import type { FeatureApi, FeatureContext, FeatureNamespace, HostFeature } from "./contract.ts";
import { FEATURE_NAMESPACES } from "./contract.ts";
import { tasksFeature } from "./tasks.ts";
import { scmFeature } from "./scm.ts";
import { testingFeature } from "./testing.ts";
import { notebooksFeature } from "./notebooks.ts";
import { authenticationFeature } from "./authentication.ts";
import { commentsFeature } from "./comments.ts";
import { chatLmFeature } from "./chat-lm.ts";
import { terminalFeature } from "./terminal.ts";
import { languagesExtraFeature } from "./languages-extra.ts";
import { workspaceMiscFeature } from "./workspace-misc.ts";
import { iconThemesFeature } from "./icon-themes.ts";
import { themingContribsFeature } from "./theming-contribs.ts";
import { issueReporterFeature } from "./issue-reporter.ts";
import { portsFeature } from "./ports.ts";
import { timelineFeature } from "./timeline.ts";
import { menusWalkthroughsFeature, setMenuArgFeatures } from "./menus-walkthroughs.ts";

export * from "./contract.ts";

/** Registered features, in order (a later feature overrides an earlier one on a clash). */
export const hostFeatures: readonly HostFeature[] = [
  tasksFeature,
  scmFeature,
  testingFeature,
  notebooksFeature,
  authenticationFeature,
  commentsFeature,
  chatLmFeature,
  terminalFeature,
  languagesExtraFeature,
  workspaceMiscFeature,
  iconThemesFeature,
  themingContribsFeature,
  issueReporterFeature,
  portsFeature,
  timelineFeature,
  menusWalkthroughsFeature,
];

/** The feature API of one extension: members per namespace, merged over all features. */
export function buildFeatureApi(ctx: FeatureContext): Record<FeatureNamespace, PropertyDescriptorMap> {
  const merged = Object.fromEntries(FEATURE_NAMESPACES.map((name) => [name, {} as PropertyDescriptorMap])) as Record<FeatureNamespace, PropertyDescriptorMap>;
  for (const feature of hostFeatures) {
    let api: FeatureApi | undefined;
    try {
      api = feature.api?.(ctx);
    } catch (error) {
      ctx.host.log("error", `feature '${feature.area}' failed to build its API: ${error instanceof Error ? error.message : String(error)}`, ctx.extensionId);
    }
    if (!api) continue;
    for (const name of FEATURE_NAMESPACES) {
      const members = api[name];
      if (members) Object.assign(merged[name], Object.getOwnPropertyDescriptors(members));
    }
  }
  return merged;
}

/** Top-level exports of all features. */
export function featureTypes(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const feature of hostFeatures) Object.assign(out, feature.types);
  return out;
}

export function featureByArea(area: string): HostFeature | undefined {
  return hostFeatures.find((feature) => feature.area === area);
}

/** All built-in command ids features handle. */
export function featureCommandIds(): string[] {
  return hostFeatures.flatMap((feature) => feature.commands ?? []);
}

// `{ $ref }` arguments of menu commands are revived by the feature of their area.
setMenuArgFeatures(featureByArea);
