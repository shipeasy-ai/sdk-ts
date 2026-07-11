// User panel — a read-only mirror of the engine bridge's identify() payload.
// It shows exactly what the app handed identify() (caller fields) plus the
// attributes the SDK auto-collects on every identify() (anonymous_id + browser/
// device context). Nothing here is editable: this is an inspector, not a
// simulator — the values are the live targeting inputs, verbatim.

import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import { useEngineBridge } from "./hooks";
import { CenterState, KV, Muted, SectionLabel, useTheme } from "./ui";

/** Attributes the SDK injects on every identify() (see `collectBrowserAttrs` +
 *  the always-on `anonymous_id` in the client engine). Everything else in the
 *  payload came straight from the app's identify() call. */
const AUTO_KEYS = new Set([
  "anonymous_id",
  "locale",
  "timezone",
  "referrer",
  "path",
  "screen_width",
  "screen_height",
  "user_agent",
]);

/** Render any identify() value verbatim: scalars as-is, objects/arrays as JSON
 *  so nested targeting attributes are shown in full rather than dropped. */
function render(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

export function UserPanel(): ReactNode {
  const t = useTheme();
  const bridge = useEngineBridge();

  if (!bridge) {
    return (
      <CenterState>
        <Muted style={styles.centerText}>
          The app hasn't configured the Shipeasy client SDK — no user to show.
        </Muted>
      </CenterState>
    );
  }

  const user = bridge.getUser();
  if (!user) {
    return (
      <CenterState>
        <Muted style={styles.centerText}>
          No identified user yet. Once the app calls identify(), the user's properties show here.
        </Muted>
      </CenterState>
    );
  }

  // Split the payload into what the app passed vs what the SDK auto-collected.
  // `$`-prefixed keys are devtools sentinels — never part of identify().
  const callerFields: [string, unknown][] = [];
  const autoFields: [string, unknown][] = [];
  for (const [k, v] of Object.entries(user)) {
    if (k.startsWith("$")) continue;
    (AUTO_KEYS.has(k) ? autoFields : callerFields).push([k, v]);
  }

  const idVal =
    (user.user_id as string) || (user.id as string) || (user.anonymous_id as string) || "—";
  const emailVal = (user.email as string) || (user.user_email as string) || "";

  return (
    <ScrollView contentContainerStyle={styles.scroll}>
      <View style={[styles.who, { borderColor: t.border, borderRadius: t.radius }]}>
        <View style={[styles.avatar, { backgroundColor: t.accentSoft }]}>
          <Text style={[styles.avatarText, { color: t.accent }]}>
            {(emailVal || idVal).trim().charAt(0).toUpperCase() || "?"}
          </Text>
        </View>
        <View style={styles.whoInfo}>
          <Text style={[styles.whoEmail, { color: t.fg }]} numberOfLines={1}>
            {emailVal || idVal}
          </Text>
          <Muted numberOfLines={1}>{idVal}</Muted>
        </View>
      </View>

      <SectionLabel hint="from identify()">User properties</SectionLabel>
      {callerFields.length === 0 ? (
        <Muted>The app called identify() with no properties.</Muted>
      ) : (
        callerFields.map(([k, v]) => <KV key={k} k={`user.${k}`} v={render(v)} />)
      )}

      <SectionLabel hint="auto-collected">Attributes</SectionLabel>
      {autoFields.length === 0 ? (
        <Muted>No auto-collected attributes.</Muted>
      ) : (
        autoFields.map(([k, v]) => <KV key={k} k={k} v={render(v)} accent />)
      )}

      <SectionLabel hint="read-only">Device context</SectionLabel>
      <KV k="ctx.platform" v={Platform.OS} accent />
      <KV k="ctx.platform_version" v={String(Platform.Version)} accent />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: "center",
    borderRadius: 999,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  avatarText: { fontSize: 17, fontWeight: "700" },
  centerText: { textAlign: "center" },
  scroll: { paddingBottom: 32 },
  who: {
    alignItems: "center",
    borderWidth: 1,
    flexDirection: "row",
    gap: 12,
    marginBottom: 4,
    padding: 12,
  },
  whoEmail: { flexShrink: 1, fontSize: 15, fontWeight: "600" },
  whoInfo: { flex: 1, gap: 2 },
});
