'use strict';

const MONO_API_URL = process.env.MONOBANK_API_URL || 'https://api.monobank.ua';
const MONO_TOKEN = String(process.env.MONOBANK_TOKEN || '').trim();
const MONO_ACCOUNT_ID = String(process.env.MONOBANK_ACCOUNT_ID || '0').trim();
const MONO_TIMEOUT_MS = Math.max(1000, Number(process.env.MONOBANK_TIMEOUT_MS || 12000));

class MonobankError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'MonobankError';
    this.details = details;
  }
}

async function callMonobank(pathname, options = {}) {
  if (!MONO_TOKEN) throw new MonobankError('Monobank token is not configured', { missing: ['MONOBANK_TOKEN'] });
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), MONO_TIMEOUT_MS);
  try {
    const response = await fetch(`${MONO_API_URL}${pathname}`, {
      ...options,
      signal: ctrl.signal,
      headers: {
        'X-Token': MONO_TOKEN,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) {
      throw new MonobankError(`Monobank HTTP ${response.status}`, {
        status: response.status,
        raw: payload || text.slice(0, 500),
      });
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new MonobankError('Monobank request timed out', { retryable: true });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function getStatement({ account = MONO_ACCOUNT_ID, from, to = Math.floor(Date.now() / 1000) } = {}) {
  const start = Math.floor(Number(from));
  const end = Math.floor(Number(to));
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new MonobankError('Statement interval is invalid');
  const data = await callMonobank(`/personal/statement/${encodeURIComponent(account || '0')}/${start}/${end}`);
  return Array.isArray(data) ? data : [];
}

async function setWebhook(webHookUrl) {
  const url = String(webHookUrl || '').trim();
  if (!url) throw new MonobankError('Webhook URL is required');
  return callMonobank('/personal/webhook', {
    method: 'POST',
    body: JSON.stringify({ webHookUrl: url }),
  });
}

function configStatus() {
  return {
    configured: !!MONO_TOKEN,
    accountId: MONO_ACCOUNT_ID || '0',
    missing: MONO_TOKEN ? [] : ['MONOBANK_TOKEN'],
  };
}

module.exports = {
  MonobankError,
  getStatement,
  setWebhook,
  configStatus,
};
