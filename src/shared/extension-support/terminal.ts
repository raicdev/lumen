import type { AreaSupport } from "./types.ts";

/** Support table changes of the "terminal" area. */
export const terminalSupport: AreaSupport = {
  api: {
    "window.createTerminal": [
      "supported",
      "name, cwd, shell options, env, message, location (panel, split, editor view column / preserveFocus), icon/color, shellIntegrationNonce and pseudo-terminals",
    ],
    "window.onDidChangeTerminalState": ["supported", "fires on first user input and when the shell type is known"],
    "window.onDidChangeTerminalShellIntegration": ["supported", "bash, zsh, fish and PowerShell via injected OSC 633 scripts (the shells VS Code integrates)"],
    "window.onDidStartTerminalShellExecution": [
      "supported",
      "bash, zsh, fish and PowerShell; typed command lines are trusted / High when the per-terminal nonce matches",
    ],
    "window.onDidEndTerminalShellExecution": ["supported", "bash, zsh, fish and PowerShell"],
    "window.registerTerminalLinkProvider": "supported",
    "window.registerTerminalProfileProvider": ["supported", "needs contributes.terminal.profiles; shown in 'Create New Terminal (With Extension Profile)'"],
    "window.onDidChangeTextEditorViewColumn": ["supported", "fires when an editor moves between groups; TextEditor.viewColumn is the group's column"],
    "window.registerTerminalQuickFixProvider": ["supported", "proposed API; fixes of finished shell-integrated commands show as a lightbulb in the terminal"],
  },
  types: ["TerminalProfile", "TerminalLink", "TerminalShellExecutionCommandLineConfidence", "TerminalQuickFixTerminalCommand", "TerminalQuickFixOpener"],
  contributions: {
    terminal: ["supported", "profiles and quickFixes (command line / output / exit code matchers; needs shell integration, as in VS Code)"],
  },
};
