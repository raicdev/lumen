import { execFile } from "child_process";
import { existsSync } from "fs";
import { rm } from "fs/promises";
import { dirname, join, normalize, relative } from "path";
import type { GitBlame, GitChangedFile, GitCommitInfo, GitFileStatus, GitRef, GitStatus } from "../shared/types.ts";

/**
 * Source control through the `git` CLI (no libgit2 binding needed): status,
 * stage / unstage / discard and commit, fetch / pull / push, branches, history
 * and blame — what the Source Control view, the status bar and the editor use.
 */

type GitResult = { code: number; stdout: string; stderr: string };
export type GitOutcome = { ok: boolean; error?: string };

/** The id git gives lines that are not committed yet (blame). */
export const UNCOMMITTED = "0".repeat(40);

function git(cwd: string, args: string[], options: { input?: string; timeout?: number } = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
        timeout: options.timeout ?? 0,
        // Missing credentials fail the command instead of waiting for a terminal prompt nobody sees.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr: stderr || (error && !stdout ? error.message : "") });
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

function failure(result: GitResult): string {
  return (result.stderr || result.stdout).trim().split(/\r?\n/).slice(0, 6).join("\n") || "git failed";
}

function outcome(result: GitResult): GitOutcome {
  return result.code === 0 ? { ok: true } : { ok: false, error: failure(result) };
}

/** Run `git` on many paths without exceeding the command line limit. */
async function gitPaths(cwd: string, args: string[], paths: string[]): Promise<GitResult> {
  let last: GitResult = { code: 0, stdout: "", stderr: "" };
  for (let i = 0; i < paths.length; i += 100) {
    last = await git(cwd, [...args, "--", ...paths.slice(i, i + 100)]);
    if (last.code !== 0) return last;
  }
  return last;
}

async function toplevel(root: string): Promise<string | null> {
  const result = await git(root, ["rev-parse", "--show-toplevel"]);
  return result.code === 0 ? normalize(result.stdout.trim()) : null;
}

/** A path as git names it inside the repository (`src/a.ts`). */
async function repoPath(root: string, path: string): Promise<{ top: string; rel: string } | null> {
  const top = await toplevel(root);
  return top ? { top, rel: relative(top, path).replace(/\\/g, "/") } : null;
}

export async function gitStatus(root: string): Promise<GitStatus> {
  const empty: GitStatus = { isRepo: false, root: null, branch: null, upstream: null, hasRemote: false, ahead: 0, behind: 0, files: [] };
  const top = await toplevel(root);
  if (!top) return empty;

  const [result, remotes] = await Promise.all([git(root, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]), gitRemotes(root)]);
  const hasRemote = remotes.length > 0;
  if (result.code !== 0) return { ...empty, isRepo: true, root: top, hasRemote, error: failure(result) };

  const status: GitStatus = { isRepo: true, root: top, branch: null, upstream: null, hasRemote, ahead: 0, behind: 0, files: [] };
  const records = result.stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    if (record.startsWith("## ")) Object.assign(status, parseBranchHeader(record.slice(3)));
    else {
      const index = record[0]!;
      const worktree = record[1]!;
      const file = record.slice(3);
      // Renames and copies are followed by the original path.
      if (index === "R" || index === "C") i++;
      const path = normalize(join(top, file));
      const entry: GitFileStatus = {
        path,
        relativePath: relative(root, path).replace(/\\/g, "/"),
        index,
        worktree,
      };
      status.files.push(entry);
    }
  }
  return status;
}

/** The `## main...origin/main [ahead 1, behind 2]` line of `git status -b`. */
export function parseBranchHeader(header: string): Pick<GitStatus, "branch" | "upstream" | "ahead" | "behind"> {
  const noCommits = /^No commits yet on (.+)$/.exec(header) ?? /^Initial commit on (.+)$/.exec(header);
  if (noCommits) return { branch: noCommits[1]!, upstream: null, ahead: 0, behind: 0 };
  const space = header.indexOf(" ");
  const name = space < 0 ? header : header.slice(0, space);
  const rest = space < 0 ? "" : header.slice(space + 1);
  const [local, upstream] = name.split("...");
  let branch = local!;
  // `HEAD (no branch)`: a detached HEAD.
  if (branch === "HEAD") branch = "(detached)";
  return {
    branch,
    upstream: upstream ?? null,
    ahead: Number(/ahead (\d+)/.exec(rest)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(rest)?.[1] ?? 0),
  };
}

export async function gitStage(root: string, paths: string[]): Promise<GitOutcome> {
  return outcome(await gitPaths(root, ["add", "-A"], paths));
}

export async function gitUnstage(root: string, paths: string[]): Promise<GitOutcome> {
  let result = await gitPaths(root, ["reset", "-q", "HEAD"], paths);
  // A repository without commits has no HEAD to reset to.
  if (result.code !== 0) result = await gitPaths(root, ["rm", "--cached", "-q", "-r"], paths);
  return outcome(result);
}

export async function gitDiscard(root: string, files: { path: string; untracked: boolean }[]): Promise<GitOutcome> {
  for (const file of files.filter((entry) => entry.untracked)) {
    try {
      await rm(file.path, { force: true, recursive: true });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const tracked = files.filter((entry) => !entry.untracked).map((entry) => entry.path);
  if (!tracked.length) return { ok: true };
  return outcome(await gitPaths(root, ["checkout", "-q"], tracked));
}

export async function gitCommit(root: string, message: string, stageAll = false): Promise<GitOutcome> {
  if (stageAll) {
    const staged = await git(root, ["add", "-A"]);
    if (staged.code !== 0) return { ok: false, error: failure(staged) };
  }
  return outcome(await git(root, ["commit", "-q", "-m", message]));
}

/** The committed (HEAD) version of a file, for diffs. `null` when it is new. */
export async function gitShowHead(root: string, path: string): Promise<string | null> {
  return await gitShow(root, "HEAD", path);
}

/**
 * A file as `ref` has it: a commit (`HEAD`, a hash, `abc123^`) or, with an empty
 * ref, the index. `null` when the file does not exist there.
 */
export async function gitShow(root: string, ref: string, path: string): Promise<string | null> {
  // A deleted file's folder may be gone too: ask from the closest folder that exists.
  while (!existsSync(root) && dirname(root) !== root) root = dirname(root);
  const where = await repoPath(root, path);
  if (!where) return null;
  const result = await git(root, ["show", `${ref}:${where.rel}`]);
  return result.code === 0 ? result.stdout : null;
}

/* ── remotes ───────────────────────────────────────────────────────────── */

/** Network commands give up after five minutes instead of hanging the view. */
const NETWORK_TIMEOUT = 5 * 60 * 1000;

export async function gitRemotes(root: string): Promise<string[]> {
  const result = await git(root, ["remote"]);
  return result.code === 0 ? result.stdout.split(/\r?\n/).filter(Boolean) : [];
}

export async function gitFetch(root: string): Promise<GitOutcome> {
  return outcome(await git(root, ["fetch", "--all", "--prune"], { timeout: NETWORK_TIMEOUT }));
}

export async function gitPull(root: string): Promise<GitOutcome> {
  return outcome(await git(root, ["pull"], { timeout: NETWORK_TIMEOUT }));
}

/**
 * Push the current branch. A branch without an upstream is published to
 * `remote` (default: `origin`, else the only remote) and tracks it from then on.
 */
export async function gitPush(root: string, remote?: string): Promise<GitOutcome> {
  const status = await gitStatus(root);
  if (status.upstream) return outcome(await git(root, ["push"], { timeout: NETWORK_TIMEOUT }));
  if (!status.branch || status.branch === "(detached)") return { ok: false, error: "There is no branch to push (detached HEAD)." };
  const remotes = await gitRemotes(root);
  const target = remote ?? (remotes.includes("origin") ? "origin" : remotes[0]);
  if (!target) return { ok: false, error: "This repository has no remote to push to." };
  return outcome(await git(root, ["push", "-u", target, status.branch], { timeout: NETWORK_TIMEOUT }));
}

/** Pull, then push: what the status bar's sync button does. */
export async function gitSync(root: string): Promise<GitOutcome> {
  const status = await gitStatus(root);
  if (status.upstream) {
    const pulled = await gitPull(root);
    if (!pulled.ok) return pulled;
  }
  return await gitPush(root);
}

/* ── branches ──────────────────────────────────────────────────────────── */

/** Local branches, remote branches and tags, most recently committed first. */
export async function gitRefs(root: string): Promise<GitRef[]> {
  const format = ["%(refname)", "%(objectname:short)", "%(HEAD)", "%(upstream:short)", "%(committerdate:unix)", "%(contents:subject)"].join("%00");
  const result = await git(root, ["for-each-ref", "--sort=-committerdate", `--format=${format}`, "refs/heads", "refs/remotes", "refs/tags"]);
  if (result.code !== 0) return [];
  return parseRefs(result.stdout);
}

export function parseRefs(output: string): GitRef[] {
  const refs: GitRef[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [refname = "", commit = "", head = "", upstream = "", date = "", subject = ""] = line.split("\0");
    const kinds: [string, GitRef["type"]][] = [
      ["refs/heads/", "head"],
      ["refs/remotes/", "remote"],
      ["refs/tags/", "tag"],
    ];
    const kind = kinds.find(([prefix]) => refname.startsWith(prefix));
    if (!kind) continue;
    const name = refname.slice(kind[0].length);
    // `origin/HEAD` points at a remote's default branch: not a branch of its own.
    if (kind[1] === "remote" && name.endsWith("/HEAD")) continue;
    refs.push({
      name,
      type: kind[1],
      commit,
      current: head === "*",
      upstream: upstream || undefined,
      date: Number(date) * 1000 || undefined,
      subject: subject || undefined,
    });
  }
  return refs;
}

/**
 * Switch to a branch, tag or commit. A remote branch (`origin/feature`) checks
 * out the local branch of the same name, created to track it when missing.
 */
export async function gitCheckout(root: string, ref: string, type: GitRef["type"] = "head"): Promise<GitOutcome> {
  if (type === "remote") {
    const local = ref.slice(ref.indexOf("/") + 1);
    const exists = await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${local}`]);
    if (exists.code === 0) return outcome(await git(root, ["checkout", "-q", local]));
    return outcome(await git(root, ["checkout", "-q", "--track", ref]));
  }
  if (type === "tag") return outcome(await git(root, ["checkout", "-q", "--detach", `refs/tags/${ref}`]));
  return outcome(await git(root, ["checkout", "-q", ref]));
}

/** Create a branch from `from` (default: HEAD) and switch to it. */
export async function gitCreateBranch(root: string, name: string, from?: string): Promise<GitOutcome> {
  const valid = await git(root, ["check-ref-format", "--branch", name]);
  if (valid.code !== 0) return { ok: false, error: `“${name}” is not a valid branch name.` };
  return outcome(await git(root, ["checkout", "-q", "-b", name, ...(from ? [from] : [])]));
}

/** Delete a local branch. Without `force`, a branch with unmerged commits is kept (`notMerged`). */
export async function gitDeleteBranch(root: string, name: string, force = false): Promise<GitOutcome & { notMerged?: boolean }> {
  const result = await git(root, ["branch", force ? "-D" : "-d", name]);
  if (result.code === 0) return { ok: true };
  return { ok: false, error: failure(result), notMerged: /not fully merged/i.test(result.stderr) };
}

/* ── history ───────────────────────────────────────────────────────────── */

const LOG_FORMAT = ["%H", "%h", "%P", "%an", "%ae", "%at", "%D", "%s", "%b"].join("%x00") + "%x1e";

/** Commits reachable from HEAD, newest first; with `path`, the commits that changed that file (following renames). */
export async function gitLog(root: string, options: { path?: string; limit?: number; skip?: number } = {}): Promise<GitCommitInfo[]> {
  // Full ref names tell local branches (refs/heads/) from remote ones (refs/remotes/).
  const args = ["log", "--decorate=full", `--format=${LOG_FORMAT}`, `-n${options.limit ?? 50}`, `--skip=${options.skip ?? 0}`];
  if (options.path) {
    const where = await repoPath(root, options.path);
    if (!where) return [];
    args.push("--follow", "--", where.rel);
  }
  const result = await git(root, args);
  return result.code === 0 ? parseLog(result.stdout) : [];
}

/**
 * `%D` with --decorate=full: `HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1`.
 * A bare `HEAD` (detached) and `origin/HEAD` are left out.
 */
export function parseDecorations(decorations: string): GitCommitInfo["refs"] {
  const refs: GitCommitInfo["refs"] = [];
  for (let entry of decorations.split(", ")) {
    const current = entry.startsWith("HEAD -> ");
    entry = entry.replace(/^HEAD -> /, "").replace(/^tag: /, "");
    const kind = (
      [
        ["refs/heads/", "head"],
        ["refs/remotes/", "remote"],
        ["refs/tags/", "tag"],
      ] as const
    ).find(([prefix]) => entry.startsWith(prefix));
    if (!kind) continue;
    const name = entry.slice(kind[0].length);
    if (kind[1] === "remote" && name.endsWith("/HEAD")) continue;
    refs.push({ name, type: kind[1], ...(current ? { current } : {}) });
  }
  return refs;
}

export function parseLog(output: string): GitCommitInfo[] {
  const commits: GitCommitInfo[] = [];
  for (const record of output.split("\x1e")) {
    const fields = record.replace(/^\r?\n/, "").split("\0");
    if (fields.length < 9) continue;
    const [hash, shortHash, parents, author, email, time, refs, subject, ...body] = fields;
    commits.push({
      hash: hash!,
      shortHash: shortHash!,
      parents: parents ? parents.split(" ") : [],
      author: author!,
      email: email!,
      date: Number(time) * 1000,
      refs: parseDecorations(refs!),
      subject: subject!,
      body: body.join("\0").trim(),
    });
  }
  return commits;
}

/** The files a commit changed, compared with its first parent (everything, for the first commit). */
export async function gitCommitFiles(root: string, hash: string): Promise<GitChangedFile[]> {
  const top = await toplevel(root);
  if (!top) return [];
  const result = await git(root, ["diff-tree", "-r", "-z", "-M", "--root", "--no-commit-id", "--name-status", "--first-parent", "-m", hash]);
  if (result.code !== 0) return [];
  return parseNameStatus(result.stdout).map((file) => ({
    status: file.status,
    path: normalize(join(top, file.path)),
    relativePath: relative(root, join(top, file.path)).replace(/\\/g, "/"),
    oldPath: file.oldPath ? normalize(join(top, file.oldPath)) : undefined,
  }));
}

/** `--name-status -z` output: `M\0path\0`, renames and copies as `R100\0old\0new\0`. */
export function parseNameStatus(output: string): { status: string; path: string; oldPath?: string }[] {
  const fields = output.split("\0");
  const files: { status: string; path: string; oldPath?: string }[] = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]!;
    if (!/^[A-Z]\d*$/.test(code)) continue;
    const status = code[0]!;
    if (status === "R" || status === "C") {
      files.push({ status, oldPath: fields[i + 1]!, path: fields[i + 2]! });
      i += 2;
    } else {
      files.push({ status, path: fields[i + 1]! });
      i += 1;
    }
  }
  return files;
}

/* ── blame ─────────────────────────────────────────────────────────────── */

/**
 * Who last changed each line. With `content` (the editor's unsaved text), lines
 * are those of that text, and edited ones belong to {@link UNCOMMITTED}.
 */
export async function gitBlame(root: string, path: string, content?: string): Promise<GitBlame | null> {
  const where = await repoPath(root, path);
  if (!where) return null;
  const args = ["blame", "--porcelain", ...(content !== undefined ? ["--contents", "-"] : []), "--", where.rel];
  const result = await git(where.top, args, { input: content });
  return result.code === 0 ? parseBlame(result.stdout) : null;
}

export function parseBlame(output: string): GitBlame {
  const blame: GitBlame = { commits: {}, lines: [] };
  let current: string | null = null;
  let line = 0;
  for (const text of output.split("\n")) {
    if (text.startsWith("\t")) {
      if (current) blame.lines[line - 1] = current;
      continue;
    }
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(text);
    if (header) {
      current = header[1]!;
      line = Number(header[2]);
      blame.commits[current] ??= { author: "", email: "", date: 0, summary: "" };
      continue;
    }
    if (!current) continue;
    const commit = blame.commits[current]!;
    const space = text.indexOf(" ");
    const key = space < 0 ? text : text.slice(0, space);
    const value = space < 0 ? "" : text.slice(space + 1).replace(/\r$/, "");
    if (key === "author") commit.author = value;
    else if (key === "author-mail") commit.email = value.replace(/^<|>$/g, "");
    else if (key === "author-time") commit.date = Number(value) * 1000;
    else if (key === "summary") commit.summary = value;
  }
  return blame;
}
