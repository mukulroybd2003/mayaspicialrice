import type { AppLang } from '../i18n/translations';
import type {
  Account,
  DirectPaddySale,
  DryingBatch,
  InventoryLot,
  PaddyPurchase,
  Party,
  PaymentRecord,
  ProductionBatch,
  SalesInvoice,
  StockLedgerEntry,
  StockTransfer,
} from '../types/erp';
import { computePartyDueAdvance } from './partyBalance';
import { getCompanyBranding } from './companySettings';
import { exportExcelWorkbook, exportPdfTableReport } from './reports';

export interface ReportDataset {
  customers: Party[];
  suppliers: Party[];
  payments: PaymentRecord[];
  purchases: PaddyPurchase[];
  invoices: SalesInvoice[];
  paddySales: DirectPaddySale[];
  lots: InventoryLot[];
  batches: ProductionBatch[];
  dryingBatches: DryingBatch[];
  stockLedger: StockLedgerEntry[];
  transfers: StockTransfer[];
  accounts: Account[];
}

export function exportAllReportsWorkbook(data: ReportDataset, lang: AppLang) {
  const bn = lang === 'bn';
  const statusStr = (active: number | boolean) => (active ? (bn ? 'সক্রিয়' : 'ACTIVE') : bn ? 'নিষ্ক্রিয়' : 'INACTIVE');

  exportExcelWorkbook(
    'SonaGrain-All-Reports-Workbook',
    [
      {
        name: bn ? 'কাস্টমার বকেয়া ও অগ্রিম' : 'Customers Due & Advance',
        rows: data.customers.map((c) => {
          const { due, advance } = computePartyDueAdvance(c, 'CUSTOMER');
          return bn
            ? {
                কোড: c.party_code,
                কাস্টমার: c.name,
                ফোন: c.phone || '',
                মোট_বিক্রয়: Number(c.total_sold || 0),
                বকেয়া: due,
                অগ্রিম: advance,
                অবস্থা: statusStr(c.is_active),
              }
            : {
                Code: c.party_code,
                CustomerName: c.name,
                Phone: c.phone || '',
                TotalSales: Number(c.total_sold || 0),
                CustomerDue: due,
                CustomerAdvance: advance,
                Status: statusStr(c.is_active),
              };
        }),
      },
      {
        name: bn ? 'সাপ্লায়ার বকেয়া ও অগ্রিম' : 'Suppliers Due & Advance',
        rows: data.suppliers.map((s) => {
          const { due, advance } = computePartyDueAdvance(s, 'SUPPLIER');
          return bn
            ? {
                কোড: s.party_code,
                সাপ্লায়ার: s.name,
                ফোন: s.phone || '',
                মোট_ক্রয়: Number(s.total_purchased || 0),
                বকেয়া: due,
                অগ্রিম: advance,
                অবস্থা: statusStr(s.is_active),
              }
            : {
                Code: s.party_code,
                SupplierName: s.name,
                Phone: s.phone || '',
                TotalPurchased: Number(s.total_purchased || 0),
                SupplierDue: due,
                SupplierAdvance: advance,
                Status: statusStr(s.is_active),
              };
        }),
      },
      {
        name: bn ? 'পেমেন্ট ও অগ্রিম ভাউচার' : 'Payments & Advances',
        rows: data.payments.map((p) =>
          bn
            ? {
                ভাউচার_নং: p.payment_no,
                ধরন: p.voucher_type || p.direction,
                পার্টি: p.party_name,
                অ্যাকাউন্ট: p.account_name,
                মাধ্যম: p.payment_mode,
                বিল_রেফ: p.settled_ref_no || '',
                টাকা: p.amount,
                তারিখ: p.created_at,
              }
            : {
                VoucherNo: p.payment_no,
                VoucherType: p.voucher_type || p.direction,
                Direction: p.direction,
                Party: p.party_name,
                Account: p.account_name,
                Mode: p.payment_mode,
                SettledBill: p.settled_ref_no || '',
                Amount: p.amount,
                Date: p.created_at,
              }
        ),
      },
      {
        name: bn ? 'ধান ক্রয় ৪-ওজন' : 'Paddy Purchases',
        rows: data.purchases.map((p) =>
          bn
            ? {
                ক্রয়_নং: p.purchase_no,
                সাপ্লায়ার: p.supplier_name,
                চালান_কেজি: p.supplier_claimed_weight_kg,
                স্কেল_কেজি: p.scale_weight_kg,
                গৃহীত_কেজি: p.received_weight_kg,
                পেমেন্ট_কেজি: p.payment_weight_kg,
                ঘাটতি_কেজি: p.weight_loss_kg || 0,
                ডিভাইজর: p.settlement_unit_kg || 75.5,
                দর: p.settlement_rate || Number((p.rate_per_kg * (p.settlement_unit_kg || 75.5)).toFixed(2)),
                পার্থক্য_কেজি: p.weight_discrepancy_kg,
                মোট_প্রদেয়: p.total_payable,
                পরিশোধিত: p.paid_amount,
                অবস্থা: p.payment_status,
              }
            : {
                PurchaseNo: p.purchase_no,
                Supplier: p.supplier_name,
                ClaimedKg: p.supplier_claimed_weight_kg,
                ScaleKg: p.scale_weight_kg,
                ReceivedKg: p.received_weight_kg,
                PaymentKg: p.payment_weight_kg,
                WeightLossKg: p.weight_loss_kg || 0,
                SettlementDivisor: p.settlement_unit_kg || 75.5,
                SettlementRate: p.settlement_rate || Number((p.rate_per_kg * (p.settlement_unit_kg || 75.5)).toFixed(2)),
                DiscrepancyKg: p.weight_discrepancy_kg,
                TotalPayable: p.total_payable,
                Paid: p.paid_amount,
                Status: p.payment_status,
              }
        ),
      },
      {
        name: bn ? 'চাল বিক্রয় চালান' : 'Rice Sales Invoices',
        rows: data.invoices.map((i) =>
          bn
            ? {
                চালান_নং: i.invoice_no,
                কাস্টমার: i.customer_name,
                মোট_টাকা: i.total_amount,
                খরচ_COGS: i.total_cogs,
                মুনাফা: Number((i.total_amount - i.total_cogs).toFixed(2)),
                প্রাপ্ত: i.paid_amount,
                অবস্থা: i.payment_status,
              }
            : {
                InvoiceNo: i.invoice_no,
                Customer: i.customer_name,
                TotalAmount: i.total_amount,
                COGS: i.total_cogs,
                GrossProfit: Number((i.total_amount - i.total_cogs).toFixed(2)),
                Paid: i.paid_amount,
                Status: i.payment_status,
              }
        ),
      },
      {
        name: bn ? 'সরাসরি ধান বিক্রয়' : 'Direct Paddy Sales',
        rows: data.paddySales.map((s) =>
          bn
            ? {
                বিক্রয়_নং: s.sale_no,
                কাস্টমার: s.customer_name,
                পণ্য: s.item_name,
                পরিমাণ_কেজি: s.qty_kg,
                মোট_টাকা: s.total_amount,
                খরচ_COGS: s.cogs_amount,
                অবস্থা: s.payment_status,
              }
            : {
                SaleNo: s.sale_no,
                Customer: s.customer_name,
                Item: s.item_name,
                QtyKg: s.qty_kg,
                TotalAmount: s.total_amount,
                COGS: s.cogs_amount,
                Status: s.payment_status,
              }
        ),
      },
      {
        name: bn ? 'ইনভেন্টরি লট' : 'Inventory Lots',
        rows: data.lots.map((l) =>
          bn
            ? {
                লট_কোড: l.lot_code,
                পণ্য: l.item_name,
                গুদাম: l.warehouse_name,
                অবশিষ্ট_কেজি: l.remaining_qty_kg,
                একক_খরচ: l.unit_cost_per_kg,
                মোট_মূল্য: Number((l.remaining_qty_kg * l.unit_cost_per_kg).toFixed(2)),
              }
            : {
                LotCode: l.lot_code,
                Item: l.item_name,
                Godown: l.warehouse_name,
                RemainingKg: l.remaining_qty_kg,
                UnitCost: l.unit_cost_per_kg,
                TotalValue: Number((l.remaining_qty_kg * l.unit_cost_per_kg).toFixed(2)),
              }
        ),
      },
      {
        name: bn ? 'উৎপাদন কস্ট শিট' : 'Production Cost Sheets',
        rows: data.batches.map((b) =>
          bn
            ? {
                ব্যাচ_নং: b.batch_no,
                প্রক্রিয়া: b.process_type,
                ইনপুট_কেজি: b.input_paddy_qty_kg,
                মূল_চাল_কেজি: b.head_rice_qty_kg,
                হার_শতাংশ: b.head_rice_yield_pct,
                নিট_খরচ: b.cost_sheet?.net_head_rice_cost || 0,
                প্রতি_কেজি_খরচ: b.cost_sheet?.cost_per_kg_head_rice || 0,
              }
            : {
                BatchNo: b.batch_no,
                Process: b.process_type,
                InputKg: b.input_paddy_qty_kg,
                HeadRiceKg: b.head_rice_qty_kg,
                YieldPct: b.head_rice_yield_pct,
                NetCost: b.cost_sheet?.net_head_rice_cost || 0,
                CostPerKg: b.cost_sheet?.cost_per_kg_head_rice || 0,
              }
        ),
      },
      {
        name: bn ? 'স্টক লেজার' : 'Stock Ledger',
        rows: data.stockLedger.map((sl) =>
          bn
            ? {
                তারিখ: sl.created_at,
                লট: sl.lot_code,
                পণ্য: sl.item_name,
                গুদাম: sl.warehouse_name,
                মুভমেন্ট: sl.movement_type,
                পরিবর্তন_কেজি: sl.qty_change_kg,
                মোট_খরচ: sl.total_cost,
              }
            : {
                Date: sl.created_at,
                Lot: sl.lot_code,
                Item: sl.item_name,
                Warehouse: sl.warehouse_name,
                Movement: sl.movement_type,
                QtyChangeKg: sl.qty_change_kg,
                TotalCost: sl.total_cost,
              }
        ),
      },
      {
        name: bn ? 'ট্রায়াল ব্যালেন্স' : 'Trial Balance',
        rows: data.accounts.map((a) =>
          bn
            ? {
                কোড: a.account_code,
                অ্যাকাউন্ট: a.name,
                ধরন: a.account_type,
                ব্যালেন্স: a.balance,
              }
            : {
                Code: a.account_code,
                Account: a.name,
                Type: a.account_type,
                Balance: a.balance,
              }
        ),
      },
    ],
    lang
  );
}

export function exportIndividualReport(
  reportNum: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10,
  format: 'pdf' | 'excel',
  lang: AppLang,
  data: ReportDataset
) {
  const bn = lang === 'bn';
  const statusStr = (active: number | boolean) => (active ? (bn ? 'সক্রিয়' : 'ACTIVE') : bn ? 'নিষ্ক্রিয়' : 'INACTIVE');

  switch (reportNum) {
    case 1: {
      if (format === 'pdf') {
        exportPdfTableReport({
          lang,
          title: bn ? 'কাস্টমার বকেয়া ও অগ্রিম বিবরণী রিপোর্ট' : 'Customer Due & Advance Statement Report',
          subtitle: bn ? `মোট কাস্টমার: ${data.customers.length}` : `Customers: ${data.customers.length}`,
          filename: 'SonaGrain-Customer-Due-Advance',
          columns: bn
            ? ['কোড', 'কাস্টমার', 'ফোন', 'মোট বিক্রয়', 'বকেয়া (৳)', 'অগ্রিম (৳)', 'অবস্থা']
            : ['Code', 'Customer', 'Phone', 'Total Sales', 'Due (BDT)', 'Advance (BDT)', 'Status'],
          rows: data.customers.map((c) => {
            const { due, advance } = computePartyDueAdvance(c, 'CUSTOMER');
            return [
              c.party_code,
              c.name,
              c.phone || '-',
              Number(c.total_sold || 0).toFixed(2),
              due.toFixed(2),
              advance.toFixed(2),
              statusStr(c.is_active),
            ];
          }),
        });
      } else {
        exportExcelWorkbook(
          'SonaGrain-Customer-Due-Advance',
          [
            {
              name: bn ? 'কাস্টমার বকেয়া ও অগ্রিম' : 'Customers Due & Advance',
              rows: data.customers.map((c) => {
                const { due, advance } = computePartyDueAdvance(c, 'CUSTOMER');
                return bn
                  ? {
                      কোড: c.party_code,
                      কাস্টমার: c.name,
                      ফোন: c.phone || '',
                      মোট_বিক্রয়: Number(c.total_sold || 0),
                      বকেয়া: due,
                      অগ্রিম: advance,
                      অবস্থা: statusStr(c.is_active),
                    }
                  : {
                      Code: c.party_code,
                      Customer: c.name,
                      Phone: c.phone || '',
                      TotalSales: Number(c.total_sold || 0),
                      CustomerDue: due,
                      CustomerAdvance: advance,
                      Status: statusStr(c.is_active),
                    };
              }),
            },
          ],
          lang
        );
      }
      break;
    }

    case 2: {
      if (format === 'pdf') {
        exportPdfTableReport({
          lang,
          title: bn ? 'সাপ্লায়ার বকেয়া ও অগ্রিম বিবরণী রিপোর্ট' : 'Supplier Due & Advance Statement Report',
          subtitle: bn ? `মোট সাপ্লায়ার: ${data.suppliers.length}` : `Suppliers: ${data.suppliers.length}`,
          filename: 'SonaGrain-Supplier-Due-Advance',
          columns: bn
            ? ['কোড', 'সাপ্লায়ার', 'ফোন', 'মোট ক্রয়', 'বকেয়া (৳)', 'অগ্রিম (৳)', 'অবস্থা']
            : ['Code', 'Supplier', 'Phone', 'Purchased', 'Due (BDT)', 'Advance (BDT)', 'Status'],
          rows: data.suppliers.map((s) => {
            const { due, advance } = computePartyDueAdvance(s, 'SUPPLIER');
            return [
              s.party_code,
              s.name,
              s.phone || '-',
              Number(s.total_purchased || 0).toFixed(2),
              due.toFixed(2),
              advance.toFixed(2),
              statusStr(s.is_active),
            ];
          }),
        });
      } else {
        exportExcelWorkbook(
          'SonaGrain-Supplier-Due-Advance',
          [
            {
              name: bn ? 'সাপ্লায়ার বকেয়া ও অগ্রিম' : 'Suppliers Due & Advance',
              rows: data.suppliers.map((s) => {
                const { due, advance } = computePartyDueAdvance(s, 'SUPPLIER');
                return bn
                  ? {
                      কোড: s.party_code,
                      সাপ্লায়ার: s.name,
                      ফোন: s.phone || '',
                      মোট_ক্রয়: Number(s.total_purchased || 0),
                      বকেয়া: due,
                      অগ্রিম: advance,
                      অবস্থা: statusStr(s.is_active),
                    }
                  : {
                      Code: s.party_code,
                      Supplier: s.name,
                      Phone: s.phone || '',
                      TotalPurchased: Number(s.total_purchased || 0),
                      SupplierDue: due,
                      SupplierAdvance: advance,
                      Status: statusStr(s.is_active),
                    };
              }),
            },
          ],
          lang
        );
      }
      break;
    }

    case 3: {
      if (format === 'pdf') {
        exportPdfTableReport({
          lang,
          title: bn ? 'বকেয়া ও অগ্রিম পেমেন্ট / প্রাপ্তি রেজিস্টার' : 'Due & Advance Payment / Receipt Register',
          subtitle: bn ? `মোট ভাউচার: ${data.payments.length}` : `Vouchers: ${data.payments.length}`,
          filename: 'SonaGrain-Payment-Advance-Register',
          columns: bn
            ? ['ভাউচার নং', 'ধরন', 'পার্টি', 'অ্যাকাউন্ট', 'মাধ্যম', 'বিল রেফ', 'টাকা', 'তারিখ']
            : ['Voucher No', 'Type', 'Party', 'Account', 'Mode', 'Settled Ref', 'Amount', 'Date'],
          rows: data.payments.map((p) => [
            p.payment_no,
            p.voucher_type || p.direction,
            p.party_name || '',
            p.account_name || '',
            p.payment_mode,
            p.settled_ref_no || '-',
            p.amount.toFixed(2),
            p.created_at.slice(0, 16),
          ]),
        });
      } else {
        exportExcelWorkbook(
          'SonaGrain-Payment-Advance-Register',
          [
            {
              name: bn ? 'পেমেন্ট ও অগ্রিম ভাউচার' : 'Payment & Advance Vouchers',
              rows: data.payments.map((p) =>
                bn
                  ? {
                      ভাউচার_নং: p.payment_no,
                      ভাউচার_ধরন: p.voucher_type || p.direction,
                      দিক: p.direction,
                      পার্টি: p.party_name,
                      অ্যাকাউন্ট: p.account_name,
                      মাধ্যম: p.payment_mode,
                      ব্যাংক_রেফ: p.reference_no || '',
                      সমন্বয়_বিল: p.settled_ref_no || '',
                      টাকা: p.amount,
                      নোট: p.notes || '',
                      তারিখ: p.created_at,
                    }
                  : {
                      VoucherNo: p.payment_no,
                      VoucherType: p.voucher_type || p.direction,
                      Direction: p.direction,
                      Party: p.party_name,
                      Account: p.account_name,
                      Mode: p.payment_mode,
                      BankRef: p.reference_no || '',
                      SettledBillRef: p.settled_ref_no || '',
                      Amount: p.amount,
                      Notes: p.notes || '',
                      Date: p.created_at,
                    }
              ),
            },
          ],
          lang
        );
      }
      break;
    }

    case 4: {
      if (format === 'pdf') {
        exportPdfTableReport({
          lang,
          title: bn ? 'ধান ক্রয় ৪-ওজন ও সেটেলমেন্ট অডিট রিপোর্ট' : 'Paddy Purchase 4-Weight & Settlement Audit Report',
          subtitle: bn ? `মোট রসিদ: ${data.purchases.length}` : `Receipts: ${data.purchases.length}`,
          filename: 'SonaGrain-Paddy-Purchases',
          columns: bn
            ? ['রসিদ', 'সাপ্লায়ার', 'চালান', 'স্কেল', 'গৃহীত', 'পেমেন্ট', 'ঘাটতি', 'ডিভাইজর', 'দর', 'প্রদেয়', 'পরিশোধ', 'অবস্থা']
            : ['Receipt', 'Supplier', 'Claimed kg', 'Scale kg', 'Received kg', 'Payment kg', 'Loss kg', 'Divisor', 'Rate', 'Payable', 'Paid', 'Status'],
          rows: data.purchases.map((p) => [
            p.purchase_no,
            p.supplier_name || '',
            p.supplier_claimed_weight_kg,
            p.scale_weight_kg,
            p.received_weight_kg,
            p.payment_weight_kg,
            Number(p.weight_loss_kg ?? 0),
            Number(p.settlement_unit_kg ?? 75.5),
            Number(p.settlement_rate ?? p.rate_per_kg ?? 0).toFixed(2),
            p.total_payable.toFixed(2),
            p.paid_amount.toFixed(2),
            p.payment_status,
          ]),
        });
      } else {
        exportExcelWorkbook(
          'SonaGrain-Paddy-Purchases',
          [
            {
              name: bn ? 'ধান ক্রয় ৪-ওজন' : 'Paddy Purchases',
              rows: data.purchases.map((p) =>
                bn
                  ? {
                      ক্রয়_নং: p.purchase_no,
                      তারিখ: p.created_at,
                      সাপ্লায়ার: p.supplier_name,
                      পণ্য: p.item_name,
                      চালান_কেজি: p.supplier_claimed_weight_kg,
                      স্কেল_কেজি: p.scale_weight_kg,
                      গৃহীত_কেজি: p.received_weight_kg,
                      পেমেন্ট_কেজি: p.payment_weight_kg,
                      ঘাটতি_কেজি: Number(p.weight_loss_kg ?? 0),
                      ডিভাইজর: Number(p.settlement_unit_kg ?? 75.5),
                      দর: Number(p.settlement_rate ?? p.rate_per_kg ?? 0),
                      পার্থক্য_কেজি: p.weight_discrepancy_kg,
                      মোট_প্রদেয়: p.total_payable,
                      পরিশোধিত: p.paid_amount,
                      অবস্থা: p.payment_status,
                    }
                  : {
                      PurchaseNo: p.purchase_no,
                      Date: p.created_at,
                      Supplier: p.supplier_name,
                      Item: p.item_name,
                      ClaimedKg: p.supplier_claimed_weight_kg,
                      ScaleKg: p.scale_weight_kg,
                      ReceivedKg: p.received_weight_kg,
                      PaymentKg: p.payment_weight_kg,
                      WeightLossKg: Number(p.weight_loss_kg ?? 0),
                      SettlementDivisor: Number(p.settlement_unit_kg ?? 75.5),
                      SettlementRate: Number(p.settlement_rate ?? p.rate_per_kg ?? 0),
                      DiscrepancyKg: p.weight_discrepancy_kg,
                      TotalPayable: p.total_payable,
                      PaidAmount: p.paid_amount,
                      Status: p.payment_status,
                    }
              ),
            },
          ],
          lang
        );
      }
      break;
    }

    case 5: {
      if (format === 'pdf') {
        exportPdfTableReport({
          lang,
          title: bn ? 'চাল ও উপজাত বিক্রয় ও মোট মুনাফা রিপোর্ট' : 'Rice & By-Product Sales & Gross Margin Report',
          subtitle: bn ? `মোট চালান: ${data.invoices.length}` : `Invoices: ${data.invoices.length}`,
          filename: 'SonaGrain-Rice-Sales-Report',
          columns: bn
            ? ['চালান নং', 'কাস্টমার', 'মোট (৳)', 'খরচ (COGS)', 'মোট মুনাফা', 'প্রাপ্তি', 'অবস্থা', 'তারিখ']
            : ['Invoice No', 'Customer', 'Total (BDT)', 'COGS', 'Gross Margin', 'Paid', 'Status', 'Date'],
          rows: data.invoices.map((i) => [
            i.invoice_no,
            i.customer_name || '',
            i.total_amount.toFixed(2),
            i.total_cogs.toFixed(2),
            (i.total_amount - i.total_cogs).toFixed(2),
            i.paid_amount.toFixed(2),
            i.payment_status,
            i.created_at.slice(0, 16),
          ]),
        });
      } else {
        exportExcelWorkbook(
          'SonaGrain-Rice-Sales-Report',
          [
            {
              name: bn ? 'চাল বিক্রয় চালান' : 'Sales Invoices',
              rows: data.invoices.map((i) =>
                bn
                  ? {
                      চালান_নং: i.invoice_no,
                      তারিখ: i.created_at,
                      কাস্টমার: i.customer_name,
                      সাবটোটাল: i.subtotal_amount,
                      ট্যাক্স: i.tax_amount,
                      ছাড়: i.discount_amount,
                      মোট_টাকা: i.total_amount,
                      খরচ_COGS: i.total_cogs,
                      মোট_মুনাফা: Number((i.total_amount - i.total_cogs).toFixed(2)),
                      প্রাপ্তি: i.paid_amount,
                      অবস্থা: i.payment_status,
                    }
                  : {
                      InvoiceNo: i.invoice_no,
                      Date: i.created_at,
                      Customer: i.customer_name,
                      Subtotal: i.subtotal_amount,
                      Tax: i.tax_amount,
                      Discount: i.discount_amount,
                      TotalAmount: i.total_amount,
                      COGS: i.total_cogs,
                      GrossProfit: Number((i.total_amount - i.total_cogs).toFixed(2)),
                      PaidAmount: i.paid_amount,
                      Status: i.payment_status,
                    }
              ),
            },
          ],
          lang
        );
      }
      break;
    }

    case 6: {
      if (format === 'pdf') {
        exportPdfTableReport({
          lang,
          title: bn ? 'সরাসরি ধান বিক্রয় রিপোর্ট' : 'Direct Paddy Sales Report',
          subtitle: bn ? `মোট বিক্রয়: ${data.paddySales.length}` : `Dispatches: ${data.paddySales.length}`,
          filename: 'SonaGrain-Direct-Paddy-Sales',
          columns: bn
            ? ['বিক্রয় নং', 'কাস্টমার', 'পণ্য', 'গুদাম', 'পরিমাণ কেজি', 'দর', 'মোট (৳)', 'COGS', 'অবস্থা']
            : ['Sale No', 'Customer', 'Item', 'Godown', 'Qty kg', 'Rate', 'Total (BDT)', 'COGS', 'Status'],
          rows: data.paddySales.map((s) => [
            s.sale_no,
            s.customer_name || '',
            s.item_name || '',
            s.warehouse_name || '',
            s.qty_kg,
            s.rate_per_kg.toFixed(2),
            s.total_amount.toFixed(2),
            s.cogs_amount.toFixed(2),
            s.payment_status,
          ]),
        });
      } else {
        exportExcelWorkbook(
          'SonaGrain-Direct-Paddy-Sales',
          [
            {
              name: bn ? 'সরাসরি ধান বিক্রয়' : 'Direct Paddy Sales',
              rows: data.paddySales.map((s) =>
                bn
                  ? {
                      বিক্রয়_নং: s.sale_no,
                      তারিখ: s.created_at,
                      কাস্টমার: s.customer_name,
                      পণ্য: s.item_name,
                      গুদাম: s.warehouse_name,
                      পরিমাণ_কেজি: s.qty_kg,
                      দর: s.rate_per_kg,
                      মোট_টাকা: s.total_amount,
                      খরচ_COGS: s.cogs_amount,
                      প্রাপ্তি: s.paid_amount,
                      অবস্থা: s.payment_status,
                    }
                  : {
                      SaleNo: s.sale_no,
                      Date: s.created_at,
                      Customer: s.customer_name,
                      Item: s.item_name,
                      Warehouse: s.warehouse_name,
                      QtyKg: s.qty_kg,
                      Rate: s.rate_per_kg,
                      TotalAmount: s.total_amount,
                      COGS: s.cogs_amount,
                      PaidAmount: s.paid_amount,
                      Status: s.payment_status,
                    }
              ),
            },
          ],
          lang
        );
      }
      break;
    }

    case 7: {
      if (format === 'pdf') {
        exportPdfTableReport({
          lang,
          title: bn ? 'বহু-গুদাম স্টক মূল্যায়ন রিপোর্ট' : 'Multi-Godown Inventory Valuation Report',
          subtitle: bn ? `মোট লট: ${data.lots.length}` : `Total Lots: ${data.lots.length}`,
          filename: 'SonaGrain-Stock-Valuation',
          columns: bn
            ? ['লট', 'পণ্য', 'গুদাম', 'প্রাথমিক কেজি', 'অবশিষ্ট কেজি', 'একক খরচ', 'মোট মূল্য']
            : ['Lot', 'Item', 'Godown', 'Initial kg', 'Remaining kg', 'Unit Cost', 'Total Value'],
          rows: data.lots.map((l) => [
            l.lot_code,
            l.item_name || '',
            l.warehouse_name || '',
            l.initial_qty_kg,
            l.remaining_qty_kg,
            l.unit_cost_per_kg.toFixed(2),
            (l.remaining_qty_kg * l.unit_cost_per_kg).toFixed(2),
          ]),
        });
      } else {
        exportExcelWorkbook(
          'SonaGrain-Stock-Valuation',
          [
            {
              name: bn ? 'ইনভেন্টরি লট' : 'Inventory Lots',
              rows: data.lots.map((l) =>
                bn
                  ? {
                      লট_কোড: l.lot_code,
                      পণ্য: l.item_name,
                      গুদাম: l.warehouse_name,
                      প্রাথমিক_কেজি: l.initial_qty_kg,
                      অবশিষ্ট_কেজি: l.remaining_qty_kg,
                      একক_খরচ: l.unit_cost_per_kg,
                      মোট_মূল্য: Number((l.remaining_qty_kg * l.unit_cost_per_kg).toFixed(2)),
                    }
                  : {
                      LotCode: l.lot_code,
                      Item: l.item_name,
                      Godown: l.warehouse_name,
                      InitialKg: l.initial_qty_kg,
                      RemainingKg: l.remaining_qty_kg,
                      UnitCost: l.unit_cost_per_kg,
                      TotalValue: Number((l.remaining_qty_kg * l.unit_cost_per_kg).toFixed(2)),
                    }
              ),
            },
          ],
          lang
        );
      }
      break;
    }

    case 8: {
      if (format === 'pdf') {
        exportPdfTableReport({
          lang,
          title: bn ? 'স্টক মুভমেন্ট ও গুদাম স্থানান্তর লেজার রিপোর্ট' : 'Stock Movement Ledger Report',
          subtitle: bn ? `মোট মুভমেন্ট: ${data.stockLedger.length}` : `Movements: ${data.stockLedger.length}`,
          filename: 'SonaGrain-Stock-Ledger',
          columns: bn
            ? ['তারিখ', 'লট', 'পণ্য', 'গুদাম', 'মুভমেন্ট', 'পরিবর্তন কেজি', 'মোট খরচ', 'অপারেটর']
            : ['Date', 'Lot', 'Item', 'Godown', 'Movement', 'Qty Change kg', 'Total Cost', 'By'],
          rows: data.stockLedger.map((sl) => [
            sl.created_at.slice(0, 16),
            sl.lot_code || '',
            sl.item_name || '',
            sl.warehouse_name || '',
            sl.movement_type,
            sl.qty_change_kg,
            sl.total_cost.toFixed(2),
            sl.employee_name || '',
          ]),
        });
      } else {
        exportExcelWorkbook(
          'SonaGrain-Stock-Movement-Transfers',
          [
            {
              name: bn ? 'স্টক লেজার' : 'Stock Ledger',
              rows: data.stockLedger.map((sl) =>
                bn
                  ? {
                      তারিখ: sl.created_at,
                      লট_কোড: sl.lot_code,
                      পণ্য: sl.item_name,
                      গুদাম: sl.warehouse_name,
                      ধরন: sl.movement_type,
                      পরিবর্তন_কেজি: sl.qty_change_kg,
                      একক_খরচ: sl.unit_cost_per_kg,
                      মোট_খরচ: sl.total_cost,
                      কর্মচারী: sl.employee_name,
                    }
                  : {
                      Date: sl.created_at,
                      LotCode: sl.lot_code,
                      Item: sl.item_name,
                      Godown: sl.warehouse_name,
                      MovementType: sl.movement_type,
                      QtyChangeKg: sl.qty_change_kg,
                      UnitCost: sl.unit_cost_per_kg,
                      TotalCost: sl.total_cost,
                      Employee: sl.employee_name,
                    }
              ),
            },
            {
              name: bn ? 'গুদাম স্থানান্তর' : 'Godown Transfers',
              rows: data.transfers.map((t) =>
                bn
                  ? {
                      স্থানান্তর_নং: t.transfer_no,
                      তারিখ: t.created_at,
                      প্রেরক_গুদাম: t.from_warehouse_name,
                      গন্তব্য_গুদাম: t.to_warehouse_name,
                      পণ্য: t.item_name,
                      পরিমাণ_কেজি: t.qty_kg,
                      মোট_খরচ: t.total_cost,
                    }
                  : {
                      TransferNo: t.transfer_no,
                      Date: t.created_at,
                      FromGodown: t.from_warehouse_name,
                      ToGodown: t.to_warehouse_name,
                      Item: t.item_name,
                      QtyKg: t.qty_kg,
                      TotalCost: t.total_cost,
                    }
              ),
            },
          ],
          lang
        );
      }
      break;
    }

    case 9: {
      if (format === 'pdf') {
        exportPdfTableReport({
          lang,
          title: bn ? 'সিদ্ধ ও আতপ উৎপাদন কস্টিং সারসংক্ষেপ' : 'Siddho & Atap Production Costing Summary',
          subtitle: bn
            ? `মিলিং ব্যাচ: ${data.batches.length} | শুকানোর ব্যাচ: ${data.dryingBatches.length}`
            : `Milling Batches: ${data.batches.length} | Drying Batches: ${data.dryingBatches.length}`,
          filename: 'SonaGrain-Production-Batches',
          columns: bn
            ? ['ব্যাচ', 'প্রক্রিয়া', 'ইনপুট কেজি', 'মূল চাল কেজি', 'হার %', 'উপজাত ক্রেডিট', 'নিট খরচ', 'খরচ/কেজি']
            : ['Batch', 'Process', 'Input kg', 'Head Rice kg', 'Yield %', 'By-Prod Credit', 'Net Cost', 'Cost/kg'],
          rows: data.batches.map((b) => [
            b.batch_no,
            b.process_type,
            b.input_paddy_qty_kg,
            b.head_rice_qty_kg,
            b.head_rice_yield_pct.toFixed(2),
            (b.cost_sheet?.byproduct_credit_value || 0).toFixed(2),
            (b.cost_sheet?.net_head_rice_cost || 0).toFixed(2),
            (b.cost_sheet?.cost_per_kg_head_rice || 0).toFixed(2),
          ]),
        });
      } else {
        exportExcelWorkbook(
          'SonaGrain-Drying-Milling-Cost-Sheets',
          [
            {
              name: bn ? 'মিলিং ব্যাচ' : 'Milling Batches',
              rows: data.batches.map((b) =>
                bn
                  ? {
                      ব্যাচ_নং: b.batch_no,
                      প্রক্রিয়া: b.process_type,
                      ইনপুট_ধান_কেজি: b.input_paddy_qty_kg,
                      মূল_চাল_কেজি: b.head_rice_qty_kg,
                      ভাঙা_চাল_কেজি: b.broken_rice_qty_kg,
                      কুঁড়া_কেজি: b.bran_qty_kg,
                      তুষ_কেজি: b.husk_qty_kg,
                      উৎপাদন_শতাংশ: b.head_rice_yield_pct,
                      মোট_খরচ: b.cost_sheet?.gross_batch_cost || 0,
                      উপজাত_ক্রেডিট: b.cost_sheet?.byproduct_credit_value || 0,
                      নিট_খরচ: b.cost_sheet?.net_head_rice_cost || 0,
                      প্রতি_কেজি_খরচ: b.cost_sheet?.cost_per_kg_head_rice || 0,
                    }
                  : {
                      BatchNo: b.batch_no,
                      Process: b.process_type,
                      InputPaddyKg: b.input_paddy_qty_kg,
                      HeadRiceKg: b.head_rice_qty_kg,
                      BrokenRiceKg: b.broken_rice_qty_kg,
                      BranKg: b.bran_qty_kg,
                      HuskKg: b.husk_qty_kg,
                      YieldPct: b.head_rice_yield_pct,
                      GrossCost: b.cost_sheet?.gross_batch_cost || 0,
                      ByProductCredit: b.cost_sheet?.byproduct_credit_value || 0,
                      NetCost: b.cost_sheet?.net_head_rice_cost || 0,
                      CostPerKg: b.cost_sheet?.cost_per_kg_head_rice || 0,
                    }
              ),
            },
            {
              name: bn ? 'শুকানোর ব্যাচ' : 'Drying Batches',
              rows: data.dryingBatches.map((d) =>
                bn
                  ? {
                      ড্রাইং_নং: d.drying_no,
                      পদ্ধতি: d.drying_method,
                      পণ্য: d.item_name,
                      ইনপুট_কেজি: d.input_qty_kg,
                      আউটপুট_কেজি: d.output_qty_kg,
                      আর্দ্রতা_ঘাটতি: d.moisture_loss_kg,
                      একক_খরচ: d.output_unit_cost_per_kg,
                    }
                  : {
                      DryingNo: d.drying_no,
                      Method: d.drying_method,
                      Item: d.item_name,
                      InputKg: d.input_qty_kg,
                      OutputKg: d.output_qty_kg,
                      MoistureLossKg: d.moisture_loss_kg,
                      OutputCostPerKg: d.output_unit_cost_per_kg,
                    }
              ),
            },
          ],
          lang
        );
      }
      break;
    }

    case 10: {
      if (format === 'pdf') {
        exportPdfTableReport({
          lang,
          title: bn ? `${getCompanyBranding('bn').name} — ট্রায়াল ব্যালেন্স রিপোর্ট` : `${getCompanyBranding('en').name} — Trial Balance Report`,
          subtitle: bn ? `মোট লেজার অ্যাকাউন্ট: ${data.accounts.length}` : `Ledger Accounts: ${data.accounts.length}`,
          filename: 'SonaGrain-Trial-Balance',
          columns: bn
            ? ['অ্যাকাউন্ট কোড', 'অ্যাকাউন্টের নাম', 'শ্রেণি', 'বর্তমান ব্যালেন্স (৳)']
            : ['Account Code', 'Account Name', 'Category', 'Live Balance (BDT)'],
          rows: data.accounts.map((a) => [a.account_code, a.name, a.account_type, a.balance.toFixed(2)]),
        });
      } else {
        exportExcelWorkbook(
          'SonaGrain-Trial-Balance',
          [
            {
              name: bn ? 'ট্রায়াল ব্যালেন্স' : 'Trial Balance',
              rows: data.accounts.map((a) =>
                bn
                  ? {
                      অ্যাকাউন্ট_কোড: a.account_code,
                      অ্যাকাউন্ট_নাম: a.name,
                      অ্যাকাউন্ট_ধরন: a.account_type,
                      ব্যালেন্স: a.balance,
                    }
                  : {
                      AccountCode: a.account_code,
                      AccountName: a.name,
                      AccountType: a.account_type,
                      Balance: a.balance,
                    }
              ),
            },
          ],
          lang
        );
      }
      break;
    }
  }
}
