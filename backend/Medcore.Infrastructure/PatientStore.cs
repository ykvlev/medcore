using System.Data;
using Medcore.Application;
using Microsoft.EntityFrameworkCore;
using Npgsql;
using NpgsqlTypes;

namespace Medcore.Infrastructure;

public sealed partial class MedcoreStore
{
    // Проекция карточки/строки списка одним SQL: поликлиника, последний случай и
    // последний приём считаются LATERAL-подзапросами, а не шестью копиями условия.
    private static string PatientRowSql(string extraWhere) => $"""
        SELECT p.id, p.last_name AS "lastName", p.first_name AS "firstName", p.middle_name AS "middleName",
            p.birth_date AS "birthDate", p.sex, p.phone, p.email, p.address,
            poly.name AS "polyclinicName",
            CASE WHEN appt.last_appointment IS NULL
                      OR (opened.last_case IS NOT NULL AND opened.last_case > appt.last_appointment)
                 THEN opened.last_case ELSE appt.last_appointment END AS "lastVisitAt",
            CASE WHEN p.is_active THEN 'active' ELSE 'archived' END AS status,
            p.version
        FROM project.patients p
        LEFT JOIN LATERAL (
            SELECT o.name FROM project.patient_attachments pa
            JOIN project.medical_organizations o ON o.id = pa.polyclinic_id
            WHERE pa.patient_id = p.id AND pa.started_at <= CURRENT_TIMESTAMP
              AND (pa.ended_at IS NULL OR pa.ended_at > CURRENT_TIMESTAMP)
            LIMIT 1) poly ON true
        LEFT JOIN LATERAL (
            SELECT max(c.opened_at) AS last_case FROM project.medical_cases c
            WHERE c.patient_id = p.id AND ({AllowedCaseSql})) opened ON true
        LEFT JOIN LATERAL (
            SELECT max(a.completed_at) AS last_appointment
            FROM project.medical_cases c JOIN project.appointments a ON a.case_id = c.id
            WHERE c.patient_id = p.id AND a.status = 'completed' AND ({AllowedCaseSql})) appt ON true
        WHERE ({PatientAccessSql}){extraWhere}
        """;

    private static PatientRow ToPatientRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (string)row["lastName"]!, (string)row["firstName"]!, row["middleName"] as string,
        (DateOnly)row["birthDate"]!, (string)row["sex"]!, row["phone"] as string, row["email"] as string,
        row["address"] as string, row["polyclinicName"] as string,
        row["lastVisitAt"] is null ? null : AsDateTimeOffset(row["lastVisitAt"]),
        (string)row["status"]!, (int)row["version"]!);

    public async Task<PageResult<PatientRow>> PatientsAsync(UserAccess access, string? search, int page,
        int pageSize, CancellationToken cancellationToken)
    {
        if (page < 1 || pageSize is < 1 or > 100 || search?.Length > 100 || (long)(page - 1) * pageSize > int.MaxValue)
            throw new ApplicationFault(400, "Некорректные параметры поиска или страницы");
        if (!AccessPolicies.CanReadPatients(access))
            throw new ApplicationFault(403, "Нет доступа к карточкам пациентов");
        var parameters = AccessParameters(access);
        parameters["search"] = string.IsNullOrWhiteSpace(search) ? null : $"%{search.Trim()}%";
        parameters["limit"] = pageSize;
        parameters["offset"] = (page - 1) * pageSize;
        const string searchFilter = """
             AND (@search IS NULL OR (p.last_name || ' ' || p.first_name || ' ' || coalesce(p.middle_name, '')) ILIKE @search)
            """;
        // COUNT и страница — два SELECT, но один round-trip через NpgsqlBatch.
        var batch = await BatchRowsAsync([
            $"SELECT count(*)::bigint AS total FROM project.patients p WHERE ({PatientAccessSql}){searchFilter}",
            PatientRowSql(searchFilter) + """
                 ORDER BY p.last_name, p.first_name, p.id
                 LIMIT @limit OFFSET @offset
                """
        ], parameters, cancellationToken);
        var total = (int)(long)batch[0][0]["total"]!;
        return new(batch[1].Select(ToPatientRow).ToArray(), total, page, pageSize);
    }

    public async Task<PatientCard> PatientAsync(UserAccess access, long id, string requestId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadPatients(access))
            throw new ApplicationFault(403, "Нет доступа к карточкам пациентов");
        var parameters = AccessParameters(access);
        parameters["id"] = id;
        var entryTitle = """
            CASE me.entry_type
                WHEN 'examination' THEN 'Осмотр'
                WHEN 'progress' THEN 'Дневниковая запись'
                WHEN 'discharge' THEN 'Выписной эпикриз'
                WHEN 'correction' THEN 'Корректирующая запись'
                ELSE 'Медицинская запись'
            END
            """;
        var doctorHistorySql = $"""
            WITH allowed AS (SELECT c.id FROM project.medical_cases c WHERE c.patient_id = @id AND ({CareCaseSql}))
            SELECT me.id, 'record' AS type, {entryTitle} AS title, me.recorded_at AS "occurredAt",
                me.content AS description, me.case_id AS "caseId"
                FROM project.medical_record_entries me WHERE me.case_id IN (SELECT id FROM allowed)
            UNION ALL
            SELECT cd.id, 'diagnosis', d.code || ' — ' || d.name, cd.recorded_at, cd.note, cd.case_id
                FROM project.case_diagnoses cd JOIN project.diagnoses d ON d.id = cd.diagnosis_id WHERE cd.case_id IN (SELECT id FROM allowed)
            UNION ALL
            SELECT a.id, 'appointment', 'Приём врача', a.scheduled_at, a.status, a.case_id
                FROM project.appointments a WHERE a.case_id IN (SELECT id FROM allowed)
            UNION ALL
            SELECT result.id, 'lab', test.name, result.measured_at, result.result_text, lo.case_id
                FROM project.lab_results result JOIN project.lab_orders lo ON lo.id = result.order_id
                JOIN project.lab_test_types test ON test.id = lo.test_type_id WHERE lo.case_id IN (SELECT id FROM allowed)
            ORDER BY "occurredAt" DESC LIMIT 100
            """;
        // Больничные роли видят историю в пределах своей больницы: случаи, госпитализации
        // и медицинские записи её отделений. Область уже проверена доступом к пациенту.
        var hospitalHistorySql = $"""
            WITH hospital_cases AS (
                SELECT c.id FROM project.medical_cases c
                WHERE c.patient_id = @id AND c.organization_id = ANY(@hospital_orgs)
                UNION
                SELECT h.case_id FROM project.hospitalizations h
                JOIN project.departments hd ON hd.id = h.department_id
                JOIN project.buildings hb ON hb.id = hd.building_id
                WHERE h.patient_id = @id AND hb.hospital_id = ANY(@hospital_orgs)
            )
            SELECT me.id, 'record' AS type, {entryTitle} AS title, me.recorded_at AS "occurredAt",
                me.content AS description, me.case_id AS "caseId"
                FROM project.medical_record_entries me WHERE me.case_id IN (SELECT id FROM hospital_cases)
            UNION ALL
            SELECT cd.id, 'diagnosis', d.code || ' — ' || d.name, cd.recorded_at, cd.note, cd.case_id
                FROM project.case_diagnoses cd JOIN project.diagnoses d ON d.id = cd.diagnosis_id
                WHERE cd.case_id IN (SELECT id FROM hospital_cases)
            UNION ALL
            SELECT a.id, 'appointment', 'Приём врача', a.scheduled_at, a.status, a.case_id
                FROM project.appointments a WHERE a.case_id IN (SELECT id FROM hospital_cases)
            UNION ALL
            SELECT result.id, 'lab', test.name, result.measured_at, result.result_text, lo.case_id
                FROM project.lab_results result JOIN project.lab_orders lo ON lo.id = result.order_id
                JOIN project.lab_test_types test ON test.id = lo.test_type_id
                WHERE lo.case_id IN (SELECT id FROM hospital_cases)
            UNION ALL
            SELECT h.id, 'hospitalization', 'Госпитализация', h.admitted_at,
                coalesce(h.discharge_summary, dept.name), h.case_id
                FROM project.hospitalizations h
                JOIN project.departments dept ON dept.id = h.department_id
                WHERE h.patient_id = @id AND h.case_id IN (SELECT id FROM hospital_cases)
            ORDER BY "occurredAt" DESC LIMIT 100
            """;
        var registrarHistorySql = """
            SELECT c.id, 'case' AS type, 'Обращение в учреждение' AS title,
                c.opened_at AS "occurredAt", o.name AS description, c.id AS "caseId"
            FROM project.medical_cases c JOIN project.medical_organizations o ON o.id = c.organization_id
            WHERE c.patient_id = @id AND c.organization_id = ANY(@reg_orgs)
            ORDER BY c.opened_at DESC LIMIT 100
            """;
        var historySql = access.HasRole("doctor") ? doctorHistorySql
            : AccessPolicies.IsHospitalReader(access) ? hospitalHistorySql
            : registrarHistorySql;
        // Карточка, история и аудит уходят одним пакетом: один round-trip вместо
        // последовательных «карточка → история → журнал». INSERT пишет запись
        // только если пациент действительно доступен (то же условие области).
        parameters["audit_actor"] = access.UserId;
        parameters["audit_action"] = "read";
        parameters["audit_entity"] = "patient";
        parameters["audit_request"] = requestId;
        parameters["audit_outcome"] = "success";
        var batch = await BatchRowsAsync([
            PatientRowSql(" AND p.id = @id"),
            historySql,
            $"""
            INSERT INTO project.audit_logs(actor_user_id, action, entity_type, entity_id, request_id, outcome)
            SELECT @audit_actor, @audit_action, @audit_entity, @id, @audit_request, @audit_outcome
            WHERE EXISTS (SELECT 1 FROM project.patients p WHERE p.id = @id AND ({PatientAccessSql}))
            """
        ], parameters, cancellationToken);
        if (batch[0].Count == 0) throw new ApplicationFault(404, "Пациент не найден в доступной области");
        var patient = ToPatientRow(batch[0][0]);
        var history = batch[1].Select(r => new HistoryItem((long)r["id"]!, (string)r["type"]!,
            (string)r["title"]!, new DateTimeOffset((DateTime)r["occurredAt"]!), (string?)r["description"],
            r["caseId"] as long?)).ToArray();
        return new(patient, history);
    }

    // Случаи пациента для формы диагноза: только доступная область, открытые сверху,
    // затем по дате открытия. Форма карточки выбирает случай по умолчанию.
    public async Task<PatientCaseList> PatientCasesAsync(UserAccess access, long id, string requestId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadPatients(access))
            throw new ApplicationFault(403, "Нет доступа к карточкам пациентов");
        if (!await AccessiblePatients(access).AnyAsync(p => p.Id == id, cancellationToken))
            throw new ApplicationFault(404, "Пациент не найден в доступной области");
        var predicates = new List<string>();
        if (access.HasRole("registrar")) predicates.Add("c.organization_id = ANY(@reg_orgs)");
        if (access.HasRole("doctor")) predicates.Add($"({CareCaseSql})");
        if (AccessPolicies.IsHospitalReader(access))
            predicates.Add("""
                c.organization_id = ANY(@hospital_orgs)
                OR EXISTS (SELECT 1 FROM project.hospitalizations h
                    JOIN project.departments hd ON hd.id = h.department_id
                    JOIN project.buildings hb ON hb.id = hd.building_id
                    WHERE h.case_id = c.id AND hb.hospital_id = ANY(@hospital_orgs))
                """);
        var parameters = AccessParameters(access);
        parameters["id"] = id;
        var rows = await RowsAsync($"""
            SELECT c.id, c.organization_id AS "organizationId", o.name AS "organizationName",
                c.status::text AS status, c.opened_at AS "openedAt", c.closed_at AS "closedAt",
                (SELECT d.code || ' — ' || d.name FROM project.case_diagnoses cd
                    JOIN project.diagnoses d ON d.id = cd.diagnosis_id
                    WHERE cd.case_id = c.id
                    ORDER BY cd.is_primary DESC, cd.recorded_at DESC, cd.id DESC LIMIT 1) AS "primaryDiagnosis"
            FROM project.medical_cases c
            JOIN project.medical_organizations o ON o.id = c.organization_id
            WHERE c.patient_id = @id AND ({(predicates.Count == 0 ? "false" : string.Join(" OR ", predicates))})
            ORDER BY (c.status = 'open') DESC, c.opened_at DESC, c.id DESC
            LIMIT 100
            """, parameters, cancellationToken);
        var items = rows.Select(row => new PatientCaseRow((long)row["id"]!, (long)row["organizationId"]!,
            (string)row["organizationName"]!, (string)row["status"]!, AsDateTimeOffset(row["openedAt"]),
            row["closedAt"] is null ? null : AsDateTimeOffset(row["closedAt"]),
            row["primaryDiagnosis"] as string)).ToArray();
        await AuditAsync(access.UserId, "read", "patient_cases", id, "success", requestId, cancellationToken);
        return new PatientCaseList(items);
    }


    private static async Task SetAuditContext(NpgsqlConnection connection, NpgsqlTransaction transaction,
        UserAccess access, string requestId, CancellationToken cancellationToken)
    {
        await using var context = new NpgsqlCommand("SELECT set_config('medcore.actor_user_id', @actor, true), set_config('medcore.request_id', @request, true)", connection, transaction);
        AddParameters(context, new() { ["actor"] = access.UserId.ToString(System.Globalization.CultureInfo.InvariantCulture), ["request"] = requestId });
        await context.ExecuteNonQueryAsync(cancellationToken);
    }

    public async Task<long> RegisterPatientAsync(UserAccess access, RegisterPatientRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanRegisterPatient(access, request.PolyclinicId))
            throw new ApplicationFault(403, "Регистрация разрешена только в поликлинике вашей области доступа");
        if (request.BirthDate == default || request.BirthDate > DateOnly.FromDateTime(DateTime.UtcNow))
            throw new ApplicationFault(400, "Некорректная дата рождения");
        if (!await db.Organizations.AnyAsync(o => o.Id == request.PolyclinicId && o.OrganizationType == "polyclinic" && o.IsActive, cancellationToken))
            throw new ApplicationFault(400, "Выбранная поликлиника недоступна");
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        await using var command = new NpgsqlCommand("""
            CALL project.sp_register_patient(@last, @first, @middle, @birth, @sex, @phone, @email, @address, @patient)
            """, connection, transaction);
        AddParameters(command, new()
        {
            ["last"] = request.LastName, ["first"] = request.FirstName, ["middle"] = request.MiddleName,
            ["birth"] = request.BirthDate, ["sex"] = request.Sex, ["phone"] = request.Phone,
            ["email"] = request.Email, ["address"] = request.Address
        });
        command.Parameters.AddWithValue("patient", NpgsqlDbType.Bigint, DBNull.Value);
        var id = Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
        await using var attachment = new NpgsqlCommand("""
            INSERT INTO project.patient_attachments(patient_id, polyclinic_id, started_at)
            VALUES (@patient, @polyclinic, CURRENT_TIMESTAMP)
            """, connection, transaction);
        AddParameters(attachment, new() { ["patient"] = id, ["polyclinic"] = request.PolyclinicId });
        await attachment.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return id;
    }

    public async Task UpdatePatientAsync(UserAccess access, long id, UpdatePatientRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanEditPatientContacts(access)) throw new ApplicationFault(403, "Изменение контактов доступно регистратору");
        var parameters = AccessParameters(access);
        parameters["id"] = id;
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        // The lock keeps the patient/version stable until the stored procedure updates it.
        await using (var allowed = new NpgsqlCommand($"SELECT p.id FROM project.patients p WHERE p.id = @id AND ({RegistrarPatientSql}) FOR UPDATE", connection, transaction))
        {
            AddParameters(allowed, parameters);
            if (await allowed.ExecuteScalarAsync(cancellationToken) is null)
                throw new ApplicationFault(404, "Пациент не найден в доступной области");
        }
        await using var command = new NpgsqlCommand("CALL project.sp_update_patient(@id, @version, @phone, @email, @address)", connection, transaction);
        AddParameters(command, new() { ["id"] = id, ["version"] = request.Version,
            ["phone"] = request.Phone, ["email"] = request.Email, ["address"] = request.Address });
        await command.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
    }

    public async Task<long> AddDiagnosisAsync(UserAccess access, long patientId, AddDiagnosisRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanEditDiagnosis(access, true)) throw new ApplicationFault(403, "Медицинские диагнозы изменяет только врач");
        var parameters = AccessParameters(access);
        parameters["case"] = request.CaseId;
        parameters["patient"] = patientId;
        var relationship = await RowsAsync($"SELECT c.id FROM project.medical_cases c WHERE c.id = @case AND c.patient_id = @patient AND ({CareCaseSql})", parameters, cancellationToken);
        if (!AccessPolicies.CanEditDiagnosis(access, relationship.Count == 1))
            throw new ApplicationFault(404, "Медицинский случай не найден в доступной области");
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await using var command = new NpgsqlCommand("""
            INSERT INTO project.case_diagnoses(case_id, diagnosis_id, doctor_id, note, is_primary)
            VALUES (@case, @diagnosis, @doctor, @note, @primary) RETURNING id
            """, connection, transaction);
        AddParameters(command, new() { ["case"] = request.CaseId, ["diagnosis"] = request.DiagnosisId,
            ["doctor"] = access.EmployeeId!.Value, ["note"] = request.Note, ["primary"] = request.IsPrimary });
        var id = Convert.ToInt64(await command.ExecuteScalarAsync(cancellationToken));
        await using var audit = new NpgsqlCommand("""
            INSERT INTO project.audit_logs(actor_user_id, action, entity_type, entity_id, request_id, outcome)
            VALUES (@actor, 'insert', 'case_diagnosis', @id, @request, 'success')
            """, connection, transaction);
        AddParameters(audit, new() { ["actor"] = access.UserId, ["id"] = id, ["request"] = requestId });
        await audit.ExecuteNonQueryAsync(cancellationToken);
        await transaction.CommitAsync(cancellationToken);
        return id;
    }
}
