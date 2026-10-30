import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
process.loadEnvFile(envPath);
let password = process.env.MEDCORE_DEMO_PASSWORD;
if (!password) {
  password = `Medcore-${randomBytes(9).toString('base64url')}!`;
  const previous = await readFile(envPath, 'utf8');
  await writeFile(envPath, previous.trimEnd() + `\nMEDCORE_DEMO_PASSWORD='${password}'\n`);
}
const content = `# Локальный доступ к MEDCORE\n\nЭтот файл содержит учебный пароль и исключён из контроля версий. Не включать в публичный репозиторий или курсовую документацию.\n\nАдрес приложения: http://localhost:5173\n\nОбщий пароль демонстрационных пользователей: **${password}**\n\n| Логин | Роль |\n|---|---|\n| admin | Системный администратор |\n| manager | Администратор учреждения |\n| doctor | Врач |\n| registrar | Регистратор |\n| lab | Сотрудник лаборатории |\n| analyst | Аналитик |\n\nУчётные записи становятся доступны после заполнения демонстрационной базы. Пароль PostgreSQL хранится отдельно в .env и здесь не повторяется.\n`;
await writeFile(path.join(root, 'LOCAL-ACCESS.md'), content);
console.log('Local demo credentials prepared; no passwords printed.');
