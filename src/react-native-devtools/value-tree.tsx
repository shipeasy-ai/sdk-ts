// Read-only structured-value display — the collapsible tree the config viewer
// renders, extracted so any KV-ish row (experiment params, forced config
// overrides) can show real nested structure instead of a one-line JSON dump.

import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import { Muted, useTheme } from "./ui";

export type ValueKind = "object" | "array" | "string" | "number" | "boolean" | "null";

export function kindOf(v: unknown): ValueKind {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "object") return "object";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return "string";
}

/** How a leaf value reads (quoted strings, literal booleans/null). */
function fmtLeaf(v: unknown): string {
  const k = kindOf(v);
  if (k === "null") return "null";
  if (k === "boolean") return v ? "true" : "false";
  if (k === "string") return `"${String(v)}"`;
  return String(v);
}

const KIND_TONE: Record<ValueKind, string> = {
  object: "#c084fc",
  array: "#22d3ee",
  string: "#34d399",
  number: "#f59e0b",
  boolean: "#a78bfa",
  null: "#9b9ba3",
};

function entriesOf(value: unknown, kind: ValueKind): Array<[string | number, unknown]> {
  if (kind === "array") return (value as unknown[]).map((v, i) => [i, v]);
  if (kind === "object") return Object.entries(value as Record<string, unknown>);
  return [];
}

/** One labelled node — a leaf shows its value inline; an object/array shows a
 *  key/item count and expands to its children (nested trees). */
export function ValueTree(props: {
  label: string;
  value: unknown;
  depth?: number;
  /** Trailing muted hint after the label (e.g. a param type, or "default"). */
  hint?: string;
  /** Tint the label + leaf accent (e.g. an overridden value). */
  accent?: boolean;
}): ReactNode {
  const t = useTheme();
  const depth = props.depth ?? 0;
  const { value } = props;
  const kind = kindOf(value);
  const branch = kind === "object" || kind === "array";
  const [open, setOpen] = useState(depth < 1);
  const entries = entriesOf(value, kind);
  const labelColor = props.accent ? t.accent : t.fg;

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
        <Text style={[styles.key, { color: labelColor }]} numberOfLines={1}>
          {props.label}
        </Text>
        {props.hint ? <Muted style={styles.hint}>{props.hint}</Muted> : null}
        <View style={[styles.kindDot, { backgroundColor: KIND_TONE[kind] }]} />
        {branch ? (
          <Text style={[styles.count, { color: t.fgMuted }]}>
            {entries.length} {kind === "array" ? "item" : "key"}
            {entries.length === 1 ? "" : "s"}
          </Text>
        ) : (
          <Text
            style={[styles.leafValue, { color: props.accent ? t.accent : t.fg }]}
            numberOfLines={2}
            selectable
          >
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
              <ValueTree key={String(k)} label={String(k)} value={v} depth={depth + 1} />
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

/** A value rendered WITHOUT a root label — an object/array's entries as nested
 *  trees, or a scalar as a single line. For displaying a value under its own
 *  heading (e.g. a forced config override under the config's name). */
export function ValueContents(props: { value: unknown }): ReactNode {
  const t = useTheme();
  const kind = kindOf(props.value);
  const entries = entriesOf(props.value, kind);
  if (kind === "object" || kind === "array") {
    if (entries.length === 0) return <Muted>{kind === "array" ? "empty" : "no fields"}</Muted>;
    return (
      <>
        {entries.map(([k, v]) => (
          <ValueTree key={String(k)} label={String(k)} value={v} depth={1} />
        ))}
      </>
    );
  }
  return (
    <Text style={[styles.scalar, { color: t.fg }]} selectable>
      {fmtLeaf(props.value)}
    </Text>
  );
}

const styles = StyleSheet.create({
  caret: { fontSize: 12 },
  caretHit: { alignItems: "center", justifyContent: "center", width: 16 },
  children: { borderLeftWidth: 1, gap: 2, marginLeft: 7, marginTop: 2, paddingLeft: 8 },
  count: { flex: 1, fontSize: 11.5 },
  emptyBranch: { fontSize: 12, paddingVertical: 4 },
  hint: { fontSize: 11 },
  key: { fontSize: 13, fontWeight: "600", maxWidth: "42%" },
  kindDot: { borderRadius: 999, height: 7, width: 7 },
  leafValue: { flex: 1, fontFamily: "Menlo", fontSize: 12.5, textAlign: "right" },
  node: {},
  nodeRow: { alignItems: "center", flexDirection: "row", gap: 6, minHeight: 34 },
  scalar: { fontFamily: "Menlo", fontSize: 12.5 },
});
