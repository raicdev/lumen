import type { AreaSupport } from "./types.ts";

/** Support table changes of the "scm" area. */
export const scmSupport: AreaSupport = {
  api: {
    "scm.*": null,
    "scm.createSourceControl": ["partial", "Source Control view with input box, groups, count, quick diff, status commands, resource decorations and the scm/* menus; scm/title shows in each provider's header; decorations.color and scm/change/title are not used"],
    "scm.inputBox": ["supported", "input box of the extension's latest source control"],
    "window.withScmProgress": ["supported", "shows a progress bar in the Source Control view"],
  },
};
