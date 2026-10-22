import { app, autoUpdater, type UpdateRelease as ShellUpdateRelease } from "@lumen/shell/main";
import type { UpdateMode, UpdateRelease, UpdateState } from "../shared/types.ts";

/** The first background check waits for startup to settle. */
const FIRST_CHECK_DELAY = 30_000;
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;

export type UpdateServiceOptions = {
  publish: (state: UpdateState) => void;
  /** Close the window (asking about unsaved changes); false when the user cancelled. */
  quit: () => Promise<boolean>;
};

function summary(release: ShellUpdateRelease): UpdateRelease {
  return { version: release.version, title: release.title, notes: release.notes, url: release.url };
}

/**
 * Lumen's own updates (see autoUpdater in Lumen Shell): checks GitHub
 * Releases as `update.mode` says, downloads a newer setup in the background
 * and installs it when the user restarts to update. Every change of state goes
 * to the view, which shows the notifications.
 */
export class UpdateService {
  #state: UpdateState = { kind: "idle" };
  #mode: UpdateMode | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  /** Whether Help > Check for Updates asked during the current run. */
  #manual = false;
  #file: string | null = null;
  readonly #options: UpdateServiceOptions;

  constructor(options: UpdateServiceOptions) {
    this.#options = options;
  }

  get state(): UpdateState {
    return this.#state;
  }

  /** Schedule the background checks of `update.mode` (dev runs never check on their own). */
  configure(mode: UpdateMode): void {
    if (mode === this.#mode) return;
    this.#mode = mode;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (mode === "default" && app.packaged) this.#schedule(FIRST_CHECK_DELAY);
  }

  #schedule(delay: number): void {
    this.#timer = setTimeout(() => {
      this.#schedule(CHECK_INTERVAL);
      void this.check(false);
    }, delay);
    this.#timer.unref?.();
  }

  /** Check now (unless a check or download is under way) and download what is found. */
  async check(manual: boolean): Promise<UpdateState> {
    if (manual) {
      this.#manual = true;
      // Report what is going on (again) instead of starting over.
      if (this.#running || this.#state.kind === "ready") this.#set({ ...this.#state, manual: true } as UpdateState);
    }
    if (this.#running) {
      await this.#running;
      return this.#state;
    }
    if (this.#state.kind === "ready") return this.#state;
    this.#manual = manual;
    this.#running = this.#run().finally(() => (this.#running = null));
    await this.#running;
    return this.#state;
  }

  async #run(): Promise<void> {
    this.#set({ kind: "checking", manual: this.#manual });
    try {
      const found = await autoUpdater.check();
      if (!found) {
        this.#set({ kind: "upToDate", manual: this.#manual });
        await autoUpdater.cleanup();
        return;
      }
      const release = summary(found);
      if (!autoUpdater.canInstall || !found.installer) {
        this.#set({ kind: "available", release, manual: this.#manual });
        return;
      }
      this.#set({ kind: "downloading", release, percent: null, manual: this.#manual });
      let shown: number | null = null;
      this.#file = await autoUpdater.download(found, (received, total) => {
        const percent = total ? Math.min(100, Math.floor((received * 100) / total)) : null;
        if (percent === shown) return;
        shown = percent;
        this.#set({ kind: "downloading", release, percent, manual: this.#manual });
      });
      this.#set({ kind: "ready", release, manual: this.#manual });
    } catch (error) {
      this.#set({ kind: "error", message: error instanceof Error ? error.message : String(error), manual: this.#manual });
    }
  }

  /** Quit and start the downloaded setup, which installs the update and starts Lumen again. */
  async install(): Promise<{ ok: boolean; error?: string }> {
    if (this.#state.kind !== "ready" || !this.#file) return { ok: false, error: "No update has been downloaded yet." };
    const file = this.#file;
    if (!(await this.#options.quit())) return { ok: false };
    try {
      autoUpdater.install(file, { relaunch: true });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  #set(state: UpdateState): void {
    this.#state = state;
    this.#options.publish(state);
  }
}
