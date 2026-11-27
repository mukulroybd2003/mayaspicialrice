<?php
declare(strict_types=1);

namespace SonaGrain;

use PDO;

final class Auth
{
    private static ?string $cachedSecret = null;

    private static function secret(PDO $pdo): string
    {
        if (self::$cachedSecret !== null) {
            return self::$cachedSecret;
        }

        $envSecret = Database::env('JWT_SECRET');
        if ($envSecret !== '') {
            self::$cachedSecret = $envSecret;
            return self::$cachedSecret;
        }

        $stmt = $pdo->prepare("SELECT meta_value FROM app_meta WHERE meta_key = 'jwt_secret' LIMIT 1");
        $stmt->execute();
        $existing = $stmt->fetchColumn();
        if (is_string($existing) && $existing !== '') {
            self::$cachedSecret = $existing;
            return self::$cachedSecret;
        }

        $generated = bin2hex(random_bytes(32));
        $ins = $pdo->prepare("INSERT IGNORE INTO app_meta (meta_key, meta_value) VALUES ('jwt_secret', ?)");
        $ins->execute([$generated]);

        $stmt->execute();
        $stored = $stmt->fetchColumn();
        self::$cachedSecret = (is_string($stored) && $stored !== '') ? $stored : $generated;
        return self::$cachedSecret;
    }

    public static function applyCors(): void
    {
        $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
        if ($origin !== '') {
            $parsedOrigin = parse_url($origin);
            $originHost   = strtolower((string)($parsedOrigin['host'] ?? ''));
            $serverHost   = strtolower((string)preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? ''));
            $appUrl       = Database::env('APP_URL');
            $appHost      = $appUrl !== '' ? strtolower((string)(parse_url($appUrl, PHP_URL_HOST) ?? '')) : '';

            $allowed = ($originHost !== '' && $serverHost !== '' && $originHost === $serverHost)
                || ($originHost !== '' && $appHost !== '' && $originHost === $appHost)
                || in_array($originHost, ['localhost', '127.0.0.1'], true)
                || $origin === 'capacitor://localhost';

            if ($allowed) {
                header('Access-Control-Allow-Origin: ' . $origin);
                header('Vary: Origin');
            }
        }

        header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Client-Type');
        header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');

        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
            http_response_code(204);
            exit;
        }
    }

    public static function signJwt(PDO $pdo, array $payload): string
    {
        $header         = self::b64Url(json_encode(['alg' => 'HS256', 'typ' => 'JWT'], JSON_THROW_ON_ERROR));
        $payload['iat'] = time();
        $payload['exp'] = time() + 86400;
        $body           = self::b64Url(json_encode($payload, JSON_THROW_ON_ERROR));
        $sig            = self::b64Url(hash_hmac('sha256', "$header.$body", self::secret($pdo), true));
        return "$header.$body.$sig";
    }

    public static function verifyJwt(PDO $pdo, string $token): ?array
    {
        $parts = explode('.', $token);
        if (count($parts) !== 3) {
            return null;
        }
        [$header, $body, $sig] = $parts;
        $expected = self::b64Url(hash_hmac('sha256', "$header.$body", self::secret($pdo), true));
        if (!hash_equals($expected, $sig)) {
            return null;
        }
        $data = json_decode(self::b64UrlDecode($body), true);
        if (!is_array($data) || ($data['exp'] ?? 0) < time()) {
            return null;
        }
        return $data;
    }

    public static function getEmployeeWithPermissions(PDO $pdo, int $employeeId): ?array
    {
        $stmt = $pdo->prepare(
            'SELECT e.id, e.employee_code, e.full_name, e.email, e.role_id, e.is_active,
                    r.code AS role_code, r.name AS role_name
             FROM employees e
             JOIN roles r ON r.id = e.role_id
             WHERE e.id = ?'
        );
        $stmt->execute([$employeeId]);
        $emp = $stmt->fetch();
        if (!$emp || !(int)$emp['is_active']) {
            return null;
        }

        $pStmt = $pdo->prepare(
            'SELECT p.perm_key FROM role_permissions rp
             JOIN permissions p ON p.id = rp.permission_id
             WHERE rp.role_id = ?'
        );
        $pStmt->execute([(int)$emp['role_id']]);
        $emp['id']          = (int)$emp['id'];
        $emp['role_id']     = (int)$emp['role_id'];
        $emp['is_active']   = (int)$emp['is_active'];
        $emp['permissions'] = array_column($pStmt->fetchAll(), 'perm_key');
        return $emp;
    }

    public static function requireEmployee(PDO $pdo): array
    {
        $hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if ($hdr === '' && function_exists('apache_request_headers')) {
            $headers = apache_request_headers();
            $hdr = $headers['Authorization'] ?? $headers['authorization'] ?? '';
        }
        if (!str_starts_with($hdr, 'Bearer ')) {
            self::abort(401, 'Authentication token required');
        }
        $claims = self::verifyJwt($pdo, substr($hdr, 7));
        if (!$claims || empty($claims['sub'])) {
            self::abort(401, 'Invalid or expired session token');
        }

        $emp = self::getEmployeeWithPermissions($pdo, (int)$claims['sub']);
        if (!$emp) {
            self::abort(401, 'Employee account is inactive or missing');
        }
        return $emp;
    }

    public static function requirePermission(array $emp, string $perm): void
    {
        if ($emp['role_code'] === 'OWNER' || in_array($perm, $emp['permissions'], true)) {
            return;
        }
        self::abort(403, "Permission denied: requires {$perm}");
    }

    public static function isPhysicalOnlyUser(?array $emp): bool
    {
        return ($emp['role_code'] ?? '') === 'GODOWN_KEEPER';
    }

    public static function rejectPhysicalOnlyUser(
        ?array $emp,
        string $message = 'Financial and commercial records are restricted for Godown Keeper role'
    ): void {
        if (self::isPhysicalOnlyUser($emp)) {
            self::abort(403, $message);
        }
    }

    public static function sanitizePurchaseForPhysical(array $p): array
    {
        $splits = [];
        if (isset($p['splits']) && is_array($p['splits'])) {
            foreach ($p['splits'] as $s) {
                $s['allocated_amount'] = 0;
                $splits[] = $s;
            }
        }
        $returnLogs = [];
        if (isset($p['return_logs']) && is_array($p['return_logs'])) {
            foreach ($p['return_logs'] as $r) {
                $r['return_amount'] = 0;
                $r['account_id']    = null;
                $r['account_name']  = '';
                $returnLogs[] = $r;
            }
        }
        return array_merge($p, [
            'settlement_rate'    => 0,
            'rate_per_kg'        => 0,
            'total_payable'      => 0,
            'paid_amount'        => 0,
            'returned_amount'    => 0,
            'payment_status'     => 'UNPAID',
            'split_summary_json' => null,
            'splits'             => $splits,
            'return_logs'        => $returnLogs,
        ]);
    }

    public static function sanitizeQrPayloadForPhysical(mixed $obj): mixed
    {
        if (is_array($obj)) {
            if (array_is_list($obj)) {
                return array_map([self::class, 'sanitizeQrPayloadForPhysical'], $obj);
            }
            $out = [];
            foreach ($obj as $k => $v) {
                if (is_string($k) && preg_match('/amount|cost|rate|price|payable|paid|profit|loss|revenue|balance|value|budget|valuation|expense/i', $k)) {
                    continue;
                }
                $out[$k] = self::sanitizeQrPayloadForPhysical($v);
            }
            return $out;
        }
        return $obj;
    }

    public static function abort(int $code, string $message, array $extra = []): never
    {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(array_merge(['error' => $message], $extra));
        exit;
    }

    public static function jsonResponse(mixed $data, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_UNICODE);
        exit;
    }

    private static function b64Url(string $data): string
    {
        return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
    }

    private static function b64UrlDecode(string $data): string
    {
        $pad = strlen($data) % 4;
        if ($pad > 0) {
            $data .= str_repeat('=', 4 - $pad);
        }
        return (string)base64_decode(strtr($data, '-_', '+/'));
    }
}
