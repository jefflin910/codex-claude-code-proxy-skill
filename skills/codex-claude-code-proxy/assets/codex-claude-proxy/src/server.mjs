import http from "node:http";
import { AuthError, readCodexAuth, requireLocalBearer } from "./auth.mjs";
import { buildLimitedResponsesPayload } from "./context-limit.mjs";
import { collectCodexResponses, createCodexResponsesStream, UpstreamError } from "./codex-upstream.mjs";
import { readConfig, printHelp, ConfigError, resolveModelMapping } from "./config.mjs";
import {
  convertCollectedResponsesEvents,
  streamResponsesAsAnthropic,
} from "./responses-to-anthropic.mjs";
import { estimateAnthropicInputTokens } from "./token-count.mjs";
import { encodeSse } from "./sse.mjs";

const MAX_BODY_BYTES = 50 * 1024 * 1024;

if (import.meta.url === `file://${process.argv[1]}`) {
  const wantsHelp = process.argv.includes("--help") || process.argv.includes("-h");
  if (wantsHelp) {
    printHelp();
    process.exit(0);
  }

  try {
    const config = readConfig();
    startServer(config);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(2);
    }
    throw error;
  }
}

export function startServer(config) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res, config).catch((error) => {
      writeError(res, error);
    });
  });

  server.listen(config.port, config.host, () => {
    console.log(
      `codex-claude-proxy listening on http://${config.host}:${config.port} model=${config.upstreamModel}`,
    );
  });

  return server;
}

async function handleRequest(req, res, config) {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  try {
    requireLocalBearer(toFetchLikeRequest(req), config.localGatewayToken);

    if (req.method === "GET" && url.pathname === "/health") {
      const auth = await readCodexAuth(config.authPath);
      return writeJson(res, 200, {
        ok: true,
        upstream_model: config.upstreamModel,
        claude_model: config.claudeModel,
        model_mappings: config.modelMappings.map((mapping) => ({
          id: mapping.id,
          display_name: mapping.displayName,
          actual_model: mapping.upstreamModel,
          reasoning_effort: mapping.reasoningEffort,
        })),
        auth: {
          expires_at: auth.expiresAt,
          seconds_left: auth.secondsLeft,
        },
      });
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      return writeJson(res, 200, modelsResponse(config));
    }

    if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      const body = await readJson(req);
      return writeJson(res, 200, {
        input_tokens: estimateAnthropicInputTokens(body),
      });
    }

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const body = await readJson(req);
      await handleMessages(res, body, config);
      return;
    }

    writeJson(res, 404, {
      type: "error",
      error: {
        type: "not_found_error",
        message: "Route not found.",
      },
    });
  } finally {
    if (config.logRequests) {
      const ms = Date.now() - started;
      console.log(`${req.method} ${url.pathname} -> ${res.statusCode || 200} ${ms}ms`);
    }
  }
}

function toFetchLikeRequest(req) {
  return {
    headers: {
      get(name) {
        const value = req.headers[name.toLowerCase()];
        if (Array.isArray(value)) return value.join(", ");
        return value || null;
      },
    },
  };
}

async function handleMessages(res, body, config) {
  const modelMapping = resolveModelMapping(body.model, config);
  const { payload: responsesPayload, stats: contextStats } = buildLimitedResponsesPayload(body, {
    upstreamModel: modelMapping.upstreamModel,
    reasoningEffort: modelMapping.reasoningEffort,
    maxBytes: config.upstreamMaxInputBytes,
  });
  logContextTrim(contextStats, config);
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), config.upstreamTimeoutMs);
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  try {
    if (body.stream) {
      writeSseHeaders(res);
      const writer = responseWriter(res);
      writeAnthropicSse(res, "message_start", makeImmediateMessageStart(modelMapping.id));
      let contentStarted = false;
      const pingInterval = setInterval(() => {
        if (!res.writableEnded) {
          writeAnthropicSse(res, "ping", { type: "ping" });
        }
      }, 10000);
      try {
        await runWithUpstreamRetries(
          config,
          abort.signal,
          "stream",
          () => contentStarted,
          async () => {
            const upstreamEvents = await createCodexResponsesStream(responsesPayload, config, {
              signal: abort.signal,
            });
            await streamResponsesAsAnthropic(upstreamEvents, writer, modelMapping.id, {
              sendMessageStart: false,
              onAnthropicEvent(event) {
                if (event.startsWith("content_block_")) contentStarted = true;
              },
            });
            res.end();
          },
        );
      } catch (error) {
        const normalizedError = normalizeUpstreamRuntimeError(error, abort.signal);
        logProxyError(normalizedError, config);
        if (!res.writableEnded) {
          res.write(encodeSse("error", anthropicErrorPayload(normalizedError)));
          res.end();
        }
      } finally {
        clearInterval(pingInterval);
      }
      return;
    }

    try {
      const events = await runWithUpstreamRetries(
        config,
        abort.signal,
        "nonstream",
        () => false,
        () =>
          collectCodexResponses(responsesPayload, config, {
            signal: abort.signal,
          }),
      );
      const message = convertCollectedResponsesEvents(events, modelMapping.id);
      writeJson(res, 200, message);
    } catch (error) {
      const normalizedError = normalizeUpstreamRuntimeError(error, abort.signal);
      logProxyError(normalizedError, config);
      throw normalizedError;
    }
  } finally {
    clearTimeout(timeout);
  }
}

function modelsResponse(config) {
  const models = config.modelMappings.map((mapping) => ({
    type: "model",
    id: mapping.id,
    display_name: mapping.displayName,
    created_at: "2026-05-26T00:00:00Z",
  }));
  return {
    data: models,
    first_id: models[0]?.id || config.claudeModel,
    last_id: models.at(-1)?.id || config.claudeModel,
    has_more: false,
  };
}

function responseWriter(res) {
  return {
    write(chunk) {
      return res.write(chunk);
    },
  };
}

function writeAnthropicSse(res, event, data) {
  res.write(encodeSse(event, data));
}

function makeImmediateMessageStart(model) {
  return {
    type: "message_start",
    message: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  };
}

function writeSseHeaders(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body is not valid JSON.");
    error.status = 400;
    throw error;
  }
}

async function readBody(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(data));
}

function writeError(res, error) {
  // The top-level handler has no config. Route-level upstream errors are logged
  // before they reach here.
  if (res.headersSent) {
    res.end();
    return;
  }

  const status = error.status || 500;
  writeJson(res, status, anthropicErrorPayload(error));
}

function anthropicErrorPayload(error) {
  let type = "api_error";
  if (error instanceof AuthError || error.status === 401) type = "authentication_error";
  else if (error instanceof UpstreamError) type = "api_error";
  else if (error.status === 400) type = "invalid_request_error";

  return {
    type: "error",
    error: {
      type,
      message: safeErrorMessage(error),
    },
  };
}

function safeErrorMessage(error) {
  if (error instanceof UpstreamError) {
    return `${error.message}.`;
  }
  return error?.message || "Unexpected proxy error.";
}

function normalizeUpstreamRuntimeError(error, signal) {
  if (error instanceof UpstreamError) return error;

  const message = String(error?.message || "");
  if (signal?.aborted || error?.name === "AbortError") {
    return new UpstreamError("Codex upstream request timed out or was aborted", 504);
  }

  if (error?.name === "TypeError" && /terminated|aborted|fetch failed/i.test(message)) {
    return new UpstreamError(`Codex upstream stream terminated: ${message}`, 502);
  }

  return error;
}

async function runWithUpstreamRetries(config, signal, mode, hasStartedOutput, operation) {
  const maxAttempts = Math.max(1, Number(config.upstreamRetries || 0) + 1);
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const normalizedError = normalizeUpstreamRuntimeError(error, signal);
      lastError = normalizedError;
      if (
        attempt >= maxAttempts ||
        hasStartedOutput?.() ||
        !isRetryableUpstreamError(normalizedError)
      ) {
        throw normalizedError;
      }
      logUpstreamRetry(normalizedError, config, {
        attempt,
        maxAttempts,
        mode,
      });
      await delay(Math.min(1000 * attempt, 3000));
    }
  }

  throw lastError;
}

function isRetryableUpstreamError(error) {
  if (error?.status === 504) return true;
  if (error?.status !== 502) return false;
  return /fetch failed|stream terminated|terminated|returned HTTP 503/i.test(
    String(error?.message || ""),
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logProxyError(error, config) {
  if (!config.logErrors) return;
  const parts = [
    "proxy_error",
    `name=${error?.name || "Error"}`,
    `status=${error?.status || 500}`,
    `message=${singleLine(error?.message || "Unexpected proxy error.")}`,
  ];
  if (error?.details) {
    parts.push(`details=${singleLine(error.details).slice(0, 500)}`);
  }
  console.error(parts.join(" "));
}

function logUpstreamRetry(error, config, { attempt, maxAttempts, mode }) {
  if (!config.logErrors) return;
  console.error(
    [
      "upstream_retry",
      `mode=${mode}`,
      `attempt=${attempt}`,
      `max_attempts=${maxAttempts}`,
      `status=${error?.status || 500}`,
      `message=${singleLine(error?.message || "Unexpected proxy error.")}`,
    ].join(" "),
  );
}

function logContextTrim(stats, config) {
  if (!config.logRequests || !stats?.trimmed) return;
  console.log(
    [
      "context_trim",
      `original_bytes=${stats.originalBytes}`,
      `final_bytes=${stats.finalBytes}`,
      `original_messages=${stats.originalMessages}`,
      `kept_messages=${stats.keptMessages}`,
      `dropped_messages=${stats.droppedMessages}`,
    ].join(" "),
  );
}

function singleLine(value) {
  return String(value).replace(/\s+/g, " ").trim();
}
