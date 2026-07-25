// The confirmation screen shown after a bug / feature is filed. Handles both
// submit paths: the PUBLIC intake (logged out — force-filed as pending_approval
// and human-reviewed, carries a ticket number) and the AUTHED path (a team
// session — filed straight into the triage queue). Shared by both forms.

import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import { Button, Muted, Title, useTheme } from "./ui";

export function CreateSuccess(props: {
  kind: "bug" | "feature";
  /** True when filed through an authed team session (vs the public intake). */
  authed: boolean;
  /** Ticket number — present on the public path (the intake returns it). */
  number?: number;
  /** The intake merged this into an existing item instead of filing a new one. */
  deduped?: boolean;
  onDone: () => void;
  /** File another — resets the form back to an empty state. */
  onAnother: () => void;
}): ReactNode {
  const t = useTheme();
  const noun = props.kind === "bug" ? "Bug" : "Feature";

  // Status line: merged (dedup) → pending review (public) → in the queue (authed).
  const status = props.deduped
    ? { color: t.accent, label: "Merged into an existing item" }
    : props.authed
      ? { color: t.ok, label: "In the triage queue" }
      : { color: "#f59e0b", label: "Pending review" };

  const note = props.deduped
    ? "This matches an item already in the queue — we bumped it instead of filing a duplicate."
    : props.authed
      ? `It's in the project's triage queue and will be reviewed shortly.`
      : "Public reports are approved by the team before they enter the queue — we'll take it from here.";

  return (
    <ScrollView contentContainerStyle={styles.wrap} showsVerticalScrollIndicator={false}>
      <View style={[styles.ringOuter, { backgroundColor: t.accentSoft }]}>
        <View style={[styles.ring, { backgroundColor: t.bg, borderColor: t.ok }]}>
          <Text style={[styles.check, { color: t.ok }]}>✓</Text>
        </View>
      </View>

      <Title style={styles.title}>{props.kind === "bug" ? "Bug reported" : "Feature requested"}</Title>
      <Muted style={styles.sub}>
        {props.kind === "bug" ? "Thanks for the report." : "Thanks for the idea."}
      </Muted>

      <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border, borderRadius: t.radius }]}>
        {props.number !== undefined ? (
          <>
            <View style={styles.row}>
              <Muted>Reference</Muted>
              <View style={[styles.ticket, { borderColor: t.border, backgroundColor: t.bg }]}>
                <Text style={[styles.ticketNo, { color: t.accent }]}>#{props.number}</Text>
              </View>
            </View>
            <View style={[styles.divider, { backgroundColor: t.border }]} />
          </>
        ) : null}
        <View style={styles.row}>
          <Muted>Status</Muted>
          <View style={styles.statusWrap}>
            <View style={[styles.dot, { backgroundColor: status.color }]} />
            <Text style={[styles.statusLabel, { color: status.color }]}>{status.label}</Text>
          </View>
        </View>
        <Text style={[styles.note, { color: t.fgMuted }]}>{note}</Text>
      </View>

      <Button title="Done" onPress={props.onDone} style={styles.done} />
      <Button
        title={props.kind === "bug" ? "Report another bug" : "Request another feature"}
        variant="ghost"
        onPress={props.onAnother}
        style={styles.another}
      />

      <Muted style={styles.footHint}>
        {props.authed
          ? `Filed as ${noun.toLowerCase()} · you can track it in the Feedback panel.`
          : "You can close the inspector — no account needed."}
      </Muted>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  another: { marginTop: 4 },
  card: { alignSelf: "stretch", borderWidth: 1, gap: 10, marginBottom: 20, padding: 14 },
  check: { fontSize: 30, fontWeight: "800" },
  divider: { height: StyleSheet.hairlineWidth },
  done: { alignSelf: "stretch" },
  dot: { borderRadius: 999, height: 8, width: 8 },
  footHint: { marginTop: 16, paddingHorizontal: 12, textAlign: "center" },
  note: { fontSize: 12.5, lineHeight: 18 },
  ring: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 2,
    height: 60,
    justifyContent: "center",
    width: 60,
  },
  ringOuter: {
    alignItems: "center",
    borderRadius: 999,
    height: 84,
    justifyContent: "center",
    marginBottom: 14,
    width: 84,
  },
  row: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  statusLabel: { fontSize: 13, fontWeight: "700" },
  statusWrap: { alignItems: "center", flexDirection: "row", gap: 7 },
  sub: { marginBottom: 20, textAlign: "center" },
  ticket: { borderWidth: 1, borderRadius: 6, paddingHorizontal: 9, paddingVertical: 3 },
  ticketNo: { fontSize: 13, fontVariant: ["tabular-nums"], fontWeight: "700" },
  title: { fontSize: 20, textAlign: "center" },
  wrap: { alignItems: "center", paddingBottom: 28, paddingHorizontal: 8, paddingTop: 28 },
});
