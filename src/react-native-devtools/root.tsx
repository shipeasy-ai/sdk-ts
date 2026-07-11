// <ShipeasyDevtools/> — the mount-once overlay root. Listens for a fast
// repeated shake (expo-sensors, optional) and presents the devtools sheet:
//
//   logged out → [ Log in to Shipeasy ]  (device-auth via the app's own scheme)
//                [ Report a bug ]        (only when the project opted into
//                                         public tickets — devtools.allow_public_tickets)
//   logged in  → User / Gates / Configs / Experiments / Feedback / I18n /
//                Events panels (gated by the project's enabled modules) +
//                Report a bug
//
// Hosts without expo-sensors (or wanting a menu entry) call `ref.open()`.

import { forwardRef, useCallback, useImperativeHandle, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { ProjectModules } from "../devtools/types";
import { BugForm } from "./bug-form";
import { FeatureForm } from "./feature-form";
import { GatesPanel, ConfigsPanel, ExperimentsPanel } from "./panels";
import { FeedbackPanel } from "./feedback-panel";
import { UserPanel } from "./user-panel";
import { EventsPanel } from "./events-panel";
import { I18nPanel } from "./i18n-panel";
import { resolveTheme } from "./theme";
import type { DevtoolsTheme } from "./theme";
import { canCaptureScreen, captureScreenShot } from "./expo-adapters";
import {
  ScreenCaptureContext,
  ensureEventCapture,
  useDevtoolsAuth,
  useDevtoolsCapabilities,
  useProject,
  useShakeToOpen,
} from "./hooks";
import type { DevtoolsConfig, ScreenCapture, ShakeOptions } from "./hooks";
import { Button, Muted, ThemeContext, Title, useTheme } from "./ui";

export interface DevtoolsHandle {
  open(): void;
  close(): void;
}

export interface ShipeasyDevtoolsProps {
  /** The HOST APP's own deep-link redirect URI (any custom scheme the app
   *  registered — e.g. `acme://se-auth`). Used by the login round-trip. */
  scheme: string;
  /** Public client key (`sdk_client_*`) — enables the logged-out public bug
   *  path. Must carry the `tickets:public_create` scope. */
  clientKey?: string;
  /** Pre-select a project on the login page. */
  projectId?: string;
  /** Edge worker origin override (default `https://api.shipeasy.ai`). */
  edgeBaseUrl?: string;
  /** Admin origin override (default `https://shipeasy.ai`). */
  adminBaseUrl?: string;
  /** Theme overrides merged over the built-in dark theme. */
  theme?: Partial<DevtoolsTheme>;
  /** Shake detection tuning; `{ enabled: false }` for imperative-only opening. */
  shake?: ShakeOptions;
  /** Extra context attached to bug reports (app version, build, …). */
  bugContext?: Record<string, unknown>;
}

type Screen =
  | "home"
  | "bug"
  | "feature"
  | "user"
  | "gates"
  | "configs"
  | "experiments"
  | "feedback"
  | "i18n"
  | "events";

const TABS: Array<{ key: Screen; label: string; module: keyof ProjectModules }> = [
  { key: "user", label: "User", module: "user" },
  { key: "gates", label: "Gates", module: "gates" },
  { key: "configs", label: "Configs", module: "configs" },
  { key: "experiments", label: "Experiments", module: "experiments" },
  { key: "feedback", label: "Feedback", module: "feedback" },
  { key: "i18n", label: "I18n", module: "translations" },
  { key: "events", label: "Events", module: "events" },
];

export const ShipeasyDevtools = forwardRef<DevtoolsHandle, ShipeasyDevtoolsProps>(
  function ShipeasyDevtools(props, ref) {
    const [visible, setVisible] = useState(false);
    const [screen, setScreen] = useState<Screen>("home");
    const theme = useMemo(() => resolveTheme(props.theme), [props.theme]);

    // Start the events ring at mount so activity before the first open shows.
    ensureEventCapture();

    const open = useCallback(() => {
      setScreen("home");
      setVisible(true);
    }, []);
    const close = useCallback(() => setVisible(false), []);
    useImperativeHandle(ref, () => ({ open, close }), [open, close]);
    useShakeToOpen(open, props.shake);

    const config: DevtoolsConfig = useMemo(
      () => ({
        scheme: props.scheme,
        clientKey: props.clientKey,
        projectId: props.projectId,
        edgeBaseUrl: props.edgeBaseUrl,
        adminBaseUrl: props.adminBaseUrl,
      }),
      [props.scheme, props.clientKey, props.projectId, props.edgeBaseUrl, props.adminBaseUrl],
    );

    // Screen capture for the report forms: the shot must show the APP, not
    // this sheet — hide the overlay via style (state survives; toggling the
    // Modal's `visible` would unmount the form mid-edit), wait a beat for the
    // keyboard + the hide to commit, shoot, restore.
    const [capturing, setCapturing] = useState(false);
    const screenCapture = useMemo<ScreenCapture>(
      () => ({
        available: canCaptureScreen(),
        capture: async () => {
          if (!canCaptureScreen()) return null;
          Keyboard.dismiss();
          setCapturing(true);
          await new Promise((resolve) => setTimeout(resolve, 400));
          try {
            return await captureScreenShot();
          } catch {
            return null;
          } finally {
            setCapturing(false);
          }
        },
      }),
      [],
    );

    return (
      <ThemeContext.Provider value={theme}>
        <ScreenCaptureContext.Provider value={screenCapture}>
          <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
            {/* Lift the sheet above the keyboard so form inputs stay visible. */}
            <KeyboardAvoidingView
              behavior={Platform.OS === "ios" ? "padding" : "height"}
              style={[styles.backdrop, capturing && styles.captureHidden]}
            >
              <SafeAreaView
                style={[styles.sheet, { backgroundColor: theme.bg, borderColor: theme.border }]}
              >
                <View style={styles.handleRow}>
                  <View style={[styles.handle, { backgroundColor: theme.border }]} />
                </View>
                <Sheet
                  config={config}
                  screen={screen}
                  setScreen={setScreen}
                  close={close}
                  bugContext={props.bugContext}
                />
              </SafeAreaView>
            </KeyboardAvoidingView>
          </Modal>
        </ScreenCaptureContext.Provider>
      </ThemeContext.Provider>
    );
  },
);

function Sheet(props: {
  config: DevtoolsConfig;
  screen: Screen;
  setScreen: (s: Screen) => void;
  close: () => void;
  bugContext?: Record<string, unknown>;
}): ReactNode {
  const t = useTheme();
  const auth = useDevtoolsAuth(props.config);
  const capabilities = useDevtoolsCapabilities();
  const project = useProject(auth.client);
  const { screen, setScreen } = props;

  // The public bug button renders ONLY when the project opted in (surfaced via
  // /sdk/evaluate). A logged-in session can always file (authed path).
  const canFileBug =
    auth.session !== null || (capabilities?.allowPublicTickets === true && !!props.config.clientKey);

  // Module-gated tabs (hidden, not greyed — same as the web overlay). Until
  // the project record lands, show everything rather than flash-hide tabs.
  const modules = project.data?.modules ?? null;
  const tabs = TABS.filter((tab) => modules === null || modules[tab.module]);
  const activeTab: Screen = tabs.some((tab) => tab.key === screen)
    ? screen
    : (tabs[0]?.key ?? "gates");

  return (
    <View style={styles.sheetInner}>
      <View style={[styles.header, { borderBottomColor: t.border }]}>
        <Title>Shipeasy devtools</Title>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={props.close}>
          <Text style={[styles.closeGlyph, { color: t.fgMuted }]}>✕</Text>
        </Pressable>
      </View>

      {screen === "bug" ? (
        <View style={styles.panel}>
          <BugForm
            config={props.config}
            client={auth.client}
            context={props.bugContext}
            onDone={() => setScreen("home")}
          />
        </View>
      ) : screen === "feature" ? (
        <View style={styles.panel}>
          <FeatureForm
            config={props.config}
            client={auth.client}
            context={props.bugContext}
            onDone={() => setScreen("home")}
          />
        </View>
      ) : auth.session && auth.client ? (
        <>
          <View style={styles.sessionRow}>
            <Muted>
              {auth.session.projectName ?? auth.session.projectId}
              {auth.session.userEmail ? ` · ${auth.session.userEmail}` : ""}
            </Muted>
            <Pressable accessibilityRole="button" onPress={() => void auth.logout()}>
              <Text style={[styles.logout, { color: t.accent }]}>Log out</Text>
            </Pressable>
          </View>
          <View style={[styles.tabs, { borderBottomColor: t.border }]}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsRow}>
              {tabs.map((tab) => {
                const active = activeTab === tab.key;
                return (
                  <Pressable
                    key={tab.key}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    onPress={() => setScreen(tab.key)}
                    style={[styles.tab, active && { borderBottomColor: t.accent }]}
                  >
                    <Text style={[styles.tabLabel, { color: active ? t.fg : t.fgMuted }]}>
                      {tab.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
          <View style={styles.panel}>
            {activeTab === "user" ? (
              <UserPanel />
            ) : activeTab === "configs" ? (
              <ConfigsPanel client={auth.client} />
            ) : activeTab === "experiments" ? (
              <ExperimentsPanel client={auth.client} />
            ) : activeTab === "feedback" ? (
              <FeedbackPanel
                client={auth.client}
                config={props.config}
                bugContext={props.bugContext}
              />
            ) : activeTab === "i18n" ? (
              <I18nPanel client={auth.client} />
            ) : activeTab === "events" ? (
              <EventsPanel />
            ) : (
              <GatesPanel client={auth.client} />
            )}
          </View>
          {activeTab !== "feedback" ? (
            <Button
              title="Report a bug"
              variant="secondary"
              onPress={() => setScreen("bug")}
              style={styles.footerButton}
            />
          ) : null}
        </>
      ) : (
        <HomeScreen
          onConnect={() => void auth.login()}
          connecting={auth.loggingIn || auth.restoring}
          error={auth.error}
          canReport={canFileBug}
          onReportBug={() => setScreen("bug")}
          onRequestFeature={() => setScreen("feature")}
        />
      )}
    </View>
  );
}

// ── logged-out home ───────────────────────────────────────────────────────────

/** The Shipeasy brand mark, drawn with plain Views (no SVG/image deps): the
 *  rounded accent tile with the inset app square — same geometry as logo.svg. */
function BrandMark(): ReactNode {
  const t = useTheme();
  return (
    <View style={[styles.brandMark, { backgroundColor: t.accent }]}>
      <View style={[styles.brandMarkInner, { backgroundColor: t.bg }]} />
    </View>
  );
}

function ActionCard(props: {
  glyph: string;
  title: string;
  sub: string;
  onPress: () => void;
}): ReactNode {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.title}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.actionCard,
        {
          backgroundColor: t.surface,
          borderColor: t.border,
          borderRadius: t.radius,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View style={[styles.actionGlyphWrap, { backgroundColor: t.accentSoft }]}>
        <Text style={[styles.actionGlyph, { color: t.accent }]}>{props.glyph}</Text>
      </View>
      <View style={styles.actionCopy}>
        <Text style={[styles.actionTitle, { color: t.fg }]}>{props.title}</Text>
        <Text style={[styles.actionSub, { color: t.fgMuted }]} numberOfLines={2}>
          {props.sub}
        </Text>
      </View>
      <Text style={[styles.actionChevron, { color: t.fgMuted }]}>›</Text>
    </Pressable>
  );
}

/** The logged-out landing: brand, the public report actions (shown when the
 *  project opted into public tickets), and Connect pinned to the bottom.
 *  Exported for design surfaces; the sheet wires it to live auth state. */
export function HomeScreen(props: {
  onConnect: () => void;
  connecting?: boolean;
  error?: string | null;
  /** Public reporting available (project opt-in + client key). */
  canReport: boolean;
  onReportBug: () => void;
  onRequestFeature: () => void;
}): ReactNode {
  const t = useTheme();
  return (
    <View style={styles.home}>
      <View style={styles.homeBrand}>
        <BrandMark />
        <Title style={styles.homeWordmark}>Shipeasy</Title>
        <Muted style={styles.homeTagline}>
          The toolbox behind this app — flags, experiments and feedback.
        </Muted>
      </View>

      {props.canReport ? (
        <View style={styles.homeActions}>
          <ActionCard
            glyph="!"
            title="Report a bug"
            sub="Something broken? Send it straight to the team."
            onPress={props.onReportBug}
          />
          <ActionCard
            glyph="+"
            title="Request a feature"
            sub="Tell the team what this app is missing."
            onPress={props.onRequestFeature}
          />
        </View>
      ) : null}

      <View style={styles.homeSpacer} />

      {props.error ? (
        <Text style={[styles.loginError, { color: t.danger }]}>{props.error}</Text>
      ) : null}
      <Button
        title="Connect to Shipeasy"
        onPress={props.onConnect}
        loading={props.connecting === true}
      />
      <Muted style={styles.homeConnectHint}>
        Team members: log in to inspect gates, configs, experiments and live events.
      </Muted>
    </View>
  );
}

const styles = StyleSheet.create({
  actionCard: {
    alignItems: "center",
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  actionChevron: { fontSize: 22, fontWeight: "400", marginTop: -2 },
  actionCopy: { flex: 1, gap: 2 },
  actionGlyph: { fontSize: 16, fontWeight: "800" },
  actionGlyphWrap: {
    alignItems: "center",
    borderRadius: 10,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  actionSub: { fontSize: 12, lineHeight: 16 },
  actionTitle: { fontSize: 15, fontWeight: "600" },
  backdrop: { backgroundColor: "rgba(0,0,0,0.55)", flex: 1, justifyContent: "flex-end" },
  brandMark: {
    alignItems: "center",
    borderRadius: 12,
    height: 46,
    justifyContent: "center",
    width: 46,
  },
  brandMarkInner: { borderRadius: 7, height: 26, width: 26 },
  // Invisible but mounted — captureScreen must shoot the app, and toggling the
  // Modal instead would unmount the form state.
  captureHidden: { opacity: 0 },
  closeGlyph: { fontSize: 18, padding: 4 },
  handle: { borderRadius: 999, height: 4, width: 36 },
  handleRow: { alignItems: "center", paddingBottom: 2, paddingTop: 8 },
  footerButton: { marginHorizontal: 16, marginVertical: 10 },
  header: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  home: { flex: 1, gap: 10, padding: 20, paddingBottom: 16 },
  homeActions: { gap: 10, marginTop: 6 },
  homeBrand: { alignItems: "center", gap: 8, paddingBottom: 10, paddingTop: 18 },
  homeConnectHint: { fontSize: 11.5, paddingHorizontal: 20, textAlign: "center" },
  homeSpacer: { flex: 1, minHeight: 8 },
  homeTagline: { paddingHorizontal: 24, textAlign: "center" },
  homeWordmark: { fontSize: 20, letterSpacing: -0.4 },
  loginError: { fontSize: 13, textAlign: "center" },
  logout: { fontSize: 13, fontWeight: "600" },
  panel: { flex: 1, paddingHorizontal: 16, paddingTop: 10 },
  sessionRow: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    maxHeight: "88%",
    minHeight: "55%",
  },
  sheetInner: { flex: 1 },
  tab: { borderBottomColor: "transparent", borderBottomWidth: 2, paddingBottom: 8 },
  tabLabel: { fontSize: 14, fontWeight: "600" },
  tabs: { borderBottomWidth: 1, paddingTop: 4 },
  tabsRow: { flexDirection: "row", gap: 18, paddingHorizontal: 16 },
});
