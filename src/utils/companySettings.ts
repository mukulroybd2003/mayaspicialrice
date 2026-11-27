import type { AppLang } from '../i18n/translations';
import type { CompanySettings } from '../types/erp';

const STORAGE_KEY = 'sonagrain_company_settings';

export const DEFAULT_COMPANY_SETTINGS: CompanySettings = {
  id: 1,
  company_name_en: 'Maya Special Rice',
  company_name_bn: 'মায়া স্পেশাল রাইস',
  short_code: 'MS',
  tagline_en: 'Automated Parboiled & Raw Rice Mill · Weighbridge, Milling & Wholesale Trade',
  tagline_bn: 'অটোমেটিক সিদ্ধ ও আতপ রাইস মিল · ডিজিটাল ওয়েব্রিজ, প্রসেসিং ও চাল বিপণন',
  address_en: 'Plot 14, BSCIC Industrial Estate, Bogura-5800, Bangladesh',
  address_bn: 'প্লট ১৪, বিসিক শিল্প নগরী, বগুড়া-৫৮০০, বাংলাদেশ',
  phone: '+880 1711-000000',
  email: 'admin@gmail.com',
  tax_id: 'BIN: 001234567-0101',
  logo_data_url: '',
};

let activeSettings: CompanySettings | null = null;

export function getActiveCompanySettings(): CompanySettings {
  if (activeSettings) return activeSettings;
  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<CompanySettings>;
        activeSettings = { ...DEFAULT_COMPANY_SETTINGS, ...parsed };
        return activeSettings;
      }
    } catch {
      // ignore storage errors
    }
  }
  return DEFAULT_COMPANY_SETTINGS;
}

export function setActiveCompanySettings(next: Partial<CompanySettings> | null | undefined): CompanySettings {
  const merged: CompanySettings = {
    ...DEFAULT_COMPANY_SETTINGS,
    ...(next || {}),
    short_code: (next?.short_code || DEFAULT_COMPANY_SETTINGS.short_code).trim().slice(0, 4).toUpperCase() || 'SG',
    logo_data_url: typeof next?.logo_data_url === 'string' ? next.logo_data_url.trim() : '',
  };
  activeSettings = merged;
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    } catch {
      // ignore storage errors
    }
  }
  if (typeof document !== 'undefined') {
    const lang = document.documentElement.lang === 'bn' ? 'bn' : 'en';
    document.title = lang === 'bn' ? `${merged.company_name_bn} — ERP` : `${merged.company_name_en} — ERP`;
  }
  return merged;
}

export function getCompanyBranding(lang: AppLang = 'en') {
  const s = getActiveCompanySettings();
  const isBn = lang === 'bn';
  const name = (isBn ? s.company_name_bn : s.company_name_en) || s.company_name_en || DEFAULT_COMPANY_SETTINGS.company_name_en;
  const tagline = (isBn ? s.tagline_bn : s.tagline_en) || s.tagline_en || '';
  const address = (isBn ? s.address_bn : s.address_en) || s.address_en || '';
  const metaParts = [address, s.phone, s.tax_id].filter((v) => v && v.trim().length > 0);
  return {
    settings: s,
    name,
    shortCode: s.short_code || 'SG',
    tagline,
    address,
    phone: s.phone || '',
    email: s.email || '',
    taxId: s.tax_id || '',
    logoDataUrl: (s.logo_data_url || '').trim(),
    metaLine: metaParts.join(' | '),
  };
}
