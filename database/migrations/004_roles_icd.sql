-- MEDCORE, миграция 004: расширение ролей, областей и справочника МКБ-10.
-- Добавляет роли главного врача, заместителя, заведующего отделением, министра
-- и губернатора, область отделения, главы МКБ-10 и демонстрационные учётные
-- записи. Существующие строки и ссылки не удаляются.
BEGIN;
SET LOCAL search_path = project, public;
SELECT set_config('medcore.actor_user_id',
    coalesce((SELECT id::text FROM project.users WHERE login = 'admin'), ''), true);
SELECT set_config('medcore.request_id', 'migration-004', true);

-- 1. Область отделения для заведующего.
ALTER TABLE project.user_organization_scopes
    ADD COLUMN IF NOT EXISTS department_id bigint REFERENCES project.departments(id);
CREATE INDEX IF NOT EXISTS idx_scopes_department ON project.user_organization_scopes(department_id);

-- 2. Главы МКБ-10 и признак активности диагноза.
ALTER TABLE project.diagnoses ADD COLUMN IF NOT EXISTS chapter text;
ALTER TABLE project.diagnoses ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- 3. Допустимые коды ролей: шесть прежних и пять новых.
ALTER TABLE project.roles DROP CONSTRAINT IF EXISTS roles_code_check;
ALTER TABLE project.roles ADD CONSTRAINT roles_code_check CHECK (code IN (
    'system_admin', 'organization_admin', 'doctor', 'registrar', 'lab_staff', 'analyst',
    'chief_physician', 'deputy_chief_physician', 'head_of_department',
    'minister_of_health', 'governor'));

INSERT INTO project.roles(code, name) VALUES
    ('chief_physician', 'Главный врач'),
    ('deputy_chief_physician', 'Заместитель главного врача'),
    ('head_of_department', 'Заведующий отделением'),
    ('minister_of_health', 'Министр здравоохранения'),
    ('governor', 'Губернатор')
ON CONFLICT (code) DO UPDATE SET name = excluded.name;

-- 4. Категории персонала для новых должностей.
INSERT INTO project.employee_categories(code, name) VALUES
    ('chief_physician', 'Главный врач'),
    ('deputy_chief_physician', 'Заместитель главного врача'),
    ('head_of_department', 'Заведующий отделением'),
    ('minister', 'Министерство здравоохранения'),
    ('governor', 'Правительство региона')
ON CONFLICT (code) DO UPDATE SET name = excluded.name;

-- 5. МКБ-10. Пять учебных кодов заменяются реальными; ссылки case_diagnoses
--    сохраняются, потому что обновляются существующие строки по id.
UPDATE project.diagnoses SET code = 'I10', name = 'Эссенциальная (первичная) гипертензия', chapter = 'IX'
    WHERE code = 'DEMO-01';
UPDATE project.diagnoses SET code = 'E11.9', name = 'Сахарный диабет 2 типа без осложнений', chapter = 'IV'
    WHERE code = 'DEMO-02';
UPDATE project.diagnoses SET code = 'J18.9', name = 'Пневмония неуточнённая', chapter = 'X'
    WHERE code = 'DEMO-03';
UPDATE project.diagnoses SET code = 'K29.7', name = 'Гастрит неуточнённый', chapter = 'XI'
    WHERE code = 'DEMO-04';
UPDATE project.diagnoses SET code = 'M54.5', name = 'Боль в нижней части спины', chapter = 'XIII'
    WHERE code = 'DEMO-05';

INSERT INTO project.diagnoses(code, name, chapter) VALUES
    ('A09', 'Диарея и гастроэнтерит предположительно инфекционного происхождения', 'I'),
    ('A15.0', 'Туберкулёз лёгких, подтверждённый микроскопией мазка', 'I'),
    ('B34.9', 'Вирусная инфекция неуточнённая', 'I'),
    ('C34.9', 'Злокачественное новообразование бронхов или лёгкого неуточнённое', 'II'),
    ('C50.9', 'Злокачественное новообразование молочной железы неуточнённое', 'II'),
    ('D50.9', 'Железодефицитная анемия неуточнённая', 'III'),
    ('E03.9', 'Гипотиреоз неуточнённый', 'IV'),
    ('E78.5', 'Гиперлипидемия неуточнённая', 'IV'),
    ('F32.9', 'Депрессивный эпизод неуточнённый', 'V'),
    ('F41.1', 'Генерализованное тревожное расстройство', 'V'),
    ('G40.9', 'Эпилепсия неуточнённая', 'VI'),
    ('G43.9', 'Мигрень неуточнённая', 'VI'),
    ('H10.9', 'Конъюнктивит неуточнённый', 'VII'),
    ('H25.9', 'Старческая катаракта неуточнённая', 'VII'),
    ('I20.9', 'Стенокардия неуточнённая', 'IX'),
    ('I21.9', 'Острый инфаркт миокарда неуточнённый', 'IX'),
    ('I25.1', 'Атеросклеротическая болезнь сердца', 'IX'),
    ('I48', 'Фибрилляция и трепетание предсердий', 'IX'),
    ('I50.9', 'Сердечная недостаточность неуточнённая', 'IX'),
    ('I63.9', 'Инфаркт мозга неуточнённый', 'IX'),
    ('J06.9', 'Острая инфекция верхних дыхательных путей неуточнённая', 'X'),
    ('J30.1', 'Аллергический ринит, вызванный пыльцой растений', 'X'),
    ('J44.9', 'Хроническая обструктивная болезнь лёгких неуточнённая', 'X'),
    ('J45.9', 'Астма неуточнённая', 'X'),
    ('K21.0', 'Гастроэзофагеальный рефлюкс с эзофагитом', 'XI'),
    ('K35.8', 'Острый аппендицит неуточнённый', 'XI'),
    ('K76.0', 'Жировая дегенерация печени', 'XI'),
    ('K80.2', 'Камни жёлчного пузыря без холецистита', 'XI'),
    ('L20.9', 'Атопический дерматит неуточнённый', 'XII'),
    ('L40.9', 'Псориаз неуточнённый', 'XII'),
    ('M17.9', 'Гонартроз неуточнённый', 'XIII'),
    ('M75.1', 'Синдром сдавления ротатора плеча', 'XIII'),
    ('N18.9', 'Хроническая болезнь почек неуточнённая', 'XIV'),
    ('N20.0', 'Камни почки', 'XIV'),
    ('N39.0', 'Инфекция мочевыводящих путей без установленной локализации', 'XIV'),
    ('O80', 'Роды одноплодные самопроизвольные', 'XV'),
    ('R07.4', 'Боль в области сердца неуточнённая', 'XVIII'),
    ('R51', 'Головная боль', 'XVIII'),
    ('S72.0', 'Перелом шейки бедра', 'XIX'),
    ('T14.9', 'Травма неуточнённая', 'XIX'),
    ('Z00.0', 'Общий медицинский осмотр', 'XXI'),
    ('Z34.9', 'Наблюдение за течением нормальной беременности неуточнённой', 'XXI')
ON CONFLICT (code) DO UPDATE SET name = excluded.name, chapter = excluded.chapter, is_active = true;

-- 6. Демонстрационные учётные записи новых ролей. Пароль совпадает с остальными
--    демонстрационными пользователями: копируется тот же хеш, открытый пароль
--    в базе не хранится.
DO $$
DECLARE
    v_hash text;
    v_hospital bigint;
    v_department bigint;
    v_employee bigint;
    v_user bigint;
    v_role bigint;
BEGIN
    SELECT password_hash INTO v_hash FROM project.users WHERE login = 'admin';
    IF v_hash IS NULL THEN RAISE EXCEPTION 'Не найден демонстрационный администратор'; END IF;

    SELECT o.id INTO v_hospital FROM project.medical_organizations o
        JOIN project.hospitals h ON h.organization_id = o.id
        WHERE o.name = 'Учебная городская больница №1';
    IF v_hospital IS NULL THEN RAISE EXCEPTION 'Не найдена демонстрационная больница'; END IF;
    SELECT d.id INTO v_department FROM project.departments d
        JOIN project.buildings b ON b.id = d.building_id
        WHERE b.hospital_id = v_hospital ORDER BY d.id LIMIT 1;

    INSERT INTO project.employees(category_id, last_name, first_name, middle_name, birth_date, phone, email)
        SELECT c.id, 'Смирнов', 'Виктор', 'Павлович', DATE '1968-03-14', '+7 (000) 700-00-01', 'chief@example.test'
        FROM project.employee_categories c WHERE c.code = 'chief_physician' RETURNING id INTO v_employee;
    INSERT INTO project.users(employee_id, login, password_hash) VALUES (v_employee, 'chief', v_hash)
        ON CONFLICT DO NOTHING RETURNING id INTO v_user;
    IF v_user IS NULL THEN SELECT id INTO v_user FROM project.users WHERE login = 'chief'; END IF;
    SELECT id INTO v_role FROM project.roles WHERE code = 'chief_physician';
    INSERT INTO project.user_roles(user_id, role_id) VALUES (v_user, v_role) ON CONFLICT DO NOTHING;
    INSERT INTO project.user_organization_scopes(user_id, role_id, organization_id) VALUES (v_user, v_role, v_hospital) ON CONFLICT DO NOTHING;

    INSERT INTO project.employees(category_id, last_name, first_name, middle_name, birth_date, phone, email)
        SELECT c.id, 'Ковалёва', 'Ирина', 'Сергеевна', DATE '1975-09-02', '+7 (000) 700-00-02', 'deputy@example.test'
        FROM project.employee_categories c WHERE c.code = 'deputy_chief_physician' RETURNING id INTO v_employee;
    INSERT INTO project.users(employee_id, login, password_hash) VALUES (v_employee, 'deputy', v_hash)
        ON CONFLICT DO NOTHING RETURNING id INTO v_user;
    IF v_user IS NULL THEN SELECT id INTO v_user FROM project.users WHERE login = 'deputy'; END IF;
    SELECT id INTO v_role FROM project.roles WHERE code = 'deputy_chief_physician';
    INSERT INTO project.user_roles(user_id, role_id) VALUES (v_user, v_role) ON CONFLICT DO NOTHING;
    INSERT INTO project.user_organization_scopes(user_id, role_id, organization_id) VALUES (v_user, v_role, v_hospital) ON CONFLICT DO NOTHING;

    INSERT INTO project.employees(category_id, last_name, first_name, middle_name, birth_date, phone, email)
        SELECT c.id, 'Петров', 'Дмитрий', 'Андреевич', DATE '1979-11-21', '+7 (000) 700-00-03', 'head@example.test'
        FROM project.employee_categories c WHERE c.code = 'head_of_department' RETURNING id INTO v_employee;
    INSERT INTO project.users(employee_id, login, password_hash) VALUES (v_employee, 'head', v_hash)
        ON CONFLICT DO NOTHING RETURNING id INTO v_user;
    IF v_user IS NULL THEN SELECT id INTO v_user FROM project.users WHERE login = 'head'; END IF;
    SELECT id INTO v_role FROM project.roles WHERE code = 'head_of_department';
    INSERT INTO project.user_roles(user_id, role_id) VALUES (v_user, v_role) ON CONFLICT DO NOTHING;
    INSERT INTO project.user_organization_scopes(user_id, role_id, organization_id, department_id)
        VALUES (v_user, v_role, v_hospital, v_department) ON CONFLICT DO NOTHING;

    INSERT INTO project.employees(category_id, last_name, first_name, middle_name, birth_date, phone, email)
        SELECT c.id, 'Соколов', 'Андрей', 'Николаевич', DATE '1972-05-30', '+7 (000) 700-00-04', 'minister@example.test'
        FROM project.employee_categories c WHERE c.code = 'minister' RETURNING id INTO v_employee;
    INSERT INTO project.users(employee_id, login, password_hash) VALUES (v_employee, 'minister', v_hash)
        ON CONFLICT DO NOTHING RETURNING id INTO v_user;
    IF v_user IS NULL THEN SELECT id INTO v_user FROM project.users WHERE login = 'minister'; END IF;
    SELECT id INTO v_role FROM project.roles WHERE code = 'minister_of_health';
    INSERT INTO project.user_roles(user_id, role_id) VALUES (v_user, v_role) ON CONFLICT DO NOTHING;

    INSERT INTO project.employees(category_id, last_name, first_name, middle_name, birth_date, phone, email)
        SELECT c.id, 'Морозова', 'Елена', 'Викторовна', DATE '1970-01-18', '+7 (000) 700-00-05', 'governor@example.test'
        FROM project.employee_categories c WHERE c.code = 'governor' RETURNING id INTO v_employee;
    INSERT INTO project.users(employee_id, login, password_hash) VALUES (v_employee, 'governor', v_hash)
        ON CONFLICT DO NOTHING RETURNING id INTO v_user;
    IF v_user IS NULL THEN SELECT id INTO v_user FROM project.users WHERE login = 'governor'; END IF;
    SELECT id INTO v_role FROM project.roles WHERE code = 'governor';
    INSERT INTO project.user_roles(user_id, role_id) VALUES (v_user, v_role) ON CONFLICT DO NOTHING;
END $$;

COMMIT;
