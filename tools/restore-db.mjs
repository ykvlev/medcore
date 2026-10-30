// Восстановление резервной копии MEDCORE ТОЛЬКО в явно указанную тестовую БД.
// Скрипт отказывается писать в рабочую БД из .env, требует отдельное имя базы,
// проверяет SHA-256 копии, отсутствие объектов project/space_archive в цели и
// после восстановления сверяет строки, представления и процедуры.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectSchema = 'project';
const archiveSchema = 'space_archive';
const keyTables = [
  'medical_organizations', 'departments', 'beds', 'employees', 'doctors',
  'patients', 'medical_cases', 'appointments', 'hospitalizations', 'bed_occupancies'
];
const expectedViews = ['vw_hospital_capacity', 'vw_doctor_statistics', 'vw_patient_treatment_summary'];
const expectedProcedures = ['sp_register_patient', 'sp_update_patient', 'sp_delete_patient_draft', 'sp_get_patient_summary'];
const forbiddenDatabases = new Set(['postgres', 'template0', 'template1']);
const databaseNamePattern = /^[a-z][a-z0-9_]{2,62}$/;

function usage() {
  console.log(`Восстановление резервной копии MEDCORE в тестовую БД

Использование:
  node tools/restore-db.mjs --database=<тестовая_бд> [--dump=<файл.dump>] [параметры]

Обязательный параметр:
  --database=<имя>   отдельная тестовая БД. Рабочая БД из PGDATABASE запрещена.

Параметры:
  --dump=<файл>      файл копии (по умолчанию последняя копия в backups/);
  --create           создать тестовую БД, если её нет и роль имеет право CREATEDB;
  --report=<файл>    записать JSON-отчёт (например, docs/database/checks/backup-restore.json);
  --help             эта справка.

Скрипт не удаляет и не перезаписывает объекты: если в целевой БД уже есть
схемы project или space_archive, восстановление отклоняется.`);
}

async function loadEnvFile(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
}

function redact(text) {
  let result = String(text ?? '');
  const secret = process.env.PGPASSWORD;
  if (secret && secret.length >= 3) result = result.replaceAll(secret, '[redacted]');
  return result;
}

function connectionConfig(database) {
  return {
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    database,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
    application_name: 'medcore-restore',
    connectionTimeoutMillis: 12000,
    statement_timeout: 60000
  };
}

function versionOf(output) {
  return String(output ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)[0] ?? null;
}

function probeExecutable(candidate) {
  const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) return null;
  return versionOf(result.stdout || result.stderr);
}

async function standardCandidates(executable) {
  const dirs = [];
  if (process.platform === 'win32') {
    const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]
      .filter(Boolean);
    for (const base of bases) {
      try {
        const entries = await readdir(path.join(base, 'PostgreSQL'), { withFileTypes: true });
        const versions = entries.filter(entry => entry.isDirectory() && /^\d+/.test(entry.name))
          .map(entry => entry.name)
          .sort((a, b) => Number.parseFloat(b) - Number.parseFloat(a));
        for (const version of versions) dirs.push(path.join(base, 'PostgreSQL', version, 'bin', executable + '.exe'));
      } catch { /* каталога нет */ }
    }
  } else {
    for (const base of ['/usr/lib/postgresql', '/opt/homebrew/opt', '/usr/local/opt']) {
      try {
        const entries = await readdir(base, { withFileTypes: true });
        const versions = entries.filter(entry => entry.isDirectory() && /^postgresql/i.test(entry.name))
          .map(entry => entry.name)
          .sort()
          .reverse();
        for (const version of versions) dirs.push(path.join(base, version, 'bin', executable));
      } catch { /* каталога нет */ }
    }
    dirs.push('/usr/bin/' + executable, '/usr/local/bin/' + executable, '/opt/homebrew/bin/' + executable);
  }
  return dirs;
}

async function discoverExecutable(executable, explicitEnv) {
  const explicit = process.env[explicitEnv];
  if (explicit) {
    const version = probeExecutable(explicit);
    if (!version) throw new Error(`${explicitEnv} указывает на ${explicit}, но запуск ${executable} не удался`);
    return { path: explicit, version, onPath: false, foundVia: explicitEnv };
  }
  const onPathVersion = probeExecutable(executable);
  if (onPathVersion) return { path: executable, version: onPathVersion, onPath: true, foundVia: 'PATH' };
  for (const candidate of await standardCandidates(executable)) {
    try { await access(candidate); } catch { continue; }
    const version = probeExecutable(candidate);
    if (version) return { path: candidate, version, onPath: false, foundVia: 'standard-install-path' };
  }
  return null;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

function parseArgs(argv) {
  const options = { database: null, dump: null, create: false, report: null };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--create') { options.create = true; continue; }
    const database = arg.match(/^--database=(.*)$/);
    if (database) { options.database = database[1].trim(); continue; }
    const dump = arg.match(/^--dump=(.+)$/);
    if (dump) { options.dump = dump[1].trim(); continue; }
    const report = arg.match(/^--report=(.+)$/);
    if (report) { options.report = report[1].trim(); continue; }
    throw new Error('Неизвестный или неверный аргумент: ' + arg);
  }
  return options;
}

async function latestDump(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch { return null; }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.dump')) continue;
    const full = path.join(directory, entry.name);
    files.push({ full, mtime: (await stat(full)).mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0]?.full ?? null;
}

async function writeReport(report, options) {
  if (!options.report) return;
  const target = path.resolve(root, options.report);
  await mkdir(path.dirname(target), { recursive: true });
  report.finishedAt = new Date().toISOString();
  await writeFile(target, JSON.stringify(report, null, 2) + '\n');
}

// ---------- основная работа ----------

const options = { database: null, dump: null, create: false, report: null };
const report = {
  checkedAt: new Date().toISOString(),
  result: 'pending',
  purpose: 'Проверка резервного копирования и восстановления MEDCORE в отдельную тестовую БД',
  safety: {},
  environment: {},
  backup: {},
  restore: { attempted: false, databaseCreatedByScript: false },
  verification: null,
  limitations: [],
  errors: []
};

let exitCode = 0;
let reportOptions = options;
try {
  Object.assign(options, parseArgs(process.argv.slice(2)));
  if (options.help) { usage(); process.exit(0); }
  await loadEnvFile(path.join(root, '.env'));
  reportOptions = options;
  report.safety.targetDatabase = options.database ?? null;
  report.safety.allowCreate = options.create;

  if (!process.env.PGPASSWORD)
    throw new Error('PGPASSWORD не задан. Скрипт не запрашивает пароль интерактивно.');
  if (!process.env.PGDATABASE)
    throw new Error('PGDATABASE не задан: невозможно проверить, что цель не является рабочей БД.');
  const workingDatabase = process.env.PGDATABASE;
  report.safety.workingDatabase = workingDatabase;

  if (!options.database)
    throw new Error('Не указана тестовая БД. Обязателен явный параметр --database=<имя>. ' +
      'Восстановление в рабочую БД запрещено.');
  const target = options.database;
  report.safety.targetNameValid = databaseNamePattern.test(target);
  if (!report.safety.targetNameValid) {
    report.result = 'refused';
    throw new Error('Недопустимое имя тестовой БД. Разрешены строчные латинские буквы, цифры и подчёркивание, от 3 до 63 символов.');
  }
  if (forbiddenDatabases.has(target)) {
    report.result = 'refused';
    throw new Error(`База "${target}" является служебной и не может использоваться для восстановления.`);
  }
  if (target.toLowerCase() === workingDatabase.toLowerCase()) {
    report.safety.targetIsWorkingDatabase = true;
    report.result = 'refused';
    throw new Error(`Отказано: "${target}" совпадает с рабочей БД из .env. ` +
      'Восстановление выполняется только в отдельную тестовую БД.');
  }
  report.safety.targetIsWorkingDatabase = false;

  const dumpPath = options.dump ? path.resolve(root, options.dump) : await latestDump(path.join(root, 'backups'));
  if (!dumpPath)
    throw new Error('Резервная копия не найдена: укажите --dump=<файл> или создайте копию tools/backup-db.mjs.');
  report.backup.file = path.relative(root, dumpPath).split(path.sep).join('/');
  const dumpInfo = await stat(dumpPath);
  report.backup.bytes = dumpInfo.size;

  const manifestPath = /\.dump$/.test(dumpPath) ? dumpPath.replace(/\.dump$/, '.manifest.json') : dumpPath + '.manifest.json';
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    report.backup.manifest = path.relative(root, manifestPath).split(path.sep).join('/');
  } catch {
    report.limitations.push('Манифест копии не найден: целостность по SHA-256 не подтверждена, ожидаемые количества строк неизвестны.');
  }

  const actualSha256 = await sha256File(dumpPath);
  report.backup.sha256 = actualSha256;
  if (manifest) {
    if (manifest.file && path.basename(manifest.file) !== path.basename(dumpPath))
      throw new Error('Манифест относится к другому файлу копии.');
    if (Number.isFinite(manifest.bytes) && manifest.bytes !== dumpInfo.size)
      throw new Error(`Размер копии ${dumpInfo.size} байт не совпадает с манифестом (${manifest.bytes}).`);
    if (manifest.sha256 && manifest.sha256 !== actualSha256)
      throw new Error('SHA-256 копии не совпадает с манифестом. Восстановление остановлено.');
    report.backup.integrity = 'verified';
    report.backup.createdAt = manifest.createdAt;
    report.backup.schemas = manifest.schemas;
    report.backup.postgresVersion = manifest.postgresVersion;
    report.backup.pgDumpVersion = manifest.pgDumpVersion;
    report.backup.pgDumpOnPath = manifest.pgDumpOnPath;
    report.backup.pgDumpPath = manifest.pgDumpPath;
    report.backup.objects = manifest.objects;
    report.backup.keyTableRows = manifest.keyTableRows;
    report.environment.pgDump = {
      available: true, onPath: Boolean(manifest.pgDumpOnPath),
      foundVia: manifest.pgDumpOnPath ? 'PATH' : 'standard-install-path',
      path: manifest.pgDumpPath, version: manifest.pgDumpVersion
    };
  } else {
    report.backup.integrity = 'unverified';
  }

  const restoreTool = await discoverExecutable('pg_restore', 'PG_RESTORE');
  if (!restoreTool)
    throw new Error('pg_restore не найден ни в PATH, ни в стандартных каталогах PostgreSQL. ' +
      'Установите клиент PostgreSQL или задайте PG_RESTORE=<полный путь>.');
  report.environment.pgRestore = { available: true, onPath: restoreTool.onPath, path: restoreTool.path, version: restoreTool.version };

  // Архив должен читаться pg_restore ещё до попытки записи в БД.
  const toc = spawnSync(restoreTool.path, ['--list', dumpPath], {
    encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' }, timeout: 120000, maxBuffer: 16 * 1024 * 1024
  });
  if (toc.status !== 0) {
    const detail = redact((toc.stderr || '').trim()).split(/\r?\n/).slice(-4).join('\n');
    throw new Error(`Копия не читается pg_restore (код ${toc.status}). ${detail}`);
  }
  const tocLines = (toc.stdout || '').split(/\r?\n/);
  const tocTableData = tocLines.filter(line => line.includes('TABLE DATA')).length;
  report.backup.toc = {
    readable: true,
    entries: tocLines.filter(line => /^\d+;/.test(line)).length,
    tableDataEntries: tocTableData
  };

  // Сведения о рабочем сервере и роли — только чтение.
  const admin = new Client(connectionConfig(workingDatabase));
  try {
    await admin.connect();
    const identity = (await admin.query(`SELECT current_database() AS database, current_user AS username,
      current_setting('server_version') AS version,
      (SELECT rolcreatedb FROM pg_roles WHERE rolname = current_user) AS can_create_database,
      (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser`)).rows[0];
    const ssl = (await admin.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0];
    report.environment.workingServer = {
      database: identity.database, username: identity.username, version: identity.version,
      ssl: Boolean(ssl?.ssl), canCreateDatabase: Boolean(identity.can_create_database), isSuperuser: Boolean(identity.is_superuser)
    };
    if (identity.username !== process.env.PGUSER)
      throw new Error('Подключение выполнено не под той ролью, что указана в PGUSER.');
  } finally {
    await admin.end().catch(() => {});
  }

  // Подключение к целевой БД: существование, права, пустота.
  let targetClient = new Client(connectionConfig(target));
  let targetExisted = true;
  try {
    await targetClient.connect();
  } catch (error) {
    await targetClient.end().catch(() => {});
    if (error.code === '3D000') targetExisted = false;
    else if (error.code === '42501') {
      report.result = 'blocked';
      throw new Error(`Нет права подключения к тестовой БД "${target}" (SQLSTATE 42501). ` +
        'Обратитесь к администратору сервера.');
    } else throw error;
  }
  report.safety.targetExisted = targetExisted;

  if (!targetExisted) {
    if (!options.create) {
      report.result = 'blocked';
      throw new Error(`Тестовая БД "${target}" не существует. Создайте её администратором сервера ` +
        `(CREATE DATABASE "${target}";) или повторите с флагом --create.`);
    }
    const creator = new Client(connectionConfig(workingDatabase));
    try {
      await creator.connect();
      await creator.query(`CREATE DATABASE "${target}"`);
      report.restore.databaseCreatedByScript = true;
    } catch (error) {
      report.result = 'blocked';
      if (error.code === '42501') {
        throw new Error('Роль БД не имеет права CREATE DATABASE (SQLSTATE 42501), поэтому отдельную ' +
          `тестовую БД "${target}" создать нельзя. Требуется администратор сервера: CREATE DATABASE "${target}"; ` +
          'после этого повторите восстановление с тем же --database.');
      }
      throw error;
    } finally {
      await creator.end().catch(() => {});
    }
    targetClient = new Client(connectionConfig(target));
    await targetClient.connect();
  }

  const existing = (await targetClient.query(`SELECT n.nspname AS schema, count(c.oid)::int AS objects
    FROM pg_namespace n LEFT JOIN pg_class c ON c.relnamespace = n.oid
    WHERE n.nspname IN ('project', 'space_archive') GROUP BY n.nspname ORDER BY n.nspname`)).rows;
  report.safety.existingObjects = existing;
  if (existing.length > 0) {
    report.result = 'refused';
    throw new Error(`В тестовой БД "${target}" уже есть схемы project/space_archive. ` +
      'Восстановление поверх существующих объектов не выполняется: укажите другую тестовую БД.');
  }

  report.restore.targetDatabase = target;
  report.restore.tool = restoreTool.version;
  report.restore.attempted = true;
  const startedAt = Date.now();
  const restore = spawnSync(restoreTool.path, [
    '--host=' + (process.env.PGHOST || 'localhost'),
    '--port=' + (process.env.PGPORT || '5432'),
    '--username=' + process.env.PGUSER,
    '--dbname=' + target,
    '--no-owner',
    '--no-privileges',
    '--single-transaction',
    '--exit-on-error',
    '--no-password',
    dumpPath
  ], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    timeout: 30 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024
  });
  report.restore.durationMs = Date.now() - startedAt;
  report.restore.pgRestoreExitCode = restore.status;
  const restoreWarnings = (restore.stderr || '').split(/\r?\n/).filter(line => /warning:/i.test(line));
  report.restore.warnings = restoreWarnings.length;
  report.restore.warningSample = restoreWarnings.slice(0, 5).map(line => redact(line));
  if (restore.error) throw new Error('Не удалось запустить pg_restore: ' + redact(restore.error.message));
  if (restore.status !== 0) {
    const detail = redact((restore.stderr || '').trim()).split(/\r?\n/).slice(-8).join('\n');
    throw new Error(`pg_restore завершился с кодом ${restore.status}. ${detail}`);
  }
  await targetClient.end().catch(() => {});

  // Сверка восстановленной БД.
  const verify = new Client(connectionConfig(target));
  const verification = { errors: [], keyTables: [], views: [], procedures: [], objects: null, extensions: [] };
  try {
    await verify.connect();
    await verify.query('BEGIN READ ONLY');
    const counts = await verify.query(`SELECT ${keyTables.map((table, index) =>
      `(SELECT count(*) FROM project.${table})::bigint AS t${index}`).join(', ')}`);
    const expectedRows = manifest?.keyTableRows ?? {};
    for (const [index, table] of keyTables.entries()) {
      const actual = Number(counts.rows[0]['t' + index]);
      const expected = Number.isFinite(expectedRows[table]) ? Number(expectedRows[table]) : null;
      const match = expected === null ? null : actual === expected;
      verification.keyTables.push({ table, expected, actual, match });
      if (match === false) verification.errors.push(`Количество строк не совпало: ${table} ожидалось ${expected}, получено ${actual}`);
    }

    const objects = (await verify.query(`SELECT
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'project' AND c.relkind = 'r')::int AS tables,
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'project' AND c.relkind = 'v')::int AS views,
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'project' AND p.prokind = 'p')::int AS procedures,
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'project' AND p.prokind = 'f')::int AS functions`)).rows[0];
    verification.objects = objects;
    const expectedObjects = manifest?.objects ?? { tables: 48, views: 3, procedures: 4, functions: 11 };
    for (const kind of ['tables', 'views', 'procedures', 'functions']) {
      if (expectedObjects[kind] !== undefined && Number(objects[kind]) !== Number(expectedObjects[kind]))
        verification.errors.push(`Количество объектов "${kind}" не совпало: ожидалось ${expectedObjects[kind]}, получено ${objects[kind]}`);
    }

    const viewRows = (await verify.query(`SELECT c.relname AS name FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'project' AND c.relkind = 'v' AND c.relname = ANY($1::text[])
      ORDER BY c.relname`, [expectedViews])).rows.map(row => row.name);
    verification.views = expectedViews.map(name => ({ name, present: viewRows.includes(name) }));
    for (const view of verification.views) if (!view.present) verification.errors.push(`Представление не найдено: project.${view.name}`);

    const procedureRows = (await verify.query(`SELECT p.proname AS name FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'project' AND p.prokind = 'p' AND p.proname = ANY($1::text[])
      ORDER BY p.proname`, [expectedProcedures])).rows.map(row => row.name);
    verification.procedures = expectedProcedures.map(name => ({ name, present: procedureRows.includes(name) }));
    for (const procedure of verification.procedures)
      if (!procedure.present) verification.errors.push(`Процедура не найдена: project.${procedure.name}`);

    verification.extensions = (await verify.query(`SELECT extname FROM pg_extension
      WHERE extname IN ('btree_gist', 'pg_trgm') ORDER BY extname`)).rows.map(row => row.extname);
    for (const extension of ['btree_gist', 'pg_trgm'])
      if (!verification.extensions.includes(extension)) verification.errors.push(`Расширение не установлено: ${extension}`);

    await verify.query('ROLLBACK');
    report.verification = verification;
  } finally {
    await verify.end().catch(() => {});
  }

  if (verification.errors.length > 0) {
    report.result = 'failed';
    throw new Error('Сверка восстановленной БД выявила расхождения: ' + verification.errors.join('; '));
  }
  report.result = 'passed';
  console.log('Восстановление в тестовую БД выполнено и проверено.');
  console.log('Копия: ' + report.backup.file + ' (SHA-256 подтверждён)');
  console.log('Тестовая БД: ' + target);
  console.log('Ключевые таблицы: 10 из 10 совпали с манифестом');
  console.log('Представления: 3 из 3; процедуры: 4 из 4; строк/объектов по манифесту — совпадают.');
} catch (error) {
  if (report.result === 'pending') report.result = 'failed';
  report.errors.push(redact(error.message));
  console.error('ОШИБКА: ' + redact(error.message));
  if (!report.restore.attempted) {
    report.limitations.push('Восстановление в тестовую БД не выполнялось, поэтому сверка строк, представлений и процедур после восстановления отсутствует.');
    report.limitations.push('Проверены целостность копии по SHA-256 и читаемость архива pg_restore; применение SQL к серверу не проверено.');
    if (report.result === 'blocked') report.limitations.push('Ограничение среды: отдельная тестовая БД не создана (нет права CREATEDB либо не указан --create).');
  }
  exitCode = 1;
} finally {
  try { await writeReport(report, reportOptions); }
  catch (error) { console.error('Не удалось записать отчёт: ' + redact(error.message)); exitCode = 1; }
}
process.exit(exitCode);
