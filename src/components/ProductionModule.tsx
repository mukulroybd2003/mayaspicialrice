import React, { useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Coins,
  Eye,
  FileText,
  Flame,
  History,
  Layers,
  PackagePlus,
  Plus,
  Receipt,
  Search,
  Sun,
  Trash2,
  TrendingDown,
  TrendingUp,
  Wallet,
  Wind,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { apiMutate } from '../services/api';
import type {
  Account,
  ChatalBatch,
  CostingMethod,
  DryingBatch,
  InventoryLot,
  ItemMaster,
  PaddyPurchase,
  Party,
  ProcessType,
  ProductCategory,
  ProductionBatch,
  ProductionBatchExpense,
  ProductionExpensePayment,
  Warehouse,
} from '../types/erp';
import { isHeadRiceItem, isPaddyItem } from '../utils/itemFilters';
import { exportBatchCostSheetPdf, exportExpensePaymentReceiptPdf } from '../utils/reports';
import { ChatalKhamalPanel } from './ChatalKhamalPanel';

interface ProductionModuleProps {
  batches: ProductionBatch[];
  dryingBatches: DryingBatch[];
  chatalBatches?: ChatalBatch[];
  warehouses: Warehouse[];
  items: ItemMaster[];
  categories?: ProductCategory[];
  lots?: InventoryLot[];
  purchases?: PaddyPurchase[];
  accounts?: Account[];
  customers?: Party[];
  initialSubTab?: 'milling' | 'chatal' | 'drying';
  initialDryingView?: 'all' | 'active' | 'history';
  navTriggerKey?: number;
  onRefresh: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

interface SecondaryOutputDraft {
  uid: string;
  item_id: number; // 0 means custom item name
  custom_name: string;
  category: string;
  pack_size_kg: number;
  bag_count: number;
  qty_kg: number;
  rate_per_kg: number;
  rate_per_bag: number;
  pricing_unit: 'BAG' | 'KG';
  warehouse_id: number;
}

type ExpensePurposeKey =
  | 'LABOR'
  | 'ELECTRICITY'
  | 'FUEL_BOILER'
  | 'MACHINERY'
  | 'PACKAGING'
  | 'TRANSPORT'
  | 'OTHER';

const EXPENSE_PURPOSES: Array<{ key: ExpensePurposeKey; bn: string; en: string }> = [
  { key: 'LABOR', bn: 'শ্রমিক / লেবার মজুরি', en: 'Labor / Coolie Wages' },
  { key: 'ELECTRICITY', bn: 'বিদ্যুৎ ও পাওয়ার বিল', en: 'Electricity & Power' },
  { key: 'FUEL_BOILER', bn: 'বয়লার / জ্বালানি / তুষ / ডিজেল', en: 'Boiler / Fuel / Diesel' },
  { key: 'MACHINERY', bn: 'মেশিনারি / মিল মেরামত', en: 'Machinery & Mill Overhead' },
  { key: 'PACKAGING', bn: 'বস্তা / প্যাকেজিং / সুতা', en: 'Packaging & Bags' },
  { key: 'TRANSPORT', bn: 'পরিবহন / গাড়ি ভাড়া', en: 'Transport & Carrying' },
  { key: 'OTHER', bn: 'অন্যান্য মিলিং খরচ', en: 'Other Milling Expense' },
];

const parseDbDate = (raw?: string | null): Date | null => {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  const dt = new Date(normalized);
  if (!Number.isNaN(dt.getTime())) return dt;
  const fallback = new Date(trimmed);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
};

const getInventoryAgeDays = (raw?: string | null): number => {
  const dt = parseDbDate(raw);
  if (!dt) return 0;
  return Math.max(0, Math.floor((Date.now() - dt.getTime()) / 86400000));
};

const formatShortDbDate = (raw?: string | null, isBn = false): string => {
  const dt = parseDbDate(raw);
  if (!dt) return '—';
  return dt.toLocaleDateString(isBn ? 'bn-BD' : 'en-GB', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  });
};

export const ProductionModule: React.FC<ProductionModuleProps> = ({
  batches,
  dryingBatches,
  chatalBatches = [],
  warehouses,
  items,
  categories = [],
  lots = [],
  purchases = [],
  accounts = [],
  customers = [],
  initialSubTab,
  initialDryingView,
  navTriggerKey,
  onRefresh,
  onNotify,
}) => {
  const { lang, t } = useI18n();
  const isBn = lang === 'bn';
  const [subTab, setSubTab] = useState<'milling' | 'chatal' | 'drying'>(initialSubTab || 'milling');
  const [dryingViewMode, setDryingViewMode] = useState<'all' | 'active' | 'history'>(initialDryingView || 'all');
  const [dryingSortOrder, setDryingSortOrder] = useState<'date_desc' | 'date_asc' | 'efficiency_desc' | 'loss_desc'>('date_desc');
  const [dryingMethodFilter, setDryingMethodFilter] = useState<'ALL' | 'MECHANICAL_DRYER' | 'SUN_YARD'>('ALL');
  const [dryingSearch, setDryingSearch] = useState('');
  const [dryingDateFrom, setDryingDateFrom] = useState('');
  const [dryingDateTo, setDryingDateTo] = useState('');
  const [showBatchForm, setShowBatchForm] = useState(true);
  const [showChatalForm, setShowChatalForm] = useState(false);
  const [showDryingForm, setShowDryingForm] = useState(false);
  const [selectedDryPurchaseId, setSelectedDryPurchaseId] = useState<number>(0);

  useEffect(() => {
    if (initialSubTab) setSubTab(initialSubTab);
    if (initialDryingView) setDryingViewMode(initialDryingView);
  }, [initialSubTab, initialDryingView, navTriggerKey]);

  // ID-based active modals so onRefresh() keeps modals live without stale snapshots
  const [sheetBatchId, setSheetBatchId] = useState<number | null>(null);
  const [completingBatchId, setCompletingBatchId] = useState<number | null>(null);
  const [expenseBatchId, setExpenseBatchId] = useState<number | null>(null);
  const [addPaddyBatchId, setAddPaddyBatchId] = useState<number | null>(null);
  const [weighOutBatchId, setWeighOutBatchId] = useState<number | null>(null);
  const [weighOutSubmitting, setWeighOutSubmitting] = useState(false);

  // Inline pay-later settlement target inside Step 2 or Cost Sheet modal
  const [payingExp, setPayingExp] = useState<{ batchId: number; exp: ProductionBatchExpense } | null>(null);
  const [lastExpenseReceipt, setLastExpenseReceipt] = useState<{ receipt: ProductionExpensePayment; batch: ProductionBatch } | null>(
    null
  );
  const [payDueForm, setPayDueForm] = useState({
    account_id: 0,
    amount: 0,
    payment_mode: 'CASH' as 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'UPI_MOBILE',
    reference_no: '',
    notes: '',
  });

  const [showStep3FinalExtra, setShowStep3FinalExtra] = useState(false);

  const paddyItems = useMemo(() => items.filter((i) => isPaddyItem(i, categories)), [items, categories]);
  const headRiceItems = useMemo(() => items.filter((i) => isHeadRiceItem(i, categories)), [items, categories]);
  const nonPaddyItems = useMemo(() => items.filter((i) => !isPaddyItem(i, categories)), [items, categories]);

  const paymentAccounts = useMemo(() => {
    const filtered = accounts.filter(
      (a) => a.account_code === '1001' || a.account_code === '1002' || (a.account_type === 'ASSET' && /cash|bank/i.test(a.name))
    );
    return filtered.length > 0 ? filtered : accounts.filter((a) => a.account_type === 'ASSET');
  }, [accounts]);

  const defaultCashAccountId = useMemo(
    () => paymentAccounts.find((a) => a.account_code === '1001')?.id || paymentAccounts[0]?.id || 0,
    [paymentAccounts]
  );

  const selectedSheetBatch = useMemo(
    () => (sheetBatchId ? batches.find((b) => b.id === sheetBatchId) || null : null),
    [batches, sheetBatchId]
  );
  const completingBatch = useMemo(
    () => (completingBatchId ? batches.find((b) => b.id === completingBatchId) || null : null),
    [batches, completingBatchId]
  );
  const expenseBatch = useMemo(
    () => (expenseBatchId ? batches.find((b) => b.id === expenseBatchId) || null : null),
    [batches, expenseBatchId]
  );
  const addPaddyBatch = useMemo(
    () => (addPaddyBatchId ? batches.find((b) => b.id === addPaddyBatchId) || null : null),
    [batches, addPaddyBatchId]
  );

  // Step 1 form
  const [batchForm, setBatchForm] = useState({
    process_type: 'PARBOILED_SIDDHO' as ProcessType,
    source_warehouse_id: warehouses[0]?.id || 0,
    paddy_item_id: paddyItems[0]?.id || 0,
    dryer_count: 1,
    dryer_no: '',
    input_bag_count: 0,
    input_paddy_qty_kg: 0,
    unit_divisor: 75.5,
    costing_method: 'FIFO' as CostingMethod,
    notes: '',
  });

  // Add extra paddy into running dryer batch form
  const [addPaddyForm, setAddPaddyForm] = useState({
    source_warehouse_id: warehouses[0]?.id || 0,
    paddy_item_id: paddyItems[0]?.id || 0,
    bag_count: 0,
    qty_kg: 0,
    unit_divisor: 75.5,
    costing_method: 'FIFO' as CostingMethod,
    notes: '',
  });

  // Step 2 expense form (Purpose-based + Pay Now / Pay Later)
  const [expenseForm, setExpenseForm] = useState({
    expense_category: 'LABOR' as ExpensePurposeKey,
    vendor_name: '',
    amount: 0,
    payment_timing: 'PAID' as 'PAID' | 'UNPAID' | 'PARTIAL',
    paid_now: 0,
    account_id: 0,
    notes: '',
  });

  // Step 3 form (25kg & 50kg Head Rice + Dynamic Secondary Items)
  const [completeForm, setCompleteForm] = useState({
    head_rice_item_id: headRiceItems[0]?.id || 0,
    rice_warehouse_id: warehouses.find((w) => w.warehouse_type === 'FINISHED_RICE')?.id || warehouses[0]?.id || 0,
    byproduct_warehouse_id: warehouses.find((w) => w.warehouse_type === 'BY_PRODUCT')?.id || warehouses[0]?.id || 0,
    bags_25kg: 0,
    bags_50kg: 0,
    extra_pack_size: 10,
    extra_bags: 0,
    labor_cost: 0,
    electricity_cost: 0,
    fuel_boiler_cost: 0,
    machinery_overhead_cost: 0,
    packaging_cost: 0,
  });
  const [secondaryDrafts, setSecondaryDrafts] = useState<SecondaryOutputDraft[]>([]);

  const [dryForm, setDryForm] = useState({
    source_warehouse_id: warehouses[0]?.id || 0,
    dest_warehouse_id: warehouses.find((w) => w.warehouse_type === 'DRYING_YARD')?.id || warehouses[0]?.id || 0,
    item_id: paddyItems[0]?.id || 0,
    drying_method: 'MECHANICAL_DRYER' as 'SUN_YARD' | 'MECHANICAL_DRYER',
    input_qty_kg: 0,
    input_bags: 0,
    initial_moisture_pct: 0,
    final_moisture_pct: 0,
    output_qty_kg: 0,
    output_bags: 0,
    weight_pending: true,
    fuel_power_cost: 0,
    labor_cost: 0,
    notes: '',
  });

  const [weighOutForm, setWeighOutForm] = useState({
    mode: 'DIRECT_SALE' as 'DIRECT_SALE' | 'WEIGH_AND_STOCK',
    customer_id: customers[0]?.id || 0,
    scale_weight_kg: 0,
    qty_kg: 0,
    weight_loss_kg: 0,
    jute_bag_count: 0,
    plastic_bag_count: 0,
    settlement_unit_kg: 75.5,
    settlement_rate: 0,
    paid_amount: 0,
    vehicle_no: '',
    challan_no: '',
    moisture_pct: 0,
    close_lot: true,
    notes: '',
  });

  const effectiveSourceWh = warehouses.some((w) => w.id === batchForm.source_warehouse_id)
    ? batchForm.source_warehouse_id
    : warehouses[0]?.id || 0;
  const effectivePaddyItemId = paddyItems.some((i) => i.id === batchForm.paddy_item_id)
    ? batchForm.paddy_item_id
    : paddyItems[0]?.id || 0;

  const effectiveAddPaddyWh = warehouses.some((w) => w.id === addPaddyForm.source_warehouse_id)
    ? addPaddyForm.source_warehouse_id
    : warehouses[0]?.id || 0;
  const effectiveAddPaddyItemId = paddyItems.some((i) => i.id === addPaddyForm.paddy_item_id)
    ? addPaddyForm.paddy_item_id
    : paddyItems[0]?.id || 0;

  const effectiveDrySourceWh = warehouses.some((w) => w.id === dryForm.source_warehouse_id)
    ? dryForm.source_warehouse_id
    : warehouses[0]?.id || 0;
  const effectiveDryDestWh = warehouses.some((w) => w.id === dryForm.dest_warehouse_id)
    ? dryForm.dest_warehouse_id
    : warehouses.find((w) => w.warehouse_type === 'DRYING_YARD')?.id || warehouses[0]?.id || 0;
  const effectiveDryPaddyId = paddyItems.some((i) => i.id === dryForm.item_id)
    ? dryForm.item_id
    : paddyItems[0]?.id || 0;

  const rawWetPurchases = useMemo(() => {
    return purchases
      .map((p) => {
        const matchingLots = lots.filter(
          (l) => l.source_type === 'PADDY_PURCHASE' && l.source_id === p.id && Number(l.remaining_qty_kg || 0) > 0.01
        );
        const remKg =
          matchingLots.length > 0
            ? matchingLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0)
            : Number(p.unconsumed_lot_qty_kg ?? Math.max(0, Number(p.received_weight_kg || 0) - Number(p.returned_qty_kg || 0)));
        const remBags =
          matchingLots.length > 0
            ? matchingLots.reduce((s, l) => s + Number(l.remaining_bags || 0), 0)
            : Number(p.unconsumed_lot_bags ?? p.bag_count ?? 0);
        return { purchase: p, matchingLots, remKg: Number(remKg.toFixed(2)), remBags };
      })
      .filter((entry) => entry.purchase.paddy_condition !== 'DRIED' && entry.remKg > 0.01);
  }, [purchases, lots]);

  const dryingSummaryStats = useMemo(() => {
    let totalRawInputKg = 0;
    let totalRawInputBags = 0;
    let weighedInputKg = 0;
    let weighedOutputKg = 0;
    let totalStoredOutputBags = 0;
    let totalDispatchedBags = 0;
    let pendingInputKg = 0;
    let pendingBags = 0;
    let totalMoistureLossKg = 0;

    for (const d of dryingBatches) {
      const inKg = Number(d.input_qty_kg || 0);
      const inBags = Number(d.input_bags || 0);
      const outKg = Number(d.output_qty_kg || 0);
      const outBags = Number(d.output_bags || 0);
      const dispBags = Number(d.dispatched_bags || 0);
      const isPending = d.status === 'PENDING_WEIGHT' || Boolean(d.weight_pending);
      totalRawInputKg += inKg;
      totalRawInputBags += inBags;
      totalStoredOutputBags += outBags;
      totalDispatchedBags += dispBags;
      if (outKg > 0) {
        weighedInputKg += inKg;
        weighedOutputKg += outKg;
        totalMoistureLossKg += Math.max(0, Number(d.moisture_loss_kg ?? inKg - outKg));
      } else if (isPending) {
        pendingInputKg += inKg;
        pendingBags += Number(d.remaining_bags ?? Math.max(0, outBags - dispBags));
      }
    }

    const yieldPct = weighedInputKg > 0 ? (weighedOutputKg / weighedInputKg) * 100 : 0;
    const lossPct = weighedInputKg > 0 ? (totalMoistureLossKg / weighedInputKg) * 100 : 0;
    const remainingRawToDryKg = rawWetPurchases.reduce((s, r) => s + r.remKg, 0);
    const remainingRawToDryBags = rawWetPurchases.reduce((s, r) => s + r.remBags, 0);

    return {
      batchCount: dryingBatches.length,
      totalRawInputKg: Number(totalRawInputKg.toFixed(2)),
      totalRawInputBags,
      weighedInputKg: Number(weighedInputKg.toFixed(2)),
      weighedOutputKg: Number(weighedOutputKg.toFixed(2)),
      totalStoredOutputBags,
      totalDispatchedBags,
      pendingInputKg: Number(pendingInputKg.toFixed(2)),
      pendingBags,
      totalMoistureLossKg: Number(totalMoistureLossKg.toFixed(2)),
      yieldPct: Number(yieldPct.toFixed(1)),
      lossPct: Number(lossPct.toFixed(1)),
      remainingRawToDryKg: Number(remainingRawToDryKg.toFixed(2)),
      remainingRawToDryBags,
    };
  }, [dryingBatches, rawWetPurchases]);

  const dryingViewCounts = useMemo(() => {
    let active = 0;
    let history = 0;
    for (const d of dryingBatches) {
      const isPending = d.status === 'PENDING_WEIGHT' || d.status === 'IN_PROGRESS' || Boolean(d.weight_pending);
      if (isPending) active += 1;
      else history += 1;
    }
    return { all: dryingBatches.length, active, history };
  }, [dryingBatches]);

  const filteredDryingBatches = useMemo(() => {
    const q = dryingSearch.trim().toLowerCase();
    const list = dryingBatches.filter((d) => {
      const isPending = d.status === 'PENDING_WEIGHT' || d.status === 'IN_PROGRESS' || Boolean(d.weight_pending);
      if (dryingViewMode === 'active' && !isPending) return false;
      if (dryingViewMode === 'history' && isPending) return false;
      if (dryingMethodFilter !== 'ALL' && d.drying_method !== dryingMethodFilter) return false;

      if (dryingDateFrom || dryingDateTo) {
        const dt = parseDbDate(d.created_at);
        if (!dt) return false;
        const isoDay = dt.toISOString().slice(0, 10);
        if (dryingDateFrom && isoDay < dryingDateFrom) return false;
        if (dryingDateTo && isoDay > dryingDateTo) return false;
      }

      if (q) {
        const hay = [
          d.drying_no,
          d.lot_code,
          d.purchase_no,
          d.supplier_name,
          d.item_name,
          d.dest_warehouse_name,
          d.source_warehouse_name,
          d.notes,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }

      return true;
    });

    const getEff = (d: DryingBatch) => {
      const inKg = Number(d.input_qty_kg || 0);
      const outKg = Number(d.output_qty_kg || 0);
      return inKg > 0 && outKg > 0 ? (outKg / inKg) * 100 : -1;
    };
    const getLoss = (d: DryingBatch) => {
      const inKg = Number(d.input_qty_kg || 0);
      const outKg = Number(d.output_qty_kg || 0);
      if (outKg <= 0) return -1;
      return Math.max(0, Number(d.moisture_loss_kg ?? inKg - outKg));
    };
    const getTime = (d: DryingBatch) => parseDbDate(d.created_at)?.getTime() ?? 0;

    return [...list].sort((a, b) => {
      if (dryingSortOrder === 'date_asc') {
        const diff = getTime(a) - getTime(b);
        return diff !== 0 ? diff : a.id - b.id;
      }
      if (dryingSortOrder === 'efficiency_desc') {
        const diff = getEff(b) - getEff(a);
        return diff !== 0 ? diff : getTime(b) - getTime(a);
      }
      if (dryingSortOrder === 'loss_desc') {
        const diff = getLoss(b) - getLoss(a);
        return diff !== 0 ? diff : getTime(b) - getTime(a);
      }
      const diff = getTime(b) - getTime(a);
      return diff !== 0 ? diff : b.id - a.id;
    });
  }, [dryingBatches, dryingViewMode, dryingMethodFilter, dryingDateFrom, dryingDateTo, dryingSearch, dryingSortOrder]);

  const filteredDryingMetrics = useMemo(() => {
    let weighedIn = 0;
    let weighedOut = 0;
    let totalLost = 0;
    let totalIn = 0;
    let dropSum = 0;
    let dropCount = 0;
    let oldestAgeDays = 0;

    for (const d of filteredDryingBatches) {
      const inKg = Number(d.input_qty_kg || 0);
      const outKg = Number(d.output_qty_kg || 0);
      totalIn += inKg;
      const age = getInventoryAgeDays(d.created_at);
      if (age > oldestAgeDays) oldestAgeDays = age;
      if (outKg > 0) {
        weighedIn += inKg;
        weighedOut += outKg;
        totalLost += Math.max(0, Number(d.moisture_loss_kg ?? inKg - outKg));
        const initMc = Number(d.initial_moisture_pct || 0);
        const finalMc = Number(d.final_moisture_pct || 0);
        if (initMc > 0 && finalMc >= 0 && initMc >= finalMc) {
          dropSum += initMc - finalMc;
          dropCount += 1;
        }
      }
    }

    return {
      count: filteredDryingBatches.length,
      totalInKg: Number(totalIn.toFixed(2)),
      weighedOutKg: Number(weighedOut.toFixed(2)),
      totalLostKg: Number(totalLost.toFixed(2)),
      avgEffPct: weighedIn > 0 ? Number(((weighedOut / weighedIn) * 100).toFixed(1)) : 0,
      avgMoistureDropPct: dropCount > 0 ? Number((dropSum / dropCount).toFixed(1)) : 0,
      oldestAgeDays,
    };
  }, [filteredDryingBatches]);

  const activeBatches = useMemo(() => batches.filter((b) => b.status === 'IN_PROGRESS'), [batches]);

  // Live stock lookup per warehouse + paddy item using Inventory & Stock formula
  const itemStockMap = useMemo(() => {
    const m = new Map<string, { bags: number; weightKg: number; value: number }>();
    for (const l of lots) {
      const kg = Number(l.remaining_qty_kg || 0);
      if (kg <= 0.0001) continue;
      const key = `${l.warehouse_id}-${l.item_id}`;
      const cur = m.get(key) || { bags: 0, weightKg: 0, value: 0 };
      const bagWt = Number(l.bag_weight_kg || items.find((it) => it.id === l.item_id)?.bag_weight_kg || 60) || 60;
      const lotBags =
        l.remaining_bags !== undefined && l.remaining_bags !== null && Number(l.remaining_bags) > 0
          ? Number(l.remaining_bags)
          : Math.round(kg / bagWt);
      cur.bags += lotBags;
      cur.weightKg += kg;
      cur.value += kg * Number(l.unit_cost_per_kg || 0);
      m.set(key, cur);
    }
    return m;
  }, [lots, items]);

  const computeStockSummary = (whId: number, itemId: number, divisor: number, qtyKg: number, bagCount: number) => {
    const raw = itemStockMap.get(`${whId}-${itemId}`) || { bags: 0, weightKg: 0, value: 0 };
    const safeDiv = divisor > 0 ? divisor : 75.5;
    const stockNetUnits = raw.weightKg > raw.bags ? (raw.weightKg - raw.bags) / safeDiv : 0;
    const bagUnitRate = stockNetUnits > 0 ? raw.value / stockNetUnits : 0;
    const goingUnits = qtyKg > bagCount && safeDiv > 0 ? (qtyKg - bagCount) / safeDiv : 0;
    const estCost =
      bagUnitRate > 0 && goingUnits > 0
        ? Number((bagUnitRate * goingUnits).toFixed(2))
        : raw.weightKg > 0
        ? Number(((raw.value / raw.weightKg) * qtyKg).toFixed(2))
        : 0;
    return { ...raw, safeDiv, stockNetUnits, bagUnitRate, goingUnits, estCost };
  };

  const selectedStock = useMemo(
    () =>
      computeStockSummary(
        effectiveSourceWh,
        effectivePaddyItemId,
        batchForm.unit_divisor,
        batchForm.input_paddy_qty_kg,
        batchForm.input_bag_count
      ),
    [itemStockMap, effectiveSourceWh, effectivePaddyItemId, batchForm.unit_divisor, batchForm.input_paddy_qty_kg, batchForm.input_bag_count]
  );

  const addPaddyStock = useMemo(
    () =>
      computeStockSummary(
        effectiveAddPaddyWh,
        effectiveAddPaddyItemId,
        addPaddyForm.unit_divisor,
        addPaddyForm.qty_kg,
        addPaddyForm.bag_count
      ),
    [itemStockMap, effectiveAddPaddyWh, effectiveAddPaddyItemId, addPaddyForm.unit_divisor, addPaddyForm.qty_kg, addPaddyForm.bag_count]
  );

  const getOverheadTotal = (b: ProductionBatch) => {
    if (!b.cost_sheet) return 0;
    return (
      Number(b.cost_sheet.labor_cost || 0) +
      Number(b.cost_sheet.electricity_cost || 0) +
      Number(b.cost_sheet.fuel_boiler_cost || 0) +
      Number(b.cost_sheet.machinery_overhead_cost || 0) +
      Number(b.cost_sheet.packaging_cost || 0)
    );
  };

  const getPurposeLabel = (cat?: string) => {
    const found = EXPENSE_PURPOSES.find((p) => p.key === cat);
    if (found) return isBn ? found.bn : found.en;
    return cat || (isBn ? 'অন্যান্য খরচ' : 'Expense');
  };

  const computeIssueMetrics = (b: ProductionBatch) => {
    const div = Number(b.unit_divisor || 75.5) || 75.5;
    const bags = Number(b.input_bag_count || 0);
    const paddyKg = Number(b.input_paddy_qty_kg || 0);
    const denom = paddyKg > bags ? (paddyKg - bags) / div : 0;
    const headKg = Number(b.head_rice_qty_kg || 0);
    const issue = Number(b.issue_per_unit || (denom > 0 && headKg > 0 ? headKg / denom : 0));
    return { div, bags, paddyKg, denom, headKg, issue };
  };

  const handleBagChange = (nextBags: number) => {
    const cleanBags = Math.max(0, Math.round(nextBags));
    const suggestedKg =
      selectedStock.bags > 0
        ? Math.round((cleanBags * selectedStock.weightKg) / selectedStock.bags)
        : Math.round(cleanBags * 60);
    setBatchForm((prev) => ({
      ...prev,
      input_bag_count: cleanBags,
      input_paddy_qty_kg: cleanBags > 0 && suggestedKg > 0 ? suggestedKg : prev.input_paddy_qty_kg,
    }));
  };

  const handleFillAllStock = () => {
    if (selectedStock.weightKg <= 0) return;
    setBatchForm((prev) => ({
      ...prev,
      input_bag_count: selectedStock.bags,
      input_paddy_qty_kg: Number(selectedStock.weightKg.toFixed(2)),
    }));
  };

  // Step 1: Issue paddy to dryer (`issue_only: true`)
  const handleCreateStep1Issue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (batchForm.input_paddy_qty_kg <= 0 || batchForm.input_bag_count <= 0 || batchForm.input_paddy_qty_kg <= batchForm.input_bag_count) {
      onNotify(
        isBn ? 'সঠিক বস্তা সংখ্যা এবং বস্তার চেয়ে বেশি ওজন (কেজি) দিন।' : 'Valid bag count and weight (kg > bags) required.',
        'err'
      );
      return;
    }
    try {
      const res = await apiMutate({
        endpoint: '/api/v1/production-batches',
        payload: {
          ...batchForm,
          source_warehouse_id: effectiveSourceWh,
          paddy_item_id: effectivePaddyItemId,
          issue_only: true,
          soaking_hours: 0,
          steaming_temp_c: 0,
          labor_cost: 0,
          electricity_cost: 0,
          fuel_boiler_cost: 0,
          machinery_overhead_cost: 0,
          packaging_cost: 0,
        },
        module: 'Production Batch (Step 1)',
        summary: `Step 1 Paddy Issue · ${batchForm.process_type} · ${batchForm.dryer_count} Dryer (${batchForm.dryer_no}) · ${batchForm.input_bag_count} bags / ${batchForm.input_paddy_qty_kg} kg`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: ধাপ ১ (ডায়ারে ধান দেওয়া) কিউতে সংরক্ষিত হয়েছে।' : 'Offline: Step 1 paddy issue queued for sync.', 'warn');
      } else {
        onNotify(
          isBn
            ? `ধাপ ১ সম্পন্ন: ${batchForm.dryer_count}টি ডায়ারে (${batchForm.dryer_no}) ${batchForm.input_bag_count} বস্তা (${batchForm.input_paddy_qty_kg} কেজি) ধান গেছে। এখন চলমান অবস্থায় আরও ধান বা খরচ যোগ করতে পারবেন।`
            : `Step 1 complete: Issued ${batchForm.input_bag_count} bags (${batchForm.input_paddy_qty_kg} kg) to ${batchForm.dryer_no}.`,
          'ok'
        );
      }
      setBatchForm((prev) => ({
        ...prev,
        dryer_no: '',
        input_bag_count: 0,
        input_paddy_qty_kg: 0,
        notes: '',
      }));
      setShowBatchForm(false);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  // Add Extra Paddy to Running Dryer Batch
  const openAddPaddyModal = (b: ProductionBatch) => {
    setAddPaddyBatchId(b.id);
    setAddPaddyForm({
      source_warehouse_id: b.source_warehouse_id || warehouses[0]?.id || 0,
      paddy_item_id: b.paddy_item_id || paddyItems[0]?.id || 0,
      bag_count: 0,
      qty_kg: 0,
      unit_divisor: b.unit_divisor || 75.5,
      costing_method: b.costing_method || 'FIFO',
      notes: '',
    });
  };

  const handleAddExtraPaddy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addPaddyBatch) return;
    if (addPaddyForm.qty_kg <= 0 || addPaddyForm.bag_count <= 0 || addPaddyForm.qty_kg <= addPaddyForm.bag_count) {
      onNotify(isBn ? 'বস্তা সংখ্যা এবং বস্তার চেয়ে বেশি ওজন দিন।' : 'Valid bag count and weight (> bags) required.', 'err');
      return;
    }
    try {
      const res = await apiMutate({
        endpoint: `/api/v1/production-batches/${addPaddyBatch.id}/add-paddy`,
        method: 'POST',
        payload: {
          source_warehouse_id: effectiveAddPaddyWh,
          paddy_item_id: effectiveAddPaddyItemId,
          bag_count: addPaddyForm.bag_count,
          qty_kg: addPaddyForm.qty_kg,
          unit_divisor: addPaddyForm.unit_divisor,
          costing_method: addPaddyForm.costing_method,
          notes: addPaddyForm.notes,
        },
        module: 'Add Paddy to Dryer',
        summary: `Added ${addPaddyForm.bag_count} bags (${addPaddyForm.qty_kg} kg) to ${addPaddyBatch.batch_no}`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: অতিরিক্ত ধান যোগ কিউতে সংরক্ষিত হয়েছে।' : 'Offline: Extra paddy queued for sync.', 'warn');
      } else {
        onNotify(
          isBn
            ? `${addPaddyBatch.batch_no}-এ আরও ${addPaddyForm.bag_count} বস্তা (${addPaddyForm.qty_kg} কেজি) ধান যোগ হয়েছে।`
            : `Added ${addPaddyForm.bag_count} bags (${addPaddyForm.qty_kg} kg) to ${addPaddyBatch.batch_no}.`,
          'ok'
        );
      }
      setAddPaddyBatchId(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  // Step 2: Open gradual categorized expense modal
  const openExpenseModal = (b: ProductionBatch) => {
    setExpenseBatchId(b.id);
    setPayingExp(null);
    setExpenseForm({
      expense_category: 'LABOR',
      vendor_name: '',
      amount: 0,
      payment_timing: 'PAID',
      paid_now: 0,
      account_id: defaultCashAccountId,
      notes: '',
    });
  };

  const handleAddBatchExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!expenseBatch) return;
    const amt = Number(expenseForm.amount || 0);
    if (amt <= 0) {
      onNotify(isBn ? 'খরচের পরিমাণ শূন্যের বেশি দিন।' : 'Enter a positive expense amount.', 'err');
      return;
    }
    const payload = {
      expense_category: expenseForm.expense_category,
      vendor_name: expenseForm.vendor_name.trim(),
      labor_cost: expenseForm.expense_category === 'LABOR' ? amt : 0,
      electricity_cost: expenseForm.expense_category === 'ELECTRICITY' ? amt : 0,
      fuel_boiler_cost: expenseForm.expense_category === 'FUEL_BOILER' ? amt : 0,
      machinery_overhead_cost:
        expenseForm.expense_category === 'MACHINERY' ||
        expenseForm.expense_category === 'TRANSPORT' ||
        expenseForm.expense_category === 'OTHER'
          ? amt
          : 0,
      packaging_cost: expenseForm.expense_category === 'PACKAGING' ? amt : 0,
      payment_timing: expenseForm.payment_timing,
      paid_now: expenseForm.payment_timing === 'PARTIAL' ? Number(expenseForm.paid_now || 0) : undefined,
      account_id: expenseForm.account_id || defaultCashAccountId || undefined,
      notes: expenseForm.notes.trim() || getPurposeLabel(expenseForm.expense_category),
    };

    try {
      const res = await apiMutate({
        endpoint: `/api/v1/production-batches/${expenseBatch.id}/expenses`,
        method: 'POST',
        payload,
        module: 'Production Expense (Step 2)',
        summary: `${getPurposeLabel(expenseForm.expense_category)} ৳${amt.toLocaleString('en-IN')} (${expenseForm.payment_timing}) on ${expenseBatch.batch_no}`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: ধাপ ২ খরচ কিউতে সংরক্ষিত হয়েছে।' : 'Offline: Expense entry queued for sync.', 'warn');
      } else {
        onNotify(
          isBn
            ? `${expenseBatch.batch_no}-এ ${getPurposeLabel(expenseForm.expense_category)} বাবদ ৳${amt.toLocaleString('en-IN')} (${
                expenseForm.payment_timing === 'UNPAID' ? 'বাকিতে' : expenseForm.payment_timing === 'PARTIAL' ? 'আংশিক পরিশোধ' : 'পরিশোধিত'
              }) যোগ হয়েছে।`
            : `Added ৳${amt.toLocaleString('en-IN')} (${expenseForm.expense_category}) to ${expenseBatch.batch_no}.`,
          'ok'
        );
      }
      setExpenseForm((prev) => ({ ...prev, amount: 0, paid_now: 0, vendor_name: '', notes: '' }));
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  // Settle unpaid/partial expense later
  const startPayExpenseDue = (batchId: number, exp: ProductionBatchExpense) => {
    const openDue = Math.max(0, Number((Number(exp.total_amount || 0) - Number(exp.paid_amount || 0)).toFixed(2)));
    setPayingExp({ batchId, exp });
    setPayDueForm({
      account_id: defaultCashAccountId,
      amount: openDue,
      payment_mode: 'CASH',
      reference_no: '',
      notes: isBn ? 'বাকি খরচ পরিশোধ' : 'Due expense settlement',
    });
  };

  const handleSubmitPayDue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payingExp) return;
    if (payDueForm.amount <= 0) {
      onNotify(isBn ? 'পরিশোধের পরিমাণ শূন্যের বেশি হতে হবে।' : 'Payment amount must be positive.', 'err');
      return;
    }
    try {
      const res = await apiMutate<{ status: string; receipt?: ProductionExpensePayment; batch?: ProductionBatch }>({
        endpoint: `/api/v1/production-batches/${payingExp.batchId}/expenses/${payingExp.exp.id}/pay`,
        method: 'POST',
        payload: {
          account_id: payDueForm.account_id || defaultCashAccountId || undefined,
          amount: payDueForm.amount,
          payment_mode: payDueForm.payment_mode,
          reference_no: payDueForm.reference_no,
          notes: payDueForm.notes,
        },
        module: 'Pay Batch Expense Due',
        summary: `Paid ৳${payDueForm.amount.toLocaleString('en-IN')} due expense`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: বাকি খরচ পরিশোধ কিউতে সংরক্ষিত।' : 'Offline: Payment queued.', 'warn');
      } else {
        if (res.data?.receipt) {
          const targetBatch = res.data.batch || batches.find((x) => x.id === payingExp.batchId);
          if (targetBatch) {
            setLastExpenseReceipt({ receipt: res.data.receipt, batch: targetBatch });
          }
        }
        onNotify(
          isBn ? `৳${payDueForm.amount.toLocaleString('en-IN')} বাকি খরচ সফলভাবে পরিশোধ হয়েছে।` : `Paid ৳${payDueForm.amount} due expense.`,
          'ok'
        );
      }
      setPayingExp(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  // Helpers for Step 3 Secondary Outputs
  const findItemMatch = (keywords: string[]) =>
    nonPaddyItems.find((it) => keywords.some((kw) => it.name.toLowerCase().includes(kw.toLowerCase())));

  const makeDraftRow = (preset: 'MORA_MACHI' | 'DIAMOND_KHUDI' | 'BROKEN' | 'BRAN' | 'HUSK' | 'CUSTOM'): SecondaryOutputDraft => {
    const bypWh = completeForm.byproduct_warehouse_id || warehouses[0]?.id || 0;
    if (preset === 'MORA_MACHI') {
      const it = findItemMatch(['মরা মাছি', 'mora machi']);
      const rate = it?.default_rate || 0;
      return {
        uid: crypto.randomUUID(),
        item_id: it?.id || 0,
        custom_name: it ? '' : 'মরা মাছি (Mora Machi 25kg)',
        category: it?.category || 'BY_PRODUCT',
        pack_size_kg: 25,
        bag_count: 0,
        qty_kg: 0,
        rate_per_kg: rate,
        rate_per_bag: rate > 0 ? Number((rate * 25).toFixed(2)) : 0,
        pricing_unit: 'BAG',
        warehouse_id: bypWh,
      };
    }
    if (preset === 'DIAMOND_KHUDI') {
      const it = findItemMatch(['ডায়মন্ড খুদি', 'diamond khudi', 'ডায়মন্ড']);
      const rate = it?.default_rate || 0;
      return {
        uid: crypto.randomUUID(),
        item_id: it?.id || 0,
        custom_name: it ? '' : 'ডায়মন্ড খুদি (Diamond Khudi 50kg)',
        category: it?.category || 'BROKEN_RICE',
        pack_size_kg: 50,
        bag_count: 0,
        qty_kg: 0,
        rate_per_kg: rate,
        rate_per_bag: rate > 0 ? Number((rate * 50).toFixed(2)) : 0,
        pricing_unit: 'BAG',
        warehouse_id: bypWh,
      };
    }
    if (preset === 'BROKEN') {
      const it = nonPaddyItems.find((i) => i.category === 'BROKEN_RICE');
      const rate = it?.default_rate || 0;
      return {
        uid: crypto.randomUUID(),
        item_id: it?.id || 0,
        custom_name: it ? '' : 'ভাঙা চাল / খুদ (Broken Rice)',
        category: 'BROKEN_RICE',
        pack_size_kg: 50,
        bag_count: 0,
        qty_kg: 0,
        rate_per_kg: rate,
        rate_per_bag: rate > 0 ? Number((rate * 50).toFixed(2)) : 0,
        pricing_unit: 'BAG',
        warehouse_id: bypWh,
      };
    }
    if (preset === 'BRAN') {
      const it = nonPaddyItems.find((i) => i.category === 'RICE_BRAN');
      const rate = it?.default_rate || 0;
      return {
        uid: crypto.randomUUID(),
        item_id: it?.id || 0,
        custom_name: it ? '' : 'চালের কুঁড়া (Rice Bran)',
        category: 'RICE_BRAN',
        pack_size_kg: 50,
        bag_count: 0,
        qty_kg: 0,
        rate_per_kg: rate,
        rate_per_bag: rate > 0 ? Number((rate * 50).toFixed(2)) : 0,
        pricing_unit: 'BAG',
        warehouse_id: bypWh,
      };
    }
    if (preset === 'HUSK') {
      const it = nonPaddyItems.find((i) => i.category === 'HUSK');
      const rate = it?.default_rate || 0;
      return {
        uid: crypto.randomUUID(),
        item_id: it?.id || 0,
        custom_name: it ? '' : 'ধানের তুষ (Husk)',
        category: 'HUSK',
        pack_size_kg: 35,
        bag_count: 0,
        qty_kg: 0,
        rate_per_kg: rate,
        rate_per_bag: rate > 0 ? Number((rate * 35).toFixed(2)) : 0,
        pricing_unit: 'BAG',
        warehouse_id: bypWh,
      };
    }
    return {
      uid: crypto.randomUUID(),
      item_id: 0,
      custom_name: '',
      category: 'BY_PRODUCT',
      pack_size_kg: 25,
      bag_count: 0,
      qty_kg: 0,
      rate_per_kg: 0,
      rate_per_bag: 0,
      pricing_unit: 'BAG',
      warehouse_id: bypWh,
    };
  };

  // Step 3: Open Complete modal
  const openCompleteModal = (b: ProductionBatch) => {
    setCompletingBatchId(b.id);
    setShowStep3FinalExtra(false);

    setCompleteForm({
      head_rice_item_id: headRiceItems[0]?.id || 0,
      rice_warehouse_id: warehouses.find((w) => w.warehouse_type === 'FINISHED_RICE')?.id || warehouses[0]?.id || 0,
      byproduct_warehouse_id: warehouses.find((w) => w.warehouse_type === 'BY_PRODUCT')?.id || warehouses[0]?.id || 0,
      bags_25kg: 0,
      bags_50kg: 0,
      extra_pack_size: 10,
      extra_bags: 0,
      labor_cost: 0,
      electricity_cost: 0,
      fuel_boiler_cost: 0,
      machinery_overhead_cost: 0,
      packaging_cost: 0,
    });

    setSecondaryDrafts([]);
  };

  const updateSecondaryDraft = (uid: string, patch: Partial<SecondaryOutputDraft>) => {
    setSecondaryDrafts((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  };

  const step3Preview = useMemo(() => {
    if (!completingBatch) return null;
    const inKg = Number(completingBatch.input_paddy_qty_kg || 0);
    const kg25 = Math.max(0, completeForm.bags_25kg) * 25;
    const kg50 = Math.max(0, completeForm.bags_50kg) * 50;
    const kgExtra = Math.max(0, completeForm.extra_bags) * Math.max(1, completeForm.extra_pack_size);
    const headKg = Number((kg25 + kg50 + kgExtra).toFixed(3));

    const secKg = Number(secondaryDrafts.reduce((s, r) => s + Math.max(0, Number(r.qty_kg || 0)), 0).toFixed(3));
    const secValue = Number(
      secondaryDrafts
        .reduce((s, r) => {
          const qty = Math.max(0, Number(r.qty_kg || 0));
          const pack = r.pack_size_kg || 25;
          const bags = Math.max(0, Number(r.bag_count || 0));
          const rowVal =
            r.pricing_unit === 'BAG' && bags > 0 && Math.abs(qty - bags * pack) < 0.01
              ? bags * Math.max(0, Number(r.rate_per_bag || 0))
              : qty * Math.max(0, Number(r.rate_per_kg || 0));
          return s + rowVal;
        }, 0)
        .toFixed(2)
    );

    const totalOutKg = Number((headKg + secKg).toFixed(3));
    const wastageKg = Math.max(0, Number((inKg - totalOutKg).toFixed(3)));
    const yieldPct = inKg > 0 ? (headKg / inKg) * 100 : 0;

    const div = Number(completingBatch.unit_divisor || 75.5) || 75.5;
    const inBags = Number(completingBatch.input_bag_count || 0);
    const issueDenom = inKg > inBags ? (inKg - inBags) / div : 0;
    const estIssuePerUnit = issueDenom > 0 && headKg > 0 ? headKg / issueDenom : 0;

    const priorGross = Number(completingBatch.cost_sheet?.gross_batch_cost ?? completingBatch.paddy_formula_cost ?? 0);
    const finalExtra =
      Number(completeForm.labor_cost || 0) +
      Number(completeForm.electricity_cost || 0) +
      Number(completeForm.fuel_boiler_cost || 0) +
      Number(completeForm.machinery_overhead_cost || 0) +
      Number(completeForm.packaging_cost || 0);
    const estGross = priorGross + finalExtra;
    const estNetHeadCost = Math.max(0, estGross - secValue);
    const estCostPerKg = headKg > 0 ? estNetHeadCost / headKg : 0;
    const estCost25kg = estCostPerKg * 25;
    const estCost50kg = estCostPerKg * 50;

    return {
      kg25,
      kg50,
      kgExtra,
      headKg,
      secKg,
      secValue,
      totalOutKg,
      wastageKg,
      yieldPct,
      estIssuePerUnit,
      estGross,
      estNetHeadCost,
      estCostPerKg,
      estCost25kg,
      estCost50kg,
      exceedsInput: totalOutKg > inKg + 0.01,
    };
  }, [completingBatch, completeForm, secondaryDrafts]);

  const handleCompletePendingBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!completingBatch || !step3Preview) return;

    if (step3Preview.headKg <= 0) {
      onNotify(isBn ? '২৫ কেজি বা ৫০ কেজি মূল চালের বস্তার সংখ্যা দিন।' : 'Enter 25kg or 50kg head rice bag counts.', 'err');
      return;
    }
    if (step3Preview.exceedsInput) {
      onNotify(
        isBn ? 'মোট আউটপুট ওজন ডায়ারে দেওয়া ধানের ওজনের বেশি হতে পারবে না।' : 'Total output cannot exceed input paddy weight.',
        'err'
      );
      return;
    }

    const head_rice_packs: Array<{
      item_id: number;
      warehouse_id: number;
      pack_size_kg: number;
      bag_count: number;
      qty_kg: number;
    }> = [];

    if (completeForm.bags_25kg > 0) {
      head_rice_packs.push({
        item_id: completeForm.head_rice_item_id,
        warehouse_id: completeForm.rice_warehouse_id,
        pack_size_kg: 25,
        bag_count: completeForm.bags_25kg,
        qty_kg: completeForm.bags_25kg * 25,
      });
    }
    if (completeForm.bags_50kg > 0) {
      head_rice_packs.push({
        item_id: completeForm.head_rice_item_id,
        warehouse_id: completeForm.rice_warehouse_id,
        pack_size_kg: 50,
        bag_count: completeForm.bags_50kg,
        qty_kg: completeForm.bags_50kg * 50,
      });
    }
    if (completeForm.extra_bags > 0 && completeForm.extra_pack_size > 0) {
      head_rice_packs.push({
        item_id: completeForm.head_rice_item_id,
        warehouse_id: completeForm.rice_warehouse_id,
        pack_size_kg: completeForm.extra_pack_size,
        bag_count: completeForm.extra_bags,
        qty_kg: completeForm.extra_bags * completeForm.extra_pack_size,
      });
    }

    const activeSec = secondaryDrafts.filter((r) => Number(r.qty_kg || 0) > 0);
    for (const r of activeSec) {
      if (r.item_id <= 0 && !r.custom_name.trim()) {
        onNotify(isBn ? 'উৎপন্ন আইটেমের নাম লিখুন অথবা তালিকা থেকে বাছাই করুন।' : 'Select an item or enter custom item name.', 'err');
        return;
      }
    }

    const secondary_outputs = activeSec.map((r) => ({
      item_id: r.item_id > 0 ? r.item_id : undefined,
      item_name: r.item_id > 0 ? undefined : r.custom_name.trim(),
      category: r.category,
      pack_size_kg: r.pack_size_kg || 25,
      bag_count: r.bag_count || Math.round(r.qty_kg / (r.pack_size_kg || 25)),
      qty_kg: r.qty_kg,
      rate_per_kg: r.rate_per_kg,
      rate_per_bag: r.rate_per_bag,
      pricing_unit: r.pricing_unit,
      warehouse_id: r.warehouse_id || completeForm.byproduct_warehouse_id,
    }));

    try {
      const res = await apiMutate({
        endpoint: `/api/v1/production-batches/${completingBatch.id}/complete`,
        method: 'POST',
        payload: {
          head_rice_item_id: completeForm.head_rice_item_id,
          rice_warehouse_id: completeForm.rice_warehouse_id,
          byproduct_warehouse_id: completeForm.byproduct_warehouse_id,
          head_rice_packs,
          secondary_outputs,
          labor_cost: completeForm.labor_cost,
          electricity_cost: completeForm.electricity_cost,
          fuel_boiler_cost: completeForm.fuel_boiler_cost,
          machinery_overhead_cost: completeForm.machinery_overhead_cost,
          packaging_cost: completeForm.packaging_cost,
        },
        module: 'Production Complete (Step 3)',
        summary: `Complete ${completingBatch.batch_no} -> ${step3Preview.headKg} kg head rice (@ ৳${step3Preview.estCostPerKg.toFixed(2)}/kg)`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: ধাপ ৩ (আউটপুট ও শেষ) কিউতে সংরক্ষিত হয়েছে।' : 'Offline: Completion queued for sync.', 'warn');
      } else {
        onNotify(
          isBn
            ? `ধাপ ৩ সম্পন্ন: ${completingBatch.batch_no}-এর ২৫/৫০ কেজি চাল (৳${step3Preview.estCostPerKg.toFixed(
                2
              )}/কেজি অটো দাম) ও উপজাত স্টকে যুক্ত হয়েছে।`
            : `Step 3 complete: Milled outputs stocked and ${completingBatch.batch_no} completed.`,
          'ok'
        );
      }
      setCompletingBatchId(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const weighOutBatch = useMemo(
    () => (weighOutBatchId ? dryingBatches.find((d) => d.id === weighOutBatchId) || null : null),
    [dryingBatches, weighOutBatchId]
  );

  const openWeighOutModal = (d: DryingBatch) => {
    const remBags = Math.max(0, Number(d.remaining_bags ?? d.output_bags ?? 0));
    const itemDef = paddyItems.find((i) => i.id === d.item_id);
    const defaultRate = itemDef?.default_rate ? Number((itemDef.default_rate * 75.5).toFixed(2)) : 0;
    setWeighOutForm({
      mode: customers.length > 0 ? 'DIRECT_SALE' : 'WEIGH_AND_STOCK',
      customer_id: customers[0]?.id || 0,
      scale_weight_kg: 0,
      qty_kg: 0,
      weight_loss_kg: 0,
      jute_bag_count: remBags,
      plastic_bag_count: 0,
      settlement_unit_kg: 75.5,
      settlement_rate: Number(d.exit_settlement_rate || defaultRate || 0),
      paid_amount: 0,
      vehicle_no: '',
      challan_no: '',
      moisture_pct: Number(d.final_moisture_pct || 0),
      close_lot: true,
      notes: '',
    });
    setWeighOutBatchId(d.id);
  };

  const weighOutTotalBags =
    Math.max(0, Math.round(Number(weighOutForm.jute_bag_count || 0))) +
    Math.max(0, Math.round(Number(weighOutForm.plastic_bag_count || 0)));
  const weighOutDivisor = weighOutForm.settlement_unit_kg > 0 ? weighOutForm.settlement_unit_kg : 75.5;
  const weighOutNetKg = Math.max(0, Number((Number(weighOutForm.qty_kg || 0) - Number(weighOutForm.weight_loss_kg || 0)).toFixed(3)));
  const weighOutUnits = Number((weighOutNetKg / weighOutDivisor).toFixed(4));
  const weighOutTotalValue = Number((weighOutUnits * Number(weighOutForm.settlement_rate || 0)).toFixed(2));
  const weighOutEffectivePerKg =
    Number(weighOutForm.qty_kg || 0) > 0 ? Number((weighOutTotalValue / Number(weighOutForm.qty_kg || 0)).toFixed(4)) : 0;

  const handleWeighOutSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!weighOutBatch) return;
    if (Number(weighOutForm.qty_kg || 0) <= 0) {
      onNotify(isBn ? 'বের হওয়ার ওজন (কেজি) শূন্যের বেশি হতে হবে।' : 'Exit weight (kg) must be greater than zero.', 'err');
      return;
    }
    if (weighOutForm.mode === 'DIRECT_SALE') {
      const custId = customers.some((c) => c.id === weighOutForm.customer_id) ? weighOutForm.customer_id : customers[0]?.id || 0;
      if (!custId) {
        onNotify(isBn ? 'অনুগ্রহ করে একজন ক্রেতা নির্বাচন করুন।' : 'Select a buyer first.', 'err');
        return;
      }
      if (weighOutNetKg <= 0 || Number(weighOutForm.settlement_rate || 0) <= 0) {
        onNotify(
          isBn ? 'নিট ওজন (ওজন − বাদ) ও বিক্রির দর শূন্যের বেশি হতে হবে।' : 'Net settlement weight and sale rate must be positive.',
          'err'
        );
        return;
      }
      setWeighOutSubmitting(true);
      try {
        await apiMutate({
          endpoint: '/api/v1/paddy-sales',
          payload: {
            customer_id: custId,
            warehouse_id: weighOutBatch.dest_warehouse_id,
            item_id: weighOutBatch.item_id,
            preferred_lot_id: weighOutBatch.lot_id || undefined,
            costing_method: 'FIFO',
            vehicle_no: weighOutForm.vehicle_no,
            challan_no: weighOutForm.challan_no,
            bag_count: weighOutTotalBags,
            jute_bag_count: Math.max(0, Math.round(Number(weighOutForm.jute_bag_count || 0))),
            plastic_bag_count: Math.max(0, Math.round(Number(weighOutForm.plastic_bag_count || 0))),
            moisture_pct: weighOutForm.moisture_pct,
            scale_weight_kg: weighOutForm.scale_weight_kg || weighOutForm.qty_kg,
            qty_kg: weighOutForm.qty_kg,
            payment_weight_kg: weighOutForm.qty_kg,
            weight_loss_kg: weighOutForm.weight_loss_kg,
            settlement_unit_kg: weighOutDivisor,
            settlement_rate: weighOutForm.settlement_rate,
            rate_per_kg: weighOutEffectivePerKg,
            paid_amount: weighOutForm.paid_amount,
            close_pending_lot: weighOutForm.close_lot,
            notes: weighOutForm.notes || `Drying ${weighOutBatch.drying_no} weigh-out sale`,
          },
          module: 'Paddy Drying Weigh-Out Sale',
          summary: `${weighOutBatch.drying_no} weigh-out sale ${weighOutForm.qty_kg} kg (${weighOutTotalBags} bags) · ৳${weighOutTotalValue.toLocaleString('en-IN')}`,
        });
        onNotify(
          isBn
            ? `${weighOutBatch.drying_no} থেকে ${weighOutTotalBags} বস্তা (${weighOutForm.qty_kg} কেজি) ওজন ও দাম বসিয়ে বিক্রি সম্পন্ন হয়েছে।`
            : `Weigh-out sale recorded for ${weighOutBatch.drying_no}.`,
          'ok'
        );
        setWeighOutBatchId(null);
        onRefresh();
      } catch (err) {
        onNotify((err as Error).message, 'err');
      } finally {
        setWeighOutSubmitting(false);
      }
    } else {
      setWeighOutSubmitting(true);
      try {
        await apiMutate({
          endpoint: `/api/v1/drying-batches/${weighOutBatch.id}/weigh-out`,
          payload: {
            scale_weight_kg: weighOutForm.scale_weight_kg || weighOutForm.qty_kg,
            qty_kg: weighOutForm.qty_kg,
            weight_loss_kg: weighOutForm.weight_loss_kg,
            exit_bags: weighOutTotalBags,
            bag_count: weighOutTotalBags,
            settlement_unit_kg: weighOutDivisor,
            settlement_rate: weighOutForm.settlement_rate,
            close_lot: weighOutForm.close_lot,
            notes: weighOutForm.notes,
          },
          module: 'Paddy Drying Weigh-Out',
          summary: `${weighOutBatch.drying_no} weighed out ${weighOutForm.qty_kg} kg (${weighOutTotalBags} bags)`,
        });
        onNotify(
          isBn
            ? `${weighOutBatch.drying_no} থেকে ${weighOutTotalBags} বস্তা (${weighOutForm.qty_kg} কেজি) ওজন করে সক্রিয় স্টকে যুক্ত করা হয়েছে।`
            : `Weighed stock created from ${weighOutBatch.drying_no}.`,
          'ok'
        );
        setWeighOutBatchId(null);
        onRefresh();
      } catch (err) {
        onNotify((err as Error).message, 'err');
      } finally {
        setWeighOutSubmitting(false);
      }
    }
  };

  const handleClosePendingDrying = async (d: DryingBatch) => {
    try {
      await apiMutate({
        endpoint: `/api/v1/drying-batches/${d.id}/close-pending`,
        payload: {},
        module: 'Paddy Drying Close',
        summary: `Close pending drying batch ${d.drying_no}`,
      });
      onNotify(
        isBn ? `${d.drying_no} লটটি সম্পূর্ণ ক্লোজ করা হয়েছে।` : `Pending lot for ${d.drying_no} closed.`,
        'ok'
      );
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const handleCreateDrying = async (e: React.FormEvent) => {
    e.preventDefault();
    if (dryForm.input_qty_kg <= 0) {
      onNotify(isBn ? 'ভেজা ধানের ইনপুট ওজন (কেজি) দিন।' : 'Enter wet paddy input weight (kg).', 'err');
      return;
    }
    if (dryForm.weight_pending && dryForm.output_bags <= 0) {
      onNotify(isBn ? 'ওজন ছাড়া গোডাউনে রাখতে শুকনো বস্তার সংখ্যা দিন।' : 'Enter dried bag count when storing unweighed.', 'err');
      return;
    }
    if (!dryForm.weight_pending && dryForm.output_qty_kg <= 0) {
      onNotify(isBn ? 'শুকনো আউটপুট ওজন (কেজি) দিন।' : 'Enter dried output weight (kg).', 'err');
      return;
    }
    const selectedPurchaseEntry = selectedDryPurchaseId
      ? rawWetPurchases.find((r) => r.purchase.id === selectedDryPurchaseId)
      : undefined;
    const pinnedLot = selectedPurchaseEntry?.matchingLots.find((l) => l.warehouse_id === effectiveDrySourceWh);

    try {
      const res = await apiMutate({
        endpoint: '/api/v1/drying-batches',
        payload: {
          ...dryForm,
          purchase_id: selectedDryPurchaseId > 0 ? selectedDryPurchaseId : undefined,
          preferred_lot_id: pinnedLot?.id || undefined,
          output_qty_kg: dryForm.weight_pending ? 0 : dryForm.output_qty_kg,
          source_warehouse_id: effectiveDrySourceWh,
          dest_warehouse_id: effectiveDryDestWh,
          item_id: effectiveDryPaddyId,
        },
        module: 'Paddy Drying',
        summary: dryForm.weight_pending
          ? `${dryForm.drying_method} ${dryForm.input_qty_kg} kg -> ${dryForm.output_bags} bags (weight pending)`
          : `${dryForm.drying_method} ${dryForm.input_qty_kg} kg -> ${dryForm.output_qty_kg} kg`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: শুকানোর সাইকেল IndexedDB-তে সংরক্ষিত।' : 'Offline: Drying cycle queued in IndexedDB.', 'warn');
      } else {
        onNotify(
          dryForm.weight_pending
            ? isBn
              ? `শুকনো ধান (${dryForm.output_bags} বস্তা) ওজন ছাড়া গোডাউনে সংরক্ষিত হয়েছে। বের হওয়ার সময় ওজন ও দাম বসাতে পারবেন।`
              : `Dried paddy (${dryForm.output_bags} bags) stored unweighed; weigh and price at exit.`
            : isBn
              ? 'ধান শুকানোর সাইকেল সম্পন্ন হয়েছে ও স্টক আপডেট হয়েছে।'
              : 'Paddy drying cycle completed and dried lot stocked.',
          'ok'
        );
      }
      setSelectedDryPurchaseId(0);
      setDryForm((prev) => ({
        ...prev,
        input_qty_kg: 0,
        input_bags: 0,
        initial_moisture_pct: 0,
        final_moisture_pct: 0,
        output_qty_kg: 0,
        output_bags: 0,
        fuel_power_cost: 0,
        labor_cost: 0,
        notes: '',
      }));
      setShowDryingForm(false);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  return (
    <div className="space-y-5">
      {/* Header Tabs & Primary Action */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
          <button
            onClick={() => setSubTab('milling')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'milling' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {isBn ? 'ক্রাশিং ও মিলিং (ধাপে ধাপে)' : t('prd.tabMilling')}
          </button>
          <button
            onClick={() => setSubTab('chatal')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'chatal' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {isBn ? `চাতাল ও খামাল (${chatalBatches.length})` : `Chatal & Khamal (${chatalBatches.length})`}
          </button>
          <button
            onClick={() => setSubTab('drying')}
            className={`px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              subTab === 'drying' ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            {t('prd.tabDrying')}
          </button>
        </div>

        {subTab === 'milling' ? (
          <button
            onClick={() => setShowBatchForm(!showBatchForm)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>{showBatchForm ? t('common.close') : isBn ? 'ধাপ ১: ডায়ারে ধান দিন' : 'Step 1: Issue Paddy to Dryer'}</span>
          </button>
        ) : subTab === 'chatal' ? (
          <button
            onClick={() => setShowChatalForm(!showChatalForm)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>{showChatalForm ? t('common.close') : isBn ? 'চাটালে ধান ঢালুন' : 'Pour Paddy onto Chatal'}</span>
          </button>
        ) : (
          <button
            onClick={() => setShowDryingForm(!showDryingForm)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>{showDryingForm ? t('common.close') : t('prd.newDrying')}</span>
          </button>
        )}
      </div>

      {subTab === 'milling' && (
        <>
          {/* STEP 1 FORM */}
          {showBatchForm && (
            <form
              onSubmit={handleCreateStep1Issue}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 md:p-6 space-y-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
                <div className="flex items-center gap-2.5">
                  <span className="px-2.5 py-1 rounded-md bg-amber-600 text-white text-[11px] font-bold">
                    {isBn ? 'ধাপ ১' : 'STEP 1'}
                  </span>
                  <div>
                    <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                      {isBn ? 'ডায়ারে ধান দেওয়া (চলমান ব্যাচ শুরু)' : 'Issue Paddy to Dryer (Start Running Batch)'}
                    </h3>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                <div>
                  <label className="block text-xs font-medium mb-1">{t('prd.processType')}</label>
                  <select
                    value={batchForm.process_type}
                    onChange={(e) => setBatchForm({ ...batchForm, process_type: e.target.value as ProcessType })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="PARBOILED_SIDDHO">{t('dash.siddho')}</option>
                    <option value="RAW_ATAP">{t('dash.atap')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('prd.sourceGodown')}</label>
                  <select
                    value={effectiveSourceWh}
                    onChange={(e) => setBatchForm({ ...batchForm, source_warehouse_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('prd.inputVariety')}</label>
                  <select
                    value={effectivePaddyItemId}
                    onChange={(e) => setBatchForm({ ...batchForm, paddy_item_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {paddyItems.length === 0 ? (
                      <option value={0}>{t('proc.noPaddy')}</option>
                    ) : (
                      paddyItems.map((i) => {
                        const st = itemStockMap.get(`${effectiveSourceWh}-${i.id}`);
                        const stockLabel =
                          st && st.weightKg > 0 ? ` (${st.bags} ${isBn ? 'বস্তা' : 'bags'} · ${st.weightKg.toLocaleString()} kg)` : '';
                        return (
                          <option key={i.id} value={i.id}>
                            {i.name}
                            {stockLabel}
                          </option>
                        );
                      })
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'ডায়ার সংখ্যা' : 'Dryer Count'}</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0.5"
                    required
                    value={batchForm.dryer_count}
                    onChange={(e) => setBatchForm({ ...batchForm, dryer_count: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'ডায়ার নং / নাম' : 'Dryer No. / Name'}</label>
                  <input
                    type="text"
                    list="dryer-presets"
                    value={batchForm.dryer_no}
                    onChange={(e) => setBatchForm({ ...batchForm, dryer_no: e.target.value })}
                    placeholder={isBn ? 'ডায়ার নং' : 'Dryer no'}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                  <datalist id="dryer-presets">
                    <option value="ডায়ার-১" />
                    <option value="ডায়ার-২" />
                    <option value="ডায়ার-৩" />
                    <option value="Dryer-1" />
                    <option value="Dryer-2" />
                    <option value="Dryer-3" />
                  </datalist>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium">{isBn ? 'যত বস্তা যাচ্ছে (বস্তা)' : 'Going Bags Count'}</label>
                    {selectedStock.bags > 0 && (
                      <button
                        type="button"
                        onClick={handleFillAllStock}
                        className="text-[11px] font-medium text-amber-700 dark:text-amber-400 hover:underline"
                      >
                        {isBn ? `সব (${selectedStock.bags})` : `All (${selectedStock.bags})`}
                      </button>
                    )}
                  </div>
                  <input
                    type="number"
                    min="1"
                    required
                    value={batchForm.input_bag_count}
                    onChange={(e) => handleBagChange(Number(e.target.value))}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'যত ওজন যাচ্ছে (কেজি)' : 'Going Weight (kg)'}</label>
                  <input
                    type="number"
                    step="0.01"
                    min="1"
                    required
                    value={batchForm.input_paddy_qty_kg}
                    onChange={(e) => setBatchForm({ ...batchForm, input_paddy_qty_kg: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'ডিভাইজর (৭৫.৫)' : 'Unit Divisor (75.5)'}</label>
                  <input
                    type="number"
                    step="0.1"
                    min="1"
                    value={batchForm.unit_divisor}
                    onChange={(e) => setBatchForm({ ...batchForm, unit_divisor: Number(e.target.value) || 75.5 })}
                    className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{isBn ? 'কস্টিং পদ্ধতি' : 'Costing Method'}</label>
                  <select
                    value={batchForm.costing_method}
                    onChange={(e) => setBatchForm({ ...batchForm, costing_method: e.target.value as CostingMethod })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="FIFO">FIFO</option>
                    <option value="WEIGHTED_AVERAGE">Weighted Avg</option>
                  </select>
                </div>
              </div>

              {/* Live Formula Card */}
              <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 p-4">
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 text-xs">
                  <div>
                    <div className="text-slate-500 dark:text-slate-400">
                      {isBn ? 'গোডাউনে বর্তমান মজুদ' : 'Godown Stock Available'}
                    </div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                      {selectedStock.bags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'} ·{' '}
                      {selectedStock.weightKg.toLocaleString('en-IN', { maximumFractionDigits: 2 })} kg
                    </div>
                    <div className="font-mono text-[11px] text-slate-500">
                      {isBn ? 'মোট মূল্য:' : 'Value:'} ৳
                      {selectedStock.value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500 dark:text-slate-400">
                      {isBn ? `মজুদ একক = (ওজন−বস্তা)÷${selectedStock.safeDiv}` : `Stock Units (Wt−Bags)÷${selectedStock.safeDiv}`}
                    </div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                      {selectedStock.stockNetUnits.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500 dark:text-slate-400">{isBn ? 'বস্তার একক মূল্য' : 'Bag Unit Rate'}</div>
                    <div className="font-mono font-bold text-amber-700 dark:text-amber-400 mt-0.5">
                      ৳{selectedStock.bagUnitRate.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                  <div>
                    <div className="text-slate-500 dark:text-slate-400">
                      {isBn
                        ? `যাচ্ছে একক = (${batchForm.input_paddy_qty_kg}−${batchForm.input_bag_count})÷${selectedStock.safeDiv}`
                        : `Going Units (Wt−Bags)÷${selectedStock.safeDiv}`}
                    </div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                      {selectedStock.goingUnits.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}
                    </div>
                  </div>
                  <div className="bg-white dark:bg-slate-900 rounded-lg px-3 py-2 border border-amber-300 dark:border-amber-800">
                    <div className="text-[11px] font-medium text-amber-800 dark:text-amber-300">
                      {isBn ? 'ধানের মোট মূল্য যাবে' : 'Total Paddy Cost'}
                    </div>
                    <div className="font-mono text-base font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">
                      ৳{selectedStock.estCost.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-end">
                <div className="flex-1">
                  <label className="block text-xs font-medium mb-1">
                    {isBn ? 'নোট / ডায়ার লোডিং মন্তব্য (ঐচ্ছিক)' : 'Dryer Loading Notes (Optional)'}
                  </label>
                  <input
                    type="text"
                    value={batchForm.notes}
                    onChange={(e) => setBatchForm({ ...batchForm, notes: e.target.value })}
                    placeholder={isBn ? 'মন্তব্য' : 'Notes'}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <button
                  type="submit"
                  className="px-5 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold whitespace-nowrap shadow-sm"
                >
                  {isBn ? 'ডায়ারে ধান দিন (ধাপ ১ শুরু করুন)' : 'Issue Paddy to Dryer (Start Step 1)'}
                </button>
              </div>
            </form>
          )}

          {/* STEP 2 & 3 ACTIVE DRYER CARDS */}
          {activeBatches.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Layers className="w-4 h-4 text-amber-600" />
                  <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                    {isBn
                      ? `চলমান ডায়ার ও ক্রাশিং ব্যাচসমূহ (${activeBatches.length}টি) — ধাপ ২ ও ধাপ ৩`
                      : `Active Dryer / Crushing Batches (${activeBatches.length}) — Step 2 & 3`}
                  </h3>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {activeBatches.map((b) => {
                  const paddyCost = Number(b.cost_sheet?.raw_paddy_cost ?? b.paddy_formula_cost ?? 0);
                  const totalExpenses = getOverheadTotal(b);
                  const runningGross = Number(b.cost_sheet?.gross_batch_cost ?? paddyCost + totalExpenses);
                  const expenseCount = b.expense_logs?.length || 0;
                  const inputCount = b.input_logs?.length || 1;
                  const unpaidDue = Number(b.profit_summary?.unpaid_expense_due || 0);
                  const latestExp = b.expense_logs?.[0];

                  return (
                    <div
                      key={b.id}
                      className="bg-white dark:bg-slate-900 border-2 border-amber-300/80 dark:border-amber-800/70 rounded-xl p-4 space-y-3.5 shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-bold text-sm text-slate-900 dark:text-white">{b.batch_no}</span>
                            <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 text-[10px] font-semibold">
                              {b.process_type === 'PARBOILED_SIDDHO' ? t('dash.siddho') : t('dash.atap')}
                            </span>
                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">
                              <Wind className="w-3.5 h-3.5 text-amber-600" />
                              {b.dryer_count || 1} {isBn ? 'ডায়ার' : 'Dryer'} · {b.dryer_no || 'ডায়ার-১'}
                            </span>
                            {unpaidDue > 0 && (
                              <span className="px-2 py-0.5 rounded bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300 text-[10px] font-semibold">
                                {isBn ? `বাকি খরচ: ৳${unpaidDue.toLocaleString('en-IN')}` : `Due Exp: ৳${unpaidDue.toLocaleString('en-IN')}`}
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {b.paddy_item_name} · {b.source_warehouse_name}
                          </div>
                        </div>
                        <button
                          onClick={() => setSheetBatchId(b.id)}
                          className="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-medium"
                        >
                          {t('prd.viewCostSheet')}
                        </button>
                      </div>

                      {/* 3-Step Visual Stepper inside Card */}
                      <div className="grid grid-cols-3 gap-1.5 text-[11px]">
                        <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900 px-2.5 py-1.5 text-emerald-800 dark:text-emerald-300 font-medium">
                          ✓ {isBn ? `১. ধান (${inputCount}বার)` : `1. Paddy (${inputCount}x)`}
                        </div>
                        <div
                          className={`rounded-lg border px-2.5 py-1.5 font-medium ${
                            totalExpenses > 0
                              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-300 dark:border-emerald-800 text-emerald-800 dark:text-emerald-300'
                              : 'bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300'
                          }`}
                        >
                          {isBn ? `২. খরচ (${expenseCount}বার)` : `2. Exp (${expenseCount}x)`}
                        </div>
                        <div className="rounded-lg bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 px-2.5 py-1.5 text-slate-600 dark:text-slate-300 font-medium">
                          {isBn ? '৩. আউটপুট বাকি' : '3. Output Pending'}
                        </div>
                      </div>

                      {/* Cost & Weight Snapshot */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-2.5 text-xs">
                        <div>
                          <div className="text-[10px] text-slate-500">{isBn ? 'মোট বস্তা ও ওজন' : 'Total Bags & Wt'}</div>
                          <div className="font-mono font-semibold text-slate-900 dark:text-white">
                            {(b.input_bag_count || 0).toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'b'} · {b.input_paddy_qty_kg.toLocaleString('en-IN')} kg
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-slate-500">{isBn ? 'ধানের মূল্য (ধাপ ১)' : 'Paddy Cost (S1)'}</div>
                          <div className="font-mono font-semibold text-slate-900 dark:text-white">
                            ৳{paddyCost.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-slate-500">{isBn ? 'মোট খরচ (ধাপ ২)' : 'Expenses (S2)'}</div>
                          <div className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                            +৳{totalExpenses.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                          </div>
                        </div>
                        <div>
                          <div className="text-[10px] text-slate-500">{isBn ? 'চলমান মোট খরচ' : 'Running Total Cost'}</div>
                          <div className="font-mono font-bold text-amber-700 dark:text-amber-400">
                            ৳{runningGross.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                          </div>
                        </div>
                      </div>

                      {latestExp && (
                        <div className="text-[11px] text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/50 rounded px-2.5 py-1.5 flex items-center justify-between gap-2">
                          <span className="truncate">
                            {isBn ? 'সর্বশেষ খরচ:' : 'Latest:'}{' '}
                            <strong className="text-slate-700 dark:text-slate-200">
                              {getPurposeLabel(latestExp.expense_category)}
                              {latestExp.vendor_name ? ` (${latestExp.vendor_name})` : ''}
                            </strong>
                          </span>
                          <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400 shrink-0">
                            +৳{Number(latestExp.total_amount || 0).toLocaleString('en-IN')}
                            {latestExp.payment_status !== 'PAID' && (
                              <span className="ml-1 text-red-600 dark:text-red-400">
                                ({isBn ? 'বাকি' : 'Due'})
                              </span>
                            )}
                          </span>
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
                        <button
                          onClick={() => openAddPaddyModal(b)}
                          className="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/50 text-xs font-semibold"
                        >
                          <PackagePlus className="w-3.5 h-3.5" />
                          <span>{isBn ? '+ আরও ধান দিন' : '+ Add Paddy'}</span>
                        </button>
                        <button
                          onClick={() => openExpenseModal(b)}
                          className="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-800 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 text-xs font-semibold"
                        >
                          <Coins className="w-3.5 h-3.5" />
                          <span>{isBn ? '+ খরচ / বাকি শোধ' : '+ Expense / Pay'}</span>
                        </button>
                        <button
                          onClick={() => openCompleteModal(b)}
                          className="inline-flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>{isBn ? 'আউটপুট ও শেষ (ধাপ ৩)' : 'Finish & Output'}</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* All Production Batches Table */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                {isBn ? 'সকল ক্রাশিং ও ডায়ার ব্যাচ তালিকা (খরচ ও বিক্রির লাভ-লস সহ)' : 'All Crushing & Dryer Batches (With Sales P&L)'}
              </h3>
              <span className="text-[11px] text-slate-500 font-mono">
                {batches.length} {isBn ? 'টি ব্যাচ' : 'batches'}
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <th className="text-left px-4 py-3 font-medium">{t('prd.batchNo')}</th>
                    <th className="text-left px-4 py-3 font-medium">{isBn ? 'প্রক্রিয়া, জাত ও ডায়ার' : 'Process, Variety & Dryer'}</th>
                    <th className="text-right px-4 py-3 font-medium">{isBn ? 'বস্তা ও ওজন (ধাপ ১)' : 'Bags & Wt (S1)'}</th>
                    <th className="text-right px-4 py-3 font-medium">{isBn ? 'মোট খরচ ও বাকি' : 'Cost & Due'}</th>
                    <th className="text-right px-4 py-3 font-medium">{isBn ? 'উৎপাদন (চাল/উপজাত)' : 'Output'}</th>
                    <th className="text-right px-4 py-3 font-medium">{isBn ? 'বিক্রি ও ডায়ার লাভ/লস' : 'Sales & Dryer P&L'}</th>
                    <th className="text-right px-4 py-3 font-medium">{isBn ? 'কার্যক্রম ও কস্ট শিট' : 'Actions & Sheet'}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {batches.map((b) => {
                    const bags = Number(b.input_bag_count || 0);
                    const paddyCost = Number(b.cost_sheet?.raw_paddy_cost ?? b.paddy_formula_cost ?? 0);
                    const expTotal = getOverheadTotal(b);
                    const expCount = b.expense_logs?.length || 0;
                    const ps = b.profit_summary;
                    const unpaidDue = Number(ps?.unpaid_expense_due || 0);
                    const realizedPnl = Number(ps?.realized_profit_loss || 0);
                    const soldRev = Number(ps?.total_sold_revenue || 0);

                    return (
                      <tr key={b.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="px-4 py-3">
                          <div className="font-mono font-medium text-slate-900 dark:text-white">{b.batch_no}</div>
                          <span
                            className={`inline-block mt-1 px-2 py-0.5 rounded text-[10px] font-medium ${
                              b.status === 'IN_PROGRESS'
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                                : 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                            }`}
                          >
                            {b.status === 'IN_PROGRESS'
                              ? isBn
                                ? 'ধাপ ২/৩ চলমান'
                                : 'STEP 2/3 ACTIVE'
                              : isBn
                              ? '৩ ধাপ সম্পন্ন'
                              : 'COMPLETED'}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5 font-medium text-slate-800 dark:text-slate-200">
                            {b.process_type === 'PARBOILED_SIDDHO' ? (
                              <Flame className="w-3.5 h-3.5 text-amber-600" />
                            ) : (
                              <Sun className="w-3.5 h-3.5 text-emerald-600" />
                            )}
                            <span>{b.process_type === 'PARBOILED_SIDDHO' ? t('dash.siddho') : t('dash.atap')}</span>
                          </div>
                          <div className="text-slate-500">{b.paddy_item_name}</div>
                          <div className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400 font-medium mt-0.5">
                            <Wind className="w-3 h-3" />
                            <span>
                              {b.dryer_count || 1} {isBn ? 'ডায়ার' : 'Dryer'} · {b.dryer_no || 'ডায়ার-১'}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          <div className="font-semibold text-slate-900 dark:text-white">
                            {bags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'}
                          </div>
                          <div className="text-slate-500">
                            {b.input_paddy_qty_kg.toLocaleString('en-IN')} {t('common.kg')}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          <div className="font-semibold text-slate-900 dark:text-white">
                            ৳{(paddyCost + expTotal).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                          </div>
                          <div className="text-[11px] text-emerald-700 dark:text-emerald-400">
                            {isBn ? `খরচ (${expCount}): +৳${expTotal.toLocaleString('en-IN')}` : `Exp (${expCount}): +৳${expTotal.toLocaleString('en-IN')}`}
                          </div>
                          {unpaidDue > 0 && (
                            <div className="text-[10px] font-semibold text-red-600 dark:text-red-400">
                              {isBn ? `বাকি: ৳${unpaidDue.toLocaleString('en-IN')}` : `Due: ৳${unpaidDue.toLocaleString('en-IN')}`}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          {b.status === 'IN_PROGRESS' ? (
                            <span className="text-slate-400">—</span>
                          ) : (
                            <>
                              <div className="font-semibold text-slate-900 dark:text-white">
                                {b.head_rice_qty_kg.toLocaleString()} {t('common.kg')}
                              </div>
                              <div className="text-[11px] text-amber-700 dark:text-amber-400 font-semibold">
                                ৳{b.cost_sheet ? b.cost_sheet.cost_per_kg_head_rice.toFixed(2) : '0.00'}/kg · ৳
                                {b.cost_sheet ? (b.cost_sheet.cost_per_kg_head_rice * 25).toFixed(0) : '0'}/25kg
                              </div>
                              {(() => {
                                const iss = computeIssueMetrics(b);
                                return iss.issue > 0 ? (
                                  <div className="text-[10px] text-emerald-700 dark:text-emerald-400">
                                    {isBn ? 'ইস্যু:' : 'Issue:'} {iss.issue.toFixed(2)}
                                  </div>
                                ) : null;
                              })()}
                            </>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          {b.status === 'IN_PROGRESS' ? (
                            <span className="text-slate-400">—</span>
                          ) : soldRev > 0 ? (
                            <div>
                              <div className="text-[11px] text-slate-600 dark:text-slate-400">
                                {isBn ? 'বিক্রি:' : 'Sold:'} ৳{soldRev.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                              </div>
                              <div
                                className={`inline-flex items-center gap-0.5 font-bold ${
                                  realizedPnl >= 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                                }`}
                              >
                                {realizedPnl >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                                <span>
                                  {realizedPnl >= 0 ? '+' : ''}৳{realizedPnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                </span>
                              </div>
                            </div>
                          ) : (
                            <span className="text-[11px] text-slate-400">{isBn ? 'বিক্রি বাকি' : 'No sales yet'}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5 flex-wrap">
                            {b.status === 'IN_PROGRESS' && (
                              <button
                                onClick={() => openAddPaddyModal(b)}
                                className="inline-flex items-center gap-1 px-2 py-1.5 rounded border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 text-xs font-medium whitespace-nowrap"
                                title={isBn ? 'চলমান ডায়ারে আরও ধান দিন' : 'Add extra paddy'}
                              >
                                <PackagePlus className="w-3.5 h-3.5" />
                                <span>{isBn ? '+ ধান' : '+ Paddy'}</span>
                              </button>
                            )}
                            <button
                              onClick={() => openExpenseModal(b)}
                              className="inline-flex items-center gap-1 px-2 py-1.5 rounded border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-100 dark:hover:bg-emerald-900/50 text-xs font-medium whitespace-nowrap"
                              title={isBn ? 'খরচ যোগ করুন / বাকি শোধ করুন' : 'Add Expense / Pay Due'}
                            >
                              <Coins className="w-3.5 h-3.5" />
                              <span>{unpaidDue > 0 ? (isBn ? 'খরচ / বাকি শোধ' : 'Exp / Pay') : isBn ? '+ খরচ' : '+ Expense'}</span>
                            </button>
                            {b.status === 'IN_PROGRESS' && (
                              <button
                                onClick={() => openCompleteModal(b)}
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium whitespace-nowrap"
                              >
                                <CheckCircle2 className="w-3.5 h-3.5" />
                                <span>{isBn ? 'আউটপুট ও শেষ' : 'Complete'}</span>
                              </button>
                            )}
                            <button
                              onClick={() => setSheetBatchId(b.id)}
                              className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium whitespace-nowrap"
                            >
                              {isBn ? 'কস্ট শিট ও লাভ-লস' : 'Sheet & P&L'}
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

      {subTab === 'chatal' && (
        <ChatalKhamalPanel
          chatalBatches={chatalBatches}
          warehouses={warehouses}
          paddyItems={paddyItems}
          lots={lots}
          purchases={purchases}
          accounts={accounts}
          customers={customers}
          showNewForm={showChatalForm}
          onToggleNewForm={setShowChatalForm}
          onRefresh={onRefresh}
          onNotify={onNotify}
        />
      )}

      {subTab === 'drying' && (
        <div className="space-y-4">
          {/* Raw-to-Dried Paddy Accounting Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <div className="text-xs text-slate-500">{isBn ? 'মোট কাঁচা ধান শুকানো হয়েছে' : 'Total Raw Paddy Dried'}</div>
              <div className="text-xl sm:text-2xl font-display font-bold font-mono tabular-nums mt-1 text-slate-900 dark:text-white">
                {dryingSummaryStats.totalRawInputKg.toLocaleString('en-IN')} {isBn ? 'কেজি' : 'kg'}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
                {dryingSummaryStats.totalRawInputBags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'} · {dryingSummaryStats.batchCount}{' '}
                {isBn ? 'টি ব্যাচ' : 'batches'}
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <div className="text-xs text-slate-500">{isBn ? 'মোট শুকনো ধান পাওয়া গেছে' : 'Total Dried Paddy Obtained'}</div>
              <div className="text-xl sm:text-2xl font-display font-bold font-mono tabular-nums mt-1 text-emerald-700 dark:text-emerald-400">
                {dryingSummaryStats.weighedOutputKg.toLocaleString('en-IN')} {isBn ? 'কেজি' : 'kg'}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
                {dryingSummaryStats.totalStoredOutputBags.toLocaleString('en-IN')} {isBn ? 'বস্তা জমা' : 'bags stored'}
                {dryingSummaryStats.pendingBags > 0
                  ? ` · ${isBn ? 'ওজন বাকি' : 'Pending'}: ${dryingSummaryStats.pendingBags} ${isBn ? 'বস্তা' : 'b'}`
                  : ''}
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <div className="text-xs text-slate-500">{isBn ? 'শুকানোর ঘাটতি (শুখতি)' : 'Drying Moisture Loss'}</div>
              <div className="text-xl sm:text-2xl font-display font-bold font-mono tabular-nums mt-1 text-amber-700 dark:text-amber-400">
                −{dryingSummaryStats.totalMoistureLossKg.toLocaleString('en-IN')} {isBn ? 'কেজি' : 'kg'}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
                {dryingSummaryStats.weighedInputKg > 0
                  ? isBn
                    ? `শুখতি ${dryingSummaryStats.lossPct}% (${dryingSummaryStats.weighedInputKg.toLocaleString('en-IN')} kg থেকে)`
                    : `${dryingSummaryStats.lossPct}% loss on ${dryingSummaryStats.weighedInputKg.toLocaleString('en-IN')} kg weighed`
                  : isBn
                  ? 'ওজন সম্পন্ন হলে ঘাটতি হিসাব হবে'
                  : 'Calculated once exit weights are recorded'}
              </div>
            </div>

            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
              <div className="text-xs text-slate-500">{isBn ? 'শুকনো প্রাপ্তি ও বাকি কাঁচা ধান' : 'Dried Yield & Pending Raw'}</div>
              <div className="text-xl sm:text-2xl font-display font-bold font-mono tabular-nums mt-1 text-slate-900 dark:text-white">
                {dryingSummaryStats.weighedInputKg > 0 ? `${dryingSummaryStats.yieldPct}%` : '—'}
              </div>
              <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
                {isBn
                  ? `শুকানো বাকি: ${dryingSummaryStats.remainingRawToDryBags} বস্তা / ${dryingSummaryStats.remainingRawToDryKg.toLocaleString('en-IN')} kg`
                  : `Pending raw: ${dryingSummaryStats.remainingRawToDryBags}b / ${dryingSummaryStats.remainingRawToDryKg.toLocaleString('en-IN')} kg`}
              </div>
            </div>
          </div>

          {showDryingForm && (
            <form
              onSubmit={handleCreateDrying}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                    {isBn ? 'ধান শুকানো ও গোডাউনে সংরক্ষণ' : 'Paddy Drying & Godown Storage'}
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    {isBn
                      ? 'শুকানোর পর ওজন না দিয়েই শুধু বস্তার সংখ্যায় গোডাউনে রাখতে পারবেন; বের হওয়ার সময় ওজন ও দাম বসাতে পারবেন (ছেঁড়া বস্তার কারণে বেশি বস্তাও অনুমোদিত)।'
                      : 'Store dried paddy in godown by bag count without weighing; weigh & price at exit (extra torn bags permitted).'}
                  </p>
                </div>
                <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 text-xs font-semibold text-amber-900 dark:text-amber-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={dryForm.weight_pending}
                    onChange={(e) => setDryForm({ ...dryForm, weight_pending: e.target.checked })}
                    className="rounded border-amber-400 text-amber-600 focus:ring-amber-500"
                  />
                  <span>
                    {isBn
                      ? 'ওজন ছাড়া শুধু বস্তায় স্টক রাখুন (বের হওয়ার সময় ওজন ও দাম)'
                      : 'Store unweighed by bag count (weigh & price at exit)'}
                  </span>
                </label>
              </div>

              <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-3">
                <label className="text-xs font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                  {isBn ? 'কেনা কাঁচা ধানের চালান বাছুন (শুকানোর জন্য):' : 'Select Raw/Wet Purchased Paddy:'}
                </label>
                <select
                  value={selectedDryPurchaseId}
                  onChange={(e) => {
                    const pId = Number(e.target.value);
                    setSelectedDryPurchaseId(pId);
                    const entry = rawWetPurchases.find((x) => x.purchase.id === pId);
                    if (!entry) return;
                    const pur = entry.purchase;
                    const srcWhId = entry.matchingLots[0]?.warehouse_id || pur.splits?.[0]?.warehouse_id || pur.warehouse_id;
                    const matchingLot = entry.matchingLots.find((l) => l.warehouse_id === srcWhId) || entry.matchingLots[0];
                    const availKg = matchingLot ? Number(matchingLot.remaining_qty_kg || 0) : entry.remKg;
                    const availBags = matchingLot ? Number(matchingLot.remaining_bags || entry.remBags || 0) : entry.remBags;
                    setDryForm((prev) => ({
                      ...prev,
                      source_warehouse_id: srcWhId,
                      item_id: pur.item_id,
                      input_qty_kg: Number(availKg.toFixed(2)),
                      input_bags: availBags,
                      output_bags: availBags,
                      initial_moisture_pct: Number(pur.moisture_pct || 18),
                      notes: `${pur.purchase_no} · ${pur.supplier_name}`,
                    }));
                  }}
                  className="flex-1 min-w-[240px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                >
                  <option value={0}>
                    {rawWetPurchases.length > 0
                      ? isBn
                        ? `— কাঁচা কেনা চালান বাছুন (${rawWetPurchases.length}টি বাকি) অথবা গোডাউন থেকে নিন —`
                        : `— Select raw purchased receipt (${rawWetPurchases.length} available) —`
                      : isBn
                      ? '— কোনো কাঁচা কেনা চালান বাকি নেই (ম্যানুয়াল বা গোডাউন স্টক নিন) —'
                      : '— No raw/wet purchased paddy pending drying —'}
                  </option>
                  {rawWetPurchases.slice(0, 60).map(({ purchase: p, remBags, remKg }) => (
                    <option key={p.id} value={p.id}>
                      {p.purchase_no} · {p.supplier_name} · {p.item_name} ({remBags} {isBn ? 'বস্তা' : 'bags'} /{' '}
                      {remKg.toLocaleString('en-IN')} kg বাকি → {p.warehouse_name})
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
                <div>
                  <label className="block text-xs font-medium mb-1">{t('prd.dryingMethod')}</label>
                  <select
                    value={dryForm.drying_method}
                    onChange={(e) => setDryForm({ ...dryForm, drying_method: e.target.value as 'SUN_YARD' | 'MECHANICAL_DRYER' })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="MECHANICAL_DRYER">{t('prd.mechanicalDryer')}</option>
                    <option value="SUN_YARD">{t('prd.sunYard')}</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('prd.sourceToDried')}</label>
                  <div className="flex gap-2">
                    <select
                      value={effectiveDrySourceWh}
                      onChange={(e) => setDryForm({ ...dryForm, source_warehouse_id: Number(e.target.value) })}
                      className="w-1/2 px-2 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.code}
                        </option>
                      ))}
                    </select>
                    <select
                      value={effectiveDryDestWh}
                      onChange={(e) => setDryForm({ ...dryForm, dest_warehouse_id: Number(e.target.value) })}
                      className="w-1/2 px-2 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      {warehouses.map((w) => (
                        <option key={w.id} value={w.id}>
                          {w.code}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('proc.paddyVariety')}</label>
                  <select
                    value={effectiveDryPaddyId}
                    onChange={(e) => setDryForm({ ...dryForm, item_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {paddyItems.length === 0 ? (
                      <option value={0}>{t('proc.noPaddy')}</option>
                    ) : (
                      paddyItems.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('prd.moistureRange')}</label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      step="0.1"
                      placeholder={isBn ? 'আগের %' : 'Initial %'}
                      value={dryForm.initial_moisture_pct}
                      onChange={(e) => setDryForm({ ...dryForm, initial_moisture_pct: Number(e.target.value) })}
                      className="w-1/2 px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                    <input
                      type="number"
                      step="0.1"
                      placeholder={isBn ? 'পরের %' : 'Final %'}
                      value={dryForm.final_moisture_pct}
                      onChange={(e) => setDryForm({ ...dryForm, final_moisture_pct: Number(e.target.value) })}
                      className="w-1/2 px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                </div>

                {(() => {
                  const dryWhStock = itemStockMap.get(`${effectiveDrySourceWh}-${effectiveDryPaddyId}`) || { bags: 0, weightKg: 0, value: 0 };
                  return (
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <label className="block text-xs font-medium">
                          {isBn ? 'ভেজা (কাঁচা) ইনপুট ওজন ও বস্তা *' : 'Raw Wet Input (kg & bags) *'}
                        </label>
                        {dryWhStock.weightKg > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setDryForm((prev) => ({
                                ...prev,
                                input_qty_kg: Number(dryWhStock.weightKg.toFixed(2)),
                                input_bags: dryWhStock.bags,
                                output_bags: dryWhStock.bags > 0 ? dryWhStock.bags : prev.output_bags,
                              }))
                            }
                            className="text-[11px] font-semibold text-amber-700 dark:text-amber-400 hover:underline whitespace-nowrap"
                          >
                            {isBn
                              ? `সব নিন (${dryWhStock.bags}ব / ${dryWhStock.weightKg.toLocaleString('en-IN')}kg)`
                              : `All (${dryWhStock.bags}b / ${dryWhStock.weightKg.toLocaleString('en-IN')}kg)`}
                          </button>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          required
                          placeholder="kg"
                          value={dryForm.input_qty_kg}
                          onChange={(e) => setDryForm({ ...dryForm, input_qty_kg: Number(e.target.value) })}
                          className="w-3/5 px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                        <input
                          type="number"
                          min="0"
                          placeholder={isBn ? 'বস্তা' : 'bags'}
                          value={dryForm.input_bags}
                          onChange={(e) => setDryForm({ ...dryForm, input_bags: Math.max(0, Math.round(Number(e.target.value))) })}
                          className="w-2/5 px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                      </div>
                    </div>
                  );
                })()}

                <div>
                  <label className="block text-xs font-medium mb-1">
                    {isBn ? 'শুকনো জমা বস্তা সংখ্যা *' : 'Stored Dried Bags *'}
                  </label>
                  <input
                    type="number"
                    min={dryForm.weight_pending ? 1 : 0}
                    required={dryForm.weight_pending}
                    value={dryForm.output_bags}
                    onChange={(e) => setDryForm({ ...dryForm, output_bags: Math.max(0, Math.round(Number(e.target.value))) })}
                    className="w-full px-3 py-2 text-xs font-mono font-semibold rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50/40 dark:bg-slate-950"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium mb-1">
                    {isBn ? 'শুকনো আউটপুট ওজন (কেজি)' : 'Dried Output (kg)'}
                  </label>
                  {dryForm.weight_pending ? (
                    <div className="w-full px-3 py-2 text-xs rounded-lg border border-dashed border-amber-300 dark:border-amber-800 bg-amber-50/40 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 font-medium">
                      {isBn ? 'বের হওয়ার সময় ওজন হবে' : 'Weighed at exit'}
                    </div>
                  ) : (
                    <input
                      type="number"
                      min="0.01"
                      step="0.01"
                      required
                      value={dryForm.output_qty_kg}
                      onChange={(e) => setDryForm({ ...dryForm, output_qty_kg: Number(e.target.value) })}
                      className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('prd.fuelPowerCost')}</label>
                    <input
                      type="number"
                      min="0"
                      value={dryForm.fuel_power_cost}
                      onChange={(e) => setDryForm({ ...dryForm, fuel_power_cost: Math.max(0, Number(e.target.value)) })}
                      className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('prd.laborCost')}</label>
                    <input
                      type="number"
                      min="0"
                      value={dryForm.labor_cost}
                      onChange={(e) => setDryForm({ ...dryForm, labor_cost: Math.max(0, Number(e.target.value)) })}
                      className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                </div>
              </div>

              {!dryForm.weight_pending && dryForm.input_qty_kg > 0 && dryForm.output_qty_kg > 0 && dryForm.output_qty_kg <= dryForm.input_qty_kg && (
                <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs font-mono tabular-nums">
                  <span className="text-slate-700 dark:text-slate-300">
                    {isBn ? 'কাঁচা থেকে শুকনো হিসাব:' : 'Raw-to-Dried Preview:'}{' '}
                    <strong>{dryForm.input_qty_kg.toLocaleString('en-IN')} kg</strong> →{' '}
                    <strong className="text-emerald-700 dark:text-emerald-400">{dryForm.output_qty_kg.toLocaleString('en-IN')} kg</strong>
                  </span>
                  <span className="text-amber-700 dark:text-amber-400 font-semibold">
                    {isBn ? 'শুখতি:' : 'Loss:'} −{(dryForm.input_qty_kg - dryForm.output_qty_kg).toFixed(2)} kg (
                    {(((dryForm.input_qty_kg - dryForm.output_qty_kg) / dryForm.input_qty_kg) * 100).toFixed(1)}%) ·{' '}
                    {isBn ? 'প্রাপ্তি:' : 'Yield:'} {((dryForm.output_qty_kg / dryForm.input_qty_kg) * 100).toFixed(1)}%
                  </span>
                </div>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
                <input
                  type="text"
                  value={dryForm.notes}
                  onChange={(e) => setDryForm({ ...dryForm, notes: e.target.value })}
                  placeholder={isBn ? 'শুকানো ও গোডাউন লোকেশন নোট...' : 'Optional drying/godown notes...'}
                  className="flex-1 min-w-[220px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
                <button type="submit" className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold whitespace-nowrap">
                  {dryForm.weight_pending
                    ? isBn
                      ? 'ওজন ছাড়া গোডাউনে জমা করুন'
                      : 'Store Unweighed in Godown'
                    : t('prd.completeDrying')}
                </button>
              </div>
            </form>
          )}

          {/* Drying History & Date-Sort Controls */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="inline-flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => setDryingViewMode('all')}
                  className={`min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    dryingViewMode === 'all'
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {isBn ? `সব ব্যাচ (${dryingViewCounts.all})` : `All Logs (${dryingViewCounts.all})`}
                </button>
                <button
                  type="button"
                  onClick={() => setDryingViewMode('active')}
                  className={`min-h-[38px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    dryingViewMode === 'active'
                      ? 'bg-white dark:bg-slate-900 text-amber-700 dark:text-amber-300 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  {isBn ? `চলমান / ওজন বাকি (${dryingViewCounts.active})` : `Active / Pending (${dryingViewCounts.active})`}
                </button>
                <button
                  type="button"
                  onClick={() => setDryingViewMode('history')}
                  className={`min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    dryingViewMode === 'history'
                      ? 'bg-white dark:bg-slate-900 text-emerald-700 dark:text-emerald-300 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
                  }`}
                >
                  <History className="w-3.5 h-3.5" />
                  <span>{isBn ? `শুকানোর ইতিহাস (${dryingViewCounts.history})` : `History (${dryingViewCounts.history})`}</span>
                </button>
              </div>

              {dryingBatches.length > 0 && (
                <div className="flex flex-wrap items-center gap-4 text-xs font-mono tabular-nums text-slate-600 dark:text-slate-300">
                  <span>
                    {isBn ? 'দেখানো হচ্ছে:' : 'Showing:'}{' '}
                    <strong className="text-slate-900 dark:text-white">{filteredDryingMetrics.count}</strong>
                  </span>
                  <span>
                    {isBn ? 'গড় দক্ষতা:' : 'Avg Efficiency:'}{' '}
                    <strong className="text-emerald-700 dark:text-emerald-400">
                      {filteredDryingMetrics.avgEffPct > 0 ? `${filteredDryingMetrics.avgEffPct}%` : '—'}
                    </strong>
                  </span>
                  <span>
                    {isBn ? 'গড় আর্দ্রতা কম:' : 'Avg MC Drop:'}{' '}
                    <strong className="text-slate-900 dark:text-white">
                      {filteredDryingMetrics.avgMoistureDropPct > 0 ? `−${filteredDryingMetrics.avgMoistureDropPct}%` : '—'}
                    </strong>
                  </span>
                  <span>
                    {isBn ? 'মোট শুখতি:' : 'Vol. Lost:'}{' '}
                    <strong className="text-amber-700 dark:text-amber-400">
                      {filteredDryingMetrics.totalLostKg.toLocaleString('en-IN')} {t('common.kg')}
                    </strong>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                    {isBn ? 'সর্বোচ্চ বয়স:' : 'Max Age:'}{' '}
                    <strong className="text-slate-900 dark:text-white">
                      {filteredDryingMetrics.oldestAgeDays} {isBn ? 'দিন' : 'd'}
                    </strong>
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5 text-xs items-end">
              <div className="lg:col-span-2">
                <label className="block text-[11px] text-slate-500 mb-1">
                  {isBn ? 'খুঁজুন (ব্যাচ / চালান / জাত / গুদাম)' : 'Search (Batch / Receipt / Variety / Godown)'}
                </label>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={dryingSearch}
                    onChange={(e) => setDryingSearch(e.target.value)}
                    placeholder={isBn ? 'DRY-..., PUR-..., জিরা...' : 'Search batch, purchase, variety...'}
                    className="w-full min-h-[38px] pl-8 pr-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-slate-500 mb-1">{isBn ? 'শুকানোর পদ্ধতি' : 'Method'}</label>
                <select
                  value={dryingMethodFilter}
                  onChange={(e) => setDryingMethodFilter(e.target.value as 'ALL' | 'MECHANICAL_DRYER' | 'SUN_YARD')}
                  className="w-full min-h-[38px] px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="ALL">{isBn ? 'সব পদ্ধতি' : 'All Methods'}</option>
                  <option value="MECHANICAL_DRYER">{isBn ? 'মেকানিক্যাল ড্রায়ার' : 'Mechanical Dryer'}</option>
                  <option value="SUN_YARD">{isBn ? 'চাতাল / রোদে' : 'Sun Yard'}</option>
                </select>
              </div>

              <div>
                <label className="block text-[11px] text-slate-500 mb-1">{isBn ? 'শুরু তারিখ' : 'From Date'}</label>
                <input
                  type="date"
                  value={dryingDateFrom}
                  onChange={(e) => setDryingDateFrom(e.target.value)}
                  className="w-full min-h-[38px] px-2.5 py-1.5 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-500 mb-1">{isBn ? 'শেষ তারিখ' : 'To Date'}</label>
                <input
                  type="date"
                  value={dryingDateTo}
                  onChange={(e) => setDryingDateTo(e.target.value)}
                  className="w-full min-h-[38px] px-2.5 py-1.5 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>

              <div>
                <label className="block text-[11px] text-slate-500 mb-1">{isBn ? 'সাজানোর ক্রম' : 'Sort By'}</label>
                <div className="flex items-center gap-1.5">
                  <select
                    value={dryingSortOrder}
                    onChange={(e) =>
                      setDryingSortOrder(e.target.value as 'date_desc' | 'date_asc' | 'efficiency_desc' | 'loss_desc')
                    }
                    className="w-full min-h-[38px] px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="date_desc">{isBn ? 'তারিখ: নতুন আগে' : 'Date: Newest First'}</option>
                    <option value="date_asc">{isBn ? 'তারিখ: পুরনো আগে (বয়স)' : 'Date: Oldest First (Age)'}</option>
                    <option value="efficiency_desc">{isBn ? 'দক্ষতা %: বেশি আগে' : 'Efficiency %: High-Low'}</option>
                    <option value="loss_desc">{isBn ? 'শুখতি (কেজি): বেশি আগে' : 'Volume Loss: High-Low'}</option>
                  </select>
                  {(dryingSearch || dryingMethodFilter !== 'ALL' || dryingDateFrom || dryingDateTo) && (
                    <button
                      type="button"
                      onClick={() => {
                        setDryingSearch('');
                        setDryingMethodFilter('ALL');
                        setDryingDateFrom('');
                        setDryingDateTo('');
                      }}
                      className="min-h-[38px] px-2.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                      title={isBn ? 'ফিল্টার রিসেট' : 'Reset filters'}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <th className="text-left px-4 py-3 font-medium">{t('prd.dryingNo')}</th>
                    <th className="text-left px-4 py-3 font-medium">{isBn ? 'তারিখ ও বয়স' : 'Date & Age'}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('prd.methodVariety')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('prd.wetInput')}</th>
                    <th className="text-right px-4 py-3 font-medium">{isBn ? 'গোডাউনে বস্তা ও বের হওয়া' : 'Stored / Dispatched Bags'}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('prd.driedOutput')}</th>
                    <th className="text-right px-4 py-3 font-medium">{isBn ? 'বের হওয়ার মূল্য / খরচ' : 'Exit Valuation / Cost'}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('common.status')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredDryingBatches.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4 py-10 text-center space-y-2.5">
                        <div className="text-slate-600 dark:text-slate-300 font-medium">
                          {dryingBatches.length === 0
                            ? isBn
                              ? 'এখনো কোনো ধান শুকানোর ব্যাচ রেকর্ড করা হয়নি।'
                              : 'No drying batches recorded yet.'
                            : dryingViewMode === 'history' && dryingViewCounts.active > 0
                            ? isBn
                              ? `এখনো কোনো সম্পন্ন ইতিহাস নেই — ${dryingViewCounts.active}টি ব্যাচ চলমান/ওজন বাকি অবস্থায় আছে।`
                              : `No completed drying history yet — ${dryingViewCounts.active} batch(es) are currently active or awaiting weigh-out.`
                            : isBn
                            ? 'নির্বাচিত ফিল্টার অনুযায়ী কোনো শুকানোর লগ পাওয়া যায়নি।'
                            : 'No drying logs match the active filters.'}
                        </div>
                        <div className="flex items-center justify-center gap-2">
                          {dryingViewMode === 'history' && dryingViewCounts.active > 0 && (
                            <button
                              type="button"
                              onClick={() => setDryingViewMode('active')}
                              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-300 font-semibold hover:bg-amber-50 dark:hover:bg-amber-950/30"
                            >
                              {isBn ? 'চলমান / ওজন বাকি দেখুন' : 'View Active / Pending'}
                            </button>
                          )}
                          {(dryingSearch || dryingMethodFilter !== 'ALL' || dryingDateFrom || dryingDateTo) && (
                            <button
                              type="button"
                              onClick={() => {
                                setDryingSearch('');
                                setDryingMethodFilter('ALL');
                                setDryingDateFrom('');
                                setDryingDateTo('');
                              }}
                              className="min-h-[38px] px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-medium hover:bg-slate-50 dark:hover:bg-slate-800"
                            >
                              {isBn ? 'ফিল্টার মুছুন' : 'Clear Filters'}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ) : (
                    filteredDryingBatches.map((d) => {
                      const isPending = d.status === 'PENDING_WEIGHT' || d.status === 'IN_PROGRESS' || Boolean(d.weight_pending);
                      const storedBags = Number(d.output_bags || 0);
                      const dispBags = Number(d.dispatched_bags || 0);
                      const remBags = Number(d.remaining_bags ?? Math.max(0, storedBags - dispBags));
                      const extraTorn = Number(d.extra_torn_bags || 0);
                      const hasExitVal = Number(d.exit_total_value || 0) > 0;
                      const rowOutKg = Number(d.output_qty_kg || 0);
                      const rowLossKg = Math.max(0, Number(d.moisture_loss_kg ?? d.input_qty_kg - rowOutKg));
                      const rowYieldPct = d.input_qty_kg > 0 && rowOutKg > 0 ? (rowOutKg / d.input_qty_kg) * 100 : 0;
                      const rowLossPct = d.input_qty_kg > 0 && rowOutKg > 0 ? (rowLossKg / d.input_qty_kg) * 100 : 0;
                      const ageDays = getInventoryAgeDays(d.created_at);
                      const isAgingLot = isPending && ageDays >= 7;
                      const methodLabel =
                        d.drying_method === 'MECHANICAL_DRYER'
                          ? isBn
                            ? 'মেকানিক্যাল ড্রায়ার'
                            : 'Mechanical Dryer'
                          : isBn
                          ? 'চাতাল / রোদে'
                          : 'Sun Yard';
                      return (
                        <tr key={d.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="px-4 py-3">
                            <div className="font-mono font-medium text-slate-900 dark:text-white">{d.drying_no}</div>
                            {d.lot_code && <div className="text-[11px] font-mono text-slate-500">{d.lot_code}</div>}
                            {d.purchase_no && (
                              <div className="text-[11px] text-amber-700 dark:text-amber-400 font-medium">
                                {d.purchase_no}
                                {d.supplier_name ? ` · ${d.supplier_name}` : ''}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="font-mono text-slate-800 dark:text-slate-200 flex items-center gap-1">
                              <Calendar className="w-3 h-3 text-slate-400 shrink-0" />
                              <span>{formatShortDbDate(d.created_at, isBn)}</span>
                            </div>
                            <div
                              className={`text-[11px] font-mono tabular-nums mt-0.5 ${
                                isAgingLot
                                  ? 'text-amber-700 dark:text-amber-400 font-semibold'
                                  : 'text-slate-500 dark:text-slate-400'
                              }`}
                            >
                              {ageDays === 0
                                ? isBn
                                  ? 'আজকে'
                                  : 'Today'
                                : isBn
                                ? `${ageDays} দিন বয়স`
                                : `${ageDays}d age`}
                            </div>
                          </td>
                          <td className="px-4 py-3">
                            <div className="font-medium text-slate-900 dark:text-white">{methodLabel}</div>
                            <div className="text-slate-500">
                              {d.item_name}
                              {d.dest_warehouse_name ? ` → ${d.dest_warehouse_name}` : ''}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            <div>
                              {d.input_qty_kg.toLocaleString()} {t('common.kg')}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {Number(d.input_bags || 0) > 0 ? `${d.input_bags} ${isBn ? 'বস্তা' : 'bags'} · ` : ''}
                              {d.initial_moisture_pct}%→{d.final_moisture_pct}%
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            <div className="font-semibold text-slate-900 dark:text-white">
                              {isBn ? `জমা ${storedBags}ব` : `${storedBags}b stored`}
                              {dispBags > 0 ? ` · ${isBn ? `বের ${dispBags}ব` : `${dispBags}b out`}` : ''}
                            </div>
                            <div className="text-[11px] text-slate-500">
                              {isPending ? `${isBn ? 'বাকি' : 'Rem'}: ${remBags}ব` : ''}
                              {extraTorn > 0 && (
                                <span className="ml-1 text-emerald-700 dark:text-emerald-400 font-sans font-semibold">
                                  · +{extraTorn} {isBn ? 'ছেঁড়া বস্তা' : 'torn'}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums font-medium">
                            {rowOutKg > 0 ? (
                              <>
                                <div>
                                  {rowOutKg.toLocaleString()} {t('common.kg')}
                                </div>
                                <div className="text-[11px] text-amber-700 dark:text-amber-400">
                                  −{rowLossKg.toLocaleString()} {t('common.kg')} ({rowLossPct.toFixed(1)}%) ·{' '}
                                  <span className="text-emerald-700 dark:text-emerald-400">
                                    {isBn ? 'প্রাপ্তি' : 'Yield'} {rowYieldPct.toFixed(1)}%
                                  </span>
                                </div>
                              </>
                            ) : (
                              <span className="font-sans text-[11px] text-amber-700 dark:text-amber-400 font-medium">
                                {isBn ? 'ওজন অপেক্ষমাণ' : 'Awaiting Weigh-Out'}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            {hasExitVal ? (
                              <>
                                <div className="font-semibold text-emerald-700 dark:text-emerald-400">
                                  ৳{Number(d.exit_total_value || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                                </div>
                                {Number(d.exit_settlement_rate || 0) > 0 && (
                                  <div className="text-[11px] text-slate-500">
                                    @৳{Number(d.exit_settlement_rate).toLocaleString('en-IN')}/{d.exit_settlement_unit_kg || 75.5}
                                  </div>
                                )}
                              </>
                            ) : isPending ? (
                              <div className="text-slate-600 dark:text-slate-300">
                                {isBn ? 'ব্যয়:' : 'Cost:'} ৳
                                {Number(
                                  d.pending_cost_total ||
                                    Number(d.input_paddy_cost || 0) + Number(d.fuel_power_cost || 0) + Number(d.labor_cost || 0)
                                ).toLocaleString('en-IN')}
                              </div>
                            ) : (
                              <div className="font-semibold">
                                ৳{Number(d.output_unit_cost_per_kg || 0).toFixed(2)}/{t('common.kg')}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            {isPending ? (
                              <span className="text-amber-700 dark:text-amber-400 text-xs font-semibold whitespace-nowrap">
                                {isBn ? 'ওজন পেন্ডিং' : 'Pending Weight'}
                              </span>
                            ) : (
                              <span className="text-emerald-700 dark:text-emerald-400 text-xs font-semibold whitespace-nowrap">
                                {isBn ? 'সম্পন্ন' : 'Completed'}
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            {isPending ? (
                              <div className="inline-flex items-center gap-1.5">
                                <button
                                  type="button"
                                  onClick={() => openWeighOutModal(d)}
                                  className="px-2.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-semibold whitespace-nowrap"
                                >
                                  {isBn ? 'ওজন ও দাম বসান' : 'Weigh-Out & Price'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void handleClosePendingDrying(d)}
                                  className="px-2 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-medium"
                                  title={isBn ? 'লটটি ক্লোজ করুন' : 'Close pending lot'}
                                >
                                  {isBn ? 'ক্লোজ' : 'Close'}
                                </button>
                              </div>
                            ) : (
                              <span className="text-[11px] text-slate-400">—</span>
                            )}
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

      {/* ADD EXTRA PADDY TO RUNNING DRYER MODAL */}
      {addPaddyBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <form
            onSubmit={handleAddExtraPaddy}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-xl w-full p-5 md:p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-start justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h4 className="text-base font-display font-semibold text-slate-900 dark:text-white">
                  {isBn ? `চলমান ডায়ারে আরও ধান যোগ — ${addPaddyBatch.batch_no}` : `Add Extra Paddy — ${addPaddyBatch.batch_no}`}
                </h4>
                <p className="text-xs text-slate-500">
                  {addPaddyBatch.dryer_no || 'ডায়ার-১'} ·{' '}
                  {isBn ? 'নতুন কেনা বা অন্য গুদামের ধান এই চলমান ব্যাচে যোগ করুন' : 'Feed additional paddy stock into this running dryer'}
                </p>
              </div>
              <button type="button" onClick={() => setAddPaddyBatchId(null)} className="p-1 text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium mb-1">{t('prd.sourceGodown')}</label>
                <select
                  value={effectiveAddPaddyWh}
                  onChange={(e) => setAddPaddyForm({ ...addPaddyForm, source_warehouse_id: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {warehouses.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">{t('prd.inputVariety')}</label>
                <select
                  value={effectiveAddPaddyItemId}
                  onChange={(e) => setAddPaddyForm({ ...addPaddyForm, paddy_item_id: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {paddyItems.map((i) => {
                    const st = itemStockMap.get(`${effectiveAddPaddyWh}-${i.id}`);
                    return (
                      <option key={i.id} value={i.id}>
                        {i.name} {st && st.weightKg > 0 ? `(${st.bags}ব · ${st.weightKg.toLocaleString()} kg)` : ''}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'অতিরিক্ত বস্তা সংখ্যা' : 'Extra Bags'}</label>
                <input
                  type="number"
                  min="1"
                  required
                  value={addPaddyForm.bag_count}
                  onChange={(e) => {
                    const b = Math.max(0, Math.round(Number(e.target.value)));
                    const kg = addPaddyStock.bags > 0 ? Math.round((b * addPaddyStock.weightKg) / addPaddyStock.bags) : b * 60;
                    setAddPaddyForm({ ...addPaddyForm, bag_count: b, qty_kg: kg > 0 ? kg : addPaddyForm.qty_kg });
                  }}
                  className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'অতিরিক্ত ওজন (কেজি)' : 'Extra Weight (kg)'}</label>
                <input
                  type="number"
                  step="0.01"
                  min="1"
                  required
                  value={addPaddyForm.qty_kg}
                  onChange={(e) => setAddPaddyForm({ ...addPaddyForm, qty_kg: Number(e.target.value) })}
                  className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 p-3 flex items-center justify-between text-xs">
              <span>
                {isBn ? 'মজুদ:' : 'Available:'} {addPaddyStock.bags} {isBn ? 'বস্তা' : 'bags'} ({addPaddyStock.weightKg.toLocaleString()} kg)
              </span>
              <span className="font-mono font-bold text-emerald-700 dark:text-emerald-400">
                {isBn ? 'যোগকৃত ধানের মূল্য:' : 'Added Cost:'} ৳{addPaddyStock.estCost.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </span>
            </div>

            <div>
              <label className="block text-xs font-medium mb-1">{isBn ? 'নোট (ঐচ্ছিক)' : 'Notes'}</label>
              <input
                type="text"
                value={addPaddyForm.notes}
                onChange={(e) => setAddPaddyForm({ ...addPaddyForm, notes: e.target.value })}
                placeholder={isBn ? 'নোট' : 'Notes'}
                className="w-full px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>

            {addPaddyBatch.input_logs && addPaddyBatch.input_logs.length > 0 && (
              <div className="border-t border-slate-200 dark:border-slate-800 pt-2.5 space-y-1.5">
                <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">
                  {isBn ? `আগের ধানের ইনপুট তালিকা (${addPaddyBatch.input_logs.length}বার)` : 'Previous Paddy Inputs'}
                </div>
                <div className="max-h-28 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 text-[11px]">
                  {addPaddyBatch.input_logs.map((inp) => (
                    <div key={inp.id} className="px-3 py-1.5 flex items-center justify-between">
                      <span>
                        {inp.item_name} ({inp.bag_count} {isBn ? 'বস্তা' : 'b'} · {inp.qty_kg.toLocaleString()} kg)
                      </span>
                      <span className="font-mono font-semibold">৳{inp.paddy_cost.toLocaleString('en-IN')}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setAddPaddyBatchId(null)}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.close')}
              </button>
              <button type="submit" className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold">
                {isBn ? 'ডায়ারে ধান যোগ করুন' : 'Add Paddy to Dryer'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* STEP 2 MODAL: Categorized Expense + Pay Now or Pay Later + Settle Dues */}
      {expenseBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-2xl w-full p-5 md:p-6 space-y-4 max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-bold">
                    {isBn ? 'ধাপ ২' : 'STEP 2'}
                  </span>
                  <h4 className="text-base font-display font-semibold text-slate-900 dark:text-white">
                    {isBn ? `খরচ যোগ ও বাকি পরিশোধ — ${expenseBatch.batch_no}` : `Categorized Expense & Due Pay — ${expenseBatch.batch_no}`}
                  </h4>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {expenseBatch.paddy_item_name} · {expenseBatch.input_bag_count || 0} {isBn ? 'বস্তা' : 'bags'} ·{' '}
                  {expenseBatch.input_paddy_qty_kg.toLocaleString()} kg · {expenseBatch.dryer_no || 'ডায়ার-১'}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setExpenseBatchId(null);
                  setPayingExp(null);
                }}
                className="p-1 text-slate-400 hover:text-slate-600"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {expenseBatch.cost_sheet && (
              <div className="rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
                <div>
                  <div className="text-[11px] text-slate-500">{isBn ? 'ধানের মূল্য' : 'Paddy Cost'}</div>
                  <div className="font-mono font-semibold text-slate-900 dark:text-white">
                    ৳{expenseBatch.cost_sheet.raw_paddy_cost.toLocaleString('en-IN')}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-500">{isBn ? 'মোট খরচ যোগ' : 'Total Expenses'}</div>
                  <div className="font-mono font-semibold text-emerald-700 dark:text-emerald-400">
                    +৳{getOverheadTotal(expenseBatch).toLocaleString('en-IN')}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-500">{isBn ? 'খরচ বাকি আছে' : 'Expense Due'}</div>
                  <div className="font-mono font-semibold text-red-600 dark:text-red-400">
                    ৳{Number(expenseBatch.profit_summary?.unpaid_expense_due || 0).toLocaleString('en-IN')}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-500">{isBn ? 'সর্বমোট ব্যাচ খরচ' : 'Gross Batch Cost'}</div>
                  <div className="font-mono font-bold text-amber-700 dark:text-amber-400">
                    ৳{expenseBatch.cost_sheet.gross_batch_cost.toLocaleString('en-IN')}
                  </div>
                </div>
              </div>
            )}

            <form onSubmit={handleAddBatchExpense} className="space-y-3 border border-slate-200 dark:border-slate-800 rounded-xl p-4 bg-slate-50/50 dark:bg-slate-950/40">
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                {isBn ? 'নতুন খরচ এন্ট্রি (কি বাবদ ও পরিশোধের ধরন)' : 'New Categorized Expense Entry'}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'কি বাবদ (খরচের খাত)' : 'Expense Purpose'}</label>
                  <select
                    value={expenseForm.expense_category}
                    onChange={(e) => setExpenseForm({ ...expenseForm, expense_category: e.target.value as ExpensePurposeKey })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {EXPENSE_PURPOSES.map((p) => (
                      <option key={p.key} value={p.key}>
                        {isBn ? p.bn : p.en}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'কার কাছে / ভেন্ডর (ঐচ্ছিক)' : 'Vendor / Payee (Optional)'}</label>
                  <input
                    type="text"
                    value={expenseForm.vendor_name}
                    onChange={(e) => setExpenseForm({ ...expenseForm, vendor_name: e.target.value })}
                    placeholder={isBn ? 'ভেন্ডর / প্রাপকের নাম' : 'Vendor / Payee'}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'খরচের পরিমাণ (৳)' : 'Amount (৳)'}</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={expenseForm.amount}
                    onChange={(e) => setExpenseForm({ ...expenseForm, amount: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'পরিশোধের অবস্থা' : 'Payment Timing'}</label>
                  <select
                    value={expenseForm.payment_timing}
                    onChange={(e) =>
                      setExpenseForm({ ...expenseForm, payment_timing: e.target.value as 'PAID' | 'UNPAID' | 'PARTIAL' })
                    }
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    <option value="PAID">{isBn ? 'এখনই পুরো পরিশোধ (Paid Now)' : 'Paid Immediately'}</option>
                    <option value="UNPAID">{isBn ? 'বাকিতে — পরে পরিশোধ করব (Pay Later)' : 'Unpaid — Pay Later (Due)'}</option>
                    <option value="PARTIAL">{isBn ? 'আংশিক পরিশোধ (Partial)' : 'Partial Payment'}</option>
                  </select>
                </div>

                {expenseForm.payment_timing !== 'UNPAID' && (
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'কোন অ্যাকাউন্ট থেকে পরিশোধ' : 'Pay From Account'}</label>
                    <select
                      value={expenseForm.account_id || defaultCashAccountId}
                      onChange={(e) => setExpenseForm({ ...expenseForm, account_id: Number(e.target.value) })}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      {paymentAccounts.map((acc) => (
                        <option key={acc.id} value={acc.id}>
                          {acc.name} (৳{Number(acc.balance || 0).toLocaleString('en-IN')})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                {expenseForm.payment_timing === 'PARTIAL' ? (
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'এখন নগদ পরিশোধ (৳)' : 'Paid Now (৳)'}</label>
                    <input
                      type="number"
                      min="0"
                      max={expenseForm.amount}
                      step="0.01"
                      value={expenseForm.paid_now}
                      onChange={(e) => setExpenseForm({ ...expenseForm, paid_now: Math.max(0, Number(e.target.value)) })}
                      className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'নোট / বিবরণ' : 'Notes'}</label>
                    <input
                      type="text"
                      value={expenseForm.notes}
                      onChange={(e) => setExpenseForm({ ...expenseForm, notes: e.target.value })}
                      placeholder={isBn ? 'নোট' : 'Notes'}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <button type="submit" className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold">
                  {isBn ? '+ খরচ সংরক্ষণ করুন' : '+ Save Expense'}
                </button>
              </div>
            </form>

            {/* Immediate Payment Receipt Banner when paying later */}
            {lastExpenseReceipt && lastExpenseReceipt.receipt.batch_id === expenseBatch.id && (
              <div className="rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/30 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                <div>
                  <span className="font-semibold text-emerald-800 dark:text-emerald-300">
                    {isBn
                      ? `খরচ পরিশোধ রিসিপ্ট প্রস্তুত: ${lastExpenseReceipt.receipt.receipt_no || `EXPR-${lastExpenseReceipt.receipt.id}`}`
                      : `Payment Receipt Ready: ${lastExpenseReceipt.receipt.receipt_no || `EXPR-${lastExpenseReceipt.receipt.id}`}`}
                  </span>
                  <span className="ml-2 font-mono">
                    ৳{Number(lastExpenseReceipt.receipt.amount || 0).toLocaleString('en-IN')}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    void exportExpensePaymentReceiptPdf(lastExpenseReceipt.receipt, expenseBatch, lang, 'open')
                  }
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-900 dark:bg-amber-600 text-white text-[11px] font-medium"
                >
                  <Eye className="w-3 h-3" /> {isBn ? 'রিসিপ্ট PDF দেখুন' : 'View Receipt PDF'}
                </button>
              </div>
            )}

            {/* Expense Logs + Inline Pay Due */}
            {expenseBatch.expense_logs && expenseBatch.expense_logs.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {isBn
                    ? `খরচের তালিকা ও বাকি পরিশোধ (${expenseBatch.expense_logs.length}টি এন্ট্রি)`
                    : `Expense History & Due Settlement (${expenseBatch.expense_logs.length})`}
                </div>
                <div className="max-h-60 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60">
                  {expenseBatch.expense_logs.map((exp) => {
                    const total = Number(exp.total_amount || 0);
                    const paid = Number(exp.paid_amount ?? (exp.payment_status === 'UNPAID' ? 0 : total));
                    const due = Math.max(0, Number((total - paid).toFixed(2)));
                    const isPayingThis = payingExp?.exp.id === exp.id;

                    return (
                      <div key={exp.id} className="p-3 text-xs space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-semibold text-slate-900 dark:text-white">
                                {getPurposeLabel(exp.expense_category)}
                              </span>
                              {exp.vendor_name && (
                                <span className="text-[11px] text-slate-600 dark:text-slate-400">· {exp.vendor_name}</span>
                              )}
                              <span
                                className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
                                  due <= 0.01
                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                                    : paid > 0
                                    ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                                    : 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300'
                                }`}
                              >
                                {due <= 0.01
                                  ? isBn
                                    ? 'পরিশোধিত'
                                    : 'PAID'
                                  : isBn
                                  ? `বাকি: ৳${due.toLocaleString('en-IN')}`
                                  : `DUE: ৳${due.toLocaleString('en-IN')}`}
                              </span>
                            </div>
                            <div className="text-[10px] text-slate-500 mt-0.5">
                              {exp.notes || '-'} · {exp.created_at?.slice(0, 16).replace('T', ' ')}
                            </div>
                          </div>

                          <div className="flex items-center gap-2 shrink-0">
                            <div className="text-right font-mono">
                              <div className="font-bold text-slate-900 dark:text-white">৳{total.toLocaleString('en-IN')}</div>
                              {paid > 0 && due > 0.01 && (
                                <div className="text-[10px] text-emerald-700 dark:text-emerald-400">
                                  {isBn ? 'দিয়েছে:' : 'Paid:'} ৳{paid.toLocaleString('en-IN')}
                                </div>
                              )}
                            </div>
                            {due > 0.01 && (
                              <button
                                type="button"
                                onClick={() =>
                                  isPayingThis ? setPayingExp(null) : startPayExpenseDue(expenseBatch.id, exp)
                                }
                                className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-[11px] font-semibold"
                              >
                                <Wallet className="w-3 h-3" />
                                <span>{isBn ? 'পরিশোধ করুন' : 'Pay Now'}</span>
                              </button>
                            )}
                          </div>
                        </div>

                        {isPayingThis && (
                          <form
                            onSubmit={handleSubmitPayDue}
                            className="rounded-lg bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-800 p-2.5 grid grid-cols-1 sm:grid-cols-4 gap-2 items-end"
                          >
                            <div>
                              <label className="block text-[10px] font-medium mb-1">{isBn ? 'অ্যাকাউন্ট' : 'Account'}</label>
                              <select
                                value={payDueForm.account_id || defaultCashAccountId}
                                onChange={(e) => setPayDueForm({ ...payDueForm, account_id: Number(e.target.value) })}
                                className="w-full px-2 py-1.5 text-[11px] rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                              >
                                {paymentAccounts.map((acc) => (
                                  <option key={acc.id} value={acc.id}>
                                    {acc.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium mb-1">{isBn ? 'পরিমাণ (৳)' : 'Amount'}</label>
                              <input
                                type="number"
                                min="0.01"
                                max={due}
                                step="0.01"
                                required
                                value={payDueForm.amount}
                                onChange={(e) => setPayDueForm({ ...payDueForm, amount: Number(e.target.value) })}
                                className="w-full px-2 py-1.5 text-[11px] font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                              />
                            </div>
                            <div>
                              <label className="block text-[10px] font-medium mb-1">{isBn ? 'নোট' : 'Note'}</label>
                              <input
                                type="text"
                                value={payDueForm.notes}
                                onChange={(e) => setPayDueForm({ ...payDueForm, notes: e.target.value })}
                                className="w-full px-2 py-1.5 text-[11px] rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                              />
                            </div>
                            <button
                              type="submit"
                              className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold"
                            >
                              {isBn ? 'টাকা পরিশোধ নিশ্চিত' : 'Confirm Pay'}
                            </button>
                          </form>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Unified Expense Payment Receipts List (Req 6) */}
            {expenseBatch.expense_payment_receipts && expenseBatch.expense_payment_receipts.length > 0 && (
              <div className="space-y-2 border-t border-slate-200 dark:border-slate-800 pt-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
                  <Receipt className="w-3.5 h-3.5 text-amber-600" />
                  <span>
                    {isBn
                      ? `সকল খরচ পরিশোধ রিসিপ্টসমূহ (${expenseBatch.expense_payment_receipts.length}টি)`
                      : `All Expense Payment Receipts (${expenseBatch.expense_payment_receipts.length})`}
                  </span>
                </div>
                <div className="max-h-48 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950">
                  {expenseBatch.expense_payment_receipts.map((rcp) => (
                    <div key={rcp.id} className="px-3 py-2 text-[11px] flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="font-mono font-semibold text-slate-900 dark:text-white">
                          {rcp.receipt_no || `EXPR-${rcp.id}`} ·{' '}
                          <span className="font-sans">{getPurposeLabel(rcp.expense_category)}</span>
                          {rcp.vendor_name ? <span className="font-sans text-slate-500"> · {rcp.vendor_name}</span> : null}
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {rcp.paid_at?.slice(0, 16).replace('T', ' ')} · {rcp.account_name || '-'} ({rcp.payment_mode})
                          {rcp.notes ? ` · ${rcp.notes}` : ''}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="font-mono font-bold text-emerald-700 dark:text-emerald-400">
                          ৳{Number(rcp.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                        </span>
                        <button
                          type="button"
                          onClick={() => void exportExpensePaymentReceiptPdf(rcp, expenseBatch, lang, 'open')}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-[10px] font-medium"
                        >
                          <FileText className="w-3 h-3" /> {isBn ? 'রিসিপ্ট PDF' : 'Receipt PDF'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end pt-2 border-t border-slate-100 dark:border-slate-800">
              <button
                type="button"
                onClick={() => {
                  setExpenseBatchId(null);
                  setPayingExp(null);
                }}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 3 MODAL: Secondary Items (Mora Machi 25kg, Diamond Khudi 50kg...) + 25kg/50kg Head Rice Auto Cost */}
      {completingBatch && step3Preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <form
            onSubmit={handleCompletePendingBatch}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-4xl w-full p-5 md:p-6 space-y-4 max-h-[92vh] overflow-y-auto"
          >
            <div className="flex items-start justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded bg-amber-600 text-white text-[10px] font-bold">
                    {isBn ? 'ধাপ ৩' : 'STEP 3'}
                  </span>
                  <h4 className="text-base font-display font-semibold text-slate-900 dark:text-white">
                    {isBn ? `উৎপন্ন আইটেম ও ২৫/৫০ কেজি চাল — ${completingBatch.batch_no}` : `Outputs & Auto Rice Rate — ${completingBatch.batch_no}`}
                  </h4>
                </div>
                <p className="text-xs text-slate-500 mt-0.5">
                  {completingBatch.paddy_item_name} · {completingBatch.input_bag_count || 0} {isBn ? 'বস্তা' : 'bags'} ·{' '}
                  {completingBatch.input_paddy_qty_kg.toLocaleString()} kg · {completingBatch.dryer_no || 'ডায়ার-১'}
                </p>
              </div>
              <button type="button" onClick={() => setCompletingBatchId(null)} className="p-1 text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Section A: Secondary / By-product items */}
            <div className="rounded-xl border border-slate-200 dark:border-slate-800 p-4 space-y-3 bg-slate-50/60 dark:bg-slate-950/40">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h5 className="text-xs font-semibold text-slate-900 dark:text-white">
                    {isBn
                      ? 'ক) উৎপন্ন উপজাত ও অন্যান্য আইটেম (মরা মাছি ২৫কেজি, ডায়মন্ড খুদি ৫০কেজি ইত্যাদি)'
                      : 'A) Secondary & By-Product Items (Mora Machi 25kg, Diamond Khudi 50kg, etc.)'}
                  </h5>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSecondaryDrafts((p) => [...p, makeDraftRow('MORA_MACHI')])}
                    className="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-[11px] font-medium hover:bg-slate-100"
                  >
                    + {isBn ? 'মরা মাছি ২৫কেজি' : 'Mora Machi 25kg'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSecondaryDrafts((p) => [...p, makeDraftRow('DIAMOND_KHUDI')])}
                    className="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 text-[11px] font-medium hover:bg-slate-100"
                  >
                    + {isBn ? 'ডায়মন্ড খুদি ৫০কেজি' : 'Diamond Khudi 50kg'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSecondaryDrafts((p) => [...p, makeDraftRow('CUSTOM')])}
                    className="px-2 py-1 rounded bg-amber-600 text-white text-[11px] font-medium hover:bg-amber-700"
                  >
                    + {isBn ? 'কাস্টম আইটেম' : 'Custom Item'}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {secondaryDrafts.map((row) => {
                  const pack = row.pack_size_kg || 25;
                  const rowTotal =
                    row.pricing_unit === 'BAG' && row.bag_count > 0 && Math.abs(row.qty_kg - row.bag_count * pack) < 0.01
                      ? Number((row.bag_count * row.rate_per_bag).toFixed(2))
                      : Number((row.qty_kg * row.rate_per_kg).toFixed(2));
                  return (
                    <div
                      key={row.uid}
                      className="grid grid-cols-12 gap-2 items-end bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-2.5 text-xs"
                    >
                      <div className="col-span-12 sm:col-span-4">
                        <label className="block text-[10px] text-slate-500 mb-0.5">{isBn ? 'আইটেম (বা কাস্টম নাম)' : 'Item'}</label>
                        {row.item_id === 0 ? (
                          <div className="flex gap-1">
                            <input
                              type="text"
                              value={row.custom_name}
                              onChange={(e) => updateSecondaryDraft(row.uid, { custom_name: e.target.value })}
                              placeholder={isBn ? 'কাস্টম আইটেমের নাম' : 'Custom item name'}
                              className="w-full px-2 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                            />
                            <button
                              type="button"
                              onClick={() => updateSecondaryDraft(row.uid, { item_id: nonPaddyItems[0]?.id || 0 })}
                              className="px-1.5 text-[10px] rounded border border-slate-300 dark:border-slate-700 shrink-0"
                              title={isBn ? 'তালিকা থেকে নিন' : 'Pick from list'}
                            >
                              {isBn ? 'তালিকা' : 'List'}
                            </button>
                          </div>
                        ) : (
                          <select
                            value={row.item_id}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              if (val === -1) {
                                updateSecondaryDraft(row.uid, { item_id: 0, custom_name: '' });
                                return;
                              }
                              const it = nonPaddyItems.find((x) => x.id === val);
                              const nextPack = Number(it?.bag_weight_kg || row.pack_size_kg || 25);
                              const nextRateKg = it?.default_rate || row.rate_per_kg;
                              updateSecondaryDraft(row.uid, {
                                item_id: val,
                                category: it?.category || row.category,
                                pack_size_kg: nextPack,
                                qty_kg: row.bag_count * nextPack,
                                rate_per_kg: nextRateKg,
                                rate_per_bag: Number((nextRateKg * nextPack).toFixed(2)),
                                pricing_unit: 'BAG',
                              });
                            }}
                            className="w-full px-2 py-1.5 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          >
                            {nonPaddyItems.map((it) => (
                              <option key={it.id} value={it.id}>
                                {it.name}
                              </option>
                            ))}
                            <option value={-1}>{isBn ? '+ নতুন নাম লিখুন...' : '+ Type custom item...'}</option>
                          </select>
                        )}
                      </div>

                      <div className="col-span-4 sm:col-span-1">
                        <label className="block text-[10px] text-slate-500 mb-0.5">{isBn ? 'প্যাক(kg)' : 'Pack'}</label>
                        <input
                          type="number"
                          min="1"
                          step="any"
                          value={row.pack_size_kg}
                          onChange={(e) => {
                            const nextPack = Math.max(1, Number(e.target.value));
                            if (row.pricing_unit === 'BAG') {
                              updateSecondaryDraft(row.uid, {
                                pack_size_kg: nextPack,
                                qty_kg: row.bag_count * nextPack,
                                rate_per_kg: Number((row.rate_per_bag / nextPack).toFixed(6)),
                              });
                            } else {
                              updateSecondaryDraft(row.uid, {
                                pack_size_kg: nextPack,
                                qty_kg: row.bag_count * nextPack,
                                rate_per_bag: Number((row.rate_per_kg * nextPack).toFixed(2)),
                              });
                            }
                          }}
                          className="w-full px-2 py-1.5 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                      </div>

                      <div className="col-span-4 sm:col-span-1">
                        <label className="block text-[10px] text-slate-500 mb-0.5">{isBn ? 'বস্তা' : 'Bags'}</label>
                        <input
                          type="number"
                          min="0"
                          value={row.bag_count}
                          onChange={(e) => {
                            const b = Math.max(0, Math.round(Number(e.target.value)));
                            updateSecondaryDraft(row.uid, { bag_count: b, qty_kg: b * (row.pack_size_kg || 25) });
                          }}
                          className="w-full px-2 py-1.5 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                      </div>

                      <div className="col-span-4 sm:col-span-2">
                        <label className="block text-[10px] text-slate-500 mb-0.5">{isBn ? 'মোট ওজন (kg)' : 'Total kg'}</label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={row.qty_kg}
                          onChange={(e) => updateSecondaryDraft(row.uid, { qty_kg: Math.max(0, Number(e.target.value)) })}
                          className="w-full px-2 py-1.5 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                      </div>

                      <div className="col-span-5 sm:col-span-1">
                        <label className="block text-[10px] text-slate-500 mb-0.5">{isBn ? 'দাম/kg' : '৳/kg'}</label>
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={row.rate_per_kg}
                          onChange={(e) => {
                            const rk = Math.max(0, Number(e.target.value));
                            updateSecondaryDraft(row.uid, {
                              pricing_unit: 'KG',
                              rate_per_kg: rk,
                              rate_per_bag: Number((rk * pack).toFixed(2)),
                            });
                          }}
                          className="w-full px-2 py-1.5 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                        />
                      </div>

                      <div className="col-span-5 sm:col-span-2">
                        <label className="block text-[10px] text-slate-500 mb-0.5">{isBn ? 'দাম/বস্তা · মোট' : '৳/bag · Total'}</label>
                        <div className="flex items-center gap-1.5">
                          <input
                            type="number"
                            min="0"
                            step="any"
                            value={row.rate_per_bag}
                            onChange={(e) => {
                              const br = Math.max(0, Number(e.target.value));
                              updateSecondaryDraft(row.uid, {
                                pricing_unit: 'BAG',
                                rate_per_bag: br,
                                rate_per_kg: pack > 0 ? Number((br / pack).toFixed(6)) : 0,
                              });
                            }}
                            className="w-20 px-2 py-1.5 font-mono rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                          />
                          <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400 truncate">
                            ৳{rowTotal.toLocaleString('en-IN')}
                          </span>
                        </div>
                      </div>

                      <div className="col-span-2 sm:col-span-1 text-right">
                        <button
                          type="button"
                          onClick={() => setSecondaryDrafts((prev) => prev.filter((x) => x.uid !== row.uid))}
                          className="p-1.5 text-slate-400 hover:text-red-600"
                          title={isBn ? 'মুছুন' : 'Remove'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Section B: Head Rice (25kg & 50kg packs) + Auto Pricing */}
            <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/60 p-4 space-y-3 bg-emerald-50/40 dark:bg-emerald-950/20">
              <h5 className="text-xs font-semibold text-slate-900 dark:text-white">
                {isBn
                  ? 'খ) মূল চাল উৎপাদন — ২৫ কেজি ও ৫০ কেজি বস্তা (দাম অটো আসবে)'
                  : 'B) Head Rice Output — 25kg & 50kg Packs (Auto Cost Calculation)'}
              </h5>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                <div>
                  <label className="block font-medium mb-1">{t('prd.finishedItem')}</label>
                  <select
                    value={completeForm.head_rice_item_id}
                    onChange={(e) => setCompleteForm({ ...completeForm, head_rice_item_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {headRiceItems.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'চালের গোডাউন' : 'Finished Rice Godown'}</label>
                  <select
                    value={completeForm.rice_warehouse_id}
                    onChange={(e) => setCompleteForm({ ...completeForm, rice_warehouse_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'উপজাত গোডাউন' : 'By-Product Godown'}</label>
                  <select
                    value={completeForm.byproduct_warehouse_id}
                    onChange={(e) => setCompleteForm({ ...completeForm, byproduct_warehouse_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {warehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
                <div className="bg-white dark:bg-slate-900 rounded-lg p-3 border border-slate-200 dark:border-slate-800">
                  <label className="block font-semibold text-amber-800 dark:text-amber-300 mb-1">
                    {isBn ? '২৫ কেজি বস্তা সংখ্যা' : '25 kg Bags Count'}
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={completeForm.bags_25kg}
                    onChange={(e) => setCompleteForm({ ...completeForm, bags_25kg: Math.max(0, Math.round(Number(e.target.value))) })}
                    className="w-full px-3 py-2 font-mono text-sm font-bold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                  <div className="text-[11px] text-slate-500 mt-1 font-mono">
                    = {(completeForm.bags_25kg * 25).toLocaleString()} kg
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-lg p-3 border border-slate-200 dark:border-slate-800">
                  <label className="block font-semibold text-emerald-800 dark:text-emerald-300 mb-1">
                    {isBn ? '৫০ কেজি বস্তা সংখ্যা' : '50 kg Bags Count'}
                  </label>
                  <input
                    type="number"
                    min="0"
                    value={completeForm.bags_50kg}
                    onChange={(e) => setCompleteForm({ ...completeForm, bags_50kg: Math.max(0, Math.round(Number(e.target.value))) })}
                    className="w-full px-3 py-2 font-mono text-sm font-bold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                  <div className="text-[11px] text-slate-500 mt-1 font-mono">
                    = {(completeForm.bags_50kg * 50).toLocaleString()} kg
                  </div>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-lg p-3 border border-slate-200 dark:border-slate-800">
                  <label className="block font-medium text-slate-600 dark:text-slate-400 mb-1">
                    {isBn ? 'অন্য প্যাক (kg × বস্তা)' : 'Other Pack (kg × bags)'}
                  </label>
                  <div className="flex gap-1.5">
                    <input
                      type="number"
                      min="1"
                      value={completeForm.extra_pack_size}
                      onChange={(e) => setCompleteForm({ ...completeForm, extra_pack_size: Math.max(1, Number(e.target.value)) })}
                      className="w-1/2 px-2 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                    <input
                      type="number"
                      min="0"
                      value={completeForm.extra_bags}
                      onChange={(e) => setCompleteForm({ ...completeForm, extra_bags: Math.max(0, Math.round(Number(e.target.value))) })}
                      className="w-1/2 px-2 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div className="text-[11px] text-slate-500 mt-1 font-mono">= {step3Preview.kgExtra.toLocaleString()} kg</div>
                </div>

                <div className="bg-white dark:bg-slate-900 rounded-lg p-3 border border-slate-200 dark:border-slate-800 flex flex-col justify-center">
                  <div className="text-[11px] text-slate-500">{isBn ? 'মোট মূল চাল ও রিকভারি' : 'Total Head Rice & Yield'}</div>
                  <div className="font-mono text-base font-bold text-slate-900 dark:text-white">
                    {step3Preview.headKg.toLocaleString('en-IN')} kg
                  </div>
                  <div className="text-[11px] font-mono text-emerald-700 dark:text-emerald-400">
                    {step3Preview.yieldPct.toFixed(2)}% · {isBn ? 'ঘাটতি:' : 'Loss:'} {step3Preview.wastageKg.toLocaleString()} kg
                  </div>
                </div>
              </div>

              {/* AUTO RICE COST SUMMARY CARD */}
              <div className="rounded-xl bg-slate-900 text-white p-4 grid grid-cols-2 sm:grid-cols-6 gap-3 text-xs">
                <div>
                  <div className="text-[10px] text-slate-400">{isBn ? 'মোট ব্যাচ খরচ (ধান+খরচ)' : 'Gross Batch Cost'}</div>
                  <div className="font-mono font-semibold text-sm">৳{step3Preview.estGross.toLocaleString('en-IN')}</div>
                </div>
                <div>
                  <div className="text-[10px] text-emerald-300">{isBn ? 'বাদ: মরা মাছি/খুদি/উপজাত' : 'Less: Secondary Value'}</div>
                  <div className="font-mono font-semibold text-sm text-emerald-400">
                    -৳{step3Preview.secValue.toLocaleString('en-IN')}
                  </div>
                </div>
                <div>
                  <div className="text-[10px] text-slate-300">{isBn ? 'নিট চালের খরচ' : 'Net Head Rice Cost'}</div>
                  <div className="font-mono font-bold text-sm">৳{step3Preview.estNetHeadCost.toLocaleString('en-IN')}</div>
                </div>
                <div className="bg-amber-600/20 border border-amber-500/40 rounded-lg px-2.5 py-1.5">
                  <div className="text-[10px] text-amber-300">{isBn ? '২৫ কেজি বস্তার অটো দাম' : 'Auto 25kg Bag Rate'}</div>
                  <div className="font-mono font-bold text-base text-amber-300">
                    ৳{step3Preview.estCost25kg.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </div>
                  <div className="text-[10px] text-slate-300 font-mono">৳{step3Preview.estCostPerKg.toFixed(2)}/kg</div>
                </div>
                <div className="bg-emerald-600/20 border border-emerald-500/40 rounded-lg px-2.5 py-1.5">
                  <div className="text-[10px] text-emerald-300">{isBn ? '৫০ কেজি বস্তার অটো দাম' : 'Auto 50kg Bag Rate'}</div>
                  <div className="font-mono font-bold text-base text-emerald-300">
                    ৳{step3Preview.estCost50kg.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                  </div>
                  <div className="text-[10px] text-slate-300 font-mono">৳{step3Preview.estCostPerKg.toFixed(2)}/kg</div>
                </div>
                <div className="bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5">
                  <div className="text-[10px] text-sky-300">{isBn ? 'ইস্যু (চাল÷ধানের একক)' : 'Issue / 75.5'}</div>
                  <div className="font-mono font-bold text-base text-sky-300">
                    {step3Preview.estIssuePerUnit.toFixed(2)} kg
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono">÷ ৭৫.৫</div>
                </div>
              </div>

              {step3Preview.exceedsInput && (
                <div className="text-xs font-semibold text-red-600 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 rounded-lg px-3 py-2">
                  {isBn
                    ? `সতর্কতা: মোট আউটপুট (${step3Preview.totalOutKg} kg) ডায়ারে দেওয়া ধান (${completingBatch.input_paddy_qty_kg} kg)-এর চেয়ে বেশি হতে পারবে না!`
                    : 'Total output weight exceeds input paddy weight!'}
                </div>
              )}
            </div>

            {/* Optional Closing Overhead */}
            <div className="border-t border-slate-200 dark:border-slate-800 pt-3">
              <button
                type="button"
                onClick={() => setShowStep3FinalExtra(!showStep3FinalExtra)}
                className="flex items-center justify-between w-full text-xs font-medium text-slate-700 dark:text-slate-300"
              >
                <span>
                  {isBn ? 'শেষ মুহূর্তের অতিরিক্ত খরচ থাকলে যোগ করুন (ঐচ্ছিক)' : 'Optional Final Closing Overhead'}
                </span>
                {showStep3FinalExtra ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
              {showStep3FinalExtra && (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5 text-xs mt-3">
                  <div>
                    <label className="block font-medium mb-1">{t('prd.labor')}</label>
                    <input
                      type="number"
                      min="0"
                      value={completeForm.labor_cost}
                      onChange={(e) => setCompleteForm({ ...completeForm, labor_cost: Math.max(0, Number(e.target.value)) })}
                      className="w-full px-2.5 py-1.5 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">{t('prd.electricity')}</label>
                    <input
                      type="number"
                      min="0"
                      value={completeForm.electricity_cost}
                      onChange={(e) => setCompleteForm({ ...completeForm, electricity_cost: Math.max(0, Number(e.target.value)) })}
                      className="w-full px-2.5 py-1.5 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">{t('prd.boilerFuel')}</label>
                    <input
                      type="number"
                      min="0"
                      value={completeForm.fuel_boiler_cost}
                      onChange={(e) => setCompleteForm({ ...completeForm, fuel_boiler_cost: Math.max(0, Number(e.target.value)) })}
                      className="w-full px-2.5 py-1.5 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">{t('prd.machinery')}</label>
                    <input
                      type="number"
                      min="0"
                      value={completeForm.machinery_overhead_cost}
                      onChange={(e) =>
                        setCompleteForm({ ...completeForm, machinery_overhead_cost: Math.max(0, Number(e.target.value)) })
                      }
                      className="w-full px-2.5 py-1.5 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label className="block font-medium mb-1">{t('prd.packaging')}</label>
                    <input
                      type="number"
                      min="0"
                      value={completeForm.packaging_cost}
                      onChange={(e) => setCompleteForm({ ...completeForm, packaging_cost: Math.max(0, Number(e.target.value)) })}
                      className="w-full px-2.5 py-1.5 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCompletingBatchId(null)}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.close')}
              </button>
              <button
                type="submit"
                disabled={step3Preview.exceedsInput}
                className="px-5 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-semibold"
              >
                {isBn ? 'আউটপুট স্টকে তুলুন ও ক্রাশিং শেষ করুন' : t('prd.completeBatch')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* COST SHEET & PER-DRYER BATCH PROFIT/LOSS MODAL */}
      {selectedSheetBatch && selectedSheetBatch.cost_sheet && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-3xl w-full p-6 space-y-4 max-h-[92vh] overflow-y-auto">
            <div className="flex items-start justify-between border-b border-slate-200 dark:border-slate-800 pb-3 gap-2">
              <div>
                <h4 className="text-base font-display font-semibold text-slate-900 dark:text-white">
                  {isBn ? `ডায়ার কস্ট শিট ও লাভ-লস — ${selectedSheetBatch.batch_no}` : `${t('prd.csTitle')} — ${selectedSheetBatch.batch_no}`}
                </h4>
                <p className="text-xs text-slate-500">
                  {selectedSheetBatch.process_type === 'PARBOILED_SIDDHO' ? t('dash.siddho') : t('dash.atap')} ·{' '}
                  {selectedSheetBatch.paddy_item_name} · {selectedSheetBatch.dryer_count || 1} {isBn ? 'ডায়ার' : 'Dryer'} (
                  {selectedSheetBatch.dryer_no || 'ডায়ার-১'})
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 flex-wrap justify-end">
                <button
                  onClick={() => exportBatchCostSheetPdf(selectedSheetBatch, 'bn')}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>{isBn ? 'সম্পূর্ণ ডায়ার রিপোর্ট PDF' : 'Complete Dryer Report (BN)'}</span>
                </button>
                <button
                  onClick={() => exportBatchCostSheetPdf(selectedSheetBatch, 'en')}
                  className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-100 text-xs font-medium whitespace-nowrap"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>{t('rep.pdfEn')}</span>
                </button>
              </div>
            </div>

            {/* Complete Dryer Report Summary (Rice Price, Issue & By-Product Bags - Req 7) */}
            {(() => {
              const iss = computeIssueMetrics(selectedSheetBatch);
              const kgPrice = Number(selectedSheetBatch.cost_sheet?.cost_per_kg_head_rice || 0);
              const byProductOuts = (selectedSheetBatch.outputs || []).filter((o) => o.output_type !== 'HEAD_RICE');
              return (
                <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50/70 dark:bg-amber-950/30 p-3.5 space-y-2.5 text-xs">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <div className="text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                        {isBn ? 'চালের দাম (২৫কেজি / ৫০কেজি / কেজি)' : 'Head Rice Cost (25kg / 50kg / kg)'}
                      </div>
                      <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5">
                        ৳{kgPrice.toFixed(2)}/kg · ৳{(kgPrice * 25).toFixed(2)} (২৫ব) · ৳{(kgPrice * 50).toFixed(2)} (৫০ব)
                      </div>
                    </div>
                    <div className="sm:col-span-2">
                      <div className="text-[10px] font-semibold text-emerald-800 dark:text-emerald-300">
                        {isBn
                          ? `ইস্যু = মোট চালের ওজন ÷ ((ধানের ওজন − বস্তা) ÷ ${iss.div})`
                          : `Issue = Total Head Rice ÷ ((Paddy Wt − Bags) ÷ ${iss.div})`}
                      </div>
                      <div className="font-mono font-bold text-slate-900 dark:text-white mt-0.5">
                        {iss.headKg > 0 && iss.denom > 0 ? (
                          <>
                            {iss.headKg.toLocaleString('en-IN')} ÷ (({iss.paddyKg.toLocaleString('en-IN')} − {iss.bags}) ÷ {iss.div}) ={' '}
                            <span className="text-emerald-700 dark:text-emerald-400">
                              {iss.issue.toFixed(2)} {isBn ? 'কেজি চাল / ৭৫.৫ ইউনিট' : 'kg rice / 75.5 unit'}
                            </span>
                          </>
                        ) : (
                          <span className="text-slate-500">{isBn ? 'আউটপুট সম্পন্ন হলে ইস্যু হিসাব হবে' : 'Calculated once completed'}</span>
                        )}
                      </div>
                    </div>
                  </div>
                  {byProductOuts.length > 0 && (
                    <div className="border-t border-amber-200 dark:border-amber-800/70 pt-2 flex flex-wrap items-center gap-2">
                      <span className="text-[10px] font-semibold text-slate-700 dark:text-slate-300">
                        {isBn ? 'উপজাত (বস্তা):' : 'By-Products (Bags):'}
                      </span>
                      {byProductOuts.map((out) => {
                        const pack = Number(out.pack_size_kg || 25);
                        const bags = Number(out.bag_count || Math.round((out.qty_kg || 0) / (pack || 50)));
                        return (
                          <span
                            key={out.id}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white dark:bg-slate-900 border border-amber-200 dark:border-amber-800 font-mono text-[11px] font-semibold text-slate-900 dark:text-white"
                          >
                            {out.item_name} ({pack} {isBn ? 'কেজি' : 'kg'}): {bags.toLocaleString('en-IN')}
                            {isBn ? 'টি বস্তা' : ' bags'}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* PER-DRYER BATCH PROFIT & LOSS SUMMARY */}
            {selectedSheetBatch.profit_summary && (
              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-900 text-white p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-amber-300">
                    {isBn ? 'বিক্রির পর ডায়ার ব্যাচের লাভ / লস বিশ্লেষণ' : 'Per-Dryer Batch Sales & Profit/Loss'}
                  </span>
                  <span className="text-[11px] font-mono text-slate-300">
                    {selectedSheetBatch.profit_summary.sales_count} {isBn ? 'টি চালান বিক্রি' : 'sales'}
                  </span>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <div className="text-[10px] text-slate-400">{isBn ? 'মোট বিক্রি (আয়)' : 'Total Sold Revenue'}</div>
                    <div className="font-mono font-bold text-sm">
                      ৳{selectedSheetBatch.profit_summary.total_sold_revenue.toLocaleString('en-IN')}
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono">
                      {selectedSheetBatch.profit_summary.total_sold_kg.toLocaleString()} kg ({selectedSheetBatch.profit_summary.total_sold_bags}ব)
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400">{isBn ? 'বিক্রিত মালের উৎপাদন খরচ' : 'Sold COGS'}</div>
                    <div className="font-mono font-semibold text-sm">
                      ৳{selectedSheetBatch.profit_summary.total_sold_cogs.toLocaleString('en-IN')}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400">{isBn ? 'বিক্রি থেকে প্রকৃত লাভ/লস' : 'Realized Sale P&L'}</div>
                    <div
                      className={`font-mono font-bold text-base ${
                        selectedSheetBatch.profit_summary.realized_profit_loss >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {selectedSheetBatch.profit_summary.realized_profit_loss >= 0 ? '+' : ''}৳
                      {selectedSheetBatch.profit_summary.realized_profit_loss.toLocaleString('en-IN')}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-400">{isBn ? 'অবিক্রিত স্টক (হাতে আছে)' : 'Unsold Stock Value'}</div>
                    <div className="font-mono font-semibold text-sm text-amber-300">
                      ৳{selectedSheetBatch.profit_summary.unsold_stock_value.toLocaleString('en-IN')}
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono">
                      {selectedSheetBatch.profit_summary.unsold_stock_kg.toLocaleString()} kg ({selectedSheetBatch.profit_summary.unsold_stock_bags}ব)
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Cost Sheet Breakdown */}
            <dl className="space-y-1.5 text-xs">
              {[
                [t('prd.csRawPaddy'), selectedSheetBatch.cost_sheet.raw_paddy_cost],
                [t('prd.csLabor'), selectedSheetBatch.cost_sheet.labor_cost],
                [t('prd.csElectricity'), selectedSheetBatch.cost_sheet.electricity_cost],
                [t('prd.csBoiler'), selectedSheetBatch.cost_sheet.fuel_boiler_cost],
                [t('prd.csMachinery'), selectedSheetBatch.cost_sheet.machinery_overhead_cost],
                [t('prd.csPackaging'), selectedSheetBatch.cost_sheet.packaging_cost],
              ].map(([label, val]) => (
                <div key={String(label)} className="flex justify-between py-1 border-b border-slate-100 dark:border-slate-800">
                  <dt className="text-slate-600 dark:text-slate-400">{label}</dt>
                  <dd className="font-mono tabular-nums text-slate-900 dark:text-white">৳{Number(val).toLocaleString('en-IN')}</dd>
                </div>
              ))}
              <div className="flex justify-between py-1.5 font-semibold">
                <dt>{t('prd.csGross')}</dt>
                <dd className="font-mono tabular-nums">৳{selectedSheetBatch.cost_sheet.gross_batch_cost.toLocaleString('en-IN')}</dd>
              </div>
              <div className="flex justify-between py-1 text-emerald-700 dark:text-emerald-400">
                <dt>{t('prd.csCredit')}</dt>
                <dd className="font-mono tabular-nums">-৳{selectedSheetBatch.cost_sheet.byproduct_credit_value.toLocaleString('en-IN')}</dd>
              </div>
              <div className="flex justify-between py-2 border-t border-slate-300 dark:border-slate-700 text-sm font-semibold">
                <dt>{t('prd.csNet')}</dt>
                <dd className="font-mono tabular-nums">৳{selectedSheetBatch.cost_sheet.net_head_rice_cost.toLocaleString('en-IN')}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2 py-2 bg-slate-50 dark:bg-slate-950 px-3 rounded-lg">
                <dt className="font-medium">{isBn ? 'মূল চালের অটো উৎপাদন মূল্য' : t('prd.csUnitCost')}</dt>
                <dd className="font-mono tabular-nums font-semibold text-amber-700 dark:text-amber-400">
                  ৳{selectedSheetBatch.cost_sheet.cost_per_kg_head_rice.toFixed(2)}/kg · ৳
                  {(selectedSheetBatch.cost_sheet.cost_per_kg_head_rice * 25).toFixed(2)}/25kg · ৳
                  {selectedSheetBatch.cost_sheet.cost_per_bag_head_rice.toFixed(2)}/50kg
                </dd>
              </div>
            </dl>

            {/* Step 3 Produced Pack-size Lots */}
            {selectedSheetBatch.outputs && selectedSheetBatch.outputs.length > 0 && (
              <div className="border-t border-slate-200 dark:border-slate-800 pt-3 space-y-2">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {isBn ? 'ধাপ ৩: উৎপন্ন চাল ও উপজাত লট (বস্তা অনুযায়ী)' : 'Step 3: Produced Pack-Size Lots'}
                </div>
                <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-x-auto">
                  <table className="w-full text-[11px]">
                    <thead className="bg-slate-50 dark:bg-slate-950 text-slate-500">
                      <tr>
                        <th className="text-left px-3 py-2">{isBn ? 'আইটেম ও লট' : 'Item & Lot'}</th>
                        <th className="text-right px-3 py-2">{isBn ? 'বস্তার সাইজ' : 'Pack'}</th>
                        <th className="text-right px-3 py-2">{isBn ? 'উৎপাদন' : 'Produced'}</th>
                        <th className="text-right px-3 py-2">{isBn ? 'অবশিষ্ট' : 'Remaining'}</th>
                        <th className="text-right px-3 py-2">{isBn ? 'দর' : 'Rate'}</th>
                        <th className="text-right px-3 py-2">{isBn ? 'মোট মূল্য' : 'Value'}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {selectedSheetBatch.outputs.map((out) => {
                        const isHeadRice = out.output_type === 'HEAD_RICE';
                        const pack = Number(out.pack_size_kg || (isHeadRice ? 50 : 25));
                        const bags = Number(out.bag_count || Math.round((out.qty_kg || 0) / (pack || 50)));
                        const remBags = Number(out.remaining_bags ?? 0);
                        const bagRate =
                          out.rate_per_bag && out.rate_per_bag > 0
                            ? Number(out.rate_per_bag)
                            : Number((Number(out.allocated_unit_cost_per_kg || 0) * pack).toFixed(2));
                        return (
                          <tr key={out.id}>
                            <td className="px-3 py-2">
                              <div className="font-medium text-slate-900 dark:text-white">{out.item_name}</div>
                              <div className="font-mono text-[10px] text-slate-500">{out.lot_code || '-'}</div>
                            </td>
                            <td className="px-3 py-2 text-right font-mono">{pack} {isBn ? 'কেজি' : 'kg'}</td>
                            <td className="px-3 py-2 text-right font-mono">
                              {isHeadRice
                                ? `${bags.toLocaleString('en-IN')}${isBn ? 'টি বস্তা' : ' bags'} · ${out.qty_kg.toLocaleString()} kg`
                                : `${bags.toLocaleString('en-IN')}${isBn ? 'টি বস্তা' : ' bags'}`}
                            </td>
                            <td className="px-3 py-2 text-right font-mono text-emerald-700 dark:text-emerald-400">
                              {isHeadRice
                                ? `${remBags.toLocaleString('en-IN')}${isBn ? 'টি বস্তা' : ' bags'} · ${Number(out.remaining_qty_kg ?? 0).toLocaleString()} kg`
                                : `${remBags.toLocaleString('en-IN')}${isBn ? 'টি বস্তা' : ' bags'}`}
                            </td>
                            <td className="px-3 py-2 text-right font-mono">
                              {isHeadRice
                                ? `৳${out.allocated_unit_cost_per_kg.toFixed(2)}/${isBn ? 'কেজি' : 'kg'}`
                                : `৳${bagRate.toFixed(2)}/${isBn ? 'বস্তা' : 'bag'}`}
                            </td>
                            <td className="px-3 py-2 text-right font-mono font-semibold">৳{out.total_value.toLocaleString('en-IN')}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Step 1 Input Logs */}
            {selectedSheetBatch.input_logs && selectedSheetBatch.input_logs.length > 0 && (
              <div className="border-t border-slate-200 dark:border-slate-800 pt-3 space-y-2">
                <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                  {isBn ? 'ধাপ ১: ডায়ারে দেওয়া ধানের তালিকা' : 'Step 1: Paddy Input Logs'}
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 text-[11px]">
                  {selectedSheetBatch.input_logs.map((inp) => (
                    <div key={inp.id} className="px-3 py-2 flex items-center justify-between gap-2">
                      <div>
                        <div className="font-medium text-slate-800 dark:text-slate-200">
                          {inp.item_name} · {inp.warehouse_name} ({inp.bag_count} {isBn ? 'বস্তা' : 'bags'} · {inp.qty_kg.toLocaleString()} kg)
                        </div>
                        <div className="text-[10px] text-slate-500">
                          {inp.notes || '-'} · {inp.created_at?.slice(0, 16).replace('T', ' ')}
                        </div>
                      </div>
                      <span className="font-mono font-semibold">৳{inp.paddy_cost.toLocaleString('en-IN')}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Step 2 Unified Expenses & Payment Receipts inside Cost Sheet (Req 6) */}
            {((selectedSheetBatch.expense_logs && selectedSheetBatch.expense_logs.length > 0) ||
              (selectedSheetBatch.expense_payment_receipts && selectedSheetBatch.expense_payment_receipts.length > 0)) && (
              <div className="border-t border-slate-200 dark:border-slate-800 pt-3 space-y-3">
                <div className="flex items-center justify-between">
                  <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                    {isBn ? 'ধাপ ২: সকল খরচ ও বাকি পরিশোধের রিসিপ্ট (একসাথে)' : 'Step 2: All Expenses & Payment Receipts'}
                  </div>
                  <button
                    type="button"
                    onClick={() => openExpenseModal(selectedSheetBatch)}
                    className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 hover:underline"
                  >
                    {isBn ? '+ খরচ / বাকি শোধ' : '+ Add / Pay Expense'}
                  </button>
                </div>

                {selectedSheetBatch.expense_logs && selectedSheetBatch.expense_logs.length > 0 && (
                  <div className="max-h-40 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800">
                    {selectedSheetBatch.expense_logs.map((exp) => {
                      const total = Number(exp.total_amount || 0);
                      const paid = Number(exp.paid_amount ?? (exp.payment_status === 'UNPAID' ? 0 : total));
                      const due = Math.max(0, Number((total - paid).toFixed(2)));
                      return (
                        <div key={exp.id} className="px-3 py-2 text-[11px] flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-medium text-slate-800 dark:text-slate-200 truncate">
                              {getPurposeLabel(exp.expense_category)}
                              {exp.vendor_name ? ` · ${exp.vendor_name}` : ''} — {exp.notes || ''}
                            </div>
                            <div className="text-[10px] text-slate-500">
                              {exp.created_at?.slice(0, 16).replace('T', ' ')} ·{' '}
                              {due <= 0.01 ? (isBn ? 'পরিশোধিত' : 'PAID') : isBn ? `বাকি ৳${due.toLocaleString('en-IN')}` : `DUE ৳${due}`}
                            </div>
                          </div>
                          <span className="font-mono font-semibold text-emerald-700 dark:text-emerald-400 shrink-0">
                            +৳{total.toLocaleString('en-IN')}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                {selectedSheetBatch.expense_payment_receipts && selectedSheetBatch.expense_payment_receipts.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 dark:text-slate-400">
                      <Receipt className="w-3.5 h-3.5 text-amber-600" />
                      <span>
                        {isBn
                          ? `পরিশোধিত রিসিপ্ট তালিকা (${selectedSheetBatch.expense_payment_receipts.length}টি)`
                          : `Payment Receipts (${selectedSheetBatch.expense_payment_receipts.length})`}
                      </span>
                    </div>
                    <div className="max-h-40 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/40">
                      {selectedSheetBatch.expense_payment_receipts.map((rcp) => (
                        <div key={rcp.id} className="px-3 py-2 text-[11px] flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <div className="font-mono font-semibold text-slate-900 dark:text-white">
                              {rcp.receipt_no || `EXPR-${rcp.id}`} ·{' '}
                              <span className="font-sans">{getPurposeLabel(rcp.expense_category)}</span>
                            </div>
                            <div className="text-[10px] text-slate-500">
                              {rcp.paid_at?.slice(0, 16).replace('T', ' ')} · {rcp.account_name || '-'} ({rcp.payment_mode})
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="font-mono font-bold text-slate-900 dark:text-white">
                              ৳{Number(rcp.amount || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                            </span>
                            <button
                              type="button"
                              onClick={() => void exportExpensePaymentReceiptPdf(rcp, selectedSheetBatch, lang, 'open')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 dark:border-slate-700 hover:bg-white dark:hover:bg-slate-800 text-[10px] font-medium"
                            >
                              <FileText className="w-3 h-3" /> {isBn ? 'রিসিপ্ট PDF' : 'Receipt PDF'}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            <button
              onClick={() => setSheetBatchId(null)}
              className="w-full py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      )}

      {/* WEIGH-OUT & SALE-STYLE PRICING MODAL FOR UNWEIGHED DRIED PADDY */}
      {weighOutBatch && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <form
            onSubmit={handleWeighOutSubmit}
            className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-2xl w-full p-5 md:p-6 space-y-4 max-h-[90vh] overflow-y-auto"
          >
            <div className="flex items-start justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h4 className="text-base font-display font-semibold text-slate-900 dark:text-white">
                  {isBn
                    ? `গোডাউন থেকে বের হওয়ার সময় ওজন ও দাম নির্ধারণ — ${weighOutBatch.drying_no}`
                    : `Exit Weigh-Out & Pricing — ${weighOutBatch.drying_no}`}
                </h4>
                <p className="text-xs text-slate-500">
                  {weighOutBatch.item_name} ({weighOutBatch.dest_warehouse_name || ''}) · {isBn ? 'জমা:' : 'Stored:'}{' '}
                  {Number(weighOutBatch.output_bags || 0)}ব · {isBn ? 'আগে বের:' : 'Dispatched:'}{' '}
                  {Number(weighOutBatch.dispatched_bags || 0)}ব · {isBn ? 'বাকি:' : 'Remaining:'}{' '}
                  {Number(weighOutBatch.remaining_bags ?? 0)}ব
                </p>
              </div>
              <button type="button" onClick={() => setWeighOutBatchId(null)} className="p-1 text-slate-400 hover:text-slate-600">
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Mode Switch: Direct Paddy Sale vs Weigh-Out to Active Stock */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 p-1 rounded-lg bg-slate-100 dark:bg-slate-800">
              <button
                type="button"
                onClick={() => setWeighOutForm({ ...weighOutForm, mode: 'DIRECT_SALE' })}
                className={`px-3 py-2 rounded-md text-xs font-semibold transition-colors ${
                  weighOutForm.mode === 'DIRECT_SALE'
                    ? 'bg-amber-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                {isBn ? 'সরাসরি বিক্রি করুন (ওজন + ক্রেতার বিল)' : 'Direct Paddy Sale (Buyer Invoice)'}
              </button>
              <button
                type="button"
                onClick={() => setWeighOutForm({ ...weighOutForm, mode: 'WEIGH_AND_STOCK' })}
                className={`px-3 py-2 rounded-md text-xs font-semibold transition-colors ${
                  weighOutForm.mode === 'WEIGH_AND_STOCK'
                    ? 'bg-slate-900 dark:bg-amber-600 text-white shadow-sm'
                    : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                {isBn ? 'ওজন ও দর বসিয়ে সক্রিয় স্টক/মিলিংয়ে নিন' : 'Weigh-Out to Active Stock / Milling'}
              </button>
            </div>

            {weighOutForm.mode === 'DIRECT_SALE' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'ক্রেতা / পার্টি *' : 'Buyer / Customer *'}</label>
                  <select
                    value={weighOutForm.customer_id}
                    onChange={(e) => setWeighOutForm({ ...weighOutForm, customer_id: Number(e.target.value) })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {customers.length === 0 ? (
                      <option value={0}>{isBn ? 'কোনো ক্রেতা নেই' : 'No customers'}</option>
                    ) : (
                      customers.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.party_code})
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'নগদ / ব্যাংক প্রাপ্ত টাকা (৳)' : 'Cash Received Now (৳)'}</label>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={weighOutForm.paid_amount}
                    onChange={(e) => setWeighOutForm({ ...weighOutForm, paid_amount: Math.max(0, Number(e.target.value)) })}
                    className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>
            )}

            {/* Torn-Bag Surplus Notice */}
            {weighOutTotalBags > Number(weighOutBatch.remaining_bags ?? 0) && (
              <div className="rounded-lg border border-emerald-300 dark:border-emerald-800 bg-emerald-50/70 dark:bg-emerald-950/30 px-3 py-2 text-xs text-emerald-800 dark:text-emerald-300 font-medium">
                {isBn
                  ? `জমার চেয়ে +${weighOutTotalBags - Number(weighOutBatch.remaining_bags ?? 0)}টি বেশি বস্তা (মোট ${
                      Number(weighOutBatch.dispatched_bags || 0) + weighOutTotalBags
                    }ব / জমা ${Number(weighOutBatch.output_bags || 0)}ব) — বস্তা ছিঁড়ে রি-ব্যাগিংয়ের কারণে অনুমোদিত।`
                  : `+${weighOutTotalBags - Number(weighOutBatch.remaining_bags ?? 0)} extra bags beyond stored count (torn/re-bagged sacks permitted).`}
              </div>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
              <div>
                <label className="block font-medium mb-1">{isBn ? 'চট বস্তা' : 'Jute Bags'}</label>
                <input
                  type="number"
                  min="0"
                  value={weighOutForm.jute_bag_count}
                  onChange={(e) => setWeighOutForm({ ...weighOutForm, jute_bag_count: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'প্লাস্টিক বস্তা' : 'Plastic Bags'}</label>
                <input
                  type="number"
                  min="0"
                  value={weighOutForm.plastic_bag_count}
                  onChange={(e) => setWeighOutForm({ ...weighOutForm, plastic_bag_count: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'স্কেল ওজন (কেজি)' : 'Scale Weight (kg)'}</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={weighOutForm.scale_weight_kg}
                  onChange={(e) => {
                    const wt = Number(e.target.value);
                    setWeighOutForm((prev) => ({
                      ...prev,
                      scale_weight_kg: wt,
                      qty_kg: prev.qty_kg === prev.scale_weight_kg || prev.qty_kg === 0 ? wt : prev.qty_kg,
                    }));
                  }}
                  className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'হিসাব/ডেলিভারি ওজন (কেজি) *' : 'Actual Exit Weight (kg) *'}</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={weighOutForm.qty_kg}
                  onChange={(e) => setWeighOutForm({ ...weighOutForm, qty_kg: Number(e.target.value) })}
                  className="w-full px-3 py-2 font-mono font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            {/* Sale-Style Pricing Formula Box: (ওজন - বাদ) / ৭৫.৫ * দর */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 rounded-lg bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50 text-xs">
              <div>
                <div className="flex items-center justify-between gap-1 mb-1">
                  <label className="font-medium">{isBn ? 'বাদ (কেজি)' : 'Deduction (kg)'}</label>
                  {weighOutTotalBags > 0 && (
                    <button
                      type="button"
                      onClick={() => setWeighOutForm({ ...weighOutForm, weight_loss_kg: weighOutTotalBags })}
                      className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-[10px] font-semibold text-amber-800 dark:text-amber-300"
                    >
                      = {weighOutTotalBags}ব
                    </button>
                  )}
                </div>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={weighOutForm.weight_loss_kg}
                  onChange={(e) => setWeighOutForm({ ...weighOutForm, weight_loss_kg: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{t('proc.divisor')}</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={weighOutForm.settlement_unit_kg}
                  onChange={(e) => setWeighOutForm({ ...weighOutForm, settlement_unit_kg: Number(e.target.value) })}
                  className="w-full px-3 py-2 font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">
                  {t('proc.ratePerUnit', { unit: weighOutDivisor })}
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={weighOutForm.settlement_rate}
                  onChange={(e) => setWeighOutForm({ ...weighOutForm, settlement_rate: Number(e.target.value) })}
                  className="w-full px-3 py-2 font-mono font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-amber-200/70 dark:border-amber-900/40 font-mono">
                <span className="text-slate-700 dark:text-slate-300">
                  ({weighOutForm.qty_kg.toLocaleString()} − {weighOutForm.weight_loss_kg.toLocaleString()}) / {weighOutDivisor} × ৳
                  {weighOutForm.settlement_rate.toLocaleString()} = <strong>{weighOutUnits.toFixed(4)} {t('proc.units')}</strong>
                </span>
                <span className="text-sm font-bold text-slate-900 dark:text-white">
                  ৳{weighOutTotalValue.toLocaleString('en-IN')} (৳{weighOutEffectivePerKg.toFixed(2)}/kg)
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs items-center">
              <input
                type="text"
                value={weighOutForm.notes}
                onChange={(e) => setWeighOutForm({ ...weighOutForm, notes: e.target.value })}
                placeholder={isBn ? 'গাড়ি নং / চালান / মন্তব্য...' : 'Vehicle / Challan / Notes...'}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
              <label className="inline-flex items-center gap-2 cursor-pointer select-none font-medium text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={weighOutForm.close_lot}
                  onChange={(e) => setWeighOutForm({ ...weighOutForm, close_lot: e.target.checked })}
                  className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                />
                <span>
                  {isBn
                    ? 'বের হওয়ার পর লটটি সম্পূর্ণ শেষ/ক্লোজ করুন (ছেঁড়া বস্তার বাকি ধান থাকলে আনচেক রাখুন)'
                    : 'Close lot after this weigh-out (uncheck if torn-bag sweep-ups remain)'}
                </span>
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setWeighOutBatchId(null)}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-xs font-medium"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={weighOutSubmitting}
                className="px-5 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-semibold disabled:opacity-50"
              >
                {weighOutSubmitting
                  ? t('common.saving')
                  : weighOutForm.mode === 'DIRECT_SALE'
                    ? isBn
                      ? 'ওজন ও দামসহ বিক্রি সম্পন্ন করুন'
                      : 'Complete Weigh-Out Sale'
                    : isBn
                      ? 'ওজন করে সক্রিয় স্টকে নিন'
                      : 'Confirm Weigh-Out to Stock'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
