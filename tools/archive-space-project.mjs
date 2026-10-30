import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));
const client = new Client({ ssl: false, connectionTimeoutMillis: 12000,
  statement_timeout: 30000, application_name: 'medcore-archive-space-project' });
const tableNames = ['agencies', 'launch_sites', 'launches', 'orbital_data', 'space_objects'];
const report = { performedAt: new Date().toISOString(), source: 'project', target: 'space_archive', result: 'pending' };
try {
  await client.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  const identity = (await client.query('SELECT current_database() AS database, current_user AS username')).rows[0];
  if (identity.database !== 'db_a_s_yakovlev' || identity.username !== 'a-s-yakovlev') throw new Error('Unexpected database identity');
  const owner = (await client.query("SELECT pg_get_userbyid(nspowner) = current_user AS owned FROM pg_namespace WHERE nspname = 'project'")).rows[0];
  if (!owner?.owned) throw new Error('Source schema is not owned by the expected user');
  const targetExists = (await client.query("SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname = 'space_archive') AS exists")).rows[0].exists;
  if (targetExists) throw new Error('Target archive schema already exists; refusing to overwrite or merge');
  const objects = (await client.query(`SELECT c.relname AS name, c.relkind AS kind FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'project'
    AND c.relkind IN ('r', 'p', 'v', 'm') ORDER BY c.relname`)).rows;
  const expected = [...tableNames.map(name => `${name}:r`), 'orbit_dashboard:v'].sort();
  if (JSON.stringify(objects.map(o => `${o.name}:${o.kind}`).sort()) !== JSON.stringify(expected)) throw new Error('Source objects differ from the inspected space project');
  report.before = {};
  for (const name of tableNames) {
    // Identifiers come exclusively from the fixed allowlist above.
    report.before[name] = (await client.query(`SELECT count(*)::text AS count FROM project."${name}"`)).rows[0].count;
  }
  await client.query('CREATE SCHEMA space_archive');
  for (const name of tableNames) await client.query(`ALTER TABLE project."${name}" SET SCHEMA space_archive`);
  await client.query('ALTER VIEW project.orbit_dashboard SET SCHEMA space_archive');
  report.after = {};
  for (const name of tableNames) {
    report.after[name] = (await client.query(`SELECT count(*)::text AS count FROM space_archive."${name}"`)).rows[0].count;
    if (report.before[name] !== report.after[name]) throw new Error(`Row count changed for ${name}`);
  }
  await client.query('SELECT * FROM space_archive.orbit_dashboard LIMIT 0');
  report.remainingProjectRelations = (await client.query(`SELECT c.relname AS name, c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'project' ORDER BY c.relname`)).rows;
  await client.query('COMMIT');
  report.result = 'passed';
  report.viewValid = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  report.result = 'failed';
  report.error = { code: error.code, message: String(error.message).replaceAll(process.env.PGPASSWORD, '[redacted]') };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
  const output = path.join(root, 'docs/database/checks');
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'space-archive-transfer.json'), JSON.stringify(report, null, 2) + '\n');
}
