import type { Patient, Role } from './types';

export const number = (value: number) => new Intl.NumberFormat('ru-RU').format(value);
export const percent = (value: number) => `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(value)}%`;
export function date(value: string | null | undefined, withTime = false): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit', month: 'short', year: 'numeric', ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(parsed);
}
export const fullName = (patient: Pick<Patient, 'lastName' | 'firstName' | 'middleName'>) =>
  [patient.lastName, patient.firstName, patient.middleName].filter(Boolean).join(' ');
export const list = (value: string[] | string | null | undefined) => Array.isArray(value) ? value.join(', ') : value || '—';
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]).join('').toUpperCase();
export const roleNames: Record<Role, string> = {
  system_admin: 'Системный администратор', organization_admin: 'Администратор организации',
  doctor: 'Врач', registrar: 'Регистратор', lab_staff: 'Сотрудник лаборатории', analyst: 'Аналитик',
  chief_physician: 'Главный врач', deputy_chief_physician: 'Заместитель главного врача',
  head_of_department: 'Заведующий отделением', minister_of_health: 'Министр здравоохранения',
  governor: 'Губернатор',
};
/** Подпись рабочей области для сводных и руководящих ролей. */
export function workspaceScopeLabel(roles: Role[]): string | null {
  if (roles.includes('minister_of_health')) return 'Сводные данные города';
  if (roles.includes('governor')) return 'Сводные данные региона';
  if (roles.includes('chief_physician') || roles.includes('deputy_chief_physician')) return 'Показатели больницы';
  if (roles.includes('head_of_department')) return 'Показатели отделения';
  return null;
}
export const hasRole = (roles: Role[], allowed: Role[]) => roles.some(role => allowed.includes(role));
export const sexName = (sex: string) => ({ male: 'Мужской', female: 'Женский', unknown: 'Не указан' })[sex] || 'Не указан';
export const monthName = (value: string) => {
  const parsed = new Date(/^\d{4}-\d{2}$/.test(value) ? `${value}-01T12:00:00` : value);
  return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat('ru-RU', { month: 'short' }).format(parsed).replace('.', '');
};
