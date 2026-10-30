using System.Data;
using System.Globalization;
using System.Text;
using Medcore.Application;
using Npgsql;
using NpgsqlTypes;

namespace Medcore.Infrastructure;

// Лаборатории: карточка, заказы и результаты. Заказ проверяет профиль лаборатории и срок
// договора на местную дату заказа; исправление результата создаёт новую запись
// с supersedes_result_id и не изменяет прежнюю. Схема не меняется: миграции 001–003.
public sealed partial class MedcoreStore
{
    // ---------- Помощники лабораторий ----------

    private static void RequireLaboratoryReader(UserAccess access)
    {
        if (!access.Roles.Any(role => role is "lab_staff" or "doctor" or "organization_admin" or "analyst")
            && !AccessPolicies.IsHospitalReader(access))
            throw new ApplicationFault(403, "Нет доступа к сведениям лабораторий");
    }

    private static void RequireLabOrderReader(UserAccess access)
    {
        if (!access.Roles.Any(role => role is "lab_staff" or "doctor" or "organization_admin")
            && !AccessPolicies.IsHospitalReader(access))
            throw new ApplicationFault(403, "Нет доступа к лабораторным заказам");
    }

    private static void RequireLabOrderCreator(UserAccess access)
    {
        if (!access.HasRole("doctor") || access.EmployeeId is null)
            throw new ApplicationFault(403, "Заказ исследования оформляет только врач");
    }

    private static void RequireLabStaff(UserAccess access)
    {
        if (!access.HasRole("lab_staff"))
            throw new ApplicationFault(403, "Результат вносит только сотрудник лаборатории");
        if (access.LaboratoryIds.Length == 0)
            throw new ApplicationFault(403, "Учётная запись не привязана к лаборатории");
    }

    // Политика строки лабораторного заказа для чтения: своя лаборатория, подтверждённое
    // отношение врача к случаю либо организация администратора.
    private static string LabOrderAccessPredicate =>
        $"(contract.laboratory_id = ANY(@labs) OR ({CareCaseSql}) OR (c.organization_id = ANY(@manager_orgs)))";

    private static DateOnly LabMoscowDate(DateTimeOffset moment) =>
        DateOnly.FromDateTime(moment.ToOffset(TimeSpan.FromHours(3)).DateTime);

    private static ApplicationFault LabWriteFault(PostgresException error) => error.SqlState switch
    {
        "23514" when error.MessageText is { Length: > 0 } text
            && text.Any(character => character is >= 'А' and <= 'я') => new ApplicationFault(409, text),
        "23514" => new ApplicationFault(409, "Операция нарушает правила лабораторных заказов"),
        "23505" => new ApplicationFault(409, "Результат уже исправлен другим пользователем"),
        "23503" => new ApplicationFault(409, "Связанная запись не найдена или недоступна"),
        "25000" => new ApplicationFault(409, "Операция требует уровня изоляции READ COMMITTED"),
        _ => new ApplicationFault(409, "Операция нарушает ограничения данных")
    };

    // Схема 001 не хранит единицу, референсный интервал и заключение отдельными колонками.
    // Они кодируются в тексте результата в устойчивом виде; при чтении возвращаются поля контракта.
    private static string ComposeLabResultText(string value, string? unit, string? referenceRange,
        string? conclusion)
    {
        var builder = new StringBuilder(value.Trim());
        if (!string.IsNullOrWhiteSpace(unit)) builder.Append(" | ед.: ").Append(unit.Trim());
        if (!string.IsNullOrWhiteSpace(referenceRange)) builder.Append(" | реф.: ").Append(referenceRange.Trim());
        if (!string.IsNullOrWhiteSpace(conclusion)) builder.Append(" | закл.: ").Append(conclusion.Trim());
        return builder.ToString();
    }

    private static LabResultSummary ParseLabResultSummary(string text, string? fallbackUnit,
        string? fallbackReference, DateTimeOffset performedAt)
    {
        var parts = text.Split(" | ", StringSplitOptions.None);
        string? unit = null, reference = null, conclusion = null;
        for (var index = 1; index < parts.Length; index++)
        {
            if (parts[index].StartsWith("ед.: ", StringComparison.Ordinal)) unit = parts[index][5..];
            else if (parts[index].StartsWith("реф.: ", StringComparison.Ordinal)) reference = parts[index][6..];
            else if (parts[index].StartsWith("закл.: ", StringComparison.Ordinal)) conclusion = parts[index][7..];
        }
        return new(parts[0], unit ?? fallbackUnit, reference ?? fallbackReference, conclusion, performedAt);
    }

    private static decimal? LabNumericValue(string value) =>
        decimal.TryParse(value.Trim().Replace(',', '.'), NumberStyles.Number, CultureInfo.InvariantCulture, out var parsed)
            ? parsed : null;

    private static LabOrderRow ToLabOrderRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (string)row["patientName"]!, (string)row["testName"]!,
        (string)row["laboratoryName"]!, (string)row["status"]!, HospitalTimestamp(row["orderedAt"]),
        HospitalTimestampOrNull(row["completedAt"]));

    // ---------- Чтение ----------

    public async Task<LaboratoryCard> LaboratoryCardAsync(UserAccess access, long id, CancellationToken cancellationToken)
    {
        RequireLaboratoryReader(access);
        var parameters = AccessParameters(access);
        parameters["id"] = id;
        parameters["orgs"] = access.OrganizationIds;
        var rows = await RowsAsync("""
            SELECT l.id, l.name, l.address, l.phone, l.email, l.is_active AS "isActive"
            FROM project.laboratories l
            WHERE l.id = @id AND (
                l.id = ANY(@labs)
                OR EXISTS (SELECT 1 FROM project.laboratory_contracts contract
                    WHERE contract.laboratory_id = l.id AND contract.organization_id = ANY(@orgs)))
            """, parameters, cancellationToken);
        if (rows.Count == 0) throw new ApplicationFault(404, "Лаборатория не найдена в доступной области");
        var laboratory = new LaboratorySummary((long)rows[0]["id"]!, (string)rows[0]["name"]!,
            (string)rows[0]["address"]!, HospitalText(rows[0]["phone"]), HospitalText(rows[0]["email"]),
            (bool)rows[0]["isActive"]!);
        var profiles = (await RowsAsync("""
            SELECT p.id, p.code, p.name
            FROM project.laboratory_profile_links link
            JOIN project.laboratory_profiles p ON p.id = link.profile_id
            WHERE link.laboratory_id = @id
            ORDER BY p.name, p.id
            """, parameters, cancellationToken)).Select(row => new LaboratoryProfileRow(
                (long)row["id"]!, (string)row["code"]!, (string)row["name"]!)).ToArray();
        var contracts = (await RowsAsync("""
            SELECT contract.id, o.name AS "organizationName", contract.contract_number AS "contractNumber",
                contract.valid_from AS "validFrom", contract.valid_until AS "validUntil",
                contract.is_active AS "isActive"
            FROM project.laboratory_contracts contract
            JOIN project.medical_organizations o ON o.id = contract.organization_id
            WHERE contract.laboratory_id = @id
              AND (contract.laboratory_id = ANY(@labs) OR contract.organization_id = ANY(@orgs))
            ORDER BY contract.valid_until DESC, contract.id
            """, parameters, cancellationToken)).Select(row => new LaboratoryContractRow(
                (long)row["id"]!, (string)row["organizationName"]!, (string)row["contractNumber"]!,
                HospitalDate(row["validFrom"]), HospitalDate(row["validUntil"]),
                (bool)row["isActive"]!)).ToArray();
        return new(laboratory, profiles, contracts);
    }

    public async Task<PageResult<LabOrderRow>> LabOrdersPageAsync(UserAccess access, string? status, string? search,
        int page, int pageSize, CancellationToken cancellationToken)
    {
        RequireLabOrderReader(access);
        if (page < 1 || pageSize is < 1 or > 100 || search?.Trim().Length > 100
            || (long)(page - 1) * pageSize > int.MaxValue)
            throw new ApplicationFault(400, "Некорректные параметры поиска или страницы");
        var normalizedStatus = string.IsNullOrWhiteSpace(status) ? null : status.Trim();
        var (statusA, statusB) = normalizedStatus switch
        {
            null => ((string?)null, (string?)null),
            "pending" => ("ordered", "in_progress"),
            "completed" => ("completed", null),
            "ordered" => ("ordered", null),
            "in_progress" => ("in_progress", null),
            "cancelled" => ("cancelled", null),
            _ => throw new ApplicationFault(400,
                "Статус заказа: pending, completed, ordered, in_progress или cancelled")
        };
        var parameters = AccessParameters(access);
        parameters["manager_orgs"] = AccessPolicies.ManagerOrganizationIds(access);
        parameters["statusA"] = statusA;
        parameters["statusB"] = statusB;
        parameters["search"] = string.IsNullOrWhiteSpace(search) ? null : $"%{search.Trim()}%";
        var filter = $"""
            FROM project.lab_orders lo
            JOIN project.medical_cases c ON c.id = lo.case_id
            JOIN project.patients p ON p.id = c.patient_id
            JOIN project.lab_test_types test ON test.id = lo.test_type_id
            JOIN project.laboratory_contracts contract ON contract.id = lo.contract_id
            JOIN project.laboratories l ON l.id = contract.laboratory_id
            WHERE {LabOrderAccessPredicate}
              AND (@statusA IS NULL OR lo.status = @statusA OR lo.status = @statusB)
              AND (@search IS NULL OR concat_ws(' ', p.last_name, p.first_name, p.middle_name) ILIKE @search)
            """;
        var total = (long)(await RowsAsync("SELECT count(*)::bigint AS total " + filter, parameters, cancellationToken))[0]["total"]!;
        parameters["limit"] = pageSize;
        parameters["offset"] = (page - 1) * pageSize;
        var rows = await RowsAsync($"""
            SELECT lo.id, concat_ws(' ', p.last_name, p.first_name, p.middle_name) AS "patientName",
                test.name AS "testName", l.name AS "laboratoryName", lo.status,
                lo.ordered_at AS "orderedAt",
                (SELECT max(result.entered_at) FROM project.lab_results result
                    WHERE result.order_id = lo.id) AS "completedAt"
            {filter}
            ORDER BY lo.ordered_at DESC, lo.id DESC
            LIMIT @limit OFFSET @offset
            """, parameters, cancellationToken);
        return new(rows.Select(ToLabOrderRow).ToArray(), (int)total, page, pageSize);
    }

    public async Task<LabOrderDetail> LabOrderDetailAsync(UserAccess access, long id, CancellationToken cancellationToken)
    {
        RequireLabOrderReader(access);
        var parameters = AccessParameters(access);
        parameters["manager_orgs"] = AccessPolicies.ManagerOrganizationIds(access);
        parameters["id"] = id;
        var rows = await RowsAsync($"""
            SELECT lo.id, concat_ws(' ', p.last_name, p.first_name, p.middle_name) AS "patientName",
                test.name AS "testName", l.name AS "laboratoryName", lo.status,
                lo.ordered_at AS "orderedAt",
                concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS "doctorName",
                test.measurement_unit AS "measurementUnit",
                test.reference_description AS "referenceDescription",
                (SELECT max(result.entered_at) FROM project.lab_results result
                    WHERE result.order_id = lo.id) AS "completedAt"
            FROM project.lab_orders lo
            JOIN project.medical_cases c ON c.id = lo.case_id
            JOIN project.patients p ON p.id = c.patient_id
            JOIN project.lab_test_types test ON test.id = lo.test_type_id
            JOIN project.laboratory_contracts contract ON contract.id = lo.contract_id
            JOIN project.laboratories l ON l.id = contract.laboratory_id
            JOIN project.employees e ON e.id = lo.doctor_id
            WHERE lo.id = @id AND {LabOrderAccessPredicate}
            """, parameters, cancellationToken);
        if (rows.Count == 0) throw new ApplicationFault(404, "Заказ исследования не найден в доступной области");
        var order = rows[0];
        var current = await RowsAsync("""
            SELECT result.id, result.result_text AS "resultText", result.measured_at AS "measuredAt"
            FROM project.lab_results result
            WHERE result.order_id = @id
              AND NOT EXISTS (SELECT 1 FROM project.lab_results next
                  WHERE next.supersedes_result_id = result.id)
            ORDER BY result.id DESC LIMIT 1
            """, parameters, cancellationToken);
        LabResultSummary? result = null;
        if (current.Count == 1)
        {
            var text = (string)current[0]["resultText"]!;
            result = ParseLabResultSummary(text, HospitalText(order["measurementUnit"]),
                HospitalText(order["referenceDescription"]), HospitalTimestamp(current[0]["measuredAt"]));
        }
        return new((long)order["id"]!, (string)order["patientName"]!, (string)order["testName"]!,
            (string)order["laboratoryName"]!, (string)order["status"]!, HospitalTimestamp(order["orderedAt"]),
            HospitalTimestampOrNull(order["completedAt"]), (string)order["doctorName"]!, result);
    }

    // ---------- Заказ исследования ----------

    public async Task<long> CreateLabOrderAsync(UserAccess access, CreateLabOrderRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        RequireLabOrderCreator(access);
        var orderedAt = request.OrderedAt ?? DateTimeOffset.UtcNow;
        if (orderedAt > DateTimeOffset.UtcNow.AddMinutes(1))
            throw new ApplicationFault(400, "Дата заказа не может быть позже текущего момента");
        var orderDate = LabMoscowDate(orderedAt);
        var parameters = AccessParameters(access);
        parameters["patient"] = request.PatientId;
        parameters["ordered"] = orderedAt;
        parameters["orderDate"] = orderDate;
        parameters["test"] = request.TestTypeId;

        // Отношение врач–пациент: тот же предикат, что и в карточке пациента.
        if (await RowsAsync($"""
            SELECT p.id FROM project.patients p
            WHERE p.id = @patient AND EXISTS (
                SELECT 1 FROM project.medical_cases c WHERE c.patient_id = p.id AND ({CareCaseSql}))
            """, parameters, cancellationToken) is { Count: 0 })
            throw new ApplicationFault(404, "Пациент не найден среди пациентов вашей области лечения");

        Dictionary<string, object?>? medicalCase;
        if (request.CaseId is > 0)
        {
            parameters["case"] = request.CaseId.Value;
            var cases = await RowsAsync($"""
                SELECT c.id, c.organization_id AS "organizationId", c.opened_at AS "openedAt",
                    c.status
                FROM project.medical_cases c
                WHERE c.id = @case AND c.patient_id = @patient AND ({CareCaseSql})
                """, parameters, cancellationToken);
            if (cases.Count == 0)
                throw new ApplicationFault(404, "Медицинский случай не найден в доступной области");
            medicalCase = cases[0];
            if ((string)medicalCase["status"]! == "cancelled")
                throw new ApplicationFault(409, "По отменённому случаю заказ исследования не оформляется");
        }
        else
        {
            var cases = await RowsAsync("""
                SELECT c.id, c.organization_id AS "organizationId", c.opened_at AS "openedAt", c.status
                FROM project.medical_cases c
                WHERE c.patient_id = @patient AND c.status = 'open' AND c.organization_id = ANY(@doctor_orgs)
                ORDER BY c.opened_at DESC, c.id DESC LIMIT 1
                """, parameters, cancellationToken);
            if (cases.Count == 0)
                throw new ApplicationFault(409,
                    "У пациента нет открытого медицинского случая в вашей организации");
            medicalCase = cases[0];
        }
        parameters["case"] = (long)medicalCase["id"]!;
        parameters["organization"] = (long)medicalCase["organizationId"]!;
        if (orderedAt < HospitalTimestamp(medicalCase["openedAt"]))
            throw new ApplicationFault(409, "Дата заказа раньше открытия медицинского случая");

        var tests = await RowsAsync("""
            SELECT t.id, t.profile_id AS "profileId" FROM project.lab_test_types t WHERE t.id = @test
            """, parameters, cancellationToken);
        if (tests.Count == 0) throw new ApplicationFault(404, "Вид исследования не найден");
        parameters["profile"] = (long)tests[0]["profileId"]!;

        long contractId;
        if (request.ContractId is > 0)
        {
            parameters["contract"] = request.ContractId.Value;
            var contracts = await RowsAsync("""
                SELECT contract.id, contract.organization_id AS "organizationId",
                    contract.valid_from AS "validFrom", contract.valid_until AS "validUntil",
                    contract.is_active AS "contractActive", l.is_active AS "laboratoryActive",
                    EXISTS (SELECT 1 FROM project.laboratory_profile_links link
                        WHERE link.laboratory_id = contract.laboratory_id AND link.profile_id = @profile)
                        AS "profileServed"
                FROM project.laboratory_contracts contract
                JOIN project.laboratories l ON l.id = contract.laboratory_id
                WHERE contract.id = @contract
                """, parameters, cancellationToken);
            if (contracts.Count == 0) throw new ApplicationFault(404, "Договор лаборатории не найден");
            var contract = contracts[0];
            if ((long)contract["organizationId"]! != (long)medicalCase["organizationId"]!)
                throw new ApplicationFault(409, "Договор заключён с другим учреждением");
            if (!(bool)contract["contractActive"]! || !(bool)contract["laboratoryActive"]!)
                throw new ApplicationFault(409, "Договор или лаборатория не действуют");
            if (orderDate < HospitalDate(contract["validFrom"]!) || orderDate > HospitalDate(contract["validUntil"]!))
                throw new ApplicationFault(409, "Договор не действует на дату заказа");
            if (!(bool)contract["profileServed"]!)
                throw new ApplicationFault(409, "Лаборатория не выполняет этот вид исследования");
            contractId = (long)contract["id"]!;
        }
        else
        {
            var contracts = await RowsAsync("""
                SELECT contract.id
                FROM project.laboratory_contracts contract
                JOIN project.laboratories l ON l.id = contract.laboratory_id AND l.is_active
                JOIN project.laboratory_profile_links link
                    ON link.laboratory_id = contract.laboratory_id AND link.profile_id = @profile
                WHERE contract.organization_id = @organization AND contract.is_active
                  AND @orderDate BETWEEN contract.valid_from AND contract.valid_until
                ORDER BY contract.valid_until DESC, contract.id LIMIT 1
                """, parameters, cancellationToken);
            if (contracts.Count == 0)
                throw new ApplicationFault(409,
                    "Нет действующего договора лаборатории с подходящим профилем на дату заказа");
            contractId = (long)contracts[0]["id"]!;
        }

        parameters["contract"] = contractId;
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var id = await TxScalarAsync(connection, transaction, """
                INSERT INTO project.lab_orders(case_id, doctor_id, test_type_id, contract_id, ordered_at)
                VALUES (@case, @employee, @test, @contract, @ordered)
                RETURNING id
                """, parameters, cancellationToken);
            await HospitalAuditAsync(connection, transaction, access.UserId, "insert", "lab_order", id, requestId,
                ["case_id", "test_type_id", "contract_id"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error)
        {
            throw LabWriteFault(error);
        }
    }

    // ---------- Результат исследования ----------

    public async Task<long> SubmitLabResultAsync(UserAccess access, long orderId, SubmitLabResultRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        RequireLabStaff(access);
        if (string.IsNullOrWhiteSpace(request.Value))
            throw new ApplicationFault(400, "Укажите значение результата");
        var performedAt = request.PerformedAt;
        if (performedAt == default) throw new ApplicationFault(400, "Не указано время выполнения измерения");
        if (performedAt > DateTimeOffset.UtcNow.AddSeconds(30))
            throw new ApplicationFault(400, "Время выполнения не может быть позже текущего момента");
        var parameters = AccessParameters(access);
        parameters["id"] = orderId;
        var resultText = ComposeLabResultText(request.Value, request.Unit, request.ReferenceRange,
            request.Conclusion);
        parameters["text"] = resultText;
        parameters["measured"] = performedAt;
        // AddParameters привязывает неизвестные типы как text; числовое значение приводится
        // к numeric явным приведением в SQL, чтобы NULL тоже имел тип numeric.
        parameters["numeric"] = LabNumericValue(request.Value)?.ToString(CultureInfo.InvariantCulture);
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            // Строка заказа блокируется: параллельные исправления не создают две ветви истории.
            var orders = await TxRowsAsync(connection, transaction, """
                SELECT lo.id, lo.status, lo.ordered_at AS "orderedAt",
                    contract.laboratory_id AS "laboratoryId"
                FROM project.lab_orders lo
                JOIN project.laboratory_contracts contract ON contract.id = lo.contract_id
                WHERE lo.id = @id
                FOR UPDATE OF lo
                """, parameters, cancellationToken);
            if (orders.Count == 0) throw new ApplicationFault(404, "Заказ исследования не найден");
            var order = orders[0];
            if (!access.LaboratoryIds.Contains((long)order["laboratoryId"]!))
                throw new ApplicationFault(403, "Заказ принадлежит другой лаборатории");
            var orderStatus = (string)order["status"]!;
            if (orderStatus == "cancelled")
                throw new ApplicationFault(409, "Заказ отменён: результат не вносится");
            if (orderStatus is not ("ordered" or "in_progress" or "completed"))
                throw new ApplicationFault(409, "Заказ в состоянии, не допускающем ввод результата");
            if (performedAt < HospitalTimestamp(order["orderedAt"]))
                throw new ApplicationFault(409, "Измерение не может быть раньше даты заказа");

            var current = await TxRowsAsync(connection, transaction, """
                SELECT result.id, result.measured_at AS "measuredAt", result.entered_at AS "enteredAt"
                FROM project.lab_results result
                WHERE result.order_id = @id
                  AND NOT EXISTS (SELECT 1 FROM project.lab_results next
                      WHERE next.supersedes_result_id = result.id)
                ORDER BY result.id DESC LIMIT 1
                FOR UPDATE OF result
                """, parameters, cancellationToken);
            var isCorrection = current.Count == 1;
            if (isCorrection)
            {
                // Исправление создаёт новую запись той же цепочки и не меняет статус заказа.
                if (orderStatus != "completed")
                    throw new ApplicationFault(409,
                        "По заказу уже есть результат, но заказ не завершён: требуется проверка администратора");
                if (performedAt < HospitalTimestamp(current[0]["measuredAt"]))
                    throw new ApplicationFault(409, "Время исправленного измерения раньше предыдущего результата");
                parameters["supersedes"] = (long)current[0]["id"]!;
            }
            else
            {
                parameters["supersedes"] = null;
            }
            var id = await TxScalarAsync(connection, transaction, """
                INSERT INTO project.lab_results(order_id, entered_by_user_id, result_text, numeric_value,
                    measured_at, entered_at, supersedes_result_id)
                VALUES (@id, @actor, @text, @numeric::numeric, @measured,
                    GREATEST(CURRENT_TIMESTAMP, @measured), @supersedes::bigint)
                RETURNING id
                """, new Dictionary<string, object?>(parameters) { ["actor"] = access.UserId },
                cancellationToken);
            // Отложенное правило 002 требует результат у завершённого заказа и запрещает результат
            // у незавершённого, поэтому первый результат и статус completed меняются одной транзакцией.
            if (!isCorrection && orderStatus != "completed")
            {
                await TxExecuteAsync(connection, transaction, """
                    UPDATE project.lab_orders SET status = 'completed' WHERE id = @id AND status IN ('ordered', 'in_progress')
                    """, parameters, cancellationToken);
            }
            await HospitalAuditAsync(connection, transaction, access.UserId, "insert", "lab_result", id, requestId,
                ["order_id", "measured_at", "supersedes_result_id"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error)
        {
            throw LabWriteFault(error);
        }
    }
}
