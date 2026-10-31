import { useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { Boxes, ClipboardList, Package, Plus, Search, TriangleAlert, X } from 'lucide-react';
import { createSupplyOrder, errorMessage, listDeficitSupplies, listSupplies, listSupplyOrders, receiveSupplyOrder } from '../api';
import { useAuth } from '../auth';
import { date, hasRole, number } from '../format';
import type { SupplyOrderRow, SupplyRow } from '../types';
import { Badge, Button, DataTable, ErrorState, Loading, PageHeading, Panel, PanelHeading, Submitting, useToast } from '../components/ui';
import { MedcoreDialog } from '../components/MedcoreDialog';
import './Supplies.css';

const categoryNames: Record<string, string> = { medicine: 'Лекарства', consumable: 'Расходники' };
const orderStatusNames: Record<string, string> = { ordered: 'Заказан', received: 'Принят', cancelled: 'Отменён' };
const categoryLabel = (category: string) => categoryNames[category] || category || '—';
const orderStatusLabel = (status: string) => orderStatusNames[status] || status;
const manageRoles = ['organization_admin', 'chief_physician', 'deputy_chief_physician'] as const;

const money = (value: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(value);
const quantity = (value: number) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value);

interface OrderLine { key: number; itemId: string; quantity: string; unitPrice: string }

function SupplyOrderForm({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const supplies = useQuery({ queryKey: ['supplies', 'order-items'], queryFn: () => listSupplies() });
  const options = supplies.data ?? [];
  const nextKey = useRef(2);
  const [supplier, setSupplier] = useState('');
  const [expectedAt, setExpectedAt] = useState('');
  const [lines, setLines] = useState<OrderLine[]>([{ key: 1, itemId: '', quantity: '1', unitPrice: '' }]);
  const [validation, setValidation] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: (items: { itemId: number; quantity: number; unitPrice: number }[]) => createSupplyOrder({ supplier: supplier.trim(), expectedAt: expectedAt || null, items }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['supply-orders'] });
      void client.invalidateQueries({ queryKey: ['supplies'] });
      toast('Заказ на снабжение создан');
      onClose();
    },
  });
  function updateLine(key: number, patch: Partial<OrderLine>) {
    setLines(previous => previous.map(line => line.key === key ? { ...line, ...patch } : line));
  }
  function addLine() {
    setLines(previous => [...previous, { key: nextKey.current++, itemId: '', quantity: '1', unitPrice: '' }]);
  }
  function removeLine(key: number) {
    setLines(previous => previous.length > 1 ? previous.filter(line => line.key !== key) : previous);
  }
  function submit() {
    setValidation(null);
    mutation.reset();
    if (!supplier.trim()) return setValidation('Укажите поставщика.');
    if (!expectedAt) return setValidation('Укажите ожидаемый срок поставки.');
    const items: { itemId: number; quantity: number; unitPrice: number }[] = [];
    for (const line of lines) {
      const touched = !!line.itemId || line.unitPrice.trim() !== '' || line.quantity !== '1';
      if (!touched) continue;
      if (!line.itemId) return setValidation('Выберите позицию в каждой строке заказа.');
      const amount = Number(line.quantity);
      const price = Number(line.unitPrice);
      if (!Number.isFinite(amount) || amount <= 0) return setValidation('Количество должно быть больше нуля.');
      if (line.unitPrice.trim() === '' || !Number.isFinite(price) || price < 0) return setValidation('Укажите неотрицательную цену позиции.');
      if (items.some(item => item.itemId === Number(line.itemId))) return setValidation('Позиции заказа не должны повторяться.');
      items.push({ itemId: Number(line.itemId), quantity: amount, unitPrice: price });
    }
    if (!items.length) return setValidation('Добавьте хотя бы одну позицию заказа.');
    mutation.mutate(items);
  }
  const preview = lines.reduce((sum, line) => {
    const amount = Number(line.quantity);
    const price = Number(line.unitPrice);
    return sum + (Number.isFinite(amount) && Number.isFinite(price) ? amount * price : 0);
  }, 0);
  return <form className="supply-form" onSubmit={event => { event.preventDefault(); submit(); }} noValidate>
    <fieldset disabled={mutation.isPending}>
      <div className="form-section-label"><Package size={15} /> Поставщик и срок</div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="order-supplier">Поставщик <span>*</span></label>
          <input id="order-supplier" value={supplier} onChange={event => setSupplier(event.target.value)} autoComplete="off" placeholder="Название поставщика" />
        </div>
        <div className="field">
          <label htmlFor="order-expected">Ожидаемая поставка <span>*</span></label>
          <input id="order-expected" type="date" value={expectedAt} onChange={event => setExpectedAt(event.target.value)} />
        </div>
      </div>
      <div className="form-section-label form-section-next"><ClipboardList size={15} /> Позиции заказа</div>
      <div className="supply-lines">
        {lines.map((line, index) => <div className="supply-line" key={line.key}>
          <div className="field supply-line-item">
            <label htmlFor={`order-item-${line.key}`}>Позиция {index + 1} <span>*</span></label>
            <select id={`order-item-${line.key}`} value={line.itemId} onChange={event => updateLine(line.key, { itemId: event.target.value })} disabled={supplies.isPending}>
              <option value="">{supplies.isPending ? 'Загружаем…' : 'Выберите позицию'}</option>
              {options.map(item => <option key={item.id} value={item.id}>{item.name}{item.unit ? ` · ${item.unit}` : ''}</option>)}
            </select>
            {index === 0 && supplies.isError && <span className="field-error">Не удалось загрузить перечень позиций.</span>}
          </div>
          <div className="field">
            <label htmlFor={`order-quantity-${line.key}`}>Количество <span>*</span></label>
            <input id={`order-quantity-${line.key}`} type="number" min="0.01" step="0.01" inputMode="decimal" value={line.quantity} onChange={event => updateLine(line.key, { quantity: event.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={`order-price-${line.key}`}>Цена, ₽ <span>*</span></label>
            <input id={`order-price-${line.key}`} type="number" min="0" step="0.01" inputMode="decimal" value={line.unitPrice} onChange={event => updateLine(line.key, { unitPrice: event.target.value })} placeholder="0,00" />
          </div>
          <button type="button" className="icon-button supply-line-remove" aria-label={`Удалить позицию ${index + 1}`} title="Удалить позицию" disabled={lines.length === 1} onClick={() => removeLine(line.key)}><X size={16} /></button>
        </div>)}
      </div>
      <div className="supply-lines-foot">
        <Button variant="secondary" type="button" onClick={addLine}><Plus size={15} /> Добавить позицию</Button>
        <span className="supply-order-total">Сумма заказа <strong>{money(preview)}</strong></span>
      </div>
      {supplies.isError && <p className="field-hint supply-form-hint">Перечень позиций недоступен: заказ можно оформить после восстановления доступа к остаткам.</p>}
    </fieldset>
    {validation && <div className="form-error" role="alert">{validation}</div>}
    {mutation.isError && <div className="form-error" role="alert">Не удалось создать заказ: {errorMessage(mutation.error)}</div>}
    <div className="dialog-actions">
      <span className="form-required">Заказ оформляется для учреждения текущей сессии</span>
      <Button variant="secondary" type="button" disabled={mutation.isPending} onClick={onClose}>Отмена</Button>
      <Button type="submit" disabled={mutation.isPending}><Submitting busy={mutation.isPending}>Создать заказ</Submitting></Button>
    </div>
  </form>;
}

export function SuppliesPage() {
  const { user } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'stock' | 'orders'>('stock');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<'all' | 'medicine' | 'consumable'>('all');
  const [deficitOnly, setDeficitOnly] = useState(false);
  const [orderStatus, setOrderStatus] = useState<'all' | 'ordered' | 'received' | 'cancelled'>('all');
  const [ordering, setOrdering] = useState(false);
  const canManage = !!user && hasRole(user.roles, [...manageRoles]);
  useEffect(() => { const timer = setTimeout(() => setSearch(searchInput.trim()), 300); return () => clearTimeout(timer); }, [searchInput]);
  const stock = useQuery({
    queryKey: ['supplies', search, category],
    queryFn: () => listSupplies({ search: search || undefined, category: category === 'all' ? undefined : category }),
    placeholderData: keepPreviousData,
  });
  const deficit = useQuery({ queryKey: ['supplies', 'deficit'], queryFn: listDeficitSupplies });
  const orders = useQuery({ queryKey: ['supply-orders'], queryFn: listSupplyOrders });
  const receive = useMutation({
    mutationFn: (id: number) => receiveSupplyOrder(id),
    onSuccess: (_, id) => {
      void client.invalidateQueries({ queryKey: ['supply-orders'] });
      void client.invalidateQueries({ queryKey: ['supplies'] });
      toast(`Заказ № ${id} принят на склад`);
    },
    onError: error => toast(errorMessage(error), 'error'),
  });
  const stockItems = stock.data ?? [];
  const visibleStock = deficitOnly ? stockItems.filter(item => item.deficit > 0) : stockItems;
  const deficitCount = deficit.data?.length ?? 0;
  const orderItems = useMemo(() => {
    const all = orders.data ?? [];
    return orderStatus === 'all' ? all : all.filter(item => item.status === orderStatus);
  }, [orders.data, orderStatus]);
  const stockColumns = useMemo<ColumnDef<SupplyRow>[]>(() => [
    { accessorKey: 'name', header: 'Наименование', cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.name}</strong><span>{row.original.code || 'Без кода'}</span></div> },
    { accessorKey: 'category', header: 'Категория', cell: ({ row }) => <span className="cell-wrap">{categoryLabel(row.original.category)}</span> },
    { accessorKey: 'unit', header: 'Единица', cell: ({ row }) => <span className="cell-date">{row.original.unit}</span> },
    { id: 'quantity', header: 'Остаток', cell: ({ row }) => <span className={row.original.deficit > 0 ? 'stock-quantity stock-low' : 'stock-quantity'}>{quantity(row.original.quantity)}</span> },
    { id: 'minQuantity', header: 'Минимум', cell: ({ row }) => <span className="stock-quantity">{quantity(row.original.minQuantity)}</span> },
    { id: 'deficit', header: 'Дефицит', cell: ({ row }) => row.original.deficit > 0
      ? <span className="stock-deficit"><TriangleAlert size={13} /> {quantity(row.original.deficit)} {row.original.unit}</span>
      : <span className="muted">—</span> },
  ], []);
  const orderColumns = useMemo<ColumnDef<SupplyOrderRow>[]>(() => [
    { accessorKey: 'supplier', header: 'Поставщик', cell: ({ row }) => <div className="name-with-meta"><strong>{row.original.supplier}</strong><span>Заказ № {row.original.id}</span></div> },
    { accessorKey: 'status', header: 'Статус', cell: ({ row }) => <Badge status={row.original.status}>{orderStatusLabel(row.original.status)}</Badge> },
    { accessorKey: 'orderedAt', header: 'Оформлен', cell: ({ row }) => <span className="cell-date">{date(row.original.orderedAt)}</span> },
    { accessorKey: 'expectedAt', header: 'Срок поставки', cell: ({ row }) => <span className="cell-date">{row.original.expectedAt ? date(row.original.expectedAt) : '—'}</span> },
    { id: 'itemCount', header: 'Позиций', cell: ({ row }) => <span className="cell-date">{number(row.original.itemCount)}</span> },
    { id: 'total', header: 'Сумма', cell: ({ row }) => <strong className="supply-order-sum">{money(row.original.total)}</strong> },
    { id: 'actions', header: '', cell: ({ row }) => <div className="table-actions">{canManage && row.original.status === 'ordered' && <Button variant="secondary" className="supply-receive" disabled={receive.isPending} onClick={() => receive.mutate(row.original.id)}>Принять</Button>}</div> },
  ], [canManage, receive]);
  return <>
    <PageHeading eyebrow="Ресурсы / Снабжение" title="Снабжение" description="Остатки лекарств и расходников, дефицит и заказы на поставку" />
    <div className="directory-toolbar supplies-tabs-row">
      <div className="segmented-control" aria-label="Раздел снабжения">
        <button type="button" className={tab === 'stock' ? 'selected' : ''} aria-pressed={tab === 'stock'} onClick={() => setTab('stock')}><Boxes size={14} /> Остатки</button>
        <button type="button" className={tab === 'orders' ? 'selected' : ''} aria-pressed={tab === 'orders'} onClick={() => setTab('orders')}><ClipboardList size={14} /> Заказы</button>
      </div>
      <span className="table-result-count">{deficitCount > 0 ? `Ниже минимума: ${number(deficitCount)}` : 'Все остатки выше минимума'}</span>
    </div>
    {tab === 'stock' ? <Panel className="supplies-panel">
      <div className="table-toolbar table-toolbar-wrap">
        <div className="search-field"><Search size={17} /><input aria-label="Поиск позиции снабжения" placeholder="Наименование или код позиции" value={searchInput} onChange={event => setSearchInput(event.target.value)} /></div>
        <div className="segmented-control" aria-label="Категория позиции">
          {([{ value: 'all', label: 'Все' }, { value: 'medicine', label: 'Лекарства' }, { value: 'consumable', label: 'Расходники' }] as const).map(item => <button key={item.value} type="button" className={category === item.value ? 'selected' : ''} aria-pressed={category === item.value} onClick={() => setCategory(item.value)}>{item.label}</button>)}
        </div>
        <span className="table-result-count">{stock.isFetching ? 'Обновляем…' : `${number(visibleStock.length)} позиций`}</span>
      </div>
      {deficitCount > 0 && <div className="supplies-deficit-note"><TriangleAlert size={15} /><span>Позиции ниже минимального остатка: <strong>{number(deficitCount)}</strong>. Своевременный заказ предупредит перебои.</span><Button variant="ghost" onClick={() => setDeficitOnly(value => !value)}>{deficitOnly ? 'Показать все' : 'Только дефицит'}</Button></div>}
      {stock.isPending ? <Loading label="Загружаем остатки" /> : stock.isError ? <ErrorState error={stock.error} retry={() => void stock.refetch()} /> : <DataTable data={visibleStock} columns={stockColumns} emptyTitle={deficitOnly ? 'Дефицита нет' : search ? 'Позиции не найдены' : 'Остатков пока нет'} emptyDescription={deficitOnly ? 'Все остатки соответствуют минимальному уровню.' : search ? 'Попробуйте другое наименование, код или категорию.' : 'Остатки появятся после приёмки первого заказа.'} />}
    </Panel> : <Panel className="supplies-panel">
      <PanelHeading title="Заказы на снабжение" subtitle="Поставщик, статус, срок поставки и сумма заказа" trailing={canManage && <Button onClick={() => setOrdering(true)}><Plus size={16} /> Новый заказ</Button>} />
      <div className="table-toolbar table-toolbar-wrap">
        <div className="segmented-control" aria-label="Статус заказа">
          {([{ value: 'all', label: 'Все' }, { value: 'ordered', label: 'Заказаны' }, { value: 'received', label: 'Приняты' }, { value: 'cancelled', label: 'Отменены' }] as const).map(item => <button key={item.value} type="button" className={orderStatus === item.value ? 'selected' : ''} aria-pressed={orderStatus === item.value} onClick={() => setOrderStatus(item.value)}>{item.label}</button>)}
        </div>
        <span className="table-result-count">{orders.isFetching ? 'Обновляем…' : `${number(orderItems.length)} заказов`}</span>
      </div>
      {orders.isPending ? <Loading label="Загружаем заказы" /> : orders.isError ? <ErrorState error={orders.error} retry={() => void orders.refetch()} /> : <DataTable data={orderItems} columns={orderColumns} emptyTitle="Заказов нет" emptyDescription={canManage ? 'Оформите первый заказ на поставку.' : 'Заказы на поставку ещё не оформлялись.'} />}
    </Panel>}
    {ordering && <MedcoreDialog open wide onClose={() => setOrdering(false)} eyebrow="Снабжение / Заказ" title="Новый заказ на снабжение" description="Поставщик, срок поставки и перечень позиций с количеством и ценой">
      <SupplyOrderForm onClose={() => setOrdering(false)} />
    </MedcoreDialog>}
  </>;
}
