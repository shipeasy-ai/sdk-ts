// Active-overrides screen — every programmatic override in effect this session
// (forced flags, configs, and experiment variants), read live off the engine
// bridge. Each can be cleared individually or all at once; clearing restores
// the app to its real evaluated state immediately (no reload).

import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsEngineBridge } from "../devtools/bridge";
import { ValueContents } from "./value-tree";
import { Badge, Button, Chip, Muted, SectionLabel, useTheme } from "./ui";

function OverrideRow(props: {
  name: string;
  /** Inline value shown on the header row (e.g. an ON/OFF or variant badge). */
  value?: ReactNode;
  /** Structured value rendered below the header (e.g. a forced config's tree). */
  body?: ReactNode;
  onClear: () => void;
}): ReactNode {
  const t = useTheme();
  return (
    <View style={[styles.row, { backgroundColor: t.surface, borderColor: t.border, borderRadius: t.radius }]}>
      <View style={styles.rowHead}>
        <View style={styles.rowMain}>
          <Text numberOfLines={1} style={[styles.rowName, { color: t.fg }]}>
            {props.name}
          </Text>
        </View>
        {props.value}
        <Chip label="Clear" tone="danger" onPress={props.onClear} />
      </View>
      {props.body ? <View style={styles.rowBody}>{props.body}</View> : null}
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
              body={<ValueContents value={value} />}
              onClear={() => bridge.removeOverride("config", name)}
            />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  clearAll: { paddingHorizontal: 12 },
  empty: { alignItems: "center", gap: 10, padding: 28, paddingTop: 48 },
  emptyGlyph: { fontSize: 30 },
  emptyText: { paddingHorizontal: 12, textAlign: "center" },
  head: { alignItems: "center", flexDirection: "row", gap: 10, justifyContent: "space-between", marginBottom: 4 },
  headText: { flex: 1 },
  list: { paddingBottom: 24 },
  row: {
    borderWidth: 1,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  rowBody: { marginTop: 8 },
  rowHead: { alignItems: "center", flexDirection: "row", gap: 8 },
  rowMain: { flex: 1, marginRight: 4 },
  rowName: { fontSize: 14, fontWeight: "600" },
});
