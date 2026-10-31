using System.Data;
using System.Globalization;
using Medcore.Application;
using Npgsql;

namespace Medcore.Infrastructure;

// Снабжение (миграция 007): остатки и дефицит по организации пользователя, заказы,
// приём заказа с увеличением остатка. Остаток и минимум — numeric, поэтому суммы
// считаются на сервере, а приложение получает decimal.
public sealed partial class MedcoreStore
{
    private static readonly string[] SupplyCategories = ["medicine", "consumable"];

    private static readonly string[] SupplyOrderStatuses = ["ordered", "received", "cancelled"];

    private const string SupplyItemsSql = """
        SELECT item.id, item.code, item.name, item.category, item.unit,
            stock.quantity, stock.min_quantity AS "minQuantity",
            (stock.quantity < stock.min_quantity) AS deficit,
            organization.name AS "organizationName"
        FROM project.supply_stock stock
        JOIN project.supply_items item ON item.id = stock.item_id
        JOIN project.medical_organizations organization ON organization.id = stock.organization_id
        WHERE stock.organization_id = @org AND item.is_active
          AND (@search IS NULL OR item.code ILIKE @search OR item.name ILIKE @search)
          AND (@category IS NULL OR item.category = @category)
          AND (NOT @deficit_only OR stock.quantity < stock.min_quantity)
        ORDER BY (stock.quantity < stock.min_quantity) DESC, item.category, item.name, item.id
        """;

    // Организация снабжения: явный запрос обязан попадать в область роли, иначе берётся
    // первая организация по приоритету роли (администратор, главный врач, зам, зав.).
    private static long ResolveSupplyOrganization(long? requested, long[] organizations)
    {
        if (requested is > 0)
        {
            if (!organizations.Contains(requested.Value))
                throw new ApplicationFault(403, "Организация вне вашей области снабжения");
            return requested.Value;
        }
        if (organizations.Length == 0)
            throw new ApplicationFault(403, "Учётная запись не привязана к организации снабжения");
        return organizations[0];
    }

    private static SupplyItemRow ToSupplyItemRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (string)row["code"]!, (string)row["name"]!, (string)row["category"]!,
        (string)row["unit"]!, (decimal)row["quantity"]!, (decimal)row["minQuantity"]!,
        (bool)row["deficit"]!, (string)row["organizationName"]!);

    private static SupplyOrderRow ToSupplyOrderRow(Dictionary<string, object?> row) => new(
        (long)row["id"]!, (string)row["supplier"]!, (string)row["status"]!,
        HospitalTimestamp(row["orderedAt"]!),
        row["expectedAt"] is null ? null : HospitalDate(row["expectedAt"]),
        HospitalTimestampOrNull(row["receivedAt"]), (int)row["itemCount"]!, (decimal)row["total"]!,
        row["note"] as string);

    // ---------- Остатки ----------

    public async Task<SupplyItemList> SupplyItemsAsync(UserAccess access, long? organizationId, string? search,
        string? category, bool onlyDeficit, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadSupplies(access))
            throw new ApplicationFault(403, "Нет доступа к остаткам снабжения");
        var normalizedCategory = string.IsNullOrWhiteSpace(category) ? null : category.Trim().ToLowerInvariant();
        if (normalizedCategory is not null && Array.IndexOf(SupplyCategories, normalizedCategory) < 0)
            throw new ApplicationFault(422, "Категория позиции: medicine или consumable");
        var query = string.IsNullOrWhiteSpace(search) ? null : search.Trim();
        if (query is { Length: > 100 }) throw new ApplicationFault(422, "Слишком длинный поисковый запрос");
        var organization = ResolveSupplyOrganization(organizationId, AccessPolicies.SupplyOrganizationIds(access));
        var parameters = new Dictionary<string, object?>
        {
            ["org"] = organization,
            ["search"] = query is null ? null : $"%{query}%",
            ["category"] = normalizedCategory,
            ["deficit_only"] = onlyDeficit
        };
        var rows = await RowsAsync(SupplyItemsSql, parameters, cancellationToken);
        return new(rows.Select(ToSupplyItemRow).ToArray());
    }

    // ---------- Заказы ----------

    public async Task<PageResult<SupplyOrderRow>> SupplyOrdersPageAsync(UserAccess access, long? organizationId,
        string? status, int page, int pageSize, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadSupplies(access))
            throw new ApplicationFault(403, "Нет доступа к заказам снабжения");
        if (page < 1 || pageSize is < 1 or > 100 || (long)(page - 1) * pageSize > int.MaxValue)
            throw new ApplicationFault(400, "Некорректные параметры страницы");
        var normalizedStatus = string.IsNullOrWhiteSpace(status) ? null : status.Trim().ToLowerInvariant();
        if (normalizedStatus is not null && Array.IndexOf(SupplyOrderStatuses, normalizedStatus) < 0)
            throw new ApplicationFault(422, "Статус заказа: ordered, received или cancelled");
        var organization = ResolveSupplyOrganization(organizationId, AccessPolicies.SupplyOrganizationIds(access));
        var parameters = new Dictionary<string, object?>
        {
            ["org"] = organization,
            ["status"] = normalizedStatus,
            ["limit"] = pageSize,
            ["offset"] = (page - 1) * pageSize
        };
        const string orderSql = """
            SELECT o.id, o.supplier, o.status, o.ordered_at AS "orderedAt", o.expected_at AS "expectedAt",
                o.received_at AS "receivedAt", o.note,
                (SELECT count(*)::int FROM project.supply_order_items i WHERE i.order_id = o.id) AS "itemCount",
                (SELECT coalesce(sum(i.quantity * i.unit_price), 0)
                    FROM project.supply_order_items i WHERE i.order_id = o.id) AS total
            """;
        const string filter = """
            FROM project.supply_orders o
            WHERE o.organization_id = @org AND (@status IS NULL OR o.status = @status)
            """;
        // COUNT и страница уходят одним пакетом: один round-trip на список заказов.
        var batch = await BatchRowsAsync([
            "SELECT count(*)::bigint AS total " + filter,
            $"{orderSql} {filter} ORDER BY o.ordered_at DESC, o.id DESC LIMIT @limit OFFSET @offset"
        ], parameters, cancellationToken);
        var total = (int)(long)batch[0][0]["total"]!;
        return new(batch[1].Select(ToSupplyOrderRow).ToArray(), total, page, pageSize);
    }

    public async Task<long> CreateSupplyOrderAsync(UserAccess access, CreateSupplyOrderRequest request,
        string requestId, CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanManageSupplyOrders(access))
            throw new ApplicationFault(403,
                "Заказ снабжения оформляет администратор организации, главный врач или заместитель");
        var supplier = (request.Supplier ?? string.Empty).Trim();
        if (supplier.Length == 0) throw new ApplicationFault(422, "Укажите поставщика");
        if (supplier.Length > 200) throw new ApplicationFault(422, "Название поставщика длиннее 200 символов");
        var note = request.Note?.Trim();
        if (note is { Length: 0 }) note = null;
        if (note is { Length: > 2000 }) throw new ApplicationFault(422, "Примечание длиннее 2000 символов");
        var items = request.Items ?? [];
        if (items.Length == 0) throw new ApplicationFault(422, "Добавьте хотя бы одну позицию заказа");
        if (items.Length > 200) throw new ApplicationFault(422, "В заказе не больше 200 позиций");
        if (items.Any(item => item.Quantity <= 0))
            throw new ApplicationFault(422, "Количество позиции должно быть больше нуля");
        if (items.Any(item => item.UnitPrice < 0))
            throw new ApplicationFault(422, "Цена позиции не может быть отрицательной");
        var itemIds = items.Select(item => item.ItemId).Distinct().ToArray();
        if (itemIds.Length != items.Length)
            throw new ApplicationFault(422, "Позиции заказа не должны повторяться");
        var organization = ResolveSupplyOrganization(null, AccessPolicies.SupplyManagerOrganizationIds(access));
        var parameters = new Dictionary<string, object?>
        {
            ["org"] = organization,
            ["supplier"] = supplier,
            ["note"] = note,
            ["expected"] = request.ExpectedAt,
            ["item_ids"] = itemIds
        };
        var known = await RowsAsync("""
            SELECT item.id FROM project.supply_items item
            WHERE item.id = ANY(@item_ids) AND item.is_active
            """, parameters, cancellationToken);
        if (known.Count != itemIds.Length)
            throw new ApplicationFault(422, "Некоторые позиции не найдены в справочнике снабжения");

        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var orderId = await TxScalarAsync(connection, transaction, """
                INSERT INTO project.supply_orders(organization_id, supplier, status, ordered_at, expected_at, note)
                VALUES (@org, @supplier, 'ordered', CURRENT_TIMESTAMP, @expected::date, @note)
                RETURNING id
                """, parameters, cancellationToken);
            // Позиции вставляются одним пакетом: одна команда на позицию, все значения — параметры.
            await using (var batch = new NpgsqlBatch(connection, transaction))
            {
                foreach (var item in items)
                {
                    var command = new NpgsqlBatchCommand("""
                        INSERT INTO project.supply_order_items(order_id, item_id, quantity, unit_price)
                        VALUES (@order, @item, @quantity::numeric, @price::numeric)
                        """);
                    AddParameters(command, new Dictionary<string, object?>
                    {
                        ["order"] = orderId, ["item"] = item.ItemId,
                        ["quantity"] = item.Quantity.ToString(CultureInfo.InvariantCulture),
                        ["price"] = item.UnitPrice.ToString(CultureInfo.InvariantCulture)
                    });
                    batch.BatchCommands.Add(command);
                }
                await batch.ExecuteNonQueryAsync(cancellationToken);
            }
            await HospitalAuditAsync(connection, transaction, access.UserId, "insert", "supply_order", orderId,
                requestId, ["organization_id", "supplier", "items"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
            return orderId;
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }

    // Приём заказа: статус received, received_at и приход остатка одной транзакцией.
    // Повторный приём отклоняется 409: остаток не должен увеличиться дважды.
    public async Task ReceiveSupplyOrderAsync(UserAccess access, long id, string requestId,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanManageSupplyOrders(access))
            throw new ApplicationFault(403,
                "Приём заказа доступен администратору организации, главному врачу и заместителю");
        var organizations = AccessPolicies.SupplyManagerOrganizationIds(access);
        if (organizations.Length == 0)
            throw new ApplicationFault(403, "Учётная запись не привязана к организации снабжения");
        var parameters = new Dictionary<string, object?>
        {
            ["id"] = id, ["orgs"] = organizations, ["org"] = organizations[0]
        };
        await using var connection = await dataSource.OpenConnectionAsync(cancellationToken);
        await using var transaction = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, cancellationToken);
        await SetAuditContext(connection, transaction, access, requestId, cancellationToken);
        try
        {
            var rows = await TxRowsAsync(connection, transaction, """
                SELECT o.id, o.organization_id AS "organizationId", o.status
                FROM project.supply_orders o
                WHERE o.id = @id AND o.organization_id = ANY(@orgs)
                FOR UPDATE OF o
                """, parameters, cancellationToken);
            if (rows.Count == 0)
                throw new ApplicationFault(404, "Заказ снабжения не найден в вашей организации");
            var status = (string)rows[0]["status"]!;
            if (status == "received") throw new ApplicationFault(409, "Заказ уже получен");
            if (status == "cancelled") throw new ApplicationFault(409, "Отменённый заказ нельзя получить");
            parameters["org"] = (long)rows[0]["organizationId"]!;
            await using (var batch = new NpgsqlBatch(connection, transaction))
            {
                var update = new NpgsqlBatchCommand("""
                    UPDATE project.supply_orders SET status = 'received', received_at = CURRENT_TIMESTAMP
                    WHERE id = @id AND status = 'ordered'
                    """);
                AddParameters(update, parameters);
                batch.BatchCommands.Add(update);
                // Остаток приходит прибавлением к существующей строке; неснижаемый минимум
                // при первом появлении позиции остаётся нулевым до настройки.
                var stock = new NpgsqlBatchCommand("""
                    INSERT INTO project.supply_stock(organization_id, item_id, quantity, min_quantity, updated_at)
                    SELECT @org, item.item_id, item.quantity, 0, CURRENT_TIMESTAMP
                    FROM project.supply_order_items item
                    WHERE item.order_id = @id
                    ON CONFLICT (organization_id, item_id) DO UPDATE
                    SET quantity = supply_stock.quantity + EXCLUDED.quantity,
                        updated_at = CURRENT_TIMESTAMP
                    """);
                AddParameters(stock, parameters);
                batch.BatchCommands.Add(stock);
                await batch.ExecuteNonQueryAsync(cancellationToken);
            }
            await HospitalAuditAsync(connection, transaction, access.UserId, "receive", "supply_order", id, requestId,
                ["status", "received_at", "supply_stock"], cancellationToken);
            await transaction.CommitAsync(cancellationToken);
        }
        catch (PostgresException error)
        {
            throw HospitalWriteFault(error);
        }
    }
}
