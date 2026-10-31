using Medcore.Application;
using Medcore.Infrastructure;

namespace Medcore.Api;

// Маршруты транспортировки пациентов. Контракт: docs/project/api-contract.md,
// раздел «Транспортировка пациентов».
public static class TransportEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        api.MapGet("/transports", async (HttpContext context, MedcoreStore store, string? status, int? page,
            int? pageSize, CancellationToken ct) =>
            Results.Ok(await store.TransportsPageAsync(Access(context), status, page ?? 1, pageSize ?? 20, ct)))
            .WithSummary("Перевозки пациентов в области доступа");

        api.MapPost("/transports", async (CreateTransportRequest request, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте данные перевозки");
            var id = await store.CreateTransportAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/transports/{id}", new { id });
        }).WithSummary("Оформление перевозки: учреждение отправления определяется доступом");

        api.MapPatch("/transports/{id:long}", async (long id, TransportStatusRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте статус перевозки");
            await store.ChangeTransportStatusAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Смена статуса перевозки: requested → in_progress/completed/cancelled");
    }

    private static UserAccess Access(HttpContext context) =>
        (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;
}
