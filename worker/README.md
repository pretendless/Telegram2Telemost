# @tg2tmbot на Cloudflare Workers

Отображаемое имя бота — Telegram2Telemost, имя пользователя — @tg2tmbot. Тексты команд и постов совпадают с `docs/bot.md`.

Адрес воркера: `https://tg2tmbot.prtndz.workers.dev`. Ход загрузки: `POST https://tg2tmbot.prtndz.workers.dev/progress`.

## Архитектура

Воркер не открывает Телемост и не гоняет браузер. Загрузка стикеров остаётся в Chrome на машине переноса.

```
Telegram  --webhook-->  POST /telegram   Worker  --sendMessage-->  чат и канал t.me/tg2tm
uploader  --Bearer-->   POST /progress   Worker  --KV-->           подписчики, статус, что уже отправлено
```

- `POST /telegram` — обновления Telegram. Заголовок `X-Telegram-Bot-Api-Secret-Token` равен секрету `WEBHOOK_SECRET`.
- `POST /progress` — ход загрузки. Заголовок `Authorization: Bearer <UPLOADER_SECRET>`. Тело: `slug`, `title`, `source`, `status` (`pending` / `uploading` / `done` / `error`), `uploaded`, `total`, `packUrl`, `error`. Можно прислать и блок `telemost` из `pack.json`.
- «Готово» подписчику и пост в канал уходят только когда `packUrl` — настоящая ссылка `http(s)`. Пока её нет, воркер лишь помнит статус. Если «готово» уже уходило без ссылки, следующее сообщение со ссылкой досылает её и тогда же публикует пост.
- Пост в канале — название и ссылка Телемоста, без `t.me/addstickers`.
- KV `BOT_KV`: `sub:<chat id>`, `state:<slug>`, `pack:<slug>`, `meta:seeded`, один ключ `queue` (приоритетные chat id и очередь запросов).
- Принятый набор пишется в `queue` одним разом. Повтор того же набора не пишет KV снова. `GET /health` KV не трогает. `/status` человека с запросом читает только `queue`, без list.
- Чат `8502935020` получает ход и ошибки даже если набор запросил кто-то другой. Один запуск пака — одно сообщение, и в нём всегда «стикер N из TOTAL». Отправка, эмодзи, «Стикер готов», ожидание, повтор, ошибка и ссылка правят его. Если правку отклонили, старое сообщение удаляется и уходит одно новое. Сбой Actions дописывает в него ошибку и ссылку на запуск. `/status` в этом чате отвечает `идёт` или `простаивает`.
- `POST /queue/claim` с `Authorization: Bearer <UPLOADER_SECRET>` забирает следующий запрос. Уже загружаемый набор не вытесняется. Приоритетные запросы идут раньше обычных, в порядке поступления. Тело `{ "release": { "id": "<id>", "status": "done" } }` только закрывает запрос и само следующий не начинает. Пока идёт текущая загрузка восьми наборов, этот метод не вызывать.

`scripts/telemost_upload.mjs` пишет ход в админ-чат напрямую. Если заданы `TG2TM_PROGRESS_URL` и `UPLOADER_SECRET`, тот же ход уходит в `POST /progress` с `adminDelivered`, чтобы `/status` видел задачу и не слал вторую карточку. Без этих переменных загрузка в Телемост продолжается.

## Локальные тесты

Из каталога `worker/`, Node 22, без Cloudflare и без токенов:

```bash
cd worker
node --test
```

или `npm test`.

## Выкладка

Нужны `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit, Workers KV Storage Edit) и `CLOUDFLARE_ACCOUNT_ID`. Токен бота в git не кладётся.

```bash
cd worker
npm install
npx wrangler kv namespace create BOT_KV
```

Идентификатор из ответа вписать в `id` секции `BOT_KV` в `wrangler.toml`. Секреты — только так:

```bash
npx wrangler secret put TG2TMBOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put UPLOADER_SECRET
npx wrangler deploy
```

`TELEGRAM_BOT_TOKEN` воркер тоже принимает, если секрет назван так. `TG2TMBOT_TOKEN` — то же значение, что в `config/tg2tmbot.token`.

Пока на машине переноса крутится `python scripts/tg2tmbot.py`, вебхук не ставить: Telegram перестанет отдавать `getUpdates`. Когда polling остановлен:

```bash
CONFIRM_STOP_POLLING=1 \
  TG2TMBOT_TOKEN=... \
  WEBHOOK_SECRET=... \
  TG2TM_WEBHOOK_URL=https://<worker>/telegram \
  node set-webhook.mjs
```

Профиль бота (имя Telegram2Telemost, описание, команды): `TG2TMBOT_TOKEN=... npm run setup-bot`.

Машина переноса сообщает ход через `scripts/telemost_upload.mjs`. Тот же адрес и секрет можно передать переменными `TG2TM_PROGRESS_URL` и `UPLOADER_SECRET`.
