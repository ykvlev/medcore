-- MEDCORE: deterministic synthetic data. The runner supplies the password HASH
-- through transaction-local medcore.seed_password_hash; no password is in SQL.
BEGIN;
SET LOCAL search_path = project, public;
SET LOCAL TIME ZONE 'Europe/Moscow';

DO $guard$
BEGIN
    IF EXISTS(SELECT 1 FROM project.patients) OR EXISTS(SELECT 1 FROM project.medical_cases)
       OR EXISTS(SELECT 1 FROM project.medical_organizations) OR EXISTS(SELECT 1 FROM project.employees)
       OR EXISTS(SELECT 1 FROM project.laboratories) OR EXISTS(SELECT 1 FROM project.users) THEN
        RAISE EXCEPTION 'Демонстрационное наполнение требует пустых таблиц MEDCORE; существующие данные не изменены'
            USING ERRCODE = '55000';
    END IF;
    IF nullif(current_setting('medcore.seed_password_hash', true), '') IS NULL THEN
        RAISE EXCEPTION 'Не передан хеш демонстрационного пароля' USING ERRCODE = '22023';
    END IF;
    IF get_byte(decode(current_setting('medcore.seed_password_hash'), 'base64'), 0) <> 1 THEN
        RAISE EXCEPTION 'Требуется хеш ASP.NET Identity V3' USING ERRCODE = '22023';
    END IF;
END;
$guard$;

CREATE TEMP TABLE seed_org(n integer, kind text, id bigint, PRIMARY KEY(kind,n)) ON COMMIT DROP;
CREATE TEMP TABLE seed_building(n integer PRIMARY KEY, id bigint, hospital_id bigint) ON COMMIT DROP;
CREATE TEMP TABLE seed_department(n integer PRIMARY KEY, id bigint, hospital_id bigint, specialization_id bigint) ON COMMIT DROP;
CREATE TEMP TABLE seed_ward(n integer PRIMARY KEY, id bigint, department_id bigint) ON COMMIT DROP;
CREATE TEMP TABLE seed_bed(n integer PRIMARY KEY, id bigint, department_id bigint, hospital_id bigint) ON COMMIT DROP;
CREATE TEMP TABLE seed_employee(n integer PRIMARY KEY, id bigint, hospital_id bigint, polyclinic_id bigint) ON COMMIT DROP;
CREATE TEMP TABLE seed_patient(n integer PRIMARY KEY, id bigint, polyclinic_id bigint) ON COMMIT DROP;
CREATE TEMP TABLE seed_case(n integer PRIMARY KEY, id bigint, patient_id bigint, organization_id bigint,
    doctor_id bigint, opened_at timestamptz, closed_at timestamptz) ON COMMIT DROP;
CREATE TEMP TABLE seed_hospitalization(n integer PRIMARY KEY, id bigint, case_id bigint, doctor_id bigint,
    admitted_at timestamptz, discharged_at timestamptz) ON COMMIT DROP;
CREATE TEMP TABLE seed_laboratory(n integer PRIMARY KEY, id bigint) ON COMMIT DROP;
CREATE TEMP TABLE seed_contract(n integer PRIMARY KEY, id bigint, laboratory_id bigint, organization_id bigint) ON COMMIT DROP;

DO $seed$
DECLARE
    anchor_date date := coalesce(nullif(current_setting('medcore.seed_anchor_date', true), '')::date, date '2026-10-30');
    anchor timestamptz;
    v_n integer; k integer; v_id bigint; v_other bigint; v_category bigint;
    v_degree bigint; v_title bigint; v_specialty bigint; v_hospital bigint; v_clinic bigint;
    v_doctor bigint; v_user bigint; v_role bigint; v_admin bigint; v_lab_user bigint;
    v_patient bigint; v_case bigint; v_referral bigint; v_bed bigint; v_department bigint;
    v_source_case bigint; v_specialization bigint; v_admit timestamptz; v_discharge timestamptz;
    v_lab bigint; v_contract bigint; v_profile bigint; v_test bigint; v_order bigint;
    v_record record; v_name text; v_code text; v_login text; v_role_code text;
    last_names text[] := ARRAY['Иванов','Петров','Смирнов','Кузнецов','Попов','Васильев','Соколов','Михайлов','Новиков','Фёдоров',
        'Морозов','Волков','Алексеев','Лебедев','Семёнов','Егоров','Павлов','Козлов','Степанов','Николаев'];
    male_names text[] := ARRAY['Александр','Михаил','Иван','Дмитрий','Андрей','Сергей','Артём','Максим','Николай','Павел'];
    female_names text[] := ARRAY['Анна','Мария','Елена','Ольга','Ирина','Наталья','Татьяна','Светлана','Дарья','Екатерина'];
    male_patronymics text[] := ARRAY['Александрович','Михайлович','Иванович','Дмитриевич','Андреевич'];
    female_patronymics text[] := ARRAY['Александровна','Михайловна','Ивановна','Дмитриевна','Андреевна'];
    specialty_codes text[] := ARRAY['surgeon','therapist','neurologist','ophthalmologist','dentist','radiologist','gynecologist','anesthesiologist'];
    specialty_names text[] := ARRAY['Хирург','Терапевт','Невролог','Офтальмолог','Стоматолог','Рентгенолог','Гинеколог','Анестезиолог'];
    login_names text[] := ARRAY['admin','manager','doctor','registrar','lab','analyst'];
    role_codes text[] := ARRAY['system_admin','organization_admin','doctor','registrar','lab_staff','analyst'];
    role_names text[] := ARRAY['Системный администратор','Администратор организации','Врач','Регистратор','Сотрудник лаборатории','Аналитик'];
BEGIN
    IF anchor_date < date '2020-01-01' OR anchor_date > timezone('Europe/Moscow', CURRENT_TIMESTAMP)::date THEN
        RAISE EXCEPTION 'Опорная дата должна быть между 01.01.2020 и текущей датой' USING ERRCODE = '22023';
    END IF;
    anchor := anchor_date::timestamp AT TIME ZONE 'Europe/Moscow';

    INSERT INTO project.academic_degrees(code,name,degree_rank) VALUES
        ('none','Без научной степени',0), ('candidate','Кандидат медицинских наук',1), ('doctor','Доктор медицинских наук',2)
        ON CONFLICT(code) DO NOTHING;
    INSERT INTO project.academic_titles(code,name,minimum_degree_rank) VALUES
        ('none','Без учёного звания',0), ('docent','Доцент',1), ('professor','Профессор',2)
        ON CONFLICT(code) DO NOTHING;
    INSERT INTO project.employee_categories(code,name) VALUES
        ('doctor','Врачебный персонал'), ('system_admin','Системное администрирование'),
        ('organization_admin','Администрация учреждения'), ('registrar','Регистратура'),
        ('lab_staff','Лабораторный персонал'), ('analyst','Аналитический отдел'),
        ('nurse','Средний медицинский персонал'), ('sanitarian','Младший медицинский персонал'), ('cleaner','Хозяйственный персонал')
        ON CONFLICT(code) DO NOTHING;
    FOR v_n IN 1..8 LOOP
        INSERT INTO project.specialties(code,name,allows_surgery)
            VALUES(specialty_codes[v_n],specialty_names[v_n],v_n IN (1,5,7)) ON CONFLICT(code) DO NOTHING;
    END LOOP;
    INSERT INTO project.specialty_conditions(specialty_id,pay_coefficient,extra_leave_days,configuration_note)
        SELECT id, CASE WHEN code IN ('dentist','radiologist') THEN 1.15 ELSE 1 END,
            CASE WHEN code IN ('radiologist','neurologist') THEN 7 ELSE 0 END,
            'Учебные параметры MEDCORE; не являются нормами трудового законодательства'
        FROM project.specialties ON CONFLICT(specialty_id) DO NOTHING;
    INSERT INTO project.department_specializations(code,name) VALUES
        ('surgical','Хирургическое направление'),('therapeutic','Терапевтическое направление'),
        ('neurological','Неврологическое направление'),('ophthalmic','Офтальмологическое направление'),
        ('gynecological','Гинекологическое направление') ON CONFLICT(code) DO NOTHING;
    INSERT INTO project.diagnoses(code,name) VALUES
        ('I10','Эссенциальная (первичная) гипертензия'),
        ('E11.9','Сахарный диабет 2 типа без осложнений'),
        ('J18.9','Пневмония неуточнённая'),
        ('K29.7','Гастрит неуточнённый'),
        ('M54.5','Боль в нижней части спины') ON CONFLICT(code) DO NOTHING;

    FOR v_n IN 1..5 LOOP
        INSERT INTO project.medical_organizations(name,organization_type,address,phone,email,is_active)
            VALUES('Учебная городская больница №'||v_n,'hospital','Учебный город, Больничная улица, д. '||v_n,
                '+7 (000) 100-00-'||lpad(v_n::text,2,'0'),'hospital'||v_n||'@example.test',false) RETURNING id INTO v_id;
        INSERT INTO project.hospitals(organization_id) VALUES(v_id);
        INSERT INTO seed_org VALUES(v_n,'hospital',v_id);
    END LOOP;
    FOR v_n IN 1..8 LOOP
        SELECT id INTO v_hospital FROM seed_org WHERE kind='hospital' AND seed_org.n=(v_n-1)%5+1;
        INSERT INTO project.medical_organizations(name,organization_type,address,phone,email,is_active)
            VALUES('Учебная поликлиника №'||v_n,'polyclinic','Учебный город, Поликлиническая улица, д. '||v_n,
                '+7 (000) 200-00-'||lpad(v_n::text,2,'0'),'polyclinic'||v_n||'@example.test',true) RETURNING id INTO v_id;
        INSERT INTO project.polyclinics(organization_id,hospital_id) VALUES(v_id,CASE WHEN v_n<=6 THEN v_hospital ELSE NULL END);
        INSERT INTO seed_org VALUES(v_n,'polyclinic',v_id);
    END LOOP;
    FOR v_n IN 1..12 LOOP
        SELECT id INTO v_hospital FROM seed_org WHERE kind='hospital' AND seed_org.n=(v_n-1)%5+1;
        INSERT INTO project.buildings(hospital_id,code,address)
            VALUES(v_hospital,'Корпус '||v_n,'Учебный город, Больничная улица, корпус '||v_n) RETURNING id INTO v_id;
        INSERT INTO seed_building VALUES(v_n,v_id,v_hospital);
    END LOOP;
    FOR v_n IN 1..30 LOOP
        SELECT * INTO v_record FROM seed_building WHERE seed_building.n=(v_n-1)%12+1;
        SELECT id INTO v_specialization FROM project.department_specializations ORDER BY id OFFSET ((v_n-1)%5) LIMIT 1;
        INSERT INTO project.departments(building_id,specialization_id,name)
            VALUES(v_record.id,v_specialization,'Учебное отделение №'||v_n) RETURNING id INTO v_id;
        INSERT INTO seed_department VALUES(v_n,v_id,v_record.hospital_id,v_specialization);
    END LOOP;
    FOR v_n IN 1..100 LOOP
        SELECT id INTO v_department FROM seed_department WHERE seed_department.n=(v_n-1)%30+1;
        INSERT INTO project.wards(department_id,number,planned_capacity)
            VALUES(v_department,'П-'||lpad(v_n::text,3,'0'),3) RETURNING id INTO v_id;
        INSERT INTO seed_ward VALUES(v_n,v_id,v_department);
    END LOOP;
    FOR v_n IN 1..300 LOOP
        SELECT sw.id,sw.department_id,sd.hospital_id INTO v_record
            FROM seed_ward sw JOIN seed_department sd ON sd.id=sw.department_id WHERE sw.n=(v_n-1)/3+1;
        INSERT INTO project.beds(ward_id,number) VALUES(v_record.id,((v_n-1)%3+1)::text) RETURNING id INTO v_id;
        INSERT INTO seed_bed VALUES(v_n,v_id,v_record.department_id,v_record.hospital_id);
    END LOOP;
    UPDATE project.medical_organizations SET is_active=true WHERE organization_type='hospital';

    FOR v_n IN 1..200 LOOP
        v_code := CASE WHEN v_n<=120 THEN 'doctor' WHEN v_n=121 THEN 'system_admin'
            WHEN v_n=122 THEN 'organization_admin' WHEN v_n=123 THEN 'registrar' WHEN v_n=124 THEN 'lab_staff'
            WHEN v_n=125 THEN 'analyst' WHEN v_n%3=0 THEN 'nurse' WHEN v_n%3=1 THEN 'sanitarian' ELSE 'cleaner' END;
        SELECT id INTO v_category FROM project.employee_categories WHERE code=v_code;
        INSERT INTO project.employees(category_id,last_name,first_name,middle_name,birth_date,phone,email)
            VALUES(v_category,last_names[(v_n-1)%20+1]||CASE WHEN v_n%2=0 THEN 'а' ELSE '' END,
                CASE WHEN v_n%2=0 THEN female_names[((v_n-1)/20)%10+1] ELSE male_names[((v_n-1)/20)%10+1] END,
                CASE WHEN v_n%2=0 THEN female_patronymics[(v_n-1)%5+1] ELSE male_patronymics[(v_n-1)%5+1] END,
                date '1965-01-01'+((v_n*137)%9000),'+7 (000) 300-'||lpad(v_n::text,4,'0'),
                'employee'||v_n||'@example.test') RETURNING id INTO v_id;
        SELECT id INTO v_hospital FROM seed_org WHERE kind='hospital' AND seed_org.n=CASE
            WHEN v_n<=120 THEN (v_n-1)/24+1 WHEN v_n<=125 THEN 1 ELSE (v_n-121)%5+1 END;
        SELECT id INTO v_clinic FROM seed_org WHERE kind='polyclinic' AND seed_org.n=(v_n-1)%8+1;
        INSERT INTO seed_employee VALUES(v_n,v_id,v_hospital,CASE WHEN v_n<=120 THEN v_clinic ELSE NULL END);
        INSERT INTO project.employments(employee_id,organization_id,position_name,started_on,workload_fraction)
            VALUES(v_id,v_hospital,CASE WHEN v_n<=120 THEN 'Врач' ELSE 'Сотрудник' END,
                date '2010-01-01'+CASE WHEN v_n<=120 THEN (((v_n-1)%12)*365)::int ELSE 0 END,1);
        IF v_n<=120 THEN
            v_code := CASE WHEN v_n%24=1 THEN 'professor' WHEN v_n%12=0 THEN 'docent' ELSE 'none' END;
            SELECT id INTO v_title FROM project.academic_titles WHERE code=v_code;
            SELECT id INTO v_degree FROM project.academic_degrees WHERE code=CASE
                WHEN v_code='professor' THEN 'doctor' WHEN v_code='docent' THEN 'candidate' ELSE 'none' END;
            INSERT INTO project.doctors(employee_id,academic_degree_id,academic_title_id,qualification)
                VALUES(v_id,v_degree,v_title,'Учебная квалификационная категория');
            v_code:=CASE WHEN (v_n-1)%24=0 THEN 'surgeon' WHEN (v_n-1)%24=1 THEN 'gynecologist' ELSE specialty_codes[(v_n-1)%8+1] END;
            SELECT id INTO v_specialty FROM project.specialties WHERE code=v_code;
            INSERT INTO project.doctor_specialties(doctor_id,specialty_id,certified_on)
                VALUES(v_id,v_specialty,date '2010-01-01');
            IF v_n%10=0 THEN
                SELECT id INTO v_specialty FROM project.specialties WHERE code='therapist';
                INSERT INTO project.doctor_specialties(doctor_id,specialty_id,certified_on)
                    VALUES(v_id,v_specialty,date '2011-01-01') ON CONFLICT DO NOTHING;
            END IF;
            INSERT INTO project.employments(employee_id,organization_id,position_name,started_on,workload_fraction)
                VALUES(v_id,v_clinic,'Врач по совместительству',date '2012-01-01',0.5);
            IF v_code IS NULL THEN RAISE EXCEPTION 'Не определена специальность'; END IF;
        END IF;
    END LOOP;
    INSERT INTO project.employments(employee_id,organization_id,position_name,started_on,workload_fraction)
        SELECT e.id,o.id,'Сотрудник по совместительству',date '2012-01-01',0.5
        FROM seed_employee e CROSS JOIN seed_org o
        WHERE e.n IN (122,123) AND o.kind='polyclinic' AND o.n=1;
    INSERT INTO project.consultation_assignments(doctor_id,organization_id,started_on)
        SELECT e.id,o.id,date '2015-01-01' FROM seed_employee e
        CROSS JOIN seed_org o WHERE e.n IN (1,25,49,73,97) AND o.kind='polyclinic' AND o.n IN (2,3);

    FOR v_n IN 1..6 LOOP
        INSERT INTO project.laboratories(name,address,phone,email)
            VALUES('Учебная лаборатория №'||v_n,'Учебный город, Лабораторный переулок, д. '||v_n,
                '+7 (000) 400-00-'||lpad(v_n::text,2,'0'),'laboratory'||v_n||'@example.test') RETURNING id INTO v_id;
        INSERT INTO seed_laboratory VALUES(v_n,v_id);
    END LOOP;
    INSERT INTO project.laboratory_profiles(code,name) VALUES
        ('biochemical','Биохимический'),('physiological','Физиологический'),('chemical','Химический') ON CONFLICT(code) DO NOTHING;
    INSERT INTO project.laboratory_profile_links(laboratory_id,profile_id)
        SELECT l.id,p.id FROM seed_laboratory l CROSS JOIN project.laboratory_profiles p;
    INSERT INTO project.lab_test_types(profile_id,code,name,measurement_unit,reference_description)
        SELECT id,'DEMO-TEST-'||code,'Учебное исследование — '||name,'условная единица',
            'Учебный диапазон 0–100; не используется для клинической интерпретации' FROM project.laboratory_profiles;
    FOR v_n IN 1..20 LOOP
        k := CASE WHEN v_n<=13 THEN v_n ELSE v_n-13 END;
        SELECT id INTO v_other FROM seed_org WHERE kind=CASE WHEN k<=5 THEN 'hospital' ELSE 'polyclinic' END
            AND seed_org.n=CASE WHEN k<=5 THEN k ELSE k-5 END;
        -- Lab 1 processes the seeded completed orders; the other five labs have
        -- valid contracts ready for further demonstrations. The single lab demo
        -- account is never credited with results from an unauthorized laboratory.
        SELECT id INTO v_lab FROM seed_laboratory WHERE seed_laboratory.n=CASE
            WHEN v_n BETWEEN 6 AND 13 THEN 1 WHEN v_n<=5 THEN v_n+1 ELSE (v_n-14)%5+2 END;
        INSERT INTO project.laboratory_contracts(laboratory_id,organization_id,contract_number,valid_from,valid_until)
            VALUES(v_lab,v_other,'DEMO-'||lpad(v_n::text,3,'0'),anchor_date-365,anchor_date+365) RETURNING id INTO v_id;
        INSERT INTO seed_contract VALUES(v_n,v_id,v_lab,v_other);
    END LOOP;

    FOR v_n IN 1..6 LOOP
        v_login:=login_names[v_n]; v_role_code:=role_codes[v_n];
        SELECT id INTO v_doctor FROM seed_employee WHERE seed_employee.n=CASE v_n WHEN 1 THEN 121 WHEN 2 THEN 122
            WHEN 3 THEN 1 WHEN 4 THEN 123 WHEN 5 THEN 124 ELSE 125 END;
        INSERT INTO project.users(employee_id,login,password_hash)
            VALUES(v_doctor,v_login,current_setting('medcore.seed_password_hash')) RETURNING id INTO v_user;
        INSERT INTO project.roles(code,name) VALUES(v_role_code,role_names[v_n])
            ON CONFLICT(code) DO UPDATE SET name=excluded.name RETURNING id INTO v_role;
        INSERT INTO project.user_roles(user_id,role_id) VALUES(v_user,v_role);
        IF v_n=1 THEN v_admin:=v_user;
        ELSIF v_n=5 THEN
            v_lab_user:=v_user;
            SELECT id INTO v_lab FROM seed_laboratory WHERE seed_laboratory.n=1;
            INSERT INTO project.user_organization_scopes(user_id,role_id,laboratory_id) VALUES(v_user,v_role,v_lab);
        ELSIF v_n=6 THEN
            INSERT INTO project.user_organization_scopes(user_id,role_id,organization_id)
                SELECT v_user,v_role,id FROM seed_org;
        ELSE
            INSERT INTO project.user_organization_scopes(user_id,role_id,organization_id)
                SELECT v_user,v_role,id FROM seed_org WHERE seed_org.n=1;
        END IF;
    END LOOP;
    -- A technical owner loads fixtures; the system-admin demo account is not
    -- misrepresented as having patient/clinical permissions.
    PERFORM set_config('medcore.actor_user_id','',true);
    PERFORM set_config('medcore.request_id','medcore-demo-seed',true);

    FOR v_n IN 1..1000 LOOP
        SELECT id INTO v_clinic FROM seed_org WHERE kind='polyclinic' AND seed_org.n=(v_n-1)%8+1;
        INSERT INTO project.patients(last_name,first_name,middle_name,birth_date,sex,phone,email,address)
            VALUES(last_names[(v_n-1)%20+1]||CASE WHEN v_n%2=0 THEN 'а' ELSE '' END,
                CASE WHEN v_n%2=0 THEN female_names[((v_n-1)/20)%10+1] ELSE male_names[((v_n-1)/20)%10+1] END,
                CASE WHEN v_n%2=0 THEN female_patronymics[((v_n-1)/200)%5+1] ELSE male_patronymics[((v_n-1)/200)%5+1] END,
                date '1950-01-01'+((v_n*43)%18000),CASE WHEN v_n%2=0 THEN 'female' ELSE 'male' END,
                '+7 (000) 500-'||lpad(v_n::text,4,'0'),'patient'||v_n||'@example.test',
                'Учебный город, Демонстрационная улица, д. '||((v_n-1)%100+1)) RETURNING id INTO v_patient;
        INSERT INTO seed_patient VALUES(v_n,v_patient,v_clinic);
        INSERT INTO project.patient_attachments(patient_id,polyclinic_id,started_at)
            VALUES(v_patient,v_clinic,anchor-interval '300 days');
    END LOOP;
    -- 1500 outpatient cases: one per patient, then another for patients 501..1000.
    FOR v_n IN 1..1500 LOOP
        k:=CASE WHEN v_n<=1000 THEN v_n ELSE v_n-500 END;
        SELECT * INTO v_record FROM seed_patient WHERE seed_patient.n=k;
        SELECT e.id INTO v_doctor FROM seed_employee e WHERE e.n<=120 AND e.polyclinic_id=v_record.polyclinic_id ORDER BY e.n LIMIT 1;
        v_admit:=anchor-CASE WHEN v_n<=1000 THEN interval '150 days' ELSE interval '40 days' END
            + ((v_n-1)%20)*interval '1 day';
        -- The referral is issued while its source case is still open. In the
        -- deterministic history the source closes one hour after that referral.
        v_discharge:=CASE WHEN v_n<=400 THEN anchor-interval '121 days'+((v_n-1)/300)*interval '40 days'+interval '1 hour'
            WHEN v_n<=500 THEN anchor-interval '4 days'+((v_n-401)%24)*interval '1 hour'+interval '1 hour'
            ELSE v_admit+interval '1 day' END;
        INSERT INTO project.medical_cases(patient_id,organization_id,case_type,status,opened_at,closed_at,reason)
            VALUES(v_record.id,v_record.polyclinic_id,'outpatient','closed',v_admit,v_discharge,
                'Вымышленное амбулаторное обращение №'||v_n) RETURNING id INTO v_case;
        INSERT INTO seed_case VALUES(v_n,v_case,v_record.id,v_record.polyclinic_id,v_doctor,v_admit,v_discharge);
        INSERT INTO project.appointments(case_id,scheduled_at,status,completed_at)
            VALUES(v_case,v_admit+interval '1 hour','completed',v_admit+interval '90 minutes') RETURNING id INTO v_id;
        INSERT INTO project.appointment_doctors(appointment_id,doctor_id) VALUES(v_id,v_doctor);
    END LOOP;
    FOR v_n IN 1..500 LOOP
        SELECT * INTO v_record FROM seed_bed WHERE seed_bed.n=CASE WHEN v_n<=400 THEN (v_n-1)%300+1 ELSE v_n-400 END;
        v_bed:=v_record.id; v_hospital:=v_record.hospital_id; v_department:=v_record.department_id;
        SELECT specialization_id INTO v_specialization FROM seed_department WHERE id=v_department;
        SELECT id INTO v_doctor FROM seed_employee WHERE seed_employee.n<=120 AND hospital_id=v_hospital ORDER BY seed_employee.n LIMIT 1;
        SELECT id,patient_id INTO v_source_case,v_patient FROM seed_case WHERE seed_case.n=v_n;
        v_admit:=CASE WHEN v_n<=400 THEN anchor-interval '120 days'+((v_n-1)/300)*interval '40 days'
            ELSE anchor-interval '3 days'+((v_n-401)%24)*interval '1 hour' END;
        v_discharge:=CASE WHEN v_n<=400 THEN v_admit+interval '5 days'+(v_n%5)*interval '1 day' ELSE NULL END;
        INSERT INTO project.referrals(case_id,referring_doctor_id,target_hospital_id,specialization_id,issued_at,reason,status)
            SELECT v_source_case,c.doctor_id,v_hospital,v_specialization,v_admit-interval '1 day',
                'Вымышленное направление №'||v_n,'used' FROM seed_case c WHERE c.id=v_source_case RETURNING id INTO v_referral;
        INSERT INTO project.medical_cases(patient_id,organization_id,case_type,status,opened_at,closed_at,reason)
            VALUES(v_patient,v_hospital,'inpatient',CASE WHEN v_n<=400 THEN 'closed' ELSE 'open' END,
                v_admit,v_discharge,'Вымышленное стационарное лечение №'||v_n) RETURNING id INTO v_case;
        INSERT INTO seed_case VALUES(1500+v_n,v_case,v_patient,v_hospital,v_doctor,v_admit,v_discharge);
        INSERT INTO project.hospitalizations(case_id,patient_id,referral_id,department_id,admitted_at,discharged_at,status,discharge_summary)
            VALUES(v_case,v_patient,v_referral,v_department,v_admit,v_discharge,
                (CASE WHEN v_n<=400 THEN 'discharged' ELSE 'active' END)::project.hospitalization_status,
                CASE WHEN v_n<=400 THEN 'Учебная выписка; медицинских рекомендаций не содержит' ELSE NULL END)
                RETURNING id INTO v_id;
        INSERT INTO seed_hospitalization VALUES(v_n,v_id,v_case,v_doctor,v_admit,v_discharge);
        INSERT INTO project.bed_occupancies(hospitalization_id,bed_id,started_at,ended_at)
            VALUES(v_id,v_bed,v_admit,v_discharge);
        INSERT INTO project.attending_physician_history(hospitalization_id,doctor_id,started_at,ended_at)
            VALUES(v_id,v_doctor,v_admit,v_discharge);
    END LOOP;
    FOR v_record IN SELECT * FROM seed_case ORDER BY seed_case.n LOOP
        INSERT INTO project.case_diagnoses(case_id,diagnosis_id,doctor_id,recorded_at,is_primary,note)
            SELECT v_record.id,id,v_record.doctor_id,v_record.opened_at+interval '2 hours',true,'Вымышленная запись'
            FROM project.diagnoses WHERE code=(ARRAY['I10','E11.9','J18.9','K29.7','M54.5'])[(v_record.n-1)%5+1];
        INSERT INTO project.medical_record_entries(case_id,doctor_id,entry_type,content,recorded_at)
            VALUES(v_record.id,v_record.doctor_id,'examination','Демонстрационная запись осмотра №'||v_record.n||
                '. Все сведения вымышлены.',v_record.opened_at+interval '2 hours');
        INSERT INTO project.prescriptions(case_id,doctor_id,description,prescribed_at,started_on,ended_on,status)
            VALUES(v_record.id,v_record.doctor_id,'Учебное назначение: контрольный осмотр',v_record.opened_at+interval '3 hours',
                v_record.opened_at::date,coalesce(v_record.closed_at::date,anchor_date+7),
                CASE WHEN v_record.closed_at IS NULL THEN 'active' ELSE 'completed' END);
    END LOOP;
    FOR v_n IN 1..200 LOOP
        SELECT * INTO v_record FROM seed_hospitalization WHERE seed_hospitalization.n=v_n;
        INSERT INTO project.surgeries(case_id,name,started_at,ended_at,outcome,note)
            VALUES(v_record.case_id,'Учебная операция №'||v_n,v_record.admitted_at+interval '2 days',
                v_record.admitted_at+interval '2 days 1 hour',CASE WHEN v_n%40=0 THEN 'fatal' ELSE 'survived' END,
                'Искусственное событие для проверки статистики') RETURNING id INTO v_id;
        SELECT id INTO v_specialty FROM project.specialties WHERE code='surgeon';
        INSERT INTO project.surgery_participants(surgery_id,doctor_id,specialty_id,participation_role)
            VALUES(v_id,v_record.doctor_id,v_specialty,'lead');
    END LOOP;
    FOR v_n IN 1..600 LOOP
        SELECT * INTO v_record FROM seed_case WHERE seed_case.n=v_n;
        SELECT id,laboratory_id INTO v_contract,v_lab FROM seed_contract
            WHERE organization_id=v_record.organization_id ORDER BY seed_contract.n LIMIT 1;
        SELECT id INTO v_test FROM project.lab_test_types ORDER BY id OFFSET ((v_n-1)%3) LIMIT 1;
        INSERT INTO project.lab_orders(case_id,doctor_id,test_type_id,contract_id,ordered_at,status,note)
            VALUES(v_record.id,v_record.doctor_id,v_test,v_contract,v_record.opened_at+interval '3 hours',
                CASE WHEN v_n<=500 THEN 'completed' WHEN v_n<=550 THEN 'ordered' ELSE 'in_progress' END,
                'Вымышленное исследование №'||v_n) RETURNING id INTO v_order;
        IF v_n<=500 THEN
            INSERT INTO project.lab_results(order_id,entered_by_user_id,result_text,numeric_value,measured_at,entered_at)
                VALUES(v_order,v_lab_user,'Демонстрационный результат: '||((v_n*7)%100),((v_n*7)%100),
                    v_record.opened_at+interval '4 hours',v_record.opened_at+interval '5 hours');
        END IF;
    END LOOP;
    PERFORM project.fn_assert_business_rules();
END;
$seed$;

-- Explicit assertions guard against accidental changes to generator cardinality.
DO $counts$
BEGIN
    IF (SELECT count(*) FROM project.hospitals)<>5 OR (SELECT count(*) FROM project.polyclinics)<>8
       OR (SELECT count(*) FROM project.buildings)<>12 OR (SELECT count(*) FROM project.departments)<>30
       OR (SELECT count(*) FROM project.wards)<>100 OR (SELECT count(*) FROM project.beds)<>300
       OR (SELECT count(*) FROM project.doctors)<>120 OR (SELECT count(*) FROM project.employees)<>200
       OR (SELECT count(*) FROM project.patients)<>1000 OR (SELECT count(*) FROM project.medical_cases)<>2000
       OR (SELECT count(*) FROM project.hospitalizations)<>500 OR (SELECT count(*) FROM project.surgeries)<>200
       OR (SELECT count(*) FROM project.laboratories)<>6 OR (SELECT count(*) FROM project.laboratory_contracts)<>20
       OR (SELECT count(*) FROM project.lab_results)<>500 OR (SELECT count(*) FROM project.users)<>6
       OR (SELECT count(*) FROM project.hospitalizations WHERE status='active')<>100
       OR (SELECT count(*) FROM project.hospitalizations WHERE status='discharged')<>400 THEN
        RAISE EXCEPTION 'Фактический объём демонстрационных данных не соответствует ожидаемому';
    END IF;
END;
$counts$;
COMMIT;
