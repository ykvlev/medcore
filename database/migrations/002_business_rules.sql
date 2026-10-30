-- MEDCORE business invariants. Requires 001_initial_schema.sql.
-- Educational implementation: governed writes serialize, then validate once at COMMIT.
-- Only READ COMMITTED transactions are supported for governed writes.
BEGIN;
SET LOCAL search_path = project, pg_catalog;

-- Internal transaction-local-in-effect queue: a request is inserted and deleted
-- in the same transaction. It is not a clinical entity or a background job.
CREATE TABLE project.business_rule_checks (
    transaction_id bigint PRIMARY KEY
);
REVOKE ALL ON project.business_rule_checks FROM PUBLIC;

CREATE FUNCTION project.fn_assert_business_rules()
RETURNS void LANGUAGE plpgsql
SET search_path = pg_catalog, project
AS $rules$
BEGIN
    -- Reference semantics cannot be edited into a less restrictive configuration.
    IF EXISTS (
        SELECT 1 FROM project.academic_degrees
        WHERE degree_rank <> CASE code WHEN 'none' THEN 0 WHEN 'candidate' THEN 1 WHEN 'doctor' THEN 2 END
    ) OR EXISTS (
        SELECT 1 FROM project.academic_titles
        WHERE minimum_degree_rank <> CASE code WHEN 'none' THEN 0 WHEN 'docent' THEN 1 WHEN 'professor' THEN 2 END
    ) OR EXISTS (
        SELECT 1 FROM project.doctors d
        JOIN project.academic_degrees g ON g.id = d.academic_degree_id
        JOIN project.academic_titles t ON t.id = d.academic_title_id
        JOIN project.employees e ON e.id = d.employee_id
        JOIN project.employee_categories c ON c.id = e.category_id
        WHERE g.degree_rank < t.minimum_degree_rank OR c.code <> 'doctor'
    ) THEN
        RAISE EXCEPTION 'Научная степень, звание или категория врача не соответствуют правилам'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1 FROM project.employments a
        JOIN project.doctors d ON d.employee_id = a.employee_id
        JOIN project.employments b ON b.employee_id = a.employee_id AND b.id > a.id
        JOIN project.medical_organizations oa ON oa.id = a.organization_id
        JOIN project.medical_organizations ob ON ob.id = b.organization_id
        WHERE oa.organization_type = ob.organization_type
          AND daterange(a.started_on, a.ended_on, '[)') && daterange(b.started_on, b.ended_on, '[)')
    ) THEN
        RAISE EXCEPTION 'Врач не может одновременно работать в двух больницах или двух поликлиниках'
            USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1 FROM project.consultation_assignments a
        JOIN project.doctors d ON d.employee_id = a.doctor_id
        JOIN project.academic_titles t ON t.id = d.academic_title_id
        WHERE t.code NOT IN ('docent', 'professor')
    ) THEN
        RAISE EXCEPTION 'Консультативное назначение требует звания доцента или профессора'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1 FROM project.patients p
        WHERE p.birth_date > timezone('Europe/Moscow', CURRENT_TIMESTAMP)::date
    ) OR EXISTS (
        SELECT 1 FROM project.employees e
        WHERE e.birth_date > timezone('Europe/Moscow', CURRENT_TIMESTAMP)::date
    ) OR EXISTS (
        SELECT 1 FROM project.medical_cases c JOIN project.patients p ON p.id = c.patient_id
        WHERE timezone('Europe/Moscow', c.opened_at)::date < p.birth_date
    ) OR EXISTS (
        SELECT 1 FROM project.employments e JOIN project.employees p ON p.id = e.employee_id
        WHERE e.started_on < p.birth_date
    ) THEN
        RAISE EXCEPTION 'Дата рождения или начало события недопустимы' USING ERRCODE = '23514';
    END IF;

    -- Draft structures may be incomplete; activation requires usable children.
    IF EXISTS (
        SELECT 1 FROM project.medical_organizations o
        WHERE o.is_active AND (
            (o.organization_type = 'hospital' AND (
                NOT EXISTS (SELECT 1 FROM project.hospitals h WHERE h.organization_id = o.id)
                OR NOT EXISTS (SELECT 1 FROM project.buildings b WHERE b.hospital_id = o.id AND b.is_active)))
            OR (o.organization_type = 'polyclinic' AND NOT EXISTS (
                SELECT 1 FROM project.polyclinics p WHERE p.organization_id = o.id)))
    ) OR EXISTS (
        SELECT 1 FROM project.buildings b JOIN project.medical_organizations o ON o.id = b.hospital_id
        WHERE o.is_active AND b.is_active
          AND NOT EXISTS (SELECT 1 FROM project.departments d WHERE d.building_id = b.id AND d.is_active)
    ) OR EXISTS (
        SELECT 1 FROM project.departments d
        JOIN project.buildings b ON b.id = d.building_id
        JOIN project.medical_organizations o ON o.id = b.hospital_id
        WHERE o.is_active AND b.is_active AND d.is_active
          AND NOT EXISTS (SELECT 1 FROM project.wards w WHERE w.department_id = d.id AND w.is_active)
    ) THEN
        RAISE EXCEPTION 'Нельзя активировать неполную структуру учреждения' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1 FROM project.wards w
        LEFT JOIN project.beds bed ON bed.ward_id = w.id
        GROUP BY w.id, w.planned_capacity
        HAVING count(bed.id) > w.planned_capacity
    ) OR EXISTS (
        SELECT 1 FROM project.wards w
        JOIN project.departments d ON d.id = w.department_id
        JOIN project.buildings b ON b.id = d.building_id
        JOIN project.medical_organizations o ON o.id = b.hospital_id
        LEFT JOIN project.beds bed ON bed.ward_id = w.id
        WHERE o.is_active AND b.is_active AND d.is_active AND w.is_active
        GROUP BY w.id, w.planned_capacity
        HAVING count(bed.id) <> w.planned_capacity
    ) THEN
        RAISE EXCEPTION 'Количество коек не соответствует плановой вместимости палаты'
            USING ERRCODE = '23514';
    END IF;

    -- department_id is the ADMISSION department. Current location comes from beds.
    IF EXISTS (
        SELECT 1 FROM project.hospitalizations h
        JOIN project.medical_cases c ON c.id = h.case_id
        JOIN project.referrals r ON r.id = h.referral_id
        JOIN project.medical_cases source_case ON source_case.id = r.case_id
        JOIN project.departments d ON d.id = h.department_id
        JOIN project.buildings b ON b.id = d.building_id
        WHERE c.case_type <> 'inpatient' OR c.patient_id <> source_case.patient_id
           OR c.organization_id <> b.hospital_id OR r.target_hospital_id <> b.hospital_id
           OR d.specialization_id <> r.specialization_id OR c.opened_at > h.admitted_at
           OR r.issued_at > h.admitted_at
           OR (h.status = 'active' AND (c.status <> 'open' OR h.admitted_at > CURRENT_TIMESTAMP))
           OR (h.status = 'discharged' AND (c.status <> 'closed' OR c.closed_at IS DISTINCT FROM h.discharged_at))
           OR (h.status = 'cancelled' AND c.status <> 'cancelled')
           OR (h.status <> 'cancelled' AND r.status <> 'used')
    ) THEN
        RAISE EXCEPTION 'Госпитализация не согласована со случаем, направлением или отделением поступления'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1 FROM project.bed_occupancies bo
        JOIN project.hospitalizations h ON h.id = bo.hospitalization_id
        JOIN project.departments admission_d ON admission_d.id = h.department_id
        JOIN project.buildings admission_b ON admission_b.id = admission_d.building_id
        JOIN project.beds bed ON bed.id = bo.bed_id
        JOIN project.wards w ON w.id = bed.ward_id
        JOIN project.departments d ON d.id = w.department_id
        JOIN project.buildings b ON b.id = d.building_id
        JOIN project.medical_organizations o ON o.id = b.hospital_id
        WHERE h.status = 'cancelled' OR b.hospital_id <> admission_b.hospital_id
           OR NOT (tstzrange(h.admitted_at, h.discharged_at, '[)') @> tstzrange(bo.started_at, bo.ended_at, '[)'))
           OR (bo.ended_at IS NULL AND NOT (bed.is_active AND w.is_active AND d.is_active AND b.is_active AND o.is_active))
    ) OR EXISTS (
        SELECT 1 FROM project.attending_physician_history a
        JOIN project.hospitalizations h ON h.id = a.hospitalization_id
        WHERE h.status = 'cancelled'
           OR NOT (tstzrange(h.admitted_at, h.discharged_at, '[)') @> tstzrange(a.started_at, a.ended_at, '[)'))
    ) THEN
        RAISE EXCEPTION 'Интервал размещения или лечащего врача выходит за пределы госпитализации'
            USING ERRCODE = '23514';
    END IF;

    -- EXCLUDE in 001 prevents overlaps; range equality also prevents gaps.
    IF EXISTS (
        SELECT 1 FROM project.hospitalizations h
        WHERE h.status <> 'cancelled' AND (
            (SELECT range_agg(tstzrange(bo.started_at, bo.ended_at, '[)'))
                FROM project.bed_occupancies bo WHERE bo.hospitalization_id = h.id)
                IS DISTINCT FROM tstzmultirange(tstzrange(h.admitted_at, h.discharged_at, '[)'))
            OR (SELECT range_agg(tstzrange(a.started_at, a.ended_at, '[)'))
                FROM project.attending_physician_history a WHERE a.hospitalization_id = h.id)
                IS DISTINCT FROM tstzmultirange(tstzrange(h.admitted_at, h.discharged_at, '[)')))
    ) THEN
        RAISE EXCEPTION 'Госпитализация должна иметь непрерывную историю койки и лечащего врача'
            USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1 FROM project.attending_physician_history a
        JOIN project.hospitalizations h ON h.id = a.hospitalization_id
        JOIN project.departments d ON d.id = h.department_id
        JOIN project.buildings b ON b.id = d.building_id
        WHERE NOT coalesce((
            SELECT range_agg(tstzrange(
                e.started_on::timestamp AT TIME ZONE 'Europe/Moscow',
                e.ended_on::timestamp AT TIME ZONE 'Europe/Moscow', '[)'))
            FROM project.employments e
            WHERE e.employee_id = a.doctor_id AND e.organization_id = b.hospital_id
        ) @> tstzrange(a.started_at, coalesce(a.ended_at, CURRENT_TIMESTAMP), '[)'), false)
    ) THEN
        RAISE EXCEPTION 'Лечащий врач должен работать в больнице на всём проверяемом интервале'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1 FROM project.lab_orders lo
        JOIN project.medical_cases c ON c.id = lo.case_id
        JOIN project.laboratory_contracts contract ON contract.id = lo.contract_id
        JOIN project.lab_test_types test ON test.id = lo.test_type_id
        WHERE contract.organization_id <> c.organization_id
           OR timezone('Europe/Moscow', lo.ordered_at)::date NOT BETWEEN contract.valid_from AND contract.valid_until
           OR lo.ordered_at < c.opened_at
           OR NOT EXISTS (SELECT 1 FROM project.laboratory_profile_links p
                WHERE p.laboratory_id = contract.laboratory_id AND p.profile_id = test.profile_id)
    ) THEN
        RAISE EXCEPTION 'Заказ исследования не соответствует организации, сроку договора или профилю лаборатории'
            USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1 FROM project.lab_results result
        JOIN project.lab_orders lo ON lo.id = result.order_id
        LEFT JOIN project.lab_results previous ON previous.id = result.supersedes_result_id
        WHERE result.measured_at < lo.ordered_at OR result.entered_at < result.measured_at
           OR (previous.id IS NOT NULL AND (previous.order_id <> result.order_id
               OR previous.entered_at > result.entered_at OR previous.id >= result.id))
           OR lo.status <> 'completed'
    ) OR EXISTS (
        SELECT 1 FROM project.lab_orders lo
        WHERE lo.status = 'completed' AND NOT EXISTS (
            SELECT 1 FROM project.lab_results result WHERE result.order_id = lo.id)
    ) THEN
        RAISE EXCEPTION 'Результат исследования не согласован с заказом, статусом или предыдущим результатом'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1 FROM project.surgery_participants p
        JOIN project.surgeries s ON s.id = p.surgery_id
        JOIN project.doctor_specialties ds ON ds.doctor_id = p.doctor_id AND ds.specialty_id = p.specialty_id
        JOIN project.specialties specialty ON specialty.id = p.specialty_id
        WHERE (p.participation_role IN ('lead', 'assistant') AND NOT specialty.allows_surgery)
           OR (p.participation_role = 'anesthetist' AND specialty.code <> 'anesthesiologist')
           OR timezone('Europe/Moscow', s.started_at)::date < ds.certified_on
           OR (ds.valid_until IS NOT NULL AND timezone('Europe/Moscow', s.started_at)::date > ds.valid_until)
    ) OR EXISTS (
        SELECT 1 FROM project.surgeries s
        JOIN project.medical_cases c ON c.id = s.case_id
        WHERE s.started_at < c.opened_at
           OR (s.outcome <> 'cancelled' AND NOT EXISTS (
                SELECT 1 FROM project.surgery_participants p WHERE p.surgery_id = s.id AND p.participation_role = 'lead'))
    ) THEN
        RAISE EXCEPTION 'Операция требует ведущего врача и участников с подходящей действующей специальностью'
            USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1 FROM project.medical_record_entries e
        JOIN project.medical_cases c ON c.id = e.case_id
        LEFT JOIN project.medical_record_entries previous ON previous.id = e.corrects_entry_id
        WHERE e.recorded_at < c.opened_at
           OR (e.corrects_entry_id IS NOT NULL AND (e.entry_type <> 'correction'
               OR previous.case_id <> e.case_id OR previous.recorded_at > e.recorded_at OR previous.id >= e.id))
           OR (e.entry_type = 'correction' AND e.corrects_entry_id IS NULL)
    ) THEN
        RAISE EXCEPTION 'Исправление медицинской записи должно ссылаться на предшествующую запись того же случая'
            USING ERRCODE = '23514';
    END IF;
END;
$rules$;

CREATE FUNCTION project.fn_lock_business_writes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, project
AS $lock$
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Изменение предметных данных поддерживается только в READ COMMITTED'
            USING ERRCODE = '25000';
    END IF;
    PERFORM pg_advisory_xact_lock(1296389187, 1);
    RETURN NULL;
END;
$lock$;

CREATE FUNCTION project.fn_schedule_business_rule_check()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, project
AS $schedule$
BEGIN
    INSERT INTO project.business_rule_checks(transaction_id) VALUES (txid_current())
        ON CONFLICT (transaction_id) DO NOTHING;
    RETURN NULL;
END;
$schedule$;

CREATE FUNCTION project.fn_execute_business_rule_check()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, project
AS $check$
BEGIN
    PERFORM project.fn_assert_business_rules();
    DELETE FROM project.business_rule_checks WHERE transaction_id = NEW.transaction_id;
    RETURN NULL;
END;
$check$;

CREATE CONSTRAINT TRIGGER trg_deferred_business_rule_check
AFTER INSERT ON project.business_rule_checks
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION project.fn_execute_business_rule_check();

-- Protect historic identity and append-only corrections. All functions are invoked
-- by triggers; application roles must not be granted direct EXECUTE access.
CREATE FUNCTION project.fn_protect_historical_identity()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, project
AS $history$
DECLARE
    old_row jsonb;
    new_row jsonb;
    parent_key text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Удаление медицинской истории запрещено: %', TG_TABLE_NAME USING ERRCODE = '23514';
    END IF;
    old_row := to_jsonb(OLD);
    new_row := to_jsonb(NEW);
    IF TG_TABLE_NAME IN ('lab_results', 'medical_record_entries') THEN
        RAISE EXCEPTION 'Медицинские записи и результаты исправляются новой записью' USING ERRCODE = '23514';
    ELSIF TG_TABLE_NAME IN ('buildings', 'departments', 'wards', 'beds') THEN
        parent_key := CASE TG_TABLE_NAME WHEN 'buildings' THEN 'hospital_id' WHEN 'departments' THEN 'building_id'
            WHEN 'wards' THEN 'department_id' WHEN 'beds' THEN 'ward_id' END;
        IF new_row -> parent_key IS DISTINCT FROM old_row -> parent_key OR new_row -> 'id' IS DISTINCT FROM old_row -> 'id' THEN
            RAISE EXCEPTION 'Изменение принадлежности элемента структуры запрещено; создайте новый элемент'
                USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'hospitalizations' THEN
        IF (new_row - ARRAY['status', 'discharged_at', 'discharge_summary'])
            IS DISTINCT FROM (old_row - ARRAY['status', 'discharged_at', 'discharge_summary']) THEN
            RAISE EXCEPTION 'Основание и данные поступления госпитализации неизменяемы' USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME IN ('bed_occupancies', 'attending_physician_history') THEN
        IF (new_row - 'ended_at') IS DISTINCT FROM (old_row - 'ended_at') THEN
            RAISE EXCEPTION 'Исторический интервал допускает только изменение времени окончания' USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'lab_orders' THEN
        IF (new_row - ARRAY['status', 'note']) IS DISTINCT FROM (old_row - ARRAY['status', 'note']) THEN
            RAISE EXCEPTION 'Связи и дата заказа исследования неизменяемы' USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'laboratory_contracts' THEN
        IF (new_row - ARRAY['valid_from', 'valid_until', 'is_active'])
            IS DISTINCT FROM (old_row - ARRAY['valid_from', 'valid_until', 'is_active']) THEN
            RAISE EXCEPTION 'Стороны и номер договора неизменяемы; создайте новый договор' USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'lab_test_types' THEN
        IF new_row -> 'id' IS DISTINCT FROM old_row -> 'id'
            OR new_row -> 'profile_id' IS DISTINCT FROM old_row -> 'profile_id'
            OR new_row -> 'code' IS DISTINCT FROM old_row -> 'code' THEN
            RAISE EXCEPTION 'Профиль и код вида исследования неизменяемы' USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'referrals' THEN
        IF (new_row - 'status') IS DISTINCT FROM (old_row - 'status') THEN
            RAISE EXCEPTION 'Направление изменяет только статус; новое основание оформляется новым направлением'
                USING ERRCODE = '23514';
        END IF;
    ELSIF TG_TABLE_NAME = 'medical_cases' THEN
        IF (new_row - ARRAY['status', 'closed_at', 'reason']) IS DISTINCT FROM (old_row - ARRAY['status', 'closed_at', 'reason']) THEN
            RAISE EXCEPTION 'Принадлежность и начало медицинского случая неизменяемы' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$history$;

-- A new order requires an active contract at creation; later deactivation does
-- not falsify orders that were valid when issued. Expiry/profile edits are still
-- checked globally against preserved orders.
CREATE FUNCTION project.fn_validate_new_lab_order()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, project
AS $order$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM project.laboratory_contracts c
        JOIN project.laboratories l ON l.id = c.laboratory_id
        WHERE c.id = NEW.contract_id AND c.is_active AND l.is_active
    ) THEN
        RAISE EXCEPTION 'Новый заказ требует действующего договора с активной лабораторией' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$order$;
CREATE TRIGGER trg_validate_new_lab_order BEFORE INSERT ON project.lab_orders
FOR EACH ROW EXECUTE FUNCTION project.fn_validate_new_lab_order();

CREATE FUNCTION project.fn_reject_business_truncate()
RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, project
AS $truncate$
BEGIN
    RAISE EXCEPTION 'TRUNCATE предметных таблиц запрещён; используйте отдельную тестовую базу'
        USING ERRCODE = '23514';
END;
$truncate$;

DO $install$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'medical_organizations', 'hospitals', 'polyclinics', 'buildings', 'departments', 'wards', 'beds',
        'employee_categories', 'employees', 'academic_degrees', 'academic_titles', 'doctors', 'employments',
        'consultation_assignments', 'patients', 'medical_cases', 'referrals', 'hospitalizations',
        'attending_physician_history', 'bed_occupancies', 'laboratories', 'laboratory_profile_links',
        'laboratory_contracts', 'lab_test_types', 'lab_orders', 'lab_results', 'specialties',
        'doctor_specialties', 'surgeries', 'surgery_participants', 'medical_record_entries'
    ] LOOP
        EXECUTE format('CREATE TRIGGER trg_lock_business_writes BEFORE INSERT OR UPDATE OR DELETE ON project.%I FOR EACH STATEMENT EXECUTE FUNCTION project.fn_lock_business_writes()', table_name);
        EXECUTE format('CREATE TRIGGER trg_schedule_business_check AFTER INSERT OR UPDATE OR DELETE ON project.%I FOR EACH STATEMENT EXECUTE FUNCTION project.fn_schedule_business_rule_check()', table_name);
        EXECUTE format('CREATE TRIGGER trg_prevent_business_truncate BEFORE TRUNCATE ON project.%I FOR EACH STATEMENT EXECUTE FUNCTION project.fn_reject_business_truncate()', table_name);
    END LOOP;
    FOREACH table_name IN ARRAY ARRAY['buildings', 'departments', 'wards', 'beds'] LOOP
        EXECUTE format('CREATE TRIGGER trg_protect_structure BEFORE UPDATE ON project.%I FOR EACH ROW EXECUTE FUNCTION project.fn_protect_historical_identity()', table_name);
    END LOOP;
    FOREACH table_name IN ARRAY ARRAY['laboratory_contracts', 'lab_test_types', 'referrals'] LOOP
        EXECUTE format('CREATE TRIGGER trg_protect_reference_identity BEFORE UPDATE ON project.%I FOR EACH ROW EXECUTE FUNCTION project.fn_protect_historical_identity()', table_name);
    END LOOP;
    FOREACH table_name IN ARRAY ARRAY['hospitalizations', 'bed_occupancies', 'attending_physician_history', 'lab_orders', 'lab_results', 'medical_record_entries', 'medical_cases'] LOOP
        EXECUTE format('CREATE TRIGGER trg_protect_history BEFORE UPDATE OR DELETE ON project.%I FOR EACH ROW EXECUTE FUNCTION project.fn_protect_historical_identity()', table_name);
    END LOOP;
END;
$install$;

REVOKE ALL ON FUNCTION project.fn_assert_business_rules() FROM PUBLIC;
REVOKE ALL ON FUNCTION project.fn_lock_business_writes() FROM PUBLIC;
REVOKE ALL ON FUNCTION project.fn_schedule_business_rule_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION project.fn_execute_business_rule_check() FROM PUBLIC;
REVOKE ALL ON FUNCTION project.fn_protect_historical_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION project.fn_validate_new_lab_order() FROM PUBLIC;
REVOKE ALL ON FUNCTION project.fn_reject_business_truncate() FROM PUBLIC;

SELECT project.fn_assert_business_rules();
COMMIT;
