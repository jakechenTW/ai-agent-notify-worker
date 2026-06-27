# Agent Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this repo immediately productive for an AI agent (Claude Code / Codex) by adding a single authoritative agent guide, an entry-point import for Claude Code, and a permission allowlist for routine commands.

**Architecture:** `AGENTS.md` is the single source of truth. `CLAUDE.md` imports it via `@AGENTS.md`. `README.md` stays human-facing with one pointer line. `.claude/settings.json` allowlists side-effect-free commands so the agent is not blocked on safe operations.

**Tech Stack:** Markdown docs, Claude Code `@`-import syntax, Claude Code `settings.json` permissions. No application code changes.

## Global Constraints

- Single source of truth: `AGENTS.md`. Do not duplicate its content into `CLAUDE.md` or `README.md`.
- Secret VALUES are never written into the repo — only how to set them.
- The allowlist excludes any command with side effects (`wrangler deploy`, `wrangler secret put`); those stay human-confirmed.
- `npm test` (`node --test`) must still pass after all changes — source code is not touched.
- Match existing repo style (ESM, `node:test`, concise Markdown like the current `README.md`).

---

### Task 1: AGENTS.md (single source of truth) + README pointer

**Files:**
- Create: `AGENTS.md`
- Modify: `README.md` (add one pointer line near the top)

**Interfaces:**
- Produces: `AGENTS.md` at repo root — the file `CLAUDE.md` will import in Task 2.

- [ ] **Step 1: Create `AGENTS.md`**

Create `AGENTS.md` with exactly this content:

```markdown
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
```

- [ ] **Step 2: Add a pointer line to `README.md`**

In `README.md`, immediately after the opening description paragraph (after the line ending "...forwards it through the Telegram Bot API."), add a blank line and this line:

```markdown
> **AI agents:** see [`AGENTS.md`](AGENTS.md) for the agent guide (architecture, conventions, ops).
```

- [ ] **Step 3: Verify nothing in the source broke**

Run: `npm test`
Expected: PASS (all existing tests still pass — no source code was changed).

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: add AGENTS.md agent guide and README pointer"
```

---

### Task 2: CLAUDE.md entry point

**Files:**
- Create: `CLAUDE.md`

**Interfaces:**
- Consumes: `AGENTS.md` from Task 1 (imported via `@AGENTS.md`).

- [ ] **Step 1: Create `CLAUDE.md`**

Create `CLAUDE.md` with exactly this content (the `@AGENTS.md` line is a Claude Code file import; keep it on its own line):

```markdown
@AGENTS.md
```

- [ ] **Step 2: Verify the import target exists**

Run: `test -f AGENTS.md && echo OK`
Expected: `OK` (confirms the `@AGENTS.md` import resolves to a real file).

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add CLAUDE.md importing AGENTS.md"
```

---

### Task 3: Permission allowlist

**Files:**
- Create: `.claude/settings.json`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Create `.claude/settings.json`**

Create `.claude/settings.json` with exactly this content (side-effect commands like `wrangler deploy` / `wrangler secret put` are intentionally NOT allowlisted):

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test)",
      "Bash(npm install)",
      "Bash(npx wrangler:*)",
      "Bash(git status)",
      "Bash(git diff:*)",
      "Bash(git log:*)"
    ]
  }
}
```

- [ ] **Step 2: Verify it is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
git add .claude/settings.json
git commit -m "chore: allowlist routine commands for agents"
```

---

## Self-Review

- **Spec coverage:** AGENTS.md (Task 1) covers what-this-is, architecture, conventions/TDD, commands, secrets/ops, external integrations, boundaries. CLAUDE.md `@AGENTS.md` (Task 2). `.claude/settings.json` allowlist with deploy excluded (Task 3). README pointer (Task 1). Verification steps present in each task. All spec deliverables mapped.
- **Placeholder scan:** No TBD/TODO; full file contents inline.
- **Type consistency:** N/A (no code interfaces); file paths consistent across tasks (`AGENTS.md` produced in Task 1, imported in Task 2).
