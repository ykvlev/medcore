import type { ItemList, Paged } from '../types';

export type ListPayload<T> = ItemList<T> | Paged<T> | T[];

/** Списки этапа 2 описаны как PageResult, но старые маршруты возвращают ItemList. */
export function payloadItems<T>(payload: ListPayload<T> | null | undefined): T[] {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload.items) ? payload.items : [];
}

export function payloadTotal<T>(payload: ListPayload<T> | null | undefined): number {
  if (!payload) return 0;
  if (!Array.isArray(payload) && 'total' in payload && typeof payload.total === 'number') return payload.total;
  return payloadItems(payload).length;
}

export function payloadHasTotal<T>(payload: ListPayload<T> | null | undefined): boolean {
  return !!payload && !Array.isArray(payload) && 'total' in payload && typeof payload.total === 'number';
}

/** Значение для <input type="datetime-local"> в местном поясе. */
export function localDateTimeValue(source = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${source.getFullYear()}-${pad(source.getMonth() + 1)}-${pad(source.getDate())}T${pad(source.getHours())}:${pad(source.getMinutes())}`;
}

/** Момент времени с часовым поясом для API. */
export function toIsoMoment(local: string): string {
  const parsed = local ? new Date(local) : new Date();
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

export function todayValue(): string {
  return localDateTimeValue().slice(0, 10);
}

export function firstDayOfYearValue(): string {
  return `${new Date().getFullYear()}-01-01`;
}

export function isValidDateRange(from: string, to: string): boolean {
  return !!from && !!to && from <= to;
}
