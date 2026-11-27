<?php
declare(strict_types=1);

use SonaGrain\Auth;
use SonaGrain\ErpEngine;
use SonaGrain\InsufficientStockException;

function handleProductionAndSalesRoutes(string $method, string $uri, array $body, PDO $pdo, array $emp, string $clientType): bool
{
    $empId   = (int)$emp['id'];
    $empName = (string)$emp['full_name'];

    $castSalesRow = static function (array $row): array {
        foreach ([
            'bag_count', 'jute_bag_count', 'plastic_bag_count',
            'moisture_pct', 'scale_weight_kg', 'qty_kg', 'payment_weight_kg', 'weight_loss_kg',
            'settlement_unit_kg', 'settlement_rate', 'rate_per_kg', 'total_amount', 'cogs_amount', 'paid_amount',
        ] as $k) {
            if (array_key_exists($k, $row) && $row[$k] !== null) {
                $row[$k] = in_array($k, ['bag_count', 'jute_bag_count', 'plastic_bag_count'], true)
                    ? (int)$row[$k]
                    : (float)$row[$k];
            }
        }
        return $row;
    };

    $getEnrichedProductionBatch = static function (int $batchId) use ($pdo): ?array {
        $bStmt = $pdo->prepare(
            'SELECT b.*, i.name AS paddy_item_name, w.name AS source_warehouse_name
             FROM production_batches b
             JOIN items i ON i.id = b.paddy_item_id
             JOIN warehouses w ON w.id = b.source_warehouse_id
             WHERE b.id = ?'
        );
        $bStmt->execute([$batchId]);
        $b = $bStmt->fetch();
        if (!$b) {
            return null;
        }

        foreach ([
            'input_paddy_qty_kg', 'unit_divisor', 'paddy_net_units', 'paddy_bag_unit_rate', 'paddy_formula_cost',
            'soaking_hours', 'steaming_temp_c', 'head_rice_qty_kg', 'broken_rice_qty_kg', 'bran_qty_kg',
            'husk_qty_kg', 'wastage_qty_kg', 'head_rice_yield_pct', 'total_recovery_pct',
        ] as $k) {
            if (array_key_exists($k, $b) && $b[$k] !== null) {
                $b[$k] = (float)$b[$k];
            }
        }
        foreach (['id', 'source_warehouse_id', 'paddy_item_id', 'input_bag_count', 'dryer_count', 'created_by'] as $k) {
            if (array_key_exists($k, $b) && $b[$k] !== null) {
                $b[$k] = (int)$b[$k];
            }
        }

        $sStmt = $pdo->prepare('SELECT * FROM production_cost_sheets WHERE batch_id = ?');
        $sStmt->execute([$batchId]);
        $sheet = $sStmt->fetch() ?: null;
        if ($sheet) {
            foreach ([
                'raw_paddy_cost', 'labor_cost', 'electricity_cost', 'fuel_boiler_cost',
                'machinery_overhead_cost', 'packaging_cost', 'gross_batch_cost',
                'byproduct_credit_value', 'net_head_rice_cost', 'cost_per_kg_head_rice', 'cost_per_bag_head_rice',
            ] as $k) {
                if (array_key_exists($k, $sheet) && $sheet[$k] !== null) {
                    $sheet[$k] = (float)$sheet[$k];
                }
            }
        }

        $inStmt = $pdo->prepare(
            'SELECT pbi.*, w.name AS warehouse_name, i.name AS item_name, emp.full_name AS created_by_name
             FROM production_batch_inputs pbi
             JOIN warehouses w ON w.id = pbi.source_warehouse_id
             JOIN items i ON i.id = pbi.paddy_item_id
             LEFT JOIN employees emp ON emp.id = pbi.created_by
             WHERE pbi.batch_id = ?
             ORDER BY pbi.id ASC'
        );
        $inStmt->execute([$batchId]);
        $inputLogs = array_map(static function (array $r): array {
            $r['bag_count']     = (int)$r['bag_count'];
            $r['qty_kg']        = (float)$r['qty_kg'];
            $r['unit_divisor']  = (float)$r['unit_divisor'];
            $r['net_units']     = (float)$r['net_units'];
            $r['bag_unit_rate'] = (float)$r['bag_unit_rate'];
            $r['paddy_cost']    = (float)$r['paddy_cost'];
            return $r;
        }, $inStmt->fetchAll());

        $expStmt = $pdo->prepare(
            'SELECT e.*, emp.full_name AS created_by_name
             FROM production_batch_expenses e
             LEFT JOIN employees emp ON emp.id = e.created_by
             WHERE e.batch_id = ?
             ORDER BY e.id DESC'
        );
        $expStmt->execute([$batchId]);
        $expensesRaw = $expStmt->fetchAll();

        $expPayStmt = $pdo->prepare(
            'SELECT pep.*, a.name AS account_name, emp.full_name AS paid_by_name
             FROM production_expense_payments pep
             JOIN accounts a ON a.id = pep.account_id
             LEFT JOIN employees emp ON emp.id = pep.paid_by
             WHERE pep.expense_id = ?
             ORDER BY pep.id DESC'
        );
        $expenseLogs = [];
        foreach ($expensesRaw as $exp) {
            foreach ([
                'labor_cost', 'electricity_cost', 'fuel_boiler_cost', 'machinery_overhead_cost',
                'packaging_cost', 'total_amount', 'paid_amount',
            ] as $k) {
                if (array_key_exists($k, $exp) && $exp[$k] !== null) {
                    $exp[$k] = (float)$exp[$k];
                }
            }
            $expPayStmt->execute([(int)$exp['id']]);
            $pLogs = array_map(static function (array $pl): array {
                $pl['amount'] = (float)$pl['amount'];
                return $pl;
            }, $expPayStmt->fetchAll());
            $exp['payment_logs'] = $pLogs;
            $expenseLogs[] = $exp;
        }

        $recStmt = $pdo->prepare(
            'SELECT pep.*, a.name AS account_name, emp.full_name AS paid_by_name,
                    pbe.expense_category, pbe.vendor_name, pbe.total_amount AS expense_total
             FROM production_expense_payments pep
             JOIN production_batch_expenses pbe ON pbe.id = pep.expense_id
             JOIN accounts a ON a.id = pep.account_id
             LEFT JOIN employees emp ON emp.id = pep.paid_by
             WHERE pep.batch_id = ?
             ORDER BY pep.id DESC'
        );
        $recStmt->execute([$batchId]);
        $expensePaymentReceipts = array_map(static function (array $r): array {
            $r['amount']        = (float)$r['amount'];
            $r['expense_total'] = (float)$r['expense_total'];
            return $r;
        }, $recStmt->fetchAll());

        $outStmt = $pdo->prepare(
            'SELECT po.*, i.name AS item_name, w.name AS warehouse_name, l.lot_code, l.remaining_qty_kg, l.remaining_bags
             FROM production_outputs po
             JOIN items i ON i.id = po.item_id
             JOIN warehouses w ON w.id = po.warehouse_id
             LEFT JOIN inventory_lots l ON l.id = po.lot_id
             WHERE po.batch_id = ?
             ORDER BY po.id ASC'
        );
        $outStmt->execute([$batchId]);
        $outputs = array_map(static function (array $o): array {
            $o['pack_size_kg']               = (float)$o['pack_size_kg'];
            $o['bag_count']                  = (int)$o['bag_count'];
            $o['qty_kg']                     = (float)$o['qty_kg'];
            $o['rate_per_bag']               = (float)$o['rate_per_bag'];
            $o['allocated_unit_cost_per_kg'] = (float)$o['allocated_unit_cost_per_kg'];
            $o['total_value']                = (float)$o['total_value'];
            if ($o['remaining_qty_kg'] !== null) {
                $o['remaining_qty_kg'] = (float)$o['remaining_qty_kg'];
            }
            if ($o['remaining_bags'] !== null) {
                $o['remaining_bags'] = (int)$o['remaining_bags'];
            }
            return $o;
        }, $outStmt->fetchAll());

        $salesStmt = $pdo->prepare(
            'SELECT COALESCE(SUM(qty_kg), 0) AS sold_kg,
                    COALESCE(SUM(bag_count), 0) AS sold_bags,
                    COALESCE(SUM(sale_amount), 0) AS sold_revenue,
                    COALESCE(SUM(cost_amount), 0) AS sold_cogs,
                    COALESCE(SUM(profit_amount), 0) AS realized_profit,
                    COUNT(DISTINCT invoice_id) AS sales_count
             FROM sales_invoice_lot_allocations
             WHERE batch_id = ?'
        );
        $salesStmt->execute([$batchId]);
        $salesAgg = $salesStmt->fetch() ?: [];

        $stockStmt = $pdo->prepare(
            "SELECT COALESCE(SUM(remaining_qty_kg), 0) AS unsold_kg,
                    COALESCE(SUM(remaining_bags), 0) AS unsold_bags,
                    COALESCE(SUM(remaining_qty_kg * unit_cost_per_kg), 0) AS unsold_val
             FROM inventory_lots
             WHERE (origin_batch_id = ? OR (source_type = 'PRODUCTION_OUTPUT' AND source_id = ?))
               AND remaining_qty_kg > 0.0001"
        );
        $stockStmt->execute([$batchId, $batchId]);
        $stockAgg = $stockStmt->fetch() ?: [];

        $totalBatchCost = (float)($sheet['gross_batch_cost'] ?? $b['paddy_formula_cost'] ?? 0);
        $totalExpPaid   = 0.0;
        $totalExpDue    = 0.0;
        foreach ($expensesRaw as $e) {
            $eTot  = (float)($e['total_amount'] ?? 0);
            $ePaid = (float)($e['paid_amount'] ?? $eTot);
            $totalExpPaid += $ePaid;
            $totalExpDue  += max(0.0, $eTot - $ePaid);
        }

        $soldRevenue    = round((float)($salesAgg['sold_revenue'] ?? 0), 2);
        $soldCogs       = round((float)($salesAgg['sold_cogs'] ?? 0), 2);
        $realizedProfit = round((float)($salesAgg['realized_profit'] ?? 0), 2);
        $unsoldVal      = round((float)($stockAgg['unsold_val'] ?? 0), 2);
        $projectedTotal = round($soldRevenue + $unsoldVal, 2);
        $projectedProf  = round($projectedTotal - $totalBatchCost, 2);

        $divisorVal      = ((float)($b['unit_divisor'] ?? 75.5)) > 0 ? (float)$b['unit_divisor'] : 75.5;
        $inputBagsVal    = (float)($b['input_bag_count'] ?? 0);
        $inputPaddyKgVal = (float)($b['input_paddy_qty_kg'] ?? 0);
        $resolvedNetUnits = ((float)($b['paddy_net_units'] ?? 0)) > 0
            ? (float)$b['paddy_net_units']
            : ($inputPaddyKgVal > $inputBagsVal ? round(($inputPaddyKgVal - $inputBagsVal) / $divisorVal, 4) : 0.0);
        $headRiceKgVal = (float)($b['head_rice_qty_kg'] ?? 0);
        $issuePerUnit  = ($resolvedNetUnits > 0 && $headRiceKgVal > 0) ? round($headRiceKgVal / $resolvedNetUnits, 4) : 0.0;

        return array_merge($b, [
            'issue_per_unit'           => $issuePerUnit,
            'cost_sheet'               => $sheet,
            'input_logs'               => $inputLogs,
            'expense_logs'             => $expenseLogs,
            'expense_payment_receipts' => $expensePaymentReceipts,
            'outputs'                  => $outputs,
            'profit_summary'           => [
                'total_batch_cost'          => $totalBatchCost,
                'total_expense_paid'        => round($totalExpPaid, 2),
                'unpaid_expense_due'        => round($totalExpDue, 2),
                'total_sold_kg'             => round((float)($salesAgg['sold_kg'] ?? 0), 2),
                'total_sold_bags'           => (int)($salesAgg['sold_bags'] ?? 0),
                'total_sold_revenue'        => $soldRevenue,
                'total_sold_cogs'           => $soldCogs,
                'realized_profit_loss'      => $realizedProfit,
                'unsold_stock_kg'           => round((float)($stockAgg['unsold_kg'] ?? 0), 2),
                'unsold_stock_bags'         => (int)($stockAgg['unsold_bags'] ?? 0),
                'unsold_stock_value'        => $unsoldVal,
                'projected_total_value'     => $projectedTotal,
                'projected_net_profit_loss' => $projectedProf,
                'sales_count'               => (int)($salesAgg['sales_count'] ?? 0),
            ],
        ]);
    };

    // -----------------------------------------------------------------------
    // 7. Direct Paddy Sales
    // -----------------------------------------------------------------------
    if ($uri === '/api/v1/paddy-sales' && $method === 'GET') {
        Auth::rejectPhysicalOnlyUser($emp);
        $rows = $pdo->query(
            'SELECT ps.*, pt.name AS customer_name, w.name AS warehouse_name, i.name AS item_name
             FROM paddy_sales ps
             JOIN parties pt ON pt.id = ps.customer_id
             JOIN warehouses w ON w.id = ps.warehouse_id
             JOIN items i ON i.id = ps.item_id
             ORDER BY ps.id DESC'
        )->fetchAll();
        Auth::jsonResponse(['sales' => array_map($castSalesRow, $rows)]);
    }

    if ($uri === '/api/v1/paddy-sales' && $method === 'POST') {
        Auth::requirePermission($emp, 'paddy.sale.create');
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $body, $clientUuid, $empId, $empName, $clientType, $castSalesRow): array {
                $seq          = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM paddy_sales')->fetchColumn();
                $saleNo       = 'PDS-2026-' . str_pad((string)$seq, 4, '0', STR_PAD_LEFT);
                $qrUid        = ErpEngine::uuidV4();
                $costingMethod = (string)($body['costing_method'] ?? 'FIFO');
                $customerId   = (int)($body['customer_id'] ?? 0);
                $warehouseId  = (int)($body['warehouse_id'] ?? 0);
                $itemId       = (int)($body['item_id'] ?? 0);
                $qtyKg        = (float)($body['qty_kg'] ?? 0);

                if ($customerId <= 0 || $warehouseId <= 0 || $itemId <= 0 || $qtyKg <= 0) {
                    throw new RuntimeException('Delivered paddy weight (kg), customer, warehouse, and variety are required');
                }

                $juteBags    = max(0, (int)round((float)($body['jute_bag_count'] ?? 0)));
                $plasticBags = max(0, (int)round((float)($body['plastic_bag_count'] ?? 0)));
                $resolvedBagCount = !empty($body['bag_count']) && (int)$body['bag_count'] > 0
                    ? (int)round((float)$body['bag_count'])
                    : ($juteBags + $plasticBags);

                $scaleWeightKg       = (float)($body['scale_weight_kg'] ?? $qtyKg);
                $paymentWeightKg     = (float)($body['payment_weight_kg'] ?? $qtyKg);
                $weightLossKg        = max(0.0, (float)($body['weight_loss_kg'] ?? 0));
                $settlementUnitKg    = (float)($body['settlement_unit_kg'] ?? 75.5);
                $settlementRate      = (float)($body['settlement_rate'] ?? 0);
                $moisturePct         = (float)($body['moisture_pct'] ?? 14);
                $netSettlementWeight = round($paymentWeightKg - $weightLossKg, 3);
                $hasFormula          = $settlementRate > 0 && $settlementUnitKg > 0;

                if ($hasFormula && $netSettlementWeight <= 0) {
                    throw new RuntimeException('Net settlement weight (Payment Weight - Weight Loss) must be greater than zero');
                }
                if (!$hasFormula && (float)($body['rate_per_kg'] ?? 0) <= 0) {
                    throw new RuntimeException('Valid paddy settlement rate or rate per kg is required');
                }

                $totalAmount = $hasFormula
                    ? round(($netSettlementWeight / $settlementUnitKg) * $settlementRate, 2)
                    : round($qtyKg * (float)($body['rate_per_kg'] ?? 0), 2);
                $effectiveRatePerKg = $hasFormula
                    ? round($totalAmount / ($paymentWeightKg > 0 ? $paymentWeightKg : $qtyKg), 4)
                    : (float)($body['rate_per_kg'] ?? 0);
                $effectiveSettlementRate = $hasFormula
                    ? $settlementRate
                    : round($effectiveRatePerKg * $settlementUnitKg, 2);

                $paidAmt   = min($totalAmount, max(0.0, (float)($body['paid_amount'] ?? 0)));
                $payStatus = $paidAmt <= 0 ? 'UNPAID' : ($paidAmt >= $totalAmount ? 'PAID' : 'PARTIAL');

                $preferredLotId = !empty($body['preferred_lot_id']) && (int)$body['preferred_lot_id'] > 0
                    ? (int)$body['preferred_lot_id']
                    : null;

                $ins = $pdo->prepare(
                    'INSERT INTO paddy_sales (
                        client_uuid, sale_no, customer_id, warehouse_id, item_id, source_lot_id,
                        challan_no, bag_count, jute_bag_count, plastic_bag_count, extra_torn_bags, moisture_pct,
                        scale_weight_kg, qty_kg, payment_weight_kg, weight_loss_kg,
                        settlement_unit_kg, settlement_rate, rate_per_kg,
                        total_amount, costing_method, cogs_amount, paid_amount, payment_status,
                        vehicle_no, notes, qr_code_uid, created_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)'
                );
                $ins->execute([
                    $clientUuid,
                    $saleNo,
                    $customerId,
                    $warehouseId,
                    $itemId,
                    $preferredLotId,
                    (string)($body['challan_no'] ?? ''),
                    $resolvedBagCount,
                    $juteBags,
                    $plasticBags,
                    $moisturePct,
                    $scaleWeightKg,
                    $qtyKg,
                    $paymentWeightKg,
                    $weightLossKg,
                    $settlementUnitKg,
                    $effectiveSettlementRate,
                    $effectiveRatePerKg,
                    $totalAmount,
                    $costingMethod,
                    $paidAmt,
                    $payStatus,
                    (string)($body['vehicle_no'] ?? ''),
                    (string)($body['notes'] ?? ''),
                    $qrUid,
                    $empId,
                ]);
                $saleId = (int)$pdo->lastInsertId();

                $pendingLotRow = null;
                if ($preferredLotId !== null) {
                    $plStmt = $pdo->prepare('SELECT id, weight_pending, remaining_bags, source_type, source_id FROM inventory_lots WHERE id = ?');
                    $plStmt->execute([$preferredLotId]);
                    $pendingLotRow = $plStmt->fetch() ?: null;
                }

                $consumedTotalCost   = 0.0;
                $extraTornThisSale   = 0;
                $resolvedSourceLotId = $preferredLotId;

                if ($pendingLotRow && (int)($pendingLotRow['weight_pending'] ?? 0) === 1) {
                    $closeLot = array_key_exists('close_pending_lot', $body)
                        ? !empty($body['close_pending_lot'])
                        : ($resolvedBagCount >= (int)($pendingLotRow['remaining_bags'] ?? 0));
                    $pendingRes = ErpEngine::consumePendingWeightLot($pdo, [
                        'lotId'         => (int)$pendingLotRow['id'],
                        'qtyKg'         => $qtyKg,
                        'bagCount'      => $resolvedBagCount,
                        'closeLot'      => $closeLot,
                        'movementType'  => 'DIRECT_SALE_OUT',
                        'referenceType' => 'PADDY_SALE',
                        'referenceId'   => $saleId,
                        'employeeId'    => $empId,
                    ]);
                    $consumedTotalCost = (float)$pendingRes['totalCost'];
                    $extraTornThisSale = (int)$pendingRes['extraTornThisExit'];
                    if ($pendingLotRow['source_type'] === 'DRYING_OUTPUT' && $pendingLotRow['source_id'] !== null) {
                        $pdo->prepare(
                            'UPDATE paddy_drying_batches
                             SET exit_settlement_unit_kg = ?, exit_settlement_rate = ?, exit_total_value = COALESCE(exit_total_value, 0) + ?
                             WHERE id = ?'
                        )->execute([$settlementUnitKg, $effectiveSettlementRate, $totalAmount, (int)$pendingLotRow['source_id']]);
                    }
                } else {
                    $consumed = ErpEngine::consumeWarehouseStock($pdo, [
                        'itemId'         => $itemId,
                        'warehouseId'    => $warehouseId,
                        'qtyKg'          => $qtyKg,
                        'bagCount'       => $resolvedBagCount > 0 ? $resolvedBagCount : null,
                        'preferredLotId' => $preferredLotId,
                        'costingMethod'  => $costingMethod,
                        'movementType'   => 'DIRECT_SALE_OUT',
                        'referenceType'  => 'PADDY_SALE',
                        'referenceId'    => $saleId,
                        'employeeId'     => $empId,
                    ]);
                    $consumedTotalCost = (float)$consumed['totalCost'];
                    if ($resolvedSourceLotId === null && !empty($consumed['consumedLots'])) {
                        $resolvedSourceLotId = (int)$consumed['consumedLots'][0]['lot_id'];
                    }
                }

                $pdo->prepare('UPDATE paddy_sales SET cogs_amount = ?, source_lot_id = ?, extra_torn_bags = ? WHERE id = ?')
                    ->execute([$consumedTotalCost, $resolvedSourceLotId, $extraTornThisSale, $saleId]);
                $dueAmt = $totalAmount - $paidAmt;
                $pdo->prepare('UPDATE parties SET current_balance = current_balance + ? WHERE id = ?')->execute([$dueAmt, $customerId]);

                $jeLines = [
                    ['accountCode' => '1100', 'debit' => $dueAmt, 'credit' => 0, 'partyId' => $customerId],
                    ['accountCode' => '4002', 'debit' => 0, 'credit' => $totalAmount],
                    ['accountCode' => '5001', 'debit' => $consumedTotalCost, 'credit' => 0],
                    ['accountCode' => '1200', 'debit' => 0, 'credit' => $consumedTotalCost],
                ];
                if ($paidAmt > 0) {
                    $jeLines[] = ['accountCode' => '1001', 'debit' => $paidAmt, 'credit' => 0, 'partyId' => $customerId];
                }
                ErpEngine::postJournalEntry($pdo, [
                    'description'   => "Direct Paddy Sale {$saleNo} ({$qtyKg} kg, {$resolvedBagCount} bags)",
                    'referenceType' => 'PADDY_SALE',
                    'referenceId'   => $saleId,
                    'employeeId'    => $empId,
                    'lines'         => $jeLines,
                ]);

                $cStmt = $pdo->prepare('SELECT name FROM parties WHERE id = ?');
                $cStmt->execute([$customerId]);
                $custName = (string)($cStmt->fetchColumn() ?: $customerId);

                $iStmt = $pdo->prepare('SELECT name FROM items WHERE id = ?');
                $iStmt->execute([$itemId]);
                $itemName = (string)($iStmt->fetchColumn() ?: $itemId);

                $wStmt = $pdo->prepare('SELECT name FROM warehouses WHERE id = ?');
                $wStmt->execute([$warehouseId]);
                $whName = (string)($wStmt->fetchColumn() ?: $warehouseId);

                ErpEngine::registerQrTag($pdo, $qrUid, 'PADDY_SALE', $saleId, $saleNo, [
                    'sale_no'            => $saleNo,
                    'customer'           => $custName,
                    'variety'            => $itemName,
                    'godown'             => $whName,
                    'bag_count'          => $resolvedBagCount,
                    'qty_kg'             => $qtyKg,
                    'settlement_unit_kg' => $settlementUnitKg,
                    'settlement_rate'    => $effectiveSettlementRate,
                    'total_amount'       => $totalAmount,
                    'vehicle_no'         => (string)($body['vehicle_no'] ?? ''),
                ]);

                ErpEngine::writeAudit($pdo, $empId, $empName, 'DIRECT_PADDY_SALE', 'PADDY_SALE', $saleNo, null, [
                    'qty_kg'          => $qtyKg,
                    'bag_count'       => $resolvedBagCount,
                    'extra_torn_bags' => $extraTornThisSale,
                    'total_amount'    => $totalAmount,
                    'cogs'            => $consumedTotalCost,
                ], $clientType);

                $sel = $pdo->prepare(
                    'SELECT ps.*, pt.name AS customer_name, w.name AS warehouse_name, i.name AS item_name
                     FROM paddy_sales ps
                     JOIN parties pt ON pt.id = ps.customer_id
                     JOIN warehouses w ON w.id = ps.warehouse_id
                     JOIN items i ON i.id = ps.item_id
                     WHERE ps.id = ?'
                );
                $sel->execute([$saleId]);
                $created = $castSalesRow($sel->fetch() ?: []);

                $responseObj = ['status' => 'SYNCED', 'sale' => $created];
                ErpEngine::recordSyncLog($pdo, $clientUuid, (string)($body['device_id'] ?? 'WEB-BROWSER'), $clientType, '/api/v1/paddy-sales', 'SYNCED', null, $responseObj, $empId);
                return $responseObj;
            });
            Auth::jsonResponse($result, 201);
        } catch (InsufficientStockException $e) {
            Auth::abort(409, $e->getMessage(), ['code' => 'INSUFFICIENT_STOCK']);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    // -----------------------------------------------------------------------
    // 8. Paddy Drying Management
    // -----------------------------------------------------------------------
    if ($uri === '/api/v1/drying-batches' && $method === 'GET') {
        Auth::rejectPhysicalOnlyUser($emp);
        $rows = $pdo->query(
            "SELECT d.*, ws.name AS source_warehouse_name, wd.name AS dest_warehouse_name, i.name AS item_name,
                    l.id AS lot_id, l.lot_code, COALESCE(l.remaining_bags, 0) AS remaining_bags,
                    COALESCE(l.pending_cost_total, 0) AS pending_cost_total
             FROM paddy_drying_batches d
             JOIN warehouses ws ON ws.id = d.source_warehouse_id
             JOIN warehouses wd ON wd.id = d.dest_warehouse_id
             JOIN items i ON i.id = d.item_id
             LEFT JOIN inventory_lots l ON l.source_type = 'DRYING_OUTPUT' AND l.source_id = d.id
             ORDER BY d.id DESC"
        )->fetchAll();
        foreach ($rows as &$r) {
            foreach ([
                'input_qty_kg', 'initial_moisture_pct', 'final_moisture_pct',
                'output_qty_kg', 'moisture_loss_kg', 'fuel_power_cost',
                'labor_cost', 'input_paddy_cost', 'output_unit_cost_per_kg',
                'exit_settlement_unit_kg', 'exit_settlement_rate', 'exit_total_value', 'pending_cost_total',
            ] as $k) {
                if (array_key_exists($k, $r) && $r[$k] !== null) {
                    $r[$k] = (float)$r[$k];
                }
            }
            foreach (['input_bags', 'output_bags', 'dispatched_bags', 'extra_torn_bags', 'weight_pending', 'remaining_bags'] as $k) {
                if (array_key_exists($k, $r) && $r[$k] !== null) {
                    $r[$k] = (int)$r[$k];
                }
            }
        }
        unset($r);
        Auth::jsonResponse(['drying_batches' => $rows]);
    }

    if ($uri === '/api/v1/drying-batches' && $method === 'POST') {
        Auth::requirePermission($emp, 'drying.manage');
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        $isWeightPending = !empty($body['weight_pending']);
        $inputQtyKg      = (float)($body['input_qty_kg'] ?? 0);
        $inputBags       = max(0, (int)round((float)($body['input_bags'] ?? 0)));
        $outputBags      = max(0, (int)round((float)($body['output_bags'] ?? 0)));
        $outputQtyKg     = $isWeightPending ? 0.0 : (float)($body['output_qty_kg'] ?? 0);

        if ($inputQtyKg <= 0) {
            Auth::abort(400, 'Wet input paddy weight (kg) must be positive');
        }
        if ($isWeightPending) {
            if ($outputBags <= 0) {
                Auth::abort(400, 'Stored bag count is required when saving unweighed dried paddy to godown');
            }
        } elseif ($outputQtyKg > $inputQtyKg || $outputQtyKg <= 0) {
            Auth::abort(400, 'Dried output weight must be positive and cannot exceed wet input weight');
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $body, $clientUuid, $inputQtyKg, $inputBags, $outputBags, $outputQtyKg, $isWeightPending, $empId, $empName, $clientType): array {
                $seq      = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM paddy_drying_batches')->fetchColumn();
                $dryingNo = 'DRY-2026-' . str_pad((string)$seq, 4, '0', STR_PAD_LEFT);
                $qrUid    = ErpEngine::uuidV4();

                $sourceWhId     = (int)($body['source_warehouse_id'] ?? 0);
                $destWhId       = (int)($body['dest_warehouse_id'] ?? 0);
                $itemId         = (int)($body['item_id'] ?? 0);
                $dryingMethod   = (string)($body['drying_method'] ?? 'MECHANICAL_DRYER');
                $initMoist      = (float)($body['initial_moisture_pct'] ?? 0);
                $finalMoist     = (float)($body['final_moisture_pct'] ?? 0);
                $moistureLossKg = $isWeightPending ? 0.0 : round($inputQtyKg - $outputQtyKg, 3);
                $fuelCost       = (float)($body['fuel_power_cost'] ?? 0);
                $laborCost      = (float)($body['labor_cost'] ?? 0);
                $initialStatus  = $isWeightPending ? 'PENDING_WEIGHT' : 'COMPLETED';

                $ins = $pdo->prepare(
                    'INSERT INTO paddy_drying_batches (
                        client_uuid, drying_no, source_warehouse_id, dest_warehouse_id, item_id, drying_method,
                        input_qty_kg, input_bags, output_bags, dispatched_bags, extra_torn_bags, weight_pending,
                        initial_moisture_pct, final_moisture_pct, output_qty_kg, moisture_loss_kg,
                        fuel_power_cost, labor_cost, input_paddy_cost, output_unit_cost_per_kg,
                        exit_settlement_unit_kg, exit_settlement_rate, exit_total_value, notes, status, qr_code_uid, created_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0, 0, 75.5, 0, 0, ?, ?, ?, ?)'
                );
                $ins->execute([
                    $clientUuid,
                    $dryingNo,
                    $sourceWhId,
                    $destWhId,
                    $itemId,
                    $dryingMethod,
                    $inputQtyKg,
                    $inputBags,
                    $outputBags,
                    $isWeightPending ? 1 : 0,
                    $initMoist,
                    $finalMoist,
                    $outputQtyKg,
                    $moistureLossKg,
                    $fuelCost,
                    $laborCost,
                    (string)($body['notes'] ?? ''),
                    $initialStatus,
                    $qrUid,
                    $empId,
                ]);
                $dryingId = (int)$pdo->lastInsertId();

                $consumed = ErpEngine::consumeWarehouseStock($pdo, [
                    'itemId'        => $itemId,
                    'warehouseId'   => $sourceWhId,
                    'qtyKg'         => $inputQtyKg,
                    'bagCount'      => $inputBags > 0 ? $inputBags : null,
                    'costingMethod' => 'FIFO',
                    'movementType'  => 'DRYING_OUT',
                    'referenceType' => 'DRYING_BATCH',
                    'referenceId'   => $dryingId,
                    'employeeId'    => $empId,
                ]);

                $totalCapitalized = round($consumed['totalCost'] + $fuelCost + $laborCost, 2);
                $outputUnitCost   = (!$isWeightPending && $outputQtyKg > 0) ? round($totalCapitalized / $outputQtyKg, 4) : 0.0;

                $pdo->prepare('UPDATE paddy_drying_batches SET input_paddy_cost = ?, output_unit_cost_per_kg = ? WHERE id = ?')
                    ->execute([$consumed['totalCost'], $outputUnitCost, $dryingId]);

                ErpEngine::createInventoryLot($pdo, [
                    'prefix'           => 'LOT-DRY',
                    'itemId'           => $itemId,
                    'warehouseId'      => $destWhId,
                    'sourceType'       => 'DRYING_OUTPUT',
                    'sourceId'         => $dryingId,
                    'qtyKg'            => $outputQtyKg,
                    'bagCount'         => $outputBags > 0 ? $outputBags : null,
                    'unitCostPerKg'    => $outputUnitCost,
                    'moisturePct'      => $finalMoist,
                    'weightPending'    => $isWeightPending,
                    'pendingCostTotal' => $isWeightPending ? $totalCapitalized : 0.0,
                    'movementType'     => 'DRYING_IN',
                    'employeeId'       => $empId,
                    'qrUid'            => $qrUid,
                ]);

                if ($fuelCost + $laborCost > 0) {
                    ErpEngine::postJournalEntry($pdo, [
                        'description'   => "Paddy Drying Overhead {$dryingNo} ({$dryingMethod})",
                        'referenceType' => 'DRYING_BATCH',
                        'referenceId'   => $dryingId,
                        'employeeId'    => $empId,
                        'lines'         => [
                            ['accountCode' => '1200', 'debit' => $fuelCost + $laborCost, 'credit' => 0],
                            ['accountCode' => '1001', 'debit' => 0, 'credit' => $fuelCost + $laborCost],
                        ],
                    ]);
                }

                ErpEngine::writeAudit($pdo, $empId, $empName, $isWeightPending ? 'DRYING_STORED_UNWEIGHED' : 'DRYING_BATCH_COMPLETED', 'DRYING_BATCH', $dryingNo, null, [
                    'input_kg'         => $inputQtyKg,
                    'output_kg'        => $outputQtyKg,
                    'output_bags'      => $outputBags,
                    'weight_pending'   => $isWeightPending,
                    'loss_kg'          => $moistureLossKg,
                    'output_unit_cost' => $outputUnitCost,
                ], $clientType);

                $sel = $pdo->prepare(
                    "SELECT d.*, ws.name AS source_warehouse_name, wd.name AS dest_warehouse_name, i.name AS item_name,
                            l.id AS lot_id, l.lot_code, COALESCE(l.remaining_bags, 0) AS remaining_bags,
                            COALESCE(l.pending_cost_total, 0) AS pending_cost_total
                     FROM paddy_drying_batches d
                     JOIN warehouses ws ON ws.id = d.source_warehouse_id
                     JOIN warehouses wd ON wd.id = d.dest_warehouse_id
                     JOIN items i ON i.id = d.item_id
                     LEFT JOIN inventory_lots l ON l.source_type = 'DRYING_OUTPUT' AND l.source_id = d.id
                     WHERE d.id = ?"
                );
                $sel->execute([$dryingId]);
                $created = $sel->fetch();

                $responseObj = ['status' => 'SYNCED', 'drying_batch' => $created];
                ErpEngine::recordSyncLog($pdo, $clientUuid, (string)($body['device_id'] ?? 'WEB-BROWSER'), $clientType, '/api/v1/drying-batches', 'SYNCED', null, $responseObj, $empId);
                return $responseObj;
            });
            Auth::jsonResponse($result, 201);
        } catch (InsufficientStockException $e) {
            Auth::abort(409, $e->getMessage(), ['code' => 'INSUFFICIENT_STOCK']);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if (preg_match('#^/api/v1/drying-batches/(\d+)/weigh-out$#', $uri, $m) && $method === 'POST') {
        Auth::requirePermission($emp, 'drying.manage');
        $dryingId   = (int)$m[1];
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        $qtyKg    = (float)($body['qty_kg'] ?? 0);
        $exitBags = max(0, (int)round((float)($body['exit_bags'] ?? $body['bag_count'] ?? 0)));
        if ($qtyKg <= 0) {
            Auth::abort(400, 'Exit weight (kg) must be greater than zero');
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $dryingId, $body, $qtyKg, $exitBags, $empId, $empName, $clientType): array {
                $lStmt = $pdo->prepare("SELECT * FROM inventory_lots WHERE source_type = 'DRYING_OUTPUT' AND source_id = ? LIMIT 1");
                $lStmt->execute([$dryingId]);
                $lot = $lStmt->fetch();
                if (!$lot || (int)($lot['weight_pending'] ?? 0) !== 1) {
                    throw new RuntimeException('No open pending-weight drying lot found');
                }

                $closeLot = array_key_exists('close_lot', $body)
                    ? !empty($body['close_lot'])
                    : ($exitBags >= (int)($lot['remaining_bags'] ?? 0));
                $consumed = ErpEngine::consumePendingWeightLot($pdo, [
                    'lotId'         => (int)$lot['id'],
                    'qtyKg'         => $qtyKg,
                    'bagCount'      => $exitBags,
                    'closeLot'      => $closeLot,
                    'movementType'  => 'DRYING_WEIGH_OUT',
                    'referenceType' => 'DRYING_BATCH',
                    'referenceId'   => $dryingId,
                    'employeeId'    => $empId,
                ]);

                $targetWhId = !empty($body['dest_warehouse_id']) && (int)$body['dest_warehouse_id'] > 0
                    ? (int)$body['dest_warehouse_id']
                    : (int)$lot['warehouse_id'];
                $weighedLot = ErpEngine::createInventoryLot($pdo, [
                    'prefix'        => 'LOT-WGH',
                    'itemId'        => (int)$lot['item_id'],
                    'warehouseId'   => $targetWhId,
                    'sourceType'    => 'DRYING_WEIGHED_IN',
                    'sourceId'      => $dryingId,
                    'qtyKg'         => $qtyKg,
                    'bagCount'      => $exitBags,
                    'packSizeKg'    => $exitBags > 0 ? round($qtyKg / $exitBags, 2) : 60,
                    'unitCostPerKg' => $consumed['avgUnitCost'],
                    'moisturePct'   => $lot['moisture_pct'] !== null ? (float)$lot['moisture_pct'] : null,
                    'movementType'  => 'DRYING_WEIGH_IN',
                    'employeeId'    => $empId,
                ]);

                $weightLossKg     = max(0.0, (float)($body['weight_loss_kg'] ?? 0));
                $settlementUnitKg = (float)($body['settlement_unit_kg'] ?? 75.5) > 0 ? (float)($body['settlement_unit_kg'] ?? 75.5) : 75.5;
                $settlementRate   = max(0.0, (float)($body['settlement_rate'] ?? 0));
                $netSettleWt      = max(0.0, $qtyKg - $weightLossKg);
                $exitTotalVal     = ($settlementRate > 0 && $netSettleWt > 0) ? round(($netSettleWt / $settlementUnitKg) * $settlementRate, 2) : 0.0;
                $noteStr          = (string)($body['notes'] ?? '');

                $pdo->prepare(
                    "UPDATE paddy_drying_batches
                     SET exit_settlement_unit_kg = ?, exit_settlement_rate = ?,
                         exit_total_value = COALESCE(exit_total_value, 0) + ?,
                         notes = CASE WHEN ? != '' THEN ? ELSE notes END
                     WHERE id = ?"
                )->execute([$settlementUnitKg, $settlementRate, $exitTotalVal, $noteStr, $noteStr, $dryingId]);

                ErpEngine::writeAudit($pdo, $empId, $empName, 'DRYING_WEIGH_OUT_STOCKED', 'DRYING_BATCH', (string)$dryingId, null, [
                    'weighed_lot_code'     => $weighedLot['lotCode'],
                    'qty_kg'               => $qtyKg,
                    'exit_bags'            => $exitBags,
                    'extra_torn_this_exit' => $consumed['extraTornThisExit'],
                    'exit_settlement_rate' => $settlementRate,
                    'exit_total_value'     => $exitTotalVal,
                    'closed'               => $consumed['closed'],
                ], $clientType);

                $sel = $pdo->prepare(
                    "SELECT d.*, ws.name AS source_warehouse_name, wd.name AS dest_warehouse_name, i.name AS item_name,
                            l.id AS lot_id, l.lot_code, COALESCE(l.remaining_bags, 0) AS remaining_bags,
                            COALESCE(l.pending_cost_total, 0) AS pending_cost_total
                     FROM paddy_drying_batches d
                     JOIN warehouses ws ON ws.id = d.source_warehouse_id
                     JOIN warehouses wd ON wd.id = d.dest_warehouse_id
                     JOIN items i ON i.id = d.item_id
                     LEFT JOIN inventory_lots l ON l.source_type = 'DRYING_OUTPUT' AND l.source_id = d.id
                     WHERE d.id = ?"
                );
                $sel->execute([$dryingId]);
                return ['status' => 'SYNCED', 'drying_batch' => $sel->fetch(), 'weighed_lot' => $weighedLot, 'consumed' => $consumed];
            });
            Auth::jsonResponse($result, 200);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if (preg_match('#^/api/v1/drying-batches/(\d+)/close-pending$#', $uri, $m) && $method === 'POST') {
        Auth::requirePermission($emp, 'drying.manage');
        $dryingId = (int)$m[1];
        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $dryingId, $empId): array {
                $lStmt = $pdo->prepare("SELECT * FROM inventory_lots WHERE source_type = 'DRYING_OUTPUT' AND source_id = ? LIMIT 1");
                $lStmt->execute([$dryingId]);
                $lot = $lStmt->fetch();
                if (!$lot || (int)($lot['weight_pending'] ?? 0) !== 1) {
                    throw new RuntimeException('No open pending-weight drying lot found');
                }
                $remCost = (float)($lot['pending_cost_total'] ?? 0);
                if ($remCost > 0.01) {
                    ErpEngine::postJournalEntry($pdo, [
                        'description'   => "Drying Loss / Unweighed Lot Closure {$lot['lot_code']}",
                        'referenceType' => 'DRYING_BATCH',
                        'referenceId'   => $dryingId,
                        'employeeId'    => $empId,
                        'lines'         => [
                            ['accountCode' => '5200', 'debit' => $remCost, 'credit' => 0],
                            ['accountCode' => '1200', 'debit' => 0, 'credit' => $remCost],
                        ],
                    ]);
                }
                $pdo->prepare('UPDATE inventory_lots SET weight_pending = 0, remaining_bags = 0, pending_cost_total = 0, version = version + 1 WHERE id = ?')
                    ->execute([(int)$lot['id']]);
                $pdo->prepare("UPDATE paddy_drying_batches SET weight_pending = 0, status = 'COMPLETED' WHERE id = ?")
                    ->execute([$dryingId]);
                return ['status' => 'CLOSED', 'drying_id' => $dryingId];
            });
            Auth::jsonResponse($result, 200);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    // -----------------------------------------------------------------------
    // 9. Production Batches (Parboiled Siddho & Raw Atap) + Cost Sheets
    // -----------------------------------------------------------------------
    if ($uri === '/api/v1/production-batches' && $method === 'GET') {
        Auth::rejectPhysicalOnlyUser($emp);
        $ids = $pdo->query('SELECT id FROM production_batches ORDER BY id DESC')->fetchAll(PDO::FETCH_COLUMN);
        $batches = [];
        foreach ($ids as $bid) {
            $enriched = $getEnrichedProductionBatch((int)$bid);
            if ($enriched !== null) {
                $batches[] = $enriched;
            }
        }
        Auth::jsonResponse(['batches' => $batches]);
    }

    if ($uri === '/api/v1/production-batches' && $method === 'POST') {
        Auth::requirePermission($emp, 'production.manage');
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        $issueOnly     = (bool)($body['issue_only'] ?? false);
        $inputQtyKg    = (float)($body['input_paddy_qty_kg'] ?? 0);
        $headRiceQty   = (float)($body['head_rice_qty_kg'] ?? 0);
        $brokenRiceQty = (float)($body['broken_rice_qty_kg'] ?? 0);
        $branQty       = (float)($body['bran_qty_kg'] ?? 0);
        $huskQty       = (float)($body['husk_qty_kg'] ?? 0);
        $totalOutput   = $headRiceQty + $brokenRiceQty + $branQty + $huskQty;

        if ($inputQtyKg <= 0) {
            Auth::abort(400, 'Input paddy weight must be positive');
        }
        if (!$issueOnly && ($totalOutput > $inputQtyKg || $headRiceQty <= 0)) {
            Auth::abort(400, 'Total milled outputs cannot exceed input paddy weight, and head rice must be positive');
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use (
                $pdo, $body, $clientUuid, $issueOnly, $inputQtyKg, $headRiceQty,
                $brokenRiceQty, $branQty, $huskQty, $totalOutput, $empId, $empName, $clientType, $getEnrichedProductionBatch
            ): array {
                $seq           = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM production_batches')->fetchColumn();
                $processType   = (string)($body['process_type'] ?? 'PARBOILED_SIDDHO');
                $prefix        = $processType === 'PARBOILED_SIDDHO' ? 'PRD-SID' : 'PRD-ATP';
                $batchNo       = $prefix . '-' . (string)(2600 + $seq);
                $qrUid         = ErpEngine::uuidV4();
                $costingMethod = (string)($body['costing_method'] ?? 'FIFO');
                $sourceWhId    = (int)($body['source_warehouse_id'] ?? 0);
                $paddyItemId   = (int)($body['paddy_item_id'] ?? 0);

                $lotStmt = $pdo->prepare(
                    "SELECT l.remaining_qty_kg, l.remaining_bags, l.unit_cost_per_kg, l.initial_qty_kg, l.source_type,
                            pp.bag_count AS purchase_bag_count, i.bag_weight_kg
                     FROM inventory_lots l
                     JOIN items i ON i.id = l.item_id
                     LEFT JOIN paddy_purchases pp ON l.source_type = 'PADDY_PURCHASE' AND pp.id = l.source_id
                     WHERE l.item_id = ? AND l.warehouse_id = ? AND l.remaining_qty_kg > 0.0001"
                );
                $lotStmt->execute([$paddyItemId, $sourceWhId]);
                $activeLots = $lotStmt->fetchAll();

                $stockWeightKg = 0.0;
                $stockBags     = 0;
                $stockValue    = 0.0;
                foreach ($activeLots as $l) {
                    $remQty = (float)($l['remaining_qty_kg'] ?? 0);
                    $stockWeightKg += $remQty;
                    $stockValue    += $remQty * (float)($l['unit_cost_per_kg'] ?? 0);
                    if ((int)($l['remaining_bags'] ?? 0) > 0) {
                        $stockBags += (int)$l['remaining_bags'];
                    } elseif ($l['source_type'] === 'PADDY_PURCHASE' && (int)($l['purchase_bag_count'] ?? 0) > 0 && (float)$l['initial_qty_kg'] > 0) {
                        $stockBags += (int)round(($remQty * (int)$l['purchase_bag_count']) / (float)$l['initial_qty_kg']);
                    } else {
                        $bw = (float)($l['bag_weight_kg'] ?? 60);
                        $stockBags += (int)round($remQty / ($bw > 0 ? $bw : 60.0));
                    }
                }

                $divisor     = ((float)($body['unit_divisor'] ?? 75.5)) > 0 ? (float)($body['unit_divisor'] ?? 75.5) : 75.5;
                $inputBags   = max(0, (int)round((float)($body['input_bag_count'] ?? 0)));
                $dryerCount  = ((int)($body['dryer_count'] ?? 1)) > 0 ? (int)$body['dryer_count'] : 1;
                $dryerNoRaw  = trim((string)($body['dryer_no'] ?? ''));
                $dryerNo     = $dryerNoRaw !== '' ? $dryerNoRaw : ('ডায়ার-' . $dryerCount);

                $stockNetUnits = $stockWeightKg > $stockBags ? ($stockWeightKg - $stockBags) / $divisor : 0.0;
                $bagUnitRate   = $stockNetUnits > 0 ? round($stockValue / $stockNetUnits, 4) : 0.0;
                $goingNetUnits = ($inputBags > 0 && $inputQtyKg > $inputBags)
                    ? round(($inputQtyKg - $inputBags) / $divisor, 4)
                    : 0.0;
                $formulaCost = ($bagUnitRate > 0 && $goingNetUnits > 0)
                    ? round($bagUnitRate * $goingNetUnits, 2)
                    : 0.0;

                $wastageKg        = $issueOnly ? 0.0 : round($inputQtyKg - $totalOutput, 3);
                $headRiceYieldPct = $issueOnly ? 0.0 : round(($headRiceQty / $inputQtyKg) * 100, 2);
                $totalRecoveryPct = $issueOnly ? 0.0 : round(($totalOutput / $inputQtyKg) * 100, 2);
                $batchStatus      = $issueOnly ? 'IN_PROGRESS' : 'COMPLETED';

                $completedExpr = $issueOnly ? 'NULL' : 'NOW()';
                $insBatch = $pdo->prepare(
                    "INSERT INTO production_batches (
                        client_uuid, batch_no, process_type, source_warehouse_id, paddy_item_id, input_paddy_qty_kg,
                        input_bag_count, dryer_no, dryer_count, unit_divisor, paddy_net_units, paddy_bag_unit_rate, paddy_formula_cost,
                        costing_method, soaking_hours, steaming_temp_c, head_rice_qty_kg, broken_rice_qty_kg, bran_qty_kg,
                        husk_qty_kg, wastage_qty_kg, head_rice_yield_pct, total_recovery_pct, status, qr_code_uid, notes, created_by, completed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, {$completedExpr})"
                );
                $insBatch->execute([
                    $clientUuid,
                    $batchNo,
                    $processType,
                    $sourceWhId,
                    $paddyItemId,
                    $inputQtyKg,
                    $inputBags,
                    $dryerNo,
                    $dryerCount,
                    $divisor,
                    $goingNetUnits,
                    $bagUnitRate,
                    $formulaCost,
                    $costingMethod,
                    (float)($body['soaking_hours'] ?? 0),
                    (float)($body['steaming_temp_c'] ?? 0),
                    $headRiceQty,
                    $brokenRiceQty,
                    $branQty,
                    $huskQty,
                    $wastageKg,
                    $headRiceYieldPct,
                    $totalRecoveryPct,
                    $batchStatus,
                    $qrUid,
                    (string)($body['notes'] ?? ''),
                    $empId,
                ]);
                $batchId = (int)$pdo->lastInsertId();

                $consumed = ErpEngine::consumeWarehouseStock($pdo, [
                    'itemId'        => $paddyItemId,
                    'warehouseId'   => $sourceWhId,
                    'qtyKg'         => $inputQtyKg,
                    'bagCount'      => $inputBags > 0 ? $inputBags : null,
                    'costingMethod' => $costingMethod,
                    'movementType'  => 'PRODUCTION_INPUT',
                    'referenceType' => 'PRODUCTION_BATCH',
                    'referenceId'   => $batchId,
                    'employeeId'    => $empId,
                ]);

                $effectiveRawPaddyCost = $formulaCost > 0 ? $formulaCost : $consumed['totalCost'];
                if ($formulaCost === 0.0 && $goingNetUnits > 0) {
                    $pdo->prepare('UPDATE production_batches SET paddy_formula_cost = ? WHERE id = ?')
                        ->execute([$effectiveRawPaddyCost, $batchId]);
                }

                $pdo->prepare(
                    'INSERT INTO production_batch_inputs (
                        batch_id, source_warehouse_id, paddy_item_id, bag_count, qty_kg, unit_divisor, net_units, bag_unit_rate, paddy_cost, notes, created_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                )->execute([
                    $batchId,
                    $sourceWhId,
                    $paddyItemId,
                    $inputBags,
                    $inputQtyKg,
                    $divisor,
                    $goingNetUnits,
                    $bagUnitRate,
                    $effectiveRawPaddyCost,
                    (string)($body['notes'] ?? 'প্রাথমিক ডায়ারে ধান ইস্যু'),
                    $empId,
                ]);

                $brokenItem = $pdo->query("SELECT id, default_rate FROM items WHERE category = 'BROKEN_RICE' LIMIT 1")->fetch();
                $branItem   = $pdo->query("SELECT id, default_rate FROM items WHERE category = 'RICE_BRAN' LIMIT 1")->fetch();
                $huskItem   = $pdo->query("SELECT id, default_rate FROM items WHERE category = 'HUSK' LIMIT 1")->fetch();

                $brokenVal = (!$issueOnly && $brokenItem && $brokenRiceQty > 0) ? round($brokenRiceQty * (float)$brokenItem['default_rate'], 2) : 0.0;
                $branVal   = (!$issueOnly && $branItem && $branQty > 0) ? round($branQty * (float)$branItem['default_rate'], 2) : 0.0;
                $huskVal   = (!$issueOnly && $huskItem && $huskQty > 0) ? round($huskQty * (float)$huskItem['default_rate'], 2) : 0.0;
                $byproductCredit = round($brokenVal + $branVal + $huskVal, 2);

                $labor = (float)($body['labor_cost'] ?? 0);
                $elec  = (float)($body['electricity_cost'] ?? 0);
                $fuel  = (float)($body['fuel_boiler_cost'] ?? 0);
                $mach  = (float)($body['machinery_overhead_cost'] ?? 0);
                $pack  = (float)($body['packaging_cost'] ?? 0);

                $grossBatchCost     = round($effectiveRawPaddyCost + $labor + $elec + $fuel + $mach + $pack, 2);
                $netHeadRiceCost    = max(0.0, round($grossBatchCost - $byproductCredit, 2));
                $costPerKgHeadRice  = (!$issueOnly && $headRiceQty > 0) ? round($netHeadRiceCost / $headRiceQty, 4) : 0.0;
                $costPerBagHeadRice = (!$issueOnly && $headRiceQty > 0) ? round($costPerKgHeadRice * 50, 2) : 0.0;

                $pdo->prepare(
                    'INSERT INTO production_cost_sheets (
                        batch_id, raw_paddy_cost, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost,
                        packaging_cost, gross_batch_cost, byproduct_credit_value, net_head_rice_cost, cost_per_kg_head_rice, cost_per_bag_head_rice
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                )->execute([
                    $batchId,
                    $effectiveRawPaddyCost,
                    $labor,
                    $elec,
                    $fuel,
                    $mach,
                    $pack,
                    $grossBatchCost,
                    $byproductCredit,
                    $netHeadRiceCost,
                    $costPerKgHeadRice,
                    $costPerBagHeadRice,
                ]);

                if (!$issueOnly && $headRiceQty > 0 && !empty($body['head_rice_item_id']) && !empty($body['rice_warehouse_id']) && !empty($body['byproduct_warehouse_id'])) {
                    $insOut = $pdo->prepare(
                        'INSERT INTO production_outputs (batch_id, item_id, warehouse_id, output_type, pack_size_kg, bag_count, qty_kg, allocated_unit_cost_per_kg, total_value, lot_id)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                    );
                    $headLot = ErpEngine::createInventoryLot($pdo, [
                        'prefix'        => 'LOT-RIC',
                        'itemId'        => (int)$body['head_rice_item_id'],
                        'warehouseId'   => (int)$body['rice_warehouse_id'],
                        'sourceType'    => 'PRODUCTION_OUTPUT',
                        'sourceId'      => $batchId,
                        'qtyKg'         => $headRiceQty,
                        'packSizeKg'    => 50,
                        'bagCount'      => (int)round($headRiceQty / 50),
                        'unitCostPerKg' => $costPerKgHeadRice,
                        'movementType'  => 'PRODUCTION_OUTPUT',
                        'employeeId'    => $empId,
                    ]);
                    $insOut->execute([
                        $batchId,
                        (int)$body['head_rice_item_id'],
                        (int)$body['rice_warehouse_id'],
                        'HEAD_RICE',
                        50,
                        (int)round($headRiceQty / 50),
                        $headRiceQty,
                        $costPerKgHeadRice,
                        $netHeadRiceCost,
                        $headLot['lotId'],
                    ]);

                    $bypWhId = (int)$body['byproduct_warehouse_id'];
                    foreach ([
                        ['qty' => $brokenRiceQty, 'item' => $brokenItem, 'type' => 'BROKEN_RICE', 'val' => $brokenVal, 'pack' => 50],
                        ['qty' => $branQty, 'item' => $branItem, 'type' => 'RICE_BRAN', 'val' => $branVal, 'pack' => 50],
                        ['qty' => $huskQty, 'item' => $huskItem, 'type' => 'HUSK', 'val' => $huskVal, 'pack' => 35],
                    ] as $byp) {
                        if ($byp['qty'] <= 0 || !$byp['item']) {
                            continue;
                        }
                        $bBags = (int)round($byp['qty'] / $byp['pack']);
                        $bLot  = ErpEngine::createInventoryLot($pdo, [
                            'prefix'        => 'LOT-BYP',
                            'itemId'        => (int)$byp['item']['id'],
                            'warehouseId'   => $bypWhId,
                            'sourceType'    => 'PRODUCTION_OUTPUT',
                            'sourceId'      => $batchId,
                            'qtyKg'         => $byp['qty'],
                            'packSizeKg'    => $byp['pack'],
                            'bagCount'      => $bBags,
                            'unitCostPerKg' => (float)$byp['item']['default_rate'],
                            'movementType'  => 'PRODUCTION_OUTPUT',
                            'employeeId'    => $empId,
                        ]);
                        $insOut->execute([
                            $batchId,
                            (int)$byp['item']['id'],
                            $bypWhId,
                            $byp['type'],
                            $byp['pack'],
                            $bBags,
                            $byp['qty'],
                            (float)$byp['item']['default_rate'],
                            $byp['val'],
                            $bLot['lotId'],
                        ]);
                    }
                }

                $overheadTotal = $labor + $elec + $fuel + $mach + $pack;
                if ($overheadTotal > 0) {
                    $pdo->prepare(
                        "INSERT INTO production_batch_expenses (
                            batch_id, expense_category, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost, packaging_cost,
                            total_amount, payment_status, paid_amount, paid_at, notes, created_by
                        ) VALUES (?, 'GENERAL', ?, ?, ?, ?, ?, ?, 'PAID', ?, NOW(), ?, ?)"
                    )->execute([$batchId, $labor, $elec, $fuel, $mach, $pack, $overheadTotal, $overheadTotal, (string)($body['notes'] ?? 'Initial batch overhead'), $empId]);

                    ErpEngine::postJournalEntry($pdo, [
                        'description'   => "Milling Overhead Capitalized - {$batchNo} ({$processType})",
                        'referenceType' => 'PRODUCTION_BATCH',
                        'referenceId'   => $batchId,
                        'employeeId'    => $empId,
                        'lines'         => [
                            ['accountCode' => '1200', 'debit' => $overheadTotal, 'credit' => 0],
                            ['accountCode' => '1001', 'debit' => 0, 'credit' => $overheadTotal],
                        ],
                    ]);
                }

                ErpEngine::registerQrTag($pdo, $qrUid, 'PRODUCTION_BATCH', $batchId, $batchNo, [
                    'batch_no'    => $batchNo,
                    'process'     => $processType,
                    'dryer'       => "{$dryerCount} ({$dryerNo})",
                    'input_bags'  => $inputBags,
                    'input_kg'    => $inputQtyKg,
                    'paddy_cost'  => $effectiveRawPaddyCost,
                    'head_rice_kg' => $headRiceQty,
                    'yield_pct'   => $headRiceYieldPct,
                    'cost_per_kg' => $costPerKgHeadRice,
                ]);

                ErpEngine::writeAudit(
                    $pdo,
                    $empId,
                    $empName,
                    $issueOnly ? 'CRUSHING_DRYER_ISSUED' : 'PRODUCTION_BATCH_COMPLETED',
                    'PRODUCTION_BATCH',
                    $batchNo,
                    null,
                    [
                        'process_type' => $processType,
                        'dryer_no'     => $dryerNo,
                        'dryer_count'  => $dryerCount,
                        'input_bags'   => $inputBags,
                        'input_kg'     => $inputQtyKg,
                        'paddy_cost'   => $effectiveRawPaddyCost,
                    ],
                    $clientType
                );

                $responseObj = ['status' => 'SYNCED', 'batch' => $getEnrichedProductionBatch($batchId)];
                ErpEngine::recordSyncLog($pdo, $clientUuid, (string)($body['device_id'] ?? 'WEB-BROWSER'), $clientType, '/api/v1/production-batches', 'SYNCED', null, $responseObj, $empId);
                return $responseObj;
            });
            Auth::jsonResponse($result, 201);
        } catch (InsufficientStockException $e) {
            Auth::abort(409, $e->getMessage(), ['code' => 'INSUFFICIENT_STOCK']);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if (preg_match('#^/api/v1/production-batches/(\d+)/add-paddy$#', $uri, $m) && $method === 'POST') {
        Auth::requirePermission($emp, 'production.manage');
        $batchId = (int)$m[1];

        $bStmt = $pdo->prepare('SELECT * FROM production_batches WHERE id = ?');
        $bStmt->execute([$batchId]);
        $batch = $bStmt->fetch();
        if (!$batch) {
            Auth::abort(404, 'Production batch not found');
        }
        if ($batch['status'] !== 'IN_PROGRESS') {
            Auth::abort(400, 'Can only add extra paddy to an ongoing (IN_PROGRESS) dryer batch');
        }

        $addBags       = max(0, (int)round((float)($body['bag_count'] ?? 0)));
        $addKg         = (float)($body['qty_kg'] ?? 0);
        $rawDiv        = (float)($body['unit_divisor'] ?? $batch['unit_divisor'] ?? 75.5);
        $divisor       = $rawDiv > 0 ? $rawDiv : 75.5;
        $costingMethod = (string)($body['costing_method'] ?? 'FIFO');

        if ($addKg <= 0 || $addBags <= 0 || $addKg <= $addBags) {
            Auth::abort(400, 'Valid bag count and weight (weight > bags) are required');
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use (
                $pdo, $body, $batchId, $batch, $addBags, $addKg, $divisor, $costingMethod, $empId, $empName, $clientType, $getEnrichedProductionBatch
            ): array {
                $sourceWhId  = (int)($body['source_warehouse_id'] ?? 0);
                $paddyItemId = (int)($body['paddy_item_id'] ?? 0);

                $lotStmt = $pdo->prepare(
                    "SELECT l.remaining_qty_kg, l.remaining_bags, l.unit_cost_per_kg, l.initial_qty_kg, l.source_type,
                            pp.bag_count AS purchase_bag_count, i.bag_weight_kg
                     FROM inventory_lots l
                     JOIN items i ON i.id = l.item_id
                     LEFT JOIN paddy_purchases pp ON l.source_type = 'PADDY_PURCHASE' AND pp.id = l.source_id
                     WHERE l.item_id = ? AND l.warehouse_id = ? AND l.remaining_qty_kg > 0.0001"
                );
                $lotStmt->execute([$paddyItemId, $sourceWhId]);
                $activeLots = $lotStmt->fetchAll();

                $stockWeightKg = 0.0;
                $stockBags     = 0;
                $stockValue    = 0.0;
                foreach ($activeLots as $l) {
                    $remQty = (float)($l['remaining_qty_kg'] ?? 0);
                    $stockWeightKg += $remQty;
                    $stockValue    += $remQty * (float)($l['unit_cost_per_kg'] ?? 0);
                    if ((int)($l['remaining_bags'] ?? 0) > 0) {
                        $stockBags += (int)$l['remaining_bags'];
                    } elseif ($l['source_type'] === 'PADDY_PURCHASE' && (int)($l['purchase_bag_count'] ?? 0) > 0 && (float)$l['initial_qty_kg'] > 0) {
                        $stockBags += (int)round(($remQty * (int)$l['purchase_bag_count']) / (float)$l['initial_qty_kg']);
                    } else {
                        $bw = (float)($l['bag_weight_kg'] ?? 60);
                        $stockBags += (int)round($remQty / ($bw > 0 ? $bw : 60.0));
                    }
                }

                $stockNetUnits = $stockWeightKg > $stockBags ? ($stockWeightKg - $stockBags) / $divisor : 0.0;
                $bagUnitRate   = $stockNetUnits > 0 ? round($stockValue / $stockNetUnits, 4) : 0.0;
                $addNetUnits   = round(($addKg - $addBags) / $divisor, 4);
                $formulaCost   = ($bagUnitRate > 0 && $addNetUnits > 0) ? round($bagUnitRate * $addNetUnits, 2) : 0.0;

                $consumed = ErpEngine::consumeWarehouseStock($pdo, [
                    'itemId'        => $paddyItemId,
                    'warehouseId'   => $sourceWhId,
                    'qtyKg'         => $addKg,
                    'bagCount'      => $addBags,
                    'costingMethod' => $costingMethod,
                    'movementType'  => 'PRODUCTION_INPUT',
                    'referenceType' => 'PRODUCTION_BATCH',
                    'referenceId'   => $batchId,
                    'employeeId'    => $empId,
                ]);
                $addCost = $formulaCost > 0 ? $formulaCost : $consumed['totalCost'];

                $pdo->prepare(
                    'INSERT INTO production_batch_inputs (
                        batch_id, source_warehouse_id, paddy_item_id, bag_count, qty_kg, unit_divisor, net_units, bag_unit_rate, paddy_cost, notes, created_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                )->execute([
                    $batchId,
                    $sourceWhId,
                    $paddyItemId,
                    $addBags,
                    $addKg,
                    $divisor,
                    $addNetUnits,
                    $bagUnitRate,
                    $addCost,
                    trim((string)($body['notes'] ?? '')) ?: 'অতিরিক্ত ধান ডায়ারে যোগ',
                    $empId,
                ]);

                $pdo->prepare(
                    'UPDATE production_batches
                     SET input_paddy_qty_kg = input_paddy_qty_kg + ?,
                         input_bag_count = input_bag_count + ?,
                         paddy_net_units = paddy_net_units + ?,
                         paddy_formula_cost = paddy_formula_cost + ?
                     WHERE id = ?'
                )->execute([$addKg, $addBags, $addNetUnits, $addCost, $batchId]);

                $sStmt = $pdo->prepare('SELECT * FROM production_cost_sheets WHERE batch_id = ?');
                $sStmt->execute([$batchId]);
                $sheet = $sStmt->fetch();
                $newRaw   = round((float)($sheet['raw_paddy_cost'] ?? 0) + $addCost, 2);
                $newGross = round(
                    $newRaw
                    + (float)($sheet['labor_cost'] ?? 0)
                    + (float)($sheet['electricity_cost'] ?? 0)
                    + (float)($sheet['fuel_boiler_cost'] ?? 0)
                    + (float)($sheet['machinery_overhead_cost'] ?? 0)
                    + (float)($sheet['packaging_cost'] ?? 0),
                    2
                );
                $pdo->prepare('UPDATE production_cost_sheets SET raw_paddy_cost = ?, gross_batch_cost = ?, net_head_rice_cost = ? WHERE batch_id = ?')
                    ->execute([$newRaw, $newGross, max(0.0, $newGross - (float)($sheet['byproduct_credit_value'] ?? 0)), $batchId]);

                ErpEngine::writeAudit($pdo, $empId, $empName, 'CRUSHING_EXTRA_PADDY_ADDED', 'PRODUCTION_BATCH', (string)$batch['batch_no'], null, [
                    'addBags' => $addBags,
                    'addKg'   => $addKg,
                    'addCost' => $addCost,
                    'newRaw'  => $newRaw,
                ], $clientType);

                return ['status' => 'OK', 'batch' => $getEnrichedProductionBatch($batchId)];
            });
            Auth::jsonResponse($result);
        } catch (InsufficientStockException $e) {
            Auth::abort(409, $e->getMessage(), ['code' => 'INSUFFICIENT_STOCK']);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if (preg_match('#^/api/v1/production-batches/(\d+)/complete$#', $uri, $m) && $method === 'POST') {
        Auth::requirePermission($emp, 'production.manage');
        $batchId = (int)$m[1];

        $bStmt = $pdo->prepare('SELECT * FROM production_batches WHERE id = ?');
        $bStmt->execute([$batchId]);
        $batch = $bStmt->fetch();
        if (!$batch) {
            Auth::abort(404, 'Production batch not found');
        }
        if ($batch['status'] === 'COMPLETED') {
            Auth::abort(400, 'Production batch is already completed');
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use (
                $pdo, $body, $batchId, $batch, $empId, $empName, $clientType, $getEnrichedProductionBatch
            ): array {
                $sStmt = $pdo->prepare('SELECT * FROM production_cost_sheets WHERE batch_id = ?');
                $sStmt->execute([$batchId]);
                $sheet = $sStmt->fetch() ?: [];

                $headItemDefault = (int)($body['head_rice_item_id'] ?? 0);
                $riceWhDefault   = (int)($body['rice_warehouse_id'] ?? 0);
                $bypWhDefault    = (int)($body['byproduct_warehouse_id'] ?? 0);

                $headPacksRaw = [];
                if (!empty($body['head_rice_packs']) && is_array($body['head_rice_packs'])) {
                    foreach ($body['head_rice_packs'] as $p) {
                        $packSize = ((float)($p['pack_size_kg'] ?? 50)) > 0 ? (float)$p['pack_size_kg'] : 50.0;
                        $bags     = max(0, (int)round((float)($p['bag_count'] ?? 0)));
                        $qty      = !empty($p['qty_kg']) && (float)$p['qty_kg'] > 0
                            ? (float)$p['qty_kg']
                            : round($bags * $packSize, 3);
                        if ($qty <= 0) {
                            continue;
                        }
                        $headPacksRaw[] = [
                            'item_id'      => (int)($p['item_id'] ?? $headItemDefault),
                            'warehouse_id' => (int)($p['warehouse_id'] ?? $riceWhDefault),
                            'pack_size_kg' => $packSize,
                            'bag_count'    => $bags > 0 ? $bags : (int)round($qty / $packSize),
                            'qty_kg'       => $qty,
                        ];
                    }
                } elseif ((float)($body['head_rice_qty_kg'] ?? 0) > 0) {
                    $q = (float)$body['head_rice_qty_kg'];
                    $headPacksRaw[] = [
                        'item_id'      => $headItemDefault,
                        'warehouse_id' => $riceWhDefault,
                        'pack_size_kg' => 50.0,
                        'bag_count'    => (int)round($q / 50),
                        'qty_kg'       => $q,
                    ];
                }

                $headRiceQty = round(array_sum(array_column($headPacksRaw, 'qty_kg')), 3);

                $brokenItem = $pdo->query("SELECT id, default_rate FROM items WHERE category = 'BROKEN_RICE' LIMIT 1")->fetch();
                $branItem   = $pdo->query("SELECT id, default_rate FROM items WHERE category = 'RICE_BRAN' LIMIT 1")->fetch();
                $huskItem   = $pdo->query("SELECT id, default_rate FROM items WHERE category = 'HUSK' LIMIT 1")->fetch();

                $secondaryResolved = [];
                if (!empty($body['secondary_outputs']) && is_array($body['secondary_outputs'])) {
                    foreach ($body['secondary_outputs'] as $row) {
                        $packSize = ((float)($row['pack_size_kg'] ?? 25)) > 0 ? (float)$row['pack_size_kg'] : 25.0;
                        $bags     = max(0, (int)round((float)($row['bag_count'] ?? 0)));
                        $qtyKg    = !empty($row['qty_kg']) && (float)$row['qty_kg'] > 0
                            ? (float)$row['qty_kg']
                            : round($bags * $packSize, 3);
                        if ($qtyKg <= 0) {
                            continue;
                        }

                        $resolvedBags = $bags > 0 ? $bags : (int)round($qtyKg / $packSize);
                        $hasBagRate   = ($row['pricing_unit'] ?? '') === 'BAG' && (float)($row['rate_per_bag'] ?? 0) > 0 && $resolvedBags > 0;
                        $ratePerBag   = $hasBagRate
                            ? (float)$row['rate_per_bag']
                            : round(max(0.0, (float)($row['rate_per_kg'] ?? 0)) * $packSize, 2);
                        $val          = $hasBagRate
                            ? round($resolvedBags * $ratePerBag, 2)
                            : round($qtyKg * max(0.0, (float)($row['rate_per_kg'] ?? 0)), 2);
                        $ratePerKg    = $hasBagRate ? round($val / $qtyKg, 6) : max(0.0, (float)($row['rate_per_kg'] ?? 0));

                        $resolvedItemId = (int)($row['item_id'] ?? 0);
                        $resolvedCat    = (string)($row['category'] ?? 'BY_PRODUCT');

                        if ($resolvedItemId > 0) {
                            $chk = $pdo->prepare('SELECT id, category FROM items WHERE id = ?');
                            $chk->execute([$resolvedItemId]);
                            $existingItem = $chk->fetch();
                            if ($existingItem) {
                                $resolvedCat = (string)$existingItem['category'];
                            } else {
                                $resolvedItemId = 0;
                            }
                        }

                        if ($resolvedItemId <= 0) {
                            $cleanName = trim((string)($row['item_name'] ?? ''));
                            if ($cleanName === '') {
                                throw new RuntimeException('Each secondary output must have an item selected or a custom item name');
                            }
                            $byNameStmt = $pdo->prepare('SELECT id, category FROM items WHERE LOWER(name) = LOWER(?) LIMIT 1');
                            $byNameStmt->execute([$cleanName]);
                            $byName = $byNameStmt->fetch();
                            if ($byName) {
                                $resolvedItemId = (int)$byName['id'];
                                $resolvedCat    = (string)$byName['category'];
                            } else {
                                $itemSeq = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM items')->fetchColumn();
                                $sku     = 'BYP-OUT-' . str_pad((string)$itemSeq, 3, '0', STR_PAD_LEFT);
                                $insItem = $pdo->prepare(
                                    "INSERT INTO items (sku, name, category, process_grade, unit, bag_weight_kg, costing_method, default_rate, is_active)
                                     VALUES (?, ?, ?, 'BY_PRODUCT', 'KG', ?, 'WEIGHTED_AVERAGE', ?, 1)"
                                );
                                $insItem->execute([$sku, $cleanName, $resolvedCat, $packSize, $ratePerKg]);
                                $resolvedItemId = (int)$pdo->lastInsertId();
                            }
                        }

                        $secondaryResolved[] = [
                            'item_id'      => $resolvedItemId,
                            'category'     => $resolvedCat,
                            'warehouse_id' => (int)($row['warehouse_id'] ?? $bypWhDefault),
                            'pack_size_kg' => $packSize,
                            'bag_count'    => $resolvedBags,
                            'qty_kg'       => $qtyKg,
                            'rate_per_kg'  => $ratePerKg,
                            'rate_per_bag' => $ratePerBag,
                            'total_value'  => $val,
                        ];
                    }
                } else {
                    $brokenQty = (float)($body['broken_rice_qty_kg'] ?? 0);
                    $branQty   = (float)($body['bran_qty_kg'] ?? 0);
                    $huskQty   = (float)($body['husk_qty_kg'] ?? 0);
                    if ($brokenQty > 0 && $brokenItem) {
                        $r = (float)$brokenItem['default_rate'];
                        $secondaryResolved[] = [
                            'item_id' => (int)$brokenItem['id'], 'category' => 'BROKEN_RICE',
                            'warehouse_id' => $bypWhDefault, 'pack_size_kg' => 50.0,
                            'bag_count' => (int)round($brokenQty / 50), 'qty_kg' => $brokenQty,
                            'rate_per_kg' => $r, 'rate_per_bag' => round($r * 50, 2),
                            'total_value' => round($brokenQty * $r, 2),
                        ];
                    }
                    if ($branQty > 0 && $branItem) {
                        $r = (float)$branItem['default_rate'];
                        $secondaryResolved[] = [
                            'item_id' => (int)$branItem['id'], 'category' => 'RICE_BRAN',
                            'warehouse_id' => $bypWhDefault, 'pack_size_kg' => 50.0,
                            'bag_count' => (int)round($branQty / 50), 'qty_kg' => $branQty,
                            'rate_per_kg' => $r, 'rate_per_bag' => round($r * 50, 2),
                            'total_value' => round($branQty * $r, 2),
                        ];
                    }
                    if ($huskQty > 0 && $huskItem) {
                        $r = (float)$huskItem['default_rate'];
                        $secondaryResolved[] = [
                            'item_id' => (int)$huskItem['id'], 'category' => 'HUSK',
                            'warehouse_id' => $bypWhDefault, 'pack_size_kg' => 35.0,
                            'bag_count' => (int)round($huskQty / 35), 'qty_kg' => $huskQty,
                            'rate_per_kg' => $r, 'rate_per_bag' => round($r * 35, 2),
                            'total_value' => round($huskQty * $r, 2),
                        ];
                    }
                }

                $secondaryTotalKg = array_sum(array_column($secondaryResolved, 'qty_kg'));
                $totalOutput      = round($headRiceQty + $secondaryTotalKg, 3);
                $inputPaddyQty    = (float)$batch['input_paddy_qty_kg'];
                if ($headRiceQty <= 0 || $totalOutput > $inputPaddyQty + 0.01) {
                    throw new RuntimeException('Head rice must be positive and total output cannot exceed input paddy weight');
                }

                $brokenRiceQty   = 0.0;
                $branQty         = 0.0;
                $huskQty         = 0.0;
                $byproductCredit = 0.0;
                foreach ($secondaryResolved as $sec) {
                    if ($sec['category'] === 'BROKEN_RICE') {
                        $brokenRiceQty += $sec['qty_kg'];
                    } elseif ($sec['category'] === 'RICE_BRAN') {
                        $branQty += $sec['qty_kg'];
                    } elseif (in_array($sec['category'], ['HUSK', 'BY_PRODUCT'], true)) {
                        $huskQty += $sec['qty_kg'];
                    }
                    $byproductCredit += $sec['total_value'];
                }
                $byproductCredit = round($byproductCredit, 2);

                $addLabor = (float)($body['labor_cost'] ?? 0);
                $addElec  = (float)($body['electricity_cost'] ?? 0);
                $addFuel  = (float)($body['fuel_boiler_cost'] ?? 0);
                $addMach  = (float)($body['machinery_overhead_cost'] ?? 0);
                $addPack  = (float)($body['packaging_cost'] ?? 0);

                $labor = (float)($sheet['labor_cost'] ?? 0) + $addLabor;
                $elec  = (float)($sheet['electricity_cost'] ?? 0) + $addElec;
                $fuel  = (float)($sheet['fuel_boiler_cost'] ?? 0) + $addFuel;
                $mach  = (float)($sheet['machinery_overhead_cost'] ?? 0) + $addMach;
                $pack  = (float)($sheet['packaging_cost'] ?? 0) + $addPack;

                $grossBatchCost     = round((float)($sheet['raw_paddy_cost'] ?? 0) + $labor + $elec + $fuel + $mach + $pack, 2);
                $netHeadRiceCost    = max(0.0, round($grossBatchCost - $byproductCredit, 2));
                $costPerKgHeadRice  = round($netHeadRiceCost / $headRiceQty, 4);
                $costPerBagHeadRice = round($costPerKgHeadRice * 50, 2);

                $wastageKg        = max(0.0, round($inputPaddyQty - $totalOutput, 3));
                $headRiceYieldPct = round(($headRiceQty / $inputPaddyQty) * 100, 2);
                $totalRecoveryPct = round(($totalOutput / $inputPaddyQty) * 100, 2);

                $pdo->prepare(
                    "UPDATE production_batches
                     SET head_rice_qty_kg = ?, broken_rice_qty_kg = ?, bran_qty_kg = ?, husk_qty_kg = ?,
                         wastage_qty_kg = ?, head_rice_yield_pct = ?, total_recovery_pct = ?,
                         status = 'COMPLETED', completed_at = NOW()
                     WHERE id = ?"
                )->execute([$headRiceQty, $brokenRiceQty, $branQty, $huskQty, $wastageKg, $headRiceYieldPct, $totalRecoveryPct, $batchId]);

                $pdo->prepare(
                    'UPDATE production_cost_sheets
                     SET labor_cost = ?, electricity_cost = ?, fuel_boiler_cost = ?, machinery_overhead_cost = ?, packaging_cost = ?,
                         gross_batch_cost = ?, byproduct_credit_value = ?, net_head_rice_cost = ?,
                         cost_per_kg_head_rice = ?, cost_per_bag_head_rice = ?
                     WHERE batch_id = ?'
                )->execute([$labor, $elec, $fuel, $mach, $pack, $grossBatchCost, $byproductCredit, $netHeadRiceCost, $costPerKgHeadRice, $costPerBagHeadRice, $batchId]);

                $insOut = $pdo->prepare(
                    'INSERT INTO production_outputs (batch_id, item_id, warehouse_id, output_type, pack_size_kg, bag_count, qty_kg, rate_per_bag, allocated_unit_cost_per_kg, total_value, lot_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                );

                foreach ($headPacksRaw as $hp) {
                    $hpValue = round($hp['qty_kg'] * $costPerKgHeadRice, 2);
                    $headLot = ErpEngine::createInventoryLot($pdo, [
                        'prefix'        => 'LOT-RIC',
                        'itemId'        => $hp['item_id'],
                        'warehouseId'   => $hp['warehouse_id'],
                        'sourceType'    => 'PRODUCTION_OUTPUT',
                        'sourceId'      => $batchId,
                        'originBatchId' => $batchId,
                        'qtyKg'         => $hp['qty_kg'],
                        'bagCount'      => $hp['bag_count'],
                        'packSizeKg'    => $hp['pack_size_kg'],
                        'unitCostPerKg' => $costPerKgHeadRice,
                        'movementType'  => 'PRODUCTION_OUTPUT',
                        'employeeId'    => $empId,
                    ]);
                    $insOut->execute([
                        $batchId,
                        $hp['item_id'],
                        $hp['warehouse_id'],
                        'HEAD_RICE',
                        $hp['pack_size_kg'],
                        $hp['bag_count'],
                        $hp['qty_kg'],
                        round($costPerKgHeadRice * $hp['pack_size_kg'], 2),
                        $costPerKgHeadRice,
                        $hpValue,
                        $headLot['lotId'],
                    ]);
                }

                foreach ($secondaryResolved as $sec) {
                    $bLot = ErpEngine::createInventoryLot($pdo, [
                        'prefix'        => 'LOT-BYP',
                        'itemId'        => $sec['item_id'],
                        'warehouseId'   => $sec['warehouse_id'],
                        'sourceType'    => 'PRODUCTION_OUTPUT',
                        'sourceId'      => $batchId,
                        'originBatchId' => $batchId,
                        'qtyKg'         => $sec['qty_kg'],
                        'bagCount'      => $sec['bag_count'],
                        'packSizeKg'    => $sec['pack_size_kg'],
                        'unitCostPerKg' => $sec['rate_per_kg'],
                        'movementType'  => 'PRODUCTION_OUTPUT',
                        'employeeId'    => $empId,
                    ]);
                    $insOut->execute([
                        $batchId,
                        $sec['item_id'],
                        $sec['warehouse_id'],
                        $sec['category'],
                        $sec['pack_size_kg'],
                        $sec['bag_count'],
                        $sec['qty_kg'],
                        $sec['rate_per_bag'],
                        $sec['rate_per_kg'],
                        $sec['total_value'],
                        $bLot['lotId'],
                    ]);
                }

                $addOverhead = $addLabor + $addElec + $addFuel + $addMach + $addPack;
                if ($addOverhead > 0) {
                    $pdo->prepare(
                        "INSERT INTO production_batch_expenses (
                            batch_id, expense_category, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost, packaging_cost,
                            total_amount, payment_status, paid_amount, paid_at, notes, created_by
                        ) VALUES (?, 'GENERAL', ?, ?, ?, ?, ?, ?, 'PAID', ?, NOW(), ?, ?)"
                    )->execute([$batchId, $addLabor, $addElec, $addFuel, $addMach, $addPack, $addOverhead, $addOverhead, 'সমাপনী অতিরিক্ত খরচ', $empId]);

                    ErpEngine::postJournalEntry($pdo, [
                        'description'   => "Milling Overhead Capitalized - {$batch['batch_no']} ({$batch['process_type']})",
                        'referenceType' => 'PRODUCTION_BATCH',
                        'referenceId'   => $batchId,
                        'employeeId'    => $empId,
                        'lines'         => [
                            ['accountCode' => '1200', 'debit' => $addOverhead, 'credit' => 0],
                            ['accountCode' => '1001', 'debit' => 0, 'credit' => $addOverhead],
                        ],
                    ]);
                }

                ErpEngine::writeAudit($pdo, $empId, $empName, 'PRODUCTION_BATCH_COMPLETED', 'PRODUCTION_BATCH', (string)$batch['batch_no'], null, [
                    'head_rice_qty_kg' => $headRiceQty,
                    'byproduct_credit' => $byproductCredit,
                    'cost_per_kg'      => $costPerKgHeadRice,
                ], $clientType);

                return ['status' => 'COMPLETED', 'batch' => $getEnrichedProductionBatch($batchId)];
            });
            Auth::jsonResponse($result);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if (preg_match('#^/api/v1/production-batches/(\d+)/expenses$#', $uri, $m) && $method === 'POST') {
        Auth::requirePermission($emp, 'production.manage');
        $batchId = (int)$m[1];

        $bStmt = $pdo->prepare('SELECT * FROM production_batches WHERE id = ?');
        $bStmt->execute([$batchId]);
        $batch = $bStmt->fetch();
        if (!$batch) {
            Auth::abort(404, 'Production batch not found');
        }

        $addLabor = max(0.0, (float)($body['labor_cost'] ?? 0));
        $addElec  = max(0.0, (float)($body['electricity_cost'] ?? 0));
        $addFuel  = max(0.0, (float)($body['fuel_boiler_cost'] ?? 0));
        $addMach  = max(0.0, (float)($body['machinery_overhead_cost'] ?? 0));
        $addPack  = max(0.0, (float)($body['packaging_cost'] ?? 0));
        $addTotal = round($addLabor + $addElec + $addFuel + $addMach + $addPack, 2);

        if ($addTotal <= 0) {
            Auth::abort(400, 'Enter at least one positive expense amount');
        }

        $timing    = in_array($body['payment_timing'] ?? '', ['UNPAID', 'PARTIAL'], true) ? $body['payment_timing'] : 'PAID';
        $paidNow   = $timing === 'UNPAID' ? 0.0 : ($timing === 'PARTIAL' ? min($addTotal, max(0.0, (float)($body['paid_now'] ?? 0))) : $addTotal);
        $dueNow    = round($addTotal - $paidNow, 2);
        $payStatus = $paidNow <= 0 ? 'UNPAID' : ($dueNow <= 0.01 ? 'PAID' : 'PARTIAL');

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use (
                $pdo, $body, $batchId, $batch, $addLabor, $addElec, $addFuel, $addMach, $addPack,
                $addTotal, $paidNow, $dueNow, $payStatus, $empId, $empName, $clientType, $getEnrichedProductionBatch
            ): array {
                $sStmt = $pdo->prepare('SELECT * FROM production_cost_sheets WHERE batch_id = ?');
                $sStmt->execute([$batchId]);
                $sheet = $sStmt->fetch() ?: [];

                $labor = (float)($sheet['labor_cost'] ?? 0) + $addLabor;
                $elec  = (float)($sheet['electricity_cost'] ?? 0) + $addElec;
                $fuel  = (float)($sheet['fuel_boiler_cost'] ?? 0) + $addFuel;
                $mach  = (float)($sheet['machinery_overhead_cost'] ?? 0) + $addMach;
                $pack  = (float)($sheet['packaging_cost'] ?? 0) + $addPack;

                $grossBatchCost     = round((float)($sheet['raw_paddy_cost'] ?? 0) + $labor + $elec + $fuel + $mach + $pack, 2);
                $netHeadRiceCost    = max(0.0, round($grossBatchCost - (float)($sheet['byproduct_credit_value'] ?? 0), 2));
                $headQty            = (float)($batch['head_rice_qty_kg'] ?? 0);
                $costPerKgHeadRice  = $headQty > 0 ? round($netHeadRiceCost / $headQty, 4) : 0.0;
                $costPerBagHeadRice = $headQty > 0 ? round($costPerKgHeadRice * 50, 2) : 0.0;

                $pdo->prepare(
                    'UPDATE production_cost_sheets
                     SET labor_cost = ?, electricity_cost = ?, fuel_boiler_cost = ?, machinery_overhead_cost = ?, packaging_cost = ?,
                         gross_batch_cost = ?, net_head_rice_cost = ?, cost_per_kg_head_rice = ?, cost_per_bag_head_rice = ?
                     WHERE batch_id = ?'
                )->execute([$labor, $elec, $fuel, $mach, $pack, $grossBatchCost, $netHeadRiceCost, $costPerKgHeadRice, $costPerBagHeadRice, $batchId]);

                $payAccountCode = '1001';
                $resolvedAccId  = null;
                if ($paidNow > 0) {
                    if (!empty($body['account_id'])) {
                        $aStmt = $pdo->prepare('SELECT id, account_code FROM accounts WHERE id = ?');
                        $aStmt->execute([(int)$body['account_id']]);
                    } else {
                        $aStmt = $pdo->query("SELECT id, account_code FROM accounts WHERE account_code = '1001' LIMIT 1");
                    }
                    $acc = $aStmt->fetch();
                    if (!$acc) {
                        throw new RuntimeException('Cash/Bank account not found');
                    }
                    $payAccountCode = (string)$acc['account_code'];
                    $resolvedAccId  = (int)$acc['id'];
                }

                $category   = trim((string)($body['expense_category'] ?? 'GENERAL')) ?: 'GENERAL';
                $vendorName = trim((string)($body['vendor_name'] ?? ''));
                $paidAtSql  = $paidNow > 0 ? 'NOW()' : 'NULL';
                $insExp = $pdo->prepare(
                    "INSERT INTO production_batch_expenses (
                        batch_id, expense_category, vendor_name, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost, packaging_cost,
                        total_amount, payment_status, paid_amount, account_id, paid_at, notes, created_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, {$paidAtSql}, ?, ?)"
                );
                $insExp->execute([
                    $batchId,
                    $category,
                    $vendorName,
                    $addLabor,
                    $addElec,
                    $addFuel,
                    $addMach,
                    $addPack,
                    $addTotal,
                    $payStatus,
                    $paidNow,
                    $resolvedAccId,
                    trim((string)($body['notes'] ?? '')),
                    $empId,
                ]);
                $expenseId = (int)$pdo->lastInsertId();

                if ($paidNow > 0 && $resolvedAccId !== null) {
                    $paySeq    = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM production_expense_payments')->fetchColumn();
                    $receiptNo = 'EXPR-2026-' . str_pad((string)$paySeq, 4, '0', STR_PAD_LEFT);
                    $pdo->prepare(
                        'INSERT INTO production_expense_payments (receipt_no, expense_id, batch_id, account_id, amount, payment_mode, notes, paid_by)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                    )->execute([
                        $receiptNo,
                        $expenseId,
                        $batchId,
                        $resolvedAccId,
                        $paidNow,
                        $payAccountCode === '1002' ? 'BANK_TRANSFER' : 'CASH',
                        (string)($body['notes'] ?? 'Initial expense payment'),
                        $empId,
                    ]);
                }

                $pdo->exec("INSERT IGNORE INTO accounts (account_code, name, account_type, balance, is_system) VALUES ('2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0, 1)");

                $jeLines = [['accountCode' => '1200', 'debit' => $addTotal, 'credit' => 0]];
                if ($paidNow > 0) {
                    $jeLines[] = ['accountCode' => $payAccountCode, 'debit' => 0, 'credit' => $paidNow];
                }
                if ($dueNow > 0) {
                    $jeLines[] = ['accountCode' => '2002', 'debit' => 0, 'credit' => $dueNow];
                }

                ErpEngine::postJournalEntry($pdo, [
                    'description'   => "Milling Expense ({$category}) - {$batch['batch_no']}" . ($vendorName !== '' ? " · {$vendorName}" : '') . (!empty($body['notes']) ? " ({$body['notes']})" : ''),
                    'referenceType' => 'PRODUCTION_BATCH',
                    'referenceId'   => $batchId,
                    'employeeId'    => $empId,
                    'lines'         => $jeLines,
                ]);

                ErpEngine::writeAudit($pdo, $empId, $empName, 'PRODUCTION_EXPENSE_ADDED', 'PRODUCTION_BATCH', (string)$batch['batch_no'], null, [
                    'category'       => $category,
                    'vendorName'     => $vendorName,
                    'addTotal'       => $addTotal,
                    'paidNow'        => $paidNow,
                    'dueNow'         => $dueNow,
                    'payStatus'      => $payStatus,
                    'grossBatchCost' => $grossBatchCost,
                ], $clientType);

                $updatedBatch = $getEnrichedProductionBatch($batchId);
                return [
                    'status'       => 'OK',
                    'cost_sheet'   => $updatedBatch['cost_sheet'] ?? null,
                    'expense_logs' => $updatedBatch['expense_logs'] ?? [],
                    'batch'        => $updatedBatch,
                ];
            });
            Auth::jsonResponse($result);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if (preg_match('#^/api/v1/production-batches/(\d+)/expenses/(\d+)/pay$#', $uri, $m) && $method === 'POST') {
        Auth::requirePermission($emp, 'production.manage');
        $batchId = (int)$m[1];
        $expId   = (int)$m[2];

        $eStmt = $pdo->prepare('SELECT * FROM production_batch_expenses WHERE id = ? AND batch_id = ?');
        $eStmt->execute([$expId, $batchId]);
        $expense = $eStmt->fetch();
        if (!$expense) {
            Auth::abort(404, 'Expense entry not found for this batch');
        }

        $bStmt = $pdo->prepare('SELECT id, batch_no FROM production_batches WHERE id = ?');
        $bStmt->execute([$batchId]);
        $batch = $bStmt->fetch();
        if (!$batch) {
            Auth::abort(404, 'Production batch not found');
        }

        $openDue = round((float)($expense['total_amount'] ?? 0) - (float)($expense['paid_amount'] ?? 0), 2);
        if ($openDue <= 0.01) {
            Auth::abort(400, 'This expense is already fully paid');
        }

        $payAmount = !empty($body['amount']) && (float)$body['amount'] > 0
            ? min($openDue, round((float)$body['amount'], 2))
            : $openDue;

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use (
                $pdo, $body, $batchId, $expId, $expense, $batch, $payAmount, $empId, $empName, $clientType, $getEnrichedProductionBatch
            ): array {
                if (!empty($body['account_id'])) {
                    $aStmt = $pdo->prepare('SELECT id, account_code, name FROM accounts WHERE id = ?');
                    $aStmt->execute([(int)$body['account_id']]);
                } else {
                    $aStmt = $pdo->query("SELECT id, account_code, name FROM accounts WHERE account_code = '1001' LIMIT 1");
                }
                $acc = $aStmt->fetch();
                if (!$acc) {
                    throw new RuntimeException('Selected payment account not found');
                }

                $nextPaid   = round((float)($expense['paid_amount'] ?? 0) + $payAmount, 2);
                $nextStatus = $nextPaid >= (float)$expense['total_amount'] - 0.01 ? 'PAID' : 'PARTIAL';

                $pdo->prepare(
                    'UPDATE production_batch_expenses
                     SET paid_amount = ?, payment_status = ?, account_id = ?, paid_at = NOW()
                     WHERE id = ?'
                )->execute([$nextPaid, $nextStatus, (int)$acc['id'], $expId]);

                $paySeq    = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM production_expense_payments')->fetchColumn();
                $receiptNo = 'EXPR-2026-' . str_pad((string)$paySeq, 4, '0', STR_PAD_LEFT);
                $payMode   = (string)($body['payment_mode'] ?? ($acc['account_code'] === '1002' ? 'BANK_TRANSFER' : 'CASH'));

                $insPay = $pdo->prepare(
                    'INSERT INTO production_expense_payments (receipt_no, expense_id, batch_id, account_id, amount, payment_mode, reference_no, notes, paid_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
                );
                $insPay->execute([
                    $receiptNo,
                    $expId,
                    $batchId,
                    (int)$acc['id'],
                    $payAmount,
                    $payMode,
                    trim((string)($body['reference_no'] ?? '')),
                    trim((string)($body['notes'] ?? '')) ?: 'বাকি খরচ পরিশোধ',
                    $empId,
                ]);
                $newPayId = (int)$pdo->lastInsertId();

                $pdo->exec("INSERT IGNORE INTO accounts (account_code, name, account_type, balance, is_system) VALUES ('2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0, 1)");

                ErpEngine::postJournalEntry($pdo, [
                    'description'   => "Milling Due Expense Paid ({$receiptNo}) - {$batch['batch_no']}" . (!empty($expense['vendor_name']) ? " ({$expense['vendor_name']})" : ''),
                    'referenceType' => 'PRODUCTION_EXPENSE_PAYMENT',
                    'referenceId'   => $expId,
                    'employeeId'    => $empId,
                    'lines'         => [
                        ['accountCode' => '2002', 'debit' => $payAmount, 'credit' => 0],
                        ['accountCode' => (string)$acc['account_code'], 'debit' => 0, 'credit' => $payAmount],
                    ],
                ]);

                ErpEngine::writeAudit($pdo, $empId, $empName, 'PRODUCTION_EXPENSE_PAID', 'PRODUCTION_BATCH', (string)$batch['batch_no'], null, [
                    'receipt_no' => $receiptNo,
                    'expense_id' => $expId,
                    'payAmount'  => $payAmount,
                    'nextPaid'   => $nextPaid,
                    'nextStatus' => $nextStatus,
                    'account'    => $acc['name'],
                ], $clientType);

                $rStmt = $pdo->prepare(
                    'SELECT pep.*, a.name AS account_name, emp.full_name AS paid_by_name,
                            pbe.expense_category, pbe.vendor_name, pbe.total_amount AS expense_total
                     FROM production_expense_payments pep
                     JOIN production_batch_expenses pbe ON pbe.id = pep.expense_id
                     JOIN accounts a ON a.id = pep.account_id
                     LEFT JOIN employees emp ON emp.id = pep.paid_by
                     WHERE pep.id = ?'
                );
                $rStmt->execute([$newPayId]);
                $receipt = $rStmt->fetch();
                if ($receipt) {
                    $receipt['amount']        = (float)$receipt['amount'];
                    $receipt['expense_total'] = (float)$receipt['expense_total'];
                }

                return ['status' => 'PAID', 'receipt' => $receipt, 'batch' => $getEnrichedProductionBatch($batchId)];
            });
            Auth::jsonResponse($result);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    // -----------------------------------------------------------------------
    // 10. Rice & By-Product Sales Invoices
    // -----------------------------------------------------------------------
    if ($uri === '/api/v1/sales-invoices' && $method === 'GET') {
        Auth::rejectPhysicalOnlyUser($emp);
        $invoices = $pdo->query(
            'SELECT s.*, pt.name AS customer_name
             FROM sales_invoices s
             JOIN parties pt ON pt.id = s.customer_id
             ORDER BY s.id DESC'
        )->fetchAll();

        $lineStmt = $pdo->prepare(
            'SELECT sii.*, i.name AS item_name, w.name AS warehouse_name
             FROM sales_invoice_items sii
             JOIN items i ON i.id = sii.item_id
             JOIN warehouses w ON w.id = sii.warehouse_id
             WHERE sii.invoice_id = ?'
        );
        foreach ($invoices as &$inv) {
            foreach (['subtotal_amount', 'tax_amount', 'discount_amount', 'total_amount', 'total_cogs', 'paid_amount'] as $k) {
                $inv[$k] = (float)$inv[$k];
            }
            $lineStmt->execute([(int)$inv['id']]);
            $items = $lineStmt->fetchAll();
            foreach ($items as &$it) {
                $it['bag_count']    = (int)$it['bag_count'];
                $it['pack_size_kg'] = (float)$it['pack_size_kg'];
                $it['rate_per_bag'] = (float)$it['rate_per_bag'];
                $it['qty_kg']       = (float)$it['qty_kg'];
                $it['rate_per_kg']  = (float)$it['rate_per_kg'];
                $it['line_total']   = (float)$it['line_total'];
                $it['line_cogs']    = (float)$it['line_cogs'];
            }
            unset($it);
            $inv['items'] = $items;
        }
        unset($inv);

        Auth::jsonResponse(['invoices' => $invoices]);
    }

    if ($uri === '/api/v1/sales-invoices' && $method === 'POST') {
        Auth::requirePermission($emp, 'rice.sale.create');
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        if (empty($body['customer_id']) || empty($body['items']) || !is_array($body['items'])) {
            Auth::abort(400, 'Customer and at least one invoice line item are required');
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $body, $clientUuid, $empId, $empName, $clientType): array {
                $seq       = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM sales_invoices')->fetchColumn();
                $invoiceNo = 'INV-2026-' . str_pad((string)$seq, 4, '0', STR_PAD_LEFT);
                $qrUid     = ErpEngine::uuidV4();
                $custId    = (int)$body['customer_id'];

                $getItemBagWt   = $pdo->prepare('SELECT bag_weight_kg FROM items WHERE id = ?');
                $getLotPackSize = $pdo->prepare('SELECT pack_size_kg FROM inventory_lots WHERE id = ?');

                $resolvedLines = [];
                $subtotal      = 0.0;
                foreach ($body['items'] as $line) {
                    $itemId    = (int)($line['item_id'] ?? 0);
                    $whId      = (int)($line['warehouse_id'] ?? 0);
                    $bagCount  = max(0, (int)round((float)($line['bag_count'] ?? 0)));
                    $prefLot   = !empty($line['preferred_lot_id']) ? (int)$line['preferred_lot_id'] : null;
                    $prefBatch = !empty($line['preferred_batch_id']) ? (int)$line['preferred_batch_id'] : null;

                    $lotPack = 0.0;
                    if ($prefLot) {
                        $getLotPackSize->execute([$prefLot]);
                        $lotPack = (float)($getLotPackSize->fetchColumn() ?: 0);
                    }
                    $getItemBagWt->execute([$itemId]);
                    $itemBagWt = (float)($getItemBagWt->fetchColumn() ?: 0);

                    $packSizeKg = !empty($line['pack_size_kg']) && (float)$line['pack_size_kg'] > 0
                        ? (float)$line['pack_size_kg']
                        : ($lotPack > 0 ? $lotPack : ($itemBagWt > 0 ? $itemBagWt : 50.0));

                    $ratePerBagInput = (float)($line['rate_per_bag'] ?? 0);
                    $qtyKg           = !empty($line['qty_kg']) && (float)$line['qty_kg'] > 0
                        ? (float)$line['qty_kg']
                        : round($bagCount * $packSizeKg, 3);
                    if ($qtyKg <= 0) {
                        throw new RuntimeException('Line item weight / bag quantity must be greater than zero');
                    }

                    $usesBagPricing = $bagCount > 0 && $ratePerBagInput > 0;
                    $lineTotal      = $usesBagPricing
                        ? round($bagCount * $ratePerBagInput, 2)
                        : round($qtyKg * (float)($line['rate_per_kg'] ?? 0), 2);
                    $ratePerKg      = $usesBagPricing
                        ? round($lineTotal / $qtyKg, 4)
                        : (float)($line['rate_per_kg'] ?? 0);
                    $ratePerBag     = $usesBagPricing
                        ? $ratePerBagInput
                        : ($bagCount > 0 ? round($lineTotal / $bagCount, 2) : 0.0);

                    $subtotal += $lineTotal;
                    $resolvedLines[] = [
                        'item_id'            => $itemId,
                        'warehouse_id'       => $whId,
                        'preferred_lot_id'   => $prefLot,
                        'preferred_batch_id' => $prefBatch,
                        'costing_method'     => (string)($line['costing_method'] ?? 'FIFO'),
                        'bagCount'           => $bagCount,
                        'packSizeKg'         => $packSizeKg,
                        'ratePerBag'         => $ratePerBag,
                        'qtyKg'              => $qtyKg,
                        'ratePerKg'          => $ratePerKg,
                        'lineTotal'          => $lineTotal,
                    ];
                }

                $subtotal    = round($subtotal, 2);
                $tax         = (float)($body['tax_amount'] ?? 0);
                $discount    = (float)($body['discount_amount'] ?? 0);
                $totalAmount = max(0.0, round($subtotal + $tax - $discount, 2));
                $paidAmt     = min($totalAmount, max(0.0, (float)($body['paid_amount'] ?? 0)));
                $payStatus   = $paidAmt <= 0 ? 'UNPAID' : ($paidAmt >= $totalAmount ? 'PAID' : 'PARTIAL');

                $insInv = $pdo->prepare(
                    'INSERT INTO sales_invoices (
                        client_uuid, invoice_no, customer_id, subtotal_amount, tax_amount, discount_amount,
                        total_amount, total_cogs, paid_amount, payment_status, vehicle_no, qr_code_uid, created_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)'
                );
                $insInv->execute([
                    $clientUuid,
                    $invoiceNo,
                    $custId,
                    $subtotal,
                    $tax,
                    $discount,
                    $totalAmount,
                    $paidAmt,
                    $payStatus,
                    (string)($body['vehicle_no'] ?? ''),
                    $qrUid,
                    $empId,
                ]);
                $invoiceId = (int)$pdo->lastInsertId();
                $totalCogs = 0.0;

                $insLine = $pdo->prepare(
                    'INSERT INTO sales_invoice_items (
                        invoice_id, item_id, warehouse_id, bag_count, pack_size_kg, rate_per_bag,
                        qty_kg, rate_per_kg, line_total, costing_method, line_cogs
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                );
                $insAlloc = $pdo->prepare(
                    'INSERT INTO sales_invoice_lot_allocations (
                        invoice_id, invoice_item_id, lot_id, batch_id, item_id, qty_kg, bag_count,
                        cost_per_kg, cost_amount, sale_rate_per_kg, sale_amount, profit_amount
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                );

                foreach ($resolvedLines as $line) {
                    $consumed = ErpEngine::consumeWarehouseStock($pdo, [
                        'itemId'           => $line['item_id'],
                        'warehouseId'      => $line['warehouse_id'],
                        'qtyKg'            => $line['qtyKg'],
                        'bagCount'         => $line['bagCount'] > 0 ? $line['bagCount'] : null,
                        'preferredLotId'   => $line['preferred_lot_id'],
                        'preferredBatchId' => $line['preferred_batch_id'],
                        'costingMethod'    => $line['costing_method'],
                        'movementType'     => 'RICE_SALE_OUT',
                        'referenceType'    => 'SALES_INVOICE',
                        'referenceId'      => $invoiceId,
                        'employeeId'       => $empId,
                    ]);

                    $insLine->execute([
                        $invoiceId,
                        $line['item_id'],
                        $line['warehouse_id'],
                        $line['bagCount'],
                        $line['packSizeKg'],
                        $line['ratePerBag'],
                        $line['qtyKg'],
                        $line['ratePerKg'],
                        $line['lineTotal'],
                        $line['costing_method'],
                        $consumed['totalCost'],
                    ]);
                    $invoiceItemId = (int)$pdo->lastInsertId();

                    $allocatedSaleTotal = 0.0;
                    $lotCount           = count($consumed['consumedLots']);
                    for ($idx = 0; $idx < $lotCount; $idx++) {
                        $ld            = $consumed['consumedLots'][$idx];
                        $linkedBatchId = $ld['origin_batch_id'] !== null
                            ? (int)$ld['origin_batch_id']
                            : ($ld['source_type'] === 'PRODUCTION_OUTPUT' && $ld['source_id'] ? (int)$ld['source_id'] : null);
                        $isLast        = ($idx === $lotCount - 1);
                        $saleAmt       = $isLast
                            ? round($line['lineTotal'] - $allocatedSaleTotal, 2)
                            : round(($ld['qty_taken_kg'] / $line['qtyKg']) * $line['lineTotal'], 2);
                        $allocatedSaleTotal += $saleAmt;
                        $costAmt   = round((float)$ld['cost_amount'], 2);
                        $profitAmt = round($saleAmt - $costAmt, 2);

                        $insAlloc->execute([
                            $invoiceId,
                            $invoiceItemId,
                            $ld['lot_id'],
                            $linkedBatchId,
                            $line['item_id'],
                            $ld['qty_taken_kg'],
                            $ld['bags_taken'],
                            $ld['unit_cost_per_kg'],
                            $costAmt,
                            $line['ratePerKg'],
                            $saleAmt,
                            $profitAmt,
                        ]);
                    }

                    $totalCogs += $consumed['totalCost'];
                }

                $totalCogs = round($totalCogs, 2);
                $pdo->prepare('UPDATE sales_invoices SET total_cogs = ? WHERE id = ?')->execute([$totalCogs, $invoiceId]);
                $dueAmt = $totalAmount - $paidAmt;
                $pdo->prepare('UPDATE parties SET current_balance = current_balance + ? WHERE id = ?')->execute([$dueAmt, $custId]);

                $jeLines = [
                    ['accountCode' => '1100', 'debit' => $dueAmt, 'credit' => 0, 'partyId' => $custId],
                    ['accountCode' => '4001', 'debit' => 0, 'credit' => $totalAmount],
                    ['accountCode' => '5001', 'debit' => $totalCogs, 'credit' => 0],
                    ['accountCode' => '1200', 'debit' => 0, 'credit' => $totalCogs],
                ];
                if ($paidAmt > 0) {
                    $jeLines[] = ['accountCode' => '1001', 'debit' => $paidAmt, 'credit' => 0, 'partyId' => $custId];
                }
                ErpEngine::postJournalEntry($pdo, [
                    'description'   => "Sales Invoice {$invoiceNo}",
                    'referenceType' => 'SALES_INVOICE',
                    'referenceId'   => $invoiceId,
                    'employeeId'    => $empId,
                    'lines'         => $jeLines,
                ]);

                $cStmt = $pdo->prepare('SELECT name FROM parties WHERE id = ?');
                $cStmt->execute([$custId]);
                $custName = (string)($cStmt->fetchColumn() ?: $custId);

                ErpEngine::registerQrTag($pdo, $qrUid, 'SALES_INVOICE', $invoiceId, $invoiceNo, [
                    'invoice_no' => $invoiceNo,
                    'customer'   => $custName,
                    'total'      => $totalAmount,
                    'vehicle'    => (string)($body['vehicle_no'] ?? ''),
                ]);

                ErpEngine::writeAudit($pdo, $empId, $empName, 'SALES_INVOICE_CREATED', 'SALES_INVOICE', $invoiceNo, null, [
                    'customer'     => $custName,
                    'total_amount' => $totalAmount,
                    'total_cogs'   => $totalCogs,
                ], $clientType);

                $iStmt = $pdo->prepare('SELECT s.*, pt.name AS customer_name FROM sales_invoices s JOIN parties pt ON pt.id = s.customer_id WHERE s.id = ?');
                $iStmt->execute([$invoiceId]);
                $created = $iStmt->fetch() ?: [];

                $lStmt = $pdo->prepare(
                    'SELECT sii.*, i.name AS item_name, w.name AS warehouse_name
                     FROM sales_invoice_items sii
                     JOIN items i ON i.id = sii.item_id
                     JOIN warehouses w ON w.id = sii.warehouse_id
                     WHERE sii.invoice_id = ?'
                );
                $lStmt->execute([$invoiceId]);
                $created['items'] = $lStmt->fetchAll();

                $responseObj = ['status' => 'SYNCED', 'invoice' => $created];
                ErpEngine::recordSyncLog($pdo, $clientUuid, (string)($body['device_id'] ?? 'WEB-BROWSER'), $clientType, '/api/v1/sales-invoices', 'SYNCED', null, $responseObj, $empId);
                return $responseObj;
            });
            Auth::jsonResponse($result, 201);
        } catch (InsufficientStockException $e) {
            ErpEngine::recordSyncLog($pdo, $clientUuid, (string)($body['device_id'] ?? 'WEB-BROWSER'), $clientType, '/api/v1/sales-invoices', 'CONFLICT', $e->getMessage(), null, $empId);
            Auth::abort(409, $e->getMessage(), ['code' => 'INSUFFICIENT_STOCK']);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    // -----------------------------------------------------------------------
    // 11. Weighbridge Scale Logs & QR Traceability Lookup
    // -----------------------------------------------------------------------
    if ($uri === '/api/v1/weighbridge-logs' && $method === 'GET') {
        $logs = $pdo->query(
            'SELECT wl.*, e.full_name AS operator_name
             FROM weighbridge_logs wl
             JOIN employees e ON e.id = wl.operator_id
             ORDER BY wl.id DESC LIMIT 100'
        )->fetchAll();
        foreach ($logs as &$l) {
            $l['gross_weight_kg'] = (float)$l['gross_weight_kg'];
            $l['tare_weight_kg']  = (float)$l['tare_weight_kg'];
            $l['net_weight_kg']   = (float)$l['net_weight_kg'];
        }
        unset($l);
        Auth::jsonResponse(['logs' => $logs]);
    }

    if ($uri === '/api/v1/weighbridge-logs' && $method === 'POST') {
        Auth::requirePermission($emp, 'weighbridge.operate');
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        $gross = (float)($body['gross_weight_kg'] ?? 0);
        $tare  = (float)($body['tare_weight_kg'] ?? 0);
        $net   = round($gross - $tare, 3);
        if ($net <= 0) {
            Auth::abort(400, 'Net weight (Gross - Tare) must be positive');
        }

        $seq      = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM weighbridge_logs')->fetchColumn();
        $ticketNo = 'WB-2026-' . str_pad((string)(100 + $seq), 4, '0', STR_PAD_LEFT);

        $ins = $pdo->prepare(
            'INSERT INTO weighbridge_logs (client_uuid, ticket_no, vehicle_no, driver_name, gross_weight_kg, tare_weight_kg, net_weight_kg, device_mode, raw_device_string, operator_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $ins->execute([
            $clientUuid,
            $ticketNo,
            strtoupper(trim((string)($body['vehicle_no'] ?? ''))),
            (string)($body['driver_name'] ?? ''),
            $gross,
            $tare,
            $net,
            (string)($body['device_mode'] ?? 'MANUAL'),
            (string)($body['raw_device_string'] ?? 'MANUAL_ENTRY'),
            $empId,
        ]);
        $logId = (int)$pdo->lastInsertId();

        $sel = $pdo->prepare('SELECT wl.*, e.full_name AS operator_name FROM weighbridge_logs wl JOIN employees e ON e.id = wl.operator_id WHERE wl.id = ?');
        $sel->execute([$logId]);
        $created = $sel->fetch();

        $responseObj = ['status' => 'SYNCED', 'log' => $created];
        ErpEngine::recordSyncLog($pdo, $clientUuid, 'WEIGHBRIDGE-TERMINAL', 'WEB_PWA', '/api/v1/weighbridge-logs', 'SYNCED', null, $responseObj, $empId);
        Auth::jsonResponse($responseObj, 201);
    }

    if ($uri === '/api/v1/qr/lookup' && $method === 'GET') {
        $code = trim((string)($_GET['code'] ?? ''));
        if ($code === '') {
            Auth::abort(400, 'QR UID or entity code is required');
        }
        $physicalOnly = Auth::isPhysicalOnlyUser($emp);

        $stmt = $pdo->prepare('SELECT * FROM qr_tags WHERE qr_code_uid = ? OR entity_code = ? LIMIT 1');
        $stmt->execute([$code, $code]);
        $tag = $stmt->fetch();
        if ($tag) {
            if ($physicalOnly && in_array($tag['entity_type'], ['SALES_INVOICE', 'PADDY_SALE', 'PRODUCTION_BATCH'], true)) {
                Auth::abort(403, 'Commercial dispatch and milling cost QR records are restricted for Godown Keeper');
            }

            $parsedPayload = json_decode((string)$tag['payload_json'], true) ?? [];
            Auth::jsonResponse([
                'qr_code_uid' => $tag['qr_code_uid'],
                'entity_type' => $tag['entity_type'],
                'entity_id'   => (int)$tag['entity_id'],
                'entity_code' => $tag['entity_code'],
                'payload'     => $physicalOnly ? Auth::sanitizeQrPayloadForPhysical($parsedPayload) : $parsedPayload,
                'created_at'  => $tag['created_at'],
            ]);
        }

        $lotStmt = $pdo->prepare(
            "SELECT l.*, i.name AS item_name, i.sku, i.category, i.process_grade, i.bag_weight_kg,
                    w.name AS warehouse_name, w.code AS warehouse_code,
                    pb.batch_no AS origin_batch_no, pb.dryer_no AS origin_dryer_no
             FROM inventory_lots l
             JOIN items i ON i.id = l.item_id
             JOIN warehouses w ON w.id = l.warehouse_id
             LEFT JOIN production_batches pb ON pb.id = COALESCE(l.origin_batch_id, CASE WHEN l.source_type = 'PRODUCTION_OUTPUT' THEN l.source_id ELSE NULL END)
             WHERE l.qr_code_uid = ? OR l.lot_code = ?
             LIMIT 1"
        );
        $lotStmt->execute([$code, $code]);
        $lot = $lotStmt->fetch();
        if (!$lot) {
            Auth::abort(404, "No lot, batch, or dispatch record found for QR \"{$code}\"");
        }

        $lotPayload = [
            'lot_code'         => $lot['lot_code'],
            'item'             => $lot['item_name'],
            'sku'              => $lot['sku'],
            'category'         => $lot['category'],
            'process_grade'    => $lot['process_grade'],
            'warehouse'        => "{$lot['warehouse_name']} ({$lot['warehouse_code']})",
            'source_type'      => $lot['source_type'],
            'remaining_qty_kg' => (float)$lot['remaining_qty_kg'],
            'initial_qty_kg'   => (float)$lot['initial_qty_kg'],
            'remaining_bags'   => (int)$lot['remaining_bags'],
            'pack_size_kg'     => (float)($lot['pack_size_kg'] ?: $lot['bag_weight_kg'] ?: 50),
            'unit_cost_per_kg' => (float)$lot['unit_cost_per_kg'],
            'received_at'      => $lot['received_at'],
        ];
        if (!empty($lot['origin_batch_no'])) {
            $lotPayload['origin_batch_no'] = $lot['origin_batch_no'];
        }
        if (!empty($lot['origin_dryer_no'])) {
            $lotPayload['origin_dryer_no'] = $lot['origin_dryer_no'];
        }
        if ($lot['moisture_pct'] !== null) {
            $lotPayload['moisture_pct'] = (float)$lot['moisture_pct'];
        }

        Auth::jsonResponse([
            'qr_code_uid' => (string)$lot['qr_code_uid'],
            'entity_type' => 'LOT',
            'entity_id'   => (int)$lot['id'],
            'entity_code' => (string)$lot['lot_code'],
            'payload'     => $physicalOnly ? Auth::sanitizeQrPayloadForPhysical($lotPayload) : $lotPayload,
            'created_at'  => (string)$lot['received_at'],
        ]);
    }

    if ($uri === '/api/v1/qr/registry' && $method === 'GET') {
        $physicalOnly = Auth::isPhysicalOnlyUser($emp);
        $rows = $pdo->query('SELECT * FROM qr_tags ORDER BY created_at DESC LIMIT 50')->fetchAll();
        $tags = [];
        foreach ($rows as $r) {
            if ($physicalOnly && in_array($r['entity_type'], ['SALES_INVOICE', 'PADDY_SALE', 'PRODUCTION_BATCH'], true)) {
                continue;
            }
            $parsed      = json_decode((string)$r['payload_json'], true) ?? [];
            $safePayload = $physicalOnly ? Auth::sanitizeQrPayloadForPhysical($parsed) : $parsed;
            $tags[]      = array_merge($r, [
                'entity_id'    => (int)$r['entity_id'],
                'payload_json' => json_encode($safePayload, JSON_UNESCAPED_UNICODE),
                'payload'      => $safePayload,
            ]);
        }
        Auth::jsonResponse(['tags' => $tags]);
    }

    return false;
}
