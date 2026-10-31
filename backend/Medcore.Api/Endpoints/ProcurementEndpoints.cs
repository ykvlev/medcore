using Medcore.Application;
using Medcore.Infrastructure;

namespace Medcore.Api;

// Маршруты закупок: поставщики, договоры, тендеры и счета. Контракт:
// docs/project/api-contract.md, раздел «Закупки».
public static class ProcurementEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        api.MapGet("/suppliers", async (HttpContext context, MedcoreStore store, string? search,
            CancellationToken ct) =>
            Results.Ok(await store.SuppliersAsync(Access(context), search, ct)))
            .WithSummary("Поставщики закупок с поиском по названию, ИНН и контакту");

        api.MapPost("/suppliers", async (CreateSupplierRequest request, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте данные поставщика");
            var id = await store.CreateSupplierAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/suppliers/{id}", new { id });
        }).WithSummary("Поставщик: администратор организации, главный врач или заместитель");

        api.MapGet("/contracts", async (HttpContext context, MedcoreStore store, string? status, long? supplierId,
            CancellationToken ct) =>
            Results.Ok(await store.ContractsAsync(Access(context), status, supplierId, ct)))
            .WithSummary("Договоры организаций пользователя с числом и суммой оплаченных счетов");

        api.MapPost("/contracts", async (CreateContractRequest request, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте данные договора");
            var id = await store.CreateContractAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/contracts/{id}", new { id });
        }).WithSummary("Договор с поставщиком в статусе draft");

        api.MapPatch("/contracts/{id:long}/status", async (long id, ContractStatusRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте статус договора");
            await store.ChangeContractStatusAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Статус договора: draft → active → closed");

        api.MapGet("/tenders", async (HttpContext context, MedcoreStore store, string? status,
            CancellationToken ct) =>
            Results.Ok(await store.TendersAsync(Access(context), status, ct)))
            .WithSummary("Тендеры организаций пользователя с поставщиком-победителем");

        api.MapPost("/tenders", async (CreateTenderRequest request, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте данные тендера");
            var id = await store.CreateTenderAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/tenders/{id}", new { id });
        }).WithSummary("Объявление тендера в статусе announced");

        api.MapPatch("/tenders/{id:long}", async (long id, TenderUpdateRequest request, HttpContext context,
            MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте данные тендера");
            await store.UpdateTenderAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Статус тендера: awarded требует поставщика-победителя, терминальные статусы неизменяемы");

        api.MapGet("/invoices", async (HttpContext context, MedcoreStore store, string? status, long? contractId,
            CancellationToken ct) =>
            Results.Ok(await store.InvoicesAsync(Access(context), status, contractId, ct)))
            .WithSummary("Счета по договорам организаций пользователя");

        api.MapPost("/invoices", async (CreateInvoiceRequest request, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте данные счёта");
            var id = await store.CreateInvoiceAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/invoices/{id}", new { id });
        }).WithSummary("Счёт по договору в статусе issued");

        api.MapPatch("/invoices/{id:long}/pay", async (long id, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            await store.PayInvoiceAsync(Access(context), id, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Оплата счёта: paid и paid_at, повторная оплата — 409");
    }

    private static UserAccess Access(HttpContext context) =>
        (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;
}
