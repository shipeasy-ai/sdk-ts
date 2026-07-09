// <ShipeasyDevtools/> — the mount-once overlay root. Listens for a fast
// repeated shake (expo-sensors, optional) and presents the devtools sheet:
//
//   logged out → [ Log in to Shipeasy ]  (device-auth via the app's own scheme)
//                [ Report a bug ]        (only when the project opted into
//                                         public tickets — devtools.allow_public_tickets)
//   logged in  → Gates / Configs / Experiments / Feedback panels + Report a bug
//
// Hosts without expo-sensors (or wanting a menu entry) call `ref.open()`.

import { forwardRef, useCallback, useImperativeHandle, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Modal, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { BugForm } from "./bug-form";
import { GatesPanel, ConfigsPanel, ExperimentsPanel, FeedbackPanel } from "./panels";
import { resolveTheme } from "./theme";
import type { DevtoolsTheme } from "./theme";
import { useDevtoolsAuth, useDevtoolsCapabilities, useShakeToOpen } from "./hooks";
import type { DevtoolsConfig, ShakeOptions } from "./hooks";
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

type Screen = "home" | "bug" | "gates" | "configs" | "experiments" | "feedback";

const TABS: Array<{ key: Screen; label: string }> = [
  { key: "gates", label: "Gates" },
  { key: "configs", label: "Configs" },
  { key: "experiments", label: "Experiments" },
  { key: "feedback", label: "Feedback" },
];

export const ShipeasyDevtools = forwardRef<DevtoolsHandle, ShipeasyDevtoolsProps>(
  function ShipeasyDevtools(props, ref) {
    const [visible, setVisible] = useState(false);
    const [screen, setScreen] = useState<Screen>("home");
    const theme = useMemo(() => resolveTheme(props.theme), [props.theme]);

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

    return (
      <ThemeContext.Provider value={theme}>
        <Modal visible={visible} animationType="slide" transparent onRequestClose={close}>
          <View style={[styles.backdrop]}>
            <SafeAreaView
              style={[styles.sheet, { backgroundColor: theme.bg, borderColor: theme.border }]}
            >
              <Sheet
                config={config}
                screen={screen}
                setScreen={setScreen}
                close={close}
                bugContext={props.bugContext}
              />
            </SafeAreaView>
          </View>
        </Modal>
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
  const { screen, setScreen } = props;

  // The public bug button renders ONLY when the project opted in (surfaced via
  // /sdk/evaluate). A logged-in session can always file (authed path).
  const canFileBug =
    auth.session !== null || (capabilities?.allowPublicTickets === true && !!props.config.clientKey);

  return (
    <View style={styles.sheetInner}>
      <View style={[styles.header, { borderBottomColor: t.border }]}>
        <Title>Shipeasy devtools</Title>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={props.close}>
          <Text style={[styles.closeGlyph, { color: t.fgMuted }]}>✕</Text>
        </Pressable>
      </View>

      {screen === "bug" ? (
        <BugForm
          config={props.config}
          client={auth.client}
          context={props.bugContext}
          onDone={() => setScreen("home")}
        />
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
            {TABS.map((tab) => {
              const active = screen === tab.key || (screen === "home" && tab.key === "gates");
              return (
                <Pressable
                  key={tab.key}
                  accessibilityRole="tab"
                  onPress={() => setScreen(tab.key)}
                  style={[styles.tab, active && { borderBottomColor: t.accent }]}
                >
                  <Text style={[styles.tabLabel, { color: active ? t.fg : t.fgMuted }]}>
                    {tab.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.panel}>
            {screen === "configs" ? (
              <ConfigsPanel client={auth.client} />
            ) : screen === "experiments" ? (
              <ExperimentsPanel client={auth.client} />
            ) : screen === "feedback" ? (
              <FeedbackPanel client={auth.client} />
            ) : (
              <GatesPanel client={auth.client} />
            )}
          </View>
          <Button
            title="Report a bug"
            variant="secondary"
            onPress={() => setScreen("bug")}
            style={styles.footerButton}
          />
        </>
      ) : (
        <View style={styles.home}>
          <Muted style={styles.homeBlurb}>
            Inspect this project's gates, configs and experiments, or report an issue.
          </Muted>
          <Button
            title="Log in to Shipeasy"
            onPress={() => void auth.login()}
            loading={auth.loggingIn || auth.restoring}
          />
          {auth.error ? (
            <Text style={[styles.loginError, { color: t.danger }]}>{auth.error}</Text>
          ) : null}
          {canFileBug ? (
            <Button
              title="Report a bug"
              variant="secondary"
              onPress={() => setScreen("bug")}
              style={styles.homeSecondary}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { backgroundColor: "rgba(0,0,0,0.55)", flex: 1, justifyContent: "flex-end" },
  closeGlyph: { fontSize: 18, padding: 4 },
  footerButton: { marginHorizontal: 16, marginVertical: 10 },
  header: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  home: { gap: 12, padding: 24 },
  homeBlurb: { marginBottom: 8 },
  homeSecondary: {},
  loginError: { fontSize: 13 },
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
  tabs: {
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 18,
    paddingHorizontal: 16,
    paddingTop: 4,
  },
});
