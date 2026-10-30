-- MEDCORE: read models, patient procedures, computed functions and patient audit.
-- All routines are SECURITY INVOKER. Context authorization belongs to the API.
BEGIN;
SET LOCAL search_path = project, public;

CREATE FUNCTION project.fn_department_occupancy(p_department_id bigint)
RETURNS numeric
LANGUAGE sql STABLE STRICT SECURITY INVOKER
SET search_path = pg_catalog, project
AS $sql$
    SELECT round(100.0 * count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM project.bed_occupancies bo
        WHERE bo.bed_id = b.id
          AND tstzrange(bo.started_at, bo.ended_at, '[)') @> CURRENT_TIMESTAMP
    )) / nullif(count(*), 0), 2)
    FROM project.beds b
    JOIN project.wards w ON w.id = b.ward_id
    WHERE w.department_id = p_department_id;
$sql$;

-- Calendar dates are [start,end); as_of_date is included. Overlapping employments
-- are merged before summation, so a hospital + clinic does not double experience.
CREATE FUNCTION project.fn_doctor_experience(
    p_doctor_id bigint, p_as_of_date date DEFAULT CURRENT_DATE)
RETURNS numeric
LANGUAGE sql STABLE STRICT SECURITY INVOKER
SET search_path = pg_catalog, project
AS $sql$
    WITH spans AS (
        SELECT range_agg(daterange(e.started_on,
            least(coalesce(e.ended_on, p_as_of_date + 1), p_as_of_date + 1), '[)')) AS merged
        FROM project.employments e
        WHERE e.employee_id = p_doctor_id AND e.started_on <= p_as_of_date
    ), days AS (
        SELECT sum(upper(r) - lower(r)) AS worked_days
        FROM spans CROSS JOIN LATERAL unnest(spans.merged) AS ranges(r)
    )
    SELECT CASE WHEN EXISTS (
        SELECT 1 FROM project.doctors d WHERE d.employee_id = p_doctor_id)
        THEN round(coalesce((SELECT worked_days FROM days), 0) / 365.2425, 2)
        ELSE NULL END;
$sql$;

-- Grain: one row per department; zero-bed departments remain visible.
CREATE VIEW project.vw_hospital_capacity AS
WITH bed_state AS (
    SELECT w.department_id, b.id,
        (b.is_active AND w.is_active AND d.is_active AND bu.is_active AND o.is_active) AS operational,
        EXISTS (SELECT 1 FROM project.bed_occupancies bo
            WHERE bo.bed_id = b.id
              AND tstzrange(bo.started_at, bo.ended_at, '[)') @> CURRENT_TIMESTAMP) AS occupied
    FROM project.beds b
    JOIN project.wards w ON w.id = b.ward_id
    JOIN project.departments d ON d.id = w.department_id
    JOIN project.buildings bu ON bu.id = d.building_id
    JOIN project.medical_organizations o ON o.id = bu.hospital_id
), capacity AS (
    SELECT department_id, count(*) AS total_beds,
        count(*) FILTER (WHERE occupied) AS occupied_beds,
        count(*) FILTER (WHERE operational AND NOT occupied) AS free_beds,
        count(*) FILTER (WHERE NOT operational AND NOT occupied) AS unavailable_beds
    FROM bed_state GROUP BY department_id
)
SELECT o.id AS hospital_id, o.name AS hospital_name,
    d.id AS department_id, d.name AS department_name,
    coalesce(c.total_beds, 0) AS total_beds,
    coalesce(c.occupied_beds, 0) AS occupied_beds,
    coalesce(c.free_beds, 0) AS free_beds,
    coalesce(c.unavailable_beds, 0) AS unavailable_beds,
    round(100.0 * coalesce(c.occupied_beds, 0) / nullif(c.total_beds, 0), 2) AS occupancy_percent
FROM project.departments d
JOIN project.buildings bu ON bu.id = d.building_id
JOIN project.medical_organizations o ON o.id = bu.hospital_id
LEFT JOIN capacity c ON c.department_id = d.id;

-- Each aggregate is computed independently at doctor grain to avoid JOIN fanout.
CREATE VIEW project.vw_doctor_statistics AS
WITH specialty_names AS (
    SELECT ds.doctor_id, string_agg(s.name, ', ' ORDER BY s.name) AS specialties
    FROM project.doctor_specialties ds
    JOIN project.specialties s ON s.id = ds.specialty_id
    WHERE ds.certified_on <= CURRENT_DATE
      AND (ds.valid_until IS NULL OR ds.valid_until >= CURRENT_DATE)
    GROUP BY ds.doctor_id
), organization_names AS (
    SELECT e.employee_id, string_agg(DISTINCT o.name, ', ' ORDER BY o.name) AS workplaces
    FROM project.employments e
    JOIN project.medical_organizations o ON o.id = e.organization_id
    WHERE daterange(e.started_on, e.ended_on, '[)') @> CURRENT_DATE
    GROUP BY e.employee_id
), appointment_counts AS (
    SELECT ad.doctor_id, count(*) AS appointment_count
    FROM project.appointment_doctors ad
    JOIN project.appointments a ON a.id = ad.appointment_id
    WHERE a.status = 'completed' GROUP BY ad.doctor_id
), surgery_counts AS (
    SELECT sp.doctor_id, count(*) AS surgery_count,
        count(*) FILTER (WHERE s.outcome = 'fatal') AS fatal_surgery_count
    FROM project.surgery_participants sp
    JOIN project.surgeries s ON s.id = sp.surgery_id
    WHERE s.outcome IN ('survived', 'fatal') GROUP BY sp.doctor_id
)
SELECT d.employee_id AS doctor_id,
    concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS full_name,
    e.is_active, sn.specialties, orn.workplaces,
    coalesce(ac.appointment_count, 0) AS appointment_count,
    coalesce(sc.surgery_count, 0) AS surgery_count,
    coalesce(sc.fatal_surgery_count, 0) AS fatal_surgery_count
FROM project.doctors d
JOIN project.employees e ON e.id = d.employee_id
LEFT JOIN specialty_names sn ON sn.doctor_id = d.employee_id
LEFT JOIN organization_names orn ON orn.employee_id = d.employee_id
LEFT JOIN appointment_counts ac ON ac.doctor_id = d.employee_id
LEFT JOIN surgery_counts sc ON sc.doctor_id = d.employee_id;

CREATE VIEW project.vw_patient_treatment_summary AS
WITH case_counts AS (
    SELECT patient_id, count(*) FILTER (WHERE status <> 'cancelled') AS case_count,
        max(opened_at) FILTER (WHERE status <> 'cancelled') AS last_case_at,
        bool_or(status = 'open') AS has_open_case
    FROM project.medical_cases GROUP BY patient_id
), hospitalization_counts AS (
    SELECT patient_id, count(*) FILTER (WHERE status <> 'cancelled') AS hospitalization_count,
        bool_or(status = 'active'
            AND tstzrange(admitted_at, discharged_at, '[)') @> CURRENT_TIMESTAMP) AS hospitalized_now
    FROM project.hospitalizations GROUP BY patient_id
), visit_dates AS (
    SELECT c.patient_id, max(a.completed_at) AS last_appointment_at
    FROM project.medical_cases c
    JOIN project.appointments a ON a.case_id = c.id
    WHERE c.status <> 'cancelled' AND a.status = 'completed' GROUP BY c.patient_id
)
SELECT p.id AS patient_id, coalesce(cc.case_count, 0) AS case_count,
    coalesce(hc.hospitalization_count, 0) AS hospitalization_count,
    greatest(cc.last_case_at, vd.last_appointment_at) AS last_visit_at,
    CASE WHEN coalesce(hc.hospitalized_now, false) THEN 'inpatient'
         WHEN coalesce(cc.has_open_case, false) THEN 'outpatient'
         ELSE 'not_in_treatment' END AS treatment_status
FROM project.patients p
LEFT JOIN case_counts cc ON cc.patient_id = p.id
LEFT JOIN hospitalization_counts hc ON hc.patient_id = p.id
LEFT JOIN visit_dates vd ON vd.patient_id = p.id;

CREATE PROCEDURE project.sp_register_patient(
    IN p_last_name text, IN p_first_name text, IN p_middle_name text,
    IN p_birth_date date, IN p_sex text, IN p_phone text,
    IN p_email text, IN p_address text, INOUT p_patient_id bigint DEFAULT NULL)
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, project
AS $body$
BEGIN
    IF p_last_name IS NULL OR btrim(p_last_name) = ''
       OR p_first_name IS NULL OR btrim(p_first_name) = ''
       OR p_birth_date IS NULL OR p_birth_date > CURRENT_DATE
       OR p_sex IS NULL OR p_sex NOT IN ('male', 'female', 'unknown') THEN
        RAISE EXCEPTION 'Обязательные данные пациента отсутствуют или некорректны'
            USING ERRCODE = '22023';
    END IF;
    INSERT INTO project.patients(last_name, first_name, middle_name,
        birth_date, sex, phone, email, address)
    VALUES (btrim(p_last_name), btrim(p_first_name), nullif(btrim(p_middle_name), ''),
        p_birth_date, p_sex, nullif(btrim(p_phone), ''), nullif(btrim(p_email), ''),
        nullif(btrim(p_address), ''))
    RETURNING id INTO p_patient_id;
END;
$body$;

-- Contact-only update: clinical and identifying fields are not arguments.
CREATE PROCEDURE project.sp_update_patient(
    IN p_patient_id bigint, IN p_expected_version integer,
    IN p_phone text, IN p_email text, IN p_address text)
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, project
AS $body$
BEGIN
    IF p_expected_version IS NULL OR p_expected_version < 1 THEN
        RAISE EXCEPTION 'Не указана корректная версия карточки' USING ERRCODE = '22023';
    END IF;
    UPDATE project.patients
    SET phone = nullif(btrim(p_phone), ''), email = nullif(btrim(p_email), ''),
        address = nullif(btrim(p_address), '')
    WHERE id = p_patient_id AND version = p_expected_version;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Карточка пациента не найдена или уже изменена'
            USING ERRCODE = 'P0001';
    END IF;
END;
$body$;

CREATE PROCEDURE project.sp_delete_patient_draft(
    IN p_patient_id bigint, IN p_expected_version integer)
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, project
AS $body$
DECLARE
    v_version integer;
BEGIN
    -- Lock serializes with FK checks performed by concurrent child inserts.
    SELECT version INTO v_version FROM project.patients
    WHERE id = p_patient_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Пациент не найден' USING ERRCODE = 'P0002';
    END IF;
    IF p_expected_version IS NULL OR v_version <> p_expected_version THEN
        RAISE EXCEPTION 'Карточка пациента уже изменена' USING ERRCODE = 'P0001';
    END IF;
    IF EXISTS (SELECT 1 FROM project.medical_cases WHERE patient_id = p_patient_id)
       OR EXISTS (SELECT 1 FROM project.patient_attachments WHERE patient_id = p_patient_id)
       OR EXISTS (SELECT 1 FROM project.hospitalizations WHERE patient_id = p_patient_id) THEN
        RAISE EXCEPTION 'Удаление пациента с историей запрещено; используйте деактивацию'
            USING ERRCODE = '23503';
    END IF;
    DELETE FROM project.patients WHERE id = p_patient_id;
END;
$body$;

-- Caller must begin a transaction and FETCH the cursor before COMMIT.
CREATE PROCEDURE project.sp_get_patient_summary(
    IN p_patient_id bigint, INOUT p_result refcursor)
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, project
AS $body$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM project.patients WHERE id = p_patient_id) THEN
        RAISE EXCEPTION 'Пациент не найден' USING ERRCODE = 'P0002';
    END IF;
    OPEN p_result FOR
        SELECT p.id, p.last_name, p.first_name, p.middle_name, p.birth_date,
            p.sex, p.phone, p.email, p.address, p.is_active, p.version,
            s.case_count, s.hospitalization_count, s.last_visit_at, s.treatment_status
        FROM project.patients p
        JOIN project.vw_patient_treatment_summary s ON s.patient_id = p.id
        WHERE p.id = p_patient_id;
END;
$body$;

CREATE FUNCTION project.fn_patient_row_version()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, project
AS $body$
BEGIN
    NEW.version := OLD.version + 1;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$body$;
CREATE TRIGGER trg_patient_row_version BEFORE UPDATE ON project.patients
FOR EACH ROW EXECUTE FUNCTION project.fn_patient_row_version();

CREATE FUNCTION project.fn_audit_patient_changes()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, project
AS $body$
DECLARE
    v_actor_text text := nullif(current_setting('medcore.actor_user_id', true), '');
    v_actor bigint;
    v_old jsonb;
    v_new jsonb;
    v_fields text[];
BEGIN
    IF v_actor_text IS NOT NULL THEN
        v_actor := v_actor_text::bigint;
        IF NOT EXISTS (SELECT 1 FROM project.users WHERE id = v_actor AND is_active) THEN
            RAISE EXCEPTION 'Недопустимый автор операции аудита' USING ERRCODE = '22023';
        END IF;
    END IF;
    IF TG_OP = 'INSERT' THEN
        v_old := '{}'::jsonb;
        v_new := to_jsonb(NEW);
    ELSIF TG_OP = 'DELETE' THEN
        v_old := to_jsonb(OLD);
        v_new := '{}'::jsonb;
    ELSE
        v_old := to_jsonb(OLD);
        v_new := to_jsonb(NEW);
    END IF;
    SELECT array_agg(field_name ORDER BY field_name) INTO v_fields
    FROM (
        SELECT jsonb_object_keys(v_old || v_new) AS field_name
    ) AS keys
    WHERE v_old -> field_name IS DISTINCT FROM v_new -> field_name;
    INSERT INTO project.audit_logs(actor_user_id, action, entity_type, entity_id,
        changed_fields, request_id, outcome)
    VALUES (v_actor, lower(TG_OP), 'patient',
        CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
        v_fields, nullif(current_setting('medcore.request_id', true), ''), 'success');
    RETURN NULL;
END;
$body$;
CREATE TRIGGER trg_audit_patient_changes AFTER INSERT OR UPDATE OR DELETE ON project.patients
FOR EACH ROW EXECUTE FUNCTION project.fn_audit_patient_changes();

-- Do not leave routine execution available through the PUBLIC role. Deployment
-- must grant exact signatures only to trusted roles after defining authorization.
REVOKE ALL ON FUNCTION project.fn_department_occupancy(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION project.fn_doctor_experience(bigint, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION project.fn_patient_row_version() FROM PUBLIC;
REVOKE ALL ON FUNCTION project.fn_audit_patient_changes() FROM PUBLIC;
REVOKE ALL ON PROCEDURE project.sp_register_patient(text,text,text,date,text,text,text,text,bigint) FROM PUBLIC;
REVOKE ALL ON PROCEDURE project.sp_update_patient(bigint,integer,text,text,text) FROM PUBLIC;
REVOKE ALL ON PROCEDURE project.sp_delete_patient_draft(bigint,integer) FROM PUBLIC;
REVOKE ALL ON PROCEDURE project.sp_get_patient_summary(bigint,refcursor) FROM PUBLIC;
COMMIT;
