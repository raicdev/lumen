import { useEffect, useState } from "react";
import { flattenMenu } from "../../shared/menus-walkthroughs";
import { githubIssueUrl, issueBody, issueTarget, type IssueReporterOpen, type IssueSystemInfo } from "../../shared/issue-reporter";
import { api as rpc } from "../lib/rpc";
import { toast } from "../lib/toast";
import { resolveContributedMenu, runMenuCommand } from "./menus-walkthroughs/menus";
import { MenuActionButton } from "./menus-walkthroughs/MenuActions";
import { createStore, useStore } from "./store";
import type { ViewFeature, ViewFeatureApi } from "./types";

/**
 * Window side of the "issue-reporter" area: Help > Report Issue… and the
 * `workbench.action.openIssueReporter` / `vscode.openIssueReporter` commands
 * open a form in an editor tab. It files the issue on the extension's GitHub
 * repository (title and body filled in), opens its own bug page, or copies the
 * report; an extension that handles reports itself adds commands to the
 * `issue/reporter` menu, shown as buttons when it is selected.
 */

const PATH_PREFIX = "lumen-issue-reporter:";
/** The value of the target select for the app itself. */
const APP_TARGET = "";

/** What the commands asked for, by tab path (the form reads it once when it opens). */
const pending = createStore<Record<string, Omit<IssueReporterOpen, "system">>>({});
const systemStore = createStore<IssueSystemInfo | null>(null);

function open(api: ViewFeatureApi, request: Omit<IssueReporterOpen, "system">): void {
  const path = `${PATH_PREFIX}${request.extensionId ?? ""}`;
  pending.set((previous) => ({ ...previous, [path]: request }));
  void api.openFile(path, { focus: true });
}

function IssueReporter({ path, api }: { path: string; api: ViewFeatureApi }) {
  const request = useStore(pending)[path];
  const system = useStore(systemStore);
  const extensions = api.getExtensions();
  const [target, setTarget] = useState(request?.extensionId ?? path.slice(PATH_PREFIX.length) ?? APP_TARGET);
  const [title, setTitle] = useState(request?.title ?? "");
  const [description, setDescription] = useState(request?.body ?? "");
  const [includeSystem, setIncludeSystem] = useState(true);

  useEffect(() => {
    if (!system) void api.requestHost<IssueSystemInfo>("systemInfo").then((info) => systemStore.set(info), () => {});
  }, [api, system]);

  const extension = extensions.find((candidate) => candidate.id.toLowerCase() === target.toLowerCase()) ?? null;
  const where = extension ? issueTarget(extension.manifest as Parameters<typeof issueTarget>[0]) : null;
  const body = issueBody(description, includeSystem ? system : null, extension ? { id: extension.id, version: extension.manifest.version } : null, request?.extensionData);
  // issue/reporter: the selected extension's own ways to report an issue.
  const own = extension
    ? flattenMenu(resolveContributedMenu("issue/reporter", (key) => (key === "extension" ? extension.id : undefined))).filter(
        (item) => item.extensionId.toLowerCase() === extension.id.toLowerCase(),
      )
    : [];

  const copy = async () => {
    await navigator.clipboard.writeText(`# ${title}\n\n${body}`).catch(() => {});
    toast("The issue was copied to the clipboard.");
  };
  const submit = async () => {
    if (!where) return void copy();
    if (where.kind === "github") return void rpc().request.openExternal({ url: githubIssueUrl(where.url, title, body) });
    await copy();
    void rpc().request.openExternal({ url: where.url });
  };

  return (
    <div className="issue-reporter">
      <h2>Report Issue</h2>
      <label className="issue-field">
        <span>File on</span>
        <select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value={APP_TARGET}>Lumen (the editor)</option>
          {extensions.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.manifest.displayName ?? candidate.manifest.name} ({candidate.id})
            </option>
          ))}
        </select>
      </label>
      {own.length > 0 && (
        <div className="issue-own">
          <span>This extension reports issues itself:</span>
          {own.map((item) => (
            <MenuActionButton key={item.command} item={{ ...item, icon: undefined }} onRun={() => runMenuCommand(item.command, [])} className="issue-own-button" />
          ))}
        </div>
      )}
      <label className="issue-field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Please enter a title" />
      </label>
      <label className="issue-field">
        <span>Description</span>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={8} placeholder="Steps to reproduce, what you expected, what happened" />
      </label>
      <label className="issue-check">
        <input type="checkbox" checked={includeSystem} onChange={(e) => setIncludeSystem(e.target.checked)} /> Include system information
      </label>
      <pre className="issue-preview">{body}</pre>
      <div className="issue-actions">
        <button type="button" className="primary-btn" disabled={!title.trim()} onClick={() => void submit()}>
          {where?.kind === "github" ? "Create on GitHub" : where?.kind === "page" ? "Copy and Open Issue Page" : "Copy to Clipboard"}
        </button>
        {where && (
          <button type="button" className="secondary-btn" onClick={() => void copy()}>
            Copy to Clipboard
          </button>
        )}
        {!where && <span className="muted">{extension ? "This extension has no repository or bug page." : "Lumen has no issue tracker configured: the report is copied."}</span>}
      </div>
    </div>
  );
}

export const issueReporterView: ViewFeature = {
  area: "issue-reporter",

  onHostMessage: (payload, api) => {
    const message = payload as { kind?: string; open?: IssueReporterOpen };
    if (message.kind !== "open" || !message.open) return;
    systemStore.set(message.open.system);
    open(api, message.open);
  },

  commands: [{ id: "workbench.action.openIssueReporter", title: "Report Issue…", category: "Help", run: (api) => open(api, {}) }],

  editorOpeners: [
    {
      id: "issue-reporter.form",
      match: (path) => path.startsWith(PATH_PREFIX),
      title: () => "Report Issue",
      render: (path, api) => <IssueReporter key={path} path={path} api={api} />,
    },
  ],
};
