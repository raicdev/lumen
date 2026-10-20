import type { AreaSupport } from "./types.ts";

/** Support table changes of the "workspace-misc" area. */
export const workspaceMiscSupport: AreaSupport = {
  api: {
    "workspace.saveAs": "supported",
    "workspace.decode": ["partial", "any encoding the platform decodes; honors files.encoding and BOMs"],
    "workspace.encode": ["partial", "UTF-8, UTF-16, ASCII, Latin-1 and Windows-1252 only"],
    "workspace.updateWorkspaceFolders": ["partial", "extra folders are visible to extensions but not shown in the explorer; the first folder is opened in the window"],
    "env.isAppPortable": "supported",
    "env.openExternal": ["supported", "http(s) and mailto links; lumen://<extension id>/... URIs go to that extension's URI handler"],
    "window.registerUriHandler": ["partial", "lumen://<extension id>/... via Open URI…, env.openExternal or the command line (other sources ask first); the OS does not register the scheme"],
  },
  types: ["InputBoxValidationSeverity", "QuickInputButtonLocation", "FilePermission", "TelemetryTrustedValue"],
};
