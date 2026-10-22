import { Copy, Globe, Plus, X } from "lucide-react";
import type { PortWire, PortsHostMessage, PortsViewMessage } from "../../shared/ports";
import { api as rpc } from "../lib/rpc";
import { MenuActions } from "./menus-walkthroughs/MenuActions";
import { showContributedMenu } from "./menus-walkthroughs/menus";
import { createStore, refreshFeatures, useStore } from "./store";
import type { ViewFeature, ViewFeatureApi } from "./types";

/**
 * Window side of the "ports" area: the Ports panel. Forwarded ports (by
 * extensions through `workspace.openTunnel`, or by the user) with their
 * address, origin and the extensions' menus: ports/item/context (right
 * click), ports/item/port/inline (Port column) and ports/item/origin/inline
 * (Forwarded Address column).
 */

const store = createStore<PortWire[]>([]);
let featureApi: ViewFeatureApi | null = null;

const send = (message: PortsViewMessage) => featureApi?.sendToHost(message);

/** What VS Code gives commands of the ports menus (its tunnel item). */
function tunnelItem(port: PortWire) {
  return {
    tunnelType: "Forwarded",
    remoteHost: port.remoteHost,
    remotePort: port.remotePort,
    localAddress: port.localAddress,
    localPort: port.localPort,
    protocol: port.protocol,
    privacy: port.privacy,
    name: port.label,
    source: { source: port.source === "user" ? 0 : 1, description: originOf(port) },
    closeable: true,
  };
}

function portLookup(port: PortWire): (key: string) => unknown {
  return (key) => {
    switch (key) {
      case "tunnelType":
        return "Forwarded";
      case "tunnelCloseable":
        return true;
      case "tunnelPrivacy":
        return port.privacy;
      case "tunnelProtocol":
        return port.protocol;
      case "tunnelViewFocus":
        return true;
      case "tunnelViewMultiSelection":
        return false;
      default:
        return undefined;
    }
  };
}

const originOf = (port: PortWire) => (port.source === "user" ? "User Forwarded" : `Extension: ${port.source}`);
const urlOf = (port: PortWire) => `${port.protocol}://${port.localAddress}`;

async function forwardPort(api: ViewFeatureApi): Promise<void> {
  const value = await api.showInputBox({ title: "Forward a Port", prompt: "Port number or address (e.g. 3000 or 10.0.0.1:2000)", placeholder: "3000" });
  if (!value) return;
  try {
    store.set(await api.requestHost<PortWire[]>("forward", [value]));
  } catch (error) {
    void api.showMessage("error", error instanceof Error ? error.message : String(error));
  }
}

function PortsPanel() {
  const ports = useStore(store);
  return (
    <div className="ports-panel">
      <table className="ports-table">
        <thead>
          <tr>
            <th>Port</th>
            <th>Forwarded Address</th>
            <th>Origin</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ports.map((port) => {
            const lookup = portLookup(port);
            const args = () => [tunnelItem(port)];
            return (
              <tr key={port.id} onContextMenu={(e) => showContributedMenu(e, "ports/item/context", lookup, args)}>
                <td>
                  <span className="ports-cell">
                    <span className="ports-port">{port.label ? `${port.label} (${port.remotePort})` : port.remotePort}</span>
                    {port.remoteHost !== "localhost" && <span className="muted">{port.remoteHost}</span>}
                    <MenuActions menuId="ports/item/port/inline" lookup={lookup} args={args} inline={() => true} overflow={false} className="ports-inline" />
                  </span>
                </td>
                <td>
                  <span className="ports-cell">
                    <a
                      href="#"
                      onClick={(e) => (e.preventDefault(), void rpc().request.openExternal({ url: urlOf(port) }))}
                      title={`Open ${urlOf(port)} in the browser`}
                    >
                      {port.localAddress}
                    </a>
                    <MenuActions menuId="ports/item/origin/inline" lookup={lookup} args={args} inline={() => true} overflow={false} className="ports-inline" />
                  </span>
                </td>
                <td className="muted">{originOf(port)}</td>
                <td className="ports-actions">
                  <button type="button" className="icon-btn" title="Copy Local Address" onClick={() => void navigator.clipboard.writeText(port.localAddress)}>
                    <Copy size={13} />
                  </button>
                  <button type="button" className="icon-btn" title="Open in Browser" onClick={() => void rpc().request.openExternal({ url: urlOf(port) })}>
                    <Globe size={13} />
                  </button>
                  <button type="button" className="icon-btn" title="Stop Forwarding Port" onClick={() => send({ kind: "close", id: port.id })}>
                    <X size={13} />
                  </button>
                </td>
              </tr>
            );
          })}
          <tr>
            <td colSpan={4}>
              <button type="button" className="secondary-btn ports-add" onClick={() => featureApi && void forwardPort(featureApi)}>
                <Plus size={13} /> Forward a Port
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export const portsView: ViewFeature = {
  area: "ports",

  init: (api) => {
    featureApi = api;
  },

  onHostReady: (api) => {
    featureApi = api;
    store.set([]);
    api.sendToHost({ kind: "ready" } satisfies PortsViewMessage);
  },

  onHostMessage: (payload) => {
    const message = payload as PortsHostMessage;
    if (message.kind !== "ports") return;
    store.set(message.ports);
    refreshFeatures();
  },

  commands: [
    { id: "remote.tunnel.forwardCommandPalette", title: "Forward a Port", category: "Ports", run: (api) => forwardPort(api) },
    { id: "workbench.view.remote.ports", title: "Focus on Ports View", category: "Ports", run: (api) => api.revealPanelTab("ports") },
  ],

  panelTabs: [{ id: "ports", title: "Ports", render: () => <PortsPanel />, badge: () => store.get().length }],
};
