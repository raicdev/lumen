import type { AreaSupport } from "./types.ts";

/** Support table changes of the "scm" area. */
export const scmSupport: AreaSupport = {
  api: {
    "scm.*": null,
    "scm.createSourceControl": ["partial", "shown in the Source Control view with input box, groups, count, quick diff and status commands; resource icons and scm/* menus are not rendered"],
    "scm.inputBox": ["supported", "input box of the extension's latest source control"],
    "window.withScmProgress": ["supported", "shows a progress bar in the Source Control view"],
  },
};
