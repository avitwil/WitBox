// Pages and sheets: new bot, bot settings, routines, brain, inbox, devices, settings.
import { S, T, h, icon, ibtn, api, post, patch, del, toast, modal, confirmDlg, fmtTime, fmtSize, avatar, mdEl, native, SHAPES, shapeOf, promptDlg, popMenu, applyPrefs } from './ui.js';
import { go, pageHead, rerender, botById } from './app.js';
import { openComputer } from './panel.js';

const field = (label, el, hint) => [h('label', { class: 'f' }, label), el, hint ? h('div', { class: 'tiny', style: { marginTop: '4px' } }, hint) : null];
const seg = (opts, val, onchange, cls = '') => { const w = h('div', { class: 'seg ' + cls }); const draw = (v) => w.replaceChildren(...opts.map(([k, l]) => h('button', { class: v === k ? 'on' : '', onclick: () => { draw(k); onchange(k); } }, l))); draw(val); return w; };
export const sw = (on, onchange) => { const b = h('button', { class: 'sw' + (on ? ' on' : ''), role: 'switch', onclick: () => { b.classList.toggle('on'); onchange(b.classList.contains('on')); } }); return b; };
const COLORS = ['#f2f2f3', '#d97757', '#ff6a13', '#f5a524', '#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#ef4444'];
// Face picker: shape + colour. cur = {shape, color, id, name}; onpick({shape}|{color})
const facePicker = (cur, onpick) => { const w = h('div', {}); const draw = () => w.replaceChildren(
  h('div', { class: 'shapes' }, SHAPES.map(([k], i) => h('button', { type: 'button', class: shapeOf(cur) === i ? 'on' : '', title: k, onclick: () => { cur.shape = k; onpick({ shape: k }); draw(); } }, avatar({ ...cur, shape: k })))),
  h('div', { class: 'shapes', style: { marginTop: '8px', alignItems: 'center' } }, COLORS.map((c) => h('button', { type: 'button', class: (cur.color || '').toLowerCase() === c ? 'on' : '', style: { width: '32px', height: '32px', padding: '4px' }, onclick: () => { cur.color = c; onpick({ color: c }); draw(); } }, h('span', { style: { display: 'block', width: '100%', height: '100%', borderRadius: '50%', background: c } }))),
    h('input', { type: 'color', title: T('צבע אחר', 'Custom colour'), style: { width: '34px', height: '32px', padding: '0', border: '0', background: 'none' }, value: /^#[0-9a-f]{6}$/i.test(cur.color || '') ? cur.color : '#d97757', onchange: (e) => { cur.color = e.target.value; onpick({ color: e.target.value }); draw(); } }))); draw(); return w; };
const levels = () => [['always', T('תמיד', 'Always')], ['ask', T('שאל אותי', 'Ask me')], ['never', T('אף פעם', 'Never')]];
const modelOptions = (includeLocal = true) => [...S.models.map((m) => [m.id, `${m.name} — ${T(m.note, m.noteEn || m.note)}`]), ...(includeLocal ? (S.settings.localModels || []).map((l) => ['local:' + l.id, `⌂ ${l.name} (${T('מקומי', 'local')})`]) : [])];
const select = (opts, val, onchange) => h('select', { class: 'in', onchange: (e) => onchange(e.target.value) }, opts.map(([k, l]) => h('option', { value: k, selected: k === val }, l)));
export const triggerText = (t) => t.type === 'interval' ? T(`כל ${t.minutes} דקות`, `every ${t.minutes} min`) : t.type === 'email' ? T(`מייל חדש (בדיקה כל ${t.minutes} דק')`, `new email (every ${t.minutes} min)`) : t.type === 'daily' ? T(`כל יום ב-${t.time}`, `daily at ${t.time}`) + (t.days?.length < 7 ? ' · ' + t.days.map((d) => T('אבגדהוש', 'SMTWTFS')[d]).join(',') : '') : 'Webhook';

// ---------------------------------------------------------------- new bot
export function newBot() {
  const draft = { name: '', title: '', description: '', instructions: '', tasks: '', interests: [], shape: SHAPES[Math.floor(Math.random() * SHAPES.length)][0], color: ['#d97757', '#22c55e', '#3b82f6', '#8b5cf6', '#ef4444', '#f5a524', '#14b8a6', '#ec4899'][Math.floor(Math.random() * 8)], modelMode: 'auto', effortMode: 'auto', proactive: false };
  const desc = h('textarea', { class: 'in', dir: 'auto', style: { minHeight: '120px' }, placeholder: T('תאר במילים שלך מה הבוט עושה. למשל: "עוזר שמנהל לי את המיילים, מתריע על מיילים חשובים, ומכין לי כל בוקר סיכום של היום"', 'Describe in your own words what this bot does…') });
  const form = h('div');
  const drawForm = () => {
    const inp = (k, ph, ta) => h(ta ? 'textarea' : 'input', { class: 'in', dir: 'auto', value: Array.isArray(draft[k]) ? draft[k].join(', ') : draft[k], placeholder: ph || '', oninput: (e) => { draft[k] = k === 'interests' ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : e.target.value; } });
    form.replaceChildren(h('div', { class: 'card' },
      field(T('שם', 'Name'), inp('name', T('למשל: דנה', 'e.g. Dana'))),
      field(T('פרצוף', 'Face'), facePicker(draft, () => {})),
      field(T('תפקיד', 'Title'), inp('title', T('למשל: מנהלת המיילים', 'e.g. Inbox manager'))),
      field(T('תיאור קצר', 'Short description'), inp('description')),
      field(T('הוראות — התפקיד ואיך לעבוד', 'Instructions — role and how to work'), inp('instructions', '', true)),
      field(T('משימות קבועות', 'Standing tasks'), inp('tasks', '', true)),
      field(T('תחומי עניין (מופרדים בפסיק)', 'Interests (comma separated)'), inp('interests')),
      h('div', { class: 'row', style: { marginTop: '14px' } }, h('div', { class: 'grow' }, h('b', {}, '⚡ ' + T('בוט פרואקטיבי', 'Proactive bot')), h('div', { class: 'tiny' }, T('יכול לפעול לבד: הוקים על מיילים חדשים, שגרות והתראות', 'Can act on its own: new-mail hooks, routines, alerts'))), sw(draft.proactive, (v) => (draft.proactive = v)))),
      h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn primary', onclick: async () => { if (!draft.name.trim()) return toast(T('חסר שם', 'Name is required')); const b = await post('/bots', draft); S.bots.push({ ...b, desktop: { running: false } }); go('#/bot/' + b.id); } }, T('צור בוט', 'Create bot'))));
  };
  const gen = h('button', { class: 'btn primary', onclick: async () => { if (!desc.value.trim()) return drawForm(); gen.disabled = true; gen.textContent = T('בונה פרופיל…', 'Drafting…'); try { Object.assign(draft, await post('/bots/draft', { description: desc.value })); } catch (e) { toast(e.message); draft.instructions = desc.value; } gen.disabled = false; gen.textContent = T('צור פרופיל מהתיאור', 'Draft profile'); drawForm(); form.scrollIntoView({ behavior: 'smooth' }); } }, icon('spark'), T('צור פרופיל מהתיאור', 'Draft profile'));
  return [pageHead(T('בוט חדש', 'New bot')), h('div', { class: 'page' }, h('h2', {}, T('מה הבוט החדש יעשה?', 'What will the new bot do?')), h('p', { class: 'muted' }, T('תאר את התפקיד בשפה חופשית — WitBox יבנה ממנו שם, תפקיד, הוראות ותחומי עניין שתוכל לערוך.', 'Describe the job in plain language — WitBox drafts a name, role, instructions and interests you can edit.')), desc,
    h('div', { class: 'row', style: { margin: '12px 0 20px', justifyContent: 'flex-end' } }, h('button', { class: 'btn', onclick: drawForm }, T('מילוי ידני', 'Fill manually')), gen), form)];
}

// ---------------------------------------------------------------- bot settings sheet
export function botSettings(bot, startTab = 'profile') {
  let tab = startTab;
  const body = h('div', { class: 'body' });
  const save = async (p) => { Object.assign(bot, p.perms ? { perms: { ...bot.perms, ...p.perms } } : p); try { await patch('/bots/' + bot.id, p); } catch (e) { toast(e.message); } };
  const inp = (k, ta, ph) => h(ta ? 'textarea' : 'input', { class: 'in', dir: 'auto', value: Array.isArray(bot[k]) ? bot[k].join(', ') : (bot[k] || ''), placeholder: ph || '', onchange: (e) => save({ [k]: k === 'interests' ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : e.target.value }) });
  const tabs = h('div', { class: 'tabs' });
  const TABS = [['profile', T('פרופיל', 'Profile')], ['model', T('מודל וחשיבה', 'Model')], ['perms', T('הרשאות', 'Permissions')], ['auto', T('פרואקטיבי', 'Proactive')], ['learn', T('למידה', 'Learning')], ['files', T('קבצים', 'Files')], ['danger', T('ניהול', 'Manage')]];
  const draw = async () => {
    tabs.replaceChildren(...TABS.map(([k, l]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; draw(); } }, l)));
    if (tab === 'profile') body.replaceChildren(
      field(T('שם', 'Name'), inp('name')),
      field(T('פרצוף', 'Face'), facePicker(bot, (v) => save(v))),
      field(T('תפקיד', 'Title'), inp('title')), field(T('תיאור', 'Description'), inp('description')),
      field(T('הוראות — התפקיד, הסגנון ואיך לעבוד', 'Instructions'), inp('instructions', true)),
      field(T('משימות קבועות', 'Standing tasks'), inp('tasks', true)),
      field(T('תחומי עניין (מופרדים בפסיק)', 'Interests (comma separated)'), inp('interests')));
    else if (tab === 'model') {
      const manualBox = h('div'), effBox = h('div');
      const drawM = () => manualBox.replaceChildren(...(bot.modelMode === 'manual' ? field(T('המודל שמריץ את הבוט', 'Model'), select(modelOptions(), bot.model, (v) => save({ model: v }))) : [h('div', { class: 'card small muted', style: { marginTop: '10px' } }, T('הבוט בוחר לכל משימה את המודל הזול ביותר שמספיק לה, רק מתוך הרשימה המותרת: ', 'For each task the bot picks the cheapest sufficient model, only from the allowed list: '), h('b', {}, (S.settings.autoModels || []).map((id) => S.models.find((m) => m.id === id)?.name || id.replace('local:', '⌂ ')).join(' · ') || '—'), ' ', h('a', { href: '#/settings', onclick: () => close() }, T('(שינוי בהגדרות)', '(change in Settings)')))]));
      const drawE = () => effBox.replaceChildren(...(bot.effortMode === 'manual' ? [h('div', { style: { marginTop: '10px' } }, seg(S.efforts.map((e) => [e, e]), bot.effort, (v) => save({ effort: v })))] : [h('div', { class: 'tiny', style: { marginTop: '8px' } }, T('הבוט מחליט לבד כמה לחשוב לפי קושי המשימה', 'The bot decides how hard to think per task'))]));
      body.replaceChildren(h('label', { class: 'f' }, T('בחירת מודל', 'Model selection')), seg([['auto', T('אוטומטי', 'Auto')], ['manual', T('ידני', 'Manual')]], bot.modelMode, (v) => { save({ modelMode: v }); drawM(); }, 'acc'), manualBox,
        h('label', { class: 'f', style: { marginTop: '22px' } }, T('רמת חשיבה', 'Thinking effort')), seg([['auto', T('אוטומטי', 'Auto')], ['manual', T('ידני', 'Manual')]], bot.effortMode, (v) => { save({ effortMode: v }); drawE(); }, 'acc'), effBox);
      drawM(); drawE();
    }
    else if (tab === 'perms') {
      // Nothing here is saved until "Save changes": everything edits a draft.
      const snap = () => JSON.stringify({ c: bot.connPerms || {}, cd: bot.connDefault || { level: 'write', ask: true }, dp: bot.devicePerms || {}, p: { devices: bot.perms?.devices || 'ask', vault: bot.perms?.vault || 'ask' }, sudo: !!bot.pcSudo, rules: bot.rules || '', at: bot.allowTools || [] });
      const d = JSON.parse(snap());
      let conns = null;
      const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]+/gi, '_');
      const cp = (key) => d.c[key] || (Array.isArray(bot.connectors) && !bot.connectors.some((c) => norm(key).includes(norm(c)) || norm(c).includes(norm(key))) ? { level: 'none', ask: true } : d.cd);
      const bar = h('div', { class: 'savebar' });
      const paintBar = () => { const dirty = JSON.stringify(d) !== snap(); bar.classList.toggle('on', dirty); bar.replaceChildren(...(dirty ? [h('span', { class: 'grow small' }, T('יש שינויים שלא נשמרו', 'Unsaved changes')), h('button', { class: 'btn sm', onclick: () => draw() }, T('בטל', 'Cancel')), h('button', { class: 'btn sm primary', onclick: doSave }, T('שמור שינויים', 'Save changes'))] : [])); };
      const connBox = h('div'), devBox = h('div'), tagBox = h('div');
      const CL = () => [['none', T('ללא גישה', 'No access')], ['read', T('קריאה בלבד', 'Read only')], ['write', T('קריאה, כתיבה ומחיקה', 'Read, write and delete')]];
      const drawConns = () => connBox.replaceChildren(h('div', { class: 'card' }, h('b', {}, T('קונקטורים', 'Connectors')), h('div', { class: 'tiny', style: { marginBottom: '6px' } }, T('מה הבוט רשאי לעשות בכל שירות שמחובר לחשבון ה-Claude שלך', 'What this bot may do in each service connected to your Claude account')),
        ...(conns === null ? [h('div', { class: 'small muted' }, T('בודק קונקטורים…', 'Checking connectors…'))] : !conns.length ? [h('div', { class: 'small muted' }, T('אין קונקטורים מחוברים. מחברים אותם באפליקציית Claude (Settings ← Connectors).', 'No connectors yet. Connect them in the Claude app (Settings → Connectors).'))]
          : conns.map((c) => { const v = cp(c.key); return h('div', { class: 'prow' }, h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('b', {}, c.name), c.status !== 'connected' ? h('span', { class: 'pill warn', style: { marginInlineStart: '8px' } }, T('לא מחובר', 'not connected')) : null), seg(CL(), v.level, (lv) => { d.c[c.key] = { level: lv, ask: cp(c.key).ask }; drawConns(); paintBar(); })),
            v.level === 'write' ? h('div', { class: 'row wrap', style: { marginTop: '8px' } }, h('div', { class: 'grow tiny' }, T('לפני כתיבה ומחיקה', 'Before writing or deleting')), seg([['ask', T('שאל אותי', 'Ask me')], ['always', T('אפשר תמיד', 'Always allow')]], v.ask ? 'ask' : 'always', (x) => { d.c[c.key] = { level: 'write', ask: x === 'ask' }; paintBar(); })) : null); }))));
      const drawDevs = () => devBox.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('b', {}, T('שליטה במכשירים שלי', 'Control my devices')), h('div', { class: 'tiny' }, T('המחשבים והטלפונים שמריצים את האפליקציה. כל מכשיר מאשר גם בנפרד מתוכו', 'PCs and phones running the app. Each device also approves locally'))), seg(levels(), d.p.devices, (v) => { d.p.devices = v; drawDevs(); paintBar(); })),
        ...(S.devices || []).map((dev) => h('div', { class: 'prow' }, h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('b', { dir: 'auto' }, dev.name || dev.id), h('div', { class: 'tiny' }, (dev.platform || '') + (dev.online ? ' · ' + T('מחובר', 'online') : ''))), seg(levels(), d.dp[dev.id] || d.p.devices, (v) => { d.dp[dev.id] = v; paintBar(); }))))));
      const drawTags = () => tagBox.replaceChildren(...(d.at.length ? [h('div', { class: 'card' }, h('b', {}, T('פעולות שאושרו "תמיד"', 'Always-allowed actions')), h('div', { class: 'row wrap', style: { marginTop: '8px' } }, d.at.map((t) => h('span', { class: 'tag' }, t.split('__').slice(-2).join(' · ').replace(/^claude_ai_/, '').replace(/_/g, ' '), h('button', { onclick: () => { d.at = d.at.filter((x) => x !== t); drawTags(); paintBar(); } }, '✕')))))] : []));
      const line = (c) => {
        const LV = { always: T('תמיד', 'Always'), ask: T('שאל אותי', 'Ask me'), never: T('אף פעם', 'Never') };
        if (c.kind === 'connector') return (conns?.find((x) => x.key === c.key)?.name || c.key) + ': ' + (c.level === 'write' ? T('קריאה, כתיבה ומחיקה', 'Read, write and delete') + ' — ' + (c.ask === false ? T('אפשר תמיד', 'always allow') : T('לשאול לפני כתיבה ומחיקה', 'ask before writing')) : CL().find((x) => x[0] === c.level)[1]);
        if (c.kind === 'devices') return T('שליטה במכשירים שלי: ', 'Control my devices: ') + LV[c.level];
        if (c.kind === 'device') return T('המכשיר ', 'Device ') + ((S.devices || []).find((x) => x.id === c.id)?.name || c.id) + ': ' + LV[c.level];
        if (c.kind === 'vault') return T('שימוש בכספת: ', 'Use the vault: ') + LV[c.level];
        return T('הרשאות מנהל (sudo): ', 'Admin rights (sudo): ') + (c.value ? T('פעיל', 'on') : T('כבוי', 'off'));
      };
      const differs = (c) => c.kind === 'connector' ? (cp(c.key).level !== c.level || (c.level === 'write' && typeof c.ask === 'boolean' && cp(c.key).ask !== c.ask)) : c.kind === 'devices' ? d.p.devices !== c.level : c.kind === 'device' ? (d.dp[c.id] || d.p.devices) !== c.level : c.kind === 'vault' ? d.p.vault !== c.level : d.sudo !== c.value;
      const applyChange = (c) => { if (c.kind === 'connector') d.c[c.key] = { level: c.level, ask: c.level === 'write' ? (typeof c.ask === 'boolean' ? c.ask : cp(c.key).ask) : true }; else if (c.kind === 'devices') d.p.devices = c.level; else if (c.kind === 'device') d.dp[c.id] = c.level; else if (c.kind === 'vault') d.p.vault = c.level; else d.sudo = c.value; };
      const commit = async () => {
        if (Array.isArray(bot.connectors) && conns) for (const c of conns) d.c[c.key] ||= cp(c.key); // legacy list → explicit per-connector levels
        const p = { connPerms: d.c, connDefault: d.cd, devicePerms: d.dp, perms: d.p, pcSudo: d.sudo, rules: d.rules, allowTools: d.at, ...(Array.isArray(bot.connectors) && conns ? { connectors: null } : {}) };
        try { Object.assign(bot, await patch('/bots/' + bot.id, p)); toast(T('נשמר', 'Saved')); } catch (e) { toast(e.message); return; }
        draw();
      };
      async function doSave() {
        if (d.rules.trim() && d.rules.trim() !== (bot.rules || '').trim()) {
          bar.replaceChildren(h('span', { class: 'grow small' }, T('בודק אילו הגדרות הכללים משנים…', 'Checking which settings the rules change…')));
          let plan = { changes: [], instructions: [] };
          try { plan = await post('/bots/' + bot.id + '/rules-plan', { rules: d.rules }); } catch (e) { toast(e.message); }
          const ch = (plan.changes || []).filter(differs);
          if (ch.length) {
            const go = await new Promise((res) => { const closeDlg = modal(h('div', { class: 'sheet', style: { width: 'min(480px,100%)' } }, h('div', { class: 'body' },
              h('p', { style: { margin: '4px 0 10px', fontSize: '16px', fontWeight: 600 } }, T('הכללים שכתבת ישנו את ההגדרות האלה', 'Your rules will change these settings')),
              h('ul', { class: 'askitems' }, ...ch.map((c) => h('li', { dir: 'auto' }, line(c)))),
              plan.instructions?.length ? h('div', {}, h('div', { class: 'tiny', style: { margin: '10px 0 4px' } }, T('אין להם הגדרה מתאימה, ולכן יישארו כהנחיה לבוט בלבד:', 'No matching setting, so these stay as instructions to the bot only:')), h('ul', { class: 'askitems' }, ...plan.instructions.map((t) => h('li', { dir: 'auto' }, t)))) : null,
              h('div', { class: 'tiny', style: { marginTop: '10px' } }, T('הטקסט של הכללים נשאר בשדה כמו שכתבת.', 'The rules text stays in the field as you wrote it.'))),
              h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => { res('back'); closeDlg(); } }, T('חזור', 'Back')), h('button', { class: 'btn', onclick: () => { res('keep'); closeDlg(); } }, T('שמור בלי לשנות הגדרות', 'Save without changing settings')), h('button', { class: 'btn primary', onclick: () => { res('apply'); closeDlg(); } }, T('עדכן ושמור', 'Update and save')))), { onclose: () => res('back') }); });
            if (go === 'back') return paintBar();
            if (go === 'apply') ch.forEach(applyChange);
          }
        }
        await commit();
      }
      const rulesIn = h('textarea', { class: 'in', dir: 'auto', value: d.rules, placeholder: T('למשל: "לעולם אל תשלח מייל בלי לשאול אותי. אל תוציא כסף."', 'e.g. "Never send email without asking me."'), oninput: (e) => { d.rules = e.target.value; paintBar(); } });
      body.replaceChildren(
        h('div', { class: 'card small muted' }, T('לבוט יש מחשב משלו, והוא תמיד רשאי להשתמש בו ולהריץ בו פקודות. הוא לא מריץ שום דבר על השרת.', 'The bot has its own computer and may always use it and run commands there. It never runs anything on the server.')),
        h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, T('הרשאות מנהל במחשב שלו (sudo)', 'Admin rights on its computer (sudo)')), h('div', { class: 'tiny' }, T('מאפשר לבוט להתקין תוכנות מערכת. כבוי: הבוט מוגבל למשתמש שלו', 'Lets the bot install system software. Off: limited to its own user'))), sw(d.sudo, (v) => { d.sudo = v; paintBar(); }))),
        connBox,
        h('div', { class: 'card' }, h('div', { class: 'row wrap' }, h('div', { class: 'grow' }, h('b', {}, T('שימוש בכספת', 'Use the vault')), h('div', { class: 'tiny' }, T('הקלדת שם משתמש וסיסמה שמורים לשדה בשולחן העבודה שלו. הבוט לא רואה את הסיסמה', 'Type a saved username/password into a field on its desktop. The bot never sees the password'))), seg(levels(), d.p.vault, (v) => { d.p.vault = v; paintBar(); }))),
        devBox, tagBox,
        ...field(T('כללים בשפה חופשית (הבוט מחויב להם)', 'Rules in plain language'), rulesIn, T('אחרי שמירה יוצג אילו הגדרות בדף הזה הכללים משנים, לאישורך.', 'After saving you will see which settings on this page the rules change, for your approval.')),
        bar);
      drawConns(); drawDevs(); drawTags(); paintBar();
      api('/connectors').then((r) => { conns = r.connectors || []; if (tab === 'perms') drawConns(); }).catch(() => { conns = []; drawConns(); });
    }
    else if (tab === 'auto') {
      const rs = S.routines.filter((r) => r.botId === bot.id);
      body.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, '⚡ ' + T('בוט פרואקטיבי', 'Proactive bot')), h('div', { class: 'tiny' }, T('מאפשר הוקים (מייל חדש, Webhook) והתראות יזומות. רק בוטים שסימנת יפעלו לבד.', 'Enables hooks (new mail, webhooks) and unprompted alerts.'))), sw(bot.proactive, async (v) => { await save({ proactive: v }); draw(); }))),
        h('h3', {}, T('שגרות והוקים', 'Routines & hooks')), ...rs.map((r) => routineCard(r, draw)), !rs.length ? h('p', { class: 'muted small' }, T('אין שגרות עדיין.', 'No routines yet.')) : null,
        h('div', { class: 'row wrap' }, h('button', { class: 'btn', onclick: () => routineEditor({ botId: bot.id }, draw) }, icon('plus'), T('שגרה חדשה', 'New routine')),
          bot.proactive && !rs.some((r) => r.trigger.type === 'email') ? h('button', { class: 'btn acc', onclick: async () => { const r = await post('/routines', { botId: bot.id, name: T('שומר המייל', 'Mail watcher'), prompt: '', trigger: { type: 'email', minutes: 5 } }); S.routines.push(r); draw(); } }, '✉ ' + T('הפעל הוק "מייל חדש"', 'Enable "new email" hook')) : null));
    }
    else if (tab === 'learn') {
      const mem = await api(`/bots/${bot.id}/memory`).catch(() => ({ text: '' }));
      const ta = h('textarea', { class: 'in', dir: 'auto', style: { minHeight: '150px' }, value: mem.text, onchange: () => api(`/bots/${bot.id}/memory`, { method: 'PUT', body: { text: ta.value } }).then(() => toast(T('נשמר', 'Saved'))) });
      body.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, '🧠 ' + T('למידה עצמית', 'Self-learning')), h('div', { class: 'tiny' }, T('אחרי שיחות הבוט מעדכן לבד את המוח המשותף: העדפות שלך, עובדות, וסקילים לפעולות שחוזרות על עצמן.', 'After conversations the bot updates the shared brain on its own: your preferences, facts, and skills for repeated work.'))), sw(bot.learning !== false, (v) => save({ learning: v }))),
        h('div', { class: 'row', style: { marginTop: '10px' } }, h('button', { class: 'btn sm', onclick: async () => { await post('/learn', { botId: bot.id }); toast(T('לומד עכשיו מהשיחה האחרונה…', 'Learning now…')); } }, icon('refresh'), T('למד עכשיו', 'Learn now')), h('button', { class: 'btn sm', onclick: () => { close(); go('#/brain'); } }, icon('brain'), T('פתח את המוח', 'Open brain')))),
        h('h3', {}, T('מה נלמד לאחרונה', 'Recently learned')), ...(bot.learnLog?.length ? bot.learnLog.slice(0, 12).map((l) => h('div', { class: 'card small' }, h('div', { class: 'tiny' }, fmtTime(l.ts)), h('div', { dir: 'auto' }, l.text))) : [h('p', { class: 'muted small' }, T('עדיין כלום — זה יתמלא ככל שתעבוד עם הבוט.', 'Nothing yet — fills up as you work with the bot.'))]),
        ...field(T('הזיכרון האישי של הבוט', "Bot's own memory"), ta));
    }
    else if (tab === 'files') {
      const r = await api(`/bots/${bot.id}/files`).catch(() => ({ files: [] }));
      body.replaceChildren(h('p', { class: 'muted small' }, T('קבצים בסביבת העבודה של הבוט', "Files in the bot's workspace")), ...(r.files.length ? r.files.map((f) => h('a', { class: 'attach', style: { marginBottom: '6px', maxWidth: '100%' }, href: `/api/bots/${bot.id}/file?path=${encodeURIComponent(f.path)}`, download: f.path.split('/').pop() }, h('span', { class: 'fi' }, icon('file')), h('span', {}, h('b', { dir: 'ltr' }, f.path), h('small', {}, fmtSize(f.size) + ' · ' + fmtTime(f.mtime))))) : [h('p', { class: 'muted' }, '—')]));
    }
    else if (tab === 'danger') body.replaceChildren(
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, T('המחשב של הבוט', "Bot's computer")), h('div', { class: 'tiny' }, bot.pcUser ? T('משתמש: ', 'User: ') + bot.pcUser : T('המשתמש ייווצר בשימוש הראשון', 'The user is created on first use'))), h('button', { class: 'btn sm', onclick: () => { close(); openComputer(bot.id); } }, icon('monitor'), T('פתח', 'Open')), bot.desktop?.running ? h('button', { class: 'btn sm', onclick: async () => { await post(`/bots/${bot.id}/desktop`, { action: 'stop' }); toast(T('נותק', 'Disconnected')); } }, T('נתק', 'Disconnect')) : null)),
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, T('הסתר בוט', 'Hide bot')), h('div', { class: 'tiny' }, T('השגרות ממשיכות לרוץ', 'Routines keep running'))), sw(bot.hidden, (v) => save({ hidden: v })))),
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, T('שיחה חדשה', 'New conversation')), h('div', { class: 'tiny' }, T('מוחק את היסטוריית הצ׳אט. המוח והסקילים נשארים.', 'Clears chat history. Brain and skills stay.'))), h('button', { class: 'btn sm', onclick: async () => { if (await confirmDlg(T('למחוק את היסטוריית השיחה?', 'Clear the conversation?'), T('מחק', 'Clear'), true)) { await del(`/bots/${bot.id}/messages`); close(); } } }, T('נקה', 'Clear')))),
      h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', { style: { color: 'var(--bad)' } }, T('מחק בוט', 'Delete bot')), h('div', { class: 'tiny' }, T('מוחק פרופיל, שיחה, שגרות והמשתמש שלו במחשב המשותף. המוח המשותף נשאר.', 'Deletes profile, chat, routines and its computer user. The shared brain stays.'))), h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDlg(T(`למחוק את ${bot.name} לצמיתות?`, `Delete ${bot.name} permanently?`), T('מחק', 'Delete'), true)) { await del('/bots/' + bot.id); close(); go('#/'); } } }, icon('trash'), T('מחק', 'Delete')))));
  };
  const sheet = h('div', { class: 'sheet' }, h('header', { class: 'head' }, avatar(bot, 'sm'), h('div', { class: 'ttl' }, h('b', {}, bot.name), h('small', {}, T('הגדרות הבוט', 'Bot settings'))), ibtn('x', T('סגור', 'Close'), () => close())), tabs, body);
  const close = modal(sheet);
  draw();
}

// ---------------------------------------------------------------- routines
function routineCard(r, redraw) {
  const bot = botById(r.botId);
  const st = r.lastStatus === 'running' ? h('span', { class: 'pill acc' }, T('רץ', 'running')) : r.lastStatus === 'ok' ? h('span', { class: 'pill ok' }, 'OK') : r.lastStatus ? h('span', { class: 'pill bad' }, r.lastStatus) : null;
  return h('div', { class: 'card' }, h('div', { class: 'row' }, bot ? avatar(bot, 'sm') : null, h('div', { class: 'grow' }, h('b', { dir: 'auto' }, r.name), h('div', { class: 'tiny' }, (bot?.name || '') + ' · ' + triggerText(r.trigger) + (r.lastRun ? ' · ' + T('ריצה אחרונה ', 'last run ') + fmtTime(r.lastRun) : ''))), st, sw(r.enabled, async (v) => { r.enabled = v; await patch('/routines/' + r.id, { enabled: v }); })),
    r.trigger.type === 'webhook' ? h('div', { class: 'tooldetail', style: { marginTop: '8px' } }, `POST ${location.origin}/api/hooks/${r.trigger.key}`) : null,
    (r.trigger.type === 'email' || r.trigger.type === 'webhook') && bot && !bot.proactive ? h('div', { class: 'tiny', style: { color: 'var(--warn)', marginTop: '6px' } }, T('הבוט לא מוגדר כפרואקטיבי — ההוק לא ירוץ', 'Bot is not proactive — this hook will not run')) : null,
    r.lastResult ? h('div', { class: 'tiny', dir: 'auto', style: { marginTop: '6px' } }, r.lastResult) : null,
    h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm', onclick: async () => { await post(`/routines/${r.id}/run`); toast(T('השגרה הופעלה', 'Routine started')); } }, icon('play'), T('הרץ עכשיו', 'Run now')), h('button', { class: 'btn sm', onclick: () => routineEditor(r, redraw) }, icon('edit'), T('ערוך', 'Edit')), h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDlg(T('למחוק את השגרה?', 'Delete routine?'), T('מחק', 'Delete'), true)) { await del('/routines/' + r.id); S.routines = S.routines.filter((x) => x.id !== r.id); redraw(); } } }, icon('trash'))));
}
function routineEditor(r, redraw) {
  const isNew = !r.id; const d = { botId: r.botId || S.bots[0]?.id, name: r.name || '', prompt: r.prompt || '', trigger: { type: 'daily', time: '08:00', minutes: 60, days: [0, 1, 2, 3, 4, 5, 6], ...(r.trigger || {}) } };
  const extra = h('div');
  const drawT = () => extra.replaceChildren(...(d.trigger.type === 'daily' ? [...field(T('שעה', 'Time'), h('input', { class: 'in', type: 'time', value: d.trigger.time, onchange: (e) => (d.trigger.time = e.target.value) })), h('div', { class: 'row wrap', style: { marginTop: '8px' } }, [0, 1, 2, 3, 4, 5, 6].map((i) => { const b = h('button', { class: 'btn sm' + (d.trigger.days.includes(i) ? ' primary' : ''), onclick: () => { d.trigger.days = d.trigger.days.includes(i) ? d.trigger.days.filter((x) => x !== i) : [...d.trigger.days, i]; b.classList.toggle('primary'); } }, T(['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'][i], ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][i])); return b; }))]
    : d.trigger.type === 'webhook' ? [h('p', { class: 'tiny' }, T('תיווצר כתובת POST ייחודית. הגוף שנשלח מועבר לבוט.', 'A unique POST URL is created; the body is passed to the bot.'))]
      : field(d.trigger.type === 'email' ? T('בדיקת מייל כל כמה דקות', 'Check mail every N minutes') : T('כל כמה דקות', 'Every N minutes'), h('input', { class: 'in', type: 'number', min: 1, value: d.trigger.minutes || 5, onchange: (e) => (d.trigger.minutes = Number(e.target.value)) }))));
  const close = modal(h('div', { class: 'sheet' }, h('header', { class: 'head' }, h('div', { class: 'ttl' }, h('b', {}, isNew ? T('שגרה חדשה', 'New routine') : T('עריכת שגרה', 'Edit routine'))), ibtn('x', '', () => close())),
    h('div', { class: 'body' }, ...(isNew && !r.botId ? field(T('בוט', 'Bot'), select(S.bots.map((b) => [b.id, b.name]), d.botId, (v) => (d.botId = v))) : []),
      ...field(T('שם', 'Name'), h('input', { class: 'in', dir: 'auto', value: d.name, oninput: (e) => (d.name = e.target.value) })),
      h('label', { class: 'f' }, T('מתי', 'When')), isNew ? seg([['daily', T('יומי', 'Daily')], ['interval', T('כל X דקות', 'Interval')], ['email', T('מייל חדש', 'New email')], ['webhook', 'Webhook']], d.trigger.type, (v) => { d.trigger.type = v; if (v === 'email') d.trigger.minutes = 5; drawT(); }) : h('div', { class: 'pill' }, triggerText(d.trigger)), extra,
      ...field(d.trigger.type === 'email' ? T('הוראות נוספות (לא חובה) — מה חשוב לך, מה זבל', 'Extra instructions (optional) — what matters, what is junk') : T('מה לעשות בכל ריצה', 'What to do on each run'), h('textarea', { class: 'in', dir: 'auto', value: d.prompt, oninput: (e) => (d.prompt = e.target.value) }))),
    h('div', { class: 'foot' }, h('button', { class: 'btn primary', onclick: async () => { try { if (isNew) S.routines.push(await post('/routines', d)); else Object.assign(r, await patch('/routines/' + r.id, d)); close(); redraw(); } catch (e) { toast(e.message); } } }, T('שמור', 'Save')))));
  drawT();
}
export function routinesPage() {
  const list = h('div');
  const draw = () => list.replaceChildren(...(S.routines.length ? S.routines.map((r) => routineCard(r, draw)) : [h('div', { class: 'empty' }, h('p', {}, T('שגרות מריצות בוט לפי לוח זמנים או אירוע: כל בוקר, כל כמה דקות, כשמגיע מייל, או Webhook.', 'Routines run a bot on a schedule or event.')))]));
  draw();
  return [pageHead(T('שגרות והוקים', 'Routines & hooks'), null, h('button', { class: 'btn sm primary', onclick: () => (S.bots.length ? routineEditor({}, draw) : toast(T('צור קודם בוט', 'Create a bot first'))) }, icon('plus'), T('חדשה', 'New'))), h('div', { class: 'page' }, list)];
}

// ---------------------------------------------------------------- brain
export let brainChanged = null;
export function brain(arg) {
  let notes = [], cur = arg && arg !== 'undefined' ? arg : null, editing = false, q = '';
  const tree = h('div', { class: 'tree' }), view = h('div', { class: 'noteview' }), wrap = h('div', { class: 'brain' }, tree, view);
  const resolve = (name) => { if (!name) return null; const n = name.replace(/\.md$/, ''); return notes.find((x) => x.path === n + '.md') || notes.find((x) => x.path.toLowerCase().endsWith('/' + n.toLowerCase() + '.md')) || notes.find((x) => x.path.split('/').pop().toLowerCase() === n.split('/').pop().toLowerCase() + '.md'); };
  async function load() { const r = await api('/brain'); notes = r.notes; wrap.dataset.vault = r.vault; drawTree(); if (cur) open(cur, false); else if (matchMedia('(min-width: 821px)').matches) open('Home', false); else drawHome(); }
  function drawTree() {
    const groups = {}; for (const n of notes) { if (q && !n.path.toLowerCase().includes(q)) continue; const p = n.path.split('/'); const g = p.length > 1 ? p.slice(0, -1).join(' / ') : ''; (groups[g] ||= []).push(n); }
    const names = { '': T('ראשי', 'Root'), User: T('עליי', 'About me'), People: T('אנשים', 'People'), Projects: T('פרויקטים', 'Projects'), Knowledge: T('ידע', 'Knowledge'), Skills: T('סקילים', 'Skills'), Journal: T('יומן פעילות', 'Journal') };
    const order = ['', 'User', 'Skills', 'People', 'Projects', 'Knowledge'];
    const keys = Object.keys(groups).sort((a, b) => (order.indexOf(a) + 1 || 50) - (order.indexOf(b) + 1 || 50) || a.localeCompare(b));
    tree.replaceChildren(h('div', { class: 'search', style: { margin: '2px 0 6px' } }, icon('search', 15), h('input', { placeholder: T('חיפוש במוח', 'Search brain'), value: q, oninput: (e) => { q = e.target.value.toLowerCase(); drawTree(); tree.querySelector('input').focus(); }, onkeydown: async (e) => { if (e.key === 'Enter' && q) { const r = await api('/brain/search?q=' + encodeURIComponent(q)); wrap.classList.add('has-note'); view.replaceChildren(backBtn(), h('h2', {}, T('תוצאות: ', 'Results: ') + q), ...r.hits.map((x) => h('button', { class: 'card', style: { display: 'block', width: '100%', textAlign: 'start' }, onclick: () => open(x.path) }, h('b', {}, x.path), h('div', { class: 'tiny', dir: 'auto' }, x.snippet)))); } } })),
      ...keys.flatMap((g) => [h('div', { class: 'fold' }, names[g] || g), ...groups[g].sort((a, b) => (g === 'Journal' ? b.path.localeCompare(a.path) : a.path.localeCompare(b.path))).slice(0, g === 'Journal' ? 14 : 400).map((n) => h('button', { class: 'note' + (cur && resolve(cur)?.path === n.path ? ' on' : ''), dir: 'auto', onclick: () => open(n.path) }, n.path.split('/').pop().replace(/\.md$/, '')))]),
      h('button', { class: 'btn sm', style: { margin: '14px 6px' }, onclick: () => { const name = prompt(T('שם הפתק (אפשר עם תיקייה, למשל Knowledge/נושא)', 'Note name (may include folder)')); if (name) { cur = name.replace(/\.md$/, ''); editing = true; drawNote({ path: cur + '.md', text: `# ${cur.split('/').pop()}\n\n` }, true); } } }, icon('plus'), T('פתק חדש', 'New note')));
  }
  const backBtn = () => h('button', { class: 'btn sm back', style: { marginBottom: '10px' }, onclick: () => { wrap.classList.remove('has-note'); cur = null; } }, icon('back'), T('כל הפתקים', 'All notes'));
  function drawHome() { wrap.classList.remove('has-note'); }
  async function open(name, push = true) {
    const n = resolve(name); editing = false;
    if (!n) { view.replaceChildren(backBtn(), h('p', { class: 'muted' }, T('הפתק לא קיים עדיין: ', 'Note does not exist yet: ') + name)); wrap.classList.add('has-note'); return; }
    cur = n.path.replace(/\.md$/, ''); if (push) history.replaceState(null, '', '#/brain/' + encodeURIComponent(cur));
    drawTree(); drawNote(await api('/brain/note/' + encodeURIComponent(n.path)));
  }
  function drawNote(note, isNew) {
    wrap.classList.add('has-note');
    const ta = h('textarea', { dir: 'auto', value: note.text });
    const strip = note.text.replace(/^---\n[\s\S]*?\n---\n/, '');
    view.replaceChildren(backBtn(), h('div', { class: 'row', style: { marginBottom: '10px' } }, h('div', { class: 'grow tiny', dir: 'ltr', style: { textAlign: 'start' } }, note.path),
      editing ? h('button', { class: 'btn sm primary', onclick: async () => { await api('/brain/note/' + encodeURIComponent(note.path), { method: 'PUT', body: { text: ta.value } }); editing = false; toast(T('נשמר', 'Saved')); await load(); } }, T('שמור', 'Save')) : h('button', { class: 'btn sm', onclick: () => { editing = true; drawNote(note); } }, icon('edit'), T('ערוך', 'Edit')),
      !isNew ? h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmDlg(T('למחוק את הפתק?', 'Delete note?'), T('מחק', 'Delete'), true)) { await del('/brain/note/' + encodeURIComponent(note.path)); cur = null; load(); view.replaceChildren(); } } }, icon('trash')) : null),
      editing ? ta : mdEl(strip));
  }
  brainChanged = () => { if (!editing) load(); };
  load();
  return [pageHead('🧠 ' + T('המוח המשותף', 'Shared brain'), T('כספת Obsidian · כל הבוטים קוראים וכותבים אליה', 'Obsidian vault · all bots read and write it')), wrap];
}

// ---------------------------------------------------------------- inbox
export function inbox() {
  localStorage.cbInboxSeen = Date.now();
  return [pageHead(T('התראות', 'Notifications'), null, S.inbox.length ? h('button', { class: 'btn sm', onclick: async () => { await del('/inbox'); S.inbox = []; rerender(); } }, T('נקה הכל', 'Clear all')) : null),
    h('div', { class: 'page' }, ...(S.inbox.length ? S.inbox.map((n) => { const b = botById(n.botId); return h('button', { class: 'card', style: { display: 'block', width: '100%', textAlign: 'start' }, onclick: () => n.botId && go('#/bot/' + n.botId) }, h('div', { class: 'row' }, b ? avatar(b, 'sm') : null, h('div', { class: 'grow' }, h('b', { dir: 'auto' }, n.title), h('div', { class: 'small muted', dir: 'auto' }, n.body)), n.priority === 'high' ? h('span', { class: 'pill acc' }, '!') : null, h('span', { class: 'tiny' }, fmtTime(n.ts)))); }) : [h('div', { class: 'empty' }, T('אין התראות. בוטים פרואקטיביים יתריעו כאן ובמכשירים שלך.', 'No notifications yet.'))]))];
}

// ---------------------------------------------------------------- devices
export function devicesPage() {
  const local = h('div');
  (async () => {
    if (!native.available) { local.replaceChildren(h('div', { class: 'card muted small' }, T('אתה גולש מדפדפן. כדי לקבל התראות ולאפשר לבוטים לשלוט במכשיר הזה — התקן את אפליקציית WitBox.', 'You are in a browser. Install the WitBox app to get notifications and let bots control this device.'))); return; }
    const [info, perms] = await Promise.all([native.call('getDeviceInfo'), native.call('getPermissions')]);
    const lv = () => [['always', T('תמיד', 'Always')], ['ask', T('שאל אותי', 'Ask me')], ['never', T('אף פעם', 'Never')]];
    local.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, T('המכשיר הזה: ', 'This device: ') + (info.name || '')), h('div', { class: 'tiny' }, (info.platform || '') + ' · v' + (info.appVersion || '') + ' · ' + T('ההרשאות נשמרות רק על המכשיר הזה', 'permissions are stored on this device only'))), info.controlAvailable ? (info.controlEnabled ? h('span', { class: 'pill ok' }, T('שליטה זמינה', 'Control ready')) : h('button', { class: 'btn sm acc', onclick: () => native.call('openControlSetup') }, T('הפעל שירות שליטה', 'Enable control'))) : h('span', { class: 'pill' }, info.platform === 'android' ? T('שליטה: רק בגרסה המלאה', 'Control: full edition only') : T('שליטה לא נתמכת', 'No control'))),
      h('div', { class: 'row', style: { marginTop: '8px' } }, h('button', { class: 'btn sm', onclick: () => native.call('changeServer') }, T('שנה כתובת שרת', 'Change server')))),
      h('h3', {}, T('אילו בוטים רשאים לשלוט במכשיר הזה', 'Which bots may control this device')),
      ...S.bots.map((b) => h('div', { class: 'card' }, h('div', { class: 'row wrap' }, avatar(b, 'sm'), h('div', { class: 'grow' }, h('b', {}, b.name), h('div', { class: 'tiny' }, b.title || '')), (() => { const w = h('div', { class: 'seg' }); const draw = (v) => w.replaceChildren(...lv().map(([k, l]) => h('button', { class: v === k ? 'on' : '', onclick: async () => { const r = await native.call('setPermission', { botId: b.id, level: k, botName: b.name }); if (r.error) toast(r.error === 'denied' ? T('לא אושר', 'Not approved') : r.error); else draw(k); } }, l))); draw(perms[b.id] || 'never'); return w; })()))));
  })();
  const dl = (file, title, sub) => h('a', { class: 'attach', style: { maxWidth: '100%', marginBottom: '8px' }, href: '/downloads/' + file, download: file }, h('span', { class: 'fi' }, icon('dl')), h('span', {}, h('b', {}, title), h('small', {}, sub)));
  return [pageHead(T('מכשירים', 'Devices')), h('div', { class: 'page' }, local,
    h('h3', {}, T('כל המכשירים המחוברים', 'All connected devices')), ...(S.devices.length ? S.devices.map((d) => h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'grow' }, h('b', {}, d.name), h('div', { class: 'tiny' }, d.platform + ' · ' + T('נראה לאחרונה ', 'last seen ') + fmtTime(d.lastSeen))), d.online ? h('span', { class: 'pill ok' }, T('מחובר', 'online')) : h('span', { class: 'pill' }, T('לא מחובר', 'offline')), d.notify ? h('span', { class: 'pill acc' }, '🔔') : null, ibtn('trash', T('שכח', 'Forget'), async () => { await del('/devices/' + d.id); S.devices = S.devices.filter((x) => x.id !== d.id); rerender(); })))) : [h('p', { class: 'muted small' }, T('עדיין אין מכשירים עם האפליקציה.', 'No devices with the app yet.'))]),
    h('h3', {}, T('הורדת האפליקציות (דרך Tailscale בלבד)', 'Download the apps (Tailscale only)')),
    dl('WitBox.apk', 'Android — WitBox.apk', T('טלפון וטאבלט', 'Phone and tablet')), dl('WitBox-full.apk', 'Android — WitBox-full.apk', T('כולל שליטת בוטים בטלפון; התקנה רק דרך adb', 'With device control; install via adb only')), dl('WitBox-windows-x64.exe', 'Windows — WitBox-windows-x64.exe', T('קובץ יחיד, ללא התקנה', 'Single file, no install')), dl('witbox-linux-x86_64', 'Linux — witbox-linux-x86_64', 'x86_64'))];
}

// ---------------------------------------------------------------- settings
export function settingsPage(arg) {
  const usageBox = h('div', { class: 'card' }, T('טוען מכסות…', 'Loading usage…'));
  api('/usage').then((u) => {
    if (u.error) return usageBox.replaceChildren(h('div', { class: 'muted' }, T('לא ניתן לקרוא מכסות: ', 'Cannot read usage: ') + u.error));
    const row = (label, x) => x ? h('div', { style: { margin: '10px 0' } }, h('div', { class: 'row small' }, h('b', { class: 'grow' }, label), h('span', {}, Math.round(x.utilization ?? x.percent ?? 0) + '%'), x.resets_at ? h('span', { class: 'tiny' }, T('מתאפס ', 'resets ') + new Date(x.resets_at).toLocaleString(S.lang === 'he' ? 'he-IL' : 'en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })) : null), h('div', { class: 'bar', style: { marginTop: '5px' } }, h('i', { style: { width: Math.min(100, x.utilization ?? x.percent ?? 0) + '%', background: (x.utilization ?? 0) > 85 ? 'var(--bad)' : (x.utilization ?? 0) > 60 ? 'var(--warn)' : 'var(--acc)' } }))) : null;
    usageBox.replaceChildren(h('div', { class: 'row' }, h('b', { class: 'grow' }, T('מנוי Claude: ', 'Claude plan: ') + String(u.plan || '').toUpperCase()), h('span', { class: 'pill' }, (u.tier || '').replace('default_claude_', '').replace(/_/g, ' '))),
      row(T('חלון 5 שעות', '5-hour window'), u.five_hour), row(T('שבועי — כל המודלים', 'Weekly — all models'), u.seven_day), row(T('שבועי — Opus', 'Weekly — Opus'), u.seven_day_opus), row(T('שבועי — Sonnet', 'Weekly — Sonnet'), u.seven_day_sonnet),
      u.extra_usage?.is_enabled ? h('div', { class: 'tiny' }, T('שימוש נוסף בתשלום פעיל', 'Extra usage enabled')) : h('div', { class: 'tiny' }, T('שימוש נוסף בתשלום: כבוי', 'Extra paid usage: off')));
  });
  const saveS = async (p) => { Object.assign(S.settings, p); await patch('/settings', p); };
  const autoBox = h('div');
  const drawAuto = () => autoBox.replaceChildren(...modelOptions().map(([id, label]) => h('div', { class: 'row', style: { padding: '7px 0' } }, h('div', { class: 'grow' }, label), sw((S.settings.autoModels || []).includes(id), async (v) => { const set = new Set(S.settings.autoModels || []); v ? set.add(id) : set.delete(id); await saveS({ autoModels: [...set] }); }))));
  drawAuto();
  const localBox = h('div');
  const drawLocal = () => localBox.replaceChildren(...(S.settings.localModels || []).map((l) => h('div', { class: 'row', style: { padding: '6px 0' } }, h('div', { class: 'grow' }, h('b', {}, '⌂ ' + l.name), h('div', { class: 'tiny', dir: 'ltr', style: { textAlign: 'start' } }, l.baseUrl + ' · ' + l.model)), ibtn('trash', '', async () => { await saveS({ localModels: S.settings.localModels.filter((x) => x.id !== l.id), autoModels: (S.settings.autoModels || []).filter((x) => x !== 'local:' + l.id) }); drawLocal(); drawAuto(); }))),
    h('button', { class: 'btn sm', style: { marginTop: '6px' }, onclick: () => localEditor(async (m) => { await saveS({ localModels: [...(S.settings.localModels || []), m] }); drawLocal(); drawAuto(); }) }, icon('plus'), T('חבר מודל מקומי', 'Connect a local model')));
  drawLocal();
  const connBox = h('div', { class: 'card' }, T('בודק קונקטורים…', 'Checking connectors…'));
  const loadConn = (force) => api('/connectors' + (force ? '?refresh=1' : '')).then((r) => connBox.replaceChildren(
    h('div', { class: 'tiny', style: { marginBottom: '6px' } }, T('הקונקטורים מגיעים מחשבון ה-Claude שלך. מוסיפים ומחברים אותם ב-claude.ai ← Settings ← Connectors, והם מופיעים כאן לכל הבוטים.', 'Connectors come from your Claude account. Add and connect them at claude.ai → Settings → Connectors.')),
    ...(r.connectors.length ? r.connectors.map((c) => h('div', { class: 'row', style: { padding: '6px 0' } }, h('b', { class: 'grow' }, c.name), c.status === 'connected' ? h('span', { class: 'pill ok' }, T('מחובר', 'connected') + ' · ' + c.tools) : h('span', { class: 'pill warn' }, c.status === 'needs-auth' ? T('דורש התחברות ב-claude.ai', 'needs sign-in at claude.ai') : c.status))) : [h('div', { class: 'muted' }, '—')]),
    h('div', { class: 'row', style: { marginTop: '6px' } }, h('button', { class: 'btn sm', onclick: () => { connBox.replaceChildren(T('בודק…', 'Checking…')); loadConn(true); } }, icon('refresh'), T('רענן', 'Refresh')), h('a', { class: 'btn sm', href: 'https://claude.ai/settings/connectors', target: '_blank' }, T('ניהול ב-claude.ai', 'Manage at claude.ai'))))).catch((e) => connBox.replaceChildren(String(e.message)));
  loadConn();
  const vm = S.vm || {};
  const cat = arg || (matchMedia('(min-width: 821px)').matches ? 'general' : '');
  const CATS = [['general', 'gear', T('כללי', 'General')], ['computer', 'monitor', T('מחשב', 'Computer')], ['permissions', 'shield', T('הרשאות', 'Permissions')], ['vault', 'vault', T('כספת', 'Vault')], ['models', 'spark', T('מודלים', 'Models')], ['connectors', 'cloud', T('קונקטורים', 'Connectors')], ['usage', 'usage', T('שימוש', 'Usage')], ['updates', 'dl', T('עדכונים', 'Updates')]];
  const row = (title, sub, ctl) => h('div', { class: 'srow' }, h('div', { class: 'grow' }, h('div', {}, title), sub ? h('div', { class: 'tiny' }, sub) : null), ctl);
  const group = (title, ...rows) => [h('h4', { class: 'sgt' }, title), h('div', { class: 'sgroup' }, rows)];
  const pref = (k, d) => localStorage[k] ?? d;
  const setPref = (k, v) => { localStorage[k] = v; applyPrefs(); };
  const sel = (opts, val, onchange) => h('select', { class: 'dsel', onchange: (e) => onchange(e.target.value) }, opts.map(([k, l]) => h('option', { value: k, selected: String(k) === String(val) }, l)));
  const content = h('div', { class: 'scontent' });
  const draw = {
    general: () => {
      const micSel = h('span', {}, sel([['', T('ברירת המחדל של המערכת', 'System default')]], '', () => {}));
      navigator.mediaDevices?.enumerateDevices?.().then((ds) => { const mics = ds.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default'); micSel.replaceChildren(sel([['', T('ברירת המחדל של המערכת', 'System default')], ...mics.map((d, i) => [d.deviceId, d.label || T('מיקרופון ', 'Microphone ') + (i + 1)])], pref('cbMic', ''), (v) => setPref('cbMic', v))); }).catch(() => {});
      const zones = ['auto', 'Asia/Jerusalem', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];
      const ACC = [['#d97757', T('כתום (ברירת מחדל)', 'Orange (default)')], ['bot', T('צבע הבוט', 'Bot colour')], ['#3b82f6', T('כחול', 'Blue')], ['#22c55e', T('ירוק', 'Green')], ['#8b5cf6', T('סגול', 'Purple')], ['#ec4899', T('ורוד', 'Pink')], ['#f5a524', T('ענבר', 'Amber')]];
      content.replaceChildren(h('h2', {}, T('כללי', 'General')),
        ...group(T('חשבון', 'Account'), row(h('b', {}, S.settings.userName || '—'), (S.settings.allowedLogins || []).join(', ') + ' · ' + T('זהות Tailscale', 'Tailscale identity'), h('input', { class: 'in', style: { width: '150px' }, placeholder: T('איך לקרוא לך', 'Your name'), value: S.settings.userName || '', onchange: (e) => saveS({ userName: e.target.value }) }))),
        ...group(T('מראה', 'Appearance'),
          row(T('ערכת נושא', 'Theme'), null, sel([['system', T('לפי המערכת', 'System')], ['dark', T('כהה', 'Dark')], ['light', T('בהיר', 'Light')]], pref('cbTheme', 'dark'), (v) => setPref('cbTheme', v))),
          row(T('הדגשה', 'Accent'), null, sel(ACC, pref('cbAccent', '#d97757'), (v) => setPref('cbAccent', v))),
          row(T('שפה', 'Language'), null, sel([['he', 'עברית'], ['en', 'English']], S.lang, (v) => { localStorage.cbLang = v; location.reload(); })),
          row(T('תצוגת מפתח', 'Developer view'), T('מציג בצ׳אט את הפרטים הטכניים של כל פעולה: פקודות, קלט ופלט גולמי. כבוי: רק מה נעשה ומה התוצאה.', 'Shows the technical details of every action in chat: commands, raw input and output. Off: only what was done and the result.'), sw(!!S.settings.devView, (v) => saveS({ devView: v }))),
          row(T('בדיקת איות בזמן ההקלדה', 'Spell check while typing'), null, sw(pref('cbSpell', '1') === '1', (v) => setPref('cbSpell', v ? '1' : '0'))),
          row(T('שליחה עם Ctrl+Enter', 'Send with Ctrl+Enter'), T('יש ללחוץ על Ctrl+Enter כדי לשלוח את ההודעה. Enter מתחיל שורה חדשה.', 'Press Ctrl+Enter to send. Enter starts a new line.'), sw(pref('cbSendKey', 'enter') === 'ctrl', (v) => setPref('cbSendKey', v ? 'ctrl' : 'enter')))),
        ...group(T('מערכת', 'System'),
          row(T('מיקרופון', 'Microphone'), T('חל על הכתבה ושיחת קול במחשב', 'Used for dictation and voice chat on a computer'), micSel),
          row(T('שפת דיבור', 'Voice language'), null, sel([['he-IL', 'עברית'], ['en-US', 'English (US)'], ['en-GB', 'English (UK)'], ['ar-IL', 'العربية'], ['ru-RU', 'Русский']], S.settings.voiceLang, (v) => saveS({ voiceLang: v }))),
          row(T('בדיקת התראות', 'Test notifications'), null, h('button', { class: 'btn sm', onclick: () => post('/notify/test') }, T('שלח', 'Send')))),
        ...group('Bot', row(T('אזור זמן', 'Time zone'), T('לפיו הבוטים מבינים "היום", "מחר" ושעות של שגרות', 'How bots understand "today", "tomorrow" and routine times'), sel(zones.map((z) => [z, z === 'auto' ? T('אוטומטי', 'Automatic') + ' (Asia/Jerusalem)' : z]), S.settings.timezone || 'auto', (v) => saveS({ timezone: v })))),
        ...group(T('ייבוא', 'Import'), row(T('ייבוא זיכרון ל-WitBox', 'Import memory into WitBox'), T('העברת ההעדפות וההקשר שלך מעוזר בינה מלאכותית אחר אל המוח המשותף', 'Bring your preferences and context from another AI assistant into the shared Brain'), h('button', { class: 'btn sm', onclick: () => importDlg() }, T('התחלת ייבוא', 'Start import')))));
    },
    computer: () => {
      const local = h('div', { class: 'sgroup' }, row(T('ביצוע במכשיר הזה', 'Run on this device'), T('אילו בוטים רשאים לפתוח קבצים ולהריץ משימות במכשיר הזה — נקבע מתוך האפליקציה במכשיר עצמו', 'Which bots may act on this device — set from the app on the device itself'), h('button', { class: 'btn sm', onclick: () => go('#/devices') }, T('ניהול', 'Manage'))));
      content.replaceChildren(h('h2', {}, T('מחשב', 'Computer')), local,
        ...group(T('ניהול מכשירים', 'Devices'), S.devices.length ? S.devices.map((d) => row(h('b', {}, d.name), d.platform + ' · ' + (d.online ? T('מחובר עכשיו', 'connected now') : T('נפתח לאחרונה ', 'last opened ') + fmtTime(d.lastSeen)), h('span', { class: 'row' }, h('i', { class: 'sdot' + (d.online ? ' on' : '') }), ibtn('trash', T('שכח', 'Forget'), async () => { await del('/devices/' + d.id); S.devices = S.devices.filter((x) => x.id !== d.id); draw.computer(); })))) : row(h('span', { class: 'muted' }, T('עדיין אין מכשירים עם האפליקציה.', 'No devices with the app yet.')))),
        ...group(T('המחשב של הבוטים', "The bots' computer"),
          row(h('b', {}, vm.os || 'Ubuntu'), `${vm.cpus || 6} ${T('ליבות', 'cores')} · ${vm.memGb || 16} GB RAM · ${T('לכל בוט משתמש ושולחן עבודה משלו', 'each bot has its own user and desktop')}`, vm.ready ? h('span', { class: 'pill ok' }, T('פועל', 'Running')) : vm.running ? h('span', { class: 'pill warn' }, T('עולה…', 'Booting…')) : h('button', { class: 'btn sm', onclick: async () => { await post('/vm', { action: 'start' }); toast(T('המכונה מופעלת…', 'Starting…')); } }, T('הפעל', 'Start'))),
          row(T('פתיחה כמנהל', 'Open as administrator'), T('שולחן עבודה עם הרשאות מנהל, להתקנת תוכנות לכל הבוטים', 'A desktop with admin rights, to install apps for all bots'), h('button', { class: 'btn sm', onclick: () => openComputer('admin', { takeover: true }) }, T('פתח', 'Open'))),
          row(T('עדכון המחשב של הבוטים', "Update the bots' computer"), T('מעדכן את מערכת ההפעלה והתוכנות. הקבצים ופרטי ההתחברות נשמרים. תגיע התראה בסיום.', 'Updates the OS and apps. Files and sign-ins are kept. You get a notification when done.'), h('button', { class: 'btn sm', onclick: async () => { await post('/vm', { action: 'update' }); toast(T('העדכון התחיל', 'Update started')); } }, T('עדכון', 'Update'))),
          row(T('הפעלה מחדש', 'Restart'), T('כל הבוטים ינותקו לרגע', 'All bots disconnect briefly'), h('button', { class: 'btn sm', onclick: async () => { if (await confirmDlg(T('להפעיל מחדש את המחשב המשותף?', 'Restart the shared computer?'))) { await post('/vm', { action: 'restart' }); toast(T('מפעיל מחדש…', 'Restarting…')); } } }, T('הפעל מחדש', 'Restart'))),
          row(T('הפעלה מחדש', 'Restart'), T('מכבה ומדליק את המחשב של הבוטים. שולחנות העבודה ייסגרו וייפתחו מחדש לפי הצורך.', "Turns the bots' computer off and on. Desktops close and reopen as needed."), h('button', { class: 'btn sm', onclick: async () => { if (await confirmDlg(T('להפעיל מחדש את המחשב המשותף?', 'Restart the shared computer?'))) { await post('/vm', { action: 'restart' }); toast(T('מפעיל מחדש…', 'Restarting…')); } } }, T('הפעל מחדש', 'Restart'))),
          row(T('שמירת תמונת מצב', 'Save a snapshot'), T('שומר את המצב הנוכחי כנקודת חזרה לאיפוס. המחשב יכבה ויעלה מחדש.', 'Saves the current state as the reset point. The computer restarts.'), h('button', { class: 'btn sm', onclick: async () => { if (await confirmDlg(T('לשמור תמונת מצב? המחשב המשותף יופעל מחדש.', 'Save a snapshot? The shared computer restarts.'))) { await post('/vm', { action: 'snapshot' }); toast(T('שומר…', 'Saving…')); } } }, T('שמור', 'Save'))),
          row(T('איפוס המחשב של הבוטים', "Reset the bots' computer"), T('חוזר לתמונת המצב האחרונה שנשמרה. שינויים מאז — קבצים, התקנות והתחברויות — יאבדו.', 'Returns to the last saved snapshot. Changes since — files, installs, sign-ins — are lost.'), h('button', { class: 'btn sm reset', onclick: async () => { if (await confirmDlg(T('לאפס את המחשב של הבוטים לתמונת המצב האחרונה? כל מה שנעשה מאז יימחק.', "Reset the bots' computer to the last snapshot? Everything since is erased."), T('איפוס', 'Reset'), true)) { await post('/vm', { action: 'reset' }); toast(T('מאפס…', 'Resetting…')); } } }, T('איפוס', 'Reset')))));
    },
    permissions: () => {
      const rules = (key, title, sub) => { const list = S.settings[key] || []; return [h('div', { class: 'srow plain' }, h('div', { class: 'grow' }, h('div', {}, title), h('div', { class: 'tiny' }, sub)), h('button', { class: 'btn sm', onclick: async () => { const r = await promptDlg(T('כלל חדש (בשפה חופשית)', 'New rule (plain language)'), '', T('הוסף', 'Add')); if (r) { await saveS({ [key]: [...list, r] }); draw.permissions(); } } }, T('הוספת כלל', 'Add rule'))),
        ...list.map((r, i) => h('div', { class: 'sgroup' }, row(h('span', { dir: 'auto' }, r), null, ibtn('trash', T('מחק', 'Delete'), async () => { await saveS({ [key]: list.filter((_, j) => j !== i) }); draw.permissions(); }))))]; };
      content.replaceChildren(h('h2', {}, T('הרשאות', 'Permissions')),
        h('div', { class: 'sgroup' }, row(T('אישורים', 'Approvals'), T('"לפי הגדרות הבוט": כל בוט פועל לפי ההרשאות שלו. "לשאול על כל פעולה": כל כתיבה בקונקטור, שימוש בכספת ושליטה במכשיר מחכים לאישור שלך, גם אם לבוט מוגדר "תמיד". לא חל על המחשב של הבוט עצמו.', '"Per bot": each bot follows its own permissions. "Ask for everything": every connector write, vault use and device control waits for your approval, even when the bot is set to "always". Does not apply to the bot\'s own computer.'), sel([['auto', T('לפי הגדרות הבוט', 'Per bot settings')], ['strict', T('לשאול על כל פעולה', 'Ask for everything')]], S.settings.approvalMode || 'auto', (v) => saveS({ approvalMode: v })))),
        ...rules('askRules', T('לשאול תמיד', 'Always ask'), T('לעצור ולשאול כשפעולה תואמת את הכללים האלה', 'Stop and ask when an action matches these rules')),
        ...rules('allowRules', T('לאפשר בלי לשאול', 'Allow without asking'), T('להמשיך אוטומטית כשפעולה תואמת את הכללים האלה', 'Continue automatically when an action matches these rules')),
        h('p', { class: 'tiny', style: { marginTop: '14px' } }, T('הכללים חלים על כל הבוטים. הרשאות לבוט בודד: הגדרות הבוט ← הרשאות.', 'Rules apply to all bots. Per-bot permissions: bot settings → Permissions.')));
    },
    vault: () => vaultView(content),
    models: () => content.replaceChildren(h('h2', {}, T('מודלים', 'Models')),
      ...group(T('מודלים מותרים במצב אוטומטי', 'Models allowed in auto mode'), h('div', { class: 'srow plain' }, h('div', { class: 'grow' }, h('div', { class: 'tiny', style: { marginBottom: '4px' } }, T('בוט במצב אוטומטי יבחר רק מתוך המודלים שמסומנים כאן — הזול ביותר שמספיק למשימה.', 'Auto-mode bots only pick from the models enabled here — the cheapest that fits the task.')), autoBox))),
      ...group(T('מודלים מקומיים', 'Local models'), h('div', { class: 'srow plain' }, h('div', { class: 'grow' }, h('div', { class: 'tiny', style: { marginBottom: '4px' } }, T('חיבור מודל שרץ מקומית (Ollama, LM Studio, llama.cpp…) עם API תואם Anthropic.', 'Connect a locally running model with an Anthropic-compatible API.')), localBox)))),
    connectors: () => content.replaceChildren(h('h2', {}, T('קונקטורים', 'Connectors')), connBox),
    usage: () => content.replaceChildren(h('h2', {}, T('שימוש', 'Usage')), usageBox, h('p', { class: 'tiny' }, T('הכול רץ על מנוי ה-Claude שלך; אין חיוב נפרד ב-WitBox.', 'Everything runs on your Claude subscription; WitBox has no separate billing.'))),
    updates: () => {
      const box = h('div', { class: 'sgroup' }, row('…'));
      const names = { 'WitBox-Setup.exe': ['Windows', T('מתקין: האפליקציה, ואופציונלית השרת (WSL2)', 'Installer: the app and, optionally, the server (WSL2)')], 'witbox-linux-x86_64.tar.gz': [T('שרת לינוקס', 'Linux server'), T('חבילת ההתקנה המלאה', 'The full install package')], 'WitBox.apk': ['Android', T('טלפון וטאבלט', 'Phone and tablet')], 'WitBox-full.apk': [T('Android — מלאה', 'Android — full'), T('כולל שליטת בוטים בטלפון; התקנה דרך adb', 'With device control; install via adb')], 'WitBox-windows-x64.exe': ['Windows', T('קובץ יחיד, ללא התקנה', 'Single file, no install')], 'witbox-linux-x86_64': ['Linux', 'x86_64'] };
      api('/downloads').then((r) => box.replaceChildren(...r.files.filter((f) => names[f.file]).map((f) => row(h('b', {}, names[f.file][0]), names[f.file][1] + ' · ' + fmtSize(f.size) + ' · ' + T('נבנה ', 'built ') + new Date(f.mtime).toLocaleDateString(S.lang === 'he' ? 'he-IL' : 'en-GB'), h('a', { class: 'btn sm', href: '/downloads/' + f.file, download: f.file }, T('הורדה', 'Download')))))).catch(() => {});
      const mine = h('span', { class: 'tiny' }, '');
      if (native.available) native.call('getDeviceInfo').then((i) => { mine.textContent = T('הגרסה המותקנת במכשיר הזה: ', 'Installed on this device: ') + (i.appVersion || '?'); });
      content.replaceChildren(h('h2', {}, T('עדכונים', 'Updates')), h('p', { class: 'muted small' }, T('הממשק מתעדכן לבד בכל פתיחה. את האפליקציות עצמן מעדכנים בהורדה והתקנה מעל הקיימת.', 'The interface updates itself on every launch. Update the apps by downloading and installing over the existing one.')), mine, h('h4', { class: 'sgt' }, T('אפליקציות (דרך Tailscale בלבד)', 'Apps (Tailscale only)')), box,
        h('h4', { class: 'sgt' }, T('אבטחה', 'Security')), h('div', { class: 'sgroup' }, row(h('span', { class: 'small muted' }, T('השרת לא פותח אף פורט רשת ונחשף אך ורק דרך Tailscale (HTTPS), לזהות: ', 'The server opens no network port and is exposed only through Tailscale (HTTPS), to: '), h('b', { dir: 'ltr' }, (S.settings.allowedLogins || []).join(', '))))),
        h('p', { class: 'tiny', style: { textAlign: 'center', marginTop: '20px' } }, `WitBox ${S.server?.version || ''} · ${S.server?.host || ''} · powered by Claude · ` + T('נוצר ע"י Avi Twil', 'Created by Avi Twil')));
    },
  };
  const nav = h('nav', { class: 'snav' }, CATS.map(([k, ic, l]) => h('button', { class: cat === k ? 'on' : '', onclick: () => go('#/settings/' + k) }, icon(ic), h('span', {}, l))), h('div', { class: 'about' }, h('img', { src: '/assets/icon-96.png', alt: '' }), h('div', {}, h('b', {}, 'WitBox ' + (S.server?.version || '')), h('small', {}, T('נוצר ע"י Avi Twil', 'Created by Avi Twil')))));
  if (cat && draw[cat]) draw[cat]();
  return [pageHead(cat && !matchMedia('(min-width: 821px)').matches ? CATS.find((c) => c[0] === cat)?.[2] : T('הגדרות', 'Settings')), h('div', { class: 'settings' + (cat ? ' has-cat' : '') }, nav, content)];
}
function importDlg() {
  const ta = h('textarea', { class: 'in', dir: 'auto', style: { minHeight: '220px' }, placeholder: T('הדבק כאן את מה שהעוזר האחר יודע עליך…', 'Paste what the other assistant knows about you…') });
  const close = modal(h('div', { class: 'sheet' }, h('div', { class: 'body' }, h('h3', { style: { margin: '0 0 6px' } }, T('ייבוא זיכרון', 'Import memory')),
    h('p', { class: 'muted small' }, T('בקש מהעוזר האחר (ChatGPT, Gemini, Grok…): "כתוב את כל מה שאתה זוכר עליי — העדפות, עובדות, פרויקטים ואנשים", והדבק כאן את התשובה. WitBox יתייק אותה במוח המשותף ותקבל התראה בסיום.', 'Ask the other assistant: "Write everything you remember about me — preferences, facts, projects and people", then paste the answer here. WitBox files it into the shared Brain and notifies you when done.')), ta),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: () => close() }, T('ביטול', 'Cancel')), h('button', { class: 'btn primary', onclick: async () => { if (!ta.value.trim()) return; try { await post('/brain/import', { text: ta.value }); close(); toast(T('הייבוא התחיל', 'Import started')); } catch (e) { toast(e.message); } } }, T('ייבוא', 'Import')))));
}
function vaultView(content) {
  let items = [], tab = 'all', q = '';
  const listBox = h('div', { class: 'sgroup' });
  const tabs = h('div', { class: 'vtabs' });
  const paint = () => {
    const n = (k) => items.filter((x) => k === 'all' || x.kind === k).length;
    tabs.replaceChildren(...[['all', T('הכול', 'All')], ['login', T('פרטי התחברות', 'Logins')], ['contact', T('פרטי קשר', 'Contact details')]].map(([k, l]) => h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; paint(); } }, l + ' ' + n(k))));
    const shown = items.filter((x) => (tab === 'all' || x.kind === tab) && (!q || JSON.stringify(x).toLowerCase().includes(q)));
    listBox.replaceChildren(...(shown.length ? shown.map((x) => h('button', { class: 'srow vitem', onclick: () => vaultEdit(x, load) }, h('span', { class: 'fi' }, x.kind === 'login' ? (x.site || '?').replace(/^https?:\/\//, '').charAt(0).toUpperCase() : icon('file')), h('div', { class: 'grow' }, h('b', { dir: 'ltr' }, x.kind === 'login' ? x.site : x.label || x.name), h('div', { class: 'tiny', dir: 'ltr' }, x.kind === 'login' ? x.username : [x.email, x.phone].filter(Boolean).join(' · '))), icon('chev'))) : [h('div', { class: 'srow muted small' }, T('הכספת ריקה. הוסף פרטי התחברות כדי שהבוטים יוכלו להיכנס לאתרים בשבילך — בלי לראות את הסיסמה.', 'The vault is empty. Add logins so bots can sign in for you — without ever seeing the password.'))]));
  };
  const load = async () => { items = (await api('/vault')).items; paint(); };
  content.replaceChildren(h('div', { class: 'row' }, h('h2', { class: 'grow' }, T('כספת', 'Vault')), h('button', { class: 'btn primary sm', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); popMenu(r.left, r.bottom + 6, [{ icon: 'shield', label: T('פרטי התחברות', 'Login'), onclick: () => vaultEdit({ kind: 'login' }, load) }, { icon: 'file', label: T('פרטי קשר', 'Contact details'), onclick: () => vaultEdit({ kind: 'contact' }, load) }]); } }, icon('plus'), T('פריט חדש', 'New item'))),
    h('div', { class: 'row wrap', style: { margin: '10px 0' } }, tabs, h('span', { style: { flex: 1 } }), h('div', { class: 'search', style: { margin: 0, minWidth: '180px' } }, icon('search', 16), h('input', { placeholder: T('חיפוש בכספת', 'Search the vault'), oninput: (e) => { q = e.target.value.toLowerCase(); paint(); } }))),
    listBox, h('p', { class: 'tiny', style: { marginTop: '12px' } }, T('הסיסמאות מוצפנות על השרת ולעולם לא נשלחות למודל: הבוט רק מבקש שהסיסמה תוקלד לשדה בשולחן העבודה שלו, וכברירת מחדל מבקש את אישורך בכל שימוש.', 'Passwords are encrypted on the server and never sent to the model: a bot can only ask for one to be typed into a field on its desktop, and by default asks you each time.')));
  load().catch((e) => toast(e.message));
}
function vaultEdit(x, done) {
  const d = { ...x }; const isNew = !x.id;
  const inp = (k, ph, type = 'text') => h('input', { class: 'in', dir: 'ltr', type, autocomplete: 'off', value: d[k] || '', placeholder: ph || '', oninput: (e) => (d[k] = e.target.value) });
  const pw = inp('password', x.hasPassword ? T('•••••••• (ללא שינוי)', '•••••••• (unchanged)') : '', 'password');
  const fields = d.kind === 'contact'
    ? [...field(T('שם הפריט', 'Label'), inp('label', T('למשל: הפרטים שלי', 'e.g. My details'))), ...field(T('שם מלא', 'Full name'), inp('name')), ...field(T('אימייל', 'Email'), inp('email')), ...field(T('טלפון', 'Phone'), inp('phone')), ...field(T('כתובת', 'Address'), inp('address'))]
    : [...field(T('אתר', 'Site'), inp('site', 'example.com')), ...field(T('שם משתמש / אימייל', 'Username / email'), inp('username')),
       ...field(T('סיסמה', 'Password'), h('div', { class: 'row' }, pw, h('button', { class: 'btn sm', type: 'button', onclick: async () => { if (pw.type === 'password') { if (!pw.value && x.id && x.hasPassword) { pw.value = (await api(`/vault/${x.id}/secret`)).password; d.password = pw.value; } pw.type = 'text'; } else pw.type = 'password'; } }, icon('eye')))), ...field(T('הערה', 'Note'), inp('note'))];
  const close = modal(h('div', { class: 'sheet', style: { width: 'min(480px,100%)' } }, h('header', { class: 'head' }, h('div', { class: 'ttl' }, h('b', {}, d.kind === 'contact' ? T('פרטי קשר', 'Contact details') : T('פרטי התחברות', 'Login'))), ibtn('x', '', () => close())),
    h('div', { class: 'body' }, ...fields),
    h('div', { class: 'foot' }, !isNew ? h('button', { class: 'btn danger', style: { marginInlineEnd: 'auto' }, onclick: async () => { if (await confirmDlg(T('למחוק את הפריט מהכספת?', 'Delete this item from the vault?'), T('מחק', 'Delete'), true)) { await del('/vault/' + x.id); close(); done(); } } }, icon('trash'), T('מחק', 'Delete')) : null,
      h('button', { class: 'btn primary', onclick: async () => { try { if (isNew) await post('/vault', d); else await patch('/vault/' + x.id, d); close(); done(); } catch (e) { toast(e.message); } } }, T('שמור', 'Save')))));
}
function localEditor(onSave) {
  const d = { name: '', baseUrl: 'http://127.0.0.1:11434', model: '', apiKey: '' };
  const out = h('div', { class: 'tiny', style: { marginTop: '10px' } }); const modelSel = h('div');
  const inp = (k, ph) => h('input', { class: 'in', dir: 'ltr', value: d[k], placeholder: ph, oninput: (e) => (d[k] = e.target.value) });
  const close = modal(h('div', { class: 'sheet' }, h('header', { class: 'head' }, h('div', { class: 'ttl' }, h('b', {}, T('חיבור מודל מקומי', 'Connect a local model'))), ibtn('x', '', () => close())),
    h('div', { class: 'body' }, ...field(T('כתובת השרת המקומי', 'Local server URL'), inp('baseUrl'), T('Ollama: http://127.0.0.1:11434 · LM Studio: http://127.0.0.1:1234 — על השרת הזה או על מכשיר אחר ב-Tailscale', 'Ollama / LM Studio — on this server or another tailnet device')),
      h('button', { class: 'btn sm', style: { marginTop: '8px' }, onclick: async () => { out.textContent = '…'; const r = await post('/local/test', { baseUrl: d.baseUrl, apiKey: d.apiKey }); out.textContent = r.models.length ? T('נמצאו מודלים: ', 'Models: ') + r.models.length : T('לא נמצאו מודלים: ', 'No models: ') + (r.modelsError || ''); modelSel.replaceChildren(...(r.models.length ? [select([['', '—'], ...r.models.map((m) => [m, m])], d.model, (v) => { d.model = v; if (!d.name) d.name = v; body.querySelectorAll('input')[1].value = v; })] : [])); } }, T('מצא מודלים', 'Find models')), modelSel,
      ...field(T('שם המודל', 'Model name'), inp('model', 'qwen3:14b')), ...field(T('שם תצוגה', 'Display name'), inp('name', 'My local model')), ...field(T('מפתח API (אם נדרש)', 'API key (if needed)'), inp('apiKey', '')), out),
    h('div', { class: 'foot' }, h('button', { class: 'btn', onclick: async () => { out.textContent = T('בודק…', 'Testing…'); const r = await post('/local/test', d); out.textContent = (r.ok ? '✔ ' : '✖ ') + (r.reply || ''); } }, T('בדוק', 'Test')), h('button', { class: 'btn primary', onclick: () => { if (!d.baseUrl || !d.model) return toast(T('חסרים כתובת ומודל', 'URL and model required')); close(); onSave({ id: Math.random().toString(36).slice(2, 9), name: d.name || d.model, baseUrl: d.baseUrl, model: d.model, apiKey: d.apiKey }); } }, T('שמור', 'Save')))));
  const body = document.querySelector('.modal:last-child .body');
}
