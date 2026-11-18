// Side panel: the bot's live Windows desktop (watch / take over / teach) and artifacts.
import { S, T, h, icon, ibtn, api, post, toast, mdEl, esc, modal } from './ui.js';

const $app = document.getElementById('app'), $panel = document.getElementById('panel');
export const panelState = { kind: null, botId: null };
let rfb = null, redraw = null;

export function closePanel() {
  if (rfb) { try { rfb.disconnect(); } catch {} rfb = null; }
  const { kind, botId } = panelState;
  if (kind === 'computer' && botId && deskInfo(botId).takeover && !deskInfo(botId).teaching) post(`/bots/${botId}/desktop`, { action: 'release' }).catch(() => {});
  panelState.kind = null; panelState.botId = null; redraw = null;
  $panel.hidden = true; $panel.replaceChildren(); $app.classList.remove('with-panel');
  document.querySelector('.head .iconbtn.on')?.classList.remove('on');
}
function showPanel(kind, botId, ...children) {
  if (rfb) { try { rfb.disconnect(); } catch {} rfb = null; }
  panelState.kind = kind; panelState.botId = botId;
  $panel.hidden = false; $app.classList.add('with-panel'); $panel.replaceChildren(...children);
}
const deskInfo = (botId) => (botId === 'admin' ? S.adminDesktop : S.bots.find((b) => b.id === botId)?.desktop) || { running: false };
export function onDesktopEvent(botId) { if (panelState.kind === 'computer' && panelState.botId === botId) redraw?.(); }

const KS = { Escape: 0xff1b, Tab: 0xff09, Enter: 0xff0d, Backspace: 0xff08, Delete: 0xffff, Win: 0xffeb, Ctrl: 0xffe3, Alt: 0xffe9, Shift: 0xffe1, Up: 0xff52, Down: 0xff54, Left: 0xff51, Right: 0xff53, F5: 0xffc2, F11: 0xffc8 };

export async function openComputer(botId, { takeover = false } = {}) {
  if (panelState.kind === 'computer' && panelState.botId === botId && !takeover) return closePanel();
  const bot = botId === 'admin' ? { id: 'admin', name: 'Administrator' } : S.bots.find((b) => b.id === botId);
  const screen = h('div', { class: 'screen' });
  const overlay = h('div', { class: 'overlay' });
  const bar = h('div', { class: 'screenbar' });
  const keys = h('div', { class: 'keys', hidden: true });
  const wrap = h('div', { class: 'screenwrap' }, screen, overlay);
  showPanel('computer', botId,
    h('header', { class: 'head' }, h('div', { class: 'ttl' }, h('b', {}, T('המחשב של ', 'Computer of ') + bot.name), h('small', {}, 'Ubuntu · ' + (botId === 'admin' ? T('מנהל המערכת', 'administrator') : T('שולחן עבודה פרטי', 'private desktop')))),
      ibtn('expand', T('מסך מלא', 'Fullscreen'), () => (document.fullscreenElement ? document.exitFullscreen() : wrap.requestFullscreen?.())), ibtn('x', T('סגור', 'Close'), closePanel)),
    wrap, keys, bar);

  const act = async (action, extra) => { try { const info = await post(`/bots/${botId}/desktop`, { action, ...extra }); if (botId === 'admin') S.adminDesktop = info; else if (S.bots.find((b) => b.id === botId)) S.bots.find((b) => b.id === botId).desktop = info; redraw(); } catch (e) { toast(e.message, 5000); overlay.hidden = false; overlay.replaceChildren(h('div', {}, '⚠ ' + e.message)); } };

  let connecting = false, retries = 0, retryT = null;
  function connectVnc() {
    if (rfb || connecting) return;
    connecting = true;
    import('/novnc/core/rfb.js').then(({ default: RFB }) => {
      connecting = false;
      if (panelState.botId !== botId || panelState.kind !== 'computer' || rfb) return;
      screen.replaceChildren();
      const mine = rfb = new RFB(screen, (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/vnc/' + botId);
      rfb.scaleViewport = true; rfb.resizeSession = false; rfb.background = '#000'; rfb.viewOnly = !deskInfo(botId).takeover; rfb.focusOnClick = true;
      rfb.addEventListener('connect', () => { if (rfb === mine) { overlay.hidden = true; retries = 0; } });
      // A stale instance (replaced by a newer connection) must not touch the current one.
      rfb.addEventListener('disconnect', () => {
        if (rfb !== mine) return;
        rfb = null; if (panelState.botId !== botId || panelState.kind !== 'computer') return;
        overlay.hidden = false;
        const again = () => { overlay.replaceChildren(h('div', {}, T('מתחבר מחדש…', 'Reconnecting…'))); act('start'); };
        if (retries < 4) { overlay.replaceChildren(h('div', {}, T('מתחבר מחדש…', 'Reconnecting…'))); clearTimeout(retryT); retryT = setTimeout(() => { if (panelState.botId === botId && panelState.kind === 'computer' && !rfb) again(); }, 1200 + 1500 * retries++); }
        else overlay.replaceChildren(h('div', {}, T('המסך מנותק', 'Screen disconnected'), h('br'), h('button', { class: 'btn sm', style: { marginTop: '10px' }, onclick: () => { retries = 0; again(); } }, T('חבר מחדש', 'Reconnect'))));
      });
    }).catch((e) => toast('noVNC: ' + e.message));
  }
  const sendKey = (...names) => { if (!rfb) return; for (const n of names) rfb.sendKey(KS[n] ?? n.charCodeAt(0), null, true); for (const n of [...names].reverse()) rfb.sendKey(KS[n] ?? n.charCodeAt(0), null, false); };

  redraw = () => {
    const d = deskInfo(botId);
    if (!d.running) {
      overlay.hidden = false;
      overlay.replaceChildren(h('div', {}, S.vm.ready ? h('div', {}, T('שולחן העבודה כבוי', 'Desktop is off'), h('br'), h('button', { class: 'btn primary', style: { marginTop: '12px' }, onclick: async (e) => { e.target.disabled = true; e.target.textContent = T('מתחבר…', 'Connecting…'); await act('start'); } }, T('הפעל שולחן עבודה', 'Start desktop'))) : h('div', {}, T('המחשב המשותף לא מוכן', 'The shared computer is not ready'), h('br'), h('span', { class: 'tiny' }, S.vm.running ? T('המכונה עולה…', 'VM is booting…') : T('המכונה כבויה (הגדרות → מחשב)', 'VM is off (Settings → Computer)')))));
      bar.replaceChildren(); keys.hidden = true; return;
    }
    connectVnc();
    if (rfb) rfb.viewOnly = !d.takeover;
    keys.hidden = !d.takeover;
    if (d.takeover && !keys.childElementCount) {
      const ti = h('input', { class: 'in', style: { width: '150px', padding: '4px 8px', flex: 'none' }, placeholder: T('הקלד כאן…', 'Type here…'), onkeydown: (e) => { if (e.key === 'Enter') { for (const ch of ti.value) { const cp = ch.codePointAt(0); const ks = cp < 0x100 ? cp : 0x01000000 + cp; rfb?.sendKey(ks, null, true); rfb?.sendKey(ks, null, false); } if (!ti.value) sendKey('Enter'); ti.value = ''; } } });
      keys.append(ti, ...[['Esc', ['Escape']], ['Tab', ['Tab']], ['Enter', ['Enter']], ['⌫', ['Backspace']], ['Win', ['Win']], ['Ctrl+C', ['Ctrl', 'c']], ['Ctrl+V', ['Ctrl', 'v']], ['Ctrl+A', ['Ctrl', 'a']], ['Alt+Tab', ['Alt', 'Tab']], ['Alt+F4', ['Alt', 0xffc1]], ['Ctrl+Alt+Del', null]].map(([l, k]) => h('button', { onclick: () => (k ? (typeof k[1] === 'number' ? (rfb?.sendKey(KS.Alt, null, true), rfb?.sendKey(k[1], null, true), rfb?.sendKey(k[1], null, false), rfb?.sendKey(KS.Alt, null, false)) : sendKey(...k)) : rfb?.sendCtrlAltDel()) }, l)));
    }
    const live = h('span', { class: 'live' + (d.takeover ? ' you' : '') }, h('i'), d.teaching ? T('מקליט הדגמה', 'Recording demo') : d.takeover ? T('אתה בשליטה', 'You are in control') : T('שידור חי · צפייה בלבד', 'Live · view only'));
    const btns = [];
    if (d.teaching) btns.push(h('button', { class: 'btn acc sm', onclick: () => teachDone(botId, act) }, icon('check'), T('סיים הדגמה', 'Finish demo')), h('button', { class: 'btn sm', onclick: () => act('teach_stop', { cancel: true }) }, T('בטל', 'Cancel')));
    else if (d.takeover) btns.push(h('button', { class: 'btn primary sm', onclick: () => act('release') }, icon('check'), botId === 'admin' ? T('סיימתי', 'Done') : T('החזר שליטה לבוט', 'Hand back to bot')));
    else btns.push(h('button', { class: 'btn primary sm', onclick: () => act('takeover') }, icon('hand'), T('השתלט', 'Take over')));
    if (!d.teaching && botId !== 'admin') btns.push(h('button', { class: 'btn sm', onclick: () => act('teach_start') }, icon('rec'), T('למד משימה', 'Teach a task')));
    bar.replaceChildren(live, h('span', { style: { flex: 1 } }), ...btns);
  };
  redraw();
  const d = deskInfo(botId);
  if (!d.running && S.vm.ready) await act('start');
  if (takeover) await act('takeover');
}

function teachDone(botId, act) {
  const ta = h('textarea', { class: 'in', dir: 'auto', placeholder: T('מה הדגמת? (למשל: "כך מפיקים חשבונית חודשית באתר X")', 'What did you demonstrate?') });
  const close = modal(h('div', { class: 'sheet', style: { width: 'min(480px,100%)' } }, h('div', { class: 'body' }, h('h3', { style: { margin: '0 0 8px' } }, '📼 ' + T('למד משימה', 'Teach a task')), h('p', { class: 'muted small' }, T('הבוט יעבור על ההקלטה, ישמור אותה כסקיל במוח המשותף ויוכל לחזור עליה.', 'The bot reviews the recording, saves it as a skill in the shared brain and can repeat it.')), ta),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close() }, T('המשך להקליט', 'Keep recording')), h('button', { class: 'btn primary', onclick: () => { close(); act('teach_stop', { description: ta.value }); toast(T('ההדגמה נשלחה לבוט', 'Demo sent to the bot')); } }, T('שמור כסקיל', 'Save as skill')))));
  ta.focus();
}

// ---------------------------------------------------------------- artifacts
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === '"' && cur === '') q = true; else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
const download = (name, text, type) => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); a.remove(); };

export async function openArtifact(botId, id) {
  let a; try { a = await api(`/bots/${botId}/artifacts/${id}`); } catch (e) { return toast(e.message); }
  const raw = `/api/bots/${botId}/artifacts/${id}/raw`;
  let body, extra = [];
  if (a.type === 'html' || a.type === 'svg') { body = h('iframe', { class: 'artframe', src: raw, /* sandboxed by the CSP header the server sends with the artifact */ style: a.type === 'svg' ? { background: '#fff' } : {} }); extra.push(h('a', { class: 'iconbtn', href: raw, target: '_blank', title: T('פתח בלשונית', 'Open in tab') }, icon('expand'))); }
  else if (a.type === 'mermaid') body = h('iframe', { class: 'artframe', sandbox: 'allow-scripts', srcdoc: `<!doctype html><body style="margin:16px;font-family:sans-serif"><pre class="mermaid">${esc(a.content)}</pre><script type="module">import m from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';m.initialize({startOnLoad:true});</script>` });
  else if (a.type === 'markdown') { body = h('div', { class: 'artbody' }, mdEl(a.content)); extra.push(ibtn('dl', T('הורד', 'Download'), () => download(a.title + '.md', a.content, 'text/markdown'))); }
  else if (a.type === 'sheet') {
    const rows = parseCSV(a.content); const head = rows[0] || []; let data = rows.slice(1); let sortCol = -1, dir = 1;
    const tbl = h('table', { class: 'grid' });
    const draw = () => tbl.replaceChildren(h('thead', {}, h('tr', {}, h('th', { class: 'rn' }, ''), head.map((c, i) => h('th', { onclick: () => { dir = sortCol === i ? -dir : 1; sortCol = i; data = [...data].sort((x, y) => { const a1 = x[i] ?? '', b1 = y[i] ?? ''; const n1 = parseFloat(String(a1).replace(/[,₪$€%\s]/g, '')), n2 = parseFloat(String(b1).replace(/[,₪$€%\s]/g, '')); return (!isNaN(n1) && !isNaN(n2) ? n1 - n2 : String(a1).localeCompare(String(b1), 'he')) * dir; }); draw(); } }, c + (sortCol === i ? (dir > 0 ? ' ▲' : ' ▼') : ''))))),
      h('tbody', {}, data.map((r, ri) => h('tr', {}, h('td', { class: 'rn' }, ri + 1), head.map((_, ci) => h('td', {}, r[ci] ?? ''))))));
    draw();
    body = h('div', { class: 'artbody', style: { padding: '0' } }, tbl);
    extra.push(ibtn('dl', T('הורד CSV (נפתח ב-Excel)', 'Download CSV (opens in Excel)'), () => download(a.title + '.csv', '﻿' + a.content, 'text/csv')));
  }
  showPanel('artifact', botId, h('header', { class: 'head' }, h('div', { class: 'ttl' }, h('b', { dir: 'auto' }, a.title), h('small', {}, a.type)), ...extra, ibtn('x', T('סגור', 'Close'), closePanel)), body);
}
