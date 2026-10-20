/** Types shared by the host (main/exthost/features/authentication.ts) and the window (mainview/features/authentication.tsx). */

export type AuthenticationAccountInfo = {
  providerId: string;
  providerLabel: string;
  accountId: string;
  accountLabel: string;
  extensions: { id: string; name: string }[];
};

export type AuthenticationPendingRequest = {
  id: string;
  providerId: string;
  providerLabel: string;
  extensionId: string;
  extensionName: string;
};

/** What the host tells the window whenever accounts, providers or pending sign-in requests change. */
export type AuthenticationState = {
  accounts: AuthenticationAccountInfo[];
  pending: AuthenticationPendingRequest[];
};
