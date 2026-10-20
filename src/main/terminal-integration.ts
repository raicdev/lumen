import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";

/**
 * Shell integration scripts (bash, zsh, PowerShell). They make the shell emit
 * VS Code's OSC 633 sequences (prompt start / end, command line, execution
 * start, exit code, cwd) that the terminal view parses into the extension API's
 * `Terminal.shellIntegration` and execution events.
 *
 * The scripts are written once to `~/.lumen/shell-integration` and loaded by
 * the shell through an rcfile / ZDOTDIR / `-Command` argument, so the user's
 * own startup files still run.
 */

export type ShellKind = "bash" | "zsh" | "pwsh";

/** String.raw cannot hold a literal `${`: scripts write `@{` where a shell parameter expansion is meant. */
const sh = (text: string) => text.replaceAll("@{", "${");

export const BASH_SCRIPT = sh(String.raw`# Lumen shell integration for bash
[ -n "$__lumen_integration" ] && return
__lumen_integration=1
__lumen_nonce="$LUMEN_SHELL_NONCE"

__lumen_esc() {
  local s="$1" out="" i c
  for ((i = 0; i < @{#s}; i++)); do
    c="@{s:i:1}"
    if [[ "$c" == "\\" ]]; then out+='\\'
    elif [[ "$c" == ";" ]]; then out+='\x3b'
    elif [[ "$c" == [[:cntrl:]] ]]; then out+="$(builtin printf '\\x%02x' "'$c")"
    else out+="$c"; fi
  done
  builtin printf '%s' "$out"
}

__lumen_ready=1
__lumen_running=""

__lumen_preexec() {
  [[ -n "$COMP_LINE" ]] && return
  [[ -z "$__lumen_ready" ]] && return
  case "$BASH_COMMAND" in __lumen_*) return ;; esac
  __lumen_ready=""
  __lumen_running=1
  local line
  line="$(HISTTIMEFORMAT= builtin history 1 | sed 's/^ *[0-9]* *//')"
  builtin printf '\e]633;E;%s;%s\a\e]633;C\a' "$(__lumen_esc "$line")" "$__lumen_nonce"
}

__lumen_precmd() {
  local status=$?
  if [[ -n "$__lumen_running" ]]; then builtin printf '\e]633;D;%s\a' "$status"; fi
  __lumen_running=""
  if [[ "$(declare -p __lumen_orig_pc 2>/dev/null)" == "declare -a"* ]]; then
    local cmd
    for cmd in "@{__lumen_orig_pc[@]}"; do (exit "$status"); eval "$cmd"; done
  elif [[ -n "$__lumen_orig_pc" ]]; then
    (exit "$status"); eval "$__lumen_orig_pc"
  fi
  builtin printf '\e]633;P;Cwd=%s;%s\a' "$(__lumen_esc "$PWD")" "$__lumen_nonce"
  if [[ "$PS1" != *'633;A'* ]]; then PS1='\[\e]633;A\a\]'"$PS1"'\[\e]633;B\a\]'; fi
  __lumen_ready=1
}

if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then __lumen_orig_pc=("@{PROMPT_COMMAND[@]}"); else __lumen_orig_pc="$PROMPT_COMMAND"; fi
PROMPT_COMMAND=__lumen_precmd
trap '__lumen_preexec' DEBUG
`);

export const ZSH_SCRIPT = sh(String.raw`# Lumen shell integration for zsh
[[ -n "$__lumen_integration" ]] && return
__lumen_integration=1
__lumen_nonce="$LUMEN_SHELL_NONCE"

__lumen_esc() {
  local s="$1" out="" i c
  for ((i = 1; i <= @{#s}; i++)); do
    c="@{s[i]}"
    if [[ "$c" == "\\" ]]; then out+='\\'
    elif [[ "$c" == ";" ]]; then out+='\x3b'
    elif [[ "$c" == [[:cntrl:]] ]]; then out+="$(builtin printf '\\x%02x' "'$c")"
    else out+="$c"; fi
  done
  builtin print -rn -- "$out"
}

__lumen_running=""
__lumen_preexec() {
  __lumen_running=1
  builtin printf '\e]633;E;%s;%s\a\e]633;C\a' "$(__lumen_esc "$1")" "$__lumen_nonce"
}
__lumen_precmd() {
  local status=$?
  if [[ -n "$__lumen_running" ]]; then builtin printf '\e]633;D;%s\a' "$status"; fi
  __lumen_running=""
  builtin printf '\e]633;P;Cwd=%s;%s\a' "$(__lumen_esc "$PWD")" "$__lumen_nonce"
  if [[ "$PS1" != *'633;A'* ]]; then PS1=$'%{\e]633;A\a%}'"$PS1"$'%{\e]633;B\a%}'; fi
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec __lumen_preexec
add-zsh-hook precmd __lumen_precmd
`);

const ZSH_FORWARD = (name: string) => `# Lumen: load the user's ${name}, then keep our ZDOTDIR
__lumen_zdotdir="$ZDOTDIR"
if [[ -n "$USER_ZDOTDIR" && -f "$USER_ZDOTDIR/${name}" ]]; then ZDOTDIR="$USER_ZDOTDIR"; . "$USER_ZDOTDIR/${name}"; fi
ZDOTDIR="$__lumen_zdotdir"
`;

const ZSH_RC = `# Lumen: load the user's .zshrc, then the integration
__lumen_zdotdir="$ZDOTDIR"
if [[ -n "$USER_ZDOTDIR" && -f "$USER_ZDOTDIR/.zshrc" ]]; then ZDOTDIR="$USER_ZDOTDIR"; . "$USER_ZDOTDIR/.zshrc"; fi
ZDOTDIR="$__lumen_zdotdir"
. "$__lumen_zdotdir/lumen-integration.zsh"
`;

const BASH_RC = `# Lumen: emulate a login shell's startup, then the integration
if [ -r /etc/profile ]; then . /etc/profile; fi
if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"
elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"
elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"
elif [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
. "$LUMEN_SHELL_INTEGRATION_DIR/lumen-integration.bash"
`;

export const PWSH_SCRIPT = String.raw`# Lumen shell integration for PowerShell
if ($Global:__LumenState) { return }
$Global:__LumenState = @{ OriginalPrompt = $function:prompt; LastHistoryId = -1; Nonce = $env:LUMEN_SHELL_NONCE }

function Global:__Lumen-Escape([string]$Value) {
  $sb = [System.Text.StringBuilder]::new()
  foreach ($c in $Value.ToCharArray()) {
    if ($c -eq '\') { [void]$sb.Append('\\') }
    elseif ($c -eq ';' -or [int]$c -lt 32) { [void]$sb.Append(('\x{0:x2}' -f [int]$c)) }
    else { [void]$sb.Append($c) }
  }
  $sb.ToString()
}

function Global:prompt {
  $ok = $?
  $native = $global:LASTEXITCODE
  $code = if ($ok) { 0 } elseif ($native -is [int] -and $native -ne 0) { $native } else { 1 }
  $esc = [char]0x1b
  $bel = [char]7
  $last = Get-History -Count 1
  $out = ""
  if ($Global:__LumenState.LastHistoryId -ne -1) {
    if ($last -and $last.Id -ne $Global:__LumenState.LastHistoryId) { $out += "$esc]633;D;$code$bel" }
    else { $out += "$esc]633;D$bel" }
  }
  if ($last) { $Global:__LumenState.LastHistoryId = $last.Id } else { $Global:__LumenState.LastHistoryId = 0 }
  $out += "$esc]633;P;Cwd=$(__Lumen-Escape $PWD.ProviderPath);$($Global:__LumenState.Nonce)$bel"
  $out += "$esc]633;A$bel"
  $out += & $Global:__LumenState.OriginalPrompt
  $out += "$esc]633;B$bel"
  $global:LASTEXITCODE = $native
  $out
}

if (Get-Module PSReadLine) {
  $Global:__LumenState.OriginalReadLine = $function:PSConsoleHostReadLine
  if ($Global:__LumenState.OriginalReadLine) {
    function Global:PSConsoleHostReadLine {
      $line = & $Global:__LumenState.OriginalReadLine
      $esc = [char]0x1b
      $bel = [char]7
      [Console]::Write("$esc]633;E;$(__Lumen-Escape $line);$($Global:__LumenState.Nonce)$bel$esc]633;C$bel")
      $line
    }
  }
}
`;

/** Which integration a shell executable gets (null: none). */
export function shellKindOf(file: string): ShellKind | null {
  const name = basename(file).toLowerCase().replace(/\.exe$/, "");
  if (name === "bash") return "bash";
  if (name === "zsh") return "zsh";
  if (name === "pwsh" || name === "powershell") return "pwsh";
  return null;
}

function integrationDir(): string {
  return join(homedir(), ".lumen", "shell-integration");
}

function writeIfChanged(path: string, content: string) {
  try {
    if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  } catch {
    // rewrite below
  }
  writeFileSync(path, content, "utf8");
}

let writtenDir: string | null = null;

/** Write the scripts (once per process); returns their directory. */
export function ensureIntegrationScripts(): string {
  const dir = integrationDir();
  if (writtenDir === dir) return dir;
  mkdirSync(join(dir, "zsh"), { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // not supported on every file system
  }
  writeIfChanged(join(dir, "lumen-integration.bash"), BASH_SCRIPT);
  writeIfChanged(join(dir, "bash-rcfile.sh"), BASH_RC);
  // Windows PowerShell 5.1 reads a BOM-less file as ANSI: write a BOM.
  writeIfChanged(join(dir, "lumen-integration.ps1"), `﻿${PWSH_SCRIPT}`);
  writeIfChanged(join(dir, "zsh", "lumen-integration.zsh"), ZSH_SCRIPT);
  writeIfChanged(join(dir, "zsh", ".zshenv"), ZSH_FORWARD(".zshenv"));
  writeIfChanged(join(dir, "zsh", ".zprofile"), ZSH_FORWARD(".zprofile"));
  writeIfChanged(join(dir, "zsh", ".zshrc"), ZSH_RC);
  writeIfChanged(join(dir, "zsh", ".zlogin"), ZSH_FORWARD(".zlogin"));
  writtenDir = dir;
  return dir;
}

/** Quote a path for a PowerShell single-quoted string (PowerShell also treats the typographic single quotes as delimiters). */
const psQuote = (value: string) => `'${value.replace(/['‘’‚‛]/g, (quote) => quote + quote)}'`;

/** Arguments after which PowerShell takes the rest of the command line as the command or script parameters. */
const PWSH_COMMAND_FLAGS = new Set(["-command", "-c", "-file", "-f", "-encodedcommand", "-ec", "-e", "-commandwithargs", "-cwa"]);

/**
 * Arguments / environment that make `file` load the integration script, or
 * null when the shell is not supported. `args` are the shell's own arguments
 * (a login flag etc.).
 */
export function injectShellIntegration(
  file: string,
  args: string[],
  env: Record<string, string>,
): { args: string[]; env: Record<string, string> } | null {
  const kind = shellKindOf(file);
  if (!kind) return null;
  let dir: string;
  try {
    dir = ensureIntegrationScripts();
  } catch (error) {
    console.error("[terminal] could not write shell integration scripts", error);
    return null;
  }
  switch (kind) {
    case "bash": {
      const rest = args.filter((arg) => arg !== "-l" && arg !== "--login");
      return { args: ["--rcfile", join(dir, "bash-rcfile.sh"), ...rest], env: { ...env, LUMEN_SHELL_INTEGRATION_DIR: dir } };
    }
    case "zsh":
      return { args, env: { ...env, USER_ZDOTDIR: env.ZDOTDIR || homedir(), ZDOTDIR: join(dir, "zsh") } };
    case "pwsh": {
      // The caller already runs a command or script: appending ours would become its text or parameters.
      if (args.some((arg) => PWSH_COMMAND_FLAGS.has(arg.toLowerCase()))) return null;
      const script = join(dir, "lumen-integration.ps1");
      const rest = args.filter((arg) => arg.toLowerCase() !== "-noexit");
      // Dot-source the script's text as a scriptblock: no need to relax the execution policy for the session.
      const load = `try { . ([scriptblock]::Create([IO.File]::ReadAllText(${psQuote(script)}))) } catch {}`;
      return { args: [...rest, "-NoExit", "-Command", load], env };
    }
  }
}
