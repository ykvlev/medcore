# Размещение MEDCORE: GitHub, Vercel и сервер API
#
# Vercel не исполняет .NET, поэтому на нём размещается только клиент.
# Серверу нужен контейнерный хостинг (Render, Fly.io, Azure) и PostgreSQL,
# доступный из интернета. Учебный сервер университета снаружи недоступен,
# поэтому для публичной демонстрации нужна отдельная база с теми же миграциями.

## 1. Репозиторий

```powershell
git init
git add .
git commit -m "MEDCORE: база данных, сервер, клиент и комплект документов"
git branch -M main
git remote add origin https://github.com/<логин>/<репозиторий>.git
git push -u origin main
```

Секреты не публикуются: `.env`, `LOCAL-ACCESS.md`, `backups/`, `materials/` и
`tmp/` исключены через `.gitignore`.

## 2. Клиент на Vercel

1. New Project → Import Git Repository.
2. Root Directory: `frontend`.
3. Framework Preset: Vite (подхватится из `frontend/vercel.json`).
4. Environment Variables:
   - `VITE_API_URL` — адрес API, например `https://medcore-api.onrender.com`.
5. Deploy. Клиент — статическая сборка, Rewrites уже настроены на `index.html`.

Если `VITE_API_URL` не задан, клиент обращается к `/api` на своём же домене —
это работает только при локальном запуске через Vite-прокси.

## 3. Сервер API в контейнере

```powershell
docker build -f backend/Dockerfile -t medcore-api .
docker run --rm -p 8080:8080 --env-file .env medcore-api
```

Переменные окружения сервера:

| Переменная | Назначение |
|---|---|
| `ConnectionStrings__Medcore` | строка подключения Npgsql к PostgreSQL |
| `MEDCORE_FRONTEND_ORIGINS` | домены клиента через запятую, например `https://medcore.vercel.app` |
| `MEDCORE_COOKIE_SAMESITE` | `None` при размещении клиента и API на разных доменах (требует HTTPS) |
| `ASPNETCORE_URLS` | адрес прослушивания, в образе `http://0.0.0.0:8080` |

Для Render достаточно `render.yaml` в корне репозитория: сервис соберётся из
`backend/Dockerfile`, а `ConnectionStrings__Medcore` и `MEDCORE_FRONTEND_ORIGINS`
задаются в панели.

## 4. База данных для демонстрации

1. Создать PostgreSQL (Neon, Supabase, Render PostgreSQL).
2. Применить миграции по порядку:
   `database/migrations/001_initial_schema.sql` … `005_specialties.sql`.
3. Загрузить демонстрационный набор `database/seeds/demo.sql` (пароль задаётся
   переменной `medcore.seed_password_hash`; локальный запуск — `tools/seed-educational-db.mjs`).
4. Проверить: `node tools/check-api.mjs` и `node tools/check-api-stage2.mjs`
   с `MEDCORE_API_URL`, указывающим на развёрнутый сервер.

## Ограничения публичной демонстрации

- Данные вымышленные; реальные медицинские сведения не используются.
- Учебный сервер PostgreSQL не поддерживает SSL и доступен только изнутри сети,
  поэтому в интернете нужна отдельная база.
- Публичный адрес API и домен клиента должны совпадать с `MEDCORE_FRONTEND_ORIGINS`,
  иначе браузер не отправит cookie сессии.
