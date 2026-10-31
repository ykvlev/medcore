export type Role =
  | 'system_admin' | 'organization_admin' | 'doctor' | 'registrar' | 'lab_staff' | 'analyst'
  | 'chief_physician' | 'deputy_chief_physician' | 'head_of_department' | 'minister_of_health' | 'governor';
export interface CurrentUser {
  id: number;
  login: string;
  displayName: string;
  roles: Role[];
  organizations: { id: number; name: string }[];
}
export interface Patient {
  id: number;
  lastName: string;
  firstName: string;
  middleName: string | null;
  birthDate: string;
  sex: 'male' | 'female' | 'unknown';
  phone: string | null;
  email: string | null;
  address: string | null;
  polyclinicName: string | null;
  lastVisitAt: string | null;
  status: string;
  version: number;
}
export interface PatientHistory {
  id: number | string;
  type: string;
  title: string;
  occurredAt: string;
  description: string | null;
  /** Код МКБ-10, если сервер отдаёт его отдельно от заголовка. */
  code?: string | null;
  /** Медицинский случай: нужен форме добавления диагноза. */
  caseId?: number | null;
}
export interface PatientDetail { patient: Patient; history: PatientHistory[] }
/** Медицинский случай пациента из GET /patients/{id}/cases. */
export interface PatientCase {
  id: number;
  organizationId: number;
  organizationName: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  primaryDiagnosis: string | null;
}
export interface Paged<T> { items: T[]; total: number; page: number; pageSize: number }
export interface ItemList<T> { items: T[] }
export interface MonthlyActivity { month: string; visits: number; hospitalizations: number }
export interface Dashboard {
  organizations: number;
  activeDoctors: number | null;
  patients: number | null;
  activeHospitalizations: number | null;
  beds: number | null;
  occupiedBeds: number | null;
  occupancyPercent: number | null;
  monthlyActivity: MonthlyActivity[];
  departmentOccupancy: { name: string; totalBeds: number; occupiedBeds: number }[];
  recentEvents: { id: number | string; action: string; entityType: string; occurredAt: string }[];
}
export interface Organization {
  id: number; name: string; organizationType: string; address: string; phone: string | null; isActive: boolean;
}
export interface Employee {
  id: number; fullName: string; category: string; specialties: string[] | string | null;
  organizationName: string | null; isActive: boolean;
}
export interface Hospitalization {
  id: number; patientName: string; hospitalName: string; departmentName: string;
  wardNumber: string | null; bedNumber: string | null; doctorName: string | null;
  admittedAt: string; dischargedAt: string | null; status: string;
}
export interface Laboratory {
  id: number; name: string; address: string; phone: string | null;
  profiles: string[] | string | null; activeContracts: number;
}
export interface Capacity {
  hospitalName: string; departmentName: string; totalBeds: number;
  occupiedBeds: number; freeBeds: number; occupancyPercent: number;
}
export interface DoctorStatistics {
  fullName: string; specialties: string[] | string | null; workplaces: string[] | string | null;
  appointmentCount: number; surgeryCount: number; fatalSurgeryCount: number;
}
export interface Reports { capacity: Capacity[]; monthlyActivity: MonthlyActivity[]; doctors: DoctorStatistics[] }

// Типы этапа 2. Контракт: docs/project/api-contract.md.
export interface OrganizationRow {
  id: number; name: string; organizationType: 'hospital' | 'polyclinic'; address: string; phone: string | null;
  isActive: boolean; parentHospitalId: number | null; parentHospitalName: string | null;
}
export interface BedRow { id: number; number: string; isActive: boolean; occupied: boolean }
export interface WardRow { id: number; number: string; plannedCapacity: number; beds: BedRow[] }
export interface DepartmentRow { id: number; name: string; specialization: string | null; totalBeds: number; occupiedBeds: number; wards: WardRow[] }
export interface BuildingRow { id: number; number: string; departments: DepartmentRow[] }
export interface OrganizationCard { organization: OrganizationRow; buildings: BuildingRow[] }
export interface DictionaryItem { id: number; name: string }
/** Элемент справочника МКБ-10 из GET /diagnoses?search=. */
export interface DiagnosisItem { id: number; code: string; name: string; chapter: string | null }
export interface Dictionaries {
  specializations: DictionaryItem[]; specialties: DictionaryItem[]; categories: DictionaryItem[];
  degrees: DictionaryItem[]; titles: DictionaryItem[]; diagnoses: { code: string; name: string }[];
  labTestTypes: { id: number; name: string; profileId: number }[]; laboratories: DictionaryItem[];
}
export interface EmployeeRow {
  id: number; fullName: string; category: string; specialties: string[] | string | null;
  organizationName: string | null; isActive: boolean;
}
export interface Employment { id: number; organizationName: string; organizationType: string; startedAt: string; endedAt: string | null }
export interface DoctorProfile { specialties: DictionaryItem[]; degree: string | null; title: string | null; hiredAt: string | null }
export interface EmployeeCard {
  employee: { id: number; lastName: string; firstName: string; middleName: string | null; birthDate: string; category: string; isActive: boolean; organizationName: string | null; phone: string | null };
  doctor: DoctorProfile | null; employments: Employment[]; consultations: Employment[];
}
export interface Placement { id: number; wardNumber: string; bedNumber: string; startedAt: string; endedAt: string | null }
export interface AttendingPeriod { id: number; doctorName: string; startedAt: string; endedAt: string | null }
export interface HospitalizationDetail {
  hospitalization: {
    id: number; patientId: number; patientName: string; hospitalName: string; departmentName: string;
    status: string; admittedAt: string; dischargedAt: string | null; bedNumber: string | null; wardNumber: string | null; diagnosis: string | null;
  };
  placements: Placement[]; attending: AttendingPeriod[]; history: PatientHistory[];
}
export interface LabOrderRow {
  id: number; patientName: string; testName: string; laboratoryName: string;
  status: string; orderedAt: string; completedAt: string | null;
}
export interface LabOrderDetail extends LabOrderRow {
  doctorName: string; result: { value: string; unit: string | null; referenceRange: string | null; conclusion: string | null; performedAt: string } | null;
}
export interface AdminUser {
  id: number; login: string; displayName: string | null; isActive: boolean;
  roles: {
    role: string;
    organizationId?: number | null; organizationName: string | null;
    laboratoryId?: number | null; laboratoryName: string | null;
    /** Область заведующего отделением; сервер может ещё не отдавать эти поля. */
    departmentId?: number | null; departmentName?: string | null;
  }[];
}
export interface AuditRow {
  id: number; occurredAt: string; actorLogin: string | null; action: string; entityType: string; entityId: number | null; outcome: string;
}
export interface ReportTable {
  kind: string; title: string; from: string; to: string;
  columns: { key: string; label: string }[]; rows: Record<string, string | number | null>[];
  totals: { rowCount: number };
}

// Этап 3. Направления, снабжение и транспортировка (миграция 007).
export type ReferralType = 'hospitalization' | 'consultation' | 'diagnostic';
/** Строка списка направлений пациента: GET /referrals?patientId= или /patients/{id}/referrals. */
export interface ReferralRow {
  id: number;
  patientId: number | null;
  patientName: string | null;
  type: ReferralType;
  hospitalId: number | null;
  hospitalName: string;
  specializationId: number | null;
  specializationName: string;
  doctorId: number | null;
  doctorName: string | null;
  status: string;
  issuedAt: string;
  validUntil: string | null;
  reason: string | null;
}
export type SupplyCategory = 'medicine' | 'consumable';
/** Остаток на складе организации: GET /supplies. */
export interface SupplyRow {
  id: number;
  code: string;
  name: string;
  category: SupplyCategory | string;
  unit: string;
  quantity: number;
  minQuantity: number;
  deficit: number;
  organizationName: string | null;
}
/** Позиция заказа на снабжение. */
export interface SupplyOrderItemRow {
  id: number;
  itemId: number;
  name: string;
  unit: string;
  quantity: number;
  unitPrice: number;
}
/** Заказ на снабжение: GET /supply-orders. */
export interface SupplyOrderRow {
  id: number;
  supplier: string;
  status: string;
  orderedAt: string;
  expectedAt: string | null;
  receivedAt: string | null;
  itemCount: number;
  total: number;
  organizationName: string | null;
  items: SupplyOrderItemRow[];
  note: string | null;
}
/** Перевозка пациента между учреждениями: GET /transports. */
export interface TransportRow {
  id: number;
  patientId: number;
  patientName: string;
  fromOrganizationId: number | null;
  fromOrganizationName: string;
  toOrganizationId: number | null;
  toOrganizationName: string;
  status: string;
  reason: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  vehicle: string | null;
  accompanyingEmployeeId: number | null;
  accompanyingName: string | null;
}

