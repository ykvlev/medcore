using System.ComponentModel.DataAnnotations;

namespace Medcore.Application;

// DTO маршрутов стационара. Контракт: docs/project/api-contract.md, раздел «Стационар».

public sealed record CreateHospitalizationRequest(
    [property: Range(1, long.MaxValue)] long PatientId,
    [property: Range(1, long.MaxValue)] long? ReferralId,
    [property: Range(1, long.MaxValue)] long HospitalId,
    [property: Range(1, long.MaxValue)] long DepartmentId,
    [property: Range(1, long.MaxValue)] long BedId,
    [property: Range(1, long.MaxValue)] long AttendingDoctorId,
    DateTimeOffset AdmittedAt,
    [property: Range(1, long.MaxValue)] long? DiagnosisId);

public sealed record TransferHospitalizationRequest(
    [property: Range(1, long.MaxValue)] long BedId,
    DateTimeOffset OccurredAt);

public sealed record ChangeAttendingPhysicianRequest(
    [property: Range(1, long.MaxValue)] long DoctorId,
    DateTimeOffset OccurredAt);

public sealed record DischargeHospitalizationRequest(DateTimeOffset DischargedAt);

// Направление оформляется маршрутом POST /api/referrals (см. Contracts.Referrals.cs).

// Строка списка госпитализаций: текущее размещение и текущий лечащий врач выводятся
// по последним интервалам, отделение — по койке (department_id — отделение поступления).
public sealed record HospitalizationRow(long Id, long PatientId, string PatientName, string HospitalName,
    string DepartmentName, string? WardNumber, string? BedNumber, string? DoctorName, string Status,
    DateTimeOffset AdmittedAt, DateTimeOffset? DischargedAt, string? Diagnosis);

public sealed record HospitalizationSummary(long Id, long PatientId, string PatientName, string HospitalName,
    string AdmissionDepartmentName, string DepartmentName, string? WardNumber, string? BedNumber,
    string? DoctorName, string Status, DateTimeOffset AdmittedAt, DateTimeOffset? DischargedAt, string? Diagnosis);

public sealed record BedPlacementRow(long Id, long BedId, string? WardNumber, string? BedNumber,
    long DepartmentId, string? DepartmentName, DateTimeOffset StartedAt, DateTimeOffset? EndedAt);

public sealed record AttendingPhysicianRow(long Id, long DoctorId, string DoctorName,
    DateTimeOffset StartedAt, DateTimeOffset? EndedAt);

public sealed record HospitalizationCard(HospitalizationSummary Hospitalization,
    IReadOnlyList<BedPlacementRow> Placements, IReadOnlyList<AttendingPhysicianRow> Attending,
    IReadOnlyList<HistoryItem> History);

// Ответ GET /api/beds/available: плоские поля, только активные койки без пересечения на момент at.
public sealed record AvailableBedRow(long Id, string Number, string? WardNumber, long WardId,
    string DepartmentName);
