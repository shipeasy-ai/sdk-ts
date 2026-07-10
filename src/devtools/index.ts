// @shipeasy/sdk/devtools — headless devtools core (framework-agnostic).
//
// The data/auth layer behind the devtools surfaces: the admin API client, the
// PKCE device-auth flow, the public bug intake, and the shared form schemas.
// No DOM, no React — the React Native overlay
// (`@shipeasy/sdk/react-native-devtools`) builds on this; so can any other host.

export {
  DEFAULT_ADMIN_BASE_URL,
  DEFAULT_EDGE_BASE_URL,
  PERMISSIVE_CONFIG_SCHEMA,
} from "./types";
export type {
  AttachmentRecord,
  AttachmentUploadResult,
  BugDetail,
  BugPriority,
  BugRecord,
  BugStatus,
  ConfigRecord,
  DevtoolsSession,
  DraftRecord,
  ExperimentRecord,
  FeatureRequestDetail,
  FeatureRequestRecord,
  FeedbackConnectorData,
  GateRecord,
  KeyRecord,
  ProfileRecord,
  ProjectModules,
  ProjectRecord,
  UniverseRecord,
} from "./types";

export { AuthError, DevtoolsClient } from "./api";
export type { DevtoolsClientOptions } from "./api";

export { readDevtoolsCapabilities, watchDevtoolsCapabilities } from "./capabilities";
export type { CapabilitiesBridge } from "./capabilities";
export type { DevtoolsCapabilities } from "./types";

export { ENGINE_BRIDGE_KEY, readEngineBridge, watchEngineBridge } from "./bridge";
export type {
  DevtoolsEngineBridge,
  DevtoolsOverridesSnapshot,
  DevtoolsStateEvent,
} from "./bridge";

export { LoginCancelled, parseDeepLinkQuery, startDeviceAuth } from "./auth";
export type { AuthSessionResult, DeviceAuthAdapters, DeviceAuthOptions } from "./auth";

export { PublicTicketsDisabled, submitPublicBug } from "./public-report";
export type { PublicBugInput, PublicBugResult, SubmitPublicBugOptions } from "./public-report";

export {
  bugFormSchema,
  bugFormToPublicInput,
  featureFormSchema,
  validateBugForm,
  validateFeatureForm,
  zCreateBugRequest,
  zCreateFeatureRequestRequest,
} from "./forms";
export type {
  BugFormValues,
  CreateBugRequestInput,
  CreateFeatureRequestRequestInput,
  FeatureFormValues,
  FormErrors,
} from "./forms";
