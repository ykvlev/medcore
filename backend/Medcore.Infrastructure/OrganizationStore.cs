using System.Data;
using Medcore.Application;
using Npgsql;
using NpgsqlTypes;

namespace Medcore.Infrastructure;

// Организации, их структура и справочники. Схема не меняется: миграции 001–003.
public sealed partial class MedcoreStore
{
    // ---------- Общие помощники потоков «организации» и «персонал» ----------

    // AddParameters из MedcoreStore.cs поддерживает только необязательные значения
    // перечисленных типов, поэтому nullable-параметры привязываются явно.
    private static void AddOptional(NpgsqlCommand command, string name, NpgsqlDbType type, object? value) =>
        command.Parameters.AddWithValue(name, type, value ?? DBNull.Value);

    // Понятное сообщение вместо общего 409 там, где причина бизнес-правила известна:
    // проверяющие функции миграции 002 поднимают 23514 с русским текстом причины.
    private static ApplicationFault? BusinessRuleFault(PostgresException error)
    {
        if (error.SqlState == "23514" && error.MessageText is { Length: > 0 } text
            && text.Any(character => character is >= 'А' and <= 'я'))
            return new ApplicationFault(409, text);
        return null;
    }

    private static async Task AuditWriteAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        long actorUserId, string action, string entityType, long entityId, string requestId,
        string[]? changedFields, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            INSERT INTO project.audit_logs(actor_user_id, action, entity_type, entity_id,
                changed_fields, request_id, outcome)
            VALUES (@actor, @action, @entity, @id, @fields, @request, 'success')
            """, connection, transaction);
        AddParameters(command, new()
        {
            ["actor"] = actorUserId, ["action"] = action, ["entity"] = entityType,
            ["id"] = entityId, ["request"] = requestId
        });
        AddOptional(command, "fields", NpgsqlDbType.Array | NpgsqlDbType.Text, changedFields);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static void ValidatePage(int page, int pageSize, string? search)
    {
        if (page < 1 || pageSize is < 1 or > 100 || search?.Trim().Length > 100
            || (long)(page - 1) * pageSize > int.MaxValue)
            throw new ApplicationFault(400, "Некорректные параметры поиска или страницы");
    }

    private static string? Trimmed(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string Pattern(string? search) => $"%{search!.Trim()}%";

    // ---------- Политики доступа ----------

    // system_admin и сводные роли видят всё; organization_admin — свои учреждения;
    // больничные роли — только свою больницу; остальные авторизованные роли читают
    // справочник целиком, как и раньше.
    private static long[]? OrganizationListScope(UserAccess access) =>
        access.HasRole("system_admin") || AccessPolicies.CanReadAllOrganizations(access) ? null
        : access.HasRole("organization_admin") ? access.OrganizationIdsFor("organization_admin")
        : AccessPolicies.IsHospitalReader(access) ? AccessPolicies.HospitalReadOrganizationIds(access)
        : null;

    private static bool CanReadOrganization(UserAccess access, long organizationId) =>
        access.HasRole("system_admin")
        || AccessPolicies.CanReadAllOrganizations(access)
        || (access.HasRole("organization_admin") && access.OrganizationIdsFor("organization_admin").Contains(organizationId))
        || (AccessPolicies.IsHospitalReader(access)
            && AccessPolicies.HospitalReadOrganizationIds(access).Contains(organizationId))
        || (!access.HasRole("organization_admin") && !AccessPolicies.IsHospitalReader(access));

    // Структуру меняют администратор организации и главный врач; заместитель
    // главного врача структуру не меняет (контракт ролей).
    private static bool ManagesOrganization(UserAccess access, long organizationId) =>
        access.HasRole("system_admin")
        || (AccessPolicies.CanManageStructure(access)
            && AccessPolicies.ManagerOrganizationIds(access).Contains(organizationId));

    // ---------- Чтение ----------

    public async Task<PageResult<OrganizationRow>> OrganizationsPageAsync(UserAccess access, string? search,
        string? type, int page, int pageSize, CancellationToken cancellationToken)
    {
        ValidatePage(page, pageSize, search);
        if (type is not null && type is not ("hospital" or "polyclinic"))
            throw new ApplicationFault(400, "Тип учреждения: hospital или polyclinic");
        var scope = OrganizationListScope(access);
        var search2 = string.IsNullOrWhiteSpace(search) ? null : Pattern(search);
        var parameters = new Dictionary<string, object?>
        {
            ["all"] = scope is null,
            ["orgs"] = scope ?? [],
            ["type"] = type,
            ["search"] = search2
        };
        parameters["limit"] = pageSize;
        parameters["offset"] = (page - 1) * pageSize;
        // COUNT и страница независимы: один NpgsqlBatch вместо двух round-trip.
        var batch = await BatchRowsAsync([
            """
            SELECT count(*)::bigint AS total FROM project.medical_organizations o
            WHERE (@all OR o.id = ANY(@orgs))
              AND (@type IS NULL OR o.organization_type = @type)
              AND (@search IS NULL OR o.name ILIKE @search)
            """,
            """
            SELECT o.id, o.name, o.organization_type AS "organizationType", o.address, o.phone,
                o.is_active AS "isActive", p.hospital_id AS "parentHospitalId",
                hp.name AS "parentHospitalName"
            FROM project.medical_organizations o
            LEFT JOIN project.polyclinics p ON p.organization_id = o.id
            LEFT JOIN project.medical_organizations hp ON hp.id = p.hospital_id
            WHERE (@all OR o.id = ANY(@orgs))
              AND (@type IS NULL OR o.organization_type = @type)
              AND (@search IS NULL OR o.name ILIKE @search)
            ORDER BY o.name, o.id
            LIMIT @limit OFFSET @offset
            """
        ], parameters, cancellationToken);
        var total = (long)batch[0][0]["total"]!;
        return new(batch[1].Select(ToOrganizationRow).ToArray(), (int)total, page, pageSize);
    }

    private static OrganizationRow ToOrganizationRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (string)row["name"]!, (string)row["organizationType"]!, (string)row["address"]!,
        (string?)row["phone"], (bool)row["isActive"]!,
        row["parentHospitalId"] is long parent ? parent : null, (string?)row["parentHospitalName"]);

    public async Task<OrganizationCard> OrganizationCardAsync(UserAccess access, long id,
        CancellationToken cancellationToken)
    {
        var header = await RowsAsync("""
            SELECT o.id, o.name, o.organization_type AS "organizationType", o.address, o.phone,
                o.is_active AS "isActive", p.hospital_id AS "parentHospitalId",
                hp.name AS "parentHospitalName"
            FROM project.medical_organizations o
            LEFT JOIN project.polyclinics p ON p.organization_id = o.id
            LEFT JOIN project.medical_organizations hp ON hp.id = p.hospital_id
            WHERE o.id = @id
            """, new() { ["id"] = id }, cancellationToken);
        if (header.Count == 0) throw new ApplicationFault(404, "Учреждение не найдено");
        if (!CanReadOrganization(access, id)) throw new ApplicationFault(403, "Учреждение вне вашей области доступа");
        var rows = await RowsAsync("""
            SELECT b.id AS "buildingId", b.code AS "buildingNumber",
                d.id AS "departmentId", d.name AS "departmentName", ds.name AS "specialization",
                w.id AS "wardId", w.number AS "wardNumber", w.planned_capacity AS "plannedCapacity",
                bed.id AS "bedId", bed.number AS "bedNumber", bed.is_active AS "bedActive",
                EXISTS (SELECT 1 FROM project.bed_occupancies bo WHERE bo.bed_id = bed.id
                    AND tstzrange(bo.started_at, bo.ended_at, '[)') @> CURRENT_TIMESTAMP) AS occupied
            FROM project.buildings b
            LEFT JOIN project.departments d ON d.building_id = b.id
            LEFT JOIN project.department_specializations ds ON ds.id = d.specialization_id
            LEFT JOIN project.wards w ON w.department_id = d.id
            LEFT JOIN project.beds bed ON bed.ward_id = w.id
            WHERE b.hospital_id = @id
            ORDER BY b.code, b.id, d.name, d.id, w.number, w.id, bed.number, bed.id
            """, new() { ["id"] = id }, cancellationToken);
        var buildings = new List<BuildingRow>();
        // Плоская выборка иерархии разворачивается в дерево корпус → отделение → палата → койка.
        var buildingsById = new Dictionary<long, (string Number, List<DepartmentRow> Departments)>();
        var wardsById = new Dictionary<long, (string Number, int PlannedCapacity, List<BedRow> Beds)>();
        var departmentsById = new Dictionary<long, (string Name, string? Specialization, List<WardRow> Wards)>();
        var buildingOrder = new List<long>();
        var departmentOrder = new Dictionary<long, List<long>>();
        var wardOrder = new Dictionary<long, List<long>>();
        foreach (var row in rows)
        {
            var buildingId = (long)row["buildingId"]!;
            if (!buildingsById.ContainsKey(buildingId))
            {
                buildingsById[buildingId] = ((string)row["buildingNumber"]!, []);
                buildingOrder.Add(buildingId);
            }
            if (row["departmentId"] is not long departmentId) continue;
            if (!departmentsById.ContainsKey(departmentId))
            {
                departmentsById[departmentId] = ((string)row["departmentName"]!, (string?)row["specialization"], []);
                if (!departmentOrder.TryGetValue(buildingId, out var order))
                    departmentOrder[buildingId] = order = [];
                order.Add(departmentId);
            }
            if (row["wardId"] is not long wardId) continue;
            if (!wardsById.ContainsKey(wardId))
            {
                wardsById[wardId] = ((string)row["wardNumber"]!, (int)row["plannedCapacity"]!, []);
                if (!wardOrder.TryGetValue(departmentId, out var order))
                    wardOrder[departmentId] = order = [];
                order.Add(wardId);
            }
            if (row["bedId"] is not long bedId) continue;
            var ward = wardsById[wardId];
            var bed = new BedRow(bedId, (string)row["bedNumber"]!, (bool)row["bedActive"]!, (bool)row["occupied"]!);
            ward.Beds.Add(bed);
            wardsById[wardId] = ward;
        }
        foreach (var buildingId in buildingOrder)
        {
            var building = buildingsById[buildingId];
            foreach (var departmentId in departmentOrder.GetValueOrDefault(buildingId) ?? [])
            {
                var department = departmentsById[departmentId];
                long totalBeds = 0;
                long occupiedBeds = 0;
                var wards = new List<WardRow>();
                foreach (var wardId in wardOrder.GetValueOrDefault(departmentId) ?? [])
                {
                    var ward = wardsById[wardId];
                    totalBeds += ward.Beds.Count;
                    occupiedBeds += ward.Beds.Count(bed => bed.Occupied);
                    wards.Add(new WardRow(wardId, ward.Number, ward.PlannedCapacity, ward.Beds));
                }
                building.Departments.Add(new DepartmentRow(departmentId, department.Name,
                    department.Specialization, totalBeds, occupiedBeds, wards));
            }
            buildings.Add(new BuildingRow(buildingId, building.Number, building.Departments));
        }
        return new(ToOrganizationRow(header[0]), buildings);
    }

    public async Task<DictionariesResult> DictionariesAsync(CancellationToken cancellationToken)
    {
        // Восемь справочников не зависят друг от друга: один общий round-trip.
        var batch = await BatchRowsAsync([
            "SELECT id, name FROM project.department_specializations ORDER BY name",
            "SELECT id, name FROM project.specialties ORDER BY name",
            "SELECT id, name FROM project.employee_categories ORDER BY name",
            "SELECT id, name FROM project.academic_degrees ORDER BY degree_rank",
            "SELECT id, name FROM project.academic_titles ORDER BY minimum_degree_rank",
            "SELECT code, name FROM project.diagnoses WHERE is_active ORDER BY code",
            "SELECT id, name, profile_id AS \"profileId\" FROM project.lab_test_types ORDER BY name",
            "SELECT id, name FROM project.laboratories ORDER BY name"
        ], new(), cancellationToken);
        var specializations = batch[0];
        var specialties = batch[1];
        var categories = batch[2];
        var degrees = batch[3];
        var titles = batch[4];
        var diagnoses = batch[5];
        var testTypes = batch[6];
        var laboratories = batch[7];
        return new(
            specializations.Select(ToDictionaryItem).ToArray(),
            specialties.Select(ToDictionaryItem).ToArray(),
            categories.Select(ToDictionaryItem).ToArray(),
            degrees.Select(ToDictionaryItem).ToArray(),
            titles.Select(ToDictionaryItem).ToArray(),
            diagnoses.Select(row => new DiagnosisDictionaryItem((string)row["code"]!, (string)row["name"]!)).ToArray(),
            testTypes.Select(row => new LabTestTypeDictionaryItem((long)row["id"]!, (string)row["name"]!,
                (long)row["profileId"]!)).ToArray(),
            laboratories.Select(ToDictionaryItem).ToArray());
    }

    private static DictionaryItem ToDictionaryItem(Dictionary<string, object?> row) =>
        new((long)row["id"]!, (string)row["name"]!);

    // ---------- Учреждения ----------

    public async Task<OrganizationRow> CreateOrganizationAsync(UserAccess access, CreateOrganizationRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!access.HasRole("system_admin") && !access.HasRole("organization_admin"))
            throw new ApplicationFault(403, "Создание учреждения разрешено администратору организации");
        if (request.OrganizationType == "hospital" && request.ParentHospitalId is not null)
            throw new ApplicationFault(400, "Больница не может иметь родительскую больницу");
        string? parentName = null;
        if (request.ParentHospitalId is long parentId)
        {
            var parents = await RowsAsync("""
                SELECT o.name FROM project.hospitals h
                JOIN project.medical_organizations o ON o.id = h.organization_id
                WHERE h.organization_id = @id
                """, new() { ["id"] = parentId }, cancellationToken);
            if (parents.Count == 0) throw new ApplicationFault(400, "Родительская больница не найдена");
            parentName = (string)parents[0]["name"]!;
        }
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            long id;
            await using (var command = new NpgsqlCommand("""
                INSERT INTO project.medical_organizations(name, organization_type, address, phone, is_active)
                VALUES (@name, @type, @address, @phone, false) RETURNING id
                """, connection, transaction))
            {
                AddParameters(command, new()
                {
                    ["name"] = request.Name.Trim(), ["type"] = request.OrganizationType,
                    ["address"] = request.Address.Trim(), ["phone"] = Trimmed(request.Phone)
                });
                id = Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
            }
            if (request.OrganizationType == "hospital")
            {
                await using var subtype = new NpgsqlCommand(
                    "INSERT INTO project.hospitals(organization_id) VALUES (@id)", connection, transaction);
                AddParameters(subtype, new() { ["id"] = id });
                await subtype.ExecuteNonQueryAsync(cancellationToken);
            }
            else
            {
                await using var subtype = new NpgsqlCommand("""
                    INSERT INTO project.polyclinics(organization_id, hospital_id) VALUES (@id, @parent)
                    """, connection, transaction);
                AddParameters(subtype, new() { ["id"] = id });
                AddOptional(subtype, "parent", NpgsqlDbType.Bigint, request.ParentHospitalId);
                await subtype.ExecuteNonQueryAsync(cancellationToken);
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "insert", "organization", id, requestId,
                ["name", "organization_type", "address", "phone"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new OrganizationRow(id, request.Name.Trim(), request.OrganizationType, request.Address.Trim(),
                Trimmed(request.Phone), false, request.ParentHospitalId, parentName);
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }

    public async Task UpdateOrganizationAsync(UserAccess access, long id, UpdateOrganizationRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        var current = await RowsAsync("""
            SELECT name, address, phone, is_active AS "isActive"
            FROM project.medical_organizations WHERE id = @id
            """, new() { ["id"] = id }, cancellationToken);
        if (current.Count == 0) throw new ApplicationFault(404, "Учреждение не найдено");
        if (!ManagesOrganization(access, id)) throw new ApplicationFault(403, "Учреждение вне вашей области доступа");
        var row = current[0];
        var changed = new List<string>();
        if ((string)row["name"]! != request.Name.Trim()) changed.Add("name");
        if ((string)row["address"]! != request.Address.Trim()) changed.Add("address");
        if ((string?)row["phone"] != Trimmed(request.Phone)) changed.Add("phone");
        if ((bool)row["isActive"]! != request.IsActive) changed.Add("is_active");
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            await using (var command = new NpgsqlCommand("""
                UPDATE project.medical_organizations
                SET name = @name, address = @address, phone = @phone, is_active = @active
                WHERE id = @id
                """, connection, transaction))
            {
                AddParameters(command, new()
                {
                    ["name"] = request.Name.Trim(), ["address"] = request.Address.Trim(),
                    ["phone"] = Trimmed(request.Phone), ["active"] = request.IsActive, ["id"] = id
                });
                if (await command.ExecuteNonQueryAsync(cancellationToken) == 0)
                    throw new ApplicationFault(404, "Учреждение не найдено");
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "update", "organization", id, requestId,
                changed.Count == 0 ? null : changed.ToArray(), cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }

    // ---------- Структура ----------

    private async Task<Dictionary<string, object?>> ParentAsync(string sql, long id, string notFound,
        CancellationToken cancellationToken)
    {
        var rows = await RowsAsync(sql, new() { ["id"] = id }, cancellationToken);
        return rows.Count == 0 ? throw new ApplicationFault(404, notFound) : rows[0];
    }

    private static async Task EnsureStructureNumberFreeAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, string sql, Dictionary<string, object?> parameters, string title,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        AddParameters(command, parameters);
        if (await command.ExecuteScalarAsync(cancellationToken) is not null)
            throw new ApplicationFault(409, title);
    }

    public async Task<long> CreateBuildingAsync(UserAccess access, long hospitalId, CreateBuildingRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        var parent = await ParentAsync("""
            SELECT h.organization_id AS "organizationId", o.address
            FROM project.hospitals h JOIN project.medical_organizations o ON o.id = h.organization_id
            WHERE h.organization_id = @id
            """, hospitalId, "Больница не найдена", cancellationToken);
        var organizationId = (long)parent["organizationId"]!;
        if (!ManagesOrganization(access, organizationId))
            throw new ApplicationFault(403, "Больница вне вашей области доступа");
        var code = request.Number.Trim();
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            await EnsureStructureNumberFreeAsync(connection, transaction,
                "SELECT 1 FROM project.buildings WHERE hospital_id = @id AND code = @code",
                new() { ["id"] = hospitalId, ["code"] = code },
                "Корпус с таким номером уже есть в этой больнице", cancellationToken);
            long id;
            await using (var command = new NpgsqlCommand("""
                INSERT INTO project.buildings(hospital_id, code, address)
                VALUES (@hospital, @code, @address) RETURNING id
                """, connection, transaction))
            {
                AddParameters(command, new()
                {
                    ["hospital"] = hospitalId, ["code"] = code, ["address"] = (string)parent["address"]!
                });
                id = Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "insert", "building", id, requestId,
                ["hospital_id", "code"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }

    public async Task<long> CreateDepartmentAsync(UserAccess access, long buildingId, CreateDepartmentRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        var parent = await ParentAsync("""
            SELECT b.hospital_id AS "organizationId" FROM project.buildings b WHERE b.id = @id
            """, buildingId, "Корпус не найден", cancellationToken);
        var organizationId = (long)parent["organizationId"]!;
        if (!ManagesOrganization(access, organizationId))
            throw new ApplicationFault(403, "Корпус вне вашей области доступа");
        var specializations = await RowsAsync("SELECT 1 AS found FROM project.department_specializations WHERE id = @id",
            new() { ["id"] = request.SpecializationId }, cancellationToken);
        if (specializations.Count == 0) throw new ApplicationFault(400, "Специализация отделения не найдена");
        var name = request.Name.Trim();
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            await EnsureStructureNumberFreeAsync(connection, transaction,
                "SELECT 1 FROM project.departments WHERE building_id = @id AND name = @name",
                new() { ["id"] = buildingId, ["name"] = name },
                "Отделение с таким названием уже есть в этом корпусе", cancellationToken);
            long id;
            await using (var command = new NpgsqlCommand("""
                INSERT INTO project.departments(building_id, specialization_id, name)
                VALUES (@building, @specialization, @name) RETURNING id
                """, connection, transaction))
            {
                AddParameters(command, new()
                {
                    ["building"] = buildingId, ["specialization"] = request.SpecializationId, ["name"] = name
                });
                id = Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "insert", "department", id, requestId,
                ["building_id", "specialization_id", "name"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }

    public async Task<long> CreateWardAsync(UserAccess access, long departmentId, CreateWardRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        var departments = await RowsAsync("""
            SELECT d.id, b.hospital_id AS "organizationId"
            FROM project.departments d JOIN project.buildings b ON b.id = d.building_id
            WHERE d.id = @id
            """, new() { ["id"] = departmentId }, cancellationToken);
        if (departments.Count == 0) throw new ApplicationFault(404, "Отделение не найдено");
        var organizationId = (long)departments[0]["organizationId"]!;
        if (!ManagesOrganization(access, organizationId))
            throw new ApplicationFault(403, "Отделение вне вашей области доступа");
        var number = request.Number.Trim();
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            await EnsureStructureNumberFreeAsync(connection, transaction,
                "SELECT 1 FROM project.wards WHERE department_id = @id AND number = @number",
                new() { ["id"] = departmentId, ["number"] = number },
                "Палата с таким номером уже есть в этом отделении", cancellationToken);
            long id;
            await using (var command = new NpgsqlCommand("""
                INSERT INTO project.wards(department_id, number, planned_capacity)
                VALUES (@department, @number, @capacity) RETURNING id
                """, connection, transaction))
            {
                AddParameters(command, new()
                {
                    ["department"] = departmentId, ["number"] = number, ["capacity"] = request.PlannedCapacity
                });
                id = Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "insert", "ward", id, requestId,
                ["department_id", "number", "planned_capacity"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }

    public async Task<long> CreateBedAsync(UserAccess access, long wardId, CreateBedRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        var ward = await ParentAsync("""
            SELECT w.id, w.planned_capacity AS "plannedCapacity", w.is_active AS "wardActive",
                d.is_active AS "departmentActive", b.is_active AS "buildingActive",
                o.is_active AS "organizationActive", b.hospital_id AS "organizationId",
                (SELECT count(*) FROM project.beds bed WHERE bed.ward_id = w.id) AS "bedCount"
            FROM project.wards w
            JOIN project.departments d ON d.id = w.department_id
            JOIN project.buildings b ON b.id = d.building_id
            JOIN project.medical_organizations o ON o.id = b.hospital_id
            WHERE w.id = @id
            """, wardId, "Палата не найдена", cancellationToken);
        var organizationId = (long)ward["organizationId"]!;
        if (!ManagesOrganization(access, organizationId))
            throw new ApplicationFault(403, "Палата вне вашей области доступа");
        var planned = (int)ward["plannedCapacity"]!;
        var bedCount = (int)(long)ward["bedCount"]!;
        if (bedCount >= planned)
            throw new ApplicationFault(409, $"В палате уже {bedCount} коек при плановой вместимости {planned}");
        var activeStructure = (bool)ward["wardActive"]! && (bool)ward["departmentActive"]!
            && (bool)ward["buildingActive"]! && (bool)ward["organizationActive"]!;
        if (activeStructure && bedCount + 1 != planned)
            throw new ApplicationFault(409,
                $"Активная палата должна содержать ровно {planned} мест, сейчас {bedCount}. " +
                "Число коек активной палаты нельзя изменить по одной: сначала выведите палату из эксплуатации.");
        var number = request.Number.Trim();
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            await EnsureStructureNumberFreeAsync(connection, transaction,
                "SELECT 1 FROM project.beds WHERE ward_id = @id AND number = @number",
                new() { ["id"] = wardId, ["number"] = number },
                "Койка с таким номером уже есть в этой палате", cancellationToken);
            long id;
            await using (var command = new NpgsqlCommand("""
                INSERT INTO project.beds(ward_id, number) VALUES (@ward, @number) RETURNING id
                """, connection, transaction))
            {
                AddParameters(command, new() { ["ward"] = wardId, ["number"] = number });
                id = Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "insert", "bed", id, requestId,
                ["ward_id", "number"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }

    public async Task SetBedActiveAsync(UserAccess access, long bedId, bool isActive, string requestId,
        CancellationToken cancellationToken)
    {
        var rows = await RowsAsync("""
            SELECT bed.id, bed.is_active AS "bedActive", b.hospital_id AS "organizationId",
                EXISTS (SELECT 1 FROM project.bed_occupancies bo WHERE bo.bed_id = bed.id
                    AND tstzrange(bo.started_at, bo.ended_at, '[)') @> CURRENT_TIMESTAMP) AS occupied
            FROM project.beds bed
            JOIN project.wards w ON w.id = bed.ward_id
            JOIN project.departments d ON d.id = w.department_id
            JOIN project.buildings b ON b.id = d.building_id
            WHERE bed.id = @id
            """, new() { ["id"] = bedId }, cancellationToken);
        if (rows.Count == 0) throw new ApplicationFault(404, "Койка не найдена");
        var row = rows[0];
        if (!ManagesOrganization(access, (long)row["organizationId"]!))
            throw new ApplicationFault(403, "Койка вне вашей области доступа");
        if (!isActive && (bool)row["occupied"]!)
            throw new ApplicationFault(409, "Койка занята пациентом: сначала оформите перевод или выписку");
        if ((bool)row["bedActive"]! == isActive) return;
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        try
        {
            await using (var command = new NpgsqlCommand("""
                UPDATE project.beds SET is_active = @active WHERE id = @id
                """, connection, transaction))
            {
                AddParameters(command, new() { ["active"] = isActive, ["id"] = bedId });
                if (await command.ExecuteNonQueryAsync(cancellationToken) == 0)
                    throw new ApplicationFault(404, "Койка не найдена");
            }
            await AuditWriteAsync(connection, transaction, access.UserId, "update", "bed", bedId, requestId,
                ["is_active"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error) when (BusinessRuleFault(error) is { } fault)
        {
            throw fault;
        }
    }
}
