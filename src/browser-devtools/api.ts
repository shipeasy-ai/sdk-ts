// Browser-overlay adapter over the shared headless devtools core. The overlay
// predates the core's injected-callback 401 contract, so this shim keeps its
// window-event surface: any 401 dispatches DEVTOOLS_UNAUTHED_EVENT and the
// overlay drops the cached session + reopens the connect screen.

import { AuthError, DevtoolsClient } from "../devtools/api";

export { AuthError };

/** Event name dispatched on `window` when any admin request returns 401. */
export const DEVTOOLS_UNAUTHED_EVENT = "se:devtools-unauthed";

export class DevtoolsApi extends DevtoolsClient {
  constructor(
    adminUrl: string,
    token: string,
    projectId: string,
    // Mutable so the overlay can refresh the kill-switch flag without
    // discarding the instance's response cache.
    public hideAdminLinks: boolean = false,
  ) {
    super({
      token,
      projectId,
      adminBaseUrl: adminUrl,
      onUnauthed: () => {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent(DEVTOOLS_UNAUTHED_EVENT));
        }
      },
    });
  }
}
