import crypto from 'crypto';
import { db } from '../db.ts';
import type { CostingMethod } from '../../src/types/erp.ts';

export class InsufficientStockError extends Error {
  availableKg: number;
  requestedKg: number;
  constructor(message: string, availableKg: number, requestedKg: number) {
    super(message);
    this.name = 'InsufficientStockError';
    this.availableKg = availableKg;
    this.requestedKg = requestedKg;
  }
}

export interface ConsumedLotDetail {
  lot_id: number;
  lot_code: string;
  source_type: string;
  source_id: number | null;
  origin_batch_id: number | null;
  chatal_batch_id?: number | null;
  pack_size_kg: number;
  bags_taken: number;
  qty_taken_kg: number;
  unit_cost_per_kg: number;
  cost_amount: number;
}

/**
 * Consumes stock from inventory_lots in an exact, atomic FIFO or WEIGHTED_AVERAGE manner.
 * Prevents stock overselling by rejecting any outflow exceeding available warehouse stock.
 * Supports preferredLotId (direct lot dispatch) or preferredBatchId (specific dryer batch).
 */
export async function consumeWarehouseStock(params: {
  itemId: number;
  warehouseId: number;
  qtyKg: number;
  bagCount?: number;
  preferredLotId?: number;
  preferredBatchId?: number;
  costingMethod: CostingMethod;
  movementType: string;
  referenceType: string;
  referenceId: number;
  employeeId: number;
}): Promise<{ totalCost: number; avgUnitCost: number; consumedLots: ConsumedLotDetail[] }> {
  const {
    itemId,
    warehouseId,
    qtyKg,
    bagCount,
    preferredLotId,
    preferredBatchId,
    costingMethod,
    movementType,
    referenceType,
    referenceId,
    employeeId,
  } = params;
  if (qtyKg <= 0) {
    throw new Error('Quantity must be greater than zero');
  }

  let lots = (await db
    .prepare(
      `SELECT l.*, COALESCE(NULLIF(l.pack_size_kg, 0), NULLIF(i.bag_weight_kg, 0), 50) as resolved_pack_kg
       FROM inventory_lots l
       JOIN items i ON i.id = l.item_id
       WHERE l.item_id = ? AND l.warehouse_id = ? AND l.remaining_qty_kg > 0.0001
       ORDER BY l.received_at ASC, l.id ASC`
    )
    .all(itemId, warehouseId)) as Array<{
    id: number;
    lot_code: string;
    source_type: string;
    source_id: number | null;
    origin_batch_id: number | null;
    chatal_batch_id: number | null;
    remaining_qty_kg: number;
    remaining_bags: number;
    resolved_pack_kg: number;
    unit_cost_per_kg: number;
    version: number;
  }>;

  if (preferredLotId) {
    const specificLot = (await db
      .prepare('SELECT id, weight_pending FROM inventory_lots WHERE id = ? AND item_id = ? AND warehouse_id = ?')
      .get(preferredLotId, itemId, warehouseId)) as { id: number; weight_pending?: number } | undefined;
    if (specificLot && Number(specificLot.weight_pending || 0) === 1) {
      const pendingRes = await consumePendingWeightLot({
        lotId: preferredLotId,
        qtyKg,
        bagCount: bagCount && bagCount > 0 ? Math.round(bagCount) : 0,
        closeLot: false,
        movementType,
        referenceType,
        referenceId,
        employeeId,
      });
      return {
        totalCost: pendingRes.totalCost,
        avgUnitCost: pendingRes.avgUnitCost,
        consumedLots: [pendingRes.consumedLot],
      };
    }
    lots = lots.filter((l) => l.id === preferredLotId);
  } else if (preferredBatchId) {
    lots = lots.sort((a, b) => {
      const aOrigin = a.origin_batch_id ?? (a.source_type === 'PRODUCTION_OUTPUT' ? a.source_id : null);
      const bOrigin = b.origin_batch_id ?? (b.source_type === 'PRODUCTION_OUTPUT' ? b.source_id : null);
      const aMatch = Number(aOrigin) === preferredBatchId ? 0 : 1;
      const bMatch = Number(bOrigin) === preferredBatchId ? 0 : 1;
      return aMatch - bMatch;
    });
  }

  const totalAvailable = lots.reduce((sum, l) => sum + Number(l.remaining_qty_kg), 0);
  if (totalAvailable + 0.0001 < qtyKg) {
    // If no weighed stock (or only pending-weight stock exists) and caller didn't pick a weighed lot, auto-consume oldest open weight_pending lot
    if (!preferredLotId && totalAvailable <= 0.0001) {
      const pendingLot = (await db
        .prepare(
          `SELECT id, remaining_bags FROM inventory_lots
           WHERE item_id = ? AND warehouse_id = ? AND COALESCE(weight_pending, 0) = 1
           ORDER BY received_at ASC, id ASC LIMIT 1`
        )
        .get(itemId, warehouseId)) as { id: number; remaining_bags: number } | undefined;
      if (pendingLot) {
        const exitBags = bagCount && bagCount > 0 ? Math.round(bagCount) : Number(pendingLot.remaining_bags || 0);
        const pendingRes = await consumePendingWeightLot({
          lotId: pendingLot.id,
          qtyKg,
          bagCount: exitBags,
          closeLot: exitBags >= Number(pendingLot.remaining_bags || 0),
          movementType,
          referenceType,
          referenceId,
          employeeId,
        });
        return {
          totalCost: pendingRes.totalCost,
          avgUnitCost: pendingRes.avgUnitCost,
          consumedLots: [pendingRes.consumedLot],
        };
      }
    }

    const itemRow = (await db.prepare('SELECT name FROM items WHERE id = ?').get(itemId)) as { name: string } | undefined;
    const whRow = (await db.prepare('SELECT name FROM warehouses WHERE id = ?').get(warehouseId)) as
      | { name: string }
      | undefined;
    throw new InsufficientStockError(
      `Insufficient stock for ${itemRow?.name ?? 'Item'} in ${whRow?.name ?? 'Warehouse'}: Available ${totalAvailable.toFixed(2)} kg, Requested ${qtyKg.toFixed(2)} kg.`,
      totalAvailable,
      qtyKg
    );
  }

  const totalInventoryValue = lots.reduce(
    (sum, l) => sum + Number(l.remaining_qty_kg) * Number(l.unit_cost_per_kg),
    0
  );
  const weightedAvgRate = totalAvailable > 0 ? totalInventoryValue / totalAvailable : 0;

  let remainingToConsume = qtyKg;
  let remainingBagsToConsume = bagCount && bagCount > 0 ? Math.round(bagCount) : 0;
  let totalCost = 0;
  const consumedLots: ConsumedLotDetail[] = [];

  const updateLotStmt = db.prepare(
    'UPDATE inventory_lots SET remaining_qty_kg = ?, remaining_bags = ?, version = version + 1 WHERE id = ? AND version = ?'
  );
  const insertLedgerStmt = db.prepare(
    `INSERT INTO stock_ledger (
      lot_id, item_id, warehouse_id, movement_type, reference_type, reference_id,
      qty_change_kg, unit_cost_per_kg, total_cost, balance_after_kg, employee_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i];
    if (remainingToConsume <= 0.0001) break;
    const take = Math.min(Number(lot.remaining_qty_kg), remainingToConsume);
    const effectiveRate = costingMethod === 'WEIGHTED_AVERAGE' ? weightedAvgRate : Number(lot.unit_cost_per_kg);
    const lineCost = take * effectiveRate;
    const newRemaining = Math.max(0, Number((Number(lot.remaining_qty_kg) - take).toFixed(4)));

    const curBags = Number(lot.remaining_bags || 0);
    let bagsTaken = 0;
    let newRemainingBags = 0;
    if (curBags > 0) {
      if (bagCount && bagCount > 0) {
        const isLastTake = remainingToConsume - take <= 0.0001 || i === lots.length - 1;
        bagsTaken = isLastTake
          ? Math.min(curBags, remainingBagsToConsume)
          : Math.min(curBags, Math.round((take / qtyKg) * bagCount));
        remainingBagsToConsume = Math.max(0, remainingBagsToConsume - bagsTaken);
        newRemainingBags = newRemaining > 0.0001 ? Math.max(0, curBags - bagsTaken) : 0;
      } else {
        bagsTaken = Math.min(curBags, Math.round((take / Number(lot.remaining_qty_kg)) * curBags));
        newRemainingBags = newRemaining > 0.0001 ? Math.max(0, curBags - bagsTaken) : 0;
      }
    }

    const res = await updateLotStmt.run(newRemaining, newRemainingBags, lot.id, lot.version);
    if (res.changes === 0) {
      throw new Error(`Concurrency conflict on lot ${lot.lot_code}. Please retry.`);
    }

    await insertLedgerStmt.run(
      lot.id,
      itemId,
      warehouseId,
      movementType,
      referenceType,
      referenceId,
      -take,
      effectiveRate,
      lineCost,
      newRemaining,
      employeeId
    );

    consumedLots.push({
      lot_id: lot.id,
      lot_code: lot.lot_code,
      source_type: lot.source_type,
      source_id: lot.source_id,
      origin_batch_id: lot.origin_batch_id ?? (lot.source_type === 'PRODUCTION_OUTPUT' ? lot.source_id : null),
      chatal_batch_id: lot.chatal_batch_id ?? (lot.source_type === 'CHATAL_YARD' ? lot.source_id : null),
      pack_size_kg: Number(lot.resolved_pack_kg || 50),
      bags_taken: bagsTaken,
      qty_taken_kg: take,
      unit_cost_per_kg: effectiveRate,
      cost_amount: lineCost,
    });

    totalCost += lineCost;
    remainingToConsume -= take;
  }

  return {
    totalCost: Number(totalCost.toFixed(2)),
    avgUnitCost: Number((totalCost / qtyKg).toFixed(4)),
    consumedLots,
  };
}

export async function consumePendingWeightLot(params: {
  lotId: number;
  qtyKg: number;
  bagCount: number;
  closeLot?: boolean;
  movementType: string;
  referenceType: string;
  referenceId: number;
  employeeId: number;
}): Promise<{
  totalCost: number;
  avgUnitCost: number;
  extraTornThisExit: number;
  totalExtraTornBags: number;
  closed: boolean;
  consumedLot: ConsumedLotDetail;
}> {
  const { lotId, qtyKg, bagCount, closeLot = false, movementType, referenceType, referenceId, employeeId } = params;
  if (qtyKg <= 0) {
    throw new Error('Exit weight (kg) must be greater than zero');
  }

  const lot = (await db
    .prepare(
      `SELECT l.*, COALESCE(NULLIF(l.pack_size_kg, 0), NULLIF(i.bag_weight_kg, 0), 60) as resolved_pack_kg
       FROM inventory_lots l
       JOIN items i ON i.id = l.item_id
       WHERE l.id = ?`
    )
    .get(lotId)) as
    | {
        id: number;
        lot_code: string;
        item_id: number;
        warehouse_id: number;
        source_type: string;
        source_id: number | null;
        origin_batch_id: number | null;
        chatal_batch_id: number | null;
        initial_bags: number;
        remaining_bags: number;
        resolved_pack_kg: number;
        weight_pending: number;
        pending_cost_total: number;
        dispatched_qty_kg: number;
        dispatched_bags: number;
        extra_torn_bags: number;
        version: number;
      }
    | undefined;

  if (!lot) {
    throw new Error('Selected inventory lot was not found');
  }
  if (Number(lot.weight_pending || 0) !== 1) {
    throw new Error(`Lot ${lot.lot_code} is already weighed or closed`);
  }

  const exitBags = Math.max(0, Math.round(bagCount));
  const curRemBags = Math.max(0, Number(lot.remaining_bags || 0));
  const curPendingCost = Math.max(0, Number(lot.pending_cost_total || 0));
  const extraTornThisExit = exitBags > curRemBags ? exitBags - curRemBags : 0;

  let costAllocated = 0;
  let nextPendingCost = curPendingCost;
  let nextRemBags = curRemBags;
  let nextWeightPending = 1;

  if (closeLot) {
    costAllocated = Number(curPendingCost.toFixed(2));
    nextPendingCost = 0;
    nextRemBags = 0;
    nextWeightPending = 0;
  } else if (curRemBags <= 0 || exitBags >= curRemBags) {
    // All remaining nominal bags are exiting, yet user kept the lot open for any torn-bag sweep-up
    costAllocated = Number(curPendingCost.toFixed(2));
    nextPendingCost = 0;
    nextRemBags = 0;
    nextWeightPending = 1;
  } else {
    const share = exitBags > 0 ? Math.min(1, exitBags / curRemBags) : 0;
    costAllocated = Number((curPendingCost * share).toFixed(2));
    nextPendingCost = Number(Math.max(0, curPendingCost - costAllocated).toFixed(2));
    nextRemBags = Math.max(0, curRemBags - exitBags);
    nextWeightPending = 1;
  }

  const newDispatchedQtyKg = Number((Number(lot.dispatched_qty_kg || 0) + qtyKg).toFixed(3));
  const newDispatchedBags = Number(lot.dispatched_bags || 0) + exitBags;
  const totalExtraTornBags = Math.max(0, newDispatchedBags - Number(lot.initial_bags || 0));
  const effectiveUnitCost = qtyKg > 0 ? Number((costAllocated / qtyKg).toFixed(4)) : 0;

  const upd = await db
    .prepare(
      `UPDATE inventory_lots
       SET remaining_bags = ?, pending_cost_total = ?, dispatched_qty_kg = ?, dispatched_bags = ?,
           extra_torn_bags = ?, weight_pending = ?, version = version + 1
       WHERE id = ? AND version = ?`
    )
    .run(
      nextRemBags,
      nextPendingCost,
      newDispatchedQtyKg,
      newDispatchedBags,
      totalExtraTornBags,
      nextWeightPending,
      lot.id,
      lot.version
    );

  if (upd.changes === 0) {
    throw new Error(`Concurrency conflict on pending-weight lot ${lot.lot_code}. Please retry.`);
  }

  await db
    .prepare(
      `INSERT INTO stock_ledger (
        lot_id, item_id, warehouse_id, movement_type, reference_type, reference_id,
        qty_change_kg, unit_cost_per_kg, total_cost, balance_after_kg, employee_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lot.id,
      lot.item_id,
      lot.warehouse_id,
      movementType,
      referenceType,
      referenceId,
      -qtyKg,
      effectiveUnitCost,
      costAllocated,
      0,
      employeeId
    );

  if (lot.source_type === 'DRYING_OUTPUT' && lot.source_id) {
    const dryRow = (await db
      .prepare('SELECT id, input_qty_kg, input_paddy_cost, fuel_power_cost, labor_cost FROM paddy_drying_batches WHERE id = ?')
      .get(lot.source_id)) as
      | { id: number; input_qty_kg: number; input_paddy_cost: number; fuel_power_cost: number; labor_cost: number }
      | undefined;
    if (dryRow) {
      const totalDryCost = Number(dryRow.input_paddy_cost || 0) + Number(dryRow.fuel_power_cost || 0) + Number(dryRow.labor_cost || 0);
      const moistureLoss = Number((Number(dryRow.input_qty_kg || 0) - newDispatchedQtyKg).toFixed(3));
      const unitCost = newDispatchedQtyKg > 0 ? Number((totalDryCost / newDispatchedQtyKg).toFixed(4)) : 0;
      const nextStatus = nextWeightPending === 0 ? 'COMPLETED' : 'PENDING_WEIGHT';
      await db
        .prepare(
          `UPDATE paddy_drying_batches
           SET output_qty_kg = ?, moisture_loss_kg = ?, dispatched_bags = ?, extra_torn_bags = ?,
               output_unit_cost_per_kg = ?, weight_pending = ?, status = ?
           WHERE id = ?`
        )
        .run(
          newDispatchedQtyKg,
          moistureLoss,
          newDispatchedBags,
          totalExtraTornBags,
          unitCost,
          nextWeightPending,
          nextStatus,
          dryRow.id
        );
    }
  }

  return {
    totalCost: costAllocated,
    avgUnitCost: effectiveUnitCost,
    extraTornThisExit,
    totalExtraTornBags,
    closed: nextWeightPending === 0,
    consumedLot: {
      lot_id: lot.id,
      lot_code: lot.lot_code,
      source_type: lot.source_type,
      source_id: lot.source_id,
      origin_batch_id: lot.origin_batch_id ?? null,
      chatal_batch_id: lot.chatal_batch_id ?? (lot.source_type === 'CHATAL_YARD' ? lot.source_id : null),
      pack_size_kg: Number(lot.resolved_pack_kg || 60),
      bags_taken: exitBags,
      qty_taken_kg: qtyKg,
      unit_cost_per_kg: effectiveUnitCost,
      cost_amount: costAllocated,
    },
  };
}

export async function createInventoryLot(params: {
  prefix: string;
  itemId: number;
  warehouseId: number;
  sourceType: string;
  sourceId: number;
  originBatchId?: number | null;
  chatalBatchId?: number | null;
  qtyKg: number;
  bagCount?: number;
  packSizeKg?: number;
  unitCostPerKg: number;
  moisturePct?: number | null;
  weightPending?: boolean;
  pendingCostTotal?: number;
  movementType: string;
  employeeId: number;
  qrUid?: string;
}): Promise<{ lotId: number; lotCode: string; qrCodeUid: string }> {
  const qrCodeUid = params.qrUid ?? crypto.randomUUID();
  const seqRow = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM inventory_lots').get()) as {
    nextId: number;
  };
  const seq = Number(seqRow.nextId);
  const lotCode = `${params.prefix}-${String(seq).padStart(4, '0')}`;

  const itemInfo = (await db.prepare('SELECT bag_weight_kg FROM items WHERE id = ?').get(params.itemId)) as
    | { bag_weight_kg: number }
    | undefined;
  const bagWeight =
    params.packSizeKg && params.packSizeKg > 0
      ? params.packSizeKg
      : itemInfo?.bag_weight_kg && itemInfo.bag_weight_kg > 0
      ? itemInfo.bag_weight_kg
      : 50;
  const isWeightPending = Boolean(params.weightPending);
  const resolvedBags =
    params.bagCount !== undefined && params.bagCount >= 0
      ? Math.round(params.bagCount)
      : Math.round(params.qtyKg / bagWeight);
  const resolvedOriginBatchId =
    params.originBatchId !== undefined
      ? params.originBatchId
      : params.sourceType === 'PRODUCTION_OUTPUT'
      ? params.sourceId
      : null;
  const resolvedChatalBatchId =
    params.chatalBatchId !== undefined
      ? params.chatalBatchId
      : params.sourceType === 'CHATAL_YARD'
      ? params.sourceId
      : null;
  const effectiveQtyKg = isWeightPending ? 0 : params.qtyKg;
  const pendingCost = isWeightPending ? Number((params.pendingCostTotal || 0).toFixed(2)) : 0;

  const info = await db
    .prepare(
      `INSERT INTO inventory_lots (
        lot_code, qr_code_uid, item_id, warehouse_id, source_type, source_id, origin_batch_id, chatal_batch_id,
        initial_qty_kg, remaining_qty_kg, initial_bags, remaining_bags, pack_size_kg, unit_cost_per_kg,
        moisture_pct, weight_pending, pending_cost_total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lotCode,
      qrCodeUid,
      params.itemId,
      params.warehouseId,
      params.sourceType,
      params.sourceId,
      resolvedOriginBatchId,
      resolvedChatalBatchId,
      effectiveQtyKg,
      effectiveQtyKg,
      resolvedBags,
      resolvedBags,
      bagWeight,
      isWeightPending ? 0 : params.unitCostPerKg,
      params.moisturePct ?? null,
      isWeightPending ? 1 : 0,
      pendingCost
    );

  const lotId = Number(info.lastInsertRowid);
  await db
    .prepare(
      `INSERT INTO stock_ledger (
        lot_id, item_id, warehouse_id, movement_type, reference_type, reference_id,
        qty_change_kg, unit_cost_per_kg, total_cost, balance_after_kg, employee_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      lotId,
      params.itemId,
      params.warehouseId,
      params.movementType,
      params.sourceType,
      params.sourceId,
      effectiveQtyKg,
      isWeightPending ? 0 : params.unitCostPerKg,
      isWeightPending ? pendingCost : Number((effectiveQtyKg * params.unitCostPerKg).toFixed(2)),
      effectiveQtyKg,
      params.employeeId
    );

  return { lotId, lotCode, qrCodeUid };
}

export async function postJournalEntry(params: {
  clientUuid?: string;
  description: string;
  referenceType: string;
  referenceId: number;
  employeeId: number;
  entryDate?: string;
  voucherPrefix?: string;
  lines: Array<{ accountCode: string; debit: number; credit: number; partyId?: number | null }>;
}): Promise<number> {
  const totalDebit = params.lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = params.lines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.05) {
    throw new Error(`Unbalanced journal entry: Debit ${totalDebit.toFixed(2)} != Credit ${totalCredit.toFixed(2)}`);
  }

  const seqRow = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM journal_entries').get()) as {
    nextId: number;
  };
  const seq = Number(seqRow.nextId);
  const prefix = params.voucherPrefix || 'JV';
  const voucherNo = `${prefix}-2026-${String(seq).padStart(4, '0')}`;
  const entryDate = params.entryDate || new Date().toISOString().slice(0, 10);

  const info = await db
    .prepare(
      `INSERT INTO journal_entries (client_uuid, voucher_no, entry_date, description, reference_type, reference_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.clientUuid ?? crypto.randomUUID(),
      voucherNo,
      entryDate,
      params.description,
      params.referenceType,
      params.referenceId,
      params.employeeId
    );

  const jeId = Number(info.lastInsertRowid);
  const getAcc = db.prepare('SELECT id, account_type FROM accounts WHERE account_code = ?');
  const insertLine = db.prepare('INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, party_id) VALUES (?, ?, ?, ?, ?)');
  const updateAcc = db.prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?');

  for (const line of params.lines) {
    if (line.debit === 0 && line.credit === 0) continue;
    const acc = (await getAcc.get(line.accountCode)) as { id: number; account_type: string } | undefined;
    if (!acc) throw new Error(`Account code ${line.accountCode} not found`);

    await insertLine.run(jeId, acc.id, Number(line.debit.toFixed(2)), Number(line.credit.toFixed(2)), line.partyId ?? null);

    // Normal balance rules: Asset/Expense increase with Debit; Liability/Equity/Revenue increase with Credit
    const delta =
      acc.account_type === 'ASSET' || acc.account_type === 'EXPENSE'
        ? line.debit - line.credit
        : line.credit - line.debit;
    await updateAcc.run(Number(delta.toFixed(2)), acc.id);
  }

  return jeId;
}

export async function writeAuditLog(params: {
  employeeId?: number | null;
  employeeName: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeObj?: unknown;
  afterObj?: unknown;
  ipAddress?: string;
  deviceType?: string;
}): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_logs (employee_id, employee_name, action, entity_type, entity_id, before_json, after_json, ip_address, device_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.employeeId ?? null,
      params.employeeName,
      params.action,
      params.entityType,
      params.entityId,
      params.beforeObj ? JSON.stringify(params.beforeObj) : null,
      params.afterObj ? JSON.stringify(params.afterObj) : null,
      params.ipAddress ?? '127.0.0.1',
      params.deviceType ?? 'WEB_PWA'
    );
}

export async function registerQrTag(params: {
  qrCodeUid: string;
  entityType: string;
  entityId: number;
  entityCode: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO qr_tags (qr_code_uid, entity_type, entity_id, entity_code, payload_json)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(params.qrCodeUid, params.entityType, params.entityId, params.entityCode, JSON.stringify(params.payload));
}

export async function checkIdempotency(
  clientUuid: string | undefined
): Promise<{ duplicate: boolean; cachedResponse?: unknown }> {
  if (!clientUuid) return { duplicate: false };
  const row = (await db
    .prepare('SELECT status, response_json FROM sync_logs WHERE client_uuid = ?')
    .get(clientUuid)) as { status: string; response_json: string | null } | undefined;
  if (row && (row.status === 'SYNCED' || row.status === 'DUPLICATE_SKIPPED')) {
    return {
      duplicate: true,
      cachedResponse: row.response_json ? JSON.parse(row.response_json) : { status: 'ALREADY_SYNCED', client_uuid: clientUuid },
    };
  }
  return { duplicate: false };
}

export async function recordSyncLog(params: {
  clientUuid: string;
  deviceId: string;
  clientType: 'WEB_PWA' | 'ANDROID_APP';
  endpoint: string;
  status: 'SYNCED' | 'DUPLICATE_SKIPPED' | 'CONFLICT' | 'FAILED';
  conflictReason?: string;
  responseObj?: unknown;
  employeeId: number;
}): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO sync_logs (client_uuid, device_id, client_type, endpoint, status, conflict_reason, response_json, employee_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.clientUuid,
      params.deviceId,
      params.clientType,
      params.endpoint,
      params.status,
      params.conflictReason ?? null,
      params.responseObj ? JSON.stringify(params.responseObj) : null,
      params.employeeId
    );
}
