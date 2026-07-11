// Shared types for the headless devtools core (`@shipeasy/sdk/devtools`).
// Framework-agnostic: no DOM, no React, no React Native imports. The RN overlay
// (`@shipeasy/sdk/react-native-devtools`) and the browser overlay
// (`@shipeasy/sdk/browser-devtools`) both consume these.
//
// Record interfaces below are the overlays' narrowed *projections* of the
// generated admin OpenAPI responses (./generated) — the subset the panels
// render. Where a projection matches a generated item 1:1 it is derived from
// it (e.g. `UniverseRecord`), so a spec change surfaces as a type error here
// instead of silent drift.

import type { ListUniversesResponse } from "./generated/types.gen";

/** Prod defaults; both overridable per client (local dev, staging). */
export const DEFAULT_ADMIN_BASE_URL = "https://shipeasy.ai";
export const DEFAULT_EDGE_BASE_URL = "https://api.shipeasy.ai";

/** Project capabilities the devtools overlays render against. */
export interface DevtoolsCapabilities {
  /** True when the project opted into public bug intake (Settings →
   *  "Allow public tickets") — shows the "file a public bug" button. */
  allowPublicTickets: boolean;
}

/** A completed device-auth login: the minted admin key + the project it binds. */
export interface DevtoolsSession {
  /** Raw admin SDK key (`sdk_admin_*`). Store securely (Keychain/Keystore). */
  token: string;
  projectId: string;
  userEmail: string | null;
  projectName: string | null;
}

export interface ProjectModules {
  translations: boolean;
  configs: boolean;
  gates: boolean;
  experiments: boolean;
  feedback: boolean;
  user: boolean;
  events: boolean;
}

export interface ProjectRecord {
  id: string;
  name: string;
  domain: string | null;
  modules: ProjectModules;
}

/** One attribute predicate inside a gate condition (e.g. `plan is one of
 *  ["business"]`). Mirrors the admin `GateRule`. */
export interface GateRule {
  attr: string;
  op: string;
  value: unknown;
}

/** One entry in a gate's ordered gatekeeper stack — evaluated top-to-bottom,
 *  first match wins. A subset of the admin `StackedGateEntry` (the fields the
 *  overlay renders). */
export interface GateStackEntry {
  id?: string;
  type?: "condition" | "rollout";
  name?: string;
  /** all rules must match ("all", default) vs any ("any"). */
  pass?: "all" | "any";
  rules?: GateRule[];
  /** 0–10000 basis points. */
  rolloutPct?: number;
  bucketBy?: string;
  locked?: boolean;
  /** True when this condition is a whitelist (its rule's value is the list). */
  whitelist?: boolean;
}

export interface GateRecord {
  id: string;
  name: string;
  enabled: boolean;
  killswitch: boolean;
  rolloutPct: number;
  updatedAt: string;
  /** Legacy flat targeting rules (pre-stack gates). */
  rules?: GateRule[] | null;
  /** The gatekeeper stack (modern gates). Present → drives the flow view. */
  stack?: GateStackEntry[] | null;
}

/** Permissive default schema. Used when a config record arrives without one. */
export const PERMISSIVE_CONFIG_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

export interface ConfigRecord {
  id: string;
  name: string;
  valueJson: unknown;
  /** JSON Schema describing the value shape. Always type="object" post-migration. */
  schema: Record<string, unknown>;
  updatedAt: string;
}

export interface ExperimentRecord {
  id: string;
  name: string;
  /** Name of the universe this experiment runs in. */
  universe: string;
  status: "draft" | "running" | "stopped" | "archived";
  groups: Array<{ name: string; weight: number }>;
  updatedAt: string;
}

export interface ProfileRecord {
  id: string;
  name: string;
  createdAt: string;
  /** 1 when this is the project's default profile (D1 returns the int flag). */
  isDefault?: number;
}

// Derived straight from the generated contract — the overlays render the whole
// universe list item, so there's nothing to narrow.
export type UniverseRecord = ListUniversesResponse["data"][number];

export interface KeyRecord {
  id: string;
  key: string;
  value: string;
  profileId: string | null;
  createdAt: string;
}

export interface DraftRecord {
  id: string;
  name: string;
  profileId: string;
  status: string;
  createdAt: string;
}

/** Subset of the server's `connector_data` the devtools read — just the linked
 *  GitHub PR/issue. The admin endpoints return the full blob; we only type the
 *  fields the overlays render. */
export interface FeedbackConnectorData {
  github?: {
    issue?: { number: number; url: string };
    pr?: { number: number; url: string };
  };
}

export type BugStatus =
  | "open"
  | "pending_approval"
  | "triaged"
  | "in_progress"
  | "ready_for_qa"
  | "resolved"
  | "wont_fix";
/** Lowest tier is `nice_to_have`; shared by bugs + feature requests. */
export type BugPriority = "nice_to_have" | "medium" | "high" | "critical";

export interface BugRecord {
  id: string;
  title: string;
  status: BugStatus;
  priority: BugPriority | null;
  reporterEmail: string | null;
  pageUrl: string | null;
  createdAt: string;
  connectorData?: FeedbackConnectorData | null;
}

export interface AttachmentRecord {
  id: string;
  kind: "screenshot" | "recording" | "file";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BugDetail extends BugRecord {
  stepsToReproduce: string;
  actualResult: string;
  expectedResult: string;
  attachments: AttachmentRecord[];
}

export interface FeatureRequestRecord {
  id: string;
  title: string;
  status: BugStatus;
  priority: BugPriority | null;
  reporterEmail: string | null;
  pageUrl: string | null;
  createdAt: string;
  connectorData?: FeedbackConnectorData | null;
}

export interface FeatureRequestDetail extends FeatureRequestRecord {
  description: string;
  useCase: string;
  attachments: AttachmentRecord[];
}

export interface AttachmentUploadResult {
  id: string;
  filename: string;
  kind: "screenshot" | "recording" | "file";
  mimeType: string;
  sizeBytes: number;
}
