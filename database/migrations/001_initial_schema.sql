-- SonaGrain / Maya Special Rice ERP - Complete 37-Table MySQL 8.0+ / MariaDB 10.6+ Schema
-- Shared-hosting & cPanel friendly: select your target database before importing (no forced CREATE DATABASE / USE).

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS roles (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  description TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  perm_key VARCHAR(100) NOT NULL UNIQUE,
  module VARCHAR(80) NOT NULL,
  description TEXT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id INT NOT NULL,
  permission_id INT NOT NULL,
  PRIMARY KEY (role_id, permission_id),
  FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
  FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  employee_code VARCHAR(50) NOT NULL UNIQUE,
  full_name VARCHAR(150) NOT NULL,
  email VARCHAR(191) NOT NULL UNIQUE,
  phone VARCHAR(50),
  password_hash VARCHAR(255) NOT NULL,
  role_id INT NOT NULL,
  is_active TINYINT NOT NULL DEFAULT 1,
  last_login_at VARCHAR(40),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (role_id) REFERENCES roles(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS warehouses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  warehouse_type VARCHAR(60) NOT NULL,
  location VARCHAR(255),
  capacity_kg DOUBLE NOT NULL DEFAULT 0,
  manager_employee_id INT,
  is_active TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (manager_employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS parties (
  id INT AUTO_INCREMENT PRIMARY KEY,
  party_code VARCHAR(50) NOT NULL UNIQUE,
  party_type VARCHAR(40) NOT NULL,
  name VARCHAR(191) NOT NULL,
  contact_person VARCHAR(150),
  phone VARCHAR(50),
  email VARCHAR(191),
  tax_id VARCHAR(80),
  address TEXT,
  credit_limit DOUBLE NOT NULL DEFAULT 0,
  opening_balance DOUBLE NOT NULL DEFAULT 0,
  current_balance DOUBLE NOT NULL DEFAULT 0,
  is_active TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_units (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  symbol VARCHAR(40) NOT NULL,
  base_weight_kg DOUBLE NOT NULL DEFAULT 1,
  description TEXT,
  is_active TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(150) NOT NULL,
  group_type VARCHAR(60) NOT NULL DEFAULT 'FINISHED_GOOD',
  default_costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO',
  description TEXT,
  is_active TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(60) NOT NULL UNIQUE,
  name VARCHAR(191) NOT NULL,
  category VARCHAR(60) NOT NULL,
  process_grade VARCHAR(60) NOT NULL,
  unit VARCHAR(40) NOT NULL DEFAULT 'KG',
  bag_weight_kg DOUBLE NOT NULL DEFAULT 50,
  costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO',
  default_rate DOUBLE NOT NULL DEFAULT 0,
  is_active TINYINT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS accounts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_code VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(191) NOT NULL,
  account_type VARCHAR(40) NOT NULL,
  balance DOUBLE NOT NULL DEFAULT 0,
  is_system TINYINT NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inventory_lots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lot_code VARCHAR(64) NOT NULL UNIQUE,
  qr_code_uid VARCHAR(64) NOT NULL UNIQUE,
  item_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  source_type VARCHAR(60) NOT NULL,
  source_id INT,
  origin_batch_id INT,
  initial_qty_kg DOUBLE NOT NULL,
  remaining_qty_kg DOUBLE NOT NULL,
  initial_bags INT NOT NULL DEFAULT 0,
  remaining_bags INT NOT NULL DEFAULT 0,
  pack_size_kg DOUBLE NOT NULL DEFAULT 0,
  unit_cost_per_kg DOUBLE NOT NULL,
  moisture_pct DOUBLE,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  version INT NOT NULL DEFAULT 1,
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_ledger (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  lot_id INT NOT NULL,
  item_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  movement_type VARCHAR(60) NOT NULL,
  reference_type VARCHAR(60) NOT NULL,
  reference_id INT NOT NULL,
  qty_change_kg DOUBLE NOT NULL,
  unit_cost_per_kg DOUBLE NOT NULL,
  total_cost DOUBLE NOT NULL,
  balance_after_kg DOUBLE NOT NULL,
  employee_id INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lot_id) REFERENCES inventory_lots(id),
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS paddy_purchases (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  purchase_no VARCHAR(64) NOT NULL UNIQUE,
  supplier_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  item_id INT NOT NULL,
  vehicle_no VARCHAR(80),
  challan_no VARCHAR(80),
  bag_count INT NOT NULL DEFAULT 0,
  jute_bag_count INT NOT NULL DEFAULT 0,
  plastic_bag_count INT NOT NULL DEFAULT 0,
  moisture_pct DOUBLE NOT NULL DEFAULT 14,
  supplier_claimed_weight_kg DOUBLE NOT NULL,
  scale_weight_kg DOUBLE NOT NULL,
  received_weight_kg DOUBLE NOT NULL,
  payment_weight_kg DOUBLE NOT NULL,
  weight_loss_kg DOUBLE NOT NULL DEFAULT 0,
  settlement_unit_kg DOUBLE NOT NULL DEFAULT 75.5,
  settlement_rate DOUBLE NOT NULL DEFAULT 0,
  weight_discrepancy_kg DOUBLE NOT NULL,
  discrepancy_flagged TINYINT NOT NULL DEFAULT 0,
  discrepancy_notes TEXT,
  rate_per_kg DOUBLE NOT NULL,
  total_payable DOUBLE NOT NULL,
  paid_amount DOUBLE NOT NULL DEFAULT 0,
  returned_qty_kg DOUBLE NOT NULL DEFAULT 0,
  returned_amount DOUBLE NOT NULL DEFAULT 0,
  payment_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID',
  pricing_status VARCHAR(30) NOT NULL DEFAULT 'PRICED',
  split_summary_json LONGTEXT,
  qr_code_uid VARCHAR(64) NOT NULL UNIQUE,
  weighbridge_mode VARCHAR(40) NOT NULL DEFAULT 'MANUAL',
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES parties(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS paddy_purchase_returns (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  return_no VARCHAR(64) NOT NULL UNIQUE,
  purchase_id INT NOT NULL,
  supplier_id INT NOT NULL,
  item_id INT NOT NULL,
  return_qty_kg DOUBLE NOT NULL,
  return_bags INT NOT NULL DEFAULT 0,
  return_jute_bags INT NOT NULL DEFAULT 0,
  return_plastic_bags INT NOT NULL DEFAULT 0,
  return_amount DOUBLE NOT NULL,
  refund_mode VARCHAR(40) NOT NULL DEFAULT 'ADJUST_PAYABLE',
  account_id INT,
  reason TEXT,
  created_by INT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (purchase_id) REFERENCES paddy_purchases(id),
  FOREIGN KEY (supplier_id) REFERENCES parties(id),
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_transfers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  transfer_no VARCHAR(64) NOT NULL UNIQUE,
  from_warehouse_id INT NOT NULL,
  to_warehouse_id INT NOT NULL,
  item_id INT NOT NULL,
  qty_kg DOUBLE NOT NULL,
  bag_count INT NOT NULL DEFAULT 0,
  unit_divisor DOUBLE NOT NULL DEFAULT 75.5,
  net_units DOUBLE NOT NULL DEFAULT 0,
  bag_unit_rate DOUBLE NOT NULL DEFAULT 0,
  costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO',
  total_cost DOUBLE NOT NULL,
  vehicle_or_driver VARCHAR(150),
  notes TEXT,
  qr_code_uid VARCHAR(64) NOT NULL UNIQUE,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS paddy_sales (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  sale_no VARCHAR(64) NOT NULL UNIQUE,
  customer_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  item_id INT NOT NULL,
  qty_kg DOUBLE NOT NULL,
  rate_per_kg DOUBLE NOT NULL,
  total_amount DOUBLE NOT NULL,
  costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO',
  cogs_amount DOUBLE NOT NULL,
  paid_amount DOUBLE NOT NULL DEFAULT 0,
  payment_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID',
  vehicle_no VARCHAR(80),
  challan_no VARCHAR(80),
  bag_count INT NOT NULL DEFAULT 0,
  jute_bag_count INT NOT NULL DEFAULT 0,
  plastic_bag_count INT NOT NULL DEFAULT 0,
  moisture_pct DOUBLE NOT NULL DEFAULT 14,
  scale_weight_kg DOUBLE NOT NULL DEFAULT 0,
  payment_weight_kg DOUBLE NOT NULL DEFAULT 0,
  weight_loss_kg DOUBLE NOT NULL DEFAULT 0,
  settlement_unit_kg DOUBLE NOT NULL DEFAULT 75.5,
  settlement_rate DOUBLE NOT NULL DEFAULT 0,
  notes TEXT,
  qr_code_uid VARCHAR(64) NOT NULL UNIQUE,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES parties(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS paddy_drying_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  drying_no VARCHAR(64) NOT NULL UNIQUE,
  source_warehouse_id INT NOT NULL,
  dest_warehouse_id INT NOT NULL,
  item_id INT NOT NULL,
  drying_method VARCHAR(60) NOT NULL,
  input_qty_kg DOUBLE NOT NULL,
  initial_moisture_pct DOUBLE NOT NULL,
  final_moisture_pct DOUBLE NOT NULL,
  output_qty_kg DOUBLE NOT NULL,
  moisture_loss_kg DOUBLE NOT NULL,
  fuel_power_cost DOUBLE NOT NULL DEFAULT 0,
  labor_cost DOUBLE NOT NULL DEFAULT 0,
  input_paddy_cost DOUBLE NOT NULL,
  output_unit_cost_per_kg DOUBLE NOT NULL,
  status VARCHAR(40) NOT NULL DEFAULT 'COMPLETED',
  qr_code_uid VARCHAR(64) NOT NULL UNIQUE,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (dest_warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_batches (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  batch_no VARCHAR(64) NOT NULL UNIQUE,
  process_type VARCHAR(60) NOT NULL,
  source_warehouse_id INT NOT NULL,
  paddy_item_id INT NOT NULL,
  input_paddy_qty_kg DOUBLE NOT NULL,
  input_bag_count INT NOT NULL DEFAULT 0,
  dryer_no VARCHAR(80) NOT NULL DEFAULT '',
  dryer_count DOUBLE NOT NULL DEFAULT 1,
  unit_divisor DOUBLE NOT NULL DEFAULT 75.5,
  paddy_net_units DOUBLE NOT NULL DEFAULT 0,
  paddy_bag_unit_rate DOUBLE NOT NULL DEFAULT 0,
  paddy_formula_cost DOUBLE NOT NULL DEFAULT 0,
  costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO',
  soaking_hours DOUBLE NOT NULL DEFAULT 0,
  steaming_temp_c DOUBLE NOT NULL DEFAULT 0,
  head_rice_qty_kg DOUBLE NOT NULL DEFAULT 0,
  broken_rice_qty_kg DOUBLE NOT NULL DEFAULT 0,
  bran_qty_kg DOUBLE NOT NULL DEFAULT 0,
  husk_qty_kg DOUBLE NOT NULL DEFAULT 0,
  wastage_qty_kg DOUBLE NOT NULL DEFAULT 0,
  head_rice_yield_pct DOUBLE NOT NULL DEFAULT 0,
  total_recovery_pct DOUBLE NOT NULL DEFAULT 0,
  status VARCHAR(40) NOT NULL DEFAULT 'COMPLETED',
  qr_code_uid VARCHAR(64) NOT NULL UNIQUE,
  notes TEXT,
  created_by INT NOT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME,
  FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (paddy_item_id) REFERENCES items(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_outputs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  item_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  output_type VARCHAR(60) NOT NULL,
  pack_size_kg DOUBLE NOT NULL DEFAULT 0,
  bag_count INT NOT NULL DEFAULT 0,
  rate_per_bag DOUBLE NOT NULL DEFAULT 0,
  qty_kg DOUBLE NOT NULL,
  allocated_unit_cost_per_kg DOUBLE NOT NULL,
  total_value DOUBLE NOT NULL,
  lot_id INT,
  FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (lot_id) REFERENCES inventory_lots(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_cost_sheets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL UNIQUE,
  raw_paddy_cost DOUBLE NOT NULL,
  labor_cost DOUBLE NOT NULL DEFAULT 0,
  electricity_cost DOUBLE NOT NULL DEFAULT 0,
  fuel_boiler_cost DOUBLE NOT NULL DEFAULT 0,
  machinery_overhead_cost DOUBLE NOT NULL DEFAULT 0,
  packaging_cost DOUBLE NOT NULL DEFAULT 0,
  gross_batch_cost DOUBLE NOT NULL,
  byproduct_credit_value DOUBLE NOT NULL DEFAULT 0,
  net_head_rice_cost DOUBLE NOT NULL,
  cost_per_kg_head_rice DOUBLE NOT NULL,
  cost_per_bag_head_rice DOUBLE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_batch_inputs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  source_warehouse_id INT NOT NULL,
  paddy_item_id INT NOT NULL,
  bag_count INT NOT NULL DEFAULT 0,
  qty_kg DOUBLE NOT NULL,
  unit_divisor DOUBLE NOT NULL DEFAULT 75.5,
  net_units DOUBLE NOT NULL DEFAULT 0,
  bag_unit_rate DOUBLE NOT NULL DEFAULT 0,
  paddy_cost DOUBLE NOT NULL DEFAULT 0,
  notes TEXT,
  created_by INT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
  FOREIGN KEY (paddy_item_id) REFERENCES items(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_batch_expenses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  batch_id INT NOT NULL,
  expense_category VARCHAR(60) NOT NULL DEFAULT 'GENERAL',
  vendor_name VARCHAR(191) DEFAULT '',
  labor_cost DOUBLE NOT NULL DEFAULT 0,
  electricity_cost DOUBLE NOT NULL DEFAULT 0,
  fuel_boiler_cost DOUBLE NOT NULL DEFAULT 0,
  machinery_overhead_cost DOUBLE NOT NULL DEFAULT 0,
  packaging_cost DOUBLE NOT NULL DEFAULT 0,
  total_amount DOUBLE NOT NULL DEFAULT 0,
  payment_status VARCHAR(30) NOT NULL DEFAULT 'PAID',
  paid_amount DOUBLE NOT NULL DEFAULT 0,
  account_id INT,
  paid_at DATETIME,
  notes TEXT,
  created_by INT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS production_expense_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  expense_id INT NOT NULL,
  batch_id INT NOT NULL,
  account_id INT NOT NULL,
  amount DOUBLE NOT NULL,
  payment_mode VARCHAR(40) NOT NULL DEFAULT 'CASH',
  reference_no VARCHAR(100),
  receipt_no VARCHAR(64),
  notes TEXT,
  paid_by INT,
  paid_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (expense_id) REFERENCES production_batch_expenses(id) ON DELETE CASCADE,
  FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (paid_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_invoices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  invoice_no VARCHAR(64) NOT NULL UNIQUE,
  customer_id INT NOT NULL,
  subtotal_amount DOUBLE NOT NULL,
  tax_amount DOUBLE NOT NULL DEFAULT 0,
  discount_amount DOUBLE NOT NULL DEFAULT 0,
  total_amount DOUBLE NOT NULL,
  total_cogs DOUBLE NOT NULL,
  paid_amount DOUBLE NOT NULL DEFAULT 0,
  payment_status VARCHAR(30) NOT NULL DEFAULT 'UNPAID',
  vehicle_no VARCHAR(80),
  qr_code_uid VARCHAR(64) NOT NULL UNIQUE,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES parties(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_invoice_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id INT NOT NULL,
  item_id INT NOT NULL,
  warehouse_id INT NOT NULL,
  qty_kg DOUBLE NOT NULL,
  bag_count INT NOT NULL DEFAULT 0,
  pack_size_kg DOUBLE NOT NULL DEFAULT 50,
  rate_per_bag DOUBLE NOT NULL DEFAULT 0,
  rate_per_kg DOUBLE NOT NULL,
  line_total DOUBLE NOT NULL,
  costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO',
  line_cogs DOUBLE NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES sales_invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (item_id) REFERENCES items(id),
  FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sales_invoice_lot_allocations (
  id INT AUTO_INCREMENT PRIMARY KEY,
  invoice_id INT NOT NULL,
  invoice_item_id INT,
  lot_id INT NOT NULL,
  batch_id INT,
  item_id INT NOT NULL,
  qty_kg DOUBLE NOT NULL,
  bag_count INT NOT NULL DEFAULT 0,
  cost_per_kg DOUBLE NOT NULL,
  cost_amount DOUBLE NOT NULL,
  sale_rate_per_kg DOUBLE NOT NULL,
  sale_amount DOUBLE NOT NULL,
  profit_amount DOUBLE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (invoice_id) REFERENCES sales_invoices(id) ON DELETE CASCADE,
  FOREIGN KEY (lot_id) REFERENCES inventory_lots(id),
  FOREIGN KEY (batch_id) REFERENCES production_batches(id),
  FOREIGN KEY (item_id) REFERENCES items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS weighbridge_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  ticket_no VARCHAR(64) NOT NULL UNIQUE,
  vehicle_no VARCHAR(80) NOT NULL,
  driver_name VARCHAR(150),
  gross_weight_kg DOUBLE NOT NULL,
  tare_weight_kg DOUBLE NOT NULL,
  net_weight_kg DOUBLE NOT NULL,
  device_mode VARCHAR(40) NOT NULL,
  raw_device_string TEXT,
  linked_type VARCHAR(60),
  linked_id INT,
  operator_id INT NOT NULL,
  captured_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (operator_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS qr_tags (
  qr_code_uid VARCHAR(64) PRIMARY KEY,
  entity_type VARCHAR(60) NOT NULL,
  entity_id INT NOT NULL,
  entity_code VARCHAR(80) NOT NULL,
  payload_json LONGTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS journal_entries (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  voucher_no VARCHAR(64) NOT NULL UNIQUE,
  entry_date VARCHAR(20) NOT NULL,
  description TEXT NOT NULL,
  reference_type VARCHAR(60),
  reference_id INT,
  is_posted TINYINT NOT NULL DEFAULT 1,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS journal_lines (
  id INT AUTO_INCREMENT PRIMARY KEY,
  journal_entry_id INT NOT NULL,
  account_id INT NOT NULL,
  debit DOUBLE NOT NULL DEFAULT 0,
  credit DOUBLE NOT NULL DEFAULT 0,
  party_id INT,
  FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (party_id) REFERENCES parties(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  payment_no VARCHAR(64) NOT NULL UNIQUE,
  direction VARCHAR(30) NOT NULL,
  voucher_type VARCHAR(50) NOT NULL DEFAULT 'DUE_SETTLEMENT',
  party_id INT NOT NULL,
  account_id INT NOT NULL,
  amount DOUBLE NOT NULL,
  payment_mode VARCHAR(40) NOT NULL,
  reference_no VARCHAR(100),
  settled_ref_no VARCHAR(150),
  notes TEXT,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (party_id) REFERENCES parties(id),
  FOREIGN KEY (account_id) REFERENCES accounts(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sync_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  device_id VARCHAR(80) NOT NULL,
  client_type VARCHAR(40) NOT NULL,
  endpoint VARCHAR(191) NOT NULL,
  status VARCHAR(40) NOT NULL,
  conflict_reason TEXT,
  response_json LONGTEXT,
  employee_id INT NOT NULL,
  synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id INT,
  employee_name VARCHAR(150) NOT NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id VARCHAR(100) NOT NULL,
  before_json LONGTEXT,
  after_json LONGTEXT,
  ip_address VARCHAR(80),
  device_type VARCHAR(40),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS backup_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  backup_name VARCHAR(191) NOT NULL,
  file_size_bytes BIGINT NOT NULL,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS company_settings (
  id INT PRIMARY KEY,
  company_name_en VARCHAR(191) NOT NULL DEFAULT 'Maya Special Rice',
  company_name_bn VARCHAR(191) NOT NULL DEFAULT 'মায়া স্পেশাল রাইস',
  short_code VARCHAR(16) NOT NULL DEFAULT 'MS',
  tagline_en VARCHAR(255) NOT NULL DEFAULT 'Automated Parboiled & Raw Rice Mill · Weighbridge, Milling & Wholesale Trade',
  tagline_bn VARCHAR(255) NOT NULL DEFAULT 'অটোমেটিক সিদ্ধ ও আতপ রাইস মিল · ডিজিটাল ওয়েব্রিজ, প্রসেসিং ও চাল বিপণন',
  address_en VARCHAR(255) NOT NULL DEFAULT 'Plot 14, BSCIC Industrial Estate, Bogura-5800, Bangladesh',
  address_bn VARCHAR(255) NOT NULL DEFAULT 'প্লট ১৪, বিসিক শিল্প নগরী, বগুড়া-৫৮০০, বাংলাদেশ',
  phone VARCHAR(60) NOT NULL DEFAULT '+880 1711-000000',
  email VARCHAR(191) NOT NULL DEFAULT 'admin@gmail.com',
  tax_id VARCHAR(100) NOT NULL DEFAULT 'BIN: 001234567-0101',
  logo_data_url LONGTEXT,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS supplier_bag_ledger (
  id INT AUTO_INCREMENT PRIMARY KEY,
  client_uuid VARCHAR(64) NOT NULL UNIQUE,
  entry_no VARCHAR(64) NOT NULL UNIQUE,
  supplier_id INT NOT NULL,
  entry_type VARCHAR(50) NOT NULL,
  direction VARCHAR(40) NOT NULL,
  jute_qty INT NOT NULL DEFAULT 0,
  plastic_qty INT NOT NULL DEFAULT 0,
  total_qty INT NOT NULL DEFAULT 0,
  reference_type VARCHAR(50),
  reference_id INT,
  reference_no VARCHAR(80),
  entry_date VARCHAR(20) NOT NULL DEFAULT '',
  notes TEXT,
  created_by INT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (supplier_id) REFERENCES parties(id),
  FOREIGN KEY (created_by) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS app_meta (
  meta_key VARCHAR(100) PRIMARY KEY,
  meta_value TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sms_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id INT NOT NULL DEFAULT 0,
  entity_code VARCHAR(80) NOT NULL DEFAULT '',
  party_id INT,
  party_name VARCHAR(191) NOT NULL DEFAULT '',
  phone VARCHAR(40) NOT NULL DEFAULT '',
  provider VARCHAR(40) NOT NULL DEFAULT 'NONE',
  message_body TEXT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'SKIPPED',
  provider_response TEXT,
  created_by INT,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
