import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticationService } from "../../src/main/exthost/features/authentication/core.ts";
import type { AuthProvider, AuthSession } from "../../src/main/exthost/features/authentication/core.ts";
import { EventEmitter } from "../../src/main/exthost/types.ts";

/** node --test test/features/authentication.test.ts */

function fakeProvider() {
  const sessions: AuthSession[] = [];
  const changes = new EventEmitter<unknown>();
  let counter = 0;
  const provider: AuthProvider = {
    getSessions: (scopes) => sessions.filter((session) => !scopes || scopes.every((scope) => session.scopes.includes(scope))),
    createSession: (scopes) => {
      const n = ++counter;
      const session = { id: `s${n}`, accessToken: `tok${n}`, account: { id: `a${n}`, label: `user${n}` }, scopes };
      sessions.push(session);
      changes.fire({ added: [session] });
      return session;
    },
    removeSession: (id) => {
      const index = sessions.findIndex((session) => session.id === id);
      if (index >= 0) sessions.splice(index, 1);
    },
    onDidChangeSessions: changes.event,
  };
  return { provider, sessions };
}

function service(file: string | null, answers: { confirm?: boolean; pick?: number } = {}) {
  const log = { confirms: 0, picks: 0, changed: 0 };
  const instance = new AuthenticationService({
    file,
    confirm: async () => (log.confirms++, answers.confirm ?? true),
    pick: async () => (log.picks++, answers.pick),
    activate: async () => {},
    changed: () => void log.changed++,
  });
  return { instance, log };
}

const ext = { id: "pub.ext", name: "Ext" };

test("getSession: silent never prompts, createIfNone signs in and remembers consent", async () => {
  const { instance, log } = service(null);
  const { provider } = fakeProvider();
  instance.registerProvider("fake", "Fake", provider);
  assert.equal(await instance.getSession(ext, "fake", ["read"], { silent: true }), undefined);
  assert.equal(instance.pending.size, 0);
  assert.equal(await instance.getSession(ext, "fake", ["read"]), undefined);
  assert.equal(instance.pending.size, 1);
  const session = await instance.getSession(ext, "fake", ["read"], { createIfNone: true });
  assert.equal(session?.accessToken, "tok1");
  assert.equal(log.confirms, 1);
  assert.equal(instance.pending.size, 0);
  // Already allowed: returned without a prompt, also silently.
  assert.equal((await instance.getSession(ext, "fake", ["read"], { silent: true }))?.id, "s1");
  assert.equal(log.confirms, 1);
  // Another extension has no access to the account.
  assert.equal(await instance.getSession({ id: "other.ext", name: "Other" }, "fake", ["read"], { silent: true }), undefined);
});

test("getSession: declining consent throws; forceNewSession creates again; bad combos and unknown providers throw", async () => {
  const { instance } = service(null, { confirm: false });
  const { provider } = fakeProvider();
  instance.registerProvider("fake", "Fake", provider);
  await assert.rejects(instance.getSession(ext, "fake", ["a"], { createIfNone: true }), /did not consent/);
  await assert.rejects(instance.getSession(ext, "fake", ["a"], { silent: true, createIfNone: true }), /Invalid combination/);
  await assert.rejects(instance.getSession(ext, "nope", ["a"]), /No authentication provider 'nope'/);

  const ok = service(null);
  const second = fakeProvider();
  ok.instance.registerProvider("fake", "Fake", second.provider);
  const first = await ok.instance.getSession(ext, "fake", ["a"], { createIfNone: true });
  const again = await ok.instance.getSession(ext, "fake", ["a"], { forceNewSession: { detail: "expired" } });
  assert.notEqual(first?.id, again?.id);
});

test("existing account without access asks for consent; access persists across instances and can be revoked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumen-auth-test-"));
  const file = join(dir, "access.json");
  const { provider, sessions } = fakeProvider();
  const first = service(file);
  first.instance.registerProvider("fake", "Fake", provider);
  provider.createSession(["a"]);
  assert.equal(sessions.length, 1);
  const session = await first.instance.getSession(ext, "fake", ["a"], { createIfNone: true });
  assert.equal(session?.id, "s1");
  assert.equal(first.log.confirms, 1);
  assert.equal(sessions.length, 1);

  const second = service(file);
  second.instance.registerProvider("fake", "Fake", provider);
  assert.equal((await second.instance.getSession(ext, "fake", ["a"], { silent: true }))?.id, "s1");
  assert.equal(second.log.confirms, 0);
  const accounts = await second.instance.listAccounts();
  assert.deepEqual(
    accounts.map((account) => [account.accountId, account.extensions[0]?.id]),
    [["a1", "pub.ext"]],
  );

  second.instance.revoke("fake", "a1", ext.id);
  assert.equal(await second.instance.getSession(ext, "fake", ["a"], { silent: true }), undefined);
});

test("getAccounts, signOut and onDidChangeSessions", async () => {
  const { instance } = service(null);
  const { provider } = fakeProvider();
  const registration = instance.registerProvider("fake", "Fake", provider);
  const events: string[] = [];
  instance.sessionsChanged.event((e) => void events.push(e.provider.id));
  await instance.getSession(ext, "fake", ["a"], { createIfNone: true });
  assert.deepEqual(events, ["fake"]);
  assert.deepEqual(await instance.getAccounts("fake"), [{ id: "a1", label: "user1" }]);
  await instance.signOut("fake", "a1");
  assert.deepEqual(await instance.getAccounts("fake"), []);
  assert.equal(instance.pending.size, 0);
  assert.throws(() => instance.registerProvider("fake", "Dup", provider), /already registered/);
  registration.dispose();
  assert.equal(events.length, 2);
  await assert.rejects(instance.getAccounts("fake"), /No authentication provider/);
});

test("pending request can be resolved from the accounts menu", async () => {
  const { instance } = service(null);
  const { provider } = fakeProvider();
  instance.registerProvider("fake", "Fake", provider);
  await instance.getSession(ext, "fake", ["a"]);
  const [request] = [...instance.pending.values()];
  assert.ok(request);
  assert.equal(await instance.resolvePending(request.id), true);
  assert.equal(instance.pending.size, 0);
  assert.equal((await instance.getSession(ext, "fake", ["a"], { silent: true }))?.id, "s1");
});

test("the host API object exposes authentication.* backed by the service", async () => {
  const { mkdtempSync: mk } = await import("node:fs");
  const { ExtensionHost } = await import("../../src/main/exthost/host.ts");
  const host = new ExtensionHost();
  host.init = {
    extensions: [],
    config: { lumen: {}, user: {} },
    workspace: null,
    userData: mk(join(tmpdir(), "lumen-auth-host-")),
    appRoot: process.cwd(),
    appName: "Lumen",
    appVersion: "0.1.0",
    languages: [],
    webviewPort: 1,
    webviewToken: "t",
  };
  host.post = () => {};
  const api = host.apiFor(null) as { authentication: Record<string, (...args: unknown[]) => any> };
  const { provider } = fakeProvider();
  const registration = api.authentication.registerAuthenticationProvider!("fake", "Fake", provider);
  assert.equal(typeof registration.dispose, "function");
  assert.equal(await api.authentication.getSession!("fake", ["a"], { silent: true }), undefined);
  assert.deepEqual(await api.authentication.getAccounts!("fake"), []);
  registration.dispose();
  await assert.rejects(api.authentication.getSession!("fake", ["a"]), /No authentication provider/);
});
