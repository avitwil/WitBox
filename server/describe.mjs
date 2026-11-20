// Human-readable descriptions of connector actions.
// The server only sees ids in write calls (threadId, labelIds…), so it remembers what earlier
// read results said about those ids (sender + subject, label names) and shows that instead.
import fs from 'node:fs';
import path from 'node:path';
import { botDir, state } from './store.mjs';

const MAX = 4000;
const cache = new Map(); // botId -> { items: {id: [title, from]}, labels: {id: name}, dirty }
const file = (botId) => path.join(botDir(botId), 'known.json');

function known(botId) {
  if (!cache.has(botId)) {
    let k = { items: {}, labels: {} };
    try { k = { items: {}, labels: {}, ...JSON.parse(fs.readFileSync(file(botId), 'utf8')) }; } catch {}
    cache.set(botId, k);
  }
  return cache.get(botId);
}
function persist(botId) {
  const k = known(botId);
  if (k.timer) return;
  k.timer = setTimeout(() => {
    k.timer = null;
    const ids = Object.keys(k.items);
    if (ids.length > MAX) for (const id of ids.slice(0, ids.length - MAX)) delete k.items[id];
    try { fs.writeFileSync(file(botId), JSON.stringify({ items: k.items, labels: k.labels }), { mode: 0o600 }); } catch {}
  }, 500);
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const clip = (s, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
function senderOf(o) {
  const a = Array.isArray(o.addressDisplayNames) ? o.addressDisplayNames : [];
  const raw = str(o.sender) || str(o.from) || str(o.organizer?.email) || '';
  const hit = a.find((x) => x && str(x.emailAddress) && raw.includes(x.emailAddress)) || (raw ? null : a[0]);
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(raw);
  return str(hit?.displayName) || (m && str(m[1])) || (m ? m[2] : raw);
}

// Remember what a tool result says about the ids in it.
export function learn(botId, toolName, text) {
  if (!text || text.length > 4e6 || !/^\s*[[{]/.test(text)) return;
  let data; try { data = JSON.parse(text); } catch { return; }
  const k = known(botId); let n = 0;
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 8) return;
    if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
    if (str(o.labelId) && str(o.name)) { k.labels[o.labelId] = o.name; n++; }
    const title = str(o.subject) || str(o.title) || str(o.summary) || (str(o.labelId) ? '' : str(o.name));
    if (title) {
      const from = senderOf(o);
      for (const key of ['id', 'threadId', 'messageId', 'fileId', 'eventId', 'draftId']) {
        const id = str(o[key]);
        if (id && id.length >= 6 && !(key === 'threadId' && k.items[id])) { k.items[id] = from ? [clip(title, 120), clip(from, 60)] : [clip(title, 120)]; n++; }
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(data, 0);
  if (n) persist(botId);
}

export const connectorOf = (name) => (name.match(/^mcp__(.+?)__/) || [])[1] || '';
export const prettyConnector = (server) => server.replace(/^claude_ai_/, '').replace(/_/g, ' ');

const VERBS = [
  [/^untrash/, 'שחזור מהאשפה', 'Restore from trash'],
  [/trash/, 'העברה לאשפה', 'Move to trash'],
  [/^unmark.*spam/, 'ביטול סימון ספאם', 'Not spam'],
  [/spam/, 'סימון כספאם', 'Mark as spam'],
  [/create_label/, 'תווית חדשה', 'New label'],
  [/^unlabel/, 'הסרת תווית', 'Remove label'],
  [/label/, 'תיוג', 'Label'],
  [/draft/, 'טיוטה', 'Draft'],
  [/reply/, 'תשובה', 'Reply'],
  [/forward/, 'העברה', 'Forward'],
  [/send/, 'שליחה', 'Send'],
  [/delete|remove/, 'מחיקה', 'Delete'],
  [/search|find|query/, 'חיפוש', 'Search'],
  [/list/, 'רשימה', 'List'],
  [/get|read|fetch|download|view|export/, 'קריאה', 'Read'],
  [/share|permission/, 'שיתוף', 'Share'],
  [/create|add|insert|upload|new/, 'יצירה', 'Create'],
  [/update|edit|modify|patch|rename|move|copy|set/, 'עדכון', 'Update'],
];

// → { label: "Gmail · העברה לאשפה", item: "נושא — שולח" | '' }
export function describe(botId, toolName, input = {}) {
  const he = state.settings.language !== 'en';
  const server = connectorOf(toolName), short = toolName.split('__').pop() || '';
  const v = VERBS.find(([re]) => re.test(short));
  let verb = v ? (he ? v[1] : v[2]) : short.replace(/_/g, ' ');
  const k = known(botId);
  const labelIds = [].concat(input.labelIds || input.addLabelIds || [], input.removeLabelIds || [], str(input.labelId) || []).filter((x) => typeof x === 'string');
  if (labelIds.length && /label/.test(short)) verb += ' ' + labelIds.map((id) => '"' + (k.labels[id] || (/^[A-Z_]+$/.test(id) ? id.toLowerCase().replace(/_/g, ' ') : he ? 'תווית' : 'label')) + '"').join(', ');
  const ids = [];
  for (const [key, val] of Object.entries(input)) {
    if (/labelids?$/i.test(key)) continue;
    if (/(^id|Id|_id)$/.test(key) && str(val)) ids.push(val);
    else if (/(^ids|Ids|_ids)$/.test(key) && Array.isArray(val)) ids.push(...val.filter((x) => typeof x === 'string'));
  }
  const parts = [];
  for (const id of ids) { const it = k.items[id]; if (it) parts.push(it[1] ? `${it[0]} — ${it[1]}` : it[0]); }
  if (!parts.length) {
    const title = str(input.subject) || str(input.title) || str(input.summary) || str(input.name);
    const to = [].concat(input.to || input.toRecipients || []).filter((x) => typeof x === 'string').join(', ');
    if (title || to) parts.push(clip(title || '') + (to ? (title ? ' → ' : '→ ') + clip(to, 60) : ''));
  }
  return { label: `${prettyConnector(server)} · ${verb}`, item: parts.join(' · ') };
}
