import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ChevronLeft, ChevronRight, ClipboardCheck, Eye, FlaskConical, MapPin, Microscope, Phone, Plus, Search } from 'lucide-react';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { date, hasRole, number } from '../format';
import type { Dictionaries, ItemList, LabOrderDetail, LabOrderRow, Laboratory, Paged, Patient } from '../types';
import { Badge, Button, DataTable, Empty, ErrorState, Loading, PageHeading, Panel, PanelHeading, Submitting, useToast } from '../components/ui';
import { MedcoreDialog } from '../components/MedcoreDialog';
import { PatientLookup } from '../components/PatientLookup';
import { localDateTimeValue, payloadHasTotal, payloadItems, payloadTotal, toIsoMoment } from '../components/medcoreUtils';
import './Laboratories.css';

const PAGE_SIZE = 15;
const orderStatusNames: Record<string, string> = { pending: 'Ожидает результата', completed: 'Завершён', cancelled: 'Отменён' };

function orderStatusName(status: string) {
  return orderStatusNames[status] || status;
}

function plural(count: number, forms: [string, string, string]) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}

function profilesOf(value: string[] | string | null) {
  if (Array.isArray(value)) return value.filter(Boolean);
  return (value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function OrderDetailDialog({ id, canReport, onClose, onResult }: { id: number; canReport: boolean; onClose: () => void; onResult: (order: LabOrderRow) => void }) {
  const query = useQuery({ queryKey: ['lab-order', id], queryFn: () => api<LabOrderDetail>(`/lab-orders/${id}`) });
  const order = query.data;
  return <MedcoreDialog open onClose={onClose} eyebrow="Лаборатории / Заказ" title={order ? order.testName : 'Заказ исследования'} description={order ? `${order.patientName} · ${order.laboratoryName}` : 'Загружаем сведения о заказе'}>{query.isPending ? <Loading label="Открываем заказ" /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : order && <>
    <div className="lab-detail-top"><Badge status={order.status}>{orderStatusName(order.status)}</Badge><span className="lab-detail-number">Заказ № {order.id}</span></div>
    <dl className="lab-facts"><div><dt>Пациент</dt><dd>{order.patientName}</dd></div><div><dt>Исследование</dt><dd>{order.testName}</dd></div><div><dt>Лаборатория</dt><dd>{order.laboratoryName}</dd></div><div><dt>Врач</dt><dd>{order.doctorName || '—'}</dd></div><div><dt>Заказан</dt><dd>{date(order.orderedAt, true)}</dd></div><div><dt>Завершён</dt><dd>{order.completedAt ? date(order.completedAt, true) : '—'}</dd></div></dl>
    <section className="lab-result-section" aria-labelledby="lab-result-title"><h3 id="lab-result-title">Результат</h3>{order.result ? <dl className="lab-facts lab-result-facts"><div><dt>Значение</dt><dd>{order.result.value}{order.result.unit ? ` ${order.result.unit}` : ''}</dd></div><div><dt>Референсный интервал</dt><dd>{order.result.referenceRange || '—'}</dd></div><div><dt>Заключение</dt><dd>{order.result.conclusion || '—'}</dd></div><div><dt>Выполнен</dt><dd>{date(order.result.performedAt, true)}</dd></div></dl> : <p className="lab-empty-line">Результат ещё не введён.</p>}</section>
    {canReport && order.status === 'pending' && <div className="lab-detail-actions"><Button onClick={() => onResult(order)}><ClipboardCheck size={15} /> Ввести результат</Button></div>}
  </>}</MedcoreDialog>;
}

function ResultForm({ order, onClose }: { order: LabOrderRow; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState('');
  const [unit, setUnit] = useState('');
  const [referenceRange, setReferenceRange] = useState('');
  const [conclusion, setConclusion] = useState('');
  const [performedAt, setPerformedAt] = useState(localDateTimeValue());
  const [validation, setValidation] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: () => api<{ id: number }>(`/lab-orders/${order.id}/results`, { method: 'POST', body: JSON.stringify({ value: value.trim(), unit: unit.trim() || null, referenceRange: referenceRange.trim() || null, conclusion: conclusion.trim() || null, performedAt: toIsoMoment(performedAt) }) }), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['lab-orders'] });
    void client.invalidateQueries({ queryKey: ['lab-order', order.id] });
    toast('Результат исследования сохранён');
    onClose();
  } });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!value.trim()) return setValidation('Введите значение результата.');
    if (!performedAt) return setValidation('Укажите дату и время выполнения.');
    mutation.mutate();
  }
  return <form className="lab-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate><fieldset disabled={mutation.isPending}><div className="lab-form-note"><strong>{order.patientName}</strong><span>{order.testName} · {order.laboratoryName}</span></div><div className="form-grid"><div className="field"><label htmlFor="result-value">Значение <span>*</span></label><input id="result-value" value={value} onChange={event => setValue(event.target.value)} autoComplete="off" /></div><div className="field"><label htmlFor="result-unit">Единица измерения</label><input id="result-unit" value={unit} onChange={event => setUnit(event.target.value)} autoComplete="off" placeholder="например, ммоль/л" /></div><div className="field"><label htmlFor="result-range">Референсный интервал</label><input id="result-range" value={referenceRange} onChange={event => setReferenceRange(event.target.value)} autoComplete="off" placeholder="например, 3,5–5,5" /></div><div className="field"><label htmlFor="result-at">Дата и время выполнения <span>*</span></label><input id="result-at" type="datetime-local" value={performedAt} onChange={event => setPerformedAt(event.target.value)} /></div><div className="field field-wide"><label htmlFor="result-conclusion">Заключение</label><textarea id="result-conclusion" rows={3} value={conclusion} onChange={event => setConclusion(event.target.value)} /></div></div></fieldset>{validation && <div className="form-error" role="alert">{validation}</div>}{mutation.isError && <div className="form-error" role="alert">Не удалось сохранить результат: {errorMessage(mutation.error)}</div>}<div className="dialog-actions"><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button><Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Сохранить результат</Submitting></Button></div></form>;
}

function OrderForm({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [testTypeId, setTestTypeId] = useState('');
  const [orderedAt, setOrderedAt] = useState(localDateTimeValue());
  const [validation, setValidation] = useState<string | null>(null);
  const dictionaries = useQuery({ queryKey: ['dictionaries'], queryFn: () => api<Dictionaries>('/dictionaries') });
  const mutation = useMutation({ mutationFn: () => api<{ id: number }>('/lab-orders', { method: 'POST', body: JSON.stringify({ patientId: patient?.id, testTypeId: Number(testTypeId), orderedAt: toIsoMoment(orderedAt) }) }), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['lab-orders'] });
    toast('Заказ исследования создан');
    onClose();
  } });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!patient) return setValidation('Выберите пациента.');
    if (!testTypeId) return setValidation('Выберите исследование.');
    if (!orderedAt) return setValidation('Укажите дату и время заказа.');
    mutation.mutate();
  }
  return <form className="lab-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate><fieldset disabled={mutation.isPending}><div className="form-section-label"><Search size={15} /> Пациент</div><PatientLookup patient={patient} onSelect={setPatient} /><div className="form-section-label form-section-next"><FlaskConical size={15} /> Исследование</div><div className="form-grid"><div className="field field-wide"><label htmlFor="order-test">Исследование <span>*</span></label><select id="order-test" value={testTypeId} onChange={event => setTestTypeId(event.target.value)} disabled={dictionaries.isPending}><option value="">{dictionaries.isPending ? 'Загружаем…' : 'Выберите исследование'}</option>{(dictionaries.data?.labTestTypes || []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{dictionaries.isError && <span className="field-error">Не удалось загрузить справочник исследований.</span>}</div><div className="field field-wide"><label htmlFor="order-at">Дата и время заказа <span>*</span></label><input id="order-at" type="datetime-local" value={orderedAt} onChange={event => setOrderedAt(event.target.value)} /></div></div><p className="lab-form-note lab-form-note-block">Сервер сам подберёт открытый случай пациента и действующий договор лаборатории, проверив профиль и срок действия на дату заказа.</p></fieldset>{validation && <div className="form-error" role="alert">{validation}</div>}{mutation.isError && <div className="form-error" role="alert">Не удалось создать заказ: {errorMessage(mutation.error)}</div>}<div className="dialog-actions"><span className="form-required">Врач определяется по текущей сессии</span><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button><Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Создать заказ</Submitting></Button></div></form>;
}
export function LaboratoriesPage() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'all' | 'pending' | 'completed'>('all');
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [dialog, setDialog] = useState<{ type: 'order' } | { type: 'result'; order: LabOrderRow } | null>(null);
  const canOrder = !!user && hasRole(user.roles, ['doctor']);
  const canReport = !!user && hasRole(user.roles, ['lab_staff']);
  const canViewOrders = !!user && hasRole(user.roles, ['lab_staff', 'organization_admin', 'doctor']);
  const laboratories = useQuery({ queryKey: ['laboratories'], queryFn: () => api<ItemList<Laboratory>>('/laboratories') });
  const labItems = useMemo(() => payloadItems(laboratories.data), [laboratories.data]);
  const filteredLabs = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('ru');
    if (!needle) return labItems;
    return labItems.filter(item => [item.name, item.address, ...profilesOf(item.profiles)].filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(needle));
  }, [labItems, search]);
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (status !== 'all') params.set('status', status);
  const orders = useQuery({ queryKey: ['lab-orders', status, page], queryFn: () => api<Paged<LabOrderRow>>(`/lab-orders?${params}`), enabled: canViewOrders, placeholderData: keepPreviousData });
  const orderItems = payloadItems(orders.data);
  const total = payloadTotal(orders.data);
  const pages = payloadHasTotal(orders.data) ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;
  const columns = useMemo<ColumnDef<LabOrderRow>[]>(() => [
    { accessorKey: 'patientName', header: 'Пациент', cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.patientName}</strong><span>Заказ № {row.original.id}</span></div> },
    { accessorKey: 'testName', header: 'Исследование', cell: ({ row }) => <span className="cell-wrap">{row.original.testName}</span> },
    { accessorKey: 'laboratoryName', header: 'Лаборатория', cell: ({ row }) => <span className="cell-wrap">{row.original.laboratoryName}</span> },
    { accessorKey: 'status', header: 'Статус', cell: ({ row }) => <Badge status={row.original.status}>{orderStatusName(row.original.status)}</Badge> },
    { accessorKey: 'orderedAt', header: 'Заказан', cell: ({ row }) => <span className="cell-date">{date(row.original.orderedAt, true)}</span> },
    { accessorKey: 'completedAt', header: 'Завершён', cell: ({ row }) => <span className="cell-date">{row.original.completedAt ? date(row.original.completedAt, true) : '—'}</span> },
    { id: 'actions', header: '', cell: ({ row }) => <div className="table-actions"><button className="icon-button" type="button" aria-label={`Открыть заказ: ${row.original.testName}`} title="Открыть заказ" onClick={() => setDetailId(row.original.id)}><Eye size={17} /></button>{canReport && row.original.status === 'pending' && <button className="icon-button" type="button" aria-label={`Ввести результат: ${row.original.testName}`} title="Ввести результат" onClick={() => setDialog({ type: 'result', order: row.original })}><ClipboardCheck size={17} /></button>}</div> },
  ], [canReport]);
  function applyStatus(next: 'all' | 'pending' | 'completed') {
    setStatus(next);
    setPage(1);
  }
  return <>
    <PageHeading eyebrow="Диагностика / Лаборатории" title="Лаборатории и исследования" description="Профили, действующие договоры и лабораторные заказы" action={canOrder && <Button onClick={() => setDialog({ type: 'order' })}><Plus size={17} /> Новый заказ</Button>} />
    <div className="lab-toolbar"><div className="search-field"><Search size={17} /><input aria-label="Поиск лабораторий" placeholder="Название, адрес или профиль исследования" value={search} onChange={event => setSearch(event.target.value)} /></div><span className="table-result-count">{laboratories.isFetching ? 'Обновляем…' : `${number(filteredLabs.length)} ${plural(filteredLabs.length, ['лаборатория', 'лаборатории', 'лабораторий'])}`}</span></div>
    {laboratories.isPending ? <Panel><Loading label="Загружаем лаборатории" /></Panel> : laboratories.isError ? <Panel><ErrorState error={laboratories.error} retry={() => void laboratories.refetch()} /></Panel> : !filteredLabs.length ? <Panel><Empty title="Лаборатории не найдены" description="Измените поиск или проверьте доступные договоры." /></Panel> : <div className="lab-grid">{filteredLabs.map((item, index) => <Panel className="lab-card" key={item.id} delay={Math.min(index * 0.025, 0.2)}><div className="lab-card-top"><span className="organization-icon tone-purple"><FlaskConical size={24} strokeWidth={1.5} /></span><span className="contract-count">{number(item.activeContracts)} {plural(item.activeContracts, ['действующий договор', 'действующих договора', 'действующих договоров'])}</span></div><span className="organization-type">Лаборатория</span><h2>{item.name}</h2>{profilesOf(item.profiles).length > 0 ? <div className="profile-tags">{profilesOf(item.profiles).map(profile => <span key={profile}>{profile}</span>)}</div> : <p className="lab-card-empty">Профили не указаны</p>}<div className="organization-contacts"><div><MapPin size={15} /><span>{item.address || 'Адрес не указан'}</span></div><div><Phone size={14} /><span>{item.phone || 'Телефон не указан'}</span></div></div></Panel>)}</div>}
    <Panel className="lab-orders-panel"><PanelHeading title="Заказы исследований" subtitle="Пациент, исследование, лаборатория и сроки выполнения" trailing={<span className="panel-icon"><Microscope size={17} /></span>} />{!canViewOrders ? <Empty small title="Заказы недоступны" description="Просмотр заказов доступен сотруднику лаборатории, врачу и администратору организации." /> : <><div className="table-toolbar table-toolbar-wrap"><div className="segmented-control" aria-label="Статус заказа">{[{ value: 'all', label: 'Все' }, { value: 'pending', label: 'Ожидают' }, { value: 'completed', label: 'Завершённые' }].map(tab => <button key={tab.value} type="button" className={status === tab.value ? 'selected' : ''} aria-pressed={status === tab.value} onClick={() => applyStatus(tab.value as 'all' | 'pending' | 'completed')}>{tab.label}</button>)}</div><span className="table-result-count">{orders.isFetching ? 'Обновляем…' : `${number(total)} ${plural(total, ['заказ', 'заказа', 'заказов'])}`}</span></div>{orders.isPending ? <Loading label="Загружаем заказы" /> : orders.isError ? <ErrorState error={orders.error} retry={() => void orders.refetch()} /> : <><DataTable data={orderItems} columns={columns} emptyTitle="Заказов нет" emptyDescription={status === 'all' ? 'В доступной области пока нет лабораторных заказов.' : 'В выбранной категории заказов нет.'} />{pages > 1 && <div className="table-pagination"><span>{total ? `${number((page - 1) * PAGE_SIZE + 1)}–${number(Math.min(page * PAGE_SIZE, total))} из ${number(total)}` : 'Нет записей'}</span><div><Button variant="ghost" aria-label="Предыдущая страница" disabled={page <= 1 || orders.isFetching} onClick={() => setPage(previous => previous - 1)}><ChevronLeft size={17} /></Button><span className="page-number">{page} / {pages}</span><Button variant="ghost" aria-label="Следующая страница" disabled={page >= pages || orders.isFetching} onClick={() => setPage(previous => previous + 1)}><ChevronRight size={17} /></Button></div></div>}</>}</>}</Panel>
    {detailId !== null && <OrderDetailDialog id={detailId} canReport={canReport} onClose={() => setDetailId(null)} onResult={order => { setDetailId(null); setDialog({ type: 'result', order }); }} />}
    {dialog?.type === 'order' && <MedcoreDialog open onClose={() => setDialog(null)} eyebrow="Лаборатории / Заказ" title="Новый лабораторный заказ" description="Заказ создаётся от имени текущего врача"><OrderForm onClose={() => setDialog(null)} /></MedcoreDialog>}
    {dialog?.type === 'result' && <MedcoreDialog open onClose={() => setDialog(null)} eyebrow="Лаборатории / Результат" title="Ввод результата исследования" description={`${dialog.order.patientName} · ${dialog.order.testName}`}><ResultForm order={dialog.order} onClose={() => setDialog(null)} /></MedcoreDialog>}
  </>;
}
