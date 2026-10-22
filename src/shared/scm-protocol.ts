/** Wire types between the scm host feature (extension host) and its view (source control panel). */

export type ScmCommandData = { title: string; tooltip?: string };

export type ScmResourceData = {
  /** The view's document key of the resource (file path, or the URI string of a virtual file). */
  path: string;
  /** File name shown in the row. */
  label: string;
  /** Folder shown dimmed after the name. */
  description: string;
  tooltip?: string;
  strikeThrough?: boolean;
  faded?: boolean;
  contextValue?: string;
  /** One-letter decoration derived from the decoration tooltip ("Modified" -> "M"). */
  letter?: string;
  /** The state has its own command (otherwise a click opens the file). */
  hasCommand: boolean;
  /** Index in the group's `resourceStates` (states without a resource are not sent). */
  index: number;
};

export type ScmGroupData = {
  handle: number;
  id: string;
  label: string;
  hideWhenEmpty: boolean;
  resources: ScmResourceData[];
};

export type ScmControlData = {
  handle: number;
  extensionId: string;
  id: string;
  label: string;
  rootPath?: string;
  count: number;
  inputBox: { value: string; valueRev: number; placeholder: string; visible: boolean; enabled: boolean; validation?: { message: string; type: number } };
  accept?: ScmCommandData;
  statusBarCommands: ScmCommandData[];
  groups: ScmGroupData[];
  hasQuickDiff: boolean;
};

export type ScmSnapshot = { controls: ScmControlData[]; busy: number };

/** host -> view */
export type ScmHostMessage = { kind: "state"; snapshot: ScmSnapshot };

/** view -> host */
export type ScmViewMessage =
  | { kind: "ready" }
  | { kind: "input"; handle: number; value: string }
  | { kind: "accept"; handle: number }
  | { kind: "resource"; handle: number; group: number; index: number }
  | { kind: "statusCommand"; handle: number; index: number };
