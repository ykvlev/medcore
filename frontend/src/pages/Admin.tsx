import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Ban, CheckCircle2, ChevronLeft, ChevronRight, Pencil, ScrollText, ShieldCheck, UserPlus, Users } from 'lucide-react';
import { api, errorMessage } from '../api';
import { date, number, roleNames } from '../format';
import type { AdminUser, AuditRow, ItemList, Laboratory, Organization, OrganizationCard, Paged, Role } from '../types';
import { Badge, Button, DataTable, ErrorState, Loading, PageHeading, Panel, Submitting, useToast } from '../components/ui';
import { MedcoreDialog } from '../components/MedcoreDialog';
import { payloadHasTotal, payloadItems, payloadTotal } from '../components/medcoreUtils';
import './Admin.css';

const PAGE_SIZE = 20;
const organizationRoles: Role[] = [
  'organization_admin', 'doctor', 'registrar', 'analyst',
  'chief_physician', 'deputy_chief_physician', 'head_of_department',
];

interface RoleDraft { role: Role; organizationId: string; laboratoryId: string; departmentId: string }

const roleLabel = (role: string) => roleNames[role as Role] || role;
const outcomeNames: Record<string, string> = { success: 'Успешно', failure: 'Ошибка', denied: 'Отказ', error: 'Ошибка' };
const outcomeStatus: Record<string, string> = { success: 'active', failure: 'cancelled', denied: 'cancelled', error: 'cancelled' };

/** Каталог ролей может прийти массивом строк или объектов — разбираем оба варианта. */
function parseRoleCatalog(payload: unknown): string[] {
  const source: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object'
      ? Array.isArray((payload as { items?: unknown[] }).items)
        ? (payload as { items: unknown[] }).items
        : Array.isArray((payload as { roles?: unknown[] }).roles)
          ? (payload as { roles: unknown[] }).roles
          : []
      : [];
  return source.flatMap(entry => {
    if (typeof entry === 'string') return [entry];
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const value = record.code ?? record.role ?? record.name;
    return typeof value === 'string' ? [value] : [];
  });
}

/** Полный список ролей: новые роли видны даже если сервер ещё отдаёт старый каталог. */
function roleOptionsFrom(payload: unknown): string[] {
  return [...new Set<string>([...(Object.keys(roleNames)), ...parseRoleCatalog(payload)])];
}

function roleAssignmentPayload(drafts: RoleDraft[]) {
  return drafts.map(draft => ({
    role: draft.role,
    organizationId: draft.organizationId ? Number(draft.organizationId) : null,
    laboratoryId: draft.laboratoryId ? Number(draft.laboratoryId) : null,
    departmentId: draft.role === 'head_of_department' && draft.departmentId ? Number(draft.departmentId) : null,
  }));
}

function RoleScopeEditor({ roleOptions, drafts, organizations, laboratories, onToggle, onScope }: {
  roleOptions: string[];
  drafts: RoleDraft[];
  organizations: Organization[];
  laboratories: Laboratory[];
  onToggle: (role: Role) => void;
  onScope: (role: Role, field: 'organizationId' | 'laboratoryId' | 'departmentId', value: string) => void;
}) {
  const headDraft = drafts.find(draft => draft.role === 'head_of_department');
  const headOrganizationId = headDraft?.organizationId ?? '';
  const headOrganization = useQuery({
    queryKey: ['organization', headOrganizationId],
    queryFn: () => api<OrganizationCard>(`/organizations/${headOrganizationId}`),
    enabled: !!headOrganizationId,
  });
  const departments = headOrganization.data?.buildings.flatMap(building => building.departments) ?? [];
  return <>
    <div className="admin-role-grid">{roleOptions.map(role => <label key={role} className={`admin-role-option${drafts.some(draft => draft.role === role) ? ' selected' : ''}`}>
      <input type="checkbox" checked={drafts.some(draft => draft.role === role)} onChange={() => onToggle(role as Role)} />
      <span>{roleLabel(role)}</span>
    </label>)}</div>
    {drafts.length > 0 && <div className="admin-scopes">{drafts.map(draft => <div className="admin-scope-row" key={draft.role}>
      <span className="admin-scope-name">{roleLabel(draft.role)}</span>
      {organizationRoles.includes(draft.role)
        ? <div className="admin-scope-fields">
          <select aria-label={`Организация для роли ${roleLabel(draft.role)}`} value={draft.organizationId} onChange={event => onScope(draft.role, 'organizationId', event.target.value)}>
            <option value="">Вся доступная область</option>
            {organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {draft.role === 'head_of_department' && <>
            <select aria-label="Отделение для роли заведующий отделением" value={draft.departmentId} onChange={event => onScope(draft.role, 'departmentId', event.target.value)} disabled={!draft.organizationId || headOrganization.isPending}>
              <option value="">{headOrganization.isPending ? 'Загружаем отделения…' : draft.organizationId ? 'Вся организация' : 'Сначала выберите организацию'}</option>
              {departments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            <span className="admin-scope-hint">{headOrganization.isError ? 'Не удалось загрузить отделения — роль можно сохранить без отделения.' : 'Отделение сужает статистику и список персонала.'}</span>
          </>}
        </div>
        : draft.role === 'lab_staff'
          ? <select aria-label="Лаборатория для роли сотрудник лаборатории" value={draft.laboratoryId} onChange={event => onScope(draft.role, 'laboratoryId', event.target.value)}>
            <option value="">Вся доступная область</option>
            {laboratories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          : draft.role === 'minister_of_health' || draft.role === 'governor'
            ? <span className="admin-no-scope">{draft.role === 'minister_of_health' ? 'Сводные данные города' : 'Сводные данные региона'}</span>
            : <span className="admin-no-scope">Системная область</span>}
    </div>)}</div>}
  </>;
}

function CreateUserForm({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [drafts, setDrafts] = useState<RoleDraft[]>([]);
  const [validation, setValidation] = useState<string | null>(null);
  const rolesQuery = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api<unknown>('/admin/roles') });
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: () => api<ItemList<Organization>>('/organizations') });
  const laboratories = useQuery({ queryKey: ['laboratories'], queryFn: () => api<ItemList<Laboratory>>('/laboratories') });
  const roleOptions = useMemo(() => roleOptionsFrom(rolesQuery.data), [rolesQuery.data]);
  const organizationItems = payloadItems(organizations.data);
  const laboratoryItems = payloadItems(laboratories.data);
  const mutation = useMutation({
    mutationFn: () => api<{ id: number }>('/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        login: login.trim(), password, employeeId: employeeId ? Number(employeeId) : null,
        roles: roleAssignmentPayload(drafts),
      }),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast('Учётная запись создана');
      onClose();
    },
  });
  function toggleRole(role: Role) {
    setDrafts(previous => previous.some(draft => draft.role === role)
      ? previous.filter(draft => draft.role !== role)
      : [...previous, { role, organizationId: '', laboratoryId: '', departmentId: '' }]);
  }
  function setScope(role: Role, field: 'organizationId' | 'laboratoryId' | 'departmentId', value: string) {
    setDrafts(previous => previous.map(draft => draft.role === role
      ? { ...draft, [field]: value, ...(field === 'organizationId' && role === 'head_of_department' ? { departmentId: '' } : {}) }
      : draft));
  }
  function submit() {
    setValidation(null);
    mutation.reset();
    if (login.trim().length < 3) return setValidation('Логин должен содержать не менее 3 символов.');
    if (password.length < 8) return setValidation('Пароль должен содержать не менее 8 символов.');
    if (employeeId && (!Number.isInteger(Number(employeeId)) || Number(employeeId) < 1)) return setValidation('Идентификатор сотрудника должен быть положительным целым числом.');
    if (!drafts.length) return setValidation('Назначьте хотя бы одну роль.');
    mutation.mutate();
  }
  return <form className="admin-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="form-grid">
        <div className="field"><label htmlFor="admin-login">Логин <span>*</span></label><input id="admin-login" value={login} onChange={event => setLogin(event.target.value)} autoComplete="off" /></div>
        <div className="field"><label htmlFor="admin-password">Пароль <span>*</span></label><input id="admin-password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="new-password" /></div>
        <div className="field field-wide"><label htmlFor="admin-employee">Идентификатор сотрудника</label><input id="admin-employee" type="number" min={1} value={employeeId} onChange={event => setEmployeeId(event.target.value)} autoComplete="off" /><span className="field-hint">Необязательно: связывает учётную запись с карточкой сотрудника.</span></div>
      </div>
      <div className="form-section-label form-section-next"><ShieldCheck size={15} /> Роли и область доступа</div>
      <RoleScopeEditor roleOptions={roleOptions} drafts={drafts} organizations={organizationItems} laboratories={laboratoryItems} onToggle={toggleRole} onScope={setScope} />
      {(organizations.isError || laboratories.isError) && <p className="field-hint">Не удалось загрузить области доступа — роль можно назначить без ограничения области.</p>}
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось создать пользователя: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions"><span className="form-required">Пароль не отображается в списке пользователей</span><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button><Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Создать пользователя</Submitting></Button></div>
  </form>;
}

function EditUserForm({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [validation, setValidation] = useState<string | null>(null);
  const rolesQuery = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api<unknown>('/admin/roles') });
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: () => api<ItemList<Organization>>('/organizations') });
  const laboratories = useQuery({ queryKey: ['laboratories'], queryFn: () => api<ItemList<Laboratory>>('/laboratories') });
  const organizationItems = payloadItems(organizations.data);
  const laboratoryItems = payloadItems(laboratories.data);
  const roleOptions = useMemo(() => roleOptionsFrom(rolesQuery.data), [rolesQuery.data]);
  const [drafts, setDrafts] = useState<RoleDraft[]>(() => user.roles.map(role => ({
    role: role.role as Role,
    organizationId: String(role.organizationId ?? organizationItems.find(item => item.name === role.organizationName)?.id ?? ''),
    laboratoryId: String(role.laboratoryId ?? laboratoryItems.find(item => item.name === role.laboratoryName)?.id ?? ''),
    departmentId: role.departmentId ? String(role.departmentId) : '',
  })));
  const mutation = useMutation({
    mutationFn: () => api<void>(`/admin/users/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({ isActive: user.isActive, roles: roleAssignmentPayload(drafts) }),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast('Роли и область доступа обновлены');
      onClose();
    },
  });
  function toggleRole(role: Role) {
    setDrafts(previous => previous.some(draft => draft.role === role)
      ? previous.filter(draft => draft.role !== role)
      : [...previous, { role, organizationId: '', laboratoryId: '', departmentId: '' }]);
  }
  function setScope(role: Role, field: 'organizationId' | 'laboratoryId' | 'departmentId', value: string) {
    setDrafts(previous => previous.map(draft => draft.role === role
      ? { ...draft, [field]: value, ...(field === 'organizationId' && role === 'head_of_department' ? { departmentId: '' } : {}) }
      : draft));
  }
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!drafts.length) return setValidation('Назначьте хотя бы одну роль.');
    mutation.mutate();
  }
  return <form className="admin-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="edit-person"><span className="patient-avatar">{user.login.slice(0, 2).toUpperCase()}</span><div><strong>{user.displayName || user.login}</strong><span>{user.login}</span></div></div>
      <div className="form-section-label"><ShieldCheck size={15} /> Роли и область доступа</div>
      <RoleScopeEditor roleOptions={roleOptions} drafts={drafts} organizations={organizationItems} laboratories={laboratoryItems} onToggle={toggleRole} onScope={setScope} />
      {(organizations.isError || laboratories.isError) && <p className="field-hint">Не удалось загрузить области доступа — роли можно сохранить без ограничения области.</p>}
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось сохранить роли: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions"><span className="form-required">Пароль и активность меняются отдельно</span><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button><Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Сохранить</Submitting></Button></div>
  </form>;
}

export function AdminPage() {
  const [tab, setTab] = useState<'users' | 'audit'>('users');
  const [creating, setCreating] = useState(false);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [toggleUser, setToggleUser] = useState<AdminUser | null>(null);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [actionInput, setActionInput] = useState('');
  const [applied, setApplied] = useState({ from: '', to: '', action: '' });
  const [auditPage, setAuditPage] = useState(1);
  const [filterError, setFilterError] = useState<string | null>(null);
  const client = useQueryClient();
  const toast = useToast();
  const usersQuery = useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<ItemList<AdminUser>>('/admin/users'), enabled: tab === 'users' });
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: () => api<ItemList<Organization>>('/organizations') });
  const laboratories = useQuery({ queryKey: ['laboratories'], queryFn: () => api<ItemList<Laboratory>>('/laboratories') });
  const auditParams = new URLSearchParams({ page: String(auditPage), pageSize: String(PAGE_SIZE) });
  if (applied.from) auditParams.set('from', applied.from);
  if (applied.to) auditParams.set('to', applied.to);
  if (applied.action) auditParams.set('action', applied.action);
  const auditQuery = useQuery({ queryKey: ['admin', 'audit', applied, auditPage], queryFn: () => api<Paged<AuditRow>>(`/admin/audit?${auditParams}`), enabled: tab === 'audit', placeholderData: keepPreviousData });
  const users = payloadItems(usersQuery.data);
  const auditItems = payloadItems(auditQuery.data);
  const auditTotal = payloadTotal(auditQuery.data);
  const auditPages = payloadHasTotal(auditQuery.data) ? Math.max(1, Math.ceil(auditTotal / PAGE_SIZE)) : 1;
  const toggleMutation = useMutation({ mutationFn: (user: AdminUser) => {
    const organizationItems = payloadItems(organizations.data);
    const laboratoryItems = payloadItems(laboratories.data);
    const roles = user.roles.map(role => {
      const organizationId = role.organizationId ?? (role.organizationName ? organizationItems.find(item => item.name === role.organizationName)?.id ?? null : null);
      const laboratoryId = role.laboratoryId ?? (role.laboratoryName ? laboratoryItems.find(item => item.name === role.laboratoryName)?.id ?? null : null);
      if (role.organizationName && !organizationId) throw new Error(`Не удалось определить организацию «${role.organizationName}» для роли ${roleLabel(role.role)}.`);
      if (role.laboratoryName && !laboratoryId) throw new Error(`Не удалось определить лабораторию «${role.laboratoryName}» для роли ${roleLabel(role.role)}.`);
      return { role: role.role, organizationId, laboratoryId, departmentId: role.departmentId ?? null };
    });
    return api<void>(`/admin/users/${user.id}`, { method: 'PUT', body: JSON.stringify({ isActive: !user.isActive, roles }) });
  }, onSuccess: (_data, user) => {
    void client.invalidateQueries({ queryKey: ['admin', 'users'] });
    toast(user.isActive ? 'Учётная запись отключена' : 'Учётная запись включена');
    setToggleUser(null);
  } });
  const userColumns = useMemo<ColumnDef<AdminUser>[]>(() => [
    { accessorKey: 'login', header: 'Логин', cell: ({ row }) => <strong>{row.original.login}</strong> },
    { id: 'displayName', header: 'ФИО', cell: ({ row }) => <span className="cell-wrap">{row.original.displayName || <span className="muted">Не указано</span>}</span> },
    { id: 'roles', header: 'Роли и область', cell: ({ row }) => row.original.roles.length ? <div className="admin-role-chips">{row.original.roles.map((role, index) => <span key={`${role.role}-${index}`} className="admin-role-chip"><strong>{roleLabel(role.role)}</strong>{(role.organizationName || role.laboratoryName || role.departmentName) && <small>{[role.organizationName, role.departmentName].filter(Boolean).join(' · ') || role.laboratoryName}</small>}</span>)}</div> : <span className="muted">Роли не назначены</span> },
    { accessorKey: 'isActive', header: 'Активность', cell: ({ row }) => <Badge status={row.original.isActive ? 'active' : 'archived'}>{row.original.isActive ? 'Активна' : 'Отключена'}</Badge> },
    { id: 'actions', header: '', cell: ({ row }) => <div className="table-actions"><button className="icon-button" aria-label={`Изменить роли: ${row.original.login}`} title="Изменить роли и область" onClick={() => { toggleMutation.reset(); setEditingUser(row.original); }} disabled={organizations.isPending || laboratories.isPending}><Pencil size={15} /></button><Button variant="secondary" className="admin-toggle" onClick={() => { toggleMutation.reset(); setToggleUser(row.original); }} disabled={organizations.isPending || laboratories.isPending}>{row.original.isActive ? <Ban size={14} /> : <CheckCircle2 size={14} />}{row.original.isActive ? 'Отключить' : 'Включить'}</Button></div> },
  ], [organizations.isPending, laboratories.isPending]);
  const auditColumns = useMemo<ColumnDef<AuditRow>[]>(() => [
    { accessorKey: 'occurredAt', header: 'Время', cell: ({ row }) => <span className="cell-date">{date(row.original.occurredAt, true)}</span> },
    { accessorKey: 'actorLogin', header: 'Пользователь', cell: ({ row }) => <span>{row.original.actorLogin || '—'}</span> },
    { accessorKey: 'action', header: 'Действие', cell: ({ row }) => <code className="admin-action-code">{row.original.action}</code> },
    { accessorKey: 'entityType', header: 'Объект', cell: ({ row }) => <span className="cell-wrap">{row.original.entityType}{row.original.entityId ? ` № ${row.original.entityId}` : ''}</span> },
    { accessorKey: 'outcome', header: 'Результат', cell: ({ row }) => <Badge status={outcomeStatus[row.original.outcome] || 'neutral'}>{outcomeNames[row.original.outcome] || row.original.outcome}</Badge> },
  ], []);
  function applyAuditFilters() {
    setFilterError(null);
    if (from && to && from > to) {
      setFilterError('Начало периода позже окончания.');
      return;
    }
    setApplied({ from, to, action: actionInput.trim() });
    setAuditPage(1);
  }
  function resetAuditFilters() {
    setFrom('');
    setTo('');
    setActionInput('');
    setApplied({ from: '', to: '', action: '' });
    setAuditPage(1);
    setFilterError(null);
  }
  return <>
    <PageHeading eyebrow="Администрирование / Доступ" title="Пользователи и аудит" description="Учётные записи, роли, область доступа и журнал действий" action={tab === 'users' && <Button onClick={() => setCreating(true)}><UserPlus size={17} /> Создать пользователя</Button>} />
    <div className="segmented-control admin-tabs" role="group" aria-label="Раздел администрирования"><button type="button" aria-pressed={tab === 'users'} className={tab === 'users' ? 'selected' : ''} onClick={() => setTab('users')}><Users size={16} /> Пользователи</button><button type="button" aria-pressed={tab === 'audit'} className={tab === 'audit' ? 'selected' : ''} onClick={() => setTab('audit')}><ScrollText size={16} /> Журнал аудита</button></div>
    {tab === 'users' ? <Panel className="admin-panel">{usersQuery.isPending ? <Loading label="Загружаем пользователей" /> : usersQuery.isError ? <ErrorState error={usersQuery.error} retry={() => void usersQuery.refetch()} /> : <><div className="table-toolbar"><span className="admin-panel-title">Учётные записи: {number(users.length)}</span><span className="table-result-count">Пароли не отображаются</span></div><DataTable data={users} columns={userColumns} emptyTitle="Пользователей нет" emptyDescription="Создайте первую учётную запись." /></>}</Panel> : <Panel className="admin-panel"><form className="audit-filters" onSubmit={event => { event.preventDefault(); applyAuditFilters(); }}><div className="field"><label htmlFor="audit-from">С даты</label><input id="audit-from" type="date" value={from} onChange={event => setFrom(event.target.value)} /></div><div className="field"><label htmlFor="audit-to">По дату</label><input id="audit-to" type="date" value={to} onChange={event => setTo(event.target.value)} /></div><div className="field"><label htmlFor="audit-action">Действие</label><input id="audit-action" value={actionInput} onChange={event => setActionInput(event.target.value)} placeholder="Код действия" autoComplete="off" /></div><div className="audit-filter-actions"><Button type="submit" variant="secondary"><ScrollText size={15} /> Применить</Button><Button type="button" variant="ghost" onClick={resetAuditFilters}>Сбросить</Button></div></form>{filterError && <div className="form-error audit-filter-error" role="alert">{filterError}</div>}{auditQuery.isPending ? <Loading label="Загружаем журнал аудита" /> : auditQuery.isError ? <ErrorState error={auditQuery.error} retry={() => void auditQuery.refetch()} /> : <><div className="table-toolbar"><span className="admin-panel-title">События: {number(auditTotal)}</span><span className="table-result-count">{applied.from || applied.to ? 'Период применён' : 'Весь доступный период'}</span></div><DataTable data={auditItems} columns={auditColumns} emptyTitle="Событий не найдено" emptyDescription="Измените период или код действия." />{auditPages > 1 && <div className="table-pagination"><span>{auditTotal ? `${number((auditPage - 1) * PAGE_SIZE + 1)}–${number(Math.min(auditPage * PAGE_SIZE, auditTotal))} из ${number(auditTotal)}` : 'Нет записей'}</span><div><Button variant="ghost" aria-label="Предыдущая страница" disabled={auditPage <= 1 || auditQuery.isFetching} onClick={() => setAuditPage(previous => previous - 1)}><ChevronLeft size={17} /></Button><span className="page-number">{auditPage} / {auditPages}</span><Button variant="ghost" aria-label="Следующая страница" disabled={auditPage >= auditPages || auditQuery.isFetching} onClick={() => setAuditPage(previous => previous + 1)}><ChevronRight size={17} /></Button></div></div>}</>}</Panel>}
    {creating && <MedcoreDialog open wide onClose={() => setCreating(false)} eyebrow="Администрирование / Учётные записи" title="Новый пользователь" description="Логин, пароль, роли и область доступа"><CreateUserForm onClose={() => setCreating(false)} /></MedcoreDialog>}
    {editingUser && <MedcoreDialog open wide onClose={() => setEditingUser(null)} eyebrow="Администрирование / Доступ" title="Роли и область доступа" description={editingUser.login}><EditUserForm user={editingUser} onClose={() => setEditingUser(null)} /></MedcoreDialog>}
    {toggleUser && <MedcoreDialog open onClose={() => { toggleMutation.reset(); setToggleUser(null); }} eyebrow="Администрирование / Доступ" title={toggleUser.isActive ? 'Отключить учётную запись' : 'Включить учётную запись'} description={toggleUser.login} busy={toggleMutation.isPending}>{toggleMutation.isError && <div className="form-error" role="alert">{errorMessage(toggleMutation.error)}</div>}<p className="admin-confirm-text">{toggleUser.isActive ? 'Пользователь потеряет доступ к системе. Текущие роли и область доступа сохранятся.' : 'Пользователь снова сможет войти в систему с назначенными ролями.'}</p><div className="dialog-actions"><Button variant="secondary" type="button" disabled={toggleMutation.isPending} onClick={() => { toggleMutation.reset(); setToggleUser(null); }}>Отмена</Button><Button type="button" disabled={toggleMutation.isPending} onClick={() => toggleMutation.mutate(toggleUser)}><Submitting busy={toggleMutation.isPending}>{toggleUser.isActive ? 'Отключить' : 'Включить'}</Submitting></Button></div></MedcoreDialog>}
  </>;
}
