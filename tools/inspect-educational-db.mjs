import { Client } from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));
const client = new Client({
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
  connectionTimeoutMillis: 12000,
  statement_timeout: 10000,
  application_name: 'medcore-read-only-inspection',
});
const report = { inspectedAt: new Date().toISOString(), mode: 'read-only', result: 'pending' };
try {
  await client.connect();
  await client.query('BEGIN READ ONLY');
  report.server = (await client.query(`SELECT current_database() AS database,
    current_user AS username, current_setting('server_version') AS version,
    current_setting('server_encoding') AS encoding,
    has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_schema`)).rows[0];
  report.ssl = (await client.query('SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0];
  report.role = (await client.query('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = current_user')).rows[0];
  report.schemas = (await client.query(`SELECT n.nspname AS name, pg_get_userbyid(n.nspowner) AS owner,
    has_schema_privilege(current_user, n.oid, 'CREATE') AS can_create
    FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
    ORDER BY n.nspname`)).rows;
  report.objects = (await client.query(`SELECT table_schema, table_name, table_type
    FROM information_schema.tables
    WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
    ORDER BY table_schema, table_name LIMIT 200`)).rows;
  report.extensions = (await client.query(`SELECT name, default_version, installed_version
    FROM pg_available_extensions WHERE name IN ('btree_gist', 'pg_trgm') ORDER BY name`)).rows;
  await client.query('ROLLBACK');
  report.result = 'passed';
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.result = 'failed';
  report.error = { code: error.code, message: String(error.message).replaceAll(process.env.PGPASSWORD, '[redacted]') };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
  const outputDir = path.join(root, 'docs/database/checks');
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'educational-inspection.json'), JSON.stringify(report, null, 2) + '\n');
}
