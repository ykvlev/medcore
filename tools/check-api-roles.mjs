// РџСЂРѕРІРµСЂРєР° СЂРѕР»РµР№ Рё РѕР±Р»Р°СЃС‚РµР№ MEDCORE РЅР° Р¶РёРІРѕРј API. РўРѕР»СЊРєРѕ С‡С‚РµРЅРёРµ Рё В«Р±РµР·РѕРїР°СЃРЅС‹РµВ»
// Р·Р°РїСЂРѕСЃС‹, РєРѕС‚РѕСЂС‹Рµ РїСЂРё РѕС‚СЃСѓС‚СЃС‚РІРёРё РїСЂР°РІ РІРѕР·РІСЂР°С‰Р°СЋС‚ 403 РґРѕ РІР°Р»РёРґР°С†РёРё С‚РµР»Р°.
// РћС‚С‡С‘С‚: docs/database/checks/api-roles-report.json.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));
const base = process.env.MEDCORE_API_URL ?? 'http://127.0.0.1:5180';
const report = { checkedAt: new Date().toISOString(), api: base, result: 'pending', checks: [] };
const failures = [];

function check(condition, name, details = {}) {
  if (!condition) {
    failures.push(name);
    report.checks.push({ name, result: 'failed', ...details });
    console.error(`FAIL ${name}`);
    return;
  }
  report.checks.push({ name, result: 'passed', ...details });
  console.log(`PASS ${name}`);
}

async function request(endpoint, { cookie, method = 'GET', body } = {}) {
  const response = await fetch(base + endpoint, {
    method,
    headers: {
      Accept: 'application/json', Origin: process.env.MEDCORE_ORIGIN ?? 'http://127.0.0.1:5173',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000)
  });
  let data;
  try { data = await response.json(); } catch { data = undefined; }
  return { status: response.status, data };
}

const accounts = [
  ['admin', 'system_admin'], ['manager', 'organization_admin'], ['chief', 'chief_physician'],
  ['deputy', 'deputy_chief_physician'], ['head', 'head_of_department'], ['doctor', 'doctor'],
  ['registrar', 'registrar'], ['lab', 'lab_staff'], ['analyst', 'analyst'],
  ['minister', 'minister_of_health'], ['governor', 'governor']
];
const sessions = new Map();

try {
  for (const [login, role] of accounts) {
    const response = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: process.env.MEDCORE_ORIGIN ?? 'http://127.0.0.1:5173' },
      body: JSON.stringify({ login, password: process.env.MEDCORE_DEMO_PASSWORD }),
      signal: AbortSignal.timeout(30000)
    });
    const cookie = response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
    const data = await response.json().catch(() => undefined);
    sessions.set(role, cookie);
    check(response.status === 200 && data?.roles?.includes(role), `${login}: РІС…РѕРґ Рё СЂРѕР»СЊ ${role}`,
      { status: response.status, roles: data?.roles });
  }

  const allowed = [
    ['system_admin', '/api/admin/users', 200],
    ['organization_admin', '/api/reports/occupancy', 200],
    ['chief_physician', '/api/patients?page=1', 200],
    ['chief_physician', '/api/employees?page=1', 200],
    ['chief_physician', '/api/dashboard/summary', 200],
    ['deputy_chief_physician', '/api/patients?page=1', 200],
    ['head_of_department', '/api/patients?page=1', 200],
    ['head_of_department', '/api/reports/occupancy', 200],
    ['doctor', '/api/diagnoses?search=I10', 200],
    ['registrar', '/api/patients?page=1', 200],
    ['lab_staff', '/api/lab-orders?page=1', 200],
    ['analyst', '/api/reports/occupancy', 200],
    ['minister_of_health', '/api/reports/occupancy', 200],
    ['minister_of_health', '/api/organizations?page=1', 200],
    ['governor', '/api/reports/hospitalizations', 200]
  ];
  for (const [role, endpoint, expected] of allowed) {
    const result = await request(endpoint, { cookie: sessions.get(role) });
    check(result.status === expected, `${role}: ${endpoint} в†’ ${expected}`, { status: result.status });
  }

  const denied = [
    ['minister_of_health', '/api/patients?page=1'],
    ['minister_of_health', '/api/patients/216'],
    ['governor', '/api/patients?page=1'],
    ['governor', '/api/patients/216/cases'],
    ['head_of_department', '/api/diagnoses?search=I10', 200],
    ['analyst', '/api/patients?page=1'],
    ['lab_staff', '/api/patients?page=1'],
    ['system_admin', '/api/patients?page=1'],
    ['registrar', '/api/admin/users'],
    ['doctor', '/api/admin/users']
  ];
  for (const [role, endpoint, expectedStatus = 403] of denied) {
    const result = await request(endpoint, { cookie: sessions.get(role) });
    check(result.status === expectedStatus, `${role}: ${endpoint} в†’ ${expectedStatus}`, { status: result.status });
  }

  // Р—Р°РїРёСЃСЊ СЃС‚СЂСѓРєС‚СѓСЂС‹: Р·Р°РјРµСЃС‚РёС‚РµР»СЊ РіР»Р°РІРІСЂР°С‡Р° РЅРµ СѓРїСЂР°РІР»СЏРµС‚ СЃС‚СЂСѓРєС‚СѓСЂРѕР№. РџСЂРѕРІРµСЂСЏРµРј РЅР°
  // С‡СѓР¶РѕР№ Р±РѕР»СЊРЅРёС†Рµ СЃ РІР°Р»РёРґРЅС‹Рј С‚РµР»РѕРј вЂ” РѕС‚РєР°Р· 403 РїСЂРёС…РѕРґРёС‚ РґРѕ Р»СЋР±РѕР№ Р·Р°РїРёСЃРё.
  const structure = await request('/api/hospitals/9/buildings', {
    cookie: sessions.get('deputy_chief_physician'), method: 'POST', body: { number: 'ROLE-CHECK' }
  });
  check(structure.status === 403, 'deputy_chief_physician: РёР·РјРµРЅРµРЅРёРµ СЃС‚СЂСѓРєС‚СѓСЂС‹ Р·Р°РїСЂРµС‰РµРЅРѕ', { status: structure.status });

  // РњРёРЅРёСЃС‚СЂ Рё РіСѓР±РµСЂРЅР°С‚РѕСЂ РІРёРґСЏС‚ РІСЃРµ 13 РѕСЂРіР°РЅРёР·Р°С†РёР№, РіР»Р°РІРІСЂР°С‡ вЂ” РѕРґРЅСѓ.
  const ministerOrganizations = await request('/api/organizations?page=1&pageSize=100', { cookie: sessions.get('minister_of_health') });
  check(ministerOrganizations.data?.total === 13, 'minister_of_health: РІСЃРµ 13 РѕСЂРіР°РЅРёР·Р°С†РёР№', { total: ministerOrganizations.data?.total });
  const chiefOrganizations = await request('/api/organizations?page=1&pageSize=100', { cookie: sessions.get('chief_physician') });
  check(chiefOrganizations.data?.total === 1, 'chief_physician: С‚РѕР»СЊРєРѕ СЃРІРѕСЏ Р±РѕР»СЊРЅРёС†Р°', { total: chiefOrganizations.data?.total });

  // РњРљР‘-10 Рё СЃР»СѓС‡Р°Рё Р»РµС‡РµРЅРёСЏ.
  const diagnoses = await request('/api/diagnoses?search=РіРёРїРµСЂС‚РµРЅР·', { cookie: sessions.get('doctor') });
  check(diagnoses.status === 200 && diagnoses.data?.items?.some(d => d.code === 'I10' && d.chapter),
    'РњРљР‘-10: РїРѕРёСЃРє РїРѕ РЅР°Р·РІР°РЅРёСЋ РЅР°С…РѕРґРёС‚ I10 СЃ РіР»Р°РІРѕР№', { items: diagnoses.data?.items?.length });
  const cases = await request('/api/patients/216/cases', { cookie: sessions.get('chief_physician') });
  check(cases.status === 200 && Array.isArray(cases.data?.items), 'chief_physician: СЃР»СѓС‡Р°Рё Р»РµС‡РµРЅРёСЏ РґРѕСЃС‚СѓРїРЅС‹',
    { cases: cases.data?.items?.length });

  // РљР°СЂС‚РѕС‡РєР° РїР°С†РёРµРЅС‚Р° СЃРѕРґРµСЂР¶РёС‚ РёСЃС‚РѕСЂРёСЋ Р±РѕР»РµР·РЅРё СЃ РєРѕРґРѕРј РњРљР‘.
  const card = await request('/api/patients/216', { cookie: sessions.get('doctor') });
  const history = card.data?.history ?? [];
  check(card.status === 200 && history.some(item => item.type === 'diagnosis' && /\b[A-Z]\d{2}/.test(item.title ?? '')),
    'РєР°СЂС‚РѕС‡РєР° РїР°С†РёРµРЅС‚Р°: РёСЃС‚РѕСЂРёСЏ СЃРѕРґРµСЂР¶РёС‚ РґРёР°РіРЅРѕР· СЃ РєРѕРґРѕРј РњРљР‘', { history: history.length });

  report.result = failures.length === 0 ? 'passed' : 'failed';
  report.failed = failures;
} catch (error) {
  report.result = 'failed';
  report.error = String(error.message).replaceAll(process.env.MEDCORE_DEMO_PASSWORD ?? '', '[redacted]');
  console.error(report.error);
} finally {
  for (const cookie of sessions.values()) {
    await request('/api/auth/logout', { cookie, method: 'POST' }).catch(() => {});
  }
  await mkdir(path.join(root, 'docs/database/checks'), { recursive: true });
  await writeFile(path.join(root, 'docs/database/checks/api-roles-report.json'), JSON.stringify(report, null, 2) + '\n');
  const passed = report.checks.filter(c => c.result === 'passed').length;
  console.log(`${report.result.toUpperCase()}: ${passed}/${report.checks.length} РїСЂРѕРІРµСЂРѕРє`);
  process.exitCode = report.result === 'passed' ? 0 : 1;
}

