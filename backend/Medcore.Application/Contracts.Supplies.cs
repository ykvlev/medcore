using System.ComponentModel.DataAnnotations;

namespace Medcore.Application;

// Снабжение (миграция 007): остатки, дефицит и заказы организации.

// Позиция с остатком организации: deficit — количество ниже неснижаемого минимума.
public sealed record SupplyItemRow(long Id, string Code, string Name, string Category, string Unit,
    decimal Quantity, decimal MinQuantity, bool Deficit, string OrganizationName);

public sealed record SupplyItemList(IReadOnlyList<SupplyItemRow> Items);

public sealed record SupplyOrderRow(long Id, string Supplier, string Status, DateTimeOffset OrderedAt,
    DateOnly? ExpectedAt, DateTimeOffset? ReceivedAt, int ItemCount, decimal Total, string? Note);

public sealed record CreateSupplyOrderRequest(
    [property: Required, StringLength(200)] string Supplier,
    DateOnly? ExpectedAt,
    [property: StringLength(2000)] string? Note,
    [property: Required, MinLength(1), MaxLength(200)] SupplyOrderItemRequest[] Items);

// Количество и цену проверяет хранилище: сообщения на русском и код 422.
public sealed record SupplyOrderItemRequest(
    [property: Range(1, long.MaxValue)] long ItemId,
    decimal Quantity,
    decimal UnitPrice);
