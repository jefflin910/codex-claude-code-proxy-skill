export function estimateAnthropicInputTokens(request) {
  const text = extractRequestText(request).join("\n");
  const bytes = Buffer.byteLength(text, "utf8");
  const chars = text.length;
  const structuralOverhead =
    64 +
    (Array.isArray(request?.messages) ? request.messages.length * 12 : 0) +
    (Array.isArray(request?.tools) ? request.tools.length * 32 : 0);

  return Math.max(1, Math.ceil(Math.max(bytes / 1.8, chars / 1.5)) + structuralOverhead);
}

function extractRequestText(request) {
  const out = [];
  addContent(out, request?.system);
  for (const message of request?.messages || []) {
    addContent(out, message?.content);
  }
  for (const tool of request?.tools || []) {
    out.push(tool?.name || "");
    out.push(tool?.description || "");
    out.push(JSON.stringify(tool?.input_schema || {}));
  }
  return out.filter(Boolean);
}

function addContent(out, content) {
  if (typeof content === "string") {
    out.push(content);
    return;
  }

  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (!part) continue;
    if (typeof part === "string") out.push(part);
    else if (part.type === "text") out.push(part.text || "");
    else if (part.type === "tool_result") out.push(JSON.stringify(part.content || ""));
    else if (part.type === "tool_use") out.push(JSON.stringify(part.input || {}));
  }
}
