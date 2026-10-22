import type { ViewFeature, ViewFeatureApi } from "./types";
import { activeColorTheme, onColorThemeChange } from "../lib/theme";
import { setSemanticTokenContributions } from "../lib/ext-semantic-tokens";
import { collectColorContributions, collectSemanticContributions, colorCustomizationsFor, colorsCss, defaultColorFor } from "../../shared/theming-contribs";

/**
 * Window side of the "theming-contribs" area: contributes.colors become
 * `--vscode-<id>` CSS variables (default for the theme kind, overridden by the
 * color theme and by workbench.colorCustomizations), so ThemeColor ids resolve
 * in decorations, status bar items, tree icons and webviews; the semantic token
 * contributions go to lib/ext-semantic-tokens.ts.
 */

const STYLE_ID = "lumen-contributed-colors";

function styleElement(): HTMLStyleElement {
  let element = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!element) {
    element = document.createElement("style");
    element.id = STYLE_ID;
    document.head.appendChild(element);
  }
  return element;
}

let current: ViewFeatureApi | null = null;
let signature = "";

function apply(api: ViewFeatureApi) {
  const extensions = api.getExtensions();
  const colors = collectColorContributions(extensions);
  let css = "";
  try {
    const theme = activeColorTheme();
    css = colorsCss({
      colors,
      kind: theme.kind,
      themeColors: theme.colors,
      customizations: colorCustomizationsFor(api.getExtensionSetting("workbench.colorCustomizations"), theme),
    });
  } catch {
    /* no theme yet: applied on the first theme change */
  }
  styleElement().textContent = css;
  // Only a changed contribution list reaches the semantic token plug-in (it re-requests tokens).
  const semantic = collectSemanticContributions(extensions);
  const next = JSON.stringify(semantic);
  if (next !== signature) {
    signature = next;
    setSemanticTokenContributions(semantic);
  }
}

export const themingContribsView: ViewFeature = {
  area: "theming-contribs",
  init(api) {
    current = api;
    onColorThemeChange(() => current && apply(current));
    api.onSettingsChange(() => apply(api));
  },
  onHostReady(api) {
    current = api;
    apply(api);
  },
  commands: [
    {
      id: "lumen.theming.showContributedColors",
      title: "Show Extension Colors",
      category: "Developer",
      enabled: (api) => collectColorContributions(api.getExtensions()).length > 0,
      async run(api) {
        const colors = collectColorContributions(api.getExtensions());
        const kind = activeColorTheme().kind;
        await api.showQuickPick(
          colors.map((color) => ({ label: color.id, description: defaultColorFor(color, kind) ?? "no default", detail: color.description || undefined })),
          {
            title: "Colors contributed by extensions",
            placeholder: "Use them with new ThemeColor(id) or workbench.colorCustomizations",
            matchOnDescription: true,
            matchOnDetail: true,
          },
        );
      },
    },
  ],
};
