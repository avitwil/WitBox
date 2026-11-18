// Bot details side panel (hideable): activity (upcoming routines, the bot's computer, voice) and library.
import { S, T, h, icon, ibtn, api, patch, post, toast, fmtTime, fmtSize, avatar, native } from './ui.js';
import { openComputer, openArtifact } from './panel.js';
import { botSettings, triggerText, sw } from './views.js';
import { voiceMode, voiceOptions } from './voice.js';

const $app = document.getElementById('app'), $el = document.getElementById('details');
const wide = () => matchMedia('(min-width: 1181px)').matches;
let overlayOpen = false, current = null, tab = 'activity', shotTimer = null;

export const detailsShown = () => (wide() ? localStorage.cbDetails !== '0' : overlayOpen);
export function toggleDetails() {
  if (wide()) localStorage.cbDetails = detailsShown() ? '0' : '1'; else overlayOpen = !overlayOpen;
  syncDetails(current);
}
const hide = () => { if (wide()) localStorage.cbDetails = '0'; else overlayOpen = false; syncDetails(current); };

// Called on every route change and whenever bots / routines change.
export function syncDetails(bot) {
  if (bot?.id !== current?.id) { tab = 'activity'; if (!wide()) overlayOpen = false; }
  current = bot || null;
  clearInterval(shotTimer); shotTimer = null;
  const show = !!bot && detailsShown();
  $el.hidden = !show; $app.classList.toggle('with-details', show);
  if (!show) { $el.replaceChildren(); return; }
  draw(bot);
}

function draw(bot) {
  const isMain = S.settings.mainBotId === bot.id;
  const body = h('div', { class: 'dbody' });
  const tabs = h('div', { class: 'dtabs' }, [['activity', T('פעילות', 'Activity')], ['library', T('ספרייה', 'Library')]].map(([k, l]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; draw(bot); } }, l)));
  $el.replaceChildren(
    h('div', { class: 'dtop' }, ibtn('x', T('הסתר', 'Hide'), hide), h('span', { style: { flex: 1 } }), ibtn('gear', T('הגדרות הבוט', 'Bot settings'), () => botSettings(bot))),
    h('div', { class: 'dhero' }, h('div', { class: 'tilewrap' }, avatar(bot, 'lg'), isMain ? h('i', { class: 'star', title: T('בוט ראשי', 'Main bot') }, '★') : null), h('b', { dir: 'auto' }, bot.name), bot.title ? h('small', { dir: 'auto' }, bot.title) : null),
    tabs, body);
  if (tab === 'activity') activity(bot, body); else library(bot, body);
}

function activity(bot, body) {
  const routines = S.routines.filter((r) => r.botId === bot.id);
  const d = bot.desktop || { running: false };
  const thumb = h('div', { class: 'thumb' });
  const loadShot = () => { if (!d.running || document.hidden) return; const img = new Image(); img.onload = () => thumb.replaceChildren(img); img.src = `/api/bots/${bot.id}/screenshot?t=${Date.now()}`; };
  if (d.running) { loadShot(); shotTimer = setInterval(loadShot, 8000); } else thumb.append(icon('monitor'));
  const vo = voiceOptions();
  const sel = (opts, val, onchange) => h('select', { class: 'dsel', onchange: (e) => onchange(e.target.value) }, opts.map(([k, l]) => h('option', { value: k, selected: String(k) === String(val) }, l)));
  const setting = (k) => async (v) => { S.settings[k] = v; try { await patch('/settings', { [k]: v }); } catch (e) { toast(e.message); } };
  body.replaceChildren(
    h('h4', {}, T('בקרוב', 'Upcoming')),
    routines.length ? routines.map((r) => h('div', { class: 'dcard row' }, icon('clock'), h('div', { class: 'grow' }, h('b', { dir: 'auto' }, r.name), h('small', {}, r.enabled ? triggerText(r.trigger) : T('מושהית', 'Paused'))), sw(r.enabled, async (v) => { r.enabled = v; try { await patch('/routines/' + r.id, { enabled: v }); } catch (e) { toast(e.message); } draw(bot); })))
      : h('div', { class: 'dcard muted small' }, T('אין שגרות מתוזמנות. אפשר לבקש מהבוט "כל בוקר ב-8…" או להוסיף בהגדרות.', 'No scheduled routines. Ask the bot ("every morning at 8…") or add one in settings.')),
    h('h4', {}, T('מחשב', 'Computer')),
    h('button', { class: 'dcard row', onclick: () => { if (!matchMedia('(min-width: 1181px)').matches) hide(); openComputer(bot.id); } }, h('div', { class: 'grow' }, h('b', {}, T('המחשב של הבוט', "The bot's computer")), h('small', {}, d.running ? (d.takeover ? T('בשליטתך', 'You are in control') : bot.status === 'computer' ? T('בשימוש כעת', 'In use now') : T('פועל', 'Running')) : T('במצב שינה', 'Asleep'))), thumb),
    h('h4', {}, T('שיחת קול', 'Voice chat')),
    h('div', { class: 'dcard' },
      h('div', { class: 'row' }, h('span', { class: 'grow' }, T('קול', 'Voice')), sel(vo.voices, S.settings.voiceName || '', setting('voiceName')), sel([['0.85', '0.85x'], ['1', '1.0x'], ['1.15', '1.15x'], ['1.3', '1.3x'], ['1.5', '1.5x']], S.settings.voiceRate || '1', setting('voiceRate'))),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('span', { class: 'grow' }, T('שפה', 'Language')), sel([['he-IL', 'עברית'], ['en-US', 'English'], ['ar-IL', 'العربية'], ['ru-RU', 'Русский'], ['fr-FR', 'Français'], ['es-ES', 'Español']], S.settings.voiceLang || 'he-IL', async (v) => { await setting('voiceLang')(v); draw(bot); })),
      h('button', { class: 'btn primary', style: { width: '100%', marginTop: '12px' }, onclick: () => voiceMode(bot) }, icon('wave'), T('התחל שיחה', 'Start talking'))));
}

async function library(bot, body) {
  body.replaceChildren(h('div', { class: 'dcard muted small' }, '…'));
  const [a, f] = await Promise.all([api(`/bots/${bot.id}/artifacts`).catch(() => ({ artifacts: [] })), api(`/bots/${bot.id}/files`).catch(() => ({ files: [] }))]);
  if (current?.id !== bot.id || tab !== 'library') return;
  const ICON = { html: '▣', sheet: '▦', markdown: '☰', svg: '◈', mermaid: '⑂' };
  body.replaceChildren(
    h('h4', {}, T('לוחות ומסמכים', 'Boards and documents')),
    a.artifacts.length ? a.artifacts.map((x) => h('button', { class: 'dcard row', onclick: () => { if (!matchMedia('(min-width: 1181px)').matches) hide(); openArtifact(bot.id, x.id); } }, h('span', { class: 'fi' }, ICON[x.type] || '▣'), h('div', { class: 'grow' }, h('b', { dir: 'auto' }, x.title || x.id), h('small', {}, x.type + (x.ts ? ' · ' + fmtTime(x.ts) : '')))))
      : h('div', { class: 'dcard muted small' }, T('הבוט עוד לא יצר לוחות או מסמכים.', 'Nothing created yet.')),
    h('h4', {}, T('קבצים', 'Files')),
    f.files.length ? f.files.slice(0, 60).map((x) => h('a', { class: 'dcard row', href: `/api/bots/${bot.id}/file?path=${encodeURIComponent(x.path)}`, download: x.path.split('/').pop() }, h('span', { class: 'fi' }, icon('file')), h('div', { class: 'grow' }, h('b', { dir: 'ltr' }, x.path.split('/').pop()), h('small', {}, fmtSize(x.size) + ' · ' + fmtTime(x.mtime)))))
      : h('div', { class: 'dcard muted small' }, T('אין קבצים.', 'No files.')));
}

window.addEventListener('resize', () => { if (current) syncDetails(current); });
