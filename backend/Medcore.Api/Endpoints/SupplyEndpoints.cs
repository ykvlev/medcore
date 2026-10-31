using Medcore.Application;
using Medcore.Infrastructure;

namespace Medcore.Api;

// Маршруты снабжения. Контракт: docs/project/api-contract.md, раздел «Снабжение».
public static class SupplyEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        api.MapGet("/supplies", async (HttpContext context, MedcoreStore store, long? organizationId,
            string? search, string? category, CancellationToken ct) =>
            Results.Ok(await store.SupplyItemsAsync(Access(context), organizationId, search, category, false, ct)))
            .WithSummary("Позиции с остатком организации: количество, минимум и признак дефицита");

        api.MapGet("/supplies/deficit", async (HttpContext context, MedcoreStore store, long? organizationId,
            string? search, string? category, CancellationToken ct) =>
            Results.Ok(await store.SupplyItemsAsync(Access(context), organizationId, search, category, true, ct)))
            .WithSummary("Позиции ниже неснижаемого минимума");

        api.MapGet("/supply-orders", async (HttpContext context, MedcoreStore store, string? status,
            long? organizationId, int? page, int? pageSize, CancellationToken ct) =>
            Results.Ok(await store.SupplyOrdersPageAsync(Access(context), organizationId, status,
                page ?? 1, pageSize ?? 20, ct)))
            .WithSummary("Заказы снабжения организации с числом позиций и суммой");

        api.MapPost("/supply-orders", async (CreateSupplyOrderRequest request, HttpContext context,
            MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте данные заказа");
            var id = await store.CreateSupplyOrderAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/supply-orders/{id}", new { id });
        }).WithSummary("Заказ снабжения: администратор организации, главный врач или заместитель");

        api.MapPost("/supply-orders/{id:long}/receive", async (long id, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            await store.ReceiveSupplyOrderAsync(Access(context), id, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Приём заказа: статус received, остаток увеличивается, повтор — 409");
    }

    private static UserAccess Access(HttpContext context) =>
        (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;
}
