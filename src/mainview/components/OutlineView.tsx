import { ChevronRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DocumentSymbol } from "../../shared/types";
import { symbolPathAt } from "../lib/symbols";
import { SymbolIcon } from "./SymbolIcon";
import { t } from "../lib/i18n";

type Props = {
  symbols: DocumentSymbol[] | null;
  cursorLine: number | null;
  onReveal: (symbol: DocumentSymbol) => void;
  collapseToken: number;
};

function SymbolNode({
  symbol,
  depth,
  activePath,
  onReveal,
  collapsed,
  toggle,
}: {
  symbol: DocumentSymbol;
  depth: number;
  activePath: DocumentSymbol[];
  onReveal: Props["onReveal"];
  collapsed: Set<DocumentSymbol>;
  toggle: (symbol: DocumentSymbol) => void;
}) {
  const hasChildren = !!symbol.children?.length;
  const open = hasChildren && !collapsed.has(symbol);
  const active = activePath[activePath.length - 1] === symbol;
  return (
    <>
      <div className={`tree-item${active ? " active" : ""}`} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => onReveal(symbol)}>
        <span
          className={`chevron${open ? " open" : ""}`}
          style={hasChildren ? undefined : { opacity: 0 }}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) toggle(symbol);
          }}
        >
          <ChevronRight size={14} />
        </span>
        <SymbolIcon kind={symbol.kind} />
        <span className="name">{symbol.name}</span>
      </div>
      {open &&
        symbol.children!.map((child, index) => (
          <SymbolNode
            key={`${child.name}:${index}`}
            symbol={child}
            depth={depth + 1}
            activePath={activePath}
            onReveal={onReveal}
            collapsed={collapsed}
            toggle={toggle}
          />
        ))}
    </>
  );
}

export function OutlineView({ symbols, cursorLine, onReveal, collapseToken }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.querySelector(".tree-item.active")?.scrollIntoView({ block: "nearest" });
  }, [cursorLine, symbols]);
  const [collapsed, setCollapsed] = useState<{ token: number; set: Set<DocumentSymbol> }>({ token: 0, set: new Set() });

  // "Collapse All" from the view header.
  let current = collapsed.set;
  if (collapsed.token !== collapseToken) {
    const all = new Set<DocumentSymbol>();
    const walk = (list: DocumentSymbol[]) =>
      list.forEach((s) => {
        if (s.children?.length) {
          all.add(s);
          walk(s.children);
        }
      });
    walk(symbols ?? []);
    current = collapseToken === 0 ? new Set() : all;
    setCollapsed({ token: collapseToken, set: current });
  }

  if (symbols === null) return <div className="tree-empty">{t("The active editor cannot provide outline information.")}</div>;
  if (!symbols.length) return <div className="tree-empty">{t("No symbols found in document.")}</div>;

  const activePath = cursorLine === null ? [] : symbolPathAt(symbols, cursorLine - 1);
  const toggle = (symbol: DocumentSymbol) =>
    setCollapsed((prev) => {
      const next = new Set(prev.set);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return { token: prev.token, set: next };
    });

  return (
    <div className="file-tree outline-tree" ref={rootRef}>
      {symbols.map((symbol, index) => (
        <SymbolNode key={`${symbol.name}:${index}`} symbol={symbol} depth={0} activePath={activePath} onReveal={onReveal} collapsed={current} toggle={toggle} />
      ))}
    </div>
  );
}
