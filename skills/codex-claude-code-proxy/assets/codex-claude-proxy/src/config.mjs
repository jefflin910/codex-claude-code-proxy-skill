import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_CLAUDE_MODEL = "claude-sonnet-4-6";
const DEFAULT_CLAUDE_DISPLAY_NAME = "Sonnet-4.6";
const DEFAULT_UPSTREAM_URL = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_MAX_UPSTREAM_INPUT_BYTES = 450000;
const DEFAULT_UPSTREAM_RETRIES = 2;
const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadDotEnv(cwd = process.cwd()) {
  const file = path.join(cwd, ".env");
  if (!fs.existsSync(file)) return;

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function readConfig(argv = process.argv.slice(2), env = process.env) {
  const cli = parseArgs(argv);
  const cwd = cli.cwd || process.cwd();
  loadDotEnv(cwd);

  const localGatewayToken = env.LOCAL_GATEWAY_TOKEN;
  if (!localGatewayToken) {
    throw new ConfigError(
      "LOCAL_GATEWAY_TOKEN is required. Create .env from .env.example or export it before starting.",
    );
  }

  const upstreamModel = env.CODEX_PROXY_MODEL || DEFAULT_MODEL;
  const claudeModel = env.CODEX_PROXY_CLAUDE_MODEL || DEFAULT_CLAUDE_MODEL;
  const claudeDisplayName =
    env.CODEX_PROXY_CLAUDE_DISPLAY_NAME || DEFAULT_CLAUDE_DISPLAY_NAME;
  const reasoningEffort = normalizeReasoningEffort(
    env.CODEX_PROXY_REASONING_EFFORT || "medium",
  );

  return {
    host: cli.host || env.CODEX_PROXY_HOST || "127.0.0.1",
    port: Number(cli.port || env.CODEX_PROXY_PORT || 15722),
    localGatewayToken,
    upstreamModel,
    claudeModel,
    claudeDisplayName,
    modelMappings: buildModelMappings({
      upstreamModel,
      claudeModel,
      claudeDisplayName,
      reasoningEffort,
      rawMappings: env.CODEX_PROXY_MODEL_MAPPINGS,
    }),
    upstreamUrl: env.CODEX_PROXY_UPSTREAM_URL || DEFAULT_UPSTREAM_URL,
    upstreamTimeoutMs: Number(env.CODEX_PROXY_UPSTREAM_TIMEOUT_MS || 180000),
    upstreamRetries: Number(env.CODEX_PROXY_UPSTREAM_RETRIES || DEFAULT_UPSTREAM_RETRIES),
    upstreamMaxInputBytes: Number(
      env.CODEX_PROXY_MAX_UPSTREAM_INPUT_BYTES || DEFAULT_MAX_UPSTREAM_INPUT_BYTES,
    ),
    authPath:
      env.CODEX_AUTH_PATH ||
      path.join(os.homedir(), ".codex", "auth.json"),
    reasoningEffort,
    logRequests: env.CODEX_PROXY_LOG_REQUESTS !== "0",
    logErrors: env.CODEX_PROXY_LOG_ERRORS !== "0",
  };
}

export function resolveModelMapping(requestedModel, config) {
  const mappings = config.modelMappings?.length
    ? config.modelMappings
    : buildModelMappings(config);
  const exact = mappings.find((mapping) => mapping.id === requestedModel);
  if (exact) return exact;

  const sonnetish =
    typeof requestedModel === "string" &&
    /sonnet|claude/i.test(requestedModel);
  if (sonnetish) return mappings[0];
  return mappings[0];
}

function buildModelMappings({
  upstreamModel,
  claudeModel,
  claudeDisplayName,
  reasoningEffort,
  rawMappings,
}) {
  if (rawMappings) {
    const parsed = parseModelMappings(rawMappings, upstreamModel);
    if (parsed.length) return parsed;
  }

  const defaultEffort = normalizeReasoningEffort(reasoningEffort || "medium");
  return [
    {
      id: claudeModel || DEFAULT_CLAUDE_MODEL,
      displayName: claudeDisplayName || DEFAULT_CLAUDE_DISPLAY_NAME,
      upstreamModel: upstreamModel || DEFAULT_MODEL,
      reasoningEffort: defaultEffort,
    },
    {
      id: `${claudeModel || DEFAULT_CLAUDE_MODEL}-high`,
      displayName: `${claudeDisplayName || DEFAULT_CLAUDE_DISPLAY_NAME} High`,
      upstreamModel: upstreamModel || DEFAULT_MODEL,
      reasoningEffort: "high",
    },
    {
      id: `${claudeModel || DEFAULT_CLAUDE_MODEL}-xhigh`,
      displayName: `${claudeDisplayName || DEFAULT_CLAUDE_DISPLAY_NAME} XHigh`,
      upstreamModel: upstreamModel || DEFAULT_MODEL,
      reasoningEffort: "xhigh",
    },
  ];
}

function parseModelMappings(rawMappings, defaultUpstreamModel) {
  return rawMappings
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [id, displayName, reasoningEffort, upstreamModel] = entry
        .split("|")
        .map((part) => part.trim());
      if (!id || !displayName) return null;
      return {
        id,
        displayName,
        upstreamModel: upstreamModel || defaultUpstreamModel || DEFAULT_MODEL,
        reasoningEffort: normalizeReasoningEffort(reasoningEffort || "medium"),
      };
    })
    .filter(Boolean);
}

function normalizeReasoningEffort(effort) {
  return VALID_REASONING_EFFORTS.has(effort) ? effort : "medium";
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--port") out.port = argv[++i];
    else if (arg === "--host") out.host = argv[++i];
    else if (arg === "--cwd") out.cwd = argv[++i];
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

export function printHelp(stream = process.stdout) {
  stream.write(`codex-claude-proxy

Usage:
  LOCAL_GATEWAY_TOKEN=... node src/server.mjs --port 15722

Options:
  --host <host>   Bind host, default 127.0.0.1
  --port <port>   Bind port, default 15722

Environment:
  LOCAL_GATEWAY_TOKEN             Required bearer token for Claude Desktop
  CODEX_PROXY_MODEL               Upstream Codex model, default gpt-5.5
  CODEX_PROXY_CLAUDE_MODEL        Exposed Claude model id, default claude-sonnet-4-6
  CODEX_PROXY_CLAUDE_DISPLAY_NAME Exposed menu name, default Sonnet-4.6
  CODEX_PROXY_REASONING_EFFORT    low|medium|high|xhigh, default medium
  CODEX_PROXY_MODEL_MAPPINGS      Optional id|display|effort|upstream comma list
  CODEX_PROXY_UPSTREAM_TIMEOUT_MS Upstream timeout, default 180000
  CODEX_PROXY_UPSTREAM_RETRIES    Retries for transient upstream failures, default ${DEFAULT_UPSTREAM_RETRIES}
  CODEX_PROXY_MAX_UPSTREAM_INPUT_BYTES
                                  Trim oldest messages above this JSON byte size, default ${DEFAULT_MAX_UPSTREAM_INPUT_BYTES}
  CODEX_PROXY_LOG_ERRORS          Set to 0 to disable safe error summaries
  CODEX_AUTH_PATH                 Codex auth file, default ~/.codex/auth.json
`);
}
