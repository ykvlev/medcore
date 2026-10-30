// Снимки экранов новых ролей (главный врач, министр, администратор).
// Требует API 5180, Vite 5173 и Edge с --remote-debugging-port=9224.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.loadEnvFile(path.join(root, '.env'));
const output = path.join(root, 'docs/screenshots');
const viewport = { width: 1600, height: 1000 };

async function token(login) {
  const response = await fetch('http://127.0.0.1:5180/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({ login, password: process.env.MEDCORE_DEMO_PASSWORD })
  });
  if (!response.ok) throw new Error(`login ${login}: ${response.status}`);
  return response.headers.getSetCookie().map(v => v.split(';')[0]).join('=').split('=').slice(1).join('=');
}

const targets = await (await fetch('http://127.0.0.1:9224/json/list')).json();
const page = targets.find(t => t.type === 'page');
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

async function setToken(value) {
  await send('Network.clearBrowserCookies');
  await send('Network.setCookie', { name: 'medcore_session', value, domain: '127.0.0.1', path: '/', httpOnly: true, sameSite: 'Lax' });
}

async function capture(name, url) {
  await send('Page.navigate', { url });
  await sleep(7000);
  const text = await send('Runtime.evaluate', { expression: 'document.body.innerText.length', returnByValue: true });
  if (!text.result.value) throw new Error(`${name}: пустая страница`);
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(path.join(output, `${name}.png`), Buffer.from(shot.data, 'base64'));
  console.log(`saved ${name}.png, ${text.result.value} символов`);
}

await mkdir(output, { recursive: true });
await setToken(await token('chief'));
await capture('12-dashboard-chief', 'http://127.0.0.1:5173/dashboard');
await capture('13-patient-history', 'http://127.0.0.1:5173/patients/216');
await capture('14-employees-chief', 'http://127.0.0.1:5173/employees');

await setToken(await token('minister'));
await capture('15-dashboard-minister', 'http://127.0.0.1:5173/dashboard');
await capture('16-reports-minister', 'http://127.0.0.1:5173/reports');

await setToken(await token('admin'));
await capture('17-admin-roles', 'http://127.0.0.1:5173/admin');

await send('Network.clearBrowserCookies');
ws.close();
console.log('DONE');
