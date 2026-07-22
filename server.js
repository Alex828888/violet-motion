/**
 * VIOLET MOTION — SERVER v2
 * node server.js
 *
 * .env: PORT, TG_TOKEN, TG_CHAT_ID, API_KEY, DATA_DIR, GEMINI_API_KEY, GEMINI_MODEL,
 *       SUPPORT_AI_ENABLED, ZVONOK_API_KEY, ZVONOK_CAMPAIGN_ID, ZVONOK_WEBHOOK_SECRET
 *
 * New in v2:
 *  • POST /api/analytics  — receive batched client events
 *  • GET  /api/analytics/summary — aggregated stats (authBot)
 *  • SSE pending-message queue — client never loses operator replies
 */

require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');
const crypto  = require('crypto');
const novaPoshta = require('./nova-poshta');
const monobank = require('./monobank');
const { createCrmIntegration } = require('./crm-integration');
const { changedNpFields, mergeNovaPoshtaOrders } = require('./np-order-merge');

const app        = express();
const PORT       = process.env.PORT       || 3000;
const TG_TOKEN   = process.env.TG_TOKEN   || process.env.BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const ZAPUSK_TG_TOKEN = process.env.ZAPUSK_TG_TOKEN || '';
const ZAPUSK_TG_CHAT_ID = process.env.ZAPUSK_TG_CHAT_ID || '';
const TG_EXTRA_ADMIN_IDS = '7996143460';
const TG_ADMIN_IDS = [process.env.ADMIN_IDS, TG_EXTRA_ADMIN_IDS].filter(Boolean).join(',');
const API_KEY    = String(process.env.API_KEY || '').trim();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const SUPPORT_AI_ENABLED = process.env.SUPPORT_AI_ENABLED !== 'false';
const SUPPORT_AI_MAX_PER_SESSION = Math.max(1, Number(process.env.SUPPORT_AI_MAX_PER_SESSION || 8));
const SUPPORT_AI_IDLE_MINUTES = Math.max(2, Number(process.env.SUPPORT_AI_IDLE_MINUTES || 10));
const ZVONOK_API_KEY = process.env.ZVONOK_API_KEY || '';
const ZVONOK_CAMPAIGN_ID = process.env.ZVONOK_CAMPAIGN_ID || '';
const ZVONOK_WEBHOOK_SECRET = process.env.ZVONOK_WEBHOOK_SECRET || '';
const MONOBANK_WEBHOOK_SECRET = process.env.MONOBANK_WEBHOOK_SECRET || '';
// Card statement data is intentionally excluded from CRM by default.
// Final money/return facts are confirmed manually by TTN against Nova Poshta tracking.
const MONOBANK_CRM_ENABLED = process.env.MONOBANK_CRM_ENABLED === 'true';
// Arbitrator (traffic manager) payout panel: fixed amount accrued per confirmed order,
// counted from the moment the feature was turned on, independent of what happens to the
// order afterwards (shipped/not shipped). Cleared to zero only when a payout is marked as received.
const ARBITRATOR_RATE = Number(process.env.ARBITRATOR_RATE || 120);
const APP_PUBLIC_URL = String(process.env.APP_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
const ZVONOK_CALL_URL = 'https://zvonok.com/manager/cabapi_external/api/v1/phones/call/';
const SHOP_NAME = process.env.SHOP_NAME || 'Violet Motion';
const PRODUCT_NAME = process.env.PRODUCT_NAME || 'Violet Motion sneakers';
const PRODUCT_DESCRIPTION = process.env.PRODUCT_DESCRIPTION || 'women\'s sneakers, soft violet edition, white / light-violet style';
const PRODUCT_UPPER = process.env.PRODUCT_UPPER || 'eco-leather plus breathable mesh';
const PRODUCT_SOLE = process.env.PRODUCT_SOLE || 'light, cushioned, comfortable for walking';
const PRODUCT_BEST_FOR = process.env.PRODUCT_BEST_FOR || 'daily wear, city walks, travel, spring, summer, and warm autumn';
const PRODUCT_PRICE = process.env.PRODUCT_PRICE || '895';
const PRODUCT_OLD_PRICE = process.env.PRODUCT_OLD_PRICE || '1899';
const META_PIXEL_ID = process.env.META_PIXEL_ID || '2110562173060470';
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN || '';
const META_TEST_EVENT_CODE = process.env.META_TEST_EVENT_CODE || '';
const TG_REQUEST_TIMEOUT_MS = Math.max(1000, Number(process.env.TG_REQUEST_TIMEOUT_MS || 10000));
const npCreateLocks = new Map();
const npSyncState = {
  current: null,
  queued: null,
  last: null,
  timer: null,
  nextJobId: 1,
};

app.set('trust proxy', 1);

/* ── Data files ────────────────────────────────────────────── */
const ROOT = __dirname;
const PUBLIC_ROOT = path.resolve(ROOT, process.env.LANDING_DIR || '.');
const DEFAULT_DATA = path.join(ROOT, 'data');
const DATA = path.resolve(process.env.DATA_DIR || DEFAULT_DATA);
const F = {
  orders:    path.join(DATA, 'orders.json'),
  reviews:   path.join(DATA, 'reviews.json'),
  support:   path.join(DATA, 'support.json'),
  analytics: path.join(DATA, 'analytics.json'),
  finance:   path.join(DATA, 'finance.json'),
  crmProducts: path.join(DATA, 'crm-products.json'),
  orderNotify: path.join(DATA, 'order-notify.json'),
  npAfterpayments: path.join(DATA, 'np-afterpayments.json'),
  financeSettings: path.join(DATA, 'finance-settings.json'),
  arbitrator: path.join(DATA, 'arbitrator.json'),
  crmSync: path.join(DATA, 'crm-sync.json'),
};

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
for (const [name, file] of Object.entries(F)) {
  if (fs.existsSync(file)) continue;
  const bundledFile = path.join(DEFAULT_DATA, path.basename(file));
  if (DATA !== DEFAULT_DATA && fs.existsSync(bundledFile)) {
    fs.copyFileSync(bundledFile, file);
  } else {
    fs.writeFileSync(file, '[]', 'utf8');
  }
}
console.log(`💾 Data directory: ${DATA}`);

function read(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.error(`[data] failed to read ${path.basename(file)}: ${error.code || error.message}`);
    throw error;
  }
}
function write(file, data) {
  const tmp = `${file}.tmp`;
  const raw = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, raw, 'utf8');
  fs.renameSync(tmp, file);
}
let crmIntegration = null;
function writeOrders(data, options = {}) {
  const previous = read(F.orders);
  write(F.orders, data);
  if (crmIntegration) crmIntegration.onOrdersChanged(previous, data, options);
}
function nextId(arr) {
  return arr.length ? Math.max(...arr.map(x => x.id || 0)) + 1 : 1;
}

// Serialize public order creation/upgrades inside one Node process. Render is
// configured with WEB_CONCURRENCY=1; this also prevents fetch + sendBeacon from
// racing each other in that process.
let orderMutationTail = Promise.resolve();
async function withOrderMutationLock(task) {
  const previous = orderMutationTail;
  let release;
  orderMutationTail = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await task(); }
  finally { release(); }
}

async function persistNovaPoshtaOrderChanges(baseOrders = [], computedOrders = []) {
  const baseById = new Map(baseOrders.map(order => [String(order.id), order]));
  const changes = computedOrders.flatMap(computed => {
    const base = baseById.get(String(computed?.id ?? ''));
    return base && changedNpFields(base, computed).length ? [{ base, computed }] : [];
  });
  if (!changes.length) {
    const latest = read(F.orders);
    return {
      changed: 0,
      conflicts: [],
      missingIds: [],
      ordersById: new Map(latest.map(order => [String(order.id), order])),
    };
  }

  return withOrderMutationLock(async () => {
    const latest = read(F.orders);
    const merged = mergeNovaPoshtaOrders(latest, changes);
    if (merged.changedOrderIds.length) writeOrders(merged.orders);
    return {
      changed: merged.changedOrderIds.length,
      conflicts: merged.conflicts,
      missingIds: merged.missingIds,
      ordersById: new Map(merged.orders.map(order => [String(order.id), order])),
    };
  });
}

function normalizeOrderPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 10 && digits.startsWith('0')) digits = `38${digits}`;
  if (digits.length === 11 && digits.startsWith('80')) digits = `3${digits}`;
  return digits;
}

function normalizeOrderPart(value) {
  return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function orderDedupeFingerprint(order = {}) {
  return [
    normalizeOrderPhone(order.phone),
    normalizeOrderPart(order.product || PRODUCT_NAME),
    normalizeOrderPart(order.variant || order.productVariant || ''),
    normalizeOrderPart(order.size),
    normalizeOrderPart(order.color),
    String(Math.max(1, Number(order.quantity) || 1)),
  ].join('|');
}

function isActiveNewOrder(order) {
  return (order?.status || 'new') === 'new';
}
const DEFAULT_FINANCE_START_AT = '2026-05-25T21:00:00.000Z';
const DEFAULT_FINANCE_RESET_KEY = 'finance-reset-2026-05-26';
function readFinanceSettings() {
  const stored = read(F.financeSettings);
  const settings = stored && !Array.isArray(stored) && typeof stored === 'object' ? stored : {};
  return {
    startAt: process.env.FINANCE_START_AT || settings.startAt || DEFAULT_FINANCE_START_AT,
    timezone: settings.timezone || 'Europe/Kyiv',
    resetLabel: settings.resetLabel || '26.05.2026',
    resetKey: settings.resetKey || DEFAULT_FINANCE_RESET_KEY,
    appliedResetKey: settings.appliedResetKey || null,
    resetAppliedAt: settings.resetAppliedAt || null,
  };
}
function financeStartAt() {
  return readFinanceSettings().startAt;
}
function isOnOrAfterFinanceStart(value) {
  const time = new Date(value || 0).getTime();
  const start = new Date(financeStartAt()).getTime();
  return Number.isFinite(time) && time >= start;
}
function inFinancePeriod(value, period) {
  return isOnOrAfterFinanceStart(value) && inPeriod(value, period);
}
function applyPendingFinanceReset() {
  const settings = readFinanceSettings();
  if (!settings.resetKey || settings.appliedResetKey === settings.resetKey) return;
  write(F.finance, []);
  write(F.npAfterpayments, []);
  write(F.financeSettings, {
    ...settings,
    appliedResetKey: settings.resetKey,
    resetAppliedAt: new Date().toISOString(),
  });
  console.log(`[finance] reset applied: ${settings.resetKey}; orders were preserved`);
}
applyPendingFinanceReset();

/* ── Arbitrator payout panel ──────────────────────────────── */
// Persisted once: the exact moment counting starts. Never moves on redeploys.
function ensureArbitratorSettings() {
  const stored = read(F.arbitrator);
  const settings = stored && !Array.isArray(stored) && typeof stored === 'object' ? stored : {};
  let changed = false;
  if (!settings.startAt) { settings.startAt = new Date().toISOString(); changed = true; }
  if (!Number.isFinite(Number(settings.rate)) || Number(settings.rate) <= 0) { settings.rate = ARBITRATOR_RATE; changed = true; }
  if (!Array.isArray(settings.payouts)) { settings.payouts = []; changed = true; }
  if (!Object.prototype.hasOwnProperty.call(settings, 'lastPayoutAt')) { settings.lastPayoutAt = null; changed = true; }
  if (changed) write(F.arbitrator, settings);
  return settings;
}
function orderCountsForArbitrator(order, sinceMs) {
  const confirmedAt = orderConfirmationAt(order);
  return confirmedAt > 0 && confirmedAt >= sinceMs;
}
function arbitratorSummary() {
  const settings = ensureArbitratorSettings();
  const rate = Number(settings.rate) || ARBITRATOR_RATE;
  const startMs = timestampMs(settings.startAt) || 0;
  const lastPayoutMs = settings.lastPayoutAt ? timestampMs(settings.lastPayoutAt) : 0;
  const cutoffMs = Math.max(startMs, lastPayoutMs);
  const orders = read(F.orders);
  const allAccrued = orders.filter(o => orderCountsForArbitrator(o, startMs));
  const owedOrders = orders.filter(o => orderCountsForArbitrator(o, cutoffMs));
  const totalPaidAmount = (settings.payouts || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
  return {
    rate,
    startAt: settings.startAt,
    lastPayoutAt: settings.lastPayoutAt,
    owedOrdersCount: owedOrders.length,
    owedAmount: owedOrders.length * rate,
    totalOrdersAllTime: allAccrued.length,
    totalEarnedAllTime: allAccrued.length * rate,
    totalPaidAmount,
    history: (settings.payouts || []).slice(-20).reverse(),
  };
}
function recordArbitratorPayout() {
  const settings = ensureArbitratorSettings();
  const summary = arbitratorSummary();
  if (!summary.owedOrdersCount) return { ...summary, alreadyPaid: true };
  const now = new Date().toISOString();
  settings.payouts = Array.isArray(settings.payouts) ? settings.payouts : [];
  settings.payouts.push({ at: now, amount: summary.owedAmount, orders: summary.owedOrdersCount });
  settings.lastPayoutAt = now;
  write(F.arbitrator, settings);
  return { ...arbitratorSummary(), alreadyPaid: false };
}
ensureArbitratorSettings();
function mergeLegacyFileIfDataEmpty(key) {
  const current = read(F[key]);
  const legacyFile = path.join(ROOT, `${key}.json`);
  if (current.length || !fs.existsSync(legacyFile)) return;
  const legacy = read(legacyFile);
  if (!Array.isArray(legacy) || !legacy.length) return;
  write(F[key], legacy);
  console.log(`[data] migrated ${legacy.length} legacy ${key} records into ${F[key]}`);
}
['orders', 'reviews', 'support'].forEach(mergeLegacyFileIfDataEmpty);

/* ── Rate limiter ──────────────────────────────────────────── */
const rateLimits = new Map();
let nextRateLimitScope = 1;
function rateLimit(windowMs, max) {
  const scope = nextRateLimitScope++;
  return (req, res, next) => {
    const key  = `${scope}:${req.ip || 'unknown'}`;
    const now  = Date.now();
    const data = rateLimits.get(key) || { count: 0, start: now };
    if (now - data.start > windowMs) { data.count = 0; data.start = now; }
    data.count++;
    rateLimits.set(key, data);
    if (data.count > max) return res.status(429).json({ error: 'Too many requests' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimits.entries())
    if (now - v.start > 10 * 60 * 1000) rateLimits.delete(k);
}, 10 * 60 * 1000).unref?.();

/* ── Telegram ──────────────────────────────────────────────── */
async function tg(text, extra = {}) {
  if (!TG_TOKEN) return null;
  const chatIds = [...new Set((TG_CHAT_ID || TG_ADMIN_IDS)
    .split(/[,\s;]+/)
    .map(x => x.trim())
    .filter(Boolean))];
  if (!chatIds.length) return null;
  const results = await Promise.all(chatIds.map(chatId => tgTo(chatId, text, extra)));
  if (results.length === 1) return results[0];
  return { ok: results.some(r => r?.ok), result: results };
}

async function telegramPost(token, method, body, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TG_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) console.error(`[${label}] HTTP ${response.status}`);
    return data;
  } catch (error) {
    console.error(`[${label}]`, error.name === 'AbortError' ? 'timeout' : error.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function tgTo(chatId, text, extra = {}) {
  if (!TG_TOKEN || !chatId) return null;
  return telegramPost(TG_TOKEN, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra }, 'TG');
}

async function sendZapuskTelegram(text) {
  if (!ZAPUSK_TG_TOKEN || !ZAPUSK_TG_CHAT_ID) return { ok: false, missingConfig: true };
  return (await telegramPost(ZAPUSK_TG_TOKEN, 'sendMessage', {
    chat_id: ZAPUSK_TG_CHAT_ID,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }, 'ZAPUSK TG')) || { ok: false };
}

async function tgEdit(chatId, messageId, text, extra = {}) {
  if (!TG_TOKEN || !chatId || !messageId) return null;
  return telegramPost(TG_TOKEN, 'editMessageText', {
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', ...extra,
  }, 'TG edit');
}

/* ══════════════════════════════════════════════════════════════
   SSE SESSIONS + PENDING MESSAGE QUEUE
   Fix: When operator replies but client SSE is disconnected,
   messages are queued. On reconnect they're flushed immediately.
══════════════════════════════════════════════════════════════ */
const sessions        = Object.create(null);  // sessionId → { res, accepted, managerId }
const pendingMessages = Object.create(null);  // sessionId → [event objects]
const MAX_QUEUE       = 50;
const SUPPORT_SESSION_TTL_MS = Math.max(60 * 60 * 1000, Number(process.env.SUPPORT_SESSION_TTL_MS || 24 * 60 * 60 * 1000));

function getSession(id) {
  const key = supportSessionKey(id);
  if (!key) return null;
  if (!sessions[key]) sessions[key] = { res: null, accepted: false, managerId: null, lastActivityAt: Date.now() };
  sessions[key].lastActivityAt = Date.now();
  return sessions[key];
}

/** Write to SSE stream. If disconnected, queue the message. */
function sseWrite(sessionId, data) {
  const key = supportSessionKey(sessionId);
  const s = getSession(key);
  if (!s) return false;
  if (s?.res) {
    try {
      s.res.write(`data: ${JSON.stringify(data)}\n\n`);
      return;
    } catch {}
  }
  // Connection not available — queue
  if (!pendingMessages[key]) pendingMessages[key] = [];
  pendingMessages[key].push(data);
  if (pendingMessages[key].length > MAX_QUEUE)
    pendingMessages[key].shift();
  return true;
}

/** Flush queued messages to a newly connected SSE client. */
function flushQueue(sessionId) {
  const key = supportSessionKey(sessionId);
  if (!key) return;
  const msgs = pendingMessages[key];
  if (!msgs || !msgs.length) return;
  const s = sessions[key];
  if (!s?.res) return;
  msgs.forEach(data => {
    try { s.res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  });
  pendingMessages[key] = [];
}

setInterval(() => {
  const cutoff = Date.now() - SUPPORT_SESSION_TTL_MS;
  for (const id of new Set([...Object.keys(sessions), ...Object.keys(pendingMessages)])) {
    const session = sessions[id];
    if (session?.res || Number(session?.lastActivityAt || 0) > cutoff) continue;
    delete sessions[id];
    delete pendingMessages[id];
    delete supportAiHistory[id];
    delete supportAiUsage[id];
  }
}, 10 * 60 * 1000).unref?.();

/* ── Middleware ────────────────────────────────────────────── */
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

/* ── Static files ──────────────────────────────────────────── */
app.get('/style.css',  (_req, res) => { res.type('text/css'); res.sendFile(path.join(PUBLIC_ROOT, 'style.css')); });
app.get('/script.js',  (_req, res) => { res.type('application/javascript'); res.sendFile(path.join(PUBLIC_ROOT, 'script.js')); });
app.get('/favicon.ico', (_req, res) => res.status(204).end());

const publicStaticOptions = {
  dotfiles: 'deny',
  extensions: false,
  fallthrough: true,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.css')  res.setHeader('Content-Type', 'text/css; charset=utf-8');
    if (ext === '.js')   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (ext === '.json') res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (ext === '.html') res.setHeader('Content-Type', 'text/html; charset=utf-8');
  },
};
const rootPublicAssets = [
  'main.jpg', 'side.jpg', 'back.jpg', 'top.jpg', 'shoes-poster.jpg', 'shoes-video-optimized.mp4',
];
app.get(rootPublicAssets.map(file => `/${file}`), (req, res) => {
  res.sendFile(path.join(PUBLIC_ROOT, path.basename(req.path)));
});
app.use('/images', express.static(path.join(PUBLIC_ROOT, 'images'), publicStaticOptions));
app.use('/media', express.static(path.join(PUBLIC_ROOT, 'media'), publicStaticOptions));

/* ── Auth ──────────────────────────────────────────────────── */
function authBot(req, res, next) {
  if (!API_KEY) return res.status(503).json({ error: 'Admin API is not configured' });
  if (!secretEqual(req.headers['x-api-key'], API_KEY)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function secretEqual(supplied, expected) {
  const left = Buffer.from(String(supplied || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

crmIntegration = createCrmIntegration({
  app,
  stateFile: F.crmSync,
  readOrders: () => read(F.orders),
  persistOrders: writeOrders,
  adminAuth: authBot,
  onOrderStatusChanged: order => updateOrderQueueNotice(order),
});

function sanitizeStr(val, max = 200) { return String(val || '').trim().slice(0, max); }
function sha256Meta(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw ? crypto.createHash('sha256').update(raw).digest('hex') : '';
}
function normalizeMetaPhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('380')) return digits;
  if (digits.startsWith('38')) return digits;
  if (digits.startsWith('0')) return `38${digits}`;
  return digits;
}
function splitMetaName(value) {
  const parts = String(value || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return { fn: parts[0] || '', ln: parts.length > 1 ? parts.slice(1).join(' ') : '' };
}
function metaContentId(order) {
  const product = String(order?.product || PRODUCT_NAME || '').toLowerCase();
  if (product.includes('voltgo') || product.includes('powerbank') || product.includes('павербанк')) return 'voltgo-powerbank-10000-001';
  if (product.includes('black breeze') || product.includes('sandal')) return 'black-breeze-sandals-001';
  return 'violet-motion-001';
}
function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || '';
}
function buildMetaUserData(order, req, meta = {}) {
  const match = meta && typeof meta.metaMatch === 'object' ? meta.metaMatch : {};
  const nameParts = splitMetaName(order.fullName || order.name || `${match.fn || ''} ${match.ln || ''}`);
  const phone = normalizeMetaPhone(order.phone || match.ph);
  const email = String(order.email || match.em || '').trim().toLowerCase();
  const city = String(order.city || match.ct || '').trim().toLowerCase();
  const userData = {
    client_ip_address: clientIp(req),
    client_user_agent: String(req.headers['user-agent'] || ''),
    country: [sha256Meta('ua')],
  };
  if (phone) userData.ph = [sha256Meta(phone)];
  if (email) userData.em = [sha256Meta(email)];
  if (nameParts.fn) userData.fn = [sha256Meta(nameParts.fn)];
  if (nameParts.ln) userData.ln = [sha256Meta(nameParts.ln)];
  if (city) userData.ct = [sha256Meta(city)];
  if (phone || email || match.external_id) userData.external_id = [sha256Meta(phone || email || match.external_id)];
  if (meta.fbp) userData.fbp = String(meta.fbp);
  if (meta.fbc) userData.fbc = String(meta.fbc);
  return Object.fromEntries(Object.entries(userData).filter(([, value]) => {
    if (Array.isArray(value)) return value.some(Boolean);
    return !!value;
  }));
}
async function sendMetaConversionEvent(eventName, order, req, meta = {}, customData = {}) {
  if (!META_ACCESS_TOKEN || !META_PIXEL_ID) return null;
  const eventId = sanitizeStr(meta.eventId || `${eventName}_${order.id}_${Date.now()}`, 120);
  const payload = {
    data: [{
      event_name: eventName,
      event_time: Math.floor(Date.now() / 1000),
      event_id: eventId,
      action_source: 'website',
      event_source_url: sanitizeStr(meta.eventSourceUrl || req.headers.referer || '', 500),
      user_data: buildMetaUserData(order, req, meta),
      custom_data: {
        currency: 'UAH',
        value: asMoneyNumber(order.price || PRODUCT_PRICE),
        content_name: order.product || PRODUCT_NAME,
        content_ids: [metaContentId(order)],
        content_type: 'product',
        ...customData,
      },
    }],
  };
  if (META_TEST_EVENT_CODE) payload.test_event_code = META_TEST_EVENT_CODE;
  try {
    const response = await fetch(`https://graph.facebook.com/v19.0/${encodeURIComponent(META_PIXEL_ID)}/events?access_token=${encodeURIComponent(META_ACCESS_TOKEN)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) console.error('[Meta CAPI]', response.status, data?.error?.message || 'request failed');
    return data;
  } catch (error) {
    console.error('[Meta CAPI]', error.message);
    return null;
  }
}
function asMoneyNumber(val) {
  if (val === null || val === undefined || val === '') return 0;
  const n = Number(String(val).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function orderPaymentStatus(o) {
  return o?.paymentStatus || (o?.status === 'paid' || o?.status === 'completed' ? 'paid' : o?.status === 'returned' ? 'returned' : 'unpaid');
}
function deliveryStatusValue(o) {
  const value = o?.deliveryStatus || '';
  if (value === 'shipped' && o?.ttnCreatedAt && !o?.npStatus && !['paid', 'completed', 'returned'].includes(o?.status || 'new')) {
    return 'ttn_created';
  }
  return value || (o?.ttn ? 'ttn_added' : '');
}
function isOrderActuallyShipped(o) {
  const deliveryStatus = deliveryStatusValue(o);
  if (['in_transit', 'delivered'].includes(deliveryStatus)) return true;
  if (['paid', 'completed'].includes(o?.status || 'new')) return true;
  if ((o?.status || 'new') === 'shipped' && !['ttn_created', 'ttn_added', 'ready_for_np', 'ready_for_dispatch', 'unknown'].includes(deliveryStatus)) return true;
  return false;
}
function orderStatusForDisplay(o) {
  return (o?.status === 'shipped' && !isOrderActuallyShipped(o)) ? 'confirmed' : (o?.status || 'new');
}
function orderExpensesTotal(o) {
  const list = Array.isArray(o?.expenses) ? o.expenses : [];
  const listedTotal = list.reduce((sum, e) => sum + asMoneyNumber(e.amount), 0);
  const listedReturn = list.some(e => e?.category === 'return');
  const separateReturn = listedReturn ? 0 : asMoneyNumber(o?.returnExpense);
  return listedTotal + asMoneyNumber(o?.extraExpenses || o?.expense) + separateReturn;
}
function orderUpsell(o) {
  return o?.upsell && typeof o.upsell === 'object' ? o.upsell : null;
}
function orderPaidNet(o) {
  const basePaid = isPaidOrder(o);
  const upsell = orderUpsell(o);
  const upsellPaid = upsell && (upsell.incomePosted || upsell.paidAt || upsell.paymentStatus === 'paid');
  let total = 0;
  if (basePaid) total += orderBaseRevenue(o) - orderBaseCost(o);
  if (upsellPaid) total += asMoneyNumber(upsell.price) - asMoneyNumber(upsell.cost);
  return total;
}
function orderProfit(o) {
  return orderPaidNet(o) - orderExpensesTotal(o);
}
function periodStart(period) {
  const now = new Date();
  if (period === 'all') return null;
  if (period === 'week') {
    const d = new Date(now);
    d.setDate(now.getDate() - 6);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (period === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    d.setHours(0, 0, 0, 0);
    return d;
  }
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}
function inPeriod(iso, period) {
  const start = periodStart(period);
  if (!start) return true;
  const t = new Date(iso || 0).getTime();
  return Number.isFinite(t) && t >= start.getTime();
}
const PRODUCT_GROUPS = [
  { key: 'violet', label: 'Violet Motion', defaultCost: 420, aliases: ['violet motion', 'violet-motion', 'violet motion sneakers', 'violet sneakers'] },
  { key: 'black',  label: 'Black Breeze',  defaultCost: 380, aliases: ['black breeze', 'black-breeze', 'black breeze sandals'] },
  { key: 'power',  label: 'VoltGo Powerbank', defaultCost: 450, aliases: ['voltgo', 'powerbank', 'павербанк', 'power bank'] },
];
function normalizeProductName(value) {
  return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s_-]+/g, ' ').trim();
}
function productGroupKey(product) {
  const value = normalizeProductName(product);
  if (!value) return 'other';
  const found = PRODUCT_GROUPS.find(p => p.aliases.some(alias => value.includes(alias)));
  return found ? found.key : 'other';
}
function productGroupLabel(key) {
  if (!key || key === 'all') return 'Усі товари';
  const found = PRODUCT_GROUPS.find(p => p.key === key);
  return found ? found.label : 'Інші / без товару';
}
function orderProductKey(order) {
  return productGroupKey(order?.product || PRODUCT_NAME);
}
function readCrmProducts() {
  const stored = read(F.crmProducts);
  const items = Array.isArray(stored) ? stored : [];
  return PRODUCT_GROUPS.map(group => {
    const item = items.find(x => x?.key === group.key) || {};
    const cost = asMoneyNumber(item.cost);
    return {
      key: group.key,
      label: group.label,
      aliases: group.aliases,
      cost: cost > 0 ? cost : group.defaultCost,
      defaultCost: group.defaultCost,
      updatedAt: item.updatedAt || null,
    };
  });
}
function crmProduct(key) {
  return readCrmProducts().find(item => item.key === key) || null;
}
function orderProduct(order) {
  return crmProduct(orderProductKey(order)) || {
    key: orderProductKey(order),
    label: productGroupLabel(orderProductKey(order)),
    cost: 0,
    defaultCost: 0,
  };
}
function orderBaseRevenue(order) {
  return asMoneyNumber(order?.price);
}
function orderBaseCost(order) {
  const snapshot = asMoneyNumber(order?.cost || order?.costPrice || order?.purchasePrice);
  const configured = asMoneyNumber(orderProduct(order).cost);
  if (order?.costLocked === true && snapshot > 0) return snapshot;
  return configured > 0 ? configured : snapshot;
}
function orderPaidRevenue(order) {
  const basePaid = isPaidOrder(order);
  const upsell = orderUpsell(order);
  const upsellPaid = upsell && (upsell.incomePosted || upsell.paidAt || upsell.paymentStatus === 'paid');
  return (basePaid ? orderBaseRevenue(order) : 0) + (upsellPaid ? asMoneyNumber(upsell.price) : 0);
}
function orderPaidCost(order) {
  const basePaid = isPaidOrder(order);
  const upsell = orderUpsell(order);
  const upsellPaid = upsell && (upsell.incomePosted || upsell.paidAt || upsell.paymentStatus === 'paid');
  return (basePaid ? orderBaseCost(order) : 0) + (upsellPaid ? asMoneyNumber(upsell.cost) : 0);
}
function isPaidOrder(order) {
  return orderPaymentStatus(order) === 'paid' || order?.status === 'paid' || order?.status === 'completed';
}
function isReturnedOrder(order) {
  return orderPaymentStatus(order) === 'returned' || order?.status === 'returned';
}
function isForecastPipelineOrder(order) {
  if (isPaidOrder(order) || isReturnedOrder(order) || order?.status === 'cancelled') return false;
  if (orderBaseRevenue(order) <= 0) return false;
  return orderStatusForDisplay(order) === 'confirmed' || isOrderActuallyShipped(order);
}
function saveCrmProductCost(key, cost) {
  const current = readCrmProducts();
  const idx = current.findIndex(item => item.key === key);
  if (idx < 0) return null;
  current[idx] = { ...current[idx], cost, updatedAt: new Date().toISOString() };
  write(F.crmProducts, current.map(({ key: itemKey, label, cost: itemCost, updatedAt }) => ({
    key: itemKey,
    label,
    cost: itemCost,
    updatedAt,
  })));
  return current[idx];
}
function buildProductBreakdown(orders) {
  const map = new Map([...PRODUCT_GROUPS.map(p => p.key), 'other'].map(key => [key, {
    key,
    label: productGroupLabel(key),
    orders: 0,
    newOrders: 0,
    confirmedOrders: 0,
    shippedOrders: 0,
    paidOrders: 0,
    returns: 0,
    withoutTtn: 0,
    unpaid: 0,
    expectedIncome: 0,
    revenue: 0,
    cost: 0,
    net: 0,
    pipelineNet: 0,
  }]));
  orders.forEach(o => {
    const item = map.get(orderProductKey(o)) || map.get('other');
    item.orders += 1;
    if (o.status === 'new') item.newOrders += 1;
    if (['confirmed', 'shipped', 'paid', 'completed'].includes(o.status)) item.confirmedOrders += 1;
    if (isOrderActuallyShipped(o)) item.shippedOrders += 1;
    if (isPaidOrder(o)) item.paidOrders += 1;
    if (isReturnedOrder(o)) item.returns += 1;
    if (!o.ttn) item.withoutTtn += 1;
    if (orderPaymentStatus(o) !== 'paid') item.unpaid += 1;
    item.expectedIncome += orderPaidNet(o);
    item.revenue += orderPaidRevenue(o);
    item.cost += orderPaidCost(o);
    item.net += orderPaidNet(o);
    if (isForecastPipelineOrder(o)) item.pipelineNet += orderBaseRevenue(o) - orderBaseCost(o);
  });
  return [...map.values()].filter(x => x.orders > 0);
}
function buildBuyoutStats(orders, fallbackOrders = orders) {
  const paidOrders = orders.filter(isPaidOrder);
  const returns = orders.filter(isReturnedOrder);
  const fallbackPaid = fallbackOrders.filter(isPaidOrder).length;
  const fallbackReturns = fallbackOrders.filter(isReturnedOrder).length;
  const finalCount = paidOrders.length + returns.length;
  const fallbackFinalCount = fallbackPaid + fallbackReturns;
  const buyoutRate = finalCount
    ? paidOrders.length / finalCount
    : fallbackFinalCount
      ? fallbackPaid / fallbackFinalCount
      : 0.5;
  return {
    buyoutRate,
    returnRate: finalCount ? returns.length / finalCount : 1 - buyoutRate,
    rateSource: finalCount ? 'period' : fallbackFinalCount ? 'all' : 'default',
  };
}
function buildRecentPayments(paidOrders) {
  return [...paidOrders]
    .sort((a, b) => new Date(b.paidAt || b.basePaidAt || b.updatedAt || b.createdAt || 0) - new Date(a.paidAt || a.basePaidAt || a.updatedAt || a.createdAt || 0))
    .slice(0, 5)
    .map(order => {
      const product = orderProduct(order);
      const revenue = orderPaidRevenue(order);
      const cost = orderPaidCost(order);
      return {
        id: order.id,
        productKey: product.key,
        product: product.label,
        revenue,
        cost,
        net: revenue - cost - orderExpensesTotal(order),
        paidAt: order.paidAt || order.basePaidAt || order.updatedAt || order.createdAt || null,
      };
    });
}
function financeOrderContext(order) {
  if (!order) return null;
  return {
    id: order.id,
    name: order.name || order.fullName || '',
    product: orderProduct(order).label,
    size: order.size || '',
    ttn: order.ttn || '',
    returnTtn: order.npReturnExpressWaybillNumber || order.npReturnOrderNumber || '',
  };
}
function paidFinanceDate(order) {
  return order?.paidAt || order?.basePaidAt || order?.bankPaidAt || null;
}
function returnFinanceDate(order) {
  return order?.returnedAt || order?.npReturnCreatedAt || null;
}
function pipelineFinanceDate(order) {
  return order?.managerConfirmedAt || order?.zvonokConfirmedAt || order?.updatedAt || order?.createdAt || null;
}
function afterpaymentFinanceDate(order) {
  return order?.ttnCreatedAt || order?.shippedAt || order?.createdAt || null;
}
function orderBelongsToFinancePeriod(order, period) {
  if (isPaidOrder(order)) return inFinancePeriod(paidFinanceDate(order), period);
  if (isReturnedOrder(order)) return inFinancePeriod(returnFinanceDate(order), period);
  return inFinancePeriod(pipelineFinanceDate(order), period);
}
function buildFinanceTransactions(period = 'today', orders = read(F.orders)) {
  const orderMap = new Map(orders.map(order => [Number(order.id), order]));
  return read(F.finance)
    .filter(item => !item.excludedAt)
    .filter(item => MONOBANK_CRM_ENABLED || item.source !== 'monobank')
    .filter(item => !item.orderId || orderMap.has(Number(item.orderId)))
    .filter(item => !isUnverifiedNovaFinanceEntry(item))
    .filter(item => inFinancePeriod(item.createdAt, period))
    .map(item => ({
      ...item,
      linkedOrder: financeOrderContext(orderMap.get(Number(item.orderId))),
    }))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}
function isPersonalFinanceEntry(entry) {
  return entry?.category === 'personal';
}
function isBusinessRefundEntry(entry) {
  return ['shipping_refund', 'return_refund', 'ads_refund', 'business_refund'].includes(entry?.category);
}
function buildAfterpaymentSummary(period = 'today', orders = read(F.orders)) {
  const orderMap = new Map(orders.filter(order => order.ttn).map(order => [String(order.ttn), order]));
  const byTtn = new Map();
  const saved = Array.isArray(read(F.npAfterpayments)) ? read(F.npAfterpayments) : [];
  saved.forEach(item => {
    if (!item?.ttn || !inFinancePeriod(item.sentAt || item.createdAt, period)) return;
    byTtn.set(String(item.ttn), { ...item, linkedOrder: financeOrderContext(orderMap.get(String(item.ttn))) });
  });
  orders.forEach(order => {
    const amount = asMoneyNumber(order.npRedeliverySum);
    if (!order.ttn || amount <= 0 || !inFinancePeriod(afterpaymentFinanceDate(order), period)) return;
    if (byTtn.has(String(order.ttn))) return;
    byTtn.set(String(order.ttn), {
      ttn: String(order.ttn),
      amount,
      paymentMethod: order.npRedeliveryPaymentMethod || 'unknown',
      status: order.npRedeliveryStatus || order.npStatus || 'tracked',
      sentAt: afterpaymentFinanceDate(order),
      source: 'nova-poshta-api',
      linkedOrder: financeOrderContext(order),
    });
  });
  const items = [...byTtn.values()].sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0));
  return {
    amount: items.reduce((sum, item) => sum + asMoneyNumber(item.amount), 0),
    cashAmount: items.filter(item => String(item.paymentMethod || '').toLowerCase() === 'cash').reduce((sum, item) => sum + asMoneyNumber(item.amount), 0),
    records: items.length,
    matchedOrders: items.filter(item => item.linkedOrder?.id).length,
    items,
  };
}

function isPowerbankOrder(order) {
  return orderProductKey(order) === 'power';
}

function moneyReceivedManually(order) {
  return order?.moneyReceivedConfirmed === true && !!order?.moneyReceivedAt;
}

function returnReceivedManually(order) {
  return order?.returnReceivedConfirmed === true && !!order?.returnReceivedAt;
}

function novaSuggestsReturn(order) {
  const text = [
    order?.npStatus,
    order?.npReturnStatus,
    order?.npReturnTrackingStatus,
    order?.deliveryStatus,
    order?.returnSettlementStatus,
    order?.novaPoshta?.tracking?.status,
    order?.novaPoshta?.returnTracking?.status,
  ].filter(Boolean).join(' ').toLowerCase();
  return !!(
    order?.returnExpected || order?.npReturnExpressWaybillNumber || order?.npReturnOrderNumber ||
    order?.npReturnOldTtnActive || order?.npReturnArrivedAt || order?.status === 'returned' ||
    /повер|возврат|відмов|отказ|return|refusal/.test(text)
  );
}

function novaSuggestsMoney(order) {
  if (!order?.ttn || novaSuggestsReturn(order)) return false;
  const text = [order?.npStatus, order?.deliveryStatus, order?.settlementStatus, order?.novaPoshta?.tracking?.status]
    .filter(Boolean).join(' ').toLowerCase();
  return !!(
    order?.npMoneyExpected || order?.npDeliveredAt || asMoneyNumber(order?.npRedeliverySum) > 0 ||
    ['paid', 'completed'].includes(order?.status || '') ||
    /delivered|отриман|одержан|вручено|видано|awaiting_money/.test(text)
  );
}

function reconciliationDate(order, kind) {
  if (kind === 'money') return order.moneyReceivedAt || order.npDeliveredAt || order.paidAt || order.shippedAt || order.createdAt;
  return order.returnReceivedAt || order.npReturnArrivedAt || order.npReturnExpectedAt || order.returnedAt || order.updatedAt || order.createdAt;
}

function privatePowerItem(order) {
  return {
    id: order.id,
    name: order.name || order.fullName || '',
    phone: order.phone || '',
    product: order.product || '',
    price: asMoneyNumber(order.price),
    ttn: String(order.ttn || ''),
    returnTtn: String(order.npReturnExpressWaybillNumber || order.npReturnOrderNumber || ''),
    status: order.status || 'new',
    npStatus: order.npStatus || '',
    npReturnStatus: order.npReturnStatus || '',
    settlementStatus: moneyReceivedManually(order) ? 'money_received' : novaSuggestsMoney(order) ? 'awaiting_money' : 'not_ready',
    returnSettlementStatus: returnReceivedManually(order) ? 'return_received' : novaSuggestsReturn(order) ? 'awaiting_return' : 'not_expected',
    moneyReceivedAt: order.moneyReceivedAt || null,
    returnReceivedAt: order.returnReceivedAt || null,
    createdAt: order.createdAt || null,
  };
}

function buildPrivatePowerSummary(period = 'all', allOrders = read(F.orders)) {
  const powerOrders = allOrders.filter(isPowerbankOrder);
  const pendingMoney = powerOrders.filter(order => novaSuggestsMoney(order) && !moneyReceivedManually(order));
  const moneyReceived = powerOrders.filter(moneyReceivedManually);
  const pendingReturns = powerOrders.filter(order => novaSuggestsReturn(order) && !returnReceivedManually(order));
  const returnsReceived = powerOrders.filter(returnReceivedManually);
  const filterPeriod = (orders, kind) => orders.filter(order => inPeriod(reconciliationDate(order, kind), period));
  const pendingMoneyPeriod = filterPeriod(pendingMoney, 'money');
  const moneyReceivedPeriod = filterPeriod(moneyReceived, 'money');
  const pendingReturnsPeriod = filterPeriod(pendingReturns, 'return');
  const returnsReceivedPeriod = filterPeriod(returnsReceived, 'return');
  const sortItems = items => items.map(privatePowerItem).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return {
    period,
    product: 'VoltGo Powerbank',
    orders: powerOrders.filter(order => inPeriod(order.createdAt, period)).length,
    allOrders: powerOrders.length,
    pendingMoney: sortItems(pendingMoneyPeriod),
    moneyReceived: sortItems(moneyReceivedPeriod),
    pendingReturns: sortItems(pendingReturnsPeriod),
    returnsReceived: sortItems(returnsReceivedPeriod),
    pendingMoneyAmount: pendingMoneyPeriod.reduce((sum, order) => sum + (asMoneyNumber(order.npRedeliverySum) || asMoneyNumber(order.price)), 0),
    moneyReceivedAmount: moneyReceivedPeriod.reduce((sum, order) => sum + (asMoneyNumber(order.npRedeliverySum) || asMoneyNumber(order.price)), 0),
  };
}

function buildManagerReconciliationSummary(period = 'all', allOrders = read(F.orders)) {
  const managerOrders = allOrders.filter(order => !isPowerbankOrder(order));
  const pendingMoney = managerOrders.filter(order => novaSuggestsMoney(order) && !moneyReceivedManually(order));
  const moneyReceived = managerOrders.filter(moneyReceivedManually);
  const pendingReturns = managerOrders.filter(order => novaSuggestsReturn(order) && !returnReceivedManually(order));
  const returnsReceived = managerOrders.filter(returnReceivedManually);
  const filterPeriod = (orders, kind) => orders.filter(order => inPeriod(reconciliationDate(order, kind), period));
  const pendingMoneyPeriod = filterPeriod(pendingMoney, 'money');
  const moneyReceivedPeriod = filterPeriod(moneyReceived, 'money');
  const pendingReturnsPeriod = filterPeriod(pendingReturns, 'return');
  const returnsReceivedPeriod = filterPeriod(returnsReceived, 'return');
  const sortItems = items => items.map(privatePowerItem).sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return {
    period,
    product: 'Violet Motion',
    orders: managerOrders.filter(order => inPeriod(order.createdAt, period)).length,
    allOrders: managerOrders.length,
    pendingMoney: sortItems(pendingMoneyPeriod),
    moneyReceived: sortItems(moneyReceivedPeriod),
    pendingReturns: sortItems(pendingReturnsPeriod),
    returnsReceived: sortItems(returnsReceivedPeriod),
    pendingMoneyAmount: pendingMoneyPeriod.reduce((sum, order) => sum + (asMoneyNumber(order.npRedeliverySum) || asMoneyNumber(order.price)), 0),
    moneyReceivedAmount: moneyReceivedPeriod.reduce((sum, order) => sum + (asMoneyNumber(order.npRedeliverySum) || asMoneyNumber(order.price)), 0),
  };
}

function reconciliationTtns(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/);
  return [...new Set(raw.map(item => String(item || '').replace(/\D/g, '')).filter(item => /^\d{14,15}$/.test(item)))].slice(0, 200);
}

function reconcileOrdersByTtn(kind, values, managerId = null, scope = 'power') {
  const ttns = reconciliationTtns(values);
  const orders = read(F.orders);
  const now = new Date().toISOString();
  const updated = [];
  const alreadyClosed = [];
  const wrongProduct = [];
  const notFound = [];
  for (const ttn of ttns) {
    const index = orders.findIndex(order => kind === 'money'
      ? String(order.ttn || '') === ttn
      : [order.ttn, order.npReturnExpressWaybillNumber, order.npReturnOrderNumber].some(value => String(value || '') === ttn));
    if (index < 0) { notFound.push(ttn); continue; }
    const isPower = isPowerbankOrder(orders[index]);
    if ((scope === 'power' && !isPower) || (scope === 'manager' && isPower)) { wrongProduct.push(ttn); continue; }
    const order = orders[index];
    if (kind === 'money' && moneyReceivedManually(order)) { alreadyClosed.push(ttn); continue; }
    if (kind === 'return' && returnReceivedManually(order)) { alreadyClosed.push(ttn); continue; }
    const history = Array.isArray(order.reconciliationHistory) ? [...order.reconciliationHistory] : [];
    const source = scope === 'power' ? 'private-panel' : 'manager-panel';
    history.push({ kind, ttn, at: now, by: managerId || source, scope });
    if (kind === 'money') {
      const reconciled = ensurePaidOrderFinance({
        ...order,
        moneyReceivedConfirmed: true,
        moneyReceivedAt: now,
        moneyReceivedBy: managerId || source,
        settlementStatus: 'money_received',
        paymentStatus: 'paid',
        status: order.status === 'completed' ? 'completed' : 'paid',
        paidAt: order.paidAt || now,
        reconciliationHistory: history,
        updatedAt: now,
      }, {
        verified: true,
        at: now,
        source: 'manual-ttn-reconciliation',
        title: 'Післяплату отримано',
        verifiedBy: managerId || source,
        extra: ttn,
      });
      orders[index] = reconciled;
    } else {
      orders[index] = {
        ...order,
        returnReceivedConfirmed: true,
        returnReceivedAt: now,
        returnReceivedBy: managerId || source,
        returnSettlementStatus: 'return_received',
        paymentStatus: 'returned',
        status: 'returned',
        returnedAt: order.returnedAt || now,
        reconciliationHistory: history,
        updatedAt: now,
      };
    }
    updated.push({ id: orders[index].id, ttn, name: orders[index].name || '', price: asMoneyNumber(orders[index].price) });
  }
  if (updated.length) writeOrders(orders);
  return { success: true, kind, scope, submitted: ttns.length, updated, alreadyClosed, wrongProduct, notFound };
}

function reconcilePrivatePowerOrders(kind, values, managerId = null) {
  return reconcileOrdersByTtn(kind, values, managerId, 'power');
}

function reconcileManagerOrders(kind, values, managerId = null) {
  return reconcileOrdersByTtn(kind, values, managerId, 'manager');
}

function buildCrmSummary(period = 'today') {
  const allOrders = read(F.orders).filter(order => !isPowerbankOrder(order));
  const orders = allOrders.filter(o => orderBelongsToFinancePeriod(o, period));
  const finance = buildFinanceTransactions(period, allOrders);
  const reviewTransactions = finance.filter(x => x.reviewRequired === true);
  const income = finance.filter(x => x.type === 'income').reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const manualIncome = finance.filter(x => x.type === 'income' && ['business_income', 'manual_business_income'].includes(x.category)).reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const refundIncome = finance.filter(x => x.type === 'income' && isBusinessRefundEntry(x)).reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const unclassifiedIncome = finance.filter(x => x.type === 'income' && x.category !== 'net_order' && !isBusinessRefundEntry(x) && !['business_income', 'manual_business_income'].includes(x.category)).reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const businessExpenses = finance.filter(x => x.type === 'expense' && !isPersonalFinanceEntry(x));
  const expense = businessExpenses.reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const personalExpense = finance.filter(x => x.type === 'expense' && isPersonalFinanceEntry(x)).reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const adsExpense = businessExpenses.filter(x => x.category === 'ads').reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const paidOrders = allOrders.filter(o => isPaidOrder(o) && inFinancePeriod(paidFinanceDate(o), period));
  const returns = allOrders.filter(o => isReturnedOrder(o) && inFinancePeriod(returnFinanceDate(o), period));
  const pipelineOrders = allOrders.filter(o => isForecastPipelineOrder(o) && inFinancePeriod(pipelineFinanceDate(o), period));
  const confirmedOrders = orders.filter(o => orderStatusForDisplay(o) === 'confirmed' || isOrderActuallyShipped(o) || o.status === 'paid' || o.status === 'completed');
  const paymentTransactions = finance.filter(x => x.type === 'income' && x.category === 'net_order' && x.source === 'monobank');
  const bankPayoutGross = paymentTransactions.reduce((s, x) => s + (asMoneyNumber(x.grossAmount) || asMoneyNumber(x.amount) + asMoneyNumber(x.costAmount)), 0);
  const revenue = paidOrders.reduce((s, order) => s + orderPaidRevenue(order), 0);
  const cost = paidOrders.reduce((s, order) => s + orderPaidCost(order), 0);
  const netOrders = paidOrders.reduce((s, order) => s + orderPaidNet(order), 0);
  const trackedOrders = allOrders.filter(o => orderBelongsToFinancePeriod(o, 'all'));
  const buyout = buildBuyoutStats(orders, trackedOrders);
  const pendingRevenue = pipelineOrders.reduce((s, o) => s + orderBaseRevenue(o), 0);
  const pendingCost = pipelineOrders.reduce((s, o) => s + orderBaseCost(o), 0);
  const expectedIncome = netOrders + (pendingRevenue - pendingCost) * buyout.buyoutRate;
  const returnsExpense = businessExpenses.filter(x => x.category === 'return').reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const shippingExpense = businessExpenses.filter(x => x.category === 'shipping').reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const monobankExpense = businessExpenses.filter(x => x.source === 'monobank').reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const otherExpense = expense - adsExpense - returnsExpense - shippingExpense;
  const recordedExpense = expense - monobankExpense;
  const afterpayments = buildAfterpaymentSummary(period, allOrders);
  const productExpenses = new Map();
  finance.filter(x => x.type === 'expense' && x.orderId && !isPersonalFinanceEntry(x)).forEach(entry => {
    const order = allOrders.find(candidate => Number(candidate.id) === Number(entry.orderId));
    if (!order) return;
    const key = orderProductKey(order);
    productExpenses.set(key, (productExpenses.get(key) || 0) + asMoneyNumber(entry.amount));
  });
  const products = buildProductBreakdown(orders).map(product => {
    const finalCount = product.paidOrders + product.returns;
    const productBuyoutRate = finalCount ? product.paidOrders / finalCount : buyout.buyoutRate;
    const linkedExpense = productExpenses.get(product.key) || 0;
    return {
      ...product,
      linkedExpense,
      profitAfterLinkedExpenses: product.net - linkedExpense,
      buyoutRate: productBuyoutRate,
      returnRate: finalCount ? product.returns / finalCount : buyout.returnRate,
      forecastNet: product.net - linkedExpense + product.pipelineNet * productBuyoutRate,
    };
  });
  return {
    period,
    financeStartAt: financeStartAt(),
    financeResetLabel: readFinanceSettings().resetLabel,
    orders: orders.length,
    newOrders: orders.filter(o => o.status === 'new').length,
    confirmedOrders: confirmedOrders.length,
    shippedOrders: orders.filter(isOrderActuallyShipped).length,
    paidOrders: paidOrders.length,
    returns: returns.length,
    withoutTtn: orders.filter(o => !o.ttn).length,
    unpaid: orders.filter(o => orderPaymentStatus(o) !== 'paid').length,
    income,
    manualIncome,
    refundIncome,
    unclassifiedIncome,
    revenue,
    cost,
    netOrders,
    expense,
    personalExpense,
    adsExpense,
    shippingExpense,
    monobankExpense,
    recordedExpense,
    otherExpense,
    bankPayoutGross,
    bankMatchedPayouts: paymentTransactions.length,
    afterpayments,
    profit: netOrders + manualIncome + refundIncome - expense,
    expectedIncome,
    forecastRevenue: revenue + pendingRevenue * buyout.buyoutRate,
    forecastCost: cost + pendingCost * buyout.buyoutRate,
    forecastProfit: expectedIncome + manualIncome + refundIncome - expense,
    buyoutRate: buyout.buyoutRate,
    buyoutRateSource: buyout.rateSource,
    returnRate: buyout.returnRate,
    pipelineOrders: pipelineOrders.length,
    returnsExpense,
    difference: netOrders - expectedIncome,
    avgCheck: paidOrders.length ? revenue / paidOrders.length : 0,
    avgProfit: paidOrders.length ? netOrders / paidOrders.length : 0,
    leadCost: orders.length ? adsExpense / orders.length : 0,
    confirmedOrderCost: confirmedOrders.length ? adsExpense / confirmedOrders.length : 0,
    paidOrderCost: paidOrders.length ? adsExpense / paidOrders.length : 0,
    products,
    recentPayments: buildRecentPayments(paidOrders),
    transactions: finance,
    reviewTransactions,
    reviewCount: reviewTransactions.length,
  };
}
function timestampMs(...values) {
  for (const value of values) {
    const time = new Date(value || 0).getTime();
    if (Number.isFinite(time) && time > 0) return time;
  }
  return 0;
}
function average(values) {
  const clean = values.filter(value => Number.isFinite(value) && value >= 0);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : 0;
}
function orderConfirmationAt(order) {
  const explicit = timestampMs(order?.managerConfirmedAt, order?.zvonokConfirmedAt, order?.confirmedAt);
  if (explicit) return explicit;
  return (order?.status === 'confirmed' && order?.updatedAt) ? timestampMs(order.updatedAt) : 0;
}
function isOrderWaitingConfirmation(order) {
  return ['new', 'no_answer'].includes(order?.status || 'new');
}
function hasNovaPoshtaRecipientData(order) {
  return !!((order?.fullName || order?.name) && order?.city && order?.postOffice && order?.size);
}
function isOrderMissingDeliveryData(order) {
  if (!['confirmed', 'shipped'].includes(order?.status || 'new') || order?.ttn) return false;
  return !hasNovaPoshtaRecipientData(order);
}
function isOrderReadyWithoutTtn(order) {
  if (!['confirmed', 'shipped', 'paid'].includes(order?.status || 'new') || order?.ttn) return false;
  return hasNovaPoshtaRecipientData(order);
}
function orderAtBranch(order) {
  if (!order?.ttn || isPaidOrder(order) || isReturnedOrder(order) || ['cancelled', 'completed'].includes(order?.status || 'new')) return false;
  const text = `${order?.npStatus || ''} ${order?.novaPoshta?.tracking?.status || ''}`.toLowerCase();
  return /(відділен|отделен|прибув|прибыл|очікує отримання|ожидает получения|доставлен.*відділен|доставлен.*отделен)/i.test(text);
}
function activeTrackingOrder(order) {
  return !!order?.ttn && !isPaidOrder(order) && !isReturnedOrder(order) && !['cancelled', 'completed'].includes(order?.status || 'new');
}
function orderAgeMs(order, ...preferredDates) {
  const start = timestampMs(...preferredDates, order?.createdAt);
  return start ? Math.max(0, Date.now() - start) : 0;
}
function orderOpsItem(order, ageMs = orderAgeMs(order)) {
  return {
    id: order.id,
    name: order.name || order.fullName || '',
    product: order.product || '',
    size: order.size || '',
    phone: order.phone || '',
    status: order.status || 'new',
    paymentStatus: orderPaymentStatus(order),
    deliveryStatus: deliveryStatusValue(order),
    ttn: order.ttn || '',
    npStatus: order.npStatus || '',
    city: order.city || '',
    postOffice: order.postOffice || '',
    createdAt: order.createdAt || null,
    updatedAt: order.updatedAt || null,
    npSyncedAt: order.npSyncedAt || null,
    ageMs,
  };
}
function oldestFirst(items, age) {
  return [...items]
    .map(order => orderOpsItem(order, age(order)))
    .sort((a, b) => b.ageMs - a.ageMs);
}
function buildOrderCrmSummary(period = 'today') {
  const allOrders = read(F.orders).filter(order => !isPowerbankOrder(order));
  const orders = allOrders.filter(order => inPeriod(order.createdAt, period));
  const waitingConfirmation = allOrders.filter(isOrderWaitingConfirmation);
  const missingDelivery = allOrders.filter(isOrderMissingDeliveryData);
  const readyWithoutTtn = allOrders.filter(isOrderReadyWithoutTtn);
  const atBranch = allOrders.filter(orderAtBranch);
  const tracked = allOrders.filter(activeTrackingOrder);
  const staleTracking = tracked.filter(order => orderAgeMs(order, order.npSyncedAt || order.ttnCreatedAt) >= 12 * 60 * 60 * 1000);
  const confirmedInPeriod = orders.filter(order => orderConfirmationAt(order));
  const ttnInPeriod = orders.filter(order => timestampMs(order.ttnCreatedAt));
  const paidInPeriod = orders.filter(isPaidOrder);
  const productStats = new Map();
  const sizeStats = new Map();

  orders.forEach(order => {
    const product = orderProduct(order);
    const productItem = productStats.get(product.key) || { key: product.key, label: product.label, orders: 0, paid: 0, returns: 0 };
    productItem.orders += 1;
    if (isPaidOrder(order)) productItem.paid += 1;
    if (isReturnedOrder(order)) productItem.returns += 1;
    productStats.set(product.key, productItem);
    const size = sanitizeStr(order.size || '', 20);
    if (size) sizeStats.set(size, (sizeStats.get(size) || 0) + 1);
  });

  return {
    period,
    generatedAt: new Date().toISOString(),
    totals: {
      periodOrders: orders.length,
      todayOrders: allOrders.filter(order => inPeriod(order.createdAt, 'today')).length,
      waitingConfirmation: waitingConfirmation.length,
      noAnswer: allOrders.filter(order => order.status === 'no_answer').length,
      confirmed: orders.filter(order => ['confirmed', 'shipped', 'paid', 'completed'].includes(order.status || 'new')).length,
      shipped: orders.filter(isOrderActuallyShipped).length,
      activeTracking: tracked.length,
      atBranch: atBranch.length,
      paid: paidInPeriod.length,
      returns: orders.filter(isReturnedOrder).length,
      cancelled: orders.filter(order => order.status === 'cancelled').length,
      missingDelivery: missingDelivery.length,
      readyWithoutTtn: readyWithoutTtn.length,
      staleTracking: staleTracking.length,
    },
    timings: {
      averageNewAgeMs: average(waitingConfirmation.map(order => orderAgeMs(order))),
      oldestNewAgeMs: waitingConfirmation.reduce((max, order) => Math.max(max, orderAgeMs(order)), 0),
      averageConfirmMs: average(confirmedInPeriod.map(order => orderConfirmationAt(order) - timestampMs(order.createdAt))),
      confirmSamples: confirmedInPeriod.length,
      averageTtnMs: average(ttnInPeriod.map(order => timestampMs(order.ttnCreatedAt) - (orderConfirmationAt(order) || timestampMs(order.createdAt)))),
      ttnSamples: ttnInPeriod.length,
      averageTransitAgeMs: average(tracked.map(order => orderAgeMs(order, order.shippedAt, order.ttnCreatedAt))),
      oldestBranchAgeMs: atBranch.reduce((max, order) => Math.max(max, orderAgeMs(order, order.shippedAt, order.ttnCreatedAt)), 0),
    },
    queues: {
      confirm: oldestFirst(waitingConfirmation, order => orderAgeMs(order)),
      missingDelivery: oldestFirst(missingDelivery, order => orderAgeMs(order, order.managerConfirmedAt, order.zvonokConfirmedAt, order.updatedAt)),
      readyWithoutTtn: oldestFirst(readyWithoutTtn, order => orderAgeMs(order, order.managerConfirmedAt, order.zvonokConfirmedAt, order.updatedAt)),
      branch: oldestFirst(atBranch, order => orderAgeMs(order, order.shippedAt, order.ttnCreatedAt)),
      staleTracking: oldestFirst(staleTracking, order => orderAgeMs(order, order.npSyncedAt || order.ttnCreatedAt)),
    },
    leaders: {
      products: [...productStats.values()].sort((a, b) => b.orders - a.orders).slice(0, 5),
      sizes: [...sizeStats.entries()].map(([size, count]) => ({ size, count })).sort((a, b) => b.count - a.count).slice(0, 5),
    },
  };
}

function financeExternalId(source, category, orderId, extra = '') {
  return [source, category, orderId || 'none', extra || 'once'].join(':');
}
function isUnverifiedNovaFinanceEntry(entry) {
  if (entry?.verifiedBy === 'monobank' || entry?.source === 'monobank') return false;
  if (entry?.category === 'net_order') return true;
  return entry?.source === 'nova-poshta' && ['shipping', 'return'].includes(entry?.category);
}
function addFinanceEntryOnce(entry) {
  const finance = read(F.finance);
  const externalId = entry.externalId || financeExternalId(entry.source || 'system', entry.category || 'manual', entry.orderId, entry.kind);
  const bankTransactionId = sanitizeStr(entry.bankTransactionId || '', 120) || null;
  const incomingBankHold = entry.bankHold === true;
  const bankHoldUpdatedAt = entry.bankHoldUpdatedAt || new Date().toISOString();
  const existingIdx = finance.findIndex(x => x.externalId === externalId);
  if (existingIdx >= 0) {
    const existing = finance[existingIdx];
    if (bankTransactionId && (existing.bankTransactionId !== bankTransactionId || existing.bankHold !== incomingBankHold)) {
      finance[existingIdx] = {
        ...existing,
        bankTransactionId,
        bankHold: incomingBankHold,
        bankHoldUpdatedAt,
      };
      write(F.finance, finance);
    }
    return finance[existingIdx];
  }
  const existingBankIdx = bankTransactionId
    ? finance.findIndex(x => x.bankTransactionId && x.bankTransactionId === bankTransactionId)
    : -1;
  if (existingBankIdx >= 0) {
    const current = finance[existingBankIdx];
    if (current.classifiedAt) {
      if (current.bankHold !== incomingBankHold) {
        finance[existingBankIdx] = {
          ...current,
          bankHold: incomingBankHold,
          bankHoldUpdatedAt,
        };
        write(F.finance, finance);
      }
      return finance[existingBankIdx];
    }
    finance[existingBankIdx] = {
      ...current,
      type: entry.type,
      title: sanitizeStr(entry.title || current.title || (entry.type === 'income' ? 'Income' : 'Expense'), 180),
      amount: asMoneyNumber(entry.amount),
      category: sanitizeStr(entry.category || current.category || 'manual', 60),
      source: sanitizeStr(entry.source || current.source || 'system', 60),
      orderId: entry.orderId ? Number(entry.orderId) : current.orderId || null,
      externalId,
      grossAmount: asMoneyNumber(entry.grossAmount),
      costAmount: asMoneyNumber(entry.costAmount),
      productKey: sanitizeStr(entry.productKey || '', 60) || current.productKey || null,
      productLabel: sanitizeStr(entry.productLabel || '', 100) || current.productLabel || null,
      verifiedBy: sanitizeStr(entry.verifiedBy || current.verifiedBy || '', 30) || null,
      bankDescription: sanitizeStr(entry.bankDescription || current.bankDescription || '', 240) || null,
      counterName: sanitizeStr(entry.counterName || current.counterName || '', 180) || null,
      bankHold: incomingBankHold,
      bankHoldUpdatedAt,
      classificationReason: sanitizeStr(entry.classificationReason || current.classificationReason || '', 120) || null,
      reviewRequired: entry.reviewRequired === true,
      reclassifiedAutomaticallyAt: new Date().toISOString(),
    };
    write(F.finance, finance);
    return finance[existingBankIdx];
  }
  const item = {
    id: nextId(finance),
    type: entry.type,
    title: sanitizeStr(entry.title || (entry.type === 'income' ? 'Income' : 'Expense'), 180),
    amount: asMoneyNumber(entry.amount),
    category: sanitizeStr(entry.category || 'manual', 60),
    source: sanitizeStr(entry.source || 'system', 60),
    orderId: entry.orderId ? Number(entry.orderId) : null,
    externalId,
    grossAmount: asMoneyNumber(entry.grossAmount),
    costAmount: asMoneyNumber(entry.costAmount),
    productKey: sanitizeStr(entry.productKey || '', 60) || null,
    productLabel: sanitizeStr(entry.productLabel || '', 100) || null,
    verifiedBy: sanitizeStr(entry.verifiedBy || '', 30) || null,
    bankTransactionId,
    bankDescription: sanitizeStr(entry.bankDescription || '', 240) || null,
    counterName: sanitizeStr(entry.counterName || '', 180) || null,
    bankHold: incomingBankHold,
    bankHoldUpdatedAt: incomingBankHold ? bankHoldUpdatedAt : null,
    classificationReason: sanitizeStr(entry.classificationReason || '', 120) || null,
    reviewRequired: entry.reviewRequired === true,
    createdAt: entry.createdAt || new Date().toISOString(),
  };
  finance.push(item);
  write(F.finance, finance);
  return item;
}
function ensurePaidOrderFinance(order, options = {}) {
  if (!isPaidOrder(order) && !options.verified) return order;
  const now = options.at || new Date().toISOString();
  const product = orderProduct(order);
  const grossAmount = orderBaseRevenue(order);
  const costAmount = orderBaseCost(order);
  const updated = {
    ...order,
    cost: asMoneyNumber(order?.cost || order?.costPrice || order?.purchasePrice) || costAmount,
    costProductKey: order.costProductKey || product.key,
    costProductLabel: order.costProductLabel || product.label,
    costSnapshotAt: order.costSnapshotAt || now,
    paidAt: order.paidAt || now,
    basePaidAt: order.basePaidAt || now,
  };

  if (options.verified && !updated.baseIncomePosted) {
    if (grossAmount > 0) {
      addFinanceEntryOnce({
        type: 'income',
        title: `${options.title || 'Order payment'} #${order.id}`,
        amount: grossAmount - costAmount,
        grossAmount,
        costAmount,
        productKey: product.key,
        productLabel: product.label,
        category: 'net_order',
        source: options.source || 'order-status',
        orderId: order.id,
        externalId: financeExternalId(options.source || 'order-status', 'payment', order.id, options.extra || 'base'),
        verifiedBy: options.verifiedBy,
        bankTransactionId: options.bankTransactionId,
        bankDescription: options.bankDescription,
        createdAt: now,
      });
      updated.baseIncomePosted = true;
      updated.baseIncomeVerified = true;
      updated.bankPaidAt = updated.bankPaidAt || now;
    }
  }

  return updated;
}
function monoStatementText(item = {}) {
  return [item.description, item.comment, item.counterName].filter(Boolean).join(' ').toLowerCase();
}
function monoMatches(text, envName, fallback) {
  const values = String(process.env[envName] || fallback)
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  return values.some(value => text.includes(value));
}
function monoMatchesAny(text, values = []) {
  return values.some(value => text.includes(String(value).toLowerCase()));
}
function monoExpenseAmount(item) {
  return Math.abs(asMoneyNumber(item?.amount) / 100);
}
function monoExtractTtn(text) {
  return String(text || '').match(/\b\d{14,15}\b/)?.[0] || '';
}
function findOrderForMonoItem(orders, item) {
  const text = monoStatementText(item);
  const ttn = monoExtractTtn(text);
  if (!ttn) return { order: null, ttn: '', returnOperation: false };
  const order = orders.find(candidate => (
    String(candidate.ttn || '') === ttn ||
    String(candidate.npReturnExpressWaybillNumber || '') === ttn ||
    String(candidate.npReturnOrderNumber || '') === ttn
  )) || null;
  return {
    order,
    ttn,
    returnOperation: !!order && [order.npReturnExpressWaybillNumber, order.npReturnOrderNumber].map(String).includes(ttn),
  };
}
function importMonobankStatementItem(item, orders = read(F.orders)) {
  if (!item?.id || Number(item.currencyCode || 980) !== 980) return { imported: false, ignored: true };
  const text = monoStatementText(item);
  const createdAt = new Date(Number(item.time || 0) * 1000).toISOString();
  const bankMeta = { bankHold: item.hold === true };
  if (!inFinancePeriod(createdAt, 'all')) return { imported: false, ignored: true, reason: 'before_finance_start' };
  const isNova = monoMatches(text, 'MONOBANK_NP_KEYWORDS', 'нова пошта,новая почта,nova poshta,nova post,nova posta,novaposhta,novapost,nova pay,novapay,novaposta');
  const isAds = monoMatches(text, 'MONOBANK_ADS_KEYWORDS', 'facebook,facebk,fb ads,fbpay,meta,meta platforms,instagram,google ads,tiktok,tik tok');
  const isBusiness = monoMatches(text, 'MONOBANK_BUSINESS_KEYWORDS', 'постачальник,supplier,упаковка,packaging');
  const isPersonal = monoMatches(text, 'MONOBANK_PERSONAL_KEYWORDS', 'таврія,таври,rozetka,temu,київстар,kyivstar,farm,medicap,into-sana,jet.ua');
  const bankAmount = asMoneyNumber(item.amount) / 100;
  if (!bankAmount) return { imported: false, ignored: true };
  const match = isNova ? findOrderForMonoItem(orders, item) : { order: null, ttn: '', returnOperation: false };
  const order = match.order;
  const isCancellation = /(скасув|отмен|cancel|refund|reversal|повернен.*кошт)/i.test(text);
  const isReturnCharge = match.returnOperation || /(повернен.*посил|зворотн.*достав|return delivery|return shipment|возврат.*посыл)/i.test(text);
  const likelyNovaReturnExpense = isReturnCharge || (isNova && bankAmount < 0 && monoExpenseAmount(item) >= 80 && monoExpenseAmount(item) <= 350);
  let entry = null;

  if (isNova && bankAmount > 0 && isCancellation && order) {
    entry = addFinanceEntryOnce({
      type: 'income',
      title: 'Monobank: Nova Poshta charge reversal',
      amount: bankAmount,
      category: isReturnCharge ? 'return_refund' : 'shipping_refund',
      source: 'monobank',
      orderId: order?.id || null,
      verifiedBy: 'monobank',
      bankTransactionId: item.id,
      bankDescription: item.description,
      counterName: item.counterName,
      externalId: financeExternalId('monobank', isReturnCharge ? 'return-refund' : 'shipping-refund', order.id, item.id),
      createdAt,
    });
  } else if (isNova && bankAmount > 0 && isCancellation) {
    entry = addFinanceEntryOnce({
      type: 'income',
      title: 'Monobank: Nova Poshta charge reversal to review',
      amount: bankAmount,
      category: likelyNovaReturnExpense ? 'return_refund' : 'shipping_refund',
      source: 'monobank',
      verifiedBy: 'monobank',
      bankTransactionId: item.id,
      bankDescription: item.description,
      counterName: item.counterName,
      externalId: financeExternalId('monobank', likelyNovaReturnExpense ? 'return-refund-review' : 'shipping-refund-review', null, item.id),
      classificationReason: 'nova_poshta_refund_without_linked_order',
      reviewRequired: true,
      createdAt,
    });
  } else if (isNova && bankAmount > 0 && order) {
    const product = orderProduct(order);
    const costAmount = orderBaseCost(order);
    entry = addFinanceEntryOnce({
      type: 'income',
      title: `Monobank: Nova Poshta payout #${order.id}`,
      amount: bankAmount - costAmount,
      grossAmount: bankAmount,
      costAmount,
      productKey: product.key,
      productLabel: product.label,
      category: 'net_order',
      source: 'monobank',
      orderId: order.id,
      verifiedBy: 'monobank',
      bankTransactionId: item.id,
      bankDescription: item.description,
      counterName: item.counterName,
      externalId: financeExternalId('monobank', 'payment', order.id, item.id),
      createdAt,
    });
    const idx = orders.findIndex(candidate => candidate.id === order.id);
    if (idx >= 0) {
      orders[idx] = {
        ...orders[idx],
        bankPaidAt: orders[idx].bankPaidAt || createdAt,
        baseIncomePosted: true,
        baseIncomeVerified: true,
        monoIncomeTransactionId: item.id,
        actualPayoutAmount: bankAmount,
        cost: asMoneyNumber(orders[idx].cost) || costAmount,
        costProductKey: orders[idx].costProductKey || product.key,
        costProductLabel: orders[idx].costProductLabel || product.label,
        updatedAt: new Date().toISOString(),
      };
      writeOrders(orders);
    }
  } else if (isNova && bankAmount > 0) {
    entry = addFinanceEntryOnce({
      type: 'unmatched',
      title: 'Monobank: Nova Poshta payout without linked order',
      amount: bankAmount,
      category: 'np_payout_unmatched',
      source: 'monobank',
      verifiedBy: 'monobank',
      bankTransactionId: item.id,
      bankDescription: item.description,
      counterName: item.counterName,
      externalId: financeExternalId('monobank', 'unmatched-payout', null, item.id),
      createdAt,
    });
  } else if (isNova && bankAmount < 0 && order) {
    entry = addFinanceEntryOnce({
      type: 'expense',
      title: `Monobank: Nova Poshta ${isReturnCharge ? 'return' : 'charge'}`,
      amount: Math.abs(bankAmount),
      category: likelyNovaReturnExpense ? 'return' : 'shipping',
      source: 'monobank',
      orderId: order?.id || null,
      verifiedBy: 'monobank',
      bankTransactionId: item.id,
      bankDescription: item.description,
      counterName: item.counterName,
      externalId: financeExternalId('monobank', likelyNovaReturnExpense ? 'return' : 'shipping', order.id, item.id),
      classificationReason: 'linked_order_ttn',
      createdAt,
    });
  } else if (isNova && bankAmount < 0) {
    entry = addFinanceEntryOnce({
      type: 'expense',
      title: 'Monobank: Nova Poshta unlinked expense',
      amount: Math.abs(bankAmount),
      category: likelyNovaReturnExpense ? 'return' : 'shipping',
      source: 'monobank',
      verifiedBy: 'monobank',
      bankTransactionId: item.id,
      bankDescription: item.description,
      counterName: item.counterName,
      externalId: financeExternalId('monobank', 'np-review', null, item.id),
      classificationReason: 'nova_poshta_without_linked_order_auto_counted',
      reviewRequired: true,
      createdAt,
    });
  } else if (isAds && bankAmount < 0) {
    entry = addFinanceEntryOnce({
      type: 'expense',
      title: 'Monobank: advertising charge',
      amount: Math.abs(bankAmount),
      category: 'ads',
      source: 'monobank',
      verifiedBy: 'monobank',
      bankTransactionId: item.id,
      bankDescription: item.description,
      counterName: item.counterName,
      externalId: financeExternalId('monobank', 'ads', null, item.id),
      classificationReason: 'ads_keyword',
      createdAt,
    });
  } else if (isAds && bankAmount > 0 && isCancellation) {
    entry = addFinanceEntryOnce({
      type: 'income',
      title: 'Monobank: advertising charge reversal',
      amount: bankAmount,
      category: 'ads_refund',
      source: 'monobank',
      verifiedBy: 'monobank',
      bankTransactionId: item.id,
      bankDescription: item.description,
      counterName: item.counterName,
      externalId: financeExternalId('monobank', 'ads-refund', null, item.id),
      classificationReason: 'ads_refund_keyword',
      createdAt,
    });
  } else if (isBusiness && bankAmount < 0) {
    entry = addFinanceEntryOnce({
      type: 'expense',
      title: 'Monobank: business expense',
      amount: Math.abs(bankAmount),
      category: 'business',
      source: 'monobank',
      verifiedBy: 'monobank',
      bankTransactionId: item.id,
      bankDescription: item.description,
      counterName: item.counterName,
      externalId: financeExternalId('monobank', 'business', null, item.id),
      classificationReason: 'business_keyword',
      createdAt,
    });
  } else if (bankAmount < 0) {
    entry = addFinanceEntryOnce({
      type: 'expense',
      title: 'Monobank: personal or unclassified expense',
      amount: Math.abs(bankAmount),
      category: 'personal',
      source: 'monobank',
      verifiedBy: 'monobank',
      bankTransactionId: item.id,
      bankDescription: item.description,
      counterName: item.counterName,
      externalId: financeExternalId('monobank', 'personal', null, item.id),
      classificationReason: isPersonal ? 'personal_keyword' : 'safe_default_not_business',
      reviewRequired: !isPersonal,
      createdAt,
    });
  } else if (bankAmount > 0) {
    entry = addFinanceEntryOnce({
      type: 'unmatched',
      title: 'Monobank: income to review',
      amount: bankAmount,
      category: 'income_review',
      source: 'monobank',
      verifiedBy: 'monobank',
      bankTransactionId: item.id,
      bankDescription: item.description,
      counterName: item.counterName,
      externalId: financeExternalId('monobank', 'income-review', null, item.id),
      classificationReason: 'unmatched_income',
      reviewRequired: true,
      createdAt,
    });
  }
  if (entry?.bankTransactionId) {
    const finance = read(F.finance);
    const idx = finance.findIndex(x => x.bankTransactionId === entry.bankTransactionId);
    if (idx >= 0 && finance[idx].bankHold !== bankMeta.bankHold) {
      finance[idx] = {
        ...finance[idx],
        bankHold: bankMeta.bankHold,
        bankHoldUpdatedAt: new Date().toISOString(),
      };
      write(F.finance, finance);
      entry = finance[idx];
    }
  }
  return { imported: !!entry, ignored: !entry, entry, orderId: order?.id || null };
}
async function syncMonobankFinance(daysBack = 3) {
  const safeDays = Math.max(1, Math.min(31, Number(daysBack || 3)));
  const to = Math.floor(Date.now() / 1000);
  const from = to - safeDays * 24 * 60 * 60;
  const items = await monobank.getStatement({ from, to });
  const results = items.map(item => importMonobankStatementItem(item));
  return {
    checked: items.length,
    imported: results.filter(result => result.imported).length,
    ignored: results.filter(result => result.ignored).length,
  };
}
function npDetailsText(details = {}) {
  return [
    details.status,
    ...(Array.isArray(details.errors) ? details.errors : []),
    ...(Array.isArray(details.warnings) ? details.warnings : []),
    ...(Array.isArray(details.info) ? details.info : []),
    ...(Array.isArray(details.raw?.errors) ? details.raw.errors : []),
    details.error,
    details.message,
  ].filter(Boolean).join(' ');
}
function isNpRateLimited(details = {}) {
  return !!(details.rateLimited || details.status === 429 || /to+\s+many\s+requests|too\s+many\s+requests|rate\s*limit|ліміт|лимит/i.test(npDetailsText(details)));
}
function npDetailMessages(details = {}) {
  return [
    ...(Array.isArray(details.errors) ? details.errors : []),
    ...(Array.isArray(details.raw?.errors) ? details.raw.errors : []),
  ]
    .map(x => sanitizeStr(x, 220))
    .filter(Boolean)
    .slice(0, 3);
}
function isNpPaymentServiceUnavailable(details = {}) {
  return /післяплат|послеплат|afterpayment|backwarddelivery|redelivery/i.test(npDetailsText(details)) &&
    /(недоступ|unavailable|not available)/i.test(npDetailsText(details));
}
function npUserMessage(error, details = {}) {
  const message = String(error?.message || '');
  const missing = Array.isArray(details.missing) ? details.missing : [];
  const apiErrors = npDetailMessages(details);

  if (missing.includes('NOVA_POSHTA_API_KEY')) {
    return 'На Render не налаштовано API ключ Нової Пошти.';
  }
  if (/sender config/i.test(message) || missing.some(x => /^CitySender|^Sender|^SenderAddress|^ContactSender|^SendersPhone$/.test(x))) {
    return 'Нова Пошта не знайшла дані відправника. Перевірте налаштування відправника НП на Render.';
  }
  if (/sender warehouse was not found/i.test(message)) {
    return `Нова Пошта не знайшла місце відправки "${sanitizeStr(details.warehouse || details.normalizedWarehouse || '', 80)}".`;
  }
  if (/city was not found/i.test(message)) {
    return `Нова Пошта не знайшла місто "${sanitizeStr(details.originalCity || details.city || '', 80)}".`;
  }
  if (/warehouse was not found/i.test(message)) {
    return `Нова Пошта не знайшла відділення "${sanitizeStr(details.warehouse || details.normalizedWarehouse || '', 80)}" у цьому місті.`;
  }
  if (/recipient name or phone is incomplete/i.test(message)) {
    return 'Для ТТН Новій Пошті потрібні коректні ПІБ отримувача та телефон.';
  }
  if (isNpPaymentServiceUnavailable(details)) {
    return 'Нова Пошта відхилила контроль оплати/післяплату: для цього API-ключа або відправника фінансова послуга недоступна. У Render перевірте NOVA_POSHTA_API_KEY і NP_SENDER_PHONE, а в кабінеті НП/NovaPay - договір та доступ до контролю оплати.';
  }
  if (apiErrors.length) {
    return `Нова Пошта відхилила ТТН: ${apiErrors.join('; ')}`;
  }
  return 'Nova Poshta не виконала запит. Перевірте дані доставки або спробуйте ще раз.';
}
function npErrorPayload(error) {
  const details = error?.details || {};
  const rateLimited = isNpRateLimited(details);
  const retryable = !!(rateLimited || details.retryable);
  return {
    error: error?.message || 'Nova Poshta request failed',
    userMessage: rateLimited
      ? 'Нова Пошта тимчасово обмежила кількість запитів. Зачекайте 30-60 секунд і натисніть створення ТТН ще раз.'
      : npUserMessage(error, details),
    details,
    missing: details.missing || [],
    retryable,
    rateLimited,
    retryAfterMs: details.retryAfterMs || null,
  };
}
function novaPoshtaMissingConfigPayload() {
  const error = new Error('Nova Poshta API key is not configured');
  error.details = { missing: ['NOVA_POSHTA_API_KEY'] };
  return npErrorPayload(error);
}
function isOrderActiveForNpSync(order) {
  const status = order?.status || 'new';
  if (!order?.ttn || ['cancelled', 'completed'].includes(status)) return false;
  if (status === 'returned') return !!(order.npReturnOrderRef || order.npReturnOrderNumber || !order.npReturnDeliveryCost);
  return true;
}
function canAutoLinkManualNpOrder(order) {
  const status = order?.status || 'new';
  return !order?.ttn && !!order?.phone && ['confirmed', 'shipped', 'paid'].includes(status);
}
function ttnAlreadyUsed(orders, ttn, exceptOrderId = null) {
  const value = String(ttn || '').trim();
  return !!value && orders.some(o => String(o.ttn || '').trim() === value && Number(o.id) !== Number(exceptOrderId));
}
function trackingText(track = {}) {
  return [
    track.status,
    track.lastCreatedOnTheBasisDocumentType,
    track.createdOnTheBasis,
    track.publicTracking?.currentStatus,
    track.publicTracking?.currentRelationType,
  ].filter(Boolean).join(' ').toLowerCase();
}
function trackingLooksLikeReturnRoute(track = {}, order = {}) {
  const text = trackingText(track);
  const orderReturn = ['returned'].includes(order?.status || '') || orderPaymentStatus(order) === 'returned';
  return !!(
    track.normalizedStatus === 'returned' ||
    track.cargoReturnRefusal ||
    /повер|возврат|відмов|отказ|змінено\s+адрес|измен[её]н.*адрес|return/i.test(text) ||
    (orderReturn && (track.senderWarehouse || track.senderWarehouseAddress || track.lastCreatedOnTheBasisNumber))
  );
}
function trackingArrivedAtSender(track = {}) {
  const code = String(track.statusCode || '');
  const text = trackingText(track);
  return ['7', '8'].includes(code) || /прибул|прибыл|відділен|отдел|поштомат|почтомат|postomat/i.test(text);
}
function applyNovaTrackingToOrder(order, track) {
  const now = new Date().toISOString();
  const patch = {
    deliveryStatus: track.normalizedStatus,
    npStatus: track.status || null,
    npStatusCode: track.statusCode || null,
    npCity: track.city || order.npCity || null,
    npWarehouse: track.warehouse || order.npWarehouse || null,
    npWarehouseAddress: track.warehouseAddress || order.npWarehouseAddress || null,
    npWarehouseNumber: track.warehouseNumber || order.npWarehouseNumber || null,
    npSenderCity: track.senderCity || order.npSenderCity || null,
    npSenderWarehouse: track.senderWarehouse || order.npSenderWarehouse || null,
    npSenderWarehouseAddress: track.senderWarehouseAddress || order.npSenderWarehouseAddress || null,
    npCanCreateReturn: track.possibilityCreateReturn === true,
    npCanCreateRefusal: track.possibilityCreateRefusal === true,
    npCanCreateRedirecting: track.possibilityCreateRedirecting === true,
    npLastCreatedOnTheBasisNumber: track.lastCreatedOnTheBasisNumber || order.npLastCreatedOnTheBasisNumber || null,
    npLastCreatedOnTheBasisDocumentType: track.lastCreatedOnTheBasisDocumentType || order.npLastCreatedOnTheBasisDocumentType || null,
    npSyncedAt: now,
    novaPoshta: {
      ...(order.novaPoshta && typeof order.novaPoshta === 'object' ? order.novaPoshta : {}),
      tracking: track,
      syncedAt: now,
    },
  };

  if (track.normalizedStatus === 'in_transit') {
    patch.status = ['paid', 'completed', 'returned'].includes(order.status) ? order.status : 'shipped';
    patch.shippedAt = order.shippedAt || now;
  }

  if (track.normalizedStatus === 'unknown' && order.status === 'shipped' && order.ttnCreatedAt && order.deliveryStatus === 'shipped') {
    patch.status = 'confirmed';
    patch.deliveryStatus = 'ttn_created';
  }

  if (track.normalizedStatus === 'delivered') {
    patch.npDeliveredAt = order.npDeliveredAt || track.receivedAt || now;
    patch.npMoneyExpected = true;
    patch.settlementStatus = order.moneyReceivedConfirmed ? 'money_received' : 'awaiting_money';
    if (!order.moneyReceivedConfirmed) {
      patch.status = ['cancelled', 'returned'].includes(order.status) ? order.status : 'shipped';
      patch.paymentStatus = 'awaiting_money';
    }
  }

  if (track.documentCost > 0) {
    patch.npDeliveryCost = order.npDeliveryCost || track.documentCost;
  }
  if (track.redeliverySum > 0) {
    patch.npRedeliverySum = track.redeliverySum;
    patch.npRedeliveryStatus = track.status || order.npRedeliveryStatus || null;
    patch.npRedeliveryPaymentMethod = track.redeliveryPaymentMethod || order.npRedeliveryPaymentMethod || null;
    patch.npRedeliverySyncedAt = now;
  }

  if (track.normalizedStatus === 'returned') {
    patch.returnExpected = true;
    patch.returnSettlementStatus = order.returnReceivedConfirmed ? 'return_received' : 'awaiting_return';
    patch.paymentStatus = order.returnReceivedConfirmed ? 'returned' : 'awaiting_return';
    patch.status = 'returned';
    patch.npReturnExpectedAt = order.npReturnExpectedAt || now;
  }

  if (trackingLooksLikeReturnRoute(track, order)) {
    const basisNumber = String(track.lastCreatedOnTheBasisNumber || '').trim();
    const publicRoute = track.publicTracking && typeof track.publicTracking === 'object' ? track.publicTracking : {};
    const publicReturnNumber = String(publicRoute.returnNumber || '').trim();
    const publicCurrentNumber = String(publicRoute.currentNumber || '').trim();
    const publicRelationType = String(publicRoute.currentRelationType || '');
    const publicCurrentRelatedTtn = (
      /^\d{14,15}$/.test(publicCurrentNumber) &&
      publicCurrentNumber !== String(order.ttn || '').trim() &&
      /return|refusal|redirect|повер|возврат|відмов|отказ/i.test(publicRelationType)
    ) ? publicCurrentNumber : '';
    const publicReturnTtn = publicCurrentRelatedTtn || (/^\d{14,15}$/.test(publicReturnNumber) ? publicReturnNumber : '');
    const currentReturnCity = publicRoute.currentCity || track.city || track.senderCity || order.npReturnCity || null;
    const currentReturnWarehouse = publicRoute.currentWarehouse || track.warehouseAddress || track.warehouse || track.senderWarehouse || track.senderWarehouseAddress || order.npReturnWarehouse || null;
    patch.npReturnOldTtnActive = true;
    patch.npReturnPossible = track.possibilityCreateReturn === true;
    patch.npReturnStatus = track.status || order.npReturnStatus || null;
    patch.npReturnStatusCode = track.statusCode || order.npReturnStatusCode || null;
    patch.npReturnCity = currentReturnCity;
    patch.npReturnWarehouse = currentReturnWarehouse;
    patch.npReturnSentAt = track.dateReturnCargo || track.lastCreatedOnTheBasisDateTime || publicRoute.returnCreatedAt || track.dateMoving || publicRoute.currentDateText || order.npReturnSentAt || null;
    patch.npReturnCandidateNumber = publicReturnTtn || basisNumber || publicRoute.currentNumber || order.npReturnCandidateNumber || null;
    patch.npReturnTrackingSyncedAt = now;
    if (publicReturnTtn) {
      patch.npReturnExpressWaybillNumber = order.npReturnExpressWaybillNumber || publicReturnTtn;
    }
    if (basisNumber && /^\d{14,15}$/.test(basisNumber) && /return|повер|возврат|відмов|отказ/i.test(trackingText(track))) {
      patch.npReturnExpressWaybillNumber = order.npReturnExpressWaybillNumber || basisNumber;
    }
    if (trackingArrivedAtSender(track)) {
      patch.npReturnArrivedAt = order.npReturnArrivedAt || track.receivedAt || now;
      patch.returnSettlementStatus = order.returnReceivedConfirmed ? 'return_received' : 'awaiting_return';
    }
    if (track.normalizedStatus === 'delivered' && (publicReturnTtn || /return|refusal|повер|возврат|відмов|отказ/i.test(trackingText(track)))) {
      patch.npReturnArrivedAt = order.npReturnArrivedAt || track.receivedAt || now;
      patch.returnSettlementStatus = order.returnReceivedConfirmed ? 'return_received' : 'awaiting_return';
    }
  }

  return { ...order, ...patch, updatedAt: now };
}
function applyNovaReturnOrderToOrder(order, returnOrder) {
  if (!returnOrder) return order;
  const now = new Date().toISOString();
  const patch = {
    npReturnSyncedAt: now,
    npReturnOrderRef: returnOrder.ref || order.npReturnOrderRef || null,
    npReturnOrderNumber: returnOrder.number || order.npReturnOrderNumber || null,
    npReturnStatus: returnOrder.status || order.npReturnStatus || null,
    npReturnExpressWaybillNumber: returnOrder.expressWaybillNumber || order.npReturnExpressWaybillNumber || null,
    npReturnExpressWaybillStatus: returnOrder.expressWaybillStatus || order.npReturnExpressWaybillStatus || null,
    novaPoshta: {
      ...(order.novaPoshta && typeof order.novaPoshta === 'object' ? order.novaPoshta : {}),
      returnOrder,
      returnSyncedAt: now,
    },
    updatedAt: now,
  };
  if (returnOrder.deliveryCost > 0) {
    patch.npReturnDeliveryCost = returnOrder.deliveryCost;
  }
  return { ...order, ...patch };
}
function applyNovaReturnTrackingToOrder(order, track) {
  if (!track) return order;
  const now = new Date().toISOString();
  const patch = {
    npReturnTrackingStatus: track.normalizedStatus || null,
    npReturnStatusCode: track.statusCode || null,
    npReturnStatus: track.status || order.npReturnStatus || null,
    npReturnCity: track.city || order.npReturnCity || null,
    npReturnWarehouse: track.warehouse || order.npReturnWarehouse || null,
    npReturnSentAt: track.sentAt || order.npReturnSentAt || null,
    npReturnArrivedAt: track.receivedAt || order.npReturnArrivedAt || null,
    ...(track.normalizedStatus === 'delivered' ? {
      returnExpected: true,
      returnSettlementStatus: order.returnReceivedConfirmed ? 'return_received' : 'awaiting_return',
    } : {}),
    npReturnTrackingSyncedAt: now,
    novaPoshta: {
      ...(order.novaPoshta && typeof order.novaPoshta === 'object' ? order.novaPoshta : {}),
      returnTracking: track,
      returnTrackingSyncedAt: now,
    },
    updatedAt: now,
  };
  if (track.documentCost > 0) patch.npReturnDeliveryCost = order.npReturnDeliveryCost || track.documentCost;
  return { ...order, ...patch };
}
function cleanTtn(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}
function trackForDocument(tracks, docs, index) {
  const expected = cleanTtn(docs[index]?.DocumentNumber || docs[index]);
  if (!expected) return tracks[index] || null;
  const exact = tracks.find(track => cleanTtn(track.number) === expected);
  if (exact) return exact;
  const indexed = tracks[index] || null;
  const indexedNumber = cleanTtn(indexed?.number);
  if (indexedNumber && indexedNumber !== expected) return null;
  return indexed;
}
function parseSyncLimit(value, fallback = 100) {
  const n = Number(value || fallback);
  return Math.max(1, Math.min(100, Number.isFinite(n) ? n : fallback));
}
function sameSerializedOrder(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function dateMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}
function orderActivityMs(order = {}) {
  return Math.max(
    dateMs(order.ttnCreatedAt),
    dateMs(order.shippedAt),
    dateMs(order.updatedAt),
    dateMs(order.createdAt),
    dateMs(order.paidAt),
    dateMs(order.returnedAt)
  );
}
function orderNpSyncedMs(order = {}) {
  return Math.max(dateMs(order.npSyncedAt), dateMs(order.novaPoshta?.syncedAt));
}
function npSyncStage(order = {}) {
  const status = order.status || 'new';
  const deliveryStatus = order.deliveryStatus || '';
  if (status === 'confirmed') {
    if (!order.npSyncedAt || ['ttn_created', 'ttn_added', 'ready_for_np', 'unknown', ''].includes(deliveryStatus)) return 0;
    return 1;
  }
  if (status === 'shipped') return 2;
  if (status === 'returned') return 3;
  if (status === 'paid') return 4;
  return 5;
}
function sortNpSyncCandidates(a, b) {
  const aSynced = orderNpSyncedMs(a.order);
  const bSynced = orderNpSyncedMs(b.order);
  const aUnsynced = aSynced ? 0 : 1;
  const bUnsynced = bSynced ? 0 : 1;
  if (aUnsynced !== bUnsynced) return bUnsynced - aUnsynced;

  const stageDiff = npSyncStage(a.order) - npSyncStage(b.order);
  if (stageDiff) return stageDiff;

  const aActivity = orderActivityMs(a.order);
  const bActivity = orderActivityMs(b.order);
  if (!aSynced && !bSynced) return bActivity - aActivity || b.index - a.index;
  if (aSynced !== bSynced) return aSynced - bSynced;
  return bActivity - aActivity || b.index - a.index;
}
function selectNpSyncCandidates(orders, limit, predicate) {
  return orders
    .map((order, index) => ({ order, index }))
    .filter(item => predicate(item.order))
    .sort(sortNpSyncCandidates)
    .slice(0, limit)
    .map(item => item.order);
}
async function syncOrderWithNovaPoshta(order) {
  if (!order?.ttn) throw new Error('Order has no TTN');
  const docs = [{ DocumentNumber: String(order.ttn), Phone: novaPoshta.normalizePhone(order.phone) }];
  const [track] = await novaPoshta.trackDocuments(docs);
  if (!track) throw new Error('Nova Poshta returned no tracking data');
  let updated = applyNovaTrackingToOrder(order, track);
  if (updated.npReturnOrderRef || updated.npReturnOrderNumber || updated.status === 'returned') {
    try {
      const returnOrder = await novaPoshta.syncReturnOrderCost(updated);
      if (returnOrder) updated = applyNovaReturnOrderToOrder(updated, returnOrder);
    } catch (error) {
      updated.npReturnSyncError = error.message;
    }
  }
  const returnTtn = updated.npReturnExpressWaybillNumber || updated.npReturnOrderNumber;
  if (returnTtn) {
    try {
      const [returnTrack] = await novaPoshta.trackDocuments([String(returnTtn)]);
      if (returnTrack) updated = applyNovaReturnTrackingToOrder(updated, returnTrack);
    } catch (error) {
      updated.npReturnTrackingError = error.message;
    }
  }
  return { updated, track };
}
async function syncReturnOrdersFromNovaPoshta(orders, limit = 100) {
  const daysBack = Math.max(7, Math.min(120, Number(process.env.NP_RETURN_SYNC_DAYS || 45)));
  const pageLimit = Math.max(10, Math.min(100, Number(limit || 100)));
  const maxPages = Math.max(1, Math.min(5, Math.ceil(pageLimit / 50)));
  const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const dateFrom = [
    String(fromDate.getDate()).padStart(2, '0'),
    String(fromDate.getMonth() + 1).padStart(2, '0'),
    fromDate.getFullYear(),
  ].join('.');
  let changed = 0;
  let checked = 0;
  const errors = [];
  const returns = [];
  const touched = new Map();
  const trackRequests = [];

  for (let page = 1; page <= maxPages; page++) {
    try {
      const batch = await novaPoshta.getReturnOrdersList({
        dateFrom,
        page,
        limit: 50,
      });
      returns.push(...batch);
      if (batch.length < 50) break;
    } catch (error) {
      errors.push({ step: 'return-orders-list', error: error.message });
      break;
    }
  }

  for (const returnOrder of returns.slice(0, pageLimit)) {
    checked++;
    const candidates = [
      returnOrder.ref,
      returnOrder.documentNumber,
      returnOrder.expressWaybillNumber,
      returnOrder.number,
    ].map(value => String(value || '').trim()).filter(Boolean);
    const idx = orders.findIndex(order => candidates.some(value => (
      String(order.ttn || '').trim() === value ||
      String(order.npReturnExpressWaybillNumber || '').trim() === value ||
      String(order.npReturnOrderNumber || '').trim() === value ||
      String(order.npReturnOrderRef || '').trim() === value
    )));
    if (idx < 0) continue;
    if (!touched.has(idx)) touched.set(idx, JSON.stringify(orders[idx]));
    orders[idx] = applyNovaReturnOrderToOrder(orders[idx], returnOrder);
    const returnTtn = orders[idx].npReturnExpressWaybillNumber || orders[idx].npReturnOrderNumber;
    if (returnTtn) {
      trackRequests.push({ idx, ttn: String(returnTtn) });
    }
  }

  const uniqueDocs = [...new Map(trackRequests.map(item => [cleanTtn(item.ttn), item])).values()]
    .map(item => ({ DocumentNumber: item.ttn }));
  if (uniqueDocs.length) {
    try {
      const tracks = await novaPoshta.trackDocuments(uniqueDocs);
      const byNumber = new Map(tracks.map(track => [cleanTtn(track.number), track]));
      for (const item of trackRequests) {
        const track = byNumber.get(cleanTtn(item.ttn));
        if (!track) continue;
        if (!touched.has(item.idx)) touched.set(item.idx, JSON.stringify(orders[item.idx]));
        orders[item.idx] = applyNovaReturnTrackingToOrder(orders[item.idx], track);
      }
    } catch (error) {
      errors.push({ step: 'return-tracking-batch', error: error.message });
    }
  }

  for (const [idx, before] of touched.entries()) {
    if (JSON.stringify(orders[idx]) !== before) changed++;
  }

  return { checked, changed, errors, found: returns.length };
}
async function linkManualNovaPoshtaTtn(order, orders = read(F.orders)) {
  if (!canAutoLinkManualNpOrder(order)) return { linked: false, reason: 'not_eligible' };
  const daysBack = Math.max(1, Math.min(90, Number(process.env.NP_MANUAL_LOOKBACK_DAYS || 21)));
  const docs = await novaPoshta.findDocumentsByRecipientPhone(order.phone, { daysBack });
  const available = docs.filter(doc => doc.ttn && !ttnAlreadyUsed(orders, doc.ttn, order.id));
  if (!available.length) return { linked: false, reason: 'not_found', checked: docs.length };
  const picked = available[0];
  const now = new Date().toISOString();
  return {
    linked: true,
    ttn: picked.ttn,
    order: {
      ...order,
      ttn: picked.ttn,
      npRef: picked.ref || order.npRef || null,
      npStatus: picked.status || order.npStatus || null,
      deliveryStatus: order.deliveryStatus || 'ttn_added',
      manualTtnAutoLinked: true,
      manualTtnAutoLinkedAt: now,
      novaPoshta: {
        ...(order.novaPoshta && typeof order.novaPoshta === 'object' ? order.novaPoshta : {}),
        manualDocument: picked,
        linkedAt: now,
      },
      updatedAt: now,
    },
    document: picked,
  };
}
async function syncOpenNovaPoshtaOrders(limit = 100, options = {}) {
  const startedAt = Date.now();
  const orders = read(F.orders);
  const baseOrders = orders.slice();
  let changed = 0;
  const errors = [];
  const safeLimit = parseSyncLimit(limit);
  const includeManualLink = options.includeManualLink !== false;
  const includeReturns = options.includeReturns !== false;
  const linkCandidatePool = includeManualLink ? orders.filter(canAutoLinkManualNpOrder) : [];
  const linkCandidates = includeManualLink
    ? selectNpSyncCandidates(orders, safeLimit, canAutoLinkManualNpOrder)
    : [];

  if (linkCandidates.length) {
    try {
      const daysBack = Math.max(1, Math.min(90, Number(process.env.NP_MANUAL_LOOKBACK_DAYS || 21)));
      const docs = await novaPoshta.getDocumentList({ daysBack, getFullList: true });
      const recentDocs = Array.isArray(docs) ? docs : [];
      for (const order of linkCandidates) {
        const idx = orders.findIndex(x => x.id === order.id);
        if (idx < 0 || orders[idx].ttn) continue;
        const target = novaPoshta.normalizePhone(orders[idx].phone);
        if (!target) continue;
        const picked = recentDocs.find(doc => {
          const phone = novaPoshta.normalizePhone(doc.recipientPhone || doc.raw?.RecipientPhone || '');
          if (!phone) return false;
          return doc.ttn && phone && (phone === target || phone.endsWith(target) || target.endsWith(phone)) &&
            !ttnAlreadyUsed(orders, doc.ttn, orders[idx].id);
        });
        if (!picked) continue;
        const linked = {
          linked: true,
          ttn: picked.ttn,
          order: {
            ...orders[idx],
            ttn: picked.ttn,
            npRef: picked.ref || orders[idx].npRef || null,
            npStatus: picked.status || orders[idx].npStatus || null,
            deliveryStatus: orders[idx].deliveryStatus || 'ttn_added',
            manualTtnAutoLinked: true,
            manualTtnAutoLinkedAt: new Date().toISOString(),
            novaPoshta: {
              ...(orders[idx].novaPoshta && typeof orders[idx].novaPoshta === 'object' ? orders[idx].novaPoshta : {}),
              manualDocument: picked,
              linkedAt: new Date().toISOString(),
            },
            updatedAt: new Date().toISOString(),
          },
        };
        orders[idx] = linked.order;
        changed++;
      }
    } catch (error) {
      errors.push({ step: 'manual-link-batch', checked: linkCandidates.length, error: error.message });
    }
  }

  const candidatePool = orders.filter(isOrderActiveForNpSync);
  const candidates = selectNpSyncCandidates(orders, safeLimit, isOrderActiveForNpSync);
  const docs = candidates.map(order => ({
    DocumentNumber: String(order.ttn),
    Phone: novaPoshta.normalizePhone(order.phone),
  }));

  if (docs.length) {
    try {
      const tracks = await novaPoshta.trackDocuments(docs);
      for (let i = 0; i < candidates.length; i++) {
        const order = candidates[i];
        const idx = orders.findIndex(x => x.id === order.id);
        if (idx < 0) continue;
        const track = trackForDocument(tracks, docs, i);
        if (!track) {
          errors.push({ orderId: order.id, ttn: order.ttn, error: 'Nova Poshta returned no tracking data' });
          continue;
        }
        const before = orders[idx];
        const updated = applyNovaTrackingToOrder(orders[idx], track);
        if (!sameSerializedOrder(before, updated)) {
          orders[idx] = updated;
          changed++;
        }
      }
    } catch (error) {
      errors.push({ step: 'tracking-batch', checked: candidates.length, error: error.message });
      const fallbackLimit = Math.max(0, Math.min(candidates.length, Number(process.env.NP_SYNC_BATCH_FALLBACK_LIMIT || 10)));
      for (const order of candidates.slice(0, fallbackLimit)) {
        const idx = orders.findIndex(x => x.id === order.id);
        if (idx < 0) continue;
        try {
          const { updated } = await syncOrderWithNovaPoshta(orders[idx]);
          if (!sameSerializedOrder(orders[idx], updated)) {
            orders[idx] = updated;
            changed++;
          }
        } catch (fallbackError) {
          errors.push({ orderId: order.id, ttn: order.ttn, error: fallbackError.message, step: 'tracking-fallback' });
        }
      }
    }
  }

  const returnSync = includeReturns
    ? await syncReturnOrdersFromNovaPoshta(orders, safeLimit)
    : { checked: 0, changed: 0, errors: [], found: 0 };
  changed += returnSync.changed;
  errors.push(...returnSync.errors);
  if (changed) {
    const persisted = await persistNovaPoshtaOrderChanges(baseOrders, orders);
    changed = persisted.changed;
    for (const conflict of persisted.conflicts) {
      errors.push({ step: 'concurrent-merge', orderId: conflict.id, fields: conflict.fields });
    }
    for (const missingId of persisted.missingIds) {
      errors.push({ step: 'concurrent-delete', orderId: missingId });
    }
  }
  return {
    checked: candidates.length,
    candidatePool: candidatePool.length,
    linkChecked: linkCandidates.length,
    linkCandidatePool: linkCandidatePool.length,
    returnChecked: returnSync.checked,
    returnFound: returnSync.found,
    changed,
    errors,
    durationMs: Date.now() - startedAt,
  };
}

function normalizeNpSyncOptions(options = {}) {
  return {
    limit: parseSyncLimit(options.limit || process.env.NP_SYNC_LIMIT || 100),
    source: sanitizeStr(options.source || 'manual', 40),
    includeManualLink: options.includeManualLink !== false,
    includeReturns: options.includeReturns !== false,
  };
}

function serializeNpSyncJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    status: job.status,
    source: job.source,
    limit: job.limit,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    requestedAt: job.requestedAt || null,
    durationMs: job.durationMs || job.result?.durationMs || null,
    result: job.result || null,
    error: job.error || null,
    errorDetails: job.errorDetails || null,
  };
}

function novaPoshtaSyncStatus() {
  return {
    running: !!npSyncState.current,
    current: serializeNpSyncJob(npSyncState.current),
    queued: serializeNpSyncJob(npSyncState.queued),
    last: serializeNpSyncJob(npSyncState.last),
    scheduled: !!npSyncState.timer,
  };
}

function startNovaPoshtaSync(options = {}) {
  const normalized = normalizeNpSyncOptions(options);
  if (npSyncState.current) {
    npSyncState.queued = {
      id: npSyncState.nextJobId++,
      ...normalized,
      status: 'queued',
      requestedAt: new Date().toISOString(),
    };
    return { started: false, queued: true, status: novaPoshtaSyncStatus() };
  }

  const job = {
    id: npSyncState.nextJobId++,
    ...normalized,
    status: 'running',
    startedAt: new Date().toISOString(),
  };
  npSyncState.current = job;
  job.promise = (async () => {
    try {
      const result = await syncOpenNovaPoshtaOrders(job.limit, job);
      job.status = 'finished';
      job.finishedAt = new Date().toISOString();
      job.durationMs = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
      job.result = result;
      if (result.checked || result.linkChecked || result.returnChecked || result.errors.length) {
        console.log('[NovaPoshta sync]', serializeNpSyncJob(job));
      }
      return result;
    } catch (error) {
      job.status = 'failed';
      job.finishedAt = new Date().toISOString();
      job.durationMs = new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime();
      job.error = error.message;
      job.errorDetails = error.details || {};
      console.error('[NovaPoshta sync]', error.message);
      return { checked: 0, linkChecked: 0, returnChecked: 0, returnFound: 0, changed: 0, errors: [{ error: error.message }], durationMs: job.durationMs };
    } finally {
      npSyncState.last = { ...job };
      delete npSyncState.last.promise;
      npSyncState.current = null;
      const queued = npSyncState.queued;
      npSyncState.queued = null;
      if (queued) {
        setTimeout(() => startNovaPoshtaSync(queued), 1000).unref?.();
      }
    }
  })();
  return { started: true, queued: false, status: novaPoshtaSyncStatus() };
}

async function runNovaPoshtaSyncNow(options = {}) {
  const start = startNovaPoshtaSync(options);
  if (!start.started) return { running: true, queued: start.queued, ...start.status };
  const current = npSyncState.current;
  const result = await current.promise;
  if (current.status === 'failed') {
    const error = new Error(current.error || 'Nova Poshta sync failed');
    error.details = current.errorDetails || {};
    throw error;
  }
  return { success: true, ...result };
}

function scheduleNovaPoshtaSync(options = {}, delayMs = 0) {
  if (!novaPoshta.configStatus().apiConfigured) return null;
  if (npSyncState.timer) return { scheduled: true, existing: true, status: novaPoshtaSyncStatus() };
  const waitMs = Math.max(0, Number(delayMs || 0));
  npSyncState.timer = setTimeout(() => {
    npSyncState.timer = null;
    startNovaPoshtaSync(options);
  }, waitMs);
  npSyncState.timer.unref?.();
  return { scheduled: true, waitMs, status: novaPoshtaSyncStatus() };
}

function escapeHtml(val) {
  return String(val || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function orderQueueNoticeText(latestOrder = null) {
  const orders = read(F.orders);
  const fresh = orders.filter(o => (o.status || 'new') === 'new');
  const latest = latestOrder || fresh[fresh.length - 1] || orders[orders.length - 1] || null;
  const now = new Date().toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

  let text = fresh.length
    ? `🆕 <b>Нові замовлення</b>\nВ черзі: <b>${fresh.length}</b>`
    : `✅ <b>Нових замовлень немає</b>\nВ черзі: <b>0</b>`;

  if (latest) {
    text +=
      `\n\nОстаннє: <b>#${escapeHtml(latest.id)}</b> ${escapeHtml(latest.name || '—')}` +
      `\n📱 ${escapeHtml(latest.phone || '—')}` +
      `\n👟 ${escapeHtml(latest.size || '—')}` +
      (latest.product ? ` · ${escapeHtml(latest.product)}` : '') +
      (latest.price ? `\n💵 ${escapeHtml(latest.price)} грн` : '');
  }

  text += `\n\nОновлено: <code>${escapeHtml(now)}</code>`;
  return text;
}

let orderQueueNoticeTail = Promise.resolve();

async function sendOrderQueueNotice(latestOrder = null) {
  if (!TG_TOKEN || !TG_CHAT_ID) return null;
  const state = read(F.orderNotify);
  const messageId = state && !Array.isArray(state) ? state.messageId : null;
  const latestId = latestOrder?.id || null;
  const keyboard = { reply_markup: { inline_keyboard: [
    ...(latestId ? [[{ text: `Відкрити #${latestId}`, callback_data: `od_${latestId}` }]] : []),
    [{ text: '📦 Всі замовлення', callback_data: 'orders' }, { text: '🚚 Відстеження', callback_data: 'track_menu' }],
  ] } };
  const text = orderQueueNoticeText(latestOrder);

  if (messageId) {
    const edited = await tgEdit(TG_CHAT_ID, messageId, text, keyboard);
    if (edited?.ok) {
      write(F.orderNotify, { messageId, updatedAt: new Date().toISOString() });
      return edited;
    }
  }

  const sent = await tg(text, keyboard);
  if (sent?.ok && sent.result?.message_id) {
    write(F.orderNotify, { messageId: sent.result.message_id, updatedAt: new Date().toISOString() });
  }
  return sent;
}

function updateOrderQueueNotice(latestOrder = null) {
  const task = orderQueueNoticeTail.then(() => sendOrderQueueNotice(latestOrder));
  orderQueueNoticeTail = task.catch(() => {});
  return task;
}

const supportAiHistory = Object.create(null);
const supportAiUsage = Object.create(null);
const supportSessionLocks = new Map();
const SUPPORT_SIZE_CHART = {
  36: '23 см',
  37: '23.5 см',
  38: '24 см',
  39: '24.5 см',
  40: '25 см',
};
const SUPPORT_AI_SYSTEM_PROMPT = `
You are the ${SHOP_NAME} store support assistant and first-line manager.
Answer customers in the same language they use: Ukrainian, Russian, or simple mixed UA/RU. Be warm, concise, and practical.

Store facts you may use:
- Product: ${PRODUCT_NAME}, ${PRODUCT_DESCRIPTION}.
- Upper: ${PRODUCT_UPPER}. Sole: ${PRODUCT_SOLE}.
- Best for: ${PRODUCT_BEST_FOR}.
- Sizes on site: 36, 37, 38, 39, 40.
- Insole length chart: 36 = 23 cm, 37 = 23.5 cm, 38 = 24 cm, 39 = 24.5 cm, 40 = 25 cm.
- Promo price: ${PRODUCT_PRICE} UAH. Old price: ${PRODUCT_OLD_PRICE} UAH.
- Payment: only after inspection/fitting on delivery, no prepayment.
- Delivery: Nova Poshta across Ukraine.
- Exchange: 14 days.
- Order flow: customer leaves name, phone, and size in the site form. They can choose Telegram contact without a call. A manager confirms details.
- Trust signals: 4.9 rating, 430+ orders this month.

Rules:
- Stay strictly on product, size, price, delivery, payment, exchange, order flow, and support for this site.
- Do not invent unavailable facts such as exact delivery price, exact stock per size, or guarantees not listed above.
- Do not ask for a human operator if you can answer from the facts.
- Request a human only when the customer explicitly asks for a person/operator/manager, complains about an existing order, asks to change/cancel an order, or sends unclear context after one short clarification would not be enough.
- For spam, random letters, insults, adult/sexual questions, tests, and unrelated topics, do not request a human. Use action "answer" and briefly say that you only help with ${PRODUCT_NAME}, sizes, price, delivery, payment, exchange, or ordering.
- If a customer asks for a fact not listed here, do not invent it. Use action "answer", say what is known, and offer to leave the question for a manager only if they want.
- Never collect full personal data in chat. Direct the customer to the order form for name, phone, and size.

Return only compact JSON:
{"action":"answer","reply":"..."} or {"action":"handoff","reply":"...","reason":"..."}
`;

function supportSessionKey(sessionId, fallbackId = null) {
  const value = String(sessionId || fallbackId || '').trim();
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) return '';
  return ['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase()) ? '' : value;
}

async function withSupportSessionLock(sessionId, task) {
  const key = supportSessionKey(sessionId, 'anonymous');
  const previous = supportSessionLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  supportSessionLocks.set(key, current);
  await previous;
  try { return await task(); }
  finally {
    release();
    if (supportSessionLocks.get(key) === current) supportSessionLocks.delete(key);
  }
}

// Different support sessions still share one JSON file. Keep its read/modify/write
// sections serialized, but never hold this lock while waiting for AI or Telegram.
let supportMutationTail = Promise.resolve();
async function withSupportMutationLock(task) {
  const previous = supportMutationTail;
  let release;
  supportMutationTail = new Promise(resolve => { release = resolve; });
  await previous;
  try { return await task(); }
  finally { release(); }
}

function supportRecordIsOpen(record) {
  if (record?.status) return record.status !== 'closed';
  return !record?.answered;
}

function findOpenSupportIndex(msgs, sessionId) {
  const key = supportSessionKey(sessionId);
  if (!key) return -1;
  let idx = msgs.findIndex(m => supportSessionKey(m.sessionId, m.id) === key && supportRecordIsOpen(m));
  if (idx >= 0) return idx;
  const numeric = Number(key);
  return Number.isFinite(numeric) ? msgs.findIndex(m => m.id === numeric && supportRecordIsOpen(m)) : -1;
}

function updateSupportRecord(sessionId, patch) {
  const msgs = read(F.support);
  const idx = findOpenSupportIndex(msgs, sessionId);
  if (idx < 0) return null;
  msgs[idx] = { ...msgs[idx], ...patch, id: msgs[idx].id, updatedAt: new Date().toISOString() };
  write(F.support, msgs);
  return msgs[idx];
}

function supportMessage(role, text, at = new Date().toISOString(), extra = {}) {
  return { role, text: sanitizeStr(text, 2000), at, ...extra };
}

function supportTranscript(record) {
  if (Array.isArray(record?.messages)) return record.messages;
  return record?.message ? [supportMessage('user', record.message, record.timestamp || record.createdAt)] : [];
}

function asIsoSupportDate(value, fallback = new Date().toISOString()) {
  if (!value) return fallback;
  const parsed = new Date(value || 0);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

function resolveSupportCustomer(raw = {}) {
  const orderId = Number(raw?.orderId || 0);
  if (orderId) {
    const order = read(F.orders).find(item => Number(item.id) === orderId);
    if (order) return {
      name: sanitizeStr(order.fullName || order.name, 140) || null,
      phone: sanitizeStr(order.phone, 30) || null,
      orderId: order.id,
    };
  }
  return {
    name: sanitizeStr(raw?.name, 140) || null,
    phone: sanitizeStr(raw?.phone, 30) || null,
    orderId: null,
  };
}

function supportFallbackSummary(record, managerRequired = false) {
  const messages = supportTranscript(record);
  const firstUser = messages.find(item => item.role === 'user')?.text || record.message || 'Звернення до підтримки';
  const lastAi = [...messages].reverse().find(item => item.role === 'ai')?.text || '';
  return {
    topic: sanitizeStr(firstUser, 180),
    wanted: sanitizeStr(firstUser, 180),
    resolved: !managerRequired && !!lastAi,
    managerRequired,
    managerAction: managerRequired ? sanitizeStr(record.handoffReason || 'Зв’язатися з клієнтом і вирішити запит', 180) : '',
  };
}

function isLikelyLowValueSupportMessage(text) {
  const compact = String(text || '').trim();
  const letters = compact.replace(/[^a-zа-яіїєґё0-9]/gi, '');
  if (compact.length < 2) return true;
  if (letters.length < 2) return true;
  if (/^(.)\1{3,}$/i.test(letters)) return true;
  if (/^(test|тест|asdf|qwerty|йцукен|fdfd|dfdf|fgfg|fggf|хз|xs)$/i.test(letters)) return true;
  const vowels = (letters.match(/[aeiouyаеёиоуыэюяіїє]/gi) || []).length;
  return letters.length >= 5 && vowels === 0;
}

function wantsHumanOperator(text) {
  return /(оператор|менеджер|людин|человек|жив[а-яіїєґ]*|human|operator|manager|support|позвон|подзвон|передзвон|звонок|дзвінок)/i.test(text);
}

function supportIssueNeedsManager(text) {
  const message = String(text || '').toLowerCase();
  if (wantsHumanOperator(message)) return true;
  return (
    /(?:скас|отмен)[а-яіїєґ\s]{0,24}(?:замов|заказ)/i.test(message) ||
    /(?:змін|измен)[а-яіїєґ\s]{0,30}(?:замов|заказ|адрес|телефон|розмір|размер|відділен|отделен)/i.test(message) ||
    /(?:де|где|статус)[а-яіїєґ\s]{0,24}(?:замов|заказ|посил|посыл)/i.test(message) ||
    /(?:не\s+(?:прийш|пришел|пришла|отрим|получ)|затрим|задерж)[а-яіїєґ\s]{0,30}(?:замов|заказ|посил|посыл|достав)/i.test(message) ||
    /(?:претенз|скарг|жалоб|брак|пошкод|поврежд|не\s+той|не\s+тот|не\s+та)[а-яіїєґ\s]{0,40}/i.test(message) ||
    /(?:повернут|повернути|вернуть|возврат)[а-яіїєґ\s]{0,24}(?:замов|заказ|товар|пару)/i.test(message) ||
    /(?:проблем)[а-яіїєґ\s]{0,24}(?:достав|оплат|замов|заказ|посил|посыл)/i.test(message)
  );
}

function offTopicSupportReply(text) {
  const msg = String(text || '').toLowerCase();
  if (/(дроч|мастурб|секс|порн|хуй|хуя|пизд|піс[ья]|соси|еба|їба|fuck|sex|porn|dick|cock|pussy)/i.test(msg)) {
    return `Я допомагаю тільки з ${PRODUCT_NAME}: розмір, устілка, ціна, доставка, оплата або оформлення замовлення.`;
  }
  if (/(політик|крипт|казино|ставк|наркот|збро|оруж|домашк|реферат|анекдот|погода|курс валют)/i.test(msg)) {
    return `Я можу підказати тільки по ${PRODUCT_NAME}: розміри, устілка, ціна, доставка, оплата, обмін або замовлення.`;
  }
  return null;
}

function localSupportReply(text) {
  const msg = String(text || '').toLowerCase();
  const offTopic = offTopicSupportReply(msg);
  if (offTopic) return offTopic;

  const sizeMatch = msg.match(/\b(36|37|38|39|40)\b/);
  const asksInsole = /(устіл|устел|стельк|устил|сант|см|centimeter|centimetre|cm)/i.test(msg);
  const asksSize = /(розмір|размер|size|підійде|подойдет|нога|стоп)/i.test(msg);

  if ((asksInsole || asksSize) && sizeMatch && SUPPORT_SIZE_CHART[sizeMatch[1]]) {
    const size = sizeMatch[1];
    return `На ${size} розмір устілка орієнтовно ${SUPPORT_SIZE_CHART[size]}. Можна оформити замовлення без передоплати: на Новій Пошті оглянете, приміряєте і тоді оплатите.`;
  }

  if ((asksInsole || asksSize) && /(таблиц|сетка|сітка|устіл|стельк|сант|см|розмір|размер|size)/i.test(msg)) {
    return `Розмірна сітка по устілці: 36 — 23 см, 37 — 23.5 см, 38 — 24 см, 39 — 24.5 см, 40 — 25 см. Оплата тільки після огляду та примірки.`;
  }

  if (/(ціна|цена|скільки кошту|сколько сто|вартість|стоимость|price|грн|895)/i.test(msg)) {
    return `Зараз акційна ціна ${PRODUCT_NAME} — ${PRODUCT_PRICE} грн замість ${PRODUCT_OLD_PRICE} грн. Передоплати немає: оплата після огляду та примірки на Новій Пошті.`;
  }

  if (/(достав|нова пошта|новою поштою|посилк|відправ|отправ|delivery)/i.test(msg)) {
    return `Доставляємо Новою Поштою по Україні. Ви оглядаєте і приміряєте пару при отриманні, оплата тільки після цього.`;
  }

  if (/(оплат|передоплат|налож|наклад|після примір|после пример|при отрим|при получ)/i.test(msg)) {
    return `Передоплати немає. Оплата тільки після огляду та примірки при отриманні на Новій Пошті.`;
  }

  if (/(обмін|обмен|поверн|возврат|14)/i.test(msg)) {
    return `Обмін доступний протягом 14 днів. Якщо розмір не підійде, менеджер допоможе з обміном.`;
  }

  if (/(замов|заказ|оформ|купить|купити|хочу|беру)/i.test(msg)) {
    return `Щоб оформити замовлення, оберіть розмір на сайті й залиште ім'я та телефон у формі. Менеджер підтвердить деталі. Можна обрати зв'язок через Telegram без дзвінка.`;
  }

  if (/(матеріал|материал|якість|качество|верх|підош|подош|колір|цвет|крос|сандал)/i.test(msg)) {
    return `${PRODUCT_NAME}: ${PRODUCT_DESCRIPTION}. Верх: ${PRODUCT_UPPER}, підошва: ${PRODUCT_SOLE}.`;
  }

  return null;
}

function geminiEndpoint() {
  const model = GEMINI_MODEL.startsWith('models/') ? GEMINI_MODEL : `models/${GEMINI_MODEL}`;
  return `https://generativelanguage.googleapis.com/v1beta/${model}:generateContent`;
}

function parseGeminiJson(raw) {
  const text = String(raw || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

async function askSupportAi(sessionId, message, savedTranscript = []) {
  if (!SUPPORT_AI_ENABLED || !GEMINI_API_KEY) return null;
  const key = supportSessionKey(sessionId, 'anonymous');
  supportAiUsage[key] = supportAiUsage[key] || 0;
  if (supportAiUsage[key] >= SUPPORT_AI_MAX_PER_SESSION) {
    return { action: 'handoff', reply: 'Передаю діалог менеджеру, щоб не ганяти вас по колу. Він підключиться й допоможе.', reason: 'ai_session_limit' };
  }

  const persistedHistory = Array.isArray(savedTranscript)
    ? savedTranscript.filter(item => ['user', 'ai'].includes(item.role) && item.text).slice(-8).map(item => ({
      role: item.role === 'ai' ? 'model' : 'user',
      parts: [{ text: sanitizeStr(item.text, 1200) }],
    }))
    : [];
  const history = (persistedHistory.length ? persistedHistory : (supportAiHistory[key] || [])).slice(-8);
  supportAiUsage[key]++;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const r = await fetch(geminiEndpoint(), {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SUPPORT_AI_SYSTEM_PROMPT }] },
        contents: [
          ...history,
          { role: 'user', parts: [{ text: message }] },
        ],
        generationConfig: {
          temperature: 0.35,
          topP: 0.85,
          maxOutputTokens: 360,
          responseMimeType: 'application/json',
        },
      }),
    });
    const data = await r.json().catch(() => null);
    clearTimeout(timer);
    if (!r.ok) {
      console.error('[Gemini]', r.status, data?.error?.message || 'request failed');
      return null;
    }

    const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
    const parsed = parseGeminiJson(raw);
    if (!parsed || !parsed.reply) return null;

    const action = parsed.action === 'handoff' ? 'handoff' : 'answer';
    const reply = sanitizeStr(parsed.reply, 900);
    if (!reply) return null;

    supportAiHistory[key] = [
      ...history,
      { role: 'user', parts: [{ text: message }] },
      { role: 'model', parts: [{ text: reply }] },
    ].slice(-10);

    return { action, reply, reason: sanitizeStr(parsed.reason || '', 120) };
  } catch (e) {
    clearTimeout(timer);
    console.error('[Gemini]', e.name === 'AbortError' ? 'timeout' : e.message);
    return null;
  }
}

async function summarizeSupportConversation(record, managerRequired = false) {
  const fallback = supportFallbackSummary(record, managerRequired);
  if (!SUPPORT_AI_ENABLED || !GEMINI_API_KEY) return fallback;
  const transcript = supportTranscript(record).slice(-14)
    .map(item => `${item.role}: ${sanitizeStr(item.text, 600)}`)
    .join('\n');
  if (!transcript) return fallback;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(geminiEndpoint(), {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: 'Create a very short Ukrainian support summary. Return JSON only. Do not copy the whole dialogue.' }] },
        contents: [{ role: 'user', parts: [{ text:
          `Conversation:\n${transcript}\n\nReturn: {"topic":"...","wanted":"...","resolved":true,"managerRequired":${managerRequired},"managerAction":"..."}`,
        }] }],
        generationConfig: { temperature: 0.15, maxOutputTokens: 220, responseMimeType: 'application/json' },
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) return fallback;
    const raw = data?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('');
    const parsed = parseGeminiJson(raw);
    if (!parsed) return fallback;
    return {
      topic: sanitizeStr(parsed.topic || fallback.topic, 180),
      wanted: sanitizeStr(parsed.wanted || fallback.wanted, 180),
      resolved: managerRequired ? false : parsed.resolved !== false,
      managerRequired,
      managerAction: managerRequired ? sanitizeStr(parsed.managerAction || fallback.managerAction, 180) : '',
    };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

async function notifySupportRequest(msg, mode = 'new') {
  const ts = new Date(msg.timestamp || msg.updatedAt || Date.now()).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  const customer = msg.customer || {};
  const summary = msg.summary || supportFallbackSummary(msg, mode === 'handoff');
  const title = mode === 'handoff'
    ? `🤝 <b>ПОТРІБЕН МЕНЕДЖЕР #${msg.id}</b>`
    : mode === 'history'
      ? `🤖 <b>ДІАЛОГ З AI ЗАВЕРШЕНО #${msg.id}</b>`
    : mode === 'dialog'
      ? `💬 <b>НОВЕ ПОВІДОМЛЕННЯ В ДІАЛОЗІ #${msg.id}</b>`
      : `🎧 <b>ПІДТРИМКА #${msg.id}</b>`;
  const text = mode === 'history'
    ? `${title}\n━━━━━━━━━━━━━━\n` +
      `👤 ${escapeHtml(customer.name || msg.sessionId || msg.id)}\n` +
      `💬 Тема: ${escapeHtml(summary.topic)}\n` +
      `✅ Вирішено: <b>${summary.resolved ? 'так' : 'ні'}</b>\n` +
      `🕒 Завершено: ${ts}`
    : `${title}\n━━━━━━━━━━━━━━\n` +
      `👤 ${escapeHtml(customer.name || 'Не вказано')}\n` +
      (customer.phone ? `📱 ${escapeHtml(customer.phone)}\n` : '') +
      (customer.orderId ? `📦 Замовлення #${escapeHtml(customer.orderId)}\n` : '') +
      `📝 Суть: ${escapeHtml(summary.topic || msg.message)}\n` +
      `🎯 Потрібно: ${escapeHtml(summary.managerAction || msg.handoffReason || 'Відповісти клієнту')}\n` +
      `🕒 ${ts}`;

  const keyboard = ['dialog', 'history'].includes(mode) ? undefined : {
    reply_markup: { inline_keyboard: [[
      { text: '✋ Прийняти діалог', callback_data: `accept_${msg.sessionId || msg.id}` },
    ]] },
  };

  if (mode === 'dialog' && msg.managerId) {
    await tgTo(msg.managerId, text, keyboard || {});
    if (TG_CHAT_ID && String(TG_CHAT_ID) !== String(msg.managerId)) await tg(text);
    return;
  }
  await tg(text, keyboard || {});
}

let supportFinalizeRunning = false;
async function finalizeDueSupportConversations() {
  if (supportFinalizeRunning) return;
  supportFinalizeRunning = true;
  try {
    const snapshot = read(F.support);
    const due = snapshot.filter(record => (
      record.category === 'ai_history' &&
      record.status === 'active' &&
      !record.summaryNotifiedAt &&
      new Date(record.summaryDueAt || 0).getTime() <= Date.now()
    ));
    for (const candidate of due) {
      const summary = await summarizeSupportConversation(candidate, false);
      await withSupportSessionLock(candidate.sessionId || candidate.id, async () => {
        const records = read(F.support);
        const idx = records.findIndex(item => item.id === candidate.id);
        if (idx < 0 || records[idx].summaryNotifiedAt || records[idx].status !== 'active') return;
        const now = new Date().toISOString();
        records[idx] = {
          ...records[idx], summary, status: 'closed', answered: true,
          completedAt: now, summaryNotifiedAt: now, updatedAt: now,
        };
        write(F.support, records);
        await notifySupportRequest(records[idx], 'history');
      });
    }
  } finally {
    supportFinalizeRunning = false;
  }
}

const supportFinalizeTimer = setInterval(() => {
  finalizeDueSupportConversations().catch(error => console.error('[support summary]', error.message));
}, 60 * 1000);
if (supportFinalizeTimer.unref) supportFinalizeTimer.unref();

function normalizePhoneForZvonok(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 && digits.startsWith('0')) return `+38${digits}`;
  if (digits.length === 12 && digits.startsWith('380')) return `+${digits}`;
  if (raw.startsWith('+')) return `+${digits}`;
  return `+${digits}`;
}

function makeZvonokLabel(order) {
  const random = Math.random().toString(36).slice(2, 8);
  return `order_${order.id}_${Date.now()}_${random}`;
}

function samePhone(a, b) {
  const da = String(a || '').replace(/\D/g, '');
  const db = String(b || '').replace(/\D/g, '');
  return !!da && !!db && (da === db || da.endsWith(db) || db.endsWith(da));
}

function getRequestBaseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function buildZvonokWebhookUrl(req, order, button) {
  const base = APP_PUBLIC_URL || getRequestBaseUrl(req);
  if (!base) return '';
  const url = new URL('/api/zvonok/ivr', base);
  url.searchParams.set('orderId', order.id);
  url.searchParams.set('button', button);
  if (ZVONOK_WEBHOOK_SECRET) url.searchParams.set('secret', ZVONOK_WEBHOOK_SECRET);
  return url.toString();
}

async function startZvonokCall(order, req) {
  if (!ZVONOK_API_KEY || !ZVONOK_CAMPAIGN_ID || !ZVONOK_WEBHOOK_SECRET) {
    console.warn('[Zvonok] skipped: API, campaign, or webhook authentication is not configured');
    return null;
  }

  const phone = normalizePhoneForZvonok(order.phone);
  if (!phone) {
    console.warn(`[Zvonok] skipped order #${order.id}: invalid phone`);
    return null;
  }

  const form = new FormData();
  form.append('public_key', ZVONOK_API_KEY);
  form.append('campaign_id', ZVONOK_CAMPAIGN_ID);
  form.append('phone', phone);
  form.append('label', makeZvonokLabel(order));

  const btn1Webhook = buildZvonokWebhookUrl(req, order, 1);
  const btn2Webhook = buildZvonokWebhookUrl(req, order, 2);
  if (btn1Webhook) form.append('ivr_lvl_1_btn_1_webhook', btn1Webhook);
  if (btn2Webhook) form.append('ivr_lvl_1_btn_2_webhook', btn2Webhook);

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 8000);
  try {
    const response = await fetch(ZVONOK_CALL_URL, { method: 'POST', body: form, signal: ctrl.signal });
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch {}
    console.log(`[Zvonok] order #${order.id} call start: ${response.status}`);
    return { ok: response.ok, status: response.status };
  } catch (e) {
    console.error(`[Zvonok] order #${order.id} call start failed:`, e.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function findOrderIndexByZvonokPayload(orders, payload) {
  const rawOrderId = payload.orderId || payload.order_id || payload.order || payload.id || payload.client_id;
  let orderId = Number(rawOrderId);
  if (!orderId && payload.label) {
    const match = String(payload.label).match(/order[_-](\d+)/i);
    if (match) orderId = Number(match[1]);
  }
  if (orderId) {
    const byId = orders.findIndex(o => o.id === orderId);
    if (byId >= 0) return byId;
  }

  const phone = payload.phone || payload.Phone || payload.called_phone || payload.customer_phone;
  if (phone) return orders.findLastIndex(o => samePhone(o.phone, phone));
  return -1;
}

function getZvonokDigit(payload) {
  const value = payload.button || payload.digit || payload.button_num || payload.ivr_button || payload.key || payload.user_choice;
  const match = String(value || '').match(/[12]/);
  return match ? match[0] : '';
}

function getZvonokStatus(payload) {
  return String(payload.status || payload.call_status || payload.dial_status || payload.event || '').toLowerCase();
}

function formatOrderForZvonokMessage(order) {
  return (
    `Имя: ${escapeHtml(order?.name || '-')}\n` +
    `Телефон: ${escapeHtml(order?.phone || '-')}\n` +
    `Размер: ${escapeHtml(order?.size || '-')}\n` +
    (order?.fullName ? `ФИО: ${escapeHtml(order.fullName)}\n` : '') +
    (order?.city ? `Город: ${escapeHtml(order.city)}\n` : '') +
    (order?.district ? `Район: ${escapeHtml(order.district)}\n` : '') +
    (order?.postOffice ? `Новая Почта: ${escapeHtml(order.postOffice)}\n` : '') +
    `Order ID: ${escapeHtml(order?.id || '-')}`
  );
}

/* ═══════════════════════════════════════════════════════════
   ANALYTICS
═══════════════════════════════════════════════════════════ */

/** POST /api/analytics — receive batched events from client */
app.post('/api/analytics', rateLimit(60 * 1000, 30), (req, res) => {
  const { events, ua } = req.body;
  if (!Array.isArray(events) || !events.length)
    return res.status(400).json({ error: 'Invalid events' });

  const existing = read(F.analytics);
  const ip       = req.ip || 'unknown';
  const now      = new Date().toISOString();

  events.slice(0, 100).forEach(ev => {
    if (!ev.event || !ev.sessionId) return;
    const suppliedTime = new Date(ev.timestamp || now).getTime();
    const eventTime = Number.isFinite(suppliedTime) && suppliedTime <= Date.now() + 5 * 60 * 1000
      ? new Date(suppliedTime).toISOString()
      : now;
    existing.push({
      event:     String(ev.event).slice(0, 50),
      sessionId: String(ev.sessionId).slice(0, 60),
      timestamp: eventTime,
      data:      ev.data || {},
      referrer:  String(ev.referrer || '').slice(0, 200),
      ua:        String(ua || '').slice(0, 200),
      ip,
    });
  });

  // Prune entries older than 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const pruned = existing.filter(e => (e.timestamp || '') >= cutoff).slice(-50000);

  write(F.analytics, pruned);
  res.json({ success: true });
});

/** GET /api/analytics/summary?period=today|hour|week — aggregated (bot only) */
app.get('/api/analytics/summary', authBot, (req, res) => {
  const period  = req.query.period || 'today';
  const all     = read(F.analytics);
  const now     = Date.now();

  let cutoff;
  if      (period === 'hour')  cutoff = now - 3600 * 1000;
  else if (period === 'week')  cutoff = now - 7 * 24 * 3600 * 1000;
  else /* today */             cutoff = new Date().setHours(0, 0, 0, 0);

  const filtered = all.filter(e => new Date(e.timestamp).getTime() >= cutoff);

  // Session stats — exclude likely-admin sessions (duration > 7200s)
  const sessionMap = Object.create(null);
  filtered.forEach(ev => {
    if (!sessionMap[ev.sessionId]) sessionMap[ev.sessionId] = { events: [], ip: ev.ip };
    sessionMap[ev.sessionId].events.push(ev);
  });

  const ipCounts = Object.create(null);
  filtered.forEach(ev => { ipCounts[ev.ip] = (ipCounts[ev.ip] || 0) + 1; });
  const hotIps = new Set(Object.entries(ipCounts).filter(([,c]) => c > 80).map(([ip]) => ip));

  const validSessions = Object.entries(sessionMap)
    .filter(([, s]) => !hotIps.has(s.ip))
    .map(([id, s]) => {
      const endEv = s.events.find(e => e.event === 'session_end');
      const dur   = endEv?.data?.duration || null;
      return { id, eventCount: s.events.length, duration: dur };
    });

  const durSamples  = validSessions.map(s => s.duration).filter(d => d !== null && d > 3 && d < 7200);
  const avgDuration = durSamples.length ? Math.round(durSamples.reduce((a, b) => a + b, 0) / durSamples.length) : 0;

  // Bounce = session with only 1–2 events
  const bounces   = validSessions.filter(s => s.eventCount <= 2).length;
  const bounceRate = validSessions.length ? +(bounces / validSessions.length).toFixed(2) : 0;

  // Scroll depth distribution
  const scrollDepth = { 25: 0, 50: 0, 75: 0, 90: 0, 100: 0 };
  filtered.filter(e => e.event === 'scroll_depth').forEach(e => {
    const d = e.data?.depth;
    if (scrollDepth[d] !== undefined) scrollDepth[d]++;
  });

  // Button clicks
  const buttonClicks = Object.create(null);
  filtered.filter(e => e.event === 'button_click').forEach(e => {
    const label = e.data?.label || 'unknown';
    buttonClicks[label] = (buttonClicks[label] || 0) + 1;
  });
  const topButtons = Object.entries(buttonClicks)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, count]) => ({ label, count }));

  // Form funnel
  const formStart  = filtered.filter(e => e.event === 'form_start').length;
  const formSubmit = filtered.filter(e => e.event === 'form_submit').length;
  const orderOk    = filtered.filter(e => e.event === 'order_success').length;

  // Active sessions in last hour
  const hourCutoff    = now - 3600 * 1000;
  const recentSessIds = new Set(all.filter(e => new Date(e.timestamp).getTime() >= hourCutoff).map(e => e.sessionId));
  const activeLastHr  = recentSessIds.size;

  // Last 10 actions
  const lastActions = [...filtered]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 10)
    .map(e => ({ event: e.event, timestamp: e.timestamp, data: e.data }));

  // Page views (unique sessions)
  const pvSessions = new Set(filtered.filter(e => e.event === 'page_view').map(e => e.sessionId));

  res.json({
    period,
    sessions: {
      total:       validSessions.length,
      unique:      pvSessions.size,
      avgDuration, // seconds
      bounceRate,
    },
    scrollDepth,
    topButtons,
    formFunnel: { started: formStart, submitted: formSubmit, succeeded: orderOk },
    activeLastHour: activeLastHr,
    lastActions,
  });
});

/** GET /api/analytics — raw dump (bot only) */
app.get('/api/analytics', authBot, (_req, res) => res.json(read(F.analytics)));

/* ═══════════════════════════════════════════════════════════
   ADMIN API (BOT)
═══════════════════════════════════════════════════════════ */
app.get('/api/admin/np/find-by-phone', authBot, asyncRoute(async (req, res) => {
  const phone = sanitizeStr(req.query.phone || req.query.q, 40);
  const normalizedPhone = novaPoshta.normalizePhone(phone);
  if (!normalizedPhone || normalizedPhone.length < 7) return res.status(400).json({ error: 'Invalid phone' });

  const orders = read(F.orders);
  const localOrders = orders
    .filter(o => samePhone(o.phone, phone))
    .map(o => ({
      id: o.id,
      name: o.name || '',
      phone: o.phone || '',
      status: o.status || 'new',
      paymentStatus: orderPaymentStatus(o),
      ttn: o.ttn || '',
      createdAt: o.createdAt || null,
      paidAt: o.paidAt || o.basePaidAt || null,
      returnedAt: o.returnedAt || o.npReturnCreatedAt || null,
    }))
    .reverse();

  const daysBack = Math.max(1, Math.min(90, Number(req.query.daysBack || process.env.NP_PHONE_LOOKUP_DAYS || 60)));
  if (!novaPoshta.configStatus().apiConfigured) {
    return res.json({
      success: true,
      apiConfigured: false,
      phone: normalizedPhone,
      daysBack,
      documents: [],
      orders: localOrders,
    });
  }

  try {
    const docs = await novaPoshta.findDocumentsByRecipientPhone(phone, { daysBack });
    const documents = docs.map(doc => {
      const linkedOrder = orders.find(o => String(o.ttn || '').trim() === String(doc.ttn || '').trim());
      return {
        ttn: doc.ttn,
        ref: doc.ref || '',
        dateTime: doc.dateTime || '',
        recipientName: doc.recipientName || '',
        recipientPhone: doc.recipientPhone || '',
        senderPhone: doc.senderPhone || '',
        status: doc.status || '',
        cost: doc.cost || 0,
        linkedOrderId: linkedOrder?.id || null,
      };
    });
    res.json({ success: true, apiConfigured: true, phone: normalizedPhone, daysBack, documents, orders: localOrders });
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  }
}));
app.get('/api/admin/orders',       authBot, (_req, res) => res.json(read(F.orders)));
app.get('/api/admin/orders/:id',   authBot, (req, res) => {
  const order = read(F.orders).find(x => x.id === Number(req.params.id));
  order ? res.json(order) : res.status(404).json({ error: 'Not found' });
});
app.patch('/api/admin/orders/:id', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = ensurePaidOrderFinance({ ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() });
  writeOrders(arr);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) updateOrderQueueNotice(arr[idx]).catch(e => console.error('[order notice]', e.message));
  if (arr[idx].ttn && (
    Object.prototype.hasOwnProperty.call(req.body || {}, 'ttn') ||
    Object.prototype.hasOwnProperty.call(req.body || {}, 'status') ||
    Object.prototype.hasOwnProperty.call(req.body || {}, 'deliveryStatus')
  )) {
    scheduleNovaPoshtaSync({ source: 'order-patch', limit: 30 }, 5000);
  }
  res.json(arr[idx]);
});

const npConfig = novaPoshta.configStatus();
if (npConfig.autoSync && npConfig.apiConfigured) {
  const intervalMs = Math.max(2, Number(process.env.NP_SYNC_INTERVAL_MINUTES || 10)) * 60 * 1000;
  const startupDelayMs = Math.max(0, Number(process.env.NP_SYNC_STARTUP_DELAY_MS || 15000));
  scheduleNovaPoshtaSync({ source: 'startup', limit: process.env.NP_SYNC_LIMIT || 100 }, startupDelayMs);
  setInterval(() => {
    scheduleNovaPoshtaSync({ source: 'interval', limit: process.env.NP_SYNC_LIMIT || 100 });
  }, intervalMs).unref();
} else if (!npConfig.apiConfigured) {
  console.warn('[NovaPoshta] NOVA_POSHTA_API_KEY is not set; tracking and TTN creation are disabled.');
}
const monoConfig = monobank.configStatus();
if (MONOBANK_CRM_ENABLED && monoConfig.configured && process.env.MONOBANK_AUTO_SYNC !== 'false') {
  const monoIntervalMs = Math.max(2, Number(process.env.MONOBANK_SYNC_INTERVAL_MINUTES || 5)) * 60 * 1000;
  const startupSyncDays = Math.max(1, Math.min(31, Number(process.env.MONOBANK_STARTUP_SYNC_DAYS || 7)));
  const intervalSyncDays = Math.max(1, Math.min(31, Number(process.env.MONOBANK_INTERVAL_SYNC_DAYS || 7)));
  syncMonobankFinance(startupSyncDays)
    .then(result => {
      if (result.imported) console.log('[Monobank initial sync]', result);
    })
    .catch(error => console.error('[Monobank initial sync]', error.message));
  setInterval(() => {
    syncMonobankFinance(intervalSyncDays)
      .then(result => {
        if (result.imported) console.log('[Monobank sync]', result);
      })
      .catch(error => console.error('[Monobank sync]', error.message));
  }, monoIntervalMs).unref();
}
/* ── Arbitrator payout panel ──────────────────────────────── */
app.get('/api/admin/arbitrator/summary', authBot, (_req, res) => {
  res.json(arbitratorSummary());
});
app.post('/api/admin/arbitrator/payout', authBot, (_req, res) => {
  res.json(recordArbitratorPayout());
});

app.delete('/api/admin/orders/cancelled', authBot, (_req, res) => {
  const arr = read(F.orders);
  const kept = arr.filter(x => (x.status || 'new') !== 'cancelled');
  const deleted = arr.length - kept.length;
  if (deleted) writeOrders(kept);
  updateOrderQueueNotice().catch(e => console.error('[order notice]', e.message));
  res.json({ success: true, deleted, remaining: kept.length });
});
app.delete('/api/admin/orders/:id', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  writeOrders(arr.filter(x => x.id !== id));
  updateOrderQueueNotice().catch(e => console.error('[order notice]', e.message));
  res.json({ success: true });
});
app.post('/api/admin/orders/:id/expense', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const amount = asMoneyNumber(req.body?.amount);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Invalid amount' });
  const expense = {
    id: nextId(Array.isArray(arr[idx].expenses) ? arr[idx].expenses : []),
    title: sanitizeStr(req.body?.title || 'Витрата по замовленню', 160),
    amount,
    category: sanitizeStr(req.body?.category || 'order', 40),
    createdAt: new Date().toISOString(),
  };
  arr[idx].expenses = [...(Array.isArray(arr[idx].expenses) ? arr[idx].expenses : []), expense];
  if (expense.category === 'return') arr[idx].returnExpense = amount;
  arr[idx].updatedAt = new Date().toISOString();
  writeOrders(arr);
  addFinanceEntryOnce({
    type: 'expense',
    title: expense.title,
    amount: expense.amount,
    category: expense.category,
    source: 'order-expense',
    orderId: id,
    externalId: financeExternalId('order-expense', expense.category, id, expense.id),
    createdAt: expense.createdAt,
  });
  res.json(arr[idx]);
});
app.post('/api/admin/orders/:id/comment', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx].managerComment = sanitizeStr(req.body?.comment, 1000);
  arr[idx].updatedAt = new Date().toISOString();
  writeOrders(arr); res.json(arr[idx]);
});
app.get('/api/admin/finance', authBot, (_req, res) => res.json(read(F.finance)));
app.post('/api/admin/finance', authBot, (req, res) => {
  const arr = read(F.finance);
  const amount = asMoneyNumber(req.body?.amount);
  const type = sanitizeStr(req.body?.type, 20);
  if (!['income', 'expense'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Invalid amount' });
  const item = {
    id: nextId(arr),
    type,
    title: sanitizeStr(req.body?.title || (type === 'income' ? 'Дохід' : 'Витрата'), 180),
    amount,
    category: sanitizeStr(req.body?.category || 'manual', 60),
    source: sanitizeStr(req.body?.source || 'manual', 60),
    orderId: req.body?.orderId ? Number(req.body.orderId) : null,
    createdAt: req.body?.createdAt || new Date().toISOString(),
  };
  arr.push(item); write(F.finance, arr); res.json(item);
});
app.delete('/api/admin/finance/expenses/today', authBot, (_req, res) => {
  const arr = read(F.finance);
  const removed = arr.filter(x => x.type === 'expense' && inPeriod(x.createdAt, 'today'));
  const kept = arr.filter(x => !(x.type === 'expense' && inPeriod(x.createdAt, 'today')));
  if (removed.length) write(F.finance, kept);
  res.json({
    success: true,
    deleted: removed.length,
    totalAmount: removed.reduce((sum, x) => sum + asMoneyNumber(x.amount), 0),
  });
});
app.delete('/api/admin/finance/:id', authBot, (req, res) => {
  const id = Number(req.params.id);
  const arr = read(F.finance);
  const idx = arr.findIndex(entry => Number(entry.id) === id);
  if (idx < 0) return res.status(404).json({ error: 'Finance operation not found' });
  arr[idx] = { ...arr[idx], excludedAt: new Date().toISOString(), excludedReason: 'manager_deleted' };
  write(F.finance, arr);
  res.json({ success: true, deleted: arr[idx] });
});
app.patch('/api/admin/finance/:id/classify', authBot, (req, res) => {
  const id = Number(req.params.id);
  const category = sanitizeStr(req.body?.category, 60);
  const allowed = ['personal', 'ads', 'shipping', 'return', 'business', 'business_income', 'ignored_income'];
  if (!allowed.includes(category)) return res.status(400).json({ error: 'Invalid finance category' });
  const arr = read(F.finance);
  const idx = arr.findIndex(entry => Number(entry.id) === id);
  if (idx < 0) return res.status(404).json({ error: 'Finance operation not found' });
  const wasIncoming = arr[idx].type === 'income' || arr[idx].type === 'unmatched';
  const incomingCategory = ['business_income', 'ignored_income'].includes(category);
  if (wasIncoming !== incomingCategory) return res.status(400).json({ error: 'Category does not match operation direction' });
  arr[idx] = {
    ...arr[idx],
    type: category === 'business_income' ? 'income' : category === 'ignored_income' ? 'unmatched' : 'expense',
    category,
    reviewRequired: false,
    classifiedAt: new Date().toISOString(),
    classifiedBy: 'manager',
  };
  write(F.finance, arr);
  res.json(arr[idx]);
});
app.get('/api/admin/finance/summary', authBot, (req, res) => {
  res.json(buildCrmSummary(sanitizeStr(req.query.period || 'today', 20)));
});
app.get('/api/admin/crm/summary', authBot, (req, res) => {
  res.json(buildCrmSummary(sanitizeStr(req.query.period || 'today', 20)));
});
app.get('/api/admin/crm/orders/summary', authBot, (req, res) => {
  res.json(buildOrderCrmSummary(sanitizeStr(req.query.period || 'today', 20)));
});
app.get('/api/admin/private/power/summary', authBot, (req, res) => {
  res.json(buildPrivatePowerSummary(sanitizeStr(req.query.period || 'all', 20)));
});
app.get('/api/admin/reconciliation/summary', authBot, (req, res) => {
  res.json(buildManagerReconciliationSummary(sanitizeStr(req.query.period || 'all', 20)));
});
app.post('/api/admin/reconciliation/money', authBot, (req, res) => {
  const ttns = reconciliationTtns(req.body?.ttns || req.body?.text);
  if (!ttns.length) return res.status(400).json({ error: 'No valid TTNs', userMessage: 'Не знайдено ТТН із 14–15 цифр.' });
  const result = reconcileManagerOrders('money', ttns, sanitizeStr(req.body?.managerId || '', 80));
  updateOrderQueueNotice().catch(error => console.error('[order notice]', error.message));
  res.json(result);
});
app.post('/api/admin/reconciliation/returns', authBot, (req, res) => {
  const ttns = reconciliationTtns(req.body?.ttns || req.body?.text);
  if (!ttns.length) return res.status(400).json({ error: 'No valid TTNs', userMessage: 'Не знайдено ТТН із 14–15 цифр.' });
  const result = reconcileManagerOrders('return', ttns, sanitizeStr(req.body?.managerId || '', 80));
  updateOrderQueueNotice().catch(error => console.error('[order notice]', error.message));
  res.json(result);
});
app.post('/api/admin/private/power/reconcile/money', authBot, (req, res) => {
  const ttns = reconciliationTtns(req.body?.ttns || req.body?.text);
  if (!ttns.length) return res.status(400).json({ error: 'No valid TTNs', userMessage: 'Не знайдено ТТН із 14–15 цифр.' });
  const result = reconcilePrivatePowerOrders('money', ttns, sanitizeStr(req.body?.managerId || '', 80));
  updateOrderQueueNotice().catch(error => console.error('[order notice]', error.message));
  res.json(result);
});
app.post('/api/admin/private/power/reconcile/returns', authBot, (req, res) => {
  const ttns = reconciliationTtns(req.body?.ttns || req.body?.text);
  if (!ttns.length) return res.status(400).json({ error: 'No valid TTNs', userMessage: 'Не знайдено ТТН із 14–15 цифр.' });
  const result = reconcilePrivatePowerOrders('return', ttns, sanitizeStr(req.body?.managerId || '', 80));
  updateOrderQueueNotice().catch(error => console.error('[order notice]', error.message));
  res.json(result);
});
app.get('/api/admin/crm/products', authBot, (_req, res) => {
  res.json({ products: readCrmProducts() });
});
app.patch('/api/admin/crm/products/:key/cost', authBot, (req, res) => {
  const amount = asMoneyNumber(req.body?.cost);
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'Invalid cost' });
  const product = saveCrmProductCost(sanitizeStr(req.params.key, 60), amount);
  if (!product) return res.status(404).json({ error: 'Product model not found' });
  res.json(product);
});
app.get('/api/admin/crm/problems', authBot, (_req, res) => {
  const orders = read(F.orders).map(o => {
    const problems = [];
    const hasReturnExpense = Object.prototype.hasOwnProperty.call(o, 'returnExpense') || (Array.isArray(o.expenses) && o.expenses.some(e => e.category === 'return'));
    if (orderStatusForDisplay(o) === 'confirmed') problems.push('Підтверджено, але не відправлено');
    if (isOrderActuallyShipped(o) && !o.ttn) problems.push('Відправлено, але немає ТТН');
    if (isOrderActuallyShipped(o) && orderPaymentStatus(o) !== 'paid') problems.push('Відправлено, але не оплачено');
    if ((o.status === 'paid' || orderPaymentStatus(o) === 'paid') && !asMoneyNumber(o.price)) problems.push('Оплачено, але немає ціни');
    if ((o.status === 'returned' || orderPaymentStatus(o) === 'returned') && !hasReturnExpense) problems.push('Повернення без витрати');
    if (o.status === 'completed' && orderProfit(o) <= 0) problems.push('Завершено, але прибуток <= 0');
    return { ...o, problems };
  }).filter(o => o.problems.length);
  res.json({ orders });
});
app.get('/api/admin/np/config', authBot, (_req, res) => {
  res.json(novaPoshta.configStatus());
});
app.get('/api/admin/np/sync/status', authBot, (_req, res) => {
  res.json({ success: true, ...novaPoshtaSyncStatus() });
});
app.get('/api/admin/np/afterpayments', authBot, (req, res) => {
  res.json(buildAfterpaymentSummary(sanitizeStr(req.query.period || 'today', 20), read(F.orders)));
});
app.post('/api/admin/np/afterpayments/sync', authBot, async (req, res) => {
  if (!novaPoshta.configStatus().apiConfigured) return res.status(400).json(novaPoshtaMissingConfigPayload());
  try {
    const limit = parseSyncLimit(req.body?.limit || 100);
    if (req.body?.background === true) {
      const job = startNovaPoshtaSync({ source: 'afterpayments', limit });
      return res.status(job.started ? 202 : 200).json({
        success: true,
        background: true,
        started: job.started,
        queued: job.queued,
        syncStatus: job.status,
        afterpayments: buildAfterpaymentSummary(sanitizeStr(req.body?.period || 'all', 20), read(F.orders)),
      });
    }
    const result = await runNovaPoshtaSyncNow({ source: 'afterpayments', limit });
    res.json({
      success: true,
      sync: result,
      afterpayments: buildAfterpaymentSummary(sanitizeStr(req.body?.period || 'all', 20), read(F.orders)),
    });
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  }
});
app.get('/api/admin/monobank/config', authBot, (_req, res) => {
  if (!MONOBANK_CRM_ENABLED) return res.json({ configured: false, disabled: true, reason: 'CRM uses Nova Poshta API plus manual TTN reconciliation' });
  res.json({ ...monobank.configStatus(), webhookAvailable: !!(APP_PUBLIC_URL && MONOBANK_WEBHOOK_SECRET) });
});
app.post('/api/admin/monobank/sync', authBot, async (req, res) => {
  if (!MONOBANK_CRM_ENABLED) return res.status(410).json({ error: 'Monobank CRM sync is disabled' });
  try {
    res.json({ success: true, ...(await syncMonobankFinance(req.body?.daysBack || 3)) });
  } catch (error) {
    res.status(502).json({ error: error.message, details: error.details || {} });
  }
});
app.post('/api/admin/monobank/webhook/setup', authBot, async (_req, res) => {
  if (!MONOBANK_CRM_ENABLED) return res.status(410).json({ error: 'Monobank CRM sync is disabled' });
  if (!APP_PUBLIC_URL || !MONOBANK_WEBHOOK_SECRET) {
    return res.status(400).json({ error: 'APP_PUBLIC_URL and MONOBANK_WEBHOOK_SECRET are required' });
  }
  const webhookUrl = `${APP_PUBLIC_URL}/api/monobank/webhook/${encodeURIComponent(MONOBANK_WEBHOOK_SECRET)}`;
  try {
    await monobank.setWebhook(webhookUrl);
    res.json({ success: true, webhookUrl });
  } catch (error) {
    res.status(502).json({ error: error.message, details: error.details || {} });
  }
});
app.get('/api/monobank/webhook/:secret', (req, res) => {
  if (!MONOBANK_WEBHOOK_SECRET || req.params.secret !== MONOBANK_WEBHOOK_SECRET) return res.sendStatus(403);
  res.sendStatus(200);
});
app.post('/api/monobank/webhook/:secret', (req, res) => {
  if (!MONOBANK_WEBHOOK_SECRET || req.params.secret !== MONOBANK_WEBHOOK_SECRET) return res.sendStatus(403);
  if (!MONOBANK_CRM_ENABLED) return res.sendStatus(204);
  if (req.body?.type === 'StatementItem' && req.body?.data?.statementItem) {
    importMonobankStatementItem(req.body.data.statementItem);
  }
  res.sendStatus(200);
});
app.get('/api/admin/np/track/:ttn', authBot, async (req, res) => {
  try {
    const ttn = sanitizeStr(req.params.ttn, 40);
    const [track] = await novaPoshta.trackDocuments([{ DocumentNumber: ttn }]);
    if (!track) {
      const publicTrack = await novaPoshta.getPublicTracking(ttn);
      if (!publicTrack) return res.status(404).json({ error: 'TTN not found' });
      return res.json(publicTrack);
    }
    res.json(track);
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  }
});
app.post('/api/admin/np/sender-location/resolve', authBot, async (req, res) => {
  const type = sanitizeStr(req.body?.type || '', 20);
  const query = sanitizeStr(req.body?.query || '', 120);
  if (!['branch', 'postomat'].includes(type)) return res.status(400).json({ error: 'Invalid sender location type' });
  if (!query) return res.status(400).json({ error: 'Sender location is required' });
  try {
    const location = await novaPoshta.resolveSenderLocation(type, query);
    res.json({ success: true, location });
  } catch (error) {
    if (/warehouse was not found/i.test(String(error?.message || ''))) {
      error.message = 'Nova Poshta sender warehouse was not found';
    }
    res.status(502).json(npErrorPayload(error));
  }
});
app.post('/api/admin/np/settlements/resolve', authBot, async (req, res) => {
  const query = sanitizeStr(req.body?.query || '', 120);
  if (!query) return res.status(400).json({ error: 'Settlement is required' });
  try {
    const result = await novaPoshta.searchRecipientSettlements(query);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  }
});
app.post('/api/admin/orders/:id/np/create', authBot, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const orders = read(F.orders);
  const idx = orders.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const bodyPatch = req.body && typeof req.body === 'object' ? { ...req.body } : {};
  delete bodyPatch.force;
  if (orders[idx].ttn && !req.body?.force) return res.json({ success: true, duplicate: true, order: orders[idx], ttn: orders[idx].ttn });
  const lockKey = String(id);
  if (npCreateLocks.has(lockKey)) {
    return res.status(409).json({
      error: 'TTN creation is already running for this order',
      userMessage: 'ТТН уже створюється. Зачекайте кілька секунд, не натискайте кнопку повторно.',
      retryable: true,
      retryAfterMs: 5000,
    });
  }
  npCreateLocks.set(lockKey, Date.now());
  try {
    const latestOrders = read(F.orders);
    const latestIdx = latestOrders.findIndex(x => x.id === id);
    if (latestIdx < 0) return res.status(404).json({ error: 'Not found' });
    const baseOrder = latestOrders[latestIdx];
    if (baseOrder.ttn && !req.body?.force) {
      return res.json({ success: true, duplicate: true, order: baseOrder, ttn: baseOrder.ttn });
    }
    const order = { ...baseOrder, ...bodyPatch };
    const created = await novaPoshta.createInternetDocument(order);
    const now = new Date().toISOString();
    const previousTtn = String(baseOrder.ttn || '').trim();
    const ttnHistory = Array.isArray(baseOrder.ttnHistory) ? [...baseOrder.ttnHistory] : [];
    if (previousTtn && previousTtn !== String(created.ttn || '').trim()) {
      ttnHistory.push({
        ttn: previousTtn,
        npRef: baseOrder.npRef || null,
        replacedAt: now,
        reason: req.body?.force ? 'recreated_before_dispatch' : 'replaced',
      });
    }
    const computedOrder = {
      ...baseOrder,
      ...order,
      ttn: created.ttn,
      npRef: created.ref,
      npEstimatedDeliveryDate: created.estimatedDeliveryDate,
      npDeliveryCost: created.cost || baseOrder.npDeliveryCost || null,
      deliveryStatus: 'ttn_created',
      status: ['paid', 'completed'].includes(baseOrder.status) ? baseOrder.status : 'confirmed',
      ttnHistory,
      novaPoshta: {
        ...(baseOrder.novaPoshta && typeof baseOrder.novaPoshta === 'object' ? baseOrder.novaPoshta : {}),
        ref: created.ref,
        ttn: created.ttn,
        city: created.city,
        warehouse: created.warehouse,
        recipient: {
          ref: created.recipient.ref,
          contactRef: created.recipient.contactRef,
          description: created.recipient.description,
          phone: created.recipient.phone,
        },
        estimatedDeliveryDate: created.estimatedDeliveryDate,
        raw: created.raw,
      },
      ttnCreatedAt: now,
      updatedAt: now,
    };
    const persisted = await persistNovaPoshtaOrderChanges([baseOrder], [computedOrder]);
    const savedOrder = persisted.ordersById.get(String(id));
    if (!savedOrder) {
      return res.status(409).json({ error: 'Order was deleted while TTN was being created', createdTtn: created.ttn });
    }
    const mergeConflict = persisted.conflicts.find(item => item.id === String(id));
    if (mergeConflict?.fields.includes('ttn')) {
      return res.status(409).json({
        error: 'Order TTN changed while a new TTN was being created',
        createdTtn: created.ttn,
        order: savedOrder,
      });
    }
    updateOrderQueueNotice(savedOrder).catch(e => console.error('[order notice]', e.message));
    scheduleNovaPoshtaSync({
      source: 'ttn-create',
      limit: Number(process.env.NP_SYNC_AFTER_TTN_LIMIT || 30),
      includeManualLink: false,
    }, Math.max(0, Number(process.env.NP_SYNC_AFTER_TTN_DELAY_MS || 120000)));
    res.json({
      success: true,
      order: savedOrder,
      novaPoshta: created,
      ttn: savedOrder.ttn || created.ttn,
      mergeConflicts: mergeConflict?.fields || [],
    });
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  } finally {
    npCreateLocks.delete(lockKey);
  }
}));
app.post('/api/admin/orders/:id/np/sync', authBot, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const orders = read(F.orders);
  const idx = orders.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (!orders[idx].ttn) return res.status(400).json({ error: 'Order has no TTN' });
  const baseOrder = orders[idx];
  try {
    const { updated, track } = await syncOrderWithNovaPoshta(baseOrder);
    const persisted = await persistNovaPoshtaOrderChanges([baseOrder], [updated]);
    const savedOrder = persisted.ordersById.get(String(id));
    if (!savedOrder) return res.status(409).json({ error: 'Order was deleted while Nova Poshta sync was running' });
    updateOrderQueueNotice(savedOrder).catch(e => console.error('[order notice]', e.message));
    res.json({
      success: true,
      order: savedOrder,
      track,
      mergeConflicts: persisted.conflicts.find(item => item.id === String(id))?.fields || [],
    });
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  }
}));
app.post('/api/admin/orders/:id/np/return', authBot, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const orders = read(F.orders);
  const idx = orders.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  if (!orders[idx].ttn) return res.status(400).json({ error: 'Order has no TTN', userMessage: 'У замовленні немає ТТН, тому повернення в Новій Пошті створити неможливо.' });
  const baseOrder = orders[idx];
  try {
    const result = await novaPoshta.createReturnOrder(baseOrder);
    const now = new Date().toISOString();
    let updated = applyNovaReturnOrderToOrder(baseOrder, result.returnOrder);
    const returnTtn = updated.npReturnExpressWaybillNumber || updated.npReturnOrderNumber;
    if (returnTtn) {
      try {
        const [returnTrack] = await novaPoshta.trackDocuments([String(returnTtn)]);
        if (returnTrack) updated = applyNovaReturnTrackingToOrder(updated, returnTrack);
      } catch (error) {
        updated.npReturnTrackingError = error.message;
      }
    }
    updated = {
      ...updated,
      status: 'returned',
      paymentStatus: req.body?.paymentStatus || 'returned',
      returnScope: req.body?.scope || baseOrder.returnScope || 'base',
      returnedAt: baseOrder.returnedAt || now,
      npReturnCreatedAt: baseOrder.npReturnCreatedAt || now,
      npReturnDuplicate: !!result.duplicate,
      updatedAt: now,
    };
    const persisted = await persistNovaPoshtaOrderChanges([baseOrder], [updated]);
    const savedOrder = persisted.ordersById.get(String(id));
    if (!savedOrder) return res.status(409).json({ error: 'Order was deleted while return creation was running' });
    updateOrderQueueNotice(savedOrder).catch(e => console.error('[order notice]', e.message));
    res.json({
      success: true,
      order: savedOrder,
      returnOrder: result.returnOrder || null,
      duplicate: !!result.duplicate,
      mergeConflicts: persisted.conflicts.find(item => item.id === String(id))?.fields || [],
    });
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  }
}));
app.post('/api/admin/orders/:id/np/link-manual', authBot, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const orders = read(F.orders);
  const idx = orders.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const baseOrder = orders[idx];
  try {
    const linked = await linkManualNovaPoshtaTtn(baseOrder, orders);
    if (!linked.linked) return res.status(404).json({ error: 'Manual TTN was not found by recipient phone', reason: linked.reason, checked: linked.checked || 0 });
    let updated = linked.order;
    try {
      const synced = await syncOrderWithNovaPoshta(updated);
      updated = synced.updated;
      linked.track = synced.track;
    } catch (error) {
      linked.syncError = error.message;
    }
    const persisted = await persistNovaPoshtaOrderChanges([baseOrder], [updated]);
    const savedOrder = persisted.ordersById.get(String(id));
    if (!savedOrder) return res.status(409).json({ error: 'Order was deleted while manual TTN linking was running' });
    const mergeConflict = persisted.conflicts.find(item => item.id === String(id));
    updateOrderQueueNotice(savedOrder).catch(e => console.error('[order notice]', e.message));
    res.json({
      success: true,
      order: savedOrder,
      ttn: savedOrder.ttn || linked.ttn,
      document: linked.document,
      track: linked.track || null,
      syncError: linked.syncError || null,
      mergeConflicts: mergeConflict?.fields || [],
    });
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  }
}));
app.post('/api/admin/np/sync', authBot, async (req, res) => {
  if (!novaPoshta.configStatus().apiConfigured) return res.status(400).json(novaPoshtaMissingConfigPayload());
  try {
    const limit = parseSyncLimit(req.body?.limit || 100);
    const source = sanitizeStr(req.body?.source || 'manual', 40);
    if (req.body?.background === true) {
      const job = startNovaPoshtaSync({ source, limit });
      return res.status(job.started ? 202 : 200).json({
        success: true,
        background: true,
        started: job.started,
        queued: job.queued,
        syncStatus: job.status,
      });
    }
    res.json({ success: true, ...(await runNovaPoshtaSyncNow({ source, limit })) });
  } catch (error) {
    res.status(502).json(npErrorPayload(error));
  }
});
app.get('/api/admin/reviews',       authBot, (_req, res) => res.json(read(F.reviews)));
app.delete('/api/admin/reviews/:id', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.reviews);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.reviews, arr.filter(x => x.id !== id)); res.json({ success: true });
});
app.get('/api/admin/support',       authBot, (_req, res) => res.json(read(F.support)));
app.patch('/api/admin/support/:id', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.support);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.support, arr); res.json(arr[idx]);
});
app.get('/api/admin/backup', authBot, (_req, res) => {
  res.json({
    exportedAt: new Date().toISOString(),
    dataDir: DATA,
    orders: read(F.orders),
    reviews: read(F.reviews),
    support: read(F.support),
    analytics: read(F.analytics),
    finance: read(F.finance),
    financeSettings: readFinanceSettings(),
    crmProducts: readCrmProducts(),
    npAfterpayments: read(F.npAfterpayments),
  });
});
app.post('/api/admin/backup/restore', authBot, (req, res) => {
  const { orders, reviews, support, analytics, finance, financeSettings, crmProducts, npAfterpayments } = req.body || {};
  const restored = {};
  if (Array.isArray(orders)) {
    writeOrders(orders);
    restored.orders = orders.length;
  }
  if (Array.isArray(reviews)) {
    write(F.reviews, reviews);
    restored.reviews = reviews.length;
  }
  if (Array.isArray(support)) {
    write(F.support, support);
    restored.support = support.length;
  }
  if (Array.isArray(analytics)) {
    write(F.analytics, analytics);
    restored.analytics = analytics.length;
  }
  if (Array.isArray(finance)) {
    write(F.finance, finance);
    restored.finance = finance.length;
  }
  if (financeSettings && !Array.isArray(financeSettings) && typeof financeSettings === 'object') {
    write(F.financeSettings, {
      startAt: financeSettings.startAt || DEFAULT_FINANCE_START_AT,
      timezone: financeSettings.timezone || 'Europe/Kyiv',
      resetLabel: financeSettings.resetLabel || '26.05.2026',
      resetKey: financeSettings.resetKey || DEFAULT_FINANCE_RESET_KEY,
      appliedResetKey: financeSettings.appliedResetKey || null,
      resetAppliedAt: financeSettings.resetAppliedAt || null,
    });
    restored.financeSettings = true;
  }
  if (Array.isArray(crmProducts)) {
    write(F.crmProducts, crmProducts);
    restored.crmProducts = crmProducts.length;
  }
  if (Array.isArray(npAfterpayments)) {
    write(F.npAfterpayments, npAfterpayments);
    restored.npAfterpayments = npAfterpayments.length;
  }
  res.json({ success: true, restored });
});

/* ── SSE endpoint ──────────────────────────────────────────── */
app.get('/api/support/stream', (req, res) => {
  const sessionId = supportSessionKey(req.query.sessionId);
  if (!sessionId) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // Tell client to retry after 3.5s on disconnect
  res.write('retry: 3500\n\n');
  res.flushHeaders();

  const sess = getSession(sessionId);
  if (sess.res && sess.res !== res) sess.res.end();
  sess.res   = res;

  // Immediately flush any messages that arrived while disconnected
  flushQueue(sessionId);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    if (sessions[sessionId]?.res === res) {
      sessions[sessionId].res = null;
      sessions[sessionId].lastActivityAt = Date.now();
    }
  });
});

/* ── Bot relay ─────────────────────────────────────────────── */
app.post('/api/support/relay', authBot, (req, res) => {
  const { text, managerName } = req.body;
  const sessionId = supportSessionKey(req.body?.sessionId);
  if (!sessionId || !text) return res.status(400).json({ error: 'Missing fields' });
  sseWrite(sessionId, { type: 'message', text, managerName: managerName || 'Оператор' });
  const records = read(F.support);
  const idx = findOpenSupportIndex(records, sessionId);
  if (idx >= 0) {
    const now = new Date().toISOString();
    records[idx].messages = [...supportTranscript(records[idx]), supportMessage('manager', text, now, { managerName: sanitizeStr(managerName, 100) })];
    records[idx].message = sanitizeStr(text, 2000);
    records[idx].updatedAt = now;
    write(F.support, records);
  }
  res.json({ success: true });
});

app.post('/api/support/accept', authBot, (req, res) => {
  const { managerId } = req.body;
  const sessionId = supportSessionKey(req.body?.sessionId);
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  const support = updateSupportRecord(sessionId, {
    accepted: true,
    answered: false,
    category: 'manager_required',
    status: 'accepted',
    managerId: managerId || null,
    acceptedAt: new Date().toISOString(),
  });
  const realSessionId = supportSessionKey(support?.sessionId, sessionId);
  const sess = getSession(realSessionId);
  sess.accepted  = true;
  sess.managerId = managerId;
  sseWrite(realSessionId, { type: 'accepted' });
  res.json({ success: true, id: support?.id || null, sessionId: realSessionId });
});

app.post('/api/support/end', authBot, (req, res) => {
  const sessionId = supportSessionKey(req.body?.sessionId);
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  const msgs = read(F.support);
  const idx  = findOpenSupportIndex(msgs, sessionId);
  const realSessionId = supportSessionKey(msgs[idx]?.sessionId, sessionId);
  sseWrite(realSessionId, { type: 'end' });
  if (idx >= 0) {
    const now = new Date().toISOString();
    msgs[idx].answered = true;
    msgs[idx].status = 'closed';
    msgs[idx].endedAt = now;
    msgs[idx].completedAt = now;
    msgs[idx].updatedAt = now;
    write(F.support, msgs);
  }
  res.json({ success: true });
});

app.get('/api/support/sessions', authBot, (_req, res) => {
  const active = Object.entries(sessions).map(([id, s]) => ({
    sessionId: id, accepted: s.accepted, managerId: s.managerId, connected: !!s.res,
    pending: (pendingMessages[id] || []).length,
  }));
  res.json(active);
});

/* ═══════════════════════════════════════════════════════════
   ZAPUSK LEADS (public)
═══════════════════════════════════════════════════════════ */
app.post('/api/zapusk/lead', rateLimit(60 * 1000, 5), asyncRoute(async (req, res) => {
  const clean = (value, max = 200) => sanitizeStr(value, max).replace(/[<>]/g, '');
  const escapeHtml = value => clean(value, 700)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  if (req.body?.website) return res.json({ success: true });

  const name = clean(req.body?.name, 80);
  const phone = clean(req.body?.phone, 100);
  const business = clean(req.body?.business, 120) || 'Не вказано';
  const messenger = clean(req.body?.messenger, 40) || 'Не вказано';
  const message = clean(req.body?.message, 700) || '—';
  const source = clean(req.body?.source, 80) || 'Сайт';

  if (name.length < 2 || phone.length < 5) {
    return res.status(400).json({ error: 'Вкажіть ім’я та контакт' });
  }
  if (!ZAPUSK_TG_TOKEN || !ZAPUSK_TG_CHAT_ID) {
    return res.status(503).json({ error: 'ZAPUSK Telegram is not configured' });
  }

  const result = await sendZapuskTelegram([
    '🚀 <b>НОВА ЗАЯВКА ZAPUSK</b>',
    '━━━━━━━━━━━━━━━━━━',
    `👤 Ім’я: <b>${escapeHtml(name)}</b>`,
    `📞 Контакт: <b>${escapeHtml(phone)}</b>`,
    `🧩 Запит: <b>${escapeHtml(business)}</b>`,
    `💬 Зручний зв’язок: <b>${escapeHtml(messenger)}</b>`,
    `📝 Деталі: ${escapeHtml(message)}`,
    `📍 Джерело: ${escapeHtml(source)}`,
    '━━━━━━━━━━━━━━━━━━',
  ].join('\n'));

  if (!result?.ok) return res.status(502).json({ error: 'Telegram error' });
  return res.json({ success: true });
}));

/* ═══════════════════════════════════════════════════════════
   ORDERS (public)
═══════════════════════════════════════════════════════════ */
function orderTelegramKeyboard(order) {
  return { reply_markup: { inline_keyboard: [[
    { text: '✅ Підтвердити', callback_data: `confirm_${order.id}` },
    { text: '❌ Скасувати', callback_data: `cancel_${order.id}` },
  ], [
    { text: '📋 Відкрити', callback_data: `od_${order.id}` },
    { text: '🚚 Відстеження', callback_data: 'track_menu' },
  ], [
    { text: '🗑 Видалити', callback_data: `del_order_${order.id}` },
  ]] } };
}

function orderTelegramText(order, upgraded = false) {
  const ts = new Date(order.updatedAt || order.createdAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  const isInstant = order.orderMode === 'instant';
  const isPowerbank = /voltgo|powerbank|павербанк/i.test(order.product || '');
  return (
    `🛒 <b>${isInstant ? 'ПОВНЕ ЗАМОВЛЕННЯ' : 'НОВА ЗАЯВКА'} #${order.id}</b>\n━━━━━━━━━━━━━━━━━━\n` +
    (upgraded ? `🔁 <b>Заявку доповнено клієнтом, ID збережено</b>\n` : '') +
    (order.product ? `🛍 Товар: <b>${escapeHtml(order.product)}</b>\n` : '') +
    `👤 Ім'я: <b>${escapeHtml(order.name)}</b>\n📱 Телефон: <b>${escapeHtml(order.phone)}</b>\n` +
    `${isPowerbank ? '🔋 Ємність' : '👟 Розмір'}: <b>${escapeHtml(order.size)}</b>\n` +
    (order.variant ? `🏷 Варіант: <b>${escapeHtml(order.variant)}</b>\n` : '') +
    (order.quantity ? `🔢 Кількість: <b>${escapeHtml(order.quantity)}</b>\n` : '') +
    (order.fullName ? `🧾 Ім'я та прізвище: <b>${escapeHtml(order.fullName)}</b>\n` : '') +
    (order.city ? `🏙 Місто: <b>${escapeHtml(order.city)}</b>\n` : '') +
    (order.district ? `📍 Район: <b>${escapeHtml(order.district)}</b>\n` : '') +
    (order.postOffice ? `📦 Відділення Нової Пошти: <b>${escapeHtml(order.postOffice)}</b>\n` : '') +
    (order.color ? `🎨 Колір: <b>${escapeHtml(order.color)}</b>\n` : '') +
    (order.price ? `💵 Ціна: <b>${escapeHtml(order.price)} грн</b>\n` : '') +
    (order.contactViaTelegram ? `💬 Зв'язок: <b>Telegram</b>\n` : `📞 Зв'язок: <b>Дзвінок</b>\n`) +
    (isInstant
      ? `✅ Тип: <b>оформлено одразу</b>\n🤖 ZVONOK: <b>автоматичне підтвердження</b>\n`
      : `👩‍💼 Обробка: <b>передзвонить менеджер, без ZVONOK</b>\n`) +
    `📅 ${ts}\n━━━━━━━━━━━━━━━━━━`
  );
}

function telegramOrderMessageRefs(result) {
  const responses = Array.isArray(result?.result) ? result.result : [result];
  return responses.map(item => ({
    chatId: item?.result?.chat?.id,
    messageId: item?.result?.message_id,
  })).filter(item => item.chatId && item.messageId);
}

async function saveTelegramOrderRefs(orderId, refs) {
  if (!refs.length) return null;
  return withOrderMutationLock(async () => {
    const orders = read(F.orders);
    const idx = orders.findIndex(order => Number(order.id) === Number(orderId));
    if (idx < 0) return null;
    orders[idx] = { ...orders[idx], telegramOrderMessages: refs };
    writeOrders(orders);
    return orders[idx];
  });
}

async function notifyOrderCreatedOrUpgraded(order, upgraded) {
  const refs = Array.isArray(order.telegramOrderMessages) ? order.telegramOrderMessages : [];
  if (upgraded && refs.length) {
    await Promise.all(refs.map(ref => tgEdit(ref.chatId, ref.messageId, orderTelegramText(order, true), orderTelegramKeyboard(order))));
    return;
  }
  if (upgraded) return; // Never create a second Telegram card for one checkout.
  const sent = await tg(orderTelegramText(order, false), orderTelegramKeyboard(order));
  const refsAfterSend = telegramOrderMessageRefs(sent);
  const latest = await saveTelegramOrderRefs(order.id, refsAfterSend);
  // An instant upgrade can arrive while Telegram is still creating the manual
  // card. In that race, refresh the just-created card with the canonical order.
  if (latest && latest.updatedAt !== order.updatedAt && refsAfterSend.length) {
    await Promise.all(refsAfterSend.map(ref => (
      tgEdit(ref.chatId, ref.messageId, orderTelegramText(latest, true), orderTelegramKeyboard(latest))
    )));
  }
}

async function dispatchZvonokOnce(order, req) {
  const selected = await withOrderMutationLock(async () => {
    const orders = read(F.orders);
    const idx = orders.findIndex(item => Number(item.id) === Number(order.id));
    if (idx < 0 || orders[idx].orderMode !== 'instant' || orders[idx].zvonokDispatchStartedAt) return null;
    const now = new Date().toISOString();
    orders[idx] = {
      ...orders[idx],
      zvonokDispatchStartedAt: now,
      zvonokDispatchAttempts: Number(orders[idx].zvonokDispatchAttempts || 0) + 1,
      updatedAt: orders[idx].updatedAt || now,
    };
    writeOrders(orders);
    return orders[idx];
  });
  if (!selected) return null;

  const result = await startZvonokCall(selected, req);
  await withOrderMutationLock(async () => {
    const orders = read(F.orders);
    const idx = orders.findIndex(item => Number(item.id) === Number(order.id));
    if (idx < 0) return;
    orders[idx] = {
      ...orders[idx],
      zvonokDispatchOk: !!result?.ok,
      zvonokDispatchStatus: result?.status || null,
      zvonokDispatchFinishedAt: new Date().toISOString(),
      ...(result ? {} : { zvonokDispatchStartedAt: null, zvonokDispatchError: 'call_start_failed' }),
    };
    writeOrders(orders);
  });
  return result;
}

app.post('/api/order', rateLimit(60 * 1000, 5), asyncRoute(async (req, res) => {
  const {
    name, phone, size, color, product, price, variant, productVariant, quantity, contactViaTelegram,
    orderMode, fullName, city, district, postOffice, delivery,
    replaceOrderId, clientOrderKey, meta,
  } = req.body;
  if (!name || !phone || !size) return res.status(400).json({ error: 'Missing fields' });

  const cleanName  = sanitizeStr(name, 100);
  const cleanPhone = sanitizeStr(phone, 20);
  const cleanSize  = sanitizeStr(size, 10);
  const cleanColor = sanitizeStr(color, 40);
  const cleanProduct = sanitizeStr(product, 100);
  const cleanPrice = sanitizeStr(price, 20);
  const cleanVariant = sanitizeStr(variant || productVariant, 80);
  const cleanQuantity = Math.max(1, Math.min(20, Number(quantity) || 1));
  const cleanClientOrderKey = sanitizeStr(clientOrderKey, 80);
  const cleanOrderMode = sanitizeStr(orderMode, 20) === 'instant' ? 'instant' : 'manual';
  const deliveryData = delivery && typeof delivery === 'object' ? delivery : {};
  const cleanFullName = sanitizeStr(fullName || deliveryData.fullName || deliveryData.name, 140);
  const cleanCity = sanitizeStr(city || deliveryData.city, 80);
  const cleanDistrict = sanitizeStr(district || deliveryData.district || deliveryData.area, 80);
  const cleanPostOffice = sanitizeStr(postOffice || deliveryData.postOffice || deliveryData.novaPoshta || deliveryData.branch, 80);
  if (!cleanName || !cleanPhone || !cleanSize)
    return res.status(400).json({ error: 'Invalid fields' });
  if (cleanOrderMode === 'instant' && (!cleanFullName || !cleanCity || !cleanPostOffice))
    return res.status(400).json({ error: 'Missing delivery fields' });

  const incoming = {
    name: cleanName,
    phone: cleanPhone,
    size: cleanSize,
    color: cleanColor || null,
    product: cleanProduct || null,
    price: cleanPrice || null,
    variant: cleanVariant || null,
    quantity: cleanQuantity,
    clientOrderKey: cleanClientOrderKey || null,
    orderMode: cleanOrderMode,
    fullName: cleanFullName || null,
    city: cleanCity || null,
    district: cleanDistrict || null,
    postOffice: cleanPostOffice || null,
    contactViaTelegram: !!contactViaTelegram,
  };

  const mutation = await withOrderMutationLock(async () => {
    const orders = read(F.orders);
    const fingerprint = orderDedupeFingerprint(incoming);
    const byKeyIdx = cleanClientOrderKey
      ? orders.findIndex(order => order.clientOrderKey === cleanClientOrderKey)
      : -1;

    if (byKeyIdx >= 0 && (cleanOrderMode === 'manual' || orders[byKeyIdx].orderMode === 'instant' || !isActiveNewOrder(orders[byKeyIdx]))) {
      return { order: orders[byKeyIdx], duplicate: true, upgraded: false, created: false };
    }

    if (cleanOrderMode === 'manual') {
      const duplicate = orders.find(order => isActiveNewOrder(order) && orderDedupeFingerprint(order) === fingerprint);
      if (duplicate) return { order: duplicate, duplicate: true, upgraded: false, created: false };
    }

    let upgradeIdx = byKeyIdx;
    const replaceId = Number(replaceOrderId || 0);
    if (cleanOrderMode === 'instant' && upgradeIdx < 0 && replaceId) {
      upgradeIdx = orders.findIndex(order => (
        Number(order.id) === replaceId &&
        isActiveNewOrder(order) &&
        (order.orderMode || 'manual') === 'manual' &&
        orderDedupeFingerprint(order) === fingerprint
      ));
    }
    if (cleanOrderMode === 'instant' && upgradeIdx < 0) {
      upgradeIdx = orders.findIndex(order => (
        isActiveNewOrder(order) &&
        (order.orderMode || 'manual') === 'manual' &&
        orderDedupeFingerprint(order) === fingerprint
      ));
    }
    if (cleanOrderMode === 'instant' && upgradeIdx < 0) {
      const duplicate = orders.find(order => isActiveNewOrder(order) && orderDedupeFingerprint(order) === fingerprint);
      if (duplicate) return { order: duplicate, duplicate: true, upgraded: false, created: false };
    }

    const now = new Date().toISOString();
    if (cleanOrderMode === 'instant' && upgradeIdx >= 0 && isActiveNewOrder(orders[upgradeIdx])) {
      const previous = orders[upgradeIdx];
      orders[upgradeIdx] = {
        ...previous,
        ...incoming,
        id: previous.id,
        createdAt: previous.createdAt || now,
        updatedAt: now,
        upgradedFromManualAt: now,
        confirmationSource: 'zvonok_pending',
        clientOrderKey: previous.clientOrderKey || cleanClientOrderKey || null,
      };
      writeOrders(orders);
      return { order: orders[upgradeIdx], duplicate: false, upgraded: true, created: false };
    }

    const order = { id: nextId(orders), ...incoming, status: 'new', createdAt: now, updatedAt: now };
    orders.push(order);
    writeOrders(orders);
    return { order, duplicate: false, upgraded: false, created: true };
  });

  const o = mutation.order;
  if (mutation.duplicate) {
    return res.json({ success: true, id: o.id, duplicate: true, orderMode: o.orderMode || 'manual' });
  }
  await updateOrderQueueNotice(o);
  if (mutation.created) {
    sendMetaConversionEvent('Lead', o, req, meta, { order_id: String(o.id) }).catch(e => console.error('[Meta CAPI]', e.message));
  }
  await notifyOrderCreatedOrUpgraded(o, mutation.upgraded);
  if (o.orderMode === 'instant') {
    try { await dispatchZvonokOnce(o, req); }
    catch (e) { console.error(`[Zvonok] unexpected order #${o.id} error:`, e.message); }
  }

  res.json({ success: true, id: o.id, upgraded: mutation.upgraded });
}));

app.get('/api/orders',        authBot, (_req, res) => res.json(read(F.orders)));
app.get('/api/orders/:id',    authBot, (req, res) => {
  const o = read(F.orders).find(x => x.id === +req.params.id);
  o ? res.json(o) : res.status(404).json({ error: 'Not found' });
});
app.patch('/api/orders/:id',  authBot, (req, res) => {
  const arr = read(F.orders); const idx = arr.findIndex(x => x.id === +req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  writeOrders(arr);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) updateOrderQueueNotice(arr[idx]).catch(e => console.error('[order notice]', e.message));
  res.json(arr[idx]);
});
app.delete('/api/orders/:id', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  writeOrders(arr.filter(x => x.id !== id));
  updateOrderQueueNotice().catch(e => console.error('[order notice]', e.message));
  res.json({ success: true });
});

app.all('/api/zvonok/ivr', asyncRoute(async (req, res) => {
  const payload = { ...req.query, ...req.body };

  if (!ZVONOK_WEBHOOK_SECRET) return res.status(503).json({ error: 'Webhook is not configured' });
  const secret = payload.secret || req.headers['x-zvonok-secret'];
  if (!secretEqual(secret, ZVONOK_WEBHOOK_SECRET)) return res.status(401).json({ error: 'Unauthorized' });

  const orders = read(F.orders);
  const idx = findOrderIndexByZvonokPayload(orders, payload);
  if (idx < 0) {
    console.warn('[Zvonok] webhook order not found');
    return res.status(404).json({ error: 'Order not found' });
  }

  const order = orders[idx];
  const digit = getZvonokDigit(payload);
  const status = getZvonokStatus(payload);
  const noAnswerStatuses = ['no_answer', 'noanswer', 'busy', 'failed', 'fail', 'error', 'unanswered', 'not_available'];

  let nextStatus = null;
  let message = null;

  if (digit === '1') {
    nextStatus = 'confirmed';
    message =
      `✅ Замовлення підтверджено автоматичним дзвінком\n` +
      formatOrderForZvonokMessage(order);
  } else if (digit === '2') {
    nextStatus = 'cancelled';
    message =
      `❌ Клієнт скасував замовлення через автоматичний дзвінок\n` +
      formatOrderForZvonokMessage(order);
  } else if (noAnswerStatuses.some(s => status.includes(s))) {
    nextStatus = 'no_answer';
    message =
      `📞 Клієнт не відповів на автоматичний дзвінок — потрібна ручна перевірка\n` +
      formatOrderForZvonokMessage(order);
  }

  if (!nextStatus) {
    console.log(`[Zvonok] webhook ignored for order #${order.id}`);
    return res.json({ success: true, ignored: true });
  }

  if (
    order.status === nextStatus
    && String(order.zvonokButton || '') === String(digit || '')
    && String(order.zvonokStatus || '') === String(status || '')
  ) {
    return res.json({ success: true, replay: true, orderId: order.id, status: nextStatus });
  }

  orders[idx] = {
    ...order,
    status: nextStatus,
    updatedAt: new Date().toISOString(),
    zvonokStatus: status || null,
    zvonokButton: digit || null,
    ...(digit === '1' ? { confirmationSource: 'zvonok', zvonokConfirmedAt: new Date().toISOString() } : {}),
    ...(digit === '2' ? { cancelledAt: new Date().toISOString() } : {}),
  };
  writeOrders(orders);

  await tg(message);
  console.log(`[Zvonok] webhook order #${order.id}: ${nextStatus}`);
  res.json({ success: true, orderId: order.id, status: nextStatus });
}));

/* ═══════════════════════════════════════════════════════════
   REVIEWS (public)
═══════════════════════════════════════════════════════════ */
app.post('/api/review', rateLimit(60 * 1000, 3), asyncRoute(async (req, res) => {
  const { name, rating, text, date } = req.body;
  if (!name || !rating || !text) return res.status(400).json({ error: 'Missing fields' });
  const cleanName = sanitizeStr(name, 100);
  const cleanText = sanitizeStr(text, 1000);
  const ratingNum = Math.min(5, Math.max(1, Number(rating)));
  if (!cleanName || !cleanText || isNaN(ratingNum))
    return res.status(400).json({ error: 'Invalid fields' });

  const reviews = read(F.reviews);
  const rv = { id: nextId(reviews), name: cleanName, rating: ratingNum, text: cleanText,
    date: date || new Date().toISOString().slice(0, 10), createdAt: new Date().toISOString() };
  reviews.push(rv); write(F.reviews, reviews);

  const st = '★'.repeat(rv.rating) + '☆'.repeat(5 - rv.rating);
  await tg(
    `💬 <b>НОВИЙ ВІДГУК #${rv.id}</b>\n━━━━━━━━━━━━━━\n👤 <b>${rv.name}</b> ${st}\n<i>${rv.text}</i>`,
    { reply_markup: { inline_keyboard: [[{ text: '🗑 Видалити', callback_data: `del_review_${rv.id}` }]] } }
  );
  res.json({ success: true, id: rv.id });
}));

app.get('/api/reviews',        (_req, res) => res.json(read(F.reviews)));
app.delete('/api/reviews/:id', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.reviews);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.reviews, arr.filter(x => x.id !== id)); res.json({ success: true });
});

/* ═══════════════════════════════════════════════════════════
   SUPPORT (public)
═══════════════════════════════════════════════════════════ */
app.post('/api/support', rateLimit(60 * 1000, 10), asyncRoute(async (req, res) => {
  const { message, sessionId, timestamp, customer } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });
  const cleanMsg = sanitizeStr(message, 2000);
  if (!cleanMsg) return res.status(400).json({ error: 'Empty message' });
  const suppliedSessionId = supportSessionKey(sessionId);
  if (sessionId && !suppliedSessionId) return res.status(400).json({ error: 'Invalid sessionId' });
  const key = suppliedSessionId || supportSessionKey(null, `anonymous_${req.ip}`) || 'anonymous';
  getSession(key);
  const result = await withSupportSessionLock(key, async () => {
    const now = new Date().toISOString();
    const messageAt = asIsoSupportDate(timestamp, now);
    const prepared = await withSupportMutationLock(() => {
      const msgs = read(F.support);
      let idx = findOpenSupportIndex(msgs, key);
      const repeated = idx >= 0;
      if (idx < 0) {
        idx = msgs.length;
        msgs.push({
          id: nextId(msgs),
          sessionId: key,
          category: 'ai_history',
          status: 'active',
          customer: resolveSupportCustomer(customer),
          messages: [],
          startedAt: now,
          timestamp: messageAt,
          answered: false,
          accepted: false,
        });
      }

      const previous = msgs[idx];
      const priorTranscript = supportTranscript(previous);
      const current = {
        ...previous,
        customer: previous.customer?.orderId ? previous.customer : resolveSupportCustomer(customer),
        message: cleanMsg,
        timestamp: messageAt,
        updatedAt: now,
        messages: [...priorTranscript, supportMessage('user', cleanMsg, messageAt)],
      };
      msgs[idx] = current;
      write(F.support, msgs);
      return { current, priorTranscript, repeated };
    });
    let { current } = prepared;
    const { priorTranscript, repeated } = prepared;

    if (current.accepted || current.status === 'accepted') {
      await notifySupportRequest(current, 'dialog');
      return { success: true, id: current.id, repeated, human: true };
    }

    const needsHuman = supportIssueNeedsManager(cleanMsg);
    const localReply = needsHuman ? null : localSupportReply(cleanMsg);
    const ai = localReply
      ? { action: 'answer', reply: localReply, reason: 'local_knowledge_base' }
      : needsHuman ? null : await askSupportAi(key, cleanMsg, priorTranscript);
    if (ai?.action === 'answer') {
      const persisted = await withSupportMutationLock(() => {
        const msgs = read(F.support);
        const idx = msgs.findIndex(item => item.id === current.id);
        if (idx < 0) return { missing: true };
        const latest = msgs[idx];
        if (latest.accepted || latest.status === 'accepted') return { current: latest, human: true };
        const completedAt = new Date().toISOString();
        const merged = {
          ...latest,
          category: 'ai_history',
          status: 'active',
          answered: true,
          aiHandled: true,
          aiError: false,
          aiLastReply: ai.reply,
          updatedAt: completedAt,
          messages: [...supportTranscript(latest), supportMessage('ai', ai.reply, completedAt)],
          summaryDueAt: new Date(Date.now() + SUPPORT_AI_IDLE_MINUTES * 60 * 1000).toISOString(),
        };
        msgs[idx] = merged;
        write(F.support, msgs);
        return { current: merged };
      });
      if (persisted.missing) return { success: false, id: current.id, repeated, error: 'Support session no longer exists' };
      current = persisted.current;
      if (persisted.human) {
        await notifySupportRequest(current, 'dialog');
        return { success: true, id: current.id, repeated, human: true };
      }
      return { success: true, id: current.id, repeated, aiReply: ai.reply, ai: true };
    }

    const handoffReason = needsHuman
      ? 'Клієнт попросив менеджера або потрібна дія з замовленням'
      : ai?.reason || 'AI не зміг надійно вирішити запит';
    const persisted = await withSupportMutationLock(() => {
      const msgs = read(F.support);
      const idx = msgs.findIndex(item => item.id === current.id);
      if (idx < 0) return { missing: true };
      const latest = msgs[idx];
      if (latest.accepted || latest.status === 'accepted') return { current: latest, human: true };
      const completedAt = new Date().toISOString();
      const merged = {
        ...latest,
        category: 'manager_required',
        status: 'waiting_manager',
        accepted: false,
        answered: false,
        aiError: !needsHuman && !ai,
        handoffReason,
        summary: supportFallbackSummary({ ...latest, handoffReason }, true),
        summaryDueAt: null,
        updatedAt: completedAt,
      };
      if (ai?.reply) merged.messages = [...supportTranscript(latest), supportMessage('ai', ai.reply, completedAt)];
      msgs[idx] = merged;
      write(F.support, msgs);
      return { current: merged };
    });
    if (persisted.missing) return { success: false, id: current.id, repeated, error: 'Support session no longer exists' };
    current = persisted.current;
    if (persisted.human) {
      await notifySupportRequest(current, 'dialog');
      return { success: true, id: current.id, repeated, human: true };
    }
    await notifySupportRequest(current, 'handoff');
    return {
      success: true,
      id: current.id,
      repeated,
      handoff: true,
      aiError: !needsHuman && !ai,
      aiReply: ai?.reply || 'Передаю питання менеджеру. Він підключиться й допоможе з деталями.',
    };
  });
  res.json(result);
}));

app.get('/api/support',        authBot, (_req, res) => res.json(read(F.support)));
app.patch('/api/support/:id',  authBot, (req, res) => {
  const arr = read(F.support); const idx = arr.findIndex(x => x.id === +req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.support, arr); res.json(arr[idx]);
});

/* ── Frontend fallback ─────────────────────────────────────── */
app.get('/', (_req, res) => { res.type('text/html'); res.sendFile(path.join(PUBLIC_ROOT, 'index.html')); });
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (path.extname(req.path)) return res.status(404).end();
  res.type('text/html');
  res.sendFile(path.join(PUBLIC_ROOT, 'index.html'));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const code = sanitizeStr(error?.code || error?.name || 'INTERNAL_ERROR', 80);
  console.error(`[http] ${req.method} ${req.path} failed (${code})`);
  return res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🟣 ${SHOP_NAME} → http://localhost:${PORT}`);
  console.log(`🖥️  Landing directory: ${PUBLIC_ROOT}`);
  if (!TG_TOKEN) console.warn('⚠️  TG_TOKEN not set — Telegram disabled');
  console.log(`🔑 API key configured: ${API_KEY ? 'yes' : 'no'}`);
});
