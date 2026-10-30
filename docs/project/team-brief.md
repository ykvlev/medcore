# Брифинг команды MEDCORE (этап 2)

Общие правила для параллельных исполнителей. Каждый агент владеет только своими файлами; общую интеграцию выполняет ведущий агент.

## Среда

- Рабочая папка: `C:\Users\tema6\Documents\kursach`. Windows, PowerShell.
- .NET SDK: `.\.tools\dotnet\dotnet.exe` (10.0.403).
- Node.js: `C:\Users\tema6\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`. Добавляй его в `$env:PATH`, иначе `node` и pnpm-скрипты не запустятся.
- pnpm: `node C:\Users\tema6\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs`.
- Учебный PostgreSQL 18: доступ в локальном `.env` (ключи `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`, `MEDCORE_DEMO_PASSWORD`). Секреты не печатать в отчётах и логах. Схема `project`; схему `space_archive` не трогать.

## Сборка и проверки

Сервер (изолированные артефакты, чтобы не конфликтовать с другими агентами):

```powershell
.\.tools\dotnet\dotnet.exe build backend\Medcore.Api\Medcore.Api.csproj --artifacts-path tmp\build-<твоё-имя> --nologo
```

Клиент:

```powershell
$env:PATH = "C:\Users\tema6\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin;" + $env:PATH
cd frontend
node node_modules\typescript\bin\tsc -p tsconfig.app.json --noEmit
```

Запуск API для проверки — только на свободном порту 5181–5190:

```powershell
$env:PATH = "...\node\bin;" + $env:PATH
node tools\run-dev.mjs --backend-only --no-build   # по умолчанию 5180; для своего порта задай ASPNETCORE_URLS
```

## Границы владения

- Не редактируй чужие файлы из списка соседних задач и эти общие файлы: `backend/Medcore.Api/Program.cs`, `backend/Medcore.Application/Contracts.cs`, `backend/Medcore.Infrastructure/MedcoreStore.cs`, `frontend/src/types.ts`, `frontend/src/api.ts`, `frontend/src/App.tsx`, `frontend/src/components/Layout.tsx`, `frontend/src/styles.css`, `database/migrations/*`, `docs/project/decisions.md`, `docs/project/requirements.md`, `docs/project/roadmap.md`, `docs/project/current-state.md`, `docs/project/api-contract.md`, `materials/**`.
- Миграции 001–003 уже применены на сервере. Исправления схемы — только новыми файлами `database/migrations/004_*.sql` и только по согласованию с ведущим агентом (по умолчанию схему не меняй).
- Не удаляй и не изменяй чужие строки в учебной БД. Временные фикстуры создавай с явной меткой и удаляй; при сомнении используй транзакцию с ROLLBACK.
- Не выдумывай результаты испытаний, подписи и библиографию. Не выдавай запланированное за реализованное.

## Стиль

- Интерфейс и документы — на русском языке; код и комментарии — в стиле существующего проекта (русские комментарии допустимы).
- Стекло, тёмная палитра, плотные таблицы; новые стили — в отдельном CSS-файле рядом со страницей, без правки `styles.css`.
- Ошибки API — Problem Details, коды 400/401/403/404/409/503 как в существующем коде.
- Доступ проверяется на сервере; скрытие кнопки в интерфейсе не считается проверкой.

## Отчёт агента

В финальном сообщении: что сделано, какие файлы созданы/изменены, какие команды выполнены и с каким результатом, что не проверено и почему, какие вопросы требуют решения ведущего агента. Коротко, без пересказа кода.
