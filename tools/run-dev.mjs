import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const localDotnet = path.join(root, '.tools/dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const dotnet = existsSync(localDotnet) ? localDotnet : 'dotnet';
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', ASPNETCORE_ENVIRONMENT: 'Development' };
if (existsSync(localDotnet)) env.DOTNET_ROOT = path.dirname(localDotnet);
const children = [];
let closing = false;

function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) if (child.exitCode === null) child.kill();
  process.exitCode = code;
}
function start(command, args, cwd) {
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('error', error => { console.error(`Unable to start local application: ${error.code ?? 'error'}`); stop(1); });
  child.on('exit', code => { if (!closing) stop(code ?? 1); });
  return child;
}
async function build() {
  const child = spawn(dotnet, ['build', 'backend/Medcore.Api/Medcore.Api.csproj', '--nologo'],
    { cwd: root, env, stdio: 'inherit', windowsHide: true });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  if (code !== 0) throw new Error('Backend build failed');
}
try {
  const frontendOnly = process.argv.includes('--frontend-only');
  const backendOnly = process.argv.includes('--backend-only');
  if (!frontendOnly) {
    if (!process.argv.includes('--no-build')) await build();
    start(dotnet, [path.join(root, 'backend/Medcore.Api/bin/Debug/net10.0/Medcore.Api.dll'),
      '--urls', 'http://127.0.0.1:5180'], root);
    console.log('MEDCORE API: http://127.0.0.1:5180');
  }
  if (!backendOnly) {
    const vite = path.join(root, 'frontend/node_modules/vite/bin/vite.js');
    if (!existsSync(vite)) throw new Error('Install frontend dependencies first: pnpm --dir frontend install');
    start(process.execPath, [vite, '--host', '127.0.0.1', '--port', '5173', '--strictPort'], path.join(root, 'frontend'));
    console.log('MEDCORE interface: http://127.0.0.1:5173');
  }
} catch (error) {
  console.error(error.message);
  stop(1);
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
