# Контракт API MEDCORE (этап 2)

Рабочий контракт для параллельной разработки сервера и клиента. Он дополняет уже реализованные маршруты (`/api/auth/*`, `/api/dashboard/summary`, `/api/patients*`, `/api/organizations`, `/api/employees`, `/api/hospitalizations`, `/api/laboratories`, `/api/reports/overview`). Формат ошибок — Problem Details, как в существующем коде. Все списки серверные, с пагинацией `page`/`pageSize` (по умолчанию 1/20, максимум 100) и поиском `search`.

Роли: `system_admin`, `organization_admin`, `doctor`, `registrar`, `lab_staff`, `analyst`.

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
| POST | `/api/referrals` | doctor |

`POST /api/hospitalizations` тело: `{ "patientId": 1, "referralId": null, "hospitalId": 2, "departmentId": 4, "bedId": 18, "attendingDoctorId": 9, "admittedAt": "2026-10-30T10:00:00+03:00", "diagnosisId": 12 }` → 201 `{ "id": … }`. Транзакция: стационарный случай, госпитализация, размещение на койке, лечащий врач, первичный диагноз. При занятой койке или отсутствии мест — 409 без частично сохранённых строк.
`PUT /api/hospitalizations/{id}/transfer` тело `{ "bedId": 25, "occurredAt": "…" }` → 204. Закрывает текущее размещение и открывает новое в той же транзакции.
`PUT /api/hospitalizations/{id}/attending` тело `{ "doctorId": 4, "occurredAt": "…" }` → 204.
`POST /api/hospitalizations/{id}/discharge` тело `{ "dischargedAt": "…" }` → 204. Закрывает размещение и назначение врача, ставит статус `discharged`.
`POST /api/referrals` тело `{ "caseId": 10, "hospitalId": 2, "specializationId": 3, "note": null }` → 201 `{ "id" }`.

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

- Существующие маршруты сохраняют текущее поведение и коды ответов.
- Пароли, строки подключения и персональные данные в ответах не логируются.
- Даты периода трактуются включительно по местной дате `Europe/Moscow`.
