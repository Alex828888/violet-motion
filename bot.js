/**
 * ═══════════════════════════════════════════════════════════
 * VIOLET MOTION — FINANCE UI (bot.js) — СПРОЩЕНА ВЕРСІЯ
 * Замінює фінансовий блок у bot.js
 *
 * ЗМІНИ:
 *  • 14 кнопок → 6 кнопок в головному меню фінансів
 *  • "Monobank live" прибрано з основного меню
 *  • "Оновити НП" прибрано з фінансів (є у Відстеженні)
 *  • Формула прибутку прибрана з основного екрану
 *  • Звірка monobank перенесена в екран "Операції"
 *  • Секція afterpayments НП — в "Операції"
 *  • unclassifiedIncome показується як одне попередження
 *  • Прогноз з міткою достовірності
 * ═══════════════════════════════════════════════════════════
 */

'use strict';

/* ─── Назви категорій ────────────────────────────────────── */
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
    manual_business:    'Бізнес-витрата',
    personal:           'Особиста витрата',
    business_income:    'Бізнес-надходження',
    order:              'Витрата по замовленню',
    manual:             'Ручна операція',
    np_payout_unmatched:'НП: надходження без замовлення',
  })[category] || category || 'Операція';
}

/* ─── Піктограма типу операції ───────────────────────────── */
function financeEntryEmoji(item) {
  if (item.type === 'income') return '✅';
  if (item.category === 'personal') return '👤';
  if (item.category === 'ads') return '📣';
  if (item.category === 'shipping') return '🚚';
  if (item.category === 'return') return '↩️';
  return '➖';
}

/* ═══════════════════════════════════════════════════════════
   ФІНАНСИ — ГОЛОВНЕ МЕНЮ (СПРОЩЕНО)
   Було: 14 кнопок | Стало: 6 кнопок
═══════════════════════════════════════════════════════════ */
function crmFinanceKb(period = 'today') {
  const mark = p => period === p ? '• ' : '';
  return {
    inline_keyboard: [
      // Вибір періоду — один рядок компактно
      [
        { text: `${mark('today')}Сьогодні`,  callback_data: 'crm_period_today' },
        { text: `${mark('week')}7 днів`,     callback_data: 'crm_period_week' },
        { text: `${mark('month')}Місяць`,    callback_data: 'crm_period_month' },
        { text: `${mark('all')}Усі`,         callback_data: 'crm_period_all' },
      ],
      // Дії
      [
        { text: '➕ Витрата',        callback_data: `crm_add_expense_${period}` },
        { text: '📋 Операції',       callback_data: `crm_tx_${period}_1` },
        { text: '🔄 Синхр.',         callback_data: `crm_sync_all_${period}` },
      ],
      [
        { text: '🏷 Собівартість',   callback_data: 'crm_products' },
        { text: '← CRM',            callback_data: 'crm_menu' },
      ],
    ],
  };
}

/* ─── Меню вибору типу витрати (бізнес / особиста) ──────── */
function crmExpenseTypeKb(period = 'today') {
  return {
    inline_keyboard: [
      [
        { text: '💼 Бізнес-витрата',  callback_data: `crm_add_business_${period}` },
        { text: '👤 Особиста',        callback_data: `crm_add_personal_${period}` },
      ],
      [{ text: '← Фінанси', callback_data: `crm_period_${period}` }],
    ],
  };
}

/* ─── Меню синхронізації ─────────────────────────────────── */
function crmSyncKb(period = 'today') {
  return {
    inline_keyboard: [
      [{ text: '🏦 Синхр. monobank (3 дні)', callback_data: `crm_mono_sync_${period}` }],
      [{ text: '🏦 Синхр. monobank (місяць)', callback_data: `crm_mono_sync_month_${period}` }],
      [{ text: '← Фінанси', callback_data: `crm_period_${period}` }],
    ],
  };
}

/* ═══════════════════════════════════════════════════════════
   ГОЛОВНИЙ ЕКРАН ФІНАНСІВ — ЧИСТИЙ І ЛАКОНІЧНИЙ
═══════════════════════════════════════════════════════════ */
async function showCrmReport(chatId, period = 'today', msgId = null) {
  const data = await serverGet(`/api/admin/crm/summary?period=${encodeURIComponent(period)}`);
  if (!data || data.error) {
    return reply(chatId, '❌ CRM-звіт зараз недоступний.', crmFinanceKb(period), msgId);
  }

  const periodLabel = { today: 'Сьогодні', week: '7 днів', month: 'Місяць', all: 'Увесь час' }[period] || period;

  /* Блок попередження про некласифіковані надходження */
  const warnLine = Number(data.unclassifiedIncome || 0) > 0
    ? `\n⚠️ Некласифіковані надходження: <b>+${money(data.unclassifiedIncome)}</b> (не у прибутку)\n`
    : '';

  /* Блок прогнозу з міткою */
  const forecastLine = data.pipelineOrders > 0
    ? (data.forecastReliable
        ? `\n🔜 На конвеєрі: <b>+${money(data.pipelineNet)}</b> (${data.pipelineOrders} замовл.)`
        : `\n🔜 На конвеєрі: <b>~${money(data.pipelineNet)}</b> (умовно, мало даних)`)
    : '';

  /* Блок особистих */
  const personalLine = Number(data.personalExpense || 0) > 0
    ? `👤 Особисті: <b>−${money(data.personalExpense)}</b> (не у прибутку)\n`
    : '';

  /* Блок реклами */
  const adsLine = Number(data.adsExpense || 0) > 0
    ? `📣 Реклама: <b>−${money(data.adsExpense)}</b>\n`
    : '';

  const text =
    `💰 <b>Фінанси — ${periodLabel}</b>\n━━━━━━━━━━━━━━━\n` +
    `📦 Замовлень: <b>${data.orders || 0}</b>  ✅ викуп: ${data.paidOrders || 0}  ↩️ поверн.: ${data.returns || 0}\n\n` +

    `<b>Результат</b>\n` +
    `💵 Виручка:       <b>+${money(data.revenue)}</b>\n` +
    `🏷 Собівартість:  <b>−${money(data.cost)}</b>\n` +
    `📊 Маржа:         <b>+${money(data.netOrders)}</b>\n` +
    `💸 Витрати:       <b>−${money(data.expense)}</b>\n` +
    `   ${adsLine}   🚚 Доставка: ${money(data.shippingExpense)}  ↩️ Повернення: ${money(data.returnsExpense)}\n` +
    `   Інше: ${money(data.otherExpense - data.adsExpense - data.shippingExpense - data.returnsExpense > 0 ? data.manualBusinessExpense || 0 : 0)}\n` +
    (Number(data.manualIncome || 0) > 0 ? `➕ Надходження: <b>+${money(data.manualIncome)}</b>\n` : '') +
    (Number(data.refundIncome || 0) > 0 ? `↩️ Повернення списань: <b>+${money(data.refundIncome)}</b>\n` : '') +
    `━━━━━━━━━━━━━━━\n` +
    `✅ <b>Прибуток: ${money(data.profit)}</b>\n` +
    forecastLine + '\n\n' +
    personalLine +
    warnLine;

  reply(chatId, text, crmFinanceKb(period), msgId);
}

/* ═══════════════════════════════════════════════════════════
   ЕКРАН ОПЕРАЦІЙ — ТРАНЗАКЦІЇ + ЗВІРКА MONOBANK
═══════════════════════════════════════════════════════════ */
function crmTransactionsKb(period, page, total, items = []) {
  const rows = [];

  /* Кнопки видалення ручних витрат */
  items
    .filter(item => item.type === 'expense' && item.source === 'manual' && Number.isFinite(Number(item.id)))
    .forEach(item => {
      rows.push([{
        text: `🗑 ${financeCategoryLabel(item.category)} −${money(item.amount)}`,
        callback_data: `crm_tx_del_${item.id}_${period}_${page}`,
      }]);
    });

  /* Навігація */
  const nav = [];
  if (page > 1)    nav.push({ text: '← Назад', callback_data: `crm_tx_${period}_${page - 1}` });
  nav.push({ text: `${page}/${total}`, callback_data: 'noop' });
  if (page < total) nav.push({ text: 'Далі →', callback_data: `crm_tx_${period}_${page + 1}` });
  if (nav.length) rows.push(nav);

  rows.push([
    { text: '🏦 Звірка monobank', callback_data: `crm_bank_check_${period}` },
    { text: '← Фінанси',         callback_data: `crm_period_${period}` },
  ]);

  return { inline_keyboard: rows };
}

async function showCrmTransactions(chatId, period = 'today', page = 1, msgId = null) {
  const data = await serverGet(`/api/admin/crm/summary?period=${encodeURIComponent(period)}`);
  if (!data || data.error)
    return reply(chatId, '❌ Операції зараз недоступні.', crmFinanceKb(period), msgId);

  const records  = Array.isArray(data.transactions) ? data.transactions : [];
  const pageSize = 8;
  const total    = Math.ceil(records.length / pageSize) || 1;
  const current  = Math.max(1, Math.min(Number(page) || 1, total));
  const items    = records.slice((current - 1) * pageSize, current * pageSize);

  const periodLabel = { today: 'Сьогодні', week: '7 днів', month: 'Місяць', all: 'Увесь час' }[period] || period;

  let text = `📋 <b>Операції — ${periodLabel}</b>\n━━━━━━━━━━━━━━━\n`;

  if (!items.length) {
    text += '\nОперацій за цей період немає.';
  } else {
    items.forEach(item => {
      const emoji  = financeEntryEmoji(item);
      const sign   = item.type === 'income' ? '+' : '−';
      const amount = `${sign}${money(item.amount)}`;

      text += `\n${emoji} <b>${amount}</b> · ${esc(financeCategoryLabel(item.category))}\n`;
      text += `   ${esc(item.title || 'Операція')}\n`;

      if (item.bankDescription)
        text += `   🏦 ${esc(item.bankDescription)}\n`;

      if (item.linkedOrder?.id) {
        text += `   #${esc(item.linkedOrder.id)} ${esc(item.linkedOrder.product || '—')}`;
        if (item.linkedOrder.size) text += ` р.${esc(item.linkedOrder.size)}`;
        text += '\n';
      }

      text += `   ${fmtDate(item.createdAt)}\n`;
    });
  }

  return reply(chatId, text, crmTransactionsKb(period, current, total, items), msgId);
}

/* ─── Звірка monobank (окремий підекран) ─────────────────── */
async function showBankCheck(chatId, period = 'today', msgId = null) {
  const data = await serverGet(`/api/admin/crm/summary?period=${encodeURIComponent(period)}`);
  if (!data || data.error)
    return reply(chatId, '❌ Зараз недоступно.', crmFinanceKb(period), msgId);

  const periodLabel = { today: 'Сьогодні', week: '7 днів', month: 'Місяць', all: 'Увесь час' }[period] || period;

  const afterpayments = data.afterpayments || {};

  const text =
    `🏦 <b>Звірка — ${periodLabel}</b>\n━━━━━━━━━━━━━━━\n\n` +
    `<b>Надходження на картку (monobank)</b>\n` +
    `Знайдено: <b>+${money(data.bankPayoutGross)}</b> (${data.bankMatchedPayouts || 0} платежів)\n` +
    `Це реальне надходження грошей на рахунок, може відрізнятися від виручки замовлень через час перерахування НП.\n\n` +
    `<b>Готівкові після оплати НП</b>\n` +
    `💵 До отримання: <b>${money(afterpayments.cashAmount || afterpayments.amount || 0)}</b>\n` +
    `Записів: ${afterpayments.records || 0}  Зіставлено з замовленнями: ${afterpayments.matchedOrders || 0}\n` +
    `Це гроші які НП тримає за вас і ще не перерахувала.`;

  return reply(chatId, text, {
    inline_keyboard: [
      [{ text: '← Операції', callback_data: `crm_tx_${period}_1` }],
      [{ text: '← Фінанси',  callback_data: `crm_period_${period}` }],
    ],
  }, msgId);
}

/* ═══════════════════════════════════════════════════════════
   ОБРОБНИКИ CALLBACK (фінансові) — вставити в головний блок
═══════════════════════════════════════════════════════════ */

/*
  Додати у bot.js в блок callback_query:

  // ФІНАНСИ — вибір витрати
  if (data.startsWith('crm_add_expense_')) {
    const period = data.slice('crm_add_expense_'.length);
    await reply(chatId, '➕ <b>Яка витрата?</b>', crmExpenseTypeKb(period), msgId);
    return;
  }

  // ФІНАНСИ — синхронізація
  if (data.startsWith('crm_sync_all_')) {
    const period = data.slice('crm_sync_all_'.length);
    await reply(chatId, '🔄 <b>Виберіть синхронізацію:</b>', crmSyncKb(period), msgId);
    return;
  }

  // ФІНАНСИ — monobank sync за місяць
  if (data.startsWith('crm_mono_sync_month_')) {
    const period = data.slice('crm_mono_sync_month_'.length);
    const result = await serverPost('/api/admin/monobank/sync', { daysBack: 31 });
    if (!result || result.error) {
      await reply(chatId, `❌ Monobank не синхронізовано: ${esc(result?.error || 'перевірте токен')}`, crmFinanceKb(period), msgId);
      return;
    }
    await reply(chatId, `✅ Синхронізовано за місяць.\nПеревірено: ${result.checked || 0}, імпортовано: ${result.imported || 0}`, crmFinanceKb(period), msgId);
    return;
  }

  // ФІНАНСИ — звірка monobank
  if (data.startsWith('crm_bank_check_')) {
    const period = data.slice('crm_bank_check_'.length);
    await showBankCheck(chatId, period, msgId);
    return;
  }
*/

/* ═══════════════════════════════════════════════════════════
   ПОВНА ЗАМІНA showCrmReport — CALLBACK ROUTING (bot.js)
   Замінити існуючий блок crm_period_ у callback_query
═══════════════════════════════════════════════════════════ */
/*
  // Замінити в callback_query:
  if (data === 'crm_finance') {
    await showCrmReport(chatId, 'today', msgId);
    return;
  }

  if (data.startsWith('crm_period_')) {
    const period = data.slice('crm_period_'.length);
    await showCrmReport(chatId, ['today','week','month','all'].includes(period) ? period : 'today', msgId);
    return;
  }
*/

/* ═══════════════════════════════════════════════════════════
   ТЕКСТ ВВЕДЕННЯ ВИТРАТИ (pendingFinanceExpense) — СПРОЩЕНИЙ
═══════════════════════════════════════════════════════════ */
/*
  Замінити в bot.js (при обробці pendingFinanceExpense):

  if (pendingFinanceExpense[chatId]) {
    const pending = pendingFinanceExpense[chatId];
    if (text === '-' || text.toLowerCase() === 'cancel') {
      delete pendingFinanceExpense[chatId];
      await showCrmReport(chatId, pending.period || 'today');
      return;
    }
    const match = text.match(/^(\d+(?:[.,]\d{1,2})?)\s+(.+)$/);
    if (!match) {
      await bot.sendMessage(chatId,
        `❌ Формат: <code>сума назва</code>, наприклад: <code>300 Київстар</code>\n\nДля скасування — «-»`,
        { parse_mode: 'HTML' });
      return;
    }
    const amount = Number(match[1].replace(',', '.'));
    const title  = match[2].trim();
    const result = await serverPost('/api/admin/finance', {
      type:     'expense',
      amount,
      title,
      category: pending.category,
      source:   'manual',
    });
    if (!result || result.error) {
      await bot.sendMessage(chatId, '❌ Не вдалося зберегти витрату.', { reply_markup: MAIN_KB });
      return;
    }
    delete pendingFinanceExpense[chatId];
    const label = pending.category === 'personal' ? 'Особиста витрата' : 'Бізнес-витрата';
    await bot.sendMessage(chatId,
      `✅ ${label} збережена: <b>−${money(amount)}</b> · ${esc(title)}`,
      { parse_mode: 'HTML', reply_markup: MAIN_KB });
    await showCrmReport(chatId, pending.period || 'today');
    return;
  }
*/
