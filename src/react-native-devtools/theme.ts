// Self-contained theme for the RN devtools overlay. Dark, dense, brand-violet —
// tuned to read as a developer tool floating over ANY host app, so nothing here
// derives from the host's theme. Override per-app via the `theme` prop.

export interface DevtoolsTheme {
  /** Panel background. */
  bg: string;
  /** Raised surfaces (cards, rows, inputs). */
  surface: string;
  /** Hairlines and input borders. */
  border: string;
  /** Primary text. */
  fg: string;
  /** Secondary/labels text. */
  fgMuted: string;
  /** Brand accent (buttons, active tab, focus). */
  accent: string;
  /** Text/icon color on accent surfaces. */
  accentFg: string;
  /** Soft accent wash (badges, selected rows). */
  accentSoft: string;
  /** Success (enabled gates, running experiments, submit confirmation). */
  ok: string;
  /** Errors and destructive affordances. */
  danger: string;
  /** Base corner radius; larger radii derive from it. */
  radius: number;
}

export const defaultTheme: DevtoolsTheme = {
  bg: "#0a0a0b",
  surface: "#161618",
  border: "#2a2a2e",
  fg: "#f4f4f5",
  fgMuted: "#9b9ba3",
  accent: "#a78bfa",
  accentFg: "#0a0a0b",
  accentSoft: "rgba(167,139,250,0.16)",
  ok: "#34d399",
  danger: "#f87171",
  radius: 10,
};

export function resolveTheme(overrides?: Partial<DevtoolsTheme>): DevtoolsTheme {
  return overrides ? { ...defaultTheme, ...overrides } : defaultTheme;
}
