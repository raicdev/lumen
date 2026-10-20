import { ChevronRight } from "lucide-react";
import type { DocumentSymbol } from "../../shared/types";
import { symbolPathAt } from "../lib/symbols";
import { SymbolIcon } from "./SymbolIcon";
import { FileIcon } from "./FileIcon";

type Props = {
  path: string;
  workspaceRoot: string | null;
  symbols: DocumentSymbol[] | null;
  cursorLine: number | null;
  onRevealFolder: (path: string) => void;
  onRevealSymbol: (symbol: DocumentSymbol) => void;
  onShowSymbols: () => void;
};

export function Breadcrumbs({ path, workspaceRoot, symbols, cursorLine, onRevealFolder, onRevealSymbol, onShowSymbols }: Props) {
  const untitled = path.startsWith("untitled:");
  const sep = path.includes("\\") ? "\\" : "/";
  let rel = untitled ? path.slice("untitled:".length) : path;
  let base = "";
  if (!untitled && workspaceRoot && path.toLowerCase().startsWith(workspaceRoot.toLowerCase())) {
    rel = path.slice(workspaceRoot.length + 1);
    base = workspaceRoot;
  }
  const segments = rel.split(/[/\\]/);
  const file = segments.pop() ?? rel;
  const chain = symbols && cursorLine !== null ? symbolPathAt(symbols, cursorLine - 1) : [];

  return (
    <nav className="breadcrumbs" aria-label="Breadcrumbs">
      {segments.map((segment, index) => {
        const folder = base ? [base, ...segments.slice(0, index + 1)].join(sep) : segments.slice(0, index + 1).join(sep);
        return (
          <span key={`${segment}:${index}`} className="crumb-wrap">
            <button type="button" className="crumb" onClick={() => onRevealFolder(folder)}>
              {segment}
            </button>
            <ChevronRight className="crumb-sep" size={13} />
          </span>
        );
      })}
      <span className="crumb-wrap">
        <button type="button" className="crumb file" onClick={onShowSymbols} title="Go to Symbol (Ctrl+Shift+O)">
          <FileIcon name={file} />
          {file}
        </button>
      </span>
      {chain.map((symbol, index) => {
        return (
          <span key={`${symbol.name}:${index}`} className="crumb-wrap">
            <ChevronRight className="crumb-sep" size={13} />
            <button type="button" className="crumb" onClick={() => onRevealSymbol(symbol)}>
              <SymbolIcon kind={symbol.kind} size={13} />
              {symbol.name}
            </button>
          </span>
        );
      })}
    </nav>
  );
}
