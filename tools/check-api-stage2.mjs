// Сквозные HTTP-проверки второго этапа: справочники, структура, стационар,
// лаборатории, администрирование, отчёты и экспорт. Только чтение и экспорт;
// данные не изменяются. Отчёт: docs/database/checks/api-stage2-report.json.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));

const base = process.env.MEDCORE_API_URL ?? 'http://127.0.0.1:5180';
const report = {
  checkedAt: new Date().toISOString(),
  api: base,
  result: 'pending',
  checks: [],
  limitations: [
    'Только чтение и экспорт: записи стационара и результатов не создавались, чтобы не оставлять неудаляемых демонстрационных строк.',
    'Проверяются коды ответов и форма данных, а не визуальное отображение в браузере.'
  ]
};

const failures = [];
function check(condition, name, details = {}) {
  if (!condition) {
    failures.push(name);
    report.checks.push({ name, result: 'failed', ...details });
    console.error(`FAIL ${name}`);
    return false;
  }
  report.checks.push({ name, result: 'passed', ...details });
  console.log(`PASS ${name}`);
  return true;
}

async function request(endpoint, { cookie, method = 'GET', body, raw = false } = {}) {
  const response = await fetch(base + endpoint, {
    method,
    headers: {
      Accept: raw ? '*/*' : 'application/json',
      Origin: 'http://127.0.0.1:5173',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  let data;
  if (!raw) { try { data = JSON.parse(buffer.toString('utf8')); } catch { data = undefined; } }
  return { status: response.status, data, buffer, headers: response.headers, cookie: response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ') };
}

async function login(name) {
  const result = await request('/api/auth/login', { method: 'POST', body: { login: name, password: process.env.MEDCORE_DEMO_PASSWORD } });
  check(result.status === 200 && !!result.cookie, `${name}: вход выполнен`);
  return result.cookie;
}

const period = 'from=2026-01-01&to=2026-10-31';
const sessions = [];
try {
  check((await request('/api/auth/me')).status === 401, 'анонимный запрос отклонён');
  const registrar = await login('registrar'); sessions.push(registrar);
  const manager = await login('manager'); sessions.push(manager);
  const doctor = await login('doctor'); sessions.push(doctor);
  const lab = await login('lab'); sessions.push(lab);
  const analyst = await login('analyst'); sessions.push(analyst);
  const admin = await login('admin'); sessions.push(admin);

  // Организации и структура.
  const organizations = await request('/api/organizations?page=1&pageSize=5', { cookie: registrar });
  check(organizations.status === 200 && Array.isArray(organizations.data?.items) && organizations.data.items.length <= 5,
    'реестр организаций отдаёт страницу', { total: organizations.data?.total });
  const hospitals = await request('/api/organizations?type=hospital&page=1&pageSize=10', { cookie: registrar });
  check(hospitals.status === 200 && hospitals.data.items.every(o => o.organizationType === 'hospital'),
    'фильтр по типу учреждения работает', { count: hospitals.data?.items?.length });
  const hospital = hospitals.data.items[0];
  const card = await request(`/api/organizations/${hospital.id}`, { cookie: registrar });
  const departments = (card.data?.buildings ?? []).flatMap(b => b.departments ?? []);
  check(card.status === 200 && departments.length > 0, 'карточка больницы содержит иерархию отделений',
    { buildings: card.data?.buildings?.length, departments: departments.length });
  const wards = departments.flatMap(d => d.wards ?? []);
  check(wards.length > 0 && (wards[0].beds ?? []).length > 0, 'палаты содержат койки');
  const dictionaries = await request('/api/dictionaries', { cookie: registrar });
  check(dictionaries.status === 200 && dictionaries.data.specializations.length > 0
    && dictionaries.data.labTestTypes.length > 0 && dictionaries.data.diagnoses.length > 0,
    'справочники отдаются одним запросом', { specializations: dictionaries.data?.specializations?.length });

  // Персонал.
  const employees = await request('/api/employees?page=1&pageSize=10', { cookie: manager });
  check(employees.status === 200 && employees.data.items.length > 0, 'реестр сотрудников отдаёт страницу',
    { total: employees.data?.total });
  const employeeCard = await request(`/api/employees/${employees.data.items[0].id}`, { cookie: manager });
  check(employeeCard.status === 200 && !!employeeCard.data.employee, 'карточка сотрудника доступна администратору');
  check((await request('/api/employees?page=1&pageSize=500', { cookie: manager })).status === 400,
    'слишком большой размер страницы отклонён');

  // Стационар.
  const hospitalizations = await request('/api/hospitalizations?page=1&pageSize=10', { cookie: registrar });
  check(hospitalizations.status === 200 && hospitalizations.data.items.length > 0,
    'список госпитализаций отдаёт страницу', { total: hospitalizations.data?.total });
  const firstHospitalization = hospitalizations.data.items[0];
  const hospitalizationCard = await request(`/api/hospitalizations/${firstHospitalization.id}`, { cookie: doctor });
  check(hospitalizationCard.status === 200 && Array.isArray(hospitalizationCard.data.placements)
    && Array.isArray(hospitalizationCard.data.attending), 'карточка госпитализации содержит размещения и врачей',
    { placements: hospitalizationCard.data?.placements?.length });
  const departmentId = departments[0].id;
  const beds = await request(`/api/beds/available?departmentId=${departmentId}`, { cookie: doctor });
  check(beds.status === 200 && Array.isArray(beds.data.items), 'свободные койки отделения отдаются списком',
    { free: beds.data?.items?.length });

  // Лаборатории.
  const laboratories = await request('/api/laboratories', { cookie: doctor });
  check(laboratories.status === 200 && laboratories.data.items.length > 0, 'врач видит список лабораторий');
  const labOrders = await request('/api/lab-orders?page=1&pageSize=10', { cookie: lab });
  check(labOrders.status === 200 && labOrders.data.items.length > 0, 'заказы исследований отдаются страницей',
    { total: labOrders.data?.total });
  const labOrder = await request(`/api/lab-orders/${labOrders.data.items[0].id}`, { cookie: lab });
  check(labOrder.status === 200 && typeof labOrder.data.patientName === 'string', 'карточка заказа содержит пациента и исследование');

  // Отчёты и экспорт.
  for (const kind of ['occupancy', 'patients', 'hospitalizations', 'doctors', 'surgeries', 'laboratory']) {
    const table = await request(`/api/reports/${kind}?${period}`, { cookie: analyst });
    check(table.status === 200 && Array.isArray(table.data.rows) && Array.isArray(table.data.columns)
      && table.data.kind === kind && table.data.totals.rowCount === table.data.rows.length,
      `отчёт ${kind} отдаёт строки и колонки`, { rows: table.data?.rows?.length });
  }
  const csv = await request(`/api/reports/occupancy/export?format=csv&${period}`, { cookie: analyst, raw: true });
  const csvText = csv.buffer.toString('utf8');
  check(csv.status === 200 && csv.buffer[0] === 0xef && csv.buffer[1] === 0xbb && csv.buffer[2] === 0xbf
    && /attachment/i.test(csv.headers.get('content-disposition') ?? '') && csvText.includes(';'),
    'CSV отчёта скачивается с BOM и разделителем ;', { bytes: csv.buffer.length });
  const pdf = await request(`/api/reports/hospitalizations/export?format=pdf&${period}`, { cookie: analyst, raw: true });
  check(pdf.status === 200 && pdf.buffer.subarray(0, 5).toString('latin1') === '%PDF-'
    && /application\/pdf/i.test(pdf.headers.get('content-type') ?? ''),
    'PDF отчёта скачивается как PDF-файл', { bytes: pdf.buffer.length });

  // Администрирование.
  const users = await request('/api/admin/users', { cookie: admin });
  check(users.status === 200 && users.data.items.length >= 6, 'список пользователей доступен администратору',
    { users: users.data?.items?.length });
  const roles = await request('/api/admin/roles', { cookie: admin });
  check(roles.status === 200 && roles.data.items.length >= 11 && roles.data.items.some(r => r.code === 'chief_physician'),
    'справочник ролей содержит одиннадцать ролей', { roles: roles.data?.items?.length });
  const audit = await request('/api/admin/audit?page=1&pageSize=10', { cookie: admin });
  check(audit.status === 200 && audit.data.items.length > 0, 'журнал аудита отдаёт страницу',
    { total: audit.data?.total });

  // Ограничения доступа.
  check((await request('/api/admin/users', { cookie: registrar })).status === 403, 'регистратору закрыт раздел пользователей');
  check((await request('/api/reports/occupancy', { cookie: doctor })).status === 403, 'врачу закрыты отчёты сети');
  check((await request('/api/reports/occupancy', { cookie: admin })).status === 403, 'техническому администратору закрыты медицинские отчёты');
  check((await request('/api/patients?page=1', { cookie: analyst })).status === 403, 'аналитику закрыты персональные карточки');
  check((await request(`/api/organizations/${hospital.id}`, { cookie: '' })).status === 401, 'без сессии карточка недоступна');

  report.result = failures.length === 0 ? 'passed' : 'failed';
  report.failed = failures;
} catch (error) {
  report.result = 'failed';
  report.error = String(error.message).replaceAll(process.env.PGPASSWORD ?? '', '[redacted]')
    .replaceAll(process.env.MEDCORE_DEMO_PASSWORD ?? '', '[redacted]');
  console.error(report.error);
} finally {
  for (const cookie of sessions) await request('/api/auth/logout', { cookie, method: 'POST' }).catch(() => {});
  await mkdir(path.join(root, 'docs/database/checks'), { recursive: true });
  await writeFile(path.join(root, 'docs/database/checks/api-stage2-report.json'), JSON.stringify(report, null, 2) + '\n');
  const passed = report.checks.filter(c => c.result === 'passed').length;
  console.log(`${report.result.toUpperCase()}: ${passed}/${report.checks.length} проверок`);
  process.exitCode = report.result === 'passed' ? 0 : 1;
}
