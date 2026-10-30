using System.Data;
using Medcore.Application;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using Npgsql;
using NpgsqlTypes;

namespace Medcore.Infrastructure;

// Администрирование учётных записей и журнала аудита. Пароль хешируется
// PasswordHasher (IdentityV3, PBKDF2) и в БД попадает только хеш.
public sealed partial class MedcoreStore
{
    private static readonly PasswordHasher<UserEntity> AdminPasswords = new(Options.Create(new PasswordHasherOptions
    {
        CompatibilityMode = PasswordHasherCompatibilityMode.IdentityV3,
        IterationCount = 210_000
    }));

    private static readonly string[] AssignableRoles =
    [
        "system_admin", "organization_admin", "doctor", "registrar", "lab_staff", "analyst",
        "chief_physician", "deputy_chief_physician", "head_of_department",
        "minister_of_health", "governor"
    ];

    public async Task<IReadOnlyList<AdminUser>> AdminUsersAsync(UserAccess access, string? search,
        CancellationToken cancellationToken)
    {
        RequireSystemAdmin(access);
        if (search is { Length: > 100 }) throw new ApplicationFault(400, "Слишком длинный поисковый запрос");
        var raw = await RowsAsync("""
            SELECT u.id, u.login,
                u.employee_id AS "employeeId",
                CASE WHEN e.id IS NULL THEN NULL
                     ELSE concat_ws(' ', e.last_name, e.first_name, e.middle_name) END AS "employeeName",
                u.is_active AS "isActive", u.created_at AS "createdAt"
            FROM project.users u
            LEFT JOIN project.employees e ON e.id = u.employee_id
            WHERE u.login ILIKE @pattern
               OR concat_ws(' ', e.last_name, e.first_name, e.middle_name) ILIKE @pattern
            ORDER BY u.login, u.id
            LIMIT 200
            """, new() { ["pattern"] = "%" + (search?.Trim() ?? "") + "%" }, cancellationToken);
        var roles = await UserRolesAsync(raw.Select(row => Convert.ToInt64(row["id"]!)).ToArray(), cancellationToken);
        return raw.Select(row =>
        {
            var id = Convert.ToInt64(row["id"]!);
            return new AdminUser(id, (string)row["login"]!,
                row["employeeId"] as long?, row["employeeName"] as string,
                (bool)row["isActive"]!, AsDateTimeOffset(row["createdAt"]),
                roles.GetValueOrDefault(id) ?? []);
        }).ToArray();
    }

    public async Task<IReadOnlyList<AdminRole>> AdminRolesAsync(UserAccess access, CancellationToken cancellationToken)
    {
        RequireSystemAdmin(access);
        var rows = await RowsAsync("SELECT code, name FROM project.roles ORDER BY code", new(), cancellationToken);
        return rows.Select(row => new AdminRole((string)row["code"]!, (string)row["name"]!)).ToArray();
    }

    public async Task<PageResult<AuditEntry>> AdminAuditAsync(UserAccess access, DateOnly? from, DateOnly? to,
        string? action, int page, int pageSize, CancellationToken cancellationToken)
    {
        RequireSystemAdmin(access);
        ValidatePage(page, pageSize);
        var actionFilter = string.IsNullOrWhiteSpace(action) ? null : action.Trim();
        if (actionFilter is { Length: > 100 }) throw new ApplicationFault(400, "Слишком длинный фильтр действия");
        var (periodFrom, periodTo) = ResolveAuditPeriod(from, to);
        var parameters = new Dictionary<string, object?>
        {
            ["from_date"] = periodFrom,
            ["to_date"] = periodTo,
            ["action"] = actionFilter,
            ["take"] = pageSize,
            ["skip"] = (page - 1) * pageSize
        };
        var raw = await RowsAsync("""
            WITH bounds AS (
                SELECT ((@from_date)::timestamp AT TIME ZONE 'Europe/Moscow') AS starts,
                       (((@to_date + 1))::timestamp AT TIME ZONE 'Europe/Moscow') AS ends
            )
            SELECT a.id, a.occurred_at AS "occurredAt", u.login AS "actorLogin", a.action,
                a.entity_type AS "entityType", a.entity_id AS "entityId", a.outcome,
                count(*) OVER () AS "_total"
            FROM project.audit_logs a
            LEFT JOIN project.users u ON u.id = a.actor_user_id
            CROSS JOIN bounds b
            WHERE a.occurred_at >= b.starts AND a.occurred_at < b.ends
              AND (@action IS NULL OR a.action = @action)
            ORDER BY a.occurred_at DESC, a.id DESC
            LIMIT @take OFFSET @skip
            """, parameters, cancellationToken);
        var total = raw.Count == 0 ? 0 : Convert.ToInt64(raw[0]["_total"]!);
        var items = raw.Select(row => new AuditEntry(Convert.ToInt64(row["id"]!),
            AsDateTimeOffset(row["occurredAt"]), row["actorLogin"] as string, (string)row["action"]!,
            (string)row["entityType"]!, row["entityId"] as long?, (string)row["outcome"]!)).ToArray();
        return new PageResult<AuditEntry>(items, PageTotal(total), page, pageSize);
    }

    public async Task<long> CreateAdminUserAsync(UserAccess access, CreateAdminUserRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        RequireSystemAdmin(access);
        var login = NormalizeLogin(request.Login);
        if (request.Password is null || request.Password.Length < 8 || request.Password.Length > 128)
            throw new ApplicationFault(400, "Пароль должен содержать от 8 до 128 символов");
        var roles = NormalizeRoles(request.Roles);
        await ValidateEmployeeAsync(request.EmployeeId, cancellationToken);
        await ValidateScopeTargetsAsync(roles, cancellationToken);
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        long id;
        try
        {
            await using var insert = new NpgsqlCommand("""
                INSERT INTO project.users(login, password_hash, employee_id)
                VALUES (@login, @hash, @employee) RETURNING id
                """, connection, transaction);
            insert.Parameters.AddWithValue("login", NpgsqlDbType.Text, login);
            insert.Parameters.AddWithValue("hash", NpgsqlDbType.Text, AdminPasswords.HashPassword(new UserEntity(), request.Password));
            insert.Parameters.AddWithValue("employee", NpgsqlDbType.Bigint, (object?)request.EmployeeId ?? DBNull.Value);
            id = Convert.ToInt64(await insert.ExecuteScalarAsync(cancellationToken));
        }
        catch (PostgresException error) when (error.SqlState == "23505")
        {
            throw new ApplicationFault(409, error.ConstraintName == "uq_user_login"
                ? "Учётная запись с таким логином уже существует"
                : "Этот сотрудник уже привязан к другой учётной записи");
        }
        await InsertUserRolesAsync(connection, transaction, id, roles, cancellationToken);
        await InsertUserAuditAsync(connection, transaction, access.UserId, "insert", id, null, requestId, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return id;
    }

    public async Task UpdateAdminUserAsync(UserAccess access, long id, UpdateAdminUserRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        RequireSystemAdmin(access);
        var roles = NormalizeRoles(request.Roles);
        if (id == access.UserId && !request.IsActive)
            throw new ApplicationFault(409, "Нельзя отключить собственную учётную запись");
        if (id == access.UserId && !roles.Any(role => role.Code == "system_admin"))
            throw new ApplicationFault(409, "Нельзя лишить собственную учётную запись роли system_admin");
        await ValidateScopeTargetsAsync(roles, cancellationToken);
        var currentRoles = await CurrentUserRolesAsync(id, cancellationToken);
        if (currentRoles is null) throw new ApplicationFault(404, "Учётная запись не найдена");
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        bool wasActive;
        await using (var lockUser = new NpgsqlCommand("""
            SELECT is_active FROM project.users WHERE id = @id FOR UPDATE
            """, connection, transaction))
        {
            lockUser.Parameters.AddWithValue("id", NpgsqlDbType.Bigint, id);
            var value = await lockUser.ExecuteScalarAsync(cancellationToken);
            if (value is null) throw new ApplicationFault(404, "Учётная запись не найдена");
            wasActive = (bool)value;
        }
        await using (var update = new NpgsqlCommand("""
            UPDATE project.users SET is_active = @active WHERE id = @id
            """, connection, transaction))
        {
            update.Parameters.AddWithValue("active", NpgsqlDbType.Boolean, request.IsActive);
            update.Parameters.AddWithValue("id", NpgsqlDbType.Bigint, id);
            await update.ExecuteNonQueryAsync(cancellationToken);
        }
        if (wasActive && !request.IsActive)
        {
            await using var revoke = new NpgsqlCommand("""
                UPDATE project.user_sessions SET revoked_at = clock_timestamp()
                WHERE user_id = @id AND revoked_at IS NULL
                """, connection, transaction);
            revoke.Parameters.AddWithValue("id", NpgsqlDbType.Bigint, id);
            await revoke.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var clearScopes = new NpgsqlCommand(
            "DELETE FROM project.user_organization_scopes WHERE user_id = @id", connection, transaction))
        {
            clearScopes.Parameters.AddWithValue("id", NpgsqlDbType.Bigint, id);
            await clearScopes.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var clearRoles = new NpgsqlCommand(
            "DELETE FROM project.user_roles WHERE user_id = @id", connection, transaction))
        {
            clearRoles.Parameters.AddWithValue("id", NpgsqlDbType.Bigint, id);
            await clearRoles.ExecuteNonQueryAsync(cancellationToken);
        }
        await InsertUserRolesAsync(connection, transaction, id, roles, cancellationToken);
        var changedFields = new List<string>();
        if (wasActive != request.IsActive) changedFields.Add("is_active");
        var added = roles.Except(currentRoles).Select(DescribeRole).ToArray();
        var removed = currentRoles.Except(roles).Select(DescribeRole).ToArray();
        if (changedFields.Count > 0)
            await InsertUserAuditAsync(connection, transaction, access.UserId, "update", id,
                changedFields.ToArray(), requestId, cancellationToken);
        if (added.Length > 0 || removed.Length > 0)
            await InsertUserAuditAsync(connection, transaction, access.UserId, "role_change", id,
                added.Select(role => "+" + role).Concat(removed.Select(role => "-" + role)).ToArray(),
                requestId, cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    private static void RequireSystemAdmin(UserAccess access)
    {
        if (!access.HasRole("system_admin"))
            throw new ApplicationFault(403, "Раздел администрирования доступен только системному администратору");
    }

    private static void ValidatePage(int page, int pageSize)
    {
        if (page < 1 || pageSize is < 1 or > 100 || (long)(page - 1) * pageSize > int.MaxValue)
            throw new ApplicationFault(400, "Некорректные параметры страницы");
    }

    private static int PageTotal(long total) => total > int.MaxValue ? int.MaxValue : (int)total;

    private static string NormalizeLogin(string? login)
    {
        var normalized = (login ?? "").Trim();
        if (normalized.Length is < 3 or > 128 || normalized.Any(char.IsWhiteSpace))
            throw new ApplicationFault(400, "Логин должен содержать от 3 до 128 символов без пробелов");
        return normalized;
    }

    private static List<NormalizedRole> NormalizeRoles(IReadOnlyList<AdminRoleAssignment>? roles)
    {
        if (roles is null || roles.Count == 0) throw new ApplicationFault(400, "Укажите хотя бы одну роль");
        var result = new List<NormalizedRole>(roles.Count);
        foreach (var assignment in roles)
        {
            var code = (assignment.Role ?? "").Trim().ToLowerInvariant();
            if (!AssignableRoles.Contains(code, StringComparer.Ordinal))
                throw new ApplicationFault(400, "Неизвестная роль: " + (assignment.Role ?? ""));
            if (assignment.OrganizationId is not null && assignment.LaboratoryId is not null)
                throw new ApplicationFault(400, "Для роли указывается либо учреждение, либо лаборатория");
            if (assignment.LaboratoryId is not null && code != "lab_staff")
                throw new ApplicationFault(400, "Область лаборатории допустима только для роли lab_staff");
            if (code == "system_admin"
                && (assignment.OrganizationId is not null || assignment.LaboratoryId is not null
                    || assignment.DepartmentId is not null))
                throw new ApplicationFault(400, "Системный администратор не имеет области действия");
            if (assignment.DepartmentId is not null)
            {
                // department_id в user_organization_scopes разрешён только заведующему.
                if (code != "head_of_department")
                    throw new ApplicationFault(400, "Область отделения допустима только для роли head_of_department");
                if (assignment.OrganizationId is null)
                    throw new ApplicationFault(400, "Для области отделения укажите учреждение");
            }
            var normalized = new NormalizedRole(code, assignment.OrganizationId, assignment.LaboratoryId,
                assignment.DepartmentId);
            if (result.Contains(normalized))
                throw new ApplicationFault(400, "Роль с такой областью действия указана повторно");
            result.Add(normalized);
        }
        return result;
    }

    private static string DescribeRole(NormalizedRole role) => role switch
    {
        { DepartmentId: long department } => $"{role.Code}@department:{department}",
        { OrganizationId: long organization } => $"{role.Code}@organization:{organization}",
        { LaboratoryId: long laboratory } => $"{role.Code}@laboratory:{laboratory}",
        _ => role.Code
    };

    private async Task ValidateEmployeeAsync(long? employeeId, CancellationToken cancellationToken)
    {
        if (employeeId is null) return;
        var rows = await RowsAsync("SELECT id FROM project.employees WHERE id = @id AND is_active",
            new() { ["id"] = employeeId.Value }, cancellationToken);
        if (rows.Count == 0) throw new ApplicationFault(400, "Сотрудник не найден или неактивен");
    }

    private async Task ValidateScopeTargetsAsync(List<NormalizedRole> roles, CancellationToken cancellationToken)
    {
        var organizations = roles.Where(role => role.OrganizationId is not null)
            .Select(role => role.OrganizationId!.Value).Distinct().ToArray();
        if (organizations.Length > 0)
        {
            var found = await RowsAsync("""
                SELECT id FROM project.medical_organizations WHERE id = ANY(@ids) AND is_active
                """, new() { ["ids"] = organizations }, cancellationToken);
            if (found.Count != organizations.Length)
                throw new ApplicationFault(400, "Учреждение области действия не найдено или неактивно");
        }
        var laboratories = roles.Where(role => role.LaboratoryId is not null)
            .Select(role => role.LaboratoryId!.Value).Distinct().ToArray();
        if (laboratories.Length > 0)
        {
            var found = await RowsAsync("""
                SELECT id FROM project.laboratories WHERE id = ANY(@ids) AND is_active
                """, new() { ["ids"] = laboratories }, cancellationToken);
            if (found.Count != laboratories.Length)
                throw new ApplicationFault(400, "Лаборатория области действия не найдена или неактивна");
        }
        // Область заведующего: отделение должно существовать и принадлежать учреждению
        // области этой же роли (отделение → корпус → больница).
        foreach (var role in roles.Where(role => role.DepartmentId is not null))
        {
            var rows = await RowsAsync("""
                SELECT b.hospital_id AS "organizationId" FROM project.departments d
                JOIN project.buildings b ON b.id = d.building_id
                WHERE d.id = @id AND d.is_active
                """, new() { ["id"] = role.DepartmentId!.Value }, cancellationToken);
            if (rows.Count == 0)
                throw new ApplicationFault(400, "Отделение области действия не найдено или неактивно");
            if ((long)rows[0]["organizationId"]! != role.OrganizationId)
                throw new ApplicationFault(400, "Отделение не принадлежит учреждению области действия");
        }
    }

    private async Task<Dictionary<long, IReadOnlyList<AdminUserRole>>> UserRolesAsync(long[] userIds,
        CancellationToken cancellationToken)
    {
        if (userIds.Length == 0) return new Dictionary<long, IReadOnlyList<AdminUserRole>>();
        var rows = await RowsAsync("""
            SELECT ur.user_id AS "userId", r.code,
                s.organization_id AS "organizationId", o.name AS "organizationName",
                s.laboratory_id AS "laboratoryId", l.name AS "laboratoryName",
                s.department_id AS "departmentId", d.name AS "departmentName"
            FROM project.user_roles ur
            JOIN project.roles r ON r.id = ur.role_id
            LEFT JOIN project.user_organization_scopes s ON s.user_id = ur.user_id AND s.role_id = ur.role_id
            LEFT JOIN project.medical_organizations o ON o.id = s.organization_id
            LEFT JOIN project.laboratories l ON l.id = s.laboratory_id
            LEFT JOIN project.departments d ON d.id = s.department_id
            WHERE ur.user_id = ANY(@users)
            ORDER BY r.code, o.name, l.name, d.name
            """, new() { ["users"] = userIds }, cancellationToken);
        return rows.GroupBy(row => Convert.ToInt64(row["userId"]!)).ToDictionary(group => group.Key,
            group => (IReadOnlyList<AdminUserRole>)group.Select(row => new AdminUserRole((string)row["code"]!,
                row["organizationId"] as long?, row["organizationName"] as string,
                row["laboratoryId"] as long?, row["laboratoryName"] as string,
                row["departmentId"] as long?, row["departmentName"] as string)).ToArray());
    }

    private async Task<List<NormalizedRole>?> CurrentUserRolesAsync(long userId,
        CancellationToken cancellationToken)
    {
        var existing = await RowsAsync("SELECT id FROM project.users WHERE id = @id",
            new() { ["id"] = userId }, cancellationToken);
        if (existing.Count == 0) return null;
        var rows = await RowsAsync("""
            SELECT r.code, s.organization_id AS "organizationId", s.laboratory_id AS "laboratoryId",
                s.department_id AS "departmentId"
            FROM project.user_roles ur
            JOIN project.roles r ON r.id = ur.role_id
            LEFT JOIN project.user_organization_scopes s ON s.user_id = ur.user_id AND s.role_id = ur.role_id
            WHERE ur.user_id = @id
            ORDER BY r.code
            """, new() { ["id"] = userId }, cancellationToken);
        return rows.Select(row => new NormalizedRole((string)row["code"]!,
            row["organizationId"] as long?, row["laboratoryId"] as long?,
            row["departmentId"] as long?)).ToList();
    }

    private static async Task InsertUserRolesAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        long userId, List<NormalizedRole> roles, CancellationToken cancellationToken)
    {
        // Одна роль может иметь несколько областей действия: строка user_roles
        // вставляется один раз, области — отдельными строками.
        var inserted = new HashSet<string>(StringComparer.Ordinal);
        foreach (var role in roles)
        {
            if (inserted.Add(role.Code))
            {
                await using var command = new NpgsqlCommand("""
                    INSERT INTO project.user_roles(user_id, role_id)
                    SELECT @user, r.id FROM project.roles r WHERE r.code = @code
                    """, connection, transaction);
                command.Parameters.AddWithValue("user", NpgsqlDbType.Bigint, userId);
                command.Parameters.AddWithValue("code", NpgsqlDbType.Text, role.Code);
                if (await command.ExecuteNonQueryAsync(cancellationToken) != 1)
                    throw new ApplicationFault(400, "Роль не найдена в справочнике: " + role.Code);
            }
            if (role.OrganizationId is null && role.LaboratoryId is null && role.DepartmentId is null) continue;
            await using var scope = new NpgsqlCommand("""
                INSERT INTO project.user_organization_scopes(user_id, role_id, organization_id, laboratory_id, department_id)
                SELECT @user, r.id, @organization, @laboratory, @department FROM project.roles r WHERE r.code = @code
                """, connection, transaction);
            scope.Parameters.AddWithValue("user", NpgsqlDbType.Bigint, userId);
            scope.Parameters.AddWithValue("code", NpgsqlDbType.Text, role.Code);
            scope.Parameters.AddWithValue("organization", NpgsqlDbType.Bigint, (object?)role.OrganizationId ?? DBNull.Value);
            scope.Parameters.AddWithValue("laboratory", NpgsqlDbType.Bigint, (object?)role.LaboratoryId ?? DBNull.Value);
            scope.Parameters.AddWithValue("department", NpgsqlDbType.Bigint, (object?)role.DepartmentId ?? DBNull.Value);
            await scope.ExecuteNonQueryAsync(cancellationToken);
        }
    }

    private static async Task InsertUserAuditAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        long actor, string action, long entityId, string[]? changedFields, string requestId,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand("""
            INSERT INTO project.audit_logs(actor_user_id, action, entity_type, entity_id, changed_fields, request_id, outcome)
            VALUES (@actor, @action, 'user', @entity, @fields, @request, 'success')
            """, connection, transaction);
        command.Parameters.AddWithValue("actor", NpgsqlDbType.Bigint, actor);
        command.Parameters.AddWithValue("action", NpgsqlDbType.Text, action);
        command.Parameters.AddWithValue("entity", NpgsqlDbType.Bigint, entityId);
        command.Parameters.AddWithValue("fields", NpgsqlDbType.Array | NpgsqlDbType.Text,
            changedFields is { Length: > 0 } ? changedFields : DBNull.Value);
        command.Parameters.AddWithValue("request", NpgsqlDbType.Text, requestId);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static DateTimeOffset AsDateTimeOffset(object? value) => value switch
    {
        DateTimeOffset offset => offset,
        DateTime date => new DateTimeOffset(DateTime.SpecifyKind(date,
            date.Kind == DateTimeKind.Unspecified ? DateTimeKind.Utc : date.Kind)),
        _ => DateTimeOffset.MinValue
    };

    private sealed record NormalizedRole(string Code, long? OrganizationId, long? LaboratoryId,
        long? DepartmentId = null);
}
