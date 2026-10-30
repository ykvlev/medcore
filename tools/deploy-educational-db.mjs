// Initial deployment into the user-designated, empty project schema.
// Refuses existing relations/routines/types; never drops or truncates objects.
import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));
const client = new Client({ ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
  connectionTimeoutMillis: 12000, statement_timeout: 60000,
  application_name: 'medcore-initial-deployment' });
const report = { performedAt: new Date().toISOString(), schema: 'project', result: 'pending', migrations: [], checks: [] };
let committed = false;
try {
  await client.connect();
  const identity = (await client.query('SELECT current_database() AS database, current_user AS username, version() AS version')).rows[0];
  if (identity.database !== 'db_a_s_yakovlev' || identity.username !== 'a-s-yakovlev') throw new Error('Unexpected database identity');
  report.serverVersion = identity.version;
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  const owner = (await client.query("SELECT pg_get_userbyid(nspowner) = current_user AS owned FROM pg_namespace WHERE nspname = 'project'")).rows[0];
  if (!owner?.owned) throw new Error('project schema must already exist and belong to the expected user');
  const objects = (await client.query(`SELECT 'relation' AS kind, c.relname AS name FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'project'
    UNION ALL SELECT 'routine', p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'project'
    UNION ALL SELECT 'type', t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'project'`)).rows;
  if (objects.length) throw new Error('project is not empty; refusing to overwrite any existing object');
  const files = (await readdir(path.join(root, 'database/migrations'))).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) {
    const sql = await readFile(path.join(root, 'database/migrations', file), 'utf8');
    // Only remove the top-level transaction wrappers. PL/pgSQL BEGIN has no semicolon.
    const insideTransaction = sql.replace(/^BEGIN;\s*$/gm, '').replace(/^COMMIT;\s*$/gm, '');
    await client.query(insideTransaction);
    report.migrations.push({ file, sha256: createHash('sha256').update(sql).digest('hex'), result: 'passed' });
  }
  await client.query('COMMIT');
  committed = true;
  await client.query('SET search_path = project, public');
  await client.query(await readFile(path.join(root, 'database/queries/required_queries.sql'), 'utf8'));
  report.checks.push({ name: '12 prepared queries compile on the educational server', result: 'passed' });
  const testFiles = (await readdir(path.join(root, 'database/tests'))).filter(f => f.endsWith('.sql')).sort();
  for (const file of testFiles) {
    await client.query(await readFile(path.join(root, 'database/tests', file), 'utf8'));
    report.checks.push({ name: file, result: 'passed', dataRolledBack: true, sequenceValuesMayAdvance: true });
  }
  report.inventory = (await client.query(`SELECT table_type, count(*)::int AS count
    FROM information_schema.tables WHERE table_schema = 'project' GROUP BY table_type ORDER BY table_type`)).rows;
  report.routines = (await client.query(`SELECT routine_type, count(*)::int AS count
    FROM information_schema.routines WHERE routine_schema = 'project' GROUP BY routine_type ORDER BY routine_type`)).rows;
  report.extensions = (await client.query("SELECT extname, extversion FROM pg_extension WHERE extname IN ('btree_gist', 'pg_trgm') ORDER BY extname")).rows;
  report.result = 'passed';
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  report.result = 'failed';
  report.schemaDeploymentCommitted = committed;
  report.error = { code: error.code, message: String(error.message).replaceAll(process.env.PGPASSWORD, '[redacted]'), detail: error.detail, where: error.where };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
  const output = path.join(root, 'docs/database/checks');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'educational-deployment.json'), JSON.stringify(report, null, 2) + '\n');
}
