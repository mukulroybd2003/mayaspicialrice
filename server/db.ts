import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import dotenv from 'dotenv';
import fs from 'fs';
import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'path';
import pg, { type Pool as PgPool, type PoolClient as PgPoolClient } from 'pg';

dotenv.config();

// Keep PostgreSQL numeric, bigint, and timestamp values consistent with SQLite / MySQL
pg.types.setTypeParser(20, (val: string) => parseInt(val, 10));
pg.types.setTypeParser(1700, (val: string) => parseFloat(val));
pg.types.setTypeParser(1114, (val: string) => val);
pg.types.setTypeParser(1184, (val: string) => val);

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

export const DB_PATH = path.join(DATA_DIR, 'sonagrain.db');

const rawDbUrl = (
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRESQL_URL ||
  process.env.MYSQL_URL ||
  process.env.MYSQL_PUBLIC_URL ||
  process.env.MARIADB_URL ||
  ''
).trim();
const rawDbHost = (
  process.env.DB_HOST ||
  process.env.MYSQL_HOST ||
  process.env.MARIADB_HOST ||
  process.env.PGHOST ||
  process.env.POSTGRES_HOST ||
  ''
).trim();
const explicitClient = (process.env.DB_CLIENT || process.env.DB_TYPE || '').trim().toLowerCase();

export const isPostgres = Boolean(
  /^postgres(ql)?:\/\//i.test(rawDbUrl) ||
    process.env.PGHOST ||
    process.env.POSTGRES_HOST ||
    explicitClient === 'postgres' ||
    explicitClient === 'postgresql' ||
    explicitClient === 'pg'
);
export const isMysql =
  !isPostgres &&
  Boolean(
    (rawDbUrl && /^(mysql2?|mariadb):\/\//i.test(rawDbUrl)) ||
      rawDbHost ||
      explicitClient === 'mysql' ||
      explicitClient === 'mariadb'
  );
export const dbEngine: 'postgres' | 'mysql' | 'sqlite' = isPostgres ? 'postgres' : isMysql ? 'mysql' : 'sqlite';

export interface RunResult {
  lastInsertRowid: number;
  changes: number;
}

export interface PreparedStatement {
  get: (...params: unknown[]) => Promise<any>;
  all: (...params: unknown[]) => Promise<any[]>;
  run: (...params: unknown[]) => Promise<RunResult>;
}

const txStorage = new AsyncLocalStorage<{ conn?: PoolConnection | null; pgClient?: PgPoolClient | null }>();

let sqliteDb: Database.Database | null = null;
let mysqlPool: Pool | null = null;
let pgPool: PgPool | null = null;
let sqliteTxChain: Promise<void> = Promise.resolve();

const SERIAL_ID_TABLES = new Set([
  'roles',
  'permissions',
  'employees',
  'warehouses',
  'parties',
  'product_units',
  'product_categories',
  'items',
  'accounts',
  'inventory_lots',
  'stock_ledger',
  'paddy_purchases',
  'paddy_purchase_returns',
  'stock_transfers',
  'paddy_sales',
  'paddy_drying_batches',
  'chatal_batches',
  'chatal_batch_inputs',
  'chatal_batch_expenses',
  'chatal_expense_payments',
  'chatal_batch_dispatches',
  'production_batches',
  'production_outputs',
  'production_cost_sheets',
  'production_batch_inputs',
  'production_batch_expenses',
  'production_expense_payments',
  'sales_invoices',
  'sales_invoice_items',
  'sales_invoice_lot_allocations',
  'weighbridge_logs',
  'journal_entries',
  'journal_lines',
  'payments',
  'sync_logs',
  'audit_logs',
  'backup_history',
  'supplier_bag_ledger',
]);

function sanitizeParams(params: unknown[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

function normalizeSqlForMysql(sql: string): string {
  return sql
    .replace(/\bdatetime\(\s*'now'\s*\)/gi, 'NOW()')
    .replace(/\bdate\(\s*'now'\s*\)/gi, 'CURDATE()')
    .replace(/\bINSERT\s+OR\s+IGNORE\b/gi, 'INSERT IGNORE')
    .replace(/\bINSERT\s+OR\s+REPLACE\b/gi, 'REPLACE');
}

function normalizeSqlForPostgres(sql: string): string {
  if (/^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+qr_tags\b/i.test(sql)) {
    sql =
      sql.replace(/^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+/i, 'INSERT INTO ').trimEnd() +
      ' ON CONFLICT (qr_code_uid) DO UPDATE SET entity_type = EXCLUDED.entity_type, entity_id = EXCLUDED.entity_id, entity_code = EXCLUDED.entity_code, payload_json = EXCLUDED.payload_json';
  } else if (/^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+sync_logs\b/i.test(sql)) {
    sql =
      sql.replace(/^\s*INSERT\s+OR\s+REPLACE\s+INTO\s+/i, 'INSERT INTO ').trimEnd() +
      ' ON CONFLICT (client_uuid) DO UPDATE SET device_id = EXCLUDED.device_id, client_type = EXCLUDED.client_type, endpoint = EXCLUDED.endpoint, status = EXCLUDED.status, conflict_reason = EXCLUDED.conflict_reason, response_json = EXCLUDED.response_json, employee_id = EXCLUDED.employee_id';
  }

  let appendOnConflictDoNothing = false;
  if (/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql)) {
    sql = sql.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO');
    appendOnConflictDoNothing = true;
  }

  sql = sql
    .replace(/\bdatetime\(\s*'now'\s*\)/gi, 'NOW()')
    .replace(/\bdate\(\s*'now'\s*\)/gi, "TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')")
    .replace(/\bdate\(\s*([^)]+?)\s*\)/gi, 'CAST($1 AS DATE)');

  let out = '';
  let paramIdx = 0;
  let inSingleQuote = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inSingleQuote) {
      out += ch;
      if (ch === "'" && sql[i + 1] === "'") {
        out += "'";
        i++;
      } else if (ch === "'") {
        inSingleQuote = false;
      }
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      out += ch;
    } else if (ch === '`') {
      out += '"';
    } else if (ch === '?') {
      paramIdx += 1;
      out += `$${paramIdx}`;
    } else {
      out += ch;
    }
  }

  if (appendOnConflictDoNothing && !/\bON\s+CONFLICT\b/i.test(out)) {
    out = out.replace(/;?\s*$/, '') + ' ON CONFLICT DO NOTHING';
  }

  const insertMatch = out.match(/^\s*INSERT\s+INTO\s+"?([a-zA-Z0-9_]+)"?/i);
  if (insertMatch && SERIAL_ID_TABLES.has(insertMatch[1]) && !/\bRETURNING\b/i.test(out)) {
    out = out.replace(/;?\s*$/, '') + ' RETURNING id';
  }

  return out;
}

function resolvePostgresSsl(sslModeParam?: string, sslRootCertParam?: string): false | { rejectUnauthorized: boolean; ca?: string } {
  const mode = (sslModeParam || process.env.PGSSLMODE || '').toLowerCase();
  const explicitSsl = process.env.DB_SSL === 'true' || process.env.DB_SSL === '1';
  if (mode === 'disable' || process.env.DB_SSL === 'false') {
    return false;
  }
  const caEnv = (process.env.DB_SSL_CA || process.env.PGSSLROOTCERT || sslRootCertParam || '').trim();
  if (caEnv) {
    if (caEnv.includes('BEGIN CERTIFICATE')) {
      return { rejectUnauthorized: true, ca: caEnv };
    }
    const resolvedCaPath = path.resolve(process.cwd(), caEnv);
    if (fs.existsSync(resolvedCaPath)) {
      return { rejectUnauthorized: true, ca: fs.readFileSync(resolvedCaPath, 'utf8') };
    }
  }
  if (explicitSsl || ['require', 'verify-ca', 'verify-full', 'prefer', 'true', '1'].includes(mode)) {
    return { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' };
  }
  return false;
}

function createPostgresPool(): PgPool {
  if (rawDbUrl && /^postgres(ql)?:\/\//i.test(rawDbUrl)) {
    const parsed = new URL(rawDbUrl);
    const sslMode = parsed.searchParams.get('sslmode') || parsed.searchParams.get('ssl') || '';
    const sslRootCert = parsed.searchParams.get('sslrootcert') || '';
    const ssl = resolvePostgresSsl(sslMode, sslRootCert);
    return new pg.Pool({
      host: parsed.hostname,
      port: Number(parsed.port || process.env.DB_PORT || process.env.PGPORT || 5432),
      user: decodeURIComponent(parsed.username || process.env.DB_USER || process.env.PGUSER || 'postgres'),
      password: decodeURIComponent(parsed.password || process.env.DB_PASS || process.env.DB_PASSWORD || process.env.PGPASSWORD || ''),
      database: parsed.pathname.replace(/^\//, '') || process.env.DB_NAME || process.env.PGDATABASE || 'postgres',
      max: 10,
      ...(ssl ? { ssl } : {}),
    });
  }

  const ssl = resolvePostgresSsl();
  return new pg.Pool({
    host: rawDbHost || '127.0.0.1',
    port: Number(process.env.DB_PORT || process.env.PGPORT || process.env.POSTGRES_PORT || 5432),
    user: process.env.DB_USER || process.env.PGUSER || process.env.POSTGRES_USER || 'postgres',
    password: process.env.DB_PASS ?? process.env.DB_PASSWORD ?? process.env.PGPASSWORD ?? process.env.POSTGRES_PASSWORD ?? '',
    database: process.env.DB_NAME || process.env.PGDATABASE || process.env.POSTGRES_DB || 'app',
    max: 10,
    ...(ssl ? { ssl } : {}),
  });
}

function createMysqlPool(): Pool {
  if (rawDbUrl && /^(mysql2?|mariadb):\/\//i.test(rawDbUrl)) {
    const parsed = new URL(rawDbUrl.replace(/^(mysql2?|mariadb):\/\//i, 'mysql://'));
    const sslParam = (parsed.searchParams.get('ssl') || parsed.searchParams.get('ssl-mode') || parsed.searchParams.get('sslmode') || '').toLowerCase();
    const sslRootCert = parsed.searchParams.get('sslrootcert') || parsed.searchParams.get('sslca') || '';
    const ssl = resolvePostgresSsl(sslParam, sslRootCert);

    return mysql.createPool({
      host: parsed.hostname,
      port: Number(parsed.port || process.env.DB_PORT || process.env.MYSQL_PORT || process.env.MARIADB_PORT || 3306),
      user: decodeURIComponent(parsed.username || process.env.DB_USER || process.env.MYSQL_USER || process.env.MARIADB_USER || 'root'),
      password: decodeURIComponent(
        parsed.password || process.env.DB_PASS || process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || process.env.MARIADB_PASSWORD || ''
      ),
      database:
        parsed.pathname.replace(/^\//, '') ||
        process.env.DB_NAME ||
        process.env.MYSQL_DATABASE ||
        process.env.MARIADB_DATABASE ||
        'sonagrain_erp',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      decimalNumbers: true,
      dateStrings: true,
      charset: 'utf8mb4',
      ...(ssl ? { ssl } : {}),
    });
  }

  const ssl = resolvePostgresSsl();
  return mysql.createPool({
    host: rawDbHost,
    port: Number(process.env.DB_PORT || process.env.MYSQL_PORT || process.env.MARIADB_PORT || 3306),
    user: process.env.DB_USER || process.env.MYSQL_USER || process.env.MARIADB_USER || 'root',
    password:
      process.env.DB_PASS ??
      process.env.DB_PASSWORD ??
      process.env.MYSQL_PASSWORD ??
      process.env.MARIADB_PASSWORD ??
      process.env.MYSQL_ROOT_PASSWORD ??
      '',
    database: process.env.DB_NAME || process.env.MYSQL_DATABASE || process.env.MARIADB_DATABASE || 'sonagrain_erp',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    decimalNumbers: true,
    dateStrings: true,
    charset: 'utf8mb4',
    ...(ssl ? { ssl } : {}),
  });
}

if (isPostgres) {
  pgPool = createPostgresPool();
} else if (isMysql) {
  mysqlPool = createMysqlPool();
} else {
  sqliteDb = new Database(DB_PATH);
  sqliteDb.pragma('journal_mode = DELETE');
  sqliteDb.pragma('synchronous = FULL');
  sqliteDb.pragma('foreign_keys = ON');
}

function getMysqlExecutor(): Pool | PoolConnection {
  const store = txStorage.getStore();
  if (store?.conn) return store.conn;
  if (!mysqlPool) throw new Error('MySQL connection pool is not initialized');
  return mysqlPool;
}

function getPgExecutor(): PgPool | PgPoolClient {
  const store = txStorage.getStore();
  if (store?.pgClient) return store.pgClient;
  if (!pgPool) throw new Error('PostgreSQL connection pool is not initialized');
  return pgPool;
}

export const db = {
  prepare(sql: string): PreparedStatement {
    if (isPostgres) {
      const normalizedSql = normalizeSqlForPostgres(sql);
      return {
        async get(...params: unknown[]) {
          const executor = getPgExecutor();
          const result = await executor.query(normalizedSql, sanitizeParams(params));
          return result.rows[0];
        },
        async all(...params: unknown[]) {
          const executor = getPgExecutor();
          const result = await executor.query(normalizedSql, sanitizeParams(params));
          return result.rows;
        },
        async run(...params: unknown[]): Promise<RunResult> {
          const executor = getPgExecutor();
          const result = await executor.query(normalizedSql, sanitizeParams(params));
          const insertedId = result.rows?.[0]?.id;
          return {
            lastInsertRowid: insertedId != null ? Number(insertedId) : 0,
            changes: Number(result.rowCount || 0),
          };
        },
      };
    }

    if (isMysql) {
      const normalizedSql = normalizeSqlForMysql(sql);
      return {
        async get(...params: unknown[]) {
          const executor = getMysqlExecutor();
          const [rows] = await executor.query<RowDataPacket[]>(normalizedSql, sanitizeParams(params));
          return rows[0];
        },
        async all(...params: unknown[]) {
          const executor = getMysqlExecutor();
          const [rows] = await executor.query<RowDataPacket[]>(normalizedSql, sanitizeParams(params));
          return rows;
        },
        async run(...params: unknown[]): Promise<RunResult> {
          const executor = getMysqlExecutor();
          const [result] = await executor.query<ResultSetHeader>(normalizedSql, sanitizeParams(params));
          return {
            lastInsertRowid: Number(result.insertId || 0),
            changes: Number(result.affectedRows || 0),
          };
        },
      };
    }

    const stmt = sqliteDb!.prepare(sql);
    return {
      async get(...params: unknown[]) {
        return stmt.get(...sanitizeParams(params));
      },
      async all(...params: unknown[]) {
        return stmt.all(...sanitizeParams(params));
      },
      async run(...params: unknown[]): Promise<RunResult> {
        const info = stmt.run(...sanitizeParams(params));
        return {
          lastInsertRowid: Number(info.lastInsertRowid || 0),
          changes: Number(info.changes || 0),
        };
      },
    };
  },

  async exec(sql: string): Promise<void> {
    if (isPostgres) {
      const executor = getPgExecutor();
      await executor.query(sql);
      return;
    }
    if (isMysql) {
      const executor = getMysqlExecutor();
      const statements = sql
        .split(/;\s*\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      for (const s of statements) {
        await executor.query(normalizeSqlForMysql(s));
      }
      return;
    }
    sqliteDb!.exec(sql);
  },

  transaction<T>(fn: () => Promise<T>): () => Promise<T> {
    return async () => {
      if (isPostgres) {
        const existing = txStorage.getStore();
        if (existing?.pgClient) {
          return await fn();
        }
        if (!pgPool) throw new Error('PostgreSQL connection pool is not initialized');
        const pgClient = await pgPool.connect();
        try {
          await pgClient.query('BEGIN');
          const out = await txStorage.run({ pgClient }, fn);
          await pgClient.query('COMMIT');
          return out;
        } catch (err) {
          try {
            await pgClient.query('ROLLBACK');
          } catch {
            // ignore rollback failure
          }
          throw err;
        } finally {
          pgClient.release();
        }
      }

      if (isMysql) {
        const existing = txStorage.getStore();
        if (existing?.conn) {
          return await fn();
        }
        if (!mysqlPool) throw new Error('MySQL connection pool is not initialized');
        const conn = await mysqlPool.getConnection();
        try {
          await conn.beginTransaction();
          const out = await txStorage.run({ conn }, fn);
          await conn.commit();
          return out;
        } catch (err) {
          try {
            await conn.rollback();
          } catch {
            // ignore rollback failure
          }
          throw err;
        } finally {
          conn.release();
        }
      }

      const existing = txStorage.getStore();
      if (existing) {
        return await fn();
      }

      const runTx = async (): Promise<T> => {
        sqliteDb!.exec('BEGIN IMMEDIATE');
        try {
          const out = await txStorage.run({ conn: null }, fn);
          sqliteDb!.exec('COMMIT');
          return out;
        } catch (err) {
          try {
            sqliteDb!.exec('ROLLBACK');
          } catch {
            // ignore rollback failure
          }
          throw err;
        }
      };

      let release!: () => void;
      const prev = sqliteTxChain;
      sqliteTxChain = new Promise<void>((res) => {
        release = res;
      });
      await prev;
      try {
        return await runTx();
      } finally {
        release();
      }
    };
  },
};

const RESETTABLE_TABLES = new Set([
  'sales_invoice_lot_allocations',
  'stock_ledger',
  'production_outputs',
  'production_expense_payments',
  'production_batch_expenses',
  'production_batch_inputs',
  'production_cost_sheets',
  'production_batches',
  'paddy_drying_batches',
  'sales_invoice_items',
  'sales_invoices',
  'paddy_purchase_returns',
  'paddy_sales',
  'stock_transfers',
  'supplier_bag_ledger',
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
  'parties',
  'items',
  'warehouses',
  'product_categories',
  'product_units',
]);

export async function resetAutoIncrement(tableName: string): Promise<void> {
  if (!RESETTABLE_TABLES.has(tableName)) {
    throw new Error(`Invalid table for sequence reset: ${tableName}`);
  }
  if (isPostgres) {
    if (!SERIAL_ID_TABLES.has(tableName)) return;
    await db.prepare(`SELECT setval(pg_get_serial_sequence('${tableName}', 'id'), 1, false)`).get();
  } else if (isMysql) {
    await db.prepare(`ALTER TABLE \`${tableName}\` AUTO_INCREMENT = 1`).run();
  } else {
    await db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(tableName);
  }
}

export async function syncPostgresSequences(): Promise<void> {
  if (!isPostgres) return;
  for (const tbl of SERIAL_ID_TABLES) {
    await db
      .prepare(
        `SELECT setval(pg_get_serial_sequence('${tbl}', 'id'), COALESCE((SELECT MAX(id) FROM "${tbl}"), 1), EXISTS(SELECT 1 FROM "${tbl}"))`
      )
      .get();
  }
}

async function ensureMysqlColumn(tableName: string, columnName: string, definitionSql: string): Promise<void> {
  const row = (await db
    .prepare(
      `SELECT COUNT(*) as c FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`
    )
    .get(tableName, columnName)) as { c: number } | undefined;
  if (!row || Number(row.c) === 0) {
    await db.prepare(`ALTER TABLE \`${tableName}\` ADD COLUMN \`${columnName}\` ${definitionSql}`).run();
  }
}

async function ensurePostgresColumn(tableName: string, columnName: string, definitionSql: string): Promise<void> {
  const row = (await db
    .prepare(
      `SELECT COUNT(*) as c FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?`
    )
    .get(tableName, columnName)) as { c: number } | undefined;
  if (!row || Number(row.c) === 0) {
    await db.prepare(`ALTER TABLE "${tableName}" ADD COLUMN IF NOT EXISTS "${columnName}" ${definitionSql}`).run();
  }
}

function convertMysqlDdlToPostgres(ddl: string): string {
  return ddl
    .replace(/\bINT\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, 'SERIAL PRIMARY KEY')
    .replace(/\bBIGINT\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, 'BIGSERIAL PRIMARY KEY')
    .replace(/\bTINYINT\b/gi, 'SMALLINT')
    .replace(/\bDOUBLE\b/gi, 'DOUBLE PRECISION')
    .replace(/\bLONGTEXT\b/gi, 'TEXT')
    .replace(/\bDATETIME\b/gi, 'TIMESTAMP')
    .replace(/\s*ENGINE=InnoDB\s+DEFAULT\s+CHARSET=utf8mb4\s+COLLATE=utf8mb4_unicode_ci/gi, '');
}

const MYSQL_DDL_STATEMENTS: string[] = [
    `CREATE TABLE IF NOT EXISTS roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(64) NOT NULL UNIQUE,
      name VARCHAR(150) NOT NULL,
      description TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS permissions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      perm_key VARCHAR(100) NOT NULL UNIQUE,
      module VARCHAR(80) NOT NULL,
      description TEXT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INT NOT NULL,
      permission_id INT NOT NULL,
      PRIMARY KEY (role_id, permission_id),
      FOREIGN KEY (role_id) REFERENCES roles(id) ON DELETE CASCADE,
      FOREIGN KEY (permission_id) REFERENCES permissions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS employees (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS warehouses (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS parties (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS product_units (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(150) NOT NULL,
      symbol VARCHAR(40) NOT NULL,
      base_weight_kg DOUBLE NOT NULL DEFAULT 1,
      description TEXT,
      is_active TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS product_categories (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(60) NOT NULL UNIQUE,
      name VARCHAR(150) NOT NULL,
      group_type VARCHAR(60) NOT NULL DEFAULT 'FINISHED_GOOD',
      default_costing_method VARCHAR(40) NOT NULL DEFAULT 'FIFO',
      description TEXT,
      is_active TINYINT NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS items (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      account_code VARCHAR(50) NOT NULL UNIQUE,
      name VARCHAR(191) NOT NULL,
      account_type VARCHAR(40) NOT NULL,
      balance DOUBLE NOT NULL DEFAULT 0,
      is_system TINYINT NOT NULL DEFAULT 1
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS inventory_lots (
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
      weight_pending TINYINT NOT NULL DEFAULT 0,
      pending_cost_total DOUBLE NOT NULL DEFAULT 0,
      dispatched_qty_kg DOUBLE NOT NULL DEFAULT 0,
      dispatched_bags INT NOT NULL DEFAULT 0,
      extra_torn_bags INT NOT NULL DEFAULT 0,
      received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      version INT NOT NULL DEFAULT 1,
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS stock_ledger (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS paddy_purchases (
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
      paddy_condition VARCHAR(20) NOT NULL DEFAULT 'RAW_WET',
      split_summary_json LONGTEXT,
      qr_code_uid VARCHAR(64) NOT NULL UNIQUE,
      weighbridge_mode VARCHAR(40) NOT NULL DEFAULT 'MANUAL',
      created_by INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (supplier_id) REFERENCES parties(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS paddy_purchase_returns (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS stock_transfers (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS paddy_sales (
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
      source_lot_id INT,
      extra_torn_bags INT NOT NULL DEFAULT 0,
      notes TEXT,
      qr_code_uid VARCHAR(64) NOT NULL UNIQUE,
      created_by INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (customer_id) REFERENCES parties(id),
      FOREIGN KEY (warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS paddy_drying_batches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      client_uuid VARCHAR(64) NOT NULL UNIQUE,
      drying_no VARCHAR(64) NOT NULL UNIQUE,
      purchase_id INT NULL,
      source_warehouse_id INT NOT NULL,
      dest_warehouse_id INT NOT NULL,
      item_id INT NOT NULL,
      drying_method VARCHAR(60) NOT NULL,
      input_qty_kg DOUBLE NOT NULL,
      input_bags INT NOT NULL DEFAULT 0,
      output_bags INT NOT NULL DEFAULT 0,
      dispatched_bags INT NOT NULL DEFAULT 0,
      extra_torn_bags INT NOT NULL DEFAULT 0,
      weight_pending TINYINT NOT NULL DEFAULT 0,
      initial_moisture_pct DOUBLE NOT NULL,
      final_moisture_pct DOUBLE NOT NULL,
      output_qty_kg DOUBLE NOT NULL,
      moisture_loss_kg DOUBLE NOT NULL,
      fuel_power_cost DOUBLE NOT NULL DEFAULT 0,
      labor_cost DOUBLE NOT NULL DEFAULT 0,
      input_paddy_cost DOUBLE NOT NULL,
      output_unit_cost_per_kg DOUBLE NOT NULL,
      exit_settlement_unit_kg DOUBLE NOT NULL DEFAULT 75.5,
      exit_settlement_rate DOUBLE NOT NULL DEFAULT 0,
      exit_total_value DOUBLE NOT NULL DEFAULT 0,
      notes TEXT,
      status VARCHAR(40) NOT NULL DEFAULT 'COMPLETED',
      qr_code_uid VARCHAR(64) NOT NULL UNIQUE,
      created_by INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (dest_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS production_batches (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS production_outputs (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS production_cost_sheets (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS production_batch_inputs (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS production_batch_expenses (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS production_expense_payments (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS chatal_batches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      client_uuid VARCHAR(64) NOT NULL UNIQUE,
      chatal_no VARCHAR(64) NOT NULL UNIQUE,
      title VARCHAR(191) NOT NULL DEFAULT '',
      chatal_warehouse_id INT NOT NULL,
      paddy_item_id INT NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',
      total_intake_bags INT NOT NULL DEFAULT 0,
      total_intake_kg DOUBLE NOT NULL DEFAULT 0,
      total_paddy_cost DOUBLE NOT NULL DEFAULT 0,
      drying_cost DOUBLE NOT NULL DEFAULT 0,
      khamal_cost DOUBLE NOT NULL DEFAULT 0,
      other_cost DOUBLE NOT NULL DEFAULT 0,
      moisture_loss_kg DOUBLE NOT NULL DEFAULT 0,
      notes TEXT,
      qr_code_uid VARCHAR(64) NOT NULL UNIQUE,
      created_by INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      closed_at DATETIME,
      FOREIGN KEY (chatal_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (paddy_item_id) REFERENCES items(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS chatal_batch_inputs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      chatal_batch_id INT NOT NULL,
      source_warehouse_id INT NOT NULL,
      paddy_item_id INT NOT NULL,
      purchase_id INT,
      lot_id INT,
      bag_count INT NOT NULL DEFAULT 0,
      qty_kg DOUBLE NOT NULL,
      unit_divisor DOUBLE NOT NULL DEFAULT 75.5,
      net_units DOUBLE NOT NULL DEFAULT 0,
      bag_unit_rate DOUBLE NOT NULL DEFAULT 0,
      paddy_cost DOUBLE NOT NULL DEFAULT 0,
      notes TEXT,
      created_by INT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chatal_batch_id) REFERENCES chatal_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (paddy_item_id) REFERENCES items(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS chatal_batch_expenses (
      id INT AUTO_INCREMENT PRIMARY KEY,
      chatal_batch_id INT NOT NULL,
      expense_type VARCHAR(50) NOT NULL DEFAULT 'DRYING',
      vendor_name VARCHAR(191) DEFAULT '',
      total_amount DOUBLE NOT NULL DEFAULT 0,
      payment_status VARCHAR(30) NOT NULL DEFAULT 'PAID',
      paid_amount DOUBLE NOT NULL DEFAULT 0,
      account_id INT,
      paid_at DATETIME,
      notes TEXT,
      created_by INT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chatal_batch_id) REFERENCES chatal_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by) REFERENCES employees(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS chatal_expense_payments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      receipt_no VARCHAR(64),
      expense_id INT NOT NULL,
      chatal_batch_id INT NOT NULL,
      account_id INT NOT NULL,
      amount DOUBLE NOT NULL,
      payment_mode VARCHAR(40) NOT NULL DEFAULT 'CASH',
      reference_no VARCHAR(100),
      notes TEXT,
      paid_by INT,
      paid_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (expense_id) REFERENCES chatal_batch_expenses(id) ON DELETE CASCADE,
      FOREIGN KEY (chatal_batch_id) REFERENCES chatal_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (paid_by) REFERENCES employees(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS chatal_batch_dispatches (
      id INT AUTO_INCREMENT PRIMARY KEY,
      chatal_batch_id INT NOT NULL,
      round_no INT NOT NULL DEFAULT 1,
      from_warehouse_id INT NOT NULL,
      dest_warehouse_id INT NOT NULL,
      dest_lot_id INT,
      paddy_item_id INT NOT NULL,
      bag_count INT NOT NULL DEFAULT 0,
      qty_kg DOUBLE NOT NULL DEFAULT 0,
      weight_pending TINYINT NOT NULL DEFAULT 0,
      allocated_cost DOUBLE NOT NULL DEFAULT 0,
      sale_style_unit_kg DOUBLE NOT NULL DEFAULT 75.5,
      sale_style_rate DOUBLE NOT NULL DEFAULT 0,
      sale_style_est_value DOUBLE NOT NULL DEFAULT 0,
      notes TEXT,
      created_by INT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (chatal_batch_id) REFERENCES chatal_batches(id) ON DELETE CASCADE,
      FOREIGN KEY (from_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (dest_warehouse_id) REFERENCES warehouses(id),
      FOREIGN KEY (dest_lot_id) REFERENCES inventory_lots(id),
      FOREIGN KEY (paddy_item_id) REFERENCES items(id),
      FOREIGN KEY (created_by) REFERENCES employees(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS sales_invoices (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS sales_invoice_items (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS sales_invoice_lot_allocations (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS weighbridge_logs (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS qr_tags (
      qr_code_uid VARCHAR(64) PRIMARY KEY,
      entity_type VARCHAR(60) NOT NULL,
      entity_id INT NOT NULL,
      entity_code VARCHAR(80) NOT NULL,
      payload_json LONGTEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS journal_entries (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS journal_lines (
      id INT AUTO_INCREMENT PRIMARY KEY,
      journal_entry_id INT NOT NULL,
      account_id INT NOT NULL,
      debit DOUBLE NOT NULL DEFAULT 0,
      credit DOUBLE NOT NULL DEFAULT 0,
      party_id INT,
      FOREIGN KEY (journal_entry_id) REFERENCES journal_entries(id) ON DELETE CASCADE,
      FOREIGN KEY (account_id) REFERENCES accounts(id),
      FOREIGN KEY (party_id) REFERENCES parties(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS payments (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS sync_logs (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS audit_logs (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS backup_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      backup_name VARCHAR(191) NOT NULL,
      file_size_bytes BIGINT NOT NULL,
      created_by INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES employees(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS company_settings (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS supplier_bag_ledger (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS app_meta (
      meta_key VARCHAR(100) PRIMARY KEY,
      meta_value TEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

    `CREATE TABLE IF NOT EXISTS sms_logs (
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

async function initMysqlSchema(): Promise<void> {
  for (const ddl of MYSQL_DDL_STATEMENTS) {
    await db.prepare(ddl).run();
  }

  await db.prepare('INSERT IGNORE INTO company_settings (id) VALUES (1)').run();
  await ensureMysqlColumn('paddy_purchases', 'pricing_status', "VARCHAR(30) NOT NULL DEFAULT 'PRICED'");
  await ensureMysqlColumn('paddy_purchases', 'paddy_condition', "VARCHAR(20) NOT NULL DEFAULT 'RAW_WET'");
  await ensureMysqlColumn('paddy_purchases', 'split_summary_json', 'LONGTEXT');
  await ensureMysqlColumn('company_settings', 'logo_data_url', 'LONGTEXT');
  await ensureMysqlColumn('inventory_lots', 'weight_pending', 'TINYINT NOT NULL DEFAULT 0');
  await ensureMysqlColumn('inventory_lots', 'pending_cost_total', 'DOUBLE NOT NULL DEFAULT 0');
  await ensureMysqlColumn('inventory_lots', 'dispatched_qty_kg', 'DOUBLE NOT NULL DEFAULT 0');
  await ensureMysqlColumn('inventory_lots', 'dispatched_bags', 'INT NOT NULL DEFAULT 0');
  await ensureMysqlColumn('inventory_lots', 'extra_torn_bags', 'INT NOT NULL DEFAULT 0');
  await ensureMysqlColumn('paddy_drying_batches', 'purchase_id', 'INT');
  await ensureMysqlColumn('paddy_drying_batches', 'input_bags', 'INT NOT NULL DEFAULT 0');
  await ensureMysqlColumn('paddy_drying_batches', 'output_bags', 'INT NOT NULL DEFAULT 0');
  await ensureMysqlColumn('paddy_drying_batches', 'dispatched_bags', 'INT NOT NULL DEFAULT 0');
  await ensureMysqlColumn('paddy_drying_batches', 'extra_torn_bags', 'INT NOT NULL DEFAULT 0');
  await ensureMysqlColumn('paddy_drying_batches', 'weight_pending', 'TINYINT NOT NULL DEFAULT 0');
  await ensureMysqlColumn('paddy_drying_batches', 'exit_settlement_unit_kg', 'DOUBLE NOT NULL DEFAULT 75.5');
  await ensureMysqlColumn('paddy_drying_batches', 'exit_settlement_rate', 'DOUBLE NOT NULL DEFAULT 0');
  await ensureMysqlColumn('paddy_drying_batches', 'exit_total_value', 'DOUBLE NOT NULL DEFAULT 0');
  await ensureMysqlColumn('paddy_drying_batches', 'notes', 'TEXT');
  await ensureMysqlColumn('paddy_sales', 'source_lot_id', 'INT');
  await ensureMysqlColumn('paddy_sales', 'extra_torn_bags', 'INT NOT NULL DEFAULT 0');
  await ensureMysqlColumn('inventory_lots', 'chatal_batch_id', 'INT');
  await ensureMysqlColumn('production_batches', 'chatal_batch_id', 'INT');
  await ensureMysqlColumn('paddy_sales', 'chatal_batch_id', 'INT');
}

async function initPostgresSchema(): Promise<void> {
  for (const ddl of MYSQL_DDL_STATEMENTS) {
    await db.prepare(convertMysqlDdlToPostgres(ddl)).run();
  }

  await db.prepare('INSERT INTO company_settings (id) VALUES (1) ON CONFLICT DO NOTHING').run();
  await ensurePostgresColumn('paddy_purchases', 'pricing_status', "VARCHAR(30) NOT NULL DEFAULT 'PRICED'");
  await ensurePostgresColumn('paddy_purchases', 'paddy_condition', "VARCHAR(20) NOT NULL DEFAULT 'RAW_WET'");
  await ensurePostgresColumn('paddy_purchases', 'split_summary_json', 'TEXT');
  await ensurePostgresColumn('company_settings', 'logo_data_url', 'TEXT');
  await ensurePostgresColumn('inventory_lots', 'weight_pending', 'SMALLINT NOT NULL DEFAULT 0');
  await ensurePostgresColumn('inventory_lots', 'pending_cost_total', 'DOUBLE PRECISION NOT NULL DEFAULT 0');
  await ensurePostgresColumn('inventory_lots', 'dispatched_qty_kg', 'DOUBLE PRECISION NOT NULL DEFAULT 0');
  await ensurePostgresColumn('inventory_lots', 'dispatched_bags', 'INTEGER NOT NULL DEFAULT 0');
  await ensurePostgresColumn('inventory_lots', 'extra_torn_bags', 'INTEGER NOT NULL DEFAULT 0');
  await ensurePostgresColumn('paddy_drying_batches', 'purchase_id', 'INTEGER');
  await ensurePostgresColumn('paddy_drying_batches', 'input_bags', 'INTEGER NOT NULL DEFAULT 0');
  await ensurePostgresColumn('paddy_drying_batches', 'output_bags', 'INTEGER NOT NULL DEFAULT 0');
  await ensurePostgresColumn('paddy_drying_batches', 'dispatched_bags', 'INTEGER NOT NULL DEFAULT 0');
  await ensurePostgresColumn('paddy_drying_batches', 'extra_torn_bags', 'INTEGER NOT NULL DEFAULT 0');
  await ensurePostgresColumn('paddy_drying_batches', 'weight_pending', 'SMALLINT NOT NULL DEFAULT 0');
  await ensurePostgresColumn('paddy_drying_batches', 'exit_settlement_unit_kg', 'DOUBLE PRECISION NOT NULL DEFAULT 75.5');
  await ensurePostgresColumn('paddy_drying_batches', 'exit_settlement_rate', 'DOUBLE PRECISION NOT NULL DEFAULT 0');
  await ensurePostgresColumn('paddy_drying_batches', 'exit_total_value', 'DOUBLE PRECISION NOT NULL DEFAULT 0');
  await ensurePostgresColumn('paddy_drying_batches', 'notes', 'TEXT');
  await ensurePostgresColumn('paddy_sales', 'source_lot_id', 'INTEGER');
  await ensurePostgresColumn('paddy_sales', 'extra_torn_bags', 'INTEGER NOT NULL DEFAULT 0');
  await ensurePostgresColumn('inventory_lots', 'chatal_batch_id', 'INTEGER');
  await ensurePostgresColumn('production_batches', 'chatal_batch_id', 'INTEGER');
  await ensurePostgresColumn('paddy_sales', 'chatal_batch_id', 'INTEGER');
}

async function initSqliteSchema(): Promise<void> {
  await db.exec(`
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
      paddy_condition TEXT NOT NULL DEFAULT 'RAW_WET',
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
      purchase_id INTEGER,
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

    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL,
      balance REAL NOT NULL DEFAULT 0,
      is_system INTEGER NOT NULL DEFAULT 1
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
      company_name_bn TEXT NOT NULL DEFAULT 'মায়া স্পেশাল রাইস',
      short_code TEXT NOT NULL DEFAULT 'MS',
      tagline_en TEXT NOT NULL DEFAULT 'Automated Parboiled & Raw Rice Mill · Weighbridge, Milling & Wholesale Trade',
      tagline_bn TEXT NOT NULL DEFAULT 'অটোমেটিক সিদ্ধ ও আতপ রাইস মিল · ডিজিটাল ওয়েব্রিজ, প্রসেসিং ও চাল বিপণন',
      address_en TEXT NOT NULL DEFAULT 'Plot 14, BSCIC Industrial Estate, Bogura-5800, Bangladesh',
      address_bn TEXT NOT NULL DEFAULT 'প্লট ১৪, বিসিক শিল্প নগরী, বগুড়া-৫৮০০, বাংলাদেশ',
      phone TEXT NOT NULL DEFAULT '+880 1711-000000',
      email TEXT NOT NULL DEFAULT 'admin@gmail.com',
      tax_id TEXT NOT NULL DEFAULT 'BIN: 001234567-0101',
      logo_data_url TEXT,
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

    CREATE TABLE IF NOT EXISTS app_meta (
      meta_key TEXT PRIMARY KEY,
      meta_value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sms_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL DEFAULT 0,
      entity_code TEXT NOT NULL DEFAULT '',
      party_id INTEGER,
      party_name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'NONE',
      message_body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'SKIPPED',
      provider_response TEXT DEFAULT '',
      created_by INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO company_settings (id) VALUES (1);
  `);

  const payCols = (await db.prepare('PRAGMA table_info(payments)').all()) as Array<{ name: string }>;
  const payColNames = new Set(payCols.map((c) => c.name));
  if (!payColNames.has('voucher_type')) {
    await db.exec("ALTER TABLE payments ADD COLUMN voucher_type TEXT NOT NULL DEFAULT 'DUE_SETTLEMENT'");
  }
  if (!payColNames.has('settled_ref_no')) {
    await db.exec('ALTER TABLE payments ADD COLUMN settled_ref_no TEXT');
  }

  const purCols = (await db.prepare('PRAGMA table_info(paddy_purchases)').all()) as Array<{ name: string }>;
  const purColNames = new Set(purCols.map((c) => c.name));
  if (!purColNames.has('weight_loss_kg')) {
    await db.exec('ALTER TABLE paddy_purchases ADD COLUMN weight_loss_kg REAL NOT NULL DEFAULT 0');
  }
  if (!purColNames.has('settlement_unit_kg')) {
    await db.exec('ALTER TABLE paddy_purchases ADD COLUMN settlement_unit_kg REAL NOT NULL DEFAULT 75.5');
  }
  if (!purColNames.has('settlement_rate')) {
    await db.exec('ALTER TABLE paddy_purchases ADD COLUMN settlement_rate REAL NOT NULL DEFAULT 0');
  }
  if (!purColNames.has('jute_bag_count')) {
    await db.exec('ALTER TABLE paddy_purchases ADD COLUMN jute_bag_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!purColNames.has('plastic_bag_count')) {
    await db.exec('ALTER TABLE paddy_purchases ADD COLUMN plastic_bag_count INTEGER NOT NULL DEFAULT 0');
    await db.exec('UPDATE paddy_purchases SET jute_bag_count = bag_count WHERE jute_bag_count = 0 AND plastic_bag_count = 0 AND bag_count > 0');
  }

  const bagLedgerCount = ((await db.prepare('SELECT COUNT(*) as c FROM supplier_bag_ledger').get()) as { c: number }).c;
  const existingPurchaseCount = ((await db.prepare('SELECT COUNT(*) as c FROM paddy_purchases').get()) as { c: number }).c;
  if (bagLedgerCount === 0 && existingPurchaseCount > 0) {
    const purchasesForBags = (await db
      .prepare('SELECT id, purchase_no, supplier_id, bag_count, jute_bag_count, plastic_bag_count, created_by, created_at FROM paddy_purchases WHERE bag_count > 0')
      .all()) as Array<{
      id: number;
      purchase_no: string;
      supplier_id: number;
      bag_count: number;
      jute_bag_count: number;
      plastic_bag_count: number;
      created_by: number;
      created_at: string;
    }>;
    const insBag = db.prepare(
      `INSERT INTO supplier_bag_ledger (
        client_uuid, entry_no, supplier_id, entry_type, direction,
        jute_qty, plastic_qty, total_qty, reference_type, reference_id, reference_no, entry_date, notes, created_by, created_at
      ) VALUES (?, ?, ?, 'PADDY_DEPOSIT', 'IN_FROM_SUPPLIER', ?, ?, ?, 'PADDY_PURCHASE', ?, ?, ?, ?, ?, ?)`
    );
    for (let idx = 0; idx < purchasesForBags.length; idx++) {
      const p = purchasesForBags[idx];
      const jute = p.jute_bag_count > 0 || p.plastic_bag_count > 0 ? p.jute_bag_count : p.bag_count;
      const plastic = p.plastic_bag_count || 0;
      const total = jute + plastic;
      await insBag.run(
        crypto.randomUUID(),
        `BAG-2026-${String(idx + 1).padStart(4, '0')}`,
        p.supplier_id,
        jute,
        plastic,
        total,
        p.id,
        p.purchase_no,
        String(p.created_at || '').slice(0, 10) || new Date().toISOString().slice(0, 10),
        `Paddy purchase bag deposit (${p.purchase_no})`,
        p.created_by,
        p.created_at
      );
    }
  }

  const lotCols = (await db.prepare('PRAGMA table_info(inventory_lots)').all()) as Array<{ name: string }>;
  const lotColNames = new Set(lotCols.map((c) => c.name));
  if (!lotColNames.has('initial_bags')) {
    await db.exec('ALTER TABLE inventory_lots ADD COLUMN initial_bags INTEGER NOT NULL DEFAULT 0');
  }
  if (!lotColNames.has('remaining_bags')) {
    await db.exec('ALTER TABLE inventory_lots ADD COLUMN remaining_bags INTEGER NOT NULL DEFAULT 0');
    await db.exec(`
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
  if (!lotColNames.has('pack_size_kg')) {
    await db.exec('ALTER TABLE inventory_lots ADD COLUMN pack_size_kg REAL NOT NULL DEFAULT 0');
    await db.exec(`
      UPDATE inventory_lots
      SET pack_size_kg = COALESCE(NULLIF((SELECT bag_weight_kg FROM items WHERE id = inventory_lots.item_id), 0), 50)
      WHERE pack_size_kg = 0
    `);
  }

  const outCols = (await db.prepare('PRAGMA table_info(production_outputs)').all()) as Array<{ name: string }>;
  const outColNames = new Set(outCols.map((c) => c.name));
  if (!outColNames.has('pack_size_kg')) {
    await db.exec('ALTER TABLE production_outputs ADD COLUMN pack_size_kg REAL NOT NULL DEFAULT 0');
  }
  if (!outColNames.has('bag_count')) {
    await db.exec('ALTER TABLE production_outputs ADD COLUMN bag_count INTEGER NOT NULL DEFAULT 0');
  }

  const expCols = (await db.prepare('PRAGMA table_info(production_batch_expenses)').all()) as Array<{ name: string }>;
  const expColNames = new Set(expCols.map((c) => c.name));
  if (!expColNames.has('expense_category')) {
    await db.exec("ALTER TABLE production_batch_expenses ADD COLUMN expense_category TEXT NOT NULL DEFAULT 'GENERAL'");
  }
  if (!expColNames.has('vendor_name')) {
    await db.exec("ALTER TABLE production_batch_expenses ADD COLUMN vendor_name TEXT DEFAULT ''");
  }
  if (!expColNames.has('payment_status')) {
    await db.exec("ALTER TABLE production_batch_expenses ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'PAID'");
  }
  if (!expColNames.has('paid_amount')) {
    await db.exec('ALTER TABLE production_batch_expenses ADD COLUMN paid_amount REAL NOT NULL DEFAULT 0');
    await db.exec("UPDATE production_batch_expenses SET paid_amount = total_amount WHERE payment_status = 'PAID' AND paid_amount = 0");
  }
  if (!expColNames.has('account_id')) {
    await db.exec('ALTER TABLE production_batch_expenses ADD COLUMN account_id INTEGER');
  }
  if (!expColNames.has('paid_at')) {
    await db.exec('ALTER TABLE production_batch_expenses ADD COLUMN paid_at TEXT');
  }

  const batchCols = (await db.prepare('PRAGMA table_info(production_batches)').all()) as Array<{ name: string }>;
  const batchColNames = new Set(batchCols.map((c) => c.name));
  if (!batchColNames.has('input_bag_count')) {
    await db.exec('ALTER TABLE production_batches ADD COLUMN input_bag_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!batchColNames.has('dryer_no')) {
    await db.exec("ALTER TABLE production_batches ADD COLUMN dryer_no TEXT NOT NULL DEFAULT ''");
  }
  if (!batchColNames.has('dryer_count')) {
    await db.exec('ALTER TABLE production_batches ADD COLUMN dryer_count REAL NOT NULL DEFAULT 1');
  }
  if (!batchColNames.has('unit_divisor')) {
    await db.exec('ALTER TABLE production_batches ADD COLUMN unit_divisor REAL NOT NULL DEFAULT 75.5');
  }
  if (!batchColNames.has('paddy_net_units')) {
    await db.exec('ALTER TABLE production_batches ADD COLUMN paddy_net_units REAL NOT NULL DEFAULT 0');
  }
  if (!batchColNames.has('paddy_bag_unit_rate')) {
    await db.exec('ALTER TABLE production_batches ADD COLUMN paddy_bag_unit_rate REAL NOT NULL DEFAULT 0');
  }
  if (!batchColNames.has('paddy_formula_cost')) {
    await db.exec('ALTER TABLE production_batches ADD COLUMN paddy_formula_cost REAL NOT NULL DEFAULT 0');
    await db.exec(`
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

  const trCols = (await db.prepare('PRAGMA table_info(stock_transfers)').all()) as Array<{ name: string }>;
  const trColNames = new Set(trCols.map((c) => c.name));
  if (!trColNames.has('bag_count')) {
    await db.exec('ALTER TABLE stock_transfers ADD COLUMN bag_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!trColNames.has('unit_divisor')) {
    await db.exec('ALTER TABLE stock_transfers ADD COLUMN unit_divisor REAL NOT NULL DEFAULT 75.5');
  }
  if (!trColNames.has('net_units')) {
    await db.exec('ALTER TABLE stock_transfers ADD COLUMN net_units REAL NOT NULL DEFAULT 0');
  }
  if (!trColNames.has('bag_unit_rate')) {
    await db.exec('ALTER TABLE stock_transfers ADD COLUMN bag_unit_rate REAL NOT NULL DEFAULT 0');
    await db.exec(`
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

  await db.exec(`
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

  const ppCols = (await db.prepare('PRAGMA table_info(paddy_purchases)').all()) as Array<{ name: string }>;
  const ppColNames = new Set(ppCols.map((c) => c.name));
  if (!ppColNames.has('returned_qty_kg')) {
    await db.exec('ALTER TABLE paddy_purchases ADD COLUMN returned_qty_kg REAL NOT NULL DEFAULT 0');
  }
  if (!ppColNames.has('returned_amount')) {
    await db.exec('ALTER TABLE paddy_purchases ADD COLUMN returned_amount REAL NOT NULL DEFAULT 0');
  }
  if (!ppColNames.has('split_summary_json')) {
    await db.exec('ALTER TABLE paddy_purchases ADD COLUMN split_summary_json TEXT');
  }
  if (!ppColNames.has('pricing_status')) {
    await db.exec("ALTER TABLE paddy_purchases ADD COLUMN pricing_status TEXT NOT NULL DEFAULT 'PRICED'");
  }
  if (!ppColNames.has('paddy_condition')) {
    await db.exec("ALTER TABLE paddy_purchases ADD COLUMN paddy_condition TEXT NOT NULL DEFAULT 'RAW_WET'");
  }

  const csCols = (await db.prepare('PRAGMA table_info(company_settings)').all()) as Array<{ name: string }>;
  const csColNames = new Set(csCols.map((c) => c.name));
  if (!csColNames.has('logo_data_url')) {
    await db.exec('ALTER TABLE company_settings ADD COLUMN logo_data_url TEXT');
  }

  const pepCols = (await db.prepare('PRAGMA table_info(production_expense_payments)').all()) as Array<{ name: string }>;
  const pepColNames = new Set(pepCols.map((c) => c.name));
  if (!pepColNames.has('receipt_no')) {
    await db.exec('ALTER TABLE production_expense_payments ADD COLUMN receipt_no TEXT');
    const existingPeps = (await db.prepare('SELECT id FROM production_expense_payments WHERE receipt_no IS NULL ORDER BY id ASC').all()) as Array<{ id: number }>;
    const updPep = db.prepare('UPDATE production_expense_payments SET receipt_no = ? WHERE id = ?');
    for (const row of existingPeps) {
      await updPep.run(`EXPR-2026-${String(row.id).padStart(4, '0')}`, row.id);
    }
  }

  const lotCols2 = (await db.prepare('PRAGMA table_info(inventory_lots)').all()) as Array<{ name: string }>;
  const lotColNames2 = new Set(lotCols2.map((c) => c.name));
  if (!lotColNames2.has('origin_batch_id')) {
    await db.exec('ALTER TABLE inventory_lots ADD COLUMN origin_batch_id INTEGER');
    await db.exec("UPDATE inventory_lots SET origin_batch_id = source_id WHERE source_type = 'PRODUCTION_OUTPUT' AND origin_batch_id IS NULL");
  }

  const outCols2 = (await db.prepare('PRAGMA table_info(production_outputs)').all()) as Array<{ name: string }>;
  const outColNames2 = new Set(outCols2.map((c) => c.name));
  if (!outColNames2.has('rate_per_bag')) {
    await db.exec('ALTER TABLE production_outputs ADD COLUMN rate_per_bag REAL NOT NULL DEFAULT 0');
    await db.exec('UPDATE production_outputs SET rate_per_bag = CASE WHEN bag_count > 0 THEN ROUND(total_value / bag_count, 2) ELSE 0 END WHERE rate_per_bag = 0');
  }

  const psCols = (await db.prepare('PRAGMA table_info(paddy_sales)').all()) as Array<{ name: string }>;
  const psColNames = new Set(psCols.map((c) => c.name));
  if (!psColNames.has('challan_no')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN challan_no TEXT');
  }
  if (!psColNames.has('bag_count')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN bag_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!psColNames.has('jute_bag_count')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN jute_bag_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!psColNames.has('plastic_bag_count')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN plastic_bag_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!psColNames.has('moisture_pct')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN moisture_pct REAL NOT NULL DEFAULT 14');
  }
  if (!psColNames.has('scale_weight_kg')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN scale_weight_kg REAL NOT NULL DEFAULT 0');
    await db.exec('UPDATE paddy_sales SET scale_weight_kg = qty_kg WHERE scale_weight_kg = 0');
  }
  if (!psColNames.has('payment_weight_kg')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN payment_weight_kg REAL NOT NULL DEFAULT 0');
    await db.exec('UPDATE paddy_sales SET payment_weight_kg = qty_kg WHERE payment_weight_kg = 0');
  }
  if (!psColNames.has('weight_loss_kg')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN weight_loss_kg REAL NOT NULL DEFAULT 0');
  }
  if (!psColNames.has('settlement_unit_kg')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN settlement_unit_kg REAL NOT NULL DEFAULT 75.5');
  }
  if (!psColNames.has('settlement_rate')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN settlement_rate REAL NOT NULL DEFAULT 0');
    await db.exec('UPDATE paddy_sales SET settlement_rate = ROUND(rate_per_kg * 75.5, 2) WHERE settlement_rate = 0');
  }
  if (!psColNames.has('notes')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN notes TEXT');
  }

  const siiCols = (await db.prepare('PRAGMA table_info(sales_invoice_items)').all()) as Array<{ name: string }>;
  const siiColNames = new Set(siiCols.map((c) => c.name));
  if (!siiColNames.has('bag_count')) {
    await db.exec('ALTER TABLE sales_invoice_items ADD COLUMN bag_count INTEGER NOT NULL DEFAULT 0');
  }
  if (!siiColNames.has('pack_size_kg')) {
    await db.exec('ALTER TABLE sales_invoice_items ADD COLUMN pack_size_kg REAL NOT NULL DEFAULT 50');
  }
  if (!siiColNames.has('rate_per_bag')) {
    await db.exec('ALTER TABLE sales_invoice_items ADD COLUMN rate_per_bag REAL NOT NULL DEFAULT 0');
  }

  const lotCols3 = (await db.prepare('PRAGMA table_info(inventory_lots)').all()) as Array<{ name: string }>;
  const lotColNames3 = new Set(lotCols3.map((c) => c.name));
  if (!lotColNames3.has('weight_pending')) {
    await db.exec('ALTER TABLE inventory_lots ADD COLUMN weight_pending INTEGER NOT NULL DEFAULT 0');
  }
  if (!lotColNames3.has('pending_cost_total')) {
    await db.exec('ALTER TABLE inventory_lots ADD COLUMN pending_cost_total REAL NOT NULL DEFAULT 0');
  }
  if (!lotColNames3.has('dispatched_qty_kg')) {
    await db.exec('ALTER TABLE inventory_lots ADD COLUMN dispatched_qty_kg REAL NOT NULL DEFAULT 0');
  }
  if (!lotColNames3.has('dispatched_bags')) {
    await db.exec('ALTER TABLE inventory_lots ADD COLUMN dispatched_bags INTEGER NOT NULL DEFAULT 0');
  }
  if (!lotColNames3.has('extra_torn_bags')) {
    await db.exec('ALTER TABLE inventory_lots ADD COLUMN extra_torn_bags INTEGER NOT NULL DEFAULT 0');
  }

  const dryCols = (await db.prepare('PRAGMA table_info(paddy_drying_batches)').all()) as Array<{ name: string }>;
  const dryColNames = new Set(dryCols.map((c) => c.name));
  if (!dryColNames.has('purchase_id')) {
    await db.exec('ALTER TABLE paddy_drying_batches ADD COLUMN purchase_id INTEGER');
  }
  if (!dryColNames.has('input_bags')) {
    await db.exec('ALTER TABLE paddy_drying_batches ADD COLUMN input_bags INTEGER NOT NULL DEFAULT 0');
  }
  if (!dryColNames.has('output_bags')) {
    await db.exec('ALTER TABLE paddy_drying_batches ADD COLUMN output_bags INTEGER NOT NULL DEFAULT 0');
  }
  if (!dryColNames.has('dispatched_bags')) {
    await db.exec('ALTER TABLE paddy_drying_batches ADD COLUMN dispatched_bags INTEGER NOT NULL DEFAULT 0');
  }
  if (!dryColNames.has('extra_torn_bags')) {
    await db.exec('ALTER TABLE paddy_drying_batches ADD COLUMN extra_torn_bags INTEGER NOT NULL DEFAULT 0');
  }
  if (!dryColNames.has('weight_pending')) {
    await db.exec('ALTER TABLE paddy_drying_batches ADD COLUMN weight_pending INTEGER NOT NULL DEFAULT 0');
  }
  if (!dryColNames.has('exit_settlement_unit_kg')) {
    await db.exec('ALTER TABLE paddy_drying_batches ADD COLUMN exit_settlement_unit_kg REAL NOT NULL DEFAULT 75.5');
  }
  if (!dryColNames.has('exit_settlement_rate')) {
    await db.exec('ALTER TABLE paddy_drying_batches ADD COLUMN exit_settlement_rate REAL NOT NULL DEFAULT 0');
  }
  if (!dryColNames.has('exit_total_value')) {
    await db.exec('ALTER TABLE paddy_drying_batches ADD COLUMN exit_total_value REAL NOT NULL DEFAULT 0');
  }
  if (!dryColNames.has('notes')) {
    await db.exec('ALTER TABLE paddy_drying_batches ADD COLUMN notes TEXT');
  }

  const psCols2 = (await db.prepare('PRAGMA table_info(paddy_sales)').all()) as Array<{ name: string }>;
  const psColNames2 = new Set(psCols2.map((c) => c.name));
  if (!psColNames2.has('source_lot_id')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN source_lot_id INTEGER');
  }
  if (!psColNames2.has('extra_torn_bags')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN extra_torn_bags INTEGER NOT NULL DEFAULT 0');
  }
  if (!psColNames2.has('chatal_batch_id')) {
    await db.exec('ALTER TABLE paddy_sales ADD COLUMN chatal_batch_id INTEGER');
  }

  const lotCols4 = (await db.prepare('PRAGMA table_info(inventory_lots)').all()) as Array<{ name: string }>;
  const lotColNames4 = new Set(lotCols4.map((c) => c.name));
  if (!lotColNames4.has('chatal_batch_id')) {
    await db.exec('ALTER TABLE inventory_lots ADD COLUMN chatal_batch_id INTEGER');
  }

  const pbColsChatal = (await db.prepare('PRAGMA table_info(production_batches)').all()) as Array<{ name: string }>;
  const pbColNamesChatal = new Set(pbColsChatal.map((c) => c.name));
  if (!pbColNamesChatal.has('chatal_batch_id')) {
    await db.exec('ALTER TABLE production_batches ADD COLUMN chatal_batch_id INTEGER');
  }

  await db.exec(`
    CREATE TABLE IF NOT EXISTS chatal_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_uuid TEXT NOT NULL UNIQUE,
      chatal_no TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      chatal_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      paddy_item_id INTEGER NOT NULL REFERENCES items(id),
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      total_intake_bags INTEGER NOT NULL DEFAULT 0,
      total_intake_kg REAL NOT NULL DEFAULT 0,
      total_paddy_cost REAL NOT NULL DEFAULT 0,
      drying_cost REAL NOT NULL DEFAULT 0,
      khamal_cost REAL NOT NULL DEFAULT 0,
      other_cost REAL NOT NULL DEFAULT 0,
      moisture_loss_kg REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      qr_code_uid TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES employees(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      closed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS chatal_batch_inputs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatal_batch_id INTEGER NOT NULL REFERENCES chatal_batches(id) ON DELETE CASCADE,
      source_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      paddy_item_id INTEGER NOT NULL REFERENCES items(id),
      purchase_id INTEGER,
      lot_id INTEGER,
      bag_count INTEGER NOT NULL DEFAULT 0,
      qty_kg REAL NOT NULL,
      unit_divisor REAL NOT NULL DEFAULT 75.5,
      net_units REAL NOT NULL DEFAULT 0,
      bag_unit_rate REAL NOT NULL DEFAULT 0,
      paddy_cost REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_by INTEGER REFERENCES employees(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatal_batch_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatal_batch_id INTEGER NOT NULL REFERENCES chatal_batches(id) ON DELETE CASCADE,
      expense_type TEXT NOT NULL DEFAULT 'DRYING',
      vendor_name TEXT DEFAULT '',
      total_amount REAL NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'PAID',
      paid_amount REAL NOT NULL DEFAULT 0,
      account_id INTEGER,
      paid_at TEXT,
      notes TEXT DEFAULT '',
      created_by INTEGER REFERENCES employees(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatal_expense_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_no TEXT,
      expense_id INTEGER NOT NULL REFERENCES chatal_batch_expenses(id) ON DELETE CASCADE,
      chatal_batch_id INTEGER NOT NULL REFERENCES chatal_batches(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      amount REAL NOT NULL,
      payment_mode TEXT NOT NULL DEFAULT 'CASH',
      reference_no TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      paid_by INTEGER REFERENCES employees(id),
      paid_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chatal_batch_dispatches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chatal_batch_id INTEGER NOT NULL REFERENCES chatal_batches(id) ON DELETE CASCADE,
      round_no INTEGER NOT NULL DEFAULT 1,
      from_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      dest_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      dest_lot_id INTEGER REFERENCES inventory_lots(id),
      paddy_item_id INTEGER NOT NULL REFERENCES items(id),
      bag_count INTEGER NOT NULL DEFAULT 0,
      qty_kg REAL NOT NULL DEFAULT 0,
      weight_pending INTEGER NOT NULL DEFAULT 0,
      allocated_cost REAL NOT NULL DEFAULT 0,
      sale_style_unit_kg REAL NOT NULL DEFAULT 75.5,
      sale_style_rate REAL NOT NULL DEFAULT 0,
      sale_style_est_value REAL NOT NULL DEFAULT 0,
      notes TEXT DEFAULT '',
      created_by INTEGER REFERENCES employees(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

export async function initDatabase(): Promise<void> {
  if (isPostgres) {
    await initPostgresSchema();
  } else if (isMysql) {
    await initMysqlSchema();
  } else {
    await initSqliteSchema();
  }

  const empCount = Number(((await db.prepare('SELECT COUNT(*) as c FROM employees').get()) as { c: number }).c);
  if (empCount === 0) {
    await seedInitialData();
    await seedMasterCatalogDefaults();
  } else {
    await db
      .prepare(
        "INSERT OR IGNORE INTO accounts (account_code, name, account_type, balance, is_system) VALUES ('2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0, 1)"
      )
      .run();
  }

  await ensureGodownKeeperRoleAndUser();
  await syncPostgresSequences();
}

export async function getOrCreateServerJwtSecret(): Promise<string> {
  const envSecret = (process.env.JWT_SECRET || '').trim();
  if (envSecret) return envSecret;

  const existing = (await db
    .prepare("SELECT meta_value FROM app_meta WHERE meta_key = 'jwt_secret'")
    .get()) as { meta_value?: string } | undefined;
  if (existing?.meta_value) {
    return existing.meta_value;
  }

  const generated = crypto.randomBytes(32).toString('hex');
  await db
    .prepare("INSERT OR IGNORE INTO app_meta (meta_key, meta_value) VALUES ('jwt_secret', ?)")
    .run(generated);
  const stored = (await db
    .prepare("SELECT meta_value FROM app_meta WHERE meta_key = 'jwt_secret'")
    .get()) as { meta_value?: string } | undefined;
  return stored?.meta_value || generated;
}

async function ensureGodownKeeperRoleAndUser(): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO roles (code, name, description) VALUES ('GODOWN_KEEPER', 'Godown Keeper (গোডাউন কিপার)', 'Physical paddy intake, bag ledger, godown stock & transfers only (no monetary access)')"
    )
    .run();
  const gkRole = (await db.prepare("SELECT id FROM roles WHERE code = 'GODOWN_KEEPER'").get()) as { id: number } | undefined;
  if (!gkRole) return;

  const gkPermKeys = ['dashboard.view', 'paddy.purchase.create', 'stock.transfer', 'weighbridge.operate', 'qr.scan'];
  const getPermId = db.prepare('SELECT id FROM permissions WHERE perm_key = ?');
  const insertRp = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
  for (const key of gkPermKeys) {
    const p = (await getPermId.get(key)) as { id: number } | undefined;
    if (p) await insertRp.run(gkRole.id, p.id);
  }

  const existingGkEmp = (await db.prepare('SELECT id FROM employees WHERE role_id = ? LIMIT 1').get(gkRole.id)) as
    | { id: number }
    | undefined;
  if (!existingGkEmp) {
    const hash = bcrypt.hashSync('Mill@2026', 10);
    await db
      .prepare(
        'INSERT OR IGNORE INTO employees (employee_code, full_name, email, phone, password_hash, role_id) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run('EMP-006', 'রতন মণ্ডল (গোডাউন কিপার)', 'godown@sonagrain.com', '+880 1711-000606', hash, gkRole.id);
  }
}

async function seedMasterCatalogDefaults(): Promise<void> {
  const unitCount = Number(((await db.prepare('SELECT COUNT(*) as c FROM product_units').get()) as { c: number }).c);
  if (unitCount === 0) {
    const insertUnit = db.prepare(
      'INSERT INTO product_units (code, name, symbol, base_weight_kg, description, is_active) VALUES (?, ?, ?, ?, ?, 1)'
    );
    await insertUnit.run('KG', 'Kilogram', 'kg', 1, 'Standard base weight unit for weighbridge and stock valuation');
    await insertUnit.run('BAG', 'Standard Mill Bag (50 kg)', 'bag', 50, 'Packed rice and bran sack equivalent to 50 kg');
    await insertUnit.run('PADBAG', 'Paddy Gunny Sack (60 kg)', 'sack', 60, 'Raw paddy farm arrival jute sack');
    await insertUnit.run('QTL', 'Quintal', 'qtl', 100, 'Wholesale grain trading unit (100 kg)');
    await insertUnit.run('MT', 'Metric Ton', 'MT', 1000, 'Bulk mill capacity & institutional dispatch unit (1,000 kg)');
  }

  const catCount = Number(((await db.prepare('SELECT COUNT(*) as c FROM product_categories').get()) as { c: number }).c);
  if (catCount === 0) {
    const insertCat = db.prepare(
      'INSERT INTO product_categories (code, name, group_type, default_costing_method, description, is_active) VALUES (?, ?, ?, ?, ?, 1)'
    );
    await insertCat.run('PADDY', 'Raw Paddy', 'RAW_MATERIAL', 'FIFO', 'Unmilled farm paddy varieties procured for drying or milling');
    await insertCat.run('HEAD_RICE', 'Head Rice', 'FINISHED_GOOD', 'FIFO', 'Whole parboiled (Siddho) and raw (Atap) finished rice');
    await insertCat.run('BROKEN_RICE', 'Broken Rice (Khud)', 'BY_PRODUCT', 'WEIGHTED_AVERAGE', 'Grading broken rice fractions from milling');
    await insertCat.run('RICE_BRAN', 'Rice Bran (Kura)', 'BY_PRODUCT', 'WEIGHTED_AVERAGE', 'Polishing bran sold to solvent oil extraction mills');
    await insertCat.run('HUSK', 'Paddy Husk (Tush)', 'BY_PRODUCT', 'WEIGHTED_AVERAGE', 'Hulling husk used for parboiling boilers and sale');
  }
}

async function seedInitialData(): Promise<void> {
  const tx = db.transaction(async () => {
    const insertRole = db.prepare('INSERT OR IGNORE INTO roles (id, code, name, description) VALUES (?, ?, ?, ?)');
    await insertRole.run(1, 'OWNER', 'Mill Owner / Admin', 'Full unrestricted access including financial overrides, backups, and RBAC');
    await insertRole.run(2, 'MANAGER', 'Mill Manager', 'Operations across godowns, purchases, drying, milling, and sales');
    await insertRole.run(3, 'WEIGHBRIDGE', 'Weighbridge Operator', 'Paddy purchase weigh-ins, weight discrepancy logging, and QR tagging');
    await insertRole.run(4, 'PRODUCTION', 'Production Supervisor', 'Drying batches, Siddho/Atap production runs, and cost sheets');
    await insertRole.run(5, 'ACCOUNTANT', 'Chief Accountant', 'Cash/bank vouchers, party payments, financial reports, and audit logs');
    await insertRole.run(6, 'SALES', 'Sales & Dispatch Officer', 'Direct paddy sales, rice & by-product invoicing, and gate-pass QR');
    await insertRole.run(7, 'GODOWN_KEEPER', 'Godown Keeper (গোডাউন কিপার)', 'Physical paddy intake, bag ledger, godown stock & transfers only (no monetary access)');

    const perms = [
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
    const insertPerm = db.prepare('INSERT OR IGNORE INTO permissions (id, perm_key, module, description) VALUES (?, ?, ?, ?)');
    const insertRp = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)');
    for (let idx = 0; idx < perms.length; idx++) {
      const p = perms[idx];
      const pid = idx + 1;
      await insertPerm.run(pid, p[0], p[1], p[2]);
      await insertRp.run(1, pid);
      if (!['employees.manage', 'backup.manage'].includes(p[0])) await insertRp.run(2, pid);
      if (['dashboard.view', 'paddy.purchase.create', 'weighbridge.operate', 'qr.scan'].includes(p[0])) await insertRp.run(3, pid);
      if (['dashboard.view', 'drying.manage', 'production.manage', 'stock.transfer', 'qr.scan'].includes(p[0])) await insertRp.run(4, pid);
      if (['dashboard.view', 'accounting.view', 'accounting.post', 'parties.manage', 'reports.export', 'audit.view'].includes(p[0])) await insertRp.run(5, pid);
      if (['dashboard.view', 'paddy.sale.create', 'rice.sale.create', 'parties.manage', 'qr.scan', 'reports.export'].includes(p[0])) await insertRp.run(6, pid);
      if (['dashboard.view', 'paddy.purchase.create', 'stock.transfer', 'weighbridge.operate', 'qr.scan'].includes(p[0])) await insertRp.run(7, pid);
    }

    const adminHash = bcrypt.hashSync('admin', 10);
    const hash = bcrypt.hashSync('Mill@2026', 10);
    const insertEmp = db.prepare(
      'INSERT OR IGNORE INTO employees (id, employee_code, full_name, email, phone, password_hash, role_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    await insertEmp.run(1, 'EMP-001', 'Admin', 'admin@gmail.com', '+880 1711-000000', adminHash, 1);
    await insertEmp.run(2, 'EMP-002', 'Suman Das', 'weighbridge@sonagrain.com', '+91 98300 11002', hash, 3);
    await insertEmp.run(3, 'EMP-003', 'Prakash Sen', 'production@sonagrain.com', '+91 98300 11003', hash, 4);
    await insertEmp.run(4, 'EMP-004', 'Meera Chatterjee', 'accounts@sonagrain.com', '+91 98300 11004', hash, 5);
    await insertEmp.run(5, 'EMP-005', 'Debashis Paul', 'sales@sonagrain.com', '+91 98300 11005', hash, 6);
    await insertEmp.run(6, 'EMP-006', 'রতন মণ্ডল (গোডাউন কিপার)', 'godown@sonagrain.com', '+880 1711-000606', hash, 7);

    const insertAcc = db.prepare('INSERT OR IGNORE INTO accounts (id, account_code, name, account_type, balance) VALUES (?, ?, ?, ?, ?)');
    await insertAcc.run(1, '1001', 'Cash in Hand (Mill Counter)', 'ASSET', 0);
    await insertAcc.run(2, '1002', 'State Bank Current A/C', 'ASSET', 0);
    await insertAcc.run(3, '1100', 'Accounts Receivable (Customers)', 'ASSET', 0);
    await insertAcc.run(4, '1200', 'Paddy & Rice Inventory', 'ASSET', 0);
    await insertAcc.run(5, '2001', 'Accounts Payable (Suppliers)', 'LIABILITY', 0);
    await insertAcc.run(6, '3001', 'Owner Capital Equity', 'EQUITY', 0);
    await insertAcc.run(7, '4001', 'Rice & By-Product Sales Revenue', 'REVENUE', 0);
    await insertAcc.run(8, '4002', 'Direct Paddy Sales Revenue', 'REVENUE', 0);
    await insertAcc.run(9, '5001', 'Cost of Goods Sold (COGS)', 'EXPENSE', 0);
    await insertAcc.run(10, '5100', 'Milling Power, Fuel & Labor Expense', 'EXPENSE', 0);
    await insertAcc.run(11, '5200', 'Weight Discrepancy & Drying Variance', 'EXPENSE', 0);
    await insertAcc.run(12, '5300', 'Transport, Freight & Loading Expense', 'EXPENSE', 0);
    await insertAcc.run(13, '5400', 'Mill Rent, Office & Admin Expense', 'EXPENSE', 0);
    await insertAcc.run(14, '2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0);
  });
  await tx();
}

export async function resetAndSeedDemoData(employeeId = 1, employeeName = 'Arjun Roy'): Promise<void> {
  const tx = db.transaction(async () => {
    const tablesToWipe = [
      'sales_invoice_lot_allocations',
      'stock_ledger',
      'production_outputs',
      'production_expense_payments',
      'production_batch_expenses',
      'production_batch_inputs',
      'production_cost_sheets',
      'production_batches',
      'paddy_drying_batches',
      'sales_invoice_items',
      'sales_invoices',
      'paddy_purchase_returns',
      'paddy_sales',
      'stock_transfers',
      'supplier_bag_ledger',
      'paddy_purchases',
      'weighbridge_logs',
      'inventory_lots',
      'payments',
      'journal_lines',
      'journal_entries',
      'qr_tags',
      'sync_logs',
      'audit_logs',
      'parties',
      'items',
      'warehouses',
      'product_categories',
      'product_units',
    ];
    for (const tbl of tablesToWipe) {
      await db.prepare(`DELETE FROM \`${tbl}\``).run();
      await resetAutoIncrement(tbl);
    }

    const empRow = (await db.prepare('SELECT id FROM employees ORDER BY id ASC LIMIT 1').get()) as { id: number } | undefined;
    const emp1 = empRow?.id || employeeId;
    const emp2 = ((await db.prepare('SELECT id FROM employees ORDER BY id ASC LIMIT 1 OFFSET 1').get()) as { id: number } | undefined)?.id || emp1;
    const emp3 = ((await db.prepare('SELECT id FROM employees ORDER BY id ASC LIMIT 1 OFFSET 2').get()) as { id: number } | undefined)?.id || emp1;
    const emp4 = ((await db.prepare('SELECT id FROM employees ORDER BY id ASC LIMIT 1 OFFSET 3').get()) as { id: number } | undefined)?.id || emp1;
    const emp5 = ((await db.prepare('SELECT id FROM employees ORDER BY id ASC LIMIT 1 OFFSET 4').get()) as { id: number } | undefined)?.id || emp1;

    await seedMasterCatalogDefaults();

    const insertWh = db.prepare(
      'INSERT INTO warehouses (id, code, name, warehouse_type, location, capacity_kg, manager_employee_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
    );
    await insertWh.run(1, 'GD-RAW-01', 'North Raw Paddy Godown A', 'RAW_PADDY', 'Gate 1 - East Wing', 500000, emp1);
    await insertWh.run(2, 'GD-DRY-01', 'Mechanical Dryer & Chatal Yard', 'DRYING_YARD', 'Central Milling Block', 200000, emp3);
    await insertWh.run(3, 'GD-FIN-01', 'Finished Rice Warehouse C', 'FINISHED_RICE', 'Dispatch Bay 2', 350000, emp1);
    await insertWh.run(4, 'GD-BYP-01', 'By-Product & Husk Silo D', 'BY_PRODUCT', 'Boiler Wing South', 250000, emp3);

    const insertItem = db.prepare(
      'INSERT INTO items (id, sku, name, category, process_grade, unit, bag_weight_kg, costing_method, default_rate, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
    );
    await insertItem.run(1, 'PAD-MIN-01', 'Miniket Raw Paddy', 'PADDY', 'RAW_PADDY', 'KG', 60, 'FIFO', 24.5);
    await insertItem.run(2, 'PAD-SWA-01', 'Swarna Raw Paddy', 'PADDY', 'RAW_PADDY', 'KG', 60, 'WEIGHTED_AVERAGE', 21.5);
    await insertItem.run(3, 'PAD-GOB-01', 'Gobindobhog Aromatic Paddy', 'PADDY', 'RAW_PADDY', 'KG', 50, 'FIFO', 38.5);
    await insertItem.run(4, 'RIC-SID-MIN', 'Miniket Parboiled Rice (Siddho)', 'HEAD_RICE', 'SIDDHO', 'KG', 50, 'FIFO', 49.0);
    await insertItem.run(5, 'RIC-SID-SWA', 'Swarna Parboiled Rice (Siddho)', 'HEAD_RICE', 'SIDDHO', 'KG', 50, 'WEIGHTED_AVERAGE', 39.5);
    await insertItem.run(6, 'RIC-ATP-GOB', 'Gobindobhog Raw Rice (Atap)', 'HEAD_RICE', 'ATAP', 'KG', 50, 'FIFO', 74.0);
    await insertItem.run(7, 'BYP-BRK-01', 'Broken Rice (Khud)', 'BROKEN_RICE', 'BY_PRODUCT', 'KG', 50, 'WEIGHTED_AVERAGE', 22.5);
    await insertItem.run(8, 'BYP-BRN-01', 'Rice Bran (Kura)', 'RICE_BRAN', 'BY_PRODUCT', 'KG', 50, 'WEIGHTED_AVERAGE', 18.5);
    await insertItem.run(9, 'BYP-HSK-01', 'Paddy Husk (Tush)', 'HUSK', 'BY_PRODUCT', 'KG', 35, 'WEIGHTED_AVERAGE', 5.5);
    await insertItem.run(10, 'BYP-MRM-01', 'মরা মাছি (Mora Machi 25kg)', 'BY_PRODUCT', 'BY_PRODUCT', 'KG', 25, 'WEIGHTED_AVERAGE', 14.0);
    await insertItem.run(11, 'BYP-DKH-01', 'ডায়মন্ড খুদি (Diamond Khudi 50kg)', 'BROKEN_RICE', 'BY_PRODUCT', 'KG', 50, 'WEIGHTED_AVERAGE', 26.0);

    const insertParty = db.prepare(
      'INSERT INTO parties (id, party_code, party_type, name, contact_person, phone, email, tax_id, address, credit_limit, opening_balance, current_balance, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)'
    );
    await insertParty.run(1, 'SUP-001', 'SUPPLIER', 'Burdwan Agro Paddy Co-op', 'Ramesh Mondal', '+91 94340 22101', 'burdwan.coop@example.in', '19AABCU9603R1ZM', 'Memari Mandi, Purba Bardhaman', 0, 0, -345000);
    await insertParty.run(2, 'SUP-002', 'SUPPLIER', 'Hooghly Kisan Traders', 'Subhash Ghosh', '+91 98311 44090', 'kisan.hooghly@example.in', '19AAACH7409R1Z2', 'Tarakeswar Agri Yard, Hooghly', 0, 0, -125000);
    await insertParty.run(3, 'SUP-003', 'SUPPLIER', 'Birbhum Harvest Farmers Co-op', 'Anupam Sarkar', '+91 97345 66210', 'birbhum.coop@example.in', '19AABCB4412P1Z9', 'Bolpur Mandi, Birbhum', 0, 0, 75000);
    await insertParty.run(4, 'CUS-001', 'CUSTOMER', 'Bengal Wholesale Grain House', 'Anirban Dutta', '+91 98301 55820', 'orders@bengalgrain.in', '19AAACB5512K1Z8', 'Posta Bazar, Kolkata 700007', 2500000, 0, 80000);
    await insertParty.run(5, 'CUS-002', 'CUSTOMER', 'Eastern Solvent & Bran Oil Ltd', 'Kalyan Mukherjee', '+91 99032 88310', 'procurement@easternbran.in', '19AABCE3390L1Z5', 'Dankuni Industrial Estate', 1500000, 0, -50000);
    await insertParty.run(6, 'BOTH-001', 'BOTH', 'Nadia Agri Mandi Syndicate', 'Tapas Saha', '+91 97325 19004', 'nadia.mandi@example.in', '19AAACN8821M1Z1', 'Krishnanagar, Nadia', 1000000, 0, 50000);

    const defaultAccounts = [
      ['1001', 'Cash in Hand (Mill Counter)', 'ASSET', 485000],
      ['1002', 'State Bank Current A/C #4089', 'ASSET', 3920000],
      ['1100', 'Accounts Receivable (Customers)', 'ASSET', 130000],
      ['1200', 'Paddy & Rice Inventory', 'ASSET', 4118985],
      ['2001', 'Accounts Payable (Suppliers)', 'LIABILITY', 470000],
      ['2002', 'Accrued Milling & Vendor Expenses Payable', 'LIABILITY', 0],
      ['3001', 'Owner Capital Equity', 'EQUITY', 8241419.5],
      ['4001', 'Rice & By-Product Sales Revenue', 'REVENUE', 157900],
      ['4002', 'Direct Paddy Sales Revenue', 'REVENUE', 114000],
      ['5001', 'Cost of Goods Sold (COGS)', 'EXPENSE', 197934.5],
      ['5100', 'Milling Power, Fuel & Labor Expense', 'EXPENSE', 124600],
      ['5200', 'Weight Discrepancy & Drying Variance', 'EXPENSE', 6800],
      ['5300', 'Transport, Freight & Loading Expense', 'EXPENSE', 0],
      ['5400', 'Mill Rent, Office & Admin Expense', 'EXPENSE', 0],
    ] as const;

    await db.prepare('UPDATE accounts SET balance = 0').run();

    for (const [code, name, type, bal] of defaultAccounts) {
      const existingAcc = (await db.prepare('SELECT id FROM accounts WHERE account_code = ?').get(code)) as { id: number } | undefined;
      if (existingAcc) {
        await db.prepare('UPDATE accounts SET balance = ? WHERE id = ?').run(bal, existingAcc.id);
      } else {
        await db
          .prepare('INSERT INTO accounts (account_code, name, account_type, balance, is_system) VALUES (?, ?, ?, ?, 1)')
          .run(code, name, type, bal);
      }
    }
    const accCash = ((await db.prepare("SELECT id FROM accounts WHERE account_code = '1001'").get()) as { id: number }).id;
    const accBank = ((await db.prepare("SELECT id FROM accounts WHERE account_code = '1002'").get()) as { id: number }).id;
    const accAr = ((await db.prepare("SELECT id FROM accounts WHERE account_code = '1100'").get()) as { id: number }).id;
    const accInv = ((await db.prepare("SELECT id FROM accounts WHERE account_code = '1200'").get()) as { id: number }).id;
    const accAp = ((await db.prepare("SELECT id FROM accounts WHERE account_code = '2001'").get()) as { id: number }).id;
    const accRevRice = ((await db.prepare("SELECT id FROM accounts WHERE account_code = '4001'").get()) as { id: number }).id;
    const accCogs = ((await db.prepare("SELECT id FROM accounts WHERE account_code = '5001'").get()) as { id: number }).id;

    const lot1Uid = crypto.randomUUID();
    const lot2Uid = crypto.randomUUID();
    const lot3Uid = crypto.randomUUID();
    const lot4Uid = crypto.randomUUID();
    const lot5Uid = crypto.randomUUID();
    const lot6Uid = crypto.randomUUID();
    const lot7Uid = crypto.randomUUID();
    const lot8Uid = crypto.randomUUID();
    const lot9Uid = crypto.randomUUID();
    const lot10Uid = crypto.randomUUID();

    const insertLot = db.prepare(
      'INSERT INTO inventory_lots (id, lot_code, qr_code_uid, item_id, warehouse_id, source_type, source_id, initial_qty_kg, remaining_qty_kg, initial_bags, remaining_bags, unit_cost_per_kg, moisture_pct, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    await insertLot.run(1, 'LOT-PAD-2601', lot1Uid, 1, 1, 'PADDY_PURCHASE', 1, 44820, 25820, 750, 432, 23.3155, 14.2, '2026-11-10 09:30:00');
    await insertLot.run(2, 'LOT-PAD-2602', lot2Uid, 2, 1, 'PADDY_PURCHASE', 2, 48000, 40000, 800, 667, 20.625, 16.5, '2026-11-12 14:15:00');
    await insertLot.run(3, 'LOT-PAD-2603', lot3Uid, 3, 1, 'PADDY_PURCHASE', 3, 18650, 0, 373, 0, 36.4772, 17.8, '2026-11-13 10:00:00');
    await insertLot.run(4, 'LOT-DRY-2601', lot4Uid, 3, 2, 'DRYING_OUTPUT', 1, 18000, 10000, 300, 167, 38.45, 13.0, '2026-11-14 11:00:00');
    await insertLot.run(5, 'LOT-TRF-2601', lot5Uid, 2, 2, 'STOCK_TRANSFER', 1, 8000, 8000, 133, 133, 20.625, 16.5, '2026-11-14 16:20:00');
    await insertLot.run(6, 'LOT-RIC-2601', lot6Uid, 4, 3, 'PRODUCTION_OUTPUT', 1, 9750, 7250, 195, 145, 37.8138, 12.5, '2026-11-15 18:45:00');
    await insertLot.run(7, 'LOT-RIC-2602', lot7Uid, 6, 3, 'PRODUCTION_OUTPUT', 2, 5120, 5120, 102, 102, 61.0996, 12.0, '2026-11-16 17:30:00');
    await insertLot.run(8, 'LOT-BYP-2601', lot8Uid, 7, 4, 'PRODUCTION_OUTPUT', 1, 1600, 1600, 32, 32, 22.0, null, '2026-11-15 18:45:00');
    await insertLot.run(9, 'LOT-BYP-2602', lot9Uid, 8, 4, 'PRODUCTION_OUTPUT', 1, 1610, 410, 32, 8, 18.5, null, '2026-11-15 18:45:00');
    await insertLot.run(10, 'LOT-BYP-2603', lot10Uid, 9, 4, 'PRODUCTION_OUTPUT', 1, 4330, 4330, 87, 87, 5.5, null, '2026-11-15 18:45:00');

    const pur1Uid = crypto.randomUUID();
    const pur2Uid = crypto.randomUUID();
    const pur3Uid = crypto.randomUUID();
    const insertPurchase = db.prepare(
      `INSERT INTO paddy_purchases (
        id, client_uuid, purchase_no, supplier_id, warehouse_id, item_id, vehicle_no, challan_no,
        bag_count, jute_bag_count, plastic_bag_count, moisture_pct, supplier_claimed_weight_kg, scale_weight_kg, received_weight_kg,
        payment_weight_kg, weight_loss_kg, settlement_unit_kg, settlement_rate,
        weight_discrepancy_kg, discrepancy_flagged, discrepancy_notes,
        rate_per_kg, total_payable, paid_amount, payment_status, qr_code_uid, weighbridge_mode, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await insertPurchase.run(
      1, pur1Uid, 'PUR-2026-0001', 1, 1, 1, 'WB-41-G-8821', 'CH-MEM-401',
      750, 450, 300, 14.2, 45250, 45000, 44820, 44820, 320, 75.5, 1773.2, -250, 1,
      'Supplier challan claimed 45,250 kg; weighbridge recorded 45,000 kg (-250 kg shortage) and 320 kg dust/moisture loss.',
      23.3155, 1045000, 700000, 'PARTIAL', lot1Uid, 'USB_SERIAL', emp2, '2026-11-10 09:30:00'
    );
    await insertPurchase.run(
      2, pur2Uid, 'PUR-2026-0002', 2, 1, 2, 'WB-15-T-2104', 'CH-TAR-118',
      800, 500, 300, 16.5, 48000, 48000, 48000, 48000, 500, 75.5, 1573.58, 0, 0,
      'Exact scale match; 500 kg moisture loss deducted via settlement formula.',
      20.625, 990000, 840000, 'PARTIAL', lot2Uid, 'MANUAL', emp2, '2026-11-12 14:15:00'
    );
    await insertPurchase.run(
      3, pur3Uid, 'PUR-2026-0003', 1, 1, 3, 'WB-41-A-9032', 'CH-MEM-419',
      373, 200, 173, 17.8, 18700, 18650, 18650, 18650, 150, 75.5, 2776.22, -50, 1,
      'High moisture aromatic lot routed for mechanical drying.',
      36.4772, 680300, 680300, 'PAID', lot3Uid, 'BLUETOOTH_SPP', emp2, '2026-11-13 10:00:00'
    );

    const insBagDemo = db.prepare(
      `INSERT INTO supplier_bag_ledger (
        client_uuid, entry_no, supplier_id, entry_type, direction,
        jute_qty, plastic_qty, total_qty, reference_type, reference_id, reference_no, entry_date, notes, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await insBagDemo.run(crypto.randomUUID(), 'BAG-2026-0001', 1, 'ADVANCE_ISSUE', 'OUT_TO_SUPPLIER', 700, 500, 1200, 'MANUAL', null, 'ADV-BAG-01', '2026-11-08', 'Advance empty jute & plastic sacks taken by supplier', emp2, '2026-11-08 10:00:00');
    await insBagDemo.run(crypto.randomUUID(), 'BAG-2026-0002', 1, 'PADDY_DEPOSIT', 'IN_FROM_SUPPLIER', 450, 300, 750, 'PADDY_PURCHASE', 1, 'PUR-2026-0001', '2026-11-10', 'Bags deposited with Miniket purchase PUR-2026-0001', emp2, '2026-11-10 09:30:00');
    await insBagDemo.run(crypto.randomUUID(), 'BAG-2026-0003', 1, 'PADDY_DEPOSIT', 'IN_FROM_SUPPLIER', 200, 173, 373, 'PADDY_PURCHASE', 3, 'PUR-2026-0003', '2026-11-13', 'Bags deposited with Gobindobhog purchase PUR-2026-0003', emp2, '2026-11-13 10:00:00');
    await insBagDemo.run(crypto.randomUUID(), 'BAG-2026-0004', 2, 'PADDY_DEPOSIT', 'IN_FROM_SUPPLIER', 500, 300, 800, 'PADDY_PURCHASE', 2, 'PUR-2026-0002', '2026-11-12', 'Bags deposited with Swarna purchase PUR-2026-0002', emp2, '2026-11-12 14:15:00');
    await insBagDemo.run(crypto.randomUUID(), 'BAG-2026-0005', 2, 'EMPTY_PICKUP', 'OUT_TO_SUPPLIER', 150, 100, 250, 'MANUAL', null, 'PKP-BAG-01', '2026-11-14', 'Empty bags picked up by supplier after paddy deposit', emp2, '2026-11-14 15:00:00');
    await insBagDemo.run(crypto.randomUUID(), 'BAG-2026-0006', 3, 'ADVANCE_ISSUE', 'OUT_TO_SUPPLIER', 100, 150, 250, 'MANUAL', null, 'ADV-BAG-02', '2026-11-15', 'Advance empty bags taken by Birbhum Co-op', emp2, '2026-11-15 11:00:00');

    const trf1Uid = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO stock_transfers (id, client_uuid, transfer_no, from_warehouse_id, to_warehouse_id, item_id, qty_kg, bag_count, unit_divisor, net_units, bag_unit_rate, costing_method, total_cost, vehicle_or_driver, notes, qr_code_uid, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        1, trf1Uid, 'TRF-2026-0001', 1, 2, 2, 8000, 133, 75.5, 104.1987, 1583.51, 'FIFO', 165000, 'Mill Tractor #2 (Haru)', 'Moved Swarna wet lot to dryer yard bay', lot5Uid, emp3, '2026-11-14 16:20:00'
      );

    await db
      .prepare(
        `INSERT INTO paddy_drying_batches (
          id, client_uuid, drying_no, source_warehouse_id, dest_warehouse_id, item_id, drying_method,
          input_qty_kg, initial_moisture_pct, final_moisture_pct, output_qty_kg, moisture_loss_kg,
          fuel_power_cost, labor_cost, input_paddy_cost, output_unit_cost_per_kg, status, qr_code_uid, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        1, crypto.randomUUID(), 'DRY-2026-0001', 1, 2, 3, 'MECHANICAL_DRYER',
        18650, 17.8, 13.0, 18000, 650, 8200, 3600, 680300, 38.45, 'COMPLETED', lot4Uid, emp3, '2026-11-14 11:00:00'
      );

    const batch1Uid = crypto.randomUUID();
    const batch2Uid = crypto.randomUUID();
    const insertBatch = db.prepare(
      `INSERT INTO production_batches (
        id, client_uuid, batch_no, process_type, source_warehouse_id, paddy_item_id, input_paddy_qty_kg,
        input_bag_count, dryer_no, dryer_count, unit_divisor, paddy_net_units, paddy_bag_unit_rate, paddy_formula_cost,
        costing_method, soaking_hours, steaming_temp_c, head_rice_qty_kg, broken_rice_qty_kg, bran_qty_kg,
        husk_qty_kg, wastage_qty_kg, head_rice_yield_pct, total_recovery_pct, status, qr_code_uid, notes, created_by, started_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await insertBatch.run(
      1, batch1Uid, 'PRD-SID-2601', 'PARBOILED_SIDDHO', 1, 1, 15000,
      250, 'Dryer-1', 1, 75.5, 195.3642, 1796.65, 351000,
      'FIFO', 14.5, 112.0, 9750, 960, 1050, 2850, 390, 65.0, 97.4, 'COMPLETED', batch1Uid,
      'Double-steamed Miniket parboiled batch; boiler fired using mill husk.', emp3, '2026-11-15 06:00:00', '2026-11-15 18:45:00'
    );
    await insertBatch.run(
      2, batch2Uid, 'PRD-ATP-2602', 'RAW_ATAP', 2, 3, 8000,
      133, 'Dryer-2', 1, 75.5, 104.1987, 2952.05, 307600,
      'FIFO', 0, 0, 5120, 640, 560, 1480, 200, 64.0, 97.5, 'COMPLETED', batch2Uid,
      'Cold-milled aromatic Gobindobhog Atap run; gentle rubber-roll hulling.', emp3, '2026-11-16 08:00:00', '2026-11-16 17:30:00'
    );

    const insertProdOut = db.prepare(
      'INSERT INTO production_outputs (batch_id, item_id, warehouse_id, output_type, pack_size_kg, bag_count, qty_kg, allocated_unit_cost_per_kg, total_value, lot_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    await insertProdOut.run(1, 4, 3, 'HEAD_RICE', 50, 195, 9750, 37.8138, 368685, 6);
    await insertProdOut.run(1, 7, 4, 'BROKEN_RICE', 50, 19, 960, 22.0, 21120, 8);
    await insertProdOut.run(1, 8, 4, 'BRAN', 50, 21, 1050, 18.5, 19425, 9);
    await insertProdOut.run(1, 9, 4, 'HUSK', 35, 81, 2850, 5.5, 15675, 10);
    await insertProdOut.run(2, 6, 3, 'HEAD_RICE', 50, 102, 5120, 61.0996, 312830, 7);
    await insertProdOut.run(2, 7, 4, 'BROKEN_RICE', 50, 13, 640, 22.0, 14080, 8);
    await insertProdOut.run(2, 8, 4, 'BRAN', 50, 11, 560, 18.5, 10360, 9);
    await insertProdOut.run(2, 9, 4, 'HUSK', 35, 42, 1480, 5.5, 8140, 10);

    const insertCostSheet = db.prepare(
      `INSERT INTO production_cost_sheets (
        batch_id, raw_paddy_cost, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost,
        packaging_cost, gross_batch_cost, byproduct_credit_value, net_head_rice_cost, cost_per_kg_head_rice, cost_per_bag_head_rice
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await insertCostSheet.run(1, 351000, 18500, 24000, 11200, 9800, 10400, 424900, 56215, 368685, 37.8138, 1890.69);
    await insertCostSheet.run(2, 307600, 12000, 13400, 0, 6500, 6200, 345700, 32580, 313120, 61.1563, 3057.81);

    const insertBatchIn = db.prepare(
      `INSERT INTO production_batch_inputs (
        batch_id, source_warehouse_id, paddy_item_id, bag_count, qty_kg, unit_divisor, net_units, bag_unit_rate, paddy_cost, notes, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await insertBatchIn.run(1, 1, 1, 250, 15000, 75.5, 195.3642, 1796.65, 351000, 'প্রাথমিক মিনিকেট ধান ডায়ারে লোড', emp3, '2026-11-15 06:00:00');
    await insertBatchIn.run(2, 2, 3, 133, 8000, 75.5, 104.1987, 2952.05, 307600, 'গোবিন্দভোগ আতপ ধান ডায়ারে লোড', emp3, '2026-11-16 08:00:00');

    const insertBatchExp = db.prepare(
      `INSERT INTO production_batch_expenses (
        batch_id, expense_category, vendor_name, labor_cost, electricity_cost, fuel_boiler_cost, machinery_overhead_cost, packaging_cost,
        total_amount, payment_status, paid_amount, account_id, paid_at, notes, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await insertBatchExp.run(1, 'FUEL_BOILER', 'বয়লার ও লেবার টিম', 10000, 0, 11200, 0, 0, 21200, 'PAID', 21200, accCash, '2026-11-15 10:30:00', 'ডায়ার ও বয়লার জ্বালানি + ১ম শিফট লেবার', emp3, '2026-11-15 10:30:00');
    await insertBatchExp.run(1, 'ELECTRICITY', 'পল্লী বিদ্যুৎ ও প্যাকিং', 8500, 24000, 0, 9800, 10400, 52700, 'PAID', 52700, accCash, '2026-11-15 17:15:00', 'মিলিং বিদ্যুৎ, মেশিন ও প্যাকিং বস্তা', emp3, '2026-11-15 17:15:00');
    await insertBatchExp.run(2, 'LABOR', 'আতপ মিলিং টিম', 12000, 13400, 0, 6500, 6200, 38100, 'PAID', 38100, accCash, '2026-11-16 15:00:00', 'আতপ ক্রাশিং লেবার, বিদ্যুৎ ও প্যাকিং', emp3, '2026-11-16 15:00:00');

    const inv1Uid = crypto.randomUUID();
    const inv2Uid = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO sales_invoices (
          id, client_uuid, invoice_no, customer_id, subtotal_amount, tax_amount, discount_amount,
          total_amount, total_cogs, paid_amount, payment_status, vehicle_no, qr_code_uid, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(1, inv1Uid, 'INV-2026-0001', 4, 122500, 0, 0, 122500, 94534.5, 0, 'UNPAID', 'WB-03-C-4419', inv1Uid, emp5, '2026-11-17 11:20:00');
    await db
      .prepare(
        `INSERT INTO sales_invoice_items (invoice_id, item_id, warehouse_id, qty_kg, rate_per_kg, line_total, costing_method, line_cogs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(1, 4, 3, 2500, 49.0, 122500, 'FIFO', 94534.5);

    await db
      .prepare(
        `INSERT INTO sales_invoices (
          id, client_uuid, invoice_no, customer_id, subtotal_amount, tax_amount, discount_amount,
          total_amount, total_cogs, paid_amount, payment_status, vehicle_no, qr_code_uid, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(2, inv2Uid, 'INV-2026-0002', 5, 35400, 0, 0, 35400, 22200, 35400, 'PAID', 'WB-23-M-1102', inv2Uid, emp5, '2026-11-17 15:10:00');
    await db
      .prepare(
        `INSERT INTO sales_invoice_items (invoice_id, item_id, warehouse_id, qty_kg, rate_per_kg, line_total, costing_method, line_cogs) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(2, 8, 4, 1200, 29.5, 35400, 'WEIGHTED_AVERAGE', 22200);

    await db
      .prepare(
        `INSERT INTO sales_invoice_lot_allocations (invoice_id, invoice_item_id, lot_id, batch_id, item_id, qty_kg, bag_count, cost_per_kg, cost_amount, sale_rate_per_kg, sale_amount, profit_amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(1, 1, 6, 1, 4, 2500, 50, 37.8138, 94534.5, 49.0, 122500, 27965.5, '2026-11-17 11:20:00');
    await db
      .prepare(
        `INSERT INTO sales_invoice_lot_allocations (invoice_id, invoice_item_id, lot_id, batch_id, item_id, qty_kg, bag_count, cost_per_kg, cost_amount, sale_rate_per_kg, sale_amount, profit_amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(2, 2, 9, 1, 8, 1200, 24, 18.5, 22200, 29.5, 35400, 13200, '2026-11-17 15:10:00');

    const ps1Uid = crypto.randomUUID();
    await db
      .prepare(
        `INSERT INTO paddy_sales (
          id, client_uuid, sale_no, customer_id, warehouse_id, item_id, qty_kg, rate_per_kg, total_amount,
          costing_method, cogs_amount, paid_amount, payment_status, vehicle_no, qr_code_uid, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(1, ps1Uid, 'PS-2026-0001', 6, 1, 1, 4000, 28.5, 114000, 'FIFO', 93262, 64000, 'PARTIAL', 'WB-51-B-3309', ps1Uid, emp5, '2026-11-18 10:15:00');

    const insertLedger = db.prepare(
      `INSERT INTO stock_ledger (lot_id, item_id, warehouse_id, movement_type, reference_type, reference_id, qty_change_kg, unit_cost_per_kg, total_cost, balance_after_kg, employee_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await insertLedger.run(1, 1, 1, 'IN_PURCHASE', 'PADDY_PURCHASE', 1, 44820, 23.3155, 1045000, 44820, emp2, '2026-11-10 09:30:00');
    await insertLedger.run(2, 2, 1, 'IN_PURCHASE', 'PADDY_PURCHASE', 2, 48000, 20.625, 990000, 48000, emp2, '2026-11-12 14:15:00');
    await insertLedger.run(3, 3, 1, 'IN_PURCHASE', 'PADDY_PURCHASE', 3, 18650, 36.4772, 680300, 18650, emp2, '2026-11-13 10:00:00');
    await insertLedger.run(3, 3, 1, 'OUT_DRYING', 'DRYING_BATCH', 1, -18650, 36.4772, -680300, 0, emp3, '2026-11-14 11:00:00');
    await insertLedger.run(4, 3, 2, 'IN_DRYING', 'DRYING_BATCH', 1, 18000, 38.45, 692100, 18000, emp3, '2026-11-14 11:00:00');
    await insertLedger.run(2, 2, 1, 'OUT_TRANSFER', 'STOCK_TRANSFER', 1, -8000, 20.625, -165000, 40000, emp3, '2026-11-14 16:20:00');
    await insertLedger.run(5, 2, 2, 'IN_TRANSFER', 'STOCK_TRANSFER', 1, 8000, 20.625, 165000, 8000, emp3, '2026-11-14 16:20:00');
    await insertLedger.run(1, 1, 1, 'OUT_PRODUCTION', 'PRODUCTION_BATCH', 1, -15000, 23.3155, -349732.5, 29820, emp3, '2026-11-15 06:00:00');
    await insertLedger.run(6, 4, 3, 'IN_PRODUCTION', 'PRODUCTION_BATCH', 1, 9750, 37.8138, 368685, 9750, emp3, '2026-11-15 18:45:00');
    await insertLedger.run(4, 3, 2, 'OUT_PRODUCTION', 'PRODUCTION_BATCH', 2, -8000, 38.45, -307600, 10000, emp3, '2026-11-16 08:00:00');
    await insertLedger.run(7, 6, 3, 'IN_PRODUCTION', 'PRODUCTION_BATCH', 2, 5120, 61.0996, 312830, 5120, emp3, '2026-11-16 17:30:00');
    await insertLedger.run(6, 4, 3, 'OUT_SALE', 'SALES_INVOICE', 1, -2500, 37.8138, -94534.5, 7250, emp5, '2026-11-17 11:20:00');
    await insertLedger.run(9, 8, 4, 'OUT_SALE', 'SALES_INVOICE', 2, -1200, 18.5, -22200, 410, emp5, '2026-11-17 15:10:00');
    await insertLedger.run(1, 1, 1, 'OUT_PADDY_SALE', 'PADDY_SALE', 1, -4000, 23.3155, -93262, 25820, emp5, '2026-11-18 10:15:00');

    const insertWb = db.prepare(
      `INSERT INTO weighbridge_logs (client_uuid, ticket_no, vehicle_no, driver_name, gross_weight_kg, tare_weight_kg, net_weight_kg, device_mode, raw_device_string, linked_type, linked_id, operator_id, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await insertWb.run(crypto.randomUUID(), 'WB-2026-0101', 'WB-41-G-8821', 'Bikash Roy', 57420, 12420, 45000, 'USB_SERIAL', 'ST,GS,+045000.0 kg', 'PADDY_PURCHASE', 1, emp2, '2026-11-10 09:25:00');
    await insertWb.run(crypto.randomUUID(), 'WB-2026-0102', 'WB-15-T-2104', 'Kartic Halder', 59900, 11900, 48000, 'MANUAL', 'MANUAL_ENTRY', 'PADDY_PURCHASE', 2, emp2, '2026-11-12 14:10:00');
    await insertWb.run(crypto.randomUUID(), 'WB-2026-0103', 'WB-41-A-9032', 'Sanjoy Paul', 29850, 11200, 18650, 'BLUETOOTH_SPP', 'BT,WT,+018650.0 kg', 'PADDY_PURCHASE', 3, emp2, '2026-11-13 09:55:00');

    const insertPay = db.prepare(
      `INSERT INTO payments (client_uuid, payment_no, direction, voucher_type, party_id, account_id, amount, payment_mode, reference_no, settled_ref_no, notes, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    await insertPay.run(crypto.randomUUID(), 'PAY-2026-0001', 'PAYMENT', 'DUE_PAYMENT', 2, accBank, 25000, 'BANK_TRANSFER', 'NEFT-8821904', null, 'Part due settlement for Swarna Paddy lot', emp4, '2026-11-15 12:00:00');
    await insertPay.run(crypto.randomUUID(), 'PAY-2026-0002', 'PAYMENT', 'ADVANCE_PAYMENT', 3, accBank, 75000, 'BANK_TRANSFER', 'NEFT-8824112', null, 'Seasonal harvest advance against Gobindobhog arrival', emp4, '2026-11-16 10:30:00');
    await insertPay.run(crypto.randomUUID(), 'RCP-2026-0001', 'RECEIPT', 'DUE_RECEIPT', 4, accBank, 42500, 'UPI_MOBILE', 'UTR-99301124', 'INV-2026-0001', 'Partial receipt against Miniket Rice invoice', emp4, '2026-11-17 16:00:00');
    await insertPay.run(crypto.randomUUID(), 'RCP-2026-0002', 'RECEIPT', 'ADVANCE_RECEIPT', 5, accCash, 50000, 'CASH', 'RCPT-ADV-01', null, 'Advance booking deposit for next week Rice Bran lot', emp4, '2026-11-18 11:45:00');

    const insertJe = db.prepare(
      'INSERT INTO journal_entries (id, client_uuid, voucher_no, entry_date, description, reference_type, reference_id, is_posted, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)'
    );
    const insertJl = db.prepare(
      'INSERT INTO journal_lines (journal_entry_id, account_id, debit, credit, party_id) VALUES (?, ?, ?, ?, ?)'
    );
    await insertJe.run(1, crypto.randomUUID(), 'JV-2026-0001', '2026-11-10', 'Paddy Purchase PUR-2026-0001 (Miniket Raw Paddy)', 'PADDY_PURCHASE', 1, emp4, '2026-11-10 09:30:00');
    await insertJl.run(1, accInv, 1045000, 0, null);
    await insertJl.run(1, accBank, 0, 700000, null);
    await insertJl.run(1, accAp, 0, 345000, 1);

    await insertJe.run(2, crypto.randomUUID(), 'JV-2026-0002', '2026-11-16', 'Advance Paid PAY-2026-0002 to Birbhum Harvest Farmers Co-op', 'PAYMENT', 2, emp4, '2026-11-16 10:30:00');
    await insertJl.run(2, accAp, 75000, 0, 3);
    await insertJl.run(2, accBank, 0, 75000, null);

    await insertJe.run(3, crypto.randomUUID(), 'JV-2026-0003', '2026-11-17', 'Sales Invoice INV-2026-0001 (Bengal Wholesale Grain House)', 'SALES_INVOICE', 1, emp5, '2026-11-17 11:20:00');
    await insertJl.run(3, accAr, 122500, 0, 4);
    await insertJl.run(3, accRevRice, 0, 122500, null);
    await insertJl.run(3, accCogs, 94534.5, 0, null);
    await insertJl.run(3, accInv, 0, 94534.5, null);

    await insertJe.run(4, crypto.randomUUID(), 'JV-2026-0004', '2026-11-18', 'Customer Advance Receipt RCP-2026-0002', 'PAYMENT', 4, emp4, '2026-11-18 11:45:00');
    await insertJl.run(4, accCash, 50000, 0, null);
    await insertJl.run(4, accAr, 0, 50000, 5);

    const insertQr = db.prepare('INSERT INTO qr_tags (qr_code_uid, entity_type, entity_id, entity_code, payload_json) VALUES (?, ?, ?, ?, ?)');
    await insertQr.run(lot1Uid, 'PADDY_LOT', 1, 'LOT-PAD-2601', JSON.stringify({ item: 'Miniket Raw Paddy', warehouse: 'North Raw Paddy Godown A', qty_kg: 44820, supplier: 'Burdwan Agro Paddy Co-op' }));
    await insertQr.run(lot6Uid, 'RICE_LOT', 6, 'LOT-RIC-2601', JSON.stringify({ item: 'Miniket Parboiled Rice (Siddho)', warehouse: 'Finished Rice Warehouse C', batch: 'PRD-SID-2601', cost_per_kg: 37.8138 }));
    await insertQr.run(trf1Uid, 'STOCK_TRANSFER', 1, 'TRF-2026-0001', JSON.stringify({ item: 'Swarna Raw Paddy', from: 'GD-RAW-01', to: 'GD-DRY-01', qty_kg: 8000 }));
    await insertQr.run(batch1Uid, 'PRODUCTION_BATCH', 1, 'PRD-SID-2601', JSON.stringify({ process: 'PARBOILED_SIDDHO', input_kg: 15000, head_rice_kg: 9750, yield_pct: 65.0 }));
    await insertQr.run(batch2Uid, 'PRODUCTION_BATCH', 2, 'PRD-ATP-2602', JSON.stringify({ process: 'RAW_ATAP', input_kg: 8000, head_rice_kg: 5120, yield_pct: 64.0 }));
    await insertQr.run(inv1Uid, 'SALES_INVOICE', 1, 'INV-2026-0001', JSON.stringify({ customer: 'Bengal Wholesale Grain House', total: 122500, vehicle: 'WB-03-C-4419' }));
    await insertQr.run(ps1Uid, 'PADDY_SALE', 1, 'PS-2026-0001', JSON.stringify({ customer: 'Nadia Agri Mandi Syndicate', qty_kg: 4000, total: 114000 }));

    await db
      .prepare(
        'INSERT INTO audit_logs (employee_id, employee_name, action, entity_type, entity_id, after_json, device_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(emp2, 'Suman Das', 'WEIGHT_DISCREPANCY_FLAGGED', 'PADDY_PURCHASE', 'PUR-2026-0001', JSON.stringify({ claimed: 45250, scale: 45000, discrepancy: -250 }), 'WEB_PWA');
    await db
      .prepare(
        'INSERT INTO audit_logs (employee_id, employee_name, action, entity_type, entity_id, after_json, device_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(emp3, 'Prakash Sen', 'PRODUCTION_BATCH_COMPLETED', 'PRODUCTION_BATCH', 'PRD-SID-2601', JSON.stringify({ input_kg: 15000, head_rice_kg: 9750, cost_per_kg: 37.8138 }), 'WEB_PWA');
    await db
      .prepare(
        'INSERT INTO audit_logs (employee_id, employee_name, action, entity_type, entity_id, after_json, device_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(employeeId, employeeName, 'DEMO_DATA_LOADED', 'SYSTEM', 'ALL_MODULES', JSON.stringify({ status: 'SEEDED' }), 'WEB_PWA');
    await syncPostgresSequences();
  });
  await tx();
}
