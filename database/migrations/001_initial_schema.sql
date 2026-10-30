-- MEDCORE: initial relational structure.
-- Run as the schema owner against an empty database using ON_ERROR_STOP.
-- This migration does NOT yet implement application permissions or all business rules.
BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE SCHEMA IF NOT EXISTS project;
SET LOCAL search_path = project, public;

CREATE DOMAIN positive_bed_count AS integer CHECK (VALUE > 0);
CREATE TYPE hospitalization_status AS ENUM ('active', 'discharged', 'cancelled');

-- Organizations: discriminator FK prevents a clinic from being a hospital subtype.
CREATE TABLE medical_organizations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL CHECK (btrim(name) <> ''),
    organization_type text NOT NULL CHECK (organization_type IN ('hospital', 'polyclinic')),
    address text NOT NULL CHECK (btrim(address) <> ''),
    phone text,
    email text,
    is_active boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (id, organization_type)
);
CREATE TABLE hospitals (
    organization_id bigint PRIMARY KEY,
    organization_type text NOT NULL DEFAULT 'hospital' CHECK (organization_type = 'hospital'),
    FOREIGN KEY (organization_id, organization_type)
        REFERENCES medical_organizations(id, organization_type)
);
CREATE TABLE polyclinics (
    organization_id bigint PRIMARY KEY,
    organization_type text NOT NULL DEFAULT 'polyclinic' CHECK (organization_type = 'polyclinic'),
    hospital_id bigint REFERENCES hospitals(organization_id),
    FOREIGN KEY (organization_id, organization_type)
        REFERENCES medical_organizations(id, organization_type)
);
CREATE TABLE buildings (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hospital_id bigint NOT NULL REFERENCES hospitals(organization_id),
    code text NOT NULL CHECK (btrim(code) <> ''),
    address text NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    UNIQUE (hospital_id, code)
);
CREATE TABLE department_specializations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL UNIQUE
);
CREATE TABLE departments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    building_id bigint NOT NULL REFERENCES buildings(id),
    specialization_id bigint NOT NULL REFERENCES department_specializations(id),
    name text NOT NULL CHECK (btrim(name) <> ''),
    is_active boolean NOT NULL DEFAULT true,
    UNIQUE (building_id, name)
);
CREATE TABLE wards (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    department_id bigint NOT NULL REFERENCES departments(id),
    number text NOT NULL CHECK (btrim(number) <> ''),
    planned_capacity positive_bed_count NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    UNIQUE (department_id, number)
);
CREATE TABLE beds (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ward_id bigint NOT NULL REFERENCES wards(id),
    number text NOT NULL CHECK (btrim(number) <> ''),
    is_active boolean NOT NULL DEFAULT true,
    UNIQUE (ward_id, number)
);

-- Personnel. Scientific ranks are validated by a later business-rule migration.
CREATE TABLE employee_categories (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL UNIQUE
);
CREATE TABLE employees (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category_id bigint NOT NULL REFERENCES employee_categories(id),
    last_name text NOT NULL CHECK (btrim(last_name) <> ''),
    first_name text NOT NULL CHECK (btrim(first_name) <> ''),
    middle_name text,
    birth_date date NOT NULL,
    phone text,
    email text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE academic_degrees (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text NOT NULL UNIQUE CHECK (code IN ('none', 'candidate', 'doctor')),
    name text NOT NULL UNIQUE,
    degree_rank smallint NOT NULL UNIQUE CHECK (degree_rank BETWEEN 0 AND 2)
);
CREATE TABLE academic_titles (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text NOT NULL UNIQUE CHECK (code IN ('none', 'docent', 'professor')),
    name text NOT NULL UNIQUE,
    minimum_degree_rank smallint NOT NULL CHECK (minimum_degree_rank BETWEEN 0 AND 2)
);
CREATE TABLE doctors (
    employee_id bigint PRIMARY KEY REFERENCES employees(id),
    academic_degree_id bigint NOT NULL REFERENCES academic_degrees(id),
    academic_title_id bigint NOT NULL REFERENCES academic_titles(id),
    qualification text
);
CREATE TABLE specialties (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL UNIQUE,
    allows_surgery boolean NOT NULL DEFAULT false
);
CREATE TABLE doctor_specialties (
    doctor_id bigint NOT NULL REFERENCES doctors(employee_id),
    specialty_id bigint NOT NULL REFERENCES specialties(id),
    certified_on date NOT NULL,
    valid_until date,
    PRIMARY KEY (doctor_id, specialty_id),
    CHECK (valid_until IS NULL OR valid_until >= certified_on)
);
CREATE TABLE employments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id bigint NOT NULL REFERENCES employees(id),
    organization_id bigint NOT NULL REFERENCES medical_organizations(id),
    position_name text NOT NULL CHECK (btrim(position_name) <> ''),
    started_on date NOT NULL,
    ended_on date,
    workload_fraction numeric(4,2) NOT NULL CHECK (workload_fraction > 0 AND workload_fraction <= 2),
    CHECK (ended_on IS NULL OR ended_on > started_on),
    EXCLUDE USING gist (employee_id WITH =, organization_id WITH =,
        daterange(started_on, ended_on, '[)') WITH &&)
);
CREATE TABLE consultation_assignments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    doctor_id bigint NOT NULL REFERENCES doctors(employee_id),
    organization_id bigint NOT NULL REFERENCES medical_organizations(id),
    started_on date NOT NULL,
    ended_on date,
    CHECK (ended_on IS NULL OR ended_on > started_on),
    EXCLUDE USING gist (doctor_id WITH =, organization_id WITH =,
        daterange(started_on, ended_on, '[)') WITH &&)
);
CREATE TABLE specialty_conditions (
    specialty_id bigint PRIMARY KEY REFERENCES specialties(id),
    pay_coefficient numeric(6,3) NOT NULL DEFAULT 1 CHECK (pay_coefficient >= 1),
    extra_leave_days integer NOT NULL DEFAULT 0 CHECK (extra_leave_days >= 0),
    configuration_note text NOT NULL
);

-- Patient identity is stored once. Treatments refer to the patient through a case.
CREATE TABLE patients (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    last_name text NOT NULL CHECK (btrim(last_name) <> ''),
    first_name text NOT NULL CHECK (btrim(first_name) <> ''),
    middle_name text,
    birth_date date NOT NULL,
    sex text NOT NULL CHECK (sex IN ('male', 'female', 'unknown')),
    phone text,
    email text,
    address text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);
CREATE TABLE patient_attachments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id bigint NOT NULL REFERENCES patients(id),
    polyclinic_id bigint NOT NULL REFERENCES polyclinics(organization_id),
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    CHECK (ended_at IS NULL OR ended_at > started_at),
    EXCLUDE USING gist (patient_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&)
);
CREATE TABLE medical_cases (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    patient_id bigint NOT NULL REFERENCES patients(id),
    organization_id bigint NOT NULL REFERENCES medical_organizations(id),
    case_type text NOT NULL CHECK (case_type IN ('outpatient', 'inpatient')),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
    opened_at timestamptz NOT NULL,
    closed_at timestamptz,
    reason text NOT NULL CHECK (btrim(reason) <> ''),
    CHECK (closed_at IS NULL OR closed_at >= opened_at),
    CHECK ((status = 'open' AND closed_at IS NULL) OR (status <> 'open' AND closed_at IS NOT NULL)),
    UNIQUE (id, patient_id)
);
CREATE TABLE diagnoses (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL
);
CREATE TABLE case_diagnoses (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id bigint NOT NULL REFERENCES medical_cases(id),
    diagnosis_id bigint NOT NULL REFERENCES diagnoses(id),
    doctor_id bigint NOT NULL REFERENCES doctors(employee_id),
    recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_primary boolean NOT NULL DEFAULT false,
    note text
);
CREATE UNIQUE INDEX uq_case_primary_diagnosis ON case_diagnoses(case_id) WHERE is_primary;
CREATE TABLE appointments (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id bigint NOT NULL REFERENCES medical_cases(id),
    scheduled_at timestamptz NOT NULL,
    duration_minutes integer NOT NULL DEFAULT 30 CHECK (duration_minutes > 0),
    status text NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'completed', 'cancelled', 'no_show')),
    reason text,
    completed_at timestamptz,
    CHECK ((status = 'completed' AND completed_at IS NOT NULL)
        OR (status <> 'completed' AND completed_at IS NULL))
);
CREATE TABLE appointment_doctors (
    appointment_id bigint NOT NULL REFERENCES appointments(id),
    doctor_id bigint NOT NULL REFERENCES doctors(employee_id),
    PRIMARY KEY (appointment_id, doctor_id)
);
CREATE TABLE referrals (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id bigint NOT NULL REFERENCES medical_cases(id),
    referring_doctor_id bigint NOT NULL REFERENCES doctors(employee_id),
    target_hospital_id bigint NOT NULL REFERENCES hospitals(organization_id),
    specialization_id bigint NOT NULL REFERENCES department_specializations(id),
    issued_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reason text NOT NULL CHECK (btrim(reason) <> ''),
    status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'used', 'cancelled'))
);
CREATE TABLE hospitalizations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id bigint NOT NULL UNIQUE,
    patient_id bigint NOT NULL,
    referral_id bigint NOT NULL UNIQUE REFERENCES referrals(id),
    department_id bigint NOT NULL REFERENCES departments(id),
    admitted_at timestamptz NOT NULL,
    discharged_at timestamptz,
    status hospitalization_status NOT NULL DEFAULT 'active',
    discharge_summary text,
    FOREIGN KEY (case_id, patient_id) REFERENCES medical_cases(id, patient_id),
    CHECK (discharged_at IS NULL OR discharged_at > admitted_at),
    CHECK ((status = 'active' AND discharged_at IS NULL)
        OR (status = 'discharged' AND discharged_at IS NOT NULL)
        OR status = 'cancelled'),
    EXCLUDE USING gist (patient_id WITH =, tstzrange(admitted_at, discharged_at, '[)') WITH &&)
        WHERE (status <> 'cancelled')
);
COMMENT ON COLUMN hospitalizations.department_id IS
    'Admission department; current and historical departments are derived from bed occupancies.';
CREATE TABLE attending_physician_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hospitalization_id bigint NOT NULL REFERENCES hospitalizations(id),
    doctor_id bigint NOT NULL REFERENCES doctors(employee_id),
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    CHECK (ended_at IS NULL OR ended_at > started_at),
    EXCLUDE USING gist (hospitalization_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&)
);
CREATE TABLE bed_occupancies (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    hospitalization_id bigint NOT NULL REFERENCES hospitalizations(id),
    bed_id bigint NOT NULL REFERENCES beds(id),
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    CHECK (ended_at IS NULL OR ended_at > started_at),
    EXCLUDE USING gist (bed_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&),
    EXCLUDE USING gist (hospitalization_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&)
);
CREATE TABLE medical_record_entries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id bigint NOT NULL REFERENCES medical_cases(id),
    doctor_id bigint NOT NULL REFERENCES doctors(employee_id),
    entry_type text NOT NULL CHECK (entry_type IN ('examination', 'progress', 'discharge', 'correction')),
    content text NOT NULL CHECK (btrim(content) <> ''),
    recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    corrects_entry_id bigint REFERENCES medical_record_entries(id),
    CHECK (corrects_entry_id IS NULL OR corrects_entry_id <> id)
);
CREATE TABLE prescriptions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id bigint NOT NULL REFERENCES medical_cases(id),
    doctor_id bigint NOT NULL REFERENCES doctors(employee_id),
    description text NOT NULL CHECK (btrim(description) <> ''),
    prescribed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_on date NOT NULL,
    ended_on date,
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
    CHECK (ended_on IS NULL OR ended_on >= started_on)
);
CREATE TABLE surgeries (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id bigint NOT NULL REFERENCES medical_cases(id),
    name text NOT NULL CHECK (btrim(name) <> ''),
    started_at timestamptz NOT NULL,
    ended_at timestamptz,
    outcome text NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'survived', 'fatal', 'cancelled')),
    note text,
    CHECK (ended_at IS NULL OR ended_at > started_at),
    CHECK (outcome NOT IN ('survived', 'fatal') OR ended_at IS NOT NULL)
);
CREATE TABLE surgery_participants (
    surgery_id bigint NOT NULL REFERENCES surgeries(id),
    doctor_id bigint NOT NULL,
    specialty_id bigint NOT NULL,
    participation_role text NOT NULL CHECK (participation_role IN ('lead', 'assistant', 'anesthetist')),
    PRIMARY KEY (surgery_id, doctor_id),
    FOREIGN KEY (doctor_id, specialty_id) REFERENCES doctor_specialties(doctor_id, specialty_id)
);
CREATE UNIQUE INDEX uq_surgery_lead ON surgery_participants(surgery_id) WHERE participation_role = 'lead';

-- Laboratories are contractual partners, not a third subtype of city institution.
CREATE TABLE laboratories (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL CHECK (btrim(name) <> ''),
    address text NOT NULL,
    phone text,
    email text,
    is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE laboratory_profiles (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text NOT NULL UNIQUE,
    name text NOT NULL UNIQUE
);
CREATE TABLE laboratory_profile_links (
    laboratory_id bigint NOT NULL REFERENCES laboratories(id),
    profile_id bigint NOT NULL REFERENCES laboratory_profiles(id),
    PRIMARY KEY (laboratory_id, profile_id)
);
CREATE TABLE laboratory_contracts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    laboratory_id bigint NOT NULL REFERENCES laboratories(id),
    organization_id bigint NOT NULL REFERENCES medical_organizations(id),
    contract_number text NOT NULL,
    valid_from date NOT NULL,
    valid_until date NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    CHECK (valid_until >= valid_from),
    UNIQUE (laboratory_id, organization_id, contract_number)
);
CREATE TABLE lab_test_types (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    profile_id bigint NOT NULL REFERENCES laboratory_profiles(id),
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    measurement_unit text,
    reference_description text
);
CREATE TABLE lab_orders (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    case_id bigint NOT NULL REFERENCES medical_cases(id),
    doctor_id bigint NOT NULL REFERENCES doctors(employee_id),
    test_type_id bigint NOT NULL REFERENCES lab_test_types(id),
    contract_id bigint NOT NULL REFERENCES laboratory_contracts(id),
    ordered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status text NOT NULL DEFAULT 'ordered'
        CHECK (status IN ('ordered', 'in_progress', 'completed', 'cancelled')),
    note text
);

-- Users do not own clinical history; disabling a user cannot delete it.
CREATE TABLE users (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    employee_id bigint UNIQUE REFERENCES employees(id),
    login text NOT NULL CHECK (btrim(login) <> ''),
    password_hash text NOT NULL CHECK (btrim(password_hash) <> ''),
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX uq_user_login ON users(lower(login));
CREATE TABLE roles (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code text NOT NULL UNIQUE CHECK (code IN (
        'system_admin', 'organization_admin', 'doctor', 'registrar', 'lab_staff', 'analyst')),
    name text NOT NULL UNIQUE
);
CREATE TABLE user_roles (
    user_id bigint NOT NULL REFERENCES users(id),
    role_id bigint NOT NULL REFERENCES roles(id),
    PRIMARY KEY (user_id, role_id)
);
-- Adds organizational context to the six roles from the original specification.
CREATE TABLE user_organization_scopes (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL,
    role_id bigint NOT NULL,
    organization_id bigint REFERENCES medical_organizations(id),
    laboratory_id bigint REFERENCES laboratories(id),
    FOREIGN KEY (user_id, role_id) REFERENCES user_roles(user_id, role_id),
    CHECK (num_nonnulls(organization_id, laboratory_id) = 1)
);
CREATE UNIQUE INDEX uq_scope_organization ON user_organization_scopes(user_id, role_id, organization_id)
    WHERE organization_id IS NOT NULL;
CREATE UNIQUE INDEX uq_scope_laboratory ON user_organization_scopes(user_id, role_id, laboratory_id)
    WHERE laboratory_id IS NOT NULL;
CREATE TABLE user_sessions (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id),
    token_hash text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE TABLE lab_results (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    order_id bigint NOT NULL REFERENCES lab_orders(id),
    entered_by_user_id bigint NOT NULL REFERENCES users(id),
    result_text text NOT NULL CHECK (btrim(result_text) <> ''),
    numeric_value numeric,
    measured_at timestamptz NOT NULL,
    entered_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    supersedes_result_id bigint UNIQUE REFERENCES lab_results(id),
    CHECK (supersedes_result_id IS NULL OR supersedes_result_id <> id)
);
CREATE UNIQUE INDEX uq_initial_lab_result ON lab_results(order_id) WHERE supersedes_result_id IS NULL;
CREATE TABLE audit_logs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_user_id bigint REFERENCES users(id),
    occurred_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id bigint,
    changed_fields text[],
    request_id text,
    outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied'))
);
CREATE TABLE report_exports (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users(id),
    report_code text NOT NULL,
    format text NOT NULL CHECK (format IN ('csv', 'pdf')),
    parameters jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(parameters) = 'object'),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'expired')),
    storage_key text,
    expires_at timestamptz,
    CHECK (expires_at IS NULL OR expires_at > created_at),
    CHECK (status <> 'ready' OR storage_key IS NOT NULL)
);

-- Search indexes. Index usefulness must be measured on the eventual seed set.
CREATE INDEX ix_patient_name ON patients USING gin (
    (last_name || ' ' || first_name || ' ' || coalesce(middle_name, '')) gin_trgm_ops);
CREATE INDEX ix_employee_name ON employees USING gin (
    (last_name || ' ' || first_name || ' ' || coalesce(middle_name, '')) gin_trgm_ops);
CREATE INDEX ix_organization_name ON medical_organizations USING gin (name gin_trgm_ops);
CREATE INDEX ix_polyclinic_hospital ON polyclinics(hospital_id);
CREATE INDEX ix_department_specialization ON departments(specialization_id);
CREATE INDEX ix_employee_category ON employees(category_id);
CREATE INDEX ix_doctor_degree ON doctors(academic_degree_id);
CREATE INDEX ix_doctor_title ON doctors(academic_title_id);
CREATE INDEX ix_doctor_specialty ON doctor_specialties(specialty_id, doctor_id);
CREATE INDEX ix_employment_organization ON employments(organization_id);
CREATE INDEX ix_consultation_organization ON consultation_assignments(organization_id);
CREATE INDEX ix_attachment_polyclinic ON patient_attachments(polyclinic_id);
CREATE INDEX ix_case_patient ON medical_cases(patient_id, opened_at DESC);
CREATE INDEX ix_case_organization_status ON medical_cases(organization_id, status, opened_at DESC);
CREATE INDEX ix_case_diagnosis_case ON case_diagnoses(case_id);
CREATE INDEX ix_case_diagnosis_code ON case_diagnoses(diagnosis_id);
CREATE INDEX ix_case_diagnosis_doctor ON case_diagnoses(doctor_id);
CREATE INDEX ix_appointment_case ON appointments(case_id, scheduled_at DESC);
CREATE INDEX ix_appointment_doctor ON appointment_doctors(doctor_id);
CREATE INDEX ix_referral_case ON referrals(case_id);
CREATE INDEX ix_referral_doctor ON referrals(referring_doctor_id);
CREATE INDEX ix_referral_target ON referrals(target_hospital_id, specialization_id);
CREATE INDEX ix_referral_specialization ON referrals(specialization_id);
CREATE INDEX ix_hospitalization_department_date ON hospitalizations(department_id, admitted_at DESC);
CREATE INDEX ix_hospitalization_status_date ON hospitalizations(status, admitted_at DESC);
CREATE INDEX ix_attending_doctor ON attending_physician_history(doctor_id);
CREATE INDEX ix_record_case_date ON medical_record_entries(case_id, recorded_at);
CREATE INDEX ix_record_doctor ON medical_record_entries(doctor_id);
CREATE INDEX ix_record_corrects ON medical_record_entries(corrects_entry_id);
CREATE INDEX ix_prescription_case ON prescriptions(case_id);
CREATE INDEX ix_prescription_doctor ON prescriptions(doctor_id);
CREATE INDEX ix_surgery_case ON surgeries(case_id, started_at);
CREATE INDEX ix_surgery_doctor_specialty ON surgery_participants(doctor_id, specialty_id);
CREATE INDEX ix_lab_profile ON laboratory_profile_links(profile_id);
CREATE INDEX ix_contract_organization ON laboratory_contracts(organization_id, valid_until);
CREATE INDEX ix_test_profile ON lab_test_types(profile_id);
CREATE INDEX ix_lab_order_case ON lab_orders(case_id, ordered_at DESC);
CREATE INDEX ix_lab_order_doctor ON lab_orders(doctor_id);
CREATE INDEX ix_lab_order_test ON lab_orders(test_type_id);
CREATE INDEX ix_lab_order_contract ON lab_orders(contract_id);
CREATE INDEX ix_lab_result_order ON lab_results(order_id);
CREATE INDEX ix_lab_result_author ON lab_results(entered_by_user_id);
CREATE INDEX ix_user_role_role ON user_roles(role_id);
CREATE INDEX ix_scope_role ON user_organization_scopes(role_id);
CREATE INDEX ix_scope_organization ON user_organization_scopes(organization_id);
CREATE INDEX ix_scope_laboratory ON user_organization_scopes(laboratory_id);
CREATE INDEX ix_session_user ON user_sessions(user_id, expires_at);
CREATE INDEX ix_audit_actor_time ON audit_logs(actor_user_id, occurred_at DESC);
CREATE INDEX ix_audit_entity_time ON audit_logs(entity_type, entity_id, occurred_at DESC);
CREATE INDEX ix_export_user_time ON report_exports(user_id, created_at DESC);

COMMIT;
