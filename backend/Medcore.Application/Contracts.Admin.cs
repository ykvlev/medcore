using System.ComponentModel.DataAnnotations;

namespace Medcore.Application;

// Административные контракты. Область действия роли задаётся учреждением либо
// лабораторией и раскладывается в user_organization_scopes.
public sealed record AdminRoleAssignment(
    [property: Required, StringLength(32)] string Role,
    [property: Range(1, long.MaxValue)] long? OrganizationId = null,
    [property: Range(1, long.MaxValue)] long? LaboratoryId = null,
    [property: Range(1, long.MaxValue)] long? DepartmentId = null);

public sealed record CreateAdminUserRequest(
    [property: Required, StringLength(128, MinimumLength = 3)] string Login,
    [property: Required, StringLength(128, MinimumLength = 8)] string Password,
    [property: Range(1, long.MaxValue)] long? EmployeeId,
    [property: Required] IReadOnlyList<AdminRoleAssignment> Roles);

public sealed record UpdateAdminUserRequest(
    bool IsActive,
    [property: Required] IReadOnlyList<AdminRoleAssignment> Roles);

public sealed record AdminUserRole(string Role, long? OrganizationId, string? OrganizationName,
    long? LaboratoryId, string? LaboratoryName, long? DepartmentId = null, string? DepartmentName = null);

public sealed record AdminUser(long Id, string Login, long? EmployeeId, string? EmployeeName,
    bool IsActive, DateTimeOffset CreatedAt, IReadOnlyList<AdminUserRole> Roles);

public sealed record AdminRole(string Code, string Name);

public sealed record AuditEntry(long Id, DateTimeOffset OccurredAt, string? ActorLogin, string Action,
    string EntityType, long? EntityId, string Outcome);
