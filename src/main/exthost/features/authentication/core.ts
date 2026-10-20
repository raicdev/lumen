import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Disposable, EventEmitter } from "../../types.ts";

/**
 * The authentication service of the extension host: providers extensions
 * register, `getSession` with VS Code's createIfNone / forceNewSession / silent
 * semantics, and which extension may use which account (persisted). UI and
 * extension activation are injected so the logic runs without a window.
 */

export type AuthAccount = { id: string; label: string };
export type AuthSession = { id: string; accessToken: string; account: AuthAccount; scopes: readonly string[]; idToken?: string };
export type AuthProvider = {
  getSessions(scopes: readonly string[] | undefined, options?: { account?: AuthAccount }): PromiseLike<readonly AuthSession[]> | readonly AuthSession[];
  createSession(scopes: readonly string[], options?: { account?: AuthAccount }): PromiseLike<AuthSession> | AuthSession;
  removeSession(sessionId: string): PromiseLike<void> | void;
  onDidChangeSessions: (listener: (e: unknown) => unknown) => { dispose(): unknown };
};
export type GetSessionOptions = {
  createIfNone?: boolean | { detail?: string };
  forceNewSession?: boolean | { detail?: string };
  clearSessionPreference?: boolean;
  silent?: boolean;
  account?: AuthAccount;
};
export type AuthClient = { id: string; name: string };

export type AccountInfo = {
  providerId: string;
  providerLabel: string;
  accountId: string;
  accountLabel: string;
  sessionIds: string[];
  extensions: { id: string; name: string }[];
};
export type PendingRequest = { id: string; providerId: string; providerLabel: string; extensionId: string; extensionName: string; scopes: string[] };

type Stored = {
  /** provider -> account -> extensions allowed to use it */
  allowed: Record<string, Record<string, { id: string; name: string }[]>>;
  /** `extension\nprovider\nscopes` -> preferred account id */
  preferred: Record<string, string>;
};

export type AuthDeps = {
  /** Where the allowed-extensions state lives (null: memory only). */
  file: string | null;
  /** A modal "Allow" question. */
  confirm(message: string, detail: string | undefined, allow: string): Promise<boolean>;
  /** A quick pick of labels; the picked index or undefined. */
  pick(title: string, items: { label: string; description?: string }[]): Promise<number | undefined>;
  /** Activate extensions that contribute / handle the provider (onAuthenticationRequest). */
  activate(providerId: string): Promise<void>;
  /** Accounts / pending requests / providers changed. */
  changed?(): void;
};

type ProviderEntry = { label: string; provider: AuthProvider; supportsMultipleAccounts: boolean; subscription: { dispose(): unknown } };

const scopesOf = (value: unknown): string[] => {
  const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { scopes?: unknown }).scopes) ? (value as { scopes: unknown[] }).scopes : [];
  return list.map(String);
};
const scopeKey = (scopes: readonly string[]) => [...scopes].sort().join(" ");
const detailOf = (option: unknown): string | undefined => (option && typeof option === "object" ? (option as { detail?: string }).detail : undefined);

export class AuthenticationService {
  readonly deps: AuthDeps;
  readonly providers = new Map<string, ProviderEntry>();
  readonly sessionsChanged = new EventEmitter<{ provider: { id: string; label: string } }>();
  readonly pending = new Map<string, PendingRequest>();
  #stored: Stored;
  #inflight = new Map<string, Promise<AuthSession | undefined>>();

  constructor(deps: AuthDeps) {
    this.deps = deps;
    this.#stored = { allowed: {}, preferred: {} };
    if (deps.file) {
      try {
        const data = JSON.parse(readFileSync(deps.file, "utf8")) as Partial<Stored>;
        this.#stored = { allowed: data.allowed ?? {}, preferred: data.preferred ?? {} };
      } catch {
        /* nothing stored yet */
      }
    }
  }

  #save() {
    if (!this.deps.file) return;
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true });
      writeFileSync(this.deps.file, JSON.stringify(this.#stored), { encoding: "utf8", mode: 0o600 });
    } catch {
      /* the state stays in memory */
    }
  }

  /* ── providers ────────────────────────────────────────────────────── */

  registerProvider(id: string, label: string, provider: AuthProvider, options?: { supportsMultipleAccounts?: boolean }): Disposable {
    if (this.providers.has(id)) throw new Error(`An authentication provider with id '${id}' is already registered.`);
    const subscription = provider.onDidChangeSessions(() => {
      this.sessionsChanged.fire({ provider: { id, label } });
      this.deps.changed?.();
    });
    this.providers.set(id, { label, provider, supportsMultipleAccounts: !!options?.supportsMultipleAccounts, subscription });
    this.deps.changed?.();
    return new Disposable(() => {
      const current = this.providers.get(id);
      if (!current || current.provider !== provider) return;
      this.providers.delete(id);
      current.subscription.dispose();
      this.sessionsChanged.fire({ provider: { id, label } });
      this.deps.changed?.();
    });
  }

  async #provider(id: string): Promise<ProviderEntry> {
    let entry = this.providers.get(id);
    if (!entry) {
      await this.deps.activate(id);
      entry = this.providers.get(id);
    }
    if (!entry) throw new Error(`No authentication provider '${id}' is currently registered.`);
    return entry;
  }

  /* ── access ───────────────────────────────────────────────────────── */

  isAllowed(providerId: string, accountId: string, extensionId: string): boolean {
    return !!this.#stored.allowed[providerId]?.[accountId]?.some((entry) => entry.id === extensionId);
  }

  allow(providerId: string, accountId: string, client: AuthClient) {
    const accounts = (this.#stored.allowed[providerId] ??= {});
    const list = (accounts[accountId] ??= []);
    if (!list.some((entry) => entry.id === client.id)) list.push({ id: client.id, name: client.name });
    this.#save();
  }

  revoke(providerId: string, accountId: string, extensionId: string) {
    const list = this.#stored.allowed[providerId]?.[accountId];
    if (!list) return;
    this.#stored.allowed[providerId]![accountId] = list.filter((entry) => entry.id !== extensionId);
    for (const key of Object.keys(this.#stored.preferred)) {
      if (key.startsWith(`${extensionId}\n${providerId}\n`) && this.#stored.preferred[key] === accountId) delete this.#stored.preferred[key];
    }
    this.#save();
    this.deps.changed?.();
  }

  #prefKey(client: AuthClient, providerId: string, scopes: readonly string[]) {
    return `${client.id}\n${providerId}\n${scopeKey(scopes)}`;
  }

  /* ── getSession ───────────────────────────────────────────────────── */

  async getSession(client: AuthClient, providerId: string, scopesInput: unknown, options: GetSessionOptions = {}): Promise<AuthSession | undefined> {
    const interactive = !!(options.createIfNone || options.forceNewSession);
    if (options.silent && interactive) throw new Error("Invalid combination of options. Please remove one of the following: silent, createIfNone, forceNewSession");
    const scopes = scopesOf(scopesInput);
    const entry = await this.#provider(providerId);
    if (!interactive) return this.#resolve(client, providerId, entry, scopes, options);
    // One prompt at a time per extension / provider / scopes.
    const key = this.#prefKey(client, providerId, scopes);
    const running = this.#inflight.get(key);
    if (running && !options.forceNewSession) return running;
    const promise = this.#resolve(client, providerId, entry, scopes, options).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, promise);
    return promise;
  }

  async #resolve(client: AuthClient, providerId: string, entry: ProviderEntry, scopes: string[], options: GetSessionOptions): Promise<AuthSession | undefined> {
    const interactive = !!(options.createIfNone || options.forceNewSession);
    const accountOption = options.account ? { account: options.account } : {};
    if (options.clearSessionPreference) {
      delete this.#stored.preferred[this.#prefKey(client, providerId, scopes)];
      this.#save();
    }
    const found = [...((await entry.provider.getSessions(scopes, accountOption)) ?? [])];
    const candidates = options.account ? found.filter((session) => session.account.id === options.account!.id) : found;

    if (!options.forceNewSession && candidates.length) {
      const allowed = candidates.filter((session) => this.isAllowed(providerId, session.account.id, client.id));
      if (allowed.length) {
        const preferred = this.#stored.preferred[this.#prefKey(client, providerId, scopes)];
        const preferredSession = allowed.find((session) => session.account.id === preferred);
        if (preferredSession) return preferredSession;
        if (allowed.length === 1 || !interactive) return allowed[0];
        const chosen = await this.#chooseAccount(entry, `Choose an account for ${client.name} (${entry.label})`, allowed, false);
        if (chosen === undefined) throw new Error("User did not consent to account access.");
        if (chosen === "new") return this.#create(client, providerId, entry, scopes, options, accountOption);
        this.#prefer(client, providerId, scopes, chosen);
        return chosen;
      }
      // Accounts exist, but the extension may not use them yet.
      if (!interactive) {
        if (!options.silent) this.#addPending(client, providerId, entry.label, scopes);
        return undefined;
      }
      let chosen: AuthSession | "new" | undefined;
      if (candidates.length === 1 && !entry.supportsMultipleAccounts) {
        const ok = await this.deps.confirm(`The extension '${client.name}' wants to sign in using ${entry.label}.`, `Account: ${candidates[0]!.account.label}`, "Allow");
        chosen = ok ? candidates[0] : undefined;
      } else {
        chosen = await this.#chooseAccount(entry, `The extension '${client.name}' wants to sign in using ${entry.label}`, candidates, true);
      }
      if (!chosen) throw new Error("User did not consent to login.");
      if (chosen === "new") return this.#create(client, providerId, entry, scopes, options, accountOption);
      this.allow(providerId, chosen.account.id, client);
      this.#prefer(client, providerId, scopes, chosen);
      this.#clearPending(client, providerId, scopes);
      this.deps.changed?.();
      return chosen;
    }

    if (!interactive) {
      if (!options.silent) this.#addPending(client, providerId, entry.label, scopes);
      return undefined;
    }
    return this.#create(client, providerId, entry, scopes, options, accountOption);
  }

  async #chooseAccount(entry: ProviderEntry, title: string, sessions: AuthSession[], offerNew: boolean): Promise<AuthSession | "new" | undefined> {
    const items = sessions.map((session) => ({ label: session.account.label, description: entry.label }));
    if (offerNew && entry.supportsMultipleAccounts) items.push({ label: "Sign in to another account", description: entry.label });
    const index = await this.deps.pick(title, items);
    if (index === undefined) return undefined;
    return index >= sessions.length ? "new" : sessions[index];
  }

  async #create(client: AuthClient, providerId: string, entry: ProviderEntry, scopes: string[], options: GetSessionOptions, accountOption: { account?: AuthAccount }): Promise<AuthSession> {
    const detail = options.forceNewSession ? detailOf(options.forceNewSession) : detailOf(options.createIfNone);
    const message = options.forceNewSession
      ? `The extension '${client.name}' wants you to sign in again using ${entry.label}.`
      : `The extension '${client.name}' wants to sign in using ${entry.label}.`;
    if (!(await this.deps.confirm(message, detail, "Allow"))) throw new Error("User did not consent to login.");
    const session = await entry.provider.createSession(scopes, accountOption);
    this.allow(providerId, session.account.id, client);
    this.#prefer(client, providerId, scopes, session);
    this.#clearPending(client, providerId, scopes);
    this.deps.changed?.();
    return session;
  }

  #prefer(client: AuthClient, providerId: string, scopes: readonly string[], session: AuthSession) {
    this.#stored.preferred[this.#prefKey(client, providerId, scopes)] = session.account.id;
    this.#save();
  }

  /* ── pending sign-in requests (getSession without createIfNone) ────── */

  #addPending(client: AuthClient, providerId: string, providerLabel: string, scopes: string[]) {
    const id = this.#prefKey(client, providerId, scopes);
    if (this.pending.has(id)) return;
    this.pending.set(id, { id, providerId, providerLabel, extensionId: client.id, extensionName: client.name, scopes });
    this.deps.changed?.();
  }

  #clearPending(client: AuthClient, providerId: string, scopes: readonly string[]) {
    this.pending.delete(this.#prefKey(client, providerId, scopes));
  }

  /** The user picked a pending request in the Accounts menu: run the interactive flow for it. */
  async resolvePending(id: string): Promise<boolean> {
    const request = this.pending.get(id);
    if (!request) return false;
    const session = await this.getSession({ id: request.extensionId, name: request.extensionName }, request.providerId, request.scopes, { createIfNone: true });
    this.pending.delete(id);
    // Tells the extension to query its session again.
    this.sessionsChanged.fire({ provider: { id: request.providerId, label: request.providerLabel } });
    this.deps.changed?.();
    return !!session;
  }

  dismissPending(id: string) {
    if (this.pending.delete(id)) this.deps.changed?.();
  }

  /* ── accounts ─────────────────────────────────────────────────────── */

  async getAccounts(providerId: string): Promise<readonly AuthAccount[]> {
    const entry = await this.#provider(providerId);
    const sessions = (await entry.provider.getSessions(undefined)) ?? [];
    const seen = new Map<string, AuthAccount>();
    for (const session of sessions) if (!seen.has(session.account.id)) seen.set(session.account.id, { id: session.account.id, label: session.account.label });
    return [...seen.values()];
  }

  /** Every signed-in account of every registered provider, with the extensions allowed to use it. */
  async listAccounts(): Promise<AccountInfo[]> {
    const result: AccountInfo[] = [];
    for (const [providerId, entry] of this.providers) {
      let sessions: readonly AuthSession[] = [];
      try {
        sessions = (await entry.provider.getSessions(undefined)) ?? [];
      } catch {
        continue;
      }
      const byAccount = new Map<string, AccountInfo>();
      for (const session of sessions) {
        const info = byAccount.get(session.account.id) ?? {
          providerId,
          providerLabel: entry.label,
          accountId: session.account.id,
          accountLabel: session.account.label,
          sessionIds: [],
          extensions: [...(this.#stored.allowed[providerId]?.[session.account.id] ?? [])],
        };
        info.sessionIds.push(session.id);
        byAccount.set(session.account.id, info);
      }
      result.push(...byAccount.values());
    }
    return result;
  }

  async signOut(providerId: string, accountId: string): Promise<void> {
    const entry = this.providers.get(providerId);
    if (!entry) return;
    const sessions = (await entry.provider.getSessions(undefined)) ?? [];
    for (const session of sessions) if (session.account.id === accountId) await entry.provider.removeSession(session.id);
    delete this.#stored.allowed[providerId]?.[accountId];
    for (const key of Object.keys(this.#stored.preferred)) {
      if (key.split("\n")[1] === providerId && this.#stored.preferred[key] === accountId) delete this.#stored.preferred[key];
    }
    this.#save();
    this.deps.changed?.();
  }
}
