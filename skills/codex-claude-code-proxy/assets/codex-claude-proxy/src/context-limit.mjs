import { anthropicToResponses } from "./anthropic-to-responses.mjs";

export function buildLimitedResponsesPayload(body, options = {}) {
  const maxBytes = Number(options.maxBytes || 0);
  const makePayload = (request) =>
    anthropicToResponses(request, {
      upstreamModel: options.upstreamModel,
      reasoningEffort: options.reasoningEffort,
    });

  const originalPayload = sanitizeResponsesPayload(makePayload(body));
  const originalBytes = jsonByteLength(originalPayload);
  const messages = Array.isArray(body?.messages) ? body.messages : [];

  if (!maxBytes || originalBytes <= maxBytes || messages.length <= 1) {
    return {
      payload: originalPayload,
      stats: {
        trimmed: false,
        originalBytes,
        finalBytes: originalBytes,
        originalMessages: messages.length,
        keptMessages: messages.length,
        droppedMessages: 0,
      },
    };
  }

  let keptMessages = [];
  let bestPayload = sanitizeResponsesPayload(makePayload({ ...body, messages: [] }));
  let bestBytes = jsonByteLength(bestPayload);

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidateMessages = [messages[index], ...keptMessages];
    const candidateBody = { ...body, messages: candidateMessages };
    const candidatePayload = sanitizeResponsesPayload(makePayload(candidateBody));
    const candidateBytes = jsonByteLength(candidatePayload);

    if (candidateBytes > maxBytes && keptMessages.length > 0) break;

    keptMessages = candidateMessages;
    bestPayload = candidatePayload;
    bestBytes = candidateBytes;

    if (candidateBytes > maxBytes) break;
  }

  return {
    payload: bestPayload,
    stats: {
      trimmed: keptMessages.length < messages.length,
      originalBytes,
      finalBytes: bestBytes,
      originalMessages: messages.length,
      keptMessages: keptMessages.length,
      droppedMessages: messages.length - keptMessages.length,
    },
  };
}

export function sanitizeResponsesPayload(payload) {
  const input = Array.isArray(payload?.input) ? payload.input : [];
  const knownCallIds = new Set();
  let droppedOrphanToolResults = 0;
  const sanitizedInput = [];

  for (const item of input) {
    if (item?.type === "function_call") {
      if (item.call_id) knownCallIds.add(item.call_id);
      sanitizedInput.push(item);
      continue;
    }

    if (item?.type === "function_call_output") {
      if (item.call_id && knownCallIds.has(item.call_id)) {
        sanitizedInput.push(item);
      } else {
        droppedOrphanToolResults += 1;
      }
      continue;
    }

    sanitizedInput.push(item);
  }

  if (!droppedOrphanToolResults) return payload;
  return {
    ...payload,
    input: sanitizedInput,
  };
}

function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}
