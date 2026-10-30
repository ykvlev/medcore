using Medcore.Domain;
using Xunit;

namespace Medcore.Tests;

public sealed class HospitalizationRulesTests
{
    private static readonly DateTimeOffset Start = new(2026, 10, 1, 9, 0, 0, TimeSpan.Zero);

    [Fact]
    public void OngoingOccupancyRejectsAnotherPatient()
    {
        Assert.False(HospitalizationRules.CanPlace(true, Start.AddDays(1), null, [(Start, null)]));
    }

    [Fact]
    public void ReleasedBedCanBeReusedAtExactTransferBoundary()
    {
        var releasedAt = Start.AddDays(1);
        Assert.True(HospitalizationRules.CanPlace(true, releasedAt, null, [(Start, releasedAt)]));
        Assert.False(HospitalizationRules.CanPlace(false, releasedAt, null, [(Start, releasedAt)]));
    }
}
