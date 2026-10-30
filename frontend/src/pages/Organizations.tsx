import { useEffect, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowLeft, ArrowUpRight, Ban, BedDouble, Building2, ChevronLeft, ChevronRight, Hospital, Layers3, MapPin, Phone, Plus, Power, PowerOff, RotateCcw, Search } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { hasRole, number, percent } from '../format';
import type { BedRow, BuildingRow, DepartmentRow, Dictionaries, ItemList, OrganizationCard, OrganizationRow, Paged, WardRow } from '../types';
import { Badge, Button, DataTable, Empty, ErrorState, Loading, PageHeading, Panel, PanelHeading, Submitting, useToast } from '../components/ui';
import { EntityDialog } from '../components/EntityDialog';
import { ProblemNotice } from '../components/ProblemNotice';
import './Organizations.css';

const PAGE_SIZE = 15;
const EMPTY_BUILDINGS: BuildingRow[] = [];
const organizationTypeTabs = [
  { value: 'all', label: 'Все' },
  { value: 'hospital', label: 'Больницы' },
  { value: 'polyclinic', label: 'Поликлиники' },
] as const;

function plural(count: number, forms: [string, string, string]) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}
function organizationTypeLabel(type: string) {
  return type === 'hospital' ? 'Больница' : type === 'polyclinic' ? 'Поликлиника' : type;
}
/* Пока серверная пагинация не подключена, старый ответ { items } фильтруем на клиенте. */
function organizationPage(data: Paged<OrganizationRow> | ItemList<OrganizationRow>, search: string, type: string, page: number) {
  if ('total' in data) return data;
  const needle = search.toLocaleLowerCase('ru').trim();
  const filtered = data.items.filter(item => {
    const matchesType = type === 'all' || item.organizationType === type;
    const haystack = [item.name, item.address, item.parentHospitalName].filter(Boolean).join(' ').toLocaleLowerCase('ru');
    return matchesType && (!needle || haystack.includes(needle));
  });
  const start = (page - 1) * PAGE_SIZE;
  return { items: filtered.slice(start, start + PAGE_SIZE), total: filtered.length, page, pageSize: PAGE_SIZE };
}
function buildingMeta(building: BuildingRow) {
  const departments = building.departments.length;
  const wards = building.departments.reduce((sum, item) => sum + item.wards.length, 0);
  const beds = building.departments.reduce((sum, item) => sum + item.totalBeds, 0);
  return `${number(departments)} ${plural(departments, ['отделение', 'отделения', 'отделений'])} · ${number(wards)} ${plural(wards, ['палата', 'палаты', 'палат'])} · ${number(beds)} ${plural(beds, ['койка', 'койки', 'коек'])}`;
}
function departmentMeta(department: DepartmentRow) {
  return `${number(department.wards.length)} ${plural(department.wards.length, ['палата', 'палаты', 'палат'])} · ${number(department.totalBeds)} ${plural(department.totalBeds, ['койка', 'койки', 'коек'])}`;
}
function wardMeta(ward: WardRow) {
  return `${number(ward.beds.length)} ${plural(ward.beds.length, ['койка', 'койки', 'коек'])} · вместимость ${number(ward.plannedCapacity)}`;
}
function departmentOccupancy(department: DepartmentRow) {
  return department.totalBeds ? Math.min(100, Math.round((department.occupiedBeds / department.totalBeds) * 1000) / 10) : 0;
}

/* ------------------------------------------------------------------ */
/* Формы создания                                                     */
/* ------------------------------------------------------------------ */

const createOrganizationSchema = z.object({
  name: z.string().trim().min(2, 'Введите название учреждения').max(200, 'Не более 200 символов'),
  organizationType: z.enum(['hospital', 'polyclinic']),
  address: z.string().trim().min(3, 'Введите адрес учреждения').max(300, 'Не более 300 символов'),
  phone: z.string().trim().max(50, 'Не более 50 символов'),
});
type CreateOrganizationValues = z.infer<typeof createOrganizationSchema>;

function CreateOrganizationForm({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const form = useForm<CreateOrganizationValues>({
    resolver: zodResolver(createOrganizationSchema),
    defaultValues: { name: '', organizationType: 'hospital', address: '', phone: '' },
  });
  const mutation = useMutation({
    mutationFn: (values: CreateOrganizationValues) => api<OrganizationRow>('/organizations', {
      method: 'POST',
      body: JSON.stringify({
        name: values.name,
        organizationType: values.organizationType,
        address: values.address,
        phone: values.phone || null,
        parentHospitalId: null,
      }),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['organizations'] });
      toast('Учреждение добавлено');
      onClose();
    },
  });
  const errors = form.formState.errors;
  return (
    <form onSubmit={form.handleSubmit(values => mutation.mutate(values))} noValidate>
      <fieldset disabled={mutation.isPending}>
        <div className="form-section-label"><Hospital size={15} /> Учреждение</div>
        <div className="form-grid">
          <div className="field field-wide">
            <label htmlFor="organization-name">Название <span>*</span></label>
            <input id="organization-name" autoComplete="off" placeholder="Например, Городская клиническая больница № 2" {...form.register('name')} aria-invalid={!!errors.name} />
            {errors.name && <span className="field-error">{errors.name.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="organization-type">Тип учреждения <span>*</span></label>
            <select id="organization-type" {...form.register('organizationType')}>
              <option value="hospital">Больница</option>
              <option value="polyclinic">Поликлиника</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="organization-phone">Телефон</label>
            <input id="organization-phone" type="tel" autoComplete="off" placeholder="+7 (495) 000-00-00" {...form.register('phone')} aria-invalid={!!errors.phone} />
            {errors.phone && <span className="field-error">{errors.phone.message}</span>}
          </div>
          <div className="field field-wide">
            <label htmlFor="organization-address">Адрес <span>*</span></label>
            <input id="organization-address" autoComplete="off" placeholder="Город, улица, дом" {...form.register('address')} aria-invalid={!!errors.address} />
            {errors.address && <span className="field-error">{errors.address.message}</span>}
          </div>
        </div>
      </fieldset>
      <ProblemNotice error={mutation.error} />
      <div className="dialog-actions">
        <span className="form-required">* Обязательные поля</span>
        <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
        <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Добавить учреждение</Submitting></Button>
      </div>
    </form>
  );
}

const buildingSchema = z.object({
  number: z.string().trim().min(1, 'Укажите номер корпуса').max(20, 'Не более 20 символов'),
});
type BuildingValues = z.infer<typeof buildingSchema>;

function BuildingForm({ organizationId, onClose }: { organizationId: string; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const form = useForm<BuildingValues>({ resolver: zodResolver(buildingSchema), defaultValues: { number: '' } });
  const mutation = useMutation({
    mutationFn: (values: BuildingValues) => api<{ id: number }>(`/hospitals/${organizationId}/buildings`, { method: 'POST', body: JSON.stringify({ number: values.number }) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['organization', organizationId] });
      toast('Корпус добавлен');
      onClose();
    },
  });
  return (
    <form onSubmit={form.handleSubmit(values => mutation.mutate(values))} noValidate>
      <fieldset disabled={mutation.isPending}>
        <div className="form-grid">
          <div className="field field-wide">
            <label htmlFor="building-number">Номер корпуса <span>*</span></label>
            <input id="building-number" autoComplete="off" placeholder="Например, 2" {...form.register('number')} aria-invalid={!!form.formState.errors.number} />
            {form.formState.errors.number && <span className="field-error">{form.formState.errors.number.message}</span>}
            <span className="field-hint">Номер должен быть уникален внутри учреждения.</span>
          </div>
        </div>
      </fieldset>
      <ProblemNotice error={mutation.error} />
      <div className="dialog-actions">
        <span className="form-required">* Обязательные поля</span>
        <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
        <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Добавить корпус</Submitting></Button>
      </div>
    </form>
  );
}

const departmentSchema = z.object({
  name: z.string().trim().min(2, 'Введите название отделения').max(150, 'Не более 150 символов'),
  specializationId: z.string().min(1, 'Выберите специализацию'),
});
type DepartmentValues = z.infer<typeof departmentSchema>;

function DepartmentForm({ buildingId, onClose }: { buildingId: number; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const dictionaries = useQuery({ queryKey: ['dictionaries'], queryFn: () => api<Dictionaries>('/dictionaries') });
  const form = useForm<DepartmentValues>({ resolver: zodResolver(departmentSchema), defaultValues: { name: '', specializationId: '' } });
  const mutation = useMutation({
    mutationFn: (values: DepartmentValues) => api<{ id: number }>(`/buildings/${buildingId}/departments`, {
      method: 'POST',
      body: JSON.stringify({ name: values.name, specializationId: Number(values.specializationId) }),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['organization'] });
      toast('Отделение добавлено');
      onClose();
    },
  });
  const specializations = dictionaries.data?.specializations ?? [];
  const errors = form.formState.errors;
  return (
    <form onSubmit={form.handleSubmit(values => mutation.mutate(values))} noValidate>
      <fieldset disabled={mutation.isPending || dictionaries.isError}>
        <div className="form-grid">
          <div className="field field-wide">
            <label htmlFor="department-name">Название отделения <span>*</span></label>
            <input id="department-name" autoComplete="off" placeholder="Например, Кардиологическое отделение" {...form.register('name')} aria-invalid={!!errors.name} />
            {errors.name && <span className="field-error">{errors.name.message}</span>}
          </div>
          <div className="field field-wide">
            <label htmlFor="department-specialization">Специализация <span>*</span></label>
            <select id="department-specialization" {...form.register('specializationId')} aria-invalid={!!errors.specializationId} disabled={dictionaries.isPending || mutation.isPending}>
              <option value="">{dictionaries.isPending ? 'Загружаем справочник…' : 'Выберите специализацию'}</option>
              {specializations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {errors.specializationId && <span className="field-error">{errors.specializationId.message}</span>}
            {dictionaries.isSuccess && !specializations.length && <span className="field-hint">Справочник специализаций пуст — отделение создать нельзя.</span>}
          </div>
        </div>
      </fieldset>
      <ProblemNotice error={mutation.error} />
      <ProblemNotice error={dictionaries.error} onRetry={() => void dictionaries.refetch()} retryLabel="Загрузить справочник" />
      <div className="dialog-actions">
        <span className="form-required">* Обязательные поля</span>
        <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
        <Button type="submit" disabled={mutation.isPending || dictionaries.isError || !specializations.length}><Submitting busy={mutation.isPending}>Добавить отделение</Submitting></Button>
      </div>
    </form>
  );
}

const wardSchema = z.object({
  number: z.string().trim().min(1, 'Укажите номер палаты').max(20, 'Не более 20 символов'),
  plannedCapacity: z.string().trim().min(1, 'Укажите плановую вместимость').refine(value => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 100, 'Вместимость — целое число от 1 до 100'),
});
type WardValues = z.infer<typeof wardSchema>;

function WardForm({ departmentId, onClose }: { departmentId: number; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const form = useForm<WardValues>({ resolver: zodResolver(wardSchema), defaultValues: { number: '', plannedCapacity: '' } });
  const mutation = useMutation({
    mutationFn: (values: WardValues) => api<{ id: number }>(`/departments/${departmentId}/wards`, {
      method: 'POST',
      body: JSON.stringify({ number: values.number, plannedCapacity: Number(values.plannedCapacity) }),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['organization'] });
      toast('Палата добавлена');
      onClose();
    },
  });
  const errors = form.formState.errors;
  return (
    <form onSubmit={form.handleSubmit(values => mutation.mutate(values))} noValidate>
      <fieldset disabled={mutation.isPending}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="ward-number">Номер палаты <span>*</span></label>
            <input id="ward-number" autoComplete="off" placeholder="Например, 201" {...form.register('number')} aria-invalid={!!errors.number} />
            {errors.number && <span className="field-error">{errors.number.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="ward-capacity">Плановая вместимость <span>*</span></label>
            <input id="ward-capacity" inputMode="numeric" autoComplete="off" placeholder="4" {...form.register('plannedCapacity')} aria-invalid={!!errors.plannedCapacity} />
            {errors.plannedCapacity && <span className="field-error">{errors.plannedCapacity.message}</span>}
          </div>
        </div>
      </fieldset>
      <ProblemNotice error={mutation.error} />
      <div className="dialog-actions">
        <span className="form-required">* Обязательные поля</span>
        <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
        <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Добавить палату</Submitting></Button>
      </div>
    </form>
  );
}

const bedSchema = z.object({
  number: z.string().trim().min(1, 'Укажите номер койки').max(20, 'Не более 20 символов'),
});
type BedValues = z.infer<typeof bedSchema>;

function BedForm({ wardId, onClose }: { wardId: number; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const form = useForm<BedValues>({ resolver: zodResolver(bedSchema), defaultValues: { number: '' } });
  const mutation = useMutation({
    mutationFn: (values: BedValues) => api<{ id: number }>(`/wards/${wardId}/beds`, { method: 'POST', body: JSON.stringify({ number: values.number }) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['organization'] });
      toast('Койка добавлена');
      onClose();
    },
  });
  return (
    <form onSubmit={form.handleSubmit(values => mutation.mutate(values))} noValidate>
      <fieldset disabled={mutation.isPending}>
        <div className="form-grid">
          <div className="field field-wide">
            <label htmlFor="bed-number">Номер койки <span>*</span></label>
            <input id="bed-number" autoComplete="off" placeholder="Например, 3" {...form.register('number')} aria-invalid={!!form.formState.errors.number} />
            {form.formState.errors.number && <span className="field-error">{form.formState.errors.number.message}</span>}
            <span className="field-hint">Койка появится в палате со статусом «в эксплуатации».</span>
          </div>
        </div>
      </fieldset>
      <ProblemNotice error={mutation.error} />
      <div className="dialog-actions">
        <span className="form-required">* Обязательные поля</span>
        <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
        <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Добавить койку</Submitting></Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Раскрывающийся блок иерархии                                       */
/* ------------------------------------------------------------------ */

function Disclosure({ title, meta, level, defaultOpen = false, actions, children }: { title: ReactNode; meta?: ReactNode; level: 'building' | 'department' | 'ward'; defaultOpen?: boolean; actions?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  return (
    <div className={`org-node org-node-${level}`}>
      <div className="org-node-row">
        <button type="button" className="org-node-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}>
          <ChevronRight size={15} className={open ? 'org-chevron is-open' : 'org-chevron'} aria-hidden="true" />
          <span className="org-node-title">{title}</span>
          {meta && <span className="org-node-meta">{meta}</span>}
        </button>
        {actions && <div className="org-node-actions">{actions}</div>}
      </div>
      <div id={panelId} className="org-node-body" hidden={!open}>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Список организаций                                                 */
/* ------------------------------------------------------------------ */

export function OrganizationsPage() {
  const { user } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [type, setType] = useState<(typeof organizationTypeTabs)[number]['value']>('all');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const canManage = !!user && hasRole(user.roles, ['organization_admin', 'system_admin']);
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);
  const query = useQuery({
    queryKey: ['organizations', 'list', search, type, page],
    queryFn: async () => {
      const params = new URLSearchParams({ search, page: String(page), pageSize: String(PAGE_SIZE) });
      if (type !== 'all') params.set('type', type);
      return organizationPage(await api<Paged<OrganizationRow> | ItemList<OrganizationRow>>(`/organizations?${params}`), search, type, page);
    },
    placeholderData: keepPreviousData,
  });
  const columns = useMemo<ColumnDef<OrganizationRow>[]>(() => [
    {
      accessorKey: 'name',
      header: 'Учреждение',
      cell: ({ row }) => (
        <Link to={`/organizations/${row.original.id}`} className="org-name-cell">
          <span className={`org-type-icon tone-${row.original.organizationType === 'hospital' ? 'blue' : 'mint'}`} aria-hidden="true">
            {row.original.organizationType === 'hospital' ? <Hospital size={17} strokeWidth={1.7} /> : <Building2 size={17} strokeWidth={1.7} />}
          </span>
          <span>
            <strong>{row.original.name}</strong>
            <small>{row.original.parentHospitalName ? `В составе: ${row.original.parentHospitalName}` : `Организация № ${row.original.id}`}</small>
          </span>
        </Link>
      ),
    },
    { accessorKey: 'organizationType', header: 'Тип', cell: ({ row }) => <span className="org-type-label">{organizationTypeLabel(row.original.organizationType)}</span> },
    { accessorKey: 'address', header: 'Адрес', cell: ({ row }) => <span className="cell-wrap">{row.original.address || <span className="muted">Не указан</span>}</span> },
    { accessorKey: 'phone', header: 'Телефон', cell: ({ row }) => row.original.phone ? <span className="org-phone">{row.original.phone}</span> : <span className="muted">—</span> },
    { accessorKey: 'isActive', header: 'Статус', cell: ({ row }) => <Badge status={row.original.isActive ? 'active' : 'archived'}>{row.original.isActive ? 'Действует' : 'Неактивна'}</Badge> },
    { id: 'actions', header: '', cell: ({ row }) => <div className="table-actions"><Link className="icon-button" to={`/organizations/${row.original.id}`} aria-label={`Открыть карточку: ${row.original.name}`} title="Открыть карточку"><ArrowUpRight size={17} /></Link></div> },
  ], []);
  const items = query.data?.items ?? [];
  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);
  useEffect(() => {
    if (query.isSuccess && page > pages) setPage(pages);
  }, [page, pages, query.isSuccess]);
  return (
    <>
      <PageHeading
        eyebrow="Медицинская сеть / Реестр"
        title="Организации"
        description="Больницы и поликлиники доступной рабочей области, их статус и структура"
        action={canManage && <Button onClick={() => setCreating(true)}><Plus size={17} /> Добавить учреждение</Button>}
      />
      <Panel className="organizations-panel">
        <div className="table-toolbar table-toolbar-wrap org-toolbar">
          <div className="segmented-control" role="group" aria-label="Тип учреждения">
            {organizationTypeTabs.map(tab => (
              <button key={tab.value} type="button" className={type === tab.value ? 'selected' : ''} aria-pressed={type === tab.value} onClick={() => { setType(tab.value); setPage(1); }}>{tab.label}</button>
            ))}
          </div>
          <div className="org-toolbar-right">
            <div className="search-field">
              <Search size={17} />
              <input aria-label="Поиск организаций по названию" placeholder="Поиск по названию учреждения" value={searchInput} onChange={event => setSearchInput(event.target.value)} />
            </div>
            <span className="table-result-count" aria-live="polite">{query.isFetching ? 'Обновляем…' : `${number(total)} ${plural(total, ['учреждение', 'учреждения', 'учреждений'])}`}</span>
          </div>
        </div>
        <div aria-busy={query.isFetching}>
          {query.isPending ? <Loading label="Загружаем организации" /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : (
            <>
              <DataTable
                data={items}
                columns={columns}
                emptyTitle={search || type !== 'all' ? 'Организации не найдены' : 'Организаций пока нет'}
                emptyDescription={search || type !== 'all' ? 'Измените поиск или выберите другой тип учреждения.' : 'Добавьте первое учреждение в вашу рабочую область.'}
              />
              <div className="table-pagination">
                <span>{total ? `${number(rangeStart)}–${number(rangeEnd)} из ${number(total)}` : 'Нет записей'}</span>
                <div>
                  <Button variant="ghost" aria-label="Предыдущая страница" disabled={page <= 1 || query.isFetching} onClick={() => setPage(previous => previous - 1)}><ChevronLeft size={17} /></Button>
                  <span className="page-number">{page} / {pages}</span>
                  <Button variant="ghost" aria-label="Следующая страница" disabled={page >= pages || query.isFetching} onClick={() => setPage(previous => previous + 1)}><ChevronRight size={17} /></Button>
                </div>
              </div>
            </>
          )}
        </div>
      </Panel>
      {creating && (
        <EntityDialog open onClose={() => setCreating(false)} eyebrow="MEDCORE / Организации" title="Новое учреждение" description="Учреждение появится в реестре вашей рабочей области" width={640}>
          <CreateOrganizationForm onClose={() => setCreating(false)} />
        </EntityDialog>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Карточка организации                                               */
/* ------------------------------------------------------------------ */

type StructureDialogState =
  | { kind: 'building' }
  | { kind: 'department'; buildingId: number; buildingNumber: string }
  | { kind: 'ward'; departmentId: number; departmentName: string }
  | { kind: 'bed'; wardId: number; wardNumber: string; departmentName: string }
  | null;

function StructureDialog({ state, organizationId, organizationName, onClose }: { state: NonNullable<StructureDialogState>; organizationId: string; organizationName: string; onClose: () => void }) {
  if (state.kind === 'building') {
    return <EntityDialog open onClose={onClose} eyebrow="MEDCORE / Организации" title="Новый корпус" description={`Учреждение «${organizationName}»`} width={540}><BuildingForm organizationId={organizationId} onClose={onClose} /></EntityDialog>;
  }
  if (state.kind === 'department') {
    return <EntityDialog open onClose={onClose} eyebrow="MEDCORE / Организации" title="Новое отделение" description={`Корпус ${state.buildingNumber} · ${organizationName}`} width={580}><DepartmentForm buildingId={state.buildingId} onClose={onClose} /></EntityDialog>;
  }
  if (state.kind === 'ward') {
    return <EntityDialog open onClose={onClose} eyebrow="MEDCORE / Организации" title="Новая палата" description={`Отделение «${state.departmentName}»`} width={580}><WardForm departmentId={state.departmentId} onClose={onClose} /></EntityDialog>;
  }
  return <EntityDialog open onClose={onClose} eyebrow="MEDCORE / Организации" title="Новая койка" description={`Палата ${state.wardNumber} · ${state.departmentName}`} width={520}><BedForm wardId={state.wardId} onClose={onClose} /></EntityDialog>;
}

type StatusAction = 'activate' | 'deactivate';

function OrganizationStatusDialog({ organization, action, onClose }: { organization: OrganizationRow; action: StatusAction; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const activate = action === 'activate';
  const mutation = useMutation({
    mutationFn: () => api<OrganizationRow>(`/organizations/${organization.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: organization.name, address: organization.address, phone: organization.phone, isActive: activate }),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['organization', String(organization.id)] });
      void client.invalidateQueries({ queryKey: ['organizations'] });
      toast(activate ? 'Учреждение активировано' : 'Учреждение деактивировано');
      onClose();
    },
  });
  return (
    <EntityDialog
      open
      onClose={onClose}
      eyebrow="MEDCORE / Организации"
      title={activate ? 'Активировать учреждение' : 'Деактивировать учреждение'}
      description={organization.name}
      width={560}
      busy={mutation.isPending}
    >
      <p className="org-status-note">
        {activate
          ? 'Учреждение будет включено в рабочий реестр. Если структура учреждения заполнена не полностью, сервер откажет и покажет причину.'
          : 'Учреждение будет отмечено как неактивное, структура и сведения сохранятся. Если деактивация запрещена, сервер покажет причину.'}
      </p>
      <div className="org-current-status">
        <span>Текущий статус</span>
        <Badge status={organization.isActive ? 'active' : 'archived'}>{organization.isActive ? 'Действует' : 'Неактивна'}</Badge>
      </div>
      <ProblemNotice error={mutation.error} />
      <div className="dialog-actions">
        <span className="form-required">Изменение статуса записывается в журнал</span>
        <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>{mutation.isError ? 'Закрыть' : 'Отмена'}</Button>
        <Button type="button" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          <Submitting busy={mutation.isPending}>{activate ? 'Активировать' : 'Деактивировать'}</Submitting>
        </Button>
      </div>
    </EntityDialog>
  );
}

export function OrganizationDetailPage() {
  const { id } = useParams();
  const { user } = useAuth();
  const organizationId = id ?? '';
  const client = useQueryClient();
  const toast = useToast();
  const [structureDialog, setStructureDialog] = useState<StructureDialogState>(null);
  const [statusAction, setStatusAction] = useState<StatusAction | null>(null);
  const canManage = !!user && hasRole(user.roles, ['organization_admin', 'system_admin']);
  const canManageStructure = !!user && hasRole(user.roles, ['organization_admin', 'system_admin', 'chief_physician']);
  const query = useQuery({
    queryKey: ['organization', organizationId],
    queryFn: () => api<OrganizationCard>(`/organizations/${organizationId}`),
    enabled: !!organizationId,
  });
  const bedMutation = useMutation({
    mutationFn: (bed: BedRow) => api<void>(`/beds/${bed.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !bed.isActive }) }),
    onSuccess: (_data, bed) => {
      void client.invalidateQueries({ queryKey: ['organization', organizationId] });
      toast(bed.isActive ? `Койка ${bed.number} выведена из эксплуатации` : `Койка ${bed.number} возвращена в эксплуатацию`);
    },
    onError: error => toast(errorMessage(error), 'error'),
  });
  const organization = query.data?.organization;
  const buildings = query.data?.buildings ?? EMPTY_BUILDINGS;
  const totals = useMemo(() => {
    const departments = buildings.flatMap(building => building.departments);
    const totalBeds = departments.reduce((sum, item) => sum + item.totalBeds, 0);
    const occupiedBeds = departments.reduce((sum, item) => sum + item.occupiedBeds, 0);
    const wards = departments.reduce((sum, item) => sum + item.wards.length, 0);
    return {
      departments: departments.length,
      wards,
      totalBeds,
      occupiedBeds,
      freeBeds: Math.max(0, totalBeds - occupiedBeds),
      occupancy: totalBeds ? Math.min(100, Math.round((occupiedBeds / totalBeds) * 1000) / 10) : 0,
    };
  }, [buildings]);
  return (
    <>
      <Link className="back-link" to="/organizations"><ArrowLeft size={16} /> Все организации</Link>
      {query.isPending ? <Panel><Loading label="Открываем учреждение" /></Panel> : query.isError ? <Panel><ErrorState error={query.error} retry={() => void query.refetch()} /></Panel> : organization ? (
        <>
          <PageHeading
            eyebrow={`Медицинская сеть / Учреждение № ${organization.id}`}
            title={organization.name}
            description={`${organizationTypeLabel(organization.organizationType)} · ${organization.address || 'Адрес не указан'}`}
            action={(canManage || canManageStructure) && (
              <div className="org-heading-actions">
                {canManage && <Button variant={organization.isActive ? 'secondary' : 'primary'} onClick={() => setStatusAction(organization.isActive ? 'deactivate' : 'activate')}>
                  {organization.isActive ? <PowerOff size={15} /> : <Power size={15} />}
                  {organization.isActive ? 'Деактивировать' : 'Активировать'}
                </Button>}
                {canManageStructure && <Button variant={organization.isActive ? 'primary' : 'secondary'} onClick={() => setStructureDialog({ kind: 'building' })}><Plus size={17} /> Добавить корпус</Button>}
              </div>
            )}
          />
          <div className="org-detail-layout">
            <Panel className="org-summary-panel">
              <div className="org-summary-head">
                <span className={`organization-icon tone-${organization.organizationType === 'hospital' ? 'blue' : 'mint'}`} aria-hidden="true">
                  {organization.organizationType === 'hospital' ? <Hospital size={25} strokeWidth={1.5} /> : <Building2 size={25} strokeWidth={1.5} />}
                </span>
                <div>
                  <span className="organization-type">{organizationTypeLabel(organization.organizationType)}</span>
                  <div className="org-summary-badges">
                    <Badge status={organization.isActive ? 'active' : 'archived'}>{organization.isActive ? 'Действует' : 'Неактивна'}</Badge>
                  </div>
                </div>
              </div>
              <PanelHeading title="Сведения об учреждении" />
              <dl className="org-facts">
                <div><dt><MapPin size={15} /> Адрес</dt><dd>{organization.address || 'Не указан'}</dd></div>
                <div><dt><Phone size={15} /> Телефон</dt><dd>{organization.phone || 'Не указан'}</dd></div>
                <div><dt><Layers3 size={15} /> Головное учреждение</dt><dd>{organization.parentHospitalName || 'Самостоятельное учреждение'}</dd></div>
              </dl>
              <div className="org-capacity">
                <div className="org-capacity-head"><span>Коечный фонд</span><strong>{percent(totals.occupancy)}</strong></div>
                <div className="progress-track progress-mint" aria-hidden="true"><span style={{ width: `${totals.occupancy}%` }} /></div>
                {totals.totalBeds ? <p>{number(totals.occupiedBeds)} из {number(totals.totalBeds)} коек занято · свободно {number(totals.freeBeds)}</p> : <p>Койки ещё не заведены: добавьте корпус, отделение, палату и койки.</p>}
              </div>
            </Panel>
            <Panel className="org-structure-panel">
              <PanelHeading
                title="Структура учреждения"
                subtitle={`${number(buildings.length)} ${plural(buildings.length, ['корпус', 'корпуса', 'корпусов'])} · ${number(totals.departments)} ${plural(totals.departments, ['отделение', 'отделения', 'отделений'])} · ${number(totals.wards)} ${plural(totals.wards, ['палата', 'палаты', 'палат'])}`}
                trailing={<span className="panel-icon"><Layers3 size={17} /></span>}
              />
              {!buildings.length ? (
                <Empty small title="Структура не заполнена" description={canManageStructure ? 'Добавьте первый корпус, затем отделения, палаты и койки.' : 'Корпуса и подразделения ещё не заведены.'} />
              ) : (
                <div className="org-tree">
                  {buildings.map((building, index) => (
                    <Disclosure
                      key={building.id}
                      level="building"
                      defaultOpen={index === 0}
                      title={`Корпус ${building.number}`}
                      meta={buildingMeta(building)}
                      actions={canManageStructure && (
                        <Button variant="ghost" className="org-add-button" onClick={() => setStructureDialog({ kind: 'department', buildingId: building.id, buildingNumber: building.number })}>
                          <Plus size={13} /> Отделение
                        </Button>
                      )}
                    >
                      {building.departments.length ? building.departments.map(department => (
                        <Disclosure
                          key={department.id}
                          level="department"
                          title={`Отделение «${department.name}»`}
                          meta={departmentMeta(department)}
                          actions={canManageStructure && (
                            <Button variant="ghost" className="org-add-button" onClick={() => setStructureDialog({ kind: 'ward', departmentId: department.id, departmentName: department.name })}>
                              <Plus size={13} /> Палата
                            </Button>
                          )}
                        >
                          <div className="org-dept-summary">
                            <div className="org-dept-progress">
                              <div className={`progress-track ${departmentOccupancy(department) >= 90 ? 'progress-amber' : ''}`} aria-hidden="true"><span style={{ width: `${departmentOccupancy(department)}%` }} /></div>
                              <small>{department.totalBeds ? `${percent(departmentOccupancy(department))} занято` : 'Койки не заведены'}</small>
                            </div>
                            {department.totalBeds > 0 && (
                              <p className="org-dept-note">
                                {department.specialization ? `Специализация: ${department.specialization} · ` : ''}
                                Занято {number(department.occupiedBeds)} из {number(department.totalBeds)} коек
                              </p>
                            )}
                          </div>
                          {department.wards.length ? department.wards.map(ward => (
                            <Disclosure
                              key={ward.id}
                              level="ward"
                              title={`Палата ${ward.number}`}
                              meta={wardMeta(ward)}
                              actions={canManageStructure && (
                                <Button variant="ghost" className="org-add-button" onClick={() => setStructureDialog({ kind: 'bed', wardId: ward.id, wardNumber: ward.number, departmentName: department.name })}>
                                  <Plus size={13} /> Койка
                                </Button>
                              )}
                            >
                              {ward.beds.length ? (
                                <div className="org-beds" role="list" aria-label={`Койки палаты ${ward.number}`}>
                                  {ward.beds.map(bed => {
                                    const pending = bedMutation.isPending && bedMutation.variables?.id === bed.id;
                                    return (
                                      <div key={bed.id} role="listitem" className={`org-bed ${bed.occupied ? 'is-occupied' : bed.isActive ? 'is-free' : 'is-off'}`}>
                                        <span className="org-bed-dot" aria-hidden="true" />
                                        <span className="org-bed-number">Койка {bed.number}</span>
                                        <span className="org-bed-state">{bed.occupied ? 'занята' : bed.isActive ? 'свободна' : 'выведена'}</span>
                                        {canManageStructure && (
                                          <button
                                            type="button"
                                            className="org-bed-action"
                                            disabled={pending}
                                            title={bed.isActive && bed.occupied ? 'Занятую койку нельзя вывести из эксплуатации — сервер вернёт причину' : undefined}
                                            aria-label={bed.isActive ? `Вывести койку ${bed.number} из эксплуатации` : `Вернуть койку ${bed.number} в эксплуатацию`}
                                            onClick={() => bedMutation.mutate(bed)}
                                          >
                                            {bed.isActive ? <Ban size={12} aria-hidden="true" /> : <RotateCcw size={12} aria-hidden="true" />}
                                            {bed.isActive ? 'Вывести' : 'Вернуть'}
                                          </button>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                              ) : <span className="org-empty-inline">В палате нет коек.</span>}
                            </Disclosure>
                          )) : <span className="org-empty-inline">В отделении нет палат.</span>}
                        </Disclosure>
                      )) : <span className="org-empty-inline">В корпусе нет отделений.</span>}
                    </Disclosure>
                  ))}
                </div>
              )}
              {!!buildings.length && <p className="org-structure-hint"><BedDouble size={13} /> Всего в структуре {number(totals.totalBeds)} {plural(totals.totalBeds, ['койка', 'койки', 'коек'])}, свободно {number(totals.freeBeds)}.</p>}
            </Panel>
          </div>
        </>
      ) : <Panel><Empty title="Учреждение не найдено" description="Проверьте адрес или доступность организации для вашей роли." /></Panel>}
      {structureDialog && organization && (
        <StructureDialog state={structureDialog} organizationId={organizationId} organizationName={organization.name} onClose={() => setStructureDialog(null)} />
      )}
      {statusAction && organization && (
        <OrganizationStatusDialog organization={organization} action={statusAction} onClose={() => setStatusAction(null)} />
      )}
    </>
  );
}
