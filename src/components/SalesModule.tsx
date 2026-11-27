import React, { useMemo, useState } from 'react';
import { Eye, Plus, QrCode, Trash2 } from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { apiMutate } from '../services/api';
import type {
  CostingMethod,
  DirectPaddySale,
  InventoryLot,
  ItemMaster,
  Party,
  ProductCategory,
  ProductionBatch,
  SalesInvoice,
  Warehouse,
} from '../types/erp';
import { isPaddyItem, isSaleableRiceOrByproductItem } from '../utils/itemFilters';
import { exportDirectPaddySalePdf, exportSalesInvoicePdf, generateQrDataUrl } from '../utils/reports';

interface SalesModuleProps {
  invoices: SalesInvoice[];
  paddySales: DirectPaddySale[];
  customers: Party[];
  warehouses: Warehouse[];
  items: ItemMaster[];
  categories?: ProductCategory[];
  lots?: InventoryLot[];
  batches?: ProductionBatch[];
  onRefresh: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

interface SaleDraftLine {
  uid: string;
  preferred_lot_id: number;
  item_id: number;
  warehouse_id: number;
  costing_method: CostingMethod;
  bag_count: number;
  pack_size_kg: number;
  rate_per_bag: number;
  qty_kg: number;
}

export const SalesModule: React.FC<SalesModuleProps> = ({
  invoices,
  paddySales,
  customers,
  warehouses,
  items,
  categories = [],
  lots = [],
  batches = [],
  onRefresh,
  onNotify,
}) => {
  const { t, lang } = useI18n();
  const isBn = lang === 'bn';

  const [subTab, setSubTab] = useState<'rice' | 'paddy'>('rice');
  const [showInvForm, setShowInvForm] = useState(false);
  const [showPaddySaleForm, setShowPaddySaleForm] = useState(false);
  const [invSubmitting, setInvSubmitting] = useState(false);
  const [psSubmitting, setPsSubmitting] = useState(false);
  const [qrPreview, setQrPreview] = useState<{ code: string; dataUrl: string } | null>(null);

  const riceAndByproductItems = useMemo(
    () => items.filter((i) => isSaleableRiceOrByproductItem(i, categories)),
    [items, categories]
  );
  const paddyItems = useMemo(() => items.filter((i) => isPaddyItem(i, categories)), [items, categories]);

  const batchById = useMemo(() => {
    const m = new Map<number, ProductionBatch>();
    for (const b of batches) m.set(b.id, b);
    return m;
  }, [batches]);

  const saleableLots = useMemo(() => {
    const riceIds = new Set(riceAndByproductItems.map((i) => i.id));
    return lots.filter((l) => Number(l.remaining_qty_kg || 0) > 0.01 && riceIds.has(l.item_id));
  }, [lots, riceAndByproductItems]);

  const makeDefaultLine = (): SaleDraftLine => {
    const firstItem = riceAndByproductItems[0];
    const packKg = Number(firstItem?.bag_weight_kg || 50) || 50;
    const perKg = Number(firstItem?.default_rate || 0);
    const defaultWh =
      firstItem?.category === 'HEAD_RICE'
        ? warehouses.find((w) => w.warehouse_type === 'FINISHED_RICE')?.id || warehouses[0]?.id || 0
        : warehouses.find((w) => w.warehouse_type === 'BY_PRODUCT')?.id || warehouses[0]?.id || 0;
    return {
      uid: crypto.randomUUID(),
      preferred_lot_id: 0,
      item_id: firstItem?.id || 0,
      warehouse_id: defaultWh,
      costing_method: 'FIFO',
      bag_count: 0,
      pack_size_kg: packKg,
      rate_per_bag: perKg > 0 ? Number((perKg * packKg).toFixed(2)) : 0,
      qty_kg: 0,
    };
  };

  // Rice & By-Product Bag-Based Multi-Line Invoice State
  const [invHeader, setInvHeader] = useState({
    customer_id: customers[0]?.id || 0,
    vehicle_no: '',
    paid_amount: 0,
    discount_amount: 0,
  });
  const [invLines, setInvLines] = useState<SaleDraftLine[]>(() => [makeDefaultLine()]);

  // Direct Paddy Sale State (Full Parity with Paddy Purchase + Live Stock Deduction)
  const defaultSettlementUnit = 75.5;
  const initialPaddyRatePerKg = paddyItems[0]?.default_rate || 0;
  const [psForm, setPsForm] = useState({
    customer_id: customers[0]?.id || 0,
    warehouse_id: warehouses.find((w) => w.warehouse_type === 'RAW_PADDY')?.id || warehouses[0]?.id || 0,
    item_id: paddyItems[0]?.id || 0,
    preferred_lot_id: 0,
    costing_method: 'FIFO' as CostingMethod,
    vehicle_no: '',
    challan_no: '',
    jute_bag_count: 0,
    plastic_bag_count: 0,
    moisture_pct: 0,
    scale_weight_kg: 0,
    qty_kg: 0,
    payment_weight_kg: 0,
    weight_loss_kg: 0,
    settlement_unit_kg: defaultSettlementUnit,
    settlement_rate: initialPaddyRatePerKg > 0 ? Number((initialPaddyRatePerKg * defaultSettlementUnit).toFixed(2)) : 0,
    paid_amount: 0,
    close_pending_lot: true,
    notes: '',
  });

  const effectiveInvCustomerId = customers.some((c) => c.id === invHeader.customer_id)
    ? invHeader.customer_id
    : customers[0]?.id || 0;

  const resolveLineDefaults = (line: SaleDraftLine): SaleDraftLine => {
    const itemId = riceAndByproductItems.some((i) => i.id === line.item_id)
      ? line.item_id
      : riceAndByproductItems[0]?.id || 0;
    const whId = warehouses.some((w) => w.id === line.warehouse_id)
      ? line.warehouse_id
      : warehouses.find((w) => w.warehouse_type === 'FINISHED_RICE')?.id || warehouses[0]?.id || 0;
    return { ...line, item_id: itemId, warehouse_id: whId };
  };

  const resolvedInvLines = useMemo(() => invLines.map(resolveLineDefaults), [invLines, riceAndByproductItems, warehouses]);

  const invTotals = useMemo(() => {
    let totalBags = 0;
    let totalKg = 0;
    let subtotal = 0;
    for (const line of resolvedInvLines) {
      totalBags += Math.max(0, Math.round(Number(line.bag_count || 0)));
      totalKg += Number(line.qty_kg || 0);
      const lineTotal =
        line.bag_count > 0 && line.rate_per_bag > 0
          ? Number((line.bag_count * line.rate_per_bag).toFixed(2))
          : 0;
      subtotal += lineTotal;
    }
    const netTotal = Math.max(0, Number((subtotal - Number(invHeader.discount_amount || 0)).toFixed(2)));
    return {
      totalBags,
      totalKg: Number(totalKg.toFixed(2)),
      subtotal: Number(subtotal.toFixed(2)),
      netTotal,
    };
  }, [resolvedInvLines, invHeader.discount_amount]);

  const updateInvLine = (uid: string, updater: (prev: SaleDraftLine) => SaleDraftLine) => {
    setInvLines((prev) => prev.map((l) => (l.uid === uid ? updater(resolveLineDefaults(l)) : l)));
  };

  const handleSelectLineLot = (uid: string, lotId: number) => {
    if (lotId <= 0) {
      updateInvLine(uid, (prev) => ({ ...prev, preferred_lot_id: 0 }));
      return;
    }
    const lot = saleableLots.find((l) => l.id === lotId);
    if (!lot) return;
    const packKg = Number(lot.pack_size_kg || lot.bag_weight_kg || 50) || 50;
    const itemDef = riceAndByproductItems.find((i) => i.id === lot.item_id);
    const bagRate = itemDef?.default_rate ? Number((itemDef.default_rate * packKg).toFixed(2)) : 0;

    updateInvLine(uid, (prev) => ({
      ...prev,
      preferred_lot_id: lot.id,
      item_id: lot.item_id,
      warehouse_id: lot.warehouse_id,
      pack_size_kg: packKg,
      bag_count: 0,
      qty_kg: 0,
      rate_per_bag: bagRate,
    }));
  };

  const handleCreateInvoice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectiveInvCustomerId || resolvedInvLines.length === 0) {
      onNotify(isBn ? 'কাস্টমার এবং অন্তত একটি পণ্য যোগ করুন।' : 'Customer and at least one item line are required.', 'err');
      return;
    }
    for (const line of resolvedInvLines) {
      if (line.bag_count <= 0 || line.rate_per_bag <= 0 || line.qty_kg <= 0) {
        onNotify(
          isBn
            ? 'প্রতিটি পণ্যের বস্তার সংখ্যা, বস্তার ওজন এবং বস্তার দাম অবশ্যই শূন্যের বেশি হতে হবে।'
            : 'Each line must have positive bag count, pack size, and rate per bag.',
          'err'
        );
        return;
      }
    }

    setInvSubmitting(true);
    try {
      const payloadItems = resolvedInvLines.map((line) => {
        const selectedLot = line.preferred_lot_id > 0 ? saleableLots.find((l) => l.id === line.preferred_lot_id) : null;
        const preferredBatchId = selectedLot
          ? selectedLot.origin_batch_id ??
            (selectedLot.source_type === 'PRODUCTION_OUTPUT' && selectedLot.source_id ? Number(selectedLot.source_id) : undefined)
          : undefined;
        const lineTotal = Number((line.bag_count * line.rate_per_bag).toFixed(2));
        const ratePerKg = line.qty_kg > 0 ? Number((lineTotal / line.qty_kg).toFixed(4)) : 0;
        return {
          item_id: line.item_id,
          warehouse_id: line.warehouse_id,
          bag_count: line.bag_count,
          pack_size_kg: line.pack_size_kg,
          rate_per_bag: line.rate_per_bag,
          qty_kg: line.qty_kg,
          preferred_lot_id: selectedLot ? selectedLot.id : undefined,
          preferred_batch_id: preferredBatchId,
          rate_per_kg: ratePerKg,
          costing_method: line.costing_method,
        };
      });

      const res = await apiMutate({
        endpoint: '/api/v1/sales-invoices',
        payload: {
          customer_id: effectiveInvCustomerId,
          vehicle_no: invHeader.vehicle_no,
          paid_amount: invHeader.paid_amount,
          discount_amount: invHeader.discount_amount,
          items: payloadItems,
        },
        module: 'Rice & By-Product Sale',
        summary: `Invoice ${invTotals.totalBags} bags (${invTotals.totalKg} kg) · ৳${invTotals.netTotal.toLocaleString('en-IN')}`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: বিক্রয় চালান IndexedDB সিঙ্ক কিউতে জমা হয়েছে।' : 'Offline: Sales invoice saved to IndexedDB sync queue.', 'warn');
      } else {
        onNotify(
          isBn
            ? 'বস্তা ভিত্তিক বিক্রয় চালান সংরক্ষিত হয়েছে, স্টক সমন্বয় ও ডায়ার ব্যাচের লাভ-লস আপডেট হয়েছে।'
            : 'Bag-based sales invoice posted, stock deducted, and Dryer Batch P&L updated.',
          'ok'
        );
      }
      setShowInvForm(false);
      setInvLines([makeDefaultLine()]);
      setInvHeader((prev) => ({ ...prev, paid_amount: 0, discount_amount: 0, vehicle_no: '' }));
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setInvSubmitting(false);
    }
  };

  // Direct Paddy Sale Calculations (Mirroring Paddy Purchase + Live Godown Deduction + Unweighed Pending Lots)
  const availablePaddyLots = useMemo(() => {
    const paddyIds = new Set(paddyItems.map((i) => i.id));
    return lots.filter((l) => (Number(l.remaining_qty_kg || 0) > 0.01 || Boolean(l.weight_pending)) && paddyIds.has(l.item_id));
  }, [lots, paddyItems]);

  const effectivePsCustomerId = customers.some((c) => c.id === psForm.customer_id)
    ? psForm.customer_id
    : customers[0]?.id || 0;
  const effectivePsWhId = warehouses.some((w) => w.id === psForm.warehouse_id)
    ? psForm.warehouse_id
    : warehouses.find((w) => w.warehouse_type === 'RAW_PADDY')?.id || warehouses[0]?.id || 0;
  const effectivePsItemId = paddyItems.some((i) => i.id === psForm.item_id)
    ? psForm.item_id
    : paddyItems[0]?.id || 0;

  const selectedPsLot = useMemo(
    () => (psForm.preferred_lot_id > 0 ? availablePaddyLots.find((l) => l.id === psForm.preferred_lot_id) || null : null),
    [availablePaddyLots, psForm.preferred_lot_id]
  );

  const matchingPaddyLots = useMemo(
    () => availablePaddyLots.filter((l) => l.warehouse_id === effectivePsWhId && l.item_id === effectivePsItemId),
    [availablePaddyLots, effectivePsWhId, effectivePsItemId]
  );

  const psGodownStats = useMemo(() => {
    const sourceLots = selectedPsLot ? [selectedPsLot] : matchingPaddyLots;
    let totalKg = 0;
    let totalBags = 0;
    let totalVal = 0;
    let hasPendingWeight = false;
    let pendingCostTotal = 0;
    for (const l of sourceLots) {
      const isPend = Boolean(l.weight_pending);
      const q = Number(l.remaining_qty_kg || 0);
      totalKg += q;
      totalBags += Number(l.remaining_bags || 0);
      if (isPend) {
        hasPendingWeight = true;
        const pCost = Number(l.pending_cost_total || 0);
        pendingCostTotal += pCost;
        totalVal += pCost;
      } else {
        totalVal += q * Number(l.unit_cost_per_kg || 0);
      }
    }
    const avgCostPerKg = totalKg > 0 ? totalVal / totalKg : 0;
    return {
      totalKg: Number(totalKg.toFixed(2)),
      totalBags,
      hasPendingWeight,
      pendingCostTotal: Number(pendingCostTotal.toFixed(2)),
      avgCostPerKg: Number(avgCostPerKg.toFixed(4)),
    };
  }, [selectedPsLot, matchingPaddyLots]);

  const psTotalBags =
    Math.max(0, Math.round(Number(psForm.jute_bag_count || 0))) +
    Math.max(0, Math.round(Number(psForm.plastic_bag_count || 0)));
  const psNetSettleWeight = Math.max(0, Number((psForm.payment_weight_kg - psForm.weight_loss_kg).toFixed(3)));
  const psDivisor = psForm.settlement_unit_kg > 0 ? psForm.settlement_unit_kg : 75.5;
  const psSettlementUnits = Number((psNetSettleWeight / psDivisor).toFixed(4));
  const psTotalAmount = Number((psSettlementUnits * psForm.settlement_rate).toFixed(2));
  const psEffectiveRatePerKg =
    psForm.payment_weight_kg > 0 ? Number((psTotalAmount / psForm.payment_weight_kg).toFixed(4)) : 0;
  const psRemainingStockKg = Number((psGodownStats.totalKg - Number(psForm.qty_kg || 0)).toFixed(2));
  const psEstCogs = Number((Number(psForm.qty_kg || 0) * psGodownStats.avgCostPerKg).toFixed(2));
  const psEstMargin = Number((psTotalAmount - psEstCogs).toFixed(2));

  const handleSelectPsLot = (lotId: number) => {
    if (lotId <= 0) {
      setPsForm((prev) => ({ ...prev, preferred_lot_id: 0 }));
      return;
    }
    const lot = availablePaddyLots.find((l) => l.id === lotId);
    if (!lot) return;
    const itemDef = paddyItems.find((i) => i.id === lot.item_id);
    const nextRate = itemDef?.default_rate
      ? Number((itemDef.default_rate * psForm.settlement_unit_kg).toFixed(2))
      : psForm.settlement_rate;
    const isPending = Boolean(lot.weight_pending);
    const lotKg = Number(lot.remaining_qty_kg || 0);
    const lotBags = Math.max(0, Math.round(Number(lot.remaining_bags || 0)));
    setPsForm((prev) => ({
      ...prev,
      preferred_lot_id: lot.id,
      warehouse_id: lot.warehouse_id,
      item_id: lot.item_id,
      settlement_rate: nextRate,
      scale_weight_kg: !isPending && lotKg > 0 && prev.scale_weight_kg > lotKg ? lotKg : prev.scale_weight_kg,
      qty_kg: !isPending && lotKg > 0 && prev.qty_kg > lotKg ? lotKg : prev.qty_kg,
      payment_weight_kg: !isPending && lotKg > 0 && prev.payment_weight_kg > lotKg ? lotKg : prev.payment_weight_kg,
      // For unweighed lots, do not clamp bag counts downward because torn bags can increase exit bag count
      jute_bag_count:
        isPending && prev.jute_bag_count === 0 && prev.plastic_bag_count === 0
          ? lotBags
          : !isPending && lotBags > 0 && prev.jute_bag_count + prev.plastic_bag_count > lotBags
            ? lotBags
            : prev.jute_bag_count,
      close_pending_lot: true,
    }));
  };

  const handleCreatePaddySale = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!effectivePsCustomerId || !effectivePsWhId || !effectivePsItemId) {
      onNotify(
        isBn
          ? 'অন্তত একটি সক্রিয় ক্রেতা, গুদাম ও ধানের জাত নির্বাচন করুন।'
          : 'Select an active Buyer, Godown, and Paddy Variety first.',
        'err'
      );
      return;
    }
    if (psForm.qty_kg <= 0 || psNetSettleWeight <= 0 || psForm.settlement_rate <= 0) {
      onNotify(
        isBn
          ? 'বিক্রিত ওজন, নিট বিলিং ওজন (ওজন − বাদ) এবং ধানের দর শূন্যের বেশি হতে হবে।'
          : 'Delivered weight, net settlement weight (weight − deduction), and settlement rate must be greater than zero.',
        'err'
      );
      return;
    }

    setPsSubmitting(true);
    try {
      const res = await apiMutate({
        endpoint: '/api/v1/paddy-sales',
        payload: {
          customer_id: effectivePsCustomerId,
          warehouse_id: effectivePsWhId,
          item_id: effectivePsItemId,
          preferred_lot_id: psForm.preferred_lot_id > 0 ? psForm.preferred_lot_id : undefined,
          costing_method: psForm.costing_method,
          vehicle_no: psForm.vehicle_no,
          challan_no: psForm.challan_no,
          bag_count: psTotalBags,
          jute_bag_count: Math.max(0, Math.round(Number(psForm.jute_bag_count || 0))),
          plastic_bag_count: Math.max(0, Math.round(Number(psForm.plastic_bag_count || 0))),
          moisture_pct: psForm.moisture_pct,
          scale_weight_kg: psForm.scale_weight_kg,
          qty_kg: psForm.qty_kg,
          payment_weight_kg: psForm.payment_weight_kg,
          weight_loss_kg: psForm.weight_loss_kg,
          settlement_unit_kg: psDivisor,
          settlement_rate: psForm.settlement_rate,
          rate_per_kg: psEffectiveRatePerKg,
          paid_amount: psForm.paid_amount,
          close_pending_lot: selectedPsLot?.weight_pending ? psForm.close_pending_lot : undefined,
          notes: psForm.notes,
        },
        module: 'Direct Paddy Sale',
        summary: `Direct paddy sale ${psForm.qty_kg} kg (${psTotalBags} bags) · ৳${psTotalAmount.toLocaleString('en-IN')}`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: সরাসরি ধান বিক্রয় সিঙ্ক কিউতে জমা হয়েছে।' : 'Offline: Direct paddy sale queued for sync.', 'warn');
      } else {
        onNotify(
          isBn
            ? 'গুদাম থেকে ধান বাদ সহ বস্তা, ওজন ও সূত্র অনুযায়ী সরাসরি ধান বিক্রয় সম্পন্ন হয়েছে।'
            : 'Direct paddy sale completed; godown paddy stock deducted with bags & formula.',
          'ok'
        );
      }
      setShowPaddySaleForm(false);
      setPsForm((prev) => ({
        ...prev,
        preferred_lot_id: 0,
        vehicle_no: '',
        challan_no: '',
        jute_bag_count: 0,
        plastic_bag_count: 0,
        moisture_pct: 0,
        scale_weight_kg: 0,
        qty_kg: 0,
        payment_weight_kg: 0,
        weight_loss_kg: 0,
        paid_amount: 0,
        close_pending_lot: true,
        notes: '',
      }));
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setPsSubmitting(false);
    }
  };

  const openQr = async (code: string, uid: string) => {
    const dataUrl = await generateQrDataUrl(`SONAGRAIN|DISPATCH|${code}|${uid}`);
    setQrPreview({ code, dataUrl });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-xl w-full sm:w-auto overflow-x-auto">
          <button
            type="button"
            onClick={() => setSubTab('rice')}
            className={`flex-1 sm:flex-initial px-3.5 py-2 min-h-[40px] text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'rice' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {t('sales.tabRice')}
          </button>
          <button
            type="button"
            onClick={() => setSubTab('paddy')}
            className={`flex-1 sm:flex-initial px-3.5 py-2 min-h-[40px] text-xs font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'paddy' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {t('sales.tabPaddy')}
          </button>
        </div>

        {subTab === 'rice' ? (
          <button
            type="button"
            onClick={() => setShowInvForm(!showInvForm)}
            className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0 w-full sm:w-auto"
          >
            <Plus className="w-4 h-4" />
            <span>{showInvForm ? t('common.close') : t('sales.newInvoice')}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowPaddySaleForm(!showPaddySaleForm)}
            className="flex items-center justify-center gap-2 px-4 py-2.5 min-h-[44px] rounded-xl bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0 w-full sm:w-auto"
          >
            <Plus className="w-4 h-4" />
            <span>{showPaddySaleForm ? t('common.close') : t('sales.newPaddySale')}</span>
          </button>
        )}
      </div>

      {/* TAB 1: PRINCIPAL PRODUCTS & BY-PRODUCTS (BAG-BASED SELLING) */}
      {subTab === 'rice' && (
        <>
          {showInvForm && (
            <form
              onSubmit={handleCreateInvoice}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3 gap-2">
                <div>
                  <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                    {isBn ? 'প্রধান পণ্য ও উপজাত বিক্রয় (বস্তা আকারে)' : 'Principal Product & By-Product Sale (Bag-Based)'}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setInvLines((prev) => [...prev, makeDefaultLine()])}
                  className="inline-flex items-center gap-1 px-3 py-2 min-h-[40px] rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 text-amber-800 dark:text-amber-300 text-xs font-semibold"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>{isBn ? 'আরও পণ্য / উপজাত যোগ করুন' : 'Add Item / By-Product'}</span>
                </button>
              </div>

              {/* Customer, Vehicle, Paid, Discount */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">{t('sales.customer')}</label>
                  <select
                    value={effectiveInvCustomerId}
                    onChange={(e) => setInvHeader({ ...invHeader, customer_id: Number(e.target.value) })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('proc.vehicleNo')}</label>
                  <input
                    type="text"
                    placeholder=""
                    value={invHeader.vehicle_no}
                    onChange={(e) => setInvHeader({ ...invHeader, vehicle_no: e.target.value })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'নগদ / ব্যাংক প্রাপ্ত টাকা (৳)' : 'Paid Amount (৳)'}</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={invHeader.paid_amount}
                    onChange={(e) => setInvHeader({ ...invHeader, paid_amount: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'ডিসকাউন্ট / ছাড় (৳)' : 'Discount (৳)'}</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={invHeader.discount_amount}
                    onChange={(e) => setInvHeader({ ...invHeader, discount_amount: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              {/* Line Items */}
              <div className="space-y-3">
                {resolvedInvLines.map((line, idx) => {
                  const selectedLot = line.preferred_lot_id > 0 ? saleableLots.find((l) => l.id === line.preferred_lot_id) || null : null;
                  const lineTotal = Number((line.bag_count * line.rate_per_bag).toFixed(2));
                  const effectiveRatePerKg = line.qty_kg > 0 ? Number((lineTotal / line.qty_kg).toFixed(2)) : 0;
                  const estCost = selectedLot ? Number((line.qty_kg * Number(selectedLot.unit_cost_per_kg || 0)).toFixed(2)) : null;
                  const estProfit = estCost !== null ? Number((lineTotal - estCost).toFixed(2)) : null;

                  return (
                    <div
                      key={line.uid}
                      className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 p-3.5 space-y-3"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                          {isBn ? `পণ্য #${idx + 1}` : `Item #${idx + 1}`}
                        </span>
                        {resolvedInvLines.length > 1 && (
                          <button
                            type="button"
                            onClick={() => setInvLines((prev) => prev.filter((r) => r.uid !== line.uid))}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                          >
                            <Trash2 className="w-3.5 h-3.5" /> {isBn ? 'সরান' : 'Remove'}
                          </button>
                        )}
                      </div>

                      {/* Dryer Batch / Lot Picker */}
                      <div className="rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50/60 dark:bg-amber-950/25 p-2.5 grid grid-cols-1 md:grid-cols-3 gap-2.5 items-center">
                        <div className="md:col-span-2">
                          <label className="block text-[11px] font-semibold text-amber-900 dark:text-amber-300 mb-1">
                            {isBn
                              ? 'ডায়ার ব্যাচ / বস্তার সাইজ লট বাছাই (লাভ-লস ট্র্যাকিংয়ের জন্য)'
                              : 'Select Dryer Batch / Pack-Size Lot (For Per-Dryer P&L)'}
                          </label>
                          <select
                            value={line.preferred_lot_id}
                            onChange={(e) => handleSelectLineLot(line.uid, Number(e.target.value))}
                            className="w-full px-3 py-2 min-h-[42px] text-xs rounded-lg border border-amber-300 dark:border-amber-800 bg-white dark:bg-slate-950"
                          >
                            <option value={0}>{isBn ? 'স্বয়ংক্রিয় FIFO (নির্দিষ্ট লট ছাড়া)' : 'Automatic FIFO (No Specific Lot)'}</option>
                            {saleableLots.map((l) => {
                              const originBatchId =
                                l.origin_batch_id ?? (l.source_type === 'PRODUCTION_OUTPUT' && l.source_id ? Number(l.source_id) : null);
                              const batch = originBatchId ? batchById.get(Number(originBatchId)) : null;
                              const batchLabel = batch
                                ? `${batch.batch_no} (${batch.dryer_no || 'ডায়ার'})`
                                : l.origin_batch_no
                                ? `${l.origin_batch_no}${l.origin_dryer_no ? ` (${l.origin_dryer_no})` : ''}`
                                : null;
                              const packKg = Number(l.pack_size_kg || l.bag_weight_kg || 50);
                              const bagsLeft =
                                l.remaining_bags && Number(l.remaining_bags) > 0
                                  ? Number(l.remaining_bags)
                                  : Math.round(Number(l.remaining_qty_kg || 0) / packKg);
                              return (
                                <option key={l.id} value={l.id}>
                                  {l.item_name} ({packKg}kg/বস্তা) · {batchLabel ? `[ডায়ার: ${batchLabel}]` : l.lot_code} ·{' '}
                                  {bagsLeft}ব ({Number(l.remaining_qty_kg || 0).toLocaleString()} kg) · Cost ৳{Number(l.unit_cost_per_kg || 0).toFixed(2)}/kg
                                </option>
                              );
                            })}
                          </select>
                        </div>
                        {selectedLot && estProfit !== null ? (
                          <div className="bg-white dark:bg-slate-900 rounded-lg px-3 py-2 border border-amber-200 dark:border-amber-800 text-xs">
                            <div className="text-[10px] text-slate-500">
                              {isBn ? `লট খরচ: ৳${Number(selectedLot.unit_cost_per_kg || 0).toFixed(2)}/kg` : `Lot Cost: ৳${Number(selectedLot.unit_cost_per_kg || 0).toFixed(2)}/kg`}
                              {(selectedLot.origin_batch_no || selectedLot.origin_batch_id) && (
                                <span className="ml-1 font-semibold text-amber-700 dark:text-amber-300">
                                  · {selectedLot.origin_batch_no || batchById.get(Number(selectedLot.origin_batch_id))?.batch_no}
                                </span>
                              )}
                            </div>
                            <div className={`font-mono font-bold text-sm tabular-nums ${estProfit >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
                              {isBn ? 'লাভ/লস:' : 'Est. P&L:'} {estProfit >= 0 ? '+' : ''}৳{estProfit.toLocaleString('en-IN')}
                            </div>
                          </div>
                        ) : (
                          <div className="text-[11px] text-slate-500">
                            {isBn
                              ? 'লট বাছাই করলে সঠিক বস্তা ও ডায়ার ব্যাচের লাভ-লস হিসাব হবে।'
                              : 'Pick a lot for exact pack-size and per-dryer profit tracking.'}
                          </div>
                        )}
                      </div>

                      {/* Item / Godown / Costing + Bag Inputs */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end">
                        <div className="lg:col-span-2">
                          <label className="block text-xs font-medium mb-1">{t('sales.riceItem')}</label>
                          <select
                            value={line.item_id}
                            onChange={(e) => {
                              const it = riceAndByproductItems.find((x) => x.id === Number(e.target.value));
                              const packKg = Number(it?.bag_weight_kg || 50) || 50;
                              const perKg = Number(it?.default_rate || 40);
                              const nextWh =
                                it?.category === 'HEAD_RICE'
                                  ? warehouses.find((w) => w.warehouse_type === 'FINISHED_RICE')?.id || line.warehouse_id
                                  : warehouses.find((w) => w.warehouse_type === 'BY_PRODUCT')?.id || line.warehouse_id;
                              updateInvLine(line.uid, (prev) => ({
                                ...prev,
                                preferred_lot_id: 0,
                                item_id: Number(e.target.value),
                                warehouse_id: nextWh,
                                pack_size_kg: packKg,
                                qty_kg: Number((prev.bag_count * packKg).toFixed(2)),
                                rate_per_bag: Number((perKg * packKg).toFixed(2)),
                              }));
                            }}
                            className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          >
                            {riceAndByproductItems.map((i) => (
                              <option key={i.id} value={i.id}>
                                {i.name} ({i.bag_weight_kg || 50}kg)
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="block text-xs font-medium mb-1">{t('sales.dispatchGodown')}</label>
                          <select
                            value={line.warehouse_id}
                            onChange={(e) =>
                              updateInvLine(line.uid, (prev) => ({
                                ...prev,
                                preferred_lot_id: 0,
                                warehouse_id: Number(e.target.value),
                              }))
                            }
                            className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          >
                            {warehouses.map((w) => (
                              <option key={w.id} value={w.id}>
                                {w.name}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label className="block text-xs font-medium mb-1">
                            {isBn ? 'বস্তার সংখ্যা *' : 'Bag Count *'}
                          </label>
                          <input
                            type="number"
                            min="1"
                            step="1"
                            required
                            value={line.bag_count}
                            onChange={(e) => {
                              const bags = Math.max(0, Math.round(Number(e.target.value)));
                              updateInvLine(line.uid, (prev) => ({
                                ...prev,
                                bag_count: bags,
                                qty_kg: Number((bags * prev.pack_size_kg).toFixed(2)),
                              }));
                            }}
                            className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-medium mb-1">
                            {isBn ? 'প্রতি বস্তা (কেজি)' : 'Kg / Bag'}
                          </label>
                          <input
                            type="number"
                            min="0.5"
                            step="0.5"
                            required
                            value={line.pack_size_kg}
                            onChange={(e) => {
                              const pack = Math.max(0.5, Number(e.target.value));
                              updateInvLine(line.uid, (prev) => ({
                                ...prev,
                                pack_size_kg: pack,
                                qty_kg: Number((prev.bag_count * pack).toFixed(2)),
                              }));
                            }}
                            className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          />
                        </div>

                        <div>
                          <label className="block text-xs font-medium mb-1">
                            {isBn ? 'দর (৳ / বস্তা) *' : 'Rate (৳ / Bag) *'}
                          </label>
                          <input
                            type="number"
                            min="1"
                            step="0.01"
                            required
                            value={line.rate_per_bag}
                            onChange={(e) =>
                              updateInvLine(line.uid, (prev) => ({
                                ...prev,
                                rate_per_bag: Math.max(0, Number(e.target.value)),
                              }))
                            }
                            className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono font-semibold rounded-lg border border-amber-400 dark:border-amber-700 bg-white dark:bg-slate-950"
                          />
                        </div>
                      </div>

                      {/* Line Weight & Exact Total Bar */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200 dark:border-slate-800 text-xs">
                        <div className="flex flex-wrap items-center gap-3">
                          <div className="flex items-center gap-1.5">
                            <span className="text-slate-500">{isBn ? 'মোট ওজন (কেজি):' : 'Total Weight (kg):'}</span>
                            <input
                              type="number"
                              min="0.01"
                              step="0.01"
                              value={line.qty_kg}
                              onChange={(e) =>
                                updateInvLine(line.uid, (prev) => ({
                                  ...prev,
                                  qty_kg: Math.max(0, Number(e.target.value)),
                                }))
                              }
                              className="w-24 px-2 py-1 font-mono text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                            />
                          </div>
                          <span className="font-mono text-slate-500">
                            ({isBn ? 'কার্যকর:' : 'Eff:'} ৳{effectiveRatePerKg.toFixed(2)}/{t('common.kg')})
                          </span>
                          <select
                            value={line.costing_method}
                            onChange={(e) =>
                              updateInvLine(line.uid, (prev) => ({
                                ...prev,
                                costing_method: e.target.value as CostingMethod,
                              }))
                            }
                            className="px-2 py-1 text-[11px] rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                          >
                            <option value="FIFO">FIFO</option>
                            <option value="WEIGHTED_AVERAGE">Weighted Avg</option>
                          </select>
                        </div>
                        <div className="font-mono font-bold text-sm tabular-nums text-slate-900 dark:text-white">
                          {line.bag_count} × ৳{line.rate_per_bag.toLocaleString('en-IN')} = ৳{lineTotal.toLocaleString('en-IN')}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                <div className="text-xs text-slate-600 dark:text-slate-300 font-mono tabular-nums">
                  {isBn
                    ? `মোট: ${invTotals.totalBags} বস্তা · ${invTotals.totalKg.toLocaleString()} কেজি · বিল: ৳${invTotals.netTotal.toLocaleString('en-IN')}`
                    : `Total: ${invTotals.totalBags} bags · ${invTotals.totalKg.toLocaleString()} kg · Net: ৳${invTotals.netTotal.toLocaleString('en-IN')}`}
                </div>
                <button
                  type="submit"
                  disabled={invSubmitting}
                  className="px-5 py-2.5 min-h-[44px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold disabled:opacity-50 w-full sm:w-auto"
                >
                  {invSubmitting
                    ? t('common.saving')
                    : `${t('sales.issueInvoice')} (৳${invTotals.netTotal.toLocaleString('en-IN')})`}
                </button>
              </div>
            </form>
          )}

          {/* Mobile Cards for Sales Invoices (md:hidden) */}
          <div className="md:hidden space-y-3">
            {invoices.length === 0 ? (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-8 text-center text-xs text-slate-500">
                {isBn ? 'এখনো কোনো বিক্রয় চালান তৈরি হয়নি।' : 'No sales invoices issued yet.'}
              </div>
            ) : (
              invoices.map((inv) => {
                const margin = inv.total_amount - inv.total_cogs;
                return (
                  <div key={inv.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-mono text-xs font-semibold text-slate-900 dark:text-white">{inv.invoice_no}</div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">{inv.customer_name}</div>
                        <div className="text-xs text-slate-500 mt-0.5 space-y-0.5">
                          {inv.items.map((l, idx) => (
                            <div key={idx}>
                              {l.item_name}:{' '}
                              {Number(l.bag_count || 0) > 0
                                ? `${l.bag_count} ${isBn ? 'বস্তা' : 'bags'} × ${l.pack_size_kg || 50}kg (${l.qty_kg}kg)`
                                : `${l.qty_kg} ${t('common.kg')}`}
                              {Number(l.rate_per_bag || 0) > 0 ? ` @ ৳${Number(l.rate_per_bag).toLocaleString('en-IN')}/বস্তা` : ''}
                            </div>
                          ))}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                          ৳{inv.total_amount.toLocaleString('en-IN')}
                        </div>
                        <div className="font-mono text-[11px] tabular-nums text-emerald-700 dark:text-emerald-400 font-semibold">
                          +{isBn ? 'লাভ' : 'Margin'} ৳{margin.toLocaleString('en-IN')}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">{inv.payment_status}</div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => openQr(inv.invoice_no, inv.qr_code_uid)}
                        className="flex items-center justify-center gap-1 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium"
                      >
                        <QrCode className="w-3.5 h-3.5" /> QR
                      </button>
                      <button
                        type="button"
                        onClick={() => exportSalesInvoicePdf(inv, 'en', 'open')}
                        className="flex items-center justify-center gap-1 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium"
                      >
                        <Eye className="w-3.5 h-3.5" /> EN
                      </button>
                      <button
                        type="button"
                        onClick={() => exportSalesInvoicePdf(inv, 'bn', 'open')}
                        className="flex items-center justify-center gap-1 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium"
                      >
                        <Eye className="w-3.5 h-3.5" /> বাংলা
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Desktop Table for Sales Invoices (hidden md:block) */}
          <div className="hidden md:block bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <th className="text-left px-4 py-3 font-medium">{t('sales.invoiceNo')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('sales.customerItems')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('sales.total')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('sales.cogs')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('sales.margin')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('common.status')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {invoices.map((inv) => {
                    const margin = inv.total_amount - inv.total_cogs;
                    return (
                      <tr key={inv.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="px-4 py-3 font-mono font-medium">{inv.invoice_no}</td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-900 dark:text-white">{inv.customer_name}</div>
                          <div className="text-slate-500">
                            {inv.items
                              .map((l) =>
                                Number(l.bag_count || 0) > 0
                                  ? `${l.item_name} (${l.bag_count}ব × ${l.pack_size_kg || 50}kg = ${l.qty_kg}kg${
                                      Number(l.rate_per_bag || 0) > 0 ? ` @ ৳${Number(l.rate_per_bag).toLocaleString('en-IN')}/ব` : ''
                                    })`
                                  : `${l.item_name} (${l.qty_kg} ${t('common.kg')})`
                              )
                              .join(', ')}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums font-medium">
                          ৳{inv.total_amount.toLocaleString('en-IN')}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-500">
                          ৳{inv.total_cogs.toLocaleString('en-IN')}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400 font-medium">
                          ৳{margin.toLocaleString('en-IN')}
                        </td>
                        <td className="px-4 py-3 font-mono">{inv.payment_status}</td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => openQr(inv.invoice_no, inv.qr_code_uid)}
                              className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                              title={t('sales.gatePassTitle')}
                            >
                              <QrCode className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => exportSalesInvoicePdf(inv, 'en', 'open')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                              title={isBn ? 'নতুন ট্যাবে ইংরেজি চালান PDF দেখুন' : 'View English Challan PDF in new tab'}
                            >
                              <Eye className="w-3 h-3" /> {isBn ? 'চালান EN' : 'View EN'}
                            </button>
                            <button
                              type="button"
                              onClick={() => exportSalesInvoicePdf(inv, 'bn', 'open')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                              title={isBn ? 'নতুন ট্যাবে বাংলা চালান PDF দেখুন' : 'View Bangla Challan PDF in new tab'}
                            >
                              <Eye className="w-3 h-3" /> {isBn ? 'চালান বাংলা' : 'View বাংলা'}
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* TAB 2: DIRECT PADDY SALES (MIRRORING PADDY PURCHASE WORKFLOW) */}
      {subTab === 'paddy' && (
        <div className="space-y-4">
          {showPaddySaleForm && (
            <form
              onSubmit={handleCreatePaddySale}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 space-y-5"
            >
              <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3 gap-2">
                <div>
                  <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                    {isBn ? 'সরাসরি ধান বিক্রয় — ওজন, বস্তা ও সূত্র এন্ট্রি' : 'Direct Paddy Sale — Weights, Bags & Formula Entry'}
                  </h3>
                </div>
                <div className="text-right font-mono text-xs shrink-0">
                  <div className="text-slate-500">{isBn ? 'বস্তা' : 'Bags'}</div>
                  <div className="font-semibold text-amber-700 dark:text-amber-400 tabular-nums">
                    {psTotalBags.toLocaleString('en-IN')} {isBn ? 'টি' : 'bags'}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div>
                  <label className="block text-xs font-medium mb-1">{t('sales.buyer')}</label>
                  <select
                    value={effectivePsCustomerId}
                    onChange={(e) => setPsForm({ ...psForm, customer_id: Number(e.target.value) })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.party_code})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('sales.sourceGodown')}</label>
                  <select
                    value={effectivePsWhId}
                    onChange={(e) => setPsForm({ ...psForm, warehouse_id: Number(e.target.value), preferred_lot_id: 0 })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name} ({w.code})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('proc.paddyVariety')}</label>
                  <select
                    value={effectivePsItemId}
                    onChange={(e) => {
                      const it = paddyItems.find((x) => x.id === Number(e.target.value));
                      const nextRate = it?.default_rate
                        ? Number((it.default_rate * psForm.settlement_unit_kg).toFixed(2))
                        : psForm.settlement_rate;
                      setPsForm({ ...psForm, item_id: Number(e.target.value), preferred_lot_id: 0, settlement_rate: nextRate });
                    }}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {paddyItems.length === 0 ? (
                      <option value={0}>{t('proc.noPaddy')}</option>
                    ) : (
                      paddyItems.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name} ({i.costing_method})
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('inv.costingMethod')}</label>
                  <select
                    value={psForm.costing_method}
                    onChange={(e) => setPsForm({ ...psForm, costing_method: e.target.value as CostingMethod })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="FIFO">FIFO</option>
                    <option value="WEIGHTED_AVERAGE">Weighted Average</option>
                  </select>
                </div>
              </div>

              {/* Paddy Lot Picker & Live Godown Stock Deduction Bar */}
              <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/50 dark:bg-amber-950/20 p-3.5 grid grid-cols-1 md:grid-cols-3 gap-3 items-center">
                <div className="md:col-span-2">
                  <label className="block text-[11px] font-semibold text-amber-900 dark:text-amber-300 mb-1">
                    {isBn
                      ? 'গুদামের ধানের লট বাছাই (বিক্রিতে এই লট / গুদাম থেকে ধান বাদ যাবে)'
                      : 'Paddy Lot Selection (Deducted from Godown Stock)'}
                  </label>
                  <select
                    value={psForm.preferred_lot_id}
                    onChange={(e) => handleSelectPsLot(Number(e.target.value))}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-amber-300 dark:border-amber-800 bg-white dark:bg-slate-950"
                  >
                    <option value={0}>
                      {isBn
                        ? `স্বয়ংক্রিয় FIFO (${matchingPaddyLots.length}টি লট · ${psGodownStats.totalKg.toLocaleString()} কেজি মজুদ)`
                        : `Auto FIFO (${matchingPaddyLots.length} lots · ${psGodownStats.totalKg.toLocaleString()} kg in godown)`}
                    </option>
                    {availablePaddyLots.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.weight_pending
                          ? `${l.lot_code} · ${l.item_name} (${l.warehouse_name}) · [${isBn ? 'ওজন পেন্ডিং' : 'Pending Wt'} · ${Number(
                              l.remaining_bags || 0
                            )}ব জমা · ব্যয় ৳${Number(l.pending_cost_total || 0).toLocaleString('en-IN')}]`
                          : `${l.lot_code} · ${l.item_name} (${l.warehouse_name}) · ${Number(l.remaining_qty_kg || 0).toLocaleString()} kg (${Number(
                              l.remaining_bags || 0
                            )}ব) · Cost ৳${Number(l.unit_cost_per_kg || 0).toFixed(2)}/kg`}
                      </option>
                    ))}
                  </select>
                  {selectedPsLot?.weight_pending && (
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] bg-white/80 dark:bg-slate-900/80 border border-amber-200 dark:border-amber-800 rounded-lg px-2.5 py-1.5">
                      <label className="inline-flex items-center gap-1.5 cursor-pointer select-none font-medium text-slate-700 dark:text-slate-200">
                        <input
                          type="checkbox"
                          checked={psForm.close_pending_lot}
                          onChange={(e) => setPsForm({ ...psForm, close_pending_lot: e.target.checked })}
                          className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                        />
                        <span>
                          {isBn
                            ? 'বিক্রির পর লটটি সম্পূর্ণ শেষ/ক্লোজ করুন (আরও ছেঁড়া বস্তা বাকি থাকলে আনচেক রাখুন)'
                            : 'Close pending lot after this sale (uncheck if more torn bags remain)'}
                        </span>
                      </label>
                      {psTotalBags > Number(selectedPsLot.remaining_bags || 0) && (
                        <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                          {isBn
                            ? `জমার চেয়ে +${psTotalBags - Number(selectedPsLot.remaining_bags || 0)}টি বেশি বস্তা (বস্তা ছিঁড়ে যাওয়ায় অনুমোদিত)`
                            : `+${psTotalBags - Number(selectedPsLot.remaining_bags || 0)} extra bags (torn/re-bagged allowed)`}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="rounded-lg bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-800 px-3 py-2 text-xs space-y-0.5">
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span>{isBn ? 'বর্তমান মজুদ:' : 'Current Stock:'}</span>
                    <span className="font-mono font-semibold text-slate-800 dark:text-slate-200 tabular-nums">
                      {selectedPsLot?.weight_pending
                        ? `${psGodownStats.totalBags}ব (${isBn ? 'ওজন পেন্ডিং' : 'Wt Pending'})`
                        : `${psGodownStats.totalKg.toLocaleString()} kg (${psGodownStats.totalBags}ব)`}
                    </span>
                  </div>
                  {selectedPsLot?.weight_pending ? (
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-500">{isBn ? 'সংরক্ষিত ব্যয় (Cost Pool):' : 'Pending Cost Pool:'}</span>
                      <span className="font-mono font-bold text-amber-700 dark:text-amber-400 tabular-nums">
                        ৳{psGodownStats.pendingCostTotal.toLocaleString('en-IN')}
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-slate-500">{isBn ? 'বাদ যাওয়ার পর অবশিষ্ট:' : 'After Deduction:'}</span>
                        <span
                          className={`font-mono font-bold tabular-nums ${
                            psRemainingStockKg < 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400'
                          }`}
                        >
                          {psRemainingStockKg.toLocaleString()} kg
                        </span>
                      </div>
                      {psRemainingStockKg < 0 && !psGodownStats.hasPendingWeight && (
                        <div className="text-[10px] font-medium text-red-600 dark:text-red-400">
                          {isBn ? 'সতর্কতা: গুদামে পর্যাপ্ত ধান মজুদ নেই!' : 'Warning: Exceeds available godown stock!'}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Weight Grid */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {isBn ? 'ওয়েব্রিজ স্কেল ওজন (কেজি)' : 'Scale Weight (kg)'}
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={psForm.scale_weight_kg}
                    onChange={(e) => setPsForm({ ...psForm, scale_weight_kg: Number(e.target.value) })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {isBn ? 'গুদাম থেকে বাদ / ডেলিভারি ওজন (কেজি) *' : 'Stock Deducted / Delivered Wt (kg) *'}
                  </label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={psForm.qty_kg}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      setPsForm((prev) => ({
                        ...prev,
                        qty_kg: val,
                        payment_weight_kg: prev.payment_weight_kg === prev.qty_kg ? val : prev.payment_weight_kg,
                      }));
                    }}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {isBn ? 'হিসাবের ওজন / সেটেলমেন্ট ওজন (কেজি) *' : 'Gross Billing Weight (kg) *'}
                  </label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={psForm.payment_weight_kg}
                    onChange={(e) => setPsForm({ ...psForm, payment_weight_kg: Number(e.target.value) })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                </div>
              </div>

              {/* Settlement Formula Box: (ওজন - বাদ) / ৭৫.৫ * দর */}
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4 p-4 rounded-lg bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50">
                <div>
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                      {isBn ? 'বাদ (ধান/বস্তা/ঘাটতি — কেজি)' : 'Deduction / বাদ (kg)'}
                    </label>
                    <div className="flex items-center gap-1">
                      {psTotalBags > 0 && (
                        <button
                          type="button"
                          onClick={() => setPsForm({ ...psForm, weight_loss_kg: psTotalBags })}
                          className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-[10px] font-semibold text-amber-800 dark:text-amber-300 hover:bg-amber-200"
                          title={isBn ? 'প্রতি বস্তা ১ কেজি হারে বাদ বসান' : 'Set 1 kg per bag deduction'}
                        >
                          = {isBn ? `${psTotalBags} বস্তা` : `${psTotalBags}b`}
                        </button>
                      )}
                      {psForm.weight_loss_kg > 0 && (
                        <button
                          type="button"
                          onClick={() => setPsForm({ ...psForm, weight_loss_kg: 0 })}
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
                    value={psForm.weight_loss_kg}
                    onChange={(e) => setPsForm({ ...psForm, weight_loss_kg: Math.max(0, Number(e.target.value)) })}
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
                    value={psForm.settlement_unit_kg}
                    onChange={(e) => setPsForm({ ...psForm, settlement_unit_kg: Number(e.target.value) })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {t('proc.ratePerUnit', { unit: psDivisor })}
                  </label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={psForm.settlement_rate}
                    onChange={(e) => setPsForm({ ...psForm, settlement_rate: Number(e.target.value) })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
                    {isBn ? 'নগদ / ব্যাংক প্রাপ্ত টাকা (৳)' : 'Cash Received Now (৳)'}
                  </label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={psForm.paid_amount}
                    onChange={(e) => setPsForm({ ...psForm, paid_amount: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                </div>

                <div className="sm:col-span-2 md:col-span-4 flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-amber-200/70 dark:border-amber-900/40 text-xs font-mono">
                  <div className="text-slate-700 dark:text-slate-300">
                    {isBn ? 'হিসাব: (ওজন − বাদ) ÷' : 'Formula: (Wt − Ded) ÷'} {psDivisor} × {isBn ? 'দর' : 'Rate'} = ({psForm.payment_weight_kg.toLocaleString()} −{' '}
                    {psForm.weight_loss_kg.toLocaleString()}) / {psDivisor} × ৳{psForm.settlement_rate.toLocaleString()} ={' '}
                    <span className="font-semibold text-slate-900 dark:text-white">
                      {psSettlementUnits.toFixed(4)} {t('proc.units')} ({psNetSettleWeight.toLocaleString()} {t('common.kg')} {t('proc.net')})
                    </span>
                  </div>
                  <div className="text-slate-500">
                    {t('proc.effectiveRate')}: <span className="font-semibold text-slate-800 dark:text-slate-200">৳{psEffectiveRatePerKg.toFixed(4)}/{t('common.kg')}</span>
                  </div>
                </div>
              </div>

              {/* Logistics & Bags Row */}
              <div className="grid grid-cols-2 md:grid-cols-6 gap-4 items-end">
                <div>
                  <label className="block text-xs font-medium mb-1">{t('proc.vehicleNo')}</label>
                  <input
                    type="text"
                    value={psForm.vehicle_no}
                    onChange={(e) => setPsForm({ ...psForm, vehicle_no: e.target.value })}
                    placeholder=""
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('proc.challanNo')}</label>
                  <input
                    type="text"
                    value={psForm.challan_no}
                    onChange={(e) => setPsForm({ ...psForm, challan_no: e.target.value })}
                    placeholder=""
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'চট বস্তা' : 'Jute Bags'}</label>
                  <input
                    type="number"
                    min="0"
                    value={psForm.jute_bag_count}
                    onChange={(e) => setPsForm({ ...psForm, jute_bag_count: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'প্লাস্টিক বস্তা' : 'Plastic Bags'}</label>
                  <input
                    type="number"
                    min="0"
                    value={psForm.plastic_bag_count}
                    onChange={(e) => setPsForm({ ...psForm, plastic_bag_count: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'মোট বস্তা' : 'Total Bags'}</label>
                  <div className="w-full px-3 py-2.5 min-h-[44px] flex items-center text-xs font-mono font-semibold rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 tabular-nums">
                    {psTotalBags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('proc.moisture')}</label>
                  <input
                    type="number"
                    step="0.1"
                    value={psForm.moisture_pct}
                    onChange={(e) => setPsForm({ ...psForm, moisture_pct: Number(e.target.value) })}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium mb-1">{isBn ? 'নোট / বিবরণ' : 'Notes / Remarks'}</label>
                  <input
                    type="text"
                    value={psForm.notes}
                    onChange={(e) => setPsForm({ ...psForm, notes: e.target.value })}
                    placeholder={isBn ? 'সরাসরি ধান বিক্রয় সংক্রান্ত নোট...' : 'Optional direct paddy sale remarks...'}
                    className="w-full px-3 py-2.5 min-h-[44px] text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="text-xs">
                    <span className="text-slate-500">{isBn ? 'সর্বমোট বিল:' : 'Total Bill:'}</span>
                    <div className="font-mono font-bold text-base tabular-nums text-slate-900 dark:text-white">
                      ৳{psTotalAmount.toLocaleString('en-IN')}
                    </div>
                    {psGodownStats.avgCostPerKg > 0 && (
                      <div
                        className={`font-mono text-[11px] tabular-nums ${
                          psEstMargin >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                        }`}
                      >
                        {isBn ? 'আনু. লাভ:' : 'Est. P&L:'} {psEstMargin >= 0 ? '+' : ''}৳{psEstMargin.toLocaleString('en-IN')}
                      </div>
                    )}
                  </div>
                  <button
                    type="submit"
                    disabled={psSubmitting}
                    className="px-5 py-2.5 min-h-[44px] rounded-xl bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold disabled:opacity-50 whitespace-nowrap w-full sm:w-auto"
                  >
                    {psSubmitting ? t('common.saving') : t('sales.completeDirectSale')}
                  </button>
                </div>
              </div>
            </form>
          )}

          {/* Mobile Cards for Direct Paddy Sales (md:hidden) */}
          <div className="md:hidden space-y-3">
            {paddySales.length === 0 ? (
              <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl px-4 py-8 text-center text-xs text-slate-500">
                {t('sales.noDirectSales')}
              </div>
            ) : (
              paddySales.map((s) => {
                const div = Number(s.settlement_unit_kg || 75.5);
                const sRate = Number(s.settlement_rate || Number((s.rate_per_kg * div).toFixed(2)));
                const margin = s.total_amount - s.cogs_amount;
                return (
                  <div key={s.id} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-mono text-xs font-semibold text-slate-900 dark:text-white">{s.sale_no}</div>
                        <div className="text-sm font-semibold text-slate-900 dark:text-white">{s.customer_name}</div>
                        <div className="text-xs text-slate-500">
                          {s.item_name} ({s.warehouse_name})
                        </div>
                        <div className="text-[11px] font-mono text-amber-700 dark:text-amber-400 mt-0.5">
                          {Number(s.bag_count || 0) > 0 ? `${s.bag_count} ${isBn ? 'বস্তা' : 'bags'} · ` : ''}
                          {s.qty_kg.toLocaleString()} kg
                          {Number(s.extra_torn_bags || 0) > 0 && (
                            <span className="ml-1.5 px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 font-sans text-[10px] font-semibold">
                              +{Number(s.extra_torn_bags)} {isBn ? 'ছেঁড়া' : 'torn'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono text-sm font-bold tabular-nums text-slate-900 dark:text-white">
                          ৳{s.total_amount.toLocaleString('en-IN')}
                        </div>
                        <div className="font-mono text-[11px] tabular-nums text-slate-500">
                          ৳{sRate.toLocaleString('en-IN')}/{div}kg
                        </div>
                        <div className={`font-mono text-[11px] font-semibold tabular-nums ${margin >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600'}`}>
                          {margin >= 0 ? '+' : ''}৳{margin.toLocaleString('en-IN')}
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-3 gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => openQr(s.sale_no, s.qr_code_uid)}
                        className="flex items-center justify-center gap-1 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium"
                      >
                        <QrCode className="w-3.5 h-3.5" /> QR
                      </button>
                      <button
                        type="button"
                        onClick={() => exportDirectPaddySalePdf(s, 'en', 'open')}
                        className="flex items-center justify-center gap-1 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium"
                      >
                        <Eye className="w-3.5 h-3.5" /> EN
                      </button>
                      <button
                        type="button"
                        onClick={() => exportDirectPaddySalePdf(s, 'bn', 'open')}
                        className="flex items-center justify-center gap-1 min-h-[44px] rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-medium"
                      >
                        <Eye className="w-3.5 h-3.5" /> বাংলা
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Desktop Table for Direct Paddy Sales (hidden md:block) */}
          <div className="hidden md:block bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <th className="text-left px-4 py-3 font-medium">{t('sales.saleNo')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('sales.buyer')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('sales.varietyGodown')}</th>
                    <th className="text-right px-4 py-3 font-medium">{isBn ? 'ওজন ও বস্তা' : 'Weight & Bags'}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('proc.thRateDiv')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('sales.total')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('sales.cogs')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {paddySales.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                        {t('sales.noDirectSales')}
                      </td>
                    </tr>
                  ) : (
                    paddySales.map((s) => {
                      const unitDiv = Number(s.settlement_unit_kg || 75.5);
                      const unitRate = Number(s.settlement_rate || Number((s.rate_per_kg * unitDiv).toFixed(2)));
                      const loss = Number(s.weight_loss_kg || 0);
                      const payWt = Number(s.payment_weight_kg || s.qty_kg || 0);
                      const netWt = Math.max(0, Number((payWt - loss).toFixed(2)));
                      return (
                        <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="px-4 py-3">
                            <div className="font-mono font-medium">{s.sale_no}</div>
                            <div className="text-[11px] text-slate-500">
                              {s.vehicle_no || t('common.none')}
                              {s.moisture_pct ? ` · ${s.moisture_pct}% MC` : ''}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-900 dark:text-white">{s.customer_name}</div>
                            <div className="text-[11px] text-slate-500">{s.payment_status}</div>
                          </td>
                          <td className="px-4 py-3">
                            <div>{s.item_name}</div>
                            <div className="text-[11px] text-slate-500">{s.warehouse_name}</div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            <div className="font-medium">{s.qty_kg.toLocaleString()} kg</div>
                            <div className="text-[11px] text-amber-700 dark:text-amber-400">
                              {Number(s.bag_count || 0) > 0 ? `${s.bag_count} ${isBn ? 'বস্তা' : 'bags'}` : ''}
                              {Number(s.extra_torn_bags || 0) > 0 ? ` (+${Number(s.extra_torn_bags)} ${isBn ? 'ছেঁড়া' : 'torn'})` : ''}
                              {loss > 0 ? `${Number(s.bag_count || 0) > 0 ? ' · ' : ''}${isBn ? 'বাদ' : 'Ded'} −${loss} (${isBn ? 'নিট' : 'Net'} ${netWt} kg)` : ''}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            <div>৳{unitRate.toLocaleString('en-IN')}</div>
                            <div className="text-[11px] text-slate-500">/{unitDiv} {t('common.kg')}</div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums font-medium">
                            ৳{s.total_amount.toLocaleString('en-IN')}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-500">
                            ৳{s.cogs_amount.toLocaleString('en-IN')}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => openQr(s.sale_no, s.qr_code_uid)}
                                className="p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
                                title={t('sales.gatePassTitle')}
                              >
                                <QrCode className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => exportDirectPaddySalePdf(s, 'en', 'open')}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                                title={isBn ? 'নতুন ট্যাবে ইংরেজি চালান PDF দেখুন' : 'View English Challan PDF in new tab'}
                              >
                                <Eye className="w-3 h-3" /> {isBn ? 'চালান EN' : 'View EN'}
                              </button>
                              <button
                                type="button"
                                onClick={() => exportDirectPaddySalePdf(s, 'bn', 'open')}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-[11px] font-medium whitespace-nowrap shrink-0"
                                title={isBn ? 'নতুন ট্যাবে বাংলা চালান PDF দেখুন' : 'View Bangla Challan PDF in new tab'}
                              >
                                <Eye className="w-3 h-3" /> {isBn ? 'চালান বাংলা' : 'View বাংলা'}
                              </button>
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
        </div>
      )}

      {qrPreview && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/50 p-0 sm:p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-t-2xl sm:rounded-xl p-6 max-w-xs w-full text-center space-y-3">
            <h4 className="text-sm font-display font-semibold">
              {t('sales.gatePassTitle')} — {qrPreview.code}
            </h4>
            <img src={qrPreview.dataUrl} alt={`QR ${qrPreview.code}`} className="mx-auto rounded-lg border border-slate-200" />
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
    </div>
  );
};
