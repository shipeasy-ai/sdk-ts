Render a translated label with the `i18n` facade. The fallback is the source string; it shows until the loader resolves. Assumes the i18n loader is wired at startup — see Installation.

```ts
import { i18n } from "@shipeasy/sdk/client";

// t(key, fallback, variables?)
//   key       — the translation key
//   fallback  — source string shown until the loader resolves (and the
//               extractable default)
//   variables — optional {{var}} interpolation values
i18n.t("checkout.cta", "Place order");
i18n.t("cart.count", "{{count}} items", { count: cart.length }); // variables
```
