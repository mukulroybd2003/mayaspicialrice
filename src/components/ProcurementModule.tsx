import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Check, Copy, Eye, FileText, MessageSquare, Package, Phone, Plus, QrCode, RotateCcw, Search, Send, Split, Sun, Tag, Trash2, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { apiGet, apiMutate } from '../services/api';
import type { Account, InventoryLot, ItemMaster, PaddyPurchase, PaddyPurchaseReturn, Party, SmsNotificationResult, Warehouse, WeighbridgeMode } from '../types/erp';
import { exportPurchaseReturnSlipPdf, exportWeighbridgeSlipPdf, generateQrDataUrl } from '../utils/reports';
import { buildSmsHref, buildWhatsAppHref, formatPaddyPurchaseMessage, normalizeBdPhone } from '../utils/smsMessage';
import { SupplierBagLedgerPanel } from './SupplierBagLedgerPanel';

interface ProcurementModuleProps {
  purchases: PaddyPurchase[];
  suppliers: Party[];
  warehouses: Warehouse[];
  paddyItems: ItemMaster[];
  lots?: InventoryLot[];
  accounts?: Account[];
  hideFinancials?: boolean;
  onRefresh: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

export const ProcurementModule: React.FC<ProcurementModuleProps> = ({
  purchases,
  suppliers,
  warehouses,
  paddyItems,
  lots = [],
  accounts = [],
  hideFinancials = false,
  onRefresh,
  onNotify,
}) => {
  const { lang, t } = useI18n();
  const isBn = lang === 'bn';
  const [activeTab, setActiveTab] = useState<'purchases' | 'bags'>('purchases');
  const [showForm, setShowForm] = useState(false);
  const [search, setSearch] = useState('');
  const [listFilter, setListFilter] = useState<'ALL' | 'RAW_WET' | 'FLAGGED'>('ALL');
  const [qrPreview, setQrPreview] = useState<{ code: string; dataUrl: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [quickModal, setQuickModal] = useState<'paddy' | 'warehouse' | 'supplier' | null>(null);
  const [quickSaving, setQuickSaving] = useState(false);
  const [quickPaddy, setQuickPaddy] = useState({ name: '', sku: '', default_rate: 0 });
  const [quickWh, setQuickWh] = useState({ code: '', name: '', location: '', capacity_kg: 0 });
  const [quickSupplier, setQuickSupplier] = useState({ name: '', phone: '', address: '' });

  // Optional collapsed Multi-Godown Split state (Req 3)
  const [showSplitBox, setShowSplitBox] = useState(false);
  const [godownSplits, setGodownSplits] = useState<
    Array<{
      uid: string;
      warehouse_id: number;
      bag_count: number;
      jute_bag_count: number;
      plastic_bag_count: number;
      received_weight_kg: number;
    }>
  >([]);

  // Paddy Purchase Return modal state (Req 2)
  const [returningPurchase, setReturningPurchase] = useState<PaddyPurchase | null>(null);
  const [returnAccounts, setReturnAccounts] = useState<Account[]>([]);
  const [returnSubmitting, setReturnSubmitting] = useState(false);
  const [lastReturnSlip, setLastReturnSlip] = useState<{ ret: PaddyPurchaseReturn; purchase: PaddyPurchase } | null>(null);
  const [returnForm, setReturnForm] = useState({
    return_type: 'PHYSICAL_RETURN' as 'PHYSICAL_RETURN' | 'FINANCIAL_ADJUSTMENT',
    return_qty_kg: 0,
    return_jute_bags: 0,
    return_plastic_bags: 0,
    return_amount: 0,
    refund_mode: 'ADJUST_PAYABLE' as 'ADJUST_PAYABLE' | 'CASH_REFUND',
    account_id: 0,
    reason: '',
  });

  // Admin Rate & Settlement modal for Godown Keeper PENDING_RATE intakes
  const [pricingPurchase, setPricingPurchase] = useState<PaddyPurchase | null>(null);
  const [pricingSubmitting, setPricingSubmitting] = useState(false);
  const [pricingForm, setPricingForm] = useState({
    weight_loss_kg: 0,
    settlement_unit_kg: 75.5,
    settlement_rate: 0,
    paid_amount: 0,
  });

  // Auto SMS / Customer Messaging state
  const [smsStatus, setSmsStatus] = useState<{ configured: boolean; auto_on_paddy_purchase: boolean; auto_on_paddy_price: boolean; provider: string; lang_mode: 'bn' | 'en' }>({
    configured: false,
    auto_on_paddy_purchase: true,
    auto_on_paddy_price: true,
    provider: 'NONE',
    lang_mode: 'bn',
  });
  const [autoSendSms, setAutoSendSms] = useState(true);
  const [lastSmsBanner, setLastSmsBanner] = useState<{
    purchase: PaddyPurchase;
    sms: SmsNotificationResult | null;
    phone: string;
    lang: 'bn' | 'en';
    message: string;
    isOfflineQueued?: boolean;
  } | null>(null);
  const [bannerSending, setBannerSending] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [msgModalPurchase, setMsgModalPurchase] = useState<PaddyPurchase | null>(null);
  const [msgModalPhone, setMsgModalPhone] = useState('');
  const [msgModalLang, setMsgModalLang] = useState<'bn' | 'en'>('bn');
  const [msgModalText, setMsgModalText] = useState('');
  const [msgModalSending, setMsgModalSending] = useState(false);

  // Direct "Dry Purchased Paddy" modal state
  const [dryModalPurchase, setDryModalPurchase] = useState<PaddyPurchase | null>(null);
  const [dryModalSubmitting, setDryModalSubmitting] = useState(false);
  const [dryModalForm, setDryModalForm] = useState({
    target_mode: 'QUICK_DRY' as 'QUICK_DRY' | 'CHATAL',
    source_warehouse_id: 0,
    dest_warehouse_id: 0,
    drying_method: 'SUN_YARD' as 'SUN_YARD' | 'MECHANICAL_DRYER',
    input_qty_kg: 0,
    input_bags: 0,
    output_bags: 0,
    output_qty_kg: 0,
    weight_pending: true,
    initial_moisture_pct: 0,
    final_moisture_pct: 0,
    fuel_power_cost: 0,
    labor_cost: 0,
    chatal_title: '',
    khamal_cost: 0,
    payment_timing: 'PAID' as 'PAID' | 'UNPAID' | 'PARTIAL',
    paid_now: 0,
    account_id: 0,
    notes: '',
  });

  useEffect(() => {
    let mounted = true;
    apiGet<{ configured: boolean; auto_on_paddy_purchase: boolean; auto_on_paddy_price: boolean; provider: string; lang_mode: 'bn' | 'en' }>(
      '/api/v1/sms/status',
      'cache_sms_status'
    )
      .then((res) => {
        if (mounted && res) {
          setSmsStatus(res);
        }
      })
      .catch(() => {
        // Ignore offline/unconfigured fallback
      });
    return () => {
      mounted = false;
    };
  }, []);

  const defaultSettlementUnit = 75.5;
  const initialPerKg = paddyItems[0]?.default_rate || 0;

  const [form, setForm] = useState({
    supplier_id: suppliers[0]?.id || 0,
    warehouse_id: warehouses.find((w) => w.warehouse_type === 'RAW_PADDY')?.id || warehouses[0]?.id || 0,
    item_id: paddyItems[0]?.id || 0,
    vehicle_no: '',
    challan_no: '',
    jute_bag_count: 0,
    plastic_bag_count: 0,
    moisture_pct: 0,
    supplier_claimed_weight_kg: 0,
    scale_weight_kg: 0,
    received_weight_kg: 0,
    payment_weight_kg: 0,
    weight_loss_kg: 0,
    settlement_unit_kg: defaultSettlementUnit,
    settlement_rate: initialPerKg > 0 ? Number((initialPerKg * defaultSettlementUnit).toFixed(2)) : 0,
    paid_amount: 0,
    paddy_condition: 'RAW_WET' as 'RAW_WET' | 'DRIED',
    weighbridge_mode: 'MANUAL' as WeighbridgeMode,
    discrepancy_notes: '',
  });

  const totalBagCount = Math.max(0, Math.round(Number(form.jute_bag_count || 0))) + Math.max(0, Math.round(Number(form.plastic_bag_count || 0)));

  const effectiveSupplierId = useMemo(
    () => (suppliers.some((s) => s.id === form.supplier_id) ? form.supplier_id : suppliers[0]?.id || 0),
    [suppliers, form.supplier_id]
  );
  const effectiveWarehouseId = useMemo(
    () =>
      warehouses.some((w) => w.id === form.warehouse_id)
        ? form.warehouse_id
        : warehouses.find((w) => w.warehouse_type === 'RAW_PADDY')?.id || warehouses[0]?.id || 0,
    [warehouses, form.warehouse_id]
  );
  const effectiveItemId = useMemo(
    () => (paddyItems.some((i) => i.id === form.item_id) ? form.item_id : paddyItems[0]?.id || 0),
    [paddyItems, form.item_id]
  );
  const selectedSupplier = useMemo(
    () => suppliers.find((s) => s.id === effectiveSupplierId) || null,
    [suppliers, effectiveSupplierId]
  );
  const selectedItem = useMemo(
    () => paddyItems.find((i) => i.id === effectiveItemId) || null,
    [paddyItems, effectiveItemId]
  );

  const discrepancy = Number((form.scale_weight_kg - form.supplier_claimed_weight_kg).toFixed(2));
  const netSettlementWeight = Math.max(0, Number((form.payment_weight_kg - form.weight_loss_kg).toFixed(3)));
  const divisor = form.settlement_unit_kg > 0 ? form.settlement_unit_kg : 75.5;
  const settlementUnits = Number((netSettlementWeight / divisor).toFixed(4));
  const totalPayable = Number((settlementUnits * form.settlement_rate).toFixed(2));
  const effectiveRatePerKg =
    form.payment_weight_kg > 0 ? Number((totalPayable / form.payment_weight_kg).toFixed(4)) : 0;

  const filtered = purchases.filter((p) => {
    const isRawWet = p.paddy_condition !== 'DRIED';
    const unconsumedKg = Number(p.unconsumed_lot_qty_kg ?? Math.max(0, p.received_weight_kg - (p.returned_qty_kg || 0)));
    if (listFilter === 'RAW_WET' && (!isRawWet || unconsumedKg <= 0.01)) return false;
    if (listFilter === 'FLAGGED' && !p.discrepancy_flagged) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      p.purchase_no.toLowerCase().includes(q) ||
      (p.supplier_name || '').toLowerCase().includes(q) ||
      (p.vehicle_no || '').toLowerCase().includes(q)
    );
  });

  const rawDryingStats = useMemo(() => {
    let rawCount = 0;
    let totalRawPurchasedKg = 0;
    let totalRawPurchasedBags = 0;
    let sentToDryKg = 0;
    let sentToDryBags = 0;
    let driedOutputKg = 0;
    let driedOutputBags = 0;
    let dryingLossKg = 0;
    let pendingOutputBags = 0;
    let remainingRawKg = 0;
    let remainingRawBags = 0;

    for (const p of purchases) {
      const ds = p.drying_summary;
      if (p.paddy_condition !== 'DRIED') {
        rawCount += 1;
        totalRawPurchasedKg += Number(p.received_weight_kg || 0);
        totalRawPurchasedBags += Number(p.bag_count || 0);
        const remKg = Number(p.unconsumed_lot_qty_kg ?? 0);
        const remBags = Number(p.unconsumed_lot_bags ?? 0);
        if (remKg > 0.01) {
          remainingRawKg += remKg;
          remainingRawBags += remBags;
        }
      }
      if (ds) {
        sentToDryKg += Number(ds.dried_input_kg || 0) + Number(ds.chatal_input_kg || 0);
        sentToDryBags += Number(ds.dried_input_bags || 0) + Number(ds.chatal_input_bags || 0);
        driedOutputKg += Number(ds.dried_output_kg || 0);
        driedOutputBags += Number(ds.dried_output_bags || 0);
        dryingLossKg += Number(ds.drying_loss_kg || 0);
        pendingOutputBags += Number(ds.pending_output_bags || 0);
      }
    }

    return {
      rawCount,
      totalRawPurchasedKg: Number(totalRawPurchasedKg.toFixed(2)),
      totalRawPurchasedBags,
      sentToDryKg: Number(sentToDryKg.toFixed(2)),
      sentToDryBags,
      driedOutputKg: Number(driedOutputKg.toFixed(2)),
      driedOutputBags,
      dryingLossKg: Number(dryingLossKg.toFixed(2)),
      pendingOutputBags,
      remainingRawKg: Number(remainingRawKg.toFixed(2)),
      remainingRawBags,
    };
  }, [purchases]);

  const splitSumKg = useMemo(
    () => Number(godownSplits.reduce((s, r) => s + Number(r.received_weight_kg || 0), 0).toFixed(2)),
    [godownSplits]
  );
  const splitSumBags = useMemo(
    () => godownSplits.reduce((s, r) => s + Math.max(0, Math.round(Number(r.bag_count || 0))), 0),
    [godownSplits]
  );

  const toggleMultiGodownSplit = () => {
    if (showSplitBox) {
      setShowSplitBox(false);
      return;
    }
    const wh1 = effectiveWarehouseId || warehouses[0]?.id || 0;
    const wh2 = warehouses.find((w) => w.id !== wh1)?.id || wh1;
    const halfBags = Math.floor(totalBagCount / 2);
    const remBags = Math.max(0, totalBagCount - halfBags);
    const halfKg = Number((form.received_weight_kg / 2).toFixed(2));
    const remKg = Number((form.received_weight_kg - halfKg).toFixed(2));
    setGodownSplits([
      {
        uid: crypto.randomUUID(),
        warehouse_id: wh1,
        bag_count: halfBags,
        jute_bag_count: halfBags,
        plastic_bag_count: 0,
        received_weight_kg: halfKg,
      },
      {
        uid: crypto.randomUUID(),
        warehouse_id: wh2,
        bag_count: remBags,
        jute_bag_count: remBags,
        plastic_bag_count: 0,
        received_weight_kg: remKg,
      },
    ]);
    setShowSplitBox(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveSupplierId || !effectiveWarehouseId || !effectiveItemId) {
      onNotify(
        lang === 'bn'
          ? 'প্রথমে অন্তত একটি সক্রিয় সাপ্লায়ার, গুদাম ও ধানের পণ্য নিশ্চিত করুন।'
          : 'Ensure at least one active Supplier, Warehouse, and Paddy Product exist first.',
        'err'
      );
      return;
    }
    if (netSettlementWeight <= 0) {
      onNotify(
        lang === 'bn'
          ? 'নিট সেটেলমেন্ট ওজন (পেমেন্ট ওজন − ঘাটতি) অবশ্যই শূন্যের বেশি হতে হবে।'
          : 'Net Settlement Weight (Payment Settlement Weight - Weight Loss) must be greater than zero.',
        'err'
      );
      return;
    }
    if (showSplitBox) {
      if (godownSplits.length < 2) {
        onNotify(isBn ? 'একাধিক গোডাউনে ভাগ করতে কমপক্ষে ২টি গোডাউন দিন।' : 'Provide at least 2 split godown rows.', 'err');
        return;
      }
      if (Math.abs(splitSumKg - form.received_weight_kg) > 0.5) {
        onNotify(
          isBn
            ? `ভাগ করা ওজনের যোগফল (${splitSumKg} kg) অবশ্যই মোট গৃহীত ওজন (${form.received_weight_kg} kg)-এর সমান হতে হবে।`
            : `Split weights sum (${splitSumKg} kg) must equal received weight (${form.received_weight_kg} kg).`,
          'err'
        );
        return;
      }
      if (totalBagCount > 0 && splitSumBags !== totalBagCount) {
        onNotify(
          isBn
            ? `ভাগ করা বস্তার যোগফল (${splitSumBags}) অবশ্যই মোট বস্তা (${totalBagCount})-এর সমান হতে হবে।`
            : `Split bags sum (${splitSumBags}) must equal total bags (${totalBagCount}).`,
          'err'
        );
        return;
      }
    }

    setSubmitting(true);
    try {
      const payload = {
        ...form,
        bag_count: totalBagCount,
        jute_bag_count: Math.max(0, Math.round(Number(form.jute_bag_count || 0))),
        plastic_bag_count: Math.max(0, Math.round(Number(form.plastic_bag_count || 0))),
        supplier_id: effectiveSupplierId,
        warehouse_id: effectiveWarehouseId,
        item_id: effectiveItemId,
        pending_rate: hideFinancials,
        rate_per_kg: hideFinancials ? 0 : effectiveRatePerKg,
        settlement_rate: hideFinancials ? 0 : form.settlement_rate,
        paid_amount: hideFinancials ? 0 : form.paid_amount,
        auto_send_sms: autoSendSms,
        splits: showSplitBox
          ? godownSplits.map((s) => ({
              warehouse_id: s.warehouse_id,
              bag_count: Math.max(0, Math.round(Number(s.bag_count || 0))),
              jute_bag_count: Math.max(0, Math.round(Number(s.bag_count || 0))),
              plastic_bag_count: 0,
              received_weight_kg: Number(s.received_weight_kg || 0),
            }))
          : undefined,
      };
      const submittedSupplierPhone = selectedSupplier?.phone || '';
      const submittedSupplierName = selectedSupplier?.name || '';
      const submittedItemName = selectedItem?.name || (isBn ? 'ধান' : 'Paddy');
      const submittedMsgLang: 'bn' | 'en' = isBn ? 'bn' : 'en';
      const res = await apiMutate<{
        status: string;
        purchase?: PaddyPurchase;
        sms_notification?: SmsNotificationResult | null;
      }>({
        endpoint: '/api/v1/paddy-purchases',
        payload,
        module: hideFinancials ? 'Paddy Intake' : 'Paddy Purchase',
        summary: hideFinancials
          ? `${form.received_weight_kg} kg (${totalBagCount} bags) · ${isBn ? 'দর নির্ধারণ বাকি' : 'Pending Rate'}`
          : `${form.received_weight_kg} kg (${totalBagCount} bags) · Payable ৳${totalPayable.toLocaleString('en-IN')}`,
      });
      if (res.offlineQueued) {
        onNotify(
          lang === 'bn'
            ? 'অফলাইন: ধান গ্রহণ IndexedDB সিঙ্ক কিউতে সংরক্ষিত হয়েছে।'
            : 'Offline: Paddy intake saved to IndexedDB sync queue.',
          'warn'
        );
        if (autoSendSms) {
          const offlineDraft: PaddyPurchase = {
            id: 0,
            client_uuid: res.client_uuid,
            purchase_no: isBn ? 'অফলাইন-রসিদ' : 'OFFLINE-DRAFT',
            supplier_id: effectiveSupplierId,
            supplier_name: submittedSupplierName,
            supplier_phone: submittedSupplierPhone,
            warehouse_id: effectiveWarehouseId,
            item_id: effectiveItemId,
            item_name: submittedItemName,
            bag_count: totalBagCount,
            moisture_pct: form.moisture_pct,
            supplier_claimed_weight_kg: form.supplier_claimed_weight_kg,
            scale_weight_kg: form.scale_weight_kg,
            received_weight_kg: form.received_weight_kg,
            payment_weight_kg: form.payment_weight_kg,
            weight_loss_kg: form.weight_loss_kg,
            weight_discrepancy_kg: discrepancy,
            discrepancy_flagged: 0,
            rate_per_kg: hideFinancials ? 0 : effectiveRatePerKg,
            total_payable: hideFinancials ? 0 : totalPayable,
            paid_amount: hideFinancials ? 0 : form.paid_amount,
            pricing_status: hideFinancials ? 'PENDING_RATE' : 'PRICED',
            payment_status: 'UNPAID',
            qr_code_uid: '',
            weighbridge_mode: form.weighbridge_mode,
            created_by: 0,
            created_at: new Date().toISOString(),
          };
          setLastSmsBanner({
            purchase: offlineDraft,
            sms: null,
            phone: submittedSupplierPhone,
            lang: submittedMsgLang,
            message: formatPaddyPurchaseMessage(offlineDraft, submittedMsgLang, { hideFinancials }),
            isOfflineQueued: true,
          });
        }
      } else {
        const createdPurchase = res.data?.purchase;
        const smsNote = res.data?.sms_notification || null;
        if (smsNote?.status === 'SENT') {
          onNotify(
            isBn
              ? `ক্রয় সংরক্ষিত হয়েছে এবং কাস্টমার (${smsNote.phone}) নম্বরে অটো SMS পাঠানো হয়েছে।`
              : `Purchase saved and auto-SMS sent to ${smsNote.phone}.`,
            'ok'
          );
        } else {
          onNotify(
            hideFinancials
              ? lang === 'bn'
                ? '৪টি ওজন, বস্তা ও কিউআর লট সহ ধান গ্রহণ সংরক্ষিত হয়েছে (দর নির্ধারণ বাকি)।'
                : 'Paddy intake recorded with 4 weights, bags & QR lot (Pending Rate).'
              : lang === 'bn'
              ? '৪টি ওজন, ঘাটতি ও কিউআর লট সহ ধান ক্রয় সংরক্ষিত হয়েছে।'
              : 'Paddy purchase recorded with all 4 weights, loss deduction & QR lot.',
            'ok'
          );
        }
        if (createdPurchase && (autoSendSms || smsNote)) {
          const fallbackMsg = formatPaddyPurchaseMessage(createdPurchase, submittedMsgLang, { hideFinancials });
          setLastSmsBanner({
            purchase: createdPurchase,
            sms: smsNote,
            phone: smsNote?.phone || createdPurchase.supplier_phone || submittedSupplierPhone,
            lang: submittedMsgLang,
            message: smsNote?.message_preview || fallbackMsg,
          });
        }
      }
      setShowSplitBox(false);
      setGodownSplits([]);
      setForm((prev) => ({
        ...prev,
        vehicle_no: '',
        challan_no: '',
        jute_bag_count: 0,
        plastic_bag_count: 0,
        moisture_pct: 0,
        supplier_claimed_weight_kg: 0,
        scale_weight_kg: 0,
        received_weight_kg: 0,
        payment_weight_kg: 0,
        weight_loss_kg: 0,
        paid_amount: 0,
        discrepancy_notes: '',
      }));
      setShowForm(false);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSubmitting(false);
    }
  };

  const openReturnModal = async (p: PaddyPurchase) => {
    const remainingByPurchase = Math.max(0, Number((p.received_weight_kg - (p.returned_qty_kg || 0)).toFixed(2)));
    const varietyStock = Number(p.available_variety_stock_kg ?? p.unconsumed_lot_qty_kg ?? remainingByPurchase);
    const maxPhysical = Math.max(0, Number(Math.min(remainingByPurchase, varietyStock).toFixed(2)));
    const maxAmt = Math.max(0, Number((p.total_payable - (p.returned_amount || 0)).toFixed(2)));
    const defaultMode: 'PHYSICAL_RETURN' | 'FINANCIAL_ADJUSTMENT' = maxPhysical > 0.01 ? 'PHYSICAL_RETURN' : 'FINANCIAL_ADJUSTMENT';
    const defaultKg = defaultMode === 'PHYSICAL_RETURN' ? maxPhysical : 0;
    const propAmt =
      defaultMode === 'PHYSICAL_RETURN' && p.received_weight_kg > 0
        ? Math.min(maxAmt, Number(((defaultKg / p.received_weight_kg) * p.total_payable).toFixed(2)))
        : 0;
    const unconsumedBags = Number(p.unconsumed_lot_bags ?? 0);
    setReturningPurchase(p);
    setReturnForm({
      return_type: defaultMode,
      return_qty_kg: defaultKg,
      return_jute_bags: defaultMode === 'PHYSICAL_RETURN' ? Math.max(0, unconsumedBags > 0 ? Math.min(unconsumedBags, p.jute_bag_count || p.bag_count || 0) : 0) : 0,
      return_plastic_bags: defaultMode === 'PHYSICAL_RETURN' && unconsumedBags > 0 ? Math.max(0, p.plastic_bag_count || 0) : 0,
      return_amount: propAmt,
      refund_mode: 'ADJUST_PAYABLE',
      account_id: returnAccounts[0]?.id || 0,
      reason: '',
    });
    if (returnAccounts.length === 0) {
      try {
        const accs = await apiGet<Account[]>('/api/v1/accounts', 'cache_accounts');
        const cashBank = accs.filter(
          (a) => a.account_code === '1001' || a.account_code === '1002' || (a.account_type === 'ASSET' && /cash|bank/i.test(a.name))
        );
        const list = cashBank.length > 0 ? cashBank : accs;
        setReturnAccounts(list);
        setReturnForm((prev) => ({ ...prev, account_id: list[0]?.id || 0 }));
      } catch {
        // Ignore offline/cached fallback
      }
    }
  };

  const handleSubmitReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returningPurchase) return;
    const remByPurchase = Math.max(0, Number((returningPurchase.received_weight_kg - (returningPurchase.returned_qty_kg || 0)).toFixed(3)));
    const varietyStock = Number(returningPurchase.available_variety_stock_kg ?? returningPurchase.unconsumed_lot_qty_kg ?? remByPurchase);
    const maxPhysical = Math.max(0, Number(Math.min(remByPurchase, varietyStock).toFixed(2)));
    const maxAmt = Math.max(0, Number((returningPurchase.total_payable - (returningPurchase.returned_amount || 0)).toFixed(2)));

    if (returnForm.return_type === 'PHYSICAL_RETURN') {
      if (maxPhysical <= 0.01) {
        onNotify(
          isBn
            ? `${returningPurchase.purchase_no}-এর ধান ইতিমধ্যেই ব্যবহৃত হয়ে গেছে। স্টক ছাড়া 'শুধু টাকা/ভুল বিল সংশোধন' মোড বেছে নিন।`
            : `No unconsumed stock remains for ${returningPurchase.purchase_no}. Switch to Financial Adjustment mode.`,
          'err'
        );
        return;
      }
      if (returnForm.return_qty_kg <= 0 || returnForm.return_qty_kg > maxPhysical + 0.01) {
        onNotify(
          isBn
            ? `ফেরতের ওজন অবশ্যই ০ কেজির বেশি এবং অব্যবহৃত মজুদ ${maxPhysical.toLocaleString()} কেজির মধ্যে হতে হবে।`
            : `Return quantity must be between 0 and available unconsumed stock (${maxPhysical} kg).`,
          'err'
        );
        return;
      }
    }
    if (returnForm.return_amount <= 0 || returnForm.return_amount > maxAmt + 0.01) {
      onNotify(
        isBn
          ? `ফেরত/সমন্বয় মূল্য অবশ্যই ৳০-এর বেশি এবং অবশিষ্ট ৳${maxAmt.toLocaleString('en-IN')}-এর মধ্যে হতে হবে।`
          : `Return/adjustment amount must be between 0 and ৳${maxAmt}.`,
        'err'
      );
      return;
    }

    setReturnSubmitting(true);
    try {
      const res = await apiMutate<{ status: string; return_record?: PaddyPurchaseReturn }>({
        endpoint: `/api/v1/paddy-purchases/${returningPurchase.id}/return`,
        method: 'POST',
        payload: {
          return_type: returnForm.return_type,
          return_qty_kg: returnForm.return_qty_kg,
          return_jute_bags: Math.max(0, Math.round(Number(returnForm.return_jute_bags || 0))),
          return_plastic_bags: Math.max(0, Math.round(Number(returnForm.return_plastic_bags || 0))),
          return_amount: returnForm.return_amount,
          refund_mode: returnForm.refund_mode,
          account_id: returnForm.refund_mode === 'CASH_REFUND' ? returnForm.account_id || undefined : undefined,
          reason: returnForm.reason.trim(),
        },
        module: 'Paddy Purchase Return',
        summary:
          returnForm.return_type === 'FINANCIAL_ADJUSTMENT'
            ? `Financial adjust ৳${returnForm.return_amount} on ${returningPurchase.purchase_no}`
            : `Return ${returnForm.return_qty_kg} kg from ${returningPurchase.purchase_no}`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: ধান ফেরত সিঙ্ক কিউতে জমা হয়েছে।' : 'Offline: Purchase return queued for sync.', 'warn');
      } else {
        if (res.data?.return_record) {
          setLastReturnSlip({ ret: res.data.return_record, purchase: returningPurchase });
        }
        onNotify(
          returnForm.return_type === 'FINANCIAL_ADJUSTMENT'
            ? isBn
              ? `${returningPurchase.purchase_no}-এর ৳${returnForm.return_amount.toLocaleString('en-IN')} টাকা/হিসাব সফলভাবে সমন্বয় করা হয়েছে।`
              : `Financial adjustment of ৳${returnForm.return_amount} posted for ${returningPurchase.purchase_no}.`
            : isBn
            ? `${returningPurchase.purchase_no} থেকে ${returnForm.return_qty_kg} কেজি ধান সফলভাবে ফেরত করা হয়েছে।`
            : `Returned ${returnForm.return_qty_kg} kg against ${returningPurchase.purchase_no}.`,
          'ok'
        );
      }
      setReturningPurchase(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setReturnSubmitting(false);
    }
  };

  const openQr = async (p: PaddyPurchase) => {
    const dataUrl = await generateQrDataUrl(`SONAGRAIN|PADDY_LOT|${p.purchase_no}|${p.qr_code_uid}`);
    setQrPreview({ code: p.purchase_no, dataUrl });
  };

  const chatalYards = useMemo(() => {
    const yards = warehouses.filter((w) => w.warehouse_type === 'DRYING_YARD');
    return yards.length > 0 ? yards : warehouses;
  }, [warehouses]);

  const cashBankAccounts = useMemo(() => {
    const filtered = accounts.filter(
      (a) => a.account_code === '1001' || a.account_code === '1002' || (a.account_type === 'ASSET' && /cash|bank/i.test(a.name))
    );
    return filtered.length > 0 ? filtered : accounts.filter((a) => a.account_type === 'ASSET');
  }, [accounts]);

  const getPurchaseLotForWarehouse = (p: PaddyPurchase, whId: number) =>
    lots.find(
      (l) =>
        l.source_type === 'PADDY_PURCHASE' &&
        l.source_id === p.id &&
        l.warehouse_id === whId &&
        Number(l.remaining_qty_kg || 0) > 0
    );

  const openDryModal = (p: PaddyPurchase) => {
    const firstSplitWh = p.splits && p.splits.length > 0 ? p.splits[0].warehouse_id : p.warehouse_id;
    const activeLot =
      lots.find((l) => l.source_type === 'PADDY_PURCHASE' && l.source_id === p.id && Number(l.remaining_qty_kg || 0) > 0) ||
      null;
    const srcWhId = activeLot?.warehouse_id || firstSplitWh;
    const splitRow = p.splits?.find((sp) => sp.warehouse_id === srcWhId);
    const availKg = activeLot
      ? Number(activeLot.remaining_qty_kg || 0)
      : Number(splitRow?.received_weight_kg ?? Math.max(0, p.received_weight_kg - (p.returned_qty_kg || 0)));
    const availBags = activeLot
      ? Number(activeLot.remaining_bags || splitRow?.bag_count || p.bag_count || 0)
      : Number(splitRow?.bag_count ?? p.bag_count ?? 0);
    const defaultDestWh = chatalYards[0]?.id || warehouses[0]?.id || srcWhId;
    const cashAccId = cashBankAccounts.find((a) => a.account_code === '1001')?.id || cashBankAccounts[0]?.id || 0;

    setDryModalForm({
      target_mode: 'QUICK_DRY',
      source_warehouse_id: srcWhId,
      dest_warehouse_id: defaultDestWh,
      drying_method: 'SUN_YARD',
      input_qty_kg: Number(availKg.toFixed(2)),
      input_bags: availBags,
      output_bags: availBags,
      output_qty_kg: 0,
      weight_pending: true,
      initial_moisture_pct: Number(p.moisture_pct || 0),
      final_moisture_pct: 14,
      fuel_power_cost: 0,
      labor_cost: 0,
      chatal_title: `${p.purchase_no} · ${p.supplier_name}`,
      khamal_cost: 0,
      payment_timing: 'PAID',
      paid_now: 0,
      account_id: cashAccId,
      notes: `${p.purchase_no} (${p.supplier_name})`,
    });
    setDryModalPurchase(p);
  };

  const handleSubmitDryPurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dryModalPurchase) return;
    if (dryModalForm.input_qty_kg <= 0) {
      onNotify(isBn ? 'ভেজা ধানের ওজন (কেজি) শূন্যের বেশি হতে হবে।' : 'Wet paddy weight (kg) must be positive.', 'err');
      return;
    }

    setDryModalSubmitting(true);
    try {
      if (dryModalForm.target_mode === 'QUICK_DRY') {
        if (dryModalForm.weight_pending && dryModalForm.output_bags <= 0) {
          onNotify(isBn ? 'ওজন ছাড়া রাখতে শুকনো বস্তার সংখ্যা দিন।' : 'Enter dried bag count when saving unweighed.', 'err');
          setDryModalSubmitting(false);
          return;
        }
        if (!dryModalForm.weight_pending && dryModalForm.output_qty_kg <= 0) {
          onNotify(isBn ? 'শুকনো আউটপুট ওজন (কেজি) দিন।' : 'Enter dried output weight (kg).', 'err');
          setDryModalSubmitting(false);
          return;
        }
        const matchedLot = getPurchaseLotForWarehouse(dryModalPurchase, dryModalForm.source_warehouse_id);
        const res = await apiMutate({
          endpoint: '/api/v1/drying-batches',
          payload: {
            source_warehouse_id: dryModalForm.source_warehouse_id,
            dest_warehouse_id: dryModalForm.dest_warehouse_id,
            item_id: dryModalPurchase.item_id,
            drying_method: dryModalForm.drying_method,
            purchase_id: dryModalPurchase.id,
            preferred_lot_id: matchedLot?.id || undefined,
            input_qty_kg: dryModalForm.input_qty_kg,
            input_bags: dryModalForm.input_bags,
            output_bags: dryModalForm.output_bags,
            weight_pending: dryModalForm.weight_pending,
            initial_moisture_pct: dryModalForm.initial_moisture_pct,
            final_moisture_pct: dryModalForm.final_moisture_pct,
            output_qty_kg: dryModalForm.weight_pending ? 0 : dryModalForm.output_qty_kg,
            fuel_power_cost: dryModalForm.fuel_power_cost,
            labor_cost: dryModalForm.labor_cost,
            notes: dryModalForm.notes,
          },
          module: 'Dry Purchased Paddy',
          summary: `Dry ${dryModalPurchase.purchase_no}: ${dryModalForm.input_qty_kg} kg`,
        });
        if (res.offlineQueued) {
          onNotify(isBn ? 'অফলাইন: কেনা ধান শুকানো কিউতে সংরক্ষিত।' : 'Offline: Drying queued for sync.', 'warn');
        } else {
          onNotify(
            dryModalForm.weight_pending
              ? isBn
                ? `${dryModalPurchase.purchase_no} শুকিয়ে ${dryModalForm.output_bags} বস্তা (ওজন ছাড়া) গোডাউনে রাখা হয়েছে।`
                : `${dryModalPurchase.purchase_no} dried & stored (${dryModalForm.output_bags} bags, weigh at exit).`
              : isBn
                ? `${dryModalPurchase.purchase_no}-এর ধান শুকানো সম্পন্ন হয়েছে ও স্টক আপডেট হয়েছে।`
                : `${dryModalPurchase.purchase_no} drying completed.`,
            'ok'
          );
        }
      } else {
        const matchedLot = getPurchaseLotForWarehouse(dryModalPurchase, dryModalForm.source_warehouse_id);
        const totalInitExp = Number(dryModalForm.fuel_power_cost || 0) + Number(dryModalForm.labor_cost || 0);
        const res = await apiMutate({
          endpoint: '/api/v1/chatal-batches',
          payload: {
            title: dryModalForm.chatal_title.trim() || `${dryModalPurchase.purchase_no} · ${dryModalPurchase.supplier_name}`,
            chatal_warehouse_id: dryModalForm.dest_warehouse_id,
            paddy_item_id: dryModalPurchase.item_id,
            drying_cost: totalInitExp,
            khamal_cost: Number(dryModalForm.khamal_cost || 0),
            payment_timing: dryModalForm.payment_timing,
            paid_now: dryModalForm.payment_timing === 'PARTIAL' ? Number(dryModalForm.paid_now || 0) : undefined,
            account_id: dryModalForm.account_id || undefined,
            notes: dryModalForm.notes,
            inputs: [
              {
                source_warehouse_id: dryModalForm.source_warehouse_id,
                paddy_item_id: dryModalPurchase.item_id,
                purchase_id: dryModalPurchase.id,
                preferred_lot_id: matchedLot?.id || undefined,
                bag_count: dryModalForm.input_bags,
                qty_kg: dryModalForm.input_qty_kg,
                unit_divisor: Number(dryModalPurchase.settlement_unit_kg || 75.5),
                notes: `${dryModalPurchase.purchase_no}`,
              },
            ],
          },
          module: 'Purchase to Chatal Batch',
          summary: `Sent ${dryModalPurchase.purchase_no} (${dryModalForm.input_qty_kg} kg) to Chatal`,
        });
        if (res.offlineQueued) {
          onNotify(isBn ? 'অফলাইন: চাতালে প্রেরণ কিউতে সংরক্ষিত।' : 'Offline: Chatal batch queued.', 'warn');
        } else {
          onNotify(
            isBn
              ? `${dryModalPurchase.purchase_no} থেকে ${dryModalForm.input_bags} বস্তা (${dryModalForm.input_qty_kg} কেজি) চাতাল ও খামালে পাঠানো হয়েছে। উৎপাদন -> চাতাল ও খামাল থেকে বাকি ধাপ করতে পারবেন।`
              : `${dryModalPurchase.purchase_no} poured onto Chatal. Continue splits/sales/P&L under Production -> Chatal & Khamal.`,
            'ok'
          );
        }
      }
      setDryModalPurchase(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setDryModalSubmitting(false);
    }
  };

  const openPricingModal = (p: PaddyPurchase) => {
    const unitKg = p.settlement_unit_kg || 75.5;
    const itemRate = paddyItems.find((i) => i.id === p.item_id)?.default_rate || 0;
    const suggestedUnitRate = p.settlement_rate && p.settlement_rate > 0 ? p.settlement_rate : itemRate > 0 ? Number((itemRate * unitKg).toFixed(2)) : 0;
    setPricingPurchase(p);
    setPricingForm({
      weight_loss_kg: p.weight_loss_kg || 0,
      settlement_unit_kg: unitKg,
      settlement_rate: suggestedUnitRate,
      paid_amount: 0,
    });
  };

  const handleSubmitPricing = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pricingPurchase) return;
    if (pricingForm.settlement_unit_kg <= 0 || pricingForm.settlement_rate <= 0) {
      onNotify(
        isBn ? 'অনুগ্রহ করে সঠিক ভাগফল (কেজি) এবং দর (৳) দিন।' : 'Please enter valid positive divisor and settlement rate.',
        'err'
      );
      return;
    }
    setPricingSubmitting(true);
    try {
      const res = await apiMutate<{
        status: string;
        purchase?: PaddyPurchase;
        sms_notification?: SmsNotificationResult | null;
      }>({
        endpoint: `/api/v1/paddy-purchases/${pricingPurchase.id}/price`,
        method: 'PUT',
        payload: pricingForm,
        module: 'Paddy Rate Settlement',
        summary: `Set rate on ${pricingPurchase.purchase_no} (৳${pricingForm.settlement_rate}/${pricingForm.settlement_unit_kg}kg)`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: দর নির্ধারণ সিঙ্ক কিউতে রাখা হয়েছে।' : 'Offline: Rate settlement queued for sync.', 'warn');
      } else {
        const updatedP = res.data?.purchase;
        const smsNote = res.data?.sms_notification || null;
        if (smsNote?.status === 'SENT') {
          onNotify(
            isBn
              ? `${pricingPurchase.purchase_no} রসিদের দর যুক্ত হয়েছে ও কাস্টমারকে (${smsNote.phone}) অটো SMS পাঠানো হয়েছে।`
              : `Rate posted for ${pricingPurchase.purchase_no} & auto-SMS sent to ${smsNote.phone}.`,
            'ok'
          );
        } else {
          onNotify(
            isBn
              ? `${pricingPurchase.purchase_no} রসিদের দর ও হিসাব সফলভাবে যুক্ত হয়েছে।`
              : `Rate & settlement posted for ${pricingPurchase.purchase_no}.`,
            'ok'
          );
        }
        if (updatedP) {
          const msgLang: 'bn' | 'en' = isBn ? 'bn' : 'en';
          const fallbackMsg = formatPaddyPurchaseMessage(updatedP, msgLang, { hideFinancials: false });
          setLastSmsBanner({
            purchase: updatedP,
            sms: smsNote,
            phone: smsNote?.phone || updatedP.supplier_phone || '',
            lang: msgLang,
            message: smsNote?.message_preview || fallbackMsg,
          });
        }
      }
      setPricingPurchase(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setPricingSubmitting(false);
    }
  };

  const openMessageModal = (p: PaddyPurchase) => {
    const initialLang: 'bn' | 'en' = isBn ? 'bn' : 'en';
    const supPhone = p.supplier_phone || suppliers.find((s) => s.id === p.supplier_id)?.phone || '';
    setMsgModalPurchase(p);
    setMsgModalPhone(supPhone);
    setMsgModalLang(initialLang);
    setMsgModalText(formatPaddyPurchaseMessage(p, initialLang, { hideFinancials }));
  };

  const handleCopyMessage = async (text: string, idKey: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(idKey);
      onNotify(isBn ? 'মেসেজ কপি করা হয়েছে।' : 'Message copied to clipboard.', 'ok');
      setTimeout(() => setCopiedId((prev) => (prev === idKey ? null : prev)), 2000);
    } catch {
      onNotify(isBn ? 'কপি করা যায়নি।' : 'Copy failed.', 'err');
    }
  };

  const handleLogManualDispatch = (purchase: PaddyPurchase, channel: 'MANUAL_WHATSAPP' | 'MANUAL_SMS', phone: string, messageBody: string) => {
    if (!purchase.id || !navigator.onLine) return;
    void apiMutate({
      endpoint: `/api/v1/sms/paddy-purchase/${purchase.id}`,
      method: 'POST',
      payload: { phone, channel, message_body: messageBody },
      module: 'Customer Messaging',
      summary: `${channel} ${purchase.purchase_no}`,
    }).catch(() => {
      // Best-effort log only
    });
  };

  const handleGatewaySendFromUi = async (params: {
    purchase: PaddyPurchase;
    phone: string;
    msgLang: 'bn' | 'en';
    source: 'banner' | 'modal';
  }) => {
    const norm = normalizeBdPhone(params.phone);
    if (!norm.valid) {
      onNotify(
        isBn ? 'সঠিক ১১ সংখ্যার মোবাইল নম্বর দিন (যেমন 017XXXXXXXX)।' : 'Enter a valid mobile number (e.g. 017XXXXXXXX).',
        'err'
      );
      return;
    }
    if (params.source === 'banner') setBannerSending(true);
    else setMsgModalSending(true);
    try {
      const res = await apiMutate<SmsNotificationResult>({
        endpoint: `/api/v1/sms/paddy-purchase/${params.purchase.id}`,
        method: 'POST',
        payload: {
          phone: norm.local,
          lang: params.msgLang,
          channel: 'GATEWAY',
        },
        module: 'Customer SMS',
        summary: `Send SMS for ${params.purchase.purchase_no}`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইনে সার্ভার SMS পাঠানো যায় না। ফোন SMS অ্যাপ ব্যবহার করুন।' : 'Cannot send server SMS offline. Use Phone SMS app.', 'warn');
      } else if (res.data) {
        if (params.source === 'banner') {
          setLastSmsBanner((prev) => (prev ? { ...prev, sms: res.data!, phone: res.data!.phone || norm.local } : prev));
        }
        if (res.data.status === 'SENT') {
          onNotify(isBn ? `${res.data.phone} নম্বরে SMS পাঠানো হয়েছে।` : `SMS sent to ${res.data.phone}.`, 'ok');
        } else {
          onNotify(res.data.error || (isBn ? 'SMS পাঠানো যায়নি।' : 'SMS delivery failed.'), 'err');
        }
      }
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      if (params.source === 'banner') setBannerSending(false);
      else setMsgModalSending(false);
    }
  };

  const handleQuickAddPaddy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickPaddy.name.trim()) return;
    setQuickSaving(true);
    try {
      const generatedSku =
        quickPaddy.sku.trim() ||
        `PAD-${Date.now().toString().slice(-5)}`;
      const res = await apiMutate<{ item?: { id: number } }>({
        endpoint: '/api/v1/items',
        method: 'POST',
        payload: {
          sku: generatedSku.toUpperCase(),
          name: quickPaddy.name.trim(),
          category: 'PADDY',
          process_grade: 'RAW_PADDY',
          unit: 'KG',
          bag_weight_kg: 50,
          costing_method: 'FIFO',
          default_rate: Number(quickPaddy.default_rate || 24),
          is_active: true,
        },
        module: 'Product Master',
        summary: `Quick add paddy ${quickPaddy.name.trim()}`,
      });
      if (res.data?.item?.id) {
        setForm((prev) => ({
          ...prev,
          item_id: res.data!.item!.id,
          settlement_rate: Number((Number(quickPaddy.default_rate || 24) * prev.settlement_unit_kg).toFixed(2)),
        }));
      }
      onNotify(
        isBn ? `ধানের জাত "${quickPaddy.name.trim()}" যোগ করা হয়েছে।` : `Paddy variety "${quickPaddy.name.trim()}" added.`,
        'ok'
      );
      setQuickModal(null);
      setQuickPaddy({ name: '', sku: '', default_rate: 0 });
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setQuickSaving(false);
    }
  };

  const handleQuickAddWarehouse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickWh.name.trim()) return;
    setQuickSaving(true);
    try {
      const code = (quickWh.code.trim() || `GDN-${Date.now().toString().slice(-4)}`).toUpperCase();
      const res = await apiMutate<{ warehouse?: { id: number } }>({
        endpoint: '/api/v1/warehouses',
        method: 'POST',
        payload: {
          code,
          name: quickWh.name.trim(),
          warehouse_type: 'RAW_PADDY',
          location: quickWh.location.trim(),
          capacity_kg: Number(quickWh.capacity_kg || 0),
          is_active: true,
        },
        module: 'Warehouse Master',
        summary: `Quick add warehouse ${quickWh.name.trim()}`,
      });
      if (res.data?.warehouse?.id) {
        setForm((prev) => ({ ...prev, warehouse_id: res.data!.warehouse!.id }));
      }
      onNotify(
        isBn ? `গুদাম "${quickWh.name.trim()}" যোগ করা হয়েছে।` : `Godown "${quickWh.name.trim()}" added.`,
        'ok'
      );
      setQuickModal(null);
      setQuickWh({ code: '', name: '', location: '', capacity_kg: 0 });
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setQuickSaving(false);
    }
  };

  const handleQuickAddSupplier = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickSupplier.name.trim()) return;
    setQuickSaving(true);
    try {
      const res = await apiMutate<{ party?: { id: number } }>({
        endpoint: '/api/v1/parties',
        method: 'POST',
        payload: {
          party_type: 'SUPPLIER',
          name: quickSupplier.name.trim(),
          phone: quickSupplier.phone.trim(),
          address: quickSupplier.address.trim(),
          credit_limit: 0,
          opening_balance: 0,
          opening_balance_type: 'NONE',
          is_active: true,
        },
        module: 'SUPPLIER Master',
        summary: `Quick add supplier ${quickSupplier.name.trim()}`,
      });
      if (res.data?.party?.id) {
        setForm((prev) => ({ ...prev, supplier_id: res.data!.party!.id }));
      }
      onNotify(
        isBn ? `সাপ্লায়ার "${quickSupplier.name.trim()}" যোগ করা হয়েছে।` : `Supplier "${quickSupplier.name.trim()}" added.`,
        'ok'
      );
      setQuickModal(null);
      setQuickSupplier({ name: '', phone: '', address: '' });
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setQuickSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Module Sub-Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl w-full sm:w-auto overflow-x-auto">
          <button
            type="button"
            onClick={() => setActiveTab('purchases')}
            className={`flex-1 sm:flex-initial px-3.5 py-2 min-h-[40px] text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'purchases'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {hideFinancials
              ? isBn
                ? 'ধান গ্রহণ ও ওজন এন্ট্রি'
                : 'Paddy Intake'
              : isBn
              ? 'ধান ক্রয় ও ওজন চালান'
              : 'Paddy Purchases'}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('bags')}
            className={`flex-1 sm:flex-initial flex items-center justify-center gap-1.5 px-3.5 py-2 min-h-[40px] text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
              activeTab === 'bags'
                ? 'bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-400 shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Package className="w-3.5 h-3.5" />
            <span>{isBn ? 'বস্তার হিসাব (চট / প্লাস্টিক)' : 'Bag Ledger (Jute / Plastic)'}</span>
          </button>
        </div>
      </div>

      {activeTab === 'bags' ? (
        <SupplierBagLedgerPanel suppliers={suppliers} canDelete={!hideFinancials} onNotify={onNotify} />
      ) : (
        <>
          {/* Toolbar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 flex-1">
              <div className="relative flex-1 sm:flex-initial">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('proc.searchPlaceholder')}
                  className="pl-9 pr-3 py-2.5 min-h-[44px] text-xs rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-full sm:w-64"
                />
              </div>
              <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl w-full sm:w-auto overflow-x-auto">
                <button
                  type="button"
                  onClick={() => setListFilter('ALL')}
                  className={`flex-1 sm:flex-initial px-3 py-2 min-h-[38px] text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                    listFilter === 'ALL' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {t('proc.allReceipts')}
                </button>
                <button
                  type="button"
                  onClick={() => setListFilter('RAW_WET')}
                  className={`flex-1 sm:flex-initial px-3 py-2 min-h-[38px] text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                    listFilter === 'RAW_WET' ? 'bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-400 shadow-sm' : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {isBn ? 'কাঁচা ধান (শুকানো বাকি)' : 'Raw/Wet (Needs Drying)'}
                </button>
                <button
                  type="button"
                  onClick={() => setListFilter('FLAGGED')}
                  className={`flex-1 sm:flex-initial px-3 py-2 min-h-[38px] text-xs font-medium rounded-lg transition-colors whitespace-nowrap ${
                    listFilter === 'FLAGGED' ? 'bg-white dark:bg-slate-900 text-red-700 dark:text-red-400 shadow-sm' : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {t('proc.flaggedOnly')}
                </button>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowForm(!showForm)}
              className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium hover:bg-slate-800 dark:hover:bg-amber-700 transition-colors whitespace-nowrap w-full sm:w-auto"
            >
              <Plus className="w-4 h-4" />
              <span>
                {showForm
                  ? t('common.closeForm')
                  : hideFinancials
                  ? isBn
                    ? 'নতুন ধান গ্রহণ'
                    : 'New Paddy Intake'
                  : t('proc.newPurchase')}
              </span>
            </button>
          </div>

      {/* Create Form */}
      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 space-y-5"
        >
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3 gap-3">
            <div>
              <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                {hideFinancials
                  ? isBn
                    ? 'নতুন ধান গ্রহণ ও ৪-ওজন এন্ট্রি'
                    : 'New Paddy Intake & 4-Weight Entry'
                  : t('proc.formTitle')}
              </h3>
            </div>
            <div className="text-right font-mono text-xs shrink-0">
              <div className="text-slate-500">{t('proc.varianceLabel')}</div>
              <div className={Math.abs(discrepancy) > 20 ? 'text-red-600 font-semibold tabular-nums' : 'text-emerald-700 font-semibold tabular-nums'}>
                {discrepancy > 0 ? `+${discrepancy}` : discrepancy} {t('common.kg')}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">{t('proc.supplier')}</label>
                {!hideFinancials && (
                  <button
                    type="button"
                    onClick={() => setQuickModal('supplier')}
                    className="text-[11px] font-medium text-amber-600 hover:underline"
                  >
                    + {isBn ? 'নতুন সাপ্লায়ার' : 'Add Supplier'}
                  </button>
                )}
              </div>
              <select
                value={effectiveSupplierId}
                onChange={(e) => setForm({ ...form, supplier_id: Number(e.target.value) })}
                className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {suppliers.length === 0 ? (
                  <option value={0}>{t('proc.noSupplier')}</option>
                ) : (
                  suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.party_code}){s.phone ? ` · ${s.phone}` : ''}
                    </option>
                  ))
                )}
              </select>
              {selectedSupplier && (
                <div className="mt-1 flex items-center gap-1.5 text-[11px]">
                  <Phone className="w-3 h-3 text-slate-400 shrink-0" />
                  {selectedSupplier.phone ? (
                    <span className="font-mono text-emerald-700 dark:text-emerald-400">
                      {selectedSupplier.phone}
                    </span>
                  ) : (
                    <span className="text-amber-700 dark:text-amber-400">
                      {isBn
                        ? 'মোবাইল নম্বর যুক্ত নেই — অটো SMS-এর জন্য কাস্টমার/সাপ্লায়ার প্রোফাইলে নম্বর দিন'
                        : 'No phone saved — add phone in Supplier directory for auto-SMS'}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">{t('proc.destGodown')}</label>
                {!hideFinancials && (
                  <button
                    type="button"
                    onClick={() => setQuickModal('warehouse')}
                    className="text-[11px] font-medium text-amber-600 hover:underline"
                  >
                    + {isBn ? 'নতুন গুদাম' : 'Add Godown'}
                  </button>
                )}
              </div>
              <select
                value={effectiveWarehouseId}
                onChange={(e) => setForm({ ...form, warehouse_id: Number(e.target.value) })}
                className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {warehouses.length === 0 ? (
                  <option value={0}>{t('proc.noWarehouse')}</option>
                ) : (
                  warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.code})
                    </option>
                  ))
                )}
              </select>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">{t('proc.paddyVariety')}</label>
                {!hideFinancials && (
                  <button
                    type="button"
                    onClick={() => setQuickModal('paddy')}
                    className="text-[11px] font-medium text-amber-600 hover:underline"
                  >
                    + {isBn ? 'নতুন ধানের জাত' : 'Add Variety'}
                  </button>
                )}
              </div>
              <select
                value={effectiveItemId}
                onChange={(e) => {
                  const it = paddyItems.find((x) => x.id === Number(e.target.value));
                  const nextUnitRate = it?.default_rate
                    ? Number((it.default_rate * form.settlement_unit_kg).toFixed(2))
                    : form.settlement_rate;
                  setForm({ ...form, item_id: Number(e.target.value), settlement_rate: nextUnitRate });
                }}
                className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {paddyItems.length === 0 ? (
                  <option value={0}>{t('proc.noPaddy')}</option>
                ) : (
                  paddyItems.map((i) => (
                    <option key={i.id} value={i.id}>
                      {hideFinancials ? i.name : `${i.name} (${i.costing_method})`}
                    </option>
                  ))
                )}
              </select>
            </div>
          </div>

          {/* Raw/Wet vs Dried Paddy Condition */}
          <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div className="text-xs">
              <div className="font-semibold text-slate-800 dark:text-slate-200">
                {isBn ? 'কেনা ধানের অবস্থা (কাঁচা হলে শুকানোর জন্য যাবে)' : 'Purchased Paddy Condition'}
              </div>
              <div className="text-[11px] text-slate-500">
                {isBn
                  ? 'কাঁচা/ভেজা ধান চিহ্নিত করলে শুকানো ও চাতাল মডিউলে ভেজা ইনপুট হিসেবে দেখানো হবে।'
                  : 'Raw/wet paddy receipts appear in the Drying & Chatal wet input list.'}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1 p-1 bg-slate-200/70 dark:bg-slate-800 rounded-lg text-xs">
              <button
                type="button"
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    paddy_condition: 'RAW_WET',
                    moisture_pct: prev.moisture_pct === 0 || prev.moisture_pct === 13.5 ? 18 : prev.moisture_pct,
                  }))
                }
                className={`px-3 py-2 rounded-md font-semibold transition-colors whitespace-nowrap ${
                  form.paddy_condition === 'RAW_WET'
                    ? 'bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {isBn ? 'কাঁচা / ভেজা ধান (শুকানো লাগবে)' : 'Raw / Wet (Needs Drying)'}
              </button>
              <button
                type="button"
                onClick={() =>
                  setForm((prev) => ({
                    ...prev,
                    paddy_condition: 'DRIED',
                    moisture_pct: prev.moisture_pct === 0 || prev.moisture_pct === 18 ? 13.5 : prev.moisture_pct,
                  }))
                }
                className={`px-3 py-2 rounded-md font-semibold transition-colors whitespace-nowrap ${
                  form.paddy_condition === 'DRIED'
                    ? 'bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {isBn ? 'শুকনো ধান (সরাসরি স্টক)' : 'Already Dried'}
              </button>
            </div>
          </div>

          {/* Strict 4-Weight Preservation Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {t('proc.claimedWt')}
              </label>
              <input
                type="number"
                step="0.01"
                required
                value={form.supplier_claimed_weight_kg}
                onChange={(e) => setForm({ ...form, supplier_claimed_weight_kg: Number(e.target.value) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {t('proc.scaleWt')}
              </label>
              <input
                type="number"
                step="0.01"
                required
                value={form.scale_weight_kg}
                onChange={(e) => setForm({ ...form, scale_weight_kg: Number(e.target.value) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {t('proc.receivedWt')}
              </label>
              <input
                type="number"
                step="0.01"
                required
                value={form.received_weight_kg}
                onChange={(e) => setForm({ ...form, received_weight_kg: Number(e.target.value) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {t('proc.paymentWt')}
              </label>
              <input
                type="number"
                step="0.01"
                required
                value={form.payment_weight_kg}
                onChange={(e) => setForm({ ...form, payment_weight_kg: Number(e.target.value) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
          </div>

          {hideFinancials ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
              <div>
                <div className="flex items-center justify-between gap-1 mb-1">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    {isBn ? 'বাদ (ধান/বস্তা/ঘাটতি — কেজি)' : t('proc.lossDeduction')}
                  </label>
                  <div className="flex items-center gap-1">
                    {totalBagCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, weight_loss_kg: totalBagCount })}
                        className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-[10px] font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-200"
                        title={isBn ? 'প্রতি বস্তা ১ কেজি হারে বাদ বসান' : 'Set 1 kg per bag deduction'}
                      >
                        = {isBn ? `${totalBagCount} বস্তা` : `${totalBagCount}b`}
                      </button>
                    )}
                    {form.weight_loss_kg > 0 && (
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, weight_loss_kg: 0 })}
                        className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-[10px] text-slate-600 dark:text-slate-300"
                      >
                        ০
                      </button>
                    )}
                  </div>
                </div>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.weight_loss_kg}
                  onChange={(e) => setForm({ ...form, weight_loss_kg: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {t('proc.divisor')}
                </label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={form.settlement_unit_kg}
                  onChange={(e) => setForm({ ...form, settlement_unit_kg: Number(e.target.value) })}
                  className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 rounded-lg bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50">
              <div>
                <div className="flex items-center justify-between gap-1 mb-1">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    {isBn ? 'বাদ (ধান/বস্তা/ঘাটতি — কেজি)' : t('proc.lossDeduction')}
                  </label>
                  <div className="flex items-center gap-1">
                    {totalBagCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, weight_loss_kg: totalBagCount })}
                        className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-[10px] font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-200"
                        title={isBn ? 'প্রতি বস্তা ১ কেজি হারে বাদ বসান' : 'Set 1 kg per bag deduction'}
                      >
                        = {isBn ? `${totalBagCount} বস্তা` : `${totalBagCount}b`}
                      </button>
                    )}
                    {form.weight_loss_kg > 0 && (
                      <button
                        type="button"
                        onClick={() => setForm({ ...form, weight_loss_kg: 0 })}
                        className="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 text-[10px] text-slate-600 dark:text-slate-300"
                      >
                        ০
                      </button>
                    )}
                  </div>
                </div>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.weight_loss_kg}
                  onChange={(e) => setForm({ ...form, weight_loss_kg: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {t('proc.divisor')}
                </label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={form.settlement_unit_kg}
                  onChange={(e) => setForm({ ...form, settlement_unit_kg: Number(e.target.value) })}
                  className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {t('proc.ratePerUnit', { unit: divisor })}
                </label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={form.settlement_rate}
                  onChange={(e) => setForm({ ...form, settlement_rate: Number(e.target.value) })}
                  className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                  {t('proc.paidNow')}
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.paid_amount}
                  onChange={(e) => setForm({ ...form, paid_amount: Number(e.target.value) })}
                  className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>

              <div className="col-span-2 md:col-span-4 flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-amber-200/70 dark:border-amber-900/40 text-xs font-mono">
                <div className="text-slate-600 dark:text-slate-300">
                  {t('proc.formula')}: (({form.payment_weight_kg.toLocaleString()} − {form.weight_loss_kg.toLocaleString()}) / {divisor}) × ৳{form.settlement_rate.toLocaleString()} ={' '}
                  <span className="font-semibold text-slate-900 dark:text-white">
                    {settlementUnits.toFixed(4)} {t('proc.units')} ({netSettlementWeight.toLocaleString()} {t('common.kg')} {t('proc.net')})
                  </span>
                </div>
                <div className="text-slate-500">
                  {t('proc.effectiveRate')}: <span className="font-semibold text-slate-800 dark:text-slate-200">৳{effectiveRatePerKg.toFixed(4)}/{t('common.kg')}</span>
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 md:grid-cols-6 gap-4 items-end">
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">{t('proc.vehicleNo')}</label>
              <input
                type="text"
                value={form.vehicle_no}
                onChange={(e) => setForm({ ...form, vehicle_no: e.target.value })}
                placeholder=""
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">{t('proc.challanNo')}</label>
              <input
                type="text"
                value={form.challan_no}
                onChange={(e) => setForm({ ...form, challan_no: e.target.value })}
                placeholder="CH-1042"
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {isBn ? 'চট বস্তা (জমা)' : 'Jute Bags'}
              </label>
              <input
                type="number"
                min="0"
                value={form.jute_bag_count}
                onChange={(e) => setForm({ ...form, jute_bag_count: Math.max(0, Number(e.target.value)) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {isBn ? 'প্লাস্টিক বস্তা (জমা)' : 'Plastic Bags'}
              </label>
              <input
                type="number"
                min="0"
                value={form.plastic_bag_count}
                onChange={(e) => setForm({ ...form, plastic_bag_count: Math.max(0, Number(e.target.value)) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {isBn ? 'মোট বস্তা (স্বয়ংক্রিয়)' : 'Total Bags'}
              </label>
              <div className="w-full px-3 py-2 text-xs font-mono font-semibold rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
                {totalBagCount.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">{t('proc.moisture')}</label>
              <input
                type="number"
                step="0.1"
                value={form.moisture_pct}
                onChange={(e) => setForm({ ...form, moisture_pct: Number(e.target.value) })}
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
          </div>

          {/* Optional Collapsed Multi-Godown Split Box (Req 3) */}
          <div className="border-t border-slate-200 dark:border-slate-800 pt-3">
            <button
              type="button"
              onClick={toggleMultiGodownSplit}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200"
            >
              <Split className="w-3.5 h-3.5 text-amber-600" />
              <span>
                {showSplitBox
                  ? isBn
                    ? 'একাধিক গোডাউন ভাগ বন্ধ করুন (১ গোডাউনে রাখুন)'
                    : 'Disable Multi-Godown Split'
                  : isBn
                  ? 'একাধিক গোডাউনে ভাগ করুন (ঐচ্ছিক)'
                  : 'Split Across Multiple Godowns (Optional)'}
              </span>
            </button>

            {showSplitBox && (
              <div className="mt-3 rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/40 dark:bg-amber-950/20 p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-semibold text-slate-900 dark:text-white">
                      {isBn
                        ? `একাধিক গোডাউনে ধান ভাগ — (ওজন − বস্তা) ÷ ${divisor} স্টক হিসাবসহ`
                        : `Multi-Godown Paddy Split — With (Wt − Bags) ÷ ${divisor} Stock Calculation`}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {isBn
                        ? `মোট বস্তা: ${totalBagCount} | ভাগ হয়েছে: ${splitSumBags} বস্তা · মোট গৃহীত ওজন: ${form.received_weight_kg} kg | ভাগ হয়েছে: ${splitSumKg} kg`
                        : `Target Bags: ${totalBagCount} (Split: ${splitSumBags}) · Received: ${form.received_weight_kg} kg (Split: ${splitSumKg} kg)`}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setGodownSplits((prev) => [
                        ...prev,
                        {
                          uid: crypto.randomUUID(),
                          warehouse_id: warehouses[0]?.id || effectiveWarehouseId,
                          bag_count: Math.max(0, totalBagCount - splitSumBags),
                          jute_bag_count: Math.max(0, totalBagCount - splitSumBags),
                          plastic_bag_count: 0,
                          received_weight_kg: Math.max(0, Number((form.received_weight_kg - splitSumKg).toFixed(2))),
                        },
                      ])
                    }
                    className="px-2.5 py-1 rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-[11px] font-medium"
                  >
                    + {isBn ? 'আরও গোডাউন' : 'Add Godown'}
                  </button>
                </div>

                <div className="space-y-2">
                  {godownSplits.map((sp, idx) => {
                    const spUnits = sp.received_weight_kg > sp.bag_count ? (sp.received_weight_kg - sp.bag_count) / divisor : 0;
                    return (
                      <div
                        key={sp.uid}
                        className="grid grid-cols-12 gap-2 items-end bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 text-xs"
                      >
                        <div className="col-span-12 sm:col-span-4">
                          <label className="block text-[10px] text-slate-500 mb-0.5">
                            {isBn ? `গোডাউন ${idx + 1}` : `Godown ${idx + 1}`}
                          </label>
                          <select
                            value={sp.warehouse_id}
                            onChange={(e) =>
                              setGodownSplits((prev) =>
                                prev.map((r) => (r.uid === sp.uid ? { ...r, warehouse_id: Number(e.target.value) } : r))
                              )
                            }
                            className="w-full px-2.5 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          >
                            {warehouses.map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.name} ({w.code})
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="col-span-4 sm:col-span-2">
                          <label className="block text-[10px] text-slate-500 mb-0.5">{isBn ? 'বস্তা' : 'Bags'}</label>
                          <input
                            type="number"
                            min="0"
                            value={sp.bag_count}
                            onChange={(e) => {
                              const bags = Math.max(0, Math.round(Number(e.target.value)));
                              setGodownSplits((prev) =>
                                prev.map((r) =>
                                  r.uid === sp.uid ? { ...r, bag_count: bags, jute_bag_count: bags } : r
                                )
                              );
                            }}
                            className="w-full px-2.5 py-1.5 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          />
                        </div>
                        <div className="col-span-5 sm:col-span-3">
                          <label className="block text-[10px] text-slate-500 mb-0.5">{isBn ? 'ওজন (কেজি)' : 'Weight (kg)'}</label>
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={sp.received_weight_kg}
                            onChange={(e) => {
                              const wt = Math.max(0, Number(e.target.value));
                              setGodownSplits((prev) =>
                                prev.map((r) => (r.uid === sp.uid ? { ...r, received_weight_kg: wt } : r))
                              );
                            }}
                            className="w-full px-2.5 py-1.5 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          />
                        </div>
                        <div className="col-span-10 sm:col-span-2">
                          <div className="text-[10px] text-slate-500">{isBn ? `(ওজন−বস্তা)÷${divisor}` : `(Wt−B)÷${divisor}`}</div>
                          <div className="font-mono font-bold text-amber-700 dark:text-amber-400 py-1">
                            {spUnits.toFixed(3)} {isBn ? 'একক' : 'u'}
                          </div>
                        </div>
                        <div className="col-span-2 sm:col-span-1 text-right">
                          {godownSplits.length > 2 && (
                            <button
                              type="button"
                              onClick={() => setGodownSplits((prev) => prev.filter((r) => r.uid !== sp.uid))}
                              className="p-1.5 text-slate-400 hover:text-red-600"
                              title={isBn ? 'সরান' : 'Remove'}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-emerald-200/80 dark:border-emerald-900/50 bg-emerald-50/50 dark:bg-emerald-950/20 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
            <label className="inline-flex items-center gap-2 cursor-pointer select-none font-medium text-slate-800 dark:text-slate-200">
              <input
                type="checkbox"
                checked={autoSendSms}
                onChange={(e) => setAutoSendSms(e.target.checked)}
                className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
              />
              <MessageSquare className="w-3.5 h-3.5 text-emerald-700 dark:text-emerald-400" />
              <span>
                {isBn
                  ? 'ক্রয় সংরক্ষণের সাথে সাথে কাস্টমার/সাপ্লায়ারের কাছে অটো মেসেজ পাঠান'
                  : 'Auto-send receipt message to customer/supplier on save'}
              </span>
            </label>
            <span className="text-[11px] font-medium text-slate-600 dark:text-slate-400">
              {smsStatus.configured
                ? isBn
                  ? `অটো SMS গেটওয়ে সক্রিয় (${smsStatus.provider})`
                  : `Auto-SMS Gateway Active (${smsStatus.provider})`
                : isBn
                ? 'সংরক্ষণের পর সরাসরি WhatsApp / ফোন SMS বাটন আসবে (গেটওয়ে সেট করলে অটো যাবে)'
                : 'Instant WhatsApp/SMS card shown on save (or configure SMS Gateway in Admin)'}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                {t('proc.notes')}
              </label>
              <input
                type="text"
                value={form.discrepancy_notes}
                onChange={(e) => setForm({ ...form, discrepancy_notes: e.target.value })}
                placeholder={t('proc.notesPlaceholder')}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="text-xs">
                {hideFinancials ? (
                  <>
                    <span className="text-slate-500">{isBn ? 'গৃহীত নিট ওজন ও বস্তা:' : 'Received Net & Bags:'}</span>
                    <div className="font-mono font-semibold text-sm tabular-nums text-slate-900 dark:text-white">
                      {form.received_weight_kg.toLocaleString()} kg · {totalBagCount.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'}
                    </div>
                  </>
                ) : (
                  <>
                    <span className="text-slate-500">{t('proc.totalPayable')}:</span>
                    <div className="font-mono font-semibold text-base tabular-nums text-slate-900 dark:text-white">
                      ৳{totalPayable.toLocaleString('en-IN')}
                    </div>
                  </>
                )}
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2.5 min-h-[44px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50 whitespace-nowrap w-full sm:w-auto"
              >
                {submitting
                  ? t('common.saving')
                  : hideFinancials
                  ? isBn
                    ? 'ধান গ্রহণ সংরক্ষণ করুন'
                    : 'Save Paddy Intake'
                  : t('proc.savePurchase')}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* Post-Purchase Instant Customer SMS / WhatsApp Notification Card */}
      {lastSmsBanner && (
        <div className="rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50/60 dark:bg-emerald-950/25 p-4 space-y-3 text-xs">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="space-y-0.5">
              <div className="flex flex-wrap items-center gap-2">
                <MessageSquare className="w-4 h-4 text-emerald-700 dark:text-emerald-400" />
                <span className="font-display font-semibold text-sm text-slate-900 dark:text-white">
                  {isBn
                    ? `কাস্টমার / সাপ্লায়ার মেসেজ — ${lastSmsBanner.purchase.purchase_no}`
                    : `Customer / Supplier Receipt Message — ${lastSmsBanner.purchase.purchase_no}`}
                </span>
                {lastSmsBanner.sms?.status === 'SENT' ? (
                  <span className="px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-semibold">
                    {isBn ? 'অটো SMS পাঠানো হয়েছে' : 'Auto-SMS Sent'}
                  </span>
                ) : lastSmsBanner.sms?.status === 'FAILED' ? (
                  <span className="px-2 py-0.5 rounded bg-red-600 text-white text-[10px] font-semibold">
                    {isBn ? 'অটো SMS ব্যর্থ' : 'Auto-SMS Failed'}
                  </span>
                ) : lastSmsBanner.sms?.status === 'SKIPPED' ? (
                  <span className="px-2 py-0.5 rounded bg-amber-600 text-white text-[10px] font-semibold">
                    {isBn ? 'মোবাইল নম্বর অনুপস্থিত' : 'Skipped (No Phone)'}
                  </span>
                ) : lastSmsBanner.isOfflineQueued ? (
                  <span className="px-2 py-0.5 rounded bg-amber-600 text-white text-[10px] font-semibold">
                    {isBn ? 'অফলাইন — ফোন SMS / WhatsApp দিয়ে পাঠান' : 'Offline — Send via Phone SMS / WhatsApp'}
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded bg-slate-700 text-white text-[10px] font-semibold">
                    {isBn ? 'WhatsApp / SMS রেডি' : 'Ready to Send'}
                  </span>
                )}
              </div>
              {lastSmsBanner.sms?.error && (
                <div className="text-[11px] text-red-700 dark:text-red-300">{lastSmsBanner.sms.error}</div>
              )}
            </div>
            <button
              type="button"
              onClick={() => setLastSmsBanner(null)}
              className="p-1 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-start">
            <div className="space-y-2">
              <label className="block text-[11px] font-medium text-slate-700 dark:text-slate-300">
                {isBn ? 'কাস্টমারের মোবাইল নম্বর' : 'Recipient Phone'}
              </label>
              <input
                type="text"
                value={lastSmsBanner.phone}
                onChange={(e) => setLastSmsBanner((prev) => (prev ? { ...prev, phone: e.target.value } : prev))}
                placeholder="017XXXXXXXX"
                className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
              <div className="flex items-center gap-1 p-0.5 rounded-lg bg-slate-200/70 dark:bg-slate-800 w-fit">
                <button
                  type="button"
                  onClick={() =>
                    setLastSmsBanner((prev) =>
                      prev
                        ? {
                            ...prev,
                            lang: 'bn',
                            message: formatPaddyPurchaseMessage(prev.purchase, 'bn', { hideFinancials }),
                          }
                        : prev
                    )
                  }
                  className={`px-2.5 py-1 rounded text-[11px] font-medium ${
                    lastSmsBanner.lang === 'bn' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  বাংলা
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setLastSmsBanner((prev) =>
                      prev
                        ? {
                            ...prev,
                            lang: 'en',
                            message: formatPaddyPurchaseMessage(prev.purchase, 'en', { hideFinancials }),
                          }
                        : prev
                    )
                  }
                  className={`px-2.5 py-1 rounded text-[11px] font-medium ${
                    lastSmsBanner.lang === 'en' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  English
                </button>
              </div>
            </div>

            <div className="md:col-span-3 space-y-2.5">
              <textarea
                rows={2}
                value={lastSmsBanner.message}
                onChange={(e) => setLastSmsBanner((prev) => (prev ? { ...prev, message: e.target.value } : prev))}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 leading-relaxed"
              />
              <div className="flex flex-wrap items-center gap-2">
                <a
                  href={buildWhatsAppHref(lastSmsBanner.phone, lastSmsBanner.message)}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => handleLogManualDispatch(lastSmsBanner.purchase, 'MANUAL_WHATSAPP', lastSmsBanner.phone, lastSmsBanner.message)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium whitespace-nowrap"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>{isBn ? 'WhatsApp-এ পাঠান' : 'Send on WhatsApp'}</span>
                </a>
                <a
                  href={buildSmsHref(lastSmsBanner.phone, lastSmsBanner.message)}
                  onClick={() => handleLogManualDispatch(lastSmsBanner.purchase, 'MANUAL_SMS', lastSmsBanner.phone, lastSmsBanner.message)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-lg bg-slate-900 dark:bg-slate-700 hover:opacity-95 text-white font-medium whitespace-nowrap"
                >
                  <MessageSquare className="w-3.5 h-3.5" />
                  <span>{isBn ? 'ফোন SMS অ্যাপ' : 'Phone SMS App'}</span>
                </a>
                <button
                  type="button"
                  onClick={() => void handleCopyMessage(lastSmsBanner.message, 'banner')}
                  className="inline-flex items-center gap-1.5 px-3 py-2 min-h-[38px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 font-medium whitespace-nowrap"
                >
                  {copiedId === 'banner' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{isBn ? 'মেসেজ কপি' : 'Copy Text'}</span>
                </button>
                {smsStatus.configured && !lastSmsBanner.isOfflineQueued && lastSmsBanner.purchase.id > 0 && (
                  <button
                    type="button"
                    disabled={bannerSending}
                    onClick={() =>
                      void handleGatewaySendFromUi({
                        purchase: lastSmsBanner.purchase,
                        phone: lastSmsBanner.phone,
                        msgLang: lastSmsBanner.lang,
                        source: 'banner',
                      })
                    }
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 min-h-[38px] rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-medium whitespace-nowrap disabled:opacity-50"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>
                      {bannerSending
                        ? isBn
                          ? 'পাঠানো হচ্ছে...'
                          : 'Sending...'
                        : isBn
                        ? 'সার্ভার SMS পুনরায় পাঠান'
                        : 'Resend via Server SMS'}
                    </span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {!hideFinancials && lastReturnSlip && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 px-4 py-3 text-xs">
          <div>
            <span className="font-semibold text-amber-900 dark:text-amber-300">
              {isBn ? `ক্রয় ফেরত স্লিপ প্রস্তুত: ${lastReturnSlip.ret.return_no}` : `Return Slip Ready: ${lastReturnSlip.ret.return_no}`}
            </span>
            <span className="ml-2 text-slate-600 dark:text-slate-300">
              {lastReturnSlip.purchase.purchase_no} · {lastReturnSlip.ret.return_qty_kg} kg · ৳
              {Number(lastReturnSlip.ret.return_amount || 0).toLocaleString('en-IN')}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void exportPurchaseReturnSlipPdf(lastReturnSlip.ret, lastReturnSlip.purchase, lang, 'open')}
              className="inline-flex items-center gap-1 px-3 py-1.5 min-h-[38px] rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>{isBn ? 'ফেরত স্লিপ PDF দেখুন' : 'View Return Slip PDF'}</span>
            </button>
            <button
              type="button"
              onClick={() => setLastReturnSlip(null)}
              className="p-1 text-slate-400 hover:text-slate-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Raw-vs-Dried Paddy Accounting Strip */}
      {purchases.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 sm:p-4">
            <div className="text-xs text-slate-500">{isBn ? 'মোট কাঁচা ধান কেনা' : 'Total Raw/Wet Purchased'}</div>
            <div className="text-lg sm:text-xl font-display font-bold font-mono tabular-nums mt-1 text-slate-900 dark:text-white">
              {rawDryingStats.totalRawPurchasedKg.toLocaleString('en-IN')} {isBn ? 'কেজি' : 'kg'}
            </div>
            <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
              {rawDryingStats.totalRawPurchasedBags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'} · {rawDryingStats.rawCount}{' '}
              {isBn ? 'টি চালান' : 'receipts'}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 sm:p-4">
            <div className="text-xs text-slate-500">{isBn ? 'শুকানো ও চাটালে গেছে (কাঁচা)' : 'Raw Sent to Dry / Chatal'}</div>
            <div className="text-lg sm:text-xl font-display font-bold font-mono tabular-nums mt-1 text-amber-700 dark:text-amber-400">
              {rawDryingStats.sentToDryKg.toLocaleString('en-IN')} {isBn ? 'কেজি' : 'kg'}
            </div>
            <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
              {rawDryingStats.sentToDryBags.toLocaleString('en-IN')} {isBn ? 'বস্তা কাঁচা শুকাতে গেছে' : 'raw bags sent'}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 sm:p-4">
            <div className="text-xs text-slate-500">{isBn ? 'শুকনো ধান পাওয়া গেছে' : 'Dried Paddy Produced'}</div>
            <div className="text-lg sm:text-xl font-display font-bold font-mono tabular-nums mt-1 text-emerald-700 dark:text-emerald-400">
              {rawDryingStats.driedOutputKg.toLocaleString('en-IN')} {isBn ? 'কেজি' : 'kg'}
            </div>
            <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
              {rawDryingStats.driedOutputBags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'}
              {rawDryingStats.dryingLossKg > 0 ? ` · ${isBn ? 'ঘাটতি' : 'Loss'} −${rawDryingStats.dryingLossKg.toLocaleString('en-IN')}kg` : ''}
              {rawDryingStats.pendingOutputBags > 0 ? ` · ${rawDryingStats.pendingOutputBags}${isBn ? 'ব ওজন বাকি' : 'b pending'}` : ''}
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-3.5 sm:p-4">
            <div className="text-xs text-slate-500">{isBn ? 'এখনো কাঁচা বাকি আছে' : 'Raw Still Un-dried'}</div>
            <div className="text-lg sm:text-xl font-display font-bold font-mono tabular-nums mt-1 text-slate-900 dark:text-white">
              {rawDryingStats.remainingRawKg.toLocaleString('en-IN')} {isBn ? 'কেজি' : 'kg'}
            </div>
            <div className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
              {rawDryingStats.remainingRawBags.toLocaleString('en-IN')} {isBn ? 'বস্তা শুকানো বাকি' : 'bags pending drying'}
            </div>
          </div>
        </div>
      )}

      {/* Mobile Cards (md:hidden) */}
      <div className="md:hidden space-y-3">
        {filtered.length === 0 ? (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-8 text-center text-xs text-slate-500">
            {t('proc.empty')}
          </div>
        ) : (
          filtered.map((p) => {
            const unitDiv = p.settlement_unit_kg || 75.5;
            const unitRate = p.settlement_rate || Number((p.rate_per_kg * unitDiv).toFixed(2));
            const loss = p.weight_loss_kg || 0;
            const returnedKg = Number(p.returned_qty_kg || 0);
            const remainingReturnable = Math.max(0, Number((p.received_weight_kg - returnedKg).toFixed(2)));
            const isPendingRate = p.pricing_status === 'PENDING_RATE';
            return (
              <div
                key={p.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-mono text-xs font-semibold text-slate-900 dark:text-white">{p.purchase_no}</div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-white mt-0.5">{p.supplier_name}</div>
                    <div className="text-xs text-slate-500">
                      {p.item_name} →{' '}
                      {p.splits && p.splits.length > 0
                        ? p.splits.map((sp) => `${sp.warehouse_name} (${sp.bag_count}ব / ${sp.received_weight_kg}kg)`).join(' + ')
                        : p.warehouse_name}
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    {!hideFinancials ? (
                      isPendingRate ? (
                        <div className="text-xs font-semibold text-amber-700 dark:text-amber-400">
                          {isBn ? 'দর নির্ধারণ বাকি' : 'Pending Rate'}
                        </div>
                      ) : (
                        <>
                          <div className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                            ৳{p.total_payable.toLocaleString('en-IN')}
                          </div>
                          <div className="font-mono text-[11px] text-slate-500 tabular-nums">
                            ৳{unitRate.toLocaleString('en-IN')}/{unitDiv}kg
                          </div>
                        </>
                      )
                    ) : (
                      <div className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                        {p.received_weight_kg.toLocaleString()} kg
                      </div>
                    )}
                    <div
                      className={`text-[11px] font-mono tabular-nums mt-0.5 ${
                        p.discrepancy_flagged ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-emerald-700 dark:text-emerald-400'
                      }`}
                    >
                      {p.weight_discrepancy_kg > 0 ? `+${p.weight_discrepancy_kg}` : p.weight_discrepancy_kg} kg var
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-2 pt-2 border-t border-slate-100 dark:border-slate-800 text-[11px]">
                  <div>
                    <div className="text-slate-400">{t('proc.thClaimed')}</div>
                    <div className="font-mono tabular-nums font-medium">{p.supplier_claimed_weight_kg.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">{t('proc.thScale')}</div>
                    <div className="font-mono tabular-nums font-medium">{p.scale_weight_kg.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">{t('proc.thReceived')}</div>
                    <div className="font-mono tabular-nums font-semibold">{p.received_weight_kg.toLocaleString()}</div>
                  </div>
                  <div>
                    <div className="text-slate-400">{isBn ? 'বস্তা' : 'Bags'}</div>
                    <div className="font-mono tabular-nums font-semibold text-amber-700 dark:text-amber-400">{p.bag_count}</div>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-500">
                  <span>
                    {p.vehicle_no || t('common.none')} · {p.moisture_pct}% MC ·{' '}
                    <span className={p.paddy_condition === 'DRIED' ? 'text-emerald-700 dark:text-emerald-400 font-semibold' : 'text-amber-700 dark:text-amber-400 font-semibold'}>
                      {p.paddy_condition === 'DRIED' ? (isBn ? 'শুকনো ধান' : 'Dried') : isBn ? 'কাঁচা ধান' : 'Raw/Wet'}
                    </span>
                    {loss > 0 ? ` · ${isBn ? 'ঘাটতি' : 'Loss'} −${loss} kg` : ''}
                  </span>
                  {returnedKg > 0 && (
                    <span className="font-semibold text-red-600 dark:text-red-400">
                      {hideFinancials
                        ? `${isBn ? 'ফেরত' : 'Returned'}: ${returnedKg.toLocaleString()} kg`
                        : `${isBn ? 'ফেরত' : 'Ret'}: ${returnedKg.toLocaleString()} kg (-৳${Number(p.returned_amount || 0).toLocaleString('en-IN')})`}
                    </span>
                  )}
                </div>

                {p.drying_summary && (p.drying_summary.dried_input_kg > 0 || p.drying_summary.chatal_input_kg > 0) && (
                  <div className="text-[11px] font-mono tabular-nums text-emerald-700 dark:text-emerald-400 pt-1 border-t border-slate-100 dark:border-slate-800">
                    {p.drying_summary.dried_input_kg > 0 && (
                      <span>
                        {isBn ? 'শুকানো:' : 'Dried:'} {p.drying_summary.dried_input_kg.toLocaleString('en-IN')}kg (
                        {p.drying_summary.dried_input_bags}ব) →{' '}
                        {p.drying_summary.dried_output_kg > 0
                          ? `${p.drying_summary.dried_output_kg.toLocaleString('en-IN')}kg`
                          : isBn
                          ? 'ওজন বাকি'
                          : 'pending wt'}{' '}
                        ({p.drying_summary.dried_output_bags}ব)
                        {p.drying_summary.drying_loss_kg > 0 ? ` · −${p.drying_summary.drying_loss_kg.toLocaleString('en-IN')}kg` : ''}
                      </span>
                    )}
                    {p.drying_summary.chatal_input_kg > 0 && (
                      <span>
                        {p.drying_summary.dried_input_kg > 0 ? ' · ' : ''}
                        {isBn ? 'চাটালে:' : 'Chatal:'} {p.drying_summary.chatal_input_kg.toLocaleString('en-IN')}kg (
                        {p.drying_summary.chatal_input_bags}ব)
                      </span>
                    )}
                    {p.paddy_condition !== 'DRIED' && Number(p.unconsumed_lot_qty_kg || 0) > 0.01 && (
                      <span className="text-amber-700 dark:text-amber-400">
                        {' '}
                        · {isBn ? 'বাকি কাঁচা:' : 'Rem raw:'} {Number(p.unconsumed_lot_qty_kg).toLocaleString('en-IN')}kg (
                        {Number(p.unconsumed_lot_bags || 0)}ব)
                      </span>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-4 gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => openQr(p)}
                    className="flex items-center justify-center gap-1 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200"
                  >
                    <QrCode className="w-3.5 h-3.5" /> QR
                  </button>
                  <button
                    type="button"
                    onClick={() => openMessageModal(p)}
                    className="flex items-center justify-center gap-1 min-h-[44px] rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/30 text-xs font-medium text-emerald-700 dark:text-emerald-300"
                  >
                    <MessageSquare className="w-3.5 h-3.5" /> SMS
                  </button>
                  <button
                    type="button"
                    onClick={() => exportWeighbridgeSlipPdf(p, 'en', 'open', { hideFinancials })}
                    className="flex items-center justify-center gap-1 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200"
                  >
                    <FileText className="w-3.5 h-3.5" /> EN
                  </button>
                  <button
                    type="button"
                    onClick={() => exportWeighbridgeSlipPdf(p, 'bn', 'open', { hideFinancials })}
                    className="flex items-center justify-center gap-1 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-700 dark:text-slate-200"
                  >
                    <FileText className="w-3.5 h-3.5" /> বাংলা
                  </button>
                </div>

                {(isPendingRate || remainingReturnable > 0.01) && (
                  <div className="flex flex-wrap gap-2">
                    {p.paddy_condition !== 'DRIED' && Number(p.unconsumed_lot_qty_kg ?? remainingReturnable) > 0.01 && (
                      <button
                        type="button"
                        onClick={() => openDryModal(p)}
                        className="flex-1 flex items-center justify-center gap-1.5 min-h-[44px] rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/80 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 text-xs font-semibold"
                      >
                        <Sun className="w-3.5 h-3.5" /> {isBn ? 'কাঁচা ধান শুকান' : 'Dry Raw Paddy'}
                      </button>
                    )}
                    {!hideFinancials && isPendingRate && (
                      <button
                        type="button"
                        onClick={() => openPricingModal(p)}
                        className="flex-1 flex items-center justify-center gap-1.5 min-h-[44px] rounded-xl bg-amber-600 text-white text-xs font-semibold"
                      >
                        <Tag className="w-3.5 h-3.5" /> {isBn ? 'দর নির্ধারণ করুন' : 'Set Rate & Bill'}
                      </button>
                    )}
                    {!hideFinancials && !isPendingRate && remainingReturnable > 0.01 && (
                      <button
                        type="button"
                        onClick={() => void openReturnModal(p)}
                        className="flex-1 flex items-center justify-center gap-1.5 min-h-[44px] rounded-xl border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300 text-xs font-medium"
                      >
                        <RotateCcw className="w-3.5 h-3.5" /> {isBn ? 'ফেরত' : 'Return'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Desktop Purchases Table (hidden md:block) */}
      <div className="hidden md:block bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="text-left px-4 py-3 font-medium">{t('proc.thReceiptVehicle')}</th>
                <th className="text-left px-4 py-3 font-medium">{t('proc.thSupplierVariety')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('proc.thClaimed')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('proc.thScale')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('proc.thReceived')}</th>
                <th className="text-right px-4 py-3 font-medium">{t('proc.thPayLoss')}</th>
                {!hideFinancials && <th className="text-right px-4 py-3 font-medium">{t('proc.thRateDiv')}</th>}
                <th className="text-right px-4 py-3 font-medium">{t('proc.thVariance')}</th>
                {!hideFinancials && <th className="text-right px-4 py-3 font-medium">{t('proc.thTotal')}</th>}
                <th className="text-right px-4 py-3 font-medium">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={hideFinancials ? 8 : 10} className="px-4 py-8 text-center text-slate-500">
                    {t('proc.empty')}
                  </td>
                </tr>
              ) : (
                filtered.map((p) => {
                  const unitDiv = p.settlement_unit_kg || 75.5;
                  const unitRate = p.settlement_rate || Number((p.rate_per_kg * unitDiv).toFixed(2));
                  const loss = p.weight_loss_kg || 0;
                  const returnedKg = Number(p.returned_qty_kg || 0);
                  const remainingReturnable = Math.max(0, Number((p.received_weight_kg - returnedKg).toFixed(2)));
                  const isPendingRate = p.pricing_status === 'PENDING_RATE';
                  return (
                    <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                      <td className="px-4 py-3">
                        <div className="font-mono font-medium text-slate-900 dark:text-white">{p.purchase_no}</div>
                        <div className="text-slate-500">
                          {p.vehicle_no || t('common.none')} · {p.moisture_pct}% MC ·{' '}
                          <span className={p.paddy_condition === 'DRIED' ? 'text-emerald-700 dark:text-emerald-400 font-semibold' : 'text-amber-700 dark:text-amber-400 font-semibold'}>
                            {p.paddy_condition === 'DRIED' ? (isBn ? 'শুকনো' : 'Dried') : isBn ? 'কাঁচা' : 'Raw'}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800 dark:text-slate-200">{p.supplier_name}</div>
                        <div className="text-slate-500">
                          {p.item_name} →{' '}
                          {p.splits && p.splits.length > 0
                            ? p.splits.map((sp) => `${sp.warehouse_name} (${sp.bag_count}ব / ${sp.received_weight_kg}kg)`).join(' + ')
                            : p.warehouse_name}
                        </div>
                        <div className="text-[11px] font-mono text-amber-700 dark:text-amber-400">
                          {p.bag_count} {isBn ? 'বস্তা' : 'bags'}
                          {(p.jute_bag_count || 0) > 0 || (p.plastic_bag_count || 0) > 0
                            ? ` (${isBn ? 'চট' : 'Jute'}: ${p.jute_bag_count || 0} · ${isBn ? 'প্লাস্টিক' : 'Plastic'}: ${p.plastic_bag_count || 0})`
                            : ''}
                        </div>
                        {p.drying_summary && (p.drying_summary.dried_input_kg > 0 || p.drying_summary.chatal_input_kg > 0) && (
                          <div className="text-[11px] font-mono tabular-nums text-emerald-700 dark:text-emerald-400 mt-0.5">
                            {p.drying_summary.dried_input_kg > 0 && (
                              <span>
                                {isBn ? 'শুকানো:' : 'Dried:'} {p.drying_summary.dried_input_kg.toLocaleString('en-IN')}kg (
                                {p.drying_summary.dried_input_bags}ব) →{' '}
                                {p.drying_summary.dried_output_kg > 0
                                  ? `${p.drying_summary.dried_output_kg.toLocaleString('en-IN')}kg`
                                  : isBn
                                  ? 'ওজন বাকি'
                                  : 'pending wt'}{' '}
                                ({p.drying_summary.dried_output_bags}ব)
                                {p.drying_summary.drying_loss_kg > 0 ? ` · −${p.drying_summary.drying_loss_kg.toLocaleString('en-IN')}kg` : ''}
                              </span>
                            )}
                            {p.drying_summary.chatal_input_kg > 0 && (
                              <span>
                                {p.drying_summary.dried_input_kg > 0 ? ' · ' : ''}
                                {isBn ? 'চাটালে:' : 'Chatal:'} {p.drying_summary.chatal_input_kg.toLocaleString('en-IN')}kg (
                                {p.drying_summary.chatal_input_bags}ব)
                              </span>
                            )}
                            {p.paddy_condition !== 'DRIED' && Number(p.unconsumed_lot_qty_kg || 0) > 0.01 && (
                              <span className="text-amber-700 dark:text-amber-400">
                                {' '}
                                · {isBn ? 'বাকি কাঁচা:' : 'Rem:'} {Number(p.unconsumed_lot_qty_kg).toLocaleString('en-IN')}kg (
                                {Number(p.unconsumed_lot_bags || 0)}ব)
                              </span>
                            )}
                          </div>
                        )}
                        {returnedKg > 0 && (
                          <div className="mt-1 flex flex-wrap items-center gap-1">
                            <span className="px-1.5 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300 text-[10px] font-semibold">
                              {hideFinancials
                                ? `${isBn ? 'ফেরত' : 'Returned'}: ${returnedKg.toLocaleString()} kg`
                                : isBn
                                ? `ফেরত: ${returnedKg.toLocaleString()} kg (-৳${Number(p.returned_amount || 0).toLocaleString('en-IN')})`
                                : `Returned: ${returnedKg.toLocaleString()} kg (-৳${Number(p.returned_amount || 0).toLocaleString('en-IN')})`}
                            </span>
                            {!hideFinancials &&
                              p.return_logs?.map((ret) => (
                                <button
                                  key={ret.id}
                                  type="button"
                                  onClick={() => void exportPurchaseReturnSlipPdf(ret, p, lang, 'open')}
                                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-[10px] font-mono hover:bg-slate-100"
                                  title={isBn ? 'ফেরত স্লিপ PDF' : 'Return Slip PDF'}
                                >
                                  <FileText className="w-2.5 h-2.5" /> {ret.return_no}
                                </button>
                              ))}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">{p.supplier_claimed_weight_kg.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">{p.scale_weight_kg.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">{p.received_weight_kg.toLocaleString()}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        <div className="font-medium">{p.payment_weight_kg.toLocaleString()} {t('common.kg')}</div>
                        {loss > 0 && <div className="text-[11px] text-amber-600">−{loss.toLocaleString()}</div>}
                      </td>
                      {!hideFinancials && (
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          {isPendingRate ? (
                            <span className="text-[11px] font-sans font-semibold text-amber-600 dark:text-amber-400">
                              {isBn ? 'দর বাকি' : 'Pending Rate'}
                            </span>
                          ) : (
                            <>
                              <div>৳{unitRate.toLocaleString('en-IN')}</div>
                              <div className="text-[11px] text-slate-500">/{unitDiv} {t('common.kg')}</div>
                            </>
                          )}
                        </td>
                      )}
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        <span
                          className={`inline-flex items-center gap-1 font-medium ${
                            p.discrepancy_flagged ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
                          }`}
                        >
                          {p.discrepancy_flagged === 1 && <AlertTriangle className="w-3 h-3" />}
                          {p.weight_discrepancy_kg > 0 ? `+${p.weight_discrepancy_kg}` : p.weight_discrepancy_kg}
                        </span>
                      </td>
                      {!hideFinancials && (
                        <td className="px-4 py-3 text-right font-mono tabular-nums font-medium text-slate-900 dark:text-white">
                          {isPendingRate ? '—' : `৳${p.total_payable.toLocaleString('en-IN')}`}
                        </td>
                      )}
                      <td className="px-4 py-3 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openQr(p)}
                            className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-300"
                            title={t('proc.lotQrTitle')}
                          >
                            <QrCode className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => openMessageModal(p)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-emerald-200 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/30 hover:bg-emerald-100 text-emerald-700 dark:text-emerald-300 text-[11px] font-medium whitespace-nowrap shrink-0"
                            title={isBn ? 'কাস্টমারকে মেসেজ / SMS পাঠান' : 'Send SMS / WhatsApp'}
                          >
                            <MessageSquare className="w-3 h-3" /> {isBn ? 'মেসেজ' : 'SMS'}
                          </button>
                          <button
                            type="button"
                            onClick={() => exportWeighbridgeSlipPdf(p, 'en', 'open', { hideFinancials })}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                            title="View English Purchase Challan"
                          >
                            <FileText className="w-3 h-3" /> EN
                          </button>
                          <button
                            type="button"
                            onClick={() => exportWeighbridgeSlipPdf(p, 'bn', 'open', { hideFinancials })}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                            title="বাংলা ক্রয় চালান দেখুন"
                          >
                            <FileText className="w-3 h-3" /> বাংলা
                          </button>
                          {p.paddy_condition !== 'DRIED' && Number(p.unconsumed_lot_qty_kg ?? remainingReturnable) > 0.01 && (
                            <button
                              type="button"
                              onClick={() => openDryModal(p)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-amber-300 dark:border-amber-800 bg-amber-50/80 dark:bg-amber-950/40 hover:bg-amber-100 text-amber-800 dark:text-amber-300 text-[11px] font-semibold whitespace-nowrap shrink-0"
                              title={isBn ? 'এই কাঁচা কেনা ধান শুকান বা চাটালে দিন' : 'Dry this raw purchased paddy'}
                            >
                              <Sun className="w-3 h-3" /> {isBn ? 'শুকান' : 'Dry'}
                            </button>
                          )}
                          {!hideFinancials && isPendingRate && (
                            <button
                              type="button"
                              onClick={() => openPricingModal(p)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-semibold whitespace-nowrap shrink-0"
                              title={isBn ? 'গুদাম কিপারের গ্রহণকৃত ধানের দর ও বিল নির্ধারণ করুন' : 'Set Rate & Billing'}
                            >
                              <Tag className="w-3 h-3" /> {isBn ? 'দর দিন' : 'Set Rate'}
                            </button>
                          )}
                          {!hideFinancials && !isPendingRate && remainingReturnable > 0.01 && (
                            <button
                              type="button"
                              onClick={() => void openReturnModal(p)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-red-200 dark:border-red-900/60 bg-red-50/70 dark:bg-red-950/30 text-red-700 dark:text-red-300 hover:bg-red-100 text-[11px] font-medium whitespace-nowrap shrink-0"
                              title={isBn ? 'ভুল বা কম/বেশি হলে ধান ক্রয় ফেরত দিন' : 'Return Paddy Purchase'}
                            >
                              <RotateCcw className="w-3 h-3" /> {isBn ? 'ফেরত' : 'Return'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      </>
      )}

      {qrPreview && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl p-6 max-w-xs w-full text-center space-y-3">
            <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
              {t('proc.lotQrTitle')} — {qrPreview.code}
            </h4>
            <img src={qrPreview.dataUrl} alt={`QR for ${qrPreview.code}`} className="mx-auto rounded-lg border border-slate-200" />
            <button
              type="button"
              onClick={() => setQrPreview(null)}
              className="w-full py-2.5 min-h-[44px] rounded-xl bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      )}

      {!hideFinancials && quickModal === 'paddy' && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
          <form
            onSubmit={handleQuickAddPaddy}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl p-5 max-w-sm w-full space-y-4"
          >
            <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
              {isBn ? 'নতুন ধানের জাত যোগ করুন' : 'Quick Add Paddy Variety'}
            </h4>
            <div>
              <label className="block text-xs font-medium mb-1">{isBn ? 'ধানের জাতের নাম *' : 'Paddy Variety Name *'}</label>
              <input
                type="text"
                required
                placeholder={isBn ? 'ধানের জাতের নাম' : 'Paddy variety name'}
                value={quickPaddy.name}
                onChange={(e) => setQuickPaddy({ ...quickPaddy, name: e.target.value })}
                className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">{isBn ? 'SKU কোড (ঐচ্ছিক)' : 'SKU Code (Optional)'}</label>
                <input
                  type="text"
                  placeholder="PAD-MIN"
                  value={quickPaddy.sku}
                  onChange={(e) => setQuickPaddy({ ...quickPaddy, sku: e.target.value })}
                  className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono uppercase rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{isBn ? 'ডিফল্ট দর (৳/কেজি)' : 'Default Rate (৳/kg)'}</label>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  required
                  value={quickPaddy.default_rate}
                  onChange={(e) => setQuickPaddy({ ...quickPaddy, default_rate: Number(e.target.value) })}
                  className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setQuickModal(null)}
                className="px-4 py-2.5 min-h-[44px] rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={quickSaving}
                className="px-4 py-2.5 min-h-[44px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50"
              >
                {quickSaving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </div>
      )}

      {!hideFinancials && quickModal === 'warehouse' && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
          <form
            onSubmit={handleQuickAddWarehouse}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl p-5 max-w-sm w-full space-y-4"
          >
            <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
              {isBn ? 'নতুন গুদাম যোগ করুন' : 'Quick Add Raw Paddy Godown'}
            </h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium mb-1">{isBn ? 'গুদাম কোড *' : 'Godown Code *'}</label>
                <input
                  type="text"
                  required
                  value={quickWh.code}
                  onChange={(e) => setQuickWh({ ...quickWh, code: e.target.value })}
                  className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono uppercase rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium mb-1">{isBn ? 'ধারণক্ষমতা (কেজি)' : 'Capacity (kg)'}</label>
                <input
                  type="number"
                  required
                  min="0"
                  value={quickWh.capacity_kg}
                  onChange={(e) => setQuickWh({ ...quickWh, capacity_kg: Number(e.target.value) })}
                  className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{isBn ? 'গুদামের নাম *' : 'Godown Name *'}</label>
              <input
                type="text"
                required
                value={quickWh.name}
                onChange={(e) => setQuickWh({ ...quickWh, name: e.target.value })}
                className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setQuickModal(null)}
                className="px-4 py-2.5 min-h-[44px] rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={quickSaving}
                className="px-4 py-2.5 min-h-[44px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50"
              >
                {quickSaving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </div>
      )}

      {!hideFinancials && quickModal === 'supplier' && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
          <form
            onSubmit={handleQuickAddSupplier}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl p-5 max-w-sm w-full space-y-4"
          >
            <h4 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
              {isBn ? 'নতুন সাপ্লায়ার যোগ করুন' : 'Quick Add Supplier'}
            </h4>
            <div>
              <label className="block text-xs font-medium mb-1">{isBn ? 'সাপ্লায়ারের নাম *' : 'Supplier Name *'}</label>
              <input
                type="text"
                required
                value={quickSupplier.name}
                onChange={(e) => setQuickSupplier({ ...quickSupplier, name: e.target.value })}
                className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{t('party.phone')}</label>
              <input
                type="text"
                value={quickSupplier.phone}
                onChange={(e) => setQuickSupplier({ ...quickSupplier, phone: e.target.value })}
                className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">{t('party.address')}</label>
              <input
                type="text"
                value={quickSupplier.address}
                onChange={(e) => setQuickSupplier({ ...quickSupplier, address: e.target.value })}
                className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setQuickModal(null)}
                className="px-4 py-2.5 min-h-[44px] rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={quickSaving}
                className="px-4 py-2.5 min-h-[44px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium disabled:opacity-50"
              >
                {quickSaving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ADMIN RATE SETTLEMENT MODAL FOR GODOWN KEEPER PENDING_RATE RECEIPTS */}
      {!hideFinancials && pricingPurchase && (() => {
        const netWeight = Math.max(0, Number((pricingPurchase.payment_weight_kg - pricingForm.weight_loss_kg).toFixed(3)));
        const unitKg = pricingForm.settlement_unit_kg > 0 ? pricingForm.settlement_unit_kg : 75.5;
        const calcPayable = Number(((netWeight / unitKg) * pricingForm.settlement_rate).toFixed(2));
        const calcPerKg = pricingPurchase.payment_weight_kg > 0 ? Number((calcPayable / pricingPurchase.payment_weight_kg).toFixed(4)) : 0;
        return (
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
            <form
              onSubmit={handleSubmitPricing}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl p-5 max-w-md w-full space-y-4 max-h-[92vh] overflow-y-auto"
            >
              <div className="flex items-start justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
                <div>
                  <h4 className="text-base font-display font-semibold text-slate-900 dark:text-white">
                    {isBn ? `ধানের দর ও হিসাব নির্ধারণ — ${pricingPurchase.purchase_no}` : `Set Paddy Rate — ${pricingPurchase.purchase_no}`}
                  </h4>
                  <p className="text-xs text-slate-500 mt-0.5">
                    {pricingPurchase.supplier_name} · {pricingPurchase.item_name}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPricingPurchase(null)}
                  className="p-1 text-slate-400 hover:text-slate-600"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3 text-xs">
                <div>
                  <div className="text-[10px] text-slate-500">{isBn ? 'গৃহীত ওজন' : 'Received Wt'}</div>
                  <div className="font-mono font-semibold tabular-nums">{pricingPurchase.received_weight_kg.toLocaleString()} kg</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">{isBn ? 'পেমেন্ট ওজন' : 'Pay Weight'}</div>
                  <div className="font-mono font-semibold tabular-nums">{pricingPurchase.payment_weight_kg.toLocaleString()} kg</div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-500">{isBn ? 'মোট বস্তা' : 'Total Bags'}</div>
                  <div className="font-mono font-semibold tabular-nums">{pricingPurchase.bag_count.toLocaleString()}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block font-medium mb-1">{t('proc.lossDeduction')}</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={pricingForm.weight_loss_kg}
                    onChange={(e) => setPricingForm({ ...pricingForm, weight_loss_kg: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-2.5 min-h-[44px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">{t('proc.divisor')}</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={pricingForm.settlement_unit_kg}
                    onChange={(e) => setPricingForm({ ...pricingForm, settlement_unit_kg: Number(e.target.value) })}
                    className="w-full px-3 py-2.5 min-h-[44px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">{t('proc.ratePerUnit', { unit: unitKg })}</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={pricingForm.settlement_rate}
                    onChange={(e) => setPricingForm({ ...pricingForm, settlement_rate: Number(e.target.value) })}
                    className="w-full px-3 py-2.5 min-h-[44px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">{t('proc.paidNow')}</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={pricingForm.paid_amount}
                    onChange={(e) => setPricingForm({ ...pricingForm, paid_amount: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-2.5 min-h-[44px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="rounded-lg bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900/50 p-3 flex items-center justify-between text-xs">
                <div>
                  <div className="text-slate-600 dark:text-slate-300">{isBn ? 'সর্বমোট প্রদেয় বিল' : 'Total Payable'}</div>
                  <div className="font-mono text-[11px] text-slate-500">৳{calcPerKg.toFixed(4)}/{t('common.kg')}</div>
                </div>
                <div className="font-mono text-base font-bold tabular-nums text-slate-900 dark:text-white">
                  ৳{calcPayable.toLocaleString('en-IN')}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setPricingPurchase(null)}
                  className="px-4 py-2.5 min-h-[44px] rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-medium"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  disabled={pricingSubmitting}
                  className="px-4 py-2.5 min-h-[44px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold disabled:opacity-50"
                >
                  {pricingSubmitting ? t('common.saving') : isBn ? 'দর ও বিল সংরক্ষণ করুন' : 'Confirm Rate & Bill'}
                </button>
              </div>
            </form>
          </div>
        );
      })()}

      {/* PADDY PURCHASE RETURN / ADJUSTMENT MODAL */}
      {!hideFinancials && returningPurchase && (() => {
        const remByPurchase = Math.max(0, Number((returningPurchase.received_weight_kg - (returningPurchase.returned_qty_kg || 0)).toFixed(2)));
        const ownLotStock = Number(returningPurchase.unconsumed_lot_qty_kg ?? remByPurchase);
        const varietyStock = Number(returningPurchase.available_variety_stock_kg ?? ownLotStock);
        const maxPhysical = Math.max(0, Number(Math.min(remByPurchase, varietyStock).toFixed(2)));
        const maxAmt = Math.max(0, Number((returningPurchase.total_payable - (returningPurchase.returned_amount || 0)).toFixed(2)));
        return (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
          <form
            onSubmit={handleSubmitReturn}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl p-5 max-w-lg w-full space-y-4 max-h-[92vh] overflow-y-auto"
          >
            <div className="flex items-start justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h4 className="text-base font-display font-semibold text-slate-900 dark:text-white">
                  {isBn
                    ? `ধান ক্রয় ফেরত / সংশোধন — ${returningPurchase.purchase_no}`
                    : `Paddy Purchase Return / Adjust — ${returningPurchase.purchase_no}`}
                </h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  {returningPurchase.supplier_name} · {returningPurchase.item_name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReturningPurchase(null)}
                className="p-1 text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3 grid grid-cols-3 gap-2 text-xs">
              <div>
                <div className="text-[10px] text-slate-500">{isBn ? 'মোট ক্রয় ওজন' : 'Purchased Wt'}</div>
                <div className="font-mono font-semibold">{returningPurchase.received_weight_kg.toLocaleString()} kg</div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500">{isBn ? 'অব্যবহৃত স্টক' : 'Unconsumed Stock'}</div>
                <div className={`font-mono font-bold ${maxPhysical > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                  {maxPhysical.toLocaleString()} kg
                </div>
              </div>
              <div>
                <div className="text-[10px] text-slate-500">{isBn ? 'অবশিষ্ট বিল' : 'Returnable Bill'}</div>
                <div className="font-mono font-semibold text-amber-700 dark:text-amber-400">
                  ৳{maxAmt.toLocaleString('en-IN')}
                </div>
              </div>
            </div>

            {/* Mode Selector: Physical Return vs Financial Adjustment */}
            <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs">
              <button
                type="button"
                disabled={maxPhysical <= 0.01}
                onClick={() => {
                  const propAmt =
                    returningPurchase.received_weight_kg > 0
                      ? Math.min(maxAmt, Number(((maxPhysical / returningPurchase.received_weight_kg) * returningPurchase.total_payable).toFixed(2)))
                      : maxAmt;
                  setReturnForm((prev) => ({
                    ...prev,
                    return_type: 'PHYSICAL_RETURN',
                    return_qty_kg: maxPhysical,
                    return_amount: propAmt,
                  }));
                }}
                className={`px-3 py-2 min-h-[40px] rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                  returnForm.return_type === 'PHYSICAL_RETURN'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {isBn ? 'ধান স্টক + টাকা ফেরত' : 'Stock + Money Return'}
              </button>
              <button
                type="button"
                onClick={() =>
                  setReturnForm((prev) => ({
                    ...prev,
                    return_type: 'FINANCIAL_ADJUSTMENT',
                    return_qty_kg: 0,
                  }))
                }
                className={`px-3 py-2 min-h-[40px] rounded-lg font-medium transition-colors ${
                  returnForm.return_type === 'FINANCIAL_ADJUSTMENT'
                    ? 'bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-400 shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {isBn ? 'শুধু টাকা/বিল সংশোধন' : 'Money / Bill Adjust Only'}
              </button>
            </div>

            {maxPhysical <= 0.01 && (
              <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-300">
                {isBn
                  ? `এই ক্রয়ের (${returningPurchase.purchase_no}) ধান ইতিমধ্যেই ডায়ার/ক্রাশিংয়ে ব্যবহৃত হয়ে গেছে (অব্যবহৃত স্টক ০ কেজি)। তাই স্টক না কমিয়ে সরাসরি সাপ্লায়ারের টাকা বা বস্তার হিসাব সমন্বয় করুন।`
                  : `All stock from ${returningPurchase.purchase_no} has already been consumed in drying/milling (0 kg left). Use Money/Bill Adjustment to correct supplier billing without touching stock.`}
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium mb-1">
                  {returnForm.return_type === 'FINANCIAL_ADJUSTMENT'
                    ? isBn
                      ? 'হিসাবে ওজন সংশোধন (কেজি, ঐচ্ছিক)'
                      : 'Weight Adjustment Note (kg, Optional)'
                    : isBn
                    ? 'ফেরত ধানের ওজন (কেজি) *'
                    : 'Return Quantity (kg) *'}
                </label>
                <input
                  type="number"
                  min={returnForm.return_type === 'PHYSICAL_RETURN' ? '0.01' : '0'}
                  max={returnForm.return_type === 'PHYSICAL_RETURN' ? Math.max(0.01, maxPhysical) : remByPurchase}
                  step="0.01"
                  required={returnForm.return_type === 'PHYSICAL_RETURN'}
                  value={returnForm.return_qty_kg}
                  onChange={(e) => {
                    const qty = Math.max(0, Number(e.target.value));
                    const propAmt =
                      returningPurchase.received_weight_kg > 0
                        ? Math.min(maxAmt, Number(((qty / returningPurchase.received_weight_kg) * returningPurchase.total_payable).toFixed(2)))
                        : maxAmt;
                    setReturnForm({
                      ...returnForm,
                      return_qty_kg: qty,
                      return_amount: qty > 0 ? propAmt : returnForm.return_amount,
                    });
                  }}
                  className="w-full px-3 py-2.5 min-h-[44px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'ফেরত / সমন্বয় মূল্য (৳) *' : 'Return / Adjust Amount (৳) *'}</label>
                <input
                  type="number"
                  min="0.01"
                  max={Math.max(0.01, maxAmt)}
                  step="0.01"
                  required
                  value={returnForm.return_amount}
                  onChange={(e) => setReturnForm({ ...returnForm, return_amount: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2.5 min-h-[44px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'ফেরত চট বস্তা' : 'Return Jute Bags'}</label>
                <input
                  type="number"
                  min="0"
                  value={returnForm.return_jute_bags}
                  onChange={(e) => setReturnForm({ ...returnForm, return_jute_bags: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2.5 min-h-[44px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'ফেরত প্লাস্টিক বস্তা' : 'Return Plastic Bags'}</label>
                <input
                  type="number"
                  min="0"
                  value={returnForm.return_plastic_bags}
                  onChange={(e) => setReturnForm({ ...returnForm, return_plastic_bags: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2.5 min-h-[44px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium mb-1">{isBn ? 'টাকা সমন্বয়ের ধরন' : 'Refund Mode'}</label>
                <select
                  value={returnForm.refund_mode}
                  onChange={(e) => setReturnForm({ ...returnForm, refund_mode: e.target.value as 'ADJUST_PAYABLE' | 'CASH_REFUND' })}
                  className="w-full px-3 py-2.5 min-h-[44px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="ADJUST_PAYABLE">
                    {isBn ? 'সাপ্লায়ার বকেয়া/লেজার থেকে বাদ দিন' : 'Adjust Supplier Payable Ledger'}
                  </option>
                  <option value="CASH_REFUND">
                    {isBn ? 'সাপ্লায়ারের কাছ থেকে নগদ/ব্যাংক ফেরত' : 'Cash / Bank Refund Received'}
                  </option>
                </select>
              </div>
              {returnForm.refund_mode === 'CASH_REFUND' && (
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'জমা অ্যাকাউন্ট' : 'Deposit Account'}</label>
                  <select
                    value={returnForm.account_id}
                    onChange={(e) => setReturnForm({ ...returnForm, account_id: Number(e.target.value) })}
                    className="w-full px-3 py-2.5 min-h-[44px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {returnAccounts.map((acc) => (
                      <option key={acc.id} value={acc.id}>
                        {acc.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{isBn ? 'ফেরত / সংশোধনের কারণ' : 'Return / Adjustment Reason'}</label>
              <input
                type="text"
                value={returnForm.reason}
                onChange={(e) => setReturnForm({ ...returnForm, reason: e.target.value })}
                placeholder={isBn ? 'কারণ লিখুন' : 'Reason'}
                className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setReturningPurchase(null)}
                className="px-4 py-2.5 min-h-[44px] rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={returnSubmitting}
                className="px-4 py-2.5 min-h-[44px] rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold disabled:opacity-50"
              >
                {returnSubmitting
                  ? t('common.saving')
                  : returnForm.return_type === 'FINANCIAL_ADJUSTMENT'
                  ? isBn
                    ? 'টাকা ও হিসাব সংশোধন করুন'
                    : 'Confirm Bill Adjustment'
                  : isBn
                  ? 'ধান ক্রয় ফেরত নিশ্চিত করুন'
                  : 'Confirm Purchase Return'}
              </button>
            </div>
          </form>
        </div>
        );
      })()}
      {/* CUSTOMER / SUPPLIER MESSAGING MODAL */}
      {msgModalPurchase && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl p-5 max-w-lg w-full space-y-4 max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h4 className="text-base font-display font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                  <MessageSquare className="w-4 h-4 text-emerald-600" />
                  <span>{isBn ? 'কাস্টমার / সাপ্লায়ার মেসেজ পাঠান' : 'Send Customer / Supplier Message'}</span>
                </h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  {msgModalPurchase.purchase_no} · {msgModalPurchase.supplier_name} · {msgModalPurchase.item_name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setMsgModalPurchase(null)}
                className="p-1 text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium mb-1">{isBn ? 'মোবাইল নম্বর' : 'Mobile Number'}</label>
                <input
                  type="text"
                  value={msgModalPhone}
                  onChange={(e) => setMsgModalPhone(e.target.value)}
                  placeholder="017XXXXXXXX"
                  className="w-full px-3 py-2.5 min-h-[42px] font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'মেসেজের ভাষা' : 'Message Language'}</label>
                <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setMsgModalLang('bn');
                      setMsgModalText(formatPaddyPurchaseMessage(msgModalPurchase, 'bn', { hideFinancials }));
                    }}
                    className={`py-2 rounded text-xs font-medium ${
                      msgModalLang === 'bn' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    বাংলা
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMsgModalLang('en');
                      setMsgModalText(formatPaddyPurchaseMessage(msgModalPurchase, 'en', { hideFinancials }));
                    }}
                    className={`py-2 rounded text-xs font-medium ${
                      msgModalLang === 'en' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
                    }`}
                  >
                    English
                  </button>
                </div>
              </div>
            </div>

            <div className="text-xs">
              <label className="block font-medium mb-1">{isBn ? 'মেসেজ টেক্সট (প্রয়োজনে পরিবর্তন করুন)' : 'Message Preview (Editable)'}</label>
              <textarea
                rows={4}
                value={msgModalText}
                onChange={(e) => setMsgModalText(e.target.value)}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 leading-relaxed"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-1">
              <a
                href={buildWhatsAppHref(msgModalPhone, msgModalText)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => handleLogManualDispatch(msgModalPurchase, 'MANUAL_WHATSAPP', msgModalPhone, msgModalText)}
                className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 min-h-[42px] rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{isBn ? 'WhatsApp-এ পাঠান' : 'Send on WhatsApp'}</span>
              </a>
              <a
                href={buildSmsHref(msgModalPhone, msgModalText)}
                onClick={() => handleLogManualDispatch(msgModalPurchase, 'MANUAL_SMS', msgModalPhone, msgModalText)}
                className="flex-1 min-w-[140px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 min-h-[42px] rounded-xl bg-slate-900 dark:bg-slate-700 hover:opacity-95 text-white text-xs font-medium"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                <span>{isBn ? 'ফোন SMS অ্যাপ' : 'Phone SMS App'}</span>
              </a>
              <button
                type="button"
                onClick={() => void handleCopyMessage(msgModalText, 'modal')}
                className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2.5 min-h-[42px] rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {copiedId === 'modal' ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{isBn ? 'কপি' : 'Copy'}</span>
              </button>
            </div>

            {smsStatus.configured && (
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between gap-3">
                <span className="text-[11px] text-slate-500">
                  {isBn ? `সার্ভার গেটওয়ে: ${smsStatus.provider}` : `Server Gateway: ${smsStatus.provider}`}
                </span>
                <button
                  type="button"
                  disabled={msgModalSending}
                  onClick={() =>
                    void handleGatewaySendFromUi({
                      purchase: msgModalPurchase,
                      phone: msgModalPhone,
                      msgLang: msgModalLang,
                      source: 'modal',
                    })
                  }
                  className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[40px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold disabled:opacity-50"
                >
                  <Send className="w-3.5 h-3.5" />
                  <span>
                    {msgModalSending
                      ? isBn
                        ? 'পাঠানো হচ্ছে...'
                        : 'Sending...'
                      : isBn
                      ? 'সার্ভার থেকে অটো SMS পাঠান'
                      : 'Send via Server SMS'}
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* DIRECT DRY PURCHASED PADDY MODAL */}
      {dryModalPurchase && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
          <form
            onSubmit={handleSubmitDryPurchase}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl p-5 max-w-xl w-full space-y-4 max-h-[92vh] overflow-y-auto"
          >
            <div className="flex items-start justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h4 className="text-base font-display font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                  <Sun className="w-4 h-4 text-amber-600" />
                  <span>{isBn ? 'কেনা ধান শুকানো / চাটালে প্রেরণ' : 'Dry Purchased Paddy'}</span>
                </h4>
                <p className="text-xs text-slate-500 mt-0.5">
                  {dryModalPurchase.purchase_no} · {dryModalPurchase.supplier_name} · {dryModalPurchase.item_name}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDryModalPurchase(null)}
                className="p-1 text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Drying Workflow Selector */}
            <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg text-xs">
              <button
                type="button"
                onClick={() => setDryModalForm((prev) => ({ ...prev, target_mode: 'QUICK_DRY' }))}
                className={`py-2 px-3 rounded-md font-semibold transition-colors ${
                  dryModalForm.target_mode === 'QUICK_DRY'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {isBn ? 'দ্রুত শুকানো / ড্রায়ার' : 'Quick Drying / Yard'}
              </button>
              <button
                type="button"
                onClick={() => setDryModalForm((prev) => ({ ...prev, target_mode: 'CHATAL' }))}
                className={`py-2 px-3 rounded-md font-semibold transition-colors ${
                  dryModalForm.target_mode === 'CHATAL'
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {isBn ? 'চাটালে ও খামালে দিন (ভাগ-বণ্টন)' : 'Send to Chatal & Khamal'}
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium mb-1">{isBn ? 'যে গোডাউন থেকে ধান নেবেন *' : 'Source Godown *'}</label>
                <select
                  value={dryModalForm.source_warehouse_id}
                  onChange={(e) => {
                    const whId = Number(e.target.value);
                    const lot = getPurchaseLotForWarehouse(dryModalPurchase, whId);
                    const sp = dryModalPurchase.splits?.find((x) => x.warehouse_id === whId);
                    const availKg = lot
                      ? Number(lot.remaining_qty_kg || 0)
                      : Number(sp?.received_weight_kg ?? dryModalPurchase.received_weight_kg ?? 0);
                    const availBags = lot
                      ? Number(lot.remaining_bags || sp?.bag_count || dryModalPurchase.bag_count || 0)
                      : Number(sp?.bag_count ?? dryModalPurchase.bag_count ?? 0);
                    setDryModalForm((prev) => ({
                      ...prev,
                      source_warehouse_id: whId,
                      input_qty_kg: Number(availKg.toFixed(2)),
                      input_bags: availBags,
                      output_bags: availBags,
                    }));
                  }}
                  className="w-full px-3 py-2.5 min-h-[42px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {dryModalPurchase.splits && dryModalPurchase.splits.length > 0 ? (
                    dryModalPurchase.splits.map((sp) => {
                      const lot = getPurchaseLotForWarehouse(dryModalPurchase, sp.warehouse_id);
                      const kg = lot ? Number(lot.remaining_qty_kg || 0) : sp.received_weight_kg;
                      const bags = lot ? Number(lot.remaining_bags || sp.bag_count) : sp.bag_count;
                      return (
                        <option key={sp.warehouse_id} value={sp.warehouse_id}>
                          {sp.warehouse_name} ({bags} {isBn ? 'বস্তা' : 'bags'} / {kg.toLocaleString('en-IN')} kg)
                        </option>
                      );
                    })
                  ) : (
                    warehouses.map((w) => {
                      const lot = getPurchaseLotForWarehouse(dryModalPurchase, w.id);
                      return (
                        <option key={w.id} value={w.id}>
                          {w.name}
                          {lot ? ` (${lot.remaining_bags || 0}ব / ${Number(lot.remaining_qty_kg || 0).toLocaleString('en-IN')} kg)` : ''}
                        </option>
                      );
                    })
                  )}
                </select>
              </div>

              <div>
                <label className="block font-medium mb-1">
                  {dryModalForm.target_mode === 'CHATAL'
                    ? isBn
                      ? 'চাতাল / ইয়ার্ড *'
                      : 'Chatal Yard *'
                    : isBn
                    ? 'শুকানোর পর কোন গোডাউনে রাখবেন *'
                    : 'Destination Godown *'}
                </label>
                <select
                  value={dryModalForm.dest_warehouse_id}
                  onChange={(e) => setDryModalForm((prev) => ({ ...prev, dest_warehouse_id: Number(e.target.value) }))}
                  className="w-full px-3 py-2.5 min-h-[42px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {(dryModalForm.target_mode === 'CHATAL' ? chatalYards : warehouses).map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name} ({w.code})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-medium mb-1">{isBn ? 'ভিজা ধানের ওজন (কেজি) *' : 'Wet Input Weight (kg) *'}</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={dryModalForm.input_qty_kg}
                  onChange={(e) => setDryModalForm((prev) => ({ ...prev, input_qty_kg: Math.max(0, Number(e.target.value)) }))}
                  className="w-full px-3 py-2.5 min-h-[42px] font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>

              <div>
                <label className="block font-medium mb-1">{isBn ? 'ভিজা বস্তার সংখ্যা' : 'Wet Input Bags'}</label>
                <input
                  type="number"
                  min="0"
                  value={dryModalForm.input_bags}
                  onChange={(e) => setDryModalForm((prev) => ({ ...prev, input_bags: Math.max(0, Math.round(Number(e.target.value))) }))}
                  className="w-full px-3 py-2.5 min-h-[42px] font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            {dryModalForm.target_mode === 'QUICK_DRY' ? (
              <div className="space-y-3 border-t border-slate-100 dark:border-slate-800 pt-3">
                <label className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 text-xs font-semibold text-amber-900 dark:text-amber-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={dryModalForm.weight_pending}
                    onChange={(e) => setDryModalForm((prev) => ({ ...prev, weight_pending: e.target.checked }))}
                    className="rounded border-amber-400 text-amber-600 focus:ring-amber-500"
                  />
                  <span>
                    {isBn
                      ? 'ওজন ছাড়া শুধু বস্তায় স্টক রাখুন (বিক্রি/বের হওয়ার সময় ওজন ও দাম)'
                      : 'Store unweighed by bag count (weigh & price at exit)'}
                  </span>
                </label>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'শুকানোর পদ্ধতি' : 'Drying Method'}</label>
                    <select
                      value={dryModalForm.drying_method}
                      onChange={(e) =>
                        setDryModalForm((prev) => ({ ...prev, drying_method: e.target.value as 'SUN_YARD' | 'MECHANICAL_DRYER' }))
                      }
                      className="w-full px-3 py-2.5 min-h-[42px] rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="SUN_YARD">{isBn ? 'রোদে চাতাল (Sun Yard)' : 'Sun Yard'}</option>
                      <option value="MECHANICAL_DRYER">{isBn ? 'ড্রায়ার মেশিন' : 'Mechanical Dryer'}</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'শুকনো জমা বস্তা *' : 'Stored Dried Bags *'}</label>
                    <input
                      type="number"
                      min={dryModalForm.weight_pending ? 1 : 0}
                      required={dryModalForm.weight_pending}
                      value={dryModalForm.output_bags}
                      onChange={(e) => setDryModalForm((prev) => ({ ...prev, output_bags: Math.max(0, Math.round(Number(e.target.value))) }))}
                      className="w-full px-3 py-2.5 min-h-[42px] font-mono tabular-nums font-semibold rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/40 dark:bg-slate-950"
                    />
                  </div>

                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'শুকনো ওজন (কেজি)' : 'Dried Output (kg)'}</label>
                    {dryModalForm.weight_pending ? (
                      <div className="px-3 py-2.5 min-h-[42px] flex items-center text-xs rounded-lg border border-dashed border-amber-300 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 font-medium">
                        {isBn ? 'বের হওয়ার সময় ওজন হবে' : 'Weighed at exit'}
                      </div>
                    ) : (
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        required
                        value={dryModalForm.output_qty_kg}
                        onChange={(e) => setDryModalForm((prev) => ({ ...prev, output_qty_kg: Math.max(0, Number(e.target.value)) }))}
                        className="w-full px-3 py-2.5 min-h-[42px] font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      />
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'আগের আর্দ্রতা %' : 'Initial %'}</label>
                    <input
                      type="number"
                      step="0.1"
                      value={dryModalForm.initial_moisture_pct}
                      onChange={(e) => setDryModalForm((prev) => ({ ...prev, initial_moisture_pct: Number(e.target.value) }))}
                      className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'পরের আর্দ্রতা %' : 'Final %'}</label>
                    <input
                      type="number"
                      step="0.1"
                      value={dryModalForm.final_moisture_pct}
                      onChange={(e) => setDryModalForm((prev) => ({ ...prev, final_moisture_pct: Number(e.target.value) }))}
                      className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'জ্বালানি / ত্রিপল (৳)' : 'Fuel/Power (৳)'}</label>
                    <input
                      type="number"
                      min="0"
                      value={dryModalForm.fuel_power_cost}
                      onChange={(e) => setDryModalForm((prev) => ({ ...prev, fuel_power_cost: Math.max(0, Number(e.target.value)) }))}
                      className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'লেবার মজুরি (৳)' : 'Labor Cost (৳)'}</label>
                    <input
                      type="number"
                      min="0"
                      value={dryModalForm.labor_cost}
                      onChange={(e) => setDryModalForm((prev) => ({ ...prev, labor_cost: Math.max(0, Number(e.target.value)) }))}
                      className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3 border-t border-slate-100 dark:border-slate-800 pt-3 text-xs">
                <p className="text-slate-500">
                  {isBn
                    ? 'চাটালে ধান ঢালার পর একাধিক গোডাউনে (যেমন ১ম ও ২য় রাউন্ডে দুই গোডাউনে) ভাগ করে পাঠানো, ক্রাশিং বা সরাসরি বিক্রি এবং চূড়ান্ত লাভ-লস হিসাব করতে পারবেন।'
                    : 'Pour onto Chatal to split across multiple godowns in rounds, crush or sell directly, and calculate full batch P&L.'}
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2">
                    <label className="block font-medium mb-1">{isBn ? 'চাতাল ব্যাচের নাম / শিরোনাম' : 'Chatal Batch Title'}</label>
                    <input
                      type="text"
                      value={dryModalForm.chatal_title}
                      onChange={(e) => setDryModalForm((prev) => ({ ...prev, chatal_title: e.target.value }))}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'শুকানো খরচ (৳)' : 'Drying Expense (৳)'}</label>
                    <input
                      type="number"
                      min="0"
                      value={dryModalForm.fuel_power_cost}
                      onChange={(e) => setDryModalForm((prev) => ({ ...prev, fuel_power_cost: Math.max(0, Number(e.target.value)) }))}
                      className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'খামাল খরচ (৳)' : 'Khamal Expense (৳)'}</label>
                    <input
                      type="number"
                      min="0"
                      value={dryModalForm.khamal_cost}
                      onChange={(e) => setDryModalForm((prev) => ({ ...prev, khamal_cost: Math.max(0, Number(e.target.value)) }))}
                      className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'খরচ পরিশোধ' : 'Expense Payment'}</label>
                    <select
                      value={dryModalForm.payment_timing}
                      onChange={(e) => setDryModalForm((prev) => ({ ...prev, payment_timing: e.target.value as 'PAID' | 'UNPAID' | 'PARTIAL' }))}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="PAID">{isBn ? 'নগদ / ব্যাংক পরিশোধ' : 'Paid Now'}</option>
                      <option value="UNPAID">{isBn ? 'বাকিতে (পরে পরিশোধ)' : 'Unpaid'}</option>
                      <option value="PARTIAL">{isBn ? 'আংশিক পরিশোধ' : 'Partial'}</option>
                    </select>
                  </div>
                  {dryModalForm.payment_timing !== 'UNPAID' && (
                    <div>
                      <label className="block font-medium mb-1">{isBn ? 'ক্যাশ / ব্যাংক অ্যাকাউন্ট' : 'Cash / Bank Account'}</label>
                      <select
                        value={dryModalForm.account_id}
                        onChange={(e) => setDryModalForm((prev) => ({ ...prev, account_id: Number(e.target.value) }))}
                        className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                      >
                        {cashBankAccounts.map((acc) => (
                          <option key={acc.id} value={acc.id}>
                            {acc.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="text-xs">
              <label className="block font-medium mb-1">{isBn ? 'মন্তব্য / নোট' : 'Notes'}</label>
              <input
                type="text"
                value={dryModalForm.notes}
                onChange={(e) => setDryModalForm((prev) => ({ ...prev, notes: e.target.value }))}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setDryModalPurchase(null)}
                className="px-4 py-2.5 min-h-[42px] rounded-xl border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={dryModalSubmitting}
                className="px-5 py-2.5 min-h-[42px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold disabled:opacity-50"
              >
                {dryModalSubmitting
                  ? t('common.saving')
                  : dryModalForm.target_mode === 'CHATAL'
                  ? isBn
                    ? 'চাটালে ধান ঢালুন'
                    : 'Pour onto Chatal'
                  : dryModalForm.weight_pending
                  ? isBn
                    ? 'শুকিয়ে গোডাউনে রাখুন'
                    : 'Dry & Store Unweighed'
                  : isBn
                  ? 'শুকানো সম্পন্ন করুন'
                  : 'Complete Drying'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
