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
//
// The sheet itself is draggable: it opens content-sized (a short form stays
// short) and the grab handle pulls it up to cover the whole app — see
// ./sheet-snap for the snap math.

import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { ConfigRecord, ExperimentRecord, ProjectModules } from "@shipeasy/devtools-core/types";
import { BugForm } from "./bug-form";
import { FeatureForm } from "./feature-form";
import { ConfigViewerScreen } from "./config-viewer";
import { ExperimentDetailScreen } from "./experiment-detail";
import { GatesPanel, ConfigsPanel, ExperimentsPanel } from "./panels";
import { FeedbackPanel } from "./feedback-panel";
import { I18nPanel } from "./i18n-panel";
import { UserPanel } from "./user-panel";
import { EventsPanel } from "./events-panel";
import { OverridesPanel } from "./overrides-panel";
import { resolveTheme } from "./theme";
import type { DevtoolsTheme } from "./theme";
import { canCaptureScreen, captureScreenShot, getSafeAreaInsets } from "./expo-adapters";
import { growFromDrag, isHandleTap, shouldDismiss, snapTarget } from "./sheet-snap";
import { Icon } from "./icons";
import type { DevtoolsIconName } from "./icons";
import {
  ScreenCaptureContext,
  SheetNavContext,
  ensureEventCapture,
  useDevtoolsAuth,
  useDevtoolsCapabilities,
  useEngineBridge,
  useProject,
  useShakeToOpen,
} from "./hooks";
import type { DevtoolsConfig, ScreenCapture, SheetNav, ShakeOptions } from "./hooks";
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

// The two snap points, as fractions of the sheet's PARENT (the keyboard-avoiding
// backdrop) rather than of the window: with the keyboard up that parent is
// already shorter, so a full-screen sheet still ends above the keyboard instead
// of overflowing behind it. Peek keeps the pre-drag behaviour — content-sized
// between the two bounds.
const PEEK_MIN = "55%";
const PEEK_MAX = "88%";
const FULL = "100%";

// Used when react-native-safe-area-context isn't installed: enough bottom room
// to clear an iPhone home indicator, a hair on Android (where the gesture bar
// only overlaps in edge-to-edge mode).
const FALLBACK_INSETS = Platform.OS === "ios" ? { top: 20, bottom: 24 } : { top: 0, bottom: 12 };

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
  | "events"
  | "overrides";

// The devtools modules, rendered as a drill-in menu (one big-tap row each) —
// far friendlier on a phone than a cramped horizontal tab strip. The icon is
// the row's leading badge (same Lucide set as the in-browser overlay);
// `module` gates visibility on the project's config.
const SECTIONS: Array<{
  key: Screen;
  label: string;
  icon: DevtoolsIconName;
  module: keyof ProjectModules;
}> = [
  { key: "user", label: "User", icon: "user", module: "user" },
  { key: "gates", label: "Feature Flags", icon: "gates", module: "gates" },
  { key: "configs", label: "Configs", icon: "configs", module: "configs" },
  { key: "experiments", label: "Experiments", icon: "experiments", module: "experiments" },
  { key: "feedback", label: "Feedback", icon: "feedback", module: "feedback" },
  { key: "i18n", label: "Translations", icon: "i18n", module: "translations" },
  { key: "events", label: "Events", icon: "events", module: "events" },
];

export const ShipeasyDevtools = forwardRef<DevtoolsHandle, ShipeasyDevtoolsProps>(
  function ShipeasyDevtools(props, ref) {
    const [visible, setVisible] = useState(false);
    const [screen, setScreen] = useState<Screen>("home");
    const theme = useMemo(() => resolveTheme(props.theme), [props.theme]);

    // Start the events ring at mount so activity before the first open shows.
    ensureEventCapture();

    // ── sheet size ───────────────────────────────────────────────────────────
    // `grow` drives every size-ish style: 0 = peek (content-sized, 55…88% of the
    // available height), 1 = full. It's a plain JS-driven Animated.Value —
    // layout props (min/maxHeight, radius, padding) can't run on the native
    // driver. `slide` is the drag-down-to-dismiss offset.
    const insets = useMemo(() => getSafeAreaInsets() ?? FALLBACK_INSETS, []);
    const grow = useRef(new Animated.Value(0)).current;
    const slide = useRef(new Animated.Value(0)).current;
    // Mirror of `grow`'s settled value — a gesture needs it synchronously, and
    // Animated.Value has no public getter.
    const growAt = useRef(0);

    // Mirrors the settled snap point for the handle's accessibility label only
    // (the visuals all ride the Animated value).
    const [atFull, setAtFull] = useState(false);

    const settle = useCallback(
      (to: 0 | 1) => {
        growAt.current = to;
        setAtFull(to === 1);
        Animated.spring(grow, {
          toValue: to,
          bounciness: 0,
          speed: 14,
          useNativeDriver: false,
        }).start();
      },
      [grow],
    );

    const open = useCallback(() => {
      setScreen("home");
      slide.setValue(0);
      setVisible(true);
    }, [slide]);
    // Deliberately does NOT reset `slide` — the Modal's own slide-out plays from
    // wherever the drag left the sheet; `open` resets it for the next mount.
    const close = useCallback(() => setVisible(false), []);
    useImperativeHandle(ref, () => ({ open, close }), [open, close]);
    useShakeToOpen(open, props.shake);

    // Drag the grab handle: up expands towards full screen, down collapses and
    // then dismisses. A tap (no travel) toggles peek ↔ full, so expanding never
    // requires a drag.
    const drag = useMemo(
      () =>
        PanResponder.create({
          onStartShouldSetPanResponder: () => true,
          onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 3,
          onPanResponderMove: (_e, g) => {
            const from = growAt.current;
            grow.setValue(growFromDrag(from, g.dy));
            // Dragging down from peek (only) previews the dismiss — from an
            // expanded sheet the same drag is just a collapse.
            slide.setValue(from === 0 && g.dy > 0 ? g.dy : 0);
          },
          onPanResponderRelease: (_e, g) => {
            if (isHandleTap(g.dx, g.dy)) {
              settle(growAt.current === 1 ? 0 : 1);
              return;
            }
            const from = growAt.current;
            const next = growFromDrag(from, g.dy);
            if (shouldDismiss(from, g.dy, g.vy)) {
              close();
              return;
            }
            Animated.timing(slide, {
              toValue: 0,
              duration: 120,
              useNativeDriver: false,
            }).start();
            settle(snapTarget(next, g.vy));
          },
          onPanResponderTerminate: () => {
            slide.setValue(0);
            settle(growAt.current === 1 ? 1 : 0);
          },
        }),
      [close, grow, settle, slide],
    );

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
              {/* The dimmed area above the sheet dismisses it (it shrinks to
                  nothing once the sheet is pulled full-screen). */}
              <Pressable
                accessibilityLabel="Close the inspector"
                onPress={close}
                style={styles.backdropTap}
              />
              <Animated.View
                style={[
                  styles.sheet,
                  {
                    backgroundColor: theme.bg,
                    borderColor: theme.border,
                    // Peek is content-sized between the two bounds; at full both
                    // collapse onto the window height, so even a short form fills
                    // the screen.
                    minHeight: grow.interpolate({
                      inputRange: [0, 1],
                      outputRange: [PEEK_MIN, FULL],
                    }),
                    maxHeight: grow.interpolate({
                      inputRange: [0, 1],
                      outputRange: [PEEK_MAX, FULL],
                    }),
                    borderTopLeftRadius: grow.interpolate({
                      inputRange: [0, 1],
                      outputRange: [16, 0],
                    }),
                    borderTopRightRadius: grow.interpolate({
                      inputRange: [0, 1],
                      outputRange: [16, 0],
                    }),
                    // Full screen means the sheet owns the status-bar strip too.
                    paddingTop: grow.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, insets.top],
                    }),
                    // Keeps the bottom-most action (Connect / Submit / Cancel)
                    // clear of the home indicator — react-native's SafeAreaView
                    // measures zero inside a Modal, which is what clipped it.
                    paddingBottom: Math.max(insets.bottom, 8),
                    transform: [{ translateY: slide }],
                  },
                ]}
              >
                <View
                  accessibilityRole="button"
                  accessibilityLabel={atFull ? "Collapse the inspector" : "Expand the inspector"}
                  accessibilityHint="Drag up to fill the screen, down to dismiss"
                  style={styles.handleRow}
                  {...drag.panHandlers}
                >
                  <View style={[styles.handle, { backgroundColor: theme.border }]} />
                </View>
                <Sheet
                  config={config}
                  screen={screen}
                  setScreen={setScreen}
                  close={close}
                  bugContext={props.bugContext}
                />
              </Animated.View>
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
  const bridge = useEngineBridge();
  const { screen, setScreen } = props;
  // Two sections drill a second level: a Configs row opens the full-page nested
  // viewer; an Experiments row opens the full-page detail screen.
  const [editorConfig, setEditorConfig] = useState<ConfigRecord | null>(null);
  const [detailExperiment, setDetailExperiment] = useState<ExperimentRecord | null>(null);
  // A section panel with its own internal drill-in (Feedback: list → detail)
  // hands the header a Back handler + title via SheetNav, so the header's single
  // ‹ Back drives it — no per-panel back button.
  const [sectionBack, setSectionBack] = useState<(() => void) | null>(null);
  const [sectionTitle, setSectionTitle] = useState<string | null>(null);
  const nav = useMemo<SheetNav>(
    () => ({
      // Wrap in a thunk: a bare `setSectionBack(fn)` would treat `fn` as a
      // state updater and call it immediately.
      setBack: (handler) => setSectionBack(() => handler),
      setTitle: (title) => setSectionTitle(title),
    }),
    [],
  );

  // Opening a section (or the overrides screen) from anywhere clears any stale
  // drill-in target so it lands on its own list, not a previously-open sub-screen.
  const openSection = (key: Screen) => {
    setEditorConfig(null);
    setDetailExperiment(null);
    setSectionBack(null);
    setSectionTitle(null);
    setScreen(key);
  };

  // Count of active engine overrides (forced flags/configs/experiment variants)
  // — drives the header's overrides pill + highlight. Live: the bridge re-reads
  // on every override change (useEngineBridge bumps a generation).
  const overrides = bridge ? bridge.getOverrides() : null;
  const overrideCount = overrides
    ? Object.keys(overrides.flags).length +
      Object.keys(overrides.configs).length +
      Object.keys(overrides.experiments).length
    : 0;

  // The public bug button renders ONLY when the project opted in (surfaced via
  // /sdk/evaluate). A logged-in session can always file (authed path).
  const canFileBug =
    auth.session !== null || (capabilities?.allowPublicTickets === true && !!props.config.clientKey);

  // Module-gated sections (hidden, not greyed — same as the web overlay). Until
  // the project record lands, show everything rather than flash-hide rows.
  const modules = project.data?.modules ?? null;
  const sections = SECTIONS.filter((s) => modules === null || modules[s.module]);
  // Logged-in nav is a drill-in: `screen === "home"` shows the section menu; a
  // section key shows that panel. A sub-screen (a section, or the bug/feature
  // forms) swaps the header brand for a ‹ Back that returns to home/menu.
  const activeSection = sections.find((s) => s.key === screen) ?? null;
  // A drill-in sub-screen (config viewer / experiment detail) is a level below
  // its section: its Back returns to that section's list, not to the menu.
  const subTitle = editorConfig
    ? editorConfig.name
    : detailExperiment
      ? detailExperiment.name
      : screen === "bug"
        ? "Report a bug"
        : screen === "feature"
          ? "Request a feature"
          : screen === "overrides"
            ? "Active overrides"
            : (sectionTitle ?? activeSection?.label ?? null);
  const goBack = () => {
    if (editorConfig) setEditorConfig(null);
    else if (detailExperiment) setDetailExperiment(null);
    else if (sectionBack) sectionBack();
    else setScreen("home");
  };

  return (
    <SheetNavContext.Provider value={nav}>
      <View style={styles.sheetInner}>
      {/* The header highlights (accent underline) while any override is active,
          so it's obvious the app is being driven off its real evaluated state. */}
      <View
        style={[
          styles.header,
          {
            borderBottomColor: overrideCount > 0 ? t.accent : t.border,
            borderBottomWidth: overrideCount > 0 ? 2 : StyleSheet.hairlineWidth,
          },
        ]}
      >
        {subTitle ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={goBack}
            style={styles.headerBack}
          >
            <Text style={[styles.backChevron, { color: t.accent }]}>‹</Text>
            <Text style={[styles.headerTitle, { color: t.fg }]}>{subTitle}</Text>
          </Pressable>
        ) : (
          <View style={styles.headerBrand}>
            <BrandMark size={22} />
            <Text style={[styles.headerTitle, { color: t.fg }]}>
              Shipeasy{" "}
              <Text style={[styles.headerTitleDim, { color: t.fgMuted }]}>Inspector</Text>
            </Text>
          </View>
        )}
        <View style={styles.headerRight}>
          {overrideCount > 0 && screen !== "overrides" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${overrideCount} active overrides`}
              onPress={() => openSection("overrides")}
              style={[styles.overridePill, { backgroundColor: t.accent }]}
            >
              <Text style={[styles.overridePillText, { color: t.accentFg }]}>
                ⚡ {overrideCount}
              </Text>
            </Pressable>
          ) : null}
          {/* Close is ALWAYS here — a logged-in session used to replace it with
              "Log out", leaving no way to dismiss the sheet on iOS (no hardware
              back). Log out now lives at the foot of the section menu. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={8}
            onPress={props.close}
          >
            <Text style={[styles.closeGlyph, { color: t.fgMuted }]}>✕</Text>
          </Pressable>
        </View>
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
      ) : screen === "overrides" ? (
        // App-level (engine bridge), so reachable regardless of devtools login.
        <View style={styles.panel}>
          <OverridesPanel bridge={bridge} />
        </View>
      ) : auth.session && auth.client ? (
        activeSection ? (
          <>
            <View style={styles.panel}>
              {activeSection.key === "user" ? (
                <UserPanel />
              ) : activeSection.key === "configs" ? (
                editorConfig ? (
                  <ConfigViewerScreen config={editorConfig} bridge={bridge} />
                ) : (
                  <ConfigsPanel client={auth.client} onOpen={setEditorConfig} />
                )
              ) : activeSection.key === "experiments" ? (
                detailExperiment ? (
                  <ExperimentDetailScreen
                    experiment={detailExperiment}
                    client={auth.client}
                    bridge={bridge}
                  />
                ) : (
                  <ExperimentsPanel client={auth.client} onOpen={setDetailExperiment} />
                )
              ) : activeSection.key === "feedback" ? (
                <FeedbackPanel
                  client={auth.client}
                  config={props.config}
                  bugContext={props.bugContext}
                />
              ) : activeSection.key === "i18n" ? (
                <I18nPanel client={auth.client} />
              ) : activeSection.key === "events" ? (
                <EventsPanel />
              ) : (
                <GatesPanel client={auth.client} />
              )}
            </View>
          </>
        ) : (
          <ScrollView contentContainerStyle={styles.menu}>
            {sections.map((s) => (
              <SectionRow
                key={s.key}
                icon={s.icon}
                label={s.label}
                onPress={() => openSection(s.key)}
              />
            ))}
            <SectionRow
              icon="bug"
              label="Report a bug"
              tone="accent"
              onPress={() => setScreen("bug")}
            />
            <SectionRow
              icon="feature"
              label="Request a feature"
              onPress={() => setScreen("feature")}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Log out"
              onPress={() => void auth.logout()}
              style={({ pressed }) => [styles.menuLogout, { opacity: pressed ? 0.7 : 1 }]}
            >
              <Text style={[styles.menuLogoutText, { color: t.fgMuted }]}>Log out</Text>
            </Pressable>
          </ScrollView>
        )
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
    </SheetNavContext.Provider>
  );
}

// ── logged-out home ───────────────────────────────────────────────────────────

/** The Shipeasy brand mark, drawn with plain Views (no SVG/image deps): the
 *  rounded accent tile with the inset app square — same geometry as logo.svg.
 *  `size` scales the whole mark (default 46; the header uses a compact 22). */
function BrandMark(props: { size?: number }): ReactNode {
  const t = useTheme();
  const size = props.size ?? 46;
  const inner = Math.round(size * 0.56);
  return (
    <View
      style={[
        styles.brandMark,
        {
          backgroundColor: t.accent,
          borderRadius: Math.round(size * 0.26),
          height: size,
          width: size,
        },
      ]}
    >
      <View
        style={{
          backgroundColor: t.bg,
          borderRadius: Math.round(inner * 0.27),
          height: inner,
          width: inner,
        }}
      />
    </View>
  );
}

/** A big-tap row in the logged-in section menu (the drill-in nav). `tone:
 *  "accent"` fills the icon badge — used for the "Report a bug" action row. */
function SectionRow(props: {
  icon: DevtoolsIconName;
  label: string;
  onPress: () => void;
  tone?: "accent";
}): ReactNode {
  const t = useTheme();
  const accent = props.tone === "accent";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.sectionRow,
        {
          backgroundColor: t.surface,
          borderColor: t.border,
          borderRadius: t.radius,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <View
        style={[styles.sectionGlyphWrap, { backgroundColor: accent ? t.accent : t.accentSoft }]}
      >
        <Icon name={props.icon} size={18} color={accent ? t.accentFg : t.accent} />
      </View>
      <Text style={[styles.sectionLabel, { color: t.fg }]}>{props.label}</Text>
      <Text style={[styles.sectionChevron, { color: t.fgMuted }]}>›</Text>
    </Pressable>
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
          The toolbox behind this app — flags, experiments and feedback
        </Muted>
      </View>

      {props.canReport ? (
        <View style={styles.homeActions}>
          <ActionCard
            glyph="!"
            title="Report a bug"
            sub="Something broken? Send it straight to the team"
            onPress={props.onReportBug}
          />
          <ActionCard
            glyph="+"
            title="Request a feature"
            sub="Tell the team what this app is missing"
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
        Team members: log in to inspect gates, configs, experiments and live events
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
  backChevron: { fontSize: 24, fontWeight: "500", marginTop: -2 },
  backdrop: { backgroundColor: "rgba(0,0,0,0.55)", flex: 1, justifyContent: "flex-end" },
  backdropTap: { flex: 1 },
  brandMark: { alignItems: "center", justifyContent: "center" },
  // Invisible but mounted — captureScreen must shoot the app, and toggling the
  // Modal instead would unmount the form state.
  captureHidden: { opacity: 0 },
  closeGlyph: { fontSize: 18, padding: 4 },
  // Generous vertical padding: this row is the drag target, not just decoration.
  handle: { borderRadius: 999, height: 4, width: 40 },
  handleRow: { alignItems: "center", paddingBottom: 6, paddingTop: 10 },
  header: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 9,
  },
  headerBack: { alignItems: "center", flexDirection: "row", gap: 3, marginLeft: -4 },
  headerBrand: { alignItems: "center", flexDirection: "row", gap: 8 },
  headerRight: { alignItems: "center", flexDirection: "row", gap: 10 },
  headerTitle: { fontSize: 15, fontWeight: "700", letterSpacing: -0.2 },
  headerTitleDim: { fontWeight: "500" },
  overridePill: { borderRadius: 999, paddingHorizontal: 9, paddingVertical: 3 },
  overridePillText: { fontSize: 12, fontVariant: ["tabular-nums"], fontWeight: "800" },
  home: { flex: 1, gap: 10, padding: 20, paddingBottom: 16 },
  homeActions: { gap: 10, marginTop: 6 },
  homeBrand: { alignItems: "center", gap: 8, paddingBottom: 10, paddingTop: 18 },
  homeConnectHint: { fontSize: 11.5, paddingHorizontal: 20, textAlign: "center" },
  homeSpacer: { flex: 1, minHeight: 8 },
  homeTagline: { paddingHorizontal: 24, textAlign: "center" },
  homeWordmark: { fontSize: 20, letterSpacing: -0.4 },
  loginError: { fontSize: 13, textAlign: "center" },
  menu: { gap: 10, padding: 16, paddingBottom: 24 },
  menuLogout: { alignItems: "center", paddingTop: 6 },
  menuLogoutText: { fontSize: 13, fontWeight: "600" },
  panel: { flex: 1, paddingHorizontal: 16, paddingTop: 10 },
  // Height, top radius and top padding are animated inline (see the drag
  // handling above) — only the chrome that never changes lives here.
  sheet: { borderWidth: 1, overflow: "hidden" },
  sheetInner: { flex: 1 },
  sectionChevron: { fontSize: 24, fontWeight: "400", marginTop: -2 },
  sectionGlyphWrap: {
    alignItems: "center",
    borderRadius: 10,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  sectionLabel: { flex: 1, fontSize: 15, fontWeight: "600" },
  sectionRow: {
    alignItems: "center",
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
});
