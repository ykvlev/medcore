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
