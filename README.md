# OpenClaw Railway Template

Deploy OpenClaw on Railway with a browser-first setup flow. No SSH required for onboarding.

IF YOU ARE UPGRADING FROM A PREVIOW VERSION REMOVE THE ENV VAR 'OPENCLAW_ENTRY' AS NOW OPENCLAW IS INSTALLED VIA NPM

## Read This First

This template exposes your OpenClaw gateway to the public internet.

- Review OpenClaw security guidance: <https://docs.openclaw.ai/gateway/security>
- Use a strong `SETUP_PASSWORD`
- If you only use chat channels, consider disabling public networking after setup

## What You Get

- OpenClaw Gateway + Control UI at `/` and `/openclaw`
- Setup Wizard at `/setup` (Basic auth protected)
- Optional browser TUI at `/tui`
- Persistent state on Railway volume (`/data`)
- Health endpoint at `/healthz`
- Diagnostics and logs via setup tools + `/logs`

## Quick Start (Railway)

1. Deploy this template to Railway.
2. Ensure a volume is mounted at `/data`.
3. Set variables:
   - `SETUP_PASSWORD` (required)
   - `OPENCLAW_STATE_DIR=/data/.openclaw`
   - `OPENCLAW_WORKSPACE_DIR=/data/workspace`
   - Optional: `ENABLE_WEB_TUI=true`
4. Open `https://<your-domain>/setup` and complete onboarding.
5. Open `https://<your-domain>/openclaw` from the setup page.

## Environment Variables

### Required

- `SETUP_PASSWORD`: password for `/setup`

### Recommended

- `OPENCLAW_STATE_DIR=/data/.openclaw`
- `OPENCLAW_WORKSPACE_DIR=/data/workspace`
- `OPENCLAW_GATEWAY_TOKEN` (stable token across redeploys)

### Optional

- `PORT=8080`
- `INTERNAL_GATEWAY_PORT=18789`
- `INTERNAL_GATEWAY_HOST=127.0.0.1`
- `ENABLE_WEB_TUI=false`
- `TUI_IDLE_TIMEOUT_MS=300000`
- `TUI_MAX_SESSION_MS=1800000`
- `RADIUS_SKILLS_DIR=/data/.openclaw/external-skills/radius-skills`
- `RADIUS_SKILLS_BOOTSTRAP_FROM_IMAGE=true`

### Build-time skills source pinning

This template vendors the Radius skills repo into the image at `/app/vendor/radius-skills`.

By default it tracks `main`, but you can pin a PR commit SHA for same-day testing:

- `RADIUS_SKILLS_REPO` (default: `https://github.com/radiustechsystems/skills.git`)
- `RADIUS_SKILLS_REF` (default: `main`; set to branch or commit SHA)

At container start, vendored skills are copied into persistent storage (`RADIUS_SKILLS_DIR`) when no git checkout exists there yet.

During setup run, OpenClaw config is updated to include that path under `skills.load.extraDirs` (the documented OpenClaw key for extra shared skill folders).

For Phase 3.1 runtime contract alignment, setup also ensures `plugins.load.paths` includes `RADIUS_SKILLS_DIR/adapters/openclaw`, so any valid native OpenClaw plugin manifest in the vendored adapter path can be discovered by OpenClaw's plugin loader.

For Phase 3.2 adapter hardening, setup normalizes the vendored Radius OpenClaw adapter into a native plugin contract if it is still scaffold-only:

- creates `adapters/openclaw/openclaw.plugin.json` when missing
- creates `adapters/openclaw/src/index.ts` plugin entrypoint scaffold when missing
- ensures adapter `package.json` has `openclaw.extensions` and `openclaw.runtimeExtensions` metadata

This keeps runtime discovery deterministic while we finish tool implementation in Phases 3.4/3.5.

## Day-1 Setup Checklist

- Confirm `/setup` loads and accepts password
- Run onboarding once
- Verify `/healthz` returns `{ "ok": true, ... }`
- In setup status card, confirm Radius skills source and discovered count are shown
- Open `/openclaw` via setup link
- If using Telegram/Discord, approve pending devices from setup tools

## Chat Token Prep

### Telegram

1. Message `@BotFather`
2. Run `/newbot`
3. Copy bot token (looks like `123456789:AA...`)
4. Paste into setup wizard

### Discord

1. Create app in Discord Developer Portal
2. Add bot + copy bot token
3. Invite bot to server (`bot`, `applications.commands` scopes)
4. Enable required intents for your use case

## Web TUI (`/tui`)

Disabled by default. Set `ENABLE_WEB_TUI=true` to enable.

Built-in safeguards:

- Protected by `SETUP_PASSWORD`
- Single active session
- Idle timeout
- Max session duration

## Local Smoke Test

```bash
docker build -t openclaw-railway-template .

docker run --rm -p 8080:8080 \
  -e PORT=8080 \
  -e SETUP_PASSWORD=test \
  -e OPENCLAW_STATE_DIR=/data/.openclaw \
  -e OPENCLAW_WORKSPACE_DIR=/data/workspace \
  -e ENABLE_WEB_TUI=true \
  -v $(pwd)/.tmpdata:/data \
  openclaw-railway-template
```

- Setup: `http://localhost:8080/setup` (password: `test`)
- UI: `http://localhost:8080/openclaw`
- TUI: `http://localhost:8080/tui`

## Troubleshooting

### Control UI says disconnected / auth error

- Open `/setup` first, then click the OpenClaw UI link from there.
- Approve pending devices in setup if pairing is required.

### 502 / gateway unavailable

- Check `/healthz`
- Run doctor from setup (`openclaw doctor --repair`)
- Verify `/data` volume is mounted and writable

### Setup keeps resetting after redeploy

- `OPENCLAW_STATE_DIR` or `OPENCLAW_WORKSPACE_DIR` is not on `/data`
- Fix both vars and redeploy

### TUI not visible

- Set `ENABLE_WEB_TUI=true`
- Redeploy and reload `/setup`

## Useful Endpoints

- `/setup` - onboarding + management
- `/openclaw` - Control UI
- `/healthz` - public health
- `/logs` - live server logs UI

## Support

Need help? Open an issue or use Railway Station support for this template.
