import type { AreaSupport } from "./types.ts";

/** Support table changes of the "terminal" area. */
export const terminalSupport: AreaSupport = {
  api: {
    "window.createTerminal": ["supported", "name, cwd, shell options, env, message, location (panel, split, editor view column / preserveFocus), icon/color, shellIntegrationNonce and pseudo-terminals"],
    "window.onDidChangeTerminalState": ["supported", "fires on first user input and when the shell type is known"],
    "window.onDidChangeTerminalShellIntegration": ["partial", "bash, zsh and PowerShell via injected OSC 633 scripts; other shells never fire"],
    "window.onDidStartTerminalShellExecution": ["partial", "bash, zsh and PowerShell only; typed command lines have at most Medium confidence (no nonce)"],
    "window.onDidEndTerminalShellExecution": ["partial", "bash, zsh and PowerShell only"],
    "window.registerTerminalLinkProvider": "supported",
    "window.registerTerminalProfileProvider": ["supported", "needs contributes.terminal.profiles; shown in 'Create New Terminal (With Extension Profile)'"],
    "window.onDidChangeTextEditorViewColumn": ["partial", "fires when an editor moves between groups; TextEditor.viewColumn still reports One"],
  },
  types: ["TerminalProfile", "TerminalLink", "TerminalShellExecutionCommandLineConfidence"],
  contributions: {
    terminal: ["partial", "terminal.profiles only; quickFixes ignored"],
  },
};
