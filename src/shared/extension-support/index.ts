import { tasksSupport } from "./tasks.ts";
import { scmSupport } from "./scm.ts";
import { testingSupport } from "./testing.ts";
import { notebooksSupport } from "./notebooks.ts";
import { authenticationSupport } from "./authentication.ts";
import { commentsSupport } from "./comments.ts";
import { chatLmSupport } from "./chat-lm.ts";
import { terminalSupport } from "./terminal.ts";
import { languagesExtraSupport } from "./languages-extra.ts";
import { workspaceMiscSupport } from "./workspace-misc.ts";
import { iconThemesSupport } from "./icon-themes.ts";
import { themingContribsSupport } from "./theming-contribs.ts";
import { issueReporterSupport } from "./issue-reporter.ts";
import { portsSupport } from "./ports.ts";
import { timelineSupport } from "./timeline.ts";
import { menusWalkthroughsSupport } from "./menus-walkthroughs.ts";
import type { AreaSupport } from "./types.ts";

export type { AreaSupport, SupportEntry } from "./types.ts";

export const AREA_SUPPORT: AreaSupport[] = [
  tasksSupport,
  scmSupport,
  testingSupport,
  notebooksSupport,
  authenticationSupport,
  commentsSupport,
  chatLmSupport,
  terminalSupport,
  languagesExtraSupport,
  workspaceMiscSupport,
  iconThemesSupport,
  themingContribsSupport,
  issueReporterSupport,
  portsSupport,
  timelineSupport,
  menusWalkthroughsSupport,
];
