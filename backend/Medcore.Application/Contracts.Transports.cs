using System.ComponentModel.DataAnnotations;

namespace Medcore.Application;

// Транспортировка пациента между учреждениями (миграция 007).

// accompanyingName — сотрудник сопровождения: схема допускает любого сотрудника.
public sealed record TransportRow(long Id, long PatientId, string PatientName,
    long FromOrganizationId, string FromOrganizationName, long ToOrganizationId, string ToOrganizationName,
    string Status, string Reason, DateTimeOffset RequestedAt, DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt, string? Vehicle, long? AccompanyingEmployeeId, string? AccompanyingName);

// Учреждение отправления приходит от клиента и проверяется на доступ пользователя.
public sealed record CreateTransportRequest(
    [property: Range(1, long.MaxValue)] long PatientId,
    [property: Range(1, long.MaxValue)] long FromOrganizationId,
    [property: Range(1, long.MaxValue)] long ToOrganizationId,
    [property: Required, StringLength(2000)] string Reason,
    [property: StringLength(200)] string? Vehicle,
    [property: Range(1, long.MaxValue)] long? AccompanyingEmployeeId,
    [property: Range(1, long.MaxValue)] long? ReferralId);

// Допустимые значения проверяет хранилище: оно возвращает 422 с русским текстом.
public sealed record TransportStatusRequest([property: Required, StringLength(20)] string Status);
