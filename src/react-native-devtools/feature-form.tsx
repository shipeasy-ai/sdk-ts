// Feature-request form — react-hook-form over the generated zod schema. Two
// submit paths (mirroring the bug form): logged in → the full authed
// createFeatureRequest; logged out → the public /cli/report intake
// (`type: "feature"`, client key).

import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsClient } from "../devtools/api";
import { useFeatureForm, useIdentityEmail } from "./hooks";
import type { DevtoolsConfig } from "./hooks";
import { ControlledField, ScreenshotAttach } from "./bug-form";
import { Button, Muted, Title, useTheme } from "./ui";

export function FeatureForm(props: {
  config: DevtoolsConfig;
  client: DevtoolsClient | null;
  context?: Record<string, unknown>;
  onDone: () => void;
}): ReactNode {
  const t = useTheme();
  const identityEmail = useIdentityEmail();
  const { form, ...state } = useFeatureForm({
    config: props.config,
    client: props.client,
    context: props.context,
  });

  if (state.result) {
    return (
      <View style={styles.done}>
        <View style={[styles.doneMark, { backgroundColor: t.accentSoft }]}>
          <Text style={[styles.doneGlyph, { color: t.ok }]}>✓</Text>
        </View>
        <Title>Thanks — request filed</Title>
        {state.result.number !== undefined ? (
          <View style={[styles.doneTicket, { borderColor: t.border, backgroundColor: t.surface }]}>
            <Text style={[styles.doneTicketNo, { color: t.accent }]}>#{state.result.number}</Text>
          </View>
        ) : null}
        <Muted style={styles.doneDetail}>
          {state.result.deduped
            ? "This matches a request already in the queue — we bumped it instead of duplicating."
            : "Your feature request landed in the queue."}
        </Muted>
        <Button title="Done" onPress={props.onDone} style={styles.doneButton} />
      </View>
    );
  }

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={styles.form}
      showsVerticalScrollIndicator={false}
    >
      <Title style={styles.heading}>Request a feature</Title>
      <Muted style={styles.blurb}>What's missing, and the workflow it would unblock.</Muted>
      <ControlledField
        control={form.control}
        name="title"
        label="Title"
        placeholder="One-line summary"
      />
      <ControlledField
        control={form.control}
        name="description"
        label="What should it do?"
        labelHint="optional"
        placeholder="Describe the feature"
        multiline
      />
      <ControlledField
        control={form.control}
        name="useCase"
        label="Why do you need it?"
        labelHint="optional"
        placeholder="The workflow it unblocks"
        multiline
      />
      {identityEmail ? (
        <View
          style={[
            styles.identityRow,
            { backgroundColor: t.surface, borderColor: t.border, borderRadius: t.radius },
          ]}
        >
          <View style={[styles.identityDot, { backgroundColor: t.ok }]} />
          <Muted style={styles.identityText} numberOfLines={1}>
            Follow-ups go to {identityEmail}
          </Muted>
        </View>
      ) : (
        <ControlledField
          control={form.control}
          name="reporterEmail"
          label="Your email"
          labelHint="optional"
          placeholder="you@example.com"
          hint="Only used to follow up on this request."
          autoCapitalize="none"
          keyboardType="email-address"
        />
      )}
      <ScreenshotAttach
        screenshot={state.screenshot}
        onChange={state.setScreenshot}
        enabled={props.client !== null}
      />
      {state.submitError ? (
        <View style={[styles.submitError, { backgroundColor: t.surface, borderColor: t.danger, borderRadius: t.radius }]}>
          <Text style={[styles.submitErrorText, { color: t.danger }]}>{state.submitError}</Text>
        </View>
      ) : null}
      <Button
        title="Submit feature request"
        onPress={() => void state.submit()}
        loading={state.submitting}
        disabled={state.publicDisabled}
      />
      <Button title="Cancel" variant="ghost" onPress={props.onDone} style={styles.cancel} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  blurb: { marginBottom: 18 },
  cancel: { marginTop: 6 },
  done: { alignItems: "center", gap: 10, padding: 24, paddingTop: 40 },
  doneButton: { alignSelf: "stretch", marginTop: 18 },
  doneDetail: { paddingHorizontal: 12, textAlign: "center" },
  doneGlyph: { fontSize: 26, fontWeight: "700" },
  doneMark: {
    alignItems: "center",
    borderRadius: 999,
    height: 56,
    justifyContent: "center",
    marginBottom: 4,
    width: 56,
  },
  doneTicket: { borderWidth: 1, paddingHorizontal: 10, paddingVertical: 3 },
  doneTicketNo: { fontSize: 13, fontVariant: ["tabular-nums"], fontWeight: "700" },
  form: { paddingBottom: 32, paddingTop: 6 },
  heading: { marginBottom: 4 },
  identityDot: { borderRadius: 999, height: 8, width: 8 },
  identityRow: {
    alignItems: "center",
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginBottom: 16,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  identityText: { flex: 1 },
  submitError: {
    borderWidth: 1,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  submitErrorText: { fontSize: 13 },
});
