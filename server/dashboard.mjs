// The dashboard: widgets (small HTML apps built by the bots) and suggestions (things a bot proposes to do next).
// Widget metadata lives in state.dashboard; the HTML and data of each widget are files in data/dashboard/.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, state, save, emit, uid, getBot } from './store.mjs';

const DIR = path.join(DATA, 'dashboard');
fs.mkdirSync(DIR, { recursive: true });
export const SIZES = ['small', 'wide', 'tall', 'large', 'full'];
const MAX_HTML = 300 * 1024, MAX_DATA = 200 * 1024, MAX_WIDGETS = 40, MAX_SUGGESTIONS = 20;

const D = () => (state.dashboard ||= { widgets: [], suggestions: [] });
const changed = () => { save(); emit('dashboard'); };
const file = (id, ext) => path.join(DIR, id + '.' + ext);
const readOr = (f, d) => { try { return fs.readFileSync(f, 'utf8'); } catch { return d; } };
const botName = (id) => getBot(id)?.name || '';

export const getWidget = (id) => D().widgets.find((w) => w.id === id);
export const publicState = () => ({ widgets: D().widgets, suggestions: D().suggestions });
export const describe = () => ({
  widgets: D().widgets.map((w) => ({ id: w.id, title: w.title, size: w.size, owner: botName(w.botId), refresh_minutes: w.refresh?.minutes || null, refresh_prompt: w.refresh?.prompt || null, updated: new Date(w.updatedAt).toISOString(), data_bytes: readOr(file(w.id, 'json'), '').length })),
  suggestions: D().suggestions.map((s) => ({ id: s.id, title: s.title, text: s.text, owner: botName(s.botId), actions: s.actions.map((a) => a.label) })),
});
export const widgetSource = (id) => ({ html: readOr(file(id, 'html'), ''), data: readOr(file(id, 'json'), 'null') });

async function syncRefresh(w) {
  const R = await import('./routines.mjs');
  const old = state.routines.find((r) => r.widgetId === w.id);
  if (!w.refresh?.minutes) { if (old) R.deleteRoutine(old.id); return; }
  const prompt = `Refresh your dashboard widget "${w.title}" (id ${w.id}). ${w.refresh.prompt || 'Get the current information it shows.'}\nThen update it with mcp__bot__dashboard_widget, passing id "${w.id}" and only the new "data" (do not resend the html unless the layout must change). Do not notify the user and do not write a chat message about a routine refresh: reply exactly NOOP when done. If the fresh information reveals something the user should act on, add a mcp__bot__dashboard_suggest card.`;
  if (old) { old.prompt = prompt; old.name = 'רענון וידג׳ט: ' + w.title; old.trigger = { type: 'interval', minutes: w.refresh.minutes }; old.botId = w.botId; save(); emit('routines'); }
  else { const r = R.createRoutine({ botId: w.botId, name: 'רענון וידג׳ט: ' + w.title, prompt, trigger: { type: 'interval', minutes: w.refresh.minutes } }); r.widgetId = w.id; r.lastRun = Date.now(); save(); }
}

// Create (no id) or update (id) a widget. Only the fields that are passed change.
export async function upsertWidget(bot, a) {
  const d = D();
  let w = a.id ? getWidget(String(a.id)) : null;
  if (a.id && !w) throw new Error(`no widget with id ${a.id} — call the dashboard tool with op "list" to see the ids`);
  if (!w) {
    if (!a.html) throw new Error('html is required for a new widget');
    if (d.widgets.length >= MAX_WIDGETS) throw new Error('the dashboard is full — remove a widget first');
    w = { id: uid(8), botId: bot.id, title: 'Widget', size: 'small', createdAt: Date.now(), updatedAt: 0, v: 0 };
    d.widgets.push(w);
  }
  if (a.title) w.title = String(a.title).slice(0, 80);
  if (a.size) { if (!SIZES.includes(a.size)) throw new Error('size must be one of ' + SIZES.join(', ')); w.size = a.size; }
  if (a.html != null) { const s = String(a.html); if (s.length > MAX_HTML) throw new Error('html is too large (max 300 KB)'); fs.writeFileSync(file(w.id, 'html'), s); }
  if (a.data !== undefined) {
    let v = a.data; if (typeof v === 'string') { try { v = JSON.parse(v); } catch {} }
    const s = JSON.stringify(v ?? null); if (s.length > MAX_DATA) throw new Error('data is too large (max 200 KB)');
    fs.writeFileSync(file(w.id, 'json'), s);
  }
  if (a.refresh_minutes !== undefined) {
    const m = Math.round(Number(a.refresh_minutes) || 0);
    w.refresh = m > 0 ? { minutes: Math.max(5, m), prompt: String(a.refresh_prompt || w.refresh?.prompt || '').slice(0, 2000) } : null;
    await syncRefresh(w);
  } else if (a.refresh_prompt && w.refresh) { w.refresh.prompt = String(a.refresh_prompt).slice(0, 2000); await syncRefresh(w); }
  w.updatedAt = Date.now(); w.v = (w.v || 0) + 1;
  changed();
  return w;
}

export async function patchWidget(id, b) {
  const d = D(); const w = getWidget(id); if (!w) return null;
  if (SIZES.includes(b.size)) w.size = b.size;
  if (typeof b.title === 'string' && b.title.trim()) w.title = b.title.trim().slice(0, 80);
  if (b.move) { const i = d.widgets.indexOf(w), j = b.move === 'first' ? 0 : Math.max(0, Math.min(d.widgets.length - 1, i + (b.move === 'back' ? -1 : 1))); d.widgets.splice(i, 1); d.widgets.splice(j, 0, w); }
  if (Array.isArray(b.order)) d.widgets.sort((x, y) => (b.order.indexOf(x.id) + 1 || 1e6) - (b.order.indexOf(y.id) + 1 || 1e6));
  if (b.refresh_minutes !== undefined) { const m = Math.round(Number(b.refresh_minutes) || 0); w.refresh = m > 0 ? { minutes: Math.max(5, m), prompt: w.refresh?.prompt || '' } : null; await syncRefresh(w); }
  changed();
  return w;
}

export async function removeWidget(id) {
  const d = D(); const w = getWidget(id); if (!w) return false;
  d.widgets = d.widgets.filter((x) => x.id !== id);
  for (const e of ['html', 'json']) fs.rmSync(file(id, e), { force: true });
  const r = state.routines.find((x) => x.widgetId === id); if (r) (await import('./routines.mjs')).deleteRoutine(r.id);
  changed();
  return true;
}

export async function refreshWidget(id) {
  const r = state.routines.find((x) => x.widgetId === id); if (!r) return false;
  (await import('./routines.mjs')).runRoutine(r);
  return true;
}

export function suggest(bot, a) {
  const d = D();
  const actions = (Array.isArray(a.actions) ? a.actions : []).filter((x) => x?.label && x?.prompt).slice(0, 3).map((x) => ({ label: String(x.label).slice(0, 40), prompt: String(x.prompt).slice(0, 2000) }));
  if (!String(a.title || '').trim()) throw new Error('title is required');
  let s = a.id ? d.suggestions.find((x) => x.id === a.id) : null;
  if (!s) { s = { id: uid(8), botId: bot.id }; d.suggestions.unshift(s); }
  Object.assign(s, { title: String(a.title).slice(0, 120), text: String(a.text || '').slice(0, 600), actions, priority: a.priority === 'high' ? 'high' : 'normal', ts: Date.now() });
  d.suggestions = d.suggestions.slice(0, MAX_SUGGESTIONS);
  changed();
  return s;
}
export const getSuggestion = (id) => D().suggestions.find((s) => s.id === id);
export function removeSuggestion(id) { const d = D(); const n = d.suggestions.length; d.suggestions = d.suggestions.filter((s) => s.id !== id); if (d.suggestions.length !== n) changed(); return d.suggestions.length !== n; }

export async function removeBot(botId) {
  const d = D();
  for (const w of d.widgets.filter((x) => x.botId === botId)) await removeWidget(w.id);
  d.suggestions = d.suggestions.filter((s) => s.botId !== botId);
  changed();
}

// ---- rendering: the widget page that runs inside a sandboxed iframe on the dashboard
const THEMES = {
  dark: { tx: '#f2f2f3', tx2: '#a3a3ab', tx3: '#6d6d76', card: '#111113', card2: '#18181b', line: '#2f2f35', scheme: 'dark' },
  light: { tx: '#17171a', tx2: '#5c5c68', tx3: '#8c8c98', card: '#ffffff', card2: '#ececef', line: '#d2d2d9', scheme: 'light' },
};
export function renderWidget(id, { theme, accent, lang } = {}) {
  const w = getWidget(id); if (!w) return null;
  const { html, data } = widgetSource(id);
  const t = THEMES[theme === 'light' ? 'light' : 'dark'];
  const acc = /^#[0-9a-f]{3,8}$/i.test(accent || '') ? accent : '#d97757';
  const l = lang === 'en' ? 'en' : 'he';
  const safeJson = (s) => s.replace(/</g, '\\u003c').replace(/[\u2028\u2029]/g, '');
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{color-scheme:${t.scheme};--tx:${t.tx};--tx2:${t.tx2};--tx3:${t.tx3};--card:${t.card};--card2:${t.card2};--line:${t.line};--acc:${acc};--ok:#4cc38a;--warn:#e5b454;--bad:#ef6b6b;--blue:#6c8eef}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:transparent}
body{padding:4px 14px 14px;color:var(--tx);font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans Hebrew",sans-serif;overflow:auto;scrollbar-width:thin}
a{color:var(--acc)}button{font:inherit;color:inherit;cursor:pointer;background:var(--card2);border:1px solid var(--line);border-radius:10px;padding:6px 12px}
button:hover{border-color:var(--acc)}h1,h2,h3{margin:0 0 6px}table{border-collapse:collapse;width:100%}td,th{padding:4px 6px;text-align:start}</style>
<script>window.DATA=${safeJson(data || 'null')};window.WIDGET=${safeJson(JSON.stringify({ id: w.id, title: w.title, size: w.size, lang: l, theme: t.scheme, updated: w.updatedAt }))};
window.cb={ask:function(p){parent.postMessage({cb:'ask',id:WIDGET.id,prompt:String(p)},'*')}};</script>`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, (m) => m + head);
  if (/<html[\s>]/i.test(html)) return html.replace(/<html([^>]*)>/i, (m) => m + '<head>' + head + '</head>');
  return `<!doctype html><html lang="${l}" dir="${l === 'he' ? 'rtl' : 'ltr'}"><head>${head}</head><body>${html}</body></html>`;
}
