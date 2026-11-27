import React, { useMemo, useState } from 'react';
import {
  ArrowRightLeft,
  Boxes,
  FileSpreadsheet,
  FileText,
  GitBranch,
  History,
  Printer,
  QrCode,
  Search,
  Warehouse as WarehouseIcon,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nContext';
import { apiMutate } from '../services/api';
import type {
  ChatalBatch,
  CostingMethod,
  DirectPaddySale,
  DryingBatch,
  InventoryLot,
  ItemMaster,
  PaddyPurchase,
  ProductCategory,
  ProductionBatch,
  StockLedgerEntry,
  StockTransfer,
  Warehouse,
} from '../types/erp';
import {
  exportExcelWorkbook,
  exportGodownStockSummaryPdf,
  type GodownSummaryPdfGroup,
} from '../utils/reports';
import { GodownFlowPanel } from './GodownFlowPanel';
import { StockBatchQrModal } from './StockBatchQrModal';

interface InventoryModuleProps {
  warehouses: Warehouse[];
  lots: InventoryLot[];
  transfers: StockTransfer[];
  ledger: StockLedgerEntry[];
  items: ItemMaster[];
  categories: ProductCategory[];
  chatalBatches?: ChatalBatch[];
  purchases?: PaddyPurchase[];
  paddySales?: DirectPaddySale[];
  batches?: ProductionBatch[];
  dryingBatches?: DryingBatch[];
  hideFinancials?: boolean;
  onRefresh: () => void;
  onNotify: (msg: string, tone?: 'ok' | 'warn' | 'err') => void;
}

function computeBagUnitStats(totalWeightKg: number, totalBags: number, totalValue: number, divisor: number) {
  const safeDiv = divisor > 0 ? divisor : 75.5;
  const netWeight = Math.max(0, totalWeightKg - totalBags);
  const netUnits = netWeight > 0 ? netWeight / safeDiv : 0;
  const bagUnitRate = netUnits > 0 ? totalValue / netUnits : 0;
  return { netWeight, netUnits, bagUnitRate };
}

export const InventoryModule: React.FC<InventoryModuleProps> = ({
  warehouses,
  lots,
  transfers,
  ledger,
  items,
  categories,
  chatalBatches = [],
  purchases = [],
  paddySales = [],
  batches = [],
  dryingBatches = [],
  hideFinancials = false,
  onRefresh,
  onNotify,
}) => {
  const { lang, t } = useI18n();
  const isBn = lang === 'bn';

  const [subTab, setSubTab] = useState<'godown' | 'flow' | 'lots' | 'transfers' | 'ledger'>('godown');
  const [stockScope, setStockScope] = useState<'PADDY' | 'ALL'>('PADDY');
  const [unitDivisor, setUnitDivisor] = useState<number>(75.5);
  const [lotSearch, setLotSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [warehouseFilter, setWarehouseFilter] = useState<string>('ALL');
  const [hideEmptyLots, setHideEmptyLots] = useState(true);
  const [qrModalLots, setQrModalLots] = useState<InventoryLot[] | null>(null);
  const [qrModalTitle, setQrModalTitle] = useState<string | undefined>(undefined);
  const [selectedLotIds, setSelectedLotIds] = useState<number[]>([]);

  const [showTransferForm, setShowTransferForm] = useState(true);
  const activeWarehouses = warehouses.filter((w) => Boolean(w.is_active));
  const activeItems = items.filter((i) => Boolean(i.is_active));

  const [trForm, setTrForm] = useState({
    from_warehouse_id: activeWarehouses[0]?.id || warehouses[0]?.id || 0,
    to_warehouse_id: activeWarehouses[1]?.id || warehouses[1]?.id || 0,
    item_id: activeItems[0]?.id || items[0]?.id || 0,
    bag_count: 0,
    qty_kg: 0,
    unit_divisor: 75.5,
    costing_method: 'FIFO' as CostingMethod,
    vehicle_or_driver: '',
    notes: '',
  });

  const itemMap = useMemo(() => {
    const m = new Map<number, ItemMaster>();
    for (const it of items) m.set(it.id, it);
    return m;
  }, [items]);

  const warehouseMap = useMemo(() => {
    const m = new Map<number, Warehouse>();
    for (const w of warehouses) m.set(w.id, w);
    return m;
  }, [warehouses]);

  const resolveLotBags = (l: InventoryLot): number => {
    if (l.remaining_bags !== undefined && l.remaining_bags !== null) {
      return Number(l.remaining_bags || 0);
    }
    const kg = Number(l.remaining_qty_kg || 0);
    if (kg <= 0) return 0;
    const bagWt = Number(l.bag_weight_kg || itemMap.get(l.item_id)?.bag_weight_kg || 50) || 50;
    return Math.round(kg / bagWt);
  };

  const resolveLotValue = (l: InventoryLot): number => {
    if (l.weight_pending) {
      return Number(l.pending_cost_total || 0);
    }
    return Number(l.remaining_qty_kg || 0) * Number(l.unit_cost_per_kg || 0);
  };

  // Inventory KPIs
  const activeLots = useMemo(
    () => lots.filter((l) => Number(l.remaining_qty_kg || 0) > 0 || Boolean(l.weight_pending)),
    [lots]
  );
  const totalStockKg = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);
  const totalStockBags = activeLots.reduce((s, l) => s + resolveLotBags(l), 0);
  const totalStockValue = activeLots.reduce((s, l) => s + resolveLotValue(l), 0);

  // Per-Godown Variety Summary (only active stock > 0)
  const godownSummary = useMemo(() => {
    const safeDiv = unitDivisor > 0 ? unitDivisor : 75.5;
    const whBuckets = new Map<
      number,
      {
        warehouseId: number;
        warehouseCode: string;
        warehouseName: string;
        location: string;
        itemsMap: Map<
          number,
          {
            itemId: number;
            itemName: string;
            sku: string;
            category: string;
            lotCount: number;
            totalBags: number;
            totalWeightKg: number;
            totalValue: number;
          }
        >;
      }
    >();

    for (const l of activeLots) {
      if (warehouseFilter !== 'ALL' && String(l.warehouse_id) !== warehouseFilter) continue;
      const itemMaster = itemMap.get(l.item_id);
      const isPaddy =
        l.category === 'PADDY' ||
        l.process_grade === 'RAW_PADDY' ||
        itemMaster?.category === 'PADDY' ||
        itemMaster?.process_grade === 'RAW_PADDY';
      if (stockScope === 'PADDY' && !isPaddy) continue;

      if (lotSearch.trim()) {
        const q = lotSearch.toLowerCase();
        const hit =
          (l.item_name || '').toLowerCase().includes(q) ||
          (l.sku || '').toLowerCase().includes(q) ||
          (l.warehouse_name || '').toLowerCase().includes(q);
        if (!hit) continue;
      }

      const wh = warehouseMap.get(l.warehouse_id);
      if (!whBuckets.has(l.warehouse_id)) {
        whBuckets.set(l.warehouse_id, {
          warehouseId: l.warehouse_id,
          warehouseCode: l.warehouse_code || wh?.code || `GD-${l.warehouse_id}`,
          warehouseName: l.warehouse_name || wh?.name || `Godown #${l.warehouse_id}`,
          location: wh?.location || '',
          itemsMap: new Map(),
        });
      }
      const bucket = whBuckets.get(l.warehouse_id)!;
      if (!bucket.itemsMap.has(l.item_id)) {
        bucket.itemsMap.set(l.item_id, {
          itemId: l.item_id,
          itemName: l.item_name || itemMaster?.name || `Item #${l.item_id}`,
          sku: l.sku || itemMaster?.sku || '',
          category: l.category || itemMaster?.category || '',
          lotCount: 0,
          totalBags: 0,
          totalWeightKg: 0,
          totalValue: 0,
        });
      }
      const row = bucket.itemsMap.get(l.item_id)!;
      const qtyKg = Number(l.remaining_qty_kg || 0);
      const bags = resolveLotBags(l);
      const val = resolveLotValue(l);
      row.lotCount += 1;
      row.totalBags += bags;
      row.totalWeightKg += qtyKg;
      row.totalValue += val;
    }

    const groups = Array.from(whBuckets.values())
      .sort((a, b) => a.warehouseId - b.warehouseId)
      .map((g) => {
        const itemRows = Array.from(g.itemsMap.values()).map((it) => {
          const stats = computeBagUnitStats(it.totalWeightKg, it.totalBags, it.totalValue, safeDiv);
          return {
            ...it,
            netWeightKg: stats.netWeight,
            netUnits: stats.netUnits,
            bagUnitRate: stats.bagUnitRate,
          };
        });
        const totalBags = itemRows.reduce((s, r) => s + r.totalBags, 0);
        const totalWeightKg = itemRows.reduce((s, r) => s + r.totalWeightKg, 0);
        const totalValue = itemRows.reduce((s, r) => s + r.totalValue, 0);
        const gStats = computeBagUnitStats(totalWeightKg, totalBags, totalValue, safeDiv);
        return {
          warehouseId: g.warehouseId,
          warehouseCode: g.warehouseCode,
          warehouseName: g.warehouseName,
          location: g.location,
          items: itemRows,
          totalBags,
          totalWeightKg,
          totalValue,
          netWeightKg: gStats.netWeight,
          netUnits: gStats.netUnits,
          bagUnitRate: gStats.bagUnitRate,
        };
      });

    const grandTotalBags = groups.reduce((s, g) => s + g.totalBags, 0);
    const grandTotalWeightKg = groups.reduce((s, g) => s + g.totalWeightKg, 0);
    const grandTotalValue = groups.reduce((s, g) => s + g.totalValue, 0);
    const grandStats = computeBagUnitStats(grandTotalWeightKg, grandTotalBags, grandTotalValue, safeDiv);

    return {
      groups,
      grandTotalBags,
      grandTotalWeightKg,
      grandTotalValue,
      grandNetWeightKg: grandStats.netWeight,
      grandNetUnits: grandStats.netUnits,
      grandBagUnitRate: grandStats.bagUnitRate,
    };
  }, [activeLots, warehouseFilter, stockScope, lotSearch, unitDivisor, itemMap, warehouseMap]);

  const itemStockMap = useMemo(() => {
    const m = new Map<string, { bags: number; weightKg: number; value: number }>();
    for (const l of activeLots) {
      const kg = Number(l.remaining_qty_kg || 0);
      if (kg <= 0.0001 && !l.weight_pending) continue;
      const key = `${l.warehouse_id}-${l.item_id}`;
      const cur = m.get(key) || { bags: 0, weightKg: 0, value: 0 };
      cur.bags += resolveLotBags(l);
      cur.weightKg += kg;
      cur.value += resolveLotValue(l);
      m.set(key, cur);
    }
    return m;
  }, [activeLots, itemMap]);

  const selectedTransferStock = useMemo(() => {
    const raw = itemStockMap.get(`${trForm.from_warehouse_id}-${trForm.item_id}`) || {
      bags: 0,
      weightKg: 0,
      value: 0,
    };
    const safeDiv = trForm.unit_divisor > 0 ? trForm.unit_divisor : 75.5;
    const stockNetUnits = raw.weightKg > raw.bags ? (raw.weightKg - raw.bags) / safeDiv : 0;
    const bagUnitRate = stockNetUnits > 0 ? raw.value / stockNetUnits : 0;
    const avgBagKg =
      raw.bags > 0
        ? raw.weightKg / raw.bags
        : Number(itemMap.get(trForm.item_id)?.bag_weight_kg || 60) || 60;
    return {
      ...raw,
      stockNetUnits,
      bagUnitRate,
      avgBagKg,
      safeDiv,
    };
  }, [itemStockMap, trForm.from_warehouse_id, trForm.item_id, trForm.unit_divisor, itemMap]);

  const transferGoingNetUnits = useMemo(() => {
    const kg = Number(trForm.qty_kg || 0);
    const bags = Number(trForm.bag_count || 0);
    if (kg <= bags || selectedTransferStock.safeDiv <= 0) return 0;
    return (kg - bags) / selectedTransferStock.safeDiv;
  }, [trForm.qty_kg, trForm.bag_count, selectedTransferStock.safeDiv]);

  const estimatedTransferValue = useMemo(() => {
    if (selectedTransferStock.bagUnitRate > 0 && transferGoingNetUnits > 0) {
      return Number((selectedTransferStock.bagUnitRate * transferGoingNetUnits).toFixed(2));
    }
    if (selectedTransferStock.weightKg > 0) {
      return Number(
        ((selectedTransferStock.value / selectedTransferStock.weightKg) * Number(trForm.qty_kg || 0)).toFixed(2)
      );
    }
    return 0;
  }, [selectedTransferStock, transferGoingNetUnits, trForm.qty_kg]);

  const availableInSourceKg = selectedTransferStock.weightKg;

  const categoryNameMap = categories.reduce<Record<string, string>>((acc, c) => {
    acc[c.code] = c.name;
    return acc;
  }, {});

  const filteredLots = lots.filter((l) => {
    if (hideEmptyLots && Number(l.remaining_qty_kg || 0) <= 0 && !l.weight_pending) return false;
    if (categoryFilter !== 'ALL' && l.category !== categoryFilter) return false;
    if (warehouseFilter !== 'ALL' && String(l.warehouse_id) !== warehouseFilter) return false;
    if (!lotSearch.trim()) return true;
    const q = lotSearch.toLowerCase();
    return (
      l.lot_code.toLowerCase().includes(q) ||
      (l.item_name || '').toLowerCase().includes(q) ||
      (l.sku || '').toLowerCase().includes(q) ||
      (l.warehouse_name || '').toLowerCase().includes(q)
    );
  });

  const handleViewQr = (lot: InventoryLot) => {
    setQrModalTitle(undefined);
    setQrModalLots([lot]);
  };

  const toggleSelectLot = (lotId: number) => {
    setSelectedLotIds((prev) =>
      prev.includes(lotId) ? prev.filter((id) => id !== lotId) : [...prev, lotId]
    );
  };

  const allFilteredLotsSelected =
    filteredLots.length > 0 && filteredLots.every((l) => selectedLotIds.includes(l.id));

  const handleToggleSelectAllLots = () => {
    const filteredIds = filteredLots.map((l) => l.id);
    if (allFilteredLotsSelected) {
      setSelectedLotIds((prev) => prev.filter((id) => !filteredIds.includes(id)));
    } else {
      setSelectedLotIds(Array.from(new Set([...selectedLotIds, ...filteredIds])));
    }
  };

  const selectedFilteredLotsCount = filteredLots.filter((l) => selectedLotIds.includes(l.id)).length;

  const handlePrintBatchQrs = () => {
    const chosen =
      selectedFilteredLotsCount > 0
        ? filteredLots.filter((l) => selectedLotIds.includes(l.id))
        : filteredLots;
    if (chosen.length === 0) {
      onNotify(
        isBn ? 'QR তৈরি করার জন্য কোনো স্টক ব্যাচ পাওয়া যায়নি।' : 'No stock batches match your current filter.',
        'warn'
      );
      return;
    }
    setQrModalTitle(
      selectedFilteredLotsCount > 0
        ? isBn
          ? `নির্বাচিত ${chosen.length}টি স্টক ব্যাচের QR লেবেল`
          : `Selected Stock Batch QR Labels (${chosen.length})`
        : isBn
          ? `ফিল্টারকৃত ${chosen.length}টি স্টক ব্যাচের QR লেবেল`
          : `Filtered Stock Batch QR Labels (${chosen.length})`
    );
    setQrModalLots(chosen);
  };

  const handleTransferFromWarehouseChange = (nextFromId: number) => {
    const currentHasStock = (itemStockMap.get(`${nextFromId}-${trForm.item_id}`)?.weightKg || 0) > 0;
    const firstStockedItem = !currentHasStock
      ? activeItems.find((it) => (itemStockMap.get(`${nextFromId}-${it.id}`)?.weightKg || 0) > 0)
      : undefined;
    const nextItemId = firstStockedItem ? firstStockedItem.id : trForm.item_id;
    const nextToId =
      trForm.to_warehouse_id === nextFromId
        ? activeWarehouses.find((w) => w.id !== nextFromId)?.id || trForm.to_warehouse_id
        : trForm.to_warehouse_id;
    setTrForm((prev) => ({
      ...prev,
      from_warehouse_id: nextFromId,
      to_warehouse_id: nextToId,
      item_id: nextItemId,
    }));
  };

  const handleTransferBagChange = (nextBags: number) => {
    const cleanBags = Math.max(0, Math.round(nextBags));
    const suggestedKg =
      selectedTransferStock.bags > 0
        ? Math.round((cleanBags * selectedTransferStock.weightKg) / selectedTransferStock.bags)
        : Math.round(cleanBags * selectedTransferStock.avgBagKg);
    setTrForm((prev) => ({
      ...prev,
      bag_count: cleanBags,
      qty_kg: cleanBags > 0 && suggestedKg > 0 ? suggestedKg : prev.qty_kg,
    }));
  };

  const handleFillAllTransferStock = () => {
    if (selectedTransferStock.weightKg <= 0) return;
    setTrForm((prev) => ({
      ...prev,
      bag_count: selectedTransferStock.bags,
      qty_kg: Number(selectedTransferStock.weightKg.toFixed(2)),
    }));
  };

  const handleTransfer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (trForm.from_warehouse_id === trForm.to_warehouse_id) {
      onNotify(
        isBn ? 'প্রেরক এবং গন্তব্য গুদাম ভিন্ন হতে হবে।' : 'Source and destination warehouses must be different.',
        'err'
      );
      return;
    }
    if (trForm.bag_count <= 0) {
      onNotify(isBn ? 'যত বস্তা যাচ্ছে তার সংখ্যা দিন।' : 'Please enter going bag count.', 'err');
      return;
    }
    if (trForm.qty_kg <= 0) {
      onNotify(isBn ? 'যত ওজন যাচ্ছে তা শূন্যের বেশি হতে হবে।' : 'Going transfer weight must be positive.', 'err');
      return;
    }
    if (trForm.qty_kg <= trForm.bag_count) {
      onNotify(
        isBn ? 'ওজন (কেজি) অবশ্যই বস্তার সংখ্যার চেয়ে বেশি হতে হবে।' : 'Weight (kg) must exceed bag count.',
        'err'
      );
      return;
    }
    if (trForm.qty_kg > availableInSourceKg + 0.0001) {
      onNotify(
        isBn
          ? `প্রেরক গুদামে পর্যাপ্ত মজুদ নেই (মজুদ: ${availableInSourceKg.toLocaleString()} কেজি)।`
          : `Insufficient stock in source godown (Available: ${availableInSourceKg.toLocaleString()} kg).`,
        'err'
      );
      return;
    }
    try {
      const res = await apiMutate({
        endpoint: '/api/v1/stock-transfers',
        payload: trForm,
        module: 'Stock Transfer',
        summary: `Transfer ${trForm.bag_count} bags / ${trForm.qty_kg} kg (${trForm.costing_method})`,
      });
      if (res.offlineQueued) {
        onNotify(
          isBn
            ? 'অফলাইন: স্টক স্থানান্তর IndexedDB-তে সংরক্ষিত হয়েছে।'
            : 'Offline: Stock transfer queued in IndexedDB.',
          'warn'
        );
      } else {
        onNotify(
          isBn
            ? `${trForm.bag_count} বস্তা (${trForm.qty_kg} কেজি) আন্তঃ-গুদাম স্থানান্তর সফলভাবে সম্পন্ন হয়েছে।`
            : `Transferred ${trForm.bag_count} bags (${trForm.qty_kg} kg) between godowns.`,
          'ok'
        );
      }
      setTrForm((prev) => ({
        ...prev,
        bag_count: 0,
        qty_kg: 0,
        vehicle_or_driver: '',
        notes: '',
      }));
      setShowTransferForm(false);
      onRefresh();
    } catch (err) {
      onNotify((err as Error).message, 'err');
    }
  };

  const handleExportGodownPdf = (exportLang: 'en' | 'bn') => {
    const groups: GodownSummaryPdfGroup[] = godownSummary.groups.map((g) => ({
      warehouseCode: g.warehouseCode,
      warehouseName: g.warehouseName,
      items: g.items.map((it) => ({
        itemName: it.itemName,
        sku: it.sku,
        totalBags: it.totalBags,
        totalWeightKg: it.totalWeightKg,
        netUnits: it.netUnits,
        totalValue: it.totalValue,
        bagUnitRate: it.bagUnitRate,
      })),
      totalBags: g.totalBags,
      totalWeightKg: g.totalWeightKg,
      netUnits: g.netUnits,
      totalValue: g.totalValue,
      bagUnitRate: g.bagUnitRate,
    }));
    void exportGodownStockSummaryPdf({
      groups,
      grandTotalBags: godownSummary.grandTotalBags,
      grandTotalWeightKg: godownSummary.grandTotalWeightKg,
      grandNetUnits: godownSummary.grandNetUnits,
      grandTotalValue: godownSummary.grandTotalValue,
      grandBagUnitRate: godownSummary.grandBagUnitRate,
      divisor: unitDivisor || 75.5,
      onlyPaddy: stockScope === 'PADDY',
      hideFinancials,
      lang: exportLang,
    });
  };

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* KPI Strip */}
      <div className={`grid grid-cols-2 ${hideFinancials ? 'lg:grid-cols-3' : 'lg:grid-cols-4'} gap-3 sm:gap-4`}>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] sm:text-xs text-slate-500">{t('inv.totalLiveStock')}</div>
          <div className="text-lg sm:text-2xl font-display font-bold font-mono tabular-nums mt-1">
            {totalStockKg.toLocaleString('en-IN')} {t('common.kg')}
          </div>
          <div className="text-[11px] sm:text-xs text-slate-500 mt-1">
            {totalStockBags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'} ·{' '}
            {(totalStockKg / 1000).toLocaleString('en-IN', { maximumFractionDigits: 2 })} {t('inv.mtTotal')}
          </div>
        </div>
        {!hideFinancials && (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
            <div className="text-[11px] sm:text-xs text-slate-500">{t('inv.valuation')}</div>
            <div className="text-lg sm:text-2xl font-display font-bold font-mono tabular-nums mt-1">
              ৳{totalStockValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </div>
            <div className="text-[11px] sm:text-xs text-slate-500 mt-1">{t('inv.fifoWavgBasis')}</div>
          </div>
        )}
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] sm:text-xs text-slate-500">{t('inv.activeLots')}</div>
          <div className="text-lg sm:text-2xl font-display font-bold font-mono tabular-nums mt-1">{activeLots.length}</div>
          <div className="text-[11px] sm:text-xs text-slate-500 mt-1">{lots.length} {t('inv.trackedLots')}</div>
        </div>
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4">
          <div className="text-[11px] sm:text-xs text-slate-500">{t('inv.stockMovements')}</div>
          <div className="text-lg sm:text-2xl font-display font-bold font-mono tabular-nums mt-1">{transfers.length}</div>
          <div className="text-[11px] sm:text-xs text-slate-500 mt-1">{ledger.length} {t('inv.ledgerPostings')}</div>
        </div>
      </div>

      {/* Sub-navigation & Action */}
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg w-full sm:w-auto">
          <button
            onClick={() => setSubTab('godown')}
            className={`min-h-[38px] flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'godown'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <WarehouseIcon className="w-3.5 h-3.5" />
            <span>
              {hideFinancials
                ? isBn
                  ? 'গোডাউন স্টক (বস্তা/কেজি)'
                  : 'Godown Stock'
                : isBn
                ? 'গোডাউন ভিত্তিক স্টক ও বস্তার হিসাব'
                : 'Godown Stock & Bag Rate'}
            </span>
          </button>
          <button
            onClick={() => setSubTab('flow')}
            className={`min-h-[38px] flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'flow'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <GitBranch className="w-3.5 h-3.5" />
            <span>{isBn ? 'গোডাউন প্রবাহ চিত্র' : 'Godown Flow'}</span>
          </button>
          <button
            onClick={() => setSubTab('lots')}
            className={`min-h-[38px] flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'lots'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <Boxes className="w-3.5 h-3.5" />
            <span>{t('inv.tabLots')} ({filteredLots.length})</span>
          </button>
          <button
            onClick={() => setSubTab('transfers')}
            className={`min-h-[38px] flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'transfers'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <ArrowRightLeft className="w-3.5 h-3.5" />
            <span>{t('inv.tabTransfers')} ({transfers.length})</span>
          </button>
          <button
            onClick={() => setSubTab('ledger')}
            className={`min-h-[38px] flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              subTab === 'ledger'
                ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-sm'
                : 'text-slate-600 dark:text-slate-400'
            }`}
          >
            <History className="w-3.5 h-3.5" />
            <span>{t('inv.tabLedger')} ({ledger.length})</span>
          </button>
        </div>

        <button
          onClick={() => {
            if (subTab !== 'transfers') {
              setSubTab('transfers');
              setShowTransferForm(true);
            } else {
              setShowTransferForm((prev) => !prev);
            }
          }}
          className="min-h-[44px] w-full sm:w-auto flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0"
        >
          <ArrowRightLeft className="w-3.5 h-3.5" />
          <span>{showTransferForm && subTab === 'transfers' ? t('inv.closeTransfer') : t('inv.newTransfer')}</span>
        </button>
      </div>

      {/* 0A. GODOWN PADDY FLOW VISUALIZATION */}
      {subTab === 'flow' && (
        <GodownFlowPanel
          warehouses={warehouses}
          lots={lots}
          transfers={transfers}
          items={items}
          categories={categories}
          chatalBatches={chatalBatches}
          purchases={purchases}
          paddySales={paddySales}
          batches={batches}
          dryingBatches={dryingBatches}
          hideFinancials={hideFinancials}
        />
      )}

      {/* 0. GODOWN-WISE PADDY & STOCK VALUATION WITH BAG UNIT RATE */}
      {subTab === 'godown' && (
        <div className="space-y-5">
          {/* Controls & Formula Info */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 p-0.5">
                  <button
                    type="button"
                    onClick={() => setStockScope('PADDY')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      stockScope === 'PADDY'
                        ? 'bg-slate-900 text-white dark:bg-amber-600'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {isBn ? 'শুধু কাঁচা ধান (Paddy)' : 'Raw Paddy Only'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setStockScope('ALL')}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                      stockScope === 'ALL'
                        ? 'bg-slate-900 text-white dark:bg-amber-600'
                        : 'text-slate-600 dark:text-slate-300'
                    }`}
                  >
                    {isBn ? 'সব পণ্য (চাল ও উপজাত সহ)' : 'All Stock (Incl. Rice & By-Products)'}
                  </button>
                </div>

                <select
                  value={warehouseFilter}
                  onChange={(e) => setWarehouseFilter(e.target.value)}
                  className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                >
                  <option value="ALL">{t('inv.allWarehouses')}</option>
                  {warehouses.map((w) => (
                    <option key={w.id} value={String(w.id)}>
                      {w.name}
                    </option>
                  ))}
                </select>

                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={lotSearch}
                    onChange={(e) => setLotSearch(e.target.value)}
                    placeholder={isBn ? 'ধান বা গোডাউন খুঁজুন...' : 'Search variety or godown...'}
                    className="pl-8 pr-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 w-52"
                  />
                </div>

                <div className="flex items-center gap-1.5 text-xs">
                  <span className="text-slate-500">{isBn ? 'ডিভাইজর:' : 'Divisor:'}</span>
                  <input
                    type="number"
                    min="1"
                    step="0.5"
                    value={unitDivisor}
                    onChange={(e) => setUnitDivisor(Number(e.target.value) || 75.5)}
                    className="w-20 px-2.5 py-1.5 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  onClick={() => handleExportGodownPdf('en')}
                  className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                >
                  <FileText className="w-3.5 h-3.5" /> {t('rep.pdfEn')}
                </button>
                <button
                  onClick={() => handleExportGodownPdf('bn')}
                  className="flex items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-xs font-medium whitespace-nowrap shrink-0"
                >
                  <FileText className="w-3.5 h-3.5" /> {t('rep.pdfBn')}
                </button>
                <button
                  onClick={() =>
                    exportExcelWorkbook(
                      'SonaGrain-Godown-Stock-Summary',
                      [
                        {
                          name: isBn ? 'গোডাউন ভিত্তিক স্টক' : 'Godown Stock Valuation',
                          rows: [
                            ...godownSummary.groups.flatMap((g) => [
                              ...g.items.map((it) => {
                                const baseRow = {
                                  GodownCode: g.warehouseCode,
                                  GodownName: g.warehouseName,
                                  Item: it.itemName,
                                  SKU: it.sku,
                                  Bags: it.totalBags,
                                  TotalWeightKg: Number(it.totalWeightKg.toFixed(2)),
                                  NetUnits_Div75_5: Number(it.netUnits.toFixed(3)),
                                };
                                return hideFinancials
                                  ? baseRow
                                  : {
                                      ...baseRow,
                                      TotalValueBDT: Number(it.totalValue.toFixed(2)),
                                      BagUnitRateBDT: Number(it.bagUnitRate.toFixed(2)),
                                    };
                              }),
                              {
                                GodownCode: g.warehouseCode,
                                GodownName: `${g.warehouseName} (SUBTOTAL)`,
                                Item: '--- GODOWN TOTAL ---',
                                SKU: '',
                                Bags: g.totalBags,
                                TotalWeightKg: Number(g.totalWeightKg.toFixed(2)),
                                NetUnits_Div75_5: Number(g.netUnits.toFixed(3)),
                                ...(hideFinancials
                                  ? {}
                                  : {
                                      TotalValueBDT: Number(g.totalValue.toFixed(2)),
                                      BagUnitRateBDT: Number(g.bagUnitRate.toFixed(2)),
                                    }),
                              },
                            ]),
                            {
                              GodownCode: 'ALL',
                              GodownName: 'GRAND TOTAL (ALL GODOWNS)',
                              Item: 'ALL VARIETIES COMBINED',
                              SKU: '',
                              Bags: godownSummary.grandTotalBags,
                              TotalWeightKg: Number(godownSummary.grandTotalWeightKg.toFixed(2)),
                              NetUnits_Div75_5: Number(godownSummary.grandNetUnits.toFixed(3)),
                              ...(hideFinancials
                                ? {}
                                : {
                                    TotalValueBDT: Number(godownSummary.grandTotalValue.toFixed(2)),
                                    BagUnitRateBDT: Number(godownSummary.grandBagUnitRate.toFixed(2)),
                                  }),
                            },
                          ],
                        },
                      ],
                      lang
                    )
                  }
                  className="min-h-[38px] flex items-center gap-1 px-3 py-2 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium whitespace-nowrap shrink-0"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" /> {t('common.excel')}
                </button>
              </div>
          </div>
        </div>

          {/* Separate Section per Godown */}
          {godownSummary.groups.length === 0 ? (
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-8 text-center text-xs text-slate-500">
              {isBn
                ? 'বর্তমান ফিল্টারে কোনো গোডাউনে অবশিষ্ট স্টক পাওয়া যায়নি। সব পণ্য দেখতে "সব পণ্য" সিলেক্ট করুন।'
                : 'No active stock matches this filter. Switch to "All Stock" to inspect rice & by-products.'}
            </div>
          ) : (
            <div className="space-y-4">
              {godownSummary.groups.map((g, gIdx) => (
                <div
                  key={g.warehouseId}
                  className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden"
                >
                  {/* Godown Header */}
                  <div className="px-4 py-3 bg-slate-50 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2.5">
                      <span className="w-6 h-6 rounded-md bg-slate-900 dark:bg-amber-600 text-white font-mono text-xs font-bold flex items-center justify-center">
                        {gIdx + 1}
                      </span>
                      <div>
                        <div className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                          {g.warehouseName}{' '}
                          <span className="font-mono text-xs text-slate-500">({g.warehouseCode})</span>
                        </div>
                        {g.location && <div className="text-[11px] text-slate-500">{g.location}</div>}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-3 sm:gap-4 text-xs font-mono tabular-nums">
                      <div>
                        <span className="text-slate-500">{isBn ? 'বস্তা:' : 'Bags:'}</span>{' '}
                        <strong className="text-slate-900 dark:text-white">{g.totalBags.toLocaleString('en-IN')}</strong>
                      </div>
                      <div>
                        <span className="text-slate-500">{isBn ? 'ওজন:' : 'Weight:'}</span>{' '}
                        <strong className="text-slate-900 dark:text-white">
                          {g.totalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 2 })} kg
                        </strong>
                      </div>
                      {!hideFinancials && (
                        <>
                          <div>
                            <span className="text-slate-500">{isBn ? 'মোট মূল্য:' : 'Value:'}</span>{' '}
                            <strong className="text-emerald-700 dark:text-emerald-400">
                              ৳{g.totalValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </strong>
                          </div>
                          <div>
                            <span className="text-slate-500">{isBn ? 'গড় একক মূল্য:' : 'Unit Rate:'}</span>{' '}
                            <strong className="text-amber-700 dark:text-amber-400">
                              ৳{g.bagUnitRate.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </strong>
                          </div>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Mobile Variety Cards */}
                  <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
                    {g.items.map((it) => (
                      <div key={it.itemId} className="p-3.5 space-y-2 text-xs">
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-semibold text-slate-900 dark:text-white">{it.itemName}</div>
                            <div className="text-[11px] text-slate-500 font-mono">
                              {it.sku} · {it.lotCount} {isBn ? 'টি লট' : 'lot(s)'}
                            </div>
                          </div>
                          {!hideFinancials && (
                            <div className="text-right font-mono font-bold text-emerald-700 dark:text-emerald-400">
                              ৳{it.totalValue.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                            </div>
                          )}
                        </div>
                        <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 dark:bg-slate-950 p-2 font-mono text-[11px]">
                          <div>
                            <div className="text-slate-400">{isBn ? 'বস্তা' : 'Bags'}</div>
                            <div className="font-semibold">{it.totalBags.toLocaleString('en-IN')}</div>
                          </div>
                          <div>
                            <div className="text-slate-400">{isBn ? 'ওজন' : 'Weight'}</div>
                            <div className="font-semibold">{it.totalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 2 })} kg</div>
                          </div>
                          <div className="text-right">
                            <div className="text-slate-400">{hideFinancials ? (isBn ? 'নিট একক' : 'Net Unit') : (isBn ? 'বস্তা রেট' : 'Bag Rate')}</div>
                            <div className="font-semibold text-amber-700 dark:text-amber-400">
                              {hideFinancials
                                ? it.netUnits.toLocaleString('en-IN', { maximumFractionDigits: 2 })
                                : `৳${it.bagUnitRate.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Desktop Variety Table inside this Godown */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-white dark:bg-slate-900 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                          <th className="text-left px-4 py-2.5 font-medium">{isBn ? 'ধানের জাত / পণ্য' : 'Paddy Variety / Product'}</th>
                          <th className="text-right px-4 py-2.5 font-medium">{isBn ? 'বস্তা সংখ্যা' : 'Total Bags'}</th>
                          <th className="text-right px-4 py-2.5 font-medium">{isBn ? 'মোট ওজন (কেজি)' : 'Total Weight (kg)'}</th>
                          <th className="text-right px-4 py-2.5 font-medium">
                            {isBn ? `(ওজন−বস্তা) ÷ ${unitDivisor || 75.5}` : `(Wt−Bags) ÷ ${unitDivisor || 75.5}`}
                          </th>
                          {!hideFinancials && (
                            <>
                              <th className="text-right px-4 py-2.5 font-medium">{isBn ? 'মোট মূল্য (৳)' : 'Total Value (৳)'}</th>
                              <th className="text-right px-4 py-2.5 font-medium">
                                {isBn ? `বস্তার একক মূল্য (/${unitDivisor || 75.5})` : `Bag Unit Rate (/${unitDivisor || 75.5})`}
                              </th>
                            </>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {g.items.map((it) => (
                          <tr key={it.itemId} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                            <td className="px-4 py-3">
                              <div className="font-medium text-slate-900 dark:text-white">{it.itemName}</div>
                              <div className="text-[11px] text-slate-500 font-mono">
                                {it.sku} · {it.lotCount} {isBn ? 'টি লট' : 'lot(s)'}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold">
                              {it.totalBags.toLocaleString('en-IN')}
                            </td>
                            <td className="px-4 py-3 text-right font-mono tabular-nums">
                              {it.totalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                            </td>
                            <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-500">
                              {it.netUnits.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                            </td>
                            {!hideFinancials && (
                              <>
                                <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold">
                                  ৳{it.totalValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                                <td className="px-4 py-3 text-right font-mono tabular-nums font-bold text-amber-700 dark:text-amber-400">
                                  ৳{it.bagUnitRate.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                </td>
                              </>
                            )}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="bg-slate-50 dark:bg-slate-950 font-semibold border-t border-slate-200 dark:border-slate-800">
                          <td className="px-4 py-2.5">
                            {isBn ? `গোডাউন মোট — ${g.warehouseName}` : `Godown Subtotal — ${g.warehouseName}`}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                            {g.totalBags.toLocaleString('en-IN')}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums">
                            {g.totalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono tabular-nums text-slate-500">
                            {g.netUnits.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                          </td>
                          {!hideFinancials && (
                            <>
                              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-emerald-700 dark:text-emerald-400">
                                ৳{g.totalValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-amber-700 dark:text-amber-400">
                                ৳{g.bagUnitRate.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            </>
                          )}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                </div>
              ))}

              {/* Grand Total Summary Across All Godowns */}
              {hideFinancials ? (
                <div className="bg-slate-900 dark:bg-slate-950 text-white border border-amber-500/60 rounded-xl px-5 py-4 flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-display font-bold text-amber-400">
                      {isBn
                        ? `সকল গোডাউন সর্বমোট স্টক (${godownSummary.groups.length}টি গোডাউন)`
                        : `GRAND TOTAL STOCK — ALL GODOWNS (${godownSummary.groups.length} Godowns)`}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {isBn ? 'সব গোডাউনের অবশিষ্ট বস্তা ও মোট ওজন' : 'Combined remaining bags and physical weight'}
                    </div>
                  </div>
                  <div className="font-mono tabular-nums text-lg sm:text-xl font-bold text-emerald-400">
                    {godownSummary.grandTotalBags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'} ·{' '}
                    {godownSummary.grandTotalWeightKg.toLocaleString('en-IN', { maximumFractionDigits: 2 })} kg
                  </div>
                </div>
              ) : (
                <div className="bg-slate-900 dark:bg-slate-950 text-white border-2 border-amber-500/80 rounded-xl px-5 py-4 flex flex-wrap items-center justify-between gap-4">
                  <div>
                    <div className="text-sm font-display font-bold text-amber-400">
                      {isBn
                        ? `সকল গোডাউন সর্বমোট টাকার ভ্যালু (${godownSummary.groups.length}টি গোডাউন)`
                        : `GRAND TOTAL VALUE — ALL GODOWNS (${godownSummary.groups.length} Godowns)`}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {isBn ? 'সব গোডাউনের অবশিষ্ট স্টকের মোট আর্থিক মূল্য' : 'Combined monetary valuation of all remaining warehouse stock'}
                    </div>
                  </div>
                  <div className="font-mono tabular-nums text-2xl font-bold text-emerald-400">
                    ৳{godownSummary.grandTotalValue.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 1. INVENTORY LOTS */}
      {subTab === 'lots' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={lotSearch}
                  onChange={(e) => setLotSearch(e.target.value)}
                  placeholder={t('inv.searchLots')}
                  className="pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 w-64"
                />
              </div>

              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="ALL">{t('inv.allCategories')}</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.code}>
                    {c.name}
                  </option>
                ))}
              </select>

              <select
                value={warehouseFilter}
                onChange={(e) => setWarehouseFilter(e.target.value)}
                className="px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900"
              >
                <option value="ALL">{t('inv.allWarehouses')}</option>
                {warehouses.map((w) => (
                  <option key={w.id} value={String(w.id)}>
                    {w.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={hideEmptyLots}
                  onChange={(e) => setHideEmptyLots(e.target.checked)}
                  className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                />
                <span>{t('inv.hideEmptyLots')}</span>
              </label>

              <button
                type="button"
                onClick={handlePrintBatchQrs}
                disabled={filteredLots.length === 0}
                className="min-h-[38px] inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-amber-600 hover:opacity-95 disabled:opacity-45 text-white text-xs font-medium whitespace-nowrap"
              >
                <Printer className="w-3.5 h-3.5" />
                <span>
                  {selectedFilteredLotsCount > 0
                    ? isBn
                      ? `নির্বাচিত QR প্রিন্ট (${selectedFilteredLotsCount})`
                      : `Print Selected QR (${selectedFilteredLotsCount})`
                    : isBn
                      ? `ব্যাচ QR প্রিন্ট (${filteredLots.length})`
                      : `Print Batch QR (${filteredLots.length})`}
                </span>
              </button>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            {/* Mobile Lots Cards */}
            <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
              {filteredLots.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-slate-500">{t('inv.noLots')}</div>
              ) : (
                filteredLots.map((l) => (
                  <div key={l.id} className="p-3.5 space-y-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <input
                          type="checkbox"
                          checked={selectedLotIds.includes(l.id)}
                          onChange={() => toggleSelectLot(l.id)}
                          className="mt-1 rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="font-mono font-semibold text-slate-900 dark:text-white">{l.lot_code}</span>
                            {Boolean(l.weight_pending) && (
                              <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300 text-[10px] font-semibold">
                                {isBn ? 'ওজন পেন্ডিং' : 'Weight Pending'}
                              </span>
                            )}
                            {Number(l.extra_torn_bags || 0) > 0 && (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 text-[10px] font-semibold">
                                +{Number(l.extra_torn_bags)} {isBn ? 'ছেঁড়া বস্তা' : 'torn'}
                              </span>
                            )}
                          </div>
                          <div className="font-medium text-slate-700 dark:text-slate-300">{l.item_name}</div>
                          <div className="text-[11px] text-slate-500">{l.warehouse_name} · {l.source_type}</div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleViewQr(l)}
                        className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800 shrink-0"
                        title={t('inv.qrModalTitle')}
                      >
                        <QrCode className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-2 rounded-lg bg-slate-50 dark:bg-slate-950 p-2 font-mono text-[11px]">
                      <div>
                        <div className="text-slate-400">{isBn ? 'বস্তা' : 'Bags'}</div>
                        <div className="font-semibold">{resolveLotBags(l).toLocaleString('en-IN')}</div>
                      </div>
                      <div>
                        <div className="text-slate-400">{t('inv.remainingKg')}</div>
                        <div className="font-semibold text-slate-900 dark:text-white">
                          {l.weight_pending ? (isBn ? 'বিক্রিতে মাপা হবে' : 'Weighed at exit') : `${Number(l.remaining_qty_kg).toLocaleString()} kg`}
                        </div>
                      </div>
                      <div className="text-right">
                        {hideFinancials ? (
                          <>
                            <div className="text-slate-400">{t('inv.initialKg')}</div>
                            <div className="font-semibold">{Number(l.initial_qty_kg).toLocaleString()} kg</div>
                          </>
                        ) : (
                          <>
                            <div className="text-slate-400">{t('inv.stockValue')}</div>
                            <div className="font-semibold text-emerald-700 dark:text-emerald-400">
                              ৳{resolveLotValue(l).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Desktop Lots Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <th className="w-10 px-3 py-3 text-center">
                      <input
                        type="checkbox"
                        checked={allFilteredLotsSelected}
                        onChange={handleToggleSelectAllLots}
                        aria-label={isBn ? 'সব নির্বাচন করুন' : 'Select all lots'}
                        className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                      />
                    </th>
                    <th className="text-left px-4 py-3 font-medium">{t('inv.lotCode')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('inv.productCategory')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('inv.warehouse')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('inv.source')}</th>
                    <th className="text-right px-4 py-3 font-medium">{isBn ? 'বস্তা' : 'Bags'}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('inv.initialKg')}</th>
                    <th className="text-right px-4 py-3 font-medium">{t('inv.remainingKg')}</th>
                    {!hideFinancials && (
                      <>
                        <th className="text-right px-4 py-3 font-medium">{t('inv.unitCost')}</th>
                        <th className="text-right px-4 py-3 font-medium">{t('inv.stockValue')}</th>
                      </>
                    )}
                    <th className="text-right px-4 py-3 font-medium">{t('common.qr')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filteredLots.length === 0 ? (
                    <tr>
                      <td colSpan={hideFinancials ? 9 : 11} className="px-4 py-8 text-center text-slate-500">
                        {t('inv.noLots')}
                      </td>
                    </tr>
                  ) : (
                    filteredLots.map((l) => (
                      <tr key={l.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="px-3 py-3 text-center">
                          <input
                            type="checkbox"
                            checked={selectedLotIds.includes(l.id)}
                            onChange={() => toggleSelectLot(l.id)}
                            aria-label={`Select ${l.lot_code}`}
                            className="rounded border-slate-300 text-amber-600 focus:ring-amber-500"
                          />
                        </td>
                        <td className="px-4 py-3 font-mono font-medium text-slate-900 dark:text-white">
                          <div>{l.lot_code}</div>
                          <div className="flex flex-wrap gap-1 mt-0.5 font-sans">
                            {Boolean(l.weight_pending) && (
                              <span className="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/50 text-amber-800 dark:text-amber-300 text-[10px] font-semibold">
                                {isBn ? 'ওজন পেন্ডিং' : 'Weight Pending'}
                              </span>
                            )}
                            {Number(l.extra_torn_bags || 0) > 0 && (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 text-[10px] font-semibold">
                                +{Number(l.extra_torn_bags)} {isBn ? 'ছেঁড়া' : 'torn'}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-slate-800 dark:text-slate-200">{l.item_name}</div>
                          <div className="text-slate-500">
                            {l.sku} · {categoryNameMap[l.category || ''] || l.category}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-700 dark:text-slate-300">{l.warehouse_name}</td>
                        <td className="px-4 py-3 text-slate-500">{l.source_type}</td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          <div>{resolveLotBags(l).toLocaleString('en-IN')}</div>
                          {Number(l.dispatched_bags || 0) > 0 && (
                            <div className="text-[10px] text-slate-500">
                              {isBn ? `বের: ${l.dispatched_bags}ব` : `out: ${l.dispatched_bags}b`}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          {Number(l.initial_qty_kg).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-slate-900 dark:text-white">
                          {l.weight_pending ? (
                            <span className="font-sans text-[11px] font-medium text-amber-700 dark:text-amber-400">
                              {isBn ? 'ওজন অপেক্ষমাণ' : 'Pending'}
                            </span>
                          ) : (
                            Number(l.remaining_qty_kg).toLocaleString()
                          )}
                        </td>
                        {!hideFinancials && (
                          <>
                            <td className="px-4 py-3 text-right font-mono tabular-nums">
                              {l.weight_pending ? '—' : `৳${Number(l.unit_cost_per_kg).toFixed(2)}`}
                            </td>
                            <td className="px-4 py-3 text-right font-mono tabular-nums font-medium">
                              ৳{resolveLotValue(l).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                            </td>
                          </>
                        )}
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => handleViewQr(l)}
                            className="p-1.5 rounded border border-slate-200 dark:border-slate-700 hover:bg-slate-100 dark:hover:bg-slate-800"
                            title={t('inv.qrModalTitle')}
                          >
                            <QrCode className="w-3.5 h-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 2. STOCK TRANSFERS */}
      {subTab === 'transfers' && (
        <div className="space-y-4">
          {showTransferForm && (
            <form
              onSubmit={handleTransfer}
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 sm:p-6 space-y-5"
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-3">
                <div>
                  <h3 className="text-sm font-display font-semibold text-slate-900 dark:text-white">
                    {t('inv.transferTitle')}
                  </h3>
                </div>
                <span className="text-xs font-mono text-slate-500">
                  {t('inv.availableSource')}:{' '}
                  <strong className="text-slate-900 dark:text-white">
                    {selectedTransferStock.bags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'} ·{' '}
                    {availableInSourceKg.toLocaleString('en-IN', { maximumFractionDigits: 2 })} {t('common.kg')}
                  </strong>
                </span>
              </div>

              {/* Row 1: From Warehouse, To Warehouse, Product */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium mb-1">{t('inv.fromWarehouse')}</label>
                  <select
                    value={trForm.from_warehouse_id}
                    onChange={(e) => handleTransferFromWarehouseChange(Number(e.target.value))}
                    className="w-full min-h-[42px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {activeWarehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('inv.toWarehouse')}</label>
                  <select
                    value={trForm.to_warehouse_id}
                    onChange={(e) => setTrForm({ ...trForm, to_warehouse_id: Number(e.target.value) })}
                    className="w-full min-h-[42px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {activeWarehouses.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">{t('inv.product')}</label>
                  <select
                    value={trForm.item_id}
                    onChange={(e) => setTrForm({ ...trForm, item_id: Number(e.target.value) })}
                    className="w-full min-h-[42px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  >
                    {activeItems.map((i) => {
                      const st = itemStockMap.get(`${trForm.from_warehouse_id}-${i.id}`);
                      const stockLabel =
                        st && st.weightKg > 0
                          ? ` (${st.bags} ${isBn ? 'বস্তা' : 'bags'} · ${st.weightKg.toLocaleString()} kg)`
                          : '';
                      return (
                        <option key={i.id} value={i.id}>
                          {i.name} ({i.sku}){stockLabel}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>

              {/* Row 2: Going Bags, Going Weight, Divisor, Costing */}
              <div className={`grid grid-cols-1 ${hideFinancials ? 'md:grid-cols-3' : 'md:grid-cols-4'} gap-4 items-end`}>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs font-medium">
                      {isBn ? 'যত বস্তা যাচ্ছে (বস্তা সংখ্যা)' : 'Going Bags Count'}
                    </label>
                    {selectedTransferStock.bags > 0 && (
                      <button
                        type="button"
                        onClick={handleFillAllTransferStock}
                        className="text-[11px] font-medium text-amber-700 dark:text-amber-400 hover:underline"
                      >
                        {isBn ? `সব (${selectedTransferStock.bags})` : `All (${selectedTransferStock.bags})`}
                      </button>
                    )}
                  </div>
                  <input
                    type="number"
                    required
                    min="1"
                    value={trForm.bag_count}
                    onChange={(e) => handleTransferBagChange(Number(e.target.value))}
                    className="w-full min-h-[42px] px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {isBn ? 'যত ওজন যাচ্ছে (কেজি)' : t('inv.transferWeight')}
                  </label>
                  <input
                    type="number"
                    required
                    min="1"
                    step="0.01"
                    value={trForm.qty_kg}
                    onChange={(e) => setTrForm({ ...trForm, qty_kg: Number(e.target.value) })}
                    className="w-full min-h-[42px] px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {isBn ? 'ডিভাইজর (৭৫.৫)' : 'Unit Divisor (75.5)'}
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    min="1"
                    value={trForm.unit_divisor}
                    onChange={(e) => setTrForm({ ...trForm, unit_divisor: Number(e.target.value) || 75.5 })}
                    className="w-full min-h-[42px] px-3 py-2 text-xs font-mono rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                {!hideFinancials && (
                  <div>
                    <label className="block text-xs font-medium mb-1">{t('inv.costingMethod')}</label>
                    <select
                      value={trForm.costing_method}
                      onChange={(e) => setTrForm({ ...trForm, costing_method: e.target.value as CostingMethod })}
                      className="w-full min-h-[42px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                    >
                      <option value="FIFO">FIFO (First-In, First-Out)</option>
                      <option value="WEIGHTED_AVERAGE">Weighted Average</option>
                    </select>
                  </div>
                )}
              </div>

              {/* Live Formula Calculation Card */}
              <div className="rounded-xl border border-amber-200 dark:border-amber-900/60 bg-amber-50/70 dark:bg-amber-950/30 p-4">
                <div className={`grid grid-cols-2 ${hideFinancials ? 'md:grid-cols-3' : 'md:grid-cols-5'} gap-4 text-xs`}>
                  <div>
                    <div className="text-slate-500 dark:text-slate-400">
                      {isBn ? 'প্রেরক গুদামে বর্তমান মজুদ' : 'Source Godown Available'}
                    </div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                      {selectedTransferStock.bags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'} ·{' '}
                      {selectedTransferStock.weightKg.toLocaleString('en-IN', { maximumFractionDigits: 2 })} kg
                    </div>
                    {!hideFinancials && (
                      <div className="font-mono text-[11px] text-slate-500">
                        {isBn ? 'মোট মূল্য:' : 'Value:'} ৳
                        {selectedTransferStock.value.toLocaleString('en-IN', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="text-slate-500 dark:text-slate-400">
                      {isBn
                        ? `মজুদ একক = (ওজন−বস্তা)÷${selectedTransferStock.safeDiv}`
                        : `Stock Units (Wt−Bags)÷${selectedTransferStock.safeDiv}`}
                    </div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                      {selectedTransferStock.stockNetUnits.toLocaleString('en-IN', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </div>
                  </div>
                  {!hideFinancials && (
                    <div>
                      <div className="text-slate-500 dark:text-slate-400">
                        {isBn ? 'বস্তার একক মূল্য (যা আসে)' : 'Bag Unit Rate'}
                      </div>
                      <div className="font-mono font-bold text-amber-700 dark:text-amber-400 mt-0.5">
                        ৳
                        {selectedTransferStock.bagUnitRate.toLocaleString('en-IN', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    </div>
                  )}
                  <div>
                    <div className="text-slate-500 dark:text-slate-400">
                      {isBn
                        ? `যাচ্ছে = (${trForm.qty_kg}−${trForm.bag_count})÷${selectedTransferStock.safeDiv}`
                        : `Going Units (Wt−Bags)÷${selectedTransferStock.safeDiv}`}
                    </div>
                    <div className="font-mono font-semibold text-slate-900 dark:text-white mt-0.5">
                      {transferGoingNetUnits.toLocaleString('en-IN', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 4,
                      })}
                    </div>
                  </div>
                  {!hideFinancials && (
                    <div className="bg-white dark:bg-slate-900 rounded-lg px-3 py-2 border border-amber-300 dark:border-amber-800">
                      <div className="text-[11px] font-medium text-amber-800 dark:text-amber-300">
                        {isBn ? 'মোট স্থানান্তর মূল্য' : 'Total Transfer Value'}
                      </div>
                      <div className="font-mono text-base font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">
                        ৳
                        {estimatedTransferValue.toLocaleString('en-IN', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Row 3: Driver, Notes, Submit */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-end">
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {isBn ? 'গাড়ি / ট্রলি / ড্রাইভার' : 'Vehicle / Trolley / Driver'}
                  </label>
                  <input
                    type="text"
                    placeholder={t('inv.driverNote')}
                    value={trForm.vehicle_or_driver}
                    onChange={(e) => setTrForm({ ...trForm, vehicle_or_driver: e.target.value })}
                    className="w-full min-h-[42px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">
                    {isBn ? 'মন্তব্য (ঐচ্ছিক)' : 'Notes (Optional)'}
                  </label>
                  <input
                    type="text"
                    placeholder={isBn ? 'স্থানান্তর সংক্রান্ত নোট...' : 'Transfer remarks...'}
                    value={trForm.notes}
                    onChange={(e) => setTrForm({ ...trForm, notes: e.target.value })}
                    className="w-full min-h-[42px] px-3 py-2 text-xs rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950"
                  />
                </div>
                <div className="flex justify-end">
                  <button
                    type="submit"
                    className="w-full md:w-auto min-h-[44px] px-5 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium whitespace-nowrap"
                  >
                    {t('inv.executeTransfer')}
                  </button>
                </div>
              </div>
            </form>
          )}

          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-slate-800 dark:text-slate-200">
                {isBn ? 'আন্তঃ-গুদাম স্টক স্থানান্তর তালিকা' : 'Inter-Godown Stock Transfer Log'} ({transfers.length})
              </div>
              <button
                type="button"
                onClick={() =>
                  exportExcelWorkbook(
                    'SonaGrain-Stock-Transfers',
                    [
                      {
                        name: isBn ? 'গুদাম স্থানান্তর' : 'Stock Transfers',
                        rows: transfers.map((tr) => {
                          const bags = Number(tr.bag_count || 0);
                          const div = Number(tr.unit_divisor || 75.5);
                          const netUnits =
                            Number(tr.net_units || 0) > 0
                              ? Number(tr.net_units)
                              : bags > 0 && tr.qty_kg > bags
                                ? Number(((tr.qty_kg - bags) / div).toFixed(4))
                                : 0;
                          const bagRate =
                            Number(tr.bag_unit_rate || 0) > 0
                              ? Number(tr.bag_unit_rate)
                              : netUnits > 0
                                ? Number((tr.total_cost / netUnits).toFixed(2))
                                : 0;
                          const baseRow = {
                            TransferNo: tr.transfer_no,
                            Date: tr.created_at,
                            Item: tr.item_name || '',
                            FromGodown: tr.from_warehouse_name || '',
                            ToGodown: tr.to_warehouse_name || '',
                            GoingBags: bags,
                            GoingWeightKg: tr.qty_kg,
                            Divisor: div,
                            NetUnits: netUnits,
                            VehicleOrDriver: tr.vehicle_or_driver || '',
                            Notes: tr.notes || '',
                          };
                          return hideFinancials
                            ? baseRow
                            : {
                                ...baseRow,
                                BagUnitRateBDT: bagRate,
                                Method: tr.costing_method,
                                TotalValueBDT: tr.total_cost,
                              };
                        }),
                      },
                    ],
                    lang
                  )
                }
                className="min-h-[38px] flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900 dark:bg-amber-600 text-white text-xs font-medium"
              >
                <FileSpreadsheet className="w-3.5 h-3.5" /> {t('common.excel')}
              </button>
            </div>

            {/* Mobile Transfers Card List */}
            <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
              {transfers.length === 0 ? (
                <div className="px-4 py-8 text-center text-xs text-slate-500">{t('inv.noTransfers')}</div>
              ) : (
                transfers.map((tr) => {
                  const bags = Number(tr.bag_count || 0);
                  const div = Number(tr.unit_divisor || 75.5);
                  const netUnits =
                    Number(tr.net_units || 0) > 0
                      ? Number(tr.net_units)
                      : bags > 0 && tr.qty_kg > bags
                        ? (tr.qty_kg - bags) / div
                        : 0;
                  return (
                    <div key={tr.id} className="p-3.5 space-y-1.5 text-xs">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-mono font-semibold text-slate-900 dark:text-white">{tr.transfer_no}</div>
                          <div className="font-medium text-slate-700 dark:text-slate-300">{tr.item_name}</div>
                        </div>
                        <div className="text-right font-mono">
                          <div className="font-semibold text-slate-900 dark:text-white">
                            {bags > 0 ? `${bags} ${isBn ? 'বস্তা · ' : 'b · '}` : ''}
                            {tr.qty_kg.toLocaleString('en-IN')} kg
                          </div>
                          {!hideFinancials && (
                            <div className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400">
                              ৳{tr.total_cost.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="text-[11px] text-slate-600 dark:text-slate-400">
                        {tr.from_warehouse_name} → {tr.to_warehouse_name}
                      </div>
                      <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
                        <span>{String(tr.created_at || '').slice(0, 16)}</span>
                        <span>{netUnits > 0 ? `${netUnits.toFixed(2)} u` : ''}</span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Desktop Transfers Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                    <th className="text-left px-4 py-3 font-medium">{t('inv.transferNo')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('inv.product')}</th>
                    <th className="text-left px-4 py-3 font-medium">{t('inv.fromToWarehouse')}</th>
                    <th className="text-right px-4 py-3 font-medium">
                      {isBn ? 'যাচ্ছে (বস্তা · কেজি)' : 'Going (Bags · kg)'}
                    </th>
                    <th className="text-right px-4 py-3 font-medium">
                      {hideFinancials
                        ? isBn
                          ? '(ওজন−বস্তা)÷৭৫.৫'
                          : 'Net Units'
                        : isBn
                        ? '(ওজন−বস্তা)÷৭৫.৫ ও রেট'
                        : 'Units & Bag Rate'}
                    </th>
                    {!hideFinancials && (
                      <>
                        <th className="text-left px-4 py-3 font-medium">{t('inv.method')}</th>
                        <th className="text-right px-4 py-3 font-medium">{t('inv.transferredValue')}</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {transfers.length === 0 ? (
                    <tr>
                      <td colSpan={hideFinancials ? 5 : 7} className="px-4 py-8 text-center text-slate-500">
                        {t('inv.noTransfers')}
                      </td>
                    </tr>
                  ) : (
                    transfers.map((tr) => {
                      const bags = Number(tr.bag_count || 0);
                      const div = Number(tr.unit_divisor || 75.5);
                      const netUnits =
                        Number(tr.net_units || 0) > 0
                          ? Number(tr.net_units)
                          : bags > 0 && tr.qty_kg > bags
                            ? (tr.qty_kg - bags) / div
                            : 0;
                      const bagRate =
                        Number(tr.bag_unit_rate || 0) > 0
                          ? Number(tr.bag_unit_rate)
                          : netUnits > 0
                            ? tr.total_cost / netUnits
                            : 0;
                      return (
                        <tr key={tr.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                          <td className="px-4 py-3">
                            <div className="font-mono font-medium text-slate-900 dark:text-white">{tr.transfer_no}</div>
                            <div className="text-[11px] font-mono text-slate-400">
                              {String(tr.created_at || '').slice(0, 16)}
                            </div>
                          </td>
                          <td className="px-4 py-3 font-medium text-slate-800 dark:text-slate-200">{tr.item_name}</td>
                          <td className="px-4 py-3">
                            <div>
                              {tr.from_warehouse_name} → {tr.to_warehouse_name}
                            </div>
                            {tr.vehicle_or_driver && (
                              <div className="text-[11px] text-slate-500">{tr.vehicle_or_driver}</div>
                            )}
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            {bags > 0 && (
                              <span className="font-semibold text-slate-900 dark:text-white">
                                {bags.toLocaleString('en-IN')} {isBn ? 'বস্তা' : 'bags'} ·{' '}
                              </span>
                            )}
                            <span>{tr.qty_kg.toLocaleString('en-IN')} kg</span>
                          </td>
                          <td className="px-4 py-3 text-right font-mono tabular-nums text-slate-600 dark:text-slate-300">
                            {netUnits > 0 ? (
                              <div>
                                <div>{netUnits.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                                {!hideFinancials && (
                                  <div className="text-[11px] text-amber-700 dark:text-amber-400">
                                    @ ৳{bagRate.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                  </div>
                                )}
                              </div>
                            ) : (
                              '—'
                            )}
                          </td>
                          {!hideFinancials && (
                            <>
                              <td className="px-4 py-3 font-mono">{tr.costing_method}</td>
                              <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">
                                ৳{tr.total_cost.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </td>
                            </>
                          )}
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

      {/* 3. STOCK LEDGER */}
      {subTab === 'ledger' && (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
          {/* Mobile Ledger Cards */}
          <div className="md:hidden divide-y divide-slate-100 dark:divide-slate-800">
            {ledger.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-slate-500">{t('inv.noLedger')}</div>
            ) : (
              ledger.map((row) => {
                const isIn = Number(row.qty_change_kg) >= 0;
                return (
                  <div key={row.id} className="p-3.5 space-y-1.5 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-mono font-semibold text-slate-900 dark:text-white">
                          {row.lot_code} · {row.movement_type}
                        </div>
                        <div className="text-slate-600 dark:text-slate-300">
                          {row.item_name} ({row.warehouse_name})
                        </div>
                      </div>
                      <div className={`text-right font-mono font-bold ${isIn ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
                        {isIn ? '+' : ''}
                        {Number(row.qty_change_kg).toLocaleString()} kg
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
                      <span>{row.created_at} · {row.employee_name}</span>
                      <span>
                        {t('inv.lotBalance')}: {Number(row.balance_after_kg).toLocaleString()} kg
                      </span>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Desktop Ledger Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-950 text-slate-500 border-b border-slate-200 dark:border-slate-800">
                  <th className="text-left px-4 py-3 font-medium">{t('common.date')}</th>
                  <th className="text-left px-4 py-3 font-medium">{t('inv.movement')}</th>
                  <th className="text-left px-4 py-3 font-medium">{t('inv.lotCode')}</th>
                  <th className="text-left px-4 py-3 font-medium">{t('inv.product')}</th>
                  <th className="text-left px-4 py-3 font-medium">{t('inv.warehouse')}</th>
                  <th className="text-right px-4 py-3 font-medium">{t('inv.qtyDelta')}</th>
                  {!hideFinancials && <th className="text-right px-4 py-3 font-medium">{t('inv.totalValue')}</th>}
                  <th className="text-right px-4 py-3 font-medium">{t('inv.lotBalance')}</th>
                  <th className="text-left px-4 py-3 font-medium">{t('inv.operator')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {ledger.length === 0 ? (
                  <tr>
                    <td colSpan={hideFinancials ? 8 : 9} className="px-4 py-8 text-center text-slate-500">
                      {t('inv.noLedger')}
                    </td>
                  </tr>
                ) : (
                  ledger.map((row) => {
                    const isIn = Number(row.qty_change_kg) >= 0;
                    return (
                      <tr key={row.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/40">
                        <td className="px-4 py-3 font-mono text-slate-500">{row.created_at}</td>
                        <td className="px-4 py-3 font-mono font-medium">{row.movement_type}</td>
                        <td className="px-4 py-3 font-mono">{row.lot_code}</td>
                        <td className="px-4 py-3">{row.item_name}</td>
                        <td className="px-4 py-3 text-slate-600 dark:text-slate-300">{row.warehouse_name}</td>
                        <td
                          className={`px-4 py-3 text-right font-mono tabular-nums font-semibold ${
                            isIn ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'
                          }`}
                        >
                          {isIn ? '+' : ''}
                          {Number(row.qty_change_kg).toLocaleString()}
                        </td>
                        {!hideFinancials && (
                          <td className="px-4 py-3 text-right font-mono tabular-nums">
                            ৳{Number(row.total_cost).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                          </td>
                        )}
                        <td className="px-4 py-3 text-right font-mono tabular-nums">
                          {Number(row.balance_after_kg).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-slate-500">{row.employee_name}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Printable Lot QR Modal */}
      {qrModalLots && qrModalLots.length > 0 && (
        <StockBatchQrModal
          lots={qrModalLots}
          title={qrModalTitle}
          hideFinancials={hideFinancials}
          onClose={() => setQrModalLots(null)}
          onNotify={onNotify}
        />
      )}
    </div>
  );
};
