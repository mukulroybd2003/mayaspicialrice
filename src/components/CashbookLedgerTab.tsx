import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownLeft,
  ArrowUpRight,
  BookOpen,
  FileSpreadsheet,
  FileText,
  Landmark,
  Printer,
  RefreshCw,
  Search,
  Users,
  Wallet,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import type { AppLang } from '../i18n/translations';
import { apiGet } from '../services/api';
import type {
  Account,
  AccountLedgerResponse,
  CashbookReport,
  JournalEntry,
  Party,
  PartyLedgerResponse,
} from '../types/erp';
import {
  exportAccountLedgerPdf,
  exportCashbookPdf,
  exportExcelWorkbook,
  exportPartyStatementPdf,
} from '../utils/reports';

interface CashbookLedgerTabProps {
  accounts: Account[];
  cashBankAccounts: Account[];
  parties: Party[];
  journalEntries: JournalEntry[];
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

type BookView = 'cashbook' | 'gl' | 'party';

const fmtMoney = (val: number) =>
  `৳${Number(val || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const CashbookLedgerTab: React.FC<CashbookLedgerTabProps> = ({
  accounts,
  cashBankAccounts,
  parties,
  journalEntries,
  onNotify,
}) => {
  const { t, lang } = useI18n();
  const isBn = lang === 'bn';
  const todayIso = new Date().toISOString().slice(0, 10);
  const monthStartIso = `${todayIso.slice(0, 7)}-01`;

  const [bookView, setBookView] = useState<BookView>('cashbook');

  // --- 1. Cashbook State ---
  const [cbAccountId, setCbAccountId] = useState<string>('ALL');
  const [cbFrom, setCbFrom] = useState<string>(monthStartIso);
  const [cbTo, setCbTo] = useState<string>(todayIso);
  const [cbSearch, setCbSearch] = useState<string>('');
  const [cbReport, setCbReport] = useState<CashbookReport | null>(null);
  const [cbLoading, setCbLoading] = useState<boolean>(false);

  // --- 2. General Ledger State ---
  const [glAccountId, setGlAccountId] = useState<number>(() => accounts[0]?.id || 0);
  const [glFrom, setGlFrom] = useState<string>('');
  const [glTo, setGlTo] = useState<string>('');
  const [glSearch, setGlSearch] = useState<string>('');
  const [glData, setGlData] = useState<AccountLedgerResponse | null>(null);
  const [glLoading, setGlLoading] = useState<boolean>(false);

  // --- 3. Party Ledger State ---
  const [partyRoleFilter, setPartyRoleFilter] = useState<'ALL' | 'CUSTOMER' | 'SUPPLIER' | 'BOTH'>('ALL');
  const [selectedPartyId, setSelectedPartyId] = useState<number>(() => parties[0]?.id || 0);
  const [plFrom, setPlFrom] = useState<string>('');
  const [plTo, setPlTo] = useState<string>('');
  const [plSearch, setPlSearch] = useState<string>('');
  const [plData, setPlData] = useState<PartyLedgerResponse | null>(null);
  const [plLoading, setPlLoading] = useState<boolean>(false);

  const effectiveGlAccountId = useMemo(() => {
    if (accounts.some((a) => a.id === glAccountId)) return glAccountId;
    return accounts[0]?.id || 0;
  }, [accounts, glAccountId]);

  const filteredPartyOptions = useMemo(() => {
    if (partyRoleFilter === 'ALL') return parties;
    return parties.filter((p) => p.party_type === partyRoleFilter);
  }, [parties, partyRoleFilter]);

  const effectivePartyId = useMemo(() => {
    if (filteredPartyOptions.some((p) => p.id === selectedPartyId)) return selectedPartyId;
    return filteredPartyOptions[0]?.id || 0;
  }, [filteredPartyOptions, selectedPartyId]);

  // --- Fetch Cashbook ---
  const loadCashbook = useCallback(async () => {
    setCbLoading(true);
    try {
      const params = new URLSearchParams();
      if (cbAccountId && cbAccountId !== 'ALL') params.set('account_id', cbAccountId);
      if (cbFrom) params.set('from', cbFrom);
      if (cbTo) params.set('to', cbTo);
      const qs = params.toString();
      const data = await apiGet<CashbookReport>(
        `/api/v1/accounting/cashbook${qs ? `?${qs}` : ''}`,
        `cache_cashbook_${cbAccountId}_${cbFrom}_${cbTo}`
      );
      setCbReport(data);
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setCbLoading(false);
    }
  }, [cbAccountId, cbFrom, cbTo, onNotify]);

  useEffect(() => {
    if (bookView === 'cashbook') {
      void loadCashbook();
    }
  }, [bookView, loadCashbook, accounts, journalEntries]);

  // --- Fetch GL Ledger ---
  const loadGlLedger = useCallback(async () => {
    if (!effectiveGlAccountId) {
      setGlData(null);
      return;
    }
    setGlLoading(true);
    try {
      const params = new URLSearchParams();
      if (glFrom) params.set('from', glFrom);
      if (glTo) params.set('to', glTo);
      const qs = params.toString();
      const data = await apiGet<AccountLedgerResponse>(
        `/api/v1/accounts/${effectiveGlAccountId}/ledger${qs ? `?${qs}` : ''}`,
        `cache_gl_${effectiveGlAccountId}_${glFrom}_${glTo}`
      );
      setGlData(data);
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setGlLoading(false);
    }
  }, [effectiveGlAccountId, glFrom, glTo, onNotify]);

  useEffect(() => {
    if (bookView === 'gl') {
      void loadGlLedger();
    }
  }, [bookView, loadGlLedger, accounts, journalEntries]);

  // --- Fetch Party Ledger ---
  const loadPartyLedger = useCallback(async () => {
    if (!effectivePartyId) {
      setPlData(null);
      return;
    }
    setPlLoading(true);
    try {
      const data = await apiGet<PartyLedgerResponse>(
        `/api/v1/parties/${effectivePartyId}/ledger`,
        `cache_party_ledger_${effectivePartyId}`
      );
      setPlData(data);
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setPlLoading(false);
    }
  }, [effectivePartyId, onNotify]);

  useEffect(() => {
    if (bookView === 'party') {
      void loadPartyLedger();
    }
  }, [bookView, loadPartyLedger, parties, journalEntries]);

  // --- Derived Cashbook Filtered Entries ---
  const filteredCbEntries = useMemo(() => {
    if (!cbReport) return [];
    const q = cbSearch.trim().toLowerCase();
    if (!q) return cbReport.entries;
    return cbReport.entries.filter(
      (e) =>
        e.voucher_no.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.contra_head || '').toLowerCase().includes(q) ||
        e.account_name.toLowerCase().includes(q) ||
        e.account_code.toLowerCase().includes(q)
    );
  }, [cbReport, cbSearch]);

  // --- Derived GL Filtered Entries ---
  const filteredGlEntries = useMemo(() => {
    if (!glData) return [];
    const q = glSearch.trim().toLowerCase();
    if (!q) return glData.entries;
    return glData.entries.filter(
      (e) =>
        e.voucher_no.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q) ||
        (e.contra_head || '').toLowerCase().includes(q)
    );
  }, [glData, glSearch]);

  // --- Derived Party Ledger Date/Search Slice ---
  const partySliced = useMemo(() => {
    if (!plData) {
      return {
        opening: 0,
        totalDebit: 0,
        totalCredit: 0,
        closing: 0,
        entries: [] as PartyLedgerResponse['entries'],
      };
    }
    const allRows = plData.entries || [];
    let opening = 0;
    const periodRows: PartyLedgerResponse['entries'] = [];

    for (const row of allRows) {
      if (row.entry_type === 'OPENING') {
        opening = row.running_balance;
        if (!plFrom) {
          periodRows.push(row);
        }
        continue;
      }
      const d = row.date.slice(0, 10);
      if (plFrom && d < plFrom) {
        opening = row.running_balance;
        continue;
      }
      if (plTo && d > plTo) {
        continue;
      }
      periodRows.push(row);
    }

    const q = plSearch.trim().toLowerCase();
    const visible = q
      ? periodRows.filter(
          (r) => r.ref_no.toLowerCase().includes(q) || r.description.toLowerCase().includes(q)
        )
      : periodRows;

    const nonOpening = visible.filter((r) => r.entry_type !== 'OPENING');
    const totalDebit = nonOpening.reduce((s, r) => s + Number(r.debit_receivable || 0), 0);
    const totalCredit = nonOpening.reduce((s, r) => s + Number(r.credit_payable || 0), 0);
    const lastRow = periodRows[periodRows.length - 1];
    const closing = lastRow ? lastRow.running_balance : opening;

    return {
      opening: Number(opening.toFixed(2)),
      totalDebit: Number(totalDebit.toFixed(2)),
      totalCredit: Number(totalCredit.toFixed(2)),
      closing: Number(closing.toFixed(2)),
      entries: visible,
    };
  }, [plData, plFrom, plTo, plSearch]);

  const exportCashbookExcel = (exportLang: AppLang) => {
    if (!cbReport) return;
    const bn = exportLang === 'bn';
    const selectedAcc =
      cbReport.account_id === 'ALL'
        ? null
        : cbReport.accounts.find((a) => a.id === cbReport.account_id) || null;
    exportExcelWorkbook(
      selectedAcc ? `Cashbook-${selectedAcc.account_code}` : 'Cashbook-Report',
      [
        {
          name: bn ? 'ক্যাশবুক' : 'Cashbook',
          rows: [
            bn
              ? {
                  তারিখ: cbReport.from || '-',
                  ভাউচার_নং: 'OPEN-BAL',
                  অ্যাকাউন্ট: selectedAcc ? `${selectedAcc.account_code} ${selectedAcc.name}` : 'সকল ক্যাশ ও ব্যাংক',
                  বিবরণ: 'প্রারম্ভিক জের (Opening Balance)',
                  বিপরীত_খাত: '',
                  জমা_প্রাপ্তি: 0,
                  খরচ_প্রদান: 0,
                  জের: cbReport.opening_balance,
                }
              : {
                  Date: cbReport.from || '-',
                  VoucherNo: 'OPEN-BAL',
                  Account: selectedAcc ? `${selectedAcc.account_code} ${selectedAcc.name}` : 'All Cash & Bank',
                  Particulars: 'Opening Balance B/F',
                  ContraHead: '',
                  Receipt: 0,
                  Payment: 0,
                  Balance: cbReport.opening_balance,
                },
            ...filteredCbEntries.map((e) =>
              bn
                ? {
                    তারিখ: e.entry_date,
                    ভাউচার_নং: e.voucher_no,
                    অ্যাকাউন্ট: `${e.account_code} ${e.account_name}`,
                    বিবরণ: e.description,
                    বিপরীত_খাত: e.contra_head || '',
                    জমা_প্রাপ্তি: e.receipt,
                    খরচ_প্রদান: e.payment,
                    জের: e.running_balance,
                  }
                : {
                    Date: e.entry_date,
                    VoucherNo: e.voucher_no,
                    Account: `${e.account_code} ${e.account_name}`,
                    Particulars: e.description,
                    ContraHead: e.contra_head || '',
                    Receipt: e.receipt,
                    Payment: e.payment,
                    Balance: e.running_balance,
                  }
            ),
          ],
        },
      ],
      exportLang
    );
  };

  const applyQuickRange = (
    setterFrom: React.Dispatch<React.SetStateAction<string>>,
    setterTo: React.Dispatch<React.SetStateAction<string>>,
    preset: 'today' | 'month' | 'all'
  ) => {
    if (preset === 'today') {
      setterFrom(todayIso);
      setterTo(todayIso);
    } else if (preset === 'month') {
      setterFrom(monthStartIso);
      setterTo(todayIso);
    } else {
      setterFrom('');
      setterTo('');
    }
  };

  const formatPartyBalanceStatus = (party: Party | undefined, bal: number) => {
    if (!party || Math.abs(bal) < 0.01) {
      return { text: t('party.settled'), cls: 'text-slate-500' };
    }
    const isCust = party.party_type === 'CUSTOMER';
    const isSupp = party.party_type === 'SUPPLIER';
    if (bal < 0) {
      return {
        text: isCust
          ? `${isBn ? 'কাস্টমার অগ্রিম' : 'Customer Advance'} ${fmtMoney(Math.abs(bal))}`
          : `${isBn ? 'সাপ্লায়ার বকেয়া' : 'Supplier Due'} ${fmtMoney(Math.abs(bal))}`,
        cls: isCust ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
      };
    }
    return {
      text: isSupp
        ? `${isBn ? 'সাপ্লায়ার অগ্রিম' : 'Supplier Advance'} ${fmtMoney(bal)}`
        : `${isBn ? 'কাস্টমার বকেয়া' : 'Customer Due'} ${fmtMoney(bal)}`,
      cls: isSupp ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400',
    };
  };

  return (
    <div className="space-y-4">
      {/* Mode Switcher Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
          <button
            onClick={() => setBookView('cashbook')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
              bookView === 'cashbook'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Wallet className="w-3.5 h-3.5" />
            <span>{isBn ? 'ক্যাশবুক রিপোর্ট' : 'Cashbook Report'}</span>
          </button>
          <button
            onClick={() => setBookView('gl')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
              bookView === 'gl'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>{isBn ? 'জেনারেল লেজার (GL)' : 'General Ledger (GL)'}</span>
          </button>
          <button
            onClick={() => setBookView('party')}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap shrink-0 ${
              bookView === 'party'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Users className="w-3.5 h-3.5" />
            <span>{isBn ? 'পার্টি লেজার' : 'Party Ledger'}</span>
          </button>
        </div>
      </div>

      {/* ================================================================ */}
      {/* 1. CASHBOOK REPORT                                                */}
      {/* ================================================================ */}
      {bookView === 'cashbook' && (
        <div className="space-y-4">
          {/* Filters & Export Bar */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isBn ? 'নগদ / ব্যাংক অ্যাকাউন্ট' : 'Cash / Bank Account'}
                </label>
                <select
                  value={cbAccountId}
                  onChange={(e) => setCbAccountId(e.target.value)}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="ALL">
                    {isBn ? 'সকল ক্যাশ ও ব্যাংক অ্যাকাউন্ট' : 'All Cash & Bank Accounts'}
                  </option>
                  {(cbReport?.accounts || cashBankAccounts).map((a) => (
                    <option key={a.id} value={String(a.id)}>
                      {a.account_code} {a.name} ({fmtMoney(a.balance)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isBn ? 'শুরুর তারিখ' : 'From Date'}
                </label>
                <input
                  type="date"
                  value={cbFrom}
                  onChange={(e) => setCbFrom(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isBn ? 'শেষ তারিখ' : 'To Date'}
                </label>
                <input
                  type="date"
                  value={cbTo}
                  onChange={(e) => setCbTo(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isBn ? 'খুঁজুন (ভাউচার / বিবরণ)' : 'Search (Voucher / Particulars)'}
                </label>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                  <input
                    type="text"
                    value={cbSearch}
                    onChange={(e) => setCbSearch(e.target.value)}
                    placeholder={isBn ? 'ভাউচার বা বিবরণ...' : 'Voucher, contra, note...'}
                    className="w-full pl-8 pr-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>
              <div className="flex flex-col justify-end">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => applyQuickRange(setCbFrom, setCbTo, 'today')}
                    className="px-2.5 py-2 text-[11px] font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    {isBn ? 'আজ' : 'Today'}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyQuickRange(setCbFrom, setCbTo, 'month')}
                    className="px-2.5 py-2 text-[11px] font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    {isBn ? 'এই মাস' : 'Month'}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyQuickRange(setCbFrom, setCbTo, 'all')}
                    className="px-2.5 py-2 text-[11px] font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    {isBn ? 'সব' : 'All'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void loadCashbook()}
                    className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                    title={t('common.refresh')}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${cbLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <div className="text-xs text-slate-500 font-mono">
                {cbReport && (
                  <>
                    {isBn ? 'নগদ স্থিতি' : 'Cash'}:{' '}
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {fmtMoney(cbReport.cash_closing)}
                    </span>{' '}
                    · {isBn ? 'ব্যাংক স্থিতি' : 'Bank'}:{' '}
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {fmtMoney(cbReport.bank_closing)}
                    </span>
                  </>
                )}
              </div>
              {cbReport && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() => exportCashbookPdf({ ...cbReport, entries: filteredCbEntries }, 'en')}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <Printer className="w-3.5 h-3.5" /> {t('rep.pdfEn')}
                  </button>
                  <button
                    onClick={() => exportCashbookPdf({ ...cbReport, entries: filteredCbEntries }, 'bn')}
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <Printer className="w-3.5 h-3.5" /> {t('rep.pdfBn')}
                  </button>
                  <button
                    onClick={() => exportCashbookExcel(lang)}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" /> {t('common.excel')}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Cashbook KPIs */}
          {cbReport && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                <div className="text-xs text-slate-500">{isBn ? 'প্রারম্ভিক জের (Opening)' : 'Opening Balance'}</div>
                <div className="text-base sm:text-lg font-display font-bold font-mono tabular-nums mt-1">
                  {fmtMoney(cbReport.opening_balance)}
                </div>
              </div>
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                <div className="text-xs text-slate-500 flex items-center gap-1">
                  <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-600" />
                  <span>{isBn ? 'মোট জমা / প্রাপ্তি (In)' : 'Total Cash In (Receipts)'}</span>
                </div>
                <div className="text-base sm:text-lg font-display font-bold font-mono tabular-nums mt-1 text-emerald-700 dark:text-emerald-400">
                  +{fmtMoney(cbReport.total_receipts)}
                </div>
              </div>
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                <div className="text-xs text-slate-500 flex items-center gap-1">
                  <ArrowUpRight className="w-3.5 h-3.5 text-red-600" />
                  <span>{isBn ? 'মোট খরচ / প্রদান (Out)' : 'Total Cash Out (Payments)'}</span>
                </div>
                <div className="text-base sm:text-lg font-display font-bold font-mono tabular-nums mt-1 text-red-600 dark:text-red-400">
                  -{fmtMoney(cbReport.total_payments)}
                </div>
              </div>
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                <div className="text-xs text-slate-500 flex items-center gap-1">
                  <Landmark className="w-3.5 h-3.5 text-sky-600" />
                  <span>{isBn ? 'সমাপনী জের (Closing)' : 'Closing Balance'}</span>
                </div>
                <div className="text-base sm:text-lg font-display font-bold font-mono tabular-nums mt-1 text-sky-700 dark:text-sky-400">
                  {fmtMoney(cbReport.closing_balance)}
                </div>
              </div>
            </div>
          )}

          {/* Cashbook Register Table (Desktop) + Cards (Mobile) */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            {cbLoading && !cbReport ? (
              <div className="p-8 text-center text-xs text-slate-500">
                {isBn ? 'ক্যাশবুক লোড হচ্ছে...' : 'Loading Cashbook register...'}
              </div>
            ) : !cbReport ? null : (
              <>
                {/* Mobile Card View */}
                <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
                  <div className="p-3.5 bg-slate-50 dark:bg-slate-950 flex items-center justify-between text-xs">
                    <div>
                      <div className="font-mono font-semibold text-slate-500">OPEN-BAL · {cbReport.from || '-'}</div>
                      <div className="font-medium mt-0.5">
                        {isBn ? 'প্রারম্ভিক জের' : 'Opening Balance Brought Forward'}
                      </div>
                    </div>
                    <div className="font-mono font-bold tabular-nums">{fmtMoney(cbReport.opening_balance)}</div>
                  </div>

                  {filteredCbEntries.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500">
                      {isBn ? 'এই সময়কালে কোনো নগদ বা ব্যাংক লেনদেন নেই।' : 'No cash or bank transactions in this period.'}
                    </div>
                  ) : (
                    filteredCbEntries.map((row) => (
                      <div key={row.id} className="p-3.5 space-y-1.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono font-semibold">
                            {row.voucher_no} · <span className="text-slate-500">{row.entry_date}</span>
                          </span>
                          {row.receipt > 0 ? (
                            <span className="px-2 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400 font-mono font-semibold">
                              +{fmtMoney(row.receipt)}
                            </span>
                          ) : (
                            <span className="px-2 py-0.5 rounded bg-red-50 dark:bg-red-950/50 text-red-600 dark:text-red-400 font-mono font-semibold">
                              -{fmtMoney(row.payment)}
                            </span>
                          )}
                        </div>
                        <div className="text-slate-900 dark:text-white font-medium">{row.description}</div>
                        <div className="flex items-center justify-between text-[11px] text-slate-500">
                          <span>
                            {row.account_code} {row.account_name}
                            {row.contra_head ? ` ↔ ${row.contra_head}` : ''}
                          </span>
                          <span className="font-mono font-semibold text-slate-900 dark:text-white">
                            {isBn ? 'জের' : 'Bal'}: {fmtMoney(row.running_balance)}
                          </span>
                        </div>
                      </div>
                    ))
                  )}

                  <div className="p-3.5 bg-slate-50 dark:bg-slate-950 flex items-center justify-between text-xs font-bold">
                    <span>{isBn ? 'সমাপনী জের' : 'Closing Balance'}</span>
                    <span className="font-mono tabular-nums text-sky-700 dark:text-sky-400">
                      {fmtMoney(cbReport.closing_balance)}
                    </span>
                  </div>
                </div>

                {/* Desktop Table View */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                        <th className="text-left px-4 py-3 font-medium">{t('common.date')}</th>
                        <th className="text-left px-4 py-3 font-medium">{t('acc.voucherNo')}</th>
                        <th className="text-left px-4 py-3 font-medium">{isBn ? 'ক্যাশ / ব্যাংক' : 'Cash / Bank'}</th>
                        <th className="text-left px-4 py-3 font-medium">{isBn ? 'বিবরণ ও বিপরীত খাত' : 'Particulars & Contra Head'}</th>
                        <th className="text-right px-4 py-3 font-medium">{isBn ? 'জমা / প্রাপ্তি (৳)' : 'Receipt / In (৳)'}</th>
                        <th className="text-right px-4 py-3 font-medium">{isBn ? 'খরচ / প্রদান (৳)' : 'Payment / Out (৳)'}</th>
                        <th className="text-right px-4 py-3 font-medium">{t('party.balance')} (৳)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      <tr className="bg-slate-50/70 dark:bg-slate-950/60 font-medium">
                        <td className="px-4 py-2.5 font-mono text-slate-500">{cbReport.from || '-'}</td>
                        <td className="px-4 py-2.5 font-mono">OPEN-BAL</td>
                        <td className="px-4 py-2.5 text-slate-500">
                          {cbReport.account_id === 'ALL'
                            ? isBn
                              ? 'সকল ক্যাশ ও ব্যাংক'
                              : 'All Cash & Bank'
                            : cbReport.accounts.find((a) => a.id === cbReport.account_id)?.name || ''}
                        </td>
                        <td className="px-4 py-2.5">{isBn ? 'প্রারম্ভিক জের (Opening Balance B/F)' : 'Opening Balance Brought Forward'}</td>
                        <td className="px-4 py-2.5 text-right font-mono">-</td>
                        <td className="px-4 py-2.5 text-right font-mono">-</td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums font-bold">
                          {fmtMoney(cbReport.opening_balance)}
                        </td>
                      </tr>

                      {filteredCbEntries.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                            {isBn ? 'এই সময়কালে কোনো নগদ বা ব্যাংক লেনদেন নেই।' : 'No cash or bank transactions in this period.'}
                          </td>
                        </tr>
                      ) : (
                        filteredCbEntries.map((row) => (
                          <tr key={row.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                            <td className="px-4 py-2.5 font-mono whitespace-nowrap">{row.entry_date}</td>
                            <td className="px-4 py-2.5 font-mono font-medium whitespace-nowrap">{row.voucher_no}</td>
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              <span className="font-mono text-slate-500 mr-1">{row.account_code}</span>
                              <span className="font-medium">{row.account_name}</span>
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="text-slate-900 dark:text-white">{row.description}</div>
                              {row.contra_head && (
                                <div className="text-[11px] text-slate-500 font-mono mt-0.5">↔ {row.contra_head}</div>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400 font-semibold">
                              {row.receipt > 0 ? fmtMoney(row.receipt) : '-'}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums text-red-600 dark:text-red-400 font-semibold">
                              {row.payment > 0 ? fmtMoney(row.payment) : '-'}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums font-bold">
                              {fmtMoney(row.running_balance)}
                            </td>
                          </tr>
                        ))
                      )}

                      <tr className="bg-slate-50 dark:bg-slate-950 font-bold border-t-2 border-slate-200 dark:border-slate-700">
                        <td colSpan={4} className="px-4 py-3 text-right">
                          {isBn
                            ? `মোট (${filteredCbEntries.length} এন্ট্রি) ও সমাপনী জের`
                            : `TOTAL (${filteredCbEntries.length} entries) & CLOSING BALANCE`}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                          {fmtMoney(cbReport.total_receipts)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-red-600 dark:text-red-400">
                          {fmtMoney(cbReport.total_payments)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-sky-700 dark:text-sky-400">
                          {fmtMoney(cbReport.closing_balance)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ================================================================ */}
      {/* 2. GENERAL LEDGER (GL)                                           */}
      {/* ================================================================ */}
      {bookView === 'gl' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isBn ? 'অ্যাকাউন্ট নির্বাচন করুন' : 'Select GL Account'}
                </label>
                <select
                  value={effectiveGlAccountId}
                  onChange={(e) => setGlAccountId(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.account_code} {a.name} [{a.account_type}] ({fmtMoney(a.balance)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isBn ? 'শুরুর তারিখ' : 'From Date'}
                </label>
                <input
                  type="date"
                  value={glFrom}
                  onChange={(e) => setGlFrom(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isBn ? 'শেষ তারিখ' : 'To Date'}
                </label>
                <input
                  type="date"
                  value={glTo}
                  onChange={(e) => setGlTo(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isBn ? 'খুঁজুন (ভাউচার / বিবরণ)' : 'Search (Voucher / Particulars)'}
                </label>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                  <input
                    type="text"
                    value={glSearch}
                    onChange={(e) => setGlSearch(e.target.value)}
                    placeholder={isBn ? 'ভাউচার বা বিবরণ...' : 'Voucher, description...'}
                    className="w-full pl-8 pr-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>
              <div className="flex flex-col justify-end">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => applyQuickRange(setGlFrom, setGlTo, 'today')}
                    className="px-2.5 py-2 text-[11px] font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    {isBn ? 'আজ' : 'Today'}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyQuickRange(setGlFrom, setGlTo, 'month')}
                    className="px-2.5 py-2 text-[11px] font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    {isBn ? 'এই মাস' : 'Month'}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyQuickRange(setGlFrom, setGlTo, 'all')}
                    className="px-2.5 py-2 text-[11px] font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    {isBn ? 'সব' : 'All'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void loadGlLedger()}
                    className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                    title={t('common.refresh')}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${glLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>
            </div>

            {glData && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <div className="text-xs font-mono text-slate-600 dark:text-slate-300">
                  {glData.account.account_code} {glData.account.name} ·{' '}
                  <span className="text-slate-500">{glData.account.account_type}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() =>
                      exportAccountLedgerPdf(glData.account, filteredGlEntries, 'en', 'open', {
                        openingBalance: glData.opening_balance,
                        closingBalance: glData.closing_balance,
                        dateFrom: glData.from,
                        dateTo: glData.to,
                      })
                    }
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <Printer className="w-3.5 h-3.5" /> {t('rep.pdfEn')}
                  </button>
                  <button
                    onClick={() =>
                      exportAccountLedgerPdf(glData.account, filteredGlEntries, 'bn', 'open', {
                        openingBalance: glData.opening_balance,
                        closingBalance: glData.closing_balance,
                        dateFrom: glData.from,
                        dateTo: glData.to,
                      })
                    }
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <Printer className="w-3.5 h-3.5" /> {t('rep.pdfBn')}
                  </button>
                  <button
                    onClick={() =>
                      exportExcelWorkbook(
                        `GL-Ledger-${glData.account.account_code}`,
                        [
                          {
                            name: `${glData.account.account_code}`,
                            rows: filteredGlEntries.map((r) => ({
                              Date: r.entry_date,
                              VoucherNo: r.voucher_no,
                              Particulars: r.description,
                              ContraHead: r.contra_head || '',
                              Debit: r.debit,
                              Credit: r.credit,
                              RunningBalance: r.running_balance,
                            })),
                          },
                        ],
                        lang
                      )
                    }
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" /> {t('common.excel')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {glData && (
            <>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                  <div className="text-xs text-slate-500">{isBn ? 'প্রারম্ভিক জের' : 'Opening Balance'}</div>
                  <div className="text-base sm:text-lg font-display font-bold font-mono tabular-nums mt-1">
                    {fmtMoney(glData.opening_balance)}
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                  <div className="text-xs text-slate-500">{isBn ? 'মোট ডেবিট (Debit)' : 'Total Debit'}</div>
                  <div className="text-base sm:text-lg font-display font-bold font-mono tabular-nums mt-1 text-emerald-700 dark:text-emerald-400">
                    {fmtMoney(glData.total_debit)}
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                  <div className="text-xs text-slate-500">{isBn ? 'মোট ক্রেডিট (Credit)' : 'Total Credit'}</div>
                  <div className="text-base sm:text-lg font-display font-bold font-mono tabular-nums mt-1 text-red-600 dark:text-red-400">
                    {fmtMoney(glData.total_credit)}
                  </div>
                </div>
                <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                  <div className="text-xs text-slate-500">{isBn ? 'সমাপনী জের' : 'Closing Balance'}</div>
                  <div className="text-base sm:text-lg font-display font-bold font-mono tabular-nums mt-1 text-sky-700 dark:text-sky-400">
                    {fmtMoney(glData.closing_balance)}
                  </div>
                </div>
              </div>

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                {/* Mobile Cards */}
                <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
                  {(glData.opening_balance !== 0 || glFrom) && (
                    <div className="p-3.5 bg-slate-50 dark:bg-slate-950 flex items-center justify-between text-xs">
                      <span>{isBn ? 'প্রারম্ভিক জের' : 'Opening Balance'}</span>
                      <span className="font-mono font-bold">{fmtMoney(glData.opening_balance)}</span>
                    </div>
                  )}
                  {filteredGlEntries.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500">
                      {isBn ? 'এই সময়কালে কোনো জার্নাল লেনদেন নেই।' : 'No journal postings in this period.'}
                    </div>
                  ) : (
                    filteredGlEntries.map((row) => (
                      <div key={row.id} className="p-3.5 space-y-1 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-semibold">
                            {row.voucher_no} · <span className="text-slate-500">{row.entry_date}</span>
                          </span>
                          <span className="font-mono font-semibold">
                            {row.debit > 0 ? `Dr ${fmtMoney(row.debit)}` : `Cr ${fmtMoney(row.credit)}`}
                          </span>
                        </div>
                        <div className="font-medium">{row.description}</div>
                        <div className="flex items-center justify-between text-[11px] text-slate-500">
                          <span>{row.contra_head || '-'}</span>
                          <span className="font-mono font-semibold text-slate-900 dark:text-white">
                            {isBn ? 'জের' : 'Bal'}: {fmtMoney(row.running_balance)}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Desktop Table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                        <th className="text-left px-4 py-3 font-medium">{t('common.date')}</th>
                        <th className="text-left px-4 py-3 font-medium">{t('acc.voucherNo')}</th>
                        <th className="text-left px-4 py-3 font-medium">{isBn ? 'বিবরণ ও বিপরীত খাত' : 'Particulars & Contra Head'}</th>
                        <th className="text-right px-4 py-3 font-medium">{isBn ? 'ডেবিট (৳)' : 'Debit (৳)'}</th>
                        <th className="text-right px-4 py-3 font-medium">{isBn ? 'ক্রেডিট (৳)' : 'Credit (৳)'}</th>
                        <th className="text-right px-4 py-3 font-medium">{t('party.balance')} (৳)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {(glData.opening_balance !== 0 || glFrom) && (
                        <tr className="bg-slate-50/70 dark:bg-slate-950/60 font-medium">
                          <td className="px-4 py-2.5 font-mono text-slate-500">{glFrom || '-'}</td>
                          <td className="px-4 py-2.5 font-mono">OPEN-BAL</td>
                          <td className="px-4 py-2.5">{isBn ? 'প্রারম্ভিক জের (Opening Balance)' : 'Opening Balance Brought Forward'}</td>
                          <td className="px-4 py-2.5 text-right font-mono">-</td>
                          <td className="px-4 py-2.5 text-right font-mono">-</td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums font-bold">
                            {fmtMoney(glData.opening_balance)}
                          </td>
                        </tr>
                      )}
                      {filteredGlEntries.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                            {isBn ? 'এই সময়কালে কোনো জার্নাল লেনদেন নেই।' : 'No journal postings in this period.'}
                          </td>
                        </tr>
                      ) : (
                        filteredGlEntries.map((row) => (
                          <tr key={row.id} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                            <td className="px-4 py-2.5 font-mono whitespace-nowrap">{row.entry_date}</td>
                            <td className="px-4 py-2.5 font-mono font-medium whitespace-nowrap">{row.voucher_no}</td>
                            <td className="px-4 py-2.5">
                              <div>{row.description}</div>
                              {row.contra_head && (
                                <div className="text-[11px] text-slate-500 font-mono mt-0.5">↔ {row.contra_head}</div>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                              {row.debit > 0 ? fmtMoney(row.debit) : '-'}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                              {row.credit > 0 ? fmtMoney(row.credit) : '-'}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums font-bold">
                              {fmtMoney(row.running_balance)}
                            </td>
                          </tr>
                        ))
                      )}
                      <tr className="bg-slate-50 dark:bg-slate-950 font-bold border-t-2 border-slate-200 dark:border-slate-700">
                        <td colSpan={3} className="px-4 py-3 text-right">
                          {isBn
                            ? `মোট (${filteredGlEntries.length} এন্ট্রি) ও সমাপনী জের`
                            : `TOTAL (${filteredGlEntries.length} entries) & CLOSING BALANCE`}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">{fmtMoney(glData.total_debit)}</td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">{fmtMoney(glData.total_credit)}</td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-sky-700 dark:text-sky-400">
                          {fmtMoney(glData.closing_balance)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ================================================================ */}
      {/* 3. PARTY LEDGER                                                  */}
      {/* ================================================================ */}
      {bookView === 'party' && (
        <div className="space-y-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isBn ? 'পার্টির ধরন' : 'Party Type'}
                </label>
                <select
                  value={partyRoleFilter}
                  onChange={(e) => setPartyRoleFilter(e.target.value as 'ALL' | 'CUSTOMER' | 'SUPPLIER' | 'BOTH')}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="ALL">{t('common.all')} ({parties.length})</option>
                  <option value="CUSTOMER">{t('party.customers')}</option>
                  <option value="SUPPLIER">{t('party.suppliers')}</option>
                  <option value="BOTH">{t('party.roleBoth')}</option>
                </select>
              </div>
              <div className="lg:col-span-2">
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isBn ? 'পার্টি (কাস্টমার / সাপ্লায়ার) নির্বাচন' : 'Select Customer / Supplier'}
                </label>
                <select
                  value={effectivePartyId}
                  onChange={(e) => setSelectedPartyId(Number(e.target.value))}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {filteredPartyOptions.length === 0 ? (
                    <option value={0}>{isBn ? 'কোনো পার্টি নেই' : 'No parties available'}</option>
                  ) : (
                    filteredPartyOptions.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.party_code} · {p.party_type})
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isBn ? 'শুরুর তারিখ' : 'From Date'}
                </label>
                <input
                  type="date"
                  value={plFrom}
                  onChange={(e) => setPlFrom(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">
                  {isBn ? 'শেষ তারিখ' : 'To Date'}
                </label>
                <input
                  type="date"
                  value={plTo}
                  onChange={(e) => setPlTo(e.target.value)}
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div className="flex flex-col justify-end">
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => applyQuickRange(setPlFrom, setPlTo, 'month')}
                    className="px-2.5 py-2 text-[11px] font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    {isBn ? 'এই মাস' : 'Month'}
                  </button>
                  <button
                    type="button"
                    onClick={() => applyQuickRange(setPlFrom, setPlTo, 'all')}
                    className="px-2.5 py-2 text-[11px] font-medium rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    {isBn ? 'সব' : 'All'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void loadPartyLedger()}
                    className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800"
                    title={t('common.refresh')}
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${plLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>
              </div>
            </div>

            {plData && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <div className="relative w-full sm:w-64">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2.5" />
                  <input
                    type="text"
                    value={plSearch}
                    onChange={(e) => setPlSearch(e.target.value)}
                    placeholder={isBn ? 'বিল / ভাউচার নং বা বিবরণ...' : 'Ref no or description...'}
                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    onClick={() =>
                      exportPartyStatementPdf({
                        partyName: plData.party.name,
                        partyCode: plData.party.party_code,
                        partyType: plData.party.party_type,
                        phone: plData.party.phone,
                        address: plData.party.address,
                        lang: 'en',
                        dueLabel:
                          plData.party.party_type === 'SUPPLIER'
                            ? `Supplier Due: BDT ${plData.summary.supplier_due.toLocaleString('en-IN')}`
                            : `Customer Due: BDT ${plData.summary.customer_due.toLocaleString('en-IN')}`,
                        advanceLabel:
                          plData.party.party_type === 'SUPPLIER'
                            ? `Supplier Advance: BDT ${plData.summary.supplier_advance.toLocaleString('en-IN')}`
                            : `Customer Advance: BDT ${plData.summary.customer_advance.toLocaleString('en-IN')}`,
                        entries: partySliced.entries,
                      })
                    }
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <FileText className="w-3.5 h-3.5" /> {t('rep.pdfEn')}
                  </button>
                  <button
                    onClick={() =>
                      exportPartyStatementPdf({
                        partyName: plData.party.name,
                        partyCode: plData.party.party_code,
                        partyType: plData.party.party_type,
                        phone: plData.party.phone,
                        address: plData.party.address,
                        lang: 'bn',
                        dueLabel:
                          plData.party.party_type === 'SUPPLIER'
                            ? `সাপ্লায়ার বকেয়া: ৳${plData.summary.supplier_due.toLocaleString('en-IN')}`
                            : `কাস্টমার বকেয়া: ৳${plData.summary.customer_due.toLocaleString('en-IN')}`,
                        advanceLabel:
                          plData.party.party_type === 'SUPPLIER'
                            ? `সাপ্লায়ার অগ্রিম: ৳${plData.summary.supplier_advance.toLocaleString('en-IN')}`
                            : `কাস্টমার অগ্রিম: ৳${plData.summary.customer_advance.toLocaleString('en-IN')}`,
                        entries: partySliced.entries,
                      })
                    }
                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <FileText className="w-3.5 h-3.5" /> {t('rep.pdfBn')}
                  </button>
                  <button
                    onClick={() =>
                      exportExcelWorkbook(
                        `Party-Ledger-${plData.party.party_code}`,
                        [
                          {
                            name: plData.party.party_code,
                            rows: partySliced.entries.map((r) => ({
                              Date: r.date.slice(0, 16),
                              Type: r.entry_type,
                              RefNo: r.ref_no,
                              Particulars: r.description,
                              DebitReceivable: r.debit_receivable,
                              CreditPayable: r.credit_payable,
                              RunningBalance: r.running_balance,
                            })),
                          },
                        ],
                        lang
                      )
                    }
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" /> {t('common.excel')}
                  </button>
                </div>
              </div>
            )}
          </div>

          {!effectivePartyId ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-xs text-slate-500">
              {isBn ? 'লেজার দেখার জন্য অন্তত একজন পার্টি যোগ করুন।' : 'Add a customer or supplier party to view their ledger.'}
            </div>
          ) : plLoading && !plData ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-xs text-slate-500">
              {t('party.loadingLedger')}
            </div>
          ) : plData ? (
            <>
              {(() => {
                const statusInfo = formatPartyBalanceStatus(plData.party, partySliced.closing);
                return (
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5">
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                      <div className="text-xs text-slate-500">{isBn ? 'প্রারম্ভিক জের' : 'Opening Balance'}</div>
                      <div className="text-base sm:text-lg font-display font-bold font-mono tabular-nums mt-1">
                        {fmtMoney(Math.abs(partySliced.opening))}{' '}
                        <span className="text-xs text-slate-500">{partySliced.opening >= 0 ? 'Dr' : 'Cr'}</span>
                      </div>
                    </div>
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                      <div className="text-xs text-slate-500">{isBn ? 'ডেবিট / পাওনা (+)' : 'Total Debit (+)'}</div>
                      <div className="text-base sm:text-lg font-display font-bold font-mono tabular-nums mt-1">
                        {fmtMoney(partySliced.totalDebit)}
                      </div>
                    </div>
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                      <div className="text-xs text-slate-500">{isBn ? 'ক্রেডিট / জমা (-)' : 'Total Credit (-)'}</div>
                      <div className="text-base sm:text-lg font-display font-bold font-mono tabular-nums mt-1">
                        {fmtMoney(partySliced.totalCredit)}
                      </div>
                    </div>
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
                      <div className="text-xs text-slate-500">{isBn ? 'বর্তমান / সমাপনী অবস্থা' : 'Closing Balance Status'}</div>
                      <div className={`text-sm sm:text-base font-display font-bold font-mono tabular-nums mt-1 ${statusInfo.cls}`}>
                        {statusInfo.text}
                      </div>
                    </div>
                  </div>
                );
              })()}

              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                {/* Mobile Cards */}
                <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
                  {partySliced.entries.length === 0 ? (
                    <div className="p-6 text-center text-xs text-slate-500">{t('party.noLedgerEntries')}</div>
                  ) : (
                    partySliced.entries.map((row, idx) => (
                      <div key={`${row.ref_no}-${idx}`} className="p-3.5 space-y-1 text-xs">
                        <div className="flex items-center justify-between">
                          <span className="font-mono font-semibold">
                            {row.ref_no} · <span className="text-slate-500">{row.date.slice(0, 10)}</span>
                          </span>
                          <span className="font-mono font-semibold">
                            {row.debit_receivable > 0
                              ? `+${fmtMoney(row.debit_receivable)}`
                              : row.credit_payable > 0
                              ? `-${fmtMoney(row.credit_payable)}`
                              : '-'}
                          </span>
                        </div>
                        <div className="font-medium">{row.description}</div>
                        <div className="flex items-center justify-between text-[11px] text-slate-500">
                          <span>{row.entry_type}</span>
                          <span className="font-mono font-bold text-slate-900 dark:text-white">
                            {fmtMoney(Math.abs(row.running_balance))} {row.running_balance >= 0 ? 'Dr' : 'Cr'}
                          </span>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* Desktop Table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                        <th className="text-left px-4 py-3 font-medium">{t('common.date')}</th>
                        <th className="text-left px-4 py-3 font-medium">{isBn ? 'রেফ নং' : 'Ref No'}</th>
                        <th className="text-left px-4 py-3 font-medium">{t('acc.type')}</th>
                        <th className="text-left px-4 py-3 font-medium">{t('party.particulars')}</th>
                        <th className="text-right px-4 py-3 font-medium">{isBn ? 'ডেবিট (+)' : 'Debit (+)'}</th>
                        <th className="text-right px-4 py-3 font-medium">{isBn ? 'ক্রেডিট (-)' : 'Credit (-)'}</th>
                        <th className="text-right px-4 py-3 font-medium">{t('party.balance')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {partySliced.entries.length === 0 ? (
                        <tr>
                          <td colSpan={7} className="px-4 py-8 text-center text-slate-500">
                            {t('party.noLedgerEntries')}
                          </td>
                        </tr>
                      ) : (
                        partySliced.entries.map((row, idx) => (
                          <tr key={`${row.ref_no}-${idx}`} className="hover:bg-slate-50/60 dark:hover:bg-slate-800/30">
                            <td className="px-4 py-2.5 font-mono whitespace-nowrap">{row.date.slice(0, 16)}</td>
                            <td className="px-4 py-2.5 font-mono font-medium whitespace-nowrap">{row.ref_no}</td>
                            <td className="px-4 py-2.5 text-slate-500 whitespace-nowrap">{row.entry_type}</td>
                            <td className="px-4 py-2.5">{row.description}</td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                              {row.debit_receivable > 0 ? fmtMoney(row.debit_receivable) : '-'}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                              {row.credit_payable > 0 ? fmtMoney(row.credit_payable) : '-'}
                            </td>
                            <td className="px-4 py-2.5 text-right font-mono tabular-nums font-bold">
                              {fmtMoney(Math.abs(row.running_balance))}{' '}
                              <span className="text-[11px] text-slate-500">{row.running_balance >= 0 ? 'Dr' : 'Cr'}</span>
                            </td>
                          </tr>
                        ))
                      )}
                      <tr className="bg-slate-50 dark:bg-slate-950 font-bold border-t-2 border-slate-200 dark:border-slate-700">
                        <td colSpan={4} className="px-4 py-3 text-right">
                          {isBn
                            ? `মোট (${partySliced.entries.length} এন্ট্রি) ও সমাপনী ব্যালেন্স`
                            : `TOTAL (${partySliced.entries.length} entries) & CLOSING BALANCE`}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">{fmtMoney(partySliced.totalDebit)}</td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">{fmtMoney(partySliced.totalCredit)}</td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-sky-700 dark:text-sky-400">
                          {fmtMoney(Math.abs(partySliced.closing))}{' '}
                          <span className="text-[11px]">{partySliced.closing >= 0 ? 'Dr' : 'Cr'}</span>
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
    </div>
  );
};
