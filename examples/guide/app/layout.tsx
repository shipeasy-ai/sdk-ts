import type { Metadata } from "next";
import "./globals.css";

/*
 * ⚠ SDK NOT WIRED YET.
 *
 * In a real Shipeasy app the root layout is where the server SDK is configured
 * exactly once — it authenticates flags, experiments AND server-side i18n with
 * the SERVER key (never the client key, never embedded in the browser):
 *
 *   // TODO: once @shipeasy/sdk is installed
 *   import { shipeasy } from "@shipeasy/sdk/server";
 *   const se = await shipeasy({ serverKey: process.env.SHIPEASY_SERVER_KEY ?? "" });
 *   const { t } = se; // server-side i18n, e.g. t("hero.title", { name: "Sam" })
 *
 * Until then there is nothing to configure and the layout stays plain.
 */

export const metadata: Metadata = {
  title: "Shipeasy · TypeScript Entity Guide",
  description:
    "A single-page visual guide to every Shipeasy SDK entity — feature flags, dynamic configs, A/B experiments, kill switches, events, i18n labels, and error reporting.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
