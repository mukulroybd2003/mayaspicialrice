import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, FileText, Printer, QrCode, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import type { InventoryLot } from '../types/erp';
import { getCompanyBranding } from '../utils/companySettings';
import { exportStockBatchQrLabelsPdf, generateQrDataUrl } from '../utils/reports';

interface StockBatchQrModalProps {
  lots: InventoryLot[];
  title?: string;
  hideFinancials?: boolean;
  onClose: () => void;
  onNotify?: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

export function buildLotQrScanString(lot: Pick<InventoryLot, 'lot_code' | 'qr_code_uid'>): string {
  return `SONAGRAIN|LOT|${lot.lot_code}|${lot.qr_code_uid}`;
}

function resolveLotBagsCount(lot: InventoryLot): number {
  if (lot.remaining_bags !== undefined && lot.remaining_bags !== null) {
    return Number(lot.remaining_bags || 0);
  }
  const kg = Number(lot.remaining_qty_kg || 0);
  if (kg <= 0) return 0;
  const pack = Number(lot.pack_size_kg || lot.bag_weight_kg || 50) || 50;
  return Math.round(kg / pack);
}

export const StockBatchQrModal: React.FC<StockBatchQrModalProps> = ({
  lots,
  title,
  hideFinancials = false,
  onClose,
  onNotify,
}) => {
  const { lang } = useI18n();
  const isBn = lang === 'bn';
  const branding = getCompanyBranding(lang);

  const [copiesPerBatch, setCopiesPerBatch] = useState<number>(1);
  const [qrImages, setQrImages] = useState<Record<string, string>>({});
  const [copiedUid, setCopiedUid] = useState<string | null>(null);
  const [exportingPdf, setExportingPdf] = useState(false);

  useEffect(() => {
    let active = true;
    const generateAll = async () => {
      const next: Record<string, string> = {};
      for (const lot of lots) {
        const scanText = buildLotQrScanString(lot);
        try {
          next[lot.qr_code_uid] = await generateQrDataUrl(scanText);
        } catch {
          // ignore QR render failures
        }
      }
      if (active) setQrImages(next);
    };
    void generateAll();
    return () => {
      active = false;
    };
  }, [lots]);

  useEffect(() => {
    const cleanup = () => {
      document.body.classList.remove('printing-qr-labels');
    };
    window.addEventListener('afterprint', cleanup);
    return () => {
      window.removeEventListener('afterprint', cleanup);
      cleanup();
    };
  }, []);

  const expandedLots = useMemo(() => {
    const safeCopies = Math.max(1, Math.min(50, Math.round(copiesPerBatch || 1)));
    const out: Array<{ lot: InventoryLot; copyIdx: number }> = [];
    for (const lot of lots) {
      for (let i = 0; i < safeCopies; i++) {
        out.push({ lot, copyIdx: i + 1 });
      }
    }
    return out;
  }, [lots, copiesPerBatch]);

  const handleCopyScanCode = async (lot: InventoryLot) => {
    const scanText = buildLotQrScanString(lot);
    try {
      await navigator.clipboard?.writeText(scanText);
      setCopiedUid(lot.qr_code_uid);
      setTimeout(() => setCopiedUid((prev) => (prev === lot.qr_code_uid ? null : prev)), 1800);
      onNotify?.(
        isBn ? `QR কোড কপি হয়েছে: ${lot.lot_code}` : `Copied Weighbridge QR payload for ${lot.lot_code}`,
        'ok'
      );
    } catch {
      onNotify?.(scanText, 'warn');
    }
  };

  const handleBrowserPrint = () => {
    document.body.classList.add('printing-qr-labels');
    setTimeout(() => {
      window.print();
      setTimeout(() => {
        document.body.classList.remove('printing-qr-labels');
      }, 800);
    }, 60);
  };

  const handleExportPdf = async (pdfLang: 'en' | 'bn') => {
    setExportingPdf(true);
    try {
      await exportStockBatchQrLabelsPdf({
        lots: expandedLots.map((e) => e.lot),
        hideFinancials,
        lang: pdfLang,
      });
    } catch (err) {
      onNotify?.((err as Error).message, 'err');
    } finally {
      setExportingPdf(false);
    }
  };

  const modalTitle =
    title ||
    (lots.length === 1
      ? isBn
        ? `স্টক ব্যাচ QR ট্রেসিবিলিটি ট্যাগ — ${lots[0].lot_code}`
        : `Stock Batch QR Traceability Tag — ${lots[0].lot_code}`
      : isBn
      ? `প্রিন্টেবল স্টক ব্যাচ QR লেবেল (${lots.length}টি ব্যাচ)`
      : `Printable Stock Batch QR Labels (${lots.length} Batches)`);

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/55 sm:p-4 no-print">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden shadow-xl">
          {/* Header */}
          <div className="px-5 py-3.5 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <QrCode className="w-4 h-4 text-amber-600 shrink-0" />
              <div className="min-w-0">
                <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white truncate">
                  {modalTitle}
                </h4>
                <p className="text-[11px] text-slate-500 truncate">
                  {isBn
                    ? 'ওয়েব্রিজ QR স্ক্যানার ফরম্যাট: SONAGRAIN|LOT|LOT_CODE|QR_UID'
                    : 'Weighbridge Scanner Compatible Format: SONAGRAIN|LOT|LOT_CODE|QR_UID'}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="min-h-[38px] min-w-[38px] flex items-center justify-center rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Print Controls Bar */}
          <div className="px-5 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium text-slate-600 dark:text-slate-300">
                {isBn ? 'প্রতি ব্যাচে কপি:' : 'Copies / Batch:'}
              </span>
              <div className="inline-flex items-center gap-1">
                {[1, 2, 4, 6, 8].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setCopiesPerBatch(n)}
                    className={`px-2 py-1 rounded text-xs font-mono border transition-colors ${
                      copiesPerBatch === n
                        ? 'bg-slate-900 dark:bg-amber-600 text-white border-slate-900 dark:border-amber-600'
                        : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    {n}
                  </button>
                ))}
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={copiesPerBatch}
                  onChange={(e) => setCopiesPerBatch(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                  className="w-14 px-2 py-1 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-mono text-center"
                />
              </div>
              <span className="text-[11px] font-mono text-slate-500">
                ({expandedLots.length} {isBn ? 'টি লেবেল' : 'labels'})
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={handleBrowserPrint}
                disabled={Object.keys(qrImages).length === 0}
                className="min-h-[36px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-amber-600 hover:opacity-95 disabled:opacity-50 text-white text-xs font-medium"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>{isBn ? 'প্রিন্ট লেবেল' : 'Print Labels'}</span>
              </button>
              <button
                type="button"
                onClick={() => void handleExportPdf('en')}
                disabled={exportingPdf}
                className="min-h-[36px] inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>PDF (EN)</span>
              </button>
              <button
                type="button"
                onClick={() => void handleExportPdf('bn')}
                disabled={exportingPdf}
                className="min-h-[36px] inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>PDF (বাংলা)</span>
              </button>
            </div>
          </div>

          {/* Scrollable Batch QR Traceability Cards */}
          <div className="p-4 sm:p-5 overflow-y-auto space-y-3">
            {lots.map((lot) => {
              const qrUrl = qrImages[lot.qr_code_uid];
              const scanString = buildLotQrScanString(lot);
              const bags = resolveLotBagsCount(lot);
              const packKg = Number(lot.pack_size_kg || lot.bag_weight_kg || 50) || 50;
              const isCopied = copiedUid === lot.qr_code_uid;

              return (
                <div
                  key={lot.id}
                  className="p-3.5 sm:p-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 flex flex-col sm:flex-row gap-4 items-center sm:items-start"
                >
                  <div className="shrink-0 flex flex-col items-center gap-1.5">
                    {qrUrl ? (
                      <img
                        src={qrUrl}
                        alt={lot.lot_code}
                        className="w-32 h-32 rounded-lg border border-slate-300 dark:border-slate-700 bg-white p-1.5"
                      />
                    ) : (
                      <div className="w-32 h-32 rounded-lg border border-dashed border-slate-300 dark:border-slate-700 flex items-center justify-center text-[11px] text-slate-400">
                        {isBn ? 'লোড হচ্ছে...' : 'Generating...'}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => void handleCopyScanCode(lot)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-[10px] font-mono text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                      {isCopied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                      <span>{isCopied ? (isBn ? 'কপি হয়েছে' : 'Copied') : isBn ? 'QR কোড কপি' : 'Copy QR Code'}</span>
                    </button>
                  </div>

                  <div className="flex-1 w-full space-y-2 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="font-mono font-bold text-sm text-slate-900 dark:text-white">
                          {lot.lot_code}
                        </div>
                        <div className="font-medium text-slate-700 dark:text-slate-200">
                          {lot.item_name || `Item #${lot.item_id}`}{' '}
                          {lot.sku && <span className="font-mono text-[11px] text-slate-500">({lot.sku})</span>}
                        </div>
                      </div>
                      <span className="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-300 font-mono text-[10px] font-semibold">
                        {lot.source_type}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 p-2.5 text-[11px]">
                      <div>
                        <div className="text-slate-400">{isBn ? 'গোডাউন' : 'Warehouse'}</div>
                        <div className="font-medium text-slate-900 dark:text-white truncate">
                          {lot.warehouse_name || `#${lot.warehouse_id}`}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-400">{isBn ? 'বর্তমান / মোট ওজন' : 'Stock / Initial'}</div>
                        <div className="font-mono font-semibold text-slate-900 dark:text-white">
                          {Number(lot.remaining_qty_kg || 0).toLocaleString('en-IN')} /{' '}
                          {Number(lot.initial_qty_kg || 0).toLocaleString('en-IN')} kg
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-400">{isBn ? 'বস্তা ও প্যাক' : 'Bags & Pack'}</div>
                        <div className="font-mono font-semibold text-slate-900 dark:text-white">
                          {bags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'} · {packKg} kg
                        </div>
                      </div>
                      {(lot.origin_batch_no || lot.origin_dryer_no) && (
                        <div>
                          <div className="text-slate-400">{isBn ? 'উৎপাদন ব্যাচ / ডায়ার' : 'Origin Batch / Dryer'}</div>
                          <div className="font-mono text-slate-900 dark:text-white">
                            {[lot.origin_batch_no, lot.origin_dryer_no].filter(Boolean).join(' · ')}
                          </div>
                        </div>
                      )}
                      {lot.moisture_pct !== undefined && lot.moisture_pct !== null && (
                        <div>
                          <div className="text-slate-400">{isBn ? 'আর্দ্রতা' : 'Moisture'}</div>
                          <div className="font-mono text-slate-900 dark:text-white">{lot.moisture_pct}%</div>
                        </div>
                      )}
                      <div>
                        <div className="text-slate-400">{isBn ? 'গ্রহণের তারিখ' : 'Received Date'}</div>
                        <div className="font-mono text-slate-900 dark:text-white">
                          {String(lot.received_at || '').slice(0, 16)}
                        </div>
                      </div>
                      {!hideFinancials && (
                        <div>
                          <div className="text-slate-400">{isBn ? 'ইউনিট কস্ট' : 'Unit Cost'}</div>
                          <div className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                            ৳{Number(lot.unit_cost_per_kg || 0).toFixed(2)}/kg
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="px-2.5 py-1.5 rounded bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 font-mono text-[10px] text-slate-600 dark:text-slate-400 break-all">
                      {scanString}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Hidden on screen; exclusively printed when Print Labels is clicked */}
      {typeof document !== 'undefined' &&
        createPortal(
          <div id="qr-label-print-portal" lang={lang} className="hidden print:block p-2">
            <div className="flex items-center justify-between border-b-2 border-black pb-2 mb-3">
              <div className="flex items-center gap-2 text-xs font-bold uppercase">
                {branding.logoDataUrl && (
                  <img
                    src={branding.logoDataUrl}
                    alt={branding.name}
                    className="w-6 h-6 object-contain border border-black bg-white p-0.5 shrink-0"
                  />
                )}
                <span>
                  {branding.name} — {isBn ? 'স্টক ব্যাচ QR ট্রেসিবিলিটি লেবেল' : 'STOCK BATCH QR TRACEABILITY LABELS'}
                </span>
              </div>
              <div className="text-[10px] font-mono">
                {expandedLots.length} {isBn ? 'টি ট্যাগ' : 'TAG(S)'}
              </div>
            </div>
            <div className="qr-print-grid">
              {expandedLots.map(({ lot, copyIdx }) => {
                const qrUrl = qrImages[lot.qr_code_uid];
                const scanString = buildLotQrScanString(lot);
                const bags = resolveLotBagsCount(lot);
                const packKg = Number(lot.pack_size_kg || lot.bag_weight_kg || 50) || 50;
                return (
                  <div key={`${lot.id}-${copyIdx}`} className="qr-label-card">
                    <div className="flex items-center justify-between border-b border-black pb-1 mb-1.5 text-[10px] font-bold">
                      <span className="font-mono">
                        {branding.shortCode} · {lot.lot_code}
                      </span>
                      <span className="font-mono">{lot.source_type}</span>
                    </div>
                    <div className="flex items-start gap-2.5">
                      {qrUrl && (
                        <img
                          src={qrUrl}
                          alt={lot.lot_code}
                          className="w-24 h-24 shrink-0 border border-black bg-white p-0.5"
                        />
                      )}
                      <div className="flex-1 min-w-0 text-[9.5px] leading-snug space-y-0.5">
                        <div className="font-bold text-[10.5px] truncate">
                          {lot.item_name || `Item #${lot.item_id}`}
                        </div>
                        {lot.sku && <div className="font-mono text-[8.5px]">SKU: {lot.sku}</div>}
                        <div>
                          {isBn ? 'গোডাউন:' : 'Godown:'} {lot.warehouse_name || `#${lot.warehouse_id}`}
                        </div>
                        <div className="font-mono font-semibold">
                          {Number(lot.remaining_qty_kg || 0).toLocaleString('en-IN')} kg · {bags}{' '}
                          {isBn ? 'বস্তা' : 'bags'} ({packKg} kg)
                        </div>
                        {(lot.origin_batch_no || lot.origin_dryer_no) && (
                          <div className="font-mono text-[8.5px]">
                            {isBn ? 'ব্যাচ:' : 'Batch:'}{' '}
                            {[lot.origin_batch_no, lot.origin_dryer_no].filter(Boolean).join(' · ')}
                          </div>
                        )}
                        {lot.moisture_pct !== undefined && lot.moisture_pct !== null && (
                          <div className="font-mono text-[8.5px]">
                            {isBn ? 'আর্দ্রতা:' : 'Moisture:'} {lot.moisture_pct}%
                          </div>
                        )}
                        <div className="font-mono text-[8.5px]">
                          {isBn ? 'তারিখ:' : 'Date:'} {String(lot.received_at || '').slice(0, 10)}
                        </div>
                      </div>
                    </div>
                    <div className="mt-1.5 pt-1 border-t border-black/30 font-mono text-[7.5px] break-all">
                      {scanString}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
