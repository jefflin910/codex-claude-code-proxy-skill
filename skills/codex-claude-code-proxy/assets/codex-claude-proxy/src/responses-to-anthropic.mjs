import { encodeSse } from "./sse.mjs";

const VALID_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "pause_turn",
  "refusal",
]);

export class ResponsesFailedError extends Error {
  constructor(message, details = null) {
    super(message);
    this.name = "ResponsesFailedError";
    this.status = 502;
    this.details = details;
  }
}

export function makeMessageStart(id, model, usage = {}) {
  return {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: usage.input_tokens || 0,
        output_tokens: usage.output_tokens || 0,
      },
    },
  };
}

export function makeMessageDelta(stopReason = "end_turn", usage = {}) {
  return {
    type: "message_delta",
    delta: {
      stop_reason: normalizeStopReason(stopReason),
      stop_sequence: null,
    },
    usage: {
      output_tokens: usage.output_tokens || 0,
    },
  };
}

export function convertCollectedResponsesEvents(events, model) {
  const state = collectResponsesState(events);
  if (state.failedError) throw state.failedError;
  return {
    id: state.responseId || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content: state.blocks,
    stop_reason: state.stopReason || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: state.usage.input_tokens || 0,
      output_tokens: state.usage.output_tokens || estimateOutputTokens(state.blocks),
    },
  };
}

export async function streamResponsesAsAnthropic(upstreamEvents, writer, model, options = {}) {
  const encoder = new TextEncoder();
  const state = createStreamState(model);

  function send(event, data) {
    options.onAnthropicEvent?.(event, data);
    writer.write(encoder.encode(encodeSse(event, data)));
  }

  if (options.sendMessageStart !== false) {
    send("message_start", makeMessageStart(state.messageId, model));
  }

  for await (const { data } of upstreamEvents) {
    if (!data || typeof data !== "object") continue;
    handleResponsesEventForAnthropicStream(data, state, send);
  }

  closeOpenBlocks(state, send);
  send("message_delta", makeMessageDelta(state.stopReason, state.usage));
  send("message_stop", { type: "message_stop" });
}

export function collectResponsesState(events) {
  const state = {
    responseId: null,
    blocks: [],
    outputItemByIndex: new Map(),
    openTextByOutputIndex: new Map(),
    usage: {},
    stopReason: "end_turn",
    failedError: null,
  };

  for (const event of events) {
    const data = event?.data || event;
    if (!data || typeof data !== "object") continue;
    if (data.type === "response.created") {
      state.responseId = data.response?.id || state.responseId;
    } else if (data.type === "response.output_text.done") {
      const text = data.text || "";
      if (text) state.blocks.push({ type: "text", text });
    } else if (data.type === "response.output_item.done") {
      const block = convertOutputItemToContentBlock(data.item);
      if (block) state.blocks.push(block);
    } else if (data.type === "response.completed") {
      state.responseId = data.response?.id || state.responseId;
      state.usage = data.response?.usage || state.usage;
    } else if (data.type === "response.failed") {
      state.failedError = makeResponsesFailedError(data);
    }
  }

  if (!state.blocks.length) {
    state.blocks.push({ type: "text", text: "" });
  }
  if (state.blocks.some((block) => block.type === "tool_use")) {
    state.stopReason = "tool_use";
  }

  return state;
}

export function handleResponsesEventForAnthropicStream(data, state, send) {
  if (data.type === "response.created") {
    state.responseId = data.response?.id || state.responseId;
    return;
  }

  if (data.type === "response.output_text.delta") {
    ensureTextBlock(data.output_index || 0, state, send);
    send("content_block_delta", {
      type: "content_block_delta",
      index: state.blockIndexByOutputIndex.get(data.output_index || 0),
      delta: {
        type: "text_delta",
        text: data.delta || "",
      },
    });
    return;
  }

  if (data.type === "response.output_text.done") {
    closeTextBlock(data.output_index || 0, state, send);
    return;
  }

  if (data.type === "response.output_item.done") {
    const block = convertOutputItemToContentBlock(data.item);
    if (block?.type === "tool_use") {
      state.stopReason = "tool_use";
      const index = state.nextBlockIndex++;
      send("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {},
        },
      });
      send("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input || {}),
        },
      });
      send("content_block_stop", {
        type: "content_block_stop",
        index,
      });
    }
    return;
  }

  if (data.type === "response.completed") {
    state.usage = data.response?.usage || state.usage;
    if (state.stopReason !== "tool_use") {
      state.stopReason = inferStopReason(data.response);
    }
  } else if (data.type === "response.failed") {
    throw makeResponsesFailedError(data);
  }
}

function createStreamState(model) {
  return {
    messageId: `msg_${Date.now()}`,
    model,
    nextBlockIndex: 0,
    blockIndexByOutputIndex: new Map(),
    openTextOutputIndexes: new Set(),
    usage: {},
    stopReason: "end_turn",
  };
}

function ensureTextBlock(outputIndex, state, send) {
  if (state.blockIndexByOutputIndex.has(outputIndex)) return;
  const index = state.nextBlockIndex++;
  state.blockIndexByOutputIndex.set(outputIndex, index);
  state.openTextOutputIndexes.add(outputIndex);
  send("content_block_start", {
    type: "content_block_start",
    index,
    content_block: {
      type: "text",
      text: "",
    },
  });
}

function closeTextBlock(outputIndex, state, send) {
  if (!state.openTextOutputIndexes.has(outputIndex)) return;
  const index = state.blockIndexByOutputIndex.get(outputIndex);
  state.openTextOutputIndexes.delete(outputIndex);
  send("content_block_stop", {
    type: "content_block_stop",
    index,
  });
}

function closeOpenBlocks(state, send) {
  for (const outputIndex of [...state.openTextOutputIndexes]) {
    closeTextBlock(outputIndex, state, send);
  }
}

function convertOutputItemToContentBlock(item) {
  if (!item) return null;
  if (item.type === "function_call") {
    return {
      type: "tool_use",
      id: toAnthropicToolUseId(item.call_id || item.id),
      name: item.name || "tool",
      input: parseJsonObject(item.arguments),
    };
  }
  return null;
}

function toAnthropicToolUseId(id) {
  const value = String(id || Date.now()).replace(/[^A-Za-z0-9_-]/g, "_");
  if (value.startsWith("toolu_")) return value;
  return `toolu_${value}`;
}

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function inferStopReason(response) {
  if (response?.status === "completed") return "end_turn";
  if (response?.status === "incomplete") return "max_tokens";
  return "end_turn";
}

function normalizeStopReason(stopReason) {
  return VALID_STOP_REASONS.has(stopReason) ? stopReason : "end_turn";
}

function makeResponsesFailedError(data) {
  const failure = data?.response?.error || data?.error || {};
  const code = failure.code || failure.type || "failed";
  const message = failure.message || data?.response?.status_details || "unknown upstream failure";
  return new ResponsesFailedError(
    `Codex upstream response failed: ${code}: ${message}`,
    safeFailureDetails(failure),
  );
}

function safeFailureDetails(failure) {
  if (!failure || typeof failure !== "object") return null;
  const safe = {
    code: failure.code,
    type: failure.type,
    message: failure.message,
  };
  return JSON.stringify(Object.fromEntries(Object.entries(safe).filter(([, value]) => value)));
}

function estimateOutputTokens(blocks) {
  const text = blocks
    .map((block) => (block.type === "text" ? block.text : JSON.stringify(block.input || {})))
    .join("\n");
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 3));
}
