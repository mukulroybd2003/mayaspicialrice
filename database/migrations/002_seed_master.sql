-- SonaGrain / Maya Special Rice ERP - Master Seed Data (Roles, Permissions, Accounts, Units, Categories, Company)
-- Idempotent seed script for MySQL 8.0+ / MariaDB 10.6+

INSERT IGNORE INTO roles (id, code, name, description) VALUES
  (1, 'OWNER', 'Mill Owner / Admin', 'Full unrestricted access including financial overrides, backups, and RBAC'),
  (2, 'MANAGER', 'Mill Manager', 'Operations across godowns, purchases, drying, milling, and sales'),
  (3, 'WEIGHBRIDGE', 'Weighbridge Operator', 'Paddy purchase weigh-ins, weight discrepancy logging, and QR tagging'),
  (4, 'PRODUCTION', 'Production Supervisor', 'Drying batches, Siddho/Atap production runs, and cost sheets'),
  (5, 'ACCOUNTANT', 'Chief Accountant', 'Cash/bank vouchers, party payments, financial reports, and audit logs'),
  (6, 'SALES', 'Sales & Dispatch Officer', 'Direct paddy sales, rice & by-product invoicing, and gate-pass QR'),
  (7, 'GODOWN_KEEPER', 'Godown Keeper (গোডাউন কিপার)', 'Physical paddy intake, bag ledger, godown stock & transfers only (no monetary access)');

INSERT IGNORE INTO permissions (id, perm_key, module, description) VALUES
  (1, 'dashboard.view', 'Dashboard', 'View executive analytics and KPIs'),
  (2, 'paddy.purchase.create', 'Procurement', 'Record paddy purchases and weighbridge entries'),
  (3, 'stock.transfer', 'Inventory', 'Execute inter-godown stock transfers'),
  (4, 'paddy.sale.create', 'Sales', 'Execute direct paddy sales without milling'),
  (5, 'drying.manage', 'Drying', 'Create and complete paddy drying cycles'),
  (6, 'production.manage', 'Production', 'Manage Siddho & Atap milling batches and cost sheets'),
  (7, 'rice.sale.create', 'Sales', 'Create rice and by-product sales invoices'),
  (8, 'weighbridge.operate', 'Weighbridge', 'Operate digital/manual weighbridge scale'),
  (9, 'qr.scan', 'Traceability', 'Scan and inspect QR lot traceability'),
  (10, 'parties.manage', 'Parties', 'Manage suppliers and customers'),
  (11, 'accounting.view', 'Accounting', 'View cash, bank, and trial balance ledgers'),
  (12, 'accounting.post', 'Accounting', 'Post payments, receipts, and journal vouchers'),
  (13, 'employees.manage', 'Admin', 'Create/update employees and role permissions'),
  (14, 'reports.export', 'Reports', 'Export PDF and Excel reports'),
  (15, 'audit.view', 'Security', 'View immutable audit logs'),
  (16, 'backup.manage', 'Security', 'Create and restore database backups');

-- Role 1: OWNER (all 16 permissions)
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT 1, id FROM permissions;

-- Role 2: MANAGER (all except employees.manage, backup.manage)
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT 2, id FROM permissions WHERE perm_key NOT IN ('employees.manage', 'backup.manage');

-- Role 3: WEIGHBRIDGE
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT 3, id FROM permissions WHERE perm_key IN ('dashboard.view', 'paddy.purchase.create', 'weighbridge.operate', 'qr.scan');

-- Role 4: PRODUCTION
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT 4, id FROM permissions WHERE perm_key IN ('dashboard.view', 'drying.manage', 'production.manage', 'stock.transfer', 'qr.scan');

-- Role 5: ACCOUNTANT
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT 5, id FROM permissions WHERE perm_key IN ('dashboard.view', 'accounting.view', 'accounting.post', 'parties.manage', 'reports.export', 'audit.view');

-- Role 6: SALES
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT 6, id FROM permissions WHERE perm_key IN ('dashboard.view', 'paddy.sale.create', 'rice.sale.create', 'parties.manage', 'qr.scan', 'reports.export');

-- Role 7: GODOWN_KEEPER
INSERT IGNORE INTO role_permissions (role_id, permission_id)
SELECT 7, id FROM permissions WHERE perm_key IN ('dashboard.view', 'paddy.purchase.create', 'stock.transfer', 'weighbridge.operate', 'qr.scan');

-- Default Employees:
-- Admin: admin@gmail.com / password: "admin"
-- Staff: "Mill@2026"
INSERT IGNORE INTO employees (id, employee_code, full_name, email, phone, password_hash, role_id) VALUES
  (1, 'EMP-001', 'Admin', 'admin@gmail.com', '+880 1711-000000', '$2y$10$8Wa/adlOYv/W87djkje3KuwV2sQYmp0WC9y/940ilz50uR8qBxpG.', 1),
  (2, 'EMP-002', 'Suman Das', 'weighbridge@sonagrain.com', '+91 98300 11002', '$2y$10$M0aMriziKhxjDs2fnO8.7.X/ZrKGCQDtQGQ2PyowPsxHbgsQTRoky', 3),
  (3, 'EMP-003', 'Prakash Sen', 'production@sonagrain.com', '+91 98300 11003', '$2y$10$M0aMriziKhxjDs2fnO8.7.X/ZrKGCQDtQGQ2PyowPsxHbgsQTRoky', 4),
  (4, 'EMP-004', 'Meera Chatterjee', 'accounts@sonagrain.com', '+91 98300 11004', '$2y$10$M0aMriziKhxjDs2fnO8.7.X/ZrKGCQDtQGQ2PyowPsxHbgsQTRoky', 5),
  (5, 'EMP-005', 'Debashis Paul', 'sales@sonagrain.com', '+91 98300 11005', '$2y$10$M0aMriziKhxjDs2fnO8.7.X/ZrKGCQDtQGQ2PyowPsxHbgsQTRoky', 6),
  (6, 'EMP-006', 'রতন মণ্ডল (গোডাউন কিপার)', 'godown@sonagrain.com', '+880 1711-000606', '$2y$10$M0aMriziKhxjDs2fnO8.7.X/ZrKGCQDtQGQ2PyowPsxHbgsQTRoky', 7);

INSERT IGNORE INTO product_units (id, code, name, symbol, base_weight_kg, description, is_active) VALUES
  (1, 'KG', 'Kilogram', 'kg', 1.0000, 'Standard base weight unit for weighbridge and stock valuation', 1),
  (2, 'BAG', 'Standard Mill Bag (50 kg)', 'bag', 50.0000, 'Packed rice and bran sack equivalent to 50 kg', 1),
  (3, 'PADBAG', 'Paddy Gunny Sack (60 kg)', 'sack', 60.0000, 'Raw paddy farm arrival jute sack', 1),
  (4, 'QTL', 'Quintal', 'qtl', 100.0000, 'Wholesale grain trading unit (100 kg)', 1),
  (5, 'MT', 'Metric Ton', 'MT', 1000.0000, 'Bulk mill capacity & institutional dispatch unit (1,000 kg)', 1);

INSERT IGNORE INTO product_categories (id, code, name, group_type, default_costing_method, description, is_active) VALUES
  (1, 'PADDY', 'Raw Paddy', 'RAW_MATERIAL', 'FIFO', 'Unmilled farm paddy varieties procured for drying or milling', 1),
  (2, 'HEAD_RICE', 'Head Rice', 'FINISHED_GOOD', 'FIFO', 'Whole parboiled (Siddho) and raw (Atap) finished rice', 1),
  (3, 'BROKEN_RICE', 'Broken Rice (Khud)', 'BY_PRODUCT', 'WEIGHTED_AVERAGE', 'Grading broken rice fractions from milling', 1),
  (4, 'RICE_BRAN', 'Rice Bran (Kura)', 'BY_PRODUCT', 'WEIGHTED_AVERAGE', 'Polishing bran sold to solvent oil extraction mills', 1),
  (5, 'HUSK', 'Paddy Husk (Tush)', 'BY_PRODUCT', 'WEIGHTED_AVERAGE', 'Hulling husk used for parboiling boilers and sale', 1);

INSERT IGNORE INTO accounts (id, account_code, name, account_type, balance, is_system) VALUES
  (1, '1001', 'Cash in Hand (Mill Counter)', 'ASSET', 0.00, 1),
  (2, '1002', 'State Bank Current A/C', 'ASSET', 0.00, 1),
  (3, '1100', 'Accounts Receivable (Customers)', 'ASSET', 0.00, 1),
  (4, '1200', 'Paddy & Rice Inventory', 'ASSET', 0.00, 1),
  (5, '2001', 'Accounts Payable (Suppliers)', 'LIABILITY', 0.00, 1),
  (6, '3001', 'Owner Capital Equity', 'EQUITY', 0.00, 1),
  (7, '4001', 'Rice & By-Product Sales Revenue', 'REVENUE', 0.00, 1),
  (8, '4002', 'Direct Paddy Sales Revenue', 'REVENUE', 0.00, 1),
  (9, '5001', 'Cost of Goods Sold (COGS)', 'EXPENSE', 0.00, 1),
  (10, '5100', 'Milling Power, Fuel & Labor Expense', 'EXPENSE', 0.00, 1),
  (11, '5200', 'Weight Discrepancy & Drying Variance', 'EXPENSE', 0.00, 1),
  (12, '5300', 'Transport, Freight & Loading Expense', 'EXPENSE', 0.00, 1),
  (13, '5400', 'Mill Rent, Office & Admin Expense', 'EXPENSE', 0.00, 1),
  (14, '2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0.00, 1);

INSERT IGNORE INTO company_settings (id) VALUES (1);
