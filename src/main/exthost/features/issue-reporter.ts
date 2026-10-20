import { arch, platform, release } from "node:os";
import type { ExtensionHost } from "../host.ts";
import type { HostFeature } from "./contract.ts";
import { NOT_HANDLED } from "./contract.ts";
import type { IssueReporterOpen, IssueSystemInfo } from "../../../shared/issue-reporter.ts";

/**
 * Host side of the "issue-reporter" area: `workbench.action.openIssueReporter`
 * and `vscode.openIssueReporter` (an extension id, `[id]` or
 * `{ extensionId, issueTitle, issueBody, extensionData }`) open the window's
 * issue reporter; the window asks for the system information it adds to the issue.
 */

const AREA = "issue-reporter";
const COMMANDS = ["workbench.action.openIssueReporter", "vscode.openIssueReporter"];

export function systemInfo(host: ExtensionHost): IssueSystemInfo {
  return {
    app: `${host.init?.appName ?? "Lumen"} ${host.init?.appVersion ?? ""}`.trim(),
    os: `${platform()} ${arch()} ${release()}`,
    runtime: `Node.js ${process.versions.node}`,
  };
}

/** The arguments of the open commands, as VS Code reads them. */
export function parseIssueArgs(args: unknown[]): Omit<IssueReporterOpen, "system"> {
  const first = args[0];
  if (typeof first === "string") return { extensionId: first };
  if (Array.isArray(first)) return typeof first[0] === "string" ? { extensionId: first[0] } : {};
  if (!first || typeof first !== "object") return {};
  const options = first as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  return { extensionId: text(options.extensionId), title: text(options.issueTitle), body: text(options.issueBody), extensionData: text(options.extensionData) };
}

export const issueReporterFeature: HostFeature = {
  area: AREA,

  commands: COMMANDS,

  executeCommand: async (host, command, args) => {
    if (!COMMANDS.includes(command)) return NOT_HANDLED;
    const open: IssueReporterOpen = { ...parseIssueArgs(args), system: systemInfo(host) };
    host.postFeature(AREA, { kind: "open", open });
    return undefined;
  },

  onViewRequest: (host, method) => {
    if (method === "systemInfo") return systemInfo(host);
    throw new Error(`issue-reporter: unknown request '${method}'`);
  },
};
