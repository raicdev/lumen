import type { AuthenticationAccountInfo, AuthenticationPendingRequest, AuthenticationState } from "../../shared/authentication";
import { createStore, refreshFeatures } from "./store";
import type { ViewFeature, ViewFeatureApi } from "./types";

/**
 * Window side of the "authentication" area: the Accounts entry (status bar,
 * right) that lists the signed-in accounts of the registered authentication
 * providers, signs out, revokes the access of extensions and answers pending
 * sign-in requests. Its styles go to feature-authentication.css (imported by index.css).
 */

const state = createStore<AuthenticationState>({ accounts: [], pending: [] });

const MANAGE = "lumen.authentication.manageAccounts";

function apply(next: AuthenticationState) {
  state.set(next);
  refreshFeatures();
}

async function reload(api: ViewFeatureApi) {
  try {
    apply(await api.requestHost<AuthenticationState>("state"));
  } catch {
    /* the host is restarting */
  }
}

async function manageAccount(api: ViewFeatureApi, account: AuthenticationAccountInfo) {
  const actions = [
    { label: "Sign Out", description: `${account.accountLabel} (${account.providerLabel})` },
    ...account.extensions.map((extension) => ({ label: `Revoke access for ${extension.name}`, description: extension.id })),
  ];
  const picked = await api.showQuickPick(actions, { title: `${account.accountLabel} - ${account.providerLabel}`, placeholder: "Manage this account" });
  const index = picked?.[0];
  if (index === undefined) return;
  if (index === 0) {
    const answer = await api.showMessage("warning", `Sign out of ${account.accountLabel} (${account.providerLabel})? Extensions using it will lose access.`, ["Sign Out"]);
    if (answer !== 0) return;
    await api.requestHost("signOut", [account.providerId, account.accountId]);
  } else {
    const extension = account.extensions[index - 1]!;
    await api.requestHost("revoke", [account.providerId, account.accountId, extension.id]);
  }
  await reload(api);
}

async function answerPending(api: ViewFeatureApi, request: AuthenticationPendingRequest) {
  const picked = await api.showQuickPick(
    [{ label: "Sign In", description: request.providerLabel }, { label: "Dismiss" }],
    { title: `${request.extensionName} wants to sign in using ${request.providerLabel}` },
  );
  const index = picked?.[0];
  if (index === undefined) return;
  try {
    if (index === 0) await api.requestHost("resolvePending", [request.id]);
    else await api.requestHost("dismissPending", [request.id]);
  } catch (error) {
    api.showMessage("error", error instanceof Error ? error.message : String(error));
  }
  await reload(api);
}

async function manageAccounts(api: ViewFeatureApi) {
  await reload(api);
  const { accounts, pending } = state.get();
  if (!accounts.length && !pending.length) {
    api.showMessage("info", "No accounts are signed in. Extensions that use an authentication provider will list their accounts here.");
    return;
  }
  const items = [
    ...pending.map((request) => ({ label: `Sign in with ${request.providerLabel} to use ${request.extensionName}`, description: "Pending request" })),
    ...accounts.map((account) => ({
      label: account.accountLabel,
      description: account.providerLabel,
      detail: account.extensions.length ? `Used by ${account.extensions.map((extension) => extension.name).join(", ")}` : undefined,
    })),
  ];
  const picked = await api.showQuickPick(items, { title: "Accounts", placeholder: "Select an account to manage", matchOnDescription: true });
  const index = picked?.[0];
  if (index === undefined) return;
  if (index < pending.length) await answerPending(api, pending[index]!);
  else await manageAccount(api, accounts[index - pending.length]!);
}

export const authenticationView: ViewFeature = {
  area: "authentication",
  onHostReady: (api) => void reload(api),
  onHostMessage: (payload) => {
    const message = payload as { type?: string; state?: AuthenticationState };
    if (message?.type === "state" && message.state) apply(message.state);
  },
  commands: [{ id: MANAGE, title: "Manage Accounts", category: "Accounts", run: (api) => manageAccounts(api) }],
  statusBarItems: [
    {
      id: "authentication.accounts",
      side: "right",
      priority: 5,
      text: () => {
        const { accounts, pending } = state.get();
        if (!accounts.length && !pending.length) return "";
        return pending.length ? `$(account) ${accounts.length} $(bell)` : `$(account) ${accounts.length}`;
      },
      tooltip: () => {
        const { accounts, pending } = state.get();
        const lines = accounts.map((account) => `${account.accountLabel} (${account.providerLabel})`);
        if (pending.length) lines.push(`${pending.length} pending sign-in request(s)`);
        return lines.join("\n") || undefined;
      },
      command: MANAGE,
    },
  ],
};
