import { ApiError, errorMessage } from '../api';
import { Button } from './ui';

/**
 * Единый вывод ошибок действия: текст берётся из Problem Details,
 * код ответа вынесен в заголовок, чтобы 403 и 409 не терялись.
 */
export function ProblemNotice({ error, onRetry, retryLabel = 'Повторить' }: { error: unknown; onRetry?: () => void; retryLabel?: string }) {
  if (!error) return null;
  const status = error instanceof ApiError ? error.status : null;
  const heading = status === 403 ? 'Недостаточно прав' : status === 409 ? 'Конфликт данных' : status ? `Ошибка ${status}` : 'Не удалось выполнить действие';
  return (
    <div className="form-error" role="alert">
      <strong>{heading}</strong>
      <span>{errorMessage(error)}</span>
      {onRetry && <Button type="button" variant="ghost" onClick={onRetry}>{retryLabel}</Button>}
    </div>
  );
}
