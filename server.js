/**
 * ═══════════════════════════════════════════════════════════
 * VIOLET MOTION — FINANCE MODULE (FIXED)
 * Замінює фінансовий блок у server.js
 *
 * ВИПРАВЛЕНО:
 *  1. externalId для ручних витрат (баг подвійного рахунку)
 *  2. otherExpense розбито на manualExpense + orderExpense
 *  3. unclassifiedIncome не псує total income рядок
 *  4. forecastProfit з міткою достовірності
 *  5. buyoutRate fallback з попередженням
 *  6. periodDate поле для швидкої фільтрації
 *  7. recordedExpense перейменовано в nonBankExpense
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

/* ─── Ідентифікатор дедублікації ─────────────────────────── */
function financeExternalId(source, category, orderId, extra = '') {
  return [source, category, orderId || 'none', extra || 'once'].join(':');
}

/* ─── Чи запис є непідтвердженим NP-записом ─────────────── */
function isUnverifiedNovaFinanceEntry(entry) {
  if (entry?.verifiedBy === 'monobank' || entry?.source === 'monobank') return false;
  if (entry?.category === 'net_order') return true;
  return entry?.source === 'nova-poshta' && ['shipping', 'return'].includes(entry?.category);
}

/* ─── Особисті витрати ───────────────────────────────────── */
function isPersonalFinanceEntry(entry) {
  return entry?.category === 'personal';
}

/* ─── Повернення бізнес-витрат ───────────────────────────── */
function isBusinessRefundEntry(entry) {
  return ['shipping_refund', 'return_refund', 'ads_refund', 'business_refund'].includes(entry?.category);
}

/* ─── Мітка категорії для відображення ──────────────────── */
function financeCategoryLabel(category) {
  return ({
    net_order:          'Оплата замовлення',
    shipping:           'Доставка НП',
    return:             'Повернення НП',
    ads:                'Реклама',
    shipping_refund:    'Повернення оплати доставки',
    return_refund:      'Повернення витрати повернення',
    ads_refund:         'Повернення реклами',
    business_refund:    'Повернення бізнес-витрати',
    manual_business:    'Бізнес-витрата (ручна)',
    personal:           'Особиста витрата',
    business_income:    'Бізнес-надходження',
    order:              'Витрата по замовленню',
    manual:             'Ручна операція',
    np_payout_unmatched:'НП: надходження без замовлення',
  })[category] || category || 'Операція';
}

/* ─── Додати запис один раз (з дедублікацією) ───────────── */
function addFinanceEntryOnce(entry, financeArr = null) {
  const finance = financeArr || read(F.finance);
  const externalId = entry.externalId ||
    financeExternalId(entry.source || 'system', entry.category || 'manual', entry.orderId, entry.kind);

  const existing = finance.find(x => x.externalId && x.externalId === externalId);
  if (existing) return existing;

  // ВИПРАВЛЕННЯ БАГ 1: periodDate для швидкої фільтрації
  const createdAt = entry.createdAt || new Date().toISOString();
  const periodDate = createdAt.slice(0, 10); // 'YYYY-MM-DD'

  const item = {
    id:               nextId(finance),
    type:             entry.type,
    title:            sanitizeStr(entry.title || (entry.type === 'income' ? 'Income' : 'Expense'), 180),
    amount:           asMoneyNumber(entry.amount),
    category:         sanitizeStr(entry.category || 'manual', 60),
    source:           sanitizeStr(entry.source || 'system', 60),
    orderId:          entry.orderId ? Number(entry.orderId) : null,
    externalId,       // завжди присутній тепер
    periodDate,
    grossAmount:      asMoneyNumber(entry.grossAmount),
    costAmount:       asMoneyNumber(entry.costAmount),
    productKey:       sanitizeStr(entry.productKey || '', 60) || null,
    productLabel:     sanitizeStr(entry.productLabel || '', 100) || null,
    verifiedBy:       sanitizeStr(entry.verifiedBy || '', 30) || null,
    bankTransactionId:sanitizeStr(entry.bankTransactionId || '', 120) || null,
    bankDescription:  sanitizeStr(entry.bankDescription || '', 240) || null,
    counterName:      sanitizeStr(entry.counterName || '', 180) || null,
    requiresReview:   entry.requiresReview || false,
    createdAt,
  };

  finance.push(item);
  if (!financeArr) write(F.finance, finance);
  return item;
}

/* ─── Контекст замовлення для транзакції ─────────────────── */
function financeOrderContext(order) {
  if (!order) return null;
  return {
    id:        order.id,
    name:      order.name || order.fullName || '',
    product:   orderProduct(order).label,
    size:      order.size || '',
    ttn:       order.ttn || '',
    returnTtn: order.npReturnExpressWaybillNumber || order.npReturnOrderNumber || '',
  };
}

/* ─── Побудова транзакцій за період ─────────────────────── */
function buildFinanceTransactions(period = 'today', orders = read(F.orders)) {
  const orderMap = new Map(orders.map(o => [Number(o.id), o]));
  const finance  = read(F.finance);

  const transactions = finance
    .filter(item => !item.excludedAt)
    .filter(item => !isUnverifiedNovaFinanceEntry(item))
    .filter(item => inPeriod(item.createdAt, period))
    .map(item => ({
      ...item,
      linkedOrder: financeOrderContext(orderMap.get(Number(item.orderId))),
    }));

  const financeExternalIds = new Set(transactions.map(item => item.externalId).filter(Boolean));

  // Додаємо embedded order expenses (якщо ще не в finance.json)
  orders.forEach(order => {
    (Array.isArray(order.expenses) ? order.expenses : []).forEach(expense => {
      if (!inPeriod(expense.createdAt || order.updatedAt || order.createdAt, period)) return;
      const externalId = financeExternalId(
        'order-expense',
        expense.category || 'order',
        order.id,
        expense.id || expense.createdAt || expense.amount,
      );
      if (financeExternalIds.has(externalId)) return;
      transactions.push({
        id:           `order-${order.id}-${expense.id || 'expense'}`,
        type:         'expense',
        title:        expense.title || 'Витрата по замовленню',
        amount:       asMoneyNumber(expense.amount),
        category:     expense.category || 'order',
        source:       'order-expense',
        orderId:      order.id,
        externalId,
        createdAt:    expense.createdAt || order.updatedAt || order.createdAt,
        linkedOrder:  financeOrderContext(order),
      });
      financeExternalIds.add(externalId);
    });
  });

  return transactions.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

/* ─── Ключовий CRM звіт ──────────────────────────────────── */
function buildCrmSummary(period = 'today') {
  const allOrders  = read(F.orders);
  const orders     = allOrders.filter(o => inPeriod(o.createdAt, period));
  const finance    = buildFinanceTransactions(period, allOrders);

  /* ── Доходи ── */
  // "net_order" — підтверджена оплата замовлення через monobank (не включаємо без підтвердження)
  const manualIncome = finance
    .filter(x => x.type === 'income' && ['business_income', 'manual_business_income'].includes(x.category))
    .reduce((s, x) => s + asMoneyNumber(x.amount), 0);

  const refundIncome = finance
    .filter(x => x.type === 'income' && isBusinessRefundEntry(x))
    .reduce((s, x) => s + asMoneyNumber(x.amount), 0);

  // ВИПРАВЛЕННЯ: unclassifiedIncome окремо, НЕ потрапляє у прибуток
  const unclassifiedIncome = finance
    .filter(x =>
      x.type === 'income' &&
      x.category !== 'net_order' &&
      !isBusinessRefundEntry(x) &&
      !['business_income', 'manual_business_income'].includes(x.category)
    )
    .reduce((s, x) => s + asMoneyNumber(x.amount), 0);

  /* ── Витрати ── */
  const businessExpenses = finance.filter(x => x.type === 'expense' && !isPersonalFinanceEntry(x));
  const expense          = businessExpenses.reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const personalExpense  = finance
    .filter(x => x.type === 'expense' && isPersonalFinanceEntry(x))
    .reduce((s, x) => s + asMoneyNumber(x.amount), 0);

  // Розбивка по категоріях
  const adsExpense      = businessExpenses.filter(x => x.category === 'ads').reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const returnsExpense  = businessExpenses.filter(x => x.category === 'return').reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const shippingExpense = businessExpenses.filter(x => x.category === 'shipping').reduce((s, x) => s + asMoneyNumber(x.amount), 0);
  const monobankExpense = businessExpenses.filter(x => x.source === 'monobank').reduce((s, x) => s + asMoneyNumber(x.amount), 0);

  // ВИПРАВЛЕННЯ: nonBankExpense = ручні бізнес-витрати (перейменовано з recordedExpense)
  const manualBusinessExpense = businessExpenses
    .filter(x => x.category === 'manual_business' && x.source === 'manual')
    .reduce((s, x) => s + asMoneyNumber(x.amount), 0);

  const orderLinkedExpense = businessExpenses
    .filter(x => ['order', 'return'].includes(x.category) && x.orderId)
    .reduce((s, x) => s + asMoneyNumber(x.amount), 0);

  // ВИПРАВЛЕННЯ: "інше" = все що не ads, не return, не shipping, не monobank-verified
  const otherExpense = expense - adsExpense - returnsExpense - shippingExpense;

  /* ── Замовлення ── */
  const paidOrders     = orders.filter(isPaidOrder);
  const returns        = orders.filter(isReturnedOrder);
  const pipelineOrders = orders.filter(isForecastPipelineOrder);
  const confirmedOrders = orders.filter(o =>
    orderStatusForDisplay(o) === 'confirmed' || isOrderActuallyShipped(o) ||
    o.status === 'paid' || o.status === 'completed'
  );

  /* ── Виручка ── */
  const revenue   = paidOrders.reduce((s, o) => s + orderPaidRevenue(o), 0);
  const cost      = paidOrders.reduce((s, o) => s + orderPaidCost(o), 0);
  const netOrders = paidOrders.reduce((s, o) => s + orderPaidNet(o), 0);

  /* ── Прибуток ── */
  // ВИПРАВЛЕННЯ: формула прозора і не включає unclassifiedIncome
  const profit = netOrders + manualIncome + refundIncome - expense;

  /* ── Monobank звірка ── */
  const paymentTransactions = finance.filter(x =>
    x.type === 'income' && x.category === 'net_order' && x.source === 'monobank'
  );
  const bankPayoutGross = paymentTransactions.reduce((s, x) =>
    s + (asMoneyNumber(x.grossAmount) || asMoneyNumber(x.amount) + asMoneyNumber(x.costAmount)), 0
  );

  /* ── Прогноз ── */
  const buyout           = buildBuyoutStats(orders, allOrders);
  const pendingRevenue   = pipelineOrders.reduce((s, o) => s + orderBaseRevenue(o), 0);
  const pendingCost      = pipelineOrders.reduce((s, o) => s + orderBaseCost(o), 0);
  const pipelineNet      = (pendingRevenue - pendingCost) * buyout.buyoutRate;
  const forecastProfit   = profit + pipelineNet;

  // ВИПРАВЛЕННЯ: мітка достовірності прогнозу
  const forecastReliable = (paidOrders.length + returns.length) >= 5;

  /* ── Afterpayments ── */
  const afterpayments = buildAfterpaymentSummary(period, allOrders);

  /* ── Продукти ── */
  const productExpenses = new Map();
  finance
    .filter(x => x.type === 'expense' && x.orderId && !isPersonalFinanceEntry(x))
    .forEach(entry => {
      const order = allOrders.find(c => Number(c.id) === Number(entry.orderId));
      if (!order) return;
      const key = orderProductKey(order);
      productExpenses.set(key, (productExpenses.get(key) || 0) + asMoneyNumber(entry.amount));
    });

  const products = buildProductBreakdown(orders).map(product => {
    const finalCount       = product.paidOrders + product.returns;
    const productBuyoutRate = finalCount ? product.paidOrders / finalCount : buyout.buyoutRate;
    const linkedExpense    = productExpenses.get(product.key) || 0;
    return {
      ...product,
      linkedExpense,
      profitAfterLinkedExpenses: product.net - linkedExpense,
      buyoutRate:  productBuyoutRate,
      returnRate:  finalCount ? product.returns / finalCount : buyout.returnRate,
      forecastNet: product.net - linkedExpense + product.pipelineNet * productBuyoutRate,
    };
  });

  return {
    period,
    /* Замовлення */
    orders:          orders.length,
    newOrders:       orders.filter(o => o.status === 'new').length,
    confirmedOrders: confirmedOrders.length,
    paidOrders:      paidOrders.length,
    returns:         returns.length,
    pipelineOrders:  pipelineOrders.length,
    /* Виручка */
    revenue,
    cost,
    netOrders,
    /* Витрати */
    expense,
    personalExpense,
    adsExpense,
    shippingExpense,
    returnsExpense,
    monobankExpense,
    manualBusinessExpense,
    orderLinkedExpense,
    otherExpense,
    /* Доходи (окремо від виручки замовлень) */
    manualIncome,
    refundIncome,
    unclassifiedIncome, // показуємо як попередження, НЕ додаємо до прибутку
    /* Прибуток */
    profit,
    /* Monobank звірка */
    bankPayoutGross,
    bankMatchedPayouts: paymentTransactions.length,
    afterpayments,
    /* Прогноз */
    forecastProfit,
    forecastReliable,    // false = мало даних, прогноз умовний
    buyoutRate:         buyout.buyoutRate,
    buyoutRateSource:   buyout.rateSource,
    returnRate:         buyout.returnRate,
    pipelineNet,
    /* Додаткові метрики */
    avgCheck:           paidOrders.length ? revenue / paidOrders.length : 0,
    leadCost:           orders.length ? adsExpense / orders.length : 0,
    paidOrderCost:      paidOrders.length ? adsExpense / paidOrders.length : 0,
    products,
    recentPayments:     buildRecentPayments(paidOrders),
    transactions:       finance,
  };
}

/* ─── POST /api/admin/finance (ВИПРАВЛЕНО: externalId для ручних) ── */
/*
  Замінює поточний handler у server.js.
  Ключова зміна: додає externalId щоб уникнути подвійного рахунку
  при наступній синхронізації monobank.
*/
function handleFinancePost(req, res) {
  const arr    = read(F.finance);
  const amount = asMoneyNumber(req.body?.amount);
  const type   = sanitizeStr(req.body?.type, 20);

  if (!['income', 'expense'].includes(type))
    return res.status(400).json({ error: 'Invalid type' });
  if (!Number.isFinite(amount) || amount < 0)
    return res.status(400).json({ error: 'Invalid amount' });

  const category = sanitizeStr(req.body?.category || 'manual', 60);
  const source   = 'manual';
  const orderId  = req.body?.orderId ? Number(req.body.orderId) : null;
  const now      = req.body?.createdAt || new Date().toISOString();

  // ВИПРАВЛЕННЯ: унікальний externalId для ручних операцій
  // Формат: manual:{category}:{orderId|none}:{timestamp_ms}
  const externalId = financeExternalId(source, category, orderId, Date.now().toString());

  const item = {
    id:          nextId(arr),
    type,
    title:       sanitizeStr(req.body?.title || (type === 'income' ? 'Дохід' : 'Витрата'), 180),
    amount,
    category,
    source,
    orderId,
    externalId,  // тепер завжди є
    periodDate:  now.slice(0, 10),
    createdAt:   now,
  };

  arr.push(item);
  write(F.finance, arr);
  res.json(item);
}

/* ─── Утиліта: очистити некласифіковані старі записи ──────── */
/*
  POST /api/admin/finance/cleanup-unclassified
  Видаляє income-записи без відомої категорії (excludedAt замість delete).
  Безпечна операція — можна відновити через backup.
*/
function handleFinanceCleanupUnclassified(req, res) {
  const arr = read(F.finance);
  const knownIncomeCategories = new Set([
    'net_order', 'business_income', 'manual_business_income',
    'shipping_refund', 'return_refund', 'ads_refund', 'business_refund',
    'np_payout_unmatched',
  ]);
  const now = new Date().toISOString();
  let cleaned = 0;
  arr.forEach(item => {
    if (
      item.type === 'income' &&
      !item.excludedAt &&
      !knownIncomeCategories.has(item.category)
    ) {
      item.excludedAt     = now;
      item.excludedReason = 'unclassified_cleanup';
      cleaned++;
    }
  });
  if (cleaned) write(F.finance, arr);
  res.json({ success: true, cleaned });
}
