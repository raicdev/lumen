import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronRight } from "lucide-react";
import type { HostDebugEvaluateResult } from "../../shared/extensions";
import { debugService, useDebug } from "../lib/debug";
import { currentSession, useDebugUi } from "../lib/debug-ui";
import { DebugValue, VariableNode } from "./DebugVariables";
import { t } from "../lib/i18n";

/**
 * The Debug Console: adapter output plus a REPL that evaluates in the focused
 * stack frame. REPL entries are kept here (module level) so they survive the
 * panel being hidden; output lines come from the debug store.
 */

type ReplEntry = {
  /** Shown after this many output lines (keeps input and output interleaved). */
  after: number;
  expression: string;
  sessionId: string;
  result: HostDebugEvaluateResult | { error: string } | null;
};

let entries: ReplEntry[] = [];
let clearedAt = 0;
const listeners = new Set<() => void>();
const replStore = {
  subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
  get: () => entries,
  set(next: ReplEntry[]) {
    entries = next;
    for (const l of listeners) l();
  },
};

const history: string[] = [];

export function clearDebugConsole() {
  clearedAt = debugService.getSnapshot().console.length;
  replStore.set([]);
}

export function DebugConsole() {
  const debug = useDebug();
  const { focused, generation } = useDebugUi();
  const repl = useSyncExternalStore(replStore.subscribe, replStore.get);
  const [input, setInput] = useState("");
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // The store trims old lines; keep the "cleared" mark inside the array.
  // Telemetry events are for the adapter's authors, not the user (VS Code hides them too).
  const lines = debug.console.slice(Math.min(clearedAt, debug.console.length));
  const offset = debug.console.length - lines.length;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length, repl]);

  useEffect(() => {
    if (!debug.sessions.length) clearedAt = 0;
  }, [debug.sessions.length]);

  const submit = async () => {
    const expression = input.trim();
    if (!expression) return;
    history.push(expression);
    setHistoryIndex(null);
    setInput("");
    const session = currentSession();
    if (!session) {
      replStore.set([...entries, { after: debug.console.length, expression, sessionId: "", result: { error: t("No active debug session.") } }]);
      return;
    }
    const entry: ReplEntry = { after: debug.console.length, expression, sessionId: session.id, result: null };
    replStore.set([...entries, entry]);
    const frameId = focused?.sessionId === session.id ? focused.frameId : null;
    const result = await debugService
      .evaluate(session.id, expression, frameId, "repl")
      .catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }));
    replStore.set(entries.map((e) => (e === entry ? { ...e, result: result ?? { error: t("No result.") } } : e)));
  };

  // Interleave output lines and REPL entries by position.
  const rows: React.ReactNode[] = [];
  let r = 0;
  const pushRepl = (upTo: number) => {
    while (r < repl.length && repl[r]!.after <= upTo) {
      const entry = repl[r]!;
      rows.push(<ReplRow key={`r${r}`} entry={entry} generation={generation} />);
      r++;
    }
  };
  lines.forEach((line, i) => {
    pushRepl(offset + i);
    if (line.category === "telemetry") return;
    rows.push(
      <div key={`o${offset + i}`} className={`dbg-console-line cat-${line.category}`} title={line.path ? `${line.path}:${line.line ?? ""}` : undefined}>
        {line.text}
      </div>,
    );
  });
  pushRepl(Number.POSITIVE_INFINITY);

  return (
    <div className="dbg-console">
      <div
        className="dbg-console-output"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        }}
      >
        {rows.length ? rows : <div className="dbg-placeholder">{t("Output of debug sessions appears here. Evaluate expressions below while paused.")}</div>}
      </div>
      <div className="dbg-console-input">
        <ChevronRight size={14} />
        <input
          value={input}
          placeholder={currentSession() ? t("Evaluate expression") : t("Start a debug session to evaluate expressions")}
          spellCheck={false}
          onChange={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
            else if (e.key === "ArrowUp" && history.length) {
              e.preventDefault();
              const index = historyIndex === null ? history.length - 1 : Math.max(0, historyIndex - 1);
              setHistoryIndex(index);
              setInput(history[index]!);
            } else if (e.key === "ArrowDown" && historyIndex !== null) {
              e.preventDefault();
              const index = historyIndex + 1;
              if (index >= history.length) {
                setHistoryIndex(null);
                setInput("");
              } else {
                setHistoryIndex(index);
                setInput(history[index]!);
              }
            }
          }}
        />
      </div>
    </div>
  );
}

function ReplRow({ entry, generation }: { entry: ReplEntry; generation: number }) {
  return (
    <>
      <div className="dbg-console-line dbg-console-input-echo">
        <ChevronRight size={12} /> {entry.expression}
      </div>
      {entry.result === null ? (
        <div className="dbg-console-line dim">…</div>
      ) : "error" in entry.result ? (
        <div className="dbg-console-line cat-stderr">{entry.result.error}</div>
      ) : entry.result.variablesReference > 0 ? (
        <div className="dbg-console-tree">
          <VariableNode
            sessionId={entry.sessionId}
            variable={{ name: "", value: entry.result.result, type: entry.result.type, variablesReference: entry.result.variablesReference }}
            depth={0}
            generation={generation}
          />
        </div>
      ) : (
        <div className="dbg-console-line">
          <DebugValue value={entry.result.result} type={entry.result.type} />
        </div>
      )}
    </>
  );
}
