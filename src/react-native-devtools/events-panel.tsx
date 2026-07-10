// Events panel — the live SDK event stream (identify evaluations + override
// mutations), captured into a module-level ring so events fired while the
// overlay was closed still show. Mirrors the web overlay's events panel; the
// feed arrives via the engine bridge's onEvent instead of window events.

import { FlatList, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsStateEvent } from "../devtools/bridge";
import { useEngineBridge, useEventLog } from "./hooks";
import { Badge, CenterState, Muted, SectionLabel, timeAgo, useTheme } from "./ui";

const KIND_LABEL: Record<DevtoolsStateEvent["kind"], string> = {
  evaluate: "eval",
  override: "set",
  update: "sdk",
};

export function EventsPanel(): ReactNode {
  const t = useTheme();
  const bridge = useEngineBridge();
  const events = useEventLog();

  if (events.length === 0) {
    return (
      <CenterState>
        <Muted style={styles.centerText}>
          {bridge
            ? "SDK evaluations and overrides will stream here as the app interacts with Shipeasy."
            : "Configure the Shipeasy client SDK in this app to capture its event stream."}
        </Muted>
      </CenterState>
    );
  }

  const now = Date.now();
  const newestFirst = events.slice().reverse();
  return (
    <View style={styles.fill}>
      <SectionLabel hint={`${events.length} captured`}>Live event stream</SectionLabel>
      <FlatList
        data={newestFirst}
        keyExtractor={(e, i) => `${e.ts}:${i}`}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={[styles.row, { borderBottomColor: t.border }]}>
            <Badge
              label={KIND_LABEL[item.kind]}
              tone={item.kind === "override" ? "accent" : item.kind === "evaluate" ? "ok" : "muted"}
            />
            <Text style={[styles.subject, { color: t.fg }]} numberOfLines={1}>
              {item.subject}
            </Text>
            <Text style={[styles.value, { color: t.fgMuted }]} numberOfLines={1}>
              {item.value}
            </Text>
            <Text style={[styles.ts, { color: t.fgMuted }]}>{timeAgo(now, item.ts)}</Text>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  centerText: { textAlign: "center" },
  fill: { flex: 1 },
  list: { paddingBottom: 24 },
  row: {
    alignItems: "center",
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 8,
    paddingVertical: 8,
  },
  subject: { flexShrink: 1, fontSize: 13, fontWeight: "600" },
  ts: { fontSize: 11, marginLeft: "auto" },
  value: { flexShrink: 1, fontSize: 12 },
});
