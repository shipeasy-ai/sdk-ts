// Declare the hermetic suite production-equivalent for the SDK's env-derived
// egress defaults (network + telemetry are OFF outside prod). Mirrors the SDK's
// own src/__tests__/setup.ts.
process.env.SHIPEASY_ENV = "production";
