// Снимки экранов MEDCORE через headless Edge (CDP). Требует запущенных API (5180),
// Vite (5173) и Edge с --remote-debugging-port=9222. Сохраняет PNG в docs/screenshots.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));
const output = path.join(root, 'docs/screenshots');
const viewport = { width: 1600, height: 1000 };

async function session(login) {
  const response = await fetch('http://127.0.0.1:5180/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({ login, password: process.env.MEDCORE_DEMO_PASSWORD })
  });
  if (!response.ok) throw new Error(`login ${login}: ${response.status}`);
  const cookie = response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
  const token = cookie.split('=').slice(1).join('=');
  return token;
}

const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = targets.find(t => t.type === 'page');
if (!page) throw new Error('нет страницы для CDP');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 0;
const pending = new Map();
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  }
};
function send(method, params = {}) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

await send('Page.enable');
await send('Network.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false });

async function setToken(token) {
  await send('Network.clearBrowserCookies');
  await send('Network.setCookie', { name: 'medcore_session', value: token, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });
}

async function capture(name, url, { full = true } = {}) {
  await send('Page.navigate', { url });
  await sleep(7000);
  const text = await send('Runtime.evaluate', { expression: 'document.body.innerText.length', returnByValue: true });
  if (!text.result.value) throw new Error(`${name}: страница пустая (${url})`);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
  console.log(`saved ${name}.png, текста ${text.result.value} символов`);
}

await mkdir(output, { recursive: true });
const manager = await session('manager');
const doctor = await session('doctor');
const admin = await session('admin');

await setToken(manager);
await capture('01-dashboard-manager', 'http://127.0.0.1:5173/dashboard');
await capture('02-organizations', 'http://127.0.0.1:5173/organizations');
await capture('03-organization-card', 'http://127.0.0.1:5173/organizations/8');
await capture('04-employees', 'http://127.0.0.1:5173/employees');
await capture('05-hospitalizations', 'http://127.0.0.1:5173/hospitalizations');
await capture('06-reports', 'http://127.0.0.1:5173/reports');

await setToken(doctor);
await capture('07-patients', 'http://127.0.0.1:5173/patients');
await capture('08-patient-card', 'http://127.0.0.1:5173/patients/216');
await capture('09-laboratories', 'http://127.0.0.1:5173/laboratories');

await setToken(admin);
await capture('10-admin', 'http://127.0.0.1:5173/admin');

await send('Network.clearBrowserCookies');
await capture('11-login', 'http://127.0.0.1:5173/login', { full: false });
ws.close();
console.log('DONE');
