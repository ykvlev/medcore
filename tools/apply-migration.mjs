// Применение одной SQL-миграции к учебной базе с отчётом и контрольной суммой.
// Использование: node tools/apply-migration.mjs database/migrations/004_roles_icd.sql
import { Client } from 'pg';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));
const relative = process.argv[2];
if (!relative) throw new Error('Укажите путь к файлу миграции');
const file = path.resolve(root, relative);
const sql = await readFile(file, 'utf8');
const digest = createHash('sha256').update(sql).digest('hex');
const report = { performedAt: new Date().toISOString(), file: relative, sha256: digest, result: 'pending' };
const client = new Client({
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
  connectionTimeoutMillis: 12000, statement_timeout: 120000, application_name: 'medcore-migration'
});
try {
  await client.connect();
  const identity = (await client.query('SELECT current_database() AS database, current_user AS username, version() AS version')).rows[0];
  report.database = identity.database;
  report.serverVersion = identity.version;
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '10s'");
  // Транзакционные обёртки файла убираются: транзакцией управляет скрипт.
  // BOM в начале файла PostgreSQL не принимает, поэтому он снимается.
  const body = sql.replace(/^\uFEFF/, '').replace(/^BEGIN;\s*$/gm, '').replace(/^COMMIT;\s*$/gm, '');
  await client.query(body);
  report.roles = (await client.query('SELECT code, name FROM project.roles ORDER BY code')).rows;
  report.diagnoses = (await client.query('SELECT count(*)::int AS total, count(*) FILTER (WHERE chapter IS NOT NULL)::int AS with_chapter FROM project.diagnoses')).rows[0];
  report.users = (await client.query('SELECT login FROM project.users ORDER BY login')).rows.map(r => r.login);
  report.scopes = (await client.query('SELECT count(*)::int AS total, count(*) FILTER (WHERE department_id IS NOT NULL)::int AS departments FROM project.user_organization_scopes')).rows[0];
  await client.query('COMMIT');
  report.result = 'passed';
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  report.result = 'failed';
  report.error = {
    code: error.code,
    message: String(error.message).replaceAll(process.env.PGPASSWORD ?? '', '[redacted]'),
    detail: error.detail, where: error.where, position: error.position
  };
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
  const output = path.join(root, 'docs/database/checks', `${path.basename(relative, '.sql')}.json`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
