import React, { useState } from 'react';
import {
  CheckCircle2,
  Edit3,
  Package,
  Plus,
  Power,
  Printer,
  QrCode,
  Search,
  Trash2,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { apiMutate } from '../services/api';
import type {
  CostingMethod,
  InventoryLot,
  ItemMaster,
  ProcessGrade,
  ProductCategory,
  ProductUnit,
} from '../types/erp';
import { StockBatchQrModal } from './StockBatchQrModal';

interface ProductsPageProps {
  items: ItemMaster[];
  categories: ProductCategory[];
  units: ProductUnit[];
  lots: InventoryLot[];
  hideFinancials?: boolean;
  onRefresh: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

export const ProductsPage: React.FC<ProductsPageProps> = ({
  items,
  categories,
  units,
  lots,
  hideFinancials = false,
  onRefresh,
  onNotify,
}) => {
  const { lang, t } = useI18n();
  const isBn = lang === 'bn';
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ItemMaster | null>(null);
  const [qrModalState, setQrModalState] = useState<{ lots: InventoryLot[]; title: string } | null>(null);

  const defaultFallbackCategories: ProductCategory[] = [
    { id: -1, code: 'PADDY', name: lang === 'bn' ? 'কাঁচা ধান (Raw Paddy)' : 'Raw Paddy (PADDY)', group_type: 'RAW_MATERIAL', default_costing_method: 'FIFO', is_active: true },
    { id: -2, code: 'HEAD_RICE', name: lang === 'bn' ? 'মূল চাল (Head Rice)' : 'Head Rice (HEAD_RICE)', group_type: 'FINISHED_GOOD', default_costing_method: 'FIFO', is_active: true },
    { id: -3, code: 'BROKEN_RICE', name: lang === 'bn' ? 'ভাঙা চাল / খুদ' : 'Broken Rice (BROKEN_RICE)', group_type: 'BY_PRODUCT', default_costing_method: 'WEIGHTED_AVERAGE', is_active: true },
    { id: -4, code: 'BRAN', name: lang === 'bn' ? 'চালের কুঁড়া' : 'Rice Bran (BRAN)', group_type: 'BY_PRODUCT', default_costing_method: 'WEIGHTED_AVERAGE', is_active: true },
    { id: -5, code: 'HUSK', name: lang === 'bn' ? 'তুষ (Husk)' : 'Paddy Husk (HUSK)', group_type: 'BY_PRODUCT', default_costing_method: 'WEIGHTED_AVERAGE', is_active: true },
  ];
  const defaultFallbackUnits: ProductUnit[] = [
    { id: -1, code: 'KG', name: lang === 'bn' ? 'কিলোগ্রাম' : 'Kilogram', symbol: 'kg', base_weight_kg: 1, is_active: true },
    { id: -2, code: 'BAG50', name: lang === 'bn' ? '৫০ কেজি বস্তা' : '50 kg Bag', symbol: 'bag', base_weight_kg: 50, is_active: true },
    { id: -3, code: 'QTL', name: lang === 'bn' ? 'কুইন্টাল (১০০ কেজি)' : 'Quintal (100 kg)', symbol: 'qtl', base_weight_kg: 100, is_active: true },
    { id: -4, code: 'MT', name: lang === 'bn' ? 'মেট্রিক টন (১০০০ কেজি)' : 'Metric Ton (1000 kg)', symbol: 'MT', base_weight_kg: 1000, is_active: true },
  ];

  const activeCategories = categories.filter((c) => Boolean(c.is_active));
  const activeUnits = units.filter((u) => Boolean(u.is_active));
  const availableCategories = activeCategories.length > 0 ? activeCategories : defaultFallbackCategories;
  const availableUnits = activeUnits.length > 0 ? activeUnits : defaultFallbackUnits;

  const [form, setForm] = useState({
    sku: '',
    name: '',
    category: availableCategories[0]?.code || 'PADDY',
    process_grade: (availableCategories[0]?.group_type === 'RAW_MATERIAL' ? 'RAW_PADDY' : 'SIDDHO') as ProcessGrade,
    unit: availableUnits[0]?.code || 'KG',
    bag_weight_kg: 50,
    costing_method: 'FIFO' as CostingMethod,
    default_rate: 0,
    is_active: true,
  });

  const activeCount = items.filter((i) => Boolean(i.is_active)).length;
  const stockByItem = lots.reduce<Record<number, { qty: number; value: number }>>((acc, l) => {
    const prev = acc[l.item_id] || { qty: 0, value: 0 };
    acc[l.item_id] = {
      qty: prev.qty + Number(l.remaining_qty_kg || 0),
      value: prev.value + Number(l.remaining_qty_kg || 0) * Number(l.unit_cost_per_kg || 0),
    };
    return acc;
  }, {});

  const categoryNameMap = categories.reduce<Record<string, string>>((acc, c) => {
    acc[c.code] = c.name;
    return acc;
  }, {});

  const unitMap = units.reduce<Record<string, ProductUnit>>((acc, u) => {
    acc[u.code] = u;
    return acc;
  }, {});

  const filtered = items.filter((i) => {
    const active = Boolean(i.is_active);
    if (statusFilter === 'ACTIVE' && !active) return false;
    if (statusFilter === 'INACTIVE' && active) return false;
    if (catFilter !== 'ALL' && i.category !== catFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q);
  });

  const handleOpenProductBatchQr = (item: ItemMaster) => {
    const itemLots = lots.filter((l) => l.item_id === item.id);
    const activeItemLots = itemLots.filter((l) => Number(l.remaining_qty_kg || 0) > 0);
    const targetLots = activeItemLots.length > 0 ? activeItemLots : itemLots;
    if (targetLots.length === 0) {
      onNotify(
        isBn
          ? `"${item.name}"-এর জন্য কোনো স্টক ব্যাচ (লট) এখনো তৈরি হয়নি।`
          : `No stock batches found yet for "${item.name}".`,
        'warn'
      );
      return;
    }
    setQrModalState({
      lots: targetLots,
      title: isBn
        ? `${item.name} (${item.sku}) — স্টক ব্যাচ QR (${targetLots.length}টি)`
        : `${item.name} (${item.sku}) — Stock Batch QRs (${targetLots.length})`,
    });
  };

  const filteredActiveLots = lots.filter(
    (l) => Number(l.remaining_qty_kg || 0) > 0 && filtered.some((i) => i.id === l.item_id)
  );

  const handleOpenAllFilteredBatchQr = () => {
    if (filteredActiveLots.length === 0) {
      onNotify(
        isBn ? 'ফিল্টারকৃত পণ্যগুলোতে সক্রিয় স্টক ব্যাচ নেই।' : 'No active stock batches found for filtered products.',
        'warn'
      );
      return;
    }
    setQrModalState({
      lots: filteredActiveLots,
      title: isBn
        ? `সক্রিয় স্টক ব্যাচ QR লেবেল (${filteredActiveLots.length}টি ব্যাচ)`
        : `Active Stock Batch QR Labels (${filteredActiveLots.length} Batches)`,
    });
  };

  const openAdd = () => {
    const defaultCat = availableCategories[0];
    const defaultUnit = availableUnits[0];
    setEditingId(null);
    setForm({
      sku: '',
      name: '',
      category: defaultCat?.code || 'PADDY',
      process_grade: defaultCat?.group_type === 'RAW_MATERIAL' || defaultCat?.code === 'PADDY' ? 'RAW_PADDY' : 'SIDDHO',
      unit: defaultUnit?.code || 'KG',
      bag_weight_kg: defaultUnit && defaultUnit.base_weight_kg > 1 ? defaultUnit.base_weight_kg : 50,
      costing_method: defaultCat?.default_costing_method || 'FIFO',
      default_rate: 0,
      is_active: true,
    });
    setShowForm(true);
  };

  const openEdit = (item: ItemMaster) => {
    setEditingId(item.id);
    setForm({
      sku: item.sku,
      name: item.name,
      category: item.category,
      process_grade: item.process_grade,
      unit: item.unit || 'KG',
      bag_weight_kg: item.bag_weight_kg,
      costing_method: item.costing_method,
      default_rate: item.default_rate,
      is_active: Boolean(item.is_active),
    });
    setShowForm(true);
  };

  const handleCategoryChange = (catCode: string) => {
    const found = availableCategories.find((c) => c.code === catCode) || categories.find((c) => c.code === catCode);
    setForm((prev) => ({
      ...prev,
      category: catCode,
      costing_method: !editingId && found ? found.default_costing_method : prev.costing_method,
      process_grade:
        !editingId && found
          ? found.group_type === 'RAW_MATERIAL' || found.code === 'PADDY'
            ? 'RAW_PADDY'
            : found.group_type === 'BY_PRODUCT'
            ? 'BY_PRODUCT'
            : 'SIDDHO'
          : prev.process_grade,
    }));
  };

  const handleUnitChange = (unitCode: string) => {
    const found = units.find((u) => u.code === unitCode);
    setForm((prev) => ({
      ...prev,
      unit: unitCode,
      bag_weight_kg: found && found.base_weight_kg > 1 ? found.base_weight_kg : prev.bag_weight_kg,
    }));
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingId) {
        await apiMutate({
          endpoint: `/api/v1/items/${editingId}`,
          method: 'PUT',
          payload: form,
          module: 'Product Master',
          summary: `Update product ${form.name}`,
        });
        onNotify(lang === 'bn' ? `পণ্য "${form.name}" আপডেট হয়েছে।` : `Product "${form.name}" updated.`, 'ok');
      } else {
        await apiMutate({
          endpoint: '/api/v1/items',
          method: 'POST',
          payload: form,
          module: 'Product Master',
          summary: `Add product ${form.name}`,
        });
        onNotify(lang === 'bn' ? `পণ্য "${form.name}" যোগ করা হয়েছে।` : `Product "${form.name}" added.`, 'ok');
      }
      setShowForm(false);
      setEditingId(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const handleToggleStatus = async (item: ItemMaster) => {
    const nextActive = !Boolean(item.is_active);
    try {
      await apiMutate({
        endpoint: `/api/v1/items/${item.id}/status`,
        method: 'PATCH',
        payload: { is_active: nextActive },
        module: 'Product Status',
        summary: `${nextActive ? 'Activate' : 'Deactivate'} ${item.sku}`,
      });
      onNotify(
        lang === 'bn'
          ? `পণ্য "${item.name}" এখন ${nextActive ? t('common.active') : t('common.inactive')}।`
          : `Product "${item.name}" is now ${nextActive ? 'Active' : 'Inactive'}.`,
        'ok'
      );
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const executeDelete = async () => {
    if (!confirmDelete) return;
    try {
      await apiMutate({
        endpoint: `/api/v1/items/${confirmDelete.id}`,
        method: 'DELETE',
        payload: {},
        module: 'Delete Product',
        summary: `Delete product ${confirmDelete.name}`,
      });
      onNotify(lang === 'bn' ? `পণ্য "${confirmDelete.name}" মুছে ফেলা হয়েছে।` : `Product "${confirmDelete.name}" deleted.`, 'ok');
      setConfirmDelete(null);
      onRefresh();
    } catch (err) {
      setConfirmDelete(null);
      onNotify((err as Error).message, 'err');
    }
  };

  const selectableCategories =
    availableCategories.some((c) => c.code === form.category) || !form.category
      ? availableCategories
      : [...availableCategories, ...categories.filter((c) => c.code === form.category)];

  const selectableUnits =
    availableUnits.some((u) => u.code === form.unit) || !form.unit
      ? availableUnits
      : [...availableUnits, ...units.filter((u) => u.code === form.unit)];

  return (
    <div className="space-y-5">
      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('prod.total')}</div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums mt-1">{items.length}</div>
          <div className="text-xs text-slate-500 mt-1">
            {activeCount} {t('common.active')} · {items.length - activeCount} {t('common.inactive')}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('prod.activeCats')}</div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums mt-1">{activeCategories.length}</div>
          <div className="text-xs text-slate-500 mt-1">{t('prod.outOfDefined', { count: categories.length })}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('prod.activeUnits')}</div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums mt-1">{activeUnits.length}</div>
          <div className="text-xs text-slate-500 mt-1">{t('prod.outOfConfigured', { count: units.length })}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('prod.inStock')}</div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums mt-1">
            {items.filter((i) => (stockByItem[i.id]?.qty || 0) > 0).length}
          </div>
          <div className="text-xs text-slate-500 mt-1">{t('prod.inStockDesc')}</div>
        </div>
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('prod.searchPlaceholder')}
              className="pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-60"
            />
          </div>

          <select
            value={catFilter}
            onChange={(e) => setCatFilter(e.target.value)}
            className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            <option value="ALL">{t('inv.allCategories')}</option>
            {categories.map((c) => (
              <option key={c.id} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
            {(['ALL', 'ACTIVE', 'INACTIVE'] as const).map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                  statusFilter === st
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {st === 'ALL' ? t('common.all') : st === 'ACTIVE' ? t('common.active') : t('common.inactive')}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleOpenAllFilteredBatchQr}
            disabled={filteredActiveLots.length === 0}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-45 text-xs font-medium whitespace-nowrap"
          >
            <Printer className="w-3.5 h-3.5 text-amber-600" />
            <span>
              {isBn
                ? `স্টক ব্যাচ QR প্রিন্ট (${filteredActiveLots.length})`
                : `Print Batch QRs (${filteredActiveLots.length})`}
            </span>
          </button>

          <button
            onClick={showForm ? () => setShowForm(false) : openAdd}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{showForm ? t('common.closeForm') : t('prod.addBtn')}</span>
          </button>
        </div>
      </div>

      {/* Add / Edit Form */}
      {showForm && (
        <form
          onSubmit={handleSave}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
        >
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
            <h3 className="text-sm font-display font-semibold">
              {editingId ? t('prod.editTitle') : t('prod.addTitle')}
            </h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">{t('prod.sku')}</label>
              <input
                type="text"
                required
                placeholder=""
                value={form.sku}
                onChange={(e) => setForm({ ...form, sku: e.target.value })}
                className="w-full px-3 py-2 text-xs font-mono uppercase rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-medium mb-1">{t('prod.name')}</label>
              <input
                type="text"
                required
                placeholder=""
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('prod.category')}</label>
              <select
                value={form.category}
                onChange={(e) => handleCategoryChange(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {selectableCategories.map((c) => (
                  <option key={c.id} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('prod.grade')}</label>
              <select
                value={form.process_grade}
                onChange={(e) => setForm({ ...form, process_grade: e.target.value as ProcessGrade })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="RAW_PADDY">{t('prod.grade.RAW_PADDY')}</option>
                <option value="SIDDHO">{t('prod.grade.SIDDHO')}</option>
                <option value="ATAP">{t('prod.grade.ATAP')}</option>
                <option value="BY_PRODUCT">{t('prod.grade.BY_PRODUCT')}</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('prod.unit')}</label>
              <select
                value={form.unit}
                onChange={(e) => handleUnitChange(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {selectableUnits.map((u) => (
                  <option key={u.id} value={u.code}>
                    {u.code} — {u.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('prod.bagWeight')}</label>
              <input
                type="number"
                required
                min="0.01"
                step="0.01"
                value={form.bag_weight_kg}
                onChange={(e) => setForm({ ...form, bag_weight_kg: Number(e.target.value) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('prod.costing')}</label>
              <select
                value={form.costing_method}
                onChange={(e) => setForm({ ...form, costing_method: e.target.value as CostingMethod })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="FIFO">FIFO</option>
                <option value="WEIGHTED_AVERAGE">Weighted Average</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('prod.defaultRate')}</label>
              <input
                type="number"
                required
                min="0"
                step="0.01"
                value={form.default_rate}
                onChange={(e) => setForm({ ...form, default_rate: Number(e.target.value) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <div className="md:col-span-3 flex items-end pb-1">
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                  className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                />
                <span>{t('prod.activeLabel')}</span>
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setEditingId(null);
              }}
              className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium"
            >
              {editingId ? t('common.saveChanges') : t('prod.createBtn')}
            </button>
          </div>
        </form>
      )}

      {/* Products Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="text-left px-4 py-3 font-medium">{t('prod.sku')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('prod.name')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('prod.category')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('prod.grade')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('prod.thUnitPack')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('prod.defaultRate')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('prod.thLiveStock')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('common.status')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                    {t('prod.empty')}
                  </td>
                </tr>
              ) : (
                filtered.map((item) => {
                  const active = Boolean(item.is_active);
                  const stock = stockByItem[item.id]?.qty || 0;
                  const unitObj = unitMap[item.unit];
                  return (
                    <tr
                      key={item.id}
                      className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 ${!active ? 'opacity-65' : ''}`}
                    >
                      <td className="px-4 py-3 font-mono font-medium text-slate-900 dark:text-white">
                        <div className="inline-flex items-center gap-2">
                          <Package className="w-3.5 h-3.5 text-slate-400" />
                          <span>{item.sku}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-medium text-slate-900 dark:text-white">{item.name}</td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">
                        {categoryNameMap[item.category] || item.category}
                      </td>
                      <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{t(`prod.grade.${item.process_grade}`) || item.process_grade}</td>
                      <td className="px-4 py-3 font-mono tabular-nums text-slate-600 dark:text-slate-300">
                        {unitObj ? `${unitObj.symbol}` : item.unit} · {item.bag_weight_kg} {t('common.kg')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        ৳{Number(item.default_rate).toFixed(2)}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-medium">
                        {stock.toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex items-center gap-1 font-medium ${
                            active ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-400'
                          }`}
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>{active ? t('common.active') : t('common.inactive')}</span>
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleOpenProductBatchQr(item)}
                            className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1 whitespace-nowrap text-slate-700 dark:text-slate-200"
                            title={isBn ? 'স্টক ব্যাচ QR তৈরি ও প্রিন্ট' : 'Generate & Print Stock Batch QR'}
                          >
                            <QrCode className="w-3.5 h-3.5 text-amber-600" />
                            <span>
                              {isBn ? 'QR' : 'QR'} (
                              {lots.filter((l) => l.item_id === item.id && Number(l.remaining_qty_kg || 0) > 0).length ||
                                lots.filter((l) => l.item_id === item.id).length}
                              )
                            </span>
                          </button>
                          <button
                            onClick={() => openEdit(item)}
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                            title={t('common.edit')}
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleToggleStatus(item)}
                            className={`px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1 whitespace-nowrap ${
                              active ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'
                            }`}
                          >
                            <Power className="w-3 h-3" />
                            <span>{active ? t('common.deactivate') : t('common.activate')}</span>
                          </button>
                          <button
                            onClick={() => setConfirmDelete(item)}
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                            title={t('common.delete')}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Confirm Delete Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-sm w-full p-6 space-y-4">
            <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
              {t('prod.deleteTitle')}
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {t('prod.deleteDesc', { name: confirmDelete.name })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={executeDelete}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium"
              >
                {t('common.deletePermanently')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Printable Product Stock Batch QR Modal */}
      {qrModalState && (
        <StockBatchQrModal
          lots={qrModalState.lots}
          title={qrModalState.title}
          hideFinancials={hideFinancials}
          onClose={() => setQrModalState(null)}
          onNotify={onNotify}
        />
      )}
    </div>
  );
};
