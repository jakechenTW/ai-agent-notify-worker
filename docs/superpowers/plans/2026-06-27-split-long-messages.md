# Split Long Telegram Messages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a single notification produce Telegram text longer than 4096 characters by splitting it into multiple sequential `sendMessage` calls.

**Architecture:** Add one pure, independently testable function `splitMessage(text, entities)` to `src/index.js` that returns 1–4 chunks (each with rebased entities and an `(n/m)` marker when there is more than one). The fetch handler composes the full message as today, calls `splitMessage()`, then sends each chunk in order, stopping on the first failure.

**Tech Stack:** Cloudflare Worker (ESM), `@gramio/format` for entities, `node:test` for tests. No new dependencies.

## Global Constraints

- `TELEGRAM_LIMIT = 4096`, `MAX_MESSAGES = 4`, `PREFIX_RESERVE = 8`, per-chunk content budget `CONTENT_BUDGET = 4096 - 8 = 4088` — exact values, defined as constants in `src/index.js`.
- Entity offsets are UTF-16 code units (matches JS `String.length`/`.slice` and the Telegram API) — no unit conversion.
- A message ≤ 4096 chars returns a single chunk with **no** `(n/m)` marker — current behavior and the existing test bodies must stay byte-identical.
- Page marker is `(n/m)\n` (1-based `n`, single digit since `m ≤ 4`), prepended to each chunk; its length is added to every entity offset in that chunk.
- Content beyond `MAX_MESSAGES` chunks is dropped (truncated).
- Send chunks sequentially; on the first thrown error or non-ok response return `502 Telegram error: ...` and send no further chunks. All succeed → `200 ok`.
- TDD: write the failing test first, watch it fail, then implement. No new dependencies.
- `npm test` runs the whole suite (`node --test`).

---

### Task 1: `splitMessage()` pure function + helpers

**Files:**
- Modify: `src/index.js` (add a named export `splitMessage` and three module-scope helpers; add the constants)
- Test: `test/index.test.js` (change the import on line 3; append unit tests)

**Interfaces:**
- Consumes: nothing (pure function over a string + entity array).
- Produces: `export function splitMessage(text, entities = [])` → `Array<{ text: string, entities: Array<{ type, offset, length, ...rest }> }>`, length 1 to 4. Task 2 calls it as `splitMessage(message.text, message.entities)`.

- [ ] **Step 1: Change the test import to also pull in the named export**

In `test/index.test.js`, replace line 3:

```javascript
import worker, { splitMessage } from "../src/index.js";
```

- [ ] **Step 2: Write the failing unit tests**

Append these tests to the end of `test/index.test.js`:

```javascript
test("splitMessage returns a single chunk without a marker for short text", () => {
  const text = "short message";
  const entities = [{ type: "bold", offset: 0, length: 5 }];
  const chunks = splitMessage(text, entities);

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, text);
  assert.deepEqual(chunks[0].entities, entities);
});

test("splitMessage splits long text into capped chunks within the Telegram limit", () => {
  const text = "a".repeat(9000); // no newlines -> hard cuts at the budget edge
  const chunks = splitMessage(text, []);

  assert.equal(chunks.length, 3);
  for (let i = 0; i < chunks.length; i += 1) {
    assert.ok(chunks[i].text.length <= 4096);
    assert.match(chunks[i].text, new RegExp(`^\\(${i + 1}/3\\)\\n`));
  }
  const reconstructed = chunks
    .map((chunk) => chunk.text.replace(/^\(\d\/\d\)\n/, ""))
    .join("");
  assert.equal(reconstructed, text);
});

test("splitMessage prefers a newline boundary when one is in range", () => {
  const text = "a".repeat(4000) + "\n" + "b".repeat(4000);
  const chunks = splitMessage(text, []);

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, "(1/2)\n" + "a".repeat(4000));
  assert.equal(chunks[1].text, "(2/2)\n" + "b".repeat(4000));
});

test("splitMessage clips an entity spanning a hard cut into both chunks", () => {
  const text = "a".repeat(9000);
  const entities = [{ type: "bold", offset: 4080, length: 16 }]; // [4080,4096) spans the cut at 4088
  const chunks = splitMessage(text, entities);

  assert.deepEqual(chunks[0].entities, [{ type: "bold", offset: 4086, length: 8 }]);
  assert.deepEqual(chunks[1].entities, [{ type: "bold", offset: 6, length: 8 }]);
  assert.deepEqual(chunks[2].entities, []);
});

test("splitMessage shifts entity offsets by the marker length", () => {
  const text = "a".repeat(9000);
  const entities = [{ type: "bold", offset: 10, length: 5 }];
  const chunks = splitMessage(text, entities);

  assert.deepEqual(chunks[0].entities[0], { type: "bold", offset: 16, length: 5 });
});

test("splitMessage drops content beyond MAX_MESSAGES", () => {
  const text = "a".repeat(20000); // would need 5 hard-cut chunks, capped at 4
  const chunks = splitMessage(text, []);

  assert.equal(chunks.length, 4);
  const delivered = chunks
    .map((chunk) => chunk.text.replace(/^\(\d\/\d\)\n/, "").length)
    .reduce((sum, length) => sum + length, 0);
  assert.equal(delivered, 4 * 4088); // 16352 chars delivered; the rest is dropped
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test`
Expected: the six new `splitMessage ...` tests FAIL (the import of `splitMessage` is undefined / not a function); the existing tests still pass.

- [ ] **Step 4: Add the constants and `splitMessage` to `src/index.js`**

Add these constants directly below the existing `FIELD_LIMITS` block (after line 12, before `export default`):

```javascript
const TELEGRAM_LIMIT = 4096;
const MAX_MESSAGES = 4;
const PREFIX_RESERVE = 8;
const CONTENT_BUDGET = TELEGRAM_LIMIT - PREFIX_RESERVE;
```

Add these functions near the other helper functions at the bottom of the file (e.g. directly above `function statusIcon(status)`):

```javascript
export function splitMessage(text, entities = []) {
  if (text.length <= TELEGRAM_LIMIT) {
    return [{ text, entities }];
  }

  const ranges = [];
  let start = 0;
  while (start < text.length && ranges.length < MAX_MESSAGES) {
    const { end, nextStart } = nextRange(text, start);
    ranges.push([start, end]);
    start = nextStart;
  }

  const total = ranges.length;
  return ranges.map(([rangeStart, rangeEnd], index) => {
    const prefix = `(${index + 1}/${total})\n`;
    const chunkEntities = rebaseEntities(entities, rangeStart, rangeEnd).map(
      (entity) => ({ ...entity, offset: entity.offset + prefix.length })
    );
    return {
      text: prefix + text.slice(rangeStart, rangeEnd),
      entities: chunkEntities,
    };
  });
}

function nextRange(text, start) {
  const hardEnd = Math.min(start + CONTENT_BUDGET, text.length);
  if (hardEnd >= text.length) {
    return { end: text.length, nextStart: text.length };
  }

  const newlineIndex = text.lastIndexOf("\n", hardEnd - 1);
  if (newlineIndex > start) {
    return { end: newlineIndex, nextStart: newlineIndex + 1 };
  }

  const cut = avoidSurrogateSplit(text, hardEnd);
  return { end: cut, nextStart: cut };
}

function avoidSurrogateSplit(text, cut) {
  const previous = text.charCodeAt(cut - 1);
  if (previous >= 0xd800 && previous <= 0xdbff) {
    return cut - 1;
  }
  return cut;
}

function rebaseEntities(entities, start, end) {
  const rebased = [];
  for (const entity of entities) {
    const clippedStart = Math.max(entity.offset, start);
    const clippedEnd = Math.min(entity.offset + entity.length, end);
    if (clippedEnd <= clippedStart) {
      continue;
    }
    rebased.push({
      ...entity,
      offset: clippedStart - start,
      length: clippedEnd - clippedStart,
    });
  }
  return rebased;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all existing tests plus the six new `splitMessage ...` tests.

- [ ] **Step 6: Commit**

```bash
git add src/index.js test/index.test.js
git commit -m "feat: add splitMessage for chunking long Telegram text"
```

---

### Task 2: Wire `splitMessage` into the handler + raise the details limit

**Files:**
- Modify: `src/index.js` (`FIELD_LIMITS.details`; replace the single send with a loop over chunks)
- Test: `test/index.test.js` (append two handler-level tests)

**Interfaces:**
- Consumes: `splitMessage(text, entities)` from Task 1.
- Produces: the final HTTP behavior (`200 ok` on full success, `502 Telegram error: ...` on the first failed chunk).

- [ ] **Step 1: Write the failing handler tests**

Append these tests to the end of `test/index.test.js`:

```javascript
test("long details are sent as multiple Telegram messages within the limit", async () => {
  const calls = [];
  const restoreFetch = withFetch(async (_url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  });

  try {
    const response = await worker.fetch(
      jsonRequest({ title: "Big report", details: "a".repeat(13000) }),
      env,
      {}
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assert.ok(calls.length > 1);
    for (const body of calls) {
      assert.ok(body.text.length <= 4096);
      assert.match(body.text, /^\(\d\/\d\)\n/);
      assert.equal(body.chat_id, "telegram-chat");
      assert.equal(body.disable_web_page_preview, true);
    }
  } finally {
    restoreFetch();
  }
});

test("a failed chunk stops sending and returns 502", async () => {
  let callCount = 0;
  const restoreFetch = withFetch(async () => {
    callCount += 1;
    if (callCount === 2) {
      return new Response("rate limited", { status: 429 });
    }
    return new Response("{}", { status: 200 });
  });

  try {
    const response = await worker.fetch(
      jsonRequest({ title: "Big report", details: "a".repeat(13000) }),
      env,
      {}
    );

    assert.equal(response.status, 502);
    assert.equal(await response.text(), "Telegram error: rate limited");
    assert.equal(callCount, 2);
  } finally {
    restoreFetch();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: the two new tests FAIL — with `FIELD_LIMITS.details` at 2000 the details are truncated to a single message, so `calls.length` is 1 (first test) and `callCount` never reaches 2 (second test).

- [ ] **Step 3: Raise the details field limit**

In `src/index.js`, change the `details` entry in `FIELD_LIMITS` (currently line 11):

```javascript
  details: 15000,
```

- [ ] **Step 4: Replace the single send with a loop over chunks**

In `src/index.js`, replace this block (currently lines 42–70):

```javascript
    const payload = normalizePayload(rawPayload);
    const message = formatTelegramMessage(payload);
    let telegramResponse;
    try {
      telegramResponse = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: message.text,
            ...(message.entities?.length ? { entities: message.entities } : {}),
            disable_web_page_preview: true,
          }),
        }
      );
    } catch (error) {
      return new Response(`Telegram error: ${error.message}`, { status: 502 });
    }

    if (!telegramResponse.ok) {
      const body = await telegramResponse.text();
      return new Response(`Telegram error: ${body}`, { status: 502 });
    }

    return new Response("ok", { status: 200 });
```

with:

```javascript
    const payload = normalizePayload(rawPayload);
    const message = formatTelegramMessage(payload);
    const chunks = splitMessage(message.text, message.entities);

    for (const chunk of chunks) {
      let telegramResponse;
      try {
        telegramResponse = await fetch(
          `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              chat_id: env.TELEGRAM_CHAT_ID,
              text: chunk.text,
              ...(chunk.entities?.length ? { entities: chunk.entities } : {}),
              disable_web_page_preview: true,
            }),
          }
        );
      } catch (error) {
        return new Response(`Telegram error: ${error.message}`, { status: 502 });
      }

      if (!telegramResponse.ok) {
        const body = await telegramResponse.text();
        return new Response(`Telegram error: ${body}`, { status: 502 });
      }
    }

    return new Response("ok", { status: 200 });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all tests, including the two new handler tests and the unchanged single-message tests (the short-message body is byte-identical because `splitMessage` returns one chunk with the original text/entities).

- [ ] **Step 6: Commit**

```bash
git add src/index.js test/index.test.js
git commit -m "feat: send long notifications as multiple Telegram messages"
```

---

## Self-Review

- **Spec coverage:**
  - Raise details limit / 4-message cap → Task 2 Step 3 (`details: 15000`), Task 1 `MAX_MESSAGES` + truncation test.
  - Newline-preferred split with hard-cut fallback → Task 1 `nextRange` + "prefers a newline boundary" test.
  - Surrogate-pair guard → Task 1 `avoidSurrogateSplit`.
  - `(n/m)` markers, single message has none → Task 1 `splitMessage` prefix logic + "single chunk without a marker" / marker-regex tests.
  - Entity clip + rebase, UTF-16 units, drop zero-length → Task 1 `rebaseEntities` + spanning-entity and offset-shift tests.
  - Sequential send, stop on first failure → 502; all succeed → 200 → Task 2 loop + "failed chunk stops sending" test.
  - Constants `TELEGRAM_LIMIT/MAX_MESSAGES/PREFIX_RESERVE/CONTENT_BUDGET` → Task 1 Step 4.
- **Placeholder scan:** none — every code and test step contains complete content.
- **Type consistency:** `splitMessage(text, entities)` returns `{ text, entities }[]`; Task 2 calls `splitMessage(message.text, message.entities)` and reads `chunk.text` / `chunk.entities` — consistent. Helpers `nextRange` / `avoidSurrogateSplit` / `rebaseEntities` are named identically where defined and called.
