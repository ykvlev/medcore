using System.Data;
using System.Globalization;
using Medcore.Application;
using Npgsql;

namespace Medcore.Infrastructure;

// Расписание приёма и талоны (миграция 008): реестр талонов и записей в области
// организаций пользователя, запись на свободный талон, смена статуса записи и
// управление расписанием врача. Время хранится в timestamptz, а расписание задаётся
// местными датой и временем Europe/Moscow, поэтому границы периода и начала талонов
// переводятся в timestamptz на сервере.
public sealed partial class MedcoreStore
{
    private static readonly string[] AppointmentStatuses = ["booked", "completed", "cancelled"];

    // Специальность врача: основная из doctor_specialties (первая по certified_on).
    // Схема не связывает врача с отделением напрямую, поэтому запасной вариант —
    // профиль отделения, в котором врач вёл госпитализации (attending_physician_history).
    private const string SlotSpecializationJoins = """
        LEFT JOIN LATERAL (
            SELECT sp.id, sp.name
            FROM project.doctor_specialties dsp
            JOIN project.specialties sp ON sp.id = dsp.specialty_id
            WHERE dsp.doctor_id = s.doctor_id
            ORDER BY dsp.certified_on DESC, sp.id
            LIMIT 1) spec ON true
        LEFT JOIN LATERAL (
            SELECT ds.id, ds.name
            FROM project.hospitalizations h
            JOIN project.departments dep ON dep.id = h.department_id
            JOIN project.department_specializations ds ON ds.id = dep.specialization_id
            WHERE EXISTS (SELECT 1 FROM project.attending_physician_history ah
                WHERE ah.hospitalization_id = h.id AND ah.doctor_id = s.doctor_id)
            ORDER BY h.admitted_at DESC, h.id DESC
            LIMIT 1) dept_spec ON true
        """;

    private const string SlotFromSql = """
        FROM project.appointment_slots s
        JOIN project.doctors d ON d.employee_id = s.doctor_id
        JOIN project.employees e ON e.id = d.employee_id
        JOIN project.medical_organizations organization ON organization.id = s.organization_id
        JOIN project.doctor_schedules schedule ON schedule.id = s.schedule_id
        """ + "\n" + SlotSpecializationJoins;

    private const string SlotSelectSql = """
        SELECT s.id, s.doctor_id AS "doctorId",
            concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS "doctorName",
            coalesce(spec.id, dept_spec.id) AS "specializationId",
            coalesce(spec.name, dept_spec.name) AS "specializationName",
            s.organization_id AS "organizationId", organization.name AS "organizationName",
            s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.status, schedule.cabinet
        """;

    private const string AppointmentFromSql = SlotFromSql + "\n" + """
        JOIN project.patients p ON p.id = s.patient_id
        """;

    private const string AppointmentSelectSql = """
        SELECT s.id, s.starts_at AS "startsAt", s.ends_at AS "endsAt", s.status,
            s.patient_id AS "patientId",
            concat_ws(' ', p.last_name, p.first_name, p.middle_name) AS "patientName",
            s.doctor_id AS "doctorId",
            concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS "doctorName",
            coalesce(spec.name, dept_spec.name) AS "specializationName",
            s.organization_id AS "organizationId", organization.name AS "organizationName",
            schedule.cabinet
        """;

    // Пациент доступен пользователю, если он доступен по общим правилам либо
    // прикреплён к поликлинике (или больнице) области приёма или имеет там открытый
    // случай: администратор организации не читает карточки, но записать пациента может.
    // Свойство, а не поле: PatientAccessSql объявлен в другом файле частичного класса,
    // и порядок инициализации статических полей между файлами не гарантирован.
    private static string AppointmentPatientSql => $"""
        (({PatientAccessSql})
         OR EXISTS (SELECT 1 FROM project.patient_attachments pa
             WHERE pa.patient_id = p.id AND pa.started_at <= CURRENT_TIMESTAMP
               AND (pa.ended_at IS NULL OR pa.ended_at > CURRENT_TIMESTAMP)
               AND (pa.polyclinic_id = ANY(@appointment_orgs)
                    OR EXISTS (SELECT 1 FROM project.polyclinics pc
                        WHERE pc.organization_id = pa.polyclinic_id
                          AND pc.hospital_id = ANY(@appointment_orgs))))
         OR EXISTS (SELECT 1 FROM project.medical_cases mc
             WHERE mc.patient_id = p.id AND mc.organization_id = ANY(@appointment_orgs)
               AND mc.status = 'open'))
        """;

    private const string ScheduleFromSql = """
        FROM project.doctor_schedules schedule
        JOIN project.doctors d ON d.employee_id = schedule.doctor_id
        JOIN project.employees e ON e.id = d.employee_id
        JOIN project.medical_organizations organization ON organization.id = schedule.organization_id
        """;

    private const string ScheduleSelectSql = """
        SELECT schedule.id, schedule.doctor_id AS "doctorId",
            concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS "doctorName",
            schedule.organization_id AS "organizationId", organization.name AS "organizationName",
            schedule.work_date AS "workDate", schedule.start_time AS "startTime",
            schedule.end_time AS "endTime", schedule.slot_minutes AS "slotMinutes", schedule.cabinet,
            schedule.is_active AS "isActive",
            (SELECT count(*)::int FROM project.appointment_slots slot
                WHERE slot.schedule_id = schedule.id) AS "slotsTotal",
            (SELECT count(*)::int FROM project.appointment_slots slot
                WHERE slot.schedule_id = schedule.id AND slot.status = 'free') AS "slotsFree"
        """;

    // Дата по умолчанию — сегодня по Москве; существующие рефералы считают её так же.
    private static DateOnly AppointmentToday() =>
        DateOnly.FromDateTime(DateTimeOffset.UtcNow.ToOffset(TimeSpan.FromHours(3)).DateTime);

    private static (DateOnly From, DateOnly To) AppointmentPeriod(DateOnly? dateFrom, DateOnly? dateTo)
    {
        var from = dateFrom ?? AppointmentToday();
        var to = dateTo ?? from.AddDays(7);
        if (to < from) throw new ApplicationFault(422, "Конец периода раньше начала");
        if (to.DayNumber - from.DayNumber > 366) throw new ApplicationFault(422, "Период длиннее года");
        return (from, to);
    }

    private static TimeOnly AppointmentClock(string? value, string field)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new ApplicationFault(422, $"Укажите время {field}");
        var text = value.Trim();
        foreach (var format in new[] { "HH:mm", "HH:mm:ss", "H:mm" })
            if (TimeOnly.TryParseExact(text, format, CultureInfo.InvariantCulture, DateTimeStyles.None, out var time))
                return time;
        throw new ApplicationFault(422, $"Время {field} указывается как ЧЧ:ММ");
    }

    private static string AppointmentTimeText(object? value) => value switch
    {
        TimeOnly time => time.ToString("HH:mm", CultureInfo.InvariantCulture),
        TimeSpan span => new TimeOnly(span.Hours, span.Minutes).ToString("HH:mm", CultureInfo.InvariantCulture),
        string text when text.Length >= 5 => text[..5],
        _ => throw new InvalidOperationException("Ожидалось время приёма")
    };

    private static SlotRow ToSlotRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (long)row["doctorId"]!, (string)row["doctorName"]!,
        row["specializationId"] is null ? null : (long)row["specializationId"]!,
        row["specializationName"] as string, (long)row["organizationId"]!,
        (string)row["organizationName"]!, HospitalTimestamp(row["startsAt"]!),
        HospitalTimestamp(row["endsAt"]!), (string)row["status"]!, row["cabinet"] as string);

    private static AppointmentRow ToAppointmentRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, HospitalTimestamp(row["startsAt"]!), HospitalTimestamp(row["endsAt"]!),
        (string)row["status"]!, (long)row["patientId"]!, (string)row["patientName"]!,
        (long)row["doctorId"]!, (string)row["doctorName"]!, row["specializationName"] as string,
        (long)row["organizationId"]!, (string)row["organizationName"]!, row["cabinet"] as string);

    private static ScheduleRow ToScheduleRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (long)row["doctorId"]!, (string)row["doctorName"]!, (long)row["organizationId"]!,
        (string)row["organizationName"]!, HospitalDate(row["workDate"]!),
        AppointmentTimeText(row["startTime"]!), AppointmentTimeText(row["endTime"]!),
        (int)row["slotMinutes"]!, row["cabinet"] as string, (bool)row["isActive"]!,
        (int)row["slotsTotal"]!, (int)row["slotsFree"]!);

    // ---------- Талоны ----------

    public Task<SlotList> SlotsAsync(UserAccess access, DateOnly? dateFrom, DateOnly? dateTo, long? organizationId,
        long? specializationId, long? doctorId, bool onlyFree, CancellationToken cancellationToken) =>
        SlotsCoreAsync(access, dateFrom, dateTo, organizationId, specializationId, doctorId, onlyFree, false,
            cancellationToken);

    // Карточка врача: тот же список, но врач задан путём и обязан существовать.
    public Task<SlotList> DoctorSlotsAsync(UserAccess access, long doctorId, DateOnly? dateFrom, DateOnly? dateTo,
        CancellationToken cancellationToken) =>
        SlotsCoreAsync(access, dateFrom, dateTo, null, null, doctorId, false, true, cancellationToken);

    private async Task<SlotList> SlotsCoreAsync(UserAccess access, DateOnly? dateFrom, DateOnly? dateTo,
        long? organizationId, long? specializationId, long? doctorId, bool onlyFree, bool requireDoctor,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadSlots(access))
            throw new ApplicationFault(403, "Нет доступа к талонам приёма");
        var (from, to) = AppointmentPeriod(dateFrom, dateTo);
        var organizations = AccessPolicies.AppointmentOrganizationIds(access);
        if (organizationId is > 0 && !organizations.Contains(organizationId.Value))
            throw new ApplicationFault(403, "Организация вне вашей области приёма");
        var parameters = AccessParameters(access);
        parameters["appointment_orgs"] = organizations;
        parameters["date_from"] = from;
        parameters["date_to"] = to;
        parameters["organization"] = organizationId is > 0 ? organizationId.Value : null;
        parameters["specialization"] = specializationId is > 0 ? specializationId.Value : null;
        parameters["doctor"] = doctorId is > 0 ? doctorId.Value : null;
        parameters["only_free"] = onlyFree;
        parameters["limit"] = 1000;
        if (requireDoctor)
        {
            parameters["doctor"] = doctorId;
            if (await RowsAsync(
                    "SELECT d.employee_id AS id FROM project.doctors d WHERE d.employee_id = @doctor::bigint",
                    parameters, cancellationToken) is { Count: 0 })
                throw new ApplicationFault(404, "Врач не найден");
        }
        var rows = await RowsAsync($"""
            {SlotSelectSql}
            {SlotFromSql}
            WHERE s.organization_id = ANY(@appointment_orgs)
              AND s.starts_at >= (@date_from::date::timestamp AT TIME ZONE 'Europe/Moscow')
              AND s.starts_at < ((@date_to::date + 1)::timestamp AT TIME ZONE 'Europe/Moscow')
              AND (@organization::bigint IS NULL OR s.organization_id = @organization::bigint)
              AND (@specialization::bigint IS NULL
                   OR coalesce(spec.id, dept_spec.id) = @specialization::bigint)
              AND (@doctor::bigint IS NULL OR s.doctor_id = @doctor::bigint)
              AND (NOT @only_free OR s.status = 'free')
            ORDER BY s.starts_at, s.doctor_id, s.id
            LIMIT @limit
            """, parameters, cancellationToken);
        return new(rows.Select(ToSlotRow).ToArray());
    }

    // ---------- Записи ----------

    public async Task<AppointmentList> AppointmentsAsync(UserAccess access, DateOnly? date, string? status,
        long? patientId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadAppointments(access))
            throw new ApplicationFault(403, "Нет доступа к записям на приём");
        var normalizedStatus = string.IsNullOrWhiteSpace(status) ? null : status.Trim().ToLowerInvariant();
        if (normalizedStatus is not null && Array.IndexOf(AppointmentStatuses, normalizedStatus) < 0)
            throw new ApplicationFault(422, "Статус записи: booked, completed или cancelled");
        var parameters = AccessParameters(access);
        parameters["appointment_orgs"] = AccessPolicies.AppointmentOrganizationIds(access);
        parameters["appointment_date"] = date;
        parameters["status"] = normalizedStatus;
        parameters["patient"] = patientId is > 0 ? patientId.Value : null;
        parameters["limit"] = 500;
        var rows = await RowsAsync($"""
            {AppointmentSelectSql}
            {AppointmentFromSql}
            WHERE s.organization_id = ANY(@appointment_orgs)
              AND s.status <> 'free'
              AND (@appointment_date::date IS NULL
                   OR (s.starts_at AT TIME ZONE 'Europe/Moscow')::date = @appointment_date::date)
              AND (@status IS NULL OR s.status = @status)
              AND (@patient::bigint IS NULL OR s.patient_id = @patient::bigint)
            ORDER BY s.starts_at DESC, s.id DESC
            LIMIT @limit
            """, parameters, cancellationToken);
        return new(rows.Select(ToAppointmentRow).ToArray());
    }

    public async Task<CreatedAppointment> BookAppointmentAsync(UserAccess access, CreateAppointmentRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanBookAppointment(access))
            throw new ApplicationFault(403,
                "Запись на приём выполняет регистратор, врач или управленческая роль учреждения");
        if (request.SlotId <= 0) throw new ApplicationFault(422, "Укажите талон");
        if (request.PatientId <= 0) throw new ApplicationFault(422, "Укажите пациента");
        var manageOrganizations = AccessPolicies.AppointmentManagerOrganizationIds(access);
        var parameters = AccessParameters(access);
        parameters["appointment_orgs"] = manageOrganizations;
        parameters["patient"] = request.PatientId;
        parameters["slot"] = request.SlotId;
        parameters["referral"] = request.ReferralId is > 0 ? request.ReferralId.Value : null;

        if (await RowsAsync($"SELECT p.id FROM project.patients p WHERE p.id = @patient AND ({AppointmentPatientSql})",
                parameters, cancellationToken) is { Count: 0 })
            throw new ApplicationFault(404, "Пациент не найден в доступной области");
        var slots = await RowsAsync("""
            SELECT s.id, s.status FROM project.appointment_slots s
            WHERE s.id = @slot::bigint AND s.organization_id = ANY(@appointment_orgs)
            """, parameters, cancellationToken);
        if (slots.Count == 0) throw new ApplicationFault(404, "Талон не найден в доступной области");
        if ((string)slots[0]["status"]! != "free") throw new ApplicationFault(409, "Талон уже занят");
        if (request.ReferralId is > 0)
        {
            var referrals = await RowsAsync("""
                SELECT r.id, c.patient_id AS "patientId"
                FROM project.referrals r
                JOIN project.medical_cases c ON c.id = r.case_id
                WHERE r.id = @referral::bigint
                """, parameters, cancellationToken);
            if (referrals.Count == 0) throw new ApplicationFault(404, "Направление не найдено");
            if ((long)referrals[0]["patientId"]! != request.PatientId)
                throw new ApplicationFault(409, "Направление выписано другому пациенту");
        }

        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            // Атомарный захват талона: условие status = 'free' в самом UPDATE отсекает
            // гонку двух регистраторов, а 0 строк означает, что талон уже заняли.
            var booked = await TxRowsAsync(connection, transaction, """
                UPDATE project.appointment_slots
                SET status = 'booked', patient_id = @patient, referral_id = @referral::bigint,
                    booked_at = CURRENT_TIMESTAMP
                WHERE id = @slot AND status = 'free' AND organization_id = ANY(@appointment_orgs)
                RETURNING id, starts_at AS "startsAt"
                """, parameters, cancellationToken);
            if (booked.Count == 0) throw new ApplicationFault(409, "Талон уже занят");
            var id = (long)booked[0]["id"]!;
            await HospitalAuditAsync(connection, transaction, access.UserId, "book", "appointment", id, requestId,
                ["status", "patient_id", "referral_id", "booked_at"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(id, HospitalTimestamp(booked[0]["startsAt"]!));
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    public async Task ChangeAppointmentStatusAsync(UserAccess access, long slotId, AppointmentStatusRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanChangeAppointmentStatus(access))
            throw new ApplicationFault(403,
                "Смену статуса записи выполняет регистратор, врач или управленческая роль учреждения");
        var status = (request.Status ?? string.Empty).Trim().ToLowerInvariant();
        if (status is not ("completed" or "cancelled"))
            throw new ApplicationFault(422, "Новый статус записи: completed или cancelled");
        var parameters = AccessParameters(access);
        parameters["manage_orgs"] = AccessPolicies.AppointmentManagerOrganizationIds(access);
        parameters["slot"] = slotId;
        parameters["status"] = status;
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var rows = await TxRowsAsync(connection, transaction, """
                SELECT s.id, s.status FROM project.appointment_slots s
                WHERE s.id = @slot AND s.organization_id = ANY(@manage_orgs)
                FOR UPDATE OF s
                """, parameters, cancellationToken);
            if (rows.Count == 0) throw new ApplicationFault(404, "Запись не найдена в доступной области");
            var current = (string)rows[0]["status"]!;
            // Разрешено только booked → completed/cancelled: отменённую запись нельзя
            // вернуть, завершённый приём не переоткрывается, свободный талон не запись.
            if (current != "booked")
                throw new ApplicationFault(409, current switch
                {
                    "free" => "На талон ещё не записан пациент",
                    "cancelled" => "Запись уже отменена",
                    "completed" => "Приём уже завершён",
                    _ => "Талон в состоянии, не допускающем смену статуса"
                });
            if (await TxExecuteAsync(connection, transaction,
                    "UPDATE project.appointment_slots SET status = @status WHERE id = @slot AND status = 'booked'",
                    parameters, cancellationToken) == 0)
                throw new ApplicationFault(409, "Запись уже изменена другим пользователем");
            await HospitalAuditAsync(connection, transaction, access.UserId, "appointment_status", "appointment",
                slotId, requestId, ["status"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // ---------- Расписание ----------

    public async Task<ScheduleList> SchedulesAsync(UserAccess access, DateOnly? dateFrom, DateOnly? dateTo,
        long? organizationId, long? doctorId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadSchedules(access))
            throw new ApplicationFault(403, "Нет доступа к расписанию приёма");
        var (from, to) = AppointmentPeriod(dateFrom, dateTo);
        var organizations = AccessPolicies.AppointmentOrganizationIds(access);
        if (organizationId is > 0 && !organizations.Contains(organizationId.Value))
            throw new ApplicationFault(403, "Организация вне вашей области приёма");
        var parameters = AccessParameters(access);
        parameters["appointment_orgs"] = organizations;
        parameters["date_from"] = from;
        parameters["date_to"] = to;
        parameters["organization"] = organizationId is > 0 ? organizationId.Value : null;
        parameters["doctor"] = doctorId is > 0 ? doctorId.Value : null;
        parameters["limit"] = 1000;
        var rows = await RowsAsync($"""
            {ScheduleSelectSql}
            {ScheduleFromSql}
            WHERE schedule.organization_id = ANY(@appointment_orgs)
              AND schedule.work_date >= @date_from::date AND schedule.work_date <= @date_to::date
              AND (@organization::bigint IS NULL OR schedule.organization_id = @organization::bigint)
              AND (@doctor::bigint IS NULL OR schedule.doctor_id = @doctor::bigint)
            ORDER BY schedule.work_date, schedule.start_time, schedule.doctor_id, schedule.id
            LIMIT @limit
            """, parameters, cancellationToken);
        return new(rows.Select(ToScheduleRow).ToArray());
    }

    public async Task<CreateScheduleResult> CreateScheduleAsync(UserAccess access, CreateScheduleRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanManageSchedules(access))
            throw new ApplicationFault(403,
                "Расписание создаёт администратор организации, главный врач или заместитель");
        if (request.WorkDate == default) throw new ApplicationFault(422, "Укажите дату приёма");
        if (request.SlotMinutes is < 5 or > 240)
            throw new ApplicationFault(422, "Длительность талона — от 5 до 240 минут");
        var start = AppointmentClock(request.StartTime, "начала приёма");
        var end = AppointmentClock(request.EndTime, "окончания приёма");
        if (end <= start) throw new ApplicationFault(422, "Окончание приёма должно быть позже начала");
        var slotsCreated = (int)(end - start).TotalMinutes / request.SlotMinutes;
        if (slotsCreated == 0) throw new ApplicationFault(422, "Интервал короче одного талона");
        if (slotsCreated > 288) throw new ApplicationFault(422, "В одном расписании не больше 288 талонов");
        var cabinet = request.Cabinet?.Trim();
        if (cabinet is { Length: 0 }) cabinet = null;
        if (cabinet is { Length: > 100 }) throw new ApplicationFault(422, "Кабинет длиннее 100 символов");
        var organizations = AccessPolicies.ScheduleManagerOrganizationIds(access);
        if (organizations.Length == 0)
            throw new ApplicationFault(403, "Учётная запись не привязана к организации расписания");
        if (!organizations.Contains(request.OrganizationId))
            throw new ApplicationFault(403, "Организация вне вашей области расписания");
        var parameters = new Dictionary<string, object?>
        {
            ["doctor"] = request.DoctorId,
            ["org"] = request.OrganizationId,
            ["date"] = request.WorkDate,
            ["start"] = start.ToString("HH:mm", CultureInfo.InvariantCulture),
            ["end"] = end.ToString("HH:mm", CultureInfo.InvariantCulture),
            ["slot"] = request.SlotMinutes,
            ["slots"] = slotsCreated,
            ["cabinet"] = cabinet
        };
        var lookups = await BatchRowsAsync([
            """
            SELECT d.employee_id AS id FROM project.doctors d
            JOIN project.employees e ON e.id = d.employee_id
            WHERE d.employee_id = @doctor AND e.is_active
            """,
            """
            SELECT em.id FROM project.employments em
            WHERE em.employee_id = @doctor::bigint AND em.organization_id = @org::bigint
              AND em.ended_on IS NULL
            """,
            """
            SELECT schedule.id FROM project.doctor_schedules schedule
            WHERE schedule.doctor_id = @doctor AND schedule.work_date = @date AND schedule.is_active
              AND schedule.start_time < @end::time AND schedule.end_time > @start::time
            """,
            // Остатки талонов неактивного расписания с тем же временем: отменённые
            // переиспользуются, а завершённые и занятые перезаписывать нельзя.
            """
            SELECT count(*)::int AS conflicts FROM project.appointment_slots s
            WHERE s.doctor_id = @doctor AND s.status <> 'cancelled'
              AND s.starts_at >= ((@date::date + @start::time)::timestamp AT TIME ZONE 'Europe/Moscow')
              AND s.starts_at < ((@date::date + @end::time)::timestamp AT TIME ZONE 'Europe/Moscow')
            """
        ], parameters, cancellationToken);
        if (lookups[0].Count == 0) throw new ApplicationFault(404, "Врач не найден или неактивен");
        if (lookups[1].Count == 0) throw new ApplicationFault(422, "Врач не работает в этой организации");
        if (lookups[2].Count > 0)
            throw new ApplicationFault(409, "У врача уже есть активное расписание на это время");
        if ((int)lookups[3][0]["conflicts"]! > 0)
            throw new ApplicationFault(409, "На это время уже есть талоны другого расписания");

        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var scheduleId = await TxScalarAsync(connection, transaction, """
                INSERT INTO project.doctor_schedules(doctor_id, organization_id, work_date, start_time,
                    end_time, slot_minutes, cabinet)
                VALUES (@doctor, @org, @date, @start::time, @end::time, @slot, @cabinet)
                RETURNING id
                """, parameters, cancellationToken);
            parameters["schedule"] = scheduleId;
            // Талоны создаются тем же оператором на весь интервал; время переводится
            // в timestamptz по Europe/Moscow, чтобы приём не сдвигался при смене пояса.
            var created = await TxExecuteAsync(connection, transaction, """
                INSERT INTO project.appointment_slots AS target(schedule_id, doctor_id, organization_id,
                    starts_at, ends_at)
                SELECT @schedule, @doctor, @org,
                    ((@date::date + @start::time) + (n * @slot::int) * interval '1 minute')
                        AT TIME ZONE 'Europe/Moscow',
                    ((@date::date + @start::time) + ((n + 1) * @slot::int) * interval '1 minute')
                        AT TIME ZONE 'Europe/Moscow'
                FROM generate_series(0, @slots::int - 1) AS n
                ON CONFLICT (doctor_id, starts_at) DO UPDATE
                SET schedule_id = EXCLUDED.schedule_id, organization_id = EXCLUDED.organization_id,
                    ends_at = EXCLUDED.ends_at, status = 'free', patient_id = NULL,
                    referral_id = NULL, booked_at = NULL
                WHERE target.status = 'cancelled'
                """, parameters, cancellationToken);
            if (created != slotsCreated)
                throw new ApplicationFault(409, "Часть талонов этого времени недоступна для нового расписания");
            await HospitalAuditAsync(connection, transaction, access.UserId, "insert", "doctor_schedule",
                scheduleId, requestId, ["doctor_id", "organization_id", "work_date", "slots"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return new(scheduleId, created);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // Отмена расписания: is_active = false, свободные талоны удаляются. Занятые талоны
    // не трогаются, поэтому расписание с записями не отменяется — 409: иначе пациент
    // остался бы с талоном в отменённом расписании. Завершённые приёмы (completed)
    // остаются историей и отмене не мешают.
    public async Task DeleteScheduleAsync(UserAccess access, long id, string requestId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanManageSchedules(access))
            throw new ApplicationFault(403,
                "Отмену расписания выполняет администратор организации, главный врач или заместитель");
        var parameters = AccessParameters(access);
        parameters["id"] = id;
        parameters["schedule_orgs"] = AccessPolicies.ScheduleManagerOrganizationIds(access);
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var rows = await TxRowsAsync(connection, transaction, """
                SELECT schedule.id, schedule.is_active AS "isActive"
                FROM project.doctor_schedules schedule
                WHERE schedule.id = @id AND schedule.organization_id = ANY(@schedule_orgs)
                FOR UPDATE OF schedule
                """, parameters, cancellationToken);
            if (rows.Count == 0) throw new ApplicationFault(404, "Расписание не найдено в доступной области");
            if (!(bool)rows[0]["isActive"]!) throw new ApplicationFault(409, "Расписание уже отменено");
            var booked = (int)(await TxRowsAsync(connection, transaction, """
                SELECT count(*)::int AS booked FROM project.appointment_slots s
                WHERE s.schedule_id = @id AND s.status = 'booked'
                """, parameters, cancellationToken))[0]["booked"]!;
            if (booked > 0) throw new ApplicationFault(409, "На расписание есть записи: сначала отмените их");
            // Свободный талон не содержит данных пациента, но CHECK миграции 008
            // (status = 'free' OR patient_id IS NOT NULL) не позволяет пометить его
            // cancelled без пациента, поэтому свободные талоны удаляются: сетка времени
            // отменённого расписания не должна оставаться доступной для записи.
            await using (var batch = new NpgsqlBatch(connection, transaction))
            {
                var schedule = new NpgsqlBatchCommand(
                    "UPDATE project.doctor_schedules SET is_active = false WHERE id = @id");
                AddParameters(schedule, parameters);
                batch.BatchCommands.Add(schedule);
                var slots = new NpgsqlBatchCommand("""
                    DELETE FROM project.appointment_slots WHERE schedule_id = @id AND status = 'free'
                    """);
                AddParameters(slots, parameters);
                batch.BatchCommands.Add(slots);
                await batch.ExecuteNonQueryAsync(cancellationToken);
            }
            await HospitalAuditAsync(connection, transaction, access.UserId, "cancel", "doctor_schedule", id,
                requestId, ["is_active", "slots"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }
}
