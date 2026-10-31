using System.Data;
using System.Globalization;
using System.Text.Json;
using Medcore.Application;
using Npgsql;

namespace Medcore.Infrastructure;

// Транспортировка пациента между учреждениями (миграция 007): реестр в области доступа,
// оформление рейса от учреждения пользователя и смена статуса с проставлением
// started_at/completed_at одним UPDATE. Миграция 008 добавила маршрут, пробег, одометр
// и топливо: их сохраняет PUT /api/transports/{id}/route, точки лежат в jsonb.
public sealed partial class MedcoreStore
{
    private static readonly string[] TransportStatuses =
        ["requested", "in_progress", "completed", "cancelled"];

    private static readonly JsonSerializerOptions TransportRouteJson = new() { PropertyNameCaseInsensitive = true };

    private const string TransportSelectSql = """
        SELECT t.id, t.patient_id AS "patientId",
            concat_ws(' ', p.last_name, p.first_name, p.middle_name) AS "patientName",
            t.from_organization_id AS "fromOrganizationId", source.name AS "fromOrganizationName",
            t.to_organization_id AS "toOrganizationId", target.name AS "toOrganizationName",
            t.status, t.reason, t.requested_at AS "requestedAt", t.started_at AS "startedAt",
            t.completed_at AS "completedAt", t.vehicle,
            t.accompanying_employee_id AS "accompanyingEmployeeId",
            nullif(concat_ws(' ', accompanying.last_name, accompanying.first_name, accompanying.middle_name), '')
                AS "accompanyingName",
            t.distance_km AS "distanceKm", t.odometer_start AS "odometerStart",
            t.odometer_end AS "odometerEnd", t.fuel_liters AS "fuelLiters",
            t.route_points::text AS "routePoints"
        """;

    private const string TransportFromSql = """
        FROM project.patient_transports t
        JOIN project.patients p ON p.id = t.patient_id
        JOIN project.medical_organizations source ON source.id = t.from_organization_id
        JOIN project.medical_organizations target ON target.id = t.to_organization_id
        LEFT JOIN project.employees accompanying ON accompanying.id = t.accompanying_employee_id
        """;

    // Область чтения: учреждения регистратора и управленческих ролей плюс случаи врача.
    private static readonly string TransportReadPredicate =
        $"""
        (t.from_organization_id = ANY(@transport_orgs) OR t.to_organization_id = ANY(@transport_orgs)
         OR EXISTS (SELECT 1 FROM project.medical_cases c
             WHERE c.patient_id = t.patient_id AND ({CareCaseSql})))
        """;

    // Статус меняют роли с организацией: регистратор, администратор, главный врач, заместитель.
    private const string TransportEditPredicate =
        "(t.from_organization_id = ANY(@transport_edit_orgs) OR t.to_organization_id = ANY(@transport_edit_orgs))";

    private static TransportRoutePoint[] TransportRouteRowPoints(object? value) =>
        value is string text && text.Length > 0
            ? JsonSerializer.Deserialize<TransportRoutePoint[]>(text, TransportRouteJson) ?? []
            : [];

    private static TransportRow ToTransportRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (long)row["patientId"]!, (string)row["patientName"]!,
        (long)row["fromOrganizationId"]!, (string)row["fromOrganizationName"]!,
        (long)row["toOrganizationId"]!, (string)row["toOrganizationName"]!,
        (string)row["status"]!, (string)row["reason"]!, HospitalTimestamp(row["requestedAt"]!),
        HospitalTimestampOrNull(row["startedAt"]), HospitalTimestampOrNull(row["completedAt"]),
        row["vehicle"] as string, (long?)row["accompanyingEmployeeId"], row["accompanyingName"] as string,
        row["distanceKm"] is null ? null : (decimal)row["distanceKm"]!,
        row["odometerStart"] is null ? null : (int)row["odometerStart"]!,
        row["odometerEnd"] is null ? null : (int)row["odometerEnd"]!,
        row["fuelLiters"] is null ? null : (decimal)row["fuelLiters"]!,
        TransportRouteRowPoints(row["routePoints"]));

    // ---------- Чтение ----------

    public async Task<PageResult<TransportRow>> TransportsPageAsync(UserAccess access, string? status, int page,
        int pageSize, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadTransports(access))
            throw new ApplicationFault(403, "Нет доступа к перевозкам пациентов");
        if (page < 1 || pageSize is < 1 or > 100 || (long)(page - 1) * pageSize > int.MaxValue)
            throw new ApplicationFault(400, "Некорректные параметры страницы");
        var normalizedStatus = string.IsNullOrWhiteSpace(status) ? null : status.Trim().ToLowerInvariant();
        if (normalizedStatus is not null && Array.IndexOf(TransportStatuses, normalizedStatus) < 0)
            throw new ApplicationFault(422,
                "Статус перевозки: requested, in_progress, completed или cancelled");
        var parameters = AccessParameters(access);
        parameters["transport_orgs"] = AccessPolicies.TransportOrganizationIds(access);
        parameters["status"] = normalizedStatus;
        var where = $"""
            WHERE {TransportReadPredicate}
              AND (@status IS NULL OR t.status = @status)
            """;
        var total = (long)(await RowsAsync($"SELECT count(*)::bigint AS total {TransportFromSql} {where}",
            parameters, cancellationToken))[0]["total"]!;
        parameters["limit"] = pageSize;
        parameters["offset"] = (page - 1) * pageSize;
        var rows = await RowsAsync($"""
            {TransportSelectSql}
            {TransportFromSql}
            {where}
            ORDER BY t.requested_at DESC, t.id DESC
            LIMIT @limit OFFSET @offset
            """, parameters, cancellationToken);
        return new(rows.Select(ToTransportRow).ToArray(), (int)total, page, pageSize);
    }

    // ---------- Оформление ----------

    public async Task<long> CreateTransportAsync(UserAccess access, CreateTransportRequest request, string requestId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanCreateTransport(access))
            throw new ApplicationFault(403,
                "Перевозку оформляет регистратор, врач или управленческая роль учреждения");
        var reason = (request.Reason ?? string.Empty).Trim();
        if (reason.Length == 0) throw new ApplicationFault(422, "Укажите причину перевозки");
        if (reason.Length > 2000) throw new ApplicationFault(422, "Причина перевозки длиннее 2000 символов");
        var vehicle = request.Vehicle?.Trim();
        if (vehicle is { Length: 0 }) vehicle = null;
        if (vehicle is { Length: > 200 }) throw new ApplicationFault(422, "Название транспорта длиннее 200 символов");
        // Учреждение отправления приходит от клиента: оно обязано быть в области доступа.
        var fromOrganizationId = request.FromOrganizationId;
        if (fromOrganizationId <= 0) throw new ApplicationFault(422, "Укажите учреждение отправления");
        if (!access.OrganizationIds.Contains(fromOrganizationId))
            throw new ApplicationFault(403, "Учреждение отправления вне вашей области доступа");
        if (request.ToOrganizationId == fromOrganizationId)
            throw new ApplicationFault(409, "Учреждение назначения совпадает с учреждением отправления");
        var parameters = AccessParameters(access);
        parameters["patient"] = request.PatientId;
        parameters["from"] = fromOrganizationId;
        parameters["target_org"] = request.ToOrganizationId;
        if (await RowsAsync($"SELECT p.id FROM project.patients p WHERE p.id = @patient AND ({PatientAccessSql})",
                parameters, cancellationToken) is { Count: 0 })
            throw new ApplicationFault(404, "Пациент не найден в доступной области");
        if (await RowsAsync("""
            SELECT o.id FROM project.medical_organizations o
            WHERE o.id = @target_org AND o.is_active
            """, parameters, cancellationToken) is { Count: 0 })
            throw new ApplicationFault(404, "Учреждение назначения не найдено или неактивно");
        parameters["referral"] = request.ReferralId;
        if (request.ReferralId is > 0)
        {
            var referrals = await RowsAsync("""
                SELECT r.id, r.target_hospital_id AS "targetHospitalId", c.patient_id AS "patientId"
                FROM project.referrals r
                JOIN project.medical_cases c ON c.id = r.case_id
                WHERE r.id = @referral
                """, parameters, cancellationToken);
            if (referrals.Count == 0) throw new ApplicationFault(404, "Направление не найдено");
            if ((long)referrals[0]["patientId"]! != request.PatientId)
                throw new ApplicationFault(409, "Направление выписано другому пациенту");
            if ((long)referrals[0]["targetHospitalId"]! != request.ToOrganizationId)
                throw new ApplicationFault(409, "Направление выписано в другое учреждение");
        }
        parameters["accompanying"] = request.AccompanyingEmployeeId;
        if (request.AccompanyingEmployeeId is > 0
            && await RowsAsync("""
                SELECT e.id FROM project.employees e WHERE e.id = @accompanying AND e.is_active
                """, parameters, cancellationToken) is { Count: 0 })
            throw new ApplicationFault(422, "Сопровождающий сотрудник не найден или неактивен");
        parameters["reason"] = reason;
        parameters["vehicle"] = vehicle;
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var id = await TxScalarAsync(connection, transaction, """
                INSERT INTO project.patient_transports(patient_id, from_organization_id, to_organization_id,
                    referral_id, status, reason, requested_at, vehicle, accompanying_employee_id)
                VALUES (@patient, @from, @target_org, @referral::bigint, 'requested', @reason, CURRENT_TIMESTAMP,
                    @vehicle, @accompanying::bigint)
                RETURNING id
                """, parameters, cancellationToken);
            await HospitalAuditAsync(connection, transaction, access.UserId, "insert", "patient_transport", id,
                requestId, ["patient_id", "from_organization_id", "to_organization_id"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // ---------- Статус ----------

    public async Task ChangeTransportStatusAsync(UserAccess access, long id, TransportStatusRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanUpdateTransport(access))
            throw new ApplicationFault(403,
                "Смену статуса перевозки выполняет регистратор или управленческая роль учреждения");
        var status = (request.Status ?? string.Empty).Trim().ToLowerInvariant();
        if (status is not ("in_progress" or "completed" or "cancelled"))
            throw new ApplicationFault(422, "Новый статус перевозки: in_progress, completed или cancelled");
        var parameters = AccessParameters(access);
        parameters["id"] = id;
        parameters["transport_edit_orgs"] = AccessPolicies.TransportEditOrganizationIds(access);
        parameters["status"] = status;
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var rows = await TxRowsAsync(connection, transaction, $"""
                SELECT t.id, t.status FROM project.patient_transports t
                WHERE t.id = @id AND {TransportEditPredicate}
                FOR UPDATE OF t
                """, parameters, cancellationToken);
            if (rows.Count == 0) throw new ApplicationFault(404, "Перевозка не найдена в доступной области");
            var current = (string)rows[0]["status"]!;
            var allowed = current switch
            {
                "requested" => status is "in_progress" or "completed" or "cancelled",
                "in_progress" => status is "completed" or "cancelled",
                _ => false
            };
            if (!allowed)
                throw new ApplicationFault(409, current switch
                {
                    "completed" => "Перевозка уже завершена",
                    "cancelled" => "Перевозка уже отменена",
                    _ => "Перевозка в состоянии, не допускающем смену статуса"
                });
            // started_at/completed_at проставляются тем же UPDATE, что и статус: CHECK схемы
            // требует completed_at только вместе с started_at, поэтому прямой перевод
            // requested → completed заполняет обе метки.
            if (await TxExecuteAsync(connection, transaction, """
                UPDATE project.patient_transports
                SET status = @status,
                    started_at = CASE WHEN @status IN ('in_progress', 'completed')
                                      THEN coalesce(started_at, CURRENT_TIMESTAMP) ELSE started_at END,
                    completed_at = CASE WHEN @status = 'completed'
                                        THEN CURRENT_TIMESTAMP ELSE completed_at END
                WHERE id = @id
                """, parameters, cancellationToken) == 0)
                throw new ApplicationFault(404, "Перевозка не найдена");
            await HospitalAuditAsync(connection, transaction, access.UserId, "transport_status", "patient_transport",
                id, requestId, ["status", "started_at", "completed_at"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // ---------- Маршрут ----------

    // PUT /api/transports/{id}/route: пробег, одометр, топливо и точки маршрута.
    // Точки хранятся в jsonb как массив объектов {lat, lng, label}; проверки диапазонов
    // дублируют ограничения схемы, чтобы клиент получал 422 с русским текстом.
    public async Task UpdateTransportRouteAsync(UserAccess access, long id, UpdateTransportRouteRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanUpdateTransport(access))
            throw new ApplicationFault(403,
                "Маршрут перевозки заполняет регистратор или управленческая роль учреждения");
        if (request.DistanceKm is not { } distanceKm)
            throw new ApplicationFault(422, "Укажите пробег маршрута");
        if (distanceKm is < 0 or > 9_999_999.9m)
            throw new ApplicationFault(422, "Пробег маршрута — от 0 до 9999999,9 км");
        var fuel = request.FuelLiters;
        if (fuel is < 0 or > 9_999_999.9m)
            throw new ApplicationFault(422, "Объём топлива — от 0 до 9999999,9 л");
        if (request.OdometerStart is < 0 || request.OdometerEnd is < 0)
            throw new ApplicationFault(422, "Показание одометра не может быть отрицательным");
        if (request.OdometerStart is { } odometerStart && request.OdometerEnd is { } odometerEnd
            && odometerEnd < odometerStart)
            throw new ApplicationFault(422, "Показание одометра в конце меньше начального");
        var points = request.RoutePoints ?? [];
        if (points.Length is < 2 or > 10)
            throw new ApplicationFault(422, "Маршрут содержит от 2 до 10 точек");
        foreach (var point in points)
        {
            if (double.IsNaN(point.Lat) || point.Lat is < -90 or > 90)
                throw new ApplicationFault(422, "Широта точки маршрута — от -90 до 90");
            if (double.IsNaN(point.Lng) || point.Lng is < -180 or > 180)
                throw new ApplicationFault(422, "Долгота точки маршрута — от -180 до 180");
            if (point.Label is { Length: > 200 })
                throw new ApplicationFault(422, "Подпись точки маршрута длиннее 200 символов");
        }
        // jsonb собирается приложением и передаётся параметром: SQL остаётся параметризованным.
        var routePoints = JsonSerializer.Serialize(points.Select(point => new
        {
            lat = point.Lat, lng = point.Lng, label = point.Label?.Trim()
        }));
        var parameters = AccessParameters(access);
        parameters["transport_edit_orgs"] = AccessPolicies.TransportEditOrganizationIds(access);
        parameters["id"] = id;
        parameters["distance"] = distanceKm.ToString(CultureInfo.InvariantCulture);
        parameters["fuel"] = fuel?.ToString(CultureInfo.InvariantCulture);
        parameters["odometer_start"] = request.OdometerStart;
        parameters["odometer_end"] = request.OdometerEnd;
        parameters["route_points"] = routePoints;
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            if (await TxRowsAsync(connection, transaction, $"""
                    SELECT t.id FROM project.patient_transports t
                    WHERE t.id = @id AND {TransportEditPredicate}
                    FOR UPDATE OF t
                    """, parameters, cancellationToken) is { Count: 0 })
                throw new ApplicationFault(404, "Перевозка не найдена в доступной области");
            if (await TxExecuteAsync(connection, transaction, """
                    UPDATE project.patient_transports
                    SET distance_km = @distance::numeric(8, 1),
                        route_points = @route_points::jsonb,
                        odometer_start = @odometer_start::int,
                        odometer_end = @odometer_end::int,
                        fuel_liters = @fuel::numeric(8, 1)
                    WHERE id = @id
                    """, parameters, cancellationToken) == 0)
                throw new ApplicationFault(404, "Перевозка не найдена");
            await HospitalAuditAsync(connection, transaction, access.UserId, "transport_route", "patient_transport",
                id, requestId, ["distance_km", "route_points", "odometer_start", "odometer_end", "fuel_liters"],
                cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }
}
