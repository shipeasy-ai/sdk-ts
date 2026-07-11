// Full-page nested config viewer — the drill-in screen behind a config row.
// Renders the effective config value as a READ-ONLY tree (expand/collapse
// nested objects & arrays, typed leaf readout) with a raw-JSON escape hatch.
// Nothing here mutates: configs are inspected, not forced, from the overlay.

import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { ConfigRecord } from "../devtools/types";
import type { DevtoolsEngineBridge } from "../devtools/bridge";
import { Badge, Muted, useTheme } from "./ui";

type Path = Array<string | number>;
type Kind = "object" | "array" | "string" | "number" | "boolean" | "null";

function kindOf(v: unknown): Kind {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "object") return "object";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return "string";
}

/** How a leaf value reads in the tree. */
function fmtLeaf(v: unknown): string {
  const k = kindOf(v);
  if (k === "null") return "null";
  if (k === "boolean") return v ? "true" : "false";
  if (k === "string") return `"${String(v)}"`;
  return String(v);
}

const KIND_TONE: Record<Kind, string> = {
  object: "#c084fc",
  array: "#22d3ee",
  string: "#34d399",
  number: "#f59e0b",
  boolean: "#a78bfa",
  null: "#9b9ba3",
};

// ── recursive node (read-only) ───────────────────────────────────────────────

function Node(props: {
  label: string;
  value: unknown;
  path: Path;
  depth: number;
}): ReactNode {
  const t = useTheme();
  const { value, path, depth } = props;
  const kind = kindOf(value);
  const branch = kind === "object" || kind === "array";
  const [open, setOpen] = useState(depth < 1);

  const entries: Array<[string | number, unknown]> = branch
    ? kind === "array"
      ? (value as unknown[]).map((v, i) => [i, v])
      : Object.entries(value as Record<string, unknown>)
    : [];

  return (
    <View style={styles.node}>
      <View style={styles.nodeRow}>
        {branch ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${props.label} ${open ? "collapse" : "expand"}`}
            onPress={() => setOpen((o) => !o)}
            style={styles.caretHit}
          >
            <Text style={[styles.caret, { color: t.fgMuted }]}>{open ? "▾" : "▸"}</Text>
          </Pressable>
        ) : (
          <View style={styles.caretHit} />
        )}
        <Text style={[styles.key, { color: t.fg }]} numberOfLines={1}>
          {props.label}
        </Text>
        <View style={[styles.kindDot, { backgroundColor: KIND_TONE[kind] }]} />
        {branch ? (
          <Text style={[styles.count, { color: t.fgMuted }]}>
            {entries.length} {kind === "array" ? "item" : "key"}
            {entries.length === 1 ? "" : "s"}
          </Text>
        ) : (
          <Text style={[styles.leafValue, { color: t.fg }]} numberOfLines={2} selectable>
            {fmtLeaf(value)}
          </Text>
        )}
      </View>

      {branch && open ? (
        <View style={[styles.children, { borderLeftColor: t.border }]}>
          {entries.length === 0 ? (
            <Muted style={styles.emptyBranch}>{kind === "array" ? "empty" : "no keys"}</Muted>
          ) : (
            entries.map(([k, v]) => (
              <Node key={String(k)} label={String(k)} value={v} path={[...path, k]} depth={depth + 1} />
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

// ── the screen ───────────────────────────────────────────────────────────────

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
        <ScrollView
          style={styles.rawScroll}
          contentContainerStyle={styles.rawContent}
          horizontal={false}
        >
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
          <Node label={config.name} value={effective} path={[]} depth={0} />
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  caret: { fontSize: 12 },
  caretHit: { alignItems: "center", justifyContent: "center", width: 16 },
  children: { borderLeftWidth: 1, gap: 2, marginLeft: 7, marginTop: 2, paddingLeft: 8 },
  count: { flex: 1, fontSize: 11.5 },
  emptyBranch: { fontSize: 12, paddingVertical: 4 },
  key: { fontSize: 13, fontWeight: "600", maxWidth: "42%" },
  kindDot: { borderRadius: 999, height: 7, width: 7 },
  leafValue: {
    flex: 1,
    fontFamily: "Menlo",
    fontSize: 12.5,
    textAlign: "right",
  },
  node: {},
  nodeRow: { alignItems: "center", flexDirection: "row", gap: 6, minHeight: 34 },
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
