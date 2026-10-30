import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, ArrowUpRight, BedDouble, CalendarDays, ChevronLeft, ChevronRight, FileHeart, FileText, FlaskConical, History, Mail, MapPin, Pencil, Phone, Plus, Search, Stethoscope, UserRound, X } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { api, ApiError, errorMessage } from '../api';
import { useAuth } from '../auth';
import { date, fullName, hasRole, initials, number, sexName } from '../format';
import type { DiagnosisItem, ItemList, Organization, Paged, Patient, PatientCase, PatientDetail, PatientHistory } from '../types';
import { Badge, Button, DataTable, Dialog, Empty, ErrorState, Loading, PageHeading, Panel, PanelHeading, Submitting, useToast } from '../components/ui';
import { payloadItems } from '../components/medcoreUtils';
import './Patients.css';

const contactsSchema = z.object({
  phone: z.string().trim().max(50, 'Не более 50 символов'),
  email: z.string().trim().refine(value => !value || z.email().safeParse(value).success, 'Проверьте адрес электронной почты'),
  address: z.string().trim().max(500, 'Не более 500 символов'),
});
const createSchema = contactsSchema.extend({
  lastName: z.string().trim().min(1, 'Введите фамилию').max(100, 'Не более 100 символов'),
  firstName: z.string().trim().min(1, 'Введите имя').max(100, 'Не более 100 символов'),
  middleName: z.string().trim().max(100, 'Не более 100 символов'),
  birthDate: z.string().min(1, 'Укажите дату рождения').refine(value => {
    const parsed = new Date(`${value}T12:00:00`);
    return !Number.isNaN(parsed.getTime()) && parsed <= new Date();
  }, 'Проверьте дату рождения'),
  sex: z.enum(['male', 'female', 'unknown']),
  polyclinicId: z.string().min(1, 'Выберите поликлинику прикрепления'),
});
type CreateValues = z.infer<typeof createSchema>;
type ContactValues = z.infer<typeof contactsSchema>;
const nullable = (value: string) => value || null;

function CreatePatientForm({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: () => api<ItemList<Organization>>('/organizations') });
  const clinics = organizations.data?.items.filter(item => item.organizationType === 'polyclinic' && item.isActive) ?? [];
  const form = useForm<CreateValues>({ resolver: zodResolver(createSchema), defaultValues: { lastName: '', firstName: '', middleName: '', birthDate: '', sex: 'unknown', phone: '', email: '', address: '', polyclinicId: '' } });
  const mutation = useMutation({ mutationFn: (values: CreateValues) => api<Patient>('/patients', { method: 'POST', body: JSON.stringify({ ...values, middleName: nullable(values.middleName), phone: nullable(values.phone), email: nullable(values.email), address: nullable(values.address), polyclinicId: Number(values.polyclinicId) }) }), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['patients'] });
    void client.invalidateQueries({ queryKey: ['dashboard'] });
    toast('Пациент зарегистрирован');
    onClose();
  } });
  const errors = form.formState.errors;
  return <form className="patient-form" onSubmit={form.handleSubmit(values => mutation.mutate(values))} noValidate><fieldset disabled={mutation.isPending}><div className="form-section-label"><UserRound size={15} /> Основные сведения</div><div className="form-grid"><div className="field"><label htmlFor="lastName">Фамилия <span>*</span></label><input id="lastName" autoComplete="off" {...form.register('lastName')} aria-invalid={!!errors.lastName} />{errors.lastName && <span className="field-error">{errors.lastName.message}</span>}</div><div className="field"><label htmlFor="firstName">Имя <span>*</span></label><input id="firstName" autoComplete="off" {...form.register('firstName')} aria-invalid={!!errors.firstName} />{errors.firstName && <span className="field-error">{errors.firstName.message}</span>}</div><div className="field"><label htmlFor="middleName">Отчество</label><input id="middleName" autoComplete="off" {...form.register('middleName')} />{errors.middleName && <span className="field-error">{errors.middleName.message}</span>}</div><div className="field"><label htmlFor="birthDate">Дата рождения <span>*</span></label><input id="birthDate" type="date" {...form.register('birthDate')} aria-invalid={!!errors.birthDate} />{errors.birthDate && <span className="field-error">{errors.birthDate.message}</span>}</div><div className="field"><label htmlFor="sex">Пол</label><select id="sex" {...form.register('sex')}><option value="unknown">Не указан</option><option value="male">Мужской</option><option value="female">Женский</option></select></div><div className="field"><label htmlFor="polyclinicId">Поликлиника <span>*</span></label><select id="polyclinicId" {...form.register('polyclinicId')} aria-invalid={!!errors.polyclinicId} disabled={organizations.isPending || organizations.isError || mutation.isPending}><option value="">{organizations.isPending ? 'Загружаем…' : 'Выберите поликлинику'}</option>{clinics.map(clinic => <option key={clinic.id} value={clinic.id}>{clinic.name}</option>)}</select>{errors.polyclinicId && <span className="field-error">{errors.polyclinicId.message}</span>}{organizations.isError && <span className="field-error">{errorMessage(organizations.error)}</span>}{organizations.isSuccess && !clinics.length && <span className="field-hint">В вашей области доступа нет активных поликлиник.</span>}</div></div><div className="form-section-label form-section-next"><Phone size={15} /> Контактные данные</div><div className="form-grid"><div className="field"><label htmlFor="phone">Телефон</label><input id="phone" type="tel" {...form.register('phone')} />{errors.phone && <span className="field-error">{errors.phone.message}</span>}</div><div className="field"><label htmlFor="email">Электронная почта</label><input id="email" type="email" {...form.register('email')} aria-invalid={!!errors.email} />{errors.email && <span className="field-error">{errors.email.message}</span>}</div><div className="field field-wide"><label htmlFor="address">Адрес</label><input id="address" {...form.register('address')} />{errors.address && <span className="field-error">{errors.address.message}</span>}</div></div></fieldset>{mutation.isError && <div className="form-error" role="alert">{errorMessage(mutation.error)}</div>}<div className="dialog-actions"><span className="form-required">* Обязательные поля</span><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button><Button type="submit" disabled={mutation.isPending || organizations.isError || !clinics.length}><Submitting busy={mutation.isPending}>Зарегистрировать</Submitting></Button></div></form>;
}
function EditPatientForm({ patient, onClose }: { patient: Patient; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const form = useForm<ContactValues>({ resolver: zodResolver(contactsSchema), defaultValues: { phone: patient.phone || '', email: patient.email || '', address: patient.address || '' } });
  const mutation = useMutation({ mutationFn: (values: ContactValues) => api<Patient>(`/patients/${patient.id}`, { method: 'PUT', body: JSON.stringify({ phone: nullable(values.phone), email: nullable(values.email), address: nullable(values.address), version: patient.version }) }), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['patients'] });
    void client.invalidateQueries({ queryKey: ['patient', String(patient.id)] });
    toast('Контактные данные обновлены');
    onClose();
  } });
  return <form className="patient-form" onSubmit={form.handleSubmit(values => mutation.mutate(values))} noValidate><div className="edit-person"><span className="patient-avatar">{initials(fullName(patient))}</span><div><strong>{fullName(patient)}</strong><span>{date(patient.birthDate)} · Карта № {patient.id}</span></div></div><fieldset disabled={mutation.isPending}><div className="form-grid"><div className="field"><label htmlFor="edit-phone">Телефон</label><input id="edit-phone" type="tel" {...form.register('phone')} />{form.formState.errors.phone && <span className="field-error">{form.formState.errors.phone.message}</span>}</div><div className="field"><label htmlFor="edit-email">Электронная почта</label><input id="edit-email" type="email" {...form.register('email')} aria-invalid={!!form.formState.errors.email} />{form.formState.errors.email && <span className="field-error">{form.formState.errors.email.message}</span>}</div><div className="field field-wide"><label htmlFor="edit-address">Адрес</label><input id="edit-address" {...form.register('address')} />{form.formState.errors.address && <span className="field-error">{form.formState.errors.address.message}</span>}</div></div></fieldset>{mutation.isError && <div className="form-error" role="alert">{errorMessage(mutation.error)}{mutation.error instanceof Error && 'status' in mutation.error && mutation.error.status === 409 && <Button type="button" variant="ghost" onClick={() => { void client.invalidateQueries({ queryKey: ['patients'] }); void client.invalidateQueries({ queryKey: ['patient', String(patient.id)] }); onClose(); }}>Обновить данные</Button>}</div>}<div className="dialog-actions"><span className="form-required">Изменение будет записано в журнал</span><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button><Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Сохранить</Submitting></Button></div></form>;
}

export function PatientsPage() {
  const { user } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<'create' | Patient | null>(null);
  const canEdit = !!user && hasRole(user.roles, ['registrar']);
  useEffect(() => { const timer = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300); return () => clearTimeout(timer); }, [searchInput]);
  const query = useQuery({ queryKey: ['patients', search, page], queryFn: () => api<Paged<Patient>>(`/patients?${new URLSearchParams({ search, page: String(page), pageSize: '15' })}`), placeholderData: keepPreviousData });
  const columns = useMemo<ColumnDef<Patient>[]>(() => [
    { accessorKey: 'lastName', header: 'Пациент', cell: ({ row }) => <Link to={`/patients/${row.original.id}`} className="person-cell"><span className="patient-avatar">{initials(fullName(row.original))}</span><span><strong>{fullName(row.original)}</strong><small>Карта № {row.original.id}</small></span></Link> },
    { accessorKey: 'birthDate', header: 'Дата рождения', cell: ({ row }) => <span className="cell-date">{date(row.original.birthDate)}</span> },
    { accessorKey: 'polyclinicName', header: 'Поликлиника', cell: ({ row }) => <span className="cell-wrap">{row.original.polyclinicName || <span className="muted">Не прикреплён</span>}</span> },
    { accessorKey: 'lastVisitAt', header: 'Последнее обращение', cell: ({ row }) => <span className="cell-date">{date(row.original.lastVisitAt)}</span> },
    { accessorKey: 'status', header: 'Статус', cell: ({ row }) => <Badge status={row.original.status} /> },
    { id: 'actions', header: '', cell: ({ row }) => <div className="table-actions">{canEdit && <button className="icon-button" aria-label={`Изменить контакты: ${fullName(row.original)}`} title="Изменить контакты" onClick={() => setDialog(row.original)}><Pencil size={15} /></button>}<Link className="icon-button" to={`/patients/${row.original.id}`} aria-label={`Открыть карточку: ${fullName(row.original)}`} title="Открыть карточку"><ArrowUpRight size={17} /></Link></div> },
  ], [canEdit]);
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 15));
  return <><PageHeading eyebrow="Медицинская сеть / Учёт" title="Пациенты" description="Карточки пациентов и история болезни" action={canEdit && <Button onClick={() => setDialog('create')}><Plus size={17} /> Добавить пациента</Button>} /><Panel className="patients-panel"><div className="table-toolbar"><div className="search-field"><Search size={17} /><input aria-label="Поиск пациентов по ФИО" placeholder="Поиск по фамилии, имени или отчеству" value={searchInput} onChange={event => setSearchInput(event.target.value)} /></div><span className="table-result-count">{query.isFetching ? 'Обновляем…' : `${number(total)} записей`}</span></div>{query.isPending ? <Loading label="Загружаем пациентов" /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : <><DataTable data={query.data.items} columns={columns} emptyTitle={search ? 'Пациенты не найдены' : 'Пациентов пока нет'} emptyDescription={search ? 'Попробуйте другой фрагмент ФИО.' : 'Добавьте первого пациента в вашу рабочую область.'} /><div className="table-pagination"><span>{total ? `${number((page - 1) * 15 + 1)}–${number(Math.min(page * 15, total))} из ${number(total)}` : 'Нет записей'}</span><div><Button variant="ghost" aria-label="Предыдущая страница" disabled={page <= 1 || query.isFetching} onClick={() => setPage(previous => previous - 1)}><ChevronLeft size={17} /></Button><span className="page-number">{page} / {pages}</span><Button variant="ghost" aria-label="Следующая страница" disabled={page >= pages || query.isFetching} onClick={() => setPage(previous => previous + 1)}><ChevronRight size={17} /></Button></div></div></>}</Panel>{dialog && <Dialog open onClose={() => setDialog(null)} title={dialog === 'create' ? 'Новый пациент' : 'Контактные данные'} description={dialog === 'create' ? 'Заполните сведения и выберите поликлинику прикрепления' : 'Изменение разрешённых персональных сведений'}>{dialog === 'create' ? <CreatePatientForm onClose={() => setDialog(null)} /> : <EditPatientForm patient={dialog} onClose={() => setDialog(null)} />}</Dialog>}</>;
}

type HistoryKind = 'diagnosis' | 'record' | 'hospitalization' | 'research' | 'case' | 'other';
type HistoryFilter = 'all' | HistoryKind;

const historyKindLabels: Record<HistoryKind, string> = {
  diagnosis: 'Диагноз', record: 'Медицинская запись', hospitalization: 'Госпитализация',
  research: 'Исследование', case: 'Обращение', other: 'Прочее',
};
const historyIcons = {
  diagnosis: Stethoscope, record: FileText, hospitalization: BedDouble, research: FlaskConical,
  case: FileHeart, other: History,
};
const historyFilters: { kind: HistoryFilter; label: string }[] = [
  { kind: 'all', label: 'Все' },
  { kind: 'diagnosis', label: historyKindLabels.diagnosis },
  { kind: 'record', label: historyKindLabels.record },
  { kind: 'hospitalization', label: historyKindLabels.hospitalization },
  { kind: 'research', label: historyKindLabels.research },
  { kind: 'case', label: historyKindLabels.case },
  { kind: 'other', label: historyKindLabels.other },
];

const historyTypeMap: Record<string, HistoryKind> = {
  diagnosis: 'diagnosis',
  record: 'record', medical_record: 'record', medical_record_entry: 'record', note: 'record', appointment: 'record',
  hospitalization: 'hospitalization', case: 'case',
  lab: 'research', lab_result: 'research', laboratory: 'research', research: 'research', examination: 'research',
};
const historyKind = (type: string): HistoryKind => historyTypeMap[type] ?? 'other';

const icdTitlePattern = /^([A-Z]\d{2}(?:\.\d{1,2})?)\s*[—–-]\s*(.+)$/i;
function diagnosisParts(event: PatientHistory) {
  const match = icdTitlePattern.exec(event.title.trim());
  return match
    ? { code: event.code?.trim() || match[1], name: match[2] }
    : { code: event.code?.trim() || null, name: event.title };
}

function caseOptionLabel(item: PatientCase): string {
  const parts = [item.organizationName];
  if (item.openedAt) parts.push(`от ${date(item.openedAt)}`);
  if (item.status === 'open') parts.push('открыт');
  else if (item.closedAt) parts.push(`закрыт ${date(item.closedAt)}`);
  if (item.primaryDiagnosis) parts.push(item.primaryDiagnosis);
  return parts.filter(Boolean).join(' · ');
}

function PatientHistoryPanel({ history, canAddDiagnosis, onAddDiagnosis }: {
  history: PatientHistory[]; canAddDiagnosis: boolean; onAddDiagnosis: () => void;
}) {
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const sorted = useMemo(() => [...history].sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime()), [history]);
  const counts = useMemo(() => {
    const result: Partial<Record<HistoryKind, number>> = {};
    for (const event of history) {
      const kind = historyKind(event.type);
      result[kind] = (result[kind] ?? 0) + 1;
    }
    return result;
  }, [history]);
  const visible = sorted.filter(event => filter === 'all' || historyKind(event.type) === filter);
  return <Panel className="patient-history-panel">
    <PanelHeading title="История болезни" subtitle="Диагнозы, медицинские записи, госпитализации и исследования в хронологическом порядке" trailing={<div className="history-heading-actions">{canAddDiagnosis && <Button variant="secondary" onClick={onAddDiagnosis}><Plus size={15} /> Добавить диагноз</Button>}<span className="panel-icon"><History size={17} /></span></div>} />
    {history.length > 0 && <div className="history-filters" role="group" aria-label="Фильтр истории болезни">
      {historyFilters.filter(item => item.kind === 'all' || ['diagnosis', 'record', 'hospitalization', 'research'].includes(item.kind) || counts[item.kind]).map(item => <button key={item.kind} type="button" className={`history-filter${filter === item.kind ? ' selected' : ''}`} aria-pressed={filter === item.kind} onClick={() => setFilter(item.kind)}>
        {item.label}<span className="history-filter-count">{item.kind === 'all' ? history.length : counts[item.kind] ?? 0}</span>
      </button>)}
    </div>}
    {!history.length
      ? <Empty title="История болезни пуста" description="Диагнозы, медицинские записи, госпитализации и исследования появятся здесь после обращения пациента." />
      : !visible.length
        ? <Empty title="Нет событий выбранного типа" description="Выберите другой тип событий или покажите всю историю." />
        : <div className="patient-timeline history-timeline">{visible.map((event, index) => {
          const kind = historyKind(event.type);
          const Icon = historyIcons[kind];
          const diagnosis = kind === 'diagnosis' ? diagnosisParts(event) : null;
          return <article className={`timeline-event history-event history-event-${kind}`} key={`${event.type}-${event.id}-${index}`}>
            <span className="timeline-point history-point"><Icon size={15} /></span>
            <div className="history-event-meta"><span className={`history-type history-type-${kind}`}>{historyKindLabels[kind]}</span><time dateTime={event.occurredAt}>{date(event.occurredAt, true)}</time></div>
            <h3>{diagnosis?.code ? <><span className="icd-code">{diagnosis.code}</span>{diagnosis.name}</> : event.title}</h3>
            {event.description && <p>{event.description}</p>}
          </article>;
        })}</div>}
  </Panel>;
}

function AddDiagnosisForm({ patientId, history, onClose }: { patientId: number; history: PatientHistory[]; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [selected, setSelected] = useState<DiagnosisItem | null>(null);
  const [caseId, setCaseId] = useState('');
  const [note, setNote] = useState('');
  const [isPrimary, setIsPrimary] = useState(false);
  const [validation, setValidation] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const diagnosisQuery = useQuery({
    queryKey: ['diagnoses', term],
    queryFn: () => api<{ items: DiagnosisItem[] }>(`/diagnoses?${new URLSearchParams({ search: term, limit: '20' })}`),
    enabled: term.length >= 2,
    staleTime: 60_000,
  });
  const options = payloadItems<DiagnosisItem>(diagnosisQuery.data);
  const casesQuery = useQuery({
    queryKey: ['patient-cases', patientId],
    queryFn: () => api<{ items: PatientCase[] }>(`/patients/${patientId}/cases`),
    retry: false,
  });
  const casesUnavailable = casesQuery.isError && casesQuery.error instanceof ApiError && casesQuery.error.status === 404;
  const caseOptions = useMemo(() => {
    if (casesQuery.data) return payloadItems<PatientCase>(casesQuery.data);
    if (!casesUnavailable) return [];
    // Резервный путь для сервера без /cases: берём caseId из истории болезни.
    const found = new Map<number, string>();
    for (const event of history) {
      if (typeof event.caseId === 'number' && event.caseId > 0) found.set(event.caseId, `Случай № ${event.caseId}`);
      else if (event.type === 'case' && typeof event.id === 'number') found.set(event.id, `Случай № ${event.id}`);
    }
    return [...found].map(([id, label]) => ({ id, organizationId: 0, organizationName: label, status: '', openedAt: '', closedAt: null, primaryDiagnosis: null }));
  }, [casesQuery.data, casesUnavailable, history]);
  useEffect(() => {
    if (caseId || !caseOptions.length) return;
    const openCase = caseOptions.find(item => item.status === 'open');
    setCaseId(String((openCase ?? caseOptions[0]).id));
  }, [caseId, caseOptions]);
  const mutation = useMutation({
    mutationFn: () => api<{ id: number }>(`/patients/${patientId}/diagnoses`, {
      method: 'POST',
      body: JSON.stringify({ caseId: Number(caseId), diagnosisId: selected?.id, note: note.trim() || null, isPrimary }),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['patient', String(patientId)] });
      void client.invalidateQueries({ queryKey: ['patients'] });
      toast('Диагноз добавлен в историю болезни');
      onClose();
    },
  });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (casesQuery.isPending) return setValidation('Дождитесь загрузки случаев лечения.');
    if (!caseOptions.length) return setValidation('Нет открытого случая лечения — добавление диагноза недоступно.');
    if (!selected) return setValidation('Выберите диагноз из справочника МКБ-10.');
    if (!caseId || !caseOptions.some(item => String(item.id) === caseId)) return setValidation('Выберите случай лечения.');
    mutation.mutate();
  }
  const canSave = !!selected && !!caseId && !casesQuery.isPending && caseOptions.length > 0 && !(casesQuery.isError && !casesUnavailable);
  return <form className="patient-form diagnosis-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="form-section-label"><FileHeart size={15} /> Случай лечения</div>
      <div className="field">
        <label htmlFor="diagnosis-case">Медицинский случай <span>*</span></label>
        {casesQuery.isPending
          ? <span className="field-hint">Загружаем случаи лечения…</span>
          : casesQuery.isError && !casesUnavailable
            ? <span className="field-error">Не удалось загрузить случаи лечения. {errorMessage(casesQuery.error)}</span>
            : !caseOptions.length
              ? <span className="diagnosis-empty-case" role="status">Нет открытого случая лечения — добавление диагноза недоступно.</span>
              : <><select id="diagnosis-case" value={caseId} onChange={event => setCaseId(event.target.value)}>{caseOptions.map(item => <option key={item.id} value={item.id}>{caseOptionLabel(item)}</option>)}</select><span className="field-hint">Учреждение, дата и первичный диагноз случая.</span></>}
      </div>
      <div className="form-section-label form-section-next"><Stethoscope size={15} /> Диагноз по МКБ-10</div>
      <div className="field">
        <label htmlFor="diagnosis-search">Код или название <span>*</span></label>
        {selected
          ? <div className="diagnosis-selected">
            <span className="icd-code">{selected.code}</span>
            <div><strong>{selected.name}</strong>{selected.chapter && <small>Глава {selected.chapter}</small>}</div>
            <button type="button" className="icon-button" aria-label="Убрать выбранный диагноз" onClick={() => setSelected(null)}><X size={15} /></button>
          </div>
          : <>
            <div className="search-field diagnosis-search-field"><Search size={17} /><input id="diagnosis-search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Например, I10 или гипертензия" autoComplete="off" role="combobox" aria-expanded={options.length > 0} aria-controls="diagnosis-options" aria-autocomplete="list" /></div>
            {term.length < 2 && <span className="field-hint">Введите не менее двух символов кода или названия.</span>}
            {term.length >= 2 && diagnosisQuery.isPending && <span className="field-hint">Ищем в справочнике МКБ-10…</span>}
            {term.length >= 2 && diagnosisQuery.isError && <span className="field-error">Не удалось загрузить справочник МКБ-10. {errorMessage(diagnosisQuery.error)}</span>}
            {term.length >= 2 && diagnosisQuery.isSuccess && !options.length && <span className="field-hint">Совпадений нет. Уточните код или название.</span>}
            {!!options.length && <ul id="diagnosis-options" className="diagnosis-options" role="listbox" aria-label="Результаты поиска по МКБ-10">{options.map(item => <li key={item.id} role="option" aria-selected={false}><button type="button" onClick={() => { setSelected(item); setSearch(''); setTerm(''); }}>
              <span className="icd-code">{item.code}</span>
              <span className="diagnosis-option-name">{item.name}</span>
              {item.chapter && <small>Глава {item.chapter}</small>}
            </button></li>)}</ul>}
          </>}
      </div>
      <div className="field field-wide diagnosis-note-field"><label htmlFor="diagnosis-note">Примечание</label><textarea id="diagnosis-note" rows={3} value={note} onChange={event => setNote(event.target.value)} placeholder="Необязательное уточнение" /><span className="field-hint">Не более 2000 символов.</span></div>
      <label className="diagnosis-primary"><input type="checkbox" checked={isPrimary} onChange={event => setIsPrimary(event.target.checked)} /><span>Первичный диагноз</span></label>
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось сохранить диагноз: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions"><span className="form-required">Изменение будет записано в журнал</span><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button><Button type="submit" disabled={mutation.isPending || !canSave}><Submitting busy={mutation.isPending}>Сохранить</Submitting></Button></div>
  </form>;
}

export function PatientDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const [editing, setEditing] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const query = useQuery({ queryKey: ['patient', id], queryFn: () => api<PatientDetail>(`/patients/${id}`), enabled: !!id });
  const patient = query.data?.patient;
  const canEdit = !!user && hasRole(user.roles, ['registrar']);
  const canDiagnose = !!user && hasRole(user.roles, ['doctor']);
  return <><Link className="back-link" to="/patients"><ArrowLeft size={16} /> Все пациенты</Link>{query.isPending ? <Panel><Loading label="Открываем карточку" /></Panel> : query.isError ? <Panel><ErrorState error={query.error} retry={() => void query.refetch()} /></Panel> : patient && <><PageHeading eyebrow={`Медицинская карта / № ${patient.id}`} title={fullName(patient)} description={`${date(patient.birthDate)} · ${sexName(patient.sex)}`} action={canEdit && <Button variant="secondary" onClick={() => setEditing(true)}><Pencil size={15} /> Изменить контакты</Button>} /><div className="patient-detail-layout"><Panel className="patient-info-panel"><div className="patient-profile"><span className="patient-avatar patient-avatar-large">{initials(fullName(patient))}</span><Badge status={patient.status} /></div><PanelHeading title="Основные сведения" /><dl className="patient-facts"><div><dt><CalendarDays size={15} /> Дата рождения</dt><dd>{date(patient.birthDate)}</dd></div><div><dt><Phone size={15} /> Телефон</dt><dd>{patient.phone || 'Не указан'}</dd></div><div><dt><Mail size={15} /> Эл. почта</dt><dd>{patient.email || 'Не указана'}</dd></div><div><dt><MapPin size={15} /> Адрес</dt><dd>{patient.address || 'Не указан'}</dd></div><div><dt><FileHeart size={15} /> Поликлиника</dt><dd>{patient.polyclinicName || 'Не прикреплён'}</dd></div><div><dt><History size={15} /> Последнее обращение</dt><dd>{date(patient.lastVisitAt)}</dd></div></dl></Panel><Panel className="patient-history-panel"><PatientHistoryPanel history={query.data.history} canAddDiagnosis={canDiagnose} onAddDiagnosis={() => setDiagnosing(true)} /></Panel></div>{diagnosing && <Dialog open onClose={() => setDiagnosing(false)} title="Новый диагноз" description="Выберите диагноз из справочника МКБ-10 и сохраните запись в историю болезни"><AddDiagnosisForm patientId={patient.id} history={query.data.history} onClose={() => setDiagnosing(false)} /></Dialog>}{editing && <Dialog open onClose={() => setEditing(false)} title="Контактные данные"><EditPatientForm patient={patient} onClose={() => setEditing(false)} /></Dialog>}</>}</>;
}
