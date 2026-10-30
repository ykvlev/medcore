import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X } from 'lucide-react';
import { api, errorMessage } from '../api';
import { date, fullName } from '../format';
import type { Paged, Patient } from '../types';
import { Button } from './ui';
import { payloadItems } from './medcoreUtils';
import './PatientLookup.css';

/** Поиск пациента по картотеке для форм стационара и лабораторий. */
export function PatientLookup({ patient, onSelect }: { patient: Patient | null; onSelect: (patient: Patient | null) => void }) {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => { const timer = setTimeout(() => setSearch(input.trim()), 300); return () => clearTimeout(timer); }, [input]);
  const query = useQuery({ queryKey: ['patients', 'lookup', search], queryFn: () => api<Paged<Patient>>(`/patients?${new URLSearchParams({ search, page: '1', pageSize: '6' })}`), enabled: search.length > 0 });
  if (patient) return <div className="patient-lookup-selected"><span><strong>{fullName(patient)}</strong><small>Карта № {patient.id} · {date(patient.birthDate)}</small></span><Button type="button" variant="ghost" onClick={() => onSelect(null)}><X size={15} /> Изменить</Button></div>;
  const found = payloadItems(query.data);
  return <div className="patient-lookup"><div className="search-field"><Search size={17} /><input aria-label="Поиск пациента по ФИО" placeholder="Начните вводить фамилию или имя" value={input} onChange={event => setInput(event.target.value)} /></div><p className="field-hint">Поиск по картотеке пациентов, доступной вашей роли.</p>{query.isFetching && <p className="patient-lookup-state" role="status">Ищем пациента…</p>}{query.isError && <p className="field-error" role="alert">{errorMessage(query.error)}</p>}{search && query.isSuccess && !found.length && <p className="patient-lookup-state">Пациенты не найдены.</p>}{found.length > 0 && <ul className="patient-lookup-results">{found.map(item => <li key={item.id}><button type="button" onClick={() => onSelect(item)}><strong>{fullName(item)}</strong><span>Карта № {item.id} · {date(item.birthDate)}</span></button></li>)}</ul>}</div>;
}
