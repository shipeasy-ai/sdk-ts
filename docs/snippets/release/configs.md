Read a typed dynamic config (with a default when the key is absent). Assumes `configure()` ran at startup — see Installation.

```ts
import { Client } from "@shipeasy/sdk/server"; // or "@shipeasy/sdk/client"

// construct once per callsite (cheap; binds the user)
const flags = new Client(currentUser);

// getConfig<T>(name, opts?)
//   name             — the config name
//   opts.defaultValue — returned when the config key is absent
//   opts.decode       — optional (raw) => T to validate/shape the stored value
const cfg = flags.getConfig<{ max: number }>("{{CONFIG_KEY}}", {
  defaultValue: { max: 50 },               // used when the key isn't published
  decode: (raw) => raw as { max: number }, // optional — typed decode / zod parse
});
```
