// Замеры задержки read-эндпоинтов MEDCORE: p50/p95 по 10 запросам.
// Запуск: node tools/perf-check.mjs --label before|after [--base http://127.0.0.1:5180]
// Результат дописывается в docs/database/checks/perf-report.json под ключом label,
// поэтому before и after сохраняются в одном отчёте.
//
// Два демонстрационных пользователя: doctor (me, dashboard, patients, diagnoses)
// и manager (organizations, reports/occupancy). Пароль берётся из .env
// (MEDCORE_DEMO_PASSWORD) и не печатается.
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const label = argument('label', 'after');
if (!['before', 'after'].includes(label)) {
  console.error('Укажите --label before или --label after');
  process.exit(2);
}
const base = (argument('base', process.env.MEDCORE_API_URL ?? 'http://127.0.0.1:5180')).replace(/\/+$/, '');
const samples = Number(argument('samples', '10'));
const password = process.env.MEDCORE_DEMO_PASSWORD;
if (!password) {
  console.error('В .env отсутствует MEDCORE_DEMO_PASSWORD — замер невозможен.');
  process.exit(2);
}

const reportPath = path.join(root, 'docs/database/checks/perf-report.json');

// Роль выбрана так, чтобы эндпоинт был разрешён контрактом доступа.
const endpoints = [
  { key: 'auth/me', path: '/api/auth/me', user: 'doctor', target: null },
  { key: 'dashboard/summary', path: '/api/dashboard/summary', user: 'doctor', target: 700 },
  { key: 'patients?page=1', path: '/api/patients?page=1', user: 'doctor', target: 600 },
  { key: 'organizations?page=1', path: '/api/organizations?page=1', user: 'manager', target: 600 },
  { key: 'reports/occupancy', path: '/api/reports/occupancy', user: 'manager', target: 600 },
  { key: 'diagnoses?search=гип', path: `/api/diagnoses?search=${encodeURIComponent('гип')}`, user: 'doctor', target: 600 }
];

const sessions = new Map();

async function request(endpoint, { cookie, method = 'GET', body } = {}) {
  const started = performance.now();
  const response = await fetch(base + endpoint, {
    method,
    headers: {
      Accept: 'application/json',
      Origin: 'http://127.0.0.1:5173',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(90000)
  });
  const bytes = (await response.arrayBuffer()).byteLength;
  const elapsed = performance.now() - started;
  return { response, bytes, elapsed };
}

async function login(user) {
  const result = await request('/api/auth/login', {
    method: 'POST',
    body: { login: user, password }
  });
  if (result.response.status !== 200) {
    throw new Error(`Не удалось войти пользователем ${user}: HTTP ${result.response.status}`);
  }
  const cookie = result.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  if (!cookie) throw new Error(`Вход ${user} не вернул cookie сессии`);
  sessions.set(user, cookie);
  return { cookie, elapsed: round(result.elapsed), bytes: result.bytes };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
    mean: round(sum / sorted.length)
  };
}

async function readExistingReport() {
  try {
    return JSON.parse(await readFile(reportPath, 'utf8'));
  } catch {
    return {};
  }
}

const run = {
  measuredAt: new Date().toISOString(),
  api: base,
  samplesPerEndpoint: samples,
  login: {},
  endpoints: [],
  notes: [
    'Каждый замер включает полный HTTP-цикл: соединение, аутентификацию, SQL и передачу тела ответа.',
    'Перед серией каждый эндпоинт вызывается один раз для прогрева JIT и пула соединений; эти вызовы не входят в статистику.',
    'doctor: /auth/me, /dashboard/summary, /patients, /diagnoses; manager: /organizations, /reports/occupancy.',
    'p50/p95 — ближайший ранг по 10 замерам.'
  ]
};

try {
  const doctorLogin = await login('doctor');
  const managerLogin = await login('manager');
  run.login = { doctor: doctorLogin.elapsed, manager: managerLogin.elapsed, note: 'включая PBKDF2 210 000 итераций' };

  // Прогрев: первый запрос каждого эндпоинта поднимает JIT и заполняет пул.
  for (const endpoint of endpoints) {
    const warm = await request(endpoint.path, { cookie: sessions.get(endpoint.user) });
    if (warm.response.status !== 200) {
      throw new Error(`${endpoint.key}: прогрев вернул HTTP ${warm.response.status}`);
    }
  }

  for (const endpoint of endpoints) {
    const values = [];
    let bytes = 0;
    let encoding = null;
    for (let index = 0; index < samples; index++) {
      const result = await request(endpoint.path, { cookie: sessions.get(endpoint.user) });
      if (result.response.status !== 200) {
        throw new Error(`${endpoint.key}: замер ${index + 1} вернул HTTP ${result.response.status}`);
      }
      values.push(result.elapsed);
      bytes += result.bytes;
      encoding = result.response.headers.get('content-encoding') ?? encoding;
    }
    const stats = summarize(values);
    run.endpoints.push({
      key: endpoint.key,
      path: endpoint.path,
      user: endpoint.user,
      targetMs: endpoint.target,
      targetMet: endpoint.target === null ? null : stats.p50 < endpoint.target,
      avgBytes: Math.round(bytes / samples),
      contentEncoding: encoding,
      samples: values.map(round),
      ...stats
    });
    console.log(`${endpoint.key.padEnd(26)} p50 ${String(stats.p50).padStart(7)} ms  p95 ${String(stats.p95).padStart(7)} ms`);
  }

  // Сжатие проверяется модулем http: fetch/undici распаковывает тело на лету,
  // поэтому размер на проводе нужно считать по сырым байтам.
  const rawGet = (url, headers) => new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, response => {
      let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, bytes }));
    });
    request.setTimeout(90000, () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
  const compressionPath = '/api/dashboard/summary';
  const compressionUrl = base + compressionPath;
  const compressionHeaders = { Accept: 'application/json', Cookie: sessions.get('doctor') };
  const plain = await rawGet(compressionUrl, compressionHeaders);
  const gzip = await rawGet(compressionUrl, { ...compressionHeaders, 'Accept-Encoding': 'gzip' });
  const brotli = await rawGet(compressionUrl, { ...compressionHeaders, 'Accept-Encoding': 'br' });
  run.compression = {
    path: compressionPath,
    plainBytes: plain.bytes,
    gzip: { bytes: gzip.bytes, contentEncoding: gzip.headers['content-encoding'] ?? null },
    brotli: { bytes: brotli.bytes, contentEncoding: brotli.headers['content-encoding'] ?? null },
    gzipRatio: plain.bytes > 0 ? round(gzip.bytes / plain.bytes) : null,
    brotliRatio: plain.bytes > 0 ? round(brotli.bytes / plain.bytes) : null
  };
  console.log(`compression: ${plain.bytes} -> gzip ${gzip.bytes}, br ${brotli.bytes} bytes`);

  const existing = await readExistingReport();
  // Аналитические разделы отчёта (changes/indexes/verification) не генерируются
  // заново при повторном замере — сохраняем их, чтобы не терять описание правок.
  const preserved = {};
  for (const key of ['comparison', 'changes', 'indexes', 'supplementary', 'verification', 'targets'])
    if (existing[key] !== undefined) preserved[key] = existing[key];
  const merged = {
    generatedAt: new Date().toISOString(),
    api: base,
    plan: {
      goal: { dashboardP50Ms: 700, listP50Ms: 600 },
      network: { roundTripMs: 110, connectMs: 370, source: 'условия задания; фактические значения зависят от канала до учебного PostgreSQL' }
    },
    runs: { ...(existing.runs ?? {}), [label]: run },
    ...preserved
  };
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(merged, null, 2) + '\n');
  console.log(`Отчёт: ${path.relative(root, reportPath)} (${label})`);
} catch (error) {
  console.error(String(error.message).replaceAll(password, '[redacted]'));
  process.exitCode = 1;
} finally {
  for (const [, cookie] of sessions) {
    await request('/api/auth/logout', { method: 'POST', cookie }).catch(() => {});
  }
}
