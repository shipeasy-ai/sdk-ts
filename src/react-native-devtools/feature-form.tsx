// Feature-request form — react-hook-form over the generated zod schema.
// Authed-only: the public /cli/report intake takes bugs, not feature requests,
// so this renders behind a devtools session.

import { StyleSheet, Text, View } from "react-native";
import { ScrollView } from "react-native";
import type { ReactNode } from "react";
import type { DevtoolsClient } from "../devtools/api";
import { useFeatureForm } from "./hooks";
import { ControlledField } from "./bug-form";
import { Button, Muted, Title, useTheme } from "./ui";

export function FeatureForm(props: {
  client: DevtoolsClient | null;
  context?: Record<string, unknown>;
  onDone: () => void;
}): ReactNode {
  const t = useTheme();
  const { form, ...state } = useFeatureForm({ client: props.client, context: props.context });

  if (state.result) {
    return (
      <View style={styles.done}>
        <View style={[styles.doneMark, { backgroundColor: t.accentSoft }]}>
          <Text style={[styles.doneGlyph, { color: t.ok }]}>✓</Text>
        </View>
        <Title>Thanks — request filed</Title>
        <Muted style={styles.doneDetail}>Your feature request landed in the queue.</Muted>
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
      {state.submitError ? (
        <View style={[styles.submitError, { backgroundColor: t.surface, borderColor: t.danger, borderRadius: t.radius }]}>
          <Text style={[styles.submitErrorText, { color: t.danger }]}>{state.submitError}</Text>
        </View>
      ) : null}
      <Button
        title="Submit feature request"
        onPress={() => void state.submit()}
        loading={state.submitting}
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
  form: { paddingBottom: 32, paddingTop: 6 },
  heading: { marginBottom: 4 },
  submitError: {
    borderWidth: 1,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  submitErrorText: { fontSize: 13 },
});
