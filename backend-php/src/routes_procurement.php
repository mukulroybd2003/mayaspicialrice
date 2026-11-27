<?php
declare(strict_types=1);

use SonaGrain\Auth;
use SonaGrain\ErpEngine;
use SonaGrain\InsufficientStockException;
use SonaGrain\SmsService;

function handleProcurementRoutes(string $method, string $uri, array $body, PDO $pdo, array $emp, string $clientType): bool
{
    $physicalOnly = Auth::isPhysicalOnlyUser($emp);

    // -----------------------------------------------------------------------
    // Paddy Purchases (List / Create w/ Multi-Godown Splits / Price / Return)
    // -----------------------------------------------------------------------
    if ($uri === '/api/v1/paddy-purchases' && $method === 'GET') {
        $purchasesRaw = $pdo->query(
            "SELECT p.*, pt.name AS supplier_name, pt.phone AS supplier_phone, w.name AS warehouse_name, i.name AS item_name, e.full_name AS created_by_name,
                    COALESCE((SELECT SUM(l.remaining_qty_kg) FROM inventory_lots l WHERE l.source_type = 'PADDY_PURCHASE' AND l.source_id = p.id), 0) AS unconsumed_lot_qty_kg,
                    COALESCE((SELECT SUM(l.remaining_bags) FROM inventory_lots l WHERE l.source_type = 'PADDY_PURCHASE' AND l.source_id = p.id), 0) AS unconsumed_lot_bags,
                    COALESCE((SELECT SUM(l2.remaining_qty_kg) FROM inventory_lots l2 WHERE l2.item_id = p.item_id AND l2.remaining_qty_kg > 0.0001), 0) AS available_variety_stock_kg
             FROM paddy_purchases p
             JOIN parties pt ON pt.id = p.supplier_id
             JOIN warehouses w ON w.id = p.warehouse_id
             JOIN items i ON i.id = p.item_id
             JOIN employees e ON e.id = p.created_by
             ORDER BY p.id DESC"
        )->fetchAll();

        $returnsRaw = $pdo->query(
            'SELECT r.*, p.purchase_no, pt.name AS supplier_name, i.name AS item_name,
                    a.name AS account_name, emp.full_name AS created_by_name
             FROM paddy_purchase_returns r
             JOIN paddy_purchases p ON p.id = r.purchase_id
             JOIN parties pt ON pt.id = r.supplier_id
             JOIN items i ON i.id = r.item_id
             LEFT JOIN accounts a ON a.id = r.account_id
             LEFT JOIN employees emp ON emp.id = r.created_by
             ORDER BY r.id DESC'
        )->fetchAll();

        $returnsByPurchase = [];
        foreach ($returnsRaw as $ret) {
            $pid = (int)$ret['purchase_id'];
            $returnsByPurchase[$pid][] = $ret;
        }

        $purchases = array_map(static function (array $p) use ($returnsByPurchase, $physicalOnly): array {
            $splits = [];
            if (!empty($p['split_summary_json']) && is_string($p['split_summary_json'])) {
                $decoded = json_decode($p['split_summary_json'], true);
                if (is_array($decoded)) {
                    $splits = $decoded;
                }
            }
            $p['unconsumed_lot_qty_kg']    = (float)$p['unconsumed_lot_qty_kg'];
            $p['unconsumed_lot_bags']      = (int)$p['unconsumed_lot_bags'];
            $p['available_variety_stock_kg'] = (float)$p['available_variety_stock_kg'];
            $row = array_merge($p, [
                'splits'      => $splits,
                'return_logs' => $returnsByPurchase[(int)$p['id']] ?? [],
            ]);
            return $physicalOnly ? Auth::sanitizePurchaseForPhysical($row) : $row;
        }, $purchasesRaw);

        Auth::jsonResponse(['purchases' => $purchases]);
    }

    if ($uri === '/api/v1/paddy-purchases' && $method === 'POST') {
        Auth::requirePermission($emp, 'paddy.purchase.create');
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            if ($physicalOnly && isset($idem['purchase']) && is_array($idem['purchase'])) {
                $idem['purchase'] = Auth::sanitizePurchaseForPhysical($idem['purchase']);
            }
            Auth::jsonResponse($idem, 200);
        }

        $weightLoss         = max(0.0, (float)($body['weight_loss_kg'] ?? 0));
        $settlementUnit     = (float)($body['settlement_unit_kg'] ?? 75.5);
        $settlementRate     = $physicalOnly ? 0.0 : (float)($body['settlement_rate'] ?? 0);
        $fallbackRatePerKg  = $physicalOnly ? 0.0 : (float)($body['rate_per_kg'] ?? 0);
        $paymentWeightKg    = (float)($body['payment_weight_kg'] ?? 0);
        $claimedWeightKg    = (float)($body['supplier_claimed_weight_kg'] ?? 0);
        $scaleWeightKg      = (float)($body['scale_weight_kg'] ?? 0);
        $receivedWeightKg   = (float)($body['received_weight_kg'] ?? 0);
        $netBillableWeight  = round($paymentWeightKg - $weightLoss, 3);
        $hasSettlementForm  = !$physicalOnly && $settlementRate > 0 && $settlementUnit > 0;
        $isGodownIntake     = $physicalOnly || ((bool)($body['pending_rate'] ?? false) && !$hasSettlementForm && $fallbackRatePerKg <= 0);
        $splitsInput        = isset($body['splits']) && is_array($body['splits']) ? $body['splits'] : [];
        $hasSplits          = count($splitsInput) > 0;
        $resolvedPrimaryWh  = (int)($body['warehouse_id'] ?? ($hasSplits ? ($splitsInput[0]['warehouse_id'] ?? 0) : 0));

        if (
            empty($body['supplier_id']) ||
            $resolvedPrimaryWh <= 0 ||
            empty($body['item_id']) ||
            $claimedWeightKg <= 0 ||
            $scaleWeightKg <= 0 ||
            $receivedWeightKg <= 0 ||
            $paymentWeightKg <= 0 ||
            $settlementUnit <= 0 ||
            $netBillableWeight <= 0 ||
            (!$isGodownIntake && !$hasSettlementForm && $fallbackRatePerKg <= 0)
        ) {
            Auth::abort(400, 'All four weight fields, positive net settlement weight, divisor, supplier, warehouse, and item are required');
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use (
                $pdo, $emp, $body, $clientUuid, $clientType, $physicalOnly,
                $weightLoss, $settlementUnit, $settlementRate, $fallbackRatePerKg,
                $paymentWeightKg, $claimedWeightKg, $scaleWeightKg, $receivedWeightKg,
                $netBillableWeight, $hasSettlementForm, $isGodownIntake, $splitsInput, $hasSplits, $resolvedPrimaryWh
            ) {
                $seq        = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM paddy_purchases')->fetchColumn();
                $purchaseNo = 'PUR-2026-' . str_pad((string)$seq, 4, '0', STR_PAD_LEFT);
                $qrUid      = ErpEngine::uuidV4();

                $weightDiscrepancy  = round($scaleWeightKg - $claimedWeightKg, 3);
                $discrepancyFlagged = (abs($weightDiscrepancy) > 20 || abs($scaleWeightKg - $receivedWeightKg) > 25) ? 1 : 0;

                $effectiveSettlementRate = $isGodownIntake
                    ? 0.0
                    : ($hasSettlementForm ? $settlementRate : round($fallbackRatePerKg * $settlementUnit, 4));
                $totalPayable = $isGodownIntake
                    ? 0.0
                    : ($hasSettlementForm
                        ? round(($netBillableWeight / $settlementUnit) * $settlementRate, 2)
                        : round($netBillableWeight * $fallbackRatePerKg, 2));
                $effectiveRatePerKg = $isGodownIntake ? 0.0 : round($totalPayable / $paymentWeightKg, 4);

                $paidAmt       = $isGodownIntake ? 0.0 : min($totalPayable, max(0.0, (float)($body['paid_amount'] ?? 0)));
                $payStatus     = ($isGodownIntake || $paidAmt <= 0) ? 'UNPAID' : ($paidAmt >= $totalPayable ? 'PAID' : 'PARTIAL');
                $pricingStatus = $isGodownIntake ? 'PENDING_RATE' : 'PRICED';

                $reqJute     = max(0, (int)round((float)($body['jute_bag_count'] ?? 0)));
                $reqPlastic  = max(0, (int)round((float)($body['plastic_bag_count'] ?? 0)));
                $reqTotal    = max(0, (int)round((float)($body['bag_count'] ?? 0)));
                $juteBags    = ($reqJute === 0 && $reqPlastic === 0 && $reqTotal > 0) ? $reqTotal : $reqJute;
                $plasticBags = $reqPlastic;
                $totalBags   = $juteBags + $plasticBags;

                $computedSplits = [];
                if ($hasSplits) {
                    $sumWeight = 0.0;
                    $sumBags   = 0;
                    $whChk     = $pdo->prepare('SELECT id, name FROM warehouses WHERE id = ?');
                    foreach ($splitsInput as $s) {
                        $whId = (int)($s['warehouse_id'] ?? 0);
                        $whChk->execute([$whId]);
                        $wh = $whChk->fetch();
                        if (!$wh) {
                            throw new RuntimeException('Invalid warehouse selected inside multi-godown split');
                        }
                        $sWt   = (float)($s['received_weight_kg'] ?? 0);
                        $sBags = max(0, (int)round((float)($s['bag_count'] ?? 0)));
                        if ($sWt <= 0) {
                            throw new RuntimeException('Each split godown weight must be positive');
                        }
                        if ($sBags > 0 && $sWt <= $sBags) {
                            throw new RuntimeException('Each split godown weight (kg) must exceed its bag count');
                        }
                        $sumWeight += $sWt;
                        $sumBags   += $sBags;
                        $sNetUnits  = $sWt > $sBags ? round(($sWt - $sBags) / $settlementUnit, 4) : 0.0;
                        $computedSplits[] = [
                            'warehouse_id'       => (int)$wh['id'],
                            'warehouse_name'     => $wh['name'],
                            'bag_count'          => $sBags,
                            'jute_bag_count'     => max(0, (int)round((float)($s['jute_bag_count'] ?? 0))),
                            'plastic_bag_count'  => max(0, (int)round((float)($s['plastic_bag_count'] ?? 0))),
                            'received_weight_kg' => round($sWt, 3),
                            'net_units'          => $sNetUnits,
                            'allocated_amount'   => $isGodownIntake ? 0 : round(($sWt / $receivedWeightKg) * $totalPayable, 2),
                        ];
                    }
                    if (abs($sumWeight - $receivedWeightKg) > 0.5) {
                        throw new RuntimeException(sprintf(
                            'Split godown weight sum (%.2f kg) must equal total received weight (%.2f kg)',
                            $sumWeight,
                            $receivedWeightKg
                        ));
                    }
                    if ($totalBags > 0 && $sumBags !== $totalBags) {
                        throw new RuntimeException("Split godown bags sum ({$sumBags}) must equal total bags ({$totalBags})");
                    }
                }

                $pdo->prepare(
                    'INSERT INTO paddy_purchases (
                        client_uuid, purchase_no, supplier_id, warehouse_id, item_id, vehicle_no, challan_no,
                        bag_count, jute_bag_count, plastic_bag_count, moisture_pct, supplier_claimed_weight_kg, scale_weight_kg, received_weight_kg,
                        payment_weight_kg, weight_loss_kg, settlement_unit_kg, settlement_rate,
                        weight_discrepancy_kg, discrepancy_flagged, discrepancy_notes,
                        rate_per_kg, total_payable, paid_amount, payment_status, pricing_status, qr_code_uid, weighbridge_mode, split_summary_json, created_by
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                )->execute([
                    $clientUuid,
                    $purchaseNo,
                    (int)$body['supplier_id'],
                    $resolvedPrimaryWh,
                    (int)$body['item_id'],
                    (string)($body['vehicle_no'] ?? ''),
                    (string)($body['challan_no'] ?? ''),
                    $totalBags,
                    $juteBags,
                    $plasticBags,
                    (float)($body['moisture_pct'] ?? 14),
                    $claimedWeightKg,
                    $scaleWeightKg,
                    $receivedWeightKg,
                    $paymentWeightKg,
                    $weightLoss,
                    $settlementUnit,
                    $effectiveSettlementRate,
                    $weightDiscrepancy,
                    $discrepancyFlagged,
                    (string)($body['discrepancy_notes'] ?? ''),
                    $effectiveRatePerKg,
                    $totalPayable,
                    $paidAmt,
                    $payStatus,
                    $pricingStatus,
                    $qrUid,
                    (string)($body['weighbridge_mode'] ?? 'MANUAL'),
                    count($computedSplits) > 0 ? json_encode($computedSplits, JSON_UNESCAPED_UNICODE) : null,
                    (int)$emp['id'],
                ]);

                $purchaseId        = (int)$pdo->lastInsertId();
                $effectiveUnitCost = $isGodownIntake ? 0.0 : round($totalPayable / $receivedWeightKg, 4);

                $iSt = $pdo->prepare('SELECT name FROM items WHERE id = ?');
                $iSt->execute([(int)$body['item_id']]);
                $itemName = (string)($iSt->fetchColumn() ?: 'Paddy');

                $primaryLot = null;
                $splitLots  = [];

                if (count($computedSplits) > 0) {
                    foreach ($computedSplits as $idx => $sp) {
                        $lotUid = $idx === 0 ? $qrUid : ErpEngine::uuidV4();
                        $lot    = ErpEngine::createInventoryLot($pdo, [
                            'prefix'        => 'LOT-PAD',
                            'itemId'        => (int)$body['item_id'],
                            'warehouseId'   => $sp['warehouse_id'],
                            'sourceType'    => 'PADDY_PURCHASE',
                            'sourceId'      => $purchaseId,
                            'qtyKg'         => $sp['received_weight_kg'],
                            'bagCount'      => $sp['bag_count'],
                            'unitCostPerKg' => $effectiveUnitCost,
                            'moisturePct'   => (float)($body['moisture_pct'] ?? 14),
                            'movementType'  => 'PURCHASE_IN',
                            'employeeId'    => (int)$emp['id'],
                            'qrUid'         => $lotUid,
                        ]);
                        if ($idx === 0) {
                            $primaryLot = $lot;
                        }
                        $splitLots[] = array_merge($lot, [
                            'warehouse_id' => $sp['warehouse_id'],
                            'qty_kg'       => $sp['received_weight_kg'],
                            'bag_count'    => $sp['bag_count'],
                        ]);
                        ErpEngine::registerQrTag($pdo, $lotUid, 'PADDY_LOT', (int)$lot['lotId'], $lot['lotCode'], [
                            'purchase_no'     => $purchaseNo,
                            'lot_code'        => $lot['lotCode'],
                            'item'            => $itemName,
                            'warehouse'       => $sp['warehouse_name'],
                            'split_qty_kg'    => $sp['received_weight_kg'],
                            'split_bags'      => $sp['bag_count'],
                            'split_net_units' => $sp['net_units'],
                        ]);
                    }
                } else {
                    $lot = ErpEngine::createInventoryLot($pdo, [
                        'prefix'        => 'LOT-PAD',
                        'itemId'        => (int)$body['item_id'],
                        'warehouseId'   => $resolvedPrimaryWh,
                        'sourceType'    => 'PADDY_PURCHASE',
                        'sourceId'      => $purchaseId,
                        'qtyKg'         => $receivedWeightKg,
                        'bagCount'      => $totalBags,
                        'unitCostPerKg' => $effectiveUnitCost,
                        'moisturePct'   => (float)($body['moisture_pct'] ?? 14),
                        'movementType'  => 'PURCHASE_IN',
                        'employeeId'    => (int)$emp['id'],
                        'qrUid'         => $qrUid,
                    ]);
                    $primaryLot = $lot;
                    $wSt = $pdo->prepare('SELECT name FROM warehouses WHERE id = ?');
                    $wSt->execute([$resolvedPrimaryWh]);
                    $whName = (string)($wSt->fetchColumn() ?: 'Godown');
                    ErpEngine::registerQrTag($pdo, $qrUid, 'PADDY_LOT', (int)$lot['lotId'], $lot['lotCode'], [
                        'purchase_no' => $purchaseNo,
                        'lot_code'    => $lot['lotCode'],
                        'item'        => $itemName,
                        'warehouse'   => $whName,
                        'claimed_kg'  => $claimedWeightKg,
                        'scale_kg'    => $scaleWeightKg,
                        'received_kg' => $receivedWeightKg,
                        'payment_kg'  => $paymentWeightKg,
                    ]);
                }

                if ($totalBags > 0) {
                    $bagSeq  = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM supplier_bag_ledger')->fetchColumn();
                    $entryNo = 'BAG-2026-' . str_pad((string)$bagSeq, 4, '0', STR_PAD_LEFT);
                    $pdo->prepare(
                        "INSERT INTO supplier_bag_ledger (
                            client_uuid, entry_no, supplier_id, entry_type, direction,
                            jute_qty, plastic_qty, total_qty, reference_type, reference_id, reference_no, entry_date, notes, created_by
                         ) VALUES (?, ?, ?, 'PADDY_DEPOSIT', 'IN_FROM_SUPPLIER', ?, ?, ?, 'PADDY_PURCHASE', ?, ?, CURDATE(), ?, ?)"
                    )->execute([
                        ErpEngine::uuidV4(),
                        $entryNo,
                        (int)$body['supplier_id'],
                        $juteBags,
                        $plasticBags,
                        $totalBags,
                        $purchaseId,
                        $purchaseNo,
                        "Bags deposited with paddy purchase {$purchaseNo}",
                        (int)$emp['id'],
                    ]);
                }

                if (!$isGodownIntake && $totalPayable > 0) {
                    $unpaidDelta = $totalPayable - $paidAmt;
                    $pdo->prepare('UPDATE parties SET current_balance = current_balance - ? WHERE id = ?')
                        ->execute([$unpaidDelta, (int)$body['supplier_id']]);

                    $journalLines = [
                        ['accountCode' => '1200', 'debit' => $totalPayable, 'credit' => 0],
                        ['accountCode' => '2001', 'debit' => 0, 'credit' => $unpaidDelta, 'partyId' => (int)$body['supplier_id']],
                    ];
                    if ($paidAmt > 0) {
                        $journalLines[] = ['accountCode' => '1001', 'debit' => 0, 'credit' => $paidAmt];
                    }
                    ErpEngine::postJournalEntry($pdo, [
                        'description'   => "Paddy Purchase {$purchaseNo} ({$receivedWeightKg} kg received / {$paymentWeightKg} kg billed)",
                        'referenceType' => 'PADDY_PURCHASE',
                        'referenceId'   => $purchaseId,
                        'employeeId'    => (int)$emp['id'],
                        'lines'         => $journalLines,
                    ]);
                }

                $action = $isGodownIntake
                    ? 'PADDY_GODOWN_INTAKE_CREATED'
                    : ($discrepancyFlagged ? 'PADDY_PURCHASE_WITH_DISCREPANCY' : 'PADDY_PURCHASE_CREATED');
                ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], $action, 'PADDY_PURCHASE', $purchaseNo, null, [
                    'claimed'        => $claimedWeightKg,
                    'scale'          => $scaleWeightKg,
                    'received'       => $receivedWeightKg,
                    'payment'        => $paymentWeightKg,
                    'discrepancy'    => $weightDiscrepancy,
                    'pricing_status' => $pricingStatus,
                    'total_payable'  => $totalPayable,
                ], $clientType);

                $cSt = $pdo->prepare(
                    'SELECT p.*, pt.name AS supplier_name, pt.phone AS supplier_phone, w.name AS warehouse_name, i.name AS item_name
                     FROM paddy_purchases p
                     JOIN parties pt ON pt.id = p.supplier_id
                     JOIN warehouses w ON w.id = p.warehouse_id
                     JOIN items i ON i.id = p.item_id
                     WHERE p.id = ?'
                );
                $cSt->execute([$purchaseId]);
                $created = $cSt->fetch();

                $responseObj = [
                    'status'     => 'SYNCED',
                    'purchase'   => array_merge($created, ['splits' => $computedSplits, 'return_logs' => []]),
                    'lot'        => $primaryLot,
                    'split_lots' => $splitLots,
                ];
                ErpEngine::recordSyncLog(
                    $pdo,
                    $clientUuid,
                    (string)($body['device_id'] ?? 'WEB-BROWSER'),
                    $clientType,
                    '/api/v1/paddy-purchases',
                    'SYNCED',
                    null,
                    $responseObj,
                    (int)$emp['id']
                );

                if ($physicalOnly) {
                    $responseObj['purchase'] = Auth::sanitizePurchaseForPhysical($responseObj['purchase']);
                }
                return $responseObj;
            });

            $smsNotification = null;
            $shouldSendSms   = !array_key_exists('auto_send_sms', $body) || (bool)$body['auto_send_sms'];
            if ($shouldSendSms && isset($result['purchase']) && is_array($result['purchase'])) {
                try {
                    $smsNotification = SmsService::dispatchPaddyPurchaseSms($pdo, [
                        'purchase'    => $result['purchase'],
                        'employeeId'  => (int)$emp['id'],
                        'triggerType' => 'CREATE',
                    ]);
                } catch (\Throwable) {
                    // Non-fatal
                }
            }
            $result['sms_notification'] = $smsNotification;

            Auth::jsonResponse($result, 201);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if (preg_match('#^/api/v1/paddy-purchases/(\d+)/price$#', $uri, $m) && $method === 'PUT') {
        Auth::rejectPhysicalOnlyUser($emp);
        $canPrice = in_array($emp['role_code'], ['OWNER', 'MANAGER', 'ACCOUNTANT'], true)
            || in_array('accounting.post', $emp['permissions'], true);
        if (!$canPrice) {
            Auth::abort(403, 'Only Admin, Manager, or Accountant can set paddy purchase rates');
        }
        $purchaseId = (int)$m[1];

        try {
            $updatedPurchase = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $purchaseId, $body, $emp, $clientType) {
                $pSt = $pdo->prepare('SELECT * FROM paddy_purchases WHERE id = ? FOR UPDATE');
                $pSt->execute([$purchaseId]);
                $purchase = $pSt->fetch();
                if (!$purchase) {
                    throw new RuntimeException('Paddy purchase record not found');
                }
                if (($purchase['pricing_status'] ?? 'PRICED') === 'PRICED' && (float)$purchase['total_payable'] > 0) {
                    throw new RuntimeException('This paddy purchase is already priced');
                }

                $weightLoss        = max(0.0, (float)($body['weight_loss_kg'] ?? $purchase['weight_loss_kg'] ?? 0));
                $settlementUnit    = (float)($body['settlement_unit_kg'] ?? $purchase['settlement_unit_kg'] ?? 75.5);
                $settlementRate    = (float)($body['settlement_rate'] ?? 0);
                $fallbackRatePerKg = (float)($body['rate_per_kg'] ?? 0);
                $netBillableWeight = round((float)$purchase['payment_weight_kg'] - $weightLoss, 3);
                $hasFormula        = $settlementRate > 0 && $settlementUnit > 0;

                if ($settlementUnit <= 0 || $netBillableWeight <= 0 || (!$hasFormula && $fallbackRatePerKg <= 0)) {
                    throw new RuntimeException('Valid positive settlement unit weight and paddy rate are required');
                }

                $effectiveSettlementRate = $hasFormula ? $settlementRate : round($fallbackRatePerKg * $settlementUnit, 4);
                $totalPayable = $hasFormula
                    ? round(($netBillableWeight / $settlementUnit) * $settlementRate, 2)
                    : round($netBillableWeight * $fallbackRatePerKg, 2);
                $effectiveRatePerKg = round($totalPayable / (float)$purchase['payment_weight_kg'], 4);
                $paidAmt            = min($totalPayable, max(0.0, (float)($body['paid_amount'] ?? 0)));
                $payStatus          = $paidAmt <= 0 ? 'UNPAID' : ($paidAmt >= $totalPayable ? 'PAID' : 'PARTIAL');

                $updatedSplitsJson = $purchase['split_summary_json'] ?? null;
                if (is_string($updatedSplitsJson) && trim($updatedSplitsJson) !== '') {
                    $parsed = json_decode($updatedSplitsJson, true);
                    if (is_array($parsed)) {
                        $nextSplits = array_map(static function (array $sp) use ($purchase, $totalPayable): array {
                            $sp['allocated_amount'] = round(((float)($sp['received_weight_kg'] ?? 0) / (float)$purchase['received_weight_kg']) * $totalPayable, 2);
                            return $sp;
                        }, $parsed);
                        $updatedSplitsJson = json_encode($nextSplits, JSON_UNESCAPED_UNICODE);
                    }
                }

                $pdo->prepare(
                    "UPDATE paddy_purchases
                     SET weight_loss_kg = ?, settlement_unit_kg = ?, settlement_rate = ?,
                         rate_per_kg = ?, total_payable = ?, paid_amount = ?,
                         payment_status = ?, pricing_status = 'PRICED', split_summary_json = ?
                     WHERE id = ?"
                )->execute([
                    $weightLoss,
                    $settlementUnit,
                    $effectiveSettlementRate,
                    $effectiveRatePerKg,
                    $totalPayable,
                    $paidAmt,
                    $payStatus,
                    $updatedSplitsJson,
                    $purchaseId,
                ]);

                $effectiveUnitCost = round($totalPayable / (float)$purchase['received_weight_kg'], 4);
                $lotSt = $pdo->prepare("SELECT id FROM inventory_lots WHERE source_type = 'PADDY_PURCHASE' AND source_id = ?");
                $lotSt->execute([$purchaseId]);
                $lots = $lotSt->fetchAll();

                $updLot    = $pdo->prepare('UPDATE inventory_lots SET unit_cost_per_kg = ? WHERE id = ?');
                $updLedger = $pdo->prepare("UPDATE stock_ledger SET unit_cost_per_kg = ?, total_cost = ROUND(ABS(qty_change_kg) * ?, 2) WHERE lot_id = ? AND movement_type = 'PURCHASE_IN'");
                foreach ($lots as $l) {
                    $updLot->execute([$effectiveUnitCost, (int)$l['id']]);
                    $updLedger->execute([$effectiveUnitCost, $effectiveUnitCost, (int)$l['id']]);
                }

                $unpaidDelta = $totalPayable - $paidAmt;
                $pdo->prepare('UPDATE parties SET current_balance = current_balance - ? WHERE id = ?')
                    ->execute([$unpaidDelta, (int)$purchase['supplier_id']]);

                $payAccCode = '1001';
                if ($paidAmt > 0 && !empty($body['account_id'])) {
                    $aSt = $pdo->prepare('SELECT account_code FROM accounts WHERE id = ?');
                    $aSt->execute([(int)$body['account_id']]);
                    $code = $aSt->fetchColumn();
                    if ($code) {
                        $payAccCode = (string)$code;
                    }
                }

                $journalLines = [
                    ['accountCode' => '1200', 'debit' => $totalPayable, 'credit' => 0],
                    ['accountCode' => '2001', 'debit' => 0, 'credit' => $unpaidDelta, 'partyId' => (int)$purchase['supplier_id']],
                ];
                if ($paidAmt > 0) {
                    $journalLines[] = ['accountCode' => $payAccCode, 'debit' => 0, 'credit' => $paidAmt];
                }
                ErpEngine::postJournalEntry($pdo, [
                    'description'   => "Paddy Purchase Priced {$purchase['purchase_no']} (Rate settled by Admin/Accounts)",
                    'referenceType' => 'PADDY_PURCHASE',
                    'referenceId'   => $purchaseId,
                    'employeeId'    => (int)$emp['id'],
                    'lines'         => $journalLines,
                ]);

                ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'PADDY_PURCHASE_PRICED', 'PADDY_PURCHASE', (string)$purchase['purchase_no'], null, [
                    'settlement_unit_kg' => $settlementUnit,
                    'settlement_rate'    => $effectiveSettlementRate,
                    'total_payable'      => $totalPayable,
                    'paid_amount'        => $paidAmt,
                ], $clientType);

                $cSt = $pdo->prepare(
                    'SELECT p.*, pt.name AS supplier_name, pt.phone AS supplier_phone, w.name AS warehouse_name, i.name AS item_name, e.full_name AS created_by_name
                     FROM paddy_purchases p
                     JOIN parties pt ON pt.id = p.supplier_id
                     JOIN warehouses w ON w.id = p.warehouse_id
                     JOIN items i ON i.id = p.item_id
                     JOIN employees e ON e.id = p.created_by
                     WHERE p.id = ?'
                );
                $cSt->execute([$purchaseId]);
                $created = $cSt->fetch();
                $created['splits']      = is_string($updatedSplitsJson) ? (json_decode($updatedSplitsJson, true) ?: []) : [];
                $created['return_logs'] = [];
                return $created;
            });

            $smsNotification = null;
            try {
                $smsNotification = SmsService::dispatchPaddyPurchaseSms($pdo, [
                    'purchase'    => $updatedPurchase,
                    'employeeId'  => (int)$emp['id'],
                    'triggerType' => 'PRICE',
                ]);
            } catch (\Throwable) {
                // Non-fatal
            }

            Auth::jsonResponse([
                'status'           => 'PRICED',
                'purchase'         => $updatedPurchase,
                'sms_notification' => $smsNotification,
            ]);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if (preg_match('#^/api/v1/paddy-purchases/(\d+)/return$#', $uri, $m) && $method === 'POST') {
        Auth::requirePermission($emp, 'paddy.purchase.create');
        Auth::rejectPhysicalOnlyUser($emp);
        $purchaseId = (int)$m[1];
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        $returnType  = ($body['return_type'] ?? '') === 'FINANCIAL_ADJUSTMENT' ? 'FINANCIAL_ADJUSTMENT' : 'PHYSICAL_RETURN';
        $returnQtyKg = max(0.0, (float)($body['return_qty_kg'] ?? 0));
        if ($returnType === 'PHYSICAL_RETURN' && $returnQtyKg <= 0) {
            Auth::abort(400, 'Return quantity (kg) must be greater than zero');
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $purchaseId, $body, $clientUuid, $clientType, $emp, $returnType, $returnQtyKg) {
                $pSt = $pdo->prepare(
                    'SELECT p.*, i.costing_method, pt.name AS supplier_name, i.name AS item_name
                     FROM paddy_purchases p
                     JOIN items i ON i.id = p.item_id
                     JOIN parties pt ON pt.id = p.supplier_id
                     WHERE p.id = ?'
                );
                $pSt->execute([$purchaseId]);
                $purchase = $pSt->fetch();
                if (!$purchase) {
                    throw new RuntimeException('Paddy purchase record not found');
                }

                $lotsToDeduct = [];
                if ($returnType === 'PHYSICAL_RETURN') {
                    $ownSt = $pdo->prepare(
                        "SELECT id, warehouse_id, remaining_qty_kg, remaining_bags
                         FROM inventory_lots
                         WHERE source_type = 'PADDY_PURCHASE' AND source_id = ? AND remaining_qty_kg > 0.0001
                         ORDER BY id ASC"
                    );
                    $ownSt->execute([$purchaseId]);
                    $ownLots = $ownSt->fetchAll();
                    $ownQty  = array_reduce($ownLots, static fn(float $s, array $l): float => $s + (float)$l['remaining_qty_kg'], 0.0);

                    if ($ownQty + 0.01 >= $returnQtyKg) {
                        $lotsToDeduct = $ownLots;
                    } else {
                        $otherSt = $pdo->prepare(
                            "SELECT id, warehouse_id, remaining_qty_kg, remaining_bags
                             FROM inventory_lots
                             WHERE item_id = ? AND remaining_qty_kg > 0.0001
                               AND NOT (source_type = 'PADDY_PURCHASE' AND source_id = ?)
                             ORDER BY CASE WHEN warehouse_id = ? THEN 0 WHEN source_type = 'TRANSFER_IN' THEN 1 ELSE 2 END ASC, id ASC"
                        );
                        $otherSt->execute([(int)$purchase['item_id'], $purchaseId, (int)$purchase['warehouse_id']]);
                        $otherLots  = $otherSt->fetchAll();
                        $totalAvail = $ownQty + array_reduce($otherLots, static fn(float $s, array $l): float => $s + (float)$l['remaining_qty_kg'], 0.0);

                        if ($totalAvail + 0.01 < $returnQtyKg) {
                            throw new RuntimeException(
                                $totalAvail <= 0.01
                                    ? "{$purchase['purchase_no']}-এর ধান ইতিমধ্যেই ডায়ার/মিলিংয়ে ব্যবহৃত হয়েছে (অব্যবহৃত স্টক ০.০০ কেজি)। স্টক ছাড়া শুধু টাকা বা বিল সংশোধন করতে 'শুধু টাকা/বিল সংশোধন' মোড ব্যবহার করুন।"
                                    : sprintf("%s ও গুদামে %s-এর অব্যবহৃত মজুদ আছে %.2f কেজি (%.2f কেজি ফেরত দেওয়া সম্ভব নয়)।", $purchase['purchase_no'], $purchase['item_name'], $totalAvail, $returnQtyKg)
                            );
                        }
                        $lotsToDeduct = array_merge($ownLots, $otherLots);
                    }
                }

                $maxReturnable   = max(0.0, round((float)$purchase['total_payable'] - (float)$purchase['returned_amount'], 2));
                $proportionalAmt = ($returnQtyKg > 0 && (float)$purchase['received_weight_kg'] > 0)
                    ? round(($returnQtyKg / (float)$purchase['received_weight_kg']) * (float)$purchase['total_payable'], 2)
                    : 0.0;
                $returnAmount = !empty($body['return_amount']) && (float)$body['return_amount'] > 0
                    ? min($maxReturnable, round((float)$body['return_amount'], 2))
                    : min($maxReturnable, $proportionalAmt);

                if ($returnAmount <= 0) {
                    throw new RuntimeException('Return / adjustment amount must be greater than zero');
                }

                $juteRet         = max(0, (int)round((float)($body['return_jute_bags'] ?? $body['return_bags'] ?? 0)));
                $plasticRet      = max(0, (int)round((float)($body['return_plastic_bags'] ?? 0)));
                $returnBags      = max(0, (int)round((float)($body['return_bags'] ?? ($juteRet + $plasticRet))));
                $finalJuteRet    = ($juteRet === 0 && $plasticRet === 0 && $returnBags > 0) ? $returnBags : $juteRet;
                $finalPlasticRet = $plasticRet;
                $refundMode      = ($body['refund_mode'] ?? '') === 'CASH_REFUND' ? 'CASH_REFUND' : 'ADJUST_PAYABLE';

                $accRow = null;
                if ($refundMode === 'CASH_REFUND') {
                    if (!empty($body['account_id'])) {
                        $aSt = $pdo->prepare('SELECT id, account_code, name FROM accounts WHERE id = ?');
                        $aSt->execute([(int)$body['account_id']]);
                    } else {
                        $aSt = $pdo->query("SELECT id, account_code, name FROM accounts WHERE account_code = '1001' LIMIT 1");
                    }
                    $accRow = $aSt->fetch();
                    if (!$accRow) {
                        throw new RuntimeException('Refund account not found');
                    }
                }

                $retSeq   = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM paddy_purchase_returns')->fetchColumn();
                $returnNo = 'RET-2026-' . str_pad((string)$retSeq, 4, '0', STR_PAD_LEFT);

                $pdo->prepare(
                    'INSERT INTO paddy_purchase_returns (
                        client_uuid, return_no, purchase_id, supplier_id, item_id,
                        return_qty_kg, return_bags, return_jute_bags, return_plastic_bags,
                        return_amount, refund_mode, account_id, reason, created_by
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                )->execute([
                    $clientUuid,
                    $returnNo,
                    $purchaseId,
                    (int)$purchase['supplier_id'],
                    (int)$purchase['item_id'],
                    $returnQtyKg,
                    $returnBags,
                    $finalJuteRet,
                    $finalPlasticRet,
                    $returnAmount,
                    $refundMode,
                    $accRow ? (int)$accRow['id'] : null,
                    trim((string)($body['reason'] ?? '')),
                    (int)$emp['id'],
                ]);
                $returnId = (int)$pdo->lastInsertId();

                if ($returnType === 'PHYSICAL_RETURN' && $returnQtyKg > 0) {
                    $remToDeduct     = $returnQtyKg;
                    $remBagsToDeduct = $returnBags;
                    foreach ($lotsToDeduct as $lot) {
                        if ($remToDeduct <= 0.0001) {
                            break;
                        }
                        $takeKg   = min($remToDeduct, (float)$lot['remaining_qty_kg']);
                        $takeBags = ($remBagsToDeduct > 0 && (int)($lot['remaining_bags'] ?? 0) > 0)
                            ? min($remBagsToDeduct, (int)$lot['remaining_bags'])
                            : null;
                        ErpEngine::consumeWarehouseStock($pdo, [
                            'itemId'         => (int)$purchase['item_id'],
                            'warehouseId'    => (int)$lot['warehouse_id'],
                            'qtyKg'          => $takeKg,
                            'bagCount'       => $takeBags,
                            'preferredLotId' => (int)$lot['id'],
                            'costingMethod'  => 'FIFO',
                            'movementType'   => 'PURCHASE_RETURN',
                            'referenceType'  => 'PADDY_PURCHASE_RETURN',
                            'referenceId'    => $returnId,
                            'employeeId'     => (int)$emp['id'],
                        ]);
                        $remToDeduct = round($remToDeduct - $takeKg, 4);
                        if ($takeBags) {
                            $remBagsToDeduct = max(0, $remBagsToDeduct - $takeBags);
                        }
                    }
                }

                $nextReturnedQty = round((float)($purchase['returned_qty_kg'] ?? 0) + $returnQtyKg, 3);
                $nextReturnedAmt = round((float)($purchase['returned_amount'] ?? 0) + $returnAmount, 2);
                $netPayableAfter = max(0.0, round((float)$purchase['total_payable'] - $nextReturnedAmt, 2));
                $paidAmount      = (float)($purchase['paid_amount'] ?? 0);
                $nextStatus      = $paidAmount >= ($netPayableAfter - 0.01) ? 'PAID' : ($paidAmount > 0 ? 'PARTIAL' : 'UNPAID');

                $pdo->prepare('UPDATE paddy_purchases SET returned_qty_kg = ?, returned_amount = ?, payment_status = ? WHERE id = ?')
                    ->execute([$nextReturnedQty, $nextReturnedAmt, $nextStatus, $purchaseId]);

                if ($refundMode === 'ADJUST_PAYABLE') {
                    $pdo->prepare('UPDATE parties SET current_balance = current_balance + ? WHERE id = ?')
                        ->execute([$returnAmount, (int)$purchase['supplier_id']]);
                }

                ErpEngine::postJournalEntry($pdo, [
                    'description'   => $returnType === 'FINANCIAL_ADJUSTMENT'
                        ? "Paddy Purchase Financial Adjustment {$returnNo} against {$purchase['purchase_no']} (৳{$returnAmount})"
                        : "Paddy Purchase Return {$returnNo} against {$purchase['purchase_no']} ({$returnQtyKg} kg)",
                    'referenceType' => 'PADDY_PURCHASE_RETURN',
                    'referenceId'   => $returnId,
                    'employeeId'    => (int)$emp['id'],
                    'lines'         => [
                        [
                            'accountCode' => ($refundMode === 'CASH_REFUND' && $accRow) ? $accRow['account_code'] : '2001',
                            'debit'       => $returnAmount,
                            'credit'      => 0,
                            'partyId'     => $refundMode === 'ADJUST_PAYABLE' ? (int)$purchase['supplier_id'] : null,
                        ],
                        [
                            'accountCode' => $returnType === 'FINANCIAL_ADJUSTMENT' ? '5200' : '1200',
                            'debit'       => 0,
                            'credit'      => $returnAmount,
                        ],
                    ],
                ]);

                if ($returnBags > 0) {
                    $bagSeq  = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM supplier_bag_ledger')->fetchColumn();
                    $entryNo = 'BAG-2026-' . str_pad((string)$bagSeq, 4, '0', STR_PAD_LEFT);
                    $pdo->prepare(
                        "INSERT INTO supplier_bag_ledger (
                            client_uuid, entry_no, supplier_id, entry_type, direction,
                            jute_qty, plastic_qty, total_qty, reference_type, reference_id, reference_no, entry_date, notes, created_by
                         ) VALUES (?, ?, ?, 'EMPTY_PICKUP', 'OUT_TO_SUPPLIER', ?, ?, ?, 'PADDY_PURCHASE_RETURN', ?, ?, CURDATE(), ?, ?)"
                    )->execute([
                        ErpEngine::uuidV4(),
                        $entryNo,
                        (int)$purchase['supplier_id'],
                        $finalJuteRet,
                        $finalPlasticRet,
                        $returnBags,
                        $returnId,
                        $returnNo,
                        "Bags returned on purchase return {$returnNo} ({$purchase['purchase_no']})",
                        (int)$emp['id'],
                    ]);
                }

                ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'PADDY_PURCHASE_RETURNED', 'PADDY_PURCHASE_RETURN', $returnNo, null, [
                    'purchase_no'   => $purchase['purchase_no'],
                    'return_qty_kg' => $returnQtyKg,
                    'return_amount' => $returnAmount,
                    'refund_mode'   => $refundMode,
                ], $clientType);

                $rSt = $pdo->prepare(
                    'SELECT r.*, p.purchase_no, pt.name AS supplier_name, i.name AS item_name,
                            a.name AS account_name, emp.full_name AS created_by_name
                     FROM paddy_purchase_returns r
                     JOIN paddy_purchases p ON p.id = r.purchase_id
                     JOIN parties pt ON pt.id = r.supplier_id
                     JOIN items i ON i.id = r.item_id
                     LEFT JOIN accounts a ON a.id = r.account_id
                     LEFT JOIN employees emp ON emp.id = r.created_by
                     WHERE r.id = ?'
                );
                $rSt->execute([$returnId]);
                $returnRecord = $rSt->fetch();

                $responseObj = ['status' => 'SYNCED', 'return_record' => $returnRecord];
                ErpEngine::recordSyncLog(
                    $pdo,
                    $clientUuid,
                    'WEB-BROWSER',
                    $clientType,
                    "/api/v1/paddy-purchases/{$purchaseId}/return",
                    'SYNCED',
                    null,
                    $responseObj,
                    (int)$emp['id']
                );
                return $responseObj;
            });

            Auth::jsonResponse($result, 201);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    // -----------------------------------------------------------------------
    // Stock Transfers Between Godowns
    // -----------------------------------------------------------------------
    if ($uri === '/api/v1/stock-transfers' && $method === 'GET') {
        $rows = $pdo->query(
            'SELECT st.*, wf.name AS from_warehouse_name, wt.name AS to_warehouse_name, i.name AS item_name
             FROM stock_transfers st
             JOIN warehouses wf ON wf.id = st.from_warehouse_id
             JOIN warehouses wt ON wt.id = st.to_warehouse_id
             JOIN items i ON i.id = st.item_id
             ORDER BY st.id DESC'
        )->fetchAll();

        $transfers = $physicalOnly
            ? array_map(static fn(array $t): array => array_merge($t, ['bag_unit_rate' => 0, 'total_cost' => 0]), $rows)
            : $rows;
        Auth::jsonResponse(['transfers' => $transfers]);
    }

    if ($uri === '/api/v1/stock-transfers' && $method === 'POST') {
        Auth::requirePermission($emp, 'stock.transfer');
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        $fromWh = (int)($body['from_warehouse_id'] ?? 0);
        $toWh   = (int)($body['to_warehouse_id'] ?? 0);
        $itemId = (int)($body['item_id'] ?? 0);
        $qtyKg  = (float)($body['qty_kg'] ?? 0);

        if ($fromWh === $toWh) {
            Auth::abort(400, 'Source and destination warehouses must be different');
        }
        if ($qtyKg <= 0) {
            Auth::abort(400, 'Transfer weight (kg) must be positive');
        }
        if (isset($body['bag_count']) && (int)$body['bag_count'] > 0 && $qtyKg <= (float)$body['bag_count']) {
            Auth::abort(400, 'Transfer weight (kg) must exceed bag count');
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $body, $clientUuid, $clientType, $emp, $physicalOnly, $fromWh, $toWh, $itemId, $qtyKg) {
                $seq           = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM stock_transfers')->fetchColumn();
                $transferNo    = 'TRF-2026-' . str_pad((string)$seq, 4, '0', STR_PAD_LEFT);
                $qrUid         = ErpEngine::uuidV4();
                $costingMethod = (string)($body['costing_method'] ?? 'FIFO');

                $lSt = $pdo->prepare(
                    "SELECT l.remaining_qty_kg, l.remaining_bags, l.unit_cost_per_kg, l.initial_qty_kg, l.source_type,
                            pp.bag_count AS purchase_bag_count, i.bag_weight_kg
                     FROM inventory_lots l
                     JOIN items i ON i.id = l.item_id
                     LEFT JOIN paddy_purchases pp ON l.source_type = 'PADDY_PURCHASE' AND pp.id = l.source_id
                     WHERE l.item_id = ? AND l.warehouse_id = ? AND l.remaining_qty_kg > 0.0001"
                );
                $lSt->execute([$itemId, $fromWh]);
                $activeLots = $lSt->fetchAll();

                $iSt = $pdo->prepare('SELECT bag_weight_kg FROM items WHERE id = ?');
                $iSt->execute([$itemId]);
                $defaultBagWt = (float)($iSt->fetchColumn() ?: 60) ?: 60.0;

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
                        $bw = (float)($l['bag_weight_kg'] ?? $defaultBagWt) ?: $defaultBagWt;
                        $stockBags += (int)round($remQty / $bw);
                    }
                }

                $divisor      = (float)($body['unit_divisor'] ?? 75.5) > 0 ? (float)($body['unit_divisor'] ?? 75.5) : 75.5;
                $transferBags = (array_key_exists('bag_count', $body) && (int)$body['bag_count'] >= 0)
                    ? (int)round((float)$body['bag_count'])
                    : max(0, (int)round($qtyKg / $defaultBagWt));

                $stockNetUnits = $stockWeightKg > $stockBags ? ($stockWeightKg - $stockBags) / $divisor : 0.0;
                $bagUnitRate   = $stockNetUnits > 0 ? round($stockValue / $stockNetUnits, 4) : 0.0;
                $goingNetUnits = ($transferBags > 0 && $qtyKg > $transferBags)
                    ? round(($qtyKg - $transferBags) / $divisor, 4)
                    : 0.0;
                $formulaCost   = ($bagUnitRate > 0 && $goingNetUnits > 0) ? round($bagUnitRate * $goingNetUnits, 2) : 0.0;

                $pdo->prepare(
                    'INSERT INTO stock_transfers (
                        client_uuid, transfer_no, from_warehouse_id, to_warehouse_id, item_id, qty_kg,
                        bag_count, unit_divisor, net_units, bag_unit_rate,
                        costing_method, total_cost, vehicle_or_driver, notes, qr_code_uid, created_by
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                )->execute([
                    $clientUuid,
                    $transferNo,
                    $fromWh,
                    $toWh,
                    $itemId,
                    $qtyKg,
                    $transferBags,
                    $divisor,
                    $goingNetUnits,
                    $bagUnitRate,
                    $costingMethod,
                    0,
                    (string)($body['vehicle_or_driver'] ?? ''),
                    (string)($body['notes'] ?? ''),
                    $qrUid,
                    (int)$emp['id'],
                ]);
                $transferId = (int)$pdo->lastInsertId();

                $consumed = ErpEngine::consumeWarehouseStock($pdo, [
                    'itemId'        => $itemId,
                    'warehouseId'   => $fromWh,
                    'qtyKg'         => $qtyKg,
                    'bagCount'      => $transferBags > 0 ? $transferBags : null,
                    'costingMethod' => $costingMethod,
                    'movementType'  => 'TRANSFER_OUT',
                    'referenceType' => 'STOCK_TRANSFER',
                    'referenceId'   => $transferId,
                    'employeeId'    => (int)$emp['id'],
                ]);

                $effectiveTotalCost = $formulaCost > 0 ? $formulaCost : $consumed['totalCost'];
                $effectiveAvgCost   = round($effectiveTotalCost / $qtyKg, 4);
                $effectiveBagRate   = $bagUnitRate > 0
                    ? round($bagUnitRate, 2)
                    : ($goingNetUnits > 0 ? round($effectiveTotalCost / $goingNetUnits, 2) : 0.0);

                $pdo->prepare('UPDATE stock_transfers SET total_cost = ?, bag_unit_rate = ? WHERE id = ?')
                    ->execute([$effectiveTotalCost, $effectiveBagRate, $transferId]);

                $originBatchId = null;
                foreach ($consumed['consumedLots'] as $cl) {
                    if (!empty($cl['origin_batch_id'])) {
                        $originBatchId = (int)$cl['origin_batch_id'];
                        break;
                    }
                }

                $lot = ErpEngine::createInventoryLot($pdo, [
                    'prefix'        => 'LOT-TRF',
                    'itemId'        => $itemId,
                    'warehouseId'   => $toWh,
                    'sourceType'    => 'TRANSFER_IN',
                    'sourceId'      => $transferId,
                    'originBatchId' => $originBatchId,
                    'qtyKg'         => $qtyKg,
                    'bagCount'      => $transferBags > 0 ? $transferBags : null,
                    'unitCostPerKg' => $effectiveAvgCost,
                    'movementType'  => 'TRANSFER_IN',
                    'employeeId'    => (int)$emp['id'],
                    'qrUid'         => $qrUid,
                ]);

                ErpEngine::registerQrTag($pdo, $qrUid, 'STOCK_TRANSFER', $transferId, $transferNo, [
                    'transfer_no'   => $transferNo,
                    'qty_kg'        => $qtyKg,
                    'bag_count'     => $transferBags,
                    'net_units'     => $goingNetUnits,
                    'bag_unit_rate' => $effectiveBagRate,
                    'avg_cost'      => $effectiveAvgCost,
                    'total_cost'    => $effectiveTotalCost,
                    'lot_code'      => $lot['lotCode'],
                ]);

                ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'STOCK_TRANSFER_COMPLETED', 'STOCK_TRANSFER', $transferNo, null, [
                    'from'          => $fromWh,
                    'to'            => $toWh,
                    'qty_kg'        => $qtyKg,
                    'bag_count'     => $transferBags,
                    'net_units'     => $goingNetUnits,
                    'bag_unit_rate' => $effectiveBagRate,
                    'total_cost'    => $effectiveTotalCost,
                ], $clientType);

                $cSt = $pdo->prepare(
                    'SELECT st.*, wf.name AS from_warehouse_name, wt.name AS to_warehouse_name, i.name AS item_name
                     FROM stock_transfers st
                     JOIN warehouses wf ON wf.id = st.from_warehouse_id
                     JOIN warehouses wt ON wt.id = st.to_warehouse_id
                     JOIN items i ON i.id = st.item_id
                     WHERE st.id = ?'
                );
                $cSt->execute([$transferId]);
                $created = $cSt->fetch();

                $responseObj = [
                    'status'   => 'SYNCED',
                    'transfer' => $physicalOnly ? array_merge($created, ['bag_unit_rate' => 0, 'total_cost' => 0]) : $created,
                ];
                ErpEngine::recordSyncLog(
                    $pdo,
                    $clientUuid,
                    (string)($body['device_id'] ?? 'WEB-BROWSER'),
                    $clientType,
                    '/api/v1/stock-transfers',
                    'SYNCED',
                    null,
                    $responseObj,
                    (int)$emp['id']
                );
                return $responseObj;
            });

            Auth::jsonResponse($result, 201);
        } catch (InsufficientStockException $e) {
            ErpEngine::recordSyncLog(
                $pdo,
                $clientUuid,
                (string)($body['device_id'] ?? 'WEB-BROWSER'),
                $clientType,
                '/api/v1/stock-transfers',
                'CONFLICT',
                $e->getMessage(),
                null,
                (int)$emp['id']
            );
            Auth::abort(409, $e->getMessage(), ['code' => 'INSUFFICIENT_STOCK']);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    // -----------------------------------------------------------------------
    // Supplier Bag Ledger (Jute & Plastic Bags)
    // -----------------------------------------------------------------------
    if ($uri === '/api/v1/supplier-bags' && $method === 'GET') {
        $supplierIdFilter = isset($_GET['supplier_id']) && is_numeric($_GET['supplier_id']) ? (int)$_GET['supplier_id'] : null;

        $summariesRaw = $pdo->query(
            "SELECT
                pt.id AS supplier_id,
                pt.party_code,
                pt.name AS supplier_name,
                pt.phone,
                pt.address,
                COALESCE(SUM(CASE WHEN sbl.direction = 'OUT_TO_SUPPLIER' THEN sbl.jute_qty ELSE 0 END), 0) AS jute_taken,
                COALESCE(SUM(CASE WHEN sbl.direction = 'IN_FROM_SUPPLIER' THEN sbl.jute_qty ELSE 0 END), 0) AS jute_deposited,
                COALESCE(SUM(CASE WHEN sbl.direction = 'OUT_TO_SUPPLIER' THEN sbl.jute_qty ELSE -sbl.jute_qty END), 0) AS jute_net,
                COALESCE(SUM(CASE WHEN sbl.direction = 'OUT_TO_SUPPLIER' THEN sbl.plastic_qty ELSE 0 END), 0) AS plastic_taken,
                COALESCE(SUM(CASE WHEN sbl.direction = 'IN_FROM_SUPPLIER' THEN sbl.plastic_qty ELSE 0 END), 0) AS plastic_deposited,
                COALESCE(SUM(CASE WHEN sbl.direction = 'OUT_TO_SUPPLIER' THEN sbl.plastic_qty ELSE -sbl.plastic_qty END), 0) AS plastic_net,
                COALESCE(SUM(CASE WHEN sbl.direction = 'OUT_TO_SUPPLIER' THEN sbl.total_qty ELSE 0 END), 0) AS total_taken,
                COALESCE(SUM(CASE WHEN sbl.direction = 'IN_FROM_SUPPLIER' THEN sbl.total_qty ELSE 0 END), 0) AS total_deposited,
                COALESCE(SUM(CASE WHEN sbl.direction = 'OUT_TO_SUPPLIER' THEN sbl.total_qty ELSE -sbl.total_qty END), 0) AS total_net,
                COUNT(sbl.id) AS tx_count
             FROM parties pt
             LEFT JOIN supplier_bag_ledger sbl ON sbl.supplier_id = pt.id
             WHERE pt.party_type IN ('SUPPLIER', 'BOTH') AND pt.is_active = 1
             GROUP BY pt.id, pt.party_code, pt.name, pt.phone, pt.address
             ORDER BY pt.name ASC"
        )->fetchAll();

        $summaries = array_map(static function (array $s): array {
            foreach (['jute_taken', 'jute_deposited', 'jute_net', 'plastic_taken', 'plastic_deposited', 'plastic_net', 'total_taken', 'total_deposited', 'total_net', 'tx_count'] as $k) {
                $s[$k] = (int)$s[$k];
            }
            return $s;
        }, $summariesRaw);

        if ($supplierIdFilter !== null) {
            $eSt = $pdo->prepare(
                'SELECT sbl.*, pt.name AS supplier_name, pt.party_code, e.full_name AS created_by_name
                 FROM supplier_bag_ledger sbl
                 JOIN parties pt ON pt.id = sbl.supplier_id
                 LEFT JOIN employees e ON e.id = sbl.created_by
                 WHERE sbl.supplier_id = ?
                 ORDER BY sbl.entry_date DESC, sbl.id DESC'
            );
            $eSt->execute([$supplierIdFilter]);
            $entries = $eSt->fetchAll();
        } else {
            $entries = $pdo->query(
                'SELECT sbl.*, pt.name AS supplier_name, pt.party_code, e.full_name AS created_by_name
                 FROM supplier_bag_ledger sbl
                 JOIN parties pt ON pt.id = sbl.supplier_id
                 LEFT JOIN employees e ON e.id = sbl.created_by
                 ORDER BY sbl.entry_date DESC, sbl.id DESC
                 LIMIT 300'
            )->fetchAll();
        }

        Auth::jsonResponse(['summaries' => $summaries, 'entries' => $entries]);
    }

    if ($uri === '/api/v1/supplier-bags' && $method === 'POST') {
        $allowed = in_array($emp['role_code'], ['OWNER', 'MANAGER', 'GODOWN_KEEPER'], true)
            || in_array('paddy.purchase.create', $emp['permissions'], true)
            || in_array('purchases.create', $emp['permissions'], true)
            || in_array('parties.manage', $emp['permissions'], true);
        if (!$allowed) {
            Auth::abort(403, 'Permission denied to record supplier bag transactions');
        }

        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        $juteQty    = max(0, (int)round((float)($body['jute_qty'] ?? 0)));
        $plasticQty = max(0, (int)round((float)($body['plastic_qty'] ?? 0)));
        $totalQty   = $juteQty + $plasticQty;
        if (empty($body['supplier_id']) || $totalQty <= 0) {
            Auth::abort(400, 'Supplier and at least one Jute or Plastic bag quantity (> 0) are required');
        }

        $entryType = (string)($body['entry_type'] ?? 'ADVANCE_ISSUE');
        $direction = in_array($entryType, ['EMPTY_RETURN', 'PADDY_DEPOSIT'], true) ? 'IN_FROM_SUPPLIER' : 'OUT_TO_SUPPLIER';
        $entryDate = trim((string)($body['entry_date'] ?? '')) ?: gmdate('Y-m-d');

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $body, $clientUuid, $clientType, $emp, $juteQty, $plasticQty, $totalQty, $entryType, $direction, $entryDate) {
                $seq     = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM supplier_bag_ledger')->fetchColumn();
                $entryNo = 'BAG-2026-' . str_pad((string)$seq, 4, '0', STR_PAD_LEFT);
                $pdo->prepare(
                    "INSERT INTO supplier_bag_ledger (
                        client_uuid, entry_no, supplier_id, entry_type, direction,
                        jute_qty, plastic_qty, total_qty, reference_type, reference_id, reference_no, entry_date, notes, created_by
                     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', NULL, ?, ?, ?, ?)"
                )->execute([
                    $clientUuid,
                    $entryNo,
                    (int)$body['supplier_id'],
                    $entryType,
                    $direction,
                    $juteQty,
                    $plasticQty,
                    $totalQty,
                    trim((string)($body['reference_no'] ?? '')),
                    $entryDate,
                    trim((string)($body['notes'] ?? '')),
                    (int)$emp['id'],
                ]);
                $id = (int)$pdo->lastInsertId();
                $cSt = $pdo->prepare(
                    'SELECT sbl.*, pt.name AS supplier_name, pt.party_code
                     FROM supplier_bag_ledger sbl
                     JOIN parties pt ON pt.id = sbl.supplier_id
                     WHERE sbl.id = ?'
                );
                $cSt->execute([$id]);
                $created = $cSt->fetch();

                ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], "BAG_{$entryType}", 'SUPPLIER_BAG_LEDGER', $entryNo, null, [
                    'supplier_id' => (int)$body['supplier_id'],
                    'direction'   => $direction,
                    'juteQty'     => $juteQty,
                    'plasticQty'  => $plasticQty,
                    'totalQty'    => $totalQty,
                ], $clientType);

                $responseObj = ['status' => 'SYNCED', 'entry' => $created];
                ErpEngine::recordSyncLog($pdo, $clientUuid, 'WEB-BROWSER', $clientType, '/api/v1/supplier-bags', 'SYNCED', null, $responseObj, (int)$emp['id']);
                return $responseObj;
            });

            Auth::jsonResponse($result, 201);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if (preg_match('#^/api/v1/supplier-bags/(\d+)$#', $uri, $m) && $method === 'DELETE') {
        $canDelete = in_array($emp['role_code'], ['OWNER', 'MANAGER'], true)
            || in_array('parties.manage', $emp['permissions'], true);
        if (!$canDelete) {
            Auth::abort(403, 'Permission denied');
        }
        $id = (int)$m[1];
        $st = $pdo->prepare('SELECT * FROM supplier_bag_ledger WHERE id = ?');
        $st->execute([$id]);
        $existing = $st->fetch();
        if (!$existing) {
            Auth::abort(404, 'Bag ledger entry not found');
        }
        if (($existing['reference_type'] ?? '') === 'PADDY_PURCHASE') {
            Auth::abort(400, 'Purchase-linked bag deposits cannot be deleted directly');
        }
        $pdo->prepare('DELETE FROM supplier_bag_ledger WHERE id = ?')->execute([$id]);
        Auth::jsonResponse(['deleted' => true]);
    }

    return false;
}
