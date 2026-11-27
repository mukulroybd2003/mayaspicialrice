import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Coins,
  Factory,
  Layers,
  Plus,
  Search,
  ShoppingCart,
  Split,
  Trash2,
  TrendingDown,
  TrendingUp,
  Warehouse as WarehouseIcon,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { apiMutate } from '../services/api';
import type {
  Account,
  ChatalBatch,
  ChatalBatchExpense,
  CostingMethod,
  InventoryLot,
  ItemMaster,
  PaddyPurchase,
  Party,
  ProcessType,
  Warehouse,
} from '../types/erp';

interface ChatalKhamalPanelProps {
  chatalBatches: ChatalBatch[];
  warehouses: Warehouse[];
  paddyItems: ItemMaster[];
  lots: InventoryLot[];
  purchases?: PaddyPurchase[];
  accounts: Account[];
  customers: Party[];
  showNewForm: boolean;
  onToggleNewForm: (next: boolean) => void;
  onRefresh: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

interface IntakeLineDraft {
  uid: string;
  source_warehouse_id: number;
  paddy_item_id: number;
  purchase_id?: number;
  preferred_lot_id?: number;
  bag_count: number;
  qty_kg: number;
  unit_divisor: number;
  notes: string;
}

interface DispatchSplitDraft {
  uid: string;
  dest_warehouse_id: number;
  bag_count: number;
  qty_kg: number;
  weight_pending: boolean;
  sale_style_unit_kg: number;
  sale_style_rate: number;
  notes: string;
}

type ChatalExpenseKey = 'DRYING' | 'KHAMAL' | 'LABOR' | 'FUEL_POWER' | 'PACKAGING' | 'TRANSPORT' | 'OTHER';

const CHATAL_EXPENSE_TYPES: Array<{ key: ChatalExpenseKey; bn: string; en: string }> = [
  { key: 'DRYING', bn: 'ধান শুকানো খরচ', en: 'Paddy Drying Expense' },
  { key: 'KHAMAL', bn: 'ধান খামাল / ঢিবি খরচ', en: 'Khamal / Stacking Expense' },
  { key: 'LABOR', bn: 'লেবার / শ্রমিক মজুরি', en: 'Labor / Coolie Wages' },
  { key: 'FUEL_POWER', bn: 'জ্বালানি / ত্রিপল / বিদ্যুৎ', en: 'Fuel / Tarp / Power' },
  { key: 'PACKAGING', bn: 'বস্তা ও সুতা খরচ', en: 'Packaging & Bags' },
  { key: 'TRANSPORT', bn: 'পরিবহন / ট্রলি ভাড়া', en: 'Transport & Trolley' },
  { key: 'OTHER', bn: 'অন্যান্য চাতাল খরচ', en: 'Other Chatal Expense' },
];

export const ChatalKhamalPanel: React.FC<ChatalKhamalPanelProps> = ({
  chatalBatches,
  warehouses,
  paddyItems,
  lots,
  purchases = [],
  accounts,
  customers,
  showNewForm,
  onToggleNewForm,
  onRefresh,
  onNotify,
}) => {
  const { lang } = useI18n();
  const isBn = lang === 'bn';
  const [selectedPurchaseId, setSelectedPurchaseId] = useState<number>(0);

  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'COMPLETED'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Modal ID states (ID-based so refreshes never show stale snapshots)
  const [addInputBatchId, setAddInputBatchId] = useState<number | null>(null);
  const [expenseBatchId, setExpenseBatchId] = useState<number | null>(null);
  const [dispatchBatchId, setDispatchBatchId] = useState<number | null>(null);
  const [crushingTarget, setCrushingTarget] = useState<{ batchId: number; lot: InventoryLot } | null>(null);
  const [directSaleTarget, setDirectSaleTarget] = useState<{ batchId: number; lot: InventoryLot } | null>(null);
  const [pnlBatchId, setPnlBatchId] = useState<number | null>(null);

  const [submitting, setSubmitting] = useState(false);

  const chatalWarehouses = useMemo(() => {
    const yards = warehouses.filter((w) => w.warehouse_type === 'DRYING_YARD');
    return yards.length > 0 ? yards : warehouses;
  }, [warehouses]);

  const godownWarehouses = useMemo(() => {
    const raw = warehouses.filter((w) => w.warehouse_type === 'RAW_PADDY' || w.warehouse_type === 'GENERAL' || w.warehouse_type === 'DRYING_YARD');
    return raw.length > 0 ? raw : warehouses;
  }, [warehouses]);

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

  // Stock map per warehouse + paddy item
  const stockMap = useMemo(() => {
    const m = new Map<string, { bags: number; weightKg: number; value: number }>();
    for (const l of lots) {
      const kg = Number(l.remaining_qty_kg || 0);
      if (kg <= 0.0001) continue;
      const key = `${l.warehouse_id}-${l.item_id}`;
      const cur = m.get(key) || { bags: 0, weightKg: 0, value: 0 };
      const bagWt = Number(l.bag_weight_kg || paddyItems.find((it) => it.id === l.item_id)?.bag_weight_kg || 60) || 60;
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
  }, [lots, paddyItems]);

  const estimateInputCost = (whId: number, itemId: number, qtyKg: number, bagCount: number, divisor: number) => {
    const raw = stockMap.get(`${whId}-${itemId}`) || { bags: 0, weightKg: 0, value: 0 };
    const safeDiv = divisor > 0 ? divisor : 75.5;
    const stockUnits = raw.weightKg > raw.bags ? (raw.weightKg - raw.bags) / safeDiv : 0;
    const bagUnitRate = stockUnits > 0 ? raw.value / stockUnits : 0;
    const goingUnits = qtyKg > bagCount && safeDiv > 0 ? (qtyKg - bagCount) / safeDiv : 0;
    const estCost =
      bagUnitRate > 0 && goingUnits > 0
        ? bagUnitRate * goingUnits
        : raw.weightKg > 0
        ? (raw.value / raw.weightKg) * qtyKg
        : 0;
    return { ...raw, estCost: Number(estCost.toFixed(2)) };
  };

  // 1. New Chatal Batch Form
  const defaultChatalWhId = chatalWarehouses[0]?.id || warehouses[0]?.id || 0;
  const defaultSrcWhId = warehouses.find((w) => w.warehouse_type === 'RAW_PADDY')?.id || warehouses[0]?.id || 0;
  const defaultPaddyId = paddyItems[0]?.id || 0;

  const [newForm, setNewForm] = useState({
    title: '',
    chatal_warehouse_id: defaultChatalWhId,
    paddy_item_id: defaultPaddyId,
    drying_cost: 0,
    khamal_cost: 0,
    payment_timing: 'PAID' as 'PAID' | 'UNPAID' | 'PARTIAL',
    paid_now: 0,
    account_id: 0,
    notes: '',
  });

  const [intakeLines, setIntakeLines] = useState<IntakeLineDraft[]>([
    {
      uid: 'init-line-1',
      source_warehouse_id: defaultSrcWhId,
      paddy_item_id: defaultPaddyId,
      bag_count: 0,
      qty_kg: 0,
      unit_divisor: 75.5,
      notes: '',
    },
  ]);

  const effectiveChatalWhId = chatalWarehouses.some((w) => w.id === newForm.chatal_warehouse_id)
    ? newForm.chatal_warehouse_id
    : defaultChatalWhId;
  const effectiveNewPaddyId = paddyItems.some((i) => i.id === newForm.paddy_item_id) ? newForm.paddy_item_id : defaultPaddyId;

  const updateIntakeLine = (uid: string, patch: Partial<IntakeLineDraft>) => {
    setIntakeLines((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  };

  const newIntakePreview = useMemo(() => {
    let bags = 0;
    let kg = 0;
    let paddyCost = 0;
    for (const line of intakeLines) {
      const wh = warehouses.some((w) => w.id === line.source_warehouse_id) ? line.source_warehouse_id : defaultSrcWhId;
      const it = effectiveNewPaddyId || line.paddy_item_id;
      const est = estimateInputCost(wh, it, Number(line.qty_kg || 0), Number(line.bag_count || 0), Number(line.unit_divisor || 75.5));
      bags += Math.max(0, Math.round(Number(line.bag_count || 0)));
      kg += Math.max(0, Number(line.qty_kg || 0));
      paddyCost += est.estCost;
    }
    const initExp = Math.max(0, Number(newForm.drying_cost || 0)) + Math.max(0, Number(newForm.khamal_cost || 0));
    return {
      bags,
      kg: Number(kg.toFixed(2)),
      paddyCost: Number(paddyCost.toFixed(2)),
      initExp: Number(initExp.toFixed(2)),
      totalCost: Number((paddyCost + initExp).toFixed(2)),
    };
  }, [intakeLines, newForm.drying_cost, newForm.khamal_cost, warehouses, defaultSrcWhId, effectiveNewPaddyId, stockMap]);

  const handleCreateChatalBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    const validLines = intakeLines
      .map((l) => ({
        source_warehouse_id: warehouses.some((w) => w.id === l.source_warehouse_id) ? l.source_warehouse_id : defaultSrcWhId,
        paddy_item_id: effectiveNewPaddyId || l.paddy_item_id,
        purchase_id: l.purchase_id || undefined,
        preferred_lot_id: l.preferred_lot_id || undefined,
        bag_count: Math.max(0, Math.round(Number(l.bag_count || 0))),
        qty_kg: Number(l.qty_kg || 0),
        unit_divisor: Number(l.unit_divisor || 75.5) > 0 ? Number(l.unit_divisor || 75.5) : 75.5,
        costing_method: 'FIFO' as CostingMethod,
        notes: l.notes,
      }))
      .filter((l) => l.qty_kg > 0);

    if (!effectiveChatalWhId || validLines.length === 0) {
      onNotify(
        isBn ? 'চাতাল গুদাম এবং অন্তত একটি বৈধ ধানের ওজন (কেজি) নির্বাচন করুন।' : 'Select a Chatal yard and enter valid paddy weight (kg).',
        'err'
      );
      return;
    }

    setSubmitting(true);
    try {
      const res = await apiMutate({
        endpoint: '/api/v1/chatal-batches',
        payload: {
          title: newForm.title.trim(),
          chatal_warehouse_id: effectiveChatalWhId,
          paddy_item_id: effectiveNewPaddyId,
          drying_cost: Math.max(0, Number(newForm.drying_cost || 0)),
          khamal_cost: Math.max(0, Number(newForm.khamal_cost || 0)),
          payment_timing: newForm.payment_timing,
          paid_now: newForm.payment_timing === 'PARTIAL' ? Number(newForm.paid_now || 0) : undefined,
          account_id: newForm.account_id || defaultCashAccountId || undefined,
          notes: newForm.notes.trim(),
          inputs: validLines,
        },
        module: 'Chatal & Khamal Batch',
        summary: `Poured ${newIntakePreview.bags} bags (${newIntakePreview.kg} kg) onto Chatal`,
      });
      if (res.offlineQueued) {
        onNotify(isBn ? 'অফলাইন: চাতাল ব্যাচ কিউতে সংরক্ষিত হয়েছে।' : 'Offline: Chatal batch queued.', 'warn');
      } else {
        onNotify(
          isBn
            ? `নতুন চাতাল ব্যাচ চালু হয়েছে: ${newIntakePreview.bags} বস্তা (${newIntakePreview.kg} কেজি) চাটালে ঢালা হয়েছে।`
            : `Chatal batch started with ${newIntakePreview.bags} bags (${newIntakePreview.kg} kg).`,
          'ok'
        );
      }
      setSelectedPurchaseId(0);
      setNewForm((prev) => ({ ...prev, title: '', drying_cost: 0, khamal_cost: 0, paid_now: 0, notes: '' }));
      setIntakeLines([
        {
          uid: crypto.randomUUID(),
          source_warehouse_id: defaultSrcWhId,
          paddy_item_id: effectiveNewPaddyId,
          bag_count: 0,
          qty_kg: 0,
          unit_divisor: 75.5,
          notes: '',
        },
      ]);
      onToggleNewForm(false);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSubmitting(false);
    }
  };

  // Active batch lookups for modals
  const addInputBatch = useMemo(
    () => (addInputBatchId ? chatalBatches.find((b) => b.id === addInputBatchId) || null : null),
    [chatalBatches, addInputBatchId]
  );
  const expenseBatch = useMemo(
    () => (expenseBatchId ? chatalBatches.find((b) => b.id === expenseBatchId) || null : null),
    [chatalBatches, expenseBatchId]
  );
  const dispatchBatch = useMemo(
    () => (dispatchBatchId ? chatalBatches.find((b) => b.id === dispatchBatchId) || null : null),
    [chatalBatches, dispatchBatchId]
  );
  const pnlBatch = useMemo(
    () => (pnlBatchId ? chatalBatches.find((b) => b.id === pnlBatchId) || null : null),
    [chatalBatches, pnlBatchId]
  );

  // 2. Add Extra Paddy Form
  const [addInputForm, setAddInputForm] = useState({
    source_warehouse_id: defaultSrcWhId,
    bag_count: 0,
    qty_kg: 0,
    unit_divisor: 75.5,
    notes: '',
  });

  const openAddInputModal = (b: ChatalBatch) => {
    setAddInputForm({
      source_warehouse_id: b.inputs?.[0]?.source_warehouse_id || defaultSrcWhId,
      bag_count: 0,
      qty_kg: 0,
      unit_divisor: 75.5,
      notes: '',
    });
    setAddInputBatchId(b.id);
  };

  const handleAddExtraInput = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addInputBatch) return;
    const whId = warehouses.some((w) => w.id === addInputForm.source_warehouse_id) ? addInputForm.source_warehouse_id : defaultSrcWhId;
    if (addInputForm.qty_kg <= 0) {
      onNotify(isBn ? 'অতিরিক্ত ধানের ওজন (কেজি) দিন।' : 'Enter additional paddy weight (kg).', 'err');
      return;
    }
    setSubmitting(true);
    try {
      await apiMutate({
        endpoint: `/api/v1/chatal-batches/${addInputBatch.id}/inputs`,
        payload: {
          source_warehouse_id: whId,
          paddy_item_id: addInputBatch.paddy_item_id,
          bag_count: Math.max(0, Math.round(Number(addInputForm.bag_count || 0))),
          qty_kg: Number(addInputForm.qty_kg || 0),
          unit_divisor: addInputForm.unit_divisor || 75.5,
          costing_method: 'FIFO',
          notes: addInputForm.notes.trim(),
        },
        module: 'Chatal Extra Intake',
        summary: `Added ${addInputForm.bag_count} bags (${addInputForm.qty_kg} kg) to ${addInputBatch.chatal_no}`,
      });
      onNotify(
        isBn
          ? `${addInputBatch.chatal_no}-এ আরও ${addInputForm.bag_count} বস্তা (${addInputForm.qty_kg} কেজি) ধান ঢালা হয়েছে।`
          : `Added ${addInputForm.qty_kg} kg to ${addInputBatch.chatal_no}.`,
        'ok'
      );
      setAddInputBatchId(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSubmitting(false);
    }
  };

  // 3. Expense & Pay Due Form
  const [expForm, setExpForm] = useState({
    expense_type: 'DRYING' as ChatalExpenseKey,
    vendor_name: '',
    total_amount: 0,
    payment_timing: 'PAID' as 'PAID' | 'UNPAID' | 'PARTIAL',
    paid_now: 0,
    account_id: 0,
    notes: '',
  });
  const [payingExp, setPayingExp] = useState<ChatalBatchExpense | null>(null);
  const [payDueForm, setPayDueForm] = useState({
    account_id: 0,
    amount: 0,
    payment_mode: 'CASH' as 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'UPI_MOBILE',
    reference_no: '',
    notes: '',
  });

  const openExpenseModal = (b: ChatalBatch) => {
    setExpenseBatchId(b.id);
    setPayingExp(null);
    setExpForm({
      expense_type: 'DRYING',
      vendor_name: '',
      total_amount: 0,
      payment_timing: 'PAID',
      paid_now: 0,
      account_id: defaultCashAccountId,
      notes: '',
    });
  };

  const handleSaveChatalExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!expenseBatch) return;
    if (expForm.total_amount <= 0) {
      onNotify(isBn ? 'খরচের পরিমাণ শূন্যের বেশি দিন।' : 'Enter a positive expense amount.', 'err');
      return;
    }
    setSubmitting(true);
    try {
      await apiMutate({
        endpoint: `/api/v1/chatal-batches/${expenseBatch.id}/expenses`,
        payload: {
          expense_type: expForm.expense_type,
          vendor_name: expForm.vendor_name.trim(),
          total_amount: expForm.total_amount,
          payment_timing: expForm.payment_timing,
          paid_now: expForm.payment_timing === 'PARTIAL' ? expForm.paid_now : undefined,
          account_id: expForm.account_id || defaultCashAccountId || undefined,
          notes: expForm.notes.trim(),
        },
        module: 'Chatal Expense',
        summary: `${expForm.expense_type} ৳${expForm.total_amount} on ${expenseBatch.chatal_no}`,
      });
      onNotify(
        isBn
          ? `${expenseBatch.chatal_no}-এ ৳${Number(expForm.total_amount).toLocaleString('en-IN')} খরচ যোগ হয়েছে।`
          : `Expense added to ${expenseBatch.chatal_no}.`,
        'ok'
      );
      setExpForm((prev) => ({ ...prev, total_amount: 0, paid_now: 0, vendor_name: '', notes: '' }));
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSubmitting(false);
    }
  };

  const handlePayExpenseDue = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!expenseBatch || !payingExp) return;
    if (payDueForm.amount <= 0) {
      onNotify(isBn ? 'পরিশোধের পরিমাণ দিন।' : 'Enter payment amount.', 'err');
      return;
    }
    setSubmitting(true);
    try {
      await apiMutate({
        endpoint: `/api/v1/chatal-batches/${expenseBatch.id}/expenses/${payingExp.id}/pay`,
        payload: {
          account_id: payDueForm.account_id || defaultCashAccountId || undefined,
          amount: payDueForm.amount,
          payment_mode: payDueForm.payment_mode,
          reference_no: payDueForm.reference_no.trim(),
          notes: payDueForm.notes.trim(),
        },
        module: 'Chatal Expense Settlement',
        summary: `Paid ৳${payDueForm.amount} due on ${expenseBatch.chatal_no}`,
      });
      onNotify(
        isBn ? `৳${Number(payDueForm.amount).toLocaleString('en-IN')} বকেয়া খরচ পরিশোধ হয়েছে।` : 'Due expense settled.',
        'ok'
      );
      setPayingExp(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSubmitting(false);
    }
  };

  // 4. Multi-Godown Split Dispatch Form (Round 1, Round 2...)
  const [dispatchMeta, setDispatchMeta] = useState({ moisture_loss_kg: 0, notes: '' });
  const [dispatchSplits, setDispatchSplits] = useState<DispatchSplitDraft[]>([]);

  const openDispatchModal = (b: ChatalBatch) => {
    const firstGd = godownWarehouses.find((w) => w.id !== b.chatal_warehouse_id)?.id || godownWarehouses[0]?.id || 0;
    const secondGd =
      godownWarehouses.find((w) => w.id !== b.chatal_warehouse_id && w.id !== firstGd)?.id || firstGd;
    setDispatchMeta({ moisture_loss_kg: 0, notes: '' });
    setDispatchSplits([
      {
        uid: crypto.randomUUID(),
        dest_warehouse_id: firstGd,
        bag_count: 0,
        qty_kg: 0,
        weight_pending: false,
        sale_style_unit_kg: 75.5,
        sale_style_rate: 0,
        notes: '',
      },
      {
        uid: crypto.randomUUID(),
        dest_warehouse_id: secondGd,
        bag_count: 0,
        qty_kg: 0,
        weight_pending: false,
        sale_style_unit_kg: 75.5,
        sale_style_rate: 0,
        notes: '',
      },
    ]);
    setDispatchBatchId(b.id);
  };

  const updateDispatchSplit = (uid: string, patch: Partial<DispatchSplitDraft>) => {
    setDispatchSplits((prev) => prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  };

  const handleDispatchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!dispatchBatch) return;
    const validSplits = dispatchSplits.filter((s) => Number(s.bag_count || 0) > 0 || (!s.weight_pending && Number(s.qty_kg || 0) > 0));
    if (validSplits.length === 0) {
      onNotify(
        isBn ? 'অন্তত একটি গন্তব্য গোডাউনে বস্তা বা ওজন দিন।' : 'Enter bag count or weight for at least one godown.',
        'err'
      );
      return;
    }
    for (const sp of validSplits) {
      if (!sp.weight_pending && Number(sp.qty_kg || 0) <= 0) {
        onNotify(
          isBn ? 'ওজন উল্লেখ করুন অথবা "ওজন ছাড়া শুধু বস্তা" টিক দিন।' : 'Enter weight (kg) or check Weight Pending.',
          'err'
        );
        return;
      }
    }

    setSubmitting(true);
    try {
      const roundNext = (dispatchBatch.dispatches?.reduce((mx, d) => Math.max(mx, Number(d.round_no || 0)), 0) || 0) + 1;
      await apiMutate({
        endpoint: `/api/v1/chatal-batches/${dispatchBatch.id}/dispatch`,
        payload: {
          moisture_loss_kg: Math.max(0, Number(dispatchMeta.moisture_loss_kg || 0)),
          notes: dispatchMeta.notes.trim(),
          splits: validSplits.map((sp) => ({
            dest_warehouse_id: sp.dest_warehouse_id,
            bag_count: Math.max(0, Math.round(Number(sp.bag_count || 0))),
            qty_kg: sp.weight_pending ? 0 : Number(sp.qty_kg || 0),
            weight_pending: sp.weight_pending,
            sale_style_unit_kg: sp.sale_style_unit_kg || 75.5,
            sale_style_rate: sp.sale_style_rate || 0,
            notes: sp.notes.trim(),
          })),
        },
        module: 'Chatal Multi-Godown Dispatch',
        summary: `${dispatchBatch.chatal_no} Round #${roundNext} -> ${validSplits.length} godown(s)`,
      });
      onNotify(
        isBn
          ? `${dispatchBatch.chatal_no} থেকে ধাপ #${roundNext}-এ ${validSplits.length}টি গোডাউনে ধান পাঠানো সম্পন্ন হয়েছে।`
          : `Dispatched Round #${roundNext} from ${dispatchBatch.chatal_no} to ${validSplits.length} godown(s).`,
        'ok'
      );
      setDispatchBatchId(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSubmitting(false);
    }
  };

  // 5. Send to Crushing Form (from remaining Chatal or any Split Godown lot)
  const [crushForm, setCrushForm] = useState({
    process_type: 'PARBOILED_SIDDHO' as ProcessType,
    bag_count: 0,
    qty_kg: 0,
    dryer_no: '',
    dryer_count: 1,
    unit_divisor: 75.5,
    close_pending_lot: true,
    notes: '',
  });

  const openCrushingModal = (batchId: number, lot: InventoryLot) => {
    setCrushForm({
      process_type: 'PARBOILED_SIDDHO',
      bag_count: Math.max(0, Number(lot.remaining_bags || 0)),
      qty_kg: Math.max(0, Number(lot.remaining_qty_kg || 0)),
      dryer_no: 'ডায়ার-১',
      dryer_count: 1,
      unit_divisor: 75.5,
      close_pending_lot: true,
      notes: '',
    });
    setCrushingTarget({ batchId, lot });
  };

  const handleSendToCrushingSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!crushingTarget) return;
    if (crushForm.qty_kg <= 0) {
      onNotify(isBn ? 'ক্রাশিংয়ের জন্য ধানের ওজন (কেজি) শূন্যের বেশি দিন।' : 'Enter paddy weight (kg) for crushing.', 'err');
      return;
    }
    setSubmitting(true);
    try {
      await apiMutate({
        endpoint: `/api/v1/chatal-batches/${crushingTarget.batchId}/send-to-crushing`,
        payload: {
          lot_id: crushingTarget.lot.id,
          process_type: crushForm.process_type,
          bag_count: Math.max(0, Math.round(Number(crushForm.bag_count || 0))),
          qty_kg: Number(crushForm.qty_kg || 0),
          dryer_no: crushForm.dryer_no.trim() || 'ডায়ার-১',
          dryer_count: Math.max(1, Math.round(Number(crushForm.dryer_count || 1))),
          unit_divisor: crushForm.unit_divisor || 75.5,
          close_pending_lot: Boolean(crushForm.close_pending_lot),
          notes: crushForm.notes.trim(),
        },
        module: 'Chatal Send to Crushing',
        summary: `Send ${crushForm.bag_count} bags (${crushForm.qty_kg} kg) from ${crushingTarget.lot.lot_code} to Crushing`,
      });
      onNotify(
        isBn
          ? `${crushingTarget.lot.lot_code} থেকে ${crushForm.bag_count} বস্তা (${crushForm.qty_kg} কেজি) ক্রাশিং ব্যাচে পাঠানো হয়েছে। মিলিং ট্যাবে গিয়ে চাল ও তুষ আউটপুট শেষ করুন।`
          : `Sent ${crushForm.qty_kg} kg from ${crushingTarget.lot.lot_code} to Crushing.`,
        'ok'
      );
      setCrushingTarget(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSubmitting(false);
    }
  };

  // 6. Direct Sale Form (with Sale-Style (ওজন − বাদ) ÷ ৭৫.৫ × দর formula + torn bag support)
  const [saleForm, setSaleForm] = useState({
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
    close_pending_lot: true,
    notes: '',
  });

  const openDirectSaleModal = (batch: ChatalBatch, lot: InventoryLot) => {
    const remBags = Math.max(0, Number(lot.remaining_bags || 0));
    const remKg = Math.max(0, Number(lot.remaining_qty_kg || 0));
    const itemDef = paddyItems.find((i) => i.id === lot.item_id);
    const defaultRate = itemDef?.default_rate ? Number((itemDef.default_rate * 75.5).toFixed(2)) : 0;
    const matchedDispatch = batch.dispatches?.find((d) => d.dest_lot_id === lot.id);
    setSaleForm({
      customer_id: customers[0]?.id || 0,
      scale_weight_kg: remKg,
      qty_kg: remKg,
      weight_loss_kg: remBags,
      jute_bag_count: remBags,
      plastic_bag_count: 0,
      settlement_unit_kg: Number(matchedDispatch?.sale_style_unit_kg || 75.5) || 75.5,
      settlement_rate: Number(matchedDispatch?.sale_style_rate || defaultRate || 0),
      paid_amount: 0,
      vehicle_no: '',
      challan_no: '',
      close_pending_lot: true,
      notes: '',
    });
    setDirectSaleTarget({ batchId: batch.id, lot });
  };

  const saleTotalBags =
    Math.max(0, Math.round(Number(saleForm.jute_bag_count || 0))) +
    Math.max(0, Math.round(Number(saleForm.plastic_bag_count || 0)));
  const saleDivisor = saleForm.settlement_unit_kg > 0 ? saleForm.settlement_unit_kg : 75.5;
  const saleNetKg = Math.max(0, Number((Number(saleForm.qty_kg || 0) - Number(saleForm.weight_loss_kg || 0)).toFixed(3)));
  const saleUnits = Number((saleNetKg / saleDivisor).toFixed(4));
  const saleTotalVal = Number((saleUnits * Number(saleForm.settlement_rate || 0)).toFixed(2));
  const saleEffectivePerKg = Number(saleForm.qty_kg || 0) > 0 ? Number((saleTotalVal / Number(saleForm.qty_kg || 0)).toFixed(4)) : 0;

  const handleDirectSaleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!directSaleTarget) return;
    const custId = customers.some((c) => c.id === saleForm.customer_id) ? saleForm.customer_id : customers[0]?.id || 0;
    if (!custId) {
      onNotify(isBn ? 'ক্রেতা নির্বাচন করুন।' : 'Select a buyer.', 'err');
      return;
    }
    if (Number(saleForm.qty_kg || 0) <= 0 || saleNetKg <= 0 || Number(saleForm.settlement_rate || 0) <= 0) {
      onNotify(
        isBn ? 'সঠিক ওজন (কেজি) এবং বিক্রির দর দিন।' : 'Valid delivery weight and settlement rate required.',
        'err'
      );
      return;
    }
    setSubmitting(true);
    try {
      await apiMutate({
        endpoint: '/api/v1/paddy-sales',
        payload: {
          customer_id: custId,
          warehouse_id: directSaleTarget.lot.warehouse_id,
          item_id: directSaleTarget.lot.item_id,
          preferred_lot_id: directSaleTarget.lot.id,
          chatal_batch_id: directSaleTarget.batchId,
          costing_method: 'FIFO',
          vehicle_no: saleForm.vehicle_no.trim(),
          challan_no: saleForm.challan_no.trim(),
          bag_count: saleTotalBags,
          jute_bag_count: Math.max(0, Math.round(Number(saleForm.jute_bag_count || 0))),
          plastic_bag_count: Math.max(0, Math.round(Number(saleForm.plastic_bag_count || 0))),
          scale_weight_kg: saleForm.scale_weight_kg || saleForm.qty_kg,
          qty_kg: saleForm.qty_kg,
          payment_weight_kg: saleForm.qty_kg,
          weight_loss_kg: saleForm.weight_loss_kg,
          settlement_unit_kg: saleDivisor,
          settlement_rate: saleForm.settlement_rate,
          rate_per_kg: saleEffectivePerKg,
          paid_amount: saleForm.paid_amount,
          close_pending_lot: Boolean(saleForm.close_pending_lot),
          notes: saleForm.notes.trim() || `Chatal lot ${directSaleTarget.lot.lot_code} direct sale`,
        },
        module: 'Chatal Direct Paddy Sale',
        summary: `Direct sale ${saleTotalBags} bags (${saleForm.qty_kg} kg) from ${directSaleTarget.lot.lot_code} · ৳${saleTotalVal.toLocaleString('en-IN')}`,
      });
      onNotify(
        isBn
          ? `${directSaleTarget.lot.lot_code} থেকে ${saleTotalBags} বস্তা (${saleForm.qty_kg} কেজি) বিক্রির নিয়মে দাম বসিয়ে সরাসরি বিক্রি সম্পন্ন হয়েছে (৳${saleTotalVal.toLocaleString('en-IN')})।`
          : `Direct sale completed from ${directSaleTarget.lot.lot_code}.`,
        'ok'
      );
      setDirectSaleTarget(null);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSubmitting(false);
    }
  };

  // 7. Close Batch handler
  const [writeOffShrinkage, setWriteOffShrinkage] = useState(false);
  const handleCloseBatch = async (b: ChatalBatch) => {
    setSubmitting(true);
    try {
      await apiMutate({
        endpoint: `/api/v1/chatal-batches/${b.id}/close`,
        payload: { write_off_remaining: writeOffShrinkage },
        module: 'Close Chatal Batch',
        summary: `Finalize Chatal Batch ${b.chatal_no}`,
      });
      onNotify(
        isBn ? `${b.chatal_no} চাতাল ব্যাচ সফলভাবে শেষ ও হিসাব চূড়ান্ত করা হয়েছে।` : `${b.chatal_no} finalized.`,
        'ok'
      );
      setWriteOffShrinkage(false);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    } finally {
      setSubmitting(false);
    }
  };

  const getExpenseTypeLabel = (type: string) => {
    const found = CHATAL_EXPENSE_TYPES.find((x) => x.key === type);
    return found ? (isBn ? found.bn : found.en) : type;
  };

  const filteredBatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return chatalBatches.filter((b) => {
      if (statusFilter !== 'ALL' && b.status !== statusFilter) return false;
      if (!q) return true;
      return (
        b.chatal_no.toLowerCase().includes(q) ||
        b.title.toLowerCase().includes(q) ||
        (b.paddy_item_name || '').toLowerCase().includes(q) ||
        (b.chatal_warehouse_name || '').toLowerCase().includes(q)
      );
    });
  }, [chatalBatches, statusFilter, searchQuery]);

  const summaryKpis = useMemo(() => {
    let activeCount = 0;
    let totalIntakeKg = 0;
    let totalIntakeBags = 0;
    let totalDriedDispatchedKg = 0;
    let totalDriedDispatchedBags = 0;
    let onChatalKg = 0;
    let onChatalBags = 0;
    let inGodownKg = 0;
    let inGodownBags = 0;
    let totalNetPnl = 0;
    for (const b of chatalBatches) {
      if (b.status === 'ACTIVE') activeCount += 1;
      totalIntakeKg += Number(b.pnl?.total_intake_kg ?? b.total_intake_kg ?? 0);
      totalIntakeBags += Number(b.pnl?.total_intake_bags ?? b.total_intake_bags ?? 0);
      for (const d of b.dispatches || []) {
        totalDriedDispatchedBags += Number(d.bag_count || 0);
        if (!d.weight_pending && Number(d.qty_kg || 0) > 0) {
          totalDriedDispatchedKg += Number(d.qty_kg || 0);
        }
      }
      if (b.pnl) {
        onChatalKg += Number(b.pnl.chatal_remaining_kg || 0);
        onChatalBags += Number(b.pnl.chatal_remaining_bags || 0);
        inGodownKg += Number(b.pnl.godown_remaining_kg || 0);
        inGodownBags += Number(b.pnl.godown_remaining_bags || 0);
        totalNetPnl += Number(b.pnl.net_profit_loss || 0);
      }
    }
    return {
      activeCount,
      totalIntakeKg: Number(totalIntakeKg.toFixed(2)),
      totalIntakeBags,
      totalDriedDispatchedKg: Number(totalDriedDispatchedKg.toFixed(2)),
      totalDriedDispatchedBags,
      onChatalKg,
      onChatalBags,
      inGodownKg,
      inGodownBags,
      totalNetPnl,
    };
  }, [chatalBatches]);

  return (
    <div className="space-y-5">
      {/* KPI Summary Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{isBn ? 'মোট কাঁচা ঢালা বনাম তোলা' : 'Raw Poured vs Dried Lifted'}</div>
          <div className="text-xl sm:text-2xl font-display font-bold font-mono tabular-nums mt-1">
            {summaryKpis.totalIntakeKg.toLocaleString('en-IN')} {isBn ? 'কেজি' : 'kg'}
          </div>
          <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
            {isBn
              ? `কাঁচা ${summaryKpis.totalIntakeBags}ব → তোলা ${summaryKpis.totalDriedDispatchedBags}ব (${summaryKpis.activeCount} সক্রিয়)`
              : `${summaryKpis.totalIntakeBags}b raw → ${summaryKpis.totalDriedDispatchedBags}b lifted (${summaryKpis.activeCount}/${chatalBatches.length})`}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{isBn ? 'বর্তমানে চাটালে থাকা ধান' : 'Currently on Chatal'}</div>
          <div className="text-xl sm:text-2xl font-display font-bold font-mono tabular-nums mt-1">
            {summaryKpis.onChatalKg.toLocaleString('en-IN')} {isBn ? 'কেজি' : 'kg'}
          </div>
          <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
            {summaryKpis.onChatalBags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{isBn ? 'গোডাউনে শুকিয়ে তোলা মজুদ' : 'Dried Godown Stock'}</div>
          <div className="text-xl sm:text-2xl font-display font-bold font-mono tabular-nums mt-1">
            {summaryKpis.inGodownKg.toLocaleString('en-IN')} {isBn ? 'কেজি' : 'kg'}
          </div>
          <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
            {summaryKpis.inGodownBags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'}
            {summaryKpis.totalDriedDispatchedKg > 0
              ? ` · ${isBn ? 'ওজনসহ তোলা' : 'weighed'}: ${summaryKpis.totalDriedDispatchedKg.toLocaleString('en-IN')} kg`
              : ''}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-xs text-slate-500">{isBn ? 'সর্বমোট চাতাল লাভ / লস' : 'Cumulative Net Profit / Loss'}</div>
          <div
            className={`text-xl sm:text-2xl font-display font-bold font-mono tabular-nums mt-1 ${
              summaryKpis.totalNetPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
            }`}
          >
            {summaryKpis.totalNetPnl >= 0 ? '+' : '−'}৳{Math.abs(summaryKpis.totalNetPnl).toLocaleString('en-IN')}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {isBn ? 'সব ধান + শুকানো + খামাল খরচ বাদে' : 'After paddy + drying + khamal cost'}
          </div>
        </div>
      </div>

      {/* NEW CHATAL BATCH FORM */}
      {showNewForm && (
        <form
          onSubmit={handleCreateChatalBatch}
          className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
            <div>
              <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                {isBn ? 'নতুন চাতাল ও খামাল ব্যাচ (চাটালে ধান ঢালুন)' : 'New Chatal & Khamal Batch (Pour Paddy onto Yard)'}
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {isBn
                  ? 'ধান ঢালার পর অংশবিশেষ চাটালে রেখে ধাপে ধাপে একাধিক গোডাউনে পাঠাতে, ক্রাশিংয়ে দিতে বা সরাসরি বিক্রি করতে পারবেন।'
                  : 'Pour paddy now, then split-dispatch across multiple godowns in rounds, crush, or sell directly.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => onToggleNewForm(false)}
              className="text-xs text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 px-2 py-1"
            >
              {isBn ? 'বন্ধ করুন' : 'Close'}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <div>
              <label className="block font-medium mb-1">{isBn ? 'ব্যাচের নাম / খামাল নম্বর' : 'Batch Title / Khamal Ref'}</label>
              <input
                type="text"
                value={newForm.title}
                onChange={(e) => setNewForm({ ...newForm, title: e.target.value })}
                placeholder={isBn ? 'যেমন: জিরাশাইল চাতাল-১ / লট A' : 'e.g. Jirashail Yard-1'}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">{isBn ? 'চাতাল / খামাল ইয়ার্ড *' : 'Chatal Yard Warehouse *'}</label>
              <select
                value={effectiveChatalWhId}
                onChange={(e) => setNewForm({ ...newForm, chatal_warehouse_id: Number(e.target.value) })}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {chatalWarehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name} ({w.warehouse_type})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">{isBn ? 'ধানের জাত *' : 'Paddy Variety *'}</label>
              <select
                value={effectiveNewPaddyId}
                onChange={(e) => setNewForm({ ...newForm, paddy_item_id: Number(e.target.value) })}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              >
                {paddyItems.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">{isBn ? 'মন্তব্য / নোট' : 'Notes'}</label>
              <input
                type="text"
                value={newForm.notes}
                onChange={(e) => setNewForm({ ...newForm, notes: e.target.value })}
                placeholder={isBn ? 'যদি কিছু লিখতে চান...' : 'Optional notes...'}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
              />
            </div>
          </div>

          {/* Optional Quick-Fill from Purchased Paddy */}
          {purchases.length > 0 && (
            <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 flex flex-wrap items-center gap-3 text-xs">
              <label className="font-semibold text-slate-800 dark:text-slate-200 whitespace-nowrap">
                {isBn ? 'কেনা ধানের চালান থেকে নিন (ঐচ্ছিক):' : 'Prefill from Purchase (Optional):'}
              </label>
              <select
                value={selectedPurchaseId}
                onChange={(e) => {
                  const pId = Number(e.target.value);
                  setSelectedPurchaseId(pId);
                  const pur = purchases.find((x) => x.id === pId);
                  if (!pur) return;
                  const matchingLots = lots.filter(
                    (l) => l.source_type === 'PADDY_PURCHASE' && l.source_id === pur.id && Number(l.remaining_qty_kg || 0) > 0
                  );
                  setNewForm((prev) => ({
                    ...prev,
                    title: prev.title || `${pur.purchase_no} · ${pur.supplier_name}`,
                    paddy_item_id: pur.item_id,
                    notes: prev.notes || `${pur.purchase_no} থেকে চাটালে`,
                  }));
                  if (matchingLots.length > 0) {
                    setIntakeLines(
                      matchingLots.map((l) => ({
                        uid: crypto.randomUUID(),
                        source_warehouse_id: l.warehouse_id,
                        paddy_item_id: pur.item_id,
                        purchase_id: pur.id,
                        preferred_lot_id: l.id,
                        bag_count: Number(l.remaining_bags || pur.bag_count || 0),
                        qty_kg: Number(Number(l.remaining_qty_kg || 0).toFixed(2)),
                        unit_divisor: Number(pur.settlement_unit_kg || 75.5),
                        notes: `${pur.purchase_no}`,
                      }))
                    );
                  } else if (pur.splits && pur.splits.length > 0) {
                    setIntakeLines(
                      pur.splits.map((sp) => ({
                        uid: crypto.randomUUID(),
                        source_warehouse_id: sp.warehouse_id,
                        paddy_item_id: pur.item_id,
                        purchase_id: pur.id,
                        bag_count: Number(sp.bag_count || 0),
                        qty_kg: Number(Number(sp.received_weight_kg || 0).toFixed(2)),
                        unit_divisor: Number(pur.settlement_unit_kg || 75.5),
                        notes: `${pur.purchase_no}`,
                      }))
                    );
                  } else {
                    setIntakeLines([
                      {
                        uid: crypto.randomUUID(),
                        source_warehouse_id: pur.warehouse_id,
                        paddy_item_id: pur.item_id,
                        purchase_id: pur.id,
                        bag_count: Number(pur.bag_count || 0),
                        qty_kg: Number(Number(pur.received_weight_kg || 0).toFixed(2)),
                        unit_divisor: Number(pur.settlement_unit_kg || 75.5),
                        notes: `${pur.purchase_no}`,
                      },
                    ]);
                  }
                }}
                className="flex-1 min-w-[240px] px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value={0}>
                  {isBn ? '— কাঁচা কেনা চালান বাছুন অথবা নিচে গোডাউন থেকে নির্বাচন করুন —' : '— Select raw purchased paddy receipt —'}
                </option>
                {purchases
                  .filter((p) => {
                    const activeLotsKg = lots
                      .filter((l) => l.source_type === 'PADDY_PURCHASE' && l.source_id === p.id)
                      .reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);
                    const rem = activeLotsKg > 0 ? activeLotsKg : Number(p.unconsumed_lot_qty_kg ?? 0);
                    return rem > 0.01 && p.paddy_condition !== 'DRIED';
                  })
                  .slice(0, 60)
                  .map((p) => {
                    const activeLotsKg = lots
                      .filter((l) => l.source_type === 'PADDY_PURCHASE' && l.source_id === p.id)
                      .reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);
                    const activeLotsBags = lots
                      .filter((l) => l.source_type === 'PADDY_PURCHASE' && l.source_id === p.id)
                      .reduce((s, l) => s + Number(l.remaining_bags || 0), 0);
                    return (
                      <option key={p.id} value={p.id}>
                        {p.purchase_no} · {p.supplier_name} · {p.item_name} ({activeLotsBags || p.bag_count}{' '}
                        {isBn ? 'বস্তা' : 'bags'} / {Number(activeLotsKg || p.received_weight_kg || 0).toLocaleString('en-IN')} kg ·{' '}
                        {isBn ? 'কাঁচা' : 'Raw'})
                      </option>
                    );
                  })}
              </select>
            </div>
          )}

          {/* Intake Source Lines */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                {isBn ? 'কোন গোডাউন থেকে কত ধান চাটালে ঢালছেন' : 'Paddy Intake Sources'}
              </span>
              <button
                type="button"
                onClick={() =>
                  setIntakeLines((prev) => [
                    ...prev,
                    {
                      uid: crypto.randomUUID(),
                      source_warehouse_id: defaultSrcWhId,
                      paddy_item_id: effectiveNewPaddyId,
                      bag_count: 0,
                      qty_kg: 0,
                      unit_divisor: 75.5,
                      notes: '',
                    },
                  ])
                }
                className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-400 hover:underline"
              >
                <Plus className="w-3.5 h-3.5" />
                {isBn ? 'আরেকটি সারি যোগ করুন' : 'Add Source Line'}
              </button>
            </div>

            <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg bg-slate-50/70 dark:bg-slate-950/60">
              {intakeLines.map((line) => {
                const whId = warehouses.some((w) => w.id === line.source_warehouse_id) ? line.source_warehouse_id : defaultSrcWhId;
                const est = estimateInputCost(whId, effectiveNewPaddyId, line.qty_kg, line.bag_count, line.unit_divisor);
                return (
                  <div key={line.uid} className="p-3 grid grid-cols-1 sm:grid-cols-12 gap-3 items-end text-xs">
                    <div className="sm:col-span-4">
                      <label className="block font-medium mb-1">{isBn ? 'সোর্স গোডাউন' : 'Source Godown'}</label>
                      <select
                        value={whId}
                        onChange={(e) => updateIntakeLine(line.uid, { source_warehouse_id: Number(e.target.value) })}
                        className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                      >
                        {warehouses.map((w) => {
                          const s = stockMap.get(`${w.id}-${effectiveNewPaddyId}`);
                          return (
                            <option key={w.id} value={w.id}>
                              {w.name} ({s ? `${s.bags} বস্তা / ${s.weightKg.toLocaleString('en-IN')} kg` : '0 kg'})
                            </option>
                          );
                        })}
                      </select>
                    </div>
                    <div className="sm:col-span-2">
                      <div className="flex items-center justify-between mb-1">
                        <label className="font-medium">{isBn ? 'বস্তা' : 'Bags'}</label>
                        {est.weightKg > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              updateIntakeLine(line.uid, {
                                bag_count: est.bags,
                                qty_kg: Number(est.weightKg.toFixed(2)),
                              })
                            }
                            className="text-[11px] font-medium text-amber-700 dark:text-amber-400 hover:underline"
                          >
                            {isBn ? 'সব নিন' : 'All'}
                          </button>
                        )}
                      </div>
                      <input
                        type="number"
                        min="0"
                        value={line.bag_count}
                        onChange={(e) => {
                          const bags = Math.max(0, Math.round(Number(e.target.value)));
                          const autoKg = est.bags > 0 ? Math.round((bags * est.weightKg) / est.bags) : bags * 60;
                          updateIntakeLine(line.uid, { bag_count: bags, qty_kg: bags > 0 && autoKg > 0 ? autoKg : line.qty_kg });
                        }}
                        className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <label className="block font-medium mb-1">
                        {isBn ? 'ওজন (কেজি) *' : 'Weight (kg) *'} ·{' '}
                        <span className="font-mono text-slate-500">{est.weightKg.toLocaleString('en-IN')} kg</span>
                      </label>
                      <input
                        type="number"
                        min="0.01"
                        step="0.01"
                        required
                        value={line.qty_kg}
                        onChange={(e) => updateIntakeLine(line.uid, { qty_kg: Number(e.target.value) })}
                        className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                      />
                    </div>
                    <div className="sm:col-span-2">
                      <div className="text-slate-500 mb-1">{isBn ? 'আনুমানিক ধানের দাম' : 'Est. Cost'}</div>
                      <div className="px-3 py-2 font-mono tabular-nums font-semibold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
                        ৳{est.estCost.toLocaleString('en-IN')}
                      </div>
                    </div>
                    <div className="sm:col-span-1 flex justify-end">
                      {intakeLines.length > 1 && (
                        <button
                          type="button"
                          onClick={() => setIntakeLines((prev) => prev.filter((x) => x.uid !== line.uid))}
                          className="p-2 rounded-lg text-slate-400 hover:text-red-600"
                          title={isBn ? 'সারি মুছুন' : 'Remove line'}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Optional Initial Drying & Khamal Costs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-xs">
            <div>
              <label className="block font-medium mb-1">{isBn ? 'প্রাথমিক ধান শুকানো খরচ (৳)' : 'Initial Drying Expense (৳)'}</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={newForm.drying_cost}
                onChange={(e) => setNewForm({ ...newForm, drying_cost: Math.max(0, Number(e.target.value)) })}
                className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">{isBn ? 'প্রাথমিক ধান খামাল খরচ (৳)' : 'Initial Khamal Expense (৳)'}</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={newForm.khamal_cost}
                onChange={(e) => setNewForm({ ...newForm, khamal_cost: Math.max(0, Number(e.target.value)) })}
                className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">{isBn ? 'খরচ পরিশোধ পদ্ধতি' : 'Expense Payment'}</label>
              <select
                value={newForm.payment_timing}
                onChange={(e) => setNewForm({ ...newForm, payment_timing: e.target.value as 'PAID' | 'UNPAID' | 'PARTIAL' })}
                className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="PAID">{isBn ? 'নগদ / ব্যাংক পরিশোধ (Paid)' : 'Paid Now'}</option>
                <option value="UNPAID">{isBn ? 'বাকিতে (পরে পরিশোধ)' : 'Unpaid / Pay Later'}</option>
                <option value="PARTIAL">{isBn ? 'আংশিক পরিশোধ' : 'Partial Paid'}</option>
              </select>
            </div>
            {newForm.payment_timing !== 'UNPAID' ? (
              <div>
                <label className="block font-medium mb-1">{isBn ? 'ক্যাশ / ব্যাংক হিসাব' : 'Cash / Bank Account'}</label>
                <select
                  value={newForm.account_id || defaultCashAccountId}
                  onChange={(e) => setNewForm({ ...newForm, account_id: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                >
                  {paymentAccounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="flex items-end text-slate-500">
                {isBn ? 'পরে যেকোনো সময় খরচ ট্যাব থেকে পরিশোধ করা যাবে।' : 'Can be settled later anytime.'}
              </div>
            )}
            {newForm.payment_timing === 'PARTIAL' && (
              <div>
                <label className="block font-medium mb-1">{isBn ? 'এখন পরিশোধ (৳)' : 'Paid Now (৳)'}</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={newForm.paid_now}
                  onChange={(e) => setNewForm({ ...newForm, paid_now: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                />
              </div>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
            <div className="text-xs font-mono tabular-nums text-slate-700 dark:text-slate-300">
              {isBn ? 'মোট ধান:' : 'Total Paddy:'} <strong>{newIntakePreview.bags} বস্তা / {newIntakePreview.kg.toLocaleString('en-IN')} কেজি</strong> ·{' '}
              {isBn ? 'ধানের মূল্য:' : 'Paddy Cost:'} <strong>৳{newIntakePreview.paddyCost.toLocaleString('en-IN')}</strong> ·{' '}
              {isBn ? 'মোট ব্যয় (শুকানো+খামালসহ):' : 'Total Cost:'}{' '}
              <strong className="text-amber-700 dark:text-amber-400">৳{newIntakePreview.totalCost.toLocaleString('en-IN')}</strong>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="px-5 py-2.5 rounded-lg bg-slate-900 dark:bg-amber-600 hover:opacity-95 text-white text-xs font-semibold disabled:opacity-50"
            >
              {submitting ? (isBn ? 'সংরক্ষণ হচ্ছে...' : 'Saving...') : isBn ? 'চাটালে ধান ঢালুন ও ব্যাচ শুরু করুন' : 'Start Chatal Batch'}
            </button>
          </div>
        </form>
      )}

      {/* Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
          {(['ALL', 'ACTIVE', 'COMPLETED'] as const).map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                statusFilter === st ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm' : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {st === 'ALL' ? (isBn ? 'সকল ব্যাচ' : 'All') : st === 'ACTIVE' ? (isBn ? 'সক্রিয়' : 'Active') : isBn ? 'সম্পন্ন' : 'Completed'}
            </button>
          ))}
        </div>

        <div className="relative w-full sm:w-72">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={isBn ? 'ব্যাচ নং, ধানের জাত বা ইয়ার্ড খুঁজুন...' : 'Search Chatal batch, variety...'}
            className="w-full pl-8 pr-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900"
          />
        </div>
      </div>

      {/* Chatal Batch List */}
      {filteredBatches.length === 0 ? (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-10 text-center space-y-2">
          <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
            {isBn ? 'এখনও কোনো চাতাল ও খামাল ব্যাচ তৈরি করা হয়নি।' : 'No Chatal & Khamal batches recorded yet.'}
          </p>
          <p className="text-xs text-slate-500">
            {isBn
              ? 'উপরের "+ চাটালে ধান ঢালুন" বাটনে ক্লিক করে প্রথম চাতাল ব্যাচ চালু করুন, তারপর একাধিক গোডাউনে ভাগ পাঠান এবং লাভ-লস দেখুন।'
              : 'Click "+ Pour Paddy onto Chatal" above to create your first batch.'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredBatches.map((batch) => {
            const pnl = batch.pnl;
            const totalTakenCost = Number(pnl?.total_paddy_cost ?? batch.total_paddy_cost ?? 0);
            const dryCost = Number(pnl?.drying_cost ?? batch.drying_cost ?? 0);
            const khamalCost = Number(pnl?.khamal_cost ?? batch.khamal_cost ?? 0);
            const otherCost = Number(pnl?.other_cost ?? batch.other_cost ?? 0);
            const totalExp = dryCost + khamalCost + otherCost;
            const unpaidDue = Number(pnl?.unpaid_expense_due ?? 0);
            const netPnl = Number(pnl?.net_profit_loss ?? 0);

            const activeLinkedLots = (batch.linked_lots || []).filter(
              (l) => Number(l.remaining_qty_kg || 0) > 0.0001 || Boolean(l.weight_pending)
            );
            const dispatchesByRound = new Map<number, typeof batch.dispatches>();
            for (const d of batch.dispatches || []) {
              const rNo = Number(d.round_no || 1);
              const list = dispatchesByRound.get(rNo) || [];
              list.push(d);
              dispatchesByRound.set(rNo, list);
            }

            return (
              <div
                key={batch.id}
                className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-5 space-y-4"
              >
                {/* Header Row */}
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 dark:border-slate-800 pb-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="font-mono font-bold text-sm text-slate-900 dark:text-white">{batch.chatal_no}</span>
                      {batch.title && batch.title !== batch.chatal_no && (
                        <>
                          <span className="text-slate-300 dark:text-slate-700">/</span>
                          <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">{batch.title}</span>
                        </>
                      )}
                      <span className="text-slate-300 dark:text-slate-700">·</span>
                      <span className="text-xs font-medium text-slate-600 dark:text-slate-300">{batch.paddy_item_name}</span>
                      <span className="text-slate-300 dark:text-slate-700">·</span>
                      <span className="text-xs text-slate-500">{batch.chatal_warehouse_name}</span>
                      <span className="text-slate-300 dark:text-slate-700">·</span>
                      <span
                        className={`text-xs font-semibold ${
                          batch.status === 'ACTIVE' ? 'text-amber-700 dark:text-amber-400' : 'text-emerald-700 dark:text-emerald-400'
                        }`}
                      >
                        {batch.status === 'ACTIVE' ? (isBn ? 'সক্রিয়' : 'Active') : isBn ? 'সম্পন্ন' : 'Completed'}
                      </span>
                    </div>
                    <div className="text-xs text-slate-500 mt-1 font-mono tabular-nums">
                      {isBn ? 'তারিখ:' : 'Date:'} {batch.created_at}
                      {Number(batch.moisture_loss_kg || 0) > 0 &&
                        ` · ${isBn ? 'শুকানো ঘাটতি:' : 'Moisture Loss:'} ${Number(batch.moisture_loss_kg).toLocaleString('en-IN')} kg`}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {batch.status === 'ACTIVE' && (
                      <>
                        <button
                          type="button"
                          onClick={() => openAddInputModal(batch)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium"
                        >
                          <Plus className="w-3.5 h-3.5" />
                          <span>{isBn ? 'আরও ধান ঢালুন' : 'Add Paddy'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => openExpenseModal(batch)}
                          className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium"
                        >
                          <Coins className="w-3.5 h-3.5" />
                          <span>{isBn ? 'শুকানো ও খামাল খরচ' : 'Drying & Khamal Cost'}</span>
                        </button>
                        {Number(pnl?.chatal_remaining_kg || 0) > 0.01 && (
                          <button
                            type="button"
                            onClick={() => openDispatchModal(batch)}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-semibold hover:opacity-95"
                          >
                            <Split className="w-3.5 h-3.5" />
                            <span>{isBn ? 'গোডাউনে ভাগ পাঠান' : 'Split to Godowns'}</span>
                          </button>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => setPnlBatchId(batch.id)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-xs font-semibold"
                    >
                      {netPnl >= 0 ? (
                        <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <TrendingDown className="w-3.5 h-3.5 text-red-600" />
                      )}
                      <span>{isBn ? 'লাভ-লস ও হিসাব শিট' : 'Profit/Loss Sheet'}</span>
                    </button>
                  </div>
                </div>

                {/* 4 Summary Metrics Row */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800">
                    <div className="text-slate-500">{isBn ? 'মোট ধান নেওয়া হয়েছে' : 'Total Paddy Taken'}</div>
                    <div className="text-sm font-mono tabular-nums font-bold mt-1 text-slate-900 dark:text-white">
                      ৳{totalTakenCost.toLocaleString('en-IN')}
                    </div>
                    <div className="font-mono tabular-nums text-slate-600 dark:text-slate-400 mt-0.5">
                      {Number(pnl?.total_intake_bags ?? batch.total_intake_bags).toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'} ·{' '}
                      {Number(pnl?.total_intake_kg ?? batch.total_intake_kg).toLocaleString('en-IN')} {isBn ? 'কেজি' : 'kg'}
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800">
                    <div className="text-slate-500">{isBn ? 'শুকানো, খামাল ও অন্যান্য খরচ' : 'Drying & Khamal Expenses'}</div>
                    <div className="text-sm font-mono tabular-nums font-bold mt-1 text-slate-900 dark:text-white">
                      ৳{totalExp.toLocaleString('en-IN')}
                    </div>
                    <div className="font-mono tabular-nums text-slate-600 dark:text-slate-400 mt-0.5">
                      {isBn ? 'শুকানো' : 'Dry'}: ৳{dryCost.toLocaleString('en-IN')} · {isBn ? 'খামাল' : 'Khamal'}: ৳
                      {khamalCost.toLocaleString('en-IN')}
                      {unpaidDue > 0 ? ` (${isBn ? 'বকেয়া' : 'Due'}: ৳${unpaidDue.toLocaleString('en-IN')})` : ''}
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800">
                    <div className="text-slate-500">{isBn ? 'শুকিয়ে গোডাউনে ও চাটালে বাকি' : 'Dried to Godown & Yard Bal.'}</div>
                    <div className="text-sm font-mono tabular-nums font-bold mt-1 text-slate-900 dark:text-white">
                      {isBn ? 'শুকিয়ে তোলা:' : 'Lifted:'}{' '}
                      {(batch.dispatches || []).reduce((s, d) => s + Number(d.bag_count || 0), 0).toLocaleString('en-IN')}{' '}
                      {isBn ? 'বস্তা' : 'b'} (
                      {(batch.dispatches || [])
                        .reduce((s, d) => s + (d.weight_pending ? 0 : Number(d.qty_kg || 0)), 0)
                        .toLocaleString('en-IN')}{' '}
                      kg)
                    </div>
                    <div className="font-mono tabular-nums text-slate-600 dark:text-slate-400 mt-0.5">
                      {isBn ? 'চাতাল:' : 'Yard:'} {Number(pnl?.chatal_remaining_bags || 0)}ব · {isBn ? 'গোডাউন:' : 'Godown:'}{' '}
                      {Number(pnl?.godown_remaining_bags || 0)}ব ({Number(pnl?.godown_remaining_kg || 0).toLocaleString('en-IN')} kg)
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800">
                    <div className="text-slate-500">{isBn ? 'মোট বিক্রি + ক্রাশিং ও লাভ-লস' : 'Sales/Crush & Net P&L'}</div>
                    <div
                      className={`text-sm font-mono tabular-nums font-bold mt-1 ${
                        netPnl >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {netPnl >= 0 ? (isBn ? 'লাভ +' : 'Profit +') : isBn ? 'লস −' : 'Loss −'}৳
                      {Math.abs(netPnl).toLocaleString('en-IN')}
                    </div>
                    <div className="font-mono tabular-nums text-slate-600 dark:text-slate-400 mt-0.5">
                      {isBn ? 'বিক্রি:' : 'Sold:'} ৳{Number(pnl?.direct_sale_revenue || 0).toLocaleString('en-IN')} ·{' '}
                      {isBn ? 'ক্রাশিং:' : 'Crush:'} {Number(pnl?.crushing_batch_count || 0)}
                    </div>
                  </div>
                </div>

                {/* Location Stock Lots (Chatal Yard + Split Godowns) with Direct Crushing & Sale Actions */}
                {activeLinkedLots.length > 0 && (
                  <div className="overflow-x-auto border border-slate-200 dark:border-slate-800 rounded-lg">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                          <th className="text-left px-3 py-2 font-medium">{isBn ? 'অবস্থান (চাতাল / গোডাউন)' : 'Location'}</th>
                          <th className="text-left px-3 py-2 font-medium">{isBn ? 'লট কোড' : 'Lot Code'}</th>
                          <th className="text-right px-3 py-2 font-medium">{isBn ? 'অবশিষ্ট বস্তা' : 'Rem. Bags'}</th>
                          <th className="text-right px-3 py-2 font-medium">{isBn ? 'অবশিষ্ট ওজন' : 'Rem. Weight'}</th>
                          <th className="text-right px-3 py-2 font-medium">{isBn ? 'জমাকৃত মূল্য' : 'Allocated Value'}</th>
                          <th className="text-right px-3 py-2 font-medium">{isBn ? 'পরবর্তী ধাপ (ক্রাশিং / বিক্রি)' : 'Next Step'}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {activeLinkedLots.map((lot) => {
                          const isYard = lot.source_type === 'CHATAL_YARD';
                          const isPendingWt = Boolean(lot.weight_pending);
                          const val = isPendingWt
                            ? Number(lot.pending_cost_total || 0)
                            : Number(lot.remaining_qty_kg || 0) * Number(lot.unit_cost_per_kg || 0);
                          return (
                            <tr key={lot.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                              <td className="px-3 py-2.5 font-medium text-slate-900 dark:text-white">
                                {lot.warehouse_name} ·{' '}
                                <span className="text-slate-500 font-normal">
                                  {isYard ? (isBn ? 'চাতালে আছে' : 'On Chatal') : isBn ? 'গোডাউনে সংরক্ষিত' : 'Split Godown'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 font-mono text-slate-600 dark:text-slate-300">{lot.lot_code}</td>
                              <td className="px-3 py-2.5 text-right font-mono tabular-nums font-semibold">
                                {Number(lot.remaining_bags || 0).toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'b'}
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                                {isPendingWt ? (
                                  <span className="text-amber-700 dark:text-amber-400">
                                    {isBn ? 'ওজন অপেক্ষমাণ' : 'Weight Pending'}
                                  </span>
                                ) : (
                                  `${Number(lot.remaining_qty_kg || 0).toLocaleString('en-IN')} kg`
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                                ৳{val.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                              </td>
                              <td className="px-3 py-2.5 text-right">
                                <div className="inline-flex flex-wrap items-center justify-end gap-1.5">
                                  <button
                                    type="button"
                                    onClick={() => openCrushingModal(batch.id, lot)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 text-xs font-medium"
                                  >
                                    <Factory className="w-3 h-3" />
                                    <span>{isBn ? 'ক্রাশিংয়ে পাঠান' : 'Crush'}</span>
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => openDirectSaleModal(batch, lot)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium"
                                  >
                                    <ShoppingCart className="w-3 h-3" />
                                    <span>{isBn ? 'সরাসরি বিক্রি' : 'Sell'}</span>
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Historical Multi-Round Godown Splits Summary */}
                {dispatchesByRound.size > 0 && (
                  <div className="text-xs text-slate-600 dark:text-slate-400 space-y-1 pt-1">
                    {Array.from(dispatchesByRound.entries()).map(([roundNo, list]) => (
                      <div key={roundNo} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-mono font-semibold text-slate-700 dark:text-slate-300">
                          {isBn ? `গোডাউন প্রেরণ ধাপ #${roundNo}:` : `Godown Split Round #${roundNo}:`}
                        </span>
                        {(list || []).map((sp, i) => (
                          <span key={sp.id} className="font-mono tabular-nums">
                            {i > 0 && ' · '}
                            {sp.dest_warehouse_name} ({sp.bag_count} বস্তা
                            {sp.weight_pending ? ` · ${isBn ? 'ওজন ছাড়া' : 'unweighed'}` : ` · ${Number(sp.qty_kg).toLocaleString('en-IN')} kg`})
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* MODAL 1: ADD EXTRA PADDY LATER */}
      {addInputBatch && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleAddExtraInput}
            className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-display font-semibold">
                  {isBn ? `আরও ধান ঢালুন · ${addInputBatch.chatal_no}` : `Pour Extra Paddy · ${addInputBatch.chatal_no}`}
                </h3>
                <p className="text-slate-500 mt-0.5">{addInputBatch.paddy_item_name}</p>
              </div>
              <button type="button" onClick={() => setAddInputBatchId(null)} className="p-1 text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block font-medium mb-1">{isBn ? 'সোর্স গোডাউন' : 'Source Godown'}</label>
                <select
                  value={addInputForm.source_warehouse_id}
                  onChange={(e) => setAddInputForm({ ...addInputForm, source_warehouse_id: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {warehouses.map((w) => {
                    const s = stockMap.get(`${w.id}-${addInputBatch.paddy_item_id}`);
                    return (
                      <option key={w.id} value={w.id}>
                        {w.name} ({s ? `${s.bags} বস্তা / ${s.weightKg.toLocaleString('en-IN')} kg` : '0 kg'})
                      </option>
                    );
                  })}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'বস্তা সংখ্যা' : 'Bags'}</label>
                  <input
                    type="number"
                    min="0"
                    value={addInputForm.bag_count}
                    onChange={(e) => setAddInputForm({ ...addInputForm, bag_count: Math.max(0, Math.round(Number(e.target.value))) })}
                    className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'ওজন (কেজি) *' : 'Weight (kg) *'}</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={addInputForm.qty_kg}
                    onChange={(e) => setAddInputForm({ ...addInputForm, qty_kg: Number(e.target.value) })}
                    className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'নোট / মন্তব্য' : 'Notes'}</label>
                <input
                  type="text"
                  value={addInputForm.notes}
                  onChange={(e) => setAddInputForm({ ...addInputForm, notes: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setAddInputBatchId(null)}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
              >
                {isBn ? 'বাতিল' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white font-semibold disabled:opacity-50"
              >
                {isBn ? 'চাটালে যোগ করুন' : 'Add Paddy'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL 2: CHALAL DRYING & KHAMAL EXPENSES (+ SETTLE DUE) */}
      {expenseBatch && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 text-xs my-8">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-display font-semibold">
                  {isBn ? `ধান শুকানো ও খামাল খরচ · ${expenseBatch.chatal_no}` : `Drying & Khamal Expenses · ${expenseBatch.chatal_no}`}
                </h3>
                <p className="text-slate-500 mt-0.5">
                  {isBn
                    ? `শুকানো: ৳${Number(expenseBatch.drying_cost || 0).toLocaleString('en-IN')} · খামাল: ৳${Number(expenseBatch.khamal_cost || 0).toLocaleString('en-IN')} · অন্যান্য: ৳${Number(expenseBatch.other_cost || 0).toLocaleString('en-IN')}`
                    : `Drying: ৳${expenseBatch.drying_cost} · Khamal: ৳${expenseBatch.khamal_cost}`}
                </p>
              </div>
              <button type="button" onClick={() => setExpenseBatchId(null)} className="p-1 text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveChatalExpense} className="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'খরচের খাত *' : 'Expense Type *'}</label>
                  <select
                    value={expForm.expense_type}
                    onChange={(e) => setExpForm({ ...expForm, expense_type: e.target.value as ChatalExpenseKey })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  >
                    {CHATAL_EXPENSE_TYPES.map((tp) => (
                      <option key={tp.key} value={tp.key}>
                        {isBn ? tp.bn : tp.en}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'টাকার পরিমাণ (৳) *' : 'Amount (৳) *'}</label>
                  <input
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={expForm.total_amount}
                    onChange={(e) => setExpForm({ ...expForm, total_amount: Number(e.target.value) })}
                    className="w-full px-3 py-2 font-mono tabular-nums font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'সর্দার / শ্রমিক / ভেন্ডর' : 'Vendor / Sardar'}</label>
                  <input
                    type="text"
                    value={expForm.vendor_name}
                    onChange={(e) => setExpForm({ ...expForm, vendor_name: e.target.value })}
                    placeholder={isBn ? 'নাম (ঐচ্ছিক)' : 'Optional name'}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium mb-1">{isBn ? 'পরিশোধের ধরন' : 'Payment Timing'}</label>
                  <select
                    value={expForm.payment_timing}
                    onChange={(e) => setExpForm({ ...expForm, payment_timing: e.target.value as 'PAID' | 'UNPAID' | 'PARTIAL' })}
                    className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                  >
                    <option value="PAID">{isBn ? 'নগদ / ব্যাংক পরিশোধ' : 'Paid Now'}</option>
                    <option value="UNPAID">{isBn ? 'বাকিতে রাখুন' : 'Unpaid (Pay Later)'}</option>
                    <option value="PARTIAL">{isBn ? 'আংশিক পরিশোধ' : 'Partial'}</option>
                  </select>
                </div>
                {expForm.payment_timing !== 'UNPAID' && (
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'হিসাব (ক্যাশ/ব্যাংক)' : 'Account'}</label>
                    <select
                      value={expForm.account_id || defaultCashAccountId}
                      onChange={(e) => setExpForm({ ...expForm, account_id: Number(e.target.value) })}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                    >
                      {paymentAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {expForm.payment_timing === 'PARTIAL' ? (
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'এখন পরিশোধ (৳)' : 'Paid Now (৳)'}</label>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      value={expForm.paid_now}
                      onChange={(e) => setExpForm({ ...expForm, paid_now: Math.max(0, Number(e.target.value)) })}
                      className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block font-medium mb-1">{isBn ? 'বিবরণ' : 'Notes'}</label>
                    <input
                      type="text"
                      value={expForm.notes}
                      onChange={(e) => setExpForm({ ...expForm, notes: e.target.value })}
                      className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                    />
                  </div>
                )}
              </div>

              <div className="flex justify-end">
                <button
                  type="submit"
                  disabled={submitting}
                  className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50"
                >
                  {isBn ? '+ খরচ সংরক্ষণ করুন' : '+ Save Expense'}
                </button>
              </div>
            </form>

            {/* Expense History + Settle Due */}
            <div className="space-y-2">
              <div className="font-semibold text-slate-700 dark:text-slate-300">
                {isBn ? `খরচের তালিকা (${expenseBatch.expenses?.length || 0}টি)` : `Expense Entries (${expenseBatch.expenses?.length || 0})`}
              </div>
              {(!expenseBatch.expenses || expenseBatch.expenses.length === 0) ? (
                <div className="text-slate-500 py-4 text-center border border-slate-200 dark:border-slate-800 rounded-lg">
                  {isBn ? 'এখনও কোনো খরচ যোগ করা হয়নি।' : 'No expenses recorded yet.'}
                </div>
              ) : (
                <div className="max-h-60 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg">
                  {expenseBatch.expenses.map((exp) => {
                    const due = Math.max(0, Number((Number(exp.total_amount) - Number(exp.paid_amount || 0)).toFixed(2)));
                    return (
                      <div key={exp.id} className="p-3 space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div>
                            <span className="font-semibold text-slate-900 dark:text-white">{getExpenseTypeLabel(exp.expense_type)}</span>
                            {exp.vendor_name && <span className="text-slate-500"> · {exp.vendor_name}</span>}
                            {exp.notes && <div className="text-slate-500">{exp.notes}</div>}
                          </div>
                          <div className="flex items-center gap-2.5 font-mono tabular-nums">
                            <span className="font-bold">৳{Number(exp.total_amount).toLocaleString('en-IN')}</span>
                            {due > 0.01 ? (
                              <button
                                type="button"
                                onClick={() => {
                                  setPayingExp(exp);
                                  setPayDueForm({
                                    account_id: defaultCashAccountId,
                                    amount: due,
                                    payment_mode: 'CASH',
                                    reference_no: '',
                                    notes: '',
                                  });
                                }}
                                className="px-2.5 py-1 rounded bg-amber-600 text-white text-xs font-medium"
                              >
                                {isBn ? `বাকি দিন (৳${due.toLocaleString('en-IN')})` : `Pay Due (৳${due})`}
                              </button>
                            ) : (
                              <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                                {isBn ? 'পরিশোধিত' : 'Paid'}
                              </span>
                            )}
                          </div>
                        </div>

                        {payingExp?.id === exp.id && (
                          <form onSubmit={handlePayExpenseDue} className="grid grid-cols-1 sm:grid-cols-4 gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
                            <select
                              value={payDueForm.account_id || defaultCashAccountId}
                              onChange={(e) => setPayDueForm({ ...payDueForm, account_id: Number(e.target.value) })}
                              className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                            >
                              {paymentAccounts.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                            <input
                              type="number"
                              min="0.01"
                              step="0.01"
                              max={due}
                              value={payDueForm.amount}
                              onChange={(e) => setPayDueForm({ ...payDueForm, amount: Number(e.target.value) })}
                              className="px-2.5 py-1.5 font-mono tabular-nums rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                            />
                            <input
                              type="text"
                              value={payDueForm.notes}
                              onChange={(e) => setPayDueForm({ ...payDueForm, notes: e.target.value })}
                              placeholder={isBn ? 'মন্তব্য' : 'Notes'}
                              className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                            />
                            <div className="flex gap-1.5 justify-end">
                              <button
                                type="button"
                                onClick={() => setPayingExp(null)}
                                className="px-2.5 py-1.5 rounded border border-slate-300 dark:border-slate-700"
                              >
                                {isBn ? 'না' : 'Cancel'}
                              </button>
                              <button type="submit" className="px-3 py-1.5 rounded bg-emerald-600 text-white font-semibold">
                                {isBn ? 'জমা দিন' : 'Pay'}
                              </button>
                            </div>
                          </form>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* MODAL 3: MULTI-GODOWN SPLIT DISPATCH (ROUND 1, ROUND 2...) */}
      {dispatchBatch && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handleDispatchSubmit}
            className="w-full max-w-3xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 text-xs my-8"
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-display font-semibold">
                  {isBn
                    ? `চাতাল থেকে একাধিক গোডাউনে ধান পাঠান · ${dispatchBatch.chatal_no}`
                    : `Multi-Godown Split Dispatch · ${dispatchBatch.chatal_no}`}
                </h3>
                <p className="text-slate-500 mt-0.5 font-mono tabular-nums">
                  {isBn ? 'বর্তমানে চাটালে অবশিষ্ট:' : 'Available on Chatal:'}{' '}
                  <strong>
                    {Number(dispatchBatch.pnl?.chatal_remaining_bags || 0)} বস্তা ·{' '}
                    {Number(dispatchBatch.pnl?.chatal_remaining_kg || 0).toLocaleString('en-IN')} কেজি
                  </strong>
                  {' · '}
                  {isBn ? 'বাকি অংশ পরে আবার পরের ধাপে পাঠাতে পারবেন' : 'Remaining stays on Chatal for later rounds'}
                </p>
              </div>
              <button type="button" onClick={() => setDispatchBatchId(null)} className="p-1 text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  {isBn ? 'গন্তব্য গোডাউনসমূহ (১টি, ২টি বা তার বেশি গোডাউনে ভাগ করুন)' : 'Destination Godown Splits'}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setDispatchSplits((prev) => [
                      ...prev,
                      {
                        uid: crypto.randomUUID(),
                        dest_warehouse_id: godownWarehouses[0]?.id || 0,
                        bag_count: 0,
                        qty_kg: 0,
                        weight_pending: false,
                        sale_style_unit_kg: 75.5,
                        sale_style_rate: 0,
                        notes: '',
                      },
                    ])
                  }
                  className="inline-flex items-center gap-1 font-medium text-amber-700 dark:text-amber-400 hover:underline"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {isBn ? 'আরেকটি গোডাউন যোগ করুন' : 'Add Godown Row'}
                </button>
              </div>

              <div className="divide-y divide-slate-200 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg bg-slate-50/70 dark:bg-slate-950/60">
                {dispatchSplits.map((sp, idx) => {
                  const estNetUnits =
                    !sp.weight_pending && sp.qty_kg > sp.bag_count && (sp.sale_style_unit_kg || 75.5) > 0
                      ? (sp.qty_kg - sp.bag_count) / (sp.sale_style_unit_kg || 75.5)
                      : 0;
                  const estSaleVal = sp.sale_style_rate > 0 ? estNetUnits * sp.sale_style_rate : 0;
                  return (
                    <div key={sp.uid} className="p-3 space-y-2.5">
                      <div className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end">
                        <div className="sm:col-span-4">
                          <label className="block font-medium mb-1">
                            {isBn ? `গোডাউন #${idx + 1}` : `Godown #${idx + 1}`}
                          </label>
                          <select
                            value={sp.dest_warehouse_id}
                            onChange={(e) => updateDispatchSplit(sp.uid, { dest_warehouse_id: Number(e.target.value) })}
                            className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                          >
                            {warehouses
                              .filter((w) => w.id !== dispatchBatch.chatal_warehouse_id)
                              .map((w) => (
                                <option key={w.id} value={w.id}>
                                  {w.name}
                                </option>
                              ))}
                          </select>
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block font-medium mb-1">{isBn ? 'বস্তা' : 'Bags'}</label>
                          <input
                            type="number"
                            min="0"
                            value={sp.bag_count}
                            onChange={(e) => updateDispatchSplit(sp.uid, { bag_count: Math.max(0, Math.round(Number(e.target.value))) })}
                            className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                        </div>
                        <div className="sm:col-span-3">
                          <label className="block font-medium mb-1">{isBn ? 'ওজন (কেজি)' : 'Weight (kg)'}</label>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            disabled={sp.weight_pending}
                            value={sp.weight_pending ? 0 : sp.qty_kg}
                            onChange={(e) => updateDispatchSplit(sp.uid, { qty_kg: Number(e.target.value) })}
                            className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 disabled:opacity-50"
                          />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="block font-medium mb-1">{isBn ? 'বিক্রি রেফারেন্স দর (৳/৭৫.৫)' : 'Ref Rate (৳/75.5)'}</label>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={sp.sale_style_rate}
                            onChange={(e) => updateDispatchSplit(sp.uid, { sale_style_rate: Math.max(0, Number(e.target.value)) })}
                            className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
                          />
                        </div>
                        <div className="sm:col-span-1 flex justify-end">
                          {dispatchSplits.length > 1 && (
                            <button
                              type="button"
                              onClick={() => setDispatchSplits((prev) => prev.filter((x) => x.uid !== sp.uid))}
                              className="p-2 text-slate-400 hover:text-red-600"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2 text-slate-600 dark:text-slate-400">
                        <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={sp.weight_pending}
                            onChange={(e) => updateDispatchSplit(sp.uid, { weight_pending: e.target.checked })}
                            className="rounded border-slate-300 text-amber-600"
                          />
                          <span>
                            {isBn ? 'ওজন না করে শুধু বস্তা গোডাউনে রাখুন (বের করার সময় ওজন ও দাম বসাবে)' : 'Store by bags only (weigh & price on exit)'}
                          </span>
                        </label>
                        {estSaleVal > 0 && (
                          <span className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                            {isBn ? 'আনুমানিক বিক্রয়মূল্য:' : 'Est. Sale Value:'} ৳{estSaleVal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-medium mb-1">{isBn ? 'শুকানো ঘাটতি / আর্দ্রতা বাদ (কেজি)' : 'Moisture / Drying Loss (kg)'}</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={dispatchMeta.moisture_loss_kg}
                  onChange={(e) => setDispatchMeta({ ...dispatchMeta, moisture_loss_kg: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'ধাপের নোট / মন্তব্য' : 'Round Notes'}</label>
                <input
                  type="text"
                  value={dispatchMeta.notes}
                  onChange={(e) => setDispatchMeta({ ...dispatchMeta, notes: e.target.value })}
                  placeholder={isBn ? 'যেমন: প্রথম ধাপে ১ ও ২ নং গোডাউনে প্রেরণ' : 'e.g. Round 1 split dispatch'}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setDispatchBatchId(null)}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
              >
                {isBn ? 'বাতিল' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white font-semibold disabled:opacity-50"
              >
                {submitting ? (isBn ? 'সংরক্ষণ হচ্ছে...' : 'Dispatching...') : isBn ? 'গোডাউনে ভাগ পাঠান' : 'Dispatch to Godowns'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL 4: SEND TO CRUSHING / MILLING */}
      {crushingTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleSendToCrushingSubmit}
            className="w-full max-w-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-display font-semibold">
                  {isBn ? `ক্রাশিং / মিলিংয়ে পাঠান · ${crushingTarget.lot.lot_code}` : `Send to Crushing · ${crushingTarget.lot.lot_code}`}
                </h3>
                <p className="text-slate-500 mt-0.5">
                  {crushingTarget.lot.warehouse_name} · {Number(crushingTarget.lot.remaining_bags || 0)} বস্তা
                  {crushingTarget.lot.weight_pending ? ` (${isBn ? 'ওজন অপেক্ষমাণ' : 'Weight pending'})` : ` (${Number(crushingTarget.lot.remaining_qty_kg || 0).toLocaleString('en-IN')} kg)`}
                </p>
              </div>
              <button type="button" onClick={() => setCrushingTarget(null)} className="p-1 text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block font-medium mb-1">{isBn ? 'প্রসেস ধরন *' : 'Process Type *'}</label>
                <select
                  value={crushForm.process_type}
                  onChange={(e) => setCrushForm({ ...crushForm, process_type: e.target.value as ProcessType })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="PARBOILED_SIDDHO">{isBn ? 'সিদ্ধ চাল (Parboiled Siddho)' : 'Parboiled Siddho'}</option>
                  <option value="RAW_ATAP">{isBn ? 'আতপ চাল (Raw Atap)' : 'Raw Atap'}</option>
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'ডায়ার / মিল নং' : 'Dryer / Mill No.'}</label>
                <input
                  type="text"
                  value={crushForm.dryer_no}
                  onChange={(e) => setCrushForm({ ...crushForm, dryer_no: e.target.value })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'বস্তা সংখ্যা (ছেঁড়া হলে বাড়তে পারে)' : 'Bag Count'}</label>
                <input
                  type="number"
                  min="0"
                  value={crushForm.bag_count}
                  onChange={(e) => setCrushForm({ ...crushForm, bag_count: Math.max(0, Math.round(Number(e.target.value))) })}
                  className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'ক্রাশিং ওজন (কেজি) *' : 'Weight for Crushing (kg) *'}</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={crushForm.qty_kg}
                  onChange={(e) => setCrushForm({ ...crushForm, qty_kg: Number(e.target.value) })}
                  className="w-full px-3 py-2 font-mono tabular-nums font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            {Boolean(crushingTarget.lot.weight_pending) && (
              <label className="flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={crushForm.close_pending_lot}
                  onChange={(e) => setCrushForm({ ...crushForm, close_pending_lot: e.target.checked })}
                  className="rounded border-slate-300 text-amber-600"
                />
                <span>{isBn ? 'এই লটের সব ধান নেওয়া শেষে লটটি ক্লোজ করুন' : 'Close pending lot after this issue'}</span>
              </label>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setCrushingTarget(null)}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
              >
                {isBn ? 'বাতিল' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white font-semibold disabled:opacity-50"
              >
                {isBn ? 'ক্রাশিং শুরু করুন' : 'Send to Crushing'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL 5: DIRECT PADDY SALE WITH SALE-STYLE FORMULA */}
      {directSaleTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handleDirectSaleSubmit}
            className="w-full max-w-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 space-y-4 text-xs my-8"
          >
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-display font-semibold">
                  {isBn
                    ? `সরাসরি ধান বিক্রি (বিক্রির মতো দাম হিসাব) · ${directSaleTarget.lot.lot_code}`
                    : `Direct Paddy Sale · ${directSaleTarget.lot.lot_code}`}
                </h3>
                <p className="text-slate-500 mt-0.5">
                  {directSaleTarget.lot.warehouse_name} · {Number(directSaleTarget.lot.remaining_bags || 0)} বস্তা
                  {directSaleTarget.lot.weight_pending
                    ? ` (${isBn ? 'ওজন ছাড়া মজুদ ছিল' : 'Unweighed stock'})`
                    : ` (${Number(directSaleTarget.lot.remaining_qty_kg || 0).toLocaleString('en-IN')} kg)`}
                </p>
              </div>
              <button type="button" onClick={() => setDirectSaleTarget(null)} className="p-1 text-slate-400 hover:text-slate-700">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block font-medium mb-1">{isBn ? 'ক্রেতা / পার্টি *' : 'Buyer / Customer *'}</label>
                <select
                  value={saleForm.customer_id}
                  onChange={(e) => setSaleForm({ ...saleForm, customer_id: Number(e.target.value) })}
                  className="w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'চট বস্তা' : 'Jute Bags'}</label>
                <input
                  type="number"
                  min="0"
                  value={saleForm.jute_bag_count}
                  onChange={(e) => setSaleForm({ ...saleForm, jute_bag_count: Math.max(0, Math.round(Number(e.target.value))) })}
                  className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'প্লাস্টিক বস্তা (ছেঁড়া সহ)' : 'Plastic Bags'}</label>
                <input
                  type="number"
                  min="0"
                  value={saleForm.plastic_bag_count}
                  onChange={(e) => setSaleForm({ ...saleForm, plastic_bag_count: Math.max(0, Math.round(Number(e.target.value))) })}
                  className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block font-medium mb-1">{isBn ? 'স্কেল / মোট ওজন (কেজি)' : 'Scale Weight (kg)'}</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={saleForm.scale_weight_kg}
                  onChange={(e) => {
                    const wt = Number(e.target.value);
                    setSaleForm((prev) => ({
                      ...prev,
                      scale_weight_kg: wt,
                      qty_kg: prev.qty_kg === prev.scale_weight_kg || prev.qty_kg === 0 ? wt : prev.qty_kg,
                    }));
                  }}
                  className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'বিক্রির ওজন (কেজি) *' : 'Delivery Weight (kg) *'}</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={saleForm.qty_kg}
                  onChange={(e) => setSaleForm({ ...saleForm, qty_kg: Number(e.target.value) })}
                  className="w-full px-3 py-2 font-mono tabular-nums font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'জমা পাওয়া টাকা (৳)' : 'Paid Amount (৳)'}</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={saleForm.paid_amount}
                  onChange={(e) => setSaleForm({ ...saleForm, paid_amount: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 rounded-lg bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="font-medium">{isBn ? 'বাদ / ঢলতা (কেজি)' : 'Weight Loss (kg)'}</label>
                  {saleTotalBags > 0 && (
                    <button
                      type="button"
                      onClick={() => setSaleForm({ ...saleForm, weight_loss_kg: saleTotalBags })}
                      className="text-[11px] font-semibold text-amber-800 dark:text-amber-300 hover:underline"
                    >
                      = {saleTotalBags}ব
                    </button>
                  )}
                </div>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={saleForm.weight_loss_kg}
                  onChange={(e) => setSaleForm({ ...saleForm, weight_loss_kg: Math.max(0, Number(e.target.value)) })}
                  className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">{isBn ? 'ভাজক (কেজি/ইউনিট)' : 'Unit Divisor (kg)'}</label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={saleForm.settlement_unit_kg}
                  onChange={(e) => setSaleForm({ ...saleForm, settlement_unit_kg: Number(e.target.value) })}
                  className="w-full px-3 py-2 font-mono tabular-nums rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">
                  {isBn ? `দর (৳ / ${saleDivisor} কেজি) *` : `Rate (৳ / ${saleDivisor} kg) *`}
                </label>
                <input
                  type="number"
                  min="0.01"
                  step="0.01"
                  required
                  value={saleForm.settlement_rate}
                  onChange={(e) => setSaleForm({ ...saleForm, settlement_rate: Number(e.target.value) })}
                  className="w-full px-3 py-2 font-mono tabular-nums font-semibold rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                />
              </div>
              <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-amber-200/70 dark:border-amber-900/40 font-mono tabular-nums">
                <span>
                  ({Number(saleForm.qty_kg || 0).toLocaleString()} − {Number(saleForm.weight_loss_kg || 0).toLocaleString()}) / {saleDivisor} × ৳
                  {Number(saleForm.settlement_rate || 0).toLocaleString()} = <strong>{saleUnits.toFixed(4)}</strong>
                </span>
                <span className="text-sm font-bold text-slate-900 dark:text-white">
                  ৳{saleTotalVal.toLocaleString('en-IN')} (৳{saleEffectivePerKg.toFixed(2)}/kg)
                </span>
              </div>
            </div>

            {Boolean(directSaleTarget.lot.weight_pending) && (
              <label className="flex items-center gap-2 text-slate-700 dark:text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={saleForm.close_pending_lot}
                  onChange={(e) => setSaleForm({ ...saleForm, close_pending_lot: e.target.checked })}
                  className="rounded border-slate-300 text-amber-600"
                />
                <span>
                  {isBn
                    ? 'বিক্রির পর লটটি সম্পূর্ণ শেষ/ক্লোজ করুন (আরও বাকি ধান থাকলে আনচেক রাখুন)'
                    : 'Close lot after this sale'}
                </span>
              </label>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setDirectSaleTarget(null)}
                className="px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700"
              >
                {isBn ? 'বাতিল' : 'Cancel'}
              </button>
              <button
                type="submit"
                disabled={submitting}
                className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50"
              >
                {isBn ? 'সরাসরি বিক্রি সম্পন্ন করুন' : 'Complete Direct Sale'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODAL 6: ITEMIZED P&L SHEET & BATCH CLOSURE */}
      {pnlBatch && pnlBatch.pnl && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 overflow-y-auto">
          <div className="w-full max-w-4xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 sm:p-6 space-y-5 text-xs my-8">
            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 pb-3">
              <div>
                <h3 className="text-base font-display font-bold text-slate-900 dark:text-white">
                  {isBn ? `চাতাল ও খামাল সম্পূর্ণ লাভ-লস হিসাব · ${pnlBatch.chatal_no}` : `Chatal Profit & Loss Sheet · ${pnlBatch.chatal_no}`}
                </h3>
                <p className="text-slate-500 mt-0.5">
                  {pnlBatch.title} · {pnlBatch.paddy_item_name} · {pnlBatch.chatal_warehouse_name}
                </p>
              </div>
              <button type="button" onClick={() => setPnlBatchId(null)} className="p-1 text-slate-400 hover:text-slate-700">
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Side-by-side Costs vs Returns */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 space-y-2">
                <div className="font-semibold text-sm text-slate-900 dark:text-white border-b border-slate-200 dark:border-slate-800 pb-1.5">
                  {isBn ? '১. মোট ধান নেওয়া ও খরচ সমূহ' : '1. Total Paddy Taken & Expenses'}
                </div>
                <div className="flex justify-between font-mono tabular-nums">
                  <span>
                    {isBn ? 'মোট ধান:' : 'Paddy Taken:'} ({pnlBatch.pnl.total_intake_bags} বস্তা · {pnlBatch.pnl.total_intake_kg} kg)
                  </span>
                  <span className="font-semibold">৳{pnlBatch.pnl.total_paddy_cost.toLocaleString('en-IN')}</span>
                </div>
                <div className="flex justify-between font-mono tabular-nums">
                  <span>{isBn ? 'ধান শুকানো খরচ:' : 'Drying Cost:'}</span>
                  <span>৳{pnlBatch.pnl.drying_cost.toLocaleString('en-IN')}</span>
                </div>
                <div className="flex justify-between font-mono tabular-nums">
                  <span>{isBn ? 'ধান খামাল খরচ:' : 'Khamal Cost:'}</span>
                  <span>৳{pnlBatch.pnl.khamal_cost.toLocaleString('en-IN')}</span>
                </div>
                {pnlBatch.pnl.other_cost > 0 && (
                  <div className="flex justify-between font-mono tabular-nums">
                    <span>{isBn ? 'অন্যান্য চাতাল খরচ:' : 'Other Expenses:'}</span>
                    <span>৳{pnlBatch.pnl.other_cost.toLocaleString('en-IN')}</span>
                  </div>
                )}
                {pnlBatch.pnl.crushing_extra_overhead > 0 && (
                  <div className="flex justify-between font-mono tabular-nums">
                    <span>{isBn ? 'মিলিং/ক্রাশিং ওভারহেড:' : 'Extra Milling Overhead:'}</span>
                    <span>৳{pnlBatch.pnl.crushing_extra_overhead.toLocaleString('en-IN')}</span>
                  </div>
                )}
                <div className="flex justify-between font-mono tabular-nums font-bold text-sm border-t border-slate-200 dark:border-slate-800 pt-2">
                  <span>{isBn ? 'মোট ব্যয় (ধান + শুকানো + খামাল):' : 'Total Cost:'}</span>
                  <span>৳{(pnlBatch.pnl.total_cost + pnlBatch.pnl.crushing_extra_overhead).toLocaleString('en-IN')}</span>
                </div>
              </div>

              <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950/60 space-y-2">
                <div className="font-semibold text-sm text-slate-900 dark:text-white border-b border-slate-200 dark:border-slate-800 pb-1.5">
                  {isBn ? '২. আয়, ক্রাশিং ও অবশিষ্ট স্টক মূল্য' : '2. Realized Revenue & Remaining Value'}
                </div>
                <div className="flex justify-between font-mono tabular-nums">
                  <span>
                    {isBn ? 'সরাসরি ধান বিক্রি:' : 'Direct Paddy Sales:'} ({pnlBatch.pnl.direct_sold_bags} বস্তা · {pnlBatch.pnl.direct_sold_kg} kg)
                  </span>
                  <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                    ৳{pnlBatch.pnl.direct_sale_revenue.toLocaleString('en-IN')}
                  </span>
                </div>
                <div className="flex justify-between font-mono tabular-nums">
                  <span>
                    {isBn ? 'ক্রাশিং থেকে উৎপাদিত চাল বিক্রি:' : 'Crushing Milled Sales:'} ({pnlBatch.pnl.crushing_batch_count} ব্যাচ)
                  </span>
                  <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                    ৳{pnlBatch.pnl.crushing_milled_revenue.toLocaleString('en-IN')}
                  </span>
                </div>
                <div className="flex justify-between font-mono tabular-nums">
                  <span>{isBn ? 'ক্রাশিংয়ের অবিক্রিত চাল ও উপজাত মূল্য:' : 'Unsold Milled Rice/Byproduct:'}</span>
                  <span>৳{pnlBatch.pnl.crushing_unsold_value.toLocaleString('en-IN')}</span>
                </div>
                <div className="flex justify-between font-mono tabular-nums">
                  <span>
                    {isBn ? 'চাতাল/গোডাউনে অবশিষ্ট ধানের মূল্য:' : 'Remaining Unsold Paddy Value:'}
                  </span>
                  <span>৳{pnlBatch.pnl.remaining_paddy_value.toLocaleString('en-IN')}</span>
                </div>
                <div className="flex justify-between font-mono tabular-nums font-bold text-sm border-t border-slate-200 dark:border-slate-800 pt-2">
                  <span>{isBn ? 'নিট লাভ / লস:' : 'Net Profit / Loss:'}</span>
                  <span className={pnlBatch.pnl.net_profit_loss >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}>
                    {pnlBatch.pnl.net_profit_loss >= 0 ? '+' : '−'}৳{Math.abs(pnlBatch.pnl.net_profit_loss).toLocaleString('en-IN')}
                  </span>
                </div>
              </div>
            </div>

            {/* Linked Sales & Linked Crushing Lists */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2">
                <div className="font-semibold text-slate-800 dark:text-slate-200">
                  {isBn ? `সরাসরি বিক্রি (${pnlBatch.linked_sales?.length || 0}টি)` : `Direct Sales (${pnlBatch.linked_sales?.length || 0})`}
                </div>
                {(!pnlBatch.linked_sales || pnlBatch.linked_sales.length === 0) ? (
                  <div className="text-slate-500">{isBn ? 'কোনো সরাসরি বিক্রি হয়নি।' : 'No direct sales yet.'}</div>
                ) : (
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {pnlBatch.linked_sales.map((s) => (
                      <div key={s.id} className="flex justify-between font-mono tabular-nums border-b border-slate-100 dark:border-slate-800 pb-1">
                        <span>
                          {s.sale_no} · {s.customer_name} ({s.bag_count}ব / {Number(s.qty_kg).toLocaleString('en-IN')} kg)
                        </span>
                        <span className="font-semibold">৳{Number(s.total_amount).toLocaleString('en-IN')}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border border-slate-200 dark:border-slate-800 rounded-lg p-3 space-y-2">
                <div className="font-semibold text-slate-800 dark:text-slate-200">
                  {isBn ? `ক্রাশিং / মিলিং ব্যাচ (${pnlBatch.linked_crushing?.length || 0}টি)` : `Linked Crushing (${pnlBatch.linked_crushing?.length || 0})`}
                </div>
                {(!pnlBatch.linked_crushing || pnlBatch.linked_crushing.length === 0) ? (
                  <div className="text-slate-500">{isBn ? 'কোনো ধান ক্রাশিংয়ে পাঠানো হয়নি।' : 'No crushing batches yet.'}</div>
                ) : (
                  <div className="space-y-1.5 max-h-40 overflow-y-auto">
                    {pnlBatch.linked_crushing.map((cb) => (
                      <div key={cb.id} className="flex justify-between font-mono tabular-nums border-b border-slate-100 dark:border-slate-800 pb-1">
                        <span>
                          {cb.batch_no} · {cb.input_bag_count}ব ({Number(cb.input_paddy_qty_kg).toLocaleString('en-IN')} kg) · {cb.status}
                        </span>
                        <span className="font-semibold">
                          ৳{(Number(cb.realized_milled_revenue || 0) + Number(cb.unsold_milled_value || 0)).toLocaleString('en-IN')}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Close / Finalize Footer */}
            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-200 dark:border-slate-800">
              {pnlBatch.status === 'ACTIVE' ? (
                <>
                  <label className="inline-flex items-center gap-2 cursor-pointer select-none text-slate-600 dark:text-slate-300">
                    <input
                      type="checkbox"
                      checked={writeOffShrinkage}
                      onChange={(e) => setWriteOffShrinkage(e.target.checked)}
                      className="rounded border-slate-300 text-amber-600"
                    />
                    <span>
                      {isBn
                        ? 'সামান্য ধুলাবালি/শুকানো ঘাটতি অবশিষ্ট থাকলে তা রাইট-অফ করে ব্যাচ শেষ করুন'
                        : 'Write off residual dust/shrinkage & close batch'}
                    </span>
                  </label>
                  <button
                    type="button"
                    disabled={submitting}
                    onClick={() => handleCloseBatch(pnlBatch)}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white font-semibold disabled:opacity-50"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{isBn ? 'চাতাল ব্যাচ শেষ ও লাভ-লস চূড়ান্ত করুন' : 'Finalize & Close Chatal Batch'}</span>
                  </button>
                </>
              ) : (
                <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                  {isBn ? `ব্যাচটি চূড়ান্তভাবে সম্পন্ন হয়েছে (${pnlBatch.closed_at || ''})` : `Batch completed (${pnlBatch.closed_at || ''})`}
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
