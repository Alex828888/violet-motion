'use strict';

const NP_API_URL = process.env.NP_API_URL || 'https://api.novaposhta.ua/v2.0/json/';
const NP_API_KEY = process.env.NOVA_POSHTA_API_KEY || process.env.NP_API_KEY || '';

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

function todayNpDate() {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${now.getFullYear()}`;
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

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), Number(process.env.NP_TIMEOUT_MS || 15000));
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
      throw new NovaPoshtaError(`Nova Poshta HTTP ${response.status}`, { status: response.status, body: text.slice(0, 1000) });
    }
    if (!payload || payload.success !== true) {
      throw new NovaPoshtaError('Nova Poshta API returned an error', {
        modelName, calledMethod,
        errors: payload?.errors || [],
        warnings: payload?.warnings || [],
        info: payload?.info || [],
        raw: payload,
      });
    }
    return payload;
  } catch (error) {
    if (error.name === 'AbortError') throw new NovaPoshtaError('Nova Poshta request timed out', { modelName, calledMethod });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
  const query = String(cityName || '').trim();
  if (!query) throw new NovaPoshtaError('Recipient city is required');

  const searched = await callNovaPoshta('Address', 'searchSettlements', { CityName: query, Limit: 10, Page: 1 });
  const addresses = searched.data?.[0]?.Addresses || [];
  const match = addresses.find(x => x.DeliveryCity || x.Ref) || null;
  if (match) {
    return {
      ref: match.DeliveryCity || match.Ref,
      settlementRef: match.Ref || null,
      description: match.Present || match.MainDescription || query,
      raw: match,
    };
  }

  const cities = await callNovaPoshta('Address', 'getCities', { FindByString: query, Limit: 10 });
  const city = cities.data?.[0] || null;
  if (!city?.Ref) throw new NovaPoshtaError('Nova Poshta city was not found', { city: query });
  return { ref: city.Ref, settlementRef: city.SettlementRef || null, description: city.Description || query, raw: city };
}

async function resolveWarehouse(cityRef, warehouseQuery) {
  const query = String(warehouseQuery || '').trim();
  if (!cityRef) throw new NovaPoshtaError('Recipient city ref is required');
  if (!query) throw new NovaPoshtaError('Recipient warehouse is required');

  const result = await callNovaPoshta('Address', 'getWarehouses', {
    CityRef: cityRef,
    FindByString: query,
    Limit: 50,
    Page: 1,
  });
  const digits = query.match(/\d+/)?.[0] || '';
  const list = result.data || [];
  const exact = list.find(w => digits && String(w.Number) === digits);
  const fallback = list[0] || null;
  const warehouse = exact || fallback;
  if (!warehouse?.Ref) throw new NovaPoshtaError('Nova Poshta warehouse was not found', { warehouse: query });
  return {
    ref: warehouse.Ref,
    number: warehouse.Number || digits || '',
    description: warehouse.Description || warehouse.ShortAddress || query,
    raw: warehouse,
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
  const width = moneyNumber(env('NP_SEAT_WIDTH_CM'));
  const length = moneyNumber(env('NP_SEAT_LENGTH_CM'));
  const height = moneyNumber(env('NP_SEAT_HEIGHT_CM'));
  const weight = moneyNumber(env('NP_WEIGHT_KG', '1'));
  if (!width || !length || !height) return null;
  return [{
    volumetricWidth: width,
    volumetricLength: length,
    volumetricHeight: height,
    weight,
  }];
}

async function createInternetDocument(order) {
  const sender = await resolveSenderConfig();
  const city = await resolveCity(order.city || order.delivery?.city);
  const warehouse = await resolveWarehouse(city.ref, order.postOffice || order.delivery?.postOffice);
  const recipient = await createRecipient(order);
  const price = Math.max(1, moneyNumber(order.price || process.env.PRODUCT_PRICE || 0));
  const description = env('NP_DESCRIPTION', order.product || process.env.PRODUCT_NAME || 'Order');
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

  const optionsSeat = buildSeatsOptions();
  if (optionsSeat) properties.OptionsSeat = optionsSeat;
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
  trackDocuments,
  configStatus,
  normalizePhone,
};
