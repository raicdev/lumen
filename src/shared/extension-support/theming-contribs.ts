import type { AreaSupport } from "./types.ts";

/** Support table changes of the "theming-contribs" area. */
export const themingContribsSupport: AreaSupport = {
  contributions: {
    colors: ["partial", "defaults per theme kind become --vscode-* variables that themes and workbench.colorCustomizations override; colorCustomizations is read from the extension settings store"],
    semanticTokenTypes: "supported",
    semanticTokenModifiers: "supported",
    semanticTokenScopes: "supported",
  },
};
