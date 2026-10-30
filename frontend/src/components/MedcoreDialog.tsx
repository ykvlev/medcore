import { useEffect, useId, useRef } from 'react';
import type { PropsWithChildren } from 'react';
import { X } from 'lucide-react';
import './MedcoreDialog.css';

/** Диалог в общем стеклянном стиле с настраиваемым надзаголовком и шириной. */
export function MedcoreDialog({ open, onClose, title, description, eyebrow = 'MEDCORE', children, busy = false, wide = false }: PropsWithChildren<{
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  eyebrow?: string;
  busy?: boolean;
  wide?: boolean;
}>) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className={`form-dialog medcore-dialog${wide ? ' medcore-dialog-wide' : ''}`} aria-labelledby={headingId} onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className="dialog-surface"><div className="dialog-header"><div><span className="eyebrow">{eyebrow}</span><h2 id={headingId}>{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" type="button" disabled={busy} onClick={onClose} aria-label="Закрыть окно"><X size={20} /></button></div>{children}</div></dialog>;
}
