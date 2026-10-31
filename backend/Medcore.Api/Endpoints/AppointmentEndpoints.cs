using Medcore.Application;
using Medcore.Infrastructure;

namespace Medcore.Api;

// Маршруты приёма: талоны, записи и расписание врача. Контракт:
// docs/project/api-contract.md, раздел «Расписание и приём».
public static class AppointmentEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        api.MapGet("/slots", async (HttpContext context, MedcoreStore store, DateOnly? dateFrom, DateOnly? dateTo,
            long? organizationId, long? specializationId, long? doctorId, bool? onlyFree, CancellationToken ct) =>
            Results.Ok(await store.SlotsAsync(Access(context), dateFrom, dateTo, organizationId, specializationId,
                doctorId, onlyFree ?? false, ct)))
            .WithSummary("Талоны приёма в области организаций; по умолчанию неделя от сегодня");

        api.MapGet("/doctors/{id:long}/slots", async (long id, HttpContext context, MedcoreStore store,
            DateOnly? dateFrom, DateOnly? dateTo, CancellationToken ct) =>
            Results.Ok(await store.DoctorSlotsAsync(Access(context), id, dateFrom, dateTo, ct)))
            .WithSummary("Талоны врача за период");

        api.MapGet("/appointments", async (HttpContext context, MedcoreStore store, DateOnly? date, string? status,
            long? patientId, CancellationToken ct) =>
            Results.Ok(await store.AppointmentsAsync(Access(context), date, status, patientId, ct)))
            .WithSummary("Записи на приём: занятые, завершённые и отменённые талоны");

        api.MapPost("/appointments", async (CreateAppointmentRequest request, HttpContext context,
            MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте данные записи");
            var created = await store.BookAppointmentAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/appointments/{created.Id}", created);
        }).WithSummary("Запись пациента на свободный талон: атомарный захват, занятый талон — 409");

        api.MapPatch("/appointments/{slotId:long}", async (long slotId, AppointmentStatusRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте статус записи");
            await store.ChangeAppointmentStatusAsync(Access(context), slotId, request, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Смена статуса записи: booked → completed или cancelled");

        api.MapGet("/schedules", async (HttpContext context, MedcoreStore store, DateOnly? dateFrom,
            DateOnly? dateTo, long? organizationId, long? doctorId, CancellationToken ct) =>
            Results.Ok(await store.SchedulesAsync(Access(context), dateFrom, dateTo, organizationId, doctorId, ct)))
            .WithSummary("Расписание приёма врачей с числом свободных талонов");

        api.MapPost("/schedules", async (CreateScheduleRequest request, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors,
                statusCode: StatusCodes.Status422UnprocessableEntity, title: "Проверьте данные расписания");
            var created = await store.CreateScheduleAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/schedules/{created.Id}", created);
        }).WithSummary("Расписание врача на день с талонами на весь интервал");

        api.MapDelete("/schedules/{id:long}", async (long id, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            await store.DeleteScheduleAsync(Access(context), id, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Отмена расписания: свободные талоны отменяются, записи должны быть сняты заранее");
    }

    private static UserAccess Access(HttpContext context) =>
        (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;
}
