// User panel — mirrors the web overlay's: shows the identify() payload from
// the engine bridge, lets the developer edit properties to simulate another
// user, and re-evaluates. Unlike the web overlay (which only re-renders), the
// bridge re-runs identify() so gates/experiments/configs re-resolve for real.

import { useState } from "react";
import { Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import { useEngineBridge } from "./hooks";
import { Badge, Button, CenterState, Field, KV, Muted, SectionLabel, useTheme } from "./ui";

/** Scalar props only — `$`-prefixed keys are devtools sentinels (`$mock`
 *  marks a simulated user) and objects aren't editable inline. */
function scalarProps(user: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(user)) {
    if (k.startsWith("$") || v == null || typeof v === "object") continue;
    out[k] = String(v);
  }
  return out;
}

export function UserPanel(): ReactNode {
  const t = useTheme();
  const bridge = useEngineBridge();
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [reevaluating, setReevaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  if (!user && Object.keys(edits).length === 0) {
    return (
      <CenterState>
        <Muted style={styles.centerText}>
          No identified user yet. Once the app calls identify(), the user's properties show here
          and you can simulate other users.
        </Muted>
      </CenterState>
    );
  }

  const base = user ? scalarProps(user) : {};
  const merged = { ...base, ...edits };
  const isMock = !!user?.$mock;
  const idVal = merged.user_id || merged.id || merged.anonymous_id || "—";
  const emailVal = merged.email || merged.user_email || "";
  const dirty = Object.entries(edits).filter(([k, v]) => (base[k] ?? "") !== v);

  const reevaluate = async (props: Record<string, string>) => {
    setError(null);
    setReevaluating(true);
    try {
      await bridge.identify(props);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Re-evaluate failed.");
    } finally {
      setReevaluating(false);
    }
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
      <View style={[styles.who, { borderColor: t.border, borderRadius: t.radius }]}>
        <View style={[styles.avatar, { backgroundColor: t.accentSoft }]}>
          <Text style={[styles.avatarText, { color: t.accent }]}>
            {(emailVal || idVal).trim().charAt(0).toUpperCase() || "?"}
          </Text>
        </View>
        <View style={styles.whoInfo}>
          <View style={styles.whoTop}>
            <Text style={[styles.whoEmail, { color: t.fg }]} numberOfLines={1}>
              {emailVal || idVal}
            </Text>
            {isMock ? <Badge label="mock" tone="accent" /> : null}
          </View>
          <Muted numberOfLines={1}>{idVal}</Muted>
        </View>
      </View>

      <SectionLabel hint="edit to simulate">User properties</SectionLabel>
      {Object.keys(merged).length === 0 ? (
        <Muted>No user properties yet.</Muted>
      ) : (
        Object.entries(merged).map(([k, v]) => (
          <Field
            key={k}
            label={`user.${k}`}
            value={v}
            autoCapitalize="none"
            onChangeText={(next) => setEdits((e) => ({ ...e, [k]: next }))}
          />
        ))
      )}

      <SectionLabel hint="read-only">Device context</SectionLabel>
      <KV k="ctx.platform" v={Platform.OS} accent />
      <KV k="ctx.platform_version" v={String(Platform.Version)} accent />

      {error ? <Text style={[styles.error, { color: t.danger }]}>{error}</Text> : null}
      <Button
        title={dirty.length > 0 ? "Re-evaluate with changes" : "Re-evaluate"}
        onPress={() => void reevaluate(merged)}
        loading={reevaluating}
      />
      <Button
        title="Reset"
        variant="ghost"
        style={styles.reset}
        onPress={() => {
          setEdits({});
          void reevaluate(base);
        }}
      />
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
  error: { fontSize: 13, marginBottom: 10 },
  reset: { marginTop: 8 },
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
  whoTop: { alignItems: "center", flexDirection: "row", gap: 8 },
});
