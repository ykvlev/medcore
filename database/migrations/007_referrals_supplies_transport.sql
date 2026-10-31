-- MEDCORE, миграция 007: направления к специалистам, тяжёлые диагнозы,
-- снабжение лекарствами и расходниками, транспортировка пациентов.
BEGIN;
SET LOCAL search_path = project, public;
SELECT set_config('medcore.actor_user_id',
    coalesce((SELECT id::text FROM project.users WHERE login = 'admin'), ''), true);
SELECT set_config('medcore.request_id', 'migration-007', true);

-- 1. Направления: тип, конкретный специалист и срок действия.
ALTER TABLE project.referrals ADD COLUMN IF NOT EXISTS referral_type text NOT NULL DEFAULT 'hospitalization';
ALTER TABLE project.referrals ADD COLUMN IF NOT EXISTS target_doctor_id bigint REFERENCES project.doctors(employee_id);
ALTER TABLE project.referrals ADD COLUMN IF NOT EXISTS valid_until date;
ALTER TABLE project.referrals DROP CONSTRAINT IF EXISTS referrals_status_check;
ALTER TABLE project.referrals ADD CONSTRAINT referrals_status_check
    CHECK (status IN ('issued', 'used', 'cancelled', 'scheduled', 'completed'));
ALTER TABLE project.referrals DROP CONSTRAINT IF EXISTS referrals_type_check;
ALTER TABLE project.referrals ADD CONSTRAINT referrals_type_check
    CHECK (referral_type IN ('hospitalization', 'consultation', 'diagnostic'));
CREATE INDEX IF NOT EXISTS idx_referrals_target_doctor ON project.referrals(target_doctor_id);
CREATE INDEX IF NOT EXISTS idx_referrals_type_status ON project.referrals(referral_type, status);

-- 2. Тяжёлые и опасные диагнозы МКБ-10 для реалистичной истории болезни.
INSERT INTO project.diagnoses(code, name, chapter) VALUES
    ('I21.0', 'Острый трансмуральный инфаркт миокарда передней стенки', 'IX'),
    ('I21.4', 'Острый субэндокардиальный инфаркт миокарда', 'IX'),
    ('I26.9', 'Тромбоэмболия лёгочной артерии без упоминания об остром лёгочном сердце', 'IX'),
    ('I60.9', 'Субарахноидальное кровоизлияние неуточнённое', 'IX'),
    ('I61.9', 'Внутримозговое кровоизлияние неуточнённое', 'IX'),
    ('A40.9', 'Стрептококковый сепсис неуточнённый', 'I'),
    ('A41.9', 'Сепсис неуточнённый', 'I'),
    ('B20', 'Болезнь, вызванная ВИЧ, с проявлениями инфекционных и паразитарных болезней', 'I'),
    ('C18.9', 'Злокачественное новообразование ободочной кишки неуточнённое', 'II'),
    ('C61', 'Злокачественное новообразование предстательной железы', 'II'),
    ('E87.6', 'Гипокалиемия', 'IV'),
    ('F20.9', 'Шизофрения неуточнённая', 'V'),
    ('G41.9', 'Эпилептический статус неуточнённый', 'VI'),
    ('J96.0', 'Острая дыхательная недостаточность', 'X'),
    ('K72.9', 'Печёночная недостаточность неуточнённая', 'XI'),
    ('K92.2', 'Желудочно-кишечное кровотечение неуточнённое', 'XI'),
    ('N17.9', 'Острая почечная недостаточность неуточнённая', 'XIV'),
    ('S06.5', 'Травматическое субдуральное кровоизлияние', 'XIX'),
    ('S72.1', 'Чрезвертельный перелом', 'XIX'),
    ('T78.2', 'Анафилактический шок неуточнённый', 'XIX')
ON CONFLICT (code) DO UPDATE SET name = excluded.name, chapter = excluded.chapter, is_active = true;

-- 3. Снабжение: справочник, остатки, заказы и позиции заказов.
CREATE TABLE IF NOT EXISTS project.supply_items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    category text NOT NULL CHECK (category IN ('medicine', 'consumable')),
    unit text NOT NULL,
    is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS project.supply_stock (
    organization_id bigint NOT NULL REFERENCES project.medical_organizations(id),
    item_id bigint NOT NULL REFERENCES project.supply_items(id),
    quantity numeric(12, 2) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
    min_quantity numeric(12, 2) NOT NULL DEFAULT 0 CHECK (min_quantity >= 0),
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (organization_id, item_id)
);

CREATE TABLE IF NOT EXISTS project.supply_orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id bigint NOT NULL REFERENCES project.medical_organizations(id),
    supplier text NOT NULL CHECK (btrim(supplier) <> ''),
    status text NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered', 'received', 'cancelled')),
    ordered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expected_at date,
    received_at timestamptz,
    note text
);

CREATE TABLE IF NOT EXISTS project.supply_order_items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id bigint NOT NULL REFERENCES project.supply_orders(id) ON DELETE CASCADE,
    item_id bigint NOT NULL REFERENCES project.supply_items(id),
    quantity numeric(12, 2) NOT NULL CHECK (quantity > 0),
    unit_price numeric(12, 2) NOT NULL CHECK (unit_price >= 0),
    UNIQUE (order_id, item_id)
);

CREATE INDEX IF NOT EXISTS idx_supply_orders_org_status ON project.supply_orders(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_supply_stock_item ON project.supply_stock(item_id);

-- 4. Транспортировка пациентов между учреждениями.
CREATE TABLE IF NOT EXISTS project.patient_transports (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id bigint NOT NULL REFERENCES project.patients(id),
    from_organization_id bigint NOT NULL REFERENCES project.medical_organizations(id),
    to_organization_id bigint NOT NULL REFERENCES project.medical_organizations(id),
    referral_id bigint REFERENCES project.referrals(id),
    status text NOT NULL DEFAULT 'requested'
        CHECK (status IN ('requested', 'in_progress', 'completed', 'cancelled')),
    reason text NOT NULL CHECK (btrim(reason) <> ''),
    requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at timestamptz,
    completed_at timestamptz,
    vehicle text,
    accompanying_employee_id bigint REFERENCES project.employees(id),
    CHECK (from_organization_id <> to_organization_id),
    CHECK (completed_at IS NULL OR started_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_transports_status ON project.patient_transports(status);
CREATE INDEX IF NOT EXISTS idx_transports_patient ON project.patient_transports(patient_id);

COMMIT;
