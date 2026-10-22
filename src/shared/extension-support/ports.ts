import type { AreaSupport } from "./types.ts";

/** Support table changes of the "ports" area. */
export const portsSupport: AreaSupport = {
  api: {
    "workspace.openTunnel": [
      "supported",
      "proposed API; forwards with a local TCP forwarder (ports of this machine are shown as they are); listed in the Ports panel",
    ],
    "workspace.tunnels": ["supported", "proposed API"],
    "workspace.onDidChangeTunnels": ["supported", "proposed API"],
  },
};
