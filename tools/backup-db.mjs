// Резервное копирование схемы project учебной БД MEDCORE.
// Схема space_archive копируется только по явному флагу --include-archive.
// Пароль берётся из PGPASSWORD (.env или окружение) и никогда не печатается.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectSchema = 'project';
const archiveSchema = 'space_archive';
const extensions = ['btree_gist', 'pg_trgm'];
// Устойчивые предметные таблицы: их количество не меняется от входов в систему и аудита.
const keyTables = [
  'medical_organizations', 'departments', 'beds', 'employees', 'doctors',
  'patients', 'medical_cases', 'appointments', 'hospitalizations', 'bed_occupancies'
];

function fail(message, code = 1) {
  console.error('ОШИБКА: ' + message);
  process.exitCode = code;
}

function usage() {
  console.log(`Резервное копирование MEDCORE (схема project)

Использование:
  node tools/backup-db.mjs [--include-archive] [--out-dir=<каталог>] [--label=<метка>]

Параметры:
  --include-archive   дополнительно скопировать схему space_archive;
  --out-dir=<каталог> каталог для файлов (по умолчанию backups/);
  --label=<метка>     дополнительная метка в имени файла (буквы, цифры, дефис).

Подключение берётся из .env или переменных PGHOST, PGPORT, PGDATABASE,
PGUSER, PGPASSWORD, PGSSLMODE. Пароль не запрашивается и не выводится.
pg_dump ищется в PATH и в стандартных каталогах установки PostgreSQL;
явный путь можно задать переменной PG_DUMP.`);
}

// ---------- окружение и секреты ----------

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
    // Явно заданная переменная окружения важнее значения из .env.
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
    database: database ?? process.env.PGDATABASE,
    ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
    application_name: 'medcore-backup',
    connectionTimeoutMillis: 12000,
    statement_timeout: 30000
  };
}

// ---------- поиск pg_dump ----------

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

// ---------- вспомогательные запросы ----------

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

function stamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function parseArgs(argv) {
  const options = { includeArchive: false, outDir: 'backups', label: null };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (arg === '--include-archive') { options.includeArchive = true; continue; }
    const outDir = arg.match(/^--out-dir=(.+)$/);
    if (outDir) { options.outDir = outDir[1]; continue; }
    const label = arg.match(/^--label=([A-Za-z0-9_-]{1,40})$/);
    if (label) { options.label = label[1]; continue; }
    throw new Error('Неизвестный или неверный аргумент: ' + arg);
  }
  return options;
}

// ---------- основная работа ----------

let exitCode = 0;
try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { usage(); process.exit(0); }
  await loadEnvFile(path.join(root, '.env'));

  if (!process.env.PGPASSWORD)
    throw new Error('PGPASSWORD не задан. Скрипт не запрашивает пароль интерактивно: укажите PGPASSWORD в .env или в окружении.');
  if (!process.env.PGDATABASE)
    throw new Error('PGDATABASE не задан: неизвестна рабочая база для копирования.');

  const dumpTool = await discoverExecutable('pg_dump', 'PG_DUMP');
  if (!dumpTool) {
    throw new Error('pg_dump не найден ни в PATH, ни в стандартных каталогах PostgreSQL. ' +
      'Установите клиент PostgreSQL или задайте PG_DUMP=<полный путь к pg_dump>. Резервная копия не создана.');
  }
  if (!dumpTool.onPath)
    console.error(`Внимание: pg_dump отсутствует в PATH, используется ${dumpTool.path}`);

  const outDir = path.resolve(root, options.outDir);
  await mkdir(outDir, { recursive: true });

  const now = new Date();
  const baseName = ['medcore', projectSchema, options.includeArchive ? 'with-archive' : 'only', options.label, stamp(now)]
    .filter(Boolean).join('_');
  const finalFile = path.join(outDir, baseName + '.dump');
  const manifestFile = path.join(outDir, baseName + '.manifest.json');
  const tempFile = finalFile + '.partial';
  const schemas = options.includeArchive ? [projectSchema, archiveSchema] : [projectSchema];

  // Сведения о сервере и контрольные количества строк — до копирования.
  const client = new Client(connectionConfig());
  let server = null;
  let objects = null;
  let keyTableRows = {};
  try {
    await client.connect();
    const identity = (await client.query(`SELECT current_database() AS database, current_user AS username,
      current_setting('server_version') AS version, version() AS version_full`)).rows[0];
    server = {
      database: identity.database,
      username: identity.username,
      version: identity.version,
      versionFull: identity.version_full
    };
    if (identity.database !== process.env.PGDATABASE)
      throw new Error('Подключение выполнено не к той базе, что указана в PGDATABASE.');
    objects = (await client.query(`SELECT
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'project' AND c.relkind = 'r')::int AS tables,
        (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'project' AND c.relkind = 'v')::int AS views,
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'project' AND p.prokind = 'p')::int AS procedures,
        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'project' AND p.prokind = 'f')::int AS functions`)).rows[0];
    const counts = await client.query(`SELECT ${keyTables.map((table, index) =>
      `(SELECT count(*) FROM project.${table})::bigint AS t${index}`).join(', ')}`);
    keyTableRows = Object.fromEntries(keyTables.map((table, index) => [table, Number(counts.rows[0]['t' + index])]));
  } finally {
    await client.end().catch(() => {});
  }

  const args = [
    '--host=' + (process.env.PGHOST || 'localhost'),
    '--port=' + (process.env.PGPORT || '5432'),
    '--username=' + process.env.PGUSER,
    '--dbname=' + process.env.PGDATABASE,
    '--format=custom',
    '--file=' + tempFile,
    '--no-password',
    '--lock-wait-timeout=20s',
    ...schemas.map(schema => '--schema=' + schema),
    ...extensions.map(extension => '--extension=' + extension)
  ];
  const startedAt = Date.now();
  const dump = spawnSync(dumpTool.path, args, {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
    timeout: 15 * 60 * 1000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (dump.error) throw new Error('Не удалось запустить pg_dump: ' + redact(dump.error.message));
  if (dump.status !== 0) {
    await unlink(tempFile).catch(() => {});
    const detail = redact((dump.stderr || '').trim()).split(/\r?\n/).slice(-6).join('\n');
    throw new Error(`pg_dump завершился с кодом ${dump.status}. ${detail}`);
  }

  await rename(tempFile, finalFile);
  const info = await stat(finalFile);
  if (info.size === 0) {
    await unlink(finalFile).catch(() => {});
    throw new Error('pg_dump создал пустой файл; копия непригодна.');
  }
  const sha256 = await sha256File(finalFile);
  const warningLines = (dump.stderr || '').split(/\r?\n/).filter(line => /warning:/i.test(line));

  const manifest = {
    manifestVersion: 1,
    createdAt: new Date().toISOString(),
    file: path.relative(root, finalFile).split(path.sep).join('/'),
    bytes: info.size,
    sha256,
    format: 'custom',
    database: server.database,
    username: server.username,
    schemas,
    postgresVersion: server.version,
    postgresVersionFull: server.versionFull,
    pgDumpVersion: dumpTool.version,
    pgDumpPath: dumpTool.path,
    pgDumpOnPath: dumpTool.onPath,
    includesExtensions: extensions,
    objects,
    keyTableRows,
    durationMs: Date.now() - startedAt,
    pgDumpWarnings: warningLines.length,
    restoreCommand: `node tools/restore-db.mjs --dump=${path.relative(root, finalFile).split(path.sep).join('/')} --database=<тестовая_бд> --create`
  };
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2) + '\n');

  console.log('Резервная копия создана.');
  console.log('Файл: ' + manifest.file);
  console.log('Манифест: ' + path.relative(root, manifestFile).split(path.sep).join('/'));
  console.log('Размер: ' + info.size + ' байт');
  console.log('SHA-256: ' + sha256);
  console.log('Схемы: ' + schemas.join(', '));
  console.log('PostgreSQL: ' + server.version + '; pg_dump: ' + dumpTool.version);
  console.log('Объекты project: таблиц ' + objects.tables + ', представлений ' + objects.views +
    ', процедур ' + objects.procedures + ', функций ' + objects.functions);
  console.log('Строк в ключевых таблицах: ' +
    keyTables.map(table => `${table}=${keyTableRows[table]}`).join(', '));
  if (warningLines.length)
    console.log('Предупреждений pg_dump: ' + warningLines.length + ' (циклические зависимости схемы; копия создана).');
} catch (error) {
  fail(redact(error.message), 1);
  exitCode = 1;
}
process.exit(exitCode);
