// @shipeasy/sdk/react-native-devtools — the shake-to-open devtools overlay.
//
//   import { ShipeasyDevtools } from "@shipeasy/sdk/react-native-devtools";
//   <ShipeasyDevtools scheme="acme://se-auth" clientKey={CLIENT_KEY} ref={devtoolsRef} />
//
// Required peers when mounting the overlay: react, react-native,
// react-hook-form + @hookform/resolvers (the bug/feature forms), zod.
// Optional Expo peers (install what you use): expo-web-browser (login),
// expo-crypto (PKCE digest), expo-secure-store (session persistence),
// expo-sensors (shake-to-open — otherwise call `ref.open()`),
// expo-image-picker (attach screenshots to feedback).

export { ShipeasyDevtools } from "./root";
export type { DevtoolsHandle, ShipeasyDevtoolsProps } from "./root";

export {
  ensureEventCapture,
  useBugForm,
  useBugDetail,
  useConfigs,
  useDevtoolsAuth,
  useDevtoolsCapabilities,
  useEngineBridge,
  useEventLog,
  useExperiments,
  useFeatureDetail,
  useFeatureForm,
  useFeatureRequests,
  useFeedback,
  useGates,
  useI18nKeys,
  useProfiles,
  useProject,
  useShakeToOpen,
  useUniverses,
} from "./hooks";
export type {
  BugFormState,
  DevtoolsAuth,
  DevtoolsConfig,
  FeatureFormState,
  QueryState,
  ShakeOptions,
} from "./hooks";

export { GatesPanel, ConfigsPanel, ExperimentsPanel } from "./panels";
export { FeedbackPanel } from "./feedback-panel";
export { UserPanel } from "./user-panel";
export { EventsPanel } from "./events-panel";
export { I18nPanel } from "./i18n-panel";
export { BugForm } from "./bug-form";
export { FeatureForm } from "./feature-form";
export { defaultTheme } from "./theme";
export type { DevtoolsTheme } from "./theme";

// Re-export the headless core so RN hosts need a single import path.
export {
  AuthError,
  DevtoolsClient,
  LoginCancelled,
  PublicTicketsDisabled,
  readEngineBridge,
  startDeviceAuth,
  submitPublicBug,
  watchEngineBridge,
} from "../devtools/index";
export type {
  BugDetail,
  BugRecord,
  ConfigRecord,
  DevtoolsEngineBridge,
  DevtoolsSession,
  DevtoolsStateEvent,
  ExperimentRecord,
  FeatureRequestDetail,
  FeatureRequestRecord,
  GateRecord,
  KeyRecord,
  ProfileRecord,
  ProjectRecord,
  UniverseRecord,
} from "../devtools/index";
