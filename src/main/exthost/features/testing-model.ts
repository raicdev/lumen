import { CancellationTokenSource, EventEmitter, Location, MarkdownString, Position, Range, Uri } from "../types.ts";
import type { CancellationToken, Disposable } from "../types.ts";
import { TEST_ID_SEPARATOR } from "../../../shared/testing.ts";
import type {
  TestRange,
  TestRunArgs,
  TestState,
  TestWireController,
  TestWireCoverageDetail,
  TestWireItem,
  TestWireMessage,
  TestWireProfile,
  TestingHostEvent,
} from "../../../shared/testing.ts";

/**
 * The model behind `vscode.tests`: controllers, test items, run profiles and
 * test runs. It talks to the window through a `Sink`, so it has no dependency
 * on the extension host itself.
 */

/** State of a continuous run: one per profile and set of included tests. */
export type ContinuousRunInfo = {
  key: string;
  profileId: string;
  controllerId: string;
  label: string;
  kind: number;
  /** Included item ids; empty means every test of the controller. */
  testIds: string[];
  running: boolean;
  /** The latest run the handler created for the request. */
  runId?: string;
};

/** Host -> window message listing the active continuous runs. */
export type TestingContinuousEvent = { kind: "continuous"; runs: ContinuousRunInfo[] };

export type TestingEvent = TestingHostEvent | TestingContinuousEvent;

export type TestingSink = {
  post(event: TestingEvent): void;
  log(level: "info" | "warning" | "error", message: string): void;
};

/** Key of a continuous run: its profile and included tests (the window builds the same one). */
export function continuousKey(profileId: string, testIds: readonly string[]): string {
  return `${profileId}${TEST_ID_SEPARATOR}${[...testIds].sort().join("\u0001")}`;
}

type Thenable<T> = PromiseLike<T>;

/* ── classes exported by the API ─────────────────────────────────────────── */

export const TestRunProfileKind = Object.freeze({ Run: 1, Debug: 2, Coverage: 3 });

export class TestTag {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}

export class TestMessageStackFrame {
  label: string;
  uri?: Uri;
  position?: Position;
  constructor(label: string, uri?: Uri, position?: Position) {
    this.label = label;
    this.uri = uri;
    this.position = position;
  }
}

export class TestMessage {
  message: string | MarkdownString;
  expectedOutput?: string;
  actualOutput?: string;
  location?: Location;
  contextValue?: string;
  stackTrace?: TestMessageStackFrame[];
  constructor(message: string | MarkdownString) {
    this.message = message;
  }
  static diff(message: string | MarkdownString, expected: string, actual: string): TestMessage {
    const result = new TestMessage(message);
    result.expectedOutput = expected;
    result.actualOutput = actual;
    return result;
  }
}

export class TestRunRequest {
  readonly include: readonly TestItemImpl[] | undefined;
  readonly exclude: readonly TestItemImpl[] | undefined;
  readonly profile: TestRunProfileImpl | undefined;
  readonly continuous: boolean | undefined;
  readonly preserveFocus: boolean;
  constructor(include?: readonly TestItemImpl[], exclude?: readonly TestItemImpl[], profile?: TestRunProfileImpl, continuous?: boolean, preserveFocus = true) {
    this.include = include;
    this.exclude = exclude;
    this.profile = profile;
    this.continuous = continuous;
    this.preserveFocus = preserveFocus;
  }
}

export class TestCoverageCount {
  covered: number;
  total: number;
  constructor(covered: number, total: number) {
    if (covered > total) throw new Error("The total number of covered items must be less than or equal to the total number of items");
    this.covered = covered;
    this.total = total;
  }
}

export class BranchCoverage {
  executed: number | boolean;
  location?: Range | Position;
  label?: string;
  constructor(executed: number | boolean, location?: Range | Position, label?: string) {
    this.executed = executed;
    this.location = location;
    this.label = label;
  }
}

export class StatementCoverage {
  executed: number | boolean;
  location: Range | Position;
  branches: BranchCoverage[];
  constructor(executed: number | boolean, location: Range | Position, branches: BranchCoverage[] = []) {
    this.executed = executed;
    this.location = location;
    this.branches = branches;
  }
}

export class DeclarationCoverage {
  name: string;
  executed: number | boolean;
  location: Range | Position;
  constructor(name: string, executed: number | boolean, location: Range | Position) {
    this.name = name;
    this.executed = executed;
    this.location = location;
  }
}

const isExecuted = (executed: number | boolean): boolean => (typeof executed === "number" ? executed > 0 : executed);

export class FileCoverage {
  readonly uri: Uri;
  statementCoverage: TestCoverageCount;
  branchCoverage?: TestCoverageCount;
  declarationCoverage?: TestCoverageCount;
  includesTests?: TestItemImpl[];
  constructor(
    uri: Uri,
    statementCoverage: TestCoverageCount,
    branchCoverage?: TestCoverageCount,
    declarationCoverage?: TestCoverageCount,
    includesTests?: TestItemImpl[],
  ) {
    this.uri = uri;
    this.statementCoverage = statementCoverage;
    this.branchCoverage = branchCoverage;
    this.declarationCoverage = declarationCoverage;
    this.includesTests = includesTests;
  }
  /** Summarises detailed coverage into the counts of a FileCoverage. */
  static fromDetails(uri: Uri, details: readonly (StatementCoverage | DeclarationCoverage)[]): FileCoverage {
    let statements = 0;
    let coveredStatements = 0;
    let branches = 0;
    let coveredBranches = 0;
    let declarations = 0;
    let coveredDeclarations = 0;
    for (const detail of details) {
      if (detail instanceof DeclarationCoverage) {
        declarations++;
        if (isExecuted(detail.executed)) coveredDeclarations++;
        continue;
      }
      statements++;
      if (isExecuted(detail.executed)) coveredStatements++;
      for (const branch of detail.branches) {
        branches++;
        if (isExecuted(branch.executed)) coveredBranches++;
      }
    }
    return new FileCoverage(
      uri,
      new TestCoverageCount(coveredStatements, statements),
      branches ? new TestCoverageCount(coveredBranches, branches) : undefined,
      declarations ? new TestCoverageCount(coveredDeclarations, declarations) : undefined,
    );
  }
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

const fsPathOf = (uri: Uri | undefined): string | undefined => (uri ? uri.fsPath : undefined);

function wireRange(range: Range | Position | undefined): TestRange | undefined {
  if (!range) return undefined;
  const start = range instanceof Position ? range : range.start;
  const end = range instanceof Position ? range : range.end;
  return { startLine: start.line, startCharacter: start.character, endLine: end.line, endCharacter: end.character };
}

function wireMessage(message: TestMessage): TestWireMessage {
  const markdown = typeof message.message !== "string";
  return {
    message: typeof message.message === "string" ? message.message : (message.message?.value ?? ""),
    markdown,
    expected: message.expectedOutput,
    actual: message.actualOutput,
    contextValue: message.contextValue,
    path: fsPathOf(message.location?.uri),
    range: wireRange(message.location?.range),
    stack: message.stackTrace?.map((frame) => ({
      label: frame.label,
      path: fsPathOf(frame.uri),
      line: frame.position?.line,
      character: frame.position?.character,
    })),
  };
}

/* ── test items ──────────────────────────────────────────────────────────── */

type Owner = { controller: ControllerImpl; item: TestItemImpl | undefined };

export class TestItemCollection implements Iterable<[string, TestItemImpl]> {
  #items = new Map<string, TestItemImpl>();
  #owner: Owner;
  constructor(owner: Owner) {
    this.#owner = owner;
  }
  get size(): number {
    return this.#items.size;
  }
  replace(items: readonly TestItemImpl[]): void {
    const next = new Map(items.map((item) => [item.id, item]));
    for (const [id, item] of this.#items) {
      if (next.get(id) !== item) item._detach();
    }
    this.#items = new Map();
    for (const item of items) this.add(item);
    this.#owner.controller.schedule();
  }
  forEach(callback: (item: TestItemImpl, collection: TestItemCollection) => unknown, thisArg?: unknown): void {
    for (const item of [...this.#items.values()]) callback.call(thisArg, item, this);
  }
  add(item: TestItemImpl): void {
    if (!(item instanceof TestItemImpl)) throw new Error("Expected a TestItem created with createTestItem");
    const existing = this.#items.get(item.id);
    if (existing && existing !== item) existing._detach();
    item._attach(this.#owner.item, this.#owner.controller);
    this.#items.set(item.id, item);
    this.#owner.controller.schedule();
  }
  delete(itemId: string): void {
    const item = this.#items.get(itemId);
    if (!item) return;
    item._detach();
    this.#items.delete(itemId);
    this.#owner.controller.schedule();
  }
  get(itemId: string): TestItemImpl | undefined {
    return this.#items.get(itemId);
  }
  [Symbol.iterator](): Iterator<[string, TestItemImpl]> {
    return [...this.#items.entries()][Symbol.iterator]();
  }
  values(): TestItemImpl[] {
    return [...this.#items.values()];
  }
}

export class TestItemImpl {
  readonly id: string;
  readonly uri: Uri | undefined;
  readonly children: TestItemCollection;
  #controller: ControllerImpl;
  #parent: TestItemImpl | undefined;
  #label: string;
  #description: string | undefined;
  #range: Range | undefined;
  #tags: TestTag[] = [];
  #canResolveChildren = false;
  #busy = false;
  #error: string | MarkdownString | undefined;

  constructor(controller: ControllerImpl, id: string, label: string, uri?: Uri) {
    this.#controller = controller;
    this.id = id;
    this.uri = uri;
    this.#label = label;
    this.children = new TestItemCollection({ controller, item: this });
  }
  get parent(): TestItemImpl | undefined {
    return this.#parent;
  }
  get controller(): ControllerImpl {
    return this.#controller;
  }
  get label(): string {
    return this.#label;
  }
  set label(value: string) {
    this.#label = value;
    this.#controller.schedule();
  }
  get description(): string | undefined {
    return this.#description;
  }
  set description(value: string | undefined) {
    this.#description = value;
    this.#controller.schedule();
  }
  get range(): Range | undefined {
    return this.#range;
  }
  set range(value: Range | undefined) {
    this.#range = value;
    this.#controller.schedule();
  }
  get tags(): readonly TestTag[] {
    return this.#tags;
  }
  set tags(value: readonly TestTag[]) {
    this.#tags = [...value];
    this.#controller.schedule();
  }
  get canResolveChildren(): boolean {
    return this.#canResolveChildren;
  }
  set canResolveChildren(value: boolean) {
    this.#canResolveChildren = value;
    this.#controller.schedule();
  }
  get busy(): boolean {
    return this.#busy;
  }
  set busy(value: boolean) {
    this.#busy = value;
    this.#controller.schedule();
  }
  get error(): string | MarkdownString | undefined {
    return this.#error;
  }
  set error(value: string | MarkdownString | undefined) {
    this.#error = value;
    this.#controller.schedule();
  }

  /** @internal */
  _attach(parent: TestItemImpl | undefined, controller: ControllerImpl): void {
    if (controller !== this.#controller) throw new Error("Cannot add a test item of another controller");
    this.#parent = parent;
  }
  /** @internal */
  _detach(): void {
    this.#parent = undefined;
  }
  /** Id of the test across the window: controller id and the ids of its ancestors. */
  get wireId(): string {
    const path: string[] = [];
    for (let item: TestItemImpl | undefined = this; item; item = item.parent) path.unshift(item.id);
    return [this.#controller.id, ...path].join(TEST_ID_SEPARATOR);
  }
}

/* ── run profiles ────────────────────────────────────────────────────────── */

export type RunHandler = (request: TestRunRequest, token: CancellationToken) => Thenable<void> | void;

export class TestRunProfileImpl {
  readonly kind: number;
  readonly onDidChangeDefault: (listener: (isDefault: boolean) => unknown) => Disposable;
  runHandler: RunHandler;
  configureHandler: (() => void) | undefined;
  loadDetailedCoverage:
    | ((testRun: TestRunImpl, fileCoverage: FileCoverage, token: CancellationToken) => Thenable<(StatementCoverage | DeclarationCoverage)[]>)
    | undefined;
  loadDetailedCoverageForTest:
    | ((
        testRun: TestRunImpl,
        fileCoverage: FileCoverage,
        testItem: TestItemImpl,
        token: CancellationToken,
      ) => Thenable<(StatementCoverage | DeclarationCoverage)[]>)
    | undefined;
  readonly index: number;
  readonly #controller: ControllerImpl;
  readonly #changeDefault = new EventEmitter<boolean>();
  #label: string;
  #isDefault: boolean;
  #tag: TestTag | undefined;
  #supportsContinuousRun: boolean;

  constructor(
    controller: ControllerImpl,
    index: number,
    label: string,
    kind: number,
    runHandler: RunHandler,
    isDefault: boolean,
    tag: TestTag | undefined,
    supportsContinuousRun: boolean,
  ) {
    this.#controller = controller;
    this.index = index;
    this.#label = label;
    this.kind = kind;
    this.runHandler = runHandler;
    this.#isDefault = isDefault;
    this.#tag = tag;
    this.#supportsContinuousRun = supportsContinuousRun;
    this.onDidChangeDefault = this.#changeDefault.event as (listener: (isDefault: boolean) => unknown) => Disposable;
  }
  get id(): string {
    return `${this.#controller.id}${TEST_ID_SEPARATOR}#${this.index}`;
  }
  get controller(): ControllerImpl {
    return this.#controller;
  }
  get label(): string {
    return this.#label;
  }
  set label(value: string) {
    this.#label = value;
    this.#controller.schedule();
  }
  get isDefault(): boolean {
    return this.#isDefault;
  }
  set isDefault(value: boolean) {
    if (value === this.#isDefault) return;
    this.#isDefault = value;
    this.#changeDefault.fire(value);
    this.#controller.schedule();
  }
  get tag(): TestTag | undefined {
    return this.#tag;
  }
  set tag(value: TestTag | undefined) {
    this.#tag = value;
    this.#controller.schedule();
  }
  get supportsContinuousRun(): boolean {
    return this.#supportsContinuousRun;
  }
  set supportsContinuousRun(value: boolean) {
    if (value === this.#supportsContinuousRun) return;
    this.#supportsContinuousRun = value;
    if (!value) this.#controller.stopContinuous(this);
    this.#controller.schedule();
  }
  dispose(): void {
    this.#controller.removeProfile(this);
  }
  toWire(): TestWireProfile {
    return {
      id: this.id,
      label: this.#label,
      kind: this.kind,
      isDefault: this.#isDefault,
      tag: this.#tag?.id,
      supportsContinuousRun: this.#supportsContinuousRun,
    };
  }
}

/* ── test runs ───────────────────────────────────────────────────────────── */

export class TestRunImpl {
  readonly name: string | undefined;
  readonly token: CancellationToken;
  readonly isPersisted: boolean;
  readonly onDidDispose: (listener: () => unknown) => Disposable;
  readonly runId: string;
  readonly profile: TestRunProfileImpl | undefined;
  readonly files: FileCoverage[] = [];
  readonly #model: TestingModel;
  readonly #dispose = new EventEmitter<void>();
  #ended = false;

  constructor(
    model: TestingModel,
    runId: string,
    controller: ControllerImpl,
    request: TestRunRequest,
    name: string | undefined,
    persist: boolean,
    token: CancellationToken,
  ) {
    this.#model = model;
    this.runId = runId;
    this.name = name;
    this.isPersisted = persist;
    this.token = token;
    this.profile = request.profile;
    this.onDidDispose = this.#dispose.event as (listener: () => unknown) => Disposable;
    model.post({
      kind: "runStart",
      runId,
      name: name ?? request.profile?.label ?? controller.label,
      controllerId: controller.id,
      profile: request.profile?.label,
      profileKind: request.profile?.kind,
      persist,
    });
  }
  #state(test: TestItemImpl, state: TestState, duration?: number, messages?: TestWireMessage[]): void {
    if (this.#ended) return;
    this.#model.post({ kind: "state", runId: this.runId, testId: test.wireId, state, duration, messages });
  }
  enqueued(test: TestItemImpl): void {
    this.#state(test, "queued");
  }
  started(test: TestItemImpl): void {
    this.#state(test, "running");
  }
  skipped(test: TestItemImpl): void {
    this.#state(test, "skipped");
  }
  failed(test: TestItemImpl, message: TestMessage | readonly TestMessage[], duration?: number): void {
    if (!this.#ended) this.#model.keepMessages(this.runId, test.wireId, [message].flat());
    this.#state(test, "failed", duration, [message].flat().map(wireMessage));
  }
  errored(test: TestItemImpl, message: TestMessage | readonly TestMessage[], duration?: number): void {
    if (!this.#ended) this.#model.keepMessages(this.runId, test.wireId, [message].flat());
    this.#state(test, "errored", duration, [message].flat().map(wireMessage));
  }
  passed(test: TestItemImpl, duration?: number): void {
    this.#state(test, "passed", duration);
  }
  appendOutput(output: string, location?: Location, test?: TestItemImpl): void {
    if (this.#ended) return;
    this.#model.post({
      kind: "output",
      runId: this.runId,
      text: String(output),
      testId: test?.wireId,
      path: fsPathOf(location?.uri),
      range: wireRange(location?.range),
    });
  }
  addCoverage(fileCoverage: FileCoverage): void {
    if (this.#ended) return;
    this.files.push(fileCoverage);
    const count = (value: TestCoverageCount | undefined) => (value ? { covered: value.covered, total: value.total } : undefined);
    this.#model.post({
      kind: "coverage",
      runId: this.runId,
      file: {
        index: this.files.length - 1,
        path: fileCoverage.uri.fsPath,
        statements: count(fileCoverage.statementCoverage) ?? { covered: 0, total: 0 },
        branches: count(fileCoverage.branchCoverage),
        declarations: count(fileCoverage.declarationCoverage),
      },
    });
  }
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#model.post({ kind: "runEnd", runId: this.runId });
    this.#dispose.fire();
  }
  get ended(): boolean {
    return this.#ended;
  }
}

/* ── controllers ─────────────────────────────────────────────────────────── */

export class ControllerImpl {
  readonly id: string;
  readonly items: TestItemCollection;
  readonly profiles: TestRunProfileImpl[] = [];
  readonly extensionId: string;
  readonly resolving = new Set<TestItemImpl>();
  refreshing = false;
  disposed = false;
  #label: string;
  #resolveHandler: ((item: TestItemImpl | undefined) => Thenable<void> | void) | undefined;
  #refreshHandler: ((token: CancellationToken) => Thenable<void> | void) | undefined;
  #model: TestingModel;
  #profileCounter = 0;
  #resolvedRoot: unknown;

  constructor(model: TestingModel, extensionId: string, id: string, label: string) {
    this.#model = model;
    this.extensionId = extensionId;
    this.id = id;
    this.#label = label;
    this.items = new TestItemCollection({ controller: this, item: undefined });
  }
  get label(): string {
    return this.#label;
  }
  set label(value: string) {
    this.#label = value;
    this.schedule();
  }
  get refreshHandler(): ((token: CancellationToken) => Thenable<void> | void) | undefined {
    return this.#refreshHandler;
  }
  set refreshHandler(handler) {
    this.#refreshHandler = handler;
    this.schedule();
  }
  get resolveHandler(): ((item: TestItemImpl | undefined) => Thenable<void> | void) | undefined {
    return this.#resolveHandler;
  }
  set resolveHandler(handler) {
    this.#resolveHandler = handler;
    // The explorer asks for the root items once a handler is there.
    if (handler && this.#resolvedRoot !== handler) {
      this.#resolvedRoot = handler;
      setTimeout(() => {
        if (!this.disposed && this.#resolveHandler === handler) void this.resolve(undefined);
      }, 0);
    }
  }
  schedule(): void {
    this.#model.scheduleTree();
  }
  createTestItem(id: string, label: string, uri?: Uri): TestItemImpl {
    if (id.includes(TEST_ID_SEPARATOR)) throw new Error("Test item ids cannot contain NUL characters");
    return new TestItemImpl(this, id, label, uri);
  }
  createRunProfile(label: string, kind: number, runHandler: RunHandler, isDefault = false, tag?: TestTag, supportsContinuousRun = false): TestRunProfileImpl {
    const profile = new TestRunProfileImpl(this, this.#profileCounter++, label, kind, runHandler, isDefault, tag, supportsContinuousRun);
    this.profiles.push(profile);
    this.schedule();
    return profile;
  }
  removeProfile(profile: TestRunProfileImpl): void {
    this.stopContinuous(profile);
    const index = this.profiles.indexOf(profile);
    if (index >= 0) this.profiles.splice(index, 1);
    this.schedule();
  }
  createTestRun(request: TestRunRequest, name?: string, persist = true): TestRunImpl {
    return this.#model.createRun(this, request, name, persist);
  }
  invalidateTestResults(items?: TestItemImpl | readonly TestItemImpl[]): void {
    const ids = items === undefined ? null : [items].flat().map((item) => item.wireId);
    this.#model.post({ kind: "invalidate", ids });
  }
  /** Stop the controller's continuous runs (or those of one of its profiles). */
  stopContinuous(profile?: TestRunProfileImpl): void {
    this.#model.stopContinuous(profile ? { profileId: profile.id } : { controllerId: this.id });
  }
  /** Look an item up by the path of ids (below the controller). */
  find(path: string[]): TestItemImpl | undefined {
    let collection: TestItemCollection = this.items;
    let item: TestItemImpl | undefined;
    for (const segment of path) {
      item = collection.get(segment);
      if (!item) return undefined;
      collection = item.children;
    }
    return item;
  }
  /** Run the resolve handler (for one item, or the root when undefined). */
  async resolve(item: TestItemImpl | undefined): Promise<void> {
    const handler = this.#resolveHandler;
    if (!handler) return;
    if (item) this.resolving.add(item);
    this.schedule();
    try {
      await handler(item);
    } catch (error) {
      this.#model.sink.log("error", `Test resolve handler of "${this.id}" failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (item) this.resolving.delete(item);
      this.schedule();
    }
  }
  async refresh(): Promise<void> {
    const handler = this.#refreshHandler;
    if (!handler || this.refreshing) return;
    this.refreshing = true;
    this.schedule();
    const source = new CancellationTokenSource();
    try {
      await handler(source.token);
    } catch (error) {
      this.#model.sink.log("error", `Test refresh handler of "${this.id}" failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      source.dispose();
      this.refreshing = false;
      this.schedule();
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.#model.stopContinuous({ controllerId: this.id });
    this.#model.removeController(this);
  }
  toWire(): TestWireController {
    const wireItem = (item: TestItemImpl): TestWireItem => ({
      id: item.wireId,
      label: item.label,
      description: item.description,
      path: fsPathOf(item.uri),
      range: wireRange(item.range),
      tags: item.tags.map((tag) => tag.id),
      busy: item.busy || this.resolving.has(item),
      canResolve: item.canResolveChildren,
      error: item.error === undefined ? undefined : typeof item.error === "string" ? item.error : item.error.value,
      children: item.children.values().map(wireItem),
    });
    return {
      id: this.id,
      label: this.#label,
      canRefresh: !!this.#refreshHandler,
      refreshing: this.refreshing,
      profiles: this.profiles.map((profile) => profile.toWire()),
      items: this.items.values().map(wireItem),
    };
  }
}

/* ── the model ───────────────────────────────────────────────────────────── */

const KEPT_RUNS = 10;

type ContinuousSession = {
  key: string;
  profile: TestRunProfileImpl;
  testIds: string[];
  request: TestRunRequest;
  source: CancellationTokenSource;
  runIds: string[];
};

export class TestingModel {
  readonly controllers = new Map<string, ControllerImpl>();
  readonly sink: TestingSink;
  /** The latest runs by id (for detailed coverage). */
  readonly #runs = new Map<string, TestRunImpl>();
  /** Cancellation sources of everything that is running. */
  readonly #sessions = new Map<string, CancellationTokenSource>();
  readonly #requestSessions = new WeakMap<TestRunRequest, string>();
  /** Active continuous runs by key (profile + included tests). */
  readonly #continuous = new Map<string, ContinuousSession>();
  readonly #continuousRequests = new WeakMap<TestRunRequest, ContinuousSession>();
  #runCounter = 0;
  #sessionCounter = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** The messages of failed tests by run and test (testing/message/* menus give them to commands); the latest ones only. */
  readonly #messages = new Map<string, TestMessage[]>();

  constructor(sink: TestingSink) {
    this.sink = sink;
  }
  keepMessages(runId: string, testId: string, messages: TestMessage[]): void {
    const key = `${runId} ${testId}`;
    this.#messages.delete(key);
    this.#messages.set(key, messages);
    while (this.#messages.size > 2000) this.#messages.delete(this.#messages.keys().next().value!);
  }
  message(runId: string, testId: string, index: number): TestMessage | undefined {
    return this.#messages.get(`${runId} ${testId}`)?.[index];
  }
  post(event: TestingEvent): void {
    this.sink.post(event);
  }
  scheduleTree(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => this.flush(), 10);
  }
  /** Send the tree now. */
  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.post({ kind: "tree", controllers: this.snapshot() });
  }
  snapshot(): TestWireController[] {
    return [...this.controllers.values()].map((controller) => controller.toWire());
  }
  createController(extensionId: string, id: string, label: string): ControllerImpl {
    if (this.controllers.has(id)) throw new Error(`Attempt to insert a duplicate controller with ID "${id}"`);
    const controller = new ControllerImpl(this, extensionId, id, label);
    this.controllers.set(id, controller);
    this.scheduleTree();
    return controller;
  }
  removeController(controller: ControllerImpl): void {
    if (this.controllers.get(controller.id) === controller) this.controllers.delete(controller.id);
    this.scheduleTree();
  }
  createRun(controller: ControllerImpl, request: TestRunRequest, name: string | undefined, persist: boolean): TestRunImpl {
    const sessionId = this.#requestSessions.get(request);
    const continuous = this.#continuousRequests.get(request);
    let token = continuous ? continuous.source.token : sessionId ? this.#sessions.get(sessionId)?.token : undefined;
    const runId = `run-${++this.#runCounter}`;
    if (!token) {
      // A run an extension starts on its own: the window can still cancel it.
      const own = new CancellationTokenSource();
      this.#sessions.set(runId, own);
      token = own.token;
    }
    const run = new TestRunImpl(this, runId, controller, request, name, persist, token);
    this.#runs.set(runId, run);
    run.onDidDispose(() => {
      const own = this.#sessions.get(runId);
      if (own) {
        own.dispose();
        this.#sessions.delete(runId);
      }
    });
    if (continuous) {
      continuous.runIds.push(runId);
      this.postContinuous();
    }
    while (this.#runs.size > KEPT_RUNS) this.#runs.delete(this.#runs.keys().next().value!);
    return run;
  }

  /** Find a test by its window id. */
  findItem(wireId: string): TestItemImpl | undefined {
    const [controllerId, ...path] = wireId.split(TEST_ID_SEPARATOR);
    return this.controllers.get(controllerId!)?.find(path);
  }
  findProfile(id: string): TestRunProfileImpl | undefined {
    const [controllerId] = id.split(TEST_ID_SEPARATOR);
    return this.controllers.get(controllerId!)?.profiles.find((profile) => profile.id === id);
  }

  /** Send the active continuous runs to the window. */
  postContinuous(): void {
    this.post({
      kind: "continuous",
      runs: [...this.#continuous.values()].map((session) => ({
        key: session.key,
        profileId: session.profile.id,
        controllerId: session.profile.controller.id,
        label: session.profile.label,
        kind: session.profile.kind,
        testIds: session.testIds,
        running: true,
        runId: session.runIds.at(-1),
      })),
    });
  }

  /**
   * Start a continuous run: the profile's run handler is called once with
   * `continuous: true` and keeps running until the token is cancelled (or the
   * handler returns, as the API asks continuous handlers not to).
   */
  startContinuous(profile: TestRunProfileImpl, testIds: string[] = []): { started: number; key?: string; error?: string } {
    if (!profile.supportsContinuousRun) return { started: 0, error: `Test profile "${profile.label}" does not support continuous runs.` };
    const include = testIds.map((id) => this.findItem(id)).filter((item): item is TestItemImpl => !!item && item.controller === profile.controller);
    if (profile.tag && include.some((item) => !hasTag(item, profile.tag!))) {
      return { started: 0, error: `Test profile "${profile.label}" does not apply to these tests.` };
    }
    const ids = include.map((item) => item.wireId);
    const key = continuousKey(profile.id, ids);
    const existing = this.#continuous.get(key);
    if (existing) return { started: 0, key };
    const request = new TestRunRequest(include.length ? include : undefined, undefined, profile, true, true);
    const source = new CancellationTokenSource();
    const session: ContinuousSession = { key, profile, testIds: ids, request, source, runIds: [] };
    this.#continuous.set(key, session);
    this.#continuousRequests.set(request, session);
    this.postContinuous();
    void (async () => {
      try {
        await profile.runHandler(request, source.token);
      } catch (error) {
        const message = `Continuous test run of "${profile.label}" failed: ${error instanceof Error ? error.message : String(error)}`;
        this.sink.log("error", message);
        this.post({ kind: "error", message });
      } finally {
        this.#continuousRequests.delete(request);
        // Do not leave runs of a stopped continuous request spinning in the window.
        for (const runId of session.runIds) this.#runs.get(runId)?.end();
        if (this.#continuous.get(key) === session) this.#continuous.delete(key);
        source.dispose();
        this.postContinuous();
      }
    })();
    return { started: 1, key };
  }

  /** Start continuous runs from a command argument: a profile id or `{ profileId, controllerId, testIds, kind }`. */
  startContinuousByArgs(args?: unknown): { started: number; keys: string[]; error?: string } {
    const options: { profileId?: string; controllerId?: string; testIds?: string[]; kind?: number } =
      typeof args === "string"
        ? { profileId: args }
        : args && typeof args === "object"
          ? (args as { profileId?: string; controllerId?: string; testIds?: string[]; kind?: number })
          : {};
    const testIds = Array.isArray(options.testIds) ? options.testIds.map(String) : [];
    const profiles: TestRunProfileImpl[] = [];
    const explicitlyWanted = options.profileId !== undefined && options.profileId !== null;
    if (explicitlyWanted) {
      const profile = this.findProfile(String(options.profileId));
      if (profile) profiles.push(profile);
    } else {
      const wanted = options.controllerId
        ? [this.controllers.get(options.controllerId)].filter((controller): controller is ControllerImpl => !!controller)
        : [...this.controllers.values()];
      for (const controller of wanted) {
        const supporting = controller.profiles.filter(
          (profile) => profile.supportsContinuousRun && (options.kind === undefined || profile.kind === options.kind),
        );
        const defaults = supporting.filter((profile) => profile.isDefault);
        profiles.push(...(defaults.length ? defaults : supporting.slice(0, 1)));
      }
    }
    if (!profiles.length) return { started: 0, keys: [], error: "No test profile supports continuous runs." };
    const keys: string[] = [];
    let error: string | undefined;
    let started = 0;
    for (const profile of profiles) {
      const result = this.startContinuous(profile, testIds);
      if (result.key) keys.push(result.key);
      if (result.error) error = result.error;
      started += result.started;
    }
    return { started, keys, error };
  }

  /** Stop continuous runs by key, profile or controller; no filter stops all of them. */
  stopContinuous(filter?: string | { key?: string; profileId?: string; controllerId?: string; testIds?: string[] }): number {
    const matches = (session: ContinuousSession): boolean => {
      if (typeof filter === "string") return session.key === filter || session.profile.id === filter;
      const wanted = filter ?? {};
      if (wanted.key && session.key !== wanted.key) return false;
      if (wanted.profileId && session.profile.id !== wanted.profileId) return false;
      if (wanted.controllerId && session.profile.controller.id !== wanted.controllerId) return false;
      if (wanted.testIds && wanted.testIds.some((id) => !session.testIds.includes(id))) return false;
      return true;
    };
    let stopped = 0;
    for (const session of [...this.#continuous.values()]) {
      if (!matches(session)) continue;
      stopped++;
      // The run disappears from the window at once; the handler may still be
      // cleaning up until its token callback runs.
      this.#continuous.delete(session.key);
      this.#continuousRequests.delete(session.request);
      for (const runId of session.runIds) this.#runs.get(runId)?.end();
      session.source.cancel();
    }
    if (stopped) this.postContinuous();
    return stopped;
  }

  /** Stop continuous runs from a command argument: a key/profile id or `{ key, profileId, controllerId, testIds }`. */
  stopContinuousByArgs(args?: unknown): number {
    if (typeof args === "string") return this.stopContinuous(args);
    if (args && typeof args === "object") {
      const options = args as { key?: string; profileId?: string; controllerId?: string; testIds?: string[] };
      return this.stopContinuous({ key: options.key, profileId: options.profileId, controllerId: options.controllerId, testIds: options.testIds });
    }
    return this.stopContinuous();
  }

  /** Start the runs the window asked for; returns once the handlers were started (not finished). */
  startRun(args: TestRunArgs): { started: number; error?: string } {
    const include = args.include.map((id) => this.findItem(id)).filter((item): item is TestItemImpl => !!item);
    const exclude = (args.exclude ?? []).map((id) => this.findItem(id)).filter((item): item is TestItemImpl => !!item);
    const profiles: TestRunProfileImpl[] = [];
    if (args.profileIds?.length) {
      for (const id of args.profileIds) {
        const profile = this.findProfile(id);
        if (profile) profiles.push(profile);
      }
    } else {
      const wanted = args.controllerId ? [this.controllers.get(args.controllerId)].filter((c): c is ControllerImpl => !!c) : [...this.controllers.values()];
      // Items limit the run to the controllers they belong to.
      const owners = new Set(include.map((item) => item.controller));
      for (const controller of wanted) {
        if (owners.size && !owners.has(controller)) continue;
        const mine = include.filter((item) => item.controller === controller);
        const fitting = controller.profiles.filter(
          (profile) => profile.kind === args.kind && (!profile.tag || mine.length === 0 || mine.every((item) => hasTag(item, profile.tag!))),
        );
        const defaults = fitting.filter((profile) => profile.isDefault);
        profiles.push(...(defaults.length ? defaults : fitting.slice(0, 1)));
      }
    }
    if (!profiles.length) return { started: 0, error: "No test profile is available for this action." };
    for (const profile of profiles) {
      const controller = profile.controller;
      const mine = include.filter((item) => item.controller === controller);
      const request = new TestRunRequest(
        mine.length ? mine : undefined,
        exclude.filter((item) => item.controller === controller),
        profile,
        false,
        true,
      );
      const sessionId = `session-${++this.#sessionCounter}`;
      const source = new CancellationTokenSource();
      this.#sessions.set(sessionId, source);
      this.#requestSessions.set(request, sessionId);
      void (async () => {
        try {
          await profile.runHandler(request, source.token);
        } catch (error) {
          const message = `Test run of "${profile.label}" failed: ${error instanceof Error ? error.message : String(error)}`;
          this.sink.log("error", message);
          this.post({ kind: "error", message });
        } finally {
          this.#sessions.delete(sessionId);
          source.dispose();
        }
      })();
    }
    return { started: profiles.length };
  }
  /** Cancel one run (by run or session id), or all of them. */
  cancel(runId?: string): void {
    if (runId) {
      this.#sessions.get(runId)?.cancel();
      return;
    }
    for (const source of this.#sessions.values()) source.cancel();
  }
  setDefaults(profileIds: string[]): void {
    const wanted = new Set(profileIds);
    for (const controller of this.controllers.values()) {
      for (const profile of controller.profiles) profile.isDefault = wanted.has(profile.id);
    }
  }
  async detailedCoverage(runId: string, index: number, testId?: string): Promise<TestWireCoverageDetail[]> {
    const run = this.#runs.get(runId);
    const file = run?.files[index];
    const profile = run?.profile;
    if (!run || !file || !profile) return [];
    const source = new CancellationTokenSource();
    try {
      const test = testId ? this.findItem(testId) : undefined;
      let details: (StatementCoverage | DeclarationCoverage)[] = [];
      if (test && profile.loadDetailedCoverageForTest) details = await profile.loadDetailedCoverageForTest(run, file, test, source.token);
      else if (profile.loadDetailedCoverage) details = await profile.loadDetailedCoverage(run, file, source.token);
      return (details ?? []).map(wireDetail);
    } finally {
      source.dispose();
    }
  }
}

function hasTag(item: TestItemImpl, tag: TestTag): boolean {
  return item.tags.some((candidate) => candidate.id === tag.id);
}

function wireDetail(detail: StatementCoverage | DeclarationCoverage): TestWireCoverageDetail {
  const range = wireRange(detail.location)!;
  if (detail instanceof DeclarationCoverage) return { kind: "declaration", name: detail.name, executed: detail.executed, range };
  return {
    kind: "statement",
    executed: detail.executed,
    range,
    branches: detail.branches.map((branch) => ({ executed: branch.executed, label: branch.label, range: wireRange(branch.location) })),
  };
}
