<?php
declare(strict_types=1);

use SonaGrain\Auth;
use SonaGrain\ErpEngine;
use SonaGrain\SmsService;

const SONAGRAIN_BACKUP_TABLES = [
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
];

function handleAccountingAndAdminRoutes(string $method, string $uri, array $body, PDO $pdo, array $emp, string $clientType): bool
{
    $empId   = (int)$emp['id'];
    $empName = (string)$emp['full_name'];

    // -----------------------------------------------------------------------
    // 12. Cash, Bank & Double-Entry Accounting
    // -----------------------------------------------------------------------
    if ($uri === '/api/v1/accounting' && $method === 'GET') {
        Auth::requirePermission($emp, 'accounting.view');

        $accounts = $pdo->query('SELECT * FROM accounts ORDER BY account_code ASC')->fetchAll();
        foreach ($accounts as &$a) {
            $a['id']        = (int)$a['id'];
            $a['balance']   = (float)$a['balance'];
            $a['is_system'] = (int)$a['is_system'];
        }
        unset($a);

        $payments = $pdo->query(
            'SELECT pay.*, pt.name AS party_name, pt.party_code, pt.party_type, a.name AS account_name
             FROM payments pay
             JOIN parties pt ON pt.id = pay.party_id
             JOIN accounts a ON a.id = pay.account_id
             ORDER BY pay.id DESC LIMIT 200'
        )->fetchAll();
        foreach ($payments as &$p) {
            $p['amount'] = (float)$p['amount'];
        }
        unset($p);

        $entries = $pdo->query('SELECT * FROM journal_entries ORDER BY id DESC LIMIT 150')->fetchAll();
        $lineStmt = $pdo->prepare(
            'SELECT jl.account_id, jl.debit, jl.credit, a.account_code, a.name AS account_name
             FROM journal_lines jl
             JOIN accounts a ON a.id = jl.account_id
             WHERE jl.journal_entry_id = ?'
        );
        foreach ($entries as &$e) {
            $lineStmt->execute([(int)$e['id']]);
            $lines = $lineStmt->fetchAll();
            foreach ($lines as &$l) {
                $l['account_id'] = (int)$l['account_id'];
                $l['debit']      = (float)$l['debit'];
                $l['credit']     = (float)$l['credit'];
            }
            unset($l);
            $e['lines'] = $lines;
        }
        unset($e);

        Auth::jsonResponse([
            'accounts'        => $accounts,
            'payments'        => $payments,
            'journal_entries' => $entries,
        ]);
    }

    if ($uri === '/api/v1/accounting/statements' && $method === 'GET') {
        Auth::requirePermission($emp, 'accounting.view');

        $accounts = $pdo->query('SELECT * FROM accounts ORDER BY account_code ASC')->fetchAll();
        $tbDebitTotal  = 0.0;
        $tbCreditTotal = 0.0;
        $tbRows        = [];

        $revenues    = [];
        $totalRev    = 0.0;
        $cogs        = [];
        $totalCogs   = 0.0;
        $expenses    = [];
        $totalExp    = 0.0;
        $assets      = [];
        $totalAssets = 0.0;
        $liabilities = [];
        $totalLiab   = 0.0;
        $equity      = [];
        $totalEq     = 0.0;

        foreach ($accounts as $a) {
            $bal           = (float)($a['balance'] ?? 0);
            $a['id']       = (int)$a['id'];
            $a['balance']  = $bal;
            $a['is_system'] = (int)$a['is_system'];
            $type          = (string)$a['account_type'];
            $isDebitNormal = in_array($type, ['ASSET', 'EXPENSE'], true);

            $debitBal  = 0.0;
            $creditBal = 0.0;
            if ($isDebitNormal) {
                if ($bal >= 0) {
                    $debitBal = $bal;
                } else {
                    $creditBal = abs($bal);
                }
            } else {
                if ($bal >= 0) {
                    $creditBal = $bal;
                } else {
                    $debitBal = abs($bal);
                }
            }
            $tbDebitTotal  += $debitBal;
            $tbCreditTotal += $creditBal;

            $tbRows[] = [
                'id'             => (int)$a['id'],
                'account_code'   => $a['account_code'],
                'name'           => $a['name'],
                'account_type'   => $type,
                'debit_balance'  => round($debitBal, 2),
                'credit_balance' => round($creditBal, 2),
            ];

            if ($type === 'REVENUE') {
                $revenues[] = $a;
                $totalRev  += $bal;
            } elseif ($type === 'EXPENSE' && $a['account_code'] === '5001') {
                $cogs[]     = $a;
                $totalCogs += $bal;
            } elseif ($type === 'EXPENSE') {
                $expenses[] = $a;
                $totalExp  += $bal;
            } elseif ($type === 'ASSET') {
                $assets[]     = $a;
                $totalAssets += $bal;
            } elseif ($type === 'LIABILITY') {
                $liabilities[] = $a;
                $totalLiab    += $bal;
            } elseif ($type === 'EQUITY') {
                $equity[] = $a;
                $totalEq += $bal;
            }
        }

        $grossProfit    = $totalRev - $totalCogs;
        $netProfit      = $grossProfit - $totalExp;
        $totalLiabAndEq = $totalLiab + $totalEq + $netProfit;

        Auth::jsonResponse([
            'trial_balance' => [
                'rows'         => $tbRows,
                'total_debit'  => round($tbDebitTotal, 2),
                'total_credit' => round($tbCreditTotal, 2),
                'is_balanced'  => abs($tbDebitTotal - $tbCreditTotal) < 0.05,
            ],
            'profit_and_loss' => [
                'revenues'       => $revenues,
                'total_revenue'  => round($totalRev, 2),
                'cogs'           => $cogs,
                'total_cogs'     => round($totalCogs, 2),
                'gross_profit'   => round($grossProfit, 2),
                'expenses'       => $expenses,
                'total_expenses' => round($totalExp, 2),
                'net_profit'     => round($netProfit, 2),
            ],
            'balance_sheet' => [
                'assets'                       => $assets,
                'total_assets'                 => round($totalAssets, 2),
                'liabilities'                  => $liabilities,
                'total_liabilities'            => round($totalLiab, 2),
                'equity'                       => $equity,
                'total_equity'                 => round($totalEq, 2),
                'current_net_profit'           => round($netProfit, 2),
                'total_liabilities_and_equity' => round($totalLiabAndEq, 2),
                'is_balanced'                  => abs($totalAssets - $totalLiabAndEq) < 0.05,
            ],
        ]);
    }

    if ($uri === '/api/v1/accounting/cashbook' && $method === 'GET') {
        Auth::requirePermission($emp, 'accounting.view');

        $fromRaw      = trim((string)($_GET['from'] ?? ''));
        $toRaw        = trim((string)($_GET['to'] ?? ''));
        $accountParam = trim((string)($_GET['account_id'] ?? 'ALL'));
        $isoDateRe    = '/^\d{4}-\d{2}-\d{2}$/';

        if (($fromRaw !== '' && !preg_match($isoDateRe, $fromRaw)) || ($toRaw !== '' && !preg_match($isoDateRe, $toRaw))) {
            Auth::abort(400, 'Invalid date format. Use YYYY-MM-DD.');
        }

        $cashBankAccounts = $pdo->query(
            "SELECT * FROM accounts
             WHERE account_type = 'ASSET'
               AND account_code NOT IN ('1100', '1200')
               AND (
                 account_code LIKE '10%'
                 OR LOWER(name) LIKE '%cash%'
                 OR LOWER(name) LIKE '%bank%'
                 OR LOWER(name) LIKE '%petty%'
                 OR LOWER(name) LIKE '%upi%'
                 OR LOWER(name) LIKE '%bkash%'
                 OR LOWER(name) LIKE '%nagad%'
               )
             ORDER BY account_code ASC"
        )->fetchAll();

        if (count($cashBankAccounts) === 0) {
            $cashBankAccounts = $pdo->query("SELECT * FROM accounts WHERE account_code IN ('1001', '1002') ORDER BY account_code ASC")->fetchAll();
        }

        $targetIds = [];
        foreach ($cashBankAccounts as &$cba) {
            $cba['id']        = (int)$cba['id'];
            $cba['balance']   = (float)$cba['balance'];
            $cba['is_system'] = (int)$cba['is_system'];
            $targetIds[]      = $cba['id'];
        }
        unset($cba);

        $selectedAccountId = 'ALL';
        if ($accountParam !== '' && $accountParam !== 'ALL') {
            $parsedId = filter_var($accountParam, FILTER_VALIDATE_INT);
            if ($parsedId === false || $parsedId <= 0) {
                Auth::abort(400, 'Invalid account_id parameter.');
            }
            $found = null;
            foreach ($cashBankAccounts as $cba) {
                if ($cba['id'] === (int)$parsedId) {
                    $found = $cba;
                    break;
                }
            }
            if (!$found) {
                Auth::abort(404, 'Cash/Bank account not found.');
            }
            $targetIds         = [$found['id']];
            $selectedAccountId = $found['id'];
        }

        $openingBalance = 0.0;
        $rows           = [];
        if (count($targetIds) > 0) {
            $placeholders = implode(', ', array_fill(0, count($targetIds), '?'));
            if ($fromRaw !== '') {
                $openStmt = $pdo->prepare(
                    "SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
                     FROM journal_lines jl
                     JOIN journal_entries je ON je.id = jl.journal_entry_id
                     WHERE jl.account_id IN ({$placeholders}) AND DATE(je.entry_date) < DATE(?)"
                );
                $openStmt->execute(array_merge($targetIds, [$fromRaw]));
                $openingBalance = round((float)$openStmt->fetchColumn(), 2);
            }

            $whereParts = ["jl.account_id IN ({$placeholders})"];
            $params     = $targetIds;
            if ($fromRaw !== '') {
                $whereParts[] = 'DATE(je.entry_date) >= DATE(?)';
                $params[]     = $fromRaw;
            }
            if ($toRaw !== '') {
                $whereParts[] = 'DATE(je.entry_date) <= DATE(?)';
                $params[]     = $toRaw;
            }

            $rowStmt = $pdo->prepare(
                'SELECT jl.id, jl.journal_entry_id, jl.account_id, a.account_code, a.name AS account_name,
                        je.voucher_no, je.entry_date, je.description, je.reference_type, je.created_at,
                        jl.debit, jl.credit
                 FROM journal_lines jl
                 JOIN journal_entries je ON je.id = jl.journal_entry_id
                 JOIN accounts a ON a.id = jl.account_id
                 WHERE ' . implode(' AND ', $whereParts) . '
                 ORDER BY DATE(je.entry_date) ASC, je.id ASC, jl.id ASC'
            );
            $rowStmt->execute($params);
            $rows = $rowStmt->fetchAll();
        }

        $contraStmt  = $pdo->prepare(
            'SELECT a.account_code, a.name AS account_name
             FROM journal_lines jl
             JOIN accounts a ON a.id = jl.account_id
             WHERE jl.journal_entry_id = ? AND jl.id != ?'
        );
        $contraCache = [];

        $running       = $openingBalance;
        $totalReceipts = 0.0;
        $totalPayments = 0.0;
        $entries       = [];

        foreach ($rows as $r) {
            $receipt = (float)($r['debit'] ?? 0);
            $payment = (float)($r['credit'] ?? 0);
            $totalReceipts += $receipt;
            $totalPayments += $payment;
            $running = round($running + $receipt - $payment, 2);

            $cacheKey = $r['journal_entry_id'] . ':' . $r['id'];
            if (!isset($contraCache[$cacheKey])) {
                $contraStmt->execute([(int)$r['journal_entry_id'], (int)$r['id']]);
                $others = $contraStmt->fetchAll();
                $contraCache[$cacheKey] = implode(', ', array_map(
                    static fn(array $o): string => $o['account_code'] . ' ' . $o['account_name'],
                    $others
                ));
            }

            $entries[] = [
                'id'               => (int)$r['id'],
                'journal_entry_id' => (int)$r['journal_entry_id'],
                'account_id'       => (int)$r['account_id'],
                'account_code'     => $r['account_code'],
                'account_name'     => $r['account_name'],
                'voucher_no'       => $r['voucher_no'],
                'entry_date'       => $r['entry_date'],
                'description'      => $r['description'],
                'contra_head'      => $contraCache[$cacheKey],
                'reference_type'   => $r['reference_type'] ?? '',
                'created_at'       => $r['created_at'] ?? $r['entry_date'],
                'receipt'          => round($receipt, 2),
                'payment'          => round($payment, 2),
                'running_balance'  => $running,
            ];
        }

        $cashClosing = 0.0;
        $bankClosing = 0.0;
        $balStmt     = $toRaw !== ''
            ? $pdo->prepare(
                'SELECT COALESCE(SUM(jl.debit - jl.credit), 0)
                 FROM journal_lines jl
                 JOIN journal_entries je ON je.id = jl.journal_entry_id
                 WHERE jl.account_id = ? AND DATE(je.entry_date) <= DATE(?)'
            )
            : null;

        foreach ($cashBankAccounts as $cba) {
            if ($balStmt !== null) {
                $balStmt->execute([$cba['id'], $toRaw]);
                $bal = round((float)$balStmt->fetchColumn(), 2);
            } else {
                $bal = (float)$cba['balance'];
            }
            $isCashAcc = $cba['account_code'] === '1001' || (bool)preg_match('/cash|petty/i', (string)$cba['name']);
            if ($isCashAcc) {
                $cashClosing += $bal;
            } else {
                $bankClosing += $bal;
            }
        }

        Auth::jsonResponse([
            'from'            => $fromRaw !== '' ? $fromRaw : null,
            'to'              => $toRaw !== '' ? $toRaw : null,
            'account_id'      => $selectedAccountId,
            'accounts'        => $cashBankAccounts,
            'opening_balance' => $openingBalance,
            'total_receipts'  => round($totalReceipts, 2),
            'total_payments'  => round($totalPayments, 2),
            'net_change'      => round($totalReceipts - $totalPayments, 2),
            'closing_balance' => $running,
            'cash_closing'    => round($cashClosing, 2),
            'bank_closing'    => round($bankClosing, 2),
            'entries'         => $entries,
        ]);
    }

    if (preg_match('#^/api/v1/accounts/(\d+)/ledger$#', $uri, $m) && $method === 'GET') {
        Auth::requirePermission($emp, 'accounting.view');
        $accountId = (int)$m[1];
        $fromRaw   = trim((string)($_GET['from'] ?? ''));
        $toRaw     = trim((string)($_GET['to'] ?? ''));
        $isoDateRe = '/^\d{4}-\d{2}-\d{2}$/';

        if (($fromRaw !== '' && !preg_match($isoDateRe, $fromRaw)) || ($toRaw !== '' && !preg_match($isoDateRe, $toRaw))) {
            Auth::abort(400, 'Invalid date format. Use YYYY-MM-DD.');
        }

        $accStmt = $pdo->prepare('SELECT * FROM accounts WHERE id = ?');
        $accStmt->execute([$accountId]);
        $account = $accStmt->fetch();
        if (!$account) {
            Auth::abort(404, 'Account not found');
        }
        $account['id']      = (int)$account['id'];
        $account['balance'] = (float)$account['balance'];

        $isDebitNormal  = in_array($account['account_type'], ['ASSET', 'EXPENSE'], true);
        $openingBalance = 0.0;

        if ($fromRaw !== '') {
            $openStmt = $pdo->prepare(
                'SELECT COALESCE(SUM(jl.debit), 0) AS dr, COALESCE(SUM(jl.credit), 0) AS cr
                 FROM journal_lines jl
                 JOIN journal_entries je ON je.id = jl.journal_entry_id
                 WHERE jl.account_id = ? AND DATE(je.entry_date) < DATE(?)'
            );
            $openStmt->execute([$accountId, $fromRaw]);
            $openRow = $openStmt->fetch() ?: ['dr' => 0, 'cr' => 0];
            $dr      = (float)$openRow['dr'];
            $cr      = (float)$openRow['cr'];
            $openingBalance = round($isDebitNormal ? ($dr - $cr) : ($cr - $dr), 2);
        }

        $whereParts = ['jl.account_id = ?'];
        $params     = [$accountId];
        if ($fromRaw !== '') {
            $whereParts[] = 'DATE(je.entry_date) >= DATE(?)';
            $params[]     = $fromRaw;
        }
        if ($toRaw !== '') {
            $whereParts[] = 'DATE(je.entry_date) <= DATE(?)';
            $params[]     = $toRaw;
        }

        $rowStmt = $pdo->prepare(
            'SELECT jl.id, jl.journal_entry_id, je.voucher_no, je.entry_date, je.description, je.reference_type, jl.debit, jl.credit
             FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.journal_entry_id
             WHERE ' . implode(' AND ', $whereParts) . '
             ORDER BY DATE(je.entry_date) ASC, je.id ASC, jl.id ASC'
        );
        $rowStmt->execute($params);
        $rows = $rowStmt->fetchAll();

        $contraStmt = $pdo->prepare(
            'SELECT a.account_code, a.name AS account_name
             FROM journal_lines jl
             JOIN accounts a ON a.id = jl.account_id
             WHERE jl.journal_entry_id = ? AND jl.id != ?'
        );

        $running     = $openingBalance;
        $totalDebit  = 0.0;
        $totalCredit = 0.0;
        $ledger      = [];
        foreach ($rows as $r) {
            $dr = (float)($r['debit'] ?? 0);
            $cr = (float)($r['credit'] ?? 0);
            $totalDebit  += $dr;
            $totalCredit += $cr;
            $running = round($running + ($isDebitNormal ? ($dr - $cr) : ($cr - $dr)), 2);
            $contraStmt->execute([(int)$r['journal_entry_id'], (int)$r['id']]);
            $others = $contraStmt->fetchAll();
            $ledger[] = array_merge($r, [
                'debit'           => $dr,
                'credit'          => $cr,
                'contra_head'     => implode(', ', array_map(static fn(array $o): string => $o['account_code'] . ' ' . $o['account_name'], $others)),
                'running_balance' => $running,
            ]);
        }

        Auth::jsonResponse([
            'account'         => $account,
            'from'            => $fromRaw !== '' ? $fromRaw : null,
            'to'              => $toRaw !== '' ? $toRaw : null,
            'opening_balance' => $openingBalance,
            'total_debit'     => round($totalDebit, 2),
            'total_credit'    => round($totalCredit, 2),
            'closing_balance' => $running,
            'entries'         => $ledger,
        ]);
    }

    if ($uri === '/api/v1/accounts' && $method === 'POST') {
        Auth::requirePermission($emp, 'accounting.post');
        $code       = strtoupper(trim((string)($body['account_code'] ?? '')));
        $name       = trim((string)($body['name'] ?? ''));
        $accType    = (string)($body['account_type'] ?? '');
        $validTypes = ['ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE'];

        if ($code === '' || $name === '' || !in_array($accType, $validTypes, true)) {
            Auth::abort(400, 'Account code, name, and valid account type are required');
        }

        try {
            $created = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $body, $code, $name, $accType, $empId, $empName, $clientType): array {
                $chk = $pdo->prepare('SELECT id FROM accounts WHERE account_code = ?');
                $chk->execute([$code]);
                if ($chk->fetch()) {
                    throw new RuntimeException("Account code {$code} already exists");
                }

                $pdo->prepare('INSERT INTO accounts (account_code, name, account_type, balance, is_system) VALUES (?, ?, ?, 0, 0)')
                    ->execute([$code, $name, $accType]);
                $accountId = (int)$pdo->lastInsertId();

                $opening = (float)($body['opening_balance'] ?? 0);
                if ($opening > 0 && $code !== '3001') {
                    $isDebitNormal = in_array($accType, ['ASSET', 'EXPENSE'], true);
                    ErpEngine::postJournalEntry($pdo, [
                        'description'   => "Opening Balance — {$code} {$name}",
                        'referenceType' => 'OPENING_BALANCE',
                        'referenceId'   => $accountId,
                        'employeeId'    => $empId,
                        'lines'         => $isDebitNormal
                            ? [
                                ['accountCode' => $code, 'debit' => $opening, 'credit' => 0],
                                ['accountCode' => '3001', 'debit' => 0, 'credit' => $opening],
                            ]
                            : [
                                ['accountCode' => '3001', 'debit' => $opening, 'credit' => 0],
                                ['accountCode' => $code, 'debit' => 0, 'credit' => $opening],
                            ],
                    ]);
                }

                ErpEngine::writeAudit($pdo, $empId, $empName, 'GL_ACCOUNT_CREATED', 'ACCOUNT', $code, null, [
                    'code'            => $code,
                    'name'            => $name,
                    'account_type'    => $accType,
                    'opening_balance' => $opening,
                ], $clientType);

                $sel = $pdo->prepare('SELECT * FROM accounts WHERE id = ?');
                $sel->execute([$accountId]);
                $acc = $sel->fetch() ?: [];
                if ($acc) {
                    $acc['id']      = (int)$acc['id'];
                    $acc['balance'] = (float)$acc['balance'];
                }
                return $acc;
            });
            Auth::jsonResponse(['account' => $created], 201);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if (preg_match('#^/api/v1/accounts/(\d+)$#', $uri, $m) && $method === 'PUT') {
        Auth::requirePermission($emp, 'accounting.post');
        $id   = (int)$m[1];
        $name = trim((string)($body['name'] ?? ''));
        if ($name === '') {
            Auth::abort(400, 'Account name is required');
        }
        $sel = $pdo->prepare('SELECT * FROM accounts WHERE id = ?');
        $sel->execute([$id]);
        $acc = $sel->fetch();
        if (!$acc) {
            Auth::abort(404, 'Account not found');
        }
        $pdo->prepare('UPDATE accounts SET name = ? WHERE id = ?')->execute([$name, $id]);
        ErpEngine::writeAudit($pdo, $empId, $empName, 'GL_ACCOUNT_UPDATED', 'ACCOUNT', (string)$acc['account_code'], ['name' => $acc['name']], ['name' => $name], $clientType);
        $sel->execute([$id]);
        $updated = $sel->fetch();
        if ($updated) {
            $updated['id']      = (int)$updated['id'];
            $updated['balance'] = (float)$updated['balance'];
        }
        Auth::jsonResponse(['account' => $updated]);
    }

    if ($uri === '/api/v1/payments' && $method === 'POST') {
        Auth::requirePermission($emp, 'accounting.post');
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        $partyId   = (int)($body['party_id'] ?? 0);
        $accountId = (int)($body['account_id'] ?? 0);
        $rawAmt    = (float)($body['amount'] ?? 0);
        if ($partyId <= 0 || $accountId <= 0 || $rawAmt <= 0) {
            Auth::abort(400, 'Party, account, and positive payment amount are required');
        }

        $voucherType = (string)($body['voucher_type'] ?? (($body['direction'] ?? '') === 'RECEIPT' ? 'DUE_RECEIPT' : 'DUE_PAYMENT'));
        $direction   = in_array($voucherType, ['DUE_RECEIPT', 'ADVANCE_RECEIPT'], true)
            ? 'RECEIPT'
            : (in_array($voucherType, ['DUE_PAYMENT', 'ADVANCE_PAYMENT'], true)
                ? 'PAYMENT'
                : (($body['direction'] ?? '') === 'RECEIPT' ? 'RECEIPT' : 'PAYMENT'));

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use (
                $pdo, $body, $clientUuid, $partyId, $accountId, $rawAmt, $voucherType, $direction, $empId, $empName, $clientType
            ): array {
                $pStmt = $pdo->prepare('SELECT id, name, party_type FROM parties WHERE id = ?');
                $pStmt->execute([$partyId]);
                $party = $pStmt->fetch();
                if (!$party) {
                    throw new RuntimeException('Selected customer/supplier does not exist');
                }

                $seq    = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM payments')->fetchColumn();
                $prefix = in_array($voucherType, ['ADVANCE_RECEIPT', 'ADVANCE_PAYMENT'], true)
                    ? ($direction === 'RECEIPT' ? 'AVR' : 'AVP')
                    : ($direction === 'RECEIPT' ? 'RCP' : 'PAY');
                $paymentNo = $prefix . '-2026-' . str_pad((string)$seq, 4, '0', STR_PAD_LEFT);

                $aStmt = $pdo->prepare('SELECT account_code, name FROM accounts WHERE id = ?');
                $aStmt->execute([$accountId]);
                $acc = $aStmt->fetch();
                if (!$acc) {
                    throw new RuntimeException('Invalid cash/bank account');
                }

                $amount      = round($rawAmt, 2);
                $targetRef   = trim((string)($body['settled_ref_no'] ?? ''));
                $settledRefs = [];

                if ($voucherType === 'DUE_PAYMENT') {
                    $rem   = $amount;
                    $purSt = $pdo->prepare(
                        "SELECT id, purchase_no, total_payable, paid_amount
                         FROM paddy_purchases
                         WHERE supplier_id = ? AND payment_status != 'PAID'
                         ORDER BY CASE WHEN purchase_no = ? THEN 0 ELSE 1 END, created_at ASC, id ASC"
                    );
                    $purSt->execute([$partyId, $targetRef]);
                    $purchases = $purSt->fetchAll();
                    $updPur    = $pdo->prepare('UPDATE paddy_purchases SET paid_amount = ?, payment_status = ? WHERE id = ?');

                    foreach ($purchases as $p) {
                        if ($rem <= 0.01) {
                            break;
                        }
                        if ($targetRef !== '' && $p['purchase_no'] !== $targetRef) {
                            continue;
                        }
                        $totalPayable = (float)$p['total_payable'];
                        $paidAlready  = (float)$p['paid_amount'];
                        $openAmt      = round($totalPayable - $paidAlready, 2);
                        if ($openAmt <= 0) {
                            continue;
                        }
                        $alloc      = min($rem, $openAmt);
                        $nextPaid   = round($paidAlready + $alloc, 2);
                        $nextStatus = $nextPaid >= $totalPayable - 0.01 ? 'PAID' : 'PARTIAL';
                        $updPur->execute([$nextPaid, $nextStatus, (int)$p['id']]);
                        $settledRefs[] = $p['purchase_no'];
                        $rem           = round($rem - $alloc, 2);
                    }
                } elseif ($voucherType === 'DUE_RECEIPT') {
                    $rem   = $amount;
                    $invSt = $pdo->prepare(
                        "SELECT 'INV' AS kind, id, invoice_no AS ref_no, total_amount, paid_amount, created_at
                         FROM sales_invoices WHERE customer_id = ? AND payment_status != 'PAID'"
                    );
                    $invSt->execute([$partyId]);
                    $pdsSt = $pdo->prepare(
                        "SELECT 'PDS' AS kind, id, sale_no AS ref_no, total_amount, paid_amount, created_at
                         FROM paddy_sales WHERE customer_id = ? AND payment_status != 'PAID'"
                    );
                    $pdsSt->execute([$partyId]);

                    $openSales = array_merge($invSt->fetchAll(), $pdsSt->fetchAll());
                    usort($openSales, static function (array $a, array $b) use ($targetRef): int {
                        if ($targetRef !== '' && $a['ref_no'] === $targetRef) {
                            return -1;
                        }
                        if ($targetRef !== '' && $b['ref_no'] === $targetRef) {
                            return 1;
                        }
                        return strcmp((string)$a['created_at'], (string)$b['created_at']);
                    });

                    $updInv = $pdo->prepare('UPDATE sales_invoices SET paid_amount = ?, payment_status = ? WHERE id = ?');
                    $updPds = $pdo->prepare('UPDATE paddy_sales SET paid_amount = ?, payment_status = ? WHERE id = ?');

                    foreach ($openSales as $s) {
                        if ($rem <= 0.01) {
                            break;
                        }
                        if ($targetRef !== '' && $s['ref_no'] !== $targetRef) {
                            continue;
                        }
                        $totalAmt    = (float)$s['total_amount'];
                        $paidAlready = (float)$s['paid_amount'];
                        $openAmt     = round($totalAmt - $paidAlready, 2);
                        if ($openAmt <= 0) {
                            continue;
                        }
                        $alloc      = min($rem, $openAmt);
                        $nextPaid   = round($paidAlready + $alloc, 2);
                        $nextStatus = $nextPaid >= $totalAmt - 0.01 ? 'PAID' : 'PARTIAL';
                        if ($s['kind'] === 'INV') {
                            $updInv->execute([$nextPaid, $nextStatus, (int)$s['id']]);
                        } else {
                            $updPds->execute([$nextPaid, $nextStatus, (int)$s['id']]);
                        }
                        $settledRefs[] = $s['ref_no'];
                        $rem           = round($rem - $alloc, 2);
                    }
                }

                $finalSettledRef = $targetRef !== '' ? $targetRef : implode(', ', $settledRefs);
                $payMode         = (string)($body['payment_mode'] ?? 'CASH');

                $insPay = $pdo->prepare(
                    'INSERT INTO payments (client_uuid, payment_no, direction, voucher_type, party_id, account_id, amount, payment_mode, reference_no, settled_ref_no, notes, created_by)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
                );
                $insPay->execute([
                    $clientUuid,
                    $paymentNo,
                    $direction,
                    $voucherType,
                    $partyId,
                    $accountId,
                    $amount,
                    $payMode,
                    (string)($body['reference_no'] ?? ''),
                    $finalSettledRef,
                    (string)($body['notes'] ?? ''),
                    $empId,
                ]);
                $payId = (int)$pdo->lastInsertId();

                $labelMap = [
                    'DUE_RECEIPT'     => 'Customer Due Receipt',
                    'ADVANCE_RECEIPT' => 'Customer Advance Receipt',
                    'DUE_PAYMENT'     => 'Supplier Due Payment',
                    'ADVANCE_PAYMENT' => 'Supplier Advance Payment',
                    'DUE_SETTLEMENT'  => $direction === 'RECEIPT' ? 'Customer Receipt' : 'Supplier Payment',
                ];
                $label = $labelMap[$voucherType] ?? $direction;

                if ($direction === 'RECEIPT') {
                    $pdo->prepare('UPDATE parties SET current_balance = current_balance - ? WHERE id = ?')->execute([$amount, $partyId]);
                    ErpEngine::postJournalEntry($pdo, [
                        'description'   => "{$label} {$paymentNo} - {$party['name']} ({$payMode})",
                        'referenceType' => 'PAYMENT',
                        'referenceId'   => $payId,
                        'employeeId'    => $empId,
                        'lines'         => [
                            ['accountCode' => (string)$acc['account_code'], 'debit' => $amount, 'credit' => 0],
                            ['accountCode' => '1100', 'debit' => 0, 'credit' => $amount, 'partyId' => $partyId],
                        ],
                    ]);
                } else {
                    $pdo->prepare('UPDATE parties SET current_balance = current_balance + ? WHERE id = ?')->execute([$amount, $partyId]);
                    ErpEngine::postJournalEntry($pdo, [
                        'description'   => "{$label} {$paymentNo} - {$party['name']} ({$payMode})",
                        'referenceType' => 'PAYMENT',
                        'referenceId'   => $payId,
                        'employeeId'    => $empId,
                        'lines'         => [
                            ['accountCode' => '2001', 'debit' => $amount, 'credit' => 0, 'partyId' => $partyId],
                            ['accountCode' => (string)$acc['account_code'], 'debit' => 0, 'credit' => $amount],
                        ],
                    ]);
                }

                ErpEngine::writeAudit($pdo, $empId, $empName, "FINANCE_{$voucherType}", 'PAYMENT', $paymentNo, null, [
                    'amount'         => $amount,
                    'party_id'       => $partyId,
                    'voucher_type'   => $voucherType,
                    'mode'           => $payMode,
                    'settled_ref_no' => $finalSettledRef,
                ], $clientType);

                $sel = $pdo->prepare(
                    'SELECT pay.*, pt.name AS party_name, pt.party_code, pt.party_type, a.name AS account_name
                     FROM payments pay
                     JOIN parties pt ON pt.id = pay.party_id
                     JOIN accounts a ON a.id = pay.account_id
                     WHERE pay.id = ?'
                );
                $sel->execute([$payId]);
                $created = $sel->fetch();
                if ($created) {
                    $created['amount'] = (float)$created['amount'];
                }

                $responseObj = ['status' => 'SYNCED', 'payment' => $created];
                ErpEngine::recordSyncLog($pdo, $clientUuid, 'WEB-BROWSER', 'WEB_PWA', '/api/v1/payments', 'SYNCED', null, $responseObj, $empId);
                return $responseObj;
            });
            Auth::jsonResponse($result, 201);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if ($uri === '/api/v1/expenses' && $method === 'POST') {
        Auth::requirePermission($emp, 'accounting.post');
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        $expAccId  = (int)($body['expense_account_id'] ?? 0);
        $paidAccId = (int)($body['paid_from_account_id'] ?? 0);
        $amount    = round((float)($body['amount'] ?? 0), 2);
        if ($expAccId <= 0 || $paidAccId <= 0 || $amount <= 0) {
            Auth::abort(400, 'Expense account, Cash/Bank account, and positive amount are required');
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $body, $clientUuid, $expAccId, $paidAccId, $amount, $empId, $empName, $clientType): array {
                $stmt = $pdo->prepare('SELECT id, account_code, name, account_type FROM accounts WHERE id = ?');
                $stmt->execute([$expAccId]);
                $expAcc = $stmt->fetch();
                $stmt->execute([$paidAccId]);
                $payAcc = $stmt->fetch();
                if (!$expAcc || !$payAcc) {
                    throw new RuntimeException('Invalid expense or payment account');
                }
                if ((int)$expAcc['id'] === (int)$payAcc['id']) {
                    throw new RuntimeException('Expense account and payment account must be different');
                }

                $desc = "Expense: {$expAcc['name']}"
                    . (!empty($body['payee_name']) ? " ({$body['payee_name']})" : '')
                    . (!empty($body['payment_mode']) ? " · {$body['payment_mode']}" : '')
                    . (!empty($body['reference_no']) ? " · Ref: {$body['reference_no']}" : '')
                    . (!empty($body['notes']) ? " — {$body['notes']}" : '');

                $jeId = ErpEngine::postJournalEntry($pdo, [
                    'clientUuid'    => $clientUuid,
                    'description'   => $desc,
                    'referenceType' => 'EXPENSE',
                    'referenceId'   => (int)$expAcc['id'],
                    'employeeId'    => $empId,
                    'entryDate'     => $body['entry_date'] ?? null,
                    'voucherPrefix' => 'EXP',
                    'lines'         => [
                        ['accountCode' => (string)$expAcc['account_code'], 'debit' => $amount, 'credit' => 0],
                        ['accountCode' => (string)$payAcc['account_code'], 'debit' => 0, 'credit' => $amount],
                    ],
                ]);

                $jeStmt = $pdo->prepare('SELECT * FROM journal_entries WHERE id = ?');
                $jeStmt->execute([$jeId]);
                $entry = $jeStmt->fetch();

                ErpEngine::writeAudit($pdo, $empId, $empName, 'EXPENSE_POSTED', 'EXPENSE', (string)($entry['voucher_no'] ?? $jeId), null, [
                    'amount'          => $amount,
                    'expense_account' => $expAcc['account_code'],
                    'paid_from'       => $payAcc['account_code'],
                    'payee'           => $body['payee_name'] ?? null,
                ], $clientType);

                $responseObj = ['status' => 'SYNCED', 'journal_entry' => $entry, 'amount' => $amount];
                ErpEngine::recordSyncLog($pdo, $clientUuid, 'WEB-BROWSER', 'WEB_PWA', '/api/v1/expenses', 'SYNCED', null, $responseObj, $empId);
                return $responseObj;
            });
            Auth::jsonResponse($result, 201);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if ($uri === '/api/v1/contra-transfers' && $method === 'POST') {
        Auth::requirePermission($emp, 'accounting.post');
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        $fromAccId = (int)($body['from_account_id'] ?? 0);
        $toAccId   = (int)($body['to_account_id'] ?? 0);
        $amount    = round((float)($body['amount'] ?? 0), 2);
        if ($fromAccId <= 0 || $toAccId <= 0 || $amount <= 0) {
            Auth::abort(400, 'Source account, destination account, and positive amount are required');
        }
        if ($fromAccId === $toAccId) {
            Auth::abort(400, 'Source and destination accounts cannot be the same');
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $body, $clientUuid, $fromAccId, $toAccId, $amount, $empId, $empName, $clientType): array {
                $stmt = $pdo->prepare('SELECT id, account_code, name, account_type FROM accounts WHERE id = ?');
                $stmt->execute([$fromAccId]);
                $fromAcc = $stmt->fetch();
                $stmt->execute([$toAccId]);
                $toAcc = $stmt->fetch();
                if (!$fromAcc || !$toAcc) {
                    throw new RuntimeException('Invalid source or destination account');
                }

                $desc = "Contra Transfer: {$fromAcc['name']} → {$toAcc['name']}"
                    . (!empty($body['reference_no']) ? " · Ref: {$body['reference_no']}" : '')
                    . (!empty($body['notes']) ? " — {$body['notes']}" : '');

                $jeId = ErpEngine::postJournalEntry($pdo, [
                    'clientUuid'    => $clientUuid,
                    'description'   => $desc,
                    'referenceType' => 'CONTRA',
                    'referenceId'   => (int)$toAcc['id'],
                    'employeeId'    => $empId,
                    'entryDate'     => $body['entry_date'] ?? null,
                    'voucherPrefix' => 'CTR',
                    'lines'         => [
                        ['accountCode' => (string)$toAcc['account_code'], 'debit' => $amount, 'credit' => 0],
                        ['accountCode' => (string)$fromAcc['account_code'], 'debit' => 0, 'credit' => $amount],
                    ],
                ]);

                $jeStmt = $pdo->prepare('SELECT * FROM journal_entries WHERE id = ?');
                $jeStmt->execute([$jeId]);
                $entry = $jeStmt->fetch();

                ErpEngine::writeAudit($pdo, $empId, $empName, 'CONTRA_TRANSFER_POSTED', 'CONTRA', (string)($entry['voucher_no'] ?? $jeId), null, [
                    'amount' => $amount,
                    'from'   => $fromAcc['account_code'],
                    'to'     => $toAcc['account_code'],
                ], $clientType);

                $responseObj = ['status' => 'SYNCED', 'journal_entry' => $entry, 'amount' => $amount];
                ErpEngine::recordSyncLog($pdo, $clientUuid, 'WEB-BROWSER', 'WEB_PWA', '/api/v1/contra-transfers', 'SYNCED', null, $responseObj, $empId);
                return $responseObj;
            });
            Auth::jsonResponse($result, 201);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if ($uri === '/api/v1/journal-entries' && $method === 'POST') {
        Auth::requirePermission($emp, 'accounting.post');
        $clientUuid = (string)($body['client_uuid'] ?? ErpEngine::uuidV4());
        $idem       = ErpEngine::checkIdempotency($pdo, $clientUuid);
        if ($idem !== null) {
            Auth::jsonResponse($idem, 200);
        }

        $desc = trim((string)($body['description'] ?? ''));
        if ($desc === '' || empty($body['lines']) || !is_array($body['lines']) || count($body['lines']) < 2) {
            Auth::abort(400, 'Description and at least 2 journal lines are required');
        }

        try {
            $result = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $body, $clientUuid, $desc, $empId, $empName, $clientType): array {
                $accStmt       = $pdo->prepare('SELECT account_code FROM accounts WHERE id = ?');
                $resolvedLines = [];
                foreach ($body['lines'] as $l) {
                    $dr = round((float)($l['debit'] ?? 0), 2);
                    $cr = round((float)($l['credit'] ?? 0), 2);
                    if ($dr < 0 || $cr < 0 || ($dr > 0 && $cr > 0)) {
                        throw new RuntimeException('Each journal line must have either non-negative debit OR credit');
                    }
                    if ($dr == 0.0 && $cr == 0.0) {
                        continue;
                    }
                    $accId = (int)($l['account_id'] ?? 0);
                    $accStmt->execute([$accId]);
                    $accCode = $accStmt->fetchColumn();
                    if (!$accCode) {
                        throw new RuntimeException("Account ID {$accId} not found");
                    }
                    $resolvedLines[] = ['accountCode' => (string)$accCode, 'debit' => $dr, 'credit' => $cr];
                }
                if (count($resolvedLines) < 2) {
                    throw new RuntimeException('At least 2 non-zero lines are required');
                }

                $jeId = ErpEngine::postJournalEntry($pdo, [
                    'clientUuid'    => $clientUuid,
                    'description'   => $desc,
                    'referenceType' => 'MANUAL_JV',
                    'referenceId'   => 0,
                    'employeeId'    => $empId,
                    'entryDate'     => $body['entry_date'] ?? null,
                    'voucherPrefix' => 'JV',
                    'lines'         => $resolvedLines,
                ]);

                $jeStmt = $pdo->prepare('SELECT * FROM journal_entries WHERE id = ?');
                $jeStmt->execute([$jeId]);
                $entry = $jeStmt->fetch();

                ErpEngine::writeAudit($pdo, $empId, $empName, 'MANUAL_JOURNAL_POSTED', 'JOURNAL_ENTRY', (string)($entry['voucher_no'] ?? $jeId), null, [
                    'description' => $desc,
                    'lines'       => $resolvedLines,
                ], $clientType);

                $responseObj = ['status' => 'SYNCED', 'journal_entry' => $entry];
                ErpEngine::recordSyncLog($pdo, $clientUuid, 'WEB-BROWSER', 'WEB_PWA', '/api/v1/journal-entries', 'SYNCED', null, $responseObj, $empId);
                return $responseObj;
            });
            Auth::jsonResponse($result, 201);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    // -----------------------------------------------------------------------
    // 13. Employees & Permissions (RBAC)
    // -----------------------------------------------------------------------
    if ($uri === '/api/v1/employees' && $method === 'GET') {
        Auth::requirePermission($emp, 'employees.manage');
        $employees = $pdo->query(
            'SELECT e.id, e.employee_code, e.full_name, e.email, e.phone, e.role_id, e.is_active, e.last_login_at,
                    r.code AS role_code, r.name AS role_name
             FROM employees e
             JOIN roles r ON r.id = e.role_id
             ORDER BY e.id ASC'
        )->fetchAll();
        foreach ($employees as &$e) {
            $e['id']        = (int)$e['id'];
            $e['role_id']   = (int)$e['role_id'];
            $e['is_active'] = (int)$e['is_active'];
        }
        unset($e);

        $roles       = $pdo->query('SELECT * FROM roles ORDER BY id ASC')->fetchAll();
        $permissions = $pdo->query('SELECT * FROM permissions ORDER BY module ASC, id ASC')->fetchAll();
        $rolePerms   = $pdo->query('SELECT * FROM role_permissions')->fetchAll();

        Auth::jsonResponse([
            'employees'        => $employees,
            'roles'            => $roles,
            'permissions'      => $permissions,
            'role_permissions' => $rolePerms,
        ]);
    }

    if ($uri === '/api/v1/employees' && $method === 'POST') {
        Auth::requirePermission($emp, 'employees.manage');
        $fullName = trim((string)($body['full_name'] ?? ''));
        $email    = strtolower(trim((string)($body['email'] ?? '')));
        $phone    = (string)($body['phone'] ?? '');
        $password = (string)($body['password'] ?? '');
        $roleId   = (int)($body['role_id'] ?? 0);

        if ($fullName === '' || $email === '' || $password === '' || $roleId <= 0) {
            Auth::abort(400, 'Name, email, password, and role are required');
        }

        try {
            $seq     = (int)$pdo->query('SELECT COALESCE(MAX(id), 0) + 1 FROM employees')->fetchColumn();
            $empCode = 'EMP-' . str_pad((string)$seq, 3, '0', STR_PAD_LEFT);
            $hash    = password_hash($password, PASSWORD_BCRYPT);

            $ins = $pdo->prepare('INSERT INTO employees (employee_code, full_name, email, phone, password_hash, role_id) VALUES (?, ?, ?, ?, ?, ?)');
            $ins->execute([$empCode, $fullName, $email, $phone, $hash, $roleId]);
            $newId = (int)$pdo->lastInsertId();

            ErpEngine::writeAudit($pdo, $empId, $empName, 'CREATE_EMPLOYEE', 'EMPLOYEE', $empCode, null, [
                'full_name' => $fullName,
                'email'     => $email,
                'role_id'   => $roleId,
            ], $clientType);

            $sel = $pdo->prepare(
                'SELECT e.id, e.employee_code, e.full_name, e.email, e.phone, e.role_id, e.is_active,
                        r.code AS role_code, r.name AS role_name
                 FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?'
            );
            $sel->execute([$newId]);
            $created = $sel->fetch();
            if ($created) {
                $created['id']        = (int)$created['id'];
                $created['role_id']   = (int)$created['role_id'];
                $created['is_active'] = (int)$created['is_active'];
            }
            Auth::jsonResponse(['employee' => $created], 201);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if (preg_match('#^/api/v1/employees/(\d+)$#', $uri, $m) && $method === 'PUT') {
        Auth::requirePermission($emp, 'employees.manage');
        $targetId = (int)$m[1];
        if ($targetId <= 0) {
            Auth::abort(400, 'Invalid employee ID');
        }

        $sel = $pdo->prepare(
            'SELECT e.id, e.employee_code, e.full_name, e.email, e.phone, e.role_id, e.is_active, r.code AS role_code
             FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?'
        );
        $sel->execute([$targetId]);
        $existing = $sel->fetch();
        if (!$existing) {
            Auth::abort(404, 'Employee not found');
        }

        $nextName   = trim((string)($body['full_name'] ?? $existing['full_name']));
        $nextEmail  = strtolower(trim((string)($body['email'] ?? $existing['email'])));
        $nextPhone  = array_key_exists('phone', $body) ? trim((string)$body['phone']) : (string)($existing['phone'] ?? '');
        $nextRoleId = array_key_exists('role_id', $body) ? (int)$body['role_id'] : (int)$existing['role_id'];
        $nextActive = array_key_exists('is_active', $body) ? ((bool)$body['is_active'] ? 1 : 0) : (int)$existing['is_active'];
        $newPass    = array_key_exists('password', $body) ? trim((string)$body['password']) : '';

        if ($nextName === '' || $nextEmail === '') {
            Auth::abort(400, 'Full name and email are required');
        }

        $rStmt = $pdo->prepare('SELECT id, code FROM roles WHERE id = ?');
        $rStmt->execute([$nextRoleId]);
        $targetRole = $rStmt->fetch();
        if (!$targetRole) {
            Auth::abort(400, 'Invalid role selected');
        }

        if ($existing['role_code'] === 'OWNER' && (int)$existing['is_active'] === 1 && ($targetRole['code'] !== 'OWNER' || $nextActive !== 1)) {
            $oStmt = $pdo->prepare(
                "SELECT COUNT(*) FROM employees e
                 JOIN roles r ON r.id = e.role_id
                 WHERE r.code = 'OWNER' AND e.is_active = 1 AND e.id != ?"
            );
            $oStmt->execute([$targetId]);
            if ((int)$oStmt->fetchColumn() < 1) {
                Auth::abort(400, 'Cannot deactivate or demote the last active Mill Owner account');
            }
        }

        if ($newPass !== '' && strlen($newPass) < 6) {
            Auth::abort(400, 'New password must be at least 6 characters');
        }

        try {
            if ($newPass !== '') {
                $hash = password_hash($newPass, PASSWORD_BCRYPT);
                $pdo->prepare(
                    'UPDATE employees SET full_name = ?, email = ?, phone = ?, role_id = ?, is_active = ?, password_hash = ? WHERE id = ?'
                )->execute([$nextName, $nextEmail, $nextPhone, $nextRoleId, $nextActive, $hash, $targetId]);
            } else {
                $pdo->prepare(
                    'UPDATE employees SET full_name = ?, email = ?, phone = ?, role_id = ?, is_active = ? WHERE id = ?'
                )->execute([$nextName, $nextEmail, $nextPhone, $nextRoleId, $nextActive, $targetId]);
            }

            ErpEngine::writeAudit(
                $pdo,
                $empId,
                $empName,
                'UPDATE_EMPLOYEE',
                'EMPLOYEE',
                (string)$existing['employee_code'],
                [
                    'full_name' => $existing['full_name'],
                    'email'     => $existing['email'],
                    'role_id'   => (int)$existing['role_id'],
                    'is_active' => (int)$existing['is_active'],
                ],
                [
                    'full_name'        => $nextName,
                    'email'            => $nextEmail,
                    'role_id'          => $nextRoleId,
                    'is_active'        => $nextActive,
                    'password_changed' => $newPass !== '',
                ],
                $clientType
            );

            $uStmt = $pdo->prepare(
                'SELECT e.id, e.employee_code, e.full_name, e.email, e.phone, e.role_id, e.is_active, e.last_login_at,
                        r.code AS role_code, r.name AS role_name
                 FROM employees e JOIN roles r ON r.id = e.role_id WHERE e.id = ?'
            );
            $uStmt->execute([$targetId]);
            $updated = $uStmt->fetch();
            if ($updated) {
                $updated['id']        = (int)$updated['id'];
                $updated['role_id']   = (int)$updated['role_id'];
                $updated['is_active'] = (int)$updated['is_active'];
            }
            Auth::jsonResponse(['employee' => $updated]);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    // -----------------------------------------------------------------------
    // 14. Audit Logs, Sync Logs, Backups & Reset
    // -----------------------------------------------------------------------
    if ($uri === '/api/v1/audit-logs' && $method === 'GET') {
        Auth::requirePermission($emp, 'audit.view');
        $logs     = $pdo->query('SELECT * FROM audit_logs ORDER BY id DESC LIMIT 150')->fetchAll();
        $syncLogs = $pdo->query(
            'SELECT s.*, e.full_name AS employee_name
             FROM sync_logs s
             JOIN employees e ON e.id = s.employee_id
             ORDER BY s.id DESC LIMIT 100'
        )->fetchAll();
        Auth::jsonResponse(['audit_logs' => $logs, 'sync_logs' => $syncLogs]);
    }

    if ($uri === '/api/v1/backups' && $method === 'GET') {
        Auth::requirePermission($emp, 'backup.manage');
        $history = $pdo->query(
            'SELECT b.*, e.full_name AS created_by_name
             FROM backup_history b
             JOIN employees e ON e.id = b.created_by
             ORDER BY b.id DESC LIMIT 30'
        )->fetchAll();
        foreach ($history as &$h) {
            $h['file_size_bytes'] = (int)$h['file_size_bytes'];
        }
        unset($h);
        Auth::jsonResponse(['backups' => $history]);
    }

    if ($uri === '/api/v1/backups/export' && $method === 'POST') {
        Auth::requirePermission($emp, 'backup.manage');
        $snapshot = [];
        foreach (SONAGRAIN_BACKUP_TABLES as $tbl) {
            $snapshot[$tbl] = $pdo->query("SELECT * FROM `{$tbl}`")->fetchAll();
        }
        $snapshotBytes = strlen(json_encode($snapshot, JSON_UNESCAPED_UNICODE) ?: '{}');
        $fullSnapshot  = [
            'exported_at'   => gmdate('c'),
            'db_engine'     => 'mysql',
            'db_file_bytes' => $snapshotBytes,
            'tables'        => $snapshot,
        ];
        $payloadStr = json_encode($fullSnapshot, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT) ?: '{}';
        $payloadLen = strlen($payloadStr);
        $backupName = 'sonagrain-backup-' . gmdate('Y-m-d\TH-i-s\Z') . '.json';

        $pdo->prepare('INSERT INTO backup_history (backup_name, file_size_bytes, created_by) VALUES (?, ?, ?)')
            ->execute([$backupName, $payloadLen, $empId]);

        ErpEngine::writeAudit($pdo, $empId, $empName, 'DATABASE_BACKUP_EXPORTED', 'BACKUP', $backupName, null, ['bytes' => $payloadLen], $clientType);
        Auth::jsonResponse(['backup_name' => $backupName, 'snapshot' => $fullSnapshot]);
    }

    if ($uri === '/api/v1/backups/restore' && $method === 'POST') {
        Auth::requirePermission($emp, 'backup.manage');

        $incomingTables = null;
        if (isset($body['tables']) && is_array($body['tables'])) {
            $incomingTables = $body['tables'];
        } elseif (isset($body['snapshot']['tables']) && is_array($body['snapshot']['tables'])) {
            $incomingTables = $body['snapshot']['tables'];
        }

        if ($incomingTables === null) {
            Auth::abort(400, 'Invalid backup JSON: missing "tables" object');
        }

        $hasValidTableArray = false;
        foreach (SONAGRAIN_BACKUP_TABLES as $tbl) {
            if (isset($incomingTables[$tbl]) && is_array($incomingTables[$tbl])) {
                $hasValidTableArray = true;
                break;
            }
        }
        if (!$hasValidTableArray) {
            Auth::abort(400, 'Backup JSON contains no recognized ERP tables');
        }

        try {
            $restoreSummary = ErpEngine::runInTransaction($pdo, static function () use ($pdo, $incomingTables, $empId, $empName, $clientType): array {
                $existingEmps = $pdo->query('SELECT id, email, password_hash FROM employees')->fetchAll();
                $hashById     = [];
                $hashByEmail  = [];
                foreach ($existingEmps as $ee) {
                    $hashById[(int)$ee['id']]                      = (string)$ee['password_hash'];
                    $hashByEmail[strtolower((string)$ee['email'])] = (string)$ee['password_hash'];
                }
                $fallbackHash = password_hash('123456', PASSWORD_BCRYPT);

                $authTables        = ['roles', 'permissions', 'role_permissions', 'employees'];
                $incomingEmployees = (isset($incomingTables['employees']) && is_array($incomingTables['employees']))
                    ? $incomingTables['employees']
                    : [];
                $restoreAuthTables = count($incomingEmployees) > 0;

                // Delete child-to-parent
                foreach (array_reverse(SONAGRAIN_BACKUP_TABLES) as $tbl) {
                    if (in_array($tbl, $authTables, true) && !$restoreAuthTables) {
                        continue;
                    }
                    if ($tbl === 'company_settings' && (!isset($incomingTables['company_settings']) || !is_array($incomingTables['company_settings']))) {
                        continue;
                    }
                    $pdo->exec("DELETE FROM `{$tbl}`");
                }

                $colStmt = $pdo->prepare(
                    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
                     ORDER BY ORDINAL_POSITION'
                );

                $restoredCounts = [];
                foreach (SONAGRAIN_BACKUP_TABLES as $tbl) {
                    if (in_array($tbl, $authTables, true) && !$restoreAuthTables) {
                        continue;
                    }
                    $rows = $incomingTables[$tbl] ?? null;
                    if (!is_array($rows) || count($rows) === 0) {
                        $restoredCounts[$tbl] = 0;
                        continue;
                    }

                    $colStmt->execute([$tbl]);
                    $validCols = array_flip($colStmt->fetchAll(PDO::FETCH_COLUMN));
                    $inserted  = 0;

                    foreach ($rows as $rawRow) {
                        if (!is_array($rawRow)) {
                            continue;
                        }
                        $row = $rawRow;
                        if ($tbl === 'employees' && empty($row['password_hash'])) {
                            $idMatch    = isset($row['id']) ? ($hashById[(int)$row['id']] ?? null) : null;
                            $emailMatch = isset($row['email']) ? ($hashByEmail[strtolower((string)$row['email'])] ?? null) : null;
                            $row['password_hash'] = $idMatch ?: ($emailMatch ?: $fallbackHash);
                        }

                        $cols = [];
                        $vals = [];
                        foreach ($row as $k => $v) {
                            if (isset($validCols[(string)$k])) {
                                $cols[] = "`{$k}`";
                                $vals[] = $v;
                            }
                        }
                        if (count($cols) === 0) {
                            continue;
                        }

                        $colSql       = implode(', ', $cols);
                        $placeholders = implode(', ', array_fill(0, count($cols), '?'));
                        $insStmt      = $pdo->prepare("INSERT IGNORE INTO `{$tbl}` ({$colSql}) VALUES ({$placeholders})");
                        $insStmt->execute($vals);
                        $inserted++;
                    }
                    $restoredCounts[$tbl] = $inserted;
                }

                $pdo->exec('INSERT IGNORE INTO company_settings (id) VALUES (1)');

                $actStmt = $pdo->prepare('SELECT id, full_name FROM employees WHERE id = ?');
                $actStmt->execute([$empId]);
                $activeEmp = $actStmt->fetch();
                if (!$activeEmp) {
                    $activeEmp = $pdo->query('SELECT id, full_name FROM employees ORDER BY id ASC LIMIT 1')->fetch();
                }

                ErpEngine::writeAudit(
                    $pdo,
                    $activeEmp ? (int)$activeEmp['id'] : $empId,
                    $activeEmp ? (string)$activeEmp['full_name'] : $empName,
                    'DATABASE_BACKUP_RESTORED',
                    'BACKUP',
                    'JSON_RESTORE',
                    null,
                    ['total_rows' => array_sum($restoredCounts), 'restoredCounts' => $restoredCounts],
                    $clientType
                );

                return $restoredCounts;
            });

            Auth::jsonResponse([
                'restored'   => true,
                'tables'     => $restoreSummary,
                'total_rows' => array_sum($restoreSummary),
            ]);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if ($uri === '/api/v1/admin/clear-all-data' && $method === 'POST') {
        Auth::requirePermission($emp, 'backup.manage');
        $scope = ($body['scope'] ?? '') === 'TRANSACTIONS_ONLY' ? 'TRANSACTIONS_ONLY' : 'ALL_DATA';

        $transactionalTables = [
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
        $masterTables   = ['parties', 'items', 'warehouses', 'product_categories', 'product_units'];
        $seqResetTables = $scope === 'ALL_DATA'
            ? array_merge($transactionalTables, $masterTables)
            : $transactionalTables;

        try {
            ErpEngine::runInTransaction($pdo, static function () use (
                $pdo, $scope, $transactionalTables, $masterTables, $empId, $empName, $clientType
            ): void {
                foreach ($transactionalTables as $tbl) {
                    $pdo->exec("DELETE FROM `{$tbl}`");
                }
                $pdo->exec('UPDATE accounts SET balance = 0');

                if ($scope === 'ALL_DATA') {
                    foreach ($masterTables as $tbl) {
                        $pdo->exec("DELETE FROM `{$tbl}`");
                    }
                } else {
                    $pdo->exec('UPDATE parties SET opening_balance = 0, current_balance = 0');
                }

                ErpEngine::writeAudit(
                    $pdo,
                    $empId,
                    $empName,
                    $scope === 'ALL_DATA' ? 'ALL_DATA_CLEARED' : 'TRANSACTIONS_CLEARED',
                    'SYSTEM',
                    $scope,
                    null,
                    ['scope' => $scope, 'preserved' => ['employees', 'roles', 'permissions', 'accounts_structure']],
                    $clientType
                );
            });

            // Reset AUTO_INCREMENT outside transaction because ALTER TABLE causes implicit COMMIT in MySQL
            foreach ($seqResetTables as $tbl) {
                try {
                    $pdo->exec("ALTER TABLE `{$tbl}` AUTO_INCREMENT = 1");
                } catch (\Throwable $ignore) {
                    // Shared hosting may restrict ALTER on some setups; rows are already cleared
                }
            }

            Auth::jsonResponse([
                'cleared'        => true,
                'scope'          => $scope,
                'cleared_tables' => $seqResetTables,
            ]);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    // -----------------------------------------------------------------------
    // 15. Auto-SMS Gateway Configuration, Testing & Delivery Logs
    // -----------------------------------------------------------------------
    if ($uri === '/api/v1/sms/status' && $method === 'GET') {
        $cfg = SmsService::getStoredConfig($pdo);
        Auth::jsonResponse([
            'configured'             => !empty($cfg['enabled']) && $cfg['provider'] !== 'NONE',
            'auto_on_paddy_purchase' => !empty($cfg['auto_on_paddy_purchase']),
            'auto_on_paddy_price'    => !empty($cfg['auto_on_paddy_price']),
            'provider'               => (string)$cfg['provider'],
            'lang_mode'              => (string)$cfg['lang_mode'],
        ]);
    }

    if ($uri === '/api/v1/sms/settings' && $method === 'GET') {
        $canManage = in_array($emp['role_code'], ['OWNER', 'MANAGER'], true)
            || in_array('employees.manage', $emp['permissions'], true);
        if (!$canManage) {
            Auth::abort(403, 'Only Mill Owner or Manager can access SMS gateway configuration');
        }
        $cfg  = SmsService::getStoredConfig($pdo);
        $logs = $pdo->query('SELECT * FROM sms_logs ORDER BY id DESC LIMIT 50')->fetchAll();
        Auth::jsonResponse(['settings' => SmsService::maskConfig($cfg), 'logs' => $logs]);
    }

    if ($uri === '/api/v1/sms/settings' && $method === 'PUT') {
        $canManage = in_array($emp['role_code'], ['OWNER', 'MANAGER'], true)
            || in_array('employees.manage', $emp['permissions'], true);
        if (!$canManage) {
            Auth::abort(403, 'Only Mill Owner or Manager can update SMS gateway settings');
        }
        try {
            $saved = SmsService::saveConfig($pdo, $body);
            ErpEngine::writeAudit($pdo, $empId, $empName, 'SMS_SETTINGS_UPDATED', 'SMS_SETTINGS', '1', null, $saved, $clientType);
            Auth::jsonResponse(['settings' => $saved]);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if ($uri === '/api/v1/sms/test' && $method === 'POST') {
        $canManage = in_array($emp['role_code'], ['OWNER', 'MANAGER'], true)
            || in_array('employees.manage', $emp['permissions'], true);
        if (!$canManage) {
            Auth::abort(403, 'Only Mill Owner or Manager can send test SMS');
        }
        try {
            $res = SmsService::sendTestMessage(
                $pdo,
                (string)($body['phone'] ?? ''),
                isset($body['message']) ? (string)$body['message'] : null,
                $empId
            );
            Auth::jsonResponse($res);
        } catch (\Throwable $e) {
            Auth::abort(400, $e->getMessage());
        }
    }

    if (preg_match('#^/api/v1/sms/paddy-purchase/(\d+)$#', $uri, $m) && $method === 'POST') {
        Auth::requirePermission($emp, 'paddy.purchase.create');
        $purchaseId = (int)$m[1];
        $stmt       = $pdo->prepare(
            'SELECT p.*, pt.name AS supplier_name, pt.phone AS supplier_phone, w.name AS warehouse_name, i.name AS item_name
             FROM paddy_purchases p
             JOIN parties pt ON pt.id = p.supplier_id
             JOIN warehouses w ON w.id = p.warehouse_id
             JOIN items i ON i.id = p.item_id
             WHERE p.id = ?'
        );
        $stmt->execute([$purchaseId]);
        $purchase = $stmt->fetch();
        if (!$purchase) {
            Auth::abort(404, 'Paddy purchase not found');
        }

        $safePurchase = Auth::isPhysicalOnlyUser($emp)
            ? Auth::sanitizePurchaseForPhysical($purchase)
            : $purchase;

        $channel = (string)($body['channel'] ?? 'GATEWAY');
        if ($channel === 'MANUAL_WHATSAPP' || $channel === 'MANUAL_SMS') {
            SmsService::recordLog($pdo, [
                'entityType'       => 'PADDY_PURCHASE',
                'entityId'         => $purchaseId,
                'entityCode'       => (string)($safePurchase['purchase_no'] ?? ''),
                'partyId'          => !empty($safePurchase['supplier_id']) ? (int)$safePurchase['supplier_id'] : null,
                'partyName'        => (string)($safePurchase['supplier_name'] ?? ''),
                'phone'            => (string)($body['phone'] ?? $safePurchase['supplier_phone'] ?? ''),
                'provider'         => $channel,
                'messageBody'      => substr((string)($body['message_body'] ?? ''), 0, 1000),
                'status'           => $channel,
                'providerResponse' => 'Launched from client app',
                'createdBy'        => $empId,
            ]);
            Auth::jsonResponse(['status' => $channel]);
        }

        $result = SmsService::dispatchPaddyPurchaseSms($pdo, [
            'purchase'        => $safePurchase,
            'employeeId'      => $empId,
            'forceManualSend' => true,
            'overridePhone'   => isset($body['phone']) ? (string)$body['phone'] : null,
            'overrideLang'    => ($body['lang'] ?? '') === 'en' ? 'en' : 'bn',
            'triggerType'     => 'MANUAL',
        ]);
        Auth::jsonResponse($result);
    }

    return false;
}
