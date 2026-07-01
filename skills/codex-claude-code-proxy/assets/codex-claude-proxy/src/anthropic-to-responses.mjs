const DEFAULT_INSTRUCTIONS = "You are Claude Code running through a local Codex-auth gateway.";

export function anthropicToResponses(request, options = {}) {
  const model = options.upstreamModel || "gpt-5.5";
  const instructions = extractInstructions(request.system) || DEFAULT_INSTRUCTIONS;
  const input = [];

  for (const message of request.messages || []) {
    const converted = convertMessage(message);
    if (Array.isArray(converted)) input.push(...converted);
    else if (converted) input.push(converted);
  }

  return stripCodexUnsupportedParams({
    model,
    instructions,
    input,
    stream: true,
    store: false,
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    reasoning: {
      effort: normalizeReasoningEffort(options.reasoningEffort),
    },
    tools: convertTools(request.tools),
    tool_choice: convertToolChoice(request.tool_choice),
  });
}

function stripCodexUnsupportedParams(payload) {
  const cleaned = { ...payload };
  if (!cleaned.tools?.length) {
    delete cleaned.tools;
    delete cleaned.tool_choice;
  }
  if (cleaned.tool_choice === undefined) delete cleaned.tool_choice;
  return cleaned;
}

function extractInstructions(system) {
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .filter((part) => part?.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n\n");
  }
  return "";
}

function convertMessage(message) {
  if (!message || !message.role) return null;

  if (message.role === "assistant") {
    return convertAssistantMessage(message);
  }

  return convertUserMessage(message);
}

function convertUserMessage(message) {
  const messageContent = [];
  const items = [];

  for (const part of normalizeContentArray(message.content)) {
    if (part.type === "tool_result") {
      items.push({
        type: "function_call_output",
        call_id: part.tool_use_id || "unknown_tool_call",
        output: stringifyToolResultContent(part.content),
      });
      continue;
    }

    const converted = convertUserContentPart(part);
    if (converted) messageContent.push(converted);
  }

  if (messageContent.length) {
    items.unshift({
      type: "message",
      role: "user",
      content: messageContent,
    });
  }

  if (!items.length) {
    items.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "" }],
    });
  }

  return items;
}

function convertAssistantMessage(message) {
  const content = [];
  const functionCalls = [];

  for (const part of normalizeContentArray(message.content)) {
    if (part.type === "text") {
      content.push({ type: "output_text", text: part.text || "" });
    } else if (part.type === "tool_use") {
      const callId = part.id || `call_${part.name || "tool"}`;
      functionCalls.push({
        type: "function_call",
        id: makeFunctionCallItemId(callId),
        call_id: callId,
        name: part.name,
        arguments: JSON.stringify(part.input || {}),
        status: "completed",
      });
    }
  }

  const items = [];
  if (content.length) {
    items.push({
      type: "message",
      role: "assistant",
      content,
    });
  }
  items.push(...functionCalls);
  return items;
}

function convertUserContentPart(part) {
  if (part.type === "text") {
    return {
      type: "input_text",
      text: part.text || "",
    };
  }
  if (part.type === "image") {
    return convertImagePart(part);
  }
  return null;
}

function normalizeContentArray(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [];
}

function convertImagePart(part) {
  const source = part.source || {};
  if (source.type === "base64" && source.data) {
    return {
      type: "input_image",
      image_url: `data:${source.media_type || "image/png"};base64,${source.data}`,
    };
  }
  if (source.type === "url" && source.url) {
    return {
      type: "input_image",
      image_url: source.url,
    };
  }
  return null;
}

function stringifyToolResultContent(contentValue) {
  const content = normalizeContentArray(contentValue)
    .map((item) => {
      if (item.type === "text") return item.text || "";
      return JSON.stringify(item);
    })
    .join("\n");
  return content || "";
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((tool) => tool?.name)
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description || "",
      parameters: tool.input_schema || { type: "object", properties: {} },
      strict: false,
    }));
}

function convertToolChoice(toolChoice) {
  if (!toolChoice) return "auto";
  if (typeof toolChoice === "string") {
    if (toolChoice === "none" || toolChoice === "auto") return toolChoice;
    return { type: "function", name: toolChoice };
  }
  if (toolChoice.type === "none" || toolChoice.type === "auto") return toolChoice.type;
  if (toolChoice.type === "tool" && toolChoice.name) {
    return { type: "function", name: toolChoice.name };
  }
  return "auto";
}

function normalizeReasoningEffort(effort) {
  if (["low", "medium", "high", "xhigh"].includes(effort)) return effort;
  return "medium";
}

function makeFunctionCallItemId(callId) {
  const suffix = String(callId || "")
    .replace(/^fc_/, "")
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 80);
  return `fc_${suffix || Date.now()}`;
}
