import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CircleCheck, Circle } from "lucide-react";
import { COMMAND_LINK_HOST, replaceCommandLinks, type Walkthrough, type WalkthroughMedia, type WalkthroughStep } from "../../../shared/menus-walkthroughs";
import { renderMarkdown } from "../../lib/markdown";
import { api as rpcApi } from "../../lib/rpc";
import {
  getApi,
  isStepDone,
  linkFollowed,
  progressOf,
  runCommandLink,
  selectStep,
  setStepDone,
  startCompletionWatch,
  useWalkthroughProgress,
  evaluateCompletion,
  AREA,
} from "./state";

/** A walkthrough: its steps with checkmarks on the left, the media of the selected step on the right. */

type MediaData = { kind: "image"; dataUrl: string } | { kind: "text"; text: string } | { error: string };

const mediaCache = new Map<string, Promise<MediaData>>();

function mediaPath(media: WalkthroughMedia): string | undefined {
  if (typeof media.path === "string") return media.path;
  const dark = getApi()?.theme.isDark() ?? true;
  const { light, dark: darkPath, hc, hcLight } = media.path;
  return (dark ? (darkPath ?? hc ?? light) : (light ?? hcLight ?? darkPath)) ?? hc ?? hcLight;
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

function StepMedia({ extensionId, media }: { extensionId: string; media: WalkthroughMedia | undefined }) {
  const path = media ? mediaPath(media) : undefined;
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
  return <div className="walkthrough-media markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.text) }} />;
}

function StepDescription({ walkthrough, step }: { walkthrough: Walkthrough; step: WalkthroughStep }) {
  const rendered = useMemo(() => {
    const { markdown, links } = replaceCommandLinks(step.description);
    // A paragraph holding nothing but a command link is shown as a button (like VS Code).
    const html = renderMarkdown(markdown).replace(/<p>(<a data-href="[^"]*">[^<]*<\/a>)<\/p>/g, (_m, link: string) => `<p class="walkthrough-button">${link}</p>`);
    return { html, links };
  }, [step.description]);

  return (
    <div
      className="walkthrough-description markdown-body"
      dangerouslySetInnerHTML={{ __html: rendered.html }}
      onClick={(event) => {
        const anchor = (event.target as HTMLElement).closest<HTMLElement>("a[data-href]");
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.dataset.href ?? "";
        if (href.startsWith(COMMAND_LINK_HOST)) {
          const command = rendered.links[Number(href.slice(COMMAND_LINK_HOST.length))];
          if (command) runCommandLink(command);
        } else {
          linkFollowed(walkthrough, step, href);
          void rpcApi().request.openExternal({ url: href });
        }
      }}
    />
  );
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

  // Context / setting / view events have no push notification: look again while the page is shown.
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
        <div>
          <h1>{walkthrough.title}</h1>
          {walkthrough.description && <p className="muted">{walkthrough.description}</p>}
        </div>
        <span className="walkthrough-progress muted">
          {done}/{total} steps
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
                {active && <StepDescription walkthrough={walkthrough} step={step} />}
              </li>
            );
          })}
        </ol>
        <StepMedia extensionId={walkthrough.extensionId} media={open?.media} />
      </div>
    </div>
  );
}
