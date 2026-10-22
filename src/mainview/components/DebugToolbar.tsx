import { ArrowDown, ArrowRight, ArrowUp, Pause, Play, RotateCw, Square } from "lucide-react";
import { useDebug } from "../lib/debug";
import { currentSession, debugMenuLookup, debugStep, restartDebugging, stopDebugging, useDebugUi } from "../lib/debug-ui";
import { MenuActions } from "../features/menus-walkthroughs/MenuActions";

/** The floating Continue / Step / Restart / Stop bar shown while debugging, with the extensions' debug/toolBar entries. */
export function DebugToolbar({ keys }: { keys: Map<string, string> }) {
  const debug = useDebug();
  useDebugUi(); // re-render when the focused frame (and with it the current session) changes
  const live = debug.sessions.filter((s) => s.state !== "terminated");
  if (!live.length) return null;
  const session = currentSession();
  const stopped = session?.state === "stopped";
  const tip = (title: string, command: string) => (keys.get(command) ? `${title} (${keys.get(command)})` : title);

  return (
    <div className="dbg-toolbar" role="toolbar" aria-label="Debug">
      {stopped ? (
        <button
          type="button"
          className="dbg-tool continue"
          title={tip("Continue", "workbench.action.debug.continue")}
          onClick={() => void debugStep("continue")}
        >
          <Play size={15} />
        </button>
      ) : (
        <button type="button" className="dbg-tool" title={tip("Pause", "workbench.action.debug.pause")} onClick={() => void debugStep("pause")}>
          <Pause size={15} />
        </button>
      )}
      <button
        type="button"
        className="dbg-tool"
        disabled={!stopped}
        title={tip("Step Over", "workbench.action.debug.stepOver")}
        onClick={() => void debugStep("next")}
      >
        <ArrowRight size={15} />
      </button>
      <button
        type="button"
        className="dbg-tool"
        disabled={!stopped}
        title={tip("Step Into", "workbench.action.debug.stepInto")}
        onClick={() => void debugStep("in")}
      >
        <ArrowDown size={15} />
      </button>
      <button
        type="button"
        className="dbg-tool"
        disabled={!stopped}
        title={tip("Step Out", "workbench.action.debug.stepOut")}
        onClick={() => void debugStep("out")}
      >
        <ArrowUp size={15} />
      </button>
      <button type="button" className="dbg-tool restart" title={tip("Restart", "workbench.action.debug.restart")} onClick={() => void restartDebugging()}>
        <RotateCw size={15} />
      </button>
      <button type="button" className="dbg-tool stop" title={tip("Stop", "workbench.action.debug.stop")} onClick={() => void stopDebugging()}>
        <Square size={13} />
      </button>
      <MenuActions
        menuId="debug/toolBar"
        lookup={debugMenuLookup(session)}
        args={session ? [{ sessionId: session.id }] : []}
        className="dbg-toolbar-contributed"
      />
      {live.length > 1 && session && <span className="dbg-toolbar-session">{session.name}</span>}
    </div>
  );
}
