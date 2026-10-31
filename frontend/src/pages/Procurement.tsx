import { useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { FileText, Gavel, Plus, Receipt, Search, Truck, Wallet } from 'lucide-react';
import {
  createContract, createInvoice, createSupplier, createTender, errorMessage, listContracts, listInvoices,
  listSuppliers, listTenders, payInvoice, setContractStatus as patchContractStatus, updateTender,
} from '../api';
import { date, number } from '../format';
import type { ContractRow, InvoiceRow, SupplierRow, TenderRow } from '../types';
import { Badge, Button, DataTable, ErrorState, Loading, PageHeading, Panel, PanelHeading, Submitting, useToast } from '../components/ui';
import { MedcoreDialog } from '../components/MedcoreDialog';
import { localDateTimeValue, payloadItems, toIsoMoment, todayValue } from '../components/medcoreUtils';
import './Procurement.css';

type Tab = 'contracts' | 'tenders' | 'invoices' | 'suppliers';

const money = (value: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(value);
const pad = (value: number) => String(value).padStart(2, '0');

function shiftDate(value: string, days: number): string {
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  parsed.setDate(parsed.getDate() + days);
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`;
}

function defaultClosesAt(): string {
  const value = new Date();
  value.setDate(value.getDate() + 7);
  value.setHours(18, 0, 0, 0);
  return localDateTimeValue(value);
}

const contractStatusNames: Record<string, string> = {
  draft: 'Черновик', active: 'Действует', signed: 'Подписан', closed: 'Закрыт', expired: 'Истёк', terminated: 'Расторгнут',
};
const tenderStatusNames: Record<string, string> = {
  announced: 'Объявлен', evaluating: 'Оценка', awarded: 'Присуждён', cancelled: 'Отменён', closed: 'Закрыт',
};
const invoiceStatusNames: Record<string, string> = {
  pending: 'Ожидает оплаты', issued: 'Выставлен', paid: 'Оплачен', overdue: 'Просрочен', cancelled: 'Отменён',
};
const contractStatusLabel = (status: string) => contractStatusNames[status] || status || '—';
const tenderStatusLabel = (status: string) => tenderStatusNames[status] || status || '—';
const invoiceStatusLabel = (status: string) => invoiceStatusNames[status] || status || '—';
const contractIsOpen = (status: string) => status !== 'closed' && status !== 'terminated' && status !== 'expired';
const invoiceIsPaid = (status: string) => status === 'paid' || status === 'cancelled';

/* ------------------------------------------------------------------ */
/* Формы                                                              */
/* ------------------------------------------------------------------ */

function SupplierForm({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [inn, setInn] = useState('');
  const [contact, setContact] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => createSupplier({ name: name.trim(), inn: inn.trim() || null, contact: contact.trim() || null }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['suppliers'] });
      toast('Поставщик добавлен');
      onClose();
    },
  });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!name.trim()) return setValidation('Укажите название поставщика.');
    if (name.trim().length > 200) return setValidation('Название не должно превышать 200 символов.');
    if (inn.trim() && !/^\d{10}(\d{2})?$/.test(inn.trim())) return setValidation('ИНН состоит из 10 или 12 цифр.');
    mutation.mutate();
  }
  return <form className="procurement-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="form-section-label"><Truck size={15} /> Реквизиты поставщика</div>
      <div className="form-grid">
        <div className="field field-wide">
          <label htmlFor="supplier-name">Название <span>*</span></label>
          <input id="supplier-name" value={name} maxLength={200} onChange={event => setName(event.target.value)} autoComplete="off" placeholder="Например, ООО «Медпоставка»" />
        </div>
        <div className="field">
          <label htmlFor="supplier-inn">ИНН</label>
          <input id="supplier-inn" value={inn} maxLength={12} onChange={event => setInn(event.target.value)} autoComplete="off" inputMode="numeric" placeholder="10 или 12 цифр" />
        </div>
        <div className="field">
          <label htmlFor="supplier-contact">Контакт</label>
          <input id="supplier-contact" value={contact} maxLength={200} onChange={event => setContact(event.target.value)} autoComplete="off" placeholder="Телефон или электронная почта" />
        </div>
      </div>
      <p className="field-hint procurement-form-hint">Активность поставщика и договоры ведутся отдельно.</p>
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось добавить поставщика: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions">
      <span className="form-required">* Обязательные поля</span>
      <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
      <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Добавить поставщика</Submitting></Button>
    </div>
  </form>;
}

function ContractForm({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const suppliers = useQuery({ queryKey: ['suppliers', 'options'], queryFn: () => listSuppliers() });
  const [supplierId, setSupplierId] = useState('');
  const [contractNumber, setContractNumber] = useState('');
  const [signedAt, setSignedAt] = useState(() => todayValue());
  const [validUntil, setValidUntil] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const supplierOptions = useMemo(() => (suppliers.data ?? []).filter(item => item.isActive), [suppliers.data]);
  const mutation = useMutation({
    mutationFn: () => createContract({
      supplierId: Number(supplierId),
      number: contractNumber.trim(),
      signedAt,
      validUntil: validUntil || null,
      amount: Number(amount),
      note: note.trim() || null,
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['contracts'] });
      void client.invalidateQueries({ queryKey: ['suppliers'] });
      toast('Договор создан в статусе «Черновик»');
      onClose();
    },
  });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!supplierId) return setValidation('Выберите поставщика.');
    if (!contractNumber.trim()) return setValidation('Укажите номер договора.');
    if (!signedAt) return setValidation('Укажите дату подписания.');
    if (validUntil && validUntil < signedAt) return setValidation('Срок действия не может быть раньше подписания.');
    const sum = Number(amount);
    if (amount.trim() === '' || !Number.isFinite(sum) || sum < 0) return setValidation('Укажите неотрицательную сумму договора.');
    mutation.mutate();
  }
  return <form className="procurement-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="form-section-label"><FileText size={15} /> Договор с поставщиком</div>
      <div className="form-grid">
        <div className="field field-wide">
          <label htmlFor="contract-supplier">Поставщик <span>*</span></label>
          <select id="contract-supplier" value={supplierId} onChange={event => setSupplierId(event.target.value)} disabled={suppliers.isPending}>
            <option value="">{suppliers.isPending ? 'Загружаем…' : 'Выберите поставщика'}</option>
            {supplierOptions.map(item => <option key={item.id} value={item.id}>{item.name}{item.inn ? ` · ИНН ${item.inn}` : ''}</option>)}
          </select>
          {suppliers.isError && <span className="field-error">Не удалось загрузить поставщиков.</span>}
          {suppliers.isSuccess && !supplierOptions.length && <span className="field-hint">Поставщиков ещё нет — добавьте их на вкладке «Поставщики».</span>}
        </div>
        <div className="field">
          <label htmlFor="contract-number">Номер договора <span>*</span></label>
          <input id="contract-number" value={contractNumber} maxLength={50} onChange={event => setContractNumber(event.target.value)} autoComplete="off" placeholder="Например, Д-2026/14" />
        </div>
        <div className="field">
          <label htmlFor="contract-amount">Сумма, ₽ <span>*</span></label>
          <input id="contract-amount" type="number" min="0" step="0.01" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0,00" />
        </div>
        <div className="field">
          <label htmlFor="contract-signed">Подписан <span>*</span></label>
          <input id="contract-signed" type="date" value={signedAt} onChange={event => setSignedAt(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="contract-valid">Действует до</label>
          <input id="contract-valid" type="date" value={validUntil} min={signedAt || undefined} onChange={event => setValidUntil(event.target.value)} />
        </div>
        <div className="field field-wide">
          <label htmlFor="contract-note">Примечание</label>
          <textarea id="contract-note" rows={3} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder="Предмет договора и условия поставки" />
        </div>
      </div>
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось создать договор: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions">
      <span className="form-required">* Обязательные поля</span>
      <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
      <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Создать договор</Submitting></Button>
    </div>
  </form>;
}

function TenderForm({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [closesAt, setClosesAt] = useState(() => defaultClosesAt());
  const [budget, setBudget] = useState('');
  const [note, setNote] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => createTender({ title: title.trim(), closesAt: toIsoMoment(closesAt), budget: Number(budget), note: note.trim() || null }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['tenders'] });
      toast('Тендер объявлен');
      onClose();
    },
  });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!title.trim()) return setValidation('Укажите название тендера.');
    if (!closesAt) return setValidation('Укажите срок подачи предложений.');
    const closes = new Date(closesAt);
    if (Number.isNaN(closes.getTime()) || closes.getTime() <= Date.now()) return setValidation('Срок подачи предложений должен быть в будущем.');
    const sum = Number(budget);
    if (budget.trim() === '' || !Number.isFinite(sum) || sum <= 0) return setValidation('Укажите бюджет больше нуля.');
    mutation.mutate();
  }
  return <form className="procurement-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="form-section-label"><Gavel size={15} /> Объявление тендера</div>
      <div className="form-grid">
        <div className="field field-wide">
          <label htmlFor="tender-title">Название <span>*</span></label>
          <input id="tender-title" value={title} maxLength={200} onChange={event => setTitle(event.target.value)} autoComplete="off" placeholder="Например, закупка расходных материалов на IV квартал" />
        </div>
        <div className="field">
          <label htmlFor="tender-budget">Бюджет, ₽ <span>*</span></label>
          <input id="tender-budget" type="number" min="0.01" step="0.01" inputMode="decimal" value={budget} onChange={event => setBudget(event.target.value)} placeholder="0,00" />
        </div>
        <div className="field">
          <label htmlFor="tender-closes">Приём предложений до <span>*</span></label>
          <input id="tender-closes" type="datetime-local" value={closesAt} onChange={event => setClosesAt(event.target.value)} />
        </div>
        <div className="field field-wide">
          <label htmlFor="tender-note">Примечание</label>
          <textarea id="tender-note" rows={3} maxLength={2000} value={note} onChange={event => setNote(event.target.value)} placeholder="Требования к поставщикам и предмет закупки" />
        </div>
      </div>
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось создать тендер: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions">
      <span className="form-required">* Обязательные поля</span>
      <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
      <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Объявить тендер</Submitting></Button>
    </div>
  </form>;
}

function AwardForm({ tender, onClose }: { tender: TenderRow; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const suppliers = useQuery({ queryKey: ['suppliers', 'options'], queryFn: () => listSuppliers() });
  const [supplierId, setSupplierId] = useState(() => tender.winnerSupplierId ? String(tender.winnerSupplierId) : '');
  const [validation, setValidation] = useState<string | null>(null);
  const supplierOptions = useMemo(() => (suppliers.data ?? []).filter(item => item.isActive), [suppliers.data]);
  const mutation = useMutation({
    mutationFn: () => updateTender(tender.id, { status: 'awarded', winnerSupplierId: Number(supplierId) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['tenders'] });
      toast(`Тендер «${tender.title}» присуждён`);
      onClose();
    },
  });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!supplierId) return setValidation('Выберите поставщика-победителя.');
    mutation.mutate();
  }
  return <form className="procurement-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="tender-summary">
        <span className="tender-summary-icon"><Gavel size={18} /></span>
        <div>
          <strong>{tender.title}</strong>
          <span>Бюджет {money(tender.budget)} · приём до {tender.closesAt ? date(tender.closesAt, true) : '—'}</span>
        </div>
      </div>
      <div className="form-section-label"><Truck size={15} /> Победитель</div>
      <div className="form-grid">
        <div className="field field-wide">
          <label htmlFor="award-supplier">Поставщик <span>*</span></label>
          <select id="award-supplier" value={supplierId} onChange={event => setSupplierId(event.target.value)} disabled={suppliers.isPending}>
            <option value="">{suppliers.isPending ? 'Загружаем…' : 'Выберите поставщика'}</option>
            {supplierOptions.map(item => <option key={item.id} value={item.id}>{item.name}{item.inn ? ` · ИНН ${item.inn}` : ''}</option>)}
          </select>
          {suppliers.isError && <span className="field-error">Не удалось загрузить поставщиков.</span>}
        </div>
      </div>
      <p className="field-hint procurement-form-hint">После присуждения тендер получает статус «Присуждён», победитель фиксируется в реестре.</p>
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось присудить тендер: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions">
      <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
      <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Присудить</Submitting></Button>
    </div>
  </form>;
}

function InvoiceForm({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const contracts = useQuery({ queryKey: ['contracts', 'options'], queryFn: () => listContracts() });
  const options = useMemo(() => payloadItems(contracts.data).filter(item => contractIsOpen(item.status)), [contracts.data]);
  const [contractId, setContractId] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [issuedAt, setIssuedAt] = useState(() => todayValue());
  const [dueAt, setDueAt] = useState(() => shiftDate(todayValue(), 30));
  const [amount, setAmount] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => createInvoice({ contractId: Number(contractId), number: invoiceNumber.trim(), issuedAt, dueAt, amount: Number(amount) }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['invoices'] });
      void client.invalidateQueries({ queryKey: ['contracts'] });
      toast('Счёт выставлен');
      onClose();
    },
  });
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!contractId) return setValidation('Выберите договор.');
    if (!invoiceNumber.trim()) return setValidation('Укажите номер счёта.');
    if (!issuedAt) return setValidation('Укажите дату выставления.');
    if (!dueAt) return setValidation('Укажите срок оплаты.');
    if (dueAt < issuedAt) return setValidation('Срок оплаты не может быть раньше выставления.');
    const sum = Number(amount);
    if (amount.trim() === '' || !Number.isFinite(sum) || sum <= 0) return setValidation('Укажите сумму счёта больше нуля.');
    mutation.mutate();
  }
  return <form className="procurement-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="form-section-label"><Receipt size={15} /> Счёт по договору</div>
      <div className="form-grid">
        <div className="field field-wide">
          <label htmlFor="invoice-contract">Договор <span>*</span></label>
          <select id="invoice-contract" value={contractId} onChange={event => setContractId(event.target.value)} disabled={contracts.isPending}>
            <option value="">{contracts.isPending ? 'Загружаем…' : 'Выберите договор'}</option>
            {options.map(item => <option key={item.id} value={item.id}>{item.number} · {item.supplierName}</option>)}
          </select>
          {contracts.isError && <span className="field-error">Не удалось загрузить договоры.</span>}
          {contracts.isSuccess && !options.length && <span className="field-hint">Нет действующих договоров — сначала создайте договор.</span>}
        </div>
        <div className="field">
          <label htmlFor="invoice-number">Номер счёта <span>*</span></label>
          <input id="invoice-number" value={invoiceNumber} maxLength={50} onChange={event => setInvoiceNumber(event.target.value)} autoComplete="off" placeholder="Например, С-1042" />
        </div>
        <div className="field">
          <label htmlFor="invoice-amount">Сумма, ₽ <span>*</span></label>
          <input id="invoice-amount" type="number" min="0.01" step="0.01" inputMode="decimal" value={amount} onChange={event => setAmount(event.target.value)} placeholder="0,00" />
        </div>
        <div className="field">
          <label htmlFor="invoice-issued">Выставлен <span>*</span></label>
          <input id="invoice-issued" type="date" value={issuedAt} onChange={event => setIssuedAt(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="invoice-due">Оплатить до <span>*</span></label>
          <input id="invoice-due" type="date" value={dueAt} min={issuedAt || undefined} onChange={event => setDueAt(event.target.value)} />
        </div>
      </div>
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось выставить счёт: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions">
      <span className="form-required">* Обязательные поля</span>
      <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
      <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Выставить счёт</Submitting></Button>
    </div>
  </form>;
}

/* ------------------------------------------------------------------ */
/* Страница                                                           */
/* ------------------------------------------------------------------ */

export function ProcurementPage() {
  const client = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('contracts');
  const [contractStatus, setContractStatus] = useState('all');
  const [tenderStatus, setTenderStatus] = useState('all');
  const [invoiceStatus, setInvoiceStatus] = useState('all');
  const [supplierSearchInput, setSupplierSearchInput] = useState('');
  const [supplierSearch, setSupplierSearch] = useState('');
  const [creatingSupplier, setCreatingSupplier] = useState(false);
  const [creatingContract, setCreatingContract] = useState(false);
  const [creatingTender, setCreatingTender] = useState(false);
  const [awarding, setAwarding] = useState<TenderRow | null>(null);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setSupplierSearch(supplierSearchInput.trim()), 300); return () => clearTimeout(timer); }, [supplierSearchInput]);

  const contractsQuery = useQuery({
    queryKey: ['contracts', contractStatus],
    queryFn: () => listContracts(contractStatus === 'all' ? {} : { status: contractStatus }),
    enabled: tab === 'contracts',
    placeholderData: keepPreviousData,
  });
  const tendersQuery = useQuery({
    queryKey: ['tenders', tenderStatus],
    queryFn: () => listTenders(tenderStatus === 'all' ? {} : { status: tenderStatus }),
    enabled: tab === 'tenders',
    placeholderData: keepPreviousData,
  });
  const invoicesQuery = useQuery({
    queryKey: ['invoices'],
    queryFn: () => listInvoices(),
    enabled: tab === 'invoices',
    placeholderData: keepPreviousData,
  });
  const suppliersQuery = useQuery({
    queryKey: ['suppliers', supplierSearch],
    queryFn: () => listSuppliers({ search: supplierSearch || undefined }),
    enabled: tab === 'suppliers',
    placeholderData: keepPreviousData,
  });

  // Договор проходит draft → active → closed; закрыть черновик напрямую нельзя.
  const contractAction = useMutation({
    mutationFn: (input: { id: number; status: 'active' | 'closed' }) => patchContractStatus(input.id, input.status),
    onSuccess: (_, input) => {
      void client.invalidateQueries({ queryKey: ['contracts'] });
      toast(input.status === 'closed' ? 'Договор закрыт' : 'Договор активирован');
    },
    onError: error => toast(errorMessage(error), 'error'),
  });
  const tenderAction = useMutation({
    mutationFn: (input: { id: number; status: string }) => updateTender(input.id, { status: input.status }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['tenders'] });
      toast('Статус тендера обновлён');
    },
    onError: error => toast(errorMessage(error), 'error'),
  });
  const pay = useMutation({
    mutationFn: (id: number) => payInvoice(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['invoices'] });
      void client.invalidateQueries({ queryKey: ['contracts'] });
      toast('Счёт оплачен');
    },
    onError: error => toast(errorMessage(error), 'error'),
  });

  const contracts = contractsQuery.data ?? [];
  const tenders = tendersQuery.data ?? [];
  const suppliers = suppliersQuery.data ?? [];
  const today = todayValue();
  // Статус счёта фильтруется на клиенте: «просрочен» — производное состояние,
  // а сервер может называть неоплаченный счёт иначе.
  const invoices = useMemo(() => {
    const all = invoicesQuery.data ?? [];
    if (invoiceStatus === 'all') return all;
    const overdue = (item: InvoiceRow) => !invoiceIsPaid(item.status) && !!item.dueAt && item.dueAt.slice(0, 10) < today;
    if (invoiceStatus === 'paid') return all.filter(item => item.status === 'paid');
    if (invoiceStatus === 'overdue') return all.filter(overdue);
    return all.filter(item => !invoiceIsPaid(item.status) && !overdue(item));
  }, [invoicesQuery.data, invoiceStatus, today]);

  const contractColumns = useMemo<ColumnDef<ContractRow>[]>(() => [
    {
      accessorKey: 'number',
      header: 'Номер',
      cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.number}</strong><span>{row.original.organizationName || `Договор № ${row.original.id}`}</span></div>,
    },
    { accessorKey: 'supplierName', header: 'Поставщик', cell: ({ row }) => <span className="cell-wrap">{row.original.supplierName || '—'}</span> },
    {
      id: 'term',
      header: 'Срок',
      cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.signedAt ? date(row.original.signedAt) : '—'}</strong><span>{row.original.validUntil ? `до ${date(row.original.validUntil)}` : 'Бессрочный'}</span></div>,
    },
    { id: 'amount', header: 'Сумма', cell: ({ row }) => <strong className="procurement-money">{money(row.original.amount)}</strong> },
    { accessorKey: 'status', header: 'Статус', cell: ({ row }) => <Badge status={row.original.status}>{contractStatusLabel(row.original.status)}</Badge> },
    { id: 'invoicesCount', header: 'Счетов', cell: ({ row }) => <span className="procurement-count">{number(row.original.invoicesCount)}</span> },
    {
      id: 'paidAmount',
      header: 'Оплачено',
      cell: ({ row }) => <span className={row.original.paidAmount >= row.original.amount && row.original.amount > 0 ? 'procurement-paid procurement-paid-full' : 'procurement-paid'}>{money(row.original.paidAmount)}</span>,
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const current = row.original.status;
        if (current === 'draft') return <div className="table-actions"><Button variant="secondary" className="procurement-action" disabled={contractAction.isPending} onClick={() => contractAction.mutate({ id: row.original.id, status: 'active' })}>Активировать</Button></div>;
        if (current === 'active') return <div className="table-actions"><Button variant="secondary" className="procurement-action" disabled={contractAction.isPending} onClick={() => contractAction.mutate({ id: row.original.id, status: 'closed' })}>Закрыть</Button></div>;
        return null;
      },
    },
  ], [contractAction]);

  const tenderColumns = useMemo<ColumnDef<TenderRow>[]>(() => [
    {
      accessorKey: 'title',
      header: 'Название',
      cell: ({ row }) => <div className="name-with-meta cell-wrap"><strong>{row.original.title}</strong><span>{row.original.organizationName || `Тендер № ${row.original.id}`}</span></div>,
    },
    { id: 'budget', header: 'Бюджет', cell: ({ row }) => <strong className="procurement-money">{money(row.original.budget)}</strong> },
    { accessorKey: 'closesAt', header: 'Срок', cell: ({ row }) => <span className="cell-date">{row.original.closesAt ? date(row.original.closesAt) : '—'}</span> },
    { accessorKey: 'status', header: 'Статус', cell: ({ row }) => <Badge status={row.original.status}>{tenderStatusLabel(row.original.status)}</Badge> },
    { id: 'winner', header: 'Победитель', cell: ({ row }) => row.original.winnerSupplierName ? <span className="cell-wrap">{row.original.winnerSupplierName}</span> : <span className="muted">Не определён</span> },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const current = row.original.status;
        const canEvaluate = current === 'announced';
        const canAward = current === 'announced' || current === 'evaluating';
        if (!canEvaluate && !canAward) return null;
        return <div className="table-actions">
          {canEvaluate && <Button variant="secondary" className="procurement-action" disabled={tenderAction.isPending} onClick={() => tenderAction.mutate({ id: row.original.id, status: 'evaluating' })}>Провести оценку</Button>}
          {canAward && <Button variant="ghost" className="procurement-action procurement-award" disabled={tenderAction.isPending} onClick={() => setAwarding(row.original)}>Присудить</Button>}
        </div>;
      },
    },
  ], [tenderAction]);

  const invoiceColumns = useMemo<ColumnDef<InvoiceRow>[]>(() => [
    {
      accessorKey: 'number',
      header: 'Номер',
      cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.number}</strong><span>Счёт № {row.original.id}</span></div>,
    },
    { id: 'contract', header: 'Договор', cell: ({ row }) => <span className="cell-wrap">{row.original.contractNumber || (row.original.contractId ? `№ ${row.original.contractId}` : '—')}</span> },
    { accessorKey: 'supplierName', header: 'Поставщик', cell: ({ row }) => <span className="cell-wrap">{row.original.supplierName || '—'}</span> },
    {
      accessorKey: 'dueAt',
      header: 'Срок',
      cell: ({ row }) => {
        const overdue = !invoiceIsPaid(row.original.status) && !!row.original.dueAt && row.original.dueAt.slice(0, 10) < today;
        return <span className={overdue ? 'procurement-due procurement-overdue' : 'procurement-due'}>{row.original.dueAt ? date(row.original.dueAt) : '—'}{overdue ? ' · просрочен' : ''}</span>;
      },
    },
    { id: 'amount', header: 'Сумма', cell: ({ row }) => <strong className="procurement-money">{money(row.original.amount)}</strong> },
    { accessorKey: 'status', header: 'Статус', cell: ({ row }) => <Badge status={row.original.status}>{invoiceStatusLabel(row.original.status)}</Badge> },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => invoiceIsPaid(row.original.status)
        ? null
        : <div className="table-actions"><Button variant="secondary" className="procurement-action" disabled={pay.isPending} onClick={() => pay.mutate(row.original.id)}><Wallet size={14} /> Оплатить</Button></div>,
    },
  ], [pay, today]);

  const supplierColumns = useMemo<ColumnDef<SupplierRow>[]>(() => [
    {
      accessorKey: 'name',
      header: 'Поставщик',
      cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.name}</strong><span>ID {row.original.id}</span></div>,
    },
    { accessorKey: 'inn', header: 'ИНН', cell: ({ row }) => row.original.inn ? <span className="procurement-count">{row.original.inn}</span> : <span className="muted">—</span> },
    { accessorKey: 'contact', header: 'Контакт', cell: ({ row }) => row.original.contact ? <span className="cell-wrap">{row.original.contact}</span> : <span className="muted">—</span> },
    { id: 'status', header: 'Статус', cell: ({ row }) => <Badge status={row.original.isActive ? 'active' : 'inactive'}>{row.original.isActive ? 'Активен' : 'Неактивен'}</Badge> },
  ], []);

  const tabs: { value: Tab; label: string; icon: typeof FileText }[] = [
    { value: 'contracts', label: 'Договоры', icon: FileText },
    { value: 'tenders', label: 'Тендеры', icon: Gavel },
    { value: 'invoices', label: 'Счета', icon: Receipt },
    { value: 'suppliers', label: 'Поставщики', icon: Truck },
  ];

  return <>
    <PageHeading
      eyebrow="Ресурсы / Закупки"
      title="Закупки"
      description="Договоры с поставщиками, тендеры, счета и реестр поставщиков"
    />
    <div className="directory-toolbar procurement-tabs-row">
      <div className="segmented-control" aria-label="Раздел закупок">
        {tabs.map(item => <button key={item.value} type="button" className={tab === item.value ? 'selected' : ''} aria-pressed={tab === item.value} onClick={() => setTab(item.value)}><item.icon size={14} /> {item.label}</button>)}
      </div>
      <span className="table-result-count">Закупки ведутся для учреждения текущей сессии</span>
    </div>

    {tab === 'contracts' && <Panel className="procurement-panel">
      <PanelHeading title="Договоры" subtitle="Поставщик, срок действия, сумма и оплата" trailing={<Button onClick={() => setCreatingContract(true)}><Plus size={16} /> Новый договор</Button>} />
      <div className="table-toolbar table-toolbar-wrap">
        <div className="procurement-status-filter">
          <label htmlFor="contract-status">Статус</label>
          <select id="contract-status" value={contractStatus} onChange={event => setContractStatus(event.target.value)}>
            <option value="all">Все</option>
            <option value="draft">Черновик</option>
            <option value="active">Действует</option>
            <option value="closed">Закрыт</option>
          </select>
        </div>
        <span className="table-result-count">{contractsQuery.isFetching ? 'Обновляем…' : `${number(contracts.length)} договоров`}</span>
      </div>
      {contractsQuery.isPending ? <Loading label="Загружаем договоры" /> : contractsQuery.isError ? <ErrorState error={contractsQuery.error} retry={() => void contractsQuery.refetch()} /> : <DataTable data={contracts} columns={contractColumns} emptyTitle="Договоров пока нет" emptyDescription={contractStatus === 'all' ? 'Создайте первый договор с поставщиком.' : 'Договоров с этим статусом нет — выберите другой статус.'} />}
    </Panel>}

    {tab === 'tenders' && <Panel className="procurement-panel">
      <PanelHeading title="Тендеры" subtitle="Объявление, оценка предложений и присуждение" trailing={<Button onClick={() => setCreatingTender(true)}><Plus size={16} /> Новый тендер</Button>} />
      <div className="table-toolbar table-toolbar-wrap">
        <div className="procurement-status-filter">
          <label htmlFor="tender-status">Статус</label>
          <select id="tender-status" value={tenderStatus} onChange={event => setTenderStatus(event.target.value)}>
            <option value="all">Все</option>
            <option value="announced">Объявлен</option>
            <option value="evaluating">Оценка</option>
            <option value="awarded">Присуждён</option>
            <option value="cancelled">Отменён</option>
          </select>
        </div>
        <span className="table-result-count">{tendersQuery.isFetching ? 'Обновляем…' : `${number(tenders.length)} тендеров`}</span>
      </div>
      {tendersQuery.isPending ? <Loading label="Загружаем тендеры" /> : tendersQuery.isError ? <ErrorState error={tendersQuery.error} retry={() => void tendersQuery.refetch()} /> : <DataTable data={tenders} columns={tenderColumns} emptyTitle="Тендеров пока нет" emptyDescription={tenderStatus === 'all' ? 'Объявите первый тендер на закупку.' : 'Тендеров с этим статусом нет — выберите другой статус.'} />}
    </Panel>}

    {tab === 'invoices' && <Panel className="procurement-panel">
      <PanelHeading title="Счета" subtitle="Счета по договорам, сроки и оплата" trailing={<Button onClick={() => setCreatingInvoice(true)}><Plus size={16} /> Новый счёт</Button>} />
      <div className="table-toolbar table-toolbar-wrap">
        <div className="procurement-status-filter">
          <label htmlFor="invoice-status">Статус</label>
          <select id="invoice-status" value={invoiceStatus} onChange={event => setInvoiceStatus(event.target.value)}>
            <option value="all">Все</option>
            <option value="pending">Ожидают оплаты</option>
            <option value="paid">Оплачены</option>
            <option value="overdue">Просрочены</option>
          </select>
        </div>
        <span className="table-result-count">{invoicesQuery.isFetching ? 'Обновляем…' : `${number(invoices.length)} счетов`}</span>
      </div>
      {invoicesQuery.isPending ? <Loading label="Загружаем счета" /> : invoicesQuery.isError ? <ErrorState error={invoicesQuery.error} retry={() => void invoicesQuery.refetch()} /> : <DataTable data={invoices} columns={invoiceColumns} emptyTitle="Счетов пока нет" emptyDescription={invoiceStatus === 'all' ? 'Выставьте первый счёт по действующему договору.' : 'Счетов с этим статусом нет — выберите другой статус.'} />}
    </Panel>}

    {tab === 'suppliers' && <Panel className="procurement-panel">
      <PanelHeading title="Поставщики" subtitle="Реестр контрагентов и их реквизиты" trailing={<Button onClick={() => setCreatingSupplier(true)}><Plus size={16} /> Добавить поставщика</Button>} />
      <div className="table-toolbar table-toolbar-wrap">
        <div className="search-field"><Search size={17} /><input aria-label="Поиск поставщика" placeholder="Название или ИНН поставщика" value={supplierSearchInput} onChange={event => setSupplierSearchInput(event.target.value)} /></div>
        <span className="table-result-count">{suppliersQuery.isFetching ? 'Обновляем…' : `${number(suppliers.length)} поставщиков`}</span>
      </div>
      {suppliersQuery.isPending ? <Loading label="Загружаем поставщиков" /> : suppliersQuery.isError ? <ErrorState error={suppliersQuery.error} retry={() => void suppliersQuery.refetch()} /> : <DataTable data={suppliers} columns={supplierColumns} emptyTitle={supplierSearch ? 'Поставщики не найдены' : 'Поставщиков пока нет'} emptyDescription={supplierSearch ? 'Попробуйте другое название или ИНН.' : 'Добавьте первого поставщика — затем оформляйте договоры.'} />}
    </Panel>}

    {creatingSupplier && <MedcoreDialog open onClose={() => setCreatingSupplier(false)} title="Добавить поставщика" description="Название, ИНН и контактные данные" eyebrow="Закупки / Поставщик">
      <SupplierForm onClose={() => setCreatingSupplier(false)} />
    </MedcoreDialog>}
    {creatingContract && <MedcoreDialog open onClose={() => setCreatingContract(false)} title="Новый договор" description="Поставщик, номер, срок действия и сумма" eyebrow="Закупки / Договор">
      <ContractForm onClose={() => setCreatingContract(false)} />
    </MedcoreDialog>}
    {creatingTender && <MedcoreDialog open onClose={() => setCreatingTender(false)} title="Новый тендер" description="Название, бюджет и срок приёма предложений" eyebrow="Закупки / Тендер">
      <TenderForm onClose={() => setCreatingTender(false)} />
    </MedcoreDialog>}
    {awarding && <MedcoreDialog open onClose={() => setAwarding(null)} title="Присудить тендер" description="Выберите поставщика-победителя" eyebrow="Закупки / Тендер">
      <AwardForm tender={awarding} onClose={() => setAwarding(null)} />
    </MedcoreDialog>}
    {creatingInvoice && <MedcoreDialog open onClose={() => setCreatingInvoice(false)} title="Новый счёт" description="Договор, номер, срок оплаты и сумма" eyebrow="Закупки / Счёт">
      <InvoiceForm onClose={() => setCreatingInvoice(false)} />
    </MedcoreDialog>}
  </>;
}
