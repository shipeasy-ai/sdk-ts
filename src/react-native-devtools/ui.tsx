// Themed RN primitives for the devtools overlay. Everything reads the theme
// from ThemeContext (set once by <ShipeasyDevtools>), so the overlay is
// self-contained and never inherits the host app's styling.

import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { StyleProp, TextStyle, ViewStyle } from "react-native";
import { defaultTheme } from "./theme";
import type { DevtoolsTheme } from "./theme";

export const ThemeContext = createContext<DevtoolsTheme>(defaultTheme);

export function useTheme(): DevtoolsTheme {
  return useContext(ThemeContext);
}

// ── buttons ──────────────────────────────────────────────────────────────────

export function Button(props: {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}): ReactNode {
  const t = useTheme();
  const variant = props.variant ?? "primary";
  const bg =
    variant === "primary"
      ? t.accent
      : variant === "danger"
        ? t.danger
        : variant === "secondary"
          ? t.surface
          : "transparent";
  const fg = variant === "primary" || variant === "danger" ? t.accentFg : t.fg;
  const disabled = props.disabled === true || props.loading === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.title}
      onPress={props.onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: bg,
          borderColor: variant === "secondary" ? t.border : "transparent",
          borderRadius: t.radius,
          opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
        },
        props.style,
      ]}
    >
      {props.loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : (
        <Text style={[styles.buttonText, { color: fg }]}>{props.title}</Text>
      )}
    </Pressable>
  );
}

// ── text + fields ────────────────────────────────────────────────────────────

export function Title(props: { children: ReactNode; style?: StyleProp<TextStyle> }): ReactNode {
  const t = useTheme();
  return <Text style={[styles.title, { color: t.fg }, props.style]}>{props.children}</Text>;
}

export function Muted(props: { children: ReactNode; style?: StyleProp<TextStyle> }): ReactNode {
  const t = useTheme();
  return <Text style={[styles.muted, { color: t.fgMuted }, props.style]}>{props.children}</Text>;
}

export function Field(props: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  error?: string;
  multiline?: boolean;
  autoCapitalize?: "none" | "sentences";
  keyboardType?: "default" | "email-address";
}): ReactNode {
  const t = useTheme();
  return (
    <View style={styles.fieldWrap}>
      <Text style={[styles.fieldLabel, { color: t.fgMuted }]}>{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChangeText}
        placeholder={props.placeholder}
        placeholderTextColor={t.fgMuted}
        multiline={props.multiline}
        autoCapitalize={props.autoCapitalize ?? "sentences"}
        keyboardType={props.keyboardType ?? "default"}
        style={[
          styles.input,
          {
            backgroundColor: t.surface,
            borderColor: props.error ? t.danger : t.border,
            borderRadius: t.radius,
            color: t.fg,
            minHeight: props.multiline ? 88 : 44,
            textAlignVertical: props.multiline ? "top" : "center",
          },
        ]}
      />
      {props.error ? (
        <Text style={[styles.fieldError, { color: t.danger }]}>{props.error}</Text>
      ) : null}
    </View>
  );
}

// ── list bits ────────────────────────────────────────────────────────────────

export function Row(props: { children: ReactNode; onPress?: () => void }): ReactNode {
  const t = useTheme();
  const inner = (
    <View
      style={[
        styles.row,
        { backgroundColor: t.surface, borderColor: t.border, borderRadius: t.radius },
      ]}
    >
      {props.children}
    </View>
  );
  if (!props.onPress) return inner;
  return (
    <Pressable onPress={props.onPress} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
      {inner}
    </Pressable>
  );
}

export function Badge(props: { label: string; tone?: "ok" | "muted" | "accent" | "danger" }): ReactNode {
  const t = useTheme();
  const tone = props.tone ?? "muted";
  const color =
    tone === "ok" ? t.ok : tone === "accent" ? t.accent : tone === "danger" ? t.danger : t.fgMuted;
  return (
    <View style={[styles.badge, { borderColor: color }]}>
      <Text style={[styles.badgeText, { color }]}>{props.label}</Text>
    </View>
  );
}

export function CenterState(props: { children: ReactNode }): ReactNode {
  return <View style={styles.center}>{props.children}</View>;
}

export function Loading(): ReactNode {
  const t = useTheme();
  return (
    <CenterState>
      <ActivityIndicator color={t.accent} />
    </CenterState>
  );
}

export function ErrorState(props: { message: string; onRetry?: () => void }): ReactNode {
  const t = useTheme();
  return (
    <CenterState>
      <Text style={[styles.muted, { color: t.danger, textAlign: "center" }]}>{props.message}</Text>
      {props.onRetry ? (
        <Button title="Retry" variant="secondary" onPress={props.onRetry} style={styles.retry} />
      ) : null}
    </CenterState>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  buttonText: { fontSize: 15, fontWeight: "600" },
  title: { fontSize: 17, fontWeight: "700" },
  muted: { fontSize: 13 },
  fieldWrap: { marginBottom: 14 },
  fieldLabel: { fontSize: 12, fontWeight: "600", marginBottom: 6, textTransform: "uppercase" },
  input: { borderWidth: 1, fontSize: 15, paddingHorizontal: 12, paddingVertical: 10 },
  fieldError: { fontSize: 12, marginTop: 4 },
  row: {
    alignItems: "center",
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    justifyContent: "space-between",
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  badge: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { fontSize: 11, fontWeight: "600" },
  center: { alignItems: "center", justifyContent: "center", padding: 32 },
  retry: { marginTop: 12 },
});
