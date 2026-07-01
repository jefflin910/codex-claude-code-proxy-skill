import test from "node:test";
import assert from "node:assert/strict";
import { anthropicToResponses } from "../src/anthropic-to-responses.mjs";
import { buildLimitedResponsesPayload, sanitizeResponsesPayload } from "../src/context-limit.mjs";
import {
  collectResponsesState,
  convertCollectedResponsesEvents,
  handleResponsesEventForAnthropicStream,
  makeMessageDelta,
  ResponsesFailedError,
} from "../src/responses-to-anthropic.mjs";
import { estimateAnthropicInputTokens } from "../src/token-count.mjs";

test("maps Anthropic messages request to Codex Responses payload", () => {
  const payload = anthropicToResponses(
    {
      model: "claude-sonnet-4-6-codex-gpt-5-5",
      system: [{ type: "text", text: "Be terse." }],
      max_tokens: 32,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Use echo" },
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: [{ type: "text", text: "done" }],
            },
          ],
        },
      ],
      tools: [
        {
          name: "echo",
          description: "Echo input",
          input_schema: {
            type: "object",
            properties: { text: { type: "string" } },
          },
        },
      ],
      tool_choice: { type: "tool", name: "echo" },
    },
    { upstreamModel: "gpt-5.5", reasoningEffort: "xhigh" },
  );

  assert.equal(payload.model, "gpt-5.5");
  assert.equal(payload.instructions, "Be terse.");
  assert.equal(payload.stream, true);
  assert.equal(payload.store, false);
  assert.deepEqual(payload.reasoning, { effort: "xhigh" });
  assert.equal(payload.input[0].type, "message");
  assert.equal(payload.input[0].content[0].text, "Use echo");
  assert.deepEqual(payload.input[1], {
    type: "function_call_output",
    call_id: "toolu_1",
    output: "done",
  });
  assert.equal(payload.tools[0].name, "echo");
  assert.deepEqual(payload.tool_choice, { type: "function", name: "echo" });
  assert.equal("max_output_tokens" in payload, false);
  assert.equal("temperature" in payload, false);

  const assistantPayload = anthropicToResponses({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_abc",
            name: "echo",
            input: { text: "hi" },
          },
        ],
      },
    ],
  });
  assert.equal(assistantPayload.input[0].id, "fc_call_abc");
  assert.equal(assistantPayload.input[0].call_id, "call_abc");
});

test("omits tool_choice when no tools are present", () => {
  const payload = anthropicToResponses({
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal("tools" in payload, false);
  assert.equal("tool_choice" in payload, false);
});

test("maps collected text response to Anthropic message", () => {
  const message = convertCollectedResponsesEvents(
    [
      {
        data: {
          type: "response.created",
          response: { id: "resp_1" },
        },
      },
      {
        data: {
          type: "response.output_text.done",
          text: "OK",
        },
      },
      {
        data: {
          type: "response.completed",
          response: {
            id: "resp_1",
            status: "completed",
            usage: {
              input_tokens: 10,
              output_tokens: 2,
            },
          },
        },
      },
    ],
    "claude-sonnet-4-6-codex-gpt-5-5",
  );

  assert.equal(message.id, "resp_1");
  assert.equal(message.role, "assistant");
  assert.deepEqual(message.content, [{ type: "text", text: "OK" }]);
  assert.equal(message.usage.input_tokens, 10);
  assert.equal(message.usage.output_tokens, 2);
});

test("maps function_call output item to Anthropic tool_use", () => {
  const state = collectResponsesState([
    {
      data: {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_1",
          name: "echo",
          arguments: '{"text":"hi"}',
        },
      },
    },
  ]);

  assert.deepEqual(state.blocks, [
    {
      type: "tool_use",
      id: "toolu_call_1",
      name: "echo",
      input: { text: "hi" },
    },
  ]);
  assert.equal(state.stopReason, "tool_use");
});

test("streams tool_use input through Anthropic input_json_delta", () => {
  const sent = [];
  const state = {
    nextBlockIndex: 0,
    blockIndexByOutputIndex: new Map(),
    openTextOutputIndexes: new Set(),
    usage: {},
    stopReason: "end_turn",
  };

  handleResponsesEventForAnthropicStream(
    {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "echo",
        arguments: '{"text":"hi"}',
      },
    },
    state,
    (event, data) => sent.push({ event, data }),
  );

  assert.equal(sent[0].event, "content_block_start");
  assert.deepEqual(sent[0].data.content_block, {
    type: "tool_use",
    id: "toolu_call_1",
    name: "echo",
    input: {},
  });
  assert.equal(sent[1].event, "content_block_delta");
  assert.deepEqual(sent[1].data.delta, {
    type: "input_json_delta",
    partial_json: '{"text":"hi"}',
  });
  assert.equal(sent[2].event, "content_block_stop");
  assert.equal(state.stopReason, "tool_use");
});

test("maps response.failed to api error instead of invalid stop reason", () => {
  const failedEvent = {
    type: "response.failed",
    response: {
      error: {
        code: "server_error",
        message: "upstream stopped",
      },
    },
  };

  assert.throws(
    () => convertCollectedResponsesEvents([{ data: failedEvent }], "claude-sonnet-4-6"),
    ResponsesFailedError,
  );
  assert.throws(
    () => handleResponsesEventForAnthropicStream(failedEvent, {}, () => {}),
    /Codex upstream response failed: server_error: upstream stopped/,
  );
  assert.equal(makeMessageDelta("error").delta.stop_reason, "end_turn");
});

test("trims oldest messages when mapped payload exceeds upstream byte budget", () => {
  const messages = Array.from({ length: 8 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: [{ type: "text", text: `message-${index} ${"x".repeat(200)}` }],
  }));
  const { payload, stats } = buildLimitedResponsesPayload(
    {
      system: "Keep recent context.",
      messages,
    },
    {
      upstreamModel: "gpt-5.5",
      reasoningEffort: "medium",
      maxBytes: 1800,
    },
  );

  assert.equal(stats.trimmed, true);
  assert.ok(stats.droppedMessages > 0);
  assert.ok(stats.keptMessages < messages.length);
  assert.ok(JSON.stringify(payload).includes("message-7"));
  assert.equal(JSON.stringify(payload).includes("message-0"), false);
});

test("drops orphan function call outputs after context trimming", () => {
  const payload = sanitizeResponsesPayload({
    model: "gpt-5.5",
    input: [
      {
        type: "function_call_output",
        call_id: "toolu_missing",
        output: "orphan",
      },
      {
        type: "function_call",
        call_id: "toolu_keep",
        name: "echo",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "toolu_keep",
        output: "matched",
      },
    ],
  });

  assert.deepEqual(
    payload.input.map((item) => item.type === "function_call_output" ? item.output : item.call_id),
    ["toolu_keep", "matched"],
  );
});

test("token estimate is conservative and positive", () => {
  const tokens = estimateAnthropicInputTokens({
    system: "sys",
    messages: [{ role: "user", content: "hello world" }],
    tools: [{ name: "echo", input_schema: { type: "object" } }],
  });

  assert.ok(tokens > 64);
});
