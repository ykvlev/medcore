-- MEDCORE: twelve prepared statements for a single database session.
-- Run after migrations with ON_ERROR_STOP. PREPARE does not execute the queries.
-- Array parameters contain organization IDs ALREADY authorized by the API.
-- Supplying an array is not authorization by itself. No API integration exists yet.

-- Q01 WHERE/ILIKE: patient search within an authorized organization context.
-- Parameters: name fragment, authorized organization IDs, limit (1..100), offset.
PREPARE medcore_q01(text, bigint[], integer, integer) AS
SELECT p.id, p.last_name, p.first_name, p.middle_name, p.birth_date, p.is_active,
    greatest(sc.last_case_at, sc.last_appointment_at) AS last_visit_at,
    CASE WHEN sc.has_inpatient THEN 'inpatient' WHEN sc.has_open_case THEN 'outpatient'
        ELSE 'not_in_treatment' END AS treatment_status
FROM project.patients p
LEFT JOIN LATERAL (
    SELECT max(c.opened_at) AS last_case_at,
        (SELECT max(a.completed_at) FROM project.appointments a
            JOIN project.medical_cases ac ON ac.id = a.case_id
            WHERE ac.patient_id = p.id AND ac.organization_id = ANY($2)
              AND ac.status <> 'cancelled' AND a.status = 'completed') AS last_appointment_at,
        coalesce(bool_or(c.status = 'open'), false) AS has_open_case,
        coalesce(bool_or(EXISTS (SELECT 1 FROM project.hospitalizations h
            WHERE h.case_id = c.id AND h.status = 'active'
              AND tstzrange(h.admitted_at, h.discharged_at, '[)') @> CURRENT_TIMESTAMP)), false)
            AS has_inpatient
    FROM project.medical_cases c
    WHERE c.patient_id = p.id AND c.organization_id = ANY($2) AND c.status <> 'cancelled'
) sc ON true
WHERE (p.last_name || ' ' || p.first_name || ' ' || coalesce(p.middle_name, ''))
    ILIKE '%' || $1 || '%'
  AND (EXISTS (SELECT 1 FROM project.medical_cases c
        WHERE c.patient_id = p.id AND c.organization_id = ANY($2))
    OR EXISTS (SELECT 1 FROM project.patient_attachments pa
        WHERE pa.patient_id = p.id AND pa.polyclinic_id = ANY($2)
          AND tstzrange(pa.started_at, pa.ended_at, '[)') @> CURRENT_TIMESTAMP))
ORDER BY p.last_name, p.first_name, p.middle_name NULLS FIRST, p.id
LIMIT least(greatest($3, 1), 100) OFFSET greatest($4, 0);

-- Q02 scalar subquery: doctors whose merged experience exceeds the scoped average.
-- Parameters: as-of date, authorized organizations.
PREPARE medcore_q02(date, bigint[]) AS
WITH scoped AS (
    SELECT d.employee_id AS doctor_id,
        concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS full_name,
        project.fn_doctor_experience(d.employee_id, $1) AS experience_years
    FROM project.doctors d JOIN project.employees e ON e.id = d.employee_id
    WHERE EXISTS (SELECT 1 FROM project.employments em
        WHERE em.employee_id = d.employee_id AND em.organization_id = ANY($2)
          AND daterange(em.started_on, em.ended_on, '[)') @> $1)
)
SELECT doctor_id, full_name, experience_years FROM scoped
WHERE experience_years > (SELECT avg(experience_years) FROM scoped)
ORDER BY experience_years DESC, doctor_id;

-- Q03 derived table: compare each department's load with the scoped average.
-- Parameter: authorized hospital IDs.
PREPARE medcore_q03(bigint[]) AS
SELECT load.department_id, load.department_name, load.occupancy_percent,
    load.occupancy_percent - averages.average_percent AS difference_percentage_points
FROM (
    SELECT * FROM project.vw_hospital_capacity WHERE hospital_id = ANY($1)
) AS load
CROSS JOIN (
    SELECT avg(occupancy_percent) AS average_percent
    FROM project.vw_hospital_capacity WHERE hospital_id = ANY($1)
) AS averages
ORDER BY load.occupancy_percent DESC NULLS LAST, load.department_id;

-- Q04 EXISTS: organizations with a contract valid on the specified calendar date.
-- Parameters: date, authorized organizations.
PREPARE medcore_q04(date, bigint[]) AS
SELECT o.id, o.name, o.organization_type
FROM project.medical_organizations o
WHERE o.id = ANY($2) AND EXISTS (
    SELECT 1 FROM project.laboratory_contracts lc
    JOIN project.laboratories l ON l.id = lc.laboratory_id
    WHERE lc.organization_id = o.id AND lc.is_active AND l.is_active
      AND $1 BETWEEN lc.valid_from AND lc.valid_until
)
ORDER BY o.name, o.id;

-- Q05 set operations: doctors shared by or exclusive to two authorized employers.
-- Parameters: hospital ID, polyclinic ID, date. API validates both IDs and types.
PREPARE medcore_q05(bigint, bigint, date) AS
WITH hospital_doctors AS (
    SELECT e.employee_id FROM project.employments e
    JOIN project.doctors d ON d.employee_id = e.employee_id
    WHERE e.organization_id = $1 AND daterange(e.started_on, e.ended_on, '[)') @> $3
), clinic_doctors AS (
    SELECT e.employee_id FROM project.employments e
    JOIN project.doctors d ON d.employee_id = e.employee_id
    WHERE e.organization_id = $2 AND daterange(e.started_on, e.ended_on, '[)') @> $3
), sets AS (
    SELECT 'both'::text AS membership, employee_id FROM (
        SELECT employee_id FROM hospital_doctors INTERSECT SELECT employee_id FROM clinic_doctors
    ) AS shared
    UNION ALL
    SELECT 'hospital_only', employee_id FROM (
        SELECT employee_id FROM hospital_doctors EXCEPT SELECT employee_id FROM clinic_doctors
    ) AS only_hospital
    UNION ALL
    SELECT 'polyclinic_only', employee_id FROM (
        SELECT employee_id FROM clinic_doctors EXCEPT SELECT employee_id FROM hospital_doctors
    ) AS only_clinic
)
SELECT s.membership, e.id AS doctor_id,
    concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS full_name
FROM sets s JOIN project.employees e ON e.id = s.employee_id
ORDER BY s.membership, e.id;

-- Q06 WITH: admissions/discharges and occupied bed-days in a half-open period.
-- Parameters: from, until, authorized hospitals. Duration is elapsed days /86400.
PREPARE medcore_q06(timestamptz, timestamptz, bigint[]) AS
WITH scoped_hospitalizations AS (
    SELECT h.*, b.hospital_id FROM project.hospitalizations h
    JOIN project.departments d ON d.id = h.department_id
    JOIN project.buildings b ON b.id = d.building_id
    WHERE b.hospital_id = ANY($3) AND h.status <> 'cancelled' AND $2 > $1
), summary AS (
    SELECT hospital_id,
        count(*) FILTER (WHERE admitted_at >= $1 AND admitted_at < $2) AS admissions,
        count(*) FILTER (WHERE discharged_at >= $1 AND discharged_at < $2) AS discharges
    FROM scoped_hospitalizations GROUP BY hospital_id
), bed_days AS (
    SELECT b.hospital_id, sum(extract(epoch FROM
        (least(coalesce(bo.ended_at, CURRENT_TIMESTAMP), $2)
         - greatest(bo.started_at, $1))) / 86400.0) AS occupied_bed_days
    FROM project.bed_occupancies bo
    JOIN project.beds bed ON bed.id = bo.bed_id
    JOIN project.wards w ON w.id = bed.ward_id
    JOIN project.departments d ON d.id = w.department_id
    JOIN project.buildings b ON b.id = d.building_id
    WHERE b.hospital_id = ANY($3) AND $2 > $1
      AND bo.started_at < least($2, CURRENT_TIMESTAMP)
      AND coalesce(bo.ended_at, CURRENT_TIMESTAMP) > $1
    GROUP BY b.hospital_id
)
SELECT o.id AS hospital_id, o.name, coalesce(s.admissions, 0) AS admissions,
    coalesce(s.discharges, 0) AS discharges,
    round(coalesce(bd.occupied_bed_days, 0), 2) AS occupied_bed_days
FROM project.hospitals h JOIN project.medical_organizations o ON o.id = h.organization_id
LEFT JOIN summary s ON s.hospital_id = h.organization_id
LEFT JOIN bed_days bd ON bd.hospital_id = h.organization_id
WHERE h.organization_id = ANY($3) AND $2 > $1 ORDER BY o.id;

-- Q07 GROUP BY/HAVING: departments over a physical-bed occupancy threshold.
-- Parameters: threshold percentage, authorized hospitals.
PREPARE medcore_q07(numeric, bigint[]) AS
SELECT d.id AS department_id, d.name,
    count(*) AS total_beds,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM project.bed_occupancies bo
        WHERE bo.bed_id = bed.id
          AND tstzrange(bo.started_at, bo.ended_at, '[)') @> CURRENT_TIMESTAMP)) AS occupied_beds
FROM project.departments d
JOIN project.buildings b ON b.id = d.building_id
JOIN project.wards w ON w.department_id = d.id
JOIN project.beds bed ON bed.ward_id = w.id
WHERE b.hospital_id = ANY($2)
GROUP BY d.id, d.name
HAVING 100.0 * count(*) FILTER (WHERE EXISTS (
    SELECT 1 FROM project.bed_occupancies bo WHERE bo.bed_id = bed.id
      AND tstzrange(bo.started_at, bo.ended_at, '[)') @> CURRENT_TIMESTAMP)) / count(*) >= $1
ORDER BY d.id;

-- Q08 JOIN: hospitalization card. Admission and current departments are distinct.
-- Parameters: hospitalization ID, authorized hospital IDs.
PREPARE medcore_q08(bigint, bigint[]) AS
SELECT h.id, h.status, h.admitted_at, h.discharged_at,
    p.id AS patient_id, concat_ws(' ', p.last_name, p.first_name, p.middle_name) AS patient_name,
    o.id AS hospital_id, o.name AS hospital_name,
    admission_d.id AS admission_department_id, admission_d.name AS admission_department_name,
    current_d.id AS current_department_id, current_d.name AS current_department_name,
    w.number AS current_ward, bed.number AS current_bed,
    physician.doctor_id, concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS doctor_name,
    r.reason AS referral_reason
FROM project.hospitalizations h
JOIN project.patients p ON p.id = h.patient_id
JOIN project.referrals r ON r.id = h.referral_id
JOIN project.departments admission_d ON admission_d.id = h.department_id
JOIN project.buildings bu ON bu.id = admission_d.building_id
JOIN project.medical_organizations o ON o.id = bu.hospital_id
LEFT JOIN project.bed_occupancies bo ON bo.hospitalization_id = h.id
    AND tstzrange(bo.started_at, bo.ended_at, '[)') @> CURRENT_TIMESTAMP
LEFT JOIN project.beds bed ON bed.id = bo.bed_id
LEFT JOIN project.wards w ON w.id = bed.ward_id
LEFT JOIN project.departments current_d ON current_d.id = w.department_id
LEFT JOIN project.attending_physician_history physician ON physician.hospitalization_id = h.id
    AND tstzrange(physician.started_at, physician.ended_at, '[)') @> CURRENT_TIMESTAMP
LEFT JOIN project.employees e ON e.id = physician.doctor_id
WHERE h.id = $1 AND o.id = ANY($2);

-- Q09 string/date functions: treatment duration and patient age at admission.
-- Parameters: period start/end, authorized hospital IDs.
PREPARE medcore_q09(timestamptz, timestamptz, bigint[]) AS
SELECT h.id, concat_ws(' ', p.last_name, p.first_name, p.middle_name) AS patient_name,
    extract(year FROM age((h.admitted_at AT TIME ZONE 'Europe/Moscow')::date, p.birth_date))::integer
        AS age_at_admission,
    h.admitted_at, h.discharged_at,
    round(extract(epoch FROM (coalesce(h.discharged_at, CURRENT_TIMESTAMP) - h.admitted_at))
        / 86400.0, 2) AS elapsed_treatment_days
FROM project.hospitalizations h JOIN project.patients p ON p.id = h.patient_id
JOIN project.departments d ON d.id = h.department_id
JOIN project.buildings b ON b.id = d.building_id
WHERE b.hospital_id = ANY($3) AND h.status <> 'cancelled'
  AND h.admitted_at >= $1 AND h.admitted_at < $2
ORDER BY h.admitted_at, h.id;

-- Q10 recursive WITH: physical hospital structure. Stable prefixed IDs avoid
-- collision between keys from different tables; path also gives a stable order.
-- Parameter: authorized hospital IDs.
PREPARE medcore_q10(bigint[]) AS
WITH RECURSIVE nodes AS (
    SELECT 'hospital:' || o.id AS node_id, NULL::text AS parent_id,
        o.name AS label, 'hospital'::text AS node_type
    FROM project.hospitals h JOIN project.medical_organizations o ON o.id = h.organization_id
    WHERE o.id = ANY($1)
    UNION ALL
    SELECT 'building:' || id, 'hospital:' || hospital_id, code, 'building' FROM project.buildings
    UNION ALL
    SELECT 'department:' || id, 'building:' || building_id, name, 'department' FROM project.departments
    UNION ALL
    SELECT 'ward:' || id, 'department:' || department_id, number, 'ward' FROM project.wards
    UNION ALL
    SELECT 'bed:' || id, 'ward:' || ward_id, number, 'bed' FROM project.beds
), tree AS (
    SELECT node_id, parent_id, label, node_type, 0 AS depth, ARRAY[node_id] AS path
    FROM nodes WHERE parent_id IS NULL
    UNION ALL
    SELECT n.node_id, n.parent_id, n.label, n.node_type, t.depth + 1, t.path || n.node_id
    FROM nodes n JOIN tree t ON n.parent_id = t.node_id
    WHERE NOT n.node_id = ANY(t.path)
)
SELECT node_id, parent_id, label, node_type, depth FROM tree ORDER BY path;

-- Q11 pivot via FILTER: admissions by calendar month (Europe/Moscow).
-- Parameters: year (1..9998), authorized hospitals. API validates the year.
PREPARE medcore_q11(integer, bigint[]) AS
SELECT o.id AS hospital_id, o.name,
    count(*) FILTER (WHERE extract(month FROM h.admitted_at AT TIME ZONE 'Europe/Moscow') = 1) AS jan,
    count(*) FILTER (WHERE extract(month FROM h.admitted_at AT TIME ZONE 'Europe/Moscow') = 2) AS feb,
    count(*) FILTER (WHERE extract(month FROM h.admitted_at AT TIME ZONE 'Europe/Moscow') = 3) AS mar,
    count(*) FILTER (WHERE extract(month FROM h.admitted_at AT TIME ZONE 'Europe/Moscow') = 4) AS apr,
    count(*) FILTER (WHERE extract(month FROM h.admitted_at AT TIME ZONE 'Europe/Moscow') = 5) AS may,
    count(*) FILTER (WHERE extract(month FROM h.admitted_at AT TIME ZONE 'Europe/Moscow') = 6) AS jun,
    count(*) FILTER (WHERE extract(month FROM h.admitted_at AT TIME ZONE 'Europe/Moscow') = 7) AS jul,
    count(*) FILTER (WHERE extract(month FROM h.admitted_at AT TIME ZONE 'Europe/Moscow') = 8) AS aug,
    count(*) FILTER (WHERE extract(month FROM h.admitted_at AT TIME ZONE 'Europe/Moscow') = 9) AS sep,
    count(*) FILTER (WHERE extract(month FROM h.admitted_at AT TIME ZONE 'Europe/Moscow') = 10) AS oct,
    count(*) FILTER (WHERE extract(month FROM h.admitted_at AT TIME ZONE 'Europe/Moscow') = 11) AS nov,
    count(*) FILTER (WHERE extract(month FROM h.admitted_at AT TIME ZONE 'Europe/Moscow') = 12) AS dec
FROM project.hospitals hospital
JOIN project.medical_organizations o ON o.id = hospital.organization_id
LEFT JOIN project.buildings b ON b.hospital_id = o.id
LEFT JOIN project.departments d ON d.building_id = b.id
LEFT JOIN project.hospitalizations h ON h.department_id = d.id AND h.status <> 'cancelled'
    AND h.admitted_at >= make_date($1, 1, 1)::timestamp AT TIME ZONE 'Europe/Moscow'
    AND h.admitted_at < make_date($1 + 1, 1, 1)::timestamp AT TIME ZONE 'Europe/Moscow'
WHERE o.id = ANY($2) GROUP BY o.id, o.name ORDER BY o.id;

-- Q12 window functions: admission load ranking in each authorized hospital.
-- Parameters: half-open period start/end, authorized hospitals.
PREPARE medcore_q12(timestamptz, timestamptz, bigint[]) AS
WITH counts AS (
    SELECT b.hospital_id, d.id AS department_id, d.name,
        count(h.id) AS admissions
    FROM project.departments d JOIN project.buildings b ON b.id = d.building_id
    LEFT JOIN project.hospitalizations h ON h.department_id = d.id AND h.status <> 'cancelled'
        AND h.admitted_at >= $1 AND h.admitted_at < $2
    WHERE b.hospital_id = ANY($3) AND $2 > $1
    GROUP BY b.hospital_id, d.id, d.name
)
SELECT hospital_id, department_id, name, admissions,
    dense_rank() OVER (PARTITION BY hospital_id ORDER BY admissions DESC) AS load_rank,
    round(100.0 * admissions / nullif(sum(admissions) OVER (PARTITION BY hospital_id), 0), 2)
        AS share_of_hospital_admissions_percent
FROM counts ORDER BY hospital_id, load_rank, department_id;
