import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, PropsWithChildren, ReactNode } from 'react';
import { AlertCircle, Check, CheckCircle2, Inbox, LoaderCircle, RefreshCw, X } from 'lucide-react';
import { motion } from 'motion/react';
import { flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import type { ColumnDef } from '@tanstack/react-table';
import { errorMessage } from '../api';

export function Button({ children, className = '', variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' }) {
  return <button className={`button button-${variant} ${className}`} {...props}>{children}</button>;
}
export function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return <div className="page-heading"><div><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p>{description}</p></div>{action && <div className="heading-action">{action}</div>}</div>;
}
export function Panel({ children, className = '', delay = 0 }: PropsWithChildren<{ className?: string; delay?: number }>) {
  return <motion.section className={`glass-panel ${className}`} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay, ease: [0.16, 1, 0.3, 1] }}>{children}</motion.section>;
}
export function PanelHeading({ title, subtitle, trailing }: { title: string; subtitle?: string; trailing?: ReactNode }) {
  return <div className="panel-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div>{trailing}</div>;
}
export function Empty({ title = 'Пока нет записей', description = 'Здесь появятся данные, когда они будут добавлены.', small = false }: { title?: string; description?: string; small?: boolean }) {
  return <div className={`empty-state ${small ? 'empty-small' : ''}`}><span className="empty-symbol"><Inbox size={23} strokeWidth={1.5} /></span><h3>{title}</h3><p>{description}</p></div>;
}
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  return <div className="error-state" role="alert"><AlertCircle size={24} /><div><h3>Не удалось загрузить данные</h3><p>{errorMessage(error)}</p></div>{retry && <Button variant="secondary" onClick={retry}><RefreshCw size={15} /> Повторить</Button>}</div>;
}
export function Loading({ label = 'Загружаем данные' }: { label?: string }) {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" size={22} /><span>{label}</span></div>;
}
export function SkeletonCards() {
  return <div className="stats-grid" aria-label="Загружаем сводку" role="status">{Array.from({ length: 4 }, (_, i) => <div className="glass-panel skeleton-card" key={i}><div className="skeleton skeleton-line" /><div className="skeleton skeleton-value" /><div className="skeleton skeleton-line short" /></div>)}</div>;
}
export function Badge({ status, children }: { status?: string; children?: ReactNode }) {
  const labels: Record<string, string> = { active: 'Активен', archived: 'В архиве', discharged: 'Выписан', cancelled: 'Отменена', completed: 'Завершён' };
  return <span className={`badge badge-${status || 'neutral'}`}><span />{children || labels[status || ''] || status}</span>;
}
export function DataTable<T>({ data, columns, emptyTitle, emptyDescription }: { data: T[]; columns: ColumnDef<T>[]; emptyTitle?: string; emptyDescription?: string }) {
  const table = useReactTable({ data, columns, getCoreRowModel: getCoreRowModel() });
  if (!data.length) return <Empty title={emptyTitle} description={emptyDescription} />;
  return <div className="table-scroll"><table className="data-table"><thead>{table.getHeaderGroups().map(group => <tr key={group.id}>{group.headers.map(header => <th key={header.id} scope="col">{header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}</th>)}</tr>)}</thead><tbody>{table.getRowModel().rows.map(row => <tr key={row.id}>{row.getVisibleCells().map(cell => <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>)}</tr>)}</tbody></table></div>;
}
export function Dialog({ open, onClose, title, description, children, busy = false }: PropsWithChildren<{ open: boolean; onClose: () => void; title: string; description?: string; busy?: boolean }>) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  return <dialog ref={ref} className="form-dialog" aria-labelledby="dialog-title" onCancel={event => { if (busy) event.preventDefault(); else onClose(); }} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className="dialog-surface"><div className="dialog-header"><div><span className="eyebrow">MEDCORE / Пациенты</span><h2 id="dialog-title">{title}</h2>{description && <p>{description}</p>}</div><button className="icon-button" type="button" disabled={busy} onClick={onClose} aria-label="Закрыть окно"><X size={20} /></button></div>{children}</div></dialog>;
}
type ToastMessage = { id: number; message: string; type: 'success' | 'error' };
const ToastContext = createContext<(message: string, type?: ToastMessage['type']) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: PropsWithChildren) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  const timeouts = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timeouts.current.forEach(clearTimeout), []);
  function notify(message: string, type: ToastMessage['type'] = 'success') {
    const id = Date.now() + Math.random();
    setMessages(previous => [...previous.slice(-2), { id, message, type }]);
    timeouts.current.push(setTimeout(() => setMessages(previous => previous.filter(item => item.id !== id)), 6000));
  }
  return <ToastContext.Provider value={notify}>{children}<div className="toast-stack" aria-live="polite">{messages.map(message => <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} key={message.id} className={`toast toast-${message.type}`}>{message.type === 'success' ? <CheckCircle2 size={19} /> : <AlertCircle size={19} />}<span>{message.message}</span><button className="icon-button" aria-label="Скрыть уведомление" onClick={() => setMessages(previous => previous.filter(item => item.id !== message.id))}><X size={15} /></button></motion.div>)}</div></ToastContext.Provider>;
}
export function Submitting({ children, busy }: PropsWithChildren<{ busy: boolean }>) {
  return <>{busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}{children}</>;
}
