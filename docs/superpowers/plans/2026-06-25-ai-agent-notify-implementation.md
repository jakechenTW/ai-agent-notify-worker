# AI Agent Notify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Cloudflare Worker Telegram relay and a chezmoi-managed `ai-notify` CLI for AI agent scheduled task reports.

**Architecture:** The Worker repository owns the authenticated HTTP relay and Telegram formatting. The chezmoi repository owns local installation, Vaultwarden-sourced relay key generation, and the shell CLI. The first version uses a small JSON payload with `prefix`, `tool`, `status`, `host`, `task`, `title`, and `details`, with no git metadata or agent hook templates.

**Tech Stack:** Cloudflare Workers, JavaScript modules, Node.js test runner, bash, jq, curl, chezmoi templates, Bitwarden CLI `bw` against Vaultwarden.

---

## File Structure

Worker repository: `/Users/jakechen/Documents/AI agent notify`

- Create `package.json`: Node scripts for test and optional deploy.
- Create `wrangler.toml`: Cloudflare Worker entrypoint metadata.
- Create `src/index.js`: Worker fetch handler, payload normalization, Telegram formatting, Telegram API call.
- Create `test/index.test.js`: Node test-runner coverage for status codes, formatting, and Telegram forwarding.
- Create `README.md`: deployment, secrets, curl test, and local client integration documentation.

Chezmoi repository: `/Users/jakechen/.local/share/chezmoi`

- Create `dot_local/bin/executable_ai-notify`: local CLI that reads `~/.ai-agent/.env`, builds JSON with `jq`, supports `--dry-run`, and posts to Worker.
- Create `dot_ai-agent/private_dot_env.tmpl`: private env file template using chezmoi data and Vaultwarden/Bitwarden CLI.
- Modify `.chezmoi.toml.tmpl`: prompt for AI Notify URL and optional machine name; set default Vaultwarden item/field names.
- Create `.chezmoiscripts/run_once_before_08_install-ai-notify-deps.sh.tmpl`: install/check `curl`, `jq`, and `git`; guide for `bw`.
- Create `.chezmoiscripts/run_onchange_after_test-ai-notify.sh.tmpl`: gated dry-run validation when `CHEZMOI_AI_NOTIFY_TEST=1`.

## Task 1: Worker Project Scaffold

**Files:**
- Create: `/Users/jakechen/Documents/AI agent notify/package.json`
- Create: `/Users/jakechen/Documents/AI agent notify/wrangler.toml`
- Create: `/Users/jakechen/Documents/AI agent notify/src/index.js`
- Create: `/Users/jakechen/Documents/AI agent notify/test/index.test.js`

- [ ] **Step 1: Create a minimal failing Worker test**

Create `/Users/jakechen/Documents/AI agent notify/test/index.test.js`:

```js
import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

test("non-POST requests return 405", async () => {
  const response = await worker.fetch(
    new Request("https://notify.example.test", { method: "GET" }),
    {},
    {}
  );

  assert.equal(response.status, 405);
  assert.equal(await response.text(), "Method Not Allowed");
});
```

- [ ] **Step 2: Create Node package metadata**

Create `/Users/jakechen/Documents/AI agent notify/package.json`:

```json
{
  "name": "ai-agent-notify-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/*.test.js",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "^4.0.0"
  }
}
```

- [ ] **Step 3: Run the failing test**

Run:

```bash
npm test
```

Expected: FAIL with an import/module-not-found error for `../src/index.js`.

- [ ] **Step 4: Create the minimal Worker**

Create `/Users/jakechen/Documents/AI agent notify/src/index.js`:

```js
export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    return new Response("ok", { status: 200 });
  },
};
```

- [ ] **Step 5: Add Wrangler config**

Create `/Users/jakechen/Documents/AI agent notify/wrangler.toml`:

```toml
name = "ai-agent-notify"
main = "src/index.js"
compatibility_date = "2026-06-25"
```

- [ ] **Step 6: Verify the scaffold test passes**

Run:

```bash
npm test
```

Expected: PASS with `non-POST requests return 405`.

- [ ] **Step 7: Commit Worker scaffold**

Run:

```bash
git add package.json wrangler.toml src/index.js test/index.test.js
git commit -m "feat: scaffold worker relay"
```

Expected: commit succeeds.

## Task 2: Worker Authentication, Payload Formatting, And Telegram Forwarding

**Files:**
- Modify: `/Users/jakechen/Documents/AI agent notify/src/index.js`
- Modify: `/Users/jakechen/Documents/AI agent notify/test/index.test.js`

- [ ] **Step 1: Replace tests with full Worker behavior tests**

Replace `/Users/jakechen/Documents/AI agent notify/test/index.test.js` with:

```js
import assert from "node:assert/strict";
import test from "node:test";
import worker from "../src/index.js";

const env = {
  AI_NOTIFY_KEY: "test-key",
  TELEGRAM_BOT_TOKEN: "telegram-token",
  TELEGRAM_CHAT_ID: "telegram-chat",
};

function jsonRequest(body, key = "test-key") {
  return new Request("https://notify.example.test", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function withFetch(handler) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("non-POST requests return 405", async () => {
  const response = await worker.fetch(
    new Request("https://notify.example.test", { method: "GET" }),
    env,
    {}
  );

  assert.equal(response.status, 405);
  assert.equal(await response.text(), "Method Not Allowed");
});

test("invalid bearer token returns 401", async () => {
  const response = await worker.fetch(jsonRequest({}, "wrong-key"), env, {});

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Unauthorized");
});

test("invalid JSON returns 400", async () => {
  const request = new Request("https://notify.example.test", {
    method: "POST",
    headers: {
      authorization: "Bearer test-key",
      "content-type": "application/json",
    },
    body: "{not-json",
  });

  const response = await worker.fetch(request, env, {});

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Invalid JSON");
});

test("successful request forwards formatted Telegram text", async () => {
  let telegramUrl = "";
  let telegramBody = {};
  const restoreFetch = withFetch(async (url, init) => {
    telegramUrl = String(url);
    telegramBody = JSON.parse(init.body);
    return new Response("{}", { status: 200 });
  });

  try {
    const response = await worker.fetch(
      jsonRequest({
        prefix: "AI Agent",
        tool: "codex",
        status: "ok",
        host: "jake-mac",
        task: "daily check",
        title: "All checks passed.",
        details: "Checked 4 scheduled tasks.",
      }),
      env,
      {}
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.equal(
      telegramUrl,
      "https://api.telegram.org/bottelegram-token/sendMessage"
    );
    assert.deepEqual(telegramBody, {
      chat_id: "telegram-chat",
      text: [
        "✅ AI Agent",
        "Tool: codex",
        "Host: jake-mac",
        "Task: daily check",
        "",
        "All checks passed.",
        "",
        "Checked 4 scheduled tasks.",
      ].join("\n"),
      disable_web_page_preview: true,
    });
  } finally {
    restoreFetch();
  }
});

test("empty task and details are omitted", async () => {
  let telegramBody = {};
  const restoreFetch = withFetch(async (_url, init) => {
    telegramBody = JSON.parse(init.body);
    return new Response("{}", { status: 200 });
  });

  try {
    const response = await worker.fetch(
      jsonRequest({
        status: "info",
        title: "Scheduled task finished.",
      }),
      env,
      {}
    );

    assert.equal(response.status, 200);
    assert.equal(
      telegramBody.text,
      [
        "ℹ️ AI Agent",
        "Tool: manual",
        "Host: unknown-host",
        "",
        "Scheduled task finished.",
      ].join("\n")
    );
  } finally {
    restoreFetch();
  }
});

test("telegram API failure returns 502", async () => {
  const restoreFetch = withFetch(async () => {
    return new Response("telegram broke", { status: 500 });
  });

  try {
    const response = await worker.fetch(
      jsonRequest({ title: "hello" }),
      env,
      {}
    );

    assert.equal(response.status, 502);
    assert.equal(await response.text(), "Telegram error: telegram broke");
  } finally {
    restoreFetch();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npm test
```

Expected: FAIL on authentication, invalid JSON, Telegram forwarding, or formatting because `src/index.js` is still minimal.

- [ ] **Step 3: Implement Worker behavior**

Replace `/Users/jakechen/Documents/AI agent notify/src/index.js` with:

```js
const FIELD_LIMITS = {
  prefix: 64,
  tool: 64,
  status: 32,
  host: 128,
  task: 128,
  title: 300,
  details: 2000,
};

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const auth = request.headers.get("authorization") || "";
    const expected = `Bearer ${env.AI_NOTIFY_KEY}`;

    if (auth !== expected) {
      return new Response("Unauthorized", { status: 401 });
    }

    let rawPayload;
    try {
      rawPayload = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    const payload = normalizePayload(rawPayload);
    const text = formatTelegramText(payload);
    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
      }
    );

    if (!telegramResponse.ok) {
      const body = await telegramResponse.text();
      return new Response(`Telegram error: ${body}`, { status: 502 });
    }

    return new Response("ok", { status: 200 });
  },
};

function normalizePayload(payload) {
  return {
    prefix: sanitize(payload.prefix || "AI Agent", FIELD_LIMITS.prefix),
    tool: sanitize(payload.tool || "manual", FIELD_LIMITS.tool),
    status: sanitize(payload.status || "info", FIELD_LIMITS.status),
    host: sanitize(payload.host || "unknown-host", FIELD_LIMITS.host),
    task: sanitize(payload.task || "", FIELD_LIMITS.task),
    title: sanitize(
      payload.title || "AI agent notification",
      FIELD_LIMITS.title
    ),
    details: sanitize(payload.details || "", FIELD_LIMITS.details),
  };
}

function formatTelegramText(payload) {
  const lines = [
    `${statusIcon(payload.status)} ${payload.prefix}`,
    `Tool: ${payload.tool}`,
    `Host: ${payload.host}`,
    payload.task ? `Task: ${payload.task}` : null,
    "",
    payload.title,
    payload.details ? "" : null,
    payload.details || null,
  ];

  return lines.filter((line) => line !== null).join("\n");
}

function statusIcon(status) {
  if (status === "ok" || status === "success") {
    return "✅";
  }

  if (status === "fail" || status === "error") {
    return "❌";
  }

  if (status === "warn" || status === "warning") {
    return "⚠️";
  }

  return "ℹ️";
}

function sanitize(value, maxLength) {
  return String(value).replace(/\r/g, "").slice(0, maxLength);
}
```

- [ ] **Step 4: Run Worker tests**

Run:

```bash
npm test
```

Expected: PASS for all Worker tests.

- [ ] **Step 5: Commit Worker behavior**

Run:

```bash
git add src/index.js test/index.test.js
git commit -m "feat: implement telegram relay behavior"
```

Expected: commit succeeds.

## Task 3: Worker README And Manual Verification Docs

**Files:**
- Create: `/Users/jakechen/Documents/AI agent notify/README.md`

- [ ] **Step 1: Write Worker documentation**

Create `/Users/jakechen/Documents/AI agent notify/README.md`:

````md
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

`task` and `details` are optional. Git metadata is intentionally not part of the first version.

## Worker Secrets

Set these with Wrangler:

```bash
wrangler secret put AI_NOTIFY_KEY
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_CHAT_ID
```

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
````

- [ ] **Step 2: Run tests after documentation**

Run:

```bash
npm test
```

Expected: PASS for all Worker tests.

- [ ] **Step 3: Commit README**

Run:

```bash
git add README.md
git commit -m "docs: document worker relay setup"
```

Expected: commit succeeds.

## Task 4: Chezmoi `ai-notify` CLI

**Files:**
- Create: `/Users/jakechen/.local/share/chezmoi/dot_local/bin/executable_ai-notify`

- [ ] **Step 1: Create the CLI script**

Create `/Users/jakechen/.local/share/chezmoi/dot_local/bin/executable_ai-notify`:

```bash
#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  ai-notify [OPTIONS] [TITLE]

Options:
  --tool TOOL          caller name, default: manual
  --status STATUS      ok | fail | warn | info, default: info
  --task TASK          task name or schedule name
  --title TITLE        notification title / conclusion
  --details DETAILS    optional detail text
  --dry-run            print JSON payload instead of sending
  --help               show this help text
USAGE
}

die() {
  printf 'ai-notify: %s\n' "$*" >&2
  exit 1
}

need_value() {
  local flag="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "$flag requires a value"
}

env_file="$HOME/.ai-agent/.env"

if [[ -f "$env_file" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$env_file"
  set +a
fi

tool="manual"
status="info"
task=""
title=""
details=""
dry_run=0
positional_title=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tool)
      need_value "$1" "${2:-}"
      tool="$2"
      shift 2
      ;;
    --status)
      need_value "$1" "${2:-}"
      status="$2"
      shift 2
      ;;
    --task)
      need_value "$1" "${2:-}"
      task="$2"
      shift 2
      ;;
    --title)
      need_value "$1" "${2:-}"
      title="$2"
      shift 2
      ;;
    --details)
      need_value "$1" "${2:-}"
      details="$2"
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --*)
      die "unknown option: $1"
      ;;
    *)
      if [[ -n "$positional_title" ]]; then
        die "only one positional TITLE is supported"
      fi
      positional_title="$1"
      shift
      ;;
  esac
done

if [[ -z "$title" ]]; then
  title="$positional_title"
fi

if [[ -z "$title" ]]; then
  title="AI agent notification"
fi

prefix="${AI_NOTIFY_PREFIX:-AI Agent}"
host="${AI_NOTIFY_MACHINE:-$(hostname 2>/dev/null || printf 'unknown-host')}"

command -v jq >/dev/null 2>&1 || die "missing dependency: jq"

payload="$(jq -n \
  --arg prefix "$prefix" \
  --arg tool "$tool" \
  --arg status "$status" \
  --arg host "$host" \
  --arg task "$task" \
  --arg title "$title" \
  --arg details "$details" \
  '{
    prefix: $prefix,
    tool: $tool,
    status: $status,
    host: $host,
    task: $task,
    title: $title,
    details: $details
  }')"

if [[ "$dry_run" -eq 1 ]]; then
  printf '%s\n' "$payload"
  exit 0
fi

: "${AI_NOTIFY_URL:?ai-notify: missing AI_NOTIFY_URL}"
: "${AI_NOTIFY_KEY:?ai-notify: missing AI_NOTIFY_KEY}"

command -v curl >/dev/null 2>&1 || die "missing dependency: curl"

curl -fsS -X POST "$AI_NOTIFY_URL" \
  -H "Authorization: Bearer ${AI_NOTIFY_KEY}" \
  -H "Content-Type: application/json" \
  --data "$payload" \
  >/dev/null
```

- [ ] **Step 2: Run syntax check**

Run:

```bash
bash -n dot_local/bin/executable_ai-notify
```

Expected: no output and exit code `0`.

- [ ] **Step 3: Run dry-run check from chezmoi source**

Run:

```bash
AI_NOTIFY_PREFIX="AI Agent" AI_NOTIFY_MACHINE="test-host" dot_local/bin/executable_ai-notify --dry-run --tool manual --status ok --task test "hello"
```

Expected JSON:

```json
{
  "prefix": "AI Agent",
  "tool": "manual",
  "status": "ok",
  "host": "test-host",
  "task": "test",
  "title": "hello",
  "details": ""
}
```

- [ ] **Step 4: Run missing-option error checks**

Run:

```bash
dot_local/bin/executable_ai-notify --tool
```

Expected: exits non-zero and prints:

```text
ai-notify: --tool requires a value
```

Run:

```bash
dot_local/bin/executable_ai-notify first second
```

Expected: exits non-zero and prints:

```text
ai-notify: only one positional TITLE is supported
```

- [ ] **Step 5: Commit CLI script in chezmoi repository**

Run from `/Users/jakechen/.local/share/chezmoi`:

```bash
git add dot_local/bin/executable_ai-notify
git commit -m "feat: add ai-notify CLI"
```

Expected: commit succeeds.

## Task 5: Chezmoi Vaultwarden Env Template And Dependencies

**Files:**
- Create: `/Users/jakechen/.local/share/chezmoi/dot_ai-agent/private_dot_env.tmpl`
- Modify: `/Users/jakechen/.local/share/chezmoi/.chezmoi.toml.tmpl`
- Create: `/Users/jakechen/.local/share/chezmoi/.chezmoiscripts/run_once_before_08_install-ai-notify-deps.sh.tmpl`
- Create: `/Users/jakechen/.local/share/chezmoi/.chezmoiscripts/run_onchange_after_test-ai-notify.sh.tmpl`

- [ ] **Step 1: Inspect local chezmoi Bitwarden support**

Run:

```bash
chezmoi data
```

Expected: output includes chezmoi data JSON. Use this only to confirm chezmoi is available.

Run:

```bash
chezmoi execute-template '{{ output "bw" "status" }}'
```

Expected when `bw` is available: JSON from `bw status`, such as `{"status":"unlocked"}`. If locked or logged out, the command should show the current Vaultwarden state. This confirms explicit `bw` command invocation works from templates.

- [ ] **Step 2: Update chezmoi config template**

Modify `/Users/jakechen/.local/share/chezmoi/.chezmoi.toml.tmpl` to:

```toml
{{- $name := promptStringOnce . "name" "Name" "Jake Chen"}}
{{- $email := promptStringOnce . "email" "Email address" "jakechentw@gmail.com"}}
{{- $aiNotifyURL := promptStringOnce . "ai_notify.url" "AI Notify Worker URL" ""}}
{{- $aiNotifyMachine := promptStringOnce . "ai_notify.machine" "AI Notify machine name" .chezmoi.hostname}}


[data]
name = {{ $name | quote }}
email = {{ $email | quote }}

[data.ai_notify]
url = {{ $aiNotifyURL | quote }}
prefix = "AI Agent"
machine = {{ $aiNotifyMachine | quote }}
bw_item = "AI Agent Notify"
bw_field = "relay_key"


[git]
autoCommit = true
autoPush = true
```

- [ ] **Step 3: Create env template using `bw`**

Create `/Users/jakechen/.local/share/chezmoi/dot_ai-agent/private_dot_env.tmpl`:

```tmpl
{{- $itemName := default "AI Agent Notify" .ai_notify.bw_item -}}
{{- $fieldName := default "relay_key" .ai_notify.bw_field -}}
{{- $item := output "bw" "get" "item" $itemName -}}
{{- $relayKey := "" -}}
{{- range ((fromJson $item).fields | default list) -}}
{{- if eq .name $fieldName -}}
{{- $relayKey = .value -}}
{{- end -}}
{{- end -}}
{{- if not $relayKey -}}
{{- fail (printf "Vaultwarden item %q does not contain custom field %q" $itemName $fieldName) -}}
{{- end -}}
AI_NOTIFY_URL={{ .ai_notify.url }}
AI_NOTIFY_KEY={{ $relayKey }}
AI_NOTIFY_PREFIX={{ default "AI Agent" .ai_notify.prefix }}
AI_NOTIFY_MACHINE={{ default .chezmoi.hostname .ai_notify.machine }}
```

- [ ] **Step 4: Create dependency script**

Create `/Users/jakechen/.local/share/chezmoi/.chezmoiscripts/run_once_before_08_install-ai-notify-deps.sh.tmpl`:

```bash
{{ if eq .chezmoi.os "linux" -}}
#!/usr/bin/env bash
set -euo pipefail

packages=(
  curl
  git
  jq
)

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update
  for package in "${packages[@]}"; do
    if ! dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q "install ok installed"; then
      sudo apt-get install -y "$package"
    fi
  done
elif command -v dnf >/dev/null 2>&1; then
  sudo dnf install -y "${packages[@]}"
elif command -v pacman >/dev/null 2>&1; then
  sudo pacman -S --needed "${packages[@]}"
fi

if ! command -v bw >/dev/null 2>&1; then
  echo "Bitwarden CLI 'bw' is not installed. Install and unlock it before applying AI Notify secrets." >&2
fi
{{ else if eq .chezmoi.os "darwin" -}}
#!/usr/bin/env bash
set -euo pipefail

if ! command -v brew >/dev/null 2>&1; then
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
fi

if ! command -v curl >/dev/null 2>&1; then
  brew install curl
fi

if ! command -v git >/dev/null 2>&1; then
  brew install git
fi

if ! command -v jq >/dev/null 2>&1; then
  brew install jq
fi

if ! command -v bw >/dev/null 2>&1; then
  echo "Bitwarden CLI 'bw' is not installed. Install and unlock it before applying AI Notify secrets." >&2
fi
{{ end -}}
```

- [ ] **Step 5: Create gated validation script**

Create `/Users/jakechen/.local/share/chezmoi/.chezmoiscripts/run_onchange_after_test-ai-notify.sh.tmpl`:

```bash
#!/usr/bin/env bash
set -euo pipefail

if [[ "${CHEZMOI_AI_NOTIFY_TEST:-0}" != "1" ]]; then
  exit 0
fi

if command -v ai-notify >/dev/null 2>&1; then
  ai-notify --dry-run --status ok --task chezmoi --title "ai-notify dry run"
fi
```

- [ ] **Step 6: Verify templates render**

Run from `/Users/jakechen/.local/share/chezmoi`:

```bash
chezmoi execute-template < dot_ai-agent/private_dot_env.tmpl
```

Expected when Vaultwarden is unlocked and the item exists: output contains `AI_NOTIFY_URL`, `AI_NOTIFY_KEY`, `AI_NOTIFY_PREFIX`, and `AI_NOTIFY_MACHINE`.

Expected if Vaultwarden is locked or the item/field is missing: non-zero failure with a clear `bw` or `Vaultwarden item` error.

- [ ] **Step 7: Verify generated changes without applying**

Run:

```bash
chezmoi diff
```

Expected: diff includes `~/.local/bin/ai-notify`, `~/.ai-agent/.env`, and the script additions. No Telegram bot token appears.

- [ ] **Step 8: Commit chezmoi template and dependency files**

Run from `/Users/jakechen/.local/share/chezmoi`:

```bash
git add .chezmoi.toml.tmpl dot_ai-agent/private_dot_env.tmpl .chezmoiscripts/run_once_before_08_install-ai-notify-deps.sh.tmpl .chezmoiscripts/run_onchange_after_test-ai-notify.sh.tmpl
git commit -m "feat: configure ai-notify secrets"
```

Expected: commit succeeds.

## Task 6: End-To-End Rollout Verification

**Files:**
- Modify if needed: `/Users/jakechen/Documents/AI agent notify/README.md`
- Modify if needed: `/Users/jakechen/.local/share/chezmoi/README.md`

- [ ] **Step 1: Verify Worker tests**

Run from `/Users/jakechen/Documents/AI agent notify`:

```bash
npm test
```

Expected: PASS for all Worker tests.

- [ ] **Step 2: Verify local CLI dry-run before apply**

Run from `/Users/jakechen/.local/share/chezmoi`:

```bash
AI_NOTIFY_PREFIX="AI Agent" AI_NOTIFY_MACHINE="test-host" dot_local/bin/executable_ai-notify --dry-run --status ok --task test --title "local client ready"
```

Expected JSON contains:

```json
{
  "prefix": "AI Agent",
  "tool": "manual",
  "status": "ok",
  "host": "test-host",
  "task": "test",
  "title": "local client ready",
  "details": ""
}
```

- [ ] **Step 3: Apply chezmoi when Vaultwarden is ready**

Run from any directory:

```bash
chezmoi apply
```

Expected:

- `~/.local/bin/ai-notify` exists.
- `~/.ai-agent/.env` exists.
- `~/.ai-agent/.env` contains `AI_NOTIFY_KEY` from Vaultwarden item `AI Agent Notify` field `relay_key`.
- No Telegram bot token is present in local files.

- [ ] **Step 4: Dry-run installed CLI**

Run:

```bash
ai-notify --dry-run --status ok --task test --title "local client ready"
```

Expected: JSON payload prints and no network call is made.

- [ ] **Step 5: Optional live notification**

Only after Worker deploy and secrets are configured, run:

```bash
ai-notify --status ok --task test --title "local client ready"
```

Expected: Telegram receives a message like:

```text
✅ AI Agent
Tool: manual
Host: <machine-name>
Task: test

local client ready
```

- [ ] **Step 6: Update docs if verification reveals environment-specific details**

If `chezmoi execute-template` needs a different Bitwarden helper than `output "bw" ...`, update:

- `/Users/jakechen/Documents/AI agent notify/docs/superpowers/specs/2026-06-25-ai-agent-notify-design.md`
- `/Users/jakechen/Documents/AI agent notify/README.md`
- `/Users/jakechen/.local/share/chezmoi/README.md` if user-facing bootstrap instructions need it.

Use exact wording for the verified Vaultwarden flow. Do not document untested commands as confirmed.

- [ ] **Step 7: Final git status check**

Run:

```bash
git -C "/Users/jakechen/Documents/AI agent notify" status --short
git -C "/Users/jakechen/.local/share/chezmoi" status --short
```

Expected: either both repos are clean, or only intentional documentation updates remain and are committed.
