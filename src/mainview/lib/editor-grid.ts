/**
 * Editor group layout (VS Code's editor grid): a tree of splits whose leaves
 * are editor groups. Rows lay children out left → right, columns top → bottom.
 */

export type GridNode =
  | { type: "leaf"; groupId: string }
  | { type: "split"; id: string; direction: "row" | "column"; children: GridNode[]; sizes: number[] };

export type DropSide = "left" | "right" | "top" | "bottom";

let splitSeq = 0;

function normalize(sizes: number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0) || 1;
  return sizes.map((size) => size / total);
}

/** Group ids in visual order (depth-first, left/top first). */
export function leafIds(node: GridNode): string[] {
  return node.type === "leaf" ? [node.groupId] : node.children.flatMap(leafIds);
}

/** Put `newGroupId` beside `groupId` on `side`, sharing that group's space. */
export function splitLeaf(root: GridNode, groupId: string, side: DropSide, newGroupId: string): GridNode {
  const direction = side === "left" || side === "right" ? "row" : "column";
  const before = side === "left" || side === "top";
  const newLeaf: GridNode = { type: "leaf", groupId: newGroupId };

  const visit = (node: GridNode): GridNode => {
    if (node.type === "leaf") {
      if (node.groupId !== groupId) return node;
      return {
        type: "split",
        id: `split-${++splitSeq}`,
        direction,
        children: before ? [newLeaf, node] : [node, newLeaf],
        sizes: [0.5, 0.5],
      };
    }
    const index = node.children.findIndex((child) => child.type === "leaf" && child.groupId === groupId);
    if (index >= 0 && node.direction === direction) {
      // Same orientation: insert next to the group instead of nesting a split.
      const children = [...node.children];
      const sizes = [...node.sizes];
      const half = sizes[index]! / 2;
      sizes[index] = half;
      children.splice(before ? index : index + 1, 0, newLeaf);
      sizes.splice(before ? index : index + 1, 0, half);
      return { ...node, children, sizes: normalize(sizes) };
    }
    return { ...node, children: node.children.map(visit) };
  };
  return visit(root);
}

/** Remove a group; splits left with one child collapse into it. */
export function removeLeaf(root: GridNode, groupId: string): GridNode {
  const visit = (node: GridNode): GridNode | null => {
    if (node.type === "leaf") return node.groupId === groupId ? null : node;
    const kept: { child: GridNode; size: number }[] = [];
    let freed = 0;
    node.children.forEach((child, index) => {
      const next = visit(child);
      if (next) {
        kept.push({ child: next, size: (node.sizes[index] ?? 1) + freed });
        freed = 0;
      } else if (kept.length) {
        // The closed group's space goes back to its neighbour (left/top first).
        kept[kept.length - 1]!.size += node.sizes[index] ?? 0;
      } else freed += node.sizes[index] ?? 0;
    });
    if (!kept.length) return null;
    if (kept.length === 1) return kept[0]!.child;
    return { ...node, children: kept.map((k) => k.child), sizes: normalize(kept.map((k) => k.size)) };
  };
  return visit(root) ?? root;
}

/** Move the boundary after child `index` of split `splitId` to `fraction` of the pair's space. */
export function resizeSplit(root: GridNode, splitId: string, index: number, delta: number): GridNode {
  const visit = (node: GridNode): GridNode => {
    if (node.type === "leaf") return node;
    if (node.id !== splitId) return { ...node, children: node.children.map(visit) };
    const sizes = [...node.sizes];
    const pair = sizes[index]! + sizes[index + 1]!;
    const minimum = 0.08;
    const first = Math.min(pair - minimum, Math.max(minimum, sizes[index]! + delta));
    sizes[index] = first;
    sizes[index + 1] = pair - first;
    return { ...node, sizes };
  };
  return visit(root);
}

/** Every split resized to equal parts (Reset Editor Group Sizes). */
export function evenSizes(root: GridNode): GridNode {
  if (root.type === "leaf") return root;
  return { ...root, children: root.children.map(evenSizes), sizes: root.children.map(() => 1 / root.children.length) };
}

export type Rect = { x: number; y: number; w: number; h: number };
export type SashInfo = { splitId: string; index: number; direction: "row" | "column"; rect: Rect; span: number };

/**
 * Where every group goes, as fractions of the editor area. Groups are then
 * positioned absolutely, so changing the layout never re-mounts an editor.
 */
export function layoutGrid(root: GridNode): { leaves: { groupId: string; rect: Rect }[]; sashes: SashInfo[] } {
  const leaves: { groupId: string; rect: Rect }[] = [];
  const sashes: SashInfo[] = [];
  const visit = (node: GridNode, rect: Rect) => {
    if (node.type === "leaf") {
      leaves.push({ groupId: node.groupId, rect });
      return;
    }
    const total = node.sizes.reduce((sum, size) => sum + size, 0) || 1;
    let offset = 0;
    node.children.forEach((child, index) => {
      const fraction = (node.sizes[index] ?? 0) / total;
      const childRect =
        node.direction === "row"
          ? { x: rect.x + offset * rect.w, y: rect.y, w: fraction * rect.w, h: rect.h }
          : { x: rect.x, y: rect.y + offset * rect.h, w: rect.w, h: fraction * rect.h };
      if (index > 0) {
        sashes.push({
          splitId: node.id,
          index: index - 1,
          direction: node.direction,
          rect:
            node.direction === "row"
              ? { x: childRect.x, y: rect.y, w: 0, h: rect.h }
              : { x: rect.x, y: childRect.y, w: rect.w, h: 0 },
          span: node.direction === "row" ? rect.w : rect.h,
        });
      }
      visit(child, childRect);
      offset += fraction;
    });
  };
  visit(root, { x: 0, y: 0, w: 1, h: 1 });
  return { leaves, sashes };
}
