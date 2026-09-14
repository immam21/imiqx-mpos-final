-- OneCounter mPOS — COMPLETE schema (mirror / backup)
-- =====================================================================
-- Creates every table the application uses, in dependency order, so it can
-- be run on a fresh Postgres / Supabase project to stand up a full mirror.
--
-- Reconstructed from:
--   * supabase/auth-schema.sql        (app_users, user_store_access)
--   * supabase/schema-updates.sql     (expenses, cash_sessions, memberships,
--                                      promo_codes, purchase_orders, ...)
--   * backend-vercel/api/v1/[...route].js and api/cron/backup.js
--                                     (all base tables + exact columns used)
--
-- Notes for a standalone mirror:
--   * app_users.id is self-generated here (the production DB references
--     Supabase auth.users(id)). Swap the default for a FK if you run this
--     inside a Supabase project that owns the auth schema.
--   * Row Level Security is intentionally omitted so the mirror is a plain
--     structural copy. Add policies if the mirror is user-facing.
--   * Safe to run multiple times (create table if not exists / add column if
--     not exists / create index if not exists).
-- =====================================================================

create extension if not exists "pgcrypto";

-- Shared trigger to maintain updated_at columns.
create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
	new.updated_at = now();
	return new;
end;
$$;

-- =====================================================================
-- Identity & access
-- =====================================================================

create table if not exists app_users (
	id uuid primary key default gen_random_uuid(),
	email text not null unique,
	full_name text,
	role text not null default 'manager' check (role in ('cashier', 'manager', 'admin')),
	is_active boolean not null default true,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now()
);

drop trigger if exists trg_app_users_updated_at on app_users;
create trigger trg_app_users_updated_at
before update on app_users
for each row execute function set_updated_at();

create table if not exists user_store_access (
	id uuid primary key default gen_random_uuid(),
	user_id uuid not null references app_users(id) on delete cascade,
	business_id text not null,
	store_id text not null,
	created_at timestamptz not null default now(),
	unique (user_id, business_id, store_id)
);

-- =====================================================================
-- Tenancy: businesses and their stores
-- =====================================================================

create table if not exists businesses (
	id uuid primary key default gen_random_uuid(),
	code text not null unique,
	legal_name text not null,
	gstin text,
	pan text,
	invoice_prefix text,
	timezone text not null default 'Asia/Kolkata',
	is_active boolean not null default true,
	created_at timestamptz not null default now()
);

create table if not exists stores (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	code text not null,
	name text not null,
	store_type text not null default 'retail',
	address_line text,
	city text,
	state text,
	pincode text,
	is_active boolean not null default true,
	created_at timestamptz not null default now(),
	unique (business_id, code)
);
create index if not exists idx_stores_business on stores (business_id);

-- =====================================================================
-- Customers
-- =====================================================================

create table if not exists customers (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	customer_code text,
	name text not null,
	phone text,
	segment text,
	place text,
	full_address text,
	city text,
	pincode text,
	is_active boolean not null default true,
	created_at timestamptz not null default now(),
	unique (business_id, phone)
);
create index if not exists idx_customers_phone on customers (business_id, phone);

-- =====================================================================
-- Catalog, pricing and stock
-- =====================================================================

create table if not exists products (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	sku text not null,
	barcode text,
	name text not null,
	category text,
	unit text not null default 'pcs',
	hsn_code text,
	tax_percent numeric(5,2) not null default 0,
	is_active boolean not null default true,
	created_at timestamptz not null default now(),
	unique (business_id, sku)
);
create index if not exists idx_products_business_sku on products (business_id, sku);

create table if not exists product_prices (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	store_id uuid not null references stores(id) on delete cascade,
	product_id uuid not null references products(id) on delete cascade,
	mrp numeric(12,2) not null default 0,
	selling_price numeric(12,2) not null default 0,
	cost_price numeric(12,2) not null default 0,
	effective_from timestamptz not null default now(),
	created_at timestamptz not null default now()
);
create index if not exists idx_product_prices_product_store on product_prices (product_id, store_id, effective_from desc);

create table if not exists inventory_balances (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	store_id uuid not null references stores(id) on delete cascade,
	product_id uuid not null references products(id) on delete cascade,
	qty_on_hand numeric(12,2) not null default 0,
	reorder_level numeric(12,2) not null default 0,
	location text,
	created_at timestamptz not null default now(),
	unique (store_id, product_id)
);
create index if not exists idx_inventory_balances_store on inventory_balances (store_id);

create table if not exists inventory_ledger (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	store_id uuid not null references stores(id) on delete cascade,
	product_id uuid references products(id) on delete set null,
	direction text not null check (direction in ('in', 'out')),
	qty numeric(12,2) not null default 0,
	source text,
	reference_type text,
	reference_id text,
	created_at timestamptz not null default now()
);
create index if not exists idx_inventory_ledger_store_created on inventory_ledger (store_id, created_at desc);

-- =====================================================================
-- Orders and fulfillment
-- =====================================================================

create table if not exists orders (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	store_id uuid not null references stores(id) on delete cascade,
	order_no text not null,
	channel text not null default 'in_store',
	customer_id uuid references customers(id) on delete set null,
	customer_name text,
	delivery_address text,
	delivery_city text,
	delivery_pincode text,
	status text not null default 'created',
	subtotal numeric(12,2) not null default 0,
	tax_amount numeric(12,2) not null default 0,
	cgst_amount numeric(12,2) not null default 0,
	sgst_amount numeric(12,2) not null default 0,
	prices_include_gst boolean not null default false,
	discount_amount numeric(12,2) not null default 0,
	manual_discount_amount numeric(12,2) not null default 0,
	promo_code text,
	promo_discount_amount numeric(12,2) not null default 0,
	total_amount numeric(12,2) not null default 0,
	wallet_balance_after numeric(12,2) not null default 0,
	sold_by_user_id uuid references app_users(id) on delete set null,
	sold_by_name text,
	created_at timestamptz not null default now(),
	unique (business_id, order_no)
);
create index if not exists idx_orders_store_created on orders (store_id, created_at desc);
create index if not exists idx_orders_store_channel_created on orders (store_id, channel, created_at desc);
create index if not exists idx_orders_store_staff_date on orders (store_id, sold_by_user_id, created_at desc);
create index if not exists idx_orders_customer on orders (customer_id, created_at desc);

create table if not exists order_items (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	order_id uuid not null references orders(id) on delete cascade,
	product_id uuid references products(id) on delete set null,
	sku text,
	name text,
	quantity numeric(12,2) not null default 0,
	unit_price numeric(12,2) not null default 0,
	line_total numeric(12,2) not null default 0,
	tax_percent numeric(5,2) not null default 0,
	taxable_amount numeric(12,2) not null default 0,
	cgst_amount numeric(12,2) not null default 0,
	sgst_amount numeric(12,2) not null default 0,
	price_includes_gst boolean not null default false,
	created_at timestamptz not null default now()
);
create index if not exists idx_order_items_order on order_items (order_id);

create table if not exists order_payments (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	order_id uuid not null references orders(id) on delete cascade,
	mode text not null,
	amount numeric(12,2) not null default 0,
	created_at timestamptz not null default now()
);
create index if not exists idx_order_payments_order on order_payments (order_id);

create table if not exists order_void_logs (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	order_id uuid references orders(id) on delete set null,
	order_no text not null,
	reason text,
	created_at timestamptz not null default now()
);

create table if not exists order_reprint_logs (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	order_id uuid references orders(id) on delete set null,
	order_no text not null,
	created_at timestamptz not null default now()
);

create table if not exists label_print_jobs (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	store_id uuid not null references stores(id) on delete cascade,
	start_sku text,
	end_sku text,
	copies integer not null default 1,
	status text not null default 'queued',
	created_at timestamptz not null default now()
);

-- =====================================================================
-- Expenses, purchases and cash drawer
-- =====================================================================

create table if not exists expenses (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	store_id uuid not null references stores(id) on delete cascade,
	expense_date date not null default current_date,
	expense_at timestamptz not null default now(),
	category text not null,
	description text,
	amount numeric(12,2) not null check (amount > 0),
	payment_mode text,
	recorded_by_user_id uuid references app_users(id) on delete set null,
	recorded_by_name text,
	created_at timestamptz not null default now()
);
create index if not exists idx_expenses_store_date on expenses (store_id, expense_date desc);
create index if not exists idx_expenses_store_expense_at on expenses (store_id, expense_at desc);
create index if not exists idx_expenses_store_staff_date on expenses (store_id, recorded_by_user_id, expense_date desc);

create table if not exists purchase_orders (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	store_id uuid not null references stores(id) on delete cascade,
	po_date date not null default current_date,
	place text,
	bill_no text,
	shop_name text,
	ref_id text,
	total_amount numeric(12,2) not null check (total_amount >= 0),
	misc text,
	comments text,
	recorded_by_user_id uuid references app_users(id) on delete set null,
	recorded_by_name text,
	created_at timestamptz not null default now()
);
create index if not exists idx_purchase_orders_store_date on purchase_orders (store_id, po_date desc);

create table if not exists cash_sessions (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	store_id uuid not null references stores(id) on delete cascade,
	opening_amount numeric(12,2) not null check (opening_amount >= 0),
	closing_amount numeric(12,2),
	opened_at timestamptz not null default now(),
	closed_at timestamptz,
	opened_by_user_id uuid references app_users(id) on delete set null,
	opened_by_name text,
	closed_by_user_id uuid references app_users(id) on delete set null,
	closed_by_name text,
	status text not null default 'open' check (status in ('open', 'closed'))
);
create unique index if not exists idx_cash_sessions_one_open_per_store on cash_sessions (store_id) where status = 'open';
create index if not exists idx_cash_sessions_store_opened on cash_sessions (store_id, opened_at desc);

-- =====================================================================
-- Promotions
-- =====================================================================

create table if not exists promo_codes (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	code text not null,
	description text,
	discount_type text not null default 'percent' check (discount_type in ('percent', 'fixed')),
	discount_value numeric(12,2) not null check (discount_value >= 0),
	min_order_amount numeric(12,2) not null default 0,
	max_discount_amount numeric(12,2),
	usage_limit integer,
	used_count integer not null default 0,
	start_date date,
	end_date date,
	is_active boolean not null default true,
	created_at timestamptz not null default now()
);
create unique index if not exists idx_promo_codes_business_code on promo_codes (business_id, upper(code));
create index if not exists idx_promo_codes_business_active on promo_codes (business_id, is_active);

-- =====================================================================
-- Reconciliation
-- =====================================================================

create table if not exists payment_reconciliation (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	store_id uuid not null references stores(id) on delete cascade,
	recon_date date not null,
	gateway_amount numeric(12,2) not null default 0,
	pos_amount numeric(12,2) not null default 0,
	variance numeric(12,2) not null default 0,
	created_at timestamptz not null default now()
);
create index if not exists idx_payment_reconciliation_store_date on payment_reconciliation (store_id, recon_date desc);

-- =====================================================================
-- Integrations & messaging
-- =====================================================================

create table if not exists whatsapp_events (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	store_id uuid references stores(id) on delete set null,
	event_type text not null,
	reference_id text,
	phone text,
	template_name text,
	payload jsonb,
	status text not null default 'sent',
	created_at timestamptz not null default now()
);
create index if not exists idx_whatsapp_events_business_created on whatsapp_events (business_id, created_at desc);

create table if not exists integrations (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	provider text not null,
	is_enabled boolean not null default false,
	config jsonb,
	created_at timestamptz not null default now(),
	updated_at timestamptz not null default now(),
	unique (business_id, provider)
);

drop trigger if exists trg_integrations_updated_at on integrations;
create trigger trg_integrations_updated_at
before update on integrations
for each row execute function set_updated_at();

create table if not exists google_sheets_sync_runs (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	status text not null check (status in ('success', 'error')),
	sales_rows integer not null default 0,
	expense_rows integer not null default 0,
	customer_rows integer not null default 0,
	error_message text,
	completed_at timestamptz not null default now()
);
create index if not exists idx_google_sheets_sync_runs_business_completed on google_sheets_sync_runs (business_id, completed_at desc);

-- =====================================================================
-- Ennaval membership & wallet program
-- =====================================================================

create table if not exists membership_program_settings (
	business_id uuid primary key references businesses(id) on delete cascade,
	minimum_eligible_purchase numeric(12,2) not null default 699,
	regular_first_purchase_reward_percent numeric(5,2) not null default 10,
	regular_repeat_purchase_reward_percent numeric(5,2) not null default 5,
	exclusive_purchase_reward_percent numeric(5,2) not null default 10,
	referral_reward_percent numeric(5,2) not null default 5,
	referred_first_purchase_reward_percent numeric(5,2) not null default 10,
	regular_wallet_redemption_percent numeric(5,2) not null default 20,
	regular_wallet_redemption_max numeric(12,2) not null default 100,
	exclusive_wallet_redemption_max numeric(12,2) not null default 150,
	exclusive_membership_fee numeric(12,2) not null default 199,
	exclusive_joining_credit numeric(12,2) not null default 250,
	regular_wallet_expiry_months integer not null default 6,
	exclusive_wallet_expiry_months integer not null default 12,
	referral_gift_threshold integer not null default 10,
	updated_at timestamptz not null default now()
);

create table if not exists membership_members (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	customer_id uuid references customers(id) on delete set null,
	phone text not null,
	name text,
	tier text not null default 'regular' check (tier in ('regular', 'exclusive')),
	referral_code text not null,
	referred_by_member_id uuid references membership_members(id) on delete set null,
	wallet_balance numeric(12,2) not null default 0 check (wallet_balance >= 0),
	wallet_expires_at timestamptz,
	eligible_purchase_count integer not null default 0,
	successful_referral_count integer not null default 0,
	referral_gift_pending boolean not null default false,
	joined_at timestamptz not null default now(),
	last_purchase_at timestamptz,
	unique (business_id, phone),
	unique (business_id, referral_code)
);
create index if not exists idx_membership_members_business_phone on membership_members (business_id, phone);

create table if not exists membership_wallet_transactions (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	member_id uuid not null references membership_members(id) on delete cascade,
	order_id uuid references orders(id) on delete set null,
	transaction_type text not null check (transaction_type in ('exclusive_joining_credit', 'purchase_reward', 'referral_reward', 'wallet_redemption', 'expiry_adjustment')),
	amount numeric(12,2) not null,
	balance_after numeric(12,2) not null,
	created_at timestamptz not null default now()
);
create index if not exists idx_membership_wallet_transactions_member on membership_wallet_transactions (member_id, created_at desc);

create table if not exists membership_referrals (
	id uuid primary key default gen_random_uuid(),
	business_id uuid not null references businesses(id) on delete cascade,
	referrer_member_id uuid not null references membership_members(id) on delete cascade,
	referred_member_id uuid not null unique references membership_members(id) on delete cascade,
	successful_order_id uuid references orders(id) on delete set null,
	status text not null default 'pending' check (status in ('pending', 'successful')),
	completed_at timestamptz,
	created_at timestamptz not null default now()
);
create index if not exists idx_membership_referrals_referrer on membership_referrals (referrer_member_id, status);
