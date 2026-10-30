// Сборка всего приложения: сервер .NET и клиент React.
// Использование: pnpm build (или node tools/build-all.mjs).
// Зависимости клиента ставятся отдельно: pnpm --dir frontend install.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localDotnet = path.join(root, '.tools', 'dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet');
const dotnet = existsSync(localDotnet) ? localDotnet : 'dotnet';
const frontend = path.join(root, 'frontend');
const tsc = path.join(frontend, 'node_modules', 'typescript', 'bin', 'tsc');
const vite = path.join(frontend, 'node_modules', 'vite', 'bin', 'vite.js');
if (!existsSync(tsc) || !existsSync(vite)) {
  console.error('Зависимости клиента не установлены: pnpm --dir frontend install');
  process.exit(1);
}

function run(command, args, cwd) {
  console.log(`\n> ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(dotnet, ['build', path.join('backend', 'Medcore.slnx'), '--nologo'], root);
run(process.execPath, [tsc, '-b'], frontend);
run(process.execPath, [vite, 'build'], frontend);
console.log('\nСборка завершена: backend/Medcore.slnx и frontend/dist');
