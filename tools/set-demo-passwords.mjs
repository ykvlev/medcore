// Устанавливает единый простой демонстрационный пароль всем учебным учётным
// записям. Использование:
//   TARGET_DATABASE_URL=postgresql://... NEW_DEMO_PASSWORD=medcore node tools/set-demo-passwords.mjs
// Пароли не печатаются; в отчёт попадает только список логинов и результат.
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes, pbkdf2Sync } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }

const url = process.env.TARGET_DATABASE_URL;
// Без явной цели используется учебная база из PG*-переменных локального .env.
const connection = url
  ? { connectionString: url, ssl: /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false } }
  : {
      host: process.env.PGHOST, port: Number(process.env.PGPORT ?? 5432), database: process.env.PGDATABASE,
      user: process.env.PGUSER, password: process.env.PGPASSWORD,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true }
    };
const password = process.env.NEW_DEMO_PASSWORD ?? 'medcore';
if (password.length < 5) throw new Error('Слишком короткий пароль для учебной демонстрации');

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

const logins = ['admin', 'manager', 'chief', 'deputy', 'head', 'doctor', 'registrar', 'lab', 'analyst', 'minister', 'governor'];
const client = new Client({
  ...connection,
  connectionTimeoutMillis: 15000,
  statement_timeout: 30000
});
try {
  await client.connect();
  const hash = identityV3Hash(password);
  const updated = await client.query(
    'UPDATE project.users SET password_hash = $1 WHERE login = ANY($2) RETURNING login',
    [hash, logins]
  );
  const rows = await client.query('SELECT login FROM project.users ORDER BY login');
  console.log('обновлено:', updated.rows.map(r => r.login).sort().join(', '));
  console.log('всего учётных записей:', rows.rows.length);
  console.log('пароль изменён для всех демонстрационных ролей');
} catch (error) {
  console.error('ошибка:', error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
