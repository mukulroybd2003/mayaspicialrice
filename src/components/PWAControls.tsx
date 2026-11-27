import React, { useState } from 'react';
import { Download, RefreshCw, Smartphone, WifiOff, AlertTriangle, Trash2, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';
import { useI18n } from '../i18n/I18nContext';
import { isNativeAndroid } from '../services/api';
import type { OfflineMutation } from '../types/erp';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showGuide, setShowGuide] = useState(false);
  const { lang, t } = useI18n();
  const isBn = lang === 'bn';

  // Suppress button when already running in standalone installed PWA or native Android APK
  if (isInstalled || isNativeAndroid()) return null;

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={() => void install()}
        className="flex items-center gap-1.5 rounded-lg bg-slate-900 dark:bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-slate-800 dark:hover:bg-amber-700 transition-colors whitespace-nowrap shrink-0"
      >
        <Download className="w-3.5 h-3.5 shrink-0" />
        <span>{t('common.installApp')}</span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setShowGuide(true)}
        className="flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 px-2.5 sm:px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
      >
        <Smartphone className="w-3.5 h-3.5 shrink-0" />
        <span className="hidden sm:inline">{t('common.installApp')}</span>
        <span className="sm:hidden">{isBn ? 'অ্যাপ' : 'App'}</span>
      </button>

      {showGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-sm rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-5 space-y-4 shadow-xl">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-amber-600 text-white flex items-center justify-center shrink-0">
                  <Smartphone className="w-4 h-4" />
                </div>
                <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                  {isIOS
                    ? t('pwa.iosTitle')
                    : isBn
                    ? 'মোবাইল অ্যাপ হিসেবে ইনস্টল করুন'
                    : 'Install as Mobile App'}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="p-1 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {isIOS ? (
              <div className="text-xs text-slate-600 dark:text-slate-300 space-y-2 leading-relaxed bg-slate-50 dark:bg-slate-950 p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
                <p>{t('pwa.iosStep1')}</p>
                <p>{t('pwa.iosStep2')}</p>
              </div>
            ) : (
              <div className="text-xs text-slate-600 dark:text-slate-300 space-y-2.5 leading-relaxed bg-slate-50 dark:bg-slate-950 p-3.5 rounded-lg border border-slate-200 dark:border-slate-800">
                <p className="font-semibold text-slate-900 dark:text-white">
                  {isBn ? 'অ্যান্ড্রয়েড (Chrome / Edge):' : 'Android (Chrome / Edge):'}
                </p>
                <p>
                  {isBn
                    ? '১. ব্রাউজারের উপরে ডানদিকের মেনু (⋮) আইকনে ট্যাপ করুন।'
                    : '1. Tap the browser menu (⋮) in the top-right corner.'}
                </p>
                <p>
                  {isBn
                    ? '২. "Install app" অথবা "Add to Home screen" সিলেক্ট করুন।'
                    : '2. Tap "Install app" or "Add to Home screen".'}
                </p>
                <p className="text-[11px] text-amber-700 dark:text-amber-400 pt-1">
                  {isBn
                    ? 'ইনস্টল হলে অনলাইন ও অফলাইন — দুই অবস্থাতেই মোবাইল অ্যাপের মতো ব্যবহার করা যাবে।'
                    : 'Once installed, works both online and offline with automatic local sync.'}
                </p>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowGuide(false)}
              className="w-full rounded-lg bg-slate-900 dark:bg-amber-600 py-2.5 text-xs font-medium text-white"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      )}
    </>
  );
};

interface OfflineIndicatorProps {
  pendingCount: number;
  onOpenSync: () => void;
}

export const OfflineIndicator: React.FC<OfflineIndicatorProps> = ({ pendingCount, onOpenSync }) => {
  const isOnline = useOnlineStatus();
  const { lang } = useI18n();
  const isBn = lang === 'bn';

  if (isOnline) return null;

  return (
    <button
      type="button"
      onClick={onOpenSync}
      role="status"
      aria-live="polite"
      className="no-print fixed bottom-20 lg:bottom-4 left-3 right-3 sm:right-auto sm:max-w-lg z-40 flex items-center justify-between sm:justify-start gap-2.5 rounded-xl bg-amber-600 hover:bg-amber-700 text-white px-3.5 py-2.5 text-xs font-medium shadow-lg border border-amber-500 transition-colors text-left"
    >
      <span className="flex items-center gap-2 min-w-0">
        <span className="h-2 w-2 rounded-full bg-white animate-pulse shrink-0" />
        <WifiOff className="w-4 h-4 shrink-0" />
        <span className="leading-snug">
          {isBn
            ? 'অফলাইন মোড চালু — এন্ট্রি লোকালভাবে সেভ হবে এবং ইন্টারনেট ফিরলেই স্বয়ংক্রিয়ভাবে সিঙ্ক হবে'
            : 'Offline Mode — Changes are saved locally and will sync automatically when connectivity returns'}
        </span>
      </span>
      {pendingCount > 0 && (
        <span className="px-2 py-0.5 rounded bg-slate-900/35 font-mono text-[11px] shrink-0">
          {pendingCount}
        </span>
      )}
    </button>
  );
};

interface SyncQueueDrawerProps {
  open: boolean;
  onClose: () => void;
  queue: OfflineMutation[];
  syncing: boolean;
  onSyncNow: () => void;
  onDiscard: (uuid: string) => void;
}

export const SyncQueueDrawer: React.FC<SyncQueueDrawerProps> = ({
  open,
  onClose,
  queue,
  syncing,
  onSyncNow,
  onDiscard,
}) => {
  const isOnline = useOnlineStatus();
  const { t } = useI18n();
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40">
      <div className="w-full max-w-md bg-white dark:bg-slate-900 h-full border-l border-slate-200 dark:border-slate-800 flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div>
            <h3 className="text-base font-display font-semibold text-slate-900 dark:text-white">
              {t('pwa.syncTitle')}
            </h3>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {isOnline ? t('pwa.onlineStatus') : t('pwa.offlineStatus')} · {queue.length} {t('pwa.queued')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
            aria-label="Close Sync Drawer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
          <button
            onClick={onSyncNow}
            disabled={!isOnline || syncing || queue.length === 0}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
            <span>{syncing ? t('pwa.syncing') : t('pwa.syncBtn')}</span>
          </button>
          {!isOnline && (
            <span className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400 font-medium">
              <WifiOff className="w-3.5 h-3.5" />
              {t('common.offlineMode')}
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {queue.length === 0 ? (
            <div className="text-center py-12 text-sm text-slate-500 dark:text-slate-400">
              {t('pwa.allSynced')}
            </div>
          ) : (
            queue.map((item) => (
              <div
                key={item.client_uuid}
                className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 space-y-2"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-900 dark:text-white">{item.module}</div>
                    <div className="text-xs text-slate-600 dark:text-slate-300 mt-0.5">{item.summary}</div>
                  </div>
                  <span
                    className={`text-xs font-mono font-medium ${
                      item.status === 'CONFLICT'
                        ? 'text-red-600 dark:text-red-400'
                        : item.status === 'FAILED'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {item.status}
                  </span>
                </div>

                {item.error_message && (
                  <div className="flex items-start gap-2 text-xs text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 p-2 rounded">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <span>{item.error_message}</span>
                  </div>
                )}

                <div className="flex items-center justify-between pt-1 text-[11px] text-slate-500 font-mono">
                  <span>UUID: {item.client_uuid.slice(0, 13)}...</span>
                  <button
                    onClick={() => onDiscard(item.client_uuid)}
                    className="flex items-center gap-1 text-red-600 hover:underline font-sans"
                  >
                    <Trash2 className="w-3 h-3" />
                    {t('pwa.discard')}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};
