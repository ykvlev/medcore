using Medcore.Application;
using Medcore.Infrastructure;

namespace Medcore.Api;

// Администрирование доступно только system_admin; проверка выполняется в
// AdminStore на сервере, а не скрытием элементов интерфейса.
public static class AdminEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        api.MapGet("/admin/users", async (HttpContext context, MedcoreStore store, string? search,
                CancellationToken ct) =>
                Results.Ok(new { items = await store.AdminUsersAsync(Access(context), search, ct) }))
            .WithSummary("Учётные записи, роли и области действия (до 200 записей)");
        api.MapPost("/admin/users", async (CreateAdminUserRequest request, HttpContext context,
            MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные учётной записи");
            var id = await store.CreateAdminUserAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/admin/users/{id}", new { id });
        }).WithSummary("Создать учётную запись");
        api.MapPut("/admin/users/{id:long}", async (long id, UpdateAdminUserRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные учётной записи");
            await store.UpdateAdminUserAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Изменить признак активности и роли");
        api.MapGet("/admin/roles", async (HttpContext context, MedcoreStore store, CancellationToken ct) =>
            Results.Ok(new { items = await store.AdminRolesAsync(Access(context), ct) }))
            .WithSummary("Справочник ролей");
        api.MapGet("/admin/audit", async (HttpContext context, MedcoreStore store, DateOnly? from, DateOnly? to,
                string? action, int? page, int? pageSize, CancellationToken ct) =>
                Results.Ok(await store.AdminAuditAsync(Access(context), from, to, action,
                    page ?? 1, pageSize ?? 20, ct)))
            .WithSummary("Журнал аудита с фильтрами периода и действия");
    }

    private static UserAccess Access(HttpContext context) =>
        (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;
}
