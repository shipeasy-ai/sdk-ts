// Full-page nested config editor — the drill-in screen behind a config row.
// Renders the effective config value as an editable tree (expand/collapse
// nested objects & arrays, typed leaf controls, add/remove fields), with a raw
// JSON escape hatch. Applying writes an override through the engine bridge.

import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { ReactNode } from "react";
import type { ConfigRecord } from "../devtools/types";
import type { DevtoolsEngineBridge } from "../devtools/bridge";
import { Badge, Button, Chip, ChipRow, Muted, Toggle, useTheme } from "./ui";

type Path = Array<string | number>;
type Kind = "object" | "array" | "string" | "number" | "boolean" | "null";

function clone<T>(v: T): T {
  return v == null ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function kindOf(v: unknown): Kind {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "object") return "object";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return "string";
}

function getAtPath(root: unknown, path: Path): unknown {
  return path.reduce<unknown>((acc, k) => (acc as Record<string | number, unknown>)?.[k], root);
}

function shallowCopy(root: unknown): Record<string | number, unknown> {
  return (
    Array.isArray(root) ? [...(root as unknown[])] : { ...(root as Record<string, unknown>) }
  ) as unknown as Record<string | number, unknown>;
}

function setAtPath(root: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const copy = shallowCopy(root);
  copy[head] = setAtPath(copy[head], rest, value);
  return copy;
}

function removeAtPath(root: unknown, path: Path): unknown {
  const [head, ...rest] = path;
  if (rest.length === 0) {
    if (Array.isArray(root)) {
      const a = [...(root as unknown[])];
      a.splice(head as number, 1);
      return a;
    }
    const o = { ...(root as Record<string, unknown>) };
    delete o[head as string];
    return o;
  }
  const copy = shallowCopy(root);
  copy[head] = removeAtPath(copy[head], rest);
  return copy;
}

/** A blank value of the chosen kind, for the add-field affordance. */
function blankOf(kind: Kind): unknown {
  switch (kind) {
    case "object":
      return {};
    case "array":
      return [];
    case "number":
      return 0;
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return "";
  }
}

const KIND_TONE: Record<Kind, string> = {
  object: "#c084fc",
  array: "#22d3ee",
  string: "#34d399",
  number: "#f59e0b",
  boolean: "#a78bfa",
  null: "#9b9ba3",
};

// ── leaf editors ─────────────────────────────────────────────────────────────

function LeafEditor(props: {
  value: unknown;
  onChange: (v: unknown) => void;
}): ReactNode {
  const t = useTheme();
  const kind = kindOf(props.value);
  if (kind === "boolean") {
    return (
      <Toggle
        value={props.value === true}
        onValueChange={props.onChange}
        accessibilityLabel="value"
      />
    );
  }
  if (kind === "null") {
    return <Muted>null</Muted>;
  }
  return (
    <TextInput
      accessibilityLabel="value"
      value={String(props.value)}
      onChangeText={(text) => {
        if (kind === "number") {
          const n = Number(text);
          props.onChange(text.trim() === "" || Number.isNaN(n) ? text : n);
        } else {
          props.onChange(text);
        }
      }}
      keyboardType={kind === "number" ? "numeric" : "default"}
      autoCapitalize="none"
      autoCorrect={false}
      placeholderTextColor={t.fgMuted}
      style={[styles.leafInput, { backgroundColor: t.bg, borderColor: t.border, color: t.fg }]}
    />
  );
}

// ── add-field affordance ─────────────────────────────────────────────────────

const ADDABLE: Kind[] = ["string", "number", "boolean", "object", "array"];

function AddField(props: {
  isArray: boolean;
  onAdd: (key: string | null, value: unknown) => void;
}): ReactNode {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [kind, setKind] = useState<Kind>("string");

  if (!open) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.isArray ? "Add item" : "Add field"}
        onPress={() => setOpen(true)}
        style={styles.addTrigger}
      >
        <Text style={[styles.addPlus, { color: t.accent }]}>+</Text>
        <Text style={[styles.addLabel, { color: t.accent }]}>
          {props.isArray ? "Add item" : "Add field"}
        </Text>
      </Pressable>
    );
  }
  const commit = () => {
    if (!props.isArray && key.trim() === "") return;
    props.onAdd(props.isArray ? null : key.trim(), blankOf(kind));
    setKey("");
    setKind("string");
    setOpen(false);
  };
  return (
    <View style={[styles.addForm, { borderColor: t.border }]}>
      {props.isArray ? null : (
        <TextInput
          accessibilityLabel="New field key"
          value={key}
          onChangeText={setKey}
          placeholder="key"
          placeholderTextColor={t.fgMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.leafInput, { backgroundColor: t.bg, borderColor: t.border, color: t.fg }]}
        />
      )}
      <ChipRow>
        {ADDABLE.map((k) => (
          <Chip key={k} label={k} selected={kind === k} onPress={() => setKind(k)} />
        ))}
      </ChipRow>
      <ChipRow>
        <Chip label="Add" selected onPress={commit} />
        <Chip label="Cancel" onPress={() => setOpen(false)} />
      </ChipRow>
    </View>
  );
}

// ── recursive node ───────────────────────────────────────────────────────────

function Node(props: {
  label: string;
  value: unknown;
  path: Path;
  depth: number;
  onChange: (path: Path, value: unknown) => void;
  onRemove: (path: Path) => void;
  onAdd: (path: Path, key: string | null, value: unknown) => void;
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
          <View style={styles.leafWrap}>
            <LeafEditor value={value} onChange={(v) => props.onChange(path, v)} />
          </View>
        )}
        {path.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Remove ${props.label}`}
            onPress={() => props.onRemove(path)}
            style={styles.removeHit}
          >
            <Text style={[styles.remove, { color: t.fgMuted }]}>✕</Text>
          </Pressable>
        ) : null}
      </View>

      {branch && open ? (
        <View style={[styles.children, { borderLeftColor: t.border }]}>
          {entries.map(([k, v]) => (
            <Node
              key={String(k)}
              label={String(k)}
              value={v}
              path={[...path, k]}
              depth={depth + 1}
              onChange={props.onChange}
              onRemove={props.onRemove}
              onAdd={props.onAdd}
            />
          ))}
          <AddField
            isArray={kind === "array"}
            onAdd={(key, val) => props.onAdd(path, key, val)}
          />
        </View>
      ) : null}
    </View>
  );
}

// ── the screen ───────────────────────────────────────────────────────────────

export function ConfigEditorScreen(props: {
  config: ConfigRecord;
  bridge: DevtoolsEngineBridge | null;
  onClose: () => void;
}): ReactNode {
  const t = useTheme();
  const { config, bridge } = props;

  const overrides = bridge ? bridge.getOverrides().configs : {};
  const forced = Object.prototype.hasOwnProperty.call(overrides, config.name);
  const live = bridge ? bridge.getConfig(config.name) : undefined;
  const effective = forced
    ? overrides[config.name]
    : live !== undefined
      ? live
      : config.valueJson;

  const [draft, setDraft] = useState<unknown>(() => clone(effective) ?? {});
  const [raw, setRaw] = useState(false);
  const [rawText, setRawText] = useState(() => JSON.stringify(clone(effective) ?? {}, null, 2));
  const [rawErr, setRawErr] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(effective),
    [draft, effective],
  );

  const onChange = (path: Path, value: unknown) =>
    setDraft((d: unknown) => setAtPath(d, path, value));
  const onRemove = (path: Path) => setDraft((d: unknown) => removeAtPath(d, path));
  const onAdd = (path: Path, key: string | null, value: unknown) =>
    setDraft((d: unknown) => {
      const target = getAtPath(d, path);
      if (Array.isArray(target)) return setAtPath(d, path, [...target, value]);
      return setAtPath(d, path, { ...(target as Record<string, unknown>), [key as string]: value });
    });

  const enterRaw = () => {
    setRawText(JSON.stringify(draft, null, 2));
    setRawErr(null);
    setRaw(true);
  };
  const exitRaw = () => {
    try {
      setDraft(JSON.parse(rawText));
      setRawErr(null);
      setRaw(false);
    } catch (e) {
      setRawErr(e instanceof Error ? e.message : "Invalid JSON");
    }
  };

  const apply = () => {
    if (!bridge) return;
    let next = draft;
    if (raw) {
      try {
        next = JSON.parse(rawText);
      } catch (e) {
        setRawErr(e instanceof Error ? e.message : "Invalid JSON");
        return;
      }
    }
    // Object-schema configs must stay object-shaped at the root (mirrors the web form).
    const schemaType = (config.schema as { type?: string }).type;
    if (
      schemaType === "object" &&
      (typeof next !== "object" || next === null || Array.isArray(next))
    ) {
      setRawErr("This config's schema expects a JSON object at the root.");
      return;
    }
    bridge.setConfigOverride(config.name, next);
    props.onClose();
  };

  return (
    <View style={styles.screen}>
      <View style={styles.statusRow}>
        <Badge label={forced ? "override" : "live"} tone={forced ? "accent" : "ok"} />
        <Muted style={styles.statusText}>
          {forced ? "Editing your local override" : "No override — editing forks the live value"}
        </Muted>
        <Pressable accessibilityRole="button" onPress={() => (raw ? exitRaw() : enterRaw())}>
          <Text style={[styles.rawToggle, { color: t.accent }]}>{raw ? "Tree" : "Raw JSON"}</Text>
        </Pressable>
      </View>

      {raw ? (
        <>
          <TextInput
            accessibilityLabel="Raw JSON"
            value={rawText}
            onChangeText={setRawText}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            placeholderTextColor={t.fgMuted}
            style={[styles.rawInput, { backgroundColor: t.bg, borderColor: t.border, color: t.fg }]}
          />
          {rawErr ? <Text style={[styles.err, { color: t.danger }]}>{rawErr}</Text> : null}
        </>
      ) : (
        <ScrollView
          style={styles.tree}
          contentContainerStyle={styles.treeContent}
          keyboardShouldPersistTaps="handled"
        >
          <Node
            label={config.name}
            value={draft}
            path={[]}
            depth={0}
            onChange={onChange}
            onRemove={onRemove}
            onAdd={onAdd}
          />
        </ScrollView>
      )}
      {rawErr && !raw ? <Text style={[styles.err, { color: t.danger }]}>{rawErr}</Text> : null}

      {!bridge ? (
        <Muted style={styles.footNote}>
          Forcing needs the app to configure the Shipeasy client SDK.
        </Muted>
      ) : (
        <View style={styles.footer}>
          <Button
            title={dirty || forced ? "Apply override" : "No changes"}
            onPress={apply}
            disabled={!dirty && !forced}
            style={styles.footerBtn}
          />
          {forced ? (
            <Button
              title="Restore live"
              variant="ghost"
              onPress={() => {
                bridge.removeOverride("config", config.name);
                props.onClose();
              }}
            />
          ) : null}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  addForm: { borderRadius: 8, borderWidth: 1, gap: 6, marginTop: 6, padding: 8 },
  addLabel: { fontSize: 12.5, fontWeight: "600" },
  addPlus: { fontSize: 15, fontWeight: "800" },
  addTrigger: { alignItems: "center", flexDirection: "row", gap: 4, paddingVertical: 6 },
  caret: { fontSize: 12 },
  caretHit: { alignItems: "center", justifyContent: "center", width: 16 },
  children: { borderLeftWidth: 1, gap: 2, marginLeft: 7, marginTop: 2, paddingLeft: 8 },
  count: { flex: 1, fontSize: 11.5 },
  err: { fontSize: 12.5, marginTop: 6 },
  footNote: { marginTop: 10 },
  footer: { gap: 8, marginTop: 10 },
  footerBtn: {},
  key: { fontSize: 13, fontWeight: "600", maxWidth: "42%" },
  kindDot: { borderRadius: 999, height: 7, width: 7 },
  leafInput: {
    borderRadius: 7,
    borderWidth: 1,
    fontSize: 13,
    minWidth: 60,
    paddingHorizontal: 8,
    paddingVertical: 6,
    textAlign: "right",
  },
  leafWrap: { flex: 1 },
  node: {},
  nodeRow: { alignItems: "center", flexDirection: "row", gap: 6, minHeight: 34 },
  rawInput: {
    borderRadius: 8,
    borderWidth: 1,
    flex: 1,
    fontFamily: "Menlo",
    fontSize: 12,
    padding: 10,
    textAlignVertical: "top",
  },
  rawToggle: { fontSize: 12.5, fontWeight: "600" },
  remove: { fontSize: 13 },
  removeHit: { alignItems: "center", justifyContent: "center", width: 22 },
  screen: { flex: 1, paddingBottom: 8 },
  statusRow: { alignItems: "center", flexDirection: "row", gap: 8, marginBottom: 10 },
  statusText: { flex: 1 },
  tree: { flex: 1 },
  treeContent: { paddingBottom: 16 },
});
