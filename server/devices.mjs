// Native clients: notification sockets + device-control sockets (see docs/CLIENT_CONTRACT.md)
import { state, save, emit, uid } from './store.mjs';

const notifySockets = new Map(); // deviceId -> Set<ws>
const deviceSockets = new Map(); // deviceId -> ws
const pending = new Map();       // rid -> {resolve, reject, timer}

function touchDevice(q) {
  const id = q.get('deviceId'); if (!id) return null;
  const d = (state.devices[id] ||= { id, firstSeen: Date.now() });
  d.name = q.get('name') || d.name || id; d.platform = q.get('platform') || d.platform || 'unknown'; d.lastSeen = Date.now();
  save();
  return d;
}
const keepAlive = (ws) => {
  const t = setInterval(() => { try { ws.send('{"type":"ping"}'); } catch {} }, 25000);
  ws.on('close', () => clearInterval(t));
};

export function attachNotify(ws, q) {
  const d = touchDevice(q); if (!d) return ws.close();
  (notifySockets.get(d.id) || notifySockets.set(d.id, new Set()).get(d.id)).add(ws);
  keepAlive(ws);
  ws.on('message', () => {});
  ws.on('close', () => notifySockets.get(d.id)?.delete(ws));
  ws.on('error', () => {});
}

export function attachDevice(ws, q) {
  const d = touchDevice(q); if (!d) return ws.close();
  const old = deviceSockets.get(d.id); if (old && old !== ws) try { old.close(); } catch {}
  deviceSockets.set(d.id, ws);
  keepAlive(ws);
  emit('devices');
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'response' && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer);
      m.ok ? p.resolve(m.result || {}) : p.reject(new Error(m.error || 'device error'));
    }
  });
  ws.on('close', () => { if (deviceSockets.get(d.id) === ws) { deviceSockets.delete(d.id); emit('devices'); } });
  ws.on('error', () => {});
}

export function listDevices() {
  return Object.values(state.devices).map((d) => ({ ...d, online: deviceSockets.has(d.id), notify: (notifySockets.get(d.id)?.size || 0) > 0 }));
}
export function forgetDevice(id) { delete state.devices[id]; save(); emit('devices'); }

export function deviceRequest(deviceId, bot, action, timeoutMs = 100000) {
  const ws = deviceSockets.get(deviceId);
  if (!ws) return Promise.reject(new Error('device is offline (the WitBox app must be running on it)'));
  const id = uid(12);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('device did not answer in time')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ type: 'request', id, botId: bot.id, botName: bot.name, action }));
  });
}

export function notify({ botId, botName, title, body, priority = 'normal', url }) {
  const n = { type: 'notification', id: uid(12), botId, botName, title, body, priority, url: url || `/#/bot/${botId}`, ts: Date.now() };
  state.inbox.unshift(n); state.inbox = state.inbox.slice(0, 200); save();
  const s = JSON.stringify(n);
  for (const set of notifySockets.values()) for (const ws of set) { try { ws.send(s); } catch {} }
  emit('notification', { notification: n });
  return n;
}
