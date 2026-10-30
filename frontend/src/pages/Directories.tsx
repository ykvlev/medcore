import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { BedDouble, Building2, FlaskConical, Hospital, MapPin, Phone, Search, Stethoscope } from 'lucide-react';
import { api } from '../api';
import { date, list, number } from '../format';
import type { Employee, Hospitalization, ItemList, Laboratory, Organization } from '../types';
import { Badge, DataTable, Empty, ErrorState, Loading, PageHeading, Panel, PanelHeading } from '../components/ui';

function SearchField({ value, onChange, placeholder = 'Поиск' }: { value: string; onChange: (value: string) => void; placeholder?: string }) {
  return <div className="search-field"><Search size={17} /><input value={value} onChange={event => onChange(event.target.value)} placeholder={placeholder} aria-label={placeholder} /></div>;
}
const match = (search: string, values: (string | null | undefined)[]) => values.filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru').trim());

export function OrganizationsPage() {
  const query = useQuery({ queryKey: ['organizations'], queryFn: () => api<ItemList<Organization>>('/organizations') });
  const [search, setSearch] = useState('');
  const [type, setType] = useState('all');
  const items = query.data?.items.filter(item => (type === 'all' || type === item.organizationType) && match(search, [item.name, item.address])) ?? [];
  return <><PageHeading eyebrow="Городская сеть" title="Медицинские организации" description="Больницы и поликлиники вашей рабочей области" /><div className="directory-toolbar"><div className="segmented-control" aria-label="Тип организации">{[{ value: 'all', label: 'Все учреждения' }, { value: 'hospital', label: 'Больницы' }, { value: 'polyclinic', label: 'Поликлиники' }].map(tab => <button key={tab.value} onClick={() => setType(tab.value)} className={type === tab.value ? 'selected' : ''} aria-pressed={type === tab.value}>{tab.label}</button>)}</div><SearchField value={search} onChange={setSearch} placeholder="Название или адрес" /></div>{query.isPending ? <Panel><Loading label="Загружаем организации" /></Panel> : query.isError ? <Panel><ErrorState error={query.error} retry={() => void query.refetch()} /></Panel> : !items.length ? <Panel><Empty title="Организации не найдены" description="Измените поиск или проверьте область доступа вашей учётной записи." /></Panel> : <div className="organization-grid">{items.map((item, index) => <Panel className="organization-card" key={item.id} delay={Math.min(index * 0.025, 0.2)}><div className="organization-card-top"><span className={`organization-icon tone-${item.organizationType === 'hospital' ? 'blue' : 'mint'}`}>{item.organizationType === 'hospital' ? <Hospital size={25} strokeWidth={1.5} /> : <Building2 size={25} strokeWidth={1.5} />}</span><Badge status={item.isActive ? 'active' : 'archived'}>{item.isActive ? 'Действует' : 'Неактивна'}</Badge></div><span className="organization-type">{item.organizationType === 'hospital' ? 'Больница' : 'Поликлиника'}</span><h2>{item.name}</h2><div className="organization-contacts"><div><MapPin size={15} /><span>{item.address || 'Адрес не указан'}</span></div><div><Phone size={14} /><span>{item.phone || 'Телефон не указан'}</span></div></div><div className="organization-card-foot"><span>Учреждение № {item.id}</span><span className="small-status-dot" /></div></Panel>)}</div>}</>;
}

export function EmployeesPage() {
  const query = useQuery({ queryKey: ['employees'], queryFn: () => api<ItemList<Employee>>('/employees') });
  const [search, setSearch] = useState('');
  const items = query.data?.items.filter(item => match(search, [item.fullName, item.category, list(item.specialties), item.organizationName])) ?? [];
  const columns = useMemo<ColumnDef<Employee>[]>(() => [
    { accessorKey: 'fullName', header: 'Сотрудник', cell: ({ row }) => <div className="staff-cell"><span className="staff-icon"><Stethoscope size={17} /></span><strong>{row.original.fullName}</strong></div> },
    { accessorKey: 'category', header: 'Категория', cell: ({ row }) => <span className="cell-wrap">{({ doctor: 'Врач', nurse: 'Медицинская сестра', orderly: 'Санитар', support: 'Обслуживающий персонал' })[row.original.category] || row.original.category}</span> },
    { accessorKey: 'specialties', header: 'Специальность', cell: ({ row }) => <span className="cell-wrap">{list(row.original.specialties)}</span> },
    { accessorKey: 'organizationName', header: 'Место работы', cell: ({ row }) => <span className="cell-wrap">{row.original.organizationName || '—'}</span> },
    { accessorKey: 'isActive', header: 'Статус', cell: ({ row }) => <Badge status={row.original.isActive ? 'active' : 'archived'} /> },
  ], []);
  return <><PageHeading eyebrow="Команда медицинской сети" title="Персонал" description="Врачи, специальности и сведения о трудоустройстве" /><Panel><div className="table-toolbar"><SearchField value={search} onChange={setSearch} placeholder="ФИО, специальность или учреждение" /><span className="table-result-count">{number(items.length)} сотрудников</span></div>{query.isPending ? <Loading label="Загружаем персонал" /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : <DataTable data={items} columns={columns} emptyTitle="Сотрудники не найдены" emptyDescription="Попробуйте другой поиск или проверьте область доступа." />}</Panel></>;
}

export function HospitalizationsPage() {
  const query = useQuery({ queryKey: ['hospitalizations'], queryFn: () => api<ItemList<Hospitalization>>('/hospitalizations') });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('active');
  const items = query.data?.items.filter(item => (status === 'all' || status === item.status) && match(search, [item.patientName, item.hospitalName, item.departmentName, item.doctorName])) ?? [];
  const columns = useMemo<ColumnDef<Hospitalization>[]>(() => [
    { accessorKey: 'patientName', header: 'Пациент', cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.patientName}</strong><span>Госпитализация № {row.original.id}</span></div> },
    { accessorKey: 'hospitalName', header: 'Учреждение / отделение', cell: ({ row }) => <div className="name-with-meta cell-wrap"><strong>{row.original.hospitalName}</strong><span>{row.original.departmentName}</span></div> },
    { accessorKey: 'bedNumber', header: 'Размещение', cell: ({ row }) => row.original.bedNumber ? <span className="bed-location"><BedDouble size={15} />Палата {row.original.wardNumber}, койка {row.original.bedNumber}</span> : <span className="muted">—</span> },
    { accessorKey: 'doctorName', header: 'Лечащий врач', cell: ({ row }) => <span className="cell-wrap">{row.original.doctorName || '—'}</span> },
    { accessorKey: 'admittedAt', header: 'Поступление', cell: ({ row }) => <span className="cell-date">{date(row.original.admittedAt)}</span> },
    { accessorKey: 'status', header: 'Статус', cell: ({ row }) => <Badge status={row.original.status}>{row.original.status === 'active' ? 'На лечении' : undefined}</Badge> },
  ], []);
  return <><PageHeading eyebrow="Стационарная помощь" title="Госпитализации" description="Размещение пациентов и текущее стационарное лечение" /><Panel><div className="table-toolbar table-toolbar-wrap"><div className="segmented-control" aria-label="Статус госпитализации">{[{ value: 'active', label: 'На лечении' }, { value: 'discharged', label: 'Выписаны' }, { value: 'all', label: 'Все' }].map(tab => <button key={tab.value} onClick={() => setStatus(tab.value)} className={status === tab.value ? 'selected' : ''} aria-pressed={status === tab.value}>{tab.label}</button>)}</div><SearchField value={search} onChange={setSearch} placeholder="Пациент, врач или учреждение" /></div>{query.isPending ? <Loading label="Загружаем госпитализации" /> : query.isError ? <ErrorState error={query.error} retry={() => void query.refetch()} /> : <><PanelHeading title={`${number(items.length)} госпитализаций`} /><DataTable data={items} columns={columns} emptyTitle="Госпитализаций не найдено" emptyDescription="В выбранной категории пока нет доступных записей." /></>}</Panel></>;
}

export function LaboratoriesPage() {
  const query = useQuery({ queryKey: ['laboratories'], queryFn: () => api<ItemList<Laboratory>>('/laboratories') });
  const [search, setSearch] = useState('');
  const items = query.data?.items.filter(item => match(search, [item.name, item.address, list(item.profiles)])) ?? [];
  return <><PageHeading eyebrow="Диагностика и исследования" title="Лаборатории" description="Исследовательские профили и действующие договоры" /><div className="directory-toolbar"><span className="directory-count">{number(items.length)} лабораторий</span><SearchField value={search} onChange={setSearch} placeholder="Название или профиль исследования" /></div>{query.isPending ? <Panel><Loading label="Загружаем лаборатории" /></Panel> : query.isError ? <Panel><ErrorState error={query.error} retry={() => void query.refetch()} /></Panel> : !items.length ? <Panel><Empty title="Лаборатории не найдены" description="Измените поиск или проверьте доступные договоры." /></Panel> : <div className="organization-grid">{items.map((item, index) => <Panel className="organization-card laboratory-card" key={item.id} delay={Math.min(index * 0.03, 0.2)}><div className="organization-card-top"><span className="organization-icon tone-purple"><FlaskConical size={25} strokeWidth={1.5} /></span><span className="contract-count">{number(item.activeContracts)} договоров</span></div><span className="organization-type">Лаборатория</span><h2>{item.name}</h2><div className="profile-tags">{(Array.isArray(item.profiles) ? item.profiles : item.profiles?.split(',') || []).map(profile => <span key={profile}>{profile.trim()}</span>)}</div><div className="organization-contacts"><div><MapPin size={15} /><span>{item.address}</span></div><div><Phone size={14} /><span>{item.phone || 'Телефон не указан'}</span></div></div><div className="organization-card-foot"><span>Лаборатория № {item.id}</span><span className="small-status-dot purple" /></div></Panel>)}</div>}</>;
}
