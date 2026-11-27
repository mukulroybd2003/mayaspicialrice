# Backup, Automated Scheduling & Disaster Recovery

## 1. In-App One-Click Backup (Owner Role)
1. Sign in as **Mill Owner** (`admin@sonagrain.com`).
2. Navigate to **Reports & Admin → Backups & Architecture**.
3. Click **Create & Download Backup**. This exports all transactional, inventory, batch costing, accounting, and audit tables into a timestamped `.json` archive and records the action in `backup_history` and `audit_logs`.

---

## 2. Automated Daily MySQL Backups (Linux VPS Cron)
Create `/usr/local/bin/sonagrain-backup.sh`:
```bash
#!/usr/bin/env bash
set -euo pipefail
BACKUP_DIR="/var/backups/sonagrain"
mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y-%m-%d_%H%M%S)
mysqldump --single-transaction --routines --triggers -u sonagrain_backup -p"$MYSQL_BACKUP_PASS" sonagrain_erp \
  | gzip > "$BACKUP_DIR/sonagrain_${STAMP}.sql.gz"
find "$BACKUP_DIR" -name "*.sql.gz" -mtime +30 -delete
```
Schedule daily at 02:00 AM via `crontab -e`:
```cron
0 2 * * * /usr/local/bin/sonagrain-backup.sh >> /var/log/sonagrain-backup.log 2>&1
```

---

## 3. Windows XAMPP Automated Backup (Task Scheduler)
Run a daily batch script via Windows Task Scheduler:
```bat
@echo off
set STAMP=%DATE:~10,4%-%DATE:~4,2%-%DATE:~7,2%
"C:\xampp\mysql\bin\mysqldump.exe" -u root --single-transaction sonagrain_erp > "C:\backups\sonagrain_%STAMP%.sql"
```

---

## 4. Restore Procedure
1. Stop incoming API writes (enable maintenance mode in Nginx/Apache).
2. Restore MySQL database from backup:
   ```bash
   gunzip < /var/backups/sonagrain/sonagrain_YYYY-MM-DD_HHMMSS.sql.gz | mysql -u root -p sonagrain_erp
   ```
3. Verify row counts in `inventory_lots`, `journal_entries`, and `audit_logs` before re-enabling traffic.
