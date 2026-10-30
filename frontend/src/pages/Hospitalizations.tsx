import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { ArrowRightLeft, BedDouble, ChevronLeft, ChevronRight, ClipboardList, Eye, History, LogOut, Plus, Search, Stethoscope, UserRoundCheck } from 'lucide-react';
import { api, ApiError, errorMessage } from '../api';
import { useAuth } from '../auth';
import { date, hasRole, list, number } from '../format';
import type { EmployeeRow, Hospitalization, HospitalizationDetail, ItemList, Organization, OrganizationCard, Patient, Paged } from '../types';
import { Badge, Button, DataTable, ErrorState, Loading, PageHeading, Panel, Submitting, useToast } from '../components/ui';
import { MedcoreDialog } from '../components/MedcoreDialog';
import { PatientLookup } from '../components/PatientLookup';
import { localDateTimeValue, payloadHasTotal, payloadItems, payloadTotal, toIsoMoment } from '../components/medcoreUtils';
import './Hospitalizations.css';

const PAGE_SIZE = 15;
const statusNames: Record<string, string> = { active: 'На лечении', discharged: 'Выписан', cancelled: 'Отменена' };

interface ActiveCase { id: number; patientName: string; hospitalName: string; departmentName: string }
interface BedOption { id: number; wardNumber: string; bedNumber: string }
type ActionState =
  | { type: 'transfer'; item: ActiveCase }
  | { type: 'attending'; item: ActiveCase }
  | { type: 'discharge'; item: ActiveCase };

function statusName(status: string) {
  return statusNames[status] || status;
}

/** Койки доступны на момент поступления; точная форма ответа контрактом не зафиксирована. */
function availableBeds(payload: unknown): BedOption[] {
  const source: unknown[] = Array.isArray(payload)
    ? payload
    : payload && typeof payload === 'object' && Array.isArray((payload as { items?: unknown[] }).items)
      ? (payload as { items: unknown[] }).items
      : [];
  return source.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const row = entry as Record<string, unknown>;
    const id = typeof row.id === 'number' ? row.id : typeof row.bedId === 'number' ? row.bedId : null;
    if (id === null) return [];
    const wardNumber = typeof row.wardNumber === 'string' ? row.wardNumber : typeof row.wardNumber === 'number' ? String(row.wardNumber) : typeof row.ward === 'string' ? row.ward : typeof row.ward === 'number' ? String(row.ward) : '';
    const bedNumber = typeof row.number === 'string' ? row.number : typeof row.number === 'number' ? String(row.number) : typeof row.bedNumber === 'string' ? row.bedNumber : typeof row.bedNumber === 'number' ? String(row.bedNumber) : String(id);
    return [{ id, wardNumber, bedNumber }];
  });
}

function bedLabel(bed: BedOption) {
  return bed.wardNumber ? `Палата ${bed.wardNumber}, койка ${bed.bedNumber}` : `Койка ${bed.bedNumber}`;
}

function departmentsOf(card: OrganizationCard | undefined) {
  return card?.buildings.flatMap(building => building.departments) ?? [];
}

function admissionErrorText(error: unknown) {
  if (error instanceof ApiError) {
    const detail = error.problem.detail || error.problem.title;
    if (error.status === 409) {
      if (detail && /невозможно/i.test(detail)) return detail;
      return detail ? `Невозможно оформить госпитализацию: ${detail}` : 'Невозможно оформить госпитализацию: свободные койки отсутствуют.';
    }
  }
  return errorMessage(error);
}

function actionErrorText(prefix: string, error: unknown) {
  if (error instanceof ApiError) {
    const detail = error.problem.detail || error.problem.title;
    return detail ? `${prefix}: ${detail}` : `${prefix}. ${error.message}`;
  }
  return errorMessage(error);
}

function activeCaseFromDetail(item: HospitalizationDetail['hospitalization']): ActiveCase {
  return { id: item.id, patientName: item.patientName, hospitalName: item.hospitalName, departmentName: item.departmentName };
}

function Fact({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function DetailDialog({ id, canTreat, onClose, onAction }: { id: number; canTreat: boolean; onClose: () => void; onAction: (action: ActionState) => void }) {
  const query = useQuery({ queryKey: ['hospitalization', id], queryFn: () => api<HospitalizationDetail>(`/hospitalizations/${id}`) });
  const data = query.data;
  const current = data?.hospitalization;
  return <MedcoreDialog open wide onClose={onClose} eyebrow="Стационар / Карточка" title={current ? current.patientName : 'Госпитализация'} description={current ? `${current.hospitalName} · ${current.departmentName}` : 'Загружаем сведения о госпитализации'}>{query.isPending ? <Loading label="Открываем карточку госпитализации" /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : data && current && <>
    <div className="hosp-detail-top"><Badge status={current.status}>{statusName(current.status)}</Badge><span className="hosp-detail-number">Госпитализация № {current.id}</span></div>
    <dl className="hosp-facts">
      <Fact label="Размещение" value={current.bedNumber ? `Палата ${current.wardNumber || '—'}, койка ${current.bedNumber}` : 'Не размещён'} />
      <Fact label="Диагноз" value={current.diagnosis || 'Не указан'} />
      <Fact label="Поступление" value={date(current.admittedAt, true)} />
      <Fact label="Выписка" value={current.dischargedAt ? date(current.dischargedAt, true) : 'Ещё не выписан'} />
    </dl>
    <div className="hosp-detail-grid">
      <section className="hosp-detail-section" aria-labelledby="hosp-placements-title">
        <h3 id="hosp-placements-title"><ClipboardList size={15} /> Размещения</h3>
        {data.placements.length ? <div className="hosp-mini-table-wrap"><table className="hosp-mini-table"><thead><tr><th scope="col">Палата / койка</th><th scope="col">Начало</th><th scope="col">Окончание</th></tr></thead><tbody>{data.placements.map(placement => <tr key={placement.id}><td>Палата {placement.wardNumber}, койка {placement.bedNumber}</td><td>{date(placement.startedAt, true)}</td><td>{placement.endedAt ? date(placement.endedAt, true) : <span className="hosp-current">текущее</span>}</td></tr>)}</tbody></table></div> : <p className="hosp-empty-line">Размещений нет.</p>}
      </section>
      <section className="hosp-detail-section" aria-labelledby="hosp-attending-title">
        <h3 id="hosp-attending-title"><Stethoscope size={15} /> Лечащие врачи</h3>
        {data.attending.length ? <div className="hosp-mini-table-wrap"><table className="hosp-mini-table"><thead><tr><th scope="col">Врач</th><th scope="col">Начало</th><th scope="col">Окончание</th></tr></thead><tbody>{data.attending.map(period => <tr key={period.id}><td>{period.doctorName}</td><td>{date(period.startedAt, true)}</td><td>{period.endedAt ? date(period.endedAt, true) : <span className="hosp-current">текущий</span>}</td></tr>)}</tbody></table></div> : <p className="hosp-empty-line">Назначений врача нет.</p>}
      </section>
    </div>
    <section className="hosp-detail-section" aria-labelledby="hosp-history-title">
      <h3 id="hosp-history-title"><History size={15} /> История</h3>
      {data.history.length ? <ol className="hosp-history">{data.history.map((event, index) => <li key={`${event.type}-${event.id}-${index}`}><span className="hosp-history-time">{date(event.occurredAt, true)}</span><div><strong>{event.title}</strong>{event.description && <p>{event.description}</p>}</div></li>)}</ol> : <p className="hosp-empty-line">Событий пока нет.</p>}
    </section>
    {canTreat && current.status === 'active' && <div className="hosp-detail-actions"><Button variant="secondary" onClick={() => onAction({ type: 'transfer', item: activeCaseFromDetail(current) })}><ArrowRightLeft size={15} /> Перевести</Button><Button variant="secondary" onClick={() => onAction({ type: 'attending', item: activeCaseFromDetail(current) })}><UserRoundCheck size={15} /> Сменить врача</Button><Button variant="secondary" onClick={() => onAction({ type: 'discharge', item: activeCaseFromDetail(current) })}><LogOut size={15} /> Выписать</Button></div>}
  </>}</MedcoreDialog>;
}

function AdmissionForm({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [patient, setPatient] = useState<Patient | null>(null);
  const [hospitalId, setHospitalId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [bedId, setBedId] = useState('');
  const [doctorId, setDoctorId] = useState('');
  const [admittedAt, setAdmittedAt] = useState(localDateTimeValue());
  const [validation, setValidation] = useState<string | null>(null);
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: () => api<ItemList<Organization>>('/organizations') });
  const hospitals = useMemo(() => payloadItems(organizations.data).filter(item => item.organizationType === 'hospital' && item.isActive), [organizations.data]);
  const hospitalCard = useQuery({ queryKey: ['organization', hospitalId], queryFn: () => api<OrganizationCard>(`/organizations/${hospitalId}`), enabled: !!hospitalId });
  const departments = useMemo(() => departmentsOf(hospitalCard.data), [hospitalCard.data]);
  const doctors = useQuery({ queryKey: ['employees', 'hospital', hospitalId], queryFn: () => api<ItemList<EmployeeRow>>(`/employees?${new URLSearchParams({ organizationId: hospitalId, page: '1', pageSize: '100' })}`), enabled: !!hospitalId });
  const doctorOptions = useMemo(() => {
    const all = payloadItems(doctors.data);
    const onlyDoctors = all.filter(item => (item.category || '').toLocaleLowerCase('ru').includes('врач') || item.category === 'doctor');
    return onlyDoctors.length ? onlyDoctors : all;
  }, [doctors.data]);
  const beds = useQuery({ queryKey: ['beds', 'available', departmentId, admittedAt], queryFn: () => api<unknown>(`/beds/available?${new URLSearchParams({ departmentId, at: toIsoMoment(admittedAt) })}`), enabled: !!departmentId && !!admittedAt });
  const bedOptions = useMemo(() => availableBeds(beds.data), [beds.data]);
  const mutation = useMutation({ mutationFn: (input: { patientId: number; hospitalId: number; departmentId: number; bedId: number; attendingDoctorId: number; admittedAt: string }) => api<{ id: number }>('/hospitalizations', { method: 'POST', body: JSON.stringify({ patientId: input.patientId, referralId: null, hospitalId: input.hospitalId, departmentId: input.departmentId, bedId: input.bedId, attendingDoctorId: input.attendingDoctorId, admittedAt: input.admittedAt }) }), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['hospitalizations'] });
    void client.invalidateQueries({ queryKey: ['dashboard'] });
    toast('Госпитализация оформлена');
    onClose();
  } });
  useEffect(() => { setDepartmentId(''); setBedId(''); }, [hospitalId]);
  useEffect(() => { setBedId(''); }, [departmentId]);
  function submit() {
    setValidation(null);
    mutation.reset();
    if (organizations.isPending) return setValidation('Дождитесь загрузки списка больниц.');
    if (hospitalId && hospitalCard.isPending) return setValidation('Дождитесь загрузки отделений.');
    if (hospitalId && doctors.isPending) return setValidation('Дождитесь загрузки списка врачей.');
    if (!patient) return setValidation('Выберите пациента.');
    if (!hospitalId) return setValidation('Выберите больницу.');
    if (!departmentId) return setValidation('Выберите отделение.');
    if (!admittedAt) return setValidation('Укажите дату и время поступления.');
    if (!doctorOptions.length) return setValidation('В выбранной больнице нет доступных врачей.');
    if (!doctorId) return setValidation('Выберите лечащего врача.');
    if (!bedId) return setValidation(beds.isSuccess && !bedOptions.length ? 'Невозможно оформить госпитализацию: свободные койки отсутствуют.' : 'Выберите свободную койку.');
    mutation.mutate({ patientId: patient.id, hospitalId: Number(hospitalId), departmentId: Number(departmentId), bedId: Number(bedId), attendingDoctorId: Number(doctorId), admittedAt: toIsoMoment(admittedAt) });
  }
  const noBeds = !!departmentId && beds.isSuccess && !bedOptions.length;
  return <form className="hosp-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate><fieldset disabled={mutation.isPending}><div className="form-section-label"><Search size={15} /> Пациент</div><PatientLookup patient={patient} onSelect={setPatient} /><div className="form-section-label form-section-next"><BedDouble size={15} /> Место лечения</div><div className="form-grid"><div className="field"><label htmlFor="admit-hospital">Больница <span>*</span></label><select id="admit-hospital" value={hospitalId} onChange={event => setHospitalId(event.target.value)} disabled={organizations.isPending}><option value="">{organizations.isPending ? 'Загружаем…' : 'Выберите больницу'}</option>{hospitals.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{organizations.isError && <span className="field-error">Не удалось загрузить учреждения.</span>}</div><div className="field"><label htmlFor="admit-department">Отделение <span>*</span></label><select id="admit-department" value={departmentId} onChange={event => setDepartmentId(event.target.value)} disabled={!hospitalId || hospitalCard.isPending}><option value="">{hospitalCard.isPending ? 'Загружаем…' : 'Выберите отделение'}</option>{departments.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{hospitalCard.isError && <span className="field-error">Не удалось загрузить отделения.</span>}</div><div className="field"><label htmlFor="admit-doctor">Лечащий врач <span>*</span></label><select id="admit-doctor" value={doctorId} onChange={event => setDoctorId(event.target.value)} disabled={!hospitalId || doctors.isPending}><option value="">{doctors.isPending ? 'Загружаем…' : 'Выберите врача'}</option>{doctorOptions.map(item => { const specialties = list(item.specialties); return <option key={item.id} value={item.id}>{item.fullName}{specialties !== '—' ? ` · ${specialties}` : ''}</option>; })}</select>{doctors.isError && <span className="field-error">Не удалось загрузить врачей.</span>}</div><div className="field"><label htmlFor="admit-at">Дата и время поступления <span>*</span></label><input id="admit-at" type="datetime-local" value={admittedAt} onChange={event => setAdmittedAt(event.target.value)} /></div><div className="field field-wide"><label htmlFor="admit-bed">Свободная койка <span>*</span></label><select id="admit-bed" value={bedId} onChange={event => setBedId(event.target.value)} disabled={!departmentId || beds.isPending}><option value="">{!departmentId ? 'Сначала выберите отделение' : beds.isPending ? 'Проверяем свободные койки…' : bedOptions.length ? 'Выберите койку' : 'Свободных коек нет'}</option>{bedOptions.map(bed => <option key={bed.id} value={bed.id}>{bedLabel(bed)}</option>)}</select>{beds.isError && <span className="field-error">Не удалось проверить свободные койки.</span>}{noBeds && <span className="hosp-bed-warning" role="status">Невозможно оформить госпитализацию: свободные койки отсутствуют.</span>}</div></div></fieldset>{validation && <div className="form-error" role="alert">{validation}</div>}{mutation.isError && <div className="form-error" role="alert">{admissionErrorText(mutation.error)}</div>}<div className="dialog-actions"><span className="form-required">Операция запишется в журнал аудита</span><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button><Button type="submit" disabled={mutation.isPending || noBeds || beds.isFetching}><Submitting busy={mutation.isPending}>Оформить поступление</Submitting></Button></div></form>;
}

function BedSelect({ departmentId, occurredAt, bedId, onChange }: { departmentId: string; occurredAt: string; bedId: string; onChange: (value: string) => void }) {
  const beds = useQuery({ queryKey: ['beds', 'available', departmentId, occurredAt], queryFn: () => api<unknown>(`/beds/available?${new URLSearchParams({ departmentId, at: toIsoMoment(occurredAt) })}`), enabled: !!departmentId && !!occurredAt });
  const options = useMemo(() => availableBeds(beds.data), [beds.data]);
  return <div className="field field-wide"><label htmlFor="move-bed">Свободная койка <span>*</span></label><select id="move-bed" value={bedId} onChange={event => onChange(event.target.value)} disabled={!departmentId || beds.isPending}><option value="">{!departmentId ? 'Сначала выберите отделение' : beds.isPending ? 'Проверяем свободные койки…' : options.length ? 'Выберите койку' : 'Свободных коек нет'}</option>{options.map(bed => <option key={bed.id} value={bed.id}>{bedLabel(bed)}</option>)}</select>{beds.isError && <span className="field-error">Не удалось проверить свободные койки.</span>}{!!departmentId && beds.isSuccess && !options.length && <span className="hosp-bed-warning" role="status">Свободные койки отсутствуют — операция невозможна.</span>}</div>;
}

function TransferForm({ item, onClose }: { item: ActiveCase; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: () => api<ItemList<Organization>>('/organizations') });
  const hospitals = useMemo(() => payloadItems(organizations.data).filter(org => org.organizationType === 'hospital' && org.isActive), [organizations.data]);
  const [hospitalId, setHospitalId] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [bedId, setBedId] = useState('');
  const [occurredAt, setOccurredAt] = useState(localDateTimeValue());
  const [validation, setValidation] = useState<string | null>(null);
  useEffect(() => {
    if (hospitalId) return;
    const match = hospitals.find(org => org.name === item.hospitalName);
    if (match) setHospitalId(String(match.id));
  }, [hospitals, hospitalId, item.hospitalName]);
  const card = useQuery({ queryKey: ['organization', hospitalId], queryFn: () => api<OrganizationCard>(`/organizations/${hospitalId}`), enabled: !!hospitalId });
  const departments = useMemo(() => departmentsOf(card.data), [card.data]);
  useEffect(() => {
    if (!departments.length || departmentId) return;
    const match = departments.find(department => department.name === item.departmentName);
    setDepartmentId(match ? String(match.id) : String(departments[0].id));
  }, [departments, departmentId, item.departmentName]);
  const mutation = useMutation({ mutationFn: () => api<void>(`/hospitalizations/${item.id}/transfer`, { method: 'PUT', body: JSON.stringify({ bedId: Number(bedId), occurredAt: toIsoMoment(occurredAt) }) }), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['hospitalizations'] });
    void client.invalidateQueries({ queryKey: ['hospitalization', item.id] });
    void client.invalidateQueries({ queryKey: ['dashboard'] });
    toast('Пациент переведён');
    onClose();
  } });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!bedId) return setValidation('Выберите свободную койку.');
    if (!occurredAt) return setValidation('Укажите дату и время перевода.');
    mutation.mutate();
  }
  return <form className="hosp-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate><fieldset disabled={mutation.isPending}><div className="hosp-transfer-person"><strong>{item.patientName}</strong><span>{item.hospitalName} · {item.departmentName}</span></div><div className="form-grid"><div className="field"><label htmlFor="transfer-hospital">Больница</label><select id="transfer-hospital" value={hospitalId} onChange={event => { setHospitalId(event.target.value); setDepartmentId(''); setBedId(''); }} disabled={organizations.isPending}><option value="">{organizations.isPending ? 'Загружаем…' : 'Выберите больницу'}</option>{hospitals.map(org => <option key={org.id} value={org.id}>{org.name}</option>)}</select>{organizations.isError && <span className="field-error">Не удалось загрузить учреждения.</span>}</div><div className="field"><label htmlFor="transfer-department">Отделение <span>*</span></label><select id="transfer-department" value={departmentId} onChange={event => { setDepartmentId(event.target.value); setBedId(''); }} disabled={!hospitalId || card.isPending}><option value="">{card.isPending ? 'Загружаем…' : 'Выберите отделение'}</option>{departments.map(department => <option key={department.id} value={department.id}>{department.name}</option>)}</select>{card.isError && <span className="field-error">Не удалось загрузить отделения.</span>}</div><div className="field"><label htmlFor="transfer-at">Дата и время перевода <span>*</span></label><input id="transfer-at" type="datetime-local" value={occurredAt} onChange={event => setOccurredAt(event.target.value)} /></div></div><BedSelect departmentId={departmentId} occurredAt={occurredAt} bedId={bedId} onChange={setBedId} /></fieldset>{validation && <div className="form-error" role="alert">{validation}</div>}{mutation.isError && <div className="form-error" role="alert">{actionErrorText('Не удалось перевести пациента', mutation.error)}</div>}<div className="dialog-actions"><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button><Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Перевести</Submitting></Button></div></form>;
}

function AttendingForm({ item, onClose }: { item: ActiveCase; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [doctorId, setDoctorId] = useState('');
  const [occurredAt, setOccurredAt] = useState(localDateTimeValue());
  const [validation, setValidation] = useState<string | null>(null);
  const organizations = useQuery({ queryKey: ['organizations'], queryFn: () => api<ItemList<Organization>>('/organizations') });
  const hospitalId = useMemo(() => payloadItems(organizations.data).find(org => org.name === item.hospitalName)?.id, [organizations.data, item.hospitalName]);
  const employeeParams = new URLSearchParams({ page: '1', pageSize: '100' });
  if (hospitalId) employeeParams.set('organizationId', String(hospitalId));
  const employees = useQuery({ queryKey: ['employees', 'attending', hospitalId ?? 'all'], queryFn: () => api<ItemList<EmployeeRow>>(`/employees?${employeeParams}`) });
  const doctors = useMemo(() => {
    const all = payloadItems(employees.data);
    const onlyDoctors = all.filter(employee => (employee.category || '').toLocaleLowerCase('ru').includes('врач') || employee.category === 'doctor');
    return onlyDoctors.length ? onlyDoctors : all;
  }, [employees.data]);
  const mutation = useMutation({ mutationFn: () => api<void>(`/hospitalizations/${item.id}/attending`, { method: 'PUT', body: JSON.stringify({ doctorId: Number(doctorId), occurredAt: toIsoMoment(occurredAt) }) }), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['hospitalizations'] });
    void client.invalidateQueries({ queryKey: ['hospitalization', item.id] });
    toast('Лечащий врач изменён');
    onClose();
  } });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!doctorId) return setValidation('Выберите врача.');
    if (!occurredAt) return setValidation('Укажите дату и время назначения.');
    mutation.mutate();
  }
  return <form className="hosp-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate><fieldset disabled={mutation.isPending}><div className="hosp-transfer-person"><strong>{item.patientName}</strong><span>{item.hospitalName} · {item.departmentName}</span></div><div className="form-grid"><div className="field field-wide"><label htmlFor="attending-doctor">Новый лечащий врач <span>*</span></label><select id="attending-doctor" value={doctorId} onChange={event => setDoctorId(event.target.value)} disabled={employees.isPending}><option value="">{employees.isPending ? 'Загружаем…' : 'Выберите врача'}</option>{doctors.map(doctor => <option key={doctor.id} value={doctor.id}>{doctor.fullName}{doctor.organizationName ? ` · ${doctor.organizationName}` : ''}</option>)}</select>{employees.isError && <span className="field-error">Не удалось загрузить врачей.</span>}{organizations.isError && <span className="field-hint">Не удалось определить учреждение — показаны все доступные врачи.</span>}</div><div className="field field-wide"><label htmlFor="attending-at">Дата и время назначения <span>*</span></label><input id="attending-at" type="datetime-local" value={occurredAt} onChange={event => setOccurredAt(event.target.value)} /></div></div></fieldset>{validation && <div className="form-error" role="alert">{validation}</div>}{mutation.isError && <div className="form-error" role="alert">{actionErrorText('Не удалось сменить лечащего врача', mutation.error)}</div>}<div className="dialog-actions"><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button><Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Назначить врача</Submitting></Button></div></form>;
}

function DischargeForm({ item, onClose }: { item: ActiveCase; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [dischargedAt, setDischargedAt] = useState(localDateTimeValue());
  const [validation, setValidation] = useState<string | null>(null);
  const mutation = useMutation({ mutationFn: () => api<void>(`/hospitalizations/${item.id}/discharge`, { method: 'POST', body: JSON.stringify({ dischargedAt: toIsoMoment(dischargedAt) }) }), onSuccess: () => {
    void client.invalidateQueries({ queryKey: ['hospitalizations'] });
    void client.invalidateQueries({ queryKey: ['hospitalization', item.id] });
    void client.invalidateQueries({ queryKey: ['dashboard'] });
    toast('Пациент выписан');
    onClose();
  } });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!dischargedAt) return setValidation('Укажите дату и время выписки.');
    mutation.mutate();
  }
  return <form className="hosp-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate><fieldset disabled={mutation.isPending}><div className="hosp-discharge-note"><LogOut size={18} /><div><strong>{item.patientName}</strong><p>Выписка закроет текущее размещение и назначение лечащего врача. Госпитализация № {item.id}.</p></div></div><div className="field"><label htmlFor="discharge-at">Дата и время выписки <span>*</span></label><input id="discharge-at" type="datetime-local" value={dischargedAt} onChange={event => setDischargedAt(event.target.value)} /></div></fieldset>{validation && <div className="form-error" role="alert">{validation}</div>}{mutation.isError && <div className="form-error" role="alert">{actionErrorText('Не удалось выписать пациента', mutation.error)}</div>}<div className="dialog-actions"><Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button><Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Выписать</Submitting></Button></div></form>;
}

export function HospitalizationsPage() {
  const { user } = useAuth();
  const [filter, setFilter] = useState<'active' | 'discharged' | 'all'>('active');
  const [page, setPage] = useState(1);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [action, setAction] = useState<ActionState | { type: 'admit' } | null>(null);
  const canTreat = !!user && hasRole(user.roles, ['doctor']);
  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (filter !== 'all') params.set('status', filter);
  const query = useQuery({ queryKey: ['hospitalizations', filter, page], queryFn: () => api<Paged<Hospitalization>>(`/hospitalizations?${params}`), placeholderData: keepPreviousData });
  const items = payloadItems(query.data);
  const total = payloadTotal(query.data);
  const pages = payloadHasTotal(query.data) ? Math.max(1, Math.ceil(total / PAGE_SIZE)) : 1;
  const columns = useMemo<ColumnDef<Hospitalization>[]>(() => [
    { accessorKey: 'patientName', header: 'Пациент', cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.patientName}</strong><span>Госпитализация № {row.original.id}</span></div> },
    { accessorKey: 'hospitalName', header: 'Учреждение / отделение', cell: ({ row }) => <div className="name-with-meta cell-wrap"><strong>{row.original.hospitalName}</strong><span>{row.original.departmentName}</span></div> },
    { accessorKey: 'bedNumber', header: 'Размещение', cell: ({ row }) => row.original.bedNumber ? <span className="bed-location"><BedDouble size={15} /> Палата {row.original.wardNumber || '—'}, койка {row.original.bedNumber}</span> : <span className="muted">Не размещён</span> },
    { accessorKey: 'doctorName', header: 'Лечащий врач', cell: ({ row }) => <span className="cell-wrap">{row.original.doctorName || '—'}</span> },
    { accessorKey: 'admittedAt', header: 'Поступление', cell: ({ row }) => <span className="cell-date">{date(row.original.admittedAt, true)}</span> },
    { accessorKey: 'status', header: 'Статус', cell: ({ row }) => <Badge status={row.original.status}>{statusName(row.original.status)}</Badge> },
    { id: 'actions', header: '', cell: ({ row }) => <div className="table-actions"><button className="icon-button" type="button" aria-label={`Открыть карточку: ${row.original.patientName}`} title="Открыть карточку" onClick={() => setDetailId(row.original.id)}><Eye size={17} /></button></div> },
  ], []);
  function applyFilter(next: 'active' | 'discharged' | 'all') {
    setFilter(next);
    setPage(1);
  }
  function openAction(next: ActionState) {
    setDetailId(null);
    setAction(next);
  }
  return <>
    <PageHeading eyebrow="Стационар / Госпитализации" title="Госпитализации" description="Поступление, размещение, перевод и выписка пациентов" action={canTreat && <Button onClick={() => setAction({ type: 'admit' })}><Plus size={17} /> Оформить поступление</Button>} />
    <Panel className="hosp-panel">
      <div className="table-toolbar table-toolbar-wrap"><div className="segmented-control" aria-label="Статус госпитализации">{([{ value: 'active', label: 'На лечении' }, { value: 'discharged', label: 'Выписанные' }, { value: 'all', label: 'Все' }] as const).map(tab => <button key={tab.value} type="button" onClick={() => applyFilter(tab.value)} className={filter === tab.value ? 'selected' : ''} aria-pressed={filter === tab.value}>{tab.label}</button>)}</div><span className="table-result-count">{query.isFetching ? 'Обновляем…' : `${number(total)} записей`}</span></div>
      {query.isPending ? <Loading label="Загружаем госпитализации" /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : <>
        <DataTable data={items} columns={columns} emptyTitle={filter === 'active' ? 'На лечении никого нет' : 'Госпитализаций не найдено'} emptyDescription={filter === 'active' ? 'Оформите поступление или выберите другой статус.' : 'В выбранной категории пока нет записей.'} />
        {pages > 1 && <div className="table-pagination"><span>{total ? `${number((page - 1) * PAGE_SIZE + 1)}–${number(Math.min(page * PAGE_SIZE, total))} из ${number(total)}` : 'Нет записей'}</span><div><Button variant="ghost" aria-label="Предыдущая страница" disabled={page <= 1 || query.isFetching} onClick={() => setPage(previous => previous - 1)}><ChevronLeft size={17} /></Button><span className="page-number">{page} / {pages}</span><Button variant="ghost" aria-label="Следующая страница" disabled={page >= pages || query.isFetching} onClick={() => setPage(previous => previous + 1)}><ChevronRight size={17} /></Button></div></div>}
      </>}
    </Panel>
    {detailId !== null && <DetailDialog id={detailId} canTreat={canTreat} onClose={() => setDetailId(null)} onAction={openAction} />}
    {action?.type === 'admit' && <MedcoreDialog open wide onClose={() => setAction(null)} eyebrow="Стационар / Поступление" title="Новая госпитализация" description="Заполните сведения о пациенте, месте лечения и свободной койке"><AdmissionForm onClose={() => setAction(null)} /></MedcoreDialog>}
    {action?.type === 'transfer' && <MedcoreDialog open onClose={() => setAction(null)} eyebrow="Стационар / Перевод" title="Перевод пациента" description={`${action.item.patientName} · ${action.item.hospitalName}`}><TransferForm item={action.item} onClose={() => setAction(null)} /></MedcoreDialog>}
    {action?.type === 'attending' && <MedcoreDialog open onClose={() => setAction(null)} eyebrow="Стационар / Лечащий врач" title="Смена лечащего врача" description={`${action.item.patientName} · ${action.item.hospitalName}`}><AttendingForm item={action.item} onClose={() => setAction(null)} /></MedcoreDialog>}
    {action?.type === 'discharge' && <MedcoreDialog open onClose={() => setAction(null)} eyebrow="Стационар / Выписка" title="Выписка пациента" description={`Госпитализация № ${action.item.id}`}><DischargeForm item={action.item} onClose={() => setAction(null)} /></MedcoreDialog>}
  </>;
}
