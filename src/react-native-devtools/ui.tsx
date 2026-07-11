// Themed RN primitives for the devtools overlay. Everything reads the theme
// from ThemeContext (set once by <ShipeasyDevtools>), so the overlay is
// self-contained and never inherits the host app's styling.

import { createContext, useContext, useState } from "react";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Switch as RNSwitch,
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

/** Themed on/off switch (the platform Switch, tinted to the overlay accent and
 *  scaled down to sit inline on a row). */
export function Toggle(props: {
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}): ReactNode {
  const t = useTheme();
  return (
    <RNSwitch
      accessibilityLabel={props.accessibilityLabel}
      value={props.value}
      onValueChange={props.onValueChange}
      disabled={props.disabled}
      trackColor={{ true: t.accent, false: t.border }}
      thumbColor={t.bg}
      ios_backgroundColor={t.border}
      style={styles.toggle}
    />
  );
}

// ── text + fields ────────────────────────────────────────────────────────────

export function Title(props: { children: ReactNode; style?: StyleProp<TextStyle> }): ReactNode {
  const t = useTheme();
  return <Text style={[styles.title, { color: t.fg }, props.style]}>{props.children}</Text>;
}

export function Muted(props: {
  children: ReactNode;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
}): ReactNode {
  const t = useTheme();
  return (
    <Text numberOfLines={props.numberOfLines} style={[styles.muted, { color: t.fgMuted }, props.style]}>
      {props.children}
    </Text>
  );
}

export function Field(props: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  /** Muted single-line helper under the input (hidden while an error shows). */
  hint?: string;
  /** Tiny de-emphasized suffix after the label, e.g. "optional". */
  labelHint?: string;
  error?: string;
  multiline?: boolean;
  autoCapitalize?: "none" | "sentences";
  keyboardType?: "default" | "email-address";
}): ReactNode {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.fieldWrap}>
      <Text style={[styles.fieldLabel, { color: t.fgMuted }]}>
        {props.label}
        {props.labelHint ? (
          <Text style={[styles.fieldLabelHint, { color: t.fgMuted }]}>  {props.labelHint}</Text>
        ) : null}
      </Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        onChangeText={props.onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          props.onBlur?.();
        }}
        placeholder={props.placeholder}
        placeholderTextColor={t.fgMuted}
        multiline={props.multiline}
        autoCapitalize={props.autoCapitalize ?? "sentences"}
        keyboardType={props.keyboardType ?? "default"}
        style={[
          styles.input,
          {
            backgroundColor: focused ? t.bg : t.surface,
            borderColor: props.error ? t.danger : focused ? t.accent : t.border,
            borderRadius: t.radius,
            color: t.fg,
            minHeight: props.multiline ? 96 : 44,
            textAlignVertical: props.multiline ? "top" : "center",
          },
        ]}
      />
      {props.error ? (
        <Text style={[styles.fieldError, { color: t.danger }]}>{props.error}</Text>
      ) : props.hint ? (
        <Text style={[styles.fieldHint, { color: t.fgMuted }]}>{props.hint}</Text>
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

/** Selectable pill — the RN stand-in for the web overlay's dropdowns and
 *  toggle buttons (variant pickers, status filters, force on/off). */
export function Chip(props: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  tone?: "accent" | "danger";
}): ReactNode {
  const t = useTheme();
  const color = props.tone === "danger" ? t.danger : t.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ selected: props.selected === true }}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: props.selected ? color : t.surface,
          borderColor: props.selected ? color : t.border,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Text style={[styles.chipText, { color: props.selected ? t.accentFg : t.fg }]}>
        {props.label}
      </Text>
    </Pressable>
  );
}

export function ChipRow(props: { children: ReactNode }): ReactNode {
  return <View style={styles.chipRow}>{props.children}</View>;
}

export function SearchInput(props: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
}): ReactNode {
  const t = useTheme();
  return (
    <TextInput
      accessibilityLabel="Search"
      value={props.value}
      onChangeText={props.onChangeText}
      placeholder={props.placeholder ?? "Search…"}
      placeholderTextColor={t.fgMuted}
      autoCapitalize="none"
      autoCorrect={false}
      style={[
        styles.search,
        {
          backgroundColor: t.surface,
          borderColor: t.border,
          borderRadius: t.radius,
          color: t.fg,
        },
      ]}
    />
  );
}

/** Uppercase section divider (the web overlay's `.dtf-group`). */
export function SectionLabel(props: { children: ReactNode; hint?: string }): ReactNode {
  const t = useTheme();
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionText, { color: t.fgMuted }]}>{props.children}</Text>
      {props.hint ? <Text style={[styles.sectionHint, { color: t.fgMuted }]}>{props.hint}</Text> : null}
    </View>
  );
}

/** `key → value` detail line (the web overlay's crumb rows). */
export function KV(props: { k: string; v: string; accent?: boolean }): ReactNode {
  const t = useTheme();
  return (
    <View style={styles.kv}>
      <Text style={[styles.kvKey, { color: t.fgMuted }]} numberOfLines={1}>
        {props.k}
      </Text>
      <Text
        style={[styles.kvValue, { color: props.accent ? t.accent : t.fg }]}
        numberOfLines={3}
        selectable
      >
        {props.v}
      </Text>
    </View>
  );
}

/** Relative timestamp, matching the web overlay's events/feedback panels. */
export function timeAgo(now: number, isoOrTs: string | number): string {
  const ts = typeof isoOrTs === "number" ? isoOrTs : Date.parse(isoOrTs);
  if (Number.isNaN(ts)) return "";
  const ms = now - ts;
  if (ms < 1000) return "now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
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
  fieldWrap: { marginBottom: 16 },
  fieldLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0.5,
    marginBottom: 6,
    textTransform: "uppercase",
  },
  fieldLabelHint: { fontWeight: "400", letterSpacing: 0.2, textTransform: "none" },
  input: { borderWidth: 1, fontSize: 15, paddingHorizontal: 12, paddingVertical: 10 },
  fieldError: { fontSize: 12, marginTop: 5 },
  fieldHint: { fontSize: 12, marginTop: 5, opacity: 0.8 },
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
  chip: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 10 },
  chipText: { fontSize: 12, fontWeight: "600" },
  kv: { flexDirection: "row", gap: 8, marginBottom: 6 },
  kvKey: { fontSize: 12, minWidth: 96 },
  kvValue: { flex: 1, fontSize: 12 },
  retry: { marginTop: 12 },
  search: {
    borderWidth: 1,
    fontSize: 14,
    marginBottom: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  section: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 8,
    marginTop: 12,
  },
  sectionHint: { fontSize: 10 },
  sectionText: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" },
  toggle: { transform: [{ scale: 0.82 }] },
});
