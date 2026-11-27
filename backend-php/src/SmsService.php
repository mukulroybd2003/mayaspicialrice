<?php
declare(strict_types=1);

namespace SonaGrain;

use PDO;

final class SmsService
{
    private const META_KEY = 'sms_gateway_config';
    private const VALID_PROVIDERS = ['NONE', 'BULKSMSBD', 'SMSNETBD', 'SSLWIRELESS', 'WEBHOOK'];

    public static function defaultConfig(): array
    {
        return [
            'provider'               => 'NONE',
            'enabled'                => false,
            'auto_on_paddy_purchase' => true,
            'auto_on_paddy_price'    => true,
            'lang_mode'              => 'bn',
            'sender_id'              => '',
            'api_key'                => '',
            'webhook_url'            => '',
            'message_template'       => '',
        ];
    }

    public static function normalizeBdPhone(?string $raw): array
    {
        $digits = preg_replace('/[^\d]/', '', (string)($raw ?? '')) ?: '';
        $len    = strlen($digits);
        if ($digits === '' || $len < 10 || $len > 15) {
            return ['valid' => false, 'local' => '', 'intl' => '', 'e164' => ''];
        }
        if (str_starts_with($digits, '8801') && $len === 13) {
            $local = '0' . substr($digits, 3);
            return ['valid' => true, 'local' => $local, 'intl' => $digits, 'e164' => '+' . $digits];
        }
        if (str_starts_with($digits, '01') && $len === 11) {
            return ['valid' => true, 'local' => $digits, 'intl' => '88' . $digits, 'e164' => '+88' . $digits];
        }
        if (str_starts_with($digits, '1') && $len === 10) {
            return ['valid' => true, 'local' => '0' . $digits, 'intl' => '880' . $digits, 'e164' => '+880' . $digits];
        }
        return ['valid' => true, 'local' => $digits, 'intl' => $digits, 'e164' => '+' . $digits];
    }

    public static function validateExternalWebhookUrl(string $rawUrl): string
    {
        $trimmed = trim($rawUrl);
        if ($trimmed === '') {
            return '';
        }
        $parts = parse_url($trimmed);
        if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
            throw new \RuntimeException('Webhook URL must be a valid HTTPS URL');
        }
        if (strtolower((string)$parts['scheme']) !== 'https') {
            throw new \RuntimeException('Webhook URL must use HTTPS');
        }
        $host = strtolower(trim((string)$parts['host'], '[]'));
        if (
            $host === '' ||
            $host === 'localhost' ||
            $host === '::1' ||
            str_ends_with($host, '.local') ||
            str_ends_with($host, '.internal') ||
            str_ends_with($host, '.localhost')
        ) {
            throw new \RuntimeException('Private, loopback, or internal webhook hosts are not allowed');
        }
        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            if (filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
                throw new \RuntimeException('Private, loopback, or internal webhook hosts are not allowed');
            }
        }
        return $trimmed;
    }

    public static function getStoredConfig(PDO $pdo): array
    {
        $stmt = $pdo->prepare('SELECT meta_value FROM app_meta WHERE meta_key = ? LIMIT 1');
        $stmt->execute([self::META_KEY]);
        $val = $stmt->fetchColumn();
        if (!is_string($val) || trim($val) === '') {
            return self::defaultConfig();
        }
        $decoded = json_decode($val, true);
        if (!is_array($decoded)) {
            return self::defaultConfig();
        }
        $merged             = array_merge(self::defaultConfig(), $decoded);
        $provider           = in_array((string)($merged['provider'] ?? ''), self::VALID_PROVIDERS, true)
            ? (string)$merged['provider']
            : 'NONE';
        $merged['provider']  = $provider;
        $merged['lang_mode'] = ($merged['lang_mode'] ?? 'bn') === 'en' ? 'en' : 'bn';
        return $merged;
    }

    public static function maskConfig(array $cfg): array
    {
        return [
            'provider'               => (string)($cfg['provider'] ?? 'NONE'),
            'enabled'                => !empty($cfg['enabled']),
            'auto_on_paddy_purchase' => !empty($cfg['auto_on_paddy_purchase']),
            'auto_on_paddy_price'    => !empty($cfg['auto_on_paddy_price']),
            'lang_mode'              => ($cfg['lang_mode'] ?? 'bn') === 'en' ? 'en' : 'bn',
            'sender_id'              => (string)($cfg['sender_id'] ?? ''),
            'webhook_url'            => (string)($cfg['webhook_url'] ?? ''),
            'message_template'       => (string)($cfg['message_template'] ?? ''),
            'has_api_key'            => trim((string)($cfg['api_key'] ?? '')) !== '',
            'updated_at'             => $cfg['updated_at'] ?? null,
        ];
    }

    public static function saveConfig(PDO $pdo, array $input): array
    {
        $current  = self::getStoredConfig($pdo);
        $provider = in_array((string)($input['provider'] ?? ''), self::VALID_PROVIDERS, true)
            ? (string)$input['provider']
            : (string)$current['provider'];

        $webhookUrl = array_key_exists('webhook_url', $input)
            ? (trim((string)$input['webhook_url']) !== '' ? self::validateExternalWebhookUrl((string)$input['webhook_url']) : '')
            : (string)$current['webhook_url'];

        $clearKey   = !empty($input['clear_api_key']);
        $nextApiKey = $clearKey
            ? ''
            : (isset($input['api_key']) && trim((string)$input['api_key']) !== ''
                ? trim((string)$input['api_key'])
                : (string)$current['api_key']);

        $enabled = array_key_exists('enabled', $input) ? (bool)$input['enabled'] : (bool)$current['enabled'];
        if ($provider === 'NONE') {
            $enabled = false;
        }

        $next = [
            'provider'               => $provider,
            'enabled'                => $enabled,
            'auto_on_paddy_purchase' => array_key_exists('auto_on_paddy_purchase', $input) ? (bool)$input['auto_on_paddy_purchase'] : (bool)$current['auto_on_paddy_purchase'],
            'auto_on_paddy_price'    => array_key_exists('auto_on_paddy_price', $input) ? (bool)$input['auto_on_paddy_price'] : (bool)$current['auto_on_paddy_price'],
            'lang_mode'              => ($input['lang_mode'] ?? $current['lang_mode']) === 'en' ? 'en' : 'bn',
            'sender_id'              => array_key_exists('sender_id', $input) ? substr(trim((string)$input['sender_id']), 0, 64) : (string)$current['sender_id'],
            'api_key'                => $nextApiKey,
            'webhook_url'            => $webhookUrl,
            'message_template'       => array_key_exists('message_template', $input) ? substr(trim((string)$input['message_template']), 0, 500) : (string)$current['message_template'],
            'updated_at'             => gmdate('c'),
        ];

        if ($next['enabled']) {
            if ($next['provider'] === 'WEBHOOK' && $next['webhook_url'] === '') {
                throw new \RuntimeException('HTTPS Webhook URL is required when Webhook provider is enabled');
            }
            if ($next['provider'] !== 'WEBHOOK' && $next['api_key'] === '') {
                throw new \RuntimeException('Gateway API Key / Token is required when SMS Gateway is enabled');
            }
        }

        $serialized = json_encode($next, JSON_UNESCAPED_UNICODE);
        $chk        = $pdo->prepare('SELECT meta_key FROM app_meta WHERE meta_key = ?');
        $chk->execute([self::META_KEY]);
        if ($chk->fetchColumn()) {
            $pdo->prepare('UPDATE app_meta SET meta_value = ? WHERE meta_key = ?')->execute([$serialized, self::META_KEY]);
        } else {
            $pdo->prepare('INSERT INTO app_meta (meta_key, meta_value) VALUES (?, ?)')->execute([self::META_KEY, $serialized]);
        }

        return self::maskConfig($next);
    }

    public static function formatPaddyMessage(PDO $pdo, array $purchase, string $langMode = 'bn', string $template = ''): string
    {
        $company     = $pdo->query('SELECT company_name_en, company_name_bn FROM company_settings WHERE id = 1')->fetch() ?: [];
        $companyName = ($langMode === 'bn' ? ($company['company_name_bn'] ?? '') : ($company['company_name_en'] ?? ''))
            ?: ($company['company_name_en'] ?? 'Maya Special Rice');

        $partyName  = (string)($purchase['supplier_name'] ?? ($langMode === 'bn' ? 'সম্মানিত গ্রাহক' : 'Valued Party'));
        $purchaseNo = (string)($purchase['purchase_no'] ?? '');
        $variety    = (string)($purchase['item_name'] ?? ($langMode === 'bn' ? 'ধান' : 'Paddy'));
        $bags       = max(0, (int)($purchase['bag_count'] ?? 0));
        $receivedKg = (float)($purchase['received_weight_kg'] ?? 0);
        $netKg      = max(0.0, round((float)($purchase['payment_weight_kg'] ?? 0) - (float)($purchase['weight_loss_kg'] ?? 0), 2));
        $isPending  = (string)($purchase['pricing_status'] ?? 'PRICED') === 'PENDING_RATE';
        $total      = (float)($purchase['total_payable'] ?? 0);
        $paid       = (float)($purchase['paid_amount'] ?? 0);
        $due        = max(0.0, round($total - $paid, 2));
        $dateStr    = substr((string)($purchase['created_at'] ?? gmdate('Y-m-d')), 0, 10);

        $fmtNum = static fn(float $n): string => rtrim(rtrim(number_format($n, 2, '.', ','), '0'), '.');

        if (trim($template) !== '' && !$isPending) {
            return str_ireplace(
                ['{company}', '{party}', '{purchase_no}', '{variety}', '{bags}', '{received_kg}', '{payment_kg}', '{total}', '{paid}', '{due}', '{date}'],
                [$companyName, $partyName, $purchaseNo, $variety, (string)$bags, $fmtNum($receivedKg), $fmtNum($netKg), $fmtNum($total), $fmtNum($paid), $fmtNum($due), $dateStr],
                $template
            );
        }

        if ($langMode === 'bn') {
            if ($isPending) {
                return "{$companyName}: প্রিয় {$partyName}, আপনার ধান গ্রহণ স্লিপ #{$purchaseNo} সম্পন্ন হয়েছে। জাত: {$variety}, বস্তা: {$bags}টি, গৃহীত ওজন: {$fmtNum($receivedKg)} কেজি (দর নির্ধারণ বাকি)। ধন্যবাদ।";
            }
            return "{$companyName}: প্রিয় {$partyName}, আপনার ধান ক্রয় রসিদ #{$purchaseNo} সম্পন্ন হয়েছে। জাত: {$variety}, বস্তা: {$bags}টি, বিলযোগ্য ওজন: {$fmtNum($netKg)} কেজি, মোট বিল: ৳{$fmtNum($total)}, পরিশোধ: ৳{$fmtNum($paid)}, বাকি: ৳{$fmtNum($due)}। ধন্যবাদ।";
        }

        if ($isPending) {
            return "{$companyName}: Dear {$partyName}, paddy intake slip #{$purchaseNo} recorded. Variety: {$variety}, Bags: {$bags}, Received Wt: {$fmtNum($receivedKg)} kg (Rate pending). Thank you.";
        }
        return "{$companyName}: Dear {$partyName}, paddy purchase #{$purchaseNo} completed. Variety: {$variety}, Bags: {$bags}, Net Wt: {$fmtNum($netKg)} kg, Total: BDT {$fmtNum($total)}, Paid: BDT {$fmtNum($paid)}, Due: BDT {$fmtNum($due)}. Thank you.";
    }

    public static function recordLog(PDO $pdo, array $entry): void
    {
        $pdo->prepare(
            'INSERT INTO sms_logs (
                entity_type, entity_id, entity_code, party_id, party_name, phone,
                provider, message_body, status, provider_response, created_by
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        )->execute([
            (string)($entry['entityType'] ?? 'PADDY_PURCHASE'),
            (int)($entry['entityId'] ?? 0),
            (string)($entry['entityCode'] ?? ''),
            isset($entry['partyId']) ? (int)$entry['partyId'] : null,
            (string)($entry['partyName'] ?? ''),
            (string)($entry['phone'] ?? ''),
            (string)($entry['provider'] ?? 'NONE'),
            (string)($entry['messageBody'] ?? ''),
            (string)($entry['status'] ?? 'SKIPPED'),
            substr((string)($entry['providerResponse'] ?? ''), 0, 400),
            isset($entry['createdBy']) ? (int)$entry['createdBy'] : null,
        ]);
    }

    private static function httpPost(string $url, string $bodyStr, array $headers): array
    {
        if (function_exists('curl_init')) {
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_POST           => true,
                CURLOPT_POSTFIELDS     => $bodyStr,
                CURLOPT_HTTPHEADER     => $headers,
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_TIMEOUT        => 7,
                CURLOPT_CONNECTTIMEOUT => 4,
            ]);
            $resp = curl_exec($ch);
            $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
            $err  = curl_error($ch);
            curl_close($ch);
            if ($resp === false) {
                return ['http_ok' => false, 'body' => $err ?: 'HTTP request failed'];
            }
            return ['http_ok' => ($code >= 200 && $code < 300), 'body' => (string)$resp];
        }

        $ctx = stream_context_create([
            'http' => [
                'method'        => 'POST',
                'header'        => implode("\r\n", $headers),
                'content'       => $bodyStr,
                'timeout'       => 7,
                'ignore_errors' => true,
            ],
        ]);
        $resp = @file_get_contents($url, false, $ctx);
        $ok   = false;
        if (isset($http_response_header[0]) && preg_match('/\s(\d{3})\s/', $http_response_header[0], $m)) {
            $code = (int)$m[1];
            $ok   = $code >= 200 && $code < 300;
        }
        return ['http_ok' => $ok, 'body' => is_string($resp) ? $resp : 'Request failed'];
    }

    private static function dispatchGatewayHttp(array $cfg, string $phoneRaw, string $message, array $meta): array
    {
        $norm = self::normalizeBdPhone($phoneRaw);
        if (!$norm['valid']) {
            return ['ok' => false, 'responseText' => 'Invalid or missing recipient phone number'];
        }
        $provider = (string)($cfg['provider'] ?? 'NONE');
        $apiKey   = (string)($cfg['api_key'] ?? '');
        $senderId = (string)($cfg['sender_id'] ?? '');

        if ($provider === 'BULKSMSBD') {
            $payload = http_build_query([
                'api_key'  => $apiKey,
                'type'     => 'text',
                'number'   => $norm['intl'],
                'senderid' => $senderId,
                'message'  => $message,
            ]);
            $res  = self::httpPost('https://bulksmsbd.net/api/smsapi', $payload, ['Content-Type: application/x-www-form-urlencoded']);
            $ok   = $res['http_ok'];
            $json = json_decode($res['body'], true);
            if (is_array($json) && isset($json['response_code'])) {
                $ok = (int)$json['response_code'] === 202;
            }
            return ['ok' => $ok, 'responseText' => substr($res['body'], 0, 400)];
        }

        if ($provider === 'SMSNETBD') {
            $fields = ['api_key' => $apiKey, 'msg' => $message, 'to' => $norm['intl']];
            if ($senderId !== '') {
                $fields['sender_id'] = $senderId;
            }
            $res  = self::httpPost('https://api.sms.net.bd/sendsms', http_build_query($fields), ['Content-Type: application/x-www-form-urlencoded']);
            $ok   = $res['http_ok'];
            $json = json_decode($res['body'], true);
            if (is_array($json) && isset($json['error'])) {
                $ok = (int)$json['error'] === 0;
            }
            return ['ok' => $ok, 'responseText' => substr($res['body'], 0, 400)];
        }

        if ($provider === 'SSLWIRELESS') {
            $jsonBody = json_encode([
                'api_token' => $apiKey,
                'sid'       => $senderId,
                'msisdn'    => $norm['intl'],
                'sms'       => $message,
                'csms_id'   => substr(($meta['entityCode'] ?? 'MSG') . '-' . time(), 0, 32),
            ], JSON_UNESCAPED_UNICODE) ?: '{}';
            $res  = self::httpPost('https://smsplus.sslwireless.com/api/v3/send-sms', $jsonBody, ['Content-Type: application/json']);
            $ok   = $res['http_ok'];
            $json = json_decode($res['body'], true);
            if (is_array($json) && !empty($json['status'])) {
                $ok = strtoupper((string)$json['status']) === 'SUCCESS';
            }
            return ['ok' => $ok, 'responseText' => substr($res['body'], 0, 400)];
        }

        if ($provider === 'WEBHOOK') {
            $safeUrl = self::validateExternalWebhookUrl((string)($cfg['webhook_url'] ?? ''));
            $headers = ['Content-Type: application/json'];
            if ($apiKey !== '') {
                $headers[] = 'Authorization: Bearer ' . $apiKey;
            }
            $jsonBody = json_encode([
                'to'           => $norm['intl'],
                'phone_local'  => $norm['local'],
                'phone_e164'   => $norm['e164'],
                'sender_id'    => $senderId !== '' ? $senderId : null,
                'message'      => $message,
                'party_name'   => (string)($meta['partyName'] ?? ''),
                'entity_type'  => (string)($meta['entityType'] ?? 'PADDY_PURCHASE'),
                'reference_no' => (string)($meta['entityCode'] ?? ''),
                'timestamp'    => gmdate('c'),
            ], JSON_UNESCAPED_UNICODE) ?: '{}';
            $res = self::httpPost($safeUrl, $jsonBody, $headers);
            return ['ok' => $res['http_ok'], 'responseText' => substr($res['body'], 0, 400)];
        }

        return ['ok' => false, 'responseText' => 'No SMS gateway provider configured'];
    }

    public static function dispatchPaddyPurchaseSms(PDO $pdo, array $params): array
    {
        $purchase    = $params['purchase'];
        $employeeId  = (int)$params['employeeId'];
        $forceManual = !empty($params['forceManualSend']);
        $triggerType = (string)($params['triggerType'] ?? 'CREATE');

        $cfg      = self::getStoredConfig($pdo);
        $langMode = (string)($params['overrideLang'] ?? $cfg['lang_mode'] ?? 'bn') === 'en' ? 'en' : 'bn';
        $message  = self::formatPaddyMessage($pdo, $purchase, $langMode, (string)($cfg['message_template'] ?? ''));
        $rawPhone = trim((string)($params['overridePhone'] ?? $purchase['supplier_phone'] ?? ''));
        $party    = (string)($purchase['supplier_name'] ?? '');
        $purId    = (int)($purchase['id'] ?? 0);
        $purNo    = (string)($purchase['purchase_no'] ?? '');
        $partyId  = !empty($purchase['supplier_id']) ? (int)$purchase['supplier_id'] : null;

        if (empty($cfg['enabled']) || $cfg['provider'] === 'NONE') {
            return [
                'attempted'       => false,
                'status'          => 'NOT_CONFIGURED',
                'phone'           => $rawPhone,
                'provider'        => (string)$cfg['provider'],
                'message_preview' => $message,
            ];
        }

        if (!$forceManual) {
            if ($triggerType === 'CREATE' && empty($cfg['auto_on_paddy_purchase'])) {
                return [
                    'attempted'       => false,
                    'status'          => 'SKIPPED',
                    'phone'           => $rawPhone,
                    'provider'        => (string)$cfg['provider'],
                    'message_preview' => $message,
                ];
            }
            if ($triggerType === 'PRICE' && empty($cfg['auto_on_paddy_price'])) {
                return [
                    'attempted'       => false,
                    'status'          => 'SKIPPED',
                    'phone'           => $rawPhone,
                    'provider'        => (string)$cfg['provider'],
                    'message_preview' => $message,
                ];
            }
        }

        $norm = self::normalizeBdPhone($rawPhone);
        if (!$norm['valid']) {
            self::recordLog($pdo, [
                'entityType'       => 'PADDY_PURCHASE',
                'entityId'         => $purId,
                'entityCode'       => $purNo,
                'partyId'          => $partyId,
                'partyName'        => $party,
                'phone'            => $rawPhone,
                'provider'         => $cfg['provider'],
                'messageBody'      => $message,
                'status'           => 'SKIPPED',
                'providerResponse' => 'Missing or invalid supplier phone number',
                'createdBy'        => $employeeId,
            ]);
            return [
                'attempted'       => false,
                'status'          => 'SKIPPED',
                'phone'           => $rawPhone,
                'provider'        => (string)$cfg['provider'],
                'message_preview' => $message,
                'error'           => 'Missing or invalid supplier phone number',
            ];
        }

        $dispatch = self::dispatchGatewayHttp($cfg, $norm['intl'], $message, [
            'entityType' => 'PADDY_PURCHASE',
            'entityCode' => $purNo,
            'partyName'  => $party,
        ]);

        self::recordLog($pdo, [
            'entityType'       => 'PADDY_PURCHASE',
            'entityId'         => $purId,
            'entityCode'       => $purNo,
            'partyId'          => $partyId,
            'partyName'        => $party,
            'phone'            => $norm['local'],
            'provider'         => $cfg['provider'],
            'messageBody'      => $message,
            'status'           => $dispatch['ok'] ? 'SENT' : 'FAILED',
            'providerResponse' => $dispatch['responseText'],
            'createdBy'        => $employeeId,
        ]);

        $out = [
            'attempted'       => true,
            'status'          => $dispatch['ok'] ? 'SENT' : 'FAILED',
            'phone'           => $norm['local'],
            'provider'        => (string)$cfg['provider'],
            'message_preview' => $message,
        ];
        if (!$dispatch['ok']) {
            $out['error'] = $dispatch['responseText'];
        }
        return $out;
    }

    public static function sendTestMessage(PDO $pdo, string $phone, ?string $customMessage, int $employeeId): array
    {
        $cfg = self::getStoredConfig($pdo);
        if (empty($cfg['enabled']) || $cfg['provider'] === 'NONE') {
            throw new \RuntimeException('Enable an SMS gateway provider before sending a test message');
        }
        $norm = self::normalizeBdPhone($phone);
        if (!$norm['valid']) {
            throw new \RuntimeException('Valid recipient mobile number is required (e.g. 017XXXXXXXX)');
        }
        $text = trim((string)($customMessage ?? '')) ?: (($cfg['lang_mode'] ?? 'bn') === 'bn'
            ? 'টেস্ট SMS: আপনার রাইস মিল ERP অটো মেসেজিং সিস্টেম সঠিকভাবে কাজ করছে।'
            : 'Test SMS: Your Rice Mill ERP auto-messaging gateway is configured properly.');

        $res = self::dispatchGatewayHttp($cfg, $norm['intl'], $text, [
            'entityType' => 'TEST',
            'entityCode' => 'TEST-SMS',
            'partyName'  => 'Admin Test',
        ]);

        self::recordLog($pdo, [
            'entityType'       => 'TEST',
            'entityId'         => 0,
            'entityCode'       => 'TEST-SMS',
            'partyId'          => null,
            'partyName'        => 'Admin Test',
            'phone'            => $norm['local'],
            'provider'         => $cfg['provider'],
            'messageBody'      => $text,
            'status'           => $res['ok'] ? 'SENT' : 'FAILED',
            'providerResponse' => $res['responseText'],
            'createdBy'        => $employeeId,
        ]);

        return [
            'ok'               => (bool)$res['ok'],
            'status'           => $res['ok'] ? 'SENT' : 'FAILED',
            'providerResponse' => $res['responseText'],
            'phone'            => $norm['local'],
        ];
    }
}
