// @shipeasy/sdk/react-native-devtools — the shake-to-open devtools overlay.
//
//   import { ShipeasyDevtools } from "@shipeasy/sdk/react-native-devtools";
//   <ShipeasyDevtools scheme="acme://se-auth" clientKey={CLIENT_KEY} ref={devtoolsRef} />
//
// Optional Expo peers (install what you use): expo-web-browser (login),
// expo-crypto (PKCE digest), expo-secure-store (session persistence),
// expo-sensors (shake-to-open — otherwise call `ref.open()`).

export { ShipeasyDevtools } from "./root";
export type { DevtoolsHandle, ShipeasyDevtoolsProps } from "./root";

export {
  useBugForm,
  useConfigs,
  useDevtoolsAuth,
  useDevtoolsCapabilities,
  useExperiments,
  useFeedback,
  useGates,
  useShakeToOpen,
} from "./hooks";
export type {
  BugFormState,
  DevtoolsAuth,
  DevtoolsConfig,
  QueryState,
  ShakeOptions,
} from "./hooks";

export { GatesPanel, ConfigsPanel, ExperimentsPanel, FeedbackPanel } from "./panels";
export { BugForm } from "./bug-form";
export { defaultTheme } from "./theme";
export type { DevtoolsTheme } from "./theme";

// Re-export the headless core so RN hosts need a single import path.
export {
  AuthError,
  DevtoolsClient,
  LoginCancelled,
  PublicTicketsDisabled,
  startDeviceAuth,
  submitPublicBug,
} from "../devtools/index";
export type {
  BugRecord,
  ConfigRecord,
  DevtoolsSession,
  ExperimentRecord,
  GateRecord,
  ProjectRecord,
} from "../devtools/index";
