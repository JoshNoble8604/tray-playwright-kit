/**
 * Copy this to `tray-console.config.mjs` in your project's root.
 *
 * ENVIRONMENTS is required. MIGRATIONS is only needed if you are moving
 * workflows from public webhooks onto API Management operations.
 */

export const ENVIRONMENTS = {
  // The FIRST entry is the default when no environment is named. Put the
  // least dangerous one first — a script run without arguments should not
  // reach production.
  dev: {
    label: "Acme (dev)",
    workspaceId: "00000000-0000-0000-0000-000000000000",
    projectId: "11111111-1111-1111-1111-111111111111",
    // apiHost is derived from projectId; override only if yours differs.
  },
  prod: {
    label: "Acme (production)",
    workspaceId: "22222222-2222-2222-2222-222222222222",
    projectId: "33333333-3333-3333-3333-333333333333",
  },
};

export const MIGRATIONS = [
  {
    key: "order-sync",
    path: "/order-sync",
    // EXACTLY as the operation form's workflow dropdown shows it. The script
    // selects on this string, so a paraphrase silently picks nothing.
    workflowName: "Sync orders to ERP",
    workflowId: "cccccccc-cccc-cccc-cccc-cccccccccccc",
    // Where the caller reads the URL and token, so "the workflow moved" and
    // "the caller knows" cannot drift apart.
    envUrlVar: "TRAY_ORDER_SYNC_URL",
    envTokenVar: "TRAY_ORDER_SYNC_TOKEN",
  },
];

/** Workflows deliberately NOT migrated, with the reason. */
export const EXCLUDED = [
  {
    key: "card-submit",
    why: "Its URL is rendered into an Adaptive Card and called by Teams. APIM authenticates with a bearer and a card cannot present one.",
  },
];
