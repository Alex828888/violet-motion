'use strict';

const NP_API_URL = process.env.NP_API_URL || 'https://api.novaposhta.ua/v2.0/json/';
const NP_API_KEY = process.env.NOVA_POSHTA_API_KEY || process.env.NP_API_KEY || '';
const NP_TIMEOUT_MS = Number(process.env.NP_TIMEOUT_MS || 15000);
const NP_MIN_INTERVAL_MS = Math.max(0, Number(process.env.NP_MIN_INTERVAL_MS || 650));
const NP_MAX_RETRIES = Math.max(0, Number(process.env.NP_MAX_RETRIES || 3));
const NP_RETRY_BASE_MS = Math.max(250, Number(process.env.NP_RETRY_BASE_MS || 1200));
const NP_CACHE_TTL_MS = Math.max(0, Number(process.env.NP_CACHE_TTL_MS || 6 * 60 * 60 * 1000));
const NP_DEFAULT_PACK_REF = '6acae69a-e177-4732-9935-acecf090b158'; // Nova Poshta: Коробка (3 кг) пласка

let novaQueue = Promise.resolve();
let lastNovaCallAt = 0;
const cityCache = new Map();
const warehouseCache = new Map();

class NovaPoshtaError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'NovaPoshtaError';
    this.details = details;
  }
}

function env(name, fallback = '') {
  return String(process.env[name] || fallback || '').trim();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cacheGet(map, key) {
  const item = map.get(key);
  if (!item) return null;
  if (NP_CACHE_TTL_MS && Date.now() - item.ts > NP_CACHE_TTL_MS) {
    map.delete(key);
    return null;
  }
  return item.value;
}

function cacheSet(map, key, value) {
  if (value) map.set(key, { value, ts: Date.now() });
  return value;
}

function isRateLimitPayload(payload, status = 0) {
  const text = [
    status,
    ...(Array.isArray(payload?.errors) ? payload.errors : []),
    ...(Array.isArray(payload?.warnings) ? payload.warnings : []),
    ...(Array.isArray(payload?.info) ? payload.info : []),
    payload?.error,
    payload?.message,
  ].filter(Boolean).join(' ').toLowerCase();
  return status === 429 || /to+\s+many\s+requests|too\s+many\s+requests|rate\s*limit|ліміт|лимит/.test(text);
}

function isRetryableNovaError(error) {
  const details = error?.details || {};
  return !!(details.retryable || details.rateLimited || details.status === 429 || isRateLimitPayload(details.raw, details.status));
}

function retryDelayMs(attempt) {
  const jitter = Math.floor(Math.random() * 350);
  return NP_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt - 1)) + jitter;
}

async function reserveNovaSlot() {
  const previous = novaQueue;
  let release;
  novaQueue = new Promise(resolve => { release = resolve; });
  await previous.catch(() => {});
  const waitMs = Math.max(0, NP_MIN_INTERVAL_MS - (Date.now() - lastNovaCallAt));
  if (waitMs) await sleep(waitMs);
  return () => {
    lastNovaCallAt = Date.now();
    release();
  };
}

function moneyNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const n = Number(String(value).replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('0')) return `38${digits}`;
  if (digits.length === 12 && digits.startsWith('380')) return digits;
  return digits;
}

function normalizeCityQuery(value) {
  let text = String(value || '').trim();
  if (!text) return '';
  text = text
    .replace(/\b(україна|украина|ukraine)\b/ig, ' ')
    .replace(/\b(закарпатська|волинська|львівська|івано-франківська|тернопільська|рівненська|чернівецька|хмельницька|житомирська|вінницька|київська|черкаська|кіровоградська|полтавська|сумська|чернігівська|харківська|луганська|донецька|дніпропетровська|запорізька|херсонська|миколаївська|одеська)\s+область\b/ig, ' ')
    .replace(/\b(область|обл\.?|район|р-н)\b/ig, ' ')
    .replace(/\b(місто|город|м\.|г\.)\b/ig, ' ')
    .replace(/[,\.;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const match = text.match(/(?:місто|город|м\.|г\.)\s*([А-ЯІЇЄҐA-Z][\p{L}'’ʼ-]+)/iu);
  if (match?.[1]) return match[1].trim();
  const tokens = text.split(/\s+/).filter(Boolean);
  return tokens.length > 1 ? tokens[tokens.length - 1] : text;
}

function normalizeWarehouseQuery(value) {
  const raw = String(value || '').trim();
  if (!raw) return { raw: '', number: '', search: '' };
  const number = raw.match(/\d+/)?.[0] || '';
  const withoutNoise = raw
    .replace(/відділення|отделение|номер|№|#|нп|нова\s+пошта|нової\s+пошти/ig, ' ')
    .replace(/[,\.;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    raw,
    number,
    search: number || withoutNoise || raw,
  };
}

function todayNpDate() {
  const now = new Date();
  return formatNpDate(now);
}

function formatNpDate(date) {
  const now = new Date(date);
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${now.getFullYear()}`;
}

function dateDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - Math.max(0, Number(days || 0)));
  return d;
}

function splitFullName(value) {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: '', lastName: '', middleName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0], middleName: '' };
  return {
    lastName: parts[0],
    firstName: parts[1],
    middleName: parts.slice(2).join(' '),
  };
}

async function callNovaPoshta(modelName, calledMethod, methodProperties = {}, apiKey = NP_API_KEY) {
  if (!apiKey) throw new NovaPoshtaError('Nova Poshta API key is not configured', { missing: ['NOVA_POSHTA_API_KEY'] });

  let lastError = null;
  const attempts = NP_MAX_RETRIES + 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const release = await reserveNovaSlot();
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), NP_TIMEOUT_MS);
    try {
      const response = await fetch(NP_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ apiKey, modelName, calledMethod, methodProperties }),
      });
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch {}
      if (!response.ok) {
        throw new NovaPoshtaError(`Nova Poshta HTTP ${response.status}`, {
          modelName, calledMethod,
          status: response.status,
          body: text.slice(0, 1000),
          raw: payload,
          rateLimited: isRateLimitPayload(payload, response.status),
          retryable: response.status >= 500 || response.status === 429,
        });
      }
      if (!payload || payload.success !== true) {
        const rateLimited = isRateLimitPayload(payload, response.status);
        throw new NovaPoshtaError('Nova Poshta API returned an error', {
          modelName, calledMethod,
          errors: payload?.errors || [],
          warnings: payload?.warnings || [],
          info: payload?.info || [],
          raw: payload,
          rateLimited,
          retryable: rateLimited,
        });
      }
      return payload;
    } catch (error) {
      if (error.name === 'AbortError') {
        lastError = new NovaPoshtaError('Nova Poshta request timed out', {
          modelName, calledMethod, retryable: true,
        });
      } else {
        lastError = error;
      }
    } finally {
      clearTimeout(timeout);
      release();
    }

    if (attempt < attempts && isRetryableNovaError(lastError)) {
      const delay = retryDelayMs(attempt);
      if (lastError?.details) {
        lastError.details.attempt = attempt;
        lastError.details.retryAfterMs = delay;
      }
      await sleep(delay);
      continue;
    }
    break;
  }
  throw lastError;
}

function requireSenderConfig() {
  const cfg = {
    CitySender: env('NP_SENDER_CITY_REF'),
    Sender: env('NP_SENDER_REF') || env('NP_SENDER_COUNTERPARTY_REF'),
    SenderAddress: env('NP_SENDER_ADDRESS_REF') || env('NP_SENDER_WAREHOUSE_REF'),
    ContactSender: env('NP_CONTACT_SENDER_REF'),
    SendersPhone: normalizePhone(env('NP_SENDER_PHONE')),
  };
  const missing = Object.entries(cfg).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    throw new NovaPoshtaError('Nova Poshta sender config is incomplete', {
      missing,
      env: [
        'NP_SENDER_CITY_REF',
        'NP_SENDER_REF',
        'NP_SENDER_ADDRESS_REF',
        'NP_CONTACT_SENDER_REF',
        'NP_SENDER_PHONE',
      ],
    });
  }
  return cfg;
}

function pickByPhone(items, phone) {
  const target = normalizePhone(phone);
  if (!target) return null;
  return items.find(item => {
    const phones = [
      item.Phone,
      item.Phones,
      item.ContactPersonPhones,
      item.CounterpartyPhone,
      item.SendersPhone,
    ].filter(Boolean).join(' ');
    const digits = normalizePhone(phones);
    return digits && (digits === target || digits.endsWith(target) || target.endsWith(digits));
  }) || null;
}

async function getSenderCounterparties() {
  const response = await callNovaPoshta('Counterparty', 'getCounterparties', {
    CounterpartyProperty: 'Sender',
    Page: '1',
  });
  return response.data || [];
}

async function getSenderContacts(senderRef) {
  const props = { Ref: senderRef, CounterpartyProperty: 'Sender' };
  try {
    const response = await callNovaPoshta('Counterparty', 'getCounterpartyContactPersons', props);
    return response.data || [];
  } catch (firstError) {
    const response = await callNovaPoshta('Counterparty', 'getCounterpartyContactPerson', props);
    return response.data || [];
  }
}

async function getSenderAddresses(senderRef) {
  const response = await callNovaPoshta('Counterparty', 'getCounterpartyAddresses', {
    Ref: senderRef,
    CounterpartyProperty: 'Sender',
  });
  return response.data || [];
}

function pickCityRef(...items) {
  for (const item of items) {
    if (!item) continue;
    const ref = item.CityRef || item.CitySender || item.City || item.SettlementRef || item.DeliveryCity || item.RefCity;
    if (ref) return ref;
  }
  return '';
}

function pickWarehouseRef(item) {
  if (!item) return '';
  return item.Ref || item.WarehouseRef || item.AddressRef || item.SenderAddress || '';
}

async function resolveSenderCityFromText(...items) {
  const text = items
    .flatMap(item => item ? [
      item.CityDescription,
      item.CityDescriptionRu,
      item.CityDescriptionUa,
      item.CityName,
      item.City,
      item.Description,
    ] : [])
    .map(v => String(v || '').trim())
    .find(Boolean);
  if (!text) return '';
  try {
    const city = await resolveCity(text);
    return city.ref || '';
  } catch {
    return '';
  }
}

async function pickFirstWarehouseInCity(cityRef) {
  if (!cityRef) return null;
  try {
    const response = await callNovaPoshta('Address', 'getWarehouses', {
      CityRef: cityRef,
      Limit: 1,
      Page: 1,
    });
    return response.data?.[0] || null;
  } catch {
    return null;
  }
}

let senderConfigCache = null;
async function resolveSenderConfig() {
  const explicit = {
    CitySender: env('NP_SENDER_CITY_REF'),
    Sender: env('NP_SENDER_REF') || env('NP_SENDER_COUNTERPARTY_REF'),
    SenderAddress: env('NP_SENDER_ADDRESS_REF') || env('NP_SENDER_WAREHOUSE_REF'),
    ContactSender: env('NP_CONTACT_SENDER_REF'),
    SendersPhone: normalizePhone(env('NP_SENDER_PHONE')),
  };
  if (Object.values(explicit).every(Boolean)) return explicit;
  if (senderConfigCache) return senderConfigCache;

  const counterparties = await getSenderCounterparties();
  if (!counterparties.length) throw new NovaPoshtaError('Nova Poshta sender was not found in account', { method: 'Counterparty/getCounterparties' });

  let chosenSender = explicit.Sender
    ? counterparties.find(x => x.Ref === explicit.Sender) || { Ref: explicit.Sender }
    : null;

  const contactMap = new Map();
  for (const sender of counterparties) {
    if (!sender?.Ref) continue;
    const contacts = await getSenderContacts(sender.Ref);
    contactMap.set(sender.Ref, contacts);
    if (!chosenSender && explicit.SendersPhone && pickByPhone(contacts, explicit.SendersPhone)) {
      chosenSender = sender;
      break;
    }
  }
  if (!chosenSender) chosenSender = counterparties[0];

  const contacts = contactMap.get(chosenSender.Ref) || await getSenderContacts(chosenSender.Ref);
  const addresses = await getSenderAddresses(chosenSender.Ref);
  const contact = explicit.ContactSender
    ? contacts.find(x => x.Ref === explicit.ContactSender) || { Ref: explicit.ContactSender }
    : pickByPhone(contacts, explicit.SendersPhone) || contacts[0] || null;
  const address = explicit.SenderAddress
    ? addresses.find(x => x.Ref === explicit.SenderAddress) || { Ref: explicit.SenderAddress }
    : addresses[0] || null;

  const senderCityName = env('NP_SENDER_CITY_NAME') || env('NP_SENDER_CITY');
  const senderWarehouseQuery = env('NP_SENDER_WAREHOUSE') || env('NP_SENDER_WAREHOUSE_NUMBER') || env('NP_SENDER_POSTOMAT') || env('NP_SENDER_POSTOMAT_NUMBER');
  const namedCity = senderCityName ? await resolveCity(senderCityName) : null;
  const autoCityRef = explicit.CitySender || namedCity?.ref || pickCityRef(address, chosenSender) || await resolveSenderCityFromText(address, chosenSender);
  const namedWarehouse = senderWarehouseQuery ? await resolveWarehouse(autoCityRef, senderWarehouseQuery) : null;
  const fallbackWarehouse = explicit.SenderAddress || namedWarehouse?.ref || pickWarehouseRef(address) ? null : await pickFirstWarehouseInCity(autoCityRef);
  const cfg = {
    CitySender: autoCityRef,
    Sender: explicit.Sender || chosenSender.Ref || '',
    SenderAddress: explicit.SenderAddress || namedWarehouse?.ref || pickWarehouseRef(address) || pickWarehouseRef(fallbackWarehouse),
    ContactSender: explicit.ContactSender || contact?.Ref || '',
    SendersPhone: explicit.SendersPhone || normalizePhone(contact?.Phones || contact?.Phone || chosenSender.Phone || chosenSender.Phones),
  };
  const missing = Object.entries(cfg).filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) {
    throw new NovaPoshtaError('Nova Poshta sender config could not be auto-detected', {
      missing,
      hint: 'In Nova Poshta cabinet add a sender warehouse/address, or set NP_SENDER_CITY_REF and NP_SENDER_ADDRESS_REF manually.',
      sender: chosenSender?.Description || chosenSender?.Ref || null,
      addressesFound: addresses.length,
      contactsFound: contacts.length,
    });
  }
  senderConfigCache = cfg;
  return cfg;
}

async function resolveCity(cityName) {
  const query = normalizeCityQuery(cityName);
  if (!query) throw new NovaPoshtaError('Recipient city is required');
  const cacheKey = query.toLowerCase();
  const cached = cacheGet(cityCache, cacheKey);
  if (cached) return cached;

  const searched = await callNovaPoshta('Address', 'searchSettlements', { CityName: query, Limit: 10, Page: 1 });
  const addresses = searched.data?.[0]?.Addresses || [];
  const match = addresses.find(x => x.DeliveryCity || x.Ref) || null;
  if (match) {
    return cacheSet(cityCache, cacheKey, {
      ref: match.DeliveryCity || match.Ref,
      settlementRef: match.Ref || null,
      description: match.Present || match.MainDescription || query,
      raw: match,
    });
  }

  const cities = await callNovaPoshta('Address', 'getCities', { FindByString: query, Limit: 10 });
  const city = cities.data?.[0] || null;
  if (!city?.Ref) throw new NovaPoshtaError('Nova Poshta city was not found', { city: query, originalCity: cityName });
  return cacheSet(cityCache, cacheKey, { ref: city.Ref, settlementRef: city.SettlementRef || null, description: city.Description || query, raw: city });
}

function filterWarehousesByCategory(warehouses = [], category = '') {
  const expected = String(category || '').trim().toLowerCase();
  if (!expected) return warehouses;
  return warehouses.filter(warehouse => String(warehouse.CategoryOfWarehouse || '').trim().toLowerCase() === expected);
}

async function resolveWarehouse(cityRef, warehouseQuery, options = {}) {
  const normalized = normalizeWarehouseQuery(warehouseQuery);
  const query = normalized.search;
  if (!cityRef) throw new NovaPoshtaError('Recipient city ref is required');
  if (!query) throw new NovaPoshtaError('Recipient warehouse is required');
  const category = String(options.category || '').trim();
  const cacheKey = `${cityRef}:${category.toLowerCase()}:${query.toLowerCase()}`;
  const cached = cacheGet(warehouseCache, cacheKey);
  if (cached) return cached;

  const digits = normalized.number || query.match(/\d+/)?.[0] || '';
  const attempts = [...new Set([query, normalized.raw, digits].filter(Boolean))];
  let list = [];
  for (const search of attempts) {
    const result = await callNovaPoshta('Address', 'getWarehouses', {
      CityRef: cityRef,
      FindByString: search,
      Limit: 50,
      Page: 1,
    });
    list = filterWarehousesByCategory(result.data || [], category);
    if (list.length) break;
  }
  if (!list.length && digits) {
    const result = await callNovaPoshta('Address', 'getWarehouses', {
      CityRef: cityRef,
      Limit: 500,
      Page: 1,
    });
    list = filterWarehousesByCategory(result.data || [], category);
  }
  const exact = list.find(w => digits && String(w.Number) === digits);
  const byDescription = list.find(w => digits && new RegExp(`(?:№|N|номер|відділення|отделение)?\\s*${digits}\\b`, 'i').test(`${w.Description || ''} ${w.ShortAddress || ''}`));
  const fallback = list.length === 1 ? list[0] : null;
  const warehouse = exact || byDescription || fallback;
  if (!warehouse?.Ref) throw new NovaPoshtaError('Nova Poshta warehouse was not found', {
    warehouse: normalized.raw || query,
    normalizedWarehouse: query,
    number: digits,
    cityRef,
    category,
    checked: list.length,
  });
  return cacheSet(warehouseCache, cacheKey, {
    ref: warehouse.Ref,
    number: warehouse.Number || digits || '',
    description: warehouse.Description || warehouse.ShortAddress || query,
    raw: warehouse,
  });
}

async function resolveSenderLocation(type, query) {
  const locationType = String(type || '').trim().toLowerCase();
  const category = locationType === 'postomat' ? 'Postomat' : locationType === 'branch' ? 'Branch' : '';
  if (!category) throw new NovaPoshtaError('Nova Poshta sender location type is invalid', { type });

  const sender = await resolveSenderConfig();
  const warehouse = await resolveWarehouse(sender.CitySender, query, { category });
  return {
    type: locationType,
    category,
    cityRef: sender.CitySender,
    ref: warehouse.ref,
    number: warehouse.number || '',
    description: warehouse.description,
    shortAddress: warehouse.raw?.ShortAddress || '',
    raw: warehouse.raw,
  };
}

async function createRecipient(order) {
  const phone = normalizePhone(order.phone);
  const fullName = order.fullName || order.name;
  const { firstName, lastName, middleName } = splitFullName(fullName);
  if (!phone || !firstName || !lastName) throw new NovaPoshtaError('Recipient name or phone is incomplete');

  const result = await callNovaPoshta('Counterparty', 'save', {
    FirstName: firstName,
    MiddleName: middleName || '',
    LastName: lastName,
    Phone: phone,
    Email: env('NP_RECIPIENT_FALLBACK_EMAIL', ''),
    CounterpartyType: 'PrivatePerson',
    CounterpartyProperty: 'Recipient',
  });
  const recipient = result.data?.[0] || null;
  const contact = recipient?.ContactPerson?.data?.[0] || recipient?.ContactPerson?.[0] || null;
  if (!recipient?.Ref || !contact?.Ref) {
    throw new NovaPoshtaError('Nova Poshta did not return recipient refs', { raw: result.data });
  }
  return {
    ref: recipient.Ref,
    contactRef: contact.Ref,
    description: recipient.Description || fullName,
    firstName,
    lastName,
    middleName,
    phone,
    raw: recipient,
  };
}

function buildSeatsOptions() {
  const width = moneyNumber(env('NP_SEAT_WIDTH_CM', '24'));
  const length = moneyNumber(env('NP_SEAT_LENGTH_CM', '34'));
  const height = moneyNumber(env('NP_SEAT_HEIGHT_CM', '14.7'));
  const weight = moneyNumber(env('NP_WEIGHT_KG', '1'));
  const volume = moneyNumber(env('NP_VOLUME_GENERAL', '0.002')) || Math.max(0.001, (width * length * height) / 1000000);
  const seat = {
    volumetricVolume: volume,
    volumetricWidth: width,
    volumetricLength: length,
    volumetricHeight: height,
    weight,
  };
  if (env('NP_PACK_ENABLED', 'true') !== 'false') {
    seat.packRef = env('NP_PACK_REF', NP_DEFAULT_PACK_REF);
  }
  return [seat];
}

function buildInternetDocumentDescription(order = {}) {
  const description = env('NP_DESCRIPTION');
  const product = String(order.product || process.env.PRODUCT_NAME || 'Order').trim();
  const size = String(order.size || '').trim();
  const parts = [description, product].filter((part, index, items) => part && items.indexOf(part) === index);
  if (size) parts.push(`size ${size}`);
  return parts.join(' | ');
}

async function createInternetDocument(order) {
  const baseSender = await resolveSenderConfig();
  const selectedSenderLocation = order?.npSenderLocation?.ref ? order.npSenderLocation : null;
  const sender = selectedSenderLocation ? {
    ...baseSender,
    CitySender: selectedSenderLocation.cityRef || baseSender.CitySender,
    SenderAddress: selectedSenderLocation.ref,
  } : baseSender;
  const city = await resolveCity(order.city || order.delivery?.city);
  const warehouse = await resolveWarehouse(city.ref, order.postOffice || order.delivery?.postOffice);
  const recipient = await createRecipient(order);
  const price = Math.max(1, moneyNumber(order.price || process.env.PRODUCT_PRICE || 0));
  const description = buildInternetDocumentDescription(order);
  const weight = moneyNumber(env('NP_WEIGHT_KG', '1')) || 1;
  const volume = moneyNumber(env('NP_VOLUME_GENERAL', '0.002')) || 0.002;
  const seats = Math.max(1, Math.round(moneyNumber(env('NP_SEATS_AMOUNT', '1')) || 1));

  const properties = {
    PayerType: env('NP_PAYER_TYPE', 'Recipient'),
    PaymentMethod: env('NP_PAYMENT_METHOD', 'Cash'),
    DateTime: todayNpDate(),
    CargoType: env('NP_CARGO_TYPE', 'Parcel'),
    VolumeGeneral: String(volume),
    Weight: String(weight),
    ServiceType: env('NP_SERVICE_TYPE', 'WarehouseWarehouse'),
    SeatsAmount: String(seats),
    Description: description,
    Cost: String(price),
    CitySender: sender.CitySender,
    Sender: sender.Sender,
    SenderAddress: sender.SenderAddress,
    ContactSender: sender.ContactSender,
    SendersPhone: sender.SendersPhone,
    CityRecipient: city.ref,
    Recipient: recipient.ref,
    RecipientAddress: warehouse.ref,
    ContactRecipient: recipient.contactRef,
    RecipientsPhone: recipient.phone,
  };

  properties.OptionsSeat = buildSeatsOptions();
  if (env('NP_COD_ENABLED', 'true') !== 'false' && price > 0) {
    properties.BackwardDeliveryData = [{
      PayerType: env('NP_COD_PAYER_TYPE', 'Recipient'),
      CargoType: 'Money',
      RedeliveryString: String(price),
    }];
  }

  const result = await callNovaPoshta('InternetDocument', 'save', properties);
  const doc = result.data?.[0] || null;
  if (!doc?.IntDocNumber) throw new NovaPoshtaError('Nova Poshta did not return TTN number', { raw: result.data });

  return {
    ttn: doc.IntDocNumber,
    ref: doc.Ref || null,
    cost: moneyNumber(doc.CostOnSite || doc.Cost),
    estimatedDeliveryDate: doc.EstimatedDeliveryDate || null,
    city,
    warehouse,
    recipient,
    raw: doc,
  };
}

function normalizeTrackingStatus(item = {}) {
  const statusText = String(item.Status || item.StatusDescription || '').toLowerCase();
  const code = String(item.StatusCode || item.StatusCodeDescription || '').trim();
  const returned = ['102', '103', '106'].includes(code) || /(повер|возврат|відмов|отказ)/i.test(statusText);
  const delivered = ['9', '10', '11'].includes(code) || /(отриман|получен|доставлен)/i.test(statusText);
  const inTransit = !returned && !delivered && /(дороз|пути|відділен|відправ|прибул|прямує|ожида)/i.test(statusText);
  return returned ? 'returned' : delivered ? 'delivered' : inTransit ? 'in_transit' : 'unknown';
}

async function trackDocuments(documents) {
  const docs = documents
    .map(item => typeof item === 'string' ? { DocumentNumber: item } : item)
    .filter(item => item?.DocumentNumber);
  if (!docs.length) return [];
  const result = await callNovaPoshta('TrackingDocument', 'getStatusDocuments', { Documents: docs.slice(0, 100) });
  return (result.data || []).map(item => ({
    number: item.Number || item.DocumentNumber || '',
    status: item.Status || '',
    statusCode: String(item.StatusCode || ''),
    normalizedStatus: normalizeTrackingStatus(item),
    city: item.CityRecipient || item.CityRecipientDescription || '',
    warehouse: item.WarehouseRecipient || item.WarehouseRecipientDescription || '',
    sentAt: item.DateCreated || '',
    receivedAt: item.ActualDeliveryDate || item.RecipientDateTime || '',
    documentCost: moneyNumber(item.DocumentCost || item.CheckWeight || 0),
    announcedPrice: moneyNumber(item.AnnouncedPrice || item.Cost || 0),
    redeliverySum: moneyNumber(item.RedeliverySum || item.AfterpaymentOnGoodsCost || 0),
    raw: item,
  }));
}

function documentPhoneText(doc = {}) {
  return [
    doc.RecipientContactPhone,
    doc.RecipientPhone,
    doc.RecipientsPhone,
    doc.PhoneRecipient,
    doc.CounterpartyRecipientPhone,
    doc.SendersPhone,
    doc.SenderContactPhone,
    doc.PhoneSender,
  ].filter(Boolean).join(' ');
}

function normalizeDocumentListItem(doc = {}) {
  const ttn = doc.IntDocNumber || doc.Number || doc.DocumentNumber || '';
  return {
    ttn,
    ref: doc.Ref || '',
    dateTime: doc.DateTime || doc.CreateTime || doc.CreationDate || doc.DateCreated || '',
    recipientName: doc.RecipientContactPerson || doc.Recipient || doc.CounterpartyRecipientDescription || '',
    recipientPhone: normalizePhone(documentPhoneText(doc)),
    senderPhone: normalizePhone(doc.SendersPhone || doc.SenderContactPhone || ''),
    status: doc.StateName || doc.Status || '',
    cost: moneyNumber(doc.Cost || doc.AnnouncedPrice || 0),
    raw: doc,
  };
}

async function getDocumentList({ dateFrom, dateTo, page = 1, getFullList = true } = {}) {
  const response = await callNovaPoshta('InternetDocument', 'getDocumentList', {
    DateTimeFrom: dateFrom || formatNpDate(dateDaysAgo(14)),
    DateTimeTo: dateTo || todayNpDate(),
    Page: String(page || 1),
    GetFullList: getFullList ? '1' : '0',
  });
  return (response.data || []).map(normalizeDocumentListItem).filter(x => x.ttn);
}

async function findDocumentsByRecipientPhone(phone, { daysBack = 14 } = {}) {
  const target = normalizePhone(phone);
  if (!target) return [];
  const docs = await getDocumentList({
    dateFrom: formatNpDate(dateDaysAgo(daysBack)),
    dateTo: todayNpDate(),
    page: 1,
    getFullList: true,
  });
  return docs.filter(doc => {
    const p = doc.recipientPhone || normalizePhone(documentPhoneText(doc.raw));
    return p && (p === target || p.endsWith(target) || target.endsWith(p));
  });
}

async function checkPossibilityCreateReturn(number) {
  const result = await callNovaPoshta('AdditionalService', 'CheckPossibilityCreateReturn', {
    Number: String(number || '').trim(),
  });
  return result.data?.[0] || null;
}

async function getReturnReasons() {
  const result = await callNovaPoshta('AdditionalService', 'getReturnReasons', {});
  return result.data || [];
}

async function getReturnReasonSubtypes(reasonRef) {
  const props = reasonRef ? { ReasonRef: reasonRef } : {};
  const result = await callNovaPoshta('AdditionalService', 'getReturnReasonsSubtypes', props);
  return result.data || [];
}

async function getDefaultReturnReason() {
  const reasonRef = env('NP_RETURN_REASON_REF');
  const subtypeRef = env('NP_RETURN_SUBTYPE_REF');
  if (reasonRef && subtypeRef) return { reasonRef, subtypeRef };

  const reasons = await getReturnReasons();
  const reason = reasonRef
    ? reasons.find(x => x.Ref === reasonRef) || { Ref: reasonRef }
    : reasons[0];
  if (!reason?.Ref) throw new NovaPoshtaError('Nova Poshta return reason was not found', { method: 'getReturnReasons' });

  const subtypes = await getReturnReasonSubtypes(reason.Ref);
  const subtype = subtypeRef
    ? subtypes.find(x => x.Ref === subtypeRef) || { Ref: subtypeRef }
    : subtypes[0];
  if (!subtype?.Ref) throw new NovaPoshtaError('Nova Poshta return reason subtype was not found', { method: 'getReturnReasonsSubtypes', reason: reason.Ref });

  return { reasonRef: reason.Ref, subtypeRef: subtype.Ref, reason, subtype };
}

function normalizeReturnOrder(item = {}) {
  return {
    ref: item.Ref || item.OrderRef || '',
    number: item.Number || item.OrderNumber || '',
    status: item.OrderStatus || item.Status || '',
    documentNumber: item.DocumentNumber || item.IntDocNumber || '',
    deliveryCost: moneyNumber(item.DeliveryCost || item.Cost || 0),
    estimatedDeliveryDate: item.EstimatedDeliveryDate || '',
    expressWaybillNumber: item.ExpressWaybillNumber || '',
    expressWaybillStatus: item.ExpressWaybillStatus || '',
    raw: item,
  };
}

async function getReturnOrdersList({ number, ref, dateFrom, dateTo, page = 1, limit = 50 } = {}) {
  const props = {
    BeginDate: dateFrom || formatNpDate(dateDaysAgo(30)),
    EndDate: dateTo || todayNpDate(),
    Page: String(page),
    Limit: String(limit),
  };
  if (number) props.Number = String(number).trim();
  if (ref) props.Ref = String(ref).trim();
  const result = await callNovaPoshta('AdditionalService', 'getReturnOrdersList', props);
  return (result.data || []).map(normalizeReturnOrder);
}

async function syncReturnOrderCost(order) {
  const query = order?.npReturnOrderNumber || order?.npReturnOrderRef || order?.ttn;
  if (!query) return null;
  const returns = await getReturnOrdersList({
    number: order.npReturnOrderNumber || order.ttn,
    ref: order.npReturnOrderRef,
  });
  const found = returns.find(x => (
    (order.npReturnOrderRef && x.ref === order.npReturnOrderRef) ||
    (order.npReturnOrderNumber && x.number === order.npReturnOrderNumber) ||
    (order.ttn && x.documentNumber === order.ttn)
  )) || returns[0] || null;
  return found;
}

async function createReturnOrder(order) {
  const ttn = String(order?.ttn || '').trim();
  if (!ttn) throw new NovaPoshtaError('Order has no TTN');
  if (order?.npReturnOrderRef || order?.npReturnOrderNumber) {
    return { duplicate: true, returnOrder: await syncReturnOrderCost(order) };
  }

  const possibility = await checkPossibilityCreateReturn(ttn);
  if (!possibility) throw new NovaPoshtaError('Nova Poshta did not return return possibility', { ttn });
  const { reasonRef, subtypeRef, reason, subtype } = await getDefaultReturnReason();
  const paymentMethod = env('NP_RETURN_PAYMENT_METHOD', env('NP_PAYMENT_METHOD', 'Cash'));
  const properties = {
    IntDocNumber: ttn,
    PaymentMethod: paymentMethod,
    Reason: reasonRef,
    SubtypeReason: subtypeRef,
    Note: env('NP_RETURN_NOTE', `Return order #${order.id || ttn}`),
    OrderType: 'orderCargoReturn',
    ReturnAddressRef: env('NP_RETURN_ADDRESS_REF', possibility.Address || possibility.Ref || env('NP_SENDER_ADDRESS_REF') || env('NP_SENDER_WAREHOUSE_REF')),
  };
  if (env('NP_RETURN_ONLY_GET_PRICING', 'false') === 'true') properties.OnlyGetPricing = '1';

  const result = await callNovaPoshta('AdditionalService', 'save', properties);
  const raw = result.data?.[0] || null;
  if (!raw) throw new NovaPoshtaError('Nova Poshta did not return return order data', { raw: result.data });
  return {
    duplicate: false,
    possibility,
    reason,
    subtype,
    returnOrder: normalizeReturnOrder(raw),
    raw,
  };
}

function configStatus() {
  const senderVars = ['NP_SENDER_CITY_REF', 'NP_SENDER_REF', 'NP_SENDER_ADDRESS_REF', 'NP_CONTACT_SENDER_REF', 'NP_SENDER_PHONE'];
  const missingSender = senderVars.filter(name => !env(name));
  return {
    apiConfigured: !!NP_API_KEY,
    senderConfigured: missingSender.length === 0,
    senderAutoDetect: !!NP_API_KEY,
    missing: [
      ...(!NP_API_KEY ? ['NOVA_POSHTA_API_KEY'] : []),
    ],
    optionalSenderMissing: missingSender,
    apiUrl: NP_API_URL,
    autoSync: env('NP_AUTO_SYNC', 'true') !== 'false',
  };
}

module.exports = {
  NovaPoshtaError,
  callNovaPoshta,
  createInternetDocument,
  resolveSenderLocation,
  createReturnOrder,
  syncReturnOrderCost,
  getReturnOrdersList,
  trackDocuments,
  getDocumentList,
  findDocumentsByRecipientPhone,
  configStatus,
  normalizePhone,
};
