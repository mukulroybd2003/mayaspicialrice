import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { Bluetooth, Camera, CheckCircle2, Clock, QrCode, Scale, Search, Trash2, Usb } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { apiGet, apiMutate } from '../services/api';
import type { WeighbridgeLog, WeighbridgeMode } from '../types/erp';
import { generateQrDataUrl } from '../utils/reports';

interface QrLookupPayload {
  qr_code_uid: string;
  entity_type: string;
  entity_code: string;
  payload: Record<string, unknown>;
  created_at: string;
}

interface RecentQrScan extends QrLookupPayload {
  scanned_at: string;
  source: 'CAMERA' | 'MANUAL';
}

const RECENT_QR_SCANS_KEY = 'sonagrain_recent_qr_scans_v1';
const FINANCIAL_KEY_RE = /(rate|cost|price|payable|paid|amount|value|total|margin|profit|balance|expense)/i;
const RESTRICTED_PHYSICAL_TYPES = new Set(['SALES_INVOICE', 'PADDY_SALE', 'PRODUCTION_BATCH']);

function sanitizePayloadForView(payload: Record<string, unknown>, hideFinancials: boolean): Record<string, unknown> {
  if (!hideFinancials) return payload;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (!FINANCIAL_KEY_RE.test(k)) {
      clean[k] = v;
    }
  }
  return clean;
}

function loadSavedQrScans(hideFinancials: boolean): RecentQrScan[] {
  try {
    const raw = localStorage.getItem(RECENT_QR_SCANS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is RecentQrScan => Boolean(item && typeof item.qr_code_uid === 'string' && typeof item.entity_code === 'string'))
      .filter((item) => !hideFinancials || !RESTRICTED_PHYSICAL_TYPES.has(item.entity_type))
      .map((item) => ({
        ...item,
        payload: sanitizePayloadForView(item.payload && typeof item.payload === 'object' ? item.payload : {}, hideFinancials),
      }))
      .slice(0, 5);
  } catch {
    return [];
  }
}

interface WeighbridgeQrModuleProps {
  logs: WeighbridgeLog[];
  hideFinancials?: boolean;
  onRefresh: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

export const WeighbridgeQrModule: React.FC<WeighbridgeQrModuleProps> = ({
  logs,
  hideFinancials = false,
  onRefresh,
  onNotify,
}) => {
  const { t, lang } = useI18n();
  const isBn = lang === 'bn';

  const [mode, setMode] = useState<WeighbridgeMode>('MANUAL');
  const [liveReading, setLiveReading] = useState<number>(0);
  const [vehicleNo, setVehicleNo] = useState('');
  const [driverName, setDriverName] = useState('');
  const [tareWeight, setTareWeight] = useState(0);
  const [rawSerialString, setRawSerialString] = useState('');

  const [qrInput, setQrInput] = useState('');
  const [qrResult, setQrResult] = useState<QrLookupPayload | null>(null);
  const [qrImg, setQrImg] = useState('');
  const [recentScans, setRecentScans] = useState<RecentQrScan[]>(() => loadSavedQrScans(hideFinancials));
  const [scanningCamera, setScanningCamera] = useState(false);
  const scannerRef = useRef<Html5Qrcode | null>(null);

  const netWeight = Math.max(0, Number((liveReading - tareWeight).toFixed(2)));

  useEffect(() => {
    setRecentScans(loadSavedQrScans(hideFinancials));
  }, [hideFinancials]);

  const persistScans = (next: RecentQrScan[]) => {
    setRecentScans(next);
    try {
      localStorage.setItem(RECENT_QR_SCANS_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage quota issues
    }
  };

  // Connect real Web Serial API weighbridge indicator if browser supports it
  const connectSerialScale = async () => {
    const navSerial = (navigator as unknown as { serial?: { requestPort: () => Promise<{ open: (o: { baudRate: number }) => Promise<void>; readable: ReadableStream<Uint8Array> }> } }).serial;
    if (!navSerial) {
      setMode('USB_SERIAL');
      onNotify(
        isBn
          ? 'এই ব্রাউজারে Web Serial API পাওয়া যায়নি; হাতে ওজন লিখুন অথবা সমর্থিত ব্রাউজার ব্যবহার করুন।'
          : 'Web Serial API unavailable in this browser; enter scale weight manually.',
        'warn'
      );
      return;
    }
    try {
      const port = await navSerial.requestPort();
      await port.open({ baudRate: 9600 });
      setMode('USB_SERIAL');
      onNotify(isBn ? '৯৬০০ বডে USB Serial ওয়েব্রিজ ইন্ডিকেটরের সাথে সংযুক্ত হয়েছে।' : 'Connected to USB Serial weighbridge indicator at 9600 baud.', 'ok');
      const reader = port.readable.getReader();
      const decoder = new TextDecoder();
      const { value } = await reader.read();
      if (value) {
        const text = decoder.decode(value).trim();
        setRawSerialString(text);
        const match = text.match(/(\d+(\.\d+)?)/);
        if (match) setLiveReading(Number(match[1]));
      }
      reader.releaseLock();
    } catch (err) {
      onNotify(`Serial port: ${(err as Error).message}`, 'warn');
    }
  };

  const handleCaptureWeight = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await apiMutate({
        endpoint: '/api/v1/weighbridge-logs',
        payload: {
          vehicle_no: vehicleNo,
          driver_name: driverName,
          gross_weight_kg: liveReading,
          tare_weight_kg: tareWeight,
          device_mode: mode,
          raw_device_string: mode === 'MANUAL' ? 'MANUAL_ENTRY' : rawSerialString,
        },
        module: 'Weighbridge Ticket',
        summary: `${vehicleNo}: Net ${netWeight} kg (${mode})`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: ওয়েব্রিজ টিকিট IndexedDB-তে সংরক্ষিত হয়েছে।' : 'Offline: Weighbridge ticket queued in IndexedDB.', 'warn');
      } else {
        onNotify(isBn ? 'ওয়েব্রিজ টিকিট সংরক্ষণ ও লগ করা হয়েছে।' : 'Weighbridge ticket captured and logged.', 'ok');
      }
      setVehicleNo('');
      setDriverName('');
      setLiveReading(0);
      setTareWeight(0);
      setRawSerialString('');
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const displayQrEntry = async (data: QrLookupPayload) => {
    setQrResult({
      ...data,
      payload: sanitizePayloadForView(data.payload || {}, hideFinancials),
    });
    setQrInput(data.entity_code);
    const url = await generateQrDataUrl(`SONAGRAIN|${data.entity_type}|${data.entity_code}|${data.qr_code_uid}`);
    setQrImg(url);
  };

  const lookupQr = async (rawCode: string, source: 'CAMERA' | 'MANUAL' = 'MANUAL') => {
    const clean = rawCode.includes('|') ? rawCode.split('|').pop() || rawCode : rawCode;
    const trimmed = clean.trim();
    if (!trimmed) return;
    try {
      const data = await apiGet<QrLookupPayload>(`/api/v1/qr/lookup?code=${encodeURIComponent(trimmed)}`);
      const safeData: QrLookupPayload = {
        ...data,
        payload: sanitizePayloadForView(data.payload || {}, hideFinancials),
      };
      await displayQrEntry(safeData);

      const newScan: RecentQrScan = {
        ...safeData,
        scanned_at: new Date().toISOString(),
        source,
      };
      const next = [newScan, ...recentScans.filter((item) => item.qr_code_uid !== safeData.qr_code_uid)].slice(0, 5);
      persistScans(next);
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const safeStopScanner = async () => {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (!scanner) return;
    try {
      const state = (scanner as unknown as { getState?: () => number }).getState?.();
      // 2 = SCANNING, 3 = PAUSED in html5-qrcode
      if (state === undefined || state === 2 || state === 3) {
        await Promise.resolve(scanner.stop()).catch(() => {});
      }
    } catch {
      // ignore synchronous stop errors when scanner is already stopped/idle
    }
    try {
      scanner.clear();
    } catch {
      // ignore clear errors if DOM node already unmounted
    }
  };

  const toggleCameraScanner = async () => {
    if (scanningCamera) {
      await safeStopScanner();
      setScanningCamera(false);
      return;
    }
    setScanningCamera(true);
    setTimeout(async () => {
      try {
        await safeStopScanner();
        const el = document.getElementById('qr-camera-reader');
        if (!el) {
          setScanningCamera(false);
          return;
        }
        const html5Qr = new Html5Qrcode('qr-camera-reader');
        scannerRef.current = html5Qr;
        await html5Qr.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 220, height: 220 } },
          (decodedText) => {
            setQrInput(decodedText);
            void lookupQr(decodedText, 'CAMERA');
            void safeStopScanner();
            setScanningCamera(false);
          },
          () => {}
        );
      } catch (err) {
        await safeStopScanner();
        setScanningCamera(false);
        onNotify(
          isBn
            ? `ক্যামেরা পাওয়া যায়নি (${(err as Error).message})। অনুগ্রহ করে হাতে লট বা চালান কোড লিখুন।`
            : `Camera unavailable (${(err as Error).message}). Enter lot or invoice code manually.`,
          'warn'
        );
      }
    }, 100);
  };

  useEffect(() => {
    return () => {
      void safeStopScanner();
    };
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Left: Hardware Weighbridge Terminal */}
      <div className="space-y-5">
        <div className="bg-slate-900 text-white rounded-xl border border-slate-800 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Scale className="w-4 h-4 text-amber-400" />
              <h3 className="text-sm font-display font-semibold">{t('wb.title')}</h3>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={connectSerialScale}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs whitespace-nowrap shrink-0"
              >
                <Usb className="w-3.5 h-3.5 text-amber-400" />
                <span>{t('wb.usbSerial')}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('BLUETOOTH_SPP');
                }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs whitespace-nowrap shrink-0"
              >
                <Bluetooth className="w-3.5 h-3.5 text-sky-400" />
                <span>{t('wb.bluetooth')}</span>
              </button>
            </div>
          </div>

          <div className="bg-slate-950 border border-slate-800 rounded-lg p-4 flex items-center justify-between">
            <div>
              <div className="text-[11px] text-slate-400 uppercase tracking-wider">{t('wb.grossReadout')} ({mode})</div>
              <div className="text-3xl font-mono font-bold tabular-nums text-emerald-400 mt-1">
                {liveReading.toLocaleString('en-IN')} <span className="text-base text-slate-400">{t('common.kg')}</span>
              </div>
              <div className="text-[11px] font-mono text-slate-500 mt-1">{rawSerialString}</div>
            </div>
            <div className="text-right">
              <div className="text-[11px] text-slate-400">{t('wb.netWeight')}</div>
              <div className="text-2xl font-mono font-semibold tabular-nums text-amber-400 mt-1">
                {netWeight.toLocaleString('en-IN')} {t('common.kg')}
              </div>
            </div>
          </div>

          <form onSubmit={handleCaptureWeight} className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block text-slate-400 mb-1">{t('wb.vehicleNo')}</label>
              <input
                type="text"
                required
                value={vehicleNo}
                onChange={(e) => setVehicleNo(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-white font-mono"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">{t('wb.driverName')}</label>
              <input
                type="text"
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
                placeholder={isBn ? 'ঐচ্ছিক' : 'Optional'}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-white"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">{t('wb.grossWeight')}</label>
              <input
                type="number"
                required
                value={liveReading}
                onChange={(e) => {
                  setMode('MANUAL');
                  setLiveReading(Number(e.target.value));
                }}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-white font-mono"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1">{t('wb.tareWeight')}</label>
              <input
                type="number"
                required
                value={tareWeight}
                onChange={(e) => setTareWeight(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-lg bg-slate-950 border border-slate-700 text-white font-mono"
              />
            </div>
            <button
              type="submit"
              className="col-span-2 min-h-[44px] py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-medium"
            >
              {t('wb.captureBtn', { net: netWeight.toLocaleString() })}
            </button>
          </form>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold">
            {t('wb.recentTickets')}
          </div>
          {/* Mobile Cards */}
          <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
            {logs.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-slate-500">
                {isBn ? 'কোনো ওয়েব্রিজ টিকিট নেই।' : 'No weighbridge tickets yet.'}
              </div>
            ) : (
              logs.map((l) => (
                <div key={l.id} className="p-3.5 space-y-1.5 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-mono font-semibold text-slate-900 dark:text-white">{l.ticket_no}</span>
                    <span className="font-mono font-bold text-amber-700 dark:text-amber-400">
                      {l.net_weight_kg.toLocaleString()} {t('common.kg')}
                    </span>
                  </div>
                  <div className="text-slate-600 dark:text-slate-300 font-mono text-[11px]">
                    {l.vehicle_no} · {l.device_mode}
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-500 pt-1">
                    <span>{t('wb.gross')}: {l.gross_weight_kg.toLocaleString()} kg</span>
                    <span>{t('wb.tare')}: {l.tare_weight_kg.toLocaleString()} kg</span>
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
                  <th className="text-left px-3 py-2 font-medium">{t('wb.ticket')}</th>
                  <th className="text-left px-3 py-2 font-medium">{t('wb.vehicleMode')}</th>
                  <th className="text-right px-3 py-2 font-medium">{t('wb.gross')}</th>
                  <th className="text-right px-3 py-2 font-medium">{t('wb.tare')}</th>
                  <th className="text-right px-3 py-2 font-medium">{t('wb.netKg')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2.5 font-mono font-medium">{l.ticket_no}</td>
                    <td className="px-3 py-2.5">
                      <div className="font-mono">{l.vehicle_no}</div>
                      <div className="text-[11px] text-slate-500">{l.device_mode}</div>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{l.gross_weight_kg.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">{l.tare_weight_kg.toLocaleString()}</td>
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums font-semibold">{l.net_weight_kg.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Right: QR Camera Scanner & Traceability Lookup */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4 lg:self-start">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <QrCode className="w-4 h-4 text-amber-600" />
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
              {t('wb.qrTitle')}
            </h3>
          </div>
          <button
            type="button"
            onClick={toggleCameraScanner}
            className="min-h-[44px] flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0"
          >
            <Camera className="w-3.5 h-3.5" />
            <span>{scanningCamera ? t('wb.stopCamera') : t('wb.scanCamera')}</span>
          </button>
        </div>

        {scanningCamera && (
          <div id="qr-camera-reader" className="w-full rounded-lg overflow-hidden border border-slate-200 dark:border-slate-800" />
        )}

        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={qrInput}
              onChange={(e) => setQrInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void lookupQr(qrInput, 'MANUAL');
                }
              }}
              placeholder={t('wb.qrPlaceholder')}
              className="w-full min-h-[44px] pl-9 pr-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
            />
          </div>
          <button
            type="button"
            onClick={() => void lookupQr(qrInput, 'MANUAL')}
            className="min-h-[44px] px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            {t('wb.inspectQr')}
          </button>
        </div>

        {qrResult ? (
          <div className="p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 flex flex-col sm:flex-row gap-4 items-center">
            {qrImg && <img src={qrImg} alt="Verified QR" className="w-32 h-32 rounded-lg border border-slate-200 bg-white p-1" />}
            <div className="flex-1 w-full space-y-1.5 text-xs">
              <div className="font-mono font-semibold text-sm text-slate-900 dark:text-white">
                {qrResult.entity_code} · {qrResult.entity_type}
              </div>
              <div className="font-mono text-[11px] text-slate-500">UUID: {qrResult.qr_code_uid}</div>
              <div className="pt-2 space-y-1">
                {Object.entries(qrResult.payload)
                  .filter(([k]) => !hideFinancials || !FINANCIAL_KEY_RE.test(k))
                  .map(([k, v]) => (
                    <div key={k} className="flex justify-between border-b border-slate-200/70 dark:border-slate-800 py-1 gap-2">
                      <span className="text-slate-500">{k}</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100 text-right">{String(v)}</span>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        ) : (
          <div className="text-center py-8 text-xs text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-xl">
            {t('wb.qrEmpty')}
          </div>
        )}

        {/* Short scrollable list of the last 5 scanned QR logs */}
        <div className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-slate-50/70 dark:bg-slate-950/60">
          <div className="px-3.5 py-2.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2 bg-white dark:bg-slate-900">
            <div className="flex items-center gap-1.5 min-w-0">
              <Clock className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span className="text-xs font-semibold text-slate-800 dark:text-slate-100 truncate">
                {isBn ? 'সর্বশেষ ৫টি স্ক্যান লগ' : 'Last 5 Scanned Logs'}
              </span>
              <span className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-[10px] font-mono text-slate-600 dark:text-slate-300 shrink-0">
                {recentScans.length}/5
              </span>
            </div>
            {recentScans.length > 0 && (
              <button
                type="button"
                onClick={() => persistScans([])}
                className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-red-600 dark:hover:text-red-400 transition-colors shrink-0"
                title={isBn ? 'স্ক্যান ইতিহাস মুছুন' : 'Clear scan history'}
              >
                <Trash2 className="w-3 h-3" />
                <span>{isBn ? 'মুছুন' : 'Clear'}</span>
              </button>
            )}
          </div>

          {recentScans.length === 0 ? (
            <div className="px-4 py-5 text-center text-[11px] text-slate-500">
              {isBn
                ? 'এখনও কোনো QR স্ক্যান করা হয়নি। স্ক্যান বা যাচাই করলে সর্বশেষ ৫টি লগ এখানে দেখা যাবে।'
                : 'No QR codes scanned yet. The last 5 scanned or inspected logs will appear here for quick verification.'}
            </div>
          ) : (
            <div className="max-h-56 overflow-y-auto divide-y divide-slate-200/80 dark:divide-slate-800">
              {recentScans.map((scan) => {
                const isSelected = qrResult?.qr_code_uid === scan.qr_code_uid;
                const previewEntries = Object.entries(scan.payload || {})
                  .filter(([k]) => !hideFinancials || !FINANCIAL_KEY_RE.test(k))
                  .slice(0, 3);
                const scanTime = new Date(scan.scanned_at).toLocaleTimeString(isBn ? 'bn-BD' : 'en-IN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                });

                return (
                  <button
                    key={`${scan.qr_code_uid}-${scan.scanned_at}`}
                    type="button"
                    onClick={() => void displayQrEntry(scan)}
                    className={`w-full text-left px-3.5 py-2.5 transition-colors flex flex-col gap-1 ${
                      isSelected
                        ? 'bg-amber-50/90 dark:bg-amber-950/30'
                        : 'hover:bg-white dark:hover:bg-slate-900/80'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0">
                        {isSelected && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />}
                        <span className="font-mono font-semibold text-xs text-slate-900 dark:text-white truncate">
                          {scan.entity_code}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800 text-[10px] font-mono text-slate-700 dark:text-slate-300 shrink-0">
                          {scan.entity_type}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-500 shrink-0">
                        <span>{scan.source === 'CAMERA' ? (isBn ? 'ক্যামেরা' : 'CAM') : (isBn ? 'ম্যানুয়াল' : 'LOOKUP')}</span>
                        <span>·</span>
                        <span>{scanTime}</span>
                      </div>
                    </div>

                    {previewEntries.length > 0 && (
                      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-600 dark:text-slate-400">
                        {previewEntries.map(([k, v]) => (
                          <span key={k} className="truncate max-w-[200px]">
                            <span className="text-slate-400 dark:text-slate-500">{k}:</span>{' '}
                            <span className="font-mono text-slate-700 dark:text-slate-200">{String(v)}</span>
                          </span>
                        ))}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
