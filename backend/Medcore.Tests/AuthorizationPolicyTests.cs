using Medcore.Application;
using Xunit;

namespace Medcore.Tests;

public sealed class AuthorizationPolicyTests
{
    private static UserAccess User(string role) => new(1, 10, "test", "Тест",
        [role], new Dictionary<string, long[]> { [role] = [100] }, [], []);

    [Fact]
    public void RegistrarCannotEditDiagnosisEvenWithOrganizationalAccess()
    {
        Assert.False(AccessPolicies.CanEditDiagnosis(User("registrar"), true));
        Assert.True(AccessPolicies.CanRegisterPatient(User("registrar"), 100));
        Assert.False(AccessPolicies.CanRegisterPatient(User("registrar"), 200));
    }

    [Fact]
    public void DoctorNeedsAnActualCareRelationshipAndAdminGetsNoClinicalOverride()
    {
        Assert.True(AccessPolicies.CanEditDiagnosis(User("doctor"), true));
        Assert.False(AccessPolicies.CanEditDiagnosis(User("doctor"), false));
        Assert.False(AccessPolicies.CanReadPatients(User("system_admin")));
        Assert.False(AccessPolicies.CanEditDiagnosis(User("system_admin"), true));
    }

    [Fact]
    public void HospitalRolesReadPatientsOnlyInsideTheirOrganizationScope()
    {
        var chief = User("chief_physician");
        Assert.True(AccessPolicies.CanReadPatients(chief));
        Assert.True(AccessPolicies.CanReadReports(chief));
        Assert.True(AccessPolicies.CanManageEmployees(chief));
        Assert.True(AccessPolicies.CanManageStructure(chief));

        var deputy = User("deputy_chief_physician");
        Assert.True(AccessPolicies.CanReadPatients(deputy));
        Assert.True(AccessPolicies.CanManageEmployees(deputy));
        Assert.False(AccessPolicies.CanManageStructure(deputy));

        var head = User("head_of_department");
        Assert.True(AccessPolicies.CanReadPatients(head));
        Assert.False(AccessPolicies.CanManageEmployees(head));
        Assert.False(AccessPolicies.CanManageStructure(head));

        var unscoped = new UserAccess(1, null, "x", "X", ["chief_physician"],
            new Dictionary<string, long[]>(), [], []);
        Assert.False(AccessPolicies.CanReadPatients(unscoped));
    }

    [Fact]
    public void MinisterAndGovernorGetOnlyAggregatesAcrossAllOrganizations()
    {
        foreach (var role in new[] { "minister_of_health", "governor" })
        {
            var user = User(role);
            Assert.False(AccessPolicies.CanReadPatients(user));
            Assert.True(AccessPolicies.CanReadReports(user));
            Assert.True(AccessPolicies.CanReadAllOrganizations(user));
        }
    }
}
