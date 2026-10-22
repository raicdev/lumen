import type { LumenConfig } from "@lumen/shell/cli";

/** One stylesheet per feature area (src/mainview/features/feature-<area>.css), linked from index.html. */
const FEATURE_AREAS = [
  "tasks",
  "scm",
  "testing",
  "notebooks",
  "authentication",
  "comments",
  "chat-lm",
  "terminal",
  "languages-extra",
  "workspace-misc",
  "icon-themes",
  "theming-contribs",
  "issue-reporter",
  "ports",
  "timeline",
  "menus-walkthroughs",
];

/**
 * Lumen Shell app configuration.
 * See packages/lumen-shell for the framework that consumes this file.
 */
export default {
  app: {
    name: "Lumen",
    identifier: "dev.lumen.editor",
    version: "0.2.0",
  },
  main: "src/main/index.ts",
  view: {
    entry: "src/mainview/index.tsx",
    html: "src/mainview/index.html",
    styles: [
      "src/mainview/index.css",
      "src/mainview/xterm.css",
      "src/mainview/extensions.css",
      ...FEATURE_AREAS.map((area) => `src/mainview/features/feature-${area}.css`),
      // The modern look goes over everything else.
      "src/mainview/modern.css",
    ],
  },
  package: {
    // Rendered from resources/icon.svg.
    icon: "resources/icon.ico",
    publisher: "Lumen Contributors",
    // lumen://<extension id>/... opens in Lumen (window.registerUriHandler).
    protocols: ["lumen"],
  },
} satisfies LumenConfig;
