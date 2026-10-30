using System.Data;
using Medcore.Application;
using Npgsql;
using NpgsqlTypes;

namespace Medcore.Infrastructure;

// Персонал: сотрудники, врачебный профиль, специальности, трудоустройство и консультации.
public sealed partial class MedcoreStore
{
    // ---------- Помощники ----------

    // Москва — фиксированный UTC+3; календарные проверки совпадают с timezone('Europe/Moscow') в БД.
    private static DateOnly MoscowToday() => DateOnly.FromDateTime(DateTime.UtcNow.AddHours(3));

    private static void ValidateBirthDate(DateOnly birthDate)
    {
        if (birthDate == default || birthDate < new DateOnly(1900, 1, 1) || birthDate > MoscowToday())
            throw new ApplicationFault(400, "Некорректная дата рождения");
    }

    private static string FullName(string lastName, string firstName, string? middleName) =>
        string.Join(' ', new[] { lastName, firstName, middleName }.Where(x => !string.IsNullOrWhiteSpace(x)));

    // system_admin видит всё; organization_admin — свои учреждения; больничные роли —
    // свою больницу; doctor и registrar — свои области.
    private static long[]? EmployeeListScope(UserAccess access) =>
        access.HasRole("system_admin") ? null
        : access.HasRole("organization_admin") ? access.OrganizationIdsFor("organization_admin")
        : AccessPolicies.IsHospitalReader(access) ? AccessPolicies.HospitalReadOrganizationIds(access)
        : access.OrganizationIds;

    private static bool CanReadEmployeeCard(UserAccess access) => AccessPolicies.CanReadEmployees(access);

    private async Task<bool> ManagesDoctorAsync(UserAccess access, long doctorId, CancellationToken cancellationToken)
    {
        if (access.HasRole("system_admin")) return true;
        if (!AccessPolicies.CanManageEmployees(access)) return false;
        var managed = AccessPolicies.ManagerOrganizationIds(access);
        var rows = await RowsAsync("""
            SELECT 1 AS found FROM project.employments
            WHERE employee_id = @id AND organization_id = ANY(@orgs) LIMIT 1
            """, new() { ["id"] = doctorId, ["orgs"] = managed }, cancellationToken);
        return rows.Count > 0;
    }

    private async Task<(long DegreeId, long TitleId)> ResolveQualificationAsync(long? degreeId, long? titleId,
        CancellationToken cancellationToken)
    {
        var defaults = await RowsAsync("""
            SELECT (SELECT id FROM project.academic_degrees WHERE code = 'none') AS "noneDegree",
                (SELECT id FROM project.academic_titles WHERE code = 'none') AS "noneTitle"
            """, new(), cancellationToken);
        var degree = degreeId ?? (long?)defaults[0]["noneDegree"];
        var title = titleId ?? (long?)defaults[0]["noneTitle"];
        if (degree is null || title is null)
            throw new ApplicationFault(500, "Справочники степеней и званий не заполнены");
        var degrees = await RowsAsync("SELECT 1 AS found FROM project.academic_degrees WHERE id = @id",
            new() { ["id"] = degree.Value }, cancellationToken);
        if (degrees.Count == 0) throw new ApplicationFault(400, "Научная степень не найдена");
        var titles = await RowsAsync("SELECT 1 AS found FROM project.academic_titles WHERE id = @id",
            new() { ["id"] = title.Value }, cancellationToken);
        if (titles.Count == 0) throw new ApplicationFault(400, "Научное звание не найдено");
        return (degree.Value, title.Value);
    }

    // ---------- Чтение ----------

    public async Task<PageResult<EmployeeRow>> EmployeesPageAsync(UserAccess access, string? search,
        long? specialtyId, long? organizationId, int page, int pageSize, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadEmployees(access))
            throw new ApplicationFault(403, "Нет доступа к сведениям о персонале");
        ValidatePage(page, pageSize, search);
        if (specialtyId is <= 0) throw new ApplicationFault(400, "Некорректная специальность");
        if (organizationId is <= 0) throw new ApplicationFault(400, "Некорректное учреждение");
        var scope = EmployeeListScope(access);
        if (organizationId is long requested && scope is not null && !scope.Contains(requested))
            throw new ApplicationFault(403, "Учреждение вне вашей области доступа");
        var parameters = new Dictionary<string, object?>
        {
            ["all"] = scope is null,
            ["orgs"] = scope ?? [],
            ["organization"] = organizationId ?? 0L,
            ["specialty"] = specialtyId ?? 0L,
            ["search"] = string.IsNullOrWhiteSpace(search) ? null : Pattern(search)
        };
        var total = (long)(await RowsAsync("""
            SELECT count(*)::bigint AS total FROM project.employees e
            WHERE (@all OR EXISTS (SELECT 1 FROM project.employments em
                    WHERE em.employee_id = e.id AND em.organization_id = ANY(@orgs)))
              AND (@organization = 0 OR EXISTS (SELECT 1 FROM project.employments em
                    WHERE em.employee_id = e.id AND em.organization_id = @organization))
              AND (@specialty = 0 OR EXISTS (SELECT 1 FROM project.doctor_specialties ds
                    WHERE ds.doctor_id = e.id AND ds.specialty_id = @specialty))
              AND (@search IS NULL OR concat_ws(' ', e.last_name, e.first_name, e.middle_name) ILIKE @search)
            """, parameters, cancellationToken))[0]["total"]!;
        parameters["limit"] = pageSize;
        parameters["offset"] = (page - 1) * pageSize;
        var rows = await RowsAsync("""
            SELECT e.id, concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS "fullName",
                ec.name AS category,
                (SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM project.doctor_specialties ds
                    JOIN project.specialties s ON s.id = ds.specialty_id
                    WHERE ds.doctor_id = e.id AND ds.certified_on <= CURRENT_DATE
                      AND (ds.valid_until IS NULL OR ds.valid_until >= CURRENT_DATE)) AS specialties,
                (SELECT string_agg(DISTINCT o.name, ', ' ORDER BY o.name) FROM project.employments em
                    JOIN project.medical_organizations o ON o.id = em.organization_id
                    WHERE em.employee_id = e.id AND (@all OR em.organization_id = ANY(@orgs))) AS "organizationName",
                e.is_active AS "isActive"
            FROM project.employees e JOIN project.employee_categories ec ON ec.id = e.category_id
            WHERE (@all OR EXISTS (SELECT 1 FROM project.employments em
                    WHERE em.employee_id = e.id AND em.organization_id = ANY(@orgs)))
              AND (@organization = 0 OR EXISTS (SELECT 1 FROM project.employments em
                    WHERE em.employee_id = e.id AND em.organization_id = @organization))
              AND (@specialty = 0 OR EXISTS (SELECT 1 FROM project.doctor_specialties ds
                    WHERE ds.doctor_id = e.id AND ds.specialty_id = @specialty))
              AND (@search IS NULL OR concat_ws(' ', e.last_name, e.first_name, e.middle_name) ILIKE @search)
            ORDER BY e.last_name, e.first_name, e.id
            LIMIT @limit OFFSET @offset
            """, parameters, cancellationToken);
        var items = rows.Select(row => new EmployeeRow((long)row["id"]!,
            (string)row["fullName"]!, (string)row["category"]!, (string?)row["specialties"],
            (string?)row["organizationName"], (bool)row["isActive"]!)).ToArray();
        return new(items, (int)total, page, pageSize);
    }

    public async Task<EmployeeCard> EmployeeAsync(UserAccess access, long id, CancellationToken cancellationToken)
    {
        if (!CanReadEmployeeCard(access))
            throw new ApplicationFault(403, "Карточка сотрудника доступна администратору организации и врачу");
        var header = await RowsAsync("""
            SELECT e.id, e.last_name AS "lastName", e.first_name AS "firstName", e.middle_name AS "middleName",
                e.birth_date AS "birthDate", e.phone, ec.name AS category, e.is_active AS "isActive",
                (SELECT o.name FROM project.employments em
                    JOIN project.medical_organizations o ON o.id = em.organization_id
                    WHERE em.employee_id = e.id AND daterange(em.started_on, em.ended_on, '[)') @> CURRENT_DATE
                    ORDER BY em.started_on DESC, em.id DESC LIMIT 1) AS "organizationName"
            FROM project.employees e JOIN project.employee_categories ec ON ec.id = e.category_id
            WHERE e.id = @id
            """, new() { ["id"] = id }, cancellationToken);
        if (header.Count == 0) throw new ApplicationFault(404, "Сотрудник не найден");
        var scope = access.HasRole("system_admin") ? null
            : access.HasRole("organization_admin") ? access.OrganizationIdsFor("organization_admin")
            : AccessPolicies.IsHospitalReader(access) ? AccessPolicies.HospitalReadOrganizationIds(access)
            : access.OrganizationIdsFor("doctor");
        if (scope is not null)
        {
            var visible = await RowsAsync("""
                SELECT 1 AS found FROM project.employments
                WHERE employee_id = @id AND organization_id = ANY(@orgs) LIMIT 1
                """, new() { ["id"] = id, ["orgs"] = scope }, cancellationToken);
            if (visible.Count == 0) throw new ApplicationFault(404, "Сотрудник не найден в доступной области");
        }
        var row = header[0];
        var doctorRows = await RowsAsync("""
            SELECT d.academic_degree_id AS "degreeId", d.academic_title_id AS "titleId",
                deg.name AS degree, t.name AS title,
                (SELECT min(em.started_on) FROM project.employments em WHERE em.employee_id = d.employee_id) AS "hiredAt"
            FROM project.doctors d
            JOIN project.academic_degrees deg ON deg.id = d.academic_degree_id
            JOIN project.academic_titles t ON t.id = d.academic_title_id
            WHERE d.employee_id = @id
            """, new() { ["id"] = id }, cancellationToken);
        DoctorProfile? doctor = null;
        if (doctorRows.Count > 0)
        {
            var specialtyRows = await RowsAsync("""
                SELECT s.id, s.name FROM project.doctor_specialties ds
                JOIN project.specialties s ON s.id = ds.specialty_id
                WHERE ds.doctor_id = @id ORDER BY s.name
                """, new() { ["id"] = id }, cancellationToken);
            var doctorRow = doctorRows[0];
            doctor = new DoctorProfile(
                specialtyRows.Select(ToDictionaryItem).ToArray(),
                (string?)doctorRow["degree"], (string?)doctorRow["title"],
                doctorRow["hiredAt"] is DateOnly hiredAt ? hiredAt : null);
        }
        var employments = await RowsAsync("""
            SELECT em.id, o.name AS "organizationName", o.organization_type AS "organizationType",
                em.started_on AS "startedAt", em.ended_on AS "endedAt"
            FROM project.employments em JOIN project.medical_organizations o ON o.id = em.organization_id
            WHERE em.employee_id = @id ORDER BY em.started_on DESC, em.id DESC
            """, new() { ["id"] = id }, cancellationToken);
        var consultations = await RowsAsync("""
            SELECT ca.id, o.name AS "organizationName", o.organization_type AS "organizationType",
                ca.started_on AS "startedAt", ca.ended_on AS "endedAt"
            FROM project.consultation_assignments ca
            JOIN project.medical_organizations o ON o.id = ca.organization_id
            WHERE ca.doctor_id = @id ORDER BY ca.started_on DESC, ca.id DESC
            """, new() { ["id"] = id }, cancellationToken);
        return new(
            new EmployeeCardRow((long)row["id"]!, (string)row["lastName"]!, (string)row["firstName"]!,
                (string?)row["middleName"], (DateOnly)row["birthDate"]!, (string)row["category"]!,
                (bool)row["isActive"]!, (string?)row["organizationName"], (string?)row["phone"]),
            doctor, employments.Select(ToEmploymentRow).ToArray(), consultations.Select(ToEmploymentRow).ToArray());
    }

    private static EmploymentRow ToEmploymentRow(Dictionary<string, object?> row) => new((long)row["id"]!,
        (string)row["organizationName"]!, (string)row["organizationType"]!,
        (DateOnly)row["startedAt"]!,
        row["endedAt"] is DateOnly endedAt ? endedAt : null);

    // ---------- Создание и изменение сотрудника ----------

    public async Task<long> CreateEmployeeAsync(UserAccess access, CreateEmployeeRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!access.HasRole("system_admin")
            && !(AccessPolicies.CanManageEmployees(access)
                 && AccessPolicies.ManagerOrganizationIds(access).Contains(request.OrganizationId)))
            throw new ApplicationFault(403, "Создание сотрудника разрешено администратору учреждения, главному врачу и заместителю в своей области");
        var organizations = await RowsAsync("SELECT 1 AS found FROM project.medical_organizations WHERE id = @id",
            new() { ["id"] = request.OrganizationId }, cancellationToken);
        if (organizations.Count == 0) throw new ApplicationFault(400, "Учреждение не найдено");
        var categories = await RowsAsync("SELECT code, name FROM project.employee_categories WHERE id = @id",
            new() { ["id"] = request.CategoryId }, cancellationToken);
        if (categories.Count == 0) throw new ApplicationFault(400, "Категория сотрудника не найдена");
        var categoryCode = (string)categories[0]["code"]!;
        var categoryName = (string)categories[0]["name"]!;
        ValidateBirthDate(request.BirthDate);
        if (request.HiredAt < request.BirthDate)
            throw new ApplicationFault(400, "Дата приёма не может быть раньше даты рождения");
        var specialtyIds = (request.SpecialtyIds ?? []).Distinct().ToArray();
        if (specialtyIds.Any(specialty => specialty <= 0))
            throw new ApplicationFault(400, "Некорректная специальность");
        if (specialtyIds.Length > 0)
        {
            var found = await RowsAsync("SELECT id FROM project.specialties WHERE id = ANY(@ids)",
                new() { ["ids"] = specialtyIds }, cancellationToken);
            if (found.Count != specialtyIds.Length)
                throw new ApplicationFault(400, "Одна из выбранных специальностей не найдена");
        }
        var wantsDoctor = specialtyIds.Length > 0 || request.DegreeId.HasValue || request.TitleId.HasValue
            || categoryCode == "doctor";
        if (wantsDoctor && categoryCode != "doctor")
            throw new ApplicationFault(409, "Врачебный профиль требует категории «Врач»");
        long degreeId = 0, titleId = 0;
        if (wantsDoctor)
        {
            var qualification = await ResolveQualificationAsync(request.DegreeId, request.TitleId, cancellationToken);
            degreeId = qualification.DegreeId;
            titleId = qualification.TitleId;
        }
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            long employeeId;
            await using (var command = new NpgsqlCommand("""
                INSERT INTO project.employees(category_id, last_name, first_name, middle_name, birth_date, phone)
                VALUES (@category, @last, @first, @middle, @birth, @phone) RETURNING id
                """, connection, transaction))
            {
                AddParameters(command, new()
                {
                    ["category"] = request.CategoryId, ["last"] = request.LastName.Trim(),
                    ["first"] = request.FirstName.Trim(), ["middle"] = Trimmed(request.MiddleName),
                    ["birth"] = request.BirthDate, ["phone"] = Trimmed(request.Phone)
                });
                employeeId = Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
            }
            if (wantsDoctor)
            {
                await using var doctor = new NpgsqlCommand("""
                    INSERT INTO project.doctors(employee_id, academic_degree_id, academic_title_id)
                    VALUES (@id, @degree, @title)
                    """, connection, transaction);
                AddParameters(doctor, new() { ["id"] = employeeId, ["degree"] = degreeId, ["title"] = titleId });
                await doctor.ExecuteNonQueryAsync(cancellationToken);
                foreach (var specialtyId in specialtyIds)
                {
                    await using var link = new NpgsqlCommand("""
                        INSERT INTO project.doctor_specialties(doctor_id, specialty_id, certified_on)
                        VALUES (@id, @specialty, @certified)
                        """, connection, transaction);
                    AddParameters(link, new()
                    {
                        ["id"] = employeeId, ["specialty"] = specialtyId, ["certified"] = request.HiredAt
                    });
                    await link.ExecuteNonQueryAsync(cancellationToken);
                }
            }
            var position = Trimmed(request.PositionName) ?? categoryName;
            long employmentId;
            await using (var employment = new NpgsqlCommand("""
                INSERT INTO project.employments(employee_id, organization_id, position_name, started_on, workload_fraction)
                VALUES (@id, @organization, @position, @started, 1.00) RETURNING id
                """, connection, transaction))
            {
                AddParameters(employment, new()
                {
                    ["id"] = employeeId, ["organization"] = request.OrganizationId,
                    ["position"] = position, ["started"] = request.HiredAt
                });
                employmentId = Convert.ToInt64(await employment.ExecuteScalarAsync(cancellationToken));
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "insert", "employee", employeeId, requestId,
                ["last_name", "first_name", "middle_name", "birth_date", "phone", "category_id",
                    "organization_id", "hired_at", "specialties", "degree_id", "title_id"], cancellationToken);
            await AuditWriteAsync(connection, transaction, access.UserId, "insert", "employment", employmentId, requestId,
                ["employee_id", "organization_id", "started_on"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return employeeId;
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }

    public async Task UpdateEmployeeAsync(UserAccess access, long id, UpdateEmployeeRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        var employees = await RowsAsync("""
            SELECT e.id, e.last_name AS "lastName", e.first_name AS "firstName", e.middle_name AS "middleName",
                e.birth_date AS "birthDate", e.phone, ec.code AS "categoryCode", ec.name AS "categoryName",
                e.category_id AS "categoryId", e.is_active AS "isActive"
            FROM project.employees e JOIN project.employee_categories ec ON ec.id = e.category_id
            WHERE e.id = @id
            """, new() { ["id"] = id }, cancellationToken);
        if (employees.Count == 0) throw new ApplicationFault(404, "Сотрудник не найден");
        if (!access.HasRole("system_admin"))
        {
            if (!AccessPolicies.CanManageEmployees(access))
                throw new ApplicationFault(403, "Изменение сотрудника разрешено администратору учреждения, главному врачу и заместителю");
            var visible = await RowsAsync("""
                SELECT 1 AS found FROM project.employments
                WHERE employee_id = @id AND organization_id = ANY(@orgs) LIMIT 1
                """, new() { ["id"] = id, ["orgs"] = AccessPolicies.ManagerOrganizationIds(access) },
                cancellationToken);
            if (visible.Count == 0) throw new ApplicationFault(403, "Сотрудник вне вашей области доступа");
        }
        var current = employees[0];
        var categories = await RowsAsync("SELECT code, name FROM project.employee_categories WHERE id = @id",
            new() { ["id"] = request.CategoryId }, cancellationToken);
        if (categories.Count == 0) throw new ApplicationFault(400, "Категория сотрудника не найдена");
        var categoryCode = (string)categories[0]["code"]!;
        ValidateBirthDate(request.BirthDate);
        var doctorRows = await RowsAsync("""
            SELECT academic_degree_id AS "degreeId", academic_title_id AS "titleId"
            FROM project.doctors WHERE employee_id = @id
            """, new() { ["id"] = id }, cancellationToken);
        var hasDoctor = doctorRows.Count > 0;
        if (hasDoctor && categoryCode != "doctor")
            throw new ApplicationFault(409,
                "У сотрудника есть врачебный профиль: снимите специальности и трудоустройства перед сменой категории");
        var wantsDoctor = hasDoctor || categoryCode == "doctor" || request.DegreeId.HasValue || request.TitleId.HasValue;
        if (!hasDoctor && wantsDoctor && categoryCode != "doctor")
            throw new ApplicationFault(409, "Врачебный профиль требует категории «Врач»");
        long degreeId = 0, titleId = 0;
        if (wantsDoctor)
        {
            var currentDegree = doctorRows.Count > 0 && doctorRows[0]["degreeId"] is long value ? value : (long?)null;
            var currentTitle = doctorRows.Count > 0 && doctorRows[0]["titleId"] is long value2 ? value2 : (long?)null;
            (degreeId, titleId) = await ResolveQualificationAsync(request.DegreeId ?? currentDegree,
                request.TitleId ?? currentTitle, cancellationToken);
        }
        var changed = new List<string>();
        if ((string)current["lastName"]! != request.LastName.Trim()) changed.Add("last_name");
        if ((string)current["firstName"]! != request.FirstName.Trim()) changed.Add("first_name");
        if ((string?)current["middleName"] != Trimmed(request.MiddleName)) changed.Add("middle_name");
        if ((DateOnly)current["birthDate"]! != request.BirthDate) changed.Add("birth_date");
        if ((string?)current["phone"] != Trimmed(request.Phone)) changed.Add("phone");
        if ((long)current["categoryId"]! != request.CategoryId) changed.Add("category_id");
        if (request.IsActive is bool active && active != (bool)current["isActive"]!) changed.Add("is_active");
        if (hasDoctor) { changed.Add("degree_id"); changed.Add("title_id"); }
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            await using (var command = new NpgsqlCommand("""
                UPDATE project.employees
                SET last_name = @last, first_name = @first, middle_name = @middle, birth_date = @birth,
                    phone = @phone, category_id = @category, is_active = coalesce(@active, is_active)
                WHERE id = @id
                """, connection, transaction))
            {
                AddParameters(command, new()
                {
                    ["last"] = request.LastName.Trim(), ["first"] = request.FirstName.Trim(),
                    ["middle"] = Trimmed(request.MiddleName), ["birth"] = request.BirthDate,
                    ["phone"] = Trimmed(request.Phone), ["category"] = request.CategoryId, ["id"] = id
                });
                AddOptional(command, "active", NpgsqlDbType.Boolean, request.IsActive);
                if (await command.ExecuteNonQueryAsync(cancellationToken) == 0)
                    throw new ApplicationFault(404, "Сотрудник не найден");
            }
            if (wantsDoctor)
            {
                await using var doctor = new NpgsqlCommand(hasDoctor ? """
                    UPDATE project.doctors SET academic_degree_id = @degree, academic_title_id = @title
                    WHERE employee_id = @id
                    """ : """
                    INSERT INTO project.doctors(employee_id, academic_degree_id, academic_title_id)
                    VALUES (@id, @degree, @title)
                    """, connection, transaction);
                AddParameters(doctor, new() { ["id"] = id, ["degree"] = degreeId, ["title"] = titleId });
                await doctor.ExecuteNonQueryAsync(cancellationToken);
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "update", "employee", id, requestId,
                changed.Count == 0 ? null : changed.Distinct().ToArray(), cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }

    // ---------- Врачебный профиль ----------

    public async Task AddDoctorSpecialtyAsync(UserAccess access, long doctorId, AddDoctorSpecialtyRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        var doctors = await RowsAsync("SELECT 1 AS found FROM project.doctors WHERE employee_id = @id",
            new() { ["id"] = doctorId }, cancellationToken);
        if (doctors.Count == 0) throw new ApplicationFault(404, "Врачебный профиль не найден");
        if (!await ManagesDoctorAsync(access, doctorId, cancellationToken))
            throw new ApplicationFault(403, "Сотрудник вне вашей области доступа");
        var specialties = await RowsAsync("SELECT 1 AS found FROM project.specialties WHERE id = @id",
            new() { ["id"] = request.SpecialtyId }, cancellationToken);
        if (specialties.Count == 0) throw new ApplicationFault(400, "Специальность не найдена");
        var certifiedOn = request.CertifiedOn ?? MoscowToday();
        if (request.ValidUntil is DateOnly validUntil && validUntil < certifiedOn)
            throw new ApplicationFault(400, "Дата окончания раньше даты сертификации");
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            await EnsureStructureNumberFreeAsync(connection, transaction,
                "SELECT 1 FROM project.doctor_specialties WHERE doctor_id = @id AND specialty_id = @specialty",
                new() { ["id"] = doctorId, ["specialty"] = request.SpecialtyId },
                "Специальность уже назначена врачу", cancellationToken);
            await using (var command = new NpgsqlCommand("""
                INSERT INTO project.doctor_specialties(doctor_id, specialty_id, certified_on, valid_until)
                VALUES (@id, @specialty, @certified, @valid)
                """, connection, transaction))
            {
                AddParameters(command, new()
                {
                    ["id"] = doctorId, ["specialty"] = request.SpecialtyId, ["certified"] = certifiedOn
                });
                AddOptional(command, "valid", NpgsqlDbType.Date, request.ValidUntil);
                await command.ExecuteNonQueryAsync(cancellationToken);
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "insert", "doctor_specialty", doctorId,
                requestId, ["specialty_id", "certified_on", "valid_until"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }

    public async Task RemoveDoctorSpecialtyAsync(UserAccess access, long doctorId, long specialtyId, string requestId,
        CancellationToken cancellationToken)
    {
        var doctors = await RowsAsync("SELECT 1 AS found FROM project.doctors WHERE employee_id = @id",
            new() { ["id"] = doctorId }, cancellationToken);
        if (doctors.Count == 0) throw new ApplicationFault(404, "Врачебный профиль не найден");
        if (!await ManagesDoctorAsync(access, doctorId, cancellationToken))
            throw new ApplicationFault(403, "Сотрудник вне вашей области доступа");
        var links = await RowsAsync("""
            SELECT 1 AS found FROM project.doctor_specialties
            WHERE doctor_id = @id AND specialty_id = @specialty
            """, new() { ["id"] = doctorId, ["specialty"] = specialtyId }, cancellationToken);
        if (links.Count == 0) throw new ApplicationFault(404, "У врача нет такой специальности");
        var used = await RowsAsync("""
            SELECT 1 AS found FROM project.surgery_participants
            WHERE doctor_id = @id AND specialty_id = @specialty LIMIT 1
            """, new() { ["id"] = doctorId, ["specialty"] = specialtyId }, cancellationToken);
        if (used.Count > 0)
            throw new ApplicationFault(409, "Специальность использована в операциях: удаление запрещено историей");
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            await using (var command = new NpgsqlCommand("""
                DELETE FROM project.doctor_specialties WHERE doctor_id = @id AND specialty_id = @specialty
                """, connection, transaction))
            {
                AddParameters(command, new() { ["id"] = doctorId, ["specialty"] = specialtyId });
                if (await command.ExecuteNonQueryAsync(cancellationToken) == 0)
                    throw new ApplicationFault(404, "У врача нет такой специальности");
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "delete", "doctor_specialty", doctorId,
                requestId, ["specialty_id"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }

    // ---------- Трудоустройство и консультации ----------

    private async Task<DateOnly> EmployeeBirthDateAsync(long employeeId, CancellationToken cancellationToken)
    {
        var rows = await RowsAsync("SELECT birth_date AS \"birthDate\" FROM project.employees WHERE id = @id",
            new() { ["id"] = employeeId }, cancellationToken);
        if (rows.Count == 0) throw new ApplicationFault(404, "Сотрудник не найден");
        return (DateOnly)rows[0]["birthDate"]!;
    }

    private static void ValidateInterval(DateOnly startedOn, DateOnly? endedOn, DateOnly birthDate)
    {
        if (startedOn < birthDate) throw new ApplicationFault(400, "Начало периода раньше даты рождения");
        if (endedOn is DateOnly ended && ended <= startedOn)
            throw new ApplicationFault(400, "Дата окончания должна быть позже даты начала");
    }

    public async Task<long> AddEmploymentAsync(UserAccess access, long doctorId, CreateEmploymentRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        var doctors = await RowsAsync("SELECT 1 AS found FROM project.doctors WHERE employee_id = @id",
            new() { ["id"] = doctorId }, cancellationToken);
        if (doctors.Count == 0) throw new ApplicationFault(404, "Врачебный профиль не найден");
        if (!access.HasRole("system_admin")
            && !(AccessPolicies.CanManageEmployees(access)
                 && AccessPolicies.ManagerOrganizationIds(access).Contains(request.OrganizationId)))
            throw new ApplicationFault(403, "Трудоустройство можно оформить только в своём учреждении");
        var organizations = await RowsAsync("SELECT 1 AS found FROM project.medical_organizations WHERE id = @id",
            new() { ["id"] = request.OrganizationId }, cancellationToken);
        if (organizations.Count == 0) throw new ApplicationFault(400, "Учреждение не найдено");
        var birthDate = await EmployeeBirthDateAsync(doctorId, cancellationToken);
        ValidateInterval(request.StartedOn, request.EndedOn, birthDate);
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            long id;
            await using (var command = new NpgsqlCommand("""
                INSERT INTO project.employments(employee_id, organization_id, position_name, started_on, ended_on,
                    workload_fraction)
                VALUES (@id, @organization, @position, @started, @ended, @workload) RETURNING id
                """, connection, transaction))
            {
                AddParameters(command, new()
                {
                    ["id"] = doctorId, ["organization"] = request.OrganizationId,
                    ["position"] = Trimmed(request.PositionName) ?? "Врач", ["started"] = request.StartedOn
                });
                AddOptional(command, "ended", NpgsqlDbType.Date, request.EndedOn);
                AddOptional(command, "workload", NpgsqlDbType.Numeric, request.WorkloadFraction);
                id = Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "insert", "employment", id, requestId,
                ["employee_id", "organization_id", "started_on", "ended_on"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error) when (error.SqlState == "23P01")
        {
            throw new ApplicationFault(409,
                "Период пересекается с уже сохранённым трудоустройством этого врача в данной организации");
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }

    public async Task<long> AddConsultationAsync(UserAccess access, long doctorId, CreateConsultationRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        var doctors = await RowsAsync("""
            SELECT t.code AS "titleCode" FROM project.doctors d
            JOIN project.academic_titles t ON t.id = d.academic_title_id
            WHERE d.employee_id = @id
            """, new() { ["id"] = doctorId }, cancellationToken);
        if (doctors.Count == 0) throw new ApplicationFault(404, "Врачебный профиль не найден");
        if ((string)doctors[0]["titleCode"]! is not ("docent" or "professor"))
            throw new ApplicationFault(409, "Консультативное назначение требует звания доцента или профессора");
        if (!access.HasRole("system_admin")
            && !(AccessPolicies.CanManageEmployees(access)
                 && AccessPolicies.ManagerOrganizationIds(access).Contains(request.OrganizationId)))
            throw new ApplicationFault(403, "Консультацию можно оформить только в своём учреждении");
        var organizations = await RowsAsync("SELECT 1 AS found FROM project.medical_organizations WHERE id = @id",
            new() { ["id"] = request.OrganizationId }, cancellationToken);
        if (organizations.Count == 0) throw new ApplicationFault(400, "Учреждение не найдено");
        var birthDate = await EmployeeBirthDateAsync(doctorId, cancellationToken);
        ValidateInterval(request.StartedOn, request.EndedOn, birthDate);
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            long id;
            await using (var command = new NpgsqlCommand("""
                INSERT INTO project.consultation_assignments(doctor_id, organization_id, started_on, ended_on)
                VALUES (@id, @organization, @started, @ended) RETURNING id
                """, connection, transaction))
            {
                AddParameters(command, new()
                {
                    ["id"] = doctorId, ["organization"] = request.OrganizationId, ["started"] = request.StartedOn
                });
                AddOptional(command, "ended", NpgsqlDbType.Date, request.EndedOn);
                id = Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "insert", "consultation_assignment", id,
                requestId, ["doctor_id", "organization_id", "started_on", "ended_on"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error) when (error.SqlState == "23P01")
        {
            throw new ApplicationFault(409,
                "Период пересекается с уже сохранённым консультативным назначением этого врача");
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }
}
