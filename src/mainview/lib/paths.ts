export function basename(path: string) {
  // Untitled editors ("untitled:Untitled-1") have no folder part.
  if (path.startsWith("untitled:")) return path.slice("untitled:".length);
  return path.split(/[/\\]/).pop() ?? path;
}

export function dirname(path: string) {
  const parts = path.replace(/\\/g, "/").split("/");
  parts.pop();
  return parts.join(path.includes("\\") ? "\\" : "/") || path;
}

export function joinPath(base: string, name: string) {
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${sep}${name.replace(/^[\\/]+/, "")}`;
}
