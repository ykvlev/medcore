# Размещение MEDCORE

## Текущий стенд

| Компонент | Адрес / параметр |
|---|---|
| Приложение | https://89-104-65-61.sslip.io |
| Сервер | 89.104.65.61, Ubuntu 22.04 LTS, 2 ГБ RAM, 40 ГБ SSD |
| Домен | `89-104-65-61.sslip.io` — публичный DNS-псевдоним, указывает на тот же IP |
| TLS | Caddy, автоматический сертификат Let's Encrypt |
| База | PostgreSQL 18 в контейнере, доступна только внутри Docker-сети |
| Доступ | SSH только по ключу (`~/.ssh/medcore_vps`), пароль отключён |

Схема: Caddy принимает HTTPS на 80/443, отдаёт статическую сборку React из
`/srv` и проксирует `/api/*` в контейнер API. API подключается к PostgreSQL по
`DATABASE_URL` внутри сети `medcore_default`. Наружу открыты только 22, 80, 443.

## Состав на сервере

```
/opt/medcore/
├── docker-compose.yml   # db, api, caddy
├── Caddyfile            # HTTPS, статика и прокси /api
├── .env                 # DB_PASSWORD (не в репозитории)
├── build/               # опубликованное приложение и Dockerfile
└── site/                # собранный фронтенд (dist)
```

`docker-compose.yml`:

- `db` — `postgres:18-alpine`, том `dbdata`, порт опубликован только на
  `127.0.0.1:5432` (для обслуживания и резервных копий);
- `api` — образ `medcore-api:latest`, переменные `DATABASE_URL`,
  `ASPNETCORE_URLS=http://0.0.0.0:8080`, `MEDCORE_FRONTEND_ORIGINS`;
- `caddy` — `caddy:2-alpine`, порты 80/443, тома `caddy_data`, `caddy_config`,
  каталог `./site` смонтирован в `/srv`.

За прокси приложение читает `X-Forwarded-Proto` и `X-Forwarded-For`
(`UseForwardedHeaders`), поэтому cookie помечается `Secure`, а ограничение
входа считает реальный адрес клиента, а не адрес контейнера Caddy.

Готовые файлы конфигурации лежат в `deploy/` (`docker-compose.yml`, `Caddyfile`).
HTTP/3 сознательно отключён (`protocols h1 h2`, без публикации 443/udp): на части
сетей UDP до сервера не доходит, и браузер вместо быстрого HTTP/2 ждёт таймаута
QUIC — страница «зависает» на 10–15 секунд. Сборка клиента разбита на части
(`React.lazy`), а файлы с хешем в имени кэшируются на год; старые файлы при
выкладке не удаляются, чтобы закэшированный `index.html` не остался без скриптов.

## Обновление приложения

```powershell
# локально: собрать фронтенд и опубликовать API
pnpm --dir frontend build
.\.tools\dotnet\dotnet.exe publish backend\Medcore.Api\Medcore.Api.csproj -c Release -o tmp\publish
Copy-Item backend\fonts tmp\publish\fonts -Recurse -Force

# загрузить на сервер и пересобрать контейнеры
scp -i $env:USERPROFILE\.ssh\medcore_vps -r frontend\dist\* root@89.104.65.61:/opt/medcore/site/
scp -i $env:USERPROFILE\.ssh\medcore_vps tmp\publish.zip root@89.104.65.61:/root/
ssh -i $env:USERPROFILE\.ssh\medcore_vps root@89.104.65.61 `
  "cd /opt/medcore && rm -rf build/app && unzip -q -o /root/publish.zip -d build/app && docker build -t medcore-api:latest build && docker compose up -d api"
```

## База данных

Первый запуск выполнялся с локального компьютера через SSH-туннель:

```powershell
ssh -i $env:USERPROFILE\.ssh\medcore_vps -N -L 15432:127.0.0.1:5432 root@89.104.65.61
$env:PUBLIC_DATABASE_URL = "postgresql://medcore:<пароль>@127.0.0.1:15432/medcore?sslmode=disable"
node tools/bootstrap-public-db.mjs
```

Скрипт применяет миграции, загружает демонстрационный набор и справочник
МКБ-10, отказываясь работать с непустой схемой `project`. Целевой результат:
13 организаций, 1 000 пациентов, 500 госпитализаций, 47 кодов МКБ-10,
11 ролей и 11 учётных записей.

Проверки на стенде: `check-api.mjs` — 33/33, `check-api-stage2.mjs` — 37/37,
`check-api-roles.mjs` — 42/42 (для прямых SQL-сверок используется тот же туннель
и переменная `MEDCORE_DATABASE_URL`).

## Альтернативная схема (Vercel + Render + Neon)

Ранее стенд был развёрнут как Vercel (клиент) → Render (API в Docker) → Neon
(PostgreSQL). Такая схема работоспособна, но зависит от доступности внешних
сервисов и бесплатный Render засыпает после простоя. Для сдачи основной стенд
размещён на собственном сервере; внешние сервисы остаются резервным вариантом.

Vercel-конфигурация сохранена: `frontend/vercel.json`, переменная
`VITE_API_URL`; для Render — `render.yaml` и `backend/Dockerfile`.
