-- Self-contained fixture and assertions after migrations 001, 002, 003.
-- All fixture rows are rolled back. A missing expected exception aborts the test.
BEGIN;
SET LOCAL search_path = project, pg_catalog;
DO $test$
DECLARE
    category_id bigint; degree_none bigint; title_none bigint; title_professor bigint;
    doctor_id bigint; patient_id bigint; hospital1 bigint; hospital2 bigint; clinic bigint;
    building1 bigint; building2 bigint; specialization bigint; department1 bigint; department2 bigint;
    ward1 bigint; ward2 bigint; bed1 bigint; bed2 bigint; other_bed bigint;
    source_case bigint; inpatient_case bigint; referral bigint; hospitalization bigint;
    occupation bigint; physician bigint; laboratory bigint; laboratory2 bigint; profile bigint;
    contract bigint; test_type bigint; lab_order bigint; lab_order2 bigint; result1 bigint;
    cycle_id bigint;
    account bigint; t0 timestamptz := CURRENT_TIMESTAMP - interval '2 days';
    transfer_at timestamptz := CURRENT_TIMESTAMP - interval '1 day';
    tests integer := 0;
BEGIN
    INSERT INTO employee_categories(code, name) VALUES ('doctor', 'Врач') ON CONFLICT (code) DO NOTHING;
    SELECT id INTO category_id FROM employee_categories WHERE code = 'doctor';
    INSERT INTO academic_degrees(code, name, degree_rank) VALUES ('none', 'Нет степени', 0) ON CONFLICT (code) DO NOTHING;
    SELECT id INTO degree_none FROM academic_degrees WHERE code = 'none';
    INSERT INTO academic_titles(code, name, minimum_degree_rank) VALUES ('none', 'Нет звания', 0), ('professor', 'Профессор', 2) ON CONFLICT (code) DO NOTHING;
    SELECT id INTO title_none FROM academic_titles WHERE code = 'none';
    SELECT id INTO title_professor FROM academic_titles WHERE code = 'professor';
    INSERT INTO employees(category_id,last_name,first_name,birth_date)
        VALUES (category_id,'Тестовый002','Врач',DATE '1980-01-01') RETURNING id INTO doctor_id;
    INSERT INTO doctors(employee_id,academic_degree_id,academic_title_id) VALUES (doctor_id,degree_none,title_none);
    INSERT INTO users(employee_id,login,password_hash) VALUES (doctor_id,'__test002','not-a-real-password-hash') RETURNING id INTO account;
    INSERT INTO patients(last_name,first_name,birth_date,sex)
        VALUES ('Тестовый002','Пациент',DATE '1990-01-01','unknown') RETURNING id INTO patient_id;
    INSERT INTO medical_organizations(name,organization_type,address,is_active)
        VALUES ('__test002 hospital1','hospital','Учебный адрес',true) RETURNING id INTO hospital1;
    INSERT INTO medical_organizations(name,organization_type,address,is_active)
        VALUES ('__test002 hospital2','hospital','Учебный адрес',true) RETURNING id INTO hospital2;
    INSERT INTO medical_organizations(name,organization_type,address,is_active)
        VALUES ('__test002 clinic','polyclinic','Учебный адрес',true) RETURNING id INTO clinic;
    INSERT INTO hospitals(organization_id) VALUES (hospital1),(hospital2);
    INSERT INTO polyclinics(organization_id) VALUES (clinic);
    INSERT INTO buildings(hospital_id,code,address) VALUES (hospital1,'__test002','Учебный адрес') RETURNING id INTO building1;
    INSERT INTO buildings(hospital_id,code,address) VALUES (hospital2,'__test002','Учебный адрес') RETURNING id INTO building2;
    INSERT INTO department_specializations(code,name) VALUES ('__test002','Учебный профиль002') RETURNING id INTO specialization;
    INSERT INTO departments(building_id,specialization_id,name) VALUES (building1,specialization,'Поступление002') RETURNING id INTO department1;
    INSERT INTO departments(building_id,specialization_id,name) VALUES (building1,specialization,'Перевод002') RETURNING id INTO department2;
    INSERT INTO wards(department_id,number,planned_capacity) VALUES (department1,'1',1) RETURNING id INTO ward1;
    INSERT INTO wards(department_id,number,planned_capacity) VALUES (department2,'2',1) RETURNING id INTO ward2;
    INSERT INTO beds(ward_id,number) VALUES (ward1,'1') RETURNING id INTO bed1;
    INSERT INTO beds(ward_id,number) VALUES (ward2,'1') RETURNING id INTO bed2;
    WITH d AS (INSERT INTO departments(building_id,specialization_id,name) VALUES (building2,specialization,'Чужое002') RETURNING id),
    w AS (INSERT INTO wards(department_id,number,planned_capacity) SELECT id,'1',1 FROM d RETURNING id)
    INSERT INTO beds(ward_id,number) SELECT id,'1' FROM w RETURNING id INTO other_bed;
    INSERT INTO employments(employee_id,organization_id,position_name,started_on,workload_fraction)
        VALUES (doctor_id,hospital1,'Врач',DATE '2020-01-01',1);
    INSERT INTO medical_cases(patient_id,organization_id,case_type,opened_at,reason)
        VALUES (patient_id,clinic,'outpatient',t0 - interval '1 day','Учебный случай') RETURNING id INTO source_case;
    INSERT INTO medical_cases(patient_id,organization_id,case_type,opened_at,reason)
        VALUES (patient_id,hospital1,'inpatient',t0,'Учебная госпитализация') RETURNING id INTO inpatient_case;
    INSERT INTO referrals(case_id,referring_doctor_id,target_hospital_id,specialization_id,issued_at,reason,status)
        VALUES (source_case,doctor_id,hospital1,specialization,t0,'Учебное направление','used') RETURNING id INTO referral;
    INSERT INTO hospitalizations(case_id,patient_id,referral_id,department_id,admitted_at)
        VALUES (inpatient_case,patient_id,referral,department1,t0) RETURNING id INTO hospitalization;
    INSERT INTO bed_occupancies(hospitalization_id,bed_id,started_at)
        VALUES (hospitalization,bed1,t0) RETURNING id INTO occupation;
    INSERT INTO attending_physician_history(hospitalization_id,doctor_id,started_at)
        VALUES (hospitalization,doctor_id,t0) RETURNING id INTO physician;
    INSERT INTO laboratories(name,address) VALUES ('__test002 lab','Учебный адрес') RETURNING id INTO laboratory;
    INSERT INTO laboratories(name,address) VALUES ('__test002 lab2','Учебный адрес') RETURNING id INTO laboratory2;
    INSERT INTO laboratory_profiles(code,name) VALUES ('__test002','Учебный лабораторный профиль002') RETURNING id INTO profile;
    INSERT INTO laboratory_profile_links(laboratory_id,profile_id) VALUES (laboratory,profile),(laboratory2,profile);
    INSERT INTO laboratory_contracts(laboratory_id,organization_id,contract_number,valid_from,valid_until)
        VALUES (laboratory,clinic,'__test002',CURRENT_DATE - 10,CURRENT_DATE + 10) RETURNING id INTO contract;
    INSERT INTO lab_test_types(profile_id,code,name) VALUES (profile,'__test002','Учебное исследование') RETURNING id INTO test_type;
    INSERT INTO lab_orders(case_id,doctor_id,test_type_id,contract_id,ordered_at,status)
        VALUES (source_case,doctor_id,test_type,contract,t0,'completed') RETURNING id INTO lab_order;
    INSERT INTO lab_results(order_id,entered_by_user_id,result_text,measured_at)
        VALUES (lab_order,account,'Учебный результат',t0 + interval '1 hour') RETURNING id INTO result1;
    INSERT INTO lab_orders(case_id,doctor_id,test_type_id,contract_id,ordered_at)
        VALUES (source_case,doctor_id,test_type,contract,t0) RETURNING id INTO lab_order2;
    SET CONSTRAINTS ALL IMMEDIATE;
    tests := tests + 1;

    BEGIN
        UPDATE doctors SET academic_title_id = title_professor WHERE employee_id = doctor_id;
        RAISE EXCEPTION 'FAIL: professor without degree accepted';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;
    BEGIN
        -- Explicit IMMEDIATE catches a regression where queueing happened BEFORE DML.
        SET CONSTRAINTS ALL IMMEDIATE;
        INSERT INTO consultation_assignments(doctor_id,organization_id,started_on)
            VALUES (doctor_id,hospital2,CURRENT_DATE);
        RAISE EXCEPTION 'FAIL: consultation without scientific title accepted';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;
    BEGIN
        INSERT INTO employments(employee_id,organization_id,position_name,started_on,workload_fraction)
            VALUES (doctor_id,hospital2,'Совместитель',DATE '2021-01-01',0.5);
        RAISE EXCEPTION 'FAIL: two hospitals accepted';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;
    BEGIN
        INSERT INTO beds(ward_id,number) VALUES (ward1,'extra');
        RAISE EXCEPTION 'FAIL: capacity exceeded';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;
    BEGIN
        UPDATE attending_physician_history SET ended_at = transfer_at WHERE id = physician;
        RAISE EXCEPTION 'FAIL: active hospitalization without continuous physician accepted';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;
    BEGIN
        UPDATE beds SET is_active = false WHERE id = bed1;
        RAISE EXCEPTION 'FAIL: occupied bed deactivation accepted';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;
    BEGIN
        SET CONSTRAINTS ALL DEFERRED;
        UPDATE bed_occupancies SET ended_at = transfer_at WHERE id = occupation;
        INSERT INTO bed_occupancies(hospitalization_id,bed_id,started_at)
            VALUES (hospitalization,other_bed,transfer_at);
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'FAIL: placement in another hospital accepted';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;
    BEGIN
        DELETE FROM laboratory_profile_links WHERE laboratory_id = laboratory AND profile_id = profile;
        RAISE EXCEPTION 'FAIL: historic laboratory profile removal accepted';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;
    BEGIN
        UPDATE laboratory_contracts SET laboratory_id = laboratory2 WHERE id = contract;
        RAISE EXCEPTION 'FAIL: historic contract laboratory reassignment accepted';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;
    BEGIN
        UPDATE laboratory_contracts SET valid_until = CURRENT_DATE - 5 WHERE id = contract;
        RAISE EXCEPTION 'FAIL: contract changed to invalidate an existing order';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;
    BEGIN
        SET CONSTRAINTS ALL DEFERRED;
        UPDATE lab_orders SET status = 'completed' WHERE id = lab_order2;
        INSERT INTO lab_results(order_id,entered_by_user_id,result_text,measured_at,supersedes_result_id)
            VALUES (lab_order2,account,'Чужое исправление',t0 + interval '2 hours',result1);
        SET CONSTRAINTS ALL IMMEDIATE;
        RAISE EXCEPTION 'FAIL: correction of another order accepted';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;
    BEGIN
        SELECT coalesce(max(id),0) + 1000 INTO cycle_id FROM lab_results;
        INSERT INTO lab_results(id,order_id,entered_by_user_id,result_text,measured_at,supersedes_result_id)
            OVERRIDING SYSTEM VALUE VALUES
            (cycle_id,lab_order,account,'Цикл A',t0 + interval '2 hours',cycle_id + 1),
            (cycle_id + 1,lab_order,account,'Цикл B',t0 + interval '2 hours',cycle_id);
        RAISE EXCEPTION 'FAIL: multirow cyclic laboratory correction accepted';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;

    INSERT INTO employments(employee_id,organization_id,position_name,started_on,workload_fraction)
        VALUES (doctor_id,clinic,'Допустимое совместительство',DATE '2021-01-01',0.5);
    SET CONSTRAINTS ALL IMMEDIATE;
    tests := tests + 1;

    -- Finishing a contract must not invalidate orders already issued.
    UPDATE laboratory_contracts SET is_active = false WHERE id = contract;
    SET CONSTRAINTS ALL IMMEDIATE;
    tests := tests + 1;
    BEGIN
        INSERT INTO lab_orders(case_id,doctor_id,test_type_id,contract_id,ordered_at)
            VALUES (source_case,doctor_id,test_type,contract,CURRENT_TIMESTAMP);
        RAISE EXCEPTION 'FAIL: new order under inactive contract accepted';
    EXCEPTION WHEN check_violation THEN tests := tests + 1; END;

    -- A same-hospital transfer preserves admission department and all intervals.
    SET CONSTRAINTS ALL DEFERRED;
    UPDATE bed_occupancies SET ended_at = transfer_at WHERE id = occupation;
    INSERT INTO bed_occupancies(hospitalization_id,bed_id,started_at) VALUES (hospitalization,bed2,transfer_at);
    SET CONSTRAINTS ALL IMMEDIATE;
    IF (SELECT department_id FROM hospitalizations WHERE id = hospitalization) <> department1 THEN
        RAISE EXCEPTION 'FAIL: admission department changed on transfer';
    END IF;
    tests := tests + 1;

    -- Atomic discharge closes case, physician and occupancy consistently.
    SET CONSTRAINTS ALL DEFERRED;
    UPDATE bed_occupancies SET ended_at = CURRENT_TIMESTAMP
        WHERE hospitalization_id = hospitalization AND ended_at IS NULL;
    UPDATE attending_physician_history SET ended_at = CURRENT_TIMESTAMP
        WHERE id = physician;
    UPDATE medical_cases SET status = 'closed',closed_at = CURRENT_TIMESTAMP WHERE id = inpatient_case;
    UPDATE hospitalizations SET status = 'discharged',discharged_at = CURRENT_TIMESTAMP WHERE id = hospitalization;
    SET CONSTRAINTS ALL IMMEDIATE;
    tests := tests + 1;
    IF EXISTS (SELECT 1 FROM business_rule_checks) THEN
        RAISE EXCEPTION 'FAIL: validation queue not empty after checks';
    END IF;
    RAISE NOTICE 'PASS: % business-rule fixture assertions', tests;
END;
$test$;
ROLLBACK;
