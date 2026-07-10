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
        <Title>Thanks — request filed</Title>
        <Muted style={styles.doneDetail}>Your feature request landed in the queue.</Muted>
        <Button title="Done" onPress={props.onDone} style={styles.doneButton} />
      </View>
    );
  }

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.form}>
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
        placeholder="Describe the feature"
        multiline
      />
      <ControlledField
        control={form.control}
        name="useCase"
        label="Why do you need it?"
        placeholder="The workflow it unblocks"
        multiline
      />
      {state.submitError ? (
        <Text style={[styles.submitError, { color: t.danger }]}>{state.submitError}</Text>
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
  cancel: { marginTop: 8 },
  done: { alignItems: "center", gap: 8, padding: 24 },
  doneButton: { alignSelf: "stretch", marginTop: 16 },
  doneDetail: { textAlign: "center" },
  form: { paddingBottom: 32 },
  submitError: { fontSize: 13, marginBottom: 10 },
});
