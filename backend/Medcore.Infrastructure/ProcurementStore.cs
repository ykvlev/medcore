using System.Data;
using System.Globalization;
using Medcore.Application;
using Npgsql;

namespace Medcore.Infrastructure;

// Закупки (миграция 008): поставщики, договоры с поставщиками, тендеры и счета.
// Область — организации пользователя по его роли закупок; суммы и оплаченные части
// считает сервер, приложение получает decimal. Все записи идут в транзакции вместе
// с записью аудита, значения передаются только параметрами.
public sealed partial class MedcoreStore
{
    private static readonly string[] ContractStatuses = ["draft", "active", "closed"];

    private static readonly string[] TenderStatuses = ["announced", "evaluating", "awarded", "cancelled"];

    private static readonly string[] InvoiceStatuses = ["issued", "paid", "overdue"];

    // numeric приходит в PostgreSQL как текст: суммы передаются строкой с точкой,
    // чтобы разделитель текущей культуры не попал в SQL.
    private static string ProcurementAmount(decimal value) => value.ToString(CultureInfo.InvariantCulture);

    // Npgsql принимает в timestamptz только смещение 0, а клиент присылает московское
    // время со смещением +03:00, поэтому момент приводится к UTC до привязки параметра.
    private static DateTimeOffset ProcurementInstant(DateTimeOffset value) => value.ToUniversalTime();

    private static long ResolveProcurementOrganization(long? requested, long[] organizations)
    {
        if (requested is > 0)
        {
            if (!organizations.Contains(requested.Value))
                throw new ApplicationFault(403, "Организация вне вашей области закупок");
            return requested.Value;
        }
        if (organizations.Length == 0)
            throw new ApplicationFault(403, "Учётная запись не привязана к организации закупок");
        return organizations[0];
    }

    private static string? ProcurementOptional(string? value, int limit, string field)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text)) return null;
        if (text.Length > limit) throw new ApplicationFault(422, $"{field} длиннее {limit} символов");
        return text;
    }

    private static string ProcurementRequired(string? value, int limit, string field)
    {
        var text = value?.Trim();
        if (string.IsNullOrEmpty(text)) throw new ApplicationFault(422, $"Укажите {field}");
        if (text.Length > limit) throw new ApplicationFault(422, $"{field} длиннее {limit} символов");
        return text;
    }

    private static SupplierRow ToSupplierRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (string)row["name"]!, row["inn"] as string, row["contact"] as string,
        (bool)row["isActive"]!);

    private static ContractRow ToContractRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (string)row["number"]!, (long)row["supplierId"]!, (string)row["supplierName"]!,
        (long)row["organizationId"]!, (string)row["organizationName"]!, HospitalDate(row["signedAt"]!),
        row["validUntil"] is null ? null : HospitalDate(row["validUntil"]), (decimal)row["amount"]!,
        (string)row["status"]!, (int)row["invoicesCount"]!, (decimal)row["paidAmount"]!);

    private static TenderRow ToTenderRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (string)row["title"]!, (long)row["organizationId"]!,
        (string)row["organizationName"]!, HospitalTimestamp(row["announcedAt"]!),
        HospitalTimestamp(row["closesAt"]!), (string)row["status"]!, (decimal)row["budget"]!,
        row["winnerSupplierId"] is null ? null : (long)row["winnerSupplierId"]!,
        row["winnerSupplierName"] as string);

    private static InvoiceRow ToInvoiceRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (long)row["contractId"]!, (string)row["contractNumber"]!,
        (string)row["supplierName"]!, (string)row["number"]!, HospitalDate(row["issuedAt"]!),
        HospitalDate(row["dueAt"]!), (decimal)row["amount"]!, (string)row["status"]!,
        HospitalTimestampOrNull(row["paidAt"]));

    // ---------- Поставщики ----------

    public async Task<SupplierList> SuppliersAsync(UserAccess access, string? search,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadProcurement(access))
            throw new ApplicationFault(403, "Нет доступа к поставщикам закупок");
        var query = string.IsNullOrWhiteSpace(search) ? null : search.Trim();
        if (query is { Length: > 100 }) throw new ApplicationFault(422, "Слишком длинный поисковый запрос");
        var parameters = new Dictionary<string, object?> { ["search"] = query is null ? null : $"%{query}%" };
        var rows = await RowsAsync("""
            SELECT s.id, s.name, s.inn, s.contact, s.is_active AS "isActive"
            FROM project.suppliers s
            WHERE (@search IS NULL OR s.name ILIKE @search OR s.inn ILIKE @search OR s.contact ILIKE @search)
            ORDER BY s.name, s.id
            LIMIT 500
            """, parameters, cancellationToken);
        return new(rows.Select(ToSupplierRow).ToArray());
    }

    public async Task<long> CreateSupplierAsync(UserAccess access, CreateSupplierRequest request, string requestId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanManageProcurement(access))
            throw new ApplicationFault(403,
                "Поставщика добавляет администратор организации, главный врач или заместитель");
        if (AccessPolicies.ProcurementOrganizationIds(access).Length == 0)
            throw new ApplicationFault(403, "Учётная запись не привязана к организации закупок");
        var name = ProcurementRequired(request.Name, 200, "название поставщика");
        var inn = ProcurementOptional(request.Inn, 20, "ИНН");
        var contact = ProcurementOptional(request.Contact, 200, "контакт");
        var parameters = new Dictionary<string, object?> { ["name"] = name, ["inn"] = inn, ["contact"] = contact };
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var id = await TxScalarAsync(connection, transaction, """
                INSERT INTO project.suppliers(name, inn, contact) VALUES (@name, @inn, @contact)
                RETURNING id
                """, parameters, cancellationToken);
            await HospitalAuditAsync(connection, transaction, access.UserId, "insert", "supplier", id, requestId,
                ["name", "inn", "contact"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error) when (error.SqlState == "23505")
        {
            throw new ApplicationFault(409, "Поставщик с таким названием уже есть");
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // ---------- Договоры ----------

    public async Task<ContractList> ContractsAsync(UserAccess access, string? status, long? supplierId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadProcurement(access))
            throw new ApplicationFault(403, "Нет доступа к договорам закупок");
        var normalizedStatus = string.IsNullOrWhiteSpace(status) ? null : status.Trim().ToLowerInvariant();
        if (normalizedStatus is not null && Array.IndexOf(ContractStatuses, normalizedStatus) < 0)
            throw new ApplicationFault(422, "Статус договора: draft, active или closed");
        var parameters = new Dictionary<string, object?>
        {
            ["procurement_orgs"] = AccessPolicies.ProcurementOrganizationIds(access),
            ["status"] = normalizedStatus,
            ["supplier"] = supplierId is > 0 ? supplierId.Value : null
        };
        var rows = await RowsAsync("""
            SELECT contract.id, contract.number, contract.supplier_id AS "supplierId",
                supplier.name AS "supplierName", contract.organization_id AS "organizationId",
                organization.name AS "organizationName", contract.signed_at AS "signedAt",
                contract.valid_until AS "validUntil", contract.amount, contract.status,
                (SELECT count(*)::int FROM project.supplier_invoices invoice
                    WHERE invoice.contract_id = contract.id) AS "invoicesCount",
                (SELECT coalesce(sum(invoice.amount), 0) FROM project.supplier_invoices invoice
                    WHERE invoice.contract_id = contract.id AND invoice.status = 'paid') AS "paidAmount"
            FROM project.procurement_contracts contract
            JOIN project.suppliers supplier ON supplier.id = contract.supplier_id
            JOIN project.medical_organizations organization ON organization.id = contract.organization_id
            WHERE contract.organization_id = ANY(@procurement_orgs)
              AND (@status IS NULL OR contract.status = @status)
              AND (@supplier::bigint IS NULL OR contract.supplier_id = @supplier::bigint)
            ORDER BY contract.signed_at DESC, contract.id DESC
            LIMIT 500
            """, parameters, cancellationToken);
        return new(rows.Select(ToContractRow).ToArray());
    }

    public async Task<long> CreateContractAsync(UserAccess access, CreateContractRequest request, string requestId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanManageProcurement(access))
            throw new ApplicationFault(403,
                "Договор оформляет администратор организации, главный врач или заместитель");
        var organization = ResolveProcurementOrganization(null, AccessPolicies.ProcurementOrganizationIds(access));
        var number = ProcurementRequired(request.Number, 100, "номер договора");
        if (request.SignedAt == default) throw new ApplicationFault(422, "Укажите дату подписания договора");
        if (request.ValidUntil is { } validUntil && validUntil < request.SignedAt)
            throw new ApplicationFault(422, "Срок действия договора раньше даты подписания");
        if (request.Amount is < 0 or > 999_999_999_999.99m)
            throw new ApplicationFault(422, "Сумма договора — от 0 до 999999999999,99");
        var note = ProcurementOptional(request.Note, 2000, "Примечание");
        var parameters = new Dictionary<string, object?>
        {
            ["org"] = organization,
            ["supplier"] = request.SupplierId,
            ["number"] = number,
            ["signed"] = request.SignedAt,
            ["valid_until"] = request.ValidUntil,
            ["amount"] = ProcurementAmount(request.Amount),
            ["note"] = note
        };
        if (await RowsAsync("""
            SELECT supplier.id FROM project.suppliers supplier
            WHERE supplier.id = @supplier AND supplier.is_active
            """, parameters, cancellationToken) is { Count: 0 })
            throw new ApplicationFault(404, "Поставщик не найден или неактивен");
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var id = await TxScalarAsync(connection, transaction, """
                INSERT INTO project.procurement_contracts(organization_id, supplier_id, number, signed_at,
                    valid_until, amount, status, note)
                VALUES (@org, @supplier, @number, @signed, @valid_until::date, @amount::numeric, 'draft', @note)
                RETURNING id
                """, parameters, cancellationToken);
            await HospitalAuditAsync(connection, transaction, access.UserId, "insert", "procurement_contract",
                id, requestId, ["organization_id", "supplier_id", "number", "amount"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error) when (error.SqlState == "23505")
        {
            throw new ApplicationFault(409, "Договор с таким номером уже есть в организации");
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // Договор проходит draft → active → closed; возврат в предыдущий статус запрещён.
    public async Task ChangeContractStatusAsync(UserAccess access, long id, ContractStatusRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanManageProcurement(access))
            throw new ApplicationFault(403,
                "Статус договора меняет администратор организации, главный врач или заместитель");
        var status = (request.Status ?? string.Empty).Trim().ToLowerInvariant();
        if (Array.IndexOf(ContractStatuses, status) < 0)
            throw new ApplicationFault(422, "Статус договора: draft, active или closed");
        var parameters = new Dictionary<string, object?>
        {
            ["procurement_orgs"] = AccessPolicies.ProcurementOrganizationIds(access),
            ["id"] = id,
            ["status"] = status
        };
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var rows = await TxRowsAsync(connection, transaction, """
                SELECT contract.id, contract.status FROM project.procurement_contracts contract
                WHERE contract.id = @id AND contract.organization_id = ANY(@procurement_orgs)
                FOR UPDATE OF contract
                """, parameters, cancellationToken);
            if (rows.Count == 0) throw new ApplicationFault(404, "Договор не найден в доступной области");
            var current = (string)rows[0]["status"]!;
            var allowed = current switch
            {
                "draft" => status == "active",
                "active" => status == "closed",
                _ => false
            };
            if (!allowed)
                throw new ApplicationFault(409, current switch
                {
                    "draft" => "Черновик договора переводится только в active",
                    "active" => "Действующий договор переводится только в closed",
                    _ => "Закрытый договор изменить нельзя"
                });
            parameters["current"] = current;
            if (await TxExecuteAsync(connection, transaction,
                    "UPDATE project.procurement_contracts SET status = @status WHERE id = @id AND status = @current",
                    parameters, cancellationToken) == 0)
                throw new ApplicationFault(409, "Договор уже изменён другим пользователем");
            await HospitalAuditAsync(connection, transaction, access.UserId, "contract_status",
                "procurement_contract", id, requestId, ["status"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // ---------- Тендеры ----------

    public async Task<TenderList> TendersAsync(UserAccess access, string? status, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadProcurement(access))
            throw new ApplicationFault(403, "Нет доступа к тендерам закупок");
        var normalizedStatus = string.IsNullOrWhiteSpace(status) ? null : status.Trim().ToLowerInvariant();
        if (normalizedStatus is not null && Array.IndexOf(TenderStatuses, normalizedStatus) < 0)
            throw new ApplicationFault(422, "Статус тендера: announced, evaluating, awarded или cancelled");
        var parameters = new Dictionary<string, object?>
        {
            ["procurement_orgs"] = AccessPolicies.ProcurementOrganizationIds(access),
            ["status"] = normalizedStatus
        };
        var rows = await RowsAsync("""
            SELECT tender.id, tender.title, tender.organization_id AS "organizationId",
                organization.name AS "organizationName", tender.announced_at AS "announcedAt",
                tender.closes_at AS "closesAt", tender.status, tender.budget,
                tender.winner_supplier_id AS "winnerSupplierId", winner.name AS "winnerSupplierName"
            FROM project.procurement_tenders tender
            JOIN project.medical_organizations organization ON organization.id = tender.organization_id
            LEFT JOIN project.suppliers winner ON winner.id = tender.winner_supplier_id
            WHERE tender.organization_id = ANY(@procurement_orgs)
              AND (@status IS NULL OR tender.status = @status)
            ORDER BY tender.closes_at DESC, tender.id DESC
            LIMIT 500
            """, parameters, cancellationToken);
        return new(rows.Select(ToTenderRow).ToArray());
    }

    public async Task<long> CreateTenderAsync(UserAccess access, CreateTenderRequest request, string requestId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanManageProcurement(access))
            throw new ApplicationFault(403,
                "Тендер объявляет администратор организации, главный врач или заместитель");
        var organization = ResolveProcurementOrganization(null, AccessPolicies.ProcurementOrganizationIds(access));
        var title = ProcurementRequired(request.Title, 300, "название закупки");
        if (request.ClosesAt <= DateTimeOffset.UtcNow)
            throw new ApplicationFault(422, "Срок подачи заявок должен быть в будущем");
        if (request.Budget is < 0 or > 999_999_999_999.99m)
            throw new ApplicationFault(422, "Бюджет закупки — от 0 до 999999999999,99");
        var note = ProcurementOptional(request.Note, 2000, "Примечание");
        var parameters = new Dictionary<string, object?>
        {
            ["org"] = organization,
            ["title"] = title,
            ["closes"] = ProcurementInstant(request.ClosesAt),
            ["budget"] = ProcurementAmount(request.Budget),
            ["note"] = note
        };
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var id = await TxScalarAsync(connection, transaction, """
                INSERT INTO project.procurement_tenders(organization_id, title, announced_at, closes_at,
                    status, budget, note)
                VALUES (@org, @title, CURRENT_TIMESTAMP, @closes, 'announced', @budget::numeric, @note)
                RETURNING id
                """, parameters, cancellationToken);
            await HospitalAuditAsync(connection, transaction, access.UserId, "insert", "procurement_tender",
                id, requestId, ["organization_id", "title", "closes_at", "budget"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    public async Task UpdateTenderAsync(UserAccess access, long id, TenderUpdateRequest request, string requestId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanManageProcurement(access))
            throw new ApplicationFault(403,
                "Тендер ведёт администратор организации, главный врач или заместитель");
        var status = (request.Status ?? string.Empty).Trim().ToLowerInvariant();
        if (Array.IndexOf(TenderStatuses, status) < 0)
            throw new ApplicationFault(422, "Статус тендера: announced, evaluating, awarded или cancelled");
        if (status == "awarded" && request.WinnerSupplierId is not > 0)
            throw new ApplicationFault(422, "Для статуса awarded укажите поставщика-победителя");
        var parameters = new Dictionary<string, object?>
        {
            ["procurement_orgs"] = AccessPolicies.ProcurementOrganizationIds(access),
            ["id"] = id,
            ["status"] = status,
            ["winner"] = status == "awarded" ? request.WinnerSupplierId!.Value : null
        };
        if (status == "awarded"
            && await RowsAsync("""
                SELECT supplier.id FROM project.suppliers supplier
                WHERE supplier.id = @winner::bigint AND supplier.is_active
                """, parameters, cancellationToken) is { Count: 0 })
            throw new ApplicationFault(422, "Поставщик-победитель не найден или неактивен");
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var rows = await TxRowsAsync(connection, transaction, """
                SELECT tender.id, tender.status FROM project.procurement_tenders tender
                WHERE tender.id = @id AND tender.organization_id = ANY(@procurement_orgs)
                FOR UPDATE OF tender
                """, parameters, cancellationToken);
            if (rows.Count == 0) throw new ApplicationFault(404, "Тендер не найден в доступной области");
            var current = (string)rows[0]["status"]!;
            var allowed = current switch
            {
                "announced" => status is "evaluating" or "awarded" or "cancelled",
                "evaluating" => status is "awarded" or "cancelled",
                _ => false
            };
            if (!allowed)
                throw new ApplicationFault(409, current switch
                {
                    "awarded" => "Тендер уже признан состоявшимся: статус неизменяем",
                    "cancelled" => "Тендер уже отменён: статус неизменяем",
                    _ => "Тендер в состоянии, не допускающем смену статуса"
                });
            parameters["current"] = current;
            if (await TxExecuteAsync(connection, transaction, """
                UPDATE project.procurement_tenders
                SET status = @status, winner_supplier_id = @winner::bigint
                WHERE id = @id AND status = @current
                """, parameters, cancellationToken) == 0)
                throw new ApplicationFault(409, "Тендер уже изменён другим пользователем");
            await HospitalAuditAsync(connection, transaction, access.UserId, "tender_status", "procurement_tender",
                id, requestId, ["status", "winner_supplier_id"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // ---------- Счета ----------

    public async Task<InvoiceList> InvoicesAsync(UserAccess access, string? status, long? contractId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadProcurement(access))
            throw new ApplicationFault(403, "Нет доступа к счетам закупок");
        var normalizedStatus = string.IsNullOrWhiteSpace(status) ? null : status.Trim().ToLowerInvariant();
        if (normalizedStatus is not null && Array.IndexOf(InvoiceStatuses, normalizedStatus) < 0)
            throw new ApplicationFault(422, "Статус счёта: issued, paid или overdue");
        var parameters = new Dictionary<string, object?>
        {
            ["procurement_orgs"] = AccessPolicies.ProcurementOrganizationIds(access),
            ["status"] = normalizedStatus,
            ["contract"] = contractId is > 0 ? contractId.Value : null
        };
        var rows = await RowsAsync("""
            SELECT invoice.id, invoice.contract_id AS "contractId", contract.number AS "contractNumber",
                supplier.name AS "supplierName", invoice.number, invoice.issued_at AS "issuedAt",
                invoice.due_at AS "dueAt", invoice.amount, invoice.status, invoice.paid_at AS "paidAt"
            FROM project.supplier_invoices invoice
            JOIN project.procurement_contracts contract ON contract.id = invoice.contract_id
            JOIN project.suppliers supplier ON supplier.id = contract.supplier_id
            WHERE contract.organization_id = ANY(@procurement_orgs)
              AND (@status IS NULL OR invoice.status = @status)
              AND (@contract::bigint IS NULL OR invoice.contract_id = @contract::bigint)
            ORDER BY invoice.issued_at DESC, invoice.id DESC
            LIMIT 500
            """, parameters, cancellationToken);
        return new(rows.Select(ToInvoiceRow).ToArray());
    }

    public async Task<long> CreateInvoiceAsync(UserAccess access, CreateInvoiceRequest request, string requestId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanManageProcurement(access))
            throw new ApplicationFault(403,
                "Счёт регистрирует администратор организации, главный врач или заместитель");
        var number = ProcurementRequired(request.Number, 100, "номер счёта");
        if (request.IssuedAt == default) throw new ApplicationFault(422, "Укажите дату выставления счёта");
        if (request.DueAt < request.IssuedAt)
            throw new ApplicationFault(422, "Срок оплаты раньше даты выставления счёта");
        if (request.Amount is < 0 or > 999_999_999_999.99m)
            throw new ApplicationFault(422, "Сумма счёта — от 0 до 999999999999,99");
        var parameters = new Dictionary<string, object?>
        {
            ["procurement_orgs"] = AccessPolicies.ProcurementOrganizationIds(access),
            ["contract"] = request.ContractId,
            ["number"] = number,
            ["issued"] = request.IssuedAt,
            ["due"] = request.DueAt,
            ["amount"] = ProcurementAmount(request.Amount)
        };
        var contract = await RowsAsync("""
            SELECT contract.id, contract.status FROM project.procurement_contracts contract
            WHERE contract.id = @contract AND contract.organization_id = ANY(@procurement_orgs)
            """, parameters, cancellationToken);
        if (contract.Count == 0) throw new ApplicationFault(404, "Договор не найден в доступной области");
        if ((string)contract[0]["status"]! == "closed")
            throw new ApplicationFault(409, "По закрытому договору счёт не выставляется");
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var id = await TxScalarAsync(connection, transaction, """
                INSERT INTO project.supplier_invoices(contract_id, number, issued_at, due_at, amount, status)
                VALUES (@contract, @number, @issued, @due, @amount::numeric, 'issued')
                RETURNING id
                """, parameters, cancellationToken);
            await HospitalAuditAsync(connection, transaction, access.UserId, "insert", "supplier_invoice", id,
                requestId, ["contract_id", "number", "issued_at", "due_at", "amount"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return id;
        }
        catch (PostgresException error) when (error.SqlState == "23505")
        {
            throw new ApplicationFault(409, "Счёт с таким номером уже есть у договора");
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // Оплата счёта: paid и paid_at одной транзакцией; повторная оплата — 409.
    public async Task PayInvoiceAsync(UserAccess access, long id, string requestId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanManageProcurement(access))
            throw new ApplicationFault(403,
                "Оплату счёта отмечает администратор организации, главный врач или заместитель");
        var parameters = new Dictionary<string, object?>
        {
            ["procurement_orgs"] = AccessPolicies.ProcurementOrganizationIds(access),
            ["id"] = id
        };
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var rows = await TxRowsAsync(connection, transaction, """
                SELECT invoice.id, invoice.status, invoice.paid_at AS "paidAt"
                FROM project.supplier_invoices invoice
                JOIN project.procurement_contracts contract ON contract.id = invoice.contract_id
                WHERE invoice.id = @id AND contract.organization_id = ANY(@procurement_orgs)
                FOR UPDATE OF invoice
                """, parameters, cancellationToken);
            if (rows.Count == 0) throw new ApplicationFault(404, "Счёт не найден в доступной области");
            if ((string)rows[0]["status"]! == "paid") throw new ApplicationFault(409, "Счёт уже оплачен");
            if (await TxExecuteAsync(connection, transaction, """
                UPDATE project.supplier_invoices SET status = 'paid', paid_at = CURRENT_TIMESTAMP
                WHERE id = @id AND status <> 'paid'
                """, parameters, cancellationToken) == 0)
                throw new ApplicationFault(409, "Счёт уже оплачен");
            await HospitalAuditAsync(connection, transaction, access.UserId, "pay", "supplier_invoice", id,
                requestId, ["status", "paid_at"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }
}
