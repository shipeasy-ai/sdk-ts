// Full-page experiment detail — the drill-in screen behind an experiment row.
// Shows the experiment's metadata, the universe param schema it draws from, and
// every variant's resolved fields (each collapsed by default). Forcing an
// assignment (bridge.setExperimentOverride) applies live, mirroring the web
// overlay's variant picker.

import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsClient } from "../devtools/api";
import type {
  ExperimentRecord,
  ExperimentVariant,
  UniverseRecord,
} from "../devtools/types";
import type { DevtoolsEngineBridge } from "../devtools/bridge";
import { useUniverses } from "./hooks";
import { Badge, Chip, ChipRow, KV, Muted, SectionLabel, useTheme } from "./ui";

type UniverseParam = NonNullable<UniverseRecord["paramSchema"]>[number];

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function pct(basisPoints: number): string {
  return `${basisPoints / 100}%`;
}

/** Resolve the fields a variant delivers: every universe param, valued by the
 *  variant's override when present else the universe default. Falls back to the
 *  variant's raw params when the universe has no schema (pre-rework universes). */
function resolveFields(
  variant: ExperimentVariant,
  schema: UniverseParam[] | null,
): Array<{ name: string; type: string; value: unknown; overridden: boolean }> {
  const params = variant.params ?? {};
  if (schema && schema.length > 0) {
    return schema.map((p) => {
      const overridden = Object.prototype.hasOwnProperty.call(params, p.name);
      return {
        name: p.name,
        type: p.type,
        value: overridden ? params[p.name] : p.default,
        overridden,
      };
    });
  }
  return Object.entries(params).map(([name, value]) => ({
    name,
    type: typeof value,
    value,
    overridden: true,
  }));
}

/** One variant, collapsed by default. Header shows the split weight + whether
 *  it's the caller's live/forced assignment; expanding reveals its resolved
 *  param fields. */
function VariantNode(props: {
  variant: ExperimentVariant;
  schema: UniverseParam[] | null;
  assigned: boolean;
  forced: boolean;
}): ReactNode {
  const t = useTheme();
  const { variant, schema, assigned, forced } = props;
  const [open, setOpen] = useState(false);
  const fields = useMemo(() => resolveFields(variant, schema), [variant, schema]);

  return (
    <View style={[styles.variant, { backgroundColor: t.surface, borderColor: t.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={variant.name}
        onPress={() => setOpen((o) => !o)}
        style={({ pressed }) => [styles.variantHead, { opacity: pressed ? 0.85 : 1 }]}
      >
        <Text style={[styles.caret, { color: t.fgMuted }]}>{open ? "▾" : "▸"}</Text>
        <Text style={[styles.variantName, { color: t.fg }]} numberOfLines={1}>
          {variant.name}
        </Text>
        {assigned ? (
          <Badge label={forced ? "forced" : "assigned"} tone={forced ? "accent" : "ok"} />
        ) : null}
        <Text style={[styles.variantWeight, { color: t.fgMuted }]}>{pct(variant.weight)}</Text>
      </Pressable>
      {open ? (
        <View style={styles.variantBody}>
          {fields.length === 0 ? (
            <Muted>No params.</Muted>
          ) : (
            fields.map((f) => (
              <KV
                key={f.name}
                k={`${f.name}${f.overridden ? "" : " ·default"}`}
                v={`${fmtValue(f.value)}  (${f.type})`}
                accent={f.overridden}
              />
            ))
          )}
        </View>
      ) : null}
    </View>
  );
}

export function ExperimentDetailScreen(props: {
  experiment: ExperimentRecord;
  client: DevtoolsClient | null;
  bridge: DevtoolsEngineBridge | null;
}): ReactNode {
  const t = useTheme();
  const { experiment: e, bridge } = props;

  // The universe supplies the param schema the variants resolve against.
  const universes = useUniverses(props.client);
  const universe = (universes.data ?? []).find((u) => u.name === e.universe) ?? null;
  const schema = universe?.paramSchema ?? null;

  const liveEntry = bridge ? bridge.getExperiment(e.name) : null;
  const forcedGroup = bridge ? (bridge.getOverrides().experiments[e.name] ?? null) : null;
  const effectiveGroup = forcedGroup ?? (liveEntry?.inExperiment ? liveEntry.group : null);

  const statusTone =
    e.status === "running" ? "ok" : e.status === "draft" ? "accent" : "muted";

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.headRow}>
        <Badge label={e.status} tone={statusTone} />
        {forcedGroup ? (
          <Badge label={`forced: ${forcedGroup}`} tone="accent" />
        ) : effectiveGroup ? (
          <Badge label={`assigned: ${effectiveGroup}`} tone="ok" />
        ) : bridge ? (
          <Muted>not assigned</Muted>
        ) : null}
      </View>

      {e.description ? <Text style={[styles.blurb, { color: t.fg }]}>{e.description}</Text> : null}
      {e.hypothesis ? (
        <Text style={[styles.hypothesis, { color: t.fgMuted }]}>“{e.hypothesis}”</Text>
      ) : null}

      <SectionLabel>Metadata</SectionLabel>
      <KV k="Universe" v={e.universe} />
      {typeof e.allocationPct === "number" ? (
        <KV k="Allocation" v={pct(e.allocationPct)} />
      ) : null}
      <KV k="Bucket by" v={e.bucketBy || universe?.unitType || "—"} />
      {e.audience ? <KV k="Audience" v={e.audience} /> : null}
      {e.ownerEmail ? <KV k="Owner" v={e.ownerEmail} /> : null}
      {e.startedAt ? <KV k="Started" v={new Date(e.startedAt).toLocaleString()} /> : null}
      {typeof e.minSampleSize === "number" ? (
        <KV k="Min sample" v={`${e.minSampleSize} / group`} />
      ) : null}

      <SectionLabel hint={bridge ? "applies live" : undefined}>Force assignment</SectionLabel>
      {bridge ? (
        <ChipRow>
          {e.groups.map((g) => (
            <Chip
              key={g.name}
              label={g.name}
              selected={forcedGroup === g.name}
              // Pass the variant's param overrides so the forced assignment
              // delivers this variant's values, not just the universe defaults.
              onPress={() => bridge.setExperimentOverride(e.name, g.name, g.params ?? {})}
            />
          ))}
          {forcedGroup ? (
            <Chip label="Restore live" onPress={() => bridge.removeOverride("experiment", e.name)} />
          ) : null}
        </ChipRow>
      ) : (
        <Muted style={styles.noBridge}>
          Forcing a variant needs the app to configure the Shipeasy client SDK.
        </Muted>
      )}

      <SectionLabel hint={schema ? `${schema.length} params` : undefined}>
        Universe schema
      </SectionLabel>
      {schema && schema.length > 0 ? (
        schema.map((p) => (
          <KV key={p.name} k={`${p.name} · ${p.type}`} v={`default: ${fmtValue(p.default)}`} />
        ))
      ) : (
        <Muted>
          {universes.loading ? "Loading universe…" : "This universe declares no params."}
        </Muted>
      )}

      <SectionLabel hint="tap to expand">Variants</SectionLabel>
      {e.groups.map((g) => (
        <VariantNode
          key={g.name}
          variant={g}
          schema={schema}
          assigned={effectiveGroup === g.name}
          forced={forcedGroup === g.name}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  blurb: { fontSize: 14, lineHeight: 20, marginTop: 4 },
  caret: { fontSize: 12, width: 14 },
  content: { paddingBottom: 28 },
  headRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  hypothesis: { fontSize: 13, fontStyle: "italic", lineHeight: 18, marginTop: 6 },
  noBridge: { marginBottom: 4 },
  variant: { borderRadius: 10, borderWidth: 1, marginBottom: 8, overflow: "hidden" },
  variantBody: { gap: 2, paddingBottom: 10, paddingHorizontal: 12, paddingTop: 2 },
  variantHead: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  variantName: { flex: 1, fontSize: 14, fontWeight: "600" },
  variantWeight: { fontSize: 12, fontVariant: ["tabular-nums"] },
});
