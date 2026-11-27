export type CostingMethod = 'FIFO' | 'WEIGHTED_AVERAGE';
export type WarehouseType = 'RAW_PADDY' | 'DRYING_YARD' | 'FINISHED_RICE' | 'BY_PRODUCT' | 'GENERAL';
export type ItemCategory = string;
export type CategoryGroupType = 'RAW_MATERIAL' | 'FINISHED_GOOD' | 'BY_PRODUCT';
export type ProcessGrade = 'RAW_PADDY' | 'SIDDHO' | 'ATAP' | 'BY_PRODUCT';
export type ProcessType = 'PARBOILED_SIDDHO' | 'RAW_ATAP';
export type WeighbridgeMode = 'MANUAL' | 'USB_SERIAL' | 'BLUETOOTH_SPP';
export type PartyType = 'SUPPLIER' | 'CUSTOMER' | 'BOTH';

export interface CompanySettings {
  id: number;
  company_name_en: string;
  company_name_bn: string;
  short_code: string;
  tagline_en: string;
  tagline_bn: string;
  address_en: string;
  address_bn: string;
  phone: string;
  email: string;
  tax_id: string;
  logo_data_url?: string;
  updated_at?: string;
}

export interface ProductUnit {
  id: number;
  code: string;
  name: string;
  symbol: string;
  base_weight_kg: number;
  description?: string;
  product_count?: number;
  is_active: boolean;
  created_at?: string;
}

export interface ProductCategory {
  id: number;
  code: string;
  name: string;
  group_type: CategoryGroupType;
  default_costing_method: CostingMethod;
  description?: string;
  product_count?: number;
  is_active: boolean;
  created_at?: string;
}

export interface StockLedgerEntry {
  id: number;
  lot_id: number;
  lot_code?: string;
  item_id: number;
  item_name?: string;
  warehouse_id: number;
  warehouse_name?: string;
  movement_type: string;
  reference_type: string;
  reference_id: number;
  qty_change_kg: number;
  unit_cost_per_kg: number;
  total_cost: number;
  balance_after_kg: number;
  employee_id: number;
  employee_name?: string;
  created_at: string;
}

export interface EmployeeUser {
  id: number;
  employee_code: string;
  full_name: string;
  email: string;
  phone?: string;
  role_id: number;
  role_code: string;
  role_name: string;
  permissions: string[];
  is_active: boolean;
  last_login_at?: string;
}

export interface Warehouse {
  id: number;
  code: string;
  name: string;
  warehouse_type: WarehouseType;
  location: string;
  capacity_kg: number;
  manager_employee_id?: number;
  current_stock_kg?: number;
  is_active: boolean;
}

export type VoucherType = 'DUE_PAYMENT' | 'ADVANCE_PAYMENT' | 'DUE_RECEIPT' | 'ADVANCE_RECEIPT' | 'DUE_SETTLEMENT';

export interface Party {
  id: number;
  party_code: string;
  party_type: PartyType;
  name: string;
  contact_person?: string;
  phone: string;
  email?: string;
  tax_id?: string;
  address?: string;
  credit_limit: number;
  opening_balance: number;
  current_balance: number;
  is_active: boolean;
  created_at?: string;
  total_purchased?: number;
  total_sold?: number;
  total_paid_out?: number;
  total_received_in?: number;
  open_purchase_due?: number;
  open_sales_due?: number;
}

export interface OpenBillItem {
  bill_type: 'PADDY_PURCHASE' | 'SALES_INVOICE' | 'PADDY_SALE';
  bill_id: number;
  bill_no: string;
  date: string;
  total_amount: number;
  paid_amount: number;
  due_amount: number;
  payment_status: string;
}

export interface PartyLedgerEntry {
  date: string;
  entry_type: 'OPENING' | 'PADDY_PURCHASE' | 'SALES_INVOICE' | 'PADDY_SALE' | 'PAYMENT';
  ref_no: string;
  description: string;
  debit_receivable: number;
  credit_payable: number;
  running_balance: number;
  voucher_type?: string;
  payment_mode?: string;
}

export interface PartyLedgerResponse {
  party: Party;
  summary: {
    opening_balance: number;
    total_purchased: number;
    total_sold: number;
    total_paid_out: number;
    total_received_in: number;
    current_balance: number;
    customer_due: number;
    customer_advance: number;
    supplier_due: number;
    supplier_advance: number;
  };
  open_bills: OpenBillItem[];
  entries: PartyLedgerEntry[];
}

export interface ItemMaster {
  id: number;
  sku: string;
  name: string;
  category: ItemCategory;
  process_grade: ProcessGrade;
  unit: string;
  bag_weight_kg: number;
  costing_method: CostingMethod;
  default_rate: number;
  is_active: boolean;
}

export interface InventoryLot {
  id: number;
  lot_code: string;
  qr_code_uid: string;
  item_id: number;
  item_name?: string;
  sku?: string;
  category?: ItemCategory;
  process_grade?: ProcessGrade;
  bag_weight_kg?: number;
  warehouse_id: number;
  warehouse_name?: string;
  warehouse_code?: string;
  warehouse_type?: WarehouseType;
  source_type: string;
  source_id?: number;
  origin_batch_id?: number | null;
  origin_batch_no?: string | null;
  origin_dryer_no?: string | null;
  chatal_batch_id?: number | null;
  purchase_bag_count?: number;
  initial_bags?: number;
  remaining_bags?: number;
  pack_size_kg?: number;
  initial_qty_kg: number;
  remaining_qty_kg: number;
  unit_cost_per_kg: number;
  moisture_pct?: number;
  weight_pending?: number | boolean;
  pending_cost_total?: number;
  dispatched_qty_kg?: number;
  dispatched_bags?: number;
  extra_torn_bags?: number;
  received_at: string;
  version: number;
}

export interface PaddyPurchaseSplit {
  warehouse_id: number;
  warehouse_name?: string;
  bag_count: number;
  jute_bag_count?: number;
  plastic_bag_count?: number;
  received_weight_kg: number;
  net_units?: number;
  allocated_amount?: number;
}

export interface PaddyPurchaseReturn {
  id: number;
  client_uuid: string;
  return_no: string;
  purchase_id: number;
  purchase_no?: string;
  supplier_id: number;
  supplier_name?: string;
  item_id: number;
  item_name?: string;
  return_qty_kg: number;
  return_bags: number;
  return_jute_bags: number;
  return_plastic_bags: number;
  return_amount: number;
  refund_mode: 'ADJUST_PAYABLE' | 'CASH_REFUND';
  account_id?: number | null;
  account_name?: string | null;
  reason?: string;
  created_by?: number;
  created_by_name?: string;
  created_at: string;
}

export interface PaddyPurchase {
  id: number;
  client_uuid: string;
  purchase_no: string;
  supplier_id: number;
  supplier_name?: string;
  supplier_phone?: string;
  warehouse_id: number;
  warehouse_name?: string;
  item_id: number;
  item_name?: string;
  vehicle_no?: string;
  challan_no?: string;
  bag_count: number;
  jute_bag_count?: number;
  plastic_bag_count?: number;
  moisture_pct: number;
  supplier_claimed_weight_kg: number;
  scale_weight_kg: number;
  received_weight_kg: number;
  payment_weight_kg: number;
  weight_loss_kg?: number;
  settlement_unit_kg?: number;
  settlement_rate?: number;
  weight_discrepancy_kg: number;
  discrepancy_flagged: number;
  discrepancy_notes?: string;
  rate_per_kg: number;
  total_payable: number;
  paid_amount: number;
  returned_qty_kg?: number;
  returned_amount?: number;
  unconsumed_lot_qty_kg?: number;
  unconsumed_lot_bags?: number;
  available_variety_stock_kg?: number;
  split_summary_json?: string;
  splits?: PaddyPurchaseSplit[];
  return_logs?: PaddyPurchaseReturn[];
  pricing_status?: 'PENDING_RATE' | 'PRICED';
  paddy_condition?: 'RAW_WET' | 'DRIED';
  drying_logs?: PaddyPurchaseDryingLog[];
  drying_summary?: PaddyPurchaseDryingSummary;
  payment_status: 'UNPAID' | 'PARTIAL' | 'PAID';
  qr_code_uid: string;
  weighbridge_mode: WeighbridgeMode;
  created_by: number;
  created_by_name?: string;
  created_at: string;
}

export interface PaddyPurchaseDryingLog {
  id: number;
  purchase_id: number;
  drying_no: string;
  drying_method: string;
  input_qty_kg: number;
  input_bags: number;
  output_qty_kg: number;
  output_bags: number;
  dispatched_bags?: number;
  moisture_loss_kg: number;
  weight_pending?: number | boolean;
  status: 'IN_PROGRESS' | 'PENDING_WEIGHT' | 'COMPLETED';
  dest_warehouse_name?: string;
  lot_remaining_bags?: number;
  created_at: string;
}

export interface PaddyPurchaseDryingSummary {
  drying_batch_count: number;
  dried_input_kg: number;
  dried_input_bags: number;
  weighed_input_kg: number;
  dried_output_kg: number;
  dried_output_bags: number;
  drying_loss_kg: number;
  pending_input_kg: number;
  pending_output_bags: number;
  chatal_batch_count: number;
  chatal_input_kg: number;
  chatal_input_bags: number;
}

export type SmsProviderType = 'NONE' | 'BULKSMSBD' | 'SMSNETBD' | 'SSLWIRELESS' | 'WEBHOOK';

export interface SmsNotificationResult {
  attempted: boolean;
  status: 'SENT' | 'FAILED' | 'SKIPPED' | 'NOT_CONFIGURED';
  phone: string;
  provider: SmsProviderType;
  message_preview: string;
  error?: string;
}

export interface SmsGatewayPublicConfig {
  provider: SmsProviderType;
  enabled: boolean;
  auto_on_paddy_purchase: boolean;
  auto_on_paddy_price: boolean;
  lang_mode: 'bn' | 'en';
  sender_id: string;
  webhook_url: string;
  message_template: string;
  has_api_key: boolean;
  updated_at?: string;
}

export interface SmsLogEntry {
  id: number;
  entity_type: string;
  entity_id: number;
  entity_code: string;
  party_id?: number | null;
  party_name: string;
  phone: string;
  provider: string;
  message_body: string;
  status: string;
  provider_response: string;
  created_by?: number | null;
  created_at: string;
}

export type SupplierBagEntryType = 'ADVANCE_ISSUE' | 'PADDY_DEPOSIT' | 'EMPTY_PICKUP' | 'EMPTY_RETURN';
export type SupplierBagDirection = 'OUT_TO_SUPPLIER' | 'IN_FROM_SUPPLIER';

export interface SupplierBagSummary {
  supplier_id: number;
  party_code: string;
  supplier_name: string;
  phone?: string;
  address?: string;
  jute_taken: number;
  jute_deposited: number;
  jute_net: number;
  plastic_taken: number;
  plastic_deposited: number;
  plastic_net: number;
  total_taken: number;
  total_deposited: number;
  total_net: number;
  tx_count: number;
}

export interface SupplierBagLedgerEntry {
  id: number;
  client_uuid: string;
  entry_no: string;
  supplier_id: number;
  supplier_name?: string;
  party_code?: string;
  entry_type: SupplierBagEntryType;
  direction: SupplierBagDirection;
  jute_qty: number;
  plastic_qty: number;
  total_qty: number;
  reference_type?: string | null;
  reference_id?: number | null;
  reference_no?: string;
  entry_date: string;
  notes?: string;
  created_by?: number;
  created_by_name?: string;
  created_at: string;
}

export interface StockTransfer {
  id: number;
  client_uuid: string;
  transfer_no: string;
  from_warehouse_id: number;
  from_warehouse_name?: string;
  to_warehouse_id: number;
  to_warehouse_name?: string;
  item_id: number;
  item_name?: string;
  qty_kg: number;
  bag_count?: number;
  unit_divisor?: number;
  net_units?: number;
  bag_unit_rate?: number;
  costing_method: CostingMethod;
  total_cost: number;
  vehicle_or_driver?: string;
  notes?: string;
  qr_code_uid: string;
  created_at: string;
}

export interface DirectPaddySale {
  id: number;
  client_uuid: string;
  sale_no: string;
  customer_id: number;
  customer_name?: string;
  warehouse_id: number;
  warehouse_name?: string;
  item_id: number;
  item_name?: string;
  source_lot_id?: number | null;
  chatal_batch_id?: number | null;
  challan_no?: string;
  bag_count?: number;
  jute_bag_count?: number;
  plastic_bag_count?: number;
  extra_torn_bags?: number;
  moisture_pct?: number;
  scale_weight_kg?: number;
  qty_kg: number;
  payment_weight_kg?: number;
  weight_loss_kg?: number;
  settlement_unit_kg?: number;
  settlement_rate?: number;
  rate_per_kg: number;
  total_amount: number;
  costing_method: CostingMethod;
  cogs_amount: number;
  paid_amount: number;
  payment_status: 'UNPAID' | 'PARTIAL' | 'PAID';
  vehicle_no?: string;
  notes?: string;
  qr_code_uid: string;
  created_at: string;
}

export interface DryingBatch {
  id: number;
  client_uuid: string;
  drying_no: string;
  purchase_id?: number | null;
  purchase_no?: string | null;
  supplier_name?: string | null;
  source_warehouse_id: number;
  source_warehouse_name?: string;
  dest_warehouse_id: number;
  dest_warehouse_name?: string;
  item_id: number;
  item_name?: string;
  drying_method: 'SUN_YARD' | 'MECHANICAL_DRYER';
  input_qty_kg: number;
  input_bags?: number;
  output_bags?: number;
  dispatched_bags?: number;
  extra_torn_bags?: number;
  weight_pending?: number | boolean;
  initial_moisture_pct: number;
  final_moisture_pct: number;
  output_qty_kg: number;
  moisture_loss_kg: number;
  fuel_power_cost: number;
  labor_cost: number;
  input_paddy_cost: number;
  output_unit_cost_per_kg: number;
  exit_settlement_unit_kg?: number;
  exit_settlement_rate?: number;
  exit_total_value?: number;
  notes?: string;
  lot_id?: number | null;
  lot_code?: string | null;
  remaining_bags?: number;
  pending_cost_total?: number;
  status: 'IN_PROGRESS' | 'PENDING_WEIGHT' | 'COMPLETED';
  qr_code_uid: string;
  created_at: string;
}

export interface ProductionCostSheet {
  id: number;
  batch_id: number;
  raw_paddy_cost: number;
  labor_cost: number;
  electricity_cost: number;
  fuel_boiler_cost: number;
  machinery_overhead_cost: number;
  packaging_cost: number;
  gross_batch_cost: number;
  byproduct_credit_value: number;
  net_head_rice_cost: number;
  cost_per_kg_head_rice: number;
  cost_per_bag_head_rice: number;
}

export interface ProductionExpensePayment {
  id: number;
  receipt_no?: string;
  expense_id: number;
  batch_id: number;
  expense_category?: string;
  vendor_name?: string;
  expense_total?: number;
  account_id: number;
  account_name?: string;
  amount: number;
  payment_mode: string;
  reference_no?: string;
  notes?: string;
  paid_by?: number;
  paid_by_name?: string;
  paid_at: string;
}

export interface ProductionBatchExpense {
  id: number;
  batch_id: number;
  expense_category?: string;
  vendor_name?: string;
  labor_cost: number;
  electricity_cost: number;
  fuel_boiler_cost: number;
  machinery_overhead_cost: number;
  packaging_cost: number;
  total_amount: number;
  payment_status?: 'PAID' | 'PARTIAL' | 'UNPAID';
  paid_amount?: number;
  account_id?: number | null;
  paid_at?: string | null;
  notes?: string;
  created_by?: number;
  created_by_name?: string;
  created_at: string;
  payment_logs?: ProductionExpensePayment[];
}

export interface ProductionBatchInput {
  id: number;
  batch_id: number;
  source_warehouse_id: number;
  warehouse_name?: string;
  paddy_item_id: number;
  item_name?: string;
  bag_count: number;
  qty_kg: number;
  unit_divisor: number;
  net_units: number;
  bag_unit_rate: number;
  paddy_cost: number;
  notes?: string;
  created_by?: number;
  created_by_name?: string;
  created_at: string;
}

export interface ProductionOutputRow {
  id: number;
  batch_id: number;
  item_id: number;
  item_name?: string;
  warehouse_id: number;
  warehouse_name?: string;
  output_type: string;
  pack_size_kg: number;
  bag_count: number;
  qty_kg: number;
  rate_per_bag?: number;
  allocated_unit_cost_per_kg: number;
  total_value: number;
  lot_id?: number;
  lot_code?: string;
  remaining_qty_kg?: number;
  remaining_bags?: number;
}

export interface BatchProfitSummary {
  total_batch_cost: number;
  total_expense_paid: number;
  unpaid_expense_due: number;
  total_sold_kg: number;
  total_sold_bags: number;
  total_sold_revenue: number;
  total_sold_cogs: number;
  realized_profit_loss: number;
  unsold_stock_kg: number;
  unsold_stock_bags: number;
  unsold_stock_value: number;
  projected_total_value: number;
  projected_net_profit_loss: number;
  sales_count: number;
}

export interface ProductionBatch {
  id: number;
  client_uuid: string;
  batch_no: string;
  process_type: ProcessType;
  source_warehouse_id: number;
  source_warehouse_name?: string;
  paddy_item_id: number;
  paddy_item_name?: string;
  input_paddy_qty_kg: number;
  input_bag_count?: number;
  dryer_no?: string;
  dryer_count?: number;
  unit_divisor?: number;
  paddy_net_units?: number;
  paddy_bag_unit_rate?: number;
  paddy_formula_cost?: number;
  costing_method: CostingMethod;
  soaking_hours: number;
  steaming_temp_c: number;
  head_rice_qty_kg: number;
  broken_rice_qty_kg: number;
  bran_qty_kg: number;
  husk_qty_kg: number;
  wastage_qty_kg: number;
  head_rice_yield_pct: number;
  total_recovery_pct: number;
  issue_per_unit?: number;
  status: 'IN_PROGRESS' | 'COMPLETED';
  qr_code_uid: string;
  notes?: string;
  chatal_batch_id?: number | null;
  started_at: string;
  completed_at?: string;
  cost_sheet?: ProductionCostSheet;
  input_logs?: ProductionBatchInput[];
  expense_logs?: ProductionBatchExpense[];
  expense_payment_receipts?: ProductionExpensePayment[];
  outputs?: ProductionOutputRow[];
  profit_summary?: BatchProfitSummary;
}

export interface ChatalBatchInput {
  id: number;
  chatal_batch_id: number;
  source_warehouse_id: number;
  source_warehouse_name?: string;
  paddy_item_id: number;
  item_name?: string;
  purchase_id?: number | null;
  lot_id?: number | null;
  bag_count: number;
  qty_kg: number;
  unit_divisor: number;
  net_units: number;
  bag_unit_rate: number;
  paddy_cost: number;
  notes?: string;
  created_by?: number;
  created_by_name?: string;
  created_at: string;
}

export interface ChatalExpensePayment {
  id: number;
  receipt_no?: string;
  expense_id: number;
  chatal_batch_id: number;
  account_id: number;
  account_name?: string;
  amount: number;
  payment_mode: string;
  reference_no?: string;
  notes?: string;
  paid_by?: number;
  paid_by_name?: string;
  paid_at: string;
}

export interface ChatalBatchExpense {
  id: number;
  chatal_batch_id: number;
  expense_type: 'DRYING' | 'KHAMAL' | 'LABOR' | 'FUEL_POWER' | 'PACKAGING' | 'TRANSPORT' | 'OTHER';
  vendor_name?: string;
  total_amount: number;
  payment_status: 'PAID' | 'PARTIAL' | 'UNPAID';
  paid_amount: number;
  account_id?: number | null;
  paid_at?: string | null;
  notes?: string;
  created_by?: number;
  created_by_name?: string;
  created_at: string;
  payment_logs?: ChatalExpensePayment[];
}

export interface ChatalBatchDispatch {
  id: number;
  chatal_batch_id: number;
  round_no: number;
  from_warehouse_id: number;
  from_warehouse_name?: string;
  dest_warehouse_id: number;
  dest_warehouse_name?: string;
  dest_lot_id?: number | null;
  lot_code?: string | null;
  paddy_item_id: number;
  item_name?: string;
  bag_count: number;
  qty_kg: number;
  weight_pending: number | boolean;
  allocated_cost: number;
  sale_style_unit_kg: number;
  sale_style_rate: number;
  sale_style_est_value: number;
  lot_remaining_bags?: number;
  lot_remaining_qty_kg?: number;
  lot_weight_pending?: number | boolean;
  lot_pending_cost_total?: number;
  lot_unit_cost_per_kg?: number;
  notes?: string;
  created_by_name?: string;
  created_at: string;
}

export interface ChatalLinkedCrushing extends ProductionBatch {
  realized_milled_revenue?: number;
  unsold_milled_value?: number;
  unsold_milled_kg?: number;
  extra_milling_overhead?: number;
}

export interface ChatalBatchPnl {
  total_intake_bags: number;
  total_intake_kg: number;
  total_paddy_cost: number;
  drying_cost: number;
  khamal_cost: number;
  other_cost: number;
  total_expenses: number;
  total_expense_paid: number;
  unpaid_expense_due: number;
  total_cost: number;
  chatal_remaining_bags: number;
  chatal_remaining_kg: number;
  chatal_remaining_value: number;
  godown_remaining_bags: number;
  godown_remaining_kg: number;
  godown_remaining_value: number;
  remaining_paddy_value: number;
  direct_sales_count: number;
  direct_sold_bags: number;
  direct_sold_kg: number;
  direct_sale_revenue: number;
  direct_sale_cogs: number;
  crushing_batch_count: number;
  crushing_input_bags: number;
  crushing_input_kg: number;
  crushing_paddy_cost: number;
  crushing_extra_overhead: number;
  crushing_milled_revenue: number;
  crushing_unsold_value: number;
  crushing_net_contribution: number;
  total_realized_revenue: number;
  total_projected_value: number;
  net_profit_loss: number;
  realized_profit_loss: number;
}

export interface ChatalBatch {
  id: number;
  client_uuid: string;
  chatal_no: string;
  title: string;
  chatal_warehouse_id: number;
  chatal_warehouse_name?: string;
  paddy_item_id: number;
  paddy_item_name?: string;
  status: 'ACTIVE' | 'COMPLETED';
  total_intake_bags: number;
  total_intake_kg: number;
  total_paddy_cost: number;
  drying_cost: number;
  khamal_cost: number;
  other_cost: number;
  moisture_loss_kg: number;
  notes?: string;
  qr_code_uid: string;
  created_by?: number;
  created_by_name?: string;
  created_at: string;
  closed_at?: string | null;
  inputs?: ChatalBatchInput[];
  expenses?: ChatalBatchExpense[];
  dispatches?: ChatalBatchDispatch[];
  linked_lots?: InventoryLot[];
  linked_sales?: DirectPaddySale[];
  linked_crushing?: ChatalLinkedCrushing[];
  pnl?: ChatalBatchPnl;
}

export interface SalesInvoiceItem {
  id?: number;
  item_id: number;
  item_name?: string;
  warehouse_id: number;
  warehouse_name?: string;
  bag_count?: number;
  pack_size_kg?: number;
  rate_per_bag?: number;
  qty_kg: number;
  rate_per_kg: number;
  line_total: number;
  costing_method: CostingMethod;
  line_cogs: number;
}

export interface SalesInvoice {
  id: number;
  client_uuid: string;
  invoice_no: string;
  customer_id: number;
  customer_name?: string;
  subtotal_amount: number;
  tax_amount: number;
  discount_amount: number;
  total_amount: number;
  total_cogs: number;
  paid_amount: number;
  payment_status: 'UNPAID' | 'PARTIAL' | 'PAID';
  vehicle_no?: string;
  qr_code_uid: string;
  created_at: string;
  items: SalesInvoiceItem[];
}

export interface WeighbridgeLog {
  id: number;
  client_uuid: string;
  ticket_no: string;
  vehicle_no: string;
  driver_name?: string;
  gross_weight_kg: number;
  tare_weight_kg: number;
  net_weight_kg: number;
  device_mode: WeighbridgeMode;
  raw_device_string?: string;
  operator_id: number;
  operator_name?: string;
  captured_at: string;
}

export interface Account {
  id: number;
  account_code: string;
  name: string;
  account_type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  balance: number;
  is_system?: number;
}

export interface AccountLedgerRow {
  id: number;
  journal_entry_id?: number;
  voucher_no: string;
  entry_date: string;
  description: string;
  contra_head?: string;
  reference_type?: string;
  debit: number;
  credit: number;
  running_balance: number;
}

export interface AccountLedgerResponse {
  account: Account;
  from: string | null;
  to: string | null;
  opening_balance: number;
  total_debit: number;
  total_credit: number;
  closing_balance: number;
  entries: AccountLedgerRow[];
}

export interface CashbookEntry {
  id: number;
  journal_entry_id: number;
  account_id: number;
  account_code: string;
  account_name: string;
  voucher_no: string;
  entry_date: string;
  description: string;
  contra_head?: string;
  reference_type?: string;
  created_at?: string;
  receipt: number;
  payment: number;
  running_balance: number;
}

export interface CashbookReport {
  from: string | null;
  to: string | null;
  account_id: number | 'ALL';
  accounts: Account[];
  opening_balance: number;
  total_receipts: number;
  total_payments: number;
  net_change: number;
  closing_balance: number;
  cash_closing: number;
  bank_closing: number;
  entries: CashbookEntry[];
}

export interface FinancialStatements {
  trial_balance: {
    rows: Array<{
      id: number;
      account_code: string;
      name: string;
      account_type: Account['account_type'];
      debit_balance: number;
      credit_balance: number;
    }>;
    total_debit: number;
    total_credit: number;
    is_balanced: boolean;
  };
  profit_and_loss: {
    revenues: Account[];
    total_revenue: number;
    cogs: Account[];
    total_cogs: number;
    gross_profit: number;
    expenses: Account[];
    total_expenses: number;
    net_profit: number;
  };
  balance_sheet: {
    assets: Account[];
    total_assets: number;
    liabilities: Account[];
    total_liabilities: number;
    equity: Account[];
    total_equity: number;
    current_net_profit: number;
    total_liabilities_and_equity: number;
    is_balanced: boolean;
  };
}

export interface PaymentRecord {
  id: number;
  client_uuid: string;
  payment_no: string;
  direction: 'RECEIPT' | 'PAYMENT';
  voucher_type?: VoucherType;
  party_id: number;
  party_name?: string;
  party_code?: string;
  party_type?: PartyType;
  account_id: number;
  account_name?: string;
  amount: number;
  payment_mode: 'CASH' | 'BANK_TRANSFER' | 'CHEQUE' | 'UPI_MOBILE';
  reference_no?: string;
  settled_ref_no?: string;
  notes?: string;
  created_at: string;
}

export interface JournalEntry {
  id: number;
  voucher_no: string;
  entry_date: string;
  description: string;
  reference_type?: string;
  reference_id?: number;
  created_at?: string;
  lines: Array<{
    account_id?: number;
    account_code: string;
    account_name: string;
    debit: number;
    credit: number;
  }>;
}

export interface AuditLog {
  id: number;
  employee_id?: number;
  employee_name: string;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json?: string;
  after_json?: string;
  device_type?: string;
  created_at: string;
}

export interface OfflineMutation {
  client_uuid: string;
  endpoint: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  payload: Record<string, unknown>;
  module: string;
  summary: string;
  created_at: string;
  status: 'PENDING' | 'SYNCING' | 'CONFLICT' | 'FAILED';
  error_message?: string;
  retries: number;
}

export interface DashboardDryingMethodStat {
  method: string;
  batch_count: number;
  input_kg: number;
  weighed_input_kg: number;
  output_kg: number;
  lost_kg: number;
  pending_kg: number;
  efficiency_pct: number;
}

export interface DashboardDryingRecentRow {
  id: number;
  drying_no: string;
  drying_method: string;
  item_name: string;
  dest_warehouse_name: string;
  purchase_no: string | null;
  input_qty_kg: number;
  input_bags: number;
  output_qty_kg: number;
  output_bags: number;
  moisture_loss_kg: number;
  initial_moisture_pct: number;
  final_moisture_pct: number;
  efficiency_pct: number;
  status: string;
  created_at: string;
}

export interface DashboardDryingSummary {
  total_raw_purchased_kg: number;
  total_raw_purchased_bags: number;
  total_raw_remaining_kg: number;
  total_raw_remaining_bags: number;
  total_drying_batches: number;
  completed_drying_batches: number;
  pending_drying_batches: number;
  total_raw_input_kg: number;
  total_raw_input_bags: number;
  weighed_input_kg: number;
  total_dried_output_kg: number;
  total_dried_output_bags: number;
  pending_weight_input_kg: number;
  pending_weight_bags: number;
  total_volume_lost_kg: number;
  drying_efficiency_pct: number;
  loss_pct: number;
  avg_moisture_drop_pct: number;
  by_method: DashboardDryingMethodStat[];
  recent_drying: DashboardDryingRecentRow[];
}

export interface DashboardSummary {
  kpis: {
    total_paddy_stock_kg: number;
    total_rice_stock_kg: number;
    total_byproduct_stock_kg: number;
    inventory_valuation: number;
    monthly_purchases: number;
    monthly_sales: number;
    monthly_gross_profit: number;
    flagged_weight_discrepancies: number;
    cash_and_bank_balance: number;
  };
  warehouse_utilization: Array<{
    id: number;
    code: string;
    name: string;
    warehouse_type: string;
    capacity_kg: number;
    current_stock_kg: number;
    valuation: number;
  }>;
  production_summary: {
    siddho_batches: number;
    atap_batches: number;
    avg_head_rice_yield_pct: number;
    total_paddy_milled_kg: number;
  };
  drying_summary?: DashboardDryingSummary;
  recent_purchases: PaddyPurchase[];
  recent_batches: ProductionBatch[];
  recent_sales: SalesInvoice[];
}
