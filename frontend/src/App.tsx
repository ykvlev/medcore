import type { PropsWithChildren } from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireAuth, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Empty, Panel, ToastProvider } from './components/ui';
import { hasRole } from './format';
import type { Role } from './types';
import { LoginPage } from './pages/Login';
import { DashboardPage } from './pages/Dashboard';
import { PatientDetailPage, PatientsPage } from './pages/Patients';
import { OrganizationDetailPage, OrganizationsPage } from './pages/Organizations';
import { EmployeesPage } from './pages/Employees';
import { HospitalizationsPage } from './pages/Hospitalizations';
import { LaboratoriesPage } from './pages/Laboratories';
import { ReportsPage } from './pages/Reports';
import { AdminPage } from './pages/Admin';

function RoleGuard({ roles, children }: PropsWithChildren<{ roles: Role[] }>) {
  const { user } = useAuth();
  return user && hasRole(user.roles, roles) ? children : <Panel><Empty title="Раздел недоступен" description="Ваша роль не даёт доступа к этому разделу." /><Link to="/dashboard" className="button button-secondary access-back">Вернуться к обзору</Link></Panel>;
}
function NotFound() {
  return <Panel><Empty title="Страница не найдена" description="Проверьте адрес или откройте обзор системы." /><Link to="/dashboard" className="button button-secondary access-back">Вернуться к обзору</Link></Panel>;
}
export function App() {
  return <ToastProvider><AuthProvider><Routes><Route path="/login" element={<LoginPage />} /><Route element={<RequireAuth><Layout /></RequireAuth>}><Route index element={<Navigate to="/dashboard" replace />} /><Route path="/dashboard" element={<DashboardPage />} /><Route path="/organizations" element={<OrganizationsPage />} /><Route path="/organizations/:id" element={<OrganizationDetailPage />} /><Route path="/employees" element={<RoleGuard roles={['organization_admin', 'doctor', 'registrar', 'chief_physician', 'deputy_chief_physician', 'head_of_department']}><EmployeesPage /></RoleGuard>} /><Route path="/patients" element={<RoleGuard roles={['doctor', 'registrar', 'chief_physician', 'deputy_chief_physician']}><PatientsPage /></RoleGuard>} /><Route path="/patients/:id" element={<RoleGuard roles={['doctor', 'registrar', 'chief_physician', 'deputy_chief_physician']}><PatientDetailPage /></RoleGuard>} /><Route path="/hospitalizations" element={<RoleGuard roles={['organization_admin', 'doctor', 'registrar', 'chief_physician', 'deputy_chief_physician', 'head_of_department']}><HospitalizationsPage /></RoleGuard>} /><Route path="/laboratories" element={<RoleGuard roles={['lab_staff', 'organization_admin', 'analyst', 'doctor']}><LaboratoriesPage /></RoleGuard>} /><Route path="/reports" element={<RoleGuard roles={['organization_admin', 'analyst', 'chief_physician', 'deputy_chief_physician', 'head_of_department', 'minister_of_health', 'governor']}><ReportsPage /></RoleGuard>} /><Route path="/admin" element={<RoleGuard roles={['system_admin']}><AdminPage /></RoleGuard>} /><Route path="*" element={<NotFound />} /></Route></Routes></AuthProvider></ToastProvider>;
}
