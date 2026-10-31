import { lazy, Suspense } from 'react';
import type { PropsWithChildren } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Empty, Panel, ToastProvider } from './components/ui';
import { hasRole } from './format';
import type { Role } from './types';
import { LoginPage } from './pages/Login';

// Разделы загружаются по требованию: первый экран не тянет графики и таблицы
// всех страниц, поэтому вход и обзор открываются заметно быстрее.
const DashboardPage = lazy(() => import('./pages/Dashboard').then(module => ({ default: module.DashboardPage })));
const PatientsPage = lazy(() => import('./pages/Patients').then(module => ({ default: module.PatientsPage })));
const PatientDetailPage = lazy(() => import('./pages/Patients').then(module => ({ default: module.PatientDetailPage })));
const OrganizationsPage = lazy(() => import('./pages/Organizations').then(module => ({ default: module.OrganizationsPage })));
const OrganizationDetailPage = lazy(() => import('./pages/Organizations').then(module => ({ default: module.OrganizationDetailPage })));
const EmployeesPage = lazy(() => import('./pages/Employees').then(module => ({ default: module.EmployeesPage })));
const HospitalizationsPage = lazy(() => import('./pages/Hospitalizations').then(module => ({ default: module.HospitalizationsPage })));
const LaboratoriesPage = lazy(() => import('./pages/Laboratories').then(module => ({ default: module.LaboratoriesPage })));
const ReportsPage = lazy(() => import('./pages/Reports').then(module => ({ default: module.ReportsPage })));
const SuppliesPage = lazy(() => import('./pages/Supplies').then(module => ({ default: module.SuppliesPage })));
const TransportsPage = lazy(() => import('./pages/Transports').then(module => ({ default: module.TransportsPage })));
const AppointmentsPage = lazy(() => import('./pages/Appointments').then(module => ({ default: module.AppointmentsPage })));
const ProcurementPage = lazy(() => import('./pages/Procurement').then(module => ({ default: module.ProcurementPage })));
const AdminPage = lazy(() => import('./pages/Admin').then(module => ({ default: module.AdminPage })));

function RoleGuard({ roles, children }: PropsWithChildren<{ roles: Role[] }>) {
  const { user } = useAuth();
  return user && hasRole(user.roles, roles) ? children : <Panel><Empty title="Раздел недоступен" description="Ваша роль не даёт доступа к этому разделу." /><Link to="/dashboard" className="button button-secondary access-back">Вернуться к обзору</Link></Panel>;
}
function NotFound() {
  return <Panel><Empty title="Страница не найдена" description="Проверьте адрес или откройте обзор системы." /><Link to="/dashboard" className="button button-secondary access-back">Вернуться к обзору</Link></Panel>;
}
function PageLoader() {
  return <div className="connection-screen"><div className="loading-state" role="status"><span className="spin" aria-hidden="true">◌</span><span>Открываем раздел</span></div></div>;
}
export function App() {
  return <ToastProvider><AuthProvider><Suspense fallback={<PageLoader />}><Routes><Route path="/login" element={<LoginPage />} /><Route element={<RequireAuth><Layout /></RequireAuth>}><Route index element={<Navigate to="/dashboard" replace />} /><Route path="/dashboard" element={<DashboardPage />} /><Route path="/organizations" element={<OrganizationsPage />} /><Route path="/organizations/:id" element={<OrganizationDetailPage />} /><Route path="/employees" element={<RoleGuard roles={['organization_admin', 'doctor', 'registrar', 'chief_physician', 'deputy_chief_physician', 'head_of_department']}><EmployeesPage /></RoleGuard>} /><Route path="/patients" element={<RoleGuard roles={['doctor', 'registrar', 'chief_physician', 'deputy_chief_physician']}><PatientsPage /></RoleGuard>} /><Route path="/patients/:id" element={<RoleGuard roles={['doctor', 'registrar', 'chief_physician', 'deputy_chief_physician']}><PatientDetailPage /></RoleGuard>} /><Route path="/hospitalizations" element={<RoleGuard roles={['organization_admin', 'doctor', 'registrar', 'chief_physician', 'deputy_chief_physician', 'head_of_department']}><HospitalizationsPage /></RoleGuard>} /><Route path="/appointments" element={<RoleGuard roles={['registrar', 'doctor', 'organization_admin', 'chief_physician', 'deputy_chief_physician', 'head_of_department']}><AppointmentsPage /></RoleGuard>} /><Route path="/laboratories" element={<RoleGuard roles={['lab_staff', 'organization_admin', 'analyst', 'doctor']}><LaboratoriesPage /></RoleGuard>} /><Route path="/reports" element={<RoleGuard roles={['organization_admin', 'analyst', 'chief_physician', 'deputy_chief_physician', 'head_of_department', 'minister_of_health', 'governor']}><ReportsPage /></RoleGuard>} /><Route path="/supplies" element={<RoleGuard roles={['organization_admin', 'chief_physician', 'deputy_chief_physician', 'head_of_department']}><SuppliesPage /></RoleGuard>} /><Route path="/procurement" element={<RoleGuard roles={['organization_admin', 'chief_physician', 'deputy_chief_physician']}><ProcurementPage /></RoleGuard>} /><Route path="/transports" element={<RoleGuard roles={['registrar', 'doctor', 'organization_admin', 'chief_physician', 'deputy_chief_physician', 'head_of_department']}><TransportsPage /></RoleGuard>} /><Route path="/admin" element={<RoleGuard roles={['system_admin']}><AdminPage /></RoleGuard>} /></Route><Route path="*" element={<NotFound />} /></Routes></Suspense></AuthProvider></ToastProvider>;
}
