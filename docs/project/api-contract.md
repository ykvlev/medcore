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
  "accompanyingName": "Петров Пётр Петрович"
}
```

`POST /api/transports` тело `{ "patientId": 42, "fromOrganizationId": 2, "toOrganizationId": 5, "reason": "…", "vehicle": "Реанимобиль", "accompanyingEmployeeId": 9 }` → 201 `{ "id": 3 }`. Учреждение отправления приходит от клиента и обязано быть в области доступа пользователя, иначе 403; учреждение назначения должно существовать и быть активным (404) и отличаться от отправления (409); пациент должен быть доступен (404); сопровождающий сотрудник — активен (422). Необязательный `referralId` проверяется на принадлежность пациенту и учреждению назначения (409).

`PATCH /api/transports/{id}` тело `{ "status": "in_progress" }` → 204. Переходы: `requested → in_progress|completed|cancelled`, `in_progress → completed|cancelled`; `started_at` ставится при `in_progress` (и при прямом переводе в `completed`), `completed_at` — при `completed`; терминальные статусы неизменяемы (409).

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
