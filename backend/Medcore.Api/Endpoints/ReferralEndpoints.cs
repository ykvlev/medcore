using Medcore.Application;
using Medcore.Infrastructure;

namespace Medcore.Api;

// Маршруты направлений к специалистам. Контракт: docs/project/api-contract.md,
// раздел «Направления к специалистам».
public static class ReferralEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        api.MapGet("/patients/{id:long}/referrals", async (long id, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
            Results.Ok(await store.PatientReferralsAsync(Access(context), id, context.TraceIdentifier, ct)))
            .WithSummary("Направления пациента по его случаям");

        api.MapGet("/referrals", async (HttpContext context, MedcoreStore store, string? status, long? patientId,
            int? page, int? pageSize, CancellationToken ct) =>
            Results.Ok(await store.ReferralsPageAsync(Access(context), status, patientId, page ?? 1,
                pageSize ?? 20, ct)))
            .WithSummary("Реестр направлений в области доступа; ?patientId= повторяет карточку пациента");

        api.MapPost("/referrals", async (CreateReferralRequest request, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте данные направления");
            var id = await store.CreateReferralAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/referrals/{id}", new { id });
        }).WithSummary("Оформление направления: врач по своим случаям, регистратор по своей организации");

        api.MapPatch("/referrals/{id:long}/status", async (long id, ReferralStatusRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте статус направления");
            await store.ChangeReferralStatusAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Смена статуса направления: issued → scheduled/completed/cancelled");
    }

    private static UserAccess Access(HttpContext context) =>
        (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;
}
