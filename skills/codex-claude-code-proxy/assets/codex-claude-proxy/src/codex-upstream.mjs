import { readCodexAuth } from "./auth.mjs";
import { parseSseStream } from "./sse.mjs";

export class UpstreamError extends Error {
  constructor(message, status = 502, details = null) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.details = details;
  }
}

export async function createCodexResponsesStream(payload, config, options = {}) {
  const auth = await readCodexAuth(config.authPath);
  let response;
  try {
    response = await fetch(config.upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${auth.accessToken}`,
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new UpstreamError("Codex upstream request timed out or was aborted", 504);
    }
    throw new UpstreamError(`Codex upstream request failed: ${error.message}`, 502);
  }

  if (!response.ok) {
    const details = await safeReadText(response);
    throw new UpstreamError(
      `Codex upstream returned HTTP ${response.status}`,
      response.status === 401 ? 401 : 502,
      details,
    );
  }

  return parseSseStream(response.body);
}

export async function collectCodexResponses(payload, config, options = {}) {
  const events = [];
  const stream = await createCodexResponsesStream(payload, config, options);
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function safeReadText(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    return text.slice(0, 2000);
  } catch {
    return null;
  }
}
