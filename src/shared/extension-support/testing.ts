import type { AreaSupport } from "./types.ts";

/** Support table changes of the "testing" area. */
export const testingSupport: AreaSupport = {
  api: {
    "tests.*": null,
    "tests.createTestController": [
      "partial",
      "controllers, items, run/debug/coverage profiles, runs with results, output and coverage, continuous runs; profile configureHandler and request.preserveFocus are not used",
    ],
  },
  types: [
    "TestRunProfileKind",
    "TestTag",
    "TestMessage",
    "TestRunRequest",
    "TestMessageStackFrame",
    "TestCoverageCount",
    "FileCoverage",
    "StatementCoverage",
    "BranchCoverage",
    "DeclarationCoverage",
  ],
};
