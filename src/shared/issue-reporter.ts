/** Types and the pure logic of the "issue-reporter" area (host and window; tests run it directly). */

export type IssueSystemInfo = { app: string; os: string; runtime: string };

/** Host -> window `{ kind: "open", open }`: what `workbench.action.openIssueReporter` was given. */
export type IssueReporterOpen = {
  extensionId?: string;
  title?: string;
  body?: string;
  /** Extra data of the extension, added to the issue body. */
  extensionData?: string;
  system: IssueSystemInfo;
};

type Manifest = { version?: string; repository?: string | { url?: string }; bugs?: string | { url?: string } };

const urlOf = (value: string | { url?: string } | undefined) => (typeof value === "string" ? value : value?.url);

/** `git+https://github.com/o/r.git`, `github:o/r`, `o/r` → `https://github.com/o/r`, or undefined when not GitHub. */
export function githubRepository(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const short = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(url);
  if (short) return `https://github.com/${short[1]}/${short[2]!.replace(/\.git$/, "")}`;
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i.exec(url);
  return match ? `https://github.com/${match[1]}/${match[2]}` : undefined;
}

/**
 * Where an extension's issues go: a GitHub "new issue" page (title and body
 * filled in), or the extension's own bug page (`bugs.url` that is not GitHub),
 * or nothing.
 */
export function issueTarget(manifest: Manifest): { kind: "github"; url: string } | { kind: "page"; url: string } | null {
  const bugs = urlOf(manifest.bugs);
  const fromBugs = githubRepository(bugs?.replace(/\/issues\/?.*$/, ""));
  if (fromBugs) return { kind: "github", url: `${fromBugs}/issues/new` };
  const fromRepository = githubRepository(urlOf(manifest.repository));
  if (fromRepository) return { kind: "github", url: `${fromRepository}/issues/new` };
  if (bugs && /^https?:/i.test(bugs)) return { kind: "page", url: bugs };
  return null;
}

/** The issue's markdown body: the user's text, then the versions (and the extension's data). */
export function issueBody(
  description: string,
  system: IssueSystemInfo | null,
  extension: { id: string; version?: string } | null,
  extensionData?: string,
): string {
  const lines = [description.trim() || "<!-- Describe the issue -->", ""];
  if (extension) lines.push(`Extension version: ${extension.id}@${extension.version ?? "?"}`);
  if (system) lines.push(`${system.app}`, `OS: ${system.os}`, `Runtime: ${system.runtime}`);
  if (extensionData) lines.push("", "<details><summary>Extension data</summary>", "", extensionData, "", "</details>");
  return lines.join("\n");
}

/** The GitHub URL that opens the "new issue" form filled in. */
export function githubIssueUrl(newIssueUrl: string, title: string, body: string): string {
  return `${newIssueUrl}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}
