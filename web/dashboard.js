// The dashboard: a full-screen home made of widgets (small apps the bots build) and suggestion cards.
// The root node is created once and patched in place, so widget iframes are not reloaded on every state change.
import { S, T, h, icon, ibtn, api, post, patch, del, toast, promptDlg, confirmDlg, popMenu, avatar, fmtTime, statusText } from './ui.js';

const open = (hash) => { location.hash = hash; };
const bot = (id) => S.bots.find((b) => b.id === id);
const mainBot = () => bot(S.settings.mainBotId) || S.bots.find((b) => !b.hidden) || S.bots[0];
const SIZES = [['small', 'קטן', 'Small'], ['wide', 'רחב', 'Wide'], ['tall', 'גבוה', 'Tall'], ['large', 'גדול', 'Large'], ['full', 'שורה מלאה', 'Full row']];

const $greet = h('div', { class: 'dgreet' });
const $sug = h('section', { class: 'dsug' });
const $team = h('div', { class: 'dteam' });
const $grid = h('div', { class: 'dgrid' });
const $empty = h('div', { class: 'dempty' });
const $askbot = h('button', { class: 'askbot', type: 'button' });
const $input = h('input', { dir: 'auto', enterkeyhint: 'send', onkeydown: (e) => { if (e.key === 'Enter' && !e.isComposing) ask(); } });
const $top = h('header', { class: 'dashtop' });
export const root = h('div', { class: 'dash' }, $top,
  h('div', { class: 'dashscroll' }, h('div', { class: 'dashin' }, $greet, $sug, $team, $grid, $empty)),
  h('div', { class: 'dashask' }, h('div', { class: 'cbox' }, $askbot, $input, h('button', { class: 'iconbtn send', title: T('שלח', 'Send'), onclick: () => ask() }, icon('send')))));

let askBotId = null;
const cards = new Map(); // widget id -> { card, frame, title, time, face, key }

// Anything that is asked for on the dashboard is carried out by a bot, in its chat.
async function sendTo(b, text, extra = {}) {
  if (!b) return toast(T('אין עדיין בוטים. צור בוט ראשון.', 'No bots yet. Create one first.'));
  try { await post(`/bots/${b.id}/messages`, { text, ...extra }); open('#/bot/' + b.id); } catch (e) { toast(e.message); }
}
function ask() {
  const text = $input.value.trim(); if (!text) return;
  $input.value = '';
  sendTo(bot(askBotId) || mainBot(), text, { dashboard: true });
}

const frameUrl = (w) => {
  const cs = getComputedStyle(document.documentElement);
  return `/api/dashboard/widgets/${w.id}/raw?v=${w.v || 0}&theme=${document.documentElement.dataset.theme || 'dark'}&acc=${encodeURIComponent(cs.getPropertyValue('--acc').trim())}&lang=${S.lang}`;
};

function widgetMenu(w, x, y) {
  const owner = bot(w.botId) || mainBot();
  popMenu(x, y, [
    { icon: 'edit', label: T('בקש שינוי מהבוט…', 'Ask the bot to change it…'), onclick: async () => { const t = await promptDlg(T(`מה לשנות ב"${w.title}"?`, `What should change in "${w.title}"?`), '', T('שלח לבוט', 'Send')); if (t) sendTo(owner, T(`בווידג׳ט "${w.title}" שבדשבורד (id ${w.id}): ${t}`, `In the dashboard widget "${w.title}" (id ${w.id}): ${t}`), { dashboard: true }); } },
    { icon: 'refresh', label: T('רענן עכשיו', 'Refresh now'), onclick: async () => { const c = cards.get(w.id); if (w.refresh) { try { await post(`/dashboard/widgets/${w.id}/refresh`); toast(T('הבוט מביא נתונים עדכניים…', 'The bot is fetching fresh data…')); } catch (e) { toast(e.message); } } else if (c) c.frame.src = frameUrl(w) + '&t=' + Date.now(); } },
    null,
    ...SIZES.map(([k, he, en]) => ({ icon: w.size === k ? 'check' : 'expand', label: T('גודל: ' + he, 'Size: ' + en), onclick: () => save(w, { size: k }) })),
    null,
    { icon: 'back', label: T('הזז אחורה', 'Move earlier'), onclick: () => save(w, { move: 'back' }) },
    { icon: 'chev', label: T('הזז קדימה', 'Move later'), onclick: () => save(w, { move: 'forward' }) },
    w.refresh ? { icon: 'clock', label: T(`עצור רענון אוטומטי (כל ${w.refresh.minutes} דק׳)`, `Stop auto refresh (every ${w.refresh.minutes} min)`), onclick: () => save(w, { refresh_minutes: 0 }) } : false,
    { icon: 'trash', label: T('הסר מהדשבורד', 'Remove from dashboard'), danger: true, onclick: async () => { if (await confirmDlg(T(`להסיר את "${w.title}" מהדשבורד?`, `Remove "${w.title}" from the dashboard?`), T('הסר', 'Remove'), true)) { try { await del('/dashboard/widgets/' + w.id); } catch (e) { toast(e.message); } } } },
  ].filter((x) => x !== false));
}
async function save(w, body) { try { await patch('/dashboard/widgets/' + w.id, body); } catch (e) { toast(e.message); } }

function makeCard(w) {
  const frame = h('iframe', { class: 'wframe', title: w.title, loading: 'lazy', src: frameUrl(w) });
  const title = h('b', { dir: 'auto' }), time = h('small', {}), face = h('span', { class: 'wface' });
  const more = h('button', { class: 'wmore', title: T('עוד', 'More'), onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); const cur = S.dashboard.widgets.find((x) => x.id === w.id); if (cur) widgetMenu(cur, r.left, r.bottom + 4); } }, icon('dots'));
  const card = h('article', { class: 'wcard', 'data-id': w.id }, h('div', { class: 'whead' }, face, title, time, more), frame);
  return { card, frame, title, time, face, key: '' };
}

function drawWidgets() {
  const list = S.dashboard.widgets;
  const theme = (document.documentElement.dataset.theme || 'dark') + getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() + S.lang;
  for (const [id, c] of cards) if (!list.some((w) => w.id === id)) { c.card.remove(); cards.delete(id); }
  for (const w of list) {
    let c = cards.get(w.id); if (!c) { c = makeCard(w); cards.set(w.id, c); c.key = (w.v || 0) + theme; }
    const key = (w.v || 0) + theme;
    if (c.key !== key) { c.key = key; c.frame.src = frameUrl(w); }
    c.card.className = 'wcard ' + (w.size || 'small');
    c.title.textContent = w.title;
    c.time.textContent = w.refresh ? fmtTime(w.updatedAt) : '';
    c.time.title = w.refresh ? T(`מתעדכן כל ${w.refresh.minutes} דקות`, `Refreshes every ${w.refresh.minutes} min`) : '';
    const b = bot(w.botId); const fk = b ? b.id + (b.shape || '') + b.color : '';
    if (c.face.dataset.k !== fk) { c.face.dataset.k = fk; c.face.replaceChildren(b ? avatar(b, 'sm') : null); c.face.title = b?.name || ''; }
  }
  // Re-attach only when the order really changed: moving an iframe in the DOM reloads it.
  const want = list.map((w) => w.id), have = [...$grid.children].map((n) => n.dataset.id);
  if (want.join() !== have.join()) $grid.replaceChildren(...want.map((id) => cards.get(id).card));
}

function drawSuggestions() {
  const act = async (s, i) => { try { const r = await post(`/dashboard/suggestions/${s.id}/act`, { index: i }); open('#/bot/' + r.botId); } catch (e) { toast(e.message); } };
  $sug.replaceChildren(...S.dashboard.suggestions.map((s) => { const b = bot(s.botId);
    return h('div', { class: 'sug' + (s.priority === 'high' ? ' high' : '') },
      b ? avatar(b) : h('span', { class: 'fi' }, icon('spark')),
      h('div', { class: 'grow' },
        h('div', { class: 'sugmeta' }, h('span', { dir: 'auto' }, b?.name || ''), h('time', {}, fmtTime(s.ts))),
        h('b', { dir: 'auto' }, s.title), s.text ? h('p', { dir: 'auto' }, s.text) : null,
        h('div', { class: 'btns' }, s.actions.map((a, i) => h('button', { class: 'btn sm' + (i === 0 ? ' primary' : ''), onclick: () => act(s, i) }, a.label)),
          b ? h('button', { class: 'btn sm ghost', onclick: () => open('#/bot/' + b.id) }, T('פתח צ׳אט', 'Open chat')) : null)),
      h('button', { class: 'iconbtn', title: T('סגור', 'Dismiss'), onclick: () => del('/dashboard/suggestions/' + s.id).catch((e) => toast(e.message)) }, icon('x')));
  }));
}

function drawTeam() {
  const bots = S.bots.filter((b) => !b.hidden);
  $team.replaceChildren(...bots.map((b) => h('button', { class: 'tm' + (b.status ? ' busy' : ''), title: b.title || b.name, onclick: () => open('#/bot/' + b.id) },
    avatar(b, '', b.status || null), h('span', {}, h('b', { dir: 'auto' }, b.name), h('small', {}, b.status ? statusText(b.status) : b.unread ? T(`${b.unread} חדשות`, `${b.unread} new`) : T('זמין', 'Idle'))),
    b.unread ? h('i', { class: 'badge' }, b.unread) : null)));
}

function drawTop() {
  const hr = new Date().getHours(), name = S.settings.userName || '';
  const hello = hr < 5 ? T('לילה טוב', 'Good night') : hr < 12 ? T('בוקר טוב', 'Good morning') : hr < 17 ? T('צהריים טובים', 'Good afternoon') : hr < 21 ? T('ערב טוב', 'Good evening') : T('לילה טוב', 'Good night');
  $greet.replaceChildren(h('h1', { dir: 'auto' }, hello + (name ? ', ' + name : '')), h('p', {}, new Date().toLocaleDateString(S.lang === 'he' ? 'he-IL' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long' })));
  const unread = S.bots.reduce((n, b) => n + (b.unread || 0), 0);
  $top.replaceChildren(
    h('button', { class: 'btn tochat', onclick: () => open('#/') }, icon('chat'), h('span', {}, T('מעבר לצ׳אט', 'Go to chat')), unread ? h('i', { class: 'badge' }, unread) : null),
    h('span', { class: 'dbrand' }, h('img', { src: '/assets/icon-96.png', alt: '' }), h('b', {}, T('דשבורד', 'Dashboard'))),
    h('span', { class: 'dtools' }, ibtn('bell', T('התראות', 'Inbox'), () => open('#/inbox')), ibtn('gear', T('הגדרות', 'Settings'), () => open('#/settings'))));
}

function drawAsk() {
  if (!bot(askBotId)) askBotId = mainBot()?.id || null;
  const b = bot(askBotId);
  $askbot.replaceChildren(b ? avatar(b, 'sm') : icon('spark'), h('span', { dir: 'auto' }, b?.name || ''), icon('chev'));
  $askbot.onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); popMenu(r.left, Math.max(8, r.top - 12 - 42 * S.bots.filter((q) => !q.hidden).length), S.bots.filter((q) => !q.hidden).map((q) => ({ icon: q.id === askBotId ? 'check' : 'spark', label: q.name, onclick: () => { askBotId = q.id; drawAsk(); $input.focus(); } }))); };
  $input.placeholder = b ? T(`בקש מ${b.name} וידג׳ט חדש…`, `Ask ${b.name} for a new widget…`) : T('צור בוט כדי להתחיל', 'Create a bot to start');
}

function drawEmpty() {
  const none = !S.dashboard.widgets.length;
  $empty.hidden = !none;
  if (!none) return;
  const ex = [T('וידג׳ט מזג אוויר לעיר שלי', 'A weather widget for my city'), T('התוצאה של המשחק האחרון של הקבוצה שלי', "My team's latest result"), T('סיכום המיילים החשובים מהיום', "Today's important emails"), T('הפגישות שלי להיום', "Today's meetings"), T('שער הדולר והביטקוין', 'USD and Bitcoin rates'), T('רשימת משימות שאפשר לסמן', 'A to-do list I can tick off')];
  $empty.replaceChildren(h('div', { class: 'dph' }, icon('grid')), h('b', {}, T('הדשבורד שלך מחכה לווידג׳טים', 'Your dashboard is waiting for widgets')),
    h('p', {}, T('מבקשים מהבוט במילים, והוא בונה את הווידג׳ט ושם אותו כאן. אפשר להתחיל מאחת הדוגמאות:', 'Ask a bot in plain words and it builds the widget and puts it here. Start from an example:')),
    h('div', { class: 'chips' }, ex.map((t) => h('button', { class: 'btn sm', onclick: () => { $input.value = t; $input.focus(); } }, t))));
}

export function update() {
  S.dashboard ||= { widgets: [], suggestions: [] };
  drawTop(); drawSuggestions(); drawTeam(); drawWidgets(); drawEmpty(); drawAsk();
}

// A widget may hand work to its bot: cb.ask("...") inside the iframe. Honoured only for the widget the user is interacting with.
window.addEventListener('message', (e) => {
  const d = e.data; if (!d || d.cb !== 'ask' || typeof d.prompt !== 'string' || !d.prompt.trim()) return;
  const hit = [...cards.entries()].find(([, c]) => c.frame.contentWindow === e.source);
  if (!hit || !root.isConnected || document.activeElement !== hit[1].frame) return;
  const w = S.dashboard.widgets.find((x) => x.id === hit[0]);
  sendTo(bot(w?.botId) || mainBot(), d.prompt.trim().slice(0, 4000));
});
