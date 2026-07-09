// Shared types for the headless devtools core (`@shipeasy/sdk/devtools`).
// Framework-agnostic: no DOM, no React, no React Native imports. The RN overlay
// (`@shipeasy/sdk/react-native-devtools`) and any future surface consume these.

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

export interface GateRecord {
  id: string;
  name: string;
  enabled: boolean;
  killswitch: boolean;
  rolloutPct: number;
  updatedAt: string;
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
