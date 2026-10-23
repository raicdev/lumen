import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fuzzyMatch, fuzzyMatchPath } from "../lib/fuzzy";
import { commandLabel, englishCommandLabel, type Command } from "../lib/commands";
import { t } from "../lib/i18n";
import { SymbolIcon } from "./SymbolIcon";
import { WithCodicons } from "./Codicon";
import { isCtrlHeld } from "../lib/keybindings";
import { FileIcon } from "./FileIcon";
import type { DocumentSymbol } from "../../shared/types";
import { decodeValidation } from "../../shared/workspace-misc";
import type { HostInputBox, HostQuickInputButton, HostQuickPick, HostWorkspaceSymbol } from "../../shared/extensions";

export type PickItem = {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  icon?: ReactNode;
  /** A group title shown above the item. */
  separator?: string;
};

export type QuickInputRequest =
  /** Quick Open: files, `>` commands, `:` line, `@` symbols, `?` help. */
  | { kind: "quick"; value: string }
  /** A one-off list (open recent, language mode, …). */
  | {
      kind: "pick";
      placeholder: string;
      items: PickItem[];
      onPick: (id: string) => void;
      activeId?: string;
      /** The highlighted item changed (e.g. to preview a color theme). */
      onActive?: (id: string) => void;
      /** Closed without picking. */
      onCancel?: () => void;
    }
  /** Free text (e.g. go to line without a document). */
  | { kind: "editors"; paths: string[]; backwards: boolean }
  /** An extension's quick pick (showQuickPick / createQuickPick); updated in place while shown. */
  | {
      kind: "hostPick";
      pick: HostQuickPick;
      /** createQuickPick (stays under the extension's control) rather than showQuickPick. */
      live?: boolean;
      onAccept: (indices: number[]) => void;
      onCancel: () => void;
      onValue?: (value: string) => void;
      onActive?: (indices: number[]) => void;
      /** A title bar button was pressed (QuickInputButton.index). */
      onButton?: (index: number) => void;
      /** An item button was pressed (item index and QuickInputButton.index). */
      onItemButton?: (item: number, index: number) => void;
    }
  /** An extension's input box (showInputBox / createInputBox). */
  | {
      kind: "input";
      id: number;
      options: HostInputBox;
      /** Message from the extension's validator for the current value. */
      validation: string | null;
      onAccept: (value: string) => void;
      onCancel: () => void;
      onValue?: (value: string) => void;
      /** A title bar button was pressed (QuickInputButton.index). */
      onButton?: (index: number) => void;
    };

/** A match in a command's English name: its positions are not the translated label's, so nothing is highlighted. */
const englishMatch = (match: ReturnType<typeof fuzzyMatch>) => (match ? { ...match, indices: [] } : null);

export type FlatSymbol = { symbol: DocumentSymbol; container: string };

type Props = {
  request: QuickInputRequest | null;
  onClose: () => void;
  workspaceRoot: string | null;
  listFiles: () => Promise<string[]>;
  /** Recently opened editors (absolute paths, most recent first). */
  recentEditors: string[];
  commands: Command[];
  keys: Map<string, string>;
  recentCommands: string[];
  lineCount: number | null;
  currentLine: number | null;
  loadSymbols: () => Promise<FlatSymbol[]>;
  /** Workspace symbols matching a query (languages.registerWorkspaceSymbolProvider). */
  loadWorkspaceSymbols: (query: string) => Promise<HostWorkspaceSymbol[]>;
  onOpenFile: (path: string) => void;
  onRunCommand: (id: string) => void;
  onGotoLine: (line: number, column: number) => void;
  onGotoSymbol: (symbol: DocumentSymbol) => void;
  onGotoWorkspaceSymbol: (symbol: HostWorkspaceSymbol) => void;
};

type Row = {
  id: string;
  label: string;
  indices?: number[];
  description?: string;
  hint?: string;
  icon?: ReactNode;
  separator?: string;
  /** Second line (quick pick item detail). */
  detail?: string;
  /** Index into an extension's quick pick items. */
  itemIndex?: number;
  /** Buttons shown on the right of the item (QuickPickItem.buttons). */
  itemButtons?: HostQuickInputButton[];
  run: () => void;
};

/** A quick input button (codicon or image), for the title bar or an item. */
function QuickButton({ button, onClick }: { button: HostQuickInputButton; onClick: () => void }) {
  return (
    <button
      type="button"
      className="quick-input-button"
      title={button.tooltip}
      tabIndex={-1}
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {button.image ? <img src={button.icon} alt="" draggable={false} /> : <WithCodicons text={`$(${button.icon})`} size={14} />}
    </button>
  );
}

function basename(path: string) {
  if (path.startsWith("untitled:")) return path.slice("untitled:".length);
  return path.split(/[/\\]/).pop() ?? path;
}

function relativeTo(root: string | null, path: string) {
  if (path.startsWith("untitled:")) return "";
  if (!root) return path;
  const normalizedRoot = root.replace(/[/\\]+$/, "");
  if (path.toLowerCase().startsWith(normalizedRoot.toLowerCase())) {
    return path.slice(normalizedRoot.length + 1).replace(/\\/g, "/");
  }
  return path;
}

function joinPath(root: string, rel: string) {
  const sep = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[/\\]+$/, "")}${sep}${rel.replace(/\//g, sep)}`;
}

function Highlighted({ text, indices }: { text: string; indices?: number[] }) {
  if (!indices?.length) return <>{text}</>;
  const set = new Set(indices);
  const parts: ReactNode[] = [];
  let buffer = "";
  let marked = false;
  const flush = (key: number) => {
    if (!buffer) return;
    parts.push(marked ? <mark key={key}>{buffer}</mark> : <span key={key}>{buffer}</span>);
    buffer = "";
  };
  for (let i = 0; i < text.length; i++) {
    const isMarked = set.has(i);
    if (isMarked !== marked) {
      flush(i);
      marked = isMarked;
    }
    buffer += text[i];
  }
  flush(text.length);
  return <>{parts}</>;
}

export function QuickInput(props: Props) {
  const { request, onClose } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  const [active, setActive] = useState(0);
  const [files, setFiles] = useState<string[] | null>(null);
  const [symbols, setSymbols] = useState<FlatSymbol[] | null>(null);
  const [workspaceSymbols, setWorkspaceSymbols] = useState<HostWorkspaceSymbol[] | null>(null);
  /** Checked items of a multi-select extension quick pick. */
  const [checked, setChecked] = useState<Set<number>>(new Set());

  // Extension quick picks are updated in place: only a new pick resets the input.
  const requestKey = request?.kind === "hostPick" ? `pick:${request.pick.id}` : request?.kind === "input" ? `input:${request.id}` : request;
  useEffect(() => {
    if (!request) return;
    setValue(
      request.kind === "quick"
        ? request.value
        : request.kind === "hostPick"
          ? (request.pick.value ?? "")
          : request.kind === "input"
            ? (request.options.value ?? "")
            : "",
    );
    setFiles(null);
    setSymbols(null);
    setWorkspaceSymbols(null);
    if (request.kind === "hostPick") {
      const items = request.pick.items;
      setChecked(new Set(request.pick.selectedItems ?? items.flatMap((item, index) => (item.picked ? [index] : []))));
    }
    if (request.kind === "editors") {
      setActive(request.backwards ? Math.max(0, request.paths.length - 1) : Math.min(1, request.paths.length - 1));
    } else if (request.kind === "pick" && request.activeId) {
      setActive(
        Math.max(
          0,
          request.items.findIndex((item) => item.id === request.activeId),
        ),
      );
    } else setActive(0);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      if (request.kind === "quick") {
        const input = inputRef.current;
        input?.setSelectionRange(input.value.length, input.value.length);
      } else if (request.kind === "input") inputRef.current?.select();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const mode =
    request?.kind === "quick"
      ? value[0] === ">"
        ? "commands"
        : value[0] === ":"
          ? "line"
          : value[0] === "@"
            ? "symbols"
            : value[0] === "#"
              ? "workspaceSymbols"
              : value[0] === "?"
                ? "help"
                : "files"
      : null;

  // Lazy data for the current mode.
  useEffect(() => {
    if (mode === "files" && files === null) void props.listFiles().then(setFiles, () => setFiles([]));
    if (mode === "symbols" && symbols === null) void props.loadSymbols().then(setSymbols, () => setSymbols([]));
  }, [mode, files, symbols, props]);

  // Workspace symbols are queried as the user types (debounced ~150 ms).
  const loadWorkspaceSymbolsRef = useRef(props.loadWorkspaceSymbols);
  loadWorkspaceSymbolsRef.current = props.loadWorkspaceSymbols;
  useEffect(() => {
    if (mode !== "workspaceSymbols") return;
    const query = value.slice(1).trim();
    const timer = setTimeout(() => {
      void loadWorkspaceSymbolsRef.current(query).then(setWorkspaceSymbols, () => setWorkspaceSymbols([]));
    }, 150);
    return () => clearTimeout(timer);
  }, [mode, value]);

  const close = onClose;

  const rows: Row[] = useMemo(() => {
    if (!request) return [];
    if (request.kind === "editors") {
      return request.paths.map((path) => ({
        id: path,
        label: basename(path),
        description: relativeTo(props.workspaceRoot, path),
        icon: <FileIcon name={basename(path)} />,
        run: () => props.onOpenFile(path),
      }));
    }
    if (request.kind === "hostPick") {
      const { pick } = request;
      const query = value.trim();
      const rows: Row[] = [];
      let separator: string | undefined;
      pick.items.forEach((item, index) => {
        if (item.separator) {
          separator = item.label || " ";
          return;
        }
        const inLabel = fuzzyMatch(query, item.label.replace(/\$\([\w-]+(~spin)?\)\s*/g, ""));
        const inOther =
          !inLabel &&
          ((pick.matchOnDescription && item.description && fuzzyMatch(query, item.description)) ||
            (pick.matchOnDetail && item.detail && fuzzyMatch(query, item.detail)));
        if (query && !pick.noFilter && !inLabel && !inOther && !item.alwaysShow) return;
        rows.push({
          id: `item:${index}`,
          itemIndex: index,
          label: item.label.replace(/\$\([\w-]+(~spin)?\)\s*/g, ""),
          indices: inLabel?.indices,
          description: item.description,
          detail: item.detail,
          separator,
          itemButtons: item.buttons,
          run: () => request.onAccept([index]),
        });
        separator = undefined;
      });
      return rows;
    }

    if (request.kind === "input") {
      const message = decodeValidation(request.validation)?.message ?? request.options.prompt;
      const hint = t("Press 'Enter' to confirm your input or 'Escape' to cancel");
      return [{ id: "hint", label: message ? `${message}` : hint, description: message ? hint : undefined, run: () => {} }];
    }

    if (request.kind === "pick") {
      const query = value.trim();
      const scored = request.items
        .map((item) => {
          const inLabel = fuzzyMatch(query, item.label);
          const inDescription = !inLabel && item.description ? fuzzyMatch(query, item.description) : null;
          return { item, match: inLabel ?? (inDescription ? { score: inDescription.score - 50, indices: [] } : null) };
        })
        .filter((entry) => !query || entry.match)
        .sort((a, b) => (query ? (b.match?.score ?? 0) - (a.match?.score ?? 0) : 0));
      return scored.map(({ item, match }) => ({
        id: item.id,
        label: item.label,
        indices: match?.indices,
        description: item.description,
        hint: item.detail,
        icon: item.icon,
        separator: query ? undefined : item.separator,
        run: () => request.onPick(item.id),
      }));
    }

    if (mode === "help") {
      return [
        { prefix: "", label: t("Go to File") },
        { prefix: ">", label: t("Show and Run Commands") },
        { prefix: ":", label: t("Go to Line / Column") },
        { prefix: "@", label: t("Go to Symbol in Editor") },
        { prefix: "#", label: t("Go to Symbol in Workspace") },
      ].map((entry) => ({
        id: entry.prefix || "files",
        label: entry.prefix ? `${entry.prefix}  ${entry.label}` : `…  ${entry.label}`,
        run: () => {},
        keep: true,
      })) as Row[];
    }

    if (mode === "line") {
      const match = /^:\s*(\d+)?(?:[:,]\s*(\d+))?/.exec(value);
      const line = match?.[1] ? Number(match[1]) : null;
      const column = match?.[2] ? Number(match[2]) : 1;
      if (props.lineCount === null) return [{ id: "none", label: t("Open a text editor first to go to a line."), run: () => {} }];
      if (!line) {
        return [
          {
            id: "hint",
            label: t("Current Line: {0}. Type a line number between 1 and {1} to navigate to.", props.currentLine ?? 1, props.lineCount),
            run: () => {},
          },
        ];
      }
      const target = Math.min(Math.max(1, line), props.lineCount);
      return [
        {
          id: "goto",
          label: column > 1 ? t("Go to line {0}, character {1}", target, column) : t("Go to line {0}", target),
          run: () => props.onGotoLine(target, column),
        },
      ];
    }

    if (mode === "symbols") {
      const query = value.slice(1).trim();
      if (symbols === null) return [{ id: "loading", label: t("Loading symbols…"), run: () => {} }];
      if (!symbols.length) return [{ id: "none", label: t("No symbols found in this editor."), run: () => {} }];
      return symbols
        .map((entry) => ({ entry, match: fuzzyMatch(query, entry.symbol.name) }))
        .filter((item) => item.match)
        .sort((a, b) => (query ? b.match!.score - a.match!.score : a.entry.symbol.line - b.entry.symbol.line))
        .slice(0, 300)
        .map(({ entry, match }) => {
          return {
            id: `${entry.symbol.name}:${entry.symbol.line}:${entry.symbol.character}`,
            label: entry.symbol.name,
            indices: match!.indices,
            description: entry.container,
            hint: `Ln ${entry.symbol.line + 1}`,
            icon: <SymbolIcon kind={entry.symbol.kind} />,
            run: () => props.onGotoSymbol(entry.symbol),
          };
        });
    }

    if (mode === "workspaceSymbols") {
      if (workspaceSymbols === null) return [{ id: "loading", label: t("Searching symbols…"), run: () => {} }];
      if (!workspaceSymbols.length) return [{ id: "none", label: t("No matching symbols."), run: () => {} }];
      return workspaceSymbols.slice(0, 300).map((symbol) => ({
        id: `workspace-symbol:${symbol.id}`,
        label: symbol.name,
        description: symbol.containerName || relativeTo(props.workspaceRoot, symbol.path),
        hint: symbol.path ? basename(symbol.path) : undefined,
        icon: <SymbolIcon kind={symbol.kind} />,
        run: () => props.onGotoWorkspaceSymbol(symbol),
      }));
    }

    if (mode === "commands") {
      const query = value.slice(1).trim();
      const recent = props.recentCommands;
      const scored = props.commands
        .map((command) => ({ command, label: commandLabel(command), english: englishCommandLabel(command) }))
        // A translated command is also found by its English name (shown beside it), as in VS Code.
        .map((entry) => ({
          ...entry,
          match: fuzzyMatch(query, entry.label) ?? (entry.english !== entry.label ? englishMatch(fuzzyMatch(query, entry.english)) : null),
        }))
        .filter((entry) => entry.match);
      if (query) scored.sort((a, b) => b.match!.score - a.match!.score);
      else {
        const rank = (id: string) => {
          const index = recent.indexOf(id);
          return index < 0 ? Number.MAX_SAFE_INTEGER : index;
        };
        scored.sort((a, b) => rank(a.command.id) - rank(b.command.id) || a.label.localeCompare(b.label));
      }
      return scored.slice(0, 400).map(({ command, label, english, match }, index) => ({
        id: command.id,
        label,
        description: english !== label ? english : undefined,
        indices: match!.indices,
        hint: props.keys.get(command.id),
        separator:
          !query && index === 0 && recent.includes(command.id)
            ? t("recently used")
            : !query && recent.includes(scored[index - 1]?.command.id ?? "") && !recent.includes(command.id)
              ? t("other commands")
              : undefined,
        run: () => props.onRunCommand(command.id),
      }));
    }

    // Files
    const query = value.trim();
    const root = props.workspaceRoot;
    const recentRows: Row[] = props.recentEditors
      .map((path) => ({ path, rel: relativeTo(root, path) }))
      .map(({ path, rel }) => ({ path, rel, match: fuzzyMatchPath(query, rel) }))
      .filter((entry) => entry.match)
      .map(({ path, rel, match }, index) => ({
        id: `recent:${path}`,
        label: basename(path),
        indices: match!.indices.filter((i) => i >= rel.length - basename(path).length).map((i) => i - (rel.length - basename(path).length)),
        description: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
        icon: <FileIcon name={basename(path)} />,
        separator: index === 0 ? t("recently opened") : undefined,
        run: () => props.onOpenFile(path),
      }));
    if (!root) return recentRows;
    if (!query) return recentRows;
    if (files === null) return [...recentRows, { id: "loading", label: t("Searching files…"), run: () => {} }];
    const seen = new Set(props.recentEditors.map((path) => relativeTo(root, path)));
    const fileRows = files
      .filter((rel) => !seen.has(rel))
      .map((rel) => ({ rel, match: fuzzyMatchPath(query, rel) }))
      .filter((entry) => entry.match)
      .sort((a, b) => b.match!.score - a.match!.score)
      .slice(0, 200)
      .map(({ rel, match }, index) => {
        const name = basename(rel);
        const offset = rel.length - name.length;
        return {
          id: rel,
          label: name,
          indices: match!.indices.filter((i) => i >= offset).map((i) => i - offset),
          description: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
          icon: <FileIcon name={name} />,
          separator: index === 0 && recentRows.length ? t("file results") : undefined,
          run: () => props.onOpenFile(joinPath(root, rel)),
        };
      });
    return [...recentRows, ...fileRows];
  }, [request, value, mode, files, symbols, workspaceSymbols, props]);

  // Typing goes back to the first match; a new request keeps the item it highlights (activeId).
  const lastValue = useRef(value);
  useEffect(() => {
    if (lastValue.current === value) return;
    lastValue.current = value;
    if (request?.kind !== "editors") setActive(0);
  }, [value, request?.kind]);

  // Extensions follow what the user types and highlights.
  const hostPick = request?.kind === "hostPick" ? request : null;
  const activeItem = hostPick ? rows[active]?.itemIndex : undefined;
  useEffect(() => {
    if (activeItem !== undefined) hostPick?.onActive?.([activeItem]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeItem]);

  const pickRequest = request?.kind === "pick" ? request : null;
  const activePickId = pickRequest ? rows[active]?.id : undefined;
  useEffect(() => {
    if (activePickId !== undefined) pickRequest?.onActive?.(activePickId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePickId]);

  useEffect(() => {
    listRef.current?.querySelector(".quick-row.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // Ctrl+Tab switcher: releasing Ctrl opens the highlighted editor.
  useEffect(() => {
    if (request?.kind !== "editors") return;
    if (!isCtrlHeld()) {
      // Ctrl was already released (a quick Ctrl+Tab): switch right away.
      const row = rows[active];
      close();
      row?.run();
      return;
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control") {
        const row = rows[active];
        close();
        row?.run();
      }
    };
    window.addEventListener("keyup", onKeyUp, true);
    return () => window.removeEventListener("keyup", onKeyUp, true);
  }, [request, rows, active, close]);

  if (!request) return null;

  /** Escape, a click outside, focus leaving: extensions hear that their input was cancelled. */
  const dismiss = () => {
    if (request.kind === "hostPick" || request.kind === "input") request.onCancel();
    if (request.kind === "pick") request.onCancel?.();
    close();
  };

  const toggle = (row: Row | undefined) => {
    if (row?.itemIndex === undefined) return;
    setChecked((previous) => {
      const next = new Set(previous);
      if (next.has(row.itemIndex!)) next.delete(row.itemIndex!);
      else next.add(row.itemIndex!);
      return next;
    });
  };

  const accept = (row: Row | undefined) => {
    if (request.kind === "input") {
      if (decodeValidation(request.validation)?.severity === "error") return;
      request.onAccept(value);
      close();
      return;
    }
    if (request.kind === "hostPick" && request.pick.canPickMany) {
      request.onAccept([...checked].sort((a, b) => a - b));
      close();
      return;
    }
    if (!row) return;
    if (mode === "help") {
      setValue(row.id === "files" ? "" : row.id);
      inputRef.current?.focus();
      return;
    }
    if (["loading", "none", "hint"].includes(row.id)) return;
    if (request.kind === "hostPick") {
      row.run();
      close();
      return;
    }
    close();
    row.run();
  };

  const placeholder =
    request.kind === "pick"
      ? request.placeholder
      : request.kind === "hostPick"
        ? (request.pick.placeholder ?? "")
        : request.kind === "input"
          ? (request.options.placeholder ?? "")
          : request.kind === "editors"
            ? t("Select an editor")
            : t("Search files by name (append : to go to line, @ to go to symbol, or # for workspace symbols)");
  const title = request.kind === "hostPick" ? request.pick.title : request.kind === "input" ? request.options.title : undefined;
  const multi = request.kind === "hostPick" && request.pick.canPickMany;
  const busy = request.kind === "hostPick" && request.pick.busy;
  // Extension buttons: QuickInputButtons.Back goes left, the rest to the right of the title bar.
  const buttons = request.kind === "hostPick" ? request.pick.buttons : request.kind === "input" ? request.options.buttons : undefined;
  const backButton = buttons?.find((button) => !button.image && button.icon === "arrow-left");
  const rightButtons = buttons?.filter((button) => button !== backButton);
  const triggerButton = (index: number) => {
    if (request.kind === "hostPick" || request.kind === "input") request.onButton?.(index);
  };
  const hasTitlebar = !!title || !!buttons?.length;

  return (
    <div
      className="palette-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div className="palette" role="dialog" aria-label={title ?? t("Quick open")}>
        {hasTitlebar && (
          <div className="palette-titlebar">
            <span className="palette-titlebar-left">{backButton && <QuickButton button={backButton} onClick={() => triggerButton(backButton.index)} />}</span>
            {title && <span className="palette-title">{title}</span>}
            <span className="palette-titlebar-right">
              {rightButtons?.map((button) => (
                <QuickButton key={button.index} button={button} onClick={() => triggerButton(button.index)} />
              ))}
            </span>
          </div>
        )}
        <div
          className={`palette-input-wrap${request.kind === "input" && request.validation ? ` ${decodeValidation(request.validation)!.severity === "error" ? "invalid" : `sev-${decodeValidation(request.validation)!.severity}`}` : ""}`}
        >
          {multi && (
            <input
              type="checkbox"
              className="palette-check-all"
              title={t("Toggle all")}
              checked={checked.size > 0 && checked.size === rows.length}
              onChange={(e) => setChecked(e.target.checked ? new Set(rows.flatMap((row) => (row.itemIndex === undefined ? [] : [row.itemIndex]))) : new Set())}
            />
          )}
          <input
            ref={inputRef}
            type={request.kind === "input" && request.options.password ? "password" : "text"}
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
            value={value}
            readOnly={request.kind === "editors"}
            onChange={(e) => {
              setValue(e.target.value);
              if (request.kind === "hostPick" || request.kind === "input") request.onValue?.(e.target.value);
            }}
            onBlur={() => {
              if (request.kind === "editors") return;
              // Clicking a row keeps focus; anything else closes like VS Code.
              setTimeout(() => {
                if (!document.activeElement?.closest(".palette")) dismiss();
              }, 0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                dismiss();
              } else if (e.key === " " && multi && e.ctrlKey) {
                e.preventDefault();
                toggle(rows[active]);
              } else if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey && request.kind === "editors")) {
                e.preventDefault();
                setActive((i) => (rows.length ? (i + 1) % rows.length : 0));
              } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey && request.kind === "editors")) {
                e.preventDefault();
                setActive((i) => (rows.length ? (i - 1 + rows.length) % rows.length : 0));
              } else if (e.key === "PageDown") {
                e.preventDefault();
                setActive((i) => Math.min(rows.length - 1, i + 10));
              } else if (e.key === "PageUp") {
                e.preventDefault();
                setActive((i) => Math.max(0, i - 10));
              } else if (e.key === "Enter") {
                e.preventDefault();
                accept(rows[active]);
              }
            }}
          />
        </div>
        {busy && <div className="palette-busy" />}
        <div className="palette-results" ref={listRef}>
          {!rows.length && <div className="palette-empty">{t("No matching results")}</div>}
          {rows.map((row, index) => (
            <div key={`${row.id}:${index}`}>
              {row.separator && row.separator.trim() && <div className="quick-separator">{row.separator}</div>}
              <div
                className={`quick-row${index === active ? " active" : ""}${row.detail ? " with-detail" : ""}${request.kind === "input" ? (request.validation ? ` input-${decodeValidation(request.validation)!.severity === "error" ? "error" : decodeValidation(request.validation)!.severity}` : " input-hint") : ""}`}
                onMouseMove={() => setActive(index)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => (multi ? toggle(row) : accept(row))}
              >
                {multi && row.itemIndex !== undefined && (
                  <input type="checkbox" className="quick-check" tabIndex={-1} readOnly checked={checked.has(row.itemIndex)} />
                )}
                {row.icon && <span className="quick-icon">{row.icon}</span>}
                <span className="quick-text">
                  <span className="quick-line">
                    <span className="quick-label">
                      <Highlighted text={row.label} indices={row.indices} />
                    </span>
                    {row.description && <span className="quick-description">{row.description}</span>}
                  </span>
                  {row.detail && <span className="quick-detail">{row.detail}</span>}
                </span>
                {row.hint && <kbd className="quick-hint">{row.hint}</kbd>}
                {row.itemButtons?.length && request.kind === "hostPick" && request.onItemButton && row.itemIndex !== undefined ? (
                  <span className="quick-item-buttons">
                    {row.itemButtons.map((button) => (
                      <QuickButton key={button.index} button={button} onClick={() => request.onItemButton?.(row.itemIndex!, button.index)} />
                    ))}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        {multi && (
          <div className="palette-footer">
            <span>{t("{0} selected", checked.size)}</span>
            <button type="button" className="palette-ok" onMouseDown={(e) => e.preventDefault()} onClick={() => accept(undefined)}>
              {t("OK")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
