# tray-console-kit

Drive Tray's console from a script, for the things that have no API behind them.

Some things Tray's console can do have no API at all — registering an API
Management operation, creating an agent tool, renaming a step. Others have one
that is private or capped. These scripts drive the UI for those, and call the API
where there is one worth calling.

Everything here is generic; the only project-specific part is a config file the
consuming project owns.

## Install

```bash
npm i -D file:../tray-playwright-kit/console   # path to this folder
cp node_modules/tray-console-kit/example.config.mjs ./tray-console.config.mjs
```

Edit `tray-console.config.mjs` with your workspace and project ids. The kit finds
it by walking up from wherever you run, so any subdirectory works.

## Use

```bash
npx tray-console login       # once — sign in, then close the window
npx tray-console browser     # leave running; every other script attaches to it
npx tray-console --help      # the full list
```

**They all share ONE browser.** `browser` launches Chromium once with a
persistent profile and a debugging port; everything else connects to it. Nothing
launches its own, and no session token is ever written to a file.

The profile lives at `~/.config/tray/ui-profile`. Signing in writes the session
there and later runs are simply already signed in — there is no moment to detect
and nothing to save. If a script says it bounced to sign-in, run `login` again.

Both open Tray's normal sign-in (`app.tray.io` → email and password, Google, or your company's
SSO). If your account only signs in from an identity provider's dashboard, start there instead:
`TRAY_LOGIN_URL=https://<your-idp>/ npx tray-console browser`.

## Configuration

`tray-console.config.mjs` exports:

| | |
|---|---|
| `ENVIRONMENTS` | **required.** Workspace and project ids per environment. The FIRST is the default — put the least dangerous one first. |
| `MIGRATIONS` | only for the APIM scripts: which workflow becomes which operation path |
| `EXCLUDED` | workflows deliberately not migrated, with the reason |

`apiHost` is derived from `projectId`, so it cannot drift out of step.

Resolution order: `--config <path>`, then `TRAY_CONSOLE_CONFIG`, then the
nearest `tray-console.config.mjs` at or above the working directory.

---


## What each one is for

### Reconnaissance — read-only, safe to run any time

| | |
|---|---|
| `inspect-operations` | Dumps the Operations form's controls and screenshots it |
| `inspect-agent-tools` | Same for the Merlin Agent Builder Tools tab, drilling tab → Add tool → Custom tool |
| `list-operations` | The project's registered operations |
| `inspect-access-control [env]` | The project's APIM clients, roles and policies |
| `workflow-url <ws> <proj> <workflowId>...` | A webhook-triggered workflow's public URL, which the Build API does not expose |
| `helix-logs` | A Helix app's Logs tab: `helix-logs <logs-url> [--since 24h] [--errors] [--grep /api] [--id execId] [--json]` |

**Run the inspector before writing anything that clicks.** Both registrars below
carry field-by-field descriptions of their forms that were read off the screen,
not inferred, and both headers record what guessing would have cost.

### APIM operations

```
swap-triggers        →  register-operations.mjs
(step 1: the trigger)       (step 2: the operation)
```

Order is not a preference. The operation form's workflow dropdown lists only
workflows that ALREADY carry an `api-operation-trigger` or `agent-tool-trigger`,
so you cannot pre-register and migrate afterwards.

`register-via-api` is the same registration through the endpoint the console
itself calls, for the case the form cannot reach: **the dropdown is capped at 16
entries**, does not scroll and has no search, so a project with more API-triggered
workflows than that cannot bind the seventeenth by clicking.

`swap-trigger-to <workflowId> "<Trigger label>" [env]` is `swap-triggers` for one
workflow and any trigger type, not only API Operation.

### Agent (MAB) tools

`register-agent-tools` creates tools from a JSON file of
`{ name, description }`.

**It mints a new workflow each time.** The dialog says so — "we will create the
workflow, operation, and assign it to the agent" — and it was measured: creating
two tools moved the project 7→9 tools, 25→27 workflows, 23→25 operations.
Deleting them put all three back. To expose a workflow you ALREADY have, use the
APIM pair above instead.

The description is not documentation. An agent chooses tools by reading them, so
it is the dispatch logic.

### Pushing committed content into Tray

| | |
|---|---|
| `set-agent-scope <file>` | The agent's system prompt, from a committed markdown file |
| `set-script-step <workflowId> <stepName> <file>` | A committed script file into a workflow's `script` step |
| `set-step-title` | Renames a step; `update_workflow_steps` takes properties, not titles |
| `set-step-auth` | Attaches an existing authentication to a step. The API accepts `authUuid` and silently ignores it |

### Data tables

Through the console's own internal endpoints (treat them as unstable). Rows are keyed by
column ID on the wire; these scripts translate from column names.

| Script | What it does |
|---|---|
| `rename-datatable-columns <ws> <proj> <tableId> name1,name2,...` | Names the `Column 1 … Column N` a scripted table is created with |
| `load-datatable-rows <ws> <proj> <tableId> <rows.json> [--key col]` | Bulk-loads rows; `--key` skips rows that already exist |
| `reset-datatable <ws> <proj> <tableId> (--empty \| --from rows.json) --yes` | Empties a table, or empties and reloads it from a file |

### Workspace actions with no API

All use the signed-in `browser` session and read the result back before reporting success.

| Script | What it does |
|---|---|
| `restore-workflow-version <id> [<versionId> [--dry-run]]` | No version: lists versions. With one: saves it back as the current version, steps and structure exactly |
| `agent-model [--provider P [--auth A [--model M]]] [--set]` | Shows an agent's model, lists providers/auths/models, or (with `--set`) changes it |
| `create-auth --service S (--show \| --name N --field "Label=value"...)` | Creates an authentication. Values can be `@env:VAR` or `@file:path`. OAuth stops at the consent screen for a human |
| `delete-project <id> --confirm "<exact name>" \| --dry-run` | Deletes a project and its workflows. The name must match |
| `console-mcp list \| call <tool> '<json>'` | Calls Tray MCP tools as the console user. Id-addressed tools only; workspace-wide ones need the MCP's own OAuth |

### Shared

`tray-console.config.mjs` is the environment table and the migration plan every APIM script
reads. A new environment goes in `ENVIRONMENTS` there and nowhere else.

### Running any of them from a Tray workflow

`runner` is a second long-lived process beside `browser`. It asks Tray for
work, runs the named script here, and posts the outcome back.

```bash
npx tray-console browser   # window one — sign in, leave open
npx tray-console runner    # window two — leave running
```

The Tray side is yours to build: a job table and three workflows, the same
contract the RPA bot uses. It is described in full in
[`bot/README.md`](../bot/README.md#the-tray-side-you-build). For this lane:

- the caller passes `{ script: "list-operations.mjs", args: ["prod"], lane: "console" }`.
  `script` is a file name in `src/`, `args` a list of command-line strings; an
  object is refused.
- the runner reports `{ job_id, status, result }` with status `done` (exit code 0)
  or `failed`, and result `{ exit_code, timed_out, stdout, stderr, duration_ms }`,
  output tail-first and capped at 4000 characters each.

**`lane: "console"` is not optional.** The default lane, `bot`, belongs to the
containerised RPA bot in [`bot/`](../bot/), which carries a completely different
set of scripts. Two bots sharing a lane race for jobs and fail each other's, each
claiming one that names a script it does not have. This runner claims `console`
(or `PW_RUNNER_LANE`) and nothing else.

**These scripts cannot move into that container**, which is the whole reason
there are two lanes: they attach to a Chromium a person signed into by hand, and
there is no signed-in profile in an image.

**It polls rather than listens because a laptop has no address.** Everything here
needs the signed-in browser, that browser is behind NAT, and a tunnel would be a
second thing to keep alive. So Tray never calls us: two webhook workflows
(claim and complete) hand out work and take results back,
and the runner drives both. A closed lid is a runner that stopped asking, which
the caller sees as `timeout` rather than as a lie.

Put the two webhook URLs — copied from each workflow's trigger step in the Tray
UI — in `~/.config/tray/playwright-runner.json`, or set `TRAY_CLAIM_URL` and
`TRAY_COMPLETE_URL`:

```json
{ "claim_url": "https://...", "complete_url": "https://..." }
```

**Those URLs are the only credential**, so treat them like passwords. The
allowlist is the other half of that: `runner` refuses anything that is not a
bare `.mjs` filename already in `src/`, because without it the claim
webhook is a remote shell on your machine.

The complete workflow should write the result BEFORE the status, deliberately — the
caller polls for `done`/`failed`, so the other order would let it read a settled
job with an empty result.

#### Three things measured while building it

**`break-loop` TERMINATES the execution.** Not "breaks out of the loop" — the run
settles as `failed_step` and nothing after the loop runs. Verified on a throwaway
with the break as the sole step of a one-item `loop_array`, so it is not the
surrounding branch and not `loop_forever`: the step emits `#control_flow: break`
and that is the end of the workflow. So the calling workflow should poll a FIXED
number of slots instead, and the settled iterations skip the wait rather than
leaving early. That is also why the interval is 10s rather than 2s — every slot
is paid for whether it is needed or not, so fewer, longer waits cost less, at the
price of up to 10s of latency after a script finishes.

**The `data-tables` connector is asymmetric: write by column ID, read by column
name.** `create_row` and `update_cell_in_row` reject names —
`400 Invalid column ids Column 1,… provided in properties` — while `lookup_row`
returns its `properties` keyed `"Column 1"` … `"Column 6"`. The write field's own
schema describes itself as *"The name of the column"*, which is what cost the
first fire. Read defensively across the shapes in the claim workflow's script
step, and return the keys it saw so a run says which one it got.

**Columns cannot be renamed through the public API**, so a scripted table reads
Column 1 … Column 6. Either keep the mapping (job_id, status, script, args,
result, updated_at) in the table's description and each step's title, or name them
with `rename-datatable-columns`.

---

## Two habits these scripts keep

**Verify by outcome, never by the click.** `register-operations` calls each
operation after saving and asserts it is not a 404; `register-agent-tools`
reloads and re-reads the tools table. "The form submitted" and "the thing exists"
are different claims and only the second one matters — a UI script that trusts
its own clicks is how you get thirteen silent failures.

**A tall viewport is load-bearing.** Every script sets 1500×1300. The create
forms run past the fold at 950px and Playwright then refuses to click, reporting
*"Element is outside of the viewport"* — which reads like a selector bug and is
not. Screen resolution does not matter; the viewport is set in code.

## If you are handing these to someone else

The only thing that does not travel is the login. There is no token in the repo
and none is written to one — each person runs `login` against their own Tray
account, and the scripts inherit whatever that account can do.

## After registering an operation: 403 usually means DISABLED, not unauthorised

`register-via-api` registers the operation and nothing else. The workflow behind it stays
**disabled**, and a disabled workflow answers **403** — which reads exactly like an
authorisation failure and is not.

| Probe | Meaning |
|---|---|
| `404` | The operation does not exist. Registration failed, whatever the POST returned. |
| `403` | Usually the WORKFLOW is disabled. Enable it and probe again before touching access control. |
| `200` | Registered, enabled, and the caller is authorised. |

Measured: a newly registered operation answered 403 in a project with one client, one role and
**zero policies**, where the same client already called another operation successfully.
Enabling the workflow turned the 403 into a 200 with no access-control change at all.

What the access-control model is NOT: there is no role-to-operation binding to find.
`api/policies` returns an empty list, `api/roles/<name>` carries only a name and description,
an operation record has no `roles` field, and `api/roles/<name>/operations` and
`api/operations/<id>/roles` both 404. Clients hold roles; nothing observable binds a role to an
operation. Do not go looking for it; `inspect-access-control` shows everything there is.

## Use the Tray Sync CLI instead

These used to be scripts here. The Tray Sync CLI does them with an API token, so they are not
duplicated in this kit. Its `api` group is hidden until you set `TRAY_CLI_API_ENABLE=true`.

```bash
npm install -g @trayai/tray-sync-cli
export TRAY_CLI_API_ENABLE=true TRAY_API_REGION=us1   # then: tray api login -r us1, or TRAY_API_TOKEN

tray api workflow enable <workflowId>            # or: disable
tray api workflow edit <workflowId> '{"description": "..."}'   # also name, tags, alerting_workflow
tray api workflow show <workflowId> --format json > workflow.json   # the raw /v2/workflows response
```

## Two operational notes

- **`register-via-api` is not only for the dropdown cap.** It registers a single new operation
  perfectly well, with one `MIGRATIONS` entry — you do not need to be past sixteen workflows to
  reach for it.
- **The shared browser can die mid-session.** Restart it with
  `npx tray-console browser` (or `node bin/tray-console.mjs browser`). The profile at
  `~/.config/tray/ui-profile` is persistent, so the hand-signed-in session survives the restart.
  Playwright's `attach()` can also hang for minutes against a busy console; driving raw CDP
  (`Target.attachToTarget` + `Runtime.evaluate`) is markedly faster.
