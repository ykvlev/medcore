import { useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Ambulance, ArrowRight, CheckCircle2, Gauge, MapPin, Play, Plus, Route, Search, Trash2, XCircle } from 'lucide-react';
import { api, createTransport, errorMessage, listTransports, saveTransportRoute, updateTransportStatus } from '../api';
import type { SaveTransportRouteInput } from '../api';
import { useAuth } from '../auth';
import { date, number } from '../format';
import type { EmployeeRow, ItemList, Organization, Patient, RoutePoint, TransportRow } from '../types';
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

const ROUTE_MAP_WIDTH = 460;
const ROUTE_MAP_HEIGHT = 230;
const ROUTE_MAP_PADDING = 34;

/** Проекция координат на схему: без тайлов и картографических библиотек. */
function projectRoute(points: RoutePoint[]) {
  if (!points.length) return [];
  const lats = points.map(point => point.lat);
  const lngs = points.map(point => point.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const spanLat = maxLat - minLat;
  const spanLng = maxLng - minLng;
  return points.map(point => ({
    ...point,
    x: points.length === 1
      ? ROUTE_MAP_WIDTH / 2
      : ROUTE_MAP_PADDING + (spanLng ? (point.lng - minLng) / spanLng : .5) * (ROUTE_MAP_WIDTH - ROUTE_MAP_PADDING * 2),
    y: points.length === 1
      ? ROUTE_MAP_HEIGHT / 2
      : ROUTE_MAP_PADDING + (spanLat ? (maxLat - point.lat) / spanLat : .5) * (ROUTE_MAP_HEIGHT - ROUTE_MAP_PADDING * 2),
  }));
}

function RouteMap({ points }: { points: RoutePoint[] }) {
  const projected = projectRoute(points);
  const label = points.length ? `Схема маршрута: ${points.map((point, index) => point.label || `точка ${index + 1}`).join(', ')}` : 'Схема маршрута не задана';
  return <div className="route-map" role="img" aria-label={label}>
    <svg viewBox={`0 0 ${ROUTE_MAP_WIDTH} ${ROUTE_MAP_HEIGHT}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <defs>
        <linearGradient id="transport-route-line" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#5bd6b1" />
          <stop offset="100%" stopColor="#6c9dff" />
        </linearGradient>
      </defs>
      {[.25, .5, .75].map(ratio => <g key={ratio}>
        <line x1={ROUTE_MAP_WIDTH * ratio} y1="14" x2={ROUTE_MAP_WIDTH * ratio} y2={ROUTE_MAP_HEIGHT - 14} stroke="rgba(255,255,255,.045)" strokeWidth="1" strokeDasharray="3 6" />
        <line x1="14" y1={ROUTE_MAP_HEIGHT * ratio} x2={ROUTE_MAP_WIDTH - 14} y2={ROUTE_MAP_HEIGHT * ratio} stroke="rgba(255,255,255,.045)" strokeWidth="1" strokeDasharray="3 6" />
      </g>)}
      {projected.length > 1 && <polyline
        points={projected.map(point => `${point.x},${point.y}`).join(' ')}
        fill="none"
        stroke="url(#transport-route-line)"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />}
      {projected.map((point, index) => <g key={`${point.lat}-${point.lng}-${index}`}>
        <circle cx={point.x} cy={point.y} r="10" fill="rgba(91,214,177,.08)" stroke="rgba(91,214,177,.22)" strokeWidth="1" />
        <circle cx={point.x} cy={point.y} r="4" fill="#9fe0cd" />
        <text
          x={point.x + (point.x > ROUTE_MAP_WIDTH * 0.78 ? -12 : 12)}
          y={point.y - 8}
          textAnchor={point.x > ROUTE_MAP_WIDTH * 0.78 ? 'end' : 'start'}
          className="route-map-label"
        >{point.label || `Точка ${index + 1}`}</text>
      </g>)}
      {!projected.length && <text x={ROUTE_MAP_WIDTH / 2} y={ROUTE_MAP_HEIGHT / 2} textAnchor="middle" className="route-map-empty-label">Маршрут не задан</text>}
    </svg>
    {!points.length && <p className="route-map-empty">Добавьте координаты двух и более точек — схема построится по подписям и порядку точек.</p>}
  </div>;
}

interface RoutePointDraft { key: number; lat: string; lng: string; label: string }

function TransportRouteForm({ transport, onClose }: { transport: TransportRow; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [distanceKm, setDistanceKm] = useState(() => transport.distanceKm !== null ? String(transport.distanceKm) : '');
  const [odometerStart, setOdometerStart] = useState(() => transport.odometerStart !== null ? String(transport.odometerStart) : '');
  const [odometerEnd, setOdometerEnd] = useState(() => transport.odometerEnd !== null ? String(transport.odometerEnd) : '');
  const [fuelLiters, setFuelLiters] = useState(() => transport.fuelLiters !== null ? String(transport.fuelLiters) : '');
  const [points, setPoints] = useState<RoutePointDraft[]>(() => {
    const existing = transport.routePoints.map((point, index) => ({
      key: index + 1,
      lat: String(point.lat),
      lng: String(point.lng),
      label: point.label,
    }));
    // Сервер принимает маршрут от двух точек: пустая форма сразу предлагает две строки.
    return existing.length ? existing : [{ key: 1, lat: '', lng: '', label: '' }, { key: 2, lat: '', lng: '', label: '' }];
  });
  const nextKey = useRef(100);
  const [validation, setValidation] = useState<string | null>(null);
  const mapPoints = useMemo<RoutePoint[]>(() => points.flatMap((point, index) => {
    if (!point.lat.trim() || !point.lng.trim()) return [];
    const lat = Number(point.lat.replace(',', '.'));
    const lng = Number(point.lng.replace(',', '.'));
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return [];
    return [{ lat, lng, label: point.label.trim() || `Точка ${index + 1}` }];
  }), [points]);

  function updatePoint(key: number, patch: Partial<RoutePointDraft>) {
    setPoints(previous => previous.map(point => point.key === key ? { ...point, ...patch } : point));
  }
  function addPoint() {
    setPoints(previous => [...previous, { key: nextKey.current++, lat: '', lng: '', label: '' }]);
  }
  function removePoint(key: number) {
    setPoints(previous => previous.filter(point => point.key !== key));
  }

  function numericValue(value: string): number | null {
    if (!value.trim()) return null;
    const parsed = Number(value.replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  const mutation = useMutation({
    mutationFn: (input: SaveTransportRouteInput) => saveTransportRoute(transport.id, input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['transports'] });
      toast('Маршрут сохранён');
      onClose();
    },
  });

  function submit() {
    setValidation(null);
    mutation.reset();
    const distance = numericValue(distanceKm);
    if (distance === null || distance < 0 || distance > 9_999_999.9) return setValidation('Укажите пробег от 0 до 9 999 999,9 км.');
    const start = numericValue(odometerStart);
    if (odometerStart.trim() && (start === null || !Number.isInteger(start) || start < 0)) return setValidation('Показания одометра в начале должны быть целым неотрицательным числом.');
    const end = numericValue(odometerEnd);
    if (odometerEnd.trim() && (end === null || !Number.isInteger(end) || end < 0)) return setValidation('Показания одометра в конце должны быть целым неотрицательным числом.');
    if (start !== null && end !== null && end < start) return setValidation('Показания одометра в конце не могут быть меньше начальных.');
    const fuel = numericValue(fuelLiters);
    if (fuelLiters.trim() && (fuel === null || fuel < 0 || fuel > 9_999_999.9)) return setValidation('Укажите объём топлива от 0 до 9 999 999,9 л.');
    const routePoints: RoutePoint[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      if (!point.lat.trim() && !point.lng.trim()) continue;
      const lat = numericValue(point.lat);
      const lng = numericValue(point.lng);
      if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        return setValidation(`Точка ${index + 1}: укажите широту от −90 до 90 и долготу от −180 до 180.`);
      }
      routePoints.push({ lat, lng, label: point.label.trim() || `Точка ${index + 1}` });
    }
    if (routePoints.length < 2) return setValidation('Добавьте минимум две точки маршрута — сервер принимает от 2 до 10 точек.');
    if (routePoints.length > 10) return setValidation('Маршрут содержит не более 10 точек.');
    mutation.mutate({ distanceKm: distance, odometerStart: start, odometerEnd: end, fuelLiters: fuel, routePoints });
  }

  return <form className="route-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="route-summary">
        <span className="route-summary-icon"><Ambulance size={18} /></span>
        <div>
          <strong>{transport.patientName || `Пациент № ${transport.patientId}`}</strong>
          <span>Перевозка № {transport.id} · {transport.fromOrganizationName || '—'} <ArrowRight size={11} /> {transport.toOrganizationName || '—'}</span>
        </div>
      </div>
      <div className="form-section-label"><Gauge size={15} /> Пробег и топливо</div>
      <div className="form-grid route-fields">
        <div className="field">
          <label htmlFor="route-distance">Пробег, км <span>*</span></label>
          <input id="route-distance" type="number" min="0" step="0.1" inputMode="decimal" value={distanceKm} onChange={event => setDistanceKm(event.target.value)} placeholder="0,0" />
        </div>
        <div className="field">
          <label htmlFor="route-fuel">Топливо, л</label>
          <input id="route-fuel" type="number" min="0" step="0.1" inputMode="decimal" value={fuelLiters} onChange={event => setFuelLiters(event.target.value)} placeholder="0,0" />
        </div>
        <div className="field">
          <label htmlFor="route-odometer-start">Одометр в начале, км</label>
          <input id="route-odometer-start" type="number" min="0" step="1" inputMode="numeric" value={odometerStart} onChange={event => setOdometerStart(event.target.value)} placeholder="Например, 48200" />
        </div>
        <div className="field">
          <label htmlFor="route-odometer-end">Одометр в конце, км</label>
          <input id="route-odometer-end" type="number" min="0" step="1" inputMode="numeric" value={odometerEnd} onChange={event => setOdometerEnd(event.target.value)} placeholder="Например, 48218" />
        </div>
      </div>

      <div className="form-section-label form-section-next"><MapPin size={15} /> Схема маршрута</div>
      <RouteMap points={mapPoints} />

      <div className="route-points">
        {points.map((point, index) => <div className="route-point-row" key={point.key}>
          <span className="route-point-index">{index + 1}</span>
          <input aria-label={`Широта точки ${index + 1}`} className="route-point-coordinate" placeholder="Широта" inputMode="decimal" value={point.lat} onChange={event => updatePoint(point.key, { lat: event.target.value })} />
          <input aria-label={`Долгота точки ${index + 1}`} className="route-point-coordinate" placeholder="Долгота" inputMode="decimal" value={point.lng} onChange={event => updatePoint(point.key, { lng: event.target.value })} />
          <input aria-label={`Подпись точки ${index + 1}`} className="route-point-label" placeholder="Подпись, например «Больница № 4»" maxLength={80} value={point.label} onChange={event => updatePoint(point.key, { label: event.target.value })} />
          <button type="button" className="icon-button route-point-remove" title="Удалить точку" aria-label={`Удалить точку ${index + 1}`} onClick={() => removePoint(point.key)}><Trash2 size={15} /></button>
        </div>)}
        {!points.length && <p className="route-points-empty">Точек пока нет. Для сохранения маршрута нужны минимум две точки.</p>}
        <div className="route-points-actions">
          <Button variant="secondary" type="button" disabled={points.length >= 10} title={points.length >= 10 ? 'Не более 10 точек маршрута' : undefined} onClick={addPoint}><Plus size={15} /> Добавить точку</Button>
          <span className="field-hint">Координаты — в градусах; от 2 до 10 точек, подпись выводится на схеме.</span>
        </div>
      </div>
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось сохранить маршрут: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions">
      <span className="form-required">* Пробег обязателен, остальные поля — по факту</span>
      <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
      <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Сохранить маршрут</Submitting></Button>
    </div>
  </form>;
}

export function TransportsPage() {
  const client = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  // Заведующий отделением видит реестр, но заявки и смену статусов не оформляет.
  const canEdit = Boolean(user && user.roles.some(role => ['registrar', 'doctor', 'organization_admin', 'chief_physician', 'deputy_chief_physician'].includes(role)));
  // Маршрут ведут регистратор и управленческие роли учреждения.
  const canEditRoute = Boolean(user && user.roles.some(role => ['registrar', 'organization_admin', 'chief_physician', 'deputy_chief_physician'].includes(role)));
  const [status, setStatus] = useState<'all' | 'requested' | 'in_progress' | 'completed' | 'cancelled'>('all');
  const [creating, setCreating] = useState(false);
  const [routeFor, setRouteFor] = useState<TransportRow | null>(null);
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
    { id: 'distance', header: 'Пробег, км', cell: ({ row }) => row.original.distanceKm !== null ? <span className="transport-distance">{number(row.original.distanceKm)} км</span> : <span className="muted">—</span> },
    { id: 'fuel', header: 'Топливо, л', cell: ({ row }) => row.original.fuelLiters !== null ? <span className="transport-fuel">{number(row.original.fuelLiters)} л</span> : <span className="muted">—</span> },
    { accessorKey: 'accompanyingName', header: 'Сопровождающий', cell: ({ row }) => row.original.accompanyingName ? <span className="cell-wrap">{row.original.accompanyingName}</span> : <span className="muted">—</span> },
    { id: 'actions', header: '', cell: ({ row }) => {
      if (!canEdit) return null;
      const current = row.original.status;
      return <div className="table-actions">
        {canEditRoute && <Button variant="secondary" className="transport-route-button" title="Пробег, топливо и точки маршрута" onClick={() => setRouteFor(row.original)}><Route size={14} /> Маршрут</Button>}
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
    {routeFor && <MedcoreDialog open wide onClose={() => setRouteFor(null)} title="Маршрут перевозки" description="Пробег, топливо и схема точек маршрута" eyebrow="Транспортировка / Маршрут">
      <TransportRouteForm transport={routeFor} onClose={() => setRouteFor(null)} />
    </MedcoreDialog>}
  </>;
}
