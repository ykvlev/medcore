using System.Data;
using System.Globalization;
using System.Security.Cryptography;
using System.Text.Json;
using Medcore.Application;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Options;
using Npgsql;
using NpgsqlTypes;

namespace Medcore.Infrastructure;

public sealed partial class MedcoreStore(MedcoreDbContext dbContext, NpgsqlDataSource source, IMemoryCache cache)
{
    private readonly MedcoreDbContext db = dbContext;
    private readonly NpgsqlDataSource dataSource = source;
    private readonly IMemoryCache accessCache = cache;

    // Доступ меняется редко, но отключение пользователя и смена ролей должны
    // применяться не позже чем через минуту. Скользящий TTL ускоряет серию
    // запросов, абсолютный — ограничивает устаревание прав.
    private static readonly MemoryCacheEntryOptions AccessCacheOptions = new()
    {
        SlidingExpiration = TimeSpan.FromSeconds(45),
        AbsoluteExpirationRelativeToNow = TimeSpan.FromSeconds(60)
    };

    private static readonly JsonSerializerOptions AccessJson = new() { PropertyNameCaseInsensitive = true };

    private sealed record AccessScopeJson(string Code, long? OrganizationId, long? LaboratoryId,
        long? DepartmentId, string? Name);

    private sealed record AccessOrganizationJson(long Id, string Name);
    private static readonly PasswordHasher<UserEntity> Passwords = new(Options.Create(new PasswordHasherOptions
    {
        CompatibilityMode = PasswordHasherCompatibilityMode.IdentityV3,
        IterationCount = 210_000
    }));
    private static readonly string DummyHash = Passwords.HashPassword(new UserEntity(), "non-account-dummy-verification");
    public const int SessionHours = 8;

    // Один запрос вместо users → employees → roles → scopes: роли и области
    // собираются json_agg на сервере, поэтому аутентификация стоит один round-trip.
    private const string AccessProjection = """
        SELECT u.id AS user_id, u.employee_id, u.login,
            CASE WHEN e.id IS NULL THEN u.login
                 ELSE btrim(concat_ws(' ', e.last_name, e.first_name, e.middle_name)) END AS display_name,
            (SELECT coalesce(json_agg(r.code ORDER BY r.code), '[]'::json)::text
                FROM project.roles r
                JOIN project.user_roles ur ON ur.role_id = r.id
                WHERE ur.user_id = u.id) AS roles,
            (SELECT coalesce(json_agg(json_build_object(
                        'code', r.code,
                        'organizationId', s.organization_id,
                        'laboratoryId', s.laboratory_id,
                        'departmentId', s.department_id,
                        'name', o.name) ORDER BY r.code, s.id), '[]'::json)::text
                FROM project.user_organization_scopes s
                JOIN project.roles r ON r.id = s.role_id
                LEFT JOIN project.medical_organizations o ON o.id = s.organization_id
                WHERE s.user_id = u.id) AS scopes,
            CASE WHEN EXISTS (
                    SELECT 1 FROM project.user_roles ur
                    JOIN project.roles r ON r.id = ur.role_id
                    WHERE ur.user_id = u.id AND r.code IN ('minister_of_health', 'governor'))
                THEN (SELECT coalesce(json_agg(json_build_object('id', org.id, 'name', org.name)
                            ORDER BY org.name), '[]'::json)::text
                        FROM (SELECT o.id, o.name FROM project.medical_organizations o
                            WHERE o.is_active ORDER BY o.name LIMIT 500) org)
                ELSE '[]'::text
            END AS all_organizations
        """;

    public Task<UserAccess?> AccessAsync(long id, CancellationToken cancellationToken) =>
        LoadAccessAsync(AccessProjection + """

            FROM project.users u
            LEFT JOIN project.employees e ON e.id = u.employee_id
            WHERE u.id = @id AND u.is_active AND (e.id IS NULL OR e.is_active)
            """, new() { ["id"] = id }, cancellationToken);

    private async Task<UserAccess?> LoadAccessAsync(string sql, Dictionary<string, object?> parameters,
        CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = new NpgsqlCommand(sql, connection);
        AddParameters(command, parameters);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        if (!await reader.ReadAsync(cancellationToken)) return null;
        var userId = reader.GetInt64(0);
        var employeeId = reader.IsDBNull(1) ? (long?)null : reader.GetInt64(1);
        var login = reader.GetString(2);
        var displayName = reader.GetString(3);
        var roles = JsonSerializer.Deserialize<string[]>(reader.GetString(4), AccessJson) ?? [];
        var scopes = JsonSerializer.Deserialize<AccessScopeJson[]>(reader.GetString(5), AccessJson) ?? [];
        var allOrganizations = JsonSerializer.Deserialize<AccessOrganizationJson[]>(reader.GetString(6), AccessJson) ?? [];
        var organizationsByRole = scopes.Where(x => x.OrganizationId is not null)
            .GroupBy(x => x.Code)
            .ToDictionary(group => group.Key,
                group => group.Select(x => x.OrganizationId!.Value).Distinct().ToArray());
        OrganizationReference[] organizations;
        if (roles.Any(code => code is "minister_of_health" or "governor"))
        {
            // Министр и губернатор не имеют строк области: их срез — все организации города.
            organizations = allOrganizations.Select(x => new OrganizationReference(x.Id, x.Name)).ToArray();
        }
        else
        {
            organizations = scopes.Where(x => x.OrganizationId is not null)
                .DistinctBy(x => x.OrganizationId)
                .Select(x => new OrganizationReference(x.OrganizationId!.Value, x.Name!)).ToArray();
        }
        var headDepartmentId = scopes
            .Where(x => x.DepartmentId is not null && x.Code == "head_of_department")
            .Select(x => x.DepartmentId!.Value).FirstOrDefault();
        return new UserAccess(userId, employeeId, login, displayName, roles, organizationsByRole,
            scopes.Where(x => x.LaboratoryId is not null && x.Code == "lab_staff")
                .Select(x => x.LaboratoryId!.Value).Distinct().ToArray(),
            organizations)
        {
            DepartmentId = headDepartmentId > 0 ? headDepartmentId : null
        };
    }

    public async Task<LoginResult?> LoginAsync(LoginRequest request, string requestId, CancellationToken cancellationToken)
    {
        var normalized = request.Login.Trim().ToLowerInvariant();
        var user = await db.Users.AsNoTracking().SingleOrDefaultAsync(x => x.Login.ToLower() == normalized, cancellationToken);
        PasswordVerificationResult verification;
        try
        {
            verification = Passwords.VerifyHashedPassword(user ?? new UserEntity(), user?.PasswordHash ?? DummyHash, request.Password);
        }
        catch (FormatException) { verification = PasswordVerificationResult.Failed; }
        var access = user is { IsActive: true } && verification != PasswordVerificationResult.Failed
            ? await AccessAsync(user.Id, cancellationToken) : null;
        if (access is null)
        {
            await AuditAsync(null, "login", "session", null, "failure", requestId, cancellationToken);
            return null;
        }
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        if (verification == PasswordVerificationResult.SuccessRehashNeeded)
        {
            await using var rehash = new NpgsqlCommand("UPDATE project.users SET password_hash = @hash WHERE id = @id", connection, transaction);
            AddParameters(rehash, new() { ["hash"] = Passwords.HashPassword(user!, request.Password), ["id"] = user!.Id });
            await rehash.ExecuteNonQueryAsync(cancellationToken);
        }
        await using (var command = new NpgsqlCommand("""
            INSERT INTO project.user_sessions(user_id, token_hash, expires_at)
            VALUES (@id, @hash, CURRENT_TIMESTAMP + interval '8 hours');
            INSERT INTO project.audit_logs(actor_user_id, action, entity_type, request_id, outcome)
            VALUES (@id, 'login', 'session', @request, 'success');
            """, connection, transaction))
        {
            AddParameters(command, new() { ["id"] = access.UserId, ["hash"] = TokenHash(token), ["request"] = requestId });
            await command.ExecuteNonQueryAsync(cancellationToken);
        }
        await transaction.CommitAsync(cancellationToken);
        return new LoginResult(access.ToCurrentUser(), token);
    }

    public async Task<UserAccess?> SessionAsync(string token, CancellationToken cancellationToken)
    {
        if (token.Length != 64 || !token.All(Uri.IsHexDigit)) return null;
        var hash = TokenHash(token);
        var key = AccessCacheKey(hash);
        if (accessCache.TryGetValue(key, out UserAccess? cached) && cached is not null) return cached;
        var access = await LoadAccessAsync(AccessProjection + """

            FROM project.user_sessions s
            JOIN project.users u ON u.id = s.user_id
            LEFT JOIN project.employees e ON e.id = u.employee_id
            WHERE s.token_hash = @hash AND s.revoked_at IS NULL AND s.expires_at > CURRENT_TIMESTAMP
              AND u.is_active AND (e.id IS NULL OR e.is_active)
            """, new() { ["hash"] = hash }, cancellationToken);
        if (access is not null) accessCache.Set(key, access, AccessCacheOptions);
        return access;
    }

    private static string AccessCacheKey(string tokenHash) => "medcore:access:" + tokenHash;

    public async Task LogoutAsync(string? token, long userId, string requestId, CancellationToken cancellationToken)
    {
        if (token is null) return;
        var hash = TokenHash(token);
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            UPDATE project.user_sessions SET revoked_at = clock_timestamp()
            WHERE token_hash = @hash AND user_id = @user AND revoked_at IS NULL;
            INSERT INTO project.audit_logs(actor_user_id, action, entity_type, request_id, outcome)
            VALUES (@user, 'logout', 'session', @request, 'success');
            """, connection, transaction);
        AddParameters(command, new() { ["hash"] = hash, ["user"] = userId, ["request"] = requestId });
        await command.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        // После выхода cookie больше не должна приниматься даже при живом кеше.
        accessCache.Remove(AccessCacheKey(hash));
    }

    private static string TokenHash(string token) => Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    public async Task AuditAsync(long? actor, string action, string entityType, long? entityId,
        string outcome, string requestId, CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = new NpgsqlCommand("""
            INSERT INTO project.audit_logs(actor_user_id, action, entity_type, entity_id, request_id, outcome)
            VALUES (@actor, @action, @entity, @id, @request, @outcome)
            """, connection);
        command.Parameters.AddWithValue("actor", NpgsqlDbType.Bigint, (object?)actor ?? DBNull.Value);
        command.Parameters.AddWithValue("id", NpgsqlDbType.Bigint, (object?)entityId ?? DBNull.Value);
        AddParameters(command, new() { ["action"] = action, ["entity"] = entityType, ["request"] = requestId, ["outcome"] = outcome });
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private async Task<List<Dictionary<string, object?>>> RowsAsync(string sql,
        Dictionary<string, object?> parameters, CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var command = new NpgsqlCommand(sql, connection);
        AddParameters(command, parameters);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var rows = new List<Dictionary<string, object?>>();
        while (await reader.ReadAsync(cancellationToken)) rows.Add(ReadRow(reader));
        return rows;
    }

    // Несколько независимых SELECT уходят одним пакетом: PostgreSQL получает
    // все команды в одном round-trip, а результат читается по NextResult.
    private async Task<List<List<Dictionary<string, object?>>>> BatchRowsAsync(
        IReadOnlyList<string> statements, Dictionary<string, object?> parameters, CancellationToken cancellationToken)
    {
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var batch = new NpgsqlBatch(connection);
        foreach (var statement in statements)
        {
            var command = new NpgsqlBatchCommand(statement);
            AddParameters(command, parameters);
            batch.BatchCommands.Add(command);
        }
        await using var reader = await batch.ExecuteReaderAsync(cancellationToken);
        var results = new List<List<Dictionary<string, object?>>>(statements.Count);
        do
        {
            var rows = new List<Dictionary<string, object?>>();
            while (await reader.ReadAsync(cancellationToken)) rows.Add(ReadRow(reader));
            results.Add(rows);
        } while (await reader.NextResultAsync(cancellationToken));
        return results;
    }

    private static Dictionary<string, object?> ReadRow(System.Data.Common.DbDataReader reader)
    {
        var row = new Dictionary<string, object?>();
        for (var i = 0; i < reader.FieldCount; i++)
            row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
        return row;
    }

    private static void AddParameters(NpgsqlCommand command, Dictionary<string, object?> values) =>
        AddParameters(command.Parameters, values);

    private static void AddParameters(NpgsqlBatchCommand command, Dictionary<string, object?> values) =>
        AddParameters(command.Parameters, values);

    private static void AddParameters(NpgsqlParameterCollection parameters, Dictionary<string, object?> values)
    {
        foreach (var (key, value) in values)
        {
            var type = value switch
            {
                long[] => NpgsqlDbType.Array | NpgsqlDbType.Bigint,
                long => NpgsqlDbType.Bigint,
                int => NpgsqlDbType.Integer,
                bool => NpgsqlDbType.Boolean,
                DateOnly => NpgsqlDbType.Date,
                DateTimeOffset => NpgsqlDbType.TimestampTz,
                _ => NpgsqlDbType.Text
            };
            parameters.AddWithValue(key, type, value ?? DBNull.Value);
        }
    }

    private static Dictionary<string, object?> AccessParameters(UserAccess access) => new()
    {
        ["reg_orgs"] = access.OrganizationIdsFor("registrar"),
        ["doctor_orgs"] = access.OrganizationIdsFor("doctor"),
        ["hospital_orgs"] = AccessPolicies.HospitalReadOrganizationIds(access),
        ["employee"] = access.EmployeeId ?? -1L,
        ["orgs"] = access.OrganizationIds,
        ["labs"] = access.LaboratoryIds
    };

    // Область отчётов: министр и губернатор видят все организации, остальные —
    // только учреждения своих ролей. Пустой набор даёт пустые строки, а не ошибку.
    private async Task<long[]> ReportOrganizationIdsAsync(UserAccess access, CancellationToken cancellationToken) =>
        AccessPolicies.CanReadAllOrganizations(access)
            ? await db.Organizations.AsNoTracking().Select(o => o.Id).ToArrayAsync(cancellationToken)
            : AccessPolicies.ReportOrganizationIds(access);

    // A doctor needs both organizational scope and a recorded care relationship.
    private const string CareCaseSql = """
        c.organization_id = ANY(@doctor_orgs) AND (
            EXISTS (SELECT 1 FROM project.appointments a JOIN project.appointment_doctors ad ON ad.appointment_id = a.id
                    WHERE a.case_id = c.id AND ad.doctor_id = @employee)
            OR EXISTS (SELECT 1 FROM project.case_diagnoses cd WHERE cd.case_id = c.id AND cd.doctor_id = @employee)
            OR EXISTS (SELECT 1 FROM project.medical_record_entries me WHERE me.case_id = c.id AND me.doctor_id = @employee)
            OR EXISTS (SELECT 1 FROM project.prescriptions pr WHERE pr.case_id = c.id AND pr.doctor_id = @employee)
            OR EXISTS (SELECT 1 FROM project.referrals r WHERE r.case_id = c.id AND r.referring_doctor_id = @employee)
            OR EXISTS (SELECT 1 FROM project.lab_orders lo WHERE lo.case_id = c.id AND lo.doctor_id = @employee)
            OR EXISTS (SELECT 1 FROM project.surgeries s JOIN project.surgery_participants sp ON sp.surgery_id = s.id
                       WHERE s.case_id = c.id AND sp.doctor_id = @employee)
            OR EXISTS (SELECT 1 FROM project.hospitalizations h JOIN project.attending_physician_history ah ON ah.hospitalization_id = h.id
                       WHERE h.case_id = c.id AND ah.doctor_id = @employee)
        )
        """;

    private const string RegistrarPatientSql = """
        EXISTS (SELECT 1 FROM project.patient_attachments pa WHERE pa.patient_id = p.id
            AND pa.polyclinic_id = ANY(@reg_orgs) AND pa.started_at <= CURRENT_TIMESTAMP
            AND (pa.ended_at IS NULL OR pa.ended_at > CURRENT_TIMESTAMP))
        OR EXISTS (SELECT 1 FROM project.medical_cases mc WHERE mc.patient_id = p.id
            AND mc.organization_id = ANY(@reg_orgs) AND mc.status = 'open')
        """;

    // Больничные роли (главный врач, заместитель, заведующий) видят пациента, если он
    // прикреплён к поликлинике этой больницы, имеет открытый случай в ней либо был
    // госпитализирован в её отделения. Область берётся из user_organization_scopes.
    private const string HospitalPatientSql = """
        EXISTS (SELECT 1 FROM project.patient_attachments pa
            WHERE pa.patient_id = p.id AND pa.started_at <= CURRENT_TIMESTAMP
              AND (pa.ended_at IS NULL OR pa.ended_at > CURRENT_TIMESTAMP)
              AND (pa.polyclinic_id = ANY(@hospital_orgs)
                   OR EXISTS (SELECT 1 FROM project.polyclinics pc
                       WHERE pc.organization_id = pa.polyclinic_id
                         AND pc.hospital_id = ANY(@hospital_orgs))))
        OR EXISTS (SELECT 1 FROM project.medical_cases mc
            WHERE mc.patient_id = p.id AND mc.organization_id = ANY(@hospital_orgs)
              AND mc.status = 'open')
        OR EXISTS (SELECT 1 FROM project.hospitalizations h
            JOIN project.departments hd ON hd.id = h.department_id
            JOIN project.buildings hb ON hb.id = hd.building_id
            WHERE h.patient_id = p.id AND hb.hospital_id = ANY(@hospital_orgs))
        """;

    private static readonly string PatientAccessSql = $"(({RegistrarPatientSql}) OR ({HospitalPatientSql}) OR EXISTS (SELECT 1 FROM project.medical_cases c WHERE c.patient_id = p.id AND ({CareCaseSql})))";

    // Случаи, доступные пользователю: области регистратора/больницы и лечебные связи врача.
    private static readonly string AllowedCaseSql = $"c.organization_id = ANY(@reg_orgs) OR c.organization_id = ANY(@hospital_orgs) OR ({CareCaseSql})";

    // The predicate is a compile-time constant; every value is bound as a parameter.
    private static readonly string PatientAccessQuery = "SELECT p.* FROM project.patients p WHERE " + PatientAccessSql;

    private IQueryable<PatientEntity> AccessiblePatients(UserAccess access)
    {
        if (!AccessPolicies.CanReadPatients(access)) throw new ApplicationFault(403, "Нет доступа к карточкам пациентов");
        var parameters = AccessParameters(access).Where(x => x.Key is "reg_orgs" or "doctor_orgs" or "hospital_orgs" or "employee")
            .Select(x => new NpgsqlParameter(x.Key, x.Value!)).ToArray();
        return db.Patients.FromSqlRaw(PatientAccessQuery, parameters).AsNoTracking();
    }
}
