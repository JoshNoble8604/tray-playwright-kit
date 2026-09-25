/**
 * Call the Tray MCP server as the signed-in console user — no OAuth dance.
 *
 *   tray-console console-mcp list
 *   tray-console console-mcp call <tool> '<json args>'
 *
 * WHY. The MCP's own OAuth grant expires and needs an interactive re-auth. The
 * console's bearer is already there.
 *
 * LIMIT, measured: the bearer is not bound to a workspace, and no header or URL
 * binds it. Tools addressed by id work (get_workflow, get_project,
 * list_workflow_executions, list_connectors, ...); workspace-wide ones answer
 * "not bound to a workspace" (list_projects, list_authentications,
 * datatable_list, get_current_workspace).
 * Override the endpoint with MCP_URL.
 */
import { environment } from "./config.mjs";
import { consoleSession, run } from "./session.mjs";

const [mode, tool, args] = process.argv.slice(2);
if (!["list", "call"].includes(mode) || (mode === "call" && !tool)) {
  console.error("usage: tray-console console-mcp list | call <tool> '<json args>'");
  process.exit(1);
}
const input = mode === "call" ? JSON.parse(args ?? "{}") : null;

const env = await environment(process.env.TRAY_ENV);
const s = await consoleSession(`https://app.tray.io/workspaces/${env.workspaceId}/projects`);
const MCP = process.env.MCP_URL ?? "https://api.tray.io/mcp";

let session = null;
let id = 0;
/** One JSON-RPC message. Replies may be plain JSON or a single SSE `data:` line. */
async function rpc(method, params, notify = false) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      authorization: s.auth,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session && { "mcp-session-id": session }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, ...(!notify && { id: ++id }) }),
  });
  session = res.headers.get("mcp-session-id") ?? session;
  if (notify) return;
  const text = await res.text();
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  let msg;
  try { msg = JSON.parse(line ? line.slice(5) : text); } catch { throw new Error(`${res.status} from MCP: ${text.slice(0, 200)}`); }
  if (msg.error) throw new Error(`${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
  return msg.result;
}

await run(s, async () => {
  await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "tray-console", version: "1" } });
  await rpc("notifications/initialized", {}, true);
  if (mode === "list") {
    const { tools } = await rpc("tools/list", {});
    for (const t of tools) console.log(`${t.name.padEnd(34)} ${(t.description ?? "").split("\n")[0].slice(0, 90)}`);
  } else {
    const r = await rpc("tools/call", { name: tool, arguments: input });
    console.log(r.content?.map((c) => c.text ?? JSON.stringify(c)).join("\n") ?? JSON.stringify(r, null, 2));
    if (r.isError) process.exitCode = 1;
  }
});
