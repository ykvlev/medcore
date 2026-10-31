import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Ambulance, ArrowRight, CheckCircle2, Play, Plus, Search, XCircle } from 'lucide-react';
import { api, createTransport, errorMessage, listTransports, updateTransportStatus } from '../api';
import { useAuth } from '../auth';
import { date, number } from '../format';
import type { EmployeeRow, ItemList, Organization, Patient, TransportRow } from '../types';
import { Badge, Button, DataTable, ErrorState, Loading, PageHeading, Panel, Submitting, useToast } from '../components/ui';
import { MedcoreDialog } from '../components/MedcoreDialog';
import { PatientLookup } from '../components/PatientLookup';
import { payloadItems } from '../components/medcoreUtils';
import './Transports.css';

const statusNames: Record<string, string> = {
  requested: 'Запрошена',
  in_progress: 'В пути',
  completed: 'Завершена',
  cancelled: 'Отменена',
};
const statusLabel = (status: string) => statusNames[status] || status;
const actionMessages: Record<string, string> = {
  in_progress: 'Перевозка начата',
  completed: 'Перевозка завершена',
  cancelled: 'Перевозка отменена',
};

function TransportForm({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [fromId, setFromId] = useState(() => user?.organizations[0] ? String(user.organizations[0].id) : '');
  const [toId, setToId] = useState('');
  const [reason, setReason] = useState('');
  const [vehicle, setVehicle] = useState('');
  const [accompanyingId, setAccompanyingId] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: () => api<ItemList<Organization>>('/organizations') });
  const organizationItems = useMemo(() => payloadItems(organizations.data).filter(item => item.isActive), [organizations.data]);
  const sourceOptions = user?.organizations.length ? user.organizations : organizationItems.map(item => ({ id: item.id, name: item.name }));
  const destinationOptions = organizationItems.filter(item => String(item.id) !== fromId);
  const employees = useQuery({
    queryKey: ['employees', 'transport', fromId],
    queryFn: () => api<ItemList<EmployeeRow>>(`/employees?${new URLSearchParams({ ...(fromId ? { organizationId: fromId } : {}), page: '1', pageSize: '100' })}`),
    enabled: !!fromId,
  });
  const employeeOptions = payloadItems(employees.data);
  const mutation = useMutation({
    mutationFn: () => createTransport({
      patientId: patient?.id ?? 0,
      fromOrganizationId: Number(fromId),
      toOrganizationId: Number(toId),
      reason: reason.trim(),
      vehicle: vehicle.trim() || null,
      accompanyingEmployeeId: accompanyingId ? Number(accompanyingId) : null,
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['transports'] });
      toast('Перевозка создана');
      onClose();
    },
  });
  function changeFrom(value: string) {
    setFromId(value);
    if (value === toId) setToId('');
    setAccompanyingId('');
  }
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!patient) return setValidation('Выберите пациента.');
    if (!fromId) return setValidation('Не удалось определить учреждение отправления.');
    if (!toId) return setValidation('Выберите учреждение назначения.');
    if (fromId === toId) return setValidation('Учреждения отправления и назначения должны различаться.');
    if (!reason.trim()) return setValidation('Опишите причину перевозки.');
    mutation.mutate();
  }
  return <form className="transport-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="form-section-label"><Search size={15} /> Пациент</div>
      <PatientLookup patient={patient} onSelect={setPatient} />
      <div className="form-section-label form-section-next"><Ambulance size={15} /> Маршрут и сопровождение</div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="transport-from">Откуда <span>*</span></label>
          <select id="transport-from" value={fromId} onChange={event => changeFrom(event.target.value)} disabled={organizations.isPending || sourceOptions.length <= 1}>
            {!sourceOptions.length && <option value="">{organizations.isPending ? 'Загружаем…' : 'Учреждение не определено'}</option>}
            {sourceOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <span className="field-hint">Рабочая область вашей учётной записи.</span>
        </div>
        <div className="field">
          <label htmlFor="transport-to">Куда <span>*</span></label>
          <select id="transport-to" value={toId} onChange={event => setToId(event.target.value)} disabled={organizations.isPending}>
            <option value="">{organizations.isPending ? 'Загружаем…' : 'Выберите учреждение'}</option>
            {destinationOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {organizations.isError && <span className="field-error">Не удалось загрузить учреждения.</span>}
        </div>
        <div className="field">
          <label htmlFor="transport-vehicle">Транспорт</label>
          <input id="transport-vehicle" value={vehicle} onChange={event => setVehicle(event.target.value)} autoComplete="off" placeholder="Например, реанимобиль № 4" />
        </div>
        <div className="field">
          <label htmlFor="transport-accompanying">Сопровождающий</label>
          <select id="transport-accompanying" value={accompanyingId} onChange={event => setAccompanyingId(event.target.value)} disabled={!fromId || employees.isPending}>
            <option value="">{!fromId ? 'Сначала выберите учреждение' : employees.isPending ? 'Загружаем…' : 'Без сопровождающего'}</option>
            {employeeOptions.map(item => <option key={item.id} value={item.id}>{item.fullName}</option>)}
          </select>
          <span className="field-hint">Необязательно: сотрудник учреждения отправления.</span>
          {employees.isError && <span className="field-error">Не удалось загрузить сотрудников.</span>}
        </div>
        <div className="field field-wide">
          <label htmlFor="transport-reason">Причина перевозки <span>*</span></label>
          <textarea id="transport-reason" rows={3} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} placeholder="Например, перевод в специализированное отделение" />
          <span className="field-hint">Не более 2000 символов.</span>
        </div>
      </div>
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось создать перевозку: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions">
      <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
      <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Создать перевозку</Submitting></Button>
    </div>
  </form>;
}

export function TransportsPage() {
  const client = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  // Заведующий отделением видит реестр, но заявки и смену статусов не оформляет.
  const canEdit = Boolean(user && user.roles.some(role => ['registrar', 'doctor', 'organization_admin', 'chief_physician', 'deputy_chief_physician'].includes(role)));
  const [status, setStatus] = useState<'all' | 'requested' | 'in_progress' | 'completed' | 'cancelled'>('all');
  const [creating, setCreating] = useState(false);
  const query = useQuery({
    queryKey: ['transports', status],
    queryFn: () => listTransports(status === 'all' ? undefined : status),
    placeholderData: keepPreviousData,
  });
  const action = useMutation({
    mutationFn: (input: { id: number; status: 'in_progress' | 'completed' | 'cancelled' }) => updateTransportStatus(input.id, input.status),
    onSuccess: (_, input) => {
      void client.invalidateQueries({ queryKey: ['transports'] });
      toast(actionMessages[input.status] || 'Статус перевозки обновлён');
    },
    onError: error => toast(errorMessage(error), 'error'),
  });
  const items = query.data ?? [];
  const columns = useMemo<ColumnDef<TransportRow>[]>(() => [
    { accessorKey: 'patientName', header: 'Пациент', cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.patientName || `Пациент № ${row.original.patientId}`}</strong><span>Перевозка № {row.original.id}</span></div> },
    { id: 'route', header: 'Маршрут', cell: ({ row }) => <div className="transport-route"><span>{row.original.fromOrganizationName || '—'}</span><span><ArrowRight size={12} /> {row.original.toOrganizationName || '—'}</span></div> },
    { accessorKey: 'reason', header: 'Причина', cell: ({ row }) => <span className="cell-wrap">{row.original.reason || '—'}</span> },
    { accessorKey: 'status', header: 'Статус', cell: ({ row }) => <Badge status={row.original.status}>{statusLabel(row.original.status)}</Badge> },
    { accessorKey: 'requestedAt', header: 'Дата', cell: ({ row }) => <span className="cell-date">{row.original.requestedAt ? date(row.original.requestedAt, true) : '—'}</span> },
    { accessorKey: 'vehicle', header: 'Транспорт', cell: ({ row }) => row.original.vehicle ? <span className="cell-wrap">{row.original.vehicle}</span> : <span className="muted">—</span> },
    { accessorKey: 'accompanyingName', header: 'Сопровождающий', cell: ({ row }) => row.original.accompanyingName ? <span className="cell-wrap">{row.original.accompanyingName}</span> : <span className="muted">—</span> },
    { id: 'actions', header: '', cell: ({ row }) => {
      if (!canEdit) return null;
      const current = row.original.status;
      return <div className="table-actions">
        {current === 'requested' && <button type="button" className="icon-button" title="Начать перевозку" aria-label={`Начать перевозку: ${row.original.patientName}`} disabled={action.isPending} onClick={() => action.mutate({ id: row.original.id, status: 'in_progress' })}><Play size={16} /></button>}
        {current === 'in_progress' && <button type="button" className="icon-button" title="Завершить перевозку" aria-label={`Завершить перевозку: ${row.original.patientName}`} disabled={action.isPending} onClick={() => action.mutate({ id: row.original.id, status: 'completed' })}><CheckCircle2 size={16} /></button>}
        {(current === 'requested' || current === 'in_progress') && <button type="button" className="icon-button transport-cancel" title="Отменить перевозку" aria-label={`Отменить перевозку: ${row.original.patientName}`} disabled={action.isPending} onClick={() => action.mutate({ id: row.original.id, status: 'cancelled' })}><XCircle size={16} /></button>}
      </div>;
    } },
  ], [action, canEdit]);
  return <>
    <PageHeading eyebrow="Логистика / Перевозки" title="Транспортировка" description="Перемещение пациентов между учреждениями и сопровождение" action={canEdit ? <Button onClick={() => setCreating(true)}><Plus size={17} /> Новая перевозка</Button> : undefined} />
    <Panel className="transports-panel">
      <div className="table-toolbar table-toolbar-wrap">
        <div className="segmented-control" aria-label="Статус перевозки">
          {([{ value: 'all', label: 'Все' }, { value: 'requested', label: 'Запрошены' }, { value: 'in_progress', label: 'В пути' }, { value: 'completed', label: 'Завершены' }, { value: 'cancelled', label: 'Отменены' }] as const).map(item => <button key={item.value} type="button" className={status === item.value ? 'selected' : ''} aria-pressed={status === item.value} onClick={() => setStatus(item.value)}>{item.label}</button>)}
        </div>
        <span className="table-result-count">{query.isFetching ? 'Обновляем…' : `${number(items.length)} записей`}</span>
      </div>
      {query.isPending ? <Loading label="Загружаем перевозки" /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : <DataTable data={items} columns={columns} emptyTitle={status === 'all' ? 'Перевозок пока нет' : 'Перевозок с этим статусом нет'} emptyDescription={status === 'all' ? 'Создайте первую перевозку пациента между учреждениями.' : 'Выберите другой статус или создайте новую перевозку.'} />}
    </Panel>
    {creating && <MedcoreDialog open onClose={() => setCreating(false)} title="Новая перевозка" description="Пациент, учреждение назначения, причина и сопровождение" eyebrow="Транспортировка / Перевозка">
      <TransportForm onClose={() => setCreating(false)} />
    </MedcoreDialog>}
  </>;
}
