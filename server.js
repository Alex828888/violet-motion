/**
 * VIOLET MOTION — SERVER
 * node server.js
 *
 * .env:  PORT, TG_TOKEN, TG_CHAT_ID, API_KEY
 */

require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');

const app  = express();
const PORT = process.env.PORT     || 3000;
const TG_TOKEN   = process.env.TG_TOKEN   || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';
const API_KEY    = process.env.API_KEY    || 'violet-secret';

/* ── Data ──────────────────────────────────────────────────── */
const DATA = path.join(__dirname, 'data');
const F = {
  orders:  path.join(DATA, 'orders.json'),
  reviews: path.join(DATA, 'reviews.json'),
  support: path.join(DATA, 'support.json'),
};
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

function read(f)    { try { return JSON.parse(fs.readFileSync(f,'utf8')); } catch { return []; } }
function write(f,d) { fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8'); }
function nextId(a)  { return a.length ? Math.max(...a.map(x=>x.id||0))+1 : 1; }

/* ── Telegram ──────────────────────────────────────────────── */
async function tg(text, extra = {}) {
  if (!TG_TOKEN || !TG_CHAT_ID) return null;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TG_CHAT_ID,
        text,
        parse_mode: 'HTML',
        ...extra,
      }),
    });
    return await r.json();
  } catch (e) {
    console.error('[TG]', e.message);
    return null;
  }
}

/* ── SSE sessions (in-memory) ──────────────────────────────── */
// sessions[sessionId] = { res: Response | null, accepted: bool, managerId: number | null }
const sessions = {};

function getSession(id) {
  if (!sessions[id]) sessions[id] = { res: null, accepted: false, managerId: null };
  return sessions[id];
}

function sseWrite(sessionId, data) {
  const s = sessions[sessionId];
  if (s?.res) {
    try { s.res.write(`data: ${JSON.stringify(data)}\n\n`); } catch {}
  }
}

/* ── Middleware ────────────────────────────────────────────── */
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ── SSE endpoint (client subscribes) ─────────────────────── */
app.get('/api/support/stream', (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const sess = getSession(sessionId);
  sess.res = res;

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch {}
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    if (sessions[sessionId]) sessions[sessionId].res = null;
  });
});

/* ── Bot relay endpoint (bot.js calls this) ────────────────── */
function authBot(req, res, next) {
  if (req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

/** POST /api/support/relay — bot sends message to client */
app.post('/api/support/relay', authBot, (req, res) => {
  const { sessionId, text, managerName } = req.body;
  if (!sessionId || !text) return res.status(400).json({ error: 'Missing fields' });

  sseWrite(sessionId, { type: 'message', text, managerName: managerName || 'Оператор' });
  res.json({ success: true });
});

/** POST /api/support/accept — bot accepts a session */
app.post('/api/support/accept', authBot, (req, res) => {
  const { sessionId, managerId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const sess = getSession(sessionId);
  sess.accepted = true;
  sess.managerId = managerId;

  const msgs = read(F.support);
  const idx  = msgs.findIndex(m => m.sessionId === sessionId && !m.answered);
  if (idx >= 0) {
    msgs[idx].accepted = true;
    msgs[idx].managerId = managerId || null;
    msgs[idx].acceptedAt = new Date().toISOString();
    write(F.support, msgs);
  }

  sseWrite(sessionId, { type: 'accepted' });
  res.json({ success: true });
});

/** POST /api/support/end — bot ends dialog */
app.post('/api/support/end', authBot, (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  sseWrite(sessionId, { type: 'end' });

  if (sessions[sessionId]) {
    sessions[sessionId].accepted = false;
    sessions[sessionId].managerId = null;
  }

  const msgs = read(F.support);
  const idx  = msgs.findIndex(m => m.sessionId === sessionId && !m.answered);
  if (idx >= 0) {
    msgs[idx].answered = true;
    msgs[idx].endedAt = new Date().toISOString();
    write(F.support, msgs);
  }

  res.json({ success: true });
});

/** GET /api/support/sessions — bot checks all active sessions */
app.get('/api/support/sessions', authBot, (_req, res) => {
  const active = Object.entries(sessions).map(([id, s]) => ({
    sessionId: id,
    accepted:  s.accepted,
    managerId: s.managerId,
    connected: !!s.res,
  }));
  res.json(active);
});

/* ═══════════════════════════════════════════════════════════
   ORDERS
═══════════════════════════════════════════════════════════ */
app.post('/api/order', async (req, res) => {
  const { name, phone, size, contactViaTelegram } = req.body;
  if (!name || !phone || !size) return res.status(400).json({ error: 'Missing fields' });

  const orders = read(F.orders);
  const o = {
    id: nextId(orders),
    name: name.trim(),
    phone: phone.trim(),
    size: String(size).trim(),
    contactViaTelegram: !!contactViaTelegram,
    status: 'new',
    createdAt: new Date().toISOString(),
  };
  orders.push(o);
  write(F.orders, orders);

  const ts  = new Date(o.createdAt).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  const tgTxt =
    `🛒 <b>НОВЕ ЗАМОВЛЕННЯ #${o.id}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `👤 Ім'я:    <b>${o.name}</b>\n` +
    `📱 Телефон: <b>${o.phone}</b>\n` +
    `👟 Розмір:  <b>${o.size}</b>\n` +
    (o.contactViaTelegram ? `💬 Спосіб зв'язку: <b>Telegram</b>\n` : `📞 Спосіб зв'язку: <b>Дзвінок</b>\n`) +
    `📅 ${ts}\n` +
    `━━━━━━━━━━━━━━━━━━`;

  await tg(tgTxt, {
    reply_markup: { inline_keyboard: [[
      { text: '✅ Підтвердити', callback_data: `confirm_${o.id}` },
      { text: '❌ Скасувати',   callback_data: `cancel_${o.id}`  },
    ]]},
  });

  res.json({ success: true, id: o.id });
});

app.get('/api/orders', (_, r) => r.json(read(F.orders)));
app.get('/api/orders/:id', (q, r) => {
  const o = read(F.orders).find(x => x.id === +q.params.id);
  o ? r.json(o) : r.status(404).json({ error:'Not found' });
});
app.patch('/api/orders/:id', (q, r) => {
  const a = read(F.orders);
  const i = a.findIndex(x => x.id === +q.params.id);
  if (i < 0) return r.status(404).json({ error:'Not found' });
  Object.assign(a[i], q.body, { id: a[i].id });
  write(F.orders, a);
  r.json(a[i]);
});
app.delete('/api/orders/:id', (q, r) => {
  write(F.orders, read(F.orders).filter(x => x.id !== +q.params.id));
  r.json({ success:true });
});

/* ═══════════════════════════════════════════════════════════
   REVIEWS
═══════════════════════════════════════════════════════════ */
app.post('/api/review', async (req, res) => {
  const { name, rating, text, date } = req.body;
  if (!name || !rating || !text) return res.status(400).json({ error: 'Missing fields' });

  const reviews = read(F.reviews);
  const rv = {
    id: nextId(reviews),
    name: name.trim(),
    rating: Number(rating),
    text: text.trim(),
    date: date || new Date().toISOString().slice(0,10),
    createdAt: new Date().toISOString()
  };
  reviews.push(rv);
  write(F.reviews, reviews);

  const st = '★'.repeat(rv.rating) + '☆'.repeat(5 - rv.rating);
  await tg(
    `💬 <b>НОВИЙ ВІДГУК #${rv.id}</b>\n━━━━━━━━━━━━━━\n👤 <b>${rv.name}</b>  ${st}\n<i>${rv.text}</i>`,
    { reply_markup:{ inline_keyboard:[[{ text:'🗑 Видалити', callback_data:`del_review_${rv.id}` }]]}}
  );

  res.json({ success: true, id: rv.id });
});

app.get('/api/reviews', (_, r) => r.json(read(F.reviews)));
app.delete('/api/reviews/:id', (q, r) => {
  write(F.reviews, read(F.reviews).filter(x => x.id !== +q.params.id));
  r.json({ success:true });
});

/* ═══════════════════════════════════════════════════════════
   SUPPORT MESSAGES
═══════════════════════════════════════════════════════════ */
app.post('/api/support', async (req, res) => {
  const { message, sessionId, timestamp } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  const msgs = read(F.support);

  const existingIdx = sessionId
    ? msgs.findIndex(m => m.sessionId === sessionId && !m.answered)
    : -1;

  // Если уже есть активный запрос по sessionId — не создаём новый, а обновляем старый
  if (existingIdx >= 0) {
    msgs[existingIdx].message   = message.trim();
    msgs[existingIdx].timestamp = timestamp || new Date().toISOString();
    msgs[existingIdx].updatedAt = new Date().toISOString();
    write(F.support, msgs);

    const current = msgs[existingIdx];
    const ts = new Date(current.timestamp).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });

    // NEW: уведомляем оператора о новом сообщении клиента
    if (current.accepted) {
      await tg(
        `💬 <b>НОВЕ ПОВІДОМЛЕННЯ В ДІАЛОЗІ #${current.id}</b>\n━━━━━━━━━━━━━━\n🆔 <code>${current.sessionId}</code>\n💬 ${current.message}\n📅 ${ts}`
      );
    } else {
      await tg(
        `💭 <b>КЛІЄНТ ДОПИСАВ У ЗАПИТ #${current.id}</b>\n━━━━━━━━━━━━━━\n💬 ${current.message}\n📅 ${ts}`,
        { reply_markup:{ inline_keyboard:[[
          { text:'✋ Прийняти діалог', callback_data:`accept_${current.sessionId || current.id}` },
        ]]} }
      );
    }

    return res.json({ success: true, id: current.id, repeated: true });
  }

  // Первое сообщение — создаём новый запрос как и раньше
  const msg = {
    id: nextId(msgs),
    message: message.trim(),
    sessionId: sessionId || null,
    timestamp: timestamp || new Date().toISOString(),
    answered: false,
    accepted: false,
  };

  msgs.push(msg);
  write(F.support, msgs);

  const ts = new Date(msg.timestamp).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' });
  await tg(
    `🎧 <b>ПІДТРИМКА #${msg.id}</b>\n━━━━━━━━━━━━━━\n💬 ${msg.message}\n📅 ${ts}`,
    { reply_markup:{ inline_keyboard:[[
      { text:'✋ Прийняти діалог', callback_data:`accept_${sessionId || msg.id}` },
    ]]} }
  );

  res.json({ success: true, id: msg.id });
});

app.get('/api/support', (_, r) => r.json(read(F.support)));
app.patch('/api/support/:id', (q, r) => {
  const a = read(F.support);
  const i = a.findIndex(x => x.id === +q.params.id);
  if (i < 0) return r.status(404).json({ error:'Not found' });
  Object.assign(a[i], q.body, { id: a[i].id });
  write(F.support, a);
  r.json(a[i]);
});

/* catch-all */
app.get('*', (_, r) => r.sendFile(path.join(__dirname,'index.html')));

app.listen(PORT, () => {
  console.log(`\n🟣  Violet Motion  →  http://localhost:${PORT}`);
  if (!TG_TOKEN) console.warn('⚠️   TG_TOKEN not set — Telegram disabled');
  console.log(`🔑  Bot API key: ${API_KEY}`);
});