// WitBox server. Listens on 127.0.0.1 only; exposed to the tailnet exclusively through `tailscale serve`.
import http from 'node:http';
import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer } from 'ws';
import { ROOT, DATA, SHARED_DIR, BRAIN, SKILLS_DIR, memFile, state, save, bus, emit, uid, botDir, getBot, createBot, publicBot, messages, clearMessages, MODELS, EFFORTS, inside } from './store.mjs';
import * as vm from './vm.mjs';
import * as agent from './agent.mjs';
import * as routines from './routines.mjs';
import * as devices from './devices.mjs';
import * as vault from './vault.mjs';
import * as learn from './learn.mjs';
import * as dash from './dashboard.mjs';

const VERSION = (() => { try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch { return 'dev'; } })();
const WEB = path.join(ROOT, 'web');
const DOWNLOADS = path.join(ROOT, 'downloads');
const NOVNC = [path.join(ROOT, 'vendor/novnc'), '/usr/share/novnc', '/usr/share/webapps/novnc', '/usr/share/noVNC'].find((d) => fs.existsSync(path.join(d, 'core/rfb.js'))) || '/usr/share/novnc';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.apk': 'application/vnd.android.package-archive', '.exe': 'application/vnd.microsoft.portable-executable', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.webmanifest': 'application/manifest+json', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };

const json = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(b); };
const readBody = (req, limit = 200 * 1024 * 1024) => new Promise((resolve, reject) => { const chunks = []; let n = 0; req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); }); req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject); });
const readJson = async (req) => { const b = await readBody(req, 8 * 1024 * 1024); return b.length ? JSON.parse(b.toString()) : {}; };

function sendFile(res, file, { download, req } = {}) {
  let st; try { st = fs.statSync(file); } catch { res.writeHead(404); return res.end('not found'); }
  if (st.isDirectory()) { res.writeHead(404); return res.end('not found'); }
  const h = { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' };
  if (download) h['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`;
  res.writeHead(200, h);
  fs.createReadStream(file).pipe(res);
}

// --- access control: tailnet identity (added by `tailscale serve`) -----------
function authorized(req) {
  const viaProxy = !!req.headers['x-forwarded-for'];
  if (!viaProxy) return true; // direct loopback (local machine only; the socket is bound to 127.0.0.1)
  const login = String(req.headers['tailscale-user-login'] || '').toLowerCase();
  return !!login && state.settings.allowedLogins.map((x) => x.toLowerCase()).includes(login);
}
// The browser's Origin must be the host the request was addressed to. Behind `tailscale serve` the original host
// arrives in X-Forwarded-Host (the Host header may be rewritten for the unix-socket backend).
const sameOrigin = (req) => { const o = req.headers.origin; if (!o) return true; try { const h = new URL(o).host; return h === req.headers.host || h === String(req.headers['x-forwarded-host'] || '').split(',')[0].trim(); } catch { return false; } };

async function fullState() {
  return {
    bots: state.bots.map((b) => ({ ...publicBot(b), status: agent.botStatus(b.id), desktop: vm.desktopInfo(b.id) })),
    routines: state.routines,
    settings: state.settings,
    models: MODELS, efforts: EFFORTS,
    devices: devices.listDevices(),
    inbox: state.inbox.slice(0, 50),
    dashboard: dash.publicState(),
    vm: await vm.vmStatus(),
    adminDesktop: vm.desktopInfo('admin'),
    server: { host: os.hostname(), version: VERSION },
  };
}

let usageCache = { t: 0, v: null };
async function usage() {
  if (Date.now() - usageCache.t < 60000 && usageCache.v) return usageCache.v;
  const cred = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude/.credentials.json'), 'utf8')).claudeAiOauth;
  const r = await fetch('https://api.anthropic.com/api/oauth/usage', { headers: { authorization: 'Bearer ' + cred.accessToken, 'anthropic-beta': 'oauth-2025-04-20' } });
  if (!r.ok) throw new Error('usage HTTP ' + r.status);
  const j = await r.json();
  const v = { plan: cred.subscriptionType, tier: cred.rateLimitTier, five_hour: j.five_hour, seven_day: j.seven_day, seven_day_opus: j.seven_day_opus, seven_day_sonnet: j.seven_day_sonnet, extra_usage: j.extra_usage, limits: j.limits, fetched: Date.now() };
  usageCache = { t: Date.now(), v };
  return v;
}

const adminBot = () => ({ id: 'admin', name: 'Administrator', pcUser: vm.ADMIN_USER, pcPass: fs.readFileSync(path.join(DATA, 'vm_admin_pass'), 'utf8').trim() });

// --- API ---------------------------------------------------------------------
async function api(req, res, url) {
  const p = url.pathname.replace(/^\/api/, '');
  const seg = p.split('/').filter(Boolean);
  const M = req.method;
  if (M !== 'GET' && M !== 'HEAD' && req.headers['x-cb'] !== '1' && seg[0] !== 'hooks') return json(res, 403, { error: 'missing X-CB header' });

  if (p === '/state' && M === 'GET') return json(res, 200, await fullState());
  if (p === '/usage' && M === 'GET') { try { return json(res, 200, await usage()); } catch (e) { return json(res, 200, { error: String(e.message) }); } }

  if (p === '/tts' && M === 'POST') { // local neural Hebrew voice for voice chat (tts/server.py)
    const b = await readJson(req); const text = String(b.text || '').slice(0, 1200);
    if (!text.trim()) return json(res, 400, { error: 'empty' });
    try { const wav = await ttsRequest({ text, rate: Number(b.rate) || 1 }); res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'no-store' }); return res.end(wav); }
    catch (e) { return json(res, 503, { error: 'tts unavailable: ' + e.message }); }
  }
  if (p === '/stt' && M === 'POST') { // server-side speech-to-text (whisper.cpp) for clients without a speech API
    const mdir = path.join(DATA, 'models'); let model = null; try { const f = fs.readdirSync(mdir).filter((x) => /^ggml-.*\.bin$/.test(x)).sort()[0]; if (f) model = path.join(mdir, f); } catch {}
    if (!model) return json(res, 200, { error: 'speech model not installed' });
    const id = uid(8), src = path.join(os.tmpdir(), `cb-stt-${id}.bin`), wav = path.join(os.tmpdir(), `cb-stt-${id}.wav`);
    fs.writeFileSync(src, await readBody(req, 30 * 1024 * 1024));
    try {
      const f = await vm.run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-ar', '16000', '-ac', '1', wav], { timeout: 30000 });
      if (f.code !== 0) return json(res, 200, { error: 'audio decode failed' });
      const lang = (url.searchParams.get('lang') || 'he').slice(0, 2);
      const w = await vm.run('whisper-cli', ['-m', model, '-l', lang, '-nt', '-np', '-t', String(Math.max(2, Math.min(8, os.cpus().length))), '-f', wav], { timeout: 120000 });
      return json(res, 200, { text: (w.stdout || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim() });
    } finally { fs.rmSync(src, { force: true }); fs.rmSync(wav, { force: true }); }
  }
  if (p === '/connectors' && M === 'GET') return json(res, 200, { connectors: await agent.connectorStatus(url.searchParams.get('refresh') === '1') });
  if (p === '/settings' && M === 'PATCH') {
    const b = await readJson(req);
    for (const k of ['autoModels', 'localModels', 'language', 'userName', 'voiceLang', 'voiceRate', 'voiceName', 'mainBotId', 'groups', 'timezone', 'approvalMode', 'askRules', 'allowRules']) if (k in b) state.settings[k] = b[k];
    save(); emit('settings');
    return json(res, 200, state.settings);
  }
  if (p === '/local/test' && M === 'POST') {
    const b = await readJson(req); const base = String(b.baseUrl || '').replace(/\/+$/, '');
    const out = { models: [] };
    try { const r = await fetch(base + '/v1/models', { headers: { authorization: 'Bearer ' + (b.apiKey || 'local'), 'x-api-key': b.apiKey || 'local' }, signal: AbortSignal.timeout(6000) }); const j = await r.json(); out.models = (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean); } catch (e) { out.modelsError = String(e.message); }
    if (b.model) {
      try {
        const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: 'Bearer ' + (b.apiKey || 'local'), 'x-api-key': b.apiKey || 'local' }, body: JSON.stringify({ model: b.model, max_tokens: 30, messages: [{ role: 'user', content: 'Say OK' }] }), signal: AbortSignal.timeout(60000) });
        const j = await r.json(); out.ok = r.ok; out.reply = j.content?.[0]?.text || JSON.stringify(j).slice(0, 300);
      } catch (e) { out.ok = false; out.reply = String(e.message); }
    }
    return json(res, 200, out);
  }

  // ---- bots
  if (p === '/bots' && M === 'POST') return json(res, 200, publicBot(createBot(await readJson(req))));
  if (p === '/bots/draft' && M === 'POST') {
    const { description } = await readJson(req);
    const out = await agent.oneShot(`A user wants to create a personal AI bot (agent) and described it like this:\n<description>\n${String(description).slice(0, 4000)}\n</description>\nWrite the bot profile in the same language as the description. Return ONLY a JSON object with keys: name (short, friendly, 1-2 words), title (job title, 2-5 words), description (one sentence), instructions (the bot's role, how it should work, tone; 4-10 lines), tasks (standing responsibilities as a short bullet list in one string, lines starting with "- "), interests (array of 3-8 short topics), emoji (one emoji).`);
    try { return json(res, 200, JSON.parse((out.match(/\{[\s\S]*\}/) || ['{}'])[0])); } catch { return json(res, 200, { name: '', instructions: String(description) }); }
  }
  if (seg[0] === 'bots' && seg[1]) {
    const bot = getBot(seg[1]);
    const sub = seg[2];
    if (seg[1] === 'admin' && sub === 'desktop' && M === 'POST') {
      const b = await readJson(req);
      if (b.action === 'start' || b.action === 'takeover') { await vm.ensureDesktop(adminBot()); vm.setTakeover('admin', true); }
      else if (b.action === 'stop') vm.stopDesktop('admin');
      return json(res, 200, vm.desktopInfo('admin'));
    }
    if (!bot) return json(res, 404, { error: 'no such bot' });
    if (!sub && M === 'PATCH') {
      const b = await readJson(req);
      for (const k of ['name', 'title', 'description', 'instructions', 'interests', 'tasks', 'emoji', 'shape', 'color', 'modelMode', 'model', 'effortMode', 'effort', 'proactive', 'connectors', 'rules', 'hidden', 'allowTools', 'learning', 'pcSudo', 'pinned', 'group']) if (k in b) bot[k] = b[k];
      if (b.perms) bot.perms = { ...bot.perms, ...b.perms };
      if ('unread' in b) bot.unread = Math.max(0, Number(b.unread) || 0);
      save(); emit('bots');
      return json(res, 200, publicBot(bot));
    }
    if (!sub && M === 'DELETE') {
      agent.stopBot(bot.id); vm.stopDesktop(bot.id);
      vm.removePcUser(bot).catch(() => {});
      if (state.settings.mainBotId === bot.id) state.settings.mainBotId = null;
      await dash.removeBot(bot.id);
      state.bots = state.bots.filter((x) => x.id !== bot.id); state.routines = state.routines.filter((r) => r.botId !== bot.id);
      fs.rmSync(botDir(bot.id), { recursive: true, force: true });
      save(); emit('bots'); emit('routines');
      return json(res, 200, { ok: true });
    }
    if (sub === 'messages' && M === 'GET') {
      const all = messages(bot.id); const limit = Number(url.searchParams.get('limit') || 60); const before = Number(url.searchParams.get('before') || Infinity);
      const f = all.filter((m) => m.ts < before);
      return json(res, 200, { messages: f.slice(-limit), more: f.length > limit });
    }
    if (sub === 'messages' && M === 'POST') {
      const b = await readJson(req);
      if (!String(b.text || '').trim() && !b.attachments?.length) return json(res, 400, { error: 'empty' });
      agent.sendMessage(bot, String(b.text || ''), { source: 'chat', attachments: b.attachments || [], voice: !!b.voice, dashboard: !!b.dashboard }).catch((e) => console.error(e));
      return json(res, 200, { ok: true });
    }
    if (sub === 'messages' && M === 'DELETE') { agent.stopBot(bot.id); clearMessages(bot.id); bot.sessionId = null; save(); return json(res, 200, { ok: true }); }
    if (sub === 'voice' && M === 'POST') { const b = await readJson(req); if (b.action === 'end') agent.closeWarm(bot.id); else agent.openWarm(bot).catch((e) => console.error('voice warm-up failed', e.message)); return json(res, 200, { ok: true }); }
    if (sub === 'stop' && M === 'POST') { agent.stopBot(bot.id); return json(res, 200, { ok: true }); }
    if (sub === 'upload' && M === 'POST') {
      const name = path.basename(url.searchParams.get('name') || 'file').replace(/[^\p{L}\p{N}._ -]/gu, '_');
      const rel = path.join('uploads', Date.now() + '-' + name);
      const buf = await readBody(req);
      fs.writeFileSync(inside(botDir(bot.id), rel), buf);
      return json(res, 200, { name, path: rel, size: buf.length });
    }
    if (sub === 'file' && M === 'GET') {
      const f = inside(botDir(bot.id), url.searchParams.get('path') || '');
      return sendFile(res, f, { download: url.searchParams.get('inline') !== '1' });
    }
    if (sub === 'artifacts' && !seg[3] && M === 'GET') {
      const dir = path.join(botDir(bot.id), 'artifacts'); const out = [];
      try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) { try { const m = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); out.push({ id: m.id, title: m.title, type: m.type, ts: m.updated }); } catch {} } } catch {}
      return json(res, 200, { artifacts: out.sort((x, y) => (y.ts || 0) - (x.ts || 0)) });
    }
    if (sub === 'artifacts' && seg[3] && M === 'GET') {
      const aid = seg[3].replace(/[^\w-]/g, ''); const dir = path.join(botDir(bot.id), 'artifacts');
      let meta, content; try { meta = JSON.parse(fs.readFileSync(path.join(dir, aid + '.json'), 'utf8')); content = fs.readFileSync(path.join(dir, aid + '.content'), 'utf8'); } catch { return json(res, 404, { error: 'not found' }); }
      if (seg[4] === 'raw') {
        res.writeHead(200, { 'content-type': meta.type === 'svg' ? 'image/svg+xml' : 'text/html; charset=utf-8', 'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads', 'cache-control': 'no-store' });
        return res.end(content);
      }
      return json(res, 200, { ...meta, content });
    }
    if (sub === 'memory') {
      const f = memFile(bot);
      if (M === 'GET') return json(res, 200, { text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' });
      if (M === 'PUT') { fs.writeFileSync(f, String((await readJson(req)).text || '')); return json(res, 200, { ok: true }); }
    }
    if (sub === 'files' && M === 'GET') {
      const out = []; const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (rel === '' && ['artifacts', 'teach'].includes(e.name)) continue; if (e.name === 'messages.jsonl' || e.name.startsWith('.')) continue; const r = path.join(rel, e.name); if (e.isDirectory()) walk(path.join(d, e.name), r); else { const st = fs.statSync(path.join(d, e.name)); out.push({ path: r, size: st.size, mtime: st.mtimeMs }); } } };
      try { walk(botDir(bot.id), ''); } catch {}
      return json(res, 200, { files: out.sort((a, b) => b.mtime - a.mtime).slice(0, 300) });
    }
    if (sub === 'desktop' && M === 'POST') {
      const b = await readJson(req);
      if (b.action === 'start') await vm.ensureDesktop(bot);
      else if (b.action === 'stop') vm.stopDesktop(bot.id);
      else if (b.action === 'takeover') { await vm.ensureDesktop(bot); vm.setTakeover(bot.id, true); }
      else if (b.action === 'release') vm.setTakeover(bot.id, false);
      else if (b.action === 'teach_start') { await vm.ensureDesktop(bot); vm.teachStart(bot); }
      else if (b.action === 'teach_stop') {
        const t = vm.teachStop(bot.id);
        if (t && t.frames.length && !b.cancel) {
          const desc = String(b.description || '').trim();
          const rel = t.frames.map((f) => path.relative(botDir(bot.id), f));
          agent.sendMessage(bot, `📼 לימדתי אותך משימה${desc ? ': ' + desc : ''} (${t.seconds} שניות הדגמה)`, { source: 'chat', promptExtra: `\n\n[SYSTEM: The user just demonstrated a task on your desktop ("teach a task"). ${t.total} screenshots were recorded; these ${rel.length} frames are in order in your workspace:\n${rel.join('\n')}\nRead the frames in order with the Read tool, work out exactly what the user did (apps, clicks, typed values, decisions, the end result), then save it as a reusable skill with save_skill: when to use it, prerequisites, numbered steps, what varies between runs (inputs), how to verify success, and where to stop and ask. Then tell the user in 2-4 lines what you learned and ask about anything ambiguous.]` }).catch(() => {});
        }
      }
      return json(res, 200, vm.desktopInfo(bot.id));
    }
    if (sub === 'screenshot' && M === 'GET') {
      try { const img = await vm.screenshot(bot.id, { quality: 55 }); res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }); return res.end(img); } catch { res.writeHead(404); return res.end(); }
    }
  }

  // ---- brain (Obsidian vault) & skills
  if (seg[0] === 'brain') {
    if (p === '/brain' && M === 'GET') {
      const out = []; const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (e.name.endsWith('.md')) { const st = fs.statSync(path.join(d, e.name)); out.push({ path: r, size: st.size, mtime: st.mtimeMs }); } } };
      walk(BRAIN, '');
      return json(res, 200, { notes: out, vault: BRAIN });
    }
    const rel = decodeURIComponent(p.slice('/brain/note/'.length));
    if (p.startsWith('/brain/note/') && rel.endsWith('.md')) {
      const f = inside(BRAIN, rel);
      if (M === 'GET') return fs.existsSync(f) ? json(res, 200, { path: rel, text: fs.readFileSync(f, 'utf8') }) : json(res, 404, { error: 'not found' });
      if (M === 'PUT') { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String((await readJson(req)).text ?? '')); emit('brain', {}); return json(res, 200, { ok: true }); }
      if (M === 'DELETE') { fs.rmSync(f, { force: true }); emit('brain', {}); return json(res, 200, { ok: true }); }
    }
    if (p === '/brain/search' && M === 'GET') {
      const q = (url.searchParams.get('q') || '').toLowerCase(); const hits = [];
      const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith('.')) continue; const r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else if (e.name.endsWith('.md')) { const t = fs.readFileSync(path.join(d, e.name), 'utf8'); const i = t.toLowerCase().indexOf(q); if (i >= 0 || r.toLowerCase().includes(q)) hits.push({ path: r, snippet: i >= 0 ? t.slice(Math.max(0, i - 60), i + 140) : '' }); } } };
      if (q) walk(BRAIN, '');
      return json(res, 200, { hits: hits.slice(0, 60) });
    }
  }
  if (p === '/skills' && M === 'GET') return json(res, 200, { skills: agent.listSkills().map((s) => ({ ...s, path: 'Skills/' + s.name + '.md', file: undefined })) });
  if (p === '/learn' && M === 'POST') { const b = await readJson(req); const bot = getBot(b.botId); if (bot) (await import('./learn.mjs')).reflect(bot, { force: true }); return json(res, 200, { ok: !!bot }); }

  // ---- approvals / secrets
  if (seg[0] === 'approvals' && seg[1] && M === 'POST') { const b = await readJson(req); return json(res, 200, { ok: agent.resolveApproval(seg[1], b.decision) }); }
  if (seg[0] === 'secrets' && seg[1] && M === 'POST') { const b = await readJson(req); return json(res, 200, { ok: agent.resolveSecret(seg[1], b.cancel ? null : String(b.value ?? '')) }); }

  // ---- routines
  if (p === '/routines' && M === 'POST') return json(res, 200, routines.createRoutine(await readJson(req)));
  if (seg[0] === 'routines' && seg[1]) {
    const r = state.routines.find((x) => x.id === seg[1]); if (!r) return json(res, 404, { error: 'not found' });
    if (M === 'PATCH') { const b = await readJson(req); for (const k of ['name', 'prompt', 'enabled', 'model']) if (k in b) r[k] = b[k]; if (b.trigger) r.trigger = { ...r.trigger, ...b.trigger }; save(); emit('routines'); return json(res, 200, r); }
    if (M === 'DELETE') { routines.deleteRoutine(r.id); return json(res, 200, { ok: true }); }
    if (seg[2] === 'run' && M === 'POST') { routines.runRoutine(r); return json(res, 200, { ok: true }); }
  }
  if (seg[0] === 'hooks' && seg[1] && M === 'POST') { const body = (await readBody(req, 1024 * 1024)).toString(); return json(res, routines.webhook(seg[1], body) ? 200 : 404, { accepted: true }); }

  // ---- devices / inbox / vm
  if (seg[0] === 'devices' && seg[1] && M === 'DELETE') { devices.forgetDevice(seg[1]); return json(res, 200, { ok: true }); }
  if (p === '/inbox' && M === 'DELETE') { state.inbox = []; save(); emit('inbox'); return json(res, 200, { ok: true }); }
  if (p === '/notify/test' && M === 'POST') { devices.notify({ botId: state.bots[0]?.id || '', botName: 'WitBox', title: 'בדיקת התראה', body: 'ההתראות עובדות ✔', priority: 'high' }); return json(res, 200, { ok: true }); }
  // ---- vault
  // ---- dashboard: widgets and suggestions made by the bots
  if (seg[0] === 'dashboard') {
    if (!seg[1] && M === 'GET') return json(res, 200, dash.publicState());
    if (seg[1] === 'widgets' && seg[2]) {
      const w = dash.getWidget(seg[2]); if (!w) return json(res, 404, { error: 'not found' });
      if (seg[3] === 'raw' && M === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals', 'cache-control': 'no-store' });
        return res.end(dash.renderWidget(w.id, { theme: url.searchParams.get('theme'), accent: url.searchParams.get('acc'), lang: url.searchParams.get('lang') }));
      }
      if (seg[3] === 'refresh' && M === 'POST') return json(res, 200, { ok: await dash.refreshWidget(w.id) });
      if (!seg[3] && M === 'PATCH') return json(res, 200, await dash.patchWidget(w.id, await readJson(req)));
      if (!seg[3] && M === 'DELETE') return json(res, 200, { ok: await dash.removeWidget(w.id) });
    }
    if (seg[1] === 'order' && M === 'POST') { const b = await readJson(req); const first = dash.publicState().widgets[0]; if (first) await dash.patchWidget(first.id, { order: b.order || [] }); return json(res, 200, { ok: true }); }
    if (seg[1] === 'suggestions' && seg[2]) {
      const sg = dash.getSuggestion(seg[2]); if (!sg) return json(res, 404, { error: 'not found' });
      if (seg[3] === 'act' && M === 'POST') { // run one of the proposed actions: it becomes a chat message to the bot that suggested it
        const b = await readJson(req); const a = sg.actions[Number(b.index) || 0]; const bot = getBot(sg.botId);
        if (!a || !bot) return json(res, 400, { error: 'no such action' });
        agent.sendMessage(bot, `${a.prompt}\n\n↳ ${sg.title}${sg.text ? ' — ' + sg.text : ''}`, { source: 'chat' }).catch((e) => console.error(e));
        dash.removeSuggestion(sg.id);
        return json(res, 200, { ok: true, botId: bot.id });
      }
      if (!seg[3] && M === 'DELETE') return json(res, 200, { ok: dash.removeSuggestion(sg.id) });
    }
    return json(res, 404, { error: 'not found' });
  }
  if (p === '/vault' && M === 'GET') return json(res, 200, { items: vault.list() });
  if (p === '/vault' && M === 'POST') return json(res, 200, vault.upsert(null, await readJson(req)));
  if (seg[0] === 'vault' && seg[1]) {
    if (!vault.get(seg[1])) return json(res, 404, { error: 'not found' });
    if (seg[2] === 'secret' && M === 'GET') return json(res, 200, { password: vault.reveal(seg[1]) || '' });
    if (M === 'PATCH') return json(res, 200, vault.upsert(seg[1], await readJson(req)));
    if (M === 'DELETE') { vault.remove(seg[1]); return json(res, 200, { ok: true }); }
  }
  if (p === '/brain/import' && M === 'POST') {
    const b = await readJson(req); if (!String(b.text || '').trim()) return json(res, 400, { error: 'empty' });
    learn.importMemory(b.text).then((line) => devices.notify({ botId: '', botName: 'WitBox', title: 'ייבוא הזיכרון הסתיים', body: line, priority: 'normal' })).catch((e) => devices.notify({ botId: '', botName: 'WitBox', title: 'ייבוא הזיכרון נכשל', body: String(e.message), priority: 'normal' }));
    return json(res, 200, { started: true });
  }
  if (p === '/downloads' && M === 'GET') {
    const dir = path.join(ROOT, 'downloads'); const out = [];
    try { for (const f of fs.readdirSync(dir)) { const st = fs.statSync(path.join(dir, f)); out.push({ file: f, size: st.size, mtime: st.mtimeMs }); } } catch {}
    return json(res, 200, { files: out });
  }
  if (p === '/vm' && M === 'POST') {
    const b = await readJson(req);
    if (b.action === 'start') await vm.vmStart();
    if (b.action === 'update') { vm.pcExec('apt-get update -q && apt-get -y -q dist-upgrade && apt-get -y -q autoremove', { timeout: 40 * 60000 }).then((r) => devices.notify({ botId: '', botName: 'WitBox', title: r.code === 0 ? 'המחשב המשותף עודכן' : 'עדכון המחשב המשותף נכשל', body: r.code === 0 ? 'כל החבילות מעודכנות.' : (r.stderr || '').slice(-300), priority: 'normal' })); return json(res, 200, { started: true }); }
    if (b.action === 'snapshot' || b.action === 'reset') {
      const reset = b.action === 'reset'; vm.stopAllDesktops();
      (async () => {
        const img = path.join(ROOT, 'vm/ubuntu.qcow2');
        await vm.run('sudo', ['-n', 'systemctl', 'stop', 'witbox-vm'], { timeout: 120000 });
        const r = await vm.run('qemu-img', ['snapshot', reset ? '-a' : '-c', 'clean', img], { timeout: 300000 });
        if (reset && r.code === 0) { for (const bt of state.bots) bt.pcSudoApplied = null; save(); }
        await vm.run('sudo', ['-n', 'systemctl', 'start', 'witbox-vm'], { timeout: 60000 });
        devices.notify({ botId: '', botName: 'WitBox', title: r.code === 0 ? (reset ? 'המחשב המשותף אופס' : 'נשמרה תמונת מצב של המחשב המשותף') : 'הפעולה על המחשב המשותף נכשלה', body: r.code === 0 ? 'המחשב עולה מחדש.' : (r.stderr || '').slice(-300), priority: 'normal' });
      })();
      return json(res, 200, { started: true });
    }
    if (b.action === 'restart') { vm.stopAllDesktops(); await vm.pcExec('systemctl reboot').catch(() => {}); }
    if (b.action === 'shutdown') { vm.stopAllDesktops(); await vm.pcExec('systemctl poweroff').catch(() => {}); }
    return json(res, 200, await vm.vmStatus());
  }
  return json(res, 404, { error: 'not found' });
}

// --- HTTP --------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  try {
    if (!authorized(req)) { res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('WitBox: access is limited to the owner\'s tailnet identity.'); }
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/downloads/')) return sendFile(res, inside(DOWNLOADS, decodeURIComponent(url.pathname.slice(11))), { download: true });
    if (url.pathname.startsWith('/novnc/')) return sendFile(res, inside(NOVNC, decodeURIComponent(url.pathname.slice(7))));
    if (url.pathname.startsWith('/assets/')) return sendFile(res, inside(path.join(ROOT, 'assets'), decodeURIComponent(url.pathname.slice(8))));
    let f = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    return sendFile(res, inside(WEB, f));
  } catch (e) {
    console.error(req.method, req.url, e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else res.end();
  }
});

// --- WebSockets --------------------------------------------------------------
// ---- local TTS worker (python, kept loaded; restarted if it dies)
const TTS_SOCK = path.join(DATA, 'tts.sock'); let ttsProc = null, ttsReady = false;
function startTts() {
  const py = path.join(ROOT, 'tts/src/.venv/bin/python'), script = path.join(ROOT, 'tts/server.py');
  if (!fs.existsSync(py) || !fs.existsSync(script)) return;
  ttsReady = false;
  ttsProc = spawn(py, [script, TTS_SOCK], { stdio: ['ignore', 'pipe', 'pipe'] });
  ttsProc.stdout.on('data', (d) => { if (String(d).includes('tts ready')) { ttsReady = true; console.log('TTS worker ready'); } });
  ttsProc.stderr.on('data', (d) => { const t = String(d).trim(); if (t && !/Warning/i.test(t)) console.error('tts:', t.slice(0, 300)); });
  ttsProc.on('exit', () => { ttsReady = false; ttsProc = null; setTimeout(startTts, 5000); });
}
function ttsRequest(body) {
  return new Promise((resolve, reject) => {
    if (!ttsReady) return reject(new Error('starting'));
    const data = Buffer.from(JSON.stringify(body));
    const r = http.request({ socketPath: TTS_SOCK, method: 'POST', path: '/', headers: { 'content-type': 'application/json', 'content-length': data.length }, timeout: 30000 }, (resp) => {
      const chunks = []; resp.on('data', (c) => chunks.push(c)); resp.on('end', () => (resp.statusCode === 200 ? resolve(Buffer.concat(chunks)) : reject(new Error(Buffer.concat(chunks).toString().slice(0, 200)))));
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); r.end(data);
  });
}
startTts();
process.on('exit', () => { try { ttsProc?.kill(); } catch {} });

const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
const uiClients = new Set();
bus.on('event', (e) => { const s = JSON.stringify(e); for (const ws of uiClients) if (ws.readyState === 1 && ws.bufferedAmount < 8e6) ws.send(s); });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (!authorized(req) || !sameOrigin(req)) { console.log(`[ws] rejected ${url.pathname} auth=${authorized(req)} origin=${req.headers.origin || '-'} host=${req.headers.host} xfh=${req.headers['x-forwarded-host'] || '-'}`); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const p = url.pathname;
    if (p === '/ws/ui') {
      uiClients.add(ws);
      const t0 = Date.now(); const ua = /Android/.test(req.headers['user-agent'] || '') ? 'android' : 'other';
      ws.on('close', (code) => console.log(`[ui-ws] closed code=${code} after ${Math.round((Date.now() - t0) / 1000)}s (${ua})`));
      const t = setInterval(() => { try { ws.ping(); } catch {} }, 25000);
      ws.on('close', () => { uiClients.delete(ws); clearInterval(t); }); ws.on('error', () => {});
    } else if (p === '/ws/notify') devices.attachNotify(ws, url.searchParams);
    else if (p === '/ws/device') devices.attachDevice(ws, url.searchParams);
    else if (p.startsWith('/ws/vnc/')) {
      const info = vm.desktopInfo(p.slice(8));
      if (!info.running) return ws.close();
      const tcp = net.connect(info.vncPort, '127.0.0.1');
      tcp.on('data', (d) => { if (ws.readyState === 1) ws.send(d); });
      tcp.on('close', () => ws.close()); tcp.on('error', () => ws.close());
      ws.on('message', (d) => tcp.write(d)); ws.on('close', () => tcp.destroy()); ws.on('error', () => tcp.destroy());
    } else ws.close();
  });
});

// Listen on a private unix socket only (mode 600): nothing on the network — not even other local users or the
// shared-computer VM (whose NAT can reach the host's loopback TCP ports) — can connect. `tailscale serve` proxies the
// tailnet HTTPS endpoint to this socket. Set PORT to additionally open a loopback TCP port for development.
const SOCK = path.join(DATA, 'server.sock');
try { fs.unlinkSync(SOCK); } catch {}
const prevMask = process.umask(0o177);
server.listen(SOCK, () => { process.umask(prevMask); fs.chmodSync(SOCK, 0o600); console.log('WitBox server on unix:' + SOCK); });
if (process.env.PORT) http.createServer((q, s) => server.emit('request', q, s)).on('upgrade', (q, s, h) => server.emit('upgrade', q, s, h)).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('dev TCP port ' + process.env.PORT));
// First run: start with one main bot so the dashboard and chat are usable right away.
if (!state.bots.length && !state.settings.seeded) {
  const en = state.settings.language === 'en';
  const b = createBot({ name: en ? 'Assistant' : 'עוזר', title: en ? 'Main bot' : 'הבוט הראשי', description: en ? 'Your main bot: handles everyday requests and delegates to the other bots.' : 'הבוט הראשי שלך: מטפל בבקשות היומיום ומחלק משימות לבוטים האחרים.', color: '#f2f2f3', shape: 'circle' });
  state.settings.mainBotId = b.id; state.settings.seeded = true; save();
}
if (!process.env.WITBOX_NO_SCHEDULER) routines.startScheduler(); // WITBOX_NO_SCHEDULER=1: demo / development instance, never runs routines on its own
// First run: nobody is allowed in yet — let in the tailnet user who owns this machine (and nobody else).
if (!state.settings.allowedLogins?.length) vm.run('tailscale', ['status', '--json'], { timeout: 8000 }).then((r) => { try { const j = JSON.parse(r.stdout); const login = j.User?.[j.Self?.UserID]?.LoginName; if (login) { state.settings.allowedLogins = [login]; save(); console.log('access granted to the tailnet owner: ' + login); } else console.log('could not detect the tailnet owner; add it to settings.allowedLogins in data/state.json'); } catch { console.log('tailscale is not running: nobody can connect until it is, then restart witbox'); } });
process.on('SIGTERM', () => { vm.stopAllDesktops(); process.exit(0); });
process.on('SIGINT', () => { vm.stopAllDesktops(); process.exit(0); });
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
