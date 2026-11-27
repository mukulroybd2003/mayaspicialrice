import React, { useState } from 'react';
import {
  CheckCircle2,
  Edit3,
  Plus,
  Power,
  Ruler,
  Search,
  Trash2,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { apiMutate } from '../services/api';
import type { ProductUnit } from '../types/erp';

interface ProductUnitsPageProps {
  units: ProductUnit[];
  onRefresh: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

export const ProductUnitsPage: React.FC<ProductUnitsPageProps> = ({
  units,
  onRefresh,
  onNotify,
}) => {
  const { lang, t } = useI18n();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ProductUnit | null>(null);

  const [form, setForm] = useState({
    code: '',
    name: '',
    symbol: '',
    base_weight_kg: 1,
    description: '',
    is_active: true,
  });

  const activeCount = units.filter((u) => Boolean(u.is_active)).length;
  const totalLinkedProducts = units.reduce((s, u) => s + Number(u.product_count || 0), 0);

  const filtered = units.filter((u) => {
    const active = Boolean(u.is_active);
    if (statusFilter === 'ACTIVE' && !active) return false;
    if (statusFilter === 'INACTIVE' && active) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      u.code.toLowerCase().includes(q) ||
      u.name.toLowerCase().includes(q) ||
      u.symbol.toLowerCase().includes(q)
    );
  });

  const openAdd = () => {
    setEditingId(null);
    setForm({
      code: '',
      name: '',
      symbol: '',
      base_weight_kg: 1,
      description: '',
      is_active: true,
    });
    setShowForm(true);
  };

  const openEdit = (u: ProductUnit) => {
    setEditingId(u.id);
    setForm({
      code: u.code,
      name: u.name,
      symbol: u.symbol,
      base_weight_kg: u.base_weight_kg,
      description: u.description || '',
      is_active: Boolean(u.is_active),
    });
    setShowForm(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingId) {
        await apiMutate({
          endpoint: `/api/v1/product-units/${editingId}`,
          method: 'PUT',
          payload: form,
          module: 'Product Unit',
          summary: `Update unit ${form.code}`,
        });
        onNotify(lang === 'bn' ? `একক "${form.name}" আপডেট হয়েছে।` : `Product unit "${form.name}" updated.`, 'ok');
      } else {
        await apiMutate({
          endpoint: '/api/v1/product-units',
          method: 'POST',
          payload: form,
          module: 'Product Unit',
          summary: `Add unit ${form.code}`,
        });
        onNotify(lang === 'bn' ? `একক "${form.name}" যোগ করা হয়েছে।` : `Product unit "${form.name}" added.`, 'ok');
      }
      setShowForm(false);
      setEditingId(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const handleToggleStatus = async (u: ProductUnit) => {
    const nextActive = !Boolean(u.is_active);
    try {
      await apiMutate({
        endpoint: `/api/v1/product-units/${u.id}/status`,
        method: 'PATCH',
        payload: { is_active: nextActive },
        module: 'Unit Status',
        summary: `${nextActive ? 'Activate' : 'Deactivate'} unit ${u.code}`,
      });
      onNotify(
        lang === 'bn'
          ? `একক "${u.name}" এখন ${nextActive ? t('common.active') : t('common.inactive')}।`
          : `Unit "${u.name}" is now ${nextActive ? 'Active' : 'Inactive'}.`,
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
        endpoint: `/api/v1/product-units/${confirmDelete.id}`,
        method: 'DELETE',
        payload: {},
        module: 'Delete Product Unit',
        summary: `Delete unit ${confirmDelete.code}`,
      });
      onNotify(lang === 'bn' ? `একক "${confirmDelete.name}" মুছে ফেলা হয়েছে।` : `Unit "${confirmDelete.name}" deleted.`, 'ok');
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('unit.total')}</div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums mt-1">{units.length}</div>
          <div className="text-xs text-slate-500 mt-1">
            {activeCount} {t('common.active')} · {units.length - activeCount} {t('common.inactive')}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('unit.baseStandard')}</div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums mt-1">1 {t('common.kg')}</div>
          <div className="text-xs text-slate-500 mt-1">{t('unit.baseDesc')}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('unit.linkedProducts')}</div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums mt-1">{totalLinkedProducts}</div>
          <div className="text-xs text-slate-500 mt-1">{t('unit.linkedDesc')}</div>
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
              placeholder={t('unit.searchPlaceholder')}
              className="pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-64"
            />
          </div>

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
          <span>{showForm ? t('common.closeForm') : t('unit.addBtn')}</span>
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
              {editingId ? t('unit.editTitle') : t('unit.addTitle')}
            </h3>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">{t('unit.code')}</label>
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
              <label className="block text-xs font-medium mb-1">{t('unit.name')}</label>
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
              <label className="block text-xs font-medium mb-1">{t('unit.symbol')}</label>
              <input
                type="text"
                required
                placeholder=""
                value={form.symbol}
                onChange={(e) => setForm({ ...form, symbol: e.target.value })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('unit.baseWeight')}</label>
              <input
                type="number"
                required
                min="0.001"
                step="0.001"
                value={form.base_weight_kg}
                onChange={(e) => setForm({ ...form, base_weight_kg: Number(e.target.value) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{t('unit.description')}</label>
              <input
                type="text"
                placeholder=""
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
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
                <span>{t('unit.activeLabel')}</span>
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
              {editingId ? t('common.saveChanges') : t('unit.createBtn')}
            </button>
          </div>
        </form>
      )}

      {/* Units Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="text-left px-4 py-3 font-medium">{t('unit.code')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('unit.name')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('unit.symbol')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('unit.thWeightEquiv')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('unit.thProducts')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('common.status')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    {t('unit.empty')}
                  </td>
                </tr>
              ) : (
                filtered.map((u) => {
                  const active = Boolean(u.is_active);
                  return (
                    <tr key={u.id} className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 ${!active ? 'opacity-65' : ''}`}>
                      <td className="px-4 py-3 font-mono font-semibold text-slate-900 dark:text-white">
                        <div className="inline-flex items-center gap-2">
                          <Ruler className="w-3.5 h-3.5 text-slate-400" />
                          <span>{u.code}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900 dark:text-white">{u.name}</div>
                        {u.description && <div className="text-slate-500 mt-0.5">{u.description}</div>}
                      </td>
                      <td className="px-4 py-3 font-mono text-slate-600 dark:text-slate-300">{u.symbol}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-medium">
                        {Number(u.base_weight_kg).toLocaleString()} {t('common.kg')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                        {Number(u.product_count || 0)}
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
                            onClick={() => openEdit(u)}
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                            title={t('common.edit')}
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => handleToggleStatus(u)}
                            className={`px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1 whitespace-nowrap ${
                              active ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'
                            }`}
                          >
                            <Power className="w-3 h-3" />
                            <span>{active ? t('common.deactivate') : t('common.activate')}</span>
                          </button>
                          <button
                            onClick={() => setConfirmDelete(u)}
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
              {t('unit.deleteTitle')}
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {t('unit.deleteDesc', { name: confirmDelete.name, code: confirmDelete.code })}
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
