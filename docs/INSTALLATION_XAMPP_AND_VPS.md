# Installation Guide: PHP 8.2+ & MySQL/MariaDB (XAMPP, cPanel, VPS) & Android APK

## 1. MySQL 8 / MariaDB Setup
1. Start MySQL 8.0+ or MariaDB 10.6+ (e.g., via XAMPP Control Panel, cPanel MySQL Databases, or Linux `mysql-server`).
2. Create an empty database (for example `sonagrain_erp`).
3. **Optional manual SQL import** — On first API request, `backend-php/config/bootstrap.php` automatically creates all **37 tables** and seeds master data (`admin@gmail.com` / `admin`). If you prefer importing via phpMyAdmin or CLI:
   ```bash
   mysql -u root -p sonagrain_erp < database/migrations/001_initial_schema.sql
   mysql -u root -p sonagrain_erp < database/migrations/002_seed_master.sql
   ```
4. Default Owner login:
   - **Email:** `admin@gmail.com`
   - **Password:** `admin`

---

## 2. Configure PHP Environment (`backend-php/.env`)
1. Copy `backend-php/.env.example` to `backend-php/.env`:
   ```env
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_NAME=sonagrain_erp
   DB_USER=root
   DB_PASS=
   JWT_SECRET=replace-with-random-64-char-hex-string
   ```
   *(If `JWT_SECRET` is left blank, `Auth.php` auto-generates and persists a random 256-bit secret inside the `app_meta` table.)*

---

## 3. Single-Domain Build & Deployment (React PWA + PHP + MySQL)
1. Build the React frontend once using Node.js:
   ```bash
   npm install
   npm run build
   ```
   This generates the `/dist/` folder.
2. Deploy files:
   - **XAMPP (Windows):** Copy the project into `C:\xampp\htdocs\sonagrain\` (keeping `/dist/`, `/database/`, and `/backend-php/` together) OR copy contents of `/dist/` into `backend-php/public/` (without overwriting `index.php` and `.htaccess`). Point Apache `DocumentRoot` to `.../backend-php/public` with `AllowOverride All` and `mod_rewrite` enabled.
   - **cPanel / Shared PHP Hosting:** Upload `backend-php/` + `database/` + `dist/` above or inside your domain root, and point the domain/subdomain document root to `backend-php/public/` (or copy `dist/assets/` + `dist/index.html` into `public_html/` alongside `backend-php/public/index.php` and `.htaccess` — keep `public/index.php` intact).
   - **Linux VPS (Nginx + PHP-FPM 8.2):**
     ```nginx
     server {
         listen 80;
         server_name erp.yourdomain.com;
         root /var/www/sonagrain/backend-php/public;
         index index.php;

         location / {
             try_files $uri /index.php?$query_string;
         }

         location ~ \.php$ {
             include fastcgi_params;
             fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
             fastcgi_pass unix:/run/php/php8.2-fpm.sock;
         }
     }
     ```
     Provision HTTPS via Certbot (`sudo certbot --nginx -d erp.yourdomain.com`).

---

## 4. Android APK Build (Android Studio)
1. Sync the web build into the Android Studio project:
   ```bash
   npm install
   npm run mobile:build
   ```
2. Open `/android/` in **Android Studio** (`npm run mobile:open`), then run **Build → Build APK(s)**.
3. On the login screen, tap the Server icon to point the APK to your PHP + MySQL server URL (e.g., `https://erp.yourdomain.com` or `http://192.168.1.100`).
