// WitBox web UI — shell, sidebar, chat.
import { S, T, h, icon, ibtn, api, post, patch, del, toast, modal, confirmDlg, promptDlg, popMenu, onMenu, fmtTime, fmtSize, avatar, mdEl, native, esc, statusText, applyPrefs } from './ui.js';
import { syncDetails, toggleDetails, detailsShown } from './details.js';
import { openComputer, openArtifact, closePanel, panelState, onDesktopEvent } from './panel.js';
import * as V from './views.js';
import * as Dash from './dashboard.js';
import { startDictation, stopDictation, voiceMode, dictating } from './voice.js';

const $app = document.getElementById('app'), $side = document.getElementById('sidebar'), $main = document.getElementById('main');
const msgs = new Map();      // botId -> [messages]
const loaded = new Set();
export const statusOf = (id) => S.bots.find((b) => b.id === id)?.status || null;
export const botById = (id) => S.bots.find((b) => b.id === id);
let route = { name: 'home' };
let filter = '';

// ---------------------------------------------------------------- data
async function refresh() {
  const st = await api('/state');
  Object.assign(S, st);
  if (!localStorage.cbLang && st.settings.language) S.lang = st.settings.language;
  document.documentElement.lang = S.lang; document.documentElement.dir = S.lang === 'he' ? 'rtl' : 'ltr';
}
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/ui');
  ws.onmessage = (e) => onEvent(JSON.parse(e.data));
  ws.onclose = () => setTimeout(async () => { try { await refresh(); render(); if (panelState.kind === 'computer') onDesktopEvent(panelState.botId); if (route.name === 'bot') { loaded.delete(route.id); await loadMsgs(route.id); renderMsgList(); } } catch {} connect(); }, 1500);
}
let refreshT = null;
const softRefresh = () => { clearTimeout(refreshT); refreshT = setTimeout(async () => { await refresh(); renderSidebar(); if (route.name !== 'bot') renderMain(); else { if (!botById(route.id)) return go('#/'); renderChatHead(); syncDetails(botById(route.id)); } }, 120); };

function onEvent(e) {
  switch (e.type) {
    case 'message': {
      const arr = msgs.get(e.botId) || msgs.set(e.botId, []).get(e.botId);
      const i = arr.findIndex((m) => m.id === e.message.id);
      if (i >= 0) arr[i] = e.message; else arr.push(e.message);
      if (route.name === 'bot' && route.id === e.botId) upsertMsg(e.message, i < 0);
      else if (i < 0 && e.message.role === 'assistant') { const b = botById(e.botId); if (b) b.unread = (b.unread || 0) + 0; }
      const b = botById(e.botId); if (b) { b.lastActivity = Date.now(); b._pv = preview(e.message); renderSidebarSoon(); }
      if (e.message.role === 'assistant') window.dispatchEvent(new CustomEvent('cb-stream', { detail: { botId: e.botId, message: e.message } }));
      if (e.message.role === 'assistant' && e.message.status === 'done') window.dispatchEvent(new CustomEvent('cb-reply', { detail: { botId: e.botId, message: e.message } }));
      break;
    }
    case 'status': { const b = botById(e.botId); if (b) { const was = b.status; b.status = e.status; if (was && !e.status) { b._doneAt = Date.now(); setTimeout(() => { renderSidebar(); if (route.name === 'bot' && route.id === b.id) renderChatHead(); }, 2700); } renderSidebarSoon(); if (route.name === 'dashboard') Dash.update(); if (route.name === 'bot' && route.id === e.botId) { renderStatus(); if (was !== e.status) renderChatHead(); } } break; }
    case 'cleared': msgs.set(e.botId, []); if (route.name === 'bot' && route.id === e.botId) renderChat(); break;
    case 'desktop': { const b = botById(e.botId); if (b) b.desktop = e.desktop; else if (e.botId === 'admin') S.adminDesktop = e.desktop; onDesktopEvent(e.botId, e.desktop); if (route.name === 'bot' && route.id === e.botId) syncDetails(botById(route.id)); break; }
    case 'notification': S.inbox.unshift(e.notification); renderSidebarSoon(); webNotify(e.notification); if (route.name === 'inbox') renderMain(); break;
    case 'learning': { const b = botById(e.botId); if (b) { b._learning = e.on; if (route.name === 'bot' && route.id === e.botId) renderStatus(); } break; }
    case 'bots': case 'routines': case 'settings': case 'devices': case 'inbox': case 'dashboard': softRefresh(); break;
    case 'brain': case 'skills': if (route.name === 'brain') V.brainChanged?.(); break;
  }
}
function webNotify(n) {
  if (native.available) return; // native apps show OS notifications themselves
  toast(`${n.botName}: ${n.title}`, 5000);
  if (document.hidden && window.Notification?.permission === 'granted') { const x = new Notification(`${n.botName} — ${n.title}`, { body: n.body, icon: '/assets/icon-192.png' }); x.onclick = () => { window.focus(); location.hash = n.url.replace(/^\/#/, '#'); }; }
}
const preview = (m) => { const t = (m.blocks || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim(); if (t) return (m.role === 'user' ? T('את/ה: ', 'You: ') : '') + t.slice(0, 80); const last = (m.blocks || []).at(-1); return last?.type === 'tool' ? T('עובד…', 'Working…') : last?.type === 'artifact' ? '▣ ' + last.title : last?.type === 'file' ? '📎 ' + last.name : ''; };
async function loadMsgs(id) {
  if (loaded.has(id)) return;
  const r = await api(`/bots/${id}/messages?limit=120`);
  msgs.set(id, r.messages); loaded.add(id);
}

// ---------------------------------------------------------------- router
export function go(hash) { if (location.hash === hash) onRoute(); else location.hash = hash; }
function parse() {
  const p = location.hash.replace(/^#\/?/, '').split('/');
  if (p[0] === 'bot' && p[1]) return { name: 'bot', id: p[1] };
  if (p[0] === 'dashboard') return { name: 'dashboard' };
  if (['brain', 'routines', 'inbox', 'devices', 'settings', 'new'].includes(p[0])) return { name: p[0], arg: decodeURIComponent(p.slice(1).join('/')) };
  return { name: 'home' };
}
async function onRoute() {
  route = parse();
  if (route.name === 'bot' && !botById(route.id)) route = { name: 'home' };
  if (route.name === 'home' && matchMedia('(min-width: 821px)').matches && botById(S.settings.mainBotId)) route = { name: 'bot', id: S.settings.mainBotId }; // desktop opens on the main bot
  $app.classList.toggle('in-main', route.name !== 'home');
  $app.classList.toggle('dash-mode', route.name === 'dashboard');
  if (panelState.kind && (route.name !== 'bot' || panelState.botId !== route.id) && panelState.botId !== 'admin') closePanel();
  renderSidebar();
  if (route.name === 'bot') {
    await loadMsgs(route.id);
    const b = botById(route.id); if (b?.unread) { b.unread = 0; patch(`/bots/${b.id}`, { unread: 0 }).catch(() => {}); renderSidebar(); }
  }
  applyPrefs(route.name === 'bot' ? botById(route.id)?.color || null : null);
  renderMain();
  syncDetails(route.name === 'bot' ? botById(route.id) : null);
}
window.addEventListener('hashchange', onRoute);

// ---------------------------------------------------------------- sidebar
let sbT = null; const renderSidebarSoon = () => { clearTimeout(sbT); sbT = setTimeout(renderSidebar, 60); };
const collapsed = () => { try { return { hidden: true, ...JSON.parse(localStorage.cbCollapsed || '{}') }; } catch { return { hidden: true }; } };
const toggleCollapsed = (k) => { const c = collapsed(); c[k] = !c[k]; localStorage.cbCollapsed = JSON.stringify(c); renderSidebar(); };
const saveBot = async (b, body) => { Object.assign(b, body); renderSidebar(); try { await patch('/bots/' + b.id, body); } catch (e) { toast(e.message); } };
const saveSettings = async (body) => { Object.assign(S.settings, body); renderSidebar(); syncDetails(route.name === 'bot' ? botById(route.id) : null); try { await patch('/settings', body); } catch (e) { toast(e.message); } };
const groupNames = () => [...new Set([...(S.settings.groups || []), ...S.bots.map((b) => b.group).filter(Boolean)])];

async function pickGroup(b) {
  const names = groupNames();
  const close = modal(h('div', { class: 'sheet', style: { width: 'min(420px,100%)' } }, h('div', { class: 'body' }, h('p', { style: { margin: '4px 0 10px', fontSize: '16px', fontWeight: 600 } }, T(`קבוצה עבור ${b.name}`, `Group for ${b.name}`)),
    ...names.map((n) => h('button', { class: 'menurow' + (b.group === n ? ' on' : ''), onclick: () => { close(); saveBot(b, { group: n }); } }, icon('folder'), h('span', { dir: 'auto' }, n))),
    b.group ? h('button', { class: 'menurow', onclick: () => { close(); saveBot(b, { group: '' }); } }, icon('x'), h('span', {}, T('הוצא מהקבוצה', 'Remove from group'))) : null,
    h('button', { class: 'menurow', onclick: async () => { close(); const n = await promptDlg(T('שם הקבוצה החדשה', 'New group name')); if (n) { await saveSettings({ groups: [...new Set([...(S.settings.groups || []), n])] }); saveBot(b, { group: n }); } } }, icon('plus'), h('span', {}, T('קבוצה חדשה…', 'New group…'))))));
}
function botMenu(b, x, y) {
  const isMain = S.settings.mainBotId === b.id;
  popMenu(x, y, [
    { icon: 'pin', label: b.pinned ? T('ביטול הצמדה', 'Unpin') : T('הצמד למעלה', 'Pin to top'), onclick: () => saveBot(b, { pinned: !b.pinned }) },
    { icon: 'star', label: isMain ? T('בטל בוט ראשי', 'Unset main bot') : T('הגדר כבוט ראשי', 'Set as main bot'), onclick: () => saveSettings({ mainBotId: isMain ? null : b.id }) },
    { icon: 'folder', label: T('העבר לקבוצה…', 'Move to group…'), onclick: () => pickGroup(b) },
    { icon: 'unread', label: T('סימון כלא נקרא', 'Mark as unread'), onclick: () => saveBot(b, { unread: Math.max(1, b.unread || 0) }) },
    null,
    { icon: 'gear', label: T('הגדרות הבוט', 'Bot settings'), onclick: () => V.botSettings(b) },
    { icon: b.hidden ? 'eye' : 'eyeoff', label: b.hidden ? T('החזר לסרגל הצד', 'Show in sidebar') : T('הסתרה מסרגל הצד', 'Hide from sidebar'), onclick: () => saveBot(b, { hidden: !b.hidden }) },
    { icon: 'trash', label: T('מחיקה', 'Delete'), danger: true, onclick: async () => { if (await confirmDlg(T(`למחוק את ${b.name} לצמיתות?`, `Delete ${b.name} permanently?`), T('מחק', 'Delete'), true)) { await del('/bots/' + b.id); if (route.name === 'bot' && route.id === b.id) go('#/'); } } },
  ]);
}
function groupMenu(name, x, y) {
  popMenu(x, y, [
    { icon: 'edit', label: T('שינוי שם', 'Rename'), onclick: async () => { const n = await promptDlg(T('שם הקבוצה', 'Group name'), name); if (!n || n === name) return; for (const b of S.bots.filter((q) => q.group === name)) saveBot(b, { group: n }); saveSettings({ groups: (S.settings.groups || []).map((g) => (g === name ? n : g)) }); } },
    { icon: 'trash', label: T('פירוק הקבוצה', 'Remove group'), danger: true, onclick: () => { for (const b of S.bots.filter((q) => q.group === name)) saveBot(b, { group: '' }); saveSettings({ groups: (S.settings.groups || []).filter((g) => g !== name) }); } },
  ]);
}
function renderSidebar() {
  const unread = S.inbox.filter((n) => n.ts > Number(localStorage.cbInboxSeen || 0)).length;
  const mainId = S.settings.mainBotId;
  const match = (b) => !filter || (b.name + ' ' + (b.title || '')).toLowerCase().includes(filter);
  const byAct = (a, b) => (b.lastActivity || 0) - (a.lastActivity || 0);
  const all = S.bots.filter(match);
  const isTop = (b) => !b.hidden && (b.id === mainId || b.pinned);
  const tiles = all.filter(isTop).sort((a, b) => (b.id === mainId) - (a.id === mainId) || byAct(a, b));
  const rest = all.filter((b) => !b.hidden && !isTop(b)).sort(byAct);
  const hidden = all.filter((b) => b.hidden).sort(byAct);
  const col = collapsed();
  const navBtn = (name, ic, label, badge) => h('button', { class: route.name === name ? 'active' : '', onclick: () => go('#/' + name) }, icon(ic), h('span', {}, label), badge ? h('i', { class: 'badge' }, badge) : null);
  const keepFocus = document.activeElement?.id === 'botsearch';
  const active = (b) => (route.name === 'bot' && route.id === b.id ? ' active' : '');
  const row = (b) => onMenu(h('button', { class: 'botrow' + active(b), onclick: () => go('#/bot/' + b.id) },
    avatar(b, '', b.status || null),
    h('div', { class: 'meta' }, h('div', { class: 'nm' }, h('b', {}, b.name), b.proactive ? h('span', { class: 'tiny', title: T('פרואקטיבי', 'Proactive') }, '⚡') : null, h('time', {}, b.lastActivity ? fmtTime(b.lastActivity) : '')),
      h('div', { class: 'pv' }, b.status ? statusText(b.status) : (b._pv || b.title || b.description || ''))),
    b.unread ? h('i', { class: 'badge' }, b.unread) : null,
    h('span', { class: 'more', role: 'button', title: T('עוד', 'More'), onclick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); botMenu(b, r.left, r.bottom + 4); } }, icon('dots'))), (x, y) => botMenu(b, x, y));
  const tile = (b) => onMenu(h('button', { class: 'tile' + active(b), title: b.title || b.name, onclick: () => go('#/bot/' + b.id) },
    h('div', { class: 'tilewrap' }, avatar(b, 'xl', b.status || null), b.id === mainId ? h('i', { class: 'star', title: T('בוט ראשי', 'Main bot') }, '★') : null, b.unread ? h('i', { class: 'badge' }, b.unread) : null),
    h('span', { dir: 'auto' }, b.name)), (x, y) => botMenu(b, x, y));
  const section = (key, title, bots, menu) => { const shut = !!col[key] && !filter; return [
    onMenu(h('button', { class: 'ghead' + (shut ? ' shut' : ''), onclick: () => toggleCollapsed(key) }, icon('chev'), h('span', { dir: 'auto' }, title), h('i', {}, bots.length), menu ? h('span', { class: 'more', role: 'button', onclick: (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4); } }, icon('dots')) : null), (x, y) => menu?.(x, y)),
    shut ? null : bots.map(row)]; };
  const groups = groupNames();
  $side.replaceChildren(
    h('div', { class: 'brand' }, h('img', { src: '/assets/icon-96.png', alt: '', title: T('WitBox · נוצר ע"י Avi Twil', 'WitBox · created by Avi Twil') }), h('b', {}, 'WitBox'), ibtn('grid', T('דשבורד', 'Dashboard'), () => go('#/dashboard')), ibtn('plus', T('בוט חדש', 'New bot'), () => go('#/new'))),
    h('div', { class: 'search' }, icon('search', 16), h('input', { id: 'botsearch', placeholder: T('חיפוש', 'Search'), value: filter, oninput: (e) => { filter = e.target.value.toLowerCase(); renderSidebar(); } })),
    h('div', { class: 'botlist' },
      tiles.length ? h('div', { class: 'tiles' }, tiles.map(tile)) : null,
      rest.filter((b) => !b.group).map(row),
      groups.map((g) => { const bots = rest.filter((b) => b.group === g); return bots.length || !filter ? section('g:' + g, g, bots, (x, y) => groupMenu(g, x, y)) : null; }),
      !S.bots.length ? h('button', { class: 'newbot', onclick: () => go('#/new') }, icon('plus', 18), h('span', {}, T('בוט חדש', 'New bot'))) : null,
      hidden.length ? section('hidden', T('בוטים מוסתרים', 'Hidden bots'), hidden) : null),
    h('nav', { class: 'nav' }, navBtn('brain', 'brain', T('מוח', 'Brain')), navBtn('routines', 'clock', T('שגרות', 'Routines')), navBtn('inbox', 'bell', T('התראות', 'Inbox'), unread || null), navBtn('devices', 'devices', T('מכשירים', 'Devices')), navBtn('settings', 'gear', T('הגדרות', 'Settings'))),
  );
  if (keepFocus) { const i = document.getElementById('botsearch'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
}

// ---------------------------------------------------------------- main
export function pageHead(title, sub, ...actions) {
  return h('header', { class: 'head' }, ibtn('back', T('חזרה', 'Back'), () => go('#/'), 'back'), h('div', { class: 'ttl' }, h('b', {}, title), sub ? h('small', {}, sub) : null), ...actions);
}
function renderMain() {
  if (route.name === 'bot') return renderChat();
  if (route.name === 'dashboard') { if ($main.firstChild !== Dash.root || $main.childNodes.length !== 1) $main.replaceChildren(Dash.root); return Dash.update(); } // the same node is kept so widget iframes do not reload
  if (route.name === 'home') return $main.replaceChildren(h('div', { class: 'empty' }, h('img', { src: '/assets/icon-192.png', style: { width: '74px', borderRadius: '20px', marginBottom: '14px' } }), h('h2', { style: { margin: '0 0 6px', color: 'var(--tx)' } }, 'WitBox'), h('p', {}, T('צוות הבוטים האישי שלך. בחר בוט או צור חדש.', 'Your personal team of bots. Pick one or create a new one.')), h('div', { class: 'chips' }, h('button', { class: 'btn primary', onclick: () => go('#/new') }, icon('plus'), T('בוט חדש', 'New bot')))));
  const view = { brain: V.brain, routines: V.routinesPage, inbox: V.inbox, devices: V.devicesPage, settings: V.settingsPage, new: V.newBot }[route.name];
  $main.replaceChildren(...[view(route.arg)].flat());
}
export const rerender = () => renderMain();

// ---------------------------------------------------------------- chat
let $msgs, $inner, $status, pendingFiles = [], stick = true;
function renderChatHead() {
  const b = botById(route.id); const head = $main.querySelector('.head'); if (!b || !head) return;
  head.replaceWith(chatHead(b));
}
function chatHead(b) {
  const narrow = !matchMedia('(min-width: 1181px)').matches;
  return h('header', { class: 'head chathead' },
    h('div', { class: 'hside' }, ibtn('back', T('חזרה', 'Back'), () => go('#/'), 'back')),
    h('button', { class: 'pillbot', title: [b.title, modelLabel(b)].filter(Boolean).join(' · '), onclick: () => { toggleDetails(); renderChatHead(); } }, avatar(b, '', b.status || null), h('b', { dir: 'auto' }, b.name), S.settings.mainBotId === b.id ? h('span', { class: 'mainstar', title: T('בוט ראשי', 'Main bot') }, '★') : null, h('span', { class: 'pchev' + (detailsShown() ? ' open' : '') }, icon('chev'))),
    h('div', { class: 'hside end' },
      ibtn('monitor', T('המחשב של הבוט', "Bot's computer"), () => openComputer(b.id), panelState.kind === 'computer' ? 'on' : ''),
      ibtn('gear', T('הגדרות הבוט', 'Bot settings'), () => V.botSettings(b))));
}
const modelLabel = (b) => b.modelMode === 'auto' ? T('מודל אוטומטי', 'Auto model') : (S.models.find((m) => m.id === b.model)?.name || (b.model || '').replace('local:', '⌂ '));

function renderChat() {
  const b = botById(route.id); if (!b) return;
  pendingFiles = [];
  $inner = h('div', { class: 'msgs-inner' });
  $msgs = h('div', { class: 'msgs', onscroll: () => { stick = $msgs.scrollHeight - $msgs.scrollTop - $msgs.clientHeight < 80; } }, $inner);
  $status = h('div', { class: 'statusline' });
  const ta = h('textarea', { rows: 1, placeholder: T(`הודעה ל${b.name}…`, `Message ${b.name}…`), dir: 'auto', oninput: () => { ta.style.height = 'auto'; ta.style.height = Math.min(180, ta.scrollHeight) + 'px'; updSend(); },
    spellcheck: localStorage.cbSpell !== '0',
    onkeydown: (e) => { if (e.key !== 'Enter' || e.isComposing) return; const ctrl = e.ctrlKey || e.metaKey; if (localStorage.cbSendKey === 'ctrl' ? ctrl : (ctrl || (!e.shiftKey && matchMedia('(min-width: 821px)').matches))) { e.preventDefault(); send(); } } });
  ta.value = sessionStorage['draft' + b.id] || '';
  const fileIn = h('input', { type: 'file', multiple: true, hidden: true, onchange: async () => { for (const f of fileIn.files) { try { const r = await api(`/bots/${b.id}/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, raw: true }); pendingFiles.push(r); } catch (e) { toast(e.message); } } fileIn.value = ''; drawPF(); updSend(); } });
  const pf = h('div', { class: 'pending-files' });
  const drawPF = () => pf.replaceChildren(...pendingFiles.map((f, i) => h('span', { class: 'pf' }, '📎 ' + f.name, h('button', { onclick: () => { pendingFiles.splice(i, 1); drawPF(); updSend(); } }, '✕'))));
  const sendBtn = h('button', { class: 'iconbtn send', title: T('שלח', 'Send'), onclick: () => { const has = ta.value.trim() || pendingFiles.length; if (statusOf(b.id) && !has) post(`/bots/${b.id}/stop`); else if (!has) voiceMode(b); else send(); } }, icon('wave'));
  const micBtn = h('button', { class: 'iconbtn mic', title: T('הכתבה', 'Dictate'), onclick: () => { if (dictating()) { stopDictation(); micBtn.classList.remove('rec'); } else { micBtn.classList.add('rec'); const base = ta.value ? ta.value + ' ' : ''; startDictation({ onText: (t) => { ta.value = base + t; ta.dispatchEvent(new Event('input')); }, onEnd: () => micBtn.classList.remove('rec') }); } } }, icon('mic'));
  function updSend() {
    sessionStorage['draft' + b.id] = ta.value;
    const busy = !!statusOf(b.id), has = ta.value.trim() || pendingFiles.length;
    sendBtn.classList.toggle('stop', busy && !has); sendBtn.replaceChildren(icon(busy && !has ? 'stop' : has ? 'send' : 'wave')); sendBtn.title = busy && !has ? T('עצור', 'Stop') : has ? T('שלח', 'Send') : T('שיחה קולית', 'Voice chat');
  }
  async function send() {
    const text = ta.value.trim(); if (!text && !pendingFiles.length) return;
    const att = pendingFiles; pendingFiles = []; drawPF(); ta.value = ''; ta.style.height = 'auto'; updSend(); stick = true;
    try { await post(`/bots/${b.id}/messages`, { text, attachments: att }); } catch (e) { toast(e.message); ta.value = text; }
  }
  $main._updSend = updSend;
  $main.replaceChildren(chatHead(b), $msgs, $status, h('div', { class: 'composer' }, pf, h('div', { class: 'cbox' }, ibtn('plus', T('צרף קובץ', 'Attach'), () => fileIn.click(), 'attachbtn'), fileIn, ta, micBtn, sendBtn)));
  $main._fill = (t) => { ta.value = t; ta.dispatchEvent(new Event('input')); ta.focus(); };
  renderMsgList(); updSend();
  requestAnimationFrame(() => { $msgs.scrollTop = $msgs.scrollHeight; });
  if (matchMedia('(min-width: 821px)').matches) ta.focus();
}
// Redraws only the message list of the open chat; the composer (and its focus / keyboard) is left alone.
function renderMsgList() {
  const b = botById(route.id); if (!b || !$inner || !$inner.isConnected) return renderChat();
  const list = msgs.get(b.id) || [];
  $inner.replaceChildren(...(list.length ? list.map((m) => msgEl(m)) : [emptyState(b, (t) => $main._fill?.(t))]));
  renderStatus(); $main._updSend?.();
  if (stick) requestAnimationFrame(() => { $msgs.scrollTop = $msgs.scrollHeight; });
}
function emptyState(b, fill) {
  const sug = [T('מה אתה יודע לעשות?', 'What can you do?'), T('פתח את הדפדפן במחשב שלך וחפש חדשות טכנולוגיה', 'Open the browser on your computer and find tech news'), T('בנה לי לוח מחוונים לדוגמה', 'Build me a sample dashboard'), T('מה חדש במייל שלי?', "What's new in my email?")];
  return h('div', { class: 'empty', id: 'emptystate' }, avatar(b, 'lg'), h('h2', { style: { margin: '0 0 4px', color: 'var(--tx)' } }, b.name), h('div', {}, b.title || b.description || ''), h('div', { class: 'chips' }, sug.map((s) => h('button', { class: 'chip', onclick: () => fill(s) }, s))));
}
function renderStatus() {
  if (!$status || route.name !== 'bot') return;
  const b = botById(route.id); const s = b?.status;
  $status.replaceChildren(...(s ? [h('i', { class: 'sp' }), statusText(s)] : b?._learning ? ['🧠 ', T('לומד מהשיחה…', 'Learning from the conversation…')] : []));
  $main._updSend?.();
}
function upsertMsg(m, isNew) {
  if (!$inner) return;
  document.getElementById('emptystate')?.remove();
  const old = $inner.querySelector(`[data-id="${m.id}"]`);
  const open = old ? [...old.querySelectorAll('.tooldetail')].map((d) => d.dataset.k) : [];
  const el = msgEl(m, open);
  if (old) old.replaceWith(el); else $inner.append(el);
  if (stick) $msgs.scrollTop = $msgs.scrollHeight;
}

const toolLabel = (b) => {
  const n = b.name, i = b.input || {};
  if (n === 'mcp__bot__computer') return ['monitor', ({ screenshot: T('מצלם מסך', 'Screenshot'), click: T('לוחץ', 'Click'), double_click: T('לחיצה כפולה', 'Double click'), right_click: T('קליק ימני', 'Right click'), type: T('מקליד', 'Type') + (i.text ? `: ${String(i.text).slice(0, 40)}` : ''), key: T('מקש', 'Key') + ` ${i.keys || ''}`, scroll: T('גולל', 'Scroll'), move: T('מזיז עכבר', 'Move'), drag: T('גורר', 'Drag'), wait: T('ממתין', 'Wait') })[i.action] || i.action];
  if (n === 'mcp__bot__pc_shell' || n === 'mcp__bot__windows_shell') return ['kbd', T('טרמינל: ', 'Terminal: ') + String(i.script || '').split('\n')[0].slice(0, 60)];
  if (n === 'mcp__bot__pc_copy' || n === 'mcp__bot__windows_copy') return ['file', T('מעתיק קובץ', 'Copy file')];
  if (n === 'mcp__bot__remember') return ['brain', T('זוכר', 'Remember') + ': ' + String(i.text || '').slice(0, 50)];
  if (n === 'mcp__bot__save_skill') return ['spark', T('שומר סקיל', 'Save skill') + ': ' + (i.name || '')];
  if (n === 'mcp__bot__routine') return ['clock', T('שגרה', 'Routine') + ' ' + (i.op || '')];
  if (n === 'mcp__bot__message_bot') return ['devices', T('פונה ל', 'Asking ') + (i.bot_name || '')];
  if (n === 'mcp__bot__device_control' || n === 'mcp__bot__list_devices') return ['devices', T('מכשיר', 'Device') + ' ' + (i.action?.type || '')];
  if (n === 'mcp__bot__dashboard_widget') return ['grid', T('וידג׳ט בדשבורד', 'Dashboard widget') + (i.title ? ': ' + i.title : '')];
  if (n === 'mcp__bot__dashboard_suggest') return ['grid', T('המלצה בדשבורד', 'Dashboard suggestion') + ': ' + (i.title || '')];
  if (n === 'mcp__bot__dashboard') return ['grid', T('דשבורד', 'Dashboard') + ' ' + (i.op || '').replace(/_/g, ' ')];
  if (n.startsWith('mcp__bot__')) return ['spark', n.slice(10).replace(/_/g, ' ')];
  if (n.startsWith('mcp__')) { const p = n.split('__'); return ['cloud', p[1].replace(/^claude_ai_/, '').replace(/_/g, ' ') + ' · ' + p.slice(2).join(' ').replace(/_/g, ' ')]; }
  if (n === 'WebSearch') return ['search', T('מחפש', 'Search') + ': ' + (i.query || '')];
  if (n === 'WebFetch') return ['cloud', T('קורא', 'Reading') + ' ' + String(i.url || '').replace(/^https?:\/\//, '').slice(0, 50)];
  if (['Read', 'Write', 'Edit', 'Glob', 'Grep'].includes(n)) { const p = String(i.file_path || i.path || i.pattern || ''); return [p.includes('/brain/') ? 'brain' : 'file', ({ Read: T('קורא', 'Read'), Write: T('כותב', 'Write'), Edit: T('עורך', 'Edit'), Glob: T('מחפש קבצים', 'Find'), Grep: T('מחפש', 'Search') })[n] + ' ' + p.split('/').slice(-2).join('/')]; }
  return ['spark', n];
};

function msgEl(m, openKeys = []) {
  const bot = botById(route.id);
  const el = h('div', { class: 'msg ' + (m.role === 'user' ? 'user' : 'bot'), 'data-id': m.id });
  { const list = msgs.get(route.id) || [], i = list.findIndex((x) => x.id === m.id), prev = i > 0 ? list[i - 1] : i < 0 ? list[list.length - 1] : null;
    if (!prev || m.ts - prev.ts > 20 * 60000) { const d = new Date(m.ts), today = d.toDateString() === new Date().toDateString(); el.append(h('div', { class: 'tsep' }, (today ? T('היום', 'Today') : d.toLocaleDateString(S.lang === 'he' ? 'he-IL' : 'en-GB', { day: 'numeric', month: 'short' })) + ' ' + d.toLocaleTimeString(S.lang === 'he' ? 'he-IL' : 'en-GB', { hour: '2-digit', minute: '2-digit' }))); } }
  if (m.from) { const fb = S.bots.find((q) => q.name === m.from); el.append(h('div', { class: 'from' }, T('הודעה מאת', 'Message from'), fb ? avatar(fb) : null, h('b', { dir: 'auto' }, m.from))); }
  if (m.meta?.routine) el.append(h('div', { class: 'from' }, '⚡ ' + T('שגרה', 'Routine') + ': ' + m.meta.routine));
  let group = null;
  const blocks = m.blocks || [];
  blocks.forEach((b, idx) => {
    if (b.type !== 'tool') group = null;
    if (b.type === 'text') { if (!b.text?.trim()) return; el.append(m.role === 'user' ? h('div', { class: 'bubble', dir: 'auto' }, b.text) : h('div', { class: 'bubble' }, mdEl(b.text))); }
    else if (b.type === 'tool') {
      if (['mcp__bot__show_artifact', 'mcp__bot__send_file', 'mcp__bot__notify', 'mcp__bot__request_takeover', 'mcp__bot__secure_input', 'TodoWrite', 'ToolSearch'].includes(b.name) && b.status !== 'error') return;
      if (!group) { group = h('div', { class: 'toolgroup' }); el.append(group); }
      const [ic, lbl] = toolLabel(b); const k = b.id;
      const row = h('button', { class: 'tool ' + (b.status === 'running' ? 'run' : b.status === 'error' ? 'err' : ''), onclick: () => { const d = row.nextSibling; if (d?.classList?.contains('tooldetail')) d.remove(); else row.after(detail()); } }, h('span', { class: 'ic' }, b.status === 'running' ? icon('refresh', 14) : icon(ic, 15)), h('span', { class: 'lbl', dir: 'auto' }, lbl));
      const detail = () => h('div', { class: 'tooldetail', 'data-k': k }, JSON.stringify(b.input, null, 1) + (b.result ? '\n→ ' + b.result : ''));
      group.append(row); if (openKeys.includes(k)) group.append(detail());
    }
    else if (b.type === 'artifact') el.append(h('button', { class: 'artcard', onclick: () => openArtifact(route.id, b.id) }, h('span', { class: 'fi' }, icon(b.kind === 'sheet' ? 'kbd' : 'spark')), h('span', {}, h('b', { dir: 'auto' }, b.title), h('small', {}, ({ html: T('אפליקציה / לוח', 'App / board'), sheet: T('גיליון', 'Sheet'), markdown: T('מסמך', 'Document'), svg: T('תרשים', 'Diagram'), mermaid: T('תרשים', 'Diagram') })[b.kind] + ' · ' + T('לחץ לפתיחה', 'tap to open')))));
    else if (b.type === 'dash') el.append(h('button', { class: 'artcard', onclick: () => go('#/dashboard') }, h('span', { class: 'fi' }, icon('grid')), h('span', {}, h('b', { dir: 'auto' }, b.title), h('small', {}, T('נוסף לדשבורד · לחץ לפתיחה', 'On the dashboard · tap to open')))));
    else if (b.type === 'file') {
      const url = `/api/bots/${route.id}/file?path=${encodeURIComponent(b.path)}`;
      if (/\.(png|jpe?g|gif|webp)$/i.test(b.name)) el.append(h('a', { href: url + '&inline=1', target: '_blank' }, h('img', { src: url + '&inline=1', style: { maxWidth: 'min(320px,80%)', borderRadius: '16px', display: 'block' } })));
      else el.append(h('a', { class: 'attach', href: url, download: b.name }, h('span', { class: 'fi' }, icon('file')), h('span', {}, h('b', { dir: 'auto' }, b.name), h('small', {}, fmtSize(b.size || 0) + (b.caption ? ' · ' + b.caption : '')))));
    }
    else if (b.type === 'notice') el.append(h('div', { class: 'notice' }, '🔔', h('div', {}, h('b', { dir: 'auto' }, b.title), h('div', { class: 'small muted', dir: 'auto' }, b.body))));
    else if (b.type === 'approval') {
      const pend = b.status === 'pending';
      const act = (d) => post('/approvals/' + b.id, { decision: d }).catch((e) => toast(e.message));
      el.append(h('div', { class: 'ask ' + (pend ? 'pending' : '') }, h('b', { dir: 'auto' }, '🛡 ' + b.title), b.detail ? h('pre', {}, b.detail) : null,
        pend ? h('div', { class: 'btns' }, h('button', { class: 'btn primary sm', onclick: () => act('allow') }, T('אשר', 'Allow')), b.toolKey ? h('button', { class: 'btn sm', onclick: () => act('always') }, T('אשר תמיד', 'Always allow')) : null, h('button', { class: 'btn sm danger', onclick: () => act('deny') }, T('דחה', 'Deny')))
          : h('span', { class: 'pill ' + (b.status === 'allowed' || b.status === 'always' ? 'ok' : 'bad') }, ({ allowed: T('אושר', 'Allowed'), always: T('אושר תמיד', 'Always allowed'), denied: T('נדחה', 'Denied'), timeout: T('פג תוקף', 'Timed out'), cancelled: T('בוטל', 'Cancelled') })[b.status] || b.status)));
    }
    else if (b.type === 'takeover') el.append(h('div', { class: 'ask ' + (b.status === 'pending' ? 'pending' : '') }, h('b', {}, '🖐 ' + T('הבוט צריך אותך במחשב', 'The bot needs you at the computer')), h('div', { class: 'small muted', dir: 'auto', style: { marginBottom: '8px' } }, b.reason), b.status === 'pending' ? h('button', { class: 'btn primary sm', onclick: () => openComputer(route.id, { takeover: true }) }, T('השתלט על המחשב', 'Take over')) : h('span', { class: 'pill ok' }, T('הוחזר לבוט', 'Handed back'))));
    else if (b.type === 'secret') {
      if (b.status === 'pending') { const inp = h('input', { class: 'in', type: 'password', autocomplete: 'off', placeholder: b.label }); el.append(h('div', { class: 'ask pending' }, h('b', { dir: 'auto' }, '🔒 ' + b.label), h('div', { class: 'tiny', style: { margin: '2px 0 8px' } }, T('הערך יוקלד ישירות למחשב של הבוט. הבוט לא רואה אותו והוא לא נשמר.', "Typed straight into the bot's computer. The bot never sees it and it is not stored.")), inp, h('div', { class: 'btns', style: { marginTop: '8px' } }, h('button', { class: 'btn primary sm', onclick: () => post('/secrets/' + b.id, { value: inp.value }) }, T('שלח', 'Submit')), h('button', { class: 'btn sm', onclick: () => post('/secrets/' + b.id, { cancel: true }) }, T('ביטול', 'Cancel'))))); }
      else el.append(h('div', { class: 'tool' }, '🔒 ', b.label, ' — ', b.status === 'done' ? T('הוזן', 'entered') : T('בוטל', 'cancelled')));
    }
  });
  if (m.role === 'assistant') {
    if (m.status === 'streaming' && !blocks.some((b) => b.type === 'text' && b.text) && !blocks.some((b) => b.type === 'tool' && b.status === 'running')) el.append(h('div', { class: 'typing' }, h('i'), h('i'), h('i')));
    if (m.status === 'error') el.append(h('div', { class: 'err', dir: 'auto' }, '⚠ ' + (m.error || T('שגיאה', 'Error'))));
    if (m.status === 'stopped') el.append(h('div', { class: 'tiny', style: { padding: '0 6px' } }, T('נעצר', 'Stopped')));
    if (m.status !== 'streaming' && m.meta?.model) el.append(h('div', { class: 'msgmeta' }, h('span', {}, fmtTime(m.ts)), h('span', {}, (S.models.find((x) => x.id === m.meta.model)?.name || m.meta.model.replace('local:', '⌂ ')) + (m.meta.effort ? ' · ' + m.meta.effort : '')), m.meta.why?.startsWith('auto') ? h('span', {}, T('אוטומטי', 'auto')) : null));
  }
  return el;
}

// ---------------------------------------------------------------- boot
const hideSplash = () => { const el = document.getElementById('splash'); if (!el) return; (window.__intro || Promise.resolve()).then(() => { el.classList.add('out'); setTimeout(() => el.remove(), 750); }); }; // the intro film plays, then the app appears
(async function boot() {
  try { await refresh(); } catch (e) { hideSplash(); document.body.append(h('div', { class: 'empty' }, T('לא ניתן להתחבר לשרת', 'Cannot reach the server'), h('br'), String(e.message))); return; }
  hideSplash();
  connect();
  render();
  if (/^#?\/?$/.test(location.hash)) history.replaceState(null, '', '#/dashboard'); // the app opens on the dashboard
  onRoute();
  if (!native.available && window.Notification && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission(), { once: true });
  document.addEventListener('click', (e) => { const n = e.target.closest?.('.wl'); if (n) go('#/brain/' + encodeURIComponent(n.dataset.note)); });
})();
function render() { renderSidebar(); }
