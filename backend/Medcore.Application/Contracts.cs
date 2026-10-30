using System.ComponentModel.DataAnnotations;

namespace Medcore.Application;

public sealed record LoginRequest(
    [property: Required, StringLength(128)] string Login,
    [property: Required, StringLength(1024)] string Password);

public sealed record RegisterPatientRequest(
    [property: Required, StringLength(100)] string LastName,
    [property: Required, StringLength(100)] string FirstName,
    [property: StringLength(100)] string? MiddleName,
    DateOnly BirthDate,
    [property: Required, RegularExpression("^(male|female|unknown)$")] string Sex,
    [property: StringLength(50)] string? Phone,
    [property: EmailAddress, StringLength(254)] string? Email,
    [property: StringLength(500)] string? Address,
    [property: Range(1, long.MaxValue)] long PolyclinicId);

public sealed record UpdatePatientRequest(
    [property: StringLength(50)] string? Phone,
    [property: EmailAddress, StringLength(254)] string? Email,
    [property: StringLength(500)] string? Address,
    [property: Range(1, int.MaxValue)] int Version);

public sealed record AddDiagnosisRequest(
    [property: Range(1, long.MaxValue)] long CaseId,
    [property: Range(1, long.MaxValue)] long DiagnosisId,
    [property: StringLength(2000)] string? Note,
    bool IsPrimary);

public sealed record OrganizationReference(long Id, string Name);
public sealed record CurrentUser(long Id, string Login, string DisplayName, string[] Roles,
    OrganizationReference[] Organizations);

public sealed record PatientRow(long Id, string LastName, string FirstName, string? MiddleName,
    DateOnly BirthDate, string Sex, string? Phone, string? Email, string? Address,
    string? PolyclinicName, DateTimeOffset? LastVisitAt, string Status, int Version);
public sealed record PageResult<T>(IReadOnlyList<T> Items, int Total, int Page, int PageSize);
// CaseId связывает событие истории с медицинским случаем; для обращений без случая — null.
public sealed record HistoryItem(long Id, string Type, string Title, DateTimeOffset OccurredAt,
    string? Description, long? CaseId = null);
public sealed record PatientCaseRow(long Id, long OrganizationId, string OrganizationName, string Status,
    DateTimeOffset OpenedAt, DateTimeOffset? ClosedAt, string? PrimaryDiagnosis);
public sealed record PatientCaseList(IReadOnlyList<PatientCaseRow> Items);
public sealed record PatientCard(PatientRow Patient, IReadOnlyList<HistoryItem> History);
public sealed record LoginResult(CurrentUser User, string Token);

public sealed class ApplicationFault(int statusCode, string title) : Exception(title)
{
    public int StatusCode { get; } = statusCode;
}

public static class RequestValidation
{
    public static Dictionary<string, string[]> Errors(object value)
    {
        var results = new List<ValidationResult>();
        Validator.TryValidateObject(value, new ValidationContext(value), results, true);
        return results.SelectMany(r => r.MemberNames.DefaultIfEmpty("request")
                .Select(name => (name, error: r.ErrorMessage ?? "Некорректное значение")))
            .GroupBy(x => x.name).ToDictionary(g => g.Key, g => g.Select(x => x.error).ToArray());
    }
}
