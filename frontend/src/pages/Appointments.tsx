import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import {
  AlertCircle, CalendarCheck2, CalendarClock, CalendarPlus, CheckCircle2, ClipboardList,
  Filter, MapPin, Plus, Stethoscope, Trash2, UserRound, X, XCircle,
} from 'lucide-react';
import {
  api, createAppointment, createSchedule, deleteSchedule, errorMessage, listAppointments, listEmployees,
  listPatientReferrals, listSchedules, listSlots, updateAppointmentStatus,
} from '../api';
import { useAuth } from '../auth';
import { date, hasRole, number } from '../format';
import type { AppointmentRow, AppointmentSlot, Dictionaries, ItemList, Organization, Patient, ReferralRow, ScheduleRow } from '../types';
import { Badge, Button, DataTable, Empty, ErrorState, Loading, PageHeading, Panel, PanelHeading, Submitting, useToast } from '../components/ui';
import { MedcoreDialog } from '../components/MedcoreDialog';
import { PatientLookup } from '../components/PatientLookup';
import { isValidDateRange, payloadItems, todayValue } from '../components/medcoreUtils';
import './Appointments.css';

const scheduleRoles = ['organization_admin', 'chief_physician', 'deputy_chief_physician'] as const;
type Tab = 'slots' | 'appointments' | 'schedule';

const pad = (value: number) => String(value).padStart(2, '0');

/** Дата в местном поясе: сервер может отдавать момент со сдвигом. */
function localDayKey(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value.slice(0, 10);
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

function shiftDate(value: string, days: number): string {
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  parsed.setDate(parsed.getDate() + days);
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

const timeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
function timeLabel(value: string): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : timeFormat.format(parsed);
}

const dayFormat = new Intl.DateTimeFormat('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
function dayLabel(key: string): string {
  const parsed = new Date(`${key}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return key;
  const text = dayFormat.format(parsed);
  return text.charAt(0).toLocaleUpperCase('ru') + text.slice(1);
}

const freeStatuses = new Set(['free', 'available', 'open', 'свободен']);
const isFreeSlot = (slot: AppointmentSlot) => freeStatuses.has(slot.status.toLocaleLowerCase('ru'));
const slotStatusNames: Record<string, string> = {
  free: 'Свободен', available: 'Свободен', open: 'Свободен', booked: 'Занят', busy: 'Занят',
  scheduled: 'Записан', confirmed: 'Подтверждён', completed: 'Завершён', cancelled: 'Отменён', no_show: 'Неявка',
};
const slotStatusLabel = (status: string) => (freeStatuses.has(status) ? 'Свободен' : slotStatusNames[status] || status || 'Недоступен');

const appointmentStatusNames: Record<string, string> = {
  scheduled: 'Запланирован', booked: 'Запланирован', planned: 'Запланирован', confirmed: 'Подтверждён',
  active: 'Запланирован', completed: 'Завершён', cancelled: 'Отменён', no_show: 'Неявка',
};
const appointmentStatusLabel = (status: string) => appointmentStatusNames[status] || status || 'Запланирован';
const appointmentIsOpen = (status: string) => !['completed', 'cancelled', 'no_show'].includes(status);

/** Время смены приходит как «HH:mm» или «HH:mm:ss» — на экране секунды не нужны. */
const clockLabel = (value: string) => (/^\d{2}:\d{2}(:\d{2})?$/.test(value) ? value.slice(0, 5) : value || '—');

const referralTypeNames: Record<string, string> = { hospitalization: 'Госпитализация', consultation: 'Консультация', diagnostic: 'Диагностика' };
const referralStatusNames: Record<string, string> = { issued: 'выдано', used: 'использовано', cancelled: 'отменено' };

function referralLabel(item: ReferralRow): string {
  const parts = [
    referralTypeNames[item.type] || item.type,
    item.hospitalName || 'без учреждения',
    item.validUntil ? `до ${date(item.validUntil)}` : null,
    item.status && item.status !== 'issued' ? referralStatusNames[item.status] || item.status : null,
  ];
  return parts.filter(Boolean).join(' · ');
}

interface SlotDay { key: string; slots: AppointmentSlot[] }
interface SlotGroup {
  doctorId: number;
  doctorName: string;
  specializationName: string;
  organizationName: string;
  cabinet: string | null;
  days: SlotDay[];
}

/** Талоны группируются по врачу, внутри — по дате приёма. */
function groupSlots(slots: AppointmentSlot[]): SlotGroup[] {
  const groups = new Map<string, SlotGroup>();
  for (const slot of slots) {
    const groupKey = `${slot.doctorId}-${slot.organizationId ?? 0}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        doctorId: slot.doctorId,
        doctorName: slot.doctorName,
        specializationName: slot.specializationName,
        organizationName: slot.organizationName,
        cabinet: null,
        days: [],
      };
      groups.set(groupKey, group);
    }
    if (!group.cabinet && slot.cabinet) group.cabinet = slot.cabinet;
    if (!group.specializationName && slot.specializationName) group.specializationName = slot.specializationName;
    if (!group.organizationName && slot.organizationName) group.organizationName = slot.organizationName;
    const key = localDayKey(slot.startsAt);
    let day = group.days.find(item => item.key === key);
    if (!day) {
      day = { key, slots: [] };
      group.days.push(day);
    }
    day.slots.push(slot);
  }
  const list = [...groups.values()];
  for (const group of list) {
    group.days.sort((left, right) => left.key.localeCompare(right.key));
    for (const day of group.days) day.slots.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  }
  return list.sort((left, right) => left.doctorName.localeCompare(right.doctorName, 'ru'));
}

function BookingForm({ slot, onClose }: { slot: AppointmentSlot; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [referralId, setReferralId] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const referrals = useQuery({
    queryKey: ['referrals', patient?.id],
    queryFn: () => listPatientReferrals(patient?.id ?? 0),
    enabled: !!patient,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: () => createAppointment({
      slotId: slot.id,
      patientId: patient?.id ?? 0,
      referralId: referralId ? Number(referralId) : null,
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['slots'] });
      void client.invalidateQueries({ queryKey: ['appointments'] });
      toast('Пациент записан на приём');
      onClose();
    },
  });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!patient) return setValidation('Выберите пациента из картотеки.');
    mutation.mutate();
  }
  return <form className="appointment-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="slot-summary">
        <span className="slot-summary-icon"><Stethoscope size={19} /></span>
        <div className="slot-summary-main">
          <strong>{slot.doctorName}</strong>
          <span>{[slot.specializationName, slot.organizationName].filter(Boolean).join(' · ') || 'Медицинское учреждение'}</span>
          <span className="slot-summary-when">
            <CalendarClock size={13} />
            {date(slot.startsAt, true)}{slot.endsAt ? ` — ${timeLabel(slot.endsAt)}` : ''}{slot.cabinet ? ` · каб. ${slot.cabinet}` : ''}
          </span>
        </div>
        <span className="slot-summary-number">Талон № {slot.id}</span>
      </div>
      <div className="form-section-label"><UserRound size={15} /> Пациент</div>
      <PatientLookup patient={patient} onSelect={value => { setPatient(value); setReferralId(''); }} />
      <div className="form-grid appointment-form-grid">
        <div className="field field-wide">
          <label htmlFor="appointment-referral">Направление пациента</label>
          <select
            id="appointment-referral"
            value={referralId}
            onChange={event => setReferralId(event.target.value)}
            disabled={!patient || referrals.isPending || referrals.isError}
          >
            <option value="">{!patient
              ? 'Сначала выберите пациента'
              : referrals.isPending
                ? 'Загружаем направления…'
                : referrals.isError
                  ? 'Направления недоступны'
                  : 'Без направления'}</option>
            {(referrals.data ?? []).map(item => <option key={item.id} value={item.id}>{referralLabel(item)}</option>)}
          </select>
          <span className="field-hint">Необязательно: направление свяжет приём с выданным документом.</span>
          {referrals.isError && <span className="field-error">Не удалось загрузить направления. Запись можно оформить без направления.</span>}
        </div>
      </div>
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось записать пациента: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions">
      <span className="form-required">Врач и время определяются выбранным талоном</span>
      <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
      <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Записать пациента</Submitting></Button>
    </div>
  </form>;
}

function ScheduleForm({ initialOrganizationId, defaultDate, onClose }: { initialOrganizationId: string; defaultDate: string; onClose: () => void }) {
  const { user } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const [organizationId, setOrganizationId] = useState(() => initialOrganizationId || (user?.organizations[0] ? String(user.organizations[0].id) : ''));
  const [doctorId, setDoctorId] = useState('');
  const [workDate, setWorkDate] = useState(defaultDate || todayValue());
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('18:00');
  const [slotMinutes, setSlotMinutes] = useState('30');
  const [cabinet, setCabinet] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: () => api<ItemList<Organization>>('/organizations') });
  const employees = useQuery({
    queryKey: ['employees', 'schedule', organizationId],
    queryFn: () => listEmployees(organizationId),
    enabled: !!organizationId,
  });
  const organizationItems = useMemo(() => payloadItems(organizations.data).filter(item => item.isActive), [organizations.data]);
  const sourceOptions = user?.organizations.length ? user.organizations : organizationItems.map(item => ({ id: item.id, name: item.name }));
  // Смену открывают только врачам: категория сотрудника приходит справочником.
  const doctorOptions = useMemo(() => (employees.data ?? []).filter(item => {
    const category = (item.category || '').toLocaleLowerCase('ru');
    return category === 'doctor' || category.includes('врач');
  }), [employees.data]);
  const mutation = useMutation({
    mutationFn: () => createSchedule({
      doctorId: Number(doctorId),
      organizationId: Number(organizationId),
      workDate,
      startTime,
      endTime,
      slotMinutes: Number(slotMinutes),
      cabinet: cabinet.trim() || null,
    }),
    onSuccess: result => {
      void client.invalidateQueries({ queryKey: ['schedules'] });
      void client.invalidateQueries({ queryKey: ['slots'] });
      toast(result.slotsCreated ? `Расписание добавлено: ${number(result.slotsCreated)} талонов` : 'Расписание добавлено');
      onClose();
    },
  });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!organizationId) return setValidation('Выберите учреждение.');
    if (!doctorId) return setValidation('Выберите врача.');
    if (!workDate) return setValidation('Укажите дату работы.');
    if (!startTime || !endTime) return setValidation('Укажите начало и конец смены.');
    if (startTime >= endTime) return setValidation('Начало смены должно быть раньше её окончания.');
    const step = Number(slotMinutes);
    if (!Number.isFinite(step) || step < 5 || step > 240) return setValidation('Длина талона должна быть от 5 до 240 минут.');
    mutation.mutate();
  }
  function changeOrganization(value: string) {
    setOrganizationId(value);
    setDoctorId('');
  }
  return <form className="schedule-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="form-section-label"><CalendarPlus size={15} /> Смена врача</div>
      <div className="form-grid">
        <div className="field field-wide">
          <label htmlFor="schedule-organization">Учреждение <span>*</span></label>
          <select id="schedule-organization" value={organizationId} onChange={event => changeOrganization(event.target.value)} disabled={organizations.isPending || !sourceOptions.length}>
            {!sourceOptions.length && <option value="">{organizations.isPending ? 'Загружаем…' : 'Учреждение не определено'}</option>}
            {sourceOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div className="field field-wide">
          <label htmlFor="schedule-doctor">Врач <span>*</span></label>
          <select id="schedule-doctor" value={doctorId} onChange={event => setDoctorId(event.target.value)} disabled={!organizationId || employees.isPending}>
            <option value="">{!organizationId ? 'Сначала выберите учреждение' : employees.isPending ? 'Загружаем…' : 'Выберите врача'}</option>
            {doctorOptions.map(item => <option key={item.id} value={item.id}>{item.fullName}{item.category ? ` · ${item.category}` : ''}</option>)}
          </select>
          {employees.isError && <span className="field-error">Не удалось загрузить сотрудников учреждения.</span>}
        </div>
        <div className="field">
          <label htmlFor="schedule-date">Дата <span>*</span></label>
          <input id="schedule-date" type="date" value={workDate} onChange={event => setWorkDate(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="schedule-cabinet">Кабинет</label>
          <input id="schedule-cabinet" value={cabinet} maxLength={50} onChange={event => setCabinet(event.target.value)} autoComplete="off" placeholder="Например, 204" />
        </div>
        <div className="field">
          <label htmlFor="schedule-start">Начало смены <span>*</span></label>
          <input id="schedule-start" type="time" value={startTime} onChange={event => setStartTime(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="schedule-end">Конец смены <span>*</span></label>
          <input id="schedule-end" type="time" value={endTime} onChange={event => setEndTime(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="schedule-slot">Длина талона <span>*</span></label>
          <select id="schedule-slot" value={slotMinutes} onChange={event => setSlotMinutes(event.target.value)}>
            {[10, 15, 20, 30, 45, 60].map(value => <option key={value} value={value}>{value} минут</option>)}
          </select>
        </div>
      </div>
      <p className="field-hint schedule-form-hint">Сервер нарежет смену на талоны указанной длины. Занятые приёмы не затрагиваются.</p>
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось добавить расписание: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions">
      <span className="form-required">* Обязательные поля</span>
      <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
      <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Добавить расписание</Submitting></Button>
    </div>
  </form>;
}

export function AppointmentsPage() {
  const { user } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const canManageSchedules = !!user && hasRole(user.roles, [...scheduleRoles]);
  // Заведующий отделением видит талоны и записи, но не оформляет приём.
  const canBook = !!user && hasRole(user.roles, ['registrar', 'doctor', 'organization_admin', 'chief_physician', 'deputy_chief_physician']);
  const [tab, setTab] = useState<Tab>('slots');
  const [organizationId, setOrganizationId] = useState('');
  const [specializationId, setSpecializationId] = useState('');
  const [dateFrom, setDateFrom] = useState(() => todayValue());
  const [dateTo, setDateTo] = useState(() => shiftDate(todayValue(), 7));
  const [onlyFree, setOnlyFree] = useState(true);
  const [selectedSlot, setSelectedSlot] = useState<AppointmentSlot | null>(null);
  const [addingSchedule, setAddingSchedule] = useState(false);
  const [deletingSchedule, setDeletingSchedule] = useState<ScheduleRow | null>(null);
  const [appointmentStatus, setAppointmentStatus] = useState<'all' | 'scheduled' | 'completed' | 'cancelled'>('all');
  const [appointmentDate, setAppointmentDate] = useState('');

  const validRange = isValidDateRange(dateFrom, dateTo);
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: () => api<ItemList<Organization>>('/organizations') });
  const dictionaries = useQuery({ queryKey: ['dictionaries'], queryFn: () => api<Dictionaries>('/dictionaries') });
  const organizationOptions = useMemo(() => payloadItems(organizations.data).filter(item => item.isActive), [organizations.data]);
  const specializationOptions = dictionaries.data?.specializations ?? [];

  const slotsQuery = useQuery({
    queryKey: ['slots', organizationId, specializationId, dateFrom, dateTo, onlyFree],
    queryFn: () => listSlots({
      dateFrom,
      dateTo,
      organizationId: organizationId || undefined,
      specializationId: specializationId || undefined,
      onlyFree,
    }),
    enabled: tab === 'slots' && validRange,
    placeholderData: keepPreviousData,
  });
  const appointmentsQuery = useQuery({
    queryKey: ['appointments', appointmentDate],
    queryFn: () => listAppointments({ date: appointmentDate || undefined }),
    enabled: tab === 'appointments',
    placeholderData: keepPreviousData,
  });
  const schedulesQuery = useQuery({
    queryKey: ['schedules', organizationId, dateFrom, dateTo],
    queryFn: () => listSchedules({
      dateFrom,
      dateTo,
      organizationId: organizationId || undefined,
    }),
    enabled: canManageSchedules && tab === 'schedule' && validRange,
    placeholderData: keepPreviousData,
  });

  const appointmentAction = useMutation({
    mutationFn: (input: { id: number; status: 'completed' | 'cancelled' }) => updateAppointmentStatus(input.id, input.status),
    onSuccess: (_, input) => {
      void client.invalidateQueries({ queryKey: ['appointments'] });
      void client.invalidateQueries({ queryKey: ['slots'] });
      toast(input.status === 'completed' ? 'Приём завершён' : 'Запись отменена');
    },
    onError: error => toast(errorMessage(error), 'error'),
  });
  const scheduleDeletion = useMutation({
    mutationFn: (id: number) => deleteSchedule(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['schedules'] });
      void client.invalidateQueries({ queryKey: ['slots'] });
      toast('Расписание удалено');
      setDeletingSchedule(null);
    },
    onError: error => toast(errorMessage(error), 'error'),
  });

  const slots = slotsQuery.data ?? [];
  const groups = useMemo(() => groupSlots(slots), [slots]);
  const freeCount = slots.filter(isFreeSlot).length;
  // Статусы записей фильтруются на клиенте: сервер может называть их по-разному.
  const appointments = useMemo(() => {
    const all = appointmentsQuery.data ?? [];
    if (appointmentStatus === 'all') return all;
    if (appointmentStatus === 'scheduled') return all.filter(item => appointmentIsOpen(item.status));
    if (appointmentStatus === 'completed') return all.filter(item => item.status === 'completed');
    return all.filter(item => item.status === 'cancelled' || item.status === 'no_show');
  }, [appointmentsQuery.data, appointmentStatus]);
  const schedules = schedulesQuery.data ?? [];

  const appointmentColumns = useMemo<ColumnDef<AppointmentRow>[]>(() => [
    {
      accessorKey: 'patientName',
      header: 'Пациент',
      cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.patientName || `Пациент № ${row.original.patientId}`}</strong><span>Запись № {row.original.id}</span></div>,
    },
    {
      id: 'when',
      header: 'Дата и время',
      cell: ({ row }) => <div className="appointment-when"><strong>{timeLabel(row.original.startsAt)}{row.original.endsAt ? ` — ${timeLabel(row.original.endsAt)}` : ''}</strong><span>{date(row.original.startsAt)}</span></div>,
    },
    {
      accessorKey: 'doctorName',
      header: 'Врач',
      cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.doctorName || '—'}</strong><span>{row.original.specializationName || 'Специализация не указана'}</span></div>,
    },
    {
      id: 'place',
      header: 'Учреждение / кабинет',
      cell: ({ row }) => <div className="name-with-meta cell-wrap"><strong>{row.original.organizationName || '—'}</strong><span>{row.original.cabinet ? `Кабинет ${row.original.cabinet}` : 'Кабинет не указан'}</span></div>,
    },
    {
      accessorKey: 'status',
      header: 'Статус',
      cell: ({ row }) => <Badge status={row.original.status}>{appointmentStatusLabel(row.original.status)}</Badge>,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        // Сервер допускает только booked → completed/cancelled.
        if (!canBook || row.original.status !== 'booked') return null;
        return <div className="table-actions">
          <Button variant="secondary" className="appointment-complete" disabled={appointmentAction.isPending} onClick={() => appointmentAction.mutate({ id: row.original.id, status: 'completed' })}><CheckCircle2 size={14} /> Завершить</Button>
          <Button variant="ghost" className="appointment-cancel" disabled={appointmentAction.isPending} onClick={() => appointmentAction.mutate({ id: row.original.id, status: 'cancelled' })}><XCircle size={14} /> Отменить</Button>
        </div>;
      },
    },
  ], [appointmentAction, canBook]);

  const scheduleColumns = useMemo<ColumnDef<ScheduleRow>[]>(() => [
    {
      id: 'doctor',
      header: 'Врач',
      cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.doctorName}</strong><span>{row.original.organizationName || 'Учреждение не указано'}</span></div>,
    },
    { accessorKey: 'workDate', header: 'Дата', cell: ({ row }) => <span className="cell-date">{date(row.original.workDate)}</span> },
    { id: 'time', header: 'Смена', cell: ({ row }) => <span className="schedule-time">{clockLabel(row.original.startTime)} — {clockLabel(row.original.endTime)}</span> },
    { id: 'slotMinutes', header: 'Талон', cell: ({ row }) => <span className="cell-date">{row.original.slotMinutes ? `${row.original.slotMinutes} мин` : '—'}</span> },
    { id: 'cabinet', header: 'Кабинет', cell: ({ row }) => row.original.cabinet ? <span className="cell-wrap">каб. {row.original.cabinet}</span> : <span className="muted">—</span> },
    {
      id: 'slots',
      header: 'Талонов',
      cell: ({ row }) => <span className="schedule-slots"><strong>{number(row.original.slotsFree)}</strong> свободно из {number(row.original.slotsTotal)}</span>,
    },
    { id: 'status', header: 'Статус', cell: ({ row }) => <Badge status={row.original.isActive ? 'active' : 'inactive'}>{row.original.isActive ? 'Действует' : 'Отключено'}</Badge> },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => <div className="table-actions">
        <button type="button" className="icon-button schedule-delete" title="Удалить расписание" aria-label={`Удалить расписание: ${row.original.doctorName}`} onClick={() => { scheduleDeletion.reset(); setDeletingSchedule(row.original); }}><Trash2 size={16} /></button>
      </div>,
    },
  ], []);

  const tabs: { value: Tab; label: string; icon: typeof CalendarClock }[] = [
    { value: 'slots', label: 'Талоны', icon: CalendarClock },
    { value: 'appointments', label: 'Мои записи', icon: CalendarCheck2 },
    ...(canManageSchedules ? [{ value: 'schedule' as Tab, label: 'Расписание', icon: ClipboardList }] : []),
  ];

  const filterError = !validRange && <div className="form-error appointments-range-error" role="alert"><AlertCircle size={15} /> Дата начала не должна быть позже даты окончания.</div>;

  return <>
    <PageHeading
      eyebrow="Медицина / Приём"
      title="Запись на приём"
      description="Свободные талоны врачей, оформление записи и управление расписанием смен"
    />
    <div className="directory-toolbar appointments-tabs-row">
      <div className="segmented-control" aria-label="Раздел приёма">
        {tabs.map(item => <button key={item.value} type="button" className={tab === item.value ? 'selected' : ''} aria-pressed={tab === item.value} onClick={() => setTab(item.value)}><item.icon size={14} /> {item.label}</button>)}
      </div>
      <span className="table-result-count">{tab === 'slots' ? 'Только свободные талоны доступны для записи' : tab === 'appointments' ? 'Завершение и отмена оформленных приёмов' : 'Смены, из которых сервер формирует талоны'}</span>
    </div>

    {tab === 'slots' && <Panel className="appointments-panel">
      <div className="appointments-filterbar">
        <div className="field appointment-filter">
          <label htmlFor="slot-organization">Больница</label>
          <select id="slot-organization" value={organizationId} onChange={event => setOrganizationId(event.target.value)} disabled={organizations.isPending}>
            <option value="">Все учреждения</option>
            {organizationOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div className="field appointment-filter">
          <label htmlFor="slot-specialization">Специальность</label>
          <select id="slot-specialization" value={specializationId} onChange={event => setSpecializationId(event.target.value)} disabled={dictionaries.isPending}>
            <option value="">Все специальности</option>
            {specializationOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div className="field appointment-filter appointment-filter-date">
          <label htmlFor="slot-date-from">С даты</label>
          <input id="slot-date-from" type="date" value={dateFrom} onChange={event => setDateFrom(event.target.value)} />
        </div>
        <div className="field appointment-filter appointment-filter-date">
          <label htmlFor="slot-date-to">По дату</label>
          <input id="slot-date-to" type="date" value={dateTo} onChange={event => setDateTo(event.target.value)} />
        </div>
        <label className="appointment-toggle">
          <input type="checkbox" checked={onlyFree} onChange={event => setOnlyFree(event.target.checked)} />
          <span><Filter size={13} /> Только свободные</span>
        </label>
      </div>
      <div className="table-toolbar table-toolbar-wrap appointments-toolbar">
        <span className="appointments-hint"><CalendarClock size={14} /> {canBook ? 'Талоны сгруппированы по врачу и дате — нажмите на время, чтобы записать пациента.' : 'Просмотр талонов: запись оформляют регистратор, врач и руководящие роли учреждения.'}</span>
        <span className="table-result-count">{slotsQuery.isFetching ? 'Обновляем…' : `${number(slots.length)} талонов · свободно ${number(freeCount)}`}</span>
      </div>
      {filterError}
      {!validRange
        ? null
        : slotsQuery.isPending
          ? <Loading label="Загружаем талоны" />
          : slotsQuery.isError
            ? <ErrorState error={slotsQuery.error} retry={() => void slotsQuery.refetch()} />
            : !groups.length
              ? <Empty
                title={onlyFree ? 'Свободных талонов нет' : 'Талонов не найдено'}
                description={onlyFree
                  ? 'Измените период, учреждение или специальность — либо снимите фильтр «Только свободные».'
                  : 'На выбранный период талонов нет. Измените даты, учреждение или специальность.'}
              />
              : <div className="slot-groups">{groups.map(group => <article className="slot-group" key={`${group.doctorId}-${group.organizationName}-${group.specializationName}`}>
                <header className="slot-group-head">
                  <span className="slot-doctor-avatar"><Stethoscope size={17} /></span>
                  <div className="slot-group-title">
                    <strong>{group.doctorName}</strong>
                    <span>{[group.specializationName, group.organizationName].filter(Boolean).join(' · ') || 'Специализация не указана'}</span>
                  </div>
                  {group.cabinet && <span className="slot-cabinet"><MapPin size={13} /> каб. {group.cabinet}</span>}
                </header>
                <div className="slot-days">{group.days.map(day => {
                  const dayFree = day.slots.filter(isFreeSlot).length;
                  return <div className="slot-day" key={day.key}>
                    <div className="slot-day-label"><strong>{dayLabel(day.key)}</strong><span>{number(dayFree)} свободно из {number(day.slots.length)}</span></div>
                    <div className="slot-chips">{day.slots.map(slot => {
                      const free = isFreeSlot(slot);
                      return <button
                        key={slot.id}
                        type="button"
                        className={`slot-chip ${free ? 'slot-chip-free' : 'slot-chip-busy'}`}
                        disabled={!free || !canBook}
                        title={`${timeLabel(slot.startsAt)}–${timeLabel(slot.endsAt)} · ${slotStatusLabel(slot.status)}${slot.cabinet ? ` · каб. ${slot.cabinet}` : ''}${free && !canBook ? ' · только просмотр' : ''}`}
                        onClick={() => { if (canBook) setSelectedSlot(slot); }}
                      >
                        <span className="slot-chip-time">{timeLabel(slot.startsAt)}</span>
                        <span className="slot-chip-state">{free ? 'свободно' : slotStatusLabel(slot.status)}</span>
                      </button>;
                    })}</div>
                  </div>;
                })}</div>
              </article>)}</div>}
    </Panel>}

    {tab === 'appointments' && <Panel className="appointments-panel">
      <PanelHeading title="Мои записи" subtitle="Оформленные приёмы: завершение и отмена" />
      <div className="table-toolbar table-toolbar-wrap">
        <div className="segmented-control" aria-label="Статус записи">
          {([{ value: 'all', label: 'Все' }, { value: 'scheduled', label: 'Запланированы' }, { value: 'completed', label: 'Завершены' }, { value: 'cancelled', label: 'Отменены' }] as const).map(item => <button key={item.value} type="button" className={appointmentStatus === item.value ? 'selected' : ''} aria-pressed={appointmentStatus === item.value} onClick={() => setAppointmentStatus(item.value)}>{item.label}</button>)}
        </div>
        <div className="appointment-date-filter">
          <label htmlFor="appointment-date">Дата</label>
          <input id="appointment-date" type="date" value={appointmentDate} onChange={event => setAppointmentDate(event.target.value)} />
          {appointmentDate && <button type="button" className="icon-button" title="Показать все даты" aria-label="Показать все даты" onClick={() => setAppointmentDate('')}><X size={15} /></button>}
        </div>
        <span className="table-result-count">{appointmentsQuery.isFetching ? 'Обновляем…' : `${number(appointments.length)} записей`}</span>
      </div>
      {appointmentsQuery.isPending
        ? <Loading label="Загружаем записи" />
        : appointmentsQuery.isError
          ? <ErrorState error={appointmentsQuery.error} retry={() => void appointmentsQuery.refetch()} />
          : <DataTable data={appointments} columns={appointmentColumns} emptyTitle="Записей пока нет" emptyDescription={appointmentDate || appointmentStatus !== 'all' ? 'С выбранными условиями записей нет — измените фильтры.' : 'Оформите первую запись на вкладке «Талоны».'} />}
    </Panel>}

    {tab === 'schedule' && canManageSchedules && <Panel className="appointments-panel">
      <PanelHeading
        title="Расписание врачей"
        subtitle="Смены, из которых сервер формирует талоны на приём"
        trailing={<Button onClick={() => setAddingSchedule(true)}><Plus size={16} /> Добавить расписание</Button>}
      />
      <div className="appointments-filterbar">
        <div className="field appointment-filter">
          <label htmlFor="schedule-filter-organization">Больница</label>
          <select id="schedule-filter-organization" value={organizationId} onChange={event => setOrganizationId(event.target.value)} disabled={organizations.isPending}>
            <option value="">Все учреждения</option>
            {organizationOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </div>
        <div className="field appointment-filter appointment-filter-date">
          <label htmlFor="schedule-date-from">С даты</label>
          <input id="schedule-date-from" type="date" value={dateFrom} onChange={event => setDateFrom(event.target.value)} />
        </div>
        <div className="field appointment-filter appointment-filter-date">
          <label htmlFor="schedule-date-to">По дату</label>
          <input id="schedule-date-to" type="date" value={dateTo} onChange={event => setDateTo(event.target.value)} />
        </div>
        <span className="table-result-count">{schedulesQuery.isFetching ? 'Обновляем…' : `${number(schedules.length)} смен`}</span>
      </div>
      {filterError}
      {!validRange
        ? null
        : schedulesQuery.isPending
          ? <Loading label="Загружаем расписание" />
          : schedulesQuery.isError
            ? <ErrorState error={schedulesQuery.error} retry={() => void schedulesQuery.refetch()} />
            : <DataTable data={schedules} columns={scheduleColumns} emptyTitle="Расписания пока нет" emptyDescription="Добавьте смену врача — сервер сразу создаст талоны для записи." />}
    </Panel>}

    {selectedSlot && <MedcoreDialog open onClose={() => setSelectedSlot(null)} title="Запись на приём" description="Пациент, свободный талон и направление" eyebrow="Приём / Запись">
      <BookingForm slot={selectedSlot} onClose={() => setSelectedSlot(null)} />
    </MedcoreDialog>}

    {addingSchedule && canManageSchedules && <MedcoreDialog open onClose={() => setAddingSchedule(false)} title="Добавить расписание" description="Врач, дата, время смены и длина талона" eyebrow="Приём / Расписание">
      <ScheduleForm initialOrganizationId={organizationId} defaultDate={validRange ? dateFrom : todayValue()} onClose={() => setAddingSchedule(false)} />
    </MedcoreDialog>}

    {deletingSchedule && <MedcoreDialog open onClose={() => { scheduleDeletion.reset(); setDeletingSchedule(null); }} title="Удалить расписание?" description={`${deletingSchedule.doctorName} · ${date(deletingSchedule.workDate)}`} eyebrow="Приём / Расписание" busy={scheduleDeletion.isPending}>
      <p className="appointment-confirm-text">Свободные талоны смены будут удалены, расписание станет неактивным. Если на смену уже есть записи, сначала отмените их.</p>
      {scheduleDeletion.isError && <div className="form-error" role="alert">{errorMessage(scheduleDeletion.error)}</div>}
      <div className="dialog-actions">
        <Button variant="secondary" type="button" disabled={scheduleDeletion.isPending} onClick={() => { scheduleDeletion.reset(); setDeletingSchedule(null); }}>Отмена</Button>
        <Button type="button" className="appointment-delete-confirm" disabled={scheduleDeletion.isPending} onClick={() => scheduleDeletion.mutate(deletingSchedule.id)}><Submitting busy={scheduleDeletion.isPending}>Удалить</Submitting></Button>
      </div>
    </MedcoreDialog>}
  </>;
}
