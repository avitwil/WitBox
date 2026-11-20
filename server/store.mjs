// WitBox persistent state: one JSON file + per-bot message logs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const DATA = process.env.WITBOX_DATA ? path.resolve(process.env.WITBOX_DATA) : path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });
// Install-time settings (data/config.env, KEY=VALUE lines written by the installer): VM size, language, …
export const CONFIG = (() => { const c = {}; try { for (const l of fs.readFileSync(path.join(DATA, 'config.env'), 'utf8').split('\n')) { const m = /^\s*([A-Z0-9_]+)=(.*)$/.exec(l); if (m) c[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); } } catch {} return c; })();
export const BOTS_DIR = path.join(DATA, 'bots');
export const SHARED_DIR = path.join(DATA, 'brain'); // the shared second brain: an Obsidian-compatible vault
export const BRAIN = SHARED_DIR;
export const SKILLS_DIR = path.join(SHARED_DIR, 'Skills');
const STATE_FILE = path.join(DATA, 'state.json');

export const bus = new EventEmitter();
bus.setMaxListeners(200);
export const emit = (type, data = {}) => bus.emit('event', { type, ...data });
export const uid = (n = 10) => crypto.randomBytes(n).toString('base64url').slice(0, n);

export const MODELS = [
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', tier: 1, note: 'מהיר וזול', noteEn: 'fast and cheap' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', tier: 2, note: 'מאוזן', noteEn: 'balanced' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', tier: 3, note: 'חזק', noteEn: 'strong' },
  { id: 'claude-fable-5-2', name: 'Fable 5.2', tier: 4, note: 'הכי חזק, יקר', noteEn: 'strongest, costly' },
];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const defaults = () => ({
  bots: [],
  routines: [],
  devices: {},
  inbox: [],
  dashboard: { widgets: [], suggestions: [] },
  settings: {
    autoModels: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
    localModels: [],            // {id, name, baseUrl, model, apiKey}
    allowedLogins: [],          // tailnet identities allowed in; empty = the owner of this tailnet node is detected at start-up
    language: CONFIG.WITBOX_LANG === 'en' ? 'en' : 'he',
    userName: CONFIG.WITBOX_USER_NAME || '',
    voiceLang: CONFIG.WITBOX_LANG === 'en' ? 'en-US' : 'he-IL',
  },
});

fs.mkdirSync(BOTS_DIR, { recursive: true });
for (const d of ['User', 'People', 'Projects', 'Knowledge', 'Journal', 'Skills', 'Bots', '.obsidian']) fs.mkdirSync(path.join(BRAIN, d), { recursive: true });
const seed = (rel, txt) => { const f = path.join(BRAIN, rel); if (!fs.existsSync(f)) fs.writeFileSync(f, txt); };
seed('Home.md', '# 🧠 WitBox Brain\n\nThe shared second brain of all bots. Open this folder as a vault in Obsidian.\n\n- [[User/Profile]] — who the user is\n- [[User/Preferences]] — how the user likes things done\n- [[People/People]] — people and contacts\n- [[Projects/Projects]] — ongoing projects\n- [[Knowledge/Knowledge]] — facts, how-tos, references\n- [[Skills/Skills]] — procedures the bots learned\n- Journal/ — daily log of what the bots did\n');
seed('User/Profile.md', '---\ntags: [user]\n---\n# User profile\n\n');
seed('User/Preferences.md', '---\ntags: [user, preferences]\n---\n# Preferences\n\nHow the user likes things done. Bots add to this automatically as they learn.\n\n');
seed('People/People.md', '# People\n\nOne note per person in this folder; link them here.\n\n');
seed('Projects/Projects.md', '# Projects\n\n');
seed('Knowledge/Knowledge.md', '# Knowledge\n\n');
seed('Skills/Skills.md', '# Skills\n\nProcedures the bots learned (taught by the user or self-learned from repetition).\n\n');
export const botSlug = (bot) => (bot.name || 'bot').replace(/[\\/:*?"<>|#^\[\]]/g, ' ').trim().slice(0, 40) + ' (' + bot.id.slice(0, 4) + ')';
export function memFile(bot) { const d = path.join(BRAIN, 'Bots', botSlug(bot)); fs.mkdirSync(d, { recursive: true }); const f = path.join(d, 'Memory.md'); if (!fs.existsSync(f)) fs.writeFileSync(f, `# ${bot.name} — memory\n\n`); return f; }
export const tz = () => { const z = state.settings.timezone; const sys = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; if (!z || z === 'auto') return sys; try { new Intl.DateTimeFormat('en', { timeZone: z }); return z; } catch { return sys; } };
export function journal(line) { const d = new Date().toLocaleDateString('sv-SE', { timeZone: tz() }); const f = path.join(BRAIN, 'Journal', d + '.md'); if (!fs.existsSync(f)) fs.writeFileSync(f, `# ${d}\n\n`); fs.appendFileSync(f, line + '\n'); }

export let state = defaults();
if (fs.existsSync(STATE_FILE)) {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...defaults(), ...s, settings: { ...defaults().settings, ...(s.settings || {}) } };
  } catch (e) { console.error('state load failed', e); }
}
// 1.3: bots work only on their own computer (no host shell), connector access is per connector.
for (const b of state.bots) {
  const p = (b.perms ||= {});
  if (!b.connDefault) b.connDefault = { level: p.connectorWrite === 'never' ? 'read' : 'write', ask: p.connectorWrite !== 'always' };
  b.connPerms ||= {}; b.devicePerms ||= {};
  b.perms = { devices: p.devices || 'ask', vault: p.vault || 'ask' };
}
fs.mkdirSync(path.join(DATA, 'pcshare'), { recursive: true });
let saveTimer = null;
export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  }, 150);
}

export const botDir = (id) => path.join(BOTS_DIR, id);
// Per-bot folder that is shared with that bot's own user on the shared computer (and only with it):
//   user-files/  what the user uploaded in chat      (workspace: ./uploads)
//   projects/    code and other work the bot builds  (workspace: ./projects)
//   sessions/    the bot's Claude Code session logs  (read-only on the bot's computer)
export const SHARE_DIR = path.join(DATA, 'pcshare');
export const shareDir = (id) => path.join(SHARE_DIR, id);
export function ensureBotDirs(id) {
  for (const d of ['', 'artifacts', 'files', 'teach']) fs.mkdirSync(path.join(botDir(id), d), { recursive: true });
  for (const d of ['user-files', 'projects', 'sessions']) fs.mkdirSync(path.join(shareDir(id), d), { recursive: true });
  for (const [name, target] of [['uploads', 'user-files'], ['projects', 'projects']]) {
    const link = path.join(botDir(id), name), dest = path.join(shareDir(id), target);
    let st = null; try { st = fs.lstatSync(link); } catch {}
    if (st?.isSymbolicLink()) continue;
    if (st?.isDirectory()) { // pre-1.4 workspace folder: move what is in it into the shared folder
      for (const e of fs.readdirSync(link)) { const to = path.join(dest, e); if (!fs.existsSync(to)) fs.renameSync(path.join(link, e), to); }
      fs.rmSync(link, { recursive: true, force: true });
    }
    fs.symlinkSync(dest, link);
  }
}
// Resolve a path the way the kernel will (following symlinks) — the shared folder is writable from the bot's
// computer, so a link planted there must never lead a host-side tool to another file on the server.
export function realOf(p) {
  let cur = path.resolve(p); const tail = [];
  for (;;) { try { return path.join(fs.realpathSync(cur), ...tail.reverse()); } catch { tail.push(path.basename(cur)); const up = path.dirname(cur); if (up === cur) return path.resolve(p); cur = up; } }
}
const under = (r, base) => r === base || r.startsWith(base + path.sep);
// A file of this bot's workspace (its private folder or its shared folder), by real path.
export function botFile(id, rel) {
  const r = realOf(path.resolve(botDir(id), String(rel || '')));
  if (!under(r, realOf(botDir(id))) && !under(r, realOf(shareDir(id)))) throw new Error('path outside workspace');
  return r;
}
export const getBot = (id) => state.bots.find((b) => b.id === id);

const COLORS = ['#D97757', '#6C8EEF', '#57B894', '#C792EA', '#E5B454', '#EF6C8E', '#4FB8C9', '#A0A56B'];
export function createBot(input = {}) {
  const id = uid(8);
  const n = state.bots.length;
  const bot = {
    id,
    name: input.name || 'בוט חדש',
    title: input.title || '',
    description: input.description || '',
    instructions: input.instructions || '',
    interests: input.interests || [],
    tasks: input.tasks || '',
    emoji: input.emoji || '',
    shape: input.shape || null,
    color: input.color || COLORS[n % COLORS.length],
    modelMode: input.modelMode || 'auto',     // auto | manual
    model: input.model || 'claude-sonnet-5-5',
    effortMode: input.effortMode || 'auto',   // auto | manual
    effort: input.effort || 'medium',
    proactive: !!input.proactive,
    connPerms: input.connPerms || {},         // connector key -> { level: none|read|write, ask: bool }
    connDefault: { level: 'write', ask: true }, // connectors without their own entry
    devicePerms: {},                          // device id -> always|ask|never (falls back to perms.devices)
    perms: { devices: ['always', 'ask', 'never'].includes(input.perms?.devices) ? input.perms.devices : 'ask', vault: ['always', 'ask', 'never'].includes(input.perms?.vault) ? input.perms.vault : 'ask' },
    rules: input.rules || '',
    allowTools: [],
    pcUser: null, pcPass: null, pcSudo: false, display: null,
    sessionId: null,
    hidden: false,
    createdAt: Date.now(), lastActivity: Date.now(), unread: 0,
  };
  ensureBotDirs(id);
  state.bots.push(bot);
  save();
  emit('bots');
  return bot;
}

export function publicBot(b) {
  const { pcPass, winPass, ...rest } = b;
  return rest;
}

// ---- messages -------------------------------------------------------------
const msgFile = (id) => path.join(botDir(id), 'messages.jsonl');
const cache = new Map(); // botId -> array
export function messages(botId) {
  if (!cache.has(botId)) {
    let arr = [];
    try {
      arr = fs.readFileSync(msgFile(botId), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      // collapse updates: last write of an id wins
      const m = new Map();
      for (const x of arr) m.set(x.id, x);
      arr = [...m.values()];
    } catch {}
    cache.set(botId, arr);
  }
  return cache.get(botId);
}
export function addMessage(botId, msg) {
  msg.id ||= uid(12);
  msg.ts ||= Date.now();
  messages(botId).push(msg);
  fs.appendFileSync(msgFile(botId), JSON.stringify(msg) + '\n');
  emit('message', { botId, message: msg });
  return msg;
}
export function updateMessage(botId, msg, { persist = false } = {}) {
  emit('message', { botId, message: msg });
  if (persist) fs.appendFileSync(msgFile(botId), JSON.stringify(msg) + '\n');
}
export function clearMessages(botId) {
  cache.set(botId, []);
  try { fs.unlinkSync(msgFile(botId)); } catch {}
  emit('cleared', { botId });
}

// safe path join inside a base dir
export function inside(base, rel) {
  const p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('path outside workspace');
  return p;
}

for (const b of state.bots) { try { ensureBotDirs(b.id); } catch (e) { console.error('workspace folders', b.id, e.message); } }
