/**
 * VIOLET MOTION — SERVER v2
 * node server.js
 *
 * .env: PORT, TG_TOKEN, TG_CHAT_ID, API_KEY, ZVONOK_API_KEY, ZVONOK_CAMPAIGN_ID, ZVONOK_WEBHOOK_SECRET
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

const app        = express();
const PORT       = process.env.PORT       || 3000;
const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const API_KEY    = process.env.API_KEY    || 'violet-secret';
const ZVONOK_API_KEY = process.env.ZVONOK_API_KEY || '';
const ZVONOK_CAMPAIGN_ID = process.env.ZVONOK_CAMPAIGN_ID || '';
const ZVONOK_WEBHOOK_SECRET = process.env.ZVONOK_WEBHOOK_SECRET || '';
const ZVONOK_CALL_URL = 'https://zvonok.com/manager/cabapi_external/api/v1/phones/call/';

/* ── Data files ────────────────────────────────────────────── */
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const F = {
  orders:    path.join(DATA, 'orders.json'),
  reviews:   path.join(DATA, 'reviews.json'),
  support:   path.join(DATA, 'support.json'),
  analytics: path.join(DATA, 'analytics.json'),
};

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
for (const file of Object.values(F)) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]', 'utf8');
}

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}
function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function nextId(arr) {
  return arr.length ? Math.max(...arr.map(x => x.id || 0)) + 1 : 1;
}

/* ── Rate limiter ──────────────────────────────────────────── */
const rateLimits = new Map();
function rateLimit(windowMs, max) {
  return (req, res, next) => {
    const key  = req.ip || 'unknown';
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
}, 10 * 60 * 1000);

/* ── Telegram ──────────────────────────────────────────────── */
async function tg(text, extra = {}) {
  if (!TG_TOKEN || !TG_CHAT_ID) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT_ID, text, parse_mode: 'HTML', ...extra }),
    });
    return await r.json();
  } catch (e) { console.error('[TG]', e.message); return null; }
}

/* ══════════════════════════════════════════════════════════════
   SSE SESSIONS + PENDING MESSAGE QUEUE
   Fix: When operator replies but client SSE is disconnected,
   messages are queued. On reconnect they're flushed immediately.
══════════════════════════════════════════════════════════════ */
const sessions        = {};  // sessionId → { res, accepted, managerId }
const pendingMessages = {};  // sessionId → [event objects]
const MAX_QUEUE       = 50;

function getSession(id) {
  if (!sessions[id]) sessions[id] = { res: null, accepted: false, managerId: null };
  return sessions[id];
}

/** Write to SSE stream. If disconnected, queue the message. */
function sseWrite(sessionId, data) {
  const s = sessions[sessionId];
  if (s?.res) {
    try {
      s.res.write(`data: ${JSON.stringify(data)}\n\n`);
      return;
    } catch {}
  }
  // Connection not available — queue
  if (!pendingMessages[sessionId]) pendingMessages[sessionId] = [];
  pendingMessages[sessionId].push(data);
  if (pendingMessages[sessionId].length > MAX_QUEUE)
    pendingMessages[sessionId].shift();
}

/** Flush queued messages to a newly connected SSE client. */
function flushQueue(sessionId) {
  const msgs = pendingMessages[sessionId];
  if (!msgs || !msgs.length) return;
  const s = sessions[sessionId];
  if (!s?.res) return;
  msgs.forEach(data => {
    try { s.res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  });
  pendingMessages[sessionId] = [];
}

/* ── Middleware ────────────────────────────────────────────── */
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* ── Static files ──────────────────────────────────────────── */
app.get('/style.css',  (_req, res) => { res.type('text/css'); res.sendFile(path.join(ROOT, 'style.css')); });
app.get('/script.js',  (_req, res) => { res.type('application/javascript'); res.sendFile(path.join(ROOT, 'script.js')); });
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(ROOT, {
  extensions: false, fallthrough: true,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.css')  res.setHeader('Content-Type', 'text/css; charset=utf-8');
    if (ext === '.js')   res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    if (ext === '.json') res.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (ext === '.html') res.setHeader('Content-Type', 'text/html; charset=utf-8');
  },
}));

/* ── Auth ──────────────────────────────────────────────────── */
function authBot(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function sanitizeStr(val, max = 200) { return String(val || '').trim().slice(0, max); }

function escapeHtml(val) {
  return String(val || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function normalizePhoneForZvonok(phone) {
  const raw = String(phone || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 && digits.startsWith('0')) return `+38${digits}`;
  if (digits.length === 12 && digits.startsWith('380')) return `+${digits}`;
  if (raw.startsWith('+')) return `+${digits}`;
  return `+${digits}`;
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
  const base = getRequestBaseUrl(req);
  if (!base) return '';
  const url = new URL('/api/zvonok/ivr', base);
  url.searchParams.set('orderId', order.id);
  url.searchParams.set('button', button);
  if (ZVONOK_WEBHOOK_SECRET) url.searchParams.set('secret', ZVONOK_WEBHOOK_SECRET);
  return url.toString();
}

async function startZvonokCall(order, req) {
  if (!ZVONOK_API_KEY || !ZVONOK_CAMPAIGN_ID) {
    console.warn('[Zvonok] skipped: ZVONOK_API_KEY or ZVONOK_CAMPAIGN_ID is not set');
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
  form.append('label', `order_${order.id}`);

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
    console.log(`[Zvonok] order #${order.id} call start: ${response.status}`, data);
    return { ok: response.ok, status: response.status, data };
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

  events.forEach(ev => {
    if (!ev.event || !ev.sessionId) return;
    existing.push({
      event:     String(ev.event).slice(0, 50),
      sessionId: String(ev.sessionId).slice(0, 60),
      timestamp: ev.timestamp || now,
      data:      ev.data || {},
      referrer:  String(ev.referrer || '').slice(0, 200),
      ua:        String(ua || '').slice(0, 200),
      ip,
    });
  });

  // Prune entries older than 7 days
  const cutoff = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const pruned = existing.filter(e => (e.timestamp || '') >= cutoff);

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
  const sessionMap = {};
  filtered.forEach(ev => {
    if (!sessionMap[ev.sessionId]) sessionMap[ev.sessionId] = { events: [], ip: ev.ip };
    sessionMap[ev.sessionId].events.push(ev);
  });

  const ipCounts = {};
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
  const buttonClicks = {};
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
app.get('/api/admin/orders',       authBot, (_req, res) => res.json(read(F.orders)));
app.get('/api/admin/orders/:id',   authBot, (req, res) => {
  const order = read(F.orders).find(x => x.id === Number(req.params.id));
  order ? res.json(order) : res.status(404).json({ error: 'Not found' });
});
app.patch('/api/admin/orders/:id', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  const idx = arr.findIndex(x => x.id === id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.orders, arr); res.json(arr[idx]);
});
app.delete('/api/admin/orders/:id', authBot, (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.orders, arr.filter(x => x.id !== id)); res.json({ success: true });
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

/* ── SSE endpoint ──────────────────────────────────────────── */
app.get('/api/support/stream', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  // Tell client to retry after 3.5s on disconnect
  res.write('retry: 3500\n\n');
  res.flushHeaders();

  const sess = getSession(sessionId);
  sess.res   = res;

  // Immediately flush any messages that arrived while disconnected
  flushQueue(sessionId);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    if (sessions[sessionId]) sessions[sessionId].res = null;
  });
});

/* ── Bot relay ─────────────────────────────────────────────── */
app.post('/api/support/relay', authBot, (req, res) => {
  const { sessionId, text, managerName } = req.body;
  if (!sessionId || !text) return res.status(400).json({ error: 'Missing fields' });
  sseWrite(sessionId, { type: 'message', text, managerName: managerName || 'Оператор' });
  res.json({ success: true });
});

app.post('/api/support/accept', authBot, (req, res) => {
  const { sessionId, managerId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  const sess = getSession(sessionId);
  sess.accepted  = true;
  sess.managerId = managerId;
  sseWrite(sessionId, { type: 'accepted' });
  res.json({ success: true });
});

app.post('/api/support/end', authBot, (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });
  sseWrite(sessionId, { type: 'end' });
  const msgs = read(F.support);
  const idx  = msgs.findIndex(m => m.sessionId === sessionId && !m.answered);
  if (idx >= 0) {
    msgs[idx].answered = true;
    msgs[idx].endedAt  = new Date().toISOString();
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
   ORDERS (public)
═══════════════════════════════════════════════════════════ */
app.post('/api/order', rateLimit(60 * 1000, 5), async (req, res) => {
  const { name, phone, size, color, product, price, contactViaTelegram } = req.body;
  if (!name || !phone || !size) return res.status(400).json({ error: 'Missing fields' });

  const cleanName  = sanitizeStr(name, 100);
  const cleanPhone = sanitizeStr(phone, 20);
  const cleanSize  = sanitizeStr(size, 10);
  const cleanColor = sanitizeStr(color, 40);
  const cleanProduct = sanitizeStr(product, 100);
  const cleanPrice = sanitizeStr(price, 20);
  if (!cleanName || !cleanPhone || !cleanSize)
    return res.status(400).json({ error: 'Invalid fields' });

  const orders = read(F.orders);
  const o = {
    id: nextId(orders), name: cleanName, phone: cleanPhone, size: cleanSize,
    color: cleanColor || null, product: cleanProduct || null, price: cleanPrice || null,
    contactViaTelegram: !!contactViaTelegram, status: 'new', createdAt: new Date().toISOString(),
  };
  orders.push(o); write(F.orders, orders);

  const ts = new Date(o.createdAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  await tg(
    `🛒 <b>НОВЕ ЗАМОВЛЕННЯ #${o.id}</b>\n━━━━━━━━━━━━━━━━━━\n` +
    (o.product ? `🛍 Товар: <b>${o.product}</b>\n` : '') +
    `👤 Ім'я: <b>${o.name}</b>\n📱 Телефон: <b>${o.phone}</b>\n` +
    `👟 Розмір: <b>${o.size}</b>\n` +
    (o.color ? `🎨 Колір: <b>${o.color}</b>\n` : '') +
    (o.price ? `💵 Ціна: <b>${o.price} грн</b>\n` : '') +
    (o.contactViaTelegram ? `💬 Зв'язок: <b>Telegram</b>\n` : `📞 Зв'язок: <b>Дзвінок</b>\n`) +
    `📅 ${ts}\n━━━━━━━━━━━━━━━━━━`,
    { reply_markup: { inline_keyboard: [[
      { text: '✅ Підтвердити', callback_data: `confirm_${o.id}` },
      { text: '❌ Скасувати',  callback_data: `cancel_${o.id}` },
    ]] } }
  );
  // Zvonok is best-effort: order creation and Telegram notifications stay intact if it fails.
  try { await startZvonokCall(o, req); }
  catch (e) { console.error(`[Zvonok] unexpected order #${o.id} error:`, e.message); }

  res.json({ success: true, id: o.id });
});

app.get('/api/orders',        (_req, res) => res.json(read(F.orders)));
app.get('/api/orders/:id',    (req, res) => {
  const o = read(F.orders).find(x => x.id === +req.params.id);
  o ? res.json(o) : res.status(404).json({ error: 'Not found' });
});
app.patch('/api/orders/:id',  (req, res) => {
  const arr = read(F.orders); const idx = arr.findIndex(x => x.id === +req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.orders, arr); res.json(arr[idx]);
});
app.delete('/api/orders/:id', (req, res) => {
  const id = Number(req.params.id); const arr = read(F.orders);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.orders, arr.filter(x => x.id !== id)); res.json({ success: true });
});

app.all('/api/zvonok/ivr', async (req, res) => {
  const payload = { ...req.query, ...req.body };

  if (ZVONOK_WEBHOOK_SECRET) {
    const secret = payload.secret || req.headers['x-zvonok-secret'];
    if (secret !== ZVONOK_WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  }

  const orders = read(F.orders);
  const idx = findOrderIndexByZvonokPayload(orders, payload);
  if (idx < 0) {
    console.warn('[Zvonok] webhook order not found:', payload);
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
    console.log(`[Zvonok] webhook received for order #${order.id}:`, payload);
    return res.json({ success: true, ignored: true });
  }

  orders[idx] = {
    ...order,
    status: nextStatus,
    updatedAt: new Date().toISOString(),
    zvonokStatus: status || null,
    zvonokButton: digit || null,
  };
  write(F.orders, orders);

  await tg(message);
  console.log(`[Zvonok] webhook order #${order.id}: ${nextStatus}`, payload);
  res.json({ success: true, orderId: order.id, status: nextStatus });
});

/* ═══════════════════════════════════════════════════════════
   REVIEWS (public)
═══════════════════════════════════════════════════════════ */
app.post('/api/review', rateLimit(60 * 1000, 3), async (req, res) => {
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
});

app.get('/api/reviews',        (_req, res) => res.json(read(F.reviews)));
app.delete('/api/reviews/:id', (req, res) => {
  const id = Number(req.params.id); const arr = read(F.reviews);
  if (!arr.some(x => x.id === id)) return res.status(404).json({ error: 'Not found' });
  write(F.reviews, arr.filter(x => x.id !== id)); res.json({ success: true });
});

/* ═══════════════════════════════════════════════════════════
   SUPPORT (public)
═══════════════════════════════════════════════════════════ */
app.post('/api/support', rateLimit(60 * 1000, 10), async (req, res) => {
  const { message, sessionId, timestamp } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });
  const cleanMsg = sanitizeStr(message, 2000);
  if (!cleanMsg) return res.status(400).json({ error: 'Empty message' });

  const msgs = read(F.support);
  const existingIdx = sessionId
    ? msgs.findIndex(m => m.sessionId === sessionId && !m.answered)
    : -1;

  if (existingIdx >= 0) {
    msgs[existingIdx].message   = cleanMsg;
    msgs[existingIdx].timestamp = timestamp || new Date().toISOString();
    msgs[existingIdx].updatedAt = new Date().toISOString();
    write(F.support, msgs);
    const current = msgs[existingIdx];
    const ts = new Date(current.timestamp).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
    if (current.accepted) {
      await tg(`💬 <b>НОВЕ ПОВІДОМЛЕННЯ В ДІАЛОЗІ #${current.id}</b>\n━━━━━━━━━━━━━━\n🆔 <code>${current.sessionId}</code>\n💬 ${current.message}\n📅 ${ts}`);
    } else {
      await tg(
        `💭 <b>КЛІЄНТ ДОПИСАВ У ЗАПИТ #${current.id}</b>\n━━━━━━━━━━━━━━\n💬 ${current.message}\n📅 ${ts}`,
        { reply_markup: { inline_keyboard: [[{ text: '✋ Прийняти діалог', callback_data: `accept_${current.sessionId || current.id}` }]] } }
      );
    }
    return res.json({ success: true, id: current.id, repeated: true });
  }

  const msg = {
    id: nextId(msgs), message: cleanMsg, sessionId: sessionId || null,
    timestamp: timestamp || new Date().toISOString(), answered: false, accepted: false,
  };
  msgs.push(msg); write(F.support, msgs);

  const ts = new Date(msg.timestamp).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  await tg(
    `🎧 <b>ПІДТРИМКА #${msg.id}</b>\n━━━━━━━━━━━━━━\n💬 ${msg.message}\n📅 ${ts}`,
    { reply_markup: { inline_keyboard: [[{ text: '✋ Прийняти діалог', callback_data: `accept_${sessionId || msg.id}` }]] } }
  );
  res.json({ success: true, id: msg.id });
});

app.get('/api/support',        (_req, res) => res.json(read(F.support)));
app.patch('/api/support/:id',  (req, res) => {
  const arr = read(F.support); const idx = arr.findIndex(x => x.id === +req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  arr[idx] = { ...arr[idx], ...req.body, id: arr[idx].id, updatedAt: new Date().toISOString() };
  write(F.support, arr); res.json(arr[idx]);
});

/* ── Frontend fallback ─────────────────────────────────────── */
app.get('/', (_req, res) => { res.type('text/html'); res.sendFile(path.join(ROOT, 'index.html')); });
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const possibleFile = path.join(ROOT, req.path);
  if (fs.existsSync(possibleFile) && fs.statSync(possibleFile).isFile())
    return res.sendFile(possibleFile);
  res.type('text/html');
  res.sendFile(path.join(ROOT, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🟣 Violet Motion → http://localhost:${PORT}`);
  if (!TG_TOKEN) console.warn('⚠️  TG_TOKEN not set — Telegram disabled');
  console.log(`🔑 API key: ${API_KEY}`);
});
