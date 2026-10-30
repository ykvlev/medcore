using System.IO.Compression;
using System.Threading.RateLimiting;
using Medcore.Api;
using Medcore.Application;
using Medcore.Infrastructure;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.HttpOverrides;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.AspNetCore.ResponseCompression;
using Microsoft.EntityFrameworkCore;
using Npgsql;

var builder = WebApplication.CreateBuilder(args);
// За обратным прокси (Caddy) реальные схема и адрес клиента приходят в заголовках:
// без этого cookie не помечается Secure, а ограничение входа считает всех одним IP.
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    options.KnownIPNetworks.Clear();
    options.KnownProxies.Clear();
});
// Render и подобные хостинги передают порт в PORT; локально остаётся 5180.
var configuredUrls = builder.Configuration["urls"] ?? Environment.GetEnvironmentVariable("ASPNETCORE_URLS");
if (string.IsNullOrEmpty(configuredUrls))
{
    var hostPort = Environment.GetEnvironmentVariable("PORT");
    builder.WebHost.UseUrls(string.IsNullOrEmpty(hostPort) ? "http://localhost:5180" : $"http://0.0.0.0:{hostPort}");
}
var connectionString = builder.Configuration.GetConnectionString("Medcore");
// Neon и другие управляемые PostgreSQL выдают строку в формате URI (DATABASE_URL).
var databaseUrl = Environment.GetEnvironmentVariable("DATABASE_URL");
if (string.IsNullOrWhiteSpace(connectionString) && !string.IsNullOrWhiteSpace(databaseUrl))
{
    var uri = new Uri(databaseUrl);
    var credentials = uri.UserInfo.Split(':', 2);
    // Управляемые PostgreSQL (Neon) требуют SSL, локальный контейнер — нет.
    var urlSslMode = uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
        .Select(pair => pair.Split('=', 2))
        .FirstOrDefault(pair => pair[0].Equals("sslmode", StringComparison.OrdinalIgnoreCase))
        ?.ElementAtOrDefault(1)?.ToLowerInvariant();
    var fromUrl = new NpgsqlConnectionStringBuilder
    {
        Host = uri.Host,
        Port = uri.IsDefaultPort ? 5432 : uri.Port,
        Database = uri.AbsolutePath.Trim('/'),
        Username = Uri.UnescapeDataString(credentials[0]),
        Password = credentials.Length > 1 ? Uri.UnescapeDataString(credentials[1]) : string.Empty,
        SslMode = urlSslMode switch
        {
            "disable" => SslMode.Disable,
            "prefer" => SslMode.Prefer,
            "verify-ca" => SslMode.VerifyCA,
            "verify-full" => SslMode.VerifyFull,
            _ => SslMode.Require
        },
        SearchPath = "project,public",
        Timezone = "Europe/Moscow",
        Timeout = 15,
        CommandTimeout = 60,
        IncludeErrorDetail = false
    };
    connectionString = fromUrl.ConnectionString;
}
if (string.IsNullOrWhiteSpace(connectionString))
{
    var connection = new NpgsqlConnectionStringBuilder
    {
        Host = Environment.GetEnvironmentVariable("PGHOST") ?? "localhost",
        Port = int.TryParse(Environment.GetEnvironmentVariable("PGPORT"), out var port) ? port : 5432,
        Database = Environment.GetEnvironmentVariable("PGDATABASE") ?? "medcore",
        Username = Environment.GetEnvironmentVariable("PGUSER") ?? "medcore",
        Password = Environment.GetEnvironmentVariable("PGPASSWORD") ?? "",
        SslMode = Environment.GetEnvironmentVariable("PGSSLMODE")?.ToLowerInvariant() switch
        {
            "disable" => SslMode.Disable,
            "verify-full" => SslMode.VerifyFull,
            "verify-ca" => SslMode.VerifyCA,
            _ => SslMode.Require
        },
        SearchPath = "project,public",
        Timezone = "Europe/Moscow",
        Timeout = 10,
        CommandTimeout = 30,
        IncludeErrorDetail = false
    };
    connectionString = connection.ConnectionString;
}
var dataSource = NpgsqlDataSource.Create(connectionString);
builder.Services.AddSingleton(dataSource);
builder.Services.AddDbContext<MedcoreDbContext>(options => options.UseNpgsql(dataSource));
// Источники клиента настраиваются окружением: локально это Vite, при размещении —
// домен фронтенда (несколько адресов через запятую).
var frontendOrigins = (Environment.GetEnvironmentVariable("MEDCORE_FRONTEND_ORIGINS")
        ?? "http://localhost:5173,http://127.0.0.1:5173")
    .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
// Для размещения фронтенда и API на разных доменах cookie должна быть SameSite=None.
var crossSiteCookies = string.Equals(Environment.GetEnvironmentVariable("MEDCORE_COOKIE_SAMESITE"), "None",
    StringComparison.OrdinalIgnoreCase);
builder.Services.AddMemoryCache();
builder.Services.AddScoped<MedcoreStore>();
// JSON-ответы сжимаются на лету: brotli для современных браузеров, gzip как запасной.
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.MimeTypes = ResponseCompressionDefaults.MimeTypes.Concat(["application/json", "application/problem+json"]);
    options.Providers.Add<BrotliCompressionProvider>();
    options.Providers.Add<GzipCompressionProvider>();
});
builder.Services.Configure<BrotliCompressionProviderOptions>(options => options.Level = CompressionLevel.Fastest);
builder.Services.Configure<GzipCompressionProviderOptions>(options => options.Level = CompressionLevel.Fastest);
builder.Services.AddAuthentication(SessionAuthenticationHandler.SchemeName)
    .AddScheme<AuthenticationSchemeOptions, SessionAuthenticationHandler>(SessionAuthenticationHandler.SchemeName, _ => { });
builder.Services.AddAuthorization();
builder.Services.AddProblemDetails();
builder.Services.AddOpenApi();
builder.Services.AddCors(options => options.AddPolicy("LocalFrontend", policy => policy
    .WithOrigins(frontendOrigins)
    .WithMethods("GET", "POST", "PUT", "PATCH", "DELETE").AllowAnyHeader().AllowCredentials()));
builder.Services.AddRateLimiter(options =>
{
    options.AddPolicy("login", context => RateLimitPartition.GetFixedWindowLimiter(
        context.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions
        {
            PermitLimit = 20, Window = TimeSpan.FromMinutes(1), QueueLimit = 0, AutoReplenishment = true
        }));
    options.OnRejected = async (context, cancellationToken) =>
    {
        context.HttpContext.Response.Headers.RetryAfter = "60";
        await Results.Problem(statusCode: 429, title: "Слишком много попыток входа. Повторите через минуту.")
            .ExecuteAsync(context.HttpContext);
    };
});

var app = builder.Build();
app.UseForwardedHeaders();
app.UseResponseCompression();
app.UseExceptionHandler(errorApp => errorApp.Run(async context =>
{
    var error = context.Features.Get<IExceptionHandlerFeature>()?.Error;
    var (status, title) = error switch
    {
        ApplicationFault fault => (fault.StatusCode, fault.Message),
        BadHttpRequestException => (400, "Некорректный запрос"),
        PostgresException { SqlState: "22023" or "22007" or "22008" } => (400, "Некорректные входные данные"),
        PostgresException { SqlState: "P0002" } => (404, "Запись не найдена"),
        PostgresException { SqlState: "P0001" } => (409, "Карточка уже изменена. Обновите данные и повторите сохранение."),
        PostgresException { SqlState: "23514" or "23503" or "23505" or "23P01" } => (409, "Операция нарушает ограничения данных"),
        PostgresException { SqlState: "40001" or "40P01" or "55P03" } => (409, "Данные изменяются другим пользователем. Повторите операцию."),
        NpgsqlException => (503, "База данных временно недоступна"),
        _ => (500, "Не удалось обработать запрос")
    };
    if (status >= 500) app.Logger.LogError("Request {RequestId} failed with {ExceptionType}", context.TraceIdentifier, error?.GetType().Name);
    await Results.Problem(statusCode: status, title: title,
        extensions: new Dictionary<string, object?> { ["traceId"] = context.TraceIdentifier }).ExecuteAsync(context);
}));
app.UseStatusCodePages(async context =>
{
    if (context.HttpContext.Request.Path.StartsWithSegments("/api"))
        await Results.Problem(statusCode: context.HttpContext.Response.StatusCode,
            title: context.HttpContext.Response.StatusCode == 404 ? "Маршрут не найден" : "Запрос не выполнен")
            .ExecuteAsync(context.HttpContext);
});
app.UseRouting();
app.UseCors("LocalFrontend");
app.Use(async (context, next) =>
{
    // Cookie authentication plus an Origin check protects unsafe browser calls.
    if (HttpMethods.IsPost(context.Request.Method) || HttpMethods.IsPut(context.Request.Method)
        || HttpMethods.IsPatch(context.Request.Method) || HttpMethods.IsDelete(context.Request.Method))
    {
        var origin = context.Request.Headers.Origin.ToString();
        var sameOrigin = $"{context.Request.Scheme}://{context.Request.Host}";
        var allowed = origin.Length == 0 || string.Equals(origin, sameOrigin, StringComparison.OrdinalIgnoreCase)
            || frontendOrigins.Contains(origin, StringComparer.OrdinalIgnoreCase);
        if (!allowed)
        {
            await Results.Problem(statusCode: 403, title: "Источник запроса не разрешён").ExecuteAsync(context);
            return;
        }
    }
    context.Response.Headers.XContentTypeOptions = "nosniff";
    context.Response.Headers.CacheControl = "no-store";
    await next(context);
});
app.UseRateLimiter();
app.UseAuthentication();
app.UseAuthorization();

app.MapGet("/health", () => Results.Ok(new { status = "ok" })).AllowAnonymous();
app.MapOpenApi();
app.UseSwaggerUI(options => options.SwaggerEndpoint("/openapi/v1.json", "MEDCORE API"));

app.MapPost("/api/auth/login", async (LoginRequest request, HttpContext context, MedcoreStore store, CancellationToken ct) =>
{
    var errors = RequestValidation.Errors(request);
    if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте поля входа");
    var result = await store.LoginAsync(request, context.TraceIdentifier, ct);
    if (result is null) return Results.Problem(statusCode: 401, title: "Неверный логин или пароль");
    context.Response.Cookies.Append(SessionAuthenticationHandler.CookieName, result.Token, new CookieOptions
    {
        HttpOnly = true, Secure = crossSiteCookies || context.Request.IsHttps,
        SameSite = crossSiteCookies ? SameSiteMode.None : SameSiteMode.Lax,
        Path = "/", MaxAge = TimeSpan.FromHours(MedcoreStore.SessionHours), IsEssential = true
    });
    return Results.Ok(result.User);
}).RequireRateLimiting("login").AllowAnonymous().WithSummary("Войти в систему");

var api = app.MapGroup("/api").RequireAuthorization();
static UserAccess Access(HttpContext context) => (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;
api.MapGet("/auth/me", (HttpContext context) => Results.Ok(Access(context).ToCurrentUser()));
api.MapPost("/auth/logout", async (HttpContext context, MedcoreStore store, CancellationToken ct) =>
{
    try
    {
        await store.LogoutAsync(context.Request.Cookies[SessionAuthenticationHandler.CookieName], Access(context).UserId, context.TraceIdentifier, ct);
    }
    finally { context.Response.Cookies.Delete(SessionAuthenticationHandler.CookieName, new CookieOptions { Path = "/" }); }
    return Results.NoContent();
});
api.MapGet("/dashboard/summary", async (HttpContext context, MedcoreStore store, CancellationToken ct) =>
    Results.Ok(await store.DashboardAsync(Access(context), ct)));
api.MapGet("/laboratories", async (HttpContext context, MedcoreStore store, CancellationToken ct) =>
    Results.Ok(await store.LaboratoriesAsync(Access(context), ct)));
api.MapGet("/reports/overview", async (HttpContext context, MedcoreStore store, CancellationToken ct) =>
    Results.Ok(await store.ReportsAsync(Access(context), ct)));
api.MapGet("/patients", async (HttpContext context, MedcoreStore store, string? search, int? page, int? pageSize, CancellationToken ct) =>
    Results.Ok(await store.PatientsAsync(Access(context), search, page ?? 1, pageSize ?? 20, ct)));
api.MapGet("/patients/{id:long}", async (long id, HttpContext context, MedcoreStore store, CancellationToken ct) =>
    Results.Ok(await store.PatientAsync(Access(context), id, context.TraceIdentifier, ct)));
api.MapGet("/patients/{id:long}/cases", async (long id, HttpContext context, MedcoreStore store, CancellationToken ct) =>
    Results.Ok(await store.PatientCasesAsync(Access(context), id, context.TraceIdentifier, ct)));
api.MapPost("/patients", async (RegisterPatientRequest request, HttpContext context, MedcoreStore store, CancellationToken ct) =>
{
    var errors = RequestValidation.Errors(request);
    if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные пациента");
    var id = await store.RegisterPatientAsync(Access(context), request, context.TraceIdentifier, ct);
    return Results.Created($"/api/patients/{id}", (await store.PatientAsync(Access(context), id, context.TraceIdentifier, ct)).Patient);
});
api.MapPut("/patients/{id:long}", async (long id, UpdatePatientRequest request, HttpContext context, MedcoreStore store, CancellationToken ct) =>
{
    var errors = RequestValidation.Errors(request);
    if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте контактные данные");
    await store.UpdatePatientAsync(Access(context), id, request, context.TraceIdentifier, ct);
    return Results.Ok((await store.PatientAsync(Access(context), id, context.TraceIdentifier, ct)).Patient);
});
api.MapPost("/patients/{id:long}/diagnoses", async (long id, AddDiagnosisRequest request, HttpContext context, MedcoreStore store, CancellationToken ct) =>
{
    if (!AccessPolicies.CanEditDiagnosis(Access(context), true)) return Results.Problem(statusCode: 403, title: "Изменение диагноза разрешено только врачу");
    var errors = RequestValidation.Errors(request);
    if (errors.Count > 0) return Results.ValidationProblem(errors, title: "Проверьте данные диагноза");
    var diagnosisId = await store.AddDiagnosisAsync(Access(context), id, request, context.TraceIdentifier, ct);
    return Results.Created($"/api/patients/{id}/diagnoses/{diagnosisId}", new { id = diagnosisId });
});
OrganizationEndpoints.Map(api);
EmployeeEndpoints.Map(api);
HospitalizationEndpoints.Map(api);
LaboratoryEndpoints.Map(api);
DiagnosisEndpoints.Map(api);
AdminEndpoints.Map(api);
ReportEndpoints.Map(api);
app.Run();

public partial class Program;
