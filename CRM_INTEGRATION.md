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
PARTNER_CRM_SYNC_INTERVAL_MINUTES=5
PARTNER_CRM_TIMEOUT_MS=15000
```

`PARTNER_CRM_API_KEY` должен совпадать с ключом в Universal CRM. Он не должен совпадать с публично известным значением или попадать в Git/логи.

Для закрытых admin API сервера и Telegram-бота отдельно задаётся одинаковый `API_KEY`:

```env
API_KEY=<другой длинный случайный ключ>
```

После смены `API_KEY` его нужно одновременно обновить у web service и процесса Telegram-бота.
Новый ключ для этого деплоя сгенерирован локально в `.env.admin.local`; файл игнорируется Git и не должен загружаться в репозиторий.

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
- активные новые семантические дубли объединяются безопасно.

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
- `PUT|PATCH /api/integration/v1/orders/:externalId`
- `DELETE /api/integration/v1/orders/:externalId`
- `POST /api/integration/v1/orders/batch`
- `POST /api/integration/v1/reconcile`

Закрытые admin endpoints:

- `GET /api/admin/crm-sync/status`
- `GET /api/admin/crm-sync/problems`
- `POST /api/admin/crm-sync/run`
- `POST /api/admin/crm-sync/retry` (`eventId` можно не передавать, тогда возвращаются все dead-letter события).

## Причина `pull_partially_failed` от 22.07.2026

Pull зацикливался на одной повреждённой записи с `localId=573` и `externalId=3c28bc49-c68b-4fab-8ec4-9b75f5a42fb5`: отсутствовали обязательные имя, телефон и размер, а `updatedAt` был раньше `createdAt`. Universal отклонял эту одну запись, курсор пакета не двигался, поэтому число повторно получаемых заказов росло. Удалённые ранее заказы также могли импортироваться снова из-за отсутствия tombstone — так появились пары вроде `#564/#565`.

Новая версия удаляет такой локальный partner-poison из рабочего списка, сохраняет его в карантине, отправляет идемпотентное удаление партнёру и продолжает обработку остальных заказов.

## Проверка после деплоя

1. Убедиться, что `GET /api/integration/v1/health` возвращает 200 с общим ключом.
2. Открыть в Telegram: **CRM → Синхронізація з іншою CRM**.
3. Нажать **Запустити звірку зараз**.
4. Проверить: `pending=0`, `failed=0`, `deadLetter=0`, `quarantine=0` после разбирательства с известной повреждённой записью.
5. Создать один тестовый заказ, изменить статус в Universal и проверить обратное обновление.
6. Удалить тестовый заказ и убедиться, что он не появляется снова при следующем cron.

Если `quarantine` не равен нулю, запись не потеряна: подробности доступны в `/api/admin/crm-sync/problems`. После исправления источника её можно отправить повторно без создания дубля.
