// Small UI toolkit: DOM helper, icons, markdown, API client, toasts, modals, native bridge.
export const S = { dashboard: { widgets: [], suggestions: [] }, bots: [], routines: [], settings: {}, models: [], efforts: [], devices: [], inbox: [], vm: {}, lang: localStorage.cbLang || 'he' };
export const T = (he, en) => (S.lang === 'he' ? he : en ?? he);

for (const m of ['replaceChildren', 'append']) { const o = Element.prototype[m]; Element.prototype[m] = function (...k) { return o.apply(this, k.flat(Infinity).filter((x) => x != null && x !== false)); }; }
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
}
const P = {
  plus: 'M12 5v14M5 12h14', back: 'M15 6l-6 6 6 6', send: 'M12 19V5M5 12l7-7 7 7', stop: 'M7 7h10v10H7z', mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3', clip: 'M21 11l-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8',
  monitor: 'M3 5h18v11H3zM8 20h8M12 16v4', gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM19 12a7 7 0 0 0-.1-1.3l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2.2-1.3L14 3h-4l-.4 2.5a7 7 0 0 0-2.2 1.3l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5 12c0 .4 0 .9.1 1.3l-2 1.5 2 3.4 2.3-1c.6.6 1.4 1 2.2 1.3L10 21h4l.4-2.5c.8-.3 1.6-.7 2.2-1.3l2.3 1 2-3.4-2-1.5c.1-.4.1-.9.1-1.3z',
  brain: 'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0V7a3 3 0 0 0-3-3zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 0', clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2', bell: 'M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7zM10 20a2 2 0 0 0 4 0', devices: 'M3 5h13v9H3zM1 17h17M19 8h3v11h-5', x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-10', file: 'M6 3h8l4 4v14H6zM14 3v4h4', spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z', hand: 'M8 12V5a1.5 1.5 0 0 1 3 0v6V4a1.5 1.5 0 0 1 3 0v7V6a1.5 1.5 0 0 1 3 0v8c0 4-2 7-6 7s-5-2-7-6l-1-2a1.5 1.5 0 0 1 2.600-1.500z', rec: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z', wave: 'M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4',
  star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.700 1-5.900-4.300-4.100 5.900-.800z', pin: 'M9 4h6l-1 6 3 3H7l3-3zM12 13v7', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', eyeoff: 'M4 4l16 16M10 6a9 9 0 0 1 2-.2c6 0 10 6.200 10 6.200a17 17 0 0 1-3 3.500M6.500 7.500A17 17 0 0 0 2 12s4 7 10 7c1.500 0 2.900-.400 4.100-1', folder: 'M3 6h6l2 2h10v11H3z', side: 'M3 5h18v14H3zM9 5v14', chev: 'M9 6l6 6-6 6', unread: 'M4 6h16v12H4zM4 7l8 6 8-6',
  grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z', chat: 'M4 5h16v11H10l-5 4v-4H4z',
  vault: 'M4 5h16v14H4zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM7 19v2M17 19v2', usage: 'M5 20V10M12 20V4M19 20v-7',
  dots: 'M5 12h.01M12 12h.01M19 12h.01', trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13', play: 'M7 5l12 7-12 7z', dl: 'M12 4v11M7 11l5 5 5-5M5 20h14', search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4', edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4', refresh: 'M4 12a8 8 0 0 1 14-5l2-2v6h-6l2-2a5.500 5.500 0 0 0-9.500 3M20 12a8 8 0 0 1-14 5l-2 2v-6h6l-2 2a5.500 5.500 0 0 0 9.500-3', kbd: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10', expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', shield: 'M12 3l8 3v6c0 5-3.500 8-8 9-4.500-1-8-4-8-9V6z', cloud: 'M7 18a4 4 0 0 1 0-8 5 5 0 0 1 9.600-1.500A4.500 4.500 0 0 1 17 18z',
};
export const icon = (n, s) => h('span', { class: 'ic', html: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"${s ? ` style="width:${s}px;height:${s}px"` : ''}><path d="${P[n] || P.dots}"/></svg>` }).firstChild;
export const ibtn = (n, title, onclick, cls = '') => h('button', { class: 'iconbtn ' + cls, title, 'aria-label': title, onclick }, icon(n));

// ---- API
export async function api(path, { method = 'GET', body, raw } = {}) {
  const r = await fetch('/api' + path, { method, headers: { 'X-CB': '1', ...(body && !raw ? { 'content-type': 'application/json' } : {}) }, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}
export const post = (p, body) => api(p, { method: 'POST', body: body || {} });
export const patch = (p, body) => api(p, { method: 'PATCH', body });
export const del = (p) => api(p, { method: 'DELETE' });

export function toast(text, ms = 2600) {
  const t = h('div', { class: 'toast' }, text);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}
export function modal(content, { onclose } = {}) {
  const root = document.getElementById('modal-root');
  const m = h('div', { class: 'modal', onmousedown: (e) => { if (e.target === m) close(); } }, content);
  const close = () => { m.remove(); onclose?.(); };
  root.append(m);
  return close;
}
export function confirmDlg(text, okLabel = T('אישור', 'OK'), danger) {
  return new Promise((res) => {
    const close = modal(h('div', { class: 'sheet', style: { width: 'min(420px,100%)' } }, h('div', { class: 'body' }, h('p', { style: { margin: '6px 0 0', fontSize: '16px' } }, text)),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => { res(false); close(); } }, T('ביטול', 'Cancel')), h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { res(true); close(); } }, okLabel))), { onclose: () => res(false) });
  });
}

// Per-device look & feel (stored on this device only): theme, accent colour.
export function applyPrefs(botColor) {
  const root = document.documentElement, th = localStorage.cbTheme || 'dark';
  root.dataset.theme = th === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : th;
  if (botColor !== undefined) applyPrefs.bot = botColor;
  const acc = localStorage.cbAccent || '#d97757', c = acc === 'bot' ? applyPrefs.bot || '#d97757' : acc;
  root.style.setProperty('--acc', /^#fff|^#f2f2f3/i.test(c) ? '#d97757' : c); root.style.setProperty('--acc2', c);
}
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => applyPrefs());
export function promptDlg(title, value = '', okLabel = T('שמור', 'Save')) {
  return new Promise((res) => {
    const inp = h('input', { class: 'in', value, dir: 'auto', onkeydown: (e) => { if (e.key === 'Enter') { res(inp.value.trim()); close(); } } });
    const close = modal(h('div', { class: 'sheet', style: { width: 'min(420px,100%)' } }, h('div', { class: 'body' }, h('p', { style: { margin: '4px 0 10px', fontSize: '16px', fontWeight: 600 } }, title), inp),
      h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => { res(null); close(); } }, T('ביטול', 'Cancel')), h('button', { class: 'btn primary', onclick: () => { res(inp.value.trim()); close(); } }, okLabel))), { onclose: () => res(null) });
    setTimeout(() => inp.focus(), 30);
  });
}
// Small popup menu at a screen position. items: [{icon, label, onclick, danger}] or null for a divider.
export function popMenu(x, y, items) {
  document.querySelector('.popmenu-back')?.remove();
  const back = h('div', { class: 'popmenu-back', onmousedown: (e) => { if (e.target === back) back.remove(); }, oncontextmenu: (e) => { e.preventDefault(); back.remove(); } });
  const m = h('div', { class: 'popmenu' }, items.map((it) => (it ? h('button', { class: it.danger ? 'danger' : '', onclick: () => { back.remove(); it.onclick(); } }, icon(it.icon), h('span', {}, it.label)) : h('hr'))));
  back.append(m); document.body.append(back);
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px'; m.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
// Right-click, long-press (touch) -> open(x, y)
export function onMenu(el, open) {
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); open(e.clientX, e.clientY); });
  let t = null;
  el.addEventListener('touchstart', (e) => { const p = e.touches[0]; t = setTimeout(() => { t = null; el._held = true; open(p.clientX, p.clientY); }, 520); }, { passive: true });
  for (const ev of ['touchend', 'touchmove', 'touchcancel']) el.addEventListener(ev, () => { clearTimeout(t); }, { passive: true });
  el.addEventListener('click', (e) => { if (el._held) { el._held = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  return el;
}

// ---- helpers
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const fmtSize = (n) => (n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : n > 1e3 ? Math.round(n / 1e3) + ' KB' : n + ' B');
export function fmtTime(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(S.lang === 'he' ? 'he-IL' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  if (now - d < 6 * 864e5) return d.toLocaleDateString(S.lang === 'he' ? 'he-IL' : 'en-GB', { weekday: 'short' });
  return d.toLocaleDateString(S.lang === 'he' ? 'he-IL' : 'en-GB', { day: 'numeric', month: 'numeric' });
}
// ---- bot faces: a coloured shape with two eyes that blinks, perks up on hover and moves while the bot works
const wavy = (n, amp, r = 41, rot = 0) => { let d = ''; for (let i = 0; i < 72; i++) { const t = (i / 72) * Math.PI * 2; const rr = r + amp * Math.cos(n * t + rot); d += (i ? 'L' : 'M') + (50 + rr * Math.sin(t)).toFixed(1) + ' ' + (50 - rr * Math.cos(t)).toFixed(1); } return d + 'z'; };
export const SHAPES = [
  ['circle', 'M50 6a44 44 0 1 0 0 88a44 44 0 1 0 0-88z'],
  ['squircle', 'M50 6C84 6 94 16 94 50S84 94 50 94 6 84 6 50 16 6 50 6z'],
  ['flower', wavy(8, 4.5)],
  ['star', wavy(5, 7, 40)],
  ['clover', wavy(4, 6.5, 40, Math.PI)],
  ['pick', 'M50 8C63 8 93 60 89 77S65 94 50 94 15 93 11 77 37 8 50 8z'],
  ['blob', 'M53 6C77 4 97 25 93 51S77 96 49 94 7 81 6 54 27 8 53 6z'],
  ['egg', 'M50 5C73 5 90 31 90 57S72 95 50 95 10 83 10 57 27 5 50 5z'],
];
const hashOf = (s) => { let x = 7; for (const c of String(s || '')) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; };
export const shapeOf = (bot) => { const i = SHAPES.findIndex((q) => q[0] === bot.shape); return i >= 0 ? i : hashOf(bot.id || bot.name) % SHAPES.length; };
const darkColor = (hex) => { const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return false; const n = parseInt(m[1], 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255 < 0.3; };
export const statusText = (s) => ({ thinking: T('חושב…', 'Thinking…'), writing: T('כותב…', 'Writing…'), working: T('עובד…', 'Working…'), computer: T('משתמש במחשב…', 'Using the computer…'), device: T('שולט במכשיר…', 'Controlling a device…'), waiting: T('ממתין לך', 'Waiting for you') }[s] || '');
// One construction for every bot: a shape and two leaning eyes. At rest it only blinks and lets its gaze drift;
// its motion changes with what the bot is doing (thinking / working / waiting for you / just finished).
export function avatar(bot, cls = '', status) {
  const color = bot.color || '#d97757', hsh = hashOf(bot.id || bot.name), eye = darkColor(color) ? '#fff' : '#17171a';
  const [rx, ry] = [[5, -5], [0, -3], [-4, -4], [4, -1], [0, -6]][hsh % 5]; // each bot rests its gaze somewhere else
  const st = status === 'waiting' ? 'wait' : status === 'thinking' ? 'think' : status ? 'work' : bot._doneAt && Date.now() - bot._doneAt < 2600 && status !== undefined ? 'done' : '';
  const a = h('div', { class: 'avatar face ' + cls + (st ? ' ' + st : ''), title: status ? statusText(status) : null, style: { '--d': -(hsh % 50) / 10 + 's', '--now': -(Date.now() % 600000) / 1000 + 's' }, html:
    `<svg viewBox="-7 -7 114 114" aria-hidden="true"><circle class="forbit" cx="50" cy="50" r="52" fill="none" stroke="${esc(color)}" stroke-width="5" stroke-linecap="round" stroke-dasharray="78 249"/>` +
    `<g class="fbody"><path d="${SHAPES[shapeOf(bot)][1]}" fill="${esc(color)}"/><g class="fgaze" style="transform:translate(${rx}px,${ry}px)" data-rx="${rx}" data-ry="${ry}"><g class="feyes" fill="${eye}" stroke="${eye}">` +
    `<g class="fpair"><g transform="rotate(-20 39 46)"><rect class="feye" x="35" y="36.5" width="8" height="19" rx="4" stroke="none"/></g><g transform="rotate(-20 60 46)"><rect class="feye" x="55" y="34" width="10" height="24" rx="5" stroke="none"/></g></g>` +
    `<g class="fhappy" fill="none" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"><path d="M32 51q7-11 14 0"/><path d="M54 51q7-11 14 0"/></g>` +
    `<g class="fbang" stroke="none"><path d="M45.5 27h9l-1.8 30h-5.4z"/><circle cx="50" cy="67" r="5.2"/></g></g></g></g></svg>` });
  if (status !== undefined) a.append(h('i', { class: 'dot ' + (status === 'waiting' ? 'wait' : status ? 'busy' : 'idle') }));
  return a;
}
// On hover the eyes follow the pointer.
let gazeEl = null;
document.addEventListener('mousemove', (e) => {
  const host = e.target.closest?.('.botrow, .tile, .pillbot, .dhero, .shapes button, .avatar.face');
  const g = host?.querySelector('.fgaze') || null;
  if (gazeEl && gazeEl !== g) gazeEl.style.transform = `translate(${gazeEl.dataset.rx}px,${gazeEl.dataset.ry}px)`;
  gazeEl = g; if (!g) return;
  const r = g.ownerSVGElement.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2), len = Math.hypot(dx, dy) || 1, k = Math.min(1, len / 60) * 9;
  g.style.transform = `translate(${((dx / len) * k).toFixed(1)}px,${((dy / len) * k).toFixed(1)}px)`;
}, { passive: true });

// ---- markdown (safe: everything is escaped first)
function inline(s) {
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0001${codes.length - 1}\u0001`; });
  s = esc(s)
    .replace(/!\[([^\]]*)\]\((https?:[^)\s]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(((?:https?:|mailto:|\/)[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => `<span class="wl" data-note="${a}">${b || a}</span>`)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>').replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  return s.replace(/\u0001(\d+)\u0001/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}
export function md(src) {
  const lines = String(src || '').replace(/\r/g, '').split('\n');
  let out = '', i = 0;
  const listStack = [];
  const closeLists = (to = 0) => { while (listStack.length > to) out += `</li></${listStack.pop().t}>`; };
  while (i < lines.length) {
    let l = lines[i];
    const fence = l.match(/^\s*```(\w*)/);
    if (fence) { closeLists(); const buf = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]); i++; out += `<pre><code>${esc(buf.join('\n'))}</code></pre>`; continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      closeLists();
      const row = (x) => x.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      let t = '<table><thead><tr>' + row(l).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'; i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) t += '<tr>' + row(lines[i++]).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
      out += t + '</tbody></table>'; continue;
    }
    const hd = l.match(/^(#{1,4})\s+(.*)/);
    if (hd) { closeLists(); out += `<h${hd[1].length}>${inline(hd[2])}</h${hd[1].length}>`; i++; continue; }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(l)) { closeLists(); out += '<hr>'; i++; continue; }
    const li = l.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
    if (li) {
      const depth = Math.floor(li[1].replace(/\t/g, '  ').length / 2), t = /\d/.test(li[2]) ? 'ol' : 'ul';
      while (listStack.length > depth + 1) out += `</li></${listStack.pop().t}>`;
      if (listStack.length === depth + 1) out += '</li><li>'; else { while (listStack.length < depth + 1) { out += `<${t}><li>`; listStack.push({ t }); } }
      const cb = li[3].match(/^\[( |x|X)\]\s+(.*)/);
      out += cb ? `<input type="checkbox" disabled ${cb[1] !== ' ' ? 'checked' : ''}> ${inline(cb[2])}` : inline(li[3]); i++; continue;
    }
    if (/^\s*>/.test(l)) { closeLists(); const buf = []; while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, '')); out += `<blockquote>${md(buf.join('\n'))}</blockquote>`; continue; }
    if (!l.trim()) { closeLists(); i++; continue; }
    if (listStack.length && /^\s{2,}\S/.test(l)) { out += '<br>' + inline(l.trim()); i++; continue; }
    closeLists();
    const buf = [l]; i++;
    while (i < lines.length && lines[i].trim() && !/^(\s*```|#{1,4}\s|\s*([-*+]|\d+[.)])\s|\s*>|\s*\|.*\|\s*$)/.test(lines[i])) buf.push(lines[i++]);
    out += `<p>${buf.map(inline).join('<br>')}</p>`;
  }
  closeLists();
  return out;
}
export const mdEl = (text) => h('div', { class: 'md', dir: 'auto', html: md(text) });

// ---- native bridge (Android app / desktop app). See docs/CLIENT_CONTRACT.md
let nid = 1; const waits = new Map(); const listeners = new Map();
const channel = window.WitBoxNative ? (s) => window.WitBoxNative.postMessage(s) : window.ipc ? (s) => window.ipc.postMessage(s) : null;
window.cbNative = {
  resolve(id, obj) { const w = waits.get(id); if (w) { waits.delete(id); w(obj || {}); } },
  emit(ev, data) { for (const f of listeners.get(ev) || []) try { f(data || {}); } catch (e) { console.error(e); } },
};
export const native = {
  available: !!channel,
  platform: /WitBoxApp\/[\d.]+ \((\w+)\)/.exec(navigator.userAgent)?.[1] || null,
  call(cmd, args = {}) {
    if (!channel) return Promise.resolve({ error: 'unsupported' });
    return new Promise((res) => { const id = nid++; waits.set(id, res); setTimeout(() => { if (waits.delete(id)) res({ error: 'timeout' }); }, cmd === 'setPermission' ? 70000 : 15000); channel(JSON.stringify({ id, cmd, args })); });
  },
  on(ev, f) { (listeners.get(ev) || listeners.set(ev, new Set()).get(ev)).add(f); return () => listeners.get(ev).delete(f); },
};
