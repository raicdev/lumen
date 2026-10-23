import { useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { HostDebugVariable } from "../../shared/extensions";
import { debugService } from "../lib/debug";
import { debugMenuLookup, debugUi } from "../lib/debug-ui";
import { showContextMenu, type ContextMenuItem } from "../lib/context-menu";
import { contributedMenuItems } from "../features/menus-walkthroughs/menus";
import { t } from "../lib/i18n";

/** A variable's value, colored like VS Code (strings, numbers, booleans, null). */
export function DebugValue({ value, type }: { value: string; type?: string }) {
  const kind =
    /^(["'`]).*\1$/s.test(value) || type === "str" || type === "string"
      ? "string"
      : /^-?\d[\d_]*(\.\d+)?(e[+-]?\d+)?n?$/i.test(value)
        ? "number"
        : /^(true|false|True|False)$/.test(value)
          ? "boolean"
          : /^(null|undefined|None|nil)$/.test(value)
            ? "null"
            : "other";
  return <span className={`dbg-value dbg-value-${kind}`}>{value}</span>;
}

type Props = {
  sessionId: string;
  variable: HostDebugVariable;
  depth: number;
  /** Bumped when the debugger stops again: expanded nodes reload their children. */
  generation: number;
  defaultOpen?: boolean;
  /** The scope or variable this one is a child of (`container` of debug/variables/context); none for scopes and watch roots. */
  container?: HostDebugVariable;
  /** In the Watch view: debug/watch/context instead of debug/variables/context. */
  watch?: boolean;
};

/** One expandable variable (children are fetched lazily from the adapter). */
export function VariableNode({ sessionId, variable, depth, generation, defaultOpen = false, container, watch = false }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [children, setChildren] = useState<HostDebugVariable[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const expandable = variable.variablesReference > 0;

  useEffect(() => {
    if (!open || !expandable) return;
    let cancelled = false;
    debugService
      .variables(sessionId, variable.variablesReference)
      .then((result) => {
        if (cancelled) return;
        setChildren(result);
        setError(null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [open, expandable, sessionId, variable.variablesReference, generation]);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Extensions' entries (VS Code's IVariablesContext: the session, the container and the DAP variable).
    const session = debugService.getSnapshot().sessions.find((candidate) => candidate.id === sessionId) ?? null;
    const lookup = debugMenuLookup(session, {
      watchItemType: watch ? (container ? "variable" : "expression") : undefined,
      variableEvaluateNamePresent: !!variable.evaluateName,
      variableIsReadonly: false,
      variablesFocused: !watch,
      watchExpressionsFocused: watch,
    });
    const context = { sessionId, container: container ?? undefined, variable: { ...variable } };
    // Scopes (variables roots) have no contributed menu.
    const contributed = watch || container ? contributedMenuItems(watch ? "debug/watch/context" : "debug/variables/context", lookup, [context]) : [];
    const own: ContextMenuItem[] = [
      { type: "item", label: t("Copy Value"), action: "copy" },
      ...(variable.evaluateName
        ? [
            { type: "item" as const, label: t("Copy as Expression"), action: "copyExpr" },
            { type: "item" as const, label: t("Add to Watch"), action: "watch" },
          ]
        : []),
    ];
    void showContextMenu(e.clientX, e.clientY, contributed.length ? [...own, { type: "separator" }, ...contributed] : own).then((action) => {
      if (action === "copy") void navigator.clipboard.writeText(variable.value);
      else if (action === "copyExpr" && variable.evaluateName) void navigator.clipboard.writeText(variable.evaluateName);
      else if (action === "watch" && variable.evaluateName) debugUi.addWatch(variable.evaluateName);
    });
  };

  return (
    <>
      <div
        className="dbg-row"
        style={{ paddingLeft: 8 + depth * 12 }}
        title={variable.type ? `${variable.name}: ${variable.type}` : variable.name}
        onClick={() => expandable && setOpen((v) => !v)}
        onContextMenu={onContextMenu}
      >
        <ChevronRight size={14} className={`dbg-chevron${open ? " open" : ""}${expandable ? "" : " hidden"}`} />
        {variable.name && <span className="dbg-name">{variable.name}</span>}
        {variable.name && <span className="dbg-sep">: </span>}
        <DebugValue value={variable.value} type={variable.type} />
      </div>
      {open && error && (
        <div className="dbg-row dbg-error" style={{ paddingLeft: 22 + depth * 12 }}>
          {error}
        </div>
      )}
      {open &&
        children?.map((child, i) => (
          <VariableNode
            key={`${child.name}:${i}`}
            sessionId={sessionId}
            variable={child}
            depth={depth + 1}
            generation={generation}
            container={variable}
            watch={watch}
          />
        ))}
    </>
  );
}
