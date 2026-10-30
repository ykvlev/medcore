import { useEffect, useId, useRef } from 'react';
import type { PropsWithChildren } from 'react';
import { X } from 'lucide-react';

/**
 * Оболочка модального окна для реестров (организации, персонал).
 * Повторяет поведение общего Dialog из ui.tsx, но с собственным надзаголовком
 * и настраиваемой шириной: общий Dialog жёстко подписан «MEDCORE / Пациенты».
 */
export function EntityDialog({ open, onClose, title, description, eyebrow, width, busy = false, children }: PropsWithChildren<{ open: boolean; onClose: () => void; title: string; description?: string; eyebrow: string; width?: number; busy?: boolean }>) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="form-dialog entity-dialog"
      aria-labelledby={titleId}
      style={width ? { width: `${width}px` } : undefined}
      onCancel={event => { if (busy) event.preventDefault(); else onClose(); }}
      onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}
    >
      <div className="dialog-surface" style={{ maxHeight: 'calc(100dvh - 58px)', overflowY: 'auto' }}>
        <div className="dialog-header">
          <div>
            <span className="eyebrow">{eyebrow}</span>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" type="button" disabled={busy} onClick={onClose} aria-label="Закрыть окно"><X size={20} /></button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
