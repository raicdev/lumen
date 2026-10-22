/**
 * A tiny fake Debug Adapter Protocol adapter, used by test/debug.test.ts.
 * It speaks `Content-Length`-framed JSON on stdio and implements just enough
 * of DAP for the debug client tests: initialize, launch, setBreakpoints,
 * configurationDone, threads, stackTrace, scopes, variables, evaluate,
 * continue, next and disconnect, emitting initialized/stopped/output/terminated.
 */

let buffer = Buffer.alloc(0);
let launchArguments = {};
let breakpoints = [];
let stopped = false;
let seq = 0;

function send(message) {
  const json = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function respond(request, body) {
  send({ seq: ++seq, type: "response", request_seq: request.seq, success: true, command: request.command, body: body ?? {} });
}

function fail(request, message) {
  send({ seq: ++seq, type: "response", request_seq: request.seq, success: false, command: request.command, message });
}

function event(name, body) {
  send({ seq: ++seq, type: "event", event: name, body: body ?? {} });
}

function lineOfFirstBreakpoint() {
  const first = breakpoints.find((bp) => bp.verified);
  return first ? first.line : 3;
}

function handle(request) {
  switch (request.command) {
    case "initialize":
      respond(request, {
        supportsConfigurationDoneRequest: true,
        supportsRestartRequest: true,
        exceptionBreakpointFilters: [{ filter: "uncaught", label: "Uncaught Exceptions", default: true }],
        // Not DAP: what the client's transport did (test/debug.test.ts reads it).
        ipc: !!process.send,
        argv: process.argv.slice(2),
      });
      return;
    case "launch":
    case "attach":
      launchArguments = request.arguments ?? {};
      respond(request);
      // The adapter is ready for breakpoints now (js-debug sends it after launch).
      event("initialized");
      // Optionally ask the client to start a child session (js-debug's startDebugging).
      if (launchArguments.startChild) {
        send({
          seq: ++seq,
          type: "request",
          command: "startDebugging",
          arguments: { request: "launch", configuration: { type: launchArguments.startChildType ?? "fake", name: "Child Session", request: "launch" } },
        });
      }
      return;
    case "setBreakpoints":
      breakpoints = (request.arguments?.breakpoints ?? []).map((bp) => ({ id: bp.line, verified: true, line: bp.line }));
      respond(request, { breakpoints });
      return;
    case "setFunctionBreakpoints":
    case "setExceptionBreakpoints":
    case "pause":
      respond(request);
      return;
    case "configurationDone":
      respond(request);
      event("output", { category: "stdout", output: "fake adapter ready\n" });
      event("output", { category: "console", output: `arguments:${JSON.stringify(launchArguments)}\n` });
      // Stop on the breakpoint (or line 3) so the client can read the stack.
      stopped = true;
      event("stopped", { reason: "breakpoint", threadId: 1, allThreadsStopped: true, description: "Paused on breakpoint" });
      return;
    case "threads":
      respond(request, { threads: [{ id: 1, name: "Main Thread" }] });
      return;
    case "stackTrace":
      respond(request, {
        stackFrames: [
          {
            id: 100,
            name: "main",
            line: lineOfFirstBreakpoint(),
            column: 1,
            source: { name: "main.js", path: launchArguments.program ?? "main.js" },
          },
          { id: 101, name: "run", line: 1, column: 1, source: { name: "main.js", path: launchArguments.program ?? "main.js" } },
        ],
        totalFrames: 2,
      });
      return;
    case "scopes":
      respond(request, { scopes: [{ name: "Locals", variablesReference: 1000, expensive: false }] });
      return;
    case "variables":
      respond(request, {
        variables: [
          { name: "counter", value: "42", type: "number", variablesReference: 0, evaluateName: "counter" },
          { name: "greeting", value: '"hello"', type: "string", variablesReference: 0 },
        ],
      });
      return;
    case "evaluate":
      if (String(request.arguments?.expression ?? "").includes("fail")) {
        fail(request, "cannot evaluate fail");
        return;
      }
      respond(request, { result: "42", type: "number", variablesReference: 0 });
      return;
    case "setVariable":
      respond(request, { value: request.arguments?.value ?? "", type: "string", variablesReference: 0 });
      return;
    case "continue":
      respond(request, { allThreadsContinued: true });
      if (stopped) {
        stopped = false;
        event("exited", { exitCode: 0 });
        event("terminated");
      }
      return;
    case "next":
    case "stepIn":
    case "stepOut":
      respond(request);
      stopped = true;
      event("stopped", { reason: "step", threadId: 1, allThreadsStopped: true });
      return;
    case "disconnect":
      respond(request);
      event("terminated");
      setTimeout(() => process.exit(0), 10);
      return;
    case "restart":
      respond(request);
      event("stopped", { reason: "restart", threadId: 1, allThreadsStopped: true });
      return;
    default:
      // Unknown requests still get a truthful answer so the client does not hang.
      respond(request);
      return;
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const separator = buffer.indexOf("\r\n\r\n");
    if (separator < 0) break;
    const header = buffer.subarray(0, separator).toString("ascii");
    const match = /content-length:\s*(\d+)/i.exec(header);
    const start = separator + 4;
    if (!match) {
      buffer = buffer.subarray(start);
      continue;
    }
    const length = Number(match[1]);
    if (buffer.length < start + length) break;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    try {
      handle(JSON.parse(body));
    } catch (error) {
      process.stderr.write(`fake adapter error: ${error?.message ?? error}\n`);
    }
  }
});
