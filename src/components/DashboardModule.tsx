import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  ArrowUpRight,
  Factory,
  History,
  Package,
  RefreshCw,
  Scale,
  Truck,
  Warehouse,
  Wifi,
  WifiOff,
  Wind,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { resolveApiUrl } from '../services/api';
import type { DashboardSummary } from '../types/erp';

interface DashboardModuleProps {
  data: DashboardSummary | null;
  loading: boolean;
  error?: string | null;
  hideFinancials?: boolean;
  onRetry?: () => void;
  onNavigate: (tab: string) => void;
  onOpenDryingHistory?: () => void;
}

const safeNum = (val: unknown): number => {
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
};

const fmtCurrency = (n: unknown) => `৳${safeNum(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

const formatDashDate = (raw?: string | null, isBn = false): string => {
  if (!raw) return '—';
  const trimmed = String(raw).trim();
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed) ? `${trimmed.replace(' ', 'T')}Z` : trimmed;
  const dt = new Date(normalized);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString(isBn ? 'bn-BD' : 'en-GB', { day: '2-digit', month: 'short' });
};

interface SpeedSample {
  mbps: number;
  kbps: number;
  pingMs: number | null;
  online: boolean;
  networkType: string;
  measuredAt: number;
}

const getBrowserNetworkType = (): string => {
  const nav = navigator as Navigator & {
    connection?: { effectiveType?: string; type?: string };
    mozConnection?: { effectiveType?: string; type?: string };
    webkitConnection?: { effectiveType?: string; type?: string };
  };
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  if (!conn) return '';
  const raw = conn.type && conn.type !== 'unknown' ? conn.type : conn.effectiveType || '';
  return raw ? raw.toUpperCase() : '';
};

const LiveInternetSpeedCard: React.FC<{ isBn: boolean }> = ({ isBn }) => {
  const [sample, setSample] = useState<SpeedSample>(() => ({
    mbps: 0,
    kbps: 0,
    pingMs: null,
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    networkType: typeof navigator !== 'undefined' ? getBrowserNetworkType() : '',
    measuredAt: 0,
  }));
  const [history, setHistory] = useState<number[]>([]);
  const [probing, setProbing] = useState(false);
  const [autoLive, setAutoLive] = useState(true);
  const inFlightRef = useRef(false);

  const runProbe = useCallback(async (payloadBytes = 131072) => {
    if (inFlightRef.current) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setSample({
        mbps: 0,
        kbps: 0,
        pingMs: null,
        online: false,
        networkType: getBrowserNetworkType(),
        measuredAt: Date.now(),
      });
      return;
    }

    inFlightRef.current = true;
    setProbing(true);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 8000);

    try {
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const pingStart = performance.now();
      const pingRes = await fetch(resolveApiUrl(`/api/v1/speed-probe?bytes=0&t=${nonce}`), {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!pingRes.ok) throw new Error('Ping failed');
      await pingRes.arrayBuffer();
      const pingMs = Math.max(1, Math.round(performance.now() - pingStart));

      const dlStart = performance.now();
      const dlRes = await fetch(resolveApiUrl(`/api/v1/speed-probe?bytes=${payloadBytes}&t=${nonce}-dl`), {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!dlRes.ok) throw new Error('Probe failed');
      const buf = await dlRes.arrayBuffer();
      const elapsedSec = Math.max(0.002, (performance.now() - dlStart) / 1000);
      const bytes = buf.byteLength || payloadBytes;
      const mbps = Number(((bytes * 8) / (elapsedSec * 1_000_000)).toFixed(2));
      const kbps = Number((bytes / (elapsedSec * 1024)).toFixed(1));

      setSample({
        mbps,
        kbps,
        pingMs,
        online: true,
        networkType: getBrowserNetworkType(),
        measuredAt: Date.now(),
      });
      setHistory((prev) => [...prev.slice(-11), mbps]);
    } catch {
      setSample((prev) => ({
        ...prev,
        mbps: navigator.onLine ? prev.mbps : 0,
        kbps: navigator.onLine ? prev.kbps : 0,
        pingMs: navigator.onLine ? prev.pingMs : null,
        online: typeof navigator !== 'undefined' ? navigator.onLine : false,
        networkType: getBrowserNetworkType(),
        measuredAt: Date.now(),
      }));
    } finally {
      window.clearTimeout(timeoutId);
      inFlightRef.current = false;
      setProbing(false);
    }
  }, []);

  useEffect(() => {
    void runProbe(131072);
    const onOnline = () => void runProbe(131072);
    const onOffline = () =>
      setSample((prev) => ({
        ...prev,
        online: false,
        mbps: 0,
        kbps: 0,
        pingMs: null,
        measuredAt: Date.now(),
      }));
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [runProbe]);

  useEffect(() => {
    if (!autoLive) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void runProbe(65536);
      }
    }, 8000);
    return () => window.clearInterval(id);
  }, [autoLive, runProbe]);

  const qualityLabel = !sample.online
    ? isBn
      ? 'অফলাইন'
      : 'Offline'
    : sample.mbps >= 15
    ? isBn
      ? 'দ্রুত গতি'
      : 'Fast'
    : sample.mbps >= 3
    ? isBn
      ? 'স্বাভাবিক'
      : 'Good'
    : sample.measuredAt === 0
    ? isBn
      ? 'মাপা হচ্ছে...'
      : 'Measuring...'
    : isBn
    ? 'ধীর গতি'
    : 'Slow';

  const qualityTone = !sample.online
    ? 'text-red-600 dark:text-red-400'
    : sample.mbps >= 15
    ? 'text-emerald-700 dark:text-emerald-400'
    : sample.mbps >= 3
    ? 'text-amber-700 dark:text-amber-400'
    : 'text-slate-600 dark:text-slate-300';

  const sparkPoints = (() => {
    if (history.length < 2) return '';
    const maxVal = Math.max(1, ...history);
    const w = 88;
    const h = 24;
    return history
      .map((val, idx) => {
        const x = (idx / (history.length - 1)) * w;
        const y = h - Math.max(2, (val / maxVal) * (h - 4));
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  })();

  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        <div
          className={`w-9 h-9 rounded-lg border flex items-center justify-center shrink-0 ${
            sample.online
              ? 'border-emerald-200 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400'
              : 'border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400'
          }`}
        >
          {sample.online ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
        </div>
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-900 dark:text-white flex items-center gap-2">
            <span>{isBn ? 'লাইভ ইন্টারনেট স্পিড' : 'Live Internet Speed'}</span>
            <span className={`text-[11px] font-medium ${qualityTone}`}>
              · {qualityLabel}
              {sample.networkType ? ` (${sample.networkType})` : ''}
            </span>
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums">
            {sample.online && sample.measuredAt > 0
              ? `${sample.kbps.toLocaleString('en-IN')} KB/s · ${
                  isBn ? 'পিং' : 'Ping'
                }: ${sample.pingMs !== null ? `${sample.pingMs} ms` : '—'}`
              : !sample.online
              ? isBn
                ? 'ইন্টারনেট সংযোগ নেই (অফলাইন মোড সক্রিয়)'
                : 'No internet connection (Offline mode)'
              : isBn
              ? 'সংযোগ পরীক্ষা করা হচ্ছে...'
              : 'Testing connection...'}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 sm:gap-4 ml-auto">
        {sparkPoints && (
          <svg
            width="88"
            height="24"
            viewBox="0 0 88 24"
            className="hidden sm:block shrink-0"
            aria-label={isBn ? 'লাইভ স্পিড গ্রাফ' : 'Live speed trend'}
          >
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={sample.online ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}
              points={sparkPoints}
            />
          </svg>
        )}

        <div className="text-right">
          <div className="font-mono font-bold text-base sm:text-lg tabular-nums text-slate-900 dark:text-white leading-tight">
            {sample.online ? sample.mbps.toFixed(1) : '0.0'}{' '}
            <span className="text-[11px] font-medium text-slate-500">Mbps</span>
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setAutoLive((v) => !v)}
            className={`px-2.5 py-2 min-h-[38px] rounded-lg border text-[11px] font-medium transition-colors whitespace-nowrap ${
              autoLive
                ? 'border-emerald-300 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-300'
                : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'
            }`}
            title={isBn ? 'প্রতি ৮ সেকেন্ডে স্বয়ংক্রিয় স্পিড আপডেট' : 'Auto refresh every 8 seconds'}
          >
            <span className="inline-flex items-center gap-1">
              <Activity className="w-3 h-3" />
              <span>{autoLive ? (isBn ? 'লাইভ' : 'Live') : isBn ? 'বিরতি' : 'Paused'}</span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => void runProbe(524288)}
            disabled={probing}
            className="px-2.5 py-2 min-h-[38px] rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium text-slate-700 dark:text-slate-200 disabled:opacity-50 whitespace-nowrap"
            title={isBn ? 'এখনই পূর্ণ স্পিড টেস্ট করুন' : 'Run full speed test now'}
          >
            <span className="inline-flex items-center gap-1">
              <RefreshCw className={`w-3 h-3 ${probing ? 'animate-spin' : ''}`} />
              <span>{isBn ? 'মাপুন' : 'Test'}</span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};

export const DashboardModule: React.FC<DashboardModuleProps> = ({
  data,
  loading,
  error,
  hideFinancials = false,
  onRetry,
  onNavigate,
  onOpenDryingHistory,
}) => {
  const { t, lang } = useI18n();
  const isBn = lang === 'bn';
  const fmtKg = (n: unknown) => `${safeNum(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })} ${t('common.kg')}`;

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <LiveInternetSpeedCard isBn={isBn} />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {[1, 2, 3, 4].map((k) => (
            <div key={k} className="h-24 sm:h-28 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900" />
          ))}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-4">
        <LiveInternetSpeedCard isBn={isBn} />
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center space-y-3">
          <AlertTriangle className="w-8 h-8 text-amber-600 mx-auto" />
          <h2 className="text-base font-display font-semibold text-slate-900 dark:text-white">
            {isBn ? 'ড্যাশবোর্ড ডেটা লোড করা যায়নি' : 'Unable to load dashboard data'}
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
            {error || (isBn ? 'অনুগ্রহ করে পুনরায় লোড করুন অথবা আবার সাইন ইন করুন।' : 'Please reload the dashboard or sign in again.')}
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="min-h-[44px] inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium hover:opacity-95"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>{isBn ? 'পুনরায় লোড করুন' : 'Reload Dashboard'}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  const kpis = data.kpis ?? {
    total_paddy_stock_kg: 0,
    total_rice_stock_kg: 0,
    total_byproduct_stock_kg: 0,
    inventory_valuation: 0,
    monthly_purchases: 0,
    monthly_sales: 0,
    monthly_gross_profit: 0,
    flagged_weight_discrepancies: 0,
    cash_and_bank_balance: 0,
  };
  const warehouse_utilization = Array.isArray(data.warehouse_utilization) ? data.warehouse_utilization : [];
  const production_summary = data.production_summary ?? {
    siddho_batches: 0,
    atap_batches: 0,
    avg_head_rice_yield_pct: 0,
    total_paddy_milled_kg: 0,
  };
  const drying_summary = data.drying_summary ?? {
    total_raw_purchased_kg: 0,
    total_raw_purchased_bags: 0,
    total_raw_remaining_kg: 0,
    total_raw_remaining_bags: 0,
    total_drying_batches: 0,
    completed_drying_batches: 0,
    pending_drying_batches: 0,
    total_raw_input_kg: 0,
    total_raw_input_bags: 0,
    weighed_input_kg: 0,
    total_dried_output_kg: 0,
    total_dried_output_bags: 0,
    pending_weight_input_kg: 0,
    pending_weight_bags: 0,
    total_volume_lost_kg: 0,
    drying_efficiency_pct: 0,
    loss_pct: 0,
    avg_moisture_drop_pct: 0,
    by_method: [],
    recent_drying: [],
  };
  const recent_purchases = Array.isArray(data.recent_purchases) ? data.recent_purchases : [];
  const recent_batches = Array.isArray(data.recent_batches) ? data.recent_batches : [];

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Live Internet Speed Meter */}
      <LiveInternetSpeedCard isBn={isBn} />

      {/* Primary KPI Grid */}
      {hideFinancials ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5">
            <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">{t('dash.rawPaddyStock')}</div>
            <div className="mt-1.5 text-lg sm:text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
              {fmtKg(kpis.total_paddy_stock_kg)}
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500 font-mono">
              {(safeNum(kpis.total_paddy_stock_kg) / 1000).toFixed(2)} MT
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5">
            <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">{t('dash.finishedRice')}</div>
            <div className="mt-1.5 text-lg sm:text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
              {fmtKg(kpis.total_rice_stock_kg)}
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500 font-mono">
              {(safeNum(kpis.total_rice_stock_kg) / 1000).toFixed(2)} MT
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5">
            <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">{t('dash.byProducts')}</div>
            <div className="mt-1.5 text-lg sm:text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
              {fmtKg(kpis.total_byproduct_stock_kg)}
            </div>
            <div className="mt-1.5 text-[11px] text-slate-500">
              {isBn ? 'তুষ, কুঁড়া ও খুদ' : 'Husk, Bran & Broken'}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5">
            <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">
              {isBn ? 'সক্রিয় গোডাউন ও ওজন অডিট' : 'Godowns & Weight Audit'}
            </div>
            <div className="mt-1.5 text-lg sm:text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
              {warehouse_utilization.length} {isBn ? 'টি' : ''}
            </div>
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{safeNum(kpis.flagged_weight_discrepancies)} {t('dash.flaggedDiscrepancies')}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5">
            <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">{t('dash.rawPaddyStock')}</div>
            <div className="mt-1.5 text-lg sm:text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
              {fmtKg(kpis.total_paddy_stock_kg)}
            </div>
            <div className="mt-1.5 text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">
              {t('dash.finishedRice')}: <span className="font-mono text-slate-700 dark:text-slate-300">{fmtKg(kpis.total_rice_stock_kg)}</span>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5">
            <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">{t('dash.invValuation')}</div>
            <div className="mt-1.5 text-lg sm:text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
              {fmtCurrency(kpis.inventory_valuation)}
            </div>
            <div className="mt-1.5 text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">
              {t('dash.byProducts')}: <span className="font-mono text-slate-700 dark:text-slate-300">{fmtKg(kpis.total_byproduct_stock_kg)}</span>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5">
            <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">{t('dash.totalSalesMargin')}</div>
            <div className="mt-1.5 text-lg sm:text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
              {fmtCurrency(kpis.monthly_sales)}
            </div>
            <div className="mt-1.5 text-[11px] sm:text-xs text-emerald-700 dark:text-emerald-400 font-medium">
              {t('dash.grossProfit')}: <span className="font-mono">{fmtCurrency(kpis.monthly_gross_profit)}</span>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5">
            <div className="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">{t('dash.cashBankBalance')}</div>
            <div className="mt-1.5 text-lg sm:text-2xl font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
              {fmtCurrency(kpis.cash_and_bank_balance)}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 text-[11px] sm:text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{safeNum(kpis.flagged_weight_discrepancies)} {t('dash.flaggedDiscrepancies')}</span>
            </div>
          </div>
        </div>
      )}

      {/* Godown Utilization & Milling Performance (or Godown Keeper Quick Actions) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        <div className="lg:col-span-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Warehouse className="w-4 h-4 text-slate-500" />
              <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                {t('dash.multiGodown')}
              </h2>
            </div>
            <button
              onClick={() => onNavigate('inventory')}
              className="min-h-[36px] text-xs font-medium text-amber-700 dark:text-amber-400 hover:underline flex items-center gap-1 whitespace-nowrap"
            >
              <span>{t('dash.manageGodowns')}</span>
              <ArrowUpRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="space-y-4">
            {warehouse_utilization.length === 0 ? (
              <div className="py-6 text-center text-xs text-slate-500">
                {isBn ? 'কোনো সক্রিয় গুদাম নেই' : 'No active godowns found.'}
              </div>
            ) : (
              warehouse_utilization.map((wh) => {
                const cap = safeNum(wh.capacity_kg);
                const cur = safeNum(wh.current_stock_kg);
                const pct = cap > 0 ? Math.min(100, (cur / cap) * 100) : 0;
                return (
                  <div key={wh.id} className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-1 text-xs">
                      <div>
                        <span className="font-medium text-slate-900 dark:text-slate-100">{wh.name}</span>
                        <span className="text-slate-400 mx-1.5">·</span>
                        <span className="font-mono text-slate-500">{wh.code}</span>
                      </div>
                      <div className="font-mono tabular-nums text-slate-700 dark:text-slate-300">
                        {fmtKg(cur)} / {fmtKg(cap)}
                        {!hideFinancials ? ` (${fmtCurrency(wh.valuation)})` : ''}
                      </div>
                    </div>
                    <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${pct > 85 ? 'bg-amber-600' : 'bg-slate-900 dark:bg-amber-500'}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {hideFinancials ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 flex flex-col justify-between space-y-4">
            <div>
              <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                {isBn ? 'গোডাউন কিপারের দ্রুত কাজ' : 'Godown Quick Actions'}
              </h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-1 gap-2.5">
              <button
                type="button"
                onClick={() => onNavigate('procurement')}
                className="min-h-[44px] w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Truck className="w-4 h-4 shrink-0" />
                  <span>{isBn ? 'নতুন ধান গ্রহণ ও ওজন এন্ট্রি' : 'New Paddy Intake & Weight'}</span>
                </span>
                <ArrowUpRight className="w-4 h-4 shrink-0" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate('bags')}
                className="min-h-[44px] w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium"
              >
                <span className="flex items-center gap-2">
                  <Package className="w-4 h-4 text-amber-600 shrink-0" />
                  <span>{isBn ? 'খালি বস্তা হিসাব ও স্লিপ' : 'Empty Bag Ledger & Slip'}</span>
                </span>
                <ArrowUpRight className="w-4 h-4 text-slate-400 shrink-0" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate('inventory')}
                className="min-h-[44px] w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium"
              >
                <span className="flex items-center gap-2">
                  <ArrowRightLeft className="w-4 h-4 text-slate-600 dark:text-slate-300 shrink-0" />
                  <span>{isBn ? 'গোডাউন স্টক ও ট্রান্সফার' : 'Godown Stock & Transfer'}</span>
                </span>
                <ArrowUpRight className="w-4 h-4 text-slate-400 shrink-0" />
              </button>
              <button
                type="button"
                onClick={() => onNavigate('weighbridge')}
                className="min-h-[44px] w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium"
              >
                <span className="flex items-center gap-2">
                  <Scale className="w-4 h-4 text-slate-600 dark:text-slate-300 shrink-0" />
                  <span>{isBn ? 'ওয়েব্রিজ স্কেল ও QR স্ক্যান' : 'Weighbridge & QR Scanner'}</span>
                </span>
                <ArrowUpRight className="w-4 h-4 text-slate-400 shrink-0" />
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Factory className="w-4 h-4 text-slate-500" />
                <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  {t('dash.millingPerf')}
                </h2>
              </div>

              <dl className="space-y-3 text-xs sm:text-sm">
                <div className="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800">
                  <dt className="text-slate-500 dark:text-slate-400">{t('dash.siddhoBatches')}</dt>
                  <dd className="font-mono font-semibold tabular-nums text-slate-900 dark:text-white">
                    {safeNum(production_summary.siddho_batches)}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800">
                  <dt className="text-slate-500 dark:text-slate-400">{t('dash.atapBatches')}</dt>
                  <dd className="font-mono font-semibold tabular-nums text-slate-900 dark:text-white">
                    {safeNum(production_summary.atap_batches)}
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-800">
                  <dt className="text-slate-500 dark:text-slate-400">{t('dash.avgHeadRice')}</dt>
                  <dd className="font-mono font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                    {safeNum(production_summary.avg_head_rice_yield_pct).toFixed(2)}%
                  </dd>
                </div>
                <div className="flex items-center justify-between py-2">
                  <dt className="text-slate-500 dark:text-slate-400">{t('dash.totalPaddyMilled')}</dt>
                  <dd className="font-mono font-semibold tabular-nums text-slate-900 dark:text-white">
                    {fmtKg(production_summary.total_paddy_milled_kg)}
                  </dd>
                </div>
              </dl>
            </div>

            <button
              onClick={() => onNavigate('production')}
              className="mt-4 min-h-[44px] w-full py-2 px-4 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors"
            >
              {t('dash.openCostSheets')}
            </button>
          </div>
        )}
      </div>

      {/* Raw-to-Dried Paddy Conversion Progress Visualization & Summary */}
      {(() => {
        const ds = drying_summary;
        const totalPipelineKg = Math.max(
          safeNum(ds.total_raw_input_kg) + safeNum(ds.total_raw_remaining_kg),
          safeNum(ds.total_raw_purchased_kg),
          1
        );
        const driedOutKg = safeNum(ds.total_dried_output_kg);
        const lostKg = safeNum(ds.total_volume_lost_kg);
        const pendingWeightKg = safeNum(ds.pending_weight_input_kg);
        const unDriedRemKg = safeNum(ds.total_raw_remaining_kg);

        const driedPipePct = Math.min(100, (driedOutKg / totalPipelineKg) * 100);
        const lostPipePct = Math.min(100 - driedPipePct, (lostKg / totalPipelineKg) * 100);
        const pendingPipePct = Math.min(100 - driedPipePct - lostPipePct, (pendingWeightKg / totalPipelineKg) * 100);
        const rawRemPipePct = Math.max(0, 100 - driedPipePct - lostPipePct - pendingPipePct);

        const weighedInputKg = safeNum(ds.weighed_input_kg);
        const yieldRatioPct = weighedInputKg > 0 ? Math.min(100, (driedOutKg / weighedInputKg) * 100) : 0;
        const lossRatioPct = weighedInputKg > 0 ? Math.max(0, 100 - yieldRatioPct) : 0;

        return (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <Wind className="w-4 h-4 text-amber-600 shrink-0" />
                <div>
                  <h2 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                    {isBn ? 'কাঁচা থেকে শুকনো ধান রূপান্তর অগ্রগতি' : 'Raw-to-Dried Paddy Conversion Progress'}
                  </h2>
                  <p className="text-[11px] text-slate-500 dark:text-slate-400">
                    {isBn
                      ? 'শুকানোর পরিমাণ, মোট শুখতি (ভলিউম লস) এবং শুকানোর দক্ষতা বিশ্লেষণ'
                      : 'Conversion pipeline, total moisture volume lost, and drying efficiency'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => (onOpenDryingHistory ? onOpenDryingHistory() : onNavigate('production'))}
                className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-amber-700 dark:text-amber-400 whitespace-nowrap"
              >
                <History className="w-3.5 h-3.5" />
                <span>{isBn ? 'শুকানোর ইতিহাস ও লগ' : 'Drying History & Logs'}</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="p-4 sm:p-5 space-y-5">
              {/* 4 Key Conversion Metrics */}
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3.5">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {isBn ? 'কাঁচা ইনপুট (শুকানোয় গেছে)' : 'Raw Paddy Input'}
                  </div>
                  <div className="mt-1 text-base sm:text-lg font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
                    {fmtKg(ds.total_raw_input_kg)}
                  </div>
                  <div className="mt-1 text-[11px] font-mono tabular-nums text-slate-500">
                    {safeNum(ds.total_raw_input_bags).toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'} ·{' '}
                    {safeNum(ds.total_drying_batches)} {isBn ? 'ব্যাচ' : 'batches'}
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3.5">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {isBn ? 'শুকনো ধান প্রাপ্তি' : 'Dried Paddy Output'}
                  </div>
                  <div className="mt-1 text-base sm:text-lg font-display font-semibold font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                    {fmtKg(ds.total_dried_output_kg)}
                  </div>
                  <div className="mt-1 text-[11px] font-mono tabular-nums text-slate-500">
                    {safeNum(ds.total_dried_output_bags).toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'} ·{' '}
                    {safeNum(ds.completed_drying_batches)} {isBn ? 'সম্পন্ন' : 'completed'}
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3.5">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {isBn ? 'মোট শুখতি / ওজন ঘাটতি' : 'Total Volume Lost'}
                  </div>
                  <div className="mt-1 text-base sm:text-lg font-display font-semibold font-mono tabular-nums text-amber-700 dark:text-amber-400">
                    −{fmtKg(ds.total_volume_lost_kg)}
                  </div>
                  <div className="mt-1 text-[11px] font-mono tabular-nums text-slate-500">
                    {weighedInputKg > 0
                      ? isBn
                        ? `ঘাটতি ${safeNum(ds.loss_pct).toFixed(1)}% (${safeNum(ds.pending_drying_batches)} পেন্ডিং)`
                        : `${safeNum(ds.loss_pct).toFixed(1)}% lost · ${safeNum(ds.pending_drying_batches)} pending`
                      : isBn
                      ? `${safeNum(ds.pending_drying_batches)}টি ওজন পেন্ডিং`
                      : `${safeNum(ds.pending_drying_batches)} pending weigh-out`}
                  </div>
                </div>

                <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3.5">
                  <div className="text-[11px] text-slate-500 dark:text-slate-400">
                    {isBn ? 'শুকানোর দক্ষতা (দক্ষতা %)' : 'Drying Efficiency'}
                  </div>
                  <div className="mt-1 text-base sm:text-lg font-display font-semibold font-mono tabular-nums text-slate-900 dark:text-white">
                    {weighedInputKg > 0 ? `${safeNum(ds.drying_efficiency_pct).toFixed(1)}%` : '—'}
                  </div>
                  <div className="mt-1 text-[11px] font-mono tabular-nums text-slate-500">
                    {safeNum(ds.avg_moisture_drop_pct) > 0
                      ? isBn
                        ? `গড় আর্দ্রতা কম: −${safeNum(ds.avg_moisture_drop_pct).toFixed(1)}%`
                        : `Avg MC drop: −${safeNum(ds.avg_moisture_drop_pct).toFixed(1)}%`
                      : isBn
                      ? `বাকি কাঁচা: ${fmtKg(ds.total_raw_remaining_kg)}`
                      : `Raw pending: ${fmtKg(ds.total_raw_remaining_kg)}`}
                  </div>
                </div>
              </div>

              {/* Chart + Summary Table */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
                {/* Visual Conversion & Method Bars */}
                <div className="lg:col-span-5 space-y-4">
                  {/* Pipeline Stacked Bar */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        {isBn ? 'কাঁচা ধান রূপান্তর পাইপলাইন' : 'Raw Paddy Conversion Pipeline'}
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-slate-500">
                        {fmtKg(ds.total_raw_input_kg)} / {fmtKg(totalPipelineKg)}
                      </span>
                    </div>
                    <div
                      className="h-3.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex"
                      role="img"
                      aria-label={isBn ? 'কাঁচা থেকে শুকনো ধান রূপান্তর চার্ট' : 'Raw to dried conversion progress bar'}
                    >
                      {driedPipePct > 0 && (
                        <div
                          className="h-full bg-emerald-600 transition-all"
                          style={{ width: `${driedPipePct.toFixed(2)}%` }}
                          title={`${isBn ? 'শুকনো আউটপুট' : 'Dried Output'}: ${fmtKg(driedOutKg)}`}
                        />
                      )}
                      {lostPipePct > 0 && (
                        <div
                          className="h-full bg-amber-500 transition-all"
                          style={{ width: `${lostPipePct.toFixed(2)}%` }}
                          title={`${isBn ? 'মোট শুখতি' : 'Volume Lost'}: ${fmtKg(lostKg)}`}
                        />
                      )}
                      {pendingPipePct > 0 && (
                        <div
                          className="h-full bg-sky-500 transition-all"
                          style={{ width: `${pendingPipePct.toFixed(2)}%` }}
                          title={`${isBn ? 'ওজন পেন্ডিং' : 'Weigh-Out Pending'}: ${fmtKg(pendingWeightKg)}`}
                        />
                      )}
                      {rawRemPipePct > 0 && safeNum(ds.total_drying_batches) + unDriedRemKg > 0 && (
                        <div
                          className="h-full bg-slate-300 dark:bg-slate-600 transition-all"
                          style={{ width: `${rawRemPipePct.toFixed(2)}%` }}
                          title={`${isBn ? 'শুকানো বাকি কাঁচা ধান' : 'Un-dried Raw Remaining'}: ${fmtKg(unDriedRemKg)}`}
                        />
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-400 font-mono tabular-nums">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 font-sans">
                          <span className="w-2.5 h-2.5 rounded-sm bg-emerald-600 inline-block" />
                          {isBn ? 'শুকনো প্রাপ্তি' : 'Dried Output'}
                        </span>
                        <span className="text-slate-900 dark:text-slate-200">{fmtKg(driedOutKg)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 font-sans">
                          <span className="w-2.5 h-2.5 rounded-sm bg-amber-500 inline-block" />
                          {isBn ? 'শুখতি / ঘাটতি' : 'Volume Lost'}
                        </span>
                        <span className="text-slate-900 dark:text-slate-200">{fmtKg(lostKg)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 font-sans">
                          <span className="w-2.5 h-2.5 rounded-sm bg-sky-500 inline-block" />
                          {isBn ? 'ওজন পেন্ডিং' : 'Weigh Pending'}
                        </span>
                        <span className="text-slate-900 dark:text-slate-200">{fmtKg(pendingWeightKg)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-1.5 font-sans">
                          <span className="w-2.5 h-2.5 rounded-sm bg-slate-300 dark:bg-slate-600 inline-block" />
                          {isBn ? 'বাকি কাঁচা ধান' : 'Raw Un-dried'}
                        </span>
                        <span className="text-slate-900 dark:text-slate-200">{fmtKg(unDriedRemKg)}</span>
                      </div>
                    </div>
                  </div>

                  {/* Weighed Yield vs Volume Loss Bar */}
                  <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        {isBn ? 'প্রাপ্তি বনাম শুখতি অনুপাত (ওজনকৃত)' : 'Weighed Yield vs Moisture Loss'}
                      </span>
                      <span className="font-mono text-[11px] tabular-nums text-emerald-700 dark:text-emerald-400 font-semibold">
                        {weighedInputKg > 0
                          ? `${yieldRatioPct.toFixed(1)}% / −${lossRatioPct.toFixed(1)}%`
                          : isBn
                          ? 'ওজন বাকি'
                          : 'Pending'}
                      </span>
                    </div>
                    <div className="h-2.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden flex">
                      {weighedInputKg > 0 && (
                        <>
                          <div className="h-full bg-emerald-600" style={{ width: `${yieldRatioPct.toFixed(1)}%` }} />
                          <div className="h-full bg-amber-500" style={{ width: `${lossRatioPct.toFixed(1)}%` }} />
                        </>
                      )}
                    </div>
                  </div>

                  {/* By Drying Method Breakdown */}
                  <div className="pt-3 border-t border-slate-100 dark:border-slate-800 space-y-2.5">
                    <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                      {isBn ? 'পদ্ধতি অনুযায়ী দক্ষতা' : 'Efficiency by Drying Method'}
                    </div>
                    {ds.by_method.length === 0 ? (
                      <div className="text-[11px] text-slate-400">
                        {isBn ? 'এখনো কোনো শুকানোর পদ্ধতি রেকর্ড হয়নি' : 'No method breakdown available yet.'}
                      </div>
                    ) : (
                      ds.by_method.map((m) => {
                        const label =
                          m.method === 'MECHANICAL_DRYER'
                            ? isBn
                              ? 'মেকানিক্যাল ড্রায়ার'
                              : 'Mechanical Dryer'
                            : isBn
                            ? 'চাতাল / রোদে'
                            : 'Sun Yard';
                        return (
                          <div key={m.method} className="space-y-1 text-[11px]">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-medium text-slate-800 dark:text-slate-200">
                                {label} ({m.batch_count})
                              </span>
                              <span className="font-mono tabular-nums text-slate-600 dark:text-slate-300">
                                {fmtKg(m.input_kg)} → {fmtKg(m.output_kg)} ·{' '}
                                <strong className="text-emerald-700 dark:text-emerald-400">
                                  {m.weighed_input_kg > 0 ? `${m.efficiency_pct.toFixed(1)}%` : '—'}
                                </strong>
                              </span>
                            </div>
                            <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                              <div
                                className="h-full bg-slate-900 dark:bg-amber-500 rounded-full"
                                style={{ width: `${Math.min(100, Math.max(0, m.efficiency_pct))}%` }}
                              />
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>

                {/* Recent Drying Conversion Summary Table */}
                <div className="lg:col-span-7 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
                  <div className="px-3.5 py-2.5 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-800 dark:text-slate-200">
                      {isBn ? 'সাম্প্রতিক শুকানোর ব্যাচ ও দক্ষতা সারসংক্ষেপ' : 'Recent Drying Conversion Summary'}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">
                      {ds.recent_drying.length} / {ds.total_drying_batches}
                    </span>
                  </div>

                  {ds.recent_drying.length === 0 ? (
                    <div className="px-4 py-8 text-center space-y-2.5">
                      <div className="text-xs text-slate-500">
                        {isBn ? 'এখনো কোনো ধান শুকানোর ব্যাচ রেকর্ড করা হয়নি।' : 'No drying conversion logs recorded yet.'}
                      </div>
                      <button
                        type="button"
                        onClick={() => (onOpenDryingHistory ? onOpenDryingHistory() : onNavigate('production'))}
                        className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold"
                      >
                        <span>{isBn ? 'ধান শুকানো শুরু করুন' : 'Open Paddy Drying'}</span>
                        <ArrowUpRight className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ) : (
                    <>
                      {/* Mobile Card View */}
                      <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
                        {ds.recent_drying.map((r) => (
                          <div key={r.id} className="p-3 text-xs space-y-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <div>
                                <div className="font-mono font-semibold text-slate-900 dark:text-white">{r.drying_no}</div>
                                <div className="text-[11px] text-slate-500">
                                  {formatDashDate(r.created_at, isBn)} · {r.item_name}
                                </div>
                              </div>
                              <div className="text-right font-mono tabular-nums">
                                <div className="font-semibold text-emerald-700 dark:text-emerald-400">
                                  {r.output_qty_kg > 0 ? `${r.efficiency_pct.toFixed(1)}%` : isBn ? 'পেন্ডিং' : 'Pending'}
                                </div>
                                {r.output_qty_kg > 0 && (
                                  <div className="text-[11px] text-amber-700 dark:text-amber-400">
                                    −{r.moisture_loss_kg.toLocaleString('en-IN')} kg
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-600 dark:text-slate-300">
                              <span>
                                {isBn ? 'ইন:' : 'In:'} {r.input_qty_kg.toLocaleString('en-IN')} kg
                              </span>
                              <span>
                                {isBn ? 'আউট:' : 'Out:'}{' '}
                                {r.output_qty_kg > 0 ? `${r.output_qty_kg.toLocaleString('en-IN')} kg` : `${r.output_bags}ব`}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Desktop Table */}
                      <div className="hidden md:block overflow-x-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-slate-50/70 dark:bg-slate-950/60 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                              <th className="text-left px-3 py-2 font-medium">{isBn ? 'ব্যাচ ও তারিখ' : 'Batch & Date'}</th>
                              <th className="text-left px-3 py-2 font-medium">{isBn ? 'ধান / গুদাম' : 'Variety / Godown'}</th>
                              <th className="text-right px-3 py-2 font-medium">{isBn ? 'কাঁচা ইনপুট' : 'Raw In'}</th>
                              <th className="text-right px-3 py-2 font-medium">{isBn ? 'শুকনো আউট' : 'Dried Out'}</th>
                              <th className="text-right px-3 py-2 font-medium">{isBn ? 'শুখতি' : 'Lost'}</th>
                              <th className="text-right px-3 py-2 font-medium">{isBn ? 'দক্ষতা %' : 'Efficiency'}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {ds.recent_drying.map((r) => (
                              <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                                <td className="px-3 py-2 whitespace-nowrap">
                                  <div className="font-mono font-medium text-slate-900 dark:text-white">{r.drying_no}</div>
                                  <div className="text-[11px] font-mono text-slate-500">
                                    {formatDashDate(r.created_at, isBn)}
                                    {r.purchase_no ? ` · ${r.purchase_no}` : ''}
                                  </div>
                                </td>
                                <td className="px-3 py-2">
                                  <div className="font-medium text-slate-800 dark:text-slate-200 truncate max-w-[150px]">
                                    {r.item_name}
                                  </div>
                                  <div className="text-[11px] text-slate-500 truncate max-w-[150px]">
                                    {r.dest_warehouse_name}
                                  </div>
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                                  {r.input_qty_kg.toLocaleString('en-IN')}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-slate-900 dark:text-white">
                                  {r.output_qty_kg > 0
                                    ? r.output_qty_kg.toLocaleString('en-IN')
                                    : `${r.output_bags}${isBn ? 'ব' : 'b'}`}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums text-amber-700 dark:text-amber-400">
                                  {r.output_qty_kg > 0 ? `−${r.moisture_loss_kg.toLocaleString('en-IN')}` : '—'}
                                </td>
                                <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold">
                                  {r.output_qty_kg > 0 ? (
                                    <span className="text-emerald-700 dark:text-emerald-400">{r.efficiency_pct.toFixed(1)}%</span>
                                  ) : (
                                    <span className="font-sans text-[11px] text-amber-700 dark:text-amber-400">
                                      {isBn ? 'পেন্ডিং' : 'Pending'}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Recent Purchases (with 4-Weight Audit) & Recent Batches (hidden for Godown Keeper) */}
      <div className={`grid grid-cols-1 ${hideFinancials ? '' : 'lg:grid-cols-2'} gap-4 sm:gap-6`}>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Scale className="w-4 h-4 text-slate-500" />
              <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                {hideFinancials ? (isBn ? 'সাম্প্রতিক ধান গ্রহণ (৪-ওজন অডিট)' : 'Recent Paddy Intake (4-Weight)') : t('dash.recentReceipts')}
              </h3>
            </div>
            <button onClick={() => onNavigate('procurement')} className="text-xs text-amber-700 dark:text-amber-400 font-medium hover:underline whitespace-nowrap">
              {t('dash.viewAll')}
            </button>
          </div>

          {/* Mobile Card List */}
          <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
            {recent_purchases.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-slate-500">
                {isBn ? 'সাম্প্রতিক কোনো ধান গ্রহণ নেই' : 'No recent paddy receipts.'}
              </div>
            ) : (
              recent_purchases.map((p) => {
                const diff = safeNum(p.weight_discrepancy_kg);
                return (
                  <div key={p.id} className="p-3.5 space-y-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-mono font-semibold text-slate-900 dark:text-white">{p.purchase_no}</div>
                        <div className="text-slate-600 dark:text-slate-300">{p.supplier_name}</div>
                      </div>
                      {!hideFinancials && (
                        <div className="text-right font-mono font-semibold text-slate-900 dark:text-white">
                          {p.pricing_status === 'PENDING_RATE' ? (
                            <span className="text-amber-700 dark:text-amber-400">{isBn ? 'দর বাকি' : 'Pending Rate'}</span>
                          ) : (
                            fmtCurrency(p.total_payable)
                          )}
                        </div>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 dark:bg-slate-950 p-2 font-mono text-[11px]">
                      <div>
                        <div className="text-slate-400">{isBn ? 'স্কেল ওজন' : 'Scale'}</div>
                        <div className="font-semibold">{safeNum(p.scale_weight_kg).toLocaleString()} kg</div>
                      </div>
                      <div>
                        <div className="text-slate-400">{isBn ? 'গৃহীত' : 'Received'}</div>
                        <div className="font-semibold">{safeNum(p.received_weight_kg).toLocaleString()} kg</div>
                      </div>
                      <div className="text-right">
                        <div className="text-slate-400">{isBn ? 'পার্থক্য' : 'Diff'}</div>
                        <div className={`font-semibold ${p.discrepancy_flagged ? 'text-red-600' : 'text-emerald-700 dark:text-emerald-400'}`}>
                          {diff > 0 ? `+${diff}` : diff} kg
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Desktop Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                  <th className="text-left px-4 py-2.5 font-medium">{t('dash.receiptSupplier')}</th>
                  <th className="text-right px-4 py-2.5 font-medium">{t('dash.scaleKg')}</th>
                  <th className="text-right px-4 py-2.5 font-medium">{isBn ? 'গৃহীত (কেজি)' : 'Received (kg)'}</th>
                  <th className="text-right px-4 py-2.5 font-medium">{t('dash.diffKg')}</th>
                  {!hideFinancials && <th className="text-right px-4 py-2.5 font-medium">{t('dash.payable')}</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {recent_purchases.length === 0 ? (
                  <tr>
                    <td colSpan={hideFinancials ? 4 : 5} className="px-4 py-6 text-center text-slate-500">
                      {isBn ? 'সাম্প্রতিক কোনো ধান গ্রহণ নেই' : 'No recent paddy purchases.'}
                    </td>
                  </tr>
                ) : (
                  recent_purchases.map((p) => {
                    const diff = safeNum(p.weight_discrepancy_kg);
                    return (
                      <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="px-4 py-2.5">
                          <div className="font-mono font-medium text-slate-900 dark:text-white">{p.purchase_no}</div>
                          <div className="text-slate-500 truncate max-w-[180px]">{p.supplier_name}</div>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {safeNum(p.scale_weight_kg).toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {safeNum(p.received_weight_kg).toLocaleString()}
                        </td>
                        <td
                          className={`px-4 py-2.5 text-right font-mono tabular-nums font-medium ${
                            p.discrepancy_flagged ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
                          }`}
                        >
                          {diff > 0 ? `+${diff}` : diff}
                        </td>
                        {!hideFinancials && (
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-900 dark:text-white">
                            {p.pricing_status === 'PENDING_RATE' ? (
                              <span className="text-amber-700 dark:text-amber-400 text-[11px] font-semibold">
                                {isBn ? 'দর বাকি' : 'Pending Rate'}
                              </span>
                            ) : (
                              fmtCurrency(p.total_payable)
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>

        {!hideFinancials && (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 sm:px-5 py-3.5 sm:py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                {t('dash.recentProduction')}
              </h3>
              <button onClick={() => onNavigate('production')} className="text-xs text-amber-700 dark:text-amber-400 font-medium hover:underline whitespace-nowrap">
                {t('dash.openProduction')}
              </button>
            </div>

            {/* Mobile Card List */}
            <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
              {recent_batches.length === 0 ? (
                <div className="px-4 py-6 text-center text-xs text-slate-500">
                  {isBn ? 'সাম্প্রতিক কোনো উৎপাদন ব্যাচ নেই' : 'No recent milling batches.'}
                </div>
              ) : (
                recent_batches.map((b) => (
                  <div key={b.id} className="p-3.5 flex items-center justify-between text-xs">
                    <div>
                      <div className="font-mono font-semibold text-slate-900 dark:text-white">{b.batch_no}</div>
                      <div className="text-slate-500">
                        {b.process_type === 'PARBOILED_SIDDHO' ? t('dash.siddho') : t('dash.atap')} · {safeNum(b.input_paddy_qty_kg).toLocaleString()} kg
                      </div>
                    </div>
                    <div className="text-right font-mono">
                      <div className="font-semibold text-slate-900 dark:text-white">{safeNum(b.head_rice_qty_kg).toLocaleString()} {t('common.kg')}</div>
                      <div className="text-emerald-700 dark:text-emerald-400 font-semibold">{safeNum(b.head_rice_yield_pct).toFixed(1)}%</div>
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
                    <th className="text-left px-4 py-2.5 font-medium">{t('dash.batchProcess')}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t('dash.inputKg')}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t('dash.headRice')}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t('dash.yieldPct')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {recent_batches.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                        {isBn ? 'সাম্প্রতিক কোনো উৎপাদন ব্যাচ নেই' : 'No recent milling batches.'}
                      </td>
                    </tr>
                  ) : (
                    recent_batches.map((b) => (
                      <tr key={b.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="px-4 py-2.5">
                          <div className="font-mono font-medium text-slate-900 dark:text-white">{b.batch_no}</div>
                          <div className="text-slate-500">
                            {b.process_type === 'PARBOILED_SIDDHO' ? t('dash.siddho') : t('dash.atap')}
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-700 dark:text-slate-300">
                          {safeNum(b.input_paddy_qty_kg).toLocaleString()}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-900 dark:text-white">
                          {safeNum(b.head_rice_qty_kg).toLocaleString()} {t('common.kg')}
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono tabular-nums font-medium text-emerald-700 dark:text-emerald-400">
                          {safeNum(b.head_rice_yield_pct).toFixed(1)}%
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

