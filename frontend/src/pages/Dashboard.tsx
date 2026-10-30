import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight, BedDouble, Building2, ChartNoAxesCombined, CircleDot, Clock3, Eye, HeartPulse,
  Layers3, LogIn, LogOut, Microscope, Pencil, Plus, ShieldCheck, Stethoscope, Trash2, Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../api';
import { useAuth } from '../auth';
import { date, hasRole, number, percent, roleNames, workspaceScopeLabel } from '../format';
import type { Dashboard } from '../types';
import { Empty, ErrorState, Panel, PanelHeading, SkeletonCards } from '../components/ui';
import { MonthlyChart } from '../components/MonthlyChart';
import { DashboardDock } from '../components/DashboardDock';
import type { DashboardDockAction } from '../components/DashboardDock';
import './Dashboard.css';

type StatTone = 'mint' | 'blue' | 'purple' | 'amber';

const actionLabels: Record<string, string> = {
  insert: 'Создана запись', update: 'Изменена запись', delete: 'Удалена запись', read: 'Просмотр данных',
  login: 'Вход в систему', logout: 'Выход из системы',
  login_success: 'Вход в систему', login_failed: 'Неудачная попытка входа',
};
const actionIcons: Record<string, LucideIcon> = {
  insert: Plus, update: Pencil, delete: Trash2, read: Eye, login: LogIn, logout: LogOut,
};
const entityLabels: Record<string, string> = {
  patients: 'Пациенты', patient: 'Пациенты', users: 'Пользователи', user: 'Пользователи',
  session: 'Авторизация', auth: 'Авторизация',
  hospitalizations: 'Госпитализации', hospitalization: 'Госпитализации',
  lab_orders: 'Направления на исследование', lab_order: 'Направления на исследование',
  lab_results: 'Результаты исследований', lab_result: 'Результаты исследований',
  employees: 'Сотрудники', employee: 'Сотрудники', employment: 'Трудоустройство',
  doctor_specialty: 'Специальности врача', consultation_assignment: 'Консультации',
  organizations: 'Организации', organization: 'Организации',
  buildings: 'Корпуса', building: 'Корпуса', departments: 'Отделения', department: 'Отделения',
  wards: 'Палаты', ward: 'Палаты', beds: 'Койки', bed: 'Койки', referral: 'Направления',
};

function plural(count: number, forms: [string, string, string]) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return forms[0];
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return forms[1];
  return forms[2];
}
function dayPart(hour: number) {
  if (hour < 5) return 'Доброй ночи';
  if (hour < 12) return 'Доброе утро';
  if (hour < 18) return 'Добрый день';
  return 'Добрый вечер';
}
function givenName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts[1] : parts[0] || '';
}

function StatCard({ label, value, subtitle, icon: Icon, color, to, index }: { label: string; value: number | null; subtitle: string; icon: LucideIcon; color: StatTone; to?: string; index: number }) {
  const display = value === null ? '—' : number(value);
  const content = (
    <div className="dash-stat-body">
      <div className="dash-stat-top">
        <span className={`dash-stat-icon dash-tone-${color}`}><Icon size={19} strokeWidth={1.6} aria-hidden="true" /></span>
        {to && <ArrowUpRight size={15} className="dash-stat-arrow" aria-hidden="true" />}
      </div>
      <div className="dash-stat-label">{label}</div>
      <div className="dash-stat-value">{display}</div>
      <div className="dash-stat-subtitle"><span className="dash-dot" aria-hidden="true" />{value === null ? 'Недоступно по вашей роли' : subtitle}</div>
    </div>
  );
  return (
    <Panel className={`dash-card dash-stat ${to ? 'dash-stat-link' : ''}`} delay={index * 0.04}>
      {to ? <Link to={to} className="dash-stat-anchor" aria-label={`${label}: ${display}`}>{content}</Link> : content}
      <span className={`dash-stat-glow dash-glow-${color}`} aria-hidden="true" />
    </Panel>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const query = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/dashboard/summary') });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  if (!user) return null;

  const data = query.data;
  const technicalOnly = user.roles.every(role => role === 'system_admin');
  const aggregateScope = hasRole(user.roles, ['minister_of_health', 'governor']);
  const chiefScope = hasRole(user.roles, ['chief_physician', 'deputy_chief_physician']);
  const departmentScope = hasRole(user.roles, ['head_of_department']);
  const patientAccess = hasRole(user.roles, ['doctor', 'registrar', 'chief_physician', 'deputy_chief_physician']);
  const employeeAccess = hasRole(user.roles, ['organization_admin', 'doctor', 'registrar', 'chief_physician', 'deputy_chief_physician', 'head_of_department']);
  const hospitalAccess = hasRole(user.roles, ['organization_admin', 'doctor', 'registrar', 'chief_physician', 'deputy_chief_physician', 'head_of_department']);
  const reportsAccess = hasRole(user.roles, ['organization_admin', 'analyst', 'chief_physician', 'deputy_chief_physician', 'head_of_department', 'minister_of_health', 'governor']);
  const labAccess = hasRole(user.roles, ['lab_staff', 'organization_admin', 'analyst', 'doctor']);
  const scopeLabel = workspaceScopeLabel(user.roles);
  const scopeName = user.roles.includes('minister_of_health') ? 'города' : 'региона';
  const capacity = data && data.beds !== null && data.occupiedBeds !== null && data.occupancyPercent !== null
    ? { beds: data.beds, occupiedBeds: data.occupiedBeds, occupancyPercent: data.occupancyPercent }
    : null;

  const timeLabel = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(now);
  const weekdayLabel = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(now);
  const monthLabel = new Intl.DateTimeFormat('ru-RU', { month: 'short' }).format(now).replace('.', '').toUpperCase();
  const yearLabel = new Intl.DateTimeFormat('ru-RU', { year: 'numeric' }).format(now);
  const fullDateLabel = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'full' }).format(now);
  const isoDay = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const dockActions: DashboardDockAction[] = [];
  if (patientAccess) dockActions.push({ to: '/patients', label: 'Пациенты', icon: Users });
  if (employeeAccess && (chiefScope || departmentScope)) dockActions.push({ to: '/employees', label: 'Персонал', icon: Stethoscope });
  if (hospitalAccess) dockActions.push({ to: '/hospitalizations', label: 'Стационар', icon: BedDouble });
  if (reportsAccess) dockActions.push({ to: '/reports', label: 'Отчёты', icon: ChartNoAxesCombined });
  if (labAccess) dockActions.push({ to: '/laboratories', label: 'Лаборатории', icon: Microscope });
  dockActions.push({ to: '/organizations', label: 'Организации', icon: Building2 });
  if (technicalOnly) dockActions.push({ to: '/admin', label: 'Администрирование', icon: ShieldCheck });

  const description = technicalOnly
    ? 'Организации и события вашей рабочей области. Медицинские сведения доступны только сотрудникам с соответствующими полномочиями.'
    : aggregateScope
      ? `Сводные показатели ${scopeName} по всем учреждениям. Персональные данные пациентов в сводку не входят.`
      : chiefScope
        ? 'Показатели больницы: пациенты, стационар, загрузка отделений и последние события доступной области.'
        : departmentScope
          ? 'Показатели отделения: сотрудники, занятость коек и последние события доступной области.'
          : patientAccess || hospitalAccess || user.roles.includes('analyst')
            ? 'Сводка по доступным медицинским организациям: пациенты, стационар, загрузка отделений и последние события.'
            : 'Организации, лаборатории и последние события вашей рабочей области.';

  return (
    <div className="dash" aria-busy={query.isPending || query.isFetching}>
      <div className="dash-atmosphere" aria-hidden="true">
        <span className="dash-aurora dash-aurora-a" />
        <span className="dash-aurora dash-aurora-b" />
        <span className="dash-aurora dash-aurora-c" />
        <span className="dash-streaks" />
        <span className="dash-stars" />
        <span className="dash-grid" />
        <span className="dash-grain" />
        <span className="dash-vignette" />
      </div>

      <div className="dash-hero">
        <Panel className="dash-card dash-greeting" delay={0}>
          <div className="dash-greeting-top">
            <span className="dash-eyebrow">{scopeLabel ?? 'Рабочее пространство'}</span>
            <span className="dash-live"><span aria-hidden="true" />Актуальные данные</span>
          </div>
          <h1 className="dash-greeting-title">{dayPart(now.getHours())}, <span>{givenName(user.displayName || user.login)}</span></h1>
          <p className="dash-greeting-text">{description}</p>
          <div className="dash-chips">
            <span className="dash-chip"><ShieldCheck size={13} strokeWidth={1.7} aria-hidden="true" />{user.roles.map(role => roleNames[role]).join(' · ')}</span>
            {aggregateScope && <span className="dash-chip"><Eye size={13} strokeWidth={1.7} aria-hidden="true" />Без персональных данных</span>}
            {user.organizations.length > 0 && <span className="dash-chip"><Building2 size={13} strokeWidth={1.7} aria-hidden="true" />{user.organizations.length} {plural(user.organizations.length, ['организация', 'организации', 'организаций'])}</span>}
          </div>
        </Panel>

        <Panel className="dash-card dash-date" delay={0.06}>
          <div className="dash-date-head">
            <span>{weekdayLabel}</span>
            <time className="dash-date-time" dateTime={now.toISOString()}>{timeLabel}</time>
          </div>
          <time className="dash-date-value" dateTime={isoDay} aria-label={fullDateLabel}>
            <strong className="dash-date-day">{now.getDate()}</strong>
            <span className="dash-date-meta"><span>{monthLabel}</span><span>{yearLabel}</span></span>
          </time>
        </Panel>
      </div>

      {query.isPending ? <SkeletonCards /> : query.isError ? <Panel className="dash-card dash-panel"><ErrorState error={query.error} retry={() => void query.refetch()} /></Panel> : data && <>
        <div className={`dash-kpis ${technicalOnly ? 'dash-kpis-technical' : ''}`}>
          <StatCard index={0} label={aggregateScope ? 'Медорганизации' : chiefScope ? 'Организации больницы' : 'Медорганизации'} value={data.organizations} subtitle={aggregateScope ? `Учреждения ${scopeName}` : chiefScope ? 'Больница и её поликлиники' : 'В вашей области доступа'} icon={Building2} color="mint" to="/organizations" />
          {!technicalOnly && <>
            <StatCard index={1} label={aggregateScope ? 'Активные врачи' : chiefScope ? 'Врачи больницы' : departmentScope ? 'Врачи отделения' : 'Активные врачи'} value={data.activeDoctors} subtitle={aggregateScope ? `Медицинский персонал ${scopeName}` : chiefScope ? 'Медицинский персонал больницы' : 'Медицинский персонал'} icon={Stethoscope} color="blue" to={employeeAccess ? '/employees' : undefined} />
            <StatCard index={2} label={aggregateScope ? 'Пациенты' : chiefScope ? 'Пациенты больницы' : 'Пациенты'} value={data.patients} subtitle={aggregateScope ? `Наблюдаются в учреждениях ${scopeName}` : 'Зарегистрировано в системе'} icon={Users} color="purple" to={patientAccess ? '/patients' : undefined} />
            <StatCard index={3} label="В стационаре" value={data.activeHospitalizations} subtitle={aggregateScope ? `Текущие госпитализации ${scopeName}` : 'Текущие госпитализации'} icon={BedDouble} color="amber" to={hospitalAccess ? '/hospitalizations' : undefined} />
          </>}
          {technicalOnly && (
            <Panel className="dash-card dash-access" delay={0.04}>
              <span className="dash-stat-icon dash-tone-blue"><Layers3 size={20} strokeWidth={1.6} aria-hidden="true" /></span>
              <h2>Доступ по роли</h2>
              <p>{user.roles.map(role => roleNames[role]).join(', ')}</p>
              <small>Медицинские сведения доступны только сотрудникам с соответствующими полномочиями.</small>
            </Panel>
          )}
        </div>

        {!technicalOnly && <div className="dash-split">
          <Panel className="dash-card dash-panel dash-chart-panel" delay={0.12}>
            <PanelHeading title="Динамика обращений" subtitle={aggregateScope ? `Обращения и госпитализации ${scopeName}` : 'Обращения и госпитализации по месяцам'} trailing={<span className="dash-period">{data.monthlyActivity.length ? `${data.monthlyActivity.length} мес.` : 'За период'}</span>} />
            <MonthlyChart data={data.monthlyActivity} />
            {data.monthlyActivity.length > 0 && <div className="chart-legend"><span><i className="legend-blue" aria-hidden="true" />Обращения</span><span><i className="legend-mint" aria-hidden="true" />Госпитализации</span></div>}
          </Panel>
          <Panel className="dash-card dash-panel" delay={0.16}>
            <PanelHeading title="Загрузка отделений" subtitle={aggregateScope ? `Занятость коечного фонда ${scopeName}` : departmentScope ? 'Занятость вашего отделения' : 'Занятость коечного фонда'} trailing={<span className="dash-panel-icon"><BedDouble size={16} strokeWidth={1.6} aria-hidden="true" /></span>} />
            {data.departmentOccupancy.length ? <ul className="dash-departments">
              {data.departmentOccupancy.slice(0, 5).map((department, index) => {
                const value = department.totalBeds ? department.occupiedBeds / department.totalBeds * 100 : 0;
                return <li className="dash-department" key={`${department.name}-${index}`}>
                  <div className="dash-department-head"><span>{department.name}</span><strong>{percent(value)}</strong></div>
                  <div className={`dash-bar ${value >= 90 ? 'dash-bar-alert' : ''}`} aria-hidden="true"><span style={{ width: `${Math.min(value, 100)}%` }} /></div>
                  <p className="dash-department-note">{number(department.occupiedBeds)} из {number(department.totalBeds)} коек занято</p>
                </li>;
              })}
            </ul> : <Empty small title="Нет отделений" description="Данные появятся после настройки стационара." />}
          </Panel>
        </div>}

        <div className={`dash-split ${technicalOnly || !capacity || aggregateScope ? 'dash-split-single' : ''}`}>
          {!aggregateScope && <Panel className="dash-card dash-panel" delay={0.18}>
            <PanelHeading title="Последние события" subtitle="Изменения в доступной рабочей области" trailing={<span className="dash-panel-icon"><Clock3 size={16} strokeWidth={1.6} aria-hidden="true" /></span>} />
            {data.recentEvents.length ? <ul className="dash-events">
              {data.recentEvents.slice(0, 5).map((event, index) => {
                const Icon = actionIcons[event.action] || CircleDot;
                return <li className="dash-event" key={event.id}>
                  <span className={`dash-event-icon dash-event-tone-${index % 3}`}><Icon size={16} strokeWidth={1.7} aria-hidden="true" /></span>
                  <div className="dash-event-body"><strong>{actionLabels[event.action] || event.action}</strong><span>{entityLabels[event.entityType] || event.entityType}</span></div>
                  <time dateTime={event.occurredAt}>{date(event.occurredAt, true)}</time>
                </li>;
              })}
            </ul> : <Empty small title="Событий пока нет" description="Здесь будет отображаться история изменений." />}
          </Panel>}

          {!technicalOnly && capacity && <Panel className="dash-card dash-panel dash-capacity" delay={0.22}>
            <PanelHeading title="Коечный фонд" subtitle={aggregateScope ? `Стационарная сеть ${scopeName}` : 'Доступная стационарная сеть'} trailing={<span className="dash-panel-icon"><HeartPulse size={16} strokeWidth={1.6} aria-hidden="true" /></span>} />
            <div className="dash-capacity-body">
              <div className="dash-ring" style={{ '--dash-ring': `${Math.min(Math.max(capacity.occupancyPercent, 0), 100)}%` } as CSSProperties} role="img" aria-label={`Занятость коечного фонда ${percent(capacity.occupancyPercent)}`}>
                <div><strong>{percent(capacity.occupancyPercent)}</strong><span>занятость</span></div>
              </div>
              <dl className="dash-capacity-stats">
                <div><dt><i className="dash-legend dash-legend-blue" aria-hidden="true" />Занято</dt><dd>{number(capacity.occupiedBeds)}</dd></div>
                <div><dt><i className="dash-legend dash-legend-mint" aria-hidden="true" />Свободно</dt><dd>{number(Math.max(0, capacity.beds - capacity.occupiedBeds))}</dd></div>
                <div className="dash-capacity-total"><dt>Всего коек</dt><dd>{number(capacity.beds)}</dd></div>
              </dl>
            </div>
            <div className="dash-capacity-foot"><HeartPulse size={13} aria-hidden="true" /><span>Показатели рассчитаны по базе данных</span></div>
          </Panel>}
        </div>
      </>}

      <DashboardDock actions={dockActions} />
    </div>
  );
}
