# Proxy Details

## Goal

Claude Code Desktop speaks Anthropic Messages API. Codex/ChatGPT auth speaks an internal Codex Responses-style endpoint. The proxy adapts between them locally so the desktop app can point straight at:

```text
http://127.0.0.1:15722
```

This bypasses CC Switch and Quotio.

## Local Security

- Bind host defaults to `127.0.0.1`.
- Claude Desktop must send `Authorization: Bearer <LOCAL_GATEWAY_TOKEN>`.
- `.env` is ignored and must not be committed.
- Logs must not contain prompts, local bearer keys, `access_token`, `refresh_token`, or tool arguments.

## Codex Auth

The proxy reads:

```text
~/.codex/auth.json
```

Expected field:

```json
{
  "tokens": {
    "access_token": "JWT"
  }
}
```

The file is read per request. The JWT `exp` claim is checked. If it is expired or nearly expired, the proxy returns `401` and asks the user to reopen/login to Codex.

## Model Mapping

Claude Desktop sees Claude-like aliases, while the real upstream model is `gpt-5.5`:

```text
claude-sonnet-4-6        -> gpt-5.5 reasoning=medium
claude-sonnet-4-6-high   -> gpt-5.5 reasoning=high
claude-sonnet-4-6-xhigh  -> gpt-5.5 reasoning=xhigh
```

If Claude Desktop sends a built-in Sonnet model ID instead of a custom model ID, the proxy still maps it to the default alias.

Override the menu with:

```text
CODEX_PROXY_MODEL_MAPPINGS=id|display|effort|upstream,id|display|effort|upstream
```

## Anthropic -> Codex Responses Mapping

- `system` -> `instructions`
- `messages[].content[].text` -> `input_text`
- Anthropic image blocks -> `input_image` when they are base64 or URL backed
- Anthropic `tool_result` -> `function_call_output` with matching `call_id`
- Anthropic assistant `tool_use` -> Responses `function_call`
- `tools[].input_schema` -> Responses `function` tools
- `tool_choice` -> `auto`, `none`, or a named Responses function
- `max_tokens`, `temperature`, and `top_p` are intentionally not forced unless supported by the Codex backend path
- `reasoning.effort` comes from the selected alias or `CODEX_PROXY_REASONING_EFFORT`

## Codex Responses -> Anthropic Mapping

- `response.output_text.delta` -> Anthropic SSE `content_block_delta` with `text_delta`
- `response.output_text.done` closes the text block
- Responses `function_call` output item -> Anthropic `tool_use`
- `response.completed` -> `message_delta` and `message_stop`
- `response.failed` -> API error, not `stop_reason=error`

For streaming requests, the proxy sends an immediate `message_start` and periodic `ping` events. It retries transient upstream failures only until content has started, because replaying after partial output can duplicate text or tool calls.

## Context Guard

Default:

```text
CODEX_PROXY_MAX_UPSTREAM_INPUT_BYTES=450000
```

The proxy trims oldest Claude messages after Anthropic -> Responses mapping when the JSON payload exceeds this byte cap. It keeps recent context and removes orphan `function_call_output` items whose matching tool call was trimmed away.

This lowers the chance of:

- `context_length_exceeded`
- long upstream stalls
- stream termination after very large Claude Code sessions
