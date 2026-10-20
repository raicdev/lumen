import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { IPty } from "node-pty";
import { decodeSpawnSpec } from "../shared/terminal-spawn.ts";
import { injectShellIntegration } from "./terminal-integration.ts";

/** Variables a shell still needs when an extension asks for a strict environment (TerminalOptions.strictEnv). */
const STRICT_ENV_KEEP = new Set(["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA"]);

export type TerminalSession = {
  id: string;
  cwd: string;
  shell: string;
  pty: IPty;
  alive: boolean;
  cols: number;
  rows: number;
};

type DataHandler = (id: string, data: string) => void;
type ExitHandler = (id: string, code: number | null) => void;
type PtySpawn = typeof import("node-pty").spawn;

function defaultShell(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoLogo"] };
  }
  const shell = process.env.SHELL || "/bin/bash";
  if (shell.endsWith("bash") || shell.endsWith("zsh") || shell.endsWith("fish")) {
    return { file: shell, args: ["-l"] };
  }
  return { file: shell, args: [] };
}

export type TerminalProfile = { id: string; name: string; file: string; args: string[] };

function findOnPath(exe: string): string | null {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":");
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

let profileCache: TerminalProfile[] | null = null;

/** Shells available on this machine (the first one is the default). */
export function terminalProfiles(): TerminalProfile[] {
  if (profileCache) return profileCache;
  const profiles: TerminalProfile[] = [];
  if (process.platform === "win32") {
    const pwsh = findOnPath("pwsh.exe");
    // Store installs live under WindowsApps, which only allows launching through
    // the app execution alias: start it by name and let PATH resolve it.
    if (pwsh) profiles.push({ id: "pwsh", name: "PowerShell 7", file: pwsh.includes("WindowsApps") ? "pwsh.exe" : pwsh, args: ["-NoLogo"] });
    profiles.push({ id: "powershell", name: "Windows PowerShell", file: "powershell.exe", args: ["-NoLogo"] });
    profiles.push({ id: "cmd", name: "Command Prompt", file: process.env.ComSpec || "cmd.exe", args: [] });
    const gitBash = [
      join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe"),
      join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
      join(process.env.LOCALAPPDATA ?? "", "Programs", "Git", "bin", "bash.exe"),
    ].find((candidate) => existsSync(candidate));
    if (gitBash) profiles.push({ id: "gitbash", name: "Git Bash", file: gitBash, args: ["--login", "-i"] });
    const wsl = findOnPath("wsl.exe");
    if (wsl) profiles.push({ id: "wsl", name: "WSL", file: wsl, args: [] });
  } else {
    const { file, args } = defaultShell();
    profiles.push({ id: "default", name: file.split("/").pop() ?? file, file, args });
    for (const shell of ["bash", "zsh", "fish", "sh"]) {
      const found = findOnPath(shell);
      if (found && found !== file) profiles.push({ id: shell, name: shell, file: found, args: shell === "sh" ? [] : ["-l"] });
    }
  }
  profileCache = profiles;
  return profiles;
}

/**
 * Full PTY terminal sessions via node-pty (ConPTY on Windows).
 * node-pty is loaded on first use so its native addon stays off the startup path.
 */
export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private onData: DataHandler | null = null;
  private onExit: ExitHandler | null = null;
  private seq = 0;
  private ptySpawn: PtySpawn | null = null;
  private loadPromise: Promise<void> | null = null;

  setHandlers(onData: DataHandler, onExit: ExitHandler) {
    this.onData = onData;
    this.onExit = onExit;
  }

  private async ensureLoaded() {
    if (this.ptySpawn) return;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        const mod = await import("node-pty");
        this.ptySpawn = mod.spawn;
      })();
    }
    await this.loadPromise;
  }

  async create(
    cwd?: string,
    size?: { cols?: number; rows?: number },
    profileId?: string,
  ): Promise<{ id: string; cwd: string; shell: string; profile: string; pid: number; nonce?: string }> {
    await this.ensureLoaded();
    if (!this.ptySpawn) throw new Error("PTY module failed to load");

    const id = `term-${++this.seq}-${Date.now().toString(36)}`;
    const workdir = cwd && cwd.length ? cwd : process.cwd() || homedir();
    const cols = size?.cols && size.cols > 0 ? size.cols : 80;
    const rows = size?.rows && size.rows > 0 ? size.rows : 24;
    const profiles = terminalProfiles();
    // An extension's TerminalOptions arrive encoded in the profile id (see shared/terminal-spawn.ts).
    const spec = decodeSpawnSpec(profileId);
    const profile = profiles.find((entry) => entry.id === (spec ? spec.profileId : profileId)) ?? profiles[0]!;
    const file = spec?.shellPath || profile.file;
    let args: string[] | string = spec?.shellArgs ?? (spec?.shellPath ? [] : profile.args);

    let env: Record<string, string> = {};
    const inherited = spec?.strictEnv ? STRICT_ENV_KEEP : null;
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v !== "string") continue;
      if (inherited && !inherited.has(k.toUpperCase())) continue;
      env[k] = v;
    }
    for (const [k, v] of Object.entries(spec?.env ?? {})) {
      if (v === null) delete env[k];
      else if (typeof v === "string") env[k] = v;
    }
    env.TERM = "xterm-256color";
    env.COLORTERM = "truecolor";
    env.TERM_PROGRAM = "Lumen";
    if (!env.FORCE_COLOR) env.FORCE_COLOR = "1";

    // An extension's own nonce (TerminalOptions.shellIntegrationNonce) is kept even without
    // our scripts: its own integration reads it from VSCODE_NONCE, as in VS Code.
    const given = typeof spec?.nonce === "string" && spec.nonce ? spec.nonce : undefined;
    if (given) env.VSCODE_NONCE = given;
    let nonce = given;
    // Shell integration (OSC 633 from bash / zsh / PowerShell) feeds Terminal.shellIntegration.
    if (Array.isArray(args) && spec?.shellIntegration !== false && !process.env.LUMEN_NO_SHELL_INTEGRATION) {
      // Per-terminal secret the integration scripts echo in their E / P sequences.
      const secret = given ?? randomUUID();
      const injected = injectShellIntegration(file, args, { ...env, LUMEN_SHELL_NONCE: secret });
      if (injected) {
        args = injected.args;
        env = injected.env;
        nonce = secret;
      }
    }

    const pty = this.ptySpawn(file, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: workdir,
      env,
      // Use node-pty's bundled ConPTY (conpty.dll + OpenConsole.exe). Its kill
      // path does not fork a helper process, which would relaunch the packaged
      // executable instead of running node-pty's helper script.
      useConptyDll: process.platform === "win32",
    });

    const session: TerminalSession = {
      id,
      cwd: workdir,
      shell: file,
      pty,
      alive: true,
      cols,
      rows,
    };
    this.sessions.set(id, session);

    pty.onData((data) => {
      this.onData?.(id, data);
    });

    pty.onExit(({ exitCode }) => {
      const s = this.sessions.get(id);
      if (s) s.alive = false;
      this.onExit?.(id, exitCode ?? null);
      this.sessions.delete(id);
    });

    return { id, cwd: workdir, shell: file, profile: profile.name, pid: pty.pid, nonce };
  }

  write(id: string, data: string): { ok: boolean } {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return { ok: false };
    try {
      s.pty.write(data);
      return { ok: true };
    } catch (e) {
      console.error("[terminal] write failed", e);
      return { ok: false };
    }
  }

  resize(id: string, cols: number, rows: number): { ok: boolean } {
    const s = this.sessions.get(id);
    if (!s || !s.alive) return { ok: false };
    const c = Math.max(2, Math.floor(cols));
    const r = Math.max(1, Math.floor(rows));
    try {
      s.pty.resize(c, r);
      s.cols = c;
      s.rows = r;
      return { ok: true };
    } catch (e) {
      console.error("[terminal] resize failed", e);
      return { ok: false };
    }
  }

  kill(id: string): { ok: boolean } {
    const s = this.sessions.get(id);
    if (!s) return { ok: false };
    try {
      s.pty.kill();
      s.alive = false;
      this.sessions.delete(id);
      return { ok: true };
    } catch {
      this.sessions.delete(id);
      return { ok: false };
    }
  }

  killAll() {
    for (const id of [...this.sessions.keys()]) {
      this.kill(id);
    }
  }

  list(): string[] {
    return [...this.sessions.keys()];
  }
}

export const terminals = new TerminalManager();
