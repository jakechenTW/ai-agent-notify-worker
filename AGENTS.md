# AI Agent Notify Worker — Agent Guide

This is the single source of truth for AI agents (Claude Code / Codex) working
in this repo. `CLAUDE.md` imports this file; `README.md` is the human-facing doc.

## What this is

A Cloudflare Worker that relays AI agent task notifications to Telegram. It sits
in the middle of this chain:

```
local `ai-notify` client  →  this Worker  →  Telegram Bot API
```

A local client POSTs a JSON payload with a shared bearer token. The Worker
validates the token, formats a short Telegram message, and forwards it via the
Telegram Bot API.

## Architecture

All logic lives in `src/index.js` (single Worker module). Request flow:

1. Reject non-`POST` requests → `405`.
2. If `AI_NOTIFY_KEY` is not configured → `500 Worker misconfigured`.
3. Compare `Authorization` header against `Bearer <AI_NOTIFY_KEY>`; mismatch → `401 Unauthorized`.
4. Parse the body as JSON; on parse failure or non-object/array → `400 Invalid JSON`.
5. `normalizePayload()` — apply defaults for missing fields, then `sanitize()` (strip `\r`, truncate to per-field `FIELD_LIMITS`).
6. `formatTelegramMessage()` — build a status line (`statusIcon` + bold `prefix` + code `status`), a `tool · host · task` line, a bold `title`, and optional markdown `details` (rendered via `@gramio/format`).
7. Forward to `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage` with `chat_id = TELEGRAM_CHAT_ID`. On thrown error or non-ok response → `502 Telegram error: ...`.
8. Success → `200 ok`.

Key files:
- `src/index.js` — the Worker (fetch handler + formatting helpers).
- `test/index.test.js` — the full test suite (`node:test`).
- `wrangler.toml` — Worker config.

## Development conventions

- **TDD is required.** For any code change, write or update a test in
  `test/index.test.js` first and watch it fail (red), then make it pass (green),
  then refactor. Do not edit `src/` before the failing test exists.
- **Code style:** match existing code — ESM imports, `node:test`, small focused
  helper functions, no new dependencies unless necessary.
- **Run tests:** `npm test` (runs `node --test`).

## Common commands

```bash
npm test          # run the test suite
npm install       # install dependencies
npm run deploy    # deploy to Cloudflare (side effects — human-confirmed)
```

Manual end-to-end test against a deployed Worker:

```bash
curl -sS -X POST "https://your-worker.workers.dev" \
  -H "Authorization: Bearer YOUR_AI_NOTIFY_KEY" \
  -H "Content-Type: application/json" \
  --data '{
    "prefix": "AI Agent",
    "tool": "manual",
    "status": "ok",
    "host": "test-host",
    "task": "manual relay test",
    "title": "Worker relay is ready.",
    "details": "Sent from curl."
  }'
```

## Secrets & ops

Three secrets, set with Wrangler (values are never committed to this repo):

```bash
wrangler secret put AI_NOTIFY_KEY      # shared bearer token clients must send
wrangler secret put TELEGRAM_BOT_TOKEN # Telegram bot token
wrangler secret put TELEGRAM_CHAT_ID   # destination chat id
```

Deploy with `npm run deploy` (`wrangler deploy`). Deploy and `secret put` have
side effects — run them only with human confirmation, not automatically.

## External integrations (not visible in this repo)

- **Local client `ai-notify`** is managed in the chezmoi repo at
  `/Users/jakechen/.local/share/chezmoi`.
- **Relay key** is stored in Vaultwarden — item name "AI Agent Notify", custom
  field `relay_key`.

## Boundaries / design decisions

- Git metadata is intentionally excluded from v1.
- All payload fields are optional; the Worker fills in defaults
  (`prefix` → "AI Agent", `tool` → "manual", `status` → "info",
  `host` → "unknown-host", `title` → "AI agent notification").
- `task` and `details` are omitted from the Telegram text when empty.
- Each field is truncated to a limit defined in `FIELD_LIMITS` in `src/index.js`.
