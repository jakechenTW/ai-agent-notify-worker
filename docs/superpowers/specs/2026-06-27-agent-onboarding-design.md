# Agent Onboarding — Design

Date: 2026-06-27

## Goal

Make this repo one where an AI agent (Claude Code / Codex) can be productive
immediately — across changing code, operating the Worker, and understanding how
it fits the wider notification chain. The agent should read one authoritative
file, know the conventions, and not get blocked on routine permission prompts.

## Approach

`AGENTS.md` is the single source of truth and the agent entry point. It holds
everything an agent needs. `README.md` stays human-facing. `CLAUDE.md`
references `AGENTS.md` rather than duplicating it, so there is only one file to
maintain.

## Deliverables

Four changes:

1. **`AGENTS.md`** — single source of truth, agent entry point (structure below).
2. **`CLAUDE.md`** — a single `@AGENTS.md` import line, nothing else.
3. **`.claude/settings.json`** — a permission allowlist for routine read/test
   commands so the agent is not interrupted on safe operations.
4. **`README.md`** — add one pointer line directing agents to `AGENTS.md`.

## `AGENTS.md` structure

- **What this is** — one sentence, plus the Worker's place in the chain:
  local `ai-notify` client → this Worker → Telegram Bot API.
- **Architecture** — `src/index.js` flow: validate bearer token → parse and
  validate JSON → format the Telegram message → forward to the Telegram Bot
  API. Note file responsibilities and the failure modes
  (401 / 400 / 500 / 502) already documented in the README.
- **Development conventions**
  - **TDD is required.** Write or change `test/index.test.js` first (red),
    make it pass (green), then touch `src`.
  - Code style: match the existing code (ESM, `node:test`).
  - Tests run with `npm test` (`node --test`).
- **Common commands** — `npm test`, `npm run deploy`, and the manual `curl`
  test from the README.
- **Secrets & ops** — the three secrets (`AI_NOTIFY_KEY`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`), how to set them with Wrangler, and
  the deploy flow. Actual secret values are NOT written into the repo — only how
  to set them.
- **External integrations** (not discoverable from the code)
  - local client `ai-notify` lives in the chezmoi repo
    (`/Users/jakechen/.local/share/chezmoi`).
  - relay key is stored in Vaultwarden (item "AI Agent Notify", custom field
    `relay_key`).
- **Boundaries / design decisions**
  - Git metadata is intentionally excluded from v1.
  - All payload fields are optional; the Worker fills in defaults.

## `.claude/settings.json`

Allowlist routine, side-effect-free commands. Deploy and `secret put` are
deliberately excluded so a human confirms anything with side effects.

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test)",
      "Bash(npm install)",
      "Bash(git status)",
      "Bash(git diff:*)",
      "Bash(git log:*)"
    ]
  }
}
```

## Verification

Documentation cannot be unit-tested. After the changes:

- Confirm `CLAUDE.md` uses correct `@AGENTS.md` import syntax.
- Confirm `.claude/settings.json` is valid JSON.
- Run `npm test` to confirm nothing in the source was disturbed.

## Out of scope

- Contributing guide, architecture diagrams, ADRs (over-engineering for a
  ~132-line Worker).
- Two independent maintained copies of the agent guide.
- Allowing deploy / secret commands without human confirmation.
