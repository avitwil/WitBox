// Vault: logins and contact details the bots may use. Secrets are encrypted at rest (AES-256-GCM, key in
// data/vault.key, mode 600) and are never sent to the model — a bot can only ask for one to be typed into its desktop.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA, uid } from './store.mjs';

const FILE = path.join(DATA, 'vault.json'), KEYF = path.join(DATA, 'vault.key');
const key = () => { if (!fs.existsSync(KEYF)) fs.writeFileSync(KEYF, crypto.randomBytes(32), { mode: 0o600 }); return fs.readFileSync(KEYF); };
const enc = (s) => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', key(), iv); const d = Buffer.concat([c.update(String(s), 'utf8'), c.final()]); return [iv, c.getAuthTag(), d].map((b) => b.toString('base64')).join('.'); };
const dec = (s) => { const [iv, tag, d] = String(s).split('.').map((x) => Buffer.from(x, 'base64')); const c = crypto.createDecipheriv('aes-256-gcm', key(), iv); c.setAuthTag(tag); return Buffer.concat([c.update(d), c.final()]).toString('utf8'); };
let items = []; try { items = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
const persist = () => { const t = FILE + '.tmp'; fs.writeFileSync(t, JSON.stringify(items, null, 1), { mode: 0o600 }); fs.renameSync(t, FILE); };

// kinds: login {site, username, password, note} · contact {label, name, email, phone, address}
const SECRET = ['password'];
const pub = (it) => { const { secret, ...rest } = it; return { ...rest, hasPassword: !!secret?.password }; };
export const list = () => items.map(pub);
export const get = (id) => items.find((x) => x.id === id);
export function upsert(id, body) {
  let it = id ? get(id) : null;
  if (!it) { it = { id: uid(10), kind: body.kind === 'contact' ? 'contact' : 'login', created: Date.now(), secret: {} }; items.push(it); }
  for (const k of ['site', 'username', 'note', 'label', 'name', 'email', 'phone', 'address']) if (k in body) it[k] = String(body[k] ?? '').slice(0, 500);
  for (const k of SECRET) if (typeof body[k] === 'string' && body[k] !== '') (it.secret ||= {})[k] = enc(body[k]);
  it.updated = Date.now(); persist();
  return pub(it);
}
export function remove(id) { items = items.filter((x) => x.id !== id); persist(); }
export function reveal(id, field = 'password') { const it = get(id); if (!it?.secret?.[field]) return null; return dec(it.secret[field]); }
// What a bot may see: everything except secrets.
export const forBot = () => items.map((it) => (it.kind === 'login' ? { id: it.id, kind: 'login', site: it.site, username: it.username, note: it.note, has_password: !!it.secret?.password } : { id: it.id, kind: 'contact', label: it.label, name: it.name, email: it.email, phone: it.phone, address: it.address }));
