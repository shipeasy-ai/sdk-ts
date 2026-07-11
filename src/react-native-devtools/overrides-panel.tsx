// Active-overrides screen — every programmatic override in effect this session
// (forced flags, configs, and experiment variants), read live off the engine
// bridge. Each can be cleared individually or all at once; clearing restores
// the app to its real evaluated state immediately (no reload).

import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsEngineBridge } from "../devtools/bridge";
import { Badge, Button, Chip, Muted, SectionLabel, useTheme } from "./ui";

function preview(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s !== undefined && s.length > 48 ? `${s.slice(0, 48)}…` : String(s);
}

function OverrideRow(props: {
  name: string;
  value: ReactNode;
  onClear: () => void;
}): ReactNode {
  const t = useTheme();
  return (
    <View style={[styles.row, { backgroundColor: t.surface, borderColor: t.border, borderRadius: t.radius }]}>
      <View style={styles.rowMain}>
        <Text numberOfLines={1} style={[styles.rowName, { color: t.fg }]}>
          {props.name}
        </Text>
      </View>
      {props.value}
      <Chip label="Clear" tone="danger" onPress={props.onClear} />
    </View>
  );
}

export function OverridesPanel(props: { bridge: DevtoolsEngineBridge | null }): ReactNode {
  const t = useTheme();
  const { bridge } = props;

  if (!bridge) {
    return (
      <View style={styles.empty}>
        <Muted style={styles.emptyText}>
          Overrides need the app to configure the Shipeasy client SDK.
        </Muted>
      </View>
    );
  }

  const ov = bridge.getOverrides();
  const flags = Object.entries(ov.flags);
  const configs = Object.entries(ov.configs);
  const experiments = Object.entries(ov.experiments);
  const total = flags.length + configs.length + experiments.length;

  if (total === 0) {
    return (
      <View style={styles.empty}>
        <Text style={[styles.emptyGlyph, { color: t.fgMuted }]}>⚡</Text>
        <Muted style={styles.emptyText}>
          No active overrides. Force a flag or experiment variant and it shows up here — and applies
          live in the running app.
        </Muted>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.list} showsVerticalScrollIndicator={false}>
      <View style={styles.head}>
        <Muted style={styles.headText}>
          {total} override{total === 1 ? "" : "s"} active this session
        </Muted>
        <Button
          title="Clear all"
          variant="danger"
          onPress={() => bridge.clearOverrides()}
          style={styles.clearAll}
        />
      </View>

      {flags.length > 0 ? (
        <>
          <SectionLabel hint={String(flags.length)}>Feature flags</SectionLabel>
          {flags.map(([name, value]) => (
            <OverrideRow
              key={name}
              name={name}
              value={<Badge label={value ? "ON" : "OFF"} tone={value ? "ok" : "muted"} />}
              onClear={() => bridge.removeOverride("flag", name)}
            />
          ))}
        </>
      ) : null}

      {experiments.length > 0 ? (
        <>
          <SectionLabel hint={String(experiments.length)}>Experiments</SectionLabel>
          {experiments.map(([name, group]) => (
            <OverrideRow
              key={name}
              name={name}
              value={<Badge label={group} tone="accent" />}
              onClear={() => bridge.removeOverride("experiment", name)}
            />
          ))}
        </>
      ) : null}

      {configs.length > 0 ? (
        <>
          <SectionLabel hint={String(configs.length)}>Configs</SectionLabel>
          {configs.map(([name, value]) => (
            <OverrideRow
              key={name}
              name={name}
              value={<Muted style={styles.cfgPreview} numberOfLines={1}>{preview(value)}</Muted>}
              onClear={() => bridge.removeOverride("config", name)}
            />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  cfgPreview: { flexShrink: 1, maxWidth: 130, textAlign: "right" },
  clearAll: { paddingHorizontal: 12 },
  empty: { alignItems: "center", gap: 10, padding: 28, paddingTop: 48 },
  emptyGlyph: { fontSize: 30 },
  emptyText: { paddingHorizontal: 12, textAlign: "center" },
  head: { alignItems: "center", flexDirection: "row", gap: 10, justifyContent: "space-between", marginBottom: 4 },
  headText: { flex: 1 },
  list: { paddingBottom: 24 },
  row: {
    alignItems: "center",
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  rowMain: { flex: 1, marginRight: 4 },
  rowName: { fontSize: 14, fontWeight: "600" },
});
