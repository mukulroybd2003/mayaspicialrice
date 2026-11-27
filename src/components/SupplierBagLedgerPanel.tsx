import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Package,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import type { AppLang } from '../i18n/translations';
import { apiGet, apiMutate } from '../services/api';
import type {
  Party,
  SupplierBagEntryType,
  SupplierBagLedgerEntry,
  SupplierBagSummary,
} from '../types/erp';
import { exportEmptyBagSlipPdf, exportExcelWorkbook, exportPdfTableReport } from '../utils/reports';

interface SupplierBagLedgerPanelProps {
  suppliers: Party[];
  canDelete?: boolean;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

export const SupplierBagLedgerPanel: React.FC<SupplierBagLedgerPanelProps> = ({
  suppliers,
  canDelete = true,
  onNotify,
}) => {
  const { lang } = useI18n();
  const isBn = lang === 'bn';

  const [summaries, setSummaries] = useState<SupplierBagSummary[]>([]);
  const [entries, setEntries] = useState<SupplierBagLedgerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [lastSavedEntry, setLastSavedEntry] = useState<SupplierBagLedgerEntry | null>(null);

  const [balanceFilter, setBalanceFilter] = useState<'ALL' | 'WE_GET' | 'SUPPLIER_GETS' | 'SETTLED'>('ALL');
  const [selectedSupplierId, setSelectedSupplierId] = useState<number>(0);
  const [search, setSearch] = useState('');

  const [form, setForm] = useState({
    supplier_id: suppliers[0]?.id || 0,
    entry_type: 'ADVANCE_ISSUE' as Exclude<SupplierBagEntryType, 'PADDY_DEPOSIT'>,
    jute_qty: 0,
    plastic_qty: 0,
    reference_no: '',
    entry_date: new Date().toISOString().slice(0, 10),
    notes: '',
  });

  const effectiveFormSupplierId = useMemo(
    () => (suppliers.some((s) => s.id === form.supplier_id) ? form.supplier_id : suppliers[0]?.id || 0),
    [suppliers, form.supplier_id]
  );

  const loadBagLedger = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiGet<{ summaries: SupplierBagSummary[]; entries: SupplierBagLedgerEntry[] }>(
        '/api/v1/supplier-bags',
        'cache_supplier_bags'
      );
      setSummaries(res.summaries || []);
      setEntries(res.entries || []);
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  useEffect(() => {
    void loadBagLedger();
  }, [loadBagLedger]);

  const formatBalanceLabel = (net: number, targetLang: AppLang = lang): string => {
    const bn = targetLang === 'bn';
    if (net > 0) return bn ? `আমরা পাবো ${net.toLocaleString('en-IN')}` : `We Get ${net.toLocaleString('en-IN')}`;
    if (net < 0) return bn ? `সাপ্লায়ার পাবে ${Math.abs(net).toLocaleString('en-IN')}` : `Supplier Gets ${Math.abs(net).toLocaleString('en-IN')}`;
    return bn ? 'সমান (০)' : 'Settled (0)';
  };

  const entryTypeLabel = (type: SupplierBagEntryType, targetLang: AppLang = lang): string => {
    const bn = targetLang === 'bn';
    switch (type) {
      case 'ADVANCE_ISSUE':
        return bn ? 'অগ্রিম বস্তা নিয়েছে' : 'Advance Bags Issued';
      case 'PADDY_DEPOSIT':
        return bn ? 'ধানের সাথে বস্তা জমা' : 'Deposited with Paddy';
      case 'EMPTY_PICKUP':
        return bn ? 'জমা থেকে খালি বস্তা নিয়েছে' : 'Empty Bag Pickup';
      case 'EMPTY_RETURN':
        return bn ? 'খালি বস্তা ফেরত দিয়েছে' : 'Empty Bag Return';
      default:
        return type;
    }
  };

  const kpis = useMemo(() => {
    let weGetJute = 0;
    let weGetPlastic = 0;
    let suppGetsJute = 0;
    let suppGetsPlastic = 0;

    for (const s of summaries) {
      if (s.jute_net > 0) weGetJute += s.jute_net;
      else if (s.jute_net < 0) suppGetsJute += Math.abs(s.jute_net);

      if (s.plastic_net > 0) weGetPlastic += s.plastic_net;
      else if (s.plastic_net < 0) suppGetsPlastic += Math.abs(s.plastic_net);
    }

    const totalWeGet = weGetJute + weGetPlastic;
    const totalSuppGets = suppGetsJute + suppGetsPlastic;
    const netOverall = totalWeGet - totalSuppGets;
    return {
      weGetJute,
      weGetPlastic,
      totalWeGet,
      suppGetsJute,
      suppGetsPlastic,
      totalSuppGets,
      netOverall,
    };
  }, [summaries]);

  const selectedFormSupplierSummary = useMemo(
    () => summaries.find((s) => s.supplier_id === effectiveFormSupplierId) || null,
    [summaries, effectiveFormSupplierId]
  );

  const filteredSummaries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return summaries.filter((s) => {
      if (balanceFilter === 'WE_GET' && s.total_net <= 0) return false;
      if (balanceFilter === 'SUPPLIER_GETS' && s.total_net >= 0) return false;
      if (balanceFilter === 'SETTLED' && s.total_net !== 0) return false;
      if (!q) return true;
      return (
        s.supplier_name.toLowerCase().includes(q) ||
        s.party_code.toLowerCase().includes(q) ||
        (s.phone || '').toLowerCase().includes(q)
      );
    });
  }, [summaries, balanceFilter, search]);

  const filteredEntries = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (selectedSupplierId && e.supplier_id !== selectedSupplierId) return false;
      if (!q) return true;
      return (
        (e.supplier_name || '').toLowerCase().includes(q) ||
        e.entry_no.toLowerCase().includes(q) ||
        (e.reference_no || '').toLowerCase().includes(q) ||
        (e.notes || '').toLowerCase().includes(q)
      );
    });
  }, [entries, selectedSupplierId, search]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveFormSupplierId) {
      onNotify(isBn ? 'একজন সাপ্লায়ার নির্বাচন করুন।' : 'Please select a supplier.', 'err');
      return;
    }
    const jute = Math.max(0, Math.round(Number(form.jute_qty || 0)));
    const plastic = Math.max(0, Math.round(Number(form.plastic_qty || 0)));
    if (jute + plastic <= 0) {
      onNotify(isBn ? 'চট অথবা প্লাস্টিক বস্তার সংখ্যা দিন।' : 'Enter at least 1 Jute or Plastic bag.', 'err');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiMutate<{ status: string; entry?: SupplierBagLedgerEntry }>({
        endpoint: '/api/v1/supplier-bags',
        method: 'POST',
        payload: {
          ...form,
          supplier_id: effectiveFormSupplierId,
          jute_qty: jute,
          plastic_qty: plastic,
        },
        module: 'Supplier Bag Ledger',
        summary: `${form.entry_type} · Jute ${jute} + Plastic ${plastic}`,
      });
      if (res.offlineQueued) {
        setLastSavedEntry(null);
        onNotify(isBn ? 'অফলাইন: বস্তার হিসাব কিউতে সংরক্ষিত হয়েছে।' : 'Offline: Bag entry queued for sync.', 'warn');
      } else {
        if (res.data?.entry) {
          setLastSavedEntry(res.data.entry);
        }
        onNotify(
          isBn
            ? `বস্তার লেনদেন সংরক্ষিত হয়েছে (চট: ${jute}, প্লাস্টিক: ${plastic})।`
            : `Saved bag entry (Jute: ${jute}, Plastic: ${plastic}).`,
          'ok'
        );
      }
      setForm((prev) => ({ ...prev, jute_qty: 0, plastic_qty: 0, reference_no: '', notes: '' }));
      await loadBagLedger();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteEntry = async (entry: SupplierBagLedgerEntry) => {
    try {
      await apiMutate({
        endpoint: `/api/v1/supplier-bags/${entry.id}`,
        method: 'DELETE',
        payload: {},
        module: 'Supplier Bag Delete',
        summary: `Delete bag entry ${entry.entry_no}`,
      });
      onNotify(isBn ? `${entry.entry_no} মুছে ফেলা হয়েছে।` : `Deleted ${entry.entry_no}.`, 'ok');
      await loadBagLedger();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const handleExportSummaryPdf = (exportLang: AppLang) => {
    const bn = exportLang === 'bn';
    const rows = filteredSummaries.map((s) => [
      `${s.supplier_name} (${s.party_code})`,
      s.jute_taken,
      s.jute_deposited,
      formatBalanceLabel(s.jute_net, exportLang),
      s.plastic_taken,
      s.plastic_deposited,
      formatBalanceLabel(s.plastic_net, exportLang),
      formatBalanceLabel(s.total_net, exportLang),
    ]);

    const totJuteTaken = filteredSummaries.reduce((a, b) => a + b.jute_taken, 0);
    const totJuteDep = filteredSummaries.reduce((a, b) => a + b.jute_deposited, 0);
    const totJuteNet = filteredSummaries.reduce((a, b) => a + b.jute_net, 0);
    const totPlasTaken = filteredSummaries.reduce((a, b) => a + b.plastic_taken, 0);
    const totPlasDep = filteredSummaries.reduce((a, b) => a + b.plastic_deposited, 0);
    const totPlasNet = filteredSummaries.reduce((a, b) => a + b.plastic_net, 0);
    const totNet = filteredSummaries.reduce((a, b) => a + b.total_net, 0);

    rows.push([
      bn ? 'সর্বমোট' : 'GRAND TOTAL',
      totJuteTaken,
      totJuteDep,
      formatBalanceLabel(totJuteNet, exportLang),
      totPlasTaken,
      totPlasDep,
      formatBalanceLabel(totPlasNet, exportLang),
      formatBalanceLabel(totNet, exportLang),
    ]);

    void exportPdfTableReport({
      lang: exportLang,
      title: bn ? 'সাপ্লায়ার বস্তার হিসাব ও পাওনা-দেনা রিপোর্ট (চট ও প্লাস্টিক)' : 'Supplier Bag Balance Report (Jute & Plastic)',
      subtitle: bn
        ? `আমরা পাবো: ${kpis.totalWeGet.toLocaleString('en-IN')} বস্তা (চট ${kpis.weGetJute}, প্লাস্টিক ${kpis.weGetPlastic}) | সাপ্লায়ার পাবে: ${kpis.totalSuppGets.toLocaleString('en-IN')} বস্তা (চট ${kpis.suppGetsJute}, প্লাস্টিক ${kpis.suppGetsPlastic})`
        : `We Get: ${kpis.totalWeGet.toLocaleString('en-IN')} bags (Jute ${kpis.weGetJute}, Plastic ${kpis.weGetPlastic}) | Supplier Gets: ${kpis.totalSuppGets.toLocaleString('en-IN')} bags (Jute ${kpis.suppGetsJute}, Plastic ${kpis.suppGetsPlastic})`,
      filename: 'Supplier-Bag-Balance-Report',
      columns: bn
        ? [
            'সাপ্লায়ার',
            'চট নিয়েছে',
            'চট জমা',
            'চট হিসাব (কে পাবে)',
            'প্লাস্টিক নিয়েছে',
            'প্লাস্টিক জমা',
            'প্লাস্টিক হিসাব (কে পাবে)',
            'মোট অবস্থা',
          ]
        : [
            'Supplier',
            'Jute Out',
            'Jute In',
            'Jute Balance',
            'Plastic Out',
            'Plastic In',
            'Plastic Balance',
            'Net Position',
          ],
      rows,
    });
  };

  const handleExportSupplierLedgerPdf = (exportLang: AppLang, supplierSummary?: SupplierBagSummary) => {
    const bn = exportLang === 'bn';
    const targetId = supplierSummary?.supplier_id || selectedSupplierId;
    const targetSum = supplierSummary || summaries.find((s) => s.supplier_id === targetId);
    const list = targetId ? entries.filter((e) => e.supplier_id === targetId) : filteredEntries;

    const rows = list.map((e) => [
      e.entry_date,
      e.entry_no,
      e.supplier_name || '-',
      entryTypeLabel(e.entry_type, exportLang),
      e.direction === 'OUT_TO_SUPPLIER' ? (bn ? 'নিয়েছে (আমরা পাবো+)' : 'Out (We Get+)') : bn ? 'জমা দিয়েছে (পাবে+)' : 'In (Supp Gets+)',
      e.jute_qty,
      e.plastic_qty,
      e.total_qty,
      e.reference_no || e.notes || '-',
    ]);

    const subText = targetSum
      ? bn
        ? `সাপ্লায়ার: ${targetSum.supplier_name} (${targetSum.party_code}) | চট: ${formatBalanceLabel(targetSum.jute_net, exportLang)} | প্লাস্টিক: ${formatBalanceLabel(targetSum.plastic_net, exportLang)} | মোট: ${formatBalanceLabel(targetSum.total_net, exportLang)}`
        : `Supplier: ${targetSum.supplier_name} (${targetSum.party_code}) | Jute: ${formatBalanceLabel(targetSum.jute_net, exportLang)} | Plastic: ${formatBalanceLabel(targetSum.plastic_net, exportLang)} | Total: ${formatBalanceLabel(targetSum.total_net, exportLang)}`
      : bn
      ? `মোট লেনদেন: ${list.length}টি | সর্বমোট আমরা পাবো: ${kpis.totalWeGet} | সাপ্লায়ার পাবে: ${kpis.totalSuppGets}`
      : `Transactions: ${list.length} | Total We Get: ${kpis.totalWeGet} | Supplier Gets: ${kpis.totalSuppGets}`;

    void exportPdfTableReport({
      lang: exportLang,
      title: bn ? 'সাপ্লায়ার বস্তা লেনদেন লেজার স্টেটমেন্ট' : 'Supplier Bag Ledger Statement',
      subtitle: subText,
      filename: targetSum ? `Bag-Ledger-${targetSum.party_code}` : 'Supplier-Bag-Ledger-All',
      columns: bn
        ? ['তারিখ', 'নং', 'সাপ্লায়ার', 'লেনদেনের ধরন', 'দিক', 'চট বস্তা', 'প্লাস্টিক বস্তা', 'মোট বস্তা', 'রেফারেন্স / নোট']
        : ['Date', 'Entry No', 'Supplier', 'Type', 'Direction', 'Jute', 'Plastic', 'Total', 'Ref / Notes'],
      rows,
    });
  };

  const handleExportExcel = () => {
    exportExcelWorkbook(
      'Supplier-Bag-Ledger',
      [
        {
          name: isBn ? 'সাপ্লায়ার বস্তা সারাংশ' : 'Bag Balance Summary',
          rows: filteredSummaries.map((s) =>
            isBn
              ? {
                  সাপ্লায়ার: s.supplier_name,
                  কোড: s.party_code,
                  চট_নিয়েছে: s.jute_taken,
                  চট_জমা: s.jute_deposited,
                  চট_নিট: s.jute_net,
                  চট_অবস্থা: formatBalanceLabel(s.jute_net, 'bn'),
                  প্লাস্টিক_নিয়েছে: s.plastic_taken,
                  প্লাস্টিক_জমা: s.plastic_deposited,
                  প্লাস্টিক_নিট: s.plastic_net,
                  প্লাস্টিক_অবস্থা: formatBalanceLabel(s.plastic_net, 'bn'),
                  মোট_নিট: s.total_net,
                  মোট_অবস্থা: formatBalanceLabel(s.total_net, 'bn'),
                }
              : {
                  Supplier: s.supplier_name,
                  Code: s.party_code,
                  JuteOut: s.jute_taken,
                  JuteIn: s.jute_deposited,
                  JuteNet: s.jute_net,
                  JuteStatus: formatBalanceLabel(s.jute_net, 'en'),
                  PlasticOut: s.plastic_taken,
                  PlasticIn: s.plastic_deposited,
                  PlasticNet: s.plastic_net,
                  PlasticStatus: formatBalanceLabel(s.plastic_net, 'en'),
                  TotalNet: s.total_net,
                  NetStatus: formatBalanceLabel(s.total_net, 'en'),
                }
          ),
        },
        {
          name: isBn ? 'বস্তা লেনদেন লেজার' : 'Bag Ledger Entries',
          rows: filteredEntries.map((e) =>
            isBn
              ? {
                  তারিখ: e.entry_date,
                  এন্ট্রি_নং: e.entry_no,
                  সাপ্লায়ার: e.supplier_name || '',
                  ধরন: entryTypeLabel(e.entry_type, 'bn'),
                  দিক: e.direction === 'OUT_TO_SUPPLIER' ? 'সাপ্লায়ার নিয়েছে' : 'সাপ্লায়ার জমা দিয়েছে',
                  চট_বস্তা: e.jute_qty,
                  প্লাস্টিক_বস্তা: e.plastic_qty,
                  মোট_বস্তা: e.total_qty,
                  রেফারেন্স: e.reference_no || '',
                  নোট: e.notes || '',
                }
              : {
                  Date: e.entry_date,
                  EntryNo: e.entry_no,
                  Supplier: e.supplier_name || '',
                  Type: entryTypeLabel(e.entry_type, 'en'),
                  Direction: e.direction,
                  JuteQty: e.jute_qty,
                  PlasticQty: e.plastic_qty,
                  TotalQty: e.total_qty,
                  ReferenceNo: e.reference_no || '',
                  Notes: e.notes || '',
                }
          ),
        },
      ],
      lang
    );
  };

  return (
    <div className="space-y-5">
      {/* KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-900/50 rounded-xl p-4">
          <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
            {isBn ? 'আমরা পাবো (সাপ্লায়ারের কাছে পাওনা)' : 'We Get (Supplier Owes Bags)'}
          </div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1">
            {kpis.totalWeGet.toLocaleString('en-IN')} <span className="text-xs font-normal">{isBn ? 'বস্তা' : 'bags'}</span>
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1">
            {isBn ? 'চট:' : 'Jute:'} {kpis.weGetJute.toLocaleString('en-IN')} · {isBn ? 'প্লাস্টিক:' : 'Plastic:'}{' '}
            {kpis.weGetPlastic.toLocaleString('en-IN')}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-900/50 rounded-xl p-4">
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            {isBn ? 'সাপ্লায়ার পাবে (মিলের কাছে জমা)' : 'Supplier Gets (Deposited at Mill)'}
          </div>
          <div className="text-2xl font-display font-bold font-mono tabular-nums text-slate-900 dark:text-white mt-1">
            {kpis.totalSuppGets.toLocaleString('en-IN')} <span className="text-xs font-normal">{isBn ? 'বস্তা' : 'bags'}</span>
          </div>
          <div className="text-[11px] font-mono text-slate-500 mt-1">
            {isBn ? 'চট:' : 'Jute:'} {kpis.suppGetsJute.toLocaleString('en-IN')} · {isBn ? 'প্লাস্টিক:' : 'Plastic:'}{' '}
            {kpis.suppGetsPlastic.toLocaleString('en-IN')}
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">
            {isBn ? 'সর্বমোট নিট বস্তা ব্যালেন্স' : 'Overall Net Bag Position'}
          </div>
          <div
            className={`text-2xl font-display font-bold font-mono tabular-nums mt-1 ${
              kpis.netOverall > 0
                ? 'text-amber-700 dark:text-amber-400'
                : kpis.netOverall < 0
                ? 'text-emerald-700 dark:text-emerald-400'
                : 'text-slate-700 dark:text-slate-300'
            }`}
          >
            {formatBalanceLabel(kpis.netOverall)}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {isBn ? 'ধান ক্রয়ের সাথে চট ও প্লাস্টিক বস্তা স্বয়ংক্রিয়ভাবে জমা হয়' : 'Paddy purchases auto-credit Jute & Plastic bags'}
          </div>
        </div>
      </div>

      {/* Entry Form */}
      <form
        onSubmit={handleSubmit}
        className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
          <div className="flex items-center gap-2">
            <Package className="w-4 h-4 text-amber-600" />
            <div>
              <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                {isBn ? 'নতুন বস্তা লেনদেন (অগ্রিম বস্তা / খালি বস্তা উত্তোলন / ফেরত)' : 'Record Bag Transaction (Advance Issue / Empty Pickup / Return)'}
              </h3>
            </div>
          </div>
          {selectedFormSupplierSummary && (
            <div className="text-xs font-mono px-3 py-1.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <span className="text-slate-500">{isBn ? 'বর্তমান ব্যালেন্স:' : 'Current:'}</span>{' '}
              <span className="font-semibold">{isBn ? 'চট' : 'Jute'}: {formatBalanceLabel(selectedFormSupplierSummary.jute_net)}</span> ·{' '}
              <span className="font-semibold">{isBn ? 'প্লাস্টিক' : 'Plastic'}: {formatBalanceLabel(selectedFormSupplierSummary.plastic_net)}</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
          <div className="lg:col-span-2">
            <label className="block text-xs font-medium mb-1">{isBn ? 'সাপ্লায়ার *' : 'Supplier *'}</label>
            <select
              value={effectiveFormSupplierId}
              onChange={(e) => setForm({ ...form, supplier_id: Number(e.target.value) })}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.party_code})
                </option>
              ))}
            </select>
          </div>
          <div className="lg:col-span-2">
            <label className="block text-xs font-medium mb-1">{isBn ? 'লেনদেনের ধরন *' : 'Transaction Type *'}</label>
            <select
              value={form.entry_type}
              onChange={(e) =>
                setForm({ ...form, entry_type: e.target.value as Exclude<SupplierBagEntryType, 'PADDY_DEPOSIT'> })
              }
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            >
              <option value="ADVANCE_ISSUE">
                {isBn ? 'অগ্রিম খালি বস্তা নিয়েছে (আমরা পাবো +)' : 'Advance Bags Issued (We Get +)'}
              </option>
              <option value="EMPTY_PICKUP">
                {isBn ? 'জমা বস্তা থেকে খালি বস্তা নিয়েছে' : 'Empty Bags Picked Up (Against Deposit)'}
              </option>
              <option value="EMPTY_RETURN">
                {isBn ? 'খালি বস্তা ফেরত / জমা দিয়েছে' : 'Empty Bags Returned / Deposited'}
              </option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">{isBn ? 'চট বস্তা (সংখ্যা)' : 'Jute Bags (Qty)'}</label>
            <input
              type="number"
              min="0"
              value={form.jute_qty}
              onChange={(e) => setForm({ ...form, jute_qty: Math.max(0, Number(e.target.value)) })}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">{isBn ? 'প্লাস্টিক বস্তা (সংখ্যা)' : 'Plastic Bags (Qty)'}</label>
            <input
              type="number"
              min="0"
              value={form.plastic_qty}
              onChange={(e) => setForm({ ...form, plastic_qty: Math.max(0, Number(e.target.value)) })}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">{isBn ? 'তারিখ' : 'Date'}</label>
            <input
              type="date"
              value={form.entry_date}
              onChange={(e) => setForm({ ...form, entry_date: e.target.value })}
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">{isBn ? 'স্লিপ / রেফ নং' : 'Slip / Ref No'}</label>
            <input
              type="text"
              value={form.reference_no}
              onChange={(e) => setForm({ ...form, reference_no: e.target.value })}
              placeholder=""
              className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <div className="lg:col-span-3">
            <label className="block text-xs font-medium mb-1">{isBn ? 'মন্তব্য / বিবরণ' : 'Notes / Remarks'}</label>
            <input
              type="text"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder={isBn ? 'মন্তব্য লিখুন' : 'Notes'}
              className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <div className="w-full sm:w-auto">
            <button
              type="submit"
              disabled={submitting}
              className="w-full min-h-[44px] flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{submitting ? (isBn ? 'সংরক্ষণ হচ্ছে...' : 'Saving...') : isBn ? 'বস্তা এন্ট্রি সেভ করুন' : 'Save Bag Entry'}</span>
            </button>
          </div>
        </div>

        {lastSavedEntry && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/30 px-3.5 py-2.5 text-xs">
            <div>
              <span className="font-semibold text-emerald-800 dark:text-emerald-300">
                {isBn ? `স্লিপ প্রস্তুত: ${lastSavedEntry.entry_no}` : `Slip Ready: ${lastSavedEntry.entry_no}`}
              </span>
              <span className="ml-2 text-slate-600 dark:text-slate-300">
                {lastSavedEntry.supplier_name} · {entryTypeLabel(lastSavedEntry.entry_type)} ·{' '}
                {isBn ? `মোট ${lastSavedEntry.total_qty} বস্তা` : `${lastSavedEntry.total_qty} bags`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  const sum = summaries.find((s) => s.supplier_id === lastSavedEntry.supplier_id) || null;
                  void exportEmptyBagSlipPdf(lastSavedEntry, sum, lang, 'open');
                }}
                className="min-h-[38px] inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md bg-slate-900 dark:bg-amber-600 text-white text-[11px] font-medium"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>{isBn ? 'স্লিপ PDF দেখুন' : 'View Slip PDF'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const sum = summaries.find((s) => s.supplier_id === lastSavedEntry.supplier_id) || null;
                  void exportEmptyBagSlipPdf(lastSavedEntry, sum, lang, 'download');
                }}
                className="min-h-[38px] inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[11px] font-medium"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{isBn ? 'ডাউনলোড' : 'Download'}</span>
              </button>
            </div>
          </div>
        )}
      </form>

      {/* Filters & Report Buttons */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <div className="relative flex-1 sm:flex-initial">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={isBn ? 'সাপ্লায়ার বা রেফারেন্স খুঁজুন...' : 'Search supplier or reference...'}
              className="min-h-[42px] pl-8 pr-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 w-full sm:w-56"
            />
          </div>
          <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs">
            {(
              [
                ['ALL', isBn ? 'সব' : 'All'],
                ['WE_GET', isBn ? 'আমরা পাবো' : 'We Get'],
                ['SUPPLIER_GETS', isBn ? 'সাপ্লায়ার পাবে' : 'Supplier Gets'],
                ['SETTLED', isBn ? 'সমান' : 'Settled'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setBalanceFilter(key)}
                className={`min-h-[34px] px-2.5 py-1 rounded-md font-medium transition-colors whitespace-nowrap ${
                  balanceFilter === key
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => handleExportSummaryPdf('bn')}
            className="min-h-[38px] flex items-center gap-1 px-2.5 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap"
          >
            <FileText className="w-3.5 h-3.5" /> {isBn ? 'পাওনা-দেনা রিপোর্ট PDF (বাংলা)' : 'Balance Report PDF (BN)'}
          </button>
          <button
            type="button"
            onClick={() => handleExportSummaryPdf('en')}
            className="min-h-[38px] flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap"
          >
            <FileText className="w-3.5 h-3.5" /> {isBn ? 'রিপোর্ট PDF (EN)' : 'Balance Report PDF (EN)'}
          </button>
          <button
            type="button"
            onClick={() => handleExportSupplierLedgerPdf('bn')}
            className="min-h-[38px] flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap"
          >
            <FileText className="w-3.5 h-3.5" /> {isBn ? 'লেজার PDF (বাংলা)' : 'Ledger PDF (BN)'}
          </button>
          <button
            type="button"
            onClick={() => handleExportSupplierLedgerPdf('en')}
            className="min-h-[38px] flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap"
          >
            <FileText className="w-3.5 h-3.5" /> {isBn ? 'লেজার PDF (EN)' : 'Ledger PDF (EN)'}
          </button>
          <button
            type="button"
            onClick={handleExportExcel}
            className="min-h-[38px] flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
          </button>
        </div>
      </div>

      {/* Supplier Bag Balance Summary Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            {isBn ? 'সাপ্লায়ার অনুযায়ী বস্তা ব্যালেন্স (কে পাবে বনাম আমরা পাবো)' : 'Supplier-Wise Bag Balance Summary (Supplier Gets vs We Get)'}
          </h4>
          {selectedSupplierId > 0 && (
            <button
              type="button"
              onClick={() => setSelectedSupplierId(0)}
              className="text-xs text-amber-600 hover:underline font-medium"
            >
              {isBn ? 'সব সাপ্লায়ারের লেনদেন দেখুন' : 'Show All Suppliers Ledger'}
            </button>
          )}
        </div>
        {/* Mobile Summary Cards */}
        <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
          {loading ? (
            <div className="px-4 py-8 text-center text-xs text-slate-500">
              {isBn ? 'বস্তার হিসাব লোড হচ্ছে...' : 'Loading supplier bag balances...'}
            </div>
          ) : filteredSummaries.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-slate-500">
              {isBn ? 'কোনো সাপ্লায়ার পাওয়া যায়নি।' : 'No matching suppliers.'}
            </div>
          ) : (
            filteredSummaries.map((s) => (
              <div
                key={s.supplier_id}
                className={`p-3.5 space-y-2.5 text-xs ${
                  selectedSupplierId === s.supplier_id ? 'bg-amber-50/50 dark:bg-amber-950/20' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-white">{s.supplier_name}</div>
                    <div className="font-mono text-[11px] text-slate-500">{s.party_code}</div>
                  </div>
                  <div
                    className={`font-mono font-bold text-right ${
                      s.total_net > 0
                        ? 'text-amber-700 dark:text-amber-400'
                        : s.total_net < 0
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-slate-500'
                    }`}
                  >
                    {formatBalanceLabel(s.total_net)}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 rounded-lg bg-slate-50 dark:bg-slate-950 p-2.5 font-mono text-[11px]">
                  <div>
                    <div className="text-slate-400">{isBn ? `চট (${s.jute_taken}/${s.jute_deposited})` : `Jute (${s.jute_taken}/${s.jute_deposited})`}</div>
                    <div className="font-semibold">{formatBalanceLabel(s.jute_net)}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-slate-400">{isBn ? `প্লাস্টিক (${s.plastic_taken}/${s.plastic_deposited})` : `Plastic (${s.plastic_taken}/${s.plastic_deposited})`}</div>
                    <div className="font-semibold">{formatBalanceLabel(s.plastic_net)}</div>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setSelectedSupplierId(selectedSupplierId === s.supplier_id ? 0 : s.supplier_id)}
                    className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium"
                  >
                    {selectedSupplierId === s.supplier_id ? (isBn ? 'ফিল্টার সরান' : 'Unfilter') : isBn ? 'লেজার দেখুন' : 'Ledger'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExportSupplierLedgerPdf('bn', s)}
                    className="min-h-[38px] inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium"
                  >
                    <FileText className="w-3.5 h-3.5" /> PDF
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {/* Desktop Summary Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'সাপ্লায়ার' : 'Supplier'}</th>
                <th className="text-right px-3 py-2.5 font-medium">{isBn ? 'চট (নিয়েছে / জমা)' : 'Jute (Out / In)'}</th>
                <th className="text-right px-3 py-2.5 font-medium">{isBn ? 'চট ব্যালেন্স' : 'Jute Balance'}</th>
                <th className="text-right px-3 py-2.5 font-medium">{isBn ? 'প্লাস্টিক (নিয়েছে / জমা)' : 'Plastic (Out / In)'}</th>
                <th className="text-right px-3 py-2.5 font-medium">{isBn ? 'প্লাস্টিক ব্যালেন্স' : 'Plastic Balance'}</th>
                <th className="text-right px-3 py-2.5 font-medium">{isBn ? 'সর্বমোট অবস্থা' : 'Net Status'}</th>
                <th className="text-right px-4 py-2.5 font-medium">{isBn ? 'রিপোর্ট / লেজার' : 'Report'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    {isBn ? 'বস্তার হিসাব লোড হচ্ছে...' : 'Loading supplier bag balances...'}
                  </td>
                </tr>
              ) : filteredSummaries.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                    {isBn ? 'কোনো সাপ্লায়ার পাওয়া যায়নি।' : 'No matching suppliers.'}
                  </td>
                </tr>
              ) : (
                filteredSummaries.map((s) => (
                  <tr
                    key={s.supplier_id}
                    className={`hover:bg-slate-50 dark:hover:bg-slate-800/40 ${
                      selectedSupplierId === s.supplier_id ? 'bg-amber-50/50 dark:bg-amber-950/20' : ''
                    }`}
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-slate-900 dark:text-white">{s.supplier_name}</div>
                      <div className="font-mono text-[11px] text-slate-500">{s.party_code}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {s.jute_taken} / {s.jute_deposited}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${
                          s.jute_net > 0
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                            : s.jute_net < 0
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                            : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                        }`}
                      >
                        {formatBalanceLabel(s.jute_net)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                      {s.plastic_taken} / {s.plastic_deposited}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                      <span
                        className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${
                          s.plastic_net > 0
                            ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                            : s.plastic_net < 0
                            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                            : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                        }`}
                      >
                        {formatBalanceLabel(s.plastic_net)}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums font-semibold">
                      <span
                        className={
                          s.total_net > 0
                            ? 'text-amber-700 dark:text-amber-400'
                            : s.total_net < 0
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-slate-500'
                        }
                      >
                        {formatBalanceLabel(s.total_net)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setSelectedSupplierId(selectedSupplierId === s.supplier_id ? 0 : s.supplier_id)}
                          className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-medium"
                        >
                          {selectedSupplierId === s.supplier_id ? (isBn ? 'ফিল্টার সরান' : 'Unfilter') : isBn ? 'লেজার দেখুন' : 'Ledger'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleExportSupplierLedgerPdf('bn', s)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-medium"
                          title={isBn ? 'বাংলা PDF লেজার' : 'Bangla Ledger PDF'}
                        >
                          <FileText className="w-3 h-3" /> PDF
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bag Ledger History */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-300">
            {isBn ? 'বস্তা লেনদেনের বিস্তারিত ইতিহাস' : 'Bag Ledger Transaction History'} ({filteredEntries.length})
          </h4>
        </div>

        {/* Mobile Bag History Cards */}
        <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
          {filteredEntries.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-slate-500">
              {isBn ? 'কোনো বস্তার লেনদেন নেই।' : 'No bag ledger transactions yet.'}
            </div>
          ) : (
            filteredEntries.map((e) => {
              const isOut = e.direction === 'OUT_TO_SUPPLIER';
              return (
                <div key={e.id} className="p-3.5 space-y-2 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-mono font-semibold text-slate-900 dark:text-white">{e.entry_no}</div>
                      <div className="text-slate-600 dark:text-slate-300">{e.supplier_name} · {e.entry_date}</div>
                    </div>
                    <div className={`font-mono font-bold ${isOut ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'}`}>
                      {isOut ? '+' : '-'}{e.total_qty.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'}
                    </div>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>{entryTypeLabel(e.entry_type)}</span>
                    <span className="font-mono">
                      {isBn ? 'চট' : 'J'}: {e.jute_qty} · {isBn ? 'প্লা.' : 'P'}: {e.plastic_qty}
                    </span>
                  </div>
                  {(e.reference_no || e.notes) && (
                    <div className="text-[11px] text-slate-500 truncate">
                      {e.reference_no ? `[${e.reference_no}] ` : ''}{e.notes}
                    </div>
                  )}
                  <div className="flex items-center justify-end gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        const sum = summaries.find((s) => s.supplier_id === e.supplier_id) || null;
                        void exportEmptyBagSlipPdf(e, sum, lang, 'open');
                      }}
                      className="min-h-[38px] inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium"
                    >
                      <FileText className="w-3.5 h-3.5" /> {isBn ? 'স্লিপ PDF' : 'Slip PDF'}
                    </button>
                    {canDelete && e.reference_type !== 'PADDY_PURCHASE' && (
                      <button
                        type="button"
                        onClick={() => handleDeleteEntry(e)}
                        className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg border border-red-200 dark:border-red-900/50 text-red-600"
                        title={isBn ? 'মুছুন' : 'Delete'}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Desktop Bag History Table */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'তারিখ ও নং' : 'Date & No'}</th>
                <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'সাপ্লায়ার' : 'Supplier'}</th>
                <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'লেনদেনের ধরন' : 'Type'}</th>
                <th className="text-right px-3 py-2.5 font-medium">{isBn ? 'চট বস্তা' : 'Jute'}</th>
                <th className="text-right px-3 py-2.5 font-medium">{isBn ? 'প্লাস্টিক বস্তা' : 'Plastic'}</th>
                <th className="text-right px-3 py-2.5 font-medium">{isBn ? 'মোট বস্তা' : 'Total'}</th>
                <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'রেফারেন্স / নোট' : 'Reference / Notes'}</th>
                <th className="text-right px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredEntries.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                    {isBn ? 'কোনো বস্তার লেনদেন নেই।' : 'No bag ledger transactions yet.'}
                  </td>
                </tr>
              ) : (
                filteredEntries.map((e) => {
                  const isOut = e.direction === 'OUT_TO_SUPPLIER';
                  return (
                    <tr key={e.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-4 py-2.5 font-mono">
                        <div className="font-medium text-slate-900 dark:text-white">{e.entry_no}</div>
                        <div className="text-[11px] text-slate-500">{e.entry_date}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-slate-900 dark:text-white">{e.supplier_name}</div>
                        <div className="text-[11px] font-mono text-slate-500">{e.party_code}</div>
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium ${
                            isOut
                              ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                              : 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                          }`}
                        >
                          {isOut ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownLeft className="w-3 h-3" />}
                          {entryTypeLabel(e.entry_type)}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                        {e.jute_qty > 0 ? e.jute_qty.toLocaleString('en-IN') : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                        {e.plastic_qty > 0 ? e.plastic_qty.toLocaleString('en-IN') : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono tabular-nums font-semibold">
                        {isOut ? '+' : '-'}
                        {e.total_qty.toLocaleString('en-IN')}
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300 max-w-[240px] truncate">
                        {e.reference_no ? <span className="font-mono text-[11px] mr-1.5">[{e.reference_no}]</span> : null}
                        {e.notes || '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              const sum = summaries.find((s) => s.supplier_id === e.supplier_id) || null;
                              void exportEmptyBagSlipPdf(e, sum, lang, 'open');
                            }}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-medium"
                            title={isBn ? 'সাদা-কালো বস্তা স্লিপ PDF' : 'Empty Bag Slip PDF'}
                          >
                            <FileText className="w-3 h-3" /> {isBn ? 'স্লিপ PDF' : 'Slip PDF'}
                          </button>
                          {canDelete && e.reference_type !== 'PADDY_PURCHASE' && (
                            <button
                              type="button"
                              onClick={() => handleDeleteEntry(e)}
                              className="p-1.5 rounded hover:bg-red-50 dark:hover:bg-red-950/30 text-red-600"
                              title={isBn ? 'মুছুন' : 'Delete'}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
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
    </div>
  );
};
