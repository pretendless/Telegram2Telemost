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
- `POST /progress` — ход загрузки. Заголовок `Authorization: Bearer <UPLOADER_SECRET>`. Тело: `slug`, `title`, `source`, `status` (`pending` / `uploading` / `done` / `error`), `uploaded`, `total`, `packUrl`, `error`, `requesterChatId`, `queueRequestId`. Можно прислать и блок `telemost` из `pack.json`.
- `POST /session-started` — один раз на run Actions: `runId`, `url`, `reason` (или `mode` для подписи по умолчанию).
- `GET /project/prompt?id=<prompt_id>` — текст запроса из `/project` (Bearer `UPLOADER_SECRET`). Его читают `cursor-agent.yml` и, если включён, `project-prompt.yml`.
- `POST /project/reply` — краткий ответ в админ-чат Telegram: `{ "id": "<prompt_id>", "summary": "…", "chatId"?: "…", "issueUrl"?: "…" }` (Bearer `UPLOADER_SECRET`). `cursor-agent.yml` шлёт итог сюда после Cloud Agent; сам агент может вызвать тот же путь.
- «Готово» подписчику и пост в канал уходят только когда `packUrl` — настоящая ссылка `http(s)`. Пока её нет, воркер лишь помнит статус. Если «готово» уже уходило без ссылки, следующее сообщение со ссылкой досылает её и тогда же публикует пост.
- Пост в канале — `📞` и название запроса, число стикеров, «Открыть в Телемосте», затем «из тг» и по одной `#` на исходный `t.me/addstickers` в порядке сбора. Превью ссылки выключено. Без исходных ссылок хвоста «из тг» нет. GitHub, chat id и кто запросил — не в посте.
- KV `BOT_KV`: `sub:<chat id>`, `await:<chat id>` (`{"step":"name"}` или `{"step":"links","title":"…","sets":[…]}` после `/create`; старое значение `1` — шаг названия), `state:<slug>`, `pack:<slug>`, `meta:seeded`, один ключ `queue` (приоритетные chat id и очередь запросов).
- Новый запрос: `/create`, затем название, затем стикеры из наборов и/или ссылки `t.me/addstickers/…` в любом порядке, затем `/done` (всего не больше 150 стикеров). Другая команда диалог не сбрасывает; повторный `/create` начинает с названия. Админ-чат может прислать пак одним сообщением без `/create`.
- Принятый набор пишется в `queue` одним разом. Повтор того же набора не пишет KV снова. `GET /health` KV не трогает. `/status` человека с запросом читает только `queue`, без list.
- Принятый запрос от любого пользователя попадает в `queue`. Если Actions сейчас не крутят Telemost, воркер сам запускает `telemost-session` (`mode=restart` с `main`), без `/restart`. Когда пак догружен или упал с ошибкой, воркер закрывает строку в `queue`. Обычно после этого снова dispatch, **если** нет другого активного run. В режиме **drain** (`sessionDrain: true` в `/progress`) тот же job в браузере забирает следующий пак через `POST /queue/claim` — повторный dispatch не нужен. После выхода из drain VM шлёт `POST /queue/drain-complete`; воркер dispatch только если в KV ещё есть `queued`.
- `/restart` в чатах из `LOGIN_CHAT_IDS` (`8502935020`, `5513343655`) — только если нужно **прервать** текущий run Actions и начать заново. Prepare смотрит только **queued/uploading** в KV; каталог `packs/NN-…` без активной строки не подхватывается (закрытие «призрачного» диалога). Повтор готового набора через бота не принимается; каталог вручную — `TG2TM_CATALOG_RETRY=1` на шаге prepare.
- При **старте каждого** run `telemost-session` админ получает одно сообщение с **причиной** и ссылкой на Actions. В dispatch передаётся `dispatch_reason`; workflow шлёт `POST /session-started` (дедуп по `runId` в KV). Без повторов, если run уже объявлен.
- `/queue` в админ-чате — очередь, текущая загрузка (N из M из `pack:request-<id>`), недавние `done`/`error`. Только ключ `queue` и один pack-ключ для uploading, без list KV.
- Чаты из `LOGIN_CHAT_IDS` (`8502935020`, `5513343655`) получают ход и ошибки даже если набор запросил кто-то другой. Один запуск пака — одно сообщение, и в нём всегда «стикер N из TOTAL». Отправка, эмодзи, «Стикер готов», ожидание, повтор, ошибка и ссылка правят его. Если правку отклонили, старое сообщение удаляется и уходит одно новое. Сбой Actions дописывает в него ошибку и ссылку на запуск. `/status` в этих чатах называет шаг: очередь, запуск Actions или «стикер N из M». Голое «простаивает» — только когда нет очереди и загрузки.
- Запросивший пользователь получает **одну карточку** на запрос (очередь → загрузка → N из M). В `/progress` поля `requesterChatId`, `queueRequestId`; в `pack.json` очереди — `requesterChatId`.
- `POST /queue/claim` с `Authorization: Bearer <UPLOADER_SECRET>` забирает следующий запрос. Уже загружаемый набор не вытесняется (приоритет: **догрузить текущий пак**, затем claim; новый priority не вытесняет uploading). Тело `{ "release": { "id": "<id>", "status": "done" } }` закрывает запрос вручную; в drain release идёт через terminal `/progress` как у bc-c3fb423d.
- `POST /queue/drain-complete` — конец сессии drain в VM; autostart следующего queued, если job оборвался с хвостом очереди.

`scripts/telemost_upload.mjs` пишет ход в админ-чат напрямую. Если заданы `TG2TM_PROGRESS_URL` и `UPLOADER_SECRET`, тот же ход уходит в `POST /progress` с `adminDelivered`, чтобы `/status` видел задачу и не слал вторую карточку. Без этих переменных загрузка в Телемост продолжается.

В режиме drain VM перед загрузкой вызывает `scripts/fetch_and_convert.py` (статичные WEBP через Pillow, анимированные `.tgs` через `rlottie-python`). Видео WEBM не конвертируется: для кадра нужен ffmpeg, его нет в образе и в шаге Actions. Образ `tg2tm-browser` ставит `python3`, `python3-pil` и pip-зависимости из `scripts/requirements-fetch.txt`; на runner Actions то же перед fetch в шагах upload/restart.

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

`CURSOR_API_KEY` в этом дизайне — секрет **GitHub Actions**, не секрет воркера. `/project` только делает `workflow_dispatch` на `cursor-agent.yml`. Команда `npx wrangler secret put CURSOR_API_KEY` нужна лишь если сам воркер начнёт звонить в Cursor API. Пока этого нет, ключ в Cloudflare не кладите и в `wrangler.toml` `[vars]` не пишите.

Пока на машине переноса крутится `python scripts/tg2tmbot.py`, вебхук не ставить: Telegram перестанет отдавать `getUpdates`. Когда polling остановлен:

```bash
CONFIRM_STOP_POLLING=1 \
  TG2TMBOT_TOKEN=... \
  WEBHOOK_SECRET=... \
  TG2TM_WEBHOOK_URL=https://<worker>/telegram \
  node set-webhook.mjs
```

### Доступ к api.telegram.org с корпоративной машины

Скрипты `setup-bot.mjs` и `set-webhook.mjs` ходят в Bot API через `telegram_fetch.mjs`. Если `PROXY_HOST` не задан (как на GitHub Actions), используется обычный `fetch`.

Локально, когда `api.telegram.org` доступен только через прокси (тот же формат, что в `vm/proxy.mjs` и секрете `PROXY_HOST`):

```bash
export PROXY_HOST=proxy.example.com:50100
export PROXY_LOGIN=...
export PROXY_PASSWORD=...
TG2TMBOT_TOKEN=... npm run setup-bot
```

Альтернатива без `PROXY_HOST`: стандартные переменные окружения Node и undici:

```bash
export NODE_USE_ENV_PROXY=1
export HTTPS_PROXY=http://user:pass@proxy.example.com:50100
TG2TMBOT_TOKEN=... npm run setup-bot
```

### Профиль бота и команды

Локально: `TG2TMBOT_TOKEN=... npm run setup-bot`. Опционально `LOGIN_CHAT_IDS=8502935020,5513343655` — те же id, что у воркера: для них в меню появятся админ-команды (`/queue`, `/skip`, `/login`, …). Если переменная короче списка в `wrangler.toml`, скрипт всё равно ставит меню на оба id. См. `docs/bot.md`.

С корпоративного ПК, где Telegram недоступен, проще запустить workflow **Setup bot** в GitHub Actions (`workflow_dispatch`): runner достаёт `api.telegram.org` напрямую, секрет `TG2TMBOT_TOKEN`, переменная репозитория `LOGIN_CHAT_IDS` (если пуста — `8502935020,5513343655`, как в `wrangler.toml`).

**Setup bot** не регистрирует webhook — только описание, короткий текст и команды. Видимое имя бота задаётся вручную в BotFather, не этим workflow.

### Бот молчит на команды

1. Запустите workflow **Check bot** — в логе: username, URL webhook, `pending_update_count`, последняя ошибка webhook.
2. Если webhook пустой или неверный: остановите polling на машине переноса (`python scripts/tg2tmbot.py`), затем workflow **Set webhook** (нужны секреты `TG2TMBOT_TOKEN` и `WEBHOOK_SECRET`, тот же `WEBHOOK_SECRET`, что на воркере).
3. Код обработчика на Worker обновляется отдельно: `cd worker && npx wrangler deploy` (не через Actions).

Машина переноса сообщает ход через `scripts/telemost_upload.mjs`. Тот же адрес и секрет можно передать переменными `TG2TM_PROGRESS_URL` и `UPLOADER_SECRET`.
