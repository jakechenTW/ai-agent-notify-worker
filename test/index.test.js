import assert from "node:assert/strict";
import test from "node:test";
import worker, { splitMessage } from "../src/index.js";

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

test("null JSON body returns 400", async () => {
  const response = await worker.fetch(jsonRequest(null), env, {});

  assert.equal(response.status, 400);
  assert.equal(await response.text(), "Invalid JSON");
});

test("missing worker key returns 500", async () => {
  const response = await worker.fetch(
    jsonRequest({ title: "hello" }, "undefined"),
    {
      TELEGRAM_BOT_TOKEN: "telegram-token",
      TELEGRAM_CHAT_ID: "telegram-chat",
    },
    {}
  );

  assert.equal(response.status, 500);
  assert.equal(await response.text(), "Worker misconfigured");
});

test("successful request converts markdown details to Telegram entities", async () => {
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
        details: "**Checked 4 scheduled tasks.** [Open report](https://example.test/report)",
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
        "✅ AI Agent · ok",
        "codex · jake-mac · daily check",
        "",
        "All checks passed.",
        "",
        "Checked 4 scheduled tasks. Open report",
      ].join("\n"),
      entities: [
        {
          type: "bold",
          offset: 2,
          length: 8,
        },
        {
          type: "code",
          offset: 13,
          length: 2,
        },
        {
          type: "bold",
          offset: 48,
          length: 18,
        },
        {
          type: "bold",
          offset: 68,
          length: 26,
        },
        {
          type: "text_link",
          offset: 95,
          length: 11,
          url: "https://example.test/report",
        },
      ],
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
    assert.deepEqual(telegramBody, {
      chat_id: "telegram-chat",
      text: [
        "ℹ️ AI Agent · info",
        "manual · unknown-host",
        "",
        "Scheduled task finished.",
      ].join("\n"),
      entities: [
        {
          type: "bold",
          offset: 3,
          length: 8,
        },
        {
          type: "code",
          offset: 14,
          length: 4,
        },
        {
          type: "bold",
          offset: 42,
          length: 24,
        },
      ],
      disable_web_page_preview: true,
    });
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

test("telegram transport failure returns 502", async () => {
  const restoreFetch = withFetch(async () => {
    throw new Error("network unreachable");
  });

  try {
    const response = await worker.fetch(
      jsonRequest({ title: "hello" }),
      env,
      {}
    );

    assert.equal(response.status, 502);
    assert.equal(
      await response.text(),
      "Telegram error: network unreachable"
    );
  } finally {
    restoreFetch();
  }
});

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

test("splitMessage keeps text at the limit as one chunk and splits one over", () => {
  assert.equal(splitMessage("a".repeat(4096), []).length, 1);
  assert.equal(splitMessage("a".repeat(4097), []).length, 2);
});

test("splitMessage never splits a UTF-16 surrogate pair on a hard cut", () => {
  const text = "🎉".repeat(3000); // 6000 UTF-16 code units, no newline -> hard cut
  const chunks = splitMessage(text, []);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    const content = chunk.text.replace(/^\(\d\/\d\)\n/, "");
    const first = content.charCodeAt(0);
    const last = content.charCodeAt(content.length - 1);
    // no lone low surrogate at the start, no lone high surrogate at the end
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), "chunk starts mid-pair");
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), "chunk ends mid-pair");
  }
});

test("splitMessage never emits an empty chunk when a newline sits at a chunk start", () => {
  // first hard cut at 4088 (no newline in [0,4088)); next chunk starts at 4088,
  // and index 4088 is a newline -> must NOT cut at start (would be empty).
  const text = "a".repeat(4088) + "\n" + "b".repeat(4088);
  const chunks = splitMessage(text, []);
  for (const chunk of chunks) {
    const content = chunk.text.replace(/^\(\d\/\d\)\n/, "");
    assert.ok(content.length > 0, "empty chunk emitted");
  }
});
