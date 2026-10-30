using Medcore.Application;

namespace Medcore.Infrastructure;

// Справочник МКБ-10 (миграция 004): активные коды, поиск по коду и названию.
public sealed partial class MedcoreStore
{
    public async Task<DiagnosisLookupResult> DiagnosesAsync(UserAccess access, string? search, int limit,
        CancellationToken cancellationToken)
    {
        // Справочник нужен тем, кто оформляет медицинские записи и читает пациентов;
        // министр, губернатор и системный администратор персональных форм не ведут.
        if (!AccessPolicies.CanReadPatients(access))
            throw new ApplicationFault(403, "Справочник МКБ-10 доступен ролям, работающим с пациентами");
        var query = string.IsNullOrWhiteSpace(search) ? null : search.Trim();
        if (query is { Length: > 100 }) throw new ApplicationFault(400, "Слишком длинный поисковый запрос");
        var take = Math.Clamp(limit, 1, 100);
        var rows = await RowsAsync("""
            SELECT id, code, name, chapter FROM project.diagnoses
            WHERE is_active AND (@search IS NULL OR code ILIKE @search OR name ILIKE @search)
            ORDER BY code
            LIMIT @take
            """, new() { ["search"] = query is null ? null : $"%{query}%", ["take"] = take }, cancellationToken);
        return new DiagnosisLookupResult(rows.Select(row => new DiagnosisLookupItem(
            (long)row["id"]!, (string)row["code"]!, (string)row["name"]!, row["chapter"] as string)).ToArray());
    }
}
