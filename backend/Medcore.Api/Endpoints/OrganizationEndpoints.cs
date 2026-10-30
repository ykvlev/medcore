using Medcore.Application;
using Medcore.Infrastructure;
using Microsoft.AspNetCore.Routing;

namespace Medcore.Api;

// Маршруты организаций, их структуры и справочников. Контракт: docs/project/api-contract.md.
public static class OrganizationEndpoints
{
    public static void Map(IEndpointRouteBuilder api)
    {
        // Program.cs уже регистрирует краткий GET /organizations. Постраничный вариант с поиском
        // включается после удаления старой регистрации ведущим агентом; иначе маршрут дублировался
        // бы и ASP.NET Core возвращал бы 500 AmbiguousMatchException.
        if (!AlreadyMapped(api, "GET", "/organizations"))
        {
            api.MapGet("/organizations", async (HttpContext context, MedcoreStore store, string? search,
                string? type, int? page, int? pageSize, CancellationToken ct) =>
                Results.Ok(await store.OrganizationsPageAsync(Access(context), search, type, page ?? 1,
                    pageSize ?? 20, ct))).WithSummary("Список учреждений");
        }

        api.MapGet("/organizations/{id:long}", async (long id, HttpContext context, MedcoreStore store,
            CancellationToken ct) =>
            Results.Ok(await store.OrganizationCardAsync(Access(context), id, ct))).WithSummary("Карточка учреждения");

        api.MapPost("/organizations", async (CreateOrganizationRequest request, HttpContext context,
            MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные учреждения");
            var organization = await store.CreateOrganizationAsync(Access(context), request,
                context.TraceIdentifier, ct);
            return Results.Created($"/api/organizations/{organization.Id}", organization);
        }).WithSummary("Создать учреждение");

        api.MapPut("/organizations/{id:long}", async (long id, UpdateOrganizationRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные учреждения");
            var access = Access(context);
            await store.UpdateOrganizationAsync(access, id, request, context.TraceIdentifier, ct);
            return Results.Ok((await store.OrganizationCardAsync(access, id, ct)).Organization);
        }).WithSummary("Изменить учреждение и признак активности");

        api.MapGet("/dictionaries", async (MedcoreStore store, CancellationToken ct) =>
            Results.Ok(await store.DictionariesAsync(ct))).WithSummary("Справочники для форм");

        api.MapPost("/hospitals/{id:long}/buildings", async (long id, CreateBuildingRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные корпуса");
            var buildingId = await store.CreateBuildingAsync(Access(context), id, request,
                context.TraceIdentifier, ct);
            return Results.Created($"/api/buildings/{buildingId}", new { id = buildingId });
        }).WithSummary("Добавить корпус");

        api.MapPost("/buildings/{id:long}/departments", async (long id, CreateDepartmentRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные отделения");
            var departmentId = await store.CreateDepartmentAsync(Access(context), id, request,
                context.TraceIdentifier, ct);
            return Results.Created($"/api/departments/{departmentId}", new { id = departmentId });
        }).WithSummary("Добавить отделение");

        api.MapPost("/departments/{id:long}/wards", async (long id, CreateWardRequest request,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные палаты");
            var wardId = await store.CreateWardAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.Created($"/api/wards/{wardId}", new { id = wardId });
        }).WithSummary("Добавить палату");

        api.MapPost("/wards/{id:long}/beds", async (long id, CreateBedRequest request, HttpContext context,
            MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные койки");
            var bedId = await store.CreateBedAsync(Access(context), id, request, context.TraceIdentifier, ct);
            return Results.Created($"/api/beds/{bedId}", new { id = bedId });
        }).WithSummary("Добавить койку");

        api.MapPatch("/beds/{id:long}", async (long id, UpdateBedRequest request, HttpContext context,
            MedcoreStore store, CancellationToken ct) =>
        {
            var errors = RequestValidation.Errors(request);
            if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте признак активности койки");
            await store.SetBedActiveAsync(Access(context), id, request.IsActive!.Value,
                context.TraceIdentifier, ct);
            return Results.NoContent();
        }).WithSummary("Ввести или вывести койку из эксплуатации");
    }

    private static UserAccess Access(HttpContext context) =>
        (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;

    // Шаблон маршрута внутри группы хранится без префикса /api, поэтому сравнение терпимо к обоим видам.
    internal static bool AlreadyMapped(IEndpointRouteBuilder api, string method, string pattern)
    {
        var expected = pattern.Trim('/');
        foreach (var dataSource in api.DataSources)
        {
            foreach (var endpoint in dataSource.Endpoints)
            {
                if (endpoint is not RouteEndpoint route) continue;
                var actual = route.RoutePattern.RawText?.Trim('/');
                if (actual is null) continue;
                if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)
                    && !string.Equals(actual, "api/" + expected, StringComparison.OrdinalIgnoreCase)) continue;
                var methods = route.Metadata.GetMetadata<HttpMethodMetadata>();
                if (methods is not null && methods.HttpMethods.Contains(method, StringComparer.OrdinalIgnoreCase))
                    return true;
            }
        }
        return false;
    }
}
