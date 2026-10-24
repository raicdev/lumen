import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  UNCOMMITTED,
  gitBlame,
  gitCheckout,
  gitCommitFiles,
  gitCreateBranch,
  gitDeleteBranch,
  gitFetch,
  gitLog,
  gitPull,
  gitPush,
  gitRefs,
  gitShow,
  gitStatus,
  gitSync,
  parseBranchHeader,
  parseDecorations,
  parseNameStatus,
} from "../src/main/git.ts";
import { gitUri, parseGitUri } from "../src/mainview/lib/git-uri.ts";

/**
 * The git CLI wrapper behind the Source Control view: sync with a remote,
 * branches, history and blame, against real repositories in a temp folder.
 *
 *   node --test test/git.test.ts
 */

function run(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** A bare `origin` and a clone of it with one commit on `main`. */
function repos() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lumen-git-test-")));
  const origin = join(dir, "origin.git");
  run(dir, "init", "-q", "--bare", "-b", "main", origin);
  const clone = (name: string) => {
    const path = join(dir, name);
    run(dir, "clone", "-q", origin, path);
    for (const [key, value] of [
      ["user.name", name === "work" ? "Ada" : "Grace"],
      ["user.email", `${name}@example.com`],
      ["commit.gpgsign", "false"],
      ["tag.gpgsign", "false"],
      ["core.autocrlf", "false"],
      ["pull.rebase", "false"],
    ]) {
      run(path, "config", key!, value!);
    }
    run(path, "checkout", "-q", "-B", "main");
    return path;
  };
  const work = clone("work");
  writeFileSync(join(work, "a.txt"), "one\ntwo\nthree\n");
  run(work, "add", "a.txt");
  run(work, "commit", "-q", "-m", "First");
  run(work, "push", "-q", "-u", "origin", "main");
  return { dir, origin, work, clone, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the status header names the branch, its upstream and how far apart they are", () => {
  assert.deepEqual(parseBranchHeader("main...origin/main [ahead 2, behind 1]"), { branch: "main", upstream: "origin/main", ahead: 2, behind: 1 });
  assert.deepEqual(parseBranchHeader("feature"), { branch: "feature", upstream: null, ahead: 0, behind: 0 });
  assert.deepEqual(parseBranchHeader("No commits yet on main"), { branch: "main", upstream: null, ahead: 0, behind: 0 });
  assert.equal(parseBranchHeader("HEAD (no branch)").branch, "(detached)");
});

test("commit decorations: local and remote branches, tags, the checked-out branch", () => {
  assert.deepEqual(parseDecorations("HEAD -> refs/heads/feature/login, tag: refs/tags/v1.0, refs/remotes/origin/HEAD, refs/remotes/origin/main"), [
    { name: "feature/login", type: "head", current: true },
    { name: "v1.0", type: "tag" },
    { name: "origin/main", type: "remote" },
  ]);
  assert.deepEqual(parseDecorations("HEAD"), []);
  assert.deepEqual(parseDecorations(""), []);
});

test("renames in --name-status output carry both paths", () => {
  assert.deepEqual(parseNameStatus("M\0a.txt\0R087\0old.txt\0new.txt\0A\0b.txt\0"), [
    { status: "M", path: "a.txt" },
    { status: "R", oldPath: "old.txt", path: "new.txt" },
    { status: "A", path: "b.txt" },
  ]);
});

test("push, fetch, pull and sync keep a clone and its remote in step", async () => {
  const { work, clone, cleanup } = repos();
  try {
    assert.equal((await gitStatus(work)).upstream, "origin/main");

    writeFileSync(join(work, "a.txt"), "one\ntwo\nthree\nfour\n");
    run(work, "commit", "-q", "-am", "Four");
    assert.equal((await gitStatus(work)).ahead, 1);
    assert.deepEqual(await gitPush(work), { ok: true });
    assert.equal((await gitStatus(work)).ahead, 0);

    // Another clone sees the commit after a fetch, and takes it with a pull.
    const other = clone("other");
    writeFileSync(join(work, "b.txt"), "b\n");
    run(work, "add", "b.txt");
    run(work, "commit", "-q", "-m", "Add b");
    assert.ok((await gitSync(work)).ok);
    assert.deepEqual(await gitFetch(other), { ok: true });
    assert.equal((await gitStatus(other)).behind, 1);
    assert.deepEqual(await gitPull(other), { ok: true });
    assert.equal((await gitStatus(other)).behind, 0);
    assert.equal(await gitShow(other, "HEAD", join(other, "b.txt")), "b\n");
  } finally {
    cleanup();
  }
});

test("a new branch is published to origin on its first push", async () => {
  const { work, origin, cleanup } = repos();
  try {
    assert.deepEqual(await gitCreateBranch(work, "feature"), { ok: true });
    const status = await gitStatus(work);
    assert.equal(status.branch, "feature");
    assert.equal(status.upstream, null);
    assert.deepEqual(await gitPush(work), { ok: true });
    assert.equal((await gitStatus(work)).upstream, "origin/feature");
    assert.match(run(origin, "branch", "--list", "feature"), /feature/);
  } finally {
    cleanup();
  }
});

test("branches: list, switch, check out a remote branch, refuse bad names and unmerged deletes", async () => {
  const { work, clone, cleanup } = repos();
  try {
    assert.equal((await gitCreateBranch(work, "bad name")).ok, false);
    assert.ok((await gitCreateBranch(work, "topic")).ok);
    writeFileSync(join(work, "topic.txt"), "topic\n");
    run(work, "add", "topic.txt");
    run(work, "commit", "-q", "-m", "Topic");
    run(work, "push", "-q", "-u", "origin", "topic");
    run(work, "tag", "v1.0.0");

    const refs = await gitRefs(work);
    const find = (name: string, type: string) => refs.find((ref) => ref.name === name && ref.type === type);
    assert.ok(find("topic", "head")?.current);
    assert.equal(find("main", "head")?.current, false);
    assert.ok(find("origin/topic", "remote"));
    assert.ok(find("v1.0.0", "tag"));
    assert.equal(find("topic", "head")?.subject, "Topic");
    assert.ok(!refs.some((ref) => ref.name.endsWith("/HEAD")));

    // A branch with commits nowhere else is kept unless forced.
    assert.ok((await gitCreateBranch(work, "wip")).ok);
    run(work, "commit", "-q", "--allow-empty", "-m", "WIP");
    assert.ok((await gitCheckout(work, "main")).ok);
    const deleted = await gitDeleteBranch(work, "wip");
    assert.equal(deleted.ok, false);
    assert.equal(deleted.notMerged, true);
    assert.ok((await gitDeleteBranch(work, "wip", true)).ok);
    assert.ok((await gitDeleteBranch(work, "topic")).ok);

    // A remote branch checks out a local branch that tracks it.
    assert.ok((await gitCheckout(work, "origin/topic", "remote")).ok);
    const status = await gitStatus(work);
    assert.equal(status.branch, "topic");
    assert.equal(status.upstream, "origin/topic");

    assert.ok((await gitCheckout(work, "v1.0.0", "tag")).ok);
    assert.equal((await gitStatus(work)).branch, "(detached)");

    // Creating from a start point.
    const other = clone("other");
    assert.ok((await gitCreateBranch(other, "from-topic", "origin/topic")).ok);
    assert.equal(await gitShow(other, "HEAD", join(other, "topic.txt")), "topic\n");
  } finally {
    cleanup();
  }
});

test("history: the log, a file's log across renames, and a commit's files", async () => {
  const { work, cleanup } = repos();
  try {
    run(work, "mv", "a.txt", "renamed.txt");
    run(work, "commit", "-q", "-m", "Rename\n\nWith a body.");
    writeFileSync(join(work, "renamed.txt"), "one\ntwo\nthree\nfour\n");
    writeFileSync(join(work, "c.txt"), "c\n");
    run(work, "add", "-A");
    run(work, "commit", "-q", "-m", "Edit");

    const log = await gitLog(work);
    assert.deepEqual(
      log.map((commit) => commit.subject),
      ["Edit", "Rename", "First"],
    );
    assert.equal(log[1]!.body, "With a body.");
    assert.equal(log[0]!.author, "Ada");
    assert.equal(log[0]!.parents.length, 1);
    assert.deepEqual(log[0]!.refs, [{ name: "main", type: "head", current: true }]);
    // origin/main stays where the first push left it.
    assert.deepEqual(log[2]!.refs, [{ name: "origin/main", type: "remote" }]);
    assert.equal((await gitLog(work, { limit: 1, skip: 1 }))[0]!.subject, "Rename");

    const history = await gitLog(work, { path: join(work, "renamed.txt") });
    assert.deepEqual(
      history.map((commit) => commit.subject),
      ["Edit", "Rename", "First"],
    );

    const edited = await gitCommitFiles(work, log[0]!.hash);
    assert.deepEqual(edited.map((file) => [file.status, file.relativePath]).sort(), [
      ["A", "c.txt"],
      ["M", "renamed.txt"],
    ]);
    const renamed = await gitCommitFiles(work, log[1]!.hash);
    assert.equal(renamed[0]!.status, "R");
    assert.equal(renamed[0]!.oldPath, join(work, "a.txt"));
    // The first commit lists everything it added.
    assert.deepEqual(
      (await gitCommitFiles(work, log[2]!.hash)).map((file) => file.status),
      ["A"],
    );

    // The parent's version and the index's version of a file.
    assert.equal(await gitShow(work, `${log[0]!.hash}^`, join(work, "renamed.txt")), "one\ntwo\nthree\n");
    assert.equal(await gitShow(work, `${log[0]!.hash}^`, join(work, "c.txt")), null);
    writeFileSync(join(work, "c.txt"), "staged\n");
    run(work, "add", "c.txt");
    assert.equal(await gitShow(work, "", join(work, "c.txt")), "staged\n");
  } finally {
    cleanup();
  }
});

test("blame: the commit of every line, unsaved edits as not committed", async () => {
  const { work, cleanup } = repos();
  try {
    run(work, "config", "user.name", "Grace");
    writeFileSync(join(work, "a.txt"), "one\nTWO\nthree\n");
    run(work, "commit", "-q", "-am", "Shout two");
    const path = join(work, "a.txt");

    const blame = (await gitBlame(work, path))!;
    assert.equal(blame.lines.length, 3);
    const authors = blame.lines.map((hash) => blame.commits[hash]!.author);
    assert.deepEqual(authors, ["Ada", "Grace", "Ada"]);
    assert.equal(blame.commits[blame.lines[1]!]!.summary, "Shout two");
    assert.equal(blame.commits[blame.lines[0]!]!.summary, "First");
    assert.ok(blame.commits[blame.lines[0]!]!.date > 0);

    const unsaved = (await gitBlame(work, path, "zero\none\nTWO\nthree\n"))!;
    assert.equal(unsaved.lines.length, 4);
    assert.equal(unsaved.lines[0], UNCOMMITTED);
    assert.equal(unsaved.commits[unsaved.lines[2]!]!.summary, "Shout two");

    assert.equal(await gitBlame(work, join(work, "missing.txt")), null);
  } finally {
    cleanup();
  }
});

test("the diff editor's git documents name a ref and a path, Windows drive letters included", () => {
  assert.equal(gitUri("D:\\repo\\a.ts", "HEAD"), "lumen-git:HEAD:D:\\repo\\a.ts");
  assert.deepEqual(parseGitUri(gitUri("D:\\repo\\a.ts", "abc123^")), { ref: "abc123^", path: "D:\\repo\\a.ts" });
  // The index has an empty ref.
  assert.deepEqual(parseGitUri(gitUri("/home/me/a.ts", "")), { ref: "", path: "/home/me/a.ts" });
  assert.equal(parseGitUri("D:\\repo\\a.ts"), null);
});
