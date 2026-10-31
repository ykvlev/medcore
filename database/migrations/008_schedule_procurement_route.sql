-- MEDCORE, миграция 008: расписание приёма с талонами, закупки
-- (поставщики, договоры, тендеры, счета) и маршрут перевозки с пробегом.
BEGIN;
SET LOCAL search_path = project, public;
SELECT set_config('medcore.actor_user_id',
    coalesce((SELECT id::text FROM project.users WHERE login = 'admin'), ''), true);
SELECT set_config('medcore.request_id', 'migration-008', true);

-- 1. Расписание врача и талоны на приём.
CREATE TABLE IF NOT EXISTS project.doctor_schedules (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doctor_id bigint NOT NULL REFERENCES project.doctors(employee_id),
    organization_id bigint NOT NULL REFERENCES project.medical_organizations(id),
    work_date date NOT NULL,
    start_time time NOT NULL,
    end_time time NOT NULL,
    slot_minutes integer NOT NULL DEFAULT 30 CHECK (slot_minutes BETWEEN 5 AND 240),
    cabinet text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (end_time > start_time)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_doctor_schedules_slot
    ON project.doctor_schedules(doctor_id, work_date, start_time) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_doctor_schedules_org_date
    ON project.doctor_schedules(organization_id, work_date) WHERE is_active;

CREATE TABLE IF NOT EXISTS project.appointment_slots (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schedule_id bigint NOT NULL REFERENCES project.doctor_schedules(id) ON DELETE CASCADE,
    doctor_id bigint NOT NULL REFERENCES project.doctors(employee_id),
    organization_id bigint NOT NULL REFERENCES project.medical_organizations(id),
    starts_at timestamptz NOT NULL,
    ends_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'free' CHECK (status IN ('free', 'booked', 'completed', 'cancelled')),
    patient_id bigint REFERENCES project.patients(id),
    referral_id bigint REFERENCES project.referrals(id),
    booked_at timestamptz,
    CHECK (ends_at > starts_at),
    CHECK (status = 'free' OR patient_id IS NOT NULL),
    UNIQUE (doctor_id, starts_at)
);

CREATE INDEX IF NOT EXISTS idx_slots_free ON project.appointment_slots(organization_id, starts_at)
    WHERE status = 'free';
CREATE INDEX IF NOT EXISTS idx_slots_patient ON project.appointment_slots(patient_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_slots_referral ON project.appointment_slots(referral_id);

-- 2. Закупки: поставщики, договоры, тендеры и счета.
CREATE TABLE IF NOT EXISTS project.suppliers (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE CHECK (btrim(name) <> ''),
    inn text,
    contact text,
    is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS project.procurement_contracts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id bigint NOT NULL REFERENCES project.medical_organizations(id),
    supplier_id bigint NOT NULL REFERENCES project.suppliers(id),
    number text NOT NULL CHECK (btrim(number) <> ''),
    signed_at date NOT NULL,
    valid_until date,
    amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'closed')),
    note text,
    UNIQUE (organization_id, number),
    CHECK (valid_until IS NULL OR valid_until >= signed_at)
);

CREATE TABLE IF NOT EXISTS project.procurement_tenders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id bigint NOT NULL REFERENCES project.medical_organizations(id),
    title text NOT NULL CHECK (btrim(title) <> ''),
    announced_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closes_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'announced'
        CHECK (status IN ('announced', 'evaluating', 'awarded', 'cancelled')),
    budget numeric(14, 2) NOT NULL CHECK (budget >= 0),
    winner_supplier_id bigint REFERENCES project.suppliers(id),
    note text,
    CHECK (closes_at > announced_at),
    CHECK (status <> 'awarded' OR winner_supplier_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS project.supplier_invoices (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contract_id bigint NOT NULL REFERENCES project.procurement_contracts(id) ON DELETE CASCADE,
    number text NOT NULL CHECK (btrim(number) <> ''),
    issued_at date NOT NULL,
    due_at date NOT NULL,
    amount numeric(14, 2) NOT NULL CHECK (amount >= 0),
    status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'paid', 'overdue')),
    paid_at timestamptz,
    UNIQUE (contract_id, number),
    CHECK (due_at >= issued_at),
    CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_contracts_org ON project.procurement_contracts(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_tenders_org ON project.procurement_tenders(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_contract ON project.supplier_invoices(contract_id, status);

-- Заказ на поставку может ссылаться на договор.
ALTER TABLE project.supply_orders ADD COLUMN IF NOT EXISTS contract_id bigint
    REFERENCES project.procurement_contracts(id);
CREATE INDEX IF NOT EXISTS idx_supply_orders_contract ON project.supply_orders(contract_id);

-- 3. Маршрут перевозки, пробег и топливо.
ALTER TABLE project.patient_transports ADD COLUMN IF NOT EXISTS distance_km numeric(8, 1);
ALTER TABLE project.patient_transports ADD COLUMN IF NOT EXISTS route_points jsonb;
ALTER TABLE project.patient_transports ADD COLUMN IF NOT EXISTS odometer_start integer;
ALTER TABLE project.patient_transports ADD COLUMN IF NOT EXISTS odometer_end integer;
ALTER TABLE project.patient_transports ADD COLUMN IF NOT EXISTS fuel_liters numeric(8, 1);

ALTER TABLE project.patient_transports DROP CONSTRAINT IF EXISTS patient_transports_distance_check;
ALTER TABLE project.patient_transports ADD CONSTRAINT patient_transports_distance_check
    CHECK (distance_km IS NULL OR distance_km >= 0);
ALTER TABLE project.patient_transports DROP CONSTRAINT IF EXISTS patient_transports_odometer_check;
ALTER TABLE project.patient_transports ADD CONSTRAINT patient_transports_odometer_check
    CHECK (odometer_end IS NULL OR odometer_start IS NULL OR odometer_end >= odometer_start);

COMMIT;
