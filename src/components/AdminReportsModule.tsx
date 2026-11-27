import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Building2, CheckCircle2, DatabaseBackup, Download, Edit3, FileSpreadsheet, FileText, KeyRound, MessageSquare, Plus, RefreshCw, Send, ShieldAlert, Trash2, Upload, Users, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { apiGet, apiMutate, getClientType, resolveApiUrl } from '../services/api';
import { clearOfflineStorage } from '../services/offlineDb';
import { setActiveCompanySettings } from '../utils/companySettings';
import type {
  Account,
  AuditLog,
  CashbookReport,
  CompanySettings,
  DirectPaddySale,
  DryingBatch,
  EmployeeUser,
  InventoryLot,
  PaddyPurchase,
  Party,
  PaymentRecord,
  ProductionBatch,
  SalesInvoice,
  SmsGatewayPublicConfig,
  SmsLogEntry,
  SmsProviderType,
  StockLedgerEntry,
  StockTransfer,
} from '../types/erp';
import { exportAllReportsWorkbook, exportIndividualReport, type ReportDataset } from '../utils/allReports';
import { exportCashbookPdf, exportExcelWorkbook } from '../utils/reports';

export type AdminSubTab = 'reports' | 'company' | 'messaging' | 'employees' | 'audit' | 'backup';

interface AdminReportsModuleProps {
  currentUser: EmployeeUser;
  companySettings: CompanySettings;
  requestedSubTab?: AdminSubTab;
  onCompanyUpdated: (next: CompanySettings) => void;
  lots: InventoryLot[];
  purchases: PaddyPurchase[];
  batches: ProductionBatch[];
  dryingBatches?: DryingBatch[];
  invoices: SalesInvoice[];
  paddySales?: DirectPaddySale[];
  transfers?: StockTransfer[];
  stockLedger?: StockLedgerEntry[];
  parties?: Party[];
  payments?: PaymentRecord[];
  accounts: Account[];
  onRefresh: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

export const AdminReportsModule: React.FC<AdminReportsModuleProps> = ({
  currentUser,
  companySettings,
  requestedSubTab,
  onCompanyUpdated,
  lots,
  purchases,
  batches,
  dryingBatches = [],
  invoices,
  paddySales = [],
  transfers = [],
  stockLedger = [],
  parties = [],
  payments = [],
  accounts,
  onRefresh,
  onNotify,
}) => {
  const { t, lang } = useI18n();
  const isBn = lang === 'bn';

  const [subTab, setSubTab] = useState<AdminSubTab>(requestedSubTab || 'reports');
  const [companyForm, setCompanyForm] = useState<CompanySettings>(companySettings);
  const [savingCompany, setSavingCompany] = useState(false);

  const canManageSms =
    currentUser.role_code === 'OWNER' ||
    currentUser.role_code === 'MANAGER' ||
    (currentUser.permissions || []).includes('employees.manage');

  const [smsConfig, setSmsConfig] = useState<SmsGatewayPublicConfig>({
    provider: 'NONE',
    enabled: false,
    auto_on_paddy_purchase: true,
    auto_on_paddy_price: true,
    lang_mode: 'bn',
    sender_id: '',
    webhook_url: '',
    message_template: '',
    has_api_key: false,
  });
  const [smsApiKeyInput, setSmsApiKeyInput] = useState('');
  const [clearSmsKey, setClearSmsKey] = useState(false);
  const [smsLogs, setSmsLogs] = useState<SmsLogEntry[]>([]);
  const [loadingSms, setLoadingSms] = useState(false);
  const [savingSms, setSavingSms] = useState(false);
  const [testSmsPhone, setTestSmsPhone] = useState('');
  const [testSmsMessage, setTestSmsMessage] = useState('');
  const [sendingTestSms, setSendingTestSms] = useState(false);
  const [lastTestResult, setLastTestResult] = useState<{ ok: boolean; status: string; providerResponse: string; phone: string } | null>(null);

  useEffect(() => {
    setCompanyForm(companySettings);
  }, [companySettings]);

  useEffect(() => {
    if (requestedSubTab) {
      setSubTab(requestedSubTab);
    }
  }, [requestedSubTab]);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [clearConfirmScope, setClearConfirmScope] = useState<'TRANSACTIONS_ONLY' | 'ALL_DATA' | null>(null);
  const [clearingData, setClearingData] = useState(false);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingRestore, setPendingRestore] = useState<{ fileName: string; tables: Record<string, unknown[]>; totalRows: number } | null>(null);
  const [restoringBackup, setRestoringBackup] = useState(false);
  const [employeesData, setEmployeesData] = useState<{
    employees: Array<{ id: number; employee_code: string; full_name: string; email: string; phone?: string; role_id: number; role_name: string; role_code: string; is_active: number }>;
    roles: Array<{ id: number; code: string; name: string; description: string }>;
  } | null>(null);
  const [auditData, setAuditData] = useState<{
    audit_logs: AuditLog[];
    sync_logs: Array<{ id: number; client_uuid: string; client_type: string; endpoint: string; status: string; conflict_reason?: string; employee_name: string; synced_at: string }>;
  } | null>(null);
  const [backups, setBackups] = useState<Array<{ id: number; backup_name: string; file_size_bytes: number; created_by_name: string; created_at: string }>>([]);

  const [empForm, setEmpForm] = useState({
    full_name: '',
    email: '',
    phone: '',
    password: '',
    role_id: 3,
  });
  const [editingEmployee, setEditingEmployee] = useState<{
    id: number;
    employee_code: string;
    full_name: string;
    email: string;
    phone?: string;
    role_id: number;
    role_name: string;
    role_code: string;
    is_active: number;
  } | null>(null);
  const [editEmpForm, setEditEmpForm] = useState({
    full_name: '',
    email: '',
    phone: '',
    role_id: 3,
    is_active: true,
    password: '',
  });
  const [savingEmpEdit, setSavingEmpEdit] = useState(false);

  const inDateRange = (ts?: string) => {
    if (!dateFrom && !dateTo) return true;
    if (!ts) return true;
    const d = ts.slice(0, 10);
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  };

  const customers = useMemo(() => parties.filter((p) => p.party_type === 'CUSTOMER' || p.party_type === 'BOTH'), [parties]);
  const suppliers = useMemo(() => parties.filter((p) => p.party_type === 'SUPPLIER' || p.party_type === 'BOTH'), [parties]);
  const filteredPurchases = useMemo(() => purchases.filter((p) => inDateRange(p.created_at)), [purchases, dateFrom, dateTo]);
  const filteredInvoices = useMemo(() => invoices.filter((i) => inDateRange(i.created_at)), [invoices, dateFrom, dateTo]);
  const filteredPaddySales = useMemo(() => paddySales.filter((s) => inDateRange(s.created_at)), [paddySales, dateFrom, dateTo]);
  const filteredPayments = useMemo(() => payments.filter((p) => inDateRange(p.created_at)), [payments, dateFrom, dateTo]);
  const filteredBatches = useMemo(() => batches.filter((b) => inDateRange(b.started_at)), [batches, dateFrom, dateTo]);
  const filteredDrying = useMemo(() => dryingBatches.filter((d) => inDateRange(d.created_at)), [dryingBatches, dateFrom, dateTo]);
  const filteredLedger = useMemo(() => stockLedger.filter((l) => inDateRange(l.created_at)), [stockLedger, dateFrom, dateTo]);

  const reportDataset: ReportDataset = useMemo(
    () => ({
      customers,
      suppliers,
      payments: filteredPayments,
      purchases: filteredPurchases,
      invoices: filteredInvoices,
      paddySales: filteredPaddySales,
      lots,
      batches: filteredBatches,
      dryingBatches: filteredDrying,
      stockLedger: filteredLedger,
      transfers,
      accounts,
    }),
    [
      customers,
      suppliers,
      filteredPayments,
      filteredPurchases,
      filteredInvoices,
      filteredPaddySales,
      lots,
      filteredBatches,
      filteredDrying,
      filteredLedger,
      transfers,
      accounts,
    ]
  );

  const loadTabDetails = async (tab: 'employees' | 'audit' | 'backup' | 'messaging') => {
    setSubTab(tab);
    try {
      if (tab === 'employees') {
        const res = await apiGet<typeof employeesData>('/api/v1/employees', 'cache_employees');
        setEmployeesData(res);
      } else if (tab === 'audit') {
        const res = await apiGet<typeof auditData>('/api/v1/audit-logs', 'cache_audit_logs');
        setAuditData(res);
      } else if (tab === 'backup') {
        const res = await apiGet<{ backups: typeof backups }>('/api/v1/backups', 'cache_backups');
        setBackups(res.backups);
      } else if (tab === 'messaging') {
        if (!canManageSms) return;
        setLoadingSms(true);
        try {
          const res = await apiGet<{ settings: SmsGatewayPublicConfig; logs: SmsLogEntry[] }>('/api/v1/sms/settings');
          setSmsConfig(res.settings);
          setSmsLogs(res.logs || []);
        } finally {
          setLoadingSms(false);
        }
      }
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  useEffect(() => {
    if (requestedSubTab === 'messaging' && canManageSms) {
      void loadTabDetails('messaging');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedSubTab]);

  const handleSaveSmsSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageSms) return;
    setSavingSms(true);
    try {
      const res = await fetch(resolveApiUrl('/api/v1/sms/settings'), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sonagrain_jwt')}`,
          'X-Client-Type': getClientType(),
        },
        body: JSON.stringify({
          ...smsConfig,
          api_key: smsApiKeyInput.trim() || undefined,
          clear_api_key: clearSmsKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save SMS gateway settings');
      setSmsConfig(data.settings);
      setSmsApiKeyInput('');
      setClearSmsKey(false);
      onNotify(
        isBn
          ? 'অটো SMS ও মেসেজিং গেটওয়ে সেটিংস সফলভাবে সংরক্ষিত হয়েছে।'
          : 'Auto-SMS & messaging gateway settings saved.',
        'ok'
      );
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSavingSms(false);
    }
  };

  const handleSendTestSms = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManageSms) return;
    setSendingTestSms(true);
    setLastTestResult(null);
    try {
      const res = await fetch(resolveApiUrl('/api/v1/sms/test'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sonagrain_jwt')}`,
          'X-Client-Type': getClientType(),
        },
        body: JSON.stringify({
          phone: testSmsPhone.trim(),
          message: testSmsMessage.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Test SMS failed');
      setLastTestResult(data);
      onNotify(
        data.ok
          ? isBn
            ? `${data.phone} নম্বরে টেস্ট SMS পাঠানো হয়েছে।`
            : `Test SMS sent to ${data.phone}.`
          : isBn
          ? `টেস্ট SMS ব্যর্থ হয়েছে: ${data.providerResponse || ''}`
          : `Test SMS failed: ${data.providerResponse || ''}`,
        data.ok ? 'ok' : 'err'
      );
      void loadTabDetails('messaging');
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSendingTestSms(false);
    }
  };

  const handleAddEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiMutate({
        endpoint: '/api/v1/employees',
        payload: empForm,
        module: 'Employee RBAC',
        summary: `Add ${empForm.full_name}`,
      });
      onNotify(isBn ? 'কর্মচারী অ্যাকাউন্ট তৈরি হয়েছে।' : 'Employee account created.', 'ok');
      setEmpForm({ full_name: '', email: '', phone: '', password: '', role_id: 3 });
      loadTabDetails('employees');
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const openEditEmployee = (emp: {
    id: number;
    employee_code: string;
    full_name: string;
    email: string;
    phone?: string;
    role_id: number;
    role_name: string;
    role_code: string;
    is_active: number;
  }) => {
    setEditingEmployee(emp);
    setEditEmpForm({
      full_name: emp.full_name,
      email: emp.email,
      phone: emp.phone || '',
      role_id: emp.role_id,
      is_active: Boolean(emp.is_active),
      password: '',
    });
  };

  const handleUpdateEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingEmployee) return;
    if (editEmpForm.password && editEmpForm.password.length < 6) {
      onNotify(isBn ? 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।' : 'New password must be at least 6 characters.', 'err');
      return;
    }
    setSavingEmpEdit(true);
    try {
      await apiMutate({
        endpoint: `/api/v1/employees/${editingEmployee.id}`,
        method: 'PUT',
        payload: {
          full_name: editEmpForm.full_name,
          email: editEmpForm.email,
          phone: editEmpForm.phone,
          role_id: editEmpForm.role_id,
          is_active: editEmpForm.is_active,
          password: editEmpForm.password.trim() || undefined,
        },
        module: 'Employee RBAC',
        summary: `Update ${editEmpForm.full_name}`,
      });
      onNotify(
        isBn
          ? `${editEmpForm.full_name}-এর তথ্য${editEmpForm.password ? ' ও পাসওয়ার্ড' : ''} আপডেট হয়েছে।`
          : `Updated ${editEmpForm.full_name}${editEmpForm.password ? ' and password' : ''}.`,
        'ok'
      );
      setEditingEmployee(null);
      loadTabDetails('employees');
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSavingEmpEdit(false);
    }
  };

  const handleExportBackup = async () => {
    try {
      const res = await fetch(resolveApiUrl('/api/v1/backups/export'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${localStorage.getItem('sonagrain_jwt')}`,
          'X-Client-Type': getClientType(),
        },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Backup failed');
      const blob = new Blob([JSON.stringify(data.snapshot, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = data.backup_name;
      a.click();
      URL.revokeObjectURL(url);
      onNotify(isBn ? `ব্যাকআপ ${data.backup_name} ডাউনলোড ও সংরক্ষিত হয়েছে।` : `Backup ${data.backup_name} downloaded & logged.`, 'ok');
      loadTabDetails('backup');
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const handleRestoreFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as { tables?: Record<string, unknown[]>; snapshot?: { tables?: Record<string, unknown[]> } };
      const tables = parsed?.tables && typeof parsed.tables === 'object' ? parsed.tables : parsed?.snapshot?.tables;
      if (!tables || typeof tables !== 'object') {
        throw new Error(isBn ? 'সঠিক ব্যাকআপ JSON ফাইল নয়।' : 'Invalid backup JSON format.');
      }
      const totalRows = Object.values(tables).reduce((sum, arr) => sum + (Array.isArray(arr) ? arr.length : 0), 0);
      setPendingRestore({ fileName: file.name, tables, totalRows });
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const handleConfirmRestore = async () => {
    if (!pendingRestore) return;
    setRestoringBackup(true);
    try {
      const res = await fetch(resolveApiUrl('/api/v1/backups/restore'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sonagrain_jwt')}`,
          'X-Client-Type': getClientType(),
        },
        body: JSON.stringify({ tables: pendingRestore.tables }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Backup restore failed');
      await clearOfflineStorage();
      setPendingRestore(null);
      onNotify(
        isBn
          ? `ব্যাকআপ সফলভাবে রিস্টোর হয়েছে (${data.total_rows ?? 0}টি রেকর্ড)।`
          : `Backup restored successfully (${data.total_rows ?? 0} records).`,
        'ok'
      );
      loadTabDetails('backup');
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setRestoringBackup(false);
    }
  };

  const handleClearAllData = async () => {
    if (!clearConfirmScope) return;
    setClearingData(true);
    try {
      const res = await fetch(resolveApiUrl('/api/v1/admin/clear-all-data'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sonagrain_jwt')}`,
          'X-Client-Type': getClientType(),
        },
        body: JSON.stringify({ scope: clearConfirmScope }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to clear data');
      await clearOfflineStorage();
      setClearConfirmScope(null);
      setBackups([]);
      setAuditData(null);
      onNotify(
        clearConfirmScope === 'ALL_DATA'
          ? isBn
            ? 'সব ব্যবসায়িক ডেটা, মাস্টার রেকর্ড এবং অফলাইন ক্যাশ পরিষ্কার হয়েছে।'
            : 'All business data, master records, and offline caches cleared.'
          : isBn
          ? 'সব লেনদেন, স্টক লট ও লেজার ব্যালেন্স পরিষ্কার হয়েছে।'
          : 'All transactions, stock lots, and ledger balances cleared.',
        'ok'
      );
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setClearingData(false);
    }
  };

  const handleLogoFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|jpg|webp|gif|svg\+xml)$/i.test(file.type)) {
      onNotify(
        isBn
          ? 'দয়া করে PNG, JPG, WebP, GIF অথবা SVG ছবি আপলোড করুন।'
          : 'Please upload a PNG, JPG, WebP, GIF, or SVG image.',
        'err'
      );
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      onNotify(
        isBn
          ? 'লোগো ফাইলের আকার ৫ মেগাবাইটের কম হতে হবে।'
          : 'Logo file must be smaller than 5 MB.',
        'err'
      );
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      const rawDataUrl = typeof reader.result === 'string' ? reader.result : '';
      if (!rawDataUrl) return;
      const img = new Image();
      img.onload = () => {
        const maxDim = 256;
        const w = img.naturalWidth || maxDim;
        const h = img.naturalHeight || maxDim;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        const targetW = Math.max(1, Math.round(w * scale));
        const targetH = Math.max(1, Math.round(h * scale));
        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          setCompanyForm((prev) => ({ ...prev, logo_data_url: rawDataUrl }));
          return;
        }
        ctx.clearRect(0, 0, targetW, targetH);
        ctx.drawImage(img, 0, 0, targetW, targetH);
        const compressedPng = canvas.toDataURL('image/png');
        setCompanyForm((prev) => ({ ...prev, logo_data_url: compressedPng }));
      };
      img.onerror = () => {
        onNotify(
          isBn ? 'লোগো ছবিটি পড়া যায়নি। অন্য ফাইল চেষ্টা করুন।' : 'Could not decode the selected image.',
          'err'
        );
      };
      img.src = rawDataUrl;
    };
    reader.readAsDataURL(file);
  };

  const handleSaveCompanySettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingCompany(true);
    try {
      const res = await fetch(resolveApiUrl('/api/v1/company-settings'), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('sonagrain_jwt')}`,
          'X-Client-Type': getClientType(),
        },
        body: JSON.stringify(companyForm),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update company settings');
      const saved = setActiveCompanySettings(data.company);
      onCompanyUpdated(saved);
      onNotify(
        isBn
          ? 'কোম্পানির নাম, লোগো, ঠিকানা ও প্রিন্ট হেডার সফলভাবে সংরক্ষিত হয়েছে।'
          : 'Company name, logo, address & letterhead settings saved successfully.',
        'ok'
      );
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSavingCompany(false);
    }
  };

  const handleExportCashbookReport = async (format: 'pdf' | 'excel', exportLang: 'en' | 'bn') => {
    try {
      const params = new URLSearchParams();
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      const qs = params.toString();
      const report = await apiGet<CashbookReport>(
        `/api/v1/accounting/cashbook${qs ? `?${qs}` : ''}`,
        `cache_admin_cashbook_${dateFrom}_${dateTo}`
      );
      if (format === 'pdf') {
        await exportCashbookPdf(report, exportLang);
      } else {
        const bn = exportLang === 'bn';
        exportExcelWorkbook(
          'Cashbook-Report',
          [
            {
              name: bn ? 'ক্যাশবুক' : 'Cashbook',
              rows: [
                bn
                  ? {
                      তারিখ: report.from || '-',
                      ভাউচার_নং: 'OPEN-BAL',
                      অ্যাকাউন্ট: 'সকল ক্যাশ ও ব্যাংক',
                      বিবরণ: 'প্রারম্ভিক জের (Opening Balance)',
                      জমা_প্রাপ্তি: 0,
                      খরচ_প্রদান: 0,
                      জের: report.opening_balance,
                    }
                  : {
                      Date: report.from || '-',
                      VoucherNo: 'OPEN-BAL',
                      Account: 'All Cash & Bank',
                      Particulars: 'Opening Balance B/F',
                      Receipt: 0,
                      Payment: 0,
                      Balance: report.opening_balance,
                    },
                ...report.entries.map((e) =>
                  bn
                    ? {
                        তারিখ: e.entry_date,
                        ভাউচার_নং: e.voucher_no,
                        অ্যাকাউন্ট: `${e.account_code} ${e.account_name}`,
                        বিবরণ: e.contra_head ? `${e.description} (${e.contra_head})` : e.description,
                        জমা_প্রাপ্তি: e.receipt,
                        খরচ_প্রদান: e.payment,
                        জের: e.running_balance,
                      }
                    : {
                        Date: e.entry_date,
                        VoucherNo: e.voucher_no,
                        Account: `${e.account_code} ${e.account_name}`,
                        Particulars: e.contra_head ? `${e.description} (${e.contra_head})` : e.description,
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
      }
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const reportConfigs: Array<{
    num: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
    title: string;
    description: string;
    countText: string;
  }> = [
    {
      num: 1,
      title: t('rep.r1Title'),
      description: t('rep.r1Desc'),
      countText: isBn ? `${customers.length} জন কাস্টমার` : `${customers.length} customer(s)`,
    },
    {
      num: 2,
      title: t('rep.r2Title'),
      description: t('rep.r2Desc'),
      countText: isBn ? `${suppliers.length} জন সাপ্লায়ার` : `${suppliers.length} supplier(s)`,
    },
    {
      num: 3,
      title: t('rep.r3Title'),
      description: t('rep.r3Desc'),
      countText: isBn ? `${filteredPayments.length} টি ভাউচার` : `${filteredPayments.length} voucher(s)`,
    },
    {
      num: 4,
      title: t('rep.r4Title'),
      description: t('rep.r4Desc'),
      countText: isBn ? `${filteredPurchases.length} টি রসিদ` : `${filteredPurchases.length} receipt(s)`,
    },
    {
      num: 5,
      title: t('rep.r5Title'),
      description: t('rep.r5Desc'),
      countText: isBn ? `${filteredInvoices.length} টি চালান` : `${filteredInvoices.length} invoice(s)`,
    },
    {
      num: 6,
      title: t('rep.r6Title'),
      description: t('rep.r6Desc'),
      countText: isBn ? `${filteredPaddySales.length} টি বিক্রয়` : `${filteredPaddySales.length} dispatch(es)`,
    },
    {
      num: 7,
      title: t('rep.r7Title'),
      description: t('rep.r7Desc'),
      countText: isBn ? `${lots.length} টি লট` : `${lots.length} lot(s)`,
    },
    {
      num: 8,
      title: t('rep.r8Title'),
      description: t('rep.r8Desc'),
      countText: isBn
        ? `${filteredLedger.length} লেজার · ${transfers.length} স্থানান্তর`
        : `${filteredLedger.length} ledger row(s) · ${transfers.length} transfer(s)`,
    },
    {
      num: 9,
      title: t('rep.r9Title'),
      description: t('rep.r9Desc'),
      countText: isBn
        ? `${filteredBatches.length} মিলিং · ${filteredDrying.length} ড্রাইং`
        : `${filteredBatches.length} milling · ${filteredDrying.length} drying`,
    },
    {
      num: 10,
      title: t('rep.r10Title'),
      description: t('rep.r10Desc'),
      countText: isBn ? `${accounts.length} টি অ্যাকাউন্ট` : `${accounts.length} ledger account(s)`,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-fit">
        <button
          onClick={() => setSubTab('reports')}
          className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
            subTab === 'reports' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
          }`}
        >
          {t('rep.tabReports')}
        </button>
        <button
          onClick={() => setSubTab('company')}
          className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
            subTab === 'company' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
          }`}
        >
          <Building2 className="w-3.5 h-3.5" />
          <span>{isBn ? 'কোম্পানির নাম ও ঠিকানা' : 'Company & Address'}</span>
        </button>
        <button
          onClick={() => void loadTabDetails('messaging')}
          className={`flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
            subTab === 'messaging' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
          }`}
        >
          <MessageSquare className="w-3.5 h-3.5" />
          <span>{isBn ? 'অটো SMS ও মেসেজিং' : 'Auto SMS & Messaging'}</span>
        </button>
        <button
          onClick={() => loadTabDetails('employees')}
          className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
            subTab === 'employees' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
          }`}
        >
          {t('rep.tabEmployees')}
        </button>
        <button
          onClick={() => loadTabDetails('audit')}
          className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
            subTab === 'audit' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
          }`}
        >
          {t('rep.tabAudit')}
        </button>
        <button
          onClick={() => loadTabDetails('backup')}
          className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
            subTab === 'backup' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
          }`}
        >
          {t('rep.tabBackup')}
        </button>
      </div>

      {subTab === 'reports' && (
        <div className="space-y-5">
          {/* Date Filter & Dual-Language Master Export Bar */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex flex-wrap items-center gap-3 text-xs">
              <span className="font-semibold text-slate-900 dark:text-white">{t('rep.filterDate')}</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
              />
              <span className="text-slate-400">{t('rep.to')}</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 font-mono"
              />
              {(dateFrom || dateTo) && (
                <button
                  onClick={() => {
                    setDateFrom('');
                    setDateTo('');
                  }}
                  className="text-amber-600 hover:underline font-medium"
                >
                  {t('rep.clearFilter')}
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => exportAllReportsWorkbook(reportDataset, 'en')}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-900 dark:text-white text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{t('rep.masterEn')}</span>
              </button>
              <button
                onClick={() => exportAllReportsWorkbook(reportDataset, 'bn')}
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium hover:opacity-95 whitespace-nowrap shrink-0"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{t('rep.masterBn')}</span>
              </button>
            </div>
          </div>

          {/* Complete 10-Report Grid with EN & বাংলা PDF + Excel Exports */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {reportConfigs.map((rc) => (
              <ReportCard
                key={rc.num}
                title={rc.title}
                description={rc.description}
                countText={rc.countText}
                pdfEnLabel={t('rep.pdfEn')}
                pdfBnLabel={t('rep.pdfBn')}
                excelEnLabel={t('rep.excelEn')}
                excelBnLabel={t('rep.excelBn')}
                onPdfEn={() => exportIndividualReport(rc.num, 'pdf', 'en', reportDataset)}
                onPdfBn={() => exportIndividualReport(rc.num, 'pdf', 'bn', reportDataset)}
                onExcelEn={() => exportIndividualReport(rc.num, 'excel', 'en', reportDataset)}
                onExcelBn={() => exportIndividualReport(rc.num, 'excel', 'bn', reportDataset)}
              />
            ))}
            <ReportCard
              title={isBn ? '১১. ক্যাশবুক ও ব্যাংক স্থিতি রিপোর্ট' : '11. Cashbook & Bank Register Report'}
              description={
                isBn
                  ? 'প্রারম্ভিক জের, নগদ ও ব্যাংক জমা/খরচ এবং সমাপনী ব্যালেন্সের বিস্তারিত খাতা।'
                  : 'Opening balance, daily cash/bank receipts, payments & running closing balance.'
              }
              countText={
                isBn
                  ? `${accounts.filter((a) => a.account_code.startsWith('10')).length} টি ক্যাশ/ব্যাংক অ্যাকাউন্ট`
                  : `${accounts.filter((a) => a.account_code.startsWith('10')).length} cash/bank account(s)`
              }
              pdfEnLabel={t('rep.pdfEn')}
              pdfBnLabel={t('rep.pdfBn')}
              excelEnLabel={t('rep.excelEn')}
              excelBnLabel={t('rep.excelBn')}
              onPdfEn={() => void handleExportCashbookReport('pdf', 'en')}
              onPdfBn={() => void handleExportCashbookReport('pdf', 'bn')}
              onExcelEn={() => void handleExportCashbookReport('excel', 'en')}
              onExcelBn={() => void handleExportCashbookReport('excel', 'bn')}
            />
          </div>
        </div>
      )}

      {subTab === 'company' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <form
            onSubmit={handleSaveCompanySettings}
            className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-4">
              <div>
                <h3 className="text-sm font-display font-semibold flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-amber-600" />
                  <span>{isBn ? 'মিল / কোম্পানির নাম, ঠিকানা ও প্রিন্ট সেটিংস' : 'Mill / Company Name, Address & Stationery Settings'}</span>
                </h3>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60">
              <div className="w-16 h-16 rounded-xl border border-slate-300 dark:border-slate-700 bg-white flex items-center justify-center overflow-hidden shrink-0">
                {companyForm.logo_data_url ? (
                  <img
                    src={companyForm.logo_data_url}
                    alt={companyForm.company_name_en || 'Company Logo'}
                    className="w-full h-full object-contain p-1"
                  />
                ) : (
                  <span className="font-display font-bold text-base text-slate-900">
                    {companyForm.short_code || 'SG'}
                  </span>
                )}
              </div>
              <div className="flex-1 min-w-[200px] space-y-1.5">
                <div className="text-xs font-semibold text-slate-800 dark:text-slate-100">
                  {isBn ? 'কোম্পানির লোগো (প্রিন্ট, PDF, লগইন ও সাইডবার)' : 'Company Logo (Reports, Invoices, Login & Sidebar)'}
                </div>
                <p className="text-[11px] text-slate-500">
                  {isBn
                    ? 'PNG, JPG, WebP বা SVG ফাইল আপলোড করুন। আপলোড করলে সব রিপোর্ট ও চালানের উপরে লোগো দেখাবে।'
                    : 'Upload PNG, JPG, WebP, or SVG. Automatically resized for crisp PDF letterheads & QR labels.'}
                </p>
                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium cursor-pointer hover:opacity-95">
                    <Upload className="w-3.5 h-3.5" />
                    <span>{isBn ? (companyForm.logo_data_url ? 'লোগো পরিবর্তন' : 'লোগো আপলোড করুন') : (companyForm.logo_data_url ? 'Change Logo' : 'Upload Logo')}</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                      onChange={handleLogoFileChange}
                      className="hidden"
                      disabled={currentUser.role_code !== 'OWNER' && currentUser.role_code !== 'MANAGER'}
                    />
                  </label>
                  {companyForm.logo_data_url && (
                    <button
                      type="button"
                      onClick={() => setCompanyForm((prev) => ({ ...prev, logo_data_url: '' }))}
                      disabled={currentUser.role_code !== 'OWNER' && currentUser.role_code !== 'MANAGER'}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-red-200 dark:border-red-900/50 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 text-xs font-medium disabled:opacity-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{isBn ? 'লোগো মুছুন' : 'Remove'}</span>
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">
                  {isBn ? 'কোম্পানির নাম (ইংরেজি) *' : 'Company Name (English) *'}
                </label>
                <input
                  type="text"
                  required
                  value={companyForm.company_name_en}
                  onChange={(e) => setCompanyForm({ ...companyForm, company_name_en: e.target.value })}
                  placeholder="Company name"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">
                  {isBn ? 'কোম্পানির নাম (বাংলা) *' : 'Company Name (Bangla) *'}
                </label>
                <input
                  type="text"
                  required
                  value={companyForm.company_name_bn}
                  onChange={(e) => setCompanyForm({ ...companyForm, company_name_bn: e.target.value })}
                  placeholder="কোম্পানির নাম"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">
                  {isBn ? 'সংক্ষিপ্ত কোড / মনোগ্রাম' : 'Short Monogram (2-3 chars)'}
                </label>
                <input
                  type="text"
                  maxLength={4}
                  value={companyForm.short_code}
                  onChange={(e) => setCompanyForm({ ...companyForm, short_code: e.target.value.toUpperCase() })}
                  placeholder="SG"
                  className="w-full px-3 py-2 text-xs font-mono uppercase rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">
                  {isBn ? 'ঠিকানা (ইংরেজি)' : 'Mill / Office Address (English)'}
                </label>
                <textarea
                  rows={2}
                  value={companyForm.address_en}
                  onChange={(e) => setCompanyForm({ ...companyForm, address_en: e.target.value })}
                  placeholder="Plot 14, BSCIC Industrial Estate, Bogura-5800, Bangladesh"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">
                  {isBn ? 'ঠিকানা (বাংলা)' : 'Mill / Office Address (Bangla)'}
                </label>
                <textarea
                  rows={2}
                  value={companyForm.address_bn}
                  onChange={(e) => setCompanyForm({ ...companyForm, address_bn: e.target.value })}
                  placeholder="প্লট ১৪, বিসিক শিল্প নগরী, বগুড়া-৫৮০০, বাংলাদেশ"
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">{isBn ? 'মোবাইল / ফোন' : 'Phone / Mobile'}</label>
                <input
                  type="text"
                  value={companyForm.phone}
                  onChange={(e) => setCompanyForm({ ...companyForm, phone: e.target.value })}
                  placeholder="+880 1711-000000"
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{isBn ? 'ইমেইল' : 'Email'}</label>
                <input
                  type="email"
                  value={companyForm.email}
                  onChange={(e) => setCompanyForm({ ...companyForm, email: e.target.value })}
                  placeholder="info@company.com"
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">
                  {isBn ? 'BIN / ভ্যাট / ট্রেড লাইসেন্স নং' : 'BIN / VAT / Trade License'}
                </label>
                <input
                  type="text"
                  value={companyForm.tax_id}
                  onChange={(e) => setCompanyForm({ ...companyForm, tax_id: e.target.value })}
                  placeholder="BIN: 001234567-0101"
                  className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium mb-1">
                  {isBn ? 'স্লোগান / উপশিরোনাম (ইংরেজি)' : 'Header Tagline (English)'}
                </label>
                <input
                  type="text"
                  value={companyForm.tagline_en}
                  onChange={(e) => setCompanyForm({ ...companyForm, tagline_en: e.target.value })}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">
                  {isBn ? 'স্লোগান / উপশিরোনাম (বাংলা)' : 'Header Tagline (Bangla)'}
                </label>
                <input
                  type="text"
                  value={companyForm.tagline_bn}
                  onChange={(e) => setCompanyForm({ ...companyForm, tagline_bn: e.target.value })}
                  className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-slate-100 dark:border-slate-800">
              <div className="text-[11px] text-slate-500">
                {currentUser.role_code === 'OWNER' || currentUser.role_code === 'MANAGER'
                  ? isBn
                    ? 'মুদ্রা: বাংলাদেশী টাকা (৳ BDT)'
                    : 'Currency: Bangladeshi Taka (৳ BDT)'
                  : isBn
                  ? 'শুধুমাত্র মিল মালিক বা ম্যানেজার পরিবর্তন করতে পারবেন।'
                  : 'Only Mill Owner or Manager can update company details.'}
              </div>
              <button
                type="submit"
                disabled={savingCompany || (currentUser.role_code !== 'OWNER' && currentUser.role_code !== 'MANAGER')}
                className="flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-semibold hover:opacity-95 disabled:opacity-50"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{savingCompany ? t('common.saving') : isBn ? 'কোম্পানির তথ্য সংরক্ষণ করুন' : 'Save Company Profile'}</span>
              </button>
            </div>
          </form>

          {/* Live Invoice & Challan Header Preview */}
          <div className="space-y-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3">
              <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                {isBn ? 'লাইভ চালান ও ভাউচার প্রিভিউ' : 'Live Challan & Voucher Letterhead Preview'}
              </div>

              {/* Bangla Preview */}
              <div className="rounded-lg bg-slate-900 text-white p-4 border-t-4 border-amber-500 space-y-1.5">
                <div className="flex items-center gap-3">
                  {companyForm.logo_data_url ? (
                    <img
                      src={companyForm.logo_data_url}
                      alt={companyForm.company_name_bn || 'Logo'}
                      className="w-9 h-9 rounded-md bg-white object-contain p-0.5 shrink-0"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-md bg-amber-600 flex items-center justify-center font-mono font-bold text-sm shrink-0">
                      {companyForm.short_code || 'SG'}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="font-display font-bold text-sm truncate">
                      {companyForm.company_name_bn || companyForm.company_name_en}
                    </div>
                    <div className="text-[11px] text-slate-300 truncate">{companyForm.tagline_bn}</div>
                  </div>
                </div>
                <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-800 break-words">
                  {[companyForm.address_bn, companyForm.phone, companyForm.tax_id].filter(Boolean).join(' | ')}
                </div>
              </div>

              {/* English Preview */}
              <div className="rounded-lg bg-slate-900 text-white p-4 border-t-4 border-emerald-500 space-y-1.5">
                <div className="flex items-center gap-3">
                  {companyForm.logo_data_url ? (
                    <img
                      src={companyForm.logo_data_url}
                      alt={companyForm.company_name_en || 'Logo'}
                      className="w-9 h-9 rounded-md bg-white object-contain p-0.5 shrink-0"
                    />
                  ) : (
                    <div className="w-9 h-9 rounded-md bg-emerald-600 flex items-center justify-center font-mono font-bold text-sm shrink-0">
                      {companyForm.short_code || 'SG'}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="font-display font-bold text-sm uppercase truncate">
                      {companyForm.company_name_en || companyForm.company_name_bn}
                    </div>
                    <div className="text-[11px] text-slate-300 truncate">{companyForm.tagline_en}</div>
                  </div>
                </div>
                <div className="text-[10px] text-slate-400 pt-1 border-t border-slate-800 break-words">
                  {[companyForm.address_en, companyForm.phone, companyForm.tax_id].filter(Boolean).join(' | ')}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {subTab === 'messaging' && (
        <div className="space-y-6">
          {!canManageSms ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 text-xs text-slate-500">
              {isBn
                ? 'শুধুমাত্র মিল মালিক বা ম্যানেজার অটো SMS গেটওয়ে সেটিংস দেখতে ও পরিবর্তন করতে পারবেন।'
                : 'Only Mill Owner or Manager can configure Auto-SMS gateway settings.'}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <form
                  onSubmit={handleSaveSmsSettings}
                  className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-5 text-xs"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-4">
                    <div>
                      <h3 className="text-sm font-display font-semibold flex items-center gap-2 text-slate-900 dark:text-white">
                        <MessageSquare className="w-4 h-4 text-emerald-600" />
                        <span>{isBn ? 'অটো SMS গেটওয়ে ও কাস্টমার মেসেজ সেটিংস' : 'Auto-SMS Gateway & Customer Notification Settings'}</span>
                      </h3>
                      <p className="text-[11px] text-slate-500 mt-1">
                        {isBn
                          ? 'ধান ক্রয় সংরক্ষণের সাথে সাথেই কাস্টমার/সাপ্লায়ারের মোবাইলে অটো রসিদ SMS পাঠাতে বাংলাদেশী SMS গেটওয়ে অথবা HTTPS Webhook যুক্ত করুন।'
                          : 'Connect a Bangladesh SMS gateway or HTTPS Webhook so customers/suppliers automatically receive purchase receipts via SMS.'}
                      </p>
                    </div>
                    <span
                      className={`px-2.5 py-1 rounded-md text-[11px] font-semibold ${
                        smsConfig.enabled && smsConfig.provider !== 'NONE'
                          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                          : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                      }`}
                    >
                      {smsConfig.enabled && smsConfig.provider !== 'NONE'
                        ? isBn
                          ? `চালু (${smsConfig.provider})`
                          : `Active (${smsConfig.provider})`
                        : isBn
                        ? 'গেটওয়ে বন্ধ'
                        : 'Disabled'}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block font-medium mb-1">{isBn ? 'SMS গেটওয়ে প্রোভাইডার' : 'SMS Gateway Provider'}</label>
                      <select
                        value={smsConfig.provider}
                        onChange={(e) => {
                          const nextProvider = e.target.value as SmsProviderType;
                          setSmsConfig((prev) => ({
                            ...prev,
                            provider: nextProvider,
                            enabled: nextProvider === 'NONE' ? false : prev.enabled,
                          }));
                        }}
                        className="w-full px-3 py-2.5 min-h-[42px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      >
                        <option value="NONE">{isBn ? 'বন্ধ (শুধু WhatsApp / ফোন SMS ব্যবহার)' : 'Disabled (Use WhatsApp / Phone SMS App)'}</option>
                        <option value="BULKSMSBD">BulkSMSBD (bulksmsbd.net)</option>
                        <option value="SMSNETBD">SMS.net.bd (api.sms.net.bd)</option>
                        <option value="SSLWIRELESS">SSL Wireless (smsplus.sslwireless.com)</option>
                        <option value="WEBHOOK">{isBn ? 'কাস্টম HTTPS Webhook / WhatsApp API' : 'Custom HTTPS Webhook / WhatsApp Bridge'}</option>
                      </select>
                    </div>

                    <div>
                      <label className="block font-medium mb-1">{isBn ? 'অটো মেসেজের ভাষা' : 'Auto Message Language'}</label>
                      <select
                        value={smsConfig.lang_mode}
                        onChange={(e) => setSmsConfig((prev) => ({ ...prev, lang_mode: e.target.value === 'en' ? 'en' : 'bn' }))}
                        className="w-full px-3 py-2.5 min-h-[42px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      >
                        <option value="bn">{isBn ? 'বাংলা (সাজানো রসিদ বার্তা)' : 'Bangla (Default)'}</option>
                        <option value="en">English</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block font-medium mb-1">{isBn ? 'Sender ID / Masking / SID' : 'Sender ID / Masking / SID'}</label>
                      <input
                        type="text"
                        value={smsConfig.sender_id}
                        onChange={(e) => setSmsConfig((prev) => ({ ...prev, sender_id: e.target.value }))}
                        placeholder="e.g. 8809617612345 or MILLNAME"
                        className="w-full px-3 py-2.5 min-h-[42px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <label className="block font-medium">
                          {smsConfig.provider === 'WEBHOOK'
                            ? isBn
                              ? 'Bearer Token / Secret (ঐচ্ছিক)'
                              : 'Bearer Token / Secret (Optional)'
                            : isBn
                            ? 'Gateway API Key / Token'
                            : 'Gateway API Key / Token'}
                        </label>
                        {smsConfig.has_api_key && !clearSmsKey && (
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">
                            <KeyRound className="w-3 h-3" /> {isBn ? 'কী সংরক্ষিত আছে' : 'Saved'}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={smsApiKeyInput}
                          onChange={(e) => {
                            setSmsApiKeyInput(e.target.value);
                            if (e.target.value) setClearSmsKey(false);
                          }}
                          placeholder={
                            smsConfig.has_api_key && !clearSmsKey
                              ? isBn
                                ? 'পরিবর্তন না করলে খালি রাখুন'
                                : 'Leave blank to keep existing key'
                              : isBn
                              ? 'আপনার API Key লিখুন'
                              : 'Paste your API Key / Token'
                          }
                          className="flex-1 px-3 py-2.5 min-h-[42px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                        {smsConfig.has_api_key && (
                          <button
                            type="button"
                            onClick={() => {
                              setClearSmsKey((v) => !v);
                              setSmsApiKeyInput('');
                            }}
                            className={`px-2.5 rounded-lg border text-[11px] font-medium ${
                              clearSmsKey
                                ? 'border-red-500 bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300'
                                : 'border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                            }`}
                          >
                            {clearSmsKey ? (isBn ? 'বাতিল' : 'Undo') : isBn ? 'মুছুন' : 'Clear'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {smsConfig.provider === 'WEBHOOK' && (
                    <div>
                      <label className="block font-medium mb-1">{isBn ? 'HTTPS Webhook URL *' : 'HTTPS Webhook URL *'}</label>
                      <input
                        type="url"
                        required
                        value={smsConfig.webhook_url}
                        onChange={(e) => setSmsConfig((prev) => ({ ...prev, webhook_url: e.target.value }))}
                        placeholder="https://hooks.example.com/send-sms"
                        className="w-full px-3 py-2.5 min-h-[42px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 rounded-xl bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                    <label className="flex items-center gap-2 cursor-pointer select-none font-medium">
                      <input
                        type="checkbox"
                        disabled={smsConfig.provider === 'NONE'}
                        checked={smsConfig.enabled && smsConfig.provider !== 'NONE'}
                        onChange={(e) => setSmsConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
                        className="rounded border-slate-300 text-amber-600 focus:ring-amber-500 disabled:opacity-40"
                      />
                      <span>{isBn ? 'অটো SMS গেটওয়ে চালু করুন' : 'Enable Auto-SMS Gateway'}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer select-none font-medium">
                      <input
                        type="checkbox"
                        checked={smsConfig.auto_on_paddy_purchase}
                        onChange={(e) => setSmsConfig((prev) => ({ ...prev, auto_on_paddy_purchase: e.target.checked }))}
                        className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                      />
                      <span>{isBn ? 'ধান ক্রয়ে সাথে সাথে SMS' : 'Auto-send on Paddy Purchase'}</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer select-none font-medium">
                      <input
                        type="checkbox"
                        checked={smsConfig.auto_on_paddy_price}
                        onChange={(e) => setSmsConfig((prev) => ({ ...prev, auto_on_paddy_price: e.target.checked }))}
                        className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                      />
                      <span>{isBn ? 'দর নির্ধারণেও SMS' : 'Auto-send on Rate Pricing'}</span>
                    </label>
                  </div>

                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                      <label className="block font-medium">
                        {isBn ? 'কাস্টম মেসেজ টেমপ্লেট (ঐচ্ছিক — খালি রাখলে ডিফল্ট রসিদ যাবে)' : 'Custom SMS Template (Optional)'}
                      </label>
                      {smsConfig.message_template && (
                        <button
                          type="button"
                          onClick={() => setSmsConfig((prev) => ({ ...prev, message_template: '' }))}
                          className="text-[11px] text-amber-600 hover:underline"
                        >
                          {isBn ? 'ডিফল্টে ফিরুন' : 'Reset to Default'}
                        </button>
                      )}
                    </div>
                    <textarea
                      rows={3}
                      value={smsConfig.message_template}
                      onChange={(e) => setSmsConfig((prev) => ({ ...prev, message_template: e.target.value }))}
                      placeholder={
                        isBn
                          ? '{company}: প্রিয় {party}, আপনার ধান ক্রয় #{purchase_no} সম্পন্ন। জাত: {variety}, বস্তা: {bags}টি, ওজন: {payment_kg} কেজি, বিল: ৳{total}, জমা: ৳{paid}, বাকি: ৳{due}।'
                          : '{company}: Dear {party}, purchase #{purchase_no} ({variety}, {bags} bags, {payment_kg} kg) Total BDT {total}, Paid {paid}, Due {due}.'
                      }
                      className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 leading-relaxed"
                    />
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {['{company}', '{party}', '{purchase_no}', '{variety}', '{bags}', '{received_kg}', '{payment_kg}', '{total}', '{paid}', '{due}', '{date}'].map((tok) => (
                        <button
                          key={tok}
                          type="button"
                          onClick={() =>
                            setSmsConfig((prev) => ({
                              ...prev,
                              message_template: prev.message_template ? `${prev.message_template} ${tok}` : tok,
                            }))
                          }
                          className="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-800 hover:bg-amber-100 dark:hover:bg-amber-900/40 font-mono text-[10px] text-slate-700 dark:text-slate-300"
                        >
                          +{tok}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
                    <button
                      type="submit"
                      disabled={savingSms}
                      className="flex items-center gap-1.5 px-5 py-2.5 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-semibold hover:opacity-95 disabled:opacity-50"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>{savingSms ? t('common.saving') : isBn ? 'SMS সেটিংস সংরক্ষণ করুন' : 'Save SMS Settings'}</span>
                    </button>
                  </div>
                </form>

                {/* Right Column: Test SMS Sender & Guidance */}
                <div className="space-y-4">
                  <form
                    onSubmit={handleSendTestSms}
                    className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-3 text-xs"
                  >
                    <h4 className="text-sm font-display font-semibold flex items-center gap-2 text-slate-900 dark:text-white">
                      <Send className="w-4 h-4 text-amber-600" />
                      <span>{isBn ? 'টেস্ট SMS পাঠিয়ে যাচাই করুন' : 'Send Test SMS'}</span>
                    </h4>
                    <div>
                      <label className="block font-medium mb-1">{isBn ? 'প্রাপকের মোবাইল নম্বর *' : 'Test Mobile Number *'}</label>
                      <input
                        type="text"
                        required
                        value={testSmsPhone}
                        onChange={(e) => setTestSmsPhone(e.target.value)}
                        placeholder="017XXXXXXXX"
                        className="w-full px-3 py-2 min-h-[40px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                    <div>
                      <label className="block font-medium mb-1">{isBn ? 'টেস্ট মেসেজ (ঐচ্ছিক)' : 'Custom Test Message (Optional)'}</label>
                      <textarea
                        rows={2}
                        value={testSmsMessage}
                        onChange={(e) => setTestSmsMessage(e.target.value)}
                        placeholder={isBn ? 'খালি রাখলে ডিফল্ট টেস্ট বার্তা যাবে' : 'Leave blank for default test message'}
                        className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    </div>
                    <button
                      type="submit"
                      disabled={sendingTestSms || !smsConfig.enabled || smsConfig.provider === 'NONE'}
                      className="w-full flex items-center justify-center gap-1.5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50"
                    >
                      <Send className="w-3.5 h-3.5" />
                      <span>{sendingTestSms ? (isBn ? 'পাঠানো হচ্ছে...' : 'Sending...') : isBn ? 'টেস্ট SMS পাঠান' : 'Send Test SMS'}</span>
                    </button>
                    {lastTestResult && (
                      <div
                        className={`p-2.5 rounded-lg border text-[11px] ${
                          lastTestResult.ok
                            ? 'bg-emerald-50 border-emerald-200 text-emerald-800 dark:bg-emerald-950/30 dark:border-emerald-900 dark:text-emerald-300'
                            : 'bg-red-50 border-red-200 text-red-800 dark:bg-red-950/30 dark:border-red-900 dark:text-red-300'
                        }`}
                      >
                        <div className="font-semibold">
                          {lastTestResult.status} ({lastTestResult.phone})
                        </div>
                        {lastTestResult.providerResponse && (
                          <div className="mt-0.5 break-all font-mono text-[10px]">{lastTestResult.providerResponse}</div>
                        )}
                      </div>
                    )}
                  </form>

                  <div className="bg-amber-50/70 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50 rounded-xl p-4 text-[11px] text-slate-700 dark:text-slate-300 space-y-1.5">
                    <div className="font-semibold text-amber-900 dark:text-amber-300">
                      {isBn ? 'কিভাবে অটো মেসেজ কাজ করে?' : 'How Auto-Messaging Works'}
                    </div>
                    <p>
                      {isBn
                        ? '১. গেটওয়ে সক্রিয় থাকলে: ধান ক্রয় সেভ করার সাথে সাথে সার্ভার থেকে সরাসরি কাস্টমারের মোবাইলে অটো SMS চলে যাবে।'
                        : '1. With Gateway enabled: saving a paddy purchase automatically dispatches an SMS from the server.'}
                    </p>
                    <p>
                      {isBn
                        ? '২. গেটওয়ে ছাড়াও: ক্রয়ের পর পরই স্ক্রিনে WhatsApp ও ফোন SMS বাটন ভেসে উঠবে যাতে ১ ক্লিকেই রসিদ পাঠানো যায়।'
                        : '2. Zero-config mode: right after purchase, 1-click WhatsApp and native Phone SMS buttons appear.'}
                    </p>
                  </div>
                </div>
              </div>

              {/* SMS Delivery Logs */}
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <div className="text-xs font-semibold text-slate-900 dark:text-white">
                    {isBn ? 'সাম্প্রতিক SMS ও মেসেজ ডেলিভারি লগ' : 'Recent SMS & Messaging Delivery Logs'}
                  </div>
                  <button
                    type="button"
                    onClick={() => void loadTabDetails('messaging')}
                    disabled={loadingSms}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 text-[11px] font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                  >
                    <RefreshCw className={`w-3 h-3 ${loadingSms ? 'animate-spin' : ''}`} />
                    <span>{isBn ? 'রিফ্রেশ' : 'Refresh'}</span>
                  </button>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                        <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'সময় ও রসিদ' : 'Time & Ref'}</th>
                        <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'কাস্টমার / মোবাইল' : 'Party & Phone'}</th>
                        <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'মাধ্যম' : 'Channel'}</th>
                        <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'অবস্থা' : 'Status'}</th>
                        <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'মেসেজ ও রেসপন্স' : 'Message & Gateway Response'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {smsLogs.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                            {isBn ? 'এখনও কোনো SMS বা মেসেজ পাঠানো হয়নি।' : 'No SMS or customer messages dispatched yet.'}
                          </td>
                        </tr>
                      ) : (
                        smsLogs.map((log) => (
                          <tr key={log.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              <div className="font-mono font-medium text-slate-900 dark:text-white">{log.entity_code}</div>
                              <div className="text-[10px] text-slate-500 font-mono">{String(log.created_at || '').slice(0, 19).replace('T', ' ')}</div>
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="font-medium text-slate-800 dark:text-slate-200">{log.party_name || '-'}</div>
                              <div className="text-[11px] font-mono text-slate-500">{log.phone || '—'}</div>
                            </td>
                            <td className="px-4 py-2.5 font-mono text-[11px]">{log.provider}</td>
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                  log.status === 'SENT' || log.status === 'MANUAL_WHATSAPP' || log.status === 'MANUAL_SMS'
                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                                    : log.status === 'FAILED'
                                    ? 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
                                    : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                                }`}
                              >
                                {log.status}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 max-w-md">
                              <div className="text-[11px] text-slate-700 dark:text-slate-300 line-clamp-2">{log.message_body}</div>
                              {log.provider_response && (
                                <div className="text-[10px] font-mono text-slate-400 truncate mt-0.5">{log.provider_response}</div>
                              )}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {subTab === 'employees' && (
        <div className="space-y-4">
          {currentUser.role_code === 'OWNER' && employeesData && (
            <form
              onSubmit={handleAddEmployee}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 grid grid-cols-1 md:grid-cols-6 gap-3 items-end"
            >
              <div>
                <label className="block text-xs font-medium mb-1">{t('adm.fullName')}</label>
                <input
                  type="text"
                  required
                  value={empForm.full_name}
                  onChange={(e) => setEmpForm({ ...empForm, full_name: e.target.value })}
                  className="w-full min-h-[42px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{t('party.email')}</label>
                <input
                  type="email"
                  required
                  value={empForm.email}
                  onChange={(e) => setEmpForm({ ...empForm, email: e.target.value })}
                  className="w-full min-h-[42px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{t('party.phone')}</label>
                <input
                  type="text"
                  value={empForm.phone}
                  onChange={(e) => setEmpForm({ ...empForm, phone: e.target.value })}
                  className="w-full min-h-[42px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{t('login.password')}</label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={empForm.password}
                  onChange={(e) => setEmpForm({ ...empForm, password: e.target.value })}
                  className="w-full min-h-[42px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{t('adm.role')}</label>
                <select
                  value={empForm.role_id}
                  onChange={(e) => setEmpForm({ ...empForm, role_id: Number(e.target.value) })}
                  className="w-full min-h-[42px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {employeesData.roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit" className="min-h-[42px] flex items-center justify-center gap-1.5 py-2 px-4 rounded-lg bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0">
                <Plus className="w-3.5 h-3.5" /> {t('adm.addEmployee')}
              </button>
            </form>
          )}

          {employeesData && (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 text-xs font-semibold">
                <Users className="w-4 h-4 text-slate-500" />
                <span>{t('adm.empAccounts')}</span>
              </div>
              {/* Mobile Cards */}
              <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
                {employeesData.employees.map((emp) => (
                  <div key={emp.id} className="p-4 space-y-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-semibold text-slate-900 dark:text-white">{emp.full_name}</div>
                        <div className="font-mono text-[11px] text-slate-500">{emp.employee_code} · {emp.email}</div>
                      </div>
                      <span className={`font-mono text-[11px] font-medium ${emp.is_active ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-400'}`}>
                        {emp.is_active ? t('common.active') : t('common.inactive')}
                      </span>
                    </div>
                    <div className="flex items-center justify-between pt-1">
                      <span className="text-slate-600 dark:text-slate-300">{emp.role_name}</span>
                      {currentUser.role_code === 'OWNER' && (
                        <button
                          type="button"
                          onClick={() => openEditEmployee(emp)}
                          className="min-h-[38px] inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                          <span>{isBn ? 'এডিট / পাসওয়ার্ড' : 'Edit / Password'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {/* Desktop Table */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                      <th className="text-left px-4 py-3 font-medium">{t('party.code')}</th>
                      <th className="text-left px-4 py-3 font-medium">{t('adm.fullName')}</th>
                      <th className="text-left px-4 py-3 font-medium">{t('party.email')}</th>
                      <th className="text-left px-4 py-3 font-medium">{t('adm.role')}</th>
                      <th className="text-left px-4 py-3 font-medium">{t('common.status')}</th>
                      {currentUser.role_code === 'OWNER' && (
                        <th className="text-right px-4 py-3 font-medium">{t('common.actions')}</th>
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {employeesData.employees.map((emp) => (
                      <tr key={emp.id}>
                        <td className="px-4 py-3 font-mono font-medium">{emp.employee_code}</td>
                        <td className="px-4 py-3 font-medium">{emp.full_name}</td>
                        <td className="px-4 py-3 font-mono text-slate-500">{emp.email}</td>
                        <td className="px-4 py-3">{emp.role_name}</td>
                        <td className={`px-4 py-3 font-mono ${emp.is_active ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-400'}`}>
                          {emp.is_active ? t('common.active') : t('common.inactive')}
                        </td>
                        {currentUser.role_code === 'OWNER' && (
                          <td className="px-4 py-3 text-right">
                            <button
                              type="button"
                              onClick={() => openEditEmployee(emp)}
                              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium whitespace-nowrap"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                              <span>{isBn ? 'এডিট / পাসওয়ার্ড' : 'Edit / Password'}</span>
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {subTab === 'audit' && auditData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center gap-2 text-xs font-semibold">
              <ShieldAlert className="w-4 h-4 text-amber-600" />
              <span>{t('adm.auditTrail')}</span>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[480px] overflow-y-auto">
              {auditData.audit_logs.map((log) => (
                <div key={log.id} className="p-3.5 text-xs space-y-1">
                  <div className="flex justify-between font-medium">
                    <span className="font-mono text-slate-900 dark:text-white">{log.action}</span>
                    <span className="font-mono text-slate-500">{log.created_at}</span>
                  </div>
                  <div className="text-slate-600 dark:text-slate-400">
                    {log.employee_name} · {log.entity_type} ({log.entity_id})
                  </div>
                  {log.after_json && (
                    <pre className="text-[11px] font-mono bg-slate-50 dark:bg-slate-950 p-2 rounded overflow-x-auto text-slate-600 dark:text-slate-400">
                      {log.after_json}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold">
              {t('adm.syncLog')}
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-[480px] overflow-y-auto">
              {auditData.sync_logs.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">{t('adm.noSync')}</div>
              ) : (
                auditData.sync_logs.map((s) => (
                  <div key={s.id} className="p-3.5 text-xs space-y-1">
                    <div className="flex justify-between font-medium">
                      <span className="font-mono">{s.endpoint}</span>
                      <span className={s.status === 'CONFLICT' ? 'text-red-600 font-mono' : 'text-emerald-700 font-mono'}>
                        {s.status}
                      </span>
                    </div>
                    <div className="text-slate-500 font-mono text-[11px]">
                      {s.client_type} · {s.employee_name} · UUID {s.client_uuid.slice(0, 12)}...
                    </div>
                    {s.conflict_reason && <div className="text-red-600 text-[11px]">{s.conflict_reason}</div>}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {subTab === 'backup' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <DatabaseBackup className="w-4 h-4 text-amber-600" />
                <h3 className="text-sm font-display font-semibold">{t('adm.backupHistory')}</h3>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={restoreInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={handleRestoreFileChange}
                  className="hidden"
                />
                {currentUser.role_code === 'OWNER' && (
                  <button
                    type="button"
                    onClick={() => restoreInputRef.current?.click()}
                    disabled={restoringBackup}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-800 dark:text-slate-100 text-xs font-medium whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>{isBn ? 'ব্যাকআপ রিস্টোর (.json)' : 'Restore Backup (.json)'}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={handleExportBackup}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>{t('adm.downloadBackup')}</span>
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-100 dark:divide-slate-800 text-xs">
              {backups.length === 0 ? (
                <div className="py-6 text-center text-slate-500">{t('adm.noBackups')}</div>
              ) : (
                backups.map((b) => (
                  <div key={b.id} className="py-2.5 flex justify-between">
                    <div>
                      <div className="font-mono font-medium">{b.backup_name}</div>
                      <div className="text-slate-500">
                        {b.created_by_name} · {b.created_at}
                      </div>
                    </div>
                    <div className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                      {(b.file_size_bytes / 1024).toFixed(1)} KB
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 text-xs">
            <div className="flex items-center gap-2">
              <Trash2 className="w-4 h-4 text-red-600" />
              <h3 className="text-sm font-display font-semibold">{t('adm.clearDataTitle')}</h3>
            </div>
            {currentUser.role_code === 'OWNER' ? (
              <div className="space-y-3 pt-1">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <button
                    onClick={() => setClearConfirmScope('TRANSACTIONS_ONLY')}
                    disabled={clearingData}
                    className="px-4 py-2.5 rounded-lg border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/30 font-medium text-left disabled:opacity-50"
                  >
                    <div className="font-semibold">{t('adm.clearTxTitle')}</div>
                  </button>
                  <button
                    onClick={() => setClearConfirmScope('ALL_DATA')}
                    disabled={clearingData}
                    className="px-4 py-2.5 rounded-lg bg-red-600 hover:bg-red-700 text-white font-medium text-left disabled:opacity-50"
                  >
                    <div className="font-semibold">{t('adm.clearAllTitle')}</div>
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-slate-500">{t('adm.ownerOnly')}</div>
            )}
          </div>
        </div>
      )}

      {/* Confirm Restore Backup Modal */}
      {pendingRestore && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h4 className="text-sm font-display font-semibold text-amber-700 dark:text-amber-400">
              {isBn ? 'ব্যাকআপ রিস্টোর নিশ্চিত করুন' : 'Confirm Backup Restore'}
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {isBn
                ? `ফাইল "${pendingRestore.fileName}" থেকে মোট ${pendingRestore.totalRows}টি রেকর্ড বর্তমান ডাটাবেসে রিস্টোর করা হবে। এতে বর্তমান ডাটা ব্যাকআপের তথ্য দিয়ে প্রতিস্থাপিত হবে।`
                : `Restore ${pendingRestore.totalRows} records from "${pendingRestore.fileName}"? Current database records will be replaced with the backup snapshot.`}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingRestore(null)}
                disabled={restoringBackup}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmRestore}
                disabled={restoringBackup}
                className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50"
              >
                {restoringBackup ? (isBn ? 'রিস্টোর হচ্ছে...' : 'Restoring...') : isBn ? 'হ্যাঁ, রিস্টোর করুন' : 'Yes, Restore'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm Clear Data Modal */}
      {clearConfirmScope && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-md w-full p-6 space-y-4">
            <h4 className="text-sm font-display font-semibold text-red-600 dark:text-red-400">
              {clearConfirmScope === 'ALL_DATA' ? t('adm.confirmClearAll') : t('adm.confirmClearTx')}
            </h4>
            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
              {clearConfirmScope === 'ALL_DATA'
                ? isBn
                  ? 'এটি সকল ধান ক্রয়, স্টক লট, স্টক লেজার, স্থানান্তর, শুকানো/মিলিং ব্যাচ, বিক্রয় চালান, ওয়েব্রিজ লগ, পেমেন্ট, জার্নাল, কাস্টমার/সাপ্লায়ার, গুদাম, পণ্য, একক, ক্যাটাগরি এবং অফলাইন ক্যাশ স্থায়ীভাবে মুছে ফেলবে। কর্মচারী লগইন অক্ষুণ্ণ থাকবে।'
                  : 'This will permanently delete all paddy purchases, inventory lots, stock ledger, transfers, drying/milling batches, sales invoices, weighbridge logs, payments, journals, parties, warehouses, products, units, and categories, plus local browser cache. Employee logins remain intact.'
                : isBn
                ? 'এটি সকল লেনদেন লেজার, স্টক লট, ক্রয়, উৎপাদন ব্যাচ, বিক্রয়, ওয়েব্রিজ লগ মুছবে এবং পার্টি ও অ্যাকাউন্ট ব্যালেন্স ৳০ করবে; তবে আপনার মাস্টার ক্যাটালগ ও কোম্পানির তথ্য অক্ষুণ্ণ থাকবে।'
                : 'This will permanently delete all transactional ledgers, inventory lots, purchases, production batches, sales, weighbridge logs, and reset account/party balances to ৳0 while keeping your master catalogs and company settings.'}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setClearConfirmScope(null)}
                disabled={clearingData}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleClearAllData}
                disabled={clearingData}
                className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-medium disabled:opacity-50"
              >
                {clearingData ? t('adm.clearing') : t('adm.yesClear')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Employee & Reset Password Modal */}
      {editingEmployee && employeesData && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
          <form
            onSubmit={handleUpdateEmployee}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-md w-full p-5 space-y-4 max-h-[92vh] overflow-y-auto"
          >
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div>
                <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  {isBn ? 'কর্মচারী তথ্য ও পাসওয়ার্ড এডিট' : 'Edit Employee & Password'}
                </h4>
                <div className="text-[11px] font-mono text-slate-500">{editingEmployee.employee_code}</div>
              </div>
              <button
                type="button"
                onClick={() => setEditingEmployee(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="space-y-3 text-xs">
              <div>
                <label className="block font-medium mb-1">{t('adm.fullName')}</label>
                <input
                  type="text"
                  required
                  value={editEmpForm.full_name}
                  onChange={(e) => setEditEmpForm({ ...editEmpForm, full_name: e.target.value })}
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium mb-1">{t('party.email')}</label>
                  <input
                    type="email"
                    required
                    value={editEmpForm.email}
                    onChange={(e) => setEditEmpForm({ ...editEmpForm, email: e.target.value })}
                    className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">{t('party.phone')}</label>
                  <input
                    type="text"
                    value={editEmpForm.phone}
                    onChange={(e) => setEditEmpForm({ ...editEmpForm, phone: e.target.value })}
                    className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium mb-1">{t('adm.role')}</label>
                  <select
                    value={editEmpForm.role_id}
                    onChange={(e) => setEditEmpForm({ ...editEmpForm, role_id: Number(e.target.value) })}
                    className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {employeesData.roles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end pb-2">
                  <label className="flex items-center gap-2 font-medium cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={editEmpForm.is_active}
                      onChange={(e) => setEditEmpForm({ ...editEmpForm, is_active: e.target.checked })}
                      className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                    />
                    <span>{t('common.active')}</span>
                  </label>
                </div>
              </div>
              <div>
                <label className="block font-medium mb-1">
                  {isBn ? 'নতুন পাসওয়ার্ড (পরিবর্তন করতে চাইলে লিখুন)' : 'New Password (leave blank to keep current)'}
                </label>
                <input
                  type="password"
                  minLength={6}
                  value={editEmpForm.password}
                  onChange={(e) => setEditEmpForm({ ...editEmpForm, password: e.target.value })}
                  className="w-full min-h-[42px] px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingEmployee(null)}
                className="min-h-[42px] px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={savingEmpEdit}
                className="min-h-[42px] px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50"
              >
                {savingEmpEdit ? t('common.saving') : t('common.saveChanges')}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

const ReportCard: React.FC<{
  title: string;
  description: string;
  countText: string;
  pdfEnLabel: string;
  pdfBnLabel: string;
  excelEnLabel: string;
  excelBnLabel: string;
  onPdfEn: () => void;
  onPdfBn: () => void;
  onExcelEn: () => void;
  onExcelBn: () => void;
}> = ({
  title,
  description,
  countText,
  pdfEnLabel,
  pdfBnLabel,
  excelEnLabel,
  excelBnLabel,
  onPdfEn,
  onPdfBn,
  onExcelEn,
  onExcelBn,
}) => (
  <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4">
    <div>
      <div className="text-xs font-mono font-semibold text-amber-700 dark:text-amber-400 mb-1">{countText}</div>
      <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">{title}</h3>
      <p className="text-xs text-slate-600 dark:text-slate-300 mt-1.5 leading-relaxed">{description}</p>
    </div>
    <div className="grid grid-cols-2 gap-2">
      <button
        onClick={onPdfEn}
        className="flex items-center justify-center gap-1 py-2 px-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
      >
        <FileText className="w-3.5 h-3.5" /> {pdfEnLabel}
      </button>
      <button
        onClick={onPdfBn}
        className="flex items-center justify-center gap-1 py-2 px-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
      >
        <FileText className="w-3.5 h-3.5" /> {pdfBnLabel}
      </button>
      <button
        onClick={onExcelEn}
        className="flex items-center justify-center gap-1 py-2 px-2 rounded-lg bg-slate-900 dark:bg-slate-800 text-white text-xs font-medium hover:opacity-95 whitespace-nowrap shrink-0"
      >
        <FileSpreadsheet className="w-3.5 h-3.5" /> {excelEnLabel}
      </button>
      <button
        onClick={onExcelBn}
        className="flex items-center justify-center gap-1 py-2 px-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium whitespace-nowrap shrink-0"
      >
        <FileSpreadsheet className="w-3.5 h-3.5" /> {excelBnLabel}
      </button>
    </div>
  </div>
);
