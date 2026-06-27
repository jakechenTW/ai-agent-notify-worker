# Split Long Telegram Messages — Design

Date: 2026-06-27

## Goal

Let a single notification produce Telegram text longer than today's effective
ceiling. The current per-field limits sum to ~2716 characters, so a message can
never approach Telegram's 4096-character `sendMessage` limit. Raise the usable
length and, when the composed message exceeds 4096, automatically split it into
multiple sequential messages.

## Decisions

- **Overall cap:** widen with a ceiling. Raise the `details` field limit and cap
  the total at **4 messages** (≈16000 characters). Content beyond 4 messages is
  truncated (dropped).
- **Split position:** prefer the nearest newline before the limit; fall back to a
  hard cut only when no newline is available.
- **Page markers:** prefix every message with `(n/m)` when there is more than one.
- **Partial failure:** send sequentially; on the first failure, stop and return
  `502` (some earlier messages may already be delivered — Telegram sends cannot
  be recalled).

## Architecture

`formatTelegramMessage()` already returns `{ text, entities }`. Add one pure,
independently testable function:

```
splitMessage(text, entities) → [{ text, entities }, ...]   // 1 to MAX_MESSAGES
```

The fetch handler composes the full message as today, calls `splitMessage()`,
then loops over the chunks calling Telegram `sendMessage` once per chunk.

### Constants

- `TELEGRAM_LIMIT = 4096` — Telegram's per-message `text` limit (UTF-16 units).
- `MAX_MESSAGES = 4` — hard cap on chunks; overflow is dropped.
- `PREFIX_RESERVE = 8` — space reserved per chunk for the `(n/m)\n` marker
  (marker is always single-digit `n`/`m` since `m ≤ 4`).
- Per-chunk content budget = `TELEGRAM_LIMIT - PREFIX_RESERVE = 4088`.

### Field limit change

`FIELD_LIMITS.details`: `2000` → `15000`. With the header (~750 chars worst
case) this keeps `header + details` under what 4 messages (~4088 each) can hold,
so the `MAX_MESSAGES` cap is a safety net that does not fire in normal use. All
other field limits are unchanged.

## `splitMessage` behavior

1. If `text.length <= TELEGRAM_LIMIT`: return a single chunk
   `[{ text, entities }]` with **no** `(n/m)` marker. This preserves current
   behavior and the existing test suite.
2. Otherwise, walk the text into chunks of at most `4088` characters:
   - Choose the cut point by searching backward from the budget edge for the
     nearest `\n`. If none exists in the window, hard-cut at the budget edge.
   - When hard-cutting, if the cut would fall between a UTF-16 surrogate pair,
     back off by one character so an emoji/astral character is never split.
3. Stop after `MAX_MESSAGES` chunks; discard any remaining text (truncation).
4. After the chunk count `m` is known, prepend `(n/m)\n` to each chunk's text
   (1-based `n`) and shift every entity offset in that chunk by the prefix
   length.

### Entity recomputation

Each chunk corresponds to a half-open range `[start, end)` of the original text.
For every entity `{ type, offset, length, ... }`:

- Entirely outside `[start, end)` → drop it.
- Overlapping `[start, end)` → clip to the range and rebase:
  `newOffset = max(offset, start) - start`,
  `newLength = min(offset + length, end) - max(offset, start)`.
  An entity spanning a cut point is clipped into both adjacent chunks so each
  message keeps its own valid formatting.
- Offsets are UTF-16 code units, matching JS `String.length`/`.slice` and the
  Telegram API convention, so no unit conversion is needed.
- Drop any entity whose clipped length is `0`.

The `(n/m)\n` prefix is plain text (no entity); adding it shifts all of the
chunk's already-rebased entity offsets by `prefixLength`.

## Send & error handling

The handler iterates chunks in order, calling `sendMessage` for each with the
chunk's `text` and `entities` (same request shape as today:
`chat_id`, `text`, optional `entities`, `disable_web_page_preview: true`). On the
first thrown error or non-ok response it returns `502 Telegram error: ...` and
does not send the remaining chunks. When all chunks succeed it returns
`200 ok`. The single-message path is unchanged.

## Testing (TDD, `test/index.test.js`)

- Short message: exactly one `sendMessage` call, no `(n/m)` marker (regression).
- Long `details`: multiple `sendMessage` calls, each `text` ≤ 4096, each starting
  with an `(n/m)` marker.
- Split prefers a newline boundary when one is available in the window.
- Entity spanning a cut point is clipped correctly and rebased in both chunks.
- The `(n/m)` prefix shifts entity offsets by the prefix length.
- Content beyond `MAX_MESSAGES` is truncated (no more than 4 calls).
- Second chunk's send fails → handler returns `502` and does not send the third.

Tests mock the global `fetch` to capture per-call request bodies.

## Out of scope

- Retry / backoff on Telegram `429` rate limits (sequential send only).
- Configurable limits via env vars (constants live in `src/index.js`).
- Re-sending or rolling back already-delivered chunks on partial failure.
- Splitting strategies other than newline-preferred (e.g. sentence/word).
