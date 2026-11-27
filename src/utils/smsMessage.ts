import type { AppLang } from '../i18n/translations';
import type { PaddyPurchase } from '../types/erp';
import { getCompanyBranding } from './companySettings';

export function normalizeBdPhone(raw?: string | null): {
  valid: boolean;
  local: string;
  intl: string;
  e164: string;
} {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits || digits.length < 10 || digits.length > 15) {
    return { valid: false, local: '', intl: '', e164: '' };
  }
  if (digits.startsWith('8801') && digits.length === 13) {
    return {
      valid: true,
      local: `0${digits.slice(3)}`,
      intl: digits,
      e164: `+${digits}`,
    };
  }
  if (digits.startsWith('01') && digits.length === 11) {
    return {
      valid: true,
      local: digits,
      intl: `88${digits}`,
      e164: `+88${digits}`,
    };
  }
  if (digits.startsWith('1') && digits.length === 10) {
    return {
      valid: true,
      local: `0${digits}`,
      intl: `880${digits}`,
      e164: `+880${digits}`,
    };
  }
  return {
    valid: true,
    local: digits,
    intl: digits,
    e164: `+${digits}`,
  };
}

export function formatPaddyPurchaseMessage(
  purchase: Pick<
    PaddyPurchase,
    | 'purchase_no'
    | 'supplier_name'
    | 'item_name'
    | 'bag_count'
    | 'received_weight_kg'
    | 'payment_weight_kg'
    | 'weight_loss_kg'
    | 'total_payable'
    | 'paid_amount'
    | 'pricing_status'
    | 'created_at'
  >,
  lang: AppLang = 'bn',
  options?: { hideFinancials?: boolean }
): string {
  const branding = getCompanyBranding(lang);
  const party = (purchase.supplier_name || (lang === 'bn' ? 'সম্মানিত গ্রাহক' : 'Valued Party')).trim();
  const variety = (purchase.item_name || (lang === 'bn' ? 'ধান' : 'Paddy')).trim();
  const bags = Math.max(0, Number(purchase.bag_count || 0));
  const receivedKg = Number(purchase.received_weight_kg || 0);
  const netBillableKg = Math.max(0, Number((Number(purchase.payment_weight_kg || 0) - Number(purchase.weight_loss_kg || 0)).toFixed(2)));
  const isPendingRate = Boolean(options?.hideFinancials) || purchase.pricing_status === 'PENDING_RATE';
  const total = Number(purchase.total_payable || 0);
  const paid = Number(purchase.paid_amount || 0);
  const due = Math.max(0, Number((total - paid).toFixed(2)));

  if (lang === 'bn') {
    if (isPendingRate) {
      return `${branding.name}: প্রিয় ${party}, আপনার ধান গ্রহণ স্লিপ #${purchase.purchase_no} সম্পন্ন হয়েছে। জাত: ${variety}, বস্তা: ${bags}টি, গৃহীত ওজন: ${receivedKg.toLocaleString('en-IN')} কেজি (দর নির্ধারণ প্রক্রিয়াধীন)। ধন্যবাদ।`;
    }
    return `${branding.name}: প্রিয় ${party}, আপনার ধান ক্রয় রসিদ #${purchase.purchase_no} সম্পন্ন হয়েছে। জাত: ${variety}, বস্তা: ${bags}টি, বিলযোগ্য ওজন: ${netBillableKg.toLocaleString('en-IN')} কেজি, মোট বিল: ৳${total.toLocaleString('en-IN')}, পরিশোধ: ৳${paid.toLocaleString('en-IN')}, বাকি: ৳${due.toLocaleString('en-IN')}। ধন্যবাদ।`;
  }

  if (isPendingRate) {
    return `${branding.name}: Dear ${party}, your paddy intake slip #${purchase.purchase_no} is recorded. Variety: ${variety}, Bags: ${bags}, Received Wt: ${receivedKg.toLocaleString('en-IN')} kg (Rate pending). Thank you.`;
  }
  return `${branding.name}: Dear ${party}, paddy purchase #${purchase.purchase_no} completed. Variety: ${variety}, Bags: ${bags}, Net Wt: ${netBillableKg.toLocaleString('en-IN')} kg, Total: BDT ${total.toLocaleString('en-IN')}, Paid: BDT ${paid.toLocaleString('en-IN')}, Due: BDT ${due.toLocaleString('en-IN')}. Thank you.`;
}

export function buildWhatsAppHref(phone: string | undefined | null, message: string): string {
  const norm = normalizeBdPhone(phone);
  const encoded = encodeURIComponent(message);
  return norm.valid ? `https://wa.me/${norm.intl}?text=${encoded}` : `https://wa.me/?text=${encoded}`;
}

export function buildSmsHref(phone: string | undefined | null, message: string): string {
  const norm = normalizeBdPhone(phone);
  const encoded = encodeURIComponent(message);
  return norm.valid ? `sms:${norm.local}?body=${encoded}` : `sms:?body=${encoded}`;
}
