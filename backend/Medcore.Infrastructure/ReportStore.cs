using Medcore.Application;

namespace Medcore.Infrastructure;

// Шесть отчётов этапа 2. Период трактуется включительно по календарным датам
// Europe/Moscow: [from 00:00, to+1 00:00) в часовом поясе Москвы. Пустой набор
// разрешённых учреждений даёт пустые строки, а не ошибку.
public sealed partial class MedcoreStore
{
    // В Москве с 2014 года нет перехода на летнее время; смещение постоянно.
    private static readonly TimeSpan MoscowOffset = TimeSpan.FromHours(3);

    private static readonly string[] ReportKinds =
        ["occupancy", "patients", "hospitalizations", "doctors", "surgeries", "laboratory"];

    private static readonly Dictionary<string, string> ReportTitles = new()
    {
        ["occupancy"] = "Занятость коечного фонда",
        ["patients"] = "Пациенты и обращения",
        ["hospitalizations"] = "Госпитализации",
        ["doctors"] = "Врачи",
        ["surgeries"] = "Операции",
        ["laboratory"] = "Лабораторные исследования"
    };

    public async Task<ReportResult> ReportAsync(UserAccess access, string kind, DateOnly? from, DateOnly? to,
        CancellationToken cancellationToken)
    {
        if (!AccessPolicies.CanReadReports(access))
            throw new ApplicationFault(403, "Отчёты доступны администратору организации, аналитику, главному врачу, заместителю, заведующему отделением, министру и губернатору");
        var normalized = (kind ?? "").Trim().ToLowerInvariant();
        if (!ReportKinds.Contains(normalized, StringComparer.Ordinal))
            throw new ApplicationFault(404, "Неизвестный отчёт");
        var (periodFrom, periodTo) = ResolveReportPeriod(from, to);
        var parameters = new Dictionary<string, object?>
        {
            ["from_date"] = periodFrom,
            ["to_date"] = periodTo,
            ["orgs"] = await ReportOrganizationIdsAsync(access, cancellationToken),
            // Министр и губернатор получают сводные строки без персональных полей пациента.
            ["personal"] = !AccessPolicies.CanReadAllOrganizations(access)
        };
        return normalized switch
        {
            "occupancy" => await OccupancyReportAsync(parameters, periodFrom, periodTo, cancellationToken),
            "patients" => await PatientsReportAsync(parameters, periodFrom, periodTo, cancellationToken),
            "hospitalizations" => await HospitalizationsReportAsync(parameters, periodFrom, periodTo, cancellationToken),
            "doctors" => await DoctorsReportAsync(parameters, periodFrom, periodTo, cancellationToken),
            "surgeries" => await SurgeriesReportAsync(parameters, periodFrom, periodTo, cancellationToken),
            _ => await LaboratoryReportAsync(parameters, periodFrom, periodTo, cancellationToken)
        };
    }

    private static (DateOnly From, DateOnly To) ResolveReportPeriod(DateOnly? from, DateOnly? to)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow + MoscowOffset);
        var actualTo = to ?? today;
        var actualFrom = from ?? new DateOnly(actualTo.Year, actualTo.Month, 1);
        ValidatePeriod(actualFrom, actualTo);
        return (actualFrom, actualTo);
    }

    private static (DateOnly From, DateOnly To) ResolveAuditPeriod(DateOnly? from, DateOnly? to)
    {
        var today = DateOnly.FromDateTime(DateTime.UtcNow + MoscowOffset);
        var actualTo = to ?? today;
        var actualFrom = from ?? new DateOnly(1900, 1, 1);
        ValidatePeriod(actualFrom, actualTo);
        return (actualFrom, actualTo);
    }

    private static void ValidatePeriod(DateOnly from, DateOnly to)
    {
        if (from > to) throw new ApplicationFault(400, "Начало периода не может быть позже окончания");
        if (from.Year is < 1900 or > 2100 || to.Year is < 1900 or > 2100)
            throw new ApplicationFault(400, "Период должен находиться в диапазоне 1900–2100 годов");
    }

    private static (string From, string To) PeriodLabels(DateOnly from, DateOnly to) =>
        (from.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture),
         to.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture));

    private static List<ReportColumn> Columns(params (string Key, string Label)[] columns) =>
        columns.Select(x => new ReportColumn(x.Key, x.Label)).ToList();

    private static List<IReadOnlyDictionary<string, object?>> Project(
        IReadOnlyList<ReportColumn> columns, List<Dictionary<string, object?>> raw)
    {
        var rows = new List<IReadOnlyDictionary<string, object?>>(raw.Count);
        foreach (var source in raw)
        {
            var row = new Dictionary<string, object?>(columns.Count);
            foreach (var column in columns) row[column.Key] = source.GetValueOrDefault(column.Key);
            rows.Add(row);
        }
        return rows;
    }

    // Контракт: totals содержит только rowCount; числовые итоги для PDF
    // вычисляются при выводе, чтобы не расширять машинный формат отчёта.
    private static Dictionary<string, object?> Totals(
        IReadOnlyList<IReadOnlyDictionary<string, object?>> rows) => new() { ["rowCount"] = rows.Count };

    // Отчёт о занятости: койко-дни за период по фактическим интервалам размещения
    // относятся к койко-дням текущего физического фонда отделения.
    private async Task<ReportResult> OccupancyReportAsync(Dictionary<string, object?> parameters,
        DateOnly from, DateOnly to, CancellationToken cancellationToken)
    {
        var raw = await RowsAsync("""
            WITH bounds AS (
                SELECT ((@from_date)::timestamp AT TIME ZONE 'Europe/Moscow') AS starts,
                       (((@to_date + 1))::timestamp AT TIME ZONE 'Europe/Moscow') AS ends
            ), beds AS (
                SELECT o.id AS hospital_id, o.name AS hospital_name,
                       d.id AS department_id, d.name AS department_name,
                       count(b.id)::bigint AS total_beds
                FROM project.departments d
                JOIN project.buildings bu ON bu.id = d.building_id
                JOIN project.medical_organizations o ON o.id = bu.hospital_id
                LEFT JOIN project.wards w ON w.department_id = d.id
                LEFT JOIN project.beds b ON b.ward_id = w.id
                WHERE o.id = ANY(@orgs)
                GROUP BY o.id, o.name, d.id, d.name
            ), period AS (
                SELECT b.starts, b.ends,
                       GREATEST(EXTRACT(EPOCH FROM (LEAST(b.ends, CURRENT_TIMESTAMP) - b.starts)) / 86400.0, 0) AS days
                FROM bounds b
            ), occupancy AS (
                SELECT w.department_id,
                       sum(EXTRACT(EPOCH FROM (LEAST(COALESCE(bo.ended_at, CURRENT_TIMESTAMP), p.ends)
                           - GREATEST(bo.started_at, p.starts))) / 86400.0) AS occupied_days
                FROM project.bed_occupancies bo
                JOIN project.beds b ON b.id = bo.bed_id
                JOIN project.wards w ON w.id = b.ward_id
                CROSS JOIN period p
                WHERE bo.started_at < LEAST(p.ends, CURRENT_TIMESTAMP)
                  AND COALESCE(bo.ended_at, CURRENT_TIMESTAMP) > p.starts
                GROUP BY w.department_id
            )
            SELECT b.hospital_name AS "hospitalName", b.department_name AS "departmentName",
                b.total_beds AS "totalBeds",
                round(b.total_beds * p.days, 2) AS "bedDays",
                round(COALESCE(oc.occupied_days, 0), 2) AS "occupiedBedDays",
                round(100.0 * COALESCE(oc.occupied_days, 0) / nullif(b.total_beds * p.days, 0), 2) AS "occupancyPercent"
            FROM beds b
            CROSS JOIN period p
            LEFT JOIN occupancy oc ON oc.department_id = b.department_id
            ORDER BY b.hospital_name, b.department_name
            """, parameters, cancellationToken);
        var columns = Columns(
            ("hospitalName", "Учреждение"), ("departmentName", "Отделение"),
            ("totalBeds", "Всего коек"), ("bedDays", "Койко-дней за период"),
            ("occupiedBedDays", "Занято койко-дней"), ("occupancyPercent", "Средняя занятость, %"));
        var rows = Project(columns, raw);
        var totals = Totals(rows);
        var (fromLabel, toLabel) = PeriodLabels(from, to);
        return new ReportResult("occupancy", ReportTitles["occupancy"], fromLabel, toLabel, columns, rows, totals);
    }

    private async Task<ReportResult> PatientsReportAsync(Dictionary<string, object?> parameters,
        DateOnly from, DateOnly to, CancellationToken cancellationToken)
    {
        var raw = await RowsAsync("""
            WITH bounds AS (
                SELECT ((@from_date)::timestamp AT TIME ZONE 'Europe/Moscow') AS starts,
                       (((@to_date + 1))::timestamp AT TIME ZONE 'Europe/Moscow') AS ends
            ), cases AS (
                SELECT c.id, c.patient_id, c.organization_id
                FROM project.medical_cases c
                CROSS JOIN bounds b
                WHERE c.organization_id = ANY(@orgs) AND c.status <> 'cancelled'
                  AND c.opened_at >= b.starts AND c.opened_at < b.ends
            ), visits AS (
                SELECT c.organization_id, count(*)::bigint AS completed_visits
                FROM project.appointments a
                JOIN project.medical_cases c ON c.id = a.case_id
                CROSS JOIN bounds b
                WHERE c.organization_id = ANY(@orgs) AND a.status = 'completed'
                  AND a.completed_at >= b.starts AND a.completed_at < b.ends
                GROUP BY c.organization_id
            ), admissions AS (
                SELECT bu.hospital_id AS organization_id, count(*)::bigint AS hospitalizations
                FROM project.hospitalizations h
                JOIN project.departments d ON d.id = h.department_id
                JOIN project.buildings bu ON bu.id = d.building_id
                CROSS JOIN bounds b
                WHERE bu.hospital_id = ANY(@orgs) AND h.status <> 'cancelled'
                  AND h.admitted_at >= b.starts AND h.admitted_at < b.ends
                GROUP BY bu.hospital_id
            ), rollup AS (
                SELECT organization_id, count(*)::bigint AS cases, count(DISTINCT patient_id)::bigint AS patients
                FROM cases GROUP BY organization_id
            )
            SELECT o.name AS "organizationName",
                COALESCE(r.patients, 0)::bigint AS "patients",
                COALESCE(r.cases, 0)::bigint AS "cases",
                COALESCE(v.completed_visits, 0)::bigint AS "visits",
                COALESCE(a.hospitalizations, 0)::bigint AS "hospitalizations"
            FROM project.medical_organizations o
            LEFT JOIN rollup r ON r.organization_id = o.id
            LEFT JOIN visits v ON v.organization_id = o.id
            LEFT JOIN admissions a ON a.organization_id = o.id
            WHERE o.id = ANY(@orgs)
            ORDER BY o.name
            """, parameters, cancellationToken);
        var columns = Columns(
            ("organizationName", "Учреждение"), ("patients", "Пациентов"), ("cases", "Обращений"),
            ("visits", "Приёмов"), ("hospitalizations", "Госпитализаций"));
        var rows = Project(columns, raw);
        var totals = Totals(rows);
        var (fromLabel, toLabel) = PeriodLabels(from, to);
        return new ReportResult("patients", ReportTitles["patients"], fromLabel, toLabel, columns, rows, totals);
    }

    private async Task<ReportResult> HospitalizationsReportAsync(Dictionary<string, object?> parameters,
        DateOnly from, DateOnly to, CancellationToken cancellationToken)
    {
        var raw = await RowsAsync("""
            WITH bounds AS (
                SELECT ((@from_date)::timestamp AT TIME ZONE 'Europe/Moscow') AS starts,
                       (((@to_date + 1))::timestamp AT TIME ZONE 'Europe/Moscow') AS ends
            )
            SELECT CASE WHEN @personal THEN concat_ws(' ', p.last_name, p.first_name, p.middle_name)
                    ELSE 'Обезличено' END AS "patientName",
                o.name AS "hospitalName", d.name AS "departmentName",
                to_char(h.admitted_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS "admittedAt",
                to_char(h.discharged_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS "dischargedAt",
                round(EXTRACT(EPOCH FROM (COALESCE(h.discharged_at, LEAST(b.ends, CURRENT_TIMESTAMP))
                    - h.admitted_at)) / 86400.0, 2) AS "stayDays",
                h.status::text AS "status"
            FROM project.hospitalizations h
            JOIN project.patients p ON p.id = h.patient_id
            JOIN project.departments d ON d.id = h.department_id
            JOIN project.buildings bu ON bu.id = d.building_id
            JOIN project.medical_organizations o ON o.id = bu.hospital_id
            CROSS JOIN bounds b
            WHERE bu.hospital_id = ANY(@orgs) AND h.status <> 'cancelled'
              AND h.admitted_at >= b.starts AND h.admitted_at < b.ends
            ORDER BY h.admitted_at, h.id
            """, parameters, cancellationToken);
        var columns = Columns(
            ("patientName", "Пациент"), ("hospitalName", "Учреждение"), ("departmentName", "Отделение поступления"),
            ("admittedAt", "Поступил"), ("dischargedAt", "Выписан"), ("stayDays", "Койко-дней"),
            ("status", "Статус"));
        var rows = Project(columns, raw);
        var totals = Totals(rows);
        var (fromLabel, toLabel) = PeriodLabels(from, to);
        return new ReportResult("hospitalizations", ReportTitles["hospitalizations"], fromLabel, toLabel, columns, rows, totals);
    }

    private async Task<ReportResult> DoctorsReportAsync(Dictionary<string, object?> parameters,
        DateOnly from, DateOnly to, CancellationToken cancellationToken)
    {
        var raw = await RowsAsync("""
            WITH bounds AS (
                SELECT ((@from_date)::timestamp AT TIME ZONE 'Europe/Moscow') AS starts,
                       (((@to_date + 1))::timestamp AT TIME ZONE 'Europe/Moscow') AS ends
            )
            SELECT concat_ws(' ', e.last_name, e.first_name, e.middle_name) AS "fullName",
                COALESCE((SELECT string_agg(s.name, ', ' ORDER BY s.name)
                    FROM project.doctor_specialties ds JOIN project.specialties s ON s.id = ds.specialty_id
                    WHERE ds.doctor_id = d.employee_id AND ds.certified_on <= @to_date
                      AND (ds.valid_until IS NULL OR ds.valid_until >= @from_date)), '') AS "specialties",
                COALESCE((SELECT string_agg(DISTINCT o.name, ', ' ORDER BY o.name)
                    FROM project.employments em JOIN project.medical_organizations o ON o.id = em.organization_id
                    WHERE em.employee_id = d.employee_id AND em.organization_id = ANY(@orgs)
                      AND daterange(em.started_on, em.ended_on, '[)')
                          && daterange(@from_date::date, (@to_date::date + 1), '[)')), '') AS "workplaces",
                project.fn_doctor_experience(d.employee_id, @to_date) AS "experienceYears",
                (SELECT count(*) FROM project.appointment_doctors ad
                    JOIN project.appointments a ON a.id = ad.appointment_id
                    JOIN project.medical_cases c ON c.id = a.case_id
                    WHERE ad.doctor_id = d.employee_id AND a.status = 'completed'
                      AND a.completed_at >= b.starts AND a.completed_at < b.ends
                      AND c.organization_id = ANY(@orgs))::bigint AS "appointments",
                (SELECT count(*) FROM project.surgery_participants sp
                    JOIN project.surgeries s ON s.id = sp.surgery_id
                    JOIN project.medical_cases c ON c.id = s.case_id
                    WHERE sp.doctor_id = d.employee_id AND s.outcome IN ('survived', 'fatal')
                      AND s.started_at >= b.starts AND s.started_at < b.ends
                      AND c.organization_id = ANY(@orgs))::bigint AS "surgeries",
                (SELECT count(*) FROM project.surgery_participants sp
                    JOIN project.surgeries s ON s.id = sp.surgery_id
                    JOIN project.medical_cases c ON c.id = s.case_id
                    WHERE sp.doctor_id = d.employee_id AND s.outcome = 'fatal'
                      AND s.started_at >= b.starts AND s.started_at < b.ends
                      AND c.organization_id = ANY(@orgs))::bigint AS "fatalSurgeries"
            FROM project.doctors d
            JOIN project.employees e ON e.id = d.employee_id
            CROSS JOIN bounds b
            WHERE EXISTS (SELECT 1 FROM project.employments em
                WHERE em.employee_id = d.employee_id AND em.organization_id = ANY(@orgs)
                  AND daterange(em.started_on, em.ended_on, '[)')
                      && daterange(@from_date::date, (@to_date::date + 1), '[)'))
            ORDER BY e.last_name, e.first_name, e.id
            """, parameters, cancellationToken);
        var columns = Columns(
            ("fullName", "Врач"), ("specialties", "Специальности"), ("workplaces", "Места работы"),
            ("experienceYears", "Стаж, лет"), ("appointments", "Приёмов"), ("surgeries", "Операций"),
            ("fatalSurgeries", "Летальных исходов"));
        var rows = Project(columns, raw);
        var totals = Totals(rows);
        var (fromLabel, toLabel) = PeriodLabels(from, to);
        return new ReportResult("doctors", ReportTitles["doctors"], fromLabel, toLabel, columns, rows, totals);
    }

    private async Task<ReportResult> SurgeriesReportAsync(Dictionary<string, object?> parameters,
        DateOnly from, DateOnly to, CancellationToken cancellationToken)
    {
        var raw = await RowsAsync("""
            WITH bounds AS (
                SELECT ((@from_date)::timestamp AT TIME ZONE 'Europe/Moscow') AS starts,
                       (((@to_date + 1))::timestamp AT TIME ZONE 'Europe/Moscow') AS ends
            )
            SELECT to_char(s.started_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD HH24:MI') AS "performedAt",
                CASE WHEN @personal THEN concat_ws(' ', p.last_name, p.first_name, p.middle_name)
                    ELSE 'Обезличено' END AS "patientName",
                o.name AS "hospitalName", s.name AS "surgeryName",
                COALESCE((SELECT concat_ws(' ', de.last_name, de.first_name, de.middle_name)
                    FROM project.surgery_participants sp
                    JOIN project.employees de ON de.id = sp.doctor_id
                    WHERE sp.surgery_id = s.id AND sp.participation_role = 'lead'), '—') AS "leadDoctor",
                s.outcome::text AS "outcome",
                round(EXTRACT(EPOCH FROM (COALESCE(s.ended_at, s.started_at) - s.started_at)) / 60.0) AS "durationMinutes"
            FROM project.surgeries s
            JOIN project.medical_cases c ON c.id = s.case_id
            JOIN project.patients p ON p.id = c.patient_id
            JOIN project.medical_organizations o ON o.id = c.organization_id
            CROSS JOIN bounds b
            WHERE c.organization_id = ANY(@orgs) AND s.outcome <> 'cancelled'
              AND s.started_at >= b.starts AND s.started_at < b.ends
            ORDER BY s.started_at, s.id
            """, parameters, cancellationToken);
        var columns = Columns(
            ("performedAt", "Дата операции"), ("patientName", "Пациент"), ("hospitalName", "Учреждение"),
            ("surgeryName", "Операция"), ("leadDoctor", "Ведущий врач"), ("outcome", "Исход"),
            ("durationMinutes", "Длительность, мин"));
        var rows = Project(columns, raw);
        var totals = Totals(rows);
        var (fromLabel, toLabel) = PeriodLabels(from, to);
        return new ReportResult("surgeries", ReportTitles["surgeries"], fromLabel, toLabel, columns, rows, totals);
    }

    private async Task<ReportResult> LaboratoryReportAsync(Dictionary<string, object?> parameters,
        DateOnly from, DateOnly to, CancellationToken cancellationToken)
    {
        var raw = await RowsAsync("""
            WITH bounds AS (
                SELECT ((@from_date)::timestamp AT TIME ZONE 'Europe/Moscow') AS starts,
                       (((@to_date + 1))::timestamp AT TIME ZONE 'Europe/Moscow') AS ends
            ), orders AS (
                SELECT lo.id, lo.status, lo.ordered_at, l.name AS laboratory_name
                FROM project.lab_orders lo
                JOIN project.laboratory_contracts lc ON lc.id = lo.contract_id
                JOIN project.laboratories l ON l.id = lc.laboratory_id
                CROSS JOIN bounds b
                WHERE lc.organization_id = ANY(@orgs)
                  AND lo.ordered_at >= b.starts AND lo.ordered_at < b.ends
            ), turnaround AS (
                SELECT r.order_id, min(r.entered_at) AS first_result_at
                FROM project.lab_results r GROUP BY r.order_id
            )
            SELECT o.laboratory_name AS "laboratoryName",
                count(*)::bigint AS "orders",
                count(*) FILTER (WHERE o.status = 'completed')::bigint AS "completed",
                count(*) FILTER (WHERE o.status = 'cancelled')::bigint AS "cancelled",
                count(*) FILTER (WHERE o.status IN ('ordered', 'in_progress'))::bigint AS "pending",
                round(avg(EXTRACT(EPOCH FROM (t.first_result_at - o.ordered_at)) / 3600.0)
                    FILTER (WHERE t.first_result_at IS NOT NULL), 2) AS "averageHours"
            FROM orders o
            LEFT JOIN turnaround t ON t.order_id = o.id
            GROUP BY o.laboratory_name
            ORDER BY o.laboratory_name
            """, parameters, cancellationToken);
        var columns = Columns(
            ("laboratoryName", "Лаборатория"), ("orders", "Заказов"), ("completed", "Завершено"),
            ("cancelled", "Отменено"), ("pending", "В работе"), ("averageHours", "Средний срок, ч"));
        var rows = Project(columns, raw);
        var totals = Totals(rows);
        var (fromLabel, toLabel) = PeriodLabels(from, to);
        return new ReportResult("laboratory", ReportTitles["laboratory"], fromLabel, toLabel, columns, rows, totals);
    }
}
