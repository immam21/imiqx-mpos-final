const { findUserByEmail, verifyPassword } = require("../../lib/auth-db");
const { sbSelect, sbInsert, sbUpdate, sbDelete } = require("../../lib/supabase-rest");
const { runBackup } = require("../cron/backup");

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Store-Id, X-Business-Id");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(res, status, data) {
  setCors(res);
  res.status(status).json(data);
}

async function parseBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function nowIso() {
  return new Date().toISOString();
}

function startOfTodayIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfDaysAgoIso(daysAgo) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString();
}

function startOfWeekIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString();
}

function startOfMonthIso() {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function getRouteSegments(req) {
  const rawRoute = req.query && req.query.route;
  if (Array.isArray(rawRoute)) {
    return rawRoute.filter(Boolean);
  }
  if (typeof rawRoute === "string" && rawRoute.trim()) {
    return rawRoute.split("/").filter(Boolean);
  }
  return [];
}

function titleCaseStatus(value) {
  const v = String(value || "");
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : v;
}

function channelLabel(value) {
  return value === "in_store" ? "In-Store" : value === "online" ? "Online" : value || "";
}

const DEFAULT_MEMBERSHIP_SETTINGS = {
  minimum_eligible_purchase: 0,
  regular_first_purchase_reward_percent: 10,
  regular_repeat_purchase_reward_percent: 5,
  referral_reward_percent: 5,
  regular_wallet_redemption_percent: 10,
  regular_wallet_expiry_months: 6,
};

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function membershipSettingsPayload(row) {
  return { ...DEFAULT_MEMBERSHIP_SETTINGS, ...(row || {}) };
}

async function getMembershipSettings(businessId) {
  const rows = await sbSelect("membership_program_settings", `select=*&business_id=eq.${encode(businessId)}&limit=1`).catch(() => []);
  return membershipSettingsPayload(rows[0]);
}

function walletExpiry(settings) {
  const expiry = new Date();
  expiry.setMonth(expiry.getMonth() + Number(settings.regular_wallet_expiry_months));
  return expiry.toISOString();
}

// Memorable code: last 4 phone digits + 2 random letters (no I/O to avoid confusion).
function referralCodeCandidate(phone) {
  const digits = String(phone || "").replace(/\D/g, "").slice(-4).padStart(4, "0");
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const rand = () => letters[Math.floor(Math.random() * letters.length)];
  return `${digits}${rand()}${rand()}`;
}

async function makeUniqueReferralCode(businessId, phone) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const code = referralCodeCandidate(phone);
    const clash = await sbSelect(
      "membership_members",
      `select=id&business_id=eq.${encode(businessId)}&referral_code=eq.${encode(code)}&limit=1`
    ).catch(() => []);
    if (!clash.length) return code;
  }
  const digits = String(phone || "").replace(/\D/g, "").slice(-4).padStart(4, "0");
  return `${digits}${Date.now().toString(36).slice(-2).toUpperCase()}`;
}

async function applyWalletTransaction({ businessId, member, orderId, type, amount, settings }) {
  const nextBalance = roundMoney(Number(member.wallet_balance || 0) + Number(amount || 0));
  const updated = await sbUpdate("membership_members", `id=eq.${member.id}`, {
    wallet_balance: nextBalance,
    wallet_expires_at: nextBalance > 0 ? walletExpiry(settings) : null,
    last_purchase_at: new Date().toISOString()
  });
  await sbInsert("membership_wallet_transactions", [{
    business_id: businessId,
    member_id: member.id,
    order_id: orderId || null,
    transaction_type: type,
    amount: roundMoney(amount),
    balance_after: nextBalance
  }]);
  return updated[0] || { ...member, wallet_balance: nextBalance };
}

function getStoreCode(req) {
  return req.headers["x-store-id"] || process.env.ONECOUNTER_STORE_ID || "store-main";
}

function getBusinessCode(req) {
  return req.headers["x-business-id"] || process.env.ONECOUNTER_BUSINESS_ID || "business-main";
}

// -------------------------------------------------------------------------
// Code -> UUID resolution (cached; the DB keys everything by UUID)
// -------------------------------------------------------------------------
const businessCache = new Map();
const storeCache = new Map();

async function resolveBusinessId(code) {
  if (businessCache.has(code)) {
    return businessCache.get(code);
  }
  const rows = await sbSelect("businesses", `select=id&code=eq.${encode(code)}&limit=1`);
  if (!rows.length) {
    throw new Error(`business_not_found:${code}`);
  }
  businessCache.set(code, rows[0].id);
  return rows[0].id;
}

async function resolveStoreId(code, businessId) {
  const key = `${businessId}:${code}`;
  if (storeCache.has(key)) {
    return storeCache.get(key);
  }
  const rows = await sbSelect("stores", `select=id&code=eq.${encode(code)}&business_id=eq.${encode(businessId)}&limit=1`);
  if (!rows.length) {
    throw new Error(`store_not_found:${code}`);
  }
  storeCache.set(key, rows[0].id);
  return rows[0].id;
}

async function resolveContext(req) {
  // Prefer the authenticated user's own business so tenants can't read another
  // tenant's data by changing the X-Business-Id header. Falls back to header/env
  // for local dev, public tooling, and users with no business link yet.
  const tenant = await resolveUserTenant(req).catch(() => null);
  if (tenant && tenant.businessId) {
    await assertBusinessActive(tenant.businessId);
    let storeId = null;
    const storeCode = getStoreCode(req);
    try {
      // Honor a store override only if that store belongs to the user's business.
      storeId = await resolveStoreId(storeCode, tenant.businessId);
    } catch (_) {
      storeId = tenant.defaultStoreId || null;
    }
    if (!storeId) storeId = tenant.defaultStoreId || null;
    if (!storeId) {
      const firstStore = (await sbSelect("stores", `select=id&business_id=eq.${encode(tenant.businessId)}&order=created_at.asc&limit=1`).catch(() => []))[0];
      storeId = firstStore ? firstStore.id : null;
    }
    return { businessCode: getBusinessCode(req), storeCode, businessId: tenant.businessId, storeId };
  }
  const businessCode = getBusinessCode(req);
  const storeCode = getStoreCode(req);
  const businessId = await resolveBusinessId(businessCode);
  await assertBusinessActive(businessId);
  const storeId = await resolveStoreId(storeCode, businessId);
  return { businessCode, storeCode, businessId, storeId };
}

// Deactivated tenants cannot use the app; block their API access with a clear error.
const businessActiveCache = new Map();
async function assertBusinessActive(businessId) {
  if (!businessId) return;
  if (!businessActiveCache.has(businessId)) {
    const rows = await sbSelect("businesses", `select=is_active&id=eq.${encode(businessId)}&limit=1`).catch(() => []);
    businessActiveCache.set(businessId, rows.length ? rows[0].is_active !== false : true);
  }
  if (businessActiveCache.get(businessId) === false) {
    throw new Error("business_inactive");
  }
}

// Resolve the logged-in user's business/default store from their app_users row.
async function resolveUserTenant(req) {
  const actor = await resolveActor(req);
  if (!actor || !actor.id) return null;
  const rows = await sbSelect(
    "app_users",
    `select=business_id,default_store_id&id=eq.${encode(actor.id)}&limit=1`
  ).catch(() => []);
  const link = rows[0];
  if (!link || !link.business_id) return null;
  return { businessId: link.business_id, defaultStoreId: link.default_store_id || null };
}

// -------------------------------------------------------------------------
// Auth (Supabase or local mock fallback)
// -------------------------------------------------------------------------
function getAuthMode() {
  const pub = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (process.env.AUTH_MODE) {
    return process.env.AUTH_MODE;
  }
  return process.env.SUPABASE_URL && pub ? "supabase" : "local_db";
}

const mockAuthSessions = {};
const mockAccessSessions = {};

function issueMockToken(user) {
  const refreshToken = `mock-refresh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = {
    access_token: `mock-access-${Date.now()}`,
    token_type: "bearer",
    expires_in: 900,
    refresh_token: refreshToken,
    user: { id: user.id || "user-mock-1", email: user.email || "", role: user.role || "manager" }
  };
  mockAuthSessions[refreshToken] = { id: payload.user.id, email: payload.user.email, role: payload.user.role, issued_at: nowIso() };
  mockAccessSessions[payload.access_token] = payload.user;
  return payload;
}

async function resolveActor(req) {
  if (req.__actorResolved) return req.__actor;
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  let actor = null;
  if (token) {
    if (getAuthMode() === "local_db") {
      actor = mockAccessSessions[token] || null;
    } else {
      const supabaseUrl = process.env.SUPABASE_URL;
      const pub = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
      if (supabaseUrl && pub) {
        const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
          headers: { apikey: pub, Authorization: `Bearer ${token}` }
        }).catch(() => null);
        if (response && response.ok) {
          const user = await response.json();
          actor = {
            id: user.id,
            email: user.email || "",
            name: (user.user_metadata && user.user_metadata.full_name) || user.email || ""
          };
        }
      }
    }
  }
  req.__actorResolved = true;
  req.__actor = actor;
  return actor;
}

async function supabasePasswordLogin(email, password) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const pub = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: pub },
    body: JSON.stringify({ email, password })
  });
  if (!res.ok) {
    throw new Error("supabase_login_failed");
  }
  return res.json();
}

async function supabaseRefresh(refreshToken) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const pub = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  const res = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: pub },
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  if (!res.ok) {
    throw new Error("supabase_refresh_failed");
  }
  return res.json();
}

async function supabaseLogout(accessToken) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const pub = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  await fetch(`${supabaseUrl}/auth/v1/logout`, {
    method: "POST",
    headers: { apikey: pub, Authorization: `Bearer ${accessToken}` }
  });
}

// -------------------------------------------------------------------------
// User admin via Supabase Admin API (service role). Hardcoded gate code.
// -------------------------------------------------------------------------
const ADMIN_CODE = process.env.ADMIN_USER_CODE || "1521";

// Super-admin gate for /v1/admin/* onboarding. Code may arrive in the body (POST)
// or as an ?admin_code= query param (GET).
function adminCodeFrom(req, body) {
  const url = new URL(req.url, "http://localhost");
  return String((body && body.admin_code) || url.searchParams.get("admin_code") || "");
}
function isSuperAdmin(req, body) {
  return adminCodeFrom(req, body) === ADMIN_CODE;
}
function slugCode(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
}

function adminHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

async function adminListUsers() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users?per_page=200`, { headers: adminHeaders() });
  if (!res.ok) {
    return [];
  }
  const data = await res.json();
  return Array.isArray(data.users) ? data.users : Array.isArray(data) ? data : [];
}

async function adminCreateUser(email, password, role) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: role ? { role } : {}
    })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { error: true, message: data.msg || data.error_description || data.error || "create_failed" };
  }
  return { error: false };
}

async function adminDeleteUser(userId) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encode(userId)}`, {
    method: "DELETE",
    headers: adminHeaders()
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { error: true, message: data.msg || data.error || "delete_failed" };
  }
  return { error: false };
}

// Update a Supabase auth user (password reset and/or role metadata).
async function adminUpdateUser(userId, patch) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const body = {};
  if (patch.password) body.password = patch.password;
  if (patch.role) body.user_metadata = { role: patch.role };
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encode(userId)}`, {
    method: "PUT",
    headers: adminHeaders(),
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { error: true, message: data.msg || data.error_description || data.error || "update_failed" };
  }
  return { error: false };
}

// -------------------------------------------------------------------------
// Promo codes
// -------------------------------------------------------------------------
// Validate a promo code for a business against a base order amount.
// Returns { valid, discount, promo, reason }.
async function validatePromoCode(businessId, code, baseAmount) {
  const normalized = String(code || "").trim().toUpperCase();
  if (!normalized) {
    return { valid: false, discount: 0, promo: null, reason: "code_required" };
  }
  const rows = await sbSelect(
    "promo_codes",
    `select=*&business_id=eq.${encode(businessId)}&code=eq.${encode(normalized)}&limit=1`
  ).catch(() => []);
  const promo = rows[0];
  if (!promo || promo.is_active === false) {
    return { valid: false, discount: 0, promo: null, reason: "invalid_code" };
  }
  const today = nowIso().slice(0, 10);
  if (promo.start_date && today < promo.start_date) {
    return { valid: false, discount: 0, promo, reason: "not_started" };
  }
  if (promo.end_date && today > promo.end_date) {
    return { valid: false, discount: 0, promo, reason: "expired" };
  }
  if (promo.usage_limit != null && Number(promo.used_count || 0) >= Number(promo.usage_limit)) {
    return { valid: false, discount: 0, promo, reason: "usage_limit_reached" };
  }
  const base = roundMoney(Number(baseAmount || 0));
  if (base < Number(promo.min_order_amount || 0)) {
    return { valid: false, discount: 0, promo, reason: "min_order_not_met" };
  }
  let discount = promo.discount_type === "fixed"
    ? Number(promo.discount_value || 0)
    : base * Number(promo.discount_value || 0) / 100;
  if (promo.max_discount_amount != null && promo.max_discount_amount > 0) {
    discount = Math.min(discount, Number(promo.max_discount_amount));
  }
  discount = roundMoney(Math.max(0, Math.min(discount, base)));
  return { valid: true, discount, promo, reason: "ok" };
}

// -------------------------------------------------------------------------
// Handler
// -------------------------------------------------------------------------
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.status(204).end();
    return;
  }

  const route = getRouteSegments(req).join("/");
  const pathname = `/v1/${route}`;

  try {
    // ------------------------- Auth -------------------------
    if (pathname === "/v1/auth/login" && req.method === "POST") {
      const body = await parseBody(req);
      if (getAuthMode() === "supabase") {
        sendJson(res, 200, await supabasePasswordLogin(body.email, body.password));
        return;
      }
      const user = findUserByEmail(body.email);
      if (!user || !verifyPassword(user, body.password)) {
        sendJson(res, 401, { error: "invalid_credentials" });
        return;
      }
      sendJson(res, 200, issueMockToken(user));
      return;
    }

    if (pathname === "/v1/auth/refresh" && req.method === "POST") {
      const body = await parseBody(req);
      if (getAuthMode() === "supabase") {
        sendJson(res, 200, await supabaseRefresh(body.refresh_token));
        return;
      }
      const session = mockAuthSessions[body.refresh_token];
      if (!session) {
        sendJson(res, 401, { error: "invalid_refresh_token" });
        return;
      }
      delete mockAuthSessions[body.refresh_token];
      sendJson(res, 200, issueMockToken(session));
      return;
    }

    if (pathname === "/v1/auth/logout" && req.method === "POST") {
      const body = await parseBody(req);
      if (getAuthMode() === "supabase") {
        const authHeader = req.headers.authorization || "";
        const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
        if (token) {
          await supabaseLogout(token);
        }
      } else if (body.refresh_token) {
        delete mockAuthSessions[body.refresh_token];
      }
      setCors(res);
      res.status(204).end();
      return;
    }

    // Public: stores available to a user (by email) for the login store picker.
    if (pathname === "/v1/auth/stores" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const email = String(url.searchParams.get("email") || "").trim().toLowerCase();
      if (!email) { sendJson(res, 200, { items: [] }); return; }
      const user = (await sbSelect("app_users", `select=business_id,default_store_id&email=eq.${encode(email)}&limit=1`).catch(() => []))[0];
      if (!user || !user.business_id) { sendJson(res, 200, { items: [] }); return; }
      const stores = await sbSelect(
        "stores",
        `select=code,name,is_active&business_id=eq.${encode(user.business_id)}&order=created_at.asc`
      ).catch(() => []);
      const defaultStore = user.default_store_id
        ? (await sbSelect("stores", `select=code&id=eq.${encode(user.default_store_id)}&limit=1`).catch(() => []))[0]
        : null;
      sendJson(res, 200, {
        items: stores.filter((s) => s.is_active !== false).map((s) => ({ code: s.code, name: s.name })),
        default_store_code: defaultStore ? defaultStore.code : ""
      });
      return;
    }

    // ------------------------- User admin (add/remove) -------------------------
    // Gated by a hardcoded admin code. Uses the Supabase Admin API (service role).
    if (pathname === "/v1/admin/users" && req.method === "GET") {
      const users = await adminListUsers();
      // Merge tenant link (business) from app_users so the console can show it.
      const links = await sbSelect("app_users", "select=id,email,role,business_id,default_store_id").catch(() => []);
      const businesses = await sbSelect("businesses", "select=id,code,legal_name").catch(() => []);
      const bizById = {};
      businesses.forEach((b) => { bizById[b.id] = b; });
      const linkByEmail = {};
      links.forEach((l) => { linkByEmail[String(l.email || "").toLowerCase()] = l; });
      sendJson(res, 200, {
        users: users.map((u) => {
          const link = linkByEmail[String(u.email || "").toLowerCase()] || {};
          const biz = link.business_id ? bizById[link.business_id] : null;
          return {
            id: u.id,
            email: u.email,
            role: link.role || (u.user_metadata && u.user_metadata.role) || "",
            business_id: link.business_id || "",
            business_code: biz ? biz.code : "",
            business_name: biz ? biz.legal_name : ""
          };
        })
      });
      return;
    }

    if (pathname === "/v1/admin/users" && req.method === "POST") {
      const body = await parseBody(req);
      if (String(body.admin_code || "") !== ADMIN_CODE) {
        sendJson(res, 403, { error: "invalid_admin_code", message: "Invalid admin code." });
        return;
      }
      if (!body.email || !body.password) {
        sendJson(res, 400, { error: "email and password required" });
        return;
      }
      const role = ["cashier", "manager", "admin"].includes(String(body.role)) ? String(body.role) : "manager";
      const result = await adminCreateUser(body.email, body.password, role);
      if (result.error) {
        sendJson(res, 400, { error: "create_failed", message: result.message });
        return;
      }
      // Link the new user to their tenant (business + optional default store + role).
      const patch = { role };
      if (body.business_id) patch.business_id = String(body.business_id);
      if (body.default_store_id) patch.default_store_id = String(body.default_store_id);
      if (body.full_name) patch.full_name = String(body.full_name);
      await sbUpdate("app_users", `email=eq.${encode(String(body.email).toLowerCase())}`, patch).catch(() => {});
      sendJson(res, 201, { status: "created", email: body.email });
      return;
    }

    if (pathname === "/v1/admin/users/delete" && req.method === "POST") {
      const body = await parseBody(req);
      if (String(body.admin_code || "") !== ADMIN_CODE) {
        sendJson(res, 403, { error: "invalid_admin_code", message: "Invalid admin code." });
        return;
      }
      if (!body.user_id) {
        sendJson(res, 400, { error: "user_id required" });
        return;
      }
      const result = await adminDeleteUser(body.user_id);
      if (result.error) {
        sendJson(res, 400, { error: "delete_failed", message: result.message });
        return;
      }
      sendJson(res, 200, { status: "deleted" });
      return;
    }

    // ------------------------- Admin: tenants (businesses) -------------------------
    if (pathname === "/v1/admin/businesses" && req.method === "GET") {
      if (!isSuperAdmin(req)) {
        sendJson(res, 403, { error: "invalid_admin_code" });
        return;
      }
      const rows = await sbSelect(
        "businesses",
        "select=id,code,legal_name,gstin,pan,invoice_prefix,timezone,is_active,created_at&order=created_at.desc"
      ).catch(() => []);
      const stores = await sbSelect("stores", "select=business_id").catch(() => []);
      const counts = {};
      stores.forEach((s) => { counts[s.business_id] = (counts[s.business_id] || 0) + 1; });
      sendJson(res, 200, { items: rows.map((b) => ({ ...b, store_count: counts[b.id] || 0 })) });
      return;
    }

    if (pathname === "/v1/admin/businesses" && req.method === "POST") {
      const body = await parseBody(req);
      if (!isSuperAdmin(req, body)) {
        sendJson(res, 403, { error: "invalid_admin_code", message: "Invalid admin code." });
        return;
      }
      const legalName = String(body.legal_name || "").trim();
      const code = slugCode(body.code || legalName);
      if (!legalName || !code) {
        sendJson(res, 400, { error: "legal_name and code required" });
        return;
      }
      const existing = await sbSelect("businesses", `select=id&code=eq.${encode(code)}&limit=1`).catch(() => []);
      if (existing.length) {
        sendJson(res, 409, { error: "code_exists", message: "A business with this code already exists." });
        return;
      }
      const inserted = await sbInsert("businesses", [{
        code,
        legal_name: legalName,
        gstin: String(body.gstin || "").trim() || null,
        pan: String(body.pan || "").trim() || null,
        invoice_prefix: String(body.invoice_prefix || "").trim() || null,
        timezone: String(body.timezone || "").trim() || "Asia/Kolkata",
        is_active: true
      }]);
      sendJson(res, 201, { status: "created", business: inserted[0] || null });
      return;
    }

    // ------------------------- Admin: stores -------------------------
    if (pathname === "/v1/admin/stores" && req.method === "GET") {
      if (!isSuperAdmin(req)) {
        sendJson(res, 403, { error: "invalid_admin_code" });
        return;
      }
      const url = new URL(req.url, "http://localhost");
      const businessId = String(url.searchParams.get("business_id") || "").trim();
      if (!businessId) {
        sendJson(res, 400, { error: "business_id required" });
        return;
      }
      const rows = await sbSelect(
        "stores",
        `select=id,code,name,store_type,city,state,is_active,created_at&business_id=eq.${encode(businessId)}&order=created_at.desc`
      ).catch(() => []);
      sendJson(res, 200, { items: rows });
      return;
    }

    if (pathname === "/v1/admin/stores" && req.method === "POST") {
      const body = await parseBody(req);
      if (!isSuperAdmin(req, body)) {
        sendJson(res, 403, { error: "invalid_admin_code", message: "Invalid admin code." });
        return;
      }
      const businessId = String(body.business_id || "").trim();
      const name = String(body.name || "").trim();
      const code = slugCode(body.code || name);
      if (!businessId || !name || !code) {
        sendJson(res, 400, { error: "business_id, name and code required" });
        return;
      }
      const existing = await sbSelect("stores", `select=id&business_id=eq.${encode(businessId)}&code=eq.${encode(code)}&limit=1`).catch(() => []);
      if (existing.length) {
        sendJson(res, 409, { error: "code_exists", message: "A store with this code already exists for the business." });
        return;
      }
      const inserted = await sbInsert("stores", [{
        business_id: businessId,
        code,
        name,
        store_type: String(body.store_type || "retail").trim() || "retail",
        city: String(body.city || "").trim() || null,
        state: String(body.state || "").trim() || null,
        is_active: true
      }]);
      sendJson(res, 201, { status: "created", store: inserted[0] || null });
      return;
    }

    if (pathname === "/v1/admin/businesses/update" && req.method === "POST") {
      const body = await parseBody(req);
      if (!isSuperAdmin(req, body)) { sendJson(res, 403, { error: "invalid_admin_code" }); return; }
      const id = String(body.id || "").trim();
      if (!id) { sendJson(res, 400, { error: "id required" }); return; }
      const patch = {};
      if (body.legal_name !== undefined) patch.legal_name = String(body.legal_name || "").trim();
      if (body.gstin !== undefined) patch.gstin = String(body.gstin || "").trim() || null;
      if (body.pan !== undefined) patch.pan = String(body.pan || "").trim() || null;
      if (body.invoice_prefix !== undefined) patch.invoice_prefix = String(body.invoice_prefix || "").trim() || null;
      if (body.timezone !== undefined) patch.timezone = String(body.timezone || "").trim() || "Asia/Kolkata";
      if (body.is_active !== undefined) patch.is_active = Boolean(body.is_active);
      await sbUpdate("businesses", `id=eq.${encode(id)}`, patch);
      businessCache.clear();
      businessActiveCache.clear();
      sendJson(res, 200, { status: "updated", id });
      return;
    }

    if (pathname === "/v1/admin/businesses/delete" && req.method === "POST") {
      const body = await parseBody(req);
      if (!isSuperAdmin(req, body)) { sendJson(res, 403, { error: "invalid_admin_code" }); return; }
      const id = String(body.id || "").trim();
      if (!id) { sendJson(res, 400, { error: "id required" }); return; }
      await sbDelete("businesses", `id=eq.${encode(id)}`);
      businessCache.clear();
      storeCache.clear();
      businessActiveCache.clear();
      sendJson(res, 200, { status: "deleted", id });
      return;
    }

    if (pathname === "/v1/admin/stores/update" && req.method === "POST") {
      const body = await parseBody(req);
      if (!isSuperAdmin(req, body)) { sendJson(res, 403, { error: "invalid_admin_code" }); return; }
      const id = String(body.id || "").trim();
      if (!id) { sendJson(res, 400, { error: "id required" }); return; }
      const patch = {};
      if (body.name !== undefined) patch.name = String(body.name || "").trim();
      if (body.store_type !== undefined) patch.store_type = String(body.store_type || "retail").trim() || "retail";
      if (body.city !== undefined) patch.city = String(body.city || "").trim() || null;
      if (body.state !== undefined) patch.state = String(body.state || "").trim() || null;
      if (body.is_active !== undefined) patch.is_active = Boolean(body.is_active);
      await sbUpdate("stores", `id=eq.${encode(id)}`, patch);
      storeCache.clear();
      sendJson(res, 200, { status: "updated", id });
      return;
    }

    if (pathname === "/v1/admin/stores/delete" && req.method === "POST") {
      const body = await parseBody(req);
      if (!isSuperAdmin(req, body)) { sendJson(res, 403, { error: "invalid_admin_code" }); return; }
      const id = String(body.id || "").trim();
      if (!id) { sendJson(res, 400, { error: "id required" }); return; }
      await sbDelete("stores", `id=eq.${encode(id)}`);
      storeCache.clear();
      sendJson(res, 200, { status: "deleted", id });
      return;
    }

    if (pathname === "/v1/admin/users/update" && req.method === "POST") {
      const body = await parseBody(req);
      if (!isSuperAdmin(req, body)) { sendJson(res, 403, { error: "invalid_admin_code" }); return; }
      const userId = String(body.user_id || "").trim();
      if (!userId) { sendJson(res, 400, { error: "user_id required" }); return; }
      const role = ["cashier", "manager", "admin"].includes(String(body.role)) ? String(body.role) : null;
      if (role) {
        const upd = await adminUpdateUser(userId, { role });
        if (upd.error) { sendJson(res, 400, { error: "update_failed", message: upd.message }); return; }
      }
      const patch = {};
      if (role) patch.role = role;
      if (body.business_id !== undefined) patch.business_id = String(body.business_id || "") || null;
      if (body.default_store_id !== undefined) patch.default_store_id = String(body.default_store_id || "") || null;
      if (Object.keys(patch).length) {
        await sbUpdate("app_users", `id=eq.${encode(userId)}`, patch).catch(() => {});
      }
      sendJson(res, 200, { status: "updated", user_id: userId });
      return;
    }

    if (pathname === "/v1/admin/users/reset-password" && req.method === "POST") {
      const body = await parseBody(req);
      if (!isSuperAdmin(req, body)) { sendJson(res, 403, { error: "invalid_admin_code" }); return; }
      const userId = String(body.user_id || "").trim();
      const password = String(body.password || "");
      if (!userId || password.length < 6) { sendJson(res, 400, { error: "user_id and password (min 6 chars) required" }); return; }
      const upd = await adminUpdateUser(userId, { password });
      if (upd.error) { sendJson(res, 400, { error: "reset_failed", message: upd.message }); return; }
      sendJson(res, 200, { status: "password_reset", user_id: userId });
      return;
    }

    // Super-admin: trigger the full platform (all-tenant) Google Sheets backup on demand.
    if (pathname === "/v1/admin/backup" && req.method === "POST") {
      const body = await parseBody(req);
      if (!isSuperAdmin(req, body)) { sendJson(res, 403, { error: "invalid_admin_code" }); return; }
      const result = await runBackup();
      sendJson(res, 200, result);
      return;
    }

    // Public e-bill: view a receipt by order number (no auth, no store headers).
    if (pathname === "/v1/receipt" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const id = (url.searchParams.get("id") || "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id required" });
        return;
      }
      const order = (await sbSelect(
        "orders",
        `select=id,order_no,channel,customer_id,customer_name,status,subtotal,tax_amount,discount_amount,total_amount,shipping_amount,tracking_number,courier,wallet_balance_after,created_at,business_id,store_id&order_no=eq.${encode(id)}&limit=1`
      ))[0];
      if (!order) {
        sendJson(res, 404, { error: "receipt_not_found" });
        return;
      }
      const items = await sbSelect(
        "order_items",
        `select=sku,name,quantity,unit_price,line_total&order_id=eq.${order.id}`
      );
      const payments = await sbSelect(
        "order_payments",
        `select=mode,amount&order_id=eq.${order.id}`
      ).catch(() => []);
      const biz = (await sbSelect("businesses", `select=legal_name,gstin,pan&id=eq.${order.business_id}&limit=1`))[0] || {};
      const store = (await sbSelect("stores", `select=name,address_line,city,state,pincode&id=eq.${order.store_id}&limit=1`))[0] || {};
      const member = order.customer_id
        ? (await sbSelect("membership_members", `select=referral_code,wallet_balance&customer_id=eq.${encode(order.customer_id)}&business_id=eq.${order.business_id}&limit=1`).catch(() => []))[0]
        : null;
      const rewardTxns = await sbSelect(
        "membership_wallet_transactions",
        `select=amount&order_id=eq.${order.id}&transaction_type=eq.purchase_reward`
      ).catch(() => []);
      const rewardEarned = rewardTxns.reduce((sum, txn) => sum + Number(txn.amount || 0), 0);
      sendJson(res, 200, {
        sale_id: order.order_no,
        channel: order.channel,
        customer_name: order.customer_name,
        status: order.status,
        created_at: order.created_at,
        totals: {
          subtotal: Number(order.subtotal || 0),
          tax: Number(order.tax_amount || 0),
          discount: Number(order.discount_amount || 0),
          shipping: Number(order.shipping_amount || 0),
          total: Number(order.total_amount || 0),
          wallet_balance: member ? Number(member.wallet_balance || 0) : Number(order.wallet_balance_after || 0)
        },
        tracking: {
          tracking_number: order.tracking_number || "",
          courier: order.courier || ""
        },
        membership: {
          referral_code: member ? member.referral_code : null,
          reward_earned: rewardEarned,
          wallet_balance: member ? Number(member.wallet_balance || 0) : Number(order.wallet_balance_after || 0)
        },
        payment_modes: payments.map((p) => p.mode),
        items: items.map((it) => ({
          sku: it.sku,
          name: it.name,
          quantity: Number(it.quantity || 0),
          unit_price: Number(it.unit_price || 0),
          line_total: Number(it.line_total || 0)
        })),
        business: { name: biz.legal_name || "", gstin: biz.gstin || "", pan: biz.pan || "" },
        store: {
          name: store.name || "",
          address_line: store.address_line || "",
          city: store.city || "",
          state: store.state || "",
          pincode: store.pincode || ""
        }
      });
      return;
    }

    // Public wallet lookup: a member checks their own balance by phone (no auth).
    if (pathname === "/v1/wallet" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const phone = (url.searchParams.get("phone") || "").replace(/\D/g, "").slice(-10);
      if (phone.length !== 10) {
        sendJson(res, 400, { error: "valid 10-digit phone required" });
        return;
      }
      const member = (await sbSelect(
        "membership_members",
        `select=id,business_id,name,phone,tier,wallet_balance,wallet_expires_at,referral_code,successful_referral_count&phone=eq.${encode(phone)}&limit=1`
      ).catch(() => []))[0];
      if (!member) {
        sendJson(res, 200, { found: false });
        return;
      }
      const history = await sbSelect(
        "membership_wallet_transactions",
        `select=transaction_type,amount,balance_after,created_at&member_id=eq.${member.id}&order=created_at.desc&limit=20`
      ).catch(() => []);
      const biz = member.business_id
        ? (await sbSelect("businesses", `select=legal_name&id=eq.${encode(member.business_id)}&limit=1`).catch(() => []))[0]
        : null;
      sendJson(res, 200, {
        found: true,
        business_name: (biz && biz.legal_name) || "",
        member: {
          name: member.name,
          phone: member.phone,
          tier: member.tier,
          wallet_balance: Number(member.wallet_balance || 0),
          wallet_expires_at: member.wallet_expires_at,
          referral_code: member.referral_code,
          successful_referral_count: Number(member.successful_referral_count || 0)
        },
        history: history.map((txn) => ({
          type: txn.transaction_type,
          amount: Number(txn.amount || 0),
          balance_after: Number(txn.balance_after || 0),
          created_at: txn.created_at
        }))
      });
      return;
    }

    // Everything below needs a resolved business/store context.
    const ctx = await resolveContext(req);

    // Current tenant/user context for the app header (business name, role, store).
    if (pathname === "/v1/me" && req.method === "GET") {
      const actor = await resolveActor(req);
      const biz = (await sbSelect("businesses", `select=code,legal_name,gstin&id=eq.${encode(ctx.businessId)}&limit=1`).catch(() => []))[0] || {};
      const store = (await sbSelect("stores", `select=code,name&id=eq.${encode(ctx.storeId)}&limit=1`).catch(() => []))[0] || {};
      let role = "";
      if (actor && actor.id) {
        const u = (await sbSelect("app_users", `select=role&id=eq.${encode(actor.id)}&limit=1`).catch(() => []))[0];
        role = u ? u.role : "";
      }
      sendJson(res, 200, {
        email: actor ? actor.email : "",
        role,
        business: { id: ctx.businessId, code: biz.code || ctx.businessCode, name: biz.legal_name || "" },
        store: { id: ctx.storeId, code: store.code || ctx.storeCode, name: store.name || "" }
      });
      return;
    }

    // Active stores for the current tenant (drives the top-bar store switcher).
    if (pathname === "/v1/stores" && req.method === "GET") {
      const rows = await sbSelect(
        "stores",
        `select=code,name,is_active&business_id=eq.${encode(ctx.businessId)}&order=created_at.asc`
      ).catch(() => []);
      sendJson(res, 200, {
        items: rows.filter((s) => s.is_active !== false).map((s) => ({ code: s.code, name: s.name })),
        current_store_code: (await sbSelect("stores", `select=code&id=eq.${encode(ctx.storeId)}&limit=1`).catch(() => []))[0]?.code || ""
      });
      return;
    }

    // ------------------------- Dashboard -------------------------
    if (pathname === "/v1/reports/dashboard" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const period = url.searchParams.get("period") || "today";
      const todayStart = startOfTodayIso();
      const weekStart = startOfDaysAgoIso(6);
      const monthStart = startOfMonthIso();
      const periodStart = period === "week"
        ? weekStart
        : period === "month"
          ? monthStart
          : period === "90days"
            ? startOfDaysAgoIso(89)
            : todayStart;
      const periodLabel = period === "week" ? "This Week" : period === "month" ? "This Month" : period === "90days" ? "Last 90 Days" : "Today";
      const [periodOrders, balances, periodExpenses, priceRows, openCashSessions, latestSyncRuns] = await Promise.all([
        sbSelect(
          "orders",
          `select=id,status,subtotal,tax_amount,discount_amount,total_amount,created_at&store_id=eq.${ctx.storeId}&created_at=gte.${encode(periodStart)}`
        ),
        sbSelect(
          "inventory_balances",
          `select=qty_on_hand,reorder_level,products(name)&store_id=eq.${ctx.storeId}`
        ),
        sbSelect(
          "expenses",
          `select=amount&store_id=eq.${ctx.storeId}&expense_date=gte.${encode(periodStart.slice(0, 10))}`
        ).catch(() => []),
        sbSelect(
          "product_prices",
          `select=product_id,cost_price,effective_from&store_id=eq.${ctx.storeId}&order=effective_from.desc`
        ).catch(() => []),
        sbSelect(
          "cash_sessions",
          `select=opened_at&store_id=eq.${ctx.storeId}&status=eq.open&order=opened_at.asc&limit=1`
        ).catch(() => []),
        sbSelect(
          "google_sheets_sync_runs",
          `select=status,error_message,completed_at&business_id=eq.${ctx.businessId}&order=completed_at.desc&limit=1`
        ).catch(() => [])
      ]);
      const paid = periodOrders.filter((o) => o.status === "paid");
      const returned = periodOrders.filter((o) => o.status === "returned");
      const unpaid = periodOrders.filter((o) => o.status === "created");

      const totalSales = paid.reduce((a, o) => a + Number(o.total_amount || 0), 0);
      const discounts = paid.reduce((a, o) => a + Number(o.discount_amount || 0), 0);
      const taxCollected = paid.reduce((a, o) => a + Number(o.tax_amount || 0), 0);
      const returnsRefunds = returned.reduce((a, o) => a + Number(o.total_amount || 0), 0);
      const netSales = totalSales - returnsRefunds;
      const ordersCount = paid.length;
      const outstanding = unpaid.reduce((a, o) => a + Number(o.total_amount || 0), 0);
      const aov = ordersCount ? Math.round(totalSales / ordersCount) : 0;

      // Items sold + COGS for today's paid orders.
      let itemsSold = 0;
      let itemsRevenue = 0;
      let cogs = 0;
      const paidIds = paid.map((o) => o.id);
      if (paidIds.length) {
        const lineItems = await sbSelect(
          "order_items",
          `select=product_id,quantity,line_total&order_id=in.(${paidIds.join(",")})`
        ).catch(() => []);
        itemsSold = lineItems.reduce((a, it) => a + Number(it.quantity || 0), 0);
        itemsRevenue = lineItems.reduce((a, it) => a + Number(it.line_total || 0), 0);

        const costByProduct = {};
        priceRows.forEach((pr) => {
          if (!(pr.product_id in costByProduct)) {
            costByProduct[pr.product_id] = Number(pr.cost_price || 0);
          }
        });
        cogs = lineItems.reduce((a, it) => a + (Number(it.quantity || 0) * (costByProduct[it.product_id] || 0)), 0);
      }
      const grossProfit = itemsRevenue - cogs;
      const expenses = periodExpenses.reduce((total, expense) => total + Number(expense.amount || 0), 0);
      const netProfit = grossProfit - expenses;
      const profitMargin = netSales > 0 ? Math.round((netProfit / netSales) * 1000) / 10 : 0;

      const lowStock = balances.filter((b) => Number(b.qty_on_hand) <= Number(b.reorder_level));

      const weekOrders = periodOrders.filter((order) => order.created_at >= weekStart);
      const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const trend = [];
      for (let i = 6; i >= 0; i -= 1) {
        const day = new Date();
        day.setHours(0, 0, 0, 0);
        day.setDate(day.getDate() - i);
        const total = weekOrders
          .filter((o) => o.status === "paid" && new Date(o.created_at).toDateString() === day.toDateString())
          .reduce((a, o) => a + Number(o.total_amount || 0), 0);
        trend.push([dayNames[day.getDay()], Math.round(total / 1000)]);
      }

      const alerts = lowStock.slice(0, 3).map((balance) => ({
        level: "warning",
        message: `Low stock: ${(balance.products && balance.products.name) || "SKU"} (${balance.qty_on_hand} left)`,
        action: "Review stock",
        tab: "inventory"
      }));
      if (unpaid.length) {
        alerts.push({
          level: "warning",
          message: `${unpaid.length} unpaid order${unpaid.length === 1 ? "" : "s"} totaling ${outstanding.toFixed(2)}`,
          action: "Review orders",
          tab: "orders"
        });
      }
      if (openCashSessions.length) {
        alerts.push({
          level: "info",
          message: `Cash drawer open since ${new Date(openCashSessions[0].opened_at).toLocaleString("en-IN")}`,
          action: "View cash report",
          tab: "reports"
        });
      }
      if (latestSyncRuns[0] && latestSyncRuns[0].status === "error") {
        alerts.push({
          level: "danger",
          message: `Google Sheets backup failed: ${latestSyncRuns[0].error_message || "check integration settings"}`,
          action: "View integration",
          tab: "integrations"
        });
      }

      const rangeStarts = {
        today: todayStart,
        last_3_days: startOfDaysAgoIso(2),
        this_week: startOfWeekIso(),
        this_month: monthStart
      };
      const rangeSales = {};
      Object.entries(rangeStarts).forEach(([key, start]) => {
        const paidOrders = periodOrders.filter((order) => order.created_at >= start && order.status === "paid");
        rangeSales[key] = {
          sales: paidOrders.reduce((total, order) => total + Number(order.total_amount || 0), 0),
          orders: paidOrders.length
        };
      });

      sendJson(res, 200, {
        period,
        period_label: periodLabel,
        kpis: {
          total_sales: totalSales,
          net_sales: netSales,
          gross_profit: grossProfit,
          net_profit: netProfit,
          profit_margin: profitMargin,
          orders: ordersCount,
          items_sold: itemsSold,
          aov,
          discounts: discounts,
          returns_refunds: returnsRefunds,
          tax_collected: taxCollected,
          outstanding: outstanding,
          expenses,
          low_stock_skus: lowStock.length
        },
        sales_periods: rangeSales,
        trend,
        alerts
      });
      return;
    }

    if (pathname === "/v1/reports/tax-summary" && req.method === "GET") {
      const month = new Date();
      month.setDate(1);
      month.setHours(0, 0, 0, 0);
      const rows = await sbSelect(
        "orders",
        `select=subtotal,tax_amount&store_id=eq.${ctx.storeId}&created_at=gte.${encode(month.toISOString())}`
      );
      const taxable = rows.reduce((a, o) => a + Number(o.subtotal || 0), 0);
      const tax = rows.reduce((a, o) => a + Number(o.tax_amount || 0), 0);
      sendJson(res, 200, {
        period: `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, "0")}`,
        taxable_value: taxable,
        cgst: Math.round((tax / 2) * 100) / 100,
        sgst: Math.round((tax / 2) * 100) / 100,
        igst: 0
      });
      return;
    }

    if (pathname === "/v1/reports/top-products" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const period = url.searchParams.get("period") || "month";
      const days = period === "day" ? 0 : period === "week" ? 6 : 30;
      const start = startOfDaysAgoIso(days);
      const items = await sbSelect(
        "order_items",
        `select=sku,name,quantity,line_total,orders!inner(store_id,created_at,status)&orders.store_id=eq.${ctx.storeId}&orders.created_at=gte.${encode(start)}&orders.status=eq.paid`
      );
      const bucket = new Map();
      items.forEach((it) => {
        const cur = bucket.get(it.sku) || { sku: it.sku, name: it.name, units_sold: 0, revenue: 0 };
        cur.units_sold += Number(it.quantity || 0);
        cur.revenue += Number(it.line_total || 0);
        bucket.set(it.sku, cur);
      });
      const top = Array.from(bucket.values()).sort((a, b) => b.units_sold - a.units_sold).slice(0, 10);
      sendJson(res, 200, { period, items: top, sold_skus: Array.from(bucket.keys()) });
      return;
    }

    if (pathname === "/v1/reports/sales-by-staff" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const period = url.searchParams.get("period") || "month";
      const days = period === "day" ? 0 : period === "week" ? 6 : 30;
      const rows = await sbSelect(
        "orders",
        `select=sold_by_user_id,sold_by_name,total_amount&store_id=eq.${ctx.storeId}&status=eq.paid&created_at=gte.${encode(startOfDaysAgoIso(days))}`
      );
      const staff = new Map();
      rows.forEach((order) => {
        const id = order.sold_by_user_id || "unattributed";
        const current = staff.get(id) || { user_id: order.sold_by_user_id || null, name: order.sold_by_name || "Unattributed", orders: 0, sales: 0 };
        current.orders += 1;
        current.sales += Number(order.total_amount || 0);
        staff.set(id, current);
      });
      sendJson(res, 200, { period, items: Array.from(staff.values()).sort((a, b) => b.sales - a.sales) });
      return;
    }

    if (pathname === "/v1/reports/stock-list" && req.method === "GET") {
      const [balances, prices] = await Promise.all([
        sbSelect(
          "inventory_balances",
          `select=product_id,qty_on_hand,reorder_level,products!inner(sku,name,is_active)&store_id=eq.${ctx.storeId}&products.is_active=eq.true`
        ),
        sbSelect(
          "product_prices",
          `select=product_id,mrp,selling_price,cost_price,effective_from&store_id=eq.${ctx.storeId}&order=effective_from.desc`
        ).catch(() => [])
      ]);
      const priceByProduct = {};
      prices.forEach((price) => {
        if (!priceByProduct[price.product_id]) priceByProduct[price.product_id] = price;
      });
      const activeItems = balances
        .filter((balance) => balance.products && balance.products.is_active !== false)
        .map((balance) => {
          const price = priceByProduct[balance.product_id] || {};
          return {
            sku: balance.products.sku,
            name: balance.products.name,
            quantity: Number(balance.qty_on_hand || 0),
            reorder_level: Number(balance.reorder_level || 0),
            mrp: Number(price.mrp || 0),
            selling_price: Number(price.selling_price || 0),
            cost_price: Number(price.cost_price || 0),
            inventory_value: Number(balance.qty_on_hand || 0) * Number(price.cost_price || 0)
          };
        });
      sendJson(res, 200, { items: activeItems, total_value: activeItems.reduce((total, item) => total + item.inventory_value, 0) });
      return;
    }

    if (pathname === "/v1/reports/reconciliation" && req.method === "GET") {
      const rows = await sbSelect(
        "payment_reconciliation",
        `select=recon_date,gateway_amount,pos_amount,variance&store_id=eq.${ctx.storeId}&order=recon_date.desc`
      );
      sendJson(res, 200, {
        rows: rows.map((r) => ({
          date: r.recon_date,
          gateway_amount: Number(r.gateway_amount),
          pos_amount: Number(r.pos_amount),
          variance: Number(r.variance)
        }))
      });
      return;
    }

    if (pathname === "/v1/expenses" && req.method === "GET") {
      const rows = await sbSelect(
        "expenses",
        `select=id,expense_date,expense_at,category,description,amount,payment_mode,recorded_by_name,created_at&store_id=eq.${ctx.storeId}&order=expense_date.desc,expense_at.desc&limit=100`
      );
      sendJson(res, 200, { items: rows.map((row) => ({ ...row, amount: Number(row.amount || 0) })) });
      return;
    }

    if (pathname === "/v1/expenses" && req.method === "POST") {
      const body = await parseBody(req);
      const actor = await resolveActor(req);
      const amount = Number(body.amount || 0);
      const category = String(body.category || "").trim();
      if (!category || !(amount > 0)) {
        sendJson(res, 400, { error: "category and positive amount required" });
        return;
      }
      const inserted = await sbInsert("expenses", [{
        business_id: ctx.businessId,
        store_id: ctx.storeId,
        expense_date: body.expense_date || nowIso().slice(0, 10),
        expense_at: body.expense_at || nowIso(),
        category,
        description: String(body.description || "").trim() || null,
        amount,
        payment_mode: body.payment_mode || null,
        recorded_by_user_id: actor ? actor.id : null,
        recorded_by_name: actor ? (actor.name || actor.email) : null
      }]);
      sendJson(res, 201, { item: { ...inserted[0], amount: Number(inserted[0].amount || amount) } });
      return;
    }

    if (pathname === "/v1/cash-session" && req.method === "GET") {
      const sessions = await sbSelect(
        "cash_sessions",
        `select=*&store_id=eq.${ctx.storeId}&order=opened_at.desc&limit=1`
      ).catch(() => []);
      const session = sessions[0];
      if (!session) {
        sendJson(res, 200, { session: null });
        return;
      }
      const openedAt = session.opened_at || nowIso();
      const [cashPayments, cashExpenses] = await Promise.all([
        sbSelect(
          "order_payments",
          `select=amount,orders!inner(store_id,created_at,status)&mode=eq.cash&orders.store_id=eq.${ctx.storeId}&orders.created_at=gte.${encode(openedAt)}&orders.status=eq.paid`
        ).catch(() => []),
        sbSelect(
          "expenses",
          `select=amount&store_id=eq.${ctx.storeId}&payment_mode=eq.cash&expense_date=gte.${encode(openedAt.slice(0, 10))}`
        ).catch(() => [])
      ]);
      const cashSales = cashPayments.reduce((total, payment) => total + Number(payment.amount || 0), 0);
      const cashExpensesTotal = cashExpenses.reduce((total, expense) => total + Number(expense.amount || 0), 0);
      const expected = Number(session.opening_amount || 0) + cashSales - cashExpensesTotal;
      sendJson(res, 200, {
        session: {
          ...session,
          opening_amount: Number(session.opening_amount || 0),
          closing_amount: session.closing_amount == null ? null : Number(session.closing_amount),
          cash_sales: cashSales,
          cash_expenses: cashExpensesTotal,
          expected_closing: expected,
          variance: session.closing_amount == null ? null : Number(session.closing_amount) - expected
        }
      });
      return;
    }

    if (pathname === "/v1/cash-session" && req.method === "POST") {
      const body = await parseBody(req);
      const actor = await resolveActor(req);
      const amount = Number(body.amount || 0);
      if (!(amount >= 0)) {
        sendJson(res, 400, { error: "valid amount required" });
        return;
      }
      const active = await sbSelect(
        "cash_sessions",
        `select=*&store_id=eq.${ctx.storeId}&status=eq.open&order=opened_at.desc&limit=1`
      ).catch(() => []);
      if (body.action === "open") {
        if (active.length) {
          sendJson(res, 409, { error: "cash_session_already_open" });
          return;
        }
        const inserted = await sbInsert("cash_sessions", [{
          business_id: ctx.businessId,
          store_id: ctx.storeId,
          opening_amount: amount,
          opened_by_user_id: actor ? actor.id : null,
          opened_by_name: actor ? (actor.name || actor.email) : null,
          status: "open"
        }]);
        sendJson(res, 201, { session: inserted[0] });
        return;
      }
      if (body.action === "close") {
        if (!active.length) {
          sendJson(res, 409, { error: "no_open_cash_session" });
          return;
        }
        const updated = await sbUpdate("cash_sessions", `id=eq.${active[0].id}`, {
          closing_amount: amount,
          closed_at: nowIso(),
          closed_by_user_id: actor ? actor.id : null,
          closed_by_name: actor ? (actor.name || actor.email) : null,
          status: "closed"
        });
        sendJson(res, 200, { session: updated[0] });
        return;
      }
      sendJson(res, 400, { error: "action must be open or close" });
      return;
    }

    // ------------------------- Orders -------------------------
    if (pathname === "/v1/orders" && req.method === "GET") {
      const rows = await sbSelect(
        "orders",
        `select=order_no,channel,customer_name,total_amount,status,created_at&or=(store_id.eq.${ctx.storeId},channel.eq.online)&order=created_at.desc`
      );
      sendJson(res, 200, {
        items: rows.map((o) => ({
          order_no: o.order_no,
          channel: channelLabel(o.channel),
          customer_name: o.customer_name,
          total_amount: Number(o.total_amount || 0),
          status: titleCaseStatus(o.status),
          created_at: o.created_at
        }))
      });
      return;
    }

    if (pathname === "/v1/orders/void" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.order_no || !body.reason) {
        sendJson(res, 400, { error: "order_no and reason required" });
        return;
      }
      const found = await sbSelect("orders", `select=id&order_no=eq.${encode(body.order_no)}&business_id=eq.${ctx.businessId}&limit=1`);
      if (!found.length) {
        sendJson(res, 404, { error: "order_not_found" });
        return;
      }
      await sbUpdate("orders", `id=eq.${found[0].id}`, { status: "voided" });
      await sbInsert("order_void_logs", [
        { business_id: ctx.businessId, order_id: found[0].id, order_no: body.order_no, reason: String(body.reason) }
      ]);
      sendJson(res, 200, { status: "voided", order_no: body.order_no });
      return;
    }

    if (pathname === "/v1/orders/reprint" && req.method === "POST") {
      const body = await parseBody(req);
      if (!body.order_no) {
        sendJson(res, 400, { error: "order_no required" });
        return;
      }
      const found = await sbSelect("orders", `select=id&order_no=eq.${encode(body.order_no)}&business_id=eq.${ctx.businessId}&limit=1`);
      await sbInsert("order_reprint_logs", [
        { business_id: ctx.businessId, order_id: found[0] ? found[0].id : null, order_no: body.order_no }
      ]);
      sendJson(res, 200, { status: "queued", order_no: body.order_no });
      return;
    }

    // ------------------------- Inventory -------------------------
    if (pathname === "/v1/inventory/products" && req.method === "GET") {
      const rows = await sbSelect(
        "inventory_balances",
        `select=product_id,qty_on_hand,reorder_level,location,products(sku,name,hsn_code,tax_percent,is_active)&store_id=eq.${ctx.storeId}`
      );
      const prices = await sbSelect(
        "product_prices",
        `select=product_id,mrp,selling_price,cost_price,effective_from&store_id=eq.${ctx.storeId}&order=effective_from.desc`
      ).catch(() => []);
      const priceByProduct = {};
      prices.forEach((pr) => {
        if (!(pr.product_id in priceByProduct)) {
          priceByProduct[pr.product_id] = { mrp: Number(pr.mrp), offer: Number(pr.selling_price), cost: Number(pr.cost_price || 0), added_at: pr.effective_from };
        }
        // Prices are ordered newest-first, so the last assignment is the earliest (first stocked).
        priceByProduct[pr.product_id].added_at = pr.effective_from;
      });
      sendJson(res, 200, {
        products: rows.filter((r) => !r.products || r.products.is_active !== false).map((r) => ({
          sku: r.products ? r.products.sku : "",
          name: r.products ? r.products.name : "",
          hsn: r.products ? r.products.hsn_code || "" : "",
          tax_percent: r.products ? Number(r.products.tax_percent || 0) : 0,
          qty: Number(r.qty_on_hand || 0),
          reorder_level: Number(r.reorder_level || 0),
          location: r.location || "",
          price: priceByProduct[r.product_id] ? priceByProduct[r.product_id].offer : 0,
          mrp: priceByProduct[r.product_id] ? priceByProduct[r.product_id].mrp : 0,
          cost_price: priceByProduct[r.product_id] ? priceByProduct[r.product_id].cost : 0,
          added_at: priceByProduct[r.product_id] ? priceByProduct[r.product_id].added_at : null
        }))
      });
      return;
    }

    if (pathname === "/v1/inventory/ledger" && req.method === "GET") {
      const rows = await sbSelect(
        "inventory_ledger",
        `select=created_at,direction,qty,source,reference_id,products(sku)&store_id=eq.${ctx.storeId}&order=created_at.desc&limit=100`
      );
      sendJson(res, 200, {
        entries: rows.map((e) => ({
          timestamp: e.created_at,
          sku: e.products ? e.products.sku : "",
          direction: e.direction,
          qty: Number(e.qty || 0),
          source: e.source,
          reference_id: e.reference_id
        }))
      });
      return;
    }

    if (pathname === "/v1/inventory/labels/print" && req.method === "POST") {
      const body = await parseBody(req);
      const row = {
        business_id: ctx.businessId,
        store_id: ctx.storeId,
        start_sku: body.start_sku || "",
        end_sku: body.end_sku || body.start_sku || "",
        copies: Number(body.copies || 1),
        status: "queued"
      };
      const inserted = await sbInsert("label_print_jobs", [row]);
      const jobId = inserted[0] ? inserted[0].id : `LBL-${Date.now()}`;
      sendJson(res, 202, { job_id: jobId, start_sku: row.start_sku, end_sku: row.end_sku, copies: row.copies, status: "queued" });
      return;
    }

    // Add stock: create/update the product, its store price, and inventory balance.
    if (pathname === "/v1/inventory/stock" && req.method === "POST") {
      const body = await parseBody(req);
      const sku = String(body.sku || "").trim();
      const name = String(body.name || "").trim();
      const qty = Number(body.qty || 0);
      const price = Number(body.price || 0); // MRP
      const offerPrice = Number(body.offer_price || 0) || price; // selling price
      const costPrice = Number(body.cost_price || 0);
      if (!sku || !name || !(qty > 0)) {
        sendJson(res, 400, { error: "sku, name and positive qty required" });
        return;
      }

      let product = (await sbSelect("products", `select=id&sku=eq.${encode(sku)}&business_id=eq.${ctx.businessId}&limit=1`))[0];
      if (!product) {
        product = (await sbInsert("products", [
          {
            business_id: ctx.businessId,
            sku,
            barcode: body.barcode || sku,
            name,
            hsn_code: body.hsn || null,
            category: body.category || null,
            unit: body.unit || "pcs",
            tax_percent: Number(body.tax_percent || 0),
            is_active: true
          }
        ]))[0];
      } else if (name) {
        await sbUpdate("products", `id=eq.${product.id}`, { name, tax_percent: Number(body.tax_percent || 0) });
      }

      if (price > 0 || offerPrice > 0) {
        await sbInsert("product_prices", [
          {
            business_id: ctx.businessId,
            store_id: ctx.storeId,
            product_id: product.id,
            mrp: price || offerPrice,
            selling_price: offerPrice,
            cost_price: costPrice,
            effective_from: nowIso()
          }
        ]);
      }

      const bal = (await sbSelect(
        "inventory_balances",
        `select=id,qty_on_hand&store_id=eq.${ctx.storeId}&product_id=eq.${product.id}&limit=1`
      ))[0];
      if (bal) {
        await sbUpdate("inventory_balances", `id=eq.${bal.id}`, {
          qty_on_hand: Number(bal.qty_on_hand || 0) + qty,
          reorder_level: Number(body.reorder_level || 0),
          location: body.location || null
        });
      } else {
        await sbInsert("inventory_balances", [
          {
            business_id: ctx.businessId,
            store_id: ctx.storeId,
            product_id: product.id,
            qty_on_hand: qty,
            reorder_level: Number(body.reorder_level || 0),
            location: body.location || null
          }
        ]);
      }

      await sbInsert("inventory_ledger", [
        {
          business_id: ctx.businessId,
          store_id: ctx.storeId,
          product_id: product.id,
          direction: "in",
          qty,
          source: "manual_stock_in",
          reference_type: "stock_in",
          reference_id: sku
        }
      ]);

      sendJson(res, 201, { sku, name, price, offer_price: offerPrice, qty, barcode: body.barcode || sku });
      return;
    }

    if (pathname === "/v1/inventory/product" && req.method === "POST") {
      const body = await parseBody(req);
      const sku = String(body.sku || "").trim();
      if (!sku) {
        sendJson(res, 400, { error: "sku required" });
        return;
      }
      const product = (await sbSelect("products", `select=id&sku=eq.${encode(sku)}&business_id=eq.${ctx.businessId}&limit=1`))[0];
      if (!product) {
        sendJson(res, 404, { error: "product_not_found" });
        return;
      }
      await sbUpdate("products", `id=eq.${product.id}`, {
        name: String(body.name || "").trim() || sku,
        hsn_code: String(body.hsn || "").trim() || null,
        tax_percent: Number(body.tax_percent || 0)
      });
      await sbInsert("product_prices", [{
        business_id: ctx.businessId,
        store_id: ctx.storeId,
        product_id: product.id,
        mrp: Number(body.mrp || 0),
        selling_price: Number(body.price || 0),
        cost_price: Number(body.cost_price || 0),
        effective_from: nowIso()
      }]);
      const balance = (await sbSelect("inventory_balances", `select=id&store_id=eq.${ctx.storeId}&product_id=eq.${product.id}&limit=1`))[0];
      if (balance) {
        const requestedQty = Number(body.qty);
        const nextQty = Number.isFinite(requestedQty) && requestedQty >= 0
          ? requestedQty
          : undefined;
        await sbUpdate("inventory_balances", `id=eq.${balance.id}`, {
          ...(nextQty === undefined ? {} : { qty_on_hand: nextQty }),
          reorder_level: Number(body.reorder_level || 0),
          location: String(body.location || "").trim() || null
        });
      }
      sendJson(res, 200, { status: "updated", sku });
      return;
    }

    // Soft-delete a product: mark inactive so it hides from stock but keeps history.
    if (pathname === "/v1/inventory/product/delete" && req.method === "POST") {
      const body = await parseBody(req);
      const sku = String(body.sku || "").trim();
      if (!sku) {
        sendJson(res, 400, { error: "sku required" });
        return;
      }
      const product = (await sbSelect("products", `select=id&sku=eq.${encode(sku)}&business_id=eq.${ctx.businessId}&limit=1`))[0];
      if (!product) {
        sendJson(res, 404, { error: "product_not_found" });
        return;
      }
      await sbUpdate("products", `id=eq.${product.id}&business_id=eq.${ctx.businessId}`, { is_active: false });
      sendJson(res, 200, { status: "deleted", sku });
      return;
    }

    // Look up a product by SKU or barcode for POS billing (validates stock).
    if (pathname === "/v1/pos/product-lookup" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const code = (url.searchParams.get("code") || "").trim();
      if (!code) {
        sendJson(res, 400, { error: "code required" });
        return;
      }
      const products = await sbSelect(
        "products",
        `select=id,sku,name,tax_percent,barcode&business_id=eq.${ctx.businessId}&or=(sku.eq.${encode(code)},barcode.eq.${encode(code)})&limit=1`
      );
      if (!products.length) {
        sendJson(res, 404, { error: "product_not_found" });
        return;
      }
      const p = products[0];
      const priceRow = (await sbSelect(
        "product_prices",
        `select=mrp,selling_price&product_id=eq.${p.id}&store_id=eq.${ctx.storeId}&order=effective_from.desc&limit=1`
      ))[0];
      const balRow = (await sbSelect(
        "inventory_balances",
        `select=qty_on_hand&product_id=eq.${p.id}&store_id=eq.${ctx.storeId}&limit=1`
      ))[0];
      sendJson(res, 200, {
        sku: p.sku,
        name: p.name,
        barcode: p.barcode,
        unit_price: priceRow ? Number(priceRow.selling_price) : 0,
        mrp: priceRow ? Number(priceRow.mrp) : 0,
        tax_percent: Number(p.tax_percent || 0),
        available_qty: balRow ? Number(balRow.qty_on_hand) : 0
      });
      return;
    }

    // Business + store details for printed receipts.
    if (pathname === "/v1/pos/receipt-context" && req.method === "GET") {
      const biz = (await sbSelect(
        "businesses",
        `select=legal_name,gstin,pan,invoice_prefix&id=eq.${ctx.businessId}&limit=1`
      ))[0] || {};
      const store = (await sbSelect(
        "stores",
        `select=name,address_line,city,state,pincode,phone&id=eq.${ctx.storeId}&limit=1`
      ))[0] || {};
      sendJson(res, 200, {
        business: {
          name: biz.legal_name || "",
          gstin: biz.gstin || "",
          pan: biz.pan || "",
          invoice_prefix: biz.invoice_prefix || ""
        },
        store: {
          name: store.name || "",
          address_line: store.address_line || "",
          city: store.city || "",
          state: store.state || "",
          pincode: store.pincode || "",
          phone: store.phone || ""
        }
      });
      return;
    }

    // ------------------------- Customers / promotions -------------------------
    // NOTE: "place" is stored in the customers.segment free-text column
    // (the schema has no dedicated address/place column).
    if (pathname === "/v1/customers" && req.method === "GET") {
      const rows = await sbSelect(
        "customers",
        `select=id,customer_code,name,phone,segment,created_at&business_id=eq.${ctx.businessId}&order=created_at.desc`
      );
      sendJson(res, 200, {
        items: rows.map((c) => ({
          id: c.id,
          code: c.customer_code,
          name: c.name,
          phone: c.phone || "",
          place: c.segment || ""
        }))
      });
      return;
    }

    // Look up a customer by phone (POS + customers tab search).
    if (pathname === "/v1/customers/lookup" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const phone = (url.searchParams.get("phone") || "").trim();
      if (!phone) {
        sendJson(res, 400, { error: "phone required" });
        return;
      }
      const rows = await sbSelect(
        "customers",
        `select=id,customer_code,name,phone,segment&business_id=eq.${ctx.businessId}&phone=eq.${encode(phone)}&limit=1`
      );
      if (!rows.length) {
        sendJson(res, 200, { found: false });
        return;
      }
      const c = rows[0];
      sendJson(res, 200, { found: true, customer: { id: c.id, code: c.customer_code, name: c.name, phone: c.phone, place: c.segment || "" } });
      return;
    }

    // Create or update a customer (upsert by phone).
    if (pathname === "/v1/customers" && req.method === "POST") {
      const body = await parseBody(req);
      const name = String(body.name || "").trim();
      const phone = String(body.phone || "").trim();
      const place = String(body.place || "").trim();
      if (!name || !phone) {
        sendJson(res, 400, { error: "name and phone required" });
        return;
      }
      const existing = await sbSelect(
        "customers",
        `select=id&business_id=eq.${ctx.businessId}&phone=eq.${encode(phone)}&limit=1`
      );
      let saved;
      if (existing.length) {
        saved = (await sbUpdate("customers", `id=eq.${existing[0].id}`, { name, segment: place }))[0];
      } else {
        saved = (await sbInsert("customers", [
          { business_id: ctx.businessId, customer_code: `C-${Date.now()}`, name, phone, segment: place, is_active: true }
        ]))[0];
      }
      sendJson(res, 200, { id: saved.id, code: saved.customer_code, name: saved.name, phone: saved.phone, place: saved.segment || "" });
      return;
    }

    // Customer detail + order history.
    if (pathname === "/v1/customers/detail" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const id = (url.searchParams.get("id") || "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id required" });
        return;
      }
      const rows = await sbSelect(
        "customers",
        `select=id,customer_code,name,phone,segment,created_at&id=eq.${encode(id)}&business_id=eq.${ctx.businessId}&limit=1`
      );
      if (!rows.length) {
        sendJson(res, 404, { error: "customer_not_found" });
        return;
      }
      const c = rows[0];
      const orders = await sbSelect(
        "orders",
        `select=order_no,status,total_amount,created_at,channel&customer_id=eq.${encode(id)}&order=created_at.desc&limit=100`
      );
      const totalSpent = orders.reduce((a, o) => a + Number(o.total_amount || 0), 0);
      sendJson(res, 200, {
        customer: { id: c.id, code: c.customer_code, name: c.name, phone: c.phone || "", place: c.segment || "", since: c.created_at },
        stats: { orders: orders.length, total_spent: totalSpent },
        orders: orders.map((o) => ({
          order_no: o.order_no,
          status: titleCaseStatus(o.status),
          total_amount: Number(o.total_amount || 0),
          channel: channelLabel(o.channel),
          created_at: o.created_at
        }))
      });
      return;
    }

    if (pathname === "/v1/promotions/campaigns" && req.method === "GET") {
      const rows = await sbSelect(
        "campaigns",
        `select=id,name,status&business_id=eq.${ctx.businessId}&order=created_at.desc`
      );
      // Aggregate delivery metrics from campaign_events when present.
      const events = await sbSelect(
        "campaign_events",
        `select=campaign_id,event_type&business_id=eq.${ctx.businessId}`
      ).catch(() => []);
      const metrics = new Map();
      events.forEach((e) => {
        const m = metrics.get(e.campaign_id) || { delivered: 0, clicked: 0, converted: 0 };
        if (e.event_type === "delivered") m.delivered += 1;
        else if (e.event_type === "clicked") m.clicked += 1;
        else if (e.event_type === "converted") m.converted += 1;
        metrics.set(e.campaign_id, m);
      });
      sendJson(res, 200, {
        items: rows.map((c) => {
          const m = metrics.get(c.id) || { delivered: 0, clicked: 0, converted: 0 };
          return { id: c.id, name: c.name, delivered: m.delivered, clicked: m.clicked, converted: m.converted, revenue: 0 };
        })
      });
      return;
    }

    // ------------------------- Promo codes -------------------------
    if (pathname === "/v1/promotions/promo-codes" && req.method === "GET") {
      const rows = await sbSelect(
        "promo_codes",
        `select=id,code,description,discount_type,discount_value,min_order_amount,max_discount_amount,usage_limit,used_count,start_date,end_date,is_active,created_at&business_id=eq.${ctx.businessId}&order=created_at.desc`
      ).catch(() => []);
      sendJson(res, 200, { items: rows });
      return;
    }

    if (pathname === "/v1/promotions/promo-codes" && req.method === "POST") {
      const body = await parseBody(req);
      const code = String(body.code || "").trim().toUpperCase();
      const discountType = body.discount_type === "fixed" ? "fixed" : "percent";
      const discountValue = Number(body.discount_value || 0);
      if (!code || !(discountValue > 0)) {
        sendJson(res, 400, { error: "code and positive discount_value required" });
        return;
      }
      const existing = await sbSelect("promo_codes", `select=id&business_id=eq.${ctx.businessId}&code=eq.${encode(code)}&limit=1`).catch(() => []);
      if (existing.length) {
        sendJson(res, 409, { error: "code_exists", message: "Promo code already exists." });
        return;
      }
      const inserted = await sbInsert("promo_codes", [{
        business_id: ctx.businessId,
        code,
        description: String(body.description || "").trim() || null,
        discount_type: discountType,
        discount_value: discountValue,
        min_order_amount: Number(body.min_order_amount || 0),
        max_discount_amount: body.max_discount_amount != null && body.max_discount_amount !== "" ? Number(body.max_discount_amount) : null,
        usage_limit: body.usage_limit != null && body.usage_limit !== "" ? Number(body.usage_limit) : null,
        start_date: body.start_date || null,
        end_date: body.end_date || null,
        is_active: body.is_active === false ? false : true
      }]);
      sendJson(res, 201, { status: "created", promo: inserted[0] || null });
      return;
    }

    if (pathname === "/v1/promotions/promo-codes/update" && req.method === "POST") {
      const body = await parseBody(req);
      const id = String(body.id || "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id required" });
        return;
      }
      const patch = {};
      if (body.description !== undefined) patch.description = String(body.description || "").trim() || null;
      if (body.discount_type !== undefined) patch.discount_type = body.discount_type === "fixed" ? "fixed" : "percent";
      if (body.discount_value !== undefined) patch.discount_value = Number(body.discount_value || 0);
      if (body.min_order_amount !== undefined) patch.min_order_amount = Number(body.min_order_amount || 0);
      if (body.max_discount_amount !== undefined) patch.max_discount_amount = body.max_discount_amount === "" || body.max_discount_amount == null ? null : Number(body.max_discount_amount);
      if (body.usage_limit !== undefined) patch.usage_limit = body.usage_limit === "" || body.usage_limit == null ? null : Number(body.usage_limit);
      if (body.start_date !== undefined) patch.start_date = body.start_date || null;
      if (body.end_date !== undefined) patch.end_date = body.end_date || null;
      if (body.is_active !== undefined) patch.is_active = Boolean(body.is_active);
      await sbUpdate("promo_codes", `id=eq.${encode(id)}&business_id=eq.${ctx.businessId}`, patch);
      sendJson(res, 200, { status: "updated", id });
      return;
    }

    if (pathname === "/v1/promotions/promo-codes/delete" && req.method === "POST") {
      const body = await parseBody(req);
      const id = String(body.id || "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id required" });
        return;
      }
      await sbDelete("promo_codes", `id=eq.${encode(id)}&business_id=eq.${ctx.businessId}`);
      sendJson(res, 200, { status: "deleted", id });
      return;
    }

    if (pathname === "/v1/promotions/promo-codes/validate" && req.method === "POST") {
      const body = await parseBody(req);
      const result = await validatePromoCode(ctx.businessId, body.code, body.order_amount);
      if (!result.valid) {
        sendJson(res, 200, { valid: false, reason: result.reason, discount: 0 });
        return;
      }
      sendJson(res, 200, {
        valid: true,
        discount: result.discount,
        code: result.promo.code,
        discount_type: result.promo.discount_type,
        discount_value: Number(result.promo.discount_value)
      });
      return;
    }

    // ------------------------- Purchase orders -------------------------
    if (pathname === "/v1/purchases" && req.method === "GET") {
      const rows = await sbSelect(
        "purchase_orders",
        `select=id,po_date,place,bill_no,shop_name,ref_id,total_amount,misc,comments,recorded_by_name,created_at&store_id=eq.${ctx.storeId}&order=po_date.desc,created_at.desc&limit=200`
      ).catch(() => []);
      sendJson(res, 200, { items: rows.map((row) => ({ ...row, total_amount: Number(row.total_amount || 0) })) });
      return;
    }

    if (pathname === "/v1/purchases" && req.method === "POST") {
      const body = await parseBody(req);
      const actor = await resolveActor(req);
      const totalAmount = Number(body.total_amount || 0);
      if (!(totalAmount >= 0)) {
        sendJson(res, 400, { error: "valid total_amount required" });
        return;
      }
      const inserted = await sbInsert("purchase_orders", [{
        business_id: ctx.businessId,
        store_id: ctx.storeId,
        po_date: body.po_date || nowIso().slice(0, 10),
        place: String(body.place || "").trim() || null,
        bill_no: String(body.bill_no || "").trim() || null,
        shop_name: String(body.shop_name || "").trim() || null,
        ref_id: String(body.ref_id || "").trim() || null,
        total_amount: totalAmount,
        misc: String(body.misc || "").trim() || null,
        comments: String(body.comments || "").trim() || null,
        recorded_by_user_id: actor ? actor.id : null,
        recorded_by_name: actor ? (actor.name || actor.email) : null
      }]);
      sendJson(res, 201, { status: "created", item: inserted[0] || null });
      return;
    }

    if (pathname === "/v1/purchases/update" && req.method === "POST") {
      const body = await parseBody(req);
      const id = String(body.id || "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id required" });
        return;
      }
      const patch = {};
      if (body.po_date !== undefined) patch.po_date = body.po_date || nowIso().slice(0, 10);
      if (body.place !== undefined) patch.place = String(body.place || "").trim() || null;
      if (body.bill_no !== undefined) patch.bill_no = String(body.bill_no || "").trim() || null;
      if (body.shop_name !== undefined) patch.shop_name = String(body.shop_name || "").trim() || null;
      if (body.ref_id !== undefined) patch.ref_id = String(body.ref_id || "").trim() || null;
      if (body.total_amount !== undefined) patch.total_amount = Number(body.total_amount || 0);
      if (body.misc !== undefined) patch.misc = String(body.misc || "").trim() || null;
      if (body.comments !== undefined) patch.comments = String(body.comments || "").trim() || null;
      await sbUpdate("purchase_orders", `id=eq.${encode(id)}&business_id=eq.${ctx.businessId}`, patch);
      sendJson(res, 200, { status: "updated", id });
      return;
    }

    if (pathname === "/v1/purchases/delete" && req.method === "POST") {
      const body = await parseBody(req);
      const id = String(body.id || "").trim();
      if (!id) {
        sendJson(res, 400, { error: "id required" });
        return;
      }
      await sbDelete("purchase_orders", `id=eq.${encode(id)}&business_id=eq.${ctx.businessId}`);
      sendJson(res, 200, { status: "deleted", id });
      return;
    }

    // ------------------------- Integrations -------------------------
    if (pathname === "/v1/integrations/status" && req.method === "GET") {
      const [rows, syncRuns] = await Promise.all([
        sbSelect("integrations", `select=provider,is_enabled,config&business_id=eq.${ctx.businessId}`),
        sbSelect(
          "google_sheets_sync_runs",
          `select=status,sales_rows,expense_rows,customer_rows,error_message,completed_at&business_id=eq.${ctx.businessId}&order=completed_at.desc&limit=1`
        ).catch(() => [])
      ]);
      const whatsapp = rows.find((r) => r.provider === "whatsapp");
      const sheets = rows.find((r) => r.provider === "google_sheets");
      const lastSync = syncRuns[0] || null;
      sendJson(res, 200, {
        whatsapp_status: whatsapp ? (whatsapp.is_enabled ? "Connected" : "Disabled") : "",
        whatsapp_templates: whatsapp && whatsapp.config ? whatsapp.config.templates : null,
        whatsapp_delivery_success: whatsapp && whatsapp.config ? whatsapp.config.delivery_success : "",
        sheet_name: sheets && sheets.config ? sheets.config.workbook : "",
        sheet_schedule: sheets && sheets.config ? sheets.config.schedule : "",
        sheet_last_run: lastSync ? lastSync.completed_at : (sheets && sheets.config ? sheets.config.last_run : ""),
        sheet_sync_status: lastSync ? lastSync.status : "not_run",
        sheet_sync_detail: lastSync
          ? (lastSync.status === "success"
            ? `${lastSync.sales_rows || 0} sales, ${lastSync.expense_rows || 0} expenses, ${lastSync.customer_rows || 0} customers backed up`
            : (lastSync.error_message || "Backup failed"))
          : "No backup run recorded yet",
        webhook_retries: null,
        idempotency_conflicts: null,
        failed_signatures: null
      });
      return;
    }

    if (pathname === "/v1/integrations/google-sheets-sync" && req.method === "POST") {
      // Ad-hoc backup is disabled for tenants: the platform backup is global
      // (all tenants) and runs automatically via cron at 1:00 AM IST.
      sendJson(res, 403, {
        error: "manual_backup_disabled",
        message: "Automatic backup runs daily at 1:00 AM IST. Manual backup is available to platform admins only."
      });
      return;
    }

    if (pathname === "/v1/integrations/whatsapp/events" && req.method === "GET") {
      const rows = await sbSelect(
        "whatsapp_events",
        `select=created_at,event_type,reference_id,status&business_id=eq.${ctx.businessId}&order=created_at.desc&limit=100`
      );
      sendJson(res, 200, {
        events: rows.map((e) => ({ timestamp: e.created_at, type: e.event_type, reference_id: e.reference_id, status: e.status }))
      });
      return;
    }

    if (pathname === "/v1/integrations/whatsapp/send-receipt" && req.method === "POST") {
      const body = await parseBody(req);
      const event = {
        business_id: ctx.businessId,
        store_id: ctx.storeId,
        event_type: "receipt",
        reference_id: body.reference_id || `SALE-${Date.now()}`,
        phone: body.phone || null,
        template_name: body.template || null,
        payload: body.message ? { message: body.message } : null,
        status: "sent"
      };
      await sbInsert("whatsapp_events", [event]);
      sendJson(res, 202, { status: "queued", event: { timestamp: nowIso(), type: "receipt", reference_id: event.reference_id, status: "sent" } });
      return;
    }

    // ------------------------- Business setup / storefront -------------------------
    if (pathname === "/v1/business/setup" && req.method === "GET") {
      const rows = await sbSelect(
        "businesses",
        `select=legal_name,gstin,pan,invoice_prefix&id=eq.${ctx.businessId}&limit=1`
      );
      const b = rows[0] || {};
      const store = (await sbSelect(
        "stores",
        `select=name,address_line,city,state,pincode,phone&id=eq.${ctx.storeId}&limit=1`
      ))[0] || {};
      sendJson(res, 200, {
        business_name: b.legal_name || "",
        gstin: b.gstin || "",
        pan: b.pan || "",
        invoice_prefix: b.invoice_prefix || "",
        store_name: store.name || "",
        store_address: store.address_line || "",
        store_city: store.city || "",
        store_state: store.state || "",
        store_pincode: store.pincode || "",
        store_phone: store.phone || ""
      });
      return;
    }

    // Save editable business + current store details.
    if (pathname === "/v1/business/setup" && req.method === "POST") {
      const body = await parseBody(req);
      const bizPatch = {};
      if (body.business_name !== undefined) bizPatch.legal_name = String(body.business_name || "").trim();
      if (body.gstin !== undefined) bizPatch.gstin = String(body.gstin || "").trim();
      if (body.pan !== undefined) bizPatch.pan = String(body.pan || "").trim();
      if (body.invoice_prefix !== undefined) bizPatch.invoice_prefix = String(body.invoice_prefix || "").trim();
      if (Object.keys(bizPatch).length) {
        await sbUpdate("businesses", `id=eq.${ctx.businessId}`, bizPatch);
      }

      const storePatch = {};
      if (body.store_name !== undefined) storePatch.name = String(body.store_name || "").trim();
      if (body.store_address !== undefined) storePatch.address_line = String(body.store_address || "").trim();
      if (body.store_city !== undefined) storePatch.city = String(body.store_city || "").trim();
      if (body.store_state !== undefined) storePatch.state = String(body.store_state || "").trim();
      if (body.store_pincode !== undefined) storePatch.pincode = String(body.store_pincode || "").trim();
      if (body.store_phone !== undefined) storePatch.phone = String(body.store_phone || "").trim();
      if (Object.keys(storePatch).length) {
        await sbUpdate("stores", `id=eq.${ctx.storeId}`, storePatch);
      }

      sendJson(res, 200, { status: "saved" });
      return;
    }

    if (pathname === "/v1/storefront/placeholder" && req.method === "GET") {
      let onlineCount = 0;
      let pendingCount = 0;
      try {
        const onlineStoreId = await resolveStoreId("store-online", ctx.businessId);
        const online = await sbSelect("inventory_balances", `select=id&store_id=eq.${onlineStoreId}`);
        onlineCount = online.length;
      } catch (_) {
        onlineCount = 0;
      }
      const pending = await sbSelect(
        "orders",
        `select=id&business_id=eq.${ctx.businessId}&channel=eq.online&status=neq.delivered`
      );
      pendingCount = pending.length;
      sendJson(res, 200, {
        notice: "Storefront status computed from live inventory and orders.",
        published_skus: onlineCount,
        pending_orders: pendingCount,
        sync_lag_seconds: 0
      });
      return;
    }

    // ------------------------- Online orders -------------------------
    if (pathname === "/v1/online-orders" && req.method === "GET") {
      const rows = await sbSelect(
        "orders",
        `select=order_no,customer_name,delivery_city,delivery_pincode,total_amount,status,created_at&business_id=eq.${ctx.businessId}&channel=eq.online&order=created_at.desc&limit=100`
      );
      sendJson(res, 200, {
        items: rows.map((order) => ({
          ...order,
          total_amount: Number(order.total_amount || 0),
          status: titleCaseStatus(order.status)
        }))
      });
      return;
    }

    if (pathname === "/v1/online-orders/detail" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const orderNo = (url.searchParams.get("order_no") || "").trim();
      if (!orderNo) {
        sendJson(res, 400, { error: "order_no required" });
        return;
      }
      const order = (await sbSelect(
        "orders",
        `select=id,customer_id,order_no,customer_name,status,total_amount,shipping_amount,tracking_number,courier,created_at,delivery_address,delivery_city,delivery_pincode&business_id=eq.${ctx.businessId}&channel=eq.online&order_no=eq.${encode(orderNo)}&limit=1`
      ))[0];
      if (!order) {
        sendJson(res, 404, { error: "online_order_not_found" });
        return;
      }
      const [items, payments, customer] = await Promise.all([
        sbSelect("order_items", `select=sku,name,quantity,unit_price,line_total&order_id=eq.${order.id}`),
        sbSelect("order_payments", `select=mode,amount&order_id=eq.${order.id}`).catch(() => []),
        order.customer_id ? sbSelect("customers", `select=phone&id=eq.${order.customer_id}&limit=1`).then((rows) => rows[0] || null) : Promise.resolve(null)
      ]);
      sendJson(res, 200, {
        ...order,
        total_amount: Number(order.total_amount || 0),
        shipping_amount: Number(order.shipping_amount || 0),
        tracking_number: order.tracking_number || "",
        courier: order.courier || "",
        status: titleCaseStatus(order.status),
        customer_phone: customer ? customer.phone || "" : "",
        items: items.map((item) => ({ ...item, quantity: Number(item.quantity || 0), unit_price: Number(item.unit_price || 0), line_total: Number(item.line_total || 0) })),
        payments: payments.map((payment) => ({ ...payment, amount: Number(payment.amount || 0) }))
      });
      return;
    }

    if (pathname === "/v1/online-orders/update" && req.method === "POST") {
      const body = await parseBody(req);
      const orderNo = String(body.order_no || "").trim();
      if (!orderNo) {
        sendJson(res, 400, { error: "order_no required" });
        return;
      }
      const order = (await sbSelect(
        "orders",
        `select=id,total_amount,status&business_id=eq.${ctx.businessId}&channel=eq.online&order_no=eq.${encode(orderNo)}&limit=1`
      ))[0];
      if (!order) {
        sendJson(res, 404, { error: "online_order_not_found" });
        return;
      }
      const requestedStatus = String(body.status || order.status).toLowerCase();
      const validStatuses = ["created", "paid", "packed", "shipped", "delivered", "returned"];
      if (!validStatuses.includes(requestedStatus)) {
        sendJson(res, 400, { error: "invalid_status" });
        return;
      }
      const updated = await sbUpdate("orders", `id=eq.${order.id}`, {
        customer_name: String(body.customer_name || "").trim() || undefined,
        delivery_address: String(body.delivery_address || "").trim() || null,
        delivery_city: String(body.delivery_city || "").trim() || null,
        delivery_pincode: String(body.delivery_pincode || "").trim() || null,
        tracking_number: body.tracking_number !== undefined ? (String(body.tracking_number || "").trim() || null) : undefined,
        courier: body.courier !== undefined ? (String(body.courier || "").trim() || null) : undefined,
        status: requestedStatus
      });
      if (requestedStatus === "paid" && order.status !== "paid") {
        await sbInsert("order_payments", [{
          business_id: ctx.businessId,
          order_id: order.id,
          mode: String(body.payment_mode || "online").trim(),
          amount: Number(order.total_amount || 0)
        }]);
      }
      sendJson(res, 200, { item: { ...updated[0], status: titleCaseStatus(updated[0].status) } });
      return;
    }

    // ------------------------- Memberships -------------------------
    if (pathname === "/v1/memberships/config" && req.method === "GET") {
      const settings = await getMembershipSettings(ctx.businessId);
      sendJson(res, 200, {
        ...settings,
        initialReward: Number(settings.exclusive_joining_credit),
        claimPercent: Number(settings.regular_wallet_redemption_percent),
        minPurchase: Number(settings.minimum_eligible_purchase)
      });
      return;
    }

    if (pathname === "/v1/memberships/config" && req.method === "POST") {
      const body = await parseBody(req);
      const current = await getMembershipSettings(ctx.businessId);
      const patch = {
        minimum_eligible_purchase: Number(body.minimum_eligible_purchase ?? body.minPurchase ?? current.minimum_eligible_purchase),
        regular_first_purchase_reward_percent: Number(body.regular_first_purchase_reward_percent ?? current.regular_first_purchase_reward_percent),
        regular_repeat_purchase_reward_percent: Number(body.regular_repeat_purchase_reward_percent ?? current.regular_repeat_purchase_reward_percent),
        exclusive_purchase_reward_percent: Number(body.exclusive_purchase_reward_percent ?? current.exclusive_purchase_reward_percent),
        referral_reward_percent: Number(body.referral_reward_percent ?? current.referral_reward_percent),
        referred_first_purchase_reward_percent: Number(body.referred_first_purchase_reward_percent ?? current.referred_first_purchase_reward_percent),
        regular_wallet_redemption_percent: Number(body.regular_wallet_redemption_percent ?? body.claimPercent ?? current.regular_wallet_redemption_percent),
        regular_wallet_redemption_max: Number(body.regular_wallet_redemption_max ?? current.regular_wallet_redemption_max),
        exclusive_wallet_redemption_max: Number(body.exclusive_wallet_redemption_max ?? current.exclusive_wallet_redemption_max),
        exclusive_membership_fee: Number(body.exclusive_membership_fee ?? current.exclusive_membership_fee),
        exclusive_joining_credit: Number(body.exclusive_joining_credit ?? body.initialReward ?? current.exclusive_joining_credit),
        regular_wallet_expiry_months: Number(body.regular_wallet_expiry_months ?? current.regular_wallet_expiry_months),
        exclusive_wallet_expiry_months: Number(body.exclusive_wallet_expiry_months ?? current.exclusive_wallet_expiry_months),
        referral_gift_threshold: Number(body.referral_gift_threshold ?? current.referral_gift_threshold),
        updated_at: new Date().toISOString()
      };
      const existing = await sbSelect("membership_program_settings", `select=business_id&business_id=eq.${encode(ctx.businessId)}&limit=1`);
      const saved = existing.length
        ? await sbUpdate("membership_program_settings", `business_id=eq.${ctx.businessId}`, patch)
        : await sbInsert("membership_program_settings", [{ business_id: ctx.businessId, ...patch }]);
      sendJson(res, 200, membershipSettingsPayload(saved[0]));
      return;
    }

    if (pathname === "/v1/memberships/customer/lookup" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const phone = String(url.searchParams.get("phone") || "").trim();
      const rows = phone ? await sbSelect("membership_members", `select=*&business_id=eq.${encode(ctx.businessId)}&phone=eq.${encode(phone)}&limit=1`) : [];
      if (!rows.length) {
        sendJson(res, 200, { found: false });
        return;
      }
      const member = rows[0];
      sendJson(res, 200, { found: true, member: { ...member, wallet_balance: Number(member.wallet_balance || 0) } });
      return;
    }

    if (pathname === "/v1/memberships/wallet-history" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const memberId = String(url.searchParams.get("member_id") || "").trim();
      if (!memberId) {
        sendJson(res, 400, { error: "member_id_required" });
        return;
      }
      const memberRows = await sbSelect("membership_members", `select=id&business_id=eq.${encode(ctx.businessId)}&id=eq.${encode(memberId)}&limit=1`);
      if (!memberRows.length) {
        sendJson(res, 404, { error: "member_not_found" });
        return;
      }
      const items = await sbSelect("membership_wallet_transactions", `select=id,order_id,transaction_type,amount,balance_after,created_at&member_id=eq.${encode(memberId)}&order=created_at.desc`);
      sendJson(res, 200, { items: items.map((item) => ({ ...item, amount: Number(item.amount || 0), balance_after: Number(item.balance_after || 0) })) });
      return;
    }

    if (pathname === "/v1/memberships/referral-lookup" && req.method === "GET") {
      const url = new URL(req.url, "http://localhost");
      const code = String(url.searchParams.get("code") || "").trim().toUpperCase();
      const rows = code ? await sbSelect("membership_members", `select=id,name,phone,referral_code&business_id=eq.${encode(ctx.businessId)}&referral_code=eq.${encode(code)}&limit=1`) : [];
      sendJson(res, 200, rows.length ? { found: true, member: rows[0] } : { found: false });
      return;
    }

    if (pathname === "/v1/memberships/customer/enroll" && req.method === "POST") {
      const body = await parseBody(req);
      const phone = String(body.phone || "").trim();
      const name = String(body.name || "").trim();
      const tier = body.tier === "exclusive" ? "exclusive" : "regular";
      if (!phone || !name) {
        sendJson(res, 400, { error: "name_and_phone_required" });
        return;
      }
      const duplicate = await sbSelect("membership_members", `select=id&business_id=eq.${encode(ctx.businessId)}&phone=eq.${encode(phone)}&limit=1`);
      if (duplicate.length) {
        sendJson(res, 409, { error: "member_already_exists" });
        return;
      }
      const settings = await getMembershipSettings(ctx.businessId);
      const referralCode = String(body.referral_code || "").trim().toUpperCase();
      const referrer = referralCode ? (await sbSelect("membership_members", `select=*&business_id=eq.${encode(ctx.businessId)}&referral_code=eq.${encode(referralCode)}&limit=1`))[0] : null;
      if (referralCode && !referrer) {
        sendJson(res, 400, { error: "invalid_referral_code" });
        return;
      }
      const customers = await sbSelect("customers", `select=id&business_id=eq.${encode(ctx.businessId)}&phone=eq.${encode(phone)}&limit=1`).catch(() => []);
      const member = (await sbInsert("membership_members", [{
        business_id: ctx.businessId,
        customer_id: customers[0] ? customers[0].id : null,
        phone,
        name,
        tier,
        referral_code: await makeUniqueReferralCode(ctx.businessId, phone),
        referred_by_member_id: referrer ? referrer.id : null,
        wallet_balance: 0,
        wallet_expires_at: null
      }]))[0];
      if (referrer) {
        await sbInsert("membership_referrals", [{ business_id: ctx.businessId, referrer_member_id: referrer.id, referred_member_id: member.id }]);
      }
      let enrolledMember = member;
      if (tier === "exclusive") {
        enrolledMember = await applyWalletTransaction({ businessId: ctx.businessId, member, type: "exclusive_joining_credit", amount: settings.exclusive_joining_credit, settings });
      }
      sendJson(res, 201, { member: enrolledMember, exclusive_membership_fee: tier === "exclusive" ? Number(settings.exclusive_membership_fee) : 0 });
      return;
    }

    if (pathname === "/v1/memberships/all" && req.method === "GET") {
      const rows = await sbSelect("membership_members", `select=id,name,phone,tier,wallet_balance,wallet_expires_at,referral_code,successful_referral_count,referral_gift_pending&business_id=eq.${encode(ctx.businessId)}&order=joined_at.desc`);
      sendJson(res, 200, { items: rows.map((member) => ({ ...member, wallet_balance: Number(member.wallet_balance || 0), rewardPoints: Number(member.wallet_balance || 0) })) });
      return;
    }

    // ------------------------- POS sale -------------------------
    if (pathname === "/v1/pos/sales" && req.method === "POST") {
      const body = await parseBody(req);
      const actor = await resolveActor(req);
      const channel = body.channel === "online" ? "online" : "in_store";
      const totals = body.totals || {};
      const items = Array.isArray(body.items) ? body.items : [];
      const orderNo = `${channel === "online" ? "ONLINE" : "SALE"}-${Date.now()}`;

      // Resolve or create the customer from phone/name when provided.
      let customerId = null;
      const custName = (body.customer && body.customer.name) || "Walk-in";
      const custPhone = body.customer && body.customer.phone ? String(body.customer.phone).trim() : "";
      const custPlace = body.customer && body.customer.place ? String(body.customer.place).trim() : "";
      const custAddress = body.customer && body.customer.address ? String(body.customer.address).trim() : "";
      const custCity = body.customer && body.customer.city ? String(body.customer.city).trim() : "";
      const custPincode = body.customer && body.customer.pincode ? String(body.customer.pincode).trim() : "";
      const markPaid = body.status !== "created";
      if (custPhone) {
        const existing = await sbSelect(
          "customers",
          `select=id&business_id=eq.${ctx.businessId}&phone=eq.${encode(custPhone)}&limit=1`
        ).catch(() => []);
        if (existing.length) {
          customerId = existing[0].id;
          await sbUpdate("customers", `id=eq.${existing[0].id}`, {
            name: custName,
            segment: custPlace,
            full_address: custAddress || null,
            city: custCity || null,
            pincode: custPincode || null
          }).catch(() => {});
        } else {
          const created = await sbInsert("customers", [
            {
              business_id: ctx.businessId,
              customer_code: `C-${Date.now()}`,
              name: custName,
              phone: custPhone,
              segment: custPlace,
              full_address: custAddress || null,
              city: custCity || null,
              pincode: custPincode || null,
              is_active: true
            }
          ]).catch(() => []);
          customerId = created[0] ? created[0].id : null;
        }
      }

      const membershipSettings = await getMembershipSettings(ctx.businessId);
      let member = custPhone
        ? (await sbSelect("membership_members", `select=*&business_id=eq.${encode(ctx.businessId)}&phone=eq.${encode(custPhone)}&limit=1`).catch(() => []))[0]
        : null;
      if (!member && custPhone && markPaid) {
        const referralCode = String(body.customer && body.customer.referral_code || "").trim().toUpperCase();
        const referrer = referralCode
          ? (await sbSelect("membership_members", `select=*&business_id=eq.${encode(ctx.businessId)}&referral_code=eq.${encode(referralCode)}&limit=1`))[0]
          : null;
        member = (await sbInsert("membership_members", [{
          business_id: ctx.businessId,
          customer_id: customerId,
          phone: custPhone,
          name: custName,
          tier: "regular",
          referral_code: await makeUniqueReferralCode(ctx.businessId, custPhone),
          referred_by_member_id: referrer ? referrer.id : null,
          wallet_balance: 0,
          wallet_expires_at: null
        }]))[0];
        if (referrer) {
          await sbInsert("membership_referrals", [{ business_id: ctx.businessId, referrer_member_id: referrer.id, referred_member_id: member.id }]);
        }
      }
      const manualDiscount = roundMoney(Number(body.manual_discount_amount || totals.discount_amount || 0));
      const baseBeforePromo = roundMoney(Number(totals.subtotal || 0) + Number(totals.tax_amount || 0) - manualDiscount);
      let promoDiscount = 0;
      let appliedPromoCode = null;
      if (body.promo_code && markPaid) {
        const promoResult = await validatePromoCode(ctx.businessId, body.promo_code, baseBeforePromo);
        if (promoResult.valid) {
          promoDiscount = promoResult.discount;
          appliedPromoCode = promoResult.promo.code;
          await sbUpdate("promo_codes", `id=eq.${promoResult.promo.id}&business_id=eq.${ctx.businessId}`, {
            used_count: Number(promoResult.promo.used_count || 0) + 1
          }).catch(() => {});
        }
      }
      const preMembershipTotal = roundMoney(baseBeforePromo - promoDiscount);
      const isEligiblePurchase = markPaid && preMembershipTotal > 0;
      const walletExpired = member && member.wallet_expires_at && new Date(member.wallet_expires_at) <= new Date();
      const availableWallet = member && !walletExpired ? Number(member.wallet_balance || 0) : 0;
      const requestedRedemption = Boolean(body.use_membership_discount) && member && isEligiblePurchase;
      const membershipDiscount = requestedRedemption
        ? roundMoney(Math.min(availableWallet * Number(membershipSettings.regular_wallet_redemption_percent) / 100, preMembershipTotal))
        : 0;
      const shippingAmount = roundMoney(Number((totals && totals.shipping_amount) || body.shipping_amount || 0));
      const merchandiseTotal = roundMoney(preMembershipTotal - membershipDiscount);
      const finalTotal = roundMoney(merchandiseTotal + shippingAmount);
      const totalDiscount = roundMoney(manualDiscount + promoDiscount + membershipDiscount);

      const insertedOrder = await sbInsert("orders", [
        {
          business_id: ctx.businessId,
          store_id: ctx.storeId,
          order_no: orderNo,
          channel,
          customer_id: customerId,
          customer_name: custName,
          delivery_address: custAddress || null,
          delivery_city: custCity || null,
          delivery_pincode: custPincode || null,
          status: markPaid ? "paid" : "created",
          subtotal: Number(totals.subtotal || 0),
          tax_amount: Number(totals.tax_amount || 0),
          cgst_amount: Number(totals.cgst_amount || 0),
          sgst_amount: Number(totals.sgst_amount || 0),
          prices_include_gst: Boolean(totals.prices_include_gst),
          discount_amount: totalDiscount,
          manual_discount_amount: manualDiscount,
          promo_code: appliedPromoCode,
          promo_discount_amount: promoDiscount,
          total_amount: finalTotal,
          shipping_amount: shippingAmount,
          wallet_balance_after: 0,
          sold_by_user_id: actor ? actor.id : null,
          sold_by_name: actor ? (actor.name || actor.email) : null
        }
      ]);
      const orderId = insertedOrder[0].id;

      let updatedMember = member;
      let walletReward = 0;
      let referralReward = 0;
      if (member && walletExpired && Number(member.wallet_balance || 0) > 0) {
        updatedMember = await applyWalletTransaction({ businessId: ctx.businessId, member, orderId, type: "expiry_adjustment", amount: -Number(member.wallet_balance), settings: membershipSettings });
      }
      if (member && membershipDiscount > 0) {
        updatedMember = await applyWalletTransaction({ businessId: ctx.businessId, member: updatedMember, orderId, type: "wallet_redemption", amount: -membershipDiscount, settings: membershipSettings });
      }
      if (member && isEligiblePurchase) {
        const isFirstEligiblePurchase = Number(member.eligible_purchase_count || 0) === 0;
        const rewardRate = isFirstEligiblePurchase
          ? Number(membershipSettings.regular_first_purchase_reward_percent)
          : Number(membershipSettings.regular_repeat_purchase_reward_percent);
        walletReward = roundMoney(merchandiseTotal * rewardRate / 100);
        updatedMember = await applyWalletTransaction({ businessId: ctx.businessId, member: updatedMember, orderId, type: "purchase_reward", amount: walletReward, settings: membershipSettings });
        updatedMember = (await sbUpdate("membership_members", `id=eq.${member.id}`, {
          eligible_purchase_count: Number(member.eligible_purchase_count || 0) + 1
        }))[0] || updatedMember;

        if (isFirstEligiblePurchase && member.referred_by_member_id) {
          const referral = (await sbSelect("membership_referrals", `select=*&referred_member_id=eq.${member.id}&status=eq.pending&limit=1`))[0];
          const referrer = referral && (await sbSelect("membership_members", `select=*&id=eq.${referral.referrer_member_id}&limit=1`))[0];
          if (referrer) {
            referralReward = roundMoney(merchandiseTotal * Number(membershipSettings.referral_reward_percent) / 100);
            await applyWalletTransaction({ businessId: ctx.businessId, member: referrer, orderId, type: "referral_reward", amount: referralReward, settings: membershipSettings });
            await sbUpdate("membership_referrals", `id=eq.${referral.id}`, { status: "successful", successful_order_id: orderId, completed_at: new Date().toISOString() });
          }
        }

      }
      if (updatedMember) {
        await sbUpdate("orders", `id=eq.${orderId}`, { wallet_balance_after: Number(updatedMember.wallet_balance || 0) });
      }

      for (const line of items) {
        let productId = null;
        const prod = await sbSelect("products", `select=id&sku=eq.${encode(line.sku)}&business_id=eq.${ctx.businessId}&limit=1`).catch(() => []);
        if (prod.length) {
          productId = prod[0].id;
        }
        await sbInsert("order_items", [
          {
            business_id: ctx.businessId,
            order_id: orderId,
            product_id: productId,
            sku: line.sku,
            name: line.name,
            quantity: Number(line.quantity || 0),
            unit_price: Number(line.unit_price || 0),
            line_total: Number(line.line_total || 0),
            tax_percent: Number(line.tax_percent || 0),
            taxable_amount: Number(line.taxable_amount || 0),
            cgst_amount: Number(line.cgst_amount || 0),
            sgst_amount: Number(line.sgst_amount || 0),
            price_includes_gst: Boolean(line.price_includes_gst)
          }
        ]);

        if (productId) {
          const bal = await sbSelect(
            "inventory_balances",
            `select=id,qty_on_hand&store_id=eq.${ctx.storeId}&product_id=eq.${productId}&limit=1`
          );
          if (bal.length) {
            await sbUpdate("inventory_balances", `id=eq.${bal[0].id}`, {
              qty_on_hand: Math.max(0, Number(bal[0].qty_on_hand || 0) - Number(line.quantity || 0))
            });
          }
          await sbInsert("inventory_ledger", [
            {
              business_id: ctx.businessId,
              store_id: ctx.storeId,
              product_id: productId,
              direction: "out",
              qty: Number(line.quantity || 0),
              source: channel === "online" ? "online_order" : "sale",
              reference_type: "order",
              reference_id: orderNo
            }
          ]);
        }
      }

      const payments = markPaid && Array.isArray(body.payments) ? body.payments : [];
      for (const pay of payments) {
        await sbInsert("order_payments", [
          { business_id: ctx.businessId, order_id: orderId, mode: pay.mode, amount: finalTotal }
        ]);
      }

      await sbInsert("whatsapp_events", [
        {
          business_id: ctx.businessId,
          store_id: ctx.storeId,
          event_type: "order_confirmation",
          reference_id: orderNo,
          phone: custPhone || null,
          status: "sent"
        }
      ]);

      sendJson(res, 201, {
        sale_id: orderNo,
        status: markPaid ? "paid" : "created",
        membership_discount: membershipDiscount,
        promo_discount: promoDiscount,
        promo_code: appliedPromoCode,
        wallet_reward: walletReward,
        referral_reward: referralReward,
        reward_balance: updatedMember ? Number(updatedMember.wallet_balance || 0) : 0,
        referral_code: (updatedMember || member) ? (updatedMember || member).referral_code : null,
        total_amount: finalTotal
      });
      return;
    }

    sendJson(res, 404, { error: "not_found", path: pathname });
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    if (message === "supabase_not_configured") {
      sendJson(res, 503, { error: "database_not_configured", message: "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." });
      return;
    }
    if (message.startsWith("business_not_found") || message.startsWith("store_not_found")) {
      sendJson(res, 400, { error: "context_not_found", message });
      return;
    }
    if (message === "business_inactive") {
      sendJson(res, 403, { error: "business_inactive", message: "Account is Deactivated, please contact admin" });
      return;
    }
    sendJson(res, 500, { error: "server_error", message });
  }
};
