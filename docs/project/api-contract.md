# Контракт API MEDCORE (этап 2)

Рабочий контракт для параллельной разработки сервера и клиента. Он дополняет уже реализованные маршруты (`/api/auth/*`, `/api/dashboard/summary`, `/api/patients*`, `/api/organizations`, `/api/employees`, `/api/hospitalizations`, `/api/laboratories`, `/api/reports/overview`). Формат ошибок — Problem Details, как в существующем коде. Все списки серверные, с пагинацией `page`/`pageSize` (по умолчанию 1/20, максимум 100) и поиском `search`.

Роли: `system_admin`, `organization_admin`, `doctor`, `registrar`, `lab_staff`, `analyst`, `chief_physician`, `deputy_chief_physician`, `head_of_department`, `minister_of_health`, `governor`. Ошибки — Problem Details: `400` некорректные параметры страницы, `401` нет сессии, `403` роль или организация вне области доступа, `404` запись не найдена в доступной области, `409` конфликт состояния, `422` некорректное значение поля.

## Организации и структура

| Метод | Маршрут | Доступ | Назначение |
|---|---|---|---|
| GET | `/api/organizations?search=&type=&page=&pageSize=` | все авторизованные | Список учреждений |
| GET | `/api/organizations/{id}` | все авторизованные | Карточка и иерархия |
| POST | `/api/organizations` | organization_admin, system_admin | Создание учреждения |
| PUT | `/api/organizations/{id}` | organization_admin (своё), system_admin | Изменение, активация |
| POST | `/api/hospitals/{id}/buildings` | organization_admin, system_admin | Корпус |
| POST | `/api/buildings/{id}/departments` | organization_admin, system_admin | Отделение |
| POST | `/api/departments/{id}/wards` | organization_admin, system_admin | Палата |
| POST | `/api/wards/{id}/beds` | organization_admin, system_admin | Койка |
| PATCH | `/api/beds/{id}` | organization_admin, system_admin | Ввод/вывод койки из эксплуатации |
| GET | `/api/dictionaries` | все авторизованные | Справочники для форм |

`GET /api/organizations/{id}`:

```json
{
  "organization": { "id": 1, "name": "…", "organizationType": "hospital", "address": "…", "phone": null, "isActive": true, "parentHospitalId": null, "parentHospitalName": null },
  "buildings": [ { "id": 1, "number": "1", "departments": [ { "id": 1, "name": "…", "specialization": "…", "totalBeds": 0, "occupiedBeds": 0, "wards": [ { "id": 1, "number": "101", "plannedCapacity": 4, "beds": [ { "id": 1, "number": "1", "isActive": true, "occupied": false } ] } ] } ] } ]
}
```

`POST /api/organizations` тело: `{ "name": "…", "organizationType": "hospital|polyclinic", "address": "…", "phone": null, "parentHospitalId": null }` → 201 и карточка.
`PUT /api/organizations/{id}` тело: `{ "name": "…", "address": "…", "phone": null, "isActive": true }` → 200.
`POST /api/hospitals/{id}/buildings` тело `{ "number": "2" }` → 201 `{ "id": … }`.
`POST /api/buildings/{id}/departments` тело `{ "name": "…", "specializationId": 3 }` → 201 `{ "id": … }`.
`POST /api/departments/{id}/wards` тело `{ "number": "201", "plannedCapacity": 6 }` → 201 `{ "id": … }`.
`POST /api/wards/{id}/beds` тело `{ "number": "3" }` → 201 `{ "id": … }`.
`PATCH /api/beds/{id}` тело `{ "isActive": false }` → 204; отказ 409, если койка занята.

`GET /api/dictionaries`:

```json
{
  "specializations": [ { "id": 1, "name": "…" } ],
  "specialties": [ { "id": 1, "name": "…" } ],
  "categories": [ { "id": 1, "name": "…" } ],
  "degrees": [ { "id": 1, "name": "…" } ],
  "titles": [ { "id": 1, "name": "…" } ],
  "diagnoses": [ { "code": "…", "name": "…" } ],
  "labTestTypes": [ { "id": 1, "name": "…", "profileId": 1 } ],
  "laboratories": [ { "id": 1, "name": "…" } ]
}
```

## Персонал

| Метод | Маршрут | Доступ |
|---|---|---|
| GET | `/api/employees?search=&specialtyId=&organizationId=&page=` | organization_admin, doctor, registrar |
| GET | `/api/employees/{id}` | organization_admin, doctor |
| POST | `/api/employees` | organization_admin |
| PUT | `/api/employees/{id}` | organization_admin |
| POST | `/api/doctors/{id}/specialties` | organization_admin |
| DELETE | `/api/doctors/{id}/specialties/{specialtyId}` | organization_admin |
| POST | `/api/doctors/{id}/employments` | organization_admin |
| POST | `/api/doctors/{id}/consultations` | organization_admin |

`GET /api/employees/{id}` → `{ "employee": { "id", "lastName", "firstName", "middleName", "birthDate", "category", "isActive", "organizationName" }, "doctor": { "specialties": [ { "id", "name" } ], "degree": null, "title": null, "hiredAt": "2020-01-01" } | null, "employments": [ { "id", "organizationName", "organizationType", "startedAt", "endedAt" } ], "consultations": [ { "id", "organizationName", "startedAt", "endedAt" } ] }`.

`POST /api/employees` тело: `{ "lastName", "firstName", "middleName", "birthDate", "sex", "phone", "categoryId", "specialtyIds": [1,2], "degreeId": null, "titleId": null, "organizationId": 2, "hiredAt": "2020-01-01" }` → 201 `{ "id" }`.
`PUT /api/employees/{id}` — те же поля без `specialtyIds`/`organizationId`; 200. Ошибки бизнес-правил (степень/звание, совместительство) возвращаются 409 с понятным заголовком.

## Стационар

| Метод | Маршрут | Доступ |
|---|---|---|
| GET | `/api/hospitalizations?status=&hospitalId=&page=` | organization_admin, doctor, registrar |
| GET | `/api/hospitalizations/{id}` | organization_admin, doctor, registrar |
| GET | `/api/beds/available?departmentId=&at=` | organization_admin, doctor, registrar |
| POST | `/api/hospitalizations` | doctor |
| PUT | `/api/hospitalizations/{id}/transfer` | doctor |
| PUT | `/api/hospitalizations/{id}/attending` | doctor |
| POST | `/api/hospitalizations/{id}/discharge` | doctor |

Направление оформляется отдельным маршрутом — см. раздел «Направления к специалистам».

`POST /api/hospitalizations` тело: `{ "patientId": 1, "referralId": null, "hospitalId": 2, "departmentId": 4, "bedId": 18, "attendingDoctorId": 9, "admittedAt": "2026-10-30T10:00:00+03:00", "diagnosisId": 12 }` → 201 `{ "id": … }`. Транзакция: стационарный случай, госпитализация, размещение на койке, лечащий врач, первичный диагноз. При занятой койке или отсутствии мест — 409 без частично сохранённых строк.
`PUT /api/hospitalizations/{id}/transfer` тело `{ "bedId": 25, "occurredAt": "…" }` → 204. Закрывает текущее размещение и открывает новое в той же транзакции.
`PUT /api/hospitalizations/{id}/attending` тело `{ "doctorId": 4, "occurredAt": "…" }` → 204.
`POST /api/hospitalizations/{id}/discharge` тело `{ "dischargedAt": "…" }` → 204. Закрывает размещение и назначение врача, ставит статус `discharged`.

Карточка `GET /api/hospitalizations/{id}` → `{ "hospitalization": { "id", "patientId", "patientName", "hospitalName", "departmentName", "status", "admittedAt", "dischargedAt", "bedNumber", "wardNumber", "diagnosis" }, "placements": [ { "id", "wardNumber", "bedNumber", "startedAt", "endedAt" } ], "attending": [ { "id", "doctorName", "startedAt", "endedAt" } ], "history": [ { "id", "type", "title", "occurredAt" } ] }`.

## Лаборатории

| Метод | Маршрут | Доступ |
|---|---|---|
| GET | `/api/laboratories/{id}` | lab_staff, doctor, organization_admin, analyst |
| GET | `/api/lab-orders?status=&page=` | lab_staff, doctor, organization_admin |
| GET | `/api/lab-orders/{id}` | lab_staff, doctor, organization_admin |
| POST | `/api/lab-orders` | doctor |
| POST | `/api/lab-orders/{id}/results` | lab_staff |

`POST /api/lab-orders` тело `{ "caseId": 1, "testTypeId": 3, "contractId": 2, "orderedAt": "…" }` → 201. Сервер сам определяет врача по сессии и проверяет профиль лаборатории и срок договора.
`POST /api/lab-orders/{id}/results` тело `{ "value": "…", "unit": "…", "referenceRange": "…", "conclusion": null, "performedAt": "…" }` → 201 `{ "id": … }`.
`GET /api/lab-orders?status=pending|completed` → `PageResult<{ id, patientName, testName, laboratoryName, status, orderedAt, completedAt }>`.

## Направления к специалистам

Схема — миграция 007: `referrals.referral_type`, `target_doctor_id`, `valid_until`; статусы `issued`, `used`, `cancelled`, `scheduled`, `completed`. Триггер 002 разрешает направлению менять только `status`, поэтому PATCH обновляет одну колонку.

| Метод | Маршрут | Доступ |
|---|---|---|
| GET | `/api/patients/{id}/referrals` | doctor (свои пациенты), registrar (своя организация), chief_physician, deputy_chief_physician, head_of_department (своя больница) |
| GET | `/api/referrals?status=&patientId=&page=&pageSize=` | registrar, doctor, больничные роли |
| POST | `/api/referrals` | doctor (свои случаи и пациенты), registrar (своя организация), больничные роли |
| PATCH | `/api/referrals/{id}/status` | doctor случая, registrar организации, chief_physician, deputy_chief_physician, head_of_department |

Строка направления (одинаковая в карточке пациента и в реестре):

```json
{
  "id": 501,
  "patientId": 42,
  "patientName": "Иванов Иван Иванович",
  "referralType": "consultation",
  "hospitalId": 2,
  "hospitalName": "Городская больница №1",
  "specializationId": 3,
  "specializationName": "Кардиология",
  "doctorId": 9,
  "doctorName": "Петров Пётр Петрович",
  "status": "issued",
  "issuedAt": "2026-10-31T10:15:00+03:00",
  "validUntil": "2026-11-30",
  "reason": "Уточнение диагноза",
  "referringDoctorName": "Сидорова Анна Петровна"
}
```

`GET /api/patients/{id}/referrals` → `{ "items": [ … ] }`, до 200 последних направлений пациента по всем его случаям. `GET /api/referrals` → `{ "items": [ … ], "total": 12, "page": 1, "pageSize": 20 }`; `status` ∈ `issued|used|scheduled|completed|cancelled`, `patientId` сужает выдачу до карточки пациента.

`POST /api/referrals` тело:

```json
{
  "patientId": 42,
  "caseId": 120,
  "referralType": "consultation",
  "hospitalId": 2,
  "specializationId": 3,
  "targetDoctorId": 9,
  "validUntil": "2026-11-30",
  "reason": "Уточнение диагноза"
}
```

→ 201 `{ "id": 501 }`. Алиасы полей: `hospitalId`/`targetHospitalId`, `targetDoctorId`/`doctorId`, `reason`/`note`. `patientId` обязателен, `referralType` по умолчанию `hospitalization`. `caseId` может быть `null`: берётся открытый случай пациента в области пользователя, а при его отсутствии создаётся новый амбулаторный случай (`case_type = 'outpatient'`, причина отражает вид направления) в организации пользователя — иных значений `case_type` схема 001 не допускает. Врач оформляет от своего имени, для регистратора и больничных ролей `referring_doctor_id` берётся из истории лечения пациента в этой организации, а если истории нет — из `targetDoctorId`; иначе 409. Ошибки: 422 (пустая причина, тип направления, срок раньше даты выдачи), 404 (пациент, случай, больница, специализация, целевой врач), 409 (случай другого пациента, отменённый случай).

`PATCH /api/referrals/{id}/status` тело `{ "status": "scheduled" }` → 204. Переходы: `issued → scheduled|completed|cancelled`, `scheduled → completed|cancelled`; из терминальных статусов и из `used` — 409.

## Снабжение

Схема — миграция 007: `supply_items`, `supply_stock`, `supply_orders`, `supply_order_items`. Остаток и минимум — `numeric(12,2)`, суммы считаются на сервере.

| Метод | Маршрут | Доступ |
|---|---|---|
| GET | `/api/supplies?search=&category=&organizationId=` | organization_admin, chief_physician, deputy_chief_physician, head_of_department |
| GET | `/api/supplies/deficit?search=&category=&organizationId=` | те же |
| GET | `/api/supply-orders?status=&organizationId=&page=&pageSize=` | те же |
| POST | `/api/supply-orders` | organization_admin, chief_physician, deputy_chief_physician |
| POST | `/api/supply-orders/{id}/receive` | organization_admin, chief_physician, deputy_chief_physician |

`GET /api/supplies` → `{ "items": [ … ] }`, только позиции с остатком организации; `category` ∈ `medicine|consumable`, `search` — код и название. `organizationId` необязателен: без него берётся первая организация по приоритету роли (администратор → главный врач → заместитель → заведующий), чужая организация — 403.

```json
{
  "id": 11,
  "code": "MED-002",
  "name": "Адреналин 0,1%, ампулы",
  "category": "medicine",
  "unit": "уп.",
  "quantity": 12.00,
  "minQuantity": 30.00,
  "deficit": true,
  "organizationName": "Городская больница №1"
}
```

`GET /api/supplies/deficit` отдаёт тот же формат только для позиций ниже минимума.

`GET /api/supply-orders` → `{ "items": [ … ], "total": 15, "page": 1, "pageSize": 20 }`; `status` ∈ `ordered|received|cancelled`:

```json
{
  "id": 7,
  "supplier": "Городской медицинский склад",
  "status": "ordered",
  "orderedAt": "2026-10-12T09:00:00+03:00",
  "expectedAt": "2026-10-17",
  "receivedAt": null,
  "itemCount": 3,
  "total": 1085.00,
  "note": "Учебная поставка"
}
```

`POST /api/supply-orders` тело `{ "supplier": "…", "expectedAt": "2026-11-05", "note": null, "items": [ { "itemId": 11, "quantity": 10, "unitPrice": 100.50 } ] }` → 201 `{ "id": 7 }`. Валидация: поставщик и хотя бы одна позиция, количество > 0, цена ≥ 0, позиции не повторяются, все `itemId` активны — иначе 422.

`POST /api/supply-orders/{id}/receive` без тела → 204: статус `received`, `received_at`, остаток увеличивается через upsert `supply_stock` одной транзакцией. Повторный приём — 409, отменённый заказ — 409, заказ другой организации — 404.

## Транспортировка пациентов

Схема — миграция 007: `patient_transports`; статусы `requested`, `in_progress`, `completed`, `cancelled`.

| Метод | Маршрут | Доступ |
|---|---|---|
| GET | `/api/transports?status=&page=&pageSize=` | registrar, doctor (свои пациенты), organization_admin, chief_physician, deputy_chief_physician, head_of_department |
| POST | `/api/transports` | registrar, doctor, organization_admin, chief_physician, deputy_chief_physician |
| PATCH | `/api/transports/{id}` | registrar, organization_admin, chief_physician, deputy_chief_physician |
| PUT | `/api/transports/{id}/route` | registrar, organization_admin, chief_physician, deputy_chief_physician |

`GET /api/transports` → `{ "items": [ … ], "total": 20, "page": 1, "pageSize": 20 }`:

```json
{
  "id": 3,
  "patientId": 42,
  "patientName": "Иванов Иван Иванович",
  "fromOrganizationId": 2,
  "fromOrganizationName": "Городская больница №1",
  "toOrganizationId": 5,
  "toOrganizationName": "Городская поликлиника №3",
  "status": "requested",
  "reason": "Перевод в учреждение с нужным профилем",
  "requestedAt": "2026-10-12T08:30:00+03:00",
  "startedAt": null,
  "completedAt": null,
  "vehicle": "Реанимобиль",
  "accompanyingEmployeeId": 9,
  "accompanyingName": "Петров Пётр Петрович",
  "distanceKm": 4.0,
  "odometerStart": null,
  "odometerEnd": null,
  "fuelLiters": null,
  "routePoints": [
    { "lat": 55.7512, "lng": 37.6184, "label": "Пункт отправления" },
    { "lat": 55.7688, "lng": 37.6421, "label": "Пункт назначения" }
  ]
}
```

`POST /api/transports` тело `{ "patientId": 42, "fromOrganizationId": 2, "toOrganizationId": 5, "reason": "…", "vehicle": "Реанимобиль", "accompanyingEmployeeId": 9 }` → 201 `{ "id": 3 }`. Учреждение отправления приходит от клиента и обязано быть в области доступа пользователя, иначе 403; учреждение назначения должно существовать и быть активным (404) и отличаться от отправления (409); пациент должен быть доступен (404); сопровождающий сотрудник — активен (422). Необязательный `referralId` проверяется на принадлежность пациенту и учреждению назначения (409).

`PATCH /api/transports/{id}` тело `{ "status": "in_progress" }` → 204. Переходы: `requested → in_progress|completed|cancelled`, `in_progress → completed|cancelled`; `started_at` ставится при `in_progress` (и при прямом переводе в `completed`), `completed_at` — при `completed`; терминальные статусы неизменяемы (409).

## Маршрут перевозки

Схема — миграция 008: `patient_transports.distance_km numeric(8,1)`, `route_points jsonb`, `odometer_start int`, `odometer_end int`, `fuel_liters numeric(8,1)`; ограничения `distance_km >= 0` и `odometer_end >= odometer_start`. Точки маршрута хранятся массивом объектов `{lat, lng, label}`.

| Метод | Маршрут | Доступ |
|---|---|---|
| PUT | `/api/transports/{id}/route` | registrar, organization_admin, chief_physician, deputy_chief_physician (те же, кто меняет статус перевозки) |

`PUT /api/transports/{id}/route` тело:

```json
{
  "distanceKm": 15.5,
  "odometerStart": 5000,
  "odometerEnd": 5015,
  "fuelLiters": 2.1,
  "routePoints": [
    { "lat": 55.7512, "lng": 37.6184, "label": "Пункт отправления" },
    { "lat": 55.7601, "lng": 37.6302, "label": "Промежуточная точка" },
    { "lat": 55.7688, "lng": 37.6421, "label": "Пункт назначения" }
  ]
}
```

→ 204 без тела. Проверки: `distanceKm` обязателен, `0 ≤ distanceKm ≤ 9999999,9`; `odometerStart`/`odometerEnd` неотрицательны и `odometerEnd ≥ odometerStart`; `fuelLiters ≥ 0`; точек от 2 до 10; `lat ∈ [-90, 90]`, `lng ∈ [-180, 180]`, `label` не длиннее 200 символов — иначе 422. Перевозка вне области доступа — 404, роль вне списка — 403. Значения пишутся параметрами, точки — одним параметром `jsonb`.

`GET /api/transports` дополнен полями `distanceKm`, `odometerStart`, `odometerEnd`, `fuelLiters`, `routePoints`; до первого сохранения маршрута они `null`, а `routePoints` — пустой массив.

## Расписание и приём

Схема — миграция 008: `doctor_schedules` (рабочий день врача, интервал и длительность талона, кабинет, `is_active`) и `appointment_slots` (конкретные талоны со `starts_at`/`ends_at` в `timestamptz`, статус `free|booked|completed|cancelled`, пациент, направление, `booked_at`). Время расписания задаётся местными датой и временем и переводится в `timestamptz` по `Europe/Moscow`; уникальность — `UNIQUE (doctor_id, starts_at)`.

| Метод | Маршрут | Доступ |
|---|---|---|
| GET | `/api/slots?dateFrom=&dateTo=&organizationId=&specializationId=&doctorId=&onlyFree=` | registrar, doctor, organization_admin, chief_physician, deputy_chief_physician, head_of_department |
| GET | `/api/doctors/{id}/slots?dateFrom=&dateTo=` | те же |
| POST | `/api/appointments` | registrar, doctor, organization_admin, chief_physician, deputy_chief_physician |
| PATCH | `/api/appointments/{slotId}` | те же |
| GET | `/api/appointments?date=&status=&patientId=` | registrar, doctor, organization_admin, chief_physician, deputy_chief_physician, head_of_department |
| GET | `/api/schedules?dateFrom=&dateTo=&organizationId=&doctorId=` | registrar, doctor, organization_admin, chief_physician, deputy_chief_physician, head_of_department |
| POST | `/api/schedules` | organization_admin, chief_physician, deputy_chief_physician |
| DELETE | `/api/schedules/{id}` | organization_admin, chief_physician, deputy_chief_physician |

Область приёма — организации ролей `registrar` и `doctor` плюс учреждения управленческих ролей; заведующий отделением попадает в неё через свою больницу и только читает. Явный `organizationId` вне области — 403, поэтому чужой талон не виден и не занимается.

`GET /api/slots` → `{ "items": [ … ] }`, до 1000 талонов:

```json
{
  "id": 41,
  "doctorId": 4,
  "doctorName": "Иванов Александр Александрович",
  "specializationId": 3,
  "specializationName": "Хирург",
  "organizationId": 8,
  "organizationName": "Учебная городская больница №1",
  "startsAt": "2026-10-31T09:00:00+03:00",
  "endsAt": "2026-10-31T09:30:00+03:00",
  "status": "free",
  "cabinet": "каб. 104"
}
```

Период по умолчанию — сегодня и семь дней вперёд по московской дате; если задан только `dateFrom`, `dateTo` = `dateFrom + 7`; `dateTo < dateFrom` и период длиннее года — 422. `onlyFree=true` возвращает только свободные талоны. `specializationId` — основная специальность врача из `doctor_specialties` (первая по `certified_on`), а при её отсутствии — профиль отделения, где врач вёл госпитализации (`hospitalizations.department_id → departments.specialization_id`); фильтр и поле ответа используют одно и то же значение, поэтому при пустом профиле оба равны `null`. `GET /api/doctors/{id}/slots` — тот же формат; неизвестный врач — 404, талоны других учреждений в ответ не попадают.

`POST /api/appointments` тело `{ "slotId": 41, "patientId": 42, "referralId": null }` → 201 `{ "id": 41, "startsAt": "2026-10-31T09:00:00+03:00" }`. Идентификатор записи — идентификатор талона. Проверки: талон существует в области и `status = 'free'` (иначе 409 «талон уже занят»), пациент доступен пользователю — по общим правилам доступа к пациентам, либо прикреплён к поликлинике (больнице) области приёма, либо имеет там открытый случай (404); необязательный `referralId` принадлежит этому пациенту (404 — направление не найдено, 409 — выписано другому). Захват талона атомарный: `UPDATE … WHERE id = @slot AND status = 'free'`, ноль строк — 409, `booked_at = now()`.

`PATCH /api/appointments/{slotId}` тело `{ "status": "completed" }` → 204. Разрешено только `booked → completed|cancelled`: свободный талон — 409 «на талон ещё не записан пациент», отменённая запись не возвращается (409), завершённый приём не переоткрывается (409); запись вне области — 404.

`GET /api/appointments` → `{ "items": [ … ] }`, до 500 записей (только талоны со статусом не `free`):

```json
{
  "id": 41,
  "startsAt": "2026-10-31T09:00:00+03:00",
  "endsAt": "2026-10-31T09:30:00+03:00",
  "status": "booked",
  "patientId": 42,
  "patientName": "Иванов Иван Иванович",
  "doctorId": 4,
  "doctorName": "Иванов Александр Александрович",
  "specializationName": "Хирург",
  "organizationId": 8,
  "organizationName": "Учебная городская больница №1",
  "cabinet": "каб. 104"
}
```

`status` ∈ `booked|completed|cancelled` (иное — 422), `date` — местная дата приёма, `patientId` сужает выдачу. Область задаётся организациями пользователя; отдельная проверка доступа к карточке пациента для этого списка не выполняется, потому что строка и так ограничена учреждением.

`GET /api/schedules` → `{ "items": [ … ] }`, до 1000 строк, период по умолчанию тот же:

```json
{
  "id": 12,
  "doctorId": 4,
  "doctorName": "Иванов Александр Александрович",
  "organizationId": 8,
  "organizationName": "Учебная городская больница №1",
  "workDate": "2026-10-31",
  "startTime": "09:00",
  "endTime": "12:00",
  "slotMinutes": 30,
  "cabinet": "каб. 104",
  "isActive": true,
  "slotsTotal": 6,
  "slotsFree": 1
}
```

В список попадают и отменённые расписания (`isActive: false`) — у них видны остаток талонов и история.

`POST /api/schedules` тело `{ "doctorId": 4, "organizationId": 8, "workDate": "2026-11-02", "startTime": "09:00", "endTime": "12:00", "slotMinutes": 30, "cabinet": "каб. 104" }` → 201 `{ "id": 12, "slotsCreated": 6 }`. Время — строки `ЧЧ:ММ` (допустим и `ЧЧ:ММ:СС`), формат проверяет сервер и отвечает 422, а не 400. Проверки: врач существует и активен (404), работает в организации по `employments` с `ended_on IS NULL` (422), `end > start` (422), `slotMinutes` 5..240 (422), интервал вмещает хотя бы один талон и не более 288 (422), у врача нет другого активного расписания с пересечением по времени в этот день (409), на эти часы нет чужих неотменённых талонов (409). Расписание и все талоны создаются одной транзакцией; границы интервала переводятся в `timestamptz` по `Europe/Moscow`.

`DELETE /api/schedules/{id}` → 204. Если на расписание есть записи со статусом `booked` — 409 «на расписание есть записи: сначала отмените их»; иначе `is_active = false`, а свободные талоны удаляются. Удаление, а не статус `cancelled`, выбрано из-за ограничения миграции 008 `CHECK (status = 'free' OR patient_id IS NOT NULL)`: свободный талон без пациента нельзя пометить отменённым. Завершённые и отменённые приёмы остаются историей и отмене не мешают. Повторная отмена — 409, расписание вне области — 404.

## Закупки

Схема — миграция 008: `suppliers`, `procurement_contracts`, `procurement_tenders`, `supplier_invoices`; суммы `numeric(14,2)`. Область закупок — организации ролей `organization_admin`, `chief_physician`, `deputy_chief_physician`; заведующий отделением к финансовым данным не допускается. Организация новых договора и тендера определяется сервером по первой организации пользователя в порядке приоритета роли.

| Метод | Маршрут | Доступ |
|---|---|---|
| GET | `/api/suppliers?search=` | organization_admin, chief_physician, deputy_chief_physician |
| POST | `/api/suppliers` | organization_admin, chief_physician, deputy_chief_physician |
| GET | `/api/contracts?status=&supplierId=` | organization_admin, chief_physician, deputy_chief_physician |
| POST | `/api/contracts` | organization_admin, chief_physician, deputy_chief_physician |
| PATCH | `/api/contracts/{id}/status` | organization_admin, chief_physician, deputy_chief_physician |
| GET | `/api/tenders?status=` | organization_admin, chief_physician, deputy_chief_physician |
| POST | `/api/tenders` | organization_admin, chief_physician, deputy_chief_physician |
| PATCH | `/api/tenders/{id}` | organization_admin, chief_physician, deputy_chief_physician |
| GET | `/api/invoices?status=&contractId=` | organization_admin, chief_physician, deputy_chief_physician |
| POST | `/api/invoices` | organization_admin, chief_physician, deputy_chief_physician |
| PATCH | `/api/invoices/{id}/pay` | organization_admin, chief_physician, deputy_chief_physician |

`GET /api/suppliers` → `{ "items": [ … ] }`, справочник общий для сети (поставщик не привязан к учреждению), поиск идёт по названию, ИНН и контакту:

```json
{ "id": 1, "name": "Городской медицинский склад", "inn": "7701000001", "contact": "склад@example.test", "isActive": true }
```

`POST /api/suppliers` тело `{ "name": "…", "inn": null, "contact": null }` → 201 `{ "id": 7 }`. Пустое название — 422, повтор названия — 409.

`GET /api/contracts` → `{ "items": [ … ] }` только по организациям пользователя:

```json
{
  "id": 1,
  "number": "Д-2026-001",
  "supplierId": 1,
  "supplierName": "Городской медицинский склад",
  "organizationId": 8,
  "organizationName": "Учебная городская больница №1",
  "signedAt": "2026-10-01",
  "validUntil": "2027-05-19",
  "amount": 150000.00,
  "status": "active",
  "invoicesCount": 2,
  "paidAmount": 45000.00
}
```

`invoicesCount` — число счетов договора, `paidAmount` — сумма оплаченных. `status` ∈ `draft|active|closed` (иное — 422), `supplierId` сужает выдачу. `POST /api/contracts` тело `{ "supplierId": 1, "number": "Д-2026-014", "signedAt": "2026-11-01", "validUntil": "2027-11-01", "amount": 250000.00, "note": null }` → 201 `{ "id": 14 }`; договор создаётся в `draft`, поставщик должен существовать и быть активным (404), `validUntil ≥ signedAt` (422), сумма 0..999999999999,99 (422), повтор номера в организации — 409.

`PATCH /api/contracts/{id}/status` тело `{ "status": "active" }` → 204. Переходы только `draft → active → closed`; `draft → closed` и возврат назад — 409, закрытый договор неизменяем.

`GET /api/tenders` → `{ "items": [ … ] }`:

```json
{
  "id": 1,
  "title": "Закупка расходников № 1",
  "organizationId": 8,
  "organizationName": "Учебная городская больница №1",
  "announcedAt": "2026-10-21T10:00:00+03:00",
  "closesAt": "2026-11-05T18:00:00+03:00",
  "status": "awarded",
  "budget": 80000.00,
  "winnerSupplierId": 1,
  "winnerSupplierName": "Городской медицинский склад"
}
```

`POST /api/tenders` тело `{ "title": "…", "closesAt": "2026-12-01T18:00:00+03:00", "budget": 100000.00, "note": null }` → 201 `{ "id": 7 }`; тендер создаётся в `announced`, `closesAt` должен быть в будущем (422, момент приводится к UTC), бюджет 0..999999999999,99 (422).

`PATCH /api/tenders/{id}` тело `{ "status": "awarded", "winnerSupplierId": 1 }` → 204. Переходы: `announced → evaluating|awarded|cancelled`, `evaluating → awarded|cancelled`; `awarded` без `winnerSupplierId` — 422, поставщик-победитель должен быть активен (422); `awarded` и `cancelled` терминальны (409).

`GET /api/invoices` → `{ "items": [ … ] }` по договорам организаций пользователя:

```json
{
  "id": 12,
  "contractId": 6,
  "contractNumber": "Д-2026-006",
  "supplierName": "СтерильСервис",
  "number": "СЧ-6-2",
  "issuedAt": "2026-10-16",
  "dueAt": "2026-11-05",
  "amount": 60000.00,
  "status": "overdue",
  "paidAt": null
}
```

`status` ∈ `issued|paid|overdue` (иное — 422), `contractId` сужает выдачу. `POST /api/invoices` тело `{ "contractId": 6, "number": "СЧ-6-3", "issuedAt": "2026-11-01", "dueAt": "2026-12-01", "amount": 15000.00 }` → 201 `{ "id": 27 }`; договор обязан быть в области (404), закрытый договор — 409, `dueAt ≥ issuedAt` (422), сумма 0..999999999999,99 (422), повтор номера у договора — 409.

`PATCH /api/invoices/{id}/pay` без тела → 204: `status = 'paid'`, `paid_at = now()`; повторная оплата — 409, счёт вне области — 404.

## Администрирование

| Метод | Маршрут | Доступ |
|---|---|---|
| GET | `/api/admin/users` | system_admin |
| POST | `/api/admin/users` | system_admin |
| PUT | `/api/admin/users/{id}` | system_admin |
| GET | `/api/admin/roles` | system_admin |
| GET | `/api/admin/audit?from=&to=&action=&page=` | system_admin |

`POST /api/admin/users` тело `{ "login", "password", "employeeId": null, "roles": [ { "role": "analyst", "organizationId": null, "laboratoryId": null } ] }` → 201 `{ "id" }`.
`PUT /api/admin/users/{id}` тело `{ "isActive": true, "roles": [ … ] }` → 204.
`GET /api/admin/audit` → `PageResult<{ id, occurredAt, actorLogin, action, entityType, entityId, outcome }>`.

## Отчёты и экспорт

| Метод | Маршрут | Доступ |
|---|---|---|
| GET | `/api/reports/occupancy?from=&to=` | organization_admin, analyst |
| GET | `/api/reports/patients?from=&to=` | organization_admin, analyst |
| GET | `/api/reports/hospitalizations?from=&to=` | organization_admin, analyst |
| GET | `/api/reports/doctors?from=&to=` | organization_admin, analyst |
| GET | `/api/reports/surgeries?from=&to=` | organization_admin, analyst |
| GET | `/api/reports/laboratory?from=&to=` | organization_admin, analyst |
| GET | `/api/reports/{kind}/export?format=csv|pdf&from=&to=` | organization_admin, analyst |

Каждый отчёт возвращает:

```json
{ "kind": "occupancy", "title": "Занятость коечного фонда", "from": "2026-01-01", "to": "2026-10-31",
  "columns": [ { "key": "hospitalName", "label": "Учреждение" } ],
  "rows": [ { "hospitalName": "…" } ],
  "totals": { "rowCount": 12 } }
```

`kind`: `occupancy`, `patients`, `hospitalizations`, `doctors`, `surgeries`, `laboratory`. Экспорт: CSV — UTF-8 с BOM, разделитель `;`, заголовок и строки; PDF — A4, заголовок отчёта, период, таблица, дата формирования. Имя файла: `medcore-<kind>-<from>-<to>.<ext>`. Экспорт проверяет те же права, что и просмотр.

## Ограничения этапа

- Существующие маршруты сохраняют текущее поведение и коды ответов. `POST /api/referrals` перенесён из раздела «Стационар» в «Направления к специалистам» и принимает прежние поля `hospitalId` и `note` как алиасы.
- Пароли, строки подключения и персональные данные в ответах не логируются.
- Даты периода трактуются включительно по местной дате `Europe/Moscow`.
- Новые домены отвечают `422` на некорректное значение поля (в том числе на неизвестный `status` или `category`), `400` — только на некорректные параметры страницы.
- `medical_cases.case_type` по схеме 001 допускает только `outpatient` и `inpatient`; направление на консультацию без `caseId` создаёт амбулаторный случай, вид направления сохраняется в причине и в `referral_type`.
- `referrals.referring_doctor_id` обязателен: врач оформляет от своего имени, регистратору и больничным ролям нужен врач из истории лечения пациента в этой организации либо `targetDoctorId` (иначе 409).
- Списки этапа отдают `{ items, total, page, pageSize }`; `GET /api/patients/{id}/referrals` и оба списка `/api/supplies*` отдают `{ items }`.
- Талоны, записи, расписание, закупки и маршрут перевозки отдают `{ items: [ … ] }` без постраничности: талоны и расписание — до 1000 строк, записи, поставщики, договоры, тендеры и счета — до 500.
- `specializationId` талона — две разные таблицы-справочника: основная специальность врача (`specialties` через `doctor_specialties`) и запасной профиль отделения (`department_specializations`). Идентификаторы этих справочников не пересекаются по смыслу, поэтому `specializationId` в фильтре и в ответе всегда относятся к одному и тому же выбранному значению, а не к справочнику отделений из `/api/dictionaries`.
- Свободный талон нельзя пометить `cancelled` без пациента (`CHECK (status = 'free' OR patient_id IS NOT NULL)` миграции 008), поэтому отмена расписания удаляет свободные талоны; занятые талоны не изменяются, а расписание с записями не отменяется (409).
- `POST /api/appointments` вызывается клиентом повторно только после 409: идемпотентности у записи нет, повторный захват того же талона отклоняется.
- Время приёма в `timestamptz` возвращается в UTC со смещением `+00:00` (примеры показывают то же мгновение в московском времени, `+03:00`); `closes_at` тендера принимается с любым смещением и приводится к UTC — `Npgsql` не принимает в `timestamptz` смещение, отличное от нуля.
- Закупки не имеют отдельного справочника организаций в запросе: договор и тендер создаются от первой организации пользователя в порядке приоритета роли (`organization_admin` → `chief_physician` → `deputy_chief_physician`), как и заказ снабжения.
