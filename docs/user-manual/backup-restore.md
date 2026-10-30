# Резервное копирование и восстановление MEDCORE

Пошаговая инструкция для администратора учебного стенда. Описывает только работу с схемой `project` в PostgreSQL и не заменяет политику резервного копирования организации. Все команды выполняются в PowerShell из корня проекта `C:\Users\tema6\Documents\kursach`.

## 1. Что и зачем копируется

| Объект | Копируется | Комментарий |
|---|---|---|
| Схема `project` | всегда | 48 таблиц, 3 представления, 4 процедуры, 11 функций, данные и последовательности |
| Расширения `btree_gist`, `pg_trgm` | всегда | нужны для ограничений и индексов; восстановление в пустую БД без них невозможно |
| Схема `space_archive` | только с `--include-archive` | старый учебный проект; в обычную копию MEDCORE не входит |
| Роли БД, владельцы объектов | нет | роль не может создавать роли; restore идёт с `--no-owner` |
| Настройки сервера, `pg_hba.conf`, WAL | нет | это логическая копия, не PITR |

Копия содержит персональные данные учебных пациентов и хеши паролей. Обращайтесь с ней как с чувствительным файлом: не отправляйте в мессенджеры, не коммитьте в Git, не храните в общедоступном каталоге.

## 2. Безопасность и запреты

- **Никогда** не восстанавливайте копию в рабочую БД `PGDATABASE` из `.env`. Скрипт сам откажется, если `--database` совпадает с ней.
- **Не** выполняйте `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE`, `DELETE` по рабочей БД. Инструкция не содержит таких команд.
- **Не** печатайте `.env`, `PGPASSWORD` и строку подключения в чат, отчёт или журнал. Скрипты читают пароль сами.
- Восстановление — только в отдельную тестовую БД с явным именем. Если в ней уже есть схемы `project` или `space_archive`, скрипт откажется: выберите другую БД.
- Перед удалением тестовой БД убедитесь, что это именно тестовая БД, а не рабочая.

## 3. Требования

1. Windows и PowerShell 7 (`pwsh`).
2. Node.js. В учебной среде:
   ```powershell
   $node = "C:\Users\tema6\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
   if (-not (Test-Path $node)) { $node = "node" }
   & $node --version
   ```
   Ожидается `v24.x` или новее.
3. Клиент PostgreSQL с `pg_dump` и `pg_restore` версии не ниже сервера. В учебной среде установлены клиентские программы PostgreSQL 18.6:
   ```powershell
   $pgbin = "C:\Program Files\PostgreSQL\18\bin"
   & "$pgbin\pg_dump.exe" --version
   & "$pgbin\pg_restore.exe" --version
   ```
4. Локальный `.env` с `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSSLMODE`. Файл исключён из Git. Не выводите его содержимое. Для учебного сервера используется `PGSSLMODE=disable`, потому что SSL им не поддерживается; это означает передачу данных по сети без шифрования.
5. Права роли: `CONNECT` к своей БД и чтение схемы `project` для копии; для создания отдельной БД нужно право `CREATEDB`, которого у учебной роли нет (см. раздел 7).

## 4. Проверка инструментов

Проверьте, видит ли PowerShell `pg_dump`:

```powershell
Get-Command pg_dump, pg_restore -ErrorAction SilentlyContinue
```

В учебной среде эта команда **ничего не выводит**: каталог `C:\Program Files\PostgreSQL\18\bin` не добавлен в `PATH`. Это не ошибка копирования: скрипты сами ищут `pg_dump` и `pg_restore` в стандартных каталогах установки PostgreSQL и сообщают, откуда взяли программу.

Если PostgreSQL установлен в нестандартное место, задайте пути явно:

```powershell
$env:PG_DUMP = "D:\PostgreSQL\bin\pg_dump.exe"
$env:PG_RESTORE = "D:\PostgreSQL\bin\pg_restore.exe"
```

Проверьте, что `.env` существует (содержимое не печатайте):

```powershell
Test-Path .env
```

## 5. Создание копии

### 5.1 Обычная копия схемы project

```powershell
& $node tools\backup-db.mjs
if ($LASTEXITCODE -ne 0) { throw "Резервная копия не создана. Код: $LASTEXITCODE" }
```

Скрипт:

- читает `.env`, требует `PGPASSWORD` и не запрашивает пароль;
- находит `pg_dump`, проверяет подключение и снимает копию в `backups/`;
- создаёт рядом манифест `.manifest.json` с размером, SHA-256, версией PostgreSQL, схемами, количеством объектов и строк;
- не печатает пароль;
- при отсутствии `pg_dump` завершается с кодом 1 и понятным сообщением, ничего не создавая.

Ожидаемый вывод (числа и хеш будут другими):

```text
Резервная копия создана.
Файл: backups/medcore_project_only_20261030T155650Z.dump
Манифест: backups/medcore_project_only_20261030T155650Z.manifest.json
Размер: 381634 байт
SHA-256: 9d0914...
Схемы: project
PostgreSQL: 18.0; pg_dump: pg_dump (PostgreSQL) 18.6
Объекты project: таблиц 48, представлений 3, процедур 4, функций 11
...
```

Предупреждения `pg_dump` о циклических зависимостях схемы — известная особенность этой схемы. Они не отменяют успешную копию; их число записывается в манифест.

### 5.2 Копия с архивом старого проекта

Только если действительно нужна схема `space_archive`:

```powershell
& $node tools\backup-db.mjs --include-archive --label=before-archive-check
```

В манифесте будет `"schemas": ["project", "space_archive"]`. Для обычного восстановления MEDCORE такой файл не нужен; он больше по размеру.

### 5.3 Своя метка и каталог

```powershell
& $node tools\backup-db.mjs --label=before-migration --out-dir=D:\medcore-backups
```

`--label` — буквы, цифры, дефис, подчёркивание, до 40 символов. Метка помогает найти копию перед конкретным изменением.

## 6. Проверка копии

### 6.1 Манифест и SHA-256

```powershell
$manifestFile = Get-ChildItem backups\*.manifest.json |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
$m = Get-Content $manifestFile.FullName -Raw | ConvertFrom-Json
$m.file
$m.bytes
$m.sha256
$m.schemas
```

Сверьте хеш:

```powershell
$dump = Join-Path (Get-Location) $m.file
$actual = (Get-FileHash $dump -Algorithm SHA256).Hash.ToLower()
if ($actual -ne $m.sha256) { throw "SHA-256 не совпадает: копию нельзя использовать" }
"Целостность подтверждена: $actual"
```

Если хеш не совпал, не восстанавливайте файл: скопируйте его заново и повторите проверку.

### 6.2 Оглавление без восстановления

```powershell
$pgbin = "C:\Program Files\PostgreSQL\18\bin"
& "$pgbin\pg_restore.exe" --list $dump | Select-Object -First 20
```

В оглавлении должны быть `SCHEMA - project`, `EXTENSION - btree_gist`, `EXTENSION - pg_trgm`, таблицы и блоки `TABLE DATA`. Команда ничего не пишет в БД.

### 6.3 Что проверить в манифесте

- `schemas` содержит `project` (и `space_archive`, если копировали с флагом);
- `objects.tables = 48`, `objects.views = 3`, `objects.procedures = 4`, `objects.functions = 11`;
- `keyTableRows` содержит ненулевые значения для ключевых таблиц;
- `bytes` совпадает с размером файла;
- `pgDumpOnPath` может быть `false` — это нормально для учебной машины, если программа найдена по стандартному пути.

## 7. Подготовка тестовой БД

Восстанавливать можно только в отдельную БД. Рабочая БД из `.env` запрещена.

### 7.1 Если роль имеет право CREATEDB

```powershell
& $node tools\restore-db.mjs `
  --dump=backups\medcore_project_only_20261030T155650Z.dump `
  --database=medcore_restore_check `
  --create `
  --report=docs\database\checks\backup-restore.json
```

Флаг `--create` создаёт БД, только если её нет и роль имеет право `CREATE DATABASE`. Скрипт не удаляет существующие объекты.

### 7.2 Если права CREATEDB нет (учебная среда)

Учебная роль не имеет права создавать БД. Попытка `--create` завершится ошибкой:

```text
ОШИБКА: Роль БД не имеет права CREATE DATABASE (SQLSTATE 42501) ...
```

Это ожидаемое ограничение среды. Попросите администратора СУБД создать пустую тестовую БД и владельцем назначить учебную роль:

```sql
CREATE DATABASE medcore_restore_check OWNER a-s-yakovlev;
```

Имя и роль возьмите из `.env` (`PGDATABASE`, `PGUSER`); не подставляйте рабочую БД. После создания проверьте, что БД пуста:

```sql
SELECT nspname FROM pg_namespace WHERE nspname IN ('project', 'space_archive');
```

Ожидается 0 строк. Если схемы уже есть, выберите другое имя БД: скрипт не перезаписывает существующие объекты.

## 8. Восстановление

```powershell
& $node tools\restore-db.mjs `
  --dump=backups\medcore_project_only_20261030T155650Z.dump `
  --database=medcore_restore_check `
  --report=docs\database\checks\backup-restore.json
if ($LASTEXITCODE -ne 0) { throw "Восстановление не выполнено. Код: $LASTEXITCODE" }
```

Параметр `--report` заменяет указанный файл отчёта. Если предыдущий отчёт нужен как доказательство, сначала скопируйте его под другим именем.

Что делает скрипт:

1. Проверяет имя целевой БД: запрещены рабочая БД из `.env`, `postgres`, `template0`, `template1`, недопустимые имена.
2. Проверяет целостность копии по размеру и SHA-256 и читает оглавление `pg_restore --list`.
3. Отказывается работать, если в целевой БД уже есть схемы `project`/`space_archive`.
4. Выполняет `pg_restore --no-owner --no-privileges --single-transaction --exit-on-error`. При ошибке транзакция откатывается, частично восстановленной схемы не остаётся.
5. Сверяет 10 ключевых таблиц, 3 представления, 4 процедуры, 48 таблиц, 11 функций и расширения.
6. Пишет JSON-отчёт, если указан `--report`.

Ожидаемый успешный вывод:

```text
Восстановление в тестовую БД выполнено и проверено.
Копия: backups/medcore_project_only_20261030T155650Z.dump (SHA-256 подтверждён)
Тестовая БД: medcore_restore_check
Ключевые таблицы: 10 из 10 совпали с манифестом
Представления: 3 из 3; процедуры: 4 из 4; строк/объектов по манифесту — совпадают.
```

Если манифеста рядом с копией нет, восстановление возможно, но целостность по SHA-256 не подтверждается, а количества строк не с чем сравнить; скрипт отметит это в отчёте как ограничение.

## 9. Проверка результата

### 9.1 По отчёту

```powershell
$report = Get-Content docs\database\checks\backup-restore.json -Raw | ConvertFrom-Json
$report.result
$report.verification.keyTables | Format-Table table, expected, actual, match
$report.verification.views | Format-Table name, present
$report.verification.procedures | Format-Table name, present
$report.verification.objects
$report.verification.extensions
```

Для успешного запуска ожидается `result = passed`, все `match = true`, все `present = true`, объекты `48/3/4/11`, расширения `btree_gist` и `pg_trgm`.

Текущий файл `backup-restore.json` может содержать составной отчёт: на учебном сервере создание БД запрещено, поэтому там есть разделы `educationalServer` (отказ 42501) и `isolatedLocalRestore` (успешная проверка в изолированном кластере). Это не признак ошибки скрипта, а честная фиксация ограничения среды. Для составного отчёта смотрите вложенные поля:

```powershell
$report.educationalServer.result
$report.educationalServer.errors
$report.isolatedLocalRestore.result
$report.isolatedLocalRestore.verification.keyTables | Format-Table table, expected, actual, match
$report.isolatedLocalRestore.verification.views | Format-Table name, present
```

### 9.2 Запросами в тестовой БД

Подключитесь к **тестовой** БД через pgAdmin или `psql`, введя пароль в приглашении (не вставляйте пароль в команду). Выполните:

```sql
SELECT count(*) AS tables
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'project' AND c.relkind = 'r';

SELECT count(*) AS patients FROM project.patients;
SELECT count(*) AS cases FROM project.medical_cases;
SELECT count(*) AS hospitalizations FROM project.hospitalizations;

SELECT table_name FROM information_schema.views
WHERE table_schema = 'project' ORDER BY table_name;

SELECT routine_name FROM information_schema.routines
WHERE routine_schema = 'project' AND routine_type = 'PROCEDURE' ORDER BY routine_name;

SELECT extname FROM pg_extension
WHERE extname IN ('btree_gist', 'pg_trgm') ORDER BY extname;
```

Ожидается: 48 таблиц, 3 представления (`vw_doctor_statistics`, `vw_hospital_capacity`, `vw_patient_treatment_summary`), 4 процедуры (`sp_delete_patient_draft`, `sp_get_patient_summary`, `sp_register_patient`, `sp_update_patient`), 2 расширения. Количества строк сверяйте с манифестом копии.

### 9.3 Проверка представлений

```sql
SELECT count(*) FROM project.vw_hospital_capacity;
SELECT count(*) FROM project.vw_doctor_statistics;
SELECT count(*) FROM project.vw_patient_treatment_summary;
```

Ошибка «relation does not exist» означает, что представления не восстановлены: не используйте такую копию.

## 10. После проверки

1. Сохраните отчёт и хеш копии в журнале резервного копирования.
2. Скопируйте файл копии на отдельный носитель или в защищённое хранилище; не оставляйте единственную копию на рабочей машине.
3. Тестовую БД можно удалить только после подтверждения, что это тестовая БД. Подключитесь к другой БД (например, `postgres`), а не к удаляемой:

```sql
DROP DATABASE medcore_restore_check;
```

Эту команду выполняет владелец БД или администратор СУБД. **Не** выполняйте её для рабочей БД. Если сомневаетесь, оставьте БД и обратитесь к администратору.

4. Не удаляйте последнюю исправную копию до создания следующей.

## 11. Типовые ошибки

| Сообщение | Причина | Что делать |
|---|---|---|
| `pg_dump не найден ни в PATH...` | клиент PostgreSQL не установлен или путь нестандартный | установить клиент; задать `$env:PG_DUMP` (и `PG_RESTORE`) |
| `PGPASSWORD не задан` | нет `.env` или переменной | проверить `.env`; не печатать пароль |
| `password authentication failed` | неверные `PGUSER`/`PGPASSWORD`/`PGHOST` | сверить `.env`; для учебного сервера `PGSSLMODE=disable` |
| `Роль БД не имеет права CREATE DATABASE (SQLSTATE 42501)` | нет `CREATEDB` | администратор создаёт БД; затем запуск без `--create` |
| `В тестовой БД уже есть схемы project/space_archive` | цель не пуста | выбрать другую тестовую БД; не перезаписывать |
| `SHA-256 копии не совпадает с манифестом` | файл повреждён или заменён | взять другую копию; не восстанавливать |
| `pg_restore завершился с кодом 1` | ошибка схемы, расширения или прав | прочитать текст ошибки; проверить пустоту БД и наличие расширений |
| `Количество строк не совпало` | копия неполная или БД изменялась | не использовать копию; создать новую |
| `Get-Command pg_dump` ничего не выводит | каталог bin не в `PATH` | это нормально: скрипт найдёт стандартный путь; можно задать `PG_DUMP` |

## 12. Регламент

- Перед каждой миграцией, изменением структуры или массовым наполнением — копия с понятной меткой.
- Не реже одного раза в месяц — проверка восстановления в отдельную БД.
- Хранить не менее трёх последних копий; одну из них — вне рабочей машины.
- Ограничить доступ к `backups/`: копия не шифруется и содержит учебные персональные данные.
- Записывать в журнал: дату, файл, SHA-256, результат проверки, кто выполнял.
- Не считать наличие файла доказательством восстановимости: доказательство — успешная сверка после restore.

## 13. Фактический статус на 30.10.2026

- `Get-Command pg_dump` не находит программу в `PATH`; установленный `pg_dump` 18.6 найден по стандартному пути и использован.
- Копия схемы `project` создана: `backups/medcore_project_only_20261030T155650Z.dump`, 381 634 байта, SHA-256 `9d09149d6b6c481f440c1c53ea734ffb113860529234ac689ef28dad000fb515`.
- Восстановление на учебном сервере **не выполнено**: роль не имеет права `CREATE DATABASE` (SQLSTATE 42501).
- Восстановление в отдельную БД проверено в изолированном локальном кластере PostgreSQL 18.6: 10 из 10 ключевых таблиц, 3 представления, 4 процедуры, 48 таблиц, 11 функций, расширения установлены.
- Подробный отчёт: [backup-restore.json](../database/checks/backup-restore.json). Разбор защиты данных: [data-protection.md](../security/data-protection.md).

Для получения успешного восстановления на учебном сервере нужен администратор СУБД: создать пустую тестовую БД и повторить команду из раздела 8. До этого ограничение считается неустранённым, а не «проверенным условно».
