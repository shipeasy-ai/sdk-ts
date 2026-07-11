// Logged-in release panels: Gates / Configs / Experiments. Feature parity with
// the web overlay's panels, adapted to the platform: live values come from the
// engine bridge, and overrides drive the Engine's programmatic override store
// (applied live — React Native has no URL to write ?se_ks_* params to, so the
// web overlay's param+reload flow becomes bridge.setFlagOverride() etc.).

import { useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsClient } from "../devtools/api";
import type { ConfigRecord, ExperimentRecord, GateRecord } from "../devtools/types";
import type { DevtoolsEngineBridge } from "../devtools/bridge";
import { buildGateFlow, evalStepMatch, ruleSummary } from "../devtools/gate-flow";
import type { GateFlowStep, StepSource } from "../devtools/gate-flow";
import { useConfigs, useEngineBridge, useExperiments, useGates } from "./hooks";
import type { QueryState } from "./hooks";
import type { DevtoolsTheme } from "./theme";
import {
  Badge,
  Button,
  Chip,
  ChipRow,
  ErrorState,
  Field,
  KV,
  Loading,
  Muted,
  Row,
  SearchInput,
  SectionLabel,
  Toggle,
  useTheme,
} from "./ui";

export function PanelList<T>(props: {
  query: QueryState<T[]>;
  keyFor: (item: T) => string;
  render: (item: T) => ReactNode;
  emptyLabel: string;
  /** Case-insensitive match against the search text; omit to hide the box. */
  matches?: (item: T, needle: string) => boolean;
  header?: ReactNode;
}): ReactNode {
  const { query } = props;
  const [search, setSearch] = useState("");
  if (query.loading && !query.data) return <Loading />;
  if (query.error) return <ErrorState message={query.error} onRetry={query.refresh} />;
  const needle = search.trim().toLowerCase();
  const items = (query.data ?? []).filter(
    (it) => !needle || !props.matches || props.matches(it, needle),
  );
  return (
    <View style={styles.fill}>
      {props.matches ? <SearchInput value={search} onChangeText={setSearch} /> : null}
      {props.header}
      {items.length === 0 ? (
        <View style={styles.empty}>
          <Muted>{needle ? "No matches." : props.emptyLabel}</Muted>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={props.keyFor}
          renderItem={({ item }) => <>{props.render(item)}</>}
          refreshing={query.loading}
          onRefresh={query.refresh}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
        />
      )}
    </View>
  );
}

export function NameCell(props: { name: string; sub?: string }): ReactNode {
  const t = useTheme();
  return (
    <View style={styles.nameCell}>
      <Text numberOfLines={1} style={[styles.name, { color: t.fg }]}>
        {props.name}
      </Text>
      {props.sub ? <Muted numberOfLines={1}>{props.sub}</Muted> : null}
    </View>
  );
}

/** Hint rendered under override controls when the host app hasn't configured
 *  the client SDK — there is no engine to force values on. */
function NoBridgeHint(): ReactNode {
  return (
    <Muted style={styles.noBridge}>
      Live values and forcing need the app to configure the Shipeasy client SDK.
    </Muted>
  );
}

// ── Gates ────────────────────────────────────────────────────────────────────

/** Left-stripe colour by rule source — mirrors the dashboard's gate-flow
 *  palette (user=accent, request-attr=purple, whitelist=cyan, public=muted). */
function stripeColor(source: StepSource, t: DevtoolsTheme): string {
  switch (source) {
    case "user":
      return t.accent;
    case "auto":
      return "#c084fc";
    case "whitelist":
      return "#22d3ee";
    case "public":
      return t.border;
  }
}

/** One node of the gate's evaluation flow: a source stripe, the step title +
 *  its pass/fail-for-this-user (conditions) or rollout % (rollout/whitelist),
 *  and a one-line predicate summary. */
function FlowStepRow(props: {
  step: GateFlowStep;
  user: Record<string, unknown> | null;
}): ReactNode {
  const t = useTheme();
  const { step } = props;
  const match = evalStepMatch(step, props.user);
  const pct = Math.round(step.rolloutPct / 100);
  const partial = step.type === "condition" && !step.whitelist && pct < 100;
  return (
    <View style={styles.step}>
      <View style={[styles.stepStripe, { backgroundColor: stripeColor(step.source, t) }]} />
      <View style={styles.stepBody}>
        <View style={styles.stepTop}>
          <Text style={[styles.stepTitle, { color: t.fg }]} numberOfLines={1}>
            {step.title}
          </Text>
          {match === "pass" ? (
            <Badge label="pass" tone="ok" />
          ) : match === "fail" ? (
            <Badge label="fail" tone="danger" />
          ) : step.whitelist ? (
            <Text style={[styles.stepPct, { color: t.accent }]}>always</Text>
          ) : (
            <Text style={[styles.stepPct, { color: pct === 0 ? t.fgMuted : t.fg }]}>{pct}%</Text>
          )}
          {partial ? (
            <Text style={[styles.stepPct, { color: t.fgMuted }]}>{pct}%</Text>
          ) : null}
        </View>
        <Text style={[styles.stepSummary, { color: t.fgMuted }]} numberOfLines={2}>
          {ruleSummary(step)}
        </Text>
      </View>
    </View>
  );
}

function GateRow(props: { gate: GateRecord; bridge: DevtoolsEngineBridge | null }): ReactNode {
  const t = useTheme();
  const { gate, bridge } = props;
  const [open, setOpen] = useState(false);
  const live = bridge ? bridge.getFlag(gate.name) : null;
  const override = bridge ? (bridge.getOverrides().flags[gate.name] ?? null) : null;
  const forced = override !== null;
  const effectiveOn = forced ? (override as boolean) : (live ?? false);
  const user = bridge ? bridge.getUser() : null;
  const flow = useMemo(() => buildGateFlow(gate), [gate]);

  return (
    <Row>
      <View style={styles.fill}>
        <View style={styles.rowTop}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={gate.name}
            onPress={() => setOpen((o) => !o)}
            style={styles.fill}
          >
            <NameCell
              name={gate.name}
              sub={`${gate.rolloutPct / 100}% public${gate.killswitch ? " · killswitch" : ""}`}
            />
          </Pressable>
          {forced ? <Badge label="forced" tone="accent" /> : null}
          {bridge ? (
            <Toggle
              value={effectiveOn}
              onValueChange={(v) => bridge.setFlagOverride(gate.name, v)}
              accessibilityLabel={`${gate.name} on/off`}
            />
          ) : (
            <Badge label={gate.enabled ? "enabled" : "disabled"} tone={gate.enabled ? "ok" : "muted"} />
          )}
        </View>
        {open ? (
          <View style={styles.detail}>
            <View style={styles.served}>
              <Text style={[styles.servedLabel, { color: t.fgMuted }]}>Served to you</Text>
              <Badge label={effectiveOn ? "ON" : "OFF"} tone={effectiveOn ? "ok" : "muted"} />
              <Muted>
                {forced ? "· forced override" : live !== null ? "· live evaluation" : "· not evaluated"}
              </Muted>
            </View>

            <SectionLabel hint="first match wins">Evaluation flow</SectionLabel>
            {flow.map((s) => (
              <FlowStepRow key={s.key} step={s} user={user} />
            ))}

            {!bridge ? (
              <NoBridgeHint />
            ) : forced ? (
              <ChipRow>
                <Chip label="Clear override" onPress={() => bridge.removeOverride("flag", gate.name)} />
              </ChipRow>
            ) : null}
          </View>
        ) : null}
      </View>
    </Row>
  );
}

export function GatesPanel(props: { client: DevtoolsClient }): ReactNode {
  const query = useGates(props.client);
  const bridge = useEngineBridge();
  return (
    <PanelList<GateRecord>
      query={query}
      keyFor={(g) => g.id}
      emptyLabel="No feature gates yet."
      matches={(g, n) => g.name.toLowerCase().includes(n)}
      render={(g) => <GateRow gate={g} bridge={bridge} />}
    />
  );
}

// ── Configs ──────────────────────────────────────────────────────────────────

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    return String(value);
  }
}

function ConfigRow(props: { config: ConfigRecord; bridge: DevtoolsEngineBridge | null }): ReactNode {
  const t = useTheme();
  const { config, bridge } = props;
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);

  const overrides = bridge ? bridge.getOverrides().configs : {};
  const forced = Object.prototype.hasOwnProperty.call(overrides, config.name);
  const live = bridge ? bridge.getConfig(config.name) : undefined;
  const effective = forced ? overrides[config.name] : (live !== undefined ? live : config.valueJson);
  const preview = JSON.stringify(effective ?? {});

  const apply = () => {
    if (!bridge) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft) as unknown;
    } catch (e) {
      setParseError(e instanceof Error ? e.message : "Invalid JSON");
      return;
    }
    // Configs are object-shaped post-migration; hold the editor to the same
    // bar the web schema form enforces at its root.
    const schemaType = (config.schema as { type?: string }).type;
    if (schemaType === "object" && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
      setParseError("This config's schema expects a JSON object at the root.");
      return;
    }
    setParseError(null);
    bridge.setConfigOverride(config.name, parsed);
    setEditing(false);
  };

  return (
    <Row onPress={() => setOpen((o) => !o)}>
      <View style={styles.fill}>
        <View style={styles.rowTop}>
          <NameCell
            name={config.name}
            sub={preview.length > 60 ? `${preview.slice(0, 60)}…` : preview}
          />
          {forced ? <Badge label="forced" tone="accent" /> : null}
        </View>
        {open ? (
          <View style={styles.detail}>
            <SectionLabel hint={forced ? "override" : "effective"}>Value</SectionLabel>
            <Text style={[styles.json, { color: t.fg }]} selectable>
              {pretty(effective)}
            </Text>
            {bridge ? (
              editing ? (
                <View>
                  <Field
                    label="Override value (JSON)"
                    value={draft}
                    onChangeText={setDraft}
                    multiline
                    autoCapitalize="none"
                    error={parseError ?? undefined}
                  />
                  <ChipRow>
                    <Chip label="Apply override" selected onPress={apply} />
                    <Chip label="Cancel" onPress={() => setEditing(false)} />
                  </ChipRow>
                </View>
              ) : (
                <ChipRow>
                  <Chip
                    label="Edit override"
                    onPress={() => {
                      setDraft(pretty(effective));
                      setParseError(null);
                      setEditing(true);
                    }}
                  />
                  {forced ? (
                    <Chip
                      label="Restore"
                      onPress={() => bridge.removeOverride("config", config.name)}
                    />
                  ) : null}
                </ChipRow>
              )
            ) : (
              <NoBridgeHint />
            )}
          </View>
        ) : null}
      </View>
    </Row>
  );
}

export function ConfigsPanel(props: { client: DevtoolsClient }): ReactNode {
  const query = useConfigs(props.client);
  const bridge = useEngineBridge();
  return (
    <PanelList<ConfigRecord>
      query={query}
      keyFor={(c) => c.id}
      emptyLabel="No dynamic configs yet."
      matches={(c, n) => c.name.toLowerCase().includes(n)}
      render={(c) => <ConfigRow config={c} bridge={bridge} />}
    />
  );
}

// ── Experiments ──────────────────────────────────────────────────────────────

function ExperimentRow(props: {
  experiment: ExperimentRecord;
  bridge: DevtoolsEngineBridge | null;
}): ReactNode {
  const { experiment: e, bridge } = props;
  const [open, setOpen] = useState(false);
  const liveEntry = bridge ? bridge.getExperiment(e.name) : null;
  const forcedGroup = bridge ? (bridge.getOverrides().experiments[e.name] ?? null) : null;
  const effectiveGroup =
    forcedGroup ?? (liveEntry?.inExperiment ? liveEntry.group : null);
  return (
    <Row onPress={() => setOpen((o) => !o)}>
      <View style={styles.fill}>
        <View style={styles.rowTop}>
          <NameCell
            name={e.name}
            sub={`${e.universe} · ${e.groups.map((g) => g.name).join(" / ") || "no groups"}`}
          />
          {forcedGroup ? <Badge label={`forced: ${forcedGroup}`} tone="accent" /> : null}
          {!forcedGroup && effectiveGroup ? <Badge label={effectiveGroup} tone="ok" /> : null}
          <Badge
            label={e.status}
            tone={e.status === "running" ? "ok" : e.status === "draft" ? "accent" : "muted"}
          />
        </View>
        {open ? (
          <View style={styles.detail}>
            {e.groups.map((g) => (
              <KV
                key={g.name}
                k={g.name}
                v={`${g.weight}%${effectiveGroup === g.name ? (forcedGroup ? " · forced" : " · live") : ""}`}
                accent={effectiveGroup === g.name}
              />
            ))}
            {bridge ? (
              <>
                <SectionLabel hint="applies live">Force variant</SectionLabel>
                <ChipRow>
                  {e.groups.map((g) => (
                    <Chip
                      key={g.name}
                      label={g.name}
                      selected={forcedGroup === g.name}
                      onPress={() => bridge.setExperimentOverride(e.name, g.name)}
                    />
                  ))}
                  {forcedGroup ? (
                    <Chip
                      label="Restore"
                      onPress={() => bridge.removeOverride("experiment", e.name)}
                    />
                  ) : null}
                </ChipRow>
              </>
            ) : (
              <NoBridgeHint />
            )}
          </View>
        ) : null}
      </View>
    </Row>
  );
}

export function ExperimentsPanel(props: { client: DevtoolsClient }): ReactNode {
  const query = useExperiments(props.client);
  const bridge = useEngineBridge();
  return (
    <PanelList<ExperimentRecord>
      query={query}
      keyFor={(e) => e.id}
      emptyLabel="No experiments yet."
      matches={(e, n) =>
        e.name.toLowerCase().includes(n) || e.universe.toLowerCase().includes(n)
      }
      render={(e) => <ExperimentRow experiment={e} bridge={bridge} />}
    />
  );
}

const styles = StyleSheet.create({
  detail: { marginTop: 10 },
  empty: { alignItems: "center", padding: 32 },
  fill: { flex: 1 },
  json: { fontFamily: "Menlo", fontSize: 11, marginBottom: 8 },
  list: { paddingBottom: 24 },
  name: { fontSize: 15, fontWeight: "600" },
  nameCell: { flex: 1, gap: 2, marginRight: 8 },
  noBridge: { marginTop: 4 },
  rowTop: { alignItems: "center", flexDirection: "row", gap: 8 },
  served: { alignItems: "center", flexDirection: "row", gap: 6, marginBottom: 4 },
  servedLabel: { fontSize: 12 },
  step: { flexDirection: "row", gap: 8, marginBottom: 6 },
  stepBody: { flex: 1, gap: 1 },
  stepPct: { fontSize: 11.5, fontVariant: ["tabular-nums"], fontWeight: "600" },
  stepStripe: { borderRadius: 999, width: 3 },
  stepSummary: { fontSize: 11.5 },
  stepTitle: { flex: 1, fontSize: 13, fontWeight: "600" },
  stepTop: { alignItems: "center", flexDirection: "row", gap: 6 },
});
