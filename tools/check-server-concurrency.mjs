// Run only after review against the designated educational database.
// Does not deploy migrations, drop/truncate objects, or disable any trigger.
import { Client } from 'pg';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'docs/database/checks');
const reportPath = path.join(outputDir, 'server-concurrency-report.json');
const runId = randomUUID();
const marker = `__medcore_concurrency_${runId}`;
const report = {
  runId,
  startedAt: new Date().toISOString(),
  schema: 'project',
  result: 'pending',
  checks: [],
  fixture: { committed: false, employeeId: null, hospitalIds: [], employmentIds: [], referenceRowsCreated: {} },
  cleanup: { result: 'not-needed', retainedReferenceRows: [] },
  limitations: [
    'Exercises one conflicting pair of employment transactions, not a load test.',
    'Does not test application authorization or the privileges of a restricted API role.',
    'Two independent server sessions are used; schema owners can still disable their own triggers.',
    'A killed process or lost connection can require manual cleanup by the recorded fixture IDs.',
  ],
};
let clientA;
let clientB;
let connectedA = false;
let connectedB = false;
let pendingInsert = null;

function sanitized(error) {
  let message = String(error?.message ?? error);
  for (const key of ['PGPASSWORD', 'PGHOST', 'PGUSER', 'PGDATABASE']) {
    const value = process.env[key];
    if (value) message = message.split(value).join('[redacted]');
  }
  return { code: error?.code ?? null, message };
}

async function saveReport() {
  await mkdir(outputDir, { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}

function check(condition, name, details = {}) {
  if (!condition) throw new Error(`Failed assertion: ${name}`);
  report.checks.push({ name, result: 'passed', ...details });
  console.log(`PASS ${name}`);
}

async function rollback(client) {
  if (client) await client.query('ROLLBACK').catch(() => {});
}

async function referenceRow(client, table, code, insertSql) {
  // Identifiers are selected only by fixed calls below, never from user input.
  const allowed = ['employee_categories', 'academic_degrees', 'academic_titles'];
  if (!allowed.includes(table)) throw new Error('Unrecognized fixture reference table');
  const inserted = await client.query(insertSql, [code, `${marker}_${table}`]);
  if (inserted.rows.length) {
    const id = inserted.rows[0].id;
    report.fixture.referenceRowsCreated[table] = id;
    return id;
  }
  const existing = await client.query(`SELECT id FROM project.${table} WHERE code = $1`, [code]);
  if (existing.rowCount !== 1) throw new Error('Fixture reference is unavailable');
  return existing.rows[0].id;
}

async function createFixture() {
  await clientA.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await clientA.query("SET LOCAL lock_timeout = '5s'");
  const category = await referenceRow(clientA, 'employee_categories', 'doctor',
    'INSERT INTO project.employee_categories(code, name) VALUES ($1, $2) ON CONFLICT (code) DO NOTHING RETURNING id');
  const degree = await referenceRow(clientA, 'academic_degrees', 'none',
    'INSERT INTO project.academic_degrees(code, name, degree_rank) VALUES ($1, $2, 0) ON CONFLICT (code) DO NOTHING RETURNING id');
  const title = await referenceRow(clientA, 'academic_titles', 'none',
    'INSERT INTO project.academic_titles(code, name, minimum_degree_rank) VALUES ($1, $2, 0) ON CONFLICT (code) DO NOTHING RETURNING id');
  const employee = await clientA.query(`INSERT INTO project.employees(category_id, last_name, first_name, birth_date)
    VALUES ($1, $2, 'Проверка', DATE '1980-01-01') RETURNING id`, [category, marker]);
  report.fixture.employeeId = employee.rows[0].id;
  await clientA.query(`INSERT INTO project.doctors(employee_id, academic_degree_id, academic_title_id)
    VALUES ($1, $2, $3)`, [report.fixture.employeeId, degree, title]);
  for (const suffix of ['A', 'B']) {
    const hospital = await clientA.query(`INSERT INTO project.medical_organizations(name, organization_type, address, is_active)
      VALUES ($1, 'hospital', 'Вымышленный адрес для проверки транзакций', false) RETURNING id`, [`${marker}_${suffix}`]);
    const hospitalId = hospital.rows[0].id;
    report.fixture.hospitalIds.push(hospitalId);
    await clientA.query('INSERT INTO project.hospitals(organization_id) VALUES ($1)', [hospitalId]);
  }
  await clientA.query('COMMIT');
  report.fixture.committed = true;
  report.cleanup.result = 'pending';
  // Persist exact IDs before starting the two-session test for recoverability.
  await saveReport();
}

async function waitForAdvisoryBlock(blockedPid) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const lock = await clientA.query(`SELECT EXISTS (
      SELECT 1 FROM pg_catalog.pg_locks
      WHERE pid = $1 AND locktype = 'advisory' AND NOT granted
        AND classid = 1296389187::oid AND objid = 1::oid AND objsubid = 2
    ) AS waiting`, [blockedPid]);
    if (lock.rows[0].waiting) return true;
    await delay(50);
  }
  return false;
}

async function concurrencyCheck() {
  await clientA.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await clientB.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  const isolationA = (await clientA.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
  const isolationB = (await clientB.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
  check(isolationA === 'read committed' && isolationB === 'read committed', 'both writers use READ COMMITTED');

  const insert = `INSERT INTO project.employments(employee_id, organization_id, position_name, started_on, workload_fraction)
    VALUES ($1, $2, 'Врач — проверка конкуренции', DATE '2020-01-01', 1) RETURNING id`;
  const employmentA = await clientA.query(insert, [report.fixture.employeeId, report.fixture.hospitalIds[0]]);
  report.fixture.employmentIds.push(employmentA.rows[0].id);
  const beforeCommit = await clientB.query('SELECT count(*)::int AS count FROM project.employments WHERE employee_id = $1',
    [report.fixture.employeeId]);
  check(beforeCommit.rows[0].count === 0, 'session B cannot see the uncommitted employment of session A');

  const pidB = (await clientB.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  const startedWaiting = Date.now();
  // Attach a rejection handler immediately: the query can fail before polling completes.
  pendingInsert = clientB.query(insert, [report.fixture.employeeId, report.fixture.hospitalIds[1]])
    .then(value => ({ ok: true, value }), error => ({ ok: false, error }));
  const observed = await waitForAdvisoryBlock(pidB);
  check(observed, 'session B is observed waiting on the business advisory lock');
  report.observedWaitMilliseconds = Date.now() - startedWaiting;

  await clientA.query('COMMIT');
  check(true, 'session A commits its employment');
  const insertedB = await pendingInsert;
  pendingInsert = null;
  if (!insertedB.ok) throw insertedB.error;
  report.fixture.employmentIds.push(insertedB.value.rows[0].id);
  check(true, 'session B continues its INSERT after session A releases the lock');

  let commitError;
  try {
    await clientB.query('COMMIT');
  } catch (error) {
    commitError = error;
  } finally {
    await rollback(clientB);
  }
  check(commitError?.code === '23514', 'session B commit rejects conflicting employment using the fresh committed state',
    { expectedSqlState: '23514', actualSqlState: commitError?.code ?? null });
  const remaining = await clientA.query('SELECT id, organization_id FROM project.employments WHERE employee_id = $1',
    [report.fixture.employeeId]);
  check(remaining.rowCount === 1 && remaining.rows[0].organization_id === report.fixture.hospitalIds[0],
    'only the employment committed by session A remains');
}

async function isolationRejectionCheck() {
  await clientB.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  const isolation = (await clientB.query('SHOW transaction_isolation')).rows[0].transaction_isolation;
  check(isolation === 'repeatable read', 'negative isolation test actually uses REPEATABLE READ');
  let failure;
  try {
    await clientB.query(`INSERT INTO project.employments(employee_id, organization_id, position_name, started_on, workload_fraction)
      VALUES ($1, $2, 'Недопустимый уровень изоляции', DATE '2020-01-01', 1)`,
    [report.fixture.employeeId, report.fixture.hospitalIds[1]]);
  } catch (error) {
    failure = error;
  } finally {
    await rollback(clientB);
  }
  check(failure?.code === '25000', 'governed write under REPEATABLE READ is rejected explicitly',
    { expectedSqlState: '25000', actualSqlState: failure?.code ?? null });
}

async function cleanupFixture() {
  if (!report.fixture.committed) return;
  await clientA.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  await clientA.query("SET LOCAL lock_timeout = '5s'");
  const fixture = report.fixture;
  await clientA.query('DELETE FROM project.employments WHERE id = ANY($1::bigint[]) AND employee_id = $2',
    [fixture.employmentIds, fixture.employeeId]);
  await clientA.query('DELETE FROM project.doctors WHERE employee_id = $1', [fixture.employeeId]);
  await clientA.query('DELETE FROM project.employees WHERE id = $1 AND last_name = $2', [fixture.employeeId, marker]);
  await clientA.query('DELETE FROM project.hospitals WHERE organization_id = ANY($1::bigint[])', [fixture.hospitalIds]);
  await clientA.query('DELETE FROM project.medical_organizations WHERE id = ANY($1::bigint[]) AND name = ANY($2::text[])',
    [fixture.hospitalIds, [`${marker}_A`, `${marker}_B`]]);

  const references = [
    ['employee_categories', 'SELECT 1 FROM project.employees WHERE category_id = r.id'],
    ['academic_degrees', 'SELECT 1 FROM project.doctors WHERE academic_degree_id = r.id'],
    ['academic_titles', 'SELECT 1 FROM project.doctors WHERE academic_title_id = r.id'],
  ];
  for (const [table, dependency] of references) {
    const id = fixture.referenceRowsCreated[table];
    if (!id) continue; // Never delete a reference that was present before this run.
    const removed = await clientA.query(`DELETE FROM project.${table} AS r
      WHERE r.id = $1 AND r.name = $2 AND NOT EXISTS (${dependency}) RETURNING r.id`,
    [id, `${marker}_${table}`]);
    if (removed.rowCount === 0) report.cleanup.retainedReferenceRows.push({ table, id, reason: 'Reference was adopted or changed; not removed.' });
  }
  await clientA.query('COMMIT');
  const leftovers = await clientA.query(`SELECT
    (SELECT count(*) FROM project.employees WHERE id = $1)::int AS employees,
    (SELECT count(*) FROM project.medical_organizations WHERE id = ANY($2::bigint[]))::int AS organizations,
    (SELECT count(*) FROM project.employments WHERE id = ANY($3::bigint[]))::int AS employments`,
  [fixture.employeeId, fixture.hospitalIds, fixture.employmentIds]);
  check(Object.values(leftovers.rows[0]).every(count => count === 0), 'all committed personal fixture rows are removed');
  report.cleanup.result = 'passed';
}

try {
  process.loadEnvFile(path.join(root, '.env'));
  if (!['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'].every(key => process.env[key])) {
    throw new Error('The local .env must contain the designated educational database connection');
  }
  const config = {
    ssl: false,
    connectionTimeoutMillis: 12000,
    statement_timeout: 15000,
    query_timeout: 20000,
    application_name: `medcore-concurrency-${runId}`,
  };
  clientA = new Client(config);
  clientB = new Client(config);
  const connections = await Promise.allSettled([clientA.connect(), clientB.connect()]);
  connectedA = connections[0].status === 'fulfilled';
  connectedB = connections[1].status === 'fulfilled';
  for (const connection of connections) if (connection.status === 'rejected') throw connection.reason;

  const preflight = (await clientA.query(`SELECT current_database() = $1 AS database_matches,
    current_user = $2 AS user_matches, current_setting('server_version') AS server_version,
    to_regclass('project.business_rule_checks') IS NOT NULL AS queue_exists,
    to_regprocedure('project.fn_lock_business_writes()') IS NOT NULL AS rules_exist`,
  [process.env.PGDATABASE, process.env.PGUSER])).rows[0];
  check(preflight.database_matches && preflight.user_matches && preflight.queue_exists && preflight.rules_exist,
    'connection identity and deployed business-rule objects match the intended environment');
  report.serverVersion = preflight.server_version;
  report.transport = 'SSL disabled for this educational server';
  report.businessRulesFileSha256 = createHash('sha256')
    .update(await readFile(path.join(root, 'database/migrations/002_business_rules.sql'))).digest('hex');

  await createFixture();
  await concurrencyCheck();
  await isolationRejectionCheck();
  const queue = await clientA.query('SELECT count(*)::int AS count FROM project.business_rule_checks');
  check(queue.rows[0].count === 0, 'business-rule queue has no committed residual requests');
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.error = sanitized(error);
  console.error(JSON.stringify({ result: 'failed', error: report.error }));
} finally {
  // Release A before awaiting a possibly blocked B query; otherwise cleanup
  // itself could wait behind the lock held by this test.
  if (connectedA) await rollback(clientA);
  if (pendingInsert) {
    const pending = await pendingInsert;
    pendingInsert = null;
    if (pending.ok) report.fixture.employmentIds.push(pending.value.rows[0].id);
  }
  if (connectedB) await rollback(clientB);
  try {
    if (connectedA) await cleanupFixture();
  } catch (error) {
    if (connectedA) await rollback(clientA);
    report.cleanup.result = 'failed';
    report.cleanup.error = sanitized(error);
    report.result = 'failed';
  }
  if (clientA) await clientA.end().catch(() => {});
  if (clientB) await clientB.end().catch(() => {});
  report.finishedAt = new Date().toISOString();
  await saveReport();
  console.log(`${report.result.toUpperCase()}: ${report.checks.length} assertions; fixture cleanup ${report.cleanup.result}`);
  process.exitCode = report.result === 'passed' ? 0 : 1;
}
