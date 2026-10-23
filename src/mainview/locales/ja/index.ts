import { app } from "./app";
import { commands } from "./commands";
import { dialogs } from "./dialogs";
import { settings } from "./settings";
import { views } from "./views";

/** Japanese (日本語): English text → translation. Later groups win when the same text appears twice. */
export const ja: Readonly<Record<string, string>> = { ...commands, ...settings, ...views, ...dialogs, ...app };
