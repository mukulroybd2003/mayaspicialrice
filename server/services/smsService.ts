import net from 'net';
import { db } from '../db.ts';

export type SmsProviderType = 'NONE' | 'BULKSMSBD' | 'SMSNETBD' | 'SSLWIRELESS' | 'WEBHOOK';

export interface SmsGatewayStoredConfig {
  provider: SmsProviderType;
  enabled: boolean;
  auto_on_paddy_purchase: boolean;
  auto_on_paddy_price: boolean;
  lang_mode: 'bn' | 'en';
  sender_id: string;
  api_key: string;
  webhook_url: string;
  message_template: string;
  updated_at?: string;
}

export interface SmsGatewayPublicConfig {
  provider: SmsProviderType;
  enabled: boolean;
  auto_on_paddy_purchase: boolean;
  auto_on_paddy_price: boolean;
  lang_mode: 'bn' | 'en';
  sender_id: string;
  webhook_url: string;
  message_template: string;
  has_api_key: boolean;
  updated_at?: string;
}

const META_KEY = 'sms_gateway_config';

export const DEFAULT_SMS_CONFIG: SmsGatewayStoredConfig = {
  provider: 'NONE',
  enabled: false,
  auto_on_paddy_purchase: true,
  auto_on_paddy_price: true,
  lang_mode: 'bn',
  sender_id: '',
  api_key: '',
  webhook_url: '',
  message_template: '',
};

export function normalizeBdPhoneServer(raw?: string | null): {
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
    return { valid: true, local: `0${digits.slice(3)}`, intl: digits, e164: `+${digits}` };
  }
  if (digits.startsWith('01') && digits.length === 11) {
    return { valid: true, local: digits, intl: `88${digits}`, e164: `+88${digits}` };
  }
  if (digits.startsWith('1') && digits.length === 10) {
    return { valid: true, local: `0${digits}`, intl: `880${digits}`, e164: `+880${digits}` };
  }
  return { valid: true, local: digits, intl: digits, e164: `+${digits}` };
}

function isPrivateOrDisallowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !host ||
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.localhost')
  ) {
    return true;
  }
  const ipVer = net.isIP(host);
  if (ipVer === 4) {
    const parts = host.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (ipVer === 6) {
    if (host === '::' || host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
      return true;
    }
  }
  return false;
}

export function validateExternalWebhookUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Webhook URL must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook URL must use HTTPS');
  }
  if (isPrivateOrDisallowedHost(parsed.hostname)) {
    throw new Error('Private, loopback, or internal webhook hosts are not allowed');
  }
  return parsed.toString();
}

export async function getSmsGatewayStoredConfig(): Promise<SmsGatewayStoredConfig> {
  const row = (await db
    .prepare('SELECT meta_value FROM app_meta WHERE meta_key = ?')
    .get(META_KEY)) as { meta_value?: string } | undefined;
  if (!row?.meta_value) {
    return { ...DEFAULT_SMS_CONFIG };
  }
  try {
    const parsed = JSON.parse(row.meta_value) as Partial<SmsGatewayStoredConfig>;
    return {
      ...DEFAULT_SMS_CONFIG,
      ...parsed,
      provider: (['NONE', 'BULKSMSBD', 'SMSNETBD', 'SSLWIRELESS', 'WEBHOOK'].includes(String(parsed.provider || ''))
        ? parsed.provider
        : 'NONE') as SmsProviderType,
      lang_mode: parsed.lang_mode === 'en' ? 'en' : 'bn',
    };
  } catch {
    return { ...DEFAULT_SMS_CONFIG };
  }
}

export function maskSmsConfig(cfg: SmsGatewayStoredConfig): SmsGatewayPublicConfig {
  return {
    provider: cfg.provider,
    enabled: Boolean(cfg.enabled),
    auto_on_paddy_purchase: Boolean(cfg.auto_on_paddy_purchase),
    auto_on_paddy_price: Boolean(cfg.auto_on_paddy_price),
    lang_mode: cfg.lang_mode === 'en' ? 'en' : 'bn',
    sender_id: cfg.sender_id || '',
    webhook_url: cfg.webhook_url || '',
    message_template: cfg.message_template || '',
    has_api_key: Boolean(cfg.api_key && cfg.api_key.trim().length > 0),
    updated_at: cfg.updated_at,
  };
}

export async function saveSmsGatewayConfig(input: Partial<SmsGatewayStoredConfig> & { clear_api_key?: boolean }): Promise<SmsGatewayPublicConfig> {
  const current = await getSmsGatewayStoredConfig();
  const provider = (
    ['NONE', 'BULKSMSBD', 'SMSNETBD', 'SSLWIRELESS', 'WEBHOOK'].includes(String(input.provider || ''))
      ? input.provider
      : current.provider
  ) as SmsProviderType;

  const webhookUrl =
    typeof input.webhook_url === 'string'
      ? input.webhook_url.trim()
        ? validateExternalWebhookUrl(input.webhook_url)
        : ''
      : current.webhook_url;

  const nextApiKey = input.clear_api_key
    ? ''
    : typeof input.api_key === 'string' && input.api_key.trim().length > 0
    ? input.api_key.trim()
    : current.api_key;

  const next: SmsGatewayStoredConfig = {
    provider,
    enabled: Boolean(input.enabled ?? current.enabled) && provider !== 'NONE',
    auto_on_paddy_purchase: Boolean(input.auto_on_paddy_purchase ?? current.auto_on_paddy_purchase),
    auto_on_paddy_price: Boolean(input.auto_on_paddy_price ?? current.auto_on_paddy_price),
    lang_mode: input.lang_mode === 'en' ? 'en' : 'bn',
    sender_id: typeof input.sender_id === 'string' ? input.sender_id.trim().slice(0, 64) : current.sender_id,
    api_key: nextApiKey,
    webhook_url: webhookUrl,
    message_template: typeof input.message_template === 'string' ? input.message_template.trim().slice(0, 500) : current.message_template,
    updated_at: new Date().toISOString(),
  };

  if (next.enabled) {
    if (next.provider === 'WEBHOOK' && !next.webhook_url) {
      throw new Error('HTTPS Webhook URL is required when Webhook provider is enabled');
    }
    if (next.provider !== 'WEBHOOK' && !next.api_key) {
      throw new Error('Gateway API Key / Token is required when SMS Gateway is enabled');
    }
  }

  const serialized = JSON.stringify(next);
  const existing = await db.prepare('SELECT meta_key FROM app_meta WHERE meta_key = ?').get(META_KEY);
  if (existing) {
    await db.prepare('UPDATE app_meta SET meta_value = ? WHERE meta_key = ?').run(serialized, META_KEY);
  } else {
    await db.prepare('INSERT INTO app_meta (meta_key, meta_value) VALUES (?, ?)').run(META_KEY, serialized);
  }

  return maskSmsConfig(next);
}

export async function formatServerPaddySmsMessage(
  purchase: Record<string, unknown>,
  langMode: 'bn' | 'en',
  template?: string
): Promise<string> {
  const company = (await db.prepare('SELECT company_name_en, company_name_bn FROM company_settings WHERE id = 1').get()) as
    | { company_name_en?: string; company_name_bn?: string }
    | undefined;
  const companyName =
    (langMode === 'bn' ? company?.company_name_bn : company?.company_name_en) ||
    company?.company_name_en ||
    'Maya Special Rice';

  const partyName = String(purchase.supplier_name || (langMode === 'bn' ? 'সম্মানিত গ্রাহক' : 'Valued Party'));
  const purchaseNo = String(purchase.purchase_no || '');
  const variety = String(purchase.item_name || (langMode === 'bn' ? 'ধান' : 'Paddy'));
  const bags = Math.max(0, Number(purchase.bag_count || 0));
  const receivedKg = Number(purchase.received_weight_kg || 0);
  const netKg = Math.max(0, Number((Number(purchase.payment_weight_kg || 0) - Number(purchase.weight_loss_kg || 0)).toFixed(2)));
  const isPending = String(purchase.pricing_status || 'PRICED') === 'PENDING_RATE';
  const total = Number(purchase.total_payable || 0);
  const paid = Number(purchase.paid_amount || 0);
  const due = Math.max(0, Number((total - paid).toFixed(2)));
  const dateStr = String(purchase.created_at || new Date().toISOString()).slice(0, 10);

  if (template && template.trim() && !isPending) {
    return template
      .replace(/\{company\}/gi, companyName)
      .replace(/\{party\}/gi, partyName)
      .replace(/\{purchase_no\}/gi, purchaseNo)
      .replace(/\{variety\}/gi, variety)
      .replace(/\{bags\}/gi, String(bags))
      .replace(/\{received_kg\}/gi, receivedKg.toLocaleString('en-IN'))
      .replace(/\{payment_kg\}/gi, netKg.toLocaleString('en-IN'))
      .replace(/\{total\}/gi, total.toLocaleString('en-IN'))
      .replace(/\{paid\}/gi, paid.toLocaleString('en-IN'))
      .replace(/\{due\}/gi, due.toLocaleString('en-IN'))
      .replace(/\{date\}/gi, dateStr);
  }

  if (langMode === 'bn') {
    if (isPending) {
      return `${companyName}: প্রিয় ${partyName}, আপনার ধান গ্রহণ স্লিপ #${purchaseNo} সম্পন্ন হয়েছে। জাত: ${variety}, বস্তা: ${bags}টি, গৃহীত ওজন: ${receivedKg.toLocaleString('en-IN')} কেজি (দর নির্ধারণ বাকি)। ধন্যবাদ।`;
    }
    return `${companyName}: প্রিয় ${partyName}, আপনার ধান ক্রয় রসিদ #${purchaseNo} সম্পন্ন হয়েছে। জাত: ${variety}, বস্তা: ${bags}টি, বিলযোগ্য ওজন: ${netKg.toLocaleString('en-IN')} কেজি, মোট বিল: ৳${total.toLocaleString('en-IN')}, পরিশোধ: ৳${paid.toLocaleString('en-IN')}, বাকি: ৳${due.toLocaleString('en-IN')}। ধন্যবাদ।`;
  }

  if (isPending) {
    return `${companyName}: Dear ${partyName}, paddy intake slip #${purchaseNo} recorded. Variety: ${variety}, Bags: ${bags}, Received Wt: ${receivedKg.toLocaleString('en-IN')} kg (Rate pending). Thank you.`;
  }
  return `${companyName}: Dear ${partyName}, paddy purchase #${purchaseNo} completed. Variety: ${variety}, Bags: ${bags}, Net Wt: ${netKg.toLocaleString('en-IN')} kg, Total: BDT ${total.toLocaleString('en-IN')}, Paid: BDT ${paid.toLocaleString('en-IN')}, Due: BDT ${due.toLocaleString('en-IN')}. Thank you.`;
}

async function dispatchGatewayHttp(
  cfg: SmsGatewayStoredConfig,
  phoneRaw: string,
  message: string,
  meta: { entityType: string; entityCode: string; partyName: string }
): Promise<{ ok: boolean; responseText: string }> {
  const norm = normalizeBdPhoneServer(phoneRaw);
  if (!norm.valid) {
    return { ok: false, responseText: 'Invalid or missing recipient phone number' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6500);

  try {
    if (cfg.provider === 'BULKSMSBD') {
      const params = new URLSearchParams({
        api_key: cfg.api_key,
        type: 'text',
        number: norm.intl,
        senderid: cfg.sender_id || '',
        message,
      });
      const res = await fetch('https://bulksmsbd.net/api/smsapi', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        signal: controller.signal,
      });
      const txt = await res.text();
      let ok = res.ok;
      try {
        const j = JSON.parse(txt) as { response_code?: number; error_message?: string };
        if (typeof j.response_code === 'number') {
          ok = j.response_code === 202;
        }
      } catch {
        // non-JSON response
      }
      return { ok, responseText: txt.slice(0, 400) };
    }

    if (cfg.provider === 'SMSNETBD') {
      const form = new URLSearchParams({
        api_key: cfg.api_key,
        msg: message,
        to: norm.intl,
      });
      if (cfg.sender_id) form.set('sender_id', cfg.sender_id);
      const res = await fetch('https://api.sms.net.bd/sendsms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: controller.signal,
      });
      const txt = await res.text();
      let ok = res.ok;
      try {
        const j = JSON.parse(txt) as { error?: number };
        if (typeof j.error === 'number') {
          ok = j.error === 0;
        }
      } catch {
        // fallback to HTTP status
      }
      return { ok, responseText: txt.slice(0, 400) };
    }

    if (cfg.provider === 'SSLWIRELESS') {
      const res = await fetch('https://smsplus.sslwireless.com/api/v3/send-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          api_token: cfg.api_key,
          sid: cfg.sender_id,
          msisdn: norm.intl,
          sms: message,
          csms_id: `${meta.entityCode}-${Date.now()}`.slice(0, 32),
        }),
        signal: controller.signal,
      });
      const txt = await res.text();
      let ok = res.ok;
      try {
        const j = JSON.parse(txt) as { status?: string; status_code?: number };
        if (j.status) ok = j.status.toUpperCase() === 'SUCCESS';
      } catch {
        // fallback
      }
      return { ok, responseText: txt.slice(0, 400) };
    }

    if (cfg.provider === 'WEBHOOK') {
      const safeUrl = validateExternalWebhookUrl(cfg.webhook_url);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (cfg.api_key) {
        headers['Authorization'] = `Bearer ${cfg.api_key}`;
      }
      const res = await fetch(safeUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          to: norm.intl,
          phone_local: norm.local,
          phone_e164: norm.e164,
          sender_id: cfg.sender_id || undefined,
          message,
          party_name: meta.partyName,
          entity_type: meta.entityType,
          reference_no: meta.entityCode,
          timestamp: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
      const txt = await res.text();
      return { ok: res.ok, responseText: txt.slice(0, 400) || `HTTP ${res.status}` };
    }

    return { ok: false, responseText: 'No SMS gateway provider configured' };
  } catch (err) {
    return { ok: false, responseText: (err as Error).message.slice(0, 400) };
  } finally {
    clearTimeout(timer);
  }
}

export async function recordSmsLog(entry: {
  entityType: string;
  entityId: number;
  entityCode: string;
  partyId?: number | null;
  partyName: string;
  phone: string;
  provider: string;
  messageBody: string;
  status: 'SENT' | 'FAILED' | 'SKIPPED' | 'MANUAL_WHATSAPP' | 'MANUAL_SMS';
  providerResponse: string;
  createdBy?: number | null;
}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sms_logs (
         entity_type, entity_id, entity_code, party_id, party_name, phone,
         provider, message_body, status, provider_response, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.entityType,
      entry.entityId,
      entry.entityCode,
      entry.partyId ?? null,
      entry.partyName,
      entry.phone,
      entry.provider,
      entry.messageBody,
      entry.status,
      entry.providerResponse,
      entry.createdBy ?? null
    );
}

export interface AutoSmsResult {
  attempted: boolean;
  status: 'SENT' | 'FAILED' | 'SKIPPED' | 'NOT_CONFIGURED';
  phone: string;
  provider: SmsProviderType;
  message_preview: string;
  error?: string;
}

export async function dispatchPaddyPurchaseSms(params: {
  purchase: Record<string, unknown>;
  employeeId: number;
  forceManualSend?: boolean;
  overridePhone?: string;
  overrideLang?: 'bn' | 'en';
  triggerType: 'CREATE' | 'PRICE' | 'MANUAL';
}): Promise<AutoSmsResult> {
  const cfg = await getSmsGatewayStoredConfig();
  const langMode = params.overrideLang || cfg.lang_mode || 'bn';
  const message = await formatServerPaddySmsMessage(params.purchase, langMode, cfg.message_template);
  const rawPhone = String(params.overridePhone || params.purchase.supplier_phone || '').trim();
  const partyName = String(params.purchase.supplier_name || '');
  const purchaseId = Number(params.purchase.id || 0);
  const purchaseNo = String(params.purchase.purchase_no || '');
  const partyId = Number(params.purchase.supplier_id || 0) || null;

  if (!cfg.enabled || cfg.provider === 'NONE') {
    return {
      attempted: false,
      status: 'NOT_CONFIGURED',
      phone: rawPhone,
      provider: cfg.provider,
      message_preview: message,
    };
  }

  if (!params.forceManualSend) {
    if (params.triggerType === 'CREATE' && !cfg.auto_on_paddy_purchase) {
      return {
        attempted: false,
        status: 'SKIPPED',
        phone: rawPhone,
        provider: cfg.provider,
        message_preview: message,
      };
    }
    if (params.triggerType === 'PRICE' && !cfg.auto_on_paddy_price) {
      return {
        attempted: false,
        status: 'SKIPPED',
        phone: rawPhone,
        provider: cfg.provider,
        message_preview: message,
      };
    }
  }

  const norm = normalizeBdPhoneServer(rawPhone);
  if (!norm.valid) {
    await recordSmsLog({
      entityType: 'PADDY_PURCHASE',
      entityId: purchaseId,
      entityCode: purchaseNo,
      partyId,
      partyName,
      phone: rawPhone,
      provider: cfg.provider,
      messageBody: message,
      status: 'SKIPPED',
      providerResponse: 'Missing or invalid supplier phone number',
      createdBy: params.employeeId,
    });
    return {
      attempted: false,
      status: 'SKIPPED',
      phone: rawPhone,
      provider: cfg.provider,
      message_preview: message,
      error: 'Missing or invalid supplier phone number',
    };
  }

  const dispatch = await dispatchGatewayHttp(cfg, norm.intl, message, {
    entityType: 'PADDY_PURCHASE',
    entityCode: purchaseNo,
    partyName,
  });

  await recordSmsLog({
    entityType: 'PADDY_PURCHASE',
    entityId: purchaseId,
    entityCode: purchaseNo,
    partyId,
    partyName,
    phone: norm.local,
    provider: cfg.provider,
    messageBody: message,
    status: dispatch.ok ? 'SENT' : 'FAILED',
    providerResponse: dispatch.responseText,
    createdBy: params.employeeId,
  });

  return {
    attempted: true,
    status: dispatch.ok ? 'SENT' : 'FAILED',
    phone: norm.local,
    provider: cfg.provider,
    message_preview: message,
    error: dispatch.ok ? undefined : dispatch.responseText,
  };
}

export async function sendTestSmsMessage(params: {
  phone: string;
  message?: string;
  employeeId: number;
}): Promise<{ ok: boolean; status: string; providerResponse: string; phone: string }> {
  const cfg = await getSmsGatewayStoredConfig();
  if (!cfg.enabled || cfg.provider === 'NONE') {
    throw new Error('Enable an SMS gateway provider before sending a test message');
  }
  const norm = normalizeBdPhoneServer(params.phone);
  if (!norm.valid) {
    throw new Error('Valid recipient mobile number is required (e.g. 017XXXXXXXX)');
  }
  const text =
    (params.message || '').trim() ||
    (cfg.lang_mode === 'bn'
      ? 'টেস্ট SMS: আপনার রাইস মিল ERP অটো মেসেজিং সিস্টেম সঠিকভাবে কাজ করছে।'
      : 'Test SMS: Your Rice Mill ERP auto-messaging gateway is configured properly.');

  const res = await dispatchGatewayHttp(cfg, norm.intl, text, {
    entityType: 'TEST',
    entityCode: 'TEST-SMS',
    partyName: 'Admin Test',
  });

  await recordSmsLog({
    entityType: 'TEST',
    entityId: 0,
    entityCode: 'TEST-SMS',
    partyId: null,
    partyName: 'Admin Test',
    phone: norm.local,
    provider: cfg.provider,
    messageBody: text,
    status: res.ok ? 'SENT' : 'FAILED',
    providerResponse: res.responseText,
    createdBy: params.employeeId,
  });

  return {
    ok: res.ok,
    status: res.ok ? 'SENT' : 'FAILED',
    providerResponse: res.responseText,
    phone: norm.local,
  };
}
