using Medcore.Application;
using Medcore.Infrastructure;

namespace Medcore.Api;

// Маршруты персонала. Контракт: docs/project/api-contract.md.
public static class EmployeeEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        // Краткий GET /employees уже зарегистрирован в Program.cs; постраничный вариант включится
        // после удаления старой регистрации, иначе получился бы дублирующий маршрут.
        if (!OrganizationEndpoints.AlreadyMapped(api, "GET", "/employees"))
        {
            api.MapGet("/employees", async (HttpContext context, MedcoreStore store, string? search,
                long? specialtyId, long? organizationId, int? page, int? pageSize, CancellationToken ct) =>
                Results.Ok(await store.EmployeesPageAsync(Access(context), search, specialtyId, organizationId,
                    page ?? 1, pageSize ?? 20, ct))).WithSummary("Список сотрудников");
        }

        api.MapGet("/employees/{id:long}", async (long id, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
            Results.Ok(await store.EmployeeAsync(Access(context), id, ct))).WithSummary("Карточка сотрудника");

        api.MapPost("/employees", async (CreateEmployeeRequest request, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные сотрудника");
            var id = await store.CreateEmployeeAsync(Access(context), request, context.TraceIdentifier, ct);
            return Results.Created($"/api/employees/{id}", new { id });
        }).WithSummary("Принять сотрудника");

        api.MapPut("/employees/{id:long}", async (long id, UpdateEmployeeRequest request, HttpContext context,
            MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные сотрудника");
            await store.UpdateEmployeeAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.Ok(new { id });
        }).WithSummary("Изменить сотрудника");

        api.MapPost("/doctors/{id:long}/specialties", async (long id, AddDoctorSpecialtyRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные специальности");
            await store.AddDoctorSpecialtyAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.Created($"/api/doctors/{id}/specialties/{request.SpecialtyId}",
                new { id = request.SpecialtyId });
        }).WithSummary("Назначить специальность врачу");

        api.MapDelete("/doctors/{id:long}/specialties/{specialtyId:long}", async (long id, long specialtyId,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            await store.RemoveDoctorSpecialtyAsync(Access(context), id, specialtyId, context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Снять специальность врача");

        api.MapPost("/doctors/{id:long}/employments", async (long id, CreateEmploymentRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные трудоустройства");
            var employmentId = await store.AddEmploymentAsync(Access(context), id, request,
                context.TraceIdentifier, ct);
            return Results.Created($"/api/doctors/{id}/employments/{employmentId}", new { id = employmentId });
        }).WithSummary("Оформить трудоустройство врача");

        api.MapPost("/doctors/{id:long}/consultations", async (long id, CreateConsultationRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные консультации");
            var consultationId = await store.AddConsultationAsync(Access(context), id, request,
                context.TraceIdentifier, ct);
            return Results.Created($"/api/doctors/{id}/consultations/{consultationId}", new { id = consultationId });
        }).WithSummary("Оформить консультативное назначение");
    }

    private static UserAccess Access(HttpContext context) =>
        (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;
}
