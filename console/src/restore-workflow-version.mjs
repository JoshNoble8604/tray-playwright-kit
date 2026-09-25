/**
 * Put a workflow back to one of its saved versions — steps and structure exactly.
 *
 *   tray-console restore-workflow-version <workflowId>                 # list versions
 *   tray-console restore-workflow-version <workflowId> <versionId> [--dry-run]
 *
 * WHY. The Tray MCP has no restore tool and API tokens 404 on the builder API.
 * The console's own session can write through it: PUT
 * /v2/workflows/<id>/versions/<currentVersion> with RemoveStep / SetStepData /
 * CreateStep operations plus the target's structure. One atomic save, then a
 * read-back that must match the target step for step, or it exits 1.
 *
 * WHY A VERSION, NOT A REBUILD. `remove_workflow_step` deletes a step's data and
 * version history cannot bring it back; a whole saved version can.
 */
import { environment } from "./config.mjs";
import { consoleSession, run } from "./session.mjs";

const [workflowId, versionId] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dry = process.argv.includes("--dry-run");
if (!workflowId) {
  console.error("usage: tray-console restore-workflow-version <workflowId> [<versionId> [--dry-run]]");
  process.exit(1);
}

const env = await environment(process.env.TRAY_ENV);
const s = await consoleSession(`https://app.tray.io/workspaces/${env.workspaceId}/projects/${env.projectId}/workflows`);
const wf = `/v2/workflows/${workflowId}`;

await run(s, async () => {
  const cur = await s.api("GET", wf);
  const steps = (d) => d.data.map((x) => x.name).join(", ");

  if (!versionId) {
    const { versions } = await s.api("GET", `${wf}/versions`);
    console.log(`${cur.unversioned_data.name} — ${versions.length} versions, newest last:`);
    for (const v of versions)
      console.log(`  ${v.version_id}  ${v.created}${v.version_id === cur.version.version_id ? "  ← current" : ""}`);
    return;
  }

  const tgt = await s.api("GET", `${wf}/versions/${versionId}`);
  console.log(`current ${cur.version.version_id}: ${steps(cur)}`);
  console.log(`target  ${versionId}: ${steps(tgt)}`);

  // auth_uuid comes back as a bare string or {value}; the save wants {value}.
  const meta = ({ auth_uuid: a, ...rest }) =>
    a ? { ...rest, auth_uuid: { value: typeof a === "string" ? a : a.value } } : rest;
  const curNames = new Set(cur.data.map((x) => x.name));
  const tgtNames = new Set(tgt.data.map((x) => x.name));
  const operations = [
    ...cur.data.filter((x) => !tgtNames.has(x.name)).map((x) => ({ type: "RemoveStep", name: x.name })),
    ...tgt.data.map((x) => ({
      type: curNames.has(x.name) ? "SetStepData" : "CreateStep",
      name: x.name,
      metadata: meta(x.metadata),
      properties: x.properties,
    })),
  ];
  const changes = operations.filter((o) => o.type !== "SetStepData").map((o) => `${o.type} ${o.name}`);
  console.log(`plan: ${changes.join(", ") || "no steps added or removed"}; SetStepData on ${operations.length - changes.length} shared steps`);
  if (dry) return console.log("--dry-run: nothing saved");

  await s.api("PUT", `${wf}/versions/${cur.version.version_id}`, { operations, structure: tgt.structure });

  const after = await s.api("GET", wf);
  const norm = (d) =>
    JSON.stringify(d.data.map((x) => [x.name, x.metadata.connector, x.metadata.operation, x.properties]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  if (norm(after) !== norm(tgt) || JSON.stringify(after.structure) !== JSON.stringify(tgt.structure))
    throw new Error(`saved as ${after.version.version_id} but it DIFFERS from ${versionId}`);
  console.log(`✓ saved as new version ${after.version.version_id}, matching ${versionId}`);
});
