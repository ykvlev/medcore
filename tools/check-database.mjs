import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = {
  checkedAt: new Date().toISOString(),
  engine: 'PGlite 0.3.14 (isolated embedded PostgreSQL, not a multi-user server)',
  migrations: [],
  checks: [],
  limitations: ['Network connections, PostgreSQL roles, concurrent sessions and production performance are not tested here.'],
};
const pg = new PGlite({ extensions: { btree_gist, pg_trgm } });
let failed = false;
try {
  const version = await pg.query('SELECT version() AS version');
  report.postgresqlVersion = version.rows[0].version;
  const files = (await readdir(path.join(root, 'database/migrations'))).filter(f => f.endsWith('.sql')).sort();
  // 004 добавляет демонстрационные учётные записи и требует уже загруженного
  // демонстрационного набора (администратор и больница). В пустой PGlite она
  // пропускается; на учебном сервере применяется и проверяется отдельно.
  const requiresDemoData = new Set(['004_roles_icd.sql']);
  for (const file of files) {
    const sql = await readFile(path.join(root, 'database/migrations', file), 'utf8');
    try {
      await pg.exec(sql);
      report.migrations.push({ file, sha256: createHash('sha256').update(sql).digest('hex'), result: 'passed' });
      console.log(`PASS migration ${file}`);
    } catch (error) {
      if (requiresDemoData.has(file)) {
        report.migrations.push({
          file, result: 'skipped',
          reason: 'нужны демонстрационные данные (администратор и больница); проверяется на учебном сервере по docs/database/checks/004_roles_icd.json',
          message: error.message
        });
        console.log(`SKIP migration ${file} (requires demonstration data)`);
        // Файл начинается с BEGIN: после ошибки соединение остаётся в прерванной
        // транзакции, поэтому её нужно явно откатить перед следующей миграцией.
        await pg.exec('ROLLBACK').catch(() => {});
        continue;
      }
      report.migrations.push({ file, result: 'failed', message: error.message, code: error.code });
      throw error;
    }
  }
  const count = await pg.query("SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema = 'project' AND table_type = 'BASE TABLE'");
  report.checks.push({ name: 'schema created', result: 'passed', tableCount: count.rows[0].count });
  await pg.exec('SET search_path = project, public');
  const requiredQueries = await readFile(path.join(root, 'database/queries/required_queries.sql'), 'utf8');
  await pg.exec(requiredQueries);
  const executions = [
    "EXECUTE medcore_q01('Учебный', ARRAY[]::bigint[], 25, 0)",
    "EXECUTE medcore_q02('2026-10-30', ARRAY[]::bigint[])",
    'EXECUTE medcore_q03(ARRAY[]::bigint[])',
    "EXECUTE medcore_q04('2026-10-30', ARRAY[]::bigint[])",
    "EXECUTE medcore_q05(1, 2, '2026-10-30')",
    "EXECUTE medcore_q06('2026-01-01+03', '2027-01-01+03', ARRAY[]::bigint[])",
    'EXECUTE medcore_q07(80, ARRAY[]::bigint[])',
    'EXECUTE medcore_q08(1, ARRAY[]::bigint[])',
    "EXECUTE medcore_q09('2026-01-01+03', '2027-01-01+03', ARRAY[]::bigint[])",
    'EXECUTE medcore_q10(ARRAY[]::bigint[])',
    'EXECUTE medcore_q11(2026, ARRAY[]::bigint[])',
    "EXECUTE medcore_q12('2026-01-01+03', '2027-01-01+03', ARRAY[]::bigint[])",
  ];
  for (let i = 0; i < executions.length; i++) {
    await pg.exec(executions[i]);
    report.checks.push({ name: `Q${String(i + 1).padStart(2, '0')} compiles and executes on empty data`, result: 'passed' });
  }

  // Check actual constraint behavior without keeping any patient data.
  await pg.exec('BEGIN');
  await pg.exec("INSERT INTO patients(last_name, first_name, birth_date, sex) VALUES ('Учебный', 'Пациент', '2000-01-01', 'unknown')");
  report.checks.push({ name: 'patient insert with required fields', result: 'passed' });
  await pg.exec('ROLLBACK');

  async function expectRejection(name, sql, code) {
    await pg.exec('BEGIN');
    try {
      await pg.exec(sql);
      await pg.exec('COMMIT');
      throw new Error(`${name}: statement unexpectedly accepted`);
    } catch (error) {
      await pg.exec('ROLLBACK');
      if (error.code !== code) throw error;
      report.checks.push({ name, result: 'passed', expectedSqlState: code });
    }
  }
  await expectRejection('nonpositive bed capacity rejected', 'SELECT 0::positive_bed_count', '23514');
  await expectRejection('empty patient name rejected', "INSERT INTO patients(last_name, first_name, birth_date, sex) VALUES ('', 'Тест', '2000-01-01', 'unknown')", '23514');
  await expectRejection('attachment to missing patient rejected', "INSERT INTO patient_attachments(patient_id, polyclinic_id, started_at) VALUES (9999999, 9999999, now())", '23503');
  await expectRejection('unknown hospitalization status rejected', "SELECT 'invalid'::hospitalization_status", '22P02');

  const testDir = path.join(root, 'database/tests');
  let testFiles = [];
  try { testFiles = (await readdir(testDir)).filter(f => f.endsWith('.sql')).sort(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const file of testFiles) {
    const sql = await readFile(path.join(testDir, file), 'utf8');
    await pg.exec(sql);
    report.checks.push({ name: file, result: 'passed' });
    console.log(`PASS SQL checks ${file}`);
  }
} catch (error) {
  failed = true;
  report.error = { message: error.message, code: error.code, detail: error.detail, where: error.where };
  console.error(JSON.stringify(report.error));
} finally {
  await pg.close();
  report.result = failed ? 'failed' : 'passed';
  const reportDir = path.join(root, 'docs/database/checks');
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, 'pglite-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.result.toUpperCase()}: ${report.migrations.length} migrations, ${report.checks.length} checks`);
  process.exitCode = failed ? 1 : 0;
}
