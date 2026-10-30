namespace Medcore.Application;

// Единый формат отчёта: колонки описывают порядок и подписи, строки содержат
// значения по ключам колонок, totals — rowCount и суммы числовых колонок.
public sealed record ReportColumn(string Key, string Label);

public sealed record ReportResult(string Kind, string Title, string From, string To,
    IReadOnlyList<ReportColumn> Columns,
    IReadOnlyList<IReadOnlyDictionary<string, object?>> Rows,
    IReadOnlyDictionary<string, object?> Totals);
