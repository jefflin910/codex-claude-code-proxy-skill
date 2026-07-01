# Troubleshooting

## Port Already In Use

```bash
lsof -nP -iTCP:15722 -sTCP:LISTEN
kill <pid>
npm start
```

Do not kill random Node processes. Confirm the command path points to this proxy.

## Claude Desktop Shows 401

Check:

```bash
TOKEN="$(grep '^LOCAL_GATEWAY_TOKEN=' .env | cut -d= -f2-)"
curl -sS -H "Authorization: Bearer $TOKEN" http://127.0.0.1:15722/health
```

If `/health` says Codex auth expired, reopen Codex or run Codex login. If it says local bearer token is invalid, update Claude Desktop Gateway API key to match `.env`.

## Claude Desktop Shows 502 / Stream Terminated

Typical causes:

- Codex upstream transient failure: `fetch failed`
- upstream stream ended mid-generation: `stream terminated`
- very large Claude Code session context

Check logs:

```bash
tail -n 120 /tmp/codex-claude-proxy.log
```

Look for:

```text
upstream_retry
proxy_error
context_trim
```

If context trimming is frequent and requests are slow, lower:

```text
CODEX_PROXY_MAX_UPSTREAM_INPUT_BYTES=350000
```

Use `Sonnet-4.6` or `Sonnet-4.6 High` for long sessions. Reserve `XHigh` for small/high-value tasks.

## Context Length Exceeded

Open a fresh Claude Code session or reduce:

```text
CODEX_PROXY_MAX_UPSTREAM_INPUT_BYTES
```

The skill default is `450000`, chosen after long-session testing. `350000` is more stable but remembers less history.

## Node Dynamic Library Error on macOS Homebrew

If Node fails with a missing Homebrew dylib such as `libllhttp`:

```bash
brew reinstall node
node -v
```

Then restart the proxy.

## Manual Smoke Test

```bash
TOKEN="$(grep '^LOCAL_GATEWAY_TOKEN=' .env | cut -d= -f2-)"

curl -sS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:15722/health

curl -sS -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:15722/v1/models

curl -sS -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-4-6","max_tokens":32,"messages":[{"role":"user","content":[{"type":"text","text":"Reply with only: ok"}]}]}' \
  http://127.0.0.1:15722/v1/messages
```

Expected final response contains:

```json
{"type":"text","text":"ok"}
```
