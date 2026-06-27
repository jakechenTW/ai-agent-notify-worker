import { bold, code, format, join } from "@gramio/format";
import { markdownToFormattable } from "@gramio/format/markdown";

const FIELD_LIMITS = {
  prefix: 64,
  tool: 64,
  status: 32,
  host: 128,
  task: 128,
  title: 300,
  details: 15000,
};

const TELEGRAM_LIMIT = 4096;
const MAX_MESSAGES = 4;
const PREFIX_RESERVE = 8;
const CONTENT_BUDGET = TELEGRAM_LIMIT - PREFIX_RESERVE;

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
