/* ═══════════════════════════════════════════════════════════
   VIOLET MOTION — CLIENT SCRIPT v2
   Analytics · Smart Float Btn · Realistic Activity
   Skeleton Loading · Scroll Animations · SSE Chat Fix
═══════════════════════════════════════════════════════════ */

const API = '';

/* ── Facebook Pixel ─────────────────────────────────────────── */
function fbTrack(event, params = {}) {
  if (typeof fbq === 'function') fbq('track', event, params);
}

/* ── Utils ─────────────────────────────────────────────────── */
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }
function showMsg(el, text, type) {
  el.textContent = text;
  el.className = type ? `form-message ${type}` : 'form-message';
}

async function postJSON(path, data, timeout = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    return await r.json();
  } catch (e) {
    clearTimeout(t);
    return { success: false, timeout: e.name === 'AbortError' };
  }
}

async function getJSON(path, timeout = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(API + path, { signal: ctrl.signal });
    clearTimeout(t);
    return await r.json();
  } catch {
    clearTimeout(t);
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════
   ANALYTICS SYSTEM
   Tracks: page_view, scroll_depth, button_click, form_start,
   form_submit, order_success, size_select, support_open,
   gallery_click, session_end
   Sends batched events to /api/analytics every 30s + on unload
══════════════════════════════════════════════════════════════ */
const Analytics = (function () {
  const SESS_KEY  = 'vm_va_sess';
  const START_KEY = 'vm_va_start';

  let sessionId = localStorage.getItem(SESS_KEY);
  if (!sessionId) {
    sessionId = 'va_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    localStorage.setItem(SESS_KEY, sessionId);
  }

  const startTime = Date.now();
  localStorage.setItem(START_KEY, String(startTime));

  const queue = [];
  let isFlushing = false;
  const referrer = document.referrer.slice(0, 200);
  const ua = navigator.userAgent.slice(0, 200);

  function track(event, data = {}) {
    queue.push({
      event,
      sessionId,
      timestamp: new Date().toISOString(),
      data,
      referrer,
    });
  }

  async function flush(keepAlive = false) {
    if (isFlushing || !queue.length) return;
    isFlushing = true;
    const batch = queue.splice(0, 30);
    try {
      await fetch(API + '/api/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: batch, ua }),
        keepalive: keepAlive,
      });
    } catch {}
    isFlushing = false;
  }

  // Flush every 30s
  setInterval(() => flush(), 30000);

  // Flush on page close
  window.addEventListener('beforeunload', () => {
    const duration = Math.round((Date.now() - startTime) / 1000);
    track('session_end', { duration });
    flush(true);
  });

  // Track initial page view
  track('page_view');

  // Track clicks on data-track elements
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-track]');
    if (!el) return;
    const label = el.dataset.track;
    track('button_click', { label, text: el.textContent.trim().slice(0, 60) });
  });

  // Scroll depth tracking (25 / 50 / 75 / 90 / 100%)
  const depthHits = new Set();
  const MILESTONES = [25, 50, 75, 90, 100];

  function onScroll() {
    const scrolled = window.scrollY + window.innerHeight;
    const total    = document.documentElement.scrollHeight;
    const pct      = Math.floor((scrolled / total) * 100);

    MILESTONES.forEach(m => {
      if (pct >= m && !depthHits.has(m)) {
        depthHits.add(m);
        track('scroll_depth', { depth: m });
      }
    });
  }
  window.addEventListener('scroll', onScroll, { passive: true });

  // Form field interaction — track when user starts filling form
  let formStartTracked = false;
  document.querySelectorAll('#orderForm input, #orderForm select').forEach(el => {
    el.addEventListener('focus', () => {
      if (!formStartTracked) {
        formStartTracked = true;
        track('form_start');
      }
    }, { once: true });
  });

  return { track, flush };
})();

/* ── Gallery ────────────────────────────────────────────────── */
document.querySelectorAll('.thumb').forEach(t => {
  t.addEventListener('click', () => {
    const img = document.getElementById('mainGalleryImage');
    img.classList.add('sk-img-hidden');
    setTimeout(() => {
      img.src = t.dataset.image;
      img.onload = () => img.classList.remove('sk-img-hidden');
    }, 80);
    document.querySelectorAll('.thumb').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    Analytics.track('gallery_click', { image: t.dataset.image });
  });
});

/* ── Sizes ──────────────────────────────────────────────────── */
const sizeBtns          = document.querySelectorAll('.size-btn');
const selectedSizeInput = document.getElementById('selectedSize');

sizeBtns.forEach(b => {
  b.addEventListener('click', () => {
    sizeBtns.forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    selectedSizeInput.value = b.dataset.size;
    Analytics.track('size_select', { size: b.dataset.size });
  });
});

/* ══════════════════════════════════════════════════════════════
   COUNTDOWN TIMER — syncs hero inline + main timer
══════════════════════════════════════════════════════════════ */
(function () {
  const KEY = 'vm_timer_end';
  let end = Number(localStorage.getItem(KEY));
  if (!end || end < Date.now()) {
    end = Date.now() + 24 * 3600 * 1000;
    localStorage.setItem(KEY, end);
  }

  const h  = document.getElementById('hours');
  const m  = document.getElementById('minutes');
  const s  = document.getElementById('seconds');
  const hi = document.getElementById('heroTimerInline');

  function tick() {
    const diff = Math.max(0, Math.floor((end - Date.now()) / 1000));
    const hh   = String(Math.floor(diff / 3600)).padStart(2, '0');
    const mm   = String(Math.floor((diff % 3600) / 60)).padStart(2, '0');
    const ss   = String(diff % 60).padStart(2, '0');
    if (h)  h.textContent  = hh;
    if (m)  m.textContent  = mm;
    if (s)  s.textContent  = ss;
    if (hi) hi.textContent = `${hh}:${mm}:${ss}`;
  }
  tick();
  setInterval(tick, 1000);
})();

/* ══════════════════════════════════════════════════════════════
   STOCK — realistic random walk, syncs ticker + sale section
   Moves ±1 with realistic probability, never looks "perfect"
══════════════════════════════════════════════════════════════ */
(function () {
  const stockEl  = document.getElementById('stockCount');
  const tickerEl = document.getElementById('tickerStock');
  const mirrors  = document.querySelectorAll('.ticker-stock-mirror');

  // Load from storage so count persists across page refreshes
  const DAY_KEY = 'vm_stock_day';
  const VAL_KEY = 'vm_stock_val';
  const today   = new Date().toDateString();

  if (localStorage.getItem(DAY_KEY) !== today) {
    localStorage.setItem(DAY_KEY, today);
    localStorage.setItem(VAL_KEY, String(15 + Math.floor(Math.random() * 5))); // 15–19
  }

  let n = Number(localStorage.getItem(VAL_KEY)) || 17;

  function setStock(val) {
    n = Math.max(6, Math.min(24, val));
    localStorage.setItem(VAL_KEY, String(n));
    if (stockEl)  stockEl.textContent  = n;
    if (tickerEl) tickerEl.textContent = n;
    mirrors.forEach(el => { el.textContent = n; });
  }
  setStock(n); // initial render

  function scheduleNext() {
    // Interval: 90–240 seconds to feel organic
    const delay = (90 + Math.random() * 150) * 1000;
    setTimeout(() => {
      // 70% chance decrease (product is selling), 30% chance same or +1 (new stock)
      const r = Math.random();
      if (r < 0.70 && n > 8) setStock(n - 1);
      else if (r > 0.90 && n < 20) setStock(n + 1);
      scheduleNext();
    }, delay);
  }
  scheduleNext();
})();

/* ══════════════════════════════════════════════════════════════
   LIVE VIEWERS — smooth realistic random walk
   Starts at 18–32, drifts ±1–2 with organic timing
══════════════════════════════════════════════════════════════ */
(function () {
  const el = document.getElementById('heroViewers');
  if (!el) return;

  let v = 18 + Math.floor(Math.random() * 14); // 18–32
  el.textContent = v;

  function scheduleNext() {
    const delay = 5000 + Math.random() * 9000; // 5–14s
    setTimeout(() => {
      // Gentle random walk: mostly ±1, rarely ±2
      const delta = Math.random() < 0.8
        ? (Math.random() < 0.55 ? 1 : -1)
        : (Math.random() < 0.5 ? 2 : -2);
      v = Math.max(11, Math.min(41, v + delta));
      el.textContent = v;
      scheduleNext();
    }, delay);
  }
  scheduleNext();
})();

/* ══════════════════════════════════════════════════════════════
   TODAY ORDERS — persisted per day, grows organically
══════════════════════════════════════════════════════════════ */
(function () {
  const todayEl    = document.getElementById('todayOrders');
  const lastTimeEl = document.getElementById('lastOrderTime');
  if (!todayEl) return;

  const D_KEY = 'vm_od_day';
  const C_KEY = 'vm_od_cnt';
  const T_KEY = 'vm_od_min';
  const today = new Date().toDateString();

  if (localStorage.getItem(D_KEY) !== today) {
    localStorage.setItem(D_KEY, today);
    localStorage.setItem(C_KEY, String(4 + Math.floor(Math.random() * 6)));
    localStorage.setItem(T_KEY, String(8 + Math.floor(Math.random() * 22)));
  }

  let count  = Number(localStorage.getItem(C_KEY)) || 6;
  let lastMin = Number(localStorage.getItem(T_KEY)) || 12;

  function render() {
    todayEl.textContent = count;
    if (lastTimeEl) lastTimeEl.textContent = `${lastMin} хв тому`;
  }
  render();

  // Increment minutes every real minute
  setInterval(() => {
    lastMin = Math.min(lastMin + 1, 90);
    localStorage.setItem(T_KEY, String(lastMin));
    if (lastTimeEl) lastTimeEl.textContent = `${lastMin} хв тому`;
  }, 60000);

  // New order every 5–12 minutes
  function scheduleOrder() {
    const delay = (5 + Math.random() * 7) * 60 * 1000;
    setTimeout(() => {
      count++;
      lastMin = 1 + Math.floor(Math.random() * 4);
      localStorage.setItem(C_KEY, String(count));
      localStorage.setItem(T_KEY, String(lastMin));
      render();
      scheduleOrder();
    }, delay);
  }
  scheduleOrder();
})();

/* ══════════════════════════════════════════════════════════════
   SOCIAL POPUP — compact, slide-in from left, non-intrusive
   Uses 10 varied notifications with realistic names/messages
══════════════════════════════════════════════════════════════ */
(function () {
  const popup    = document.getElementById('socPopup');
  const nameEl   = document.getElementById('socPopupName');
  const msgEl    = document.getElementById('socPopupMsg');
  const closeBtn = document.getElementById('socPopupClose');
  if (!popup) return;

  const events = [
    { name: 'Марія, Київ',      msg: 'щойно замовила кросівки 💜' },
    { name: 'Оля, Харків',      msg: 'оформила замовлення (38р.) 💜' },
    { name: 'Катя, Одеса',      msg: 'щойно забрала акційну ціну 💜' },
    { name: 'Наталя, Дніпро',   msg: 'замовила — останні пари! 💜' },
    { name: 'Таня, Львів',      msg: 'щойно замовила кросівки 💜' },
    { name: 'Віка, Запоріжжя',  msg: 'оформила замовлення (37р.) 💜' },
    { name: 'Аліна, Полтава',   msg: 'щойно забрала за 895 грн 💜' },
    { name: 'Дарина, Вінниця',  msg: 'замовила для подарунку 💜' },
    { name: 'Крістіна, Суми',   msg: 'щойно замовила кросівки 💜' },
    { name: 'Юля, Луцьк',       msg: 'оформила замовлення 💜' },
  ];

  // Shuffle to avoid same order every reload
  events.sort(() => Math.random() - 0.5);
  let idx = 0;
  let hideTimer = null;

  function showPopup() {
    const ev = events[idx % events.length];
    idx++;
    nameEl.textContent = ev.name;
    msgEl.textContent  = ev.msg;
    popup.classList.add('visible');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePopup, 4500);
  }

  function hidePopup() {
    popup.classList.remove('visible');
  }

  closeBtn.addEventListener('click', () => {
    clearTimeout(hideTimer);
    hidePopup();
  });

  // First popup 10–15s after load, then every 25–40s
  const firstDelay = 10000 + Math.random() * 5000;
  setTimeout(() => {
    showPopup();
    setInterval(showPopup, 25000 + Math.random() * 15000);
  }, firstDelay);
})();

/* ── Phone mask ─────────────────────────────────────────────── */
const phoneInput = document.getElementById('phone');
if (phoneInput) {
  phoneInput.addEventListener('input', e => {
    let x = e.target.value.replace(/\D/g, '').slice(0, 12);
    if (x.startsWith('380')) x = x.slice(2);
    else if (x.startsWith('38')) x = x.slice(2);
    let f = '+38 ';
    if (x.length > 0) f += '(' + x.slice(0, 3);
    if (x.length >= 3) f += ') ' + x.slice(3, 6);
    if (x.length >= 6) f += '-' + x.slice(6, 8);
    if (x.length >= 8) f += '-' + x.slice(8, 10);
    e.target.value = f;
  });
}

/* ══════════════════════════════════════════════════════════════
   ORDER SUCCESS OVERLAY
══════════════════════════════════════════════════════════════ */
const orderOverlay    = document.getElementById('orderOverlay');
const successDetails  = document.getElementById('successDetails');
const successCloseBtn = document.getElementById('successCloseBtn');

function showSuccessOverlay(name, size) {
  successDetails.innerHTML =
    `👤 <b>${esc(name)}</b><br />👟 Розмір: <b>${esc(size)}</b><br />🚚 Доставка: Нова Пошта`;
  orderOverlay.classList.add('visible');

  ['.success-ring', '.check-path'].forEach(sel => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  });

  setTimeout(closeSuccessOverlay, 8000);
}

function closeSuccessOverlay() {
  orderOverlay.classList.remove('visible');
}

successCloseBtn.addEventListener('click', closeSuccessOverlay);
orderOverlay.addEventListener('click', e => {
  if (e.target === orderOverlay) closeSuccessOverlay();
});

/* ══════════════════════════════════════════════════════════════
   ORDER FORM
══════════════════════════════════════════════════════════════ */
let orderSubmitting = false;

document.getElementById('orderForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (orderSubmitting) return;

  const msgEl = document.getElementById('formMessage');
  const btn   = e.target.querySelector('.form-btn');
  const name  = document.getElementById('name').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const size  = selectedSizeInput.value.trim();
  const viaTg = document.getElementById('contactViaTelegram').checked;

  if (!name)  return showMsg(msgEl, "Вкажіть, будь ласка, Ваше ім'я.", 'error');
  if (!phone) return showMsg(msgEl, 'Вкажіть, будь ласка, номер телефону.', 'error');
  if (phone.replace(/\D/g, '').length < 10) return showMsg(msgEl, 'Номер телефону виглядає неповним.', 'error');
  if (!size)  return showMsg(msgEl, 'Оберіть розмір взуття.', 'error');

  fbTrack('InitiateCheckout', { content_name: 'Violet Motion Sneakers', content_ids: ['violet-motion-001'], value: 895, currency: 'UAH', num_items: 1 });
  Analytics.track('form_submit', { size, viaTelegram: viaTg });

  orderSubmitting = true;
  const origText = btn.textContent;
  btn.textContent = 'Надсилаємо…';
  btn.disabled = true;
  showMsg(msgEl, '', '');

  const result = await postJSON('/api/order', { name, phone, size, contactViaTelegram: viaTg });

  orderSubmitting = false;
  btn.textContent = origText;
  btn.disabled = false;

  if (!result || !result.success) {
    const msg = result?.timeout
      ? 'Сервер не відповідає. Спробуйте ще раз або напишіть нам у підтримку.'
      : 'Не вдалося надіслати замовлення. Спробуйте ще раз.';
    return showMsg(msgEl, msg, 'error');
  }

  fbTrack('Lead', { content_name: 'Violet Motion Order', value: 895, currency: 'UAH' });
  Analytics.track('order_success', { size });

  e.target.reset();
  selectedSizeInput.value = '';
  sizeBtns.forEach(b => b.classList.remove('active'));
  document.getElementById('contactViaTelegram').checked = false;
  showSuccessOverlay(name, size);
});

/* ══════════════════════════════════════════════════════════════
   REVIEWS — 15 realistic, varied language, no photos
   Mix: perfect Ukrainian · casual · Russian · typos · short/long
══════════════════════════════════════════════════════════════ */
const STATIC_REVIEWS = [
  {
    id: 1, name: 'Марина К., Київ', rating: 5,
    text: 'Дуже легкі та акуратні. На нозі виглядають ніжно, колір у житті ще кращий. Брала 38-й, сів ідеально.',
    date: '2026-04-20', deletable: false,
  },
  {
    id: 2, name: 'olia_99, Харків', rating: 5,
    text: 'взяла 38й. сидять як рідні навіть без примірки в магазі)) колір вогонь, ніжний такий. вже тиждень ношу щодня',
    date: '2026-04-19', deletable: false,
  },
  {
    id: 3, name: 'Sveta, Одеса', rating: 4,
    text: 'Хорошие кроссовки, удобные. Немного переживала за качество с незнакомого сайта, но всё нормально. Цвет красивый, мягкие.',
    date: '2026-04-18', deletable: false,
  },
  {
    id: 4, name: 'Ірина, Дніпро', rating: 5,
    text: "Сподобалось що можна оплатити після примірки. Взяла маміна подарунок — вона в захваті. Доставка 4 дні, все чітко.",
    date: '2026-04-17', deletable: false,
  },
  {
    id: 5, name: 'Наталя, Львів', rating: 5,
    text: 'замовила 2 тижні тому. ношу кожен день. підошва мяка нога не втомлюється. рекомендую)',
    date: '2026-04-16', deletable: false,
  },
  {
    id: 6, name: 'Вікторія, Суми', rating: 4,
    text: 'Якість хороша для такої ціни. Трохи довго йшла посилка (6 днів) але загалом задоволена. Розмір відповідає.',
    date: '2026-04-15', deletable: false,
  },
  {
    id: 7, name: 'Анна Б., Запоріжжя', rating: 5,
    text: 'красивееееее) ношу третій тиждень, поки все ок! матеріал не розповзається, не брудниться швидко',
    date: '2026-04-14', deletable: false,
  },
  {
    id: 8, name: 'Катерина, Полтава', rating: 5,
    text: 'Очень удобные! Брала размер 37, сидит хорошо. Фиолетовый акцент очень нежный, под белые джинсы вообще огонь.',
    date: '2026-04-13', deletable: false,
  },
  {
    id: 9, name: 'Dasha M., Луцьк', rating: 5,
    text: 'best кросівки за ці гроші чесно. матеріал приємний, не парить нога навіть влітку. брала 39й на широку ногу — ок',
    date: '2026-04-12', deletable: false,
  },
  {
    id: 10, name: 'Людмила, Тернопіль', rating: 5,
    text: 'Замовила онуці на день народження. Говорить що зручні і красиві 😊 Оплата після примірки — дуже зручно для нас.',
    date: '2026-04-11', deletable: false,
  },
  {
    id: 11, name: 'kristina_ok, Херсон', rating: 3,
    text: 'норм. очікувала трохи краще але для щоденного носіння згодяться. розмір підійшов',
    date: '2026-04-10', deletable: false,
  },
  {
    id: 12, name: 'Оксана В., Чернівці', rating: 5,
    text: 'Чудові кросівки! Дихаюча сітка дійсно відчувається — нога не пріє. Беру вже другу пару, попередні затерла :)',
    date: '2026-04-09', deletable: false,
  },
  {
    id: 13, name: 'Марічка, Івано-Франківськ', rating: 5,
    text: 'Прийшли швидко. Розмір відповідає таблиці. Колір як на фото — приємний пастельний, не кричущий.',
    date: '2026-04-08', deletable: false,
  },
  {
    id: 14, name: 'Таня, Чернігів', rating: 5,
    text: 'взяла 39й на широку ногу. не тисне!! нарешті знайшла зручні. ходжу цілий день без болю',
    date: '2026-04-07', deletable: false,
  },
  {
    id: 15, name: 'Аліна, Кропивницький', rating: 4,
    text: 'стильні та легкі. якби ще більше кольорів додали то взагалі ідеал. за якістю — все добре.',
    date: '2026-04-06', deletable: false,
  },
];

let allReviews   = [...STATIC_REVIEWS];
let nextReviewId = 300;
let currentPage  = 1;
let currentSort  = 'newest';
const PER_PAGE   = 5;

(async function loadReviews() {
  const data = await getJSON('/api/reviews');
  if (Array.isArray(data) && data.length > 0) {
    const serverReviews = data.map(r => ({ ...r, deletable: false }));
    const serverIds     = new Set(serverReviews.map(r => r.id));
    allReviews = [
      ...serverReviews,
      ...STATIC_REVIEWS.filter(r => !serverIds.has(r.id)),
    ];
    nextReviewId = Math.max(...allReviews.map(r => r.id || 0)) + 1;
  }
  renderReviews();
})();

function sorted() {
  const c = [...allReviews];
  switch (currentSort) {
    case 'newest':      return c.sort((a, b) => new Date(b.date) - new Date(a.date));
    case 'oldest':      return c.sort((a, b) => new Date(a.date) - new Date(b.date));
    case 'rating-high': return c.sort((a, b) => b.rating - a.rating);
    case 'rating-low':  return c.sort((a, b) => a.rating - b.rating);
    default: return c;
  }
}

function renderReviews() {
  const list  = document.getElementById('reviewsList');
  const pag   = document.getElementById('reviewsPagination');
  const label = document.getElementById('reviewsCountLabel');
  const s     = sorted();
  const total = Math.ceil(s.length / PER_PAGE) || 1;
  if (currentPage > total) currentPage = total;
  const items = s.slice((currentPage - 1) * PER_PAGE, currentPage * PER_PAGE);
  const w = s.length === 1 ? 'відгук' : s.length < 5 ? 'відгуки' : 'відгуків';
  label.textContent = `Всього: ${s.length} ${w}`;
  list.innerHTML = '';

  if (!items.length) {
    list.innerHTML = '<p style="color:var(--muted);text-align:center;padding:20px 0">Ще немає відгуків. Будьте першою! 💜</p>';
  }

  items.forEach(r => {
    let dateStr = '';
    try { dateStr = new Date(r.date).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', year: 'numeric' }); } catch {}

    const card = document.createElement('article');
    card.className = 'review-card';
    card.dataset.id = r.id;
    card.innerHTML = `
      <div class="review-top">
        <div>
          <strong>${esc(r.name)}</strong>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">${esc(dateStr)}</div>
        </div>
        <div class="review-top-right">
          <span class="stars-display">${stars(r.rating)}</span>
          ${r.deletable ? `<button type="button" class="review-delete-btn" title="Видалити">✕</button>` : ''}
        </div>
      </div>
      <p>${esc(r.text)}</p>
    `;

    if (r.deletable) {
      card.querySelector('.review-delete-btn').addEventListener('click', () => {
        card.classList.add('review-card--removing');
        setTimeout(() => { allReviews = allReviews.filter(x => x.id !== r.id); renderReviews(); }, 320);
      });
    }
    list.appendChild(card);
  });

  pag.innerHTML = '';
  if (total <= 1) return;
  pag.appendChild(mkBtn('←', 'page-btn page-btn--nav', currentPage === 1, () => { currentPage--; renderReviews(); }));
  for (let i = 1; i <= total; i++) {
    pag.appendChild(mkBtn(i, `page-btn${i === currentPage ? ' active' : ''}`, false, () => { currentPage = i; renderReviews(); }));
  }
  pag.appendChild(mkBtn('→', 'page-btn page-btn--nav', currentPage === total, () => { currentPage++; renderReviews(); }));
}

function mkBtn(label, cls, disabled, onClick) {
  const b = document.createElement('button');
  b.className = cls; b.textContent = label; b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

document.getElementById('reviewsSortSelect').addEventListener('change', e => {
  currentSort = e.target.value; currentPage = 1; renderReviews();
});

const starBtns    = document.querySelectorAll('.star-btn');
const ratingInput = document.getElementById('reviewRating');
function syncStars() {
  const v = Number(ratingInput.value);
  starBtns.forEach(s => s.classList.toggle('selected', Number(s.dataset.value) <= v));
}
starBtns.forEach(b => {
  b.addEventListener('mouseenter', () => starBtns.forEach(s => s.classList.toggle('hovered', Number(s.dataset.value) <= Number(b.dataset.value))));
  b.addEventListener('mouseleave', () => { starBtns.forEach(s => s.classList.remove('hovered')); syncStars(); });
  b.addEventListener('click', () => { ratingInput.value = b.dataset.value; syncStars(); });
});

let reviewSubmitting = false;
document.getElementById('reviewForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (reviewSubmitting) return;
  const msgEl  = document.getElementById('reviewMessage');
  const name   = document.getElementById('reviewName').value.trim();
  const rating = ratingInput.value;
  const text   = document.getElementById('reviewText').value.trim();
  if (!name)           return showMsg(msgEl, "Вкажіть Ваше ім'я.", 'error');
  if (!rating)         return showMsg(msgEl, 'Будь ласка, поставте оцінку.', 'error');
  if (!text)           return showMsg(msgEl, 'Напишіть текст відгуку.', 'error');
  if (text.length < 5) return showMsg(msgEl, 'Відгук занадто короткий.', 'error');
  reviewSubmitting = true;
  const r = { id: nextReviewId++, name, rating: Number(rating), text, date: new Date().toISOString().slice(0, 10), deletable: true };
  allReviews.unshift(r); currentPage = 1; renderReviews();
  postJSON('/api/review', r);
  showMsg(msgEl, 'Дякуємо! Ваш відгук додано 💜', 'success');
  e.target.reset(); ratingInput.value = '';
  starBtns.forEach(s => s.classList.remove('selected', 'hovered'));
  reviewSubmitting = false;
});

/* ══════════════════════════════════════════════════════════════
   SUPPORT CHAT — two-way SSE with pending message queue
   Bug fix: messages queued on server if SSE disconnects,
   flushed on reconnect. Client never loses operator replies.
══════════════════════════════════════════════════════════════ */
const supportFab    = document.getElementById('supportFab');
const supportPanel  = document.getElementById('supportPanel');
const supportClose  = document.getElementById('supportClose');
const supportInput  = document.getElementById('supportInput');
const supportSend   = document.getElementById('supportSend');
const supportMsgs   = document.getElementById('supportMessages');
const supportStatus = document.getElementById('supportStatus');

function getSessionId() {
  let id = sessionStorage.getItem('vm_sess');
  if (!id) {
    id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
    sessionStorage.setItem('vm_sess', id);
  }
  return id;
}
function createNewSessionId() {
  const id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
  sessionStorage.setItem('vm_sess', id);
  return id;
}

let SESSION_ID        = getSessionId();
let dialogEnded       = false;
let firstMsg          = true;
let operatorConnected = false;
let supportES         = null;
let reconnectTimer    = null;
let serverReachable   = true;

const FALLBACK_REPLIES = [
  'Дякуємо за звернення! Оператор зв\'яжеться з вами найближчим часом 💜',
  'Зрозуміло! Менеджер відповість щойно буде онлайн.',
  'Отримали ваше повідомлення. Очікуйте — скоро відповімо.',
  'Передамо вашому менеджеру. Зазвичай відповідаємо протягом кількох хвилин 💜',
];
let fallbackIdx = 0;

function cleanupSSE() {
  if (supportES) { try { supportES.close(); } catch {} supportES = null; }
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function connectSSE() {
  if (!window.EventSource || !serverReachable) return;
  cleanupSSE();

  const url = `${API}/api/support/stream?sessionId=${encodeURIComponent(SESSION_ID)}`;
  supportES = new EventSource(url);

  supportES.onopen = () => {
    // Connection established — server will flush any pending messages
  };

  supportES.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      switch (d.type) {
        case 'message':
          addChatMsg(d.text, false);
          break;
        case 'accepted':
          operatorConnected = true;
          supportStatus.textContent = '● Оператор підключився';
          addSystemMsg('💜 Оператор підключився і вже тут');
          break;
        case 'end':
          handleDialogEnd();
          break;
        case 'ping':
          break; // keepalive, ignore
      }
    } catch {}
  };

  supportES.onerror = () => {
    cleanupSSE();
    if (!dialogEnded) {
      reconnectTimer = setTimeout(connectSSE, 3500);
    }
  };
}

connectSSE();

/* Chat panel toggle */
supportFab.addEventListener('click', () => {
  const open = !supportPanel.classList.contains('support-panel--open');
  supportPanel.classList.toggle('support-panel--open', open);
  supportFab.classList.toggle('support-fab--active', open);
  if (open) { setTimeout(() => supportInput.focus(), 280); Analytics.track('support_open'); }
});
supportClose.addEventListener('click', () => {
  supportPanel.classList.remove('support-panel--open');
  supportFab.classList.remove('support-fab--active');
});

function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function addChatMsg(text, isUser) {
  const div = document.createElement('div');
  div.className = `support-msg ${isUser ? 'support-msg--user' : 'support-msg--bot'}`;
  div.innerHTML = `<div class="support-bubble">${esc(text)}</div><div class="support-time">${nowTime()}</div>`;
  supportMsgs.appendChild(div);
  supportMsgs.scrollTop = supportMsgs.scrollHeight;
}
function addSystemMsg(text) {
  const div = document.createElement('div');
  div.className = 'support-msg support-msg--system';
  div.innerHTML = `<div class="support-bubble">${esc(text)}</div>`;
  supportMsgs.appendChild(div);
  supportMsgs.scrollTop = supportMsgs.scrollHeight;
}
function showTyping() {
  if (document.getElementById('typingIndicator')) return;
  const div = document.createElement('div');
  div.className = 'support-msg support-msg--bot support-typing';
  div.id = 'typingIndicator';
  div.innerHTML = `<div class="support-bubble"><span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span></div>`;
  supportMsgs.appendChild(div);
  supportMsgs.scrollTop = supportMsgs.scrollHeight;
}
function hideTyping() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function handleDialogEnd() {
  if (dialogEnded) return;
  dialogEnded = true; operatorConnected = false;
  supportStatus.textContent = '● Чат завершено';
  addSystemMsg('Оператор завершив чат. Дякуємо за звернення!');

  const ratingBlock = document.createElement('div');
  ratingBlock.className = 'support-rating-block';
  ratingBlock.innerHTML = `<p>Оцініть якість підтримки:</p><div class="support-rating-stars">${[1,2,3,4,5].map(i=>`<button class="support-rate-star" data-v="${i}">★</button>`).join('')}</div>`;
  ratingBlock.querySelectorAll('.support-rate-star').forEach(btn => {
    btn.addEventListener('mouseenter', () => ratingBlock.querySelectorAll('.support-rate-star').forEach(s => s.classList.toggle('lit', Number(s.dataset.v) <= Number(btn.dataset.v))));
    btn.addEventListener('mouseleave', () => ratingBlock.querySelectorAll('.support-rate-star').forEach(s => s.classList.remove('lit')));
    btn.addEventListener('click', () => { ratingBlock.innerHTML = '<p class="support-rated-msg">Дякуємо за оцінку! 💜</p>'; });
  });
  supportMsgs.appendChild(ratingBlock);
  supportMsgs.scrollTop = supportMsgs.scrollHeight;
  supportInput.placeholder = 'Напишіть нове повідомлення, щоб почати новий чат…';
  cleanupSSE();
}

let sendingSupport = false;
async function sendSupportMsg() {
  const text = supportInput.value.trim();
  if (!text || sendingSupport) return;

  if (dialogEnded) {
    SESSION_ID = createNewSessionId();
    dialogEnded = false; firstMsg = true; operatorConnected = false;
    supportStatus.textContent = '● Очікуємо оператора';
    supportInput.placeholder = 'Напишіть ваше повідомлення…';
    connectSSE();
  }

  sendingSupport = true;
  addChatMsg(text, true);
  supportInput.value = '';

  const result = await postJSON('/api/support', {
    message: text, sessionId: SESSION_ID, timestamp: new Date().toISOString(),
  });

  sendingSupport = false;

  if (!result || !result.success) {
    serverReachable = false;
    // Fallback — show auto-reply so chat doesn't feel broken
    if (firstMsg) {
      firstMsg = false;
      showTyping();
      setTimeout(() => {
        hideTyping();
        addChatMsg(FALLBACK_REPLIES[fallbackIdx++ % FALLBACK_REPLIES.length], false);
      }, 1200 + Math.random() * 600);
    }
    return;
  }

  serverReachable = true;
  // If first message and operator hasn't connected yet, show acknowledgement after delay
  if (firstMsg && !operatorConnected) {
    firstMsg = false;
    showTyping();
    setTimeout(() => {
      hideTyping();
      if (!dialogEnded && !operatorConnected) {
        addChatMsg(FALLBACK_REPLIES[fallbackIdx++ % FALLBACK_REPLIES.length], false);
      }
    }, 1000 + Math.random() * 500);
  }
}

supportSend.addEventListener('click', sendSupportMsg);
supportInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendSupportMsg(); }
});

/* ══════════════════════════════════════════════════════════════
   SMART FLOATING BUTTON
   Observes ALL main CTAs — appears only when none is visible
══════════════════════════════════════════════════════════════ */
(function () {
  const floatBtn = document.getElementById('floatOrderBtn');
  if (!floatBtn) return;

  const visibleSet = new Set();

  // All elements whose visibility controls the float button
  const targets = [
    '#heroOrderBtn',
    '.visual-block .main-btn',
    '.sale-cta',
    '#orderForm .form-btn',
  ];

  const observer = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) visibleSet.add(e.target);
      else visibleSet.delete(e.target);
    });
    const shouldShow = visibleSet.size === 0;
    floatBtn.classList.toggle('visible', shouldShow);
  }, { threshold: 0.4 });

  targets.forEach(sel => {
    document.querySelectorAll(sel).forEach(el => observer.observe(el));
  });
})();

/* ══════════════════════════════════════════════════════════════
   SKELETON LOADING — video + gallery main image
══════════════════════════════════════════════════════════════ */
(function () {
  const videoCard   = document.getElementById('heroVideoCard');
  const video       = document.getElementById('heroVideo');
  const fallbackImg = document.getElementById('heroFallback');
  const videoSkel   = document.getElementById('videoSkeleton');

  function markVideoLoaded() {
    if (videoCard) videoCard.classList.add('sk-loaded');
  }

  if (video) {
    if (video.readyState >= 3) {
      markVideoLoaded();
    } else {
      video.addEventListener('loadeddata', markVideoLoaded, { once: true });
      video.addEventListener('error', () => {
        // Video failed — rely on fallback image
        if (fallbackImg) {
          if (fallbackImg.complete && fallbackImg.naturalWidth > 0) {
            markVideoLoaded();
          } else {
            fallbackImg.addEventListener('load', markVideoLoaded, { once: true });
            fallbackImg.addEventListener('error', markVideoLoaded, { once: true });
          }
        } else {
          setTimeout(markVideoLoaded, 2000);
        }
      }, { once: true });
    }
  } else {
    setTimeout(markVideoLoaded, 1500);
  }

  // Gallery main image skeleton
  const galleryMain = document.querySelector('.gallery-main');
  const galleryImg  = document.getElementById('mainGalleryImage');

  if (galleryMain && galleryImg) {
    if (galleryImg.complete && galleryImg.naturalWidth > 0) {
      galleryMain.classList.add('sk-loaded');
    } else {
      galleryImg.addEventListener('load', () => galleryMain.classList.add('sk-loaded'), { once: true });
      galleryImg.addEventListener('error', () => galleryMain.classList.add('sk-loaded'), { once: true });
    }
  }

  // Safety fallback — remove all skeletons after 4s no matter what
  setTimeout(() => {
    document.querySelectorAll('.sk-wrap').forEach(w => w.classList.add('sk-loaded'));
  }, 4000);
})();

/* ══════════════════════════════════════════════════════════════
   SCROLL ANIMATIONS — fade-in-up on IntersectionObserver
   Lightweight, CSS-transition based, no heavy lib needed
══════════════════════════════════════════════════════════════ */
(function () {
  const els = document.querySelectorAll('.fade-in-up');
  if (!els.length) return;

  const observer = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add('fiu-visible');
        observer.unobserve(e.target); // animate once only
      }
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  els.forEach(el => observer.observe(el));
})();