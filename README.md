# Telegram → Telemost stickers

Перенос стикерпаков из Telegram в стикеры Яндекс Телемоста.

Источник списка — канал [t.me/tg2tm](https://t.me/tg2tm). Каждое сообщение канала — один пак в Телемосте: первая строка это название, дальше ссылки `t.me/addstickers/...` в нужном порядке. Владелец уже уложил каждое сообщение в лимит Телемоста (не больше 150 стикеров на пак). Формат описан в `docs/bot.md`. Бот [@tg2tmbot](https://t.me/tg2tmbot) показывает этот формат и проверяет присланный пак.

Локальная копия репозитория: `D:\Telemost2Telegram`.

## Как устроено

| Путь | Что там |
| --- | --- |
| `packs/NN-slug/` | Один пак: `pack.json` (название, источник, ссылки, количество, статус и ссылка в Телемосте). Картинки `001.png`, … появляются здесь только локально и в git не хранятся. |
| `config/settings.json` | Канал-источник и лимиты бота Телемоста. |
| `config/tg2tmbot.token`, `config/bot.token` | Токены @tg2tmbot и служебного бота для скачивания. Только локально: `*.token` в `.gitignore`, в git не попадают. |
| `docs/` | Формат заявки и бот (`bot.md`), бот Телемоста, откуда брать файлы из Telegram. |
| `logs/transfer-log.md` | Ход переноса: пак, стикер, статус, ошибки. |
| `scripts/fetch_and_convert.py` | Скачивает стикеры через Bot API и делает PNG 512×512 для Телемоста. |
| `scripts/telemost_upload.mjs` | Загружает картинки в бота Телемоста через открытый Chrome. |
| `scripts/telemost_links.mjs` | Дописывает `telemost.packUrl` по сообщениям бота «Набор … сохранён». |
| `scripts/cleanup_uploaded.py` | Удаляет локальные картинки и кэш паков, уже загруженных в Телемост и получивших ссылку. |
| `scripts/channel_cleanup.py` | Удаляет из t.me/tg2tm пост-заявку пака, когда пак готов в Телемосте. Перед удалением сверяет текст поста с `pack.json`. |
| `scripts/tg2tmbot.py` | Бот @tg2tmbot: `/start`, `/status`, `/format`, `/example`, проверка пака и уведомления. |
| `scripts/chrome_cdp.mjs` | Клиент Chrome DevTools, общий для скриптов браузера. |
| `scripts/telegram_web.mjs` | Открыть чат Telegram Web и отправить текст. Разовые шаги вроде @BotFather собираются из этих вызовов. |
| `scripts/validate_packs.py` | Проверяет, что папки, картинки и `pack.json` сходятся. |

Имена каталогов и файлов только ASCII, чтобы их нормально открывал Windows.

## Как забрать обновления

```bat
cd /d D:\Telemost2Telegram
git fetch origin
git checkout cursor/repo-layout-9d8d
git pull origin cursor/repo-layout-9d8d
```

## Поля pack.json

- `title` — название пака, как в сообщении канала.
- `sourceMessage` — ссылка на это сообщение (`https://t.me/tg2tm/<id>`).
- `stickerLinks` — ссылки на наборы Telegram, по порядку.
- `stickerSets` — по каждому набору: число стикеров, сколько из них статичных, анимированных и видео, и что пропущено.
- `stickerCount` — сколько стикеров войдёт в пак Телемоста.
- `images` — по картинке: файл, эмодзи, исходный набор и позиция, тип оригинала (`static`, `animated`, `video`).
- `telemost.status` — `pending`, `uploading`, `done` или `error`. `telemost.uploaded` — сколько картинок уже принято ботом. `telemost.packUrl` — ссылка на готовый пак в Телемосте.

## Что меняется при конвертации

- Каждая картинка вписана в квадрат 512×512 на прозрачном фоне и весит не больше 512 КБ.
- Видео (`.webm`) и анимированные (`.tgs`) стикеры становятся статичными: берётся кадр из середины. Телемост принимает только JPEG и PNG.
- Последний стикер с эмодзи ©️ в наборах `*_by_TgEmojiBot` — реклама канала автора, а не персонаж. Он пропускается и записывается в `stickerSets[].skipped`.

## Картинки не в git

PNG, а также исходные `.webp`, `.tgs` и `.webm` в git не хранятся: они перечислены в `.gitignore`. Всё нужное для их восстановления записано в `pack.json`: наборы, порядок, эмодзи и пропущенные стикеры. Собрать картинки заново:

```bash
TELEGRAM_BOT_TOKEN=$(cat config/bot.token) python scripts/fetch_and_convert.py        # все паки
TELEGRAM_BOT_TOKEN=$(cat config/bot.token) python scripts/fetch_and_convert.py 03 05  # выбранные
```

Скрипт скачивает оригиналы в `.cache/originals/` и кладёт PNG рядом с `pack.json`. Поле `telemost` при этом не меняется.

После загрузки пака и появления `telemost.packUrl` локальные картинки удаляются (`python scripts/cleanup_uploaded.py`). Токены, `config/tg2tmbot-subscribers.json` и `.cache/tg2tmbot-state.json` скрипт не трогает.

## Запуск

```bash
TELEGRAM_BOT_TOKEN=$(cat config/bot.token) python scripts/fetch_and_convert.py   # все паки или номера: 01 02
node scripts/telemost_upload.mjs 01 02                                             # нужен Chrome с --remote-debugging-port=9222 и открытым Телемостом
python scripts/validate_packs.py
```
