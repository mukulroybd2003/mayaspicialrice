<?php
declare(strict_types=1);

namespace SonaGrain;

use PDO;

final class SchemaBootstrap
{
    private static bool $checked = false;

    public static function ensureSchemaAndSeed(PDO $pdo): void
    {
        if (self::$checked) {
            return;
        }
        self::$checked = true;

        // Fast-path: if employees and app_meta exist and at least one employee exists, skip heavy DDL check
        try {
            $hasMeta = $pdo->query("SHOW TABLES LIKE 'app_meta'")->fetchColumn();
            $hasEmp  = $pdo->query("SHOW TABLES LIKE 'employees'")->fetchColumn();
            if ($hasMeta && $hasEmp) {
                $cnt = (int)$pdo->query('SELECT COUNT(*) FROM employees')->fetchColumn();
                if ($cnt > 0) {
                    self::ensureOptionalColumns($pdo);
                    self::ensureSystemDefaults($pdo);
                    return;
                }
            }
        } catch (\Throwable) {
            // Fall through to full bootstrap
        }

        $schemaSql = self::loadMigrationSql('001_initial_schema.sql') ?: self::fallbackSchemaSql();
        self::execSqlBatch($pdo, $schemaSql);
        self::ensureOptionalColumns($pdo);

        $empCount = (int)$pdo->query('SELECT COUNT(*) FROM employees')->fetchColumn();
        if ($empCount === 0) {
            $seedSql = self::loadMigrationSql('002_seed_master.sql');
            if ($seedSql !== null) {
                self::execSqlBatch($pdo, $seedSql);
            }
            self::seedPhpDefaultsIfEmpty($pdo);
        }

        self::ensureSystemDefaults($pdo);
    }

    private static function loadMigrationSql(string $filename): ?string
    {
        $paths = [
            dirname(__DIR__, 2) . '/database/migrations/' . $filename,
            dirname(__DIR__) . '/database/migrations/' . $filename,
        ];
        foreach ($paths as $path) {
            if (is_file($path) && is_readable($path)) {
                $content = file_get_contents($path);
                if (is_string($content) && trim($content) !== '') {
                    return $content;
                }
            }
        }
        return null;
    }

    private static function execSqlBatch(PDO $pdo, string $sql): void
    {
        $lines = preg_split('/\R/', $sql) ?: [];
        $cleanLines = [];
        foreach ($lines as $line) {
            $t = ltrim($line);
            if (str_starts_with($t, '--')) {
                continue;
            }
            $cleanLines[] = $line;
        }
        $cleanSql = implode("\n", $cleanLines);
        $statements = preg_split('/;\s*(?:\R|$)/', $cleanSql) ?: [];
        foreach ($statements as $stmt) {
            $s = trim($stmt);
            if ($s === '') {
                continue;
            }
            $pdo->exec($s);
        }
    }

    private static function ensureOptionalColumns(PDO $pdo): void
    {
        self::addColumnIfMissing($pdo, 'paddy_purchases', 'pricing_status', "VARCHAR(30) NOT NULL DEFAULT 'PRICED'");
        self::addColumnIfMissing($pdo, 'paddy_purchases', 'split_summary_json', 'LONGTEXT');
        self::addColumnIfMissing($pdo, 'production_expense_payments', 'receipt_no', 'VARCHAR(64)');
        self::addColumnIfMissing($pdo, 'inventory_lots', 'origin_batch_id', 'INT');
        self::addColumnIfMissing($pdo, 'inventory_lots', 'pack_size_kg', 'DOUBLE NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'sales_invoice_items', 'bag_count', 'INT NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'sales_invoice_items', 'pack_size_kg', 'DOUBLE NOT NULL DEFAULT 50');
        self::addColumnIfMissing($pdo, 'sales_invoice_items', 'rate_per_bag', 'DOUBLE NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'company_settings', 'logo_data_url', 'LONGTEXT');
        self::addColumnIfMissing($pdo, 'inventory_lots', 'weight_pending', 'TINYINT NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'inventory_lots', 'pending_cost_total', 'DOUBLE NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'inventory_lots', 'dispatched_qty_kg', 'DOUBLE NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'inventory_lots', 'dispatched_bags', 'INT NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'inventory_lots', 'extra_torn_bags', 'INT NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'paddy_drying_batches', 'input_bags', 'INT NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'paddy_drying_batches', 'output_bags', 'INT NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'paddy_drying_batches', 'dispatched_bags', 'INT NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'paddy_drying_batches', 'extra_torn_bags', 'INT NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'paddy_drying_batches', 'weight_pending', 'TINYINT NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'paddy_drying_batches', 'exit_settlement_unit_kg', 'DOUBLE NOT NULL DEFAULT 75.5');
        self::addColumnIfMissing($pdo, 'paddy_drying_batches', 'exit_settlement_rate', 'DOUBLE NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'paddy_drying_batches', 'exit_total_value', 'DOUBLE NOT NULL DEFAULT 0');
        self::addColumnIfMissing($pdo, 'paddy_drying_batches', 'notes', 'TEXT');
        self::addColumnIfMissing($pdo, 'paddy_sales', 'source_lot_id', 'INT');
        self::addColumnIfMissing($pdo, 'paddy_sales', 'extra_torn_bags', 'INT NOT NULL DEFAULT 0');
    }

    private static function addColumnIfMissing(PDO $pdo, string $table, string $column, string $definition): void
    {
        $stmt = $pdo->prepare(
            'SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?'
        );
        $stmt->execute([$table, $column]);
        if ((int)$stmt->fetchColumn() === 0) {
            $pdo->exec("ALTER TABLE `{$table}` ADD COLUMN `{$column}` {$definition}");
        }
    }

    private static function seedPhpDefaultsIfEmpty(PDO $pdo): void
    {
        $empCount = (int)$pdo->query('SELECT COUNT(*) FROM employees')->fetchColumn();
        if ($empCount > 0) {
            return;
        }

        $roles = [
            [1, 'OWNER', 'Mill Owner / Admin', 'Full unrestricted access including financial overrides, backups, and RBAC'],
            [2, 'MANAGER', 'Mill Manager', 'Operations across godowns, purchases, drying, milling, and sales'],
            [3, 'WEIGHBRIDGE', 'Weighbridge Operator', 'Paddy purchase weigh-ins, weight discrepancy logging, and QR tagging'],
            [4, 'PRODUCTION', 'Production Supervisor', 'Drying batches, Siddho/Atap production runs, and cost sheets'],
            [5, 'ACCOUNTANT', 'Chief Accountant', 'Cash/bank vouchers, party payments, financial reports, and audit logs'],
            [6, 'SALES', 'Sales & Dispatch Officer', 'Direct paddy sales, rice & by-product invoicing, and gate-pass QR'],
            [7, 'GODOWN_KEEPER', 'Godown Keeper (গোডাউন কিপার)', 'Physical paddy intake, bag ledger, godown stock & transfers only (no monetary access)'],
        ];
        $rStmt = $pdo->prepare('INSERT IGNORE INTO roles (id, code, name, description) VALUES (?, ?, ?, ?)');
        foreach ($roles as $r) {
            $rStmt->execute($r);
        }

        $perms = [
            ['dashboard.view', 'Dashboard', 'View executive analytics and KPIs'],
            ['paddy.purchase.create', 'Procurement', 'Record paddy purchases and weighbridge entries'],
            ['stock.transfer', 'Inventory', 'Execute inter-godown stock transfers'],
            ['paddy.sale.create', 'Sales', 'Execute direct paddy sales without milling'],
            ['drying.manage', 'Drying', 'Create and complete paddy drying cycles'],
            ['production.manage', 'Production', 'Manage Siddho & Atap milling batches and cost sheets'],
            ['rice.sale.create', 'Sales', 'Create rice and by-product sales invoices'],
            ['weighbridge.operate', 'Weighbridge', 'Operate digital/manual weighbridge scale'],
            ['qr.scan', 'Traceability', 'Scan and inspect QR lot traceability'],
            ['parties.manage', 'Parties', 'Manage suppliers and customers'],
            ['accounting.view', 'Accounting', 'View cash, bank, and trial balance ledgers'],
            ['accounting.post', 'Accounting', 'Post payments, receipts, and journal vouchers'],
            ['employees.manage', 'Admin', 'Create/update employees and role permissions'],
            ['reports.export', 'Reports', 'Export PDF and Excel reports'],
            ['audit.view', 'Security', 'View immutable audit logs'],
            ['backup.manage', 'Security', 'Create and restore database backups'],
        ];
        $pStmt  = $pdo->prepare('INSERT IGNORE INTO permissions (id, perm_key, module, description) VALUES (?, ?, ?, ?)');
        $rpStmt = $pdo->prepare('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
        foreach ($perms as $idx => $p) {
            $pid = $idx + 1;
            $pStmt->execute([$pid, $p[0], $p[1], $p[2]]);
            $rpStmt->execute([1, $pid]);
            if (!in_array($p[0], ['employees.manage', 'backup.manage'], true)) {
                $rpStmt->execute([2, $pid]);
            }
            if (in_array($p[0], ['dashboard.view', 'paddy.purchase.create', 'weighbridge.operate', 'qr.scan'], true)) {
                $rpStmt->execute([3, $pid]);
            }
            if (in_array($p[0], ['dashboard.view', 'drying.manage', 'production.manage', 'stock.transfer', 'qr.scan'], true)) {
                $rpStmt->execute([4, $pid]);
            }
            if (in_array($p[0], ['dashboard.view', 'accounting.view', 'accounting.post', 'parties.manage', 'reports.export', 'audit.view'], true)) {
                $rpStmt->execute([5, $pid]);
            }
            if (in_array($p[0], ['dashboard.view', 'paddy.sale.create', 'rice.sale.create', 'parties.manage', 'qr.scan', 'reports.export'], true)) {
                $rpStmt->execute([6, $pid]);
            }
            if (in_array($p[0], ['dashboard.view', 'paddy.purchase.create', 'stock.transfer', 'weighbridge.operate', 'qr.scan'], true)) {
                $rpStmt->execute([7, $pid]);
            }
        }

        $adminHash = password_hash('admin', PASSWORD_BCRYPT);
        $staffHash = password_hash('Mill@2026', PASSWORD_BCRYPT);
        $eStmt = $pdo->prepare('INSERT IGNORE INTO employees (id, employee_code, full_name, email, phone, password_hash, role_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
        $eStmt->execute([1, 'EMP-001', 'Admin', 'admin@gmail.com', '+880 1711-000000', $adminHash, 1]);
        $eStmt->execute([2, 'EMP-002', 'Suman Das', 'weighbridge@sonagrain.com', '+91 98300 11002', $staffHash, 3]);
        $eStmt->execute([3, 'EMP-003', 'Prakash Sen', 'production@sonagrain.com', '+91 98300 11003', $staffHash, 4]);
        $eStmt->execute([4, 'EMP-004', 'Meera Chatterjee', 'accounts@sonagrain.com', '+91 98300 11004', $staffHash, 5]);
        $eStmt->execute([5, 'EMP-005', 'Debashis Paul', 'sales@sonagrain.com', '+91 98300 11005', $staffHash, 6]);
        $eStmt->execute([6, 'EMP-006', 'রতন মণ্ডল (গোডাউন কিপার)', 'godown@sonagrain.com', '+880 1711-000606', $staffHash, 7]);
    }

    private static function ensureSystemDefaults(PDO $pdo): void
    {
        $pdo->exec('INSERT IGNORE INTO company_settings (id) VALUES (1)');
        $pdo->exec(
            'CREATE TABLE IF NOT EXISTS sms_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                entity_type VARCHAR(50) NOT NULL,
                entity_id INT NOT NULL DEFAULT 0,
                entity_code VARCHAR(80) NOT NULL DEFAULT \'\',
                party_id INT,
                party_name VARCHAR(191) NOT NULL DEFAULT \'\',
                phone VARCHAR(40) NOT NULL DEFAULT \'\',
                provider VARCHAR(40) NOT NULL DEFAULT \'NONE\',
                message_body TEXT NOT NULL,
                status VARCHAR(30) NOT NULL DEFAULT \'SKIPPED\',
                provider_response TEXT,
                created_by INT,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci'
        );
        $pdo->exec(
            "INSERT IGNORE INTO accounts (account_code, name, account_type, balance, is_system) VALUES
            ('1001', 'Cash in Hand (Mill Counter)', 'ASSET', 0, 1),
            ('1002', 'State Bank Current A/C', 'ASSET', 0, 1),
            ('1100', 'Accounts Receivable (Customers)', 'ASSET', 0, 1),
            ('1200', 'Paddy & Rice Inventory', 'ASSET', 0, 1),
            ('2001', 'Accounts Payable (Suppliers)', 'LIABILITY', 0, 1),
            ('2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0, 1),
            ('3001', 'Owner Capital Equity', 'EQUITY', 0, 1),
            ('4001', 'Rice & By-Product Sales Revenue', 'REVENUE', 0, 1),
            ('4002', 'Direct Paddy Sales Revenue', 'REVENUE', 0, 1),
            ('5001', 'Cost of Goods Sold (COGS)', 'EXPENSE', 0, 1),
            ('5100', 'Milling Power, Fuel & Labor Expense', 'EXPENSE', 0, 1),
            ('5200', 'Weight Discrepancy & Drying Variance', 'EXPENSE', 0, 1),
            ('5300', 'Transport, Freight & Loading Expense', 'EXPENSE', 0, 1),
            ('5400', 'Mill Rent, Office & Admin Expense', 'EXPENSE', 0, 1)"
        );

        $unitCnt = (int)$pdo->query('SELECT COUNT(*) FROM product_units')->fetchColumn();
        if ($unitCnt === 0) {
            $pdo->exec(
                "INSERT IGNORE INTO product_units (code, name, symbol, base_weight_kg, description, is_active) VALUES
                ('KG', 'Kilogram', 'kg', 1, 'Standard base weight unit for weighbridge and stock valuation', 1),
                ('BAG', 'Standard Mill Bag (50 kg)', 'bag', 50, 'Packed rice and bran sack equivalent to 50 kg', 1),
                ('PADBAG', 'Paddy Gunny Sack (60 kg)', 'sack', 60, 'Raw paddy farm arrival jute sack', 1),
                ('QTL', 'Quintal', 'qtl', 100, 'Wholesale grain trading unit (100 kg)', 1),
                ('MT', 'Metric Ton', 'MT', 1000, 'Bulk mill capacity & institutional dispatch unit (1,000 kg)', 1)"
            );
        }

        $catCnt = (int)$pdo->query('SELECT COUNT(*) FROM product_categories')->fetchColumn();
        if ($catCnt === 0) {
            $pdo->exec(
                "INSERT IGNORE INTO product_categories (code, name, group_type, default_costing_method, description, is_active) VALUES
                ('PADDY', 'Raw Paddy', 'RAW_MATERIAL', 'FIFO', 'Unmilled farm paddy varieties procured for drying or milling', 1),
                ('HEAD_RICE', 'Head Rice', 'FINISHED_GOOD', 'FIFO', 'Whole parboiled (Siddho) and raw (Atap) finished rice', 1),
                ('BROKEN_RICE', 'Broken Rice (Khud)', 'BY_PRODUCT', 'WEIGHTED_AVERAGE', 'Grading broken rice fractions from milling', 1),
                ('RICE_BRAN', 'Rice Bran (Kura)', 'BY_PRODUCT', 'WEIGHTED_AVERAGE', 'Polishing bran sold to solvent oil extraction mills', 1),
                ('HUSK', 'Paddy Husk (Tush)', 'BY_PRODUCT', 'WEIGHTED_AVERAGE', 'Hulling husk used for parboiling boilers and sale', 1)"
            );
        }

        // Ensure GODOWN_KEEPER role exists with exact physical permissions
        $pdo->exec(
            "INSERT IGNORE INTO roles (code, name, description) VALUES
            ('GODOWN_KEEPER', 'Godown Keeper (গোডাউন কিপার)', 'Physical paddy intake, bag ledger, godown stock & transfers only (no monetary access)')"
        );
        $gkRoleId = $pdo->query("SELECT id FROM roles WHERE code = 'GODOWN_KEEPER' LIMIT 1")->fetchColumn();
        if ($gkRoleId) {
            $gkKeys = ['dashboard.view', 'paddy.purchase.create', 'stock.transfer', 'weighbridge.operate', 'qr.scan'];
            $getPerm = $pdo->prepare('SELECT id FROM permissions WHERE perm_key = ?');
            $insRp   = $pdo->prepare('INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
            foreach ($gkKeys as $k) {
                $getPerm->execute([$k]);
                $pid = $getPerm->fetchColumn();
                if ($pid) {
                    $insRp->execute([(int)$gkRoleId, (int)$pid]);
                }
            }
        }
    }

    private static function fallbackSchemaSql(): string
    {
        return <<<'SQL'
SET FOREIGN_KEY_CHECKS = 0;
CREATE TABLE IF NOT EXISTS roles (id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(64) NOT NULL UNIQUE, name VARCHAR(150) NOT NULL, description TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS permissions (id INT AUTO_INCREMENT PRIMARY KEY, perm_key VARCHAR(100) NOT NULL UNIQUE, module VARCHAR(80) NOT NULL, description TEXT) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS role_permissions (role_id INT NOT NULL, permission_id INT NOT NULL, PRIMARY KEY (role_id, permission_id), FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE, FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS employees (id INT AUTO_INCREMENT PRIMARY KEY, employee_code VARCHAR(50) NOT NULL UNIQUE, full_name VARCHAR(150) NOT NULL, email VARCHAR(191) NOT NULL UNIQUE, phone VARCHAR(50), password_hash VARCHAR(255) NOT NULL, role_id INT NOT NULL, is_active TINYINT NOT NULL DEFAULT 1, last_login_at VARCHAR(40), created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (role_id) REFERENCES roles(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS warehouses (id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(50) NOT NULL UNIQUE, name VARCHAR(150) NOT NULL, warehouse_type VARCHAR(60) NOT NULL, location VARCHAR(255), capacity_kg DOUBLE NOT NULL DEFAULT 0, manager_employee_id INT, is_active TINYINT NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (manager_employee_id) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS parties (id INT AUTO_INCREMENT PRIMARY KEY, party_code VARCHAR(50) NOT NULL UNIQUE, party_type VARCHAR(40) NOT NULL, name VARCHAR(191) NOT NULL, contact_person VARCHAR(150), phone VARCHAR(50), email VARCHAR(191), tax_id VARCHAR(80), address TEXT, credit_limit DOUBLE NOT NULL DEFAULT 0, opening_balance DOUBLE NOT NULL DEFAULT 0, current_balance DOUBLE NOT NULL DEFAULT 0, is_active TINYINT NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS product_units (id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(50) NOT NULL UNIQUE, name VARCHAR(150) NOT NULL, symbol VARCHAR(40) NOT NULL, base_weight_kg DOUBLE NOT NULL DEFAULT 1, description TEXT, is_active TINYINT NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS product_categories (id INT AUTO_INCREMENT PRIMARY KEY, code VARCHAR(60) NOT NULL UNIQUE, name VARCHAR(150) NOT NULL, group_type VARCHAR(60) NOT NULL DEFAULT 'FINISHED_GOOD', default_costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO', description TEXT, is_active TINYINT NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS items (id INT AUTO_INCREMENT PRIMARY KEY, sku VARCHAR(60) NOT NULL UNIQUE, name VARCHAR(191) NOT NULL, category VARCHAR(60) NOT NULL, process_grade VARCHAR(60) NOT NULL, unit VARCHAR(40) NOT NULL DEFAULT 'KG', bag_weight_kg DOUBLE NOT NULL DEFAULT 50, costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO', default_rate DOUBLE NOT NULL DEFAULT 0, is_active TINYINT NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS accounts (id INT AUTO_INCREMENT PRIMARY KEY, account_code VARCHAR(50) NOT NULL UNIQUE, name VARCHAR(191) NOT NULL, account_type VARCHAR(40) NOT NULL, balance DOUBLE NOT NULL DEFAULT 0, is_system TINYINT NOT NULL DEFAULT 1) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS inventory_lots (id INT AUTO_INCREMENT PRIMARY KEY, lot_code VARCHAR(64) NOT NULL UNIQUE, qr_code_uid VARCHAR(64) NOT NULL UNIQUE, item_id INT NOT NULL, warehouse_id INT NOT NULL, source_type VARCHAR(60) NOT NULL, source_id INT, origin_batch_id INT, initial_qty_kg DOUBLE NOT NULL, remaining_qty_kg DOUBLE NOT NULL, initial_bags INT NOT NULL DEFAULT 0, remaining_bags INT NOT NULL DEFAULT 0, pack_size_kg DOUBLE NOT NULL DEFAULT 0, unit_cost_per_kg DOUBLE NOT NULL, moisture_pct DOUBLE, received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, version INT NOT NULL DEFAULT 1, FOREIGN KEY (item_id) REFERENCES items(id), FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_ledger (id BIGINT AUTO_INCREMENT PRIMARY KEY, lot_id INT NOT NULL, item_id INT NOT NULL, warehouse_id INT NOT NULL, movement_type VARCHAR(60) NOT NULL, reference_type VARCHAR(60) NOT NULL, reference_id INT NOT NULL, qty_change_kg DOUBLE NOT NULL, unit_cost_per_kg DOUBLE NOT NULL, total_cost DOUBLE NOT NULL, balance_after_kg DOUBLE NOT NULL, employee_id INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (lot_id) REFERENCES inventory_lots(id), FOREIGN KEY (item_id) REFERENCES items(id), FOREIGN KEY (warehouse_id) REFERENCES warehouses(id), FOREIGN KEY (employee_id) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS paddy_purchases (id INT AUTO_INCREMENT PRIMARY KEY, client_uuid VARCHAR(64) NOT NULL UNIQUE, purchase_no VARCHAR(64) NOT NULL UNIQUE, supplier_id INT NOT NULL, warehouse_id INT NOT NULL, item_id INT NOT NULL, vehicle_no VARCHAR(80), challan_no VARCHAR(80), bag_count INT NOT NULL DEFAULT 0, jute_bag_count INT NOT NULL DEFAULT 0, plastic_bag_count INT NOT NULL DEFAULT 0, moisture_pct DOUBLE NOT NULL DEFAULT 14, supplier_claimed_weight_kg DOUBLE NOT NULL, scale_weight_kg DOUBLE NOT NULL, received_weight_kg DOUBLE NOT NULL, payment_weight_kg DOUBLE NOT NULL, weight_loss_kg DOUBLE NOT NULL DEFAULT 0, settlement_unit_kg DOUBLE NOT NULL DEFAULT 75.5, settlement_rate DOUBLE NOT NULL DEFAULT 0, weight_discrepancy_kg DOUBLE NOT NULL, discrepancy_flagged TINYINT NOT NULL DEFAULT 0, discrepancy_notes TEXT, rate_per_kg DOUBLE NOT NULL, total_payable DOUBLE NOT NULL, paid_amount DOUBLE NOT NULL DEFAULT 0, returned_qty_kg DOUBLE NOT NULL DEFAULT 0, returned_amount DOUBLE NOT NULL DEFAULT 0, payment_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID', pricing_status VARCHAR(30) NOT NULL DEFAULT 'PRICED', split_summary_json LONGTEXT, qr_code_uid VARCHAR(64) NOT NULL UNIQUE, weighbridge_mode VARCHAR(40) NOT NULL DEFAULT 'MANUAL', created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (supplier_id) REFERENCES parties(id), FOREIGN KEY (warehouse_id) REFERENCES warehouses(id), FOREIGN KEY (item_id) REFERENCES items(id), FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS paddy_purchase_returns (id INT AUTO_INCREMENT PRIMARY KEY, client_uuid VARCHAR(64) NOT NULL UNIQUE, return_no VARCHAR(64) NOT NULL UNIQUE, purchase_id INT NOT NULL, supplier_id INT NOT NULL, item_id INT NOT NULL, return_qty_kg DOUBLE NOT NULL, return_bags INT NOT NULL DEFAULT 0, return_jute_bags INT NOT NULL DEFAULT 0, return_plastic_bags INT NOT NULL DEFAULT 0, return_amount DOUBLE NOT NULL, refund_mode VARCHAR(40) NOT NULL DEFAULT 'ADJUST_PAYABLE', account_id INT, reason TEXT, created_by INT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (purchase_id) REFERENCES paddy_purchases(id), FOREIGN KEY (supplier_id) REFERENCES parties(id), FOREIGN KEY (item_id) REFERENCES items(id), FOREIGN KEY (account_id) REFERENCES accounts(id), FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS stock_transfers (id INT AUTO_INCREMENT PRIMARY KEY, client_uuid VARCHAR(64) NOT NULL UNIQUE, transfer_no VARCHAR(64) NOT NULL UNIQUE, from_warehouse_id INT NOT NULL, to_warehouse_id INT NOT NULL, item_id INT NOT NULL, qty_kg DOUBLE NOT NULL, bag_count INT NOT NULL DEFAULT 0, unit_divisor DOUBLE NOT NULL DEFAULT 75.5, net_units DOUBLE NOT NULL DEFAULT 0, bag_unit_rate DOUBLE NOT NULL DEFAULT 0, costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO', total_cost DOUBLE NOT NULL, vehicle_or_driver VARCHAR(150), notes TEXT, qr_code_uid VARCHAR(64) NOT NULL UNIQUE, created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id), FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id), FOREIGN KEY (item_id) REFERENCES items(id), FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS paddy_sales (id INT AUTO_INCREMENT PRIMARY KEY, client_uuid VARCHAR(64) NOT NULL UNIQUE, sale_no VARCHAR(64) NOT NULL UNIQUE, customer_id INT NOT NULL, warehouse_id INT NOT NULL, item_id INT NOT NULL, qty_kg DOUBLE NOT NULL, rate_per_kg DOUBLE NOT NULL, total_amount DOUBLE NOT NULL, costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO', cogs_amount DOUBLE NOT NULL, paid_amount DOUBLE NOT NULL DEFAULT 0, payment_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID', vehicle_no VARCHAR(80), challan_no VARCHAR(80), bag_count INT NOT NULL DEFAULT 0, jute_bag_count INT NOT NULL DEFAULT 0, plastic_bag_count INT NOT NULL DEFAULT 0, moisture_pct DOUBLE NOT NULL DEFAULT 14, scale_weight_kg DOUBLE NOT NULL DEFAULT 0, payment_weight_kg DOUBLE NOT NULL DEFAULT 0, weight_loss_kg DOUBLE NOT NULL DEFAULT 0, settlement_unit_kg DOUBLE NOT NULL DEFAULT 75.5, settlement_rate DOUBLE NOT NULL DEFAULT 0, notes TEXT, qr_code_uid VARCHAR(64) NOT NULL UNIQUE, created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (customer_id) REFERENCES parties(id), FOREIGN KEY (warehouse_id) REFERENCES warehouses(id), FOREIGN KEY (item_id) REFERENCES items(id), FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS paddy_drying_batches (id INT AUTO_INCREMENT PRIMARY KEY, client_uuid VARCHAR(64) NOT NULL UNIQUE, drying_no VARCHAR(64) NOT NULL UNIQUE, source_warehouse_id INT NOT NULL, dest_warehouse_id INT NOT NULL, item_id INT NOT NULL, drying_method VARCHAR(60) NOT NULL, input_qty_kg DOUBLE NOT NULL, initial_moisture_pct DOUBLE NOT NULL, final_moisture_pct DOUBLE NOT NULL, output_qty_kg DOUBLE NOT NULL, moisture_loss_kg DOUBLE NOT NULL, fuel_power_cost DOUBLE NOT NULL DEFAULT 0, labor_cost DOUBLE NOT NULL DEFAULT 0, input_paddy_cost DOUBLE NOT NULL, output_unit_cost_per_kg DOUBLE NOT NULL, status VARCHAR(40) NOT NULL DEFAULT 'COMPLETED', qr_code_uid VARCHAR(64) NOT NULL UNIQUE, created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id), FOREIGN KEY (dest_warehouse_id) REFERENCES warehouses(id), FOREIGN KEY (item_id) REFERENCES items(id), FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS production_batches (id INT AUTO_INCREMENT PRIMARY KEY, client_uuid VARCHAR(64) NOT NULL UNIQUE, batch_no VARCHAR(64) NOT NULL UNIQUE, process_type VARCHAR(60) NOT NULL, source_warehouse_id INT NOT NULL, paddy_item_id INT NOT NULL, input_paddy_qty_kg DOUBLE NOT NULL, input_bag_count INT NOT NULL DEFAULT 0, dryer_no VARCHAR(80) NOT NULL DEFAULT '', dryer_count DOUBLE NOT NULL DEFAULT 1, unit_divisor DOUBLE NOT NULL DEFAULT 75.5, paddy_net_units DOUBLE NOT NULL DEFAULT 0, paddy_bag_unit_rate DOUBLE NOT NULL DEFAULT 0, paddy_formula_cost DOUBLE NOT NULL DEFAULT 0, costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO', soaking_hours DOUBLE NOT NULL DEFAULT 0, steaming_temp_c DOUBLE NOT NULL DEFAULT 0, head_rice_qty_kg DOUBLE NOT NULL DEFAULT 0, broken_rice_qty_kg DOUBLE NOT NULL DEFAULT 0, bran_qty_kg DOUBLE NOT NULL DEFAULT 0, husk_qty_kg DOUBLE NOT NULL DEFAULT 0, wastage_qty_kg DOUBLE NOT NULL DEFAULT 0, head_rice_yield_pct DOUBLE NOT NULL DEFAULT 0, total_recovery_pct DOUBLE NOT NULL DEFAULT 0, status VARCHAR(40) NOT NULL DEFAULT 'COMPLETED', qr_code_uid VARCHAR(64) NOT NULL UNIQUE, notes TEXT, created_by INT NOT NULL, started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at DATETIME, FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id), FOREIGN KEY (paddy_item_id) REFERENCES items(id), FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS production_outputs (id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL, item_id INT NOT NULL, warehouse_id INT NOT NULL, output_type VARCHAR(60) NOT NULL, pack_size_kg DOUBLE NOT NULL DEFAULT 0, bag_count INT NOT NULL DEFAULT 0, rate_per_bag DOUBLE NOT NULL DEFAULT 0, qty_kg DOUBLE NOT NULL, allocated_unit_cost_per_kg DOUBLE NOT NULL, total_value DOUBLE NOT NULL, lot_id INT, FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE, FOREIGN KEY (item_id) REFERENCES items(id), FOREIGN KEY (warehouse_id) REFERENCES warehouses(id), FOREIGN KEY (lot_id) REFERENCES inventory_lots(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS production_cost_sheets (id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL UNIQUE, raw_paddy_cost DOUBLE NOT NULL, labor_cost DOUBLE NOT NULL DEFAULT 0, electricity_cost DOUBLE NOT NULL DEFAULT 0, fuel_boiler_cost DOUBLE NOT NULL DEFAULT 0, machinery_overhead_cost DOUBLE NOT NULL DEFAULT 0, packaging_cost DOUBLE NOT NULL DEFAULT 0, gross_batch_cost DOUBLE NOT NULL, byproduct_credit_value DOUBLE NOT NULL DEFAULT 0, net_head_rice_cost DOUBLE NOT NULL, cost_per_kg_head_rice DOUBLE NOT NULL, cost_per_bag_head_rice DOUBLE NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS production_batch_inputs (id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL, source_warehouse_id INT NOT NULL, paddy_item_id INT NOT NULL, bag_count INT NOT NULL DEFAULT 0, qty_kg DOUBLE NOT NULL, unit_divisor DOUBLE NOT NULL DEFAULT 75.5, net_units DOUBLE NOT NULL DEFAULT 0, bag_unit_rate DOUBLE NOT NULL DEFAULT 0, paddy_cost DOUBLE NOT NULL DEFAULT 0, notes TEXT, created_by INT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE, FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id), FOREIGN KEY (paddy_item_id) REFERENCES items(id), FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS production_batch_expenses (id INT AUTO_INCREMENT PRIMARY KEY, batch_id INT NOT NULL, expense_category VARCHAR(60) NOT NULL DEFAULT 'GENERAL', vendor_name VARCHAR(191) DEFAULT '', labor_cost DOUBLE NOT NULL DEFAULT 0, electricity_cost DOUBLE NOT NULL DEFAULT 0, fuel_boiler_cost DOUBLE NOT NULL DEFAULT 0, machinery_overhead_cost DOUBLE NOT NULL DEFAULT 0, packaging_cost DOUBLE NOT NULL DEFAULT 0, total_amount DOUBLE NOT NULL DEFAULT 0, payment_status VARCHAR(30) NOT NULL DEFAULT 'PAID', paid_amount DOUBLE NOT NULL DEFAULT 0, account_id INT, paid_at DATETIME, notes TEXT, created_by INT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE, FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS production_expense_payments (id INT AUTO_INCREMENT PRIMARY KEY, expense_id INT NOT NULL, batch_id INT NOT NULL, account_id INT NOT NULL, amount DOUBLE NOT NULL, payment_mode VARCHAR(40) NOT NULL DEFAULT 'CASH', reference_no VARCHAR(100), receipt_no VARCHAR(64), notes TEXT, paid_by INT, paid_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (expense_id) REFERENCES production_batch_expenses(id) ON DELETE CASCADE, FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE, FOREIGN KEY (account_id) REFERENCES accounts(id), FOREIGN KEY (paid_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS sales_invoices (id INT AUTO_INCREMENT PRIMARY KEY, client_uuid VARCHAR(64) NOT NULL UNIQUE, invoice_no VARCHAR(64) NOT NULL UNIQUE, customer_id INT NOT NULL, subtotal_amount DOUBLE NOT NULL, tax_amount DOUBLE NOT NULL DEFAULT 0, discount_amount DOUBLE NOT NULL DEFAULT 0, total_amount DOUBLE NOT NULL, total_cogs DOUBLE NOT NULL, paid_amount DOUBLE NOT NULL DEFAULT 0, payment_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID', vehicle_no VARCHAR(80), qr_code_uid VARCHAR(64) NOT NULL UNIQUE, created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (customer_id) REFERENCES parties(id), FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS sales_invoice_items (id INT AUTO_INCREMENT PRIMARY KEY, invoice_id INT NOT NULL, item_id INT NOT NULL, warehouse_id INT NOT NULL, qty_kg DOUBLE NOT NULL, bag_count INT NOT NULL DEFAULT 0, pack_size_kg DOUBLE NOT NULL DEFAULT 50, rate_per_bag DOUBLE NOT NULL DEFAULT 0, rate_per_kg DOUBLE NOT NULL, line_total DOUBLE NOT NULL, costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO', line_cogs DOUBLE NOT NULL, FOREIGN KEY (invoice_id) REFERENCES sales_invoices(id) ON DELETE CASCADE, FOREIGN KEY (item_id) REFERENCES items(id), FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS sales_invoice_lot_allocations (id INT AUTO_INCREMENT PRIMARY KEY, invoice_id INT NOT NULL, invoice_item_id INT, lot_id INT NOT NULL, batch_id INT, item_id INT NOT NULL, qty_kg DOUBLE NOT NULL, bag_count INT NOT NULL DEFAULT 0, cost_per_kg DOUBLE NOT NULL, cost_amount DOUBLE NOT NULL, sale_rate_per_kg DOUBLE NOT NULL, sale_amount DOUBLE NOT NULL, profit_amount DOUBLE NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (invoice_id) REFERENCES sales_invoices(id) ON DELETE CASCADE, FOREIGN KEY (lot_id) REFERENCES inventory_lots(id), FOREIGN KEY (batch_id) REFERENCES production_batches(id), FOREIGN KEY (item_id) REFERENCES items(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS weighbridge_logs (id INT AUTO_INCREMENT PRIMARY KEY, client_uuid VARCHAR(64) NOT NULL UNIQUE, ticket_no VARCHAR(64) NOT NULL UNIQUE, vehicle_no VARCHAR(80) NOT NULL, driver_name VARCHAR(150), gross_weight_kg DOUBLE NOT NULL, tare_weight_kg DOUBLE NOT NULL, net_weight_kg DOUBLE NOT NULL, device_mode VARCHAR(40) NOT NULL, raw_device_string TEXT, linked_type VARCHAR(60), linked_id INT, operator_id INT NOT NULL, captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (operator_id) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS qr_tags (qr_code_uid VARCHAR(64) PRIMARY KEY, entity_type VARCHAR(60) NOT NULL, entity_id INT NOT NULL, entity_code VARCHAR(80) NOT NULL, payload_json LONGTEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS journal_entries (id INT AUTO_INCREMENT PRIMARY KEY, client_uuid VARCHAR(64) NOT NULL UNIQUE, voucher_no VARCHAR(64) NOT NULL UNIQUE, entry_date VARCHAR(20) NOT NULL, description TEXT NOT NULL, reference_type VARCHAR(60), reference_id INT, is_posted TINYINT NOT NULL DEFAULT 1, created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS journal_lines (id INT AUTO_INCREMENT PRIMARY KEY, journal_entry_id INT NOT NULL, account_id INT NOT NULL, debit DOUBLE NOT NULL DEFAULT 0, credit DOUBLE NOT NULL DEFAULT 0, party_id INT, FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE, FOREIGN KEY (account_id) REFERENCES accounts(id), FOREIGN KEY (party_id) REFERENCES parties(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS payments (id INT AUTO_INCREMENT PRIMARY KEY, client_uuid VARCHAR(64) NOT NULL UNIQUE, payment_no VARCHAR(64) NOT NULL UNIQUE, direction VARCHAR(30) NOT NULL, voucher_type VARCHAR(50) NOT NULL DEFAULT 'DUE_SETTLEMENT', party_id INT NOT NULL, account_id INT NOT NULL, amount DOUBLE NOT NULL, payment_mode VARCHAR(40) NOT NULL, reference_no VARCHAR(100), settled_ref_no VARCHAR(150), notes TEXT, created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (party_id) REFERENCES parties(id), FOREIGN KEY (account_id) REFERENCES accounts(id), FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS sync_logs (id INT AUTO_INCREMENT PRIMARY KEY, client_uuid VARCHAR(64) NOT NULL UNIQUE, device_id VARCHAR(80) NOT NULL, client_type VARCHAR(40) NOT NULL, endpoint VARCHAR(191) NOT NULL, status VARCHAR(40) NOT NULL, conflict_reason TEXT, response_json LONGTEXT, employee_id INT NOT NULL, synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (employee_id) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS audit_logs (id BIGINT AUTO_INCREMENT PRIMARY KEY, employee_id INT, employee_name VARCHAR(150) NOT NULL, action VARCHAR(80) NOT NULL, entity_type VARCHAR(60) NOT NULL, entity_id VARCHAR(100) NOT NULL, before_json LONGTEXT, after_json LONGTEXT, ip_address VARCHAR(80), device_type VARCHAR(40), created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS backup_history (id INT AUTO_INCREMENT PRIMARY KEY, backup_name VARCHAR(191) NOT NULL, file_size_bytes BIGINT NOT NULL, created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS company_settings (id INT PRIMARY KEY, company_name_en VARCHAR(191) NOT NULL DEFAULT 'Maya Special Rice', company_name_bn VARCHAR(191) NOT NULL DEFAULT 'মায়া স্পেশাল রাইস', short_code VARCHAR(16) NOT NULL DEFAULT 'MS', tagline_en VARCHAR(255) NOT NULL DEFAULT 'Automated Parboiled & Raw Rice Mill · Weighbridge, Milling & Wholesale Trade', tagline_bn VARCHAR(255) NOT NULL DEFAULT 'অটোমেটিক সিদ্ধ ও আতপ রাইস মিল · ডিজিটাল ওয়েব্রিজ, প্রসেসিং ও চাল বিপণন', address_en VARCHAR(255) NOT NULL DEFAULT 'Plot 14, BSCIC Industrial Estate, Bogura-5800, Bangladesh', address_bn VARCHAR(255) NOT NULL DEFAULT 'প্লট ১৪, বিসিক শিল্প নগরী, বগুড়া-৫৮০০, বাংলাদেশ', phone VARCHAR(60) NOT NULL DEFAULT '+880 1711-000000', email VARCHAR(191) NOT NULL DEFAULT 'admin@gmail.com', tax_id VARCHAR(100) NOT NULL DEFAULT 'BIN: 001234567-0101', logo_data_url LONGTEXT, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS supplier_bag_ledger (id INT AUTO_INCREMENT PRIMARY KEY, client_uuid VARCHAR(64) NOT NULL UNIQUE, entry_no VARCHAR(64) NOT NULL UNIQUE, supplier_id INT NOT NULL, entry_type VARCHAR(50) NOT NULL, direction VARCHAR(40) NOT NULL, jute_qty INT NOT NULL DEFAULT 0, plastic_qty INT NOT NULL DEFAULT 0, total_qty INT NOT NULL DEFAULT 0, reference_type VARCHAR(50), reference_id INT, reference_no VARCHAR(80), entry_date VARCHAR(20) NOT NULL DEFAULT '', notes TEXT, created_by INT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (supplier_id) REFERENCES parties(id), FOREIGN KEY (created_by) REFERENCES employees(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS app_meta (meta_key VARCHAR(100) PRIMARY KEY, meta_value TEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS sms_logs (id INT AUTO_INCREMENT PRIMARY KEY, entity_type VARCHAR(50) NOT NULL, entity_id INT NOT NULL DEFAULT 0, entity_code VARCHAR(80) NOT NULL DEFAULT '', party_id INT, party_name VARCHAR(191) NOT NULL DEFAULT '', phone VARCHAR(40) NOT NULL DEFAULT '', provider VARCHAR(40) NOT NULL DEFAULT 'NONE', message_body TEXT NOT NULL, status VARCHAR(30) NOT NULL DEFAULT 'SKIPPED', provider_response TEXT, created_by INT, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SET FOREIGN_KEY_CHECKS = 1;
SQL;
    }
}
