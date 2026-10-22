// A minimal MCP server over stdio: one tool, `echo`.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    send({ id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
  else if (message.method === "tools/list")
    send({
      id: message.id,
      result: { tools: [{ name: "echo", description: "Echo the text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] },
    });
  else if (message.method === "tools/call") send({ id: message.id, result: { content: [{ type: "text", text: `echo: ${message.params.arguments.text}` }] } });
  else if (message.id !== undefined) send({ id: message.id, error: { code: -32601, message: "no such method" } });
});
