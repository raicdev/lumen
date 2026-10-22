import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import {
  autoUpdater,
  compareSemver,
  installerAssetPattern,
  newestUpdate,
  parseSemver,
  parseVersion,
  releaseUpdate,
} from "../packages/lumen-shell/src/main/updater.ts";

const SETUP = "Lumen-0.2.0-win32-x64-setup.exe";

function release(overrides: Record<string, unknown> = {}) {
  return {
    tag_name: "v0.2.0",
    name: "Lumen v0.2.0",
    body: "Notes",
    html_url: "https://github.com/raicdev/lumen/releases/tag/v0.2.0",
    assets: [
      { name: "Lumen-v0.2.0-win32-x64.zip", browser_download_url: "https://example.com/zip", size: 2, digest: "sha256:" + "a".repeat(64) },
      { name: SETUP, browser_download_url: "https://example.com/setup", size: 1, digest: "sha256:" + "B".repeat(64) },
    ],
    ...overrides,
  };
}

test("versions: plain semver with an optional v, nothing else", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseVersion("0.10.0"), [0, 10, 0]);
  assert.equal(parseVersion("1.2.3-beta.1"), null);
  assert.equal(parseVersion("nightly"), null);
});

test("a newer release becomes an update with the platform's setup", () => {
  const update = releaseUpdate(release(), "0.1.1", installerAssetPattern("win32", "x64"));
  assert.deepEqual(update, {
    version: "0.2.0",
    title: "Lumen v0.2.0",
    notes: "Notes",
    url: "https://github.com/raicdev/lumen/releases/tag/v0.2.0",
    installer: { name: SETUP, url: "https://example.com/setup", size: 1, sha256: "b".repeat(64) },
  });
  // 0.10.0 is newer than 0.9.0 (numbers, not strings).
  assert.ok(releaseUpdate(release({ tag_name: "v0.10.0" }), "0.9.0", null));
});

test("same, older, pre-release, draft and malformed releases are no update", () => {
  const pattern = installerAssetPattern("win32", "x64");
  assert.equal(releaseUpdate(release(), "0.2.0", pattern), null);
  assert.equal(releaseUpdate(release(), "0.3.0", pattern), null);
  assert.equal(releaseUpdate(release({ prerelease: true }), "0.1.0", pattern), null);
  assert.equal(releaseUpdate(release({ draft: true }), "0.1.0", pattern), null);
  assert.equal(releaseUpdate(release({ tag_name: "v0.2.0-rc.1" }), "0.1.0", pattern), null);
});

test("a pre-release build gets the stable release of its version and newer ones, not older ones", () => {
  const pattern = installerAssetPattern("win32", "x64");
  assert.equal(releaseUpdate(release(), "0.2.0-beta.1", pattern)?.version, "0.2.0");
  assert.equal(releaseUpdate(release(), "0.1.9-beta.2", pattern)?.version, "0.2.0");
  assert.equal(releaseUpdate(release(), "0.2.1-beta.1", pattern), null);
  assert.equal(releaseUpdate(release(), "0.2.0-", pattern), null);
});

test("semver precedence: pre-releases come before their release, numeric identifiers sort as numbers", () => {
  const order = ["0.2.1", "0.2.2-alpha", "0.2.2-beta.1", "0.2.2-beta.2", "0.2.2-beta.10", "0.2.2-rc.1", "0.2.2", "v0.3.0-beta.1"];
  const parsed = order.map((version) => parseSemver(version)!);
  for (let i = 1; i < parsed.length; i++) assert.ok(compareSemver(parsed[i - 1]!, parsed[i]!) < 0, `${order[i - 1]} < ${order[i]}`);
  assert.equal(compareSemver(parseSemver("1.0.0+build.5")!, parseSemver("v1.0.0")!), 0);
  assert.equal(parseSemver("1.0.0-"), null);
  assert.equal(parseSemver("1.0"), null);
});

test("the beta channel takes pre-releases; the stable channel never does", () => {
  const pattern = installerAssetPattern("win32", "x64");
  const beta = release({ tag_name: "v0.3.0-beta.1", prerelease: true });
  assert.equal(releaseUpdate(beta, "0.2.0", pattern, "stable"), null);
  assert.equal(releaseUpdate(beta, "0.2.0", pattern, "beta")?.version, "0.3.0-beta.1");
  assert.equal(releaseUpdate(release({ tag_name: "v0.3.0-beta.2", prerelease: true }), "0.3.0-beta.1", pattern, "beta")?.version, "0.3.0-beta.2");
  assert.equal(releaseUpdate(beta, "0.3.0-beta.1", pattern, "beta"), null);
  assert.equal(releaseUpdate(beta, "0.3.0", pattern, "beta"), null);
  assert.equal(releaseUpdate(release({ tag_name: "v0.3.0-beta.1", draft: true }), "0.2.0", pattern, "beta"), null);
});

test("the newest update of a release list wins, a release over the betas of its version", () => {
  const list = [
    release({ tag_name: "v0.3.0-beta.2", prerelease: true }),
    release({ tag_name: "v0.3.0" }),
    release({ tag_name: "v0.3.0-beta.1", prerelease: true }),
    release({ tag_name: "v0.2.0" }),
  ];
  assert.equal(newestUpdate(list, "0.3.0-beta.1", null, "beta")?.version, "0.3.0");
  assert.equal(newestUpdate(list.slice(2), "0.2.0", null, "beta")?.version, "0.3.0-beta.1");
  assert.equal(newestUpdate([list[0]!, list[3]!], "0.1.0", null, "stable")?.version, "0.2.0");
  assert.equal(newestUpdate(list, "0.3.0", null, "beta"), null);
});

test("no setup for other architectures or platforms; a missing digest is reported as null", () => {
  assert.equal(releaseUpdate(release(), "0.1.0", installerAssetPattern("win32", "arm64"))?.installer, null);
  assert.equal(releaseUpdate(release(), "0.1.0", installerAssetPattern("linux", "x64"))?.installer, null);
  const noDigest = release({ assets: [{ name: SETUP, browser_download_url: "https://example.com/setup", size: 1 }] });
  assert.equal(releaseUpdate(noDigest, "0.1.0", installerAssetPattern("win32", "x64"))?.installer?.sha256, null);
});

test("download checks the SHA-256 digest and reuses a verified download", async (t) => {
  const payload = Buffer.from("setup bytes ".repeat(1000));
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "Content-Length": payload.length });
    response.end(payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  autoUpdater.configure({ repository: "example/app", name: "Lumen", version: "0.1.0", identifier: `lumen-updater-test-${process.pid}` });
  t.after(() => rmSync(autoUpdater.downloadDir, { recursive: true, force: true }));

  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/setup.exe`;
  const sha256 = createHash("sha256").update(payload).digest("hex");
  const update = { version: "0.2.0", title: "", notes: "", url: "", installer: { name: SETUP, url, size: payload.length, sha256 } };

  let last = 0;
  const file = await autoUpdater.download(update, (received) => (last = received));
  assert.equal(last, payload.length);
  assert.deepEqual(readFileSync(file), payload);
  assert.equal(await autoUpdater.download(update), file);
  assert.equal(requests, 1);

  const tampered = { ...update, installer: { ...update.installer, name: "Other-setup.exe", sha256: "0".repeat(64) } };
  await assert.rejects(autoUpdater.download(tampered), /SHA-256/);
  assert.equal(existsSync(`${autoUpdater.downloadDir}/Other-setup.exe`), false);
  assert.equal(existsSync(`${autoUpdater.downloadDir}/Other-setup.exe.part`), false);

  const unsafe = { ...update, installer: { ...update.installer, name: "..\\evil.exe" } };
  const saved = await autoUpdater.download(unsafe);
  assert.ok(saved.startsWith(autoUpdater.downloadDir));
});
