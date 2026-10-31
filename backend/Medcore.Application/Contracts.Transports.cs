using System.ComponentModel.DataAnnotations;

namespace Medcore.Application;

// Транспортировка пациента между учреждениями (миграция 007) и маршрут с пробегом
// (миграция 008). Координаты и подпись точки приходят от клиента, jsonb хранит их как есть.

// accompanyingName — сотрудник сопровождения: схема допускает любого сотрудника.
// distanceKm и далее заполняются PUT /api/transports/{id}/route и могут быть null.
public sealed record TransportRow(long Id, long PatientId, string PatientName,
    long FromOrganizationId, string FromOrganizationName, long ToOrganizationId, string ToOrganizationName,
    string Status, string Reason, DateTimeOffset RequestedAt, DateTimeOffset? StartedAt,
    DateTimeOffset? CompletedAt, string? Vehicle, long? AccompanyingEmployeeId, string? AccompanyingName,
    decimal? DistanceKm, int? OdometerStart, int? OdometerEnd, decimal? FuelLiters,
    IReadOnlyList<TransportRoutePoint> RoutePoints);

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

// Точка маршрута: lat ∈ [-90, 90], lng ∈ [-180, 180]; подпись необязательна.
public sealed record TransportRoutePointRequest(
    [property: Range(-90d, 90d)] double Lat,
    [property: Range(-180d, 180d)] double Lng,
    [property: StringLength(200)] string? Label);

// Тело PUT /api/transports/{id}/route. Пробег обязателен и неотрицателен, точек 2..10,
// показание одометра в конце не меньше начального — проверки в хранилище (422).
public sealed record UpdateTransportRouteRequest(
    decimal? DistanceKm,
    [property: Range(0, int.MaxValue)] int? OdometerStart,
    [property: Range(0, int.MaxValue)] int? OdometerEnd,
    decimal? FuelLiters,
    TransportRoutePointRequest[]? RoutePoints);

public sealed record TransportRoutePoint(double Lat, double Lng, string? Label);
