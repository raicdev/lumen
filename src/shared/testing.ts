/** Wire types between the testing host feature (extension host) and its view (window). Types only plus tiny pure helpers. */

export type TestState = "queued" | "running" | "passed" | "failed" | "errored" | "skipped";

export type TestRange = { startLine: number; startCharacter: number; endLine: number; endCharacter: number };

/** Id of a test: the controller id and the ids of its ancestors, joined by NUL. */
export const TEST_ID_SEPARATOR = "\u0000";

export type TestWireItem = {
  id: string;
  label: string;
  description?: string;
  path?: string;
  range?: TestRange;
  tags: string[];
  busy: boolean;
  canResolve: boolean;
  error?: string;
  children: TestWireItem[];
};

export type TestWireProfile = {
  id: string;
  label: string;
  /** TestRunProfileKind: 1 run, 2 debug, 3 coverage. */
  kind: number;
  isDefault: boolean;
  tag?: string;
  supportsContinuousRun: boolean;
};

export type TestWireController = {
  id: string;
  label: string;
  canRefresh: boolean;
  refreshing: boolean;
  profiles: TestWireProfile[];
  items: TestWireItem[];
};

export type TestWireMessage = {
  message: string;
  markdown: boolean;
  expected?: string;
  actual?: string;
  /** TestMessage.contextValue (the `testMessage` context key of testing/message/* menus). */
  contextValue?: string;
  path?: string;
  range?: TestRange;
  stack?: { label: string; path?: string; line?: number; character?: number }[];
};

export type TestWireCoverageFile = {
  index: number;
  path: string;
  statements: { covered: number; total: number };
  branches?: { covered: number; total: number };
  declarations?: { covered: number; total: number };
};

export type TestWireCoverageDetail =
  | { kind: "statement"; executed: number | boolean; range: TestRange; branches: { executed: number | boolean; label?: string; range?: TestRange }[] }
  | { kind: "declaration"; name: string; executed: number | boolean; range: TestRange };

/** Host -> window messages. */
export type TestingHostEvent =
  | { kind: "tree"; controllers: TestWireController[] }
  | { kind: "runStart"; runId: string; name: string; controllerId: string; profile?: string; profileKind?: number; persist: boolean }
  | { kind: "state"; runId: string; testId: string; state: TestState; duration?: number; messages?: TestWireMessage[] }
  | { kind: "output"; runId: string; text: string; testId?: string; path?: string; range?: TestRange }
  | { kind: "coverage"; runId: string; file: TestWireCoverageFile }
  | { kind: "runEnd"; runId: string }
  | { kind: "invalidate"; ids: string[] | null }
  | { kind: "error"; message: string };

/** Window -> host messages. */
export type TestingViewMessage =
  | { kind: "resolve"; id: string }
  | { kind: "refresh"; controllerId: string }
  | { kind: "cancel"; runId?: string }
  | { kind: "setDefaults"; profileIds: string[] };

export type TestRunArgs = {
  /** Limits the run to one controller (default: all of them). */
  controllerId?: string;
  kind: number;
  /** Test ids; empty runs everything of the controller(s). */
  include: string[];
  exclude?: string[];
  /** Explicit profiles (ids from TestWireProfile); otherwise the default profiles of `kind`. */
  profileIds?: string[];
};

export const STATE_PRIORITY: Record<TestState, number> = { errored: 5, failed: 4, running: 3, queued: 2, passed: 1, skipped: 0 };
