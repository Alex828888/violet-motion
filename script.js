/* ═══════════════════════════════════════════════════════════
   VIOLET MOTION — CLIENT SCRIPT
   Повна версія з конверсійними покращеннями:
   - Синхронізований лічильник залишку (тікер = секція продажу)
   - Live-viewers на відео
   - Hero inline timer (синхрон із основним)
   - Соціальний попап "Хтось щойно замовив"
   - Лічильник сьогоднішніх замовлень над формою
   - Graceful degradation чату (автовідповідь якщо сервер недоступний)
   - 15 відгуків без фото
═══════════════════════════════════════════════════════════ */

const API = '';

/* ── Facebook Pixel helper ──────────────────────────────────── */
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

/* fetch з таймаутом */
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

/* ── Gallery ────────────────────────────────────────────────── */
document.querySelectorAll('.thumb').forEach(t => {
  t.addEventListener('click', () => {
    document.getElementById('mainGalleryImage').src = t.dataset.image;
    document.querySelectorAll('.thumb').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
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
  });
});

/* ══════════════════════════════════════════════════════════════
   COUNTDOWN TIMER
   Зберігається між оновленнями в localStorage.
   Синхронізує: основний таймер + hero inline таймер.
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

    if (h) h.textContent = hh;
    if (m) m.textContent = mm;
    if (s) s.textContent = ss;
    if (hi) hi.textContent = `${hh}:${mm}:${ss}`;
  }

  tick();
  setInterval(tick, 1000);
})();

/* ══════════════════════════════════════════════════════════════
   STOCK SIMULATION
   Зменшується повільно. Синхронізує тікер і секцію продажу.
══════════════════════════════════════════════════════════════ */
(function () {
  const stockEl    = document.getElementById('stockCount');
  const tickerEl   = document.getElementById('tickerStock');
  const mirrors    = document.querySelectorAll('.ticker-stock-mirror');

  let n = 17;

  function setStock(val) {
    if (stockEl)  stockEl.textContent  = val;
    if (tickerEl) tickerEl.textContent = val;
    mirrors.forEach(el => { el.textContent = val; });
  }

  setInterval(() => {
    if (n > 8 && Math.random() > 0.65) {
      n--;
      setStock(n);
    }
  }, 18000);
})();

/* ══════════════════════════════════════════════════════════════
   LIVE VIEWERS — анімований лічильник "переглядають зараз"
══════════════════════════════════════════════════════════════ */
(function () {
  const el = document.getElementById('heroViewers');
  if (!el) return;

  let v = 18 + Math.floor(Math.random() * 12); // 18–30 при завантаженні
  el.textContent = v;

  setInterval(() => {
    const delta = Math.random() > 0.5 ? 1 : -1;
    v = Math.max(12, Math.min(38, v + delta));
    el.textContent = v;
  }, 7000 + Math.random() * 5000);
})();

/* ══════════════════════════════════════════════════════════════
   TODAY ORDERS COUNTER — "Сьогодні вже N замовлень"
   Стартує з 5–9 і повільно росте протягом дня
══════════════════════════════════════════════════════════════ */
(function () {
  const todayEl    = document.getElementById('todayOrders');
  const lastTimeEl = document.getElementById('lastOrderTime');
  if (!todayEl) return;

  /* Прив'язуємо до дати — кожен день нові значення */
  const KEY   = 'vm_today_orders';
  const DKEY  = 'vm_today_date';
  const today = new Date().toDateString();

  if (localStorage.getItem(DKEY) !== today) {
    localStorage.setItem(DKEY, today);
    localStorage.setItem(KEY, String(5 + Math.floor(Math.random() * 5)));
  }

  let count = Number(localStorage.getItem(KEY)) || 6;
  todayEl.textContent = count;

  /* Оновлюємо "хвилин тому" */
  const lastMinuteKey = 'vm_last_order_min';
  let lastMin = Number(localStorage.getItem(lastMinuteKey)) || (8 + Math.floor(Math.random() * 20));

  function updateLastTime() {
    if (lastTimeEl) lastTimeEl.textContent = `${lastMin} хв тому`;
  }
  updateLastTime();

  /* Кожні 4–9 хв нові "замовлення" і час оновлюється */
  function scheduleNextOrder() {
    const delay = (4 + Math.random() * 5) * 60 * 1000;
    setTimeout(() => {
      count++;
      lastMin = 1 + Math.floor(Math.random() * 3);
      localStorage.setItem(KEY, String(count));
      localStorage.setItem(lastMinuteKey, String(lastMin));
      todayEl.textContent = count;
      updateLastTime();
      scheduleNextOrder();
    }, delay);
  }

  /* Час "тому" поступово зростає кожну хвилину */
  setInterval(() => {
    lastMin++;
    localStorage.setItem(lastMinuteKey, String(lastMin));
    updateLastTime();
  }, 60 * 1000);

  scheduleNextOrder();
})();

/* ══════════════════════════════════════════════════════════════
   SOCIAL POPUP — "Олена з Харкова щойно замовила"
══════════════════════════════════════════════════════════════ */
(function () {
  const popup    = document.getElementById('socPopup');
  const nameEl   = document.getElementById('socPopupName');
  const msgEl    = document.getElementById('socPopupMsg');
  const closeBtn = document.getElementById('socPopupClose');
  if (!popup) return;

  const events = [
    { name: 'Марія, Київ',     msg: 'щойно замовила кросівки 💜' },
    { name: 'Олена, Харків',   msg: 'оформила замовлення розмір 38 💜' },
    { name: 'Катерина, Одеса', msg: 'щойно замовила кросівки 💜' },
    { name: 'Наталія, Львів',  msg: 'оформила замовлення 💜' },
    { name: 'Тетяна, Дніпро',  msg: 'щойно купила останній розмір 37 💜' },
    { name: 'Вікторія, Луцьк', msg: 'щойно замовила кросівки 💜' },
    { name: 'Аліна, Суми',     msg: 'оформила замовлення розмір 39 💜' },
    { name: 'Дарина, Вінниця', msg: 'щойно замовила кросівки 💜' },
    { name: 'Юлія, Запоріжжя', msg: 'оформила замовлення 💜' },
    { name: 'Анна, Полтава',   msg: 'щойно замовила кросівки 💜' },
  ];

  let idx = Math.floor(Math.random() * events.length);
  let hideTimer = null;

  function showPopup() {
    const ev = events[idx % events.length];
    idx++;
    nameEl.textContent = ev.name;
    msgEl.textContent  = ev.msg;
    popup.classList.add('visible');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hidePopup, 5000);
  }

  function hidePopup() {
    popup.classList.remove('visible');
  }

  closeBtn.addEventListener('click', () => {
    clearTimeout(hideTimer);
    hidePopup();
  });

  /* Перший показ через 8 сек, потім кожні 22–38 сек */
  setTimeout(() => {
    showPopup();
    setInterval(showPopup, 22000 + Math.random() * 16000);
  }, 8000);
})();

/* ── Phone mask ─────────────────────────────────────────────── */
document.getElementById('phone').addEventListener('input', e => {
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

/* ══════════════════════════════════════════════════════════════
   ORDER SUCCESS OVERLAY
══════════════════════════════════════════════════════════════ */
const orderOverlay    = document.getElementById('orderOverlay');
const successDetails  = document.getElementById('successDetails');
const successCloseBtn = document.getElementById('successCloseBtn');

function showSuccessOverlay(name, size) {
  successDetails.innerHTML = `
    👤 <b>${esc(name)}</b><br />
    👟 Розмір: <b>${esc(size)}</b><br />
    🚚 Доставка: Нова Пошта
  `;
  orderOverlay.classList.add('visible');

  ['.success-ring', '.check-path'].forEach(sel => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  });

  setTimeout(closeSuccessOverlay, 7000);
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

  if (!name)  return showMsg(msgEl, 'Вкажіть, будь ласка, Ваше ім\'я.', 'error');
  if (!phone) return showMsg(msgEl, 'Вкажіть, будь ласка, номер телефону.', 'error');
  if (phone.replace(/\D/g, '').length < 10) return showMsg(msgEl, 'Номер телефону виглядає неповним.', 'error');
  if (!size)  return showMsg(msgEl, 'Оберіть розмір взуття.', 'error');

  fbTrack('InitiateCheckout', {
    content_name: 'Violet Motion Sneakers',
    content_ids: ['violet-motion-001'],
    value: 895,
    currency: 'UAH',
    num_items: 1,
  });

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

  fbTrack('Lead', {
    content_name: 'Violet Motion Order',
    value: 895,
    currency: 'UAH',
  });

  e.target.reset();
  selectedSizeInput.value = '';
  sizeBtns.forEach(b => b.classList.remove('active'));
  document.getElementById('contactViaTelegram').checked = false;

  showSuccessOverlay(name, size);
});

/* ══════════════════════════════════════════════════════════════
   REVIEWS — 15 статичних відгуків БЕЗ ФОТО
   Розподіл: 13 × 5★, 2 × 4★ → виглядає природньо
══════════════════════════════════════════════════════════════ */
const STATIC_REVIEWS = [
  { id: 1,  name: 'Марина, Київ',      rating: 5, text: 'Дуже легкі та акуратні. На нозі виглядають ніжно, колір у житті ще кращий. Брала 38-й, сів ідеально.', date: '2026-04-20', deletable: false },
  { id: 2,  name: 'Олена, Львів',      rating: 5, text: 'Брала на кожен день. Зручні, м\'які, не тиснуть. Під джогери й джинси — супер. Вже тиждень ношу.', date: '2026-04-19', deletable: false },
  { id: 3,  name: 'Ірина, Дніпро',     rating: 5, text: 'Сподобалось, що можна оплатити після примірки. Сайт зручний, замовлення швидке. Дуже задоволена!', date: '2026-04-18', deletable: false },
  { id: 4,  name: 'Тетяна, Харків',    rating: 5, text: 'Замовляла скептично, але виявилось дуже якісно. Підошва м\'яка, нога не втомлюється. Дочка вже теж хоче 😄', date: '2026-04-17', deletable: false },
  { id: 5,  name: 'Юлія, Одеса',       rating: 4, text: 'Гарні кросівки, зручні. Єдине — доставка була 5 днів, але оплата після примірки — це великий плюс. Розмір відповідає.', date: '2026-04-16', deletable: false },
  { id: 6,  name: 'Катерина, Запоріжжя', rating: 5, text: 'Купила тиждень тому. Ходжу в них щодня, повністю задоволена. Виглядають дорожче ніж коштують!', date: '2026-04-15', deletable: false },
  { id: 7,  name: 'Вікторія, Суми',    rating: 5, text: 'Ніжний фіолетовий відтінок — як на фото. Легенькі, не тиснуть, ніжка відчуває себе вільно. Рекомендую.', date: '2026-04-14', deletable: false },
  { id: 8,  name: 'Наталія, Полтава',  rating: 5, text: 'Взяла 37-й. Сидять як влита. Ходила весь день — нога зовсім не втомилась. Приємна якість для такої ціни.', date: '2026-04-13', deletable: false },
  { id: 9,  name: 'Аліна, Луцьк',      rating: 5, text: 'Спершу сумнівалась — оплата після примірки все вирішила. Кросівки прийшли швидко, якість хороша. Беру ще одну пару в подарунок.', date: '2026-04-12', deletable: false },
  { id: 10, name: 'Дарина, Вінниця',   rating: 5, text: 'Дуже стильні! Колір ніжний і приємний. Одразу підходять і під плаття, і під джинси. Матеріал приємний до дотику.', date: '2026-04-11', deletable: false },
  { id: 11, name: 'Анна, Чернігів',    rating: 5, text: 'Замовила маміа-подарунок — вона в захваті. Каже, зручні та легкі. Доставка Новою Поштою, все чітко.', date: '2026-04-10', deletable: false },
  { id: 12, name: 'Христина, Івано-Франківськ', rating: 4, text: 'Загалом задоволена, кросівки справді легкі. Мінус один — хотілося б більше кольорів. Але за якістю — клас.', date: '2026-04-09', deletable: false },
  { id: 13, name: 'Оксана, Херсон',    rating: 5, text: 'Нарешті знайшла зручні й симпатичні одночасно. Берете без роздумів — не пожалкуєте. Ношу вже 2 тижні, все добре.', date: '2026-04-08', deletable: false },
  { id: 14, name: 'Людмила, Житомир',  rating: 5, text: 'Дуже задоволена покупкою. Примірила одразу на пошті — розмір точний, матеріал приємний. Оплатила без питань.', date: '2026-04-07', deletable: false },
  { id: 15, name: 'Соломія, Тернопіль', rating: 5, text: 'Замовила вперше — все пройшло відмінно. Кросівки легкі, фіолетовий акцент дуже ніжний. Дуже задоволена покупкою!', date: '2026-04-06', deletable: false },
];

let allReviews   = [...STATIC_REVIEWS];
let nextReviewId = 200;
let currentPage  = 1;
let currentSort  = 'newest';
const PER_PAGE   = 5;

/* Завантаження відгуків з сервера */
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
    const card = document.createElement('article');
    card.className = 'review-card';
    card.dataset.id = r.id;

    /* Форматуємо дату у вигляді "20 квіт. 2026" */
    let dateStr = '';
    try {
      dateStr = new Date(r.date).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch { dateStr = r.date || ''; }

    card.innerHTML = `
      <div class="review-top">
        <div>
          <strong>${esc(r.name)}</strong>
          <div style="font-size:11px;color:var(--muted);margin-top:3px">${esc(dateStr)}</div>
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
        setTimeout(() => {
          allReviews = allReviews.filter(x => x.id !== r.id);
          renderReviews();
        }, 320);
      });
    }

    list.appendChild(card);
  });

  pag.innerHTML = '';
  if (total <= 1) return;

  pag.appendChild(mkBtn('←', 'page-btn page-btn--nav', currentPage === 1, () => { currentPage--; renderReviews(); }));

  for (let i = 1; i <= total; i++) {
    const active = i === currentPage;
    pag.appendChild(mkBtn(i, `page-btn${active ? ' active' : ''}`, false, () => { currentPage = i; renderReviews(); }));
  }

  pag.appendChild(mkBtn('→', 'page-btn page-btn--nav', currentPage === total, () => { currentPage++; renderReviews(); }));
}

function mkBtn(label, cls, disabled, onClick) {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener('click', onClick);
  return b;
}

document.getElementById('reviewsSortSelect').addEventListener('change', e => {
  currentSort = e.target.value;
  currentPage = 1;
  renderReviews();
});

/* Star rating */
const starBtns    = document.querySelectorAll('.star-btn');
const ratingInput = document.getElementById('reviewRating');

function syncStars() {
  const v = Number(ratingInput.value);
  starBtns.forEach(s => s.classList.toggle('selected', Number(s.dataset.value) <= v));
}

starBtns.forEach(b => {
  b.addEventListener('mouseenter', () => {
    starBtns.forEach(s => s.classList.toggle('hovered', Number(s.dataset.value) <= Number(b.dataset.value)));
  });
  b.addEventListener('mouseleave', () => {
    starBtns.forEach(s => s.classList.remove('hovered'));
    syncStars();
  });
  b.addEventListener('click', () => {
    ratingInput.value = b.dataset.value;
    syncStars();
  });
});

/* Review submit */
let reviewSubmitting = false;

document.getElementById('reviewForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (reviewSubmitting) return;

  const msgEl  = document.getElementById('reviewMessage');
  const name   = document.getElementById('reviewName').value.trim();
  const rating = ratingInput.value;
  const text   = document.getElementById('reviewText').value.trim();

  if (!name)           return showMsg(msgEl, 'Вкажіть Ваше ім\'я.', 'error');
  if (!rating)         return showMsg(msgEl, 'Будь ласка, поставте оцінку.', 'error');
  if (!text)           return showMsg(msgEl, 'Напишіть текст відгуку.', 'error');
  if (text.length < 5) return showMsg(msgEl, 'Відгук занадто короткий.', 'error');

  reviewSubmitting = true;

  const r = {
    id:       nextReviewId++,
    name,
    rating:   Number(rating),
    text,
    date:     new Date().toISOString().slice(0, 10),
    deletable: true,
  };

  allReviews.unshift(r);
  currentPage = 1;
  renderReviews();

  postJSON('/api/review', r);
  showMsg(msgEl, 'Дякуємо! Ваш відгук додано 💜', 'success');

  e.target.reset();
  ratingInput.value = '';
  starBtns.forEach(s => s.classList.remove('selected', 'hovered'));

  reviewSubmitting = false;
});

/* ══════════════════════════════════════════════════════════════
   SUPPORT CHAT
   Graceful degradation: якщо сервер недоступний →
   показуємо typing-індикатор і авто-відповідь через 1.5 сек.
   Якщо сервер доступний — SSE-потік від оператора.
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

let SESSION_ID = getSessionId();
let dialogEnded = false;
let firstMessage = true;
let supportES = null;
let supportReconnectTimer = null;
let operatorConnected = false;
let serverAvailable = true; /* Чи відповідав сервер хоча б раз */

/* Авто-відповіді коли сервер недоступний */
const AUTO_REPLIES = [
  'Дякуємо за звернення! Оператор отримає ваше повідомлення і зв\'яжеться з вами 💜',
  'Зрозуміло! Менеджер відповість найближчим часом.',
  'Передамо вашому запит команді.',
  'Очікуйте — ми отримали повідомлення і скоро відповімо.',
  'Дякуємо! Якщо питання термінове — зателефонуємо якнайшвидше 💜',
];
let autoIdx = 0;

function cleanupSSE() {
  if (supportES) {
    try { supportES.close(); } catch {}
    supportES = null;
  }
  if (supportReconnectTimer) {
    clearTimeout(supportReconnectTimer);
    supportReconnectTimer = null;
  }
}

function connectSSE() {
  if (!window.EventSource || !serverAvailable) return;
  cleanupSSE();

  supportES = new EventSource(`${API}/api/support/stream?sessionId=${SESSION_ID}`);

  supportES.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'message') {
        addChatMsg(d.text, false);
      } else if (d.type === 'accepted') {
        operatorConnected = true;
        supportStatus.textContent = '● Оператор підключився';
        addSystemMsg('💜 Оператор прийняв ваш запит і вже тут');
      } else if (d.type === 'end') {
        handleDialogEnd();
      }
    } catch {}
  };

  supportES.onerror = () => {
    cleanupSSE();
    if (!dialogEnded) {
      supportReconnectTimer = setTimeout(connectSSE, 3000);
    }
  };
}

connectSSE();

/* Toggle panel */
supportFab.addEventListener('click', () => {
  const open = !supportPanel.classList.contains('support-panel--open');
  supportPanel.classList.toggle('support-panel--open', open);
  supportFab.classList.toggle('support-fab--active', open);
  if (open) setTimeout(() => supportInput.focus(), 280);
});

supportClose.addEventListener('click', () => {
  supportPanel.classList.remove('support-panel--open');
  supportFab.classList.remove('support-fab--active');
});

function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

/* Typing indicator */
function showTyping() {
  const div = document.createElement('div');
  div.className = 'support-msg support-msg--bot support-typing';
  div.id = 'typingIndicator';
  div.innerHTML = `<div class="support-bubble">
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
    <span class="typing-dot"></span>
  </div>`;
  supportMsgs.appendChild(div);
  supportMsgs.scrollTop = supportMsgs.scrollHeight;
}

function hideTyping() {
  const el = document.getElementById('typingIndicator');
  if (el) el.remove();
}

function handleDialogEnd() {
  if (dialogEnded) return;
  dialogEnded = true;
  operatorConnected = false;
  supportStatus.textContent = '● Чат завершено';
  addSystemMsg('Оператор завершив чат. Дякуємо за звернення!');

  const ratingBlock = document.createElement('div');
  ratingBlock.className = 'support-rating-block';
  ratingBlock.innerHTML = `
    <p>Оцініть якість підтримки:</p>
    <div class="support-rating-stars">
      ${[1,2,3,4,5].map(i => `<button class="support-rate-star" data-v="${i}">★</button>`).join('')}
    </div>
  `;

  ratingBlock.querySelectorAll('.support-rate-star').forEach(btn => {
    btn.addEventListener('mouseenter', () => {
      ratingBlock.querySelectorAll('.support-rate-star').forEach(s => {
        s.classList.toggle('lit', Number(s.dataset.v) <= Number(btn.dataset.v));
      });
    });
    btn.addEventListener('mouseleave', () => {
      ratingBlock.querySelectorAll('.support-rate-star').forEach(s => s.classList.remove('lit'));
    });
    btn.addEventListener('click', () => {
      ratingBlock.innerHTML = '<p class="support-rated-msg">Дякуємо за оцінку! 💜</p>';
    });
  });

  supportMsgs.appendChild(ratingBlock);
  supportMsgs.scrollTop = supportMsgs.scrollHeight;

  supportInput.disabled = false;
  supportSend.disabled = false;
  supportInput.placeholder = 'Напишіть нове повідомлення, щоб почати новий чат…';
  cleanupSSE();
}

let sendingSupport = false;

async function sendSupportMsg() {
  const text = supportInput.value.trim();
  if (!text || sendingSupport) return;

  if (dialogEnded) {
    SESSION_ID = createNewSessionId();
    dialogEnded = false;
    firstMessage = true;
    operatorConnected = false;
    supportStatus.textContent = '● Очікуємо оператора';
    supportInput.placeholder = 'Напишіть ваше повідомлення…';
    connectSSE();
  }

  sendingSupport = true;
  addChatMsg(text, true);
  supportInput.value = '';

  const result = await postJSON('/api/support', {
    message: text,
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
  });

  sendingSupport = false;

  if (!result || !result.success) {
    /* Сервер недоступний — показуємо авто-відповідь */
    serverAvailable = false;
    if (firstMessage) {
      firstMessage = false;
      showTyping();
      setTimeout(() => {
        hideTyping();
        addChatMsg(AUTO_REPLIES[autoIdx++ % AUTO_REPLIES.length], false);
      }, 1200 + Math.random() * 800);
    }
    return;
  }

  /* Сервер відповів */
  serverAvailable = true;

  if (firstMessage && !operatorConnected) {
    firstMessage = false;
    showTyping();
    setTimeout(() => {
      if (!dialogEnded && !operatorConnected) {
        hideTyping();
        addChatMsg(AUTO_REPLIES[autoIdx++ % AUTO_REPLIES.length], false);
      }
    }, 1000 + Math.random() * 500);
  }
}

supportSend.addEventListener('click', sendSupportMsg);
supportInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendSupportMsg();
  }
});

/* ── Floating Order Button ───────────────────────────────────── */
(function () {
  const floatBtn = document.getElementById('floatOrderBtn');
  const heroBtn  = document.getElementById('heroOrderBtn');
  if (!floatBtn || !heroBtn) return;

  const observer = new IntersectionObserver(
    entries => {
      entries.forEach(entry => {
        floatBtn.classList.toggle('visible', !entry.isIntersecting);
      });
    },
    { threshold: 0, rootMargin: '0px 0px -20px 0px' }
  );

  observer.observe(heroBtn);
})();