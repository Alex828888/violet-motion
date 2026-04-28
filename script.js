/* ═══════════════════════════════════════════════════════════
   VIOLET MOTION — CLIENT SCRIPT
═══════════════════════════════════════════════════════════ */

const API = '';  // '' = same origin; 'http://localhost:3000' for dev without bundler

/* ── Utils ─────────────────────────────────────────────────── */
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n); }
function showMsg(el, text, type) { el.textContent = text; el.className = `form-message ${type}`; }

async function postJSON(path, data) {
  try {
    const r = await fetch(API + path, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(data)
    });
    return await r.json();
  } catch {
    return { success: false, offline: true };
  }
}

/* ── Gallery ────────────────────────────────────────────────── */
const docEl = document.documentElement;
const heroVideo = document.querySelector('.hero-video');
const connection = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches || false;
const coarsePointer = window.matchMedia?.('(max-width: 767px), (pointer: coarse)')?.matches || false;
const lowBandwidth = !!connection && (connection.saveData || /(?:slow-)?[23]g/.test(connection.effectiveType || ''));
const lowPowerDevice =
  (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4) ||
  (typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency <= 4);
const liteMotion = lowBandwidth || (coarsePointer && lowPowerDevice);

if (liteMotion) docEl.classList.add('lite-motion');

function setupHeroVideo() {
  if (!heroVideo) return;

  if (prefersReducedMotion || liteMotion) {
    heroVideo.pause();
    heroVideo.preload = 'none';
    return;
  }

  const setPlayback = visible => {
    if (document.hidden || !visible) {
      heroVideo.pause();
      return;
    }

    const playback = heroVideo.play();
    if (playback && typeof playback.catch === 'function') {
      playback.catch(() => heroVideo.pause());
    }
  };

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => setPlayback(entry.isIntersecting && entry.intersectionRatio >= 0.35));
    }, {
      threshold: [0.15, 0.35, 0.65]
    });

    observer.observe(heroVideo);
  } else {
    setPlayback(true);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      heroVideo.pause();
      return;
    }

    const rect = heroVideo.getBoundingClientRect();
    setPlayback(rect.top < window.innerHeight * 0.9 && rect.bottom > window.innerHeight * 0.15);
  });
}

function setupScrollReveal() {
  const targets = [];

  const register = (selector, step = 70, cycle = 4) => {
    document.querySelectorAll(selector).forEach((el, index) => {
      if (targets.includes(el)) return;
      el.classList.add('scroll-reveal');
      el.style.setProperty('--reveal-delay', `${(index % cycle) * step}ms`);
      targets.push(el);
    });
  };

  register('.hero-badge, .hero-title, .hero-text, .hero-price-box, .hero-actions, .hero-mini-stats', 90, 6);
  register('.section-head');
  register('.feature-card');
  register('.visual-text, .visual-image-wrap');
  register('.gallery-main, .thumb');
  register('.specs-card');
  register('.step-item');
  register('.sale-box');
  register('.order-card');
  register('.reviews-left, .review-form-card');

  if (!targets.length) return;

  if (prefersReducedMotion || !('IntersectionObserver' in window)) {
    targets.forEach(el => el.classList.add('reveal-in'));
    return;
  }

  const replay = el => {
    el.classList.remove('reveal-in');
    void el.offsetWidth;
    el.classList.add('reveal-in');
  };

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting && entry.intersectionRatio >= 0.18) {
        replay(entry.target);
      } else {
        entry.target.classList.remove('reveal-in');
      }
    });
  }, {
    threshold: [0.18, 0.35],
    rootMargin: '0px 0px -12% 0px'
  });

  targets.forEach(el => observer.observe(el));
}

setupHeroVideo();
setupScrollReveal();

document.querySelectorAll('.thumb').forEach(t => {
  t.addEventListener('click', () => {
    const mainGalleryImage =
      document.getElementById('mainGalleryImageOptimized') ||
      document.getElementById('mainGalleryImage');

    if (mainGalleryImage) mainGalleryImage.src = t.dataset.image;
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

/* ── Countdown ──────────────────────────────────────────────── */
(function() {
  let t = 24 * 3600 - 1;
  const h = document.getElementById('hours');
  const m = document.getElementById('minutes');
  const s = document.getElementById('seconds');

  setInterval(() => {
    h.textContent = String(Math.floor(t / 3600)).padStart(2,'0');
    m.textContent = String(Math.floor((t % 3600) / 60)).padStart(2,'0');
    s.textContent = String(t % 60).padStart(2,'0');
    t = t > 0 ? t - 1 : 24 * 3600 - 1;
  }, 1000);
})();

/* ── Stock simulation ───────────────────────────────────────── */
(function() {
  const el = document.getElementById('stockCount');
  let n = 17;
  setInterval(() => {
    if (n > 8 && Math.random() > 0.65) el.textContent = --n;
  }, 18000);
})();

/* ── Phone mask ─────────────────────────────────────────────── */
document.getElementById('phone').addEventListener('input', e => {
  let x = e.target.value.replace(/\D/g,'').slice(0,12);
  if (x.startsWith('380')) x = x.slice(2);

  let f = '+38 ';
  if (x.length > 0) f += '(' + x.slice(0,3);
  if (x.length >= 3) f += ') ' + x.slice(3,6);
  if (x.length >= 6) f += '-' + x.slice(6,8);
  if (x.length >= 8) f += '-' + x.slice(8,10);

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

  const ring  = document.querySelector('.success-ring');
  const check = document.querySelector('.check-path');

  [ring, check].forEach(el => {
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  });

  setTimeout(() => closeSuccessOverlay(), 7000);
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
document.getElementById('orderForm').addEventListener('submit', async e => {
  e.preventDefault();

  const msgEl = document.getElementById('formMessage');
  const name  = document.getElementById('name').value.trim();
  const phone = document.getElementById('phone').value.trim();
  const size  = selectedSizeInput.value.trim();
  const viaTg = document.getElementById('contactViaTelegram').checked;

  if (!name)  return showMsg(msgEl, 'Вкажіть, будь ласка, Ваше ім\'я.', 'error');
  if (!phone) return showMsg(msgEl, 'Вкажіть, будь ласка, номер телефону.', 'error');
  if (phone.replace(/\D/g,'').length < 10) return showMsg(msgEl, 'Номер телефону виглядає неповним.', 'error');
  if (!size)  return showMsg(msgEl, 'Оберіть розмір взуття.', 'error');

  const result = await postJSON('/api/order', {
    name,
    phone,
    size,
    contactViaTelegram: viaTg
  });

  if (!result || !result.success) {
    return showMsg(msgEl, 'Не вдалося надіслати замовлення. Спробуйте ще раз.', 'error');
  }

  e.target.reset();
  selectedSizeInput.value = '';
  sizeBtns.forEach(b => b.classList.remove('active'));
  document.getElementById('contactViaTelegram').checked = false;

  showSuccessOverlay(name, size);
});

/* ══════════════════════════════════════════════════════════════
   REVIEWS
══════════════════════════════════════════════════════════════ */
let allReviews = [
  { id:1, name:'Марина, Київ',  rating:5, text:'Дуже легкі та акуратні. На нозі виглядають ніжно, колір у житті ще кращий.', date:'2026-04-20', deletable:false },
  { id:2, name:'Олена, Львів',  rating:5, text:'Брала на кожен день. Зручні, м\'які, не тиснуть. Під джогери й джинси — супер.', date:'2026-04-19', deletable:false },
  { id:3, name:'Ірина, Дніпро', rating:5, text:'Сподобалось, що можна оплатити після примірки. Сайт зручний, замовлення швидке.', date:'2026-04-18', deletable:false },
];

let nextReviewId = 4;
let currentPage  = 1;
let currentSort  = 'newest';
const PER_PAGE   = 3;

function sorted() {
  const c = [...allReviews];
  switch (currentSort) {
    case 'newest':      return c.sort((a,b) => new Date(b.date) - new Date(a.date));
    case 'oldest':      return c.sort((a,b) => new Date(a.date) - new Date(b.date));
    case 'rating-high': return c.sort((a,b) => b.rating - a.rating);
    case 'rating-low':  return c.sort((a,b) => a.rating - b.rating);
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
    card.innerHTML = `
      <div class="review-top">
        <strong>${esc(r.name)}</strong>
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

  const prev = btn('←', 'page-btn page-btn--nav', currentPage === 1, () => {
    currentPage--;
    renderReviews();
  });
  pag.appendChild(prev);

  for (let i = 1; i <= total; i++) {
    const b = btn(i, 'page-btn' + (i === currentPage ? ' active' : ''), false, () => {
      currentPage = i;
      renderReviews();
    });
    pag.appendChild(b);
  }

  const next = btn('→', 'page-btn page-btn--nav', currentPage === total, () => {
    currentPage++;
    renderReviews();
  });
  pag.appendChild(next);
}

function btn(label, cls, disabled, onClick) {
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

renderReviews();

/* Star rating widget */
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
document.getElementById('reviewForm').addEventListener('submit', async e => {
  e.preventDefault();

  const msgEl  = document.getElementById('reviewMessage');
  const name   = document.getElementById('reviewName').value.trim();
  const rating = ratingInput.value;
  const text   = document.getElementById('reviewText').value.trim();

  if (!name)   return showMsg(msgEl, 'Вкажіть Ваше ім\'я.', 'error');
  if (!rating) return showMsg(msgEl, 'Будь ласка, поставте оцінку.', 'error');
  if (!text)   return showMsg(msgEl, 'Напишіть текст відгуку.', 'error');

  const r = {
    id: nextReviewId++,
    name,
    rating: Number(rating),
    text,
    date: new Date().toISOString().slice(0,10),
    deletable: true
  };

  allReviews.unshift(r);
  currentPage = 1;
  renderReviews();

  postJSON('/api/review', r);

  showMsg(msgEl, 'Дякуємо! Ваш відгук додано 💜', 'success');

  e.target.reset();
  ratingInput.value = '';
  starBtns.forEach(s => s.classList.remove('selected','hovered'));
});

/* ══════════════════════════════════════════════════════════════
   SUPPORT CHAT — SSE-backed live dialog
══════════════════════════════════════════════════════════════ */
const supportFab    = document.getElementById('supportFab');
const supportPanel  = document.getElementById('supportPanel');
const supportClose  = document.getElementById('supportClose');
const supportInput  = document.getElementById('supportInput');
const supportSend   = document.getElementById('supportSend');
const supportMsgs   = document.getElementById('supportMessages');
const supportStatus = document.getElementById('supportStatus');

/* Session ID — persists across page refresh within same tab session */
function getSessionId() {
  let id = sessionStorage.getItem('vm_sess');
  if (!id) {
    id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2,9);
    sessionStorage.setItem('vm_sess', id);
  }
  return id;
}

function createNewSessionId() {
  const id = 'sess_' + Date.now() + '_' + Math.random().toString(36).slice(2,9);
  sessionStorage.setItem('vm_sess', id);
  return id;
}

let SESSION_ID = getSessionId();
let dialogEnded = false;
let firstMessage = true;
let supportES = null;
let supportReconnectTimer = null;
let operatorConnected = false;

const BOT_REPLIES = [
  'Дякуємо за звернення! Оператор відповість найближчим часом 💜',
  'Зрозуміло! Уточнимо і зв\'яжемося з вами.',
  'Передамо це нашій команді.',
  'Очікуйте — оператор вже бачить ваш запит.',
];
let botIdx = 0;

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
  if (!window.EventSource) return;

  cleanupSSE();

  supportES = new EventSource(`${API}/api/support/stream?sessionId=${SESSION_ID}`);

  supportES.onmessage = e => {
    try {
      const d = JSON.parse(e.data);

      if (d.type === 'message') {
        addChatMsg(d.text, false, d.managerName || 'Підтримка');
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
      supportReconnectTimer = setTimeout(() => {
        connectSSE();
      }, 3000);
    }
  };
}

/* стартуем текущее подключение */
connectSSE();

/* Toggle panel */
supportFab.addEventListener('click', () => {
  const open = !supportPanel.classList.contains('support-panel--open');
  supportPanel.classList.toggle('support-panel--open', open);
  supportFab.classList.toggle('support-fab--active', open);

  if (open) {
    setTimeout(() => supportInput.focus(), 280);
  }
});

supportClose.addEventListener('click', () => {
  supportPanel.classList.remove('support-panel--open');
  supportFab.classList.remove('support-fab--active');
});

/* Add message to chat */
function now() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function addChatMsg(text, isUser, senderLabel) {
  const div = document.createElement('div');
  div.className = `support-msg ${isUser ? 'support-msg--user' : 'support-msg--bot'}`;
  div.innerHTML = `<div class="support-bubble">${esc(text)}</div><div class="support-time">${now()}</div>`;
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

function restoreChatForNewDialog() {
  dialogEnded = false;
  firstMessage = true;
  operatorConnected = false;

  supportStatus.textContent = '● Очікуємо оператора';
  supportInput.disabled = false;
  supportSend.disabled = false;
  supportInput.placeholder = 'Напишіть ваше повідомлення...';
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

  /* ВАЖНО:
     не убиваем чат насмерть, а просто переводим его в режим ожидания нового диалога */
  supportInput.disabled = false;
  supportSend.disabled = false;
  supportInput.placeholder = 'Напишіть нове повідомлення, щоб почати новий чат...';

  cleanupSSE();
}

async function sendSupportMsg() {
  const text = supportInput.value.trim();
  if (!text) return;

  /* Если предыдущий диалог завершён — стартуем новый прямо сейчас */
  if (dialogEnded) {
    SESSION_ID = createNewSessionId();
    restoreChatForNewDialog();
    connectSSE();
  }

  addChatMsg(text, true);
  supportInput.value = '';

  const result = await postJSON('/api/support', {
    message: text,
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString()
  });

  if (!result || !result.success) {
    addSystemMsg('Не вдалося надіслати повідомлення. Спробуйте ще раз.');
    return;
  }

  /* Автоответ только на первое сообщение, пока оператор ещё не подключился */
  if (firstMessage && !operatorConnected) {
    firstMessage = false;
    setTimeout(() => {
      if (!dialogEnded && !operatorConnected) {
        addChatMsg(BOT_REPLIES[botIdx++ % BOT_REPLIES.length], false);
      }
    }, 900 + Math.random() * 500);
  }
}

supportSend.addEventListener('click', sendSupportMsg);

supportInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendSupportMsg();
  }
});
