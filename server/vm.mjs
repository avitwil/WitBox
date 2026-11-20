// Shared computer (Ubuntu Server VM under QEMU/KVM) + per-bot desktops.
// Each bot = its own Linux user + its own XFCE desktop session (xrdp), rendered into a private
// headless X display (Xvfb) on the host by xfreerdp. The bot drives it with xdotool/screenshots,
// the user watches / takes over through x11vnc -> WebSocket -> noVNC in the UI.
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, ROOT, CONFIG, state, save, emit, botDir, shareDir } from './store.mjs';

const onPath = (bin) => (process.env.PATH || '').split(':').some((d) => d && fs.existsSync(path.join(d, bin)));
const XFREERDP = ['xfreerdp3', 'xfreerdp'].find(onPath) || 'xfreerdp'; // FreeRDP 3 is the default on newer distributions
export const VM_CPUS = Number(CONFIG.VM_CPUS) || 6, VM_RAM_GB = Number(CONFIG.VM_RAM_GB) || 16;

const RDP_PORT = 13389, SSH_PORT = 10022;
export const ADMIN_USER = 'cbadmin', OS_NAME = 'Ubuntu Server 24.04';
const KEY = path.join(DATA, 'vm_key');
const W = 1280, H = 800;
const adminPass = () => fs.readFileSync(path.join(DATA, 'vm_admin_pass'), 'utf8').trim();

const portOpen = (port, timeout = 1500) => new Promise((res) => {
  const s = net.connect({ port, host: '127.0.0.1' });
  const done = (v) => { s.destroy(); res(v); };
  s.setTimeout(timeout, () => done(false));
  s.on('connect', () => done(true)); s.on('error', () => done(false));
});

export function run(cmd, args, { input, timeout = 60000, env, maxBuffer = 32 * 1024 * 1024, encoding = 'utf8' } = {}) {
  return new Promise((resolve) => {
    const c = execFile(cmd, args, { timeout, env: { ...process.env, ...(env || {}) }, maxBuffer, encoding }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr, err });
    });
    if (input != null) { c.stdin.write(input); c.stdin.end(); }
  });
}

let vmCache = { t: 0, v: null };
export async function vmStatus() {
  if (Date.now() - vmCache.t < 4000 && vmCache.v) return vmCache.v;
  const running = (await run('pgrep', ['-f', 'name witbox-pc'])).code === 0;
  const [rdp, ssh] = await Promise.all([portOpen(RDP_PORT), portOpen(SSH_PORT)]);
  const ready = running && rdp && ssh && fs.existsSync(path.join(DATA, 'vm_ready'));
  vmCache = { t: Date.now(), v: { running, rdp, ssh, ready, cpus: VM_CPUS, memGb: VM_RAM_GB, os: OS_NAME } };
  return vmCache.v;
}

export async function vmStart() {
  if ((await vmStatus()).running) return;
  spawn('setsid', [path.join(ROOT, 'vm', 'run-vm.sh')], { detached: true, stdio: 'ignore' }).unref();
  vmCache.t = 0; shared.clear();
}

const SSH_OPTS = ['-i', KEY, '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'LogLevel=ERROR', '-o', 'ConnectTimeout=8', '-o', 'BatchMode=yes'];
export const scpArgs = () => [...SSH_OPTS, '-P', String(SSH_PORT)];

// Run a bash script inside the shared computer over SSH. No user -> administrator (root through sudo).
// A bot user's script gets DISPLAY of that bot's desktop session, so it can also start GUI apps.
export async function pcExec(script, { user = null, timeout = 120000 } = {}) {
  const asRoot = !user;
  const pre = asRoot ? 'export DEBIAN_FRONTEND=noninteractive\n' : 'export DISPLAY="$(cb-display)"; export XAUTHORITY="$HOME/.Xauthority"; cd "$HOME"\n';
  const r = await run('ssh', [...SSH_OPTS, '-p', String(SSH_PORT), `${user || ADMIN_USER}@127.0.0.1`, asRoot ? 'sudo -n bash -s' : 'bash -s'], { timeout, input: pre + script + '\n' });
  return { code: r.code, stdout: r.stdout, stderr: r.stderr || '' };
}

const shq = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";
export async function ensurePcUser(bot) {
  const want = !!bot.pcSudo;
  if (bot.pcUser && bot.pcPass && bot.pcSudoApplied === want) return;
  const user = bot.pcUser || 'bot_' + bot.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toLowerCase();
  const pass = bot.pcPass || 'Cb' + crypto.randomBytes(9).toString('hex');
  const pub = fs.readFileSync(KEY + '.pub', 'utf8').trim();
  const r = await pcExec(`
    set -e
    id ${user} >/dev/null 2>&1 || useradd -m -s /bin/bash -G bots -c ${shq((bot.name || 'Bot').replace(/[:,\n]/g, ' '))} ${user}
    echo ${shq(user + ':' + pass)} | chpasswd
    install -d -m 700 -o ${user} -g ${user} /home/${user}/.ssh
    echo ${shq(pub)} > /home/${user}/.ssh/authorized_keys; chown ${user}:${user} /home/${user}/.ssh/authorized_keys; chmod 600 /home/${user}/.ssh/authorized_keys
    [ -f /home/${user}/.xsession ] || { cp /etc/skel/.xsession /home/${user}/.xsession; chown ${user}:${user} /home/${user}/.xsession; }
    ${want ? `echo '${user} ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/${user}; chmod 440 /etc/sudoers.d/${user}` : `rm -f /etc/sudoers.d/${user}`}
    echo ok`);
  if (!r.stdout.includes('ok')) throw new Error('failed to create the bot user: ' + (r.stderr || r.stdout));
  bot.pcUser = user; bot.pcPass = pass; bot.pcSudoApplied = want; save();
  shared.delete(bot.id);
}

// ---- the bot's shared folder ------------------------------------------------
// The host folder data/pcshare is exported to the VM over virtio-9p (see vm/run-vm.sh) and mounted under a root-only folder.
// Each bot gets just its own sub-folder, re-exposed with bindfs as its own user: ~/witbox/{user-files,projects,sessions}
// plus shortcuts on its desktop. Returns false when the VM has no shared folder yet (it was started before 1.4).
const SHARE_NAMES = () => (state.settings.language === 'en' ? ['User files', 'Projects', 'Claude Code sessions'] : ['קבצי משתמש', 'פרויקטים', 'סשנים של Claude Code']);
const shared = new Map(); // botId -> last time the mounts were verified
export async function ensureShare(bot) {
  if (!bot.pcUser || bot.id === 'admin') return false;
  if (Date.now() - (shared.get(bot.id) || 0) < 5 * 60000) return true;
  const u = bot.pcUser, H = `/home/${u}`, B = `/var/lib/witbox/share/${bot.id}`, [n1, n2, n3] = SHARE_NAMES();
  const r = await pcExec(`
    command -v bindfs >/dev/null || apt-get install -y -q bindfs >/dev/null 2>&1 || { echo nobindfs; exit 0; }
    install -d -m 700 -o root -g root /var/lib/witbox; mkdir -p /var/lib/witbox/share   # root-only parent: host uids show through 9p, so no bot user may reach the export itself
    mountpoint -q /var/lib/witbox/share || mount -t 9p -o trans=virtio,version=9p2000.L,msize=512000 witbox /var/lib/witbox/share 2>/dev/null || { echo noshare; exit 0; }
    [ -d ${shq(B)} ] || { echo nodir; exit 0; }
    install -d -o ${u} -g ${u} ${H}/witbox ${H}/Desktop
    for d in user-files projects sessions; do
      install -d -o ${u} -g ${u} ${H}/witbox/$d
      mountpoint -q ${H}/witbox/$d && continue
      ro=""; [ $d = sessions ] && ro="-r"
      bindfs $ro -o attr_timeout=1,entry_timeout=1 --force-user=${u} --force-group=${u} --perms=u=rwX:go= --chown-ignore --chgrp-ignore ${shq(B)}/$d ${H}/witbox/$d || { echo mountfail; exit 0; }
    done
    ln -sfn ${H}/witbox/user-files ${shq(H + '/Desktop/' + n1)}; ln -sfn ${H}/witbox/projects ${shq(H + '/Desktop/' + n2)}; ln -sfn ${H}/witbox/sessions ${shq(H + '/Desktop/' + n3)}
    chown -h ${u}:${u} ${shq(H + '/Desktop/' + n1)} ${shq(H + '/Desktop/' + n2)} ${shq(H + '/Desktop/' + n3)}
    echo shareok`, { timeout: 180000 });
  const ok = r.stdout.includes('shareok');
  if (/noshare/.test(r.stdout) && !ensureShare.told) { ensureShare.told = true; emit('share-missing'); }
  if (ok) shared.set(bot.id, Date.now()); else { shared.delete(bot.id); if (!/noshare/.test(r.stdout)) console.error('shared folder', bot.id, (r.stdout + r.stderr).trim().slice(-300)); }
  return ok;
}
export const forgetShares = () => shared.clear();

export async function removePcUser(bot) {
  if (!bot.pcUser) return;
  shared.delete(bot.id);
  // unmount the shared folders first: "userdel -r" must never reach into them
  await pcExec(`pkill -KILL -u ${bot.pcUser}; sleep 1
    for d in user-files projects sessions; do umount -l /home/${bot.pcUser}/witbox/$d 2>/dev/null; done
    if mount | grep -q " /home/${bot.pcUser}/witbox/"; then echo "still mounted, keeping the home folder"; userdel ${bot.pcUser}; else userdel -r ${bot.pcUser}; fi
    rm -f /etc/sudoers.d/${bot.pcUser}; true`).catch(() => {});
}

// ---- desktops ---------------------------------------------------------------
const desks = new Map(); // botId -> {n, procs:{xvfb,rdp,vnc}, takeover, teach}
const usedDisplays = () => new Set([...desks.values()].map((d) => d.n));

function spawnLogged(name, cmd, args, env) {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  p.stderr.on('data', () => {}); p.stdout.on('data', () => {});
  p.on('error', (e) => console.error(name, e.message));
  return p;
}

export function desktopInfo(botId) {
  const d = desks.get(botId);
  return d ? { running: true, takeover: !!d.takeover, teaching: !!d.teach, width: W, height: H, vncPort: 5900 + d.n } : { running: false };
}

export async function ensureDesktop(bot) {
  let d = desks.get(bot.id);
  if (d && d.procs.rdp.exitCode === null && d.procs.xvfb.exitCode === null) return d;
  if (d) stopDesktop(bot.id);
  const vm = await vmStatus();
  if (!vm.ready) throw new Error('The shared computer is not ready yet (VM ' + (vm.running ? 'is still starting' : 'is off') + ').');
  if (bot.id !== 'admin') { await ensurePcUser(bot); await ensureShare(bot).catch(() => false); }
  let n = 100; const used = usedDisplays();
  while (used.has(n) || fs.existsSync(`/tmp/.X11-unix/X${n}`)) n++;
  const disp = ':' + n;
  const xvfb = spawnLogged('xvfb', 'Xvfb', [disp, '-screen', '0', `${W}x${H}x24`, '-nolisten', 'tcp', '-ac']);
  await new Promise((r) => setTimeout(r, 700));
  const startRdp = () => spawnLogged('rdp', XFREERDP, [`/v:127.0.0.1:${RDP_PORT}`, `/u:${bot.pcUser}`, `/p:${bot.pcPass}`, '/cert:ignore',
    `/size:${W}x${H}`, '/f', '/bpp:24', '+clipboard', '/network:lan', '/auto-reconnect', '/auto-reconnect-max-retries:20', '-grab-keyboard',
    '/audio-mode:2'], { DISPLAY: disp });
  const rdp = startRdp();
  const vnc = spawnLogged('vnc', 'x11vnc', ['-display', disp, '-localhost', '-rfbport', String(5900 + n), '-forever', '-shared', '-nopw', '-quiet', '-noxdamage', '-repeat', '-xkb']);
  d = { n, disp, procs: { xvfb, rdp, vnc }, takeover: false, teach: null };
  desks.set(bot.id, d);
  rdp.on('exit', () => { if (desks.get(bot.id) === d) { stopDesktop(bot.id); } });
  await new Promise((r) => setTimeout(r, 6000));
  emit('desktop', { botId: bot.id, desktop: desktopInfo(bot.id) });
  return d;
}

export function stopDesktop(botId) {
  const d = desks.get(botId);
  if (!d) return;
  desks.delete(botId);
  for (const p of Object.values(d.procs)) { try { p.kill('SIGTERM'); } catch {} }
  if (d.teach?.timer) clearInterval(d.teach.timer);
  emit('desktop', { botId, desktop: desktopInfo(botId) });
}
export function stopAllDesktops() { for (const id of [...desks.keys()]) stopDesktop(id); }

export function setTakeover(botId, on) {
  const d = desks.get(botId); if (!d) return;
  d.takeover = !!on;
  if (!on && d.takeoverWaiters) { for (const w of d.takeoverWaiters) w(); d.takeoverWaiters = []; }
  emit('desktop', { botId, desktop: desktopInfo(botId) });
}
export function waitTakeoverEnd(botId, timeoutMs = 15 * 60000) {
  const d = desks.get(botId); if (!d || !d.takeover) return Promise.resolve();
  return new Promise((res) => { (d.takeoverWaiters ||= []).push(res); setTimeout(res, timeoutMs); });
}

export async function screenshot(botId, { quality = 72 } = {}) {
  const d = desks.get(botId); if (!d) throw new Error('desktop not running');
  const r = await run('import', ['-display', d.disp, '-window', 'root', '-quality', String(quality), 'jpg:-'], { encoding: 'buffer', timeout: 15000 });
  if (r.code !== 0 || !r.stdout?.length) throw new Error('screenshot failed');
  return r.stdout;
}

const xdo = (d, args) => run('xdotool', args, { env: { DISPLAY: d.disp }, timeout: 30000 });
const KEYMAP = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', win: 'super', super: 'super', cmd: 'super', meta: 'super', enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', backspace: 'BackSpace', delete: 'Delete', del: 'Delete', space: 'space', up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Page_Up', pagedown: 'Page_Down', page_up: 'Page_Up', page_down: 'Page_Down', insert: 'Insert', printscreen: 'Print' };
const normKeys = (k) => k.split('+').map((p) => { const t = p.trim(); return KEYMAP[t.toLowerCase()] || (/^f\d+$/i.test(t) ? t.toUpperCase() : t); }).join('+');

export async function desktopAction(botId, a) {
  const d = desks.get(botId); if (!d) throw new Error('desktop not running');
  const xy = (x, y) => [String(Math.round(Math.max(0, Math.min(W - 1, x)))), String(Math.round(Math.max(0, Math.min(H - 1, y))))];
  const btn = { left: '1', middle: '2', right: '3' };
  switch (a.action) {
    case 'click': case 'left_click': await xdo(d, ['mousemove', ...xy(a.x, a.y), 'click', btn[a.button] || '1']); break;
    case 'double_click': await xdo(d, ['mousemove', ...xy(a.x, a.y), 'click', '--repeat', '2', '--delay', '90', '1']); break;
    case 'right_click': await xdo(d, ['mousemove', ...xy(a.x, a.y), 'click', '3']); break;
    case 'move': await xdo(d, ['mousemove', ...xy(a.x, a.y)]); break;
    case 'drag': await xdo(d, ['mousemove', ...xy(a.x, a.y), 'mousedown', '1', 'mousemove', ...xy(a.x2, a.y2), 'mouseup', '1']); break;
    case 'scroll': {
      const n = Math.max(1, Math.min(30, Math.abs(a.amount || 3)));
      const b = a.direction === 'up' ? '4' : a.direction === 'left' ? '6' : a.direction === 'right' ? '7' : '5';
      await xdo(d, [...(a.x != null ? ['mousemove', ...xy(a.x, a.y)] : []), 'click', '--repeat', String(n), '--delay', '40', b]); break;
    }
    case 'type': {
      const text = String(a.text ?? '');
      if (/^[\x20-\x7e\n\t]*$/.test(text) && text.length < 400) {
        await xdo(d, ['type', '--delay', '14', '--', text]);
      } else { // unicode / long text: paste through the RDP clipboard
        await run('xclip', ['-selection', 'clipboard', '-display', d.disp], { input: text, timeout: 5000 });
        await new Promise((r) => setTimeout(r, 400));
        await xdo(d, ['key', 'ctrl+v']);
      }
      break;
    }
    case 'key': await xdo(d, ['key', '--', normKeys(String(a.keys || a.key))]); break;
    case 'wait': await new Promise((r) => setTimeout(r, Math.min(15, a.seconds || 1) * 1000)); break;
    default: throw new Error('unknown action ' + a.action);
  }
}

// Type a secret straight into the desktop (never shown to the model).
export async function typeSecret(botId, text) {
  const d = desks.get(botId); if (!d) throw new Error('desktop not running');
  await run('xclip', ['-selection', 'clipboard', '-display', d.disp], { input: text, timeout: 5000 });
  await new Promise((r) => setTimeout(r, 400));
  await xdo(d, ['key', 'ctrl+v']);
  await new Promise((r) => setTimeout(r, 300));
  await run('xclip', ['-selection', 'clipboard', '-display', d.disp], { input: '', timeout: 5000 });
}

// ---- teach a task: record frames while the user demonstrates -----------------
export function teachStart(bot) {
  const d = desks.get(bot.id); if (!d) throw new Error('desktop not running');
  const dir = path.join(botDir(bot.id), 'teach', String(Date.now()));
  fs.mkdirSync(dir, { recursive: true });
  const t = { dir, n: 0, last: '', started: Date.now() };
  t.timer = setInterval(async () => {
    if (t.n >= 240 || Date.now() - t.started > 10 * 60000) return;
    try {
      const img = await screenshot(bot.id, { quality: 60 });
      const h = crypto.createHash('md5').update(img).digest('hex');
      if (h === t.last) return;
      t.last = h;
      fs.writeFileSync(path.join(dir, String(++t.n).padStart(3, '0') + '.jpg'), img);
    } catch {}
  }, 1500);
  d.teach = t; d.takeover = true;
  emit('desktop', { botId: bot.id, desktop: desktopInfo(bot.id) });
}
export function teachStop(botId) {
  const d = desks.get(botId); if (!d?.teach) return null;
  const t = d.teach; clearInterval(t.timer); d.teach = null; d.takeover = false;
  emit('desktop', { botId, desktop: desktopInfo(botId) });
  const files = fs.readdirSync(t.dir).sort();
  const max = 24, step = Math.max(1, Math.ceil(files.length / max));
  const picked = files.filter((_, i) => i % step === 0 || i === files.length - 1).map((f) => path.join(t.dir, f));
  return { dir: t.dir, frames: picked, total: files.length, seconds: Math.round((Date.now() - t.started) / 1000) };
}

export const DESKTOP_SIZE = { W, H };
