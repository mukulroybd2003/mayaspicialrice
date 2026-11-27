<?php
declare(strict_types=1);

namespace SonaGrain;

use PDO;
use PDOException;

require_once __DIR__ . '/bootstrap.php';

final class Database
{
    private static ?PDO $pdo = null;
    private static array $dotEnv = [];
    private static bool $dotEnvLoaded = false;

    public static function env(string $key, string $default = ''): string
    {
        self::loadDotEnv();
        $val = $_ENV[$key] ?? $_SERVER[$key] ?? getenv($key);
        if ($val !== false && $val !== null && $val !== '') {
            return (string)$val;
        }
        if (isset(self::$dotEnv[$key]) && self::$dotEnv[$key] !== '') {
            return (string)self::$dotEnv[$key];
        }
        return $default;
    }

    private static function loadDotEnv(): void
    {
        if (self::$dotEnvLoaded) {
            return;
        }
        self::$dotEnvLoaded = true;

        $candidates = [
            dirname(__DIR__) . '/.env',
            dirname(__DIR__, 2) . '/.env',
        ];
        foreach ($candidates as $path) {
            if (!is_file($path) || !is_readable($path)) {
                continue;
            }
            $lines = @file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            if (!is_array($lines)) {
                continue;
            }
            foreach ($lines as $line) {
                $trimmed = trim($line);
                if ($trimmed === '' || str_starts_with($trimmed, '#')) {
                    continue;
                }
                if (str_starts_with($trimmed, 'export ')) {
                    $trimmed = trim(substr($trimmed, 7));
                }
                $eqPos = strpos($trimmed, '=');
                if ($eqPos === false) {
                    continue;
                }
                $k = trim(substr($trimmed, 0, $eqPos));
                $v = trim(substr($trimmed, $eqPos + 1));
                if ($k === '' || isset(self::$dotEnv[$k])) {
                    continue;
                }
                if (
                    (str_starts_with($v, '"') && str_ends_with($v, '"') && strlen($v) >= 2) ||
                    (str_starts_with($v, "'") && str_ends_with($v, "'") && strlen($v) >= 2)
                ) {
                    $v = substr($v, 1, -1);
                }
                self::$dotEnv[$k] = $v;
            }
        }
    }

    private static function resolveConnectionConfig(): array
    {
        $url = self::env('MYSQL_URL') ?: self::env('MARIADB_URL') ?: self::env('DATABASE_URL');
        if ($url !== '' && (str_starts_with($url, 'mysql://') || str_starts_with($url, 'mariadb://'))) {
            $parts = parse_url($url);
            if (is_array($parts)) {
                parse_str($parts['query'] ?? '', $query);
                return [
                    'host' => $parts['host'] ?? '127.0.0.1',
                    'port' => (string)($parts['port'] ?? '3306'),
                    'db'   => ltrim((string)($parts['path'] ?? '/sonagrain_erp'), '/'),
                    'user' => rawurldecode((string)($parts['user'] ?? 'root')),
                    'pass' => rawurldecode((string)($parts['pass'] ?? '')),
                    'ssl'  => self::env('DB_SSL') ?: (string)($query['ssl'] ?? $query['sslmode'] ?? ''),
                    'ca'   => self::env('DB_SSL_CA') ?: (string)($query['sslca'] ?? $query['sslrootcert'] ?? ''),
                ];
            }
        }

        return [
            'host' => self::env('DB_HOST') ?: self::env('MYSQL_HOST') ?: self::env('MARIADB_HOST', '127.0.0.1'),
            'port' => self::env('DB_PORT') ?: self::env('MYSQL_PORT') ?: self::env('MARIADB_PORT', '3306'),
            'db'   => self::env('DB_NAME') ?: self::env('MYSQL_DATABASE') ?: self::env('MARIADB_DATABASE', 'sonagrain_erp'),
            'user' => self::env('DB_USER') ?: self::env('MYSQL_USER') ?: self::env('MARIADB_USER', 'root'),
            'pass' => self::env('DB_PASS') ?: self::env('MYSQL_PASSWORD') ?: self::env('MARIADB_PASSWORD', ''),
            'ssl'  => self::env('DB_SSL', 'false'),
            'ca'   => self::env('DB_SSL_CA', ''),
        ];
    }

    public static function connect(): PDO
    {
        if (self::$pdo !== null) {
            return self::$pdo;
        }

        $cfg = self::resolveConnectionConfig();
        $dsn = "mysql:host={$cfg['host']};port={$cfg['port']};dbname={$cfg['db']};charset=utf8mb4";

        $options = [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
            PDO::ATTR_STRINGIFY_FETCHES  => false,
        ];

        $sslFlag = strtolower((string)$cfg['ssl']);
        $useSsl = in_array($sslFlag, ['1', 'true', 'yes', 'require', 'verify-full', 'verify-ca'], true) || $cfg['ca'] !== '';
        if ($useSsl) {
            if ($cfg['ca'] !== '' && defined('PDO::MYSQL_ATTR_SSL_CA')) {
                $caVal = $cfg['ca'];
                if (!str_contains($caVal, 'BEGIN CERTIFICATE') && is_file($caVal)) {
                    $options[PDO::MYSQL_ATTR_SSL_CA] = $caVal;
                }
            }
            if (defined('PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT')) {
                $rejectUnauthorized = strtolower(self::env('DB_SSL_REJECT_UNAUTHORIZED', 'false'));
                $options[PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT] = in_array($rejectUnauthorized, ['1', 'true', 'yes'], true);
            }
        }

        try {
            self::$pdo = new PDO($dsn, $cfg['user'], $cfg['pass'], $options);
            self::$pdo->exec("SET time_zone = '+00:00'");
            SchemaBootstrap::ensureSchemaAndSeed(self::$pdo);
            return self::$pdo;
        } catch (PDOException $e) {
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['error' => 'Database connection failed: ' . $e->getMessage()]);
            exit;
        }
    }
}
