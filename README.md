# AI Agent Notify Worker

Cloudflare Worker relay for AI agent scheduled task notifications.

Local clients call this Worker with a shared bearer token. The Worker validates the token, formats a short Telegram message, and forwards it through the Telegram Bot API.

## Payload

```json
{
  "prefix": "AI Agent",
  "tool": "codex",
  "status": "ok",
  "host": "jake-mac",
  "task": "daily check",
  "title": "All checks passed.",
  "details": "Checked 4 scheduled tasks."
}
```

All payload fields are optional. The Worker fills in defaults when fields are omitted. `task` and `details` are omitted from Telegram text when empty, and Git metadata is intentionally not part of the first version.

## Worker Secrets

Set these with Wrangler:

```bash
wrangler secret put AI_NOTIFY_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
```

## Failure Modes

- Missing `AI_NOTIFY_KEY` returns `500 Worker misconfigured`
- Malformed JSON or non-object JSON returns `400 Invalid JSON`
- Invalid bearer token returns `401 Unauthorized`

## Development

```bash
npm test
```

## Deploy

```bash
npm run deploy
```

## Manual Test

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

Expected Telegram text:

```text
✅ AI Agent
Tool: manual
Host: test-host
Task: manual relay test

Worker relay is ready.

Sent from curl.
```

## Local Client

The local `ai-notify` command is managed in the chezmoi repository at:

```text
/Users/jakechen/.local/share/chezmoi
```

The local relay key should be stored in Vaultwarden:

```text
Item name: AI Agent Notify
Custom field: relay_key
```
