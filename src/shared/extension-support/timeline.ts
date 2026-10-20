import type { AreaSupport } from "./types.ts";

/** Support table changes of the "timeline" area. */
export const timelineSupport: AreaSupport = {
  api: {
    "workspace.registerTimelineProvider": ["supported", "proposed API; the Timeline section of the Explorer, with Lumen's own Git History source"],
    "workspace.registerWorkspaceTimelineProvider": ["supported", "proposed API; shown when no file is active"],
  },
  types: ["TimelineItem", "TimelineTriggerKind"],
};
