// Подготовка внешней демонстрационной базы PostgreSQL: миграции, демонстрационный
// набор, роли и справочник МКБ-10. Использование:
//   DATABASE_URL=postgresql://... MEDCORE_DEMO_PASSWORD=... node tools/bootstrap-public-db.mjs
// Порядок важен: 004 добавляет учётные записи и опирается на демонстрационные
// данные (администратор и больница), поэтому сначала загружается seed.
import { readFile } from 'node:fs/promises';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }

// Основная переменная — DATABASE_URL; PUBLIC_DATABASE_URL позволяет указать
// отдельную цель (например, туннель к серверу) поверх локального .env.
const url = process.env.PUBLIC_DATABASE_URL ?? process.env.DATABASE_URL;
if (!url) throw new Error('Задайте DATABASE_URL внешней базы PostgreSQL');
const password = process.env.MEDCORE_DEMO_PASSWORD;
if (!password || password.length < 12) throw new Error('Задайте MEDCORE_DEMO_PASSWORD (не короче 12 символов)');

function identityV3Hash(value) {
  const salt = randomBytes(16);
  const iterations = 210000;
  const subkey = pbkdf2Sync(value, salt, iterations, 32, 'sha512');
  const header = Buffer.alloc(13);
  header[0] = 0x01;
  header.writeUInt32BE(2, 1); // HMACSHA512
  header.writeUInt32BE(iterations, 5);
  header.writeUInt32BE(salt.length, 9);
  return Buffer.concat([header, salt, subkey]).toString('base64');
}

async function body(relative) {
  const sql = await readFile(path.join(root, relative), 'utf8');
  return sql.replace(/^\uFEFF/, '').replace(/^BEGIN;\s*$/gm, '').replace(/^COMMIT;\s*$/gm, '');
}

const client = new Client({
  connectionString: url,
  ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
  statement_timeout: 300000,
  application_name: 'medcore-public-bootstrap'
});
try {
  await client.connect();
  const existing = await client.query(`SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'project' AND table_type = 'BASE TABLE'`);
  if (existing.rows[0].n > 0) throw new Error('В схеме project уже есть таблицы: база не пустая, развёртывание остановлено');

  // Схема и демонстрационный набор — одной транзакцией: seed читает парольный
  // хеш из transaction-local настройки, как и задумано в demo.sql.
  await client.query('BEGIN');
  for (const file of ['001_initial_schema.sql', '002_business_rules.sql', '003_stored_objects.sql']) {
    await client.query(await body(`database/migrations/${file}`));
  }
  await client.query("SELECT set_config('medcore.seed_password_hash', $1, true)", [identityV3Hash(password)]);
  await client.query(await body('database/seeds/demo.sql'));
  await client.query('COMMIT');
  console.log('ok схема и демонстрационный набор');

  for (const file of ['004_roles_icd.sql', '005_specialties.sql', '006_icd_chapters.sql']) {
    await client.query('BEGIN');
    await client.query(await body(`database/migrations/${file}`));
    await client.query('COMMIT');
    console.log(`ok ${file}`);
  }

  const summary = await client.query(`SELECT
      (SELECT count(*)::int FROM project.medical_organizations) AS organizations,
      (SELECT count(*)::int FROM project.patients) AS patients,
      (SELECT count(*)::int FROM project.hospitalizations) AS hospitalizations,
      (SELECT count(*)::int FROM project.diagnoses WHERE chapter IS NOT NULL) AS icd_codes,
      (SELECT count(*)::int FROM project.roles) AS roles,
      (SELECT count(*)::int FROM project.users) AS users`);
  console.log('готово:', JSON.stringify(summary.rows[0]));
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('ошибка:', error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
