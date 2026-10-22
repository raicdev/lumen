import { existsSync } from "fs";
import { join } from "path";

type Env = Record<string, string | undefined>;

/** The PATH key as spelled in env (Windows keeps "Path"; a plain copy of process.env is case-sensitive). */
function pathKey(env: Env): string {
  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
}

/** Where Node.js version managers and installers keep node.exe, most specific first. */
export function nodeInstallDirs(env: Env): string[] {
  const dirs: (string | undefined)[] = [
    // nvm-windows: a symlink to the active version.
    env.NVM_SYMLINK,
    // fnm: the default alias (its per-shell "multishell" links are gone once the shell exits).
    env.FNM_DIR ? join(env.FNM_DIR, "aliases", "default") : undefined,
    env.APPDATA ? join(env.APPDATA, "fnm", "aliases", "default") : undefined,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "fnm", "aliases", "default") : undefined,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Volta", "bin") : undefined,
    env.ProgramFiles ? join(env.ProgramFiles, "nodejs") : undefined,
    env["ProgramFiles(x86)"] ? join(env["ProgramFiles(x86)"], "nodejs") : undefined,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Programs", "nodejs") : undefined,
    ...["nodejs", "nodejs-lts"].map((app) => {
      const scoop = env.SCOOP ?? (env.USERPROFILE ? join(env.USERPROFILE, "scoop") : undefined);
      return scoop ? join(scoop, "apps", app, "current") : undefined;
    }),
  ];
  return dirs.filter((dir): dir is string => !!dir);
}

/**
 * Apps started from the Start menu or Explorer get the PATH stored in the
 * registry, not the one a shell profile builds, and version managers such as
 * fnm only put node on the latter. Package-manager shims
 * (node_modules/.bin/*.cmd) and extensions then cannot start `node`: oxlint's
 * language server, for one, exits at once. When no node.exe is on PATH, add
 * an installed Node.js at the end of it, for the workers and child processes
 * that inherit this environment. Returns the directory added, if any.
 */
export function ensureNodeOnPath(env: Env = process.env, platform: string = process.platform): string | null {
  if (platform !== "win32") return null;
  const key = pathKey(env);
  const entries = (env[key] ?? "").split(";").filter(Boolean);
  const onPath = entries.some((entry) => {
    const dir = entry.replace(/%([^%]+)%/g, (whole, name: string) => env[name] ?? whole);
    return existsSync(join(dir, "node.exe"));
  });
  if (onPath) return null;
  const found = nodeInstallDirs(env).find((dir) => existsSync(join(dir, "node.exe")));
  if (!found) return null;
  env[key] = [...entries, found].join(";");
  return found;
}
