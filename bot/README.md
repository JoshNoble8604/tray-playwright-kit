# `playwright-bot` — RPA for Tray workflows

A Tray workflow calls one callable and gets back what a browser did:

```
run-playwright-script  { script: "smoke-check", args: { url: "https://example.com" } }
                    →  { job_id, status: "done", result: { title: "Example Domain", … } }
```

The browser work happens in this container. Tray holds the queue and waits.

---

## How the trigger actually works

**The workflow is the trigger.** Nothing runs unless a Tray workflow enqueues it,
and the caller blocks until the bot reports back.

The HTTP goes the other way, and that trips people up. The bot dials Tray, not
the reverse — the same arrangement as a CI runner polling for builds, which
nobody describes as "builds triggered by the runner". Direction of connection is
not direction of control.

```
Tray cloud                                    the bot container
──────────                                    ─────────────────
run-playwright-script
  writes a job row, lane "bot"
  polls that row, waiting
                              ← claim ─────── runner.mjs
                                                 │ resolves automations/<name>.mjs
                                                 │ launches Chromium, runs it
                                                 ▼
                                              the app being automated
                              ─── result ───→ runner.mjs
  row settles, poll sees it,
  callable returns to its caller
```

Polling is what lets the bot sit anywhere — behind a NAT, on a private subnet,
inside the VPN with the apps it drives — with no inbound port, no tunnel and no
public certificate. It also keeps the failure mode honest: a bot that is down
stops asking, and the caller gets `timeout` rather than a connection error
dressed up as a result.

---

## Running it

```bash
cp .env.example .env          # then paste the two webhook URLs in
npm install
npm start                     # locally, HEADLESS=false to watch it work

npm run docker:build          # stamps the git sha into every result
npm run docker:run
```

The two URLs come off the trigger step of the claim and complete workflows you
build in Tray (next section).

**Those URLs are the only credential.** Anyone holding the claim URL can make
this bot run any automation it carries; anyone holding the complete URL can
settle a job with a result of their choosing. Treat both as passwords.

---

## The Tray side you build

Nothing in Tray ships with this. You build one data table and three workflows,
and both this bot and the console runner (`console/src/runner.mjs`) speak to them.

**The job table** — six columns: `job_id`, `status`, `script`, `args`, `result`,
`updated_at`. `status` is `pending:<lane>` while queued, then `running`, then
`done` or `failed`.

**Claim** — a webhook workflow. The bot POSTs

```json
{ "lane": "bot" }
```

and it looks up one row with status `pending:<lane>`, sets it `running`, and
replies with either

```json
{ "found": false }
{ "found": true, "job_id": "…", "script": "smoke-check", "args": { "url": "https://example.com" } }
```

`script` is an automation name (the bot also accepts it with `.mjs`); `args` is an
object for this bot and a list of strings for the console lane.

**Complete** — a webhook workflow. The bot POSTs

```json
{ "job_id": "…", "status": "done", "result": { … } }
```

where `status` is `done` or `failed`, and it writes `result` then `status` onto the
row. It must answer 2xx with a JSON body (`{ "ok": true }` is enough); anything
else counts as a failed report and is retried. `result` from this bot is

```
{ ok: true,  data, log, duration_ms, revision }     // data capped at MAX_RESULT_CHARS
{ ok: false, error, duration_ms, revision }
```

**`run-playwright-script`** — the callable your other workflows use. Input
`{ script, args, lane = "bot", timeout_seconds }`; it writes a `pending:<lane>`
row with a fresh `job_id`, polls that row until it settles, and returns
`{ job_id, status, result }` with status `done`, `failed` or `timeout`.

---

## Writing an automation

One file in `automations/`, and it is live on the next deploy — no workflow edit,
no registration step.

```js
export const meta = {
  description: "one line, for whoever reads the registry",
  secrets: ["PORTAL_USERNAME", "PORTAL_PASSWORD"],   // optional
  timeoutMs: 180_000,                                // optional
};

export async function run({ page, context, args, secrets, log, artifact }) {
  return { anything: "JSON-serialisable" };
}
```

`automations/EXAMPLE-portal-invoice.mjs.txt` is a worked example of a real one —
a `.txt` so the registry cannot load it. `smoke-check.mjs` is a live automation
that needs no credentials, which is what to run first when a deploy looks wrong.

Four habits worth keeping:

**Declare secrets; never read `process.env` inside `run()`.** They are resolved
before a browser launches, so a missing password fails in a sentence rather than
as a timeout on a login page.

**Verify by outcome, never by the click.** "The search box accepted my text" and
"this is the invoice I asked for" are different claims and only the second is
worth anything. A portal that silently ignores a filter returns the wrong record,
successfully.

**Return data, not a status.** The calling workflow wants the amount and the due
date. `{ ok: true }` makes it scrape the log.

**Save evidence for anything irreversible.** `artifact(name, bytes)` writes under
`/artifacts/<job_id>/`, and a failure screenshots the page automatically before
the browser closes.

---

## Lanes

A job is enqueued into a lane and only a bot on that lane can claim it.

| lane | bot | runs |
|---|---|---|
| `bot` (default) | this container | everything in `automations/` |
| `console` | `console/src/runner.mjs` in this repo, on a laptop | the Tray-console scripts, against a human's signed-in Chromium |

The second one cannot move into this container: it drives a browser profile a
person signed into by hand, and there is no profile in an image.

**Lanes are not optional decoration.** Two bots sharing a lane race for jobs, and
two bots with different automations sharing a lane also FAIL each other's — each
claims a job naming a script it does not have. Give a bot with a different script
set a different lane.

The lane rides inside the status value (`pending:bot`) rather than in a column of
its own, because `lookup_row` filters on exactly one column. Settlement is still
plain `done` / `failed`, so nothing downstream has to know lanes exist.

---

## Things that were measured, not assumed

**`break-loop` terminates the execution.** Not the loop — the run settles
`failed_step` and nothing after the loop happens. Verified on a throwaway with
the break as the sole step of a one-item `loop_array`, so it is neither the
surrounding branch nor `loop_forever`. That is why `run-playwright-script` polls
a fixed number of slots and the settled iterations skip the wait instead of
leaving early, and why the interval is 10s rather than 2s: every slot is paid for
whether needed or not, at the price of up to 10s of latency after a job settles.

**The `data-tables` connector is asymmetric — write by column ID, read by column
name.** `create_row` rejects names (`400 Invalid column ids Column 1,…`) while
`lookup_row` returns properties keyed `"Column 1"`. The write field's own schema
calls itself *"The name of the column"*, which is what cost the first fire.

**`lookup_row` does NOT error when nothing matches.** It SUCCEEDS and comes back
without a `properties` key — and a jsonpath onto a missing value fails the STEP,
not the field. So an empty queue, the commonest state there is, answered every
poll with

```
500 Reference: $.steps.data-tables-1.properties … did not resolve to any value
```

which reads like a broken step and is an empty table. The manual error path built
for it never fired, because the step never failed. `script-1` takes the whole
`$.steps.data-tables-1` output instead and decides emptiness in code that can say
so. Found by curling the live webhook before starting the bot.

**Data table columns cannot be renamed through the public API**, so a scripted
job table reads Column 1 … Column 6. Keep the mapping in the table's description,
or name them with `console`'s `rename-datatable-columns`.

**A webhook URL is `https://<routingId>.trayapp.io`**, and `routingId` appears
ONLY in `get_workflow view:"full"` (under `unversionedData`) — not in `metadata`,
and not on any REST path that answered. So reading a webhook URL costs a full
workflow dump. Both webhook workflows also arrived **disabled**; a disabled
webhook is simply unreachable, so enable them after any structural change.

**`callable-workflow-response` "fails" on a test fire** — *"must be called by
Call Workflow step with operation 'fire and wait for response'"* — because a test
fire has no calling workflow to answer. The step's INPUT is the real payload.
Same shape as `trigger-reply` on a test fire.

---

## Speed, measured

`helix-demo-walk` runs in **~7s** headless (median of 3, screenshots off);
~11-14s with screenshots and the retries below. Two cross-domain page loads are
most of it, so there is not much fat to cut. Two things that look like wins and
are not:

| tried | result |
|---|---|
| Blocking images, fonts, media and analytics | **Slower** — median 8.0s vs 7.4s. Not adopted |
| Hovering menus open instead of clicking | **Much slower** — median 17.2s, 6 failed gestures in 3 runs. Hover does not open these menus at all |

What DID help: dropping the retry's first probe from a flat 5s to 1.2s. A menu
that opens does so in about 50ms, so a long first wait is pure dead air on the
common path.

The remaining lever is browser reuse across jobs (~200ms a run, and it risks
leaking state between automations). Not worth it yet.

## Resilience

**Handled, and each one verified rather than assumed:**

| risk | what happens |
|---|---|
| A page not interactive yet | Menus are clicked up to 3× with escalating waits, until a probe element proves the menu is open. On the last run this fired 3× on one menu and 2× on the other — it is load-bearing, not belt-and-braces |
| The bot reports a result and the network drops | The completion POST retries 5× over ~52s, then writes `unreported-result.json` into the job's artifact dir. The work was done; losing the receipt would make a human re-run it |
| A hung connection | Every request has a 30s timeout. Without one the loop stalls and the bot looks switched off |
| Two bots on one lane | Refused by a PID lock, naming the process to kill. Different lanes still run side by side; a stale lock from a killed bot is taken over |
| A job that fails | Screenshot of the page as it stood, plus the video if recording — captured BEFORE the browser closes |
| Tray briefly unreachable | Claims just retry. A failed claim costs nothing: the job is still queued |
| Ctrl-C mid-job | Finishes the job in hand, then stops. Abandoning it would strand the row as `running` |

**Two scheduled workflows worth building to watch the system itself:**

**`reap-stale-jobs`** — every 15 minutes. Marks as `failed` any job left
`running` or unclaimed for over 30 minutes, writing WHY into the row: whether a
bot claimed it and died, or no bot ever came for it. Without this a dead bot
leaves rows that look like live work and nothing anywhere says it died.

Make the threshold longer than any job can live — if `run-playwright-script`
polls at most 90 slots of 10s, that is 15 minutes — so it cannot reap a job somebody is
still waiting on. Reaping a live job would be much worse than leaving a dead one:
the caller would be told `failed` for work still running, and for anything
irreversible that invites a human to do it twice. A row whose timestamp will not
parse is left alone for the same reason — "I cannot tell how old this is" must
never mean "delete it".

**`check-automations-still-work`** — every hour. Runs an automation such as
`helix-demo-walk` for real and FAILS the workflow if it did not complete, which
puts it into Tray's own error alerting: a channel that already exists and already
reaches somebody, with no new integration to keep alive. It separates the two
causes, because they need different people:

| it says | what broke | who fixes it |
|---|---|---|
| `no bot picked the job up` | the container is not running | whoever runs the host |
| `ran and FAILED, the site has probably changed` | a renamed button, a moved menu | whoever maintains the automation |

Collapsing those into "the check failed" would send somebody to read Playwright
selectors when the real answer is that a container is off.

**Leave it off until the bot runs permanently** — enabled early, it alerts every
hour that a bot is missing. Turn it on in the same change that makes the bot
always-on.

**Still not handled:**

1. **One job at a time**, so a slow automation blocks the lane. Deliberate; the
   fix is more bots, not concurrency inside one.
2. **No retry of a whole failed job.** That belongs to the calling workflow,
   which knows whether the action was safe to repeat. The bot must not guess.
3. **Artifacts stay on the bot.** Nothing ships them to Tray or object storage,
   so evidence lives only as long as the volume.

## What this does not do yet

- **No queue backpressure.** A flood of jobs queues in the table and the caller
  times out; nothing sheds load or warns.

See **Resilience** above for the rest, with the gaps ranked.
