# Интеграция Violet Motion ↔ Universal CRM

Интеграция работает напрямую между Node.js-сервером Violet Motion на Render и production bridge Universal CRM (Next.js + Supabase). Google Sheets, Google Sites и Apps Script в этом контуре не используются.

## Production-адреса

- Violet Motion API: `https://violet-motion-backend.onrender.com/api/integration/v1`
- Universal CRM bridge: `https://www.to-pcrm.com/api/integrations/violet-motion/bridge`

## Переменные Render для Violet Motion

```env
PARTNER_CRM_API_KEY=<общий длинный секретный ключ>
PARTNER_CRM_URL=https://www.to-pcrm.com/api/integrations/violet-motion/bridge
PARTNER_CRM_AUTO_SYNC=true
PARTNER_CRM_ALLOW_BACKFILL=false
PARTNER_CRM_ALLOW_INBOUND_DELETE=false
PARTNER_CRM_SYNC_INTERVAL_MINUTES=5
PARTNER_CRM_TIMEOUT_MS=15000
```

`PARTNER_CRM_API_KEY` должен совпадать с ключом в Universal CRM. Он не должен совпадать с публично известным значением или попадать в Git/логи.

`PARTNER_CRM_ALLOW_BACKFILL` по умолчанию выключен. Startup/cron сверяет и обновляет только уже связанные заказы; отсутствующие исторические строки не импортируются, не экспортируются и не удаляются автоматически. Новые события продолжают идти через обычные bridge/batch/outbox маршруты. Включать backfill можно только отдельным осознанным решением после аудита данных.

`PARTNER_CRM_ALLOW_INBOUND_DELETE` по умолчанию выключен. Universal CRM может обновлять связанные заказы, но не может удалять их в Violet Motion. Включать удаление разрешается только после отдельного согласования и production-теста tombstone-защиты.

Для закрытых admin API сервера и Telegram-бота отдельно задаётся одинаковый `API_KEY`:

```env
API_KEY=<другой длинный случайный ключ>
BOT_WEBHOOK_SECRET=<отдельный длинный случайный ключ для Telegram webhook>
POWERBANK_PANEL_PASSWORD=<отдельный пароль приватной панели>
```

После смены `API_KEY` его нужно одновременно обновить у web service и процесса Telegram-бота.
Секреты задаются только в Environment соответствующих сервисов Render и не должны загружаться в репозиторий или выводиться в логи.

## Что синхронизируется

- клиент и телефон;
- товар, вариант, размер, цвет, количество и цена;
- статус заказа и оплаты;
- доставка, город, район и отделение;
- ТТН;
- комментарий менеджера;
- создание, изменение и удаление заказа.

Системные статусы: `new`, `no_answer`, `confirmed`, `cancelled`, `shipped`, `paid`, `returned`, `completed`.

## Надёжность

- изменения сначала записываются в durable outbox;
- временно не доставленное событие повторяется с backoff;
- после 8 неудачных попыток событие переносится в dead-letter и не теряется;
- отдельное событие можно вернуть на повтор через admin API или кнопку Telegram-бота;
- частичный ответ Universal обрабатывается по каждому `eventId`, поэтому успешные события не повторяются;
- состояние перечитывается после сетевого запроса, поэтому более свежее локальное изменение не затирается;
- параллельные полные sync-запуски объединяются в один;
- удаление создаёт tombstone и не позволяет старой записи снова импортироваться;
- повреждённая запись помещается в карантин, а остальные записи продолжают pull;
- входящий PATCH обновляет только точный `localId` и никогда не создаёт заказ;
- `externalId` нельзя незаметно перепривязать к другому заказу;
- повтор PATCH с тем же `Idempotency-Key` возвращает сохранённый первый ответ без повторного обновления и Telegram-события;
- старый `updatedAt` не перезаписывает более свежую локальную запись;
- при равном `updatedAt` итоговый `confirmed`/`cancelled` из Universal повышает локальный `new`/`no_answer`, а незавершённый статус никогда не отправляется назад поверх итогового статуса Universal;
- принятый финальный PATCH заменяет старое pending/dead-letter событие этого заказа свежим outbox-снимком, поэтому потерянный ACK не может позже вернуть статус `new`;
- существующие исторические конфликты только показываются аудитом и не исправляются автоматически.

В журнал ошибки попадают время, операция, ID события, local/external ID заказа, ограниченный снимок данных заказа, HTTP-статус, код, текст ошибки и безопасно ограниченный ответ партнёра.

## API Violet Motion для Universal CRM

Авторизация поддерживается через:

```http
X-API-Key: <PARTNER_CRM_API_KEY>
```

или `Authorization: Bearer <PARTNER_CRM_API_KEY>`.

- `GET /api/integration/v1/health`
- `GET /api/integration/v1/orders?updatedSince=<ISO>&limit=200`
- `GET /api/integration/v1/orders/:id`
- `PUT /api/integration/v1/orders/:externalId` — совместимый upsert-маршрут;
- `PATCH /api/integration/v1/orders/:localId` — только обновление существующего заказа;
- `DELETE /api/integration/v1/orders/:externalId`
- `POST /api/integration/v1/orders/batch`
- `POST /api/integration/v1/reconcile`

Для PATCH Universal передаёт заголовок:

```http
Idempotency-Key: <уникальный ключ операции>
```

Входящий статус через этот PATCH может быть только `confirmed` или `cancelled`. Если `localId` не существует, API отвечает `404` и не создаёт запись:

```json
{
  "ok": false,
  "created": false,
  "error": "order_not_found"
}
```

Успешный ответ содержит значения уже сохранённой записи:

```json
{
  "ok": true,
  "created": false,
  "order": {
    "localId": "123",
    "externalId": "universal-id",
    "status": "confirmed",
    "updatedAt": "2026-07-22T13:30:00.000Z"
  }
}
```

Violet Motion хранит рабочие заказы в атомарно записываемом JSON-файле, а не в SQL-базе, поэтому SQL-миграция здесь не применяется. Уникальность `localId` и partner `externalId` проверяется на всех входящих partner API операциях PUT/PATCH/DELETE. Существующие конфликты доступны как счётчики `identityConflicts` в закрытом `/api/admin/crm-sync/status`; аудит ничего не исправляет и не удаляет.

Закрытые admin endpoints:

- `GET /api/admin/crm-sync/status`
- `GET /api/admin/crm-sync/problems`
- `POST /api/admin/crm-sync/run`
- `POST /api/admin/crm-sync/retry` (`eventId` можно не передавать, тогда возвращаются все dead-letter события).

## Причина `pull_partially_failed` от 22.07.2026

Pull зацикливался на одной повреждённой записи с `localId=573` и `externalId=3c28bc49-c68b-4fab-8ec4-9b75f5a42fb5`: отсутствовали обязательные имя, телефон и размер, а `updatedAt` был раньше `createdAt`. Universal отклонял эту одну запись, курсор пакета не двигался, поэтому число повторно получаемых заказов росло. Удалённые ранее заказы также могли импортироваться снова из-за отсутствия tombstone — так появились пары вроде `#564/#565`.

Исправленная версия изолирует повреждённую запись в карантине и продолжает обработку остальных заказов. В рамках обновления PATCH исторические записи не удаляются, не объединяются и не изменяются автоматически; backfill не запускается.

Причина рассинхронизации статусов была в старом контракте PATCH: параметр пути ошибочно трактовался как `externalId`, хотя Universal передавала `localId`. В результате целевой заказ не находился и оставался `new`; общий upsert при полном теле запроса также мог создать лишнюю запись. Теперь PATCH использует отдельный точный поиск по `localId` без ветки создания.

## Проверка после деплоя

1. Убедиться, что `GET /api/integration/v1/health` возвращает 200 с общим ключом.
2. Открыть в Telegram: **CRM → Синхронізація з іншою CRM**.
3. Нажать **Запустити звірку зараз**.
4. Проверить: `pending=0`, `failed=0`, `deadLetter=0`, `quarantine=0` после разбирательства с известной повреждённой записью.
5. Создать один тестовый заказ, изменить статус в Universal и проверить обратное обновление.
6. Удалить тестовый заказ и убедиться, что он не появляется снова при следующем cron.

Если `quarantine` не равен нулю, запись не потеряна: подробности доступны в `/api/admin/crm-sync/problems`. После исправления источника её можно отправить повторно без создания дубля.
