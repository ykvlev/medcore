-- Isolated assertions for stored objects. No fixture survives ROLLBACK.
BEGIN;
SET LOCAL search_path = project, public;

DO $test$
DECLARE
    v_category bigint;
    v_degree bigint;
    v_title bigint;
    v_doctor bigint;
    v_user bigint;
    v_hospital bigint;
    v_clinic bigint;
    v_building bigint;
    v_spec bigint;
    v_department bigint;
    v_empty_department bigint;
    v_ward bigint;
    v_specialty bigint;
    v_second_specialty bigint;
    v_patient bigint;
    v_draft bigint;
    v_case bigint;
    v_appointment bigint;
    v_surgery bigint;
    v_cursor refcursor := 'stored_object_test_cursor';
    v_row record;
    v_count bigint;
    v_expected numeric;
    v_caught boolean;
BEGIN
    -- Empty baseline views must be selectable, including zero-row aggregates.
    PERFORM * FROM project.vw_hospital_capacity;
    PERFORM * FROM project.vw_doctor_statistics;
    PERFORM * FROM project.vw_patient_treatment_summary;
    IF project.fn_department_occupancy(-1) IS NOT NULL
       OR project.fn_doctor_experience(-1, '2015-12-31') IS NOT NULL THEN
        RAISE EXCEPTION 'Missing identities must return NULL';
    END IF;

    INSERT INTO employee_categories(code, name) VALUES ('doctor', '__test_doctor_category')
        ON CONFLICT(code) DO UPDATE SET code = excluded.code RETURNING id INTO v_category;
    INSERT INTO academic_degrees(code, name, degree_rank) VALUES ('none', '__test_no_degree', 0)
        ON CONFLICT(code) DO UPDATE SET code = excluded.code RETURNING id INTO v_degree;
    INSERT INTO academic_titles(code, name, minimum_degree_rank) VALUES ('none', '__test_no_title', 0)
        ON CONFLICT(code) DO UPDATE SET code = excluded.code RETURNING id INTO v_title;
    INSERT INTO employees(category_id, last_name, first_name, birth_date)
        VALUES(v_category, 'Тестовый', 'Врач', '1980-01-01') RETURNING id INTO v_doctor;
    INSERT INTO doctors(employee_id, academic_degree_id, academic_title_id)
        VALUES(v_doctor, v_degree, v_title);
    INSERT INTO users(employee_id, login, password_hash)
        VALUES(v_doctor, '__stored_object_test_user', 'non-authenticating-test-fixture') RETURNING id INTO v_user;
    PERFORM set_config('medcore.actor_user_id', v_user::text, true);
    PERFORM set_config('medcore.request_id', '__stored_object_test_request', true);

    CALL project.sp_register_patient(' Тестовый ', ' Пациент ', NULL, '2000-01-01',
        'unknown', NULL, NULL, NULL, v_patient);
    IF v_patient IS NULL OR NOT EXISTS (SELECT 1 FROM patients
        WHERE id = v_patient AND last_name = 'Тестовый' AND version = 1) THEN
        RAISE EXCEPTION 'Registration output or trimming failed';
    END IF;
    CALL project.sp_update_patient(v_patient, 1, ' +7 000 000-00-00 ', '', ' Учебный адрес ');
    IF NOT EXISTS (SELECT 1 FROM patients WHERE id = v_patient AND version = 2
        AND phone = '+7 000 000-00-00' AND email IS NULL AND address = 'Учебный адрес') THEN
        RAISE EXCEPTION 'Contact normalization or optimistic version failed';
    END IF;
    v_caught := false;
    BEGIN
        CALL project.sp_update_patient(v_patient, 1, 'stale', NULL, NULL);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN v_caught := true;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'Stale update must fail'; END IF;
    IF (SELECT version FROM patients WHERE id = v_patient) <> 2 THEN
        RAISE EXCEPTION 'Stale update changed patient';
    END IF;
    SELECT count(*) INTO v_count FROM audit_logs WHERE entity_type = 'patient'
        AND entity_id = v_patient AND actor_user_id = v_user
        AND request_id = '__stored_object_test_request' AND action IN ('insert', 'update');
    IF v_count <> 2 OR NOT EXISTS (SELECT 1 FROM audit_logs
        WHERE entity_type = 'patient' AND entity_id = v_patient AND action = 'update'
          AND changed_fields @> ARRAY['phone', 'address', 'version']) THEN
        RAISE EXCEPTION 'Audit actor, request or changed fields failed';
    END IF;
    v_caught := false;
    BEGIN
        CALL project.sp_register_patient('', 'Пациент', NULL, '2000-01-01',
            'unknown', NULL, NULL, NULL, v_draft);
    EXCEPTION WHEN SQLSTATE '22023' THEN v_caught := true;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'Registration must validate required names'; END IF;
    v_draft := NULL;
    CALL project.sp_register_patient('Черновик', 'Пациент', NULL, '2000-01-01',
        'unknown', NULL, NULL, NULL, v_draft);
    CALL project.sp_delete_patient_draft(v_draft, 1);
    IF EXISTS (SELECT 1 FROM patients WHERE id = v_draft)
       OR NOT EXISTS (SELECT 1 FROM audit_logs WHERE entity_type = 'patient'
        AND entity_id = v_draft AND action = 'delete' AND actor_user_id = v_user) THEN
        RAISE EXCEPTION 'Draft deletion or deletion audit failed';
    END IF;

    INSERT INTO medical_organizations(name, organization_type, address)
        VALUES('__test_hospital', 'hospital', 'Учебный адрес') RETURNING id INTO v_hospital;
    INSERT INTO hospitals(organization_id) VALUES(v_hospital);
    INSERT INTO medical_organizations(name, organization_type, address)
        VALUES('__test_clinic', 'polyclinic', 'Учебный адрес') RETURNING id INTO v_clinic;
    INSERT INTO polyclinics(organization_id, hospital_id) VALUES(v_clinic, v_hospital);
    INSERT INTO employments(employee_id, organization_id, position_name, started_on, ended_on, workload_fraction)
        VALUES(v_doctor, v_hospital, 'Врач', '2010-01-01', '2016-01-01', 1),
              (v_doctor, v_clinic, 'Врач', '2012-01-01', '2015-01-01', 0.5);
    v_expected := round((date '2016-01-01' - date '2010-01-01') / 365.2425, 2);
    IF project.fn_doctor_experience(v_doctor, '2015-12-31') <> v_expected
       OR project.fn_doctor_experience(v_doctor, '2009-12-31') <> 0 THEN
        RAISE EXCEPTION 'Experience must merge overlapping periods and ignore future work';
    END IF;
    v_expected := round((date '2016-01-01' - date '2010-01-01') / 365.2425, 2);
    IF project.fn_doctor_experience(v_doctor, '2017-01-01') <> v_expected THEN
        RAISE EXCEPTION 'Employment end must be exclusive';
    END IF;

    INSERT INTO buildings(hospital_id, code, address) VALUES(v_hospital, '__test_building', 'Учебный адрес')
        RETURNING id INTO v_building;
    INSERT INTO department_specializations(code, name) VALUES('__test_capacity', '__test_capacity')
        RETURNING id INTO v_spec;
    INSERT INTO departments(building_id, specialization_id, name)
        VALUES(v_building, v_spec, '__test_department') RETURNING id INTO v_department;
    INSERT INTO departments(building_id, specialization_id, name, is_active)
        VALUES(v_building, v_spec, '__test_empty_department', false) RETURNING id INTO v_empty_department;
    INSERT INTO wards(department_id, number, planned_capacity) VALUES(v_department, '__test_ward', 2)
        RETURNING id INTO v_ward;
    INSERT INTO beds(ward_id, number) VALUES(v_ward, '1'), (v_ward, '2');
    SELECT * INTO STRICT v_row FROM vw_hospital_capacity WHERE department_id = v_department;
    IF v_row.total_beds <> 2 OR v_row.occupied_beds <> 0
       OR v_row.free_beds <> 0 OR v_row.unavailable_beds <> 2 OR v_row.occupancy_percent <> 0 THEN
        RAISE EXCEPTION 'Inactive hospital capacity must be unavailable';
    END IF;
    SELECT * INTO STRICT v_row FROM vw_hospital_capacity WHERE department_id = v_empty_department;
    IF v_row.total_beds <> 0 OR v_row.occupancy_percent IS NOT NULL THEN
        RAISE EXCEPTION 'Empty department must have zero beds and NULL percentage';
    END IF;
    UPDATE medical_organizations SET is_active = true WHERE id = v_hospital;
    SELECT * INTO STRICT v_row FROM vw_hospital_capacity WHERE department_id = v_department;
    IF v_row.free_beds <> 2 OR v_row.unavailable_beds <> 0 THEN
        RAISE EXCEPTION 'Activated hierarchy must expose free beds';
    END IF;

    INSERT INTO specialties(code, name, allows_surgery) VALUES('__test_surgery_a', '__test_surgery_a', true)
        RETURNING id INTO v_specialty;
    INSERT INTO specialties(code, name, allows_surgery) VALUES('__test_surgery_b', '__test_surgery_b', true)
        RETURNING id INTO v_second_specialty;
    INSERT INTO doctor_specialties(doctor_id, specialty_id, certified_on)
        VALUES(v_doctor, v_specialty, '2010-01-01'), (v_doctor, v_second_specialty, '2010-01-01');
    INSERT INTO medical_cases(patient_id, organization_id, case_type, status, opened_at, closed_at, reason)
        VALUES(v_patient, v_clinic, 'outpatient', 'closed', '2012-02-01 00:00Z', '2012-03-01 00:00Z', 'Учебный случай')
        RETURNING id INTO v_case;
    INSERT INTO appointments(case_id, scheduled_at, status, completed_at)
        VALUES(v_case, '2012-02-02 10:00Z', 'completed', '2012-02-02 10:30Z')
        RETURNING id INTO v_appointment;
    INSERT INTO appointment_doctors(appointment_id, doctor_id) VALUES(v_appointment, v_doctor);
    INSERT INTO appointments(case_id, scheduled_at, status, completed_at)
        VALUES(v_case, '2012-02-03 10:00Z', 'completed', '2012-02-03 10:30Z')
        RETURNING id INTO v_appointment;
    INSERT INTO appointment_doctors(appointment_id, doctor_id) VALUES(v_appointment, v_doctor);
    INSERT INTO surgeries(case_id, name, started_at, ended_at, outcome)
        VALUES(v_case, '__test_surgery_1', '2012-02-04 10:00Z', '2012-02-04 11:00Z', 'survived')
        RETURNING id INTO v_surgery;
    INSERT INTO surgery_participants(surgery_id, doctor_id, specialty_id, participation_role)
        VALUES(v_surgery, v_doctor, v_specialty, 'lead');
    INSERT INTO surgeries(case_id, name, started_at, ended_at, outcome)
        VALUES(v_case, '__test_surgery_2', '2012-02-05 10:00Z', '2012-02-05 11:00Z', 'fatal')
        RETURNING id INTO v_surgery;
    INSERT INTO surgery_participants(surgery_id, doctor_id, specialty_id, participation_role)
        VALUES(v_surgery, v_doctor, v_specialty, 'lead');
    SELECT * INTO STRICT v_row FROM vw_doctor_statistics WHERE doctor_id = v_doctor;
    IF v_row.appointment_count <> 2 OR v_row.surgery_count <> 2 OR v_row.fatal_surgery_count <> 1 THEN
        RAISE EXCEPTION 'Doctor aggregates must not multiply events by specialties or employments';
    END IF;
    SELECT * INTO STRICT v_row FROM vw_patient_treatment_summary WHERE patient_id = v_patient;
    IF v_row.case_count <> 1 OR v_row.hospitalization_count <> 0
       OR v_row.treatment_status <> 'not_in_treatment'
       OR v_row.last_visit_at <> '2012-02-03 10:30Z'::timestamptz THEN
        RAISE EXCEPTION 'Patient summary or last visit failed';
    END IF;
    CALL project.sp_get_patient_summary(v_patient, v_cursor);
    FETCH v_cursor INTO v_row;
    IF v_row.id <> v_patient OR v_row.case_count <> 1 OR v_row.version <> 2 THEN
        RAISE EXCEPTION 'Patient summary cursor contract failed';
    END IF;
    CLOSE v_cursor;
    v_caught := false;
    BEGIN
        CALL project.sp_delete_patient_draft(v_patient, 2);
    EXCEPTION WHEN SQLSTATE '23503' THEN v_caught := true;
    END;
    IF NOT v_caught THEN RAISE EXCEPTION 'Patient with medical history must not be deleted'; END IF;
    PERFORM project.fn_assert_business_rules();
END;
$test$;
ROLLBACK;
