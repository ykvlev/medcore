// РЎРєРІРѕР·РЅС‹Рµ HTTP-РїСЂРѕРІРµСЂРєРё РІС‚РѕСЂРѕРіРѕ СЌС‚Р°РїР°: СЃРїСЂР°РІРѕС‡РЅРёРєРё, СЃС‚СЂСѓРєС‚СѓСЂР°, СЃС‚Р°С†РёРѕРЅР°СЂ,
// Р»Р°Р±РѕСЂР°С‚РѕСЂРёРё, Р°РґРјРёРЅРёСЃС‚СЂРёСЂРѕРІР°РЅРёРµ, РѕС‚С‡С‘С‚С‹ Рё СЌРєСЃРїРѕСЂС‚. РўРѕР»СЊРєРѕ С‡С‚РµРЅРёРµ Рё СЌРєСЃРїРѕСЂС‚;
// РґР°РЅРЅС‹Рµ РЅРµ РёР·РјРµРЅСЏСЋС‚СЃСЏ. РћС‚С‡С‘С‚: docs/database/checks/api-stage2-report.json.
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
    'РўРѕР»СЊРєРѕ С‡С‚РµРЅРёРµ Рё СЌРєСЃРїРѕСЂС‚: Р·Р°РїРёСЃРё СЃС‚Р°С†РёРѕРЅР°СЂР° Рё СЂРµР·СѓР»СЊС‚Р°С‚РѕРІ РЅРµ СЃРѕР·РґР°РІР°Р»РёСЃСЊ, С‡С‚РѕР±С‹ РЅРµ РѕСЃС‚Р°РІР»СЏС‚СЊ РЅРµСѓРґР°Р»СЏРµРјС‹С… РґРµРјРѕРЅСЃС‚СЂР°С†РёРѕРЅРЅС‹С… СЃС‚СЂРѕРє.',
    'РџСЂРѕРІРµСЂСЏСЋС‚СЃСЏ РєРѕРґС‹ РѕС‚РІРµС‚РѕРІ Рё С„РѕСЂРјР° РґР°РЅРЅС‹С…, Р° РЅРµ РІРёР·СѓР°Р»СЊРЅРѕРµ РѕС‚РѕР±СЂР°Р¶РµРЅРёРµ РІ Р±СЂР°СѓР·РµСЂРµ.'
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
      Origin: process.env.MEDCORE_ORIGIN ?? 'http://127.0.0.1:5173',
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
  check(result.status === 200 && !!result.cookie, `${name}: РІС…РѕРґ РІС‹РїРѕР»РЅРµРЅ`);
  return result.cookie;
}

const period = 'from=2026-01-01&to=2026-10-31';
const sessions = [];
try {
  check((await request('/api/auth/me')).status === 401, 'Р°РЅРѕРЅРёРјРЅС‹Р№ Р·Р°РїСЂРѕСЃ РѕС‚РєР»РѕРЅС‘РЅ');
  const registrar = await login('registrar'); sessions.push(registrar);
  const manager = await login('manager'); sessions.push(manager);
  const doctor = await login('doctor'); sessions.push(doctor);
  const lab = await login('lab'); sessions.push(lab);
  const analyst = await login('analyst'); sessions.push(analyst);
  const admin = await login('admin'); sessions.push(admin);

  // РћСЂРіР°РЅРёР·Р°С†РёРё Рё СЃС‚СЂСѓРєС‚СѓСЂР°.
  const organizations = await request('/api/organizations?page=1&pageSize=5', { cookie: registrar });
  check(organizations.status === 200 && Array.isArray(organizations.data?.items) && organizations.data.items.length <= 5,
    'СЂРµРµСЃС‚СЂ РѕСЂРіР°РЅРёР·Р°С†РёР№ РѕС‚РґР°С‘С‚ СЃС‚СЂР°РЅРёС†Сѓ', { total: organizations.data?.total });
  const hospitals = await request('/api/organizations?type=hospital&page=1&pageSize=10', { cookie: registrar });
  check(hospitals.status === 200 && hospitals.data.items.every(o => o.organizationType === 'hospital'),
    'С„РёР»СЊС‚СЂ РїРѕ С‚РёРїСѓ СѓС‡СЂРµР¶РґРµРЅРёСЏ СЂР°Р±РѕС‚Р°РµС‚', { count: hospitals.data?.items?.length });
  const hospital = hospitals.data.items[0];
  const card = await request(`/api/organizations/${hospital.id}`, { cookie: registrar });
  const departments = (card.data?.buildings ?? []).flatMap(b => b.departments ?? []);
  check(card.status === 200 && departments.length > 0, 'РєР°СЂС‚РѕС‡РєР° Р±РѕР»СЊРЅРёС†С‹ СЃРѕРґРµСЂР¶РёС‚ РёРµСЂР°СЂС…РёСЋ РѕС‚РґРµР»РµРЅРёР№',
    { buildings: card.data?.buildings?.length, departments: departments.length });
  const wards = departments.flatMap(d => d.wards ?? []);
  check(wards.length > 0 && (wards[0].beds ?? []).length > 0, 'РїР°Р»Р°С‚С‹ СЃРѕРґРµСЂР¶Р°С‚ РєРѕР№РєРё');
  const dictionaries = await request('/api/dictionaries', { cookie: registrar });
  check(dictionaries.status === 200 && dictionaries.data.specializations.length > 0
    && dictionaries.data.labTestTypes.length > 0 && dictionaries.data.diagnoses.length > 0,
    'СЃРїСЂР°РІРѕС‡РЅРёРєРё РѕС‚РґР°СЋС‚СЃСЏ РѕРґРЅРёРј Р·Р°РїСЂРѕСЃРѕРј', { specializations: dictionaries.data?.specializations?.length });

  // РџРµСЂСЃРѕРЅР°Р».
  const employees = await request('/api/employees?page=1&pageSize=10', { cookie: manager });
  check(employees.status === 200 && employees.data.items.length > 0, 'СЂРµРµСЃС‚СЂ СЃРѕС‚СЂСѓРґРЅРёРєРѕРІ РѕС‚РґР°С‘С‚ СЃС‚СЂР°РЅРёС†Сѓ',
    { total: employees.data?.total });
  const employeeCard = await request(`/api/employees/${employees.data.items[0].id}`, { cookie: manager });
  check(employeeCard.status === 200 && !!employeeCard.data.employee, 'РєР°СЂС‚РѕС‡РєР° СЃРѕС‚СЂСѓРґРЅРёРєР° РґРѕСЃС‚СѓРїРЅР° Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂСѓ');
  check((await request('/api/employees?page=1&pageSize=500', { cookie: manager })).status === 400,
    'СЃР»РёС€РєРѕРј Р±РѕР»СЊС€РѕР№ СЂР°Р·РјРµСЂ СЃС‚СЂР°РЅРёС†С‹ РѕС‚РєР»РѕРЅС‘РЅ');

  // РЎС‚Р°С†РёРѕРЅР°СЂ.
  const hospitalizations = await request('/api/hospitalizations?page=1&pageSize=10', { cookie: registrar });
  check(hospitalizations.status === 200 && hospitalizations.data.items.length > 0,
    'СЃРїРёСЃРѕРє РіРѕСЃРїРёС‚Р°Р»РёР·Р°С†РёР№ РѕС‚РґР°С‘С‚ СЃС‚СЂР°РЅРёС†Сѓ', { total: hospitalizations.data?.total });
  const firstHospitalization = hospitalizations.data.items[0];
  const hospitalizationCard = await request(`/api/hospitalizations/${firstHospitalization.id}`, { cookie: doctor });
  check(hospitalizationCard.status === 200 && Array.isArray(hospitalizationCard.data.placements)
    && Array.isArray(hospitalizationCard.data.attending), 'РєР°СЂС‚РѕС‡РєР° РіРѕСЃРїРёС‚Р°Р»РёР·Р°С†РёРё СЃРѕРґРµСЂР¶РёС‚ СЂР°Р·РјРµС‰РµРЅРёСЏ Рё РІСЂР°С‡РµР№',
    { placements: hospitalizationCard.data?.placements?.length });
  const departmentId = departments[0].id;
  const beds = await request(`/api/beds/available?departmentId=${departmentId}`, { cookie: doctor });
  check(beds.status === 200 && Array.isArray(beds.data.items), 'СЃРІРѕР±РѕРґРЅС‹Рµ РєРѕР№РєРё РѕС‚РґРµР»РµРЅРёСЏ РѕС‚РґР°СЋС‚СЃСЏ СЃРїРёСЃРєРѕРј',
    { free: beds.data?.items?.length });

  // Р›Р°Р±РѕСЂР°С‚РѕСЂРёРё.
  const laboratories = await request('/api/laboratories', { cookie: doctor });
  check(laboratories.status === 200 && laboratories.data.items.length > 0, 'РІСЂР°С‡ РІРёРґРёС‚ СЃРїРёСЃРѕРє Р»Р°Р±РѕСЂР°С‚РѕСЂРёР№');
  const labOrders = await request('/api/lab-orders?page=1&pageSize=10', { cookie: lab });
  check(labOrders.status === 200 && labOrders.data.items.length > 0, 'Р·Р°РєР°Р·С‹ РёСЃСЃР»РµРґРѕРІР°РЅРёР№ РѕС‚РґР°СЋС‚СЃСЏ СЃС‚СЂР°РЅРёС†РµР№',
    { total: labOrders.data?.total });
  const labOrder = await request(`/api/lab-orders/${labOrders.data.items[0].id}`, { cookie: lab });
  check(labOrder.status === 200 && typeof labOrder.data.patientName === 'string', 'РєР°СЂС‚РѕС‡РєР° Р·Р°РєР°Р·Р° СЃРѕРґРµСЂР¶РёС‚ РїР°С†РёРµРЅС‚Р° Рё РёСЃСЃР»РµРґРѕРІР°РЅРёРµ');

  // РћС‚С‡С‘С‚С‹ Рё СЌРєСЃРїРѕСЂС‚.
  for (const kind of ['occupancy', 'patients', 'hospitalizations', 'doctors', 'surgeries', 'laboratory']) {
    const table = await request(`/api/reports/${kind}?${period}`, { cookie: analyst });
    check(table.status === 200 && Array.isArray(table.data.rows) && Array.isArray(table.data.columns)
      && table.data.kind === kind && table.data.totals.rowCount === table.data.rows.length,
      `РѕС‚С‡С‘С‚ ${kind} РѕС‚РґР°С‘С‚ СЃС‚СЂРѕРєРё Рё РєРѕР»РѕРЅРєРё`, { rows: table.data?.rows?.length });
  }
  const csv = await request(`/api/reports/occupancy/export?format=csv&${period}`, { cookie: analyst, raw: true });
  const csvText = csv.buffer.toString('utf8');
  check(csv.status === 200 && csv.buffer[0] === 0xef && csv.buffer[1] === 0xbb && csv.buffer[2] === 0xbf
    && /attachment/i.test(csv.headers.get('content-disposition') ?? '') && csvText.includes(';'),
    'CSV РѕС‚С‡С‘С‚Р° СЃРєР°С‡РёРІР°РµС‚СЃСЏ СЃ BOM Рё СЂР°Р·РґРµР»РёС‚РµР»РµРј ;', { bytes: csv.buffer.length });
  const pdf = await request(`/api/reports/hospitalizations/export?format=pdf&${period}`, { cookie: analyst, raw: true });
  check(pdf.status === 200 && pdf.buffer.subarray(0, 5).toString('latin1') === '%PDF-'
    && /application\/pdf/i.test(pdf.headers.get('content-type') ?? ''),
    'PDF РѕС‚С‡С‘С‚Р° СЃРєР°С‡РёРІР°РµС‚СЃСЏ РєР°Рє PDF-С„Р°Р№Р»', { bytes: pdf.buffer.length });

  // РђРґРјРёРЅРёСЃС‚СЂРёСЂРѕРІР°РЅРёРµ.
  const users = await request('/api/admin/users', { cookie: admin });
  check(users.status === 200 && users.data.items.length >= 6, 'СЃРїРёСЃРѕРє РїРѕР»СЊР·РѕРІР°С‚РµР»РµР№ РґРѕСЃС‚СѓРїРµРЅ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂСѓ',
    { users: users.data?.items?.length });
  const roles = await request('/api/admin/roles', { cookie: admin });
  check(roles.status === 200 && roles.data.items.length >= 11 && roles.data.items.some(r => r.code === 'chief_physician'),
    'СЃРїСЂР°РІРѕС‡РЅРёРє СЂРѕР»РµР№ СЃРѕРґРµСЂР¶РёС‚ РѕРґРёРЅРЅР°РґС†Р°С‚СЊ СЂРѕР»РµР№', { roles: roles.data?.items?.length });
  const audit = await request('/api/admin/audit?page=1&pageSize=10', { cookie: admin });
  check(audit.status === 200 && audit.data.items.length > 0, 'Р¶СѓСЂРЅР°Р» Р°СѓРґРёС‚Р° РѕС‚РґР°С‘С‚ СЃС‚СЂР°РЅРёС†Сѓ',
    { total: audit.data?.total });

  // РћРіСЂР°РЅРёС‡РµРЅРёСЏ РґРѕСЃС‚СѓРїР°.
  check((await request('/api/admin/users', { cookie: registrar })).status === 403, 'СЂРµРіРёСЃС‚СЂР°С‚РѕСЂСѓ Р·Р°РєСЂС‹С‚ СЂР°Р·РґРµР» РїРѕР»СЊР·РѕРІР°С‚РµР»РµР№');
  check((await request('/api/reports/occupancy', { cookie: doctor })).status === 403, 'РІСЂР°С‡Сѓ Р·Р°РєСЂС‹С‚С‹ РѕС‚С‡С‘С‚С‹ СЃРµС‚Рё');
  check((await request('/api/reports/occupancy', { cookie: admin })).status === 403, 'С‚РµС…РЅРёС‡РµСЃРєРѕРјСѓ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂСѓ Р·Р°РєСЂС‹С‚С‹ РјРµРґРёС†РёРЅСЃРєРёРµ РѕС‚С‡С‘С‚С‹');
  check((await request('/api/patients?page=1', { cookie: analyst })).status === 403, 'Р°РЅР°Р»РёС‚РёРєСѓ Р·Р°РєСЂС‹С‚С‹ РїРµСЂСЃРѕРЅР°Р»СЊРЅС‹Рµ РєР°СЂС‚РѕС‡РєРё');
  check((await request(`/api/organizations/${hospital.id}`, { cookie: '' })).status === 401, 'Р±РµР· СЃРµСЃСЃРёРё РєР°СЂС‚РѕС‡РєР° РЅРµРґРѕСЃС‚СѓРїРЅР°');

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
  console.log(`${report.result.toUpperCase()}: ${passed}/${report.checks.length} РїСЂРѕРІРµСЂРѕРє`);
  process.exitCode = report.result === 'passed' ? 0 : 1;
}

