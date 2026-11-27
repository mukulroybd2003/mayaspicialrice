import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import jsPDF from 'jspdf';
import QRCode from 'qrcode';
import * as XLSX from 'xlsx';
import type { AppLang } from '../i18n/translations';
import { getCompanyBranding } from './companySettings';
import type {
  Account,
  AccountLedgerRow,
  CashbookReport,
  DirectPaddySale,
  FinancialStatements,
  InventoryLot,
  JournalEntry,
  PaddyPurchase,
  PaddyPurchaseReturn,
  ProductionBatch,
  ProductionExpensePayment,
  SalesInvoice,
  SupplierBagLedgerEntry,
  SupplierBagSummary,
} from '../types/erp';

export type PdfDeliveryMode = 'open' | 'download';

if (typeof document !== 'undefined' && document.fonts?.load) {
  const bnSample = 'অআকখ বাংলা ১২০';
  void document.fonts.load('400 12px "DM Sans"');
  void document.fonts.load('600 12px "DM Sans"');
  void document.fonts.load('700 14px "Plus Jakarta Sans"');
  void document.fonts.load('400 14px "SutonnyBanglaUnicode"', bnSample);
  void document.fonts.load('700 16px "SutonnyBanglaUnicode"', bnSample);
  void document.fonts.load('400 14px "Noto Serif Bengali"', bnSample);
  void document.fonts.load('500 14px "Noto Serif Bengali"', bnSample);
  void document.fonts.load('600 14px "Noto Serif Bengali"', bnSample);
  void document.fonts.load('700 16px "Noto Serif Bengali"', bnSample);
  void document.fonts.load('400 14px "Tiro Bangla"', bnSample);
  void document.fonts.load('400 12px "Noto Sans Bengali"', bnSample);
  void document.fonts.load('600 13px "Noto Sans Bengali"', bnSample);
  void document.fonts.load('700 14px "Noto Sans Bengali"', bnSample);
}

async function shareNativeFile(filename: string, base64Data: string, title: string): Promise<void> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const res = await Filesystem.writeFile({
    path: safeName,
    data: base64Data,
    directory: Directory.Cache,
  });
  await Share.share({
    title,
    url: res.uri,
    dialogTitle: title,
  });
}

function deliverPdfDocument(
  doc: jsPDF,
  filename: string,
  title: string,
  mode: PdfDeliveryMode = 'open'
): string {
  doc.setProperties({ title: `${title} (${filename})` });

  if (Capacitor.isNativePlatform()) {
    const dataUri = doc.output('datauristring');
    const base64 = dataUri.split(',')[1] || '';
    void shareNativeFile(filename, base64, title).catch(() => {
      doc.save(filename);
    });
    return '';
  }

  const isStandalonePwa =
    typeof window !== 'undefined' &&
    (window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true);

  if (mode === 'download' || isStandalonePwa) {
    doc.save(filename);
    return '';
  }

  const rawBlob = doc.output('blob');
  const pdfBlob = new Blob([rawBlob], { type: 'application/pdf' });
  const blobUrl = URL.createObjectURL(pdfBlob);

  const link = document.createElement('a');
  link.href = blobUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  setTimeout(() => {
    URL.revokeObjectURL(blobUrl);
  }, 180_000);

  return blobUrl;
}

export async function generateQrDataUrl(text: string): Promise<string> {
  return QRCode.toDataURL(text, {
    width: 220,
    margin: 2,
    color: { dark: '#000000', light: '#FFFFFF' },
  });
}

export function exportExcelWorkbook(
  filename: string,
  sheets: Array<{ name: string; rows: Record<string, unknown>[] }>,
  lang: AppLang = 'en'
) {
  const wb = XLSX.utils.book_new();
  const branding = getCompanyBranding(lang);
  const ts = new Date().toLocaleString(lang === 'bn' ? 'bn-BD' : 'en-IN');
  const emptyNotice: Record<string, unknown> =
    lang === 'bn'
      ? { তথ্য: 'কোনো রেকর্ড পাওয়া যায়নি' }
      : { Notice: 'No records available' };

  for (const sheet of sheets) {
    const safeRows: Record<string, unknown>[] = sheet.rows.length > 0 ? sheet.rows : [emptyNotice];
    const headers = Object.keys(safeRows[0]);
    const titleBanner = [[`${branding.name} — ${sheet.name}`], [`${branding.metaLine ? `${branding.metaLine}  |  ` : ''}${lang === 'bn' ? 'তৈরির সময়' : 'Generated'}: ${ts}`], []];
    const ws = XLSX.utils.aoa_to_sheet(titleBanner);
    XLSX.utils.sheet_add_json(ws, safeRows, { origin: 'A4' });

    // Auto-fit column widths so numbers & Bangla text never truncate to ###
    ws['!cols'] = headers.map((h) => {
      let maxLen = h.length * 1.25;
      for (const r of safeRows) {
        const val = r[h] === null || r[h] === undefined ? '' : String(r[h]);
        const hasBn = /[^\u0000-\u007F]/.test(val);
        const effLen = val.length * (hasBn ? 1.3 : 1.05);
        if (effLen > maxLen) maxLen = effLen;
      }
      return { wch: Math.min(46, Math.max(13, Math.ceil(maxLen) + 3)) };
    });

    XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31));
  }
  const outName = `${filename}-${lang}.xlsx`;
  if (Capacitor.isNativePlatform()) {
    const b64 = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' }) as string;
    void shareNativeFile(outName, b64, filename).catch(() => {
      XLSX.writeFile(wb, outName);
    });
    return;
  }
  XLSX.writeFile(wb, outName);
}

const PDF_CANVAS_SCALE = 4;
const FONT_STACK_EN = '"Calibri", "Plus Jakarta Sans", "DM Sans", "Segoe UI", "SutonnyBanglaUnicode", "Noto Serif Bengali", "Tiro Bangla", "Noto Sans Bengali", system-ui, sans-serif';
const FONT_STACK_BN = '"SutonnyBanglaUnicode", "Noto Serif Bengali", "Tiro Bangla", "Noto Sans Bengali", serif';

function getPdfFontStack(lang: AppLang): string {
  return lang === 'bn' ? FONT_STACK_BN : FONT_STACK_EN;
}

function createHiResPdfCanvas(ptW: number, ptH: number): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(ptW * PDF_CANVAS_SCALE);
  canvas.height = Math.round(ptH * PDF_CANVAS_SCALE);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(PDF_CANVAS_SCALE, PDF_CANVAS_SCALE);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, ptW, ptH);
  return { canvas, ctx };
}

function wrapCellText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const str = String(text ?? '');
  if (!str) return [''];
  const words = str.split(/\s+/);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      if (current) {
        lines.push(current);
        current = '';
      }
      if (ctx.measureText(word).width <= maxWidth) {
        current = word;
      } else {
        let chunk = '';
        for (const ch of word) {
          if (ctx.measureText(chunk + ch).width <= maxWidth) {
            chunk += ch;
          } else {
            if (chunk) lines.push(chunk);
            chunk = ch;
          }
        }
        current = chunk;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [''];
}

const BN_DIGITS = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];

export function toBnDigits(input: string | number): string {
  return String(input ?? '').replace(/\d/g, (d) => BN_DIGITS[Number(d)]);
}

const BN_PDF_TOKEN_MAP: Array<[RegExp, string]> = [
  [/\bPARBOILED_SIDDHO\b/g, 'সিদ্ধ'],
  [/\bRAW_ATAP\b/g, 'আতপ'],
  [/\bCOMPLETED\b/g, 'সম্পন্ন'],
  [/\bIN_PROGRESS\b/g, 'চলমান'],
  [/\bPAID\b/g, 'পরিশোধিত'],
  [/\bPARTIAL\b/g, 'আংশিক'],
  [/\bUNPAID\b/g, 'বকেয়া'],
  [/\bCASH_REFUND\b/g, 'নগদ ফেরত'],
  [/\bADJUST_PAYABLE\b/g, 'বকেয়া সমন্বয়'],
  [/\bBANK_TRANSFER\b/g, 'ব্যাংক ট্রান্সফার'],
  [/\bUPI_MOBILE\b/g, 'মোবাইল ব্যাংকিং'],
  [/\bCHEQUE\b/g, 'চেক'],
  [/\bCASH\b/g, 'নগদ'],
  [/\bMANUAL\b/g, 'ম্যানুয়াল'],
  [/\bUSB_SERIAL\b/g, 'ডিজিটাল স্কেল (USB)'],
  [/\bBLUETOOTH_SPP\b/g, 'ব্লুটুথ স্কেল'],
  [/\bHEAD_RICE\b/g, 'মূল চাল'],
  [/\bBROKEN_RICE\b/g, 'ভাঙা চাল / খুদ'],
  [/\bRICE_BRAN\b/g, 'চালের কুঁড়া'],
  [/\bHUSK\b/g, 'তুষ'],
  [/\bBY_PRODUCT\b/g, 'উপজাত'],
  [/\bPADDY_PURCHASE_RETURN\b/g, 'ধান ক্রয় ফেরত'],
  [/\bPADDY_PURCHASE\b/g, 'ধান ক্রয়'],
  [/\bPURCHASE_RETURN\b/g, 'ক্রয় ফেরত'],
  [/\bPURCHASE_IN\b/g, 'ক্রয় জমা'],
  [/\bTRANSFER_IN\b/g, 'স্থানান্তর আগত'],
  [/\bTRANSFER_OUT\b/g, 'স্থানান্তর প্রেরণ'],
  [/\bPRODUCTION_INPUT\b/g, 'ক্রাশিং ইনপুট'],
  [/\bPRODUCTION_OUTPUT\b/g, 'উৎপাদন আউটপুট'],
  [/\bPRODUCTION_EXPENSE_PAYMENT\b/g, 'ক্রাশিং খরচ পরিশোধ'],
  [/\bPRODUCTION_BATCH\b/g, 'উৎপাদন ব্যাচ'],
  [/\bRICE_SALE_OUT\b/g, 'চাল বিক্রয়'],
  [/\bDIRECT_SALE_OUT\b/g, 'সরাসরি ধান বিক্রয়'],
  [/\bDRYING_IN\b/g, 'ড্রাইং আউটপুট'],
  [/\bDRYING_OUT\b/g, 'ড্রাইং ইনপুট'],
  [/\bSALES_INVOICE\b/g, 'বিক্রয় চালান'],
  [/\bPADDY_SALE\b/g, 'ধান বিক্রয়'],
  [/\bDUE_PAYMENT\b/g, 'বকেয়া পরিশোধ'],
  [/\bADVANCE_PAYMENT\b/g, 'অগ্রিম প্রদান'],
  [/\bDUE_RECEIPT\b/g, 'বকেয়া আদায়'],
  [/\bADVANCE_RECEIPT\b/g, 'অগ্রিম গ্রহণ'],
  [/\bDUE_SETTLEMENT\b/g, 'বকেয়া সমন্বয়'],
  [/\bWEIGHTED_AVERAGE\b/g, 'ওয়েটেড গড়'],
  [/\bFIFO\b/g, 'ফিফো (FIFO)'],
  [/\bASSET\b/g, 'সম্পদ'],
  [/\bLIABILITY\b/g, 'দায়'],
  [/\bEQUITY\b/g, 'মূলধন'],
  [/\bREVENUE\b/g, 'আয়'],
  [/\bEXPENSE\b/g, 'ব্যয়'],
  [/\bLIABILITY\b/g, 'দায়'],
  [/\bGENERAL\b/g, 'সাধারণ'],
  [/\bLABOR\b/g, 'শ্রমিক'],
  [/\bELECTRICITY\b/g, 'বিদ্যুৎ'],
  [/\bFUEL\b/g, 'জ্বালানি'],
  [/\bBOILER\b/g, 'বয়লার'],
  [/\bMACHINERY\b/g, 'মেশিনারি'],
  [/\bPACKAGING\b/g, 'প্যাকেজিং'],
  [/\bSUN_YARD\b/g, 'চাতাল (রোদে)'],
  [/\bMECHANICAL_DRYER\b/g, 'মেকানিক্যাল ড্রায়ার'],
  [/\bADVANCE_ISSUE\b/g, 'অগ্রিম খালি বস্তা প্রদান'],
  [/\bEMPTY_PICKUP\b/g, 'জমা থেকে খালি বস্তা উত্তোলন'],
  [/\bEMPTY_RETURN\b/g, 'খালি বস্তা ফেরত'],
  [/\bPADDY_DEPOSIT\b/g, 'ধানের সাথে বস্তা জমা'],
  [/\bOUT_TO_SUPPLIER\b/g, 'সাপ্লায়ারকে প্রদান'],
  [/\bIN_FROM_SUPPLIER\b/g, 'সাপ্লায়ার থেকে প্রাপ্ত'],
  [/\bBALANCED\b/g, 'সুষম'],
  [/\bUNBALANCED\b/g, 'অসম'],
  [/\bOPEN-BAL\b/g, 'প্রারম্ভিক জের'],
  [/\bACTIVE\b/g, 'সক্রিয়'],
  [/\bINACTIVE\b/g, 'নিষ্ক্রিয়'],
  [/\bCUSTOMER\b/g, 'কাস্টমার'],
  [/\bSUPPLIER\b/g, 'সাপ্লায়ার'],
  [/\bBOTH\b/g, 'উভয়'],
  [/\bDIRECT_SALE\b/g, 'সরাসরি বিক্রয়'],
  [/\bADJUSTMENT\b/g, 'সমন্বয়'],
  [/\bRECEIPT\b/g, 'রিসিপ্ট'],
  [/\bPAYMENT\b/g, 'পেমেন্ট'],
  [/\bJOURNAL\b/g, 'জার্নাল'],
  [/\bCONTRA\b/g, 'কন্ট্রা'],
  [/\bDryer-/g, 'ডায়ার-'],
  [/\bDryer\b/g, 'ডায়ার'],
  [/\bkg\b/gi, 'কেজি'],
  [/\bbags?\b/gi, 'বস্তা'],
  [/\bunits?\b/gi, 'ইউনিট'],
  [/\bDr\b/g, 'ডেবিট'],
  [/\bCr\b/g, 'ক্রেডিট'],
  [/\bBDT\b/g, 'টাকা'],
];

export function localizePdfText(input: unknown, lang: AppLang): string {
  const raw = String(input ?? '');
  if (!raw || lang !== 'bn') return raw;
  let out = raw;
  for (const [pattern, replacement] of BN_PDF_TOKEN_MAP) {
    out = out.replace(pattern, replacement);
  }
  return toBnDigits(out);
}

function isNumericOrRightAlignedValue(val: string): boolean {
  const s = String(val ?? '').trim();
  if (!s || s === '-' || s === '—') return false;
  return /^[-+৳₹\d০-৯,.\s]+(%|kg|কেজি|বস্তা|u|units?|ইউনিট|Dr|Cr|ডেবিট|ক্রেডিট)?$/i.test(s);
}

function isSummaryOrTotalRow(row: (string | number)[]): boolean {
  const firstTwo = `${String(row[0] ?? '')} ${String(row[1] ?? '')}`.toUpperCase();
  return /TOTAL|GRAND TOTAL|GODOWN TOTAL|NET PROFIT|GROSS PROFIT|NET HEAD RICE|BALANCE SHEET|মোট|সর্বমোট|গোডাউন মোট|নিট লাভ|মোট মুনাফা|মোট সম্পদ|মোট দায়|মোট ব্যয়|মোট আয়/.test(
    firstTwo
  );
}

function isGrandTotalRow(row: (string | number)[]): boolean {
  const firstTwo = `${String(row[0] ?? '')} ${String(row[1] ?? '')}`.toUpperCase();
  return /GRAND TOTAL|COMBINED ALL|TOTAL ASSETS|TOTAL LIABILITIES|NET PROFIT|সর্বমোট|সকল গোডাউন|মোট সম্পদ|মোট দায় ও মালিকানা|নিট লাভ/.test(
    firstTwo
  );
}

async function renderUnicodeCanvasPdf(params: {
  orientation: 'landscape' | 'portrait';
  brand: string;
  title: string;
  subtitle: string;
  footerLeft: string;
  lang: AppLang;
  filename: string;
  tables: Array<{
    head: string[];
    body: (string | number)[][];
    headFill?: string;
  }>;
  summaryLine?: string;
  mode?: PdfDeliveryMode;
}) {
  await ensurePdfFontsLoaded();

  const branding = getCompanyBranding(params.lang);
  const isBn = params.lang === 'bn';
  const loc = (v: unknown) => localizePdfText(v, params.lang);
  const localizedTitle = loc(params.title);
  const localizedSubtitle = loc(params.subtitle);
  const localizedSummaryLine = params.summaryLine ? loc(params.summaryLine) : undefined;
  const localizedTables = params.tables.map((t) => ({
    ...t,
    head: t.head.map((h) => loc(h)),
    body: t.body.map((r) => r.map((c) => loc(c))),
  }));

  const ptW = params.orientation === 'landscape' ? 841.89 : 595.28;
  const ptH = params.orientation === 'landscape' ? 595.28 : 841.89;
  const marginX = params.orientation === 'landscape' ? 34 : 38;
  const marginTop = 28;
  const marginBottom = 44;
  const contentW = ptW - marginX * 2;
  const fontStack = getPdfFontStack(params.lang);
  const ts = loc(new Date().toLocaleString(isBn ? 'bn-BD' : 'en-IN'));

  const pages: HTMLCanvasElement[] = [];

  const createPage = (isFirst: boolean): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; startY: number } => {
    const { canvas, ctx } = createHiResPdfCanvas(ptW, ptH);

    let y = marginTop;
    if (isFirst) {
      // Authentic Microsoft Word Official Document Masthead
      const emblemSize = 36;
      drawCompanyEmblem(ctx, marginX, y + 2, emblemSize, branding, fontStack);

      // Right Side Official Date & Currency Metadata
      const rightEdge = marginX + contentW;
      ctx.textAlign = 'right';
      ctx.fillStyle = '#1F2937';
      ctx.font = `600 9px ${fontStack}`;
      ctx.fillText(`${isBn ? 'তারিখ' : 'Date'}: ${ts}`, rightEdge, y + 15);
      ctx.font = `500 9px ${fontStack}`;
      ctx.fillText(isBn ? 'মুদ্রা: টাকা (৳ BDT)' : 'Currency: BDT (৳)', rightEdge, y + 29);
      ctx.textAlign = 'left';

      // Centered Company Masthead
      const centerX = ptW / 2;
      const centerMaxW = contentW - 220;
      ctx.textAlign = 'center';
      ctx.fillStyle = '#000000';
      ctx.font = `700 17.5px ${fontStack}`;
      ctx.fillText(isBn ? branding.name : branding.name.toUpperCase(), centerX, y + 17, centerMaxW);

      ctx.fillStyle = '#111827';
      ctx.font = `600 10px ${fontStack}`;
      ctx.fillText(branding.tagline, centerX, y + 32, centerMaxW);

      ctx.fillStyle = '#1F2937';
      ctx.font = `400 9.5px ${fontStack}`;
      ctx.fillText(branding.metaLine || params.footerLeft, centerX, y + 46, contentW - 110);
      ctx.textAlign = 'left';

      // Classic MS Word Double Horizontal Rule
      const ruleY = y + 56;
      ctx.fillStyle = '#000000';
      ctx.fillRect(marginX, ruleY, contentW, 1.5);
      ctx.fillRect(marginX, ruleY + 3, contentW, 0.6);

      // Centered Underlined Document Title (Official MS Word Style)
      ctx.textAlign = 'center';
      ctx.fillStyle = '#000000';
      ctx.font = `700 13px ${fontStack}`;
      const titleY = ruleY + 21;
      ctx.fillText(localizedTitle, centerX, titleY, contentW - 20);
      const measuredTitleW = Math.min(contentW - 20, ctx.measureText(localizedTitle).width);
      ctx.fillRect(centerX - measuredTitleW / 2 - 6, titleY + 4, measuredTitleW + 12, 1);
      ctx.textAlign = 'left';

      y = ruleY + 34;

      // Formal Word Bordered Summary Table Strip parsed from subtitle segments
      const segments = String(localizedSubtitle || '')
        .split('|')
        .map((s) => s.trim())
        .filter(Boolean);

      if (segments.length >= 2 && segments.length <= 4) {
        const segW = contentW / segments.length;
        const rowH = 38;
        ctx.fillStyle = '#F8FAFC';
        ctx.fillRect(marginX, y, contentW, rowH);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1;
        ctx.strokeRect(marginX, y, contentW, rowH);

        segments.forEach((seg, idx) => {
          const cx = marginX + idx * segW;
          if (idx > 0) {
            ctx.strokeStyle = '#475569';
            ctx.lineWidth = 0.75;
            ctx.beginPath();
            ctx.moveTo(cx, y);
            ctx.lineTo(cx, y + rowH);
            ctx.stroke();
          }

          const colonIdx = seg.indexOf(':');
          if (colonIdx > 0 && colonIdx < 28) {
            const k = seg.slice(0, colonIdx).trim();
            const v = seg.slice(colonIdx + 1).trim();
            ctx.fillStyle = '#1F2937';
            ctx.font = `600 9px ${fontStack}`;
            ctx.fillText(k, cx + 8, y + 14.5, segW - 16);
            ctx.fillStyle = '#000000';
            ctx.font = `700 10px ${fontStack}`;
            ctx.fillText(v, cx + 8, y + 29.5, segW - 16);
          } else {
            ctx.fillStyle = '#000000';
            ctx.font = `600 9.5px ${fontStack}`;
            ctx.fillText(seg, cx + 8, y + 22.5, segW - 16);
          }
        });
        y += rowH + 12;
      } else if (localizedSubtitle) {
        ctx.fillStyle = '#F8FAFC';
        ctx.fillRect(marginX, y, contentW, 28);
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 0.9;
        ctx.strokeRect(marginX, y, contentW, 28);
        ctx.fillStyle = '#000000';
        ctx.font = `600 9.5px ${fontStack}`;
        ctx.fillText(localizedSubtitle, marginX + 10, y + 17.5, contentW - 20);
        y += 38;
      }
    } else {
      // Continuation page running Word header
      ctx.fillStyle = '#000000';
      ctx.font = `700 10px ${fontStack}`;
      ctx.fillText(`${branding.name} — ${localizedTitle}`, marginX, y + 12, contentW * 0.72);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#1F2937';
      ctx.font = `400 9px ${fontStack}`;
      ctx.fillText(ts, marginX + contentW, y + 12);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#000000';
      ctx.fillRect(marginX, y + 18, contentW, 1);
      y += 28;
    }

    pages.push(canvas);
    return { canvas, ctx, startY: y };
  };

  let page = createPage(true);
  let y = page.startY;

  for (const tbl of localizedTables) {
    const colsCount = Math.max(1, tbl.head.length);
    const isWideTable = params.orientation === 'landscape' && colsCount >= 6;
    const tableFontSize = isWideTable ? 9.5 : 10;
    const tableLineH = isWideTable ? 13.5 : 14;
    const colWidths: number[] = new Array(colsCount).fill(contentW / colsCount);

    // Determine column alignment (right-align numeric/money columns automatically)
    const colAlign: Array<'left' | 'right'> = new Array(colsCount).fill('left');
    for (let cIdx = 0; cIdx < colsCount; cIdx++) {
      let numHits = 0;
      let nonEmpty = 0;
      for (const row of tbl.body.slice(0, 30)) {
        const cell = String(row[cIdx] ?? '').trim();
        if (!cell || cell === '-' || cell === '—') continue;
        nonEmpty++;
        if (isNumericOrRightAlignedValue(cell)) numHits++;
      }
      if (nonEmpty > 0 && numHits / nonEmpty >= 0.6) {
        colAlign[cIdx] = 'right';
      }
    }

    // Measure natural column widths using official table font size
    page.ctx.font = `700 ${tableFontSize}px ${fontStack}`;
    const desired = tbl.head.map((h) => Math.min(205, Math.max(46, page.ctx.measureText(String(h)).width + 18)));
    page.ctx.font = `400 ${tableFontSize}px ${fontStack}`;
    for (const row of tbl.body.slice(0, 50)) {
      row.forEach((cell, idx) => {
        if (idx < colsCount) {
          const w = Math.min(220, Math.max(42, page.ctx.measureText(String(cell ?? '')).width + 18));
          if (w > desired[idx]) desired[idx] = w;
        }
      });
    }
    const desiredSum = desired.reduce((a, b) => a + b, 0) || contentW;
    for (let i = 0; i < colsCount; i++) {
      colWidths[i] = (desired[i] / desiredSum) * contentW;
    }

    const drawHeaderRow = (curCtx: CanvasRenderingContext2D, curY: number): number => {
      curCtx.font = `700 ${tableFontSize}px ${fontStack}`;
      const headerWrapped = tbl.head.map((h, i) => wrapCellText(curCtx, String(h), Math.max(22, colWidths[i] - 12)));
      const maxLines = Math.max(1, ...headerWrapped.map((l) => l.length));
      const rowH = Math.max(27, maxLines * tableLineH + 12);

      // MS Word Table Grid Header
      curCtx.fillStyle = tbl.headFill || '#EDEDED';
      curCtx.fillRect(marginX, curY, contentW, rowH);
      curCtx.strokeStyle = '#000000';
      curCtx.lineWidth = 1;
      curCtx.strokeRect(marginX, curY, contentW, rowH);

      curCtx.fillStyle = '#000000';
      let x = marginX;
      headerWrapped.forEach((lines, idx) => {
        const alignRight = colAlign[idx] === 'right';
        lines.forEach((line, li) => {
          if (alignRight) {
            curCtx.textAlign = 'right';
            curCtx.fillText(line, x + colWidths[idx] - 7, curY + 16.5 + li * tableLineH);
            curCtx.textAlign = 'left';
          } else {
            curCtx.fillText(line, x + 7, curY + 16.5 + li * tableLineH);
          }
        });
        if (idx < colsCount - 1) {
          curCtx.strokeStyle = '#334155';
          curCtx.lineWidth = 0.75;
          curCtx.beginPath();
          curCtx.moveTo(x + colWidths[idx], curY);
          curCtx.lineTo(x + colWidths[idx], curY + rowH);
          curCtx.stroke();
        }
        x += colWidths[idx];
      });
      return curY + rowH;
    };

    if (y + 56 > ptH - marginBottom) {
      page = createPage(false);
      y = page.startY;
    }
    y = drawHeaderRow(page.ctx, y);

    const rowsToRender =
      tbl.body.length > 0
        ? tbl.body
        : [[isBn ? 'কোনো রেকর্ড নেই' : 'No records available', ...new Array(Math.max(0, colsCount - 1)).fill('')]];

    rowsToRender.forEach((row) => {
      const c = page.ctx;
      const isTotal = isSummaryOrTotalRow(row);
      const isGrand = isGrandTotalRow(row);
      c.font = `${isTotal ? '700' : '400'} ${tableFontSize}px ${fontStack}`;
      const wrappedCols = tbl.head.map((_, idx) =>
        wrapCellText(c, String(row[idx] ?? ''), Math.max(20, colWidths[idx] - 12))
      );
      const maxLines = Math.max(1, ...wrappedCols.map((l) => l.length));
      const rowH = Math.max(isTotal ? 26 : 24, maxLines * tableLineH + 10);

      if (y + rowH > ptH - marginBottom) {
        page = createPage(false);
        y = page.startY;
        y = drawHeaderRow(page.ctx, y);
      }

      const activeCtx = page.ctx;
      if (isGrand) {
        activeCtx.fillStyle = '#E5E7EB';
        activeCtx.fillRect(marginX, y, contentW, rowH);
      } else if (isTotal) {
        activeCtx.fillStyle = '#F3F4F6';
        activeCtx.fillRect(marginX, y, contentW, rowH);
      } else {
        activeCtx.fillStyle = '#FFFFFF';
        activeCtx.fillRect(marginX, y, contentW, rowH);
      }

      // Authentic MS Word Table Grid borders
      activeCtx.strokeStyle = isGrand || isTotal ? '#000000' : '#475569';
      activeCtx.lineWidth = isGrand ? 1.15 : isTotal ? 0.95 : 0.6;
      activeCtx.strokeRect(marginX, y, contentW, rowH);

      let x = marginX;
      wrappedCols.forEach((lines, idx) => {
        if (idx < colsCount - 1) {
          activeCtx.strokeStyle = isTotal ? '#334155' : '#64748B';
          activeCtx.lineWidth = 0.6;
          activeCtx.beginPath();
          activeCtx.moveTo(x + colWidths[idx], y);
          activeCtx.lineTo(x + colWidths[idx], y + rowH);
          activeCtx.stroke();
        }

        const rawCell = String(row[idx] ?? '');
        const isStatusBold = /আমরা পাবো|WE GET|সাপ্লায়ার পাবে|SUPPLIER GETS|BALANCED|সুষম ✓|UNBALANCED|অসম|^-\s*৳/i.test(rawCell);
        const textColor = isTotal || isStatusBold ? '#000000' : '#111827';
        const cellWeight = isTotal || isStatusBold ? '700' : '400';

        activeCtx.fillStyle = textColor;
        activeCtx.font = `${cellWeight} ${tableFontSize}px ${fontStack}`;
        const alignRight = colAlign[idx] === 'right';
        lines.forEach((line, li) => {
          if (alignRight) {
            activeCtx.textAlign = 'right';
            activeCtx.fillText(line, x + colWidths[idx] - 7, y + 16 + li * tableLineH);
            activeCtx.textAlign = 'left';
          } else {
            activeCtx.fillText(line, x + 7, y + 16 + li * tableLineH);
          }
        });
        x += colWidths[idx];
      });
      y += rowH;
    });

    y += 14;
  }

  if (localizedSummaryLine) {
    if (y + 36 > ptH - marginBottom) {
      page = createPage(false);
      y = page.startY;
    }
    page.ctx.fillStyle = '#F3F4F6';
    page.ctx.fillRect(marginX, y, contentW, 28);
    page.ctx.strokeStyle = '#000000';
    page.ctx.lineWidth = 1;
    page.ctx.strokeRect(marginX, y, contentW, 28);
    page.ctx.fillStyle = '#000000';
    page.ctx.font = `700 10px ${fontStack}`;
    page.ctx.fillText(localizedSummaryLine, marginX + 12, y + 18, contentW - 24);
    y += 36;
  }

  // Official Signature Band on the final page if room remains
  const lastCanvas = pages[pages.length - 1];
  const lastCtx = lastCanvas.getContext('2d')!;
  if (y + 54 <= ptH - marginBottom) {
    const sigY = ptH - 66;
    const sigLabels = isBn
      ? ['প্রস্তুতকারক', 'হিসাবরক্ষক / যাচাইকারী', 'অনুমোদিত স্বাক্ষর (মিল)']
      : ['Prepared By', 'Verified By (Accounts)', 'Authorized Signatory'];
    const colW = (contentW - 48) / 3;
    sigLabels.forEach((lbl, idx) => {
      const sx = marginX + idx * (colW + 24);
      lastCtx.strokeStyle = '#000000';
      lastCtx.lineWidth = 0.9;
      lastCtx.beginPath();
      lastCtx.moveTo(sx, sigY);
      lastCtx.lineTo(sx + colW, sigY);
      lastCtx.stroke();
      lastCtx.fillStyle = '#000000';
      lastCtx.font = `600 10px ${fontStack}`;
      lastCtx.textAlign = 'center';
      lastCtx.fillText(lbl, sx + colW / 2, sigY + 13);
      lastCtx.textAlign = 'left';
    });
  }

  // Classic MS Word Document Footer with Page Numbering
  pages.forEach((pCanvas, idx) => {
    const fCtx = pCanvas.getContext('2d')!;
    fCtx.strokeStyle = '#000000';
    fCtx.lineWidth = 0.75;
    fCtx.beginPath();
    fCtx.moveTo(marginX, ptH - 29);
    fCtx.lineTo(ptW - marginX, ptH - 29);
    fCtx.stroke();

    fCtx.fillStyle = '#1F2937';
    fCtx.font = `400 9px ${fontStack}`;
    const footerBrandText = loc(branding.metaLine ? `${branding.name} · ${branding.metaLine}` : params.footerLeft);
    fCtx.fillText(footerBrandText, marginX, ptH - 14, contentW * 0.68);
    const pageLabel = isBn
      ? `অফিশিয়াল রিপোর্ট · পৃষ্ঠা ${toBnDigits(idx + 1)} / ${toBnDigits(pages.length)}`
      : `Official Report · Page ${idx + 1} of ${pages.length}`;
    fCtx.textAlign = 'right';
    fCtx.fillText(pageLabel, ptW - marginX, ptH - 14);
    fCtx.textAlign = 'left';
  });

  const doc = new jsPDF({ orientation: params.orientation, unit: 'pt', format: 'a4' });
  pages.forEach((pCanvas, idx) => {
    if (idx > 0) doc.addPage();
    const imgData = pCanvas.toDataURL('image/png');
    doc.addImage(imgData, 'PNG', 0, 0, ptW, ptH, undefined, 'NONE');
  });
  return deliverPdfDocument(doc, `${params.filename}-${params.lang}.pdf`, params.title, params.mode ?? 'open');
}

export async function exportPdfTableReport(params: {
  title: string;
  subtitle: string;
  filename: string;
  columns: string[];
  rows: (string | number)[][];
  lang?: AppLang;
  mode?: PdfDeliveryMode;
}) {
  const lang: AppLang = params.lang || 'en';
  const branding = getCompanyBranding(lang);
  const brand = branding.name;
  const footerBrand = branding.metaLine ? `${brand} · ${branding.metaLine}` : brand;

  return renderUnicodeCanvasPdf({
    orientation: 'landscape',
    brand,
    title: params.title,
    subtitle: params.subtitle,
    footerLeft: footerBrand,
    lang,
    filename: params.filename,
    tables: [{ head: params.columns, body: params.rows }],
    mode: params.mode ?? 'open',
  });
}

// ---------------------------------------------------------------------------
// Professional Commercial Stationery Helpers (Vouchers, Challans & Invoices)
// ---------------------------------------------------------------------------

let cachedLogoUrl = '';
let cachedLogoImg: HTMLImageElement | null = null;

function loadImageElement(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function ensureCompanyLogoLoaded(): Promise<HTMLImageElement | null> {
  const url = getCompanyBranding('en').logoDataUrl;
  if (!url) {
    cachedLogoUrl = '';
    cachedLogoImg = null;
    return null;
  }
  if (cachedLogoUrl === url && cachedLogoImg) {
    return cachedLogoImg;
  }
  const img = await loadImageElement(url);
  if (img && img.naturalWidth > 0) {
    cachedLogoUrl = url;
    cachedLogoImg = img;
    return img;
  }
  return null;
}

function drawCompanyEmblem(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  branding: ReturnType<typeof getCompanyBranding>,
  fontStack: string
) {
  const logoImg = branding.logoDataUrl && cachedLogoUrl === branding.logoDataUrl ? cachedLogoImg : null;
  if (logoImg && logoImg.naturalWidth > 0 && logoImg.naturalHeight > 0) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 0.7;
    ctx.strokeRect(x, y, size, size);
    const pad = 2.5;
    const avail = Math.max(8, size - pad * 2);
    const scale = Math.min(avail / logoImg.naturalWidth, avail / logoImg.naturalHeight);
    const dw = logoImg.naturalWidth * scale;
    const dh = logoImg.naturalHeight * scale;
    ctx.drawImage(logoImg, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
    return;
  }

  ctx.fillStyle = '#000000';
  ctx.fillRect(x, y, size, size);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 ${branding.shortCode.length > 2 ? Math.round(size * 0.33) : Math.round(size * 0.4)}px ${fontStack}`;
  ctx.textAlign = 'center';
  ctx.fillText(branding.shortCode, x + size / 2, y + size * 0.62);
  ctx.textAlign = 'left';
}

async function ensurePdfFontsLoaded() {
  if (typeof document !== 'undefined' && document.fonts) {
    const bnSample = 'অআকখ বাংলা ১২০';
    try {
      await Promise.race([
        Promise.allSettled([
          document.fonts.load('400 12px "DM Sans"'),
          document.fonts.load('600 12px "DM Sans"'),
          document.fonts.load('700 14px "Plus Jakarta Sans"'),
          document.fonts.load('400 14px "SutonnyBanglaUnicode"', bnSample),
          document.fonts.load('700 16px "SutonnyBanglaUnicode"', bnSample),
          document.fonts.load('400 14px "Noto Serif Bengali"', bnSample),
          document.fonts.load('500 14px "Noto Serif Bengali"', bnSample),
          document.fonts.load('600 14px "Noto Serif Bengali"', bnSample),
          document.fonts.load('700 16px "Noto Serif Bengali"', bnSample),
          document.fonts.load('400 14px "Tiro Bangla"', bnSample),
          document.fonts.load('400 12px "Noto Sans Bengali"', bnSample),
          document.fonts.load('600 13px "Noto Sans Bengali"', bnSample),
          document.fonts.load('700 14px "Noto Sans Bengali"', bnSample),
          document.fonts.ready,
          ensureCompanyLogoLoaded(),
        ]),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    } catch {
      // ignore font loading timeout
    }
  } else {
    await ensureCompanyLogoLoaded();
  }
}

function numberToIndianWordsEn(num: number): string {
  const n = Math.round(Math.max(0, Number.isFinite(num) ? num : 0));
  if (n === 0) return 'Taka Zero Only';
  const ones = [
    '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
    'Seventeen', 'Eighteen', 'Nineteen',
  ];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const twoDigits = (v: number): string => {
    if (v === 0) return '';
    if (v < 20) return ones[v];
    return `${tens[Math.floor(v / 10)]}${v % 10 ? ` ${ones[v % 10]}` : ''}`;
  };
  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const hundred = Math.floor((n % 1000) / 100);
  const rest = n % 100;
  if (crore > 0) parts.push(`${twoDigits(crore)} Crore`);
  if (lakh > 0) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${twoDigits(thousand)} Thousand`);
  if (hundred > 0) parts.push(`${ones[hundred]} Hundred`);
  if (rest > 0) parts.push(twoDigits(rest));
  return `Taka ${parts.join(' ')} Only`;
}

function numberToWordsBn(num: number): string {
  const n = Math.round(Math.max(0, Number.isFinite(num) ? num : 0));
  if (n === 0) return 'শূন্য টাকা মাত্র';
  const crore = Math.floor(n / 10000000);
  const lakh = Math.floor((n % 10000000) / 100000);
  const thousand = Math.floor((n % 100000) / 1000);
  const hundred = Math.floor((n % 1000) / 100);
  const rest = n % 100;
  const parts: string[] = [];
  if (crore > 0) parts.push(`${toBnDigits(crore)} কোটি`);
  if (lakh > 0) parts.push(`${toBnDigits(lakh)} লক্ষ`);
  if (thousand > 0) parts.push(`${toBnDigits(thousand)} হাজার`);
  if (hundred > 0) parts.push(`${toBnDigits(hundred)} শত`);
  if (rest > 0) parts.push(`${toBnDigits(rest)}`);
  return `${parts.join(' ')} টাকা মাত্র`;
}

function formatDateTime(ts?: string, lang: AppLang = 'en'): string {
  if (!ts) {
    const d = new Date().toLocaleDateString(lang === 'bn' ? 'bn-BD' : 'en-IN');
    return lang === 'bn' ? toBnDigits(d) : d;
  }
  const s = ts.slice(0, 16);
  return lang === 'bn' ? toBnDigits(s) : s;
}

interface CommercialHeaderOpts {
  lang: AppLang;
  accentColor: string;
  badgeText: string;
  docNoLabel: string;
  docNo: string;
  dateText: string;
  statusLabel?: string;
  statusTone?: 'ok' | 'warn' | 'err';
  qrDataUrl?: string | null;
}

function drawCommercialLetterhead(
  ctx: CanvasRenderingContext2D,
  ptW: number,
  marginX: number,
  opts: CommercialHeaderOpts,
  qrImg: HTMLImageElement | null
): number {
  const isBn = opts.lang === 'bn';
  const fontStack = getPdfFontStack(opts.lang);
  const contentW = ptW - marginX * 2;
  const topY = 26;
  const branding = getCompanyBranding(opts.lang);

  // Left: Company Logo or Square Monogram Seal (MS Word Official Stamp)
  const emblemSize = 36;
  drawCompanyEmblem(ctx, marginX, topY + 2, emblemSize, branding, fontStack);

  // Right: Optional QR Verification Code in Square Frame
  const qrSize = qrImg ? 52 : 0;
  const qrX = marginX + contentW - qrSize;
  const qrY = topY + 1;
  if (qrImg) {
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(qrX - 2, qrY - 2, qrSize + 4, qrSize + 4);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 0.9;
    ctx.strokeRect(qrX - 2, qrY - 2, qrSize + 4, qrSize + 4);
    ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
  }

  // Centered MS Word Official Masthead
  const centerX = ptW / 2;
  const sideClearance = qrImg ? (qrSize + 18) * 2 : 96;
  const centerMaxW = Math.max(220, contentW - sideClearance);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#000000';
  ctx.font = `700 17px ${fontStack}`;
  ctx.fillText(isBn ? branding.name : branding.name.toUpperCase(), centerX, topY + 17, centerMaxW);

  ctx.fillStyle = '#111827';
  ctx.font = `600 10px ${fontStack}`;
  ctx.fillText(branding.tagline, centerX, topY + 32, centerMaxW);

  ctx.fillStyle = '#1F2937';
  ctx.font = `400 9.5px ${fontStack}`;
  ctx.fillText(branding.metaLine, centerX, topY + 46, contentW - (qrImg ? qrSize + 54 : 84));
  ctx.textAlign = 'left';

  // Classic MS Word Double Horizontal Rule
  const ruleY = topY + 58;
  ctx.fillStyle = '#000000';
  ctx.fillRect(marginX, ruleY, contentW, 1.5);
  ctx.fillRect(marginX, ruleY + 3, contentW, 0.6);

  // Centered Underlined Document Title
  const locBadge = localizePdfText(opts.badgeText, opts.lang);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#000000';
  ctx.font = `700 12.5px ${fontStack}`;
  const titleY = ruleY + 21;
  ctx.fillText(locBadge, centerX, titleY, contentW - 20);
  const titleW = Math.min(contentW - 20, ctx.measureText(locBadge).width);
  ctx.fillRect(centerX - titleW / 2 - 6, titleY + 4, titleW + 12, 1);
  ctx.textAlign = 'left';

  // Formal Reference No, Date & Status Line
  const metaY = ruleY + 42;
  ctx.fillStyle = '#000000';
  ctx.font = `700 10px ${fontStack}`;
  ctx.fillText(
    `${localizePdfText(opts.docNoLabel, opts.lang)}: ${localizePdfText(opts.docNo, opts.lang)}`,
    marginX,
    metaY,
    contentW * 0.48
  );

  const rightMeta = opts.statusLabel
    ? `${localizePdfText(opts.dateText, opts.lang)}   |   ${localizePdfText(opts.statusLabel, opts.lang)}`
    : localizePdfText(opts.dateText, opts.lang);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#111827';
  ctx.font = `600 10px ${fontStack}`;
  ctx.fillText(rightMeta, marginX + contentW, metaY, contentW * 0.54);
  ctx.textAlign = 'left';

  ctx.strokeStyle = '#64748B';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(marginX, metaY + 7);
  ctx.lineTo(marginX + contentW, metaY + 7);
  ctx.stroke();

  return metaY + 16;
}

function drawTwoColInfoCards(
  ctx: CanvasRenderingContext2D,
  marginX: number,
  y: number,
  contentW: number,
  left: { title: string; rows: Array<[string, string]> },
  right: { title: string; rows: Array<[string, string]> },
  lang: AppLang = 'en'
): number {
  const fontStack = getPdfFontStack(lang);
  const colW = contentW / 2;
  const locCard = (card: { title: string; rows: Array<[string, string]> }) => ({
    title: localizePdfText(card.title, lang),
    rows: card.rows.map(([k, v]) => [localizePdfText(k, lang), localizePdfText(v, lang)] as [string, string]),
  });
  const lCard = locCard(left);
  const rCard = locCard(right);

  const calcHeight = (rows: Array<[string, string]>) => {
    let h = 24;
    ctx.font = `600 10px ${fontStack}`;
    for (const [k, v] of rows) {
      const kW = ctx.measureText(k).width;
      const maxValW = Math.max(60, colW - 22 - Math.min(114, kW + 10));
      const lines = wrapCellText(ctx, v || '-', maxValW);
      h += Math.max(19, lines.length * 13.5 + 5.5);
    }
    return h + 4;
  };

  const cardH = Math.max(calcHeight(lCard.rows), calcHeight(rCard.rows));

  // Classic MS Word 2-Column Bordered Grid
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(marginX, y, contentW, cardH);

  // Header Shading Band across both columns
  ctx.fillStyle = '#EDEDED';
  ctx.fillRect(marginX, y, contentW, 22);

  // Outer Frame & Dividers
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(marginX, y, contentW, cardH);

  ctx.beginPath();
  ctx.moveTo(marginX, y + 22);
  ctx.lineTo(marginX + contentW, y + 22);
  ctx.moveTo(marginX + colW, y);
  ctx.lineTo(marginX + colW, y + cardH);
  ctx.stroke();

  const drawCol = (x: number, card: { title: string; rows: Array<[string, string]> }) => {
    ctx.fillStyle = '#000000';
    ctx.font = `700 10px ${fontStack}`;
    ctx.fillText(lang === 'bn' ? card.title : card.title.toUpperCase(), x + 8, y + 15, colW - 16);

    let ry = y + 36;
    card.rows.forEach(([k, v], rIdx) => {
      ctx.fillStyle = '#1F2937';
      ctx.font = `600 9.5px ${fontStack}`;
      ctx.fillText(k, x + 8, ry);

      const labelOffset = Math.min(116, Math.max(82, ctx.measureText(k).width + 10));
      const maxValW = colW - 16 - labelOffset;
      ctx.fillStyle = '#000000';
      ctx.font = `600 10px ${fontStack}`;
      const lines = wrapCellText(ctx, v || '-', maxValW);
      lines.forEach((ln, idx) => {
        ctx.fillText(ln, x + 8 + labelOffset, ry + idx * 13.5);
      });
      const step = Math.max(19, lines.length * 13.5 + 5.5);
      if (rIdx < card.rows.length - 1) {
        ctx.strokeStyle = '#CBD5E1';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(x, ry + step - 13);
        ctx.lineTo(x + colW, ry + step - 13);
        ctx.stroke();
      }
      ry += step;
    });
  };

  drawCol(marginX, lCard);
  drawCol(marginX + colW, rCard);
  return y + cardH + 12;
}

function drawCommercialTable(
  ctx: CanvasRenderingContext2D,
  marginX: number,
  y: number,
  contentW: number,
  columns: Array<{ label: string; widthPct: number; align?: 'left' | 'right' }>,
  rows: (string | number)[][],
  _headFill = '#EDEDED',
  lang: AppLang = 'en'
): number {
  const fontStack = getPdfFontStack(lang);
  const colWidths = columns.map((c) => (c.widthPct / 100) * contentW);

  // MS Word Table Grid Header with clean wrapping
  ctx.font = `700 10px ${fontStack}`;
  const headerWrapped = columns.map((col, i) =>
    wrapCellText(ctx, localizePdfText(col.label, lang), Math.max(22, colWidths[i] - 12))
  );
  const maxHeaderLines = Math.max(1, ...headerWrapped.map((l) => l.length));
  const headerH = Math.max(27, maxHeaderLines * 14 + 12);

  ctx.fillStyle = '#EDEDED';
  ctx.fillRect(marginX, y, contentW, headerH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(marginX, y, contentW, headerH);

  ctx.fillStyle = '#000000';
  let x = marginX;
  columns.forEach((col, i) => {
    const lines = headerWrapped[i];
    lines.forEach((ln, li) => {
      if (col.align === 'right') {
        ctx.textAlign = 'right';
        ctx.fillText(ln, x + colWidths[i] - 7, y + 17 + li * 14);
        ctx.textAlign = 'left';
      } else {
        ctx.fillText(ln, x + 7, y + 17 + li * 14);
      }
    });
    if (i < columns.length - 1) {
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(x + colWidths[i], y);
      ctx.lineTo(x + colWidths[i], y + headerH);
      ctx.stroke();
    }
    x += colWidths[i];
  });
  y += headerH;

  // MS Word Table Grid Body Rows
  rows.forEach((row) => {
    const locRow = row.map((c) => localizePdfText(c, lang));
    const isTotal = isSummaryOrTotalRow(locRow);
    ctx.font = `${isTotal ? '700' : '400'} 10px ${fontStack}`;
    const wrapped = columns.map((_, i) =>
      wrapCellText(ctx, String(locRow[i] ?? ''), Math.max(20, colWidths[i] - 14))
    );
    const maxLines = Math.max(1, ...wrapped.map((l) => l.length));
    const rowH = Math.max(25, maxLines * 14 + 10);

    ctx.fillStyle = isTotal ? '#F3F4F6' : '#FFFFFF';
    ctx.fillRect(marginX, y, contentW, rowH);
    ctx.strokeStyle = isTotal ? '#000000' : '#475569';
    ctx.lineWidth = isTotal ? 1 : 0.65;
    ctx.strokeRect(marginX, y, contentW, rowH);

    let cx = marginX;
    wrapped.forEach((lines, i) => {
      if (i < columns.length - 1) {
        ctx.strokeStyle = isTotal ? '#334155' : '#64748B';
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(cx + colWidths[i], y);
        ctx.lineTo(cx + colWidths[i], y + rowH);
        ctx.stroke();
      }
      const col = columns[i];
      ctx.fillStyle = isTotal || i === columns.length - 1 ? '#000000' : '#111827';
      ctx.font = isTotal || i === columns.length - 1 ? `700 10px ${fontStack}` : `400 10px ${fontStack}`;
      lines.forEach((ln, li) => {
        if (col.align === 'right') {
          ctx.textAlign = 'right';
          ctx.fillText(ln, cx + colWidths[i] - 7, y + 16.5 + li * 14);
          ctx.textAlign = 'left';
        } else {
          ctx.fillText(ln, cx + 7, y + 16.5 + li * 14);
        }
      });
      cx += colWidths[i];
    });
    y += rowH;
  });

  return y + 12;
}

function drawSignatureFooter(
  ctx: CanvasRenderingContext2D,
  ptW: number,
  ptH: number,
  marginX: number,
  labels: [string, string, string],
  lang: AppLang,
  footerNote: string
) {
  const fontStack = getPdfFontStack(lang);
  const contentW = ptW - marginX * 2;
  const sigY = ptH - 74;
  const colW = (contentW - 40) / 3;

  labels.forEach((label, idx) => {
    const sx = marginX + idx * (colW + 20);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(sx, sigY);
    ctx.lineTo(sx + colW, sigY);
    ctx.stroke();

    ctx.fillStyle = '#000000';
    ctx.font = `600 10px ${fontStack}`;
    ctx.textAlign = 'center';
    ctx.fillText(label, sx + colW / 2, sigY + 14);
    ctx.textAlign = 'left';
  });

  // Classic Word Footer Line
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 0.75;
  ctx.beginPath();
  ctx.moveTo(marginX, ptH - 34);
  ctx.lineTo(ptW - marginX, ptH - 34);
  ctx.stroke();

  ctx.fillStyle = '#1F2937';
  ctx.font = `400 9px ${fontStack}`;
  ctx.fillText(footerNote, marginX, ptH - 18, contentW * 0.58);
  ctx.textAlign = 'right';
  ctx.fillText(
    lang === 'bn' ? 'কম্পিউটার জেনারেটেড অফিশিয়াল ডকুমেন্ট · পৃষ্ঠা ১ / ১' : 'Official Document · Page 1 of 1',
    ptW - marginX,
    ptH - 18
  );
  ctx.textAlign = 'left';
}

function finalizeSingleCanvasPdf(
  canvas: HTMLCanvasElement,
  filename: string,
  title: string,
  mode: PdfDeliveryMode = 'open'
): string {
  const ptW = 595.28;
  const ptH = 841.89;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, ptW, ptH, undefined, 'NONE');
  return deliverPdfDocument(doc, filename, title, mode);
}

export async function exportBatchCostSheetPdf(
  batch: ProductionBatch,
  lang: AppLang = 'en',
  mode: PdfDeliveryMode = 'open'
) {
  const cs = batch.cost_sheet;
  const isBn = lang === 'bn';
  const brand = getCompanyBranding(lang).name;
  const isCompleted = batch.status === 'COMPLETED';
  const title = isBn
    ? `${isCompleted ? 'সম্পূর্ণ ডায়ার ক্রাশিং ও কস্ট রিপোর্ট' : 'মিলিং ব্যাচ কস্ট শিট'} — ${batch.batch_no}`
    : `${isCompleted ? 'Complete Dryer Milling & Cost Report' : 'Milling Batch Cost Sheet'} — ${batch.batch_no}`;
  const dryerLabel = batch.dryer_no
    ? isBn
      ? `${batch.dryer_count || 1} ডায়ার (${batch.dryer_no})`
      : `${batch.dryer_count || 1} Dryer (${batch.dryer_no})`
    : isBn
    ? `${batch.dryer_count || 1} ডায়ার`
    : `${batch.dryer_count || 1} Dryer`;
  const inputBags = Number(batch.input_bag_count || 0);
  const divisor = Number(batch.unit_divisor || 75.5) || 75.5;
  const netUnits = Number(
    batch.paddy_net_units || (inputBags > 0 && batch.input_paddy_qty_kg > inputBags ? (batch.input_paddy_qty_kg - inputBags) / divisor : 0)
  );
  const bagUnitRate = Number(batch.paddy_bag_unit_rate || (netUnits > 0 && cs ? cs.raw_paddy_cost / netUnits : 0));
  const headRiceKg = Number(batch.head_rice_qty_kg || 0);
  const issuePerUnit = Number(
    batch.issue_per_unit || (netUnits > 0 && headRiceKg > 0 ? headRiceKg / netUnits : 0)
  );
  const issueFormulaText = isBn
    ? `${headRiceKg.toLocaleString('en-IN')} ÷ ((${batch.input_paddy_qty_kg.toLocaleString('en-IN')} − ${inputBags.toLocaleString('en-IN')}) ÷ ${divisor}) = ${issuePerUnit.toFixed(2)} কেজি/ইউনিট`
    : `${headRiceKg.toLocaleString('en-IN')} ÷ ((${batch.input_paddy_qty_kg.toLocaleString('en-IN')} − ${inputBags.toLocaleString('en-IN')}) ÷ ${divisor}) = ${issuePerUnit.toFixed(2)} kg/unit`;

  const subtitle = isBn
    ? `প্রক্রিয়া: ${batch.process_type === 'PARBOILED_SIDDHO' ? 'সিদ্ধ চাল' : 'আতপ চাল'} | ধানের জাত: ${batch.paddy_item_name || ''} | ডায়ার: ${dryerLabel} | অবস্থা: ${batch.status}`
    : `Process: ${batch.process_type} | Variety: ${batch.paddy_item_name || ''} | Dryer: ${dryerLabel} | Status: ${batch.status}`;

  const costPerKg = cs ? cs.cost_per_kg_head_rice : 0;
  const riceCostSummary = cs
    ? isBn
      ? `৳${costPerKg.toFixed(2)}/কেজি · ৳${(costPerKg * 25).toFixed(2)} (২৫ কেজি) · ৳${cs.cost_per_bag_head_rice.toFixed(2)} (৫০ কেজি)`
      : `৳${costPerKg.toFixed(2)}/kg · ৳${(costPerKg * 25).toFixed(2)} (25kg) · ৳${cs.cost_per_bag_head_rice.toFixed(2)} (50kg)`
    : '-';

  const allOutputs = batch.outputs || [];
  const headRiceOutputs = allOutputs.filter((o) => o.output_type === 'HEAD_RICE');
  const byProductOutputs = allOutputs.filter((o) => o.output_type !== 'HEAD_RICE');
  const headTotalBags = headRiceOutputs.reduce(
    (s, o) => s + Number(o.bag_count || Math.round((o.qty_kg || 0) / (o.pack_size_kg || 50))),
    0
  );
  const totalByProductBags = byProductOutputs.reduce(
    (s, o) => s + Number(o.bag_count || Math.round((o.qty_kg || 0) / (o.pack_size_kg || 50))),
    0
  );

  const byProductYieldRows: (string | number)[][] =
    byProductOutputs.length > 0
      ? [
          ...byProductOutputs.map((out) => {
            const pack = Number(out.pack_size_kg || 25);
            const bags = Number(out.bag_count || Math.round((out.qty_kg || 0) / (pack || 50)));
            const bagUnitRate =
              out.rate_per_bag && out.rate_per_bag > 0
                ? Number(out.rate_per_bag)
                : Number((Number(out.allocated_unit_cost_per_kg || 0) * pack).toFixed(2));
            return isBn
              ? [
                  `উপজাত — ${out.item_name || 'উপজাত'} (${pack}কেজি)`,
                  `${bags.toLocaleString('en-IN')}টি বস্তা${bagUnitRate > 0 ? ` · ৳${bagUnitRate.toLocaleString('en-IN')}/বস্তা` : ''}`,
                ]
              : [
                  `By-Product — ${out.item_name || 'By-Product'} (${pack}kg)`,
                  `${bags.toLocaleString('en-IN')} bags${bagUnitRate > 0 ? ` · ৳${bagUnitRate.toLocaleString('en-IN')}/bag` : ''}`,
                ];
          }),
          [
            isBn ? 'মোট উপজাত বস্তা' : 'Total By-Product Bags',
            isBn ? `${totalByProductBags.toLocaleString('en-IN')}টি বস্তা` : `${totalByProductBags.toLocaleString('en-IN')} bags`,
          ],
        ]
      : isBn
      ? [
          ['ভাঙা চাল (খুদ)', `${batch.broken_rice_qty_kg > 0 ? Number((batch.broken_rice_qty_kg / 50).toFixed(1)).toLocaleString('en-IN') : '0'}টি বস্তা`],
          ['চালের কুঁড়া', `${batch.bran_qty_kg > 0 ? Number((batch.bran_qty_kg / 50).toFixed(1)).toLocaleString('en-IN') : '0'}টি বস্তা`],
          ['তুষ', `${batch.husk_qty_kg > 0 ? Number((batch.husk_qty_kg / 50).toFixed(1)).toLocaleString('en-IN') : '0'}টি বস্তা`],
        ]
      : [
          ['Broken Rice (Khud)', `${batch.broken_rice_qty_kg > 0 ? Number((batch.broken_rice_qty_kg / 50).toFixed(1)).toLocaleString('en-IN') : '0'} bags`],
          ['Rice Bran (Kura)', `${batch.bran_qty_kg > 0 ? Number((batch.bran_qty_kg / 50).toFixed(1)).toLocaleString('en-IN') : '0'} bags`],
          ['Paddy Husk (Tush)', `${batch.husk_qty_kg > 0 ? Number((batch.husk_qty_kg / 50).toFixed(1)).toLocaleString('en-IN') : '0'} bags`],
        ];

  const yieldBody: (string | number)[][] = isBn
    ? [
        ['ডায়ার বরাদ্দ', dryerLabel],
        ['ইনপুট বস্তা ও ওজন', `${inputBags.toLocaleString('en-IN')} বস্তা · ${batch.input_paddy_qty_kg.toLocaleString('en-IN')} কেজি`],
        [`নেট ইউনিট (ওজন−বস্তা) ÷ ${divisor}`, `${netUnits.toFixed(2)} ইউনিট (একক মূল্য: ৳${bagUnitRate.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`],
        [
          'মূল চাল উৎপাদন',
          `${headTotalBags > 0 ? `${headTotalBags.toLocaleString('en-IN')}টি বস্তা · ` : ''}${headRiceKg.toLocaleString()} কেজি (${batch.head_rice_yield_pct.toFixed(2)}%)`,
        ],
        ['ইস্যু = মোট চাল ÷ ((ধানের ওজন−বস্তা) ÷ ৭৫.৫)', issuePerUnit > 0 ? issueFormulaText : '-'],
        ['চালের দাম (২৫কেজি / ৫০কেজি / কেজি)', riceCostSummary],
        ...byProductYieldRows,
        ['অপচয় / আর্দ্রতা ঘাটতি', `${batch.wastage_qty_kg.toLocaleString()} কেজি`],
        ['মোট রিকভারি %', `${batch.total_recovery_pct.toFixed(2)}%`],
      ]
    : [
        ['Dryer Allocation', dryerLabel],
        ['Input Paddy Bags & Weight', `${inputBags.toLocaleString('en-IN')} bags · ${batch.input_paddy_qty_kg.toLocaleString('en-IN')} kg`],
        [`Net Units (Wt−Bags) ÷ ${divisor}`, `${netUnits.toFixed(2)} units (Bag Unit Rate: ৳${bagUnitRate.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})`],
        [
          'Head Rice Output',
          `${headTotalBags > 0 ? `${headTotalBags.toLocaleString('en-IN')} bags · ` : ''}${headRiceKg.toLocaleString()} kg (${batch.head_rice_yield_pct.toFixed(2)}%)`,
        ],
        [`Issue = Total Rice ÷ ((Paddy Wt−Bags) ÷ ${divisor})`, issuePerUnit > 0 ? issueFormulaText : '-'],
        ['Head Rice Cost (kg / 25kg / 50kg)', riceCostSummary],
        ...byProductYieldRows,
        ['Process Wastage / Moisture Loss', `${batch.wastage_qty_kg.toLocaleString()} kg`],
        ['Total Recovery %', `${batch.total_recovery_pct.toFixed(2)}%`],
      ];

  const tables: Array<{ head: string[]; body: (string | number)[][]; headFill?: string }> = [
    {
      head: isBn ? ['ডায়ার ও উৎপাদন সারসংক্ষেপ', 'মান ও সূত্র'] : ['Dryer Production & Yield Summary', 'Value & Formula'],
      body: yieldBody,
      headFill: '#E6E6E6',
    },
  ];

  if (batch.input_logs && batch.input_logs.length > 0) {
    tables.push({
      head: isBn
        ? ['ধাপ ১: ডায়ারে ধান ইনপুট', 'বস্তা ও ওজন', 'মন্তব্য', 'মূল্য (৳)']
        : ['Step 1: Paddy Input', 'Bags & Weight', 'Notes', 'Cost (BDT)'],
      headFill: '#E6E6E6',
      body: batch.input_logs.map((inp) => [
        `${inp.item_name || ''} (${inp.warehouse_name || ''})`,
        `${Number(inp.bag_count || 0).toLocaleString('en-IN')} ${isBn ? 'বস্তা' : 'bags'} · ${Number(inp.qty_kg || 0).toLocaleString('en-IN')} kg`,
        inp.notes || '-',
        `৳${Number(inp.paddy_cost || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      ]),
    });
  }

  if (cs) {
    tables.push({
      head: isBn ? ['খরচের খাত', 'পরিমাণ (৳)'] : ['Cost Component', 'Amount (BDT)'],
      headFill: '#E6E6E6',
      body: isBn
        ? [
            ['কাঁচা ধানের খরচ (COGS)', `৳${cs.raw_paddy_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['সরাসরি শ্রমিক খরচ', `৳${cs.labor_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['বিদ্যুৎ ও পাওয়ার', `৳${cs.electricity_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['বয়লার / ড্রায়ার জ্বালানি', `৳${cs.fuel_boiler_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['যন্ত্রপাতি ও মিল ওভারহেড', `৳${cs.machinery_overhead_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['প্যাকেজিং ও বস্তা', `৳${cs.packaging_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['মোট ব্যাচ খরচ', `৳${cs.gross_batch_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['বাদ: উপজাত ও অন্যান্য আইটেম মূল্য', `-৳${cs.byproduct_credit_value.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['নিট মূল চাল উৎপাদন খরচ', `৳${cs.net_head_rice_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['চালের দাম — প্রতি কেজি', `৳${cs.cost_per_kg_head_rice.toFixed(4)}`],
            ['চালের দাম — প্রতি ২৫ কেজি বস্তা', `৳${(cs.cost_per_kg_head_rice * 25).toFixed(2)}`],
            ['চালের দাম — প্রতি ৫০ কেজি বস্তা', `৳${cs.cost_per_bag_head_rice.toFixed(2)}`],
          ]
        : [
            ['Raw Paddy Cost (COGS)', `৳${cs.raw_paddy_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['Direct Labor Cost', `৳${cs.labor_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['Electricity & Power', `৳${cs.electricity_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['Boiler / Dryer Fuel', `৳${cs.fuel_boiler_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['Machinery & Mill Overhead', `৳${cs.machinery_overhead_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['Packaging & Bags', `৳${cs.packaging_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['Gross Batch Cost', `৳${cs.gross_batch_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['Less: Secondary / By-Product Credit', `-৳${cs.byproduct_credit_value.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['Net Head Rice Production Cost', `৳${cs.net_head_rice_cost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['Auto Cost per KG (Head Rice)', `৳${cs.cost_per_kg_head_rice.toFixed(4)}`],
            ['Auto Cost per 25kg Bag (Head Rice)', `৳${(cs.cost_per_kg_head_rice * 25).toFixed(2)}`],
            ['Auto Cost per 50kg Bag (Head Rice)', `৳${cs.cost_per_bag_head_rice.toFixed(2)}`],
          ],
    });
  }

  if (batch.expense_logs && batch.expense_logs.length > 0) {
    tables.push({
      head: isBn
        ? ['তারিখ', 'খরচের খাত ও ভেন্ডর', 'পরিশোধ অবস্থা', 'পরিশোধিত / মোট (৳)']
        : ['Date', 'Category & Vendor', 'Payment Status', 'Paid / Total (BDT)'],
      headFill: '#E6E6E6',
      body: batch.expense_logs.map((exp) => {
        const total = Number(exp.total_amount || 0);
        const paid = Number(exp.paid_amount ?? (exp.payment_status === 'UNPAID' ? 0 : total));
        const due = Math.max(0, Number((total - paid).toFixed(2)));
        const payLabel =
          due <= 0.01
            ? isBn
              ? 'পরিশোধিত'
              : 'PAID'
            : paid > 0
            ? isBn
              ? `আংশিক (বাকি ৳${due.toLocaleString('en-IN')})`
              : `PARTIAL (Due ৳${due.toLocaleString('en-IN')})`
            : isBn
            ? `বাকি ৳${due.toLocaleString('en-IN')}`
            : `UNPAID (Due ৳${due.toLocaleString('en-IN')})`;
        return [
          exp.created_at ? exp.created_at.slice(0, 16).replace('T', ' ') : '-',
          `${exp.expense_category || 'GENERAL'}${exp.vendor_name ? ` · ${exp.vendor_name}` : ''} (${exp.notes || '-'})`,
          payLabel,
          `৳${paid.toLocaleString('en-IN', { minimumFractionDigits: 2 })} / ৳${total.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
        ];
      }),
    });
  }

  if (batch.expense_payment_receipts && batch.expense_payment_receipts.length > 0) {
    tables.push({
      head: isBn
        ? ['রিসিপ্ট নং', 'তারিখ', 'খরচের খাত ও ভেন্ডর', 'অ্যাকাউন্ট / মাধ্যম', 'পরিশোধিত (৳)']
        : ['Receipt No', 'Paid Date', 'Category & Vendor', 'Account / Mode', 'Amount Paid (BDT)'],
      headFill: '#E6E6E6',
      body: batch.expense_payment_receipts.map((rcp) => [
        rcp.receipt_no || `EXPR-${rcp.id}`,
        rcp.paid_at ? rcp.paid_at.slice(0, 16).replace('T', ' ') : '-',
        `${rcp.expense_category || 'GENERAL'}${rcp.vendor_name ? ` · ${rcp.vendor_name}` : ''}${rcp.notes ? ` (${rcp.notes})` : ''}`,
        `${rcp.account_name || '-'} · ${rcp.payment_mode}`,
        `৳${Number(rcp.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      ]),
    });
  }

  if (batch.outputs && batch.outputs.length > 0) {
    tables.push({
      head: isBn
        ? ['ধাপ ৩: উৎপন্ন আইটেম ও লট', 'বস্তার সাইজ', 'উৎপাদন (বস্তা / পরিমাণ)', 'দর', 'মোট মূল্য (৳)']
        : ['Step 3: Produced Item & Lot', 'Pack Size', 'Produced Qty', 'Rate', 'Total Value (BDT)'],
      headFill: '#E6E6E6',
      body: batch.outputs.map((out) => {
        const pack = Number(out.pack_size_kg || (out.output_type === 'HEAD_RICE' ? 50 : 25));
        const bags = Number(out.bag_count || Math.round((out.qty_kg || 0) / (pack || 50)));
        const isHeadRice = out.output_type === 'HEAD_RICE';
        const bagRate =
          out.rate_per_bag && out.rate_per_bag > 0
            ? Number(out.rate_per_bag)
            : Number((Number(out.allocated_unit_cost_per_kg || 0) * pack).toFixed(2));
        return [
          `${out.item_name || ''} (${out.lot_code || '-'})`,
          `${pack}${isBn ? ' কেজি' : 'kg'}`,
          isHeadRice
            ? `${bags.toLocaleString('en-IN')}${isBn ? 'টি বস্তা' : ' bags'} (${Number(out.qty_kg || 0).toLocaleString('en-IN')} ${isBn ? 'কেজি' : 'kg'})`
            : `${bags.toLocaleString('en-IN')}${isBn ? 'টি বস্তা' : ' bags'}`,
          isHeadRice
            ? `৳${Number(out.allocated_unit_cost_per_kg || 0).toFixed(2)}/${isBn ? 'কেজি' : 'kg'}`
            : `৳${bagRate.toFixed(2)}/${isBn ? 'বস্তা' : 'bag'}`,
          `৳${Number(out.total_value || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
        ];
      }),
    });
  }

  if (batch.profit_summary) {
    const ps = batch.profit_summary;
    tables.push({
      head: isBn ? ['ডায়ার ব্যাচ বিক্রি ও লাভ-লস হিসাব', 'পরিমাণ'] : ['Dryer Batch Sales & Profit/Loss', 'Amount'],
      headFill: '#E6E6E6',
      body: isBn
        ? [
            ['মোট বিক্রি (চাল ও উপজাত)', `৳${ps.total_sold_revenue.toLocaleString('en-IN', { minimumFractionDigits: 2 })} (${ps.total_sold_bags}টি বস্তা)`],
            ['বিক্রিত মালের উৎপাদন খরচ (COGS)', `৳${ps.total_sold_cogs.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['বিক্রি থেকে নিট লাভ / লস', `${ps.realized_profit_loss >= 0 ? '+' : ''}৳${ps.realized_profit_loss.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['অবিক্রিত স্টকের মূল্য', `৳${ps.unsold_stock_value.toLocaleString('en-IN', { minimumFractionDigits: 2 })} (${ps.unsold_stock_bags}টি বস্তা)`],
            ['বাকি খরচ পরিশোধ বাকি', `৳${ps.unpaid_expense_due.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
          ]
        : [
            ['Total Sold Revenue (Rice + By-Products)', `৳${ps.total_sold_revenue.toLocaleString('en-IN', { minimumFractionDigits: 2 })} (${ps.total_sold_kg.toLocaleString('en-IN')} kg / ${ps.total_sold_bags} bags)`],
            ['Sold Inventory COGS', `৳${ps.total_sold_cogs.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['Realized Sale Profit / Loss', `${ps.realized_profit_loss >= 0 ? '+' : ''}৳${ps.realized_profit_loss.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['Remaining Unsold Stock Value', `৳${ps.unsold_stock_value.toLocaleString('en-IN', { minimumFractionDigits: 2 })} (${ps.unsold_stock_kg.toLocaleString('en-IN')} kg)`],
            ['Unpaid Batch Expenses Due', `৳${ps.unpaid_expense_due.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
          ],
    });
  }

  const summaryLine =
    isCompleted && cs
      ? isBn
        ? `চালের দাম: ৳${(cs.cost_per_kg_head_rice * 25).toFixed(2)} (২৫কেজি) / ৳${cs.cost_per_bag_head_rice.toFixed(2)} (৫০কেজি) · ইস্যু: ${issuePerUnit.toFixed(2)} কেজি/${divisor} ইউনিট · বিক্রি লাভ/লস: ${batch.profit_summary ? `${batch.profit_summary.realized_profit_loss >= 0 ? '+' : ''}৳${batch.profit_summary.realized_profit_loss.toFixed(2)}` : '৳০'}`
        : `Rice Cost: ৳${(cs.cost_per_kg_head_rice * 25).toFixed(2)} (25kg) / ৳${cs.cost_per_bag_head_rice.toFixed(2)} (50kg) · Issue: ${issuePerUnit.toFixed(2)} kg/${divisor} unit · Profit: ${batch.profit_summary ? `৳${batch.profit_summary.realized_profit_loss.toFixed(2)}` : '৳0'}`
      : undefined;

  return renderUnicodeCanvasPdf({
    orientation: 'portrait',
    brand,
    title,
    subtitle,
    footerLeft: brand,
    lang,
    filename: `CostSheet-${batch.batch_no}`,
    tables,
    summaryLine,
    mode,
  });
}

// ---------------------------------------------------------------------------
// 1. Professional Paddy Purchase Challan & 4-Weight Audit Slip
// ---------------------------------------------------------------------------
export async function exportWeighbridgeSlipPdf(
  p: PaddyPurchase,
  lang: AppLang = 'en',
  mode: PdfDeliveryMode = 'open',
  options?: { hideFinancials?: boolean }
) {
  await ensurePdfFontsLoaded();
  const hideFinancials = Boolean(options?.hideFinancials);
  const isBn = lang === 'bn';
  const fontStack = getPdfFontStack(lang);
  const ptW = 595.28;
  const ptH = 841.89;
  const marginX = 36;
  const contentW = ptW - marginX * 2;

  const qrUrl = await generateQrDataUrl(`SONAGRAIN|PADDY_PURCHASE|${p.purchase_no}|${p.qr_code_uid || ''}`).catch(() => null);
  const qrImg = qrUrl ? await loadImageElement(qrUrl) : null;

  const { canvas, ctx } = createHiResPdfCanvas(ptW, ptH);

  const statusTone = hideFinancials
    ? 'ok'
    : p.payment_status === 'PAID'
    ? 'ok'
    : p.payment_status === 'UNPAID'
    ? 'err'
    : 'warn';
  const statusLabel = hideFinancials
    ? isBn
      ? 'গুদাম গ্রহণ স্লিপ'
      : 'GODOWN INTAKE'
    : isBn
    ? p.payment_status === 'PAID'
      ? 'পরিশোধিত (PAID)'
      : p.payment_status === 'PARTIAL'
      ? 'আংশিক পরিশোধ (PARTIAL)'
      : 'বকেয়া (UNPAID)'
    : p.payment_status;

  let y = drawCommercialLetterhead(
    ctx,
    ptW,
    marginX,
    {
      lang,
      accentColor: '#000000',
      badgeText: hideFinancials
        ? isBn
          ? 'গুদাম ধান গ্রহণ ও ৪-ওজন স্লিপ'
          : 'GODOWN PADDY INTAKE & 4-WEIGHT SLIP'
        : isBn
        ? 'ধান ক্রয় চালান ও ৪-ওজন রসিদ'
        : 'PADDY PURCHASE CHALLAN & WEIGHT SLIP',
      docNoLabel: isBn ? 'গ্রহণ চালান নং' : 'INTAKE CHALLAN NO',
      docNo: p.purchase_no,
      dateText: `${isBn ? 'তারিখ' : 'Date'}: ${formatDateTime(p.created_at, lang)}`,
      statusLabel,
      statusTone,
    },
    qrImg
  );

  // Two-column Supplier & Weighbridge MS Word Grid
  y = drawTwoColInfoCards(
    ctx,
    marginX,
    y,
    contentW,
    {
      title: isBn ? 'সরবরাহকারী ও পণ্যের তথ্য' : 'Supplier & Paddy Details',
      rows: isBn
        ? [
            ['সাপ্লায়ার', p.supplier_name || String(p.supplier_id)],
            ['সাপ্লায়ার চালান', p.challan_no || 'উল্লেখ নেই'],
            ['ধানের জাত', p.item_name || String(p.item_id)],
            ['লক্ষ্য গুদাম', p.warehouse_name || String(p.warehouse_id)],
          ]
        : [
            ['Supplier', p.supplier_name || String(p.supplier_id)],
            ['Supplier Challan', p.challan_no || 'N/A'],
            ['Paddy Variety', p.item_name || String(p.item_id)],
            ['Target Godown', p.warehouse_name || String(p.warehouse_id)],
          ],
    },
    {
      title: isBn ? 'ওয়েব্রিজ ও পরিবহন বিবরণ' : 'Weighbridge & Logistics',
      rows: isBn
        ? [
            ['গাড়ি / ট্রাক নং', p.vehicle_no || 'উল্লেখ নেই'],
            [
              'বস্তার সংখ্যা',
              `${p.bag_count.toLocaleString('en-IN')} বস্তা${
                (p.jute_bag_count || 0) > 0 || (p.plastic_bag_count || 0) > 0
                  ? ` (চট: ${p.jute_bag_count || 0}, প্লাস্টিক: ${p.plastic_bag_count || 0})`
                  : ''
              }`,
            ],
            ['আর্দ্রতা (MC %)', `${p.moisture_pct}%`],
            ['ওয়েব্রিজ মাধ্যম', `${p.weighbridge_mode}`],
          ]
        : [
            ['Vehicle No', p.vehicle_no || 'N/A'],
            [
              'Bag Count',
              `${p.bag_count.toLocaleString('en-IN')} bags${
                (p.jute_bag_count || 0) > 0 || (p.plastic_bag_count || 0) > 0
                  ? ` (Jute: ${p.jute_bag_count || 0}, Plastic: ${p.plastic_bag_count || 0})`
                  : ''
              }`,
            ],
            ['Moisture %', `${p.moisture_pct}% MC`],
            ['Weighbridge Mode', `${p.weighbridge_mode}`],
          ],
    },
    lang
  );

  // 4-Weight Audit Strip as Formal MS Word 4-Column Bordered Table
  const boxW = contentW / 4;
  const boxH = 60;
  const weightBoxes = [
    {
      title: isBn ? '১. চালান দাবি ওজন' : '1. SUPPLIER CLAIMED',
      val: `${p.supplier_claimed_weight_kg.toLocaleString('en-IN')} ${isBn ? 'কেজি' : 'kg'}`,
      sub: isBn ? 'কাগজের চালান' : 'Challan Weight',
      flagged: false,
    },
    {
      title: isBn ? '২. ওয়েব্রিজ স্কেল' : '2. SCALE WEIGHT',
      val: `${p.scale_weight_kg.toLocaleString('en-IN')} ${isBn ? 'কেজি' : 'kg'}`,
      sub: `${isBn ? 'পার্থক্য' : 'Diff'}: ${p.weight_discrepancy_kg > 0 ? `+${p.weight_discrepancy_kg}` : p.weight_discrepancy_kg} kg`,
      flagged: Boolean(p.discrepancy_flagged),
    },
    {
      title: isBn ? '৩. গৃহীত ওজন' : '3. RECEIVED WT',
      val: `${p.received_weight_kg.toLocaleString('en-IN')} ${isBn ? 'কেজি' : 'kg'}`,
      sub: isBn ? 'গুদাম লটে জমা' : 'Stocked in Godown',
      flagged: false,
    },
    {
      title: isBn ? '৪. পেমেন্ট ওজন' : '4. SETTLEMENT WT',
      val: `${p.payment_weight_kg.toLocaleString('en-IN')} ${isBn ? 'কেজি' : 'kg'}`,
      sub: `${isBn ? 'ঘাটতি বাদ' : 'Loss'}: -${(p.weight_loss_kg || 0).toLocaleString('en-IN')} kg`,
      flagged: false,
    },
  ];

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(marginX, y, contentW, boxH);
  ctx.fillStyle = '#EDEDED';
  ctx.fillRect(marginX, y, contentW, 20);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(marginX, y, contentW, boxH);
  ctx.beginPath();
  ctx.moveTo(marginX, y + 20);
  ctx.lineTo(marginX + contentW, y + 20);
  ctx.stroke();

  weightBoxes.forEach((b, idx) => {
    const bx = marginX + idx * boxW;
    if (idx > 0) {
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 0.75;
      ctx.beginPath();
      ctx.moveTo(bx, y);
      ctx.lineTo(bx, y + boxH);
      ctx.stroke();
    }

    ctx.fillStyle = '#000000';
    ctx.font = `700 8.5px ${fontStack}`;
    ctx.fillText(localizePdfText(b.title, lang), bx + 7, y + 14, boxW - 14);

    ctx.fillStyle = '#000000';
    ctx.font = `700 11px ${fontStack}`;
    ctx.fillText(localizePdfText(b.val, lang), bx + 7, y + 36, boxW - 14);

    ctx.fillStyle = b.flagged ? '#000000' : '#1F2937';
    ctx.font = `${b.flagged ? '700' : '500'} 8.5px ${fontStack}`;
    ctx.fillText(localizePdfText(b.sub, lang), bx + 7, y + 51, boxW - 14);
  });
  y += boxH + 12;

  // Settlement Calculation Table (or Physical Weight Verification Table when hideFinancials=true)
  const unitDiv = p.settlement_unit_kg || 75.5;
  const unitRate = p.settlement_rate || p.rate_per_kg * unitDiv;
  const lossKg = p.weight_loss_kg || 0;
  const netWt = Math.max(0, p.payment_weight_kg - lossKg);
  const netUnits = unitDiv > 0 ? netWt / unitDiv : 0;

  if (hideFinancials) {
    y = drawCommercialTable(
      ctx,
      marginX,
      y,
      contentW,
      isBn
        ? [
            { label: 'ধানের জাত ও বিবরণ', widthPct: 36 },
            { label: 'বস্তা সংখ্যা', widthPct: 16, align: 'right' },
            { label: 'গৃহীত ওজন (কেজি)', widthPct: 18, align: 'right' },
            { label: 'ঘাটতি বাদ (কেজি)', widthPct: 15, align: 'right' },
            { label: `নিট ইউনিট (÷${unitDiv})`, widthPct: 15, align: 'right' },
          ]
        : [
            { label: 'Paddy Variety & Lot', widthPct: 36 },
            { label: 'Bags', widthPct: 16, align: 'right' },
            { label: 'Received Wt (kg)', widthPct: 18, align: 'right' },
            { label: 'Loss (kg)', widthPct: 15, align: 'right' },
            { label: `Net Units (÷${unitDiv})`, widthPct: 15, align: 'right' },
          ],
      [
        [
          `${p.item_name || 'Raw Paddy'}`,
          `${p.bag_count.toLocaleString('en-IN')} ${isBn ? 'বস্তা' : 'bags'}`,
          p.received_weight_kg.toLocaleString('en-IN'),
          lossKg > 0 ? `-${lossKg.toLocaleString('en-IN')}` : '0',
          netUnits.toFixed(3),
        ],
      ],
      '#E6E6E6',
      lang
    );

    ctx.fillStyle = '#F8FAFC';
    ctx.fillRect(marginX, y, contentW, 92);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 0.9;
    ctx.strokeRect(marginX, y, contentW, 92);
    ctx.fillStyle = '#000000';
    ctx.font = `700 9.5px ${fontStack}`;
    ctx.fillText(isBn ? 'গোডাউন ওজন ও মানের নোট' : 'GODOWN WEIGHT & QUALITY VERIFICATION', marginX + 12, y + 20);
    ctx.fillStyle = '#111827';
    ctx.font = `500 9.5px ${fontStack}`;
    ctx.fillText(
      localizePdfText(
        `${isBn ? 'আর্দ্রতা' : 'Moisture'}: ${p.moisture_pct}%   |   ${isBn ? 'অডিট' : 'Audit'}: ${
          p.discrepancy_flagged ? (isBn ? 'ওজন পার্থক্য সতর্কতা' : 'VARIANCE FLAGGED') : isBn ? 'স্বাভাবিক' : 'NORMAL'
        }`,
        lang
      ),
      marginX + 12,
      y + 40
    );
    const noteLines = wrapCellText(
      ctx,
      localizePdfText(`${isBn ? 'মন্তব্য' : 'Notes'}: ${p.discrepancy_notes || (isBn ? 'নেই' : 'None')}`, lang),
      contentW - 24
    );
    noteLines.slice(0, 2).forEach((nl, idx) => {
      ctx.fillText(nl, marginX + 12, y + 60 + idx * 14);
    });
  } else {
    y = drawCommercialTable(
      ctx,
      marginX,
      y,
      contentW,
      isBn
        ? [
            { label: 'ধানের জাত ও বিবরণ', widthPct: 28 },
            { label: 'পেমেন্ট ওজন', widthPct: 14, align: 'right' },
            { label: 'ঘাটতি বাদ', widthPct: 12, align: 'right' },
            { label: 'নিট ওজন', widthPct: 14, align: 'right' },
            { label: `ইউনিট (÷${unitDiv})`, widthPct: 12, align: 'right' },
            { label: `দর / ${unitDiv}kg`, widthPct: 10, align: 'right' },
            { label: 'মোট মূল্য (৳)', widthPct: 10, align: 'right' },
          ]
        : [
            { label: 'Paddy Variety & Lot', widthPct: 28 },
            { label: 'Pay Wt (kg)', widthPct: 14, align: 'right' },
            { label: 'Loss (kg)', widthPct: 12, align: 'right' },
            { label: 'Net Wt (kg)', widthPct: 14, align: 'right' },
            { label: `Units (÷${unitDiv})`, widthPct: 12, align: 'right' },
            { label: `Rate/${unitDiv}`, widthPct: 10, align: 'right' },
            { label: 'Payable (৳)', widthPct: 10, align: 'right' },
          ],
      [
        [
          `${p.item_name || 'Raw Paddy'} (${p.bag_count} ${isBn ? 'বস্তা' : 'bags'})`,
          p.payment_weight_kg.toLocaleString('en-IN'),
          lossKg > 0 ? `-${lossKg.toLocaleString('en-IN')}` : '0',
          netWt.toLocaleString('en-IN'),
          netUnits.toFixed(3),
          unitRate.toFixed(2),
          p.total_payable.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
        ],
      ],
      '#EDEDED',
      lang
    );

    // Formula + Financial Totals Split (MS Word Bordered Document Boxes)
    const balanceDue = Math.max(0, p.total_payable - (p.paid_amount || 0));
    const leftW = contentW * 0.56;
    const rightW = contentW - leftW - 10;
    const summaryH = 132;

    // Left box: Formula, Amount in Words & Remarks
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(marginX, y, leftW, summaryH);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 0.9;
    ctx.strokeRect(marginX, y, leftW, summaryH);

    ctx.fillStyle = '#000000';
    ctx.font = `700 9.5px ${fontStack}`;
    ctx.fillText(isBn ? 'হিসাব সূত্র ও মন্তব্য' : 'SETTLEMENT FORMULA & REMARKS', marginX + 10, y + 18);

    ctx.fillStyle = '#000000';
    ctx.font = `600 9.5px ${fontStack}`;
    ctx.fillText(
      localizePdfText(
        `(${p.payment_weight_kg.toLocaleString('en-IN')} - ${lossKg.toLocaleString('en-IN')}) ÷ ${unitDiv} × ৳${unitRate.toFixed(2)} = ৳${p.total_payable.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
        lang
      ),
      marginX + 10,
      y + 36,
      leftW - 20
    );
    ctx.fillStyle = '#1F2937';
    ctx.font = `500 9px ${fontStack}`;
    ctx.fillText(
      localizePdfText(
        `${isBn ? 'কার্যকর কেজি দর' : 'Effective Rate/kg'}: ৳${p.rate_per_kg.toFixed(4)}   |   ${isBn ? 'অডিট' : 'Audit'}: ${
          p.discrepancy_flagged ? (isBn ? 'ওজন পার্থক্য সতর্কতা' : 'VARIANCE FLAGGED') : isBn ? 'স্বাভাবিক' : 'NORMAL'
        }`,
        lang
      ),
      marginX + 10,
      y + 52,
      leftW - 20
    );

    ctx.fillStyle = '#000000';
    ctx.font = `700 9.5px ${fontStack}`;
    const words = isBn ? numberToWordsBn(p.total_payable) : numberToIndianWordsEn(p.total_payable);
    const wordLines = wrapCellText(ctx, `${isBn ? 'কথায়' : 'In Words'}: ${words}`, leftW - 20);
    wordLines.slice(0, 2).forEach((wl, idx) => {
      ctx.fillText(wl, marginX + 10, y + 71 + idx * 14);
    });

    ctx.fillStyle = '#1F2937';
    ctx.font = `500 9px ${fontStack}`;
    const noteLines = wrapCellText(
      ctx,
      localizePdfText(`${isBn ? 'মন্তব্য' : 'Notes'}: ${p.discrepancy_notes || (isBn ? 'নেই' : 'None')}`, lang),
      leftW - 20
    );
    noteLines.slice(0, 2).forEach((nl, idx) => {
      ctx.fillText(nl, marginX + 10, y + 102 + idx * 13);
    });

    // Right box: Financial Summary
    const rx = marginX + leftW + 10;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(rx, y, rightW, summaryH);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.strokeRect(rx, y, rightW, summaryH);

    const drawSumRow = (label: string, val: string, ry: number, bold = false) => {
      ctx.fillStyle = bold ? '#000000' : '#1F2937';
      ctx.font = bold ? `700 10px ${fontStack}` : `600 9.5px ${fontStack}`;
      ctx.fillText(localizePdfText(label, lang), rx + 10, ry);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#000000';
      ctx.font = bold ? `700 11px ${fontStack}` : `600 10px ${fontStack}`;
      ctx.fillText(localizePdfText(val, lang), rx + rightW - 10, ry);
      ctx.textAlign = 'left';
    };

    drawSumRow(
      isBn ? 'মোট প্রদেয় বিল' : 'Total Payable',
      `৳${p.total_payable.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      y + 24,
      true
    );
    drawSumRow(
      isBn ? 'তাৎক্ষণিক পরিশোধ' : 'Paid at Receipt',
      `৳${(p.paid_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      y + 48,
      false
    );

    ctx.fillStyle = '#EDEDED';
    ctx.fillRect(rx + 8, y + 66, rightW - 16, 52);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.4;
    ctx.strokeRect(rx + 8, y + 66, rightW - 16, 52);
    ctx.fillStyle = '#000000';
    ctx.font = `700 9px ${fontStack}`;
    ctx.fillText(isBn ? 'অবশিষ্ট বকেয়া' : 'BALANCE DUE', rx + 14, y + 84);
    ctx.fillStyle = '#000000';
    ctx.font = `700 13.5px ${fontStack}`;
    ctx.fillText(localizePdfText(`৳${balanceDue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, lang), rx + 14, y + 105);
  }

  drawSignatureFooter(
    ctx,
    ptW,
    ptH,
    marginX,
    isBn
      ? ['ওয়েব্রিজ অপারেটর', 'সরবরাহকারী / ড্রাইভারের স্বাক্ষর', 'অনুমোদিত স্বাক্ষর (মিল)']
      : ['Weighbridge Operator', 'Supplier / Driver Signature', 'Authorized Signatory'],
    lang,
    `${getCompanyBranding(lang).name} · ${isBn ? 'ক্রয় চালান ও ৪-ওজন অডিট স্লিপ' : 'Paddy Purchase Challan & 4-Weight Audit'}`
  );

  return finalizeSingleCanvasPdf(canvas, `PurchaseChallan-${p.purchase_no}-${lang}.pdf`, p.purchase_no, mode);
}

// ---------------------------------------------------------------------------
// 2. Professional Rice & By-Product Sales Invoice / Challan
// ---------------------------------------------------------------------------
export async function exportSalesInvoicePdf(
  inv: SalesInvoice,
  lang: AppLang = 'en',
  mode: PdfDeliveryMode = 'open'
) {
  await ensurePdfFontsLoaded();
  const isBn = lang === 'bn';
  const fontStack = getPdfFontStack(lang);
  const ptW = 595.28;
  const ptH = 841.89;
  const marginX = 36;
  const contentW = ptW - marginX * 2;

  const qrUrl = await generateQrDataUrl(`SONAGRAIN|INVOICE|${inv.invoice_no}|${inv.qr_code_uid || ''}`).catch(() => null);
  const qrImg = qrUrl ? await loadImageElement(qrUrl) : null;

  const { canvas, ctx } = createHiResPdfCanvas(ptW, ptH);

  const statusTone = inv.payment_status === 'PAID' ? 'ok' : inv.payment_status === 'UNPAID' ? 'err' : 'warn';
  const statusLabel = isBn
    ? inv.payment_status === 'PAID'
      ? 'পরিশোধিত (PAID)'
      : inv.payment_status === 'PARTIAL'
      ? 'আংশিক (PARTIAL)'
      : 'বকেয়া (UNPAID)'
    : inv.payment_status;

  let y = drawCommercialLetterhead(
    ctx,
    ptW,
    marginX,
    {
      lang,
      accentColor: '#000000',
      badgeText: isBn ? 'চাল ও উপজাত বিক্রয় চালান (গেট পাস)' : 'SALES CHALLAN & TAX INVOICE',
      docNoLabel: isBn ? 'চালান / বিল নং' : 'INVOICE / CHALLAN NO',
      docNo: inv.invoice_no,
      dateText: `${isBn ? 'তারিখ' : 'Date'}: ${formatDateTime(inv.created_at, lang)}`,
      statusLabel,
      statusTone,
    },
    qrImg
  );

  const totalBagsInv = inv.items.reduce((s, l) => s + Number(l.bag_count || 0), 0);
  const totalKgInv = inv.items.reduce((s, l) => s + Number(l.qty_kg || 0), 0);

  y = drawTwoColInfoCards(
    ctx,
    marginX,
    y,
    contentW,
    {
      title: isBn ? 'ক্রেতা / কাস্টমার তথ্য' : 'Billed & Dispatched To',
      rows: isBn
        ? [
            ['কাস্টমারের নাম', inv.customer_name || String(inv.customer_id)],
            ['চালান ধরন', 'বস্তা ও কেজি ভিত্তিক চাল / উপজাত বিক্রয়'],
            ['স্ট্যাটাস', statusLabel],
          ]
        : [
            ['Customer Name', inv.customer_name || String(inv.customer_id)],
            ['Order Type', 'Wholesale Rice & By-Product Dispatch'],
            ['Payment Status', inv.payment_status],
          ],
    },
    {
      title: isBn ? 'পরিবহন ও গেট পাস তথ্য' : 'Dispatch & Gate Pass Logistics',
      rows: isBn
        ? [
            ['গাড়ি / ট্রাক নং', inv.vehicle_no || 'উল্লেখ নেই'],
            ['মোট বস্তা / আইটেম', totalBagsInv > 0 ? `${totalBagsInv.toLocaleString('en-IN')} বস্তা (${inv.items.length} আইটেম)` : `${inv.items.length} টি`],
            ['মোট ওজন', `${totalKgInv.toLocaleString('en-IN')} কেজি`],
          ]
        : [
            ['Vehicle No', inv.vehicle_no || 'N/A'],
            ['Total Bags / Items', totalBagsInv > 0 ? `${totalBagsInv.toLocaleString('en-IN')} bags (${inv.items.length} items)` : `${inv.items.length} item(s)`],
            ['Total Weight', `${totalKgInv.toLocaleString('en-IN')} kg`],
          ],
    },
    lang
  );

  y = drawCommercialTable(
    ctx,
    marginX,
    y,
    contentW,
    isBn
      ? [
          { label: '#', widthPct: 5 },
          { label: 'পণ্যের বিবরণ', widthPct: 27 },
          { label: 'উৎস গুদাম', widthPct: 18 },
          { label: 'বস্তা ও ওজন', widthPct: 22, align: 'right' },
          { label: 'দর (বস্তা/কেজি)', widthPct: 14, align: 'right' },
          { label: 'মোট (৳)', widthPct: 14, align: 'right' },
        ]
      : [
          { label: '#', widthPct: 5 },
          { label: 'Product Description', widthPct: 27 },
          { label: 'Source Godown', widthPct: 18 },
          { label: 'Bags & Weight', widthPct: 22, align: 'right' },
          { label: 'Rate', widthPct: 14, align: 'right' },
          { label: 'Amount (৳)', widthPct: 14, align: 'right' },
        ],
    inv.items.map((l, idx) => {
      const bags = Number(l.bag_count || 0);
      const pack = Number(l.pack_size_kg || 0);
      const bagRate = Number(l.rate_per_bag || 0);
      const qtyDisplay =
        bags > 0
          ? isBn
            ? `${bags.toLocaleString('en-IN')} বস্তা${pack > 0 ? ` × ${pack}kg` : ''} (${l.qty_kg.toLocaleString('en-IN')} kg)`
            : `${bags.toLocaleString('en-IN')} bags${pack > 0 ? ` × ${pack}kg` : ''} (${l.qty_kg.toLocaleString('en-IN')} kg)`
          : `${l.qty_kg.toLocaleString('en-IN')} kg`;
      const rateDisplay =
        bags > 0 && bagRate > 0
          ? isBn
            ? `৳${bagRate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}/বস্তা`
            : `৳${bagRate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}/bag`
          : `৳${l.rate_per_kg.toFixed(2)}/kg`;
      return [
        idx + 1,
        l.item_name || String(l.item_id),
        l.warehouse_name || String(l.warehouse_id),
        qtyDisplay,
        rateDisplay,
        l.line_total.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
      ];
    }),
    '#E6E6E6',
    lang
  );

  const balanceDue = Math.max(0, inv.total_amount - (inv.paid_amount || 0));
  const leftW = contentW * 0.55;
  const rightW = contentW - leftW - 10;
  const boxH = 132;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(marginX, y, leftW, boxH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 0.9;
  ctx.strokeRect(marginX, y, leftW, boxH);

  ctx.fillStyle = '#000000';
  ctx.font = `700 9.5px ${fontStack}`;
  ctx.fillText(isBn ? 'কথায় মোট বিল ও শর্তাবলী' : 'AMOUNT IN WORDS & TERMS', marginX + 10, y + 18);

  const words = isBn ? numberToWordsBn(inv.total_amount) : numberToIndianWordsEn(inv.total_amount);
  ctx.fillStyle = '#000000';
  ctx.font = `700 10px ${fontStack}`;
  wrapCellText(ctx, words, leftW - 20)
    .slice(0, 3)
    .forEach((wl, idx) => {
      ctx.fillText(wl, marginX + 10, y + 38 + idx * 14);
    });

  ctx.fillStyle = '#1F2937';
  ctx.font = `400 9px ${fontStack}`;
  ctx.fillText(
    isBn ? '১. পণ্য বুঝে নেওয়ার পর কোনো ওজন আপত্তি গ্রহণযোগ্য নয়।' : '1. Goods once weighed & dispatched cannot be claimed for shortage later.',
    marginX + 10,
    y + 92,
    leftW - 20
  );
  ctx.fillText(
    isBn ? '২. গেট পাসের জন্য কিউআর কোড স্ক্যান করে যাচাই করুন।' : '2. Verify dispatch authenticity by scanning the invoice QR code.',
    marginX + 10,
    y + 108,
    leftW - 20
  );

  const rx = marginX + leftW + 10;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(rx, y, rightW, boxH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(rx, y, rightW, boxH);

  const drawInvSum = (label: string, val: string, sy: number, bold = false) => {
    ctx.fillStyle = bold ? '#000000' : '#1F2937';
    ctx.font = bold ? `700 10px ${fontStack}` : `600 9.5px ${fontStack}`;
    ctx.fillText(localizePdfText(label, lang), rx + 10, sy);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#000000';
    ctx.font = bold ? `700 11px ${fontStack}` : `600 10px ${fontStack}`;
    ctx.fillText(localizePdfText(val, lang), rx + rightW - 10, sy);
    ctx.textAlign = 'left';
  };

  drawInvSum(isBn ? 'সাবটোটাল' : 'Subtotal', `৳${inv.subtotal_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, y + 20);
  drawInvSum(isBn ? 'ডিসকাউন্ট / ট্যাক্স' : 'Discount / Tax', `-৳${inv.discount_amount.toFixed(0)} / +৳${inv.tax_amount.toFixed(0)}`, y + 38);
  drawInvSum(isBn ? 'সর্বমোট বিল' : 'Grand Total', `৳${inv.total_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, y + 57, true);
  drawInvSum(isBn ? 'প্রাপ্ত টাকা' : 'Paid Amount', `৳${inv.paid_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, y + 75, false);

  ctx.fillStyle = '#EDEDED';
  ctx.fillRect(rx + 8, y + 86, rightW - 16, 38);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(rx + 8, y + 86, rightW - 16, 38);
  ctx.fillStyle = '#000000';
  ctx.font = `700 9.5px ${fontStack}`;
  ctx.fillText(isBn ? 'বকেয়া' : 'BALANCE DUE', rx + 14, y + 109);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#000000';
  ctx.font = `700 12px ${fontStack}`;
  ctx.fillText(localizePdfText(`৳${balanceDue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, lang), rx + rightW - 14, y + 109);
  ctx.textAlign = 'left';

  drawSignatureFooter(
    ctx,
    ptW,
    ptH,
    marginX,
    isBn
      ? ['গুদাম ও গেট পাস', 'ক্রেতা / ড্রাইভারের স্বাক্ষর', 'অনুমোদিত স্বাক্ষর (মিল)']
      : ['Store & Gate Pass', 'Customer / Driver', 'Authorized Signatory'],
    lang,
    `${getCompanyBranding(lang).name} · ${isBn ? 'বিক্রয় চালান' : 'Wholesale Dispatch Challan'}`
  );

  return finalizeSingleCanvasPdf(canvas, `Invoice-${inv.invoice_no}-${lang}.pdf`, inv.invoice_no, mode);
}

// ---------------------------------------------------------------------------
// 3. Professional Direct Paddy Sale Challan
// ---------------------------------------------------------------------------
export async function exportDirectPaddySalePdf(
  sale: DirectPaddySale,
  lang: AppLang = 'en',
  mode: PdfDeliveryMode = 'open'
) {
  await ensurePdfFontsLoaded();
  const isBn = lang === 'bn';
  const fontStack = getPdfFontStack(lang);
  const ptW = 595.28;
  const ptH = 841.89;
  const marginX = 36;
  const contentW = ptW - marginX * 2;

  const qrUrl = await generateQrDataUrl(`SONAGRAIN|PADDY_SALE|${sale.sale_no}|${sale.qr_code_uid || ''}`).catch(() => null);
  const qrImg = qrUrl ? await loadImageElement(qrUrl) : null;

  const { canvas, ctx } = createHiResPdfCanvas(ptW, ptH);

  const statusTone = sale.payment_status === 'PAID' ? 'ok' : sale.payment_status === 'UNPAID' ? 'err' : 'warn';
  const statusLabel = isBn
    ? sale.payment_status === 'PAID'
      ? 'পরিশোধিত (PAID)'
      : sale.payment_status === 'PARTIAL'
      ? 'আংশিক (PARTIAL)'
      : 'বকেয়া (UNPAID)'
    : sale.payment_status;

  let y = drawCommercialLetterhead(
    ctx,
    ptW,
    marginX,
    {
      lang,
      accentColor: '#000000',
      badgeText: isBn ? 'সরাসরি কাঁচা ধান বিক্রয় চালান' : 'DIRECT PADDY DISPATCH CHALLAN',
      docNoLabel: isBn ? 'ধান বিক্রয় চালান নং' : 'PADDY CHALLAN NO',
      docNo: sale.sale_no,
      dateText: `${isBn ? 'তারিখ' : 'Date'}: ${formatDateTime(sale.created_at, lang)}`,
      statusLabel,
      statusTone,
    },
    qrImg
  );

  const bagCnt = Number(sale.bag_count || 0);
  const juteBags = Number(sale.jute_bag_count || 0);
  const plasticBags = Number(sale.plastic_bag_count || 0);
  const scaleWt = Number(sale.scale_weight_kg || sale.qty_kg || 0);
  const payWt = Number(sale.payment_weight_kg || sale.qty_kg || 0);
  const lossWt = Number(sale.weight_loss_kg || 0);
  const netSettleWt = Math.max(0, Number((payWt - lossWt).toFixed(3)));
  const unitDiv = Number(sale.settlement_unit_kg || 75.5);
  const unitRate = Number(sale.settlement_rate || Number((sale.rate_per_kg * unitDiv).toFixed(2)));
  const bagLabel =
    bagCnt > 0
      ? isBn
        ? `${bagCnt.toLocaleString('en-IN')} বস্তা${juteBags > 0 || plasticBags > 0 ? ` (চট: ${juteBags}, প্লাস্টিক: ${plasticBags})` : ''}`
        : `${bagCnt.toLocaleString('en-IN')} bags${juteBags > 0 || plasticBags > 0 ? ` (Jute: ${juteBags}, Plastic: ${plasticBags})` : ''}`
      : isBn
      ? 'উল্লেখ নেই'
      : 'N/A';

  y = drawTwoColInfoCards(
    ctx,
    marginX,
    y,
    contentW,
    {
      title: isBn ? 'ক্রেতা ও পণ্যের তথ্য' : 'Buyer & Paddy Details',
      rows: isBn
        ? [
            ['ক্রেতা / পার্টি', sale.customer_name || String(sale.customer_id)],
            ['ধানের জাত', sale.item_name || String(sale.item_id)],
            ['উৎস গুদাম', sale.warehouse_name || String(sale.warehouse_id)],
            ['চালান নং', sale.challan_no || 'উল্লেখ নেই'],
          ]
        : [
            ['Buyer / Party', sale.customer_name || String(sale.customer_id)],
            ['Paddy Variety', sale.item_name || String(sale.item_id)],
            ['Source Godown', sale.warehouse_name || String(sale.warehouse_id)],
            ['Challan Ref', sale.challan_no || 'N/A'],
          ],
    },
    {
      title: isBn ? 'ওয়েব্রিজ ও পরিবহন তথ্য' : 'Weighbridge & Logistics',
      rows: isBn
        ? [
            ['গাড়ি / ট্রাক নং', sale.vehicle_no || 'উল্লেখ নেই'],
            ['বস্তার সংখ্যা', bagLabel],
            ['আর্দ্রতা (MC %)', `${Number(sale.moisture_pct ?? 14)}%`],
            ['অবস্থা', statusLabel],
          ]
        : [
            ['Vehicle No', sale.vehicle_no || 'N/A'],
            ['Bag Count', bagLabel],
            ['Moisture %', `${Number(sale.moisture_pct ?? 14)}%`],
            ['Payment Status', sale.payment_status],
          ],
    },
    lang
  );

  y = drawCommercialTable(
    ctx,
    marginX,
    y,
    contentW,
    isBn
      ? [
          { label: 'স্কেল ওজন', widthPct: 16, align: 'right' },
          { label: 'ডেলিভারি ওজন', widthPct: 18, align: 'right' },
          { label: 'বিলিং ওজন', widthPct: 16, align: 'right' },
          { label: 'ঘাটতি বাদ', widthPct: 13, align: 'right' },
          { label: `দর (/${unitDiv}kg)`, widthPct: 18, align: 'right' },
          { label: 'মোট মূল্য (৳)', widthPct: 19, align: 'right' },
        ]
      : [
          { label: 'Scale Wt', widthPct: 16, align: 'right' },
          { label: 'Delivered Wt', widthPct: 18, align: 'right' },
          { label: 'Billing Wt', widthPct: 16, align: 'right' },
          { label: 'Loss Ded.', widthPct: 13, align: 'right' },
          { label: `Rate (/${unitDiv}kg)`, widthPct: 18, align: 'right' },
          { label: 'Amount (৳)', widthPct: 19, align: 'right' },
        ],
    [
      [
        `${scaleWt.toLocaleString('en-IN')} kg`,
        `${sale.qty_kg.toLocaleString('en-IN')} kg`,
        `${payWt.toLocaleString('en-IN')} kg`,
        `−${lossWt.toLocaleString('en-IN')} kg`,
        `৳${unitRate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}\n(৳${sale.rate_per_kg.toFixed(2)}/kg)`,
        `৳${sale.total_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      ],
    ],
    '#E6E6E6',
    lang
  );

  ctx.fillStyle = '#111827';
  ctx.font = `600 9.5px ${fontStack}`;
  ctx.fillText(
    localizePdfText(
      isBn
        ? `হিসাব সূত্র: (ওজন ${payWt.toLocaleString('en-IN')} − বাদ ${lossWt.toLocaleString('en-IN')}) ÷ ${unitDiv} × ৳${unitRate.toLocaleString('en-IN')} = ${(netSettleWt / unitDiv).toFixed(4)} একক (নিট ${netSettleWt.toLocaleString('en-IN')} কেজি)`
        : `Formula: (${payWt.toLocaleString('en-IN')} - ${lossWt.toLocaleString('en-IN')}) / ${unitDiv} x ৳${unitRate.toLocaleString('en-IN')} = ${(netSettleWt / unitDiv).toFixed(4)} units (Net ${netSettleWt.toLocaleString('en-IN')} kg)`,
      lang
    ),
    marginX,
    y + 5,
    contentW
  );
  y += 18;

  const balanceDue = Math.max(0, sale.total_amount - (sale.paid_amount || 0));
  const leftW = contentW * 0.55;
  const rightW = contentW - leftW - 10;
  const boxH = 116;

  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(marginX, y, leftW, boxH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 0.9;
  ctx.strokeRect(marginX, y, leftW, boxH);

  ctx.fillStyle = '#000000';
  ctx.font = `700 9.5px ${fontStack}`;
  ctx.fillText(isBn ? 'কথায় মোট মূল্য' : 'AMOUNT IN WORDS', marginX + 10, y + 18);

  const words = isBn ? numberToWordsBn(sale.total_amount) : numberToIndianWordsEn(sale.total_amount);
  ctx.fillStyle = '#000000';
  ctx.font = `700 10px ${fontStack}`;
  wrapCellText(ctx, words, leftW - 20)
    .slice(0, 3)
    .forEach((wl, idx) => {
      ctx.fillText(wl, marginX + 10, y + 38 + idx * 14);
    });

  const rx = marginX + leftW + 10;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(rx, y, rightW, boxH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(rx, y, rightW, boxH);

  ctx.fillStyle = '#1F2937';
  ctx.font = `600 9.5px ${fontStack}`;
  ctx.fillText(isBn ? 'মোট বিক্রয় মূল্য' : 'Total Bill Amount', rx + 10, y + 24);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#000000';
  ctx.font = `700 10.5px ${fontStack}`;
  ctx.fillText(localizePdfText(`৳${sale.total_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, lang), rx + rightW - 10, y + 24);
  ctx.textAlign = 'left';

  ctx.fillStyle = '#1F2937';
  ctx.font = `600 9.5px ${fontStack}`;
  ctx.fillText(isBn ? 'জমা / প্রাপ্ত টাকা' : 'Paid Received', rx + 10, y + 46);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#000000';
  ctx.font = `700 10.5px ${fontStack}`;
  ctx.fillText(localizePdfText(`৳${sale.paid_amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, lang), rx + rightW - 10, y + 46);
  ctx.textAlign = 'left';

  ctx.fillStyle = '#EDEDED';
  ctx.fillRect(rx + 8, y + 64, rightW - 16, 42);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.4;
  ctx.strokeRect(rx + 8, y + 64, rightW - 16, 42);
  ctx.fillStyle = '#000000';
  ctx.font = `700 9.5px ${fontStack}`;
  ctx.fillText(isBn ? 'অবশিষ্ট বকেয়া' : 'BALANCE DUE', rx + 14, y + 89);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#000000';
  ctx.font = `700 12px ${fontStack}`;
  ctx.fillText(localizePdfText(`৳${balanceDue.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, lang), rx + rightW - 14, y + 89);
  ctx.textAlign = 'left';

  drawSignatureFooter(
    ctx,
    ptW,
    ptH,
    marginX,
    isBn
      ? ['ওয়েব্রিজ ও গেট পাস', 'ক্রেতা / ড্রাইভারের স্বাক্ষর', 'অনুমোদিত স্বাক্ষর (মিল)']
      : ['Weighbridge & Gate Pass', 'Buyer / Driver Signature', 'Authorized Signatory'],
    lang,
    `${getCompanyBranding(lang).name} · ${isBn ? 'সরাসরি ধান বিক্রয় চালান' : 'Direct Paddy Sale Challan'}`
  );

  return finalizeSingleCanvasPdf(canvas, `PaddyChallan-${sale.sale_no}-${lang}.pdf`, sale.sale_no, mode);
}

// ---------------------------------------------------------------------------
// 4. Party Ledger Statement PDF
// ---------------------------------------------------------------------------
export async function exportPartyStatementPdf(params: {
  partyName: string;
  partyCode: string;
  partyType: string;
  phone?: string;
  address?: string;
  dueLabel: string;
  advanceLabel: string;
  lang?: AppLang;
  mode?: PdfDeliveryMode;
  entries: Array<{
    date: string;
    ref_no: string;
    description: string;
    debit_receivable: number;
    credit_payable: number;
    running_balance: number;
  }>;
}) {
  const lang: AppLang = params.lang || 'en';
  const isBn = lang === 'bn';
  const brand = getCompanyBranding(lang).name;

  return renderUnicodeCanvasPdf({
    orientation: 'portrait',
    brand,
    title: isBn ? 'পার্টি লেজার স্টেটমেন্ট' : 'Party Ledger Statement',
    subtitle: `${params.partyName} (${params.partyCode}) | ${params.dueLabel} | ${params.advanceLabel}`,
    footerLeft: `${brand} · ${params.phone || ''}`,
    lang,
    filename: `Statement-${params.partyCode}`,
    tables: [
      {
        head: isBn
          ? ['তারিখ', 'রেফ নং', 'বিবরণ', 'ডেবিট (+)', 'ক্রেডিট (-)', 'ব্যালেন্স']
          : ['Date', 'Ref No', 'Particulars', 'Debit (+)', 'Credit (-)', 'Balance'],
        body: params.entries.map((e) => [
          e.date.slice(0, 16),
          e.ref_no,
          e.description,
          e.debit_receivable > 0 ? e.debit_receivable.toFixed(2) : '-',
          e.credit_payable > 0 ? e.credit_payable.toFixed(2) : '-',
          `${Math.abs(e.running_balance).toFixed(2)} ${e.running_balance >= 0 ? 'Dr' : 'Cr'}`,
        ]),
      },
    ],
    mode: params.mode ?? 'open',
  });
}

// ---------------------------------------------------------------------------
// 5. Professional Payment / Advance / Money Receipt Voucher PDF
// ---------------------------------------------------------------------------
export async function exportPaymentVoucherPdf(
  pay: {
    payment_no: string;
    voucher_type?: string;
    direction: string;
    party_name?: string;
    account_name?: string;
    amount: number;
    payment_mode: string;
    reference_no?: string;
    settled_ref_no?: string;
    notes?: string;
    created_at: string;
  },
  lang: AppLang = 'en',
  mode: PdfDeliveryMode = 'open'
) {
  await ensurePdfFontsLoaded();
  const isBn = lang === 'bn';
  const fontStack = getPdfFontStack(lang);
  const ptW = 595.28;
  const ptH = 841.89;
  const marginX = 36;
  const contentW = ptW - marginX * 2;

  const isReceipt = pay.direction === 'RECEIPT';
  const accentColor = '#000000';

  const resolveVoucherTitle = () => {
    const vt = pay.voucher_type || pay.direction;
    if (isBn) {
      if (vt === 'DUE_PAYMENT') return 'সাপ্লায়ার বকেয়া পরিশোধ ভাউচার';
      if (vt === 'ADVANCE_PAYMENT') return 'সাপ্লায়ার অগ্রিম প্রদান ভাউচার';
      if (vt === 'DUE_RECEIPT') return 'কাস্টমার বকেয়া আদায় রিসিপ্ট';
      if (vt === 'ADVANCE_RECEIPT') return 'কাস্টমার অগ্রিম গ্রহণ রিসিপ্ট';
      return isReceipt ? 'অর্থ প্রাপ্তি রিসিপ্ট ভাউচার' : 'পেমেন্ট পরিশোধ ভাউচার';
    }
    if (vt === 'DUE_PAYMENT') return 'SUPPLIER DUE PAYMENT VOUCHER';
    if (vt === 'ADVANCE_PAYMENT') return 'SUPPLIER ADVANCE PAYMENT VOUCHER';
    if (vt === 'DUE_RECEIPT') return 'CUSTOMER DUE RECEIPT VOUCHER';
    if (vt === 'ADVANCE_RECEIPT') return 'CUSTOMER ADVANCE RECEIPT VOUCHER';
    return isReceipt ? 'MONEY RECEIPT VOUCHER' : 'PAYMENT VOUCHER';
  };

  const qrUrl = await generateQrDataUrl(
    `SONAGRAIN|VOUCHER|${pay.payment_no}|${pay.direction}|${pay.amount}`
  ).catch(() => null);
  const qrImg = qrUrl ? await loadImageElement(qrUrl) : null;

  const { canvas, ctx } = createHiResPdfCanvas(ptW, ptH);

  let y = drawCommercialLetterhead(
    ctx,
    ptW,
    marginX,
    {
      lang,
      accentColor,
      badgeText: resolveVoucherTitle(),
      docNoLabel: isBn ? 'ভাউচার নং' : 'VOUCHER NO',
      docNo: pay.payment_no,
      dateText: `${isBn ? 'তারিখ' : 'Date'}: ${formatDateTime(pay.created_at, lang)}`,
      statusLabel: isReceipt
        ? isBn
          ? 'টাকা গ্রহণ (RECEIPT)'
          : 'RECEIPT (INFLOW)'
        : isBn
        ? 'টাকা প্রদান (PAYMENT)'
        : 'PAYMENT (OUTFLOW)',
      statusTone: isReceipt ? 'ok' : 'warn',
    },
    qrImg
  );

  // Two-column Party & Settlement Cards
  y = drawTwoColInfoCards(
    ctx,
    marginX,
    y,
    contentW,
    {
      title: isReceipt
        ? isBn
          ? 'যার নিকট থেকে প্রাপ্ত'
          : 'Received From (Party)'
        : isBn
        ? 'যাকে প্রদান করা হয়েছে'
        : 'Paid To (Party)',
      rows: isBn
        ? [
            ['পার্টির নাম', pay.party_name || 'প্রযোজ্য নয়'],
            ['ভাউচার ধরন', resolveVoucherTitle()],
            ['সমন্বয়কৃত বিল', pay.settled_ref_no || 'অন-অ্যাকাউন্ট / অগ্রিম'],
          ]
        : [
            ['Party Name', pay.party_name || 'N/A'],
            ['Voucher Category', pay.voucher_type || pay.direction],
            ['Settled Against', pay.settled_ref_no || 'On Account / Advance'],
          ],
    },
    {
      title: isBn ? 'অ্যাকাউন্ট ও পেমেন্ট মাধ্যম' : 'Account & Payment Method',
      rows: isBn
        ? [
            ['নগদ / ব্যাংক', pay.account_name || 'প্রযোজ্য নয়'],
            ['পেমেন্ট মাধ্যম', pay.payment_mode],
            ['ব্যাংক / চেক রেফ', pay.reference_no || 'নেই'],
          ]
        : [
            ['Cash / Bank A/C', pay.account_name || 'N/A'],
            ['Payment Mode', pay.payment_mode],
            ['Bank / UTR Ref', pay.reference_no || 'N/A'],
          ],
    },
    lang
  );

  // Highlighted MS Word Bordered Amount Banner
  const amtBannerH = 90;
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(marginX, y, contentW, amtBannerH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.1;
  ctx.strokeRect(marginX, y, contentW, amtBannerH);

  // Left side of Amount Banner: Words
  ctx.fillStyle = '#000000';
  ctx.font = `700 9.5px ${fontStack}`;
  ctx.fillText(isBn ? 'টাকার পরিমাণ (কথায়)' : 'AMOUNT IN WORDS', marginX + 12, y + 20);

  const words = isBn ? numberToWordsBn(pay.amount) : numberToIndianWordsEn(pay.amount);
  ctx.fillStyle = '#000000';
  ctx.font = `700 11px ${fontStack}`;
  wrapCellText(ctx, words, contentW - 216)
    .slice(0, 2)
    .forEach((wl, idx) => {
      ctx.fillText(wl, marginX + 12, y + 42 + idx * 15);
    });

  // Right side of Amount Banner: Sharp MS Word Currency Box
  const pillW = 182;
  const pillX = marginX + contentW - pillW - 12;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(pillX, y + 14, pillW, 62);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(pillX, y + 14, pillW, 62);

  ctx.fillStyle = '#1F2937';
  ctx.font = `700 9px ${fontStack}`;
  ctx.textAlign = 'right';
  ctx.fillText(isBn ? 'মোট পরিমাণ' : 'TOTAL AMOUNT', pillX + pillW - 12, y + 32);

  ctx.fillStyle = '#000000';
  ctx.font = `700 16px ${fontStack}`;
  ctx.fillText(
    localizePdfText(`৳${pay.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`, lang),
    pillX + pillW - 12,
    y + 58
  );
  ctx.textAlign = 'left';

  y += amtBannerH + 14;

  // Particulars / Journal Summary Table
  y = drawCommercialTable(
    ctx,
    marginX,
    y,
    contentW,
    isBn
      ? [
          { label: 'লেনদেনের বিবরণ ও খাত', widthPct: 52 },
          { label: 'মাধ্যম ও রেফারেন্স', widthPct: 28 },
          { label: 'পরিমাণ (৳)', widthPct: 20, align: 'right' },
        ]
      : [
          { label: 'Particulars & Narration', widthPct: 52 },
          { label: 'Mode & Reference', widthPct: 28 },
          { label: 'Amount (৳)', widthPct: 20, align: 'right' },
        ],
    [
      [
        `${resolveVoucherTitle()}${pay.settled_ref_no ? ` — Ref: ${pay.settled_ref_no}` : ''}\n${
          pay.notes ? `${isBn ? 'মন্তব্য' : 'Notes'}: ${pay.notes}` : ''
        }`.trim(),
        `${pay.payment_mode}${pay.reference_no ? ` (${pay.reference_no})` : ''}`,
        `৳${pay.amount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      ],
    ],
    '#EDEDED',
    lang
  );

  // Narration & Confirmation Box
  const noteBoxH = 74;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(marginX, y, contentW, noteBoxH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 0.9;
  ctx.strokeRect(marginX, y, contentW, noteBoxH);

  ctx.fillStyle = '#000000';
  ctx.font = `700 9.5px ${fontStack}`;
  ctx.fillText(isBn ? 'অফিশিয়াল নোট ও বিবরণ' : 'NARRATION & CONFIRMATION', marginX + 12, y + 18);

  ctx.fillStyle = '#111827';
  ctx.font = `400 10px ${fontStack}`;
  const narration = localizePdfText(
    pay.notes ||
      (isBn
        ? `${pay.party_name || 'পার্টি'} এর সাথে ${pay.payment_mode} মাধ্যমে ৳${pay.amount.toLocaleString('en-IN')} লেনদেন সম্পন্ন ও লেজারে সমন্বয় করা হয়েছে।`
        : `Posted via ${pay.payment_mode} against ${pay.party_name || 'party'} account and reconciled in double-entry general ledger.`),
    lang
  );
  wrapCellText(ctx, narration, contentW - 24)
    .slice(0, 3)
    .forEach((nl, idx) => {
      ctx.fillText(nl, marginX + 12, y + 38 + idx * 14);
    });

  drawSignatureFooter(
    ctx,
    ptW,
    ptH,
    marginX,
    isBn
      ? ['প্রস্তুতকারকের স্বাক্ষর', 'হিসাবরক্ষক / ক্যাশিয়ার', isReceipt ? 'প্রদানকারীর স্বাক্ষর' : 'গ্রহণকারীর স্বাক্ষর']
      : ['Prepared By', 'Accountant / Cashier', isReceipt ? 'Depositor Signature' : 'Receiver / Payee Signature'],
    lang,
    `${getCompanyBranding(lang).name} · ${isBn ? 'অফিশিয়াল ভাউচার রসিদ' : 'Official Accounting Voucher'}`
  );

  return finalizeSingleCanvasPdf(canvas, `Voucher-${pay.payment_no}-${lang}.pdf`, pay.payment_no, mode);
}

// ---------------------------------------------------------------------------
// 6. Double-Entry Journal / Expense / Contra Voucher PDF
// ---------------------------------------------------------------------------
export async function exportJournalVoucherPdf(
  je: JournalEntry,
  lang: AppLang = 'en',
  mode: PdfDeliveryMode = 'open'
) {
  await ensurePdfFontsLoaded();
  const isBn = lang === 'bn';
  const fontStack = getPdfFontStack(lang);
  const ptW = 595.28;
  const ptH = 841.89;
  const marginX = 36;
  const contentW = ptW - marginX * 2;

  const refType = je.reference_type || 'JOURNAL';
  const isExpense = refType === 'EXPENSE' || je.voucher_no.startsWith('EXP-');
  const isContra = refType === 'CONTRA' || je.voucher_no.startsWith('CTR-');
  const accentColor = '#000000';

  const badgeText = isBn
    ? isExpense
      ? 'মিল পরিচালন খরচ ভাউচার (EXPENSE)'
      : isContra
      ? 'ক্যাশ ↔ ব্যাংক কন্ট্রা ট্রান্সফার ভাউচার'
      : 'ডাবল-এন্ট্রি জার্নাল ভাউচার (JV)'
    : isExpense
    ? 'MILL EXPENSE PAYMENT VOUCHER'
    : isContra
    ? 'CASH / BANK CONTRA VOUCHER'
    : 'DOUBLE-ENTRY JOURNAL VOUCHER';

  const totalDebit = je.lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  const totalCredit = je.lines.reduce((s, l) => s + Number(l.credit || 0), 0);

  const qrUrl = await generateQrDataUrl(
    `SONAGRAIN|JV|${je.voucher_no}|${refType}|${totalDebit.toFixed(2)}`
  ).catch(() => null);
  const qrImg = qrUrl ? await loadImageElement(qrUrl) : null;

  const { canvas, ctx } = createHiResPdfCanvas(ptW, ptH);

  const isBalanced = Math.abs(totalDebit - totalCredit) < 0.05;
  let y = drawCommercialLetterhead(
    ctx,
    ptW,
    marginX,
    {
      lang,
      accentColor,
      badgeText,
      docNoLabel: isBn ? 'ভাউচার নং' : 'VOUCHER NO',
      docNo: je.voucher_no,
      dateText: `${isBn ? 'এন্ট্রি তারিখ' : 'Entry Date'}: ${je.entry_date}`,
      statusLabel: isBalanced
        ? isBn
          ? 'সুষম এন্ট্রি (BALANCED)'
          : 'BALANCED POSTING'
        : isBn
        ? 'অসম (UNBALANCED)'
        : 'UNBALANCED',
      statusTone: isBalanced ? 'ok' : 'err',
    },
    qrImg
  );

  y = drawTwoColInfoCards(
    ctx,
    marginX,
    y,
    contentW,
    {
      title: isBn ? 'ভাউচার পরিচিতি ও উৎস' : 'Voucher Metadata & Source',
      rows: isBn
        ? [
            ['ভাউচার ধরন', refType],
            ['মোট ডেবিট / ক্রেডিট', `৳${totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['লেজার লাইন সংখ্যা', `${je.lines.length} টি`],
          ]
        : [
            ['Reference Type', refType],
            ['Voucher Value', `৳${totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`],
            ['Ledger Lines', `${je.lines.length} line(s)`],
          ],
    },
    {
      title: isBn ? 'তারিখ ও অডিট বিবরণ' : 'Posting & Audit Info',
      rows: isBn
        ? [
            ['পোস্টিং তারিখ', je.entry_date],
            ['রেকর্ড সময়', formatDateTime(je.created_at, lang)],
            ['স্ট্যাটাস', 'সফলভাবে লেজারে যুক্ত'],
          ]
        : [
            ['Accounting Date', je.entry_date],
            ['Posted At', formatDateTime(je.created_at, lang)],
            ['GL Status', 'Posted & Reconciled'],
          ],
    },
    lang
  );

  // Debit & Credit Lines Table
  const tableRows: (string | number)[][] = je.lines.map((l) => [
    l.account_code,
    l.account_name,
    l.debit > 0 ? `৳${l.debit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-',
    l.credit > 0 ? `৳${l.credit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-',
  ]);
  tableRows.push([
    '',
    isBn ? 'মোট (সুষম ডেবিট ও ক্রেডিট)' : 'TOTAL (DEBIT = CREDIT)',
    `৳${totalDebit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
    `৳${totalCredit.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
  ]);

  y = drawCommercialTable(
    ctx,
    marginX,
    y,
    contentW,
    isBn
      ? [
          { label: 'কোড', widthPct: 14 },
          { label: 'অ্যাকাউন্টের নাম (GL Head)', widthPct: 48 },
          { label: 'ডেবিট (Dr ৳)', widthPct: 19, align: 'right' },
          { label: 'ক্রেডিট (Cr ৳)', widthPct: 19, align: 'right' },
        ]
      : [
          { label: 'Code', widthPct: 14 },
          { label: 'GL Account Head', widthPct: 48 },
          { label: 'Debit (৳)', widthPct: 19, align: 'right' },
          { label: 'Credit (৳)', widthPct: 19, align: 'right' },
        ],
    tableRows,
    '#E6E6E6',
    lang
  );

  // Highlighted Amount in Words Banner (MS Word Bordered Box)
  const bannerH = 72;
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(marginX, y, contentW, bannerH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(marginX, y, contentW, bannerH);

  ctx.fillStyle = '#000000';
  ctx.font = `700 9.5px ${fontStack}`;
  ctx.fillText(isBn ? 'টাকার পরিমাণ (কথায়)' : 'AMOUNT IN WORDS', marginX + 12, y + 20);

  const words = isBn ? numberToWordsBn(totalDebit) : numberToIndianWordsEn(totalDebit);
  ctx.fillStyle = '#000000';
  ctx.font = `700 10.5px ${fontStack}`;
  wrapCellText(ctx, words, contentW - 24)
    .slice(0, 2)
    .forEach((wl, idx) => {
      ctx.fillText(wl, marginX + 12, y + 40 + idx * 14);
    });
  y += bannerH + 12;

  // Narration Box
  const noteH = 74;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(marginX, y, contentW, noteH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 0.9;
  ctx.strokeRect(marginX, y, contentW, noteH);

  ctx.fillStyle = '#000000';
  ctx.font = `700 9.5px ${fontStack}`;
  ctx.fillText(isBn ? 'লেনদেনের বিবরণ / নোট' : 'PARTICULARS & NARRATION', marginX + 12, y + 20);

  ctx.fillStyle = '#111827';
  ctx.font = `400 10px ${fontStack}`;
  wrapCellText(ctx, localizePdfText(je.description || '-', lang), contentW - 24)
    .slice(0, 3)
    .forEach((nl, idx) => {
      ctx.fillText(nl, marginX + 12, y + 40 + idx * 14);
    });

  drawSignatureFooter(
    ctx,
    ptW,
    ptH,
    marginX,
    isBn
      ? ['প্রস্তুতকারকের স্বাক্ষর', 'হিসাবরক্ষক / ম্যানেজার', 'অনুমোদিত স্বাক্ষর (মালিক)']
      : ['Prepared By', 'Accountant / Manager', 'Authorized Signatory'],
    lang,
    `${getCompanyBranding(lang).name} · ${isBn ? 'ডাবল-এন্ট্রি অ্যাকাউন্টিং ভাউচার' : 'Double-Entry General Ledger Voucher'}`
  );

  return finalizeSingleCanvasPdf(canvas, `Voucher-${je.voucher_no}-${lang}.pdf`, je.voucher_no, mode);
}

// ---------------------------------------------------------------------------
// 7. General Ledger Account Statement PDF & Cashbook Report PDF
// ---------------------------------------------------------------------------
export async function exportAccountLedgerPdf(
  account: Account,
  entries: AccountLedgerRow[],
  lang: AppLang = 'en',
  mode: PdfDeliveryMode = 'open',
  options?: {
    openingBalance?: number;
    closingBalance?: number;
    dateFrom?: string | null;
    dateTo?: string | null;
  }
) {
  const isBn = lang === 'bn';
  const brand = getCompanyBranding(lang).name;
  const totalDr = entries.reduce((s, r) => s + Number(r.debit || 0), 0);
  const totalCr = entries.reduce((s, r) => s + Number(r.credit || 0), 0);
  const openingBal = Number(options?.openingBalance || 0);
  const closingBal =
    options?.closingBalance !== undefined
      ? Number(options.closingBalance)
      : entries.length > 0
      ? Number(entries[entries.length - 1].running_balance)
      : openingBal;
  const periodText =
    options?.dateFrom || options?.dateTo
      ? `${options?.dateFrom || '...'} → ${options?.dateTo || (isBn ? 'আজ পর্যন্ত' : 'Today')}`
      : isBn
      ? 'সকল সময়'
      : 'All Dates';

  const bodyRows: (string | number)[][] = [];
  if (openingBal !== 0 || options?.dateFrom) {
    bodyRows.push([
      options?.dateFrom || '-',
      'OPEN-BAL',
      isBn ? 'প্রারম্ভিক জের (Opening Balance)' : 'Opening Balance Brought Forward',
      '-',
      '-',
      openingBal.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
    ]);
  }
  for (const e of entries) {
    bodyRows.push([
      e.entry_date,
      e.voucher_no,
      e.contra_head ? `${e.description} (${e.contra_head})` : e.description,
      e.debit > 0 ? e.debit.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '-',
      e.credit > 0 ? e.credit.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '-',
      e.running_balance.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
    ]);
  }
  bodyRows.push([
    '',
    isBn ? 'মোট' : 'TOTAL',
    `${entries.length} ${isBn ? 'টি লেনদেন' : 'entries'}`,
    totalDr.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
    totalCr.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
    closingBal.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
  ]);

  return renderUnicodeCanvasPdf({
    orientation: 'portrait',
    brand,
    title: isBn
      ? `অ্যাকাউন্ট লেজার স্টেটমেন্ট — ${account.account_code} ${account.name}`
      : `GL Account Ledger — ${account.account_code} ${account.name}`,
    subtitle: isBn
      ? `সময়কাল: ${periodText} | প্রারম্ভিক: ৳${openingBal.toLocaleString('en-IN', { minimumFractionDigits: 2 })} | সমাপনী: ৳${closingBal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
      : `Period: ${periodText} | Opening: ৳${openingBal.toLocaleString('en-IN', { minimumFractionDigits: 2 })} | Closing: ৳${closingBal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
    footerLeft: `${brand} · ${account.account_code} ${account.name}`,
    lang,
    filename: `Ledger-${account.account_code}`,
    tables: [
      {
        head: isBn
          ? ['তারিখ', 'ভাউচার নং', 'বিবরণ', 'ডেবিট (৳)', 'ক্রেডিট (৳)', 'ব্যালেন্স (৳)']
          : ['Date', 'Voucher No', 'Particulars', 'Debit (৳)', 'Credit (৳)', 'Balance (৳)'],
        body: bodyRows,
        headFill: '#E6E6E6',
      },
    ],
    mode,
  });
}

export async function exportCashbookPdf(
  report: CashbookReport,
  lang: AppLang = 'en',
  mode: PdfDeliveryMode = 'open'
) {
  const isBn = lang === 'bn';
  const brand = getCompanyBranding(lang).name;
  const fmt = (n: number) => `৳${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
  const selectedAcc =
    report.account_id === 'ALL'
      ? null
      : report.accounts.find((a) => a.id === report.account_id) || null;
  const accLabel = selectedAcc
    ? `${selectedAcc.account_code} ${selectedAcc.name}`
    : isBn
    ? 'সকল নগদ ও ব্যাংক অ্যাকাউন্ট'
    : 'All Cash & Bank Accounts';
  const periodLabel =
    report.from || report.to
      ? `${report.from || '...'} → ${report.to || (isBn ? 'আজ পর্যন্ত' : 'Today')}`
      : isBn
      ? 'সকল সময়'
      : 'All Dates';

  const bodyRows: (string | number)[][] = [
    [
      report.from || '-',
      'OPEN-BAL',
      accLabel,
      isBn ? 'প্রারম্ভিক ক্যাশ/ব্যাংক জের (Opening Balance)' : 'Opening Cash & Bank Balance B/F',
      '-',
      '-',
      fmt(report.opening_balance),
    ],
    ...report.entries.map((e) => [
      e.entry_date,
      e.voucher_no,
      `${e.account_code} ${e.account_name}`,
      e.contra_head ? `${e.description} [${e.contra_head}]` : e.description,
      e.receipt > 0 ? e.receipt.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '-',
      e.payment > 0 ? e.payment.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '-',
      fmt(e.running_balance),
    ]),
    [
      '',
      isBn ? 'মোট' : 'TOTAL',
      `${report.entries.length} ${isBn ? 'টি এন্ট্রি' : 'entries'}`,
      isBn ? 'সময়কালের মোট জমা, খরচ ও সমাপনী জের' : 'Period Cash In, Cash Out & Closing Balance',
      fmt(report.total_receipts),
      fmt(report.total_payments),
      fmt(report.closing_balance),
    ],
  ];

  return renderUnicodeCanvasPdf({
    orientation: 'landscape',
    brand,
    title: isBn ? `ক্যাশবুক রিপোর্ট — ${accLabel}` : `Cashbook Report — ${accLabel}`,
    subtitle: isBn
      ? `সময়কাল: ${periodLabel} | প্রারম্ভিক: ${fmt(report.opening_balance)} | জমা: ${fmt(report.total_receipts)} | খরচ: ${fmt(report.total_payments)} | সমাপনী: ${fmt(report.closing_balance)}`
      : `Period: ${periodLabel} | Opening: ${fmt(report.opening_balance)} | Cash In: ${fmt(report.total_receipts)} | Cash Out: ${fmt(report.total_payments)} | Closing: ${fmt(report.closing_balance)}`,
    footerLeft: `${brand} · ${isBn ? 'ক্যাশবুক ও ব্যাংক স্থিতি' : 'Cashbook & Bank Register'}`,
    lang,
    filename: selectedAcc ? `Cashbook-${selectedAcc.account_code}` : 'Cashbook-Report',
    tables: [
      {
        head: isBn
          ? ['তারিখ', 'ভাউচার নং', 'ক্যাশ/ব্যাংক অ্যাকাউন্ট', 'বিবরণ ও বিপরীত খাত', 'জমা / প্রাপ্তি (৳)', 'খরচ / প্রদান (৳)', 'জের (৳)']
          : ['Date', 'Voucher No', 'Cash / Bank Account', 'Particulars & Contra Head', 'Receipt / In (৳)', 'Payment / Out (৳)', 'Balance (৳)'],
        body: bodyRows,
        headFill: '#E6E6E6',
      },
    ],
    mode,
  });
}

// ---------------------------------------------------------------------------
// 8. Financial Statements PDF (Trial Balance, Profit & Loss, Balance Sheet)
// ---------------------------------------------------------------------------
export async function exportFinancialStatementsPdf(
  statements: FinancialStatements,
  lang: AppLang = 'en',
  mode: PdfDeliveryMode = 'open'
) {
  const isBn = lang === 'bn';
  const brand = getCompanyBranding(lang).name;
  const { trial_balance: tb, profit_and_loss: pnl, balance_sheet: bs } = statements;

  const fmt = (n: number) => `৳${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;

  const tbRows: (string | number)[][] = [
    ...tb.rows.map((r) => [
      r.account_code,
      r.name,
      r.account_type,
      r.debit_balance > 0 ? fmt(r.debit_balance) : '-',
      r.credit_balance > 0 ? fmt(r.credit_balance) : '-',
    ]),
    [
      '',
      isBn ? 'মোট ট্রায়াল ব্যালেন্স' : 'TOTAL TRIAL BALANCE',
      tb.is_balanced ? (isBn ? 'সুষম ✓' : 'BALANCED ✓') : isBn ? 'অসম' : 'UNBALANCED',
      fmt(tb.total_debit),
      fmt(tb.total_credit),
    ],
  ];

  const pnlRows: (string | number)[][] = [
    ...pnl.revenues.map((a) => [isBn ? 'আয় (Revenue)' : 'Revenue', `${a.account_code} ${a.name}`, fmt(a.balance)]),
    [isBn ? 'মোট বিক্রয় ও আয়' : 'Total Revenue', '', fmt(pnl.total_revenue)],
    ...pnl.cogs.map((a) => [isBn ? 'বিক্রীত পণ্যের খরচ (COGS)' : 'Less: COGS', `${a.account_code} ${a.name}`, `-${fmt(a.balance)}`]),
    [isBn ? 'মোট মুনাফা (Gross Profit)' : 'GROSS PROFIT', '', fmt(pnl.gross_profit)],
    ...pnl.expenses.map((a) => [isBn ? 'পরিচালন খরচ (Expense)' : 'Less: Operating Expense', `${a.account_code} ${a.name}`, `-${fmt(a.balance)}`]),
    [isBn ? 'মোট পরিচালন খরচ' : 'Total Operating Expenses', '', fmt(pnl.total_expenses)],
    [isBn ? 'নিট লাভ / ক্ষতি (Net Profit/Loss)' : 'NET PROFIT / (LOSS)', '', fmt(pnl.net_profit)],
  ];

  const bsRows: (string | number)[][] = [
    ...bs.assets.map((a) => [isBn ? 'সম্পদ (Asset)' : 'Asset', `${a.account_code} ${a.name}`, fmt(a.balance)]),
    [isBn ? 'মোট সম্পদ (Total Assets)' : 'TOTAL ASSETS', '', fmt(bs.total_assets)],
    ...bs.liabilities.map((a) => [isBn ? 'দায় (Liability)' : 'Liability', `${a.account_code} ${a.name}`, fmt(a.balance)]),
    [isBn ? 'মোট দায়' : 'Total Liabilities', '', fmt(bs.total_liabilities)],
    ...bs.equity.map((a) => [isBn ? 'মালিকানা মূলধন (Equity)' : 'Equity', `${a.account_code} ${a.name}`, fmt(a.balance)]),
    [isBn ? 'চলতি নিট লাভ / (ক্ষতি)' : 'Current Period Net Profit / (Loss)', '', fmt(bs.current_net_profit)],
    [
      isBn ? 'মোট দায় ও মালিকানা মূলধন' : 'TOTAL LIABILITIES & EQUITY',
      bs.is_balanced ? (isBn ? 'সুষম ✓' : 'BALANCED ✓') : isBn ? 'অসম' : 'UNBALANCED',
      fmt(bs.total_liabilities_and_equity),
    ],
  ];

  return renderUnicodeCanvasPdf({
    orientation: 'portrait',
    brand,
    title: isBn ? 'আর্থিক বিবরণী — ট্রায়াল ব্যালেন্স, লাভ-ক্ষতি ও ব্যালেন্স শিট' : 'Financial Statements — Trial Balance, P&L & Balance Sheet',
    subtitle: isBn
      ? `নিট লাভ: ${fmt(pnl.net_profit)} | মোট সম্পদ: ${fmt(bs.total_assets)}`
      : `Net Profit: ${fmt(pnl.net_profit)} | Total Assets: ${fmt(bs.total_assets)}`,
    footerLeft: `${brand} · ${isBn ? 'আর্থিক বিবরণী' : 'Financial Statements'}`,
    lang,
    filename: 'SonaGrain-Financial-Statements',
    tables: [
      {
        head: isBn
          ? ['কোড', 'অ্যাকাউন্টের নাম', 'ধরন', 'ডেবিট ব্যালেন্স', 'ক্রেডিট ব্যালেন্স']
          : ['Code', 'Trial Balance Account', 'Type', 'Debit Balance', 'Credit Balance'],
        body: tbRows,
        headFill: '#E6E6E6',
      },
      {
        head: isBn ? ['লাভ-ক্ষতি বিভাগ', 'খাত', 'পরিমাণ (৳)'] : ['Profit & Loss Section', 'Account Head', 'Amount (৳)'],
        body: pnlRows,
        headFill: '#E6E6E6',
      },
      {
        head: isBn ? ['ব্যালেন্স শিট বিভাগ', 'খাত', 'পরিমাণ (৳)'] : ['Balance Sheet Section', 'Account Head', 'Amount (৳)'],
        body: bsRows,
        headFill: '#E6E6E6',
      },
    ],
    mode,
  });
}

// ---------------------------------------------------------------------------
// 9. Godown-Wise Paddy & Stock Summary PDF (Per-Godown + Grand Total)
// ---------------------------------------------------------------------------
export interface GodownSummaryPdfGroup {
  warehouseCode: string;
  warehouseName: string;
  items: Array<{
    itemName: string;
    sku: string;
    totalBags: number;
    totalWeightKg: number;
    netUnits: number;
    totalValue: number;
    bagUnitRate: number;
  }>;
  totalBags: number;
  totalWeightKg: number;
  netUnits: number;
  totalValue: number;
  bagUnitRate: number;
}

export async function exportGodownStockSummaryPdf(params: {
  groups: GodownSummaryPdfGroup[];
  grandTotalBags: number;
  grandTotalWeightKg: number;
  grandNetUnits: number;
  grandTotalValue: number;
  grandBagUnitRate: number;
  divisor?: number;
  onlyPaddy?: boolean;
  hideFinancials?: boolean;
  lang?: AppLang;
  mode?: PdfDeliveryMode;
}) {
  const lang: AppLang = params.lang || 'en';
  const isBn = lang === 'bn';
  const hideFinancials = Boolean(params.hideFinancials);
  const div = params.divisor || 75.5;
  const brand = getCompanyBranding(lang).name;
  const fmtMoney = (n: number) => `৳${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const tables: Array<{ head: string[]; body: (string | number)[][]; headFill?: string }> = params.groups.map((g) => ({
    head: hideFinancials
      ? isBn
        ? [
            `${g.warehouseName} (${g.warehouseCode}) — ধানের জাত / পণ্য`,
            'বস্তা',
            'মোট ওজন (কেজি)',
            `(ওজন−বস্তা)÷${div}`,
          ]
        : [
            `${g.warehouseName} (${g.warehouseCode}) — Variety / Product`,
            'Bags',
            'Total Wt (kg)',
            `(Wt−Bags)÷${div}`,
          ]
      : isBn
      ? [
          `${g.warehouseName} (${g.warehouseCode}) — ধানের জাত / পণ্য`,
          'বস্তা',
          'মোট ওজন (কেজি)',
          `(ওজন−বস্তা)÷${div}`,
          'মোট মূল্য (৳)',
          `একক মূল্য (/${div})`,
        ]
      : [
          `${g.warehouseName} (${g.warehouseCode}) — Variety / Product`,
          'Bags',
          'Total Wt (kg)',
          `(Wt−Bags)÷${div}`,
          'Total Value (৳)',
          `Unit Rate (/${div})`,
        ],
    headFill: '#E6E6E6',
    body: hideFinancials
      ? [
          ...g.items.map((it) => [
            `${it.itemName} (${it.sku})`,
            it.totalBags.toLocaleString('en-IN'),
            it.totalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
            it.netUnits.toFixed(2),
          ]),
          [
            isBn ? `গোডাউন মোট (${g.warehouseName})` : `GODOWN TOTAL (${g.warehouseName})`,
            g.totalBags.toLocaleString('en-IN'),
            g.totalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
            g.netUnits.toFixed(2),
          ],
        ]
      : [
          ...g.items.map((it) => [
            `${it.itemName} (${it.sku})`,
            it.totalBags.toLocaleString('en-IN'),
            it.totalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
            it.netUnits.toFixed(2),
            fmtMoney(it.totalValue),
            fmtMoney(it.bagUnitRate),
          ]),
          [
            isBn ? `গোডাউন মোট (${g.warehouseName})` : `GODOWN TOTAL (${g.warehouseName})`,
            g.totalBags.toLocaleString('en-IN'),
            g.totalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
            g.netUnits.toFixed(2),
            fmtMoney(g.totalValue),
            fmtMoney(g.bagUnitRate),
          ],
        ],
  }));

  tables.push(
    hideFinancials
      ? {
          head: isBn
            ? ['সকল গোডাউন সর্বমোট', 'মোট বস্তা', 'মোট ওজন (কেজি)', `(ওজন−বস্তা)÷${div}`]
            : ['GRAND TOTAL (ALL GODOWNS)', 'Total Bags', 'Total Wt (kg)', `(Wt−Bags)÷${div}`],
          headFill: '#E6E6E6',
          body: [
            [
              isBn ? `সব গোডাউনের সর্বমোট (${params.groups.length}টি গোডাউন)` : `Combined All Godowns (${params.groups.length} godown(s))`,
              params.grandTotalBags.toLocaleString('en-IN'),
              params.grandTotalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 2 }),
              params.grandNetUnits.toFixed(2),
            ],
          ],
        }
      : {
          head: isBn
            ? ['সকল গোডাউন সর্বমোট', 'সর্বমোট টাকার ভ্যালু (৳)']
            : ['GRAND TOTAL (ALL GODOWNS)', 'Grand Total Value (৳)'],
          headFill: '#E6E6E6',
          body: [
            [
              isBn ? `সব গোডাউনের সর্বমোট (${params.groups.length}টি গোডাউন)` : `Combined All Godowns (${params.groups.length} godown(s))`,
              fmtMoney(params.grandTotalValue),
            ],
          ],
        }
  );

  return renderUnicodeCanvasPdf({
    orientation: 'landscape',
    brand,
    title: hideFinancials
      ? isBn
        ? `গোডাউন ভিত্তিক ${params.onlyPaddy ? 'ধান' : 'স্টক'} (বস্তা ও ওজন) রিপোর্ট`
        : `Godown-Wise ${params.onlyPaddy ? 'Paddy' : 'Stock'} (Bags & Weight) Report`
      : isBn
      ? `গোডাউন ভিত্তিক ${params.onlyPaddy ? 'ধান' : 'স্টক'} ও বস্তার একক মূল্য রিপোর্ট`
      : `Godown-Wise ${params.onlyPaddy ? 'Paddy' : 'Stock'} & Bag Unit Valuation Report`,
    subtitle: hideFinancials
      ? isBn
        ? 'প্রতিটি গোডাউনের ধান, বস্তা ও ওজনের বিবরণ'
        : 'Warehouse-Wise Stock, Bags & Net Weight'
      : isBn
      ? 'প্রতিটি গোডাউনের ধান, বস্তা, ওজন, মূল্য ও একক মূল্যের বিবরণ'
      : 'Warehouse-Wise Stock, Bags, Weight, Value & Unit Rate',
    footerLeft: `${brand} · ${isBn ? 'গোডাউন ভিত্তিক স্টক হিসাব' : 'Godown-Wise Stock Summary'}`,
    lang,
    filename: hideFinancials ? 'SonaGrain-Godown-Physical-Stock' : 'SonaGrain-Godown-Stock-Valuation',
    tables,
    mode: params.mode ?? 'open',
  });
}

// ---------------------------------------------------------------------------
// 10. Empty Bag Ledger Transaction Slip PDF (Monochrome B&W)
// ---------------------------------------------------------------------------
export async function exportEmptyBagSlipPdf(
  entry: SupplierBagLedgerEntry,
  summary: SupplierBagSummary | null,
  lang: AppLang = 'en',
  mode: PdfDeliveryMode = 'open'
) {
  await ensurePdfFontsLoaded();
  const isBn = lang === 'bn';
  const fontStack = getPdfFontStack(lang);
  const ptW = 595.28;
  const ptH = 841.89;
  const marginX = 36;
  const contentW = ptW - marginX * 2;

  const qrUrl = await generateQrDataUrl(`SONAGRAIN|BAG|${entry.entry_no}|${entry.supplier_id}|${entry.total_qty}`).catch(() => null);
  const qrImg = qrUrl ? await loadImageElement(qrUrl) : null;

  const { canvas, ctx } = createHiResPdfCanvas(ptW, ptH);

  let y = drawCommercialLetterhead(
    ctx,
    ptW,
    marginX,
    {
      lang,
      accentColor: '#000000',
      badgeText: isBn ? 'খালি বস্তা লেনদেন স্লিপ (বস্তা হিসাব)' : 'EMPTY BAG TRANSACTION SLIP',
      docNoLabel: isBn ? 'বস্তা স্লিপ নং' : 'BAG SLIP NO',
      docNo: entry.entry_no,
      dateText: `${isBn ? 'তারিখ' : 'Date'}: ${formatDateTime(entry.entry_date || entry.created_at, lang)}`,
      statusLabel: entry.entry_type,
      statusTone: entry.direction === 'OUT_TO_SUPPLIER' ? 'warn' : 'ok',
    },
    qrImg
  );

  y = drawTwoColInfoCards(
    ctx,
    marginX,
    y,
    contentW,
    {
      title: isBn ? 'সাপ্লায়ার তথ্য' : 'Supplier Details',
      rows: isBn
        ? [
            ['সাপ্লায়ারের নাম', entry.supplier_name || summary?.supplier_name || String(entry.supplier_id)],
            ['পার্টি কোড', entry.party_code || summary?.party_code || '-'],
            ['মোবাইল', summary?.phone || 'উল্লেখ নেই'],
          ]
        : [
            ['Supplier Name', entry.supplier_name || summary?.supplier_name || String(entry.supplier_id)],
            ['Party Code', entry.party_code || summary?.party_code || '-'],
            ['Phone', summary?.phone || 'N/A'],
          ],
    },
    {
      title: isBn ? 'বস্তা লেনদেনের বিবরণ' : 'Transaction Metadata',
      rows: isBn
        ? [
            ['লেনদেনের ধরন', entry.entry_type],
            ['দিক / প্রবাহ', entry.direction],
            ['রেফারেন্স', entry.reference_no || 'সরাসরি খালি বস্তা'],
            ['এন্ট্রিকারী', entry.created_by_name || 'অপারেটর'],
          ]
        : [
            ['Entry Type', entry.entry_type],
            ['Direction', entry.direction],
            ['Reference No', entry.reference_no || 'Direct Bag Entry'],
            ['Recorded By', entry.created_by_name || 'Operator'],
          ],
    },
    lang
  );

  y = drawCommercialTable(
    ctx,
    marginX,
    y,
    contentW,
    isBn
      ? [
          { label: 'বস্তার বিবরণ ও ধরন', widthPct: 46 },
          { label: 'চটের বস্তা (Jute)', widthPct: 18, align: 'right' },
          { label: 'প্লাস্টিক বস্তা (Plastic)', widthPct: 18, align: 'right' },
          { label: 'সর্বমোট বস্তা', widthPct: 18, align: 'right' },
        ]
      : [
          { label: 'Bag Description & Purpose', widthPct: 46 },
          { label: 'Jute Bags', widthPct: 18, align: 'right' },
          { label: 'Plastic Bags', widthPct: 18, align: 'right' },
          { label: 'Total Bags', widthPct: 18, align: 'right' },
        ],
    [
      [
        entry.notes || entry.entry_type,
        `${Number(entry.jute_qty || 0).toLocaleString('en-IN')} ${isBn ? 'বস্তা' : 'bags'}`,
        `${Number(entry.plastic_qty || 0).toLocaleString('en-IN')} ${isBn ? 'বস্তা' : 'bags'}`,
        `${Number(entry.total_qty || 0).toLocaleString('en-IN')} ${isBn ? 'বস্তা' : 'bags'}`,
      ],
    ],
    '#E6E6E6',
    lang
  );

  if (summary) {
    const netLabel =
      summary.total_net > 0
        ? isBn
          ? `মিল সাপ্লায়ারের কাছে ${summary.total_net.toLocaleString('en-IN')} বস্তা পাবে`
          : `We Get ${summary.total_net.toLocaleString('en-IN')} bags from Supplier`
        : summary.total_net < 0
        ? isBn
          ? `সাপ্লায়ার মিলের কাছে ${Math.abs(summary.total_net).toLocaleString('en-IN')} বস্তা পাবে`
          : `Supplier Gets ${Math.abs(summary.total_net).toLocaleString('en-IN')} bags`
        : isBn
        ? 'হিসাব সমান (০ বাকি)'
        : 'Settled (0 Balance)';

    const boxH = 90;
    ctx.fillStyle = '#F8FAFC';
    ctx.fillRect(marginX, y, contentW, boxH);
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.strokeRect(marginX, y, contentW, boxH);

    ctx.fillStyle = '#000000';
    ctx.font = `700 9.5px ${fontStack}`;
    ctx.fillText(isBn ? 'সাপ্লায়ারের বর্তমান খালি বস্তা ব্যালেন্স' : 'CURRENT SUPPLIER BAG LEDGER BALANCE', marginX + 12, y + 20);

    ctx.fillStyle = '#000000';
    ctx.font = `700 12px ${fontStack}`;
    ctx.fillText(localizePdfText(netLabel, lang), marginX + 12, y + 43, contentW - 24);

    ctx.fillStyle = '#1F2937';
    ctx.font = `500 9.5px ${fontStack}`;
    ctx.fillText(
      localizePdfText(
        isBn
          ? `সাপ্লায়ার নিয়েছে: ${summary.total_taken} বস্তা (চট: ${summary.jute_taken}, প্লাস্টিক: ${summary.plastic_taken})  |  জমা দিয়েছে: ${summary.total_deposited} বস্তা (চট: ${summary.jute_deposited}, প্লাস্টিক: ${summary.plastic_deposited})`
          : `Taken by Supplier: ${summary.total_taken} bags (Jute: ${summary.jute_taken}, Plastic: ${summary.plastic_taken})  |  Deposited: ${summary.total_deposited} bags`,
        lang
      ),
      marginX + 12,
      y + 68,
      contentW - 24
    );
  }

  drawSignatureFooter(
    ctx,
    ptW,
    ptH,
    marginX,
    isBn
      ? ['স্টোর ইনচার্জ', 'সাপ্লায়ার / ড্রাইভারের স্বাক্ষর', 'অনুমোদিত স্বাক্ষর (মিল)']
      : ['Store Keeper', 'Supplier / Driver Signature', 'Authorized Signatory'],
    lang,
    `${getCompanyBranding(lang).name} · ${isBn ? 'খালি বস্তা হিসাব স্লিপ' : 'Empty Bag Ledger Slip'}`
  );

  return finalizeSingleCanvasPdf(canvas, `BagSlip-${entry.entry_no}-${lang}.pdf`, entry.entry_no, mode);
}

// ---------------------------------------------------------------------------
// 11. Paddy Purchase Return Slip PDF (Monochrome B&W)
// ---------------------------------------------------------------------------
export async function exportPurchaseReturnSlipPdf(
  ret: PaddyPurchaseReturn,
  purchase: PaddyPurchase,
  lang: AppLang = 'en',
  mode: PdfDeliveryMode = 'open'
) {
  await ensurePdfFontsLoaded();
  const isBn = lang === 'bn';
  const fontStack = getPdfFontStack(lang);
  const ptW = 595.28;
  const ptH = 841.89;
  const marginX = 36;
  const contentW = ptW - marginX * 2;

  const qrUrl = await generateQrDataUrl(`SONAGRAIN|PADDY_RETURN|${ret.return_no}|${purchase.purchase_no}|${ret.return_qty_kg}`).catch(() => null);
  const qrImg = qrUrl ? await loadImageElement(qrUrl) : null;

  const { canvas, ctx } = createHiResPdfCanvas(ptW, ptH);

  let y = drawCommercialLetterhead(
    ctx,
    ptW,
    marginX,
    {
      lang,
      accentColor: '#000000',
      badgeText: isBn ? 'ধান ক্রয় ফেরত রসিদ (PURCHASE RETURN)' : 'PADDY PURCHASE RETURN SLIP',
      docNoLabel: isBn ? 'ফেরত চালান নং' : 'RETURN SLIP NO',
      docNo: ret.return_no,
      dateText: `${isBn ? 'তারিখ' : 'Date'}: ${formatDateTime(ret.created_at, lang)}`,
      statusLabel: ret.refund_mode,
      statusTone: 'warn',
    },
    qrImg
  );

  y = drawTwoColInfoCards(
    ctx,
    marginX,
    y,
    contentW,
    {
      title: isBn ? 'সাপ্লায়ার ও মূল ক্রয় তথ্য' : 'Supplier & Original Purchase',
      rows: isBn
        ? [
            ['সাপ্লায়ার', ret.supplier_name || purchase.supplier_name || '-'],
            ['মূল ক্রয় নং', purchase.purchase_no],
            ['ধানের জাত', ret.item_name || purchase.item_name || '-'],
            ['কারণ / নোট', ret.reason || 'ওজন / মান সংক্রান্ত সমন্বয়'],
          ]
        : [
            ['Supplier', ret.supplier_name || purchase.supplier_name || '-'],
            ['Original Purchase', purchase.purchase_no],
            ['Paddy Variety', ret.item_name || purchase.item_name || '-'],
            ['Return Reason', ret.reason || 'Quality / Weight Reversal'],
          ],
    },
    {
      title: isBn ? 'আর্থিক ও বস্তা সমন্বয়' : 'Refund & Bag Adjustment',
      rows: isBn
        ? [
            ['সমন্বয় পদ্ধতি', ret.refund_mode],
            ['অ্যাকাউন্ট', ret.account_name || 'সাপ্লায়ার লেজার সমন্বয়'],
            ['ফেরত বস্তা', `${ret.return_bags} বস্তা (চট: ${ret.return_jute_bags}, প্লাস্টিক: ${ret.return_plastic_bags})`],
            ['এন্ট্রিকারী', ret.created_by_name || 'অপারেটর'],
          ]
        : [
            ['Refund Mode', ret.refund_mode],
            ['Account', ret.account_name || 'Supplier AP Adjustment'],
            ['Returned Bags', `${ret.return_bags} bags (Jute: ${ret.return_jute_bags}, Plastic: ${ret.return_plastic_bags})`],
            ['Processed By', ret.created_by_name || 'Operator'],
          ],
    },
    lang
  );

  y = drawCommercialTable(
    ctx,
    marginX,
    y,
    contentW,
    isBn
      ? [
          { label: 'ফেরত পণ্যের বিবরণ', widthPct: 40 },
          { label: 'ফেরত বস্তা', widthPct: 18, align: 'right' },
          { label: 'ফেরত ওজন (কেজি)', widthPct: 20, align: 'right' },
          { label: 'ফেরত মূল্য (৳)', widthPct: 22, align: 'right' },
        ]
      : [
          { label: 'Returned Paddy Item', widthPct: 40 },
          { label: 'Returned Bags', widthPct: 18, align: 'right' },
          { label: 'Return Qty (kg)', widthPct: 20, align: 'right' },
          { label: 'Credit Value (৳)', widthPct: 22, align: 'right' },
        ],
    [
      [
        `${ret.item_name || purchase.item_name || 'Paddy'} (${purchase.purchase_no})`,
        `${Number(ret.return_bags || 0)}`,
        Number(ret.return_qty_kg || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 }),
        `৳${Number(ret.return_amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      ],
    ],
    '#E6E6E6',
    lang
  );

  const boxH = 74;
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(marginX, y, contentW, boxH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(marginX, y, contentW, boxH);
  ctx.fillStyle = '#000000';
  ctx.font = `700 9.5px ${fontStack}`;
  ctx.fillText(isBn ? 'কথায় ফেরত টাকার পরিমাণ' : 'RETURN AMOUNT IN WORDS', marginX + 12, y + 20);
  ctx.fillStyle = '#000000';
  ctx.font = `700 10.5px ${fontStack}`;
  wrapCellText(
    ctx,
    isBn ? numberToWordsBn(ret.return_amount) : numberToIndianWordsEn(ret.return_amount),
    contentW - 24
  )
    .slice(0, 2)
    .forEach((wl, idx) => {
      ctx.fillText(wl, marginX + 12, y + 42 + idx * 14);
    });

  drawSignatureFooter(
    ctx,
    ptW,
    ptH,
    marginX,
    isBn
      ? ['ওয়েব্রিজ / স্টোর', 'সাপ্লায়ার / ড্রাইভারের স্বাক্ষর', 'অনুমোদিত স্বাক্ষর (মিল)']
      : ['Weighbridge / Store', 'Supplier / Driver Signature', 'Authorized Signatory'],
    lang,
    `${getCompanyBranding(lang).name} · ${isBn ? 'ধান ক্রয় ফেরত স্লিপ' : 'Paddy Purchase Return Slip'}`
  );

  return finalizeSingleCanvasPdf(canvas, `PurchaseReturn-${ret.return_no}-${lang}.pdf`, ret.return_no, mode);
}

// ---------------------------------------------------------------------------
// 12. Production Expense Payment Receipt PDF (Monochrome B&W)
// ---------------------------------------------------------------------------
export async function exportExpensePaymentReceiptPdf(
  receipt: ProductionExpensePayment,
  batch: ProductionBatch,
  lang: AppLang = 'en',
  mode: PdfDeliveryMode = 'open'
) {
  await ensurePdfFontsLoaded();
  const isBn = lang === 'bn';
  const fontStack = getPdfFontStack(lang);
  const ptW = 595.28;
  const ptH = 841.89;
  const marginX = 36;
  const contentW = ptW - marginX * 2;
  const receiptNo = receipt.receipt_no || `EXPR-${receipt.id}`;

  const qrUrl = await generateQrDataUrl(`SONAGRAIN|EXP_RCP|${receiptNo}|${batch.batch_no}|${receipt.amount}`).catch(() => null);
  const qrImg = qrUrl ? await loadImageElement(qrUrl) : null;

  const { canvas, ctx } = createHiResPdfCanvas(ptW, ptH);

  let y = drawCommercialLetterhead(
    ctx,
    ptW,
    marginX,
    {
      lang,
      accentColor: '#000000',
      badgeText: isBn ? 'ডায়ার / ক্রাশিং খরচ পরিশোধ রিসিপ্ট' : 'MILLING EXPENSE PAYMENT RECEIPT',
      docNoLabel: isBn ? 'খরচ রিসিপ্ট নং' : 'EXPENSE RECEIPT NO',
      docNo: receiptNo,
      dateText: `${isBn ? 'পরিশোধের তারিখ' : 'Paid Date'}: ${formatDateTime(receipt.paid_at, lang)}`,
      statusLabel: isBn ? 'পরিশোধিত' : 'PAID RECEIPT',
      statusTone: 'ok',
    },
    qrImg
  );

  y = drawTwoColInfoCards(
    ctx,
    marginX,
    y,
    contentW,
    {
      title: isBn ? 'ডায়ার ও খরচের বিবরণ' : 'Batch & Expense Info',
      rows: isBn
        ? [
            ['ব্যাচ ও ডায়ার', `${batch.batch_no}${batch.dryer_no ? ` (${batch.dryer_no})` : ''}`],
            ['খরচের খাত', receipt.expense_category || 'GENERAL'],
            ['ভেন্ডর / কর্মী', receipt.vendor_name || 'মিল নিজস্ব'],
            ['মোট মূল বিল', receipt.expense_total ? `৳${Number(receipt.expense_total).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'],
          ]
        : [
            ['Batch & Dryer', `${batch.batch_no}${batch.dryer_no ? ` (${batch.dryer_no})` : ''}`],
            ['Category', receipt.expense_category || 'GENERAL'],
            ['Vendor / Payee', receipt.vendor_name || 'Mill Direct'],
            ['Total Expense Bill', receipt.expense_total ? `৳${Number(receipt.expense_total).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '-'],
          ],
    },
    {
      title: isBn ? 'অ্যাকাউন্ট ও পরিশোধ মাধ্যম' : 'Payment Method & Account',
      rows: isBn
        ? [
            ['নগদ / ব্যাংক', receipt.account_name || '-'],
            ['পেমেন্ট মাধ্যম', receipt.payment_mode || 'CASH'],
            ['রেফারেন্স নং', receipt.reference_no || 'নেই'],
            ['প্রদানকারী', receipt.paid_by_name || 'অ্যাকাউন্টস'],
          ]
        : [
            ['Account', receipt.account_name || '-'],
            ['Payment Mode', receipt.payment_mode || 'CASH'],
            ['Reference No', receipt.reference_no || 'None'],
            ['Paid By', receipt.paid_by_name || 'Accounts'],
          ],
    },
    lang
  );

  y = drawCommercialTable(
    ctx,
    marginX,
    y,
    contentW,
    isBn
      ? [
          { label: 'রিসিপ্ট বিবরণ ও নোট', widthPct: 55 },
          { label: 'মাধ্যম ও অ্যাকাউন্ট', widthPct: 25 },
          { label: 'পরিশোধিত (৳)', widthPct: 20, align: 'right' },
        ]
      : [
          { label: 'Receipt Description & Notes', widthPct: 55 },
          { label: 'Account & Mode', widthPct: 25 },
          { label: 'Amount Paid (৳)', widthPct: 20, align: 'right' },
        ],
    [
      [
        `${receipt.expense_category || 'GENERAL'}${receipt.vendor_name ? ` · ${receipt.vendor_name}` : ''} — ${receipt.notes || '-'}`,
        `${receipt.account_name || ''} (${receipt.payment_mode})`,
        `৳${Number(receipt.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`,
      ],
    ],
    '#E6E6E6',
    lang
  );

  const boxH = 74;
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(marginX, y, contentW, boxH);
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(marginX, y, contentW, boxH);
  ctx.fillStyle = '#000000';
  ctx.font = `700 9.5px ${fontStack}`;
  ctx.fillText(isBn ? 'পরিশোধিত টাকার পরিমাণ (কথায়)' : 'AMOUNT PAID IN WORDS', marginX + 12, y + 20);
  ctx.fillStyle = '#000000';
  ctx.font = `700 10.5px ${fontStack}`;
  wrapCellText(
    ctx,
    isBn ? numberToWordsBn(receipt.amount) : numberToIndianWordsEn(receipt.amount),
    contentW - 24
  )
    .slice(0, 2)
    .forEach((wl, idx) => {
      ctx.fillText(wl, marginX + 12, y + 42 + idx * 14);
    });

  drawSignatureFooter(
    ctx,
    ptW,
    ptH,
    marginX,
    isBn
      ? ['ক্যাশিয়ার / হিসাবরক্ষক', 'ভেন্ডর / গ্রহণকারীর স্বাক্ষর', 'অনুমোদিত স্বাক্ষর (মিল)']
      : ['Cashier / Accountant', 'Vendor / Payee Signature', 'Authorized Signatory'],
    lang,
    `${getCompanyBranding(lang).name} · ${isBn ? 'ক্রাশিং খরচ পরিশোধ রিসিপ্ট' : 'Production Expense Payment Receipt'}`
  );

  return finalizeSingleCanvasPdf(canvas, `ExpenseReceipt-${receiptNo}-${lang}.pdf`, receiptNo, mode);
}

// ---------------------------------------------------------------------------
// 13. Printable Stock Batch QR Traceability Labels PDF (8 Tags / A4 Page)
// ---------------------------------------------------------------------------
export async function exportStockBatchQrLabelsPdf(params: {
  lots: InventoryLot[];
  hideFinancials?: boolean;
  lang?: AppLang;
  mode?: PdfDeliveryMode;
}) {
  const lang: AppLang = params.lang || 'en';
  const isBn = lang === 'bn';
  const hideFinancials = Boolean(params.hideFinancials);
  const lots = params.lots;
  if (lots.length === 0) return '';

  await ensurePdfFontsLoaded();
  const fontStack = getPdfFontStack(lang);
  const branding = getCompanyBranding(lang);

  // Pre-generate unique QR images by qr_code_uid + lot_code
  const qrCache = new Map<string, HTMLImageElement | null>();
  for (const lot of lots) {
    const scanText = `SONAGRAIN|LOT|${lot.lot_code}|${lot.qr_code_uid}`;
    if (!qrCache.has(scanText)) {
      const url = await generateQrDataUrl(scanText).catch(() => null);
      const img = url ? await loadImageElement(url) : null;
      qrCache.set(scanText, img);
    }
  }

  const ptW = 595.28;
  const ptH = 841.89;
  const marginX = 24;
  const marginTop = 26;
  const marginBottom = 28;
  const headerBarH = 30;
  const colGap = 12;
  const rowGap = 12;
  const cols = 2;
  const rowsPerPage = 4;
  const cardsPerPage = cols * rowsPerPage;

  const usableW = ptW - marginX * 2;
  const cardW = (usableW - colGap) / cols;
  const usableH = ptH - marginTop - headerBarH - marginBottom;
  const cardH = (usableH - rowGap * (rowsPerPage - 1)) / rowsPerPage;

  const totalPages = Math.ceil(lots.length / cardsPerPage);
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const loc = (v: unknown) => localizePdfText(v, lang);

  for (let pageIdx = 0; pageIdx < totalPages; pageIdx++) {
    const { canvas, ctx } = createHiResPdfCanvas(ptW, ptH);

    // Top sheet title bar
    const hasLogo = Boolean(branding.logoDataUrl && cachedLogoUrl === branding.logoDataUrl && cachedLogoImg);
    if (hasLogo) {
      drawCompanyEmblem(ctx, marginX, marginTop - 2, 18, branding, fontStack);
    }
    ctx.fillStyle = '#000000';
    ctx.font = `700 11px ${fontStack}`;
    ctx.fillText(
      isBn
        ? `${branding.name} — স্টক ব্যাচ QR ট্রেসিবিলিটি লেবেল`
        : `${branding.name} — STOCK BATCH QR TRACEABILITY LABELS`,
      hasLogo ? marginX + 24 : marginX,
      marginTop + 12
    );
    ctx.textAlign = 'right';
    ctx.fillStyle = '#1F2937';
    ctx.font = `600 9px ${fontStack}`;
    ctx.fillText(
      isBn
        ? `পৃষ্ঠা ${toBnDigits(pageIdx + 1)} / ${toBnDigits(totalPages)} · মোট ${toBnDigits(lots.length)}টি ট্যাগ`
        : `Page ${pageIdx + 1} of ${totalPages} · ${lots.length} Label(s)`,
      ptW - marginX,
      marginTop + 12
    );
    ctx.textAlign = 'left';

    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(marginX, marginTop + 19);
    ctx.lineTo(ptW - marginX, marginTop + 19);
    ctx.stroke();

    const slice = lots.slice(pageIdx * cardsPerPage, (pageIdx + 1) * cardsPerPage);
    slice.forEach((lot, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const x = marginX + col * (cardW + colGap);
      const y = marginTop + headerBarH + row * (cardH + rowGap);

      // Dashed cut border around label
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#999999';
      ctx.lineWidth = 0.7;
      ctx.strokeRect(x - 3, y - 3, cardW + 6, cardH + 6);
      ctx.restore();

      // Solid black label frame (sharp Word tag border)
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(x, y, cardW, cardH);
      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 1.2;
      ctx.strokeRect(x, y, cardW, cardH);

      // Label top header band
      const bandH = 24;
      ctx.fillStyle = '#000000';
      ctx.fillRect(x, y, cardW, bandH);

      ctx.fillStyle = '#FFFFFF';
      ctx.font = `700 8.5px ${fontStack}`;
      ctx.fillText(branding.shortCode, x + 8, y + 15);

      ctx.font = `700 10px ${fontStack}`;
      ctx.fillText(lot.lot_code, x + 36, y + 15.5, cardW - 115);

      ctx.textAlign = 'right';
      ctx.font = `600 7.5px ${fontStack}`;
      ctx.fillText(isBn ? 'ব্যাচ QR' : 'LOT TAG', x + cardW - 8, y + 15);
      ctx.textAlign = 'left';

      // QR Code on Left
      const qrSize = 86;
      const qrX = x + 9;
      const qrY = y + bandH + 12;
      const scanText = `SONAGRAIN|LOT|${lot.lot_code}|${lot.qr_code_uid}`;
      const qrImg = qrCache.get(scanText) || null;

      ctx.strokeStyle = '#000000';
      ctx.lineWidth = 0.8;
      ctx.strokeRect(qrX - 2, qrY - 2, qrSize + 4, qrSize + 4);
      if (qrImg) {
        ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
      }

      // Traceability Metadata on Right
      const infoX = qrX + qrSize + 10;
      const infoW = cardW - (infoX - x) - 8;
      let ry = y + bandH + 18;

      ctx.fillStyle = '#000000';
      ctx.font = `700 9.5px ${fontStack}`;
      const itemLines = wrapCellText(ctx, `${lot.item_name || `Item #${lot.item_id}`}`, infoW).slice(0, 2);
      itemLines.forEach((ln) => {
        ctx.fillText(ln, infoX, ry);
        ry += 11.5;
      });

      ctx.fillStyle = '#1F2937';
      ctx.font = `600 8px ${fontStack}`;
      const metaSub = [lot.sku, lot.category ? loc(lot.category) : ''].filter(Boolean).join(' · ');
      if (metaSub) {
        ctx.fillText(metaSub, infoX, ry, infoW);
        ry += 11.5;
      }

      const remKg = Number(lot.remaining_qty_kg || 0);
      const initKg = Number(lot.initial_qty_kg || 0);
      const packKg = Number(lot.pack_size_kg || lot.bag_weight_kg || 50) || 50;
      const bags =
        lot.remaining_bags !== undefined && lot.remaining_bags !== null
          ? Number(lot.remaining_bags)
          : Math.round(remKg / packKg);

      const rows: Array<[string, string]> = [
        [
          isBn ? 'গোডাউন' : 'Godown',
          `${lot.warehouse_name || '-'}${lot.warehouse_code ? ` (${lot.warehouse_code})` : ''}`,
        ],
        [
          isBn ? 'পরিমাণ' : 'Stock',
          isBn
            ? `${toBnDigits(remKg.toLocaleString('en-IN'))} কেজি (${toBnDigits(bags)} বস্তা)`
            : `${remKg.toLocaleString('en-IN')} kg (${bags} bags)`,
        ],
        [
          isBn ? 'উৎস' : 'Source',
          `${loc(lot.source_type)}${lot.origin_batch_no ? ` · ${lot.origin_batch_no}` : ''}`,
        ],
      ];

      if (lot.origin_dryer_no) {
        rows.push([isBn ? 'ডায়ার' : 'Dryer', String(lot.origin_dryer_no)]);
      } else if (lot.moisture_pct !== undefined && lot.moisture_pct !== null) {
        rows.push([
          isBn ? 'আর্দ্রতা / প্যাক' : 'Moist / Pack',
          isBn
            ? `${toBnDigits(lot.moisture_pct)}% · ${toBnDigits(packKg)} কেজি`
            : `${lot.moisture_pct}% · ${packKg} kg/bag`,
        ]);
      } else {
        rows.push([
          isBn ? 'শুরুর / তারিখ' : 'Init / Date',
          isBn
            ? `${toBnDigits(initKg.toLocaleString('en-IN'))} কেজি · ${toBnDigits(String(lot.received_at || '').slice(0, 10))}`
            : `${initKg.toLocaleString('en-IN')} kg · ${String(lot.received_at || '').slice(0, 10)}`,
        ]);
      }

      if (!hideFinancials && Number(lot.unit_cost_per_kg || 0) > 0) {
        rows.push([
          isBn ? 'ইউনিট কস্ট' : 'Unit Cost',
          isBn
            ? `৳${toBnDigits(Number(lot.unit_cost_per_kg).toFixed(2))}/কেজি`
            : `BDT ${Number(lot.unit_cost_per_kg).toFixed(2)}/kg`,
        ]);
      }

      for (const [lbl, val] of rows.slice(0, 5)) {
        if (ry > y + cardH - 22) break;
        ctx.fillStyle = '#1F2937';
        ctx.font = `700 8px ${fontStack}`;
        ctx.fillText(`${lbl}:`, infoX, ry);
        const lblW = Math.min(56, ctx.measureText(`${lbl}:`).width + 4);
        ctx.fillStyle = '#000000';
        ctx.font = `600 8.5px ${fontStack}`;
        ctx.fillText(val, infoX + lblW, ry, Math.max(40, infoW - lblW));
        ry += 11.5;
      }

      // Bottom Scan Format Footer inside card
      ctx.fillStyle = '#EDEDED';
      ctx.fillRect(x + 1, y + cardH - 19, cardW - 2, 18);
      ctx.strokeStyle = '#64748B';
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(x + 1, y + cardH - 19);
      ctx.lineTo(x + cardW - 1, y + cardH - 19);
      ctx.stroke();

      ctx.fillStyle = '#000000';
      ctx.font = `700 7.5px ${FONT_STACK_EN}`;
      ctx.fillText(scanText, x + 7, y + cardH - 7, cardW - 14);
    });

    if (pageIdx > 0) doc.addPage();
    doc.addImage(canvas.toDataURL('image/png'), 'PNG', 0, 0, ptW, ptH, undefined, 'NONE');
  }

  const fileTag = lots.length === 1 ? lots[0].lot_code : `Batch-${lots.length}-Tags`;
  return deliverPdfDocument(doc, `StockQR-${fileTag}-${lang}.pdf`, `Stock Batch QR Tags (${fileTag})`, params.mode ?? 'open');
}

