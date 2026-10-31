using System.ComponentModel.DataAnnotations;

namespace Medcore.Application;

// Закупки (миграция 008): поставщики, договоры, тендеры и счета. Строки списков
// повторяют клиентский контракт: суммы считаются на сервере, имена поставщика и
// организации приходят из справочников.

public sealed record SupplierRow(long Id, string Name, string? Inn, string? Contact, bool IsActive);

public sealed record SupplierList(IReadOnlyList<SupplierRow> Items);

public sealed record CreateSupplierRequest(
    [property: Required, StringLength(200)] string Name,
    [property: StringLength(20)] string? Inn,
    [property: StringLength(200)] string? Contact);

// paidAmount — сумма оплаченных счетов договора, invoicesCount — число его счетов.
public sealed record ContractRow(long Id, string Number, long SupplierId, string SupplierName,
    long OrganizationId, string OrganizationName, DateOnly SignedAt, DateOnly? ValidUntil,
    decimal Amount, string Status, int InvoicesCount, decimal PaidAmount);

public sealed record ContractList(IReadOnlyList<ContractRow> Items);

// Организация договора — организация пользователя по его роли закупок.
// Суммы проверяет хранилище: оно возвращает 422 с русским текстом, а Range для decimal
// разбирает границы по текущей культуре и на сервере с запятой-разделителем падает.
public sealed record CreateContractRequest(
    [property: Range(1, long.MaxValue)] long SupplierId,
    [property: Required, StringLength(100)] string Number,
    DateOnly SignedAt,
    DateOnly? ValidUntil,
    decimal Amount,
    [property: StringLength(2000)] string? Note);

public sealed record ContractStatusRequest([property: Required, StringLength(20)] string Status);

public sealed record TenderRow(long Id, string Title, long OrganizationId, string OrganizationName,
    DateTimeOffset AnnouncedAt, DateTimeOffset ClosesAt, string Status, decimal Budget,
    long? WinnerSupplierId, string? WinnerSupplierName);

public sealed record TenderList(IReadOnlyList<TenderRow> Items);

public sealed record CreateTenderRequest(
    [property: Required, StringLength(300)] string Title,
    DateTimeOffset ClosesAt,
    decimal Budget,
    [property: StringLength(2000)] string? Note);

// awarded требует winnerSupplierId; awarded и cancelled — терминальные статусы.
public sealed record TenderUpdateRequest(
    [property: Required, StringLength(20)] string Status,
    [property: Range(1, long.MaxValue)] long? WinnerSupplierId);

public sealed record InvoiceRow(long Id, long ContractId, string ContractNumber, string SupplierName,
    string Number, DateOnly IssuedAt, DateOnly DueAt, decimal Amount, string Status, DateTimeOffset? PaidAt);

public sealed record InvoiceList(IReadOnlyList<InvoiceRow> Items);

public sealed record CreateInvoiceRequest(
    [property: Range(1, long.MaxValue)] long ContractId,
    [property: Required, StringLength(100)] string Number,
    DateOnly IssuedAt,
    DateOnly DueAt,
    decimal Amount);
