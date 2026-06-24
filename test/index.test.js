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
