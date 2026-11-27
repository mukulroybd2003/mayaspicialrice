// server.ts
import bcrypt2 from "bcryptjs";
import crypto3 from "crypto";
import dotenv from "dotenv";
import express from "express";
import fs2 from "fs";
import http from "http";
import jwt from "jsonwebtoken";
import path2 from "path";
import { createServer as createViteServer } from "vite";

// server/db.ts
import Database from "better-sqlite3";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import fs from "fs";
import path from "path";
var DATA_DIR = path.resolve(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
var DB_PATH = path.join(DATA_DIR, "sonagrain.db");
var db = new Database(DB_PATH);
db.pragma("journal_mode = DELETE");
db.pragma("foreign_keys = ON");
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      perm_key TEXT NOT NULL UNIQUE,
      module TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL,
      permission_id INTEGER NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_code TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      password_hash TEXT NOT NULL,
      role_id INTEGER NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (role_id) REFERENCES roles(id)
    );

    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      warehouse_type TEXT NOT NULL,
      location TEXT,
      capacity_kg REAL NOT NULL DEFAULT 0,
      manager_employee_id INTEGER,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (manager_employee_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS parties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      party_code TEXT NOT NULL UNIQUE,
      party_type TEXT NOT NULL,
      name TEXT NOT NULL,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      tax_id TEXT,
      address TEXT,
      credit_limit REAL NOT NULL DEFAULT 0,
      opening_balance REAL NOT NULL DEFAULT 0,
      current_balance REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      base_weight_kg REAL NOT NULL DEFAULT 1,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS product_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      group_type TEXT NOT NULL DEFAULT 'FINISHED_GOOD',
      default_costing_method TEXT NOT NULL DEFAULT 'FIFO',
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      process_grade TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'KG',
      bag_weight_kg REAL NOT NULL DEFAULT 50,
      costing_method TEXT NOT NULL DEFAULT 'FIFO',
      default_rate REAL NOT NULL DEFAULT 0,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS inventory_lots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_code TEXT NOT NULL UNIQUE,
      qr_code_uid TEXT NOT NULL UNIQUE,
      item_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_id INTEGER,
      initial_qty_kg REAL NOT NULL,
      remaining_qty_kg REAL NOT NULL CHECK (remaining_qty_kg >= 0),
      initial_bags INTEGER NOT NULL DEFAULT 0,
      remaining_bags INTEGER NOT NULL DEFAULT 0,
      unit_cost_per_kg REAL NOT NULL,
      moisture_pct REAL,
      received_at TEXT NOT NULL DEFAULT (datetime('now')),
      version INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    );

    CREATE TABLE IF NOT EXISTS stock_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      movement_type TEXT NOT NULL,
      reference_type TEXT NOT NULL,
      reference_id INTEGER NOT NULL,
      qty_change_kg REAL NOT NULL,
      unit_cost_per_kg REAL NOT NULL,
      total_cost REAL NOT NULL,
      balance_after_kg REAL NOT NULL,
      employee_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (lot_id) REFERENCES inventory_lots(id),
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS paddy_purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      purchase_no TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      vehicle_no TEXT,
      challan_no TEXT,
      bag_count INTEGER NOT NULL DEFAULT 0,
      jute_bag_count INTEGER NOT NULL DEFAULT 0,
      plastic_bag_count INTEGER NOT NULL DEFAULT 0,
      moisture_pct REAL NOT NULL DEFAULT 14,
      supplier_claimed_weight_kg REAL NOT NULL,
      scale_weight_kg REAL NOT NULL,
      received_weight_kg REAL NOT NULL,
      payment_weight_kg REAL NOT NULL,
      weight_loss_kg REAL NOT NULL DEFAULT 0,
      settlement_unit_kg REAL NOT NULL DEFAULT 75.5,
      settlement_rate REAL NOT NULL DEFAULT 0,
      weight_discrepancy_kg REAL NOT NULL,
      discrepancy_flagged INTEGER NOT NULL DEFAULT 0,
      discrepancy_notes TEXT,
      rate_per_kg REAL NOT NULL,
      total_payable REAL NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'UNPAID',
      qr_code_uid TEXT NOT NULL UNIQUE,
      weighbridge_mode TEXT NOT NULL DEFAULT 'MANUAL',
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (supplier_id) REFERENCES parties(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS stock_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      transfer_no TEXT NOT NULL UNIQUE,
      from_warehouse_id INTEGER NOT NULL,
      to_warehouse_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      qty_kg REAL NOT NULL,
      bag_count INTEGER NOT NULL DEFAULT 0,
      unit_divisor REAL NOT NULL DEFAULT 75.5,
      net_units REAL NOT NULL DEFAULT 0,
      bag_unit_rate REAL NOT NULL DEFAULT 0,
      costing_method TEXT NOT NULL DEFAULT 'FIFO',
      total_cost REAL NOT NULL,
      vehicle_or_driver TEXT,
      notes TEXT,
      qr_code_uid TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (to_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS paddy_sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      sale_no TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      qty_kg REAL NOT NULL,
      rate_per_kg REAL NOT NULL,
      total_amount REAL NOT NULL,
      costing_method TEXT NOT NULL DEFAULT 'FIFO',
      cogs_amount REAL NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'UNPAID',
      vehicle_no TEXT,
      qr_code_uid TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES parties(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS paddy_drying_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      drying_no TEXT NOT NULL UNIQUE,
      source_warehouse_id INTEGER NOT NULL,
      dest_warehouse_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      drying_method TEXT NOT NULL,
      input_qty_kg REAL NOT NULL,
      initial_moisture_pct REAL NOT NULL,
      final_moisture_pct REAL NOT NULL,
      output_qty_kg REAL NOT NULL,
      moisture_loss_kg REAL NOT NULL,
      fuel_power_cost REAL NOT NULL DEFAULT 0,
      labor_cost REAL NOT NULL DEFAULT 0,
      input_paddy_cost REAL NOT NULL,
      output_unit_cost_per_kg REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      qr_code_uid TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (dest_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS production_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      batch_no TEXT NOT NULL UNIQUE,
      process_type TEXT NOT NULL,
      source_warehouse_id INTEGER NOT NULL,
      paddy_item_id INTEGER NOT NULL,
      input_paddy_qty_kg REAL NOT NULL,
      input_bag_count INTEGER NOT NULL DEFAULT 0,
      dryer_no TEXT NOT NULL DEFAULT '',
      dryer_count REAL NOT NULL DEFAULT 1,
      unit_divisor REAL NOT NULL DEFAULT 75.5,
      paddy_net_units REAL NOT NULL DEFAULT 0,
      paddy_bag_unit_rate REAL NOT NULL DEFAULT 0,
      paddy_formula_cost REAL NOT NULL DEFAULT 0,
      costing_method TEXT NOT NULL DEFAULT 'FIFO',
      soaking_hours REAL NOT NULL DEFAULT 0,
      steaming_temp_c REAL NOT NULL DEFAULT 0,
      head_rice_qty_kg REAL NOT NULL DEFAULT 0,
      broken_rice_qty_kg REAL NOT NULL DEFAULT 0,
      bran_qty_kg REAL NOT NULL DEFAULT 0,
      husk_qty_kg REAL NOT NULL DEFAULT 0,
      wastage_qty_kg REAL NOT NULL DEFAULT 0,
      head_rice_yield_pct REAL NOT NULL DEFAULT 0,
      total_recovery_pct REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'COMPLETED',
      qr_code_uid TEXT NOT NULL UNIQUE,
      notes TEXT,
      created_by INTEGER NOT NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (paddy_item_id) REFERENCES items(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS production_outputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      output_type TEXT NOT NULL,
      pack_size_kg REAL NOT NULL DEFAULT 0,
      bag_count INTEGER NOT NULL DEFAULT 0,
      qty_kg REAL NOT NULL,
      allocated_unit_cost_per_kg REAL NOT NULL,
      total_value REAL NOT NULL,
      lot_id INTEGER,
      FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (lot_id) REFERENCES inventory_lots(id)
    );

    CREATE TABLE IF NOT EXISTS production_cost_sheets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL UNIQUE,
      raw_paddy_cost REAL NOT NULL,
      labor_cost REAL NOT NULL DEFAULT 0,
      electricity_cost REAL NOT NULL DEFAULT 0,
      fuel_boiler_cost REAL NOT NULL DEFAULT 0,
      machinery_overhead_cost REAL NOT NULL DEFAULT 0,
      packaging_cost REAL NOT NULL DEFAULT 0,
      gross_batch_cost REAL NOT NULL,
      byproduct_credit_value REAL NOT NULL DEFAULT 0,
      net_head_rice_cost REAL NOT NULL,
      cost_per_kg_head_rice REAL NOT NULL,
      cost_per_bag_head_rice REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS production_batch_inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      source_warehouse_id INTEGER NOT NULL,
      paddy_item_id INTEGER NOT NULL,
      bag_count INTEGER NOT NULL DEFAULT 0,
      qty_kg REAL NOT NULL,
      unit_divisor REAL NOT NULL DEFAULT 75.5,
      net_units REAL NOT NULL DEFAULT 0,
      bag_unit_rate REAL NOT NULL DEFAULT 0,
      paddy_cost REAL NOT NULL DEFAULT 0,
      notes TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (paddy_item_id) REFERENCES items(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS production_batch_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      expense_category TEXT NOT NULL DEFAULT 'GENERAL',
      vendor_name TEXT DEFAULT '',
      labor_cost REAL NOT NULL DEFAULT 0,
      electricity_cost REAL NOT NULL DEFAULT 0,
      fuel_boiler_cost REAL NOT NULL DEFAULT 0,
      machinery_overhead_cost REAL NOT NULL DEFAULT 0,
      packaging_cost REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'PAID',
      paid_amount REAL NOT NULL DEFAULT 0,
      account_id INTEGER,
      paid_at TEXT,
      notes TEXT,
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS production_expense_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_id INTEGER NOT NULL,
      batch_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_mode TEXT NOT NULL DEFAULT 'CASH',
      reference_no TEXT,
      notes TEXT,
      paid_by INTEGER,
      paid_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (expense_id) REFERENCES production_batch_expenses(id) ON DELETE CASCADE,
      FOREIGN KEY (batch_id) REFERENCES production_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (paid_by) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS sales_invoice_lot_allocations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      invoice_item_id INTEGER,
      lot_id INTEGER NOT NULL,
      batch_id INTEGER,
      item_id INTEGER NOT NULL,
      qty_kg REAL NOT NULL,
      bag_count INTEGER NOT NULL DEFAULT 0,
      cost_per_kg REAL NOT NULL,
      cost_amount REAL NOT NULL,
      sale_rate_per_kg REAL NOT NULL,
      sale_amount REAL NOT NULL,
      profit_amount REAL NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (invoice_id) REFERENCES sales_invoices(id) ON DELETE CASCADE,
      FOREIGN KEY (lot_id) REFERENCES inventory_lots(id),
      FOREIGN KEY (batch_id) REFERENCES production_batches(id),
      FOREIGN KEY (item_id) REFERENCES items(id)
    );

    CREATE TABLE IF NOT EXISTS sales_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      invoice_no TEXT NOT NULL UNIQUE,
      customer_id INTEGER NOT NULL,
      subtotal_amount REAL NOT NULL,
      tax_amount REAL NOT NULL DEFAULT 0,
      discount_amount REAL NOT NULL DEFAULT 0,
      total_amount REAL NOT NULL,
      total_cogs REAL NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'UNPAID',
      vehicle_no TEXT,
      qr_code_uid TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (customer_id) REFERENCES parties(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS sales_invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      warehouse_id INTEGER NOT NULL,
      qty_kg REAL NOT NULL,
      rate_per_kg REAL NOT NULL,
      line_total REAL NOT NULL,
      costing_method TEXT NOT NULL DEFAULT 'FIFO',
      line_cogs REAL NOT NULL,
      FOREIGN KEY (invoice_id) REFERENCES sales_invoices(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    );

    CREATE TABLE IF NOT EXISTS weighbridge_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      ticket_no TEXT NOT NULL UNIQUE,
      vehicle_no TEXT NOT NULL,
      driver_name TEXT,
      gross_weight_kg REAL NOT NULL,
      tare_weight_kg REAL NOT NULL,
      net_weight_kg REAL NOT NULL,
      device_mode TEXT NOT NULL,
      raw_device_string TEXT,
      linked_type TEXT,
      linked_id INTEGER,
      operator_id INTEGER NOT NULL,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (operator_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS qr_tags (
      qr_code_uid TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      entity_code TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS journal_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      voucher_no TEXT NOT NULL UNIQUE,
      entry_date TEXT NOT NULL,
      description TEXT NOT NULL,
      reference_type TEXT,
      reference_id INTEGER,
      is_posted INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS journal_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_entry_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      debit REAL NOT NULL DEFAULT 0,
      credit REAL NOT NULL DEFAULT 0,
      party_id INTEGER,
      FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (party_id) REFERENCES parties(id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      payment_no TEXT NOT NULL UNIQUE,
      direction TEXT NOT NULL,
      voucher_type TEXT NOT NULL DEFAULT 'DUE_SETTLEMENT',
      party_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      payment_mode TEXT NOT NULL,
      reference_no TEXT,
      settled_ref_no TEXT,
      notes TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (party_id) REFERENCES parties(id),
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL,
      client_type TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      status TEXT NOT NULL,
      conflict_reason TEXT,
      response_json TEXT,
      employee_id INTEGER NOT NULL,
      synced_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER,
      employee_name TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      ip_address TEXT,
      device_type TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS backup_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      backup_name TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    );

    CREATE TABLE IF NOT EXISTS company_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      company_name_en TEXT NOT NULL DEFAULT 'Maya Special Rice',
      company_name_bn TEXT NOT NULL DEFAULT '\u09AE\u09BE\u09DF\u09BE \u09B8\u09CD\u09AA\u09C7\u09B6\u09BE\u09B2 \u09B0\u09BE\u0987\u09B8',
      short_code TEXT NOT NULL DEFAULT 'MS',
      tagline_en TEXT NOT NULL DEFAULT 'Automated Parboiled & Raw Rice Mill \xB7 Weighbridge, Milling & Wholesale Trade',
      tagline_bn TEXT NOT NULL DEFAULT '\u0985\u099F\u09CB\u09AE\u09C7\u099F\u09BF\u0995 \u09B8\u09BF\u09A6\u09CD\u09A7 \u0993 \u0986\u09A4\u09AA \u09B0\u09BE\u0987\u09B8 \u09AE\u09BF\u09B2 \xB7 \u09A1\u09BF\u099C\u09BF\u099F\u09BE\u09B2 \u0993\u09AF\u09BC\u09C7\u09AC\u09CD\u09B0\u09BF\u099C, \u09AA\u09CD\u09B0\u09B8\u09C7\u09B8\u09BF\u0982 \u0993 \u099A\u09BE\u09B2 \u09AC\u09BF\u09AA\u09A3\u09A8',
      address_en TEXT NOT NULL DEFAULT 'Plot 14, BSCIC Industrial Estate, Bogura-5800, Bangladesh',
      address_bn TEXT NOT NULL DEFAULT '\u09AA\u09CD\u09B2\u099F \u09E7\u09EA, \u09AC\u09BF\u09B8\u09BF\u0995 \u09B6\u09BF\u09B2\u09CD\u09AA \u09A8\u0997\u09B0\u09C0, \u09AC\u0997\u09C1\u09A1\u09BC\u09BE-\u09EB\u09EE\u09E6\u09E6, \u09AC\u09BE\u0982\u09B2\u09BE\u09A6\u09C7\u09B6',
      phone TEXT NOT NULL DEFAULT '+880 1711-000000',
      email TEXT NOT NULL DEFAULT 'admin@gmail.com',
      tax_id TEXT NOT NULL DEFAULT 'BIN: 001234567-0101',
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS supplier_bag_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      entry_no TEXT NOT NULL UNIQUE,
      supplier_id INTEGER NOT NULL,
      entry_type TEXT NOT NULL,
      direction TEXT NOT NULL,
      jute_qty INTEGER NOT NULL DEFAULT 0,
      plastic_qty INTEGER NOT NULL DEFAULT 0,
      total_qty INTEGER NOT NULL DEFAULT 0,
      reference_type TEXT,
      reference_id INTEGER,
      reference_no TEXT,
      entry_date TEXT NOT NULL DEFAULT (date('now')),
      notes TEXT,
      created_by INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (supplier_id) REFERENCES parties(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    );

    INSERT OR IGNORE INTO company_settings (id) VALUES (1);
  `);
  const payCols = db.prepare("PRAGMA table_info(payments)").all();
  const payColNames = new Set(payCols.map((c) => c.name));
  if (!payColNames.has("voucher_type")) {
    db.exec("ALTER TABLE payments ADD COLUMN voucher_type TEXT NOT NULL DEFAULT 'DUE_SETTLEMENT'");
  }
  if (!payColNames.has("settled_ref_no")) {
    db.exec("ALTER TABLE payments ADD COLUMN settled_ref_no TEXT");
  }
  const purCols = db.prepare("PRAGMA table_info(paddy_purchases)").all();
  const purColNames = new Set(purCols.map((c) => c.name));
  if (!purColNames.has("weight_loss_kg")) {
    db.exec("ALTER TABLE paddy_purchases ADD COLUMN weight_loss_kg REAL NOT NULL DEFAULT 0");
  }
  if (!purColNames.has("settlement_unit_kg")) {
    db.exec("ALTER TABLE paddy_purchases ADD COLUMN settlement_unit_kg REAL NOT NULL DEFAULT 75.5");
  }
  if (!purColNames.has("settlement_rate")) {
    db.exec("ALTER TABLE paddy_purchases ADD COLUMN settlement_rate REAL NOT NULL DEFAULT 0");
  }
  if (!purColNames.has("jute_bag_count")) {
    db.exec("ALTER TABLE paddy_purchases ADD COLUMN jute_bag_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!purColNames.has("plastic_bag_count")) {
    db.exec("ALTER TABLE paddy_purchases ADD COLUMN plastic_bag_count INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE paddy_purchases SET jute_bag_count = bag_count WHERE jute_bag_count = 0 AND plastic_bag_count = 0 AND bag_count > 0");
  }
  const bagLedgerCount = db.prepare("SELECT COUNT(*) as c FROM supplier_bag_ledger").get().c;
  const existingPurchaseCount = db.prepare("SELECT COUNT(*) as c FROM paddy_purchases").get().c;
  if (bagLedgerCount === 0 && existingPurchaseCount > 0) {
    const purchasesForBags = db.prepare("SELECT id, purchase_no, supplier_id, bag_count, jute_bag_count, plastic_bag_count, created_by, created_at FROM paddy_purchases WHERE bag_count > 0").all();
    const insBag = db.prepare(
      `INSERT INTO supplier_bag_ledger (
        client_uuid, entry_no, supplier_id, entry_type, direction,
        jute_qty, plastic_qty, total_qty, reference_type, reference_id, reference_no, entry_date, notes, created_by, created_at
      ) VALUES (?, ?, ?, 'PADDY_DEPOSIT', 'IN_FROM_SUPPLIER', ?, ?, ?, 'PADDY_PURCHASE', ?, ?, ?, ?, ?, ?)`
    );
    purchasesForBags.forEach((p, idx) => {
      const jute = p.jute_bag_count > 0 || p.plastic_bag_count > 0 ? p.jute_bag_count : p.bag_count;
      const plastic = p.plastic_bag_count || 0;
      const total = jute + plastic;
      insBag.run(
        crypto.randomUUID(),
        `BAG-2026-${String(idx + 1).padStart(4, "0")}`,
        p.supplier_id,
        jute,
        plastic,
        total,
        p.id,
        p.purchase_no,
        String(p.created_at || "").slice(0, 10) || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
        `Paddy purchase bag deposit (${p.purchase_no})`,
        p.created_by,
        p.created_at
      );
    });
  }
  const lotCols = db.prepare("PRAGMA table_info(inventory_lots)").all();
  const lotColNames = new Set(lotCols.map((c) => c.name));
  if (!lotColNames.has("initial_bags")) {
    db.exec("ALTER TABLE inventory_lots ADD COLUMN initial_bags INTEGER NOT NULL DEFAULT 0");
  }
  if (!lotColNames.has("remaining_bags")) {
    db.exec("ALTER TABLE inventory_lots ADD COLUMN remaining_bags INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE inventory_lots
      SET initial_bags = CASE
        WHEN source_type = 'PADDY_PURCHASE' AND COALESCE((SELECT bag_count FROM paddy_purchases WHERE id = inventory_lots.source_id), 0) > 0
          THEN (SELECT bag_count FROM paddy_purchases WHERE id = inventory_lots.source_id)
        ELSE CAST(ROUND(initial_qty_kg / COALESCE(NULLIF((SELECT bag_weight_kg FROM items WHERE id = inventory_lots.item_id), 0), 50)) AS INTEGER)
      END,
      remaining_bags = CASE
        WHEN remaining_qty_kg <= 0.0001 THEN 0
        WHEN source_type = 'PADDY_PURCHASE' AND initial_qty_kg > 0 AND COALESCE((SELECT bag_count FROM paddy_purchases WHERE id = inventory_lots.source_id), 0) > 0
          THEN CAST(ROUND(remaining_qty_kg * (SELECT bag_count FROM paddy_purchases WHERE id = inventory_lots.source_id) / initial_qty_kg) AS INTEGER)
        ELSE CAST(ROUND(remaining_qty_kg / COALESCE(NULLIF((SELECT bag_weight_kg FROM items WHERE id = inventory_lots.item_id), 0), 50)) AS INTEGER)
      END
    `);
  }
  if (!lotColNames.has("pack_size_kg")) {
    db.exec("ALTER TABLE inventory_lots ADD COLUMN pack_size_kg REAL NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE inventory_lots
      SET pack_size_kg = COALESCE(NULLIF((SELECT bag_weight_kg FROM items WHERE id = inventory_lots.item_id), 0), 50)
      WHERE pack_size_kg = 0
    `);
  }
  const outCols = db.prepare("PRAGMA table_info(production_outputs)").all();
  const outColNames = new Set(outCols.map((c) => c.name));
  if (!outColNames.has("pack_size_kg")) {
    db.exec("ALTER TABLE production_outputs ADD COLUMN pack_size_kg REAL NOT NULL DEFAULT 0");
  }
  if (!outColNames.has("bag_count")) {
    db.exec("ALTER TABLE production_outputs ADD COLUMN bag_count INTEGER NOT NULL DEFAULT 0");
  }
  const expCols = db.prepare("PRAGMA table_info(production_batch_expenses)").all();
  const expColNames = new Set(expCols.map((c) => c.name));
  if (!expColNames.has("expense_category")) {
    db.exec("ALTER TABLE production_batch_expenses ADD COLUMN expense_category TEXT NOT NULL DEFAULT 'GENERAL'");
  }
  if (!expColNames.has("vendor_name")) {
    db.exec("ALTER TABLE production_batch_expenses ADD COLUMN vendor_name TEXT DEFAULT ''");
  }
  if (!expColNames.has("payment_status")) {
    db.exec("ALTER TABLE production_batch_expenses ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'PAID'");
  }
  if (!expColNames.has("paid_amount")) {
    db.exec("ALTER TABLE production_batch_expenses ADD COLUMN paid_amount REAL NOT NULL DEFAULT 0");
    db.exec("UPDATE production_batch_expenses SET paid_amount = total_amount WHERE payment_status = 'PAID' AND paid_amount = 0");
  }
  if (!expColNames.has("account_id")) {
    db.exec("ALTER TABLE production_batch_expenses ADD COLUMN account_id INTEGER");
  }
  if (!expColNames.has("paid_at")) {
    db.exec("ALTER TABLE production_batch_expenses ADD COLUMN paid_at TEXT");
  }
  const batchCols = db.prepare("PRAGMA table_info(production_batches)").all();
  const batchColNames = new Set(batchCols.map((c) => c.name));
  if (!batchColNames.has("input_bag_count")) {
    db.exec("ALTER TABLE production_batches ADD COLUMN input_bag_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!batchColNames.has("dryer_no")) {
    db.exec("ALTER TABLE production_batches ADD COLUMN dryer_no TEXT NOT NULL DEFAULT ''");
  }
  if (!batchColNames.has("dryer_count")) {
    db.exec("ALTER TABLE production_batches ADD COLUMN dryer_count REAL NOT NULL DEFAULT 1");
  }
  if (!batchColNames.has("unit_divisor")) {
    db.exec("ALTER TABLE production_batches ADD COLUMN unit_divisor REAL NOT NULL DEFAULT 75.5");
  }
  if (!batchColNames.has("paddy_net_units")) {
    db.exec("ALTER TABLE production_batches ADD COLUMN paddy_net_units REAL NOT NULL DEFAULT 0");
  }
  if (!batchColNames.has("paddy_bag_unit_rate")) {
    db.exec("ALTER TABLE production_batches ADD COLUMN paddy_bag_unit_rate REAL NOT NULL DEFAULT 0");
  }
  if (!batchColNames.has("paddy_formula_cost")) {
    db.exec("ALTER TABLE production_batches ADD COLUMN paddy_formula_cost REAL NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE production_batches
      SET input_bag_count = CAST(ROUND(input_paddy_qty_kg / COALESCE(NULLIF((SELECT bag_weight_kg FROM items WHERE id = production_batches.paddy_item_id), 0), 60)) AS INTEGER),
          dryer_no = CASE WHEN process_type = 'PARBOILED_SIDDHO' THEN 'Dryer-1' ELSE 'Dryer-2' END,
          dryer_count = 1,
          unit_divisor = 75.5
      WHERE input_bag_count = 0 AND input_paddy_qty_kg > 0;
      UPDATE production_batches
      SET paddy_net_units = ROUND(MAX(0, input_paddy_qty_kg - input_bag_count) / 75.5, 4),
          paddy_formula_cost = COALESCE((SELECT raw_paddy_cost FROM production_cost_sheets WHERE batch_id = production_batches.id), 0),
          paddy_bag_unit_rate = CASE
            WHEN MAX(0, input_paddy_qty_kg - input_bag_count) > 0
              THEN ROUND(COALESCE((SELECT raw_paddy_cost FROM production_cost_sheets WHERE batch_id = production_batches.id), 0) / ((input_paddy_qty_kg - input_bag_count) / 75.5), 2)
            ELSE 0
          END
      WHERE paddy_formula_cost = 0 AND input_paddy_qty_kg > 0;
    `);
  }
  const trCols = db.prepare("PRAGMA table_info(stock_transfers)").all();
  const trColNames = new Set(trCols.map((c) => c.name));
  if (!trColNames.has("bag_count")) {
    db.exec("ALTER TABLE stock_transfers ADD COLUMN bag_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!trColNames.has("unit_divisor")) {
    db.exec("ALTER TABLE stock_transfers ADD COLUMN unit_divisor REAL NOT NULL DEFAULT 75.5");
  }
  if (!trColNames.has("net_units")) {
    db.exec("ALTER TABLE stock_transfers ADD COLUMN net_units REAL NOT NULL DEFAULT 0");
  }
  if (!trColNames.has("bag_unit_rate")) {
    db.exec("ALTER TABLE stock_transfers ADD COLUMN bag_unit_rate REAL NOT NULL DEFAULT 0");
    db.exec(`
      UPDATE stock_transfers
      SET bag_count = CAST(ROUND(qty_kg / COALESCE(NULLIF((SELECT bag_weight_kg FROM items WHERE id = stock_transfers.item_id), 0), 60)) AS INTEGER),
          unit_divisor = 75.5
      WHERE bag_count = 0 AND qty_kg > 0;
      UPDATE stock_transfers
      SET net_units = ROUND(MAX(0, qty_kg - bag_count) / 75.5, 4),
          bag_unit_rate = CASE
            WHEN MAX(0, qty_kg - bag_count) > 0
              THEN ROUND(total_cost / ((qty_kg - bag_count) / 75.5), 2)
            ELSE 0
          END
      WHERE net_units = 0 AND qty_kg > 0;
    `);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS paddy_purchase_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      return_no TEXT NOT NULL UNIQUE,
      purchase_id INTEGER NOT NULL REFERENCES paddy_purchases(id),
      supplier_id INTEGER NOT NULL REFERENCES parties(id),
      item_id INTEGER NOT NULL REFERENCES items(id),
      return_qty_kg REAL NOT NULL,
      return_bags INTEGER NOT NULL DEFAULT 0,
      return_jute_bags INTEGER NOT NULL DEFAULT 0,
      return_plastic_bags INTEGER NOT NULL DEFAULT 0,
      return_amount REAL NOT NULL,
      refund_mode TEXT NOT NULL DEFAULT 'ADJUST_PAYABLE',
      account_id INTEGER REFERENCES accounts(id),
      reason TEXT DEFAULT '',
      created_by INTEGER REFERENCES employees(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const ppCols = db.prepare("PRAGMA table_info(paddy_purchases)").all();
  const ppColNames = new Set(ppCols.map((c) => c.name));
  if (!ppColNames.has("returned_qty_kg")) {
    db.exec("ALTER TABLE paddy_purchases ADD COLUMN returned_qty_kg REAL NOT NULL DEFAULT 0");
  }
  if (!ppColNames.has("returned_amount")) {
    db.exec("ALTER TABLE paddy_purchases ADD COLUMN returned_amount REAL NOT NULL DEFAULT 0");
  }
  if (!ppColNames.has("split_summary_json")) {
    db.exec("ALTER TABLE paddy_purchases ADD COLUMN split_summary_json TEXT");
  }
  if (!ppColNames.has("pricing_status")) {
    db.exec("ALTER TABLE paddy_purchases ADD COLUMN pricing_status TEXT NOT NULL DEFAULT 'PRICED'");
  }
  const pepCols = db.prepare("PRAGMA table_info(production_expense_payments)").all();
  const pepColNames = new Set(pepCols.map((c) => c.name));
  if (!pepColNames.has("receipt_no")) {
    db.exec("ALTER TABLE production_expense_payments ADD COLUMN receipt_no TEXT");
    const existingPeps = db.prepare("SELECT id FROM production_expense_payments WHERE receipt_no IS NULL ORDER BY id ASC").all();
    const updPep = db.prepare("UPDATE production_expense_payments SET receipt_no = ? WHERE id = ?");
    for (const row of existingPeps) {
      updPep.run(`EXPR-2026-${String(row.id).padStart(4, "0")}`, row.id);
    }
  }
  const lotCols2 = db.prepare("PRAGMA table_info(inventory_lots)").all();
  const lotColNames2 = new Set(lotCols2.map((c) => c.name));
  if (!lotColNames2.has("origin_batch_id")) {
    db.exec("ALTER TABLE inventory_lots ADD COLUMN origin_batch_id INTEGER");
    db.exec("UPDATE inventory_lots SET origin_batch_id = source_id WHERE source_type = 'PRODUCTION_OUTPUT' AND origin_batch_id IS NULL");
  }
  const outCols2 = db.prepare("PRAGMA table_info(production_outputs)").all();
  const outColNames2 = new Set(outCols2.map((c) => c.name));
  if (!outColNames2.has("rate_per_bag")) {
    db.exec("ALTER TABLE production_outputs ADD COLUMN rate_per_bag REAL NOT NULL DEFAULT 0");
    db.exec("UPDATE production_outputs SET rate_per_bag = CASE WHEN bag_count > 0 THEN ROUND(total_value / bag_count, 2) ELSE 0 END WHERE rate_per_bag = 0");
  }
  const psCols = db.prepare("PRAGMA table_info(paddy_sales)").all();
  const psColNames = new Set(psCols.map((c) => c.name));
  if (!psColNames.has("challan_no")) {
    db.exec("ALTER TABLE paddy_sales ADD COLUMN challan_no TEXT");
  }
  if (!psColNames.has("bag_count")) {
    db.exec("ALTER TABLE paddy_sales ADD COLUMN bag_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!psColNames.has("jute_bag_count")) {
    db.exec("ALTER TABLE paddy_sales ADD COLUMN jute_bag_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!psColNames.has("plastic_bag_count")) {
    db.exec("ALTER TABLE paddy_sales ADD COLUMN plastic_bag_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!psColNames.has("moisture_pct")) {
    db.exec("ALTER TABLE paddy_sales ADD COLUMN moisture_pct REAL NOT NULL DEFAULT 14");
  }
  if (!psColNames.has("scale_weight_kg")) {
    db.exec("ALTER TABLE paddy_sales ADD COLUMN scale_weight_kg REAL NOT NULL DEFAULT 0");
    db.exec("UPDATE paddy_sales SET scale_weight_kg = qty_kg WHERE scale_weight_kg = 0");
  }
  if (!psColNames.has("payment_weight_kg")) {
    db.exec("ALTER TABLE paddy_sales ADD COLUMN payment_weight_kg REAL NOT NULL DEFAULT 0");
    db.exec("UPDATE paddy_sales SET payment_weight_kg = qty_kg WHERE payment_weight_kg = 0");
  }
  if (!psColNames.has("weight_loss_kg")) {
    db.exec("ALTER TABLE paddy_sales ADD COLUMN weight_loss_kg REAL NOT NULL DEFAULT 0");
  }
  if (!psColNames.has("settlement_unit_kg")) {
    db.exec("ALTER TABLE paddy_sales ADD COLUMN settlement_unit_kg REAL NOT NULL DEFAULT 75.5");
  }
  if (!psColNames.has("settlement_rate")) {
    db.exec("ALTER TABLE paddy_sales ADD COLUMN settlement_rate REAL NOT NULL DEFAULT 0");
    db.exec("UPDATE paddy_sales SET settlement_rate = ROUND(rate_per_kg * 75.5, 2) WHERE settlement_rate = 0");
  }
  if (!psColNames.has("notes")) {
    db.exec("ALTER TABLE paddy_sales ADD COLUMN notes TEXT");
  }
  const siiCols = db.prepare("PRAGMA table_info(sales_invoice_items)").all();
  const siiColNames = new Set(siiCols.map((c) => c.name));
  if (!siiColNames.has("bag_count")) {
    db.exec("ALTER TABLE sales_invoice_items ADD COLUMN bag_count INTEGER NOT NULL DEFAULT 0");
  }
  if (!siiColNames.has("pack_size_kg")) {
    db.exec("ALTER TABLE sales_invoice_items ADD COLUMN pack_size_kg REAL NOT NULL DEFAULT 50");
  }
  if (!siiColNames.has("rate_per_bag")) {
    db.exec("ALTER TABLE sales_invoice_items ADD COLUMN rate_per_bag REAL NOT NULL DEFAULT 0");
  }
  const empCount = db.prepare("SELECT COUNT(*) as c FROM employees").get().c;
  if (empCount === 0) {
    seedInitialData();
    seedMasterCatalogDefaults();
  } else {
    db.prepare(
      "INSERT OR IGNORE INTO accounts (account_code, name, account_type, balance, is_system) VALUES ('2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0, 1)"
    ).run();
  }
  ensureGodownKeeperRoleAndUser();
}
function ensureGodownKeeperRoleAndUser() {
  db.prepare(
    "INSERT OR IGNORE INTO roles (code, name, description) VALUES ('GODOWN_KEEPER', 'Godown Keeper (\u0997\u09CB\u09A1\u09BE\u0989\u09A8 \u0995\u09BF\u09AA\u09BE\u09B0)', 'Physical paddy intake, bag ledger, godown stock & transfers only (no monetary access)')"
  ).run();
  const gkRole = db.prepare("SELECT id FROM roles WHERE code = 'GODOWN_KEEPER'").get();
  if (!gkRole) return;
  const gkPermKeys = ["dashboard.view", "paddy.purchase.create", "stock.transfer", "weighbridge.operate", "qr.scan"];
  const getPermId = db.prepare("SELECT id FROM permissions WHERE perm_key = ?");
  const insertRp = db.prepare("INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)");
  for (const key of gkPermKeys) {
    const p = getPermId.get(key);
    if (p) insertRp.run(gkRole.id, p.id);
  }
  const existingGkEmp = db.prepare("SELECT id FROM employees WHERE role_id = ? LIMIT 1").get(gkRole.id);
  if (!existingGkEmp) {
    const hash = bcrypt.hashSync("Mill@2026", 10);
    db.prepare(
      "INSERT OR IGNORE INTO employees (employee_code, full_name, email, phone, password_hash, role_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("EMP-006", "\u09B0\u09A4\u09A8 \u09AE\u09A3\u09CD\u09A1\u09B2 (\u0997\u09CB\u09A1\u09BE\u0989\u09A8 \u0995\u09BF\u09AA\u09BE\u09B0)", "godown@sonagrain.com", "+880 1711-000606", hash, gkRole.id);
  }
}
function seedMasterCatalogDefaults() {
  const unitCount = db.prepare("SELECT COUNT(*) as c FROM product_units").get().c;
  if (unitCount === 0) {
    const insertUnit = db.prepare(
      "INSERT INTO product_units (code, name, symbol, base_weight_kg, description, is_active) VALUES (?, ?, ?, ?, ?, 1)"
    );
    insertUnit.run("KG", "Kilogram", "kg", 1, "Standard base weight unit for weighbridge and stock valuation");
    insertUnit.run("BAG", "Standard Mill Bag (50 kg)", "bag", 50, "Packed rice and bran sack equivalent to 50 kg");
    insertUnit.run("PADBAG", "Paddy Gunny Sack (60 kg)", "sack", 60, "Raw paddy farm arrival jute sack");
    insertUnit.run("QTL", "Quintal", "qtl", 100, "Wholesale grain trading unit (100 kg)");
    insertUnit.run("MT", "Metric Ton", "MT", 1e3, "Bulk mill capacity & institutional dispatch unit (1,000 kg)");
  }
  const catCount = db.prepare("SELECT COUNT(*) as c FROM product_categories").get().c;
  if (catCount === 0) {
    const insertCat = db.prepare(
      "INSERT INTO product_categories (code, name, group_type, default_costing_method, description, is_active) VALUES (?, ?, ?, ?, ?, 1)"
    );
    insertCat.run("PADDY", "Raw Paddy", "RAW_MATERIAL", "FIFO", "Unmilled farm paddy varieties procured for drying or milling");
    insertCat.run("HEAD_RICE", "Head Rice", "FINISHED_GOOD", "FIFO", "Whole parboiled (Siddho) and raw (Atap) finished rice");
    insertCat.run("BROKEN_RICE", "Broken Rice (Khud)", "BY_PRODUCT", "WEIGHTED_AVERAGE", "Grading broken rice fractions from milling");
    insertCat.run("RICE_BRAN", "Rice Bran (Kura)", "BY_PRODUCT", "WEIGHTED_AVERAGE", "Polishing bran sold to solvent oil extraction mills");
    insertCat.run("HUSK", "Paddy Husk (Tush)", "BY_PRODUCT", "WEIGHTED_AVERAGE", "Hulling husk used for parboiling boilers and sale");
  }
}
function seedInitialData() {
  const tx = db.transaction(() => {
    const insertRole = db.prepare("INSERT INTO roles (id, code, name, description) VALUES (?, ?, ?, ?)");
    insertRole.run(1, "OWNER", "Mill Owner / Admin", "Full unrestricted access including financial overrides, backups, and RBAC");
    insertRole.run(2, "MANAGER", "Mill Manager", "Operations across godowns, purchases, drying, milling, and sales");
    insertRole.run(3, "WEIGHBRIDGE", "Weighbridge Operator", "Paddy purchase weigh-ins, weight discrepancy logging, and QR tagging");
    insertRole.run(4, "PRODUCTION", "Production Supervisor", "Drying batches, Siddho/Atap production runs, and cost sheets");
    insertRole.run(5, "ACCOUNTANT", "Chief Accountant", "Cash/bank vouchers, party payments, financial reports, and audit logs");
    insertRole.run(6, "SALES", "Sales & Dispatch Officer", "Direct paddy sales, rice & by-product invoicing, and gate-pass QR");
    insertRole.run(7, "GODOWN_KEEPER", "Godown Keeper (\u0997\u09CB\u09A1\u09BE\u0989\u09A8 \u0995\u09BF\u09AA\u09BE\u09B0)", "Physical paddy intake, bag ledger, godown stock & transfers only (no monetary access)");
    const perms = [
      ["dashboard.view", "Dashboard", "View executive analytics and KPIs"],
      ["paddy.purchase.create", "Procurement", "Record paddy purchases and weighbridge entries"],
      ["stock.transfer", "Inventory", "Execute inter-godown stock transfers"],
      ["paddy.sale.create", "Sales", "Execute direct paddy sales without milling"],
      ["drying.manage", "Drying", "Create and complete paddy drying cycles"],
      ["production.manage", "Production", "Manage Siddho & Atap milling batches and cost sheets"],
      ["rice.sale.create", "Sales", "Create rice and by-product sales invoices"],
      ["weighbridge.operate", "Weighbridge", "Operate digital/manual weighbridge scale"],
      ["qr.scan", "Traceability", "Scan and inspect QR lot traceability"],
      ["parties.manage", "Parties", "Manage suppliers and customers"],
      ["accounting.view", "Accounting", "View cash, bank, and trial balance ledgers"],
      ["accounting.post", "Accounting", "Post payments, receipts, and journal vouchers"],
      ["employees.manage", "Admin", "Create/update employees and role permissions"],
      ["reports.export", "Reports", "Export PDF and Excel reports"],
      ["audit.view", "Security", "View immutable audit logs"],
      ["backup.manage", "Security", "Create and restore database backups"]
    ];
    const insertPerm = db.prepare("INSERT INTO permissions (id, perm_key, module, description) VALUES (?, ?, ?, ?)");
    const insertRp = db.prepare("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)");
    perms.forEach((p, idx) => {
      const pid = idx + 1;
      insertPerm.run(pid, p[0], p[1], p[2]);
      insertRp.run(1, pid);
      if (!["employees.manage", "backup.manage"].includes(p[0])) insertRp.run(2, pid);
      if (["dashboard.view", "paddy.purchase.create", "weighbridge.operate", "qr.scan"].includes(p[0])) insertRp.run(3, pid);
      if (["dashboard.view", "drying.manage", "production.manage", "stock.transfer", "qr.scan"].includes(p[0])) insertRp.run(4, pid);
      if (["dashboard.view", "accounting.view", "accounting.post", "parties.manage", "reports.export", "audit.view"].includes(p[0])) insertRp.run(5, pid);
      if (["dashboard.view", "paddy.sale.create", "rice.sale.create", "parties.manage", "qr.scan", "reports.export"].includes(p[0])) insertRp.run(6, pid);
      if (["dashboard.view", "paddy.purchase.create", "stock.transfer", "weighbridge.operate", "qr.scan"].includes(p[0])) insertRp.run(7, pid);
    });
    const adminHash = bcrypt.hashSync("admin", 10);
    const hash = bcrypt.hashSync("Mill@2026", 10);
    const insertEmp = db.prepare(
      "INSERT INTO employees (id, employee_code, full_name, email, phone, password_hash, role_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    insertEmp.run(1, "EMP-001", "Admin", "admin@gmail.com", "+880 1711-000000", adminHash, 1);
    insertEmp.run(2, "EMP-002", "Suman Das", "weighbridge@sonagrain.com", "+91 98300 11002", hash, 3);
    insertEmp.run(3, "EMP-003", "Prakash Sen", "production@sonagrain.com", "+91 98300 11003", hash, 4);
    insertEmp.run(4, "EMP-004", "Meera Chatterjee", "accounts@sonagrain.com", "+91 98300 11004", hash, 5);
    insertEmp.run(5, "EMP-005", "Debashis Paul", "sales@sonagrain.com", "+91 98300 11005", hash, 6);
    insertEmp.run(6, "EMP-006", "\u09B0\u09A4\u09A8 \u09AE\u09A3\u09CD\u09A1\u09B2 (\u0997\u09CB\u09A1\u09BE\u0989\u09A8 \u0995\u09BF\u09AA\u09BE\u09B0)", "godown@sonagrain.com", "+880 1711-000606", hash, 7);
    const insertAcc = db.prepare("INSERT INTO accounts (id, account_code, name, account_type, balance) VALUES (?, ?, ?, ?, ?)");
    insertAcc.run(1, "1001", "Cash in Hand (Mill Counter)", "ASSET", 0);
    insertAcc.run(2, "1002", "State Bank Current A/C", "ASSET", 0);
    insertAcc.run(3, "1100", "Accounts Receivable (Customers)", "ASSET", 0);
    insertAcc.run(4, "1200", "Paddy & Rice Inventory", "ASSET", 0);
    insertAcc.run(5, "2001", "Accounts Payable (Suppliers)", "LIABILITY", 0);
    insertAcc.run(6, "3001", "Owner Capital Equity", "EQUITY", 0);
    insertAcc.run(7, "4001", "Rice & By-Product Sales Revenue", "REVENUE", 0);
    insertAcc.run(8, "4002", "Direct Paddy Sales Revenue", "REVENUE", 0);
    insertAcc.run(9, "5001", "Cost of Goods Sold (COGS)", "EXPENSE", 0);
    insertAcc.run(10, "5100", "Milling Power, Fuel & Labor Expense", "EXPENSE", 0);
    insertAcc.run(11, "5200", "Weight Discrepancy & Drying Variance", "EXPENSE", 0);
    insertAcc.run(12, "5300", "Transport, Freight & Loading Expense", "EXPENSE", 0);
    insertAcc.run(13, "5400", "Mill Rent, Office & Admin Expense", "EXPENSE", 0);
    insertAcc.run(14, "2002", "Accrued Milling & Vendor Expenses Payable", "LIABILITY", 0);
  });
  tx();
}

// server/services/erpEngine.ts
import crypto2 from "crypto";
var InsufficientStockError = class extends Error {
  constructor(message, availableKg, requestedKg) {
    super(message);
    this.name = "InsufficientStockError";
    this.availableKg = availableKg;
    this.requestedKg = requestedKg;
  }
};
function consumeWarehouseStock(params) {
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
    employeeId
  } = params;
  if (qtyKg <= 0) {
    throw new Error("Quantity must be greater than zero");
  }
  let lots = db.prepare(
    `SELECT l.*, COALESCE(NULLIF(l.pack_size_kg, 0), NULLIF(i.bag_weight_kg, 0), 50) as resolved_pack_kg
       FROM inventory_lots l
       JOIN items i ON i.id = l.item_id
       WHERE l.item_id = ? AND l.warehouse_id = ? AND l.remaining_qty_kg > 0.0001
       ORDER BY datetime(l.received_at) ASC, l.id ASC`
  ).all(itemId, warehouseId);
  if (preferredLotId) {
    lots = lots.filter((l) => l.id === preferredLotId);
  } else if (preferredBatchId) {
    lots = lots.sort((a, b) => {
      const aOrigin = a.origin_batch_id ?? (a.source_type === "PRODUCTION_OUTPUT" ? a.source_id : null);
      const bOrigin = b.origin_batch_id ?? (b.source_type === "PRODUCTION_OUTPUT" ? b.source_id : null);
      const aMatch = Number(aOrigin) === preferredBatchId ? 0 : 1;
      const bMatch = Number(bOrigin) === preferredBatchId ? 0 : 1;
      return aMatch - bMatch;
    });
  }
  const totalAvailable = lots.reduce((sum, l) => sum + Number(l.remaining_qty_kg), 0);
  if (totalAvailable + 1e-4 < qtyKg) {
    const itemRow = db.prepare("SELECT name FROM items WHERE id = ?").get(itemId);
    const whRow = db.prepare("SELECT name FROM warehouses WHERE id = ?").get(warehouseId);
    throw new InsufficientStockError(
      `Insufficient stock for ${itemRow?.name ?? "Item"} in ${whRow?.name ?? "Warehouse"}: Available ${totalAvailable.toFixed(2)} kg, Requested ${qtyKg.toFixed(2)} kg.`,
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
  const consumedLots = [];
  const updateLotStmt = db.prepare(
    "UPDATE inventory_lots SET remaining_qty_kg = ?, remaining_bags = ?, version = version + 1 WHERE id = ? AND version = ?"
  );
  const insertLedgerStmt = db.prepare(
    `INSERT INTO stock_ledger (
      lot_id, item_id, warehouse_id, movement_type, reference_type, reference_id,
      qty_change_kg, unit_cost_per_kg, total_cost, balance_after_kg, employee_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i];
    if (remainingToConsume <= 1e-4) break;
    const take = Math.min(Number(lot.remaining_qty_kg), remainingToConsume);
    const effectiveRate = costingMethod === "WEIGHTED_AVERAGE" ? weightedAvgRate : Number(lot.unit_cost_per_kg);
    const lineCost = take * effectiveRate;
    const newRemaining = Math.max(0, Number((Number(lot.remaining_qty_kg) - take).toFixed(4)));
    const curBags = Number(lot.remaining_bags || 0);
    let bagsTaken = 0;
    let newRemainingBags = 0;
    if (curBags > 0) {
      if (bagCount && bagCount > 0) {
        const isLastTake = remainingToConsume - take <= 1e-4 || i === lots.length - 1;
        bagsTaken = isLastTake ? Math.min(curBags, remainingBagsToConsume) : Math.min(curBags, Math.round(take / qtyKg * bagCount));
        remainingBagsToConsume = Math.max(0, remainingBagsToConsume - bagsTaken);
        newRemainingBags = newRemaining > 1e-4 ? Math.max(0, curBags - bagsTaken) : 0;
      } else {
        bagsTaken = Math.min(curBags, Math.round(take / Number(lot.remaining_qty_kg) * curBags));
        newRemainingBags = newRemaining > 1e-4 ? Math.max(0, curBags - bagsTaken) : 0;
      }
    }
    const res = updateLotStmt.run(newRemaining, newRemainingBags, lot.id, lot.version);
    if (res.changes === 0) {
      throw new Error(`Concurrency conflict on lot ${lot.lot_code}. Please retry.`);
    }
    insertLedgerStmt.run(
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
      origin_batch_id: lot.origin_batch_id ?? (lot.source_type === "PRODUCTION_OUTPUT" ? lot.source_id : null),
      pack_size_kg: Number(lot.resolved_pack_kg || 50),
      bags_taken: bagsTaken,
      qty_taken_kg: take,
      unit_cost_per_kg: effectiveRate,
      cost_amount: lineCost
    });
    totalCost += lineCost;
    remainingToConsume -= take;
  }
  return {
    totalCost: Number(totalCost.toFixed(2)),
    avgUnitCost: Number((totalCost / qtyKg).toFixed(4)),
    consumedLots
  };
}
function createInventoryLot(params) {
  const qrCodeUid = params.qrUid ?? crypto2.randomUUID();
  const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM inventory_lots").get().nextId;
  const lotCode = `${params.prefix}-${String(seq).padStart(4, "0")}`;
  const itemInfo = db.prepare("SELECT bag_weight_kg FROM items WHERE id = ?").get(params.itemId);
  const bagWeight = params.packSizeKg && params.packSizeKg > 0 ? params.packSizeKg : itemInfo?.bag_weight_kg && itemInfo.bag_weight_kg > 0 ? itemInfo.bag_weight_kg : 50;
  const resolvedBags = params.bagCount !== void 0 && params.bagCount >= 0 ? Math.round(params.bagCount) : Math.round(params.qtyKg / bagWeight);
  const resolvedOriginBatchId = params.originBatchId !== void 0 ? params.originBatchId : params.sourceType === "PRODUCTION_OUTPUT" ? params.sourceId : null;
  const info = db.prepare(
    `INSERT INTO inventory_lots (
        lot_code, qr_code_uid, item_id, warehouse_id, source_type, source_id, origin_batch_id,
        initial_qty_kg, remaining_qty_kg, initial_bags, remaining_bags, pack_size_kg, unit_cost_per_kg, moisture_pct
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lotCode,
    qrCodeUid,
    params.itemId,
    params.warehouseId,
    params.sourceType,
    params.sourceId,
    resolvedOriginBatchId,
    params.qtyKg,
    params.qtyKg,
    resolvedBags,
    resolvedBags,
    bagWeight,
    params.unitCostPerKg,
    params.moisturePct ?? null
  );
  const lotId = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO stock_ledger (
      lot_id, item_id, warehouse_id, movement_type, reference_type, reference_id,
      qty_change_kg, unit_cost_per_kg, total_cost, balance_after_kg, employee_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    lotId,
    params.itemId,
    params.warehouseId,
    params.movementType,
    params.sourceType,
    params.sourceId,
    params.qtyKg,
    params.unitCostPerKg,
    Number((params.qtyKg * params.unitCostPerKg).toFixed(2)),
    params.qtyKg,
    params.employeeId
  );
  return { lotId, lotCode, qrCodeUid };
}
function postJournalEntry(params) {
  const totalDebit = params.lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = params.lines.reduce((s, l) => s + l.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > 0.05) {
    throw new Error(`Unbalanced journal entry: Debit ${totalDebit.toFixed(2)} != Credit ${totalCredit.toFixed(2)}`);
  }
  const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM journal_entries").get().nextId;
  const prefix = params.voucherPrefix || "JV";
  const voucherNo = `${prefix}-2026-${String(seq).padStart(4, "0")}`;
  const entryDate = params.entryDate || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  const info = db.prepare(
    `INSERT INTO journal_entries (client_uuid, voucher_no, entry_date, description, reference_type, reference_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(params.clientUuid ?? crypto2.randomUUID(), voucherNo, entryDate, params.description, params.referenceType, params.referenceId, params.employeeId);
  const jeId = Number(info.lastInsertRowid);
  const getAcc = db.prepare("SELECT id, account_type FROM accounts WHERE account_code = ?");
  const insertLine = db.prepare("INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, party_id) VALUES (?, ?, ?, ?, ?)");
  const updateAcc = db.prepare("UPDATE accounts SET balance = balance + ? WHERE id = ?");
  for (const line of params.lines) {
    if (line.debit === 0 && line.credit === 0) continue;
    const acc = getAcc.get(line.accountCode);
    if (!acc) throw new Error(`Account code ${line.accountCode} not found`);
    insertLine.run(jeId, acc.id, Number(line.debit.toFixed(2)), Number(line.credit.toFixed(2)), line.partyId ?? null);
    const delta = acc.account_type === "ASSET" || acc.account_type === "EXPENSE" ? line.debit - line.credit : line.credit - line.debit;
    updateAcc.run(Number(delta.toFixed(2)), acc.id);
  }
  return jeId;
}
function writeAuditLog(params) {
  db.prepare(
    `INSERT INTO audit_logs (employee_id, employee_name, action, entity_type, entity_id, before_json, after_json, ip_address, device_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    params.employeeId ?? null,
    params.employeeName,
    params.action,
    params.entityType,
    params.entityId,
    params.beforeObj ? JSON.stringify(params.beforeObj) : null,
    params.afterObj ? JSON.stringify(params.afterObj) : null,
    params.ipAddress ?? "127.0.0.1",
    params.deviceType ?? "WEB_PWA"
  );
}
function registerQrTag(params) {
  db.prepare(
    `INSERT OR REPLACE INTO qr_tags (qr_code_uid, entity_type, entity_id, entity_code, payload_json)
     VALUES (?, ?, ?, ?, ?)`
  ).run(params.qrCodeUid, params.entityType, params.entityId, params.entityCode, JSON.stringify(params.payload));
}
function checkIdempotency(clientUuid) {
  if (!clientUuid) return { duplicate: false };
  const row = db.prepare("SELECT status, response_json FROM sync_logs WHERE client_uuid = ?").get(clientUuid);
  if (row && (row.status === "SYNCED" || row.status === "DUPLICATE_SKIPPED")) {
    return {
      duplicate: true,
      cachedResponse: row.response_json ? JSON.parse(row.response_json) : { status: "ALREADY_SYNCED", client_uuid: clientUuid }
    };
  }
  return { duplicate: false };
}
function recordSyncLog(params) {
  db.prepare(
    `INSERT OR REPLACE INTO sync_logs (client_uuid, device_id, client_type, endpoint, status, conflict_reason, response_json, employee_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
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

// server.ts
dotenv.config();
initDatabase();
var JWT_SECRET = process.env.JWT_SECRET || "sonagrain-enterprise-secret-2026-change-in-prod";
var PORT = 3e3;
function getEmployeeWithPermissions(employeeId) {
  const emp = db.prepare(
    `SELECT e.id, e.employee_code, e.full_name, e.email, e.role_id, e.is_active,
              r.code as role_code, r.name as role_name
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       WHERE e.id = ?`
  ).get(employeeId);
  if (!emp || !emp.is_active) return null;
  const permRows = db.prepare(
    `SELECT p.perm_key FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ?`
  ).all(emp.role_id);
  return {
    id: emp.id,
    employee_code: emp.employee_code,
    full_name: emp.full_name,
    email: emp.email,
    role_id: emp.role_id,
    role_code: emp.role_code,
    role_name: emp.role_name,
    permissions: permRows.map((p) => p.perm_key)
  };
}
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authentication token required" });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = getEmployeeWithPermissions(decoded.sub);
    if (!user) {
      res.status(401).json({ error: "Employee account is inactive or missing" });
      return;
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session token" });
  }
}
function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (req.user.role_code === "OWNER" || req.user.permissions.includes(perm)) {
      next();
      return;
    }
    writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: "PERMISSION_DENIED",
      entityType: "API_ENDPOINT",
      entityId: req.originalUrl,
      afterObj: { required_permission: perm },
      ipAddress: req.ip
    });
    res.status(403).json({ error: `Permission denied: requires ${perm}` });
  };
}
function isPhysicalOnlyUser(user) {
  return user?.role_code === "GODOWN_KEEPER";
}
function rejectPhysicalOnlyUser(req, res, message = "Financial and commercial records are restricted for Godown Keeper role") {
  if (isPhysicalOnlyUser(req.user)) {
    res.status(403).json({ error: message });
    return true;
  }
  return false;
}
function sanitizePurchaseForPhysical(p) {
  const splits = Array.isArray(p.splits) ? p.splits.map((s) => ({
    ...s,
    allocated_amount: 0
  })) : [];
  const returnLogs = Array.isArray(p.return_logs) ? p.return_logs.map((r) => ({
    ...r,
    return_amount: 0,
    account_id: null,
    account_name: ""
  })) : [];
  return {
    ...p,
    settlement_rate: 0,
    rate_per_kg: 0,
    total_payable: 0,
    paid_amount: 0,
    returned_amount: 0,
    payment_status: "UNPAID",
    split_summary_json: null,
    splits,
    return_logs: returnLogs
  };
}
function sanitizeQrPayloadForPhysical(obj) {
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeQrPayloadForPhysical(item));
  }
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/amount|cost|rate|price|payable|paid|profit|loss|revenue|balance|value|budget|valuation|expense/i.test(k)) {
        continue;
      }
      out[k] = sanitizeQrPayloadForPhysical(v);
    }
    return out;
  }
  return obj;
}
var app = express();
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", "*");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Client-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});
var SPEED_PROBE_BUFFER = crypto3.randomBytes(1024 * 1024);
app.get("/api/v1/health", (_req, res) => {
  res.json({ status: "ok", api_version: "1.0.0", engine: "SonaGrain-Node-Parity", timestamp: (/* @__PURE__ */ new Date()).toISOString() });
});
app.get("/api/v1/speed-probe", (req, res) => {
  const reqBytes = Number(req.query.bytes ?? 131072);
  const byteLen = Number.isFinite(reqBytes) ? Math.max(0, Math.min(1048576, Math.round(reqBytes))) : 131072;
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Length", String(byteLen));
  if (byteLen === 0) {
    res.status(200).end();
    return;
  }
  res.status(200).send(SPEED_PROBE_BUFFER.subarray(0, byteLen));
});
app.post("/api/v1/auth/login", (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  const emp = db.prepare("SELECT id, password_hash, is_active FROM employees WHERE email = ?").get(email.trim().toLowerCase());
  if (!emp || !emp.is_active || !bcrypt2.compareSync(password, emp.password_hash)) {
    res.status(401).json({ error: "Invalid employee credentials" });
    return;
  }
  db.prepare("UPDATE employees SET last_login_at = datetime('now') WHERE id = ?").run(emp.id);
  const user = getEmployeeWithPermissions(emp.id);
  const token = jwt.sign({ sub: user.id, role: user.role_code }, JWT_SECRET, { expiresIn: "24h" });
  writeAuditLog({
    employeeId: user.id,
    employeeName: user.full_name,
    action: "LOGIN",
    entityType: "EMPLOYEE",
    entityId: user.employee_code,
    ipAddress: req.ip,
    deviceType: req.headers["x-client-type"] || "WEB_PWA"
  });
  res.json({ token, user });
});
app.get("/api/v1/auth/me", authenticate, (req, res) => {
  res.json({ user: req.user });
});
app.post("/api/v1/auth/change-password", authenticate, (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    res.status(400).json({ error: "Current password and new password are required" });
    return;
  }
  const cleanNew = new_password.trim();
  if (cleanNew.length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters" });
    return;
  }
  const emp = db.prepare("SELECT id, employee_code, password_hash, is_active FROM employees WHERE id = ?").get(req.user.id);
  if (!emp || !emp.is_active) {
    res.status(404).json({ error: "Employee account not found or inactive" });
    return;
  }
  if (!bcrypt2.compareSync(current_password, emp.password_hash)) {
    res.status(401).json({ error: "Current password is incorrect" });
    return;
  }
  const nextHash = bcrypt2.hashSync(cleanNew, 10);
  db.prepare("UPDATE employees SET password_hash = ? WHERE id = ?").run(nextHash, emp.id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: "CHANGE_PASSWORD",
    entityType: "EMPLOYEE",
    entityId: emp.employee_code,
    ipAddress: req.ip,
    deviceType: req.headers["x-client-type"] || "WEB_PWA"
  });
  res.json({ status: "ok" });
});
app.get("/api/v1/dashboard", authenticate, (req, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const lots = db.prepare(
    `SELECT l.*, i.category, i.name as item_name
       FROM inventory_lots l
       JOIN items i ON i.id = l.item_id
       WHERE l.remaining_qty_kg > 0`
  ).all();
  let paddyKg = 0;
  let riceKg = 0;
  let bypKg = 0;
  let valuation = 0;
  const whStats = /* @__PURE__ */ new Map();
  for (const lot of lots) {
    const qty = Number(lot.remaining_qty_kg);
    const val = physicalOnly ? 0 : qty * Number(lot.unit_cost_per_kg);
    valuation += val;
    if (lot.category === "PADDY") paddyKg += qty;
    else if (lot.category === "HEAD_RICE") riceKg += qty;
    else bypKg += qty;
    const cur = whStats.get(lot.warehouse_id) ?? { qty: 0, val: 0 };
    cur.qty += qty;
    cur.val += val;
    whStats.set(lot.warehouse_id, cur);
  }
  const warehouses = db.prepare("SELECT * FROM warehouses WHERE is_active = 1").all();
  const warehouseUtilization = warehouses.map((w) => {
    const s = whStats.get(w.id) ?? { qty: 0, val: 0 };
    return {
      ...w,
      current_stock_kg: Number(s.qty.toFixed(2)),
      valuation: physicalOnly ? 0 : Number(s.val.toFixed(2))
    };
  });
  const purAgg = db.prepare("SELECT COALESCE(SUM(total_payable), 0) as total, COALESCE(SUM(discrepancy_flagged), 0) as flagged FROM paddy_purchases").get();
  const riceSalesAgg = physicalOnly ? { rev: 0, cogs: 0 } : db.prepare("SELECT COALESCE(SUM(total_amount), 0) as rev, COALESCE(SUM(total_cogs), 0) as cogs FROM sales_invoices").get();
  const paddySalesAgg = physicalOnly ? { rev: 0, cogs: 0 } : db.prepare("SELECT COALESCE(SUM(total_amount), 0) as rev, COALESCE(SUM(cogs_amount), 0) as cogs FROM paddy_sales").get();
  const cashBankAgg = physicalOnly ? { bal: 0 } : db.prepare("SELECT COALESCE(SUM(balance), 0) as bal FROM accounts WHERE account_code IN ('1001', '1002')").get();
  const batchAgg = physicalOnly ? { siddho_batches: 0, atap_batches: 0, avg_yield: 0, total_milled: 0 } : db.prepare(
    `SELECT
            SUM(CASE WHEN process_type = 'PARBOILED_SIDDHO' THEN 1 ELSE 0 END) as siddho_batches,
            SUM(CASE WHEN process_type = 'RAW_ATAP' THEN 1 ELSE 0 END) as atap_batches,
            COALESCE(AVG(head_rice_yield_pct), 0) as avg_yield,
            COALESCE(SUM(input_paddy_qty_kg), 0) as total_milled
           FROM production_batches`
  ).get();
  const recentPurchasesRaw = db.prepare(
    `SELECT p.*, pt.name as supplier_name, w.name as warehouse_name, i.name as item_name
       FROM paddy_purchases p
       JOIN parties pt ON pt.id = p.supplier_id
       JOIN warehouses w ON w.id = p.warehouse_id
       JOIN items i ON i.id = p.item_id
       ORDER BY p.id DESC LIMIT 5`
  ).all();
  const recentPurchases = physicalOnly ? recentPurchasesRaw.map((p) => sanitizePurchaseForPhysical(p)) : recentPurchasesRaw;
  const recentBatches = physicalOnly ? [] : db.prepare(
    `SELECT b.*, i.name as paddy_item_name, w.name as source_warehouse_name,
                  cs.net_head_rice_cost, cs.cost_per_kg_head_rice
           FROM production_batches b
           JOIN items i ON i.id = b.paddy_item_id
           JOIN warehouses w ON w.id = b.source_warehouse_id
           LEFT JOIN production_cost_sheets cs ON cs.batch_id = b.id
           ORDER BY b.id DESC LIMIT 5`
  ).all();
  const recentSales = physicalOnly ? [] : db.prepare(
    `SELECT s.*, pt.name as customer_name
           FROM sales_invoices s
           JOIN parties pt ON pt.id = s.customer_id
           ORDER BY s.id DESC LIMIT 5`
  ).all();
  const totalRev = Number(riceSalesAgg.rev) + Number(paddySalesAgg.rev);
  const totalCogs = Number(riceSalesAgg.cogs) + Number(paddySalesAgg.cogs);
  res.json({
    kpis: {
      total_paddy_stock_kg: Number(paddyKg.toFixed(2)),
      total_rice_stock_kg: Number(riceKg.toFixed(2)),
      total_byproduct_stock_kg: Number(bypKg.toFixed(2)),
      inventory_valuation: physicalOnly ? 0 : Number(valuation.toFixed(2)),
      monthly_purchases: physicalOnly ? 0 : Number(purAgg.total.toFixed(2)),
      monthly_sales: physicalOnly ? 0 : Number(totalRev.toFixed(2)),
      monthly_gross_profit: physicalOnly ? 0 : Number((totalRev - totalCogs).toFixed(2)),
      flagged_weight_discrepancies: Number(purAgg.flagged),
      cash_and_bank_balance: physicalOnly ? 0 : Number(cashBankAgg.bal.toFixed(2))
    },
    warehouse_utilization: warehouseUtilization,
    production_summary: {
      siddho_batches: Number(batchAgg.siddho_batches || 0),
      atap_batches: Number(batchAgg.atap_batches || 0),
      avg_head_rice_yield_pct: Number((batchAgg.avg_yield || 0).toFixed(2)),
      total_paddy_milled_kg: Number((batchAgg.total_milled || 0).toFixed(2))
    },
    recent_purchases: recentPurchases,
    recent_batches: recentBatches,
    recent_sales: recentSales
  });
});
var ENRICHED_PARTIES_SQL = `
  SELECT pt.*,
    COALESCE((SELECT SUM(pp.total_payable) FROM paddy_purchases pp WHERE pp.supplier_id = pt.id), 0) as total_purchased,
    COALESCE((SELECT SUM(si.total_amount) FROM sales_invoices si WHERE si.customer_id = pt.id), 0)
      + COALESCE((SELECT SUM(ps.total_amount) FROM paddy_sales ps WHERE ps.customer_id = pt.id), 0) as total_sold,
    COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.party_id = pt.id AND pay.direction = 'PAYMENT'), 0)
      + COALESCE((SELECT SUM(pp.paid_amount) FROM paddy_purchases pp WHERE pp.supplier_id = pt.id), 0) as total_paid_out,
    COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.party_id = pt.id AND pay.direction = 'RECEIPT'), 0)
      + COALESCE((SELECT SUM(si.paid_amount) FROM sales_invoices si WHERE si.customer_id = pt.id), 0)
      + COALESCE((SELECT SUM(ps.paid_amount) FROM paddy_sales ps WHERE ps.customer_id = pt.id), 0) as total_received_in,
    COALESCE((SELECT SUM(MAX(0, pp.total_payable - pp.paid_amount)) FROM paddy_purchases pp WHERE pp.supplier_id = pt.id AND pp.payment_status != 'PAID'), 0) as open_purchase_due,
    COALESCE((SELECT SUM(MAX(0, si.total_amount - si.paid_amount)) FROM sales_invoices si WHERE si.customer_id = pt.id AND si.payment_status != 'PAID'), 0)
      + COALESCE((SELECT SUM(MAX(0, ps.total_amount - ps.paid_amount)) FROM paddy_sales ps WHERE ps.customer_id = pt.id AND ps.payment_status != 'PAID'), 0) as open_sales_due
  FROM parties pt
`;
app.get("/api/v1/master", authenticate, (req, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const warehouses = db.prepare(
    `SELECT w.*, COALESCE((SELECT SUM(l.remaining_qty_kg) FROM inventory_lots l WHERE l.warehouse_id = w.id), 0) as current_stock_kg
       FROM warehouses w ORDER BY w.id ASC`
  ).all();
  const units = db.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM items i WHERE i.unit = u.code) as product_count
       FROM product_units u ORDER BY u.id ASC`
  ).all();
  const categories = db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category = c.code) as product_count
       FROM product_categories c ORDER BY c.id ASC`
  ).all();
  const itemsRaw = db.prepare("SELECT * FROM items ORDER BY id ASC").all();
  const items = physicalOnly ? itemsRaw.map((i) => ({ ...i, default_rate: 0 })) : itemsRaw;
  const partiesRaw = db.prepare(`${ENRICHED_PARTIES_SQL} ORDER BY pt.name ASC`).all();
  const parties = physicalOnly ? partiesRaw.filter((p) => p.party_type === "SUPPLIER" || p.party_type === "BOTH").map((p) => ({
    ...p,
    credit_limit: 0,
    opening_balance: 0,
    current_balance: 0,
    total_purchased: 0,
    total_sold: 0,
    total_paid_out: 0,
    total_received_in: 0,
    open_purchase_due: 0,
    open_sales_due: 0
  })) : partiesRaw;
  const accounts = physicalOnly ? [] : db.prepare("SELECT * FROM accounts ORDER BY account_code ASC").all();
  const roles = db.prepare("SELECT * FROM roles ORDER BY id ASC").all();
  const company_settings = db.prepare("SELECT * FROM company_settings WHERE id = 1").get();
  res.json({ warehouses, units, categories, items, parties, accounts, roles, company_settings });
});
app.get("/api/v1/company-settings", (_req, res) => {
  const company = db.prepare("SELECT * FROM company_settings WHERE id = 1").get();
  res.json({ company });
});
app.put("/api/v1/company-settings", authenticate, (req, res) => {
  const roleCode = req.user?.role_code;
  const canManage = roleCode === "OWNER" || roleCode === "MANAGER" || (req.user?.permissions || []).includes("employees.manage");
  if (!canManage) {
    return res.status(403).json({ error: "Only Mill Owner or Manager can customize company profile settings" });
  }
  const body = req.body;
  const nameEn = String(body.company_name_en || "").trim();
  const nameBn = String(body.company_name_bn || "").trim() || nameEn;
  if (!nameEn && !nameBn) {
    return res.status(400).json({ error: "Company name is required" });
  }
  const existing = db.prepare("SELECT * FROM company_settings WHERE id = 1").get();
  const shortCode = String(body.short_code || "").trim().toUpperCase().slice(0, 4) || nameEn.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "SG";
  db.prepare(
    `INSERT INTO company_settings (id, company_name_en, company_name_bn, short_code, tagline_en, tagline_bn, address_en, address_bn, phone, email, tax_id, updated_at)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET
       company_name_en = excluded.company_name_en,
       company_name_bn = excluded.company_name_bn,
       short_code = excluded.short_code,
       tagline_en = excluded.tagline_en,
       tagline_bn = excluded.tagline_bn,
       address_en = excluded.address_en,
       address_bn = excluded.address_bn,
       phone = excluded.phone,
       email = excluded.email,
       tax_id = excluded.tax_id,
       updated_at = datetime('now')`
  ).run(
    nameEn || nameBn,
    nameBn || nameEn,
    shortCode,
    String(body.tagline_en || "").trim(),
    String(body.tagline_bn || "").trim(),
    String(body.address_en || "").trim(),
    String(body.address_bn || "").trim(),
    String(body.phone || "").trim(),
    String(body.email || "").trim(),
    String(body.tax_id || "").trim()
  );
  const updated = db.prepare("SELECT * FROM company_settings WHERE id = 1").get();
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: "COMPANY_SETTINGS_UPDATED",
    entityType: "COMPANY_SETTINGS",
    entityId: "1",
    beforeObj: existing,
    afterObj: updated
  });
  res.json({ company: updated });
});
app.post("/api/v1/warehouses", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const { code, name, warehouse_type, location, capacity_kg, is_active } = req.body;
  if (!code || !name || !warehouse_type) {
    res.status(400).json({ error: "Warehouse code, name, and type are required" });
    return;
  }
  try {
    const activeVal = is_active === void 0 ? 1 : is_active ? 1 : 0;
    const info = db.prepare("INSERT INTO warehouses (code, name, warehouse_type, location, capacity_kg, manager_employee_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)").run(code.trim().toUpperCase(), name.trim(), warehouse_type, location || "", Number(capacity_kg || 0), req.user.id, activeVal);
    const wh = db.prepare("SELECT *, 0 as current_stock_kg FROM warehouses WHERE id = ?").get(info.lastInsertRowid);
    writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: "CREATE_WAREHOUSE",
      entityType: "WAREHOUSE",
      entityId: String(info.lastInsertRowid),
      afterObj: wh
    });
    res.status(201).json({ warehouse: wh });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.put("/api/v1/warehouses/:id", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM warehouses WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Warehouse not found" });
    return;
  }
  const { code, name, warehouse_type, location, capacity_kg, is_active } = req.body;
  if (!code?.trim() || !name?.trim() || !warehouse_type) {
    res.status(400).json({ error: "Warehouse code, name, and type are required" });
    return;
  }
  try {
    const activeVal = is_active === void 0 ? existing.is_active : is_active ? 1 : 0;
    db.prepare(
      "UPDATE warehouses SET code = ?, name = ?, warehouse_type = ?, location = ?, capacity_kg = ?, is_active = ? WHERE id = ?"
    ).run(code.trim().toUpperCase(), name.trim(), warehouse_type, location || "", Number(capacity_kg || 0), activeVal, id);
    const updated = db.prepare(
      `SELECT w.*, COALESCE((SELECT SUM(l.remaining_qty_kg) FROM inventory_lots l WHERE l.warehouse_id = w.id), 0) as current_stock_kg
         FROM warehouses w WHERE w.id = ?`
    ).get(id);
    writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: "UPDATE_WAREHOUSE",
      entityType: "WAREHOUSE",
      entityId: String(id),
      beforeObj: existing,
      afterObj: updated
    });
    res.json({ warehouse: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.patch("/api/v1/warehouses/:id/status", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM warehouses WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Warehouse not found" });
    return;
  }
  const body = req.body;
  const nextActive = body.is_active !== void 0 ? body.is_active ? 1 : 0 : existing.is_active ? 0 : 1;
  db.prepare("UPDATE warehouses SET is_active = ? WHERE id = ?").run(nextActive, id);
  const updated = db.prepare("SELECT * FROM warehouses WHERE id = ?").get(id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: nextActive ? "ACTIVATE_WAREHOUSE" : "DEACTIVATE_WAREHOUSE",
    entityType: "WAREHOUSE",
    entityId: existing.code,
    beforeObj: { is_active: existing.is_active },
    afterObj: { is_active: nextActive }
  });
  res.json({ warehouse: updated });
});
app.delete("/api/v1/warehouses/:id", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM warehouses WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Warehouse not found" });
    return;
  }
  const lotCount = db.prepare("SELECT COUNT(*) as c FROM inventory_lots WHERE warehouse_id = ?").get(id).c;
  const purCount = db.prepare("SELECT COUNT(*) as c FROM paddy_purchases WHERE warehouse_id = ?").get(id).c;
  const trfCount = db.prepare("SELECT COUNT(*) as c FROM stock_transfers WHERE from_warehouse_id = ? OR to_warehouse_id = ?").get(id, id).c;
  const prodCount = db.prepare("SELECT COUNT(*) as c FROM production_batches WHERE source_warehouse_id = ?").get(id).c;
  const saleCount = db.prepare("SELECT COUNT(*) as c FROM sales_invoice_items WHERE warehouse_id = ?").get(id).c;
  if (lotCount + purCount + trfCount + prodCount + saleCount > 0) {
    res.status(409).json({
      error: `Cannot delete godown "${existing.name}" because it has stock lots or historical transactions. Set it Inactive instead.`
    });
    return;
  }
  db.prepare("DELETE FROM warehouses WHERE id = ?").run(id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: "DELETE_WAREHOUSE",
    entityType: "WAREHOUSE",
    entityId: existing.code,
    beforeObj: existing
  });
  res.json({ deleted: true, id });
});
app.post("/api/v1/items", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const { sku, name, category, process_grade, unit, bag_weight_kg, costing_method, default_rate, is_active } = req.body;
  if (!sku?.trim() || !name?.trim() || !category || !process_grade) {
    res.status(400).json({ error: "SKU, product name, category, and process grade are required" });
    return;
  }
  try {
    const activeVal = is_active === void 0 ? 1 : is_active ? 1 : 0;
    const catCode = category.trim().toUpperCase();
    const unitCode = (unit || "KG").trim().toUpperCase();
    const existingCat = db.prepare("SELECT id FROM product_categories WHERE UPPER(code) = ?").get(catCode);
    if (!existingCat) {
      const groupType = process_grade === "RAW_PADDY" || catCode === "PADDY" || catCode === "RAW_PADDY" ? "RAW_MATERIAL" : process_grade === "BY_PRODUCT" || ["BROKEN_RICE", "BRAN", "HUSK"].includes(catCode) ? "BY_PRODUCT" : "FINISHED_GOOD";
      const defaultCatNames = {
        PADDY: "Raw Paddy",
        RAW_PADDY: "Raw Paddy",
        HEAD_RICE: "Head Rice",
        BROKEN_RICE: "Broken Rice (Khud)",
        BRAN: "Rice Bran (Kura)",
        HUSK: "Paddy Husk (Tush)"
      };
      db.prepare(
        `INSERT INTO product_categories (code, name, group_type, default_costing_method, description, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).run(catCode, defaultCatNames[catCode] || catCode, groupType, costing_method || "FIFO", "Auto-created with product");
    }
    const existingUnit = db.prepare("SELECT id FROM product_units WHERE UPPER(code) = ?").get(unitCode);
    if (!existingUnit) {
      const defaultUnits = {
        KG: { name: "Kilogram", symbol: "kg", baseKg: 1 },
        BAG50: { name: "50 kg Bag", symbol: "bag", baseKg: 50 },
        QTL: { name: "Quintal (100 kg)", symbol: "qtl", baseKg: 100 },
        MT: { name: "Metric Ton (1000 kg)", symbol: "MT", baseKg: 1e3 }
      };
      const uDef = defaultUnits[unitCode] || { name: unitCode, symbol: unitCode.toLowerCase(), baseKg: Number(bag_weight_kg || 1) };
      db.prepare(
        `INSERT INTO product_units (code, name, symbol, base_weight_kg, description, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).run(unitCode, uDef.name, uDef.symbol, uDef.baseKg, "Auto-created with product");
    }
    const info = db.prepare(
      `INSERT INTO items (sku, name, category, process_grade, unit, bag_weight_kg, costing_method, default_rate, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      sku.trim().toUpperCase(),
      name.trim(),
      catCode,
      process_grade,
      unitCode,
      Number(bag_weight_kg || 50),
      costing_method || "FIFO",
      Number(default_rate || 0),
      activeVal
    );
    const item = db.prepare("SELECT * FROM items WHERE id = ?").get(info.lastInsertRowid);
    writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: "CREATE_PRODUCT",
      entityType: "ITEM",
      entityId: sku.trim().toUpperCase(),
      afterObj: item
    });
    res.status(201).json({ item });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.put("/api/v1/items/:id", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Product not found" });
    return;
  }
  const { sku, name, category, process_grade, unit, bag_weight_kg, costing_method, default_rate, is_active } = req.body;
  if (!sku?.trim() || !name?.trim() || !category || !process_grade) {
    res.status(400).json({ error: "SKU, product name, category, and process grade are required" });
    return;
  }
  try {
    const activeVal = is_active === void 0 ? existing.is_active : is_active ? 1 : 0;
    db.prepare(
      `UPDATE items
       SET sku = ?, name = ?, category = ?, process_grade = ?, unit = ?, bag_weight_kg = ?, costing_method = ?, default_rate = ?, is_active = ?
       WHERE id = ?`
    ).run(
      sku.trim().toUpperCase(),
      name.trim(),
      category,
      process_grade,
      (unit || "KG").trim().toUpperCase(),
      Number(bag_weight_kg || 50),
      costing_method || "FIFO",
      Number(default_rate || 0),
      activeVal,
      id
    );
    const updated = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
    writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: "UPDATE_PRODUCT",
      entityType: "ITEM",
      entityId: sku.trim().toUpperCase(),
      beforeObj: existing,
      afterObj: updated
    });
    res.json({ item: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.patch("/api/v1/items/:id/status", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Product not found" });
    return;
  }
  const body = req.body;
  const nextActive = body.is_active !== void 0 ? body.is_active ? 1 : 0 : existing.is_active ? 0 : 1;
  db.prepare("UPDATE items SET is_active = ? WHERE id = ?").run(nextActive, id);
  const updated = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: nextActive ? "ACTIVATE_PRODUCT" : "DEACTIVATE_PRODUCT",
    entityType: "ITEM",
    entityId: existing.sku,
    beforeObj: { is_active: existing.is_active },
    afterObj: { is_active: nextActive }
  });
  res.json({ item: updated });
});
app.delete("/api/v1/items/:id", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM items WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Product not found" });
    return;
  }
  const lotCount = db.prepare("SELECT COUNT(*) as c FROM inventory_lots WHERE item_id = ?").get(id).c;
  const purCount = db.prepare("SELECT COUNT(*) as c FROM paddy_purchases WHERE item_id = ?").get(id).c;
  const prodCount = db.prepare("SELECT COUNT(*) as c FROM production_batches WHERE paddy_item_id = ?").get(id).c;
  const saleCount = db.prepare("SELECT COUNT(*) as c FROM sales_invoice_items WHERE item_id = ?").get(id).c;
  const pSaleCount = db.prepare("SELECT COUNT(*) as c FROM paddy_sales WHERE item_id = ?").get(id).c;
  if (lotCount + purCount + prodCount + saleCount + pSaleCount > 0) {
    res.status(409).json({
      error: `Cannot delete product "${existing.name}" because it has stock lots or historical transactions. Set it Inactive instead.`
    });
    return;
  }
  db.prepare("DELETE FROM items WHERE id = ?").run(id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: "DELETE_PRODUCT",
    entityType: "ITEM",
    entityId: existing.sku,
    beforeObj: existing
  });
  res.json({ deleted: true, id });
});
app.get("/api/v1/product-units", authenticate, (_req, res) => {
  const units = db.prepare(
    `SELECT u.*, (SELECT COUNT(*) FROM items i WHERE i.unit = u.code) as product_count
       FROM product_units u ORDER BY u.id ASC`
  ).all();
  res.json({ units });
});
app.post("/api/v1/product-units", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const { code, name, symbol, base_weight_kg, description, is_active } = req.body;
  if (!code?.trim() || !name?.trim()) {
    res.status(400).json({ error: "Unit code and name are required" });
    return;
  }
  const baseWeight = Number(base_weight_kg ?? 1);
  if (isNaN(baseWeight) || baseWeight <= 0) {
    res.status(400).json({ error: "Base weight equivalent (kg) must be greater than zero" });
    return;
  }
  try {
    const cleanCode = code.trim().toUpperCase();
    const activeVal = is_active === void 0 ? 1 : is_active ? 1 : 0;
    const info = db.prepare(
      `INSERT INTO product_units (code, name, symbol, base_weight_kg, description, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(cleanCode, name.trim(), (symbol || cleanCode.toLowerCase()).trim(), baseWeight, description || "", activeVal);
    const unit = db.prepare("SELECT *, 0 as product_count FROM product_units WHERE id = ?").get(info.lastInsertRowid);
    writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: "CREATE_PRODUCT_UNIT",
      entityType: "PRODUCT_UNIT",
      entityId: cleanCode,
      afterObj: unit
    });
    res.status(201).json({ unit });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.put("/api/v1/product-units/:id", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM product_units WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Product unit not found" });
    return;
  }
  const { code, name, symbol, base_weight_kg, description, is_active } = req.body;
  if (!code?.trim() || !name?.trim()) {
    res.status(400).json({ error: "Unit code and name are required" });
    return;
  }
  const baseWeight = Number(base_weight_kg ?? 1);
  if (isNaN(baseWeight) || baseWeight <= 0) {
    res.status(400).json({ error: "Base weight equivalent (kg) must be greater than zero" });
    return;
  }
  try {
    const cleanCode = code.trim().toUpperCase();
    const activeVal = is_active === void 0 ? existing.is_active : is_active ? 1 : 0;
    const updated = db.transaction(() => {
      db.prepare(
        `UPDATE product_units SET code = ?, name = ?, symbol = ?, base_weight_kg = ?, description = ?, is_active = ? WHERE id = ?`
      ).run(cleanCode, name.trim(), (symbol || cleanCode.toLowerCase()).trim(), baseWeight, description || "", activeVal, id);
      if (existing.code !== cleanCode) {
        db.prepare("UPDATE items SET unit = ? WHERE unit = ?").run(cleanCode, existing.code);
      }
      return db.prepare(
        `SELECT u.*, (SELECT COUNT(*) FROM items i WHERE i.unit = u.code) as product_count
           FROM product_units u WHERE u.id = ?`
      ).get(id);
    })();
    writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: "UPDATE_PRODUCT_UNIT",
      entityType: "PRODUCT_UNIT",
      entityId: cleanCode,
      beforeObj: existing,
      afterObj: updated
    });
    res.json({ unit: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.patch("/api/v1/product-units/:id/status", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM product_units WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Product unit not found" });
    return;
  }
  const body = req.body;
  const nextActive = body.is_active !== void 0 ? body.is_active ? 1 : 0 : existing.is_active ? 0 : 1;
  db.prepare("UPDATE product_units SET is_active = ? WHERE id = ?").run(nextActive, id);
  const updated = db.prepare("SELECT * FROM product_units WHERE id = ?").get(id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: nextActive ? "ACTIVATE_PRODUCT_UNIT" : "DEACTIVATE_PRODUCT_UNIT",
    entityType: "PRODUCT_UNIT",
    entityId: existing.code,
    beforeObj: { is_active: existing.is_active },
    afterObj: { is_active: nextActive }
  });
  res.json({ unit: updated });
});
app.delete("/api/v1/product-units/:id", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM product_units WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Product unit not found" });
    return;
  }
  const refCount = db.prepare("SELECT COUNT(*) as c FROM items WHERE unit = ?").get(existing.code).c;
  if (refCount > 0) {
    res.status(409).json({
      error: `Cannot delete unit "${existing.name}" because ${refCount} product(s) currently use it. Set it Inactive instead.`
    });
    return;
  }
  db.prepare("DELETE FROM product_units WHERE id = ?").run(id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: "DELETE_PRODUCT_UNIT",
    entityType: "PRODUCT_UNIT",
    entityId: existing.code,
    beforeObj: existing
  });
  res.json({ deleted: true, id });
});
app.get("/api/v1/product-categories", authenticate, (_req, res) => {
  const categories = db.prepare(
    `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category = c.code) as product_count
       FROM product_categories c ORDER BY c.id ASC`
  ).all();
  res.json({ categories });
});
app.post("/api/v1/product-categories", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const { code, name, group_type, default_costing_method, description, is_active } = req.body;
  if (!code?.trim() || !name?.trim()) {
    res.status(400).json({ error: "Category code and name are required" });
    return;
  }
  try {
    const cleanCode = code.trim().toUpperCase().replace(/\s+/g, "_");
    const activeVal = is_active === void 0 ? 1 : is_active ? 1 : 0;
    const info = db.prepare(
      `INSERT INTO product_categories (code, name, group_type, default_costing_method, description, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      cleanCode,
      name.trim(),
      group_type || "FINISHED_GOOD",
      default_costing_method || "FIFO",
      description || "",
      activeVal
    );
    const category = db.prepare("SELECT *, 0 as product_count FROM product_categories WHERE id = ?").get(info.lastInsertRowid);
    writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: "CREATE_PRODUCT_CATEGORY",
      entityType: "PRODUCT_CATEGORY",
      entityId: cleanCode,
      afterObj: category
    });
    res.status(201).json({ category });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.put("/api/v1/product-categories/:id", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM product_categories WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Product category not found" });
    return;
  }
  const { code, name, group_type, default_costing_method, description, is_active } = req.body;
  if (!code?.trim() || !name?.trim()) {
    res.status(400).json({ error: "Category code and name are required" });
    return;
  }
  try {
    const cleanCode = code.trim().toUpperCase().replace(/\s+/g, "_");
    const activeVal = is_active === void 0 ? existing.is_active : is_active ? 1 : 0;
    const updated = db.transaction(() => {
      db.prepare(
        `UPDATE product_categories
         SET code = ?, name = ?, group_type = ?, default_costing_method = ?, description = ?, is_active = ?
         WHERE id = ?`
      ).run(
        cleanCode,
        name.trim(),
        group_type || "FINISHED_GOOD",
        default_costing_method || "FIFO",
        description || "",
        activeVal,
        id
      );
      if (existing.code !== cleanCode) {
        db.prepare("UPDATE items SET category = ? WHERE category = ?").run(cleanCode, existing.code);
      }
      return db.prepare(
        `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category = c.code) as product_count
           FROM product_categories c WHERE c.id = ?`
      ).get(id);
    })();
    writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: "UPDATE_PRODUCT_CATEGORY",
      entityType: "PRODUCT_CATEGORY",
      entityId: cleanCode,
      beforeObj: existing,
      afterObj: updated
    });
    res.json({ category: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.patch("/api/v1/product-categories/:id/status", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM product_categories WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Product category not found" });
    return;
  }
  const body = req.body;
  const nextActive = body.is_active !== void 0 ? body.is_active ? 1 : 0 : existing.is_active ? 0 : 1;
  db.prepare("UPDATE product_categories SET is_active = ? WHERE id = ?").run(nextActive, id);
  const updated = db.prepare("SELECT * FROM product_categories WHERE id = ?").get(id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: nextActive ? "ACTIVATE_PRODUCT_CATEGORY" : "DEACTIVATE_PRODUCT_CATEGORY",
    entityType: "PRODUCT_CATEGORY",
    entityId: existing.code,
    beforeObj: { is_active: existing.is_active },
    afterObj: { is_active: nextActive }
  });
  res.json({ category: updated });
});
app.delete("/api/v1/product-categories/:id", authenticate, requirePermission("stock.transfer"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM product_categories WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Product category not found" });
    return;
  }
  const refCount = db.prepare("SELECT COUNT(*) as c FROM items WHERE category = ?").get(existing.code).c;
  if (refCount > 0) {
    res.status(409).json({
      error: `Cannot delete category "${existing.name}" because ${refCount} product(s) belong to it. Set it Inactive instead.`
    });
    return;
  }
  db.prepare("DELETE FROM product_categories WHERE id = ?").run(id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: "DELETE_PRODUCT_CATEGORY",
    entityType: "PRODUCT_CATEGORY",
    entityId: existing.code,
    beforeObj: existing
  });
  res.json({ deleted: true, id });
});
function resolveSignedOpeningBalance(amount, balanceMode, partyType) {
  const amt = Math.max(0, Number(amount || 0));
  if (amt === 0) return 0;
  if (balanceMode === "CUSTOMER_DUE" || balanceMode === "SUPPLIER_ADVANCE" || balanceMode === "RECEIVABLE") return amt;
  if (balanceMode === "SUPPLIER_DUE" || balanceMode === "CUSTOMER_ADVANCE" || balanceMode === "PAYABLE") return -amt;
  if (balanceMode === "DUE") return partyType === "SUPPLIER" ? -amt : amt;
  if (balanceMode === "ADVANCE") return partyType === "CUSTOMER" ? -amt : amt;
  return Number(amount || 0);
}
app.get("/api/v1/parties", authenticate, (req, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const partiesRaw = db.prepare(`${ENRICHED_PARTIES_SQL} ORDER BY pt.name ASC`).all();
  const parties = physicalOnly ? partiesRaw.filter((p) => p.party_type === "SUPPLIER" || p.party_type === "BOTH").map((p) => ({
    ...p,
    credit_limit: 0,
    opening_balance: 0,
    current_balance: 0,
    total_purchased: 0,
    total_sold: 0,
    total_paid_out: 0,
    total_received_in: 0,
    open_purchase_due: 0,
    open_sales_due: 0
  })) : partiesRaw;
  res.json({ parties });
});
app.post("/api/v1/parties", authenticate, requirePermission("parties.manage"), (req, res) => {
  const {
    party_type,
    name,
    contact_person,
    phone,
    email,
    tax_id,
    address,
    credit_limit,
    opening_balance,
    opening_balance_type,
    is_active
  } = req.body;
  if (!party_type || !name?.trim()) {
    res.status(400).json({ error: "Party type and name are required" });
    return;
  }
  const signedOpening = resolveSignedOpeningBalance(opening_balance, opening_balance_type, party_type);
  const activeVal = is_active === void 0 ? 1 : is_active ? 1 : 0;
  const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM parties").get().nextId;
  const prefix = party_type === "SUPPLIER" ? "SUP" : party_type === "CUSTOMER" ? "CUS" : "BTH";
  const partyCode = `${prefix}-${String(seq).padStart(3, "0")}`;
  const info = db.prepare(
    `INSERT INTO parties (party_code, party_type, name, contact_person, phone, email, tax_id, address, credit_limit, opening_balance, current_balance, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    partyCode,
    party_type,
    name.trim(),
    contact_person || "",
    phone || "",
    email || "",
    tax_id || "",
    address || "",
    Number(credit_limit || 0),
    signedOpening,
    signedOpening,
    activeVal
  );
  const party = db.prepare(`${ENRICHED_PARTIES_SQL} WHERE pt.id = ?`).get(info.lastInsertRowid);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: "CREATE_PARTY",
    entityType: "PARTY",
    entityId: partyCode,
    afterObj: party
  });
  res.status(201).json({ party });
});
app.put("/api/v1/parties/:id", authenticate, requirePermission("parties.manage"), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM parties WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Party not found" });
    return;
  }
  const {
    party_type,
    name,
    contact_person,
    phone,
    email,
    tax_id,
    address,
    credit_limit,
    opening_balance,
    opening_balance_type,
    is_active
  } = req.body;
  if (!name?.trim() || !party_type) {
    res.status(400).json({ error: "Party type and name are required" });
    return;
  }
  const nextOpening = opening_balance !== void 0 ? resolveSignedOpeningBalance(opening_balance, opening_balance_type, party_type) : Number(existing.opening_balance);
  const openingDelta = Number((nextOpening - Number(existing.opening_balance)).toFixed(2));
  const nextCurrent = Number((Number(existing.current_balance) + openingDelta).toFixed(2));
  const activeVal = is_active === void 0 ? existing.is_active : is_active ? 1 : 0;
  db.prepare(
    `UPDATE parties
     SET party_type = ?, name = ?, contact_person = ?, phone = ?, email = ?, tax_id = ?, address = ?, credit_limit = ?, opening_balance = ?, current_balance = ?, is_active = ?
     WHERE id = ?`
  ).run(
    party_type,
    name.trim(),
    contact_person || "",
    phone || "",
    email || "",
    tax_id || "",
    address || "",
    Number(credit_limit || 0),
    nextOpening,
    nextCurrent,
    activeVal,
    id
  );
  const updated = db.prepare(`${ENRICHED_PARTIES_SQL} WHERE pt.id = ?`).get(id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: "UPDATE_PARTY",
    entityType: "PARTY",
    entityId: existing.party_code,
    beforeObj: existing,
    afterObj: updated
  });
  res.json({ party: updated });
});
app.patch("/api/v1/parties/:id/status", authenticate, requirePermission("parties.manage"), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM parties WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Party not found" });
    return;
  }
  const body = req.body;
  const nextActive = body.is_active !== void 0 ? body.is_active ? 1 : 0 : existing.is_active ? 0 : 1;
  db.prepare("UPDATE parties SET is_active = ? WHERE id = ?").run(nextActive, id);
  const updated = db.prepare(`${ENRICHED_PARTIES_SQL} WHERE pt.id = ?`).get(id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: nextActive ? "ACTIVATE_PARTY" : "DEACTIVATE_PARTY",
    entityType: "PARTY",
    entityId: existing.party_code,
    beforeObj: { is_active: existing.is_active },
    afterObj: { is_active: nextActive }
  });
  res.json({ party: updated });
});
app.delete("/api/v1/parties/:id", authenticate, requirePermission("parties.manage"), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM parties WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Party not found" });
    return;
  }
  const purCount = db.prepare("SELECT COUNT(*) as c FROM paddy_purchases WHERE supplier_id = ?").get(id).c;
  const invCount = db.prepare("SELECT COUNT(*) as c FROM sales_invoices WHERE customer_id = ?").get(id).c;
  const pSaleCount = db.prepare("SELECT COUNT(*) as c FROM paddy_sales WHERE customer_id = ?").get(id).c;
  const payCount = db.prepare("SELECT COUNT(*) as c FROM payments WHERE party_id = ?").get(id).c;
  if (purCount + invCount + pSaleCount + payCount > 0) {
    res.status(409).json({
      error: `Cannot delete "${existing.name}" because it has historical purchases, sales, or payments. Set it Inactive instead.`
    });
    return;
  }
  db.prepare("DELETE FROM parties WHERE id = ?").run(id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: "DELETE_PARTY",
    entityType: "PARTY",
    entityId: existing.party_code,
    beforeObj: existing
  });
  res.json({ deleted: true, id });
});
app.get("/api/v1/parties/:id/ledger", authenticate, (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const party = db.prepare(`${ENRICHED_PARTIES_SQL} WHERE pt.id = ?`).get(id);
  if (!party) {
    res.status(404).json({ error: "Party not found" });
    return;
  }
  const purchases = db.prepare(
    `SELECT pp.id, pp.purchase_no, pp.total_payable, pp.paid_amount, pp.payment_status, pp.payment_weight_kg, pp.created_at, i.name as item_name
       FROM paddy_purchases pp JOIN items i ON i.id = pp.item_id WHERE pp.supplier_id = ? ORDER BY datetime(pp.created_at) ASC, pp.id ASC`
  ).all(id);
  const invoices = db.prepare(
    `SELECT id, invoice_no, total_amount, paid_amount, payment_status, vehicle_no, created_at
       FROM sales_invoices WHERE customer_id = ? ORDER BY datetime(created_at) ASC, id ASC`
  ).all(id);
  const paddySales = db.prepare(
    `SELECT ps.id, ps.sale_no, ps.total_amount, ps.paid_amount, ps.payment_status, ps.qty_kg, ps.created_at, i.name as item_name
       FROM paddy_sales ps JOIN items i ON i.id = ps.item_id WHERE ps.customer_id = ? ORDER BY datetime(ps.created_at) ASC, ps.id ASC`
  ).all(id);
  const payments = db.prepare(
    `SELECT pay.*, a.name as account_name
       FROM payments pay JOIN accounts a ON a.id = pay.account_id
       WHERE pay.party_id = ? ORDER BY datetime(pay.created_at) ASC, pay.id ASC`
  ).all(id);
  const rawEvents = [];
  for (const pp of purchases) {
    rawEvents.push({
      date: pp.created_at,
      sortOrder: 1,
      entry_type: "PADDY_PURCHASE",
      ref_no: pp.purchase_no,
      description: `Paddy Purchase: ${pp.item_name} (${pp.payment_weight_kg.toLocaleString()} kg)${pp.paid_amount > 0 ? ` \xB7 Initial Paid \u09F3${pp.paid_amount.toLocaleString()}` : ""}`,
      debit_receivable: Number(pp.paid_amount || 0),
      credit_payable: Number(pp.total_payable || 0)
    });
  }
  for (const si of invoices) {
    rawEvents.push({
      date: si.created_at,
      sortOrder: 2,
      entry_type: "SALES_INVOICE",
      ref_no: si.invoice_no,
      description: `Rice & By-Product Sales Invoice${si.vehicle_no ? ` (${si.vehicle_no})` : ""}${si.paid_amount > 0 ? ` \xB7 Initial Recd \u09F3${si.paid_amount.toLocaleString()}` : ""}`,
      debit_receivable: Number(si.total_amount || 0),
      credit_payable: Number(si.paid_amount || 0)
    });
  }
  for (const ps of paddySales) {
    rawEvents.push({
      date: ps.created_at,
      sortOrder: 3,
      entry_type: "PADDY_SALE",
      ref_no: ps.sale_no,
      description: `Direct Paddy Sale: ${ps.item_name} (${ps.qty_kg.toLocaleString()} kg)`,
      debit_receivable: Number(ps.total_amount || 0),
      credit_payable: Number(ps.paid_amount || 0)
    });
  }
  for (const pay of payments) {
    const isReceipt = pay.direction === "RECEIPT";
    rawEvents.push({
      date: pay.created_at,
      sortOrder: 4,
      entry_type: "PAYMENT",
      ref_no: pay.payment_no,
      description: `${pay.voucher_type || pay.direction} via ${pay.account_name} (${pay.payment_mode})${pay.settled_ref_no ? ` \xB7 Ref: ${pay.settled_ref_no}` : ""}${pay.notes ? ` \xB7 ${pay.notes}` : ""}`,
      debit_receivable: isReceipt ? 0 : Number(pay.amount),
      credit_payable: isReceipt ? Number(pay.amount) : 0,
      voucher_type: pay.voucher_type,
      payment_mode: pay.payment_mode
    });
  }
  rawEvents.sort((a, b) => a.date.localeCompare(b.date) || a.sortOrder - b.sortOrder);
  let running = Number(party.opening_balance || 0);
  const entries = [];
  if (running !== 0) {
    entries.push({
      date: "Opening",
      entry_type: "OPENING",
      ref_no: "OPEN-BAL",
      description: running > 0 ? "Opening Receivable / Supplier Advance" : "Opening Payable / Customer Advance",
      debit_receivable: running > 0 ? running : 0,
      credit_payable: running < 0 ? Math.abs(running) : 0,
      running_balance: running
    });
  }
  for (const ev of rawEvents) {
    running = Number((running + ev.debit_receivable - ev.credit_payable).toFixed(2));
    entries.push({
      date: ev.date,
      entry_type: ev.entry_type,
      ref_no: ev.ref_no,
      description: ev.description,
      debit_receivable: ev.debit_receivable,
      credit_payable: ev.credit_payable,
      running_balance: running,
      voucher_type: ev.voucher_type,
      payment_mode: ev.payment_mode
    });
  }
  const openBills = [
    ...purchases.filter((p) => p.payment_status !== "PAID" && p.total_payable - p.paid_amount > 0.01).map((p) => ({
      bill_type: "PADDY_PURCHASE",
      bill_id: p.id,
      bill_no: p.purchase_no,
      date: p.created_at,
      total_amount: p.total_payable,
      paid_amount: p.paid_amount,
      due_amount: Number((p.total_payable - p.paid_amount).toFixed(2)),
      payment_status: p.payment_status
    })),
    ...invoices.filter((i) => i.payment_status !== "PAID" && i.total_amount - i.paid_amount > 0.01).map((i) => ({
      bill_type: "SALES_INVOICE",
      bill_id: i.id,
      bill_no: i.invoice_no,
      date: i.created_at,
      total_amount: i.total_amount,
      paid_amount: i.paid_amount,
      due_amount: Number((i.total_amount - i.paid_amount).toFixed(2)),
      payment_status: i.payment_status
    })),
    ...paddySales.filter((s) => s.payment_status !== "PAID" && s.total_amount - s.paid_amount > 0.01).map((s) => ({
      bill_type: "PADDY_SALE",
      bill_id: s.id,
      bill_no: s.sale_no,
      date: s.created_at,
      total_amount: s.total_amount,
      paid_amount: s.paid_amount,
      due_amount: Number((s.total_amount - s.paid_amount).toFixed(2)),
      payment_status: s.payment_status
    }))
  ];
  const curBal = Number(party.current_balance || 0);
  const pType = party.party_type;
  const customerDue = (pType === "CUSTOMER" || pType === "BOTH") && curBal > 0 ? curBal : 0;
  const customerAdvance = pType === "CUSTOMER" && curBal < 0 ? Math.abs(curBal) : 0;
  const supplierDue = (pType === "SUPPLIER" || pType === "BOTH") && curBal < 0 ? Math.abs(curBal) : 0;
  const supplierAdvance = pType === "SUPPLIER" && curBal > 0 ? curBal : 0;
  res.json({
    party,
    summary: {
      opening_balance: Number(party.opening_balance || 0),
      total_purchased: Number(party.total_purchased || 0),
      total_sold: Number(party.total_sold || 0),
      total_paid_out: Number(party.total_paid_out || 0),
      total_received_in: Number(party.total_received_in || 0),
      current_balance: curBal,
      customer_due: Number(customerDue.toFixed(2)),
      customer_advance: Number(customerAdvance.toFixed(2)),
      supplier_due: Number(supplierDue.toFixed(2)),
      supplier_advance: Number(supplierAdvance.toFixed(2))
    },
    open_bills: openBills,
    entries
  });
});
app.get("/api/v1/inventory/lots", authenticate, (req, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const lotsRaw = db.prepare(
    `SELECT l.*,
              COALESCE(l.origin_batch_id, CASE WHEN l.source_type = 'PRODUCTION_OUTPUT' THEN l.source_id ELSE NULL END) as origin_batch_id,
              pb.batch_no as origin_batch_no,
              pb.dryer_no as origin_dryer_no,
              i.name as item_name,
              i.sku,
              i.category,
              i.process_grade,
              i.bag_weight_kg,
              i.costing_method,
              w.name as warehouse_name,
              w.code as warehouse_code,
              w.warehouse_type,
              pp.bag_count as purchase_bag_count,
              CASE
                WHEN l.remaining_qty_kg <= 0.0001 THEN 0
                WHEN l.remaining_bags > 0 THEN l.remaining_bags
                WHEN l.source_type = 'PADDY_PURCHASE' AND pp.bag_count > 0 AND l.initial_qty_kg > 0
                  THEN ROUND(l.remaining_qty_kg * pp.bag_count / l.initial_qty_kg)
                ELSE ROUND(l.remaining_qty_kg / COALESCE(NULLIF(i.bag_weight_kg, 0), 50))
              END as remaining_bags
       FROM inventory_lots l
       JOIN items i ON i.id = l.item_id
       JOIN warehouses w ON w.id = l.warehouse_id
       LEFT JOIN paddy_purchases pp ON l.source_type = 'PADDY_PURCHASE' AND pp.id = l.source_id
       LEFT JOIN production_batches pb ON pb.id = COALESCE(l.origin_batch_id, CASE WHEN l.source_type = 'PRODUCTION_OUTPUT' THEN l.source_id ELSE NULL END)
       ORDER BY l.remaining_qty_kg DESC, datetime(l.received_at) ASC`
  ).all();
  const lots = physicalOnly ? lotsRaw.map((l) => ({ ...l, unit_cost_per_kg: 0 })) : lotsRaw;
  res.json({ lots });
});
app.get("/api/v1/inventory/ledger", authenticate, (req, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const ledgerRaw = db.prepare(
    `SELECT sl.*, l.lot_code, i.name as item_name, w.name as warehouse_name, e.full_name as employee_name
       FROM stock_ledger sl
       JOIN inventory_lots l ON l.id = sl.lot_id
       JOIN items i ON i.id = sl.item_id
       JOIN warehouses w ON w.id = sl.warehouse_id
       JOIN employees e ON e.id = sl.employee_id
       ORDER BY sl.id DESC LIMIT 150`
  ).all();
  const ledger = physicalOnly ? ledgerRaw.map((row) => ({ ...row, unit_cost_per_kg: 0, total_cost: 0 })) : ledgerRaw;
  res.json({ ledger });
});
app.get("/api/v1/paddy-purchases", authenticate, (req, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const purchasesRaw = db.prepare(
    `SELECT p.*, pt.name as supplier_name, w.name as warehouse_name, i.name as item_name, e.full_name as created_by_name,
              COALESCE((SELECT SUM(l.remaining_qty_kg) FROM inventory_lots l WHERE l.source_type = 'PADDY_PURCHASE' AND l.source_id = p.id), 0) as unconsumed_lot_qty_kg,
              COALESCE((SELECT SUM(l.remaining_bags) FROM inventory_lots l WHERE l.source_type = 'PADDY_PURCHASE' AND l.source_id = p.id), 0) as unconsumed_lot_bags,
              COALESCE((SELECT SUM(l2.remaining_qty_kg) FROM inventory_lots l2 WHERE l2.item_id = p.item_id AND l2.remaining_qty_kg > 0.0001), 0) as available_variety_stock_kg
       FROM paddy_purchases p
       JOIN parties pt ON pt.id = p.supplier_id
       JOIN warehouses w ON w.id = p.warehouse_id
       JOIN items i ON i.id = p.item_id
       JOIN employees e ON e.id = p.created_by
       ORDER BY p.id DESC`
  ).all();
  const returnsRaw = db.prepare(
    `SELECT r.*, p.purchase_no, pt.name as supplier_name, i.name as item_name,
              a.name as account_name, emp.full_name as created_by_name
       FROM paddy_purchase_returns r
       JOIN paddy_purchases p ON p.id = r.purchase_id
       JOIN parties pt ON pt.id = r.supplier_id
       JOIN items i ON i.id = r.item_id
       LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN employees emp ON emp.id = r.created_by
       ORDER BY r.id DESC`
  ).all();
  const returnsByPurchase = /* @__PURE__ */ new Map();
  for (const ret of returnsRaw) {
    const pid = Number(ret.purchase_id);
    const list = returnsByPurchase.get(pid) || [];
    list.push(ret);
    returnsByPurchase.set(pid, list);
  }
  const purchases = purchasesRaw.map((p) => {
    let splits = [];
    if (typeof p.split_summary_json === "string" && p.split_summary_json.trim()) {
      try {
        splits = JSON.parse(p.split_summary_json);
      } catch {
        splits = [];
      }
    }
    const row = {
      ...p,
      splits,
      return_logs: returnsByPurchase.get(Number(p.id)) || []
    };
    return physicalOnly ? sanitizePurchaseForPhysical(row) : row;
  });
  res.json({ purchases });
});
app.post("/api/v1/paddy-purchases", authenticate, requirePermission("paddy.purchase.create"), (req, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    const cached = idem.cachedResponse;
    if (physicalOnly && cached?.purchase) {
      res.status(200).json({ ...cached, purchase: sanitizePurchaseForPhysical(cached.purchase) });
      return;
    }
    res.status(200).json(idem.cachedResponse);
    return;
  }
  const weightLoss = Math.max(0, Number(body.weight_loss_kg || 0));
  const settlementUnit = Number(body.settlement_unit_kg || 75.5);
  const settlementRate = physicalOnly ? 0 : Number(body.settlement_rate || 0);
  const fallbackRatePerKg = physicalOnly ? 0 : Number(body.rate_per_kg || 0);
  const netBillableWeight = Number((Number(body.payment_weight_kg) - weightLoss).toFixed(3));
  const hasSettlementFormula = !physicalOnly && settlementRate > 0 && settlementUnit > 0;
  const isGodownIntake = physicalOnly || Boolean(body.pending_rate) && !hasSettlementFormula && fallbackRatePerKg <= 0;
  const hasSplits = Array.isArray(body.splits) && body.splits.length > 0;
  const resolvedPrimaryWhId = Number(body.warehouse_id || (hasSplits ? body.splits[0]?.warehouse_id : 0));
  if (!body.supplier_id || !resolvedPrimaryWhId || !body.item_id || body.supplier_claimed_weight_kg <= 0 || body.scale_weight_kg <= 0 || body.received_weight_kg <= 0 || body.payment_weight_kg <= 0 || settlementUnit <= 0 || netBillableWeight <= 0 || !isGodownIntake && !hasSettlementFormula && fallbackRatePerKg <= 0) {
    res.status(400).json({ error: "All four weight fields, positive net settlement weight, divisor, supplier, warehouse, and item are required" });
    return;
  }
  try {
    const result = db.transaction(() => {
      const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM paddy_purchases").get().nextId;
      const purchaseNo = `PUR-2026-${String(seq).padStart(4, "0")}`;
      const qrUid = crypto3.randomUUID();
      const weightDiscrepancy = Number((body.scale_weight_kg - body.supplier_claimed_weight_kg).toFixed(3));
      const discrepancyFlagged = Math.abs(weightDiscrepancy) > 20 || Math.abs(body.scale_weight_kg - body.received_weight_kg) > 25 ? 1 : 0;
      const effectiveSettlementRate = isGodownIntake ? 0 : hasSettlementFormula ? settlementRate : Number((fallbackRatePerKg * settlementUnit).toFixed(4));
      const totalPayable = isGodownIntake ? 0 : hasSettlementFormula ? Number((netBillableWeight / settlementUnit * settlementRate).toFixed(2)) : Number((netBillableWeight * fallbackRatePerKg).toFixed(2));
      const effectiveRatePerKg = isGodownIntake ? 0 : Number((totalPayable / body.payment_weight_kg).toFixed(4));
      const paidAmt = isGodownIntake ? 0 : Math.min(totalPayable, Math.max(0, Number(body.paid_amount || 0)));
      const payStatus = isGodownIntake || paidAmt <= 0 ? "UNPAID" : paidAmt >= totalPayable ? "PAID" : "PARTIAL";
      const pricingStatus = isGodownIntake ? "PENDING_RATE" : "PRICED";
      const reqJute = Math.max(0, Math.round(Number(body.jute_bag_count || 0)));
      const reqPlastic = Math.max(0, Math.round(Number(body.plastic_bag_count || 0)));
      const reqTotal = Math.max(0, Math.round(Number(body.bag_count || 0)));
      const juteBags = reqJute === 0 && reqPlastic === 0 && reqTotal > 0 ? reqTotal : reqJute;
      const plasticBags = reqPlastic;
      const totalBags = juteBags + plasticBags;
      const computedSplits = [];
      if (hasSplits) {
        let sumWeight = 0;
        let sumBags = 0;
        for (const s of body.splits) {
          const wh = db.prepare("SELECT id, name FROM warehouses WHERE id = ?").get(Number(s.warehouse_id));
          if (!wh) throw new Error("Invalid warehouse selected inside multi-godown split");
          const sWt = Number(s.received_weight_kg || 0);
          const sBags = Math.max(0, Math.round(Number(s.bag_count || 0)));
          if (sWt <= 0) throw new Error("Each split godown weight must be positive");
          if (sBags > 0 && sWt <= sBags) throw new Error("Each split godown weight (kg) must exceed its bag count");
          sumWeight += sWt;
          sumBags += sBags;
          const sNetUnits = sWt > sBags ? Number(((sWt - sBags) / settlementUnit).toFixed(4)) : 0;
          computedSplits.push({
            warehouse_id: wh.id,
            warehouse_name: wh.name,
            bag_count: sBags,
            jute_bag_count: Math.max(0, Math.round(Number(s.jute_bag_count || 0))),
            plastic_bag_count: Math.max(0, Math.round(Number(s.plastic_bag_count || 0))),
            received_weight_kg: Number(sWt.toFixed(3)),
            net_units: sNetUnits,
            allocated_amount: isGodownIntake ? 0 : Number((sWt / body.received_weight_kg * totalPayable).toFixed(2))
          });
        }
        if (Math.abs(sumWeight - body.received_weight_kg) > 0.5) {
          throw new Error(
            `Split godown weight sum (${sumWeight.toFixed(2)} kg) must equal total received weight (${Number(body.received_weight_kg).toFixed(2)} kg)`
          );
        }
        if (totalBags > 0 && sumBags !== totalBags) {
          throw new Error(`Split godown bags sum (${sumBags}) must equal total bags (${totalBags})`);
        }
      }
      const info = db.prepare(
        `INSERT INTO paddy_purchases (
            client_uuid, purchase_no, supplier_id, warehouse_id, item_id, vehicle_no, challan_no,
            bag_count, jute_bag_count, plastic_bag_count, moisture_pct, supplier_claimed_weight_kg, scale_weight_kg, received_weight_kg,
            payment_weight_kg, weight_loss_kg, settlement_unit_kg, settlement_rate,
            weight_discrepancy_kg, discrepancy_flagged, discrepancy_notes,
            rate_per_kg, total_payable, paid_amount, payment_status, pricing_status, qr_code_uid, weighbridge_mode, split_summary_json, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        clientUuid,
        purchaseNo,
        body.supplier_id,
        resolvedPrimaryWhId,
        body.item_id,
        body.vehicle_no || "",
        body.challan_no || "",
        totalBags,
        juteBags,
        plasticBags,
        Number(body.moisture_pct || 14),
        body.supplier_claimed_weight_kg,
        body.scale_weight_kg,
        body.received_weight_kg,
        body.payment_weight_kg,
        weightLoss,
        settlementUnit,
        effectiveSettlementRate,
        weightDiscrepancy,
        discrepancyFlagged,
        body.discrepancy_notes || "",
        effectiveRatePerKg,
        totalPayable,
        paidAmt,
        payStatus,
        pricingStatus,
        qrUid,
        body.weighbridge_mode || "MANUAL",
        computedSplits.length > 0 ? JSON.stringify(computedSplits) : null,
        req.user.id
      );
      const purchaseId = Number(info.lastInsertRowid);
      const effectiveUnitCost = isGodownIntake ? 0 : Number((totalPayable / body.received_weight_kg).toFixed(4));
      const itemRow = db.prepare("SELECT name FROM items WHERE id = ?").get(body.item_id);
      let primaryLot = null;
      const splitLots = [];
      if (computedSplits.length > 0) {
        for (let idx = 0; idx < computedSplits.length; idx++) {
          const sp = computedSplits[idx];
          const lotUid = idx === 0 ? qrUid : crypto3.randomUUID();
          const lot = createInventoryLot({
            prefix: "LOT-PAD",
            itemId: body.item_id,
            warehouseId: sp.warehouse_id,
            sourceType: "PADDY_PURCHASE",
            sourceId: purchaseId,
            qtyKg: sp.received_weight_kg,
            bagCount: sp.bag_count,
            unitCostPerKg: effectiveUnitCost,
            moisturePct: body.moisture_pct,
            movementType: "PURCHASE_IN",
            employeeId: req.user.id,
            qrUid: lotUid
          });
          if (idx === 0) primaryLot = lot;
          splitLots.push({ ...lot, warehouse_id: sp.warehouse_id, qty_kg: sp.received_weight_kg, bag_count: sp.bag_count });
          registerQrTag({
            qrCodeUid: lotUid,
            entityType: "PADDY_LOT",
            entityId: lot.lotId,
            entityCode: lot.lotCode,
            payload: {
              purchase_no: purchaseNo,
              lot_code: lot.lotCode,
              item: itemRow.name,
              warehouse: sp.warehouse_name,
              split_qty_kg: sp.received_weight_kg,
              split_bags: sp.bag_count,
              split_net_units: sp.net_units
            }
          });
        }
      } else {
        const lot = createInventoryLot({
          prefix: "LOT-PAD",
          itemId: body.item_id,
          warehouseId: resolvedPrimaryWhId,
          sourceType: "PADDY_PURCHASE",
          sourceId: purchaseId,
          qtyKg: body.received_weight_kg,
          bagCount: totalBags,
          unitCostPerKg: effectiveUnitCost,
          moisturePct: body.moisture_pct,
          movementType: "PURCHASE_IN",
          employeeId: req.user.id,
          qrUid
        });
        primaryLot = lot;
        const whRow = db.prepare("SELECT name FROM warehouses WHERE id = ?").get(resolvedPrimaryWhId);
        registerQrTag({
          qrCodeUid: qrUid,
          entityType: "PADDY_LOT",
          entityId: lot.lotId,
          entityCode: lot.lotCode,
          payload: {
            purchase_no: purchaseNo,
            lot_code: lot.lotCode,
            item: itemRow.name,
            warehouse: whRow.name,
            claimed_kg: body.supplier_claimed_weight_kg,
            scale_kg: body.scale_weight_kg,
            received_kg: body.received_weight_kg,
            payment_kg: body.payment_weight_kg
          }
        });
      }
      if (totalBags > 0) {
        const bagSeq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM supplier_bag_ledger").get().nextId;
        const entryNo = `BAG-2026-${String(bagSeq).padStart(4, "0")}`;
        db.prepare(
          `INSERT INTO supplier_bag_ledger (
            client_uuid, entry_no, supplier_id, entry_type, direction,
            jute_qty, plastic_qty, total_qty, reference_type, reference_id, reference_no, entry_date, notes, created_by
          ) VALUES (?, ?, ?, 'PADDY_DEPOSIT', 'IN_FROM_SUPPLIER', ?, ?, ?, 'PADDY_PURCHASE', ?, ?, date('now'), ?, ?)`
        ).run(
          crypto3.randomUUID(),
          entryNo,
          body.supplier_id,
          juteBags,
          plasticBags,
          totalBags,
          purchaseId,
          purchaseNo,
          `Bags deposited with paddy purchase ${purchaseNo}`,
          req.user.id
        );
      }
      if (!isGodownIntake && totalPayable > 0) {
        const unpaidDelta = totalPayable - paidAmt;
        db.prepare("UPDATE parties SET current_balance = current_balance - ? WHERE id = ?").run(unpaidDelta, body.supplier_id);
        const journalLines = [
          { accountCode: "1200", debit: totalPayable, credit: 0 },
          { accountCode: "2001", debit: 0, credit: unpaidDelta, partyId: body.supplier_id }
        ];
        if (paidAmt > 0) {
          journalLines.push({ accountCode: "1001", debit: 0, credit: paidAmt });
        }
        postJournalEntry({
          description: `Paddy Purchase ${purchaseNo} (${body.received_weight_kg} kg received / ${body.payment_weight_kg} kg billed)`,
          referenceType: "PADDY_PURCHASE",
          referenceId: purchaseId,
          employeeId: req.user.id,
          lines: journalLines
        });
      }
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: isGodownIntake ? "PADDY_GODOWN_INTAKE_CREATED" : discrepancyFlagged ? "PADDY_PURCHASE_WITH_DISCREPANCY" : "PADDY_PURCHASE_CREATED",
        entityType: "PADDY_PURCHASE",
        entityId: purchaseNo,
        afterObj: {
          claimed: body.supplier_claimed_weight_kg,
          scale: body.scale_weight_kg,
          received: body.received_weight_kg,
          payment: body.payment_weight_kg,
          discrepancy: weightDiscrepancy,
          pricing_status: pricingStatus,
          total_payable: totalPayable,
          splits: computedSplits.length > 0 ? computedSplits : void 0
        },
        deviceType: body.client_type || "WEB_PWA"
      });
      const created = db.prepare(
        `SELECT p.*, pt.name as supplier_name, w.name as warehouse_name, i.name as item_name
           FROM paddy_purchases p
           JOIN parties pt ON pt.id = p.supplier_id
           JOIN warehouses w ON w.id = p.warehouse_id
           JOIN items i ON i.id = p.item_id
           WHERE p.id = ?`
      ).get(purchaseId);
      const responseObj = {
        status: "SYNCED",
        purchase: { ...created, splits: computedSplits, return_logs: [] },
        lot: primaryLot,
        split_lots: splitLots
      };
      recordSyncLog({
        clientUuid,
        deviceId: body.device_id || "WEB-BROWSER",
        clientType: body.client_type || "WEB_PWA",
        endpoint: "/api/v1/paddy-purchases",
        status: "SYNCED",
        responseObj,
        employeeId: req.user.id
      });
      return physicalOnly ? { ...responseObj, purchase: sanitizePurchaseForPhysical(responseObj.purchase) } : responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.put("/api/v1/paddy-purchases/:id/price", authenticate, (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const canPrice = req.user?.role_code === "OWNER" || req.user?.role_code === "MANAGER" || req.user?.role_code === "ACCOUNTANT" || (req.user?.permissions || []).includes("accounting.post");
  if (!canPrice) {
    res.status(403).json({ error: "Only Admin, Manager, or Accountant can set paddy purchase rates" });
    return;
  }
  const purchaseId = Number(req.params.id);
  const body = req.body;
  try {
    const updatedPurchase = db.transaction(() => {
      const purchase = db.prepare("SELECT * FROM paddy_purchases WHERE id = ?").get(purchaseId);
      if (!purchase) throw new Error("Paddy purchase record not found");
      if (purchase.pricing_status === "PRICED" && Number(purchase.total_payable || 0) > 0) {
        throw new Error("This paddy purchase is already priced");
      }
      const weightLoss = Math.max(0, Number(body.weight_loss_kg ?? purchase.weight_loss_kg ?? 0));
      const settlementUnit = Number(body.settlement_unit_kg || purchase.settlement_unit_kg || 75.5);
      const settlementRate = Number(body.settlement_rate || 0);
      const fallbackRatePerKg = Number(body.rate_per_kg || 0);
      const netBillableWeight = Number((Number(purchase.payment_weight_kg) - weightLoss).toFixed(3));
      const hasSettlementFormula = settlementRate > 0 && settlementUnit > 0;
      if (settlementUnit <= 0 || netBillableWeight <= 0 || !hasSettlementFormula && fallbackRatePerKg <= 0) {
        throw new Error("Valid positive settlement unit weight and paddy rate are required");
      }
      const effectiveSettlementRate = hasSettlementFormula ? settlementRate : Number((fallbackRatePerKg * settlementUnit).toFixed(4));
      const totalPayable = hasSettlementFormula ? Number((netBillableWeight / settlementUnit * settlementRate).toFixed(2)) : Number((netBillableWeight * fallbackRatePerKg).toFixed(2));
      const effectiveRatePerKg = Number((totalPayable / Number(purchase.payment_weight_kg)).toFixed(4));
      const paidAmt = Math.min(totalPayable, Math.max(0, Number(body.paid_amount || 0)));
      const payStatus = paidAmt <= 0 ? "UNPAID" : paidAmt >= totalPayable ? "PAID" : "PARTIAL";
      let updatedSplitsJson = purchase.split_summary_json ?? null;
      if (typeof purchase.split_summary_json === "string" && purchase.split_summary_json.trim()) {
        try {
          const parsed = JSON.parse(purchase.split_summary_json);
          const nextSplits = parsed.map((sp) => ({
            ...sp,
            allocated_amount: Number((Number(sp.received_weight_kg || 0) / Number(purchase.received_weight_kg) * totalPayable).toFixed(2))
          }));
          updatedSplitsJson = JSON.stringify(nextSplits);
        } catch {
        }
      }
      db.prepare(
        `UPDATE paddy_purchases
         SET weight_loss_kg = ?, settlement_unit_kg = ?, settlement_rate = ?,
             rate_per_kg = ?, total_payable = ?, paid_amount = ?,
             payment_status = ?, pricing_status = 'PRICED', split_summary_json = ?
         WHERE id = ?`
      ).run(
        weightLoss,
        settlementUnit,
        effectiveSettlementRate,
        effectiveRatePerKg,
        totalPayable,
        paidAmt,
        payStatus,
        updatedSplitsJson,
        purchaseId
      );
      const effectiveUnitCost = Number((totalPayable / Number(purchase.received_weight_kg)).toFixed(4));
      const lots = db.prepare("SELECT id FROM inventory_lots WHERE source_type = 'PADDY_PURCHASE' AND source_id = ?").all(purchaseId);
      const updLot = db.prepare("UPDATE inventory_lots SET unit_cost_per_kg = ? WHERE id = ?");
      const updLedger = db.prepare(
        "UPDATE stock_ledger SET unit_cost_per_kg = ?, total_cost = ROUND(ABS(qty_change_kg) * ?, 2) WHERE lot_id = ? AND movement_type = 'PURCHASE_IN'"
      );
      for (const l of lots) {
        updLot.run(effectiveUnitCost, l.id);
        updLedger.run(effectiveUnitCost, effectiveUnitCost, l.id);
      }
      const unpaidDelta = totalPayable - paidAmt;
      db.prepare("UPDATE parties SET current_balance = current_balance - ? WHERE id = ?").run(unpaidDelta, purchase.supplier_id);
      let payAccCode = "1001";
      if (paidAmt > 0 && body.account_id) {
        const acc = db.prepare("SELECT account_code FROM accounts WHERE id = ?").get(Number(body.account_id));
        if (acc?.account_code) payAccCode = acc.account_code;
      }
      const journalLines = [
        { accountCode: "1200", debit: totalPayable, credit: 0 },
        { accountCode: "2001", debit: 0, credit: unpaidDelta, partyId: purchase.supplier_id }
      ];
      if (paidAmt > 0) {
        journalLines.push({ accountCode: payAccCode, debit: 0, credit: paidAmt });
      }
      postJournalEntry({
        description: `Paddy Purchase Priced ${purchase.purchase_no} (Rate settled by Admin/Accounts)`,
        referenceType: "PADDY_PURCHASE",
        referenceId: purchaseId,
        employeeId: req.user.id,
        lines: journalLines
      });
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "PADDY_PURCHASE_PRICED",
        entityType: "PADDY_PURCHASE",
        entityId: purchase.purchase_no,
        afterObj: {
          settlement_unit_kg: settlementUnit,
          settlement_rate: effectiveSettlementRate,
          total_payable: totalPayable,
          paid_amount: paidAmt
        }
      });
      const created = db.prepare(
        `SELECT p.*, pt.name as supplier_name, w.name as warehouse_name, i.name as item_name, e.full_name as created_by_name
           FROM paddy_purchases p
           JOIN parties pt ON pt.id = p.supplier_id
           JOIN warehouses w ON w.id = p.warehouse_id
           JOIN items i ON i.id = p.item_id
           JOIN employees e ON e.id = p.created_by
           WHERE p.id = ?`
      ).get(purchaseId);
      return { ...created, splits: updatedSplitsJson ? JSON.parse(updatedSplitsJson) : [], return_logs: [] };
    })();
    res.json({ status: "PRICED", purchase: updatedPurchase });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/v1/paddy-purchases/:id/return", authenticate, requirePermission("paddy.purchase.create"), (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const purchaseId = Number(req.params.id);
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }
  const returnType = body.return_type === "FINANCIAL_ADJUSTMENT" ? "FINANCIAL_ADJUSTMENT" : "PHYSICAL_RETURN";
  const returnQtyKg = Math.max(0, Number(body.return_qty_kg || 0));
  if (returnType === "PHYSICAL_RETURN" && (!Number.isFinite(returnQtyKg) || returnQtyKg <= 0)) {
    res.status(400).json({ error: "Return quantity (kg) must be greater than zero" });
    return;
  }
  try {
    const result = db.transaction(() => {
      const purchase = db.prepare(
        `SELECT p.*, i.costing_method, pt.name as supplier_name, i.name as item_name
           FROM paddy_purchases p
           JOIN items i ON i.id = p.item_id
           JOIN parties pt ON pt.id = p.supplier_id
           WHERE p.id = ?`
      ).get(purchaseId);
      if (!purchase) throw new Error("Paddy purchase record not found");
      let lotsToDeduct = [];
      if (returnType === "PHYSICAL_RETURN") {
        const ownLots = db.prepare(
          `SELECT id, warehouse_id, remaining_qty_kg, remaining_bags
             FROM inventory_lots
             WHERE source_type = 'PADDY_PURCHASE' AND source_id = ? AND remaining_qty_kg > 0.0001
             ORDER BY id ASC`
        ).all(purchaseId);
        const ownQty = ownLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);
        if (ownQty + 0.01 >= returnQtyKg) {
          lotsToDeduct = ownLots;
        } else {
          const otherVarietyLots = db.prepare(
            `SELECT id, warehouse_id, remaining_qty_kg, remaining_bags
               FROM inventory_lots
               WHERE item_id = ? AND remaining_qty_kg > 0.0001
                 AND NOT (source_type = 'PADDY_PURCHASE' AND source_id = ?)
               ORDER BY CASE WHEN warehouse_id = ? THEN 0 WHEN source_type = 'TRANSFER_IN' THEN 1 ELSE 2 END ASC, id ASC`
          ).all(purchase.item_id, purchaseId, purchase.warehouse_id);
          const totalAvailable = ownQty + otherVarietyLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);
          if (totalAvailable + 0.01 < returnQtyKg) {
            throw new Error(
              totalAvailable <= 0.01 ? `${purchase.purchase_no}-\u098F\u09B0 \u09A7\u09BE\u09A8 \u0987\u09A4\u09BF\u09AE\u09A7\u09CD\u09AF\u09C7\u0987 \u09A1\u09BE\u09AF\u09BC\u09BE\u09B0/\u09AE\u09BF\u09B2\u09BF\u0982\u09AF\u09BC\u09C7 \u09AC\u09CD\u09AF\u09AC\u09B9\u09C3\u09A4 \u09B9\u09AF\u09BC\u09C7\u099B\u09C7 (\u0985\u09AC\u09CD\u09AF\u09AC\u09B9\u09C3\u09A4 \u09B8\u09CD\u099F\u0995 \u09E6.\u09E6\u09E6 \u0995\u09C7\u099C\u09BF)\u0964 \u09B8\u09CD\u099F\u0995 \u099B\u09BE\u09A1\u09BC\u09BE \u09B6\u09C1\u09A7\u09C1 \u099F\u09BE\u0995\u09BE \u09AC\u09BE \u09AC\u09BF\u09B2 \u09B8\u0982\u09B6\u09CB\u09A7\u09A8 \u0995\u09B0\u09A4\u09C7 '\u09B6\u09C1\u09A7\u09C1 \u099F\u09BE\u0995\u09BE/\u09AC\u09BF\u09B2 \u09B8\u0982\u09B6\u09CB\u09A7\u09A8' \u09AE\u09CB\u09A1 \u09AC\u09CD\u09AF\u09AC\u09B9\u09BE\u09B0 \u0995\u09B0\u09C1\u09A8\u0964` : `${purchase.purchase_no} \u0993 \u0997\u09C1\u09A6\u09BE\u09AE\u09C7 ${purchase.item_name}-\u098F\u09B0 \u0985\u09AC\u09CD\u09AF\u09AC\u09B9\u09C3\u09A4 \u09AE\u099C\u09C1\u09A6 \u0986\u099B\u09C7 ${totalAvailable.toFixed(2)} \u0995\u09C7\u099C\u09BF (${returnQtyKg.toFixed(2)} \u0995\u09C7\u099C\u09BF \u09AB\u09C7\u09B0\u09A4 \u09A6\u09C7\u0993\u09DF\u09BE \u09B8\u09AE\u09CD\u09AD\u09AC \u09A8\u09DF)\u0964`
            );
          }
          lotsToDeduct = [...ownLots, ...otherVarietyLots];
        }
      }
      const maxReturnableAmt = Math.max(0, Number((Number(purchase.total_payable) - Number(purchase.returned_amount || 0)).toFixed(2)));
      const proportionalAmt = returnQtyKg > 0 && Number(purchase.received_weight_kg) > 0 ? Number((returnQtyKg / Number(purchase.received_weight_kg) * Number(purchase.total_payable)).toFixed(2)) : 0;
      const returnAmount = body.return_amount && Number(body.return_amount) > 0 ? Math.min(maxReturnableAmt, Number(Number(body.return_amount).toFixed(2))) : Math.min(maxReturnableAmt, proportionalAmt);
      if (returnAmount <= 0) throw new Error("Return / adjustment amount must be greater than zero");
      const juteRet = Math.max(0, Math.round(Number(body.return_jute_bags || 0)));
      const plasticRet = Math.max(0, Math.round(Number(body.return_plastic_bags || 0)));
      const explicitTotalRet = Math.max(0, Math.round(Number(body.return_bags || 0)));
      const returnBags = juteRet + plasticRet > 0 ? juteRet + plasticRet : explicitTotalRet;
      const finalJuteRet = juteRet + plasticRet > 0 ? juteRet : returnBags;
      const finalPlasticRet = juteRet + plasticRet > 0 ? plasticRet : 0;
      const refundMode = body.refund_mode === "CASH_REFUND" ? "CASH_REFUND" : "ADJUST_PAYABLE";
      let accRow;
      if (refundMode === "CASH_REFUND") {
        accRow = body.account_id ? db.prepare("SELECT id, account_code, name FROM accounts WHERE id = ?").get(Number(body.account_id)) : db.prepare("SELECT id, account_code, name FROM accounts WHERE account_code = '1001' LIMIT 1").get();
        if (!accRow) throw new Error("Refund account not found");
      }
      const retSeq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM paddy_purchase_returns").get().nextId;
      const returnNo = `RET-2026-${String(retSeq).padStart(4, "0")}`;
      const retIns = db.prepare(
        `INSERT INTO paddy_purchase_returns (
            client_uuid, return_no, purchase_id, supplier_id, item_id,
            return_qty_kg, return_bags, return_jute_bags, return_plastic_bags,
            return_amount, refund_mode, account_id, reason, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        clientUuid,
        returnNo,
        purchaseId,
        purchase.supplier_id,
        purchase.item_id,
        returnQtyKg,
        returnBags,
        finalJuteRet,
        finalPlasticRet,
        returnAmount,
        refundMode,
        accRow?.id ?? null,
        String(body.reason || "").trim(),
        req.user.id
      );
      const returnId = Number(retIns.lastInsertRowid);
      if (returnType === "PHYSICAL_RETURN" && returnQtyKg > 0) {
        let remToDeduct = returnQtyKg;
        let remBagsToDeduct = returnBags;
        for (const lot of lotsToDeduct) {
          if (remToDeduct <= 1e-4) break;
          const takeKg = Math.min(remToDeduct, Number(lot.remaining_qty_kg));
          const takeBags = remBagsToDeduct > 0 && Number(lot.remaining_bags || 0) > 0 ? Math.min(remBagsToDeduct, Number(lot.remaining_bags)) : void 0;
          consumeWarehouseStock({
            itemId: purchase.item_id,
            warehouseId: lot.warehouse_id,
            qtyKg: takeKg,
            bagCount: takeBags,
            preferredLotId: lot.id,
            costingMethod: "FIFO",
            movementType: "PURCHASE_RETURN",
            referenceType: "PADDY_PURCHASE_RETURN",
            referenceId: returnId,
            employeeId: req.user.id
          });
          remToDeduct = Number((remToDeduct - takeKg).toFixed(4));
          if (takeBags) remBagsToDeduct = Math.max(0, remBagsToDeduct - takeBags);
        }
      }
      const nextReturnedQty = Number((Number(purchase.returned_qty_kg || 0) + returnQtyKg).toFixed(3));
      const nextReturnedAmt = Number((Number(purchase.returned_amount || 0) + returnAmount).toFixed(2));
      const netPayableAfter = Math.max(0, Number((Number(purchase.total_payable) - nextReturnedAmt).toFixed(2)));
      const nextStatus = Number(purchase.paid_amount || 0) >= netPayableAfter - 0.01 ? "PAID" : Number(purchase.paid_amount || 0) > 0 ? "PARTIAL" : "UNPAID";
      db.prepare(
        "UPDATE paddy_purchases SET returned_qty_kg = ?, returned_amount = ?, payment_status = ? WHERE id = ?"
      ).run(nextReturnedQty, nextReturnedAmt, nextStatus, purchaseId);
      if (refundMode === "ADJUST_PAYABLE") {
        db.prepare("UPDATE parties SET current_balance = current_balance + ? WHERE id = ?").run(returnAmount, purchase.supplier_id);
      }
      postJournalEntry({
        description: returnType === "FINANCIAL_ADJUSTMENT" ? `Paddy Purchase Financial Adjustment ${returnNo} against ${purchase.purchase_no} (\u09F3${returnAmount})` : `Paddy Purchase Return ${returnNo} against ${purchase.purchase_no} (${returnQtyKg} kg)`,
        referenceType: "PADDY_PURCHASE_RETURN",
        referenceId: returnId,
        employeeId: req.user.id,
        lines: [
          {
            accountCode: refundMode === "CASH_REFUND" && accRow ? accRow.account_code : "2001",
            debit: returnAmount,
            credit: 0,
            partyId: refundMode === "ADJUST_PAYABLE" ? purchase.supplier_id : null
          },
          { accountCode: returnType === "FINANCIAL_ADJUSTMENT" ? "5200" : "1200", debit: 0, credit: returnAmount }
        ]
      });
      if (returnBags > 0) {
        const bagSeq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM supplier_bag_ledger").get().nextId;
        const entryNo = `BAG-2026-${String(bagSeq).padStart(4, "0")}`;
        db.prepare(
          `INSERT INTO supplier_bag_ledger (
            client_uuid, entry_no, supplier_id, entry_type, direction,
            jute_qty, plastic_qty, total_qty, reference_type, reference_id, reference_no, entry_date, notes, created_by
          ) VALUES (?, ?, ?, 'EMPTY_PICKUP', 'OUT_TO_SUPPLIER', ?, ?, ?, 'PADDY_PURCHASE_RETURN', ?, ?, date('now'), ?, ?)`
        ).run(
          crypto3.randomUUID(),
          entryNo,
          purchase.supplier_id,
          finalJuteRet,
          finalPlasticRet,
          returnBags,
          returnId,
          returnNo,
          `Bags returned on purchase return ${returnNo} (${purchase.purchase_no})`,
          req.user.id
        );
      }
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "PADDY_PURCHASE_RETURNED",
        entityType: "PADDY_PURCHASE_RETURN",
        entityId: returnNo,
        afterObj: { purchase_no: purchase.purchase_no, return_qty_kg: returnQtyKg, return_amount: returnAmount, refund_mode: refundMode }
      });
      const returnRecord = db.prepare(
        `SELECT r.*, p.purchase_no, pt.name as supplier_name, i.name as item_name,
                  a.name as account_name, emp.full_name as created_by_name
           FROM paddy_purchase_returns r
           JOIN paddy_purchases p ON p.id = r.purchase_id
           JOIN parties pt ON pt.id = r.supplier_id
           JOIN items i ON i.id = r.item_id
           LEFT JOIN accounts a ON a.id = r.account_id
           LEFT JOIN employees emp ON emp.id = r.created_by
           WHERE r.id = ?`
      ).get(returnId);
      const responseObj = { status: "SYNCED", return_record: returnRecord };
      recordSyncLog({
        clientUuid,
        deviceId: "WEB-BROWSER",
        clientType: "WEB_PWA",
        endpoint: `/api/v1/paddy-purchases/${purchaseId}/return`,
        status: "SYNCED",
        responseObj,
        employeeId: req.user.id
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get("/api/v1/stock-transfers", authenticate, (req, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const transfersRaw = db.prepare(
    `SELECT st.*, wf.name as from_warehouse_name, wt.name as to_warehouse_name, i.name as item_name
       FROM stock_transfers st
       JOIN warehouses wf ON wf.id = st.from_warehouse_id
       JOIN warehouses wt ON wt.id = st.to_warehouse_id
       JOIN items i ON i.id = st.item_id
       ORDER BY st.id DESC`
  ).all();
  const transfers = physicalOnly ? transfersRaw.map((t) => ({ ...t, bag_unit_rate: 0, total_cost: 0 })) : transfersRaw;
  res.json({ transfers });
});
app.post("/api/v1/stock-transfers", authenticate, requirePermission("stock.transfer"), (req, res) => {
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }
  if (body.from_warehouse_id === body.to_warehouse_id) {
    res.status(400).json({ error: "Source and destination warehouses must be different" });
    return;
  }
  if (Number(body.qty_kg) <= 0) {
    res.status(400).json({ error: "Transfer weight (kg) must be positive" });
    return;
  }
  if (body.bag_count !== void 0 && Number(body.bag_count) > 0 && Number(body.qty_kg) <= Number(body.bag_count)) {
    res.status(400).json({ error: "Transfer weight (kg) must exceed bag count" });
    return;
  }
  try {
    const result = db.transaction(() => {
      const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM stock_transfers").get().nextId;
      const transferNo = `TRF-2026-${String(seq).padStart(4, "0")}`;
      const qrUid = crypto3.randomUUID();
      const costingMethod = body.costing_method || "FIFO";
      const activeLots = db.prepare(
        `SELECT l.remaining_qty_kg, l.remaining_bags, l.unit_cost_per_kg, l.initial_qty_kg, l.source_type,
                  pp.bag_count as purchase_bag_count, i.bag_weight_kg
           FROM inventory_lots l
           JOIN items i ON i.id = l.item_id
           LEFT JOIN paddy_purchases pp ON l.source_type = 'PADDY_PURCHASE' AND pp.id = l.source_id
           WHERE l.item_id = ? AND l.warehouse_id = ? AND l.remaining_qty_kg > 0.0001`
      ).all(body.item_id, body.from_warehouse_id);
      const itemMeta = db.prepare("SELECT bag_weight_kg FROM items WHERE id = ?").get(body.item_id);
      const defaultBagWt = Number(itemMeta?.bag_weight_kg || 60) > 0 ? Number(itemMeta?.bag_weight_kg || 60) : 60;
      const stockWeightKg = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);
      const stockBags = activeLots.reduce((s, l) => {
        if (l.remaining_bags > 0) return s + Number(l.remaining_bags);
        if (l.source_type === "PADDY_PURCHASE" && (l.purchase_bag_count || 0) > 0 && l.initial_qty_kg > 0) {
          return s + Math.round(Number(l.remaining_qty_kg) * Number(l.purchase_bag_count) / Number(l.initial_qty_kg));
        }
        return s + Math.round(Number(l.remaining_qty_kg) / (Number(l.bag_weight_kg || defaultBagWt) || defaultBagWt));
      }, 0);
      const stockValue = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0) * Number(l.unit_cost_per_kg || 0), 0);
      const divisor = Number(body.unit_divisor || 75.5) > 0 ? Number(body.unit_divisor || 75.5) : 75.5;
      const transferBags = body.bag_count !== void 0 && Number(body.bag_count) >= 0 ? Math.round(Number(body.bag_count)) : Math.max(0, Math.round(Number(body.qty_kg) / defaultBagWt));
      const stockNetUnits = stockWeightKg > stockBags ? (stockWeightKg - stockBags) / divisor : 0;
      const bagUnitRate = stockNetUnits > 0 ? Number((stockValue / stockNetUnits).toFixed(4)) : 0;
      const goingNetUnits = transferBags > 0 && body.qty_kg > transferBags ? Number(((body.qty_kg - transferBags) / divisor).toFixed(4)) : 0;
      const formulaCost = bagUnitRate > 0 && goingNetUnits > 0 ? Number((bagUnitRate * goingNetUnits).toFixed(2)) : 0;
      const info = db.prepare(
        `INSERT INTO stock_transfers (
            client_uuid, transfer_no, from_warehouse_id, to_warehouse_id, item_id, qty_kg,
            bag_count, unit_divisor, net_units, bag_unit_rate,
            costing_method, total_cost, vehicle_or_driver, notes, qr_code_uid, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        clientUuid,
        transferNo,
        body.from_warehouse_id,
        body.to_warehouse_id,
        body.item_id,
        body.qty_kg,
        transferBags,
        divisor,
        goingNetUnits,
        bagUnitRate,
        costingMethod,
        0,
        body.vehicle_or_driver || "",
        body.notes || "",
        qrUid,
        req.user.id
      );
      const transferId = Number(info.lastInsertRowid);
      const consumed = consumeWarehouseStock({
        itemId: body.item_id,
        warehouseId: body.from_warehouse_id,
        qtyKg: body.qty_kg,
        bagCount: transferBags > 0 ? transferBags : void 0,
        costingMethod,
        movementType: "TRANSFER_OUT",
        referenceType: "STOCK_TRANSFER",
        referenceId: transferId,
        employeeId: req.user.id
      });
      const effectiveTotalCost = formulaCost > 0 ? formulaCost : consumed.totalCost;
      const effectiveAvgCost = Number((effectiveTotalCost / body.qty_kg).toFixed(4));
      const effectiveBagRate = bagUnitRate > 0 ? Number(bagUnitRate.toFixed(2)) : goingNetUnits > 0 ? Number((effectiveTotalCost / goingNetUnits).toFixed(2)) : 0;
      db.prepare("UPDATE stock_transfers SET total_cost = ?, bag_unit_rate = ? WHERE id = ?").run(
        effectiveTotalCost,
        effectiveBagRate,
        transferId
      );
      const originBatchIds = Array.from(
        new Set(consumed.consumedLots.map((c) => c.origin_batch_id).filter((id) => id != null))
      );
      const lot = createInventoryLot({
        prefix: "LOT-TRF",
        itemId: body.item_id,
        warehouseId: body.to_warehouse_id,
        sourceType: "TRANSFER_IN",
        sourceId: transferId,
        originBatchId: originBatchIds.length > 0 ? originBatchIds[0] : null,
        qtyKg: body.qty_kg,
        bagCount: transferBags > 0 ? transferBags : void 0,
        unitCostPerKg: effectiveAvgCost,
        movementType: "TRANSFER_IN",
        employeeId: req.user.id,
        qrUid
      });
      registerQrTag({
        qrCodeUid: qrUid,
        entityType: "STOCK_TRANSFER",
        entityId: transferId,
        entityCode: transferNo,
        payload: {
          transfer_no: transferNo,
          qty_kg: body.qty_kg,
          bag_count: transferBags,
          net_units: goingNetUnits,
          bag_unit_rate: effectiveBagRate,
          avg_cost: effectiveAvgCost,
          total_cost: effectiveTotalCost,
          lot_code: lot.lotCode
        }
      });
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "STOCK_TRANSFER_COMPLETED",
        entityType: "STOCK_TRANSFER",
        entityId: transferNo,
        afterObj: {
          from: body.from_warehouse_id,
          to: body.to_warehouse_id,
          qty_kg: body.qty_kg,
          bag_count: transferBags,
          net_units: goingNetUnits,
          bag_unit_rate: effectiveBagRate,
          total_cost: effectiveTotalCost
        },
        deviceType: body.client_type || "WEB_PWA"
      });
      const created = db.prepare(
        `SELECT st.*, wf.name as from_warehouse_name, wt.name as to_warehouse_name, i.name as item_name
           FROM stock_transfers st
           JOIN warehouses wf ON wf.id = st.from_warehouse_id
           JOIN warehouses wt ON wt.id = st.to_warehouse_id
           JOIN items i ON i.id = st.item_id
           WHERE st.id = ?`
      ).get(transferId);
      const physicalOnly = isPhysicalOnlyUser(req.user);
      const responseObj = {
        status: "SYNCED",
        transfer: physicalOnly ? { ...created, bag_unit_rate: 0, total_cost: 0 } : created
      };
      recordSyncLog({
        clientUuid,
        deviceId: body.device_id || "WEB-BROWSER",
        clientType: body.client_type || "WEB_PWA",
        endpoint: "/api/v1/stock-transfers",
        status: "SYNCED",
        responseObj,
        employeeId: req.user.id
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      recordSyncLog({
        clientUuid,
        deviceId: body.device_id || "WEB-BROWSER",
        clientType: body.client_type || "WEB_PWA",
        endpoint: "/api/v1/stock-transfers",
        status: "CONFLICT",
        conflictReason: err.message,
        employeeId: req.user.id
      });
      res.status(409).json({ error: err.message, code: "INSUFFICIENT_STOCK" });
      return;
    }
    res.status(400).json({ error: err.message });
  }
});
app.get("/api/v1/paddy-sales", authenticate, (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const sales = db.prepare(
    `SELECT ps.*, pt.name as customer_name, w.name as warehouse_name, i.name as item_name
       FROM paddy_sales ps
       JOIN parties pt ON pt.id = ps.customer_id
       JOIN warehouses w ON w.id = ps.warehouse_id
       JOIN items i ON i.id = ps.item_id
       ORDER BY ps.id DESC`
  ).all();
  res.json({ sales });
});
app.post("/api/v1/paddy-sales", authenticate, requirePermission("paddy.sale.create"), (req, res) => {
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }
  try {
    const result = db.transaction(() => {
      const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM paddy_sales").get().nextId;
      const saleNo = `PDS-2026-${String(seq).padStart(4, "0")}`;
      const qrUid = crypto3.randomUUID();
      const costingMethod = body.costing_method || "FIFO";
      const qtyKg = Number(body.qty_kg || 0);
      if (qtyKg <= 0) {
        throw new Error("Delivered paddy weight (kg) must be greater than zero");
      }
      const juteBags = Math.max(0, Math.round(Number(body.jute_bag_count || 0)));
      const plasticBags = Math.max(0, Math.round(Number(body.plastic_bag_count || 0)));
      const resolvedBagCount = body.bag_count && Number(body.bag_count) > 0 ? Math.round(Number(body.bag_count)) : juteBags + plasticBags;
      const scaleWeightKg = Number(body.scale_weight_kg ?? qtyKg);
      const paymentWeightKg = Number(body.payment_weight_kg ?? qtyKg);
      const weightLossKg = Math.max(0, Number(body.weight_loss_kg || 0));
      const settlementUnitKg = Number(body.settlement_unit_kg || 75.5);
      const settlementRate = Number(body.settlement_rate || 0);
      const moisturePct = Number(body.moisture_pct ?? 14);
      const netSettlementWeight = Number((paymentWeightKg - weightLossKg).toFixed(3));
      const hasFormula = settlementRate > 0 && settlementUnitKg > 0;
      if (hasFormula && netSettlementWeight <= 0) {
        throw new Error("Net settlement weight (Payment Weight - Weight Loss) must be greater than zero");
      }
      if (!hasFormula && Number(body.rate_per_kg || 0) <= 0) {
        throw new Error("Valid paddy settlement rate or rate per kg is required");
      }
      const totalAmount = hasFormula ? Number((netSettlementWeight / settlementUnitKg * settlementRate).toFixed(2)) : Number((qtyKg * Number(body.rate_per_kg || 0)).toFixed(2));
      const effectiveRatePerKg = hasFormula ? Number((totalAmount / (paymentWeightKg > 0 ? paymentWeightKg : qtyKg)).toFixed(4)) : Number(body.rate_per_kg || 0);
      const effectiveSettlementRate = hasFormula ? settlementRate : Number((effectiveRatePerKg * settlementUnitKg).toFixed(2));
      const paidAmt = Math.min(totalAmount, Math.max(0, Number(body.paid_amount || 0)));
      const payStatus = paidAmt <= 0 ? "UNPAID" : paidAmt >= totalAmount ? "PAID" : "PARTIAL";
      const info = db.prepare(
        `INSERT INTO paddy_sales (
            client_uuid, sale_no, customer_id, warehouse_id, item_id,
            challan_no, bag_count, jute_bag_count, plastic_bag_count, moisture_pct,
            scale_weight_kg, qty_kg, payment_weight_kg, weight_loss_kg,
            settlement_unit_kg, settlement_rate, rate_per_kg,
            total_amount, costing_method, cogs_amount, paid_amount, payment_status,
            vehicle_no, notes, qr_code_uid, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        clientUuid,
        saleNo,
        body.customer_id,
        body.warehouse_id,
        body.item_id,
        body.challan_no || "",
        resolvedBagCount,
        juteBags,
        plasticBags,
        moisturePct,
        scaleWeightKg,
        qtyKg,
        paymentWeightKg,
        weightLossKg,
        settlementUnitKg,
        effectiveSettlementRate,
        effectiveRatePerKg,
        totalAmount,
        costingMethod,
        0,
        paidAmt,
        payStatus,
        body.vehicle_no || "",
        body.notes || "",
        qrUid,
        req.user.id
      );
      const saleId = Number(info.lastInsertRowid);
      const preferredLotId = body.preferred_lot_id && Number(body.preferred_lot_id) > 0 ? Number(body.preferred_lot_id) : void 0;
      const consumed = consumeWarehouseStock({
        itemId: body.item_id,
        warehouseId: body.warehouse_id,
        qtyKg,
        bagCount: resolvedBagCount > 0 ? resolvedBagCount : void 0,
        preferredLotId,
        costingMethod,
        movementType: "DIRECT_SALE_OUT",
        referenceType: "PADDY_SALE",
        referenceId: saleId,
        employeeId: req.user.id
      });
      db.prepare("UPDATE paddy_sales SET cogs_amount = ? WHERE id = ?").run(consumed.totalCost, saleId);
      const dueAmt = totalAmount - paidAmt;
      db.prepare("UPDATE parties SET current_balance = current_balance + ? WHERE id = ?").run(dueAmt, body.customer_id);
      const jeLines = [
        { accountCode: "1100", debit: dueAmt, credit: 0, partyId: body.customer_id },
        { accountCode: "4002", debit: 0, credit: totalAmount },
        { accountCode: "5001", debit: consumed.totalCost, credit: 0 },
        { accountCode: "1200", debit: 0, credit: consumed.totalCost }
      ];
      if (paidAmt > 0) jeLines.push({ accountCode: "1001", debit: paidAmt, credit: 0, partyId: body.customer_id });
      postJournalEntry({
        description: `Direct Paddy Sale ${saleNo} (${qtyKg} kg, ${resolvedBagCount} bags)`,
        referenceType: "PADDY_SALE",
        referenceId: saleId,
        employeeId: req.user.id,
        lines: jeLines
      });
      const cust = db.prepare("SELECT name FROM parties WHERE id = ?").get(body.customer_id);
      const itemInfo = db.prepare("SELECT name FROM items WHERE id = ?").get(body.item_id);
      const whInfo = db.prepare("SELECT name FROM warehouses WHERE id = ?").get(body.warehouse_id);
      registerQrTag({
        qrCodeUid: qrUid,
        entityType: "PADDY_SALE",
        entityId: saleId,
        entityCode: saleNo,
        payload: {
          sale_no: saleNo,
          customer: cust?.name || String(body.customer_id),
          variety: itemInfo?.name || String(body.item_id),
          godown: whInfo?.name || String(body.warehouse_id),
          bag_count: resolvedBagCount,
          qty_kg: qtyKg,
          settlement_unit_kg: settlementUnitKg,
          settlement_rate: effectiveSettlementRate,
          total_amount: totalAmount,
          vehicle_no: body.vehicle_no || ""
        }
      });
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "DIRECT_PADDY_SALE",
        entityType: "PADDY_SALE",
        entityId: saleNo,
        afterObj: { qty_kg: qtyKg, bag_count: resolvedBagCount, total_amount: totalAmount, cogs: consumed.totalCost },
        deviceType: body.client_type || "WEB_PWA"
      });
      const created = db.prepare(
        `SELECT ps.*, pt.name as customer_name, w.name as warehouse_name, i.name as item_name
           FROM paddy_sales ps
           JOIN parties pt ON pt.id = ps.customer_id
           JOIN warehouses w ON w.id = ps.warehouse_id
           JOIN items i ON i.id = ps.item_id
           WHERE ps.id = ?`
      ).get(saleId);
      const responseObj = { status: "SYNCED", sale: created };
      recordSyncLog({
        clientUuid,
        deviceId: body.device_id || "WEB-BROWSER",
        clientType: body.client_type || "WEB_PWA",
        endpoint: "/api/v1/paddy-sales",
        status: "SYNCED",
        responseObj,
        employeeId: req.user.id
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      res.status(409).json({ error: err.message, code: "INSUFFICIENT_STOCK" });
      return;
    }
    res.status(400).json({ error: err.message });
  }
});
app.get("/api/v1/drying-batches", authenticate, (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const batches = db.prepare(
    `SELECT d.*, ws.name as source_warehouse_name, wd.name as dest_warehouse_name, i.name as item_name
       FROM paddy_drying_batches d
       JOIN warehouses ws ON ws.id = d.source_warehouse_id
       JOIN warehouses wd ON wd.id = d.dest_warehouse_id
       JOIN items i ON i.id = d.item_id
       ORDER BY d.id DESC`
  ).all();
  res.json({ drying_batches: batches });
});
app.post("/api/v1/drying-batches", authenticate, requirePermission("drying.manage"), (req, res) => {
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }
  if (body.output_qty_kg > body.input_qty_kg || body.output_qty_kg <= 0) {
    res.status(400).json({ error: "Dried output weight must be positive and cannot exceed wet input weight" });
    return;
  }
  try {
    const result = db.transaction(() => {
      const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM paddy_drying_batches").get().nextId;
      const dryingNo = `DRY-2026-${String(seq).padStart(4, "0")}`;
      const qrUid = crypto3.randomUUID();
      const moistureLossKg = Number((body.input_qty_kg - body.output_qty_kg).toFixed(3));
      const fuelCost = Number(body.fuel_power_cost || 0);
      const laborCost = Number(body.labor_cost || 0);
      const info = db.prepare(
        `INSERT INTO paddy_drying_batches (
            client_uuid, drying_no, source_warehouse_id, dest_warehouse_id, item_id, drying_method,
            input_qty_kg, initial_moisture_pct, final_moisture_pct, output_qty_kg, moisture_loss_kg,
            fuel_power_cost, labor_cost, input_paddy_cost, output_unit_cost_per_kg, status, qr_code_uid, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?)`
      ).run(
        clientUuid,
        dryingNo,
        body.source_warehouse_id,
        body.dest_warehouse_id,
        body.item_id,
        body.drying_method,
        body.input_qty_kg,
        body.initial_moisture_pct,
        body.final_moisture_pct,
        body.output_qty_kg,
        moistureLossKg,
        fuelCost,
        laborCost,
        0,
        0,
        qrUid,
        req.user.id
      );
      const dryingId = Number(info.lastInsertRowid);
      const consumed = consumeWarehouseStock({
        itemId: body.item_id,
        warehouseId: body.source_warehouse_id,
        qtyKg: body.input_qty_kg,
        costingMethod: "FIFO",
        movementType: "DRYING_OUT",
        referenceType: "DRYING_BATCH",
        referenceId: dryingId,
        employeeId: req.user.id
      });
      const totalCapitalizedCost = consumed.totalCost + fuelCost + laborCost;
      const outputUnitCost = Number((totalCapitalizedCost / body.output_qty_kg).toFixed(4));
      db.prepare("UPDATE paddy_drying_batches SET input_paddy_cost = ?, output_unit_cost_per_kg = ? WHERE id = ?").run(
        consumed.totalCost,
        outputUnitCost,
        dryingId
      );
      createInventoryLot({
        prefix: "LOT-DRY",
        itemId: body.item_id,
        warehouseId: body.dest_warehouse_id,
        sourceType: "DRYING_OUTPUT",
        sourceId: dryingId,
        qtyKg: body.output_qty_kg,
        unitCostPerKg: outputUnitCost,
        moisturePct: body.final_moisture_pct,
        movementType: "DRYING_IN",
        employeeId: req.user.id,
        qrUid
      });
      if (fuelCost + laborCost > 0) {
        postJournalEntry({
          description: `Paddy Drying Overhead ${dryingNo} (${body.drying_method})`,
          referenceType: "DRYING_BATCH",
          referenceId: dryingId,
          employeeId: req.user.id,
          lines: [
            { accountCode: "1200", debit: fuelCost + laborCost, credit: 0 },
            { accountCode: "1001", debit: 0, credit: fuelCost + laborCost }
          ]
        });
      }
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "DRYING_BATCH_COMPLETED",
        entityType: "DRYING_BATCH",
        entityId: dryingNo,
        afterObj: { input_kg: body.input_qty_kg, output_kg: body.output_qty_kg, loss_kg: moistureLossKg, output_unit_cost: outputUnitCost },
        deviceType: body.client_type || "WEB_PWA"
      });
      const created = db.prepare(
        `SELECT d.*, ws.name as source_warehouse_name, wd.name as dest_warehouse_name, i.name as item_name
           FROM paddy_drying_batches d
           JOIN warehouses ws ON ws.id = d.source_warehouse_id
           JOIN warehouses wd ON wd.id = d.dest_warehouse_id
           JOIN items i ON i.id = d.item_id
           WHERE d.id = ?`
      ).get(dryingId);
      const responseObj = { status: "SYNCED", drying_batch: created };
      recordSyncLog({
        clientUuid,
        deviceId: body.device_id || "WEB-BROWSER",
        clientType: body.client_type || "WEB_PWA",
        endpoint: "/api/v1/drying-batches",
        status: "SYNCED",
        responseObj,
        employeeId: req.user.id
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      res.status(409).json({ error: err.message, code: "INSUFFICIENT_STOCK" });
      return;
    }
    res.status(400).json({ error: err.message });
  }
});
function getEnrichedProductionBatch(batchId) {
  const b = db.prepare(
    `SELECT b.*, i.name as paddy_item_name, w.name as source_warehouse_name
       FROM production_batches b
       JOIN items i ON i.id = b.paddy_item_id
       JOIN warehouses w ON w.id = b.source_warehouse_id
       WHERE b.id = ?`
  ).get(batchId);
  if (!b) return null;
  const sheet = db.prepare("SELECT * FROM production_cost_sheets WHERE batch_id = ?").get(batchId) || null;
  const inputLogs = db.prepare(
    `SELECT pbi.*, w.name as warehouse_name, i.name as item_name, emp.full_name as created_by_name
       FROM production_batch_inputs pbi
       JOIN warehouses w ON w.id = pbi.source_warehouse_id
       JOIN items i ON i.id = pbi.paddy_item_id
       LEFT JOIN employees emp ON emp.id = pbi.created_by
       WHERE pbi.batch_id = ?
       ORDER BY pbi.id ASC`
  ).all(batchId);
  const expensesRaw = db.prepare(
    `SELECT e.*, emp.full_name as created_by_name
       FROM production_batch_expenses e
       LEFT JOIN employees emp ON emp.id = e.created_by
       WHERE e.batch_id = ?
       ORDER BY e.id DESC`
  ).all(batchId);
  const getExpPayments = db.prepare(
    `SELECT pep.*, a.name as account_name, emp.full_name as paid_by_name
     FROM production_expense_payments pep
     JOIN accounts a ON a.id = pep.account_id
     LEFT JOIN employees emp ON emp.id = pep.paid_by
     WHERE pep.expense_id = ?
     ORDER BY pep.id DESC`
  );
  const expenseLogs = expensesRaw.map((exp) => ({
    ...exp,
    payment_logs: getExpPayments.all(exp.id)
  }));
  const expensePaymentReceipts = db.prepare(
    `SELECT pep.*, a.name as account_name, emp.full_name as paid_by_name,
              pbe.expense_category, pbe.vendor_name, pbe.total_amount as expense_total
       FROM production_expense_payments pep
       JOIN production_batch_expenses pbe ON pbe.id = pep.expense_id
       JOIN accounts a ON a.id = pep.account_id
       LEFT JOIN employees emp ON emp.id = pep.paid_by
       WHERE pep.batch_id = ?
       ORDER BY pep.id DESC`
  ).all(batchId);
  const outputs = db.prepare(
    `SELECT po.*, i.name as item_name, w.name as warehouse_name, l.lot_code, l.remaining_qty_kg, l.remaining_bags
       FROM production_outputs po
       JOIN items i ON i.id = po.item_id
       JOIN warehouses w ON w.id = po.warehouse_id
       LEFT JOIN inventory_lots l ON l.id = po.lot_id
       WHERE po.batch_id = ?
       ORDER BY po.id ASC`
  ).all(batchId);
  const salesAgg = db.prepare(
    `SELECT COALESCE(SUM(qty_kg), 0) as sold_kg,
              COALESCE(SUM(bag_count), 0) as sold_bags,
              COALESCE(SUM(sale_amount), 0) as sold_revenue,
              COALESCE(SUM(cost_amount), 0) as sold_cogs,
              COALESCE(SUM(profit_amount), 0) as realized_profit,
              COUNT(DISTINCT invoice_id) as sales_count
       FROM sales_invoice_lot_allocations
       WHERE batch_id = ?`
  ).get(batchId);
  const stockAgg = db.prepare(
    `SELECT COALESCE(SUM(remaining_qty_kg), 0) as unsold_kg,
              COALESCE(SUM(remaining_bags), 0) as unsold_bags,
              COALESCE(SUM(remaining_qty_kg * unit_cost_per_kg), 0) as unsold_val
       FROM inventory_lots
       WHERE (origin_batch_id = ? OR (source_type = 'PRODUCTION_OUTPUT' AND source_id = ?)) AND remaining_qty_kg > 0.0001`
  ).get(batchId, batchId);
  const totalBatchCost = Number(sheet?.gross_batch_cost ?? b.paddy_formula_cost ?? 0);
  const totalExpPaid = expensesRaw.reduce((s, e) => s + Number(e.paid_amount ?? e.total_amount ?? 0), 0);
  const totalExpDue = expensesRaw.reduce((s, e) => s + Math.max(0, Number(e.total_amount || 0) - Number(e.paid_amount ?? e.total_amount ?? 0)), 0);
  const soldRevenue = Number(Number(salesAgg.sold_revenue || 0).toFixed(2));
  const soldCogs = Number(Number(salesAgg.sold_cogs || 0).toFixed(2));
  const realizedProfit = Number(Number(salesAgg.realized_profit || 0).toFixed(2));
  const unsoldVal = Number(Number(stockAgg.unsold_val || 0).toFixed(2));
  const projectedTotal = Number((soldRevenue + unsoldVal).toFixed(2));
  const projectedProfit = Number((projectedTotal - totalBatchCost).toFixed(2));
  const divisorVal = Number(b.unit_divisor || 75.5) > 0 ? Number(b.unit_divisor || 75.5) : 75.5;
  const inputBagsVal = Number(b.input_bag_count || 0);
  const inputPaddyKgVal = Number(b.input_paddy_qty_kg || 0);
  const resolvedNetUnits = Number(b.paddy_net_units || 0) > 0 ? Number(b.paddy_net_units) : inputPaddyKgVal > inputBagsVal ? Number(((inputPaddyKgVal - inputBagsVal) / divisorVal).toFixed(4)) : 0;
  const headRiceKgVal = Number(b.head_rice_qty_kg || 0);
  const issuePerUnit = resolvedNetUnits > 0 && headRiceKgVal > 0 ? Number((headRiceKgVal / resolvedNetUnits).toFixed(4)) : 0;
  return {
    ...b,
    issue_per_unit: issuePerUnit,
    cost_sheet: sheet,
    input_logs: inputLogs,
    expense_logs: expenseLogs,
    expense_payment_receipts: expensePaymentReceipts,
    outputs,
    profit_summary: {
      total_batch_cost: totalBatchCost,
      total_expense_paid: Number(totalExpPaid.toFixed(2)),
      unpaid_expense_due: Number(totalExpDue.toFixed(2)),
      total_sold_kg: Number(Number(salesAgg.sold_kg || 0).toFixed(2)),
      total_sold_bags: Number(salesAgg.sold_bags || 0),
      total_sold_revenue: soldRevenue,
      total_sold_cogs: soldCogs,
      realized_profit_loss: realizedProfit,
      unsold_stock_kg: Number(Number(stockAgg.unsold_kg || 0).toFixed(2)),
      unsold_stock_bags: Number(stockAgg.unsold_bags || 0),
      unsold_stock_value: unsoldVal,
      projected_total_value: projectedTotal,
      projected_net_profit_loss: projectedProfit,
      sales_count: Number(salesAgg.sales_count || 0)
    }
  };
}
app.get("/api/v1/production-batches", authenticate, (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const batchIds = db.prepare("SELECT id FROM production_batches ORDER BY id DESC").all();
  const enriched = batchIds.map((row) => getEnrichedProductionBatch(row.id)).filter((b) => b !== null);
  res.json({ batches: enriched });
});
app.post("/api/v1/production-batches", authenticate, requirePermission("production.manage"), (req, res) => {
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }
  const issueOnly = Boolean(body.issue_only);
  const headRiceQty = Number(body.head_rice_qty_kg || 0);
  const brokenRiceQty = Number(body.broken_rice_qty_kg || 0);
  const branQty = Number(body.bran_qty_kg || 0);
  const huskQty = Number(body.husk_qty_kg || 0);
  const totalOutput = headRiceQty + brokenRiceQty + branQty + huskQty;
  if (Number(body.input_paddy_qty_kg) <= 0) {
    res.status(400).json({ error: "Input paddy weight must be positive" });
    return;
  }
  if (!issueOnly && (totalOutput > body.input_paddy_qty_kg || headRiceQty <= 0)) {
    res.status(400).json({ error: "Total milled outputs cannot exceed input paddy weight, and head rice must be positive" });
    return;
  }
  try {
    const result = db.transaction(() => {
      const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM production_batches").get().nextId;
      const prefix = body.process_type === "PARBOILED_SIDDHO" ? "PRD-SID" : "PRD-ATP";
      const batchNo = `${prefix}-${String(2600 + seq)}`;
      const qrUid = crypto3.randomUUID();
      const costingMethod = body.costing_method || "FIFO";
      const activeLots = db.prepare(
        `SELECT l.remaining_qty_kg, l.remaining_bags, l.unit_cost_per_kg, l.initial_qty_kg, l.source_type,
                  pp.bag_count as purchase_bag_count, i.bag_weight_kg
           FROM inventory_lots l
           JOIN items i ON i.id = l.item_id
           LEFT JOIN paddy_purchases pp ON l.source_type = 'PADDY_PURCHASE' AND pp.id = l.source_id
           WHERE l.item_id = ? AND l.warehouse_id = ? AND l.remaining_qty_kg > 0.0001`
      ).all(body.paddy_item_id, body.source_warehouse_id);
      const stockWeightKg = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);
      const stockBags = activeLots.reduce((s, l) => {
        if (l.remaining_bags > 0) return s + Number(l.remaining_bags);
        if (l.source_type === "PADDY_PURCHASE" && (l.purchase_bag_count || 0) > 0 && l.initial_qty_kg > 0) {
          return s + Math.round(Number(l.remaining_qty_kg) * Number(l.purchase_bag_count) / Number(l.initial_qty_kg));
        }
        return s + Math.round(Number(l.remaining_qty_kg) / (Number(l.bag_weight_kg || 60) || 60));
      }, 0);
      const stockValue = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0) * Number(l.unit_cost_per_kg || 0), 0);
      const divisor = Number(body.unit_divisor || 75.5) > 0 ? Number(body.unit_divisor || 75.5) : 75.5;
      const inputBags = Math.max(0, Math.round(Number(body.input_bag_count || 0)));
      const dryerCount = Number(body.dryer_count || 1) > 0 ? Number(body.dryer_count || 1) : 1;
      const dryerNo = String(body.dryer_no || "").trim() || `\u09A1\u09BE\u09AF\u09BC\u09BE\u09B0-${dryerCount}`;
      const stockNetUnits = stockWeightKg > stockBags ? (stockWeightKg - stockBags) / divisor : 0;
      const bagUnitRate = stockNetUnits > 0 ? Number((stockValue / stockNetUnits).toFixed(4)) : 0;
      const goingNetUnits = inputBags > 0 && body.input_paddy_qty_kg > inputBags ? Number(((body.input_paddy_qty_kg - inputBags) / divisor).toFixed(4)) : 0;
      const formulaCost = bagUnitRate > 0 && goingNetUnits > 0 ? Number((bagUnitRate * goingNetUnits).toFixed(2)) : 0;
      const wastageKg = issueOnly ? 0 : Number((body.input_paddy_qty_kg - totalOutput).toFixed(3));
      const headRiceYieldPct = issueOnly ? 0 : Number((headRiceQty / body.input_paddy_qty_kg * 100).toFixed(2));
      const totalRecoveryPct = issueOnly ? 0 : Number((totalOutput / body.input_paddy_qty_kg * 100).toFixed(2));
      const batchStatus = issueOnly ? "IN_PROGRESS" : "COMPLETED";
      const info = db.prepare(
        `INSERT INTO production_batches (
            client_uuid, batch_no, process_type, source_warehouse_id, paddy_item_id, input_paddy_qty_kg,
            input_bag_count, dryer_no, dryer_count, unit_divisor, paddy_net_units, paddy_bag_unit_rate, paddy_formula_cost,
            costing_method, soaking_hours, steaming_temp_c, head_rice_qty_kg, broken_rice_qty_kg, bran_qty_kg,
            husk_qty_kg, wastage_qty_kg, head_rice_yield_pct, total_recovery_pct, status, qr_code_uid, notes, created_by, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${issueOnly ? "NULL" : "datetime('now')"})`
      ).run(
        clientUuid,
        batchNo,
        body.process_type,
        body.source_warehouse_id,
        body.paddy_item_id,
        body.input_paddy_qty_kg,
        inputBags,
        dryerNo,
        dryerCount,
        divisor,
        goingNetUnits,
        bagUnitRate,
        formulaCost,
        costingMethod,
        Number(body.soaking_hours || 0),
        Number(body.steaming_temp_c || 0),
        headRiceQty,
        brokenRiceQty,
        branQty,
        huskQty,
        wastageKg,
        headRiceYieldPct,
        totalRecoveryPct,
        batchStatus,
        qrUid,
        body.notes || "",
        req.user.id
      );
      const batchId = Number(info.lastInsertRowid);
      const consumed = consumeWarehouseStock({
        itemId: body.paddy_item_id,
        warehouseId: body.source_warehouse_id,
        qtyKg: body.input_paddy_qty_kg,
        bagCount: inputBags > 0 ? inputBags : void 0,
        costingMethod,
        movementType: "PRODUCTION_INPUT",
        referenceType: "PRODUCTION_BATCH",
        referenceId: batchId,
        employeeId: req.user.id
      });
      const effectiveRawPaddyCost = formulaCost > 0 ? formulaCost : consumed.totalCost;
      if (formulaCost === 0 && goingNetUnits > 0) {
        db.prepare("UPDATE production_batches SET paddy_formula_cost = ? WHERE id = ?").run(effectiveRawPaddyCost, batchId);
      }
      db.prepare(
        `INSERT INTO production_batch_inputs (
          batch_id, source_warehouse_id, paddy_item_id, bag_count, qty_kg, unit_divisor, net_units, bag_unit_rate, paddy_cost, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        batchId,
        body.source_warehouse_id,
        body.paddy_item_id,
        inputBags,
        body.input_paddy_qty_kg,
        divisor,
        goingNetUnits,
        bagUnitRate,
        effectiveRawPaddyCost,
        body.notes || "\u09AA\u09CD\u09B0\u09BE\u09A5\u09AE\u09BF\u0995 \u09A1\u09BE\u09AF\u09BC\u09BE\u09B0\u09C7 \u09A7\u09BE\u09A8 \u0987\u09B8\u09CD\u09AF\u09C1",
        req.user.id
      );
      const brokenItem = db.prepare("SELECT id, default_rate FROM items WHERE category = 'BROKEN_RICE' LIMIT 1").get();
      const branItem = db.prepare("SELECT id, default_rate FROM items WHERE category = 'RICE_BRAN' LIMIT 1").get();
      const huskItem = db.prepare("SELECT id, default_rate FROM items WHERE category = 'HUSK' LIMIT 1").get();
      const brokenVal = issueOnly ? 0 : Number((brokenRiceQty * brokenItem.default_rate).toFixed(2));
      const branVal = issueOnly ? 0 : Number((branQty * branItem.default_rate).toFixed(2));
      const huskVal = issueOnly ? 0 : Number((huskQty * huskItem.default_rate).toFixed(2));
      const byproductCredit = Number((brokenVal + branVal + huskVal).toFixed(2));
      const labor = Number(body.labor_cost || 0);
      const elec = Number(body.electricity_cost || 0);
      const fuel = Number(body.fuel_boiler_cost || 0);
      const mach = Number(body.machinery_overhead_cost || 0);
      const pack = Number(body.packaging_cost || 0);
      const grossBatchCost = Number((effectiveRawPaddyCost + labor + elec + fuel + mach + pack).toFixed(2));
      const netHeadRiceCost = Math.max(0, Number((grossBatchCost - byproductCredit).toFixed(2)));
      const costPerKgHeadRice = !issueOnly && headRiceQty > 0 ? Number((netHeadRiceCost / headRiceQty).toFixed(4)) : 0;
      const costPerBagHeadRice = !issueOnly && headRiceQty > 0 ? Number((costPerKgHeadRice * 50).toFixed(2)) : 0;
      db.prepare(
        `INSERT INTO production_cost_sheets (
          batch_id, raw_paddy_cost, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost,
          packaging_cost, gross_batch_cost, byproduct_credit_value, net_head_rice_cost, cost_per_kg_head_rice, cost_per_bag_head_rice
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        batchId,
        effectiveRawPaddyCost,
        labor,
        elec,
        fuel,
        mach,
        pack,
        grossBatchCost,
        byproductCredit,
        netHeadRiceCost,
        costPerKgHeadRice,
        costPerBagHeadRice
      );
      if (!issueOnly && headRiceQty > 0 && body.head_rice_item_id && body.rice_warehouse_id && body.byproduct_warehouse_id) {
        const insertOutput = db.prepare(
          `INSERT INTO production_outputs (batch_id, item_id, warehouse_id, output_type, pack_size_kg, bag_count, qty_kg, allocated_unit_cost_per_kg, total_value, lot_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const headLot = createInventoryLot({
          prefix: "LOT-RIC",
          itemId: body.head_rice_item_id,
          warehouseId: body.rice_warehouse_id,
          sourceType: "PRODUCTION_OUTPUT",
          sourceId: batchId,
          qtyKg: headRiceQty,
          packSizeKg: 50,
          bagCount: Math.round(headRiceQty / 50),
          unitCostPerKg: costPerKgHeadRice,
          movementType: "PRODUCTION_OUTPUT",
          employeeId: req.user.id
        });
        insertOutput.run(
          batchId,
          body.head_rice_item_id,
          body.rice_warehouse_id,
          "HEAD_RICE",
          50,
          Math.round(headRiceQty / 50),
          headRiceQty,
          costPerKgHeadRice,
          netHeadRiceCost,
          headLot.lotId
        );
        for (const b of [
          { qty: brokenRiceQty, item: brokenItem, type: "BROKEN_RICE", val: brokenVal, pack: 50 },
          { qty: branQty, item: branItem, type: "RICE_BRAN", val: branVal, pack: 50 },
          { qty: huskQty, item: huskItem, type: "HUSK", val: huskVal, pack: 35 }
        ]) {
          if (b.qty <= 0) continue;
          const bBags = Math.round(b.qty / b.pack);
          const bLot = createInventoryLot({
            prefix: "LOT-BYP",
            itemId: b.item.id,
            warehouseId: body.byproduct_warehouse_id,
            sourceType: "PRODUCTION_OUTPUT",
            sourceId: batchId,
            qtyKg: b.qty,
            packSizeKg: b.pack,
            bagCount: bBags,
            unitCostPerKg: b.item.default_rate,
            movementType: "PRODUCTION_OUTPUT",
            employeeId: req.user.id
          });
          insertOutput.run(batchId, b.item.id, body.byproduct_warehouse_id, b.type, b.pack, bBags, b.qty, b.item.default_rate, b.val, bLot.lotId);
        }
      }
      const overheadTotal = labor + elec + fuel + mach + pack;
      if (overheadTotal > 0) {
        db.prepare(
          `INSERT INTO production_batch_expenses (
            batch_id, expense_category, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost, packaging_cost,
            total_amount, payment_status, paid_amount, paid_at, notes, created_by
          ) VALUES (?, 'GENERAL', ?, ?, ?, ?, ?, ?, 'PAID', ?, datetime('now'), ?, ?)`
        ).run(batchId, labor, elec, fuel, mach, pack, overheadTotal, overheadTotal, body.notes || "Initial batch overhead", req.user.id);
        postJournalEntry({
          description: `Milling Overhead Capitalized - ${batchNo} (${body.process_type})`,
          referenceType: "PRODUCTION_BATCH",
          referenceId: batchId,
          employeeId: req.user.id,
          lines: [
            { accountCode: "1200", debit: overheadTotal, credit: 0 },
            { accountCode: "1001", debit: 0, credit: overheadTotal }
          ]
        });
      }
      registerQrTag({
        qrCodeUid: qrUid,
        entityType: "PRODUCTION_BATCH",
        entityId: batchId,
        entityCode: batchNo,
        payload: {
          batch_no: batchNo,
          process: body.process_type,
          dryer: `${dryerCount} (${dryerNo})`,
          input_bags: inputBags,
          input_kg: body.input_paddy_qty_kg,
          paddy_cost: effectiveRawPaddyCost,
          head_rice_kg: headRiceQty,
          yield_pct: headRiceYieldPct,
          cost_per_kg: costPerKgHeadRice
        }
      });
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: issueOnly ? "CRUSHING_DRYER_ISSUED" : "PRODUCTION_BATCH_COMPLETED",
        entityType: "PRODUCTION_BATCH",
        entityId: batchNo,
        afterObj: {
          process_type: body.process_type,
          dryer_no: dryerNo,
          dryer_count: dryerCount,
          input_bags: inputBags,
          input_kg: body.input_paddy_qty_kg,
          paddy_cost: effectiveRawPaddyCost
        },
        deviceType: body.client_type || "WEB_PWA"
      });
      const responseObj = { status: "SYNCED", batch: getEnrichedProductionBatch(batchId) };
      recordSyncLog({
        clientUuid,
        deviceId: body.device_id || "WEB-BROWSER",
        clientType: body.client_type || "WEB_PWA",
        endpoint: "/api/v1/production-batches",
        status: "SYNCED",
        responseObj,
        employeeId: req.user.id
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      res.status(409).json({ error: err.message, code: "INSUFFICIENT_STOCK" });
      return;
    }
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/v1/production-batches/:id/add-paddy", authenticate, requirePermission("production.manage"), (req, res) => {
  const batchId = Number(req.params.id);
  const body = req.body;
  const batch = db.prepare("SELECT * FROM production_batches WHERE id = ?").get(batchId);
  if (!batch) {
    res.status(404).json({ error: "Production batch not found" });
    return;
  }
  if (batch.status !== "IN_PROGRESS") {
    res.status(400).json({ error: "Can only add extra paddy to an ongoing (IN_PROGRESS) dryer batch" });
    return;
  }
  const addBags = Math.max(0, Math.round(Number(body.bag_count || 0)));
  const addKg = Number(body.qty_kg || 0);
  const divisor = Number(body.unit_divisor || batch.unit_divisor || 75.5) > 0 ? Number(body.unit_divisor || batch.unit_divisor || 75.5) : 75.5;
  const costingMethod = body.costing_method || "FIFO";
  if (addKg <= 0 || addBags <= 0 || addKg <= addBags) {
    res.status(400).json({ error: "Valid bag count and weight (weight > bags) are required" });
    return;
  }
  try {
    const result = db.transaction(() => {
      const activeLots = db.prepare(
        `SELECT l.remaining_qty_kg, l.remaining_bags, l.unit_cost_per_kg, l.initial_qty_kg, l.source_type,
                  pp.bag_count as purchase_bag_count, i.bag_weight_kg
           FROM inventory_lots l
           JOIN items i ON i.id = l.item_id
           LEFT JOIN paddy_purchases pp ON l.source_type = 'PADDY_PURCHASE' AND pp.id = l.source_id
           WHERE l.item_id = ? AND l.warehouse_id = ? AND l.remaining_qty_kg > 0.0001`
      ).all(body.paddy_item_id, body.source_warehouse_id);
      const stockWeightKg = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);
      const stockBags = activeLots.reduce((s, l) => {
        if (l.remaining_bags > 0) return s + Number(l.remaining_bags);
        if (l.source_type === "PADDY_PURCHASE" && (l.purchase_bag_count || 0) > 0 && l.initial_qty_kg > 0) {
          return s + Math.round(Number(l.remaining_qty_kg) * Number(l.purchase_bag_count) / Number(l.initial_qty_kg));
        }
        return s + Math.round(Number(l.remaining_qty_kg) / (Number(l.bag_weight_kg || 60) || 60));
      }, 0);
      const stockValue = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0) * Number(l.unit_cost_per_kg || 0), 0);
      const stockNetUnits = stockWeightKg > stockBags ? (stockWeightKg - stockBags) / divisor : 0;
      const bagUnitRate = stockNetUnits > 0 ? Number((stockValue / stockNetUnits).toFixed(4)) : 0;
      const addNetUnits = Number(((addKg - addBags) / divisor).toFixed(4));
      const formulaCost = bagUnitRate > 0 && addNetUnits > 0 ? Number((bagUnitRate * addNetUnits).toFixed(2)) : 0;
      const consumed = consumeWarehouseStock({
        itemId: body.paddy_item_id,
        warehouseId: body.source_warehouse_id,
        qtyKg: addKg,
        bagCount: addBags,
        costingMethod,
        movementType: "PRODUCTION_INPUT",
        referenceType: "PRODUCTION_BATCH",
        referenceId: batchId,
        employeeId: req.user.id
      });
      const addCost = formulaCost > 0 ? formulaCost : consumed.totalCost;
      db.prepare(
        `INSERT INTO production_batch_inputs (
          batch_id, source_warehouse_id, paddy_item_id, bag_count, qty_kg, unit_divisor, net_units, bag_unit_rate, paddy_cost, notes, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        batchId,
        body.source_warehouse_id,
        body.paddy_item_id,
        addBags,
        addKg,
        divisor,
        addNetUnits,
        bagUnitRate,
        addCost,
        String(body.notes || "").trim() || "\u0985\u09A4\u09BF\u09B0\u09BF\u0995\u09CD\u09A4 \u09A7\u09BE\u09A8 \u09A1\u09BE\u09AF\u09BC\u09BE\u09B0\u09C7 \u09AF\u09CB\u0997",
        req.user.id
      );
      db.prepare(
        `UPDATE production_batches
         SET input_paddy_qty_kg = input_paddy_qty_kg + ?,
             input_bag_count = input_bag_count + ?,
             paddy_net_units = paddy_net_units + ?,
             paddy_formula_cost = paddy_formula_cost + ?
         WHERE id = ?`
      ).run(addKg, addBags, addNetUnits, addCost, batchId);
      const sheet = db.prepare("SELECT * FROM production_cost_sheets WHERE batch_id = ?").get(batchId);
      const newRaw = Number((Number(sheet.raw_paddy_cost) + addCost).toFixed(2));
      const newGross = Number(
        (newRaw + Number(sheet.labor_cost || 0) + Number(sheet.electricity_cost || 0) + Number(sheet.fuel_boiler_cost || 0) + Number(sheet.machinery_overhead_cost || 0) + Number(sheet.packaging_cost || 0)).toFixed(2)
      );
      db.prepare("UPDATE production_cost_sheets SET raw_paddy_cost = ?, gross_batch_cost = ?, net_head_rice_cost = ? WHERE batch_id = ?").run(
        newRaw,
        newGross,
        Math.max(0, newGross - Number(sheet.byproduct_credit_value || 0)),
        batchId
      );
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "CRUSHING_EXTRA_PADDY_ADDED",
        entityType: "PRODUCTION_BATCH",
        entityId: batch.batch_no,
        afterObj: { addBags, addKg, addCost, newRaw }
      });
      return { status: "OK", batch: getEnrichedProductionBatch(batchId) };
    })();
    res.json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      res.status(409).json({ error: err.message, code: "INSUFFICIENT_STOCK" });
      return;
    }
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/v1/production-batches/:id/complete", authenticate, requirePermission("production.manage"), (req, res) => {
  const batchId = Number(req.params.id);
  const body = req.body;
  const batch = db.prepare("SELECT * FROM production_batches WHERE id = ?").get(batchId);
  if (!batch) {
    res.status(404).json({ error: "Production batch not found" });
    return;
  }
  if (batch.status === "COMPLETED") {
    res.status(400).json({ error: "Production batch is already completed" });
    return;
  }
  try {
    const result = db.transaction(() => {
      const sheet = db.prepare("SELECT * FROM production_cost_sheets WHERE batch_id = ?").get(batchId);
      const headPacksRaw = Array.isArray(body.head_rice_packs) && body.head_rice_packs.length > 0 ? body.head_rice_packs.map((p) => {
        const packSize = Number(p.pack_size_kg || 50) > 0 ? Number(p.pack_size_kg || 50) : 50;
        const bags = Math.max(0, Math.round(Number(p.bag_count || 0)));
        const qty = p.qty_kg && Number(p.qty_kg) > 0 ? Number(p.qty_kg) : Number((bags * packSize).toFixed(3));
        return {
          item_id: Number(p.item_id || body.head_rice_item_id),
          warehouse_id: Number(p.warehouse_id || body.rice_warehouse_id),
          pack_size_kg: packSize,
          bag_count: bags > 0 ? bags : Math.round(qty / packSize),
          qty_kg: qty
        };
      }).filter((p) => p.qty_kg > 0) : Number(body.head_rice_qty_kg || 0) > 0 ? [
        {
          item_id: Number(body.head_rice_item_id),
          warehouse_id: Number(body.rice_warehouse_id),
          pack_size_kg: 50,
          bag_count: Math.round(Number(body.head_rice_qty_kg || 0) / 50),
          qty_kg: Number(body.head_rice_qty_kg || 0)
        }
      ] : [];
      const headRiceQty = Number(headPacksRaw.reduce((s, p) => s + p.qty_kg, 0).toFixed(3));
      const brokenItem = db.prepare("SELECT id, default_rate FROM items WHERE category = 'BROKEN_RICE' LIMIT 1").get();
      const branItem = db.prepare("SELECT id, default_rate FROM items WHERE category = 'RICE_BRAN' LIMIT 1").get();
      const huskItem = db.prepare("SELECT id, default_rate FROM items WHERE category = 'HUSK' LIMIT 1").get();
      const secondaryResolved = [];
      if (Array.isArray(body.secondary_outputs) && body.secondary_outputs.length > 0) {
        for (const row of body.secondary_outputs) {
          const packSize = Number(row.pack_size_kg || 25) > 0 ? Number(row.pack_size_kg || 25) : 25;
          const bags = Math.max(0, Math.round(Number(row.bag_count || 0)));
          const qtyKg = row.qty_kg && Number(row.qty_kg) > 0 ? Number(row.qty_kg) : Number((bags * packSize).toFixed(3));
          if (qtyKg <= 0) continue;
          const resolvedBags = bags > 0 ? bags : Math.round(qtyKg / packSize);
          const hasBagRate = row.pricing_unit === "BAG" && Number(row.rate_per_bag || 0) > 0 && resolvedBags > 0;
          const ratePerBag = hasBagRate ? Number(row.rate_per_bag) : Number((Math.max(0, Number(row.rate_per_kg || 0)) * packSize).toFixed(2));
          const val = hasBagRate ? Number((resolvedBags * ratePerBag).toFixed(2)) : Number((qtyKg * Math.max(0, Number(row.rate_per_kg || 0))).toFixed(2));
          const ratePerKg = hasBagRate ? Number((val / qtyKg).toFixed(6)) : Math.max(0, Number(row.rate_per_kg || 0));
          let resolvedItemId = Number(row.item_id || 0);
          let resolvedCat = String(row.category || "BY_PRODUCT");
          if (resolvedItemId > 0) {
            const existingItem = db.prepare("SELECT id, category FROM items WHERE id = ?").get(resolvedItemId);
            if (existingItem) {
              resolvedCat = existingItem.category;
            } else {
              resolvedItemId = 0;
            }
          }
          if (resolvedItemId <= 0) {
            const cleanName = String(row.item_name || "").trim();
            if (!cleanName) throw new Error("Each secondary output must have an item selected or a custom item name");
            const byName = db.prepare("SELECT id, category FROM items WHERE LOWER(name) = LOWER(?) LIMIT 1").get(cleanName);
            if (byName) {
              resolvedItemId = byName.id;
              resolvedCat = byName.category;
            } else {
              const itemSeq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM items").get().nextId;
              const sku = `BYP-OUT-${String(itemSeq).padStart(3, "0")}`;
              const insItem = db.prepare(
                `INSERT INTO items (sku, name, category, process_grade, unit, bag_weight_kg, costing_method, default_rate, is_active)
                   VALUES (?, ?, ?, 'BY_PRODUCT', 'KG', ?, 'WEIGHTED_AVERAGE', ?, 1)`
              ).run(sku, cleanName, resolvedCat, packSize, ratePerKg);
              resolvedItemId = Number(insItem.lastInsertRowid);
            }
          }
          secondaryResolved.push({
            item_id: resolvedItemId,
            category: resolvedCat,
            warehouse_id: Number(row.warehouse_id || body.byproduct_warehouse_id),
            pack_size_kg: packSize,
            bag_count: resolvedBags,
            qty_kg: qtyKg,
            rate_per_kg: ratePerKg,
            rate_per_bag: ratePerBag,
            total_value: val
          });
        }
      } else {
        const brokenQty = Number(body.broken_rice_qty_kg || 0);
        const branQty2 = Number(body.bran_qty_kg || 0);
        const huskQty2 = Number(body.husk_qty_kg || 0);
        if (brokenQty > 0) {
          secondaryResolved.push({
            item_id: brokenItem.id,
            category: "BROKEN_RICE",
            warehouse_id: body.byproduct_warehouse_id,
            pack_size_kg: 50,
            bag_count: Math.round(brokenQty / 50),
            qty_kg: brokenQty,
            rate_per_kg: brokenItem.default_rate,
            rate_per_bag: Number((brokenItem.default_rate * 50).toFixed(2)),
            total_value: Number((brokenQty * brokenItem.default_rate).toFixed(2))
          });
        }
        if (branQty2 > 0) {
          secondaryResolved.push({
            item_id: branItem.id,
            category: "RICE_BRAN",
            warehouse_id: body.byproduct_warehouse_id,
            pack_size_kg: 50,
            bag_count: Math.round(branQty2 / 50),
            qty_kg: branQty2,
            rate_per_kg: branItem.default_rate,
            rate_per_bag: Number((branItem.default_rate * 50).toFixed(2)),
            total_value: Number((branQty2 * branItem.default_rate).toFixed(2))
          });
        }
        if (huskQty2 > 0) {
          secondaryResolved.push({
            item_id: huskItem.id,
            category: "HUSK",
            warehouse_id: body.byproduct_warehouse_id,
            pack_size_kg: 35,
            bag_count: Math.round(huskQty2 / 35),
            qty_kg: huskQty2,
            rate_per_kg: huskItem.default_rate,
            rate_per_bag: Number((huskItem.default_rate * 35).toFixed(2)),
            total_value: Number((huskQty2 * huskItem.default_rate).toFixed(2))
          });
        }
      }
      const secondaryTotalKg = secondaryResolved.reduce((s, r) => s + r.qty_kg, 0);
      const totalOutput = Number((headRiceQty + secondaryTotalKg).toFixed(3));
      if (headRiceQty <= 0 || totalOutput > batch.input_paddy_qty_kg + 0.01) {
        throw new Error("Head rice must be positive and total output cannot exceed input paddy weight");
      }
      const brokenRiceQty = secondaryResolved.filter((r) => r.category === "BROKEN_RICE").reduce((s, r) => s + r.qty_kg, 0);
      const branQty = secondaryResolved.filter((r) => r.category === "RICE_BRAN").reduce((s, r) => s + r.qty_kg, 0);
      const huskQty = secondaryResolved.filter((r) => r.category === "HUSK" || r.category === "BY_PRODUCT").reduce((s, r) => s + r.qty_kg, 0);
      const byproductCredit = Number(secondaryResolved.reduce((s, r) => s + r.total_value, 0).toFixed(2));
      const addLabor = Number(body.labor_cost ?? 0);
      const addElec = Number(body.electricity_cost ?? 0);
      const addFuel = Number(body.fuel_boiler_cost ?? 0);
      const addMach = Number(body.machinery_overhead_cost ?? 0);
      const addPack = Number(body.packaging_cost ?? 0);
      const labor = Number(sheet.labor_cost || 0) + addLabor;
      const elec = Number(sheet.electricity_cost || 0) + addElec;
      const fuel = Number(sheet.fuel_boiler_cost || 0) + addFuel;
      const mach = Number(sheet.machinery_overhead_cost || 0) + addMach;
      const pack = Number(sheet.packaging_cost || 0) + addPack;
      const grossBatchCost = Number((Number(sheet.raw_paddy_cost) + labor + elec + fuel + mach + pack).toFixed(2));
      const netHeadRiceCost = Math.max(0, Number((grossBatchCost - byproductCredit).toFixed(2)));
      const costPerKgHeadRice = Number((netHeadRiceCost / headRiceQty).toFixed(4));
      const costPerBagHeadRice = Number((costPerKgHeadRice * 50).toFixed(2));
      const wastageKg = Math.max(0, Number((batch.input_paddy_qty_kg - totalOutput).toFixed(3)));
      const headRiceYieldPct = Number((headRiceQty / batch.input_paddy_qty_kg * 100).toFixed(2));
      const totalRecoveryPct = Number((totalOutput / batch.input_paddy_qty_kg * 100).toFixed(2));
      db.prepare(
        `UPDATE production_batches
         SET head_rice_qty_kg = ?, broken_rice_qty_kg = ?, bran_qty_kg = ?, husk_qty_kg = ?,
             wastage_qty_kg = ?, head_rice_yield_pct = ?, total_recovery_pct = ?,
             status = 'COMPLETED', completed_at = datetime('now')
         WHERE id = ?`
      ).run(headRiceQty, brokenRiceQty, branQty, huskQty, wastageKg, headRiceYieldPct, totalRecoveryPct, batchId);
      db.prepare(
        `UPDATE production_cost_sheets
         SET labor_cost = ?, electricity_cost = ?, fuel_boiler_cost = ?, machinery_overhead_cost = ?, packaging_cost = ?,
             gross_batch_cost = ?, byproduct_credit_value = ?, net_head_rice_cost = ?,
             cost_per_kg_head_rice = ?, cost_per_bag_head_rice = ?
         WHERE batch_id = ?`
      ).run(labor, elec, fuel, mach, pack, grossBatchCost, byproductCredit, netHeadRiceCost, costPerKgHeadRice, costPerBagHeadRice, batchId);
      const insertOutput = db.prepare(
        `INSERT INTO production_outputs (batch_id, item_id, warehouse_id, output_type, pack_size_kg, bag_count, qty_kg, rate_per_bag, allocated_unit_cost_per_kg, total_value, lot_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const hp of headPacksRaw) {
        const hpValue = Number((hp.qty_kg * costPerKgHeadRice).toFixed(2));
        const headLot = createInventoryLot({
          prefix: "LOT-RIC",
          itemId: hp.item_id,
          warehouseId: hp.warehouse_id,
          sourceType: "PRODUCTION_OUTPUT",
          sourceId: batchId,
          originBatchId: batchId,
          qtyKg: hp.qty_kg,
          bagCount: hp.bag_count,
          packSizeKg: hp.pack_size_kg,
          unitCostPerKg: costPerKgHeadRice,
          movementType: "PRODUCTION_OUTPUT",
          employeeId: req.user.id
        });
        insertOutput.run(
          batchId,
          hp.item_id,
          hp.warehouse_id,
          "HEAD_RICE",
          hp.pack_size_kg,
          hp.bag_count,
          hp.qty_kg,
          Number((costPerKgHeadRice * hp.pack_size_kg).toFixed(2)),
          costPerKgHeadRice,
          hpValue,
          headLot.lotId
        );
      }
      for (const sec of secondaryResolved) {
        const bLot = createInventoryLot({
          prefix: "LOT-BYP",
          itemId: sec.item_id,
          warehouseId: sec.warehouse_id,
          sourceType: "PRODUCTION_OUTPUT",
          sourceId: batchId,
          originBatchId: batchId,
          qtyKg: sec.qty_kg,
          bagCount: sec.bag_count,
          packSizeKg: sec.pack_size_kg,
          unitCostPerKg: sec.rate_per_kg,
          movementType: "PRODUCTION_OUTPUT",
          employeeId: req.user.id
        });
        insertOutput.run(
          batchId,
          sec.item_id,
          sec.warehouse_id,
          sec.category,
          sec.pack_size_kg,
          sec.bag_count,
          sec.qty_kg,
          sec.rate_per_bag,
          sec.rate_per_kg,
          sec.total_value,
          bLot.lotId
        );
      }
      const addOverhead = addLabor + addElec + addFuel + addMach + addPack;
      if (addOverhead > 0) {
        db.prepare(
          `INSERT INTO production_batch_expenses (
            batch_id, expense_category, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost, packaging_cost,
            total_amount, payment_status, paid_amount, paid_at, notes, created_by
          ) VALUES (?, 'GENERAL', ?, ?, ?, ?, ?, ?, 'PAID', ?, datetime('now'), ?, ?)`
        ).run(batchId, addLabor, addElec, addFuel, addMach, addPack, addOverhead, addOverhead, "\u09B8\u09AE\u09BE\u09AA\u09A8\u09C0 \u0985\u09A4\u09BF\u09B0\u09BF\u0995\u09CD\u09A4 \u0996\u09B0\u099A", req.user.id);
        postJournalEntry({
          description: `Milling Overhead Capitalized - ${batch.batch_no} (${batch.process_type})`,
          referenceType: "PRODUCTION_BATCH",
          referenceId: batchId,
          employeeId: req.user.id,
          lines: [
            { accountCode: "1200", debit: addOverhead, credit: 0 },
            { accountCode: "1001", debit: 0, credit: addOverhead }
          ]
        });
      }
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "PRODUCTION_BATCH_COMPLETED",
        entityType: "PRODUCTION_BATCH",
        entityId: batch.batch_no,
        afterObj: { head_rice_qty_kg: headRiceQty, byproduct_credit: byproductCredit, cost_per_kg: costPerKgHeadRice }
      });
      return { status: "COMPLETED", batch: getEnrichedProductionBatch(batchId) };
    })();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/v1/production-batches/:id/expenses", authenticate, requirePermission("production.manage"), (req, res) => {
  const batchId = Number(req.params.id);
  const body = req.body;
  const batch = db.prepare("SELECT * FROM production_batches WHERE id = ?").get(batchId);
  if (!batch) {
    res.status(404).json({ error: "Production batch not found" });
    return;
  }
  const addLabor = Math.max(0, Number(body.labor_cost || 0));
  const addElec = Math.max(0, Number(body.electricity_cost || 0));
  const addFuel = Math.max(0, Number(body.fuel_boiler_cost || 0));
  const addMach = Math.max(0, Number(body.machinery_overhead_cost || 0));
  const addPack = Math.max(0, Number(body.packaging_cost || 0));
  const addTotal = Number((addLabor + addElec + addFuel + addMach + addPack).toFixed(2));
  if (addTotal <= 0) {
    res.status(400).json({ error: "Enter at least one positive expense amount" });
    return;
  }
  const timing = body.payment_timing === "UNPAID" || body.payment_timing === "PARTIAL" ? body.payment_timing : "PAID";
  const paidNow = timing === "UNPAID" ? 0 : timing === "PARTIAL" ? Math.min(addTotal, Math.max(0, Number(body.paid_now || 0))) : addTotal;
  const dueNow = Number((addTotal - paidNow).toFixed(2));
  const payStatus = paidNow <= 0 ? "UNPAID" : dueNow <= 0.01 ? "PAID" : "PARTIAL";
  try {
    const result = db.transaction(() => {
      const sheet = db.prepare("SELECT * FROM production_cost_sheets WHERE batch_id = ?").get(batchId);
      const labor = Number(sheet.labor_cost || 0) + addLabor;
      const elec = Number(sheet.electricity_cost || 0) + addElec;
      const fuel = Number(sheet.fuel_boiler_cost || 0) + addFuel;
      const mach = Number(sheet.machinery_overhead_cost || 0) + addMach;
      const pack = Number(sheet.packaging_cost || 0) + addPack;
      const grossBatchCost = Number((Number(sheet.raw_paddy_cost) + labor + elec + fuel + mach + pack).toFixed(2));
      const netHeadRiceCost = Math.max(0, Number((grossBatchCost - Number(sheet.byproduct_credit_value || 0)).toFixed(2)));
      const costPerKgHeadRice = batch.head_rice_qty_kg > 0 ? Number((netHeadRiceCost / batch.head_rice_qty_kg).toFixed(4)) : 0;
      const costPerBagHeadRice = batch.head_rice_qty_kg > 0 ? Number((costPerKgHeadRice * 50).toFixed(2)) : 0;
      db.prepare(
        `UPDATE production_cost_sheets
         SET labor_cost = ?, electricity_cost = ?, fuel_boiler_cost = ?, machinery_overhead_cost = ?, packaging_cost = ?,
             gross_batch_cost = ?, net_head_rice_cost = ?, cost_per_kg_head_rice = ?, cost_per_bag_head_rice = ?
         WHERE batch_id = ?`
      ).run(labor, elec, fuel, mach, pack, grossBatchCost, netHeadRiceCost, costPerKgHeadRice, costPerBagHeadRice, batchId);
      let payAccountCode = "1001";
      let resolvedAccId = null;
      if (paidNow > 0) {
        const acc = body.account_id ? db.prepare("SELECT id, account_code FROM accounts WHERE id = ?").get(body.account_id) : db.prepare("SELECT id, account_code FROM accounts WHERE account_code = '1001' LIMIT 1").get();
        if (!acc) throw new Error("Cash/Bank account not found");
        payAccountCode = acc.account_code;
        resolvedAccId = acc.id;
      }
      const category = String(body.expense_category || "GENERAL").trim() || "GENERAL";
      const vendorName = String(body.vendor_name || "").trim();
      const expInfo = db.prepare(
        `INSERT INTO production_batch_expenses (
            batch_id, expense_category, vendor_name, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost, packaging_cost,
            total_amount, payment_status, paid_amount, account_id, paid_at, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${paidNow > 0 ? "datetime('now')" : "NULL"}, ?, ?)`
      ).run(
        batchId,
        category,
        vendorName,
        addLabor,
        addElec,
        addFuel,
        addMach,
        addPack,
        addTotal,
        payStatus,
        paidNow,
        resolvedAccId,
        String(body.notes || "").trim(),
        req.user.id
      );
      const expenseId = Number(expInfo.lastInsertRowid);
      if (paidNow > 0 && resolvedAccId) {
        const paySeq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM production_expense_payments").get().nextId;
        const receiptNo = `EXPR-2026-${String(paySeq).padStart(4, "0")}`;
        db.prepare(
          `INSERT INTO production_expense_payments (receipt_no, expense_id, batch_id, account_id, amount, payment_mode, notes, paid_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(receiptNo, expenseId, batchId, resolvedAccId, paidNow, payAccountCode === "1002" ? "BANK_TRANSFER" : "CASH", body.notes || "Initial expense payment", req.user.id);
      }
      db.prepare(
        "INSERT OR IGNORE INTO accounts (account_code, name, account_type, balance, is_system) VALUES ('2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0, 1)"
      ).run();
      const jeLines = [
        { accountCode: "1200", debit: addTotal, credit: 0 }
      ];
      if (paidNow > 0) jeLines.push({ accountCode: payAccountCode, debit: 0, credit: paidNow });
      if (dueNow > 0) jeLines.push({ accountCode: "2002", debit: 0, credit: dueNow });
      postJournalEntry({
        description: `Milling Expense (${category}) - ${batch.batch_no}${vendorName ? ` \xB7 ${vendorName}` : ""}${body.notes ? ` (${body.notes})` : ""}`,
        referenceType: "PRODUCTION_BATCH",
        referenceId: batchId,
        employeeId: req.user.id,
        lines: jeLines
      });
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "PRODUCTION_EXPENSE_ADDED",
        entityType: "PRODUCTION_BATCH",
        entityId: batch.batch_no,
        afterObj: { category, vendorName, addTotal, paidNow, dueNow, payStatus, grossBatchCost }
      });
      const updatedBatch = getEnrichedProductionBatch(batchId);
      return {
        status: "OK",
        cost_sheet: updatedBatch?.cost_sheet || null,
        expense_logs: updatedBatch?.expense_logs || [],
        batch: updatedBatch
      };
    })();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/v1/production-batches/:id/expenses/:expId/pay", authenticate, requirePermission("production.manage"), (req, res) => {
  const batchId = Number(req.params.id);
  const expId = Number(req.params.expId);
  const body = req.body;
  const expense = db.prepare("SELECT * FROM production_batch_expenses WHERE id = ? AND batch_id = ?").get(expId, batchId);
  if (!expense) {
    res.status(404).json({ error: "Expense entry not found for this batch" });
    return;
  }
  const batch = db.prepare("SELECT id, batch_no FROM production_batches WHERE id = ?").get(batchId);
  if (!batch) {
    res.status(404).json({ error: "Production batch not found" });
    return;
  }
  const openDue = Number((Number(expense.total_amount || 0) - Number(expense.paid_amount || 0)).toFixed(2));
  if (openDue <= 0.01) {
    res.status(400).json({ error: "This expense is already fully paid" });
    return;
  }
  const payAmount = body.amount && Number(body.amount) > 0 ? Math.min(openDue, Number(Number(body.amount).toFixed(2))) : openDue;
  try {
    const result = db.transaction(() => {
      const acc = body.account_id ? db.prepare("SELECT id, account_code, name FROM accounts WHERE id = ?").get(body.account_id) : db.prepare("SELECT id, account_code, name FROM accounts WHERE account_code = '1001' LIMIT 1").get();
      if (!acc) throw new Error("Selected payment account not found");
      const nextPaid = Number((Number(expense.paid_amount || 0) + payAmount).toFixed(2));
      const nextStatus = nextPaid >= Number(expense.total_amount) - 0.01 ? "PAID" : "PARTIAL";
      db.prepare(
        `UPDATE production_batch_expenses
         SET paid_amount = ?, payment_status = ?, account_id = ?, paid_at = datetime('now')
         WHERE id = ?`
      ).run(nextPaid, nextStatus, acc.id, expId);
      const paySeq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM production_expense_payments").get().nextId;
      const receiptNo = `EXPR-2026-${String(paySeq).padStart(4, "0")}`;
      const payIns = db.prepare(
        `INSERT INTO production_expense_payments (receipt_no, expense_id, batch_id, account_id, amount, payment_mode, reference_no, notes, paid_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        receiptNo,
        expId,
        batchId,
        acc.id,
        payAmount,
        body.payment_mode || (acc.account_code === "1002" ? "BANK_TRANSFER" : "CASH"),
        String(body.reference_no || "").trim(),
        String(body.notes || "").trim() || "\u09AC\u09BE\u0995\u09BF \u0996\u09B0\u099A \u09AA\u09B0\u09BF\u09B6\u09CB\u09A7",
        req.user.id
      );
      const newPayId = Number(payIns.lastInsertRowid);
      db.prepare(
        "INSERT OR IGNORE INTO accounts (account_code, name, account_type, balance, is_system) VALUES ('2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0, 1)"
      ).run();
      postJournalEntry({
        description: `Milling Due Expense Paid (${receiptNo}) - ${batch.batch_no}${expense.vendor_name ? ` (${expense.vendor_name})` : ""}`,
        referenceType: "PRODUCTION_EXPENSE_PAYMENT",
        referenceId: expId,
        employeeId: req.user.id,
        lines: [
          { accountCode: "2002", debit: payAmount, credit: 0 },
          { accountCode: acc.account_code, debit: 0, credit: payAmount }
        ]
      });
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "PRODUCTION_EXPENSE_PAID",
        entityType: "PRODUCTION_BATCH",
        entityId: batch.batch_no,
        afterObj: { receipt_no: receiptNo, expense_id: expId, payAmount, nextPaid, nextStatus, account: acc.name }
      });
      const receipt = db.prepare(
        `SELECT pep.*, a.name as account_name, emp.full_name as paid_by_name,
                  pbe.expense_category, pbe.vendor_name, pbe.total_amount as expense_total
           FROM production_expense_payments pep
           JOIN production_batch_expenses pbe ON pbe.id = pep.expense_id
           JOIN accounts a ON a.id = pep.account_id
           LEFT JOIN employees emp ON emp.id = pep.paid_by
           WHERE pep.id = ?`
      ).get(newPayId);
      return { status: "PAID", receipt, batch: getEnrichedProductionBatch(batchId) };
    })();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get("/api/v1/supplier-bags", authenticate, (req, res) => {
  const supplierIdFilter = req.query.supplier_id ? Number(req.query.supplier_id) : null;
  const summaries = db.prepare(
    `SELECT
        pt.id as supplier_id,
        pt.party_code,
        pt.name as supplier_name,
        pt.phone,
        pt.address,
        COALESCE(SUM(CASE WHEN sbl.direction = 'OUT_TO_SUPPLIER' THEN sbl.jute_qty ELSE 0 END), 0) as jute_taken,
        COALESCE(SUM(CASE WHEN sbl.direction = 'IN_FROM_SUPPLIER' THEN sbl.jute_qty ELSE 0 END), 0) as jute_deposited,
        COALESCE(SUM(CASE WHEN sbl.direction = 'OUT_TO_SUPPLIER' THEN sbl.jute_qty ELSE -sbl.jute_qty END), 0) as jute_net,
        COALESCE(SUM(CASE WHEN sbl.direction = 'OUT_TO_SUPPLIER' THEN sbl.plastic_qty ELSE 0 END), 0) as plastic_taken,
        COALESCE(SUM(CASE WHEN sbl.direction = 'IN_FROM_SUPPLIER' THEN sbl.plastic_qty ELSE 0 END), 0) as plastic_deposited,
        COALESCE(SUM(CASE WHEN sbl.direction = 'OUT_TO_SUPPLIER' THEN sbl.plastic_qty ELSE -sbl.plastic_qty END), 0) as plastic_net,
        COALESCE(SUM(CASE WHEN sbl.direction = 'OUT_TO_SUPPLIER' THEN sbl.total_qty ELSE 0 END), 0) as total_taken,
        COALESCE(SUM(CASE WHEN sbl.direction = 'IN_FROM_SUPPLIER' THEN sbl.total_qty ELSE 0 END), 0) as total_deposited,
        COALESCE(SUM(CASE WHEN sbl.direction = 'OUT_TO_SUPPLIER' THEN sbl.total_qty ELSE -sbl.total_qty END), 0) as total_net,
        COUNT(sbl.id) as tx_count
       FROM parties pt
       LEFT JOIN supplier_bag_ledger sbl ON sbl.supplier_id = pt.id
       WHERE pt.party_type IN ('SUPPLIER', 'BOTH') AND pt.is_active = 1
       GROUP BY pt.id
       ORDER BY pt.name ASC`
  ).all();
  const entries = supplierIdFilter ? db.prepare(
    `SELECT sbl.*, pt.name as supplier_name, pt.party_code, e.full_name as created_by_name
           FROM supplier_bag_ledger sbl
           JOIN parties pt ON pt.id = sbl.supplier_id
           LEFT JOIN employees e ON e.id = sbl.created_by
           WHERE sbl.supplier_id = ?
           ORDER BY sbl.entry_date DESC, sbl.id DESC`
  ).all(supplierIdFilter) : db.prepare(
    `SELECT sbl.*, pt.name as supplier_name, pt.party_code, e.full_name as created_by_name
           FROM supplier_bag_ledger sbl
           JOIN parties pt ON pt.id = sbl.supplier_id
           LEFT JOIN employees e ON e.id = sbl.created_by
           ORDER BY sbl.entry_date DESC, sbl.id DESC
           LIMIT 300`
  ).all();
  res.json({ summaries, entries });
});
app.post("/api/v1/supplier-bags", authenticate, (req, res) => {
  const roleCode = req.user?.role_code;
  const perms = req.user?.permissions || [];
  const allowed = roleCode === "OWNER" || roleCode === "MANAGER" || roleCode === "GODOWN_KEEPER" || perms.includes("paddy.purchase.create") || perms.includes("purchases.create") || perms.includes("parties.manage");
  if (!allowed) {
    res.status(403).json({ error: "Permission denied to record supplier bag transactions" });
    return;
  }
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }
  const juteQty = Math.max(0, Math.round(Number(body.jute_qty || 0)));
  const plasticQty = Math.max(0, Math.round(Number(body.plastic_qty || 0)));
  const totalQty = juteQty + plasticQty;
  if (!body.supplier_id || totalQty <= 0) {
    res.status(400).json({ error: "Supplier and at least one Jute or Plastic bag quantity (> 0) are required" });
    return;
  }
  const entryType = body.entry_type || "ADVANCE_ISSUE";
  const direction = entryType === "EMPTY_RETURN" || entryType === "PADDY_DEPOSIT" ? "IN_FROM_SUPPLIER" : "OUT_TO_SUPPLIER";
  const entryDate = String(body.entry_date || "").trim() || (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  try {
    const result = db.transaction(() => {
      const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM supplier_bag_ledger").get().nextId;
      const entryNo = `BAG-2026-${String(seq).padStart(4, "0")}`;
      const info = db.prepare(
        `INSERT INTO supplier_bag_ledger (
            client_uuid, entry_no, supplier_id, entry_type, direction,
            jute_qty, plastic_qty, total_qty, reference_type, reference_id, reference_no, entry_date, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', NULL, ?, ?, ?, ?)`
      ).run(
        clientUuid,
        entryNo,
        body.supplier_id,
        entryType,
        direction,
        juteQty,
        plasticQty,
        totalQty,
        String(body.reference_no || "").trim(),
        entryDate,
        String(body.notes || "").trim(),
        req.user.id
      );
      const created = db.prepare(
        `SELECT sbl.*, pt.name as supplier_name, pt.party_code
           FROM supplier_bag_ledger sbl
           JOIN parties pt ON pt.id = sbl.supplier_id
           WHERE sbl.id = ?`
      ).get(Number(info.lastInsertRowid));
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: `BAG_${entryType}`,
        entityType: "SUPPLIER_BAG_LEDGER",
        entityId: entryNo,
        afterObj: { supplier_id: body.supplier_id, direction, juteQty, plasticQty, totalQty }
      });
      const responseObj = { status: "SYNCED", entry: created };
      recordSyncLog({
        clientUuid,
        deviceId: "WEB-BROWSER",
        clientType: "WEB_PWA",
        endpoint: "/api/v1/supplier-bags",
        status: "SYNCED",
        responseObj,
        employeeId: req.user.id
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete("/api/v1/supplier-bags/:id", authenticate, (req, res) => {
  const roleCode = req.user?.role_code;
  const canDelete = roleCode === "OWNER" || roleCode === "MANAGER" || (req.user?.permissions || []).includes("parties.manage");
  if (!canDelete) {
    res.status(403).json({ error: "Permission denied" });
    return;
  }
  const id = Number(req.params.id);
  const existing = db.prepare("SELECT * FROM supplier_bag_ledger WHERE id = ?").get(id);
  if (!existing) {
    res.status(404).json({ error: "Bag ledger entry not found" });
    return;
  }
  if (existing.reference_type === "PADDY_PURCHASE") {
    res.status(400).json({ error: "Purchase-linked bag deposits cannot be deleted directly" });
    return;
  }
  db.prepare("DELETE FROM supplier_bag_ledger WHERE id = ?").run(id);
  res.json({ deleted: true });
});
app.get("/api/v1/sales-invoices", authenticate, (req, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const invoices = db.prepare(
    `SELECT s.*, pt.name as customer_name
       FROM sales_invoices s
       JOIN parties pt ON pt.id = s.customer_id
       ORDER BY s.id DESC`
  ).all();
  const getLines = db.prepare(
    `SELECT sii.*, i.name as item_name, w.name as warehouse_name
     FROM sales_invoice_items sii
     JOIN items i ON i.id = sii.item_id
     JOIN warehouses w ON w.id = sii.warehouse_id
     WHERE sii.invoice_id = ?`
  );
  res.json({
    invoices: invoices.map((inv) => ({
      ...inv,
      items: getLines.all(inv.id)
    }))
  });
});
app.post("/api/v1/sales-invoices", authenticate, requirePermission("rice.sale.create"), (req, res) => {
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }
  if (!body.customer_id || !body.items?.length) {
    res.status(400).json({ error: "Customer and at least one invoice line item are required" });
    return;
  }
  try {
    const result = db.transaction(() => {
      const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM sales_invoices").get().nextId;
      const invoiceNo = `INV-2026-${String(seq).padStart(4, "0")}`;
      const qrUid = crypto3.randomUUID();
      const getItemBagWeight = db.prepare("SELECT bag_weight_kg FROM items WHERE id = ?");
      const getLotPackSize = db.prepare("SELECT pack_size_kg FROM inventory_lots WHERE id = ?");
      const resolvedLines = body.items.map((line) => {
        const bagCount = Math.max(0, Math.round(Number(line.bag_count || 0)));
        const lotInfo = line.preferred_lot_id ? getLotPackSize.get(line.preferred_lot_id) : void 0;
        const itemInfo = getItemBagWeight.get(line.item_id);
        const packSizeKg = Number(line.pack_size_kg || 0) > 0 ? Number(line.pack_size_kg) : Number(lotInfo?.pack_size_kg || 0) > 0 ? Number(lotInfo.pack_size_kg) : Number(itemInfo?.bag_weight_kg || 50) || 50;
        const ratePerBagInput = Number(line.rate_per_bag || 0);
        const qtyKg = Number(line.qty_kg || 0) > 0 ? Number(line.qty_kg) : Number((bagCount * packSizeKg).toFixed(3));
        if (qtyKg <= 0) {
          throw new Error("Line item weight / bag quantity must be greater than zero");
        }
        const usesBagPricing = bagCount > 0 && ratePerBagInput > 0;
        const lineTotal = usesBagPricing ? Number((bagCount * ratePerBagInput).toFixed(2)) : Number((qtyKg * Number(line.rate_per_kg || 0)).toFixed(2));
        const ratePerKg = usesBagPricing ? Number((lineTotal / qtyKg).toFixed(4)) : Number(line.rate_per_kg || 0);
        const ratePerBag = usesBagPricing ? ratePerBagInput : bagCount > 0 ? Number((lineTotal / bagCount).toFixed(2)) : 0;
        return {
          ...line,
          bagCount,
          packSizeKg,
          ratePerBag,
          qtyKg,
          ratePerKg,
          lineTotal
        };
      });
      const subtotal = Number(resolvedLines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2));
      const tax = Number(body.tax_amount || 0);
      const discount = Number(body.discount_amount || 0);
      const totalAmount = Math.max(0, Number((subtotal + tax - discount).toFixed(2)));
      const paidAmt = Math.min(totalAmount, Math.max(0, Number(body.paid_amount || 0)));
      const payStatus = paidAmt <= 0 ? "UNPAID" : paidAmt >= totalAmount ? "PAID" : "PARTIAL";
      const info = db.prepare(
        `INSERT INTO sales_invoices (
            client_uuid, invoice_no, customer_id, subtotal_amount, tax_amount, discount_amount,
            total_amount, total_cogs, paid_amount, payment_status, vehicle_no, qr_code_uid, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        clientUuid,
        invoiceNo,
        body.customer_id,
        subtotal,
        tax,
        discount,
        totalAmount,
        0,
        paidAmt,
        payStatus,
        body.vehicle_no || "",
        qrUid,
        req.user.id
      );
      const invoiceId = Number(info.lastInsertRowid);
      let totalCogs = 0;
      const insertLine = db.prepare(
        `INSERT INTO sales_invoice_items (
          invoice_id, item_id, warehouse_id, bag_count, pack_size_kg, rate_per_bag,
          qty_kg, rate_per_kg, line_total, costing_method, line_cogs
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insertLotAlloc = db.prepare(
        `INSERT INTO sales_invoice_lot_allocations (
          invoice_id, invoice_item_id, lot_id, batch_id, item_id, qty_kg, bag_count, cost_per_kg, cost_amount, sale_rate_per_kg, sale_amount, profit_amount
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const line of resolvedLines) {
        const cm = line.costing_method || "FIFO";
        const consumed = consumeWarehouseStock({
          itemId: line.item_id,
          warehouseId: line.warehouse_id,
          qtyKg: line.qtyKg,
          bagCount: line.bagCount > 0 ? line.bagCount : void 0,
          preferredLotId: line.preferred_lot_id,
          preferredBatchId: line.preferred_batch_id,
          costingMethod: cm,
          movementType: "RICE_SALE_OUT",
          referenceType: "SALES_INVOICE",
          referenceId: invoiceId,
          employeeId: req.user.id
        });
        const lineInfo = insertLine.run(
          invoiceId,
          line.item_id,
          line.warehouse_id,
          line.bagCount,
          line.packSizeKg,
          line.ratePerBag,
          line.qtyKg,
          line.ratePerKg,
          line.lineTotal,
          cm,
          consumed.totalCost
        );
        const invoiceItemId = Number(lineInfo.lastInsertRowid);
        let allocatedSaleTotal = 0;
        for (let idx = 0; idx < consumed.consumedLots.length; idx++) {
          const lotDetail = consumed.consumedLots[idx];
          const linkedBatchId = lotDetail.origin_batch_id != null ? Number(lotDetail.origin_batch_id) : lotDetail.source_type === "PRODUCTION_OUTPUT" && lotDetail.source_id ? Number(lotDetail.source_id) : null;
          const isLast = idx === consumed.consumedLots.length - 1;
          const saleAmt = isLast ? Number((line.lineTotal - allocatedSaleTotal).toFixed(2)) : Number((lotDetail.qty_taken_kg / line.qtyKg * line.lineTotal).toFixed(2));
          allocatedSaleTotal += saleAmt;
          const costAmt = Number(lotDetail.cost_amount.toFixed(2));
          const profitAmt = Number((saleAmt - costAmt).toFixed(2));
          insertLotAlloc.run(
            invoiceId,
            invoiceItemId,
            lotDetail.lot_id,
            linkedBatchId,
            line.item_id,
            lotDetail.qty_taken_kg,
            lotDetail.bags_taken,
            lotDetail.unit_cost_per_kg,
            costAmt,
            line.ratePerKg,
            saleAmt,
            profitAmt
          );
        }
        totalCogs += consumed.totalCost;
      }
      db.prepare("UPDATE sales_invoices SET total_cogs = ? WHERE id = ?").run(Number(totalCogs.toFixed(2)), invoiceId);
      const dueAmt = totalAmount - paidAmt;
      db.prepare("UPDATE parties SET current_balance = current_balance + ? WHERE id = ?").run(dueAmt, body.customer_id);
      const jeLines = [
        { accountCode: "1100", debit: dueAmt, credit: 0, partyId: body.customer_id },
        { accountCode: "4001", debit: 0, credit: totalAmount },
        { accountCode: "5001", debit: totalCogs, credit: 0 },
        { accountCode: "1200", debit: 0, credit: totalCogs }
      ];
      if (paidAmt > 0) jeLines.push({ accountCode: "1001", debit: paidAmt, credit: 0, partyId: body.customer_id });
      postJournalEntry({
        description: `Sales Invoice ${invoiceNo}`,
        referenceType: "SALES_INVOICE",
        referenceId: invoiceId,
        employeeId: req.user.id,
        lines: jeLines
      });
      const cust = db.prepare("SELECT name FROM parties WHERE id = ?").get(body.customer_id);
      registerQrTag({
        qrCodeUid: qrUid,
        entityType: "SALES_INVOICE",
        entityId: invoiceId,
        entityCode: invoiceNo,
        payload: { invoice_no: invoiceNo, customer: cust.name, total: totalAmount, vehicle: body.vehicle_no || "" }
      });
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "SALES_INVOICE_CREATED",
        entityType: "SALES_INVOICE",
        entityId: invoiceNo,
        afterObj: { customer: cust.name, total_amount: totalAmount, total_cogs: totalCogs },
        deviceType: body.client_type || "WEB_PWA"
      });
      const created = db.prepare("SELECT s.*, pt.name as customer_name FROM sales_invoices s JOIN parties pt ON pt.id = s.customer_id WHERE s.id = ?").get(invoiceId);
      const lineItems = db.prepare(
        `SELECT sii.*, i.name as item_name, w.name as warehouse_name
           FROM sales_invoice_items sii
           JOIN items i ON i.id = sii.item_id
           JOIN warehouses w ON w.id = sii.warehouse_id
           WHERE sii.invoice_id = ?`
      ).all(invoiceId);
      const responseObj = { status: "SYNCED", invoice: { ...created, items: lineItems } };
      recordSyncLog({
        clientUuid,
        deviceId: body.device_id || "WEB-BROWSER",
        clientType: body.client_type || "WEB_PWA",
        endpoint: "/api/v1/sales-invoices",
        status: "SYNCED",
        responseObj,
        employeeId: req.user.id
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      recordSyncLog({
        clientUuid,
        deviceId: body.device_id || "WEB-BROWSER",
        clientType: body.client_type || "WEB_PWA",
        endpoint: "/api/v1/sales-invoices",
        status: "CONFLICT",
        conflictReason: err.message,
        employeeId: req.user.id
      });
      res.status(409).json({ error: err.message, code: "INSUFFICIENT_STOCK" });
      return;
    }
    res.status(400).json({ error: err.message });
  }
});
app.get("/api/v1/weighbridge-logs", authenticate, (_req, res) => {
  const logs = db.prepare(
    `SELECT wl.*, e.full_name as operator_name
       FROM weighbridge_logs wl
       JOIN employees e ON e.id = wl.operator_id
       ORDER BY wl.id DESC LIMIT 100`
  ).all();
  res.json({ logs });
});
app.post("/api/v1/weighbridge-logs", authenticate, requirePermission("weighbridge.operate"), (req, res) => {
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }
  const net = Number((body.gross_weight_kg - body.tare_weight_kg).toFixed(3));
  if (net <= 0) {
    res.status(400).json({ error: "Net weight (Gross - Tare) must be positive" });
    return;
  }
  const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM weighbridge_logs").get().nextId;
  const ticketNo = `WB-2026-${String(100 + seq).padStart(4, "0")}`;
  const info = db.prepare(
    `INSERT INTO weighbridge_logs (client_uuid, ticket_no, vehicle_no, driver_name, gross_weight_kg, tare_weight_kg, net_weight_kg, device_mode, raw_device_string, operator_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    clientUuid,
    ticketNo,
    body.vehicle_no.trim().toUpperCase(),
    body.driver_name || "",
    body.gross_weight_kg,
    body.tare_weight_kg,
    net,
    body.device_mode || "MANUAL",
    body.raw_device_string || "MANUAL_ENTRY",
    req.user.id
  );
  const created = db.prepare("SELECT wl.*, e.full_name as operator_name FROM weighbridge_logs wl JOIN employees e ON e.id = wl.operator_id WHERE wl.id = ?").get(info.lastInsertRowid);
  const responseObj = { status: "SYNCED", log: created };
  recordSyncLog({
    clientUuid,
    deviceId: "WEIGHBRIDGE-TERMINAL",
    clientType: "WEB_PWA",
    endpoint: "/api/v1/weighbridge-logs",
    status: "SYNCED",
    responseObj,
    employeeId: req.user.id
  });
  res.status(201).json(responseObj);
});
app.get("/api/v1/qr/lookup", authenticate, (req, res) => {
  const code = String(req.query.code || "").trim();
  if (!code) {
    res.status(400).json({ error: "QR UID or entity code is required" });
    return;
  }
  const tag = db.prepare("SELECT * FROM qr_tags WHERE qr_code_uid = ? OR entity_code = ? LIMIT 1").get(code, code);
  if (!tag) {
    res.status(404).json({ error: `No lot, batch, or dispatch record found for QR "${code}"` });
    return;
  }
  const physicalOnly = isPhysicalOnlyUser(req.user);
  if (physicalOnly && ["SALES_INVOICE", "PADDY_SALE", "PRODUCTION_BATCH"].includes(tag.entity_type)) {
    res.status(403).json({ error: "Commercial dispatch and milling cost QR records are restricted for Godown Keeper" });
    return;
  }
  const parsedPayload = JSON.parse(tag.payload_json);
  res.json({
    qr_code_uid: tag.qr_code_uid,
    entity_type: tag.entity_type,
    entity_id: tag.entity_id,
    entity_code: tag.entity_code,
    payload: physicalOnly ? sanitizeQrPayloadForPhysical(parsedPayload) : parsedPayload,
    created_at: tag.created_at
  });
});
app.get("/api/v1/qr/registry", authenticate, (req, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const rows = db.prepare("SELECT * FROM qr_tags ORDER BY created_at DESC LIMIT 50").all();
  const filteredRows = physicalOnly ? rows.filter((r) => !["SALES_INVOICE", "PADDY_SALE", "PRODUCTION_BATCH"].includes(r.entity_type)) : rows;
  res.json({
    tags: filteredRows.map((r) => {
      const parsed = JSON.parse(r.payload_json);
      const safePayload = physicalOnly ? sanitizeQrPayloadForPhysical(parsed) : parsed;
      return {
        ...r,
        payload_json: JSON.stringify(safePayload),
        payload: safePayload
      };
    })
  });
});
app.get("/api/v1/accounting", authenticate, requirePermission("accounting.view"), (_req, res) => {
  const accounts = db.prepare("SELECT * FROM accounts ORDER BY account_code ASC").all();
  const payments = db.prepare(
    `SELECT pay.*, pt.name as party_name, pt.party_code, pt.party_type, a.name as account_name
       FROM payments pay
       JOIN parties pt ON pt.id = pay.party_id
       JOIN accounts a ON a.id = pay.account_id
       ORDER BY pay.id DESC LIMIT 200`
  ).all();
  const entries = db.prepare("SELECT * FROM journal_entries ORDER BY id DESC LIMIT 150").all();
  const getLines = db.prepare(
    `SELECT jl.account_id, jl.debit, jl.credit, a.account_code, a.name as account_name
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.journal_entry_id = ?`
  );
  res.json({
    accounts,
    payments,
    journal_entries: entries.map((e) => ({ ...e, lines: getLines.all(e.id) }))
  });
});
app.get("/api/v1/accounting/statements", authenticate, requirePermission("accounting.view"), (_req, res) => {
  const accounts = db.prepare("SELECT * FROM accounts ORDER BY account_code ASC").all();
  let tbDebitTotal = 0;
  let tbCreditTotal = 0;
  const tbRows = accounts.map((a) => {
    const bal = Number(a.balance || 0);
    const isDebitNormal = a.account_type === "ASSET" || a.account_type === "EXPENSE";
    let debitBal = 0;
    let creditBal = 0;
    if (isDebitNormal) {
      if (bal >= 0) debitBal = bal;
      else creditBal = Math.abs(bal);
    } else {
      if (bal >= 0) creditBal = bal;
      else debitBal = Math.abs(bal);
    }
    tbDebitTotal += debitBal;
    tbCreditTotal += creditBal;
    return {
      id: a.id,
      account_code: a.account_code,
      name: a.name,
      account_type: a.account_type,
      debit_balance: Number(debitBal.toFixed(2)),
      credit_balance: Number(creditBal.toFixed(2))
    };
  });
  const revenues = accounts.filter((a) => a.account_type === "REVENUE");
  const totalRevenue = revenues.reduce((s, a) => s + Number(a.balance || 0), 0);
  const cogs = accounts.filter((a) => a.account_type === "EXPENSE" && a.account_code === "5001");
  const totalCogs = cogs.reduce((s, a) => s + Number(a.balance || 0), 0);
  const grossProfit = totalRevenue - totalCogs;
  const expenses = accounts.filter((a) => a.account_type === "EXPENSE" && a.account_code !== "5001");
  const totalExpenses = expenses.reduce((s, a) => s + Number(a.balance || 0), 0);
  const netProfit = grossProfit - totalExpenses;
  const assets = accounts.filter((a) => a.account_type === "ASSET");
  const totalAssets = assets.reduce((s, a) => s + Number(a.balance || 0), 0);
  const liabilities = accounts.filter((a) => a.account_type === "LIABILITY");
  const totalLiabilities = liabilities.reduce((s, a) => s + Number(a.balance || 0), 0);
  const equity = accounts.filter((a) => a.account_type === "EQUITY");
  const totalEquity = equity.reduce((s, a) => s + Number(a.balance || 0), 0);
  const totalLiabAndEq = totalLiabilities + totalEquity + netProfit;
  res.json({
    trial_balance: {
      rows: tbRows,
      total_debit: Number(tbDebitTotal.toFixed(2)),
      total_credit: Number(tbCreditTotal.toFixed(2)),
      is_balanced: Math.abs(tbDebitTotal - tbCreditTotal) < 0.05
    },
    profit_and_loss: {
      revenues,
      total_revenue: Number(totalRevenue.toFixed(2)),
      cogs,
      total_cogs: Number(totalCogs.toFixed(2)),
      gross_profit: Number(grossProfit.toFixed(2)),
      expenses,
      total_expenses: Number(totalExpenses.toFixed(2)),
      net_profit: Number(netProfit.toFixed(2))
    },
    balance_sheet: {
      assets,
      total_assets: Number(totalAssets.toFixed(2)),
      liabilities,
      total_liabilities: Number(totalLiabilities.toFixed(2)),
      equity,
      total_equity: Number(totalEquity.toFixed(2)),
      current_net_profit: Number(netProfit.toFixed(2)),
      total_liabilities_and_equity: Number(totalLiabAndEq.toFixed(2)),
      is_balanced: Math.abs(totalAssets - totalLiabAndEq) < 0.05
    }
  });
});
app.get("/api/v1/accounting/cashbook", authenticate, requirePermission("accounting.view"), (req, res) => {
  const fromRaw = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const toRaw = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const accountParam = typeof req.query.account_id === "string" ? req.query.account_id.trim() : "ALL";
  const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (fromRaw && !isoDateRe.test(fromRaw) || toRaw && !isoDateRe.test(toRaw)) {
    res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
    return;
  }
  let cashBankAccounts = db.prepare(
    `SELECT * FROM accounts
       WHERE account_type = 'ASSET'
         AND account_code NOT IN ('1100', '1200')
         AND (
           account_code LIKE '10%'
           OR lower(name) LIKE '%cash%'
           OR lower(name) LIKE '%bank%'
           OR lower(name) LIKE '%petty%'
           OR lower(name) LIKE '%upi%'
           OR lower(name) LIKE '%bkash%'
           OR lower(name) LIKE '%nagad%'
         )
       ORDER BY account_code ASC`
  ).all();
  if (cashBankAccounts.length === 0) {
    cashBankAccounts = db.prepare(`SELECT * FROM accounts WHERE account_code IN ('1001', '1002') ORDER BY account_code ASC`).all();
  }
  let targetIds = cashBankAccounts.map((a) => a.id);
  let selectedAccountId = "ALL";
  if (accountParam && accountParam !== "ALL") {
    const parsedId = Number(accountParam);
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      res.status(400).json({ error: "Invalid account_id parameter." });
      return;
    }
    const found = cashBankAccounts.find((a) => a.id === parsedId);
    if (!found) {
      res.status(404).json({ error: "Cash/Bank account not found." });
      return;
    }
    targetIds = [found.id];
    selectedAccountId = found.id;
  }
  let openingBalance = 0;
  let rows = [];
  if (targetIds.length > 0) {
    const placeholders = targetIds.map(() => "?").join(", ");
    if (fromRaw) {
      const openRow = db.prepare(
        `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) as bal
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.journal_entry_id
           WHERE jl.account_id IN (${placeholders}) AND date(je.entry_date) < date(?)`
      ).get(...targetIds, fromRaw);
      openingBalance = Number(Number(openRow?.bal || 0).toFixed(2));
    }
    const whereParts = [`jl.account_id IN (${placeholders})`];
    const params = [...targetIds];
    if (fromRaw) {
      whereParts.push("date(je.entry_date) >= date(?)");
      params.push(fromRaw);
    }
    if (toRaw) {
      whereParts.push("date(je.entry_date) <= date(?)");
      params.push(toRaw);
    }
    rows = db.prepare(
      `SELECT jl.id, jl.journal_entry_id, jl.account_id, a.account_code, a.name as account_name,
                je.voucher_no, je.entry_date, je.description, je.reference_type, je.created_at,
                jl.debit, jl.credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id
         JOIN accounts a ON a.id = jl.account_id
         WHERE ${whereParts.join(" AND ")}
         ORDER BY date(je.entry_date) ASC, je.id ASC, jl.id ASC`
    ).all(...params);
  }
  const contraStmt = db.prepare(
    `SELECT a.account_code, a.name as account_name
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.journal_entry_id = ? AND jl.id != ?`
  );
  const contraCache = /* @__PURE__ */ new Map();
  let running = openingBalance;
  let totalReceipts = 0;
  let totalPayments = 0;
  const entries = rows.map((r) => {
    const receipt = Number(r.debit || 0);
    const payment = Number(r.credit || 0);
    totalReceipts += receipt;
    totalPayments += payment;
    running = Number((running + receipt - payment).toFixed(2));
    const cacheKey = `${r.journal_entry_id}:${r.id}`;
    let contraHead = contraCache.get(cacheKey);
    if (contraHead === void 0) {
      const others = contraStmt.all(r.journal_entry_id, r.id);
      contraHead = others.map((o) => `${o.account_code} ${o.account_name}`).join(", ");
      contraCache.set(cacheKey, contraHead);
    }
    return {
      id: r.id,
      journal_entry_id: r.journal_entry_id,
      account_id: r.account_id,
      account_code: r.account_code,
      account_name: r.account_name,
      voucher_no: r.voucher_no,
      entry_date: r.entry_date,
      description: r.description,
      contra_head: contraHead,
      reference_type: r.reference_type || "",
      created_at: r.created_at || r.entry_date,
      receipt: Number(receipt.toFixed(2)),
      payment: Number(payment.toFixed(2)),
      running_balance: running
    };
  });
  let cashClosing = 0;
  let bankClosing = 0;
  const balStmt = toRaw ? db.prepare(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) as bal
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id
         WHERE jl.account_id = ? AND date(je.entry_date) <= date(?)`
  ) : null;
  for (const acc of cashBankAccounts) {
    const bal = toRaw ? Number((balStmt.get(acc.id, toRaw)?.bal || 0).toFixed(2)) : Number(acc.balance || 0);
    const isCashAcc = acc.account_code === "1001" || /cash|petty/i.test(acc.name);
    if (isCashAcc) cashClosing += bal;
    else bankClosing += bal;
  }
  res.json({
    from: fromRaw || null,
    to: toRaw || null,
    account_id: selectedAccountId,
    accounts: cashBankAccounts,
    opening_balance: openingBalance,
    total_receipts: Number(totalReceipts.toFixed(2)),
    total_payments: Number(totalPayments.toFixed(2)),
    net_change: Number((totalReceipts - totalPayments).toFixed(2)),
    closing_balance: running,
    cash_closing: Number(cashClosing.toFixed(2)),
    bank_closing: Number(bankClosing.toFixed(2)),
    entries
  });
});
app.get("/api/v1/accounts/:id/ledger", authenticate, requirePermission("accounting.view"), (req, res) => {
  const accountId = Number(req.params.id);
  const fromRaw = typeof req.query.from === "string" ? req.query.from.trim() : "";
  const toRaw = typeof req.query.to === "string" ? req.query.to.trim() : "";
  const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
  if (fromRaw && !isoDateRe.test(fromRaw) || toRaw && !isoDateRe.test(toRaw)) {
    res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });
    return;
  }
  const account = db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId);
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const isDebitNormal = account.account_type === "ASSET" || account.account_type === "EXPENSE";
  let openingBalance = 0;
  if (fromRaw) {
    const openRow = db.prepare(
      `SELECT COALESCE(SUM(jl.debit), 0) as dr, COALESCE(SUM(jl.credit), 0) as cr
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id
         WHERE jl.account_id = ? AND date(je.entry_date) < date(?)`
    ).get(accountId, fromRaw);
    const dr = Number(openRow?.dr || 0);
    const cr = Number(openRow?.cr || 0);
    openingBalance = Number((isDebitNormal ? dr - cr : cr - dr).toFixed(2));
  }
  const whereParts = ["jl.account_id = ?"];
  const params = [accountId];
  if (fromRaw) {
    whereParts.push("date(je.entry_date) >= date(?)");
    params.push(fromRaw);
  }
  if (toRaw) {
    whereParts.push("date(je.entry_date) <= date(?)");
    params.push(toRaw);
  }
  const rows = db.prepare(
    `SELECT jl.id, jl.journal_entry_id, je.voucher_no, je.entry_date, je.description, je.reference_type, jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       WHERE ${whereParts.join(" AND ")}
       ORDER BY date(je.entry_date) ASC, je.id ASC, jl.id ASC`
  ).all(...params);
  const contraStmt = db.prepare(
    `SELECT a.account_code, a.name as account_name
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.journal_entry_id = ? AND jl.id != ?`
  );
  let running = openingBalance;
  let totalDebit = 0;
  let totalCredit = 0;
  const ledger = rows.map((r) => {
    const dr = Number(r.debit || 0);
    const cr = Number(r.credit || 0);
    totalDebit += dr;
    totalCredit += cr;
    running = Number((running + (isDebitNormal ? dr - cr : cr - dr)).toFixed(2));
    const others = contraStmt.all(r.journal_entry_id, r.id);
    return {
      ...r,
      contra_head: others.map((o) => `${o.account_code} ${o.account_name}`).join(", "),
      running_balance: running
    };
  });
  res.json({
    account,
    from: fromRaw || null,
    to: toRaw || null,
    opening_balance: openingBalance,
    total_debit: Number(totalDebit.toFixed(2)),
    total_credit: Number(totalCredit.toFixed(2)),
    closing_balance: running,
    entries: ledger
  });
});
app.post("/api/v1/accounts", authenticate, requirePermission("accounting.post"), (req, res) => {
  const body = req.body;
  const code = String(body.account_code || "").trim().toUpperCase();
  const name = String(body.name || "").trim();
  const validTypes = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"];
  if (!code || !name || !validTypes.includes(body.account_type)) {
    res.status(400).json({ error: "Account code, name, and valid account type are required" });
    return;
  }
  try {
    const created = db.transaction(() => {
      const existing = db.prepare("SELECT id FROM accounts WHERE account_code = ?").get(code);
      if (existing) throw new Error(`Account code ${code} already exists`);
      const info = db.prepare("INSERT INTO accounts (account_code, name, account_type, balance, is_system) VALUES (?, ?, ?, 0, 0)").run(code, name, body.account_type);
      const accountId = Number(info.lastInsertRowid);
      const opening = Number(body.opening_balance || 0);
      if (opening > 0 && code !== "3001") {
        const isDebitNormal = body.account_type === "ASSET" || body.account_type === "EXPENSE";
        postJournalEntry({
          description: `Opening Balance \u2014 ${code} ${name}`,
          referenceType: "OPENING_BALANCE",
          referenceId: accountId,
          employeeId: req.user.id,
          lines: isDebitNormal ? [
            { accountCode: code, debit: opening, credit: 0 },
            { accountCode: "3001", debit: 0, credit: opening }
          ] : [
            { accountCode: "3001", debit: opening, credit: 0 },
            { accountCode: code, debit: 0, credit: opening }
          ]
        });
      }
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "GL_ACCOUNT_CREATED",
        entityType: "ACCOUNT",
        entityId: code,
        afterObj: { code, name, account_type: body.account_type, opening_balance: opening }
      });
      return db.prepare("SELECT * FROM accounts WHERE id = ?").get(accountId);
    })();
    res.status(201).json({ account: created });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.put("/api/v1/accounts/:id", authenticate, requirePermission("accounting.post"), (req, res) => {
  const id = Number(req.params.id);
  const body = req.body;
  const name = String(body.name || "").trim();
  if (!name) {
    res.status(400).json({ error: "Account name is required" });
    return;
  }
  const acc = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
  if (!acc) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  db.prepare("UPDATE accounts SET name = ? WHERE id = ?").run(name, id);
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: "GL_ACCOUNT_UPDATED",
    entityType: "ACCOUNT",
    entityId: acc.account_code,
    beforeObj: { name: acc.name },
    afterObj: { name }
  });
  res.json({ account: db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) });
});
app.post("/api/v1/payments", authenticate, requirePermission("accounting.post"), (req, res) => {
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }
  if (!body.party_id || !body.account_id || Number(body.amount) <= 0) {
    res.status(400).json({ error: "Party, account, and positive payment amount are required" });
    return;
  }
  const voucherType = body.voucher_type || (body.direction === "RECEIPT" ? "DUE_RECEIPT" : "DUE_PAYMENT");
  const direction = voucherType === "DUE_RECEIPT" || voucherType === "ADVANCE_RECEIPT" ? "RECEIPT" : voucherType === "DUE_PAYMENT" || voucherType === "ADVANCE_PAYMENT" ? "PAYMENT" : body.direction === "RECEIPT" ? "RECEIPT" : "PAYMENT";
  try {
    const result = db.transaction(() => {
      const party = db.prepare("SELECT id, name, party_type FROM parties WHERE id = ?").get(body.party_id);
      if (!party) throw new Error("Selected customer/supplier does not exist");
      const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM payments").get().nextId;
      const prefix = voucherType === "ADVANCE_RECEIPT" || voucherType === "ADVANCE_PAYMENT" ? direction === "RECEIPT" ? "AVR" : "AVP" : direction === "RECEIPT" ? "RCP" : "PAY";
      const paymentNo = `${prefix}-2026-${String(seq).padStart(4, "0")}`;
      const acc = db.prepare("SELECT account_code, name FROM accounts WHERE id = ?").get(body.account_id);
      if (!acc) throw new Error("Invalid cash/bank account");
      const amount = Number(Number(body.amount).toFixed(2));
      const settledRefs = [];
      if (voucherType === "DUE_PAYMENT") {
        let rem = amount;
        const targetRef = body.settled_ref_no?.trim();
        const purchases = db.prepare(
          `SELECT id, purchase_no, total_payable, paid_amount
             FROM paddy_purchases
             WHERE supplier_id = ? AND payment_status != 'PAID'
             ORDER BY CASE WHEN purchase_no = ? THEN 0 ELSE 1 END, datetime(created_at) ASC, id ASC`
        ).all(body.party_id, targetRef || "");
        for (const p of purchases) {
          if (rem <= 0.01) break;
          if (targetRef && p.purchase_no !== targetRef) continue;
          const openAmt = Number((p.total_payable - p.paid_amount).toFixed(2));
          if (openAmt <= 0) continue;
          const alloc = Math.min(rem, openAmt);
          const nextPaid = Number((p.paid_amount + alloc).toFixed(2));
          const nextStatus = nextPaid >= p.total_payable - 0.01 ? "PAID" : "PARTIAL";
          db.prepare("UPDATE paddy_purchases SET paid_amount = ?, payment_status = ? WHERE id = ?").run(nextPaid, nextStatus, p.id);
          settledRefs.push(p.purchase_no);
          rem = Number((rem - alloc).toFixed(2));
        }
      } else if (voucherType === "DUE_RECEIPT") {
        let rem = amount;
        const targetRef = body.settled_ref_no?.trim();
        const openSales = [
          ...db.prepare(
            `SELECT 'INV' as kind, id, invoice_no as ref_no, total_amount, paid_amount, created_at
               FROM sales_invoices WHERE customer_id = ? AND payment_status != 'PAID'`
          ).all(body.party_id),
          ...db.prepare(
            `SELECT 'PDS' as kind, id, sale_no as ref_no, total_amount, paid_amount, created_at
               FROM paddy_sales WHERE customer_id = ? AND payment_status != 'PAID'`
          ).all(body.party_id)
        ].sort((a, b) => {
          if (targetRef && a.ref_no === targetRef) return -1;
          if (targetRef && b.ref_no === targetRef) return 1;
          return a.created_at.localeCompare(b.created_at);
        });
        for (const s of openSales) {
          if (rem <= 0.01) break;
          if (targetRef && s.ref_no !== targetRef) continue;
          const openAmt = Number((s.total_amount - s.paid_amount).toFixed(2));
          if (openAmt <= 0) continue;
          const alloc = Math.min(rem, openAmt);
          const nextPaid = Number((s.paid_amount + alloc).toFixed(2));
          const nextStatus = nextPaid >= s.total_amount - 0.01 ? "PAID" : "PARTIAL";
          if (s.kind === "INV") {
            db.prepare("UPDATE sales_invoices SET paid_amount = ?, payment_status = ? WHERE id = ?").run(nextPaid, nextStatus, s.id);
          } else {
            db.prepare("UPDATE paddy_sales SET paid_amount = ?, payment_status = ? WHERE id = ?").run(nextPaid, nextStatus, s.id);
          }
          settledRefs.push(s.ref_no);
          rem = Number((rem - alloc).toFixed(2));
        }
      }
      const finalSettledRef = body.settled_ref_no?.trim() || settledRefs.join(", ");
      const info = db.prepare(
        `INSERT INTO payments (client_uuid, payment_no, direction, voucher_type, party_id, account_id, amount, payment_mode, reference_no, settled_ref_no, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        clientUuid,
        paymentNo,
        direction,
        voucherType,
        body.party_id,
        body.account_id,
        amount,
        body.payment_mode,
        body.reference_no || "",
        finalSettledRef,
        body.notes || "",
        req.user.id
      );
      const payId = Number(info.lastInsertRowid);
      const labelMap = {
        DUE_RECEIPT: "Customer Due Receipt",
        ADVANCE_RECEIPT: "Customer Advance Receipt",
        DUE_PAYMENT: "Supplier Due Payment",
        ADVANCE_PAYMENT: "Supplier Advance Payment",
        DUE_SETTLEMENT: direction === "RECEIPT" ? "Customer Receipt" : "Supplier Payment"
      };
      const label = labelMap[voucherType] || direction;
      if (direction === "RECEIPT") {
        db.prepare("UPDATE parties SET current_balance = current_balance - ? WHERE id = ?").run(amount, body.party_id);
        postJournalEntry({
          description: `${label} ${paymentNo} - ${party.name} (${body.payment_mode})`,
          referenceType: "PAYMENT",
          referenceId: payId,
          employeeId: req.user.id,
          lines: [
            { accountCode: acc.account_code, debit: amount, credit: 0 },
            { accountCode: "1100", debit: 0, credit: amount, partyId: body.party_id }
          ]
        });
      } else {
        db.prepare("UPDATE parties SET current_balance = current_balance + ? WHERE id = ?").run(amount, body.party_id);
        postJournalEntry({
          description: `${label} ${paymentNo} - ${party.name} (${body.payment_mode})`,
          referenceType: "PAYMENT",
          referenceId: payId,
          employeeId: req.user.id,
          lines: [
            { accountCode: "2001", debit: amount, credit: 0, partyId: body.party_id },
            { accountCode: acc.account_code, debit: 0, credit: amount }
          ]
        });
      }
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: `FINANCE_${voucherType}`,
        entityType: "PAYMENT",
        entityId: paymentNo,
        afterObj: { amount, party_id: body.party_id, voucher_type: voucherType, mode: body.payment_mode, settled_ref_no: finalSettledRef }
      });
      const created = db.prepare(
        `SELECT pay.*, pt.name as party_name, pt.party_code, pt.party_type, a.name as account_name
           FROM payments pay
           JOIN parties pt ON pt.id = pay.party_id
           JOIN accounts a ON a.id = pay.account_id
           WHERE pay.id = ?`
      ).get(payId);
      const responseObj = { status: "SYNCED", payment: created };
      recordSyncLog({
        clientUuid,
        deviceId: "WEB-BROWSER",
        clientType: "WEB_PWA",
        endpoint: "/api/v1/payments",
        status: "SYNCED",
        responseObj,
        employeeId: req.user.id
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/v1/expenses", authenticate, requirePermission("accounting.post"), (req, res) => {
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }
  const amount = Number(Number(body.amount || 0).toFixed(2));
  if (!body.expense_account_id || !body.paid_from_account_id || amount <= 0) {
    res.status(400).json({ error: "Expense account, Cash/Bank account, and positive amount are required" });
    return;
  }
  try {
    const result = db.transaction(() => {
      const expAcc = db.prepare("SELECT id, account_code, name, account_type FROM accounts WHERE id = ?").get(body.expense_account_id);
      const payAcc = db.prepare("SELECT id, account_code, name, account_type FROM accounts WHERE id = ?").get(body.paid_from_account_id);
      if (!expAcc || !payAcc) throw new Error("Invalid expense or payment account");
      if (expAcc.id === payAcc.id) throw new Error("Expense account and payment account must be different");
      const desc = `Expense: ${expAcc.name}${body.payee_name ? ` (${body.payee_name})` : ""}${body.payment_mode ? ` \xB7 ${body.payment_mode}` : ""}${body.reference_no ? ` \xB7 Ref: ${body.reference_no}` : ""}${body.notes ? ` \u2014 ${body.notes}` : ""}`;
      const jeId = postJournalEntry({
        clientUuid,
        description: desc,
        referenceType: "EXPENSE",
        referenceId: expAcc.id,
        employeeId: req.user.id,
        entryDate: body.entry_date,
        voucherPrefix: "EXP",
        lines: [
          { accountCode: expAcc.account_code, debit: amount, credit: 0 },
          { accountCode: payAcc.account_code, debit: 0, credit: amount }
        ]
      });
      const entry = db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(jeId);
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "EXPENSE_POSTED",
        entityType: "EXPENSE",
        entityId: entry.voucher_no,
        afterObj: { amount, expense_account: expAcc.account_code, paid_from: payAcc.account_code, payee: body.payee_name }
      });
      const responseObj = { status: "SYNCED", journal_entry: entry, amount };
      recordSyncLog({
        clientUuid,
        deviceId: "WEB-BROWSER",
        clientType: "WEB_PWA",
        endpoint: "/api/v1/expenses",
        status: "SYNCED",
        responseObj,
        employeeId: req.user.id
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/v1/contra-transfers", authenticate, requirePermission("accounting.post"), (req, res) => {
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }
  const amount = Number(Number(body.amount || 0).toFixed(2));
  if (!body.from_account_id || !body.to_account_id || amount <= 0) {
    res.status(400).json({ error: "Source account, destination account, and positive amount are required" });
    return;
  }
  if (body.from_account_id === body.to_account_id) {
    res.status(400).json({ error: "Source and destination accounts cannot be the same" });
    return;
  }
  try {
    const result = db.transaction(() => {
      const fromAcc = db.prepare("SELECT id, account_code, name, account_type FROM accounts WHERE id = ?").get(body.from_account_id);
      const toAcc = db.prepare("SELECT id, account_code, name, account_type FROM accounts WHERE id = ?").get(body.to_account_id);
      if (!fromAcc || !toAcc) throw new Error("Invalid source or destination account");
      const desc = `Contra Transfer: ${fromAcc.name} \u2192 ${toAcc.name}${body.reference_no ? ` \xB7 Ref: ${body.reference_no}` : ""}${body.notes ? ` \u2014 ${body.notes}` : ""}`;
      const jeId = postJournalEntry({
        clientUuid,
        description: desc,
        referenceType: "CONTRA",
        referenceId: toAcc.id,
        employeeId: req.user.id,
        entryDate: body.entry_date,
        voucherPrefix: "CTR",
        lines: [
          { accountCode: toAcc.account_code, debit: amount, credit: 0 },
          { accountCode: fromAcc.account_code, debit: 0, credit: amount }
        ]
      });
      const entry = db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(jeId);
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "CONTRA_TRANSFER_POSTED",
        entityType: "CONTRA",
        entityId: entry.voucher_no,
        afterObj: { amount, from: fromAcc.account_code, to: toAcc.account_code }
      });
      const responseObj = { status: "SYNCED", journal_entry: entry, amount };
      recordSyncLog({
        clientUuid,
        deviceId: "WEB-BROWSER",
        clientType: "WEB_PWA",
        endpoint: "/api/v1/contra-transfers",
        status: "SYNCED",
        responseObj,
        employeeId: req.user.id
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/v1/journal-entries", authenticate, requirePermission("accounting.post"), (req, res) => {
  const body = req.body;
  const clientUuid = body.client_uuid || crypto3.randomUUID();
  const idem = checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }
  if (!body.description?.trim() || !Array.isArray(body.lines) || body.lines.length < 2) {
    res.status(400).json({ error: "Description and at least 2 journal lines are required" });
    return;
  }
  try {
    const result = db.transaction(() => {
      const resolvedLines = [];
      for (const l of body.lines) {
        const dr = Number(Number(l.debit || 0).toFixed(2));
        const cr = Number(Number(l.credit || 0).toFixed(2));
        if (dr < 0 || cr < 0 || dr > 0 && cr > 0) {
          throw new Error("Each journal line must have either non-negative debit OR credit");
        }
        if (dr === 0 && cr === 0) continue;
        const acc = db.prepare("SELECT account_code FROM accounts WHERE id = ?").get(l.account_id);
        if (!acc) throw new Error(`Account ID ${l.account_id} not found`);
        resolvedLines.push({ accountCode: acc.account_code, debit: dr, credit: cr });
      }
      if (resolvedLines.length < 2) throw new Error("At least 2 non-zero lines are required");
      const jeId = postJournalEntry({
        clientUuid,
        description: body.description.trim(),
        referenceType: "MANUAL_JV",
        referenceId: 0,
        employeeId: req.user.id,
        entryDate: body.entry_date,
        voucherPrefix: "JV",
        lines: resolvedLines
      });
      const entry = db.prepare("SELECT * FROM journal_entries WHERE id = ?").get(jeId);
      writeAuditLog({
        employeeId: req.user.id,
        employeeName: req.user.full_name,
        action: "MANUAL_JOURNAL_POSTED",
        entityType: "JOURNAL_ENTRY",
        entityId: entry.voucher_no,
        afterObj: { description: body.description, lines: resolvedLines }
      });
      const responseObj = { status: "SYNCED", journal_entry: entry };
      recordSyncLog({
        clientUuid,
        deviceId: "WEB-BROWSER",
        clientType: "WEB_PWA",
        endpoint: "/api/v1/journal-entries",
        status: "SYNCED",
        responseObj,
        employeeId: req.user.id
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get("/api/v1/employees", authenticate, requirePermission("employees.manage"), (_req, res) => {
  const employees = db.prepare(
    `SELECT e.id, e.employee_code, e.full_name, e.email, e.phone, e.role_id, e.is_active, e.last_login_at,
              r.code as role_code, r.name as role_name
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       ORDER BY e.id ASC`
  ).all();
  const roles = db.prepare("SELECT * FROM roles ORDER BY id ASC").all();
  const permissions = db.prepare("SELECT * FROM permissions ORDER BY module ASC, id ASC").all();
  const rolePerms = db.prepare("SELECT * FROM role_permissions").all();
  res.json({ employees, roles, permissions, role_permissions: rolePerms });
});
app.post("/api/v1/employees", authenticate, requirePermission("employees.manage"), (req, res) => {
  const { full_name, email, phone, password, role_id } = req.body;
  if (!full_name || !email || !password || !role_id) {
    res.status(400).json({ error: "Name, email, password, and role are required" });
    return;
  }
  try {
    const seq = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM employees").get().nextId;
    const empCode = `EMP-${String(seq).padStart(3, "0")}`;
    const hash = bcrypt2.hashSync(password, 10);
    const info = db.prepare("INSERT INTO employees (employee_code, full_name, email, phone, password_hash, role_id) VALUES (?, ?, ?, ?, ?, ?)").run(empCode, full_name.trim(), email.trim().toLowerCase(), phone || "", hash, role_id);
    writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: "CREATE_EMPLOYEE",
      entityType: "EMPLOYEE",
      entityId: empCode,
      afterObj: { full_name, email, role_id }
    });
    const created = db.prepare(
      `SELECT e.id, e.employee_code, e.full_name, e.email, e.phone, e.role_id, e.is_active, r.code as role_code, r.name as role_name
         FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?`
    ).get(info.lastInsertRowid);
    res.status(201).json({ employee: created });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.put("/api/v1/employees/:id", authenticate, requirePermission("employees.manage"), (req, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    res.status(400).json({ error: "Invalid employee ID" });
    return;
  }
  const { full_name, email, phone, role_id, is_active, password } = req.body;
  const existing = db.prepare(
    `SELECT e.id, e.employee_code, e.full_name, e.email, e.phone, e.role_id, e.is_active, r.code as role_code
       FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?`
  ).get(targetId);
  if (!existing) {
    res.status(404).json({ error: "Employee not found" });
    return;
  }
  const nextName = (full_name ?? existing.full_name).trim();
  const nextEmail = (email ?? existing.email).trim().toLowerCase();
  const nextPhone = phone !== void 0 ? String(phone).trim() : existing.phone || "";
  const nextRoleId = role_id !== void 0 ? Number(role_id) : existing.role_id;
  const nextActive = is_active !== void 0 ? is_active ? 1 : 0 : existing.is_active;
  if (!nextName || !nextEmail) {
    res.status(400).json({ error: "Full name and email are required" });
    return;
  }
  const targetRole = db.prepare("SELECT id, code FROM roles WHERE id = ?").get(nextRoleId);
  if (!targetRole) {
    res.status(400).json({ error: "Invalid role selected" });
    return;
  }
  if (existing.role_code === "OWNER" && existing.is_active === 1 && (targetRole.code !== "OWNER" || nextActive !== 1)) {
    const otherActiveOwners = db.prepare(
      `SELECT COUNT(*) as c FROM employees e
           JOIN roles r ON r.id = e.role_id
           WHERE r.code = 'OWNER' AND e.is_active = 1 AND e.id != ?`
    ).get(targetId).c;
    if (otherActiveOwners < 1) {
      res.status(400).json({ error: "Cannot deactivate or demote the last active Mill Owner account" });
      return;
    }
  }
  if (password !== void 0 && password.trim().length > 0 && password.trim().length < 6) {
    res.status(400).json({ error: "New password must be at least 6 characters" });
    return;
  }
  try {
    if (password !== void 0 && password.trim().length >= 6) {
      const hash = bcrypt2.hashSync(password.trim(), 10);
      db.prepare(
        "UPDATE employees SET full_name = ?, email = ?, phone = ?, role_id = ?, is_active = ?, password_hash = ? WHERE id = ?"
      ).run(nextName, nextEmail, nextPhone, nextRoleId, nextActive, hash, targetId);
    } else {
      db.prepare(
        "UPDATE employees SET full_name = ?, email = ?, phone = ?, role_id = ?, is_active = ? WHERE id = ?"
      ).run(nextName, nextEmail, nextPhone, nextRoleId, nextActive, targetId);
    }
    writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: "UPDATE_EMPLOYEE",
      entityType: "EMPLOYEE",
      entityId: existing.employee_code,
      beforeObj: {
        full_name: existing.full_name,
        email: existing.email,
        role_id: existing.role_id,
        is_active: existing.is_active
      },
      afterObj: {
        full_name: nextName,
        email: nextEmail,
        role_id: nextRoleId,
        is_active: nextActive,
        password_changed: Boolean(password && password.trim().length >= 6)
      }
    });
    const updated = db.prepare(
      `SELECT e.id, e.employee_code, e.full_name, e.email, e.phone, e.role_id, e.is_active, e.last_login_at,
                r.code as role_code, r.name as role_name
         FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?`
    ).get(targetId);
    res.json({ employee: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.get("/api/v1/audit-logs", authenticate, requirePermission("audit.view"), (_req, res) => {
  const logs = db.prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 150").all();
  const syncLogs = db.prepare(
    `SELECT s.*, e.full_name as employee_name
       FROM sync_logs s
       JOIN employees e ON e.id = s.employee_id
       ORDER BY s.id DESC LIMIT 100`
  ).all();
  res.json({ audit_logs: logs, sync_logs: syncLogs });
});
app.get("/api/v1/backups", authenticate, requirePermission("backup.manage"), (_req, res) => {
  const history = db.prepare(
    `SELECT b.*, e.full_name as created_by_name
       FROM backup_history b
       JOIN employees e ON e.id = b.created_by
       ORDER BY b.id DESC LIMIT 30`
  ).all();
  res.json({ backups: history });
});
app.post("/api/v1/backups/export", authenticate, requirePermission("backup.manage"), (req, res) => {
  const tables = [
    "company_settings",
    "roles",
    "permissions",
    "employees",
    "warehouses",
    "product_units",
    "product_categories",
    "parties",
    "items",
    "inventory_lots",
    "paddy_purchases",
    "supplier_bag_ledger",
    "stock_transfers",
    "paddy_sales",
    "paddy_drying_batches",
    "production_batches",
    "production_batch_inputs",
    "production_cost_sheets",
    "production_batch_expenses",
    "production_expense_payments",
    "sales_invoices",
    "sales_invoice_lot_allocations",
    "accounts",
    "journal_entries",
    "payments",
    "audit_logs"
  ];
  const snapshot = {};
  for (const t of tables) {
    snapshot[t] = db.prepare(`SELECT * FROM ${t}`).all();
  }
  const payloadStr = JSON.stringify({ exported_at: (/* @__PURE__ */ new Date()).toISOString(), db_file_bytes: fs2.statSync(DB_PATH).size, tables: snapshot }, null, 2);
  const backupName = `sonagrain-backup-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.json`;
  db.prepare("INSERT INTO backup_history (backup_name, file_size_bytes, created_by) VALUES (?, ?, ?)").run(
    backupName,
    Buffer.byteLength(payloadStr, "utf8"),
    req.user.id
  );
  writeAuditLog({
    employeeId: req.user.id,
    employeeName: req.user.full_name,
    action: "DATABASE_BACKUP_EXPORTED",
    entityType: "BACKUP",
    entityId: backupName,
    afterObj: { bytes: Buffer.byteLength(payloadStr, "utf8") }
  });
  res.json({ backup_name: backupName, snapshot: JSON.parse(payloadStr) });
});
app.post("/api/v1/admin/clear-all-data", authenticate, requirePermission("backup.manage"), (req, res) => {
  const body = req.body;
  const scope = body.scope === "TRANSACTIONS_ONLY" ? "TRANSACTIONS_ONLY" : "ALL_DATA";
  const clearedTables = db.transaction(() => {
    const transactionalTables = [
      "sales_invoice_lot_allocations",
      "stock_ledger",
      "production_outputs",
      "production_expense_payments",
      "production_batch_expenses",
      "production_batch_inputs",
      "production_cost_sheets",
      "production_batches",
      "paddy_drying_batches",
      "sales_invoice_items",
      "sales_invoices",
      "paddy_sales",
      "stock_transfers",
      "supplier_bag_ledger",
      "paddy_purchases",
      "weighbridge_logs",
      "inventory_lots",
      "qr_tags",
      "journal_lines",
      "journal_entries",
      "payments",
      "sync_logs",
      "backup_history",
      "audit_logs"
    ];
    for (const tbl of transactionalTables) {
      db.prepare(`DELETE FROM ${tbl}`).run();
    }
    db.prepare("UPDATE accounts SET balance = 0").run();
    const masterTables = ["parties", "items", "warehouses", "product_categories", "product_units"];
    if (scope === "ALL_DATA") {
      for (const tbl of masterTables) {
        db.prepare(`DELETE FROM ${tbl}`).run();
      }
    } else {
      db.prepare("UPDATE parties SET opening_balance = 0, current_balance = 0").run();
    }
    const seqResetTables = scope === "ALL_DATA" ? [...transactionalTables, ...masterTables] : transactionalTables;
    const resetSeqStmt = db.prepare("DELETE FROM sqlite_sequence WHERE name = ?");
    for (const tbl of seqResetTables) {
      resetSeqStmt.run(tbl);
    }
    writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: scope === "ALL_DATA" ? "ALL_DATA_CLEARED" : "TRANSACTIONS_CLEARED",
      entityType: "SYSTEM",
      entityId: scope,
      afterObj: { scope, preserved: ["employees", "roles", "permissions", "accounts_structure"] }
    });
    return seqResetTables;
  })();
  res.json({
    cleared: true,
    scope,
    cleared_tables: clearedTables
  });
});
async function startServer() {
  const httpServer = http.createServer(app);
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: { server: httpServer }
      },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path2.resolve(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path2.join(distPath, "index.html"));
    });
  }
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`SonaGrain Rice Mill ERP running on http://0.0.0.0:${PORT}`);
  });
}
startServer();
