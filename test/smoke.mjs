// End-to-end smoke test for the whole modular monolith, backed by PGlite
// (in-process Postgres). Run:  npm run build && node test/smoke.mjs
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'fs';
import http from 'http';
import { generateKeyPairSync } from 'crypto';
import { createTenantApp } from '../dist/app.js';
import { hashPassword } from '../dist/auth/passwords.js';
import { signAccessToken } from '../dist/auth/jwt.js';

const db = await new PGlite();
for (const f of readdirSync('./migrations').filter((f) => /^\d+.*\.sql$/.test(f)).sort())
  await db.exec(readFileSync(`./migrations/${f}`, 'utf8'));

const pools = {
  activePoolCount: 1,
  async query(_c, t, p) { return db.query(t, p || []); },
  async withTransaction(_c, fn) {
    await db.query('BEGIN');
    try { const r = await fn({ query: (t, p) => db.query(t, p || []) }); await db.query('COMMIT'); return r; }
    catch (e) { await db.query('ROLLBACK'); throw e; }
  },
};
const ctx = { tenant: { id: '11111111-1111-1111-1111-111111111111', slug: 'sunrise', subdomain: 'sunrise', dbName: 'd', dbInstanceId: 'i', status: 'active' }, instance: { id: 'i' } };
const cache = { size: 1, get: (s) => (s === 'sunrise' ? ctx : undefined) };
const { privateKey: priv, publicKey: pub } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const keys = { activeKid: 'k1', privateKeyPem: priv, publicKeys: { k1: pub }, issuer: 'schoolmgmt.com', accessTtlSeconds: 3600 };

const adminId = (await db.query(
  `INSERT INTO users(email,password_hash,role,full_name) VALUES('admin@sunrise.com',$1,'admin','Head') RETURNING id`,
  [await hashPassword('secret123')])).rows[0].id;
const yr = (await db.query(`INSERT INTO academic_years(name,start_date,end_date,is_current) VALUES('2025-2026','2025-04-01','2026-03-31',true) RETURNING id`)).rows[0].id;
await db.query(`INSERT INTO students(admission_number,first_name,last_name,date_of_birth) VALUES('A1','R','K','2015-01-01'),('A2','S','K','2015-02-01')`);
await db.query(`INSERT INTO staff(employee_code,first_name,last_name) VALUES('E1','J','S')`);
await db.query(`INSERT INTO school_events(academic_year_id,title,event_type,start_date,end_date) VALUES($1,'Sports Day','sports',CURRENT_DATE+7,CURRENT_DATE+7)`, [yr]);

const app = createTenantApp({ cache, pools, keys, baseDomain: 'schoolmgmt.com' });
const server = http.createServer(app).listen(0);
const port = server.address().port;
const call = (m, path, { host = 'sunrise.schoolmgmt.com', token, body } = {}) => new Promise((rs) => {
  const d = body ? JSON.stringify(body) : null;
  const headers = { 'content-type': 'application/json', host };
  if (token) headers['authorization'] = 'Bearer ' + token;
  const q = http.request({ port, method: m, path, headers }, (res) => {
    let x = ''; res.on('data', (c) => (x += c)); res.on('end', () => rs({ status: res.statusCode, body: JSON.parse(x || '{}') }));
  });
  if (d) q.write(d); q.end();
});
let pass = 0, fail = 0;
const ck = (n, c, r) => { console.log((c ? 'PASS' : 'FAIL') + '  ' + n + (c ? '' : '  -> ' + JSON.stringify(r?.body))); c ? pass++ : fail++; };

let r = await call('GET', '/health', { host: 'schoolmgmt.com' }); ck('health ok', r.status === 200);
r = await call('GET', '/api/v1/dashboard/admin', { host: 'ghost.schoolmgmt.com' }); ck('unknown tenant -> 404', r.status === 404);
r = await call('GET', '/api/v1/dashboard/admin'); ck('no token -> 401', r.status === 401);
r = await call('POST', '/api/v1/auth/login', { body: { email: 'admin@sunrise.com', password: 'secret123' } }); ck('login', r.status === 200 && r.body.data.access_token, r);
const token = r.body.data.access_token, refresh = r.body.data.refresh_token;
r = await call('POST', '/api/v1/auth/login', { body: { email: 'admin@sunrise.com', password: 'nope' } }); ck('wrong password 401', r.status === 401);
r = await call('GET', '/api/v1/auth/me', { token }); ck('me', r.status === 200 && r.body.data.email === 'admin@sunrise.com');
r = await call('GET', '/api/v1/dashboard/admin', { token }); ck('admin dashboard', r.status === 200 && r.body.data.students_total === 2 && r.body.data.staff_total === 1, r);
const foreign = signAccessToken(keys, { userId: adminId, email: 'x', role: 'admin', tenantId: '99999999-9999-9999-9999-999999999999', tenantSlug: 'other' }).token;
r = await call('GET', '/api/v1/dashboard/admin', { token: foreign }); ck('cross-tenant -> 403', r.status === 403 && r.body.error.code === 'TENANT_MISMATCH');
r = await call('POST', '/api/v1/auth/refresh', { body: { refresh_token: refresh } }); ck('refresh rotation', r.status === 200 && r.body.data.refresh_token !== refresh);
r = await call('POST', '/api/v1/auth/refresh', { body: { refresh_token: refresh } }); ck('reused refresh -> 401', r.status === 401);
r = await call('GET', `/internal/users/${adminId}/role`); ck('internal role lookup', r.status === 200 && r.body.data.role === 'admin');
r = await call('GET', '/api/v1/nope', { token }); ck('unknown route 404', r.status === 404);

console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
