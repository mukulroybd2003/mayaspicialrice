<?php
declare(strict_types=1);

namespace SonaGrain;

use PDO;
use RuntimeException;

final class InsufficientStockException extends RuntimeException
{
}

final class ErpEngine
{
    public static function uuidV4(): string
    {
        $bytes    = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }

    public static function runInTransaction(PDO $pdo, callable $fn): mixed
    {
        if ($pdo->inTransaction()) {
            return $fn();
        }
        $pdo->beginTransaction();
        try {
            $res = $fn();
            if ($pdo->inTransaction()) {
                $pdo->commit();
            }
            return $res;
        } catch (\Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }
    }

    public static function checkIdempotency(PDO $pdo, ?string $clientUuid): ?array
    {
        if (!$clientUuid) {
            return null;
        }
        $stmt = $pdo->prepare('SELECT status, response_json FROM sync_logs WHERE client_uuid = ? LIMIT 1');
        $stmt->execute([$clientUuid]);
        $row = $stmt->fetch();
        if ($row && in_array($row['status'], ['SYNCED', 'DUPLICATE_SKIPPED'], true)) {
            return $row['response_json']
                ? json_decode((string)$row['response_json'], true)
                : ['status' => 'ALREADY_SYNCED', 'client_uuid' => $clientUuid];
        }
        return null;
    }

    public static function recordSyncLog(
        PDO $pdo,
        string $clientUuid,
        string $deviceId,
        string $clientType,
        string $endpoint,
        string $status,
        ?string $conflictReason,
        ?array $responseObj,
        int $employeeId
    ): void {
        $stmt = $pdo->prepare(
            'INSERT INTO sync_logs (client_uuid, device_id, client_type, endpoint, status, conflict_reason, response_json, employee_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE status = VALUES(status), conflict_reason = VALUES(conflict_reason), response_json = VALUES(response_json)'
        );
        $stmt->execute([
            $clientUuid,
            $deviceId,
            $clientType,
            $endpoint,
            $status,
            $conflictReason,
            $responseObj !== null ? json_encode($responseObj, JSON_UNESCAPED_UNICODE) : null,
            $employeeId,
        ]);
    }

    /**
     * Exact parity with server/services/erpEngine.ts consumeWarehouseStock
     * Params: itemId, warehouseId, qtyKg, bagCount?, preferredLotId?, preferredBatchId?,
     *         costingMethod, movementType, referenceType, referenceId, employeeId
     */
    public static function consumeWarehouseStock(PDO $pdo, array $params): array
    {
        $itemId           = (int)$params['itemId'];
        $warehouseId      = (int)$params['warehouseId'];
        $qtyKg            = (float)$params['qtyKg'];
        $bagCount         = isset($params['bagCount']) && (int)$params['bagCount'] > 0 ? (int)round((float)$params['bagCount']) : null;
        $preferredLotId   = isset($params['preferredLotId']) && (int)$params['preferredLotId'] > 0 ? (int)$params['preferredLotId'] : null;
        $preferredBatchId = isset($params['preferredBatchId']) && (int)$params['preferredBatchId'] > 0 ? (int)$params['preferredBatchId'] : null;
        $costingMethod    = (string)($params['costingMethod'] ?? 'FIFO');
        $movementType     = (string)$params['movementType'];
        $referenceType    = (string)$params['referenceType'];
        $referenceId      = (int)$params['referenceId'];
        $employeeId       = (int)$params['employeeId'];

        if ($qtyKg <= 0) {
            throw new RuntimeException('Quantity must be greater than zero');
        }

        $stmt = $pdo->prepare(
            'SELECT l.*, COALESCE(NULLIF(l.pack_size_kg, 0), NULLIF(i.bag_weight_kg, 0), 50) AS resolved_pack_kg
             FROM inventory_lots l
             JOIN items i ON i.id = l.item_id
             WHERE l.item_id = ? AND l.warehouse_id = ? AND l.remaining_qty_kg > 0.0001
             ORDER BY l.received_at ASC, l.id ASC
             FOR UPDATE'
        );
        $stmt->execute([$itemId, $warehouseId]);
        $lots = $stmt->fetchAll();

        if ($preferredLotId !== null) {
            $pStmt = $pdo->prepare('SELECT id, weight_pending FROM inventory_lots WHERE id = ? AND item_id = ? AND warehouse_id = ?');
            $pStmt->execute([$preferredLotId, $itemId, $warehouseId]);
            $pRow = $pStmt->fetch();
            if ($pRow && (int)($pRow['weight_pending'] ?? 0) === 1) {
                $pendingRes = self::consumePendingWeightLot($pdo, [
                    'lotId'         => $preferredLotId,
                    'qtyKg'         => $qtyKg,
                    'bagCount'      => $bagCount ?? 0,
                    'closeLot'      => false,
                    'movementType'  => $movementType,
                    'referenceType' => $referenceType,
                    'referenceId'   => $referenceId,
                    'employeeId'    => $employeeId,
                ]);
                return [
                    'totalCost'    => $pendingRes['totalCost'],
                    'avgUnitCost'  => $pendingRes['avgUnitCost'],
                    'consumedLots' => [$pendingRes['consumedLot']],
                ];
            }
            $lots = array_values(array_filter($lots, static fn(array $l): bool => (int)$l['id'] === $preferredLotId));
        } elseif ($preferredBatchId !== null) {
            usort($lots, static function (array $a, array $b) use ($preferredBatchId): int {
                $aOrigin = $a['origin_batch_id'] ?? ($a['source_type'] === 'PRODUCTION_OUTPUT' ? $a['source_id'] : null);
                $bOrigin = $b['origin_batch_id'] ?? ($b['source_type'] === 'PRODUCTION_OUTPUT' ? $b['source_id'] : null);
                $aMatch  = (int)$aOrigin === $preferredBatchId ? 0 : 1;
                $bMatch  = (int)$bOrigin === $preferredBatchId ? 0 : 1;
                return $aMatch <=> $bMatch;
            });
        }

        $totalAvailable = 0.0;
        $totalValue     = 0.0;
        foreach ($lots as $l) {
            $q = (float)$l['remaining_qty_kg'];
            $totalAvailable += $q;
            $totalValue     += $q * (float)$l['unit_cost_per_kg'];
        }

        if ($totalAvailable + 0.0001 < $qtyKg) {
            if ($preferredLotId === null && $totalAvailable <= 0.0001) {
                $pendStmt = $pdo->prepare(
                    'SELECT id, remaining_bags FROM inventory_lots
                     WHERE item_id = ? AND warehouse_id = ? AND COALESCE(weight_pending, 0) = 1
                     ORDER BY received_at ASC, id ASC LIMIT 1 FOR UPDATE'
                );
                $pendStmt->execute([$itemId, $warehouseId]);
                $pendLot = $pendStmt->fetch();
                if ($pendLot) {
                    $exitBags   = $bagCount ?? (int)$pendLot['remaining_bags'];
                    $pendingRes = self::consumePendingWeightLot($pdo, [
                        'lotId'         => (int)$pendLot['id'],
                        'qtyKg'         => $qtyKg,
                        'bagCount'      => $exitBags,
                        'closeLot'      => $exitBags >= (int)$pendLot['remaining_bags'],
                        'movementType'  => $movementType,
                        'referenceType' => $referenceType,
                        'referenceId'   => $referenceId,
                        'employeeId'    => $employeeId,
                    ]);
                    return [
                        'totalCost'    => $pendingRes['totalCost'],
                        'avgUnitCost'  => $pendingRes['avgUnitCost'],
                        'consumedLots' => [$pendingRes['consumedLot']],
                    ];
                }
            }
            $iStmt = $pdo->prepare('SELECT name FROM items WHERE id = ?');
            $iStmt->execute([$itemId]);
            $itemName = $iStmt->fetchColumn() ?: 'Item';

            $wStmt = $pdo->prepare('SELECT name FROM warehouses WHERE id = ?');
            $wStmt->execute([$warehouseId]);
            $whName = $wStmt->fetchColumn() ?: 'Warehouse';

            throw new InsufficientStockException(
                sprintf(
                    'Insufficient stock for %s in %s: Available %.2f kg, Requested %.2f kg.',
                    $itemName,
                    $whName,
                    $totalAvailable,
                    $qtyKg
                )
            );
        }

        $weightedAvgRate        = $totalAvailable > 0 ? $totalValue / $totalAvailable : 0.0;
        $remainingToConsume     = $qtyKg;
        $remainingBagsToConsume = $bagCount ?? 0;
        $totalCost              = 0.0;
        $consumedLots           = [];

        $updLot = $pdo->prepare(
            'UPDATE inventory_lots SET remaining_qty_kg = ?, remaining_bags = ?, version = version + 1 WHERE id = ? AND version = ?'
        );
        $insLed = $pdo->prepare(
            'INSERT INTO stock_ledger (
                lot_id, item_id, warehouse_id, movement_type, reference_type, reference_id,
                qty_change_kg, unit_cost_per_kg, total_cost, balance_after_kg, employee_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );

        $lotCount = count($lots);
        for ($i = 0; $i < $lotCount; $i++) {
            if ($remainingToConsume <= 0.0001) {
                break;
            }
            $lot        = $lots[$i];
            $lotAvail   = (float)$lot['remaining_qty_kg'];
            $take       = min($lotAvail, $remainingToConsume);
            $rate       = $costingMethod === 'WEIGHTED_AVERAGE' ? $weightedAvgRate : (float)$lot['unit_cost_per_kg'];
            $lineCost   = $take * $rate;
            $newRem     = max(0.0, round($lotAvail - $take, 4));
            $curBags    = (int)($lot['remaining_bags'] ?? 0);
            $bagsTaken  = 0;
            $newRemBags = 0;

            if ($curBags > 0) {
                if ($bagCount !== null && $bagCount > 0) {
                    $isLastTake = ($remainingToConsume - $take <= 0.0001) || ($i === $lotCount - 1);
                    $bagsTaken  = $isLastTake
                        ? min($curBags, $remainingBagsToConsume)
                        : min($curBags, (int)round(($take / $qtyKg) * $bagCount));
                    $remainingBagsToConsume = max(0, $remainingBagsToConsume - $bagsTaken);
                    $newRemBags = $newRem > 0.0001 ? max(0, $curBags - $bagsTaken) : 0;
                } else {
                    $bagsTaken  = min($curBags, (int)round(($take / $lotAvail) * $curBags));
                    $newRemBags = $newRem > 0.0001 ? max(0, $curBags - $bagsTaken) : 0;
                }
            }

            $updLot->execute([$newRem, $newRemBags, (int)$lot['id'], (int)$lot['version']]);
            if ($updLot->rowCount() === 0) {
                throw new RuntimeException("Concurrency conflict on lot {$lot['lot_code']}. Please retry.");
            }

            $insLed->execute([
                (int)$lot['id'],
                $itemId,
                $warehouseId,
                $movementType,
                $referenceType,
                $referenceId,
                -$take,
                $rate,
                round($lineCost, 2),
                $newRem,
                $employeeId,
            ]);

            $originBatchId = $lot['origin_batch_id'] !== null
                ? (int)$lot['origin_batch_id']
                : ($lot['source_type'] === 'PRODUCTION_OUTPUT' && $lot['source_id'] !== null ? (int)$lot['source_id'] : null);

            $consumedLots[] = [
                'lot_id'           => (int)$lot['id'],
                'lot_code'         => $lot['lot_code'],
                'source_type'      => $lot['source_type'],
                'source_id'        => $lot['source_id'] !== null ? (int)$lot['source_id'] : null,
                'origin_batch_id'  => $originBatchId,
                'pack_size_kg'     => (float)($lot['resolved_pack_kg'] ?: 50),
                'bags_taken'       => $bagsTaken,
                'qty_taken_kg'     => $take,
                'unit_cost_per_kg' => $rate,
                'cost_amount'      => $lineCost,
            ];

            $totalCost          += $lineCost;
            $remainingToConsume -= $take;
        }

        return [
            'totalCost'    => round($totalCost, 2),
            'avgUnitCost'  => round($totalCost / $qtyKg, 4),
            'consumedLots' => $consumedLots,
        ];
    }

    public static function consumePendingWeightLot(PDO $pdo, array $params): array
    {
        $lotId         = (int)$params['lotId'];
        $qtyKg         = (float)$params['qtyKg'];
        $exitBags      = max(0, (int)round((float)($params['bagCount'] ?? 0)));
        $closeLot      = !empty($params['closeLot']);
        $movementType  = (string)$params['movementType'];
        $referenceType = (string)$params['referenceType'];
        $referenceId   = (int)$params['referenceId'];
        $employeeId    = (int)$params['employeeId'];

        if ($qtyKg <= 0) {
            throw new RuntimeException('Exit weight (kg) must be greater than zero');
        }

        $stmt = $pdo->prepare(
            'SELECT l.*, COALESCE(NULLIF(l.pack_size_kg, 0), NULLIF(i.bag_weight_kg, 0), 60) AS resolved_pack_kg
             FROM inventory_lots l
             JOIN items i ON i.id = l.item_id
             WHERE l.id = ? FOR UPDATE'
        );
        $stmt->execute([$lotId]);
        $lot = $stmt->fetch();
        if (!$lot) {
            throw new RuntimeException('Selected inventory lot was not found');
        }
        if ((int)($lot['weight_pending'] ?? 0) !== 1) {
            throw new RuntimeException("Lot {$lot['lot_code']} is already weighed or closed");
        }

        $curRemBags        = max(0, (int)($lot['remaining_bags'] ?? 0));
        $curPendingCost    = max(0.0, (float)($lot['pending_cost_total'] ?? 0));
        $extraTornThisExit = $exitBags > $curRemBags ? $exitBags - $curRemBags : 0;

        if ($closeLot) {
            $costAllocated     = round($curPendingCost, 2);
            $nextPendingCost   = 0.0;
            $nextRemBags       = 0;
            $nextWeightPending = 0;
        } elseif ($curRemBags <= 0 || $exitBags >= $curRemBags) {
            $costAllocated     = round($curPendingCost, 2);
            $nextPendingCost   = 0.0;
            $nextRemBags       = 0;
            $nextWeightPending = 1;
        } else {
            $share             = $exitBags > 0 ? min(1.0, $exitBags / $curRemBags) : 0.0;
            $costAllocated     = round($curPendingCost * $share, 2);
            $nextPendingCost   = round(max(0.0, $curPendingCost - $costAllocated), 2);
            $nextRemBags       = max(0, $curRemBags - $exitBags);
            $nextWeightPending = 1;
        }

        $newDispatchedQtyKg = round((float)($lot['dispatched_qty_kg'] ?? 0) + $qtyKg, 3);
        $newDispatchedBags  = (int)($lot['dispatched_bags'] ?? 0) + $exitBags;
        $totalExtraTornBags = max(0, $newDispatchedBags - (int)($lot['initial_bags'] ?? 0));
        $effectiveUnitCost  = $qtyKg > 0 ? round($costAllocated / $qtyKg, 4) : 0.0;

        $upd = $pdo->prepare(
            'UPDATE inventory_lots
             SET remaining_bags = ?, pending_cost_total = ?, dispatched_qty_kg = ?, dispatched_bags = ?,
                 extra_torn_bags = ?, weight_pending = ?, version = version + 1
             WHERE id = ? AND version = ?'
        );
        $upd->execute([
            $nextRemBags,
            $nextPendingCost,
            $newDispatchedQtyKg,
            $newDispatchedBags,
            $totalExtraTornBags,
            $nextWeightPending,
            (int)$lot['id'],
            (int)$lot['version'],
        ]);
        if ($upd->rowCount() === 0) {
            throw new RuntimeException("Concurrency conflict on pending-weight lot {$lot['lot_code']}. Please retry.");
        }

        $pdo->prepare(
            'INSERT INTO stock_ledger (
                lot_id, item_id, warehouse_id, movement_type, reference_type, reference_id,
                qty_change_kg, unit_cost_per_kg, total_cost, balance_after_kg, employee_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)'
        )->execute([
            (int)$lot['id'],
            (int)$lot['item_id'],
            (int)$lot['warehouse_id'],
            $movementType,
            $referenceType,
            $referenceId,
            -$qtyKg,
            $effectiveUnitCost,
            $costAllocated,
            $employeeId,
        ]);

        if ($lot['source_type'] === 'DRYING_OUTPUT' && $lot['source_id'] !== null) {
            $dStmt = $pdo->prepare('SELECT id, input_qty_kg, input_paddy_cost, fuel_power_cost, labor_cost FROM paddy_drying_batches WHERE id = ?');
            $dStmt->execute([(int)$lot['source_id']]);
            $dryRow = $dStmt->fetch();
            if ($dryRow) {
                $totalDryCost = (float)$dryRow['input_paddy_cost'] + (float)$dryRow['fuel_power_cost'] + (float)$dryRow['labor_cost'];
                $moistureLoss = round((float)$dryRow['input_qty_kg'] - $newDispatchedQtyKg, 3);
                $unitCost     = $newDispatchedQtyKg > 0 ? round($totalDryCost / $newDispatchedQtyKg, 4) : 0.0;
                $nextStatus   = $nextWeightPending === 0 ? 'COMPLETED' : 'PENDING_WEIGHT';
                $pdo->prepare(
                    'UPDATE paddy_drying_batches
                     SET output_qty_kg = ?, moisture_loss_kg = ?, dispatched_bags = ?, extra_torn_bags = ?,
                         output_unit_cost_per_kg = ?, weight_pending = ?, status = ?
                     WHERE id = ?'
                )->execute([
                    $newDispatchedQtyKg,
                    $moistureLoss,
                    $newDispatchedBags,
                    $totalExtraTornBags,
                    $unitCost,
                    $nextWeightPending,
                    $nextStatus,
                    (int)$dryRow['id'],
                ]);
            }
        }

        return [
            'totalCost'          => $costAllocated,
            'avgUnitCost'        => $effectiveUnitCost,
            'extraTornThisExit'  => $extraTornThisExit,
            'totalExtraTornBags' => $totalExtraTornBags,
            'closed'             => $nextWeightPending === 0,
            'consumedLot'        => [
                'lot_id'           => (int)$lot['id'],
                'lot_code'         => $lot['lot_code'],
                'source_type'      => $lot['source_type'],
                'source_id'        => $lot['source_id'] !== null ? (int)$lot['source_id'] : null,
                'origin_batch_id'  => $lot['origin_batch_id'] !== null ? (int)$lot['origin_batch_id'] : null,
                'pack_size_kg'     => (float)($lot['resolved_pack_kg'] ?: 60),
                'bags_taken'       => $exitBags,
                'qty_taken_kg'     => $qtyKg,
                'unit_cost_per_kg' => $effectiveUnitCost,
                'cost_amount'      => $costAllocated,
            ],
        ];
    }

    /**
     * Exact parity with server/services/erpEngine.ts createInventoryLot
     */
    public static function createInventoryLot(PDO $pdo, array $params): array
    {
        $qrCodeUid    = !empty($params['qrUid']) ? (string)$params['qrUid'] : self::uuidV4();
        $seq          = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM inventory_lots')->fetchColumn();
        $lotCode      = $params['prefix'] . '-' . str_pad((string)$seq, 4, '0', STR_PAD_LEFT);
        $itemId       = (int)$params['itemId'];
        $warehouseId  = (int)$params['warehouseId'];
        $sourceType   = (string)$params['sourceType'];
        $sourceId     = (int)$params['sourceId'];
        $qtyKg        = (float)$params['qtyKg'];
        $unitCost     = (float)$params['unitCostPerKg'];
        $moisturePct  = isset($params['moisturePct']) && $params['moisturePct'] !== null ? (float)$params['moisturePct'] : null;
        $movementType = (string)$params['movementType'];
        $employeeId   = (int)$params['employeeId'];

        $iStmt = $pdo->prepare('SELECT bag_weight_kg FROM items WHERE id = ?');
        $iStmt->execute([$itemId]);
        $itemBagWt = (float)($iStmt->fetchColumn() ?: 0);

        $packSizeKg = !empty($params['packSizeKg']) && (float)$params['packSizeKg'] > 0
            ? (float)$params['packSizeKg']
            : ($itemBagWt > 0 ? $itemBagWt : 50.0);

        $isWeightPending = !empty($params['weightPending']);
        $resolvedBags    = array_key_exists('bagCount', $params) && $params['bagCount'] !== null && (int)$params['bagCount'] >= 0
            ? (int)round((float)$params['bagCount'])
            : (int)round($qtyKg / $packSizeKg);

        $originBatchId = array_key_exists('originBatchId', $params)
            ? ($params['originBatchId'] !== null ? (int)$params['originBatchId'] : null)
            : ($sourceType === 'PRODUCTION_OUTPUT' ? $sourceId : null);

        $effectiveQtyKg = $isWeightPending ? 0.0 : $qtyKg;
        $pendingCost    = $isWeightPending ? round((float)($params['pendingCostTotal'] ?? 0), 2) : 0.0;
        $effUnitCost    = $isWeightPending ? 0.0 : $unitCost;

        $ins = $pdo->prepare(
            'INSERT INTO inventory_lots (
                lot_code, qr_code_uid, item_id, warehouse_id, source_type, source_id, origin_batch_id,
                initial_qty_kg, remaining_qty_kg, initial_bags, remaining_bags, pack_size_kg, unit_cost_per_kg,
                moisture_pct, weight_pending, pending_cost_total
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $ins->execute([
            $lotCode,
            $qrCodeUid,
            $itemId,
            $warehouseId,
            $sourceType,
            $sourceId,
            $originBatchId,
            $effectiveQtyKg,
            $effectiveQtyKg,
            $resolvedBags,
            $resolvedBags,
            $packSizeKg,
            $effUnitCost,
            $moisturePct,
            $isWeightPending ? 1 : 0,
            $pendingCost,
        ]);

        $lotId = (int)$pdo->lastInsertId();
        $led = $pdo->prepare(
            'INSERT INTO stock_ledger (
                lot_id, item_id, warehouse_id, movement_type, reference_type, reference_id,
                qty_change_kg, unit_cost_per_kg, total_cost, balance_after_kg, employee_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $led->execute([
            $lotId,
            $itemId,
            $warehouseId,
            $movementType,
            $sourceType,
            $sourceId,
            $effectiveQtyKg,
            $effUnitCost,
            $isWeightPending ? $pendingCost : round($effectiveQtyKg * $effUnitCost, 2),
            $effectiveQtyKg,
            $employeeId,
        ]);

        return [
            'lotId'     => $lotId,
            'lotCode'   => $lotCode,
            'qrCodeUid' => $qrCodeUid,
        ];
    }

    public static function postJournalEntry(PDO $pdo, array $params): int
    {
        $lines       = $params['lines'] ?? [];
        $totalDebit  = 0.0;
        $totalCredit = 0.0;
        foreach ($lines as $l) {
            $totalDebit  += (float)($l['debit'] ?? 0);
            $totalCredit += (float)($l['credit'] ?? 0);
        }
        if (abs($totalDebit - $totalCredit) > 0.05) {
            throw new RuntimeException(sprintf('Unbalanced journal entry: Debit %.2f != Credit %.2f', $totalDebit, $totalCredit));
        }

        $seq       = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM journal_entries')->fetchColumn();
        $prefix    = !empty($params['voucherPrefix']) ? (string)$params['voucherPrefix'] : 'JV';
        $voucherNo = $prefix . '-2026-' . str_pad((string)$seq, 4, '0', STR_PAD_LEFT);
        $entryDate = !empty($params['entryDate']) ? (string)$params['entryDate'] : gmdate('Y-m-d');
        $clientUuid = !empty($params['clientUuid']) ? (string)$params['clientUuid'] : self::uuidV4();

        $insJe = $pdo->prepare(
            'INSERT INTO journal_entries (client_uuid, voucher_no, entry_date, description, reference_type, reference_id, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        $insJe->execute([
            $clientUuid,
            $voucherNo,
            $entryDate,
            (string)$params['description'],
            (string)$params['referenceType'],
            (int)$params['referenceId'],
            (int)$params['employeeId'],
        ]);
        $jeId = (int)$pdo->lastInsertId();

        $getAcc = $pdo->prepare('SELECT id, account_type FROM accounts WHERE account_code = ?');
        $insJl  = $pdo->prepare('INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, party_id) VALUES (?, ?, ?, ?, ?)');
        $updAcc = $pdo->prepare('UPDATE accounts SET balance = balance + ? WHERE id = ?');

        foreach ($lines as $line) {
            $dr = round((float)($line['debit'] ?? 0), 2);
            $cr = round((float)($line['credit'] ?? 0), 2);
            if ($dr == 0.0 && $cr == 0.0) {
                continue;
            }
            $code = (string)$line['accountCode'];
            $getAcc->execute([$code]);
            $acc = $getAcc->fetch();
            if (!$acc) {
                throw new RuntimeException("Account code {$code} not found");
            }
            $partyId = isset($line['partyId']) && $line['partyId'] !== null ? (int)$line['partyId'] : null;
            $insJl->execute([$jeId, (int)$acc['id'], $dr, $cr, $partyId]);

            $delta = in_array($acc['account_type'], ['ASSET', 'EXPENSE'], true)
                ? ($dr - $cr)
                : ($cr - $dr);
            $updAcc->execute([round($delta, 2), (int)$acc['id']]);
        }

        return $jeId;
    }

    public static function registerQrTag(
        PDO $pdo,
        string $qrCodeUid,
        string $entityType,
        int $entityId,
        string $entityCode,
        array $payload
    ): void {
        $stmt = $pdo->prepare(
            'INSERT INTO qr_tags (qr_code_uid, entity_type, entity_id, entity_code, payload_json)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE entity_type = VALUES(entity_type), entity_id = VALUES(entity_id), entity_code = VALUES(entity_code), payload_json = VALUES(payload_json)'
        );
        $stmt->execute([
            $qrCodeUid,
            $entityType,
            $entityId,
            $entityCode,
            json_encode($payload, JSON_UNESCAPED_UNICODE),
        ]);
    }

    public static function writeAudit(
        PDO $pdo,
        ?int $employeeId,
        string $employeeName,
        string $action,
        string $entityType,
        string $entityId,
        ?array $beforeObj,
        ?array $afterObj,
        string $deviceType = 'WEB_PWA'
    ): void {
        $stmt = $pdo->prepare(
            'INSERT INTO audit_logs (employee_id, employee_name, action, entity_type, entity_id, before_json, after_json, ip_address, device_type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([
            $employeeId,
            $employeeName,
            $action,
            $entityType,
            $entityId,
            $beforeObj !== null ? json_encode($beforeObj, JSON_UNESCAPED_UNICODE) : null,
            $afterObj !== null ? json_encode($afterObj, JSON_UNESCAPED_UNICODE) : null,
            $_SERVER['REMOTE_ADDR'] ?? '127.0.0.1',
            $deviceType,
        ]);
    }
}
