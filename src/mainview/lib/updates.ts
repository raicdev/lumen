import type { UpdateState } from "../../shared/types";
import { api } from "./rpc";
import { getSettings, onSettingsChange } from "./settings";
import { notify, showProgress, toast } from "./toast";

/**
 * Lumen's own updates in the view: hands `update.mode` and `update.channel` to the main process
 * (which checks GitHub Releases and downloads) and turns its update states
 * into notifications. Background checks stay quiet until an update is ready;
 * Help > Check for Updates reports every step.
 */

/** showProgress id; extensions' progress ids count up from 0. */
const PROGRESS_ID = -1;

let state: UpdateState = { kind: "idle" };
/** Notifications already shown for a background check in this session (`ready:1.2.3`). */
const told = new Set<string>();

export function updateState(): UpdateState {
  return state;
}

function openReleasePage(url: string): void {
  if (url) void api().request.openExternal({ url });
}

/** Help > Check for Updates. */
export function checkForUpdates(): void {
  if (getSettings()["update.mode"] === "none") {
    void notify("info", "Updates are turned off (update.mode is none).");
    return;
  }
  void api().request.updateCheck({});
}

/** Quit (unsaved changes are asked about first), install the downloaded update and start again. */
export async function restartToUpdate(): Promise<void> {
  // The window closes before the answer arrives when it works.
  const result = await api()
    .request.updateInstall({})
    .catch(() => ({ ok: true, error: undefined }));
  if (!result.ok && result.error) void notify("error", `Could not install the update: ${result.error}`);
}

/** Show a background check's news once; what Check for Updates finds always. */
function firstTime(next: UpdateState & { manual: boolean }, key: string): boolean {
  if (told.has(key) && !next.manual) return false;
  told.add(key);
  return true;
}

async function show(next: UpdateState): Promise<void> {
  state = next;
  if (next.kind !== "downloading" || !next.manual) showProgress(PROGRESS_ID, { done: true });
  switch (next.kind) {
    case "checking":
      if (next.manual) toast("Checking for updates…");
      return;
    case "upToDate":
      if (next.manual) void notify("info", "There are currently no updates available.");
      return;
    case "available": {
      if (!firstTime(next, `available:${next.release.version}`)) return;
      const choice = await notify("info", `Lumen ${next.release.version} is available. Download it from the release page.`, ["Download", "Later"]);
      if (choice === 0) openReleasePage(next.release.url);
      return;
    }
    case "downloading":
      if (next.manual) showProgress(PROGRESS_ID, { title: `Downloading Lumen ${next.release.version}`, percent: next.percent ?? undefined });
      return;
    case "ready": {
      if (!firstTime(next, `ready:${next.release.version}`)) return;
      const choice = await notify("info", `Lumen ${next.release.version} has been downloaded. Restart Lumen to update.`, [
        "Restart to Update",
        "Release Notes",
        "Later",
      ]);
      if (choice === 0) await restartToUpdate();
      else if (choice === 1) openReleasePage(next.release.url);
      return;
    }
    case "error":
      if (next.manual) void notify("error", `Could not update Lumen: ${next.message}`);
      else console.warn("[update]", next.message);
      return;
  }
}

/** Start following the main process's update state and keep it told about `update.mode` and `update.channel`. */
export function startUpdates(): void {
  window.addEventListener("lumen:update-state", (event) => void show((event as CustomEvent<UpdateState>).detail));
  let mode = getSettings()["update.mode"];
  let channel = getSettings()["update.channel"];
  const configure = () =>
    api()
      .request.updateConfigure({ mode, channel })
      .then(({ state: current }) => {
        // A reloaded view catches up with an update that is ready already.
        if (current.kind === "ready" || current.kind === "available") void show({ ...current, manual: false });
        else state = current;
      })
      .catch(() => undefined);
  void configure();
  onSettingsChange(() => {
    const settings = getSettings();
    if (settings["update.mode"] === mode && settings["update.channel"] === channel) return;
    mode = settings["update.mode"];
    channel = settings["update.channel"];
    void configure();
  });
}
