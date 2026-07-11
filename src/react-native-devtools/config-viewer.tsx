// Full-page nested config viewer — the drill-in screen behind a config row.
// Renders the effective config value as a READ-ONLY tree (the shared ValueTree)
// with a raw-JSON escape hatch. Nothing here mutates: configs are inspected,
// not forced, from the overlay.

import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { ConfigRecord } from "../devtools/types";
import type { DevtoolsEngineBridge } from "../devtools/bridge";
import { ValueTree } from "./value-tree";
import { Badge, Muted, useTheme } from "./ui";

export function ConfigViewerScreen(props: {
  config: ConfigRecord;
  bridge: DevtoolsEngineBridge | null;
}): ReactNode {
  const t = useTheme();
  const { config, bridge } = props;

  // Effective value: a local override (set elsewhere via the SDK) wins, then the
  // live evaluated value, then the config's saved value. Read-only either way.
  const overrides = bridge ? bridge.getOverrides().configs : {};
  const forced = Object.prototype.hasOwnProperty.call(overrides, config.name);
  const live = bridge ? bridge.getConfig(config.name) : undefined;
  const effective = forced
    ? overrides[config.name]
    : live !== undefined
      ? live
      : config.valueJson;

  const [raw, setRaw] = useState(false);
  const rawText = useMemo(() => JSON.stringify(effective ?? {}, null, 2), [effective]);

  return (
    <View style={styles.screen}>
      <View style={styles.statusRow}>
        <Badge label={forced ? "override" : "live"} tone={forced ? "accent" : "ok"} />
        <Muted style={styles.statusText}>
          {forced ? "Showing your local override" : "Live value — read-only"}
        </Muted>
        <Pressable accessibilityRole="button" onPress={() => setRaw((r) => !r)}>
          <Text style={[styles.rawToggle, { color: t.accent }]}>{raw ? "Tree" : "Raw JSON"}</Text>
        </Pressable>
      </View>

      {raw ? (
        <ScrollView style={styles.rawScroll} contentContainerStyle={styles.rawContent}>
          <Text
            accessibilityLabel="Raw JSON"
            style={[styles.rawText, { backgroundColor: t.bg, borderColor: t.border, color: t.fg }]}
            selectable
          >
            {rawText}
          </Text>
        </ScrollView>
      ) : (
        <ScrollView style={styles.tree} contentContainerStyle={styles.treeContent}>
          <ValueTree label={config.name} value={effective} depth={0} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  rawContent: { paddingBottom: 16 },
  rawScroll: { flex: 1 },
  rawText: {
    borderRadius: 8,
    borderWidth: 1,
    fontFamily: "Menlo",
    fontSize: 12,
    padding: 10,
  },
  rawToggle: { fontSize: 12.5, fontWeight: "600" },
  screen: { flex: 1, paddingBottom: 8 },
  statusRow: { alignItems: "center", flexDirection: "row", gap: 8, marginBottom: 10 },
  statusText: { flex: 1 },
  tree: { flex: 1 },
  treeContent: { paddingBottom: 16 },
});
