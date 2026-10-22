import { useEffect, useState } from "react";
import { ChevronRight, CircleDot, Play, Plus, Settings, Trash2, X } from "lucide-react";
import type {
  HostDebugBreakpoint,
  HostDebugConfiguration,
  HostDebugEvaluateResult,
  HostDebugScope,
  HostDebugSession,
  HostDebugStackFrame,
  HostDebugThread,
} from "../../shared/extensions";
import { debugService, useDebug } from "../lib/debug";
import { debugMenuLookup, debugUi, removeBreakpoint, setBreakpointEnabled, useDebugUi } from "../lib/debug-ui";
import { MenuActions } from "../features/menus-walkthroughs/MenuActions";
import { showContributedMenu } from "../features/menus-walkthroughs/menus";
import { basename } from "../lib/paths";
import { DebugValue, VariableNode } from "./DebugVariables";

type Props = {
  workspaceRoot: string | null;
  onStart: (config: HostDebugConfiguration | null) => void;
  onOpenLaunchJson: () => void;
  onReveal: (path: string, line: number, column?: number) => void;
};

/** A collapsible section of the Run and Debug view. */
function Section({
  title,
  actions,
  children,
  defaultOpen = true,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`dbg-section${open ? " open" : ""}`}>
      <header className="dbg-section-header" onClick={() => setOpen((v) => !v)}>
        <ChevronRight size={14} className={`dbg-chevron${open ? " open" : ""}`} />
        <span className="dbg-section-title">{title}</span>
        {open && actions && (
          <span className="dbg-section-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        )}
      </header>
      {open && <div className="dbg-section-body">{children}</div>}
    </section>
  );
}

export function DebugView({ workspaceRoot, onStart, onOpenLaunchJson, onReveal }: Props) {
  const debug = useDebug();
  const ui = useDebugUi();
  const [configs, setConfigs] = useState<HostDebugConfiguration[]>([]);
  const [configError, setConfigError] = useState<string | null>(null);
  const live = debug.sessions.filter((s) => s.state !== "terminated");

  // launch.json can change at any time: re-read it when the view is shown and after sessions end.
  useEffect(() => {
    let cancelled = false;
    debugService
      .listConfigurations(workspaceRoot)
      .then((result) => {
        if (cancelled) return;
        setConfigs(result.configurations);
        setConfigError(result.error ?? null);
      })
      .catch(() => !cancelled && setConfigs([]));
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, live.length]);

  const selected = configs.find((c) => c.name === ui.selectedConfig) ?? configs[0] ?? null;

  return (
    <div className="dbg-view">
      <div className="dbg-launch">
        {configs.length ? (
          <>
            <button className="dbg-start" type="button" title="Start Debugging (F5)" onClick={() => onStart(selected)}>
              <Play size={14} strokeWidth={2} />
            </button>
            <select
              className="dbg-config-select"
              value={selected?.name ?? ""}
              onChange={(e) => debugUi.selectConfig(e.target.value)}
              title="Launch configuration"
            >
              {configs.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
            <button className="icon-btn" type="button" title="Open launch.json" onClick={onOpenLaunchJson}>
              <Settings size={15} strokeWidth={1.75} />
            </button>
          </>
        ) : (
          <div className="dbg-empty-launch">
            <button className="dbg-run-button" type="button" onClick={() => onStart(null)}>
              Run and Debug
            </button>
            <p>
              Debugs the active file with an installed debugger.{" "}
              <a href="#" onClick={(e) => (e.preventDefault(), onOpenLaunchJson())}>
                Create a launch.json file
              </a>{" "}
              to customize it.
            </p>
            {configError && <p className="dbg-error">{configError}</p>}
          </div>
        )}
      </div>

      <Section title="Variables">
        <VariablesSection generation={ui.generation} />
      </Section>
      <Section
        title="Watch"
        actions={
          <>
            <button className="icon-btn" type="button" title="Add Expression" onClick={() => window.dispatchEvent(new CustomEvent("lumen:debug-add-watch"))}>
              <Plus size={14} />
            </button>
            <button className="icon-btn" type="button" title="Remove All Expressions" onClick={() => debugUi.removeWatch("all")}>
              <Trash2 size={13} />
            </button>
          </>
        }
      >
        <WatchSection />
      </Section>
      <Section title="Call Stack">
        <CallStackSection sessions={live} onReveal={onReveal} />
      </Section>
      <Section
        title="Breakpoints"
        actions={
          <button className="icon-btn" type="button" title="Remove All Breakpoints" onClick={() => void debugService.removeAllBreakpoints()}>
            <Trash2 size={13} />
          </button>
        }
      >
        <BreakpointsSection breakpoints={debug.breakpoints} onReveal={onReveal} />
      </Section>
    </div>
  );
}

/* ── Variables ─────────────────────────────────────────────────────────── */

function VariablesSection({ generation }: { generation: number }) {
  const { focused } = useDebugUi();
  const [scopes, setScopes] = useState<HostDebugScope[] | null>(null);
  const sessionId = focused?.sessionId;
  const frameId = focused?.frameId;

  useEffect(() => {
    if (sessionId === undefined || frameId === undefined) {
      setScopes(null);
      return;
    }
    let cancelled = false;
    debugService
      .scopes(sessionId, frameId)
      .then((result) => !cancelled && setScopes(result))
      .catch(() => !cancelled && setScopes([]));
    return () => {
      cancelled = true;
    };
  }, [sessionId, frameId, generation]);

  if (!focused) return <div className="dbg-placeholder">Not paused.</div>;
  if (!scopes) return null;
  return (
    <>
      {scopes.map((scope, i) => (
        <VariableNode
          key={`${scope.name}:${i}`}
          sessionId={focused.sessionId}
          variable={{ name: scope.name, value: "", variablesReference: scope.variablesReference }}
          depth={0}
          generation={generation}
          defaultOpen={i === 0 && !scope.expensive}
        />
      ))}
    </>
  );
}

/* ── Watch ─────────────────────────────────────────────────────────────── */

function WatchSection() {
  const debug = useDebug();
  const { watches, focused, generation } = useDebugUi();
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [results, setResults] = useState<(HostDebugEvaluateResult | { error: string } | null)[]>([]);

  useEffect(() => {
    const onAdd = () => setEditing("new");
    window.addEventListener("lumen:debug-add-watch", onAdd);
    return () => window.removeEventListener("lumen:debug-add-watch", onAdd);
  }, []);

  const sessionId = focused?.sessionId;
  const frameId = focused?.frameId;
  useEffect(() => {
    if (sessionId === undefined || frameId === undefined) {
      setResults([]);
      return;
    }
    let cancelled = false;
    void Promise.all(
      watches.map((expression) =>
        debugService.evaluate(sessionId, expression, frameId, "watch").catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
      ),
    ).then((values) => !cancelled && setResults(values));
    return () => {
      cancelled = true;
    };
  }, [watches, sessionId, frameId, generation]);

  const commit = (index: number | "new", value: string) => {
    setEditing(null);
    const expression = value.trim();
    if (index === "new") {
      if (expression) debugUi.addWatch(expression);
    } else if (!expression) debugUi.removeWatch(index);
    else debugUi.editWatch(index, expression);
  };

  const input = (index: number | "new", initial: string) => (
    <input
      className="dbg-watch-input"
      autoFocus
      defaultValue={initial}
      placeholder="Expression to watch"
      onBlur={(e) => commit(index, e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit(index, e.currentTarget.value);
        else if (e.key === "Escape") setEditing(null);
      }}
    />
  );

  return (
    <>
      {watches.map((expression, i) => {
        if (editing === i) return <div key={i}>{input(i, expression)}</div>;
        const result = results[i];
        const row = (
          <div
            className="dbg-row dbg-watch-row"
            onDoubleClick={() => setEditing(i)}
            onContextMenu={(e) => {
              const session = debug.sessions.find((candidate) => candidate.id === focused?.sessionId) ?? null;
              const value =
                result && !("error" in result)
                  ? { value: result.result, type: result.type, variablesReference: result.variablesReference }
                  : { value: "", variablesReference: 0 };
              showContributedMenu(e, "debug/watch/context", debugMenuLookup(session, { watchItemType: "expression", watchExpressionsFocused: true }), [
                { sessionId: focused?.sessionId, variable: { name: expression, evaluateName: expression, ...value } },
              ]);
            }}
          >
            <span className="dbg-chevron hidden" />
            <span className="dbg-name">{expression}</span>
            <span className="dbg-sep">: </span>
            {!focused || !result ? (
              <span className="dbg-value dbg-value-null">not available</span>
            ) : "error" in result ? (
              <span className="dbg-error">{result.error}</span>
            ) : (
              <DebugValue value={result.result} type={result.type} />
            )}
            <button className="icon-btn dbg-row-action" type="button" title="Remove Expression" onClick={() => debugUi.removeWatch(i)}>
              <X size={13} />
            </button>
          </div>
        );
        if (focused && result && !("error" in result) && result.variablesReference > 0) {
          return (
            <div key={i} className="dbg-watch-tree" onDoubleClick={() => setEditing(i)}>
              <VariableNode
                sessionId={focused.sessionId}
                variable={{
                  name: expression,
                  value: result.result,
                  type: result.type,
                  variablesReference: result.variablesReference,
                  evaluateName: expression,
                }}
                depth={0}
                generation={generation}
                watch
              />
            </div>
          );
        }
        return <div key={i}>{row}</div>;
      })}
      {editing === "new" && input("new", "")}
    </>
  );
}

/* ── Call stack ────────────────────────────────────────────────────────── */

function CallStackSection({ sessions, onReveal }: { sessions: HostDebugSession[]; onReveal: Props["onReveal"] }) {
  if (!sessions.length) return <div className="dbg-placeholder">Not running.</div>;
  return (
    <>
      {sessions.map((session) => (
        <SessionNode key={session.id} session={session} depth={session.parentId ? 1 : 0} onReveal={onReveal} />
      ))}
    </>
  );
}

function SessionNode({ session, depth, onReveal }: { session: HostDebugSession; depth: number; onReveal: Props["onReveal"] }) {
  const { generation } = useDebugUi();
  const [threads, setThreads] = useState<HostDebugThread[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    if (session.state === "starting") return;
    let cancelled = false;
    debugService
      .threads(session.id)
      .then((result) => !cancelled && setThreads(result))
      .catch(() => !cancelled && setThreads([]));
    return () => {
      cancelled = true;
    };
  }, [session.id, session.state, session.stoppedThreadId, generation]);

  const label =
    session.state === "stopped"
      ? `Paused${session.stoppedReason ? ` on ${session.stoppedReason}` : ""}`
      : session.state === "starting"
        ? "Starting"
        : "Running";
  return (
    <>
      <div
        className="dbg-row dbg-session-row"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => setOpen((v) => !v)}
        onContextMenu={(e) =>
          showContributedMenu(e, "debug/callstack/context", callStackLookup(session, "session", threads.length === 1), [{ sessionId: session.id }])
        }
      >
        <ChevronRight size={14} className={`dbg-chevron${open ? " open" : ""}`} />
        <span className="dbg-name">{session.name}</span>
        <span className="dbg-state">{label}</span>
        <CallStackInline lookup={callStackLookup(session, "session", threads.length === 1)} args={[{ sessionId: session.id }]} />
      </div>
      {open &&
        threads.map((thread) => (
          <ThreadNode
            key={thread.id}
            session={session}
            thread={thread}
            depth={depth + 1}
            stopped={session.state === "stopped" && (session.stoppedThreadId === undefined || session.stoppedThreadId === thread.id)}
            onReveal={onReveal}
            single={threads.length === 1}
          />
        ))}
    </>
  );
}

function ThreadNode({
  session,
  thread,
  depth,
  stopped,
  single,
  onReveal,
}: {
  session: HostDebugSession;
  thread: HostDebugThread;
  depth: number;
  stopped: boolean;
  single: boolean;
  onReveal: Props["onReveal"];
}) {
  const { focused, generation } = useDebugUi();
  const [frames, setFrames] = useState<HostDebugStackFrame[]>([]);
  const [open, setOpen] = useState(stopped);

  useEffect(() => setOpen(stopped), [stopped]);
  useEffect(() => {
    if (!stopped) {
      setFrames([]);
      return;
    }
    let cancelled = false;
    debugService
      .stackTrace(session.id, thread.id, 0, 50)
      .then((result) => !cancelled && setFrames(result))
      .catch(() => !cancelled && setFrames([]));
    return () => {
      cancelled = true;
    };
  }, [session.id, thread.id, stopped, generation]);

  // A single thread is shown directly as its frames (like VS Code).
  const frameDepth = single ? depth : depth + 1;
  return (
    <>
      {!single && (
        <div
          className="dbg-row dbg-thread-row"
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => setOpen((v) => !v)}
          onContextMenu={(e) =>
            showContributedMenu(e, "debug/callstack/context", callStackLookup(session, "thread", single, stopped), [
              { sessionId: session.id, threadId: thread.id },
            ])
          }
        >
          <ChevronRight size={14} className={`dbg-chevron${open ? " open" : ""}${stopped ? "" : " hidden"}`} />
          <span className="dbg-name">{thread.name}</span>
          <span className="dbg-state">{stopped ? "Paused" : "Running"}</span>
          <CallStackInline lookup={callStackLookup(session, "thread", single, stopped)} args={[{ sessionId: session.id, threadId: thread.id }]} />
        </div>
      )}
      {(open || single) &&
        frames.map((frame, i) => {
          const isFocused = focused?.sessionId === session.id && focused.frameId === frame.id;
          const path = frame.source?.path;
          // VS Code's stack frame context of contributed commands.
          const context = {
            sessionId: session.id,
            threadId: thread.id,
            frameId: frame.id,
            frameName: frame.name,
            frameLocation: {
              range: { startLineNumber: frame.line, startColumn: frame.column, endLineNumber: frame.line, endColumn: frame.column },
              source: frame.source,
            },
          };
          const lookup = callStackLookup(session, "stackFrame", single, stopped);
          return (
            <div
              key={frame.id}
              className={`dbg-row dbg-frame-row${isFocused ? " focused" : ""}${path ? "" : " no-source"}`}
              style={{ paddingLeft: 8 + frameDepth * 12 }}
              title={path ? `${path}:${frame.line}` : "Source not available"}
              onClick={() => {
                debugUi.focusFrame(session.id, thread.id, frame, i === 0);
                if (path) onReveal(path, frame.line, frame.column);
              }}
              onContextMenu={(e) => showContributedMenu(e, "debug/callstack/context", lookup, [context])}
            >
              <span className="dbg-chevron hidden" />
              <span className="dbg-name">{frame.name}</span>
              <span className="dbg-location">
                {frame.source?.name ?? (path ? basename(path) : "")}
                {frame.line ? `:${frame.line}` : ""}
              </span>
              <CallStackInline lookup={lookup} args={[context]} />
            </div>
          );
        })}
    </>
  );
}

/** Context keys of debug/callstack/context for a session, thread or stack frame row. */
function callStackLookup(session: HostDebugSession, type: "session" | "thread" | "stackFrame", oneThread: boolean, stopped = session.state === "stopped") {
  return debugMenuLookup(session, {
    callStackItemType: type,
    callStackItemStopped: stopped,
    callStackSessionHasOneThread: oneThread,
    callStackSessionIsAttach: false,
    callStackFocused: true,
  });
}

/** The `inline` entries of debug/callstack/context: buttons at the end of a call stack row. */
function CallStackInline({ lookup, args }: { lookup: (key: string) => unknown; args: unknown[] }) {
  return <MenuActions menuId="debug/callstack/context" lookup={lookup} args={args} inline={["inline"]} overflow={false} className="dbg-row-actions" />;
}

/* ── Breakpoints ───────────────────────────────────────────────────────── */

function BreakpointsSection({ breakpoints, onReveal }: { breakpoints: HostDebugBreakpoint[]; onReveal: Props["onReveal"] }) {
  const debug = useDebug();
  const session = debug.sessions.find((s) => s.id === debug.activeSessionId && s.state !== "terminated");
  const filters = debug.capabilities && session && debug.capabilities.sessionId === session.id ? debug.capabilities.exceptionBreakpointFilters : [];
  const [enabledFilters, setEnabledFilters] = useState<Set<string>>(new Set());

  // `filters` is rebuilt on every render: the session and how many filters it has say when they changed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setEnabledFilters(new Set(filters.filter((f) => f.default).map((f) => f.filter))), [session?.id, filters.length]);

  const toggleFilter = (filter: string, on: boolean) => {
    const next = new Set(enabledFilters);
    if (on) next.add(filter);
    else next.delete(filter);
    setEnabledFilters(next);
    if (session) void debugService.setExceptionBreakpoints(session.id, [...next]);
  };

  const sorted = [...breakpoints].sort(
    (a, b) => (a.path ?? a.functionName ?? "").localeCompare(b.path ?? b.functionName ?? "") || (a.line ?? 0) - (b.line ?? 0),
  );
  if (!filters.length && !sorted.length) return <div className="dbg-placeholder">No breakpoints. Click left of a line number to add one.</div>;
  return (
    <>
      {filters.map((f) => (
        <label key={f.filter} className="dbg-row dbg-bp-row" title={f.description}>
          <input type="checkbox" checked={enabledFilters.has(f.filter)} onChange={(e) => toggleFilter(f.filter, e.currentTarget.checked)} />
          <span className="dbg-name">{f.label}</span>
        </label>
      ))}
      {sorted.map((bp) => {
        const path = bp.path ?? bp.sourcePath;
        const line = bp.verifiedLine ?? bp.line;
        const unverified = bp.enabled && bp.verified === false && debug.sessions.some((s) => s.state !== "terminated");
        return (
          <div
            key={bp.id}
            className={`dbg-row dbg-bp-row${unverified ? " unverified" : ""}`}
            title={
              [
                bp.condition && `Condition: ${bp.condition}`,
                bp.hitCondition && `Hit count: ${bp.hitCondition}`,
                bp.logMessage && `Log: ${bp.logMessage}`,
                unverified && (bp.message ?? "Unverified breakpoint"),
              ]
                .filter(Boolean)
                .join("\n") || path
            }
            onClick={() => path && line && onReveal(path, line)}
          >
            <input
              type="checkbox"
              checked={bp.enabled}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setBreakpointEnabled(bp.id, e.currentTarget.checked)}
            />
            <CircleDot size={12} className={`dbg-bp-icon${bp.logMessage ? " log" : bp.condition || bp.hitCondition ? " conditional" : ""}`} />
            <span className="dbg-name">{bp.kind === "function" ? bp.functionName : path ? basename(path) : "?"}</span>
            {bp.kind === "source" && <span className="dbg-location">{line}</span>}
            {path && workspaceRelativeDir(path) && <span className="dbg-location dim">{workspaceRelativeDir(path)}</span>}
            <button
              className="icon-btn dbg-row-action"
              type="button"
              title="Remove Breakpoint"
              onClick={(e) => {
                e.stopPropagation();
                removeBreakpoint(bp);
              }}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </>
  );
}

function workspaceRelativeDir(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/");
  return parts.length > 1 ? parts[parts.length - 2]! : "";
}
