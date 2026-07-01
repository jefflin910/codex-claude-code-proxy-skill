import test from "node:test";
import assert from "node:assert/strict";
import { readConfig, resolveModelMapping } from "../src/config.mjs";

test("builds default Sonnet reasoning aliases", () => {
  const config = readConfig([], {
    LOCAL_GATEWAY_TOKEN: "local",
    CODEX_PROXY_MODEL: "gpt-5.5",
  });

  assert.deepEqual(
    config.modelMappings.map((mapping) => ({
      id: mapping.id,
      displayName: mapping.displayName,
      upstreamModel: mapping.upstreamModel,
      reasoningEffort: mapping.reasoningEffort,
    })),
    [
      {
        id: "claude-sonnet-4-6",
        displayName: "Sonnet-4.6",
        upstreamModel: "gpt-5.5",
        reasoningEffort: "medium",
      },
      {
        id: "claude-sonnet-4-6-high",
        displayName: "Sonnet-4.6 High",
        upstreamModel: "gpt-5.5",
        reasoningEffort: "high",
      },
      {
        id: "claude-sonnet-4-6-xhigh",
        displayName: "Sonnet-4.6 XHigh",
        upstreamModel: "gpt-5.5",
        reasoningEffort: "xhigh",
      },
    ],
  );
});

test("resolves requested model to matching reasoning alias", () => {
  const config = readConfig([], {
    LOCAL_GATEWAY_TOKEN: "local",
    CODEX_PROXY_MODEL: "gpt-5.5",
  });

  assert.equal(
    resolveModelMapping("claude-sonnet-4-6-high", config).reasoningEffort,
    "high",
  );
  assert.equal(
    resolveModelMapping("claude-sonnet-4-6-xhigh", config).reasoningEffort,
    "xhigh",
  );
  assert.equal(
    resolveModelMapping("claude-opus-something", config).reasoningEffort,
    "medium",
  );
});

test("reads upstream reliability limits from env", () => {
  const config = readConfig([], {
    LOCAL_GATEWAY_TOKEN: "local",
    CODEX_PROXY_UPSTREAM_TIMEOUT_MS: "123456",
    CODEX_PROXY_UPSTREAM_RETRIES: "4",
    CODEX_PROXY_MAX_UPSTREAM_INPUT_BYTES: "789000",
  });

  assert.equal(config.upstreamTimeoutMs, 123456);
  assert.equal(config.upstreamRetries, 4);
  assert.equal(config.upstreamMaxInputBytes, 789000);
});
