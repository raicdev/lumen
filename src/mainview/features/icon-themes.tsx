import { updateSetting } from "../lib/settings";
import {
  FILE_ICON_THEME_SETTING,
  PRODUCT_ICON_THEME_SETTING,
  applyFileIconTheme,
  applyProductIconTheme,
  bindIconThemes,
  configuredTheme,
  contributedIconThemes,
  watchIconThemeInputs,
} from "./icon-themes-state";
import type { ViewFeature, ViewFeatureApi } from "./types";

/**
 * Window side of the "icon-themes" area: the "Preferences: File Icon Theme" and
 * "Preferences: Product Icon Theme" pickers and the loading of the selected
 * themes (workbench.iconTheme / workbench.productIconTheme). The host reads the
 * theme files and their images and fonts; FileIcon and Codicon render them.
 */

let stopWatching: (() => void) | null = null;

function reload(api: ViewFeatureApi): void {
  bindIconThemes(api);
  void applyFileIconTheme(api, true);
  void applyProductIconTheme(api, true);
}

async function pick(api: ViewFeatureApi, kind: "file" | "product"): Promise<void> {
  const themes = contributedIconThemes(api.getExtensions(), kind);
  const setting = kind === "file" ? FILE_ICON_THEME_SETTING : PRODUCT_ICON_THEME_SETTING;
  const current = configuredTheme(setting);
  const none = kind === "file" ? "None" : "Default";
  const items = [
    { label: none, description: kind === "file" ? "Built-in file icons" : "Built-in icons", picked: !current },
    ...themes.map((theme) => ({ label: theme.label, description: theme.extensionId, picked: theme.id === current || theme.label === current })),
  ];
  const picked = await api.showQuickPick(items, {
    title: kind === "file" ? "Select File Icon Theme" : "Select Product Icon Theme",
    placeholder: kind === "file" ? "Select File Icon Theme" : "Select Product Icon Theme",
  });
  const index = picked?.[0];
  if (index === undefined) return;
  // The Settings type has no icon theme keys; the store keeps any key.
  (updateSetting as (key: string, value: string) => void)(setting, index === 0 ? "" : themes[index - 1]!.id);
}

export const iconThemesView: ViewFeature = {
  area: "icon-themes",
  init: (api) => {
    stopWatching?.();
    stopWatching = watchIconThemeInputs(api);
  },
  onHostReady: (api) => reload(api),
  commands: [
    { id: "workbench.action.selectIconTheme", title: "File Icon Theme", category: "Preferences", run: (api) => void pick(api, "file") },
    { id: "workbench.action.selectProductIconTheme", title: "Product Icon Theme", category: "Preferences", run: (api) => void pick(api, "product") },
  ],
};
