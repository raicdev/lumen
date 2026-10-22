import { Box, Component, Dot, Hash, Heading, ListOrdered, Package, Pi, SquareFunction, Type, Variable, Wrench, type LucideIcon } from "lucide-react";

/** Icon + color per symbol kind (outline, breadcrumbs, Go to Symbol), after VS Code's. */
const KINDS: Record<string, { Icon: LucideIcon; color: string }> = {
  class: { Icon: Box, color: "#ee9d28" },
  interface: { Icon: Component, color: "#75beff" },
  type: { Icon: Type, color: "#75beff" },
  enum: { Icon: ListOrdered, color: "#ee9d28" },
  enumMember: { Icon: Hash, color: "#75beff" },
  function: { Icon: SquareFunction, color: "#b180d7" },
  method: { Icon: SquareFunction, color: "#b180d7" },
  constructor: { Icon: SquareFunction, color: "#b180d7" },
  property: { Icon: Wrench, color: "#75beff" },
  constant: { Icon: Pi, color: "#4fc1ff" },
  variable: { Icon: Variable, color: "#75beff" },
  module: { Icon: Package, color: "#cccccc" },
  heading: { Icon: Heading, color: "#cccccc" },
};

export function SymbolIcon({ kind, size = 14 }: { kind: string; size?: number }) {
  const { Icon, color } = KINDS[kind] ?? { Icon: Dot, color: "#9d9d9d" };
  return <Icon className="symbol-icon" size={size} color={color} strokeWidth={1.75} aria-hidden="true" />;
}
