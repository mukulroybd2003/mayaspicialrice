import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart3,
  BookOpen,
  Boxes,
  Building2,
  CheckCircle2,
  Factory,
  KeyRound,
  Layers,
  LogOut,
  Menu,
  Moon,
  Package,
  RefreshCw,
  Ruler,
  Scale,
  Settings,
  ShoppingBag,
  ShoppingCart,
  Sun,
  Truck,
  UserCheck,
  Users,
  Warehouse as WarehouseIcon,
  WifiOff,
  X,
} from 'lucide-react';
import { AccountingPartiesModule } from './components/AccountingPartiesModule';
import { AdminReportsModule, type AdminSubTab } from './components/AdminReportsModule';
import { DashboardModule } from './components/DashboardModule';
import { InventoryModule } from './components/InventoryModule';
import { LoginView } from './components/LoginView';
import { PartiesDirectoryPage } from './components/PartiesDirectoryPage';
import { ProcurementModule } from './components/ProcurementModule';
import { ProductCategoriesPage } from './components/ProductCategoriesPage';
import { ProductionModule } from './components/ProductionModule';
import { ProductsPage } from './components/ProductsPage';
import { ProductUnitsPage } from './components/ProductUnitsPage';
import { OfflineIndicator, PWAInstallButton, SyncQueueDrawer } from './components/PWAControls';
import { SalesModule } from './components/SalesModule';
import { SupplierBagLedgerPanel } from './components/SupplierBagLedgerPanel';
import { WarehousesPage } from './components/WarehousesPage';
import { WeighbridgeQrModule } from './components/WeighbridgeQrModule';
import { useOnlineStatus } from './hooks/usePWAInstall';
import { useI18n } from './i18n/I18nContext';
import { getActiveCompanySettings, setActiveCompanySettings } from './utils/companySettings';
import { isPaddyItem } from './utils/itemFilters';
import { StatusBar, Style } from '@capacitor/status-bar';
import {
  ApiError,
  apiGet,
  clearStoredSession,
  getClientType,
  getStoredToken,
  getStoredUser,
  isNativeAndroid,
  resolveApiUrl,
  syncPendingMutations,
} from './services/api';
import { clearKvCache, clearOfflineStorage, getQueuedMutations, removeMutation } from './services/offlineDb';
import type {
  Account,
  ChatalBatch,
  CompanySettings,
  DashboardSummary,
  DirectPaddySale,
  DryingBatch,
  EmployeeUser,
  InventoryLot,
  ItemMaster,
  JournalEntry,
  OfflineMutation,
  PaddyPurchase,
  Party,
  PaymentRecord,
  ProductCategory,
  ProductionBatch,
  ProductUnit,
  SalesInvoice,
  StockLedgerEntry,
  StockTransfer,
  Warehouse,
  WeighbridgeLog,
} from './types/erp';

type NavKey =
  | 'dashboard'
  | 'procurement'
  | 'bags'
  | 'inventory'
  | 'warehouses'
  | 'units'
  | 'categories'
  | 'products'
  | 'production'
  | 'sales'
  | 'weighbridge'
  | 'customers'
  | 'suppliers'
  | 'accounting'
  | 'admin';

const NAV_ITEMS: Array<{ key: NavKey; labelKey: string; icon: React.ComponentType<{ className?: string }> }> = [
  { key: 'dashboard', labelKey: 'nav.dashboard', icon: BarChart3 },
  { key: 'procurement', labelKey: 'nav.procurement', icon: Truck },
  { key: 'bags', labelKey: 'nav.bags', icon: ShoppingBag },
  { key: 'inventory', labelKey: 'nav.inventory', icon: Boxes },
  { key: 'warehouses', labelKey: 'nav.warehouses', icon: WarehouseIcon },
  { key: 'units', labelKey: 'nav.units', icon: Ruler },
  { key: 'categories', labelKey: 'nav.categories', icon: Layers },
  { key: 'products', labelKey: 'nav.products', icon: Package },
  { key: 'production', labelKey: 'nav.production', icon: Factory },
  { key: 'sales', labelKey: 'nav.sales', icon: ShoppingCart },
  { key: 'weighbridge', labelKey: 'nav.weighbridge', icon: Scale },
  { key: 'customers', labelKey: 'nav.customers', icon: Users },
  { key: 'suppliers', labelKey: 'nav.suppliers', icon: UserCheck },
  { key: 'accounting', labelKey: 'nav.accounting', icon: BookOpen },
  { key: 'admin', labelKey: 'nav.admin', icon: Settings },
];

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, message: error?.message || 'Unexpected rendering error' };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-6">
          <div className="max-w-md w-full bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 text-center">
            <h2 className="text-base font-display font-semibold text-red-600 dark:text-red-400">
              Something went wrong / ডিসপ্লে ত্রুটি
            </h2>
            <p className="text-xs text-slate-600 dark:text-slate-400 font-mono break-words">
              {this.state.message}
            </p>
            <div className="flex justify-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  await clearOfflineStorage();
                  window.location.reload();
                }}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium"
              >
                Clear Cache & Reload
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const { lang, setLang, t } = useI18n();
  const [user, setUser] = useState<EmployeeUser | null>(() => {
    const tok = getStoredToken();
    const u = getStoredUser<EmployeeUser>();
    if (!tok || !u) {
      clearStoredSession();
      return null;
    }
    return u;
  });
  const [activeTab, setActiveTab] = useState<NavKey>('dashboard');
  const [adminSubTab, setAdminSubTab] = useState<AdminSubTab | undefined>(undefined);
  const [productionNavTarget, setProductionNavTarget] = useState<{
    subTab: 'milling' | 'chatal' | 'drying';
    dryingView?: 'all' | 'active' | 'history';
    key: number;
  } | null>(null);
  const [companySettings, setCompanySettings] = useState<CompanySettings>(() => getActiveCompanySettings());
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(false);

  const isOnline = useOnlineStatus();
  const [syncQueue, setSyncQueue] = useState<OfflineMutation[]>([]);
  const [syncDrawerOpen, setSyncDrawerOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [toast, setToast] = useState<{ msg: string; tone: 'ok' | 'warn' | 'err' } | null>(null);
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [pwdForm, setPwdForm] = useState({ current_password: '', new_password: '', confirm_password: '' });
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdError, setPwdError] = useState('');

  // ERP State
  const [loading, setLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [units, setUnits] = useState<ProductUnit[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [items, setItems] = useState<ItemMaster[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [lots, setLots] = useState<InventoryLot[]>([]);
  const [stockLedger, setStockLedger] = useState<StockLedgerEntry[]>([]);
  const [purchases, setPurchases] = useState<PaddyPurchase[]>([]);
  const [transfers, setTransfers] = useState<StockTransfer[]>([]);
  const [dryingBatches, setDryingBatches] = useState<DryingBatch[]>([]);
  const [chatalBatches, setChatalBatches] = useState<ChatalBatch[]>([]);
  const [batches, setBatches] = useState<ProductionBatch[]>([]);
  const [invoices, setInvoices] = useState<SalesInvoice[]>([]);
  const [paddySales, setPaddySales] = useState<DirectPaddySale[]>([]);
  const [weighLogs, setWeighLogs] = useState<WeighbridgeLog[]>([]);
  const [payments, setPayments] = useState<PaymentRecord[]>([]);
  const [journalEntries, setJournalEntries] = useState<JournalEntry[]>([]);

  const toastTimerRef = useRef<number | null>(null);
  const prevOnlineRef = useRef<boolean>(isOnline);

  const notify = useCallback((msg: string, tone: 'ok' | 'warn' | 'err' = 'ok', durationMs = 4500) => {
    setToast({ msg, tone });
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // Notify immediately when switching between online and offline states
  useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    prevOnlineRef.current = isOnline;
    if (wasOnline === isOnline) return;

    if (!isOnline) {
      notify(
        lang === 'bn'
          ? 'অফলাইন মোড চালু হয়েছে: নতুন এন্ট্রি লোকালভাবে সেভ হবে এবং ইন্টারনেট ফিরলেই স্বয়ংক্রিয়ভাবে সিঙ্ক হবে।'
          : 'Offline Mode: You are now offline. Changes are saved locally and will sync automatically when connectivity returns.',
        'warn',
        7000
      );
    } else {
      notify(
        lang === 'bn'
          ? 'ইন্টারনেট সংযোগ ফিরে এসেছে: অপেক্ষমাণ অফলাইন এন্ট্রি স্বয়ংক্রিয়ভাবে সিঙ্ক হচ্ছে।'
          : 'Back Online: Connectivity restored. Pending offline changes will sync automatically.',
        'ok',
        4500
      );
    }
  }, [isOnline, lang, notify]);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwdError('');
    if (pwdForm.new_password.length < 6) {
      setPwdError(lang === 'bn' ? 'নতুন পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে।' : 'New password must be at least 6 characters.');
      return;
    }
    if (pwdForm.new_password !== pwdForm.confirm_password) {
      setPwdError(lang === 'bn' ? 'নতুন পাসওয়ার্ড দুটি মেলেনি।' : 'New passwords do not match.');
      return;
    }
    setPwdSaving(true);
    try {
      const res = await fetch(resolveApiUrl('/api/v1/auth/change-password'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Type': getClientType(),
          Authorization: `Bearer ${getStoredToken()}`,
        },
        body: JSON.stringify({
          current_password: pwdForm.current_password,
          new_password: pwdForm.new_password,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to change password');
      }
      setShowPwdModal(false);
      setPwdForm({ current_password: '', new_password: '', confirm_password: '' });
      notify(lang === 'bn' ? 'পাসওয়ার্ড সফলভাবে পরিবর্তন হয়েছে।' : 'Password changed successfully.', 'ok');
    } catch (err) {
      setPwdError((err as Error).message);
    } finally {
      setPwdSaving(false);
    }
  };

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    if (isNativeAndroid()) {
      void StatusBar.setStyle({ style: Style.Dark }).catch(() => {});
      void StatusBar.setBackgroundColor({ color: '#0F172A' }).catch(() => {});
      void StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
    }
  }, [darkMode]);

  useEffect(() => {
    fetch(resolveApiUrl('/api/v1/company-settings'), {
      headers: { 'X-Client-Type': getClientType() },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.company) {
          setCompanySettings(setActiveCompanySettings(d.company));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setActiveCompanySettings(companySettings);
  }, [lang, companySettings]);

  const refreshQueue = useCallback(async () => {
    const q = await getQueuedMutations();
    setSyncQueue(q);
  }, []);

  const isGodownKeeper = user?.role_code === 'GODOWN_KEEPER';
  const allowedNavKeys: NavKey[] = isGodownKeeper
    ? ['dashboard', 'procurement', 'bags', 'inventory', 'weighbridge']
    : NAV_ITEMS.map((n) => n.key);
  const visibleNavItems = NAV_ITEMS.filter((n) => allowedNavKeys.includes(n.key));

  useEffect(() => {
    if (user && !allowedNavKeys.includes(activeTab)) {
      setActiveTab('dashboard');
    }
  }, [user, activeTab, isGodownKeeper]);

  const getNavLabel = (key: NavKey, defaultLabelKey: string) => {
    if (isGodownKeeper && key === 'procurement') {
      return lang === 'bn' ? 'ধান গ্রহণ ও ওজন' : 'Paddy Intake';
    }
    return t(defaultLabelKey);
  };

  const loadAllData = useCallback(async () => {
    const currentUser = getStoredUser<EmployeeUser>();
    if (!getStoredToken() || !currentUser) {
      clearStoredSession();
      setUser(null);
      return;
    }
    const physicalOnly = currentUser.role_code === 'GODOWN_KEEPER';
    setLoading(true);
    setDashboardError(null);
    try {
      const results = await Promise.allSettled([
        apiGet<DashboardSummary>('/api/v1/dashboard', 'cache_dashboard'),
        apiGet<{
          warehouses: Warehouse[];
          units?: ProductUnit[];
          categories?: ProductCategory[];
          items: ItemMaster[];
          parties: Party[];
          accounts: Account[];
          company_settings?: CompanySettings;
        }>('/api/v1/master', 'cache_master'),
        apiGet<{ lots: InventoryLot[] }>('/api/v1/inventory/lots', 'cache_lots'),
        apiGet<{ ledger: StockLedgerEntry[] }>('/api/v1/inventory/ledger', 'cache_ledger'),
        apiGet<{ purchases: PaddyPurchase[] }>('/api/v1/paddy-purchases', 'cache_purchases'),
        apiGet<{ transfers: StockTransfer[] }>('/api/v1/stock-transfers', 'cache_transfers'),
        physicalOnly
          ? Promise.resolve({ drying_batches: [] as DryingBatch[] })
          : apiGet<{ drying_batches: DryingBatch[] }>('/api/v1/drying-batches', 'cache_drying'),
        physicalOnly
          ? Promise.resolve({ batches: [] as ProductionBatch[] })
          : apiGet<{ batches: ProductionBatch[] }>('/api/v1/production-batches', 'cache_batches'),
        physicalOnly
          ? Promise.resolve({ invoices: [] as SalesInvoice[] })
          : apiGet<{ invoices: SalesInvoice[] }>('/api/v1/sales-invoices', 'cache_invoices'),
        physicalOnly
          ? Promise.resolve({ sales: [] as DirectPaddySale[] })
          : apiGet<{ sales: DirectPaddySale[] }>('/api/v1/paddy-sales', 'cache_paddy_sales'),
        apiGet<{ logs: WeighbridgeLog[] }>('/api/v1/weighbridge-logs', 'cache_weighbridge'),
        physicalOnly
          ? Promise.resolve({ chatal_batches: [] as ChatalBatch[] })
          : apiGet<{ chatal_batches: ChatalBatch[] }>('/api/v1/chatal-batches', 'cache_chatal'),
      ]);

      const authRejected = results.find(
        (r) =>
          r.status === 'rejected' &&
          ((r.reason instanceof ApiError && r.reason.status === 401) ||
            String(r.reason?.message || '').includes('401') ||
            String(r.reason?.message || '').toLowerCase().includes('token') ||
            String(r.reason?.message || '').toLowerCase().includes('inactive'))
      );
      if (authRejected) {
        clearStoredSession();
        setUser(null);
        return;
      }

      const [dashRes, masterRes, lotsRes, ledgerRes, purRes, trfRes, dryRes, batRes, invRes, psRes, wbRes, chtRes] = results;

      if (dashRes.status === 'fulfilled') {
        setDashboard(dashRes.value);
      } else {
        setDashboardError((dashRes.reason as Error)?.message || 'Failed to load dashboard');
      }
      if (masterRes.status === 'fulfilled') {
        setWarehouses(masterRes.value.warehouses || []);
        setUnits(masterRes.value.units || []);
        setCategories(masterRes.value.categories || []);
        setItems(masterRes.value.items || []);
        setParties(masterRes.value.parties || []);
        setAccounts(masterRes.value.accounts || []);
        if (masterRes.value.company_settings) {
          setCompanySettings(setActiveCompanySettings(masterRes.value.company_settings));
        }
      }
      if (lotsRes.status === 'fulfilled') setLots(lotsRes.value.lots || []);
      if (ledgerRes.status === 'fulfilled') setStockLedger(ledgerRes.value.ledger || []);
      if (purRes.status === 'fulfilled') setPurchases(purRes.value.purchases || []);
      if (trfRes.status === 'fulfilled') setTransfers(trfRes.value.transfers || []);
      if (dryRes.status === 'fulfilled') setDryingBatches(dryRes.value.drying_batches || []);
      if (batRes.status === 'fulfilled') setBatches(batRes.value.batches || []);
      if (invRes.status === 'fulfilled') setInvoices(invRes.value.invoices || []);
      if (psRes.status === 'fulfilled') setPaddySales(psRes.value.sales || []);
      if (wbRes.status === 'fulfilled') setWeighLogs(wbRes.value.logs || []);
      if (chtRes.status === 'fulfilled') setChatalBatches(chtRes.value.chatal_batches || []);

      if (physicalOnly) {
        setAccounts([]);
        setPayments([]);
        setJournalEntries([]);
      } else {
        // Accounting endpoint requires accounting.view permission
        apiGet<{ accounts: Account[]; payments: PaymentRecord[]; journal_entries: JournalEntry[] }>(
          '/api/v1/accounting',
          'cache_accounting'
        )
          .then((accRes) => {
            setAccounts(accRes.accounts || []);
            setPayments(accRes.payments || []);
            setJournalEntries(accRes.journal_entries || []);
          })
          .catch(() => {});
      }
    } catch (err) {
      const msg = (err as Error).message;
      if ((err instanceof ApiError && err.status === 401) || msg.includes('401') || msg.toLowerCase().includes('token')) {
        clearStoredSession();
        setUser(null);
      } else {
        setDashboardError(msg);
        notify(msg, 'err');
      }
    } finally {
      setLoading(false);
      refreshQueue();
    }
  }, [notify, refreshQueue]);

  useEffect(() => {
    if (user) {
      loadAllData();
    }
  }, [user, loadAllData]);

  // Automatic Background Synchronization when connectivity returns
  const handleSyncNow = useCallback(async () => {
    setSyncing(true);
    try {
      const res = await syncPendingMutations();
      await refreshQueue();
      if (res.synced > 0) {
        notify(
          lang === 'bn'
            ? `${res.synced}টি অফলাইন লেনদেন সিঙ্ক করা হয়েছে।`
            : `Synchronized ${res.synced} offline transaction(s).`,
          'ok'
        );
        loadAllData();
      }
      if (res.conflicts > 0) {
        notify(
          lang === 'bn'
            ? `${res.conflicts}টি সিঙ্ক কনফ্লিক্ট পাওয়া গেছে। সিঙ্ক কিউ দেখুন।`
            : `${res.conflicts} sync conflict(s) detected. Review Sync Queue.`,
          'err'
        );
      }
    } finally {
      setSyncing(false);
    }
  }, [lang, loadAllData, notify, refreshQueue]);

  useEffect(() => {
    if (isOnline && user && syncQueue.some((q) => q.status === 'PENDING')) {
      handleSyncNow();
    }
  }, [isOnline, user, syncQueue, handleSyncNow]);

  const handleLogout = async () => {
    await clearKvCache();
    clearStoredSession();
    setDashboard(null);
    setPurchases([]);
    setBatches([]);
    setDryingBatches([]);
    setInvoices([]);
    setPaddySales([]);
    setAccounts([]);
    setPayments([]);
    setJournalEntries([]);
    setUser(null);
  };

  if (!user) {
    return (
      <LoginView
        company={companySettings}
        onLoginSuccess={(u) => {
          void clearKvCache();
          setActiveTab('dashboard');
          setUser(u);
        }}
      />
    );
  }

  const companyDisplayName = lang === 'bn' ? companySettings.company_name_bn : companySettings.company_name_en;
  const companyDisplayAddress = lang === 'bn' ? companySettings.address_bn : companySettings.address_en;
  const activeItem = visibleNavItems.find((n) => n.key === activeTab) || visibleNavItems[0];
  const activeNavLabel = activeItem ? getNavLabel(activeItem.key, activeItem.labelKey) : t('nav.dashboard');

  const mobileBottomNav: Array<{ key: NavKey | 'MENU'; icon: React.ComponentType<{ className?: string }>; label: string }> =
    isGodownKeeper
      ? [
          { key: 'dashboard', icon: BarChart3, label: lang === 'bn' ? 'হোম' : 'Home' },
          { key: 'procurement', icon: Truck, label: lang === 'bn' ? 'ধান গ্রহণ' : 'Intake' },
          { key: 'bags', icon: ShoppingBag, label: lang === 'bn' ? 'বস্তা' : 'Bags' },
          { key: 'inventory', icon: Boxes, label: lang === 'bn' ? 'স্টক' : 'Stock' },
          { key: 'weighbridge', icon: Scale, label: lang === 'bn' ? 'স্কেল/QR' : 'Scale' },
        ]
      : [
          { key: 'dashboard', icon: BarChart3, label: lang === 'bn' ? 'হোম' : 'Home' },
          { key: 'procurement', icon: Truck, label: lang === 'bn' ? 'ক্রয়' : 'Buy' },
          { key: 'inventory', icon: Boxes, label: lang === 'bn' ? 'মজুদ' : 'Stock' },
          { key: 'production', icon: Factory, label: lang === 'bn' ? 'ক্রাশিং' : 'Mill' },
          { key: 'MENU', icon: Menu, label: lang === 'bn' ? 'মেনু' : 'Menu' },
        ];

  return (
    <AppErrorBoundary>
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-64 shrink-0 flex-col bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800">
        <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3">
          {companySettings.logo_data_url ? (
            <img
              src={companySettings.logo_data_url}
              alt={companyDisplayName || 'Logo'}
              className="w-8 h-8 rounded-lg bg-white border border-slate-200 dark:border-slate-700 object-contain p-0.5 shrink-0"
            />
          ) : (
            <div className="w-8 h-8 rounded-lg bg-slate-900 dark:bg-amber-600 flex items-center justify-center text-amber-400 dark:text-white font-display font-bold text-xs shrink-0">
              {companySettings.short_code || 'SG'}
            </div>
          )}
          <div className="min-w-0">
            <div className="font-display font-bold text-sm tracking-tight truncate">
              {companyDisplayName || t('app.brand')}
            </div>
            {companyDisplayAddress && (
              <div className="text-[10px] text-slate-400 truncate">{companyDisplayAddress}</div>
            )}
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {visibleNavItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.key;
            return (
              <button
                key={item.key}
                onClick={() => setActiveTab(item.key)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors ${
                  active
                    ? 'bg-slate-900 text-white dark:bg-amber-600 dark:text-white'
                    : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="whitespace-nowrap truncate">{getNavLabel(item.key, item.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5 text-xs">
          <div>
            <div className="font-medium text-slate-900 dark:text-white">{user.full_name}</div>
            <div className="text-slate-500">{user.role_name} · {user.employee_code}</div>
          </div>
          <button
            type="button"
            onClick={() => {
              setPwdError('');
              setPwdForm({ current_password: '', new_password: '', confirm_password: '' });
              setShowPwdModal(true);
            }}
            className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 whitespace-nowrap"
          >
            <KeyRound className="w-3.5 h-3.5 shrink-0" />
            <span>{lang === 'bn' ? 'পাসওয়ার্ড পরিবর্তন' : 'Change Password'}</span>
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              {darkMode ? <Sun className="w-3.5 h-3.5 shrink-0" /> : <Moon className="w-3.5 h-3.5 shrink-0" />}
              <span>{darkMode ? t('common.light') : t('common.dark')}</span>
            </button>
            <button
              onClick={handleLogout}
              className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-slate-200 dark:border-slate-800 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 whitespace-nowrap"
            >
              <LogOut className="w-3.5 h-3.5 shrink-0" />
              <span>{t('common.signOut')}</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="w-72 max-w-[82vw] bg-white dark:bg-slate-900 h-full border-r border-slate-200 dark:border-slate-800 flex flex-col shadow-xl">
            <div className="px-4 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                {companySettings.logo_data_url && (
                  <img
                    src={companySettings.logo_data_url}
                    alt={companyDisplayName || 'Logo'}
                    className="w-8 h-8 rounded-lg bg-white border border-slate-200 dark:border-slate-700 object-contain p-0.5 shrink-0"
                  />
                )}
                <div className="min-w-0">
                  <div className="font-display font-bold text-sm truncate">{companyDisplayName || t('app.brand')}</div>
                  <div className="text-[11px] text-slate-500 truncate">{user.full_name} · {user.role_name}</div>
                </div>
              </div>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close Navigation"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
              {visibleNavItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    onClick={() => {
                      setActiveTab(item.key);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full min-h-[44px] flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-medium transition-colors ${
                      activeTab === item.key
                        ? 'bg-slate-900 text-white dark:bg-amber-600'
                        : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span className="truncate">{getNavLabel(item.key, item.labelKey)}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-3.5 border-t border-slate-200 dark:border-slate-800 space-y-2 pb-[calc(0.875rem+env(safe-area-inset-bottom))]">
              <button
                type="button"
                onClick={() => {
                  setMobileMenuOpen(false);
                  setPwdError('');
                  setPwdForm({ current_password: '', new_password: '', confirm_password: '' });
                  setShowPwdModal(true);
                }}
                className="w-full min-h-[44px] py-2.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-xl flex items-center justify-center gap-2"
              >
                <KeyRound className="w-4 h-4" />
                <span>{lang === 'bn' ? 'পাসওয়ার্ড পরিবর্তন' : 'Change Password'}</span>
              </button>
              <button
                onClick={() => setDarkMode(!darkMode)}
                className="w-full min-h-[44px] py-2.5 text-xs font-medium border border-slate-200 dark:border-slate-700 rounded-xl flex items-center justify-center gap-2"
              >
                {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                <span>{darkMode ? t('common.light') : t('common.dark')}</span>
              </button>
              <button
                onClick={handleLogout}
                className="w-full min-h-[44px] py-2.5 text-xs text-red-600 font-medium border border-red-200 dark:border-red-900/50 rounded-xl flex items-center justify-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                <span>{t('common.signOut')}</span>
              </button>
            </div>
          </div>
          <div className="flex-1 bg-black/50 backdrop-blur-[1px]" onClick={() => setMobileMenuOpen(false)} />
        </div>
      )}

      {/* Main Content Shell */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 h-14 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-b border-slate-200 dark:border-slate-800 px-3 sm:px-6 flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden min-h-[44px] min-w-[44px] -ml-1.5 flex items-center justify-center rounded-xl text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
              aria-label="Open Navigation"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm truncate">
                {!isGodownKeeper ? (
                  <button
                    type="button"
                    onClick={() => {
                      setAdminSubTab('company');
                      setActiveTab('admin');
                    }}
                    title={lang === 'bn' ? 'কোম্পানির নাম ও ঠিকানা পরিবর্তন করুন' : 'Customize Company Name & Address'}
                    className="hidden sm:inline-flex items-center gap-1 text-slate-500 hover:text-amber-600 dark:hover:text-amber-400 whitespace-nowrap transition-colors"
                  >
                    <Building2 className="w-3.5 h-3.5 shrink-0" />
                    <span>{companyDisplayName || t('app.millName')}</span>
                  </button>
                ) : (
                  <span className="hidden sm:inline-flex items-center gap-1 text-slate-500 whitespace-nowrap">
                    <Building2 className="w-3.5 h-3.5 shrink-0" />
                    <span>{companyDisplayName || t('app.millName')}</span>
                  </span>
                )}
                <span className="text-slate-300 hidden sm:inline">/</span>
                <h1 className="font-display font-semibold text-sm sm:text-base text-slate-900 dark:text-white truncate">
                  {activeNavLabel}
                </h1>
              </div>
              <div className="text-[10px] text-slate-500 truncate sm:hidden">
                {user.role_name} · {companyDisplayName || t('app.millName')}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">
            {!isOnline && (
              <button
                type="button"
                onClick={() => setSyncDrawerOpen(true)}
                title={
                  lang === 'bn'
                    ? 'অফলাইন মোড চালু — সংযোগ ফিরলে স্বয়ংক্রিয়ভাবে সিঙ্ক হবে'
                    : 'Offline Mode — Sync will happen automatically when connectivity returns'
                }
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-100 dark:bg-amber-950/60 border border-amber-300 dark:border-amber-800 text-xs font-medium text-amber-800 dark:text-amber-300 whitespace-nowrap shrink-0"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-amber-600 dark:bg-amber-400 animate-pulse shrink-0" />
                <WifiOff className="w-3.5 h-3.5 shrink-0" />
                <span className="hidden sm:inline">{t('common.offlineMode')}</span>
              </button>
            )}
            <div
              className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-0.5 shrink-0"
              role="group"
              aria-label="Language Switcher"
            >
              <button
                type="button"
                onClick={() => setLang('en')}
                className={`min-h-[34px] px-2 sm:px-2.5 rounded-md text-[11px] sm:text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  lang === 'en'
                    ? 'bg-slate-900 text-white dark:bg-amber-600'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                EN
              </button>
              <button
                type="button"
                onClick={() => setLang('bn')}
                className={`min-h-[34px] px-2 sm:px-2.5 rounded-md text-[11px] sm:text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                  lang === 'bn'
                    ? 'bg-slate-900 text-white dark:bg-amber-600'
                    : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                }`}
              >
                বাংলা
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setPwdError('');
                setPwdForm({ current_password: '', new_password: '', confirm_password: '' });
                setShowPwdModal(true);
              }}
              title={lang === 'bn' ? 'পাসওয়ার্ড পরিবর্তন' : 'Change Password'}
              className="min-h-[38px] flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <KeyRound className="w-3.5 h-3.5 shrink-0" />
              <span className="hidden md:inline">{lang === 'bn' ? 'পাসওয়ার্ড' : 'Password'}</span>
            </button>
            <button
              onClick={() => setSyncDrawerOpen(true)}
              className="min-h-[38px] flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${syncing ? 'animate-spin' : ''}`} />
              <span className="hidden sm:inline">{t('common.sync')}</span>
              <span className="font-mono">({syncQueue.length})</span>
            </button>
            <div className="hidden sm:block">
              <PWAInstallButton />
            </div>
          </div>
        </header>

        <main className="flex-1 p-3 sm:p-6 pb-24 lg:pb-6 max-w-[1440px] w-full mx-auto">
          {activeTab === 'dashboard' && (
            <DashboardModule
              data={dashboard}
              loading={loading}
              error={dashboardError}
              hideFinancials={isGodownKeeper}
              onRetry={loadAllData}
              onNavigate={(t) => setActiveTab(t as NavKey)}
              onOpenDryingHistory={() => {
                setProductionNavTarget({ subTab: 'drying', dryingView: 'history', key: Date.now() });
                setActiveTab('production');
              }}
            />
          )}
          {activeTab === 'procurement' && (
            <ProcurementModule
              purchases={purchases}
              suppliers={parties.filter((p) => Boolean(p.is_active) && (p.party_type === 'SUPPLIER' || p.party_type === 'BOTH'))}
              warehouses={warehouses.filter((w) => Boolean(w.is_active))}
              paddyItems={items.filter((i) => Boolean(i.is_active) && isPaddyItem(i, categories))}
              lots={lots}
              accounts={accounts}
              hideFinancials={isGodownKeeper}
              onRefresh={loadAllData}
              onNotify={notify}
            />
          )}
          {activeTab === 'bags' && (
            <SupplierBagLedgerPanel
              suppliers={parties.filter((p) => Boolean(p.is_active) && (p.party_type === 'SUPPLIER' || p.party_type === 'BOTH'))}
              canDelete={!isGodownKeeper}
              onNotify={notify}
            />
          )}
          {activeTab === 'inventory' && (
            <InventoryModule
              warehouses={warehouses}
              lots={lots}
              transfers={transfers}
              ledger={stockLedger}
              items={items}
              categories={categories}
              chatalBatches={chatalBatches}
              purchases={purchases}
              paddySales={paddySales}
              batches={batches}
              dryingBatches={dryingBatches}
              hideFinancials={isGodownKeeper}
              onRefresh={loadAllData}
              onNotify={notify}
            />
          )}
          {activeTab === 'warehouses' && (
            <WarehousesPage
              warehouses={warehouses}
              onRefresh={loadAllData}
              onNotify={notify}
            />
          )}
          {activeTab === 'units' && (
            <ProductUnitsPage
              units={units}
              onRefresh={loadAllData}
              onNotify={notify}
            />
          )}
          {activeTab === 'categories' && (
            <ProductCategoriesPage
              categories={categories}
              onRefresh={loadAllData}
              onNotify={notify}
            />
          )}
          {activeTab === 'products' && (
            <ProductsPage
              items={items}
              categories={categories}
              units={units}
              lots={lots}
              hideFinancials={isGodownKeeper}
              onRefresh={loadAllData}
              onNotify={notify}
            />
          )}
          {activeTab === 'production' && (
            <ProductionModule
              batches={batches}
              dryingBatches={dryingBatches}
              chatalBatches={chatalBatches}
              warehouses={warehouses.filter((w) => Boolean(w.is_active))}
              items={items.filter((i) => Boolean(i.is_active))}
              categories={categories}
              lots={lots}
              purchases={purchases}
              accounts={accounts}
              customers={parties.filter((p) => Boolean(p.is_active) && (p.party_type === 'CUSTOMER' || p.party_type === 'BOTH'))}
              initialSubTab={productionNavTarget?.subTab}
              initialDryingView={productionNavTarget?.dryingView}
              navTriggerKey={productionNavTarget?.key}
              onRefresh={loadAllData}
              onNotify={notify}
            />
          )}
          {activeTab === 'sales' && (
            <SalesModule
              invoices={invoices}
              paddySales={paddySales}
              customers={parties.filter((p) => Boolean(p.is_active) && (p.party_type === 'CUSTOMER' || p.party_type === 'BOTH'))}
              warehouses={warehouses.filter((w) => Boolean(w.is_active))}
              items={items.filter((i) => Boolean(i.is_active))}
              categories={categories}
              lots={lots}
              batches={batches}
              onRefresh={loadAllData}
              onNotify={notify}
            />
          )}
          {activeTab === 'weighbridge' && (
            <WeighbridgeQrModule logs={weighLogs} hideFinancials={isGodownKeeper} onRefresh={loadAllData} onNotify={notify} />
          )}
          {!isGodownKeeper && activeTab === 'customers' && (
            <PartiesDirectoryPage
              mode="CUSTOMER"
              parties={parties}
              accounts={accounts}
              purchases={purchases}
              invoices={invoices}
              paddySales={paddySales}
              onRefresh={loadAllData}
              onNotify={notify}
            />
          )}
          {!isGodownKeeper && activeTab === 'suppliers' && (
            <PartiesDirectoryPage
              mode="SUPPLIER"
              parties={parties}
              accounts={accounts}
              purchases={purchases}
              invoices={invoices}
              paddySales={paddySales}
              onRefresh={loadAllData}
              onNotify={notify}
            />
          )}
          {!isGodownKeeper && activeTab === 'accounting' && (
            <AccountingPartiesModule
              parties={parties}
              accounts={accounts}
              payments={payments}
              journalEntries={journalEntries}
              purchases={purchases}
              invoices={invoices}
              paddySales={paddySales}
              onRefresh={loadAllData}
              onNotify={notify}
            />
          )}
          {!isGodownKeeper && activeTab === 'admin' && (
            <AdminReportsModule
              currentUser={user}
              companySettings={companySettings}
              requestedSubTab={adminSubTab}
              onCompanyUpdated={(next) => setCompanySettings(next)}
              lots={lots}
              purchases={purchases}
              batches={batches}
              dryingBatches={dryingBatches}
              invoices={invoices}
              paddySales={paddySales}
              transfers={transfers}
              stockLedger={stockLedger}
              parties={parties}
              payments={payments}
              accounts={accounts}
              onRefresh={loadAllData}
              onNotify={notify}
            />
          )}
        </main>
      </div>

      <OfflineIndicator pendingCount={syncQueue.length} onOpenSync={() => setSyncDrawerOpen(true)} />

      {/* Mobile Bottom Navigation Bar */}
      <nav
        aria-label="Mobile Navigation"
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border-t border-slate-200 dark:border-slate-800 pb-[env(safe-area-inset-bottom)]"
      >
        <div className="grid grid-cols-5 h-15">
          {mobileBottomNav.map((nav) => {
            const Icon = nav.icon;
            const isMenu = nav.key === 'MENU';
            const isActive = !isMenu && activeTab === nav.key;
            return (
              <button
                key={nav.key}
                type="button"
                onClick={() => {
                  if (isMenu) {
                    setMobileMenuOpen(true);
                  } else {
                    setActiveTab(nav.key as NavKey);
                    setMobileMenuOpen(false);
                  }
                }}
                className={`min-h-[44px] flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
                  isActive
                    ? 'text-amber-700 dark:text-amber-400 font-semibold'
                    : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${isActive ? 'stroke-[2.3]' : ''}`} />
                <span className="truncate max-w-full px-1">{nav.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      <SyncQueueDrawer
        open={syncDrawerOpen}
        onClose={() => setSyncDrawerOpen(false)}
        queue={syncQueue}
        syncing={syncing}
        onSyncNow={handleSyncNow}
        onDiscard={async (uuid) => {
          await removeMutation(uuid);
          refreshQueue();
        }}
      />

      {showPwdModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
          <form
            onSubmit={handleChangePassword}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl p-5 max-w-sm w-full space-y-4"
          >
            <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-amber-600" />
                <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  {lang === 'bn' ? 'পাসওয়ার্ড পরিবর্তন করুন' : 'Change Password'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowPwdModal(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {lang === 'bn' ? 'বর্তমান পাসওয়ার্ড *' : 'Current Password *'}
              </label>
              <input
                type="password"
                required
                value={pwdForm.current_password}
                onChange={(e) => setPwdForm({ ...pwdForm, current_password: e.target.value })}
                className="w-full min-h-[44px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {lang === 'bn' ? 'নতুন পাসওয়ার্ড (কমপক্ষে ৬ অক্ষর) *' : 'New Password (min 6 chars) *'}
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={pwdForm.new_password}
                onChange={(e) => setPwdForm({ ...pwdForm, new_password: e.target.value })}
                className="w-full min-h-[44px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">
                {lang === 'bn' ? 'নতুন পাসওয়ার্ড নিশ্চিত করুন *' : 'Confirm New Password *'}
              </label>
              <input
                type="password"
                required
                minLength={6}
                value={pwdForm.confirm_password}
                onChange={(e) => setPwdForm({ ...pwdForm, confirm_password: e.target.value })}
                className="w-full min-h-[44px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            {pwdError && (
              <div className="p-2.5 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
                {pwdError}
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowPwdModal(false)}
                className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={pwdSaving}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50"
              >
                {pwdSaving ? t('common.saving') : lang === 'bn' ? 'আপডেট করুন' : 'Update Password'}
              </button>
            </div>
          </form>
        </div>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className={`no-print fixed bottom-24 lg:bottom-4 right-4 z-50 px-3.5 py-2.5 rounded-xl text-xs font-medium shadow-lg border max-w-[92vw] sm:max-w-md flex items-start gap-2.5 ${
            toast.tone === 'err'
              ? 'bg-red-600 text-white border-red-700'
              : toast.tone === 'warn'
              ? 'bg-amber-600 text-white border-amber-700'
              : 'bg-slate-900 text-white border-slate-800 dark:bg-white dark:text-slate-900'
          }`}
        >
          {toast.tone === 'warn' ? (
            !isOnline ? (
              <WifiOff className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            )
          ) : toast.tone === 'err' ? (
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          ) : (
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          )}
          <span className="flex-1 leading-snug">{toast.msg}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
            className="opacity-80 hover:opacity-100 shrink-0 p-0.5"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
    </AppErrorBoundary>
  );
}
