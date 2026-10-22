import type { AreaSupport } from "./types.ts";

/** Support table changes of the "workspace-misc" area. */
export const workspaceMiscSupport: AreaSupport = {
  api: {
    "workspace.saveAs": "supported",
    "workspace.decode": ["partial", "BOMs, files.encoding (also per language of an open document) and VS Code's encodings except cp1125 and koi8t; files.autoGuessEncoding is not used"],
    "workspace.encode": ["partial", "the same encodings as decode (characters an encoding cannot hold become ?); files.encoding also per language of an open document"],
    "workspace.updateWorkspaceFolders": ["partial", "extra folders are visible to extensions and in the explorer (extra file: folders and folders of registered file systems); the first folder is opened in the window"],
    "env.isAppPortable": "supported",
    "env.openExternal": ["supported", "http(s) and mailto links; lumen://<extension id>/... URIs go to that extension's URI handler"],
    "window.registerUriHandler": ["supported", "lumen://<extension id>/... from the OS (the Windows installer registers the scheme; a running Lumen receives it), Open URI…, env.openExternal or the command line (other sources ask first)"],
  },
  types: ["InputBoxValidationSeverity", "QuickInputButtonLocation", "FilePermission", "TelemetryTrustedValue"],
};
