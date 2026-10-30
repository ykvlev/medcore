import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ArrowUpRight, Award, Briefcase, Building2, CalendarDays, ChevronLeft, ChevronRight, ClipboardList, GraduationCap, Phone, Plus, Search, Stethoscope, UserRound, X } from 'lucide-react';
import type { ColumnDef } from '@tanstack/react-table';
import { api, errorMessage } from '../api';
import { useAuth } from '../auth';
import { date, fullName, hasRole, initials, list, number } from '../format';
import type { Dictionaries, EmployeeCard, EmployeeRow, ItemList, OrganizationRow, Paged } from '../types';
import { Badge, Button, DataTable, Empty, ErrorState, Loading, PageHeading, Panel, Submitting, useToast } from '../components/ui';
import { EntityDialog } from '../components/EntityDialog';
import { ProblemNotice } from '../components/ProblemNotice';
import './Employees.css';

const PAGE_SIZE = 15;
const EMPTY_EMPLOYEES: EmployeeRow[] = [];

function plural(count: number, forms: [string, string, string]) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}
function asPaged<T>(data: Paged<T> | ItemList<T>, page: number, pageSize: number): Paged<T> {
  if ('total' in data) return data;
  const start = (page - 1) * pageSize;
  return { items: data.items.slice(start, start + pageSize), total: data.items.length, page, pageSize };
}
function organizationTypeLabel(type: string) {
  return type === 'hospital' ? 'Больница' : type === 'polyclinic' ? 'Поликлиника' : type;
}
function todayIso() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${String(now.getDate()).padStart(2, '0')}`;
}
function isNotFutureDate(value: string) {
  const parsed = new Date(`${value}T12:00:00`);
  return !Number.isNaN(parsed.getTime()) && parsed <= new Date();
}
async function loadOrganizationOptions() {
  const data = await api<Paged<OrganizationRow> | ItemList<OrganizationRow>>('/organizations?pageSize=100');
  return asPaged(data, 1, 100).items;
}

/* ------------------------------------------------------------------ */
/* Создание сотрудника                                                */
/* ------------------------------------------------------------------ */

const employeeSchema = z.object({
  lastName: z.string().trim().min(1, 'Введите фамилию').max(100, 'Не более 100 символов'),
  firstName: z.string().trim().min(1, 'Введите имя').max(100, 'Не более 100 символов'),
  middleName: z.string().trim().max(100, 'Не более 100 символов'),
  birthDate: z.string().min(1, 'Укажите дату рождения').refine(isNotFutureDate, 'Проверьте дату рождения'),
  sex: z.enum(['male', 'female', 'unknown']),
  phone: z.string().trim().max(50, 'Не более 50 символов'),
  categoryId: z.string().min(1, 'Выберите категорию'),
  degreeId: z.string(),
  titleId: z.string(),
  organizationId: z.string().min(1, 'Выберите учреждение'),
  hiredAt: z.string().min(1, 'Укажите дату приёма').refine(isNotFutureDate, 'Дата приёма не может быть в будущем'),
  specialtyIds: z.array(z.number()),
});
type EmployeeValues = z.infer<typeof employeeSchema>;

function CreateEmployeeForm({ dictionaries, onClose }: { dictionaries: Dictionaries; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const organizationsQuery = useQuery({ queryKey: ['organizations', 'options'], queryFn: loadOrganizationOptions });
  const organizations = (organizationsQuery.data ?? []).filter(item => item.isActive);
  const form = useForm<EmployeeValues>({
    resolver: zodResolver(employeeSchema),
    defaultValues: {
      lastName: '', firstName: '', middleName: '', birthDate: '', sex: 'unknown', phone: '',
      categoryId: '', degreeId: '', titleId: '', organizationId: '', hiredAt: todayIso(), specialtyIds: [],
    },
  });
  const mutation = useMutation({
    mutationFn: (values: EmployeeValues) => api<{ id: number }>('/employees', {
      method: 'POST',
      body: JSON.stringify({
        lastName: values.lastName,
        firstName: values.firstName,
        middleName: values.middleName || null,
        birthDate: values.birthDate,
        sex: values.sex,
        phone: values.phone || null,
        categoryId: Number(values.categoryId),
        specialtyIds: values.specialtyIds,
        degreeId: values.degreeId ? Number(values.degreeId) : null,
        titleId: values.titleId ? Number(values.titleId) : null,
        organizationId: Number(values.organizationId),
        hiredAt: values.hiredAt,
      }),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['employees'] });
      void client.invalidateQueries({ queryKey: ['dashboard'] });
      toast('Сотрудник добавлен');
      onClose();
    },
  });
  const selectedSpecialties = form.watch('specialtyIds');
  const errors = form.formState.errors;
  return (
    <form onSubmit={form.handleSubmit(values => mutation.mutate(values))} noValidate>
      <fieldset disabled={mutation.isPending}>
        <div className="form-section-label"><UserRound size={15} /> Личные сведения</div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="employee-last-name">Фамилия <span>*</span></label>
            <input id="employee-last-name" autoComplete="off" {...form.register('lastName')} aria-invalid={!!errors.lastName} />
            {errors.lastName && <span className="field-error">{errors.lastName.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="employee-first-name">Имя <span>*</span></label>
            <input id="employee-first-name" autoComplete="off" {...form.register('firstName')} aria-invalid={!!errors.firstName} />
            {errors.firstName && <span className="field-error">{errors.firstName.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="employee-middle-name">Отчество</label>
            <input id="employee-middle-name" autoComplete="off" {...form.register('middleName')} />
            {errors.middleName && <span className="field-error">{errors.middleName.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="employee-birth-date">Дата рождения <span>*</span></label>
            <input id="employee-birth-date" type="date" max={todayIso()} {...form.register('birthDate')} aria-invalid={!!errors.birthDate} />
            {errors.birthDate && <span className="field-error">{errors.birthDate.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="employee-sex">Пол</label>
            <select id="employee-sex" {...form.register('sex')}>
              <option value="unknown">Не указан</option>
              <option value="male">Мужской</option>
              <option value="female">Женский</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="employee-phone">Телефон</label>
            <input id="employee-phone" type="tel" autoComplete="off" placeholder="+7 (900) 000-00-00" {...form.register('phone')} aria-invalid={!!errors.phone} />
            {errors.phone && <span className="field-error">{errors.phone.message}</span>}
          </div>
        </div>
        <div className="form-section-label form-section-next"><Briefcase size={15} /> Должность и учреждение</div>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="employee-category">Категория <span>*</span></label>
            <select id="employee-category" {...form.register('categoryId')} aria-invalid={!!errors.categoryId}>
              <option value="">Выберите категорию</option>
              {dictionaries.categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {errors.categoryId && <span className="field-error">{errors.categoryId.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="employee-organization">Учреждение <span>*</span></label>
            <select id="employee-organization" {...form.register('organizationId')} aria-invalid={!!errors.organizationId} disabled={organizationsQuery.isPending || organizationsQuery.isError || mutation.isPending}>
              <option value="">{organizationsQuery.isPending ? 'Загружаем учреждения…' : 'Выберите учреждение'}</option>
              {organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
            {errors.organizationId && <span className="field-error">{errors.organizationId.message}</span>}
            {organizationsQuery.isSuccess && !organizations.length && <span className="field-hint">Нет активных учреждений в вашей области доступа.</span>}
          </div>
          <div className="field">
            <label htmlFor="employee-hired-at">Принят на работу <span>*</span></label>
            <input id="employee-hired-at" type="date" max={todayIso()} {...form.register('hiredAt')} aria-invalid={!!errors.hiredAt} />
            {errors.hiredAt && <span className="field-error">{errors.hiredAt.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="employee-degree">Учёная степень</label>
            <select id="employee-degree" {...form.register('degreeId')}>
              <option value="">Не указана</option>
              {dictionaries.degrees.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="employee-title">Учёное звание</label>
            <select id="employee-title" {...form.register('titleId')}>
              <option value="">Не указано</option>
              {dictionaries.titles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </div>
          <div className="field">
            <span className="emp-group-label" id="employee-specialty-group">Специальности</span>
            {dictionaries.specialties.length ? (
              <div className="emp-checkbox-grid" role="group" aria-labelledby="employee-specialty-group">
                {dictionaries.specialties.map(item => (
                  <label className="emp-check" key={item.id} htmlFor={`employee-specialty-${item.id}`}>
                    <input
                      id={`employee-specialty-${item.id}`}
                      type="checkbox"
                      checked={selectedSpecialties.includes(item.id)}
                      onChange={event => form.setValue('specialtyIds', event.target.checked ? [...selectedSpecialties, item.id] : selectedSpecialties.filter(id => id !== item.id), { shouldValidate: true, shouldDirty: true })}
                    />
                    <span>{item.name}</span>
                  </label>
                ))}
              </div>
            ) : <span className="field-hint">Справочник специальностей пуст.</span>}
            <span className="field-hint">Степень, звание и специальности указываются для врачей.</span>
          </div>
        </div>
      </fieldset>
      <ProblemNotice error={mutation.error} />
      <ProblemNotice error={organizationsQuery.error} onRetry={() => void organizationsQuery.refetch()} retryLabel="Загрузить учреждения" />
      <div className="dialog-actions">
        <span className="form-required">* Обязательные поля</span>
        <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
        <Button type="submit" disabled={mutation.isPending || organizationsQuery.isError || !organizations.length}><Submitting busy={mutation.isPending}>Добавить сотрудника</Submitting></Button>
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */
/* Карточка сотрудника                                                */
/* ------------------------------------------------------------------ */

const specialtySchema = z.object({ specialtyId: z.string().min(1, 'Выберите специальность') });
type SpecialtyValues = z.infer<typeof specialtySchema>;

function AddSpecialtyForm({ employeeId, existingIds, onDone, onCancel }: { employeeId: number; existingIds: number[]; onDone: () => void; onCancel: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const dictionaries = useQuery({ queryKey: ['dictionaries'], queryFn: () => api<Dictionaries>('/dictionaries') });
  const available = dictionaries.data?.specialties.filter(item => !existingIds.includes(item.id)) ?? [];
  const form = useForm<SpecialtyValues>({ resolver: zodResolver(specialtySchema), defaultValues: { specialtyId: '' } });
  const mutation = useMutation({
    mutationFn: (values: SpecialtyValues) => api<{ id: number }>(`/doctors/${employeeId}/specialties`, {
      method: 'POST',
      body: JSON.stringify({ specialtyId: Number(values.specialtyId), certifiedOn: todayIso() }),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['employee', employeeId] });
      void client.invalidateQueries({ queryKey: ['employees'] });
      toast('Специальность добавлена');
      onDone();
    },
  });
  if (dictionaries.isPending) return <div className="emp-form-panel"><Loading label="Загружаем справочник специальностей" /></div>;
  if (dictionaries.isError) return <div className="emp-form-panel"><ProblemNotice error={dictionaries.error} onRetry={() => void dictionaries.refetch()} /></div>;
  return (
    <form className="emp-form-panel" onSubmit={form.handleSubmit(values => mutation.mutate(values))} noValidate>
      <div className="form-grid">
        <div className="field field-wide">
          <label htmlFor="add-specialty">Специальность <span>*</span></label>
          <select id="add-specialty" {...form.register('specialtyId')} aria-invalid={!!form.formState.errors.specialtyId} disabled={mutation.isPending || !available.length}>
            <option value="">{available.length ? 'Выберите специальность' : 'Все доступные специальности уже добавлены'}</option>
            {available.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {form.formState.errors.specialtyId && <span className="field-error">{form.formState.errors.specialtyId.message}</span>}
        </div>
      </div>
      <ProblemNotice error={mutation.error} />
      <div className="emp-form-actions">
        <Button variant="ghost" type="button" onClick={onCancel}>Отмена</Button>
        <Button type="submit" disabled={mutation.isPending || !available.length}><Submitting busy={mutation.isPending}>Добавить</Submitting></Button>
      </div>
    </form>
  );
}

const assignmentSchema = z.object({
  organizationId: z.string().min(1, 'Выберите учреждение'),
  startedAt: z.string().min(1, 'Укажите дату начала'),
  endedAt: z.string(),
}).refine(values => !values.endedAt || values.endedAt > values.startedAt, { message: 'Дата окончания должна быть позже даты начала', path: ['endedAt'] });
type AssignmentValues = z.infer<typeof assignmentSchema>;

function AssignmentForm({ employeeId, kind, onDone, onCancel }: { employeeId: number; kind: 'employment' | 'consultation'; onDone: () => void; onCancel: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const organizationsQuery = useQuery({ queryKey: ['organizations', 'options'], queryFn: loadOrganizationOptions });
  const organizations = (organizationsQuery.data ?? []).filter(item => item.isActive);
  const form = useForm<AssignmentValues>({ resolver: zodResolver(assignmentSchema), defaultValues: { organizationId: '', startedAt: todayIso(), endedAt: '' } });
  const path = kind === 'employment' ? 'employments' : 'consultations';
  const mutation = useMutation({
    mutationFn: (values: AssignmentValues) => api<{ id: number }>(`/doctors/${employeeId}/${path}`, {
      method: 'POST',
      body: JSON.stringify({ organizationId: Number(values.organizationId), startedOn: values.startedAt, endedOn: values.endedAt || null }),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['employee', employeeId] });
      void client.invalidateQueries({ queryKey: ['employees'] });
      toast(kind === 'employment' ? 'Трудоустройство добавлено' : 'Консультация назначена');
      onDone();
    },
  });
  const errors = form.formState.errors;
  return (
    <form className="emp-form-panel" onSubmit={form.handleSubmit(values => mutation.mutate(values))} noValidate>
      <div className="form-grid">
        <div className="field field-wide">
          <label htmlFor={`${kind}-organization`}>Учреждение <span>*</span></label>
          <select id={`${kind}-organization`} {...form.register('organizationId')} aria-invalid={!!errors.organizationId} disabled={organizationsQuery.isPending || organizationsQuery.isError || mutation.isPending}>
            <option value="">{organizationsQuery.isPending ? 'Загружаем учреждения…' : 'Выберите учреждение'}</option>
            {organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {errors.organizationId && <span className="field-error">{errors.organizationId.message}</span>}
          {organizationsQuery.isSuccess && !organizations.length && <span className="field-hint">Нет активных учреждений в вашей области доступа.</span>}
        </div>
        <div className="field">
          <label htmlFor={`${kind}-started`}>Начало <span>*</span></label>
          <input id={`${kind}-started`} type="date" {...form.register('startedAt')} aria-invalid={!!errors.startedAt} />
          {errors.startedAt && <span className="field-error">{errors.startedAt.message}</span>}
        </div>
        <div className="field">
          <label htmlFor={`${kind}-ended`}>Окончание</label>
          <input id={`${kind}-ended`} type="date" {...form.register('endedAt')} aria-invalid={!!errors.endedAt} />
          {errors.endedAt ? <span className="field-error">{errors.endedAt.message}</span> : <span className="field-hint">Оставьте пустым, если действует сейчас.</span>}
        </div>
      </div>
      <ProblemNotice error={mutation.error} />
      <ProblemNotice error={organizationsQuery.error} onRetry={() => void organizationsQuery.refetch()} retryLabel="Загрузить учреждения" />
      <div className="emp-form-actions">
        <Button variant="ghost" type="button" onClick={onCancel}>Отмена</Button>
        <Button type="submit" disabled={mutation.isPending || organizationsQuery.isError || !organizations.length}><Submitting busy={mutation.isPending}>Сохранить</Submitting></Button>
      </div>
    </form>
  );
}

function EmployeeCardBody({ card, employeeId, canManage }: { card: EmployeeCard; employeeId: number; canManage: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const [panel, setPanel] = useState<'specialty' | 'employment' | 'consultation' | null>(null);
  const removeSpecialty = useMutation({
    mutationFn: (specialtyId: number) => api<void>(`/doctors/${employeeId}/specialties/${specialtyId}`, { method: 'DELETE' }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['employee', employeeId] });
      void client.invalidateQueries({ queryKey: ['employees'] });
      toast('Специальность удалена');
    },
  });
  const doctor = card.doctor;
  const hiredAt = doctor?.hiredAt ?? card.employments.reduce<string | null>((earliest, employment) => !earliest || employment.startedAt < earliest ? employment.startedAt : earliest, null);
  const togglePanel = (next: 'specialty' | 'employment' | 'consultation') => setPanel(current => current === next ? null : next);
  return (
    <div className="emp-card">
      <div className="emp-card-head">
        <span className="emp-avatar" aria-hidden="true">{initials(fullName(card.employee))}</span>
        <div>
          <strong>{fullName(card.employee)}</strong>
          <span>{card.employee.category} · {card.employee.organizationName || 'Учреждение не указано'}</span>
        </div>
        <Badge status={card.employee.isActive ? 'active' : 'archived'}>{card.employee.isActive ? 'Работает' : 'Неактивен'}</Badge>
      </div>
      <dl className="emp-facts">
        <div><dt><CalendarDays size={14} /> Дата рождения</dt><dd>{date(card.employee.birthDate)}</dd></div>
        <div><dt><Phone size={14} /> Телефон</dt><dd>{card.employee.phone || 'Не указан'}</dd></div>
        <div><dt><Building2 size={14} /> Текущее учреждение</dt><dd>{card.employee.organizationName || 'Не указано'}</dd></div>
        <div><dt><Briefcase size={14} /> Работает с</dt><dd>{hiredAt ? date(hiredAt) : '—'}</dd></div>
      </dl>

      {doctor ? (
        <section className="emp-section" aria-labelledby="employee-specialties-title">
          <div className="emp-section-head">
            <h3 id="employee-specialties-title"><Stethoscope size={14} /> Специальности</h3>
            {canManage && <Button variant="ghost" className="emp-add-button" aria-expanded={panel === 'specialty'} onClick={() => togglePanel('specialty')}><Plus size={13} /> Добавить</Button>}
          </div>
          {doctor.specialties.length ? (
            <div className="emp-chips">
              {doctor.specialties.map(item => (
                <span className="emp-chip" key={item.id}>
                  {item.name}
                  {canManage && (
                    <button type="button" onClick={() => removeSpecialty.mutate(item.id)} disabled={removeSpecialty.isPending && removeSpecialty.variables === item.id} aria-label={`Убрать специальность «${item.name}»`} title="Убрать специальность">
                      <X size={12} aria-hidden="true" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          ) : <p className="emp-muted">Специальности не указаны.</p>}
          <div className="emp-credentials">
            <div><span><GraduationCap size={13} /> Учёная степень</span><strong>{doctor.degree || 'Не указана'}</strong></div>
            <div><span><Award size={13} /> Учёное звание</span><strong>{doctor.title || 'Не указано'}</strong></div>
          </div>
          <ProblemNotice error={removeSpecialty.error} />
          {panel === 'specialty' && <AddSpecialtyForm employeeId={employeeId} existingIds={doctor.specialties.map(item => item.id)} onDone={() => setPanel(null)} onCancel={() => setPanel(null)} />}
        </section>
      ) : (
        <section className="emp-section" aria-labelledby="employee-doctor-title">
          <div className="emp-section-head"><h3 id="employee-doctor-title"><Stethoscope size={14} /> Профессиональные сведения</h3></div>
          <p className="emp-muted">Сотрудник не является врачом: специальности, учёная степень и звание не ведутся.</p>
        </section>
      )}

      <section className="emp-section" aria-labelledby="employee-employments-title">
        <div className="emp-section-head">
          <h3 id="employee-employments-title"><Briefcase size={14} /> Трудоустройства</h3>
          {canManage && doctor && <Button variant="ghost" className="emp-add-button" aria-expanded={panel === 'employment'} onClick={() => togglePanel('employment')}><Plus size={13} /> Добавить</Button>}
        </div>
        {card.employments.length ? (
          <ul className="emp-list">
            {card.employments.map(item => (
              <li key={item.id}>
                <span className="emp-list-icon" aria-hidden="true"><Building2 size={14} /></span>
                <div className="emp-list-main">
                  <strong>{item.organizationName}</strong>
                  <span>{date(item.startedAt)} — {item.endedAt ? date(item.endedAt) : 'по настоящее время'}</span>
                </div>
                <span className="emp-list-tag">{organizationTypeLabel(item.organizationType)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="emp-muted">Записей о трудоустройстве нет.</p>}
        {panel === 'employment' && <AssignmentForm employeeId={employeeId} kind="employment" onDone={() => setPanel(null)} onCancel={() => setPanel(null)} />}
      </section>

      <section className="emp-section" aria-labelledby="employee-consultations-title">
        <div className="emp-section-head">
          <h3 id="employee-consultations-title"><ClipboardList size={14} /> Консультации</h3>
          {canManage && doctor && <Button variant="ghost" className="emp-add-button" aria-expanded={panel === 'consultation'} onClick={() => togglePanel('consultation')}><Plus size={13} /> Назначить</Button>}
        </div>
        {card.consultations.length ? (
          <ul className="emp-list">
            {card.consultations.map(item => (
              <li key={item.id}>
                <span className="emp-list-icon" aria-hidden="true"><ClipboardList size={14} /></span>
                <div className="emp-list-main">
                  <strong>{item.organizationName}</strong>
                  <span>{date(item.startedAt)} — {item.endedAt ? date(item.endedAt) : 'по настоящее время'}</span>
                </div>
                <span className="emp-list-tag">{organizationTypeLabel(item.organizationType)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="emp-muted">Назначений консультаций нет.</p>}
        {panel === 'consultation' && <AssignmentForm employeeId={employeeId} kind="consultation" onDone={() => setPanel(null)} onCancel={() => setPanel(null)} />}
      </section>
    </div>
  );
}

function EmployeeCardDialog({ employeeId, canManage, onClose }: { employeeId: number; canManage: boolean; onClose: () => void }) {
  const query = useQuery({ queryKey: ['employee', employeeId], queryFn: () => api<EmployeeCard>(`/employees/${employeeId}`) });
  const card = query.data;
  return (
    <EntityDialog
      open
      onClose={onClose}
      eyebrow="MEDCORE / Персонал"
      title={card ? fullName(card.employee) : 'Карточка сотрудника'}
      description={card ? `${card.employee.category} · ${card.employee.organizationName || 'Учреждение не указано'}` : 'Сведения о сотруднике, специальностях и назначениях'}
      width={880}
    >
      {query.isPending ? <Loading label="Открываем карточку сотрудника" /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : card ? <EmployeeCardBody card={card} employeeId={employeeId} canManage={canManage} /> : <Empty title="Сотрудник не найден" description="Проверьте доступность карточки для вашей роли." />}
    </EntityDialog>
  );
}

/* ------------------------------------------------------------------ */
/* Список персонала                                                   */
/* ------------------------------------------------------------------ */

export function EmployeesPage() {
  const { user } = useAuth();
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [specialtyId, setSpecialtyId] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<'create' | number | null>(null);
  const canManage = !!user && hasRole(user.roles, ['organization_admin', 'chief_physician', 'deputy_chief_physician']);
  const canViewCard = !!user && hasRole(user.roles, ['organization_admin', 'doctor', 'chief_physician', 'deputy_chief_physician', 'head_of_department']);
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);
  const dictionaries = useQuery({ queryKey: ['dictionaries'], queryFn: () => api<Dictionaries>('/dictionaries') });
  const query = useQuery({
    queryKey: ['employees', 'list', search, specialtyId, page],
    queryFn: async () => {
      const params = new URLSearchParams({ search, page: String(page), pageSize: String(PAGE_SIZE) });
      if (specialtyId) params.set('specialtyId', specialtyId);
      return asPaged(await api<Paged<EmployeeRow> | ItemList<EmployeeRow>>(`/employees?${params}`), page, PAGE_SIZE);
    },
    placeholderData: keepPreviousData,
  });
  const columns = useMemo<ColumnDef<EmployeeRow>[]>(() => {
    const base: ColumnDef<EmployeeRow>[] = [
      {
        accessorKey: 'fullName',
        header: 'Сотрудник',
        cell: ({ row }) => (
          <div className="staff-cell">
            <span className="staff-icon" aria-hidden="true"><Stethoscope size={17} /></span>
            <span className="emp-name"><strong>{row.original.fullName}</strong><small>Сотрудник № {row.original.id}</small></span>
          </div>
        ),
      },
      { accessorKey: 'category', header: 'Категория', cell: ({ row }) => <span className="emp-category">{row.original.category}</span> },
      { accessorKey: 'specialties', header: 'Специальности', cell: ({ row }) => <span className="cell-wrap">{list(row.original.specialties)}</span> },
      { accessorKey: 'organizationName', header: 'Учреждение', cell: ({ row }) => <span className="cell-wrap">{row.original.organizationName || <span className="muted">Не указано</span>}</span> },
      { accessorKey: 'isActive', header: 'Статус', cell: ({ row }) => <Badge status={row.original.isActive ? 'active' : 'archived'}>{row.original.isActive ? 'Работает' : 'Неактивен'}</Badge> },
    ];
    if (canViewCard) {
      base.push({
        id: 'actions',
        header: '',
        cell: ({ row }) => (
          <div className="table-actions">
            <button type="button" className="icon-button" aria-label={`Открыть карточку: ${row.original.fullName}`} title="Открыть карточку" onClick={() => setDialog(row.original.id)}><ArrowUpRight size={17} /></button>
          </div>
        ),
      });
    }
    return base;
  }, [canViewCard]);
  const items = query.data?.items ?? EMPTY_EMPLOYEES;
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
        eyebrow="Кадры / Реестр"
        title="Персонал"
        description="Сотрудники, специальности, трудоустройства и назначения консультаций"
        action={canManage && <Button onClick={() => setDialog('create')}><Plus size={17} /> Добавить сотрудника</Button>}
      />
      <Panel className="employees-panel">
        <div className="table-toolbar table-toolbar-wrap emp-toolbar">
          <div className="search-field">
            <Search size={17} />
            <input aria-label="Поиск сотрудников по ФИО" placeholder="Поиск по ФИО сотрудника" value={searchInput} onChange={event => setSearchInput(event.target.value)} />
          </div>
          <div className="emp-toolbar-right">
            <div className="emp-filter">
              <label htmlFor="employee-specialty-filter">Специальность</label>
              <select
                id="employee-specialty-filter"
                value={specialtyId}
                onChange={event => { setSpecialtyId(event.target.value); setPage(1); }}
                disabled={dictionaries.isPending}
                title={dictionaries.isError ? errorMessage(dictionaries.error) : undefined}
              >
                <option value="">Все</option>
                {dictionaries.data?.specialties.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
            {dictionaries.isError && <span className="emp-filter-error" role="alert">Фильтр по специальности недоступен</span>}
            <span className="table-result-count" aria-live="polite">{query.isFetching ? 'Обновляем…' : `${number(total)} ${plural(total, ['сотрудник', 'сотрудника', 'сотрудников'])}`}</span>
          </div>
        </div>
        <div aria-busy={query.isFetching}>
          {query.isPending ? <Loading label="Загружаем персонал" /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : (
            <>
              <DataTable
                data={items}
                columns={columns}
                emptyTitle={search || specialtyId ? 'Сотрудники не найдены' : 'Сотрудников пока нет'}
                emptyDescription={search || specialtyId ? 'Попробуйте другой поиск или выберите другую специальность.' : 'Добавьте первого сотрудника и укажите его трудоустройство.'}
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
      {dialog === 'create' && (
        <EntityDialog open onClose={() => setDialog(null)} eyebrow="MEDCORE / Персонал" title="Новый сотрудник" description="Карточка сотрудника и первичное трудоустройство" width={820}>
          {dictionaries.isPending ? <Loading label="Загружаем справочники" /> : dictionaries.isError ? <ErrorState error={dictionaries.error} retry={() => void dictionaries.refetch()} /> : <CreateEmployeeForm dictionaries={dictionaries.data} onClose={() => setDialog(null)} />}
        </EntityDialog>
      )}
      {typeof dialog === 'number' && <EmployeeCardDialog employeeId={dialog} canManage={canManage} onClose={() => setDialog(null)} />}
    </>
  );
}
