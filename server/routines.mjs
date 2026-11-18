// Routines & triggers: schedules, new-email hooks, webhooks. Only proactive bots run email/webhook hooks.
import { state, save, emit, uid, getBot, MODELS, tz } from './store.mjs';
import { sendMessage, isRunning } from './agent.mjs';

const EMAIL_PROMPT = `New-mail hook. Check the user's Gmail inbox with the Gmail connector for unread messages that arrived since your last check.
1. Read ./email-state.json (create if missing) — it holds {"handled": [message/thread ids]}. Search e.g. "in:inbox is:unread newer_than:2d" and skip ids already handled.
2. For each new message decide IMPORTANT / NORMAL / SPAM. Use the rules in your memory about who and what the user considers important or spam; when unsure prefer NORMAL.
   - IMPORTANT → call notify (priority high) with the sender and a one-line summary of what is needed. When there is something you could do about it (compare offers, draft a reply, book, renew, research), also put a card on the dashboard with mcp__bot__dashboard_suggest: what arrived, and up to three next steps the user can start with one tap.
   - SPAM / junk / bulk promo the user never opens → move it to spam (or label/trash it) with the connector, if such a tool is available.
   - NORMAL → do nothing.
3. Learn: when you see a consistent pattern (a sender that is always spam, a topic the user always cares about, a correction from the user), save a short rule with remember so future checks get better.
4. Update ./email-state.json with the handled ids (keep the latest 500).
If there was nothing new or nothing worth reporting, reply exactly NOOP. Otherwise reply with a 1-3 line summary.`;

export function createRoutine({ botId, name, prompt, trigger, enabled = true, model }) {
  const t = { type: trigger?.type || 'interval' };
  if (t.type === 'interval' || t.type === 'email') t.minutes = Math.max(1, Math.round(trigger?.minutes || (t.type === 'email' ? 5 : 60)));
  if (t.type === 'daily') { t.time = /^\d{1,2}:\d{2}$/.test(trigger?.time || '') ? trigger.time.padStart(5, '0') : '08:00'; t.days = Array.isArray(trigger?.days) && trigger.days.length ? trigger.days : [0, 1, 2, 3, 4, 5, 6]; }
  if (t.type === 'webhook') t.key = uid(24);
  const r = { id: uid(8), botId, name: name || 'Routine', prompt: prompt || '', trigger: t, enabled, model: model || null, createdAt: Date.now(), lastRun: null, lastStatus: null, runs: 0 };
  state.routines.push(r); save(); emit('routines');
  return r;
}
export function deleteRoutine(id) { state.routines = state.routines.filter((r) => r.id !== id); save(); emit('routines'); }

const cheapest = () => {
  const a = (state.settings.autoModels || []).filter((id) => MODELS.some((m) => m.id === id)).sort((x, y) => MODELS.find((m) => m.id === x).tier - MODELS.find((m) => m.id === y).tier);
  return a[0] || 'claude-haiku-5-5';
};

const active = new Set();
export async function runRoutine(r, extra = '') {
  const bot = getBot(r.botId);
  if (!bot || active.has(r.id)) return;
  active.add(r.id);
  r.lastRun = Date.now(); r.runs = (r.runs || 0) + 1; r.lastStatus = 'running'; save(); emit('routines');
  try {
    const prompt = (r.trigger.type === 'email' ? EMAIL_PROMPT + (r.prompt ? '\n\nExtra instructions from the user:\n' + r.prompt : '') : r.prompt) + (extra ? '\n\nTrigger payload:\n' + extra : '');
    const model = r.model || (r.trigger.type === 'email' ? cheapest() : null);
    const res = await sendMessage(bot, prompt, { source: 'routine', routineName: r.name, ...(model ? { model, effort: 'low' } : {}) });
    r.lastStatus = res.message?.status === 'done' ? 'ok' : (res.message?.status || 'error');
    r.lastResult = (res.text || '').slice(0, 300);
  } catch (e) { r.lastStatus = 'error'; r.lastResult = String(e.message || e).slice(0, 300); }
  active.delete(r.id); save(); emit('routines');
}

function due(r, now) {
  const t = r.trigger;
  if (t.type === 'interval' || t.type === 'email') return !r.lastRun || now - r.lastRun >= t.minutes * 60000;
  if (t.type === 'daily') {
    const il = new Date(new Date(now).toLocaleString('en-US', { timeZone: tz() }));
    const [h, m] = t.time.split(':').map(Number);
    if (!t.days.includes(il.getDay())) return false;
    const mins = il.getHours() * 60 + il.getMinutes(), target = h * 60 + m;
    return mins >= target && mins < target + 10 && (!r.lastRun || now - r.lastRun > 11 * 60000);
  }
  return false;
}

export function startScheduler() {
  setInterval(() => {
    const now = Date.now();
    for (const r of state.routines) {
      if (!r.enabled) continue;
      const bot = getBot(r.botId); if (!bot) continue;
      if ((r.trigger.type === 'email' || r.trigger.type === 'webhook') && !bot.proactive) continue;
      if (due(r, now) && !isRunning(bot.id)) runRoutine(r);
    }
  }, 20000);
}

export function webhook(key, payload) {
  const r = state.routines.find((x) => x.trigger.type === 'webhook' && x.trigger.key === key && x.enabled);
  if (!r) return false;
  const bot = getBot(r.botId); if (!bot?.proactive) return false;
  runRoutine(r, String(payload || '').slice(0, 20000));
  return true;
}
