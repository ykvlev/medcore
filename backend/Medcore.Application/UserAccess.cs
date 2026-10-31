namespace Medcore.Application;

public sealed record UserAccess(long UserId, long? EmployeeId, string Login, string DisplayName,
    string[] Roles, IReadOnlyDictionary<string, long[]> OrganizationsByRole,
    long[] LaboratoryIds, OrganizationReference[] Organizations)
{
    // Область отделения задаётся только для head_of_department (CHECK миграции 004).
    public long? DepartmentId { get; init; }

    public bool HasRole(string role) => Roles.Contains(role, StringComparer.Ordinal);
    public long[] OrganizationIdsFor(string role) => OrganizationsByRole.GetValueOrDefault(role) ?? [];
    public long[] OrganizationIds => OrganizationsByRole.Values.SelectMany(x => x).Distinct().ToArray();
    public CurrentUser ToCurrentUser() => new(UserId, Login, DisplayName, Roles, Organizations);
}

public static class AccessPolicies
{
    private static readonly string[] HospitalReadRoles =
        ["chief_physician", "deputy_chief_physician", "head_of_department"];

    private static readonly string[] AllOrganizationReportRoles = ["minister_of_health", "governor"];

    private static readonly string[] ReportManagerRoles = ["organization_admin", "analyst"];

    // Снабжение: остатки и заказы читают управленческие роли учреждения; заказ
    // оформляет и принимает администратор организации, главный врач и заместитель.
    private static readonly string[] SupplyReadRoles =
        ["organization_admin", "chief_physician", "deputy_chief_physician", "head_of_department"];

    private static readonly string[] SupplyManagerRoles =
        ["organization_admin", "chief_physician", "deputy_chief_physician"];

    // Перевозки: оформляет и ведёт регистратор, врач и управленческие роли; заведующий
    // отделением только читает, как и в остальных больничных разделах.
    private static readonly string[] TransportManagerRoles =
        ["organization_admin", "chief_physician", "deputy_chief_physician"];

    // Больничные роли читают пациентов только в области своей больницы.
    public static bool IsHospitalReader(UserAccess user) =>
        HospitalReadRoles.Any(user.HasRole);

    public static long[] HospitalReadOrganizationIds(UserAccess user) =>
        HospitalReadRoles.SelectMany(user.OrganizationIdsFor).Distinct().ToArray();

    // Организации, которыми роль управляет как учреждением (не структура, а чтение
    // и отчёты): администратор организации и больничные роли.
    public static long[] ManagerOrganizationIds(UserAccess user) =>
        user.OrganizationIdsFor("organization_admin")
            .Concat(HospitalReadOrganizationIds(user)).Distinct().ToArray();

    public static bool CanReadPatients(UserAccess user) =>
        user.HasRole("registrar")
        || (user.HasRole("doctor") && user.EmployeeId.HasValue)
        || (IsHospitalReader(user) && HospitalReadOrganizationIds(user).Length > 0);

    public static bool CanRegisterPatient(UserAccess user, long polyclinicId) =>
        user.HasRole("registrar") && user.OrganizationIdsFor("registrar").Contains(polyclinicId);
    public static bool CanEditPatientContacts(UserAccess user) => user.HasRole("registrar");
    public static bool CanEditDiagnosis(UserAccess user, bool hasCareRelationship) =>
        user.HasRole("doctor") && user.EmployeeId.HasValue && hasCareRelationship;

    public static bool CanReadReports(UserAccess user) =>
        ReportManagerRoles.Any(user.HasRole) || IsHospitalReader(user) || CanReadAllOrganizations(user);

    // Министр и губернатор получают только сводные данные по всем организациям.
    public static bool CanReadAllOrganizations(UserAccess user) =>
        AllOrganizationReportRoles.Any(user.HasRole);

    public static long[] ReportOrganizationIds(UserAccess user) =>
        ReportManagerRoles.SelectMany(user.OrganizationIdsFor)
            .Concat(HospitalReadOrganizationIds(user)).Distinct().ToArray();

    // Персонал: chief/deputy управляют в своей больнице, head — только чтение.
    public static bool CanReadEmployees(UserAccess user) =>
        user.HasRole("system_admin") || user.HasRole("organization_admin") || user.HasRole("doctor")
        || user.HasRole("registrar") || IsHospitalReader(user);

    public static bool CanManageEmployees(UserAccess user) =>
        user.HasRole("system_admin") || user.HasRole("organization_admin")
        || user.HasRole("chief_physician") || user.HasRole("deputy_chief_physician");

    // Структуру меняет главный врач; заместитель и заведующий — нет.
    public static bool CanManageStructure(UserAccess user) =>
        user.HasRole("system_admin") || user.HasRole("organization_admin")
        || user.HasRole("chief_physician");

    // Область отделения для статистики заведующего; NULL для остальных ролей.
    public static long? DepartmentScope(UserAccess user) =>
        user.HasRole("head_of_department") ? user.DepartmentId : null;

    // ---------- Направления к специалистам (миграция 007) ----------

    // Список направлений доступен регистратору своей организации, врачу по своим
    // случаям и больничным ролям в области своей больницы.
    public static bool CanReadReferrals(UserAccess user) =>
        user.HasRole("registrar") || (user.HasRole("doctor") && user.EmployeeId.HasValue)
        || IsHospitalReader(user);

    // Оформляет направление врач по своим случаям, регистратор по своей организации
    // и больничные роли (главный врач, заместитель, заведующий) по своей больнице.
    public static bool CanCreateReferral(UserAccess user) =>
        user.HasRole("registrar") || (user.HasRole("doctor") && user.EmployeeId.HasValue)
        || IsHospitalReader(user);

    // Статус меняет врач случая, регистратор организации и главный врач с заместителем;
    // заведующий отделением попадает в больничные роли наравне с ними.
    public static bool CanChangeReferralStatus(UserAccess user) =>
        user.HasRole("registrar") || (user.HasRole("doctor") && user.EmployeeId.HasValue)
        || IsHospitalReader(user);

    // Область направлений: организации регистратора и больницы больничных ролей.
    public static long[] ReferralOrganizationIds(UserAccess user) =>
        user.OrganizationIdsFor("registrar").Concat(HospitalReadOrganizationIds(user)).Distinct().ToArray();

    // ---------- Снабжение (миграция 007) ----------

    public static bool CanReadSupplies(UserAccess user) => SupplyReadRoles.Any(user.HasRole);

    public static bool CanManageSupplyOrders(UserAccess user) => SupplyManagerRoles.Any(user.HasRole);

    // Организации снабжения в порядке приоритета роли: администратор, главный врач,
    // заместитель, заведующий отделением.
    public static long[] SupplyOrganizationIds(UserAccess user) =>
        SupplyReadRoles.SelectMany(user.OrganizationIdsFor).Distinct().ToArray();

    public static long[] SupplyManagerOrganizationIds(UserAccess user) =>
        SupplyManagerRoles.SelectMany(user.OrganizationIdsFor).Distinct().ToArray();

    // ---------- Транспортировка пациентов (миграция 007) ----------

    public static bool CanReadTransports(UserAccess user) =>
        user.HasRole("registrar") || (user.HasRole("doctor") && user.EmployeeId.HasValue)
        || user.HasRole("organization_admin") || IsHospitalReader(user);

    public static bool CanCreateTransport(UserAccess user) =>
        user.HasRole("registrar") || (user.HasRole("doctor") && user.EmployeeId.HasValue)
        || TransportManagerRoles.Any(user.HasRole);

    // Ведёт перевозку регистратор и управленческие роли; врач и заведующий отделением
    // оформляют и читают, но статус не меняют.
    public static bool CanUpdateTransport(UserAccess user) =>
        user.HasRole("registrar") || TransportManagerRoles.Any(user.HasRole);

    public static long[] TransportOrganizationIds(UserAccess user) =>
        user.OrganizationIdsFor("registrar").Concat(ManagerOrganizationIds(user)).Distinct().ToArray();

    public static long[] TransportEditOrganizationIds(UserAccess user) =>
        user.OrganizationIdsFor("registrar")
            .Concat(TransportManagerRoles.SelectMany(user.OrganizationIdsFor)).Distinct().ToArray();

    // ---------- Расписание и приём (миграция 008) ----------

    // Талон, запись и расписание читают регистратор, врач и управленческие роли
    // учреждения; заведующий отделением только читает, как и в остальных разделах.
    private static readonly string[] AppointmentReaderRoles =
    [
        "registrar", "doctor", "organization_admin", "chief_physician", "deputy_chief_physician",
        "head_of_department"
    ];

    // Запись на талон и смену статуса выполняют регистратор, врач и управленческие роли.
    private static readonly string[] AppointmentManagerRoles =
        ["registrar", "doctor", "organization_admin", "chief_physician", "deputy_chief_physician"];

    // Расписание создаёт и отменяет администратор организации, главный врач и заместитель.
    private static readonly string[] ScheduleManagerRoles =
        ["organization_admin", "chief_physician", "deputy_chief_physician"];

    public static bool CanReadSlots(UserAccess user) => AppointmentReaderRoles.Any(user.HasRole);

    public static bool CanReadAppointments(UserAccess user) => AppointmentReaderRoles.Any(user.HasRole);

    public static bool CanReadSchedules(UserAccess user) => AppointmentReaderRoles.Any(user.HasRole);

    public static bool CanBookAppointment(UserAccess user) => AppointmentManagerRoles.Any(user.HasRole);

    public static bool CanChangeAppointmentStatus(UserAccess user) =>
        AppointmentManagerRoles.Any(user.HasRole);

    public static bool CanManageSchedules(UserAccess user) => ScheduleManagerRoles.Any(user.HasRole);

    // Область приёма: организации регистратора и врача плюс учреждения управленческих
    // ролей; заведующий отделением попадает в неё через свою больницу.
    public static long[] AppointmentOrganizationIds(UserAccess user) =>
        user.OrganizationIdsFor("registrar").Concat(user.OrganizationIdsFor("doctor"))
            .Concat(ManagerOrganizationIds(user)).Distinct().ToArray();

    // Запись и смена статуса — без заведующего отделением: он только читает.
    public static long[] AppointmentManagerOrganizationIds(UserAccess user) =>
        user.OrganizationIdsFor("registrar").Concat(user.OrganizationIdsFor("doctor"))
            .Concat(ScheduleManagerRoles.SelectMany(user.OrganizationIdsFor)).Distinct().ToArray();

    // Расписанием управляет администратор организации, главный врач и заместитель.
    public static long[] ScheduleManagerOrganizationIds(UserAccess user) =>
        ScheduleManagerRoles.SelectMany(user.OrganizationIdsFor).Distinct().ToArray();

    // ---------- Закупки (миграция 008) ----------

    // Финансовые данные закупок видят управленческие роли учреждения; заведующий
    // отделением к договорам, тендерам и счетам не допускается.
    private static readonly string[] ProcurementRoles =
        ["organization_admin", "chief_physician", "deputy_chief_physician"];

    public static bool CanReadProcurement(UserAccess user) => ProcurementRoles.Any(user.HasRole);

    public static bool CanManageProcurement(UserAccess user) => ProcurementRoles.Any(user.HasRole);

    public static long[] ProcurementOrganizationIds(UserAccess user) =>
        ProcurementRoles.SelectMany(user.OrganizationIdsFor).Distinct().ToArray();
}
