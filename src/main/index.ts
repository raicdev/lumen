import { isMainThread, workerData } from "worker_threads";
import { runWorker, type WorkerKind } from "./workers.ts";
import { ensureNodeOnPath } from "./node-path.ts";
import { installCrashLog, logPath, showFatalError } from "./crash-log.ts";

// The same entry serves the app and its worker threads (one bundle when
// packaged). Workers only load what they need: main.ts — and with it the
// native shell — is never imported there. No top-level await: the packaged
// launcher loads this bundle with require(), which rejects async ESM graphs.
const kind = (workerData as { lumenWorker?: WorkerKind } | null)?.lumenWorker;
if (!isMainThread && kind) void runWorker(kind);
else {
  installCrashLog();
  // Before any worker starts: they copy this environment.
  ensureNodeOnPath();
  import("./main.ts").catch((error: unknown) => {
    // E.g. the native shell library is missing or broken.
    showFatalError(
      "Lumen could not start.",
      `${error instanceof Error ? error.message : String(error)}\n\nDetails are in ${logPath()}. Reinstalling Lumen may help.`,
    );
    process.exit(1);
  });
}
