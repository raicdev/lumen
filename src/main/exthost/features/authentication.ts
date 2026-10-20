import { join } from "node:path";
import type { ExtensionHost } from "../host.ts";
import type { AuthenticationState } from "../../../shared/authentication.ts";
import type { HostFeature } from "./contract.ts";
import { AuthenticationService } from "./authentication/core.ts";
import type { AuthClient, AuthProvider, GetSessionOptions } from "./authentication/core.ts";

/**
 * Host side of the "authentication" area: `authentication.*` with VS Code's
 * getSession semantics (consent prompt, per-extension account access that is
 * persisted), the `onAuthenticationRequest` activation and the data behind the
 * window's Accounts menu.
 */

const services = new WeakMap<ExtensionHost, AuthenticationService>();

/** Extensions that declare `contributes.authentication: [{ id }]` for the provider (VS Code activates them on demand). */
function contributors(host: ExtensionHost, providerId: string) {
  return [...host.runtimes.values()].filter((runtime) => {
    const declared = (runtime.description.manifest as { contributes?: { authentication?: { id?: string }[] } }).contributes?.authentication;
    return Array.isArray(declared) && declared.some((entry) => entry?.id === providerId);
  });
}

export function authenticationService(host: ExtensionHost): AuthenticationService {
  let service = services.get(host);
  if (service) return service;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        host.postFeature("authentication", { type: "state", state: await snapshot(service!) });
      } catch {
        /* the window is gone */
      }
    }, 20);
    timer.unref?.();
  };
  service = new AuthenticationService({
    file: host.init?.userData ? join(host.init.userData, "authentication", "access.json") : null,
    confirm: async (message, detail, allow) => (await host.requestView("showMessage", "info", message, [allow], { modal: true, detail })) === 0,
    pick: async (title, items) => {
      const picked = await host.requestView("showQuickPick", { id: host.nextId(), title, items, canPickMany: false });
      return picked?.[0];
    },
    activate: async (providerId) => {
      await host.activateByEvent(`onAuthenticationRequest:${providerId}`);
      for (const runtime of contributors(host, providerId)) {
        try {
          await host.activate(runtime, `onAuthenticationRequest:${providerId}`);
        } catch {
          /* activation errors are reported by the host */
        }
      }
    },
    changed: publish,
  });
  services.set(host, service);
  return service;
}

async function snapshot(service: AuthenticationService): Promise<AuthenticationState> {
  return {
    accounts: (await service.listAccounts()).map(({ sessionIds: _sessionIds, ...account }) => account),
    pending: [...service.pending.values()].map(({ scopes: _scopes, ...request }) => request),
  };
}

export const authenticationFeature: HostFeature = {
  area: "authentication",

  api: ({ host, runtime, extensionId }) => {
    const client: AuthClient = {
      id: extensionId,
      name: runtime ? (runtime.description.manifest.displayName ?? extensionId) : extensionId,
    };
    return {
      authentication: {
        getSession: (providerId: string, scopes: unknown, options?: GetSessionOptions) => authenticationService(host).getSession(client, providerId, scopes, options),
        getAccounts: (providerId: string) => authenticationService(host).getAccounts(providerId),
        registerAuthenticationProvider: (id: string, label: string, provider: AuthProvider, options?: { supportsMultipleAccounts?: boolean }) =>
          authenticationService(host).registerProvider(id, label, provider, options),
        onDidChangeSessions: (listener: (e: unknown) => unknown, thisArgs?: unknown, disposables?: { dispose(): unknown }[]) =>
          authenticationService(host).sessionsChanged.event(thisArgs ? listener.bind(thisArgs) : listener, undefined, disposables as never),
      },
    };
  },

  init: (host) => {
    authenticationService(host);
  },

  onViewRequest: async (host, method, args) => {
    const service = authenticationService(host);
    switch (method) {
      case "state":
        return snapshot(service);
      case "signOut":
        await service.signOut(String(args[0]), String(args[1]));
        return true;
      case "revoke":
        service.revoke(String(args[0]), String(args[1]), String(args[2]));
        return true;
      case "resolvePending":
        return service.resolvePending(String(args[0]));
      case "dismissPending":
        service.dismissPending(String(args[0]));
        return true;
      default:
        throw new Error(`Unknown authentication request '${method}'`);
    }
  },
};
