using System.ComponentModel.DataAnnotations;

namespace Medcore.Application;

// DTO маршрутов лабораторий. Контракт: docs/project/api-contract.md, раздел «Лаборатории».

public sealed record LaboratorySummary(long Id, string Name, string Address, string? Phone, string? Email,
    bool IsActive);

public sealed record LaboratoryProfileRow(long Id, string Code, string Name);

public sealed record LaboratoryContractRow(long Id, string OrganizationName, string ContractNumber,
    DateOnly ValidFrom, DateOnly ValidUntil, bool IsActive);

public sealed record LaboratoryCard(LaboratorySummary Laboratory, IReadOnlyList<LaboratoryProfileRow> Profiles,
    IReadOnlyList<LaboratoryContractRow> Contracts);

public sealed record LabOrderRow(long Id, string PatientName, string TestName, string LaboratoryName,
    string Status, DateTimeOffset OrderedAt, DateTimeOffset? CompletedAt);

public sealed record LabResultSummary(string Value, string? Unit, string? ReferenceRange, string? Conclusion,
    DateTimeOffset PerformedAt);

public sealed record LabOrderDetail(long Id, string PatientName, string TestName, string LaboratoryName,
    string Status, DateTimeOffset OrderedAt, DateTimeOffset? CompletedAt, string DoctorName,
    LabResultSummary? Result);

// Основной вариант: patientId + testTypeId + orderedAt; сервер сам находит открытый случай
// пациента в организации врача и действующий договор лаборатории с нужным профилем.
// caseId и contractId — необязательные альтернативы.
public sealed record CreateLabOrderRequest(
    [property: Range(1, long.MaxValue)] long PatientId,
    [property: Range(1, long.MaxValue)] long TestTypeId,
    DateTimeOffset? OrderedAt,
    [property: Range(1, long.MaxValue)] long? CaseId,
    [property: Range(1, long.MaxValue)] long? ContractId);

// Схема 001 хранит результат текстом и числом; единица, референсный интервал и заключение
// кодируются в тексте результата, потому что отдельных колонок в миграции 001 нет.
public sealed record SubmitLabResultRequest(
    [property: Required, StringLength(2000, MinimumLength = 1)] string Value,
    [property: StringLength(50)] string? Unit,
    [property: StringLength(200)] string? ReferenceRange,
    [property: StringLength(2000)] string? Conclusion,
    DateTimeOffset PerformedAt);
