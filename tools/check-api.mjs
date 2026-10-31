// End-to-end HTTP checks against the running local API and educational database.
// Creates one explicitly marked patient, then removes only that test fixture.
import { Client } from 'pg';
import net from 'node:net';
// На части сетей авто-выбор семейства адресов в Node уходит в IPv6 и висит.
net.setDefaultAutoSelectFamily(false);
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));
const base = process.env.MEDCORE_API_URL ?? 'http://127.0.0.1:5180';
const report = { checkedAt: new Date().toISOString(), result: 'pending', checks: [], cleanup: 'not-needed', limitations: ['HTTP API checks; browser interaction is checked separately.', 'Hospitalization write operations and full coursework acceptance are not covered.'] };
const marker = `Проверка-${randomUUID().slice(0, 8)}`;
const sessions = [];
let fixtureId;
let db;
function assert(condition, name, details = {}) {
  if (!condition) throw new Error(name);
  report.checks.push({ name, result: 'passed', ...details });
  console.log(`PASS ${name}`);
}
async function request(endpoint, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(base + endpoint, { method,
    headers: { Accept: 'application/json', Origin: process.env.MEDCORE_ORIGIN ?? 'http://127.0.0.1:5173',
      ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
  return { status: response.status, data, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
}
async function login(name) {
  const result = await request('/api/auth/login', { method: 'POST', body: { login: name, password: process.env.MEDCORE_DEMO_PASSWORD } });
  assert(result.status === 200 && !!result.cookie, `${name}: real login creates session cookie`, { status: result.status });
  sessions.push(result.cookie);
  return result.cookie;
}
try {
  assert((await request('/health')).status === 200, 'API health responds');
  assert((await request('/api/auth/me')).status === 401, 'anonymous session is rejected');
  assert((await request('/api/auth/login', { method: 'POST', body: { login: 'registrar', password: 'deliberately-wrong-password' } })).status === 401, 'incorrect password is rejected');
  const registrar = await login('registrar');
  const me = await request('/api/auth/me', { cookie: registrar });
  assert(me.status === 200 && me.data.roles.includes('registrar'), 'session resolves the registrar role');
  const list = await request('/api/patients?page=1&pageSize=15', { cookie: registrar });
  assert(list.status === 200 && list.data.total > 0 && list.data.items.length <= 15, 'patients come from the scoped paginated API');
  const orgs = await request('/api/organizations', { cookie: registrar });
  const clinic = orgs.data?.items?.find(o => o.organizationType === 'polyclinic' && o.isActive);
  assert(!!clinic, 'registrar has an active authorized polyclinic');
  const created = await request('/api/patients', { cookie: registrar, method: 'POST', body: {
    lastName: marker, firstName: 'Учебный', middleName: null, birthDate: '1997-06-15', sex: 'unknown',
    phone: '+7 (000) 000-00-01', email: null, address: 'Вымышленный адрес проверки API', polyclinicId: clinic.id,
  } });
  fixtureId = created.data?.id ?? created.data?.patient?.id;
  assert(created.status === 201 && !!fixtureId, 'TC-01 API: patient registration succeeds', { status: created.status });
  const card = await request(`/api/patients/${fixtureId}`, { cookie: registrar });
  assert(card.status === 200 && card.data.patient.lastName === marker, 'new patient is readable after registration');
  const search = await request(`/api/patients?search=${encodeURIComponent(marker)}&page=1&pageSize=15`, { cookie: registrar });
  assert(search.status === 200 && search.data.total === 1 && search.data.items[0].id === fixtureId, 'TC-03 API: search finds the registered patient');
  const contacts = { phone: '+7 (000) 000-00-02', email: 'api-check@example.test', address: 'Обновлённый вымышленный адрес', version: card.data.patient.version };
  const updated = await request(`/api/patients/${fixtureId}`, { cookie: registrar, method: 'PUT', body: contacts });
  assert([200, 204].includes(updated.status), 'TC-02 API: authorized contacts update succeeds');
  const changed = await request(`/api/patients/${fixtureId}`, { cookie: registrar });
  assert(changed.data.patient.phone === contacts.phone && changed.data.patient.version > contacts.version, 'contact update is persisted with a new version');
  const conflict = await request(`/api/patients/${fixtureId}`, { cookie: registrar, method: 'PUT', body: contacts });
  assert(conflict.status === 409, 'stale patient version is rejected');
  const denied = await request(`/api/patients/${fixtureId}/diagnoses`, { cookie: registrar, method: 'POST', body: { caseId: 1, diagnosisId: 1, isPrimary: false, note: 'Access rejection test' } });
  assert(denied.status === 403, 'TC-05 API: registrar cannot create a diagnosis', { status: denied.status });

  // Прямая сверка идёт в ту же базу, что и API: для внешнего стенда адрес
  // передаётся через MEDCORE_DATABASE_URL, иначе используются PG* из .env.
  db = new Client(process.env.MEDCORE_DATABASE_URL
    ? { connectionString: process.env.MEDCORE_DATABASE_URL, ssl: /sslmode=disable/.test(process.env.MEDCORE_DATABASE_URL) ? false : { rejectUnauthorized: false }, connectionTimeoutMillis: 12000, statement_timeout: 10000 }
    : { ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true }, connectionTimeoutMillis: 12000, statement_timeout: 10000 });
  await db.connect();
  const persisted = (await db.query('SELECT phone,version FROM project.patients WHERE id=$1 AND last_name=$2', [fixtureId, marker])).rows[0];
  assert(persisted?.phone === contacts.phone, 'patient change is verified directly in PostgreSQL');
  const audit = (await db.query("SELECT count(*)::int AS count FROM project.audit_logs WHERE entity_id=$1 AND entity_type='patient' AND actor_user_id=$2 AND action IN ('insert','update')", [fixtureId, me.data.id])).rows[0];
  assert(audit.count >= 2, 'patient creation and update have actor-attributed audit entries');
  for (const [name, allowedPath, deniedPath] of [
    ['admin', '/api/dashboard/summary', '/api/patients'],
    ['manager', '/api/reports/overview', '/api/patients'],
    ['analyst', '/api/reports/overview', '/api/patients'],
    ['lab', '/api/laboratories', '/api/patients'],
  ]) {
    const cookie = await login(name);
    assert((await request(allowedPath, { cookie })).status === 200, `${name}: permitted read succeeds`);
    assert((await request(deniedPath, { cookie })).status === 403, `${name}: personal patient list is denied`);
  }
  const doctor = await login('doctor');
  assert((await request('/api/patients?page=1&pageSize=15', { cookie: doctor })).status === 200, 'doctor can read patients within care relationships');
  assert((await request(`/api/patients/${fixtureId}`, { cookie: doctor, method: 'PUT', body: { ...contacts, version: changed.data.patient.version } })).status === 403, 'doctor cannot use the registrar contact-edit permission');
  assert((await request('/api/auth/logout', { cookie: registrar, method: 'POST' })).status === 204, 'logout succeeds');
  assert((await request('/api/auth/me', { cookie: registrar })).status === 401, 'old session cookie is rejected after logout');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.error = String(error.message).replaceAll(process.env.PGPASSWORD, '[redacted]').replaceAll(process.env.MEDCORE_DEMO_PASSWORD, '[redacted]');
  console.error(report.error);
} finally {
  for (const cookie of sessions) await request('/api/auth/logout', { cookie, method: 'POST' }).catch(() => {});
  if (fixtureId && db) {
    try {
      await db.query('BEGIN');
      const owned = (await db.query('SELECT id FROM project.patients WHERE id=$1 AND last_name=$2 FOR UPDATE', [fixtureId, marker])).rowCount;
      if (owned !== 1) throw new Error('Test patient identity does not match');
      await db.query('DELETE FROM project.patient_attachments WHERE patient_id=$1', [fixtureId]);
      await db.query('DELETE FROM project.patients WHERE id=$1 AND last_name=$2', [fixtureId, marker]);
      await db.query('COMMIT');
      report.cleanup = 'passed';
    } catch (error) { await db.query('ROLLBACK').catch(() => {}); report.cleanup = 'failed'; report.result = 'failed'; }
  } else if (fixtureId) { report.cleanup = 'pending: database verification was not reached'; report.fixtureId = fixtureId; }
  if (db) await db.end().catch(() => {});
  await mkdir(path.join(root, 'docs/database/checks'), { recursive: true });
  await writeFile(path.join(root, 'docs/database/checks/api-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.result.toUpperCase()}: ${report.checks.length} checks, fixture cleanup ${report.cleanup}`);
  process.exitCode = report.result === 'passed' ? 0 : 1;
}
