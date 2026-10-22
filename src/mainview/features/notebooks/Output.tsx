import type { ReactNode } from "react";
import type { NbWireOutput, NbWireOutputItem } from "../../../shared/notebooks";
import { renderMarkdown, sanitizeHtml } from "../../lib/markdown";

/**
 * The outputs of a cell: text, sanitized HTML and Markdown, images, JSON and
 * errors. Each output shows its best item (renderers of extensions do not run
 * in Lumen).
 */

const MIME_STDOUT = "application/vnd.code.notebook.stdout";
const MIME_STDERR = "application/vnd.code.notebook.stderr";
const MIME_ERROR = "application/vnd.code.notebook.error";

const PRIORITY = [
  MIME_ERROR,
  "text/html",
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "text/markdown",
  "application/json",
  MIME_STDERR,
  MIME_STDOUT,
  "text/latex",
  "text/plain",
];

const MAX_TEXT = 200_000;

/** Color escape sequences of terminals do not belong into a notebook's text. */
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

function pickItem(output: NbWireOutput): NbWireOutputItem | undefined {
  for (const mime of PRIORITY) {
    const item = output.items.find((candidate) => candidate.mime === mime);
    if (item) return item;
  }
  return output.items.find((item) => item.mime.startsWith("text/")) ?? output.items.find((item) => item.mime.startsWith("image/"));
}

function Text({ text, className }: { text: string; className?: string }) {
  const clipped = text.length > MAX_TEXT;
  return (
    <pre className={`nb-output-text ${className ?? ""}`}>
      {stripAnsi(clipped ? text.slice(0, MAX_TEXT) : text)}
      {clipped ? `\n… ${text.length - MAX_TEXT} more characters` : ""}
    </pre>
  );
}

function renderItem(item: NbWireOutputItem): ReactNode {
  const { mime, data } = item;
  if (mime === MIME_ERROR) {
    let error: { name?: string; message?: string; stack?: string } = {};
    try {
      error = JSON.parse(data);
    } catch {
      error = { message: data };
    }
    const stack = error.stack ?? "";
    return (
      <div className="nb-output-error">
        <strong>{[error.name, error.message].filter(Boolean).join(": ")}</strong>
        {stack && stack !== `${error.name}: ${error.message}` ? <Text text={stack} /> : null}
      </div>
    );
  }
  if (mime === "text/html") return <div className="nb-output-html" dangerouslySetInnerHTML={{ __html: sanitizeHtml(data) }} />;
  if (mime === "text/markdown") return <div className="nb-output-html markdown-body" dangerouslySetInnerHTML={{ __html: renderMarkdown(data) }} />;
  if (mime === "image/svg+xml") return <img className="nb-output-image" alt="" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data)}`} />;
  if (mime.startsWith("image/")) return <img className="nb-output-image" alt="" src={`data:${mime};base64,${data}`} />;
  if (mime === "application/json") {
    let pretty = data;
    try {
      pretty = JSON.stringify(JSON.parse(data), null, 2);
    } catch {
      /* show it as it is */
    }
    return <Text text={pretty} />;
  }
  if (mime === MIME_STDERR) return <Text text={data} className="nb-stderr" />;
  return <Text text={data} />;
}

export function CellOutputs({ outputs }: { outputs: NbWireOutput[] }) {
  if (!outputs.length) return null;
  return (
    <div className="nb-outputs">
      {outputs.map((output) => {
        const item = pickItem(output);
        return (
          <div className="nb-output" key={output.id}>
            {item ? (
              renderItem(item)
            ) : (
              <span className="nb-output-unsupported">
                Output of type {output.items.map((candidate) => candidate.mime).join(", ") || "(empty)"} cannot be shown.
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
