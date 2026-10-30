using System.ComponentModel.DataAnnotations;

namespace Medcore.Application;

// DTO маршрутов персонала. Контракт: docs/project/api-contract.md.

public sealed record EmployeeRow(long Id, string FullName, string Category, string? Specialties,
    string? OrganizationName, bool IsActive);

public sealed record EmployeeCardRow(long Id, string LastName, string FirstName, string? MiddleName,
    DateOnly BirthDate, string Category, bool IsActive, string? OrganizationName, string? Phone);

public sealed record DoctorProfile(IReadOnlyList<DictionaryItem> Specialties, string? Degree, string? Title,
    DateOnly? HiredAt);

public sealed record EmploymentRow(long Id, string OrganizationName, string OrganizationType,
    DateOnly StartedAt, DateOnly? EndedAt);

public sealed record EmployeeCard(EmployeeCardRow Employee, DoctorProfile? Doctor,
    IReadOnlyList<EmploymentRow> Employments, IReadOnlyList<EmploymentRow> Consultations);

public sealed record CreateEmployeeRequest(
    [property: Required, StringLength(100, MinimumLength = 1)] string LastName,
    [property: Required, StringLength(100, MinimumLength = 1)] string FirstName,
    [property: StringLength(100)] string? MiddleName,
    DateOnly BirthDate,
    [property: RegularExpression("^(male|female|unknown)$")] string? Sex,
    [property: StringLength(50)] string? Phone,
    [property: Range(1, long.MaxValue)] long CategoryId,
    long[]? SpecialtyIds,
    [property: Range(1, long.MaxValue)] long? DegreeId,
    [property: Range(1, long.MaxValue)] long? TitleId,
    [property: Range(1, long.MaxValue)] long OrganizationId,
    DateOnly HiredAt,
    [property: StringLength(200)] string? PositionName);

public sealed record UpdateEmployeeRequest(
    [property: Required, StringLength(100, MinimumLength = 1)] string LastName,
    [property: Required, StringLength(100, MinimumLength = 1)] string FirstName,
    [property: StringLength(100)] string? MiddleName,
    DateOnly BirthDate,
    [property: RegularExpression("^(male|female|unknown)$")] string? Sex,
    [property: StringLength(50)] string? Phone,
    [property: Range(1, long.MaxValue)] long CategoryId,
    [property: Range(1, long.MaxValue)] long? DegreeId,
    [property: Range(1, long.MaxValue)] long? TitleId,
    bool? IsActive);

public sealed record AddDoctorSpecialtyRequest(
    [property: Range(1, long.MaxValue)] long SpecialtyId,
    DateOnly? CertifiedOn,
    DateOnly? ValidUntil);

public sealed record CreateEmploymentRequest(
    [property: Range(1, long.MaxValue)] long OrganizationId,
    [property: StringLength(200, MinimumLength = 1)] string? PositionName,
    DateOnly StartedOn,
    DateOnly? EndedOn,
    [property: Range(0.01, 2.0)] decimal WorkloadFraction = 1m);

public sealed record CreateConsultationRequest(
    [property: Range(1, long.MaxValue)] long OrganizationId,
    DateOnly StartedOn,
    DateOnly? EndedOn);
