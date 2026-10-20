import { Folder, FolderOpen } from "lucide-react";
import { themedFileIcon, themedFolderIcon, useIconThemeState, type ThemedIcon } from "../features/icon-themes-state";

/**
 * Small colored file-type glyphs (in the spirit of VS Code's Seti icons),
 * shared by the explorer, tabs, Quick Open and Source Control.
 */

type Icon = { label: string; color: string };

const BY_EXTENSION: Record<string, Icon> = {
  ts: { label: "TS", color: "#3178c6" },
  mts: { label: "TS", color: "#3178c6" },
  cts: { label: "TS", color: "#3178c6" },
  tsx: { label: "⚛", color: "#4fc1ff" },
  jsx: { label: "⚛", color: "#4fc1ff" },
  js: { label: "JS", color: "#e8d44d" },
  mjs: { label: "JS", color: "#e8d44d" },
  cjs: { label: "JS", color: "#e8d44d" },
  json: { label: "{}", color: "#cbcb41" },
  jsonc: { label: "{}", color: "#cbcb41" },
  html: { label: "<>", color: "#e37933" },
  htm: { label: "<>", color: "#e37933" },
  xml: { label: "<>", color: "#e37933" },
  svg: { label: "◇", color: "#ffb13b" },
  css: { label: "#", color: "#519aba" },
  scss: { label: "#", color: "#f55385" },
  less: { label: "#", color: "#519aba" },
  md: { label: "M↓", color: "#519aba" },
  mdx: { label: "M↓", color: "#519aba" },
  py: { label: "py", color: "#4b8bbe" },
  rs: { label: "rs", color: "#dea584" },
  go: { label: "go", color: "#00add8" },
  java: { label: "J", color: "#cc3e44" },
  c: { label: "C", color: "#599eff" },
  h: { label: "h", color: "#a074c4" },
  cpp: { label: "C+", color: "#f34b7d" },
  cs: { label: "C#", color: "#178600" },
  php: { label: "php", color: "#a074c4" },
  rb: { label: "rb", color: "#cc3e44" },
  kt: { label: "K", color: "#a97bff" },
  sh: { label: "$", color: "#89e051" },
  bash: { label: "$", color: "#89e051" },
  ps1: { label: ">_", color: "#519aba" },
  yml: { label: "≡", color: "#cb171e" },
  yaml: { label: "≡", color: "#cb171e" },
  toml: { label: "≡", color: "#9c4221" },
  sql: { label: "db", color: "#dad8d8" },
  vue: { label: "V", color: "#41b883" },
  svelte: { label: "S", color: "#ff3e00" },
  png: { label: "▣", color: "#a074c4" },
  jpg: { label: "▣", color: "#a074c4" },
  jpeg: { label: "▣", color: "#a074c4" },
  gif: { label: "▣", color: "#a074c4" },
  ico: { label: "▣", color: "#a074c4" },
  lock: { label: "🔒", color: "#8a8a8a" },
  txt: { label: "≡", color: "#8a8a8a" },
  log: { label: "≡", color: "#8a8a8a" },
};

const BY_NAME: Record<string, Icon> = {
  "package.json": { label: "npm", color: "#cb3837" },
  "tsconfig.json": { label: "TS", color: "#3178c6" },
  dockerfile: { label: "🐳", color: "#0db7ed" },
  ".gitignore": { label: "git", color: "#e94e31" },
  ".gitattributes": { label: "git", color: "#e94e31" },
  license: { label: "§", color: "#cbcb41" },
  makefile: { label: "mk", color: "#e37933" },
};

function iconFor(name: string): Icon {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.startsWith(".env")) return { label: "⚙", color: "#faf594" };
  if (lower.startsWith("readme")) return { label: "ⓘ", color: "#519aba" };
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  return BY_EXTENSION[ext] ?? { label: "≡", color: "#8a8a8a" };
}

/** An icon of the selected file icon theme (contributes.iconThemes): an image or a glyph of the theme font. */
function ThemedGlyph({ icon, folder }: { icon: ThemedIcon; folder?: boolean }) {
  const className = `file-type-icon themed-icon${folder ? " folder-type-icon" : ""}`;
  if (icon.kind === "image") return <span className={className} style={{ backgroundImage: `url("${icon.src}")` }} aria-hidden="true" />;
  if (icon.kind === "font") {
    return (
      <span className={className} style={{ fontFamily: `"${icon.family}"`, color: icon.color, fontSize: icon.size, fontWeight: "normal", letterSpacing: 0 }} aria-hidden="true">
        {icon.char}
      </span>
    );
  }
  return <span className={className} aria-hidden="true" />;
}

export function FileIcon({ name }: { name: string }) {
  const state = useIconThemeState();
  const themed = themedFileIcon(name, state);
  if (themed) return <ThemedGlyph icon={themed} />;
  const icon = iconFor(name);
  return (
    <span className="file-type-icon" style={{ color: icon.color }} aria-hidden="true">
      {icon.label}
    </span>
  );
}

/** `name` / `root` let a file icon theme pick folder icons by name (folderNames); without them only the default folder icon applies. */
export function FolderIcon({ open, name = "", root = false }: { open?: boolean; name?: string; root?: boolean }) {
  const state = useIconThemeState();
  const themed = themedFolderIcon(name, !!open, root, state);
  if (themed) return <ThemedGlyph icon={themed} folder />;
  const Icon = open ? FolderOpen : Folder;
  return <Icon className="folder-type-icon" size={15} strokeWidth={1.75} aria-hidden="true" />;
}
