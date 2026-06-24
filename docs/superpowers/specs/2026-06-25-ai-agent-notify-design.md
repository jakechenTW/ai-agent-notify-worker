# AI Agent Notify Design

## Overview

Build a shared notification path for AI agent scheduled task reports.

The system has two repositories with separate responsibilities:

- `/Users/jakechen/Documents/AI agent notify` is the Cloudflare Worker relay repository.
- `/Users/jakechen/.local/share/chezmoi` is the local client and dotfiles repository.

The relay receives authenticated notification payloads and sends Telegram messages. The local client installs a shared `ai-notify` CLI through chezmoi. Telegram credentials stay only in Cloudflare Worker secrets. The local machine stores only the relay URL and relay auth key, with the relay auth key sourced from Vaultwarden.

## Goals

- Provide one local command: `ai-notify`.
- Support AI agent scheduled task reports.
- Keep Telegram bot credentials off local machines.
- Use Cloudflare Worker as the central relay.
- Manage local installation through chezmoi.
- Source `AI_NOTIFY_KEY` from Vaultwarden item `AI Agent Notify`, custom field `relay_key`.
- Keep the first version simple and low-noise.

## Non-Goals

- Do not add Codex or Claude instruction templates in the first version.
- Do not send notifications for every agent stop event.
- Do not include git metadata such as project, branch, or commit.
- Do not build a chatbot.
- Do not store notification history.
- Do not require a database.
- Do not add Slack or LINE support in the first version.

## Repository Boundaries

### Worker Repository

Path:

```text
/Users/jakechen/Documents/AI agent notify
```

Files:

```text
src/
  index.js
test/
  index.test.js
package.json
wrangler.toml
README.md
```

This repository owns:

- Cloudflare Worker request handling.
- Bearer token validation.
- Payload normalization.
- Telegram message formatting.
- Telegram Bot API forwarding.
- Worker tests and deployment documentation.

This repository does not contain real secrets.

### Chezmoi Repository

Path:

```text
/Users/jakechen/.local/share/chezmoi
```

Files to add:

```text
dot_local/
  bin/
    executable_ai-notify
dot_ai-agent/
  private_dot_env.tmpl
.chezmoiscripts/
  run_once_before_08_install-ai-notify-deps.sh.tmpl
```

Optional validation script:

```text
.chezmoiscripts/
  run_onchange_after_test-ai-notify.sh.tmpl
```

This repository owns:

- Installing `~/.local/bin/ai-notify`.
- Generating `~/.ai-agent/.env`.
- Checking local dependencies.
- Providing a dry-run validation path.

The first version will not add:

- `dot_codex/AGENTS.md.tmpl`
- `dot_claude/settings.json.tmpl`

## Payload Contract

The local CLI sends JSON to the Worker:

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

Fields:

- `prefix`: notification heading. Default: `AI_NOTIFY_PREFIX`, falling back to `AI Agent`.
- `tool`: caller name. Default: `manual`.
- `status`: notification state. Default: `info`.
- `host`: machine name. Default: `AI_NOTIFY_MACHINE`, falling back to `hostname`.
- `task`: task or schedule name. Optional.
- `title`: notification conclusion. Default: `AI agent notification`.
- `details`: optional supporting detail text.

Status icons:

| Status | Icon |
|---|---|
| `ok`, `success` | success icon |
| `fail`, `error` | failure icon |
| `warn`, `warning` | warning icon |
| anything else | info icon |

Git context is intentionally excluded from the first version. If a scheduled task needs repository-specific context, it can include that text in `details`.

## CLI Interface

Command:

```bash
ai-notify [OPTIONS] [TITLE]
```

Options:

```text
--tool TOOL          caller name, default: manual
--status STATUS      ok | fail | warn | info, default: info
--task TASK          task name or schedule name
--title TITLE        notification title / conclusion
--details DETAILS    optional detail text
--dry-run            print JSON payload instead of sending
--help               show usage
```

Title resolution:

1. Use `--title` when provided.
2. Otherwise use positional `TITLE`.
3. Otherwise use `AI agent notification`.

First-version limits:

- Only one positional title is accepted.
- No stdin capture.
- No details file.
- No project, branch, or commit fields.

Examples:

```bash
ai-notify "daily check completed"
ai-notify --status ok --task "daily check" --title "All checks passed."
ai-notify --tool codex --status fail --task "repo scan" --title "Scan failed." --details "Permission denied"
ai-notify --dry-run --tool manual --status ok --task test "hello"
```

Dry-run output:

```json
{
  "prefix": "AI Agent",
  "tool": "manual",
  "status": "ok",
  "host": "jake-mac",
  "task": "test",
  "title": "hello",
  "details": ""
}
```

## Worker Behavior

The Worker accepts only authenticated JSON `POST` requests.

Request handling:

- Non-`POST` request: return `405`.
- Missing or invalid bearer token: return `401`.
- Invalid JSON: return `400`.
- Telegram API failure: return `502`.
- Success: return `200 ok`.

Telegram text format:

```text
✅ AI Agent
Tool: codex
Host: jake-mac
Task: daily check

All checks passed.

Checked 4 scheduled tasks.
```

Formatting rules:

- The heading uses `payload.prefix`, defaulting to `AI Agent`.
- `task` is omitted when empty.
- `details` is omitted when empty.
- Fields are length-limited by the Worker before formatting.
- Rich Telegram Markdown or HTML parsing is not enabled in the first version.

Worker secrets:

```text
AI_NOTIFY_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

Secrets are set with `wrangler secret put`.

## Chezmoi And Vaultwarden Behavior

Generated target file:

```text
~/.ai-agent/.env
```

Contents:

```bash
AI_NOTIFY_URL=...
AI_NOTIFY_KEY=...
AI_NOTIFY_PREFIX=AI Agent
AI_NOTIFY_MACHINE=...
```

Source rules:

- `AI_NOTIFY_URL` comes from chezmoi data: `.ai_notify.url`.
- `AI_NOTIFY_PREFIX` comes from `.ai_notify.prefix`, defaulting to `AI Agent`.
- `AI_NOTIFY_MACHINE` comes from `.ai_notify.machine`, defaulting to `.chezmoi.hostname`.
- `AI_NOTIFY_KEY` comes from Vaultwarden through Bitwarden CLI `bw`.

Vaultwarden item:

```text
Item name: AI Agent Notify
Custom field: relay_key
```

Chezmoi data shape:

```toml
[data.ai_notify]
url = "https://your-worker.workers.dev"
prefix = "AI Agent"
machine = "jake-mac"
bw_item = "AI Agent Notify"
bw_field = "relay_key"
```

The implementation should verify the most reliable chezmoi template mechanism before writing the template. Acceptable mechanisms include a native chezmoi Bitwarden helper or an explicit `bw` command invocation from the template.

The template must not:

- Commit `AI_NOTIFY_KEY` to git.
- Store `TELEGRAM_BOT_TOKEN` locally.
- Automatically log in to Vaultwarden.
- Automatically unlock Vaultwarden.

If `bw` is missing, locked, unauthenticated, or the item/field is unavailable, `chezmoi apply` should fail with a clear message.

## Local Dependency Behavior

The chezmoi dependency script should ensure:

- `curl`
- `jq`
- `git`

The script may check for `bw` and print guidance if missing. It should not configure Vaultwarden authentication automatically.

## Testing

### Worker Tests

Automated tests cover:

- Non-`POST` request returns `405`.
- Invalid bearer token returns `401`.
- Invalid JSON returns `400`.
- Telegram API failure returns `502`.
- Successful request calls Telegram `sendMessage` and returns `200`.

### Local Client Tests

Manual and scripted checks cover:

- `ai-notify --dry-run --status ok --task test --title "hello"` prints the expected JSON payload.
- Missing `AI_NOTIFY_URL` exits non-zero with a clear error.
- Missing `AI_NOTIFY_KEY` exits non-zero with a clear error.
- `chezmoi apply` creates `~/.local/bin/ai-notify`.
- `chezmoi apply` creates private `~/.ai-agent/.env`.
- End-to-end notification reaches Telegram after Worker deployment.

## Rollout Plan

1. Implement the Worker repository.
2. Run Worker tests.
3. Set Worker secrets with `wrangler secret put`.
4. Deploy the Worker.
5. Validate with a manual `curl` request.
6. Implement chezmoi local client files.
7. Ensure Vaultwarden item `AI Agent Notify` has custom field `relay_key`.
8. Run `chezmoi apply`.
9. Validate `ai-notify --dry-run`.
10. Send an end-to-end test notification:

```bash
ai-notify --status ok --task test --title "local client ready"
```

## Open Decisions

There are no open product decisions for the first implementation plan. During implementation, the only expected technical decision is which chezmoi/Vaultwarden template mechanism is most reliable in this environment.
