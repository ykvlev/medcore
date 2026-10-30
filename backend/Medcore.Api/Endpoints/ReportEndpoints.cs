using System.Globalization;
using System.Text;
using Medcore.Application;
using Medcore.Infrastructure;
using PdfSharp;
using PdfSharp.Drawing;
using PdfSharp.Fonts;
using PdfSharp.Pdf;

namespace Medcore.Api;

// Отчёты и экспорт. Права проверяются в ReportStore теми же правилами, что и
// просмотр: администратор организации, аналитик, главный врач, заместитель,
// заведующий отделением, министр и губернатор.
public static class ReportEndpoints
{
    private static readonly string[] Kinds =
        ["occupancy", "patients", "hospitalizations", "doctors", "surgeries", "laboratory"];

    public static void Map(IEndpointRouteBuilder api)
    {
        foreach (var reportKind in Kinds)
        {
            api.MapGet($"/reports/{reportKind}", async (HttpContext context, MedcoreStore store,
                    DateOnly? from, DateOnly? to, CancellationToken ct) =>
                    Results.Ok(await store.ReportAsync(Access(context), reportKind, from, to, ct)))
                .WithSummary("Отчёт с периодом from/to (Europe/Moscow)");
        }
        api.MapGet("/reports/{kind}/export", async (string kind, string? format, DateOnly? from, DateOnly? to,
            HttpContext context, MedcoreStore store, CancellationToken ct) =>
        {
            var normalized = (format ?? "csv").Trim().ToLowerInvariant();
            if (normalized is not ("csv" or "pdf"))
                return Results.ValidationProblem(new Dictionary<string, string[]>
                {
                    ["format"] = ["Допустимые форматы экспорта: csv или pdf"]
                }, title: "Проверьте формат экспорта");
            var report = await store.ReportAsync(Access(context), kind, from, to, ct);
            var fileName = $"medcore-{report.Kind}-{report.From}-{report.To}";
            return normalized == "csv"
                ? Results.File(ReportExport.Csv(report), "text/csv; charset=utf-8", fileName + ".csv")
                : Results.File(ReportExport.Pdf(report), "application/pdf", fileName + ".pdf");
        }).WithSummary("Экспорт отчёта в CSV (UTF-8 с BOM) или PDF (A4)");
    }

    private static UserAccess Access(HttpContext context) =>
        (UserAccess)context.Items[SessionAuthenticationHandler.AccessItem]!;
}

internal static class ReportExport
{
    private static readonly TimeSpan MoscowOffset = TimeSpan.FromHours(3);

    public static byte[] Csv(ReportResult report)
    {
        // UTF-8 с BOM и разделителем ';' открывается в русской Excel без настройки.
        var builder = new StringBuilder();
        builder.Append(string.Join(';', report.Columns.Select(column => CsvField(column.Label)))).Append("\r\n");
        foreach (var row in report.Rows)
            builder.Append(string.Join(';', report.Columns
                .Select(column => CsvField(Format(row.GetValueOrDefault(column.Key)))))).Append("\r\n");
        var encoding = new UTF8Encoding(encoderShouldEmitUTF8Identifier: true);
        return encoding.GetPreamble().Concat(encoding.GetBytes(builder.ToString())).ToArray();
    }

    public static byte[] Pdf(ReportResult report)
    {
        MedcoreFonts.Ensure();
        try
        {
            using var document = new PdfDocument();
            document.Info.Title = report.Title;
            document.Info.Subject = $"Период {report.From} — {report.To} (Europe/Moscow)";
            document.Info.Author = "MEDCORE";
            document.Info.Creator = "MEDCORE";

            var titleFont = new XFont(MedcoreFonts.Family, 15, XFontStyleEx.Bold);
            var subtitleFont = new XFont(MedcoreFonts.Family, 9, XFontStyleEx.Regular);
            var headerFont = new XFont(MedcoreFonts.Family, 8.5, XFontStyleEx.Bold);
            var cellFont = new XFont(MedcoreFonts.Family, 8, XFontStyleEx.Regular);
            var boldCellFont = new XFont(MedcoreFonts.Family, 8, XFontStyleEx.Bold);
            var footerFont = new XFont(MedcoreFonts.Family, 7.5, XFontStyleEx.Regular);

            var landscape = report.Columns.Count > 5;
            var page = AddPage(document, landscape);
            var graphics = XGraphics.FromPdfPage(page);
            const double margin = 32;
            var contentWidth = page.Width.Point - margin * 2;
            var y = DrawHeading(graphics, report, margin, contentWidth, titleFont, subtitleFont);

            var widths = ColumnWidths(report, contentWidth);
            y = DrawHeader(graphics, report, widths, margin, y, headerFont);
            var rowHeight = 15.0;
            foreach (var row in report.Rows)
            {
                if (y + rowHeight > page.Height.Point - 50)
                {
                    graphics.Dispose();
                    page = AddPage(document, landscape);
                    graphics = XGraphics.FromPdfPage(page);
                    y = margin;
                    y = DrawHeader(graphics, report, widths, margin, y, headerFont);
                }
                DrawRow(graphics, report, row, widths, margin, y, rowHeight, cellFont);
                y += rowHeight;
            }

            if (report.Rows.Count == 0)
            {
                graphics.DrawString("За выбранный период данных нет.", cellFont, XBrushes.Black,
                    new XRect(margin, y + 6, contentWidth, 14), XStringFormats.TopLeft);
                y += 26;
            }

            if (y + 40 > page.Height.Point - 46)
            {
                graphics.Dispose();
                page = AddPage(document, landscape);
                graphics = XGraphics.FromPdfPage(page);
                y = margin;
                y = DrawHeader(graphics, report, widths, margin, y, headerFont);
            }
            DrawTotals(graphics, report, widths, margin, y, rowHeight + 3, boldCellFont, subtitleFont);
            graphics.Dispose();
            DrawFooters(document, footerFont);
            using var stream = new MemoryStream();
            document.Save(stream, false);
            return stream.ToArray();
        }
        catch (ApplicationFault) { throw; }
        catch (Exception error)
        {
            throw new ApplicationFault(503, "Не удалось сформировать PDF: " + error.GetType().Name);
        }
    }

    private static PdfPage AddPage(PdfDocument document, bool landscape)
    {
        var page = document.AddPage();
        page.Size = PageSize.A4;
        if (landscape) page.Orientation = PageOrientation.Landscape;
        return page;
    }

    private static double DrawHeading(XGraphics graphics, ReportResult report, double margin, double contentWidth,
        XFont titleFont, XFont subtitleFont)
    {
        var y = margin;
        graphics.DrawString(report.Title, titleFont, XBrushes.Black,
            new XRect(margin, y, contentWidth, 22), XStringFormats.TopLeft);
        y += 24;
        graphics.DrawString($"Период: {RuDate(report.From)} — {RuDate(report.To)} (Europe/Moscow)",
            subtitleFont, XBrushes.DimGray, new XRect(margin, y, contentWidth, 14), XStringFormats.TopLeft);
        y += 18;
        graphics.DrawLine(new XPen(XColor.FromArgb(150, 165, 180), 0.8), margin, y, margin + contentWidth, y);
        return y + 8;
    }

    private static double[] ColumnWidths(ReportResult report, double contentWidth)
    {
        var weights = report.Columns.Select(column =>
        {
            var max = column.Label.Length;
            foreach (var row in report.Rows)
                max = Math.Max(max, Format(row.GetValueOrDefault(column.Key)).Length);
            return Math.Clamp(max, 8, 42);
        }).ToArray();
        var total = weights.Sum();
        return weights.Select(weight => contentWidth * weight / total).ToArray();
    }

    private static double DrawHeader(XGraphics graphics, ReportResult report, double[] widths, double margin,
        double y, XFont font)
    {
        const double height = 20;
        var x = margin;
        var pen = new XPen(XColor.FromArgb(150, 165, 180), 0.6);
        var fill = new XSolidBrush(XColor.FromArgb(226, 233, 240));
        for (var index = 0; index < report.Columns.Count; index++)
        {
            graphics.DrawRectangle(pen, fill, x, y, widths[index], height);
            graphics.DrawString(Fit(graphics, report.Columns[index].Label, font, widths[index] - 8),
                font, XBrushes.Black, new XRect(x + 3, y + 5, widths[index] - 6, height - 6),
                XStringFormats.TopLeft);
            x += widths[index];
        }
        return y + height;
    }

    private static void DrawRow(XGraphics graphics, ReportResult report, IReadOnlyDictionary<string, object?> row,
        double[] widths, double margin, double y, double height, XFont font)
    {
        var x = margin;
        var pen = new XPen(XColor.FromArgb(196, 206, 216), 0.4);
        for (var index = 0; index < report.Columns.Count; index++)
        {
            var text = Format(row.GetValueOrDefault(report.Columns[index].Key));
            graphics.DrawRectangle(pen, x, y, widths[index], height);
            graphics.DrawString(Fit(graphics, text, font, widths[index] - 8), font, XBrushes.Black,
                new XRect(x + 3, y + 4, widths[index] - 6, height - 4), XStringFormats.TopLeft);
            x += widths[index];
        }
    }

    private static void DrawTotals(XGraphics graphics, ReportResult report, double[] widths, double margin,
        double y, double height, XFont boldFont, XFont noteFont)
    {
        var x = margin;
        var pen = new XPen(XColor.FromArgb(150, 165, 180), 0.6);
        var fill = new XSolidBrush(XColor.FromArgb(238, 242, 246));
        for (var index = 0; index < report.Columns.Count; index++)
        {
            var text = index == 0 ? "Итого" : TotalText(report, index);
            graphics.DrawRectangle(pen, fill, x, y, widths[index], height);
            graphics.DrawString(Fit(graphics, text, boldFont, widths[index] - 8), boldFont, XBrushes.Black,
                new XRect(x + 3, y + 6, widths[index] - 6, height - 6), XStringFormats.TopLeft);
            x += widths[index];
        }
        graphics.DrawString($"Строк: {report.Rows.Count}", noteFont, XBrushes.DimGray,
            new XRect(margin, y + height + 6, widths.Sum(), 12), XStringFormats.TopLeft);
    }

    private static readonly HashSet<string> NotSummed = ["occupancyPercent", "averageHours", "experienceYears"];

    private static string TotalText(ReportResult report, int index)
    {
        var column = report.Columns[index];
        if (column.Key == "occupancyPercent")
        {
            var bedDays = SumColumn(report, "bedDays");
            var occupied = SumColumn(report, "occupiedBedDays");
            return bedDays is > 0 && occupied is not null
                ? Format(Math.Round(100m * occupied.Value / bedDays.Value, 2))
                : "";
        }
        if (NotSummed.Contains(column.Key)) return "";
        var sum = SumColumn(report, column.Key);
        return sum is null ? "" : Format(sum.Value);
    }

    private static decimal? SumColumn(ReportResult report, string key)
    {
        decimal sum = 0;
        var found = false;
        foreach (var row in report.Rows)
        {
            switch (row.GetValueOrDefault(key))
            {
                case long number: sum += number; found = true; break;
                case int number: sum += number; found = true; break;
                case decimal number: sum += number; found = true; break;
                case double number: sum += (decimal)number; found = true; break;
            }
        }
        return found ? sum : null;
    }

    private static void DrawFooters(PdfDocument document, XFont font)
    {
        var stamp = DateTimeOffset.UtcNow.ToOffset(MoscowOffset).ToString("dd.MM.yyyy HH:mm", CultureInfo.InvariantCulture);
        for (var index = 0; index < document.Pages.Count; index++)
        {
            var page = document.Pages[index];
            var graphics = XGraphics.FromPdfPage(page, XGraphicsPdfPageOptions.Append);
            const double margin = 32;
            var width = page.Width.Point - margin * 2;
            var y = page.Height.Point - 30;
            graphics.DrawLine(new XPen(XColor.FromArgb(180, 190, 200), 0.6), margin, y - 6, margin + width, y - 6);
            graphics.DrawString($"Сформировано: {stamp} (Europe/Moscow)", font, XBrushes.DimGray,
                new XRect(margin, y, width, 12), XStringFormats.TopLeft);
            graphics.DrawString($"Стр. {index + 1} из {document.Pages.Count}", font, XBrushes.DimGray,
                new XRect(margin, y, width, 12), new XStringFormat
                {
                    Alignment = XStringAlignment.Far,
                    LineAlignment = XLineAlignment.Near
                });
            graphics.Dispose();
        }
    }

    private static string Fit(XGraphics graphics, string text, XFont font, double width)
    {
        if (width <= 0) return "";
        if (graphics.MeasureString(text, font).Width <= width) return text;
        const string ellipsis = "…";
        var low = 0;
        var high = text.Length;
        while (low < high)
        {
            var middle = (low + high + 1) / 2;
            if (graphics.MeasureString(text[..middle] + ellipsis, font).Width <= width) low = middle;
            else high = middle - 1;
        }
        return low == 0 ? ellipsis : text[..low] + ellipsis;
    }

    private static string CsvField(string? value)
    {
        value ??= "";
        var quote = value.Contains(';') || value.Contains('"') || value.Contains('\r') || value.Contains('\n')
            || (value.Length > 0 && (char.IsWhiteSpace(value[0]) || char.IsWhiteSpace(value[^1])));
        return quote ? "\"" + value.Replace("\"", "\"\"") + "\"" : value;
    }

    private static string Format(object? value) => value switch
    {
        null => "",
        decimal number => number.ToString("0.##", CultureInfo.InvariantCulture),
        double number => number.ToString("0.##", CultureInfo.InvariantCulture),
        float number => number.ToString("0.##", CultureInfo.InvariantCulture),
        long number => number.ToString(CultureInfo.InvariantCulture),
        int number => number.ToString(CultureInfo.InvariantCulture),
        bool flag => flag ? "да" : "нет",
        _ => Convert.ToString(value, CultureInfo.InvariantCulture) ?? ""
    };

    private static string RuDate(string isoDate) =>
        DateOnly.TryParseExact(isoDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)
            ? date.ToString("dd.MM.yyyy", CultureInfo.InvariantCulture)
            : isoDate;
}

// PDFsharp не использует системные шрифты сам: в PDF попадает встроенный TrueType.
// Arial/DejaVu покрывают кириллицу; если шрифта нет, экспорт честно отвечает 503.
internal static class MedcoreFonts
{
    public const string Family = "Medcore Sans";
    private const string RegularFace = "MedcoreSans-Regular";
    private const string BoldFace = "MedcoreSans-Bold";

    private static readonly Lazy<byte[]> Regular = new(() => Load(RegularFace));
    private static readonly Lazy<byte[]> Bold = new(() => Load(BoldFace));

    public static void Ensure()
    {
        _ = Regular.Value;
        _ = Bold.Value;
        if (!ReferenceEquals(GlobalFontSettings.FontResolver, Resolver.Instance))
            GlobalFontSettings.FontResolver = Resolver.Instance;
    }

    private static byte[] Load(string face)
    {
        var bold = face == BoldFace;
        foreach (var path in Candidates(bold))
        {
            try
            {
                if (File.Exists(path)) return File.ReadAllBytes(path);
            }
            catch (IOException) { }
        }
        throw new ApplicationFault(503, "Для PDF не найден шрифт с поддержкой кириллицы");
    }

    private static IEnumerable<string> Candidates(bool bold)
    {
        var names = bold
            ? new[] { "arialbd.ttf", "segoeuib.ttf", "DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf" }
            : new[] { "arial.ttf", "segoeui.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf" };
        var fonts = Environment.GetFolderPath(Environment.SpecialFolder.Fonts);
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        foreach (var name in names)
        {
            if (!string.IsNullOrEmpty(fonts)) yield return Path.Combine(fonts, name);
            if (!string.IsNullOrEmpty(windows)) yield return Path.Combine(windows, "Fonts", name);
            yield return Path.Combine("/usr/share/fonts/truetype/dejavu", name);
            yield return Path.Combine("/usr/share/fonts/truetype/liberation", name);
            yield return Path.Combine(AppContext.BaseDirectory, "fonts", name);
        }
    }

    private sealed class Resolver : IFontResolver
    {
        public static readonly Resolver Instance = new();

        public FontResolverInfo? ResolveTypeface(string familyName, bool isBold, bool isItalic) =>
            new(isBold ? BoldFace : RegularFace);

        public byte[]? GetFont(string faceName) => faceName == BoldFace ? Bold.Value : Regular.Value;
    }
}
