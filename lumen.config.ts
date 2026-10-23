import type { LumenConfig } from "@lumen/shell/cli";

/**
 * Lumen Shell app configuration.
 * See packages/lumen-shell for the framework that consumes this file.
 */
export default {
  app: {
    name: "Lumen",
    identifier: "dev.lumen.editor",
    version: "0.3.0-beta.6",
  },
  main: "src/main/index.ts",
  view: {
    entry: "src/mainview/index.tsx",
    html: "src/mainview/index.html",
    styles: [
      // Imports the rest of the UI's stylesheets (styles/, features/…).
      "src/mainview/index.css",
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
