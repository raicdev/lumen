import { spawnSync } from "child_process";
import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { format } from "util";

/**
 * The main process log (%APPDATA%\Lumen\logs\main.log): errors, warnings and
 * uncaught exceptions. The packaged app has no console, so without it a
 * failure leaves no trace. Kept free of the native shell so it works when
 * that is what failed to load.
 */

const MAX_LOG_BYTES = 1024 * 1024;

export function logPath(appName = "Lumen"): string {
  const base = process.platform === "win32" ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming")) : join(homedir(), ".config");
  return join(base, appName, "logs", "main.log");
}

/** Append a line; the previous log is kept as main.old.log once the file passes 1 MB. */
export function writeLog(level: "error" | "warning" | "fatal", message: string): void {
  const file = logPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, file.replace(/\.log$/, ".old.log"));
    } catch {
      /* no log yet */
    }
    appendFileSync(file, `[${new Date().toISOString()}] ${level}: ${message}\n`);
  } catch {
    /* logging must never fail the app */
  }
}

/** Log uncaught exceptions, unhandled rejections and console errors / warnings of the main process. */
export function installCrashLog(): void {
  process.on("uncaughtException", (error) => {
    writeLog("fatal", `uncaught exception: ${error.stack ?? error.message}`);
    process.stderr.write(`uncaught exception: ${error.stack ?? error.message}\n`);
  });
  process.on("unhandledRejection", (reason) => {
    writeLog("error", `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : format(reason)}`);
  });
  for (const [method, level] of [
    ["error", "error"],
    ["warn", "warning"],
  ] as const) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      writeLog(level, format(...args));
      original(...args);
    };
  }
}

/**
 * Tell the user why Lumen cannot run, without the window (it may be what is
 * missing). Blocks until the message is closed: the process exits right after.
 */
export function showFatalError(message: string, detail: string): void {
  writeLog("fatal", `${message} ${detail}`);
  if (process.platform !== "win32") {
    process.stderr.write(`${message}\n${detail}\n`);
    return;
  }
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const script = `Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.MessageBox]::Show(${quote(`${message}\n\n${detail}`)}, 'Lumen', 'OK', 'Error')`;
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true });
}
