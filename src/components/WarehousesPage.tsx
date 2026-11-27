import React, { useState } from 'react';
import {
  CheckCircle2,
  Edit3,
  Plus,
  Power,
  Search,
  Trash2,
  Warehouse as WarehouseIcon,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { apiMutate } from '../services/api';
import type { Warehouse, WarehouseType } from '../types/erp';

interface WarehousesPageProps {
  warehouses: Warehouse[];
  onRefresh: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

const WAREHOUSE_TYPES: WarehouseType[] = [
  'RAW_PADDY',
  'DRYING_YARD',
  'FINISHED_RICE',
  'BY_PRODUCT',
  'GENERAL',
];

export const WarehousesPage: React.FC<WarehousesPageProps> = ({
  warehouses,
  onRefresh,
  onNotify,
}) => {
  const { lang, t } = useI18n();
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Warehouse | null>(null);

  const [form, setForm] = useState({
    code: '',
    name: '',
    warehouse_type: 'RAW_PADDY' as WarehouseType,
    location: '',
    capacity_kg: 0,
    is_active: true,
  });

  const activeCount = warehouses.filter((w) => Boolean(w.is_active)).length;
  const totalCapacityKg = warehouses.reduce((s, w) => s + Number(w.capacity_kg || 0), 0);
  const totalStockKg = warehouses.reduce((s, w) => s + Number(w.current_stock_kg || 0), 0);

  const filtered = warehouses.filter((w) => {
    const active = Boolean(w.is_active);
    if (statusFilter === 'ACTIVE' && !active) return false;
    if (statusFilter === 'INACTIVE' && active) return false;
    if (typeFilter !== 'ALL' && w.warehouse_type !== typeFilter) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      w.name.toLowerCase().includes(q) ||
      w.code.toLowerCase().includes(q) ||
      (w.location || '').toLowerCase().includes(q)
    );
  });

  const openAdd = () => {
    setEditingId(null);
    setForm({
      code: '',
      name: '',
      warehouse_type: 'RAW_PADDY',
      location: '',
      capacity_kg: 0,
      is_active: true,
    });
    setShowForm(true);
  };

  const openEdit = (w: Warehouse) => {
    setEditingId(w.id);
    setForm({
      code: w.code,
      name: w.name,
      warehouse_type: w.warehouse_type,
      location: w.location || '',
      capacity_kg: w.capacity_kg,
      is_active: Boolean(w.is_active),
    });
    setShowForm(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingId) {
        await apiMutate({
          endpoint: `/api/v1/warehouses/${editingId}`,
          method: 'PUT',
          payload: form,
          module: 'Warehouse Master',
          summary: `Update warehouse ${form.name}`,
        });
        onNotify(lang === 'bn' ? `গুদাম "${form.name}" আপডেট হয়েছে।` : `Warehouse "${form.name}" updated.`, 'ok');
      } else {
        await apiMutate({
          endpoint: '/api/v1/warehouses',
          method: 'POST',
          payload: form,
          module: 'Warehouse Master',
          summary: `Add warehouse ${form.name}`,
        });
        onNotify(lang === 'bn' ? `গুদাম "${form.name}" যোগ করা হয়েছে।` : `Warehouse "${form.name}" added.`, 'ok');
      }
      setShowForm(false);
      setEditingId(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const handleToggleStatus = async (w: Warehouse) => {
    const nextActive = !Boolean(w.is_active);
    try {
      await apiMutate({
        endpoint: `/api/v1/warehouses/${w.id}/status`,
        method: 'PATCH',
        payload: { is_active: nextActive },
        module: 'Warehouse Status',
        summary: `${nextActive ? 'Activate' : 'Deactivate'} ${w.code}`,
      });
      onNotify(
        lang === 'bn'
          ? `গুদাম "${w.name}" এখন ${nextActive ? t('common.active') : t('common.inactive')}।`
          : `Warehouse "${w.name}" is now ${nextActive ? 'Active' : 'Inactive'}.`,
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
        endpoint: `/api/v1/warehouses/${confirmDelete.id}`,
        method: 'DELETE',
        payload: {},
        module: 'Delete Warehouse',
        summary: `Delete warehouse ${confirmDelete.name}`,
      });
      onNotify(lang === 'bn' ? `গুদাম "${confirmDelete.name}" মুছে ফেলা হয়েছে।` : `Warehouse "${confirmDelete.name}" deleted.`, 'ok');
      setConfirmDelete(null);
      onRefresh();
    } catch (err) {
      setConfirmDelete(null);
      onNotify((err as Error).message, 'err');
    }
  };

  return (
    <div className="space-y-5">
      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('wh.total')}</div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums mt-1">{warehouses.length}</div>
          <div className="text-xs text-slate-500 mt-1">
            {activeCount} {t('common.active')} · {warehouses.length - activeCount} {t('common.inactive')}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('wh.totalCapacity')}</div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums mt-1">
            {(totalCapacityKg / 1000).toLocaleString('en-IN', { maximumFractionDigits: 1 })} {t('common.mt')}
          </div>
          <div className="text-xs text-slate-500 mt-1">{totalCapacityKg.toLocaleString()} {t('common.kg')}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('wh.currentStored')}</div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums mt-1">
            {(totalStockKg / 1000).toLocaleString('en-IN', { maximumFractionDigits: 1 })} {t('common.mt')}
          </div>
          <div className="text-xs text-slate-500 mt-1">{totalStockKg.toLocaleString()} {t('wh.acrossLots')}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('wh.utilization')}</div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums mt-1">
            {totalCapacityKg > 0 ? ((totalStockKg / totalCapacityKg) * 100).toFixed(1) : '0.0'}%
          </div>
          <div className="text-xs text-slate-500 mt-1">{t('wh.availableSpace')}: {Math.max(0, totalCapacityKg - totalStockKg).toLocaleString()} {t('common.kg')}</div>
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
              placeholder={t('wh.searchPlaceholder')}
              className="pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-60"
            />
          </div>

          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
          >
            <option value="ALL">{t('wh.allTypes')}</option>
            {WAREHOUSE_TYPES.map((k) => (
              <option key={k} value={k}>
                {t(`wh.type.${k}`)}
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

        <button
          onClick={showForm ? () => setShowForm(false) : openAdd}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>{showForm ? t('common.closeForm') : t('wh.addBtn')}</span>
        </button>
      </div>

      {/* Add / Edit Form */}
      {showForm && (
        <form
          onSubmit={handleSave}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
        >
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
            <h3 className="text-sm font-display font-semibold">
              {editingId ? t('wh.editTitle') : t('wh.addTitle')}
            </h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">{t('wh.code')}</label>
              <input
                type="text"
                required
                placeholder=""
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                className="w-full px-3 py-2 text-xs font-mono uppercase rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('wh.name')}</label>
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
              <label className="block text-xs font-medium mb-1">{t('wh.type')}</label>
              <select
                value={form.warehouse_type}
                onChange={(e) => setForm({ ...form, warehouse_type: e.target.value as WarehouseType })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {WAREHOUSE_TYPES.map((k) => (
                  <option key={k} value={k}>
                    {t(`wh.type.${k}`)}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('wh.location')}</label>
              <input
                type="text"
                placeholder=""
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('wh.capacity')}</label>
              <input
                type="number"
                required
                min="0"
                step="1"
                value={form.capacity_kg}
                onChange={(e) => setForm({ ...form, capacity_kg: Number(e.target.value) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <div className="flex items-end pb-1">
              <label className="flex items-center gap-2 text-xs font-medium cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
                  className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                />
                <span>{t('wh.activeLabel')}</span>
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
              {editingId ? t('common.saveChanges') : t('wh.createBtn')}
            </button>
          </div>
        </form>
      )}

      {/* Warehouse Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.length === 0 ? (
          <div className="md:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center text-xs text-slate-500">
            {t('wh.empty')}
          </div>
        ) : (
          filtered.map((w) => {
            const active = Boolean(w.is_active);
            const stock = Number(w.current_stock_kg || 0);
            const cap = Number(w.capacity_kg || 0);
            const pct = cap > 0 ? Math.min(100, (stock / cap) * 100) : 0;

            return (
              <div
                key={w.id}
                className={`bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between gap-4 ${
                  !active ? 'opacity-70' : ''
                }`}
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="w-9 h-9 rounded-lg bg-slate-100 dark:bg-slate-800 flex items-center justify-center shrink-0">
                        <WarehouseIcon className="w-4 h-4 text-slate-700 dark:text-slate-300" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-slate-500">{w.code}</span>
                          <span className="text-xs text-slate-400">·</span>
                          <span className="text-xs text-slate-500">{t(`wh.type.${w.warehouse_type}`) || w.warehouse_type}</span>
                        </div>
                        <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white mt-0.5">
                          {w.name}
                        </h4>
                        <div className="text-xs text-slate-500 mt-0.5">{w.location || t('wh.noLocation')}</div>
                      </div>
                    </div>

                    <div className="text-right shrink-0">
                      <div className="text-sm font-mono font-semibold tabular-nums">
                        {stock.toLocaleString()} {t('common.kg')}
                      </div>
                      <div className="text-xs text-slate-500 font-mono tabular-nums">
                        / {cap.toLocaleString()} {t('common.kg')}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-xs text-slate-500 mb-1">
                      <span>{t('wh.occupancy')}</span>
                      <span className="font-mono tabular-nums">{pct.toFixed(1)}%</span>
                    </div>
                    <div className="h-2 rounded bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full ${pct > 85 ? 'bg-amber-600' : 'bg-slate-900 dark:bg-amber-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs">
                  <span
                    className={`inline-flex items-center gap-1 font-medium ${
                      active ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-400'
                    }`}
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{active ? t('common.active') : t('common.inactive')}</span>
                  </span>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => openEdit(w)}
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                    >
                      <Edit3 className="w-3 h-3" />
                      <span>{t('common.edit')}</span>
                    </button>
                    <button
                      onClick={() => handleToggleStatus(w)}
                      className={`flex items-center gap-1 px-2.5 py-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap ${
                        active ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      <Power className="w-3 h-3" />
                      <span>{active ? t('common.deactivate') : t('common.activate')}</span>
                    </button>
                    <button
                      onClick={() => setConfirmDelete(w)}
                      className="p-1.5 rounded border border-slate-200 dark:border-slate-700 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                      title={t('common.delete')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Confirm Delete Modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-sm w-full p-6 space-y-4">
            <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
              {t('wh.deleteTitle')}
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {t('wh.deleteDesc', { name: confirmDelete.name })}
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
    </div>
  );
};
