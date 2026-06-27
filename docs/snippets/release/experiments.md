Read an experiment's params, then record the conversion event.

```ts
import { configure, Client } from "@shipeasy/sdk/server"; // or "@shipeasy/sdk/client"

configure({ apiKey: process.env.SHIPEASY_SERVER_KEY! });

const flags = new Client(currentUser);
const { params } = flags.getExperiment("{{RESOURCE_NAME}}", {
  primary_label: "Sign up",
});

render(params.primary_label);

// On conversion — same bound Client, no user arg (the unit is inferred):
flags.track("{{SUCCESS_EVENT}}");
```
