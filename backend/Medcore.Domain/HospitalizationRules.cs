namespace Medcore.Domain;

public static class HospitalizationRules
{
    // Half-open intervals permit an immediate transfer at the exact end time.
    public static bool Overlaps(DateTimeOffset firstStart, DateTimeOffset? firstEnd,
        DateTimeOffset secondStart, DateTimeOffset? secondEnd)
    {
        if (firstEnd <= firstStart || secondEnd <= secondStart)
            throw new ArgumentException("Интервал должен иметь положительную продолжительность.");
        return firstStart < (secondEnd ?? DateTimeOffset.MaxValue)
            && secondStart < (firstEnd ?? DateTimeOffset.MaxValue);
    }

    public static bool CanPlace(bool operational, DateTimeOffset startsAt, DateTimeOffset? endsAt,
        IEnumerable<(DateTimeOffset Start, DateTimeOffset? End)> occupancies)
    {
        if (endsAt <= startsAt) throw new ArgumentException("Интервал должен иметь положительную продолжительность.");
        return operational && !occupancies.Any(o => Overlaps(startsAt, endsAt, o.Start, o.End));
    }
}
