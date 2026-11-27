<?php
declare(strict_types=1);

use SonaGrain\Auth;
use SonaGrain\ErpEngine;

function handleMasterAndPartyRoutes(string $method, string $uri, array $body, PDO $pdo, array $emp, string $clientType): bool
{
    $physicalOnly = Auth::isPhysicalOnlyUser($emp);

    $enrichedPartiesSql = "
      SELECT pt.*,
        COALESCE((SELECT SUM(pp.total_payable) FROM paddy_purchases pp WHERE pp.supplier_id = pt.id), 0) AS total_purchased,
        COALESCE((SELECT SUM(si.total_amount) FROM sales_invoices si WHERE si.customer_id = pt.id), 0)
          + COALESCE((SELECT SUM(ps.total_amount) FROM paddy_sales ps WHERE ps.customer_id = pt.id), 0) AS total_sold,
        COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.party_id = pt.id AND pay.direction = 'PAYMENT'), 0)
          + COALESCE((SELECT SUM(pp.paid_amount) FROM paddy_purchases pp WHERE pp.supplier_id = pt.id), 0) AS total_paid_out,
        COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.party_id = pt.id AND pay.direction = 'RECEIPT'), 0)
          + COALESCE((SELECT SUM(si.paid_amount) FROM sales_invoices si WHERE si.customer_id = pt.id), 0)
          + COALESCE((SELECT SUM(ps.paid_amount) FROM paddy_sales ps WHERE ps.customer_id = pt.id), 0) AS total_received_in,
        COALESCE((SELECT SUM(CASE WHEN pp.total_payable - pp.paid_amount > 0 THEN pp.total_payable - pp.paid_amount ELSE 0 END) FROM paddy_purchases pp WHERE pp.supplier_id = pt.id AND pp.payment_status != 'PAID'), 0) AS open_purchase_due,
        COALESCE((SELECT SUM(CASE WHEN si.total_amount - si.paid_amount > 0 THEN si.total_amount - si.paid_amount ELSE 0 END) FROM sales_invoices si WHERE si.customer_id = pt.id AND si.payment_status != 'PAID'), 0)
          + COALESCE((SELECT SUM(CASE WHEN ps.total_amount - ps.paid_amount > 0 THEN ps.total_amount - ps.paid_amount ELSE 0 END) FROM paddy_sales ps WHERE ps.customer_id = pt.id AND ps.payment_status != 'PAID'), 0) AS open_sales_due
      FROM parties pt
    ";

    $castPartyRow = static function (array $p): array {
        foreach ([
            'credit_limit', 'opening_balance', 'current_balance',
            'total_purchased', 'total_sold', 'total_paid_out', 'total_received_in',
            'open_purchase_due', 'open_sales_due',
        ] as $k) {
            if (isset($p[$k])) {
                $p[$k] = (float)$p[$k];
            }
        }
        return $p;
    };

    $resolveOpening = static function (mixed $amount, ?string $balanceMode, string $partyType): float {
        $amt = max(0.0, (float)($amount ?? 0));
        if ($amt === 0.0) {
            return 0.0;
        }
        if (in_array($balanceMode, ['CUSTOMER_DUE', 'SUPPLIER_ADVANCE', 'RECEIVABLE'], true)) {
            return $amt;
        }
        if (in_array($balanceMode, ['SUPPLIER_DUE', 'CUSTOMER_ADVANCE', 'PAYABLE'], true)) {
            return -$amt;
        }
        if ($balanceMode === 'DUE') {
            return $partyType === 'SUPPLIER' ? -$amt : $amt;
        }
        if ($balanceMode === 'ADVANCE') {
            return $partyType === 'CUSTOMER' ? -$amt : $amt;
        }
        return (float)($amount ?? 0);
    };

    if ($uri === '/api/v1/dashboard' && $method === 'GET') {
        $lots = $pdo->query(
            'SELECT l.*, i.category, i.name AS item_name
             FROM inventory_lots l
             JOIN items i ON i.id = l.item_id
             WHERE l.remaining_qty_kg > 0 OR COALESCE(l.weight_pending, 0) = 1'
        )->fetchAll();

        $paddyKg   = 0.0;
        $riceKg    = 0.0;
        $bypKg     = 0.0;
        $valuation = 0.0;
        $whStats   = [];

        foreach ($lots as $lot) {
            $isPending = !empty($lot['weight_pending']);
            $qty = (float)$lot['remaining_qty_kg'];
            $val = $physicalOnly
                ? 0.0
                : ($isPending ? (float)($lot['pending_cost_total'] ?? 0) : ($qty * (float)$lot['unit_cost_per_kg']));
            $valuation += $val;
            if ($lot['category'] === 'PADDY') {
                $paddyKg += $qty;
            } elseif ($lot['category'] === 'HEAD_RICE') {
                $riceKg += $qty;
            } else {
                $bypKg += $qty;
            }
            $wid = (int)$lot['warehouse_id'];
            if (!isset($whStats[$wid])) {
                $whStats[$wid] = ['qty' => 0.0, 'val' => 0.0];
            }
            $whStats[$wid]['qty'] += $qty;
            $whStats[$wid]['val'] += $val;
        }

        $warehouses = $pdo->query('SELECT * FROM warehouses WHERE is_active = 1')->fetchAll();
        $warehouseUtilization = array_map(static function (array $w) use ($whStats, $physicalOnly): array {
            $s = $whStats[(int)$w['id']] ?? ['qty' => 0.0, 'val' => 0.0];
            return array_merge($w, [
                'current_stock_kg' => round($s['qty'], 2),
                'valuation'        => $physicalOnly ? 0 : round($s['val'], 2),
            ]);
        }, $warehouses);

        $purAgg = $pdo->query('SELECT COALESCE(SUM(total_payable), 0) AS total, COALESCE(SUM(discrepancy_flagged), 0) AS flagged FROM paddy_purchases')->fetch();
        $riceSalesAgg = $physicalOnly
            ? ['rev' => 0, 'cogs' => 0]
            : $pdo->query('SELECT COALESCE(SUM(total_amount), 0) AS rev, COALESCE(SUM(total_cogs), 0) AS cogs FROM sales_invoices')->fetch();
        $paddySalesAgg = $physicalOnly
            ? ['rev' => 0, 'cogs' => 0]
            : $pdo->query('SELECT COALESCE(SUM(total_amount), 0) AS rev, COALESCE(SUM(cogs_amount), 0) AS cogs FROM paddy_sales')->fetch();
        $cashBankAgg = $physicalOnly
            ? ['bal' => 0]
            : $pdo->query("SELECT COALESCE(SUM(balance), 0) AS bal FROM accounts WHERE account_code IN ('1001', '1002')")->fetch();

        $batchAgg = $physicalOnly
            ? ['siddho_batches' => 0, 'atap_batches' => 0, 'avg_yield' => 0, 'total_milled' => 0]
            : $pdo->query(
                "SELECT
                    SUM(CASE WHEN process_type = 'PARBOILED_SIDDHO' THEN 1 ELSE 0 END) AS siddho_batches,
                    SUM(CASE WHEN process_type = 'RAW_ATAP' THEN 1 ELSE 0 END) AS atap_batches,
                    COALESCE(AVG(head_rice_yield_pct), 0) AS avg_yield,
                    COALESCE(SUM(input_paddy_qty_kg), 0) AS total_milled
                 FROM production_batches"
            )->fetch();

        $recentPurchasesRaw = $pdo->query(
            'SELECT p.*, pt.name AS supplier_name, w.name AS warehouse_name, i.name AS item_name
             FROM paddy_purchases p
             JOIN parties pt ON pt.id = p.supplier_id
             JOIN warehouses w ON w.id = p.warehouse_id
             JOIN items i ON i.id = p.item_id
             ORDER BY p.id DESC LIMIT 5'
        )->fetchAll();
        $recentPurchases = $physicalOnly
            ? array_map([Auth::class, 'sanitizePurchaseForPhysical'], $recentPurchasesRaw)
            : $recentPurchasesRaw;

        $recentBatches = $physicalOnly
            ? []
            : $pdo->query(
                'SELECT b.*, i.name AS paddy_item_name, w.name AS source_warehouse_name,
                        cs.net_head_rice_cost, cs.cost_per_kg_head_rice
                 FROM production_batches b
                 JOIN items i ON i.id = b.paddy_item_id
                 JOIN warehouses w ON w.id = b.source_warehouse_id
                 LEFT JOIN production_cost_sheets cs ON cs.batch_id = b.id
                 ORDER BY b.id DESC LIMIT 5'
            )->fetchAll();

        $recentSales = $physicalOnly
            ? []
            : $pdo->query(
                'SELECT s.*, pt.name AS customer_name
                 FROM sales_invoices s
                 JOIN parties pt ON pt.id = s.customer_id
                 ORDER BY s.id DESC LIMIT 5'
            )->fetchAll();

        $totalRev  = (float)($riceSalesAgg['rev'] ?? 0) + (float)($paddySalesAgg['rev'] ?? 0);
        $totalCogs = (float)($riceSalesAgg['cogs'] ?? 0) + (float)($paddySalesAgg['cogs'] ?? 0);

        Auth::jsonResponse([
            'kpis' => [
                'total_paddy_stock_kg'       => round($paddyKg, 2),
                'total_rice_stock_kg'        => round($riceKg, 2),
                'total_byproduct_stock_kg'   => round($bypKg, 2),
                'inventory_valuation'        => $physicalOnly ? 0 : round($valuation, 2),
                'monthly_purchases'          => $physicalOnly ? 0 : round((float)($purAgg['total'] ?? 0), 2),
                'monthly_sales'              => $physicalOnly ? 0 : round($totalRev, 2),
                'monthly_gross_profit'       => $physicalOnly ? 0 : round($totalRev - $totalCogs, 2),
                'flagged_weight_discrepancies' => (int)($purAgg['flagged'] ?? 0),
                'cash_and_bank_balance'      => $physicalOnly ? 0 : round((float)($cashBankAgg['bal'] ?? 0), 2),
            ],
            'warehouse_utilization' => $warehouseUtilization,
            'production_summary'    => [
                'siddho_batches'          => (int)($batchAgg['siddho_batches'] ?? 0),
                'atap_batches'            => (int)($batchAgg['atap_batches'] ?? 0),
                'avg_head_rice_yield_pct' => round((float)($batchAgg['avg_yield'] ?? 0), 2),
                'total_paddy_milled_kg'   => round((float)($batchAgg['total_milled'] ?? 0), 2),
            ],
            'recent_purchases'      => $recentPurchases,
            'recent_batches'        => $recentBatches,
            'recent_sales'          => $recentSales,
        ]);
    }

    if ($uri === '/api/v1/master' && $method === 'GET') {
        $warehouses = $pdo->query(
            'SELECT w.*, COALESCE((SELECT SUM(l.remaining_qty_kg) FROM inventory_lots l WHERE l.warehouse_id = w.id), 0) AS current_stock_kg
             FROM warehouses w ORDER BY w.id ASC'
        )->fetchAll();
        foreach ($warehouses as &$w) {
            $w['current_stock_kg'] = (float)$w['current_stock_kg'];
        }
        unset($w);

        $units = $pdo->query(
            'SELECT u.*, (SELECT COUNT(*) FROM items i WHERE i.unit = u.code) AS product_count
             FROM product_units u ORDER BY u.id ASC'
        )->fetchAll();
        $categories = $pdo->query(
            'SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category = c.code) AS product_count
             FROM product_categories c ORDER BY c.id ASC'
        )->fetchAll();

        $itemsRaw = $pdo->query('SELECT * FROM items ORDER BY id ASC')->fetchAll();
        $items    = $physicalOnly
            ? array_map(static fn(array $i): array => array_merge($i, ['default_rate' => 0]), $itemsRaw)
            : $itemsRaw;

        $partiesRaw = array_map($castPartyRow, $pdo->query("{$enrichedPartiesSql} ORDER BY pt.name ASC")->fetchAll());
        $parties    = $physicalOnly
            ? array_values(array_map(
                static fn(array $p): array => array_merge($p, [
                    'credit_limit'      => 0,
                    'opening_balance'   => 0,
                    'current_balance'   => 0,
                    'total_purchased'   => 0,
                    'total_sold'        => 0,
                    'total_paid_out'    => 0,
                    'total_received_in' => 0,
                    'open_purchase_due' => 0,
                    'open_sales_due'    => 0,
                ]),
                array_filter($partiesRaw, static fn(array $p): bool => in_array($p['party_type'], ['SUPPLIER', 'BOTH'], true))
            ))
            : $partiesRaw;

        $accounts        = $physicalOnly ? [] : $pdo->query('SELECT * FROM accounts ORDER BY account_code ASC')->fetchAll();
        $roles           = $pdo->query('SELECT * FROM roles ORDER BY id ASC')->fetchAll();
        $companySettings = $pdo->query('SELECT * FROM company_settings WHERE id = 1')->fetch();

        Auth::jsonResponse([
            'warehouses'       => $warehouses,
            'units'            => $units,
            'categories'       => $categories,
            'items'            => $items,
            'parties'          => $parties,
            'accounts'         => $accounts,
            'roles'            => $roles,
            'company_settings' => $companySettings ?: null,
        ]);
    }

    if ($uri === '/api/v1/company-settings' && $method === 'PUT') {
        $canManage = in_array($emp['role_code'], ['OWNER', 'MANAGER'], true)
            || in_array('employees.manage', $emp['permissions'], true);
        if (!$canManage) {
            Auth::abort(403, 'Only Mill Owner or Manager can customize company profile settings');
        }

        $nameEn = trim((string)($body['company_name_en'] ?? ''));
        $nameBn = trim((string)($body['company_name_bn'] ?? '')) ?: $nameEn;
        if ($nameEn === '' && $nameBn === '') {
            Auth::abort(400, 'Company name is required');
        }

        $existing = $pdo->query('SELECT * FROM company_settings WHERE id = 1')->fetch();
        $rawShort = strtoupper(trim((string)($body['short_code'] ?? '')));
        $shortCode = $rawShort !== '' ? mb_substr($rawShort, 0, 4) : '';
        if ($shortCode === '' && $nameEn !== '') {
            $words = preg_split('/\s+/', $nameEn) ?: [];
            $initials = '';
            foreach ($words as $wd) {
                if ($wd !== '') {
                    $initials .= mb_substr($wd, 0, 1);
                }
            }
            $shortCode = strtoupper(mb_substr($initials, 0, 2)) ?: 'SG';
        }
        if ($shortCode === '') {
            $shortCode = 'SG';
        }

        $logoDataUrl = trim((string)($body['logo_data_url'] ?? ''));
        if ($logoDataUrl !== '') {
            if (strlen($logoDataUrl) > 800000) {
                Auth::abort(400, 'Logo image is too large (max ~600 KB)');
            }
            if (!preg_match('/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);(base64,|charset=utf-8,)/i', $logoDataUrl)) {
                Auth::abort(400, 'Invalid logo image format. Please upload PNG, JPG, WebP, GIF, or SVG.');
            }
        }

        $params = [
            $nameEn ?: $nameBn,
            $nameBn ?: $nameEn,
            $shortCode,
            trim((string)($body['tagline_en'] ?? '')),
            trim((string)($body['tagline_bn'] ?? '')),
            trim((string)($body['address_en'] ?? '')),
            trim((string)($body['address_bn'] ?? '')),
            trim((string)($body['phone'] ?? '')),
            trim((string)($body['email'] ?? '')),
            trim((string)($body['tax_id'] ?? '')),
            $logoDataUrl,
        ];

        if ($existing) {
            $pdo->prepare(
                'UPDATE company_settings SET
                    company_name_en = ?, company_name_bn = ?, short_code = ?,
                    tagline_en = ?, tagline_bn = ?, address_en = ?, address_bn = ?,
                    phone = ?, email = ?, tax_id = ?, logo_data_url = ?, updated_at = NOW()
                 WHERE id = 1'
            )->execute($params);
        } else {
            $pdo->prepare(
                'INSERT INTO company_settings (
                    id, company_name_en, company_name_bn, short_code, tagline_en, tagline_bn,
                    address_en, address_bn, phone, email, tax_id, logo_data_url, updated_at
                 ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())'
            )->execute($params);
        }

        $updated = $pdo->query('SELECT * FROM company_settings WHERE id = 1')->fetch();
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'COMPANY_SETTINGS_UPDATED', 'COMPANY_SETTINGS', '1', $existing ?: null, $updated ?: null, $clientType);
        Auth::jsonResponse(['company' => $updated]);
    }

    // Warehouses CRUD
    if ($uri === '/api/v1/warehouses' && $method === 'POST') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $code   = strtoupper(trim((string)($body['code'] ?? '')));
        $name   = trim((string)($body['name'] ?? ''));
        $type   = (string)($body['warehouse_type'] ?? '');
        if ($code === '' || $name === '' || $type === '') {
            Auth::abort(400, 'Warehouse code, name, and type are required');
        }
        $activeVal = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : 1;
        $pdo->prepare(
            'INSERT INTO warehouses (code, name, warehouse_type, location, capacity_kg, manager_employee_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )->execute([$code, $name, $type, (string)($body['location'] ?? ''), (float)($body['capacity_kg'] ?? 0), (int)$emp['id'], $activeVal]);
        $id = (int)$pdo->lastInsertId();
        $st = $pdo->prepare('SELECT *, 0 AS current_stock_kg FROM warehouses WHERE id = ?');
        $st->execute([$id]);
        $wh = $st->fetch();
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'CREATE_WAREHOUSE', 'WAREHOUSE', (string)$id, null, $wh ?: null, $clientType);
        Auth::jsonResponse(['warehouse' => $wh], 201);
    }

    if (preg_match('#^/api/v1/warehouses/(\d+)$#', $uri, $m) && $method === 'PUT') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM warehouses WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Warehouse not found');
        }
        $code = strtoupper(trim((string)($body['code'] ?? '')));
        $name = trim((string)($body['name'] ?? ''));
        $type = (string)($body['warehouse_type'] ?? '');
        if ($code === '' || $name === '' || $type === '') {
            Auth::abort(400, 'Warehouse code, name, and type are required');
        }
        $activeVal = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : (int)$existing['is_active'];
        $pdo->prepare(
            'UPDATE warehouses SET code = ?, name = ?, warehouse_type = ?, location = ?, capacity_kg = ?, is_active = ? WHERE id = ?'
        )->execute([$code, $name, $type, (string)($body['location'] ?? ''), (float)($body['capacity_kg'] ?? 0), $activeVal, $id]);

        $upSt = $pdo->prepare(
            'SELECT w.*, COALESCE((SELECT SUM(l.remaining_qty_kg) FROM inventory_lots l WHERE l.warehouse_id = w.id), 0) AS current_stock_kg
             FROM warehouses w WHERE w.id = ?'
        );
        $upSt->execute([$id]);
        $updated = $upSt->fetch();
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'UPDATE_WAREHOUSE', 'WAREHOUSE', (string)$id, $existing, $updated ?: null, $clientType);
        Auth::jsonResponse(['warehouse' => $updated]);
    }

    if (preg_match('#^/api/v1/warehouses/(\d+)/status$#', $uri, $m) && $method === 'PATCH') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM warehouses WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Warehouse not found');
        }
        $nextActive = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : ((int)$existing['is_active'] ? 0 : 1);
        $pdo->prepare('UPDATE warehouses SET is_active = ? WHERE id = ?')->execute([$nextActive, $id]);
        $upSt = $pdo->prepare('SELECT * FROM warehouses WHERE id = ?');
        $upSt->execute([$id]);
        $updated = $upSt->fetch();
        ErpEngine::writeAudit(
            $pdo,
            (int)$emp['id'],
            $emp['full_name'],
            $nextActive ? 'ACTIVATE_WAREHOUSE' : 'DEACTIVATE_WAREHOUSE',
            'WAREHOUSE',
            (string)$existing['code'],
            ['is_active' => $existing['is_active']],
            ['is_active' => $nextActive],
            $clientType
        );
        Auth::jsonResponse(['warehouse' => $updated]);
    }

    if (preg_match('#^/api/v1/warehouses/(\d+)$#', $uri, $m) && $method === 'DELETE') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM warehouses WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Warehouse not found');
        }
        $refSt = $pdo->prepare(
            'SELECT
                (SELECT COUNT(*) FROM inventory_lots WHERE warehouse_id = ?)
              + (SELECT COUNT(*) FROM paddy_purchases WHERE warehouse_id = ?)
              + (SELECT COUNT(*) FROM stock_transfers WHERE from_warehouse_id = ? OR to_warehouse_id = ?)
              + (SELECT COUNT(*) FROM production_batches WHERE source_warehouse_id = ?)
              + (SELECT COUNT(*) FROM sales_invoice_items WHERE warehouse_id = ?)'
        );
        $refSt->execute([$id, $id, $id, $id, $id, $id]);
        if ((int)$refSt->fetchColumn() > 0) {
            Auth::abort(409, "Cannot delete godown \"{$existing['name']}\" because it has stock lots or historical transactions. Set it Inactive instead.");
        }
        $pdo->prepare('DELETE FROM warehouses WHERE id = ?')->execute([$id]);
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'DELETE_WAREHOUSE', 'WAREHOUSE', (string)$existing['code'], $existing, null, $clientType);
        Auth::jsonResponse(['deleted' => true, 'id' => $id]);
    }

    // Items CRUD
    if ($uri === '/api/v1/items' && $method === 'POST') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $sku          = strtoupper(trim((string)($body['sku'] ?? '')));
        $name         = trim((string)($body['name'] ?? ''));
        $category     = trim((string)($body['category'] ?? ''));
        $processGrade = (string)($body['process_grade'] ?? '');
        if ($sku === '' || $name === '' || $category === '' || $processGrade === '') {
            Auth::abort(400, 'SKU, product name, category, and process grade are required');
        }
        $activeVal = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : 1;
        $catCode   = strtoupper($category);
        $unitCode  = strtoupper(trim((string)($body['unit'] ?? 'KG')) ?: 'KG');
        $bagWt     = (float)($body['bag_weight_kg'] ?? 50);
        $cm        = (string)($body['costing_method'] ?? 'FIFO');

        $catChk = $pdo->prepare('SELECT id FROM product_categories WHERE UPPER(code) = ?');
        $catChk->execute([$catCode]);
        if (!$catChk->fetch()) {
            $groupType = ($processGrade === 'RAW_PADDY' || in_array($catCode, ['PADDY', 'RAW_PADDY'], true))
                ? 'RAW_MATERIAL'
                : (($processGrade === 'BY_PRODUCT' || in_array($catCode, ['BROKEN_RICE', 'BRAN', 'RICE_BRAN', 'HUSK'], true)) ? 'BY_PRODUCT' : 'FINISHED_GOOD');
            $catNames = ['PADDY' => 'Raw Paddy', 'RAW_PADDY' => 'Raw Paddy', 'HEAD_RICE' => 'Head Rice', 'BROKEN_RICE' => 'Broken Rice (Khud)', 'BRAN' => 'Rice Bran (Kura)', 'RICE_BRAN' => 'Rice Bran (Kura)', 'HUSK' => 'Paddy Husk (Tush)'];
            $pdo->prepare('INSERT INTO product_categories (code, name, group_type, default_costing_method, description, is_active) VALUES (?, ?, ?, ?, ?, 1)')
                ->execute([$catCode, $catNames[$catCode] ?? $catCode, $groupType, $cm, 'Auto-created with product']);
        }

        $unitChk = $pdo->prepare('SELECT id FROM product_units WHERE UPPER(code) = ?');
        $unitChk->execute([$unitCode]);
        if (!$unitChk->fetch()) {
            $unitDefs = [
                'KG'    => ['Kilogram', 'kg', 1.0],
                'BAG50' => ['50 kg Bag', 'bag', 50.0],
                'QTL'   => ['Quintal (100 kg)', 'qtl', 100.0],
                'MT'    => ['Metric Ton (1000 kg)', 'MT', 1000.0],
            ];
            $uDef = $unitDefs[$unitCode] ?? [$unitCode, strtolower($unitCode), $bagWt > 0 ? $bagWt : 1.0];
            $pdo->prepare('INSERT INTO product_units (code, name, symbol, base_weight_kg, description, is_active) VALUES (?, ?, ?, ?, ?, 1)')
                ->execute([$unitCode, $uDef[0], $uDef[1], $uDef[2], 'Auto-created with product']);
        }

        $pdo->prepare(
            'INSERT INTO items (sku, name, category, process_grade, unit, bag_weight_kg, costing_method, default_rate, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([$sku, $name, $catCode, $processGrade, $unitCode, $bagWt ?: 50, $cm, (float)($body['default_rate'] ?? 0), $activeVal]);
        $id = (int)$pdo->lastInsertId();
        $st = $pdo->prepare('SELECT * FROM items WHERE id = ?');
        $st->execute([$id]);
        $item = $st->fetch();
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'CREATE_PRODUCT', 'ITEM', $sku, null, $item ?: null, $clientType);
        Auth::jsonResponse(['item' => $item], 201);
    }

    if (preg_match('#^/api/v1/items/(\d+)$#', $uri, $m) && $method === 'PUT') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM items WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Product not found');
        }
        $sku          = strtoupper(trim((string)($body['sku'] ?? '')));
        $name         = trim((string)($body['name'] ?? ''));
        $category     = (string)($body['category'] ?? '');
        $processGrade = (string)($body['process_grade'] ?? '');
        if ($sku === '' || $name === '' || $category === '' || $processGrade === '') {
            Auth::abort(400, 'SKU, product name, category, and process grade are required');
        }
        $activeVal = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : (int)$existing['is_active'];
        $pdo->prepare(
            'UPDATE items SET sku = ?, name = ?, category = ?, process_grade = ?, unit = ?, bag_weight_kg = ?, costing_method = ?, default_rate = ?, is_active = ? WHERE id = ?'
        )->execute([
            $sku,
            $name,
            $category,
            $processGrade,
            strtoupper(trim((string)($body['unit'] ?? 'KG')) ?: 'KG'),
            (float)($body['bag_weight_kg'] ?? 50) ?: 50,
            (string)($body['costing_method'] ?? 'FIFO'),
            (float)($body['default_rate'] ?? 0),
            $activeVal,
            $id,
        ]);
        $upSt = $pdo->prepare('SELECT * FROM items WHERE id = ?');
        $upSt->execute([$id]);
        $updated = $upSt->fetch();
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'UPDATE_PRODUCT', 'ITEM', $sku, $existing, $updated ?: null, $clientType);
        Auth::jsonResponse(['item' => $updated]);
    }

    if (preg_match('#^/api/v1/items/(\d+)/status$#', $uri, $m) && $method === 'PATCH') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM items WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Product not found');
        }
        $nextActive = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : ((int)$existing['is_active'] ? 0 : 1);
        $pdo->prepare('UPDATE items SET is_active = ? WHERE id = ?')->execute([$nextActive, $id]);
        $upSt = $pdo->prepare('SELECT * FROM items WHERE id = ?');
        $upSt->execute([$id]);
        $updated = $upSt->fetch();
        ErpEngine::writeAudit(
            $pdo,
            (int)$emp['id'],
            $emp['full_name'],
            $nextActive ? 'ACTIVATE_PRODUCT' : 'DEACTIVATE_PRODUCT',
            'ITEM',
            (string)$existing['sku'],
            ['is_active' => $existing['is_active']],
            ['is_active' => $nextActive],
            $clientType
        );
        Auth::jsonResponse(['item' => $updated]);
    }

    if (preg_match('#^/api/v1/items/(\d+)$#', $uri, $m) && $method === 'DELETE') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM items WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Product not found');
        }
        $refSt = $pdo->prepare(
            'SELECT
                (SELECT COUNT(*) FROM inventory_lots WHERE item_id = ?)
              + (SELECT COUNT(*) FROM paddy_purchases WHERE item_id = ?)
              + (SELECT COUNT(*) FROM production_batches WHERE paddy_item_id = ?)
              + (SELECT COUNT(*) FROM sales_invoice_items WHERE item_id = ?)
              + (SELECT COUNT(*) FROM paddy_sales WHERE item_id = ?)'
        );
        $refSt->execute([$id, $id, $id, $id, $id]);
        if ((int)$refSt->fetchColumn() > 0) {
            Auth::abort(409, "Cannot delete product \"{$existing['name']}\" because it has stock lots or historical transactions. Set it Inactive instead.");
        }
        $pdo->prepare('DELETE FROM items WHERE id = ?')->execute([$id]);
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'DELETE_PRODUCT', 'ITEM', (string)$existing['sku'], $existing, null, $clientType);
        Auth::jsonResponse(['deleted' => true, 'id' => $id]);
    }

    // Product Units CRUD
    if ($uri === '/api/v1/product-units' && $method === 'GET') {
        $units = $pdo->query(
            'SELECT u.*, (SELECT COUNT(*) FROM items i WHERE i.unit = u.code) AS product_count
             FROM product_units u ORDER BY u.id ASC'
        )->fetchAll();
        Auth::jsonResponse(['units' => $units]);
    }

    if ($uri === '/api/v1/product-units' && $method === 'POST') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $code       = strtoupper(trim((string)($body['code'] ?? '')));
        $name       = trim((string)($body['name'] ?? ''));
        $baseWeight = (float)($body['base_weight_kg'] ?? 1);
        if ($code === '' || $name === '') {
            Auth::abort(400, 'Unit code and name are required');
        }
        if ($baseWeight <= 0) {
            Auth::abort(400, 'Base weight equivalent (kg) must be greater than zero');
        }
        $activeVal = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : 1;
        $symbol    = trim((string)($body['symbol'] ?? strtolower($code))) ?: strtolower($code);
        $pdo->prepare('INSERT INTO product_units (code, name, symbol, base_weight_kg, description, is_active) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$code, $name, $symbol, $baseWeight, (string)($body['description'] ?? ''), $activeVal]);
        $id = (int)$pdo->lastInsertId();
        $st = $pdo->prepare('SELECT *, 0 AS product_count FROM product_units WHERE id = ?');
        $st->execute([$id]);
        $unit = $st->fetch();
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'CREATE_PRODUCT_UNIT', 'PRODUCT_UNIT', $code, null, $unit ?: null, $clientType);
        Auth::jsonResponse(['unit' => $unit], 201);
    }

    if (preg_match('#^/api/v1/product-units/(\d+)$#', $uri, $m) && $method === 'PUT') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM product_units WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Product unit not found');
        }
        $code       = strtoupper(trim((string)($body['code'] ?? '')));
        $name       = trim((string)($body['name'] ?? ''));
        $baseWeight = (float)($body['base_weight_kg'] ?? 1);
        if ($code === '' || $name === '') {
            Auth::abort(400, 'Unit code and name are required');
        }
        if ($baseWeight <= 0) {
            Auth::abort(400, 'Base weight equivalent (kg) must be greater than zero');
        }
        $activeVal = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : (int)$existing['is_active'];
        $symbol    = trim((string)($body['symbol'] ?? strtolower($code))) ?: strtolower($code);
        $updated   = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $code, $name, $symbol, $baseWeight, $body, $activeVal, $id, $existing) {
            $pdo->prepare('UPDATE product_units SET code = ?, name = ?, symbol = ?, base_weight_kg = ?, description = ?, is_active = ? WHERE id = ?')
                ->execute([$code, $name, $symbol, $baseWeight, (string)($body['description'] ?? ''), $activeVal, $id]);
            if ($existing['code'] !== $code) {
                $pdo->prepare('UPDATE items SET unit = ? WHERE unit = ?')->execute([$code, $existing['code']]);
            }
            $st = $pdo->prepare('SELECT u.*, (SELECT COUNT(*) FROM items i WHERE i.unit = u.code) AS product_count FROM product_units u WHERE u.id = ?');
            $st->execute([$id]);
            return $st->fetch();
        });
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'UPDATE_PRODUCT_UNIT', 'PRODUCT_UNIT', $code, $existing, $updated ?: null, $clientType);
        Auth::jsonResponse(['unit' => $updated]);
    }

    if (preg_match('#^/api/v1/product-units/(\d+)/status$#', $uri, $m) && $method === 'PATCH') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM product_units WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Product unit not found');
        }
        $nextActive = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : ((int)$existing['is_active'] ? 0 : 1);
        $pdo->prepare('UPDATE product_units SET is_active = ? WHERE id = ?')->execute([$nextActive, $id]);
        $upSt = $pdo->prepare('SELECT * FROM product_units WHERE id = ?');
        $upSt->execute([$id]);
        $updated = $upSt->fetch();
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], $nextActive ? 'ACTIVATE_PRODUCT_UNIT' : 'DEACTIVATE_PRODUCT_UNIT', 'PRODUCT_UNIT', (string)$existing['code'], ['is_active' => $existing['is_active']], ['is_active' => $nextActive], $clientType);
        Auth::jsonResponse(['unit' => $updated]);
    }

    if (preg_match('#^/api/v1/product-units/(\d+)$#', $uri, $m) && $method === 'DELETE') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM product_units WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Product unit not found');
        }
        $cntSt = $pdo->prepare('SELECT COUNT(*) FROM items WHERE unit = ?');
        $cntSt->execute([$existing['code']]);
        $refCount = (int)$cntSt->fetchColumn();
        if ($refCount > 0) {
            Auth::abort(409, "Cannot delete unit \"{$existing['name']}\" because {$refCount} product(s) currently use it. Set it Inactive instead.");
        }
        $pdo->prepare('DELETE FROM product_units WHERE id = ?')->execute([$id]);
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'DELETE_PRODUCT_UNIT', 'PRODUCT_UNIT', (string)$existing['code'], $existing, null, $clientType);
        Auth::jsonResponse(['deleted' => true, 'id' => $id]);
    }

    // Product Categories CRUD
    if ($uri === '/api/v1/product-categories' && $method === 'GET') {
        $cats = $pdo->query(
            'SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category = c.code) AS product_count
             FROM product_categories c ORDER BY c.id ASC'
        )->fetchAll();
        Auth::jsonResponse(['categories' => $cats]);
    }

    if ($uri === '/api/v1/product-categories' && $method === 'POST') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $rawCode = trim((string)($body['code'] ?? ''));
        $name    = trim((string)($body['name'] ?? ''));
        if ($rawCode === '' || $name === '') {
            Auth::abort(400, 'Category code and name are required');
        }
        $cleanCode = (string)preg_replace('/\s+/', '_', strtoupper($rawCode));
        $activeVal = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : 1;
        $pdo->prepare(
            'INSERT INTO product_categories (code, name, group_type, default_costing_method, description, is_active) VALUES (?, ?, ?, ?, ?, ?)'
        )->execute([
            $cleanCode,
            $name,
            (string)($body['group_type'] ?? 'FINISHED_GOOD'),
            (string)($body['default_costing_method'] ?? 'FIFO'),
            (string)($body['description'] ?? ''),
            $activeVal,
        ]);
        $id = (int)$pdo->lastInsertId();
        $st = $pdo->prepare('SELECT *, 0 AS product_count FROM product_categories WHERE id = ?');
        $st->execute([$id]);
        $cat = $st->fetch();
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'CREATE_PRODUCT_CATEGORY', 'PRODUCT_CATEGORY', $cleanCode, null, $cat ?: null, $clientType);
        Auth::jsonResponse(['category' => $cat], 201);
    }

    if (preg_match('#^/api/v1/product-categories/(\d+)$#', $uri, $m) && $method === 'PUT') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM product_categories WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Product category not found');
        }
        $rawCode = trim((string)($body['code'] ?? ''));
        $name    = trim((string)($body['name'] ?? ''));
        if ($rawCode === '' || $name === '') {
            Auth::abort(400, 'Category code and name are required');
        }
        $cleanCode = (string)preg_replace('/\s+/', '_', strtoupper($rawCode));
        $activeVal = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : (int)$existing['is_active'];
        $updated   = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $cleanCode, $name, $body, $activeVal, $id, $existing) {
            $pdo->prepare(
                'UPDATE product_categories SET code = ?, name = ?, group_type = ?, default_costing_method = ?, description = ?, is_active = ? WHERE id = ?'
            )->execute([
                $cleanCode,
                $name,
                (string)($body['group_type'] ?? 'FINISHED_GOOD'),
                (string)($body['default_costing_method'] ?? 'FIFO'),
                (string)($body['description'] ?? ''),
                $activeVal,
                $id,
            ]);
            if ($existing['code'] !== $cleanCode) {
                $pdo->prepare('UPDATE items SET category = ? WHERE category = ?')->execute([$cleanCode, $existing['code']]);
            }
            $st = $pdo->prepare('SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category = c.code) AS product_count FROM product_categories c WHERE c.id = ?');
            $st->execute([$id]);
            return $st->fetch();
        });
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'UPDATE_PRODUCT_CATEGORY', 'PRODUCT_CATEGORY', $cleanCode, $existing, $updated ?: null, $clientType);
        Auth::jsonResponse(['category' => $updated]);
    }

    if (preg_match('#^/api/v1/product-categories/(\d+)/status$#', $uri, $m) && $method === 'PATCH') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM product_categories WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Product category not found');
        }
        $nextActive = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : ((int)$existing['is_active'] ? 0 : 1);
        $pdo->prepare('UPDATE product_categories SET is_active = ? WHERE id = ?')->execute([$nextActive, $id]);
        $upSt = $pdo->prepare('SELECT * FROM product_categories WHERE id = ?');
        $upSt->execute([$id]);
        $updated = $upSt->fetch();
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], $nextActive ? 'ACTIVATE_PRODUCT_CATEGORY' : 'DEACTIVATE_PRODUCT_CATEGORY', 'PRODUCT_CATEGORY', (string)$existing['code'], ['is_active' => $existing['is_active']], ['is_active' => $nextActive], $clientType);
        Auth::jsonResponse(['category' => $updated]);
    }

    if (preg_match('#^/api/v1/product-categories/(\d+)$#', $uri, $m) && $method === 'DELETE') {
        Auth::requirePermission($emp, 'stock.transfer');
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM product_categories WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Product category not found');
        }
        $cntSt = $pdo->prepare('SELECT COUNT(*) FROM items WHERE category = ?');
        $cntSt->execute([$existing['code']]);
        $refCount = (int)$cntSt->fetchColumn();
        if ($refCount > 0) {
            Auth::abort(409, "Cannot delete category \"{$existing['name']}\" because {$refCount} product(s) belong to it. Set it Inactive instead.");
        }
        $pdo->prepare('DELETE FROM product_categories WHERE id = ?')->execute([$id]);
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'DELETE_PRODUCT_CATEGORY', 'PRODUCT_CATEGORY', (string)$existing['code'], $existing, null, $clientType);
        Auth::jsonResponse(['deleted' => true, 'id' => $id]);
    }

    // Parties CRUD & Ledger
    if ($uri === '/api/v1/parties' && $method === 'GET') {
        $partiesRaw = array_map($castPartyRow, $pdo->query("{$enrichedPartiesSql} ORDER BY pt.name ASC")->fetchAll());
        $parties    = $physicalOnly
            ? array_values(array_map(
                static fn(array $p): array => array_merge($p, [
                    'credit_limit'      => 0,
                    'opening_balance'   => 0,
                    'current_balance'   => 0,
                    'total_purchased'   => 0,
                    'total_sold'        => 0,
                    'total_paid_out'    => 0,
                    'total_received_in' => 0,
                    'open_purchase_due' => 0,
                    'open_sales_due'    => 0,
                ]),
                array_filter($partiesRaw, static fn(array $p): bool => in_array($p['party_type'], ['SUPPLIER', 'BOTH'], true))
            ))
            : $partiesRaw;
        Auth::jsonResponse(['parties' => $parties]);
    }

    if ($uri === '/api/v1/parties' && $method === 'POST') {
        Auth::requirePermission($emp, 'parties.manage');
        $partyType = (string)($body['party_type'] ?? '');
        $name      = trim((string)($body['name'] ?? ''));
        if ($partyType === '' || $name === '') {
            Auth::abort(400, 'Party type and name are required');
        }
        $signedOpening = $resolveOpening($body['opening_balance'] ?? 0, $body['opening_balance_type'] ?? null, $partyType);
        $activeVal     = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : 1;
        $seq           = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM parties')->fetchColumn();
        $prefix        = $partyType === 'SUPPLIER' ? 'SUP' : ($partyType === 'CUSTOMER' ? 'CUS' : 'BTH');
        $partyCode     = $prefix . '-' . str_pad((string)$seq, 3, '0', STR_PAD_LEFT);

        $pdo->prepare(
            'INSERT INTO parties (party_code, party_type, name, contact_person, phone, email, tax_id, address, credit_limit, opening_balance, current_balance, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            $partyCode,
            $partyType,
            $name,
            (string)($body['contact_person'] ?? ''),
            (string)($body['phone'] ?? ''),
            (string)($body['email'] ?? ''),
            (string)($body['tax_id'] ?? ''),
            (string)($body['address'] ?? ''),
            (float)($body['credit_limit'] ?? 0),
            $signedOpening,
            $signedOpening,
            $activeVal,
        ]);
        $id = (int)$pdo->lastInsertId();
        $st = $pdo->prepare("{$enrichedPartiesSql} WHERE pt.id = ?");
        $st->execute([$id]);
        $party = $castPartyRow($st->fetch());
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'CREATE_PARTY', 'PARTY', $partyCode, null, $party, $clientType);
        Auth::jsonResponse(['party' => $party], 201);
    }

    if (preg_match('#^/api/v1/parties/(\d+)$#', $uri, $m) && $method === 'PUT') {
        Auth::requirePermission($emp, 'parties.manage');
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM parties WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Party not found');
        }
        $partyType = (string)($body['party_type'] ?? '');
        $name      = trim((string)($body['name'] ?? ''));
        if ($partyType === '' || $name === '') {
            Auth::abort(400, 'Party type and name are required');
        }
        $nextOpening = array_key_exists('opening_balance', $body)
            ? $resolveOpening($body['opening_balance'], $body['opening_balance_type'] ?? null, $partyType)
            : (float)$existing['opening_balance'];
        $delta       = round($nextOpening - (float)$existing['opening_balance'], 2);
        $nextCurrent = round((float)$existing['current_balance'] + $delta, 2);
        $activeVal   = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : (int)$existing['is_active'];

        $pdo->prepare(
            'UPDATE parties SET party_type = ?, name = ?, contact_person = ?, phone = ?, email = ?, tax_id = ?, address = ?, credit_limit = ?, opening_balance = ?, current_balance = ?, is_active = ? WHERE id = ?'
        )->execute([
            $partyType,
            $name,
            (string)($body['contact_person'] ?? ''),
            (string)($body['phone'] ?? ''),
            (string)($body['email'] ?? ''),
            (string)($body['tax_id'] ?? ''),
            (string)($body['address'] ?? ''),
            (float)($body['credit_limit'] ?? 0),
            $nextOpening,
            $nextCurrent,
            $activeVal,
            $id,
        ]);
        $st = $pdo->prepare("{$enrichedPartiesSql} WHERE pt.id = ?");
        $st->execute([$id]);
        $updated = $castPartyRow($st->fetch());
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'UPDATE_PARTY', 'PARTY', (string)$existing['party_code'], $existing, $updated, $clientType);
        Auth::jsonResponse(['party' => $updated]);
    }

    if (preg_match('#^/api/v1/parties/(\d+)/status$#', $uri, $m) && $method === 'PATCH') {
        Auth::requirePermission($emp, 'parties.manage');
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM parties WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Party not found');
        }
        $nextActive = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : ((int)$existing['is_active'] ? 0 : 1);
        $pdo->prepare('UPDATE parties SET is_active = ? WHERE id = ?')->execute([$nextActive, $id]);
        $st = $pdo->prepare("{$enrichedPartiesSql} WHERE pt.id = ?");
        $st->execute([$id]);
        $updated = $castPartyRow($st->fetch());
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], $nextActive ? 'ACTIVATE_PARTY' : 'DEACTIVATE_PARTY', 'PARTY', (string)$existing['party_code'], ['is_active' => $existing['is_active']], ['is_active' => $nextActive], $clientType);
        Auth::jsonResponse(['party' => $updated]);
    }

    if (preg_match('#^/api/v1/parties/(\d+)$#', $uri, $m) && $method === 'DELETE') {
        Auth::requirePermission($emp, 'parties.manage');
        $id = (int)$m[1];
        $exSt = $pdo->prepare('SELECT * FROM parties WHERE id = ?');
        $exSt->execute([$id]);
        $existing = $exSt->fetch();
        if (!$existing) {
            Auth::abort(404, 'Party not found');
        }
        $refSt = $pdo->prepare(
            'SELECT
                (SELECT COUNT(*) FROM paddy_purchases WHERE supplier_id = ?)
              + (SELECT COUNT(*) FROM sales_invoices WHERE customer_id = ?)
              + (SELECT COUNT(*) FROM paddy_sales WHERE customer_id = ?)
              + (SELECT COUNT(*) FROM payments WHERE party_id = ?)'
        );
        $refSt->execute([$id, $id, $id, $id]);
        if ((int)$refSt->fetchColumn() > 0) {
            Auth::abort(409, "Cannot delete \"{$existing['name']}\" because it has historical purchases, sales, or payments. Set it Inactive instead.");
        }
        $pdo->prepare('DELETE FROM parties WHERE id = ?')->execute([$id]);
        ErpEngine::writeAudit($pdo, (int)$emp['id'], $emp['full_name'], 'DELETE_PARTY', 'PARTY', (string)$existing['party_code'], $existing, null, $clientType);
        Auth::jsonResponse(['deleted' => true, 'id' => $id]);
    }

    if (preg_match('#^/api/v1/parties/(\d+)/ledger$#', $uri, $m) && $method === 'GET') {
        Auth::rejectPhysicalOnlyUser($emp);
        $id = (int)$m[1];
        $pSt = $pdo->prepare("{$enrichedPartiesSql} WHERE pt.id = ?");
        $pSt->execute([$id]);
        $party = $pSt->fetch();
        if (!$party) {
            Auth::abort(404, 'Party not found');
        }
        $party = $castPartyRow($party);

        $purSt = $pdo->prepare(
            'SELECT pp.id, pp.purchase_no, pp.total_payable, pp.paid_amount, pp.payment_status, pp.payment_weight_kg, pp.created_at, i.name AS item_name
             FROM paddy_purchases pp JOIN items i ON i.id = pp.item_id WHERE pp.supplier_id = ? ORDER BY pp.created_at ASC, pp.id ASC'
        );
        $purSt->execute([$id]);
        $purchases = $purSt->fetchAll();

        $invSt = $pdo->prepare(
            'SELECT id, invoice_no, total_amount, paid_amount, payment_status, vehicle_no, created_at
             FROM sales_invoices WHERE customer_id = ? ORDER BY created_at ASC, id ASC'
        );
        $invSt->execute([$id]);
        $invoices = $invSt->fetchAll();

        $psSt = $pdo->prepare(
            'SELECT ps.id, ps.sale_no, ps.total_amount, ps.paid_amount, ps.payment_status, ps.qty_kg, ps.created_at, i.name AS item_name
             FROM paddy_sales ps JOIN items i ON i.id = ps.item_id WHERE ps.customer_id = ? ORDER BY ps.created_at ASC, ps.id ASC'
        );
        $psSt->execute([$id]);
        $paddySales = $psSt->fetchAll();

        $paySt = $pdo->prepare(
            'SELECT pay.*, a.name AS account_name
             FROM payments pay JOIN accounts a ON a.id = pay.account_id
             WHERE pay.party_id = ? ORDER BY pay.created_at ASC, pay.id ASC'
        );
        $paySt->execute([$id]);
        $payments = $paySt->fetchAll();

        $rawEvents = [];
        foreach ($purchases as $pp) {
            $paid = (float)$pp['paid_amount'];
            $rawEvents[] = [
                'date'             => (string)$pp['created_at'],
                'sortOrder'        => 1,
                'entry_type'       => 'PADDY_PURCHASE',
                'ref_no'           => $pp['purchase_no'],
                'description'      => sprintf('Paddy Purchase: %s (%s kg)%s', $pp['item_name'], number_format((float)$pp['payment_weight_kg']), $paid > 0 ? ' · Initial Paid ৳' . number_format($paid) : ''),
                'debit_receivable' => $paid,
                'credit_payable'   => (float)$pp['total_payable'],
            ];
        }
        foreach ($invoices as $si) {
            $paid = (float)$si['paid_amount'];
            $rawEvents[] = [
                'date'             => (string)$si['created_at'],
                'sortOrder'        => 2,
                'entry_type'       => 'SALES_INVOICE',
                'ref_no'           => $si['invoice_no'],
                'description'      => 'Rice & By-Product Sales Invoice' . (!empty($si['vehicle_no']) ? " ({$si['vehicle_no']})" : '') . ($paid > 0 ? ' · Initial Recd ৳' . number_format($paid) : ''),
                'debit_receivable' => (float)$si['total_amount'],
                'credit_payable'   => $paid,
            ];
        }
        foreach ($paddySales as $ps) {
            $rawEvents[] = [
                'date'             => (string)$ps['created_at'],
                'sortOrder'        => 3,
                'entry_type'       => 'PADDY_SALE',
                'ref_no'           => $ps['sale_no'],
                'description'      => sprintf('Direct Paddy Sale: %s (%s kg)', $ps['item_name'], number_format((float)$ps['qty_kg'])),
                'debit_receivable' => (float)$ps['total_amount'],
                'credit_payable'   => (float)$ps['paid_amount'],
            ];
        }
        foreach ($payments as $pay) {
            $isReceipt = $pay['direction'] === 'RECEIPT';
            $rawEvents[] = [
                'date'             => (string)$pay['created_at'],
                'sortOrder'        => 4,
                'entry_type'       => 'PAYMENT',
                'ref_no'           => $pay['payment_no'],
                'description'      => ($pay['voucher_type'] ?: $pay['direction']) . " via {$pay['account_name']} ({$pay['payment_mode']})"
                    . (!empty($pay['settled_ref_no']) ? " · Ref: {$pay['settled_ref_no']}" : '')
                    . (!empty($pay['notes']) ? " · {$pay['notes']}" : ''),
                'debit_receivable' => $isReceipt ? 0.0 : (float)$pay['amount'],
                'credit_payable'   => $isReceipt ? (float)$pay['amount'] : 0.0,
                'voucher_type'     => $pay['voucher_type'],
                'payment_mode'     => $pay['payment_mode'],
            ];
        }

        usort($rawEvents, static fn(array $a, array $b): int => strcmp($a['date'], $b['date']) ?: ($a['sortOrder'] <=> $b['sortOrder']));

        $running = (float)$party['opening_balance'];
        $entries = [];
        if ($running != 0.0) {
            $entries[] = [
                'date'             => 'Opening',
                'entry_type'       => 'OPENING',
                'ref_no'           => 'OPEN-BAL',
                'description'      => $running > 0 ? 'Opening Receivable / Supplier Advance' : 'Opening Payable / Customer Advance',
                'debit_receivable' => $running > 0 ? $running : 0,
                'credit_payable'   => $running < 0 ? abs($running) : 0,
                'running_balance'  => $running,
            ];
        }
        foreach ($rawEvents as $ev) {
            $running = round($running + $ev['debit_receivable'] - $ev['credit_payable'], 2);
            $row = [
                'date'             => $ev['date'],
                'entry_type'       => $ev['entry_type'],
                'ref_no'           => $ev['ref_no'],
                'description'      => $ev['description'],
                'debit_receivable' => $ev['debit_receivable'],
                'credit_payable'   => $ev['credit_payable'],
                'running_balance'  => $running,
            ];
            if (isset($ev['voucher_type'])) {
                $row['voucher_type'] = $ev['voucher_type'];
                $row['payment_mode'] = $ev['payment_mode'];
            }
            $entries[] = $row;
        }

        $openBills = [];
        foreach ($purchases as $p) {
            $due = round((float)$p['total_payable'] - (float)$p['paid_amount'], 2);
            if ($p['payment_status'] !== 'PAID' && $due > 0.01) {
                $openBills[] = [
                    'bill_type'      => 'PADDY_PURCHASE',
                    'bill_id'        => (int)$p['id'],
                    'bill_no'        => $p['purchase_no'],
                    'date'           => $p['created_at'],
                    'total_amount'   => (float)$p['total_payable'],
                    'paid_amount'    => (float)$p['paid_amount'],
                    'due_amount'     => $due,
                    'payment_status' => $p['payment_status'],
                ];
            }
        }
        foreach ($invoices as $i) {
            $due = round((float)$i['total_amount'] - (float)$i['paid_amount'], 2);
            if ($i['payment_status'] !== 'PAID' && $due > 0.01) {
                $openBills[] = [
                    'bill_type'      => 'SALES_INVOICE',
                    'bill_id'        => (int)$i['id'],
                    'bill_no'        => $i['invoice_no'],
                    'date'           => $i['created_at'],
                    'total_amount'   => (float)$i['total_amount'],
                    'paid_amount'    => (float)$i['paid_amount'],
                    'due_amount'     => $due,
                    'payment_status' => $i['payment_status'],
                ];
            }
        }
        foreach ($paddySales as $s) {
            $due = round((float)$s['total_amount'] - (float)$s['paid_amount'], 2);
            if ($s['payment_status'] !== 'PAID' && $due > 0.01) {
                $openBills[] = [
                    'bill_type'      => 'PADDY_SALE',
                    'bill_id'        => (int)$s['id'],
                    'bill_no'        => $s['sale_no'],
                    'date'           => $s['created_at'],
                    'total_amount'   => (float)$s['total_amount'],
                    'paid_amount'    => (float)$s['paid_amount'],
                    'due_amount'     => $due,
                    'payment_status' => $s['payment_status'],
                ];
            }
        }

        $curBal          = (float)$party['current_balance'];
        $pType           = $party['party_type'];
        $customerDue     = in_array($pType, ['CUSTOMER', 'BOTH'], true) && $curBal > 0 ? $curBal : 0.0;
        $customerAdvance = $pType === 'CUSTOMER' && $curBal < 0 ? abs($curBal) : 0.0;
        $supplierDue     = in_array($pType, ['SUPPLIER', 'BOTH'], true) && $curBal < 0 ? abs($curBal) : 0.0;
        $supplierAdvance = $pType === 'SUPPLIER' && $curBal > 0 ? $curBal : 0.0;

        Auth::jsonResponse([
            'party'   => $party,
            'summary' => [
                'opening_balance'   => (float)$party['opening_balance'],
                'total_purchased'   => (float)$party['total_purchased'],
                'total_sold'        => (float)$party['total_sold'],
                'total_paid_out'    => (float)$party['total_paid_out'],
                'total_received_in' => (float)$party['total_received_in'],
                'current_balance'   => $curBal,
                'customer_due'      => round($customerDue, 2),
                'customer_advance'  => round($customerAdvance, 2),
                'supplier_due'      => round($supplierDue, 2),
                'supplier_advance'  => round($supplierAdvance, 2),
            ],
            'open_bills' => $openBills,
            'entries'    => $entries,
        ]);
    }

    if ($uri === '/api/v1/inventory/lots' && $method === 'GET') {
        $lotsRaw = $pdo->query(
            "SELECT l.*,
                    COALESCE(l.origin_batch_id, CASE WHEN l.source_type = 'PRODUCTION_OUTPUT' THEN l.source_id ELSE NULL END) AS origin_batch_id,
                    pb.batch_no AS origin_batch_no,
                    pb.dryer_no AS origin_dryer_no,
                    i.name AS item_name,
                    i.sku,
                    i.category,
                    i.process_grade,
                    i.bag_weight_kg,
                    i.costing_method,
                    w.name AS warehouse_name,
                    w.code AS warehouse_code,
                    w.warehouse_type,
                    pp.bag_count AS purchase_bag_count,
                    CASE
                      WHEN COALESCE(l.weight_pending, 0) = 1 THEN l.remaining_bags
                      WHEN l.remaining_qty_kg <= 0.0001 THEN 0
                      WHEN l.remaining_bags > 0 THEN l.remaining_bags
                      WHEN l.source_type = 'PADDY_PURCHASE' AND pp.bag_count > 0 AND l.initial_qty_kg > 0
                        THEN ROUND(l.remaining_qty_kg * pp.bag_count / l.initial_qty_kg)
                      ELSE ROUND(l.remaining_qty_kg / COALESCE(NULLIF(i.bag_weight_kg, 0), 50))
                    END AS remaining_bags
             FROM inventory_lots l
             JOIN items i ON i.id = l.item_id
             JOIN warehouses w ON w.id = l.warehouse_id
             LEFT JOIN paddy_purchases pp ON l.source_type = 'PADDY_PURCHASE' AND pp.id = l.source_id
             LEFT JOIN production_batches pb ON pb.id = COALESCE(l.origin_batch_id, CASE WHEN l.source_type = 'PRODUCTION_OUTPUT' THEN l.source_id ELSE NULL END)
             ORDER BY COALESCE(l.weight_pending, 0) DESC, l.remaining_qty_kg DESC, l.received_at ASC"
        )->fetchAll();

        $lots = array_map(static function (array $l) use ($physicalOnly): array {
            $l['remaining_bags'] = (int)$l['remaining_bags'];
            if ($physicalOnly) {
                $l['unit_cost_per_kg']   = 0;
                $l['pending_cost_total'] = 0;
            }
            return $l;
        }, $lotsRaw);

        Auth::jsonResponse(['lots' => $lots]);
    }

    if ($uri === '/api/v1/inventory/ledger' && $method === 'GET') {
        $ledgerRaw = $pdo->query(
            'SELECT sl.*, l.lot_code, i.name AS item_name, w.name AS warehouse_name, e.full_name AS employee_name
             FROM stock_ledger sl
             JOIN inventory_lots l ON l.id = sl.lot_id
             JOIN items i ON i.id = sl.item_id
             JOIN warehouses w ON w.id = sl.warehouse_id
             JOIN employees e ON e.id = sl.employee_id
             ORDER BY sl.id DESC LIMIT 150'
        )->fetchAll();

        $ledger = $physicalOnly
            ? array_map(static fn(array $r): array => array_merge($r, ['unit_cost_per_kg' => 0, 'total_cost' => 0]), $ledgerRaw)
            : $ledgerRaw;

        Auth::jsonResponse(['ledger' => $ledger]);
    }

    return false;
}
