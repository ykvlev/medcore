using System.Data;
using Medcore.Application;
using Npgsql;

namespace Medcore.Infrastructure;

// Направления к специалистам (миграция 007): реестр и карточка пациента, оформление
// с подбором случая и смена статуса. Схема 001 допускает только амбулаторный и
// стационарный тип случая, поэтому случай для консультации создаётся как outpatient
// с причиной, в которой указан вид направления.
public sealed partial class MedcoreStore
{
    private static readonly string[] ReferralTypes = ["hospitalization", "consultation", "diagnostic"];

    private static readonly string[] ReferralStatuses =
        ["issued", "used", "cancelled", "scheduled", "completed"];

    private const string ReferralSelectSql = """
        SELECT r.id, p.id AS "patientId",
            concat_ws(' ', p.last_name, p.first_name, p.middle_name) AS "patientName",
            r.referral_type AS "referralType",
            hospital.id AS "hospitalId", hospital.name AS "hospitalName",
            specialization.id AS "specializationId", specialization.name AS "specializationName",
            r.target_doctor_id AS "doctorId",
            nullif(concat_ws(' ', doctor.last_name, doctor.first_name, doctor.middle_name), '') AS "doctorName",
            r.status, r.issued_at AS "issuedAt", r.valid_until AS "validUntil", r.reason,
            concat_ws(' ', referring.last_name, referring.first_name, referring.middle_name)
                AS "referringDoctorName"
        """;

    private const string ReferralFromSql = """
        FROM project.referrals r
        JOIN project.medical_cases c ON c.id = r.case_id
        JOIN project.patients p ON p.id = c.patient_id
        JOIN project.medical_organizations hospital ON hospital.id = r.target_hospital_id
        JOIN project.department_specializations specialization ON specialization.id = r.specialization_id
        JOIN project.employees referring ON referring.id = r.referring_doctor_id
        LEFT JOIN project.employees doctor ON doctor.id = r.target_doctor_id
        """;

    // Область реестра и смены статуса: организация регистратора, больница больничных ролей,
    // больница назначения и случаи врача.
    private static readonly string ReferralReadPredicate =
        $"(c.organization_id = ANY(@referral_orgs) OR r.target_hospital_id = ANY(@referral_orgs)"
        + $" OR ({CareCaseSql}))";

    private static DateOnly ReferralToday() =>
        DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(3)).DateTime);

    // Случай доступен регистратору в его организации, врачу — по своим случаям,
    // больничным ролям — в области своей больницы, включая случаи её госпитализаций
    // (то же правило, что в карточке пациента).
    private static string ReferralCasePredicate(UserAccess access)
    {
        var clauses = new List<string>();
        if (access.HasRole("registrar")) clauses.Add("c.organization_id = ANY(@reg_orgs)");
        if (access.HasRole("doctor") && access.EmployeeId.HasValue) clauses.Add($"({CareCaseSql})");
        if (AccessPolicies.IsHospitalReader(access))
            clauses.Add("""
                (c.organization_id = ANY(@hospital_orgs)
                 OR EXISTS (SELECT 1 FROM project.hospitalizations h
                     JOIN project.departments hd ON hd.id = h.department_id
                     JOIN project.buildings hb ON hb.id = hd.building_id
                     WHERE h.case_id = c.id AND hb.hospital_id = ANY(@hospital_orgs)))
                """);
        if (clauses.Count == 0)
            throw new ApplicationFault(403, "Оформление направления недоступно вашей роли");
        return string.Join(" OR ", clauses);
    }

    private static long[] ReferralCaseOrganizations(UserAccess access)
    {
        var organizations = new List<long>();
        if (access.HasRole("registrar")) organizations.AddRange(access.OrganizationIdsFor("registrar"));
        if (access.HasRole("doctor")) organizations.AddRange(access.OrganizationIdsFor("doctor"));
        if (AccessPolicies.IsHospitalReader(access))
            organizations.AddRange(AccessPolicies.HospitalReadOrganizationIds(access));
        return organizations.Distinct().ToArray();
    }

    private static ReferralRow ToReferralRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (long)row["patientId"]!, (string)row["patientName"]!,
        (string)row["referralType"]!, (long)row["hospitalId"]!, (string)row["hospitalName"]!,
        (long)row["specializationId"]!, (string)row["specializationName"]!,
        (long?)row["doctorId"], row["doctorName"] as string, (string)row["status"]!,
        HospitalTimestamp(row["issuedAt"]!),
        row["validUntil"] is null ? null : HospitalDate(row["validUntil"]),
        (string)row["reason"]!, (string)row["referringDoctorName"]!);

    // ---------- Чтение ----------

    // Направления пациента по всем его случаям: доступ к пациенту уже подтверждён,
    // поэтому история направлений не урезается организацией читающего.
    public async Task<ReferralList> PatientReferralsAsync(UserAccess access, long patientId, string requestId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadPatients(access))
            throw new ApplicationFault(403, "Нет доступа к направлениям пациента");
        var parameters = AccessParameters(access);
        parameters["patient"] = patientId;
        if (await RowsAsync($"SELECT p.id FROM project.patients p WHERE p.id = @patient AND ({PatientAccessSql})",
                parameters, cancellationToken) is { Count: 0 })
            throw new ApplicationFault(404, "Пациент не найден в доступной области");
        var rows = await RowsAsync($"""
            {ReferralSelectSql}
            {ReferralFromSql}
            WHERE c.patient_id = @patient
            ORDER BY r.issued_at DESC, r.id DESC
            LIMIT 200
            """, parameters, cancellationToken);
        await AuditAsync(access.UserId, "read", "referrals", patientId, "success", requestId, cancellationToken);
        return new(rows.Select(ToReferralRow).ToArray());
    }

    public async Task<PageResult<ReferralRow>> ReferralsPageAsync(UserAccess access, string? status, long? patientId,
        int page, int pageSize, CancellationToken cancellationToken)
    {
        if (page < 1 || pageSize is < 1 or > 100 || (long)(page - 1) * pageSize > int.MaxValue)
            throw new ApplicationFault(400, "Некорректные параметры страницы");
        var normalizedStatus = string.IsNullOrWhiteSpace(status) ? null : status.Trim().ToLowerInvariant();
        if (normalizedStatus is not null && Array.IndexOf(ReferralStatuses, normalizedStatus) < 0)
            throw new ApplicationFault(422,
                "Статус направления: issued, used, scheduled, completed или cancelled");
        var parameters = AccessParameters(access);
        parameters["status"] = normalizedStatus;
        parameters["patient"] = patientId ?? 0L;
        string where;
        if (patientId is > 0)
        {
            // ?patientId= повторяет карточку пациента: доступ проверяется по пациенту.
            if (!AccessPolicies.CanReadPatients(access))
                throw new ApplicationFault(403, "Нет доступа к направлениям пациента");
            if (await RowsAsync($"SELECT p.id FROM project.patients p WHERE p.id = @patient AND ({PatientAccessSql})",
                    parameters, cancellationToken) is { Count: 0 })
                throw new ApplicationFault(404, "Пациент не найден в доступной области");
            where = """
                WHERE c.patient_id = @patient
                  AND (@status IS NULL OR r.status = @status)
                """;
        }
        else
        {
            if (!AccessPolicies.CanReadReferrals(access))
                throw new ApplicationFault(403, "Нет доступа к реестру направлений");
            parameters["referral_orgs"] = AccessPolicies.ReferralOrganizationIds(access);
            where = $"""
                WHERE {ReferralReadPredicate}
                  AND (@status IS NULL OR r.status = @status)
                """;
        }
        var total = (long)(await RowsAsync($"SELECT count(*)::bigint AS total {ReferralFromSql} {where}",
            parameters, cancellationToken))[0]["total"]!;
        parameters["limit"] = pageSize;
        parameters["offset"] = (page - 1) * pageSize;
        var rows = await RowsAsync($"""
            {ReferralSelectSql}
            {ReferralFromSql}
            {where}
            ORDER BY r.issued_at DESC, r.id DESC
            LIMIT @limit OFFSET @offset
            """, parameters, cancellationToken);
        return new(rows.Select(ToReferralRow).ToArray(), (int)total, page, pageSize);
    }

    // ---------- Оформление ----------

    public async Task<long> CreateReferralAsync(UserAccess access, CreateReferralRequest request, string requestId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanCreateReferral(access))
            throw new ApplicationFault(403,
                "Направление оформляет врач, регистратор или управленческая роль больницы");
        var patientId = request.PatientId;
        if (patientId <= 0) throw new ApplicationFault(422, "Укажите пациента");
        // hospitalId и targetHospitalId — одно и то же значение под двумя именами.
        var hospitalId = request.TargetHospitalId ?? request.HospitalId ?? 0;
        if (hospitalId <= 0) throw new ApplicationFault(422, "Укажите больницу назначения");
        if (request.SpecializationId is not > 0) throw new ApplicationFault(422, "Укажите специализацию");
        var reason = (request.Reason ?? request.Note)?.Trim();
        if (string.IsNullOrEmpty(reason)) throw new ApplicationFault(422, "Укажите причину направления");
        if (reason.Length > 2000) throw new ApplicationFault(422, "Причина направления длиннее 2000 символов");
        var referralType = string.IsNullOrWhiteSpace(request.ReferralType)
            ? "hospitalization"
            : request.ReferralType.Trim().ToLowerInvariant();
        if (Array.IndexOf(ReferralTypes, referralType) < 0)
            throw new ApplicationFault(422, "Тип направления: hospitalization, consultation или diagnostic");
        if (request.ValidUntil is { } validUntil && validUntil < ReferralToday())
            throw new ApplicationFault(422, "Срок действия не может быть раньше даты выдачи");
        // targetDoctorId и doctorId — одно и то же значение под двумя именами.
        var targetDoctorId = request.TargetDoctorId ?? request.DoctorId ?? 0;

        var parameters = AccessParameters(access);
        parameters["patient"] = patientId;
        parameters["hospital"] = hospitalId;
        parameters["specialization"] = request.SpecializationId!.Value;
        parameters["target_doctor"] = targetDoctorId;
        parameters["case_orgs"] = ReferralCaseOrganizations(access);

        // Справочные проверки и членство врача уходят одним пакетом.
        var lookups = await BatchRowsAsync([
            """
            SELECT h.organization_id AS id FROM project.hospitals h
            JOIN project.medical_organizations o ON o.id = h.organization_id
            WHERE h.organization_id = @hospital AND o.is_active
            """,
            "SELECT id FROM project.department_specializations WHERE id = @specialization",
            """
            SELECT d.employee_id AS id FROM project.doctors d
            JOIN project.employees e ON e.id = d.employee_id
            WHERE d.employee_id = @target_doctor AND e.is_active
            """,
            "SELECT d.employee_id AS id FROM project.doctors d WHERE d.employee_id = @employee"
        ], parameters, cancellationToken);
        if (lookups[0].Count == 0)
            throw new ApplicationFault(404, "Больница назначения не найдена или неактивна");
        if (lookups[1].Count == 0) throw new ApplicationFault(404, "Специализация направления не найдена");
        if (targetDoctorId > 0 && lookups[2].Count == 0)
            throw new ApplicationFault(404, "Целевой врач не найден или неактивен");
        var isDoctor = access.HasRole("doctor") && access.EmployeeId.HasValue;
        if (isDoctor && lookups[3].Count == 0)
            throw new ApplicationFault(403, "Учётная запись врача не связана со справочником врачей");

        var casePredicate = ReferralCasePredicate(access);
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            long caseId;
            long caseOrganizationId;
            if (request.CaseId is > 0)
            {
                parameters["case"] = request.CaseId.Value;
                var cases = await TxRowsAsync(connection, transaction, $"""
                    SELECT c.id, c.patient_id AS "patientId", c.organization_id AS "organizationId", c.status
                    FROM project.medical_cases c
                    WHERE c.id = @case AND ({casePredicate})
                    FOR UPDATE OF c
                    """, parameters, cancellationToken);
                if (cases.Count == 0)
                    throw new ApplicationFault(404, "Медицинский случай не найден в доступной области");
                if ((long)cases[0]["patientId"]! != patientId)
                    throw new ApplicationFault(409, "Случай относится к другому пациенту");
                if ((string)cases[0]["status"]! == "cancelled")
                    throw new ApplicationFault(409, "По отменённому случаю направление не оформляется");
                caseId = (long)cases[0]["id"]!;
                caseOrganizationId = (long)cases[0]["organizationId"]!;
            }
            else
            {
                if (await TxRowsAsync(connection, transaction,
                        $"SELECT p.id FROM project.patients p WHERE p.id = @patient AND ({PatientAccessSql})",
                        parameters, cancellationToken) is { Count: 0 })
                    throw new ApplicationFault(404, "Пациент не найден в доступной области");
                var open = await TxRowsAsync(connection, transaction, $"""
                    SELECT c.id, c.organization_id AS "organizationId"
                    FROM project.medical_cases c
                    WHERE c.patient_id = @patient AND c.status = 'open' AND ({casePredicate})
                    ORDER BY c.opened_at DESC, c.id DESC
                    LIMIT 1
                    """, parameters, cancellationToken);
                if (open.Count == 1)
                {
                    caseId = (long)open[0]["id"]!;
                    caseOrganizationId = (long)open[0]["organizationId"]!;
                }
                else
                {
                    // Организация случая: прикрепление пациента в области пользователя,
                    // иначе первая активная организация области.
                    var attachments = await TxRowsAsync(connection, transaction, """
                        SELECT pa.polyclinic_id AS id
                        FROM project.patient_attachments pa
                        WHERE pa.patient_id = @patient AND pa.polyclinic_id = ANY(@case_orgs)
                          AND pa.started_at <= CURRENT_TIMESTAMP
                          AND (pa.ended_at IS NULL OR pa.ended_at > CURRENT_TIMESTAMP)
                        ORDER BY pa.started_at DESC, pa.id DESC
                        LIMIT 1
                        """, parameters, cancellationToken);
                    if (attachments.Count == 1)
                    {
                        caseOrganizationId = (long)attachments[0]["id"]!;
                    }
                    else
                    {
                        var fallback = await TxRowsAsync(connection, transaction, """
                            SELECT o.id FROM project.medical_organizations o
                            WHERE o.id = ANY(@case_orgs) AND o.is_active
                            ORDER BY o.id
                            LIMIT 1
                            """, parameters, cancellationToken);
                        if (fallback.Count == 0)
                            throw new ApplicationFault(409,
                                "Не удалось определить организацию для случая пациента");
                        caseOrganizationId = (long)fallback[0]["id"]!;
                    }
                    parameters["case_org"] = caseOrganizationId;
                    parameters["case_reason"] = referralType switch
                    {
                        "consultation" => "Направление на консультацию специалиста",
                        "diagnostic" => "Направление на диагностическое исследование",
                        _ => "Направление на госпитализацию"
                    };
                    caseId = await TxScalarAsync(connection, transaction, """
                        INSERT INTO project.medical_cases(patient_id, organization_id, case_type, status,
                            opened_at, reason)
                        VALUES (@patient, @case_org, 'outpatient', 'open', CURRENT_TIMESTAMP, @case_reason)
                        RETURNING id
                        """, parameters, cancellationToken);
                }
            }

            parameters["case"] = caseId;
            parameters["case_org"] = caseOrganizationId;
            parameters["referring"] = await ResolveReferralDoctorAsync(connection, transaction, access,
                parameters, targetDoctorId, cancellationToken);
            parameters["reason"] = reason;
            parameters["type"] = referralType;
            parameters["valid_until"] = request.ValidUntil;
            parameters["target_doctor"] = targetDoctorId > 0 ? targetDoctorId : null;
            var id = await TxScalarAsync(connection, transaction, """
                INSERT INTO project.referrals(case_id, referring_doctor_id, target_hospital_id, specialization_id,
                    issued_at, reason, status, referral_type, target_doctor_id, valid_until)
                VALUES (@case, @referring, @hospital, @specialization, CURRENT_TIMESTAMP, @reason, 'issued',
                    @type, @target_doctor::bigint, @valid_until::date)
                RETURNING id
                """, parameters, cancellationToken);
            await HospitalAuditAsync(connection, transaction, access.UserId, "insert", "referral", id, requestId,
                ["case_id", "target_hospital_id", "specialization_id", "referral_type"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // referring_doctor_id обязателен по схеме: врач оформляет от своего имени, а для
    // регистратора и больничных ролей берётся врач, лечивший пациента в этой организации;
    // если истории нет — целевой врач из запроса.
    private static async Task<long> ResolveReferralDoctorAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, UserAccess access, Dictionary<string, object?> parameters,
        long targetDoctorId, CancellationToken cancellationToken)
    {
        if (access.HasRole("doctor") && access.EmployeeId.HasValue) return access.EmployeeId.Value;
        var related = await TxRowsAsync(connection, transaction, """
            SELECT related.doctor_id AS "doctorId", max(related.at) AS "lastAt"
            FROM (
                SELECT cd.doctor_id, cd.recorded_at AS at
                FROM project.case_diagnoses cd
                JOIN project.medical_cases c ON c.id = cd.case_id
                WHERE c.patient_id = @patient AND c.organization_id = @case_org
                UNION ALL
                SELECT me.doctor_id, me.recorded_at
                FROM project.medical_record_entries me
                JOIN project.medical_cases c ON c.id = me.case_id
                WHERE c.patient_id = @patient AND c.organization_id = @case_org
                UNION ALL
                SELECT ad.doctor_id, a.scheduled_at
                FROM project.appointments a
                JOIN project.appointment_doctors ad ON ad.appointment_id = a.id
                JOIN project.medical_cases c ON c.id = a.case_id
                WHERE c.patient_id = @patient AND c.organization_id = @case_org
                UNION ALL
                SELECT r.referring_doctor_id, r.issued_at
                FROM project.referrals r
                JOIN project.medical_cases c ON c.id = r.case_id
                WHERE c.patient_id = @patient AND c.organization_id = @case_org
            ) related
            GROUP BY related.doctor_id
            ORDER BY "lastAt" DESC, related.doctor_id DESC
            LIMIT 1
            """, parameters, cancellationToken);
        if (related.Count == 1) return (long)related[0]["doctorId"]!;
        if (targetDoctorId > 0) return targetDoctorId;
        throw new ApplicationFault(409,
            "Укажите целевого врача: в истории пациента нет врача этой организации, чтобы указать направившего");
    }

    // ---------- Статус ----------

    public async Task ChangeReferralStatusAsync(UserAccess access, long id, ReferralStatusRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanChangeReferralStatus(access))
            throw new ApplicationFault(403, "Смена статуса направления недоступна вашей роли");
        var status = (request.Status ?? string.Empty).Trim().ToLowerInvariant();
        if (status is not ("scheduled" or "completed" or "cancelled"))
            throw new ApplicationFault(422, "Статус направления: scheduled, completed или cancelled");
        var parameters = AccessParameters(access);
        parameters["id"] = id;
        parameters["referral_orgs"] = AccessPolicies.ReferralOrganizationIds(access);
        parameters["status"] = status;
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var rows = await TxRowsAsync(connection, transaction, $"""
                SELECT r.id, r.status FROM project.referrals r
                JOIN project.medical_cases c ON c.id = r.case_id
                WHERE r.id = @id AND ({ReferralReadPredicate})
                FOR UPDATE OF r
                """, parameters, cancellationToken);
            if (rows.Count == 0) throw new ApplicationFault(404, "Направление не найдено в доступной области");
            var current = (string)rows[0]["status"]!;
            var allowed = current switch
            {
                "issued" => status is "scheduled" or "completed" or "cancelled",
                "scheduled" => status is "completed" or "cancelled",
                _ => false
            };
            if (!allowed)
                throw new ApplicationFault(409, current switch
                {
                    "scheduled" => "Направление уже запланировано",
                    "completed" => "Направление уже выполнено",
                    "cancelled" => "Направление уже отменено",
                    "used" => "Направление уже использовано для госпитализации",
                    _ => "Направление в состоянии, не допускающем смену статуса"
                });
            parameters["current"] = current;
            if (await TxExecuteAsync(connection, transaction,
                    "UPDATE project.referrals SET status = @status WHERE id = @id AND status = @current",
                    parameters, cancellationToken) == 0)
                throw new ApplicationFault(409, "Направление уже изменено другим пользователем");
            await HospitalAuditAsync(connection, transaction, access.UserId, "referral_status", "referral", id,
                requestId, ["status"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }
}
