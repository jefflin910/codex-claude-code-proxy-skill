---
name: codex-claude-code-proxy
description: Install, configure, run, and troubleshoot a local Anthropic Messages API proxy that lets Claude Code Desktop talk directly to Codex/ChatGPT auth, bypassing CC Switch and Quotio. Use for Claude Desktop gateway setup, Sonnet-to-GPT-5.5 model mapping, reasoning aliases, local bearer-token setup, and proxy error triage.
---

# Codex Claude Code Proxy

Use this skill when the user wants Claude Code Desktop to use Codex/ChatGPT auth directly through a local proxy, without CC Switch or Quotio.

The bundled proxy lives at `assets/codex-claude-proxy`. It exposes an Anthropic-compatible local gateway and forwards requests to the Codex backend using `~/.codex/auth.json`.

## Fast Path

1. Copy the bundled proxy into a user workspace:

```bash
./scripts/install_proxy.sh /path/to/codex-claude-proxy
```

2. Start it:

```bash
cd /path/to/codex-claude-proxy
npm test
npm start
```

3. Configure Claude Desktop Gateway:

```text
Gateway base URL: http://127.0.0.1:15722
Gateway API key:  value of LOCAL_GATEWAY_TOKEN in .env
Gateway auth scheme: bearer
```

4. Test:

```bash
TOKEN="$(grep '^LOCAL_GATEWAY_TOKEN=' .env | cut -d= -f2-)"
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:15722/health
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:15722/v1/models
```

## What It Implements

- Local-only HTTP service bound to `127.0.0.1:15722`.
- Required local bearer token via `LOCAL_GATEWAY_TOKEN`.
- Reads `~/.codex/auth.json` on every request and uses `tokens.access_token`.
- Rejects expired Codex JWTs with clear `401` instead of implementing refresh.
- Exposes `GET /health`, `GET /v1/models`, `POST /v1/messages`, and `POST /v1/messages/count_tokens`.
- Maps Claude/Sonnet requests to upstream `gpt-5.5`.
- Provides model aliases:
  - `claude-sonnet-4-6` -> `gpt-5.5`, reasoning `medium`
  - `claude-sonnet-4-6-high` -> `gpt-5.5`, reasoning `high`
  - `claude-sonnet-4-6-xhigh` -> `gpt-5.5`, reasoning `xhigh`
- Uses a conservative context byte cap, default `450000`, to reduce Codex upstream context failures.
- Logs request timings, context trimming, safe upstream errors, and retry summaries only. Do not add prompt, token, or credential logs.

## Setup Checks

Before starting the proxy, verify:

```bash
node -v
test -r ~/.codex/auth.json && echo "codex auth exists"
```

If `~/.codex/auth.json` is missing or expired, ask the user to reopen Codex or run Codex login before testing Claude Desktop.

## When Editing

- Keep all upstream calls isolated in `src/codex-upstream.mjs`.
- Keep Anthropic -> Responses mapping in `src/anthropic-to-responses.mjs`.
- Keep Responses -> Anthropic mapping in `src/responses-to-anthropic.mjs`.
- Keep local auth behavior in `src/auth.mjs`.
- Preserve local-only bind defaults and bearer-token protection.
- Never commit `.env`, `~/.codex/auth.json`, access tokens, refresh tokens, Claude prompt text, or tool payloads.

Read `references/proxy-details.md` for protocol mapping and `references/troubleshooting.md` when diagnosing Claude Code Desktop errors.
