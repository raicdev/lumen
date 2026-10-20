/** Wire types of the "ports" area (forwarded ports) between the extension host and the Ports panel. */

export type PortWire = {
  id: number;
  remoteHost: string;
  remotePort: number;
  /** `localhost:<port>` */
  localAddress: string;
  localPort: number;
  label?: string;
  protocol: string;
  privacy: string;
  /** "user", or the id of the extension that forwarded it. */
  source: string;
};

/** Host -> window. */
export type PortsHostMessage = { kind: "ports"; ports: PortWire[] };

/** Window -> host. */
export type PortsViewMessage = { kind: "ready" } | { kind: "close"; id: number };
