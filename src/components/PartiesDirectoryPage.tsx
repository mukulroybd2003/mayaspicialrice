import React, { useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  Edit3,
  FileSpreadsheet,
  FileText,
  History,
  Package,
  Plus,
  Power,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import type { AppLang } from '../i18n/translations';
import { apiGet, apiMutate } from '../services/api';
import type {
  Account,
  DirectPaddySale,
  PaddyPurchase,
  Party,
  PartyLedgerResponse,
  PartyType,
  SalesInvoice,
  VoucherType,
} from '../types/erp';
import { computePartyDueAdvance } from '../utils/partyBalance';
import { exportExcelWorkbook, exportPartyStatementPdf, exportPdfTableReport } from '../utils/reports';
import { SupplierBagLedgerPanel } from './SupplierBagLedgerPanel';

export { computePartyDueAdvance };

interface PartiesDirectoryPageProps {
  mode: 'CUSTOMER' | 'SUPPLIER';
  parties: Party[];
  accounts: Account[];
  purchases: PaddyPurchase[];
  invoices: SalesInvoice[];
  paddySales: DirectPaddySale[];
  onRefresh: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

export const PartiesDirectoryPage: React.FC<PartiesDirectoryPageProps> = ({
  mode,
  parties,
  accounts,
  purchases,
  invoices,
  paddySales,
  onRefresh,
  onNotify,
}) => {
  const { t, lang } = useI18n();
  const isBn = lang === 'bn';

  const isCustomer = mode === 'CUSTOMER';
  const titleLabel = isCustomer ? t('party.customer') : t('party.supplier');

  const [supplierSubTab, setSupplierSubTab] = useState<'directory' | 'bags'>('directory');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [balanceFilter, setBalanceFilter] = useState<'ALL' | 'DUE' | 'ADVANCE'>('ALL');

  const [formOpen, setFormOpen] = useState(false);
  const [editingParty, setEditingParty] = useState<Party | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Party | null>(null);
  const [saving, setSaving] = useState(false);

  const [partyForm, setPartyForm] = useState({
    party_type: mode as PartyType,
    name: '',
    contact_person: '',
    phone: '',
    email: '',
    tax_id: '',
    address: '',
    credit_limit: 0,
    opening_balance: 0,
    opening_balance_type: 'NONE' as 'NONE' | 'DUE' | 'ADVANCE',
    is_active: true,
  });

  // Payment / Advance Modal state
  const [payTarget, setPayTarget] = useState<Party | null>(null);
  const [payForm, setPayForm] = useState({
    voucher_type: (isCustomer ? 'DUE_RECEIPT' : 'DUE_PAYMENT') as VoucherType,
    account_id: accounts.find((a) => a.account_code === '1001' || a.account_code === '1002')?.id || 1,
    amount: 0,
    payment_mode: 'CASH' as 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'UPI_MOBILE',
    settled_ref_no: '',
    reference_no: '',
    notes: '',
  });

  // Statement Drawer state
  const [ledgerData, setLedgerData] = useState<PartyLedgerResponse | null>(null);
  const [loadingLedger, setLoadingLedger] = useState(false);

  const cashBankAccounts = useMemo(() => {
    const list = accounts.filter(
      (a) =>
        a.account_type === 'ASSET' &&
        a.account_code !== '1100' &&
        a.account_code !== '1200' &&
        (a.account_code.startsWith('10') || /cash|bank|petty|upi|bkash|nagad/i.test(a.name))
    );
    return list.length > 0 ? list : accounts.filter((a) => a.account_code === '1001' || a.account_code === '1002');
  }, [accounts]);

  const scopedParties = useMemo(() => {
    return parties.filter((p) => p.party_type === mode || p.party_type === 'BOTH');
  }, [parties, mode]);

  const metrics = useMemo(() => {
    let activeCount = 0;
    let totalDue = 0;
    let totalAdvance = 0;
    let totalBusiness = 0;
    for (const p of scopedParties) {
      if (p.is_active) activeCount += 1;
      const { due, advance } = computePartyDueAdvance(p, mode);
      totalDue += due;
      totalAdvance += advance;
      totalBusiness += isCustomer ? Number(p.total_sold || 0) : Number(p.total_purchased || 0);
    }
    return { activeCount, totalDue, totalAdvance, totalBusiness };
  }, [scopedParties, mode, isCustomer]);

  const filteredParties = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scopedParties.filter((p) => {
      if (statusFilter === 'ACTIVE' && !p.is_active) return false;
      if (statusFilter === 'INACTIVE' && p.is_active) return false;
      const { due, advance } = computePartyDueAdvance(p, mode);
      if (balanceFilter === 'DUE' && due <= 0.01) return false;
      if (balanceFilter === 'ADVANCE' && advance <= 0.01) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.party_code.toLowerCase().includes(q) ||
        (p.phone || '').toLowerCase().includes(q) ||
        (p.tax_id || '').toLowerCase().includes(q) ||
        (p.address || '').toLowerCase().includes(q)
      );
    });
  }, [scopedParties, search, statusFilter, balanceFilter, mode]);

  const openCreateForm = () => {
    setEditingParty(null);
    setPartyForm({
      party_type: mode,
      name: '',
      contact_person: '',
      phone: '',
      email: '',
      tax_id: '',
      address: '',
      credit_limit: 0,
      opening_balance: 0,
      opening_balance_type: 'NONE',
      is_active: true,
    });
    setFormOpen(true);
  };

  const openEditForm = (p: Party) => {
    setEditingParty(p);
    const ob = Number(p.opening_balance || 0);
    let obType: 'NONE' | 'DUE' | 'ADVANCE' = 'NONE';
    if (ob !== 0) {
      if (isCustomer) {
        obType = ob > 0 ? 'DUE' : 'ADVANCE';
      } else {
        obType = ob < 0 ? 'DUE' : 'ADVANCE';
      }
    }
    setPartyForm({
      party_type: p.party_type,
      name: p.name,
      contact_person: p.contact_person || '',
      phone: p.phone || '',
      email: p.email || '',
      tax_id: p.tax_id || '',
      address: p.address || '',
      credit_limit: Number(p.credit_limit || 0),
      opening_balance: Math.abs(ob),
      opening_balance_type: obType,
      is_active: Boolean(p.is_active),
    });
    setFormOpen(true);
  };

  const handleSaveParty = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const signedMode =
        partyForm.opening_balance_type === 'NONE' || Number(partyForm.opening_balance) <= 0
          ? 'NONE'
          : partyForm.opening_balance_type === 'DUE'
          ? partyForm.party_type === 'SUPPLIER'
            ? 'SUPPLIER_DUE'
            : 'CUSTOMER_DUE'
          : partyForm.party_type === 'SUPPLIER'
          ? 'SUPPLIER_ADVANCE'
          : 'CUSTOMER_ADVANCE';

      const payload = {
        ...partyForm,
        opening_balance: partyForm.opening_balance_type === 'NONE' ? 0 : Number(partyForm.opening_balance || 0),
        opening_balance_type: signedMode,
      };

      const res = await apiMutate({
        endpoint: editingParty ? `/api/v1/parties/${editingParty.id}` : '/api/v1/parties',
        method: editingParty ? 'PUT' : 'POST',
        payload,
        module: `${mode} Master`,
        summary: `${editingParty ? 'Update' : 'Create'} ${mode}: ${partyForm.name}`,
      });

      onNotify(
        res.offlineQueued
          ? isBn
            ? `অফলাইন: ${titleLabel} সিঙ্ক কিউতে সংরক্ষিত হয়েছে।`
            : `Offline: ${titleLabel} saved to sync queue.`
          : isBn
          ? `${titleLabel} "${partyForm.name}" ${editingParty ? 'আপডেট হয়েছে' : 'তৈরি হয়েছে'}।`
          : `${titleLabel} "${partyForm.name}" ${editingParty ? 'updated' : 'created'}.`,
        res.offlineQueued ? 'warn' : 'ok'
      );
      setFormOpen(false);
      setEditingParty(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleStatus = async (p: Party) => {
    try {
      const nextActive = !Boolean(p.is_active);
      await apiMutate({
        endpoint: `/api/v1/parties/${p.id}/status`,
        method: 'PATCH',
        payload: { is_active: nextActive },
        module: `${mode} Status`,
        summary: `${nextActive ? 'Activate' : 'Deactivate'} ${p.name}`,
      });
      onNotify(
        isBn
          ? `${p.name} — ${nextActive ? 'সক্রিয়' : 'নিষ্ক্রিয়'} করা হয়েছে।`
          : `${p.name} marked ${nextActive ? 'Active' : 'Inactive'}.`,
        'ok'
      );
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiMutate({
        endpoint: `/api/v1/parties/${deleteTarget.id}`,
        method: 'DELETE',
        payload: {},
        module: `${mode} Delete`,
        summary: `Delete ${deleteTarget.name}`,
      });
      onNotify(
        isBn ? `${deleteTarget.name} স্থায়ীভাবে মুছে ফেলা হয়েছে।` : `${deleteTarget.name} deleted permanently.`,
        'ok'
      );
      setDeleteTarget(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
      setDeleteTarget(null);
    }
  };

  const openPayModal = (p: Party, vType: VoucherType) => {
    const { due } = computePartyDueAdvance(p, mode);
    setPayTarget(p);
    setPayForm({
      voucher_type: vType,
      account_id: cashBankAccounts[0]?.id || accounts[0]?.id || 1,
      amount: vType === 'DUE_PAYMENT' || vType === 'DUE_RECEIPT' ? (due > 0 ? due : 0) : 0,
      payment_mode: 'CASH',
      settled_ref_no: '',
      reference_no: '',
      notes: '',
    });
  };

  const openBillsForPayTarget = useMemo(() => {
    if (!payTarget) return [];
    if (payForm.voucher_type === 'DUE_PAYMENT') {
      return purchases
        .filter((pp) => pp.supplier_id === payTarget.id && pp.payment_status !== 'PAID')
        .map((pp) => ({
          refNo: pp.purchase_no,
          due: Number((pp.total_payable - pp.paid_amount).toFixed(2)),
          total: pp.total_payable,
        }));
    }
    if (payForm.voucher_type === 'DUE_RECEIPT') {
      return [
        ...invoices
          .filter((si) => si.customer_id === payTarget.id && si.payment_status !== 'PAID')
          .map((si) => ({
            refNo: si.invoice_no,
            due: Number((si.total_amount - si.paid_amount).toFixed(2)),
            total: si.total_amount,
          })),
        ...paddySales
          .filter((ps) => ps.customer_id === payTarget.id && ps.payment_status !== 'PAID')
          .map((ps) => ({
            refNo: ps.sale_no,
            due: Number((ps.total_amount - ps.paid_amount).toFixed(2)),
            total: ps.total_amount,
          })),
      ];
    }
    return [];
  }, [payTarget, payForm.voucher_type, purchases, invoices, paddySales]);

  const handleSubmitPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payTarget) return;
    setSaving(true);
    try {
      const direction =
        payForm.voucher_type === 'DUE_RECEIPT' || payForm.voucher_type === 'ADVANCE_RECEIPT' ? 'RECEIPT' : 'PAYMENT';
      const res = await apiMutate({
        endpoint: '/api/v1/payments',
        method: 'POST',
        payload: {
          ...payForm,
          direction,
          party_id: payTarget.id,
        },
        module: 'Due & Advance Voucher',
        summary: `${payForm.voucher_type} ৳${payForm.amount.toLocaleString()} (${payTarget.name})`,
      });
      onNotify(
        res.offlineQueued
          ? isBn
            ? 'অফলাইন: পেমেন্ট ভাউচার IndexedDB-তে জমা হয়েছে।'
            : 'Offline: Payment voucher queued in IndexedDB.'
          : isBn
          ? `${payTarget.name}-এর জন্য ৳${payForm.amount.toLocaleString('en-IN')} ভাউচার সংরক্ষিত হয়েছে।`
          : `${payForm.voucher_type.replace('_', ' ')} of ৳${payForm.amount.toLocaleString('en-IN')} posted for ${payTarget.name}.`,
        res.offlineQueued ? 'warn' : 'ok'
      );
      setPayTarget(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const handleOpenLedger = async (p: Party) => {
    setLoadingLedger(true);
    try {
      const res = await apiGet<PartyLedgerResponse>(`/api/v1/parties/${p.id}/ledger`, `cache_party_ledger_${p.id}`);
      setLedgerData(res);
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setLoadingLedger(false);
    }
  };

  const handleExportDirectoryPdf = (exportLang: AppLang) => {
    const bn = exportLang === 'bn';
    const label = isCustomer ? (bn ? 'কাস্টমার' : 'Customer') : bn ? 'সাপ্লায়ার' : 'Supplier';
    exportPdfTableReport({
      lang: exportLang,
      title: bn ? `${label} বকেয়া ও অগ্রিম রিপোর্ট` : `${label} Due & Advance Report`,
      subtitle: bn
        ? `মোট ${label}: ${filteredParties.length} | মোট বকেয়া: ৳${metrics.totalDue.toLocaleString('en-IN')} | অগ্রিম: ৳${metrics.totalAdvance.toLocaleString('en-IN')}`
        : `${label}s: ${filteredParties.length} | Total Due: BDT ${metrics.totalDue.toLocaleString('en-IN')} | Advance: BDT ${metrics.totalAdvance.toLocaleString('en-IN')}`,
      filename: `SonaGrain-${isCustomer ? 'Customers' : 'Suppliers'}-Due-Advance`,
      columns: bn
        ? ['কোড', 'নাম', 'ফোন', isCustomer ? 'মোট বিক্রয়' : 'মোট ক্রয়', 'বকেয়া (৳)', 'অগ্রিম (৳)', 'অবস্থা']
        : ['Code', 'Name', 'Phone', isCustomer ? 'Total Sales' : 'Total Purchased', 'Due (BDT)', 'Advance (BDT)', 'Status'],
      rows: filteredParties.map((p) => {
        const { due, advance } = computePartyDueAdvance(p, mode);
        return [
          p.party_code,
          p.name,
          p.phone || '-',
          (isCustomer ? Number(p.total_sold || 0) : Number(p.total_purchased || 0)).toFixed(2),
          due.toFixed(2),
          advance.toFixed(2),
          p.is_active ? (bn ? 'সক্রিয়' : 'ACTIVE') : bn ? 'নিষ্ক্রিয়' : 'INACTIVE',
        ];
      }),
    });
  };

  const handleExportDirectoryExcel = (exportLang: AppLang) => {
    const bn = exportLang === 'bn';
    exportExcelWorkbook(
      `SonaGrain-${isCustomer ? 'Customers' : 'Suppliers'}-Directory`,
      [
        {
          name: isCustomer ? (bn ? 'কাস্টমার তালিকা' : 'Customers') : bn ? 'সাপ্লায়ার তালিকা' : 'Suppliers',
          rows: filteredParties.map((p) => {
            const { due, advance } = computePartyDueAdvance(p, mode);
            return bn
              ? {
                  কোড: p.party_code,
                  নাম: p.name,
                  ধরন: p.party_type,
                  যোগাযোগকারী: p.contact_person || '',
                  ফোন: p.phone || '',
                  জিএসটি_আইডি: p.tax_id || '',
                  ঠিকানা: p.address || '',
                  প্রারম্ভিক_ব্যালেন্স: p.opening_balance,
                  মোট_বিল: isCustomer ? Number(p.total_sold || 0) : Number(p.total_purchased || 0),
                  বকেয়া_টাকা: due,
                  অগ্রিম_টাকা: advance,
                  অবস্থা: p.is_active ? 'সক্রিয়' : 'নিষ্ক্রিয়',
                }
              : {
                  Code: p.party_code,
                  Name: p.name,
                  Type: p.party_type,
                  ContactPerson: p.contact_person || '',
                  Phone: p.phone || '',
                  TaxID: p.tax_id || '',
                  Address: p.address || '',
                  OpeningBalance: p.opening_balance,
                  TotalBilled: isCustomer ? Number(p.total_sold || 0) : Number(p.total_purchased || 0),
                  DueAmount: due,
                  AdvanceAmount: advance,
                  Status: p.is_active ? 'ACTIVE' : 'INACTIVE',
                };
          }),
        },
      ],
      exportLang
    );
  };

  return (
    <div className="space-y-5">
      {!isCustomer && (
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
          <button
            type="button"
            onClick={() => setSupplierSubTab('directory')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              supplierSubTab === 'directory'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {isBn ? 'সাপ্লায়ার তালিকা ও টাকা লেজার' : 'Suppliers & Cash Ledger'}
          </button>
          <button
            type="button"
            onClick={() => setSupplierSubTab('bags')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              supplierSubTab === 'bags'
                ? 'bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-400 shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Package className="w-3.5 h-3.5" />
            <span>{isBn ? 'বস্তার হিসাব ও রিপোর্ট (চট / প্লাস্টিক)' : 'Bag Ledger & Reports (Jute / Plastic)'}</span>
          </button>
        </div>
      )}

      {!isCustomer && supplierSubTab === 'bags' ? (
        <SupplierBagLedgerPanel suppliers={scopedParties} onNotify={onNotify} />
      ) : (
        <>
          {/* KPI Summary Strip */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{isCustomer ? t('party.activeCustomers') : t('party.activeSuppliers')}</div>
          <div className="text-xl font-display font-bold font-mono tabular-nums mt-1">
            {metrics.activeCount}{' '}
            <span className="text-xs font-normal text-slate-400">
              / {scopedParties.length} {t('party.total')}
            </span>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{isCustomer ? t('party.custDueLabel') : t('party.suppDueLabel')}</div>
          <div className="text-xl font-display font-bold font-mono tabular-nums mt-1 text-red-600 dark:text-red-400">
            ৳{metrics.totalDue.toLocaleString('en-IN')}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{isCustomer ? t('party.custAdvLabel') : t('party.suppAdvLabel')}</div>
          <div className="text-xl font-display font-bold font-mono tabular-nums mt-1 text-emerald-700 dark:text-emerald-400">
            ৳{metrics.totalAdvance.toLocaleString('en-IN')}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{isCustomer ? t('party.lifetimeSales') : t('party.lifetimePurchases')}</div>
          <div className="text-xl font-display font-bold font-mono tabular-nums mt-1">
            ৳{metrics.totalBusiness.toLocaleString('en-IN')}
          </div>
        </div>
      </div>

      {/* Action & Filter Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder={t('common.search')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 w-60"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as 'ALL' | 'ACTIVE' | 'INACTIVE')}
            className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
          >
            <option value="ALL">{t('common.allStatus')}</option>
            <option value="ACTIVE">{t('common.activeOnly')}</option>
            <option value="INACTIVE">{t('common.inactiveOnly')}</option>
          </select>
          <select
            value={balanceFilter}
            onChange={(e) => setBalanceFilter(e.target.value as 'ALL' | 'DUE' | 'ADVANCE')}
            className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
          >
            <option value="ALL">{t('party.allBalances')}</option>
            <option value="DUE">{t('party.hasDue')}</option>
            <option value="ADVANCE">{t('party.hasAdvance')}</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={() => handleExportDirectoryPdf('en')}
            className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <FileText className="w-3.5 h-3.5" /> {t('rep.pdfEn')}
          </button>
          <button
            onClick={() => handleExportDirectoryPdf('bn')}
            className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <FileText className="w-3.5 h-3.5" /> {t('rep.pdfBn')}
          </button>
          <button
            onClick={() => handleExportDirectoryExcel('en')}
            className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" /> {t('rep.excelEn')}
          </button>
          <button
            onClick={() => handleExportDirectoryExcel('bn')}
            className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <FileSpreadsheet className="w-3.5 h-3.5" /> {t('rep.excelBn')}
          </button>
          <button
            onClick={openCreateForm}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium hover:opacity-95 whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" /> {isCustomer ? t('party.addCustomer') : t('party.addSupplier')}
          </button>
        </div>
      </div>

      {/* Add / Edit Party Form */}
      {formOpen && (
        <form
          onSubmit={handleSaveParty}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
        >
          <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
            <h3 className="text-sm font-display font-semibold">
              {editingParty
                ? `${t('party.editPrefix')} ${titleLabel}: ${editingParty.name}`
                : isCustomer
                ? t('party.newCustomer')
                : t('party.newSupplier')}
            </h3>
            <button type="button" onClick={() => setFormOpen(false)} className="p-1 text-slate-400 hover:text-slate-600">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block text-xs font-medium mb-1">{t('party.name')}</label>
              <input
                type="text"
                required
                value={partyForm.name}
                onChange={(e) => setPartyForm({ ...partyForm, name: e.target.value })}
                placeholder={isCustomer ? (isBn ? 'কাস্টমারের নাম' : 'Customer name') : isBn ? 'সাপ্লায়ারের নাম' : 'Supplier name'}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{t('party.role')}</label>
              <select
                value={partyForm.party_type}
                onChange={(e) => setPartyForm({ ...partyForm, party_type: e.target.value as PartyType })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="CUSTOMER">{t('party.roleCustomer')}</option>
                <option value="SUPPLIER">{t('party.roleSupplier')}</option>
                <option value="BOTH">{t('party.roleBoth')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{t('party.contactPerson')}</label>
              <input
                type="text"
                value={partyForm.contact_person}
                onChange={(e) => setPartyForm({ ...partyForm, contact_person: e.target.value })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{t('party.phone')}</label>
              <input
                type="text"
                value={partyForm.phone}
                onChange={(e) => setPartyForm({ ...partyForm, phone: e.target.value })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{t('party.email')}</label>
              <input
                type="email"
                value={partyForm.email}
                onChange={(e) => setPartyForm({ ...partyForm, email: e.target.value })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{t('party.taxId')}</label>
              <input
                type="text"
                value={partyForm.tax_id}
                onChange={(e) => setPartyForm({ ...partyForm, tax_id: e.target.value })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-xs font-medium mb-1">{t('party.address')}</label>
              <input
                type="text"
                value={partyForm.address}
                onChange={(e) => setPartyForm({ ...partyForm, address: e.target.value })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{t('party.openingType')}</label>
              <select
                value={partyForm.opening_balance_type}
                onChange={(e) => setPartyForm({ ...partyForm, opening_balance_type: e.target.value as 'NONE' | 'DUE' | 'ADVANCE' })}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="NONE">{t('party.openingZero')}</option>
                <option value="DUE">{isCustomer ? t('party.openingCustDue') : t('party.openingSuppDue')}</option>
                <option value="ADVANCE">{isCustomer ? t('party.openingCustAdv') : t('party.openingSuppAdv')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{t('party.openingAmount')}</label>
              <input
                type="number"
                min="0"
                step="0.01"
                disabled={partyForm.opening_balance_type === 'NONE'}
                value={partyForm.opening_balance}
                onChange={(e) => setPartyForm({ ...partyForm, opening_balance: Number(e.target.value) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 disabled:opacity-50"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{t('party.creditLimit')}</label>
              <input
                type="number"
                min="0"
                value={partyForm.credit_limit}
                onChange={(e) => setPartyForm({ ...partyForm, credit_limit: Number(e.target.value) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="flex items-end gap-2">
              <button
                type="submit"
                disabled={saving}
                className="flex-1 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50"
              >
                {saving ? t('common.saving') : editingParty ? t('common.saveChanges') : t('common.save')}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Parties Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="text-left px-4 py-3 font-medium">{t('party.code')}</th>
                <th className="text-left px-4 py-3 font-medium">{titleLabel} · {t('party.details')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('party.contact')}</th>
                <th className="text-right px-4 py-3 font-medium">{isCustomer ? t('party.totalSales') : t('party.totalPurchased')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('party.dueBalance')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('party.advance')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('common.status')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredParties.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-500">
                    {isBn
                      ? `কোনো ${titleLabel} অ্যাকাউন্ট ফিল্টারের সাথে মেলেনি।`
                      : `No ${titleLabel.toLowerCase()} accounts match your filter.`}
                  </td>
                </tr>
              ) : (
                filteredParties.map((p) => {
                  const { due, advance } = computePartyDueAdvance(p, mode);
                  const totalBilled = isCustomer ? Number(p.total_sold || 0) : Number(p.total_purchased || 0);
                  return (
                    <tr key={p.id} className={!p.is_active ? 'opacity-60 bg-slate-50/50 dark:bg-slate-950/30' : ''}>
                      <td className="px-4 py-3 font-mono font-medium">
                        <div>{p.party_code}</div>
                        {p.party_type === 'BOTH' && (
                          <div className="text-[10px] font-sans text-amber-600 dark:text-amber-400">BOTH</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900 dark:text-white">{p.name}</div>
                        <div className="text-slate-500 truncate max-w-[220px]">{p.address || p.tax_id || '—'}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div>{p.phone || '-'}</div>
                        <div className="text-[11px] text-slate-500">{p.contact_person || p.email || ''}</div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        ৳{totalBilled.toLocaleString('en-IN')}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold">
                        {due > 0 ? (
                          <span className="text-red-600 dark:text-red-400">৳{due.toLocaleString('en-IN')}</span>
                        ) : (
                          <span className="text-slate-400">৳0</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold">
                        {advance > 0 ? (
                          <span className="text-emerald-700 dark:text-emerald-400">৳{advance.toLocaleString('en-IN')}</span>
                        ) : (
                          <span className="text-slate-400">৳0</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[11px] font-mono whitespace-nowrap ${
                            p.is_active
                              ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400'
                              : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                          }`}
                        >
                          {p.is_active ? t('common.active') : t('common.inactive')}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1 flex-wrap">
                          <button
                            onClick={() => openPayModal(p, isCustomer ? 'DUE_RECEIPT' : 'DUE_PAYMENT')}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                            title={isCustomer ? t('party.optCollectDue') : t('party.optPayDue')}
                          >
                            {isCustomer ? <ArrowDownLeft className="w-3 h-3 text-emerald-600" /> : <ArrowUpRight className="w-3 h-3 text-amber-600" />}
                            <span>{isCustomer ? t('party.collectDue') : t('party.payDue')}</span>
                          </button>
                          <button
                            onClick={() => openPayModal(p, isCustomer ? 'ADVANCE_RECEIPT' : 'ADVANCE_PAYMENT')}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                            title={isCustomer ? t('party.optReceiveAdv') : t('party.optPayAdv')}
                          >
                            <span>{t('party.advShort')}</span>
                          </button>
                          <button
                            onClick={() => handleOpenLedger(p)}
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                            title={t('party.statementTitle')}
                          >
                            <History className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300" />
                          </button>
                          <button
                            onClick={() => openEditForm(p)}
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                            title={t('common.edit')}
                          >
                            <Edit3 className="w-3.5 h-3.5 text-slate-600 dark:text-slate-300" />
                          </button>
                          <button
                            onClick={() => handleToggleStatus(p)}
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                            title={p.is_active ? t('common.deactivate') : t('common.activate')}
                          >
                            <Power className={`w-3.5 h-3.5 ${p.is_active ? 'text-emerald-600' : 'text-slate-400'}`} />
                          </button>
                          <button
                            onClick={() => setDeleteTarget(p)}
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-red-50 dark:hover:bg-red-950/30"
                            title={t('common.delete')}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-red-600" />
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

      {/* Due / Advance Payment Modal */}
      {payTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <form
            onSubmit={handleSubmitPayment}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-6 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div>
                <h4 className="text-sm font-display font-semibold">{payTarget.name}</h4>
                <div className="text-[11px] font-mono text-slate-500">
                  {payTarget.party_code} · {t('party.settlementSub')}
                </div>
              </div>
              <button type="button" onClick={() => setPayTarget(null)} className="p-1 text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium mb-1">{t('party.voucherType')}</label>
                <select
                  value={payForm.voucher_type}
                  onChange={(e) => setPayForm({ ...payForm, voucher_type: e.target.value as VoucherType, settled_ref_no: '' })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {isCustomer ? (
                    <>
                      <option value="DUE_RECEIPT">{t('party.optCollectDue')}</option>
                      <option value="ADVANCE_RECEIPT">{t('party.optReceiveAdv')}</option>
                    </>
                  ) : (
                    <>
                      <option value="DUE_PAYMENT">{t('party.optPayDue')}</option>
                      <option value="ADVANCE_PAYMENT">{t('party.optPayAdv')}</option>
                    </>
                  )}
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">{t('party.cashBankAccount')}</label>
                <select
                  value={payForm.account_id}
                  onChange={(e) => setPayForm({ ...payForm, account_id: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {cashBankAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">{t('party.amount')}</label>
                <input
                  type="number"
                  required
                  min="1"
                  step="0.01"
                  value={payForm.amount}
                  onChange={(e) => setPayForm({ ...payForm, amount: Number(e.target.value) })}
                  className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{t('party.paymentMode')}</label>
                <select
                  value={payForm.payment_mode}
                  onChange={(e) =>
                    setPayForm({ ...payForm, payment_mode: e.target.value as 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'UPI_MOBILE' })
                  }
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="CASH">Cash</option>
                  <option value="BANK_TRANSFER">Bank NEFT / RTGS</option>
                  <option value="CHEQUE">Cheque</option>
                  <option value="UPI_MOBILE">UPI / Mobile</option>
                </select>
              </div>

              {openBillsForPayTarget.length > 0 && (
                <div className="col-span-2">
                  <label className="block font-medium mb-1">{t('party.settleBillOpt')}</label>
                  <select
                    value={payForm.settled_ref_no}
                    onChange={(e) => {
                      const bill = openBillsForPayTarget.find((b) => b.refNo === e.target.value);
                      setPayForm({
                        ...payForm,
                        settled_ref_no: e.target.value,
                        amount: bill ? bill.due : payForm.amount,
                      });
                    }}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="">{t('party.autoFifo')}</option>
                    {openBillsForPayTarget.map((b) => (
                      <option key={b.refNo} value={b.refNo}>
                        {b.refNo} — ৳{b.due.toLocaleString('en-IN')} / ৳{b.total.toLocaleString('en-IN')}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div>
                <label className="block font-medium mb-1">{t('party.bankRef')}</label>
                <input
                  type="text"
                  value={payForm.reference_no}
                  onChange={(e) => setPayForm({ ...payForm, reference_no: e.target.value })}
                  className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{t('common.notes')}</label>
                <input
                  type="text"
                  value={payForm.notes}
                  onChange={(e) => setPayForm({ ...payForm, notes: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPayTarget(null)}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50"
              >
                {saving ? t('party.posting') : t('party.postVoucher')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Party Statement Modal */}
      {(ledgerData || loadingLedger) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-4xl w-full max-h-[85vh] flex flex-col overflow-hidden">
            {loadingLedger || !ledgerData ? (
              <div className="p-8 text-center text-xs text-slate-500">{t('party.loadingLedger')}</div>
            ) : (
              <>
                <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-display font-semibold">
                      {t('party.statementTitle')}: {ledgerData.party.name} ({ledgerData.party.party_code})
                    </h4>
                    <div className="text-xs text-slate-500 mt-0.5">
                      {isCustomer
                        ? `${t('party.dueBalance')}: ৳${ledgerData.summary.customer_due.toLocaleString('en-IN')} · ${t('party.advance')}: ৳${ledgerData.summary.customer_advance.toLocaleString('en-IN')}`
                        : `${t('party.dueBalance')}: ৳${ledgerData.summary.supplier_due.toLocaleString('en-IN')} · ${t('party.advance')}: ৳${ledgerData.summary.supplier_advance.toLocaleString('en-IN')}`}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      onClick={() =>
                        exportPartyStatementPdf({
                          partyName: ledgerData.party.name,
                          partyCode: ledgerData.party.party_code,
                          partyType: ledgerData.party.party_type,
                          phone: ledgerData.party.phone,
                          address: ledgerData.party.address,
                          lang: 'en',
                          dueLabel: isCustomer
                            ? `Customer Due: BDT ${ledgerData.summary.customer_due.toLocaleString('en-IN')}`
                            : `Supplier Due: BDT ${ledgerData.summary.supplier_due.toLocaleString('en-IN')}`,
                          advanceLabel: isCustomer
                            ? `Customer Advance: BDT ${ledgerData.summary.customer_advance.toLocaleString('en-IN')}`
                            : `Supplier Advance: BDT ${ledgerData.summary.supplier_advance.toLocaleString('en-IN')}`,
                          entries: ledgerData.entries,
                        })
                      }
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium whitespace-nowrap shrink-0"
                    >
                      <FileText className="w-3.5 h-3.5" /> {t('rep.pdfEn')}
                    </button>
                    <button
                      onClick={() =>
                        exportPartyStatementPdf({
                          partyName: ledgerData.party.name,
                          partyCode: ledgerData.party.party_code,
                          partyType: ledgerData.party.party_type,
                          phone: ledgerData.party.phone,
                          address: ledgerData.party.address,
                          lang: 'bn',
                          dueLabel: isCustomer
                            ? `কাস্টমার বকেয়া: ৳${ledgerData.summary.customer_due.toLocaleString('en-IN')}`
                            : `সাপ্লায়ার বকেয়া: ৳${ledgerData.summary.supplier_due.toLocaleString('en-IN')}`,
                          advanceLabel: isCustomer
                            ? `কাস্টমার অগ্রিম: ৳${ledgerData.summary.customer_advance.toLocaleString('en-IN')}`
                            : `সাপ্লায়ার অগ্রিম: ৳${ledgerData.summary.supplier_advance.toLocaleString('en-IN')}`,
                          entries: ledgerData.entries,
                        })
                      }
                      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium whitespace-nowrap shrink-0"
                    >
                      <FileText className="w-3.5 h-3.5" /> {t('rep.pdfBn')}
                    </button>
                    <button
                      onClick={() =>
                        exportExcelWorkbook(
                          `Statement-${ledgerData.party.party_code}`,
                          [
                            {
                              name: isBn ? 'লেজার এন্ট্রি' : 'Ledger Entries',
                              rows: ledgerData.entries.map((e) =>
                                isBn
                                  ? {
                                      তারিখ: e.date,
                                      রেফারেন্স: e.ref_no,
                                      ধরন: e.entry_type,
                                      বিবরণ: e.description,
                                      ডেবিট: e.debit_receivable,
                                      ক্রেডিট: e.credit_payable,
                                      চলতি_ব্যালেন্স: e.running_balance,
                                    }
                                  : {
                                      Date: e.date,
                                      RefNo: e.ref_no,
                                      Type: e.entry_type,
                                      Description: e.description,
                                      DebitReceivable: e.debit_receivable,
                                      CreditPayable: e.credit_payable,
                                      RunningBalance: e.running_balance,
                                    }
                              ),
                            },
                          ],
                          lang
                        )
                      }
                      className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0"
                    >
                      <FileSpreadsheet className="w-3.5 h-3.5" /> {t('common.excel')}
                    </button>
                    <button onClick={() => setLedgerData(null)} className="p-1.5 text-slate-400 hover:text-slate-600">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="overflow-y-auto flex-1">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                        <th className="text-left px-4 py-2.5 font-medium">{t('common.date')}</th>
                        <th className="text-left px-4 py-2.5 font-medium">Ref No</th>
                        <th className="text-left px-4 py-2.5 font-medium">{t('party.particulars')}</th>
                        <th className="text-right px-4 py-2.5 font-medium">{t('party.debitPlus')}</th>
                        <th className="text-right px-4 py-2.5 font-medium">{t('party.creditMinus')}</th>
                        <th className="text-right px-4 py-2.5 font-medium">{t('party.balance')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {ledgerData.entries.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                            {t('party.noLedgerEntries')}
                          </td>
                        </tr>
                      ) : (
                        ledgerData.entries.map((e, idx) => (
                          <tr key={idx}>
                            <td className="px-4 py-2.5 font-mono text-[11px] text-slate-500">{e.date.slice(0, 16)}</td>
                            <td className="px-4 py-2.5 font-mono font-medium">{e.ref_no}</td>
                            <td className="px-4 py-2.5">{e.description}</td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                              {e.debit_receivable > 0 ? `৳${e.debit_receivable.toLocaleString('en-IN')}` : '-'}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                              {e.credit_payable > 0 ? `৳${e.credit_payable.toLocaleString('en-IN')}` : '-'}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold">
                              ৳{Math.abs(e.running_balance).toLocaleString('en-IN')} {e.running_balance >= 0 ? 'Dr' : 'Cr'}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h4 className="text-sm font-display font-semibold text-red-600 dark:text-red-400">
              {t('common.delete')} {titleLabel}: {deleteTarget.name}?
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              {t('party.deleteDesc', { code: deleteTarget.party_code })}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setDeleteTarget(null)}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button onClick={handleConfirmDelete} className="px-4 py-2 rounded-lg bg-red-600 text-white text-xs font-medium">
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
};
