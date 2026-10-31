import type { ReferralRow, ReferralType, SupplyOrderItemRow, SupplyOrderRow, SupplyRow, TransportRow } from './types';

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
