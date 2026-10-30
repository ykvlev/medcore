# -*- coding: utf-8 -*-
"""Диаграмма классов backend MEDCORE по фактическому коду."""
from pathlib import Path

from diagram_common import (AMBER, AMBER_L, BLUE, BLUE_L, GREEN, GREEN_L, INK,
                            MUTED, PURPLE, PURPLE_L, RED, RULE, TEAL, TEAL_L,
                            WHITE, arrow, block, canvas, check_bounds, header,
                            label, line, save, txt)

W, H = 2000, 1450
OUT = Path(__file__).with_name("class_diagram.png")

fig, ax = canvas(W, H)
header(ax, W, H,
       "Диаграмма классов backend MEDCORE",
       "Controllers/Endpoints, Stores, DbContext, Entities, DTO и политики доступа · по фактическому коду",
       sheet=6, total=6)

BAND = dict(fc="#fbfcfd", ec=RULE)


def band(x, y, w, h, title, color):
    block(ax, x, y, w, h, fc="#fbfcfd", ec=RULE, lw=0.8, rounding=5, z=1)
    txt(ax, x + 10, y + h - 16, title, 8.0, color, weight="bold", ha="left", z=2)


band(30, 1070, 1940, 205, "API · Minimal API и endpoint-классы", BLUE)
band(30, 790, 1940, 255, "APPLICATION · DTO, доступ, валидация", TEAL)
band(30, 460, 1940, 305, "INFRASTRUCTURE · Stores и EF Core", PURPLE)
band(30, 190, 1940, 245, "DOMAIN · правила и тесты", AMBER)


def cls(x, y, w, h, name, stereotype, lines, color=INK, light=WHITE, dashed=False):
    block(ax, x, y, w, h, fc=light, ec=color, lw=1.0, rounding=0,
          ls="--" if dashed else "-", z=3)
    block(ax, x, y + h - 24, w, 24, fc=light, ec=color, lw=1.0, rounding=0,
          ls="--" if dashed else "-", z=3)
    txt(ax, x + 7, y + h - 10, name, 9.6, color, weight="bold", ha="left", z=4)
    if stereotype:
        txt(ax, x + 7, y + h - 20, stereotype, 6.6, MUTED, ha="left", z=4)
    yy = y + h - 32
    for text, style in lines:
        txt(ax, x + 7, yy, text, 7.0, MUTED if style == "m" else INK,
            style="italic" if style == "i" else "normal", ha="left", z=4)
        yy -= 10.5


# API
cls(55, 1090, 520, 155, "Program", "minimal API · Program.cs", [
    ("+ MapGet/MapPost: /auth, /dashboard, /patients*", ""),
    ("+ MapGet: /organizations, /employees, /hospitalizations", ""),
    ("+ MapGet: /laboratories, /reports/overview", ""),
    ("+ UseAuthentication / UseAuthorization / UseRateLimiter", "m"),
    ("+ UseExceptionHandler → Problem Details", "m"),
], BLUE, BLUE_L)

cls(615, 1090, 380, 155, "SessionAuthenticationHandler",
    ": AuthenticationHandler", [
        ("+ const SchemeName = \"MedcoreSession\"", ""),
        ("+ const CookieName = \"medcore_session\"", ""),
        ("+ HandleAuthenticateAsync()", ""),
        ("- store.SessionAsync(token, ct)", "m"),
    ], BLUE, BLUE_L)

# Endpoint package
block(ax, 1035, 1075, 525, 175, fc=WHITE, ec=BLUE, lw=1.0, rounding=0,
      ls="--", z=3)
txt(ax, 1045, 1235, "Endpoints (static, 6 классов)", 8.6, BLUE, weight="bold",
    ha="left", z=4)
txt(ax, 1045, 1221, "Map(IEndpointRouteBuilder) — заготовки, маршруты не реализованы",
    6.4, MUTED, ha="left", z=4)
EP = ["OrganizationEndpoints", "EmployeeEndpoints", "HospitalizationEndpoints",
      "LaboratoryEndpoints", "AdminEndpoints", "ReportEndpoints"]
for i, name in enumerate(EP):
    yy = 1203 - i * 17
    txt(ax, 1050, yy, name, 6.9, INK, ha="left", z=4)
    txt(ax, 1300, yy, "Map(api)  ·  пусто", 6.5, RED, ha="left", z=4)

cls(1600, 1090, 350, 155, "ASP.NET Core", "внешний фреймворк", [
    ("AuthenticationHandler", "m"),
    ("IEndpointRouteBuilder", "m"),
    ("ProblemDetails / RateLimiter", "m"),
    ("NpgsqlDataSource", "m"),
], MUTED, "#f1f3f5")

# Application
cls(55, 830, 440, 150, "UserAccess", "sealed record · Application", [
    ("+ UserId, EmployeeId, Login, DisplayName", ""),
    ("+ Roles: string[]", ""),
    ("+ OrganizationsByRole: IReadOnlyDictionary", ""),
    ("+ HasRole(role): bool", ""),
    ("+ OrganizationIdsFor(role): long[]", ""),
    ("+ ToCurrentUser(): CurrentUser", ""),
], TEAL, TEAL_L)

cls(535, 830, 340, 150, "AccessPolicies", "static class", [
    ("+ CanReadPatients(UserAccess)", ""),
    ("+ CanRegisterPatient(UserAccess, long)", ""),
    ("+ CanEditPatientContacts(UserAccess)", ""),
    ("+ CanEditDiagnosis(UserAccess, bool)", ""),
    ("+ CanReadReports(UserAccess)", ""),
], TEAL, TEAL_L)

cls(920, 800, 440, 180, "DTO пациентов", "records · Contracts.cs", [
    ("RegisterPatientRequest", "b"),
    ("UpdatePatientRequest", "b"),
    ("AddDiagnosisRequest", "b"),
    ("PatientRow / PatientCard", "b"),
    ("PageResult<T> / HistoryItem", "b"),
], TEAL, TEAL_L)

cls(1400, 800, 550, 180, "DTO авторизации и общие", "records · Contracts.cs", [
    ("LoginRequest / LoginResult", "b"),
    ("CurrentUser / OrganizationReference", "b"),
    ("ApplicationFault : Exception", "b"),
    ("RequestValidation.Errors(object)", "b"),
    ("PageResult<T> — общий тип страницы", "b"),
], TEAL, TEAL_L)

# Infrastructure
cls(55, 470, 720, 240, "MedcoreStore", "sealed partial class · 3 файла", [
    ("- db: MedcoreDbContext", ""),
    ("- dataSource: NpgsqlDataSource", ""),
    ("Аутентификация: AccessAsync, LoginAsync, SessionAsync,", ""),
    ("  LogoutAsync, AuditAsync", ""),
    ("Пациенты: PatientsAsync, PatientAsync, RegisterPatientAsync,", ""),
    ("  UpdatePatientAsync, AddDiagnosisAsync", ""),
    ("Чтение: OrganizationsAsync, EmployeesAsync, HospitalizationsAsync,", ""),
    ("  LaboratoriesAsync, DashboardAsync, ReportsAsync", ""),
    ("+ SQL: CareCaseSql, RegistrarPatientSql, PatientAccessSql", "m"),
], PURPLE, PURPLE_L)

cls(805, 470, 500, 240, "MedcoreDbContext", ": DbContext", [
    ("+ DbSet<UserEntity> Users", ""),
    ("+ DbSet<PatientEntity> Patients", ""),
    ("+ DbSet<OrganizationEntity> Organizations", ""),
    ("+ DbSet<EmployeeEntity> Employees", ""),
    ("+ DbSet<MedicalCaseEntity> MedicalCases", ""),
    ("+ DbSet<AttachmentEntity> Attachments", ""),
    ("+ DbSet<AppointmentEntity> Appointments", ""),
    ("+ OnModelCreating(): schema project, snake_case", ""),
    ("+ TreatmentSummaryEntity → vw_patient_treatment_summary", "m"),
], PURPLE, PURPLE_L)

cls(1340, 450, 620, 265, "Entities (MedcoreDbContext.cs)", "8 POCO-классов", [
    ("UserEntity: Id, EmployeeId, Login, PasswordHash, IsActive", ""),
    ("PatientEntity: Id, LastName, FirstName, BirthDate, Version", ""),
    ("OrganizationEntity: Id, Name, OrganizationType, IsActive", ""),
    ("EmployeeEntity: Id, LastName, FirstName, IsActive", ""),
    ("MedicalCaseEntity: Id, PatientId, OrganizationId, Status", ""),
    ("AttachmentEntity: PatientId, PolyclinicId, StartedAt, EndedAt", ""),
    ("AppointmentEntity: Id, CaseId, Status, CompletedAt", ""),
    ("TreatmentSummaryEntity: PatientId (key), CaseCount, ...", ""),
    ("Все классы — public sealed class, без навигаций", "m"),
], PURPLE, PURPLE_L)

# Domain / tests
cls(55, 215, 420, 150, "HospitalizationRules", "static class · Domain", [
    ("+ Overlaps(firstStart, firstEnd,", ""),
    ("           secondStart, secondEnd): bool", ""),
    ("+ CanPlace(operational, startsAt, endsAt,", ""),
    ("           occupancies): bool", ""),
    ("Полуоткрытые интервалы [start, end)", "m"),
], AMBER, AMBER_L)

cls(505, 215, 380, 150, "Внешние зависимости", "Npgsql · EF Core 10", [
    ("NpgsqlDataSource", "m"),
    ("NpgsqlCommand / NpgsqlParameter", "m"),
    ("Microsoft.EntityFrameworkCore", "m"),
    ("PasswordHasher<UserEntity>", "m"),
], MUTED, "#f1f3f5")

cls(925, 215, 405, 150, "Тесты", "Medcore.Tests", [
    ("AuthorizationPolicyTests", "b"),
    ("  CanEditDiagnosis: регистратор → false", "m"),
    ("HospitalizationRulesTests", "b"),
    ("  занятая койка / пересечение интервалов", "m"),
], RED, "#f8ecec")

# Легенда
block(ax, 1365, 205, 595, 170, fc="#fbfcfd", ec=RULE, lw=0.8, rounding=3, z=3)
txt(ax, 1377, 355, "Обозначения", 8.0, INK, weight="bold", ha="left", z=4)
arrow(ax, [(1377, 334), (1450, 334)], color=INK, lw=1.0, head=8, head_w=4)
txt(ax, 1460, 334, "зависимость / вызов", 6.7, MUTED, ha="left", z=4)
arrow(ax, [(1377, 314), (1450, 314)], color=AMBER, lw=1.0, head=8, head_w=4, ls="--")
txt(ax, 1460, 314, "план / заготовка", 6.7, MUTED, ha="left", z=4)
ax.plot([1377, 1450], [294, 294], color=PURPLE, lw=1.0, zorder=4)
txt(ax, 1460, 294, "композиция DbSet", 6.7, MUTED, ha="left", z=4)
txt(ax, 1377, 272, "Сплошные рамки — реализовано; пунктир —", 6.5, MUTED, ha="left", z=4)
txt(ax, 1377, 258, "endpoint-заготовки из api-contract.md.", 6.5, MUTED, ha="left", z=4)
txt(ax, 1377, 238, "Program.cs: 12 групп маршрутов; endpoint-классы", 6.5, MUTED, ha="left", z=4)
txt(ax, 1377, 224, "пока не содержат маршрутов.", 6.5, MUTED, ha="left", z=4)

# Связи
arrow(ax, [(575, 1160), (615, 1160)], color=BLUE, lw=1.0, head=8, head_w=4)
label(ax, 595, 1176, "cookie", size=6.0, color=BLUE)

arrow(ax, [(575, 1120), (1035, 1120)], color=BLUE, lw=1.0, head=8, head_w=4, ls="--")
label(ax, 800, 1134, "Map(api)", size=6.2, color=BLUE)

arrow(ax, [(35, 1130), (35, 600), (55, 600)], color=BLUE, lw=1.0, head=8, head_w=4)
label(ax, 45, 870, "использует", size=6.2, color=BLUE, rotation=90)

arrow(ax, [(300, 1090), (300, 980)], color=TEAL, lw=1.0, head=8, head_w=4)
label(ax, 310, 1035, "Access(context)", size=6.0, color=TEAL)

arrow(ax, [(520, 1090), (520, 1040), (570, 1040), (570, 980)], color=TEAL,
      lw=1.0, head=8, head_w=4)
label(ax, 548, 1052, "политики", size=6.0, color=TEAL)

arrow(ax, [(810, 1090), (810, 1050), (900, 1050), (900, 740)], color=BLUE,
      lw=1.0, head=8, head_w=4)
label(ax, 855, 1062, "SessionAsync", size=6.0, color=BLUE)

arrow(ax, [(760, 600), (805, 600)], color=PURPLE, lw=1.0, head=8, head_w=4)
label(ax, 782, 614, "db", size=6.0, color=PURPLE)

arrow(ax, [(1305, 600), (1340, 600)], color=PURPLE, lw=1.0, head=8, head_w=4)
label(ax, 1322, 614, "DbSet", size=6.0, color=PURPLE)

arrow(ax, [(420, 710), (420, 830)], color=TEAL, lw=1.0, head=8, head_w=4)
label(ax, 430, 770, "access", size=6.0, color=TEAL)

arrow(ax, [(650, 710), (650, 830)], color=TEAL, lw=1.0, head=8, head_w=4)
label(ax, 660, 770, "Can*", size=6.0, color=TEAL)

arrow(ax, [(760, 830), (765, 830)], color=TEAL, lw=1.0, head=8, head_w=4)
label(ax, 762, 844, "uses", size=6.0, color=TEAL)

arrow(ax, [(720, 710), (720, 740), (1120, 740), (1120, 800)], color=TEAL,
      lw=1.0, head=8, head_w=4, ls="--")
label(ax, 930, 754, "возвращает DTO", size=6.0, color=TEAL)

arrow(ax, [(300, 470), (300, 420), (620, 420), (620, 365)], color=PURPLE,
      lw=1.0, head=8, head_w=4, ls="--")
label(ax, 470, 434, "Npgsql / SQL", size=6.0, color=PURPLE)

arrow(ax, [(475, 290), (535, 290)], color=AMBER, lw=1.0, head=8, head_w=4)
label(ax, 505, 304, "unit", size=6.0, color=AMBER)

check_bounds(fig, ax, "Class")
save(fig, OUT)
print("saved", OUT)

