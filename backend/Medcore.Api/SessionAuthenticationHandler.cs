using System.Security.Claims;
using System.Text.Encodings.Web;
using Medcore.Infrastructure;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Medcore.Api;

public sealed class SessionAuthenticationHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options, ILoggerFactory logger,
    UrlEncoder encoder, MedcoreStore store) : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "MedcoreSession";
    public const string CookieName = "medcore_session";
    public const string AccessItem = "medcore.access";

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        if (!Request.Cookies.TryGetValue(CookieName, out var token)) return AuthenticateResult.NoResult();
        var access = await store.SessionAsync(token, Context.RequestAborted);
        if (access is null) return AuthenticateResult.Fail("Сессия недействительна или завершена");
        Context.Items[AccessItem] = access;
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, access.UserId.ToString(System.Globalization.CultureInfo.InvariantCulture)),
            new(ClaimTypes.Name, access.Login)
        };
        claims.AddRange(access.Roles.Select(role => new Claim(ClaimTypes.Role, role)));
        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName));
        return AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName));
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties) =>
        Results.Problem(statusCode: 401, title: "Требуется вход в систему").ExecuteAsync(Context);
    protected override Task HandleForbiddenAsync(AuthenticationProperties properties) =>
        Results.Problem(statusCode: 403, title: "Недостаточно прав").ExecuteAsync(Context);
}
