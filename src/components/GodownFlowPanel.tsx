import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  ArrowRightLeft,
  Filter,
  GitBranch,
  RotateCcw,
  Warehouse as WarehouseIcon,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import type {
  ChatalBatch,
  DirectPaddySale,
  DryingBatch,
  InventoryLot,
  ItemMaster,
  PaddyPurchase,
  ProductCategory,
  ProductionBatch,
  StockTransfer,
  Warehouse,
} from '../types/erp';
import { isPaddyItem } from '../utils/itemFilters';

interface GodownFlowPanelProps {
  warehouses: Warehouse[];
  lots: InventoryLot[];
  transfers: StockTransfer[];
  items: ItemMaster[];
  categories: ProductCategory[];
  chatalBatches?: ChatalBatch[];
  purchases?: PaddyPurchase[];
  paddySales?: DirectPaddySale[];
  batches?: ProductionBatch[];
  dryingBatches?: DryingBatch[];
  hideFinancials?: boolean;
}

type FlowKind =
  | 'PURCHASE_IN'
  | 'STOCK_TRANSFER'
  | 'CHATAL_INTAKE'
  | 'CHATAL_DISPATCH'
  | 'DRYING_MOVE'
  | 'CRUSHING_ISSUE'
  | 'DIRECT_SALE';

interface UnifiedFlowEvent {
  uid: string;
  dateStr: string;
  timestamp: number;
  kind: FlowKind;
  refNo: string;
  itemId: number;
  itemName: string;
  fromWhId: number | null;
  fromLabel: string;
  toWhId: number | null;
  toLabel: string;
  bags: number;
  qtyKg: number;
  weightPending: boolean;
  value: number;
  notes: string;
}

interface CorridorAgg {
  key: string;
  fromWhId: number | null;
  fromLabel: string;
  toWhId: number | null;
  toLabel: string;
  totalKg: number;
  totalBags: number;
  count: number;
  totalValue: number;
}

export const GodownFlowPanel: React.FC<GodownFlowPanelProps> = ({
  warehouses,
  lots,
  transfers,
  items,
  categories,
  chatalBatches = [],
  purchases = [],
  paddySales = [],
  batches = [],
  dryingBatches = [],
  hideFinancials = false,
}) => {
  const { lang } = useI18n();
  const isBn = lang === 'bn';

  const [itemFilter, setItemFilter] = useState<string>('ALL');
  const [dateRange, setDateRange] = useState<'7D' | '30D' | '90D' | 'ALL'>('ALL');
  const [selectedWhId, setSelectedWhId] = useState<number | null>(null);
  const [selectedCorridorKey, setSelectedCorridorKey] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<string>('ALL');

  const paddyItems = useMemo(() => items.filter((i) => isPaddyItem(i, categories)), [items, categories]);
  const itemMap = useMemo(() => {
    const m = new Map<number, ItemMaster>();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);
  const whMap = useMemo(() => {
    const m = new Map<number, Warehouse>();
    for (const w of warehouses) m.set(w.id, w);
    return m;
  }, [warehouses]);

  // Build unified movement events across purchases, transfers, chatal, drying, crushing, sales
  const allFlowEvents = useMemo<UnifiedFlowEvent[]>(() => {
    const events: UnifiedFlowEvent[] = [];
    const parseTs = (d?: string) => {
      if (!d) return 0;
      const normalized = d.includes('T') ? d : d.replace(' ', 'T');
      const ms = Date.parse(normalized);
      return Number.isFinite(ms) ? ms : 0;
    };

    // 1. Paddy Purchases In
    for (const p of purchases) {
      const splits = p.splits && p.splits.length > 0 ? p.splits : null;
      if (splits) {
        splits.forEach((sp, idx) => {
          events.push({
            uid: `pur-${p.id}-${idx}`,
            dateStr: p.created_at,
            timestamp: parseTs(p.created_at),
            kind: 'PURCHASE_IN',
            refNo: p.purchase_no,
            itemId: p.item_id,
            itemName: p.item_name || itemMap.get(p.item_id)?.name || '',
            fromWhId: null,
            fromLabel: p.supplier_name || (isBn ? 'কৃষক / বেপারী ক্রয়' : 'Supplier Purchase'),
            toWhId: sp.warehouse_id,
            toLabel: sp.warehouse_name || whMap.get(sp.warehouse_id)?.name || `GD-${sp.warehouse_id}`,
            bags: Number(sp.bag_count || 0),
            qtyKg: Number(sp.received_weight_kg || 0),
            weightPending: false,
            value: Number(sp.allocated_amount || 0),
            notes: p.vehicle_no ? `${isBn ? 'গাড়ি:' : 'Veh:'} ${p.vehicle_no}` : '',
          });
        });
      } else {
        events.push({
          uid: `pur-${p.id}`,
          dateStr: p.created_at,
          timestamp: parseTs(p.created_at),
          kind: 'PURCHASE_IN',
          refNo: p.purchase_no,
          itemId: p.item_id,
          itemName: p.item_name || itemMap.get(p.item_id)?.name || '',
          fromWhId: null,
          fromLabel: p.supplier_name || (isBn ? 'কৃষক / বেপারী ক্রয়' : 'Supplier Purchase'),
          toWhId: p.warehouse_id,
          toLabel: p.warehouse_name || whMap.get(p.warehouse_id)?.name || `GD-${p.warehouse_id}`,
          bags: Number(p.bag_count || 0),
          qtyKg: Number(p.received_weight_kg || 0),
          weightPending: false,
          value: Number(p.total_payable || 0),
          notes: p.vehicle_no || '',
        });
      }
    }

    // 2. Inter-Godown Stock Transfers
    for (const tr of transfers) {
      events.push({
        uid: `trf-${tr.id}`,
        dateStr: tr.created_at,
        timestamp: parseTs(tr.created_at),
        kind: 'STOCK_TRANSFER',
        refNo: tr.transfer_no,
        itemId: tr.item_id,
        itemName: tr.item_name || itemMap.get(tr.item_id)?.name || '',
        fromWhId: tr.from_warehouse_id,
        fromLabel: tr.from_warehouse_name || whMap.get(tr.from_warehouse_id)?.name || `GD-${tr.from_warehouse_id}`,
        toWhId: tr.to_warehouse_id,
        toLabel: tr.to_warehouse_name || whMap.get(tr.to_warehouse_id)?.name || `GD-${tr.to_warehouse_id}`,
        bags: Number(tr.bag_count || 0),
        qtyKg: Number(tr.qty_kg || 0),
        weightPending: false,
        value: Number(tr.total_cost || 0),
        notes: tr.vehicle_or_driver || tr.notes || '',
      });
    }

    // 3. Chatal Intakes & Multi-Godown Split Dispatches
    for (const cb of chatalBatches) {
      for (const inp of cb.inputs || []) {
        events.push({
          uid: `cht-in-${inp.id}`,
          dateStr: inp.created_at || cb.created_at,
          timestamp: parseTs(inp.created_at || cb.created_at),
          kind: 'CHATAL_INTAKE',
          refNo: cb.chatal_no,
          itemId: inp.paddy_item_id,
          itemName: inp.item_name || cb.paddy_item_name || '',
          fromWhId: inp.source_warehouse_id,
          fromLabel: inp.source_warehouse_name || whMap.get(inp.source_warehouse_id)?.name || '',
          toWhId: cb.chatal_warehouse_id,
          toLabel: cb.chatal_warehouse_name || whMap.get(cb.chatal_warehouse_id)?.name || '',
          bags: Number(inp.bag_count || 0),
          qtyKg: Number(inp.qty_kg || 0),
          weightPending: false,
          value: Number(inp.paddy_cost || 0),
          notes: inp.notes || cb.title || '',
        });
      }
      for (const dsp of cb.dispatches || []) {
        events.push({
          uid: `cht-dsp-${dsp.id}`,
          dateStr: dsp.created_at,
          timestamp: parseTs(dsp.created_at),
          kind: 'CHATAL_DISPATCH',
          refNo: `${cb.chatal_no} #${dsp.round_no}`,
          itemId: dsp.paddy_item_id,
          itemName: dsp.item_name || cb.paddy_item_name || '',
          fromWhId: dsp.from_warehouse_id,
          fromLabel: dsp.from_warehouse_name || whMap.get(dsp.from_warehouse_id)?.name || '',
          toWhId: dsp.dest_warehouse_id,
          toLabel: dsp.dest_warehouse_name || whMap.get(dsp.dest_warehouse_id)?.name || '',
          bags: Number(dsp.bag_count || 0),
          qtyKg: Number(dsp.qty_kg || 0),
          weightPending: Boolean(dsp.weight_pending),
          value: Number(dsp.allocated_cost || 0),
          notes: dsp.notes || '',
        });
      }
    }

    // 4. Drying Batches Movement
    for (const d of dryingBatches) {
      events.push({
        uid: `dry-${d.id}`,
        dateStr: d.created_at,
        timestamp: parseTs(d.created_at),
        kind: 'DRYING_MOVE',
        refNo: d.drying_no,
        itemId: d.item_id,
        itemName: d.item_name || itemMap.get(d.item_id)?.name || '',
        fromWhId: d.source_warehouse_id,
        fromLabel: d.source_warehouse_name || whMap.get(d.source_warehouse_id)?.name || '',
        toWhId: d.dest_warehouse_id,
        toLabel: d.dest_warehouse_name || whMap.get(d.dest_warehouse_id)?.name || '',
        bags: Number(d.output_bags || d.input_bags || 0),
        qtyKg: Number(d.output_qty_kg || d.input_qty_kg || 0),
        weightPending: Boolean(d.weight_pending),
        value: Number(d.input_paddy_cost || 0),
        notes: d.notes || '',
      });
    }

    // 5. Production Crushing Issues
    for (const b of batches) {
      events.push({
        uid: `prd-${b.id}`,
        dateStr: b.started_at,
        timestamp: parseTs(b.started_at),
        kind: 'CRUSHING_ISSUE',
        refNo: b.batch_no,
        itemId: b.paddy_item_id,
        itemName: b.paddy_item_name || itemMap.get(b.paddy_item_id)?.name || '',
        fromWhId: b.source_warehouse_id,
        fromLabel: b.source_warehouse_name || whMap.get(b.source_warehouse_id)?.name || '',
        toWhId: null,
        toLabel: isBn ? 'মিলিং / ক্রাশিং ফ্লোর' : 'Crushing / Milling',
        bags: Number(b.input_bag_count || 0),
        qtyKg: Number(b.input_paddy_qty_kg || 0),
        weightPending: false,
        value: Number(b.cost_sheet?.raw_paddy_cost || b.paddy_formula_cost || 0),
        notes: b.dryer_no || '',
      });
    }

    // 6. Direct Paddy Sales Out
    for (const s of paddySales) {
      events.push({
        uid: `pds-${s.id}`,
        dateStr: s.created_at,
        timestamp: parseTs(s.created_at),
        kind: 'DIRECT_SALE',
        refNo: s.sale_no,
        itemId: s.item_id,
        itemName: s.item_name || itemMap.get(s.item_id)?.name || '',
        fromWhId: s.warehouse_id,
        fromLabel: s.warehouse_name || whMap.get(s.warehouse_id)?.name || '',
        toWhId: null,
        toLabel: s.customer_name || (isBn ? 'সরাসরি ধান বিক্রি' : 'Direct Sale'),
        bags: Number(s.bag_count || 0),
        qtyKg: Number(s.qty_kg || 0),
        weightPending: false,
        value: Number(s.total_amount || 0),
        notes: s.vehicle_no || s.notes || '',
      });
    }

    return events.sort((a, b) => b.timestamp - a.timestamp);
  }, [purchases, transfers, chatalBatches, dryingBatches, batches, paddySales, itemMap, whMap, isBn]);

  // Apply variety & date range filters
  const scopedEvents = useMemo(() => {
    const now = Date.now();
    const cutoffMs =
      dateRange === '7D'
        ? now - 7 * 86400_000
        : dateRange === '30D'
        ? now - 30 * 86400_000
        : dateRange === '90D'
        ? now - 90 * 86400_000
        : 0;

    return allFlowEvents.filter((ev) => {
      if (itemFilter !== 'ALL' && String(ev.itemId) !== itemFilter) return false;
      if (cutoffMs > 0 && ev.timestamp > 0 && ev.timestamp < cutoffMs) return false;
      if (kindFilter !== 'ALL' && ev.kind !== kindFilter) return false;
      return true;
    });
  }, [allFlowEvents, itemFilter, dateRange, kindFilter]);

  // Current live balances per warehouse (respecting itemFilter for paddy / selected variety)
  const warehouseBalances = useMemo(() => {
    const map = new Map<
      number,
      {
        warehouse: Warehouse;
        currentKg: number;
        currentBags: number;
        currentVal: number;
        pendingLotsCount: number;
        inflowKg: number;
        inflowBags: number;
        outflowKg: number;
        outflowBags: number;
      }
    >();

    for (const w of warehouses) {
      map.set(w.id, {
        warehouse: w,
        currentKg: 0,
        currentBags: 0,
        currentVal: 0,
        pendingLotsCount: 0,
        inflowKg: 0,
        inflowBags: 0,
        outflowKg: 0,
        outflowBags: 0,
      });
    }

    for (const l of lots) {
      if (itemFilter !== 'ALL' && String(l.item_id) !== itemFilter) continue;
      if (itemFilter === 'ALL') {
        const it = itemMap.get(l.item_id);
        if (it && !isPaddyItem(it, categories) && l.category !== 'PADDY' && l.process_grade !== 'RAW_PADDY') continue;
      }
      const kg = Number(l.remaining_qty_kg || 0);
      const isPend = Boolean(l.weight_pending);
      if (kg <= 0.0001 && !isPend) continue;
      const entry = map.get(l.warehouse_id);
      if (!entry) continue;

      const bags =
        l.remaining_bags !== undefined && l.remaining_bags !== null
          ? Number(l.remaining_bags || 0)
          : Math.round(kg / (Number(l.bag_weight_kg || 60) || 60));
      const val = isPend ? Number(l.pending_cost_total || 0) : kg * Number(l.unit_cost_per_kg || 0);
      entry.currentKg += kg;
      entry.currentBags += bags;
      entry.currentVal += val;
      if (isPend) entry.pendingLotsCount += 1;
    }

    for (const ev of scopedEvents) {
      if (ev.toWhId && map.has(ev.toWhId)) {
        const b = map.get(ev.toWhId)!;
        b.inflowKg += ev.qtyKg;
        b.inflowBags += ev.bags;
      }
      if (ev.fromWhId && map.has(ev.fromWhId)) {
        const b = map.get(ev.fromWhId)!;
        b.outflowKg += ev.qtyKg;
        b.outflowBags += ev.bags;
      }
    }

    return Array.from(map.values()).filter(
      (b) =>
        Boolean(b.warehouse.is_active) ||
        b.currentKg > 0 ||
        b.currentBags > 0 ||
        b.inflowKg > 0 ||
        b.outflowKg > 0
    );
  }, [warehouses, lots, itemFilter, itemMap, categories, scopedEvents]);

  // Corridor aggregations between locations (From -> To)
  const corridors = useMemo<CorridorAgg[]>(() => {
    const map = new Map<string, CorridorAgg>();
    for (const ev of scopedEvents) {
      const fromKey = ev.fromWhId ? `W${ev.fromWhId}` : 'EXT_IN';
      const toKey = ev.toWhId ? `W${ev.toWhId}` : ev.kind === 'CRUSHING_ISSUE' ? 'EXT_CRUSH' : 'EXT_SALE';
      const fromName = ev.fromWhId
        ? whMap.get(ev.fromWhId)?.name || ev.fromLabel
        : isBn
        ? 'বাহির থেকে ক্রয়'
        : 'Purchases In';
      const toName = ev.toWhId
        ? whMap.get(ev.toWhId)?.name || ev.toLabel
        : ev.kind === 'CRUSHING_ISSUE'
        ? isBn
          ? 'ক্রাশিং / মিলিং'
          : 'Crushing / Milling'
        : isBn
        ? 'সরাসরি ধান বিক্রি'
        : 'Direct Sales';

      const key = `${fromKey}->${toKey}`;
      const existing = map.get(key) || {
        key,
        fromWhId: ev.fromWhId,
        fromLabel: fromName,
        toWhId: ev.toWhId,
        toLabel: toName,
        totalKg: 0,
        totalBags: 0,
        count: 0,
        totalValue: 0,
      };
      existing.totalKg += ev.qtyKg;
      existing.totalBags += ev.bags;
      existing.count += 1;
      existing.totalValue += ev.value;
      map.set(key, existing);
    }
    return Array.from(map.values()).sort((a, b) => b.totalKg + b.totalBags * 50 - (a.totalKg + a.totalBags * 50));
  }, [scopedEvents, whMap, isBn]);

  const maxCorridorKg = useMemo(
    () => Math.max(1, ...corridors.map((c) => c.totalKg || c.totalBags * 50)),
    [corridors]
  );

  // Inter-warehouse corridors specifically for visual SVG network
  const warehouseNodes = useMemo(() => {
    const sorted = [...warehouseBalances].sort((a, b) => {
      const rank = (t: string) => (t === 'RAW_PADDY' ? 0 : t === 'DRYING_YARD' ? 1 : t === 'GENERAL' ? 2 : 3);
      return rank(a.warehouse.warehouse_type) - rank(b.warehouse.warehouse_type) || a.warehouse.id - b.warehouse.id;
    });
    const count = Math.max(1, sorted.length);
    return sorted.map((wb, idx) => {
      const col = idx % 3;
      const row = Math.floor(idx / 3);
      const x = 230 + col * 240;
      const y = 70 + row * 120;
      return { ...wb, x, y, totalRows: Math.ceil(count / 3) };
    });
  }, [warehouseBalances]);

  const svgHeight = useMemo(() => {
    const maxRow = warehouseNodes.reduce((mx, n) => Math.max(mx, Math.floor(warehouseNodes.indexOf(n) / 3) + 1), 1);
    return Math.max(240, maxRow * 125 + 30);
  }, [warehouseNodes]);

  const nodePosMap = useMemo(() => {
    const m = new Map<number, { x: number; y: number; name: string }>();
    for (const n of warehouseNodes) {
      m.set(n.warehouse.id, { x: n.x, y: n.y, name: n.warehouse.name });
    }
    return m;
  }, [warehouseNodes]);

  // Filtered table events by selected warehouse card or corridor
  const displayedEvents = useMemo(() => {
    return scopedEvents.filter((ev) => {
      if (selectedWhId !== null && ev.fromWhId !== selectedWhId && ev.toWhId !== selectedWhId) {
        return false;
      }
      if (selectedCorridorKey !== null) {
        const fromKey = ev.fromWhId ? `W${ev.fromWhId}` : 'EXT_IN';
        const toKey = ev.toWhId ? `W${ev.toWhId}` : ev.kind === 'CRUSHING_ISSUE' ? 'EXT_CRUSH' : 'EXT_SALE';
        if (`${fromKey}->${toKey}` !== selectedCorridorKey) return false;
      }
      return true;
    });
  }, [scopedEvents, selectedWhId, selectedCorridorKey]);

  const getKindLabel = (k: FlowKind) => {
    switch (k) {
      case 'PURCHASE_IN':
        return isBn ? 'ধান ক্রয়' : 'Purchase In';
      case 'STOCK_TRANSFER':
        return isBn ? 'গোডাউন স্থানান্তর' : 'Godown Transfer';
      case 'CHATAL_INTAKE':
        return isBn ? 'চাতালে ঢালা' : 'Chatal Pour';
      case 'CHATAL_DISPATCH':
        return isBn ? 'চাতাল থেকে ভাগ' : 'Chatal Split';
      case 'DRYING_MOVE':
        return isBn ? 'শুকানো স্থানান্তর' : 'Drying Move';
      case 'CRUSHING_ISSUE':
        return isBn ? 'ক্রাশিংয়ে প্রেরণ' : 'To Crushing';
      case 'DIRECT_SALE':
        return isBn ? 'সরাসরি বিক্রি' : 'Direct Sale';
    }
  };

  return (
    <div className="space-y-5">
      {/* Filter Controls */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1.5 font-semibold text-slate-800 dark:text-slate-200">
            <GitBranch className="w-4 h-4 text-amber-600" />
            <span>{isBn ? 'গোডাউন প্রবাহ ও ব্যালেন্স ফিল্টার:' : 'Paddy Flow & Balance Filters:'}</span>
          </div>

          <select
            value={itemFilter}
            onChange={(e) => setItemFilter(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="ALL">{isBn ? 'সকল ধানের জাত' : 'All Paddy Varieties'}</option>
            {paddyItems.map((it) => (
              <option key={it.id} value={String(it.id)}>
                {it.name}
              </option>
            ))}
          </select>

          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value)}
            className="px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
          >
            <option value="ALL">{isBn ? 'সকল প্রবাহ ধরন' : 'All Movement Types'}</option>
            <option value="PURCHASE_IN">{isBn ? 'ধান ক্রয়' : 'Purchases'}</option>
            <option value="STOCK_TRANSFER">{isBn ? 'গোডাউন স্থানান্তর' : 'Transfers'}</option>
            <option value="CHATAL_INTAKE">{isBn ? 'চাতালে ঢালা' : 'Chatal Pour'}</option>
            <option value="CHATAL_DISPATCH">{isBn ? 'চাতাল থেকে গোডাউনে ভাগ' : 'Chatal Splits'}</option>
            <option value="DRYING_MOVE">{isBn ? 'শুকানো স্থানান্তর' : 'Drying'}</option>
            <option value="CRUSHING_ISSUE">{isBn ? 'ক্রাশিংয়ে প্রেরণ' : 'Crushing'}</option>
            <option value="DIRECT_SALE">{isBn ? 'সরাসরি বিক্রি' : 'Direct Sales'}</option>
          </select>

          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-0.5">
            {(['7D', '30D', '90D', 'ALL'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setDateRange(r)}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors ${
                  dateRange === r ? 'bg-slate-900 text-white dark:bg-amber-600' : 'text-slate-600 dark:text-slate-300'
                }`}
              >
                {r === '7D' ? (isBn ? '৭ দিন' : '7D') : r === '30D' ? (isBn ? '৩০ দিন' : '30D') : r === '90D' ? (isBn ? '৯০ দিন' : '90D') : isBn ? 'সব সময়' : 'All'}
              </button>
            ))}
          </div>
        </div>

        {(selectedWhId !== null || selectedCorridorKey !== null || itemFilter !== 'ALL' || kindFilter !== 'ALL') && (
          <button
            type="button"
            onClick={() => {
              setSelectedWhId(null);
              setSelectedCorridorKey(null);
              setItemFilter('ALL');
              setKindFilter('ALL');
            }}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 font-medium"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{isBn ? 'ফিল্টার রিসেট' : 'Reset Filters'}</span>
          </button>
        )}
      </div>

      {/* 1. PER-GODOWN CURRENT BALANCE & HISTORICAL INFLOW/OUTFLOW CARDS */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between text-xs">
          <h3 className="font-display font-semibold text-slate-900 dark:text-white">
            {isBn
              ? 'প্রতিটি গোডাউন ও চাতালের বর্তমান ব্যালেন্স ও মোট প্রবাহ (ক্লিক করে ফিল্টার করুন)'
              : 'Current Balance & Flow per Location (Click to Filter)'}
          </h3>
          <span className="text-slate-500 font-mono tabular-nums">
            {warehouseBalances.length} {isBn ? 'টি অবস্থান' : 'locations'}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {warehouseBalances.map((wb) => {
            const isSelected = selectedWhId === wb.warehouse.id;
            const cap = Number(wb.warehouse.capacity_kg || 0);
            const pct = cap > 0 ? Math.min(100, Math.round((wb.currentKg / cap) * 100)) : 0;
            return (
              <button
                key={wb.warehouse.id}
                type="button"
                onClick={() => {
                  setSelectedCorridorKey(null);
                  setSelectedWhId((prev) => (prev === wb.warehouse.id ? null : wb.warehouse.id));
                }}
                className={`text-left p-4 rounded-xl border transition-colors ${
                  isSelected
                    ? 'bg-amber-50/70 dark:bg-amber-950/30 border-amber-500 ring-1 ring-amber-500'
                    : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:border-slate-300 dark:hover:border-slate-700'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                      <WarehouseIcon className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                      <span>{wb.warehouse.name}</span>
                    </div>
                    <div className="text-xs text-slate-500 mt-0.5 font-mono">
                      {wb.warehouse.code} · {wb.warehouse.warehouse_type}
                    </div>
                  </div>
                  <div className="text-right font-mono tabular-nums">
                    <div className="text-sm font-bold text-slate-900 dark:text-white">
                      {wb.currentKg.toLocaleString('en-IN')} kg
                    </div>
                    <div className="text-xs text-slate-500">
                      {wb.currentBags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'}
                    </div>
                  </div>
                </div>

                {cap > 0 && (
                  <div className="mt-2.5 space-y-1">
                    <div className="w-full h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-amber-600"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="flex justify-between text-[11px] font-mono tabular-nums text-slate-500">
                      <span>{pct}% {isBn ? 'পূর্ণ' : 'utilized'}</span>
                      {!hideFinancials && <span>৳{wb.currentVal.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>}
                    </div>
                  </div>
                )}

                <div className="mt-2.5 pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs font-mono tabular-nums">
                  <span className="text-emerald-700 dark:text-emerald-400">
                    +{wb.inflowKg.toLocaleString('en-IN')} kg ({wb.inflowBags}ব)
                  </span>
                  <span className="text-amber-700 dark:text-amber-400">
                    −{wb.outflowKg.toLocaleString('en-IN')} kg ({wb.outflowBags}ব)
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. INTERACTIVE GODOWN FLOW NETWORK SVG + CORRIDOR VOLUME BREAKDOWN */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* SVG Route Network */}
        <div className="xl:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                {isBn ? 'গোডাউন ও চাতাল ধান প্রবাহ মানচিত্র' : 'Godown & Chatal Paddy Flow Map'}
              </h3>
              <p className="text-xs text-slate-500">
                {isBn
                  ? 'লাইনগুলোর পুরুত্ব ধান প্রবাহের পরিমাণ অনুযায়ী দেখানো হয়েছে; যেকোনো রুট বা গোডাউনে ক্লিক করুন।'
                  : 'Line thickness reflects total moved volume; click any node or route to filter history.'}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto border border-slate-100 dark:border-slate-800 rounded-lg bg-slate-50/60 dark:bg-slate-950/60">
            <svg viewBox={`0 0 920 ${svgHeight}`} className="w-full min-w-[680px]" style={{ height: svgHeight }}>
              <defs>
                <marker id="flowArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                  <path d="M0,1 L7,4 L0,7 Z" fill="#d97706" />
                </marker>
                <marker id="flowArrowActive" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
                  <path d="M0,1 L8,4.5 L0,8 Z" fill="#059669" />
                </marker>
              </defs>

              {/* External Stage Anchor Nodes */}
              <g>
                <rect x="20" y={svgHeight / 2 - 28} width="128" height="56" rx="10" className="fill-white dark:fill-slate-900 stroke-slate-300 dark:stroke-slate-700" strokeWidth="1.5" />
                <text x="84" y={svgHeight / 2 - 4} textAnchor="middle" className="fill-slate-800 dark:fill-slate-200 text-[12px] font-semibold">
                  {isBn ? 'ক্রয় / সরবরাহকারী' : 'Purchases In'}
                </text>
                <text x="84" y={svgHeight / 2 + 14} textAnchor="middle" className="fill-slate-500 text-[10px] font-mono">
                  {scopedEvents.filter((e) => e.kind === 'PURCHASE_IN').reduce((s, e) => s + e.qtyKg, 0).toLocaleString('en-IN')} kg
                </text>
              </g>

              <g>
                <rect x="768" y="34" width="136" height="56" rx="10" className="fill-white dark:fill-slate-900 stroke-slate-300 dark:stroke-slate-700" strokeWidth="1.5" />
                <text x="836" y="58" textAnchor="middle" className="fill-slate-800 dark:fill-slate-200 text-[12px] font-semibold">
                  {isBn ? 'ক্রাশিং / মিলিং' : 'Crushing'}
                </text>
                <text x="836" y="76" textAnchor="middle" className="fill-slate-500 text-[10px] font-mono">
                  {scopedEvents.filter((e) => e.kind === 'CRUSHING_ISSUE').reduce((s, e) => s + e.qtyKg, 0).toLocaleString('en-IN')} kg
                </text>
              </g>

              <g>
                <rect x="768" y={svgHeight - 92} width="136" height="56" rx="10" className="fill-white dark:fill-slate-900 stroke-slate-300 dark:stroke-slate-700" strokeWidth="1.5" />
                <text x="836" y={svgHeight - 68} textAnchor="middle" className="fill-slate-800 dark:fill-slate-200 text-[12px] font-semibold">
                  {isBn ? 'সরাসরি বিক্রি' : 'Direct Sales'}
                </text>
                <text x="836" y={svgHeight - 50} textAnchor="middle" className="fill-slate-500 text-[10px] font-mono">
                  {scopedEvents.filter((e) => e.kind === 'DIRECT_SALE').reduce((s, e) => s + e.qtyKg, 0).toLocaleString('en-IN')} kg
                </text>
              </g>

              {/* Corridor Curved Edges */}
              {corridors.map((c, i) => {
                const start = c.fromWhId && nodePosMap.has(c.fromWhId)
                  ? nodePosMap.get(c.fromWhId)!
                  : { x: 148, y: svgHeight / 2 };
                const end = c.toWhId && nodePosMap.has(c.toWhId)
                  ? nodePosMap.get(c.toWhId)!
                  : c.key.endsWith('EXT_CRUSH')
                  ? { x: 768, y: 62 }
                  : { x: 768, y: svgHeight - 64 };

                const curveOffset = ((i % 3) - 1) * 26;
                const cx1 = (start.x + end.x) / 2;
                const cy1 = Math.min(start.y, end.y) - 24 + curveOffset;
                const weightRatio = Math.max(0.2, (c.totalKg || c.totalBags * 50) / maxCorridorKg);
                const strokeW = Number((1.5 + weightRatio * 4.5).toFixed(2));
                const isActive =
                  selectedCorridorKey === c.key ||
                  (selectedWhId !== null && (c.fromWhId === selectedWhId || c.toWhId === selectedWhId));
                const dimmed =
                  (selectedCorridorKey !== null && selectedCorridorKey !== c.key) ||
                  (selectedWhId !== null && c.fromWhId !== selectedWhId && c.toWhId !== selectedWhId);

                return (
                  <g
                    key={c.key}
                    onClick={() => {
                      setSelectedWhId(null);
                      setSelectedCorridorKey((prev) => (prev === c.key ? null : c.key));
                    }}
                    className="cursor-pointer"
                  >
                    <path
                      d={`M ${start.x} ${start.y} Q ${cx1} ${cy1} ${end.x} ${end.y}`}
                      fill="none"
                      stroke={isActive ? '#059669' : '#d97706'}
                      strokeWidth={isActive ? strokeW + 1 : strokeW}
                      strokeOpacity={dimmed ? 0.18 : 0.72}
                      markerEnd={isActive ? 'url(#flowArrowActive)' : 'url(#flowArrow)'}
                    />
                  </g>
                );
              })}

              {/* Warehouse Nodes */}
              {warehouseNodes.map((n) => {
                const isSel = selectedWhId === n.warehouse.id;
                return (
                  <g
                    key={n.warehouse.id}
                    onClick={() => {
                      setSelectedCorridorKey(null);
                      setSelectedWhId((prev) => (prev === n.warehouse.id ? null : n.warehouse.id));
                    }}
                    className="cursor-pointer"
                  >
                    <rect
                      x={n.x - 84}
                      y={n.y - 30}
                      width="168"
                      height="60"
                      rx="10"
                      className={
                        isSel
                          ? 'fill-amber-50 dark:fill-amber-950/60 stroke-amber-600'
                          : 'fill-white dark:fill-slate-900 stroke-slate-300 dark:stroke-slate-700'
                      }
                      strokeWidth={isSel ? '2.2' : '1.5'}
                    />
                    <text
                      x={n.x}
                      y={n.y - 6}
                      textAnchor="middle"
                      className="fill-slate-900 dark:fill-white text-[12px] font-semibold"
                    >
                      {n.warehouse.name.length > 22 ? `${n.warehouse.name.slice(0, 20)}..` : n.warehouse.name}
                    </text>
                    <text
                      x={n.x}
                      y={n.y + 13}
                      textAnchor="middle"
                      className="fill-slate-600 dark:fill-slate-300 text-[11px] font-mono"
                    >
                      {n.currentKg.toLocaleString('en-IN')} kg · {n.currentBags}ব
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Aggregated Route Corridors List */}
        <div className="xl:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
              {isBn ? 'রুট অনুযায়ী মোট প্রবাহ (From → To)' : 'Route Volume Summary (From → To)'}
            </h3>
            <span className="text-xs font-mono text-slate-500">{corridors.length} {isBn ? 'টি রুট' : 'routes'}</span>
          </div>

          {corridors.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500">
              {isBn ? 'নির্বাচিত ফিল্টারে কোনো প্রবাহ পাওয়া যায়নি।' : 'No flow routes match the current filter.'}
            </div>
          ) : (
            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
              {corridors.map((c) => {
                const pct = Math.max(6, Math.round(((c.totalKg || c.totalBags * 50) / maxCorridorKg) * 100));
                const isSel = selectedCorridorKey === c.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => {
                      setSelectedWhId(null);
                      setSelectedCorridorKey((prev) => (prev === c.key ? null : c.key));
                    }}
                    className={`w-full text-left p-2.5 rounded-lg border transition-colors text-xs ${
                      isSel
                        ? 'bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-500'
                        : 'bg-slate-50/70 dark:bg-slate-950/60 border-slate-200 dark:border-slate-800 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2 font-medium text-slate-900 dark:text-white">
                      <span className="flex items-center gap-1.5 truncate">
                        <span className="truncate">{c.fromLabel}</span>
                        <ArrowRight className="w-3 h-3 text-amber-600 shrink-0" />
                        <span className="truncate">{c.toLabel}</span>
                      </span>
                      <span className="font-mono tabular-nums font-bold shrink-0">
                        {c.totalKg.toLocaleString('en-IN')} kg
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
                        <div className="h-full rounded-full bg-amber-600" style={{ width: `${pct}%` }} />
                      </div>
                      <span className="font-mono tabular-nums text-[11px] text-slate-500 shrink-0">
                        {c.totalBags}ব · {c.count} {isBn ? 'বার' : 'tx'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* 3. UNIFIED HISTORICAL TRANSFERS & MOVEMENT LOG */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-display font-semibold text-slate-900 dark:text-white">
            <ArrowRightLeft className="w-4 h-4 text-slate-500" />
            <span>
              {isBn ? 'ঐতিহাসিক স্থানান্তর ও ধান প্রবাহের পূর্ণ বিবরণী' : 'Historical Transfers & Paddy Flow History'}
            </span>
          </div>
          <div className="text-xs font-mono tabular-nums text-slate-500">
            {displayedEvents.length} {isBn ? 'টি রেকর্ড' : 'records'}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'তারিখ' : 'Date'}</th>
                <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'ধরন / রেফ' : 'Type / Ref'}</th>
                <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'ধানের জাত' : 'Variety'}</th>
                <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'কোন অবস্থান থেকে → কোন অবস্থানে' : 'From → To'}</th>
                <th className="text-right px-4 py-2.5 font-medium">{isBn ? 'বস্তা' : 'Bags'}</th>
                <th className="text-right px-4 py-2.5 font-medium">{isBn ? 'ওজন (কেজি)' : 'Weight (kg)'}</th>
                {!hideFinancials && <th className="text-right px-4 py-2.5 font-medium">{isBn ? 'মূল্য (৳)' : 'Value'}</th>}
                <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'নোট' : 'Notes'}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {displayedEvents.length === 0 ? (
                <tr>
                  <td colSpan={hideFinancials ? 7 : 8} className="px-4 py-8 text-center text-slate-500">
                    {isBn ? 'কোনো ঐতিহাসিক প্রবাহ তথ্য পাওয়া যায়নি।' : 'No historical flow records found.'}
                  </td>
                </tr>
              ) : (
                displayedEvents.map((ev) => (
                  <tr key={ev.uid} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/30">
                    <td className="px-4 py-2.5 font-mono text-slate-500 whitespace-nowrap">{ev.dateStr?.slice(0, 16).replace('T', ' ')}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="font-medium text-slate-900 dark:text-white">{getKindLabel(ev.kind)}</span>
                      <span className="text-slate-400"> · </span>
                      <span className="font-mono text-slate-600 dark:text-slate-300">{ev.refNo}</span>
                    </td>
                    <td className="px-4 py-2.5">{ev.itemName}</td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-medium text-slate-700 dark:text-slate-200">{ev.fromLabel}</span>
                        <ArrowRight className="w-3 h-3 text-amber-600 shrink-0" />
                        <span className="font-medium text-slate-900 dark:text-white">{ev.toLabel}</span>
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums">{ev.bags.toLocaleString('en-IN')}</td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold">
                      {ev.weightPending && ev.qtyKg <= 0 ? (
                        <span className="text-amber-700 dark:text-amber-400">{isBn ? 'ওজন ছাড়া' : 'Pending'}</span>
                      ) : (
                        ev.qtyKg.toLocaleString('en-IN')
                      )}
                    </td>
                    {!hideFinancials && (
                      <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                        {ev.value > 0 ? `৳${ev.value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '—'}
                      </td>
                    )}
                    <td className="px-4 py-2.5 text-slate-500 max-w-[200px] truncate">{ev.notes || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
