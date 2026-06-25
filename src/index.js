import { bold, code, format, join } from "@gramio/format";
import { markdownToFormattable } from "@gramio/format/markdown";

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

    if (!env.AI_NOTIFY_KEY) {
      return new Response("Worker misconfigured", { status: 500 });
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

    if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
      return new Response("Invalid JSON", { status: 400 });
    }

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

function formatTelegramMessage(payload) {
  const metadata = formatTelegramMetadata(payload);

  if (!payload.details) {
    return metadata;
  }

  return format`${metadata}\n\n${formatTelegramDetails(payload)}`;
}

function formatTelegramMetadata(payload) {
  const statusLine = format`${statusIcon(payload.status)} ${bold(payload.prefix)} · ${code(payload.status)}`;
  const metadataParts = [
    payload.tool,
    payload.host,
    payload.task || null,
  ].filter(Boolean);

  return format`${statusLine}\n${join(metadataParts, " · ")}\n\n${bold(payload.title)}`;
}

function formatTelegramDetails(payload) {
  return markdownToFormattable(payload.details);
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
