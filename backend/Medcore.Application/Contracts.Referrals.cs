using System.ComponentModel.DataAnnotations;

namespace Medcore.Application;

// Направления к специалистам (миграция 007). Имена полей согласованы с клиентом:
// список и карточка пациента отдают одни и те же строки.

// doctorId/doctorName — целевой врач (необязательный), referringDoctorName — кто направил.
public sealed record ReferralRow(long Id, long PatientId, string PatientName, string ReferralType,
    long HospitalId, string HospitalName, long SpecializationId, string SpecializationName,
    long? DoctorId, string? DoctorName, string Status, DateTimeOffset IssuedAt, DateOnly? ValidUntil,
    string Reason, string ReferringDoctorName);

public sealed record ReferralList(IReadOnlyList<ReferralRow> Items);

// Тело POST /api/referrals. hospitalId|targetHospitalId и targetDoctorId|doctorId — алиасы;
// caseId может отсутствовать: направление оформляется по открытому случаю пациента или
// по новому амбулаторному случаю в организации пользователя.
public sealed record CreateReferralRequest(
    [property: Range(1, long.MaxValue)] long PatientId,
    [property: Range(1, long.MaxValue)] long? CaseId,
    [property: StringLength(20)] string? ReferralType,
    [property: Range(1, long.MaxValue)] long? HospitalId,
    [property: Range(1, long.MaxValue)] long? TargetHospitalId,
    [property: Range(1, long.MaxValue)] long? SpecializationId,
    [property: Range(1, long.MaxValue)] long? TargetDoctorId,
    [property: Range(1, long.MaxValue)] long? DoctorId,
    DateOnly? ValidUntil,
    [property: StringLength(2000)] string? Reason,
    [property: StringLength(2000)] string? Note);

// Допустимые значения проверяет хранилище: оно возвращает 422 с русским текстом.
public sealed record ReferralStatusRequest([property: Required, StringLength(20)] string Status);
