import type { AreaSupport } from "./types.ts";

/** Support table changes of the "authentication" area. */
export const authenticationSupport: AreaSupport = {
  api: {
    "authentication.*": null,
    "authentication.registerAuthenticationProvider": "supported",
    "authentication.getSession": "supported",
    "authentication.getAccounts": "supported",
    "authentication.onDidChangeSessions": "supported",
  },
  contributions: {
    authentication: ["supported", "declared providers activate on demand (onAuthenticationRequest:<id>); no built-in providers"],
  },
};
