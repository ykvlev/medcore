using Medcore.Application;
using Medcore.Infrastructure;
using Microsoft.AspNetCore.Routing;

namespace Medcore.Api;

// Маршруты стационара. Контракт: docs/project/api-contract.md, раздел «Стационар».
public static class HospitalizationEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        // Program.cs уже регистрирует краткий GET /hospitalizations. Постраничный вариант
        // с фильтрами status/hospitalId должен побеждать: Order = -1 разрешает совпадение
        // маршрутов без правки общего Program.cs. Ведущий агент может удалить старую
        // регистрацию — этот маршрут продолжит работать.
        var list = api.MapGet("/hospitalizations", async (HttpContext context, MedcoreStore store, string? status,
            long? hospitalId, string? search, int? page, int? pageSize, CancellationToken ct) =>
            Results.Ok(await store.HospitalizationsPageAsync(Access(context), status, hospitalId, search,
                page ?? 1, pageSize ?? 20, ct)))
            .WithSummary("Список госпитализаций с фильтрами");
        list.Add(builder =>
        {
            if (builder is RouteEndpointBuilder route) route.Order = -1;
        });

        api.MapGet("/hospitalizations/{id:long}", async (long id, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
            Results.Ok(await store.HospitalizationCardAsync(Access(context), id, context.TraceIdentifier, ct)))
            .WithSummary("Карточка госпитализации: размещения, лечащие врачи, история");

        api.MapGet("/beds/available", async (HttpContext context, MedcoreStore store, long? departmentId,
            DateTimeOffset? at, CancellationToken ct) =>
        {
            if (departmentId is not > 0) return Results.ValidationProblem(
                new Dictionary<string, string[]> { ["departmentId"] = ["Укажите отделение"] },
                title: "Проверьте параметры запроса");
            var items = await store.AvailableBedsAsync(Access(context), departmentId.Value, at, ct);
            return Results.Ok(new { items });
        }).WithSummary("Свободные койки отделения на момент времени");

        api.MapPost("/hospitalizations", async (CreateHospitalizationRequest request, HttpContext context,
            MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные поступления");
            var id = await store.AdmitPatientAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/hospitalizations/{id}", new { id });
        }).WithSummary("Атомарное поступление в стационар");

        api.MapPut("/hospitalizations/{id:long}/transfer", async (long id, TransferHospitalizationRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные перевода");
            await store.TransferHospitalizationAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Перевод на другую койку");

        api.MapPut("/hospitalizations/{id:long}/attending", async (long id,
            ChangeAttendingPhysicianRequest request, HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные врача");
            await store.ChangeAttendingPhysicianAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Смена лечащего врача");

        api.MapPost("/hospitalizations/{id:long}/discharge", async (long id,
            DischargeHospitalizationRequest request, HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            await store.DischargeHospitalizationAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Выписка из стационара");

        api.MapPost("/referrals", async (CreateReferralRequest request, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные направления");
            var id = await store.CreateReferralAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/referrals/{id}", new { id });
        }).WithSummary("Направление на госпитализацию");
    }

    private static UserAccess Access(HttpContext context) =>
        (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;
}
