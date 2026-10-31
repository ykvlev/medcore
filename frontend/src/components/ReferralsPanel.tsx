import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Plus, Stethoscope } from 'lucide-react';
import { api, createReferral, errorMessage, listPatientReferrals } from '../api';
import { useAuth } from '../auth';
import { date, hasRole, list } from '../format';
import type { Dictionaries, EmployeeRow, ItemList, Organization, PatientCase, ReferralRow, ReferralType } from '../types';
import { Badge, Button, DataTable, Empty, ErrorState, Loading, Panel, PanelHeading, Submitting, useToast } from './ui';
import { MedcoreDialog } from './MedcoreDialog';
import { payloadItems } from './medcoreUtils';
import './ReferralsPanel.css';

const typeNames: Record<ReferralType, string> = {
  hospitalization: 'Госпитализация',
  consultation: 'Консультация',
  diagnostic: 'Диагностика',
};
const statusNames: Record<string, string> = {
  issued: 'Выдано',
  used: 'Использовано',
  cancelled: 'Отменено',
  scheduled: 'Запланировано',
  completed: 'Завершено',
};
const statusLabel = (status: string) => statusNames[status] || status;

function ReferralForm({ patientId, onClose }: { patientId: number; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [type, setType] = useState<ReferralType>('hospitalization');
  const [hospitalId, setHospitalId] = useState('');
  const [specializationId, setSpecializationId] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [reason, setReason] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: () => api<ItemList<Organization>>('/organizations') });
  const dictionaries = useQuery({ queryKey: ['dictionaries'], queryFn: () => api<Dictionaries>('/dictionaries') });
  const cases = useQuery({
    queryKey: ['patient-cases', patientId],
    queryFn: () => api<{ items: PatientCase[] }>(`/patients/${patientId}/cases`),
    retry: false,
  });
  const employees = useQuery({
    queryKey: ['employees', 'referral', hospitalId],
    queryFn: () => api<ItemList<EmployeeRow>>(`/employees?${new URLSearchParams({ organizationId: hospitalId, page: '1', pageSize: '100' })}`),
    enabled: !!hospitalId,
  });
  const hospitals = useMemo(() => payloadItems(organizations.data).filter(item => item.organizationType === 'hospital' && item.isActive), [organizations.data]);
  const specializations = dictionaries.data?.specializations ?? [];
  const doctorOptions = useMemo(() => {
    const all = payloadItems(employees.data);
    return all.filter(item => (item.category || '').toLocaleLowerCase('ru').includes('врач') || item.category === 'doctor');
  }, [employees.data]);
  const openCase = useMemo(() => payloadItems(cases.data).find(item => item.status === 'open') ?? null, [cases.data]);
  const mutation = useMutation({
    mutationFn: () => createReferral({
      patientId,
      caseId: openCase?.id ?? null,
      type,
      hospitalId: Number(hospitalId),
      specializationId: Number(specializationId),
      doctorId: doctorId ? Number(doctorId) : null,
      validUntil: validUntil || null,
      reason: reason.trim(),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['referrals', patientId] });
      toast('Направление выдано');
      onClose();
    },
  });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (cases.isPending) return setValidation('Дождитесь загрузки случая лечения.');
    if (!hospitalId) return setValidation('Выберите больницу назначения.');
    if (!specializationId) return setValidation('Выберите специализацию.');
    if (!validUntil) return setValidation('Укажите срок действия направления.');
    if (!reason.trim()) return setValidation('Опишите причину направления.');
    mutation.mutate();
  }
  return <form className="referral-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="form-section-label"><Stethoscope size={15} /> Направление к специалисту</div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="referral-type">Тип направления <span>*</span></label>
          <select id="referral-type" value={type} onChange={event => setType(event.target.value as ReferralType)}>
            <option value="hospitalization">Госпитализация</option>
            <option value="consultation">Консультация</option>
            <option value="diagnostic">Диагностика</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="referral-hospital">Больница <span>*</span></label>
          <select id="referral-hospital" value={hospitalId} onChange={event => { setHospitalId(event.target.value); setDoctorId(''); }} disabled={organizations.isPending}>
            <option value="">{organizations.isPending ? 'Загружаем…' : 'Выберите больницу'}</option>
            {hospitals.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {organizations.isError && <span className="field-error">Не удалось загрузить учреждения.</span>}
        </div>
        <div className="field">
          <label htmlFor="referral-specialization">Специализация <span>*</span></label>
          <select id="referral-specialization" value={specializationId} onChange={event => setSpecializationId(event.target.value)} disabled={dictionaries.isPending}>
            <option value="">{dictionaries.isPending ? 'Загружаем…' : 'Выберите специализацию'}</option>
            {specializations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          {dictionaries.isError && <span className="field-error">Не удалось загрузить справочник специализаций.</span>}
        </div>
        <div className="field">
          <label htmlFor="referral-doctor">Врач</label>
          <select id="referral-doctor" value={doctorId} onChange={event => setDoctorId(event.target.value)} disabled={!hospitalId || employees.isPending}>
            <option value="">{!hospitalId ? 'Сначала выберите больницу' : employees.isPending ? 'Загружаем…' : 'Любой специалист'}</option>
            {doctorOptions.map(item => <option key={item.id} value={item.id}>{item.fullName}{list(item.specialties) !== '—' ? ` · ${list(item.specialties)}` : ''}</option>)}
          </select>
          <span className="field-hint">Необязательно: конкретный врач больницы назначения.</span>
          {employees.isError && <span className="field-error">Не удалось загрузить врачей выбранной больницы.</span>}
        </div>
        <div className="field">
          <label htmlFor="referral-valid-until">Срок действия <span>*</span></label>
          <input id="referral-valid-until" type="date" value={validUntil} onChange={event => setValidUntil(event.target.value)} />
        </div>
        <div className="field field-wide">
          <label htmlFor="referral-reason">Причина направления <span>*</span></label>
          <textarea id="referral-reason" rows={3} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} placeholder="Краткое обоснование и цель направления" />
          <span className="field-hint">Не более 2000 символов. Направление оформляется в рамках открытого случая лечения пациента.</span>
        </div>
      </div>
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось выдать направление: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions">
      <span className="form-required">Врач определяется по текущей сессии</span>
      <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
      <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Выдать направление</Submitting></Button>
    </div>
  </form>;
}

export function ReferralsPanel({ patientId }: { patientId: number }) {
  const { user } = useAuth();
  const [issuing, setIssuing] = useState(false);
  const canIssue = !!user && hasRole(user.roles, ['doctor']);
  const query = useQuery({ queryKey: ['referrals', patientId], queryFn: () => listPatientReferrals(patientId) });
  const items = query.data ?? [];
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const columns = useMemo<ColumnDef<ReferralRow>[]>(() => [
    { accessorKey: 'issuedAt', header: 'Дата', cell: ({ row }) => <span className="cell-date">{date(row.original.issuedAt)}</span> },
    { id: 'type', header: 'Тип', cell: ({ row }) => <span className={`referral-type referral-type-${row.original.type}`}>{typeNames[row.original.type]}</span> },
    { accessorKey: 'hospitalName', header: 'Больница', cell: ({ row }) => <span className="cell-wrap">{row.original.hospitalName || '—'}</span> },
    { accessorKey: 'specializationName', header: 'Специализация', cell: ({ row }) => <span className="cell-wrap">{row.original.specializationName || '—'}</span> },
    { accessorKey: 'doctorName', header: 'Врач', cell: ({ row }) => row.original.doctorName ? <span className="cell-wrap">{row.original.doctorName}</span> : <span className="muted">Не указан</span> },
    { accessorKey: 'status', header: 'Статус', cell: ({ row }) => <Badge status={row.original.status}>{statusLabel(row.original.status)}</Badge> },
    { accessorKey: 'validUntil', header: 'Срок действия', cell: ({ row }) => {
      const expired = !!row.original.validUntil && row.original.validUntil.slice(0, 10) < today && row.original.status === 'issued';
      return <span className={expired ? 'referral-expired' : 'cell-date'}>{row.original.validUntil ? date(row.original.validUntil) : '—'}{expired ? ' · истёк' : ''}</span>;
    } },
  ], [today]);
  return <Panel className="patient-referrals-panel">
    <PanelHeading title="Направления" subtitle="Направления пациента к специалистам, на диагностику и госпитализацию" trailing={canIssue && <Button variant="secondary" onClick={() => setIssuing(true)}><Plus size={15} /> Выдать направление</Button>} />
    {query.isPending
      ? <Loading label="Загружаем направления" />
      : query.isError
        ? <ErrorState error={query.error} retry={() => void query.refetch()} />
        : !items.length
          ? <Empty small title="Направлений пока нет" description={canIssue ? 'Выдайте первое направление пациенту — оно появится в этом списке.' : 'Врач оформит направление во время приёма.'} />
          : <DataTable data={items} columns={columns} emptyTitle="Направлений пока нет" emptyDescription="В выбранной карточке ещё не оформлялись направления." />}
    {issuing && <MedcoreDialog open onClose={() => setIssuing(false)} title="Новое направление" description="Больница, специализация и срок действия направления" eyebrow="Пациенты / Направления">
      <ReferralForm patientId={patientId} onClose={() => setIssuing(false)} />
    </MedcoreDialog>}
  </Panel>;
}
