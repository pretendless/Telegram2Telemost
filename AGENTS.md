# Agents

Repo: pretendless/Telegram2Telemost.

## Workers

Live @tg2tmbot is the Cloudflare worker `tg2tmbot` (`worker/wrangler.toml`). Its webhook is still `https://tg2tmbot.prtndz.workers.dev/telegram` (`.github/workflows/set-webhook.yml`). It has not moved.

Do not rename `tg2tmbot`. Do not delete its KV. Do not point @tg2tmbot at another worker until a separate cutover.

Shared worker `t2t-box` (`https://t2t-box.prtndz.workers.dev`) already has `POST /tg2tm` in LetterboxdStats. @tg2tmbot stays on `tg2tmbot` until that cutover.

## KV

Binding `BOT_KV`, id `69c9d9f3572a48469a312e5914e8a233` (`worker/wrangler.toml`). The same namespace is bound on `t2t-box`. Letterboxd keys there use the `lebxd:` prefix. Do not wipe it.

## Names the live worker reads

Secrets: `TG2TMBOT_TOKEN`, `GH_DISPATCH_TOKEN`, `WEBHOOK_SECRET`, `UPLOADER_SECRET`.

Var `LOGIN_CHAT_IDS` = `8502935020,5513343655`.

`GH_DISPATCH_TOKEN` was temporarily renamed to `GHTG2TM_DISPATCH_TOKEN`. Keep that secret under the old name `GH_DISPATCH_TOKEN` on `tg2tmbot` until the webhook moves. `t2t-box` uses `TG2TM_TOKEN` and `GHTG2TM_DISPATCH_TOKEN` for the same roles.

## GitHub Actions

Secrets: `TG2TMBOT_TOKEN`, `WEBHOOK_SECRET`, `UPLOADER_SECRET`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `TELEMOST_SESSION_KEY`.

Workflows: Deploy worker (`.github/workflows/deploy-worker.yml`), Set webhook (`.github/workflows/set-webhook.yml`), Setup bot (`.github/workflows/setup-bot.yml`).

## /letterboxd

`/letterboxd` does not run the report. It sends a card to `https://t.me/lebxdbot?start=letterboxd`. Chart code stays in this repo until a later removal.
