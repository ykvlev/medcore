using Medcore.Application;
using Microsoft.EntityFrameworkCore;

namespace Medcore.Infrastructure;

public sealed partial class MedcoreStore
{
    public async Task<object> OrganizationsAsync(UserAccess access, CancellationToken cancellationToken)
    {
        var ids = access.OrganizationIds;
        if (access.HasRole("lab_staff"))
        {
            var served = await RowsAsync("""
                SELECT DISTINCT organization_id FROM project.laboratory_contracts
                WHERE laboratory_id = ANY(@labs) AND is_active AND CURRENT_DATE BETWEEN valid_from AND valid_until
                """, new() { ["labs"] = access.LaboratoryIds }, cancellationToken);
            ids = ids.Concat(served.Select(x => (long)x["organization_id"]!)).Distinct().ToArray();
        }
        var organizations = db.Organizations.AsNoTracking();
        if (!access.HasRole("system_admin") && !AccessPolicies.CanReadAllOrganizations(access))
            organizations = organizations.Where(o => ids.Contains(o.Id));
        var items = await organizations.OrderBy(o => o.Name).Select(o => new
        {
            o.Id, o.Name, o.OrganizationType, o.Address, o.Phone, o.IsActive
        }).Take(500).ToArrayAsync(cancellationToken);
        return new { items };
    }

    public async Task<object> EmployeesAsync(UserAccess access, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadEmployees(access))
            throw new ApplicationFault(403, "Нет доступа к сведениям о персонале");
        // Заведующий видит сотрудников своей больницы: привязка сотрудника к отделению
        // схемой не смоделирована (employments знает только учреждение).
        var ids = new[] { "organization_admin", "doctor", "registrar" }.SelectMany(access.OrganizationIdsFor)
            .Concat(AccessPolicies.HospitalReadOrganizationIds(access)).Distinct().ToArray();
        var rows = await RowsAsync("""
            SELECT e.id, concat_ws(' ',e.last_name,e.first_name,e.middle_name) AS "fullName", ec.name AS category,
                coalesce((SELECT string_agg(s.name, ', ' ORDER BY s.name)
                    FROM project.doctor_specialties ds JOIN project.specialties s ON s.id = ds.specialty_id
                    WHERE ds.doctor_id = e.id AND ds.certified_on <= CURRENT_DATE
                      AND (ds.valid_until IS NULL OR ds.valid_until >= CURRENT_DATE)), '') AS specialties,
                (SELECT string_agg(DISTINCT o.name, ', ' ORDER BY o.name)
                    FROM project.employments em JOIN project.medical_organizations o ON o.id = em.organization_id
                    WHERE em.employee_id = e.id AND em.organization_id = ANY(@orgs)
                      AND daterange(em.started_on,em.ended_on,'[)') @> CURRENT_DATE) AS "organizationName",
                e.is_active AS "isActive"
            FROM project.employees e JOIN project.employee_categories ec ON ec.id = e.category_id
            WHERE EXISTS (SELECT 1 FROM project.employments em WHERE em.employee_id = e.id
                AND em.organization_id = ANY(@orgs) AND daterange(em.started_on,em.ended_on,'[)') @> CURRENT_DATE)
            ORDER BY e.last_name,e.first_name,e.id LIMIT 300
            """, new() { ["orgs"] = ids }, cancellationToken);
        return new { items = rows };
    }

    public async Task<object> HospitalizationsAsync(UserAccess access, CancellationToken cancellationToken)
    {
        if (!access.Roles.Any(r => r is "organization_admin" or "doctor" or "registrar")
            && !AccessPolicies.IsHospitalReader(access))
            throw new ApplicationFault(403, "Нет доступа к госпитализациям");
        var parameters = AccessParameters(access);
        parameters["manager_orgs"] = AccessPolicies.ManagerOrganizationIds(access);
        var rows = await RowsAsync($"""
            SELECT h.id, CASE WHEN {PatientAccessSql}
                    THEN concat_ws(' ',p.last_name,p.first_name,p.middle_name) ELSE 'Обезличено' END AS "patientName",
                o.name AS "hospitalName", coalesce(current_d.name, admission_d.name) AS "departmentName",
                location.ward_number AS "wardNumber", location.bed_number AS "bedNumber",
                CASE WHEN {PatientAccessSql} THEN attending.full_name ELSE NULL END AS "doctorName",
                h.admitted_at AS "admittedAt", h.discharged_at AS "dischargedAt", h.status::text AS status
            FROM project.hospitalizations h JOIN project.patients p ON p.id = h.patient_id
            JOIN project.departments admission_d ON admission_d.id = h.department_id
            JOIN project.buildings admission_b ON admission_b.id = admission_d.building_id
            JOIN project.medical_organizations o ON o.id = admission_b.hospital_id
            LEFT JOIN LATERAL (SELECT b.number AS bed_number, w.number AS ward_number, w.department_id
                FROM project.bed_occupancies bo JOIN project.beds b ON b.id = bo.bed_id
                JOIN project.wards w ON w.id = b.ward_id WHERE bo.hospitalization_id = h.id
                ORDER BY bo.started_at DESC LIMIT 1) location ON true
            LEFT JOIN project.departments current_d ON current_d.id = location.department_id
            LEFT JOIN LATERAL (SELECT concat_ws(' ',e.last_name,e.first_name,e.middle_name) AS full_name
                FROM project.attending_physician_history a JOIN project.employees e ON e.id = a.doctor_id
                WHERE a.hospitalization_id = h.id ORDER BY a.started_at DESC LIMIT 1) attending ON true
            WHERE o.id = ANY(@manager_orgs) OR {PatientAccessSql}
            ORDER BY h.admitted_at DESC,h.id LIMIT 200
            """, parameters, cancellationToken);
        return new { items = rows };
    }

    public async Task<object> LaboratoriesAsync(UserAccess access, CancellationToken cancellationToken)
    {
        if (!access.Roles.Any(r => r is "lab_staff" or "organization_admin" or "analyst" or "doctor")
            && !AccessPolicies.IsHospitalReader(access))
            throw new ApplicationFault(403, "Нет доступа к сведениям лабораторий");
        var orgs = new[] { "organization_admin", "analyst", "doctor" }.SelectMany(access.OrganizationIdsFor)
            .Concat(AccessPolicies.HospitalReadOrganizationIds(access)).Distinct().ToArray();
        var rows = await RowsAsync("""
            SELECT l.id,l.name,l.address,l.phone,
                coalesce((SELECT string_agg(p.name, ', ' ORDER BY p.name) FROM project.laboratory_profile_links link
                    JOIN project.laboratory_profiles p ON p.id = link.profile_id WHERE link.laboratory_id = l.id), '') AS profiles,
                (SELECT count(*) FROM project.laboratory_contracts contract WHERE contract.laboratory_id = l.id
                    AND contract.is_active AND CURRENT_DATE BETWEEN contract.valid_from AND contract.valid_until
                    AND (contract.organization_id = ANY(@orgs) OR l.id = ANY(@labs))) AS "activeContracts"
            FROM project.laboratories l
            WHERE l.id = ANY(@labs) OR EXISTS (SELECT 1 FROM project.laboratory_contracts contract
                WHERE contract.laboratory_id = l.id AND contract.organization_id = ANY(@orgs))
            ORDER BY l.name LIMIT 100
            """, new() { ["orgs"] = orgs, ["labs"] = access.LaboratoryIds }, cancellationToken);
        return new { items = rows };
    }

    public async Task<object> DashboardAsync(UserAccess access, CancellationToken cancellationToken)
    {
        var parameters = AccessParameters(access);
        var allOrganizations = AccessPolicies.CanReadAllOrganizations(access);
        var hospitalReader = AccessPolicies.IsHospitalReader(access);
        var broadAggregate = allOrganizations || access.HasRole("organization_admin") || access.HasRole("analyst");
        var hasMedicalMetrics = broadAggregate || hospitalReader
            || access.Roles.Any(r => r is "doctor" or "registrar");
        // Срез показателей: город (министр, губернатор), учреждения администратора и
        // аналитика, больница главного врача/заместителя/заведующего, область врача.
        var orgs = allOrganizations
            ? await db.Organizations.AsNoTracking().Select(o => o.Id).ToArrayAsync(cancellationToken)
            : broadAggregate
                ? new[] { "organization_admin", "analyst" }.SelectMany(access.OrganizationIdsFor).Distinct().ToArray()
                : hospitalReader
                    ? AccessPolicies.HospitalReadOrganizationIds(access)
                    : access.OrganizationIds;
        parameters["orgs"] = orgs;
        var department = AccessPolicies.DepartmentScope(access) ?? 0L;
        parameters["department"] = department;
        var broadCases = broadAggregate || hospitalReader || access.HasRole("registrar");
        var caseFilter = broadCases ? "c.organization_id = ANY(@orgs)" : CareCaseSql;
        // Восемь независимых агрегатов уходят одним NpgsqlBatch: раньше каждый
        // SELECT открывал соединение и стоил отдельного round-trip.
        var statements = new List<(string Name, string Sql)>();
        void Add(string name, string sql) => statements.Add((name, sql));
        Add("organizations", access.HasRole("system_admin") || allOrganizations
            ? "SELECT count(*)::bigint AS count FROM project.medical_organizations"
            : "SELECT count(*)::bigint AS count FROM project.medical_organizations o WHERE o.id = ANY(@orgs)");
        if (hasMedicalMetrics)
        {
            var patientFilter = broadAggregate ? """
                EXISTS (SELECT 1 FROM project.medical_cases mc WHERE mc.patient_id = p.id AND mc.organization_id = ANY(@orgs))
                OR EXISTS (SELECT 1 FROM project.patient_attachments pa WHERE pa.patient_id = p.id
                    AND pa.polyclinic_id = ANY(@orgs) AND tstzrange(pa.started_at,pa.ended_at,'[)') @> CURRENT_TIMESTAMP)
                """ : PatientAccessSql;
            Add("patients", $"SELECT count(*)::bigint AS count FROM project.patients p WHERE {patientFilter}");
            Add("activeDoctors", """
                SELECT count(*)::bigint AS count FROM project.doctors doctor JOIN project.employees employee ON employee.id = doctor.employee_id
                WHERE employee.is_active AND EXISTS (SELECT 1 FROM project.employments e WHERE e.employee_id = doctor.employee_id
                    AND e.organization_id = ANY(@orgs) AND daterange(e.started_on,e.ended_on,'[)') @> CURRENT_DATE)
                """);
            Add("activeHospitalizations", $"""
                SELECT count(*)::bigint AS count FROM project.hospitalizations h JOIN project.medical_cases c ON c.id = h.case_id
                WHERE h.status = 'active' AND ({caseFilter})
                """);
            Add("capacity", """
                SELECT coalesce(sum(total_beds),0)::bigint AS beds,coalesce(sum(occupied_beds),0)::bigint AS occupied,
                    coalesce(round(100.0 * sum(occupied_beds) / nullif(sum(total_beds),0),2),0) AS percent
                FROM project.vw_hospital_capacity
                WHERE hospital_id = ANY(@orgs) AND (@department = 0 OR department_id = @department)
                """);
            Add("monthly", MonthlyActivitySql(caseFilter));
            Add("departments", """
                SELECT department_name AS name,total_beds AS "totalBeds",occupied_beds AS "occupiedBeds"
                FROM project.vw_hospital_capacity
                WHERE hospital_id = ANY(@orgs) AND (@department = 0 OR department_id = @department)
                ORDER BY occupancy_percent DESC NULLS LAST LIMIT 8
                """);
        }
        parameters["user"] = access.UserId;
        parameters["technical"] = access.HasRole("system_admin");
        Add("recentEvents", """
            SELECT id,action,entity_type AS "entityType",occurred_at AS "occurredAt" FROM project.audit_logs
            WHERE actor_user_id = @user OR (@technical AND entity_type IN ('session','user','role'))
            ORDER BY occurred_at DESC,id DESC LIMIT 8
            """);
        var batch = await BatchRowsAsync(statements.Select(x => x.Sql).ToArray(), parameters, cancellationToken);
        var results = statements.Select((statement, index) => (statement.Name, Rows: batch[index]))
            .ToDictionary(x => x.Name, x => x.Rows);
        var organizations = (long)results["organizations"][0]["count"]!;
        long? patients = null;
        long? activeDoctors = null;
        long? activeHospitalizations = null;
        long? beds = null;
        long? occupiedBeds = null;
        decimal? occupancyPercent = null;
        List<Dictionary<string, object?>> monthlyActivity = [];
        List<Dictionary<string, object?>> departmentOccupancy = [];
        if (hasMedicalMetrics)
        {
            patients = (long)results["patients"][0]["count"]!;
            activeDoctors = (long)results["activeDoctors"][0]["count"]!;
            activeHospitalizations = (long)results["activeHospitalizations"][0]["count"]!;
            var capacity = results["capacity"][0];
            beds = (long)capacity["beds"]!;
            occupiedBeds = (long)capacity["occupied"]!;
            occupancyPercent = (decimal)capacity["percent"]!;
            monthlyActivity = results["monthly"];
            departmentOccupancy = results["departments"];
        }
        var recentEvents = results["recentEvents"];
        return new { organizations, activeDoctors, patients, activeHospitalizations, beds, occupiedBeds,
            occupancyPercent, monthlyActivity, departmentOccupancy, recentEvents };
    }

    private static string MonthlyActivitySql(string caseFilter) => $"""
        WITH months AS (SELECT generate_series(date_trunc('month',CURRENT_TIMESTAMP) - interval '5 months',
            date_trunc('month',CURRENT_TIMESTAMP),interval '1 month') AS month)
        SELECT to_char(m.month,'YYYY-MM') AS month,
            (SELECT count(*) FROM project.appointments a JOIN project.medical_cases c ON c.id = a.case_id
                WHERE a.status = 'completed' AND a.completed_at >= m.month AND a.completed_at < m.month + interval '1 month'
                    AND ({caseFilter})) AS visits,
            (SELECT count(*) FROM project.hospitalizations h JOIN project.medical_cases c ON c.id = h.case_id
                WHERE h.status <> 'cancelled' AND h.admitted_at >= m.month AND h.admitted_at < m.month + interval '1 month'
                    AND ({caseFilter})) AS hospitalizations
        FROM months m ORDER BY m.month
        """;

    private Task<List<Dictionary<string, object?>>> MonthlyActivityAsync(Dictionary<string, object?> parameters,
        string caseFilter, CancellationToken cancellationToken) =>
        RowsAsync(MonthlyActivitySql(caseFilter), parameters, cancellationToken);

    public async Task<object> ReportsAsync(UserAccess access, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadReports(access)) throw new ApplicationFault(403, "Нет доступа к аналитическим отчётам");
        var ids = await ReportOrganizationIdsAsync(access, cancellationToken);
        var parameters = AccessParameters(access);
        parameters["orgs"] = ids;
        parameters["department"] = AccessPolicies.DepartmentScope(access) ?? 0L;
        var statements = new[]
        {
            """
            SELECT hospital_name AS "hospitalName",department_name AS "departmentName",total_beds AS "totalBeds",
                occupied_beds AS "occupiedBeds",free_beds AS "freeBeds",occupancy_percent AS "occupancyPercent"
            FROM project.vw_hospital_capacity
            WHERE hospital_id = ANY(@orgs) AND (@department = 0 OR department_id = @department)
            ORDER BY hospital_name,department_name
            """,
            // Counts are recomputed within the selected institutions; the global doctor
            // statistics view must not expose another institution's clinical workload.
            """
            SELECT concat_ws(' ',e.last_name,e.first_name,e.middle_name) AS "fullName",
                coalesce((SELECT string_agg(s.name,', ' ORDER BY s.name) FROM project.doctor_specialties ds
                    JOIN project.specialties s ON s.id = ds.specialty_id WHERE ds.doctor_id = d.employee_id),'') AS specialties,
                (SELECT string_agg(DISTINCT o.name,', ' ORDER BY o.name) FROM project.employments em
                    JOIN project.medical_organizations o ON o.id = em.organization_id
                    WHERE em.employee_id = d.employee_id AND em.organization_id = ANY(@orgs)) AS workplaces,
                (SELECT count(*) FROM project.appointment_doctors ad JOIN project.appointments a ON a.id = ad.appointment_id
                    JOIN project.medical_cases c ON c.id = a.case_id WHERE ad.doctor_id = d.employee_id
                    AND a.status = 'completed' AND c.organization_id = ANY(@orgs)) AS "appointmentCount",
                (SELECT count(*) FROM project.surgery_participants sp JOIN project.surgeries s ON s.id = sp.surgery_id
                    JOIN project.medical_cases c ON c.id = s.case_id WHERE sp.doctor_id = d.employee_id
                    AND s.outcome IN ('survived','fatal') AND c.organization_id = ANY(@orgs)) AS "surgeryCount",
                (SELECT count(*) FROM project.surgery_participants sp JOIN project.surgeries s ON s.id = sp.surgery_id
                    JOIN project.medical_cases c ON c.id = s.case_id WHERE sp.doctor_id = d.employee_id
                    AND s.outcome = 'fatal' AND c.organization_id = ANY(@orgs)) AS "fatalSurgeryCount"
            FROM project.doctors d JOIN project.employees e ON e.id = d.employee_id
            WHERE EXISTS (SELECT 1 FROM project.employments em WHERE em.employee_id = d.employee_id AND em.organization_id = ANY(@orgs))
            ORDER BY e.last_name,e.first_name LIMIT 300
            """,
            MonthlyActivitySql("c.organization_id = ANY(@orgs)")
        };
        var batch = await BatchRowsAsync(statements, parameters, cancellationToken);
        return new { capacity = batch[0], monthlyActivity = batch[2], doctors = batch[1] };
    }
}
