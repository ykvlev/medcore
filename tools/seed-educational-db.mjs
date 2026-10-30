// Default: isolated in-memory verification. --server explicitly targets the
// designated educational database; it never creates schemas or deletes data.
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, pbkdf2Sync, timingSafeEqual, createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const args = process.argv.slice(2);
const serverMode = args.includes('--server');
const unexpected = args.filter(arg => arg !== '--server' && arg !== '--local-check' && !arg.startsWith('--anchor='));
if (unexpected.length || (args.includes('--server') && args.includes('--local-check'))) {
  throw new Error('Usage: seed-educational-db.mjs [--local-check | --server] [--anchor=YYYY-MM-DD]');
}
const anchorDate = args.find(arg => arg.startsWith('--anchor='))?.split('=')[1] ?? '2026-10-30';
if (!/^\d{4}-\d{2}-\d{2}$/.test(anchorDate) || Number.isNaN(Date.parse(`${anchorDate}T00:00:00Z`))) {
  throw new Error('Anchor must be a valid ISO calendar date');
}
let demoPassword = process.env.MEDCORE_DEMO_PASSWORD;
if (serverMode && (!demoPassword || demoPassword.length < 12)) {
  throw new Error('Set MEDCORE_DEMO_PASSWORD to a password of at least 12 characters before server seeding');
}
// An in-memory verification does not need to publish or retain a demo credential.
demoPassword ??= randomBytes(32).toString('base64url');

function identityV3Hash(password) {
  const salt = randomBytes(16);
  const iterations = 210000;
  const subkey = pbkdf2Sync(password, salt, iterations, 32, 'sha512');
  const header = Buffer.alloc(13);
  header[0] = 0x01;
  header.writeUInt32BE(2, 1); // HMACSHA512, ASP.NET KeyDerivationPrf
  header.writeUInt32BE(iterations, 5);
  header.writeUInt32BE(salt.length, 9);
  return Buffer.concat([header, salt, subkey]).toString('base64');
}
function verifyIdentityV3(hash, password) {
  const bytes = Buffer.from(hash, 'base64');
  if (bytes[0] !== 1 || bytes.readUInt32BE(1) !== 2) return false;
  const saltLength = bytes.readUInt32BE(9);
  const expected = bytes.subarray(13 + saltLength);
  const actual = pbkdf2Sync(password, bytes.subarray(13, 13 + saltLength), bytes.readUInt32BE(5), expected.length, 'sha512');
  return expected.length === 32 && timingSafeEqual(actual, expected);
}
const passwordHash = identityV3Hash(demoPassword);
if (!verifyIdentityV3(passwordHash, demoPassword)) throw new Error('Identity V3 hash self-check failed');

const report = {
  performedAt: new Date().toISOString(), mode: serverMode ? 'educational-server' : 'isolated-pglite',
  anchorDate, schema: 'project', result: 'pending', checks: [],
  credentials: { logins: ['admin','manager','doctor','registrar','lab','analyst'],
    passwordSource: process.env.MEDCORE_DEMO_PASSWORD ? 'MEDCORE_DEMO_PASSWORD environment variable' : 'ephemeral random value for local verification only',
    hashFormat: 'ASP.NET Identity V3 PBKDF2-HMAC-SHA512, 210000 iterations, random 16-byte salt, 32-byte subkey' },
};
const seedSql = await readFile(path.join(root, 'database/seeds/demo.sql'), 'utf8');
report.seedSha256 = createHash('sha256').update(seedSql).digest('hex');
const seedBody = seedSql.replace(/^BEGIN;\s*$/gm, '').replace(/^COMMIT;\s*$/gm, '');
let db;
let committed = false;
let exec;
let query;
try {
  if (serverMode) {
    db = new Client({ ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
      connectionTimeoutMillis: 12000, statement_timeout: 180000, application_name: 'medcore-demo-seed' });
    await db.connect();
    exec = sql => db.query(sql);
    query = (sql, params) => db.query(sql, params);
    const identity = (await query('SELECT current_database() AS database, current_user AS username')).rows[0];
    if (identity.database !== 'db_a_s_yakovlev' || identity.username !== 'a-s-yakovlev') throw new Error('Unexpected educational database identity');
    const schema = (await query("SELECT pg_get_userbyid(nspowner) = current_user AS owned FROM pg_namespace WHERE nspname='project'")).rows[0];
    if (!schema?.owned) throw new Error('The project schema must already exist and belong to the expected user');
  } else {
    db = new PGlite({ extensions: { btree_gist, pg_trgm } });
    exec = sql => db.exec(sql);
    query = (sql, params) => db.query(sql, params);
    const files = (await readdir(path.join(root, 'database/migrations'))).filter(file => file.endsWith('.sql')).sort();
    for (const file of files) await exec(await readFile(path.join(root, 'database/migrations', file), 'utf8'));
    report.checks.push({ name: 'all current migrations applied to isolated empty database', result: 'passed' });
  }
  report.engine = (await query('SELECT version() AS version')).rows[0].version;
  await exec('BEGIN');
  await exec("SET LOCAL lock_timeout='10s'");
  await query("SELECT set_config('medcore.seed_password_hash',$1,true),set_config('medcore.seed_anchor_date',$2,true)", [passwordHash, anchorDate]);
  console.log(serverMode ? 'Loading synthetic data into the designated educational project schema...' : 'Checking full synthetic dataset in isolated PostgreSQL...');
  await exec(seedBody);
  await exec('COMMIT');
  committed = true;
  report.checks.push({ name: 'single seed transaction and deferred business constraints committed', result: 'passed' });
  report.counts = (await query(`SELECT
      (SELECT count(*)::int FROM project.hospitals) AS hospitals,
      (SELECT count(*)::int FROM project.polyclinics) AS polyclinics,
      (SELECT count(*)::int FROM project.buildings) AS buildings,
      (SELECT count(*)::int FROM project.departments) AS departments,
      (SELECT count(*)::int FROM project.wards) AS wards,
      (SELECT count(*)::int FROM project.beds) AS beds,
      (SELECT count(*)::int FROM project.doctors) AS doctors,
      (SELECT count(*)::int FROM project.employees) AS employees,
      (SELECT count(*)::int FROM project.patients) AS patients,
      (SELECT count(*)::int FROM project.medical_cases) AS medical_cases,
      (SELECT count(*)::int FROM project.hospitalizations) AS hospitalizations,
      (SELECT count(*)::int FROM project.hospitalizations WHERE status='active') AS active_hospitalizations,
      (SELECT count(*)::int FROM project.surgeries) AS surgeries,
      (SELECT count(*)::int FROM project.laboratories) AS laboratories,
      (SELECT count(*)::int FROM project.laboratory_contracts) AS laboratory_contracts,
      (SELECT count(*)::int FROM project.lab_orders) AS lab_orders,
      (SELECT count(*)::int FROM project.lab_results) AS lab_results,
      (SELECT count(*)::int FROM project.users) AS users`)).rows[0];
  report.capacity = (await query(`SELECT sum(total_beds)::int AS total_beds,
      sum(occupied_beds)::int AS occupied_beds, sum(free_beds)::int AS free_beds,
      sum(unavailable_beds)::int AS unavailable_beds FROM project.vw_hospital_capacity`)).rows[0];
  if (report.capacity.total_beds !== 300 || report.capacity.occupied_beds !== 100 || report.capacity.free_beds !== 200) {
    throw new Error('Unexpected current bed capacity');
  }
  const credentialRows = (await query('SELECT login,password_hash FROM project.users ORDER BY login')).rows;
  if (credentialRows.length !== 6 || credentialRows.some(row => !verifyIdentityV3(row.password_hash, demoPassword))) {
    throw new Error('Demo account password verification failed');
  }
  report.checks.push({ name: 'all six account hashes verify as ASP.NET Identity V3', result: 'passed' });
  const unauthorizedAuthors = (await query(`SELECT count(*)::int AS count FROM project.lab_results r
      JOIN project.lab_orders o ON o.id=r.order_id JOIN project.laboratory_contracts c ON c.id=o.contract_id
      WHERE NOT EXISTS(SELECT 1 FROM project.user_organization_scopes s
        JOIN project.roles role ON role.id=s.role_id WHERE s.user_id=r.entered_by_user_id
          AND s.laboratory_id=c.laboratory_id AND role.code='lab_staff')`)).rows[0].count;
  if (unauthorizedAuthors !== 0) throw new Error('A result author lacks the matching lab scope');
  report.checks.push({ name: 'laboratory result authors have matching laboratory scope', result: 'passed' });
  const lateReferrals=(await query(`SELECT count(*)::int AS count FROM project.referrals r
      JOIN project.medical_cases c ON c.id=r.case_id
      WHERE r.issued_at<c.opened_at OR (c.closed_at IS NOT NULL AND r.issued_at>c.closed_at)`)).rows[0].count;
  if(lateReferrals!==0) throw new Error('Referral falls outside its source case');
  report.checks.push({name:'all referrals fall within their source medical case',result:'passed'});
  const missingWorkScopes=(await query(`SELECT count(*)::int AS count FROM project.users u
      JOIN project.user_organization_scopes scope ON scope.user_id=u.id
      WHERE u.login IN ('manager','registrar','doctor') AND scope.organization_id IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM project.employments e WHERE e.employee_id=u.employee_id
          AND e.organization_id=scope.organization_id AND e.ended_on IS NULL)`)).rows[0].count;
  if(missingWorkScopes!==0) throw new Error('A demo clinical/organization account has a scope without employment');
  report.checks.push({name:'manager, registrar and doctor scopes match employment',result:'passed'});

  await exec(await readFile(path.join(root, 'database/queries/required_queries.sql'), 'utf8'));
  const organizations = (await query('SELECT id FROM project.medical_organizations ORDER BY id')).rows.map(row => Number(row.id));
  const hospitals = (await query('SELECT organization_id AS id FROM project.hospitals ORDER BY organization_id')).rows.map(row => Number(row.id));
  const clinic = Number((await query('SELECT organization_id AS id FROM project.polyclinics ORDER BY organization_id LIMIT 1')).rows[0].id);
  const hospitalization = Number((await query("SELECT id FROM project.hospitalizations WHERE status='active' ORDER BY id LIMIT 1")).rows[0].id);
  const organizationArray = `ARRAY[${organizations.join(',')}]::bigint[]`;
  const hospitalArray = `ARRAY[${hospitals.join(',')}]::bigint[]`;
  const from = `${Number(anchorDate.slice(0, 4))}-01-01 00:00+03`;
  const until = `${Number(anchorDate.slice(0, 4)) + 1}-01-01 00:00+03`;
  const executions = [
    `EXECUTE medcore_q01('Иванов',${organizationArray},25,0)`,
    `EXECUTE medcore_q02('${anchorDate}',${organizationArray})`,
    `EXECUTE medcore_q03(${hospitalArray})`,
    `EXECUTE medcore_q04('${anchorDate}',${organizationArray})`,
    `EXECUTE medcore_q05(${hospitals[0]},${clinic},'${anchorDate}')`,
    `EXECUTE medcore_q06('${from}','${until}',${hospitalArray})`,
    `EXECUTE medcore_q07(20,${hospitalArray})`,
    `EXECUTE medcore_q08(${hospitalization},${hospitalArray})`,
    `EXECUTE medcore_q09('${from}','${until}',${hospitalArray})`,
    `EXECUTE medcore_q10(${hospitalArray})`,
    `EXECUTE medcore_q11(${Number(anchorDate.slice(0,4))},${hospitalArray})`,
    `EXECUTE medcore_q12('${from}','${until}',${hospitalArray})`,
  ];
  for (let i=0; i<executions.length; i++) {
    const result = await query(executions[i]);
    report.checks.push({ name: `Q${String(i+1).padStart(2,'0')} executes against full dataset`, result: 'passed', rowCount: result.rows.length });
  }
  await exec('BEGIN');
  try {
    await query("SELECT set_config('medcore.seed_password_hash',$1,true)",[passwordHash]);
    await exec(seedBody);
    throw new Error('Repeat seeding unexpectedly accepted');
  } catch (error) {
    if (error.code !== '55000') throw error;
    report.checks.push({ name: 'repeat seeding refused without changing existing data', result: 'passed', sqlState: error.code });
  } finally { await exec('ROLLBACK'); }
  report.result = 'passed';
  console.log(`PASS: ${report.counts.patients} patients, ${report.counts.medical_cases} cases, ${report.counts.hospitalizations} hospitalizations, ${report.counts.lab_results} results.`);
  console.log('Demo passwords and hashes were not printed.');
} catch (error) {
  if (db) await exec?.('ROLLBACK').catch(() => {});
  report.result='failed'; report.seedCommitted=committed;
  const secrets=[process.env.PGPASSWORD, demoPassword, passwordHash].filter(Boolean);
  let safeMessage=String(error.message);
  for (const secret of secrets) safeMessage=safeMessage.replaceAll(secret,'[redacted]');
  report.error={code:error.code,message:safeMessage};
  console.error(JSON.stringify(report.error));
  process.exitCode=1;
} finally {
  if (db) await (serverMode ? db.end() : db.close()).catch(() => {});
  const output=path.join(root,'docs/database/checks');
  await mkdir(output,{recursive:true});
  await writeFile(path.join(output,serverMode ? 'educational-seed-report.json' : 'local-seed-report.json'),JSON.stringify(report,null,2)+'\n');
}
