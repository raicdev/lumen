import { isMainThread, workerData } from "worker_threads";
import { runWorker, type WorkerKind } from "./workers.ts";

// The same entry serves the app and its worker threads (one bundle when
// packaged). Workers only load what they need: main.ts — and with it the
// native shell — is never imported there. No top-level await: the packaged
// launcher loads this bundle with require(), which rejects async ESM graphs.
const kind = (workerData as { lumenWorker?: WorkerKind } | null)?.lumenWorker;
if (!isMainThread && kind) void runWorker(kind);
else void import("./main.ts");
