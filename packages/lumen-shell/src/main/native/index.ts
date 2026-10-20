import type { Platform } from "./platform.ts";
import { win32Platform } from "./platform-win32.ts";
import { posixPlatform } from "./platform-posix.ts";

// Both backends load their system libraries lazily, so importing them here
// never touches user32.dll on macOS/Linux (or GLib on Windows).
export function platform(): Platform {
  return process.platform === "win32" ? win32Platform : posixPlatform;
}

export type { Platform, MenuGroup, MenuEntry, WindowHooks } from "./platform.ts";
