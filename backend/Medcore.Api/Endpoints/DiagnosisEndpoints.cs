using Medcore.Application;
using Medcore.Infrastructure;

namespace Medcore.Api;

// Справочник МКБ-10 для формы диагноза. Контракт: docs/project/roles-and-icd-contract.md.
public static class DiagnosisEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        api.MapGet("/diagnoses", async (HttpContext context, MedcoreStore store, string? search, int? limit,
                CancellationToken ct) =>
                Results.Ok(await store.DiagnosesAsync(Access(context), search, limit ?? 20, ct)))
            .WithSummary("Поиск активных кодов МКБ-10 по коду и названию (limit 1..100)");
    }

    private static UserAccess Access(HttpContext context) =>
        (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;
}
