import { NotebookCellData, NotebookCellKind, NotebookCellOutputItem, NotebookData } from "../../compat-types.ts";
import { NotebookCellOutput } from "./types.ts";

/**
 * The built-in Jupyter (nbformat 4) serializer: used for `.ipynb` files when no
 * extension registers a serializer for the `jupyter-notebook` type. Cell and
 * notebook metadata is kept, so saving a notebook does not drop what Lumen
 * does not understand.
 */

export const MIME_STDOUT = "application/vnd.code.notebook.stdout";
export const MIME_STDERR = "application/vnd.code.notebook.stderr";
export const MIME_ERROR = "application/vnd.code.notebook.error";

type Json = Record<string, unknown>;

const lines = (value: unknown): string => (Array.isArray(value) ? value.join("") : typeof value === "string" ? value : "");

const isTextMime = (mime: string): boolean =>
  mime.startsWith("text/") || mime === "image/svg+xml" || mime.endsWith("+json") || /^application\/(json|javascript|x-latex|x-tex|xml)$/.test(mime);

function splitLines(text: string): string[] {
  if (!text) return [];
  const parts = text.split(/(?<=\n)/);
  return parts;
}

function decodeOutput(output: Json): NotebookCellOutput | undefined {
  const type = output.output_type;
  const metadata = { outputType: type, ...(output.metadata && Object.keys(output.metadata as Json).length ? { metadata: output.metadata } : {}), ...(output.execution_count !== undefined ? { executionCount: output.execution_count } : {}) };
  if (type === "stream") {
    const mime = output.name === "stderr" ? MIME_STDERR : MIME_STDOUT;
    return new NotebookCellOutput([NotebookCellOutputItem.text(lines(output.text), mime)], metadata);
  }
  if (type === "error") {
    const error = { name: String(output.ename ?? "Error"), message: String(output.evalue ?? ""), stack: Array.isArray(output.traceback) ? output.traceback.join("\n") : "" };
    return new NotebookCellOutput([NotebookCellOutputItem.json(error, MIME_ERROR)], metadata);
  }
  if (type === "display_data" || type === "execute_result") {
    const items: NotebookCellOutputItem[] = [];
    for (const [mime, value] of Object.entries((output.data ?? {}) as Json)) {
      if (isTextMime(mime) && mime !== "application/json" && !mime.endsWith("+json")) items.push(NotebookCellOutputItem.text(lines(value), mime));
      else if (mime === "application/json" || mime.endsWith("+json")) items.push(NotebookCellOutputItem.json(value, mime));
      else items.push(new NotebookCellOutputItem(Buffer.from(lines(value).replace(/\s/g, ""), "base64"), mime));
    }
    return new NotebookCellOutput(items, metadata);
  }
  return undefined;
}

export function parseIpynb(text: string): NotebookData {
  const json: Json = text.trim() ? JSON.parse(text) : {};
  const metadata = (json.metadata ?? {}) as Json;
  const language = String(((metadata.language_info as Json | undefined)?.name ?? (metadata.kernelspec as Json | undefined)?.language ?? "python") as string).toLowerCase();
  const cells: NotebookCellData[] = [];
  for (const raw of (Array.isArray(json.cells) ? json.cells : []) as Json[]) {
    const cellMetadata: Json = { ...((raw.metadata ?? {}) as Json) };
    if (raw.id !== undefined) cellMetadata.id = raw.id;
    if (raw.cell_type === "code") {
      const cell = new NotebookCellData(NotebookCellKind.Code, lines(raw.source), language);
      cell.metadata = cellMetadata;
      cell.outputs = ((Array.isArray(raw.outputs) ? raw.outputs : []) as Json[]).map(decodeOutput).filter((output): output is NotebookCellOutput => !!output);
      if (typeof raw.execution_count === "number") (cell as unknown as { executionSummary: unknown }).executionSummary = { executionOrder: raw.execution_count };
      cells.push(cell);
    } else {
      if (raw.cell_type === "raw") cellMetadata.raw = true;
      const cell = new NotebookCellData(NotebookCellKind.Markup, lines(raw.source), "markdown");
      cell.metadata = cellMetadata;
      cells.push(cell);
    }
  }
  const data = new NotebookData(cells);
  data.metadata = { ...metadata, nbformat: json.nbformat ?? 4, nbformat_minor: json.nbformat_minor ?? 5 };
  return data;
}

type OutputLike = { items: { mime: string; data: Uint8Array }[]; metadata?: Json };

function encodeOutput(output: OutputLike): Json | undefined {
  const meta = output.metadata ?? {};
  const decode = (data: Uint8Array) => new TextDecoder().decode(data);
  const first = output.items[0];
  if (!first) return undefined;
  if (first.mime === MIME_STDOUT || first.mime === MIME_STDERR) {
    return { output_type: "stream", name: first.mime === MIME_STDERR ? "stderr" : "stdout", text: splitLines(output.items.map((item) => decode(item.data)).join("")) };
  }
  if (first.mime === MIME_ERROR) {
    let error: Json = {};
    try {
      error = JSON.parse(decode(first.data));
    } catch {
      /* keep the empty error */
    }
    return { output_type: "error", ename: String(error.name ?? "Error"), evalue: String(error.message ?? ""), traceback: String(error.stack ?? "").split("\n") };
  }
  const data: Json = {};
  for (const item of output.items) {
    if (item.mime === "application/json" || item.mime.endsWith("+json")) {
      try {
        data[item.mime] = JSON.parse(decode(item.data));
      } catch {
        data[item.mime] = decode(item.data);
      }
    } else if (isTextMime(item.mime)) data[item.mime] = splitLines(decode(item.data));
    else data[item.mime] = Buffer.from(item.data).toString("base64");
  }
  const outputType = meta.outputType === "execute_result" ? "execute_result" : "display_data";
  const result: Json = { output_type: outputType, data, metadata: (meta.metadata as Json | undefined) ?? {} };
  if (outputType === "execute_result") result.execution_count = typeof meta.executionCount === "number" ? meta.executionCount : null;
  return result;
}

type CellLike = { kind: number; value: string; languageId: string; outputs?: OutputLike[]; metadata?: Json; executionSummary?: { executionOrder?: number } };

export function stringifyIpynb(data: { cells: CellLike[]; metadata?: Json }): string {
  const { nbformat = 4, nbformat_minor = 5, ...metadata } = (data.metadata ?? {}) as Json;
  const minor = Number(nbformat_minor);
  const cells = data.cells.map((cell, index) => {
    const { id, raw, ...cellMetadata } = (cell.metadata ?? {}) as Json;
    const base: Json = {};
    if (minor >= 5) base.id = typeof id === "string" ? id : `cell-${index + 1}-${Math.random().toString(36).slice(2, 8)}`;
    if (cell.kind === NotebookCellKind.Code) {
      return {
        cell_type: "code",
        ...base,
        metadata: cellMetadata,
        execution_count: cell.executionSummary?.executionOrder ?? null,
        outputs: (cell.outputs ?? []).map(encodeOutput).filter((output) => !!output),
        source: splitLines(cell.value),
      };
    }
    return { cell_type: raw ? "raw" : "markdown", ...base, metadata: cellMetadata, source: splitLines(cell.value) };
  });
  return `${JSON.stringify({ cells, metadata, nbformat, nbformat_minor }, null, 1)}\n`;
}

/** The serializer object, in the shape of `vscode.NotebookSerializer`. */
export const ipynbSerializer = {
  deserializeNotebook: (content: Uint8Array): NotebookData => parseIpynb(new TextDecoder().decode(content)),
  serializeNotebook: (data: { cells: CellLike[]; metadata?: Json }): Uint8Array => new TextEncoder().encode(stringifyIpynb(data)),
};
