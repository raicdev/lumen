import type { ExtensionHost } from "../host.ts";
import type { HostFeature } from "./contract.ts";
import { NOT_HANDLED } from "./contract.ts";
import type { TestRunArgs, TestingViewMessage } from "../../../shared/testing.ts";
import {
  BranchCoverage,
  DeclarationCoverage,
  FileCoverage,
  StatementCoverage,
  TestCoverageCount,
  TestMessage,
  TestMessageStackFrame,
  TestRunProfileKind,
  TestRunRequest,
  TestTag,
  TestingModel,
} from "./testing-model.ts";

/**
 * Host side of the "testing" area: `vscode.tests` (test controllers, items,
 * run profiles, test runs with results, output and coverage). The window shows
 * the tree and the results (src/mainview/features/testing.tsx).
 */

const models = new WeakMap<ExtensionHost, TestingModel>();

export function testingModel(host: ExtensionHost): TestingModel {
  let model = models.get(host);
  if (!model) {
    model = new TestingModel({
      post: (event) => host.postFeature("testing", event),
      log: (level, message) => host.log(level, message),
    });
    models.set(host, model);
  }
  return model;
}

const KIND_COMMANDS: Record<string, number> = {
  "testing.runAll": TestRunProfileKind.Run,
  "testing.debugAll": TestRunProfileKind.Debug,
  "testing.coverageAll": TestRunProfileKind.Coverage,
};

/** Window messages of continuous runs (the rest is in shared/testing.ts). */
type ContinuousViewMessage =
  | { kind: "startContinuous"; profileId: string; ids?: string[] }
  | { kind: "stopContinuous"; key?: string; profileId?: string; controllerId?: string };

export const testingFeature: HostFeature = {
  area: "testing",

  api: ({ host, extensionId }) => ({
    tests: {
      createTestController: (id: string, label: string) => testingModel(host).createController(extensionId, id, label),
    },
  }),

  types: {
    TestRunProfileKind,
    TestTag,
    TestMessage,
    TestRunRequest,
    TestMessageStackFrame,
    TestCoverageCount,
    FileCoverage,
    StatementCoverage,
    BranchCoverage,
    DeclarationCoverage,
  },

  commands: ["testing.runAll", "testing.debugAll", "testing.coverageAll", "testing.cancelRun", "testing.refreshTests", "testing.startContinuousRun", "testing.stopContinuousRun"],

  /**
   * testing/* menus: `{ item }` is the `TestItem`, `{ item, run, message }` VS Code's
   * `{ test, message }` of testing/message/*, `{ profile }` the `TestRunProfile`.
   */
  menuArg(host, ref) {
    const model = testingModel(host);
    if (typeof ref.profile === "string") return model.findProfile(ref.profile);
    const test = model.findItem(String(ref.item));
    if (ref.message === undefined) return test;
    const message = model.message(String(ref.run), String(ref.item), Number(ref.message));
    return test && message ? { test, message } : undefined;
  },

  onViewMessage(host, payload) {
    const model = testingModel(host);
    const message = payload as TestingViewMessage | ContinuousViewMessage;
    switch (message.kind) {
      case "resolve": {
        const item = model.findItem(message.id);
        void item?.controller.resolve(item);
        break;
      }
      case "refresh":
        void model.controllers.get(message.controllerId)?.refresh();
        break;
      case "cancel":
        model.cancel(message.runId);
        break;
      case "setDefaults":
        model.setDefaults(message.profileIds);
        break;
      case "startContinuous": {
        const profile = model.findProfile(message.profileId);
        if (!profile) {
          host.log("warning", `Unknown test profile: ${message.profileId}`);
          break;
        }
        const result = model.startContinuous(profile, message.ids ?? []);
        if (result.error) host.log("warning", result.error);
        break;
      }
      case "stopContinuous":
        model.stopContinuous({ key: message.key, profileId: message.profileId, controllerId: message.controllerId });
        break;
    }
  },

  onViewRequest(host, method, args) {
    const model = testingModel(host);
    switch (method) {
      case "snapshot": {
        const snapshot = model.snapshot();
        // The window may have restarted: tell it about the continuous runs that are still active.
        model.postContinuous();
        return snapshot;
      }
      case "run":
        return model.startRun(args[0] as TestRunArgs);
      case "detailedCoverage":
        return model.detailedCoverage(String(args[0]), Number(args[1]), args[2] as string | undefined);
      default:
        throw new Error(`Unknown testing request: ${method}`);
    }
  },

  async executeCommand(host, command, args) {
    const model = testingModel(host);
    if (command in KIND_COMMANDS) {
      const result = model.startRun({ kind: KIND_COMMANDS[command]!, include: [] });
      if (result.error) host.log("warning", result.error);
      return undefined;
    }
    if (command === "testing.startContinuousRun") {
      const result = model.startContinuousByArgs(args[0]);
      if (result.error) host.log("warning", result.error);
      return result.keys;
    }
    if (command === "testing.stopContinuousRun") {
      model.stopContinuousByArgs(args[0]);
      return undefined;
    }
    if (command === "testing.cancelRun") {
      model.cancel();
      return undefined;
    }
    if (command === "testing.refreshTests") {
      await Promise.all([...model.controllers.values()].map((controller) => controller.refresh()));
      return undefined;
    }
    return NOT_HANDLED;
  },
};
