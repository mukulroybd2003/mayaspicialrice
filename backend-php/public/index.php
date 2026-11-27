<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/database.php';
require_once __DIR__ . '/../src/Auth.php';
require_once __DIR__ . '/../src/ErpEngine.php';
require_once __DIR__ . '/../src/SmsService.php';
require_once __DIR__ . '/../src/routes_master_parties.php';
require_once __DIR__ . '/../src/routes_procurement.php';
require_once __DIR__ . '/../src/routes_production_sales.php';
require_once __DIR__ . '/../src/routes_accounting_admin.php';

use SonaGrain\Auth;
use SonaGrain\Database;
use SonaGrain\ErpEngine;

$rawPath = (string)(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/');
$method  = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

// Support both root-domain hosting (/api/v1/...) and subfolder hosting (/sub/public/api/v1/...)
$apiPos = strpos($rawPath, '/api/v1/');
$uri    = $apiPos !== false ? substr($rawPath, $apiPos) : $rawPath;

// ---------------------------------------------------------------------------
// 1. Static React PWA (dist/) + SPA Fallback for Non-API Requests
// ---------------------------------------------------------------------------
if ($apiPos === false && !str_starts_with($uri, '/api/')) {
    $candidates = [
        dirname(__DIR__, 2) . '/dist',
        dirname(__DIR__) . '/dist',
        __DIR__,
    ];

    $distDir = null;
    foreach ($candidates as $cand) {
        $real = realpath($cand);
        if ($real !== false && is_file($real . DIRECTORY_SEPARATOR . 'index.html')) {
            $distDir = $real;
            break;
        }
    }

    if ($distDir !== null) {
        $scriptName = str_replace('\\', '/', dirname((string)($_SERVER['SCRIPT_NAME'] ?? '')));
        $relPath    = $rawPath;
        if ($scriptName !== '/' && $scriptName !== '.' && $scriptName !== '' && str_starts_with($rawPath, $scriptName)) {
            $relPath = substr($rawPath, strlen($scriptName));
        }
        $relPath = ltrim(rawurldecode($relPath), '/');

        $serveStatic = static function (string $filePath, bool $isEntryHtml = false): never {
            $ext  = strtolower(pathinfo($filePath, PATHINFO_EXTENSION));
            $mime = match ($ext) {
                'html'              => 'text/html; charset=utf-8',
                'js', 'mjs'         => 'application/javascript; charset=utf-8',
                'css'               => 'text/css; charset=utf-8',
                'json', 'webmanifest' => 'application/json; charset=utf-8',
                'svg'               => 'image/svg+xml',
                'png'               => 'image/png',
                'jpg', 'jpeg'       => 'image/jpeg',
                'webp'              => 'image/webp',
                'ico'               => 'image/x-icon',
                'woff'              => 'font/woff',
                'woff2'             => 'font/woff2',
                'ttf'               => 'font/ttf',
                'txt'               => 'text/plain; charset=utf-8',
                default             => 'application/octet-stream',
            };
            header('Content-Type: ' . $mime);
            if ($isEntryHtml || $ext === 'html' || basename($filePath) === 'sw.js') {
                header('Cache-Control: no-cache, no-store, must-revalidate');
            } elseif (str_contains(str_replace('\\', '/', $filePath), '/assets/')) {
                header('Cache-Control: public, max-age=31536000, immutable');
            }
            header('Content-Length: ' . (string)filesize($filePath));
            readfile($filePath);
            exit;
        };

        if ($relPath !== '' && !str_ends_with(strtolower($relPath), '.php')) {
            $candidateFile = realpath($distDir . DIRECTORY_SEPARATOR . $relPath);
            $distPrefix    = rtrim($distDir, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR;
            if ($candidateFile !== false && str_starts_with($candidateFile, $distPrefix) && is_file($candidateFile)) {
                $serveStatic($candidateFile, basename($candidateFile) === 'index.html');
            }
        }

        // SPA fallback for React client-side routes
        $indexFile = $distDir . DIRECTORY_SEPARATOR . 'index.html';
        if (is_file($indexFile)) {
            $serveStatic($indexFile, true);
        }
    }

    Auth::jsonResponse([
        'status'  => 'ok',
        'service' => 'SonaGrain ERP PHP + MySQL API',
        'hint'    => 'Build the frontend (npm run build) and place dist/ at the project root or inside backend-php/public/ to serve the UI here.',
        'health'  => '/api/v1/health',
    ]);
}

// ---------------------------------------------------------------------------
// 2. API CORS, Body Parsing & Database Connection
// ---------------------------------------------------------------------------
Auth::applyCors();

$rawInput = file_get_contents('php://input');
$body     = [];
if (is_string($rawInput) && trim($rawInput) !== '') {
    $decoded = json_decode($rawInput, true);
    if (is_array($decoded)) {
        $body = $decoded;
    }
}

$clientType = (string)($_SERVER['HTTP_X_CLIENT_TYPE'] ?? ($body['client_type'] ?? 'WEB_PWA'));

try {
    $pdo = Database::connect();
} catch (\Throwable $e) {
    Auth::abort(500, 'Database connection failed: ' . $e->getMessage());
}

// ---------------------------------------------------------------------------
// 3. Public Pre-Auth Endpoints
// ---------------------------------------------------------------------------
if ($uri === '/api/v1/health' && $method === 'GET') {
    Auth::jsonResponse([
        'status'      => 'ok',
        'api_version' => '1.0.0',
        'engine'      => 'PHP-' . PHP_VERSION,
        'db_engine'   => 'mysql',
        'timestamp'   => gmdate('c'),
    ]);
}

if ($uri === '/api/v1/speed-probe' && $method === 'GET') {
    $reqBytes = isset($_GET['bytes']) && is_numeric($_GET['bytes']) ? (int)round((float)$_GET['bytes']) : 131072;
    $byteLen  = max(0, min(1048576, $reqBytes));
    header('Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate');
    header('Pragma: no-cache');
    header('Expires: 0');
    header('Content-Type: application/octet-stream');
    header('Content-Length: ' . (string)$byteLen);
    if ($byteLen > 0) {
        echo random_bytes($byteLen);
    }
    exit;
}

if ($uri === '/api/v1/company-settings' && $method === 'GET') {
    $company = $pdo->query('SELECT * FROM company_settings WHERE id = 1')->fetch() ?: null;
    Auth::jsonResponse(['company' => $company]);
}

if ($uri === '/api/v1/auth/login' && $method === 'POST') {
    $email    = strtolower(trim((string)($body['email'] ?? '')));
    $password = (string)($body['password'] ?? '');
    if ($email === '' || $password === '') {
        Auth::abort(400, 'Email and password are required');
    }

    $stmt = $pdo->prepare('SELECT id, password_hash, is_active FROM employees WHERE email = ? LIMIT 1');
    $stmt->execute([$email]);
    $empRow = $stmt->fetch();

    if (!$empRow || !(int)$empRow['is_active'] || !password_verify($password, (string)$empRow['password_hash'])) {
        Auth::abort(401, 'Invalid employee credentials');
    }

    $empId = (int)$empRow['id'];
    $pdo->prepare('UPDATE employees SET last_login_at = NOW() WHERE id = ?')->execute([$empId]);

    $user = Auth::getEmployeeWithPermissions($pdo, $empId);
    if (!$user) {
        Auth::abort(401, 'Employee account is inactive or missing');
    }

    $token = Auth::signJwt($pdo, ['sub' => $empId, 'role' => $user['role_code']]);
    ErpEngine::writeAudit($pdo, $empId, (string)$user['full_name'], 'LOGIN', 'EMPLOYEE', (string)$user['employee_code'], null, null, $clientType);

    Auth::jsonResponse(['token' => $token, 'user' => $user]);
}

// ---------------------------------------------------------------------------
// 4. Authenticated Barrier & Session Endpoints
// ---------------------------------------------------------------------------
$emp = Auth::requireEmployee($pdo);

if ($uri === '/api/v1/auth/me' && $method === 'GET') {
    Auth::jsonResponse(['user' => $emp]);
}

if ($uri === '/api/v1/auth/change-password' && $method === 'POST') {
    $currentPass = (string)($body['current_password'] ?? '');
    $newPass     = trim((string)($body['new_password'] ?? ''));

    if ($currentPass === '' || $newPass === '') {
        Auth::abort(400, 'Current password and new password are required');
    }
    if (strlen($newPass) < 6) {
        Auth::abort(400, 'New password must be at least 6 characters');
    }

    $empId = (int)$emp['id'];
    $stmt  = $pdo->prepare('SELECT id, employee_code, password_hash, is_active FROM employees WHERE id = ?');
    $stmt->execute([$empId]);
    $row = $stmt->fetch();
    if (!$row || !(int)$row['is_active']) {
        Auth::abort(404, 'Employee account not found or inactive');
    }
    if (!password_verify($currentPass, (string)$row['password_hash'])) {
        Auth::abort(401, 'Current password is incorrect');
    }

    $nextHash = password_hash($newPass, PASSWORD_BCRYPT);
    $pdo->prepare('UPDATE employees SET password_hash = ? WHERE id = ?')->execute([$nextHash, $empId]);

    ErpEngine::writeAudit($pdo, $empId, (string)$emp['full_name'], 'CHANGE_PASSWORD', 'EMPLOYEE', (string)$row['employee_code'], null, null, $clientType);
    Auth::jsonResponse(['status' => 'ok']);
}

// ---------------------------------------------------------------------------
// 5. Modular ERP Routers (Full Parity with server.ts)
// ---------------------------------------------------------------------------
if (handleMasterAndPartyRoutes($method, $uri, $body, $pdo, $emp, $clientType)) {
    exit;
}
if (handleProcurementRoutes($method, $uri, $body, $pdo, $emp, $clientType)) {
    exit;
}
if (handleProductionAndSalesRoutes($method, $uri, $body, $pdo, $emp, $clientType)) {
    exit;
}
if (handleAccountingAndAdminRoutes($method, $uri, $body, $pdo, $emp, $clientType)) {
    exit;
}

Auth::abort(404, "Endpoint not found: {$method} {$uri}");
