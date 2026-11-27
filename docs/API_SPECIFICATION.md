# SonaGrain Rice Mill ERP — Unified REST API Specification (`v1.0.0`)

Both **Application 1 (React PWA)** and **Application 2 (Native Android Kotlin/Compose)** communicate exclusively with the centralized `/api/v1/*` REST API backed by a single relational database.

## Base Headers & Security
- `Authorization: Bearer <JWT_TOKEN>` (required on all endpoints except `/api/v1/health` and `/api/v1/auth/login`)
- `Content-Type: application/json`
- `X-Client-Type: WEB_PWA | ANDROID_APP`
- Transport: HTTPS (TLS 1.2+) in production.

## Offline Idempotency & Conflict Prevention
Every write operation accepts:
- `client_uuid` (UUID v4 generated offline by Web IndexedDB or Android Room)
- `device_id` (Terminal identifier)

### Behavior
1. If `client_uuid` already exists in `sync_logs` with `status = SYNCED`, the API returns HTTP `200 OK` with the cached response without creating duplicate stock or accounting entries.
2. If stock is insufficient for an outflow (`stock-transfers`, `paddy-sales`, `drying-batches`, `production-batches`, `sales-invoices`), the API rolls back the transaction, logs `CONFLICT` in `sync_logs`, and returns HTTP `409 Conflict` (`code: "INSUFFICIENT_STOCK"`).

---

## Endpoints

| Method | Endpoint | Permission | Description |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/v1/health` | Public | API health and version check |
| `POST` | `/api/v1/auth/login` | Public | Employee email/password login -> JWT + RBAC permissions |
| `GET` | `/api/v1/auth/me` | Authenticated | Current employee profile and permissions |
| `GET` | `/api/v1/dashboard` | `dashboard.view` | KPIs, warehouse utilization, yields, recent activity |
| `GET` | `/api/v1/master` | Authenticated | Warehouses, items, parties, accounts, roles |
| `POST` | `/api/v1/warehouses` | `employees.manage` | Create a godown/warehouse |
| `POST` | `/api/v1/parties` | `parties.manage` | Create supplier or customer |
| `GET` | `/api/v1/inventory/lots` | Authenticated | Active FIFO / Weighted Avg lots across godowns |
| `GET` | `/api/v1/paddy-purchases` | Authenticated | List paddy purchases with 4-weight audit fields |
| `POST` | `/api/v1/paddy-purchases` | `paddy.purchase.create` | Record purchase preserving Claimed, Scale, Received, Payment weights |
| `POST` | `/api/v1/stock-transfers` | `stock.transfer` | Inter-godown stock transfer (FIFO or Weighted Average) |
| `POST` | `/api/v1/paddy-sales` | `paddy.sale.create` | Direct unmilled paddy sale |
| `POST` | `/api/v1/drying-batches` | `drying.manage` | Complete Sun Yard / Mechanical Dryer batch |
| `POST` | `/api/v1/production-batches` | `production.manage` | Complete Siddho or Atap batch + separate Cost Sheet |
| `POST` | `/api/v1/sales-invoices` | `rice.sale.create` | Multi-line rice & by-product invoice + Gate-Pass QR |
| `POST` | `/api/v1/weighbridge-logs` | `weighbridge.operate` | Record Manual, USB Serial, or Bluetooth SPP scale ticket |
| `GET` | `/api/v1/qr/lookup?code=` | Authenticated | Inspect lot, batch, or invoice traceability by QR UID/code |
| `GET` | `/api/v1/accounting` | `accounting.view` | Chart of accounts, vouchers, and double-entry journals |
| `POST` | `/api/v1/payments` | `accounting.post` | Post cash/bank receipt or supplier payment |
| `GET/POST` | `/api/v1/employees` | `employees.manage` | Manage employee accounts and role assignments |
| `GET` | `/api/v1/audit-logs` | `audit.view` | Immutable audit trail & sync conflict logs |
| `POST` | `/api/v1/backups/export` | `backup.manage` | Generate & download full JSON database snapshot |
