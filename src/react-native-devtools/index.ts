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

export { HomeScreen, ShipeasyDevtools } from "./root";
export type { DevtoolsHandle, ShipeasyDevtoolsProps } from "./root";

export {
  ScreenCaptureContext,
  SheetNavContext,
  ensureEventCapture,
  useBugForm,
  useBugDetail,
  useAlerts,
  useConfigs,
  useDevtoolsAuth,
  useDevtoolsCapabilities,
  useEngineBridge,
  useErrors,
  useEventLog,
  useExperiments,
  useFeatureDetail,
  useFeatureForm,
  useFeatureRequests,
  useFeedback,
  useGates,
  useOpsDetail,
  useI18nKeys,
  useIdentityEmail,
  useProject,
  useScreenCapture,
  useShakeToOpen,
  useUniverses,
} from "./hooks";
export type {
  BugFormState,
  DevtoolsAuth,
  DevtoolsConfig,
  FeatureFormState,
  QueryState,
  ScreenCapture,
  SheetNav,
  ShakeOptions,
} from "./hooks";

export { GatesPanel, ConfigsPanel, ExperimentsPanel } from "./panels";
export { ConfigViewerScreen } from "./config-viewer";
export { ExperimentDetailScreen } from "./experiment-detail";
export { ValueTree, ValueContents } from "./value-tree";
export { FeedbackPanel } from "./feedback-panel";
export { UserPanel } from "./user-panel";
export { EventsPanel } from "./events-panel";
export { OverridesPanel } from "./overrides-panel";
export { I18nPanel } from "./i18n-panel";
export { BugForm, ScreenshotAttach } from "./bug-form";
export { FeatureForm } from "./feature-form";
export { CreateSuccess } from "./create-success";
export { canCaptureScreen, captureScreenShot } from "./expo-adapters";
export type { CapturedScreen } from "./expo-adapters";
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
