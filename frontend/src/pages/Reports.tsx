import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BedDouble, CalendarDays, ClipboardList, FileSpreadsheet, FileText, FlaskConical, LoaderCircle, Scissors, Stethoscope, Users } from 'lucide-react';
import { api, errorMessage, type ProblemDetails } from '../api';
import { date, number, percent, workspaceScopeLabel } from '../format';
import type { ReportTable } from '../types';
import { Button, Empty, ErrorState, Loading, PageHeading, Panel, useToast } from '../components/ui';
import { firstDayOfYearValue, isValidDateRange, todayValue } from '../components/medcoreUtils';
import { useAuth } from '../auth';
import './Reports.css';

type ReportKind = 'occupancy' | 'patients' | 'hospitalizations' | 'doctors' | 'surgeries' | 'laboratory';

const reportKinds: { kind: ReportKind; label: string; icon: typeof BedDouble }[] = [
  { kind: 'occupancy', label: 'Коечный фонд', icon: BedDouble },
  { kind: 'patients', label: 'Пациенты по учреждениям', icon: Users },
  { kind: 'hospitalizations', label: 'Госпитализации', icon: ClipboardList },
  { kind: 'doctors', label: 'Нагрузка врачей', icon: Stethoscope },
  { kind: 'surgeries', label: 'Операции', icon: Scissors },
  { kind: 'laboratory', label: 'Исследования', icon: FlaskConical },
];

function contentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const utf8 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (utf8?.[1]) {
    try { return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, '')); }
    catch { return utf8[1].trim().replace(/^"|"$/g, ''); }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/i.exec(header);
  if (quoted?.[1]) return quoted[1];
  const plain = /filename\s*=\s*([^;]+)/i.exec(header);
  return plain?.[1]?.trim() ?? null;
}

function safeFilename(name: string) {
  return name.replace(/[\\/:*?"<>|\r\n]/g, '_');
}

function cellText(key: string, value: string | number | null) {
  if (value === null || value === '') return '—';
  if (typeof value === 'number') return /percent|share|occupancy/i.test(key) ? percent(value) : number(value);
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return date(value, true);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return date(value);
  return value;
}

export function ReportsPage() {
  const toast = useToast();
  const { user } = useAuth();
  const scopeLabel = user ? workspaceScopeLabel(user.roles) : null;
  const aggregateScope = !!user && (user.roles.includes('minister_of_health') || user.roles.includes('governor'));
  const scopeName = user?.roles.includes('minister_of_health') ? 'города' : 'региона';
  const [kind, setKind] = useState<ReportKind>('occupancy');
  const [period, setPeriod] = useState(() => ({ from: firstDayOfYearValue(), to: todayValue() }));
  const [fromInput, setFromInput] = useState(period.from);
  const [toInput, setToInput] = useState(period.to);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<'csv' | 'pdf' | null>(null);
  const report = useQuery({ queryKey: ['report', kind, period.from, period.to], queryFn: () => api<ReportTable>(`/reports/${kind}?${new URLSearchParams({ from: period.from, to: period.to })}`) });
  const activeKind = reportKinds.find(item => item.kind === kind) ?? reportKinds[0];
  const columns = useMemo(() => report.data?.columns ?? [], [report.data]);
  const rows = report.data?.rows ?? [];
  function applyPeriod() {
    if (!isValidDateRange(fromInput, toInput)) {
      setRangeError('Проверьте период: начало не должно быть позже окончания.');
      return;
    }
    setRangeError(null);
    setPeriod({ from: fromInput, to: toInput });
  }
  async function exportReport(format: 'csv' | 'pdf') {
    setExporting(format);
    try {
      const params = new URLSearchParams({ format, from: period.from, to: period.to });
      const response = await fetch(`/api/reports/${kind}/export?${params}`, { credentials: 'include', headers: { Accept: format === 'csv' ? 'text/csv' : 'application/pdf' } });
      if (!response.ok) {
        if (response.status === 401) window.dispatchEvent(new Event('medcore:session-expired'));
        const problem = await response.json().catch(() => null) as ProblemDetails | null;
        throw new Error(problem?.detail || problem?.title || `Экспорт не выполнен, код ответа ${response.status}.`);
      }
      const blob = await response.blob();
      const filename = safeFilename(contentDispositionFilename(response.headers.get('Content-Disposition')) || `medcore-${kind}-${period.from}-${period.to}.${format}`);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`Файл ${filename} сформирован`);
    } catch (error) {
      toast(error instanceof TypeError ? 'Нет соединения с сервером. Проверьте, что сервер MEDCORE запущен.' : errorMessage(error), 'error');
    } finally {
      setExporting(null);
    }
  }
  return <>
    <PageHeading eyebrow={scopeLabel ? `Аналитика / ${scopeLabel}` : 'Аналитика / Отчёты'} title={aggregateScope ? 'Сводные отчёты' : 'Отчёты и экспорт'} description={aggregateScope ? `Агрегированные показатели учреждений ${scopeName} без персональных данных` : scopeLabel === 'Показатели больницы' ? 'Сводные отчёты по больнице и её учреждениям' : scopeLabel === 'Показатели отделения' ? 'Показатели и отчёты вашего отделения' : 'Шесть сводных отчётов по доступной области с выгрузкой в CSV и PDF'} />
    <Panel className="reports-filter-panel"><form className="reports-filter" onSubmit={event => { event.preventDefault(); applyPeriod(); }}><div className="field"><label htmlFor="report-from">С даты</label><input id="report-from" type="date" value={fromInput} onChange={event => setFromInput(event.target.value)} /></div><div className="field"><label htmlFor="report-to">По дату</label><input id="report-to" type="date" value={toInput} onChange={event => setToInput(event.target.value)} /></div><Button type="submit" variant="secondary"><CalendarDays size={15} /> Сформировать</Button><span className="reports-period-hint">Период включительно · Europe/Moscow</span></form>{rangeError && <div className="form-error reports-range-error" role="alert">{rangeError}</div>}</Panel>
    <div className="reports-tabs" role="group" aria-label="Тип отчёта">{reportKinds.map(item => <button key={item.kind} type="button" aria-pressed={kind === item.kind} className={kind === item.kind ? 'selected' : ''} onClick={() => setKind(item.kind)}><item.icon size={16} /><span>{item.label}</span></button>)}</div>
    <Panel className="report-table-panel">
      <div className="report-head"><div><span className="eyebrow">Отчёт</span><h2>{report.data?.title || activeKind.label}</h2><p>{report.isFetching ? 'Обновляем данные…' : `Период: ${date(period.from)} — ${date(period.to)}`}</p></div><div className="report-export-actions"><Button variant="secondary" disabled={!!exporting} onClick={() => void exportReport('csv')}>{exporting === 'csv' ? <LoaderCircle size={15} className="spin" /> : <FileSpreadsheet size={15} />} CSV</Button><Button variant="secondary" disabled={!!exporting} onClick={() => void exportReport('pdf')}>{exporting === 'pdf' ? <LoaderCircle size={15} className="spin" /> : <FileText size={15} />} PDF</Button></div></div>
      {report.isPending ? <Loading label="Формируем отчёт" /> : report.isError ? <ErrorState error={report.error} retry={() => void report.refetch()} /> : report.data && <>
        <div className="report-summary"><div><span>Отчёт</span><strong>{report.data.title}</strong></div><div><span>Период</span><strong>{date(report.data.from)} — {date(report.data.to)}</strong></div><div><span>Итого строк</span><strong>{number(report.data.totals.rowCount)}</strong></div></div>
        {columns.length === 0 || rows.length === 0 ? <Empty title="Нет данных за период" description="Измените период или проверьте доступную область отчёта." /> : <div className="table-scroll report-table-wrap"><table className="data-table report-table" aria-label={report.data.title}><caption className="report-caption">{report.data.title}, период {date(report.data.from)} — {date(report.data.to)}</caption><thead><tr>{columns.map(column => <th key={column.key} scope="col">{column.label}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map(column => { const text = cellText(column.key, row[column.key] ?? null); return <td key={`${column.key}-${index}`} className={text === '—' ? 'muted' : undefined}>{text}</td>; })}</tr>)}</tbody><tfoot><tr><td colSpan={columns.length}>Итого строк: {number(report.data.totals.rowCount)}</td></tr></tfoot></table></div>}
      </>}
    </Panel>
  </>;
}
