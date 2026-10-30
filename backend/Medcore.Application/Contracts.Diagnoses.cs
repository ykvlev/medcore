namespace Medcore.Application;

// Справочник МКБ-10 для форм: только активные коды, поиск по коду и названию.
public sealed record DiagnosisLookupItem(long Id, string Code, string Name, string? Chapter);

public sealed record DiagnosisLookupResult(IReadOnlyList<DiagnosisLookupItem> Items);
