import { useState } from "react";
import { CircleCheck, X } from "lucide-react";
import { WalkthroughIcon, WalkthroughView } from "../features/menus-walkthroughs/WalkthroughView";
import {
  announceWalkthrough,
  hideWalkthrough,
  pickWalkthrough,
  progressOf,
  useHiddenWalkthroughs,
  useWalkthroughProgress,
  useWalkthroughs,
} from "../features/menus-walkthroughs/state";

type Props = {
  recent: string[];
  keys: Map<string, string>;
  onRun: (commandId: string) => void;
  onOpenRecent: (path: string) => void;
};

function basename(path: string) {
  return path.split(/[/\\]/).pop() ?? path;
}

function parent(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index > 0 ? path.slice(0, index) : path;
}

const START = [
  { id: "welcome.showNewFileEntries", label: "New File…" },
  { id: "workbench.action.files.openFile", label: "Open File…" },
  { id: "workbench.action.files.openFolder", label: "Open Folder…" },
];

const HELP = [
  { id: "workbench.action.showCommands", label: "Show All Commands" },
  { id: "workbench.action.quickOpen", label: "Go to File" },
  { id: "workbench.view.search", label: "Find in Files" },
  { id: "workbench.action.terminal.toggleTerminal", label: "Toggle Terminal" },
  { id: "workbench.action.openSettings", label: "Open Settings" },
  { id: "workbench.action.openGlobalKeybindings", label: "Keyboard Shortcuts" },
];

/** "Walkthroughs" of the extensions: the list on the page, or one walkthrough in place of the page. */
function Walkthroughs({ onOpen }: { onOpen: (key: string) => void }) {
  const walkthroughs = useWalkthroughs();
  const progress = useWalkthroughProgress();
  const hidden = useHiddenWalkthroughs();
  if (!walkthroughs.length) return null;
  const visible = walkthroughs.filter((walkthrough) => !hidden.has(walkthrough.key.toLowerCase()));
  return (
    <>
      <h2>Walkthroughs</h2>
      <div className="welcome-walkthroughs">
        {visible.map((walkthrough) => {
          const { done, total } = progressOf(progress, walkthrough);
          return (
            <div key={walkthrough.key} className="welcome-walkthrough-row">
              <button type="button" className={`welcome-walkthrough${walkthrough.featured ? " featured" : ""}`} onClick={() => onOpen(walkthrough.key)}>
                <span className="welcome-walkthrough-title">
                  {walkthrough.icon ? (
                    <WalkthroughIcon extensionId={walkthrough.extensionId} path={walkthrough.icon} size={20} />
                  ) : walkthrough.iconUrl ? (
                    <img className="walkthrough-icon" src={walkthrough.iconUrl} alt="" width={20} height={20} />
                  ) : null}
                  {done === total && total > 0 && <CircleCheck size={13} />}
                  {walkthrough.title}
                  {walkthrough.featured && <span className="welcome-walkthrough-featured">Featured</span>}
                </span>
                {walkthrough.description && <span className="muted welcome-walkthrough-description">{walkthrough.description}</span>}
                <span className="welcome-walkthrough-bar" aria-hidden="true">
                  <span style={{ width: total ? `${(done / total) * 100}%` : "0%" }} />
                </span>
              </button>
              <button
                type="button"
                className="welcome-walkthrough-hide"
                title="Hide"
                aria-label={`Hide ${walkthrough.title}`}
                onClick={() => hideWalkthrough(walkthrough)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button type="button" className="welcome-link welcome-walkthroughs-more" onClick={() => void pickWalkthrough()}>
        More…
      </button>
    </>
  );
}

export function Welcome({ recent, keys, onRun, onOpenRecent }: Props) {
  const [walkthroughKey, setWalkthroughKey] = useState<string | null>(null);
  const walkthroughs = useWalkthroughs();
  const open = walkthroughKey ? walkthroughs.find((walkthrough) => walkthrough.key === walkthroughKey) : undefined;
  if (open) {
    return (
      <div className="welcome">
        <div className="welcome-page welcome-page-wide">
          <WalkthroughView walkthrough={open} onBack={() => setWalkthroughKey(null)} />
        </div>
      </div>
    );
  }
  return (
    <div className="welcome">
      <div className="welcome-page">
        <header className="welcome-hero">
          <h1>Lumen</h1>
          <p className="welcome-tagline">Editing evolved</p>
        </header>
        <div className="welcome-columns">
          <section>
            <h2>Start</h2>
            {START.map((item) => (
              <button key={item.id} type="button" className="welcome-link" onClick={() => onRun(item.id)}>
                {item.label}
              </button>
            ))}
            <h2>Recent</h2>
            {!recent.length && <p className="muted">You have no recent folders.</p>}
            {recent.slice(0, 6).map((path) => (
              <div key={path} className="welcome-recent">
                <button type="button" className="welcome-link" onClick={() => onOpenRecent(path)}>
                  {basename(path)}
                </button>
                <span className="muted">{parent(path)}</span>
              </div>
            ))}
            {recent.length > 6 && (
              <button type="button" className="welcome-link" onClick={() => onRun("workbench.action.openRecent")}>
                More…
              </button>
            )}
            <Walkthroughs
              onOpen={(key) => {
                announceWalkthrough(key);
                setWalkthroughKey(key);
              }}
            />
          </section>
          <section>
            <h2>Shortcuts</h2>
            <div className="welcome-keys">
              {HELP.map((item) => (
                <button key={item.id} type="button" className="welcome-key" onClick={() => onRun(item.id)}>
                  <span>{item.label}</span>
                  {keys.get(item.id) && <kbd>{keys.get(item.id)}</kbd>}
                </button>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
