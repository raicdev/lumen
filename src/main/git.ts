import { execFile } from "child_process";
import { rm } from "fs/promises";
import { join, normalize, relative } from "path";
import type { GitFileStatus, GitStatus } from "../shared/types.ts";

/**
 * Source control through the `git` CLI (no libgit2 binding needed): status,
 * stage / unstage / discard and commit — what the Source Control view uses.
 */

type GitResult = { code: number; stdout: string; stderr: string };

function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || (error && !stdout ? error.message : "") });
    });
  });
}

function failure(result: GitResult): string {
  return (result.stderr || result.stdout).trim().split(/\r?\n/).slice(0, 6).join("\n") || "git failed";
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

export async function gitStatus(root: string): Promise<GitStatus> {
  const empty: GitStatus = { isRepo: false, root: null, branch: null, ahead: 0, behind: 0, files: [] };
  const top = await toplevel(root);
  if (!top) return empty;

  const result = await git(root, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]);
  if (result.code !== 0) return { ...empty, isRepo: true, root: top, error: failure(result) };

  const status: GitStatus = { isRepo: true, root: top, branch: null, ahead: 0, behind: 0, files: [] };
  const records = result.stdout.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    if (record.startsWith("## ")) {
      const header = record.slice(3);
      const noCommits = /^No commits yet on (.+)$/.exec(header);
      if (noCommits) status.branch = noCommits[1]!;
      else status.branch = header.split("...")[0]!.split(" ")[0]!;
      if (status.branch === "HEAD") status.branch = "(detached)";
      status.ahead = Number(/ahead (\d+)/.exec(header)?.[1] ?? 0);
      status.behind = Number(/behind (\d+)/.exec(header)?.[1] ?? 0);
      continue;
    }
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
  return status;
}

export async function gitStage(root: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
  const result = await gitPaths(root, ["add", "-A"], paths);
  return result.code === 0 ? { ok: true } : { ok: false, error: failure(result) };
}

export async function gitUnstage(root: string, paths: string[]): Promise<{ ok: boolean; error?: string }> {
  let result = await gitPaths(root, ["reset", "-q", "HEAD"], paths);
  // A repository without commits has no HEAD to reset to.
  if (result.code !== 0) result = await gitPaths(root, ["rm", "--cached", "-q", "-r"], paths);
  return result.code === 0 ? { ok: true } : { ok: false, error: failure(result) };
}

export async function gitDiscard(root: string, files: { path: string; untracked: boolean }[]): Promise<{ ok: boolean; error?: string }> {
  for (const file of files.filter((entry) => entry.untracked)) {
    try {
      await rm(file.path, { force: true, recursive: true });
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const tracked = files.filter((entry) => !entry.untracked).map((entry) => entry.path);
  if (!tracked.length) return { ok: true };
  const result = await gitPaths(root, ["checkout", "-q"], tracked);
  return result.code === 0 ? { ok: true } : { ok: false, error: failure(result) };
}

export async function gitCommit(root: string, message: string, stageAll = false): Promise<{ ok: boolean; error?: string }> {
  if (stageAll) {
    const staged = await git(root, ["add", "-A"]);
    if (staged.code !== 0) return { ok: false, error: failure(staged) };
  }
  const result = await git(root, ["commit", "-q", "-m", message]);
  return result.code === 0 ? { ok: true } : { ok: false, error: failure(result) };
}

/** The committed (HEAD) version of a file, for diffs. `null` when it is new. */
export async function gitShowHead(root: string, path: string): Promise<string | null> {
  const top = await toplevel(root);
  if (!top) return null;
  const rel = relative(top, path).replace(/\\/g, "/");
  const result = await git(root, ["show", `HEAD:${rel}`]);
  return result.code === 0 ? result.stdout : null;
}
