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
