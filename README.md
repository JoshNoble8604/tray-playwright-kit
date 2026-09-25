# tray-playwright-kit

Playwright tooling for Tray, in two parts:

| Folder | What it does |
|---|---|
| [`console/`](console/) | **tray-console**: drives the Tray console from a signed-in browser for things with no API, such as registering APIM operations, creating agent tools and auths, swapping triggers, restoring workflow versions, changing an agent's model, deleting projects and reading Helix logs. |
| [`bot/`](bot/) | **playwright-bot**: an RPA runner. A Tray workflow queues a job, the bot claims it, runs an automation in Chromium and reports the result back. You build the Tray-side queue workflows; the contract is in `bot/README.md`. |

> Not an official Tray product. Most scripts drive the console UI or call private console
> endpoints, so a Tray release can break them; each script reads its result back and fails
> loudly when that happens. Hosts are currently the US region (`app.tray.io`, `api.tray.io`).

MIT licensed, see [LICENSE](LICENSE).

## Setup

```bash
npm install                                  # installs both workspaces
npx playwright install chromium
cp console/example.config.mjs tray-console.config.mjs   # set your workspace and project ids
```

## Console scripts

```bash
npm run console -- login      # once: sign in, then close the window
npm run console -- browser    # leave running; every other script attaches to it
npm run console -- --help     # full script list
```

## Helix logs

The Helix CLI has no logs command. This reads the same data as the Logs tab at app.helix.tray.ai, using your signed-in `browser` session:

```bash
npm run console -- helix-logs <paste the Logs tab URL> --since 7d --errors
npm run console -- helix-logs <url> --id <executionId>   # full request, response, operations
```

Other flags: `--grep <route text>`, `--limit <n>`, `--json`.

## Bot

```bash
cp bot/.env.example bot/.env  # claim/complete webhook URLs. Treat them as passwords
npm run bot
```

Details are in each folder's README. `npm run check` syntax-checks every script.

Anything the [Tray Sync CLI](https://tray.ai/documentation/developer/developer-tools/tray-sync-cli) can do (enabling workflows, editing workflow name/description/tags, exporting workflows, promoting projects) is left to it; see `console/README.md`.
