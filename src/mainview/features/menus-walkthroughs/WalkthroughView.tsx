import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CircleCheck, Circle, RotateCcw } from "lucide-react";
import {
  COMMAND_LINK_HOST,
  mediaPathFor,
  parseStepDescription,
  replaceCommandLinks,
  type MediaThemeKind,
  type Walkthrough,
  type WalkthroughMedia,
  type WalkthroughStep,
} from "../../../shared/menus-walkthroughs";
import { renderMarkdown } from "../../lib/markdown";
import { api as rpcApi } from "../../lib/rpc";
import {
  getApi,
  isStepDone,
  linkFollowedUrl,
  progressOf,
  resetProgress,
  runCommandLink,
  selectStep,
  setStepDone,
  startCompletionWatch,
  useWalkthroughProgress,
  evaluateCompletion,
  AREA,
} from "./state";

/** A walkthrough: its steps with checkmarks on the left, the media of the selected step on the right. */

type MediaData = { kind: "image"; dataUrl: string } | { kind: "svg"; text: string } | { kind: "text"; text: string } | { error: string };

const mediaCache = new Map<string, Promise<MediaData>>();

/** The extension host restarted (extension update): read media files again. */
export function clearMediaCache(): void {
  mediaCache.clear();
}

/** The active theme kind (`document.documentElement.dataset.themeKind`), for light/dark/hc media variants. */
function themeKind(): MediaThemeKind {
  const kind = document.documentElement.dataset.themeKind;
  if (kind === "light" || kind === "hcDark" || kind === "hcLight") return kind;
  return document.body.classList.contains("vscode-light") ? "light" : "dark";
}

/** Re-renders when the color theme changes (media may have per-theme variants). */
function useThemeKind(): MediaThemeKind {
  const [kind, setKind] = useState(themeKind);
  useEffect(() => {
    setKind(themeKind());
    return getApi()?.theme.onChange(() => setKind(themeKind()));
  }, []);
  return kind;
}

function loadMedia(extensionId: string, path: string): Promise<MediaData> {
  const key = `${extensionId}\0${path}`;
  let loading = mediaCache.get(key);
  if (!loading) {
    const api = getApi();
    loading = (api ? api.requestHost<MediaData>("media", [extensionId, path]) : Promise.reject(new Error("not ready"))).catch((error: unknown) => {
      mediaCache.delete(key);
      return { error: error instanceof Error ? error.message : String(error) };
    });
    mediaCache.set(key, loading);
  }
  return loading;
}

/** VS Code SVGs use the workbench's theme variables; render them inline, without scripts or event handlers. */
export function sanitizeSvg(source: string): string {
  return source
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(?:href|xlink:href)\s*=\s*(?:"|')?\s*javascript:/gi, "href=\"#");
}

/** A Markdown block with links that open externally, run commands, or complete `onLink`. */
function MarkdownBlock({ markdown, onLink }: { markdown: string; onLink?: (url: string) => void }) {
  const rendered = useMemo(() => {
    const replaced = replaceCommandLinks(markdown);
    return { html: renderMarkdown(replaced.markdown), links: replaced.links };
  }, [markdown]);

  return (
    <div
      className="markdown-body"
      dangerouslySetInnerHTML={{ __html: rendered.html }}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLElement>("a[data-href]");
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.dataset.href ?? "";
        if (href.startsWith(COMMAND_LINK_HOST)) {
          const command = rendered.links[Number(href.slice(COMMAND_LINK_HOST.length))];
          if (command) runCommandLink(command);
          return;
        }
        onLink?.(href);
        void rpcApi().request.openExternal({ url: href });
      }}
    />
  );
}

function StepMedia({ extensionId, media }: { extensionId: string; media: WalkthroughMedia | undefined }) {
  const kind = useThemeKind();
  const path = media ? mediaPathFor(media, kind) : undefined;
  const [data, setData] = useState<MediaData | null>(null);
  useEffect(() => {
    setData(null);
    if (!path) return;
    let cancelled = false;
    void loadMedia(extensionId, path).then((result) => !cancelled && setData(result));
    return () => {
      cancelled = true;
    };
  }, [extensionId, path]);

  if (!media || !path) return <div className="walkthrough-media empty" />;
  if (!data) return <div className="walkthrough-media empty muted">Loading…</div>;
  if ("error" in data) return <div className="walkthrough-media empty muted">{media.alt ?? data.error}</div>;
  if (data.kind === "image") {
    return (
      <div className="walkthrough-media">
        <img src={data.dataUrl} alt={media.alt ?? ""} />
      </div>
    );
  }
  if (data.kind === "svg") {
    return (
      <div className="walkthrough-media svg-body">
        <div role="img" aria-label={media.alt ?? ""} dangerouslySetInnerHTML={{ __html: sanitizeSvg(data.text) }} />
      </div>
    );
  }
  return (
    <div className="walkthrough-media markdown-body">
      <MarkdownBlock markdown={data.text} onLink={(url) => linkFollowedUrl(url)} />
    </div>
  );
}

/** One line of a step description: Markdown with buttons for lone links (VS Code's buildMarkdownDescription). */
function DescriptionLine({ text, button }: { text: string; button?: { label: string; href: string } }) {
  const rendered = useMemo(() => {
    const replaced = replaceCommandLinks(text);
    return { html: renderMarkdown(replaced.markdown), links: replaced.links };
  }, [text]);
  const label = useMemo(() => (button ? renderMarkdown(button.label).replace(/^<p>|<\/p>$/g, "") : ""), [button]);

  if (button) {
    return (
      <p className="walkthrough-button">
        <a
          data-href={button.href}
          onClick={(event) => {
            event.preventDefault();
            if (button.href.startsWith("command:")) runCommandLink(button.href);
            else {
              linkFollowedUrl(button.href);
              void rpcApi().request.openExternal({ url: button.href });
            }
          }}
          dangerouslySetInnerHTML={{ __html: label }}
        />
      </p>
    );
  }

  return (
    <div
      className="walkthrough-line"
      dangerouslySetInnerHTML={{ __html: rendered.html }}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLElement>("a[data-href]");
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.dataset.href ?? "";
        if (href.startsWith(COMMAND_LINK_HOST)) {
          const command = rendered.links[Number(href.slice(COMMAND_LINK_HOST.length))];
          if (command) runCommandLink(command);
          return;
        }
        linkFollowedUrl(href);
        void rpcApi().request.openExternal({ url: href });
      }}
    />
  );
}

function StepDescription({ step }: { step: WalkthroughStep }) {
  const lines = useMemo(() => parseStepDescription(step.description), [step.description]);
  return (
    <div className="walkthrough-description markdown-body">
      {lines.map((line, index) => (
        <DescriptionLine key={index} text={line.text} button={line.button} />
      ))}
    </div>
  );
}

/** The icon of a walkthrough (or the extension's) at the left of the title. */
export function WalkthroughIcon({ extensionId, path, size = 24 }: { extensionId: string; path: string; size?: number }) {
  const [data, setData] = useState<{ src?: string; svg?: string }>({});
  useEffect(() => {
    let cancelled = false;
    void loadMedia(extensionId, path).then((result) => {
      if (cancelled) return;
      if ("dataUrl" in result) setData({ src: result.dataUrl });
      else if ("text" in result && result.kind === "svg") setData({ svg: sanitizeSvg(result.text) });
    });
    return () => {
      cancelled = true;
    };
  }, [extensionId, path]);
  if (data.src) return <img className="walkthrough-icon" src={data.src} alt="" width={size} height={size} />;
  if (data.svg)
    return <span className="walkthrough-icon" role="img" aria-hidden="true" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: data.svg }} />;
  return null;
}

export function WalkthroughView({ walkthrough, onBack }: { walkthrough: Walkthrough; onBack?: () => void }) {
  const progress = useWalkthroughProgress();
  const selectedId = progress.selected[walkthrough.key];
  const initial = walkthrough.steps.find((step) => step.id === selectedId) ?? walkthrough.steps.find((step) => !isStepDone(progress, walkthrough, step)) ?? walkthrough.steps[0];
  const [openId, setOpenId] = useState<string | undefined>(initial?.id);
  const open = walkthrough.steps.find((step) => step.id === openId) ?? initial;
  const { done, total } = progressOf(progress, walkthrough);

  // A step asked for from outside (openWalkthrough with a step) follows the remembered selection.
  useEffect(() => {
    if (selectedId) setOpenId(selectedId);
  }, [selectedId]);

  // Context / setting / view events have no push notification for window keys: look again while the page is shown.
  useEffect(() => {
    startCompletionWatch();
    evaluateCompletion();
    const timer = setInterval(evaluateCompletion, 2000);
    return () => clearInterval(timer);
  }, []);

  // The initially shown step counts as selected.
  useEffect(() => {
    if (open) selectStep(walkthrough, open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walkthrough.key, open?.id]);

  return (
    <div className="walkthrough" data-area={AREA}>
      <header className="walkthrough-head">
        {onBack && (
          <button type="button" className="icon-btn" title="Back to Welcome" onClick={onBack}>
            <ArrowLeft size={16} />
          </button>
        )}
        {walkthrough.icon ? (
          <WalkthroughIcon extensionId={walkthrough.extensionId} path={walkthrough.icon} />
        ) : walkthrough.iconUrl ? (
          <img className="walkthrough-icon" src={walkthrough.iconUrl} alt="" width={28} height={28} />
        ) : null}
        <div>
          <h1>
            {walkthrough.title}
            {walkthrough.featured && <span className="walkthrough-featured">Featured</span>}
          </h1>
          {walkthrough.description && <p className="muted">{walkthrough.description}</p>}
        </div>
        <span className="walkthrough-progress muted">
          {done}/{total} steps
          {done > 0 && (
            <button type="button" className="icon-btn walkthrough-reset" title="Reset All Walkthrough Progress" onClick={() => resetProgress()}>
              <RotateCcw size={13} />
            </button>
          )}
        </span>
      </header>
      <div className="walkthrough-body">
        <ol className="walkthrough-steps">
          {walkthrough.steps.map((step) => {
            const complete = isStepDone(progress, walkthrough, step);
            const active = step.id === open?.id;
            return (
              <li key={step.id} className={`walkthrough-step${active ? " active" : ""}${complete ? " done" : ""}`}>
                <div className="walkthrough-step-row">
                  <button
                    type="button"
                    className="walkthrough-check"
                    title={complete ? "Mark as not done" : "Mark as done"}
                    onClick={() => setStepDone(walkthrough, step, !complete)}
                  >
                    {complete ? <CircleCheck size={16} /> : <Circle size={16} />}
                  </button>
                  <button
                    type="button"
                    className="walkthrough-step-title"
                    onClick={() => {
                      setOpenId(step.id);
                      selectStep(walkthrough, step);
                    }}
                  >
                    {step.title}
                  </button>
                </div>
                {active && <StepDescription step={step} />}
              </li>
            );
          })}
        </ol>
        <StepMedia extensionId={walkthrough.extensionId} media={open?.media} />
      </div>
    </div>
  );
}
