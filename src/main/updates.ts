import { app, autoUpdater, type UpdateRelease as ShellUpdateRelease } from "@lumen/shell/main";
import { existsSync } from "fs";
import type { UpdateChannel, UpdateMode, UpdateRelease, UpdateState } from "../shared/types.ts";

/** The first background check waits for startup to settle. */
const FIRST_CHECK_DELAY = 30_000;
/** After switching the channel, its releases are looked at soon. */
const CHANNEL_CHECK_DELAY = 5_000;
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
 * Releases as `update.mode` and `update.channel` say, downloads a newer setup in the background
 * and installs it when the user restarts to update. Every change of state goes
 * to the view, which shows the notifications.
 */
export class UpdateService {
  #state: UpdateState = { kind: "idle" };
  #mode: UpdateMode | null = null;
  #channel: UpdateChannel | null = null;
  /** Bumped when the channel changes: what a check of the other channel finds is dropped. */
  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running: Promise<void> | null = null;
  #runningGeneration = 0;
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

  /**
   * Schedule the background checks of `update.mode` (dev runs never check on
   * their own) on the releases of `update.channel`. Switching the channel drops
   * what the other channel found or downloaded.
   */
  configure(mode: UpdateMode, channel: UpdateChannel): void {
    const switched = this.#channel !== null && channel !== this.#channel;
    if (mode === this.#mode && !switched) return;
    this.#mode = mode;
    this.#channel = autoUpdater.channel = channel;
    if (switched) {
      this.#generation++;
      this.#file = null;
      this.#set({ kind: "idle" });
      void autoUpdater.cleanup();
    }
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (mode === "default" && app.packaged) this.#schedule(switched ? CHANNEL_CHECK_DELAY : FIRST_CHECK_DELAY);
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
    while (this.#running) {
      // A check of the channel left behind does not answer for this one.
      const stale = this.#runningGeneration !== this.#generation;
      await this.#running;
      if (!stale) return this.#state;
    }
    if (this.#state.kind === "ready") return this.#state;
    this.#manual = manual;
    this.#runningGeneration = this.#generation;
    this.#running = this.#run().finally(() => (this.#running = null));
    await this.#running;
    return this.#state;
  }

  async #run(): Promise<void> {
    const generation = this.#generation;
    const current = () => generation === this.#generation;
    const set = (state: UpdateState) => current() && this.#set(state);
    set({ kind: "checking", manual: this.#manual });
    try {
      const found = await autoUpdater.check();
      if (!current()) return;
      if (!found) {
        set({ kind: "upToDate", manual: this.#manual });
        await autoUpdater.cleanup();
        return;
      }
      const release = summary(found);
      if (!autoUpdater.canInstall || !found.installer) {
        set({ kind: "available", release, manual: this.#manual });
        return;
      }
      set({ kind: "downloading", release, percent: null, manual: this.#manual });
      let shown: number | null = null;
      const file = await autoUpdater.download(found, (received, total) => {
        const percent = total ? Math.min(100, Math.floor((received * 100) / total)) : null;
        if (percent === shown) return;
        shown = percent;
        set({ kind: "downloading", release, percent, manual: this.#manual });
      });
      if (!current()) return;
      this.#file = file;
      set({ kind: "ready", release, manual: this.#manual });
    } catch (error) {
      set({ kind: "error", message: error instanceof Error ? error.message : String(error), manual: this.#manual });
    }
  }

  /** Quit and start the downloaded setup, which installs the update and starts Lumen again. */
  async install(): Promise<{ ok: boolean; error?: string }> {
    if (this.#state.kind !== "ready" || !this.#file) return { ok: false, error: "No update has been downloaded yet." };
    const file = this.#file;
    // Checked while the window is still there to say so: after quitting nobody would see the error.
    if (!autoUpdater.canInstall) return { ok: false, error: "This copy of Lumen cannot install updates." };
    if (!existsSync(file)) {
      this.#file = null;
      this.#set({ kind: "idle" });
      return { ok: false, error: "The downloaded update was removed (for example by disk cleanup). Check for updates to download it again." };
    }
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
