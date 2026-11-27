import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  BarChart3,
  BookOpen,
  CheckCircle2,
  Edit3,
  FileSpreadsheet,
  FileText,
  Landmark,
  Plus,
  Printer,
  Receipt,
  RefreshCw,
  Trash2,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import type { AppLang } from '../i18n/translations';
import { apiGet, apiMutate } from '../services/api';
import type {
  Account,
  AccountLedgerRow,
  DirectPaddySale,
  FinancialStatements,
  JournalEntry,
  PaddyPurchase,
  Party,
  PaymentRecord,
  SalesInvoice,
  VoucherType,
} from '../types/erp';
import { computePartyDueAdvance } from '../utils/partyBalance';
import {
  exportAccountLedgerPdf,
  exportExcelWorkbook,
  exportFinancialStatementsPdf,
  exportJournalVoucherPdf,
  exportPaymentVoucherPdf,
  exportPdfTableReport,
} from '../utils/reports';
import { CashbookLedgerTab } from './CashbookLedgerTab';

interface AccountingPartiesModuleProps {
  parties: Party[];
  accounts: Account[];
  payments: PaymentRecord[];
  journalEntries: JournalEntry[];
  purchases?: PaddyPurchase[];
  invoices?: SalesInvoice[];
  paddySales?: DirectPaddySale[];
  onRefresh: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

type AccountingSubTab = 'payments' | 'cashbook' | 'expenses' | 'journal' | 'statements' | 'parties';

export const AccountingPartiesModule: React.FC<AccountingPartiesModuleProps> = ({
  parties,
  accounts,
  payments,
  journalEntries,
  purchases = [],
  invoices = [],
  paddySales = [],
  onRefresh,
  onNotify,
}) => {
  const { t, lang } = useI18n();
  const isBn = lang === 'bn';
  const todayIso = new Date().toISOString().slice(0, 10);

  const voucherLabel = (type: string | undefined, fallback: string) => {
    const mapEn: Record<string, string> = {
      DUE_RECEIPT: 'Customer Due Receipt',
      ADVANCE_RECEIPT: 'Customer Advance Receipt',
      DUE_PAYMENT: 'Supplier Due Payment',
      ADVANCE_PAYMENT: 'Supplier Advance Payment',
      DUE_SETTLEMENT: 'Due Settlement',
    };
    const mapBn: Record<string, string> = {
      DUE_RECEIPT: 'কাস্টমার বকেয়া আদায়',
      ADVANCE_RECEIPT: 'কাস্টমার অগ্রিম গ্রহণ',
      DUE_PAYMENT: 'সাপ্লায়ার বকেয়া পরিশোধ',
      ADVANCE_PAYMENT: 'সাপ্লায়ার অগ্রিম প্রদান',
      DUE_SETTLEMENT: 'বকেয়া সমন্বয়',
    };
    const dict = isBn ? mapBn : mapEn;
    return (type && dict[type]) || fallback;
  };

  const [subTab, setSubTab] = useState<AccountingSubTab>('payments');
  const [showPayForm, setShowPayForm] = useState(true);
  const [voucherFilter, setVoucherFilter] = useState<string>('ALL');
  const [partyFilter, setPartyFilter] = useState<'ALL' | 'CUSTOMER' | 'SUPPLIER' | 'BOTH'>('ALL');
  const [saving, setSaving] = useState(false);

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

  const operatingExpenseAccounts = useMemo(
    () => accounts.filter((a) => a.account_type === 'EXPENSE' && a.account_code !== '5001'),
    [accounts]
  );

  const activeParties = useMemo(() => parties.filter((p) => Boolean(p.is_active)), [parties]);

  const [payForm, setPayForm] = useState({
    voucher_type: 'DUE_PAYMENT' as VoucherType,
    party_id: activeParties[0]?.id || 0,
    account_id: cashBankAccounts[0]?.id || accounts[0]?.id || 1,
    amount: 0,
    payment_mode: 'BANK_TRANSFER' as 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'UPI_MOBILE',
    settled_ref_no: '',
    reference_no: '',
    notes: '',
  });

  // Expense Form State
  const [expForm, setExpForm] = useState({
    expense_account_id: 0,
    paid_from_account_id: 0,
    amount: 0,
    payment_mode: 'CASH' as 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'UPI_MOBILE',
    payee_name: '',
    reference_no: '',
    entry_date: todayIso,
    notes: '',
  });

  // Contra Transfer Form State
  const [contraForm, setContraForm] = useState({
    from_account_id: 0,
    to_account_id: 0,
    amount: 0,
    reference_no: '',
    entry_date: todayIso,
    notes: '',
  });
  const [expContraFilter, setExpContraFilter] = useState<'ALL' | 'EXPENSE' | 'CONTRA'>('ALL');

  // Chart of Accounts & Ledger State
  const [accountTypeFilter, setAccountTypeFilter] = useState<string>('ALL');
  const [showNewAccountForm, setShowNewAccountForm] = useState(false);
  const [newAccountForm, setNewAccountForm] = useState({
    account_code: '',
    name: '',
    account_type: 'EXPENSE' as Account['account_type'],
    opening_balance: 0,
  });
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [editingAccountName, setEditingAccountName] = useState('');

  const [selectedLedgerAccount, setSelectedLedgerAccount] = useState<Account | null>(null);
  const [ledgerEntries, setLedgerEntries] = useState<AccountLedgerRow[]>([]);
  const [loadingLedger, setLoadingLedger] = useState(false);

  // Manual Journal Voucher Builder State
  const [showJournalForm, setShowJournalForm] = useState(false);
  const [journalTypeFilter, setJournalTypeFilter] = useState<string>('ALL');
  const [jvForm, setJvForm] = useState({
    entry_date: todayIso,
    description: '',
    lines: [
      { account_id: 0, debit: 0, credit: 0 },
      { account_id: 0, debit: 0, credit: 0 },
    ],
  });

  // Financial Statements State
  const [statements, setStatements] = useState<FinancialStatements | null>(null);
  const [loadingStatements, setLoadingStatements] = useState(false);

  const effectiveExpAccountId = useMemo(() => {
    if (operatingExpenseAccounts.some((a) => a.id === expForm.expense_account_id)) {
      return expForm.expense_account_id;
    }
    return operatingExpenseAccounts[0]?.id || 0;
  }, [operatingExpenseAccounts, expForm.expense_account_id]);

  const effectiveExpPaidFromId = useMemo(() => {
    if (cashBankAccounts.some((a) => a.id === expForm.paid_from_account_id)) {
      return expForm.paid_from_account_id;
    }
    return cashBankAccounts[0]?.id || 0;
  }, [cashBankAccounts, expForm.paid_from_account_id]);

  const effectiveContraFromId = useMemo(() => {
    if (cashBankAccounts.some((a) => a.id === contraForm.from_account_id)) {
      return contraForm.from_account_id;
    }
    return cashBankAccounts[0]?.id || 0;
  }, [cashBankAccounts, contraForm.from_account_id]);

  const effectiveContraToId = useMemo(() => {
    if (
      cashBankAccounts.some((a) => a.id === contraForm.to_account_id) &&
      contraForm.to_account_id !== effectiveContraFromId
    ) {
      return contraForm.to_account_id;
    }
    return cashBankAccounts.find((a) => a.id !== effectiveContraFromId)?.id || cashBankAccounts[0]?.id || 0;
  }, [cashBankAccounts, contraForm.to_account_id, effectiveContraFromId]);

  const loadStatements = useCallback(async () => {
    setLoadingStatements(true);
    try {
      const data = await apiGet<FinancialStatements>('/api/v1/accounting/statements', 'accounting_statements');
      setStatements(data);
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setLoadingStatements(false);
    }
  }, [onNotify]);

  useEffect(() => {
    if (subTab === 'statements') {
      void loadStatements();
    }
  }, [subTab, accounts, journalEntries, loadStatements]);

  const openAccountLedger = async (acc: Account) => {
    setSelectedLedgerAccount(acc);
    setLoadingLedger(true);
    try {
      const data = await apiGet<{ account: Account; entries: AccountLedgerRow[] }>(
        `/api/v1/accounts/${acc.id}/ledger`,
        `cache_account_ledger_${acc.id}`
      );
      setSelectedLedgerAccount(data.account);
      setLedgerEntries(data.entries || []);
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setLoadingLedger(false);
    }
  };

  const dueAdvanceTotals = useMemo(() => {
    let customerDue = 0;
    let customerAdvance = 0;
    let supplierDue = 0;
    let supplierAdvance = 0;
    for (const p of parties) {
      if (p.party_type === 'CUSTOMER' || p.party_type === 'BOTH') {
        const { due, advance } = computePartyDueAdvance(p, 'CUSTOMER');
        customerDue += due;
        if (p.party_type === 'CUSTOMER') customerAdvance += advance;
      }
      if (p.party_type === 'SUPPLIER' || p.party_type === 'BOTH') {
        const { due, advance } = computePartyDueAdvance(p, 'SUPPLIER');
        supplierDue += due;
        if (p.party_type === 'SUPPLIER') supplierAdvance += advance;
      }
    }
    return { customerDue, customerAdvance, supplierDue, supplierAdvance };
  }, [parties]);

  const cashTotal = useMemo(
    () => cashBankAccounts.reduce((s, a) => s + Number(a.balance || 0), 0),
    [cashBankAccounts]
  );

  const totalOperatingExpenses = useMemo(
    () => operatingExpenseAccounts.reduce((s, a) => s + Number(a.balance || 0), 0),
    [operatingExpenseAccounts]
  );

  const eligiblePartiesForVoucher = useMemo(() => {
    const isReceipt = payForm.voucher_type === 'DUE_RECEIPT' || payForm.voucher_type === 'ADVANCE_RECEIPT';
    return activeParties.filter((p) =>
      isReceipt ? p.party_type === 'CUSTOMER' || p.party_type === 'BOTH' : p.party_type === 'SUPPLIER' || p.party_type === 'BOTH'
    );
  }, [activeParties, payForm.voucher_type]);

  const effectivePartyId = useMemo(() => {
    if (eligiblePartiesForVoucher.some((p) => p.id === payForm.party_id)) return payForm.party_id;
    return eligiblePartiesForVoucher[0]?.id || 0;
  }, [eligiblePartiesForVoucher, payForm.party_id]);

  const selectedParty = useMemo(
    () => parties.find((p) => p.id === effectivePartyId),
    [parties, effectivePartyId]
  );

  const openBillsForSelected = useMemo(() => {
    if (!effectivePartyId) return [];
    if (payForm.voucher_type === 'DUE_PAYMENT') {
      return purchases
        .filter((p) => p.supplier_id === effectivePartyId && p.payment_status !== 'PAID')
        .map((p) => ({
          refNo: p.purchase_no,
          total: p.total_payable,
          due: Number((p.total_payable - p.paid_amount).toFixed(2)),
        }));
    }
    if (payForm.voucher_type === 'DUE_RECEIPT') {
      return [
        ...invoices
          .filter((i) => i.customer_id === effectivePartyId && i.payment_status !== 'PAID')
          .map((i) => ({
            refNo: i.invoice_no,
            total: i.total_amount,
            due: Number((i.total_amount - i.paid_amount).toFixed(2)),
          })),
        ...paddySales
          .filter((s) => s.customer_id === effectivePartyId && s.payment_status !== 'PAID')
          .map((s) => ({
            refNo: s.sale_no,
            total: s.total_amount,
            due: Number((s.total_amount - s.paid_amount).toFixed(2)),
          })),
      ];
    }
    return [];
  }, [effectivePartyId, payForm.voucher_type, purchases, invoices, paddySales]);

  const allPendingBills = useMemo(() => {
    const rows: Array<{
      kind: 'PURCHASE' | 'INVOICE' | 'PADDY_SALE';
      refNo: string;
      partyId: number;
      partyName: string;
      date: string;
      total: number;
      paid: number;
      due: number;
      status: string;
    }> = [];
    for (const p of purchases) {
      if (p.payment_status !== 'PAID' && p.total_payable - p.paid_amount > 0.01) {
        rows.push({
          kind: 'PURCHASE',
          refNo: p.purchase_no,
          partyId: p.supplier_id,
          partyName: p.supplier_name || `Supplier #${p.supplier_id}`,
          date: p.created_at,
          total: p.total_payable,
          paid: p.paid_amount,
          due: Number((p.total_payable - p.paid_amount).toFixed(2)),
          status: p.payment_status,
        });
      }
    }
    for (const inv of invoices) {
      if (inv.payment_status !== 'PAID' && inv.total_amount - inv.paid_amount > 0.01) {
        rows.push({
          kind: 'INVOICE',
          refNo: inv.invoice_no,
          partyId: inv.customer_id,
          partyName: inv.customer_name || `Customer #${inv.customer_id}`,
          date: inv.created_at,
          total: inv.total_amount,
          paid: inv.paid_amount,
          due: Number((inv.total_amount - inv.paid_amount).toFixed(2)),
          status: inv.payment_status,
        });
      }
    }
    for (const ps of paddySales) {
      if (ps.payment_status !== 'PAID' && ps.total_amount - ps.paid_amount > 0.01) {
        rows.push({
          kind: 'PADDY_SALE',
          refNo: ps.sale_no,
          partyId: ps.customer_id,
          partyName: ps.customer_name || `Customer #${ps.customer_id}`,
          date: ps.created_at,
          total: ps.total_amount,
          paid: ps.paid_amount,
          due: Number((ps.total_amount - ps.paid_amount).toFixed(2)),
          status: ps.payment_status,
        });
      }
    }
    return rows.sort((a, b) => b.date.localeCompare(a.date));
  }, [purchases, invoices, paddySales]);

  const filteredPayments = useMemo(() => {
    if (voucherFilter === 'ALL') return payments;
    return payments.filter((p) => (p.voucher_type || payDirectionFallback(p)) === voucherFilter);
  }, [payments, voucherFilter]);

  function payDirectionFallback(p: PaymentRecord): string {
    return p.direction;
  }

  const filteredParties = useMemo(() => {
    if (partyFilter === 'ALL') return parties;
    return parties.filter((p) => p.party_type === partyFilter);
  }, [parties, partyFilter]);

  const expenseAndContraEntries = useMemo(() => {
    return journalEntries.filter((je) => {
      const isExp = je.reference_type === 'EXPENSE' || je.voucher_no.startsWith('EXP-');
      const isCtr = je.reference_type === 'CONTRA' || je.voucher_no.startsWith('CTR-');
      if (expContraFilter === 'EXPENSE') return isExp;
      if (expContraFilter === 'CONTRA') return isCtr;
      return isExp || isCtr;
    });
  }, [journalEntries, expContraFilter]);

  const filteredAccounts = useMemo(() => {
    if (accountTypeFilter === 'ALL') return accounts;
    return accounts.filter((a) => a.account_type === accountTypeFilter);
  }, [accounts, accountTypeFilter]);

  const filteredJournalEntries = useMemo(() => {
    if (journalTypeFilter === 'ALL') return journalEntries;
    return journalEntries.filter((je) => (je.reference_type || 'JOURNAL') === journalTypeFilter);
  }, [journalEntries, journalTypeFilter]);

  const jvTotals = useMemo(() => {
    const dr = jvForm.lines.reduce((s, l) => s + Number(l.debit || 0), 0);
    const cr = jvForm.lines.reduce((s, l) => s + Number(l.credit || 0), 0);
    return {
      debit: Number(dr.toFixed(2)),
      credit: Number(cr.toFixed(2)),
      diff: Number(Math.abs(dr - cr).toFixed(2)),
      balanced: dr > 0 && Math.abs(dr - cr) < 0.01,
    };
  }, [jvForm.lines]);

  // Submit Handlers
  const handleCreatePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectivePartyId) {
      onNotify(
        isBn ? 'ভাউচার পোস্ট করার আগে একটি সক্রিয় কাস্টমার বা সাপ্লায়ার তৈরি করুন।' : 'Create an active Customer or Supplier before posting a voucher.',
        'err'
      );
      return;
    }
    if (payForm.amount <= 0) {
      onNotify(isBn ? 'টাকার পরিমাণ শূন্যের চেয়ে বেশি হতে হবে।' : 'Payment amount must be greater than zero.', 'err');
      return;
    }
    setSaving(true);
    try {
      const direction =
        payForm.voucher_type === 'DUE_RECEIPT' || payForm.voucher_type === 'ADVANCE_RECEIPT' ? 'RECEIPT' : 'PAYMENT';
      const res = await apiMutate({
        endpoint: '/api/v1/payments',
        payload: {
          ...payForm,
          party_id: effectivePartyId,
          direction,
        },
        module: 'Due & Advance Voucher',
        summary: `${voucherLabel(payForm.voucher_type, direction)} ৳${payForm.amount.toLocaleString()}`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: পেমেন্ট ভাউচার IndexedDB-তে জমা হয়েছে।' : 'Offline: Payment voucher queued in IndexedDB.', 'warn');
      } else {
        onNotify(
          isBn ? `${voucherLabel(payForm.voucher_type, direction)} সংরক্ষিত হয়েছে ও ব্যালেন্স আপডেট হয়েছে।` : `${voucherLabel(payForm.voucher_type, direction)} posted & party balance updated.`,
          'ok'
        );
      }
      setPayForm((prev) => ({ ...prev, amount: 0, settled_ref_no: '', reference_no: '', notes: '' }));
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveExpAccountId || !effectiveExpPaidFromId || expForm.amount <= 0) {
      onNotify(
        isBn ? 'খরচের খাত, নগদ/ব্যাংক অ্যাকাউন্ট এবং সঠিক পরিমাণ দিন।' : 'Select expense head, payment account, and positive amount.',
        'err'
      );
      return;
    }
    setSaving(true);
    try {
      const res = await apiMutate({
        endpoint: '/api/v1/expenses',
        payload: {
          ...expForm,
          expense_account_id: effectiveExpAccountId,
          paid_from_account_id: effectiveExpPaidFromId,
        },
        module: 'Mill Expense',
        summary: `Expense ৳${expForm.amount.toLocaleString()}`,
      });
      onNotify(
        res.offlineQueued
          ? isBn
            ? 'অফলাইন: খরচের ভাউচার কিউতে জমা হয়েছে।'
            : 'Offline: Expense voucher queued.'
          : isBn
          ? 'খরচের ভাউচার সফলভাবে লেজারে সংরক্ষিত হয়েছে।'
          : 'Expense voucher posted to General Ledger.',
        res.offlineQueued ? 'warn' : 'ok'
      );
      setExpForm((prev) => ({ ...prev, amount: 0, payee_name: '', reference_no: '', notes: '' }));
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateContra = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveContraFromId || !effectiveContraToId || effectiveContraFromId === effectiveContraToId || contraForm.amount <= 0) {
      onNotify(
        isBn ? 'ভিন্ন উৎস ও গন্তব্য অ্যাকাউন্ট এবং সঠিক পরিমাণ দিন।' : 'Select different source & destination accounts and positive amount.',
        'err'
      );
      return;
    }
    setSaving(true);
    try {
      const res = await apiMutate({
        endpoint: '/api/v1/contra-transfers',
        payload: {
          ...contraForm,
          from_account_id: effectiveContraFromId,
          to_account_id: effectiveContraToId,
        },
        module: 'Contra Transfer',
        summary: `Contra ৳${contraForm.amount.toLocaleString()}`,
      });
      onNotify(
        res.offlineQueued
          ? isBn
            ? 'অফলাইন: কন্ট্রা ট্রান্সফার কিউতে জমা হয়েছে।'
            : 'Offline: Contra transfer queued.'
          : isBn
          ? 'ক্যাশ / ব্যাংক কন্ট্রা ট্রান্সফার সম্পন্ন হয়েছে।'
          : 'Cash / Bank contra transfer posted.',
        res.offlineQueued ? 'warn' : 'ok'
      );
      setContraForm((prev) => ({ ...prev, amount: 0, reference_no: '', notes: '' }));
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccountForm.account_code.trim() || !newAccountForm.name.trim()) {
      onNotify(isBn ? 'অ্যাকাউন্ট কোড ও নাম আবশ্যক।' : 'Account code and name are required.', 'err');
      return;
    }
    setSaving(true);
    try {
      await apiMutate({
        endpoint: '/api/v1/accounts',
        payload: newAccountForm,
        module: 'Chart of Accounts',
        summary: `New GL Account ${newAccountForm.account_code}`,
      });
      onNotify(
        isBn ? `নতুন লেজার অ্যাকাউন্ট ${newAccountForm.account_code} তৈরি হয়েছে।` : `GL Account ${newAccountForm.account_code} created.`,
        'ok'
      );
      setNewAccountForm({ account_code: '', name: '', account_type: 'EXPENSE', opening_balance: 0 });
      setShowNewAccountForm(false);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const handleRenameAccount = async (accId: number) => {
    if (!editingAccountName.trim()) return;
    setSaving(true);
    try {
      await apiMutate({
        endpoint: `/api/v1/accounts/${accId}`,
        method: 'PUT',
        payload: { name: editingAccountName.trim() },
        module: 'Chart of Accounts',
        summary: `Rename GL Account #${accId}`,
      });
      setEditingAccountId(null);
      setEditingAccountName('');
      onNotify(isBn ? 'অ্যাকাউন্টের নাম আপডেট হয়েছে।' : 'GL Account name updated.', 'ok');
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const handlePostManualJournal = async (e: React.FormEvent) => {
    e.preventDefault();
    const validLines = jvForm.lines.filter((l) => l.account_id > 0 && (l.debit > 0 || l.credit > 0));
    if (!jvForm.description.trim() || validLines.length < 2 || !jvTotals.balanced) {
      onNotify(
        isBn
          ? 'বিবরণ, কমপক্ষে ২টি লাইন এবং ডেবিট ও ক্রেডিট সমান হওয়া আবশ্যক।'
          : 'Description, at least 2 valid lines, and balanced Debit = Credit are required.',
        'err'
      );
      return;
    }
    setSaving(true);
    try {
      const res = await apiMutate({
        endpoint: '/api/v1/journal-entries',
        payload: {
          entry_date: jvForm.entry_date,
          description: jvForm.description.trim(),
          lines: validLines,
        },
        module: 'Manual Journal Voucher',
        summary: `JV ৳${jvTotals.debit.toLocaleString()}`,
      });
      onNotify(
        res.offlineQueued
          ? isBn
            ? 'অফলাইন: জার্নাল ভাউচার কিউতে জমা হয়েছে।'
            : 'Offline: Journal voucher queued.'
          : isBn
          ? 'ডাবল-এন্ট্রি জার্নাল ভাউচার লেজারে পোস্ট হয়েছে।'
          : 'Double-entry journal voucher posted.',
        res.offlineQueued ? 'warn' : 'ok'
      );
      setJvForm({
        entry_date: todayIso,
        description: '',
        lines: [
          { account_id: accounts[0]?.id || 0, debit: 0, credit: 0 },
          { account_id: accounts[1]?.id || accounts[0]?.id || 0, debit: 0, credit: 0 },
        ],
      });
      setShowJournalForm(false);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSaving(false);
    }
  };

  const exportPaymentsRegisterPdf = (exportLang: AppLang) => {
    const bn = exportLang === 'bn';
    exportPdfTableReport({
      lang: exportLang,
      title: bn ? 'নগদ ও ব্যাংক বকেয়া / অগ্রিম পেমেন্ট রেজিস্টার' : 'Cash & Bank Due / Advance Payment Register',
      subtitle: bn ? `ভাউচার সংখ্যা: ${filteredPayments.length}` : `Vouchers: ${filteredPayments.length}`,
      filename: 'SonaGrain-Payments-Register',
      columns: bn
        ? ['ভাউচার নং', 'ধরন', 'কাস্টমার/সাপ্লায়ার', 'অ্যাকাউন্ট', 'মাধ্যম', 'বিল রেফ', 'পরিমাণ (৳)', 'তারিখ']
        : ['Voucher No', 'Type', 'Party', 'Account', 'Mode', 'Settled Ref', 'Amount (BDT)', 'Date'],
      rows: filteredPayments.map((pay) => [
        pay.payment_no,
        pay.voucher_type || pay.direction,
        pay.party_name || '',
        pay.account_name || '',
        pay.payment_mode,
        pay.settled_ref_no || '-',
        pay.amount.toFixed(2),
        pay.created_at.slice(0, 16),
      ]),
    });
  };

  const exportPartiesSummaryPdf = (exportLang: AppLang) => {
    const bn = exportLang === 'bn';
    exportPdfTableReport({
      lang: exportLang,
      title: bn ? 'সকল কাস্টমার ও সাপ্লায়ার বকেয়া ও অগ্রিম রিপোর্ট' : 'All Customers & Suppliers Due & Advance Report',
      subtitle: bn ? `মোট পার্টি: ${filteredParties.length}` : `Total Parties: ${filteredParties.length}`,
      filename: 'SonaGrain-All-Parties-Due-Advance',
      columns: bn
        ? ['কোড', 'নাম', 'ধরন', 'মোট ক্রয়', 'মোট বিক্রয়', 'প্রদান', 'প্রাপ্তি', 'বর্তমান অবস্থা']
        : ['Code', 'Party Name', 'Type', 'Purchased', 'Sold', 'Paid Out', 'Received In', 'Balance Status'],
      rows: filteredParties.map((p) => [
        p.party_code,
        p.name,
        p.party_type,
        Number(p.total_purchased || 0).toFixed(2),
        Number(p.total_sold || 0).toFixed(2),
        Number(p.total_paid_out || 0).toFixed(2),
        Number(p.total_received_in || 0).toFixed(2),
        p.current_balance < 0
          ? `${bn ? 'দেনা/কাস্ট.অগ্রিম' : 'Payable/CustAdv'} ${Math.abs(p.current_balance).toFixed(2)}`
          : p.current_balance > 0
          ? `${bn ? 'পাওনা/সাপ্লা.অগ্রিম' : 'Receivable/SuppAdv'} ${p.current_balance.toFixed(2)}`
          : '0.00',
      ]),
    });
  };

  return (
    <div className="space-y-5">
      {/* Live Accounting KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{isBn ? 'মোট নগদ ও ব্যাংক স্থিতি' : 'Cash & Bank Balance'}</div>
          <div className="text-lg font-display font-bold font-mono tabular-nums mt-1 text-sky-700 dark:text-sky-400">
            ৳{cashTotal.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('acc.custDue')}</div>
          <div className="text-lg font-display font-bold font-mono tabular-nums mt-1 text-emerald-700 dark:text-emerald-400">
            ৳{dueAdvanceTotals.customerDue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{t('acc.suppDue')}</div>
          <div className="text-lg font-display font-bold font-mono tabular-nums mt-1 text-red-600 dark:text-red-400">
            ৳{dueAdvanceTotals.supplierDue.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{isBn ? 'কাস্টমার / সাপ্লায়ার অগ্রিম' : 'Customer / Supplier Adv'}</div>
          <div className="text-xs font-mono tabular-nums mt-1.5 space-y-0.5">
            <div className="text-slate-800 dark:text-slate-200">
              {isBn ? 'কাস্টমার' : 'Cust'}: ৳{dueAdvanceTotals.customerAdvance.toLocaleString('en-IN')}
            </div>
            <div className="text-amber-600 dark:text-amber-400">
              {isBn ? 'সাপ্লায়ার' : 'Supp'}: ৳{dueAdvanceTotals.supplierAdvance.toLocaleString('en-IN')}
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{isBn ? 'মোট মিল পরিচালন খরচ' : 'Operating Mill Expenses'}</div>
          <div className="text-lg font-display font-bold font-mono tabular-nums mt-1 text-amber-600 dark:text-amber-400">
            ৳{totalOperatingExpenses.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
          </div>
        </div>
      </div>

      {/* Sub-Navigation */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
          <button
            onClick={() => setSubTab('payments')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'payments' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Wallet className="w-3.5 h-3.5" />
            <span>{t('acc.tabVouchers')}</span>
          </button>
          <button
            onClick={() => setSubTab('cashbook')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'cashbook' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Landmark className="w-3.5 h-3.5" />
            <span>{isBn ? 'ক্যাশবুক ও লেজার' : 'Cashbook & Ledger'}</span>
          </button>
          <button
            onClick={() => setSubTab('expenses')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'expenses' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Receipt className="w-3.5 h-3.5" />
            <span>{isBn ? 'খরচ ও ক্যাশ-ব্যাংক' : 'Expenses & Contra'}</span>
          </button>
          <button
            onClick={() => setSubTab('journal')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'journal' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>{isBn ? 'লেজার ও জার্নাল' : 'Accounts & Journal'}</span>
          </button>
          <button
            onClick={() => setSubTab('statements')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'statements' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            <span>{isBn ? 'আর্থিক বিবরণী (P&L / BS)' : 'Financial Statements'}</span>
          </button>
          <button
            onClick={() => setSubTab('parties')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'parties' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>{t('acc.tabSummary')}</span>
          </button>
        </div>

        {subTab === 'payments' && (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={() => exportPaymentsRegisterPdf('en')}
              className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
            >
              <FileText className="w-3.5 h-3.5" /> {t('rep.pdfEn')}
            </button>
            <button
              onClick={() => exportPaymentsRegisterPdf('bn')}
              className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
            >
              <FileText className="w-3.5 h-3.5" /> {t('rep.pdfBn')}
            </button>
            <button
              onClick={() =>
                exportExcelWorkbook(
                  'SonaGrain-Payments-Register',
                  [
                    {
                      name: isBn ? 'বকেয়া ও অগ্রিম ভাউচার' : 'Due & Advance Vouchers',
                      rows: filteredPayments.map((pay) => ({
                        VoucherNo: pay.payment_no,
                        Direction: pay.direction,
                        VoucherType: pay.voucher_type || pay.direction,
                        Party: pay.party_name,
                        Account: pay.account_name,
                        Mode: pay.payment_mode,
                        BankRef: pay.reference_no || '',
                        SettledBillRef: pay.settled_ref_no || '',
                        Amount: pay.amount,
                        Notes: pay.notes || '',
                        Date: pay.created_at,
                      })),
                    },
                  ],
                  lang
                )
              }
              className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" /> {t('common.excel')}
            </button>
            <button
              onClick={() => setShowPayForm(!showPayForm)}
              className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{showPayForm ? t('acc.hideForm') : t('acc.newVoucher')}</span>
            </button>
          </div>
        )}
      </div>

      {/* TAB 1B: Cashbook Report & Unified GL / Party Ledgers */}
      {subTab === 'cashbook' && (
        <CashbookLedgerTab
          accounts={accounts}
          cashBankAccounts={cashBankAccounts}
          parties={parties}
          journalEntries={journalEntries}
          onNotify={onNotify}
        />
      )}

      {/* TAB 1: Due & Advance Payment Settlement */}
      {subTab === 'payments' && (
        <div className="space-y-5">
          {showPayForm && (
            <form
              onSubmit={handleCreatePayment}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
                <h3 className="text-sm font-display font-semibold">{t('acc.formTitle')}</h3>
                {selectedParty && (
                  <div className="text-xs font-mono">
                    {t('acc.currentBalance')}:{' '}
                    <span
                      className={
                        selectedParty.current_balance < 0
                          ? 'text-red-600 dark:text-red-400 font-semibold'
                          : selectedParty.current_balance > 0
                          ? 'text-emerald-700 dark:text-emerald-400 font-semibold'
                          : ''
                      }
                    >
                      {selectedParty.current_balance < 0
                        ? `${isBn ? 'দেনা / কাস্ট.অগ্রিম' : 'Payable / Cust Adv'} ৳${Math.abs(selectedParty.current_balance).toLocaleString('en-IN')}`
                        : selectedParty.current_balance > 0
                        ? `${isBn ? 'পাওনা / সাপ্লা.অগ্রিম' : 'Receivable / Supp Adv'} ৳${selectedParty.current_balance.toLocaleString('en-IN')}`
                        : t('party.settled')}
                    </span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-medium mb-1">{t('acc.voucherCategory')}</label>
                  <select
                    value={payForm.voucher_type}
                    onChange={(e) =>
                      setPayForm({
                        ...payForm,
                        voucher_type: e.target.value as VoucherType,
                        settled_ref_no: '',
                      })
                    }
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="DUE_PAYMENT">{t('party.optPayDue')}</option>
                    <option value="ADVANCE_PAYMENT">{t('party.optPayAdv')}</option>
                    <option value="DUE_RECEIPT">{t('party.optCollectDue')}</option>
                    <option value="ADVANCE_RECEIPT">{t('party.optReceiveAdv')}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">
                    {payForm.voucher_type.includes('RECEIPT') ? `${t('party.customer')} *` : `${t('party.supplier')} *`}
                  </label>
                  <select
                    value={effectivePartyId}
                    onChange={(e) => setPayForm({ ...payForm, party_id: Number(e.target.value), settled_ref_no: '' })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {eligiblePartiesForVoucher.length === 0 ? (
                      <option value={0}>{isBn ? 'কোনো সক্রিয় পার্টি নেই' : 'No active party available'}</option>
                    ) : (
                      eligiblePartiesForVoucher.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.party_code})
                        </option>
                      ))
                    )}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">{t('party.cashBankAccount')} *</label>
                  <select
                    value={payForm.account_id}
                    onChange={(e) => setPayForm({ ...payForm, account_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {cashBankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.account_code} {a.name} (৳{Number(a.balance).toLocaleString('en-IN')})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">{t('party.amount')} / {t('party.paymentMode')}</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      required
                      min="1"
                      step="0.01"
                      value={payForm.amount || ''}
                      placeholder="Amount"
                      onChange={(e) => setPayForm({ ...payForm, amount: Number(e.target.value) })}
                      className="w-1/2 px-2.5 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                    <select
                      value={payForm.payment_mode}
                      onChange={(e) =>
                        setPayForm({
                          ...payForm,
                          payment_mode: e.target.value as 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'UPI_MOBILE',
                        })
                      }
                      className="w-1/2 px-2 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="CASH">Cash</option>
                      <option value="BANK_TRANSFER">Bank NEFT</option>
                      <option value="CHEQUE">Cheque</option>
                      <option value="UPI_MOBILE">UPI</option>
                    </select>
                  </div>
                </div>

                {(payForm.voucher_type === 'DUE_PAYMENT' || payForm.voucher_type === 'DUE_RECEIPT') && (
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('party.settleBillOpt')}</label>
                    <select
                      value={payForm.settled_ref_no}
                      onChange={(e) => {
                        const match = openBillsForSelected.find((b) => b.refNo === e.target.value);
                        setPayForm({
                          ...payForm,
                          settled_ref_no: e.target.value,
                          amount: match ? match.due : payForm.amount,
                        });
                      }}
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="">{t('party.autoFifo')}</option>
                      {openBillsForSelected.map((b) => (
                        <option key={b.refNo} value={b.refNo}>
                          {b.refNo} (৳{b.due.toLocaleString('en-IN')})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-medium mb-1">{t('party.bankRef')}</label>
                  <input
                    type="text"
                    value={payForm.reference_no}
                    onChange={(e) => setPayForm({ ...payForm, reference_no: e.target.value })}
                    placeholder={isBn ? 'ঐচ্ছিক রেফ নং' : 'Optional ref no'}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>

                <div className={payForm.voucher_type.includes('DUE') ? 'md:col-span-1' : 'md:col-span-2'}>
                  <label className="block text-xs font-medium mb-1">{t('common.notes')}</label>
                  <input
                    type="text"
                    value={payForm.notes}
                    onChange={(e) => setPayForm({ ...payForm, notes: e.target.value })}
                    placeholder={isBn ? 'নোট লিখুন' : 'Notes'}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>

                <div className="flex items-end">
                  <button
                    type="submit"
                    disabled={saving}
                    className="w-full py-2 px-4 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50"
                  >
                    {saving ? t('party.posting') : t('party.postVoucher')}
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Pending Due Bills Quick-Settle */}
          {allPendingBills.length > 0 && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                <span className="text-xs font-semibold">
                  {t('acc.pendingBills')} ({allPendingBills.length})
                </span>
              </div>
              <div className="overflow-x-auto max-h-64">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                      <th className="text-left px-4 py-2 font-medium">{t('acc.billNo')}</th>
                      <th className="text-left px-4 py-2 font-medium">{t('acc.type')}</th>
                      <th className="text-left px-4 py-2 font-medium">{t('acc.custOrSupp')}</th>
                      <th className="text-right px-4 py-2 font-medium">{t('sales.total')}</th>
                      <th className="text-right px-4 py-2 font-medium">{t('acc.paid')}</th>
                      <th className="text-right px-4 py-2 font-medium">{t('acc.remainingDue')}</th>
                      <th className="text-right px-4 py-2 font-medium">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {allPendingBills.map((b) => (
                      <tr key={`${b.kind}-${b.refNo}`}>
                        <td className="px-4 py-2 font-mono font-medium">{b.refNo}</td>
                        <td className="px-4 py-2">
                          {b.kind === 'PURCHASE'
                            ? isBn
                              ? 'সাপ্লায়ার ক্রয়'
                              : 'Supplier Purchase'
                            : b.kind === 'INVOICE'
                            ? isBn
                              ? 'চাল বিক্রয় চালান'
                              : 'Rice Sales Invoice'
                            : isBn
                            ? 'সরাসরি ধান বিক্রয়'
                            : 'Direct Paddy Sale'}
                        </td>
                        <td className="px-4 py-2">{b.partyName}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums">৳{b.total.toLocaleString('en-IN')}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums text-slate-500">৳{b.paid.toLocaleString('en-IN')}</td>
                        <td className="px-4 py-2 text-right font-mono tabular-nums font-semibold text-red-600 dark:text-red-400">
                          ৳{b.due.toLocaleString('en-IN')}
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button
                            onClick={() => {
                              setShowPayForm(true);
                              setPayForm((prev) => ({
                                ...prev,
                                voucher_type: b.kind === 'PURCHASE' ? 'DUE_PAYMENT' : 'DUE_RECEIPT',
                                party_id: b.partyId,
                                settled_ref_no: b.refNo,
                                amount: b.due,
                              }));
                            }}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-900 dark:bg-amber-600 text-white text-[11px] font-medium whitespace-nowrap shrink-0"
                          >
                            {b.kind === 'PURCHASE' ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownLeft className="w-3 h-3" />}
                            <span>{b.kind === 'PURCHASE' ? t('party.payDue') : t('party.collectDue')}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Voucher Register */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold">{t('acc.voucherRegister')}</span>
              <select
                value={voucherFilter}
                onChange={(e) => setVoucherFilter(e.target.value)}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                <option value="ALL">{t('acc.allVouchers')}</option>
                <option value="DUE_PAYMENT">{t('party.optPayDue')}</option>
                <option value="ADVANCE_PAYMENT">{t('party.optPayAdv')}</option>
                <option value="DUE_RECEIPT">{t('party.optCollectDue')}</option>
                <option value="ADVANCE_RECEIPT">{t('party.optReceiveAdv')}</option>
              </select>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <th className="text-left px-4 py-3 font-medium">{t('acc.voucherNo')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('acc.category')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('acc.custOrSupp')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('acc.accountMode')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('acc.settledNotes')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('party.amount')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('acc.print')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredPayments.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                        {t('acc.noVouchers')}
                      </td>
                    </tr>
                  ) : (
                    filteredPayments.map((pay) => (
                      <tr key={pay.id}>
                        <td className="px-4 py-3 font-mono font-medium">
                          <div>{pay.payment_no}</div>
                          <div className="text-[10px] text-slate-400">{pay.created_at.slice(0, 16)}</div>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium whitespace-nowrap ${
                              pay.direction === 'RECEIPT'
                                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400'
                                : 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400'
                            }`}
                          >
                            {voucherLabel(pay.voucher_type, pay.direction)}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-medium">{pay.party_name}</td>
                        <td className="px-4 py-3">
                          <div>{pay.account_name}</div>
                          <div className="text-[11px] text-slate-500">
                            {pay.payment_mode} {pay.reference_no ? `· ${pay.reference_no}` : ''}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-400">
                          {pay.settled_ref_no && <div className="font-mono text-[11px]">{pay.settled_ref_no}</div>}
                          <div>{pay.notes || '-'}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold">
                          ৳{pay.amount.toLocaleString('en-IN')}
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              onClick={() => exportPaymentVoucherPdf(pay, 'en')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                            >
                              <Printer className="w-3 h-3" /> EN
                            </button>
                            <button
                              onClick={() => exportPaymentVoucherPdf(pay, 'bn')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                            >
                              <Printer className="w-3 h-3" /> বাংলা
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
        </div>
      )}

      {/* TAB 2: Operating Expenses & Cash-Bank Contra Transfers */}
      {subTab === 'expenses' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Expense Voucher Form */}
            <form
              onSubmit={handleCreateExpense}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <Receipt className="w-4 h-4 text-red-600" />
                  <h3 className="text-sm font-display font-semibold">
                    {isBn ? 'মিল পরিচালন খরচ ভাউচার (Expense)' : 'Post Mill Operating Expense'}
                  </h3>
                </div>
                <span className="text-[11px] text-slate-500 font-mono">EXP-2026-XXXX</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'খরচের খাত (Expense A/C) *' : 'Expense Head *'}</label>
                  <select
                    value={effectiveExpAccountId}
                    onChange={(e) => setExpForm({ ...expForm, expense_account_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {operatingExpenseAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.account_code} — {a.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'প্রদানকারী অ্যাকাউন্ট *' : 'Paid From (Cash/Bank) *'}</label>
                  <select
                    value={effectiveExpPaidFromId}
                    onChange={(e) => setExpForm({ ...expForm, paid_from_account_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {cashBankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.account_code} {a.name} (৳{Number(a.balance).toLocaleString('en-IN')})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'টাকার পরিমাণ (৳) *' : 'Amount (৳) *'}</label>
                  <input
                    type="number"
                    required
                    min="1"
                    step="0.01"
                    value={expForm.amount || ''}
                    onChange={(e) => setExpForm({ ...expForm, amount: Number(e.target.value) })}
                    placeholder="0.00"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'পেমেন্ট মাধ্যম ও তারিখ' : 'Mode & Date'}</label>
                  <div className="flex gap-2">
                    <select
                      value={expForm.payment_mode}
                      onChange={(e) =>
                        setExpForm({
                          ...expForm,
                          payment_mode: e.target.value as 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'UPI_MOBILE',
                        })
                      }
                      className="w-1/2 px-2 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="CASH">Cash</option>
                      <option value="BANK_TRANSFER">Bank NEFT</option>
                      <option value="CHEQUE">Cheque</option>
                      <option value="UPI_MOBILE">UPI</option>
                    </select>
                    <input
                      type="date"
                      value={expForm.entry_date}
                      onChange={(e) => setExpForm({ ...expForm, entry_date: e.target.value })}
                      className="w-1/2 px-2 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'প্রাপকের নাম / ভেন্ডর' : 'Payee / Vendor Name'}</label>
                  <input
                    type="text"
                    value={expForm.payee_name}
                    onChange={(e) => setExpForm({ ...expForm, payee_name: e.target.value })}
                    placeholder={isBn ? 'প্রাপকের নাম' : 'Payee / Vendor'}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'বিল / ভাউচার রেফ নং' : 'Bill / Ref No'}</label>
                  <input
                    type="text"
                    value={expForm.reference_no}
                    onChange={(e) => setExpForm({ ...expForm, reference_no: e.target.value })}
                    placeholder={isBn ? 'ঐচ্ছিক' : 'Optional'}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>

                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium mb-1">{isBn ? 'খরচের বিবরণ / নোট' : 'Expense Particulars / Notes'}</label>
                  <input
                    type="text"
                    value={expForm.notes}
                    onChange={(e) => setExpForm({ ...expForm, notes: e.target.value })}
                    placeholder={isBn ? 'বিবরণ লিখুন' : 'Notes'}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={saving}
                className="w-full py-2.5 px-4 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-semibold hover:opacity-95 disabled:opacity-50"
              >
                {saving
                  ? t('party.posting')
                  : isBn
                  ? 'খরচ ভাউচার পোস্ট করুন'
                  : 'Post Expense Voucher'}
              </button>
            </form>

            {/* Contra Transfer Form */}
            <form
              onSubmit={handleCreateContra}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
                <div className="flex items-center gap-2">
                  <ArrowLeftRight className="w-4 h-4 text-sky-600" />
                  <h3 className="text-sm font-display font-semibold">
                    {isBn ? 'ক্যাশ ↔ ব্যাংক কন্ট্রা ট্রান্সফার' : 'Cash ↔ Bank Contra Transfer'}
                  </h3>
                </div>
                <span className="text-[11px] text-slate-500 font-mono">CTR-2026-XXXX</span>
              </div>

              {/* Quick Direction Swap */}
              {cashBankAccounts.length >= 2 && (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setContraForm((prev) => ({
                        ...prev,
                        from_account_id: cashBankAccounts[0].id,
                        to_account_id: cashBankAccounts[1].id,
                        notes: isBn ? 'নগদ থেকে ব্যাংকে জমা' : 'Cash deposited into bank',
                      }))
                    }
                    className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                  >
                    {isBn ? 'ক্যাশ → ব্যাংক জমা' : 'Cash → Bank Deposit'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setContraForm((prev) => ({
                        ...prev,
                        from_account_id: cashBankAccounts[1].id,
                        to_account_id: cashBankAccounts[0].id,
                        notes: isBn ? 'ব্যাংক থেকে নগদ উত্তোলন' : 'Cash withdrawn from bank',
                      }))
                    }
                    className="px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-[11px] font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
                  >
                    {isBn ? 'ব্যাংক → ক্যাশ উত্তোলন' : 'Bank → Cash Withdrawal'}
                  </button>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'উৎস অ্যাকাউন্ট (From) *' : 'From Account (Credit) *'}</label>
                  <select
                    value={effectiveContraFromId}
                    onChange={(e) => setContraForm({ ...contraForm, from_account_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {cashBankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.account_code} {a.name} (৳{Number(a.balance).toLocaleString('en-IN')})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'গন্তব্য অ্যাকাউন্ট (To) *' : 'To Account (Debit) *'}</label>
                  <select
                    value={effectiveContraToId}
                    onChange={(e) => setContraForm({ ...contraForm, to_account_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {cashBankAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.account_code} {a.name} (৳{Number(a.balance).toLocaleString('en-IN')})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'ট্রান্সফার পরিমাণ (৳) *' : 'Transfer Amount (৳) *'}</label>
                  <input
                    type="number"
                    required
                    min="1"
                    step="0.01"
                    value={contraForm.amount || ''}
                    onChange={(e) => setContraForm({ ...contraForm, amount: Number(e.target.value) })}
                    placeholder="0.00"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'তারিখ' : 'Transfer Date'}</label>
                  <input
                    type="date"
                    value={contraForm.entry_date}
                    onChange={(e) => setContraForm({ ...contraForm, entry_date: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'স্লিপ / চেক রেফ' : 'Deposit Slip / Cheque Ref'}</label>
                  <input
                    type="text"
                    value={contraForm.reference_no}
                    onChange={(e) => setContraForm({ ...contraForm, reference_no: e.target.value })}
                    placeholder={isBn ? 'ঐচ্ছিক রেফ নং' : 'Optional slip/UTR'}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">{t('common.notes')}</label>
                  <input
                    type="text"
                    value={contraForm.notes}
                    onChange={(e) => setContraForm({ ...contraForm, notes: e.target.value })}
                    placeholder={isBn ? 'ক্যাশ জমা বা ব্যাংক উত্তোলন নোট' : 'Deposit / ATM / Cheque note'}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={saving || effectiveContraFromId === effectiveContraToId}
                className="w-full py-2.5 px-4 rounded-lg bg-sky-700 hover:bg-sky-800 text-white text-xs font-semibold disabled:opacity-50"
              >
                {saving
                  ? t('party.posting')
                  : isBn
                  ? 'কন্ট্রা ট্রান্সফার পোস্ট করুন'
                  : 'Post Contra Transfer'}
              </button>
            </form>
          </div>

          {/* Expense & Contra Register */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold">
                {isBn ? 'খরচ ও কন্ট্রা ভাউচার রেজিস্টার' : 'Expense & Contra Voucher Register'} ({expenseAndContraEntries.length})
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={expContraFilter}
                  onChange={(e) => setExpContraFilter(e.target.value as 'ALL' | 'EXPENSE' | 'CONTRA')}
                  className="px-2.5 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="ALL">{isBn ? 'সব খরচ ও কন্ট্রা' : 'All Expense & Contra'}</option>
                  <option value="EXPENSE">{isBn ? 'শুধু পরিচালন খরচ' : 'Expenses Only'}</option>
                  <option value="CONTRA">{isBn ? 'শুধু কন্ট্রা ট্রান্সফার' : 'Contra Only'}</option>
                </select>
                <button
                  onClick={() =>
                    exportExcelWorkbook(
                      'SonaGrain-Expenses-Contra',
                      [
                        {
                          name: isBn ? 'খরচ ও কন্ট্রা' : 'Expenses & Contra',
                          rows: expenseAndContraEntries.map((je) => ({
                            VoucherNo: je.voucher_no,
                            Type: je.reference_type || '',
                            Date: je.entry_date,
                            Description: je.description,
                            Amount: je.lines.reduce((s, l) => s + Number(l.debit || 0), 0),
                          })),
                        },
                      ],
                      lang
                    )
                  }
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium whitespace-nowrap shrink-0"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" /> {t('common.excel')}
                </button>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <th className="text-left px-4 py-3 font-medium">{t('acc.voucherNo')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('acc.type')}</th>
                    <th className="text-left px-4 py-3 font-medium">{isBn ? 'বিবরণ ও লেজার এন্ট্রি' : 'Particulars & GL Impact'}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('party.amount')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('acc.print')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {expenseAndContraEntries.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                        {isBn
                          ? 'এখনো কোনো পরিচালন খরচ বা কন্ট্রা ট্রান্সফার এন্ট্রি নেই।'
                          : 'No operating expense or contra transfer vouchers posted yet.'}
                      </td>
                    </tr>
                  ) : (
                    expenseAndContraEntries.map((je) => {
                      const amt = je.lines.reduce((s, l) => s + Number(l.debit || 0), 0);
                      const isCtr = je.reference_type === 'CONTRA' || je.voucher_no.startsWith('CTR-');
                      return (
                        <tr key={je.id}>
                          <td className="px-4 py-3 font-mono font-medium">
                            <div>{je.voucher_no}</div>
                            <div className="text-[10px] text-slate-400">{je.entry_date}</div>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium ${
                                isCtr
                                  ? 'bg-sky-50 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400'
                                  : 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400'
                              }`}
                            >
                              {isCtr ? (isBn ? 'কন্ট্রা' : 'CONTRA') : isBn ? 'খরচ' : 'EXPENSE'}
                            </span>
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-900 dark:text-white">{je.description}</div>
                            <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                              {je.lines.map((l) => `${l.account_code} ${l.account_name} (${l.debit > 0 ? `Dr ৳${l.debit}` : `Cr ৳${l.credit}`})`).join(' · ')}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold">
                            ৳{amt.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              <button
                                onClick={() => exportJournalVoucherPdf(je, 'en')}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                              >
                                <Printer className="w-3 h-3" /> EN
                              </button>
                              <button
                                onClick={() => exportJournalVoucherPdf(je, 'bn')}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                              >
                                <Printer className="w-3 h-3" /> বাংলা
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
        </div>
      )}

      {/* TAB 3: Chart of Accounts, GL Account Ledger & Manual Double-Entry Journal */}
      {subTab === 'journal' && (
        <div className="space-y-5">
          {/* Action Toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => {
                  setShowNewAccountForm(!showNewAccountForm);
                  setShowJournalForm(false);
                }}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
              >
                <Landmark className="w-3.5 h-3.5" />
                <span>{showNewAccountForm ? t('common.closeForm') : isBn ? '+ নতুন GL অ্যাকাউন্ট' : '+ New GL Account'}</span>
              </button>
              <button
                onClick={() => {
                  if (!showJournalForm && accounts.length >= 2) {
                    setJvForm({
                      entry_date: todayIso,
                      description: '',
                      lines: [
                        { account_id: accounts[0].id, debit: 0, credit: 0 },
                        { account_id: accounts[1].id, debit: 0, credit: 0 },
                      ],
                    });
                  }
                  setShowJournalForm(!showJournalForm);
                  setShowNewAccountForm(false);
                }}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>{showJournalForm ? t('common.closeForm') : isBn ? '+ ম্যানুয়াল জার্নাল ভাউচার (JV)' : '+ Manual Journal Voucher (JV)'}</span>
              </button>
            </div>

            <button
              onClick={() =>
                exportExcelWorkbook(
                  'SonaGrain-ChartOfAccounts-Journal',
                  [
                    {
                      name: 'Chart of Accounts',
                      rows: accounts.map((a) => ({
                        Code: a.account_code,
                        Name: a.name,
                        Type: a.account_type,
                        Balance: a.balance,
                      })),
                    },
                    {
                      name: 'General Journal',
                      rows: journalEntries.flatMap((je) =>
                        je.lines.map((l) => ({
                          VoucherNo: je.voucher_no,
                          Date: je.entry_date,
                          RefType: je.reference_type || '',
                          Description: je.description,
                          AccountCode: l.account_code,
                          AccountName: l.account_name,
                          Debit: l.debit,
                          Credit: l.credit,
                        }))
                      ),
                    },
                  ],
                  lang
                )
              }
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" /> {t('common.excel')}
            </button>
          </div>

          {/* Create GL Account Form */}
          {showNewAccountForm && (
            <form
              onSubmit={handleCreateAccount}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
            >
              <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
                <h3 className="text-sm font-display font-semibold">
                  {isBn ? 'নতুন জেনারেল লেজার (GL) অ্যাকাউন্ট যোগ করুন' : 'Create New General Ledger Account'}
                </h3>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'অ্যাকাউন্ট কোড *' : 'Account Code *'}</label>
                  <input
                    type="text"
                    required
                    value={newAccountForm.account_code}
                    onChange={(e) => setNewAccountForm({ ...newAccountForm, account_code: e.target.value })}
                    placeholder=""
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div className="lg:col-span-2">
                  <label className="block text-xs font-medium mb-1">{t('acc.accountName')} *</label>
                  <input
                    type="text"
                    required
                    value={newAccountForm.name}
                    onChange={(e) => setNewAccountForm({ ...newAccountForm, name: e.target.value })}
                    placeholder={isBn ? 'অ্যাকাউন্টের নাম' : 'Account name'}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('acc.type')} *</label>
                  <select
                    value={newAccountForm.account_type}
                    onChange={(e) =>
                      setNewAccountForm({ ...newAccountForm, account_type: e.target.value as Account['account_type'] })
                    }
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="ASSET">ASSET (সম্পদ)</option>
                    <option value="LIABILITY">LIABILITY (দায়)</option>
                    <option value="EQUITY">EQUITY (মূলধন)</option>
                    <option value="REVENUE">REVENUE (আয়)</option>
                    <option value="EXPENSE">EXPENSE (খরচ)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'প্রারম্ভিক ব্যালেন্স (৳)' : 'Opening Balance (৳)'}</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={newAccountForm.opening_balance || ''}
                    onChange={(e) => setNewAccountForm({ ...newAccountForm, opening_balance: Number(e.target.value) })}
                    placeholder="0.00"
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowNewAccountForm(false)}
                  className="px-3.5 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-medium rounded-lg bg-slate-900 dark:bg-amber-600 text-white disabled:opacity-50"
                >
                  {saving ? t('common.saving') : isBn ? 'অ্যাকাউন্ট তৈরি করুন' : 'Create GL Account'}
                </button>
              </div>
            </form>
          )}

          {/* Manual Double-Entry Journal Voucher Builder */}
          {showJournalForm && (
            <form
              onSubmit={handlePostManualJournal}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-3">
                <h3 className="text-sm font-display font-semibold">
                  {isBn ? 'ম্যানুয়াল ডাবল-এন্ট্রি জার্নাল ভাউচার (JV)' : 'Manual Double-Entry Journal Voucher (JV)'}
                </h3>
                <div className="flex items-center gap-3 text-xs font-mono">
                  <span>Dr: ৳{jvTotals.debit.toLocaleString('en-IN')}</span>
                  <span>Cr: ৳{jvTotals.credit.toLocaleString('en-IN')}</span>
                  <span
                    className={`px-2 py-0.5 rounded font-semibold ${
                      jvTotals.balanced
                        ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400'
                        : 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-400'
                    }`}
                  >
                    {jvTotals.balanced
                      ? isBn
                        ? 'সুষম ✓'
                        : 'BALANCED ✓'
                      : `${isBn ? 'পার্থক্য' : 'Diff'}: ৳${jvTotals.diff}`}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5">
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'এন্ট্রি তারিখ' : 'Entry Date'}</label>
                  <input
                    type="date"
                    value={jvForm.entry_date}
                    onChange={(e) => setJvForm({ ...jvForm, entry_date: e.target.value })}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-xs font-medium mb-1">{isBn ? 'জার্নাল বিবরণ / নোট *' : 'Journal Narration / Description *'}</label>
                  <input
                    type="text"
                    required
                    value={jvForm.description}
                    onChange={(e) => setJvForm({ ...jvForm, description: e.target.value })}
                    placeholder={isBn ? 'বিবরণ লিখুন' : 'Description'}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="space-y-2">
                {jvForm.lines.map((line, idx) => (
                  <div key={idx} className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-6">
                      <select
                        value={line.account_id}
                        onChange={(e) => {
                          const next = [...jvForm.lines];
                          next[idx] = { ...next[idx], account_id: Number(e.target.value) };
                          setJvForm({ ...jvForm, lines: next });
                        }}
                        className="w-full px-2.5 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      >
                        <option value={0}>{isBn ? '-- অ্যাকাউন্ট নির্বাচন করুন --' : '-- Select GL Account --'}</option>
                        {accounts.map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.account_code} {a.name} ({a.account_type})
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="col-span-2">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.debit || ''}
                        placeholder="Debit ৳"
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          const next = [...jvForm.lines];
                          next[idx] = { ...next[idx], debit: val, credit: val > 0 ? 0 : next[idx].credit };
                          setJvForm({ ...jvForm, lines: next });
                        }}
                        className="w-full px-2.5 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div className="col-span-2">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.credit || ''}
                        placeholder="Credit ৳"
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          const next = [...jvForm.lines];
                          next[idx] = { ...next[idx], credit: val, debit: val > 0 ? 0 : next[idx].debit };
                          setJvForm({ ...jvForm, lines: next });
                        }}
                        className="w-full px-2.5 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div className="col-span-2 flex justify-end">
                      {jvForm.lines.length > 2 && (
                        <button
                          type="button"
                          onClick={() =>
                            setJvForm({
                              ...jvForm,
                              lines: jvForm.lines.filter((_, i) => i !== idx),
                            })
                          }
                          className="p-2 rounded-lg text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
                <button
                  type="button"
                  onClick={() =>
                    setJvForm({
                      ...jvForm,
                      lines: [...jvForm.lines, { account_id: accounts[0]?.id || 0, debit: 0, credit: 0 }],
                    })
                  }
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium"
                >
                  <Plus className="w-3.5 h-3.5" /> {isBn ? 'লাইনে যুক্ত করুন' : 'Add Line'}
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setShowJournalForm(false)}
                    className="px-3.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={saving || !jvTotals.balanced}
                    className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-semibold disabled:opacity-50"
                  >
                    {saving ? t('party.posting') : isBn ? 'জার্নাল পোস্ট করুন' : 'Post Journal Voucher'}
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Selected GL Account Ledger Drill-Down */}
          {selectedLedgerAccount && (
            <div className="bg-white dark:bg-slate-900 border-2 border-slate-900 dark:border-amber-600 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold">
                    {isBn ? 'অ্যাকাউন্ট লেজার' : 'GL Account Ledger'}: {selectedLedgerAccount.account_code}{' '}
                    {selectedLedgerAccount.name}
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono">
                    {selectedLedgerAccount.account_type} · {isBn ? 'বর্তমান ব্যালেন্স' : 'Closing Balance'}: ৳
                    {Number(selectedLedgerAccount.balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => exportAccountLedgerPdf(selectedLedgerAccount, ledgerEntries, 'en')}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <Printer className="w-3.5 h-3.5" /> EN PDF
                  </button>
                  <button
                    onClick={() => exportAccountLedgerPdf(selectedLedgerAccount, ledgerEntries, 'bn')}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <Printer className="w-3.5 h-3.5" /> বাংলা PDF
                  </button>
                  <button
                    onClick={() =>
                      exportExcelWorkbook(
                        `Ledger-${selectedLedgerAccount.account_code}`,
                        [
                          {
                            name: selectedLedgerAccount.account_code,
                            rows: ledgerEntries.map((r) => ({
                              Date: r.entry_date,
                              VoucherNo: r.voucher_no,
                              Type: r.reference_type || '',
                              Description: r.description,
                              Debit: r.debit,
                              Credit: r.credit,
                              RunningBalance: r.running_balance,
                            })),
                          },
                        ],
                        lang
                      )
                    }
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
                  </button>
                  <button
                    onClick={() => setSelectedLedgerAccount(null)}
                    className="p-1.5 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800"
                    title={t('common.close')}
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {loadingLedger ? (
                <div className="p-6 text-center text-xs text-slate-500">{t('party.loadingLedger')}</div>
              ) : (
                <div className="overflow-x-auto max-h-80">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                        <th className="text-left px-4 py-2 font-medium">{t('common.date')}</th>
                        <th className="text-left px-4 py-2 font-medium">{t('acc.voucherNo')}</th>
                        <th className="text-left px-4 py-2 font-medium">{t('party.particulars')}</th>
                        <th className="text-right px-4 py-2 font-medium">Debit (৳)</th>
                        <th className="text-right px-4 py-2 font-medium">Credit (৳)</th>
                        <th className="text-right px-4 py-2 font-medium">{t('party.balance')} (৳)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {ledgerEntries.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-6 text-center text-slate-500">
                            {isBn ? 'এই অ্যাকাউন্টে এখনো কোনো জার্নাল লেনদেন নেই।' : 'No journal postings yet for this GL account.'}
                          </td>
                        </tr>
                      ) : (
                        ledgerEntries.map((row) => (
                          <tr key={row.id}>
                            <td className="px-4 py-2 font-mono">{row.entry_date}</td>
                            <td className="px-4 py-2 font-mono font-medium">{row.voucher_no}</td>
                            <td className="px-4 py-2">{row.description}</td>
                            <td className="px-4 py-2 text-right font-mono tabular-nums">
                              {row.debit > 0 ? `৳${row.debit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}
                            </td>
                            <td className="px-4 py-2 text-right font-mono tabular-nums">
                              {row.credit > 0 ? `৳${row.credit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}
                            </td>
                            <td className="px-4 py-2 text-right font-mono tabular-nums font-semibold">
                              ৳{row.running_balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* Chart of Accounts & Journal Split */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Chart of Accounts */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold">
                  {t('acc.trialBalanceLive')} ({filteredAccounts.length})
                </span>
                <select
                  value={accountTypeFilter}
                  onChange={(e) => setAccountTypeFilter(e.target.value)}
                  className="px-2.5 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="ALL">{t('common.all')}</option>
                  <option value="ASSET">ASSET</option>
                  <option value="LIABILITY">LIABILITY</option>
                  <option value="EQUITY">EQUITY</option>
                  <option value="REVENUE">REVENUE</option>
                  <option value="EXPENSE">EXPENSE</option>
                </select>
              </div>
              <div className="overflow-x-auto max-h-[540px]">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                      <th className="text-left px-3 py-2.5 font-medium">{t('acc.accountCode')}</th>
                      <th className="text-left px-3 py-2.5 font-medium">{t('acc.accountName')}</th>
                      <th className="text-left px-3 py-2.5 font-medium">{t('acc.type')}</th>
                      <th className="text-right px-3 py-2.5 font-medium">{t('party.balance')} (৳)</th>
                      <th className="text-right px-3 py-2.5 font-medium">{t('common.actions')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {filteredAccounts.map((a) => (
                      <tr key={a.id}>
                        <td className="px-3 py-2.5 font-mono">{a.account_code}</td>
                        <td className="px-3 py-2.5 font-medium">
                          {editingAccountId === a.id ? (
                            <div className="flex items-center gap-1">
                              <input
                                type="text"
                                value={editingAccountName}
                                onChange={(e) => setEditingAccountName(e.target.value)}
                                className="px-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 w-full"
                              />
                              <button
                                onClick={() => handleRenameAccount(a.id)}
                                className="px-2 py-1 rounded bg-slate-900 dark:bg-amber-600 text-white text-[10px]"
                              >
                                {t('common.save')}
                              </button>
                              <button
                                onClick={() => setEditingAccountId(null)}
                                className="px-1.5 py-1 rounded border border-slate-200 text-[10px]"
                              >
                                ×
                              </button>
                            </div>
                          ) : (
                            <span>{a.name}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-slate-500">{a.account_type}</td>
                        <td className="px-3 py-2.5 text-right font-mono tabular-nums font-semibold">
                          ৳{a.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              onClick={() => openAccountLedger(a)}
                              className="px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap"
                            >
                              {isBn ? 'লেজার' : 'Ledger'}
                            </button>
                            <button
                              onClick={() => {
                                setEditingAccountId(a.id);
                                setEditingAccountName(a.name);
                              }}
                              className="p-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                              title={t('common.edit')}
                            >
                              <Edit3 className="w-3 h-3" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* General Journal Vouchers */}
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold">
                  {t('acc.journalTitle')} ({filteredJournalEntries.length})
                </span>
                <select
                  value={journalTypeFilter}
                  onChange={(e) => setJournalTypeFilter(e.target.value)}
                  className="px-2.5 py-1 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="ALL">{t('common.all')}</option>
                  <option value="EXPENSE">EXPENSE</option>
                  <option value="CONTRA">CONTRA</option>
                  <option value="MANUAL_JV">MANUAL_JV</option>
                  <option value="PURCHASE">PURCHASE</option>
                  <option value="SALE">SALE</option>
                  <option value="PAYMENT">PAYMENT</option>
                  <option value="PRODUCTION">PRODUCTION</option>
                  <option value="DRYING">DRYING</option>
                </select>
              </div>
              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[540px] overflow-y-auto">
                {filteredJournalEntries.length === 0 ? (
                  <div className="p-6 text-center text-xs text-slate-500">{t('acc.noJournal')}</div>
                ) : (
                  filteredJournalEntries.map((je) => (
                    <div key={je.id} className="p-4 space-y-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2 font-medium">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-slate-900 dark:text-white">{je.voucher_no}</span>
                          {je.reference_type && (
                            <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[10px] text-slate-600 dark:text-slate-300">
                              {je.reference_type}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-slate-500">{je.entry_date}</span>
                          <button
                            onClick={() => exportJournalVoucherPdf(je, 'en')}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[10px] font-medium whitespace-nowrap"
                          >
                            <Printer className="w-2.5 h-2.5" /> EN
                          </button>
                          <button
                            onClick={() => exportJournalVoucherPdf(je, 'bn')}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[10px] font-medium whitespace-nowrap"
                          >
                            <Printer className="w-2.5 h-2.5" /> বাংলা
                          </button>
                        </div>
                      </div>
                      <div className="text-slate-600 dark:text-slate-300">{je.description}</div>
                      <div className="space-y-1 pt-1">
                        {je.lines.map((l, idx) => (
                          <div key={idx} className="flex justify-between font-mono text-[11px] text-slate-500">
                            <span>
                              {l.account_code} {l.account_name}
                            </span>
                            <span>{l.debit > 0 ? `Dr ৳${l.debit.toLocaleString('en-IN')}` : `Cr ৳${l.credit.toLocaleString('en-IN')}`}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: Live Financial Statements (Trial Balance, Profit & Loss, Balance Sheet) */}
      {subTab === 'statements' && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-display font-semibold">
                {isBn ? 'সম্পূর্ণ আর্থিক বিবরণী (ট্রায়াল ব্যালেন্স, লাভ-ক্ষতি ও ব্যালেন্স শিট)' : 'Financial Statements (Trial Balance, Profit & Loss & Balance Sheet)'}
              </h3>
              <p className="text-xs text-slate-500">
                {isBn ? 'ডাবল-এন্ট্রি জেনারেল লেজার থেকে সরাসরি লাইভ হিসাব' : 'Computed live from double-entry general ledger balances'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => loadStatements()}
                disabled={loadingStatements}
                className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loadingStatements ? 'animate-spin' : ''}`} />
                <span>{isBn ? 'রিফ্রেশ' : 'Refresh'}</span>
              </button>
              {statements && (
                <>
                  <button
                    onClick={() => exportFinancialStatementsPdf(statements, 'en')}
                    className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <FileText className="w-3.5 h-3.5" /> {t('rep.pdfEn')}
                  </button>
                  <button
                    onClick={() => exportFinancialStatementsPdf(statements, 'bn')}
                    className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <FileText className="w-3.5 h-3.5" /> {t('rep.pdfBn')}
                  </button>
                  <button
                    onClick={() =>
                      exportExcelWorkbook(
                        'SonaGrain-Financial-Statements',
                        [
                          {
                            name: 'Trial Balance',
                            rows: statements.trial_balance.rows.map((r) => ({
                              Code: r.account_code,
                              Account: r.name,
                              Type: r.account_type,
                              Debit: r.debit_balance,
                              Credit: r.credit_balance,
                            })),
                          },
                          {
                            name: 'Profit & Loss',
                            rows: [
                              ...statements.profit_and_loss.revenues.map((a) => ({
                                Section: 'Revenue',
                                Code: a.account_code,
                                Account: a.name,
                                Amount: a.balance,
                              })),
                              ...statements.profit_and_loss.cogs.map((a) => ({
                                Section: 'COGS',
                                Code: a.account_code,
                                Account: a.name,
                                Amount: -a.balance,
                              })),
                              {
                                Section: 'Summary',
                                Code: '',
                                Account: 'Gross Profit',
                                Amount: statements.profit_and_loss.gross_profit,
                              },
                              ...statements.profit_and_loss.expenses.map((a) => ({
                                Section: 'Operating Expense',
                                Code: a.account_code,
                                Account: a.name,
                                Amount: -a.balance,
                              })),
                              {
                                Section: 'Summary',
                                Code: '',
                                Account: 'Net Profit / (Loss)',
                                Amount: statements.profit_and_loss.net_profit,
                              },
                            ],
                          },
                          {
                            name: 'Balance Sheet',
                            rows: [
                              ...statements.balance_sheet.assets.map((a) => ({
                                Section: 'Asset',
                                Code: a.account_code,
                                Account: a.name,
                                Amount: a.balance,
                              })),
                              ...statements.balance_sheet.liabilities.map((a) => ({
                                Section: 'Liability',
                                Code: a.account_code,
                                Account: a.name,
                                Amount: a.balance,
                              })),
                              ...statements.balance_sheet.equity.map((a) => ({
                                Section: 'Equity',
                                Code: a.account_code,
                                Account: a.name,
                                Amount: a.balance,
                              })),
                              {
                                Section: 'Equity',
                                Code: 'P&L',
                                Account: 'Current Net Profit / (Loss)',
                                Amount: statements.balance_sheet.current_net_profit,
                              },
                            ],
                          },
                        ],
                        lang
                      )
                    }
                    className="flex items-center gap-1 px-2.5 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" /> {t('common.excel')}
                  </button>
                </>
              )}
            </div>
          </div>

          {loadingStatements && !statements ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-xs text-slate-500">
              {isBn ? 'আর্থিক বিবরণী হিসাব করা হচ্ছে...' : 'Computing live Trial Balance, P&L and Balance Sheet...'}
            </div>
          ) : statements ? (
            <>
              {/* Summary Strip */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                  <div className="text-xs text-slate-500">{isBn ? 'মোট বিক্রয় ও আয়' : 'Total Sales Revenue'}</div>
                  <div className="text-lg font-display font-bold font-mono tabular-nums mt-1 text-emerald-700 dark:text-emerald-400">
                    ৳{statements.profit_and_loss.total_revenue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                  <div className="text-xs text-slate-500">{isBn ? 'মোট মুনাফা (Gross Profit)' : 'Gross Profit (After COGS)'}</div>
                  <div className="text-lg font-display font-bold font-mono tabular-nums mt-1">
                    ৳{statements.profit_and_loss.gross_profit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                  <div className="text-xs text-slate-500">{isBn ? 'নিট লাভ / (ক্ষতি)' : 'Net Profit / (Loss)'}</div>
                  <div
                    className={`text-lg font-display font-bold font-mono tabular-nums mt-1 ${
                      statements.profit_and_loss.net_profit >= 0
                        ? 'text-emerald-700 dark:text-emerald-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    ৳{statements.profit_and_loss.net_profit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                  <div className="text-xs text-slate-500">{isBn ? 'মোট সম্পদ ও ব্যালেন্স যাচাই' : 'Total Assets & Audit Check'}</div>
                  <div className="text-lg font-display font-bold font-mono tabular-nums mt-1">
                    ৳{statements.balance_sheet.total_assets.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                  </div>
                  <div className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400 flex items-center gap-1 mt-0.5">
                    <CheckCircle2 className="w-3 h-3" />
                    <span>
                      {statements.trial_balance.is_balanced && statements.balance_sheet.is_balanced
                        ? isBn
                          ? 'ট্রায়াল ব্যালেন্স ও ব্যালেন্স শিট সুষম'
                          : 'Trial Balance & Balance Sheet Balanced'
                        : isBn
                        ? 'পার্থক্য পাওয়া গেছে'
                        : 'Variance Detected'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Profit & Loss and Balance Sheet Side-by-Side */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                {/* Profit & Loss Statement */}
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 font-semibold text-xs">
                    {isBn ? 'লাভ-ক্ষতি বিবরণী (Profit & Loss Statement)' : 'Income Statement (Profit & Loss)'}
                  </div>
                  <div className="p-4 space-y-3 text-xs">
                    <div>
                      <div className="font-semibold text-slate-500 uppercase text-[11px] mb-1.5">
                        {isBn ? 'আয়সমূহ (Revenue)' : 'Revenue'}
                      </div>
                      {statements.profit_and_loss.revenues.map((a) => (
                        <div key={a.id} className="flex justify-between py-1">
                          <span>
                            {a.account_code} {a.name}
                          </span>
                          <span className="font-mono tabular-nums">৳{a.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      ))}
                      <div className="flex justify-between py-1.5 border-t border-slate-100 dark:border-slate-800 font-semibold">
                        <span>{isBn ? 'মোট বিক্রয় ও আয়' : 'Total Revenue'}</span>
                        <span className="font-mono tabular-nums">
                          ৳{statements.profit_and_loss.total_revenue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                    </div>

                    <div>
                      <div className="font-semibold text-slate-500 uppercase text-[11px] mb-1.5">
                        {isBn ? 'বাদ: বিক্রীত পণ্যের খরচ (COGS)' : 'Less: Cost of Goods Sold (COGS)'}
                      </div>
                      {statements.profit_and_loss.cogs.map((a) => (
                        <div key={a.id} className="flex justify-between py-1 text-slate-600 dark:text-slate-300">
                          <span>
                            {a.account_code} {a.name}
                          </span>
                          <span className="font-mono tabular-nums">-৳{a.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      ))}
                      <div className="flex justify-between py-1.5 border-t border-slate-100 dark:border-slate-800 font-semibold bg-slate-50 dark:bg-slate-950 px-2 rounded">
                        <span>{isBn ? 'মোট মুনাফা (Gross Profit)' : 'Gross Profit'}</span>
                        <span className="font-mono tabular-nums">
                          ৳{statements.profit_and_loss.gross_profit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                    </div>

                    <div>
                      <div className="font-semibold text-slate-500 uppercase text-[11px] mb-1.5">
                        {isBn ? 'বাদ: পরিচালন খরচ (Operating Expenses)' : 'Less: Operating Expenses'}
                      </div>
                      {statements.profit_and_loss.expenses.map((a) => (
                        <div key={a.id} className="flex justify-between py-1 text-slate-600 dark:text-slate-300">
                          <span>
                            {a.account_code} {a.name}
                          </span>
                          <span className="font-mono tabular-nums">-৳{a.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      ))}
                      <div className="flex justify-between py-2 mt-2 border-t-2 border-slate-900 dark:border-amber-600 font-bold text-sm">
                        <span>{isBn ? 'নিট লাভ / (ক্ষতি)' : 'Net Profit / (Loss)'}</span>
                        <span
                          className={`font-mono tabular-nums ${
                            statements.profit_and_loss.net_profit >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'
                          }`}
                        >
                          ৳{statements.profit_and_loss.net_profit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Balance Sheet */}
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 flex items-center justify-between">
                    <span className="font-semibold text-xs">{isBn ? 'ব্যালেন্স শিট (Balance Sheet)' : 'Balance Sheet'}</span>
                    <span className="text-[11px] font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                      {statements.balance_sheet.is_balanced ? (isBn ? 'সুষম ✓' : 'Assets = L + E ✓') : 'Variance'}
                    </span>
                  </div>
                  <div className="p-4 space-y-3 text-xs">
                    <div>
                      <div className="font-semibold text-slate-500 uppercase text-[11px] mb-1.5">
                        {isBn ? 'সম্পদসমূহ (Assets)' : 'Assets'}
                      </div>
                      {statements.balance_sheet.assets.map((a) => (
                        <div key={a.id} className="flex justify-between py-1">
                          <span>
                            {a.account_code} {a.name}
                          </span>
                          <span className="font-mono tabular-nums">৳{a.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      ))}
                      <div className="flex justify-between py-1.5 border-t border-slate-200 dark:border-slate-700 font-bold bg-slate-50 dark:bg-slate-950 px-2 rounded">
                        <span>{isBn ? 'মোট সম্পদ (Total Assets)' : 'Total Assets'}</span>
                        <span className="font-mono tabular-nums">
                          ৳{statements.balance_sheet.total_assets.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                    </div>

                    <div>
                      <div className="font-semibold text-slate-500 uppercase text-[11px] mb-1.5">
                        {isBn ? 'দায় ও মালিকানা মূলধন (Liabilities & Equity)' : 'Liabilities & Owner Equity'}
                      </div>
                      {statements.balance_sheet.liabilities.map((a) => (
                        <div key={a.id} className="flex justify-between py-1">
                          <span>
                            {a.account_code} {a.name}
                          </span>
                          <span className="font-mono tabular-nums">৳{a.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      ))}
                      {statements.balance_sheet.equity.map((a) => (
                        <div key={a.id} className="flex justify-between py-1">
                          <span>
                            {a.account_code} {a.name}
                          </span>
                          <span className="font-mono tabular-nums">৳{a.balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                        </div>
                      ))}
                      <div className="flex justify-between py-1 text-slate-600 dark:text-slate-300">
                        <span>{isBn ? 'চলতি সময়কালের নিট লাভ / (ক্ষতি)' : 'Current Period Net Profit / (Loss)'}</span>
                        <span className="font-mono tabular-nums">
                          ৳{statements.balance_sheet.current_net_profit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                      <div className="flex justify-between py-2 mt-2 border-t-2 border-slate-900 dark:border-amber-600 font-bold text-sm">
                        <span>{isBn ? 'মোট দায় ও মালিকানা মূলধন' : 'Total Liabilities & Equity'}</span>
                        <span className="font-mono tabular-nums">
                          ৳{statements.balance_sheet.total_liabilities_and_equity.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Full Trial Balance Table */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <span className="text-xs font-semibold">{isBn ? 'সম্পূর্ণ ট্রায়াল ব্যালেন্স (Trial Balance)' : 'Trial Balance'}</span>
                  <span
                    className={`text-xs font-mono font-semibold ${
                      statements.trial_balance.is_balanced ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600'
                    }`}
                  >
                    {statements.trial_balance.is_balanced
                      ? isBn
                        ? 'ডেবিট = ক্রেডিট (সুষম ✓)'
                        : 'Total Debit = Total Credit (BALANCED ✓)'
                      : 'UNBALANCED'}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                        <th className="text-left px-4 py-2.5 font-medium">{t('acc.accountCode')}</th>
                        <th className="text-left px-4 py-2.5 font-medium">{t('acc.accountName')}</th>
                        <th className="text-left px-4 py-2.5 font-medium">{t('acc.type')}</th>
                        <th className="text-right px-4 py-2.5 font-medium">{isBn ? 'ডেবিট ব্যালেন্স (৳)' : 'Debit Balance (৳)'}</th>
                        <th className="text-right px-4 py-2.5 font-medium">{isBn ? 'ক্রেডিট ব্যালেন্স (৳)' : 'Credit Balance (৳)'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {statements.trial_balance.rows.map((r) => (
                        <tr key={r.id}>
                          <td className="px-4 py-2.5 font-mono">{r.account_code}</td>
                          <td className="px-4 py-2.5 font-medium">{r.name}</td>
                          <td className="px-4 py-2.5 text-slate-500">{r.account_type}</td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                            {r.debit_balance > 0 ? `৳${r.debit_balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                            {r.credit_balance > 0 ? `৳${r.credit_balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'}
                          </td>
                        </tr>
                      ))}
                      <tr className="bg-slate-50 dark:bg-slate-950 font-bold">
                        <td colSpan={3} className="px-4 py-3 text-right">
                          {isBn ? 'সর্বমোট ট্রায়াল ব্যালেন্স' : 'TOTAL TRIAL BALANCE'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          ৳{statements.trial_balance.total_debit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          ৳{statements.trial_balance.total_credit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : null}
        </div>
      )}

      {/* TAB 5: All Parties Due & Advance Summary */}
      {subTab === 'parties' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <select
              value={partyFilter}
              onChange={(e) => setPartyFilter(e.target.value as 'ALL' | 'CUSTOMER' | 'SUPPLIER' | 'BOTH')}
              className="px-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900"
            >
              <option value="ALL">
                {t('common.all')} ({parties.length})
              </option>
              <option value="CUSTOMER">{t('party.customers')}</option>
              <option value="SUPPLIER">{t('party.suppliers')}</option>
              <option value="BOTH">{t('party.roleBoth')}</option>
            </select>
            <div className="flex flex-wrap gap-1.5">
              <button
                onClick={() => exportPartiesSummaryPdf('en')}
                className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
              >
                <FileText className="w-3.5 h-3.5" /> {t('rep.pdfEn')}
              </button>
              <button
                onClick={() => exportPartiesSummaryPdf('bn')}
                className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
              >
                <FileText className="w-3.5 h-3.5" /> {t('rep.pdfBn')}
              </button>
              <button
                onClick={() =>
                  exportExcelWorkbook(
                    'SonaGrain-Parties-Due-Advance',
                    [
                      {
                        name: isBn ? 'পার্টি বকেয়া ও অগ্রিম' : 'Party Due & Advance',
                        rows: filteredParties.map((p) => ({
                          Code: p.party_code,
                          Name: p.name,
                          Type: p.party_type,
                          Phone: p.phone || '',
                          TotalPurchased: Number(p.total_purchased || 0),
                          TotalSold: Number(p.total_sold || 0),
                          TotalPaidOut: Number(p.total_paid_out || 0),
                          TotalReceivedIn: Number(p.total_received_in || 0),
                          CurrentSignedBalance: p.current_balance,
                          Status: p.is_active ? 'ACTIVE' : 'INACTIVE',
                        })),
                      },
                    ],
                    lang
                  )
                }
                className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" /> {t('common.excel')}
              </button>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <th className="text-left px-4 py-3 font-medium">{t('party.code')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('party.details')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('acc.type')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('party.totalPurchased')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('party.totalSales')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('party.dueBalance')} / {t('party.advance')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredParties.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                        {t('party.noLedgerEntries')}
                      </td>
                    </tr>
                  ) : (
                    filteredParties.map((p) => {
                      const isCust = p.party_type === 'CUSTOMER';
                      const isSupp = p.party_type === 'SUPPLIER';
                      let balText = t('party.settled');
                      let balClass = 'text-slate-500';
                      if (p.current_balance < 0) {
                        balText = isCust
                          ? `${isBn ? 'কাস্টমার অগ্রিম' : 'Customer Advance'} ৳${Math.abs(p.current_balance).toLocaleString('en-IN')}`
                          : `${isBn ? 'সাপ্লায়ার বকেয়া' : 'Supplier Due'} ৳${Math.abs(p.current_balance).toLocaleString('en-IN')}`;
                        balClass = isCust ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400';
                      } else if (p.current_balance > 0) {
                        balText = isSupp
                          ? `${isBn ? 'সাপ্লায়ার অগ্রিম' : 'Supplier Advance'} ৳${p.current_balance.toLocaleString('en-IN')}`
                          : `${isBn ? 'কাস্টমার বকেয়া' : 'Customer Due'} ৳${p.current_balance.toLocaleString('en-IN')}`;
                        balClass = isSupp ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400';
                      }
                      return (
                        <tr key={p.id}>
                          <td className="px-4 py-3 font-mono font-medium">{p.party_code}</td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-900 dark:text-white">{p.name}</div>
                            <div className="text-slate-500">{p.phone || '-'}</div>
                          </td>
                          <td className="px-4 py-3">{p.party_type}</td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            ৳{Number(p.total_purchased || 0).toLocaleString('en-IN')}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            ৳{Number(p.total_sold || 0).toLocaleString('en-IN')}
                          </td>
                          <td className={`px-4 py-3 text-right font-mono tabular-nums font-semibold ${balClass}`}>{balText}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
