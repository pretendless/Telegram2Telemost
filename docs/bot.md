# Бот @tg2tmbot и формат пака

## Ссылки

- Бот: [@tg2tmbot](https://t.me/tg2tmbot), имя TG2TM.
- Канал с образцами: [t.me/tg2tm](https://t.me/tg2tm). Каждое сообщение канала — готовый пример заявки.

## Формат: одно сообщение — один пак

```
<название пака>

https://t.me/addstickers/<набор 1>
https://t.me/addstickers/<набор 2>
…
```

- Первая строка — название пака в Телемосте.
- Дальше ссылки на наборы Telegram, по одной в строке. Порядок ссылок задаёт порядок стикеров.
- Всего не больше 150 стикеров на сообщение: столько Телемост разрешает в одном паке.

Пример из канала (в канале у «Минто» есть ещё `minto3_vk`):

```
Минто

https://t.me/addstickers/minty_vk
https://t.me/addstickers/minty2_vk
```

## Что умеет бот

| Команда | Ответ |
| --- | --- |
| `/start` | Формат пака и пример из канала с подписью «Пример (из канала)» |
| `/format` | Только правила формата |
| `/example` | Только пример |
| сообщение в формате пака | Название, число стикеров в каждом наборе и укладывается ли пак в 150 |

В Телемост бот ничего не загружает: он показывает формат и проверяет заявку. Перенос делают `scripts/fetch_and_convert.py` и `scripts/telemost_upload.mjs`.

Описание, «о боте» (short description) и список команд задаются через Bot API: `python scripts/tg2tmbot.py --setup`.

Бот отвечает, только пока запущен `python scripts/tg2tmbot.py` (long polling). Сейчас он работает на машине, где идёт перенос. Если её выключить, бот замолчит — тогда его нужно запустить где-то ещё с тем же токеном.

## Токены

Токены лежат только локально и в git не попадают (`*.token` в `.gitignore`):

- `config/tg2tmbot.token` — бот @tg2tmbot;
- `config/bot.token` — служебный бот, через который `fetch_and_convert.py` скачивает стикеры.

```bash
python scripts/tg2tmbot.py
TELEGRAM_BOT_TOKEN=$(cat config/bot.token) python scripts/fetch_and_convert.py
```

## История имени

12 октября 2026 канал ненадолго переименовали в `t.me/tg2tm_samples`, чтобы отдать имя `tg2tm` боту. BotFather отказал: «Sorry, the username must end in `bot`». Канал вернули на `t.me/tg2tm`, а бот получил имя `tg2tmbot`.
