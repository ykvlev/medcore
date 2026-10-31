import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { Activity, Ambulance, Boxes, Building2, CalendarDays, ChartNoAxesCombined, ChevronDown, HeartPulse, LayoutDashboard, LogOut, Microscope, ShieldCheck, Stethoscope, Users, BedDouble } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useAuth } from '../auth';
import { errorMessage } from '../api';
import { hasRole, initials, roleNames, workspaceScopeLabel } from '../format';
import type { Role } from '../types';
import { useToast } from './ui';

const everyone: Role[] = ['system_admin', 'organization_admin', 'doctor', 'registrar', 'lab_staff', 'analyst', 'chief_physician', 'deputy_chief_physician', 'head_of_department', 'minister_of_health', 'governor'];
const navigation = [
  { to: '/dashboard', label: 'Обзор', icon: LayoutDashboard, roles: everyone },
  { to: '/organizations', label: 'Организации', icon: Building2, roles: everyone },
  { to: '/employees', label: 'Персонал', icon: Stethoscope, roles: ['organization_admin', 'doctor', 'registrar', 'chief_physician', 'deputy_chief_physician', 'head_of_department'] as Role[] },
  { to: '/patients', label: 'Пациенты', icon: Users, roles: ['doctor', 'registrar', 'chief_physician', 'deputy_chief_physician'] as Role[] },
  { to: '/hospitalizations', label: 'Стационар', icon: BedDouble, roles: ['organization_admin', 'doctor', 'registrar', 'chief_physician', 'deputy_chief_physician', 'head_of_department'] as Role[] },
  { to: '/supplies', label: 'Снабжение', icon: Boxes, roles: ['organization_admin', 'chief_physician', 'deputy_chief_physician', 'head_of_department'] as Role[] },
  { to: '/transports', label: 'Транспортировка', icon: Ambulance, roles: ['registrar', 'doctor', 'organization_admin', 'chief_physician', 'deputy_chief_physician', 'head_of_department'] as Role[] },
  { to: '/laboratories', label: 'Лаборатории', icon: Microscope, roles: ['lab_staff', 'organization_admin', 'analyst', 'doctor'] as Role[] },
  { to: '/reports', label: 'Отчёты', icon: ChartNoAxesCombined, roles: ['organization_admin', 'analyst', 'chief_physician', 'deputy_chief_physician', 'head_of_department', 'minister_of_health', 'governor'] as Role[] },
  { to: '/admin', label: 'Администрирование', icon: ShieldCheck, roles: ['system_admin'] as Role[] },
];

export function Scene() {
  return <div className="ambient-scene" aria-hidden="true"><div className="scene-grid" /><div className="ambient-orb orb-mint" /><div className="ambient-orb orb-blue" /><div className="ambient-orb orb-purple" /><div className="scene-plane" /><div className="scene-grain" /></div>;
}
export function Layout() {
  const { user, logout, loggingOut } = useAuth();
  const location = useLocation();
  const toast = useToast();
  if (!user) return null;
  const current = navigation.find(item => location.pathname.startsWith(item.to));
  const scopeLabel = workspaceScopeLabel(user.roles);
  async function handleLogout() {
    try { await logout(); } catch (error) { toast(errorMessage(error), 'error'); }
  }
  return <div className="app-shell"><Scene /><a className="skip-link" href="#main-content">Перейти к содержимому</a>
    <aside className="sidebar" aria-label="Главная навигация"><NavLink className="brand-mark" to="/dashboard" aria-label="MEDCORE — обзор"><HeartPulse size={29} strokeWidth={1.7} /></NavLink><span className="sidebar-divider" /><nav>{navigation.filter(item => hasRole(user.roles, item.roles)).map(item => <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`} title={item.label}><item.icon size={21} strokeWidth={1.65} /><span>{item.label}</span></NavLink>)}</nav><div className="sidebar-bottom"><span className="workspace-icon" title="Учебная медицинская система"><ShieldCheck size={19} /></span><button className="nav-item logout" onClick={() => void handleLogout()} disabled={loggingOut} title="Выйти из системы"><LogOut size={20} /><span>Выйти</span></button></div></aside>
    <div className="workspace"><header className="topbar"><div className="brand-wordmark">MED<span>CORE</span><span className="brand-separator" /><span className="workspace-label" title={scopeLabel ?? 'Медицинская сеть города'}>{scopeLabel ?? 'Медицинская сеть города'}</span></div><div className="topbar-right"><div className="today"><CalendarDays size={15} /><span>{new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' }).format(new Date())}</span></div><span className="topbar-divider" /><div className="user-identity"><span className="user-avatar">{initials(user.displayName || user.login)}</span><div><strong>{user.displayName || user.login}</strong><span>{user.roles.map(role => roleNames[role]).join(' · ')}</span></div><ChevronDown size={14} className="identity-chevron" /></div></div></header>
      <main id="main-content" className="main-content" tabIndex={-1}><AnimatePresence mode="wait"><motion.div key={current?.to || location.pathname} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.16 }}><Outlet /></motion.div></AnimatePresence></main>
      <footer className="workspace-footer"><span><Activity size={12} /> MEDCORE</span><span>Учебная система · Вымышленные данные</span></footer>
    </div></div>;
}
