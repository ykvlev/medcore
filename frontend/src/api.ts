import type {
  AppointmentRow, AppointmentSlot, ContractRow, InvoiceRow, ReferralRow, ReferralType, RoutePoint,
  ScheduleRow, SupplierRow, SupplyOrderItemRow, SupplyOrderRow, SupplyRow, TenderRow, TransportRow,
} from './types';

export interface ProblemDetails {
  title?: string;
  detail?: string;
  status?: number;
  errors?: Record<string, string[]>;
}

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly problem: ProblemDetails) {
    super(problem.detail || problem.title || 'Не удалось выполнить запрос. Попробуйте ещё раз.');
    this.name = 'ApiError';
  }
}

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api${path}`, {
      ...options,
      credentials: 'include',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch {
    throw new Error('Нет соединения с сервером. Проверьте, что сервер MEDCORE запущен.');
  }
  if (!response.ok) {
    const problem = await response.json().catch(() => ({})) as ProblemDetails;
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') {
      window.dispatchEvent(new Event('medcore:session-expired'));
    }
    if (response.status === 403 && !problem.detail) problem.detail = 'Ваша роль не даёт доступа к этим сведениям.';
    if (response.status === 409 && !problem.detail) problem.detail = 'Запись уже изменена. Обновите данные и повторите действие.';
    throw new ApiError(response.status, problem);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить действие.';
}

/* ------------------------------------------------------------------ */
/* Этап 3: направления, снабжение, транспортировка.                   */
/* Ответы новых маршрутов разбираются терпимо к именам полей: сервер   */
/* может отдавать как плоские имена, так и вложенные объекты.          */
/* ------------------------------------------------------------------ */

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function listOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const items = recordOf(value).items;
  return Array.isArray(items) ? items : [];
}

function textOf(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function optionalText(...values: unknown[]): string | null {
  const value = textOf(...values);
  return value || null;
}

function numberValue(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function numberFrom(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function numberOrZero(...values: unknown[]): number {
  return numberFrom(...values) ?? 0;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const text = value.trim().toLocaleLowerCase('en');
    if (['true', '1', 'yes', 'active'].includes(text)) return true;
    if (['false', '0', 'no', 'inactive'].includes(text)) return false;
  }
  return fallback;
}

/** Числовой идентификатор фильтра в строку запроса; пустое значение не отправляется. */
function idText(value: number | string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text && text !== '0' ? text : undefined;
}

function toRoutePoint(raw: unknown): RoutePoint | null {
  if (Array.isArray(raw)) {
    const lat = numberFrom(raw[0]);
    const lng = numberFrom(raw[1]);
    return lat !== null && lng !== null ? { lat, lng, label: '' } : null;
  }
  const row = recordOf(raw);
  const lat = numberFrom(row.lat, row.latitude);
  const lng = numberFrom(row.lng, row.lon, row.longitude);
  if (lat === null || lng === null) return null;
  return { lat, lng, label: textOf(row.label, row.name, row.title) };
}

function toRoutePoints(value: unknown): RoutePoint[] {
  return (Array.isArray(value) ? value : []).map(toRoutePoint).filter((point): point is RoutePoint => point !== null);
}

function queryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value);
  const query = search.toString();
  return query ? `?${query}` : '';
}

function typeOfReferral(value: unknown): ReferralType {
  const text = textOf(value).toLocaleLowerCase('en');
  if (text === 'consultation' || text === 'consult') return 'consultation';
  if (text === 'diagnostic' || text === 'diagnostics') return 'diagnostic';
  return 'hospitalization';
}

function toReferral(raw: unknown): ReferralRow {
  const row = recordOf(raw);
  const hospital = recordOf(row.hospital ?? row.targetHospital);
  const specialization = recordOf(row.specialization);
  const doctor = recordOf(row.doctor ?? row.targetDoctor);
  return {
    id: numberOrZero(row.id),
    patientId: numberFrom(row.patientId, recordOf(row.patient).id),
    patientName: optionalText(row.patientName, recordOf(row.patient).fullName, recordOf(row.patient).name),
    type: typeOfReferral(row.referralType ?? row.type),
    hospitalId: numberFrom(row.hospitalId, row.targetHospitalId, hospital.id),
    hospitalName: textOf(row.hospitalName, row.targetHospitalName, hospital.name),
    specializationId: numberFrom(row.specializationId, specialization.id),
    specializationName: textOf(row.specializationName, typeof row.specialization === 'string' ? row.specialization : null, specialization.name),
    doctorId: numberFrom(row.doctorId, row.targetDoctorId, doctor.id),
    doctorName: optionalText(row.doctorName, row.targetDoctorName, doctor.fullName, doctor.name),
    status: textOf(row.status) || 'issued',
    issuedAt: textOf(row.issuedAt, row.createdAt),
    validUntil: optionalText(row.validUntil),
    reason: optionalText(row.reason, row.note),
  };
}

function toSupply(raw: unknown): SupplyRow {
  const row = recordOf(raw);
  const item = recordOf(row.item);
  const quantity = numberOrZero(row.quantity, row.stock, row.available);
  const minQuantity = numberOrZero(row.minQuantity, row.minimum, row.min);
  return {
    id: numberOrZero(row.id, row.itemId, item.id),
    code: textOf(row.code, item.code),
    name: textOf(row.name, row.itemName, item.name),
    category: textOf(row.category, item.category),
    unit: textOf(row.unit, item.unit) || '—',
    quantity,
    minQuantity,
    deficit: numberFrom(row.deficit) ?? Math.max(0, minQuantity - quantity),
    organizationName: optionalText(row.organizationName, recordOf(row.organization).name),
  };
}

function toSupplyOrderItem(raw: unknown): SupplyOrderItemRow {
  const row = recordOf(raw);
  const item = recordOf(row.item);
  return {
    id: numberOrZero(row.id),
    itemId: numberOrZero(row.itemId, item.id),
    name: textOf(row.name, row.itemName, item.name) || 'Позиция',
    unit: textOf(row.unit, item.unit),
    quantity: numberOrZero(row.quantity),
    unitPrice: numberOrZero(row.unitPrice, row.price),
  };
}

function toSupplyOrder(raw: unknown): SupplyOrderRow {
  const row = recordOf(raw);
  const rawItems = Array.isArray(row.items) ? row.items : [];
  const items = rawItems.map(toSupplyOrderItem);
  const total = numberFrom(row.total, row.totalAmount, row.amount, row.sum)
    ?? items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
  return {
    id: numberOrZero(row.id),
    supplier: textOf(row.supplier),
    status: textOf(row.status) || 'ordered',
    orderedAt: textOf(row.orderedAt, row.createdAt),
    expectedAt: optionalText(row.expectedAt),
    receivedAt: optionalText(row.receivedAt),
    itemCount: numberOrZero(row.itemCount, row.itemsCount, row.positions, items.length),
    total,
    organizationName: optionalText(row.organizationName, recordOf(row.organization).name),
    items,
    note: optionalText(row.note),
  };
}

function toTransport(raw: unknown): TransportRow {
  const row = recordOf(raw);
  const patient = recordOf(row.patient);
  const from = recordOf(row.fromOrganization ?? row.from);
  const to = recordOf(row.toOrganization ?? row.to);
  const accompanying = recordOf(row.accompanying ?? row.accompanyingEmployee);
  return {
    id: numberOrZero(row.id),
    patientId: numberOrZero(row.patientId, patient.id),
    patientName: textOf(row.patientName, patient.fullName, patient.name),
    fromOrganizationId: numberFrom(row.fromOrganizationId, from.id),
    fromOrganizationName: textOf(row.fromOrganizationName, row.fromName, from.name),
    toOrganizationId: numberFrom(row.toOrganizationId, to.id),
    toOrganizationName: textOf(row.toOrganizationName, row.toName, to.name),
    status: textOf(row.status) || 'requested',
    reason: textOf(row.reason),
    requestedAt: textOf(row.requestedAt, row.createdAt),
    startedAt: optionalText(row.startedAt),
    completedAt: optionalText(row.completedAt),
    vehicle: optionalText(row.vehicle),
    accompanyingEmployeeId: numberFrom(row.accompanyingEmployeeId, accompanying.id),
    accompanyingName: optionalText(row.accompanyingName, row.accompanyingEmployeeName, accompanying.fullName),
    distanceKm: numberFrom(row.distanceKm, row.distance, row.mileage),
    odometerStart: numberFrom(row.odometerStart, row.odometerFrom),
    odometerEnd: numberFrom(row.odometerEnd, row.odometerTo),
    fuelLiters: numberFrom(row.fuelLiters, row.fuel, row.fuelConsumed),
    routePoints: toRoutePoints(row.routePoints),
  };
}

export interface CreateReferralInput {
  patientId: number;
  caseId?: number | null;
  type: ReferralType;
  hospitalId: number;
  specializationId: number;
  doctorId?: number | null;
  validUntil?: string | null;
  reason: string;
}

/** Направления пациента: сначала вложенный маршрут, затем фильтр списка. */
export async function listPatientReferrals(patientId: number): Promise<ReferralRow[]> {
  try {
    const payload = await api<unknown>(`/patients/${patientId}/referrals`);
    return listOf(payload).map(toReferral);
  } catch (error) {
    if (!(error instanceof ApiError) || (error.status !== 404 && error.status !== 405)) throw error;
    const payload = await api<unknown>(`/referrals${queryString({ patientId: String(patientId) })}`);
    return listOf(payload).map(toReferral);
  }
}

export function createReferral(input: CreateReferralInput): Promise<{ id: number }> {
  return api<{ id: number }>('/referrals', {
    method: 'POST',
    body: JSON.stringify({
      patientId: input.patientId,
      caseId: input.caseId ?? null,
      referralType: input.type,
      hospitalId: input.hospitalId,
      specializationId: input.specializationId,
      targetDoctorId: input.doctorId ?? null,
      validUntil: input.validUntil || null,
      reason: input.reason,
    }),
  });
}

export async function listSupplies(filters: { search?: string; category?: string } = {}): Promise<SupplyRow[]> {
  const payload = await api<unknown>(`/supplies${queryString({ search: filters.search, category: filters.category })}`);
  return listOf(payload).map(toSupply);
}

export async function listDeficitSupplies(): Promise<SupplyRow[]> {
  const payload = await api<unknown>('/supplies/deficit');
  return listOf(payload).map(toSupply);
}

export async function listSupplyOrders(): Promise<SupplyOrderRow[]> {
  const payload = await api<unknown>('/supply-orders');
  return listOf(payload).map(toSupplyOrder);
}

export interface CreateSupplyOrderInput {
  supplier: string;
  expectedAt?: string | null;
  items: { itemId: number; quantity: number; unitPrice: number }[];
}

export function createSupplyOrder(input: CreateSupplyOrderInput): Promise<{ id: number }> {
  return api<{ id: number }>('/supply-orders', {
    method: 'POST',
    body: JSON.stringify({
      supplier: input.supplier,
      expectedAt: input.expectedAt || null,
      items: input.items,
    }),
  });
}

export function receiveSupplyOrder(id: number): Promise<void> {
  return api<void>(`/supply-orders/${id}/receive`, { method: 'POST' });
}

export async function listTransports(status?: string): Promise<TransportRow[]> {
  const payload = await api<unknown>(`/transports${queryString({ status })}`);
  return listOf(payload).map(toTransport);
}

export interface CreateTransportInput {
  patientId: number;
  fromOrganizationId: number;
  toOrganizationId: number;
  reason: string;
  vehicle?: string | null;
  accompanyingEmployeeId?: number | null;
}

export function createTransport(input: CreateTransportInput): Promise<{ id: number }> {
  return api<{ id: number }>('/transports', {
    method: 'POST',
    body: JSON.stringify({
      patientId: input.patientId,
      fromOrganizationId: input.fromOrganizationId,
      toOrganizationId: input.toOrganizationId,
      reason: input.reason,
      vehicle: input.vehicle || null,
      accompanyingEmployeeId: input.accompanyingEmployeeId ?? null,
    }),
  });
}

export function updateTransportStatus(id: number, status: string): Promise<void> {
  return api<void>(`/transports/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
}

/* ------------------------------------------------------------------ */
/* Этап 4: приём, расписание и закупки.                                */
/* Ответы разбираются терпимо: { items } или массив, плоские поля или  */
/* вложенные объекты doctor/patient/organization.                      */
/* ------------------------------------------------------------------ */

function toSlot(raw: unknown): AppointmentSlot {
  const row = recordOf(raw);
  const doctor = recordOf(row.doctor);
  const specialization = recordOf(row.specialization);
  const organization = recordOf(row.organization ?? row.hospital);
  return {
    id: numberOrZero(row.id, row.slotId),
    doctorId: numberOrZero(row.doctorId, doctor.id),
    doctorName: textOf(row.doctorName, typeof row.doctor === 'string' ? row.doctor : null, doctor.fullName, doctor.name) || 'Врач',
    specializationId: numberFrom(row.specializationId, specialization.id),
    specializationName: textOf(row.specializationName, typeof row.specialization === 'string' ? row.specialization : null, specialization.name),
    organizationId: numberFrom(row.organizationId, row.hospitalId, organization.id),
    organizationName: textOf(row.organizationName, row.hospitalName, organization.name),
    startsAt: textOf(row.startsAt, row.startAt),
    endsAt: textOf(row.endsAt, row.endAt),
    status: textOf(row.status).toLocaleLowerCase('en') || 'free',
    cabinet: optionalText(row.cabinet, row.room, row.office),
  };
}

function toAppointment(raw: unknown): AppointmentRow {
  const row = recordOf(raw);
  const patient = recordOf(row.patient);
  const doctor = recordOf(row.doctor);
  const specialization = recordOf(row.specialization);
  const organization = recordOf(row.organization ?? row.hospital);
  return {
    id: numberOrZero(row.id, row.appointmentId, row.slotId),
    startsAt: textOf(row.startsAt, row.startAt),
    endsAt: textOf(row.endsAt, row.endAt),
    status: textOf(row.status).toLocaleLowerCase('en') || 'scheduled',
    patientId: numberOrZero(row.patientId, patient.id),
    patientName: textOf(row.patientName, patient.fullName, patient.name),
    doctorId: numberOrZero(row.doctorId, doctor.id),
    doctorName: textOf(row.doctorName, doctor.fullName, doctor.name),
    specializationName: textOf(row.specializationName, typeof row.specialization === 'string' ? row.specialization : null, specialization.name),
    organizationId: numberFrom(row.organizationId, organization.id),
    organizationName: textOf(row.organizationName, organization.name),
    cabinet: optionalText(row.cabinet, row.room),
  };
}

function toSchedule(raw: unknown): ScheduleRow {
  const row = recordOf(raw);
  const doctor = recordOf(row.doctor);
  const organization = recordOf(row.organization ?? row.hospital);
  return {
    id: numberOrZero(row.id, row.scheduleId),
    doctorId: numberOrZero(row.doctorId, doctor.id),
    doctorName: textOf(row.doctorName, doctor.fullName, doctor.name) || 'Врач',
    organizationId: numberFrom(row.organizationId, organization.id),
    organizationName: textOf(row.organizationName, organization.name),
    workDate: textOf(row.workDate, row.date),
    startTime: textOf(row.startTime, row.startsAt),
    endTime: textOf(row.endTime, row.endsAt),
    slotMinutes: numberOrZero(row.slotMinutes, row.slotDuration),
    cabinet: optionalText(row.cabinet, row.room),
    isActive: booleanOr(row.isActive, true),
    slotsTotal: numberOrZero(row.slotsTotal, row.totalSlots, row.slots),
    slotsFree: numberOrZero(row.slotsFree, row.freeSlots),
  };
}

function toSupplier(raw: unknown): SupplierRow {
  const row = recordOf(raw);
  return {
    id: numberOrZero(row.id, row.supplierId),
    name: textOf(row.name, row.title) || `Поставщик № ${numberOrZero(row.id)}`,
    inn: optionalText(row.inn, row.taxId),
    contact: optionalText(row.contact, row.contacts, row.phone),
    isActive: booleanOr(row.isActive, true),
  };
}

function toContract(raw: unknown): ContractRow {
  const row = recordOf(raw);
  const supplier = recordOf(row.supplier);
  const organization = recordOf(row.organization ?? row.hospital);
  return {
    id: numberOrZero(row.id, row.contractId),
    number: textOf(row.number, row.contractNumber) || `Договор № ${numberOrZero(row.id)}`,
    supplierId: numberFrom(row.supplierId, supplier.id),
    supplierName: textOf(row.supplierName, supplier.name) || '—',
    organizationId: numberFrom(row.organizationId, organization.id),
    organizationName: textOf(row.organizationName, organization.name),
    signedAt: textOf(row.signedAt, row.signedDate, row.createdAt),
    validUntil: optionalText(row.validUntil, row.expiresAt),
    amount: numberOrZero(row.amount, row.totalAmount, row.sum),
    status: textOf(row.status).toLocaleLowerCase('en') || 'active',
    invoicesCount: numberOrZero(row.invoicesCount, row.invoiceCount, row.invoices),
    paidAmount: numberOrZero(row.paidAmount, row.paid, row.paidSum),
  };
}

function toTender(raw: unknown): TenderRow {
  const row = recordOf(raw);
  const organization = recordOf(row.organization ?? row.hospital);
  const winner = recordOf(row.winnerSupplier ?? row.winner);
  return {
    id: numberOrZero(row.id, row.tenderId),
    title: textOf(row.title, row.name) || `Тендер № ${numberOrZero(row.id)}`,
    organizationId: numberFrom(row.organizationId, organization.id),
    organizationName: textOf(row.organizationName, organization.name),
    announcedAt: textOf(row.announcedAt, row.createdAt),
    closesAt: textOf(row.closesAt, row.deadline),
    status: textOf(row.status).toLocaleLowerCase('en') || 'announced',
    budget: numberOrZero(row.budget, row.amount, row.maxPrice),
    winnerSupplierId: numberFrom(row.winnerSupplierId, winner.id),
    winnerSupplierName: optionalText(row.winnerSupplierName, winner.name, winner.supplierName),
  };
}

function toInvoice(raw: unknown): InvoiceRow {
  const row = recordOf(raw);
  const contract = recordOf(row.contract);
  const supplier = recordOf(row.supplier);
  return {
    id: numberOrZero(row.id, row.invoiceId),
    contractId: numberFrom(row.contractId, contract.id),
    contractNumber: textOf(row.contractNumber, contract.number),
    supplierName: textOf(row.supplierName, supplier.name, contract.supplierName),
    number: textOf(row.number, row.invoiceNumber) || `Счёт № ${numberOrZero(row.id)}`,
    issuedAt: textOf(row.issuedAt, row.issuedDate, row.createdAt),
    dueAt: textOf(row.dueAt, row.dueDate, row.payUntil),
    amount: numberOrZero(row.amount, row.total, row.sum),
    status: textOf(row.status).toLocaleLowerCase('en') || 'pending',
    paidAt: optionalText(row.paidAt, row.paidDate),
  };
}

export interface SlotFilters {
  dateFrom?: string;
  dateTo?: string;
  organizationId?: number | string;
  specializationId?: number | string;
  doctorId?: number | string;
  onlyFree?: boolean;
}

export async function listSlots(filters: SlotFilters = {}): Promise<AppointmentSlot[]> {
  const payload = await api<unknown>(`/slots${queryString({
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
    organizationId: idText(filters.organizationId),
    specializationId: idText(filters.specializationId),
    doctorId: idText(filters.doctorId),
    onlyFree: filters.onlyFree === undefined ? undefined : String(filters.onlyFree),
  })}`);
  return listOf(payload).map(toSlot);
}

export async function listDoctorSlots(doctorId: number, filters: { dateFrom?: string; dateTo?: string } = {}): Promise<AppointmentSlot[]> {
  const payload = await api<unknown>(`/doctors/${doctorId}/slots${queryString({
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
  })}`);
  return listOf(payload).map(toSlot);
}

export interface CreateAppointmentInput {
  slotId: number;
  patientId: number;
  referralId?: number | null;
}

export function createAppointment(input: CreateAppointmentInput): Promise<{ id: number }> {
  return api<{ id: number }>('/appointments', {
    method: 'POST',
    body: JSON.stringify({
      slotId: input.slotId,
      patientId: input.patientId,
      ...(input.referralId ? { referralId: input.referralId } : {}),
    }),
  });
}

export function updateAppointmentStatus(slotId: number, status: 'cancelled' | 'completed'): Promise<void> {
  return api<void>(`/appointments/${slotId}`, { method: 'PATCH', body: JSON.stringify({ status }) });
}

export interface AppointmentFilters {
  date?: string;
  status?: string;
  patientId?: number | string;
}

export async function listAppointments(filters: AppointmentFilters = {}): Promise<AppointmentRow[]> {
  const payload = await api<unknown>(`/appointments${queryString({
    date: filters.date || undefined,
    status: filters.status || undefined,
    patientId: idText(filters.patientId),
  })}`);
  return listOf(payload).map(toAppointment);
}

export interface CreateScheduleInput {
  doctorId: number;
  organizationId: number;
  workDate: string;
  startTime: string;
  endTime: string;
  slotMinutes: number;
  cabinet?: string | null;
}

export async function listSchedules(filters: { dateFrom?: string; dateTo?: string; organizationId?: number | string; doctorId?: number | string } = {}): Promise<ScheduleRow[]> {
  const payload = await api<unknown>(`/schedules${queryString({
    dateFrom: filters.dateFrom || undefined,
    dateTo: filters.dateTo || undefined,
    organizationId: idText(filters.organizationId),
    doctorId: idText(filters.doctorId),
  })}`);
  return listOf(payload).map(toSchedule);
}

export async function createSchedule(input: CreateScheduleInput): Promise<{ id: number; slotsCreated: number }> {
  const payload = await api<unknown>('/schedules', {
    method: 'POST',
    body: JSON.stringify({
      doctorId: input.doctorId,
      organizationId: input.organizationId,
      workDate: input.workDate,
      startTime: input.startTime,
      endTime: input.endTime,
      slotMinutes: input.slotMinutes,
      cabinet: input.cabinet || null,
    }),
  });
  const row = recordOf(payload);
  return { id: numberOrZero(row.id), slotsCreated: numberOrZero(row.slotsCreated, row.slotsCreatedCount, row.slots) };
}

export function deleteSchedule(id: number): Promise<void> {
  return api<void>(`/schedules/${id}`, { method: 'DELETE' });
}

export async function listEmployees(organizationId?: number | string): Promise<{ id: number; fullName: string; category: string; organizationName: string | null; isActive: boolean }[]> {
  const payload = await api<unknown>(`/employees${queryString({ organizationId: idText(organizationId), page: '1', pageSize: '100' })}`);
  return listOf(payload).map(raw => {
    const row = recordOf(raw);
    const person = recordOf(row.employee);
    return {
      id: numberOrZero(row.id, person.id),
      fullName: textOf(row.fullName, row.name, person.fullName, person.name) || `Сотрудник № ${numberOrZero(row.id)}`,
      category: textOf(row.category, person.category, row.position),
      organizationName: optionalText(row.organizationName, recordOf(row.organization).name),
      isActive: booleanOr(row.isActive, true),
    };
  });
}

export async function listSuppliers(filters: { search?: string } = {}): Promise<SupplierRow[]> {
  const payload = await api<unknown>(`/suppliers${queryString({ search: filters.search || undefined })}`);
  return listOf(payload).map(toSupplier);
}

export function createSupplier(input: { name: string; inn?: string | null; contact?: string | null }): Promise<{ id: number }> {
  return api<{ id: number }>('/suppliers', {
    method: 'POST',
    body: JSON.stringify({ name: input.name, inn: input.inn || null, contact: input.contact || null }),
  });
}

export async function listContracts(filters: { status?: string; supplierId?: number | string } = {}): Promise<ContractRow[]> {
  const payload = await api<unknown>(`/contracts${queryString({ status: filters.status || undefined, supplierId: idText(filters.supplierId) })}`);
  return listOf(payload).map(toContract);
}

export interface CreateContractInput {
  supplierId: number;
  number: string;
  signedAt: string;
  validUntil?: string | null;
  amount: number;
  note?: string | null;
}

export function createContract(input: CreateContractInput): Promise<{ id: number }> {
  return api<{ id: number }>('/contracts', {
    method: 'POST',
    body: JSON.stringify({
      supplierId: input.supplierId,
      number: input.number,
      signedAt: input.signedAt,
      validUntil: input.validUntil || null,
      amount: input.amount,
      note: input.note || null,
    }),
  });
}

export function setContractStatus(id: number, status: string): Promise<void> {
  return api<void>(`/contracts/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
}

export async function listTenders(filters: { status?: string } = {}): Promise<TenderRow[]> {
  const payload = await api<unknown>(`/tenders${queryString({ status: filters.status || undefined })}`);
  return listOf(payload).map(toTender);
}

export function createTender(input: { title: string; closesAt: string; budget: number; note?: string | null }): Promise<{ id: number }> {
  return api<{ id: number }>('/tenders', {
    method: 'POST',
    body: JSON.stringify({ title: input.title, closesAt: input.closesAt, budget: input.budget, note: input.note || null }),
  });
}

export function updateTender(id: number, input: { status: string; winnerSupplierId?: number | null }): Promise<void> {
  return api<void>(`/tenders/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: input.status, ...(input.winnerSupplierId ? { winnerSupplierId: input.winnerSupplierId } : {}) }),
  });
}

export async function listInvoices(filters: { status?: string; contractId?: number | string } = {}): Promise<InvoiceRow[]> {
  const payload = await api<unknown>(`/invoices${queryString({ status: filters.status || undefined, contractId: idText(filters.contractId) })}`);
  return listOf(payload).map(toInvoice);
}

export function createInvoice(input: { contractId: number; number: string; issuedAt: string; dueAt: string; amount: number }): Promise<{ id: number }> {
  return api<{ id: number }>('/invoices', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function payInvoice(id: number): Promise<void> {
  return api<void>(`/invoices/${id}/pay`, { method: 'PATCH' });
}

export interface SaveTransportRouteInput {
  distanceKm: number;
  odometerStart?: number | null;
  odometerEnd?: number | null;
  fuelLiters?: number | null;
  routePoints: RoutePoint[];
}

export function saveTransportRoute(id: number, input: SaveTransportRouteInput): Promise<void> {
  return api<void>(`/transports/${id}/route`, {
    method: 'PUT',
    body: JSON.stringify({
      distanceKm: input.distanceKm,
      odometerStart: input.odometerStart ?? null,
      odometerEnd: input.odometerEnd ?? null,
      fuelLiters: input.fuelLiters ?? null,
      routePoints: input.routePoints,
    }),
  });
}
