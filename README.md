# Codex Claude Code Proxy Skill

A Codex skill for installing and operating a local Anthropic-compatible proxy that lets Claude Code Desktop use Codex/ChatGPT auth directly.

It is designed to bypass CC Switch and Quotio:

```text
Claude Code Desktop -> http://127.0.0.1:15722 -> Codex auth -> gpt-5.5
```

## What Is Included

- `skills/codex-claude-code-proxy/SKILL.md` - the Codex skill entrypoint.
- `skills/codex-claude-code-proxy/assets/codex-claude-proxy` - the local Node proxy.
- `skills/codex-claude-code-proxy/scripts/install_proxy.sh` - copies the proxy into a workspace and creates a local bearer key.
- `skills/codex-claude-code-proxy/references/` - protocol mapping and troubleshooting notes.

## Install Locally

Copy the skill folder into your Codex skills directory:

```bash
mkdir -p ~/.codex/skills
cp -R skills/codex-claude-code-proxy ~/.codex/skills/
```

## Use It From Codex

After the skill is installed, you can ask Codex to run the terminal setup for
you:

```text
Use $codex-claude-code-proxy to install the proxy into ~/codex-claude-proxy,
start it in the background, and show me the Claude Code Desktop Gateway
settings.
```

Codex will:

1. Copy the bundled Node proxy into `~/codex-claude-proxy`.
2. Create `~/codex-claude-proxy/.env` with a random local bearer token.
3. Run the proxy on `http://127.0.0.1:15722`.
4. Verify `/health` and `/v1/models`.
5. Print the exact Gateway settings for Claude Code Desktop.

The skill can run terminal commands through Codex, but it does not modify
Claude Code Desktop automatically. You still paste the printed Gateway settings
into Claude Code Desktop once.

## Manual Proxy Install

```bash
cd skills/codex-claude-code-proxy
./scripts/install_proxy.sh ~/codex-claude-proxy
cd ~/codex-claude-proxy
npm test
npm start
```

To start it in the background from the skill directory:

```bash
./scripts/start_proxy.sh ~/codex-claude-proxy
```

Claude Desktop Gateway:

```text
Gateway base URL: http://127.0.0.1:15722
Gateway API key:  value of LOCAL_GATEWAY_TOKEN in .env
Gateway auth scheme: bearer
```

## Publish To GitHub

From this repository root:

```bash
git add .
git commit -m "Add Codex Claude Code proxy skill"
gh repo create codex-claude-code-proxy-skill --public --source=. --remote=origin --push
```

If you do not use GitHub CLI:

```bash
git remote add origin git@github.com:<you>/codex-claude-code-proxy-skill.git
git push -u origin main
```

## Model Aliases

```text
Sonnet-4.6        -> gpt-5.5 reasoning=medium
Sonnet-4.6 High   -> gpt-5.5 reasoning=high
Sonnet-4.6 XHigh  -> gpt-5.5 reasoning=xhigh
```

## Security Notes

- The proxy binds to `127.0.0.1` by default.
- `.env` is ignored and should never be committed.
- Do not publish `~/.codex/auth.json`, access tokens, refresh tokens, local bearer keys, prompts, or tool payloads.
- This uses an internal Codex backend endpoint and may need updates if that endpoint changes.

## License

MIT
