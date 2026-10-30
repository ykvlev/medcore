# Размещение MEDCORE: GitHub, Vercel и сервер API

## Текущее размещение (демонстрационный стенд)

| Компонент | Адрес |
|---|---|
| Клиент | https://medcore-ebon.vercel.app |
| API | https://medcore-api-k0no.onrender.com |
| База | Neon, проект `crimson-surf-25226215`, ветка `production` |
| Репозиторий | https://github.com/ykvlev/medcore |

Схема развёртывания: Vercel отдаёт статическую сборку React, браузер обращается
к API на Render по `VITE_API_URL`, API подключается к Neon по `DATABASE_URL`.
Cookie сессии — `HttpOnly; Secure; SameSite=None`, потому что клиент и API
находятся на разных доменах; источник клиента разрешён в
`MEDCORE_FRONTEND_ORIGINS`. Проверки на этом стенде: `check-api.mjs` — 33/33,
`check-api-stage2.mjs` — 37/37, `check-api-roles.mjs` — 42/42.

Vercel не исполняет .NET, поэтому на нём размещается только клиент.
Серверу нужен контейнерный хостинг (Render, Fly.io, Azure) и PostgreSQL,
доступный из интернета. Учебный сервер университета снаружи недоступен,
поэтому для публичной демонстрации нужна отдельная база с теми же миграциями.

## 1. Репозиторий

Сборка целиком (сервер и клиент):

```powershell
pnpm install --frozen-lockfile
pnpm build
node tools/check-api.mjs   # при запущенном API
```

Публикация кода:

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
2. Подготовить базу одной командой — она применит миграции, загрузит
   демонстрационный набор и справочник МКБ-10:

   ```powershell
   $env:DATABASE_URL = "postgresql://user:password@host/db?sslmode=require"
   $env:MEDCORE_DEMO_PASSWORD = "демонстрационный-пароль"
   node tools/bootstrap-public-db.mjs
   ```

   Скрипт отказывается работать с непустой схемой `project`. Ожидаемый итог:
   13 организаций, 1 000 пациентов, 500 госпитализаций, 47 кодов МКБ-10,
   11 ролей и 11 учётных записей.
3. Проверить развёрнутый сервер:

   ```powershell
   $env:MEDCORE_API_URL = "https://<сервер>"
   $env:MEDCORE_DATABASE_URL = "postgresql://...?sslmode=require"
   node tools/check-api.mjs
   node tools/check-api-stage2.mjs
   node tools/check-api-roles.mjs
   ```

Подготовка базы проверена локально на чистом кластере PostgreSQL 18:
bootstrap и 33 проверки API прошли полностью.

## Ограничения публичной демонстрации

- Данные вымышленные; реальные медицинские сведения не используются.
- Учебный сервер PostgreSQL не поддерживает SSL и доступен только изнутри сети,
  поэтому в интернете нужна отдельная база.
- Публичный адрес API и домен клиента должны совпадать с `MEDCORE_FRONTEND_ORIGINS`,
  иначе браузер не отправит cookie сессии.
