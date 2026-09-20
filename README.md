# Job Scout

A local job discovery and application drafting app built with Bun, TypeScript, SQLite, Playwright, and LocalBase.

## Setup

Install Bun and LocalBase, then run:

```sh
bun install
cp .env.example .env
cp preferences.example.json preferences.json
bunx playwright install chromium
```

Set your LocalBase API key in `.env`. Set `RESUME_MCP_URL` to your compatible résumé MCP endpoint. The connector expects `get_resume` and `get_experience` tools, with the record schemas defined in `src/connectors.ts` and `src/domain.ts`. The complete résumé and experience records are cached locally. Ordinary draft chat reads the cache without contacting the MCP.

```sh
bun run jobs profile
bun run start
```

Open http://127.0.0.1:4317 and adjust your goals and filters. Enable automatic refresh to search every 24 hours while the service is running. Search now starts an earlier run. Sources and collection limits are configured in `browser-sources.json`. Collection is bounded and some sites may reject browser access.

## Applications

The app captures listing URLs and visible application questions. Drafts answer individual questions using cached experience. Each answer supports AI revision, before/after review, and restoring earlier versions. LocalBase handles inference; there is no hosted model fallback. Review answers and factual claims before using them. The app does not submit applications.

Shared writing prompts live in `prompts/`. Personal reviewed answers can be stored in `prompts/jobs/<job-id>.json`; that directory is excluded from Git.

## Browser help and LAN access

Optional Docker infrastructure provides Chromium with noVNC:

```sh
docker compose up -d --build --wait
```

Set `"browserTransport": "novnc"` in local `runtime.json` to use it. VNC and CDP ports bind to loopback. Login and CAPTCHA completion require a person.

Configure email sender and recipient through `JOB_SCOUT_ALERT_SENDER` and `JOB_SCOUT_ALERT_RECIPIENT` in `.env`. Generate the private SMTP setup link with your host's LAN address and subnet mask:

```sh
bun scripts/setup-mail.ts LAN_ADDRESS SUBNET_MASK
bun scripts/setup-remote.ts
```

Restart the service after initial setup. These scripts print private single-use links; do not share or commit them. Check the displayed certificate fingerprint before trusting the local self-signed certificate. SMTP credentials are encrypted in the local data directory. Email alerts generate a fresh single-use help link for every send attempt. Links last 24 hours; authenticated phone sessions last 30 minutes.

With LAN setup configured, the dashboard uses HTTPS port 4317 without a password on the configured subnet. Only enable this on a trusted home network. Mail setup uses port 4318 and browser help uses port 4319, both with private unlock flows. Do not expose these services to the public internet.

On macOS, `bun run service install` installs a user LaunchAgent. Use `bun run service stop` or `bun run service uninstall` to stop it.

## Checks

```sh
bun run check
bun test
bun run check:http
bun run validate:data
```

`bun run smoke` uses local inference and your cached profile, writing its results to ignored reports. Integration checks may require configured local services.

## Private local files

The repository uses a default-deny root ignore policy. Only reviewed source directories, dependency files, and sanitized templates are included. Local `.env` files, preferences, runtime configuration, résumé caches, jobs, screenshots, browser profiles, SMTP credentials and keys, certificates, drafts, chat history, reports, and personal job prompts remain on the host. Do not force-add ignored files.
