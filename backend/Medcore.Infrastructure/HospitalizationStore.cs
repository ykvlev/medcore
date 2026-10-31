using System.Data;
using System.Globalization;
using Medcore.Application;
using Npgsql;
using NpgsqlTypes;

namespace Medcore.Infrastructure;

// Стационар: чтение, атомарное поступление, перевод, смена лечащего врача, выписка и направления.
// Транзакции READ COMMITTED; предметные строки блокируются SELECT ... FOR UPDATE.
// Схема не меняется: миграции 001–003.
public sealed partial class MedcoreStore
{
    // ---------- Помощники стационара ----------

    private static void RequireHospitalReader(UserAccess access)
    {
        if (!access.Roles.Any(role => role is "organization_admin" or "doctor" or "registrar")
            && !AccessPolicies.IsHospitalReader(access))
            throw new ApplicationFault(403, "Нет доступа к госпитализациям");
    }

    private static void RequireHospitalDoctor(UserAccess access)
    {
        if (!access.HasRole("doctor") || access.EmployeeId is null)
            throw new ApplicationFault(403, "Операция доступна только врачу");
    }

    // Право чтения списка и карточки госпитализации. Больничные роли (главный врач,
    // заместитель, заведующий) видят только госпитализации своей больницы; администратор,
    // врач и регистратор сохраняют прежнее правило области/отношения к пациенту.
    private static string HospitalReadPredicate(UserAccess access) =>
        AccessPolicies.IsHospitalReader(access)
            ? "(o.id = ANY(@hospital_orgs))"
            : $"(o.id = ANY(@manager_orgs) OR {PatientAccessSql})";

    private static string? HospitalText(object? value) => value as string;

    private static DateTimeOffset HospitalTimestamp(object? value) => value switch
    {
        DateTimeOffset offset => offset,
        DateTime dateTime => new DateTimeOffset(DateTime.SpecifyKind(dateTime, DateTimeKind.Utc)),
        _ => throw new InvalidOperationException("Ожидалась временная метка")
    };

    private static DateTimeOffset? HospitalTimestampOrNull(object? value) =>
        value is null ? null : HospitalTimestamp(value);

    private static DateOnly HospitalDate(object? value) => value switch
    {
        DateOnly date => date,
        DateTime dateTime => DateOnly.FromDateTime(dateTime),
        _ => throw new InvalidOperationException("Ожидалась дата")
    };

    private static DateTimeOffset HospitalNow() => DateTimeOffset.UtcNow;

    // Проверяющие функции миграции 002 поднимают 23514 с русским текстом причины.
    private static ApplicationFault HospitalWriteFault(PostgresException error) => error.SqlState switch
    {
        "23P01" when error.ConstraintName?.Contains("bed_occupancies", StringComparison.Ordinal) == true =>
            new ApplicationFault(409, "Койка уже занята на указанное время"),
        "23P01" when error.ConstraintName?.Contains("hospitalizations", StringComparison.Ordinal) == true =>
            new ApplicationFault(409, "У пациента уже есть госпитализация на указанный период"),
        "23P01" when error.ConstraintName?.Contains("attending_physician_history", StringComparison.Ordinal) == true =>
            new ApplicationFault(409, "Назначение лечащего врача пересекается с сохранённым интервалом"),
        "23P01" => new ApplicationFault(409, "Интервал пересекается с уже сохранёнными данными"),
        "23514" when error.MessageText is { Length: > 0 } text
            && text.Any(character => character is >= 'А' and <= 'я') => new ApplicationFault(409, text),
        "23514" => new ApplicationFault(409, "Операция нарушает правила стационара"),
        "23505" => new ApplicationFault(409, "Такая запись уже существует"),
        "23503" => new ApplicationFault(409, "Связанная запись не найдена или недоступна"),
        "25000" => new ApplicationFault(409, "Операция требует уровня изоляции READ COMMITTED"),
        _ => new ApplicationFault(409, "Операция нарушает ограничения данных")
    };

    private static async Task<List<Dictionary<string, object?>>> TxRowsAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, string sql, Dictionary<string, object?> parameters,
        CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        AddParameters(command, parameters);
        await using var reader = await command.ExecuteReaderAsync(cancellationToken);
        var rows = new List<Dictionary<string, object?>>();
        while (await reader.ReadAsync(cancellationToken))
        {
            var row = new Dictionary<string, object?>();
            for (var index = 0; index < reader.FieldCount; index++)
                row[reader.GetName(index)] = reader.IsDBNull(index) ? null : reader.GetValue(index);
            rows.Add(row);
        }
        return rows;
    }

    private static async Task<long> TxScalarAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        string sql, Dictionary<string, object?> parameters, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        AddParameters(command, parameters);
        var value = await command.ExecuteScalarAsync(cancellationToken)
            ?? throw new ApplicationFault(409, "Операция не вернула идентификатор записи");
        return Convert.ToInt64(value, CultureInfo.InvariantCulture);
    }

    private static async Task<int> TxExecuteAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        string sql, Dictionary<string, object?> parameters, CancellationToken cancellationToken)
    {
        await using var command = new NpgsqlCommand(sql, connection, transaction);
        AddParameters(command, parameters);
        return await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task HospitalAuditAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
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
        command.Parameters.AddWithValue("fields", NpgsqlDbType.Array | NpgsqlDbType.Text,
            (object?)changedFields ?? DBNull.Value);
        await command.ExecuteNonQueryAsync(cancellationToken);
    }

    private static HospitalizationRow ToHospitalizationRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (long)row["patientId"]!, (string)row["patientName"]!, (string)row["hospitalName"]!,
        (string)row["departmentName"]!, HospitalText(row["wardNumber"]), HospitalText(row["bedNumber"]),
        HospitalText(row["doctorName"]), (string)row["status"]!, HospitalTimestamp(row["admittedAt"]),
        HospitalTimestampOrNull(row["dischargedAt"]), HospitalText(row["diagnosis"]));

    private static HospitalizationSummary ToHospitalizationSummary(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (long)row["patientId"]!, (string)row["patientName"]!, (string)row["hospitalName"]!,
        (string)row["admissionDepartmentName"]!, (string)row["departmentName"]!,
        HospitalText(row["wardNumber"]), HospitalText(row["bedNumber"]), HospitalText(row["doctorName"]),
        (string)row["status"]!, HospitalTimestamp(row["admittedAt"]),
        HospitalTimestampOrNull(row["dischargedAt"]), HospitalText(row["diagnosis"]));

    // ---------- Чтение ----------

    public async Task<PageResult<HospitalizationRow>> HospitalizationsPageAsync(UserAccess access, string? status,
        long? hospitalId, string? search, int page, int pageSize, CancellationToken cancellationToken)
    {
        RequireHospitalReader(access);
        if (page < 1 || pageSize is < 1 or > 100 || search?.Trim().Length > 100
            || (long)(page - 1) * pageSize > int.MaxValue)
            throw new ApplicationFault(400, "Некорректные параметры поиска или страницы");
        var normalizedStatus = string.IsNullOrWhiteSpace(status) ? null : status.Trim();
        if (normalizedStatus is not null && normalizedStatus is not ("active" or "discharged" or "cancelled"))
            throw new ApplicationFault(400, "Статус госпитализации: active, discharged или cancelled");
        var parameters = AccessParameters(access);
        parameters["manager_orgs"] = AccessPolicies.ManagerOrganizationIds(access);
        parameters["status"] = normalizedStatus;
        parameters["hospital"] = hospitalId ?? 0L;
        parameters["search"] = string.IsNullOrWhiteSpace(search) ? null : $"%{search.Trim()}%";
        var readPredicate = HospitalReadPredicate(access);
        var from = """
            FROM project.hospitalizations h
            JOIN project.patients p ON p.id = h.patient_id
            JOIN project.departments admission_d ON admission_d.id = h.department_id
            JOIN project.buildings admission_b ON admission_b.id = admission_d.building_id
            JOIN project.medical_organizations o ON o.id = admission_b.hospital_id
            """;
        var filter = $"""
            WHERE {readPredicate}
              AND (@status IS NULL OR h.status::text = @status)
              AND (@hospital = 0 OR o.id = @hospital)
              AND (@search IS NULL OR concat_ws(' ', p.last_name, p.first_name, p.middle_name) ILIKE @search)
            """;
        var total = (long)(await RowsAsync($"SELECT count(*)::bigint AS total {from} {filter}",
            parameters, cancellationToken))[0]["total"]!;
        parameters["limit"] = pageSize;
        parameters["offset"] = (page - 1) * pageSize;
        var rows = await RowsAsync($"""
            SELECT h.id, h.patient_id AS "patientId",
                concat_ws(' ', p.last_name, p.first_name, p.middle_name) AS "patientName",
                o.name AS "hospitalName",
                coalesce(current_d.name, admission_d.name) AS "departmentName",
                location.ward_number AS "wardNumber", location.bed_number AS "bedNumber",
                attending.full_name AS "doctorName",
                h.status::text AS status, h.admitted_at AS "admittedAt", h.discharged_at AS "dischargedAt",
                (SELECT dg.name FROM project.case_diagnoses cd
                    JOIN project.diagnoses dg ON dg.id = cd.diagnosis_id
                    WHERE cd.case_id = h.case_id
                    ORDER BY cd.is_primary DESC, cd.recorded_at DESC, cd.id DESC LIMIT 1) AS diagnosis
            {from}
            LEFT JOIN LATERAL (
                SELECT bed.number AS bed_number, w.number AS ward_number, w.department_id
                FROM project.bed_occupancies bo
                JOIN project.beds bed ON bed.id = bo.bed_id
                JOIN project.wards w ON w.id = bed.ward_id
                WHERE bo.hospitalization_id = h.id
                ORDER BY bo.started_at DESC, bo.id DESC LIMIT 1) location ON true
            LEFT JOIN project.departments current_d ON current_d.id = location.department_id
            LEFT JOIN LATERAL (
                SELECT concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS full_name
                FROM project.attending_physician_history a
                JOIN project.employees e ON e.id = a.doctor_id
                WHERE a.hospitalization_id = h.id
                ORDER BY a.started_at DESC, a.id DESC LIMIT 1) attending ON true
            {filter}
            ORDER BY h.admitted_at DESC, h.id DESC
            LIMIT @limit OFFSET @offset
            """, parameters, cancellationToken);
        return new(rows.Select(ToHospitalizationRow).ToArray(), (int)total, page, pageSize);
    }

    public async Task<HospitalizationCard> HospitalizationCardAsync(UserAccess access, long id, string requestId,
        CancellationToken cancellationToken)
    {
        RequireHospitalReader(access);
        var parameters = AccessParameters(access);
        parameters["manager_orgs"] = AccessPolicies.ManagerOrganizationIds(access);
        parameters["id"] = id;
        var readPredicate = HospitalReadPredicate(access);
        var rows = await RowsAsync($"""
            SELECT h.id, h.patient_id AS "patientId",
                concat_ws(' ', p.last_name, p.first_name, p.middle_name) AS "patientName",
                o.name AS "hospitalName", admission_d.name AS "admissionDepartmentName",
                coalesce(current_d.name, admission_d.name) AS "departmentName",
                location.ward_number AS "wardNumber", location.bed_number AS "bedNumber",
                attending.full_name AS "doctorName", h.status::text AS status,
                h.admitted_at AS "admittedAt", h.discharged_at AS "dischargedAt",
                (SELECT dg.name FROM project.case_diagnoses cd
                    JOIN project.diagnoses dg ON dg.id = cd.diagnosis_id
                    WHERE cd.case_id = h.case_id
                    ORDER BY cd.is_primary DESC, cd.recorded_at DESC, cd.id DESC LIMIT 1) AS diagnosis
            FROM project.hospitalizations h
            JOIN project.patients p ON p.id = h.patient_id
            JOIN project.departments admission_d ON admission_d.id = h.department_id
            JOIN project.buildings admission_b ON admission_b.id = admission_d.building_id
            JOIN project.medical_organizations o ON o.id = admission_b.hospital_id
            LEFT JOIN LATERAL (
                SELECT bed.number AS bed_number, w.number AS ward_number, w.department_id
                FROM project.bed_occupancies bo
                JOIN project.beds bed ON bed.id = bo.bed_id
                JOIN project.wards w ON w.id = bed.ward_id
                WHERE bo.hospitalization_id = h.id
                ORDER BY bo.started_at DESC, bo.id DESC LIMIT 1) location ON true
            LEFT JOIN project.departments current_d ON current_d.id = location.department_id
            LEFT JOIN LATERAL (
                SELECT concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS full_name
                FROM project.attending_physician_history a
                JOIN project.employees e ON e.id = a.doctor_id
                WHERE a.hospitalization_id = h.id
                ORDER BY a.started_at DESC, a.id DESC LIMIT 1) attending ON true
            WHERE h.id = @id AND {readPredicate}
            """, parameters, cancellationToken);
        if (rows.Count == 0) throw new ApplicationFault(404, "Госпитализация не найдена в доступной области");

        var placements = (await RowsAsync("""
            SELECT bo.id, bo.bed_id AS "bedId", w.number AS "wardNumber", bed.number AS "bedNumber",
                d.id AS "departmentId", d.name AS "departmentName",
                bo.started_at AS "startedAt", bo.ended_at AS "endedAt"
            FROM project.bed_occupancies bo
            JOIN project.beds bed ON bed.id = bo.bed_id
            JOIN project.wards w ON w.id = bed.ward_id
            JOIN project.departments d ON d.id = w.department_id
            WHERE bo.hospitalization_id = @id
            ORDER BY bo.started_at, bo.id
            """, parameters, cancellationToken)).Select(row => new BedPlacementRow(
                (long)row["id"]!, (long)row["bedId"]!, HospitalText(row["wardNumber"]),
                HospitalText(row["bedNumber"]), (long)row["departmentId"]!, HospitalText(row["departmentName"]),
                HospitalTimestamp(row["startedAt"]), HospitalTimestampOrNull(row["endedAt"]))).ToArray();

        var attending = (await RowsAsync("""
            SELECT a.id, a.doctor_id AS "doctorId",
                concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS "doctorName",
                a.started_at AS "startedAt", a.ended_at AS "endedAt"
            FROM project.attending_physician_history a
            JOIN project.employees e ON e.id = a.doctor_id
            WHERE a.hospitalization_id = @id
            ORDER BY a.started_at, a.id
            """, parameters, cancellationToken)).Select(row => new AttendingPhysicianRow(
                (long)row["id"]!, (long)row["doctorId"]!, (string)row["doctorName"]!,
                HospitalTimestamp(row["startedAt"]), HospitalTimestampOrNull(row["endedAt"]))).ToArray();

        var history = (await RowsAsync("""
            SELECT events.id, events.type, events.title, events."occurredAt"
            FROM (
                SELECT h.id, 'admission' AS type, 'Поступление в стационар' AS title,
                    h.admitted_at AS "occurredAt"
                FROM project.hospitalizations h WHERE h.id = @id
                UNION ALL
                SELECT bo.id, 'placement',
                    'Размещение: палата ' || w.number || ', койка ' || bed.number, bo.started_at
                FROM project.bed_occupancies bo
                JOIN project.beds bed ON bed.id = bo.bed_id
                JOIN project.wards w ON w.id = bed.ward_id
                WHERE bo.hospitalization_id = @id
                UNION ALL
                SELECT a.id, 'attending', 'Лечащий врач: ' || concat_ws(' ', e.last_name, e.first_name, e.middle_name),
                    a.started_at
                FROM project.attending_physician_history a
                JOIN project.employees e ON e.id = a.doctor_id
                WHERE a.hospitalization_id = @id
                UNION ALL
                SELECT cd.id, 'diagnosis', dg.name, cd.recorded_at
                FROM project.case_diagnoses cd
                JOIN project.diagnoses dg ON dg.id = cd.diagnosis_id
                JOIN project.hospitalizations h ON h.case_id = cd.case_id AND h.id = @id
                UNION ALL
                SELECT me.id, 'record', 'Медицинская запись', me.recorded_at
                FROM project.medical_record_entries me
                JOIN project.hospitalizations h ON h.case_id = me.case_id AND h.id = @id
                UNION ALL
                SELECT h.id, 'discharge', 'Выписка из стационара', h.discharged_at
                FROM project.hospitalizations h
                WHERE h.id = @id AND h.discharged_at IS NOT NULL
            ) events
            ORDER BY events."occurredAt" DESC, events.id DESC
            LIMIT 100
            """, parameters, cancellationToken)).Select(row => new HistoryItem(
                (long)row["id"]!, (string)row["type"]!, (string)row["title"]!,
                HospitalTimestamp(row["occurredAt"]), null)).ToArray();

        await AuditAsync(access.UserId, "read", "hospitalization", id, "success", requestId, cancellationToken);
        return new(ToHospitalizationSummary(rows[0]), placements, attending, history);
    }

    public async Task<IReadOnlyList<AvailableBedRow>> AvailableBedsAsync(UserAccess access, long departmentId,
        DateTimeOffset? at, CancellationToken cancellationToken)
    {
        if (!access.Roles.Any(role => role is "organization_admin" or "doctor" or "registrar"))
            throw new ApplicationFault(403, "Нет доступа к коечному фонду");
        var moment = at ?? HospitalNow();
        var organizations = new[] { "organization_admin", "doctor", "registrar" }
            .SelectMany(access.OrganizationIdsFor).Distinct().ToArray();
        var parameters = new Dictionary<string, object?>
        {
            ["department"] = departmentId, ["organizations"] = organizations, ["at"] = moment
        };
        var department = await RowsAsync("""
            SELECT d.id, d.is_active AS "departmentActive", b.is_active AS "buildingActive",
                o.is_active AS "hospitalActive", b.hospital_id AS "hospitalId"
            FROM project.departments d
            JOIN project.buildings b ON b.id = d.building_id
            JOIN project.medical_organizations o ON o.id = b.hospital_id
            WHERE d.id = @department
            """, parameters, cancellationToken);
        if (department.Count == 0 || !organizations.Contains((long)department[0]["hospitalId"]!))
            throw new ApplicationFault(404, "Отделение не найдено в доступной области");
        var rows = await RowsAsync("""
            SELECT bed.id, bed.number, w.id AS "wardId", w.number AS "wardNumber",
                d.name AS "departmentName"
            FROM project.beds bed
            JOIN project.wards w ON w.id = bed.ward_id
            JOIN project.departments d ON d.id = w.department_id
            JOIN project.buildings b ON b.id = d.building_id
            JOIN project.medical_organizations o ON o.id = b.hospital_id
            WHERE d.id = @department
              AND bed.is_active AND w.is_active AND d.is_active AND b.is_active AND o.is_active
              AND o.id = ANY(@organizations)
              AND NOT EXISTS (
                  SELECT 1 FROM project.bed_occupancies bo
                  WHERE bo.bed_id = bed.id
                    AND tstzrange(bo.started_at, bo.ended_at, '[)') @> @at)
            ORDER BY w.number, bed.number, bed.id
            """, parameters, cancellationToken);
        return rows.Select(row => new AvailableBedRow((long)row["id"]!, (string)row["number"]!,
            HospitalText(row["wardNumber"]), (long)row["wardId"]!, (string)row["departmentName"]!)).ToArray();
    }

    // ---------- Поступление ----------

    public async Task<long> AdmitPatientAsync(UserAccess access, CreateHospitalizationRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        RequireHospitalDoctor(access);
        var admittedAt = request.AdmittedAt;
        if (admittedAt == default) throw new ApplicationFault(400, "Не указано время поступления");
        if (admittedAt > HospitalNow().AddMinutes(1))
            throw new ApplicationFault(400, "Время поступления не может быть позже текущего момента");

        var parameters = AccessParameters(access);
        parameters["admitted"] = admittedAt;
        parameters["hospital"] = request.HospitalId;
        var referralId = request.ReferralId is > 0 ? request.ReferralId : null;
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            // Подтверждённое отношение врач–пациент: случай пациента в доступной организации,
            // где врач уже участвует в лечении (существующая политика CareCaseSql).
            parameters["patient"] = request.PatientId;
            var patients = await TxRowsAsync(connection, transaction, $"""
                SELECT p.id FROM project.patients p
                WHERE p.id = @patient AND EXISTS (
                    SELECT 1 FROM project.medical_cases c WHERE c.patient_id = p.id AND ({CareCaseSql}))
                """, parameters, cancellationToken);
            if (patients.Count == 0)
                throw new ApplicationFault(404, "Пациент не найден среди пациентов вашей области лечения");

            parameters["department"] = request.DepartmentId;
            var departments = await TxRowsAsync(connection, transaction, """
                SELECT d.id, d.specialization_id AS "specializationId", d.is_active AS "departmentActive",
                    b.is_active AS "buildingActive", b.hospital_id AS "hospitalId",
                    o.is_active AS "hospitalActive"
                FROM project.departments d
                JOIN project.buildings b ON b.id = d.building_id
                JOIN project.medical_organizations o ON o.id = b.hospital_id
                WHERE d.id = @department
                FOR UPDATE OF d
                """, parameters, cancellationToken);
            if (departments.Count == 0) throw new ApplicationFault(404, "Отделение поступления не найдено");
            var department = departments[0];
            if ((long)department["hospitalId"]! != request.HospitalId)
                throw new ApplicationFault(409, "Отделение поступления относится к другой больнице");
            if (!(bool)department["departmentActive"]! || !(bool)department["buildingActive"]!
                || !(bool)department["hospitalActive"]!)
                throw new ApplicationFault(409, "Отделение поступления или его учреждение выведены из эксплуатации");
            if (!access.OrganizationIdsFor("doctor").Contains(request.HospitalId))
                throw new ApplicationFault(403, "Больница вне вашей области доступа");

            // Направление обязательно в схеме 001 (referral_id NOT NULL). Переданное направление
            // блокируется и проверяется, отсутствующее создаётся в этой же транзакции по открытому
            // случаю пациента в организации врача: отдельного «поступления без направления» нет.
            var autoReferral = referralId is null;
            if (referralId is long providedReferral)
            {
                parameters["referral"] = providedReferral;
                var referrals = await TxRowsAsync(connection, transaction, """
                    SELECT r.id, r.target_hospital_id AS "hospitalId", r.specialization_id AS "specializationId",
                        r.status, r.issued_at AS "issuedAt", source.patient_id AS "patientId"
                    FROM project.referrals r
                    JOIN project.medical_cases source ON source.id = r.case_id
                    WHERE r.id = @referral
                    FOR UPDATE OF r
                    """, parameters, cancellationToken);
                if (referrals.Count == 0) throw new ApplicationFault(404, "Направление не найдено");
                var referral = referrals[0];
                if ((long)referral["patientId"]! != request.PatientId)
                    throw new ApplicationFault(409, "Направление выписано другому пациенту");
                if ((long)referral["hospitalId"]! != request.HospitalId)
                    throw new ApplicationFault(409, "Направление выписано в другую больницу");
                if ((string)referral["status"]! != "issued")
                    throw new ApplicationFault(409, "Направление уже использовано или отменено");
                if (admittedAt < HospitalTimestamp(referral["issuedAt"]))
                    throw new ApplicationFault(409, "Время поступления раньше даты направления");
                if ((long)department["specializationId"]! != (long)referral["specializationId"]!)
                    throw new ApplicationFault(409, "Отделение поступления не соответствует специализации направления");
            }
            else
            {
                var sourceCases = await TxRowsAsync(connection, transaction, """
                    SELECT c.id FROM project.medical_cases c
                    WHERE c.patient_id = @patient AND c.status = 'open'
                      AND c.organization_id = ANY(@doctor_orgs)
                    ORDER BY c.opened_at DESC, c.id DESC LIMIT 1
                    """, parameters, cancellationToken);
                if (sourceCases.Count == 0)
                    throw new ApplicationFault(409, "Нет открытого случая для направления");
                parameters["sourceCase"] = (long)sourceCases[0]["id"]!;
                parameters["specialization"] = (long)department["specializationId"]!;
                var createdReferral = await TxScalarAsync(connection, transaction, """
                    INSERT INTO project.referrals(case_id, referring_doctor_id, target_hospital_id,
                        specialization_id, issued_at, reason, status)
                    VALUES (@sourceCase, @employee, @hospital, @specialization, @admitted,
                        'Оформлено при поступлении', 'used')
                    RETURNING id
                    """, parameters, cancellationToken);
                parameters["referral"] = createdReferral;
                await HospitalAuditAsync(connection, transaction, access.UserId, "insert", "referral",
                    createdReferral, requestId, ["case_id", "target_hospital_id", "specialization_id"],
                    cancellationToken);
            }

            // Койка блокируется до проверки интервала: два одновременных поступления на одну
            // койку сериализуются, второе видит сохранённое размещение и получает 409.
            parameters["bed"] = request.BedId;
            var beds = await TxRowsAsync(connection, transaction, """
                SELECT bed.id, bed.is_active AS "bedActive", w.is_active AS "wardActive",
                    d.is_active AS "departmentActive", b.is_active AS "buildingActive",
                    o.is_active AS "hospitalActive", b.hospital_id AS "hospitalId",
                    w.department_id AS "wardDepartmentId"
                FROM project.beds bed
                JOIN project.wards w ON w.id = bed.ward_id
                JOIN project.departments d ON d.id = w.department_id
                JOIN project.buildings b ON b.id = d.building_id
                JOIN project.medical_organizations o ON o.id = b.hospital_id
                WHERE bed.id = @bed
                FOR UPDATE OF bed
                """, parameters, cancellationToken);
            if (beds.Count == 0) throw new ApplicationFault(404, "Койка не найдена");
            var bed = beds[0];
            if ((long)bed["hospitalId"]! != request.HospitalId)
                throw new ApplicationFault(409, "Койка принадлежит другой больнице");
            if (!(bool)bed["bedActive"]! || !(bool)bed["wardActive"]! || !(bool)bed["departmentActive"]!
                || !(bool)bed["buildingActive"]! || !(bool)bed["hospitalActive"]!)
                throw new ApplicationFault(409, "Койка или её подразделение выведены из эксплуатации");
            if (await TxRowsAsync(connection, transaction, """
                SELECT 1 FROM project.bed_occupancies bo
                WHERE bo.bed_id = @bed
                  AND tstzrange(bo.started_at, bo.ended_at, '[)') && tstzrange(@admitted, NULL, '[)')
                LIMIT 1
                """, parameters, cancellationToken) is { Count: > 0 })
                throw new ApplicationFault(409, "Койка уже занята на указанное время");
            if (await TxRowsAsync(connection, transaction, """
                SELECT 1 FROM project.hospitalizations h
                WHERE h.patient_id = @patient AND h.status <> 'cancelled'
                  AND tstzrange(h.admitted_at, h.discharged_at, '[)') && tstzrange(@admitted, NULL, '[)')
                LIMIT 1
                """, parameters, cancellationToken) is { Count: > 0 })
                throw new ApplicationFault(409, "У пациента уже есть госпитализация на указанный период");

            parameters["doctor"] = request.AttendingDoctorId;
            if (await TxRowsAsync(connection, transaction, """
                SELECT doctor.employee_id FROM project.doctors doctor
                JOIN project.employees e ON e.id = doctor.employee_id
                WHERE doctor.employee_id = @doctor AND e.is_active
                  AND EXISTS (
                      SELECT 1 FROM project.employments em
                      WHERE em.employee_id = doctor.employee_id AND em.organization_id = @hospital
                        AND em.started_on <= (timezone('Europe/Moscow', @admitted))::date
                        AND (em.ended_on IS NULL
                             OR em.ended_on > (timezone('Europe/Moscow', CURRENT_TIMESTAMP))::date))
                """, parameters, cancellationToken) is { Count: 0 })
                throw new ApplicationFault(409,
                    "Лечащий врач не работает в этой больнице на весь проверяемый интервал");

            var caseId = await TxScalarAsync(connection, transaction, """
                INSERT INTO project.medical_cases(patient_id, organization_id, case_type, status, opened_at, reason)
                VALUES (@patient, @hospital, 'inpatient', 'open', @admitted, 'Госпитализация в стационар')
                RETURNING id
                """, parameters, cancellationToken);
            parameters["case"] = caseId;
            var hospitalizationId = await TxScalarAsync(connection, transaction, """
                INSERT INTO project.hospitalizations(case_id, patient_id, referral_id, department_id, admitted_at)
                VALUES (@case, @patient, @referral, @department, @admitted)
                RETURNING id
                """, parameters, cancellationToken);
            parameters["hospitalization"] = hospitalizationId;
            await TxExecuteAsync(connection, transaction, """
                INSERT INTO project.bed_occupancies(hospitalization_id, bed_id, started_at)
                VALUES (@hospitalization, @bed, @admitted)
                """, parameters, cancellationToken);
            await TxExecuteAsync(connection, transaction, """
                INSERT INTO project.attending_physician_history(hospitalization_id, doctor_id, started_at)
                VALUES (@hospitalization, @doctor, @admitted)
                """, parameters, cancellationToken);
            if (!autoReferral
                && await TxExecuteAsync(connection, transaction,
                    "UPDATE project.referrals SET status = 'used' WHERE id = @referral AND status = 'issued'",
                    parameters, cancellationToken) == 0)
                throw new ApplicationFault(409, "Направление уже использовано или отменено");

            if (request.DiagnosisId is > 0)
            {
                parameters["diagnosis"] = request.DiagnosisId.Value;
                await TxExecuteAsync(connection, transaction, """
                    INSERT INTO project.case_diagnoses(case_id, diagnosis_id, doctor_id, recorded_at, is_primary)
                    VALUES (@case, @diagnosis, @employee, @admitted, true)
                    """, parameters, cancellationToken);
            }
            await HospitalAuditAsync(connection, transaction, access.UserId, "insert", "hospitalization",
                hospitalizationId, requestId, ["case_id", "patient_id", "department_id", "bed_id"],
                cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return hospitalizationId;
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // ---------- Перевод ----------

    public async Task TransferHospitalizationAsync(UserAccess access, long id, TransferHospitalizationRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        RequireHospitalDoctor(access);
        var occurredAt = request.OccurredAt;
        if (occurredAt == default) throw new ApplicationFault(400, "Не указано время перевода");
        if (occurredAt > HospitalNow().AddMinutes(1))
            throw new ApplicationFault(400, "Время перевода не может быть позже текущего момента");
        var parameters = AccessParameters(access);
        parameters["id"] = id;
        parameters["occurred"] = occurredAt;
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var hospitalization = await LockHospitalizationAsync(connection, transaction, parameters, cancellationToken);
            if ((string)hospitalization["status"]! != "active")
                throw new ApplicationFault(409, "Госпитализация уже завершена");
            var admission = await LockOpenPlacementAsync(connection, transaction, parameters, cancellationToken);
            if (occurredAt <= HospitalTimestamp(admission["startedAt"]))
                throw new ApplicationFault(409, "Время перевода должно быть позже начала текущего размещения");

            parameters["bed"] = request.BedId;
            var bed = await LockBedAsync(connection, transaction, parameters, cancellationToken);
            if ((long)bed["hospitalId"]! != (long)hospitalization["hospitalId"]!)
                throw new ApplicationFault(409, "Койка принадлежит другой больнице");
            if ((long)bed["id"]! == (long)admission["bedId"]!)
                throw new ApplicationFault(409, "Пациент уже находится на этой койке");
            if (await TxRowsAsync(connection, transaction, """
                SELECT 1 FROM project.bed_occupancies bo
                WHERE bo.bed_id = @bed
                  AND tstzrange(bo.started_at, bo.ended_at, '[)') && tstzrange(@occurred, NULL, '[)')
                LIMIT 1
                """, parameters, cancellationToken) is { Count: > 0 })
                throw new ApplicationFault(409, "Койка уже занята на указанное время");

            await TxExecuteAsync(connection, transaction,
                "UPDATE project.bed_occupancies SET ended_at = @occurred WHERE id = @placement",
                new Dictionary<string, object?>(parameters) { ["placement"] = admission["id"] }, cancellationToken);
            await TxExecuteAsync(connection, transaction, """
                INSERT INTO project.bed_occupancies(hospitalization_id, bed_id, started_at)
                VALUES (@id, @bed, @occurred)
                """, parameters, cancellationToken);
            await HospitalAuditAsync(connection, transaction, access.UserId, "transfer", "hospitalization",
                id, requestId, ["bed_id"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // ---------- Смена лечащего врача ----------

    public async Task ChangeAttendingPhysicianAsync(UserAccess access, long id,
        ChangeAttendingPhysicianRequest request, string requestId, CancellationToken cancellationToken)
    {
        RequireHospitalDoctor(access);
        var occurredAt = request.OccurredAt;
        if (occurredAt == default) throw new ApplicationFault(400, "Не указано время смены лечащего врача");
        if (occurredAt > HospitalNow().AddMinutes(1))
            throw new ApplicationFault(400, "Время смены врача не может быть позже текущего момента");
        var parameters = AccessParameters(access);
        parameters["id"] = id;
        parameters["occurred"] = occurredAt;
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var hospitalization = await LockHospitalizationAsync(connection, transaction, parameters, cancellationToken);
            if ((string)hospitalization["status"]! != "active")
                throw new ApplicationFault(409, "Госпитализация уже завершена");
            var current = await TxRowsAsync(connection, transaction, """
                SELECT a.id, a.doctor_id AS "doctorId", a.started_at AS "startedAt"
                FROM project.attending_physician_history a
                WHERE a.hospitalization_id = @id AND a.ended_at IS NULL
                ORDER BY a.started_at DESC, a.id DESC
                FOR UPDATE
                """, parameters, cancellationToken);
            if (current.Count != 1)
                throw new ApplicationFault(409, "Текущее назначение лечащего врача не найдено; проверьте историю");
            if (occurredAt <= HospitalTimestamp(current[0]["startedAt"]))
                throw new ApplicationFault(409, "Время смены врача должно быть позже начала текущего назначения");
            if ((long)current[0]["doctorId"]! == request.DoctorId)
                throw new ApplicationFault(409, "Этот врач уже назначен лечащим");

            parameters["doctor"] = request.DoctorId;
            parameters["hospital"] = (long)hospitalization["hospitalId"]!;
            if (await TxRowsAsync(connection, transaction, """
                SELECT doctor.employee_id FROM project.doctors doctor
                JOIN project.employees e ON e.id = doctor.employee_id
                WHERE doctor.employee_id = @doctor AND e.is_active
                  AND EXISTS (
                      SELECT 1 FROM project.employments em
                      WHERE em.employee_id = doctor.employee_id AND em.organization_id = @hospital
                        AND em.started_on <= (timezone('Europe/Moscow', @occurred))::date
                        AND (em.ended_on IS NULL
                             OR em.ended_on > (timezone('Europe/Moscow', CURRENT_TIMESTAMP))::date))
                """, parameters, cancellationToken) is { Count: 0 })
                throw new ApplicationFault(409,
                    "Новый лечащий врач не работает в этой больнице на весь проверяемый интервал");

            await TxExecuteAsync(connection, transaction,
                "UPDATE project.attending_physician_history SET ended_at = @occurred WHERE id = @current",
                new Dictionary<string, object?>(parameters) { ["current"] = current[0]["id"] }, cancellationToken);
            await TxExecuteAsync(connection, transaction, """
                INSERT INTO project.attending_physician_history(hospitalization_id, doctor_id, started_at)
                VALUES (@id, @doctor, @occurred)
                """, parameters, cancellationToken);
            await HospitalAuditAsync(connection, transaction, access.UserId, "attending_change", "hospitalization",
                id, requestId, ["doctor_id"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // ---------- Выписка ----------

    public async Task DischargeHospitalizationAsync(UserAccess access, long id,
        DischargeHospitalizationRequest request, string requestId, CancellationToken cancellationToken)
    {
        RequireHospitalDoctor(access);
        var dischargedAt = request.DischargedAt;
        if (dischargedAt == default) throw new ApplicationFault(400, "Не указано время выписки");
        if (dischargedAt > HospitalNow().AddMinutes(1))
            throw new ApplicationFault(400, "Время выписки не может быть позже текущего момента");
        var parameters = AccessParameters(access);
        parameters["id"] = id;
        parameters["discharged"] = dischargedAt;
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var hospitalization = await LockHospitalizationAsync(connection, transaction, parameters, cancellationToken);
            if ((string)hospitalization["status"]! != "active")
                throw new ApplicationFault(409, "Госпитализация уже завершена");
            if (dischargedAt <= HospitalTimestamp(hospitalization["admittedAt"]))
                throw new ApplicationFault(409, "Время выписки должно быть позже времени поступления");
            var placement = await LockOpenPlacementAsync(connection, transaction, parameters, cancellationToken);
            if (dischargedAt <= HospitalTimestamp(placement["startedAt"]))
                throw new ApplicationFault(409, "Время выписки раньше начала текущего размещения");
            var attending = await TxRowsAsync(connection, transaction, """
                SELECT a.id, a.started_at AS "startedAt"
                FROM project.attending_physician_history a
                WHERE a.hospitalization_id = @id AND a.ended_at IS NULL
                ORDER BY a.started_at DESC, a.id DESC
                FOR UPDATE
                """, parameters, cancellationToken);
            if (attending.Count != 1)
                throw new ApplicationFault(409, "Текущее назначение лечащего врача не найдено");
            if (dischargedAt <= HospitalTimestamp(attending[0]["startedAt"]))
                throw new ApplicationFault(409, "Время выписки раньше начала текущего назначения врача");

            await TxExecuteAsync(connection, transaction,
                "UPDATE project.bed_occupancies SET ended_at = @discharged WHERE hospitalization_id = @id AND ended_at IS NULL",
                parameters, cancellationToken);
            await TxExecuteAsync(connection, transaction,
                "UPDATE project.attending_physician_history SET ended_at = @discharged WHERE hospitalization_id = @id AND ended_at IS NULL",
                parameters, cancellationToken);
            await TxExecuteAsync(connection, transaction, """
                UPDATE project.hospitalizations
                SET status = 'discharged', discharged_at = @discharged
                WHERE id = @id AND status = 'active'
                """, parameters, cancellationToken);
            await TxExecuteAsync(connection, transaction, """
                UPDATE project.medical_cases
                SET status = 'closed', closed_at = @discharged
                WHERE id = @case AND status = 'open'
                """, new Dictionary<string, object?>(parameters)
                { ["case"] = (long)hospitalization["caseId"]! }, cancellationToken);
            await HospitalAuditAsync(connection, transaction, access.UserId, "discharge", "hospitalization",
                id, requestId, ["status", "discharged_at"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // ---------- Направление ----------
    // Оформление и смена статуса направления живут в ReferralStore.cs: маршрут общий
    // для врача и регистратора, а поля направления расширены миграцией 007.

    // ---------- Общие проверки записи ----------

    private static async Task<Dictionary<string, object?>> LockHospitalizationAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, Dictionary<string, object?> parameters, CancellationToken cancellationToken)
    {
        var rows = await TxRowsAsync(connection, transaction, $"""
            SELECT h.id, h.status::text AS status, h.admitted_at AS "admittedAt",
                h.discharged_at AS "dischargedAt", h.case_id AS "caseId", h.patient_id AS "patientId",
                admission_b.hospital_id AS "hospitalId",
                EXISTS (SELECT 1 FROM project.attending_physician_history a
                    WHERE a.hospitalization_id = h.id AND a.doctor_id = @employee) AS "isAttending",
                EXISTS (SELECT 1 FROM project.medical_cases c
                    WHERE c.id = h.case_id AND ({CareCaseSql})) AS "isRelated"
            FROM project.hospitalizations h
            JOIN project.departments admission_d ON admission_d.id = h.department_id
            JOIN project.buildings admission_b ON admission_b.id = admission_d.building_id
            WHERE h.id = @id
            FOR UPDATE OF h
            """, parameters, cancellationToken);
        if (rows.Count == 0) throw new ApplicationFault(404, "Госпитализация не найдена");
        if (!(bool)rows[0]["isAttending"]! && !(bool)rows[0]["isRelated"]!)
            throw new ApplicationFault(403, "Операция доступна только врачу, связанному с пациентом");
        return rows[0];
    }

    private static async Task<Dictionary<string, object?>> LockOpenPlacementAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, Dictionary<string, object?> parameters, CancellationToken cancellationToken)
    {
        var rows = await TxRowsAsync(connection, transaction, """
            SELECT bo.id, bo.bed_id AS "bedId", bo.started_at AS "startedAt"
            FROM project.bed_occupancies bo
            WHERE bo.hospitalization_id = @id AND bo.ended_at IS NULL
            ORDER BY bo.started_at DESC, bo.id DESC
            FOR UPDATE
            """, parameters, cancellationToken);
        if (rows.Count != 1)
            throw new ApplicationFault(409, "Текущее размещение не найдено; проверьте историю госпитализации");
        return rows[0];
    }

    private static async Task<Dictionary<string, object?>> LockBedAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, Dictionary<string, object?> parameters, CancellationToken cancellationToken)
    {
        var rows = await TxRowsAsync(connection, transaction, """
            SELECT bed.id, bed.is_active AS "bedActive", w.is_active AS "wardActive",
                d.is_active AS "departmentActive", b.is_active AS "buildingActive",
                o.is_active AS "hospitalActive", b.hospital_id AS "hospitalId"
            FROM project.beds bed
            JOIN project.wards w ON w.id = bed.ward_id
            JOIN project.departments d ON d.id = w.department_id
            JOIN project.buildings b ON b.id = d.building_id
            JOIN project.medical_organizations o ON o.id = b.hospital_id
            WHERE bed.id = @bed
            FOR UPDATE OF bed
            """, parameters, cancellationToken);
        if (rows.Count == 0) throw new ApplicationFault(404, "Койка не найдена");
        var bed = rows[0];
        if (!(bool)bed["bedActive"]! || !(bool)bed["wardActive"]! || !(bool)bed["departmentActive"]!
            || !(bool)bed["buildingActive"]! || !(bool)bed["hospitalActive"]!)
            throw new ApplicationFault(409, "Койка или её подразделение выведены из эксплуатации");
        return bed;
    }
}
