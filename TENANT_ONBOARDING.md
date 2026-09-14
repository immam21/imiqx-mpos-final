# Tenant Onboarding (Multi-Business)

OneCounter is multi-tenant by **`business_id`**. One backend + one Supabase database can
serve many businesses; every `/v1/*` query is scoped to the caller's business.

## How business context is resolved

1. The frontend sends an **`X-Business-Id`** header (and **`X-Store-Id`**) with every request.
   - Values come from `window.__ONECOUNTER_BUSINESS_ID__` / `window.__ONECOUNTER_STORE_ID__`
     (see [config.local.example.js](config.local.example.js)).
   - Fallbacks: env `ONECOUNTER_BUSINESS_ID` / `ONECOUNTER_STORE_ID`, then `business-main` / `store-main`.
2. The backend maps the business **code** → its UUID via the `businesses` table
   (`resolveBusinessId` in [api/v1/[...route].js](backend-vercel/api/v1/[...route].js)).
3. All reads/writes are filtered with `business_id=eq.<uuid>` (and store where relevant).

> **Terminology:** the `X-Business-Id` header carries the business **code** (e.g. `business-main`),
> not the UUID. The backend resolves the code to the UUID.

## Onboarding a new tenant

### 1. Create the business + stores (Supabase SQL)

Follow the pattern in [supabase/seed-reference.sql](supabase/seed-reference.sql):

```sql
insert into businesses (code, legal_name, gstin, pan, invoice_prefix, timezone, is_active)
values ('acme-retail', 'Acme Retail Pvt Ltd', '22AAAAA0000A1Z5', 'AAAAA0000A', 'ACME/', 'Asia/Kolkata', true)
on conflict (code) do nothing;

insert into stores (business_id, code, name, store_type, city, state, is_active)
select b.id, s.code, s.name, s.store_type, s.city, s.state, true
from businesses b
cross join (values
  ('acme-main',   'Acme Main Store',     'retail', 'Chennai', 'Tamil Nadu'),
  ('acme-online', 'Acme Online',         'online', 'Chennai', 'Tamil Nadu')
) as s(code, name, store_type, city, state)
where b.code = 'acme-retail'
on conflict do nothing;
```

Transactional tables (orders, inventory, customers, …) start empty — dashboards read live values.

### 2. Create users for the tenant

Users are linked to a business through `app_users.business_id`
(see [supabase/auth-schema.sql](supabase/auth-schema.sql); `role` ∈ `cashier | manager | admin`).

- **Supabase auth:** create the auth user, then ensure their `app_users` row has
  `business_id = 'acme-retail'` and the right `role`.
- **Local dev (no Supabase):** add the user to
  [backend-vercel/data/users.db.json](backend-vercel/data/users.db.json) with `business_id`.

### 3. Point the tenant's frontend at their business

Copy `config.local.example.js` → `config.local.js` for that deployment and set:

```js
window.__ONECOUNTER_API_BASE_URL__  = "https://api.yourdomain.com";
window.__ONECOUNTER_BUSINESS_ID__   = "acme-retail";   // business code
window.__ONECOUNTER_STORE_ID__      = "acme-main";     // default store code
window.__ONECOUNTER_SUPABASE_URL__  = "https://YOUR-PROJECT.supabase.co";
window.__ONECOUNTER_SUPABASE_ANON_KEY__ = "YOUR_SUPABASE_ANON_KEY";
```

Each tenant typically gets its own hosted build/URL (or a deployment that sets these values),
so their app always sends their `X-Business-Id`.

### 4. (Optional) Seed reference/config rows

- `membership_program_settings` (wallet/referral config) — created on first save, or seed a row.
- `integrations` rows (WhatsApp / Google Sheets) if the tenant uses them.

## ⚠️ Security note (must fix before production multi-tenant)

Business selection currently comes **only** from the client-supplied `X-Business-Id` header and is
**not** tied to the authenticated user. Nothing verifies the logged-in user belongs to that business,
so a client could read another tenant's data by changing the header.

Before serving untrusted tenants, derive `business_id` from the authenticated user's record/JWT
(or validate the header against it), and enable Supabase **row-level security** scoped by `business_id`.

## Google Sheets backup and multi-tenancy

The Google Sheets sync ([backend-vercel/api/cron/backup.js](backend-vercel/api/cron/backup.js)) is
currently **global**, not per-tenant:

- It exports **all** businesses' rows (no `business_id` filter).
- It writes to a **single** spreadsheet (`GOOGLE_SHEETS_SPREADSHEET_ID`, one env var).

The spreadsheet must be shared with the service-account email (Editor). Missing worksheet tabs are
auto-created on sync. Expected tabs: `Sales`, `Sales Items`, `Expenses`, `Customers`, `Products`,
`Order Payments`, `Cash Sessions`, `Promo Codes`, `Memberships`, `Wallet Transactions`, `Referrals`,
`Membership Settings`.

**To make Sheets export per-tenant:**

1. Store each business's own spreadsheet ID in the `integrations` table `config` (keyed by `business_id`).
2. Pass `business_id` into `runBackup(businessId)` and add `&business_id=eq.<id>` to every select.
3. Run per business (loop over enabled businesses, or use the caller's `ctx.businessId`) and write to
   that business's spreadsheet.

## Quick checklist per tenant

- [ ] `businesses` row created (unique `code`)
- [ ] `stores` rows created for the business
- [ ] Users created and mapped to `business_id` (correct `role`)
- [ ] Tenant frontend `config.local.js` set to the business/store codes
- [ ] (Optional) membership settings + integrations configured
- [ ] Verified the tenant sees only their own data
