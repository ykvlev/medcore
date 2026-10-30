using Medcore.Application;
using Medcore.Infrastructure;

namespace Medcore.Api;

// Маршруты лабораторий. Контракт: docs/project/api-contract.md, раздел «Лаборатории».
public static class LaboratoryEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        api.MapGet("/laboratories/{id:long}", async (long id, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
            Results.Ok(await store.LaboratoryCardAsync(Access(context), id, ct)))
            .WithSummary("Карточка лаборатории: профили и договоры");

        api.MapGet("/lab-orders", async (HttpContext context, MedcoreStore store, string? status, string? search,
            int? page, int? pageSize, CancellationToken ct) =>
            Results.Ok(await store.LabOrdersPageAsync(Access(context), status, search, page ?? 1,
                pageSize ?? 20, ct)))
            .WithSummary("Список лабораторных заказов");

        api.MapGet("/lab-orders/{id:long}", async (long id, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
            Results.Ok(await store.LabOrderDetailAsync(Access(context), id, ct)))
            .WithSummary("Карточка лабораторного заказа с текущим результатом");

        api.MapPost("/lab-orders", async (CreateLabOrderRequest request, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные заказа");
            var id = await store.CreateLabOrderAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/lab-orders/{id}", new { id });
        }).WithSummary("Заказ лабораторного исследования");

        api.MapPost("/lab-orders/{id:long}/results", async (long id, SubmitLabResultRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные результата");
            var resultId = await store.SubmitLabResultAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.Created($"/api/lab-orders/{id}/results/{resultId}", new { id = resultId });
        }).WithSummary("Внести результат или исправление результата");
    }

    private static UserAccess Access(HttpContext context) =>
        (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;
}
