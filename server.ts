import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import http from 'http';
import jwt from 'jsonwebtoken';
import path from 'path';
import {
  db,
  dbEngine,
  DB_PATH,
  getOrCreateServerJwtSecret,
  initDatabase,
  isMysql,
  isPostgres,
  resetAutoIncrement,
  syncPostgresSequences,
} from './server/db.ts';
import {
  checkIdempotency,
  consumePendingWeightLot,
  consumeWarehouseStock,
  createInventoryLot,
  InsufficientStockError,
  postJournalEntry,
  recordSyncLog,
  registerQrTag,
  writeAuditLog,
} from './server/services/erpEngine.ts';
import {
  dispatchPaddyPurchaseSms,
  getSmsGatewayStoredConfig,
  maskSmsConfig,
  recordSmsLog,
  saveSmsGatewayConfig,
  sendTestSmsMessage,
  type AutoSmsResult,
} from './server/services/smsService.ts';
import type { CostingMethod } from './src/types/erp.ts';

dotenv.config();

let JWT_SECRET = (process.env.JWT_SECRET || '').trim() || crypto.randomBytes(32).toString('hex');
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);

interface AuthPayload {
  id: number;
  employee_code: string;
  full_name: string;
  email: string;
  role_id: number;
  role_code: string;
  role_name: string;
  permissions: string[];
}

interface AuthedRequest extends Request {
  user?: AuthPayload;
}

async function getEmployeeWithPermissions(employeeId: number): Promise<AuthPayload | null> {
  const emp = (await db
    .prepare(
      `SELECT e.id, e.employee_code, e.full_name, e.email, e.role_id, e.is_active,
              r.code as role_code, r.name as role_name
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       WHERE e.id = ?`
    )
    .get(employeeId)) as (AuthPayload & { is_active: number }) | undefined;

  if (!emp || !emp.is_active) return null;

  const permRows = (await db
    .prepare(
      `SELECT p.perm_key FROM role_permissions rp
       JOIN permissions p ON p.id = rp.permission_id
       WHERE rp.role_id = ?`
    )
    .all(emp.role_id)) as Array<{ perm_key: string }>;

  return {
    id: emp.id,
    employee_code: emp.employee_code,
    full_name: emp.full_name,
    email: emp.email,
    role_id: emp.role_id,
    role_code: emp.role_code,
    role_name: emp.role_name,
    permissions: permRows.map((p) => p.perm_key),
  };
}

async function authenticate(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication token required' });
    return;
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as unknown as { sub: number };
    const user = await getEmployeeWithPermissions(decoded.sub);
    if (!user) {
      res.status(401).json({ error: 'Employee account is inactive or missing' });
      return;
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired session token' });
  }
}

function requirePermission(perm: string) {
  return async (req: AuthedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    if (req.user.role_code === 'OWNER' || req.user.permissions.includes(perm)) {
      next();
      return;
    }
    await writeAuditLog({
      employeeId: req.user.id,
      employeeName: req.user.full_name,
      action: 'PERMISSION_DENIED',
      entityType: 'API_ENDPOINT',
      entityId: req.originalUrl,
      afterObj: { required_permission: perm },
      ipAddress: req.ip,
    });
    res.status(403).json({ error: `Permission denied: requires ${perm}` });
  };
}

function isPhysicalOnlyUser(user?: AuthPayload): boolean {
  return user?.role_code === 'GODOWN_KEEPER';
}

function rejectPhysicalOnlyUser(
  req: AuthedRequest,
  res: Response,
  message = 'Financial and commercial records are restricted for Godown Keeper role'
): boolean {
  if (isPhysicalOnlyUser(req.user)) {
    res.status(403).json({ error: message });
    return true;
  }
  return false;
}

function sanitizePurchaseForPhysical(p: Record<string, unknown>): Record<string, unknown> {
  const splits = Array.isArray(p.splits)
    ? (p.splits as Array<Record<string, unknown>>).map((s) => ({
        ...s,
        allocated_amount: 0,
      }))
    : [];
  const returnLogs = Array.isArray(p.return_logs)
    ? (p.return_logs as Array<Record<string, unknown>>).map((r) => ({
        ...r,
        return_amount: 0,
        account_id: null,
        account_name: '',
      }))
    : [];
  return {
    ...p,
    settlement_rate: 0,
    rate_per_kg: 0,
    total_payable: 0,
    paid_amount: 0,
    returned_amount: 0,
    payment_status: 'UNPAID',
    split_summary_json: null,
    splits,
    return_logs: returnLogs,
  };
}

function sanitizeQrPayloadForPhysical(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeQrPayloadForPhysical(item));
  }
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (/amount|cost|rate|price|payable|paid|profit|loss|revenue|balance|value|budget|valuation|expense/i.test(k)) {
        continue;
      }
      out[k] = sanitizeQrPayloadForPhysical(v);
    }
    return out;
  }
  return obj;
}

const app = express();
app.use(express.json({ limit: '25mb' }));

// Automatically forward async route rejections to Express error middleware
const wrapAsyncHandler = (fn: unknown) => {
  if (typeof fn !== 'function' || fn.length >= 4) return fn;
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve((fn as (req: Request, res: Response, next: NextFunction) => unknown)(req, res, next)).catch(next);
  };
};
for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
  const orig = (app as unknown as Record<string, (...a: unknown[]) => unknown>)[method].bind(app);
  (app as unknown as Record<string, (...a: unknown[]) => unknown>)[method] = (...args: unknown[]) => {
    if (method === 'get' && args.length === 1) return orig(...args);
    return orig(args[0], ...args.slice(1).map(wrapAsyncHandler));
  };
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Client-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

// Health Check & Live Speed Probe (Incompressible payload, no-store)
const SPEED_PROBE_BUFFER = crypto.randomBytes(1024 * 1024);

app.get('/api/v1/health', async (_req, res) => {
  res.json({
    status: 'ok',
    api_version: '1.0.0',
    engine: 'SonaGrain-Node-Parity',
    db_engine: dbEngine,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/v1/speed-probe', async (req, res) => {
  const reqBytes = Number(req.query.bytes ?? 131072);
  const byteLen = Number.isFinite(reqBytes) ? Math.max(0, Math.min(1048576, Math.round(reqBytes))) : 131072;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(byteLen));
  if (byteLen === 0) {
    res.status(200).end();
    return;
  }
  res.status(200).send(SPEED_PROBE_BUFFER.subarray(0, byteLen));
});

// ---------------------------------------------------------------------------
// 1. Authentication & Session
// ---------------------------------------------------------------------------
app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const emp = await db.prepare('SELECT id, password_hash, is_active FROM employees WHERE email = ?').get(email.trim().toLowerCase()) as
    | { id: number; password_hash: string; is_active: number }
    | undefined;

  if (!emp || !emp.is_active || !bcrypt.compareSync(password, emp.password_hash)) {
    res.status(401).json({ error: 'Invalid employee credentials' });
    return;
  }

  await db.prepare("UPDATE employees SET last_login_at = datetime('now') WHERE id = ?").run(emp.id);
  const user = (await getEmployeeWithPermissions(emp.id))!;
  const token = jwt.sign({ sub: user.id, role: user.role_code }, JWT_SECRET, { expiresIn: '24h' });

  await writeAuditLog({
    employeeId: user.id,
    employeeName: user.full_name,
    action: 'LOGIN',
    entityType: 'EMPLOYEE',
    entityId: user.employee_code,
    ipAddress: req.ip,
    deviceType: (req.headers['x-client-type'] as string) || 'WEB_PWA',
  });

  res.json({ token, user });
});

app.get('/api/v1/auth/me', authenticate, async (req: AuthedRequest, res) => {
  res.json({ user: req.user });
});

app.post('/api/v1/auth/change-password', authenticate, async (req: AuthedRequest, res) => {
  const { current_password, new_password } = req.body as {
    current_password?: string;
    new_password?: string;
  };
  if (!current_password || !new_password) {
    res.status(400).json({ error: 'Current password and new password are required' });
    return;
  }
  const cleanNew = new_password.trim();
  if (cleanNew.length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }

  const emp = await db
    .prepare('SELECT id, employee_code, password_hash, is_active FROM employees WHERE id = ?')
    .get(req.user!.id) as { id: number; employee_code: string; password_hash: string; is_active: number } | undefined;

  if (!emp || !emp.is_active) {
    res.status(404).json({ error: 'Employee account not found or inactive' });
    return;
  }
  if (!bcrypt.compareSync(current_password, emp.password_hash)) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  const nextHash = bcrypt.hashSync(cleanNew, 10);
  await db.prepare('UPDATE employees SET password_hash = ? WHERE id = ?').run(nextHash, emp.id);

  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: 'CHANGE_PASSWORD',
    entityType: 'EMPLOYEE',
    entityId: emp.employee_code,
    ipAddress: req.ip,
    deviceType: (req.headers['x-client-type'] as string) || 'WEB_PWA',
  });

  res.json({ status: 'ok' });
});

// ---------------------------------------------------------------------------
// 2. Dashboard Analytics
// ---------------------------------------------------------------------------
app.get('/api/v1/dashboard', authenticate, async (req: AuthedRequest, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const lots = await db
    .prepare(
      `SELECT l.*, i.category, i.name as item_name
       FROM inventory_lots l
       JOIN items i ON i.id = l.item_id
       WHERE l.remaining_qty_kg > 0 OR COALESCE(l.weight_pending, 0) = 1`
    )
    .all() as Array<{
    category: string;
    remaining_qty_kg: number;
    unit_cost_per_kg: number;
    warehouse_id: number;
    weight_pending?: number;
    pending_cost_total?: number;
  }>;

  let paddyKg = 0;
  let riceKg = 0;
  let bypKg = 0;
  let valuation = 0;
  const whStats = new Map<number, { qty: number; val: number }>();

  for (const lot of lots) {
    const qty = Number(lot.remaining_qty_kg || 0);
    const val = physicalOnly
      ? 0
      : Number(lot.weight_pending || 0) === 1
      ? Number(lot.pending_cost_total || 0)
      : qty * Number(lot.unit_cost_per_kg || 0);
    valuation += val;
    if (lot.category === 'PADDY') paddyKg += qty;
    else if (lot.category === 'HEAD_RICE') riceKg += qty;
    else bypKg += qty;

    const cur = whStats.get(lot.warehouse_id) ?? { qty: 0, val: 0 };
    cur.qty += qty;
    cur.val += val;
    whStats.set(lot.warehouse_id, cur);
  }

  const warehouses = await db.prepare('SELECT * FROM warehouses WHERE is_active = 1').all() as Array<{
    id: number;
    code: string;
    name: string;
    warehouse_type: string;
    capacity_kg: number;
  }>;

  const warehouseUtilization = warehouses.map((w) => {
    const s = whStats.get(w.id) ?? { qty: 0, val: 0 };
    return {
      ...w,
      current_stock_kg: Number(s.qty.toFixed(2)),
      valuation: physicalOnly ? 0 : Number(s.val.toFixed(2)),
    };
  });

  const purAgg = await db.prepare('SELECT COALESCE(SUM(total_payable), 0) as total, COALESCE(SUM(discrepancy_flagged), 0) as flagged FROM paddy_purchases').get() as {
    total: number;
    flagged: number;
  };
  const riceSalesAgg = physicalOnly
    ? { rev: 0, cogs: 0 }
    : (await db.prepare('SELECT COALESCE(SUM(total_amount), 0) as rev, COALESCE(SUM(total_cogs), 0) as cogs FROM sales_invoices').get() as {
        rev: number;
        cogs: number;
      });
  const paddySalesAgg = physicalOnly
    ? { rev: 0, cogs: 0 }
    : (await db.prepare('SELECT COALESCE(SUM(total_amount), 0) as rev, COALESCE(SUM(cogs_amount), 0) as cogs FROM paddy_sales').get() as {
        rev: number;
        cogs: number;
      });
  const cashBankAgg = physicalOnly
    ? { bal: 0 }
    : (await db
        .prepare("SELECT COALESCE(SUM(balance), 0) as bal FROM accounts WHERE account_code IN ('1001', '1002')")
        .get() as { bal: number });

  const batchAgg = physicalOnly
    ? { siddho_batches: 0, atap_batches: 0, avg_yield: 0, total_milled: 0 }
    : (await db
        .prepare(
          `SELECT
            SUM(CASE WHEN process_type = 'PARBOILED_SIDDHO' THEN 1 ELSE 0 END) as siddho_batches,
            SUM(CASE WHEN process_type = 'RAW_ATAP' THEN 1 ELSE 0 END) as atap_batches,
            COALESCE(AVG(head_rice_yield_pct), 0) as avg_yield,
            COALESCE(SUM(input_paddy_qty_kg), 0) as total_milled
           FROM production_batches`
        )
        .get() as { siddho_batches: number; atap_batches: number; avg_yield: number; total_milled: number });

  const recentPurchasesRaw = await db
    .prepare(
      `SELECT p.*, pt.name as supplier_name, w.name as warehouse_name, i.name as item_name
       FROM paddy_purchases p
       JOIN parties pt ON pt.id = p.supplier_id
       JOIN warehouses w ON w.id = p.warehouse_id
       JOIN items i ON i.id = p.item_id
       ORDER BY p.id DESC LIMIT 5`
    )
    .all() as Array<Record<string, unknown>>;

  const recentPurchases = physicalOnly
    ? recentPurchasesRaw.map((p) => sanitizePurchaseForPhysical(p))
    : recentPurchasesRaw;

  const recentBatches = physicalOnly
    ? []
    : await db
        .prepare(
          `SELECT b.*, i.name as paddy_item_name, w.name as source_warehouse_name,
                  cs.net_head_rice_cost, cs.cost_per_kg_head_rice
           FROM production_batches b
           JOIN items i ON i.id = b.paddy_item_id
           JOIN warehouses w ON w.id = b.source_warehouse_id
           LEFT JOIN production_cost_sheets cs ON cs.batch_id = b.id
           ORDER BY b.id DESC LIMIT 5`
        )
        .all();

  const recentSales = physicalOnly
    ? []
    : await db
        .prepare(
          `SELECT s.*, pt.name as customer_name
           FROM sales_invoices s
           JOIN parties pt ON pt.id = s.customer_id
           ORDER BY s.id DESC LIMIT 5`
        )
        .all();

  const rawPurAgg = (await db
    .prepare(
      `SELECT COALESCE(SUM(received_weight_kg), 0) as total_kg,
              COALESCE(SUM(bag_count), 0) as total_bags
       FROM paddy_purchases
       WHERE COALESCE(paddy_condition, 'RAW_WET') != 'DRIED'`
    )
    .get()) as { total_kg: number; total_bags: number };

  const rawRemAgg = (await db
    .prepare(
      `SELECT COALESCE(SUM(l.remaining_qty_kg), 0) as rem_kg,
              COALESCE(SUM(l.remaining_bags), 0) as rem_bags
       FROM inventory_lots l
       JOIN paddy_purchases p ON p.id = l.source_id AND l.source_type = 'PADDY_PURCHASE'
       WHERE COALESCE(p.paddy_condition, 'RAW_WET') != 'DRIED' AND l.remaining_qty_kg > 0.0001`
    )
    .get()) as { rem_kg: number; rem_bags: number };

  const dryingRows = (await db
    .prepare(
      `SELECT d.id, d.drying_no, d.drying_method, d.input_qty_kg, d.input_bags,
              d.output_qty_kg, d.output_bags, d.dispatched_bags, d.moisture_loss_kg,
              d.initial_moisture_pct, d.final_moisture_pct, d.weight_pending, d.status,
              d.created_at, i.name as item_name, wd.name as dest_warehouse_name,
              pp.purchase_no
       FROM paddy_drying_batches d
       JOIN items i ON i.id = d.item_id
       JOIN warehouses wd ON wd.id = d.dest_warehouse_id
       LEFT JOIN paddy_purchases pp ON pp.id = d.purchase_id
       ORDER BY d.created_at DESC, d.id DESC`
    )
    .all()) as Array<Record<string, unknown>>;

  let completedDryingCount = 0;
  let pendingDryingCount = 0;
  let totalDryRawInputKg = 0;
  let totalDryRawInputBags = 0;
  let weighedDryInputKg = 0;
  let totalDriedOutputKg = 0;
  let totalDriedOutputBags = 0;
  let pendingDryInputKg = 0;
  let pendingDryBags = 0;
  let totalDryVolumeLostKg = 0;
  let moistureDropSum = 0;
  let moistureDropCount = 0;

  const methodStatsMap = new Map<
    string,
    { batch_count: number; input_kg: number; weighed_input_kg: number; output_kg: number; lost_kg: number; pending_kg: number }
  >();

  for (const d of dryingRows) {
    const inKg = Number(d.input_qty_kg || 0);
    const inBags = Number(d.input_bags || 0);
    const outKg = Number(d.output_qty_kg || 0);
    const outBags = Number(d.output_bags || 0);
    const dispBags = Number(d.dispatched_bags || 0);
    const isPending = d.status === 'PENDING_WEIGHT' || Number(d.weight_pending || 0) === 1;
    const method = String(d.drying_method || 'MECHANICAL_DRYER');

    totalDryRawInputKg += inKg;
    totalDryRawInputBags += inBags;
    totalDriedOutputBags += outBags;

    const mStat = methodStatsMap.get(method) || {
      batch_count: 0,
      input_kg: 0,
      weighed_input_kg: 0,
      output_kg: 0,
      lost_kg: 0,
      pending_kg: 0,
    };
    mStat.batch_count += 1;
    mStat.input_kg += inKg;

    if (outKg > 0) {
      const lossKg = Math.max(0, Number(d.moisture_loss_kg ?? inKg - outKg));
      weighedDryInputKg += inKg;
      totalDriedOutputKg += outKg;
      totalDryVolumeLostKg += lossKg;
      mStat.weighed_input_kg += inKg;
      mStat.output_kg += outKg;
      mStat.lost_kg += lossKg;

      const initMc = Number(d.initial_moisture_pct || 0);
      const finalMc = Number(d.final_moisture_pct || 0);
      if (initMc > 0 && finalMc >= 0 && initMc >= finalMc) {
        moistureDropSum += initMc - finalMc;
        moistureDropCount += 1;
      }
    }

    if (isPending) {
      pendingDryingCount += 1;
      if (outKg <= 0) {
        pendingDryInputKg += inKg;
        mStat.pending_kg += inKg;
      }
      pendingDryBags += Math.max(0, outBags - dispBags);
    } else {
      completedDryingCount += 1;
    }

    methodStatsMap.set(method, mStat);
  }

  const dryingEfficiencyPct = weighedDryInputKg > 0 ? (totalDriedOutputKg / weighedDryInputKg) * 100 : 0;
  const dryingLossPct = weighedDryInputKg > 0 ? (totalDryVolumeLostKg / weighedDryInputKg) * 100 : 0;
  const avgMoistureDropPct = moistureDropCount > 0 ? moistureDropSum / moistureDropCount : 0;

  const byMethod = Array.from(methodStatsMap.entries()).map(([method, s]) => ({
    method,
    batch_count: s.batch_count,
    input_kg: Number(s.input_kg.toFixed(2)),
    weighed_input_kg: Number(s.weighed_input_kg.toFixed(2)),
    output_kg: Number(s.output_kg.toFixed(2)),
    lost_kg: Number(s.lost_kg.toFixed(2)),
    pending_kg: Number(s.pending_kg.toFixed(2)),
    efficiency_pct: s.weighed_input_kg > 0 ? Number(((s.output_kg / s.weighed_input_kg) * 100).toFixed(1)) : 0,
  }));

  const recentDrying = dryingRows.slice(0, 6).map((d) => {
    const inKg = Number(d.input_qty_kg || 0);
    const outKg = Number(d.output_qty_kg || 0);
    const lossKg = outKg > 0 ? Math.max(0, Number(d.moisture_loss_kg ?? inKg - outKg)) : 0;
    const effPct = inKg > 0 && outKg > 0 ? Number(((outKg / inKg) * 100).toFixed(1)) : 0;
    return {
      id: Number(d.id),
      drying_no: String(d.drying_no),
      drying_method: String(d.drying_method),
      item_name: String(d.item_name || ''),
      dest_warehouse_name: String(d.dest_warehouse_name || ''),
      purchase_no: d.purchase_no ? String(d.purchase_no) : null,
      input_qty_kg: Number(inKg.toFixed(2)),
      input_bags: Number(d.input_bags || 0),
      output_qty_kg: Number(outKg.toFixed(2)),
      output_bags: Number(d.output_bags || 0),
      moisture_loss_kg: Number(lossKg.toFixed(2)),
      initial_moisture_pct: Number(d.initial_moisture_pct || 0),
      final_moisture_pct: Number(d.final_moisture_pct || 0),
      efficiency_pct: effPct,
      status: String(d.status || 'COMPLETED'),
      created_at: String(d.created_at || ''),
    };
  });

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
      cash_and_bank_balance: physicalOnly ? 0 : Number(cashBankAgg.bal.toFixed(2)),
    },
    warehouse_utilization: warehouseUtilization,
    production_summary: {
      siddho_batches: Number(batchAgg.siddho_batches || 0),
      atap_batches: Number(batchAgg.atap_batches || 0),
      avg_head_rice_yield_pct: Number((batchAgg.avg_yield || 0).toFixed(2)),
      total_paddy_milled_kg: Number((batchAgg.total_milled || 0).toFixed(2)),
    },
    drying_summary: {
      total_raw_purchased_kg: Number(Number(rawPurAgg.total_kg || 0).toFixed(2)),
      total_raw_purchased_bags: Number(rawPurAgg.total_bags || 0),
      total_raw_remaining_kg: Number(Number(rawRemAgg.rem_kg || 0).toFixed(2)),
      total_raw_remaining_bags: Number(rawRemAgg.rem_bags || 0),
      total_drying_batches: dryingRows.length,
      completed_drying_batches: completedDryingCount,
      pending_drying_batches: pendingDryingCount,
      total_raw_input_kg: Number(totalDryRawInputKg.toFixed(2)),
      total_raw_input_bags: totalDryRawInputBags,
      weighed_input_kg: Number(weighedDryInputKg.toFixed(2)),
      total_dried_output_kg: Number(totalDriedOutputKg.toFixed(2)),
      total_dried_output_bags: totalDriedOutputBags,
      pending_weight_input_kg: Number(pendingDryInputKg.toFixed(2)),
      pending_weight_bags: pendingDryBags,
      total_volume_lost_kg: Number(totalDryVolumeLostKg.toFixed(2)),
      drying_efficiency_pct: Number(dryingEfficiencyPct.toFixed(1)),
      loss_pct: Number(dryingLossPct.toFixed(1)),
      avg_moisture_drop_pct: Number(avgMoistureDropPct.toFixed(1)),
      by_method: byMethod,
      recent_drying: recentDrying,
    },
    recent_purchases: recentPurchases,
    recent_batches: recentBatches,
    recent_sales: recentSales,
  });
});

// ---------------------------------------------------------------------------
// 3. Master Data: Warehouses, Items, Parties
// ---------------------------------------------------------------------------
const ENRICHED_PARTIES_SQL = `
  SELECT pt.*,
    COALESCE((SELECT SUM(pp.total_payable) FROM paddy_purchases pp WHERE pp.supplier_id = pt.id), 0) as total_purchased,
    COALESCE((SELECT SUM(si.total_amount) FROM sales_invoices si WHERE si.customer_id = pt.id), 0)
      + COALESCE((SELECT SUM(ps.total_amount) FROM paddy_sales ps WHERE ps.customer_id = pt.id), 0) as total_sold,
    COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.party_id = pt.id AND pay.direction = 'PAYMENT'), 0)
      + COALESCE((SELECT SUM(pp.paid_amount) FROM paddy_purchases pp WHERE pp.supplier_id = pt.id), 0) as total_paid_out,
    COALESCE((SELECT SUM(pay.amount) FROM payments pay WHERE pay.party_id = pt.id AND pay.direction = 'RECEIPT'), 0)
      + COALESCE((SELECT SUM(si.paid_amount) FROM sales_invoices si WHERE si.customer_id = pt.id), 0)
      + COALESCE((SELECT SUM(ps.paid_amount) FROM paddy_sales ps WHERE ps.customer_id = pt.id), 0) as total_received_in,
    COALESCE((SELECT SUM(CASE WHEN pp.total_payable - pp.paid_amount > 0 THEN pp.total_payable - pp.paid_amount ELSE 0 END) FROM paddy_purchases pp WHERE pp.supplier_id = pt.id AND pp.payment_status != 'PAID'), 0) as open_purchase_due,
    COALESCE((SELECT SUM(CASE WHEN si.total_amount - si.paid_amount > 0 THEN si.total_amount - si.paid_amount ELSE 0 END) FROM sales_invoices si WHERE si.customer_id = pt.id AND si.payment_status != 'PAID'), 0)
      + COALESCE((SELECT SUM(CASE WHEN ps.total_amount - ps.paid_amount > 0 THEN ps.total_amount - ps.paid_amount ELSE 0 END) FROM paddy_sales ps WHERE ps.customer_id = pt.id AND ps.payment_status != 'PAID'), 0) as open_sales_due
  FROM parties pt
`;

app.get('/api/v1/master', authenticate, async (req: AuthedRequest, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const warehouses = await db
    .prepare(
      `SELECT w.*, COALESCE((SELECT SUM(l.remaining_qty_kg) FROM inventory_lots l WHERE l.warehouse_id = w.id), 0) as current_stock_kg
       FROM warehouses w ORDER BY w.id ASC`
    )
    .all();
  const units = await db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM items i WHERE i.unit = u.code) as product_count
       FROM product_units u ORDER BY u.id ASC`
    )
    .all();
  const categories = await db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category = c.code) as product_count
       FROM product_categories c ORDER BY c.id ASC`
    )
    .all();
  const itemsRaw = await db.prepare('SELECT * FROM items ORDER BY id ASC').all() as Array<Record<string, unknown>>;
  const items = physicalOnly ? itemsRaw.map((i) => ({ ...i, default_rate: 0 })) : itemsRaw;

  const partiesRaw = await db.prepare(`${ENRICHED_PARTIES_SQL} ORDER BY pt.name ASC`).all() as Array<Record<string, unknown>>;
  const parties = physicalOnly
    ? partiesRaw
        .filter((p) => p.party_type === 'SUPPLIER' || p.party_type === 'BOTH')
        .map((p) => ({
          ...p,
          credit_limit: 0,
          opening_balance: 0,
          current_balance: 0,
          total_purchased: 0,
          total_sold: 0,
          total_paid_out: 0,
          total_received_in: 0,
          open_purchase_due: 0,
          open_sales_due: 0,
        }))
    : partiesRaw;

  const accounts = physicalOnly ? [] : await db.prepare('SELECT * FROM accounts ORDER BY account_code ASC').all();
  const roles = await db.prepare('SELECT * FROM roles ORDER BY id ASC').all();
  const company_settings = await db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  res.json({ warehouses, units, categories, items, parties, accounts, roles, company_settings });
});

app.get('/api/v1/company-settings', async (_req, res) => {
  const company = await db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  res.json({ company });
});

app.put('/api/v1/company-settings', authenticate, async (req: AuthedRequest, res) => {
  const roleCode = req.user?.role_code;
  const canManage =
    roleCode === 'OWNER' ||
    roleCode === 'MANAGER' ||
    (req.user?.permissions || []).includes('employees.manage');
  if (!canManage) {
    return res.status(403).json({ error: 'Only Mill Owner or Manager can customize company profile settings' });
  }

  const body = req.body as {
    company_name_en?: string;
    company_name_bn?: string;
    short_code?: string;
    tagline_en?: string;
    tagline_bn?: string;
    address_en?: string;
    address_bn?: string;
    phone?: string;
    email?: string;
    tax_id?: string;
    logo_data_url?: string;
  };

  const nameEn = String(body.company_name_en || '').trim();
  const nameBn = String(body.company_name_bn || '').trim() || nameEn;
  if (!nameEn && !nameBn) {
    return res.status(400).json({ error: 'Company name is required' });
  }

  const logoDataUrl = typeof body.logo_data_url === 'string' ? body.logo_data_url.trim() : '';
  if (logoDataUrl) {
    if (logoDataUrl.length > 800_000) {
      return res.status(400).json({ error: 'Logo image is too large (max ~600 KB)' });
    }
    if (!/^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);(base64,|charset=utf-8,)/i.test(logoDataUrl)) {
      return res.status(400).json({ error: 'Invalid logo image format. Please upload PNG, JPG, WebP, GIF, or SVG.' });
    }
  }

  const existing = await db.prepare('SELECT * FROM company_settings WHERE id = 1').get() as Record<string, unknown> | undefined;
  const shortCode =
    String(body.short_code || '')
      .trim()
      .toUpperCase()
      .slice(0, 4) ||
    nameEn
      .split(/\s+/)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() ||
    'SG';

  if (existing) {
    await db
      .prepare(
        `UPDATE company_settings SET
           company_name_en = ?,
           company_name_bn = ?,
           short_code = ?,
           tagline_en = ?,
           tagline_bn = ?,
           address_en = ?,
           address_bn = ?,
           phone = ?,
           email = ?,
           tax_id = ?,
           logo_data_url = ?,
           updated_at = datetime('now')
         WHERE id = 1`
      )
      .run(
        nameEn || nameBn,
        nameBn || nameEn,
        shortCode,
        String(body.tagline_en || '').trim(),
        String(body.tagline_bn || '').trim(),
        String(body.address_en || '').trim(),
        String(body.address_bn || '').trim(),
        String(body.phone || '').trim(),
        String(body.email || '').trim(),
        String(body.tax_id || '').trim(),
        logoDataUrl
      );
  } else {
    await db
      .prepare(
        `INSERT INTO company_settings (id, company_name_en, company_name_bn, short_code, tagline_en, tagline_bn, address_en, address_bn, phone, email, tax_id, logo_data_url, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      )
      .run(
        nameEn || nameBn,
        nameBn || nameEn,
        shortCode,
        String(body.tagline_en || '').trim(),
        String(body.tagline_bn || '').trim(),
        String(body.address_en || '').trim(),
        String(body.address_bn || '').trim(),
        String(body.phone || '').trim(),
        String(body.email || '').trim(),
        String(body.tax_id || '').trim(),
        logoDataUrl
      );
  }

  const updated = await db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: 'COMPANY_SETTINGS_UPDATED',
    entityType: 'COMPANY_SETTINGS',
    entityId: '1',
    beforeObj: existing,
    afterObj: updated,
  });

  res.json({ company: updated });
});

app.get('/api/v1/sms/status', authenticate, async (_req, res) => {
  const cfg = await getSmsGatewayStoredConfig();
  res.json({
    configured: Boolean(cfg.enabled && cfg.provider !== 'NONE'),
    auto_on_paddy_purchase: Boolean(cfg.auto_on_paddy_purchase),
    auto_on_paddy_price: Boolean(cfg.auto_on_paddy_price),
    provider: cfg.provider,
    lang_mode: cfg.lang_mode,
  });
});

app.get('/api/v1/sms/settings', authenticate, async (req: AuthedRequest, res) => {
  const roleCode = req.user?.role_code;
  const canManage =
    roleCode === 'OWNER' ||
    roleCode === 'MANAGER' ||
    (req.user?.permissions || []).includes('employees.manage');
  if (!canManage) {
    res.status(403).json({ error: 'Only Mill Owner or Manager can access SMS gateway configuration' });
    return;
  }
  const cfg = await getSmsGatewayStoredConfig();
  const logs = await db
    .prepare('SELECT * FROM sms_logs ORDER BY id DESC LIMIT 50')
    .all();
  res.json({ settings: maskSmsConfig(cfg), logs });
});

app.put('/api/v1/sms/settings', authenticate, async (req: AuthedRequest, res) => {
  const roleCode = req.user?.role_code;
  const canManage =
    roleCode === 'OWNER' ||
    roleCode === 'MANAGER' ||
    (req.user?.permissions || []).includes('employees.manage');
  if (!canManage) {
    res.status(403).json({ error: 'Only Mill Owner or Manager can update SMS gateway settings' });
    return;
  }
  try {
    const saved = await saveSmsGatewayConfig(req.body || {});
    await writeAuditLog({
      employeeId: req.user!.id,
      employeeName: req.user!.full_name,
      action: 'SMS_SETTINGS_UPDATED',
      entityType: 'SMS_SETTINGS',
      entityId: '1',
      afterObj: saved,
    });
    res.json({ settings: saved });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/v1/sms/test', authenticate, async (req: AuthedRequest, res) => {
  const roleCode = req.user?.role_code;
  const canManage =
    roleCode === 'OWNER' ||
    roleCode === 'MANAGER' ||
    (req.user?.permissions || []).includes('employees.manage');
  if (!canManage) {
    res.status(403).json({ error: 'Only Mill Owner or Manager can send test SMS' });
    return;
  }
  const { phone, message } = req.body as { phone?: string; message?: string };
  try {
    const result = await sendTestSmsMessage({
      phone: String(phone || ''),
      message: typeof message === 'string' ? message : undefined,
      employeeId: req.user!.id,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/v1/sms/paddy-purchase/:id', authenticate, requirePermission('paddy.purchase.create'), async (req: AuthedRequest, res) => {
  const purchaseId = Number(req.params.id);
  const { phone, lang, channel, message_body } = (req.body || {}) as {
    phone?: string;
    lang?: 'bn' | 'en';
    channel?: 'GATEWAY' | 'MANUAL_WHATSAPP' | 'MANUAL_SMS';
    message_body?: string;
  };
  const purchase = (await db
    .prepare(
      `SELECT p.*, pt.name as supplier_name, pt.phone as supplier_phone, w.name as warehouse_name, i.name as item_name
       FROM paddy_purchases p
       JOIN parties pt ON pt.id = p.supplier_id
       JOIN warehouses w ON w.id = p.warehouse_id
       JOIN items i ON i.id = p.item_id
       WHERE p.id = ?`
    )
    .get(purchaseId)) as Record<string, unknown> | undefined;

  if (!purchase) {
    res.status(404).json({ error: 'Paddy purchase not found' });
    return;
  }

  const safePurchase = isPhysicalOnlyUser(req.user)
    ? sanitizePurchaseForPhysical(purchase)
    : purchase;

  if (channel === 'MANUAL_WHATSAPP' || channel === 'MANUAL_SMS') {
    await recordSmsLog({
      entityType: 'PADDY_PURCHASE',
      entityId: purchaseId,
      entityCode: String(safePurchase.purchase_no || ''),
      partyId: Number(safePurchase.supplier_id || 0) || null,
      partyName: String(safePurchase.supplier_name || ''),
      phone: String(phone || safePurchase.supplier_phone || ''),
      provider: channel,
      messageBody: String(message_body || '').slice(0, 1000),
      status: channel,
      providerResponse: 'Launched from client app',
      createdBy: req.user!.id,
    });
    res.json({ status: channel });
    return;
  }

  const result = await dispatchPaddyPurchaseSms({
    purchase: safePurchase,
    employeeId: req.user!.id,
    forceManualSend: true,
    overridePhone: typeof phone === 'string' ? phone : undefined,
    overrideLang: lang === 'en' ? 'en' : 'bn',
    triggerType: 'MANUAL',
  });
  res.json(result);
});

app.post('/api/v1/warehouses', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const { code, name, warehouse_type, location, capacity_kg, is_active } = req.body as {
    code: string;
    name: string;
    warehouse_type: string;
    location: string;
    capacity_kg: number;
    is_active?: boolean | number;
  };
  if (!code || !name || !warehouse_type) {
    res.status(400).json({ error: 'Warehouse code, name, and type are required' });
    return;
  }
  try {
    const activeVal = is_active === undefined ? 1 : is_active ? 1 : 0;
    const info = await db
      .prepare('INSERT INTO warehouses (code, name, warehouse_type, location, capacity_kg, manager_employee_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(code.trim().toUpperCase(), name.trim(), warehouse_type, location || '', Number(capacity_kg || 0), req.user!.id, activeVal);
    const wh = await db.prepare('SELECT *, 0 as current_stock_kg FROM warehouses WHERE id = ?').get(info.lastInsertRowid);
    await writeAuditLog({
      employeeId: req.user!.id,
      employeeName: req.user!.full_name,
      action: 'CREATE_WAREHOUSE',
      entityType: 'WAREHOUSE',
      entityId: String(info.lastInsertRowid),
      afterObj: wh,
    });
    res.status(201).json({ warehouse: wh });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.put('/api/v1/warehouses/:id', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Warehouse not found' });
    return;
  }
  const { code, name, warehouse_type, location, capacity_kg, is_active } = req.body as {
    code?: string;
    name?: string;
    warehouse_type?: string;
    location?: string;
    capacity_kg?: number;
    is_active?: boolean | number;
  };
  if (!code?.trim() || !name?.trim() || !warehouse_type) {
    res.status(400).json({ error: 'Warehouse code, name, and type are required' });
    return;
  }
  try {
    const activeVal = is_active === undefined ? existing.is_active : is_active ? 1 : 0;
    await db.prepare(
      'UPDATE warehouses SET code = ?, name = ?, warehouse_type = ?, location = ?, capacity_kg = ?, is_active = ? WHERE id = ?'
    ).run(code.trim().toUpperCase(), name.trim(), warehouse_type, location || '', Number(capacity_kg || 0), activeVal, id);
    const updated = await db
      .prepare(
        `SELECT w.*, COALESCE((SELECT SUM(l.remaining_qty_kg) FROM inventory_lots l WHERE l.warehouse_id = w.id), 0) as current_stock_kg
         FROM warehouses w WHERE w.id = ?`
      )
      .get(id);
    await writeAuditLog({
      employeeId: req.user!.id,
      employeeName: req.user!.full_name,
      action: 'UPDATE_WAREHOUSE',
      entityType: 'WAREHOUSE',
      entityId: String(id),
      beforeObj: existing,
      afterObj: updated,
    });
    res.json({ warehouse: updated });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.patch('/api/v1/warehouses/:id/status', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id) as { id: number; code: string; is_active: number } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Warehouse not found' });
    return;
  }
  const body = req.body as { is_active?: boolean | number };
  const nextActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active ? 0 : 1;
  await db.prepare('UPDATE warehouses SET is_active = ? WHERE id = ?').run(nextActive, id);
  const updated = await db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: nextActive ? 'ACTIVATE_WAREHOUSE' : 'DEACTIVATE_WAREHOUSE',
    entityType: 'WAREHOUSE',
    entityId: existing.code,
    beforeObj: { is_active: existing.is_active },
    afterObj: { is_active: nextActive },
  });
  res.json({ warehouse: updated });
});

app.delete('/api/v1/warehouses/:id', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id) as { id: number; code: string; name: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Warehouse not found' });
    return;
  }

  const lotCount = (await db.prepare('SELECT COUNT(*) as c FROM inventory_lots WHERE warehouse_id = ?').get(id) as { c: number }).c;
  const purCount = (await db.prepare('SELECT COUNT(*) as c FROM paddy_purchases WHERE warehouse_id = ?').get(id) as { c: number }).c;
  const trfCount = (await db.prepare('SELECT COUNT(*) as c FROM stock_transfers WHERE from_warehouse_id = ? OR to_warehouse_id = ?').get(id, id) as { c: number }).c;
  const prodCount = (await db.prepare('SELECT COUNT(*) as c FROM production_batches WHERE source_warehouse_id = ?').get(id) as { c: number }).c;
  const saleCount = (await db.prepare('SELECT COUNT(*) as c FROM sales_invoice_items WHERE warehouse_id = ?').get(id) as { c: number }).c;

  if (lotCount + purCount + trfCount + prodCount + saleCount > 0) {
    res.status(409).json({
      error: `Cannot delete godown "${existing.name}" because it has stock lots or historical transactions. Set it Inactive instead.`,
    });
    return;
  }

  await db.prepare('DELETE FROM warehouses WHERE id = ?').run(id);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: 'DELETE_WAREHOUSE',
    entityType: 'WAREHOUSE',
    entityId: existing.code,
    beforeObj: existing,
  });
  res.json({ deleted: true, id });
});

// Products / Items Master CRUD
app.post('/api/v1/items', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const { sku, name, category, process_grade, unit, bag_weight_kg, costing_method, default_rate, is_active } = req.body as {
    sku: string;
    name: string;
    category: string;
    process_grade: string;
    unit?: string;
    bag_weight_kg?: number;
    costing_method?: string;
    default_rate?: number;
    is_active?: boolean | number;
  };
  if (!sku?.trim() || !name?.trim() || !category || !process_grade) {
    res.status(400).json({ error: 'SKU, product name, category, and process grade are required' });
    return;
  }
  try {
    const activeVal = is_active === undefined ? 1 : is_active ? 1 : 0;
    const catCode = category.trim().toUpperCase();
    const unitCode = (unit || 'KG').trim().toUpperCase();

    const existingCat = await db.prepare('SELECT id FROM product_categories WHERE UPPER(code) = ?').get(catCode);
    if (!existingCat) {
      const groupType =
        process_grade === 'RAW_PADDY' || catCode === 'PADDY' || catCode === 'RAW_PADDY'
          ? 'RAW_MATERIAL'
          : process_grade === 'BY_PRODUCT' || ['BROKEN_RICE', 'BRAN', 'HUSK'].includes(catCode)
          ? 'BY_PRODUCT'
          : 'FINISHED_GOOD';
      const defaultCatNames: Record<string, string> = {
        PADDY: 'Raw Paddy',
        RAW_PADDY: 'Raw Paddy',
        HEAD_RICE: 'Head Rice',
        BROKEN_RICE: 'Broken Rice (Khud)',
        BRAN: 'Rice Bran (Kura)',
        HUSK: 'Paddy Husk (Tush)',
      };
      await db.prepare(
        `INSERT INTO product_categories (code, name, group_type, default_costing_method, description, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).run(catCode, defaultCatNames[catCode] || catCode, groupType, costing_method || 'FIFO', 'Auto-created with product');
    }

    const existingUnit = await db.prepare('SELECT id FROM product_units WHERE UPPER(code) = ?').get(unitCode);
    if (!existingUnit) {
      const defaultUnits: Record<string, { name: string; symbol: string; baseKg: number }> = {
        KG: { name: 'Kilogram', symbol: 'kg', baseKg: 1 },
        BAG50: { name: '50 kg Bag', symbol: 'bag', baseKg: 50 },
        QTL: { name: 'Quintal (100 kg)', symbol: 'qtl', baseKg: 100 },
        MT: { name: 'Metric Ton (1000 kg)', symbol: 'MT', baseKg: 1000 },
      };
      const uDef = defaultUnits[unitCode] || { name: unitCode, symbol: unitCode.toLowerCase(), baseKg: Number(bag_weight_kg || 1) };
      await db.prepare(
        `INSERT INTO product_units (code, name, symbol, base_weight_kg, description, is_active)
         VALUES (?, ?, ?, ?, ?, 1)`
      ).run(unitCode, uDef.name, uDef.symbol, uDef.baseKg, 'Auto-created with product');
    }

    const info = await db
      .prepare(
        `INSERT INTO items (sku, name, category, process_grade, unit, bag_weight_kg, costing_method, default_rate, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        sku.trim().toUpperCase(),
        name.trim(),
        catCode,
        process_grade,
        unitCode,
        Number(bag_weight_kg || 50),
        costing_method || 'FIFO',
        Number(default_rate || 0),
        activeVal
      );
    const item = await db.prepare('SELECT * FROM items WHERE id = ?').get(info.lastInsertRowid);
    await writeAuditLog({
      employeeId: req.user!.id,
      employeeName: req.user!.full_name,
      action: 'CREATE_PRODUCT',
      entityType: 'ITEM',
      entityId: sku.trim().toUpperCase(),
      afterObj: item,
    });
    res.status(201).json({ item });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.put('/api/v1/items/:id', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM items WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  const { sku, name, category, process_grade, unit, bag_weight_kg, costing_method, default_rate, is_active } = req.body as {
    sku?: string;
    name?: string;
    category?: string;
    process_grade?: string;
    unit?: string;
    bag_weight_kg?: number;
    costing_method?: string;
    default_rate?: number;
    is_active?: boolean | number;
  };
  if (!sku?.trim() || !name?.trim() || !category || !process_grade) {
    res.status(400).json({ error: 'SKU, product name, category, and process grade are required' });
    return;
  }
  try {
    const activeVal = is_active === undefined ? existing.is_active : is_active ? 1 : 0;
    await db.prepare(
      `UPDATE items
       SET sku = ?, name = ?, category = ?, process_grade = ?, unit = ?, bag_weight_kg = ?, costing_method = ?, default_rate = ?, is_active = ?
       WHERE id = ?`
    ).run(
      sku.trim().toUpperCase(),
      name.trim(),
      category,
      process_grade,
      (unit || 'KG').trim().toUpperCase(),
      Number(bag_weight_kg || 50),
      costing_method || 'FIFO',
      Number(default_rate || 0),
      activeVal,
      id
    );
    const updated = await db.prepare('SELECT * FROM items WHERE id = ?').get(id);
    await writeAuditLog({
      employeeId: req.user!.id,
      employeeName: req.user!.full_name,
      action: 'UPDATE_PRODUCT',
      entityType: 'ITEM',
      entityId: sku.trim().toUpperCase(),
      beforeObj: existing,
      afterObj: updated,
    });
    res.json({ item: updated });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.patch('/api/v1/items/:id/status', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM items WHERE id = ?').get(id) as { id: number; sku: string; is_active: number } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }
  const body = req.body as { is_active?: boolean | number };
  const nextActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active ? 0 : 1;
  await db.prepare('UPDATE items SET is_active = ? WHERE id = ?').run(nextActive, id);
  const updated = await db.prepare('SELECT * FROM items WHERE id = ?').get(id);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: nextActive ? 'ACTIVATE_PRODUCT' : 'DEACTIVATE_PRODUCT',
    entityType: 'ITEM',
    entityId: existing.sku,
    beforeObj: { is_active: existing.is_active },
    afterObj: { is_active: nextActive },
  });
  res.json({ item: updated });
});

app.delete('/api/v1/items/:id', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM items WHERE id = ?').get(id) as { id: number; sku: string; name: string } | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Product not found' });
    return;
  }

  const lotCount = (await db.prepare('SELECT COUNT(*) as c FROM inventory_lots WHERE item_id = ?').get(id) as { c: number }).c;
  const purCount = (await db.prepare('SELECT COUNT(*) as c FROM paddy_purchases WHERE item_id = ?').get(id) as { c: number }).c;
  const prodCount = (await db.prepare('SELECT COUNT(*) as c FROM production_batches WHERE paddy_item_id = ?').get(id) as { c: number }).c;
  const saleCount = (await db.prepare('SELECT COUNT(*) as c FROM sales_invoice_items WHERE item_id = ?').get(id) as { c: number }).c;
  const pSaleCount = (await db.prepare('SELECT COUNT(*) as c FROM paddy_sales WHERE item_id = ?').get(id) as { c: number }).c;

  if (lotCount + purCount + prodCount + saleCount + pSaleCount > 0) {
    res.status(409).json({
      error: `Cannot delete product "${existing.name}" because it has stock lots or historical transactions. Set it Inactive instead.`,
    });
    return;
  }

  await db.prepare('DELETE FROM items WHERE id = ?').run(id);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: 'DELETE_PRODUCT',
    entityType: 'ITEM',
    entityId: existing.sku,
    beforeObj: existing,
  });
  res.json({ deleted: true, id });
});

// Product Units Master CRUD
app.get('/api/v1/product-units', authenticate, async (_req, res) => {
  const units = await db
    .prepare(
      `SELECT u.*, (SELECT COUNT(*) FROM items i WHERE i.unit = u.code) as product_count
       FROM product_units u ORDER BY u.id ASC`
    )
    .all();
  res.json({ units });
});

app.post('/api/v1/product-units', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const { code, name, symbol, base_weight_kg, description, is_active } = req.body as {
    code: string;
    name: string;
    symbol?: string;
    base_weight_kg?: number;
    description?: string;
    is_active?: boolean | number;
  };
  if (!code?.trim() || !name?.trim()) {
    res.status(400).json({ error: 'Unit code and name are required' });
    return;
  }
  const baseWeight = Number(base_weight_kg ?? 1);
  if (isNaN(baseWeight) || baseWeight <= 0) {
    res.status(400).json({ error: 'Base weight equivalent (kg) must be greater than zero' });
    return;
  }
  try {
    const cleanCode = code.trim().toUpperCase();
    const activeVal = is_active === undefined ? 1 : is_active ? 1 : 0;
    const info = await db
      .prepare(
        `INSERT INTO product_units (code, name, symbol, base_weight_kg, description, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(cleanCode, name.trim(), (symbol || cleanCode.toLowerCase()).trim(), baseWeight, description || '', activeVal);
    const unit = await db
      .prepare('SELECT *, 0 as product_count FROM product_units WHERE id = ?')
      .get(info.lastInsertRowid);
    await writeAuditLog({
      employeeId: req.user!.id,
      employeeName: req.user!.full_name,
      action: 'CREATE_PRODUCT_UNIT',
      entityType: 'PRODUCT_UNIT',
      entityId: cleanCode,
      afterObj: unit,
    });
    res.status(201).json({ unit });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.put('/api/v1/product-units/:id', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM product_units WHERE id = ?').get(id) as
    | { id: number; code: string; is_active: number }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Product unit not found' });
    return;
  }
  const { code, name, symbol, base_weight_kg, description, is_active } = req.body as {
    code?: string;
    name?: string;
    symbol?: string;
    base_weight_kg?: number;
    description?: string;
    is_active?: boolean | number;
  };
  if (!code?.trim() || !name?.trim()) {
    res.status(400).json({ error: 'Unit code and name are required' });
    return;
  }
  const baseWeight = Number(base_weight_kg ?? 1);
  if (isNaN(baseWeight) || baseWeight <= 0) {
    res.status(400).json({ error: 'Base weight equivalent (kg) must be greater than zero' });
    return;
  }
  try {
    const cleanCode = code.trim().toUpperCase();
    const activeVal = is_active === undefined ? existing.is_active : is_active ? 1 : 0;
    const updated = await db.transaction(async () => {
      await db.prepare(
        `UPDATE product_units SET code = ?, name = ?, symbol = ?, base_weight_kg = ?, description = ?, is_active = ? WHERE id = ?`
      ).run(cleanCode, name.trim(), (symbol || cleanCode.toLowerCase()).trim(), baseWeight, description || '', activeVal, id);
      if (existing.code !== cleanCode) {
        await db.prepare('UPDATE items SET unit = ? WHERE unit = ?').run(cleanCode, existing.code);
      }
      return await db
        .prepare(
          `SELECT u.*, (SELECT COUNT(*) FROM items i WHERE i.unit = u.code) as product_count
           FROM product_units u WHERE u.id = ?`
        )
        .get(id);
    })();
    await writeAuditLog({
      employeeId: req.user!.id,
      employeeName: req.user!.full_name,
      action: 'UPDATE_PRODUCT_UNIT',
      entityType: 'PRODUCT_UNIT',
      entityId: cleanCode,
      beforeObj: existing,
      afterObj: updated,
    });
    res.json({ unit: updated });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.patch('/api/v1/product-units/:id/status', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM product_units WHERE id = ?').get(id) as
    | { id: number; code: string; is_active: number }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Product unit not found' });
    return;
  }
  const body = req.body as { is_active?: boolean | number };
  const nextActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active ? 0 : 1;
  await db.prepare('UPDATE product_units SET is_active = ? WHERE id = ?').run(nextActive, id);
  const updated = await db.prepare('SELECT * FROM product_units WHERE id = ?').get(id);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: nextActive ? 'ACTIVATE_PRODUCT_UNIT' : 'DEACTIVATE_PRODUCT_UNIT',
    entityType: 'PRODUCT_UNIT',
    entityId: existing.code,
    beforeObj: { is_active: existing.is_active },
    afterObj: { is_active: nextActive },
  });
  res.json({ unit: updated });
});

app.delete('/api/v1/product-units/:id', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM product_units WHERE id = ?').get(id) as
    | { id: number; code: string; name: string }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Product unit not found' });
    return;
  }
  const refCount = (await db.prepare('SELECT COUNT(*) as c FROM items WHERE unit = ?').get(existing.code) as { c: number }).c;
  if (refCount > 0) {
    res.status(409).json({
      error: `Cannot delete unit "${existing.name}" because ${refCount} product(s) currently use it. Set it Inactive instead.`,
    });
    return;
  }
  await db.prepare('DELETE FROM product_units WHERE id = ?').run(id);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: 'DELETE_PRODUCT_UNIT',
    entityType: 'PRODUCT_UNIT',
    entityId: existing.code,
    beforeObj: existing,
  });
  res.json({ deleted: true, id });
});

// Product Categories Master CRUD
app.get('/api/v1/product-categories', authenticate, async (_req, res) => {
  const categories = await db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category = c.code) as product_count
       FROM product_categories c ORDER BY c.id ASC`
    )
    .all();
  res.json({ categories });
});

app.post('/api/v1/product-categories', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const { code, name, group_type, default_costing_method, description, is_active } = req.body as {
    code: string;
    name: string;
    group_type?: string;
    default_costing_method?: string;
    description?: string;
    is_active?: boolean | number;
  };
  if (!code?.trim() || !name?.trim()) {
    res.status(400).json({ error: 'Category code and name are required' });
    return;
  }
  try {
    const cleanCode = code.trim().toUpperCase().replace(/\s+/g, '_');
    const activeVal = is_active === undefined ? 1 : is_active ? 1 : 0;
    const info = await db
      .prepare(
        `INSERT INTO product_categories (code, name, group_type, default_costing_method, description, is_active)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        cleanCode,
        name.trim(),
        group_type || 'FINISHED_GOOD',
        default_costing_method || 'FIFO',
        description || '',
        activeVal
      );
    const category = await db
      .prepare('SELECT *, 0 as product_count FROM product_categories WHERE id = ?')
      .get(info.lastInsertRowid);
    await writeAuditLog({
      employeeId: req.user!.id,
      employeeName: req.user!.full_name,
      action: 'CREATE_PRODUCT_CATEGORY',
      entityType: 'PRODUCT_CATEGORY',
      entityId: cleanCode,
      afterObj: category,
    });
    res.status(201).json({ category });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.put('/api/v1/product-categories/:id', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM product_categories WHERE id = ?').get(id) as
    | { id: number; code: string; is_active: number }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Product category not found' });
    return;
  }
  const { code, name, group_type, default_costing_method, description, is_active } = req.body as {
    code?: string;
    name?: string;
    group_type?: string;
    default_costing_method?: string;
    description?: string;
    is_active?: boolean | number;
  };
  if (!code?.trim() || !name?.trim()) {
    res.status(400).json({ error: 'Category code and name are required' });
    return;
  }
  try {
    const cleanCode = code.trim().toUpperCase().replace(/\s+/g, '_');
    const activeVal = is_active === undefined ? existing.is_active : is_active ? 1 : 0;
    const updated = await db.transaction(async () => {
      await db.prepare(
        `UPDATE product_categories
         SET code = ?, name = ?, group_type = ?, default_costing_method = ?, description = ?, is_active = ?
         WHERE id = ?`
      ).run(
        cleanCode,
        name.trim(),
        group_type || 'FINISHED_GOOD',
        default_costing_method || 'FIFO',
        description || '',
        activeVal,
        id
      );
      if (existing.code !== cleanCode) {
        await db.prepare('UPDATE items SET category = ? WHERE category = ?').run(cleanCode, existing.code);
      }
      return await db
        .prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM items i WHERE i.category = c.code) as product_count
           FROM product_categories c WHERE c.id = ?`
        )
        .get(id);
    })();
    await writeAuditLog({
      employeeId: req.user!.id,
      employeeName: req.user!.full_name,
      action: 'UPDATE_PRODUCT_CATEGORY',
      entityType: 'PRODUCT_CATEGORY',
      entityId: cleanCode,
      beforeObj: existing,
      afterObj: updated,
    });
    res.json({ category: updated });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.patch('/api/v1/product-categories/:id/status', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM product_categories WHERE id = ?').get(id) as
    | { id: number; code: string; is_active: number }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Product category not found' });
    return;
  }
  const body = req.body as { is_active?: boolean | number };
  const nextActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active ? 0 : 1;
  await db.prepare('UPDATE product_categories SET is_active = ? WHERE id = ?').run(nextActive, id);
  const updated = await db.prepare('SELECT * FROM product_categories WHERE id = ?').get(id);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: nextActive ? 'ACTIVATE_PRODUCT_CATEGORY' : 'DEACTIVATE_PRODUCT_CATEGORY',
    entityType: 'PRODUCT_CATEGORY',
    entityId: existing.code,
    beforeObj: { is_active: existing.is_active },
    afterObj: { is_active: nextActive },
  });
  res.json({ category: updated });
});

app.delete('/api/v1/product-categories/:id', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM product_categories WHERE id = ?').get(id) as
    | { id: number; code: string; name: string }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Product category not found' });
    return;
  }
  const refCount = (await db.prepare('SELECT COUNT(*) as c FROM items WHERE category = ?').get(existing.code) as { c: number }).c;
  if (refCount > 0) {
    res.status(409).json({
      error: `Cannot delete category "${existing.name}" because ${refCount} product(s) belong to it. Set it Inactive instead.`,
    });
    return;
  }
  await db.prepare('DELETE FROM product_categories WHERE id = ?').run(id);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: 'DELETE_PRODUCT_CATEGORY',
    entityType: 'PRODUCT_CATEGORY',
    entityId: existing.code,
    beforeObj: existing,
  });
  res.json({ deleted: true, id });
});

function resolveSignedOpeningBalance(
  amount: number | undefined,
  balanceMode: string | undefined,
  partyType: string
): number {
  const amt = Math.max(0, Number(amount || 0));
  if (amt === 0) return 0;
  if (balanceMode === 'CUSTOMER_DUE' || balanceMode === 'SUPPLIER_ADVANCE' || balanceMode === 'RECEIVABLE') return amt;
  if (balanceMode === 'SUPPLIER_DUE' || balanceMode === 'CUSTOMER_ADVANCE' || balanceMode === 'PAYABLE') return -amt;
  if (balanceMode === 'DUE') return partyType === 'SUPPLIER' ? -amt : amt;
  if (balanceMode === 'ADVANCE') return partyType === 'CUSTOMER' ? -amt : amt;
  return Number(amount || 0);
}

app.get('/api/v1/parties', authenticate, async (req: AuthedRequest, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const partiesRaw = await db.prepare(`${ENRICHED_PARTIES_SQL} ORDER BY pt.name ASC`).all() as Array<Record<string, unknown>>;
  const parties = physicalOnly
    ? partiesRaw
        .filter((p) => p.party_type === 'SUPPLIER' || p.party_type === 'BOTH')
        .map((p) => ({
          ...p,
          credit_limit: 0,
          opening_balance: 0,
          current_balance: 0,
          total_purchased: 0,
          total_sold: 0,
          total_paid_out: 0,
          total_received_in: 0,
          open_purchase_due: 0,
          open_sales_due: 0,
        }))
    : partiesRaw;
  res.json({ parties });
});

app.post('/api/v1/parties', authenticate, requirePermission('parties.manage'), async (req: AuthedRequest, res) => {
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
    is_active,
  } = req.body as {
    party_type: string;
    name: string;
    contact_person?: string;
    phone?: string;
    email?: string;
    tax_id?: string;
    address?: string;
    credit_limit?: number;
    opening_balance?: number;
    opening_balance_type?: string;
    is_active?: boolean | number;
  };
  if (!party_type || !name?.trim()) {
    res.status(400).json({ error: 'Party type and name are required' });
    return;
  }
  const signedOpening = resolveSignedOpeningBalance(opening_balance, opening_balance_type, party_type);
  const activeVal = is_active === undefined ? 1 : is_active ? 1 : 0;
  const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM parties').get() as { nextId: number }).nextId;
  const prefix = party_type === 'SUPPLIER' ? 'SUP' : party_type === 'CUSTOMER' ? 'CUS' : 'BTH';
  const partyCode = `${prefix}-${String(seq).padStart(3, '0')}`;
  const info = await db
    .prepare(
      `INSERT INTO parties (party_code, party_type, name, contact_person, phone, email, tax_id, address, credit_limit, opening_balance, current_balance, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      partyCode,
      party_type,
      name.trim(),
      contact_person || '',
      phone || '',
      email || '',
      tax_id || '',
      address || '',
      Number(credit_limit || 0),
      signedOpening,
      signedOpening,
      activeVal
    );
  const party = await db.prepare(`${ENRICHED_PARTIES_SQL} WHERE pt.id = ?`).get(info.lastInsertRowid);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: 'CREATE_PARTY',
    entityType: 'PARTY',
    entityId: partyCode,
    afterObj: party,
  });
  res.status(201).json({ party });
});

app.put('/api/v1/parties/:id', authenticate, requirePermission('parties.manage'), async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM parties WHERE id = ?').get(id) as
    | {
        id: number;
        party_code: string;
        party_type: string;
        opening_balance: number;
        current_balance: number;
        is_active: number;
      }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Party not found' });
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
    is_active,
  } = req.body as {
    party_type?: string;
    name?: string;
    contact_person?: string;
    phone?: string;
    email?: string;
    tax_id?: string;
    address?: string;
    credit_limit?: number;
    opening_balance?: number;
    opening_balance_type?: string;
    is_active?: boolean | number;
  };
  if (!name?.trim() || !party_type) {
    res.status(400).json({ error: 'Party type and name are required' });
    return;
  }

  const nextOpening =
    opening_balance !== undefined
      ? resolveSignedOpeningBalance(opening_balance, opening_balance_type, party_type)
      : Number(existing.opening_balance);
  const openingDelta = Number((nextOpening - Number(existing.opening_balance)).toFixed(2));
  const nextCurrent = Number((Number(existing.current_balance) + openingDelta).toFixed(2));
  const activeVal = is_active === undefined ? existing.is_active : is_active ? 1 : 0;

  await db.prepare(
    `UPDATE parties
     SET party_type = ?, name = ?, contact_person = ?, phone = ?, email = ?, tax_id = ?, address = ?, credit_limit = ?, opening_balance = ?, current_balance = ?, is_active = ?
     WHERE id = ?`
  ).run(
    party_type,
    name.trim(),
    contact_person || '',
    phone || '',
    email || '',
    tax_id || '',
    address || '',
    Number(credit_limit || 0),
    nextOpening,
    nextCurrent,
    activeVal,
    id
  );

  const updated = await db.prepare(`${ENRICHED_PARTIES_SQL} WHERE pt.id = ?`).get(id);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: 'UPDATE_PARTY',
    entityType: 'PARTY',
    entityId: existing.party_code,
    beforeObj: existing,
    afterObj: updated,
  });
  res.json({ party: updated });
});

app.patch('/api/v1/parties/:id/status', authenticate, requirePermission('parties.manage'), async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM parties WHERE id = ?').get(id) as
    | { id: number; party_code: string; is_active: number }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Party not found' });
    return;
  }
  const body = req.body as { is_active?: boolean | number };
  const nextActive = body.is_active !== undefined ? (body.is_active ? 1 : 0) : existing.is_active ? 0 : 1;
  await db.prepare('UPDATE parties SET is_active = ? WHERE id = ?').run(nextActive, id);
  const updated = await db.prepare(`${ENRICHED_PARTIES_SQL} WHERE pt.id = ?`).get(id);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: nextActive ? 'ACTIVATE_PARTY' : 'DEACTIVATE_PARTY',
    entityType: 'PARTY',
    entityId: existing.party_code,
    beforeObj: { is_active: existing.is_active },
    afterObj: { is_active: nextActive },
  });
  res.json({ party: updated });
});

app.delete('/api/v1/parties/:id', authenticate, requirePermission('parties.manage'), async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM parties WHERE id = ?').get(id) as
    | { id: number; party_code: string; name: string }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Party not found' });
    return;
  }

  const purCount = (await db.prepare('SELECT COUNT(*) as c FROM paddy_purchases WHERE supplier_id = ?').get(id) as { c: number }).c;
  const invCount = (await db.prepare('SELECT COUNT(*) as c FROM sales_invoices WHERE customer_id = ?').get(id) as { c: number }).c;
  const pSaleCount = (await db.prepare('SELECT COUNT(*) as c FROM paddy_sales WHERE customer_id = ?').get(id) as { c: number }).c;
  const payCount = (await db.prepare('SELECT COUNT(*) as c FROM payments WHERE party_id = ?').get(id) as { c: number }).c;

  if (purCount + invCount + pSaleCount + payCount > 0) {
    res.status(409).json({
      error: `Cannot delete "${existing.name}" because it has historical purchases, sales, or payments. Set it Inactive instead.`,
    });
    return;
  }

  await db.prepare('DELETE FROM parties WHERE id = ?').run(id);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: 'DELETE_PARTY',
    entityType: 'PARTY',
    entityId: existing.party_code,
    beforeObj: existing,
  });
  res.json({ deleted: true, id });
});

app.get('/api/v1/parties/:id/ledger', authenticate, async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const id = Number(req.params.id);
  const party = await db.prepare(`${ENRICHED_PARTIES_SQL} WHERE pt.id = ?`).get(id) as
    | (Record<string, unknown> & {
        id: number;
        party_type: string;
        opening_balance: number;
        current_balance: number;
      })
    | undefined;
  if (!party) {
    res.status(404).json({ error: 'Party not found' });
    return;
  }

  const purchases = await db
    .prepare(
      `SELECT pp.id, pp.purchase_no, pp.total_payable, pp.paid_amount, pp.payment_status, pp.payment_weight_kg, pp.created_at, i.name as item_name
       FROM paddy_purchases pp JOIN items i ON i.id = pp.item_id WHERE pp.supplier_id = ? ORDER BY pp.created_at ASC, pp.id ASC`
    )
    .all(id) as Array<{
    id: number;
    purchase_no: string;
    total_payable: number;
    paid_amount: number;
    payment_status: string;
    payment_weight_kg: number;
    created_at: string;
    item_name: string;
  }>;

  const invoices = await db
    .prepare(
      `SELECT id, invoice_no, total_amount, paid_amount, payment_status, vehicle_no, created_at
       FROM sales_invoices WHERE customer_id = ? ORDER BY created_at ASC, id ASC`
    )
    .all(id) as Array<{
    id: number;
    invoice_no: string;
    total_amount: number;
    paid_amount: number;
    payment_status: string;
    vehicle_no: string;
    created_at: string;
  }>;

  const paddySales = await db
    .prepare(
      `SELECT ps.id, ps.sale_no, ps.total_amount, ps.paid_amount, ps.payment_status, ps.qty_kg, ps.created_at, i.name as item_name
       FROM paddy_sales ps JOIN items i ON i.id = ps.item_id WHERE ps.customer_id = ? ORDER BY ps.created_at ASC, ps.id ASC`
    )
    .all(id) as Array<{
    id: number;
    sale_no: string;
    total_amount: number;
    paid_amount: number;
    payment_status: string;
    qty_kg: number;
    created_at: string;
    item_name: string;
  }>;

  const payments = await db
    .prepare(
      `SELECT pay.*, a.name as account_name
       FROM payments pay JOIN accounts a ON a.id = pay.account_id
       WHERE pay.party_id = ? ORDER BY pay.created_at ASC, pay.id ASC`
    )
    .all(id) as Array<{
    id: number;
    payment_no: string;
    direction: 'RECEIPT' | 'PAYMENT';
    voucher_type: string;
    amount: number;
    payment_mode: string;
    account_name: string;
    reference_no: string;
    settled_ref_no: string;
    notes: string;
    created_at: string;
  }>;

  const rawEvents: Array<{
    date: string;
    sortOrder: number;
    entry_type: 'PADDY_PURCHASE' | 'SALES_INVOICE' | 'PADDY_SALE' | 'PAYMENT';
    ref_no: string;
    description: string;
    debit_receivable: number;
    credit_payable: number;
    voucher_type?: string;
    payment_mode?: string;
  }> = [];

  for (const pp of purchases) {
    rawEvents.push({
      date: pp.created_at,
      sortOrder: 1,
      entry_type: 'PADDY_PURCHASE',
      ref_no: pp.purchase_no,
      description: `Paddy Purchase: ${pp.item_name} (${pp.payment_weight_kg.toLocaleString()} kg)${pp.paid_amount > 0 ? ` · Initial Paid ৳${pp.paid_amount.toLocaleString()}` : ''}`,
      debit_receivable: Number(pp.paid_amount || 0),
      credit_payable: Number(pp.total_payable || 0),
    });
  }

  for (const si of invoices) {
    rawEvents.push({
      date: si.created_at,
      sortOrder: 2,
      entry_type: 'SALES_INVOICE',
      ref_no: si.invoice_no,
      description: `Rice & By-Product Sales Invoice${si.vehicle_no ? ` (${si.vehicle_no})` : ''}${si.paid_amount > 0 ? ` · Initial Recd ৳${si.paid_amount.toLocaleString()}` : ''}`,
      debit_receivable: Number(si.total_amount || 0),
      credit_payable: Number(si.paid_amount || 0),
    });
  }

  for (const ps of paddySales) {
    rawEvents.push({
      date: ps.created_at,
      sortOrder: 3,
      entry_type: 'PADDY_SALE',
      ref_no: ps.sale_no,
      description: `Direct Paddy Sale: ${ps.item_name} (${ps.qty_kg.toLocaleString()} kg)`,
      debit_receivable: Number(ps.total_amount || 0),
      credit_payable: Number(ps.paid_amount || 0),
    });
  }

  for (const pay of payments) {
    const isReceipt = pay.direction === 'RECEIPT';
    rawEvents.push({
      date: pay.created_at,
      sortOrder: 4,
      entry_type: 'PAYMENT',
      ref_no: pay.payment_no,
      description: `${pay.voucher_type || pay.direction} via ${pay.account_name} (${pay.payment_mode})${pay.settled_ref_no ? ` · Ref: ${pay.settled_ref_no}` : ''}${pay.notes ? ` · ${pay.notes}` : ''}`,
      debit_receivable: isReceipt ? 0 : Number(pay.amount),
      credit_payable: isReceipt ? Number(pay.amount) : 0,
      voucher_type: pay.voucher_type,
      payment_mode: pay.payment_mode,
    });
  }

  rawEvents.sort((a, b) => a.date.localeCompare(b.date) || a.sortOrder - b.sortOrder);

  let running = Number(party.opening_balance || 0);
  const entries: Array<Record<string, unknown>> = [];
  if (running !== 0) {
    entries.push({
      date: 'Opening',
      entry_type: 'OPENING',
      ref_no: 'OPEN-BAL',
      description: running > 0 ? 'Opening Receivable / Supplier Advance' : 'Opening Payable / Customer Advance',
      debit_receivable: running > 0 ? running : 0,
      credit_payable: running < 0 ? Math.abs(running) : 0,
      running_balance: running,
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
      payment_mode: ev.payment_mode,
    });
  }

  const openBills = [
    ...purchases
      .filter((p) => p.payment_status !== 'PAID' && p.total_payable - p.paid_amount > 0.01)
      .map((p) => ({
        bill_type: 'PADDY_PURCHASE' as const,
        bill_id: p.id,
        bill_no: p.purchase_no,
        date: p.created_at,
        total_amount: p.total_payable,
        paid_amount: p.paid_amount,
        due_amount: Number((p.total_payable - p.paid_amount).toFixed(2)),
        payment_status: p.payment_status,
      })),
    ...invoices
      .filter((i) => i.payment_status !== 'PAID' && i.total_amount - i.paid_amount > 0.01)
      .map((i) => ({
        bill_type: 'SALES_INVOICE' as const,
        bill_id: i.id,
        bill_no: i.invoice_no,
        date: i.created_at,
        total_amount: i.total_amount,
        paid_amount: i.paid_amount,
        due_amount: Number((i.total_amount - i.paid_amount).toFixed(2)),
        payment_status: i.payment_status,
      })),
    ...paddySales
      .filter((s) => s.payment_status !== 'PAID' && s.total_amount - s.paid_amount > 0.01)
      .map((s) => ({
        bill_type: 'PADDY_SALE' as const,
        bill_id: s.id,
        bill_no: s.sale_no,
        date: s.created_at,
        total_amount: s.total_amount,
        paid_amount: s.paid_amount,
        due_amount: Number((s.total_amount - s.paid_amount).toFixed(2)),
        payment_status: s.payment_status,
      })),
  ];

  const curBal = Number(party.current_balance || 0);
  const pType = party.party_type;
  const customerDue = (pType === 'CUSTOMER' || pType === 'BOTH') && curBal > 0 ? curBal : 0;
  const customerAdvance = pType === 'CUSTOMER' && curBal < 0 ? Math.abs(curBal) : 0;
  const supplierDue = (pType === 'SUPPLIER' || pType === 'BOTH') && curBal < 0 ? Math.abs(curBal) : 0;
  const supplierAdvance = pType === 'SUPPLIER' && curBal > 0 ? curBal : 0;

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
      supplier_advance: Number(supplierAdvance.toFixed(2)),
    },
    open_bills: openBills,
    entries,
  });
});

// ---------------------------------------------------------------------------
// 4. Inventory Lots & Valuation
// ---------------------------------------------------------------------------
app.get('/api/v1/inventory/lots', authenticate, async (req: AuthedRequest, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const lotsRaw = await db
    .prepare(
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
                WHEN COALESCE(l.weight_pending, 0) = 1 THEN l.remaining_bags
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
       ORDER BY COALESCE(l.weight_pending, 0) DESC, l.remaining_qty_kg DESC, l.received_at ASC`
    )
    .all() as Array<Record<string, unknown>>;
  const lots = physicalOnly ? lotsRaw.map((l) => ({ ...l, unit_cost_per_kg: 0, pending_cost_total: 0 })) : lotsRaw;
  res.json({ lots });
});

app.get('/api/v1/inventory/ledger', authenticate, async (req: AuthedRequest, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const ledgerRaw = await db
    .prepare(
      `SELECT sl.*, l.lot_code, i.name as item_name, w.name as warehouse_name, e.full_name as employee_name
       FROM stock_ledger sl
       JOIN inventory_lots l ON l.id = sl.lot_id
       JOIN items i ON i.id = sl.item_id
       JOIN warehouses w ON w.id = sl.warehouse_id
       JOIN employees e ON e.id = sl.employee_id
       ORDER BY sl.id DESC LIMIT 150`
    )
    .all() as Array<Record<string, unknown>>;
  const ledger = physicalOnly ? ledgerRaw.map((row) => ({ ...row, unit_cost_per_kg: 0, total_cost: 0 })) : ledgerRaw;
  res.json({ ledger });
});

// ---------------------------------------------------------------------------
// 5. Paddy Purchases (Strict 4-Weight Preservation + Discrepancy Flagging)
// ---------------------------------------------------------------------------
app.get('/api/v1/paddy-purchases', authenticate, async (req: AuthedRequest, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const purchasesRaw = await db
    .prepare(
      `SELECT p.*, pt.name as supplier_name, pt.phone as supplier_phone, w.name as warehouse_name, i.name as item_name, e.full_name as created_by_name,
              COALESCE((SELECT SUM(l.remaining_qty_kg) FROM inventory_lots l WHERE l.source_type = 'PADDY_PURCHASE' AND l.source_id = p.id), 0) as unconsumed_lot_qty_kg,
              COALESCE((SELECT SUM(l.remaining_bags) FROM inventory_lots l WHERE l.source_type = 'PADDY_PURCHASE' AND l.source_id = p.id), 0) as unconsumed_lot_bags,
              COALESCE((SELECT SUM(l2.remaining_qty_kg) FROM inventory_lots l2 WHERE l2.item_id = p.item_id AND l2.remaining_qty_kg > 0.0001), 0) as available_variety_stock_kg
       FROM paddy_purchases p
       JOIN parties pt ON pt.id = p.supplier_id
       JOIN warehouses w ON w.id = p.warehouse_id
       JOIN items i ON i.id = p.item_id
       JOIN employees e ON e.id = p.created_by
       ORDER BY p.id DESC`
    )
    .all() as Array<Record<string, unknown>>;

  const returnsRaw = await db
    .prepare(
      `SELECT r.*, p.purchase_no, pt.name as supplier_name, i.name as item_name,
              a.name as account_name, emp.full_name as created_by_name
       FROM paddy_purchase_returns r
       JOIN paddy_purchases p ON p.id = r.purchase_id
       JOIN parties pt ON pt.id = r.supplier_id
       JOIN items i ON i.id = r.item_id
       LEFT JOIN accounts a ON a.id = r.account_id
       LEFT JOIN employees emp ON emp.id = r.created_by
       ORDER BY r.id DESC`
    )
    .all() as Array<Record<string, unknown>>;

  const returnsByPurchase = new Map<number, Array<Record<string, unknown>>>();
  for (const ret of returnsRaw) {
    const pid = Number(ret.purchase_id);
    const list = returnsByPurchase.get(pid) || [];
    list.push(ret);
    returnsByPurchase.set(pid, list);
  }

  const dryingRows = (await db
    .prepare(
      `SELECT d.id, d.purchase_id, d.drying_no, d.drying_method, d.input_qty_kg, d.input_bags,
              d.output_qty_kg, d.output_bags, d.dispatched_bags, d.moisture_loss_kg, d.weight_pending,
              d.status, d.created_at, wd.name as dest_warehouse_name,
              COALESCE(l.remaining_bags, 0) as lot_remaining_bags
       FROM paddy_drying_batches d
       JOIN warehouses wd ON wd.id = d.dest_warehouse_id
       LEFT JOIN inventory_lots l ON l.source_type = 'DRYING_OUTPUT' AND l.source_id = d.id
       WHERE d.purchase_id IS NOT NULL
       ORDER BY d.id DESC`
    )
    .all()) as Array<Record<string, unknown>>;

  const dryingByPurchase = new Map<number, Array<Record<string, unknown>>>();
  for (const dr of dryingRows) {
    const pid = Number(dr.purchase_id);
    if (!pid) continue;
    const list = dryingByPurchase.get(pid) || [];
    list.push(dr);
    dryingByPurchase.set(pid, list);
  }

  const chatalInputRows = (await db
    .prepare(
      `SELECT ci.purchase_id, ci.chatal_batch_id, ci.bag_count, ci.qty_kg
       FROM chatal_batch_inputs ci
       WHERE ci.purchase_id IS NOT NULL`
    )
    .all()) as Array<Record<string, unknown>>;

  const chatalByPurchase = new Map<number, { bags: number; kg: number; batchIds: Set<number> }>();
  for (const ci of chatalInputRows) {
    const pid = Number(ci.purchase_id);
    if (!pid) continue;
    const cur = chatalByPurchase.get(pid) || { bags: 0, kg: 0, batchIds: new Set<number>() };
    cur.bags += Number(ci.bag_count || 0);
    cur.kg += Number(ci.qty_kg || 0);
    if (ci.chatal_batch_id) cur.batchIds.add(Number(ci.chatal_batch_id));
    chatalByPurchase.set(pid, cur);
  }

  const purchases = purchasesRaw.map((p) => {
    const pid = Number(p.id);
    let splits: unknown[] = [];
    if (typeof p.split_summary_json === 'string' && p.split_summary_json.trim()) {
      try {
        splits = JSON.parse(p.split_summary_json);
      } catch {
        splits = [];
      }
    }
    const dryLogs = dryingByPurchase.get(pid) || [];
    const chatalAgg = chatalByPurchase.get(pid);

    let driedInputKg = 0;
    let driedInputBags = 0;
    let weighedInputKg = 0;
    let driedOutputKg = 0;
    let driedOutputBags = 0;
    let dryingLossKg = 0;
    let pendingInputKg = 0;
    let pendingOutputBags = 0;

    for (const dr of dryLogs) {
      const inKg = Number(dr.input_qty_kg || 0);
      const inBags = Number(dr.input_bags || 0);
      const outKg = Number(dr.output_qty_kg || 0);
      const outBags = Number(dr.output_bags || 0);
      const isPending = dr.status === 'PENDING_WEIGHT' || Number(dr.weight_pending || 0) === 1;
      driedInputKg += inKg;
      driedInputBags += inBags;
      driedOutputBags += outBags;
      if (outKg > 0) {
        weighedInputKg += inKg;
        driedOutputKg += outKg;
        dryingLossKg += Math.max(0, Number(dr.moisture_loss_kg ?? inKg - outKg));
      } else if (isPending) {
        pendingInputKg += inKg;
        pendingOutputBags += Number(dr.lot_remaining_bags || outBags);
      }
    }

    const row = {
      ...p,
      splits,
      return_logs: returnsByPurchase.get(pid) || [],
      drying_logs: dryLogs,
      drying_summary: {
        drying_batch_count: dryLogs.length,
        dried_input_kg: Number(driedInputKg.toFixed(2)),
        dried_input_bags: driedInputBags,
        weighed_input_kg: Number(weighedInputKg.toFixed(2)),
        dried_output_kg: Number(driedOutputKg.toFixed(2)),
        dried_output_bags: driedOutputBags,
        drying_loss_kg: Number(dryingLossKg.toFixed(2)),
        pending_input_kg: Number(pendingInputKg.toFixed(2)),
        pending_output_bags: pendingOutputBags,
        chatal_batch_count: chatalAgg ? chatalAgg.batchIds.size : 0,
        chatal_input_kg: Number((chatalAgg?.kg || 0).toFixed(2)),
        chatal_input_bags: chatalAgg?.bags || 0,
      },
    };
    return physicalOnly ? sanitizePurchaseForPhysical(row) : row;
  });

  res.json({ purchases });
});

app.post('/api/v1/paddy-purchases', authenticate, requirePermission('paddy.purchase.create'), async (req: AuthedRequest, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const body = req.body as {
    client_uuid?: string;
    device_id?: string;
    client_type?: 'WEB_PWA' | 'ANDROID_APP';
    supplier_id: number;
    warehouse_id: number;
    item_id: number;
    vehicle_no?: string;
    challan_no?: string;
    bag_count: number;
    jute_bag_count?: number;
    plastic_bag_count?: number;
    moisture_pct: number;
    supplier_claimed_weight_kg: number;
    scale_weight_kg: number;
    received_weight_kg: number;
    payment_weight_kg: number;
    weight_loss_kg?: number;
    settlement_unit_kg?: number;
    settlement_rate?: number;
    pending_rate?: boolean;
    discrepancy_notes?: string;
    rate_per_kg?: number;
    paid_amount?: number;
    auto_send_sms?: boolean;
    paddy_condition?: 'RAW_WET' | 'DRIED';
    weighbridge_mode?: 'MANUAL' | 'USB_SERIAL' | 'BLUETOOTH_SPP';
    splits?: Array<{
      warehouse_id: number;
      bag_count: number;
      jute_bag_count?: number;
      plastic_bag_count?: number;
      received_weight_kg: number;
    }>;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    const cached = idem.cachedResponse as Record<string, unknown>;
    if (physicalOnly && cached?.purchase) {
      res.status(200).json({ ...cached, purchase: sanitizePurchaseForPhysical(cached.purchase as Record<string, unknown>) });
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
  const isGodownIntake = physicalOnly || (Boolean(body.pending_rate) && !hasSettlementFormula && fallbackRatePerKg <= 0);

  const hasSplits = Array.isArray(body.splits) && body.splits.length > 0;
  const resolvedPrimaryWhId = Number(body.warehouse_id || (hasSplits ? body.splits![0]?.warehouse_id : 0));

  if (
    !body.supplier_id ||
    !resolvedPrimaryWhId ||
    !body.item_id ||
    body.supplier_claimed_weight_kg <= 0 ||
    body.scale_weight_kg <= 0 ||
    body.received_weight_kg <= 0 ||
    body.payment_weight_kg <= 0 ||
    settlementUnit <= 0 ||
    netBillableWeight <= 0 ||
    (!isGodownIntake && !hasSettlementFormula && fallbackRatePerKg <= 0)
  ) {
    res.status(400).json({ error: 'All four weight fields, positive net settlement weight, divisor, supplier, warehouse, and item are required' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM paddy_purchases').get() as { nextId: number }).nextId;
      const purchaseNo = `PUR-2026-${String(seq).padStart(4, '0')}`;
      const qrUid = crypto.randomUUID();

      // Critical business rule: Never silently modify weight discrepancies. Preserve all 4 weights.
      const weightDiscrepancy = Number((body.scale_weight_kg - body.supplier_claimed_weight_kg).toFixed(3));
      const discrepancyFlagged = Math.abs(weightDiscrepancy) > 20 || Math.abs(body.scale_weight_kg - body.received_weight_kg) > 25 ? 1 : 0;

      // Settlement formula: ((Payment Settlement Weight - Weight Loss) / Settlement Unit [default 75.5]) * Rate
      const effectiveSettlementRate = isGodownIntake
        ? 0
        : hasSettlementFormula
        ? settlementRate
        : Number((fallbackRatePerKg * settlementUnit).toFixed(4));
      const totalPayable = isGodownIntake
        ? 0
        : hasSettlementFormula
        ? Number(((netBillableWeight / settlementUnit) * settlementRate).toFixed(2))
        : Number((netBillableWeight * fallbackRatePerKg).toFixed(2));
      const effectiveRatePerKg = isGodownIntake ? 0 : Number((totalPayable / body.payment_weight_kg).toFixed(4));

      const paidAmt = isGodownIntake ? 0 : Math.min(totalPayable, Math.max(0, Number(body.paid_amount || 0)));
      const payStatus = isGodownIntake || paidAmt <= 0 ? 'UNPAID' : paidAmt >= totalPayable ? 'PAID' : 'PARTIAL';
      const pricingStatus = isGodownIntake ? 'PENDING_RATE' : 'PRICED';

      const reqJute = Math.max(0, Math.round(Number(body.jute_bag_count || 0)));
      const reqPlastic = Math.max(0, Math.round(Number(body.plastic_bag_count || 0)));
      const reqTotal = Math.max(0, Math.round(Number(body.bag_count || 0)));
      const juteBags = reqJute === 0 && reqPlastic === 0 && reqTotal > 0 ? reqTotal : reqJute;
      const plasticBags = reqPlastic;
      const totalBags = juteBags + plasticBags;

      const computedSplits: Array<{
        warehouse_id: number;
        warehouse_name: string;
        bag_count: number;
        jute_bag_count: number;
        plastic_bag_count: number;
        received_weight_kg: number;
        net_units: number;
        allocated_amount: number;
      }> = [];

      if (hasSplits) {
        let sumWeight = 0;
        let sumBags = 0;
        for (const s of body.splits!) {
          const wh = await db.prepare('SELECT id, name FROM warehouses WHERE id = ?').get(Number(s.warehouse_id)) as
            | { id: number; name: string }
            | undefined;
          if (!wh) throw new Error('Invalid warehouse selected inside multi-godown split');
          const sWt = Number(s.received_weight_kg || 0);
          const sBags = Math.max(0, Math.round(Number(s.bag_count || 0)));
          if (sWt <= 0) throw new Error('Each split godown weight must be positive');
          if (sBags > 0 && sWt <= sBags) throw new Error('Each split godown weight (kg) must exceed its bag count');
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
            allocated_amount: isGodownIntake ? 0 : Number(((sWt / body.received_weight_kg) * totalPayable).toFixed(2)),
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

      const paddyCondition = body.paddy_condition === 'DRIED' ? 'DRIED' : 'RAW_WET';

      const info = await db
        .prepare(
          `INSERT INTO paddy_purchases (
            client_uuid, purchase_no, supplier_id, warehouse_id, item_id, vehicle_no, challan_no,
            bag_count, jute_bag_count, plastic_bag_count, moisture_pct, supplier_claimed_weight_kg, scale_weight_kg, received_weight_kg,
            payment_weight_kg, weight_loss_kg, settlement_unit_kg, settlement_rate,
            weight_discrepancy_kg, discrepancy_flagged, discrepancy_notes,
            rate_per_kg, total_payable, paid_amount, payment_status, pricing_status, paddy_condition, qr_code_uid, weighbridge_mode, split_summary_json, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          clientUuid,
          purchaseNo,
          body.supplier_id,
          resolvedPrimaryWhId,
          body.item_id,
          body.vehicle_no || '',
          body.challan_no || '',
          totalBags,
          juteBags,
          plasticBags,
          Number(body.moisture_pct || (paddyCondition === 'RAW_WET' ? 18 : 13.5)),
          body.supplier_claimed_weight_kg,
          body.scale_weight_kg,
          body.received_weight_kg,
          body.payment_weight_kg,
          weightLoss,
          settlementUnit,
          effectiveSettlementRate,
          weightDiscrepancy,
          discrepancyFlagged,
          body.discrepancy_notes || '',
          effectiveRatePerKg,
          totalPayable,
          paidAmt,
          payStatus,
          pricingStatus,
          paddyCondition,
          qrUid,
          body.weighbridge_mode || 'MANUAL',
          computedSplits.length > 0 ? JSON.stringify(computedSplits) : null,
          req.user!.id
        );

      const purchaseId = Number(info.lastInsertRowid);
      const effectiveUnitCost = isGodownIntake ? 0 : Number((totalPayable / body.received_weight_kg).toFixed(4));
      const itemRow = await db.prepare('SELECT name FROM items WHERE id = ?').get(body.item_id) as { name: string };

      let primaryLot: { lotId: number; lotCode: string; qrCodeUid: string } | null = null;
      const splitLots: Array<{ lotId: number; lotCode: string; qrCodeUid: string; warehouse_id: number; qty_kg: number; bag_count: number }> = [];

      if (computedSplits.length > 0) {
        for (let idx = 0; idx < computedSplits.length; idx++) {
          const sp = computedSplits[idx];
          const lotUid = idx === 0 ? qrUid : crypto.randomUUID();
          const lot = await createInventoryLot({
            prefix: 'LOT-PAD',
            itemId: body.item_id,
            warehouseId: sp.warehouse_id,
            sourceType: 'PADDY_PURCHASE',
            sourceId: purchaseId,
            qtyKg: sp.received_weight_kg,
            bagCount: sp.bag_count,
            unitCostPerKg: effectiveUnitCost,
            moisturePct: body.moisture_pct,
            movementType: 'PURCHASE_IN',
            employeeId: req.user!.id,
            qrUid: lotUid,
          });
          if (idx === 0) primaryLot = lot;
          splitLots.push({ ...lot, warehouse_id: sp.warehouse_id, qty_kg: sp.received_weight_kg, bag_count: sp.bag_count });
          await registerQrTag({
            qrCodeUid: lotUid,
            entityType: 'PADDY_LOT',
            entityId: lot.lotId,
            entityCode: lot.lotCode,
            payload: {
              purchase_no: purchaseNo,
              lot_code: lot.lotCode,
              item: itemRow.name,
              warehouse: sp.warehouse_name,
              split_qty_kg: sp.received_weight_kg,
              split_bags: sp.bag_count,
              split_net_units: sp.net_units,
            },
          });
        }
      } else {
        const lot = await createInventoryLot({
          prefix: 'LOT-PAD',
          itemId: body.item_id,
          warehouseId: resolvedPrimaryWhId,
          sourceType: 'PADDY_PURCHASE',
          sourceId: purchaseId,
          qtyKg: body.received_weight_kg,
          bagCount: totalBags,
          unitCostPerKg: effectiveUnitCost,
          moisturePct: body.moisture_pct,
          movementType: 'PURCHASE_IN',
          employeeId: req.user!.id,
          qrUid,
        });
        primaryLot = lot;
        const whRow = await db.prepare('SELECT name FROM warehouses WHERE id = ?').get(resolvedPrimaryWhId) as { name: string };
        await registerQrTag({
          qrCodeUid: qrUid,
          entityType: 'PADDY_LOT',
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
            payment_kg: body.payment_weight_kg,
          },
        });
      }

      if (totalBags > 0) {
        const bagSeq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM supplier_bag_ledger').get() as { nextId: number }).nextId;
        const entryNo = `BAG-2026-${String(bagSeq).padStart(4, '0')}`;
        await db.prepare(
          `INSERT INTO supplier_bag_ledger (
            client_uuid, entry_no, supplier_id, entry_type, direction,
            jute_qty, plastic_qty, total_qty, reference_type, reference_id, reference_no, entry_date, notes, created_by
          ) VALUES (?, ?, ?, 'PADDY_DEPOSIT', 'IN_FROM_SUPPLIER', ?, ?, ?, 'PADDY_PURCHASE', ?, ?, date('now'), ?, ?)`
        ).run(
          crypto.randomUUID(),
          entryNo,
          body.supplier_id,
          juteBags,
          plasticBags,
          totalBags,
          purchaseId,
          purchaseNo,
          `Bags deposited with paddy purchase ${purchaseNo}`,
          req.user!.id
        );
      }

      if (!isGodownIntake && totalPayable > 0) {
        // Update supplier balance (negative = payable to supplier)
        const unpaidDelta = totalPayable - paidAmt;
        await db.prepare('UPDATE parties SET current_balance = current_balance - ? WHERE id = ?').run(unpaidDelta, body.supplier_id);

        // Accounting Journal Entry
        const journalLines = [
          { accountCode: '1200', debit: totalPayable, credit: 0 },
          { accountCode: '2001', debit: 0, credit: unpaidDelta, partyId: body.supplier_id },
        ];
        if (paidAmt > 0) {
          journalLines.push({ accountCode: '1001', debit: 0, credit: paidAmt });
        }
        await postJournalEntry({
          description: `Paddy Purchase ${purchaseNo} (${body.received_weight_kg} kg received / ${body.payment_weight_kg} kg billed)`,
          referenceType: 'PADDY_PURCHASE',
          referenceId: purchaseId,
          employeeId: req.user!.id,
          lines: journalLines,
        });
      }

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: isGodownIntake
          ? 'PADDY_GODOWN_INTAKE_CREATED'
          : discrepancyFlagged
          ? 'PADDY_PURCHASE_WITH_DISCREPANCY'
          : 'PADDY_PURCHASE_CREATED',
        entityType: 'PADDY_PURCHASE',
        entityId: purchaseNo,
        afterObj: {
          claimed: body.supplier_claimed_weight_kg,
          scale: body.scale_weight_kg,
          received: body.received_weight_kg,
          payment: body.payment_weight_kg,
          discrepancy: weightDiscrepancy,
          pricing_status: pricingStatus,
          total_payable: totalPayable,
          splits: computedSplits.length > 0 ? computedSplits : undefined,
        },
        deviceType: body.client_type || 'WEB_PWA',
      });

      const created = await db
        .prepare(
          `SELECT p.*, pt.name as supplier_name, pt.phone as supplier_phone, w.name as warehouse_name, i.name as item_name
           FROM paddy_purchases p
           JOIN parties pt ON pt.id = p.supplier_id
           JOIN warehouses w ON w.id = p.warehouse_id
           JOIN items i ON i.id = p.item_id
           WHERE p.id = ?`
        )
        .get(purchaseId) as Record<string, unknown>;

      const responseObj = {
        status: 'SYNCED',
        purchase: { ...created, splits: computedSplits, return_logs: [] },
        lot: primaryLot,
        split_lots: splitLots,
      };
      await recordSyncLog({
        clientUuid,
        deviceId: body.device_id || 'WEB-BROWSER',
        clientType: body.client_type || 'WEB_PWA',
        endpoint: '/api/v1/paddy-purchases',
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });

      return physicalOnly
        ? { ...responseObj, purchase: sanitizePurchaseForPhysical(responseObj.purchase as Record<string, unknown>) }
        : responseObj;
    })();

    let smsNotification: AutoSmsResult | null = null;
    if (body.auto_send_sms !== false && result?.purchase) {
      try {
        smsNotification = await dispatchPaddyPurchaseSms({
          purchase: result.purchase as Record<string, unknown>,
          employeeId: req.user!.id,
          triggerType: 'CREATE',
        });
      } catch {
        // Non-fatal: purchase commit remains intact even if external SMS gateway fails
      }
    }

    res.status(201).json({
      ...result,
      sms_notification: smsNotification,
    });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Admin/Accountant sets rate & settlement on a Godown Keeper PENDING_RATE paddy intake
app.put('/api/v1/paddy-purchases/:id/price', authenticate, async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const canPrice =
    req.user?.role_code === 'OWNER' ||
    req.user?.role_code === 'MANAGER' ||
    req.user?.role_code === 'ACCOUNTANT' ||
    (req.user?.permissions || []).includes('accounting.post');
  if (!canPrice) {
    res.status(403).json({ error: 'Only Admin, Manager, or Accountant can set paddy purchase rates' });
    return;
  }

  const purchaseId = Number(req.params.id);
  const body = req.body as {
    settlement_unit_kg?: number;
    settlement_rate?: number;
    rate_per_kg?: number;
    weight_loss_kg?: number;
    paid_amount?: number;
    account_id?: number;
  };

  try {
    const updatedPurchase = await db.transaction(async () => {
      const purchase = await db
        .prepare('SELECT * FROM paddy_purchases WHERE id = ?')
        .get(purchaseId) as
        | {
            id: number;
            purchase_no: string;
            supplier_id: number;
            received_weight_kg: number;
            payment_weight_kg: number;
            weight_loss_kg: number;
            settlement_unit_kg: number;
            pricing_status?: string;
            total_payable: number;
            split_summary_json?: string | null;
          }
        | undefined;
      if (!purchase) throw new Error('Paddy purchase record not found');
      if (purchase.pricing_status === 'PRICED' && Number(purchase.total_payable || 0) > 0) {
        throw new Error('This paddy purchase is already priced');
      }

      const weightLoss = Math.max(0, Number(body.weight_loss_kg ?? purchase.weight_loss_kg ?? 0));
      const settlementUnit = Number(body.settlement_unit_kg || purchase.settlement_unit_kg || 75.5);
      const settlementRate = Number(body.settlement_rate || 0);
      const fallbackRatePerKg = Number(body.rate_per_kg || 0);
      const netBillableWeight = Number((Number(purchase.payment_weight_kg) - weightLoss).toFixed(3));
      const hasSettlementFormula = settlementRate > 0 && settlementUnit > 0;

      if (settlementUnit <= 0 || netBillableWeight <= 0 || (!hasSettlementFormula && fallbackRatePerKg <= 0)) {
        throw new Error('Valid positive settlement unit weight and paddy rate are required');
      }

      const effectiveSettlementRate = hasSettlementFormula
        ? settlementRate
        : Number((fallbackRatePerKg * settlementUnit).toFixed(4));
      const totalPayable = hasSettlementFormula
        ? Number(((netBillableWeight / settlementUnit) * settlementRate).toFixed(2))
        : Number((netBillableWeight * fallbackRatePerKg).toFixed(2));
      const effectiveRatePerKg = Number((totalPayable / Number(purchase.payment_weight_kg)).toFixed(4));
      const paidAmt = Math.min(totalPayable, Math.max(0, Number(body.paid_amount || 0)));
      const payStatus = paidAmt <= 0 ? 'UNPAID' : paidAmt >= totalPayable ? 'PAID' : 'PARTIAL';

      let updatedSplitsJson: string | null = purchase.split_summary_json ?? null;
      if (typeof purchase.split_summary_json === 'string' && purchase.split_summary_json.trim()) {
        try {
          const parsed = JSON.parse(purchase.split_summary_json) as Array<Record<string, unknown>>;
          const nextSplits = parsed.map((sp) => ({
            ...sp,
            allocated_amount: Number(((Number(sp.received_weight_kg || 0) / Number(purchase.received_weight_kg)) * totalPayable).toFixed(2)),
          }));
          updatedSplitsJson = JSON.stringify(nextSplits);
        } catch {
          // keep original if parse fails
        }
      }

      await db.prepare(
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
      const lots = await db
        .prepare("SELECT id FROM inventory_lots WHERE source_type = 'PADDY_PURCHASE' AND source_id = ?")
        .all(purchaseId) as Array<{ id: number }>;
      const updLot = db.prepare('UPDATE inventory_lots SET unit_cost_per_kg = ? WHERE id = ?');
      const updLedger = db.prepare(
        "UPDATE stock_ledger SET unit_cost_per_kg = ?, total_cost = ROUND(ABS(qty_change_kg) * ?, 2) WHERE lot_id = ? AND movement_type = 'PURCHASE_IN'"
      );
      for (const l of lots) {
        await updLot.run(effectiveUnitCost, l.id);
        await updLedger.run(effectiveUnitCost, effectiveUnitCost, l.id);
      }

      const unpaidDelta = totalPayable - paidAmt;
      await db.prepare('UPDATE parties SET current_balance = current_balance - ? WHERE id = ?').run(unpaidDelta, purchase.supplier_id);

      let payAccCode = '1001';
      if (paidAmt > 0 && body.account_id) {
        const acc = await db.prepare('SELECT account_code FROM accounts WHERE id = ?').get(Number(body.account_id)) as
          | { account_code: string }
          | undefined;
        if (acc?.account_code) payAccCode = acc.account_code;
      }

      const journalLines = [
        { accountCode: '1200', debit: totalPayable, credit: 0 },
        { accountCode: '2001', debit: 0, credit: unpaidDelta, partyId: purchase.supplier_id },
      ];
      if (paidAmt > 0) {
        journalLines.push({ accountCode: payAccCode, debit: 0, credit: paidAmt });
      }
      await postJournalEntry({
        description: `Paddy Purchase Priced ${purchase.purchase_no} (Rate settled by Admin/Accounts)`,
        referenceType: 'PADDY_PURCHASE',
        referenceId: purchaseId,
        employeeId: req.user!.id,
        lines: journalLines,
      });

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'PADDY_PURCHASE_PRICED',
        entityType: 'PADDY_PURCHASE',
        entityId: purchase.purchase_no,
        afterObj: {
          settlement_unit_kg: settlementUnit,
          settlement_rate: effectiveSettlementRate,
          total_payable: totalPayable,
          paid_amount: paidAmt,
        },
      });

      const created = await db
        .prepare(
          `SELECT p.*, pt.name as supplier_name, pt.phone as supplier_phone, w.name as warehouse_name, i.name as item_name, e.full_name as created_by_name
           FROM paddy_purchases p
           JOIN parties pt ON pt.id = p.supplier_id
           JOIN warehouses w ON w.id = p.warehouse_id
           JOIN items i ON i.id = p.item_id
           JOIN employees e ON e.id = p.created_by
           WHERE p.id = ?`
        )
        .get(purchaseId) as Record<string, unknown>;

      return { ...created, splits: updatedSplitsJson ? JSON.parse(updatedSplitsJson) : [], return_logs: [] };
    })();

    let smsNotification: AutoSmsResult | null = null;
    try {
      smsNotification = await dispatchPaddyPurchaseSms({
        purchase: updatedPurchase as Record<string, unknown>,
        employeeId: req.user!.id,
        triggerType: 'PRICE',
      });
    } catch {
      // Non-fatal
    }

    res.json({ status: 'PRICED', purchase: updatedPurchase, sms_notification: smsNotification });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Paddy Purchase Return (Partial or Full Reversal with Stock, Ledger, GL & Bag Adjustment)
app.post('/api/v1/paddy-purchases/:id/return', authenticate, requirePermission('paddy.purchase.create'), async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const purchaseId = Number(req.params.id);
  const body = req.body as {
    client_uuid?: string;
    return_type?: 'PHYSICAL_RETURN' | 'FINANCIAL_ADJUSTMENT';
    return_qty_kg: number;
    return_jute_bags?: number;
    return_plastic_bags?: number;
    return_bags?: number;
    return_amount?: number;
    refund_mode?: 'ADJUST_PAYABLE' | 'CASH_REFUND';
    account_id?: number;
    reason?: string;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  const returnType: 'PHYSICAL_RETURN' | 'FINANCIAL_ADJUSTMENT' =
    body.return_type === 'FINANCIAL_ADJUSTMENT' ? 'FINANCIAL_ADJUSTMENT' : 'PHYSICAL_RETURN';
  const returnQtyKg = Math.max(0, Number(body.return_qty_kg || 0));
  if (returnType === 'PHYSICAL_RETURN' && (!Number.isFinite(returnQtyKg) || returnQtyKg <= 0)) {
    res.status(400).json({ error: 'Return quantity (kg) must be greater than zero' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const purchase = await db
        .prepare(
          `SELECT p.*, i.costing_method, pt.name as supplier_name, i.name as item_name
           FROM paddy_purchases p
           JOIN items i ON i.id = p.item_id
           JOIN parties pt ON pt.id = p.supplier_id
           WHERE p.id = ?`
        )
        .get(purchaseId) as
        | {
            id: number;
            purchase_no: string;
            supplier_id: number;
            supplier_name: string;
            warehouse_id: number;
            item_id: number;
            item_name: string;
            costing_method: CostingMethod;
            received_weight_kg: number;
            total_payable: number;
            paid_amount: number;
            returned_qty_kg: number;
            returned_amount: number;
          }
        | undefined;
      if (!purchase) throw new Error('Paddy purchase record not found');

      let lotsToDeduct: Array<{ id: number; warehouse_id: number; remaining_qty_kg: number; remaining_bags: number }> = [];
      if (returnType === 'PHYSICAL_RETURN') {
        const ownLots = await db
          .prepare(
            `SELECT id, warehouse_id, remaining_qty_kg, remaining_bags
             FROM inventory_lots
             WHERE source_type = 'PADDY_PURCHASE' AND source_id = ? AND remaining_qty_kg > 0.0001
             ORDER BY id ASC`
          )
          .all(purchaseId) as Array<{ id: number; warehouse_id: number; remaining_qty_kg: number; remaining_bags: number }>;

        const ownQty = ownLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);

        if (ownQty + 0.01 >= returnQtyKg) {
          lotsToDeduct = ownLots;
        } else {
          // Include transferred or pooled stock of the same paddy variety if original lot was moved
          const otherVarietyLots = await db
            .prepare(
              `SELECT id, warehouse_id, remaining_qty_kg, remaining_bags
               FROM inventory_lots
               WHERE item_id = ? AND remaining_qty_kg > 0.0001
                 AND NOT (source_type = 'PADDY_PURCHASE' AND source_id = ?)
               ORDER BY CASE WHEN warehouse_id = ? THEN 0 WHEN source_type = 'TRANSFER_IN' THEN 1 ELSE 2 END ASC, id ASC`
            )
            .all(purchase.item_id, purchaseId, purchase.warehouse_id) as Array<{
            id: number;
            warehouse_id: number;
            remaining_qty_kg: number;
            remaining_bags: number;
          }>;
          const totalAvailable = ownQty + otherVarietyLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);
          if (totalAvailable + 0.01 < returnQtyKg) {
            throw new Error(
              totalAvailable <= 0.01
                ? `${purchase.purchase_no}-এর ধান ইতিমধ্যেই ডায়ার/মিলিংয়ে ব্যবহৃত হয়েছে (অব্যবহৃত স্টক ০.০০ কেজি)। স্টক ছাড়া শুধু টাকা বা বিল সংশোধন করতে 'শুধু টাকা/বিল সংশোধন' মোড ব্যবহার করুন।`
                : `${purchase.purchase_no} ও গুদামে ${purchase.item_name}-এর অব্যবহৃত মজুদ আছে ${totalAvailable.toFixed(2)} কেজি (${returnQtyKg.toFixed(2)} কেজি ফেরত দেওয়া সম্ভব নয়)।`
            );
          }
          lotsToDeduct = [...ownLots, ...otherVarietyLots];
        }
      }

      const maxReturnableAmt = Math.max(0, Number((Number(purchase.total_payable) - Number(purchase.returned_amount || 0)).toFixed(2)));
      const proportionalAmt =
        returnQtyKg > 0 && Number(purchase.received_weight_kg) > 0
          ? Number(((returnQtyKg / Number(purchase.received_weight_kg)) * Number(purchase.total_payable)).toFixed(2))
          : 0;
      const returnAmount =
        body.return_amount && Number(body.return_amount) > 0
          ? Math.min(maxReturnableAmt, Number(Number(body.return_amount).toFixed(2)))
          : Math.min(maxReturnableAmt, proportionalAmt);

      if (returnAmount <= 0) throw new Error('Return / adjustment amount must be greater than zero');

      const juteRet = Math.max(0, Math.round(Number(body.return_jute_bags || 0)));
      const plasticRet = Math.max(0, Math.round(Number(body.return_plastic_bags || 0)));
      const explicitTotalRet = Math.max(0, Math.round(Number(body.return_bags || 0)));
      const returnBags = juteRet + plasticRet > 0 ? juteRet + plasticRet : explicitTotalRet;
      const finalJuteRet = juteRet + plasticRet > 0 ? juteRet : returnBags;
      const finalPlasticRet = juteRet + plasticRet > 0 ? plasticRet : 0;

      const refundMode: 'ADJUST_PAYABLE' | 'CASH_REFUND' =
        body.refund_mode === 'CASH_REFUND' ? 'CASH_REFUND' : 'ADJUST_PAYABLE';

      let accRow: { id: number; account_code: string; name: string } | undefined;
      if (refundMode === 'CASH_REFUND') {
        accRow = body.account_id
          ? (await db.prepare('SELECT id, account_code, name FROM accounts WHERE id = ?').get(Number(body.account_id)) as
              | { id: number; account_code: string; name: string }
              | undefined)
          : (await db.prepare("SELECT id, account_code, name FROM accounts WHERE account_code = '1001' LIMIT 1").get() as
              | { id: number; account_code: string; name: string }
              | undefined);
        if (!accRow) throw new Error('Refund account not found');
      }

      const retSeq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM paddy_purchase_returns').get() as { nextId: number }).nextId;
      const returnNo = `RET-2026-${String(retSeq).padStart(4, '0')}`;

      const retIns = await db
        .prepare(
          `INSERT INTO paddy_purchase_returns (
            client_uuid, return_no, purchase_id, supplier_id, item_id,
            return_qty_kg, return_bags, return_jute_bags, return_plastic_bags,
            return_amount, refund_mode, account_id, reason, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
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
          String(body.reason || '').trim(),
          req.user!.id
        );
      const returnId = Number(retIns.lastInsertRowid);

      if (returnType === 'PHYSICAL_RETURN' && returnQtyKg > 0) {
        let remToDeduct = returnQtyKg;
        let remBagsToDeduct = returnBags;
        for (const lot of lotsToDeduct) {
          if (remToDeduct <= 0.0001) break;
          const takeKg = Math.min(remToDeduct, Number(lot.remaining_qty_kg));
          const takeBags =
            remBagsToDeduct > 0 && Number(lot.remaining_bags || 0) > 0
              ? Math.min(remBagsToDeduct, Number(lot.remaining_bags))
              : undefined;
          await consumeWarehouseStock({
            itemId: purchase.item_id,
            warehouseId: lot.warehouse_id,
            qtyKg: takeKg,
            bagCount: takeBags,
            preferredLotId: lot.id,
            costingMethod: 'FIFO',
            movementType: 'PURCHASE_RETURN',
            referenceType: 'PADDY_PURCHASE_RETURN',
            referenceId: returnId,
            employeeId: req.user!.id,
          });
          remToDeduct = Number((remToDeduct - takeKg).toFixed(4));
          if (takeBags) remBagsToDeduct = Math.max(0, remBagsToDeduct - takeBags);
        }
      }

      const nextReturnedQty = Number((Number(purchase.returned_qty_kg || 0) + returnQtyKg).toFixed(3));
      const nextReturnedAmt = Number((Number(purchase.returned_amount || 0) + returnAmount).toFixed(2));
      const netPayableAfter = Math.max(0, Number((Number(purchase.total_payable) - nextReturnedAmt).toFixed(2)));
      const nextStatus =
        Number(purchase.paid_amount || 0) >= netPayableAfter - 0.01
          ? 'PAID'
          : Number(purchase.paid_amount || 0) > 0
          ? 'PARTIAL'
          : 'UNPAID';

      await db.prepare(
        'UPDATE paddy_purchases SET returned_qty_kg = ?, returned_amount = ?, payment_status = ? WHERE id = ?'
      ).run(nextReturnedQty, nextReturnedAmt, nextStatus, purchaseId);

      // Supplier payable decreases (credit balance moves positive by returnAmount unless cash refunded directly)
      if (refundMode === 'ADJUST_PAYABLE') {
        await db.prepare('UPDATE parties SET current_balance = current_balance + ? WHERE id = ?').run(returnAmount, purchase.supplier_id);
      }

      await postJournalEntry({
        description:
          returnType === 'FINANCIAL_ADJUSTMENT'
            ? `Paddy Purchase Financial Adjustment ${returnNo} against ${purchase.purchase_no} (৳${returnAmount})`
            : `Paddy Purchase Return ${returnNo} against ${purchase.purchase_no} (${returnQtyKg} kg)`,
        referenceType: 'PADDY_PURCHASE_RETURN',
        referenceId: returnId,
        employeeId: req.user!.id,
        lines: [
          {
            accountCode: refundMode === 'CASH_REFUND' && accRow ? accRow.account_code : '2001',
            debit: returnAmount,
            credit: 0,
            partyId: refundMode === 'ADJUST_PAYABLE' ? purchase.supplier_id : null,
          },
          { accountCode: returnType === 'FINANCIAL_ADJUSTMENT' ? '5200' : '1200', debit: 0, credit: returnAmount },
        ],
      });

      if (returnBags > 0) {
        const bagSeq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM supplier_bag_ledger').get() as { nextId: number }).nextId;
        const entryNo = `BAG-2026-${String(bagSeq).padStart(4, '0')}`;
        await db.prepare(
          `INSERT INTO supplier_bag_ledger (
            client_uuid, entry_no, supplier_id, entry_type, direction,
            jute_qty, plastic_qty, total_qty, reference_type, reference_id, reference_no, entry_date, notes, created_by
          ) VALUES (?, ?, ?, 'EMPTY_PICKUP', 'OUT_TO_SUPPLIER', ?, ?, ?, 'PADDY_PURCHASE_RETURN', ?, ?, date('now'), ?, ?)`
        ).run(
          crypto.randomUUID(),
          entryNo,
          purchase.supplier_id,
          finalJuteRet,
          finalPlasticRet,
          returnBags,
          returnId,
          returnNo,
          `Bags returned on purchase return ${returnNo} (${purchase.purchase_no})`,
          req.user!.id
        );
      }

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'PADDY_PURCHASE_RETURNED',
        entityType: 'PADDY_PURCHASE_RETURN',
        entityId: returnNo,
        afterObj: { purchase_no: purchase.purchase_no, return_qty_kg: returnQtyKg, return_amount: returnAmount, refund_mode: refundMode },
      });

      const returnRecord = await db
        .prepare(
          `SELECT r.*, p.purchase_no, pt.name as supplier_name, i.name as item_name,
                  a.name as account_name, emp.full_name as created_by_name
           FROM paddy_purchase_returns r
           JOIN paddy_purchases p ON p.id = r.purchase_id
           JOIN parties pt ON pt.id = r.supplier_id
           JOIN items i ON i.id = r.item_id
           LEFT JOIN accounts a ON a.id = r.account_id
           LEFT JOIN employees emp ON emp.id = r.created_by
           WHERE r.id = ?`
        )
        .get(returnId);

      const responseObj = { status: 'SYNCED', return_record: returnRecord };
      await recordSyncLog({
        clientUuid,
        deviceId: 'WEB-BROWSER',
        clientType: 'WEB_PWA',
        endpoint: `/api/v1/paddy-purchases/${purchaseId}/return`,
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });

      return responseObj;
    })();

    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// 6. Stock Transfers Between Godowns
// ---------------------------------------------------------------------------
app.get('/api/v1/stock-transfers', authenticate, async (req: AuthedRequest, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const transfersRaw = await db
    .prepare(
      `SELECT st.*, wf.name as from_warehouse_name, wt.name as to_warehouse_name, i.name as item_name
       FROM stock_transfers st
       JOIN warehouses wf ON wf.id = st.from_warehouse_id
       JOIN warehouses wt ON wt.id = st.to_warehouse_id
       JOIN items i ON i.id = st.item_id
       ORDER BY st.id DESC`
    )
    .all() as Array<Record<string, unknown>>;
  const transfers = physicalOnly
    ? transfersRaw.map((t) => ({ ...t, bag_unit_rate: 0, total_cost: 0 }))
    : transfersRaw;
  res.json({ transfers });
});

app.post('/api/v1/stock-transfers', authenticate, requirePermission('stock.transfer'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    client_uuid?: string;
    device_id?: string;
    client_type?: 'WEB_PWA' | 'ANDROID_APP';
    from_warehouse_id: number;
    to_warehouse_id: number;
    item_id: number;
    qty_kg: number;
    bag_count?: number;
    unit_divisor?: number;
    costing_method?: CostingMethod;
    vehicle_or_driver?: string;
    notes?: string;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  if (body.from_warehouse_id === body.to_warehouse_id) {
    res.status(400).json({ error: 'Source and destination warehouses must be different' });
    return;
  }
  if (Number(body.qty_kg) <= 0) {
    res.status(400).json({ error: 'Transfer weight (kg) must be positive' });
    return;
  }
  if (body.bag_count !== undefined && Number(body.bag_count) > 0 && Number(body.qty_kg) <= Number(body.bag_count)) {
    res.status(400).json({ error: 'Transfer weight (kg) must exceed bag count' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM stock_transfers').get() as { nextId: number }).nextId;
      const transferNo = `TRF-2026-${String(seq).padStart(4, '0')}`;
      const qrUid = crypto.randomUUID();
      const costingMethod = body.costing_method || 'FIFO';

      // Compute Source Godown + Item Bag Unit Rate BEFORE stock consumption:
      // Bag Unit Rate = Total Stock Value / ((Total Stock Weight - Total Stock Bags) / Divisor)
      // Transfer Value = Bag Unit Rate * ((Going Weight - Going Bags) / Divisor)
      const activeLots = await db
        .prepare(
          `SELECT l.remaining_qty_kg, l.remaining_bags, l.unit_cost_per_kg, l.initial_qty_kg, l.source_type,
                  pp.bag_count as purchase_bag_count, i.bag_weight_kg
           FROM inventory_lots l
           JOIN items i ON i.id = l.item_id
           LEFT JOIN paddy_purchases pp ON l.source_type = 'PADDY_PURCHASE' AND pp.id = l.source_id
           WHERE l.item_id = ? AND l.warehouse_id = ? AND l.remaining_qty_kg > 0.0001`
        )
        .all(body.item_id, body.from_warehouse_id) as Array<{
        remaining_qty_kg: number;
        remaining_bags: number;
        unit_cost_per_kg: number;
        initial_qty_kg: number;
        source_type: string;
        purchase_bag_count: number | null;
        bag_weight_kg: number | null;
      }>;

      const itemMeta = await db.prepare('SELECT bag_weight_kg FROM items WHERE id = ?').get(body.item_id) as
        | { bag_weight_kg: number | null }
        | undefined;
      const defaultBagWt = Number(itemMeta?.bag_weight_kg || 60) > 0 ? Number(itemMeta?.bag_weight_kg || 60) : 60;

      const stockWeightKg = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);
      const stockBags = activeLots.reduce((s, l) => {
        if (l.remaining_bags > 0) return s + Number(l.remaining_bags);
        if (l.source_type === 'PADDY_PURCHASE' && (l.purchase_bag_count || 0) > 0 && l.initial_qty_kg > 0) {
          return s + Math.round((Number(l.remaining_qty_kg) * Number(l.purchase_bag_count)) / Number(l.initial_qty_kg));
        }
        return s + Math.round(Number(l.remaining_qty_kg) / (Number(l.bag_weight_kg || defaultBagWt) || defaultBagWt));
      }, 0);
      const stockValue = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0) * Number(l.unit_cost_per_kg || 0), 0);

      const divisor = Number(body.unit_divisor || 75.5) > 0 ? Number(body.unit_divisor || 75.5) : 75.5;
      const transferBags =
        body.bag_count !== undefined && Number(body.bag_count) >= 0
          ? Math.round(Number(body.bag_count))
          : Math.max(0, Math.round(Number(body.qty_kg) / defaultBagWt));

      const stockNetUnits = stockWeightKg > stockBags ? (stockWeightKg - stockBags) / divisor : 0;
      const bagUnitRate = stockNetUnits > 0 ? Number((stockValue / stockNetUnits).toFixed(4)) : 0;
      const goingNetUnits =
        transferBags > 0 && body.qty_kg > transferBags
          ? Number(((body.qty_kg - transferBags) / divisor).toFixed(4))
          : 0;
      const formulaCost = bagUnitRate > 0 && goingNetUnits > 0 ? Number((bagUnitRate * goingNetUnits).toFixed(2)) : 0;

      const info = await db
        .prepare(
          `INSERT INTO stock_transfers (
            client_uuid, transfer_no, from_warehouse_id, to_warehouse_id, item_id, qty_kg,
            bag_count, unit_divisor, net_units, bag_unit_rate,
            costing_method, total_cost, vehicle_or_driver, notes, qr_code_uid, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
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
          body.vehicle_or_driver || '',
          body.notes || '',
          qrUid,
          req.user!.id
        );

      const transferId = Number(info.lastInsertRowid);
      const consumed = await consumeWarehouseStock({
        itemId: body.item_id,
        warehouseId: body.from_warehouse_id,
        qtyKg: body.qty_kg,
        bagCount: transferBags > 0 ? transferBags : undefined,
        costingMethod,
        movementType: 'TRANSFER_OUT',
        referenceType: 'STOCK_TRANSFER',
        referenceId: transferId,
        employeeId: req.user!.id,
      });

      const effectiveTotalCost = formulaCost > 0 ? formulaCost : consumed.totalCost;
      const effectiveAvgCost = Number((effectiveTotalCost / body.qty_kg).toFixed(4));
      const effectiveBagRate =
        bagUnitRate > 0
          ? Number(bagUnitRate.toFixed(2))
          : goingNetUnits > 0
            ? Number((effectiveTotalCost / goingNetUnits).toFixed(2))
            : 0;

      await db.prepare('UPDATE stock_transfers SET total_cost = ?, bag_unit_rate = ? WHERE id = ?').run(
        effectiveTotalCost,
        effectiveBagRate,
        transferId
      );

      const originBatchIds = Array.from(
        new Set(consumed.consumedLots.map((c) => c.origin_batch_id).filter((id): id is number => id != null))
      );

      const lot = await createInventoryLot({
        prefix: 'LOT-TRF',
        itemId: body.item_id,
        warehouseId: body.to_warehouse_id,
        sourceType: 'TRANSFER_IN',
        sourceId: transferId,
        originBatchId: originBatchIds.length > 0 ? originBatchIds[0] : null,
        qtyKg: body.qty_kg,
        bagCount: transferBags > 0 ? transferBags : undefined,
        unitCostPerKg: effectiveAvgCost,
        movementType: 'TRANSFER_IN',
        employeeId: req.user!.id,
        qrUid,
      });

      await registerQrTag({
        qrCodeUid: qrUid,
        entityType: 'STOCK_TRANSFER',
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
          lot_code: lot.lotCode,
        },
      });

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'STOCK_TRANSFER_COMPLETED',
        entityType: 'STOCK_TRANSFER',
        entityId: transferNo,
        afterObj: {
          from: body.from_warehouse_id,
          to: body.to_warehouse_id,
          qty_kg: body.qty_kg,
          bag_count: transferBags,
          net_units: goingNetUnits,
          bag_unit_rate: effectiveBagRate,
          total_cost: effectiveTotalCost,
        },
        deviceType: body.client_type || 'WEB_PWA',
      });

      const created = await db
        .prepare(
          `SELECT st.*, wf.name as from_warehouse_name, wt.name as to_warehouse_name, i.name as item_name
           FROM stock_transfers st
           JOIN warehouses wf ON wf.id = st.from_warehouse_id
           JOIN warehouses wt ON wt.id = st.to_warehouse_id
           JOIN items i ON i.id = st.item_id
           WHERE st.id = ?`
        )
        .get(transferId) as Record<string, unknown>;

      const physicalOnly = isPhysicalOnlyUser(req.user);
      const responseObj = {
        status: 'SYNCED',
        transfer: physicalOnly ? { ...created, bag_unit_rate: 0, total_cost: 0 } : created,
      };
      await recordSyncLog({
        clientUuid,
        deviceId: body.device_id || 'WEB-BROWSER',
        clientType: body.client_type || 'WEB_PWA',
        endpoint: '/api/v1/stock-transfers',
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      await recordSyncLog({
        clientUuid,
        deviceId: body.device_id || 'WEB-BROWSER',
        clientType: body.client_type || 'WEB_PWA',
        endpoint: '/api/v1/stock-transfers',
        status: 'CONFLICT',
        conflictReason: err.message,
        employeeId: req.user!.id,
      });
      res.status(409).json({ error: err.message, code: 'INSUFFICIENT_STOCK' });
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// 7. Direct Paddy Sales (Without Processing)
// ---------------------------------------------------------------------------
app.get('/api/v1/paddy-sales', authenticate, async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const sales = await db
    .prepare(
      `SELECT ps.*, pt.name as customer_name, w.name as warehouse_name, i.name as item_name
       FROM paddy_sales ps
       JOIN parties pt ON pt.id = ps.customer_id
       JOIN warehouses w ON w.id = ps.warehouse_id
       JOIN items i ON i.id = ps.item_id
       ORDER BY ps.id DESC`
    )
    .all();
  res.json({ sales });
});

app.post('/api/v1/paddy-sales', authenticate, requirePermission('paddy.sale.create'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    client_uuid?: string;
    device_id?: string;
    client_type?: 'WEB_PWA' | 'ANDROID_APP';
    customer_id: number;
    warehouse_id: number;
    item_id: number;
    preferred_lot_id?: number;
    chatal_batch_id?: number;
    close_pending_lot?: boolean;
    challan_no?: string;
    bag_count?: number;
    jute_bag_count?: number;
    plastic_bag_count?: number;
    moisture_pct?: number;
    scale_weight_kg?: number;
    qty_kg: number;
    payment_weight_kg?: number;
    weight_loss_kg?: number;
    settlement_unit_kg?: number;
    settlement_rate?: number;
    rate_per_kg?: number;
    costing_method?: CostingMethod;
    paid_amount?: number;
    vehicle_no?: string;
    notes?: string;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM paddy_sales').get() as { nextId: number }).nextId;
      const saleNo = `PDS-2026-${String(seq).padStart(4, '0')}`;
      const qrUid = crypto.randomUUID();
      const costingMethod = body.costing_method || 'FIFO';

      const qtyKg = Number(body.qty_kg || 0);
      if (qtyKg <= 0) {
        throw new Error('Delivered paddy weight (kg) must be greater than zero');
      }

      const juteBags = Math.max(0, Math.round(Number(body.jute_bag_count || 0)));
      const plasticBags = Math.max(0, Math.round(Number(body.plastic_bag_count || 0)));
      const resolvedBagCount =
        body.bag_count && Number(body.bag_count) > 0
          ? Math.round(Number(body.bag_count))
          : juteBags + plasticBags;

      const scaleWeightKg = Number(body.scale_weight_kg ?? qtyKg);
      const paymentWeightKg = Number(body.payment_weight_kg ?? qtyKg);
      const weightLossKg = Math.max(0, Number(body.weight_loss_kg || 0));
      const settlementUnitKg = Number(body.settlement_unit_kg || 75.5);
      const settlementRate = Number(body.settlement_rate || 0);
      const moisturePct = Number(body.moisture_pct ?? 14);
      const netSettlementWeight = Number((paymentWeightKg - weightLossKg).toFixed(3));
      const hasFormula = settlementRate > 0 && settlementUnitKg > 0;

      if (hasFormula && netSettlementWeight <= 0) {
        throw new Error('Net settlement weight (Payment Weight - Weight Loss) must be greater than zero');
      }
      if (!hasFormula && Number(body.rate_per_kg || 0) <= 0) {
        throw new Error('Valid paddy settlement rate or rate per kg is required');
      }

      const totalAmount = hasFormula
        ? Number(((netSettlementWeight / settlementUnitKg) * settlementRate).toFixed(2))
        : Number((qtyKg * Number(body.rate_per_kg || 0)).toFixed(2));
      const effectiveRatePerKg = hasFormula
        ? Number((totalAmount / (paymentWeightKg > 0 ? paymentWeightKg : qtyKg)).toFixed(4))
        : Number(body.rate_per_kg || 0);
      const effectiveSettlementRate = hasFormula
        ? settlementRate
        : Number((effectiveRatePerKg * settlementUnitKg).toFixed(2));

      const paidAmt = Math.min(totalAmount, Math.max(0, Number(body.paid_amount || 0)));
      const payStatus = paidAmt <= 0 ? 'UNPAID' : paidAmt >= totalAmount ? 'PAID' : 'PARTIAL';

      const preferredLotId =
        body.preferred_lot_id && Number(body.preferred_lot_id) > 0 ? Number(body.preferred_lot_id) : undefined;

      const info = await db
        .prepare(
          `INSERT INTO paddy_sales (
            client_uuid, sale_no, customer_id, warehouse_id, item_id, source_lot_id,
            challan_no, bag_count, jute_bag_count, plastic_bag_count, extra_torn_bags, moisture_pct,
            scale_weight_kg, qty_kg, payment_weight_kg, weight_loss_kg,
            settlement_unit_kg, settlement_rate, rate_per_kg,
            total_amount, costing_method, cogs_amount, paid_amount, payment_status,
            vehicle_no, notes, qr_code_uid, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          clientUuid,
          saleNo,
          body.customer_id,
          body.warehouse_id,
          body.item_id,
          preferredLotId ?? null,
          body.challan_no || '',
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
          body.vehicle_no || '',
          body.notes || '',
          qrUid,
          req.user!.id
        );

      const saleId = Number(info.lastInsertRowid);

      let pendingLotRow:
        | { id: number; weight_pending: number; remaining_bags: number; source_type: string; source_id: number | null; chatal_batch_id: number | null }
        | undefined;
      if (preferredLotId) {
        pendingLotRow = (await db
          .prepare('SELECT id, weight_pending, remaining_bags, source_type, source_id, chatal_batch_id FROM inventory_lots WHERE id = ?')
          .get(preferredLotId)) as typeof pendingLotRow;
      }

      let consumedTotalCost = 0;
      let extraTornThisSale = 0;
      let resolvedSourceLotId = preferredLotId ?? null;
      let resolvedChatalBatchId =
        body.chatal_batch_id && Number(body.chatal_batch_id) > 0
          ? Number(body.chatal_batch_id)
          : pendingLotRow?.chatal_batch_id ??
            (pendingLotRow?.source_type === 'CHATAL_YARD' ? pendingLotRow.source_id : null) ??
            null;

      if (pendingLotRow && Number(pendingLotRow.weight_pending || 0) === 1) {
        const closeLot =
          body.close_pending_lot !== undefined
            ? Boolean(body.close_pending_lot)
            : resolvedBagCount >= Number(pendingLotRow.remaining_bags || 0);
        const pendingRes = await consumePendingWeightLot({
          lotId: pendingLotRow.id,
          qtyKg,
          bagCount: resolvedBagCount,
          closeLot,
          movementType: 'DIRECT_SALE_OUT',
          referenceType: 'PADDY_SALE',
          referenceId: saleId,
          employeeId: req.user!.id,
        });
        consumedTotalCost = pendingRes.totalCost;
        extraTornThisSale = pendingRes.extraTornThisExit;
        if (!resolvedChatalBatchId) {
          resolvedChatalBatchId = pendingRes.consumedLot.chatal_batch_id ?? null;
        }
        if (pendingLotRow.source_type === 'DRYING_OUTPUT' && pendingLotRow.source_id) {
          await db
            .prepare(
              `UPDATE paddy_drying_batches
               SET exit_settlement_unit_kg = ?, exit_settlement_rate = ?, exit_total_value = COALESCE(exit_total_value, 0) + ?
               WHERE id = ?`
            )
            .run(settlementUnitKg, effectiveSettlementRate, totalAmount, pendingLotRow.source_id);
        }
      } else {
        const consumed = await consumeWarehouseStock({
          itemId: body.item_id,
          warehouseId: body.warehouse_id,
          qtyKg,
          bagCount: resolvedBagCount > 0 ? resolvedBagCount : undefined,
          preferredLotId,
          costingMethod,
          movementType: 'DIRECT_SALE_OUT',
          referenceType: 'PADDY_SALE',
          referenceId: saleId,
          employeeId: req.user!.id,
        });
        consumedTotalCost = consumed.totalCost;
        if (!resolvedSourceLotId && consumed.consumedLots.length > 0) {
          resolvedSourceLotId = consumed.consumedLots[0].lot_id;
        }
        if (!resolvedChatalBatchId && consumed.consumedLots.length > 0) {
          const hit = consumed.consumedLots.find((c) => Number(c.chatal_batch_id || 0) > 0);
          if (hit?.chatal_batch_id) resolvedChatalBatchId = hit.chatal_batch_id;
        }
      }

      await db
        .prepare('UPDATE paddy_sales SET cogs_amount = ?, source_lot_id = ?, extra_torn_bags = ?, chatal_batch_id = ? WHERE id = ?')
        .run(consumedTotalCost, resolvedSourceLotId, extraTornThisSale, resolvedChatalBatchId, saleId);
      const dueAmt = totalAmount - paidAmt;
      await db.prepare('UPDATE parties SET current_balance = current_balance + ? WHERE id = ?').run(dueAmt, body.customer_id);

      const jeLines = [
        { accountCode: '1100', debit: dueAmt, credit: 0, partyId: body.customer_id },
        { accountCode: '4002', debit: 0, credit: totalAmount },
        { accountCode: '5001', debit: consumedTotalCost, credit: 0 },
        { accountCode: '1200', debit: 0, credit: consumedTotalCost },
      ];
      if (paidAmt > 0) jeLines.push({ accountCode: '1001', debit: paidAmt, credit: 0, partyId: body.customer_id });
      await postJournalEntry({
        description: `Direct Paddy Sale ${saleNo} (${qtyKg} kg, ${resolvedBagCount} bags)`,
        referenceType: 'PADDY_SALE',
        referenceId: saleId,
        employeeId: req.user!.id,
        lines: jeLines,
      });

      const cust = await db.prepare('SELECT name FROM parties WHERE id = ?').get(body.customer_id) as { name: string } | undefined;
      const itemInfo = await db.prepare('SELECT name FROM items WHERE id = ?').get(body.item_id) as { name: string } | undefined;
      const whInfo = await db.prepare('SELECT name FROM warehouses WHERE id = ?').get(body.warehouse_id) as { name: string } | undefined;
      await registerQrTag({
        qrCodeUid: qrUid,
        entityType: 'PADDY_SALE',
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
          vehicle_no: body.vehicle_no || '',
        },
      });

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'DIRECT_PADDY_SALE',
        entityType: 'PADDY_SALE',
        entityId: saleNo,
        afterObj: { qty_kg: qtyKg, bag_count: resolvedBagCount, extra_torn_bags: extraTornThisSale, total_amount: totalAmount, cogs: consumedTotalCost },
        deviceType: body.client_type || 'WEB_PWA',
      });

      const created = await db
        .prepare(
          `SELECT ps.*, pt.name as customer_name, w.name as warehouse_name, i.name as item_name
           FROM paddy_sales ps
           JOIN parties pt ON pt.id = ps.customer_id
           JOIN warehouses w ON w.id = ps.warehouse_id
           JOIN items i ON i.id = ps.item_id
           WHERE ps.id = ?`
        )
        .get(saleId);
      const responseObj = { status: 'SYNCED', sale: created };
      await recordSyncLog({
        clientUuid,
        deviceId: body.device_id || 'WEB-BROWSER',
        clientType: body.client_type || 'WEB_PWA',
        endpoint: '/api/v1/paddy-sales',
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      res.status(409).json({ error: err.message, code: 'INSUFFICIENT_STOCK' });
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// 8. Paddy Drying Management
// ---------------------------------------------------------------------------
app.get('/api/v1/drying-batches', authenticate, async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const batches = await db
    .prepare(
      `SELECT d.*, ws.name as source_warehouse_name, wd.name as dest_warehouse_name, i.name as item_name,
              pp.purchase_no, sp.name as supplier_name,
              l.id as lot_id, l.lot_code, COALESCE(l.remaining_bags, 0) as remaining_bags,
              COALESCE(l.pending_cost_total, 0) as pending_cost_total
       FROM paddy_drying_batches d
       JOIN warehouses ws ON ws.id = d.source_warehouse_id
       JOIN warehouses wd ON wd.id = d.dest_warehouse_id
       JOIN items i ON i.id = d.item_id
       LEFT JOIN paddy_purchases pp ON pp.id = d.purchase_id
       LEFT JOIN parties sp ON sp.id = pp.supplier_id
       LEFT JOIN inventory_lots l ON l.source_type = 'DRYING_OUTPUT' AND l.source_id = d.id
       ORDER BY d.id DESC`
    )
    .all();
  res.json({ drying_batches: batches });
});

app.post('/api/v1/drying-batches', authenticate, requirePermission('drying.manage'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    client_uuid?: string;
    device_id?: string;
    client_type?: 'WEB_PWA' | 'ANDROID_APP';
    source_warehouse_id: number;
    dest_warehouse_id: number;
    item_id: number;
    drying_method: 'SUN_YARD' | 'MECHANICAL_DRYER';
    purchase_id?: number;
    preferred_lot_id?: number;
    input_qty_kg: number;
    input_bags?: number;
    output_bags?: number;
    weight_pending?: boolean;
    initial_moisture_pct: number;
    final_moisture_pct: number;
    output_qty_kg: number;
    fuel_power_cost?: number;
    labor_cost?: number;
    notes?: string;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  const isWeightPending = Boolean(body.weight_pending);
  const inputQtyKg = Number(body.input_qty_kg || 0);
  const inputBags = Math.max(0, Math.round(Number(body.input_bags || 0)));
  const outputBags = Math.max(0, Math.round(Number(body.output_bags || 0)));
  const outputQtyKg = isWeightPending ? 0 : Number(body.output_qty_kg || 0);

  if (inputQtyKg <= 0) {
    res.status(400).json({ error: 'Wet input paddy weight (kg) must be positive' });
    return;
  }
  if (isWeightPending) {
    if (outputBags <= 0) {
      res.status(400).json({ error: 'Stored bag count is required when saving unweighed dried paddy to godown' });
      return;
    }
  } else if (outputQtyKg > inputQtyKg || outputQtyKg <= 0) {
    res.status(400).json({ error: 'Dried output weight must be positive and cannot exceed wet input weight' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM paddy_drying_batches').get() as { nextId: number }).nextId;
      const dryingNo = `DRY-2026-${String(seq).padStart(4, '0')}`;
      const qrUid = crypto.randomUUID();

      const moistureLossKg = isWeightPending ? 0 : Number((inputQtyKg - outputQtyKg).toFixed(3));
      const fuelCost = Number(body.fuel_power_cost || 0);
      const laborCost = Number(body.labor_cost || 0);
      const initialStatus = isWeightPending ? 'PENDING_WEIGHT' : 'COMPLETED';

      const info = await db
        .prepare(
          `INSERT INTO paddy_drying_batches (
            client_uuid, drying_no, source_warehouse_id, dest_warehouse_id, item_id, drying_method,
            input_qty_kg, input_bags, output_bags, dispatched_bags, extra_torn_bags, weight_pending,
            initial_moisture_pct, final_moisture_pct, output_qty_kg, moisture_loss_kg,
            fuel_power_cost, labor_cost, input_paddy_cost, output_unit_cost_per_kg,
            exit_settlement_unit_kg, exit_settlement_rate, exit_total_value, notes, status, qr_code_uid, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0, 0, 75.5, 0, 0, ?, ?, ?, ?)`
        )
        .run(
          clientUuid,
          dryingNo,
          body.source_warehouse_id,
          body.dest_warehouse_id,
          body.item_id,
          body.drying_method,
          inputQtyKg,
          inputBags,
          outputBags,
          isWeightPending ? 1 : 0,
          Number(body.initial_moisture_pct || 0),
          Number(body.final_moisture_pct || 0),
          outputQtyKg,
          moistureLossKg,
          fuelCost,
          laborCost,
          body.notes || '',
          initialStatus,
          qrUid,
          req.user!.id
        );

      let resolvedPreferredLotId = body.preferred_lot_id ? Number(body.preferred_lot_id) : undefined;
      if (!resolvedPreferredLotId && body.purchase_id) {
        const purLot = (await db
          .prepare(
            `SELECT id FROM inventory_lots
             WHERE source_type = 'PADDY_PURCHASE' AND source_id = ? AND warehouse_id = ? AND item_id = ? AND remaining_qty_kg > 0.0001
             ORDER BY id ASC LIMIT 1`
          )
          .get(Number(body.purchase_id), body.source_warehouse_id, body.item_id)) as { id: number } | undefined;
        if (purLot) resolvedPreferredLotId = purLot.id;
      }

      const dryingId = Number(info.lastInsertRowid);
      const consumed = await consumeWarehouseStock({
        itemId: body.item_id,
        warehouseId: body.source_warehouse_id,
        qtyKg: inputQtyKg,
        bagCount: inputBags > 0 ? inputBags : undefined,
        preferredLotId: resolvedPreferredLotId,
        costingMethod: 'FIFO',
        movementType: 'DRYING_OUT',
        referenceType: 'DRYING_BATCH',
        referenceId: dryingId,
        employeeId: req.user!.id,
      });

      const totalCapitalizedCost = Number((consumed.totalCost + fuelCost + laborCost).toFixed(2));
      const outputUnitCost = !isWeightPending && outputQtyKg > 0 ? Number((totalCapitalizedCost / outputQtyKg).toFixed(4)) : 0;
      const autoPurchaseLot = consumed.consumedLots.find((c) => c.source_type === 'PADDY_PURCHASE' && Number(c.source_id || 0) > 0);
      const resolvedPurchaseId = body.purchase_id ? Number(body.purchase_id) : autoPurchaseLot?.source_id ? Number(autoPurchaseLot.source_id) : null;

      await db
        .prepare('UPDATE paddy_drying_batches SET input_paddy_cost = ?, output_unit_cost_per_kg = ?, purchase_id = ? WHERE id = ?')
        .run(consumed.totalCost, outputUnitCost, resolvedPurchaseId, dryingId);

      await createInventoryLot({
        prefix: 'LOT-DRY',
        itemId: body.item_id,
        warehouseId: body.dest_warehouse_id,
        sourceType: 'DRYING_OUTPUT',
        sourceId: dryingId,
        qtyKg: outputQtyKg,
        bagCount: outputBags > 0 ? outputBags : undefined,
        unitCostPerKg: outputUnitCost,
        moisturePct: Number(body.final_moisture_pct || 0),
        weightPending: isWeightPending,
        pendingCostTotal: isWeightPending ? totalCapitalizedCost : 0,
        movementType: 'DRYING_IN',
        employeeId: req.user!.id,
        qrUid,
      });

      if (fuelCost + laborCost > 0) {
        await postJournalEntry({
          description: `Paddy Drying Overhead ${dryingNo} (${body.drying_method})`,
          referenceType: 'DRYING_BATCH',
          referenceId: dryingId,
          employeeId: req.user!.id,
          lines: [
            { accountCode: '1200', debit: fuelCost + laborCost, credit: 0 },
            { accountCode: '1001', debit: 0, credit: fuelCost + laborCost },
          ],
        });
      }

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: isWeightPending ? 'DRYING_STORED_UNWEIGHED' : 'DRYING_BATCH_COMPLETED',
        entityType: 'DRYING_BATCH',
        entityId: dryingNo,
        afterObj: {
          input_kg: inputQtyKg,
          output_kg: outputQtyKg,
          output_bags: outputBags,
          weight_pending: isWeightPending,
          loss_kg: moistureLossKg,
          output_unit_cost: outputUnitCost,
        },
        deviceType: body.client_type || 'WEB_PWA',
      });

      const created = await db
        .prepare(
          `SELECT d.*, ws.name as source_warehouse_name, wd.name as dest_warehouse_name, i.name as item_name,
                  pp.purchase_no, sp.name as supplier_name,
                  l.id as lot_id, l.lot_code, COALESCE(l.remaining_bags, 0) as remaining_bags,
                  COALESCE(l.pending_cost_total, 0) as pending_cost_total
           FROM paddy_drying_batches d
           JOIN warehouses ws ON ws.id = d.source_warehouse_id
           JOIN warehouses wd ON wd.id = d.dest_warehouse_id
           JOIN items i ON i.id = d.item_id
           LEFT JOIN paddy_purchases pp ON pp.id = d.purchase_id
           LEFT JOIN parties sp ON sp.id = pp.supplier_id
           LEFT JOIN inventory_lots l ON l.source_type = 'DRYING_OUTPUT' AND l.source_id = d.id
           WHERE d.id = ?`
        )
        .get(dryingId);
      const responseObj = { status: 'SYNCED', drying_batch: created };
      await recordSyncLog({
        clientUuid,
        deviceId: body.device_id || 'WEB-BROWSER',
        clientType: body.client_type || 'WEB_PWA',
        endpoint: '/api/v1/drying-batches',
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      res.status(409).json({ error: err.message, code: 'INSUFFICIENT_STOCK' });
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/v1/drying-batches/:id/weigh-out', authenticate, requirePermission('drying.manage'), async (req: AuthedRequest, res) => {
  const dryingId = Number(req.params.id);
  const body = req.body as {
    client_uuid?: string;
    dest_warehouse_id?: number;
    exit_bags?: number;
    bag_count?: number;
    scale_weight_kg?: number;
    qty_kg: number;
    weight_loss_kg?: number;
    settlement_unit_kg?: number;
    settlement_rate?: number;
    close_lot?: boolean;
    notes?: string;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  const qtyKg = Number(body.qty_kg || 0);
  const exitBags = Math.max(0, Math.round(Number(body.exit_bags ?? body.bag_count ?? 0)));
  if (qtyKg <= 0) {
    res.status(400).json({ error: 'Exit weight (kg) must be greater than zero' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const lot = (await db
        .prepare("SELECT * FROM inventory_lots WHERE source_type = 'DRYING_OUTPUT' AND source_id = ? LIMIT 1")
        .get(dryingId)) as
        | { id: number; lot_code: string; item_id: number; warehouse_id: number; weight_pending: number; remaining_bags: number; moisture_pct: number | null }
        | undefined;
      if (!lot) {
        throw new Error('Linked drying inventory lot not found');
      }
      if (Number(lot.weight_pending || 0) !== 1) {
        throw new Error(`Drying lot ${lot.lot_code} is already weighed/closed`);
      }

      const closeLot = body.close_lot !== undefined ? Boolean(body.close_lot) : exitBags >= Number(lot.remaining_bags || 0);
      const consumed = await consumePendingWeightLot({
        lotId: lot.id,
        qtyKg,
        bagCount: exitBags,
        closeLot,
        movementType: 'DRYING_WEIGH_OUT',
        referenceType: 'DRYING_BATCH',
        referenceId: dryingId,
        employeeId: req.user!.id,
      });

      const targetWhId = body.dest_warehouse_id && Number(body.dest_warehouse_id) > 0 ? Number(body.dest_warehouse_id) : lot.warehouse_id;
      const weighedLot = await createInventoryLot({
        prefix: 'LOT-WGH',
        itemId: lot.item_id,
        warehouseId: targetWhId,
        sourceType: 'DRYING_WEIGHED_IN',
        sourceId: dryingId,
        qtyKg,
        bagCount: exitBags,
        packSizeKg: exitBags > 0 ? Number((qtyKg / exitBags).toFixed(2)) : 60,
        unitCostPerKg: consumed.avgUnitCost,
        moisturePct: lot.moisture_pct,
        movementType: 'DRYING_WEIGH_IN',
        employeeId: req.user!.id,
      });

      const weightLossKg = Math.max(0, Number(body.weight_loss_kg || 0));
      const settlementUnitKg = Number(body.settlement_unit_kg || 75.5) > 0 ? Number(body.settlement_unit_kg || 75.5) : 75.5;
      const settlementRate = Math.max(0, Number(body.settlement_rate || 0));
      const netSettleWt = Math.max(0, qtyKg - weightLossKg);
      const exitTotalVal =
        settlementRate > 0 && netSettleWt > 0 ? Number(((netSettleWt / settlementUnitKg) * settlementRate).toFixed(2)) : 0;

      await db
        .prepare(
          `UPDATE paddy_drying_batches
           SET exit_settlement_unit_kg = ?, exit_settlement_rate = ?,
               exit_total_value = COALESCE(exit_total_value, 0) + ?,
               notes = CASE WHEN ? != '' THEN ? ELSE notes END
           WHERE id = ?`
        )
        .run(settlementUnitKg, settlementRate, exitTotalVal, body.notes || '', body.notes || '', dryingId);

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'DRYING_WEIGH_OUT_STOCKED',
        entityType: 'DRYING_BATCH',
        entityId: String(dryingId),
        afterObj: {
          weighed_lot_code: weighedLot.lotCode,
          qty_kg: qtyKg,
          exit_bags: exitBags,
          extra_torn_this_exit: consumed.extraTornThisExit,
          exit_settlement_rate: settlementRate,
          exit_total_value: exitTotalVal,
          closed: consumed.closed,
        },
      });

      const updated = await db
        .prepare(
          `SELECT d.*, ws.name as source_warehouse_name, wd.name as dest_warehouse_name, i.name as item_name,
                  pp.purchase_no, sp.name as supplier_name,
                  l.id as lot_id, l.lot_code, COALESCE(l.remaining_bags, 0) as remaining_bags,
                  COALESCE(l.pending_cost_total, 0) as pending_cost_total
           FROM paddy_drying_batches d
           JOIN warehouses ws ON ws.id = d.source_warehouse_id
           JOIN warehouses wd ON wd.id = d.dest_warehouse_id
           JOIN items i ON i.id = d.item_id
           LEFT JOIN paddy_purchases pp ON pp.id = d.purchase_id
           LEFT JOIN parties sp ON sp.id = pp.supplier_id
           LEFT JOIN inventory_lots l ON l.source_type = 'DRYING_OUTPUT' AND l.source_id = d.id
           WHERE d.id = ?`
        )
        .get(dryingId);

      return { status: 'SYNCED', drying_batch: updated, weighed_lot: weighedLot, consumed };
    })();
    res.status(200).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/v1/drying-batches/:id/close-pending', authenticate, requirePermission('drying.manage'), async (req: AuthedRequest, res) => {
  const dryingId = Number(req.params.id);
  try {
    const result = await db.transaction(async () => {
      const lot = (await db
        .prepare("SELECT * FROM inventory_lots WHERE source_type = 'DRYING_OUTPUT' AND source_id = ? LIMIT 1")
        .get(dryingId)) as
        | { id: number; lot_code: string; item_id: number; warehouse_id: number; weight_pending: number; pending_cost_total: number; dispatched_qty_kg: number }
        | undefined;
      if (!lot || Number(lot.weight_pending || 0) !== 1) {
        throw new Error('No open pending-weight drying lot found');
      }
      const remCost = Number(lot.pending_cost_total || 0);
      if (remCost > 0.01) {
        await postJournalEntry({
          description: `Drying Loss / Unweighed Lot Closure ${lot.lot_code}`,
          referenceType: 'DRYING_BATCH',
          referenceId: dryingId,
          employeeId: req.user!.id,
          lines: [
            { accountCode: '5200', debit: remCost, credit: 0 },
            { accountCode: '1200', debit: 0, credit: remCost },
          ],
        });
      }
      await db
        .prepare('UPDATE inventory_lots SET weight_pending = 0, remaining_bags = 0, pending_cost_total = 0, version = version + 1 WHERE id = ?')
        .run(lot.id);
      await db
        .prepare("UPDATE paddy_drying_batches SET weight_pending = 0, status = 'COMPLETED' WHERE id = ?")
        .run(dryingId);
      return { status: 'CLOSED', drying_id: dryingId };
    })();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// 8B. Chatal & Khamal Management (Yard Pour -> Multi-Godown Split -> Drying/Khamal -> Crushing/Sale -> P&L)
// ---------------------------------------------------------------------------
async function getEnrichedChatalBatch(chatalId: number): Promise<Record<string, unknown> | null> {
  const b = (await db
    .prepare(
      `SELECT c.*, w.name as chatal_warehouse_name, i.name as paddy_item_name, emp.full_name as created_by_name
       FROM chatal_batches c
       JOIN warehouses w ON w.id = c.chatal_warehouse_id
       JOIN items i ON i.id = c.paddy_item_id
       LEFT JOIN employees emp ON emp.id = c.created_by
       WHERE c.id = ?`
    )
    .get(chatalId)) as Record<string, unknown> | undefined;
  if (!b) return null;

  const inputs = await db
    .prepare(
      `SELECT ci.*, w.name as source_warehouse_name, i.name as item_name, emp.full_name as created_by_name
       FROM chatal_batch_inputs ci
       JOIN warehouses w ON w.id = ci.source_warehouse_id
       JOIN items i ON i.id = ci.paddy_item_id
       LEFT JOIN employees emp ON emp.id = ci.created_by
       WHERE ci.chatal_batch_id = ?
       ORDER BY ci.id ASC`
    )
    .all(chatalId);

  const expensesRaw = (await db
    .prepare(
      `SELECT ce.*, emp.full_name as created_by_name
       FROM chatal_batch_expenses ce
       LEFT JOIN employees emp ON emp.id = ce.created_by
       WHERE ce.chatal_batch_id = ?
       ORDER BY ce.id DESC`
    )
    .all(chatalId)) as Array<Record<string, unknown>>;

  const getExpPays = db.prepare(
    `SELECT cep.*, a.name as account_name, emp.full_name as paid_by_name
     FROM chatal_expense_payments cep
     JOIN accounts a ON a.id = cep.account_id
     LEFT JOIN employees emp ON emp.id = cep.paid_by
     WHERE cep.expense_id = ?
     ORDER BY cep.id DESC`
  );
  const expenses = await Promise.all(
    expensesRaw.map(async (exp) => ({
      ...exp,
      payment_logs: await getExpPays.all(exp.id as number),
    }))
  );

  const dispatches = await db
    .prepare(
      `SELECT cd.*, wf.name as from_warehouse_name, wt.name as dest_warehouse_name, i.name as item_name,
              l.lot_code, l.remaining_bags as lot_remaining_bags, l.remaining_qty_kg as lot_remaining_qty_kg,
              l.weight_pending as lot_weight_pending, l.pending_cost_total as lot_pending_cost_total,
              l.unit_cost_per_kg as lot_unit_cost_per_kg, emp.full_name as created_by_name
       FROM chatal_batch_dispatches cd
       JOIN warehouses wf ON wf.id = cd.from_warehouse_id
       JOIN warehouses wt ON wt.id = cd.dest_warehouse_id
       JOIN items i ON i.id = cd.paddy_item_id
       LEFT JOIN inventory_lots l ON l.id = cd.dest_lot_id
       LEFT JOIN employees emp ON emp.id = cd.created_by
       WHERE cd.chatal_batch_id = ?
       ORDER BY cd.round_no ASC, cd.id ASC`
    )
    .all(chatalId);

  const linkedLots = (await db
    .prepare(
      `SELECT l.*, w.name as warehouse_name, w.warehouse_type, i.name as item_name
       FROM inventory_lots l
       JOIN warehouses w ON w.id = l.warehouse_id
       JOIN items i ON i.id = l.item_id
       WHERE l.chatal_batch_id = ?
          OR (l.source_type = 'CHATAL_YARD' AND l.source_id = ?)
       ORDER BY CASE WHEN l.source_type = 'CHATAL_YARD' THEN 0 ELSE 1 END, l.id ASC`
    )
    .all(chatalId, chatalId)) as Array<Record<string, unknown>>;

  const linkedSales = (await db
    .prepare(
      `SELECT ps.*, pt.name as customer_name, w.name as warehouse_name, i.name as item_name
       FROM paddy_sales ps
       JOIN parties pt ON pt.id = ps.customer_id
       JOIN warehouses w ON w.id = ps.warehouse_id
       JOIN items i ON i.id = ps.item_id
       WHERE ps.chatal_batch_id = ?
       ORDER BY ps.id DESC`
    )
    .all(chatalId)) as Array<Record<string, unknown>>;

  const linkedCrushingRaw = (await db
    .prepare(
      `SELECT pb.*, w.name as source_warehouse_name, i.name as paddy_item_name,
              pcs.raw_paddy_cost, pcs.gross_batch_cost, pcs.labor_cost as mill_labor_cost,
              pcs.electricity_cost as mill_elec_cost, pcs.fuel_boiler_cost as mill_fuel_cost,
              pcs.machinery_overhead_cost as mill_mach_cost, pcs.packaging_cost as mill_pack_cost
       FROM production_batches pb
       JOIN warehouses w ON w.id = pb.source_warehouse_id
       JOIN items i ON i.id = pb.paddy_item_id
       LEFT JOIN production_cost_sheets pcs ON pcs.batch_id = pb.id
       WHERE pb.chatal_batch_id = ?
       ORDER BY pb.id DESC`
    )
    .all(chatalId)) as Array<Record<string, unknown>>;

  const linkedCrushing: Array<Record<string, unknown>> = await Promise.all(
    linkedCrushingRaw.map(async (cb): Promise<Record<string, unknown>> => {
      const bid = Number(cb.id);
      const salesAgg = (await db
        .prepare(
          `SELECT COALESCE(SUM(sale_amount), 0) as rev, COALESCE(SUM(cost_amount), 0) as cogs
           FROM sales_invoice_lot_allocations WHERE batch_id = ?`
        )
        .get(bid)) as { rev: number; cogs: number };
      const stockAgg = (await db
        .prepare(
          `SELECT COALESCE(SUM(remaining_qty_kg * unit_cost_per_kg), 0) as unsold_val,
                  COALESCE(SUM(remaining_qty_kg), 0) as unsold_kg
           FROM inventory_lots
           WHERE (origin_batch_id = ? OR (source_type = 'PRODUCTION_OUTPUT' AND source_id = ?)) AND remaining_qty_kg > 0.0001`
        )
        .get(bid, bid)) as { unsold_val: number; unsold_kg: number };
      const extraOverhead =
        Number(cb.mill_labor_cost || 0) +
        Number(cb.mill_elec_cost || 0) +
        Number(cb.mill_fuel_cost || 0) +
        Number(cb.mill_mach_cost || 0) +
        Number(cb.mill_pack_cost || 0);
      return {
        ...cb,
        realized_milled_revenue: Number(Number(salesAgg.rev || 0).toFixed(2)),
        unsold_milled_value: Number(Number(stockAgg.unsold_val || 0).toFixed(2)),
        unsold_milled_kg: Number(Number(stockAgg.unsold_kg || 0).toFixed(2)),
        extra_milling_overhead: Number(extraOverhead.toFixed(2)),
      };
    })
  );

  const resolveLotVal = (l: Record<string, unknown>) =>
    Number(l.weight_pending || 0) === 1
      ? Number(l.pending_cost_total || 0)
      : Number(l.remaining_qty_kg || 0) * Number(l.unit_cost_per_kg || 0);

  let chatalRemBags = 0;
  let chatalRemKg = 0;
  let chatalRemVal = 0;
  let godownRemBags = 0;
  let godownRemKg = 0;
  let godownRemVal = 0;

  for (const l of linkedLots) {
    const val = resolveLotVal(l);
    const kg = Number(l.remaining_qty_kg || 0);
    const bags = Number(l.remaining_bags || 0);
    if (kg <= 0.0001 && Number(l.weight_pending || 0) !== 1) continue;
    if (l.source_type === 'CHATAL_YARD') {
      chatalRemBags += bags;
      chatalRemKg += kg;
      chatalRemVal += val;
    } else {
      godownRemBags += bags;
      godownRemKg += kg;
      godownRemVal += val;
    }
  }

  const totalPaddyCost = Number(Number(b.total_paddy_cost || 0).toFixed(2));
  const dryingCost = Number(Number(b.drying_cost || 0).toFixed(2));
  const khamalCost = Number(Number(b.khamal_cost || 0).toFixed(2));
  const otherCost = Number(Number(b.other_cost || 0).toFixed(2));
  const totalExpenses = Number((dryingCost + khamalCost + otherCost).toFixed(2));
  const totalExpensePaid = expensesRaw.reduce((s, e) => s + Number(e.paid_amount ?? e.total_amount ?? 0), 0);
  const unpaidExpenseDue = expensesRaw.reduce(
    (s, e) => s + Math.max(0, Number(e.total_amount || 0) - Number(e.paid_amount ?? e.total_amount ?? 0)),
    0
  );
  const totalCost = Number((totalPaddyCost + totalExpenses).toFixed(2));

  const directSoldBags = linkedSales.reduce((s, row) => s + Number(row.bag_count || 0), 0);
  const directSoldKg = linkedSales.reduce((s, row) => s + Number(row.qty_kg || 0), 0);
  const directSaleRevenue = linkedSales.reduce((s, row) => s + Number(row.total_amount || 0), 0);
  const directSaleCogs = linkedSales.reduce((s, row) => s + Number(row.cogs_amount || 0), 0);

  const crushingInputBags = linkedCrushing.reduce((s, row) => s + Number(row.input_bag_count || 0), 0);
  const crushingInputKg = linkedCrushing.reduce((s, row) => s + Number(row.input_paddy_qty_kg || 0), 0);
  const crushingPaddyCost = linkedCrushing.reduce((s, row) => s + Number(row.raw_paddy_cost || row.paddy_formula_cost || 0), 0);
  const crushingExtraOverhead = linkedCrushing.reduce((s, row) => s + Number(row.extra_milling_overhead || 0), 0);
  const crushingMilledRevenue = linkedCrushing.reduce((s, row) => s + Number(row.realized_milled_revenue || 0), 0);
  const crushingUnsoldValue = linkedCrushing.reduce((s, row) => s + Number(row.unsold_milled_value || 0), 0);
  const crushingWipValue = linkedCrushing.reduce(
    (s, row) =>
      row.status === 'IN_PROGRESS'
        ? s + Number(row.raw_paddy_cost || row.paddy_formula_cost || 0) + Number(row.extra_milling_overhead || 0)
        : s,
    0
  );
  const crushingNetContribution = Number(
    (crushingMilledRevenue + crushingUnsoldValue + crushingWipValue - crushingExtraOverhead).toFixed(2)
  );

  const remainingPaddyValue = Number((chatalRemVal + godownRemVal).toFixed(2));
  const totalRealizedRevenue = Number((directSaleRevenue + crushingMilledRevenue).toFixed(2));
  const totalProjectedValue = Number((directSaleRevenue + crushingNetContribution + remainingPaddyValue).toFixed(2));
  const netProfitLoss = Number((totalProjectedValue - totalCost).toFixed(2));
  const realizedProfitLoss = Number((directSaleRevenue + crushingMilledRevenue - crushingExtraOverhead - totalCost).toFixed(2));

  return {
    ...b,
    inputs,
    expenses,
    dispatches,
    linked_lots: linkedLots,
    linked_sales: linkedSales,
    linked_crushing: linkedCrushing,
    pnl: {
      total_intake_bags: Number(b.total_intake_bags || 0),
      total_intake_kg: Number(Number(b.total_intake_kg || 0).toFixed(2)),
      total_paddy_cost: totalPaddyCost,
      drying_cost: dryingCost,
      khamal_cost: khamalCost,
      other_cost: otherCost,
      total_expenses: totalExpenses,
      total_expense_paid: Number(totalExpensePaid.toFixed(2)),
      unpaid_expense_due: Number(unpaidExpenseDue.toFixed(2)),
      total_cost: totalCost,
      chatal_remaining_bags: chatalRemBags,
      chatal_remaining_kg: Number(chatalRemKg.toFixed(2)),
      chatal_remaining_value: Number(chatalRemVal.toFixed(2)),
      godown_remaining_bags: godownRemBags,
      godown_remaining_kg: Number(godownRemKg.toFixed(2)),
      godown_remaining_value: Number(godownRemVal.toFixed(2)),
      remaining_paddy_value: remainingPaddyValue,
      direct_sales_count: linkedSales.length,
      direct_sold_bags: directSoldBags,
      direct_sold_kg: Number(directSoldKg.toFixed(2)),
      direct_sale_revenue: Number(directSaleRevenue.toFixed(2)),
      direct_sale_cogs: Number(directSaleCogs.toFixed(2)),
      crushing_batch_count: linkedCrushing.length,
      crushing_input_bags: crushingInputBags,
      crushing_input_kg: Number(crushingInputKg.toFixed(2)),
      crushing_paddy_cost: Number(crushingPaddyCost.toFixed(2)),
      crushing_extra_overhead: Number(crushingExtraOverhead.toFixed(2)),
      crushing_milled_revenue: Number(crushingMilledRevenue.toFixed(2)),
      crushing_unsold_value: Number(crushingUnsoldValue.toFixed(2)),
      crushing_net_contribution: crushingNetContribution,
      total_realized_revenue: totalRealizedRevenue,
      total_projected_value: totalProjectedValue,
      net_profit_loss: netProfitLoss,
      realized_profit_loss: realizedProfitLoss,
    },
  };
}

async function capitalizeExpenseOntoChatalLots(chatalId: number, addAmount: number): Promise<boolean> {
  if (addAmount <= 0) return false;
  const activeLots = (await db
    .prepare(
      `SELECT id, source_type, remaining_qty_kg, unit_cost_per_kg, weight_pending, pending_cost_total
       FROM inventory_lots
       WHERE (chatal_batch_id = ? OR (source_type = 'CHATAL_YARD' AND source_id = ?))
         AND (remaining_qty_kg > 0.0001 OR COALESCE(weight_pending, 0) = 1)
       ORDER BY CASE WHEN source_type = 'CHATAL_YARD' THEN 0 ELSE 1 END, id ASC`
    )
    .all(chatalId, chatalId)) as Array<{
    id: number;
    source_type: string;
    remaining_qty_kg: number;
    unit_cost_per_kg: number;
    weight_pending: number;
    pending_cost_total: number;
  }>;

  if (activeLots.length === 0) return false;

  const chatalHoldingLots = activeLots.filter((l) => l.source_type === 'CHATAL_YARD');
  const targetLots = chatalHoldingLots.length > 0 ? chatalHoldingLots : activeLots;
  const totalBaseValue = targetLots.reduce((s, l) => {
    const val = Number(l.weight_pending || 0) === 1
      ? Number(l.pending_cost_total || 0)
      : Number(l.remaining_qty_kg || 0) * Number(l.unit_cost_per_kg || 0);
    return s + val;
  }, 0);

  let remainingAdd = Number(addAmount.toFixed(2));
  for (let idx = 0; idx < targetLots.length; idx++) {
    const lot = targetLots[idx];
    const lotVal =
      Number(lot.weight_pending || 0) === 1
        ? Number(lot.pending_cost_total || 0)
        : Number(lot.remaining_qty_kg || 0) * Number(lot.unit_cost_per_kg || 0);
    const shareAmt =
      idx === targetLots.length - 1
        ? remainingAdd
        : totalBaseValue > 0
        ? Number(((addAmount * lotVal) / totalBaseValue).toFixed(2))
        : Number((addAmount / targetLots.length).toFixed(2));
    remainingAdd = Number((remainingAdd - shareAmt).toFixed(2));

    if (Number(lot.weight_pending || 0) === 1) {
      await db
        .prepare('UPDATE inventory_lots SET pending_cost_total = pending_cost_total + ?, version = version + 1 WHERE id = ?')
        .run(shareAmt, lot.id);
    } else if (Number(lot.remaining_qty_kg || 0) > 0.0001) {
      const nextVal = Number((lotVal + shareAmt).toFixed(4));
      const nextUnit = Number((nextVal / Number(lot.remaining_qty_kg)).toFixed(6));
      await db
        .prepare('UPDATE inventory_lots SET unit_cost_per_kg = ?, version = version + 1 WHERE id = ?')
        .run(nextUnit, lot.id);
    }
  }
  return true;
}

app.get('/api/v1/chatal-batches', authenticate, async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const ids = (await db.prepare('SELECT id FROM chatal_batches ORDER BY id DESC').all()) as Array<{ id: number }>;
  const batches = (await Promise.all(ids.map((r) => getEnrichedChatalBatch(r.id)))).filter(
    (x): x is Record<string, unknown> => x !== null
  );
  res.json({ chatal_batches: batches });
});

app.post('/api/v1/chatal-batches', authenticate, requirePermission('drying.manage'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    client_uuid?: string;
    title?: string;
    chatal_warehouse_id: number;
    paddy_item_id?: number;
    drying_cost?: number;
    khamal_cost?: number;
    account_id?: number;
    payment_timing?: 'PAID' | 'UNPAID' | 'PARTIAL';
    paid_now?: number;
    notes?: string;
    inputs: Array<{
      source_warehouse_id: number;
      paddy_item_id: number;
      purchase_id?: number;
      preferred_lot_id?: number;
      bag_count: number;
      qty_kg: number;
      unit_divisor?: number;
      costing_method?: CostingMethod;
      notes?: string;
    }>;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  const inputRows = Array.isArray(body.inputs) ? body.inputs.filter((r) => Number(r.qty_kg || 0) > 0) : [];
  if (!body.chatal_warehouse_id || inputRows.length === 0) {
    res.status(400).json({ error: 'Chatal yard warehouse and at least one paddy intake line are required' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM chatal_batches').get() as { nextId: number }).nextId;
      const chatalNo = `CHT-2026-${String(seq).padStart(4, '0')}`;
      const qrUid = crypto.randomUUID();
      const primaryItemId = Number(body.paddy_item_id || inputRows[0].paddy_item_id);
      const initDryCost = Math.max(0, Number(body.drying_cost || 0));
      const initKhamalCost = Math.max(0, Number(body.khamal_cost || 0));

      const info = await db
        .prepare(
          `INSERT INTO chatal_batches (
            client_uuid, chatal_no, title, chatal_warehouse_id, paddy_item_id, status,
            total_intake_bags, total_intake_kg, total_paddy_cost, drying_cost, khamal_cost, other_cost,
            moisture_loss_kg, notes, qr_code_uid, created_by
          ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', 0, 0, 0, 0, 0, 0, 0, ?, ?, ?)`
        )
        .run(
          clientUuid,
          chatalNo,
          String(body.title || '').trim() || chatalNo,
          body.chatal_warehouse_id,
          primaryItemId,
          String(body.notes || '').trim(),
          qrUid,
          req.user!.id
        );
      const chatalId = Number(info.lastInsertRowid);

      let totalBags = 0;
      let totalKg = 0;
      let totalPaddyCost = 0;

      for (const inp of inputRows) {
        const qtyKg = Number(inp.qty_kg || 0);
        const bags = Math.max(0, Math.round(Number(inp.bag_count || 0)));
        const divisor = Number(inp.unit_divisor || 75.5) > 0 ? Number(inp.unit_divisor || 75.5) : 75.5;
        const costingMethod = inp.costing_method || 'FIFO';

        const consumed = await consumeWarehouseStock({
          itemId: Number(inp.paddy_item_id || primaryItemId),
          warehouseId: inp.source_warehouse_id,
          qtyKg,
          bagCount: bags > 0 ? bags : undefined,
          preferredLotId: inp.preferred_lot_id,
          costingMethod,
          movementType: 'CHATAL_INTAKE_OUT',
          referenceType: 'CHATAL_BATCH',
          referenceId: chatalId,
          employeeId: req.user!.id,
        });

        const netUnits = qtyKg > bags ? Number(((qtyKg - bags) / divisor).toFixed(4)) : 0;
        const bagRate = netUnits > 0 ? Number((consumed.totalCost / netUnits).toFixed(2)) : 0;

        const autoChatalPur = consumed.consumedLots.find((c) => c.source_type === 'PADDY_PURCHASE' && Number(c.source_id || 0) > 0);
        const resolvedChatalPurchaseId = inp.purchase_id ?? (autoChatalPur?.source_id ? Number(autoChatalPur.source_id) : null);

        await db
          .prepare(
            `INSERT INTO chatal_batch_inputs (
              chatal_batch_id, source_warehouse_id, paddy_item_id, purchase_id, lot_id,
              bag_count, qty_kg, unit_divisor, net_units, bag_unit_rate, paddy_cost, notes, created_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            chatalId,
            inp.source_warehouse_id,
            Number(inp.paddy_item_id || primaryItemId),
            resolvedChatalPurchaseId,
            consumed.consumedLots[0]?.lot_id ?? null,
            bags,
            qtyKg,
            divisor,
            netUnits,
            bagRate,
            consumed.totalCost,
            String(inp.notes || '').trim(),
            req.user!.id
          );

        totalBags += bags;
        totalKg += qtyKg;
        totalPaddyCost += consumed.totalCost;
      }

      const avgUnitCost = totalKg > 0 ? Number((totalPaddyCost / totalKg).toFixed(6)) : 0;
      await createInventoryLot({
        prefix: 'LOT-CHT',
        itemId: primaryItemId,
        warehouseId: body.chatal_warehouse_id,
        sourceType: 'CHATAL_YARD',
        sourceId: chatalId,
        chatalBatchId: chatalId,
        qtyKg: Number(totalKg.toFixed(3)),
        bagCount: totalBags,
        unitCostPerKg: avgUnitCost,
        movementType: 'CHATAL_INTAKE_IN',
        employeeId: req.user!.id,
      });

      await db
        .prepare('UPDATE chatal_batches SET total_intake_bags = ?, total_intake_kg = ?, total_paddy_cost = ? WHERE id = ?')
        .run(totalBags, Number(totalKg.toFixed(3)), Number(totalPaddyCost.toFixed(2)), chatalId);

      // Optional initial Drying & Khamal expenses
      const initExpEntries: Array<{ type: 'DRYING' | 'KHAMAL'; amount: number }> = [];
      if (initDryCost > 0) initExpEntries.push({ type: 'DRYING', amount: initDryCost });
      if (initKhamalCost > 0) initExpEntries.push({ type: 'KHAMAL', amount: initKhamalCost });

      if (initExpEntries.length > 0) {
        await db.prepare(
          "INSERT OR IGNORE INTO accounts (account_code, name, account_type, balance, is_system) VALUES ('2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0, 1)"
        ).run();
        const totalInitExp = initDryCost + initKhamalCost;
        const timing = body.payment_timing === 'UNPAID' || body.payment_timing === 'PARTIAL' ? body.payment_timing : 'PAID';
        const acc = body.account_id
          ? (await db.prepare('SELECT id, account_code FROM accounts WHERE id = ?').get(body.account_id) as { id: number; account_code: string } | undefined)
          : (await db.prepare("SELECT id, account_code FROM accounts WHERE account_code = '1001' LIMIT 1").get() as { id: number; account_code: string } | undefined);

        let remainingPaidPool = timing === 'UNPAID' ? 0 : timing === 'PARTIAL' ? Math.min(totalInitExp, Math.max(0, Number(body.paid_now || 0))) : totalInitExp;

        for (const itemExp of initExpEntries) {
          const paidPart = Number(Math.min(itemExp.amount, remainingPaidPool).toFixed(2));
          remainingPaidPool = Number(Math.max(0, remainingPaidPool - paidPart).toFixed(2));
          const duePart = Number((itemExp.amount - paidPart).toFixed(2));
          const pStatus = paidPart <= 0 ? 'UNPAID' : duePart <= 0.01 ? 'PAID' : 'PARTIAL';

          const expIns = await db
            .prepare(
              `INSERT INTO chatal_batch_expenses (
                chatal_batch_id, expense_type, vendor_name, total_amount, payment_status, paid_amount, account_id, paid_at, notes, created_by
              ) VALUES (?, ?, '', ?, ?, ?, ?, ${paidPart > 0 ? "datetime('now')" : 'NULL'}, ?, ?)`
            )
            .run(chatalId, itemExp.type, itemExp.amount, pStatus, paidPart, paidPart > 0 && acc ? acc.id : null, itemExp.type === 'DRYING' ? 'প্রাথমিক ধান শুকানো খরচ' : 'প্রাথমিক খামাল খরচ', req.user!.id);

          if (paidPart > 0 && acc) {
            const pSeq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM chatal_expense_payments').get() as { nextId: number }).nextId;
            await db.prepare(
              `INSERT INTO chatal_expense_payments (receipt_no, expense_id, chatal_batch_id, account_id, amount, payment_mode, notes, paid_by)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(`CEXP-2026-${String(pSeq).padStart(4, '0')}`, Number(expIns.lastInsertRowid), chatalId, acc.id, paidPart, acc.account_code === '1002' ? 'BANK_TRANSFER' : 'CASH', 'প্রাথমিক চাতাল খরচ', req.user!.id);
          }

          await capitalizeExpenseOntoChatalLots(chatalId, itemExp.amount);
          const jeLines: Array<{ accountCode: string; debit: number; credit: number }> = [{ accountCode: '1200', debit: itemExp.amount, credit: 0 }];
          if (paidPart > 0 && acc) jeLines.push({ accountCode: acc.account_code, debit: 0, credit: paidPart });
          if (duePart > 0.005) jeLines.push({ accountCode: '2002', debit: 0, credit: duePart });
          await postJournalEntry({
            description: `Chatal ${itemExp.type} Expense Capitalized - ${chatalNo}`,
            referenceType: 'CHATAL_BATCH',
            referenceId: chatalId,
            employeeId: req.user!.id,
            lines: jeLines,
          });
        }

        await db
          .prepare('UPDATE chatal_batches SET drying_cost = ?, khamal_cost = ? WHERE id = ?')
          .run(initDryCost, initKhamalCost, chatalId);
      }

      await registerQrTag({
        qrCodeUid: qrUid,
        entityType: 'CHATAL_BATCH',
        entityId: chatalId,
        entityCode: chatalNo,
        payload: { chatal_no: chatalNo, bags: totalBags, qty_kg: totalKg, total_paddy_cost: totalPaddyCost },
      });

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'CHATAL_BATCH_CREATED',
        entityType: 'CHATAL_BATCH',
        entityId: chatalNo,
        afterObj: { bags: totalBags, qty_kg: totalKg, total_paddy_cost: totalPaddyCost },
      });

      const responseObj = { status: 'SYNCED', chatal_batch: await getEnrichedChatalBatch(chatalId) };
      await recordSyncLog({
        clientUuid,
        deviceId: 'WEB-BROWSER',
        clientType: 'WEB_PWA',
        endpoint: '/api/v1/chatal-batches',
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      res.status(409).json({ error: err.message, code: 'INSUFFICIENT_STOCK' });
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

// Add additional paddy later onto an active Chatal batch
app.post('/api/v1/chatal-batches/:id/inputs', authenticate, requirePermission('drying.manage'), async (req: AuthedRequest, res) => {
  const chatalId = Number(req.params.id);
  const body = req.body as {
    source_warehouse_id: number;
    paddy_item_id?: number;
    preferred_lot_id?: number;
    bag_count: number;
    qty_kg: number;
    unit_divisor?: number;
    costing_method?: CostingMethod;
    notes?: string;
  };

  try {
    const result = await db.transaction(async () => {
      const chatal = (await db.prepare('SELECT * FROM chatal_batches WHERE id = ?').get(chatalId)) as
        | { id: number; chatal_no: string; chatal_warehouse_id: number; paddy_item_id: number; status: string }
        | undefined;
      if (!chatal) throw new Error('Chatal batch not found');
      if (chatal.status !== 'ACTIVE') throw new Error('Chatal batch is already closed');

      const qtyKg = Number(body.qty_kg || 0);
      const bags = Math.max(0, Math.round(Number(body.bag_count || 0)));
      if (qtyKg <= 0) throw new Error('Paddy weight (kg) must be greater than zero');

      const itemId = Number(body.paddy_item_id || chatal.paddy_item_id);
      const divisor = Number(body.unit_divisor || 75.5) > 0 ? Number(body.unit_divisor || 75.5) : 75.5;
      const costingMethod = body.costing_method || 'FIFO';

      const consumed = await consumeWarehouseStock({
        itemId,
        warehouseId: body.source_warehouse_id,
        qtyKg,
        bagCount: bags > 0 ? bags : undefined,
        preferredLotId: body.preferred_lot_id,
        costingMethod,
        movementType: 'CHATAL_INTAKE_OUT',
        referenceType: 'CHATAL_BATCH',
        referenceId: chatalId,
        employeeId: req.user!.id,
      });

      const netUnits = qtyKg > bags ? Number(((qtyKg - bags) / divisor).toFixed(4)) : 0;
      const bagRate = netUnits > 0 ? Number((consumed.totalCost / netUnits).toFixed(2)) : 0;

      const autoExtraPur = consumed.consumedLots.find((c) => c.source_type === 'PADDY_PURCHASE' && Number(c.source_id || 0) > 0);
      const resolvedExtraPurchaseId = autoExtraPur?.source_id ? Number(autoExtraPur.source_id) : null;

      await db
        .prepare(
          `INSERT INTO chatal_batch_inputs (
            chatal_batch_id, source_warehouse_id, paddy_item_id, purchase_id, lot_id,
            bag_count, qty_kg, unit_divisor, net_units, bag_unit_rate, paddy_cost, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          chatalId,
          body.source_warehouse_id,
          itemId,
          resolvedExtraPurchaseId,
          consumed.consumedLots[0]?.lot_id ?? null,
          bags,
          qtyKg,
          divisor,
          netUnits,
          bagRate,
          consumed.totalCost,
          String(body.notes || '').trim(),
          req.user!.id
        );

      const holdingLot = (await db
        .prepare(
          `SELECT id, remaining_qty_kg, remaining_bags, unit_cost_per_kg
           FROM inventory_lots
           WHERE source_type = 'CHATAL_YARD' AND source_id = ? AND warehouse_id = ? AND item_id = ?
           ORDER BY id DESC LIMIT 1`
        )
        .get(chatalId, chatal.chatal_warehouse_id, itemId)) as
        | { id: number; remaining_qty_kg: number; remaining_bags: number; unit_cost_per_kg: number }
        | undefined;

      if (holdingLot) {
        const oldVal = Number(holdingLot.remaining_qty_kg || 0) * Number(holdingLot.unit_cost_per_kg || 0);
        const newKg = Number((Number(holdingLot.remaining_qty_kg || 0) + qtyKg).toFixed(3));
        const newBags = Number(holdingLot.remaining_bags || 0) + bags;
        const newUnitCost = newKg > 0 ? Number(((oldVal + consumed.totalCost) / newKg).toFixed(6)) : 0;
        await db
          .prepare(
            `UPDATE inventory_lots
             SET initial_qty_kg = initial_qty_kg + ?, remaining_qty_kg = ?,
                 initial_bags = initial_bags + ?, remaining_bags = ?,
                 unit_cost_per_kg = ?, weight_pending = 0, version = version + 1
             WHERE id = ?`
          )
          .run(qtyKg, newKg, bags, newBags, newUnitCost, holdingLot.id);
        await db
          .prepare(
            `INSERT INTO stock_ledger (
              lot_id, item_id, warehouse_id, movement_type, reference_type, reference_id,
              qty_change_kg, unit_cost_per_kg, total_cost, balance_after_kg, employee_id
            ) VALUES (?, ?, ?, 'CHATAL_INTAKE_IN', 'CHATAL_BATCH', ?, ?, ?, ?, ?, ?)`
          )
          .run(
            holdingLot.id,
            itemId,
            chatal.chatal_warehouse_id,
            chatalId,
            qtyKg,
            qtyKg > 0 ? Number((consumed.totalCost / qtyKg).toFixed(4)) : 0,
            consumed.totalCost,
            newKg,
            req.user!.id
          );
      } else {
        await createInventoryLot({
          prefix: 'LOT-CHT',
          itemId,
          warehouseId: chatal.chatal_warehouse_id,
          sourceType: 'CHATAL_YARD',
          sourceId: chatalId,
          chatalBatchId: chatalId,
          qtyKg,
          bagCount: bags,
          unitCostPerKg: qtyKg > 0 ? Number((consumed.totalCost / qtyKg).toFixed(6)) : 0,
          movementType: 'CHATAL_INTAKE_IN',
          employeeId: req.user!.id,
        });
      }

      await db
        .prepare(
          `UPDATE chatal_batches
           SET total_intake_bags = total_intake_bags + ?,
               total_intake_kg = total_intake_kg + ?,
               total_paddy_cost = total_paddy_cost + ?
           WHERE id = ?`
        )
        .run(bags, qtyKg, consumed.totalCost, chatalId);

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'CHATAL_EXTRA_PADDY_POURED',
        entityType: 'CHATAL_BATCH',
        entityId: chatal.chatal_no,
        afterObj: { bags, qty_kg: qtyKg, paddy_cost: consumed.totalCost },
      });

      return { status: 'OK', chatal_batch: await getEnrichedChatalBatch(chatalId) };
    })();
    res.json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      res.status(409).json({ error: err.message, code: 'INSUFFICIENT_STOCK' });
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

// Record Chatal Expenses (Drying, Khamal, Fuel, Packaging, Transport, Other)
app.post('/api/v1/chatal-batches/:id/expenses', authenticate, requirePermission('drying.manage'), async (req: AuthedRequest, res) => {
  const chatalId = Number(req.params.id);
  const body = req.body as {
    expense_type?: 'DRYING' | 'KHAMAL' | 'LABOR' | 'FUEL_POWER' | 'PACKAGING' | 'TRANSPORT' | 'OTHER';
    vendor_name?: string;
    total_amount: number;
    payment_timing?: 'PAID' | 'UNPAID' | 'PARTIAL';
    paid_now?: number;
    account_id?: number;
    notes?: string;
  };

  const amount = Number(Number(body.total_amount || 0).toFixed(2));
  if (amount <= 0) {
    res.status(400).json({ error: 'Expense amount must be greater than zero' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const chatal = (await db.prepare('SELECT id, chatal_no FROM chatal_batches WHERE id = ?').get(chatalId)) as
        | { id: number; chatal_no: string }
        | undefined;
      if (!chatal) throw new Error('Chatal batch not found');

      const expType = body.expense_type || 'DRYING';
      const timing = body.payment_timing === 'UNPAID' || body.payment_timing === 'PARTIAL' ? body.payment_timing : 'PAID';
      const paidNow =
        timing === 'UNPAID' ? 0 : timing === 'PARTIAL' ? Math.min(amount, Math.max(0, Number(body.paid_now || 0))) : amount;
      const dueNow = Number((amount - paidNow).toFixed(2));
      const payStatus = paidNow <= 0 ? 'UNPAID' : dueNow <= 0.01 ? 'PAID' : 'PARTIAL';

      let payAccountCode = '1001';
      let resolvedAccId: number | null = null;
      if (paidNow > 0) {
        const acc = body.account_id
          ? (await db.prepare('SELECT id, account_code FROM accounts WHERE id = ?').get(body.account_id) as { id: number; account_code: string } | undefined)
          : (await db.prepare("SELECT id, account_code FROM accounts WHERE account_code = '1001' LIMIT 1").get() as { id: number; account_code: string } | undefined);
        if (!acc) throw new Error('Cash/Bank account not found');
        payAccountCode = acc.account_code;
        resolvedAccId = acc.id;
      }

      await db.prepare(
        "INSERT OR IGNORE INTO accounts (account_code, name, account_type, balance, is_system) VALUES ('2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0, 1)"
      ).run();

      const expIns = await db
        .prepare(
          `INSERT INTO chatal_batch_expenses (
            chatal_batch_id, expense_type, vendor_name, total_amount, payment_status, paid_amount, account_id, paid_at, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ${paidNow > 0 ? "datetime('now')" : 'NULL'}, ?, ?)`
        )
        .run(chatalId, expType, String(body.vendor_name || '').trim(), amount, payStatus, paidNow, resolvedAccId, String(body.notes || '').trim(), req.user!.id);

      const expenseId = Number(expIns.lastInsertRowid);
      if (paidNow > 0 && resolvedAccId) {
        const pSeq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM chatal_expense_payments').get() as { nextId: number }).nextId;
        await db.prepare(
          `INSERT INTO chatal_expense_payments (receipt_no, expense_id, chatal_batch_id, account_id, amount, payment_mode, notes, paid_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          `CEXP-2026-${String(pSeq).padStart(4, '0')}`,
          expenseId,
          chatalId,
          resolvedAccId,
          paidNow,
          payAccountCode === '1002' ? 'BANK_TRANSFER' : 'CASH',
          body.notes || 'Chatal expense payment',
          req.user!.id
        );
      }

      if (expType === 'DRYING') {
        await db.prepare('UPDATE chatal_batches SET drying_cost = drying_cost + ? WHERE id = ?').run(amount, chatalId);
      } else if (expType === 'KHAMAL') {
        await db.prepare('UPDATE chatal_batches SET khamal_cost = khamal_cost + ? WHERE id = ?').run(amount, chatalId);
      } else {
        await db.prepare('UPDATE chatal_batches SET other_cost = other_cost + ? WHERE id = ?').run(amount, chatalId);
      }

      const capitalized = await capitalizeExpenseOntoChatalLots(chatalId, amount);
      const debitAccountCode = capitalized ? '1200' : '5100';
      const jeLines: Array<{ accountCode: string; debit: number; credit: number }> = [
        { accountCode: debitAccountCode, debit: amount, credit: 0 },
      ];
      if (paidNow > 0) jeLines.push({ accountCode: payAccountCode, debit: 0, credit: paidNow });
      if (dueNow > 0.005) jeLines.push({ accountCode: '2002', debit: 0, credit: dueNow });

      await postJournalEntry({
        description: `Chatal ${expType} Expense - ${chatal.chatal_no}`,
        referenceType: 'CHATAL_BATCH',
        referenceId: chatalId,
        employeeId: req.user!.id,
        lines: jeLines,
      });

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'CHATAL_EXPENSE_RECORDED',
        entityType: 'CHATAL_BATCH',
        entityId: chatal.chatal_no,
        afterObj: { expense_type: expType, amount, paidNow, dueNow, capitalized },
      });

      return { status: 'OK', chatal_batch: await getEnrichedChatalBatch(chatalId) };
    })();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/v1/chatal-batches/:id/expenses/:expId/pay', authenticate, requirePermission('drying.manage'), async (req: AuthedRequest, res) => {
  const chatalId = Number(req.params.id);
  const expId = Number(req.params.expId);
  const body = req.body as { account_id?: number; amount: number; payment_mode?: string; reference_no?: string; notes?: string };

  const payAmt = Number(Number(body.amount || 0).toFixed(2));
  if (payAmt <= 0) {
    res.status(400).json({ error: 'Payment amount must be greater than zero' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const chatal = (await db.prepare('SELECT id, chatal_no FROM chatal_batches WHERE id = ?').get(chatalId)) as { id: number; chatal_no: string } | undefined;
      const exp = (await db.prepare('SELECT * FROM chatal_batch_expenses WHERE id = ? AND chatal_batch_id = ?').get(expId, chatalId)) as
        | { id: number; total_amount: number; paid_amount: number; expense_type: string }
        | undefined;
      if (!chatal || !exp) throw new Error('Chatal expense record not found');

      const remainingDue = Number((Number(exp.total_amount || 0) - Number(exp.paid_amount || 0)).toFixed(2));
      if (remainingDue <= 0.005) throw new Error('Expense is already fully paid');
      if (payAmt > remainingDue + 0.01) throw new Error(`Amount exceeds remaining due (৳${remainingDue.toFixed(2)})`);

      const acc = body.account_id
        ? (await db.prepare('SELECT id, account_code FROM accounts WHERE id = ?').get(body.account_id) as { id: number; account_code: string } | undefined)
        : (await db.prepare("SELECT id, account_code FROM accounts WHERE account_code = '1001' LIMIT 1").get() as { id: number; account_code: string } | undefined);
      if (!acc) throw new Error('Cash/Bank account not found');

      const newPaid = Number((Number(exp.paid_amount || 0) + payAmt).toFixed(2));
      const newStatus = newPaid >= Number(exp.total_amount) - 0.01 ? 'PAID' : 'PARTIAL';

      await db
        .prepare("UPDATE chatal_batch_expenses SET paid_amount = ?, payment_status = ?, account_id = ?, paid_at = datetime('now') WHERE id = ?")
        .run(newPaid, newStatus, acc.id, expId);

      const pSeq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM chatal_expense_payments').get() as { nextId: number }).nextId;
      await db.prepare(
        `INSERT INTO chatal_expense_payments (receipt_no, expense_id, chatal_batch_id, account_id, amount, payment_mode, reference_no, notes, paid_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `CEXP-2026-${String(pSeq).padStart(4, '0')}`,
        expId,
        chatalId,
        acc.id,
        payAmt,
        body.payment_mode || (acc.account_code === '1002' ? 'BANK_TRANSFER' : 'CASH'),
        String(body.reference_no || '').trim(),
        String(body.notes || '').trim() || 'Chatal due expense settled',
        req.user!.id
      );

      await postJournalEntry({
        description: `Chatal Expense Due Settled - ${chatal.chatal_no} (${exp.expense_type})`,
        referenceType: 'CHATAL_BATCH',
        referenceId: chatalId,
        employeeId: req.user!.id,
        lines: [
          { accountCode: '2002', debit: payAmt, credit: 0 },
          { accountCode: acc.account_code, debit: 0, credit: payAmt },
        ],
      });

      return { status: 'PAID', chatal_batch: await getEnrichedChatalBatch(chatalId) };
    })();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Multi-Godown Split Dispatch from Chatal (Round 1, Round 2, etc.)
app.post('/api/v1/chatal-batches/:id/dispatch', authenticate, requirePermission('drying.manage'), async (req: AuthedRequest, res) => {
  const chatalId = Number(req.params.id);
  const body = req.body as {
    moisture_loss_kg?: number;
    notes?: string;
    splits: Array<{
      dest_warehouse_id: number;
      bag_count: number;
      qty_kg?: number;
      weight_pending?: boolean;
      sale_style_unit_kg?: number;
      sale_style_rate?: number;
      notes?: string;
    }>;
  };

  const splits = Array.isArray(body.splits) ? body.splits.filter((s) => Number(s.bag_count || 0) > 0 || Number(s.qty_kg || 0) > 0) : [];
  if (splits.length === 0) {
    res.status(400).json({ error: 'Add at least one destination godown split' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const chatal = (await db.prepare('SELECT * FROM chatal_batches WHERE id = ?').get(chatalId)) as
        | { id: number; chatal_no: string; chatal_warehouse_id: number; paddy_item_id: number; status: string }
        | undefined;
      if (!chatal) throw new Error('Chatal batch not found');
      if (chatal.status !== 'ACTIVE') throw new Error('Chatal batch is already closed');

      const holdingLot = (await db
        .prepare(
          `SELECT * FROM inventory_lots
           WHERE source_type = 'CHATAL_YARD' AND source_id = ? AND remaining_qty_kg > 0.0001
           ORDER BY id ASC LIMIT 1`
        )
        .get(chatalId)) as
        | {
            id: number;
            lot_code: string;
            item_id: number;
            warehouse_id: number;
            remaining_qty_kg: number;
            remaining_bags: number;
            unit_cost_per_kg: number;
            version: number;
          }
        | undefined;

      if (!holdingLot) {
        throw new Error('No remaining paddy stock on Chatal yard to dispatch');
      }

      const moistureLoss = Math.max(0, Number(body.moisture_loss_kg || 0));
      const beforeKg = Number(holdingLot.remaining_qty_kg || 0);
      const beforeBags = Math.max(0, Number(holdingLot.remaining_bags || 0));
      const beforeCost = Number((beforeKg * Number(holdingLot.unit_cost_per_kg || 0)).toFixed(2));
      const effectiveDryKg = Number((beforeKg - moistureLoss).toFixed(3));
      if (effectiveDryKg <= 0) {
        throw new Error('Moisture loss cannot equal or exceed remaining Chatal weight');
      }

      const totalWeighedOutKg = splits.reduce((s, r) => s + (r.weight_pending ? 0 : Math.max(0, Number(r.qty_kg || 0))), 0);
      const totalOutBags = splits.reduce((s, r) => s + Math.max(0, Math.round(Number(r.bag_count || 0))), 0);
      if (totalWeighedOutKg > effectiveDryKg + 0.01) {
        throw new Error(`Dispatched weight (${totalWeighedOutKg} kg) exceeds available Chatal dry weight (${effectiveDryKg} kg)`);
      }

      const maxRoundRow = (await db
        .prepare('SELECT COALESCE(MAX(round_no), 0) as maxRound FROM chatal_batch_dispatches WHERE chatal_batch_id = ?')
        .get(chatalId)) as { maxRound: number };
      const roundNo = Number(maxRoundRow.maxRound || 0) + 1;

      let remainingCostPool = beforeCost;
      let remainingKgPool = effectiveDryKg;
      let remainingBagPool = beforeBags;
      const clearingAllBags = beforeBags > 0 && totalOutBags >= beforeBags && Math.abs(effectiveDryKg - totalWeighedOutKg) < 0.5;

      for (let idx = 0; idx < splits.length; idx++) {
        const sp = splits[idx];
        const spBags = Math.max(0, Math.round(Number(sp.bag_count || 0)));
        const isPending = Boolean(sp.weight_pending) || Number(sp.qty_kg || 0) <= 0;
        const spKg = isPending ? 0 : Number(Number(sp.qty_kg || 0).toFixed(3));
        const isLast = idx === splits.length - 1;

        let allocCost = 0;
        let deductKgFromHolding = spKg;
        if (isPending) {
          const bagShare = remainingBagPool > 0 ? Math.min(1, spBags / remainingBagPool) : 0;
          allocCost = Number((remainingCostPool * bagShare).toFixed(2));
          deductKgFromHolding = remainingBagPool > 0 ? Number((remainingKgPool * bagShare).toFixed(3)) : 0;
        } else {
          const kgShare = remainingKgPool > 0 ? Math.min(1, spKg / remainingKgPool) : 0;
          allocCost = Number((remainingCostPool * kgShare).toFixed(2));
        }

        if (isLast && (clearingAllBags || (remainingKgPool - deductKgFromHolding <= 0.01 && remainingBagPool - spBags <= 0))) {
          allocCost = Number(remainingCostPool.toFixed(2));
          deductKgFromHolding = remainingKgPool;
        }
        allocCost = Math.min(remainingCostPool, Math.max(0, allocCost));
        remainingCostPool = Number(Math.max(0, remainingCostPool - allocCost).toFixed(2));
        remainingKgPool = Number(Math.max(0, remainingKgPool - deductKgFromHolding).toFixed(3));
        remainingBagPool = Math.max(0, remainingBagPool - spBags);

        const saleUnitKg = Number(sp.sale_style_unit_kg || 75.5) > 0 ? Number(sp.sale_style_unit_kg || 75.5) : 75.5;
        const saleRate = Math.max(0, Number(sp.sale_style_rate || 0));
        const netSaleUnits = !isPending && spKg > spBags ? (spKg - spBags) / saleUnitKg : 0;
        const estSaleVal = saleRate > 0 && netSaleUnits > 0 ? Number((netSaleUnits * saleRate).toFixed(2)) : 0;

        const dispIns = await db
          .prepare(
            `INSERT INTO chatal_batch_dispatches (
              chatal_batch_id, round_no, from_warehouse_id, dest_warehouse_id, dest_lot_id,
              paddy_item_id, bag_count, qty_kg, weight_pending, allocated_cost,
              sale_style_unit_kg, sale_style_rate, sale_style_est_value, notes, created_by
            ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            chatalId,
            roundNo,
            holdingLot.warehouse_id,
            sp.dest_warehouse_id,
            holdingLot.item_id,
            spBags,
            spKg,
            isPending ? 1 : 0,
            allocCost,
            saleUnitKg,
            saleRate,
            estSaleVal,
            String(sp.notes || body.notes || '').trim(),
            req.user!.id
          );
        const dispatchId = Number(dispIns.lastInsertRowid);

        const destLot = await createInventoryLot({
          prefix: 'LOT-CGD',
          itemId: holdingLot.item_id,
          warehouseId: sp.dest_warehouse_id,
          sourceType: 'CHATAL_DISPATCH',
          sourceId: dispatchId,
          chatalBatchId: chatalId,
          qtyKg: spKg,
          bagCount: spBags,
          unitCostPerKg: !isPending && spKg > 0 ? Number((allocCost / spKg).toFixed(6)) : 0,
          weightPending: isPending,
          pendingCostTotal: isPending ? allocCost : 0,
          movementType: 'CHATAL_DISPATCH_IN',
          employeeId: req.user!.id,
        });

        await db.prepare('UPDATE chatal_batch_dispatches SET dest_lot_id = ? WHERE id = ?').run(destLot.lotId, dispatchId);

        await db
          .prepare(
            `INSERT INTO stock_ledger (
              lot_id, item_id, warehouse_id, movement_type, reference_type, reference_id,
              qty_change_kg, unit_cost_per_kg, total_cost, balance_after_kg, employee_id
            ) VALUES (?, ?, ?, 'CHATAL_DISPATCH_OUT', 'CHATAL_BATCH', ?, ?, ?, ?, ?, ?)`
          )
          .run(
            holdingLot.id,
            holdingLot.item_id,
            holdingLot.warehouse_id,
            chatalId,
            -deductKgFromHolding,
            deductKgFromHolding > 0 ? Number((allocCost / deductKgFromHolding).toFixed(4)) : 0,
            allocCost,
            remainingKgPool,
            req.user!.id
          );
      }

      const nextHoldingUnitCost =
        remainingKgPool > 0.0001 ? Number((remainingCostPool / remainingKgPool).toFixed(6)) : 0;
      const updHolding = await db
        .prepare(
          `UPDATE inventory_lots
           SET remaining_qty_kg = ?, remaining_bags = ?, unit_cost_per_kg = ?, version = version + 1
           WHERE id = ? AND version = ?`
        )
        .run(remainingKgPool, remainingBagPool, nextHoldingUnitCost, holdingLot.id, holdingLot.version);
      if (updHolding.changes === 0) {
        throw new Error('Concurrency conflict on Chatal holding lot. Please retry.');
      }

      if (moistureLoss > 0) {
        await db.prepare('UPDATE chatal_batches SET moisture_loss_kg = moisture_loss_kg + ? WHERE id = ?').run(moistureLoss, chatalId);
      }

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'CHATAL_MULTI_GODOWN_DISPATCH',
        entityType: 'CHATAL_BATCH',
        entityId: chatal.chatal_no,
        afterObj: { round_no: roundNo, splits_count: splits.length, moisture_loss_kg: moistureLoss, chatal_remaining_kg: remainingKgPool },
      });

      return { status: 'OK', round_no: roundNo, chatal_batch: await getEnrichedChatalBatch(chatalId) };
    })();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Send Chatal lot or Split Godown lot directly into Crushing / Milling (Step 1)
app.post('/api/v1/chatal-batches/:id/send-to-crushing', authenticate, requirePermission('production.manage'), async (req: AuthedRequest, res) => {
  const chatalId = Number(req.params.id);
  const body = req.body as {
    lot_id: number;
    process_type?: 'PARBOILED_SIDDHO' | 'RAW_ATAP';
    bag_count?: number;
    qty_kg: number;
    dryer_no?: string;
    dryer_count?: number;
    unit_divisor?: number;
    close_pending_lot?: boolean;
    notes?: string;
  };

  const qtyKg = Number(body.qty_kg || 0);
  if (!body.lot_id || qtyKg <= 0) {
    res.status(400).json({ error: 'Select source lot and enter valid paddy weight (kg) for crushing' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const chatal = (await db.prepare('SELECT id, chatal_no FROM chatal_batches WHERE id = ?').get(chatalId)) as
        | { id: number; chatal_no: string }
        | undefined;
      if (!chatal) throw new Error('Chatal batch not found');

      const lot = (await db
        .prepare('SELECT * FROM inventory_lots WHERE id = ?')
        .get(body.lot_id)) as
        | {
            id: number;
            item_id: number;
            warehouse_id: number;
            remaining_qty_kg: number;
            remaining_bags: number;
            weight_pending: number;
            chatal_batch_id: number | null;
            source_type: string;
            source_id: number | null;
          }
        | undefined;
      if (!lot) throw new Error('Source inventory lot not found');

      const procType = body.process_type === 'RAW_ATAP' ? 'RAW_ATAP' : 'PARBOILED_SIDDHO';
      const bags = Math.max(0, Math.round(Number(body.bag_count ?? lot.remaining_bags ?? 0)));
      const divisor = Number(body.unit_divisor || 75.5) > 0 ? Number(body.unit_divisor || 75.5) : 75.5;
      const dryerCount = Number(body.dryer_count || 1) > 0 ? Number(body.dryer_count || 1) : 1;
      const dryerNo = String(body.dryer_no || '').trim() || `ডায়ার-${dryerCount}`;

      const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM production_batches').get() as { nextId: number }).nextId;
      const prefix = procType === 'PARBOILED_SIDDHO' ? 'PRD-SID' : 'PRD-ATP';
      const batchNo = `${prefix}-${String(2600 + seq)}`;
      const qrUid = crypto.randomUUID();
      const batchUuid = crypto.randomUUID();

      const info = await db
        .prepare(
          `INSERT INTO production_batches (
            client_uuid, batch_no, process_type, source_warehouse_id, paddy_item_id, chatal_batch_id,
            input_paddy_qty_kg, input_bag_count, dryer_no, dryer_count, unit_divisor,
            paddy_net_units, paddy_bag_unit_rate, paddy_formula_cost, costing_method,
            status, qr_code_uid, notes, created_by, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 'FIFO', 'IN_PROGRESS', ?, ?, ?, NULL)`
        )
        .run(
          batchUuid,
          batchNo,
          procType,
          lot.warehouse_id,
          lot.item_id,
          chatalId,
          qtyKg,
          bags,
          dryerNo,
          dryerCount,
          divisor,
          qrUid,
          String(body.notes || '').trim() || `Chatal ${chatal.chatal_no} -> Crushing`,
          req.user!.id
        );
      const batchId = Number(info.lastInsertRowid);

      let paddyCost = 0;
      if (Number(lot.weight_pending || 0) === 1) {
        const closeLot =
          body.close_pending_lot !== undefined ? Boolean(body.close_pending_lot) : bags >= Number(lot.remaining_bags || 0);
        const pendingRes = await consumePendingWeightLot({
          lotId: lot.id,
          qtyKg,
          bagCount: bags,
          closeLot,
          movementType: 'PRODUCTION_INPUT',
          referenceType: 'PRODUCTION_BATCH',
          referenceId: batchId,
          employeeId: req.user!.id,
        });
        paddyCost = pendingRes.totalCost;
      } else {
        const consumed = await consumeWarehouseStock({
          itemId: lot.item_id,
          warehouseId: lot.warehouse_id,
          qtyKg,
          bagCount: bags > 0 ? bags : undefined,
          preferredLotId: lot.id,
          costingMethod: 'FIFO',
          movementType: 'PRODUCTION_INPUT',
          referenceType: 'PRODUCTION_BATCH',
          referenceId: batchId,
          employeeId: req.user!.id,
        });
        paddyCost = consumed.totalCost;
      }

      const netUnits = qtyKg > bags ? Number(((qtyKg - bags) / divisor).toFixed(4)) : 0;
      const bagRate = netUnits > 0 ? Number((paddyCost / netUnits).toFixed(4)) : 0;

      await db
        .prepare('UPDATE production_batches SET paddy_net_units = ?, paddy_bag_unit_rate = ?, paddy_formula_cost = ? WHERE id = ?')
        .run(netUnits, bagRate, paddyCost, batchId);

      await db
        .prepare(
          `INSERT INTO production_batch_inputs (
            batch_id, source_warehouse_id, paddy_item_id, bag_count, qty_kg, unit_divisor, net_units, bag_unit_rate, paddy_cost, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(batchId, lot.warehouse_id, lot.item_id, bags, qtyKg, divisor, netUnits, bagRate, paddyCost, `Chatal ${chatal.chatal_no}`, req.user!.id);

      await db
        .prepare(
          `INSERT INTO production_cost_sheets (
            batch_id, raw_paddy_cost, gross_batch_cost, byproduct_credit_value, net_head_rice_cost, cost_per_kg_head_rice, cost_per_bag_head_rice
          ) VALUES (?, ?, ?, 0, ?, 0, 0)`
        )
        .run(batchId, paddyCost, paddyCost, paddyCost);

      await registerQrTag({
        qrCodeUid: qrUid,
        entityType: 'PRODUCTION_BATCH',
        entityId: batchId,
        entityCode: batchNo,
        payload: { batch_no: batchNo, chatal_no: chatal.chatal_no, qty_kg: qtyKg, bags },
      });

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'CHATAL_SENT_TO_CRUSHING',
        entityType: 'CHATAL_BATCH',
        entityId: chatal.chatal_no,
        afterObj: { production_batch_no: batchNo, lot_id: lot.id, qty_kg: qtyKg, bags, paddy_cost: paddyCost },
      });

      return {
        status: 'IN_PROGRESS',
        batch: await getEnrichedProductionBatch(batchId),
        chatal_batch: await getEnrichedChatalBatch(chatalId),
      };
    })();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      res.status(409).json({ error: err.message, code: 'INSUFFICIENT_STOCK' });
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

// Close / Finalize Chatal Batch & Settle P&L
app.post('/api/v1/chatal-batches/:id/close', authenticate, requirePermission('drying.manage'), async (req: AuthedRequest, res) => {
  const chatalId = Number(req.params.id);
  const body = req.body as { write_off_remaining?: boolean };
  try {
    const result = await db.transaction(async () => {
      const chatal = (await db.prepare('SELECT id, chatal_no, status FROM chatal_batches WHERE id = ?').get(chatalId)) as
        | { id: number; chatal_no: string; status: string }
        | undefined;
      if (!chatal) throw new Error('Chatal batch not found');

      const openLots = (await db
        .prepare(
          `SELECT id, lot_code, remaining_qty_kg, unit_cost_per_kg, weight_pending, pending_cost_total
           FROM inventory_lots
           WHERE (chatal_batch_id = ? OR (source_type = 'CHATAL_YARD' AND source_id = ?))
             AND (remaining_qty_kg > 0.01 OR COALESCE(weight_pending, 0) = 1)`
        )
        .all(chatalId, chatalId)) as Array<{
        id: number;
        lot_code: string;
        remaining_qty_kg: number;
        unit_cost_per_kg: number;
        weight_pending: number;
        pending_cost_total: number;
      }>;

      if (openLots.length > 0 && !body.write_off_remaining) {
        throw new Error('Unsold/unmilled paddy still remains on Chatal or split godowns. Sell/crush it first or check shrinkage write-off.');
      }

      if (openLots.length > 0 && body.write_off_remaining) {
        let writeOffCost = 0;
        for (const l of openLots) {
          const val =
            Number(l.weight_pending || 0) === 1
              ? Number(l.pending_cost_total || 0)
              : Number(l.remaining_qty_kg || 0) * Number(l.unit_cost_per_kg || 0);
          writeOffCost += val;
          await db
            .prepare('UPDATE inventory_lots SET remaining_qty_kg = 0, remaining_bags = 0, weight_pending = 0, pending_cost_total = 0, version = version + 1 WHERE id = ?')
            .run(l.id);
        }
        writeOffCost = Number(writeOffCost.toFixed(2));
        if (writeOffCost > 0.01) {
          await postJournalEntry({
            description: `Chatal Shrinkage / Dust Write-off - ${chatal.chatal_no}`,
            referenceType: 'CHATAL_BATCH',
            referenceId: chatalId,
            employeeId: req.user!.id,
            lines: [
              { accountCode: '5200', debit: writeOffCost, credit: 0 },
              { accountCode: '1200', debit: 0, credit: writeOffCost },
            ],
          });
        }
      }

      await db.prepare("UPDATE chatal_batches SET status = 'COMPLETED', closed_at = datetime('now') WHERE id = ?").run(chatalId);
      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'CHATAL_BATCH_CLOSED',
        entityType: 'CHATAL_BATCH',
        entityId: chatal.chatal_no,
        afterObj: { write_off_remaining: Boolean(body.write_off_remaining) },
      });

      return { status: 'COMPLETED', chatal_batch: await getEnrichedChatalBatch(chatalId) };
    })();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// 9. Production Batches (Parboiled Siddho & Raw Atap) + Separate Cost Sheets
// ---------------------------------------------------------------------------
async function getEnrichedProductionBatch(batchId: number): Promise<Record<string, unknown> | null> {
  const b = (await db
    .prepare(
      `SELECT b.*, i.name as paddy_item_name, w.name as source_warehouse_name
       FROM production_batches b
       JOIN items i ON i.id = b.paddy_item_id
       JOIN warehouses w ON w.id = b.source_warehouse_id
       WHERE b.id = ?`
    )
    .get(batchId)) as Record<string, unknown> | undefined;
  if (!b) return null;

  const sheet = ((await db.prepare('SELECT * FROM production_cost_sheets WHERE batch_id = ?').get(batchId)) as Record<string, unknown> | undefined) || null;
  const inputLogs = await db
    .prepare(
      `SELECT pbi.*, w.name as warehouse_name, i.name as item_name, emp.full_name as created_by_name
       FROM production_batch_inputs pbi
       JOIN warehouses w ON w.id = pbi.source_warehouse_id
       JOIN items i ON i.id = pbi.paddy_item_id
       LEFT JOIN employees emp ON emp.id = pbi.created_by
       WHERE pbi.batch_id = ?
       ORDER BY pbi.id ASC`
    )
    .all(batchId);

  const expensesRaw = (await db
    .prepare(
      `SELECT e.*, emp.full_name as created_by_name
       FROM production_batch_expenses e
       LEFT JOIN employees emp ON emp.id = e.created_by
       WHERE e.batch_id = ?
       ORDER BY e.id DESC`
    )
    .all(batchId)) as Array<Record<string, unknown>>;

  const getExpPayments = db.prepare(
    `SELECT pep.*, a.name as account_name, emp.full_name as paid_by_name
     FROM production_expense_payments pep
     JOIN accounts a ON a.id = pep.account_id
     LEFT JOIN employees emp ON emp.id = pep.paid_by
     WHERE pep.expense_id = ?
     ORDER BY pep.id DESC`
  );
  const expenseLogs = await Promise.all(
    expensesRaw.map(async (exp) => ({
      ...exp,
      payment_logs: await getExpPayments.all(exp.id as number),
    }))
  );

  const expensePaymentReceipts = await db
    .prepare(
      `SELECT pep.*, a.name as account_name, emp.full_name as paid_by_name,
              pbe.expense_category, pbe.vendor_name, pbe.total_amount as expense_total
       FROM production_expense_payments pep
       JOIN production_batch_expenses pbe ON pbe.id = pep.expense_id
       JOIN accounts a ON a.id = pep.account_id
       LEFT JOIN employees emp ON emp.id = pep.paid_by
       WHERE pep.batch_id = ?
       ORDER BY pep.id DESC`
    )
    .all(batchId);

  const outputs = await db
    .prepare(
      `SELECT po.*, i.name as item_name, w.name as warehouse_name, l.lot_code, l.remaining_qty_kg, l.remaining_bags
       FROM production_outputs po
       JOIN items i ON i.id = po.item_id
       JOIN warehouses w ON w.id = po.warehouse_id
       LEFT JOIN inventory_lots l ON l.id = po.lot_id
       WHERE po.batch_id = ?
       ORDER BY po.id ASC`
    )
    .all(batchId);

  const salesAgg = await db
    .prepare(
      `SELECT COALESCE(SUM(qty_kg), 0) as sold_kg,
              COALESCE(SUM(bag_count), 0) as sold_bags,
              COALESCE(SUM(sale_amount), 0) as sold_revenue,
              COALESCE(SUM(cost_amount), 0) as sold_cogs,
              COALESCE(SUM(profit_amount), 0) as realized_profit,
              COUNT(DISTINCT invoice_id) as sales_count
       FROM sales_invoice_lot_allocations
       WHERE batch_id = ?`
    )
    .get(batchId) as {
    sold_kg: number;
    sold_bags: number;
    sold_revenue: number;
    sold_cogs: number;
    realized_profit: number;
    sales_count: number;
  };

  const stockAgg = await db
    .prepare(
      `SELECT COALESCE(SUM(remaining_qty_kg), 0) as unsold_kg,
              COALESCE(SUM(remaining_bags), 0) as unsold_bags,
              COALESCE(SUM(remaining_qty_kg * unit_cost_per_kg), 0) as unsold_val
       FROM inventory_lots
       WHERE (origin_batch_id = ? OR (source_type = 'PRODUCTION_OUTPUT' AND source_id = ?)) AND remaining_qty_kg > 0.0001`
    )
    .get(batchId, batchId) as {
    unsold_kg: number;
    unsold_bags: number;
    unsold_val: number;
  };

  const totalBatchCost = Number((sheet?.gross_batch_cost as number) ?? (b.paddy_formula_cost as number) ?? 0);
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
  const resolvedNetUnits =
    Number(b.paddy_net_units || 0) > 0
      ? Number(b.paddy_net_units)
      : inputPaddyKgVal > inputBagsVal
        ? Number(((inputPaddyKgVal - inputBagsVal) / divisorVal).toFixed(4))
        : 0;
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
      sales_count: Number(salesAgg.sales_count || 0),
    },
  };
}

app.get('/api/v1/production-batches', authenticate, async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const batchIds = await db
    .prepare('SELECT id FROM production_batches ORDER BY id DESC')
    .all() as Array<{ id: number }>;

  const enrichedAll = await Promise.all(batchIds.map((row) => getEnrichedProductionBatch(row.id)));
  const enriched = enrichedAll.filter((b): b is Record<string, unknown> => b !== null);
  res.json({ batches: enriched });
});

app.post('/api/v1/production-batches', authenticate, requirePermission('production.manage'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    client_uuid?: string;
    device_id?: string;
    client_type?: 'WEB_PWA' | 'ANDROID_APP';
    process_type: 'PARBOILED_SIDDHO' | 'RAW_ATAP';
    source_warehouse_id: number;
    paddy_item_id: number;
    input_paddy_qty_kg: number;
    input_bag_count?: number;
    dryer_no?: string;
    dryer_count?: number;
    unit_divisor?: number;
    issue_only?: boolean;
    costing_method?: CostingMethod;
    soaking_hours?: number;
    steaming_temp_c?: number;
    head_rice_item_id?: number;
    rice_warehouse_id?: number;
    byproduct_warehouse_id?: number;
    head_rice_qty_kg?: number;
    broken_rice_qty_kg?: number;
    bran_qty_kg?: number;
    husk_qty_kg?: number;
    labor_cost?: number;
    electricity_cost?: number;
    fuel_boiler_cost?: number;
    machinery_overhead_cost?: number;
    packaging_cost?: number;
    notes?: string;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
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
    res.status(400).json({ error: 'Input paddy weight must be positive' });
    return;
  }
  if (!issueOnly && (totalOutput > body.input_paddy_qty_kg || headRiceQty <= 0)) {
    res.status(400).json({ error: 'Total milled outputs cannot exceed input paddy weight, and head rice must be positive' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM production_batches').get() as { nextId: number }).nextId;
      const prefix = body.process_type === 'PARBOILED_SIDDHO' ? 'PRD-SID' : 'PRD-ATP';
      const batchNo = `${prefix}-${String(2600 + seq)}`;
      const qrUid = crypto.randomUUID();
      const costingMethod = body.costing_method || 'FIFO';

      const activeLots = await db
        .prepare(
          `SELECT l.remaining_qty_kg, l.remaining_bags, l.unit_cost_per_kg, l.initial_qty_kg, l.source_type,
                  pp.bag_count as purchase_bag_count, i.bag_weight_kg
           FROM inventory_lots l
           JOIN items i ON i.id = l.item_id
           LEFT JOIN paddy_purchases pp ON l.source_type = 'PADDY_PURCHASE' AND pp.id = l.source_id
           WHERE l.item_id = ? AND l.warehouse_id = ? AND l.remaining_qty_kg > 0.0001`
        )
        .all(body.paddy_item_id, body.source_warehouse_id) as Array<{
        remaining_qty_kg: number;
        remaining_bags: number;
        unit_cost_per_kg: number;
        initial_qty_kg: number;
        source_type: string;
        purchase_bag_count: number | null;
        bag_weight_kg: number | null;
      }>;

      const stockWeightKg = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);
      const stockBags = activeLots.reduce((s, l) => {
        if (l.remaining_bags > 0) return s + Number(l.remaining_bags);
        if (l.source_type === 'PADDY_PURCHASE' && (l.purchase_bag_count || 0) > 0 && l.initial_qty_kg > 0) {
          return s + Math.round((Number(l.remaining_qty_kg) * Number(l.purchase_bag_count)) / Number(l.initial_qty_kg));
        }
        return s + Math.round(Number(l.remaining_qty_kg) / (Number(l.bag_weight_kg || 60) || 60));
      }, 0);
      const stockValue = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0) * Number(l.unit_cost_per_kg || 0), 0);

      const divisor = Number(body.unit_divisor || 75.5) > 0 ? Number(body.unit_divisor || 75.5) : 75.5;
      const inputBags = Math.max(0, Math.round(Number(body.input_bag_count || 0)));
      const dryerCount = Number(body.dryer_count || 1) > 0 ? Number(body.dryer_count || 1) : 1;
      const dryerNo = String(body.dryer_no || '').trim() || `ডায়ার-${dryerCount}`;

      const stockNetUnits = stockWeightKg > stockBags ? (stockWeightKg - stockBags) / divisor : 0;
      const bagUnitRate = stockNetUnits > 0 ? Number((stockValue / stockNetUnits).toFixed(4)) : 0;
      const goingNetUnits =
        inputBags > 0 && body.input_paddy_qty_kg > inputBags
          ? Number(((body.input_paddy_qty_kg - inputBags) / divisor).toFixed(4))
          : 0;
      const formulaCost = bagUnitRate > 0 && goingNetUnits > 0 ? Number((bagUnitRate * goingNetUnits).toFixed(2)) : 0;

      const wastageKg = issueOnly ? 0 : Number((body.input_paddy_qty_kg - totalOutput).toFixed(3));
      const headRiceYieldPct = issueOnly ? 0 : Number(((headRiceQty / body.input_paddy_qty_kg) * 100).toFixed(2));
      const totalRecoveryPct = issueOnly ? 0 : Number(((totalOutput / body.input_paddy_qty_kg) * 100).toFixed(2));
      const batchStatus = issueOnly ? 'IN_PROGRESS' : 'COMPLETED';

      const info = await db
        .prepare(
          `INSERT INTO production_batches (
            client_uuid, batch_no, process_type, source_warehouse_id, paddy_item_id, input_paddy_qty_kg,
            input_bag_count, dryer_no, dryer_count, unit_divisor, paddy_net_units, paddy_bag_unit_rate, paddy_formula_cost,
            costing_method, soaking_hours, steaming_temp_c, head_rice_qty_kg, broken_rice_qty_kg, bran_qty_kg,
            husk_qty_kg, wastage_qty_kg, head_rice_yield_pct, total_recovery_pct, status, qr_code_uid, notes, created_by, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${issueOnly ? 'NULL' : "datetime('now')"})`
        )
        .run(
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
          body.notes || '',
          req.user!.id
        );

      const batchId = Number(info.lastInsertRowid);

      const consumed = await consumeWarehouseStock({
        itemId: body.paddy_item_id,
        warehouseId: body.source_warehouse_id,
        qtyKg: body.input_paddy_qty_kg,
        bagCount: inputBags > 0 ? inputBags : undefined,
        costingMethod,
        movementType: 'PRODUCTION_INPUT',
        referenceType: 'PRODUCTION_BATCH',
        referenceId: batchId,
        employeeId: req.user!.id,
      });

      const effectiveRawPaddyCost = formulaCost > 0 ? formulaCost : consumed.totalCost;
      if (formulaCost === 0 && goingNetUnits > 0) {
        await db.prepare('UPDATE production_batches SET paddy_formula_cost = ? WHERE id = ?').run(effectiveRawPaddyCost, batchId);
      }

      await db.prepare(
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
        body.notes || 'প্রাথমিক ডায়ারে ধান ইস্যু',
        req.user!.id
      );

      const brokenItem = await db.prepare("SELECT id, default_rate FROM items WHERE category = 'BROKEN_RICE' LIMIT 1").get() as {
        id: number;
        default_rate: number;
      };
      const branItem = await db.prepare("SELECT id, default_rate FROM items WHERE category = 'RICE_BRAN' LIMIT 1").get() as {
        id: number;
        default_rate: number;
      };
      const huskItem = await db.prepare("SELECT id, default_rate FROM items WHERE category = 'HUSK' LIMIT 1").get() as {
        id: number;
        default_rate: number;
      };

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

      await db.prepare(
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

        const headLot = await createInventoryLot({
          prefix: 'LOT-RIC',
          itemId: body.head_rice_item_id,
          warehouseId: body.rice_warehouse_id,
          sourceType: 'PRODUCTION_OUTPUT',
          sourceId: batchId,
          qtyKg: headRiceQty,
          packSizeKg: 50,
          bagCount: Math.round(headRiceQty / 50),
          unitCostPerKg: costPerKgHeadRice,
          movementType: 'PRODUCTION_OUTPUT',
          employeeId: req.user!.id,
        });
        await insertOutput.run(
          batchId,
          body.head_rice_item_id,
          body.rice_warehouse_id,
          'HEAD_RICE',
          50,
          Math.round(headRiceQty / 50),
          headRiceQty,
          costPerKgHeadRice,
          netHeadRiceCost,
          headLot.lotId
        );

        for (const b of [
          { qty: brokenRiceQty, item: brokenItem, type: 'BROKEN_RICE', val: brokenVal, pack: 50 },
          { qty: branQty, item: branItem, type: 'RICE_BRAN', val: branVal, pack: 50 },
          { qty: huskQty, item: huskItem, type: 'HUSK', val: huskVal, pack: 35 },
        ]) {
          if (b.qty <= 0) continue;
          const bBags = Math.round(b.qty / b.pack);
          const bLot = await createInventoryLot({
            prefix: 'LOT-BYP',
            itemId: b.item.id,
            warehouseId: body.byproduct_warehouse_id,
            sourceType: 'PRODUCTION_OUTPUT',
            sourceId: batchId,
            qtyKg: b.qty,
            packSizeKg: b.pack,
            bagCount: bBags,
            unitCostPerKg: b.item.default_rate,
            movementType: 'PRODUCTION_OUTPUT',
            employeeId: req.user!.id,
          });
          await insertOutput.run(batchId, b.item.id, body.byproduct_warehouse_id, b.type, b.pack, bBags, b.qty, b.item.default_rate, b.val, bLot.lotId);
        }
      }

      const overheadTotal = labor + elec + fuel + mach + pack;
      if (overheadTotal > 0) {
        await db.prepare(
          `INSERT INTO production_batch_expenses (
            batch_id, expense_category, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost, packaging_cost,
            total_amount, payment_status, paid_amount, paid_at, notes, created_by
          ) VALUES (?, 'GENERAL', ?, ?, ?, ?, ?, ?, 'PAID', ?, datetime('now'), ?, ?)`
        ).run(batchId, labor, elec, fuel, mach, pack, overheadTotal, overheadTotal, body.notes || 'Initial batch overhead', req.user!.id);

        await postJournalEntry({
          description: `Milling Overhead Capitalized - ${batchNo} (${body.process_type})`,
          referenceType: 'PRODUCTION_BATCH',
          referenceId: batchId,
          employeeId: req.user!.id,
          lines: [
            { accountCode: '1200', debit: overheadTotal, credit: 0 },
            { accountCode: '1001', debit: 0, credit: overheadTotal },
          ],
        });
      }

      await registerQrTag({
        qrCodeUid: qrUid,
        entityType: 'PRODUCTION_BATCH',
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
          cost_per_kg: costPerKgHeadRice,
        },
      });

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: issueOnly ? 'CRUSHING_DRYER_ISSUED' : 'PRODUCTION_BATCH_COMPLETED',
        entityType: 'PRODUCTION_BATCH',
        entityId: batchNo,
        afterObj: {
          process_type: body.process_type,
          dryer_no: dryerNo,
          dryer_count: dryerCount,
          input_bags: inputBags,
          input_kg: body.input_paddy_qty_kg,
          paddy_cost: effectiveRawPaddyCost,
        },
        deviceType: body.client_type || 'WEB_PWA',
      });

      const responseObj = { status: 'SYNCED', batch: await getEnrichedProductionBatch(batchId) };
      await recordSyncLog({
        clientUuid,
        deviceId: body.device_id || 'WEB-BROWSER',
        clientType: body.client_type || 'WEB_PWA',
        endpoint: '/api/v1/production-batches',
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      res.status(409).json({ error: err.message, code: 'INSUFFICIENT_STOCK' });
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

// Add extra paddy into an ongoing (IN_PROGRESS) dryer batch
app.post('/api/v1/production-batches/:id/add-paddy', authenticate, requirePermission('production.manage'), async (req: AuthedRequest, res) => {
  const batchId = Number(req.params.id);
  const body = req.body as {
    source_warehouse_id: number;
    paddy_item_id: number;
    bag_count: number;
    qty_kg: number;
    unit_divisor?: number;
    costing_method?: CostingMethod;
    notes?: string;
  };

  const batch = await db.prepare('SELECT * FROM production_batches WHERE id = ?').get(batchId) as
    | { id: number; batch_no: string; status: string; input_paddy_qty_kg: number; input_bag_count: number; unit_divisor: number }
    | undefined;
  if (!batch) {
    res.status(404).json({ error: 'Production batch not found' });
    return;
  }
  if (batch.status !== 'IN_PROGRESS') {
    res.status(400).json({ error: 'Can only add extra paddy to an ongoing (IN_PROGRESS) dryer batch' });
    return;
  }

  const addBags = Math.max(0, Math.round(Number(body.bag_count || 0)));
  const addKg = Number(body.qty_kg || 0);
  const divisor = Number(body.unit_divisor || batch.unit_divisor || 75.5) > 0 ? Number(body.unit_divisor || batch.unit_divisor || 75.5) : 75.5;
  const costingMethod = body.costing_method || 'FIFO';

  if (addKg <= 0 || addBags <= 0 || addKg <= addBags) {
    res.status(400).json({ error: 'Valid bag count and weight (weight > bags) are required' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const activeLots = await db
        .prepare(
          `SELECT l.remaining_qty_kg, l.remaining_bags, l.unit_cost_per_kg, l.initial_qty_kg, l.source_type,
                  pp.bag_count as purchase_bag_count, i.bag_weight_kg
           FROM inventory_lots l
           JOIN items i ON i.id = l.item_id
           LEFT JOIN paddy_purchases pp ON l.source_type = 'PADDY_PURCHASE' AND pp.id = l.source_id
           WHERE l.item_id = ? AND l.warehouse_id = ? AND l.remaining_qty_kg > 0.0001`
        )
        .all(body.paddy_item_id, body.source_warehouse_id) as Array<{
        remaining_qty_kg: number;
        remaining_bags: number;
        unit_cost_per_kg: number;
        initial_qty_kg: number;
        source_type: string;
        purchase_bag_count: number | null;
        bag_weight_kg: number | null;
      }>;

      const stockWeightKg = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0), 0);
      const stockBags = activeLots.reduce((s, l) => {
        if (l.remaining_bags > 0) return s + Number(l.remaining_bags);
        if (l.source_type === 'PADDY_PURCHASE' && (l.purchase_bag_count || 0) > 0 && l.initial_qty_kg > 0) {
          return s + Math.round((Number(l.remaining_qty_kg) * Number(l.purchase_bag_count)) / Number(l.initial_qty_kg));
        }
        return s + Math.round(Number(l.remaining_qty_kg) / (Number(l.bag_weight_kg || 60) || 60));
      }, 0);
      const stockValue = activeLots.reduce((s, l) => s + Number(l.remaining_qty_kg || 0) * Number(l.unit_cost_per_kg || 0), 0);
      const stockNetUnits = stockWeightKg > stockBags ? (stockWeightKg - stockBags) / divisor : 0;
      const bagUnitRate = stockNetUnits > 0 ? Number((stockValue / stockNetUnits).toFixed(4)) : 0;
      const addNetUnits = Number(((addKg - addBags) / divisor).toFixed(4));
      const formulaCost = bagUnitRate > 0 && addNetUnits > 0 ? Number((bagUnitRate * addNetUnits).toFixed(2)) : 0;

      const consumed = await consumeWarehouseStock({
        itemId: body.paddy_item_id,
        warehouseId: body.source_warehouse_id,
        qtyKg: addKg,
        bagCount: addBags,
        costingMethod,
        movementType: 'PRODUCTION_INPUT',
        referenceType: 'PRODUCTION_BATCH',
        referenceId: batchId,
        employeeId: req.user!.id,
      });

      const addCost = formulaCost > 0 ? formulaCost : consumed.totalCost;

      await db.prepare(
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
        String(body.notes || '').trim() || 'অতিরিক্ত ধান ডায়ারে যোগ',
        req.user!.id
      );

      await db.prepare(
        `UPDATE production_batches
         SET input_paddy_qty_kg = input_paddy_qty_kg + ?,
             input_bag_count = input_bag_count + ?,
             paddy_net_units = paddy_net_units + ?,
             paddy_formula_cost = paddy_formula_cost + ?
         WHERE id = ?`
      ).run(addKg, addBags, addNetUnits, addCost, batchId);

      const sheet = await db.prepare('SELECT * FROM production_cost_sheets WHERE batch_id = ?').get(batchId) as {
        raw_paddy_cost: number;
        labor_cost: number;
        electricity_cost: number;
        fuel_boiler_cost: number;
        machinery_overhead_cost: number;
        packaging_cost: number;
        byproduct_credit_value: number;
      };
      const newRaw = Number((Number(sheet.raw_paddy_cost) + addCost).toFixed(2));
      const newGross = Number(
        (
          newRaw +
          Number(sheet.labor_cost || 0) +
          Number(sheet.electricity_cost || 0) +
          Number(sheet.fuel_boiler_cost || 0) +
          Number(sheet.machinery_overhead_cost || 0) +
          Number(sheet.packaging_cost || 0)
        ).toFixed(2)
      );
      await db.prepare('UPDATE production_cost_sheets SET raw_paddy_cost = ?, gross_batch_cost = ?, net_head_rice_cost = ? WHERE batch_id = ?').run(
        newRaw,
        newGross,
        Math.max(0, newGross - Number(sheet.byproduct_credit_value || 0)),
        batchId
      );

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'CRUSHING_EXTRA_PADDY_ADDED',
        entityType: 'PRODUCTION_BATCH',
        entityId: batch.batch_no,
        afterObj: { addBags, addKg, addCost, newRaw },
      });

      return { status: 'OK', batch: await getEnrichedProductionBatch(batchId) };
    })();
    res.json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      res.status(409).json({ error: err.message, code: 'INSUFFICIENT_STOCK' });
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/v1/production-batches/:id/complete', authenticate, requirePermission('production.manage'), async (req: AuthedRequest, res) => {
  const batchId = Number(req.params.id);
  const body = req.body as {
    head_rice_item_id: number;
    rice_warehouse_id: number;
    byproduct_warehouse_id: number;
    head_rice_qty_kg?: number;
    head_rice_packs?: Array<{
      item_id?: number;
      pack_size_kg: number;
      bag_count: number;
      qty_kg?: number;
      warehouse_id?: number;
    }>;
    secondary_outputs?: Array<{
      item_id?: number;
      item_name?: string;
      category?: string;
      pack_size_kg?: number;
      bag_count?: number;
      qty_kg: number;
      rate_per_kg: number;
      rate_per_bag?: number;
      pricing_unit?: 'BAG' | 'KG';
      warehouse_id?: number;
    }>;
    broken_rice_qty_kg?: number;
    bran_qty_kg?: number;
    husk_qty_kg?: number;
    labor_cost?: number;
    electricity_cost?: number;
    fuel_boiler_cost?: number;
    machinery_overhead_cost?: number;
    packaging_cost?: number;
  };

  const batch = await db.prepare('SELECT * FROM production_batches WHERE id = ?').get(batchId) as
    | { id: number; batch_no: string; process_type: string; input_paddy_qty_kg: number; status: string; qr_code_uid: string }
    | undefined;
  if (!batch) {
    res.status(404).json({ error: 'Production batch not found' });
    return;
  }
  if (batch.status === 'COMPLETED') {
    res.status(400).json({ error: 'Production batch is already completed' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const sheet = await db.prepare('SELECT * FROM production_cost_sheets WHERE batch_id = ?').get(batchId) as {
        raw_paddy_cost: number;
        labor_cost: number;
        electricity_cost: number;
        fuel_boiler_cost: number;
        machinery_overhead_cost: number;
        packaging_cost: number;
      };

      // Resolve Head Rice Pack Rows (25kg, 50kg, etc.)
      const headPacksRaw =
        Array.isArray(body.head_rice_packs) && body.head_rice_packs.length > 0
          ? body.head_rice_packs
              .map((p) => {
                const packSize = Number(p.pack_size_kg || 50) > 0 ? Number(p.pack_size_kg || 50) : 50;
                const bags = Math.max(0, Math.round(Number(p.bag_count || 0)));
                const qty = p.qty_kg && Number(p.qty_kg) > 0 ? Number(p.qty_kg) : Number((bags * packSize).toFixed(3));
                return {
                  item_id: Number(p.item_id || body.head_rice_item_id),
                  warehouse_id: Number(p.warehouse_id || body.rice_warehouse_id),
                  pack_size_kg: packSize,
                  bag_count: bags > 0 ? bags : Math.round(qty / packSize),
                  qty_kg: qty,
                };
              })
              .filter((p) => p.qty_kg > 0)
          : Number(body.head_rice_qty_kg || 0) > 0
          ? [
              {
                item_id: Number(body.head_rice_item_id),
                warehouse_id: Number(body.rice_warehouse_id),
                pack_size_kg: 50,
                bag_count: Math.round(Number(body.head_rice_qty_kg || 0) / 50),
                qty_kg: Number(body.head_rice_qty_kg || 0),
              },
            ]
          : [];

      const headRiceQty = Number(headPacksRaw.reduce((s, p) => s + p.qty_kg, 0).toFixed(3));

      // Resolve Secondary / By-Product Outputs (e.g. Mora Machi 25kg, Diamond Khudi 50kg, Bran, Husk, Broken Rice)
      const brokenItem = await db.prepare("SELECT id, default_rate FROM items WHERE category = 'BROKEN_RICE' LIMIT 1").get() as {
        id: number;
        default_rate: number;
      };
      const branItem = await db.prepare("SELECT id, default_rate FROM items WHERE category = 'RICE_BRAN' LIMIT 1").get() as {
        id: number;
        default_rate: number;
      };
      const huskItem = await db.prepare("SELECT id, default_rate FROM items WHERE category = 'HUSK' LIMIT 1").get() as {
        id: number;
        default_rate: number;
      };

      const secondaryResolved: Array<{
        item_id: number;
        category: string;
        warehouse_id: number;
        pack_size_kg: number;
        bag_count: number;
        qty_kg: number;
        rate_per_kg: number;
        rate_per_bag: number;
        total_value: number;
      }> = [];

      if (Array.isArray(body.secondary_outputs) && body.secondary_outputs.length > 0) {
        for (const row of body.secondary_outputs) {
          const packSize = Number(row.pack_size_kg || 25) > 0 ? Number(row.pack_size_kg || 25) : 25;
          const bags = Math.max(0, Math.round(Number(row.bag_count || 0)));
          const qtyKg = row.qty_kg && Number(row.qty_kg) > 0 ? Number(row.qty_kg) : Number((bags * packSize).toFixed(3));
          if (qtyKg <= 0) continue;

          const resolvedBags = bags > 0 ? bags : Math.round(qtyKg / packSize);
          const hasBagRate = row.pricing_unit === 'BAG' && Number(row.rate_per_bag || 0) > 0 && resolvedBags > 0;
          const ratePerBag = hasBagRate
            ? Number(row.rate_per_bag)
            : Number((Math.max(0, Number(row.rate_per_kg || 0)) * packSize).toFixed(2));
          const val = hasBagRate
            ? Number((resolvedBags * ratePerBag).toFixed(2))
            : Number((qtyKg * Math.max(0, Number(row.rate_per_kg || 0))).toFixed(2));
          const ratePerKg = hasBagRate ? Number((val / qtyKg).toFixed(6)) : Math.max(0, Number(row.rate_per_kg || 0));

          let resolvedItemId = Number(row.item_id || 0);
          let resolvedCat = String(row.category || 'BY_PRODUCT');

          if (resolvedItemId > 0) {
            const existingItem = await db.prepare('SELECT id, category FROM items WHERE id = ?').get(resolvedItemId) as
              | { id: number; category: string }
              | undefined;
            if (existingItem) {
              resolvedCat = existingItem.category;
            } else {
              resolvedItemId = 0;
            }
          }

          if (resolvedItemId <= 0) {
            const cleanName = String(row.item_name || '').trim();
            if (!cleanName) throw new Error('Each secondary output must have an item selected or a custom item name');
            const byName = await db.prepare('SELECT id, category FROM items WHERE LOWER(name) = LOWER(?) LIMIT 1').get(cleanName) as
              | { id: number; category: string }
              | undefined;
            if (byName) {
              resolvedItemId = byName.id;
              resolvedCat = byName.category;
            } else {
              const itemSeq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM items').get() as { nextId: number }).nextId;
              const sku = `BYP-OUT-${String(itemSeq).padStart(3, '0')}`;
              const insItem = await db
                .prepare(
                  `INSERT INTO items (sku, name, category, process_grade, unit, bag_weight_kg, costing_method, default_rate, is_active)
                   VALUES (?, ?, ?, 'BY_PRODUCT', 'KG', ?, 'WEIGHTED_AVERAGE', ?, 1)`
                )
                .run(sku, cleanName, resolvedCat, packSize, ratePerKg);
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
            total_value: val,
          });
        }
      } else {
        const brokenQty = Number(body.broken_rice_qty_kg || 0);
        const branQty = Number(body.bran_qty_kg || 0);
        const huskQty = Number(body.husk_qty_kg || 0);
        if (brokenQty > 0) {
          secondaryResolved.push({
            item_id: brokenItem.id,
            category: 'BROKEN_RICE',
            warehouse_id: body.byproduct_warehouse_id,
            pack_size_kg: 50,
            bag_count: Math.round(brokenQty / 50),
            qty_kg: brokenQty,
            rate_per_kg: brokenItem.default_rate,
            rate_per_bag: Number((brokenItem.default_rate * 50).toFixed(2)),
            total_value: Number((brokenQty * brokenItem.default_rate).toFixed(2)),
          });
        }
        if (branQty > 0) {
          secondaryResolved.push({
            item_id: branItem.id,
            category: 'RICE_BRAN',
            warehouse_id: body.byproduct_warehouse_id,
            pack_size_kg: 50,
            bag_count: Math.round(branQty / 50),
            qty_kg: branQty,
            rate_per_kg: branItem.default_rate,
            rate_per_bag: Number((branItem.default_rate * 50).toFixed(2)),
            total_value: Number((branQty * branItem.default_rate).toFixed(2)),
          });
        }
        if (huskQty > 0) {
          secondaryResolved.push({
            item_id: huskItem.id,
            category: 'HUSK',
            warehouse_id: body.byproduct_warehouse_id,
            pack_size_kg: 35,
            bag_count: Math.round(huskQty / 35),
            qty_kg: huskQty,
            rate_per_kg: huskItem.default_rate,
            rate_per_bag: Number((huskItem.default_rate * 35).toFixed(2)),
            total_value: Number((huskQty * huskItem.default_rate).toFixed(2)),
          });
        }
      }

      const secondaryTotalKg = secondaryResolved.reduce((s, r) => s + r.qty_kg, 0);
      const totalOutput = Number((headRiceQty + secondaryTotalKg).toFixed(3));
      if (headRiceQty <= 0 || totalOutput > batch.input_paddy_qty_kg + 0.01) {
        throw new Error('Head rice must be positive and total output cannot exceed input paddy weight');
      }

      const brokenRiceQty = secondaryResolved
        .filter((r) => r.category === 'BROKEN_RICE')
        .reduce((s, r) => s + r.qty_kg, 0);
      const branQty = secondaryResolved
        .filter((r) => r.category === 'RICE_BRAN')
        .reduce((s, r) => s + r.qty_kg, 0);
      const huskQty = secondaryResolved
        .filter((r) => r.category === 'HUSK' || r.category === 'BY_PRODUCT')
        .reduce((s, r) => s + r.qty_kg, 0);

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
      const headRiceYieldPct = Number(((headRiceQty / batch.input_paddy_qty_kg) * 100).toFixed(2));
      const totalRecoveryPct = Number(((totalOutput / batch.input_paddy_qty_kg) * 100).toFixed(2));

      await db.prepare(
        `UPDATE production_batches
         SET head_rice_qty_kg = ?, broken_rice_qty_kg = ?, bran_qty_kg = ?, husk_qty_kg = ?,
             wastage_qty_kg = ?, head_rice_yield_pct = ?, total_recovery_pct = ?,
             status = 'COMPLETED', completed_at = datetime('now')
         WHERE id = ?`
      ).run(headRiceQty, brokenRiceQty, branQty, huskQty, wastageKg, headRiceYieldPct, totalRecoveryPct, batchId);

      await db.prepare(
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
        const headLot = await createInventoryLot({
          prefix: 'LOT-RIC',
          itemId: hp.item_id,
          warehouseId: hp.warehouse_id,
          sourceType: 'PRODUCTION_OUTPUT',
          sourceId: batchId,
          originBatchId: batchId,
          qtyKg: hp.qty_kg,
          bagCount: hp.bag_count,
          packSizeKg: hp.pack_size_kg,
          unitCostPerKg: costPerKgHeadRice,
          movementType: 'PRODUCTION_OUTPUT',
          employeeId: req.user!.id,
        });
        await insertOutput.run(
          batchId,
          hp.item_id,
          hp.warehouse_id,
          'HEAD_RICE',
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
        const bLot = await createInventoryLot({
          prefix: 'LOT-BYP',
          itemId: sec.item_id,
          warehouseId: sec.warehouse_id,
          sourceType: 'PRODUCTION_OUTPUT',
          sourceId: batchId,
          originBatchId: batchId,
          qtyKg: sec.qty_kg,
          bagCount: sec.bag_count,
          packSizeKg: sec.pack_size_kg,
          unitCostPerKg: sec.rate_per_kg,
          movementType: 'PRODUCTION_OUTPUT',
          employeeId: req.user!.id,
        });
        await insertOutput.run(
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
        await db.prepare(
          `INSERT INTO production_batch_expenses (
            batch_id, expense_category, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost, packaging_cost,
            total_amount, payment_status, paid_amount, paid_at, notes, created_by
          ) VALUES (?, 'GENERAL', ?, ?, ?, ?, ?, ?, 'PAID', ?, datetime('now'), ?, ?)`
        ).run(batchId, addLabor, addElec, addFuel, addMach, addPack, addOverhead, addOverhead, 'সমাপনী অতিরিক্ত খরচ', req.user!.id);

        await postJournalEntry({
          description: `Milling Overhead Capitalized - ${batch.batch_no} (${batch.process_type})`,
          referenceType: 'PRODUCTION_BATCH',
          referenceId: batchId,
          employeeId: req.user!.id,
          lines: [
            { accountCode: '1200', debit: addOverhead, credit: 0 },
            { accountCode: '1001', debit: 0, credit: addOverhead },
          ],
        });
      }

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'PRODUCTION_BATCH_COMPLETED',
        entityType: 'PRODUCTION_BATCH',
        entityId: batch.batch_no,
        afterObj: { head_rice_qty_kg: headRiceQty, byproduct_credit: byproductCredit, cost_per_kg: costPerKgHeadRice },
      });

      return { status: 'COMPLETED', batch: await getEnrichedProductionBatch(batchId) };
    })();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/v1/production-batches/:id/expenses', authenticate, requirePermission('production.manage'), async (req: AuthedRequest, res) => {
  const batchId = Number(req.params.id);
  const body = req.body as {
    expense_category?: string;
    vendor_name?: string;
    labor_cost?: number;
    electricity_cost?: number;
    fuel_boiler_cost?: number;
    machinery_overhead_cost?: number;
    packaging_cost?: number;
    payment_timing?: 'PAID' | 'UNPAID' | 'PARTIAL';
    paid_now?: number;
    account_id?: number;
    notes?: string;
  };

  const batch = await db.prepare('SELECT * FROM production_batches WHERE id = ?').get(batchId) as
    | { id: number; batch_no: string; process_type: string; head_rice_qty_kg: number; status: string }
    | undefined;
  if (!batch) {
    res.status(404).json({ error: 'Production batch not found' });
    return;
  }

  const addLabor = Math.max(0, Number(body.labor_cost || 0));
  const addElec = Math.max(0, Number(body.electricity_cost || 0));
  const addFuel = Math.max(0, Number(body.fuel_boiler_cost || 0));
  const addMach = Math.max(0, Number(body.machinery_overhead_cost || 0));
  const addPack = Math.max(0, Number(body.packaging_cost || 0));
  const addTotal = Number((addLabor + addElec + addFuel + addMach + addPack).toFixed(2));

  if (addTotal <= 0) {
    res.status(400).json({ error: 'Enter at least one positive expense amount' });
    return;
  }

  const timing = body.payment_timing === 'UNPAID' || body.payment_timing === 'PARTIAL' ? body.payment_timing : 'PAID';
  const paidNow =
    timing === 'UNPAID'
      ? 0
      : timing === 'PARTIAL'
      ? Math.min(addTotal, Math.max(0, Number(body.paid_now || 0)))
      : addTotal;
  const dueNow = Number((addTotal - paidNow).toFixed(2));
  const payStatus = paidNow <= 0 ? 'UNPAID' : dueNow <= 0.01 ? 'PAID' : 'PARTIAL';

  try {
    const result = await db.transaction(async () => {
      const sheet = await db.prepare('SELECT * FROM production_cost_sheets WHERE batch_id = ?').get(batchId) as {
        raw_paddy_cost: number;
        labor_cost: number;
        electricity_cost: number;
        fuel_boiler_cost: number;
        machinery_overhead_cost: number;
        packaging_cost: number;
        byproduct_credit_value: number;
      };

      const labor = Number(sheet.labor_cost || 0) + addLabor;
      const elec = Number(sheet.electricity_cost || 0) + addElec;
      const fuel = Number(sheet.fuel_boiler_cost || 0) + addFuel;
      const mach = Number(sheet.machinery_overhead_cost || 0) + addMach;
      const pack = Number(sheet.packaging_cost || 0) + addPack;
      const grossBatchCost = Number((Number(sheet.raw_paddy_cost) + labor + elec + fuel + mach + pack).toFixed(2));
      const netHeadRiceCost = Math.max(0, Number((grossBatchCost - Number(sheet.byproduct_credit_value || 0)).toFixed(2)));
      const costPerKgHeadRice = batch.head_rice_qty_kg > 0 ? Number((netHeadRiceCost / batch.head_rice_qty_kg).toFixed(4)) : 0;
      const costPerBagHeadRice = batch.head_rice_qty_kg > 0 ? Number((costPerKgHeadRice * 50).toFixed(2)) : 0;

      await db.prepare(
        `UPDATE production_cost_sheets
         SET labor_cost = ?, electricity_cost = ?, fuel_boiler_cost = ?, machinery_overhead_cost = ?, packaging_cost = ?,
             gross_batch_cost = ?, net_head_rice_cost = ?, cost_per_kg_head_rice = ?, cost_per_bag_head_rice = ?
         WHERE batch_id = ?`
      ).run(labor, elec, fuel, mach, pack, grossBatchCost, netHeadRiceCost, costPerKgHeadRice, costPerBagHeadRice, batchId);

      let payAccountCode = '1001';
      let resolvedAccId: number | null = null;
      if (paidNow > 0) {
        const acc = body.account_id
          ? (await db.prepare('SELECT id, account_code FROM accounts WHERE id = ?').get(body.account_id) as
              | { id: number; account_code: string }
              | undefined)
          : (await db.prepare("SELECT id, account_code FROM accounts WHERE account_code = '1001' LIMIT 1").get() as
              | { id: number; account_code: string }
              | undefined);
        if (!acc) throw new Error('Cash/Bank account not found');
        payAccountCode = acc.account_code;
        resolvedAccId = acc.id;
      }

      const category = String(body.expense_category || 'GENERAL').trim() || 'GENERAL';
      const vendorName = String(body.vendor_name || '').trim();
      const expInfo = await db
        .prepare(
          `INSERT INTO production_batch_expenses (
            batch_id, expense_category, vendor_name, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost, packaging_cost,
            total_amount, payment_status, paid_amount, account_id, paid_at, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${paidNow > 0 ? "datetime('now')" : 'NULL'}, ?, ?)`
        )
        .run(
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
          String(body.notes || '').trim(),
          req.user!.id
        );

      const expenseId = Number(expInfo.lastInsertRowid);
      if (paidNow > 0 && resolvedAccId) {
        const paySeq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM production_expense_payments').get() as { nextId: number }).nextId;
        const receiptNo = `EXPR-2026-${String(paySeq).padStart(4, '0')}`;
        await db.prepare(
          `INSERT INTO production_expense_payments (receipt_no, expense_id, batch_id, account_id, amount, payment_mode, notes, paid_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(receiptNo, expenseId, batchId, resolvedAccId, paidNow, payAccountCode === '1002' ? 'BANK_TRANSFER' : 'CASH', body.notes || 'Initial expense payment', req.user!.id);
      }

      // Ensure Payable account 2002 exists before posting
      await db.prepare(
        "INSERT OR IGNORE INTO accounts (account_code, name, account_type, balance, is_system) VALUES ('2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0, 1)"
      ).run();

      const jeLines: Array<{ accountCode: string; debit: number; credit: number }> = [
        { accountCode: '1200', debit: addTotal, credit: 0 },
      ];
      if (paidNow > 0) jeLines.push({ accountCode: payAccountCode, debit: 0, credit: paidNow });
      if (dueNow > 0) jeLines.push({ accountCode: '2002', debit: 0, credit: dueNow });

      await postJournalEntry({
        description: `Milling Expense (${category}) - ${batch.batch_no}${vendorName ? ` · ${vendorName}` : ''}${body.notes ? ` (${body.notes})` : ''}`,
        referenceType: 'PRODUCTION_BATCH',
        referenceId: batchId,
        employeeId: req.user!.id,
        lines: jeLines,
      });

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'PRODUCTION_EXPENSE_ADDED',
        entityType: 'PRODUCTION_BATCH',
        entityId: batch.batch_no,
        afterObj: { category, vendorName, addTotal, paidNow, dueNow, payStatus, grossBatchCost },
      });

      const updatedBatch = await getEnrichedProductionBatch(batchId);
      return {
        status: 'OK',
        cost_sheet: updatedBatch?.cost_sheet || null,
        expense_logs: updatedBatch?.expense_logs || [],
        batch: updatedBatch,
      };
    })();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// Pay later against an UNPAID or PARTIAL batch expense
app.post('/api/v1/production-batches/:id/expenses/:expId/pay', authenticate, requirePermission('production.manage'), async (req: AuthedRequest, res) => {
  const batchId = Number(req.params.id);
  const expId = Number(req.params.expId);
  const body = req.body as {
    account_id?: number;
    amount?: number;
    payment_mode?: 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'UPI_MOBILE';
    reference_no?: string;
    notes?: string;
  };

  const expense = await db
    .prepare('SELECT * FROM production_batch_expenses WHERE id = ? AND batch_id = ?')
    .get(expId, batchId) as
    | { id: number; batch_id: number; total_amount: number; paid_amount: number; payment_status: string; vendor_name: string; notes: string }
    | undefined;
  if (!expense) {
    res.status(404).json({ error: 'Expense entry not found for this batch' });
    return;
  }

  const batch = await db.prepare('SELECT id, batch_no FROM production_batches WHERE id = ?').get(batchId) as
    | { id: number; batch_no: string }
    | undefined;
  if (!batch) {
    res.status(404).json({ error: 'Production batch not found' });
    return;
  }

  const openDue = Number((Number(expense.total_amount || 0) - Number(expense.paid_amount || 0)).toFixed(2));
  if (openDue <= 0.01) {
    res.status(400).json({ error: 'This expense is already fully paid' });
    return;
  }

  const payAmount = body.amount && Number(body.amount) > 0 ? Math.min(openDue, Number(Number(body.amount).toFixed(2))) : openDue;

  try {
    const result = await db.transaction(async () => {
      const acc = body.account_id
        ? (await db.prepare('SELECT id, account_code, name FROM accounts WHERE id = ?').get(body.account_id) as
            | { id: number; account_code: string; name: string }
            | undefined)
        : (await db.prepare("SELECT id, account_code, name FROM accounts WHERE account_code = '1001' LIMIT 1").get() as
            | { id: number; account_code: string; name: string }
            | undefined);
      if (!acc) throw new Error('Selected payment account not found');

      const nextPaid = Number((Number(expense.paid_amount || 0) + payAmount).toFixed(2));
      const nextStatus = nextPaid >= Number(expense.total_amount) - 0.01 ? 'PAID' : 'PARTIAL';

      await db.prepare(
        `UPDATE production_batch_expenses
         SET paid_amount = ?, payment_status = ?, account_id = ?, paid_at = datetime('now')
         WHERE id = ?`
      ).run(nextPaid, nextStatus, acc.id, expId);

      const paySeq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM production_expense_payments').get() as { nextId: number }).nextId;
      const receiptNo = `EXPR-2026-${String(paySeq).padStart(4, '0')}`;
      const payIns = await db
        .prepare(
          `INSERT INTO production_expense_payments (receipt_no, expense_id, batch_id, account_id, amount, payment_mode, reference_no, notes, paid_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          receiptNo,
          expId,
          batchId,
          acc.id,
          payAmount,
          body.payment_mode || (acc.account_code === '1002' ? 'BANK_TRANSFER' : 'CASH'),
          String(body.reference_no || '').trim(),
          String(body.notes || '').trim() || 'বাকি খরচ পরিশোধ',
          req.user!.id
        );
      const newPayId = Number(payIns.lastInsertRowid);

      await db.prepare(
        "INSERT OR IGNORE INTO accounts (account_code, name, account_type, balance, is_system) VALUES ('2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0, 1)"
      ).run();

      await postJournalEntry({
        description: `Milling Due Expense Paid (${receiptNo}) - ${batch.batch_no}${expense.vendor_name ? ` (${expense.vendor_name})` : ''}`,
        referenceType: 'PRODUCTION_EXPENSE_PAYMENT',
        referenceId: expId,
        employeeId: req.user!.id,
        lines: [
          { accountCode: '2002', debit: payAmount, credit: 0 },
          { accountCode: acc.account_code, debit: 0, credit: payAmount },
        ],
      });

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'PRODUCTION_EXPENSE_PAID',
        entityType: 'PRODUCTION_BATCH',
        entityId: batch.batch_no,
        afterObj: { receipt_no: receiptNo, expense_id: expId, payAmount, nextPaid, nextStatus, account: acc.name },
      });

      const receipt = await db
        .prepare(
          `SELECT pep.*, a.name as account_name, emp.full_name as paid_by_name,
                  pbe.expense_category, pbe.vendor_name, pbe.total_amount as expense_total
           FROM production_expense_payments pep
           JOIN production_batch_expenses pbe ON pbe.id = pep.expense_id
           JOIN accounts a ON a.id = pep.account_id
           LEFT JOIN employees emp ON emp.id = pep.paid_by
           WHERE pep.id = ?`
        )
        .get(newPayId);

      return { status: 'PAID', receipt, batch: await getEnrichedProductionBatch(batchId) };
    })();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// 9B. Supplier Bag Ledger (Jute & Plastic Bags — Advance Issue, Deposit, Pickup)
// ---------------------------------------------------------------------------
app.get('/api/v1/supplier-bags', authenticate, async (req, res) => {
  const supplierIdFilter = req.query.supplier_id ? Number(req.query.supplier_id) : null;

  const summaries = await db
    .prepare(
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
       GROUP BY pt.id, pt.party_code, pt.name, pt.phone, pt.address
       ORDER BY pt.name ASC`
    )
    .all();

  const entries = supplierIdFilter
    ? await db
        .prepare(
          `SELECT sbl.*, pt.name as supplier_name, pt.party_code, e.full_name as created_by_name
           FROM supplier_bag_ledger sbl
           JOIN parties pt ON pt.id = sbl.supplier_id
           LEFT JOIN employees e ON e.id = sbl.created_by
           WHERE sbl.supplier_id = ?
           ORDER BY sbl.entry_date DESC, sbl.id DESC`
        )
        .all(supplierIdFilter)
    : await db
        .prepare(
          `SELECT sbl.*, pt.name as supplier_name, pt.party_code, e.full_name as created_by_name
           FROM supplier_bag_ledger sbl
           JOIN parties pt ON pt.id = sbl.supplier_id
           LEFT JOIN employees e ON e.id = sbl.created_by
           ORDER BY sbl.entry_date DESC, sbl.id DESC
           LIMIT 300`
        )
        .all();

  res.json({ summaries, entries });
});

app.post('/api/v1/supplier-bags', authenticate, async (req: AuthedRequest, res) => {
  const roleCode = req.user?.role_code;
  const perms = req.user?.permissions || [];
  const allowed =
    roleCode === 'OWNER' ||
    roleCode === 'MANAGER' ||
    roleCode === 'GODOWN_KEEPER' ||
    perms.includes('paddy.purchase.create') ||
    perms.includes('purchases.create') ||
    perms.includes('parties.manage');
  if (!allowed) {
    res.status(403).json({ error: 'Permission denied to record supplier bag transactions' });
    return;
  }

  const body = req.body as {
    client_uuid?: string;
    supplier_id: number;
    entry_type: 'ADVANCE_ISSUE' | 'EMPTY_PICKUP' | 'EMPTY_RETURN' | 'PADDY_DEPOSIT';
    jute_qty?: number;
    plastic_qty?: number;
    reference_no?: string;
    entry_date?: string;
    notes?: string;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  const juteQty = Math.max(0, Math.round(Number(body.jute_qty || 0)));
  const plasticQty = Math.max(0, Math.round(Number(body.plastic_qty || 0)));
  const totalQty = juteQty + plasticQty;

  if (!body.supplier_id || totalQty <= 0) {
    res.status(400).json({ error: 'Supplier and at least one Jute or Plastic bag quantity (> 0) are required' });
    return;
  }

  const entryType = body.entry_type || 'ADVANCE_ISSUE';
  const direction = entryType === 'EMPTY_RETURN' || entryType === 'PADDY_DEPOSIT' ? 'IN_FROM_SUPPLIER' : 'OUT_TO_SUPPLIER';
  const entryDate = String(body.entry_date || '').trim() || new Date().toISOString().slice(0, 10);

  try {
    const result = await db.transaction(async () => {
      const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM supplier_bag_ledger').get() as { nextId: number }).nextId;
      const entryNo = `BAG-2026-${String(seq).padStart(4, '0')}`;
      const info = await db
        .prepare(
          `INSERT INTO supplier_bag_ledger (
            client_uuid, entry_no, supplier_id, entry_type, direction,
            jute_qty, plastic_qty, total_qty, reference_type, reference_id, reference_no, entry_date, notes, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'MANUAL', NULL, ?, ?, ?, ?)`
        )
        .run(
          clientUuid,
          entryNo,
          body.supplier_id,
          entryType,
          direction,
          juteQty,
          plasticQty,
          totalQty,
          String(body.reference_no || '').trim(),
          entryDate,
          String(body.notes || '').trim(),
          req.user!.id
        );

      const created = await db
        .prepare(
          `SELECT sbl.*, pt.name as supplier_name, pt.party_code
           FROM supplier_bag_ledger sbl
           JOIN parties pt ON pt.id = sbl.supplier_id
           WHERE sbl.id = ?`
        )
        .get(Number(info.lastInsertRowid));

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: `BAG_${entryType}`,
        entityType: 'SUPPLIER_BAG_LEDGER',
        entityId: entryNo,
        afterObj: { supplier_id: body.supplier_id, direction, juteQty, plasticQty, totalQty },
      });

      const responseObj = { status: 'SYNCED', entry: created };
      await recordSyncLog({
        clientUuid,
        deviceId: 'WEB-BROWSER',
        clientType: 'WEB_PWA',
        endpoint: '/api/v1/supplier-bags',
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.delete('/api/v1/supplier-bags/:id', authenticate, async (req: AuthedRequest, res) => {
  const roleCode = req.user?.role_code;
  const canDelete = roleCode === 'OWNER' || roleCode === 'MANAGER' || (req.user?.permissions || []).includes('parties.manage');
  if (!canDelete) {
    res.status(403).json({ error: 'Permission denied' });
    return;
  }
  const id = Number(req.params.id);
  const existing = await db.prepare('SELECT * FROM supplier_bag_ledger WHERE id = ?').get(id) as
    | { id: number; entry_no: string; reference_type: string | null }
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'Bag ledger entry not found' });
    return;
  }
  if (existing.reference_type === 'PADDY_PURCHASE') {
    res.status(400).json({ error: 'Purchase-linked bag deposits cannot be deleted directly' });
    return;
  }
  await db.prepare('DELETE FROM supplier_bag_ledger WHERE id = ?').run(id);
  res.json({ deleted: true });
});

// ---------------------------------------------------------------------------
// 10. Rice & By-Product Sales Invoices
// ---------------------------------------------------------------------------
app.get('/api/v1/sales-invoices', authenticate, async (req: AuthedRequest, res) => {
  if (rejectPhysicalOnlyUser(req, res)) return;
  const invoices = await db
    .prepare(
      `SELECT s.*, pt.name as customer_name
       FROM sales_invoices s
       JOIN parties pt ON pt.id = s.customer_id
       ORDER BY s.id DESC`
    )
    .all() as Array<Record<string, unknown>>;

  const getLines = db.prepare(
    `SELECT sii.*, i.name as item_name, w.name as warehouse_name
     FROM sales_invoice_items sii
     JOIN items i ON i.id = sii.item_id
     JOIN warehouses w ON w.id = sii.warehouse_id
     WHERE sii.invoice_id = ?`
  );

  const enrichedInvoices = await Promise.all(
    invoices.map(async (inv) => ({
      ...inv,
      items: await getLines.all(inv.id as number),
    }))
  );

  res.json({
    invoices: enrichedInvoices,
  });
});

app.post('/api/v1/sales-invoices', authenticate, requirePermission('rice.sale.create'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    client_uuid?: string;
    device_id?: string;
    client_type?: 'WEB_PWA' | 'ANDROID_APP';
    customer_id: number;
    vehicle_no?: string;
    discount_amount?: number;
    tax_amount?: number;
    paid_amount?: number;
    items: Array<{
      item_id: number;
      warehouse_id: number;
      bag_count?: number;
      pack_size_kg?: number;
      rate_per_bag?: number;
      qty_kg: number;
      preferred_lot_id?: number;
      preferred_batch_id?: number;
      rate_per_kg: number;
      costing_method?: CostingMethod;
    }>;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  if (!body.customer_id || !body.items?.length) {
    res.status(400).json({ error: 'Customer and at least one invoice line item are required' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM sales_invoices').get() as { nextId: number }).nextId;
      const invoiceNo = `INV-2026-${String(seq).padStart(4, '0')}`;
      const qrUid = crypto.randomUUID();

      const getItemBagWeight = db.prepare('SELECT bag_weight_kg FROM items WHERE id = ?');
      const getLotPackSize = db.prepare('SELECT pack_size_kg FROM inventory_lots WHERE id = ?');

      const resolvedLines: Array<{
        item_id: number;
        warehouse_id: number;
        bag_count?: number;
        pack_size_kg?: number;
        rate_per_bag?: number;
        qty_kg: number;
        preferred_lot_id?: number;
        preferred_batch_id?: number;
        rate_per_kg: number;
        costing_method?: CostingMethod;
        bagCount: number;
        packSizeKg: number;
        ratePerBag: number;
        qtyKg: number;
        ratePerKg: number;
        lineTotal: number;
      }> = [];
      for (const line of body.items) {
        const bagCount = Math.max(0, Math.round(Number(line.bag_count || 0)));
        const lotInfo = line.preferred_lot_id
          ? ((await getLotPackSize.get(line.preferred_lot_id)) as { pack_size_kg?: number } | undefined)
          : undefined;
        const itemInfo = (await getItemBagWeight.get(line.item_id)) as { bag_weight_kg?: number } | undefined;
        const packSizeKg =
          Number(line.pack_size_kg || 0) > 0
            ? Number(line.pack_size_kg)
            : Number(lotInfo?.pack_size_kg || 0) > 0
            ? Number(lotInfo!.pack_size_kg)
            : Number(itemInfo?.bag_weight_kg || 50) || 50;

        const ratePerBagInput = Number(line.rate_per_bag || 0);
        const qtyKg =
          Number(line.qty_kg || 0) > 0
            ? Number(line.qty_kg)
            : Number((bagCount * packSizeKg).toFixed(3));
        if (qtyKg <= 0) {
          throw new Error('Line item weight / bag quantity must be greater than zero');
        }

        const usesBagPricing = bagCount > 0 && ratePerBagInput > 0;
        const lineTotal = usesBagPricing
          ? Number((bagCount * ratePerBagInput).toFixed(2))
          : Number((qtyKg * Number(line.rate_per_kg || 0)).toFixed(2));
        const ratePerKg = usesBagPricing
          ? Number((lineTotal / qtyKg).toFixed(4))
          : Number(line.rate_per_kg || 0);
        const ratePerBag = usesBagPricing
          ? ratePerBagInput
          : bagCount > 0
          ? Number((lineTotal / bagCount).toFixed(2))
          : 0;

        resolvedLines.push({
          ...line,
          bagCount,
          packSizeKg,
          ratePerBag,
          qtyKg,
          ratePerKg,
          lineTotal,
        });
      }

      const subtotal = Number(resolvedLines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2));
      const tax = Number(body.tax_amount || 0);
      const discount = Number(body.discount_amount || 0);
      const totalAmount = Math.max(0, Number((subtotal + tax - discount).toFixed(2)));
      const paidAmt = Math.min(totalAmount, Math.max(0, Number(body.paid_amount || 0)));
      const payStatus = paidAmt <= 0 ? 'UNPAID' : paidAmt >= totalAmount ? 'PAID' : 'PARTIAL';

      const info = await db
        .prepare(
          `INSERT INTO sales_invoices (
            client_uuid, invoice_no, customer_id, subtotal_amount, tax_amount, discount_amount,
            total_amount, total_cogs, paid_amount, payment_status, vehicle_no, qr_code_uid, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
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
          body.vehicle_no || '',
          qrUid,
          req.user!.id
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
        const cm = line.costing_method || 'FIFO';
        const consumed = await consumeWarehouseStock({
          itemId: line.item_id,
          warehouseId: line.warehouse_id,
          qtyKg: line.qtyKg,
          bagCount: line.bagCount > 0 ? line.bagCount : undefined,
          preferredLotId: line.preferred_lot_id,
          preferredBatchId: line.preferred_batch_id,
          costingMethod: cm,
          movementType: 'RICE_SALE_OUT',
          referenceType: 'SALES_INVOICE',
          referenceId: invoiceId,
          employeeId: req.user!.id,
        });
        const lineInfo = await insertLine.run(
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
          const linkedBatchId =
            lotDetail.origin_batch_id != null
              ? Number(lotDetail.origin_batch_id)
              : lotDetail.source_type === 'PRODUCTION_OUTPUT' && lotDetail.source_id
                ? Number(lotDetail.source_id)
                : null;
          const isLast = idx === consumed.consumedLots.length - 1;
          const saleAmt = isLast
            ? Number((line.lineTotal - allocatedSaleTotal).toFixed(2))
            : Number(((lotDetail.qty_taken_kg / line.qtyKg) * line.lineTotal).toFixed(2));
          allocatedSaleTotal += saleAmt;
          const costAmt = Number(lotDetail.cost_amount.toFixed(2));
          const profitAmt = Number((saleAmt - costAmt).toFixed(2));
          await insertLotAlloc.run(
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

      await db.prepare('UPDATE sales_invoices SET total_cogs = ? WHERE id = ?').run(Number(totalCogs.toFixed(2)), invoiceId);
      const dueAmt = totalAmount - paidAmt;
      await db.prepare('UPDATE parties SET current_balance = current_balance + ? WHERE id = ?').run(dueAmt, body.customer_id);

      const jeLines = [
        { accountCode: '1100', debit: dueAmt, credit: 0, partyId: body.customer_id },
        { accountCode: '4001', debit: 0, credit: totalAmount },
        { accountCode: '5001', debit: totalCogs, credit: 0 },
        { accountCode: '1200', debit: 0, credit: totalCogs },
      ];
      if (paidAmt > 0) jeLines.push({ accountCode: '1001', debit: paidAmt, credit: 0, partyId: body.customer_id });
      await postJournalEntry({
        description: `Sales Invoice ${invoiceNo}`,
        referenceType: 'SALES_INVOICE',
        referenceId: invoiceId,
        employeeId: req.user!.id,
        lines: jeLines,
      });

      const cust = await db.prepare('SELECT name FROM parties WHERE id = ?').get(body.customer_id) as { name: string };
      await registerQrTag({
        qrCodeUid: qrUid,
        entityType: 'SALES_INVOICE',
        entityId: invoiceId,
        entityCode: invoiceNo,
        payload: { invoice_no: invoiceNo, customer: cust.name, total: totalAmount, vehicle: body.vehicle_no || '' },
      });

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'SALES_INVOICE_CREATED',
        entityType: 'SALES_INVOICE',
        entityId: invoiceNo,
        afterObj: { customer: cust.name, total_amount: totalAmount, total_cogs: totalCogs },
        deviceType: body.client_type || 'WEB_PWA',
      });

      const created = await db
        .prepare('SELECT s.*, pt.name as customer_name FROM sales_invoices s JOIN parties pt ON pt.id = s.customer_id WHERE s.id = ?')
        .get(invoiceId) as Record<string, unknown>;
      const lineItems = await db
        .prepare(
          `SELECT sii.*, i.name as item_name, w.name as warehouse_name
           FROM sales_invoice_items sii
           JOIN items i ON i.id = sii.item_id
           JOIN warehouses w ON w.id = sii.warehouse_id
           WHERE sii.invoice_id = ?`
        )
        .all(invoiceId);
      const responseObj = { status: 'SYNCED', invoice: { ...created, items: lineItems } };
      await recordSyncLog({
        clientUuid,
        deviceId: body.device_id || 'WEB-BROWSER',
        clientType: body.client_type || 'WEB_PWA',
        endpoint: '/api/v1/sales-invoices',
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InsufficientStockError) {
      await recordSyncLog({
        clientUuid,
        deviceId: body.device_id || 'WEB-BROWSER',
        clientType: body.client_type || 'WEB_PWA',
        endpoint: '/api/v1/sales-invoices',
        status: 'CONFLICT',
        conflictReason: err.message,
        employeeId: req.user!.id,
      });
      res.status(409).json({ error: err.message, code: 'INSUFFICIENT_STOCK' });
      return;
    }
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// 11. Weighbridge Scale Logs & QR Traceability Lookup
// ---------------------------------------------------------------------------
app.get('/api/v1/weighbridge-logs', authenticate, async (_req, res) => {
  const logs = await db
    .prepare(
      `SELECT wl.*, e.full_name as operator_name
       FROM weighbridge_logs wl
       JOIN employees e ON e.id = wl.operator_id
       ORDER BY wl.id DESC LIMIT 100`
    )
    .all();
  res.json({ logs });
});

app.post('/api/v1/weighbridge-logs', authenticate, requirePermission('weighbridge.operate'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    client_uuid?: string;
    vehicle_no: string;
    driver_name?: string;
    gross_weight_kg: number;
    tare_weight_kg: number;
    device_mode: 'MANUAL' | 'USB_SERIAL' | 'BLUETOOTH_SPP';
    raw_device_string?: string;
  };
  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  const net = Number((body.gross_weight_kg - body.tare_weight_kg).toFixed(3));
  if (net <= 0) {
    res.status(400).json({ error: 'Net weight (Gross - Tare) must be positive' });
    return;
  }

  const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM weighbridge_logs').get() as { nextId: number }).nextId;
  const ticketNo = `WB-2026-${String(100 + seq).padStart(4, '0')}`;

  const info = await db
    .prepare(
      `INSERT INTO weighbridge_logs (client_uuid, ticket_no, vehicle_no, driver_name, gross_weight_kg, tare_weight_kg, net_weight_kg, device_mode, raw_device_string, operator_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      clientUuid,
      ticketNo,
      body.vehicle_no.trim().toUpperCase(),
      body.driver_name || '',
      body.gross_weight_kg,
      body.tare_weight_kg,
      net,
      body.device_mode || 'MANUAL',
      body.raw_device_string || 'MANUAL_ENTRY',
      req.user!.id
    );

  const created = await db
    .prepare('SELECT wl.*, e.full_name as operator_name FROM weighbridge_logs wl JOIN employees e ON e.id = wl.operator_id WHERE wl.id = ?')
    .get(info.lastInsertRowid);
  const responseObj = { status: 'SYNCED', log: created };
  await recordSyncLog({
    clientUuid,
    deviceId: 'WEIGHBRIDGE-TERMINAL',
    clientType: 'WEB_PWA',
    endpoint: '/api/v1/weighbridge-logs',
    status: 'SYNCED',
    responseObj,
    employeeId: req.user!.id,
  });
  res.status(201).json(responseObj);
});

app.get('/api/v1/qr/lookup', authenticate, async (req: AuthedRequest, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) {
    res.status(400).json({ error: 'QR UID or entity code is required' });
    return;
  }
  const physicalOnly = isPhysicalOnlyUser(req.user);

  const tag = await db
    .prepare('SELECT * FROM qr_tags WHERE qr_code_uid = ? OR entity_code = ? LIMIT 1')
    .get(code, code) as { qr_code_uid: string; entity_type: string; entity_id: number; entity_code: string; payload_json: string; created_at: string } | undefined;

  if (tag) {
    if (physicalOnly && ['SALES_INVOICE', 'PADDY_SALE', 'PRODUCTION_BATCH'].includes(tag.entity_type)) {
      res.status(403).json({ error: 'Commercial dispatch and milling cost QR records are restricted for Godown Keeper' });
      return;
    }

    const parsedPayload = JSON.parse(tag.payload_json);
    res.json({
      qr_code_uid: tag.qr_code_uid,
      entity_type: tag.entity_type,
      entity_id: tag.entity_id,
      entity_code: tag.entity_code,
      payload: physicalOnly ? sanitizeQrPayloadForPhysical(parsedPayload) : parsedPayload,
      created_at: tag.created_at,
    });
    return;
  }

  // Fallback: resolve any stock batch directly from inventory_lots using qr_code_uid or lot_code
  const lot = await db
    .prepare(
      `SELECT l.*, i.name as item_name, i.sku, i.category, i.process_grade, i.bag_weight_kg,
              w.name as warehouse_name, w.code as warehouse_code,
              pb.batch_no as origin_batch_no, pb.dryer_no as origin_dryer_no
       FROM inventory_lots l
       JOIN items i ON i.id = l.item_id
       JOIN warehouses w ON w.id = l.warehouse_id
       LEFT JOIN production_batches pb ON pb.id = COALESCE(l.origin_batch_id, CASE WHEN l.source_type = 'PRODUCTION_OUTPUT' THEN l.source_id ELSE NULL END)
       WHERE l.qr_code_uid = ? OR l.lot_code = ?
       LIMIT 1`
    )
    .get(code, code) as Record<string, unknown> | undefined;

  if (!lot) {
    res.status(404).json({ error: `No lot, batch, or dispatch record found for QR "${code}"` });
    return;
  }

  const lotPayload: Record<string, unknown> = {
    lot_code: lot.lot_code,
    item: lot.item_name,
    sku: lot.sku,
    category: lot.category,
    process_grade: lot.process_grade,
    warehouse: `${lot.warehouse_name} (${lot.warehouse_code})`,
    source_type: lot.source_type,
    ...(lot.origin_batch_no ? { origin_batch_no: lot.origin_batch_no } : {}),
    ...(lot.origin_dryer_no ? { origin_dryer_no: lot.origin_dryer_no } : {}),
    remaining_qty_kg: Number(lot.remaining_qty_kg || 0),
    initial_qty_kg: Number(lot.initial_qty_kg || 0),
    remaining_bags: Number(lot.remaining_bags || 0),
    pack_size_kg: Number(lot.pack_size_kg || lot.bag_weight_kg || 50),
    ...(lot.moisture_pct !== null && lot.moisture_pct !== undefined ? { moisture_pct: Number(lot.moisture_pct) } : {}),
    unit_cost_per_kg: Number(lot.unit_cost_per_kg || 0),
    received_at: lot.received_at,
  };

  res.json({
    qr_code_uid: String(lot.qr_code_uid),
    entity_type: 'LOT',
    entity_id: Number(lot.id),
    entity_code: String(lot.lot_code),
    payload: physicalOnly ? sanitizeQrPayloadForPhysical(lotPayload) : lotPayload,
    created_at: String(lot.received_at),
  });
});

app.get('/api/v1/qr/registry', authenticate, async (req: AuthedRequest, res) => {
  const physicalOnly = isPhysicalOnlyUser(req.user);
  const rows = await db.prepare('SELECT * FROM qr_tags ORDER BY created_at DESC LIMIT 50').all() as Array<{
    qr_code_uid: string;
    entity_type: string;
    entity_id: number;
    entity_code: string;
    payload_json: string;
    created_at: string;
  }>;
  const filteredRows = physicalOnly
    ? rows.filter((r) => !['SALES_INVOICE', 'PADDY_SALE', 'PRODUCTION_BATCH'].includes(r.entity_type))
    : rows;
  res.json({
    tags: filteredRows.map((r) => {
      const parsed = JSON.parse(r.payload_json);
      const safePayload = physicalOnly ? sanitizeQrPayloadForPhysical(parsed) : parsed;
      return {
        ...r,
        payload_json: JSON.stringify(safePayload),
        payload: safePayload,
      };
    }),
  });
});

// ---------------------------------------------------------------------------
// 12. Cash, Bank & Double-Entry Accounting
// ---------------------------------------------------------------------------
app.get('/api/v1/accounting', authenticate, requirePermission('accounting.view'), async (_req, res) => {
  const accounts = await db.prepare('SELECT * FROM accounts ORDER BY account_code ASC').all();
  const payments = await db
    .prepare(
      `SELECT pay.*, pt.name as party_name, pt.party_code, pt.party_type, a.name as account_name
       FROM payments pay
       JOIN parties pt ON pt.id = pay.party_id
       JOIN accounts a ON a.id = pay.account_id
       ORDER BY pay.id DESC LIMIT 200`
    )
    .all();
  const entries = await db.prepare('SELECT * FROM journal_entries ORDER BY id DESC LIMIT 150').all() as Array<Record<string, unknown>>;
  const getLines = db.prepare(
    `SELECT jl.account_id, jl.debit, jl.credit, a.account_code, a.name as account_name
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.journal_entry_id = ?`
  );
  const enrichedEntries = await Promise.all(
    entries.map(async (e) => ({ ...e, lines: await getLines.all(e.id as number) }))
  );
  res.json({
    accounts,
    payments,
    journal_entries: enrichedEntries,
  });
});

app.get('/api/v1/accounting/statements', authenticate, requirePermission('accounting.view'), async (_req, res) => {
  const accounts = await db.prepare('SELECT * FROM accounts ORDER BY account_code ASC').all() as Array<{
    id: number;
    account_code: string;
    name: string;
    account_type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
    balance: number;
    is_system: number;
  }>;

  let tbDebitTotal = 0;
  let tbCreditTotal = 0;
  const tbRows = accounts.map((a) => {
    const bal = Number(a.balance || 0);
    const isDebitNormal = a.account_type === 'ASSET' || a.account_type === 'EXPENSE';
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
      credit_balance: Number(creditBal.toFixed(2)),
    };
  });

  const revenues = accounts.filter((a) => a.account_type === 'REVENUE');
  const totalRevenue = revenues.reduce((s, a) => s + Number(a.balance || 0), 0);

  const cogs = accounts.filter((a) => a.account_type === 'EXPENSE' && a.account_code === '5001');
  const totalCogs = cogs.reduce((s, a) => s + Number(a.balance || 0), 0);
  const grossProfit = totalRevenue - totalCogs;

  const expenses = accounts.filter((a) => a.account_type === 'EXPENSE' && a.account_code !== '5001');
  const totalExpenses = expenses.reduce((s, a) => s + Number(a.balance || 0), 0);
  const netProfit = grossProfit - totalExpenses;

  const assets = accounts.filter((a) => a.account_type === 'ASSET');
  const totalAssets = assets.reduce((s, a) => s + Number(a.balance || 0), 0);

  const liabilities = accounts.filter((a) => a.account_type === 'LIABILITY');
  const totalLiabilities = liabilities.reduce((s, a) => s + Number(a.balance || 0), 0);

  const equity = accounts.filter((a) => a.account_type === 'EQUITY');
  const totalEquity = equity.reduce((s, a) => s + Number(a.balance || 0), 0);
  const totalLiabAndEq = totalLiabilities + totalEquity + netProfit;

  res.json({
    trial_balance: {
      rows: tbRows,
      total_debit: Number(tbDebitTotal.toFixed(2)),
      total_credit: Number(tbCreditTotal.toFixed(2)),
      is_balanced: Math.abs(tbDebitTotal - tbCreditTotal) < 0.05,
    },
    profit_and_loss: {
      revenues,
      total_revenue: Number(totalRevenue.toFixed(2)),
      cogs,
      total_cogs: Number(totalCogs.toFixed(2)),
      gross_profit: Number(grossProfit.toFixed(2)),
      expenses,
      total_expenses: Number(totalExpenses.toFixed(2)),
      net_profit: Number(netProfit.toFixed(2)),
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
      is_balanced: Math.abs(totalAssets - totalLiabAndEq) < 0.05,
    },
  });
});

app.get('/api/v1/accounting/cashbook', authenticate, requirePermission('accounting.view'), async (req, res) => {
  const fromRaw = typeof req.query.from === 'string' ? req.query.from.trim() : '';
  const toRaw = typeof req.query.to === 'string' ? req.query.to.trim() : '';
  const accountParam = typeof req.query.account_id === 'string' ? req.query.account_id.trim() : 'ALL';
  const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;

  if ((fromRaw && !isoDateRe.test(fromRaw)) || (toRaw && !isoDateRe.test(toRaw))) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }

  let cashBankAccounts = await db
    .prepare(
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
    )
    .all() as Array<{
    id: number;
    account_code: string;
    name: string;
    account_type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
    balance: number;
    is_system: number;
  }>;

  if (cashBankAccounts.length === 0) {
    cashBankAccounts = await db
      .prepare(`SELECT * FROM accounts WHERE account_code IN ('1001', '1002') ORDER BY account_code ASC`)
      .all() as typeof cashBankAccounts;
  }

  let targetIds = cashBankAccounts.map((a) => a.id);
  let selectedAccountId: number | 'ALL' = 'ALL';

  if (accountParam && accountParam !== 'ALL') {
    const parsedId = Number(accountParam);
    if (!Number.isInteger(parsedId) || parsedId <= 0) {
      res.status(400).json({ error: 'Invalid account_id parameter.' });
      return;
    }
    const found = cashBankAccounts.find((a) => a.id === parsedId);
    if (!found) {
      res.status(404).json({ error: 'Cash/Bank account not found.' });
      return;
    }
    targetIds = [found.id];
    selectedAccountId = found.id;
  }

  let openingBalance = 0;
  let rows: Array<{
    id: number;
    journal_entry_id: number;
    account_id: number;
    account_code: string;
    account_name: string;
    voucher_no: string;
    entry_date: string;
    description: string;
    reference_type?: string;
    created_at?: string;
    debit: number;
    credit: number;
  }> = [];

  if (targetIds.length > 0) {
    const placeholders = targetIds.map(() => '?').join(', ');

    if (fromRaw) {
      const openRow = await db
        .prepare(
          `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) as bal
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.journal_entry_id
           WHERE jl.account_id IN (${placeholders}) AND date(je.entry_date) < date(?)`
        )
        .get(...targetIds, fromRaw) as { bal: number };
      openingBalance = Number(Number(openRow?.bal || 0).toFixed(2));
    }

    const whereParts: string[] = [`jl.account_id IN (${placeholders})`];
    const params: Array<number | string> = [...targetIds];
    if (fromRaw) {
      whereParts.push('date(je.entry_date) >= date(?)');
      params.push(fromRaw);
    }
    if (toRaw) {
      whereParts.push('date(je.entry_date) <= date(?)');
      params.push(toRaw);
    }

    rows = await db
      .prepare(
        `SELECT jl.id, jl.journal_entry_id, jl.account_id, a.account_code, a.name as account_name,
                je.voucher_no, je.entry_date, je.description, je.reference_type, je.created_at,
                jl.debit, jl.credit
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id
         JOIN accounts a ON a.id = jl.account_id
         WHERE ${whereParts.join(' AND ')}
         ORDER BY date(je.entry_date) ASC, je.id ASC, jl.id ASC`
      )
      .all(...params) as typeof rows;
  }

  const contraStmt = db.prepare(
    `SELECT a.account_code, a.name as account_name
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.journal_entry_id = ? AND jl.id != ?`
  );
  const contraCache = new Map<string, string>();

  let running = openingBalance;
  let totalReceipts = 0;
  let totalPayments = 0;

  const entries: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const receipt = Number(r.debit || 0);
    const payment = Number(r.credit || 0);
    totalReceipts += receipt;
    totalPayments += payment;
    running = Number((running + receipt - payment).toFixed(2));

    const cacheKey = `${r.journal_entry_id}:${r.id}`;
    let contraHead = contraCache.get(cacheKey);
    if (contraHead === undefined) {
      const others = (await contraStmt.all(r.journal_entry_id, r.id)) as Array<{ account_code: string; account_name: string }>;
      contraHead = others.map((o) => `${o.account_code} ${o.account_name}`).join(', ');
      contraCache.set(cacheKey, contraHead);
    }

    entries.push({
      id: r.id,
      journal_entry_id: r.journal_entry_id,
      account_id: r.account_id,
      account_code: r.account_code,
      account_name: r.account_name,
      voucher_no: r.voucher_no,
      entry_date: r.entry_date,
      description: r.description,
      contra_head: contraHead,
      reference_type: r.reference_type || '',
      created_at: r.created_at || r.entry_date,
      receipt: Number(receipt.toFixed(2)),
      payment: Number(payment.toFixed(2)),
      running_balance: running,
    });
  }

  // Compute Cash vs Bank closing breakdown up to `toRaw` (or live if no `toRaw`)
  let cashClosing = 0;
  let bankClosing = 0;
  const balStmt = toRaw
    ? db.prepare(
        `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) as bal
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id
         WHERE jl.account_id = ? AND date(je.entry_date) <= date(?)`
      )
    : null;

  for (const acc of cashBankAccounts) {
    const bal = toRaw
      ? Number(((await balStmt!.get(acc.id, toRaw) as { bal: number })?.bal || 0).toFixed(2))
      : Number(acc.balance || 0);
    const isCashAcc = acc.account_code === '1001' || /cash|petty/i.test(acc.name);
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
    entries,
  });
});

app.get('/api/v1/accounts/:id/ledger', authenticate, requirePermission('accounting.view'), async (req, res) => {
  const accountId = Number(req.params.id);
  const fromRaw = typeof req.query.from === 'string' ? req.query.from.trim() : '';
  const toRaw = typeof req.query.to === 'string' ? req.query.to.trim() : '';
  const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;

  if ((fromRaw && !isoDateRe.test(fromRaw)) || (toRaw && !isoDateRe.test(toRaw))) {
    res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
    return;
  }

  const account = await db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as
    | { id: number; account_code: string; name: string; account_type: string; balance: number }
    | undefined;
  if (!account) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }

  const isDebitNormal = account.account_type === 'ASSET' || account.account_type === 'EXPENSE';

  let openingBalance = 0;
  if (fromRaw) {
    const openRow = await db
      .prepare(
        `SELECT COALESCE(SUM(jl.debit), 0) as dr, COALESCE(SUM(jl.credit), 0) as cr
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journal_entry_id
         WHERE jl.account_id = ? AND date(je.entry_date) < date(?)`
      )
      .get(accountId, fromRaw) as { dr: number; cr: number };
    const dr = Number(openRow?.dr || 0);
    const cr = Number(openRow?.cr || 0);
    openingBalance = Number((isDebitNormal ? dr - cr : cr - dr).toFixed(2));
  }

  const whereParts: string[] = ['jl.account_id = ?'];
  const params: Array<number | string> = [accountId];
  if (fromRaw) {
    whereParts.push('date(je.entry_date) >= date(?)');
    params.push(fromRaw);
  }
  if (toRaw) {
    whereParts.push('date(je.entry_date) <= date(?)');
    params.push(toRaw);
  }

  const rows = await db
    .prepare(
      `SELECT jl.id, jl.journal_entry_id, je.voucher_no, je.entry_date, je.description, je.reference_type, jl.debit, jl.credit
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journal_entry_id
       WHERE ${whereParts.join(' AND ')}
       ORDER BY date(je.entry_date) ASC, je.id ASC, jl.id ASC`
    )
    .all(...params) as Array<{
    id: number;
    journal_entry_id: number;
    voucher_no: string;
    entry_date: string;
    description: string;
    reference_type?: string;
    debit: number;
    credit: number;
  }>;

  const contraStmt = db.prepare(
    `SELECT a.account_code, a.name as account_name
     FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id
     WHERE jl.journal_entry_id = ? AND jl.id != ?`
  );

  let running = openingBalance;
  let totalDebit = 0;
  let totalCredit = 0;
  const ledger: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    const dr = Number(r.debit || 0);
    const cr = Number(r.credit || 0);
    totalDebit += dr;
    totalCredit += cr;
    running = Number((running + (isDebitNormal ? dr - cr : cr - dr)).toFixed(2));
    const others = (await contraStmt.all(r.journal_entry_id, r.id)) as Array<{ account_code: string; account_name: string }>;
    ledger.push({
      ...r,
      contra_head: others.map((o) => `${o.account_code} ${o.account_name}`).join(', '),
      running_balance: running,
    });
  }

  res.json({
    account,
    from: fromRaw || null,
    to: toRaw || null,
    opening_balance: openingBalance,
    total_debit: Number(totalDebit.toFixed(2)),
    total_credit: Number(totalCredit.toFixed(2)),
    closing_balance: running,
    entries: ledger,
  });
});

app.post('/api/v1/accounts', authenticate, requirePermission('accounting.post'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    account_code: string;
    name: string;
    account_type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
    opening_balance?: number;
  };

  const code = String(body.account_code || '').trim().toUpperCase();
  const name = String(body.name || '').trim();
  const validTypes = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

  if (!code || !name || !validTypes.includes(body.account_type)) {
    res.status(400).json({ error: 'Account code, name, and valid account type are required' });
    return;
  }

  try {
    const created = await db.transaction(async () => {
      const existing = await db.prepare('SELECT id FROM accounts WHERE account_code = ?').get(code);
      if (existing) throw new Error(`Account code ${code} already exists`);

      const info = await db
        .prepare('INSERT INTO accounts (account_code, name, account_type, balance, is_system) VALUES (?, ?, ?, 0, 0)')
        .run(code, name, body.account_type);
      const accountId = Number(info.lastInsertRowid);

      const opening = Number(body.opening_balance || 0);
      if (opening > 0 && code !== '3001') {
        const isDebitNormal = body.account_type === 'ASSET' || body.account_type === 'EXPENSE';
        await postJournalEntry({
          description: `Opening Balance — ${code} ${name}`,
          referenceType: 'OPENING_BALANCE',
          referenceId: accountId,
          employeeId: req.user!.id,
          lines: isDebitNormal
            ? [
                { accountCode: code, debit: opening, credit: 0 },
                { accountCode: '3001', debit: 0, credit: opening },
              ]
            : [
                { accountCode: '3001', debit: opening, credit: 0 },
                { accountCode: code, debit: 0, credit: opening },
              ],
        });
      }

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'GL_ACCOUNT_CREATED',
        entityType: 'ACCOUNT',
        entityId: code,
        afterObj: { code, name, account_type: body.account_type, opening_balance: opening },
      });

      return await db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
    })();
    res.status(201).json({ account: created });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.put('/api/v1/accounts/:id', authenticate, requirePermission('accounting.post'), async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  const body = req.body as { name?: string };
  const name = String(body.name || '').trim();
  if (!name) {
    res.status(400).json({ error: 'Account name is required' });
    return;
  }
  const acc = await db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as { id: number; account_code: string; name: string } | undefined;
  if (!acc) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }
  await db.prepare('UPDATE accounts SET name = ? WHERE id = ?').run(name, id);
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: 'GL_ACCOUNT_UPDATED',
    entityType: 'ACCOUNT',
    entityId: acc.account_code,
    beforeObj: { name: acc.name },
    afterObj: { name },
  });
  res.json({ account: await db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) });
});

app.post('/api/v1/payments', authenticate, requirePermission('accounting.post'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    client_uuid?: string;
    direction?: 'RECEIPT' | 'PAYMENT';
    voucher_type?: 'DUE_PAYMENT' | 'ADVANCE_PAYMENT' | 'DUE_RECEIPT' | 'ADVANCE_RECEIPT' | 'DUE_SETTLEMENT';
    party_id: number;
    account_id: number;
    amount: number;
    payment_mode: 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'UPI_MOBILE';
    reference_no?: string;
    settled_ref_no?: string;
    notes?: string;
  };
  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  if (!body.party_id || !body.account_id || Number(body.amount) <= 0) {
    res.status(400).json({ error: 'Party, account, and positive payment amount are required' });
    return;
  }

  const voucherType =
    body.voucher_type ||
    (body.direction === 'RECEIPT' ? 'DUE_RECEIPT' : 'DUE_PAYMENT');
  const direction: 'RECEIPT' | 'PAYMENT' =
    voucherType === 'DUE_RECEIPT' || voucherType === 'ADVANCE_RECEIPT'
      ? 'RECEIPT'
      : voucherType === 'DUE_PAYMENT' || voucherType === 'ADVANCE_PAYMENT'
      ? 'PAYMENT'
      : body.direction === 'RECEIPT'
      ? 'RECEIPT'
      : 'PAYMENT';

  try {
    const result = await db.transaction(async () => {
      const party = await db.prepare('SELECT id, name, party_type FROM parties WHERE id = ?').get(body.party_id) as
        | { id: number; name: string; party_type: string }
        | undefined;
      if (!party) throw new Error('Selected customer/supplier does not exist');

      const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM payments').get() as { nextId: number }).nextId;
      const prefix =
        voucherType === 'ADVANCE_RECEIPT' || voucherType === 'ADVANCE_PAYMENT'
          ? direction === 'RECEIPT'
            ? 'AVR'
            : 'AVP'
          : direction === 'RECEIPT'
          ? 'RCP'
          : 'PAY';
      const paymentNo = `${prefix}-2026-${String(seq).padStart(4, '0')}`;
      const acc = await db.prepare('SELECT account_code, name FROM accounts WHERE id = ?').get(body.account_id) as
        | { account_code: string; name: string }
        | undefined;
      if (!acc) throw new Error('Invalid cash/bank account');

      const amount = Number(Number(body.amount).toFixed(2));
      const settledRefs: string[] = [];

      // Allocate due settlement against pending bills when settling due (targeted ref first, then FIFO oldest)
      if (voucherType === 'DUE_PAYMENT') {
        let rem = amount;
        const targetRef = body.settled_ref_no?.trim();
        const purchases = await db
          .prepare(
            `SELECT id, purchase_no, total_payable, paid_amount
             FROM paddy_purchases
             WHERE supplier_id = ? AND payment_status != 'PAID'
             ORDER BY CASE WHEN purchase_no = ? THEN 0 ELSE 1 END, created_at ASC, id ASC`
          )
          .all(body.party_id, targetRef || '') as Array<{
          id: number;
          purchase_no: string;
          total_payable: number;
          paid_amount: number;
        }>;
        for (const p of purchases) {
          if (rem <= 0.01) break;
          if (targetRef && p.purchase_no !== targetRef) continue;
          const openAmt = Number((p.total_payable - p.paid_amount).toFixed(2));
          if (openAmt <= 0) continue;
          const alloc = Math.min(rem, openAmt);
          const nextPaid = Number((p.paid_amount + alloc).toFixed(2));
          const nextStatus = nextPaid >= p.total_payable - 0.01 ? 'PAID' : 'PARTIAL';
          await db.prepare('UPDATE paddy_purchases SET paid_amount = ?, payment_status = ? WHERE id = ?').run(nextPaid, nextStatus, p.id);
          settledRefs.push(p.purchase_no);
          rem = Number((rem - alloc).toFixed(2));
        }
      } else if (voucherType === 'DUE_RECEIPT') {
        let rem = amount;
        const targetRef = body.settled_ref_no?.trim();
        const openSales = [
          ...(await db
            .prepare(
              `SELECT 'INV' as kind, id, invoice_no as ref_no, total_amount, paid_amount, created_at
               FROM sales_invoices WHERE customer_id = ? AND payment_status != 'PAID'`
            )
            .all(body.party_id) as Array<{ kind: 'INV'; id: number; ref_no: string; total_amount: number; paid_amount: number; created_at: string }>),
          ...(await db
            .prepare(
              `SELECT 'PDS' as kind, id, sale_no as ref_no, total_amount, paid_amount, created_at
               FROM paddy_sales WHERE customer_id = ? AND payment_status != 'PAID'`
            )
            .all(body.party_id) as Array<{ kind: 'PDS'; id: number; ref_no: string; total_amount: number; paid_amount: number; created_at: string }>),
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
          const nextStatus = nextPaid >= s.total_amount - 0.01 ? 'PAID' : 'PARTIAL';
          if (s.kind === 'INV') {
            await db.prepare('UPDATE sales_invoices SET paid_amount = ?, payment_status = ? WHERE id = ?').run(nextPaid, nextStatus, s.id);
          } else {
            await db.prepare('UPDATE paddy_sales SET paid_amount = ?, payment_status = ? WHERE id = ?').run(nextPaid, nextStatus, s.id);
          }
          settledRefs.push(s.ref_no);
          rem = Number((rem - alloc).toFixed(2));
        }
      }

      const finalSettledRef = body.settled_ref_no?.trim() || settledRefs.join(', ');

      const info = await db
        .prepare(
          `INSERT INTO payments (client_uuid, payment_no, direction, voucher_type, party_id, account_id, amount, payment_mode, reference_no, settled_ref_no, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          clientUuid,
          paymentNo,
          direction,
          voucherType,
          body.party_id,
          body.account_id,
          amount,
          body.payment_mode,
          body.reference_no || '',
          finalSettledRef,
          body.notes || '',
          req.user!.id
        );

      const payId = Number(info.lastInsertRowid);
      const labelMap: Record<string, string> = {
        DUE_RECEIPT: 'Customer Due Receipt',
        ADVANCE_RECEIPT: 'Customer Advance Receipt',
        DUE_PAYMENT: 'Supplier Due Payment',
        ADVANCE_PAYMENT: 'Supplier Advance Payment',
        DUE_SETTLEMENT: direction === 'RECEIPT' ? 'Customer Receipt' : 'Supplier Payment',
      };
      const label = labelMap[voucherType] || direction;

      if (direction === 'RECEIPT') {
        await db.prepare('UPDATE parties SET current_balance = current_balance - ? WHERE id = ?').run(amount, body.party_id);
        await postJournalEntry({
          description: `${label} ${paymentNo} - ${party.name} (${body.payment_mode})`,
          referenceType: 'PAYMENT',
          referenceId: payId,
          employeeId: req.user!.id,
          lines: [
            { accountCode: acc.account_code, debit: amount, credit: 0 },
            { accountCode: '1100', debit: 0, credit: amount, partyId: body.party_id },
          ],
        });
      } else {
        await db.prepare('UPDATE parties SET current_balance = current_balance + ? WHERE id = ?').run(amount, body.party_id);
        await postJournalEntry({
          description: `${label} ${paymentNo} - ${party.name} (${body.payment_mode})`,
          referenceType: 'PAYMENT',
          referenceId: payId,
          employeeId: req.user!.id,
          lines: [
            { accountCode: '2001', debit: amount, credit: 0, partyId: body.party_id },
            { accountCode: acc.account_code, debit: 0, credit: amount },
          ],
        });
      }

      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: `FINANCE_${voucherType}`,
        entityType: 'PAYMENT',
        entityId: paymentNo,
        afterObj: { amount, party_id: body.party_id, voucher_type: voucherType, mode: body.payment_mode, settled_ref_no: finalSettledRef },
      });

      const created = await db
        .prepare(
          `SELECT pay.*, pt.name as party_name, pt.party_code, pt.party_type, a.name as account_name
           FROM payments pay
           JOIN parties pt ON pt.id = pay.party_id
           JOIN accounts a ON a.id = pay.account_id
           WHERE pay.id = ?`
        )
        .get(payId);
      const responseObj = { status: 'SYNCED', payment: created };
      await recordSyncLog({
        clientUuid,
        deviceId: 'WEB-BROWSER',
        clientType: 'WEB_PWA',
        endpoint: '/api/v1/payments',
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });
      return responseObj;
    })();
  res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/v1/expenses', authenticate, requirePermission('accounting.post'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    client_uuid?: string;
    expense_account_id: number;
    paid_from_account_id: number;
    amount: number;
    payment_mode?: 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'UPI_MOBILE';
    payee_name?: string;
    reference_no?: string;
    entry_date?: string;
    notes?: string;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  const amount = Number(Number(body.amount || 0).toFixed(2));
  if (!body.expense_account_id || !body.paid_from_account_id || amount <= 0) {
    res.status(400).json({ error: 'Expense account, Cash/Bank account, and positive amount are required' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const expAcc = await db.prepare('SELECT id, account_code, name, account_type FROM accounts WHERE id = ?').get(body.expense_account_id) as
        | { id: number; account_code: string; name: string; account_type: string }
        | undefined;
      const payAcc = await db.prepare('SELECT id, account_code, name, account_type FROM accounts WHERE id = ?').get(body.paid_from_account_id) as
        | { id: number; account_code: string; name: string; account_type: string }
        | undefined;
      if (!expAcc || !payAcc) throw new Error('Invalid expense or payment account');
      if (expAcc.id === payAcc.id) throw new Error('Expense account and payment account must be different');

      const desc = `Expense: ${expAcc.name}${body.payee_name ? ` (${body.payee_name})` : ''}${body.payment_mode ? ` · ${body.payment_mode}` : ''}${
        body.reference_no ? ` · Ref: ${body.reference_no}` : ''
      }${body.notes ? ` — ${body.notes}` : ''}`;

      const jeId = await postJournalEntry({
        clientUuid,
        description: desc,
        referenceType: 'EXPENSE',
        referenceId: expAcc.id,
        employeeId: req.user!.id,
        entryDate: body.entry_date,
        voucherPrefix: 'EXP',
        lines: [
          { accountCode: expAcc.account_code, debit: amount, credit: 0 },
          { accountCode: payAcc.account_code, debit: 0, credit: amount },
        ],
      });

      const entry = await db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(jeId) as { voucher_no: string };
      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'EXPENSE_POSTED',
        entityType: 'EXPENSE',
        entityId: entry.voucher_no,
        afterObj: { amount, expense_account: expAcc.account_code, paid_from: payAcc.account_code, payee: body.payee_name },
      });

      const responseObj = { status: 'SYNCED', journal_entry: entry, amount };
      await recordSyncLog({
        clientUuid,
        deviceId: 'WEB-BROWSER',
        clientType: 'WEB_PWA',
        endpoint: '/api/v1/expenses',
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/v1/contra-transfers', authenticate, requirePermission('accounting.post'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    client_uuid?: string;
    from_account_id: number;
    to_account_id: number;
    amount: number;
    reference_no?: string;
    entry_date?: string;
    notes?: string;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  const amount = Number(Number(body.amount || 0).toFixed(2));
  if (!body.from_account_id || !body.to_account_id || amount <= 0) {
    res.status(400).json({ error: 'Source account, destination account, and positive amount are required' });
    return;
  }
  if (body.from_account_id === body.to_account_id) {
    res.status(400).json({ error: 'Source and destination accounts cannot be the same' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const fromAcc = await db.prepare('SELECT id, account_code, name, account_type FROM accounts WHERE id = ?').get(body.from_account_id) as
        | { id: number; account_code: string; name: string; account_type: string }
        | undefined;
      const toAcc = await db.prepare('SELECT id, account_code, name, account_type FROM accounts WHERE id = ?').get(body.to_account_id) as
        | { id: number; account_code: string; name: string; account_type: string }
        | undefined;
      if (!fromAcc || !toAcc) throw new Error('Invalid source or destination account');

      const desc = `Contra Transfer: ${fromAcc.name} → ${toAcc.name}${body.reference_no ? ` · Ref: ${body.reference_no}` : ''}${
        body.notes ? ` — ${body.notes}` : ''
      }`;

      const jeId = await postJournalEntry({
        clientUuid,
        description: desc,
        referenceType: 'CONTRA',
        referenceId: toAcc.id,
        employeeId: req.user!.id,
        entryDate: body.entry_date,
        voucherPrefix: 'CTR',
        lines: [
          { accountCode: toAcc.account_code, debit: amount, credit: 0 },
          { accountCode: fromAcc.account_code, debit: 0, credit: amount },
        ],
      });

      const entry = await db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(jeId) as { voucher_no: string };
      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'CONTRA_TRANSFER_POSTED',
        entityType: 'CONTRA',
        entityId: entry.voucher_no,
        afterObj: { amount, from: fromAcc.account_code, to: toAcc.account_code },
      });

      const responseObj = { status: 'SYNCED', journal_entry: entry, amount };
      await recordSyncLog({
        clientUuid,
        deviceId: 'WEB-BROWSER',
        clientType: 'WEB_PWA',
        endpoint: '/api/v1/contra-transfers',
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/v1/journal-entries', authenticate, requirePermission('accounting.post'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    client_uuid?: string;
    entry_date?: string;
    description: string;
    lines: Array<{ account_id: number; debit: number; credit: number }>;
  };

  const clientUuid = body.client_uuid || crypto.randomUUID();
  const idem = await checkIdempotency(clientUuid);
  if (idem.duplicate) {
    res.status(200).json(idem.cachedResponse);
    return;
  }

  if (!body.description?.trim() || !Array.isArray(body.lines) || body.lines.length < 2) {
    res.status(400).json({ error: 'Description and at least 2 journal lines are required' });
    return;
  }

  try {
    const result = await db.transaction(async () => {
      const resolvedLines: Array<{ accountCode: string; debit: number; credit: number }> = [];
      for (const l of body.lines) {
        const dr = Number(Number(l.debit || 0).toFixed(2));
        const cr = Number(Number(l.credit || 0).toFixed(2));
        if (dr < 0 || cr < 0 || (dr > 0 && cr > 0)) {
          throw new Error('Each journal line must have either non-negative debit OR credit');
        }
        if (dr === 0 && cr === 0) continue;
        const acc = await db.prepare('SELECT account_code FROM accounts WHERE id = ?').get(l.account_id) as { account_code: string } | undefined;
        if (!acc) throw new Error(`Account ID ${l.account_id} not found`);
        resolvedLines.push({ accountCode: acc.account_code, debit: dr, credit: cr });
      }
      if (resolvedLines.length < 2) throw new Error('At least 2 non-zero lines are required');

      const jeId = await postJournalEntry({
        clientUuid,
        description: body.description.trim(),
        referenceType: 'MANUAL_JV',
        referenceId: 0,
        employeeId: req.user!.id,
        entryDate: body.entry_date,
        voucherPrefix: 'JV',
        lines: resolvedLines,
      });

      const entry = await db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(jeId) as { voucher_no: string };
      await writeAuditLog({
        employeeId: req.user!.id,
        employeeName: req.user!.full_name,
        action: 'MANUAL_JOURNAL_POSTED',
        entityType: 'JOURNAL_ENTRY',
        entityId: entry.voucher_no,
        afterObj: { description: body.description, lines: resolvedLines },
      });

      const responseObj = { status: 'SYNCED', journal_entry: entry };
      await recordSyncLog({
        clientUuid,
        deviceId: 'WEB-BROWSER',
        clientType: 'WEB_PWA',
        endpoint: '/api/v1/journal-entries',
        status: 'SYNCED',
        responseObj,
        employeeId: req.user!.id,
      });
      return responseObj;
    })();
    res.status(201).json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// 13. Employees & Permissions (RBAC)
// ---------------------------------------------------------------------------
app.get('/api/v1/employees', authenticate, requirePermission('employees.manage'), async (_req, res) => {
  const employees = await db
    .prepare(
      `SELECT e.id, e.employee_code, e.full_name, e.email, e.phone, e.role_id, e.is_active, e.last_login_at,
              r.code as role_code, r.name as role_name
       FROM employees e
       JOIN roles r ON r.id = e.role_id
       ORDER BY e.id ASC`
    )
    .all();
  const roles = await db.prepare('SELECT * FROM roles ORDER BY id ASC').all();
  const permissions = await db.prepare('SELECT * FROM permissions ORDER BY module ASC, id ASC').all();
  const rolePerms = await db.prepare('SELECT * FROM role_permissions').all();
  res.json({ employees, roles, permissions, role_permissions: rolePerms });
});

app.post('/api/v1/employees', authenticate, requirePermission('employees.manage'), async (req: AuthedRequest, res) => {
  const { full_name, email, phone, password, role_id } = req.body as {
    full_name: string;
    email: string;
    phone?: string;
    password: string;
    role_id: number;
  };
  if (!full_name || !email || !password || !role_id) {
    res.status(400).json({ error: 'Name, email, password, and role are required' });
    return;
  }
  try {
    const seq = (await db.prepare('SELECT COALESCE(MAX(id), 0) + 1 as nextId FROM employees').get() as { nextId: number }).nextId;
    const empCode = `EMP-${String(seq).padStart(3, '0')}`;
    const hash = bcrypt.hashSync(password, 10);
    const info = await db
      .prepare('INSERT INTO employees (employee_code, full_name, email, phone, password_hash, role_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(empCode, full_name.trim(), email.trim().toLowerCase(), phone || '', hash, role_id);

    await writeAuditLog({
      employeeId: req.user!.id,
      employeeName: req.user!.full_name,
      action: 'CREATE_EMPLOYEE',
      entityType: 'EMPLOYEE',
      entityId: empCode,
      afterObj: { full_name, email, role_id },
    });
    const created = await db
      .prepare(
        `SELECT e.id, e.employee_code, e.full_name, e.email, e.phone, e.role_id, e.is_active, r.code as role_code, r.name as role_name
         FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?`
      )
      .get(info.lastInsertRowid);
    res.status(201).json({ employee: created });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.put('/api/v1/employees/:id', authenticate, requirePermission('employees.manage'), async (req: AuthedRequest, res) => {
  const targetId = Number(req.params.id);
  if (!Number.isFinite(targetId) || targetId <= 0) {
    res.status(400).json({ error: 'Invalid employee ID' });
    return;
  }

  const { full_name, email, phone, role_id, is_active, password } = req.body as {
    full_name?: string;
    email?: string;
    phone?: string;
    role_id?: number;
    is_active?: boolean | number;
    password?: string;
  };

  const existing = await db
    .prepare(
      `SELECT e.id, e.employee_code, e.full_name, e.email, e.phone, e.role_id, e.is_active, r.code as role_code
       FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?`
    )
    .get(targetId) as
    | {
        id: number;
        employee_code: string;
        full_name: string;
        email: string;
        phone: string;
        role_id: number;
        is_active: number;
        role_code: string;
      }
    | undefined;

  if (!existing) {
    res.status(404).json({ error: 'Employee not found' });
    return;
  }

  const nextName = (full_name ?? existing.full_name).trim();
  const nextEmail = (email ?? existing.email).trim().toLowerCase();
  const nextPhone = phone !== undefined ? String(phone).trim() : existing.phone || '';
  const nextRoleId = role_id !== undefined ? Number(role_id) : existing.role_id;
  const nextActive = is_active !== undefined ? (is_active ? 1 : 0) : existing.is_active;

  if (!nextName || !nextEmail) {
    res.status(400).json({ error: 'Full name and email are required' });
    return;
  }

  const targetRole = await db.prepare('SELECT id, code FROM roles WHERE id = ?').get(nextRoleId) as
    | { id: number; code: string }
    | undefined;
  if (!targetRole) {
    res.status(400).json({ error: 'Invalid role selected' });
    return;
  }

  if (existing.role_code === 'OWNER' && existing.is_active === 1 && (targetRole.code !== 'OWNER' || nextActive !== 1)) {
    const otherActiveOwners = (
      await db
        .prepare(
          `SELECT COUNT(*) as c FROM employees e
           JOIN roles r ON r.id = e.role_id
           WHERE r.code = 'OWNER' AND e.is_active = 1 AND e.id != ?`
        )
        .get(targetId) as { c: number }
    ).c;
    if (otherActiveOwners < 1) {
      res.status(400).json({ error: 'Cannot deactivate or demote the last active Mill Owner account' });
      return;
    }
  }

  if (password !== undefined && password.trim().length > 0 && password.trim().length < 6) {
    res.status(400).json({ error: 'New password must be at least 6 characters' });
    return;
  }

  try {
    if (password !== undefined && password.trim().length >= 6) {
      const hash = bcrypt.hashSync(password.trim(), 10);
      await db.prepare(
        'UPDATE employees SET full_name = ?, email = ?, phone = ?, role_id = ?, is_active = ?, password_hash = ? WHERE id = ?'
      ).run(nextName, nextEmail, nextPhone, nextRoleId, nextActive, hash, targetId);
    } else {
      await db.prepare(
        'UPDATE employees SET full_name = ?, email = ?, phone = ?, role_id = ?, is_active = ? WHERE id = ?'
      ).run(nextName, nextEmail, nextPhone, nextRoleId, nextActive, targetId);
    }

    await writeAuditLog({
      employeeId: req.user!.id,
      employeeName: req.user!.full_name,
      action: 'UPDATE_EMPLOYEE',
      entityType: 'EMPLOYEE',
      entityId: existing.employee_code,
      beforeObj: {
        full_name: existing.full_name,
        email: existing.email,
        role_id: existing.role_id,
        is_active: existing.is_active,
      },
      afterObj: {
        full_name: nextName,
        email: nextEmail,
        role_id: nextRoleId,
        is_active: nextActive,
        password_changed: Boolean(password && password.trim().length >= 6),
      },
    });

    const updated = await db
      .prepare(
        `SELECT e.id, e.employee_code, e.full_name, e.email, e.phone, e.role_id, e.is_active, e.last_login_at,
                r.code as role_code, r.name as role_name
         FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?`
      )
      .get(targetId);

    res.json({ employee: updated });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// 14. Audit Logs, Sync Logs & Automated Backups
// ---------------------------------------------------------------------------
app.get('/api/v1/audit-logs', authenticate, requirePermission('audit.view'), async (_req, res) => {
  const logs = await db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 150').all();
  const syncLogs = await db
    .prepare(
      `SELECT s.*, e.full_name as employee_name
       FROM sync_logs s
       JOIN employees e ON e.id = s.employee_id
       ORDER BY s.id DESC LIMIT 100`
    )
    .all();
  res.json({ audit_logs: logs, sync_logs: syncLogs });
});

app.get('/api/v1/backups', authenticate, requirePermission('backup.manage'), async (_req, res) => {
  const history = await db
    .prepare(
      `SELECT b.*, e.full_name as created_by_name
       FROM backup_history b
       JOIN employees e ON e.id = b.created_by
       ORDER BY b.id DESC LIMIT 30`
    )
    .all();
  res.json({ backups: history });
});

const BACKUP_TABLES = [
  'company_settings',
  'roles',
  'permissions',
  'role_permissions',
  'employees',
  'warehouses',
  'product_units',
  'product_categories',
  'parties',
  'items',
  'accounts',
  'paddy_purchases',
  'paddy_purchase_returns',
  'supplier_bag_ledger',
  'stock_transfers',
  'paddy_sales',
  'paddy_drying_batches',
  'chatal_batches',
  'chatal_batch_inputs',
  'chatal_batch_expenses',
  'chatal_expense_payments',
  'chatal_batch_dispatches',
  'production_batches',
  'inventory_lots',
  'production_outputs',
  'production_cost_sheets',
  'production_batch_inputs',
  'production_batch_expenses',
  'production_expense_payments',
  'sales_invoices',
  'sales_invoice_items',
  'sales_invoice_lot_allocations',
  'weighbridge_logs',
  'qr_tags',
  'stock_ledger',
  'journal_entries',
  'journal_lines',
  'payments',
  'sync_logs',
  'audit_logs',
  'backup_history',
] as const;

const BACKUP_TABLE_SET = new Set<string>(BACKUP_TABLES);

async function getValidTableColumns(tableName: string): Promise<string[]> {
  if (!BACKUP_TABLE_SET.has(tableName)) {
    throw new Error(`Invalid backup table: ${tableName}`);
  }
  if (isPostgres) {
    const rows = (await db
      .prepare(
        `SELECT column_name as name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = ?
         ORDER BY ordinal_position`
      )
      .all(tableName)) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }
  if (isMysql) {
    const rows = (await db
      .prepare(
        `SELECT COLUMN_NAME as name FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`
      )
      .all(tableName)) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }
  const rows = (await db.prepare(`PRAGMA table_info(\`${tableName}\`)`).all()) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

app.post('/api/v1/backups/export', authenticate, requirePermission('backup.manage'), async (req: AuthedRequest, res) => {
  const snapshot: Record<string, unknown[]> = {};
  for (const t of BACKUP_TABLES) {
    snapshot[t] = await db.prepare(`SELECT * FROM \`${t}\``).all();
  }
  const snapshotBytes =
    isMysql || isPostgres
      ? Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
      : fs.existsSync(DB_PATH)
      ? fs.statSync(DB_PATH).size
      : 0;
  const payloadStr = JSON.stringify(
    { exported_at: new Date().toISOString(), db_engine: dbEngine, db_file_bytes: snapshotBytes, tables: snapshot },
    null,
    2
  );
  const backupName = `sonagrain-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  await db.prepare('INSERT INTO backup_history (backup_name, file_size_bytes, created_by) VALUES (?, ?, ?)').run(
    backupName,
    Buffer.byteLength(payloadStr, 'utf8'),
    req.user!.id
  );
  await writeAuditLog({
    employeeId: req.user!.id,
    employeeName: req.user!.full_name,
    action: 'DATABASE_BACKUP_EXPORTED',
    entityType: 'BACKUP',
    entityId: backupName,
    afterObj: { bytes: Buffer.byteLength(payloadStr, 'utf8') },
  });

  res.json({ backup_name: backupName, snapshot: JSON.parse(payloadStr) });
});

app.post('/api/v1/backups/restore', authenticate, requirePermission('backup.manage'), async (req: AuthedRequest, res) => {
  const body = req.body as {
    tables?: Record<string, unknown>;
    snapshot?: { tables?: Record<string, unknown> };
  };
  const incomingTables =
    body?.tables && typeof body.tables === 'object'
      ? body.tables
      : body?.snapshot?.tables && typeof body.snapshot.tables === 'object'
      ? body.snapshot.tables
      : null;

  if (!incomingTables) {
    res.status(400).json({ error: 'Invalid backup JSON: missing "tables" object' });
    return;
  }

  const hasValidTableArray = BACKUP_TABLES.some((t) => Array.isArray(incomingTables[t]));
  if (!hasValidTableArray) {
    res.status(400).json({ error: 'Backup JSON contains no recognized ERP tables' });
    return;
  }

  const restoreSummary = await db.transaction(async () => {
    const existingEmps = (await db.prepare('SELECT id, email, password_hash FROM employees').all()) as Array<{
      id: number;
      email: string;
      password_hash: string;
    }>;
    const hashById = new Map(existingEmps.map((e) => [e.id, e.password_hash]));
    const hashByEmail = new Map(existingEmps.map((e) => [e.email.toLowerCase(), e.password_hash]));
    const fallbackHash = bcrypt.hashSync('123456', 10);

    const authTables = new Set(['roles', 'permissions', 'role_permissions', 'employees']);
    const incomingEmployees = Array.isArray(incomingTables.employees) ? incomingTables.employees : [];
    const restoreAuthTables = incomingEmployees.length > 0;

    // Delete in reverse topological (child-to-parent) order
    const reverseTables = [...BACKUP_TABLES].reverse();
    for (const tbl of reverseTables) {
      if (authTables.has(tbl) && !restoreAuthTables) continue;
      if (tbl === 'company_settings' && !Array.isArray(incomingTables.company_settings)) continue;
      await db.prepare(`DELETE FROM \`${tbl}\``).run();
    }

    const restoredCounts: Record<string, number> = {};

    // Insert in parent-to-child topological order
    for (const tbl of BACKUP_TABLES) {
      if (authTables.has(tbl) && !restoreAuthTables) continue;
      const rows = incomingTables[tbl];
      if (!Array.isArray(rows) || rows.length === 0) {
        restoredCounts[tbl] = 0;
        continue;
      }

      const validCols = await getValidTableColumns(tbl);
      const validColSet = new Set(validCols);
      let inserted = 0;

      for (const rawRow of rows) {
        if (!rawRow || typeof rawRow !== 'object') continue;
        const row = { ...(rawRow as Record<string, unknown>) };

        if (tbl === 'employees' && (!row.password_hash || typeof row.password_hash !== 'string')) {
          const idMatch = typeof row.id === 'number' ? hashById.get(row.id) : undefined;
          const emailMatch = typeof row.email === 'string' ? hashByEmail.get(row.email.toLowerCase()) : undefined;
          row.password_hash = idMatch || emailMatch || fallbackHash;
        }

        const cols = Object.keys(row).filter((col) => validColSet.has(col));
        if (cols.length === 0) continue;

        const colSql = cols.map((c) => `\`${c}\``).join(', ');
        const placeholders = cols.map(() => '?').join(', ');
        const values = cols.map((c) => row[c]);

        await db.prepare(`INSERT OR IGNORE INTO \`${tbl}\` (${colSql}) VALUES (${placeholders})`).run(...values);
        inserted += 1;
      }
      restoredCounts[tbl] = inserted;
    }

    await db.prepare('INSERT OR IGNORE INTO company_settings (id) VALUES (1)').run();
    await syncPostgresSequences();

    const activeEmp = (await db.prepare('SELECT id, full_name FROM employees WHERE id = ?').get(req.user!.id)) as
      | { id: number; full_name: string }
      | undefined;
    const fallbackEmp =
      activeEmp ||
      ((await db.prepare('SELECT id, full_name FROM employees ORDER BY id ASC LIMIT 1').get()) as
        | { id: number; full_name: string }
        | undefined);

    await writeAuditLog({
      employeeId: fallbackEmp?.id ?? req.user!.id,
      employeeName: fallbackEmp?.full_name ?? req.user!.full_name,
      action: 'DATABASE_BACKUP_RESTORED',
      entityType: 'BACKUP',
      entityId: 'JSON_RESTORE',
      afterObj: { total_rows: Object.values(restoredCounts).reduce((s, v) => s + v, 0), restoredCounts },
    });

    return restoredCounts;
  })();

  res.json({
    restored: true,
    tables: restoreSummary,
    total_rows: Object.values(restoreSummary).reduce((s, v) => s + v, 0),
  });
});

app.post('/api/v1/admin/clear-all-data', authenticate, requirePermission('backup.manage'), async (req: AuthedRequest, res) => {
  const body = req.body as { scope?: 'TRANSACTIONS_ONLY' | 'ALL_DATA' };
  const scope = body.scope === 'TRANSACTIONS_ONLY' ? 'TRANSACTIONS_ONLY' : 'ALL_DATA';

  const clearedTables = await db.transaction(async () => {
    const transactionalTables = [
      'sales_invoice_lot_allocations',
      'stock_ledger',
      'production_outputs',
      'production_expense_payments',
      'production_batch_expenses',
      'production_batch_inputs',
      'production_cost_sheets',
      'production_batches',
      'chatal_batch_dispatches',
      'chatal_expense_payments',
      'chatal_batch_expenses',
      'chatal_batch_inputs',
      'chatal_batches',
      'paddy_drying_batches',
      'sales_invoice_items',
      'sales_invoices',
      'paddy_sales',
      'stock_transfers',
      'supplier_bag_ledger',
      'paddy_purchase_returns',
      'paddy_purchases',
      'weighbridge_logs',
      'inventory_lots',
      'qr_tags',
      'journal_lines',
      'journal_entries',
      'payments',
      'sync_logs',
      'backup_history',
      'audit_logs',
    ];

    for (const tbl of transactionalTables) {
      await db.prepare(`DELETE FROM \`${tbl}\``).run();
    }

    await db.prepare('UPDATE accounts SET balance = 0').run();

    const masterTables = ['parties', 'items', 'warehouses', 'product_categories', 'product_units'];
    if (scope === 'ALL_DATA') {
      for (const tbl of masterTables) {
        await db.prepare(`DELETE FROM \`${tbl}\``).run();
      }
    } else {
      await db.prepare('UPDATE parties SET opening_balance = 0, current_balance = 0').run();
    }

    const seqResetTables = scope === 'ALL_DATA' ? [...transactionalTables, ...masterTables] : transactionalTables;
    for (const tbl of seqResetTables) {
      await resetAutoIncrement(tbl);
    }

    await writeAuditLog({
      employeeId: req.user!.id,
      employeeName: req.user!.full_name,
      action: scope === 'ALL_DATA' ? 'ALL_DATA_CLEARED' : 'TRANSACTIONS_CLEARED',
      entityType: 'SYSTEM',
      entityId: scope,
      afterObj: { scope, preserved: ['employees', 'roles', 'permissions', 'accounts_structure'] },
    });

    return seqResetTables;
  })();

  res.json({
    cleared: true,
    scope,
    cleared_tables: clearedTables,
  });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Unhandled API error:', err);
  if (res.headersSent) return;
  const msg = err instanceof Error ? err.message : 'Internal server error';
  res.status(500).json({ error: msg });
});

// ---------------------------------------------------------------------------
// Start Server + Mount Vite Middleware (Dev) or Static Dist (Prod)
// ---------------------------------------------------------------------------
async function startServer() {
  await initDatabase();
  JWT_SECRET = await getOrCreateServerJwtSecret();
  const httpServer = http.createServer(app);

  const distPath = path.resolve(process.cwd(), 'dist');
  const isProdMode =
    process.env.NODE_ENV === 'production' ||
    (Boolean(process.argv[1]) &&
      path.basename(process.argv[1]) === 'server.js' &&
      fs.existsSync(path.join(distPath, 'index.html')));

  if (!isProdMode) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        ws: { server: httpServer },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`SonaGrain Rice Mill ERP running on http://0.0.0.0:${PORT} (${dbEngine}, ${isProdMode ? 'production' : 'dev'})`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
