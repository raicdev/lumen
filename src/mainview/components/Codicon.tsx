import {
  Archive,
  ArrowLeft,
  Bookmark,
  Box,
  Braces,
  ChevronsDownUp,
  ChevronsUpDown,
  Download,
  Ellipsis,
  Eraser,
  ExternalLink,
  FilePlus,
  Filter,
  FlaskConical,
  FolderPlus,
  Home,
  Layers,
  Library,
  Link,
  List,
  ListTree,
  Minus,
  Package,
  Puzzle,
  Upload,
  Variable,
  TriangleAlert,
  Bell,
  Bug,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  Clock,
  Cloud,
  Code,
  Copy,
  Database,
  Eye,
  File,
  FileText,
  Flame,
  Folder,
  GitBranch,
  GitPullRequest,
  Globe,
  Heart,
  Info,
  Key,
  Lightbulb,
  Loader,
  Lock,
  Mail,
  MessageSquare,
  Pencil,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Server,
  Settings,
  Sparkles,
  Square,
  Star,
  Tag,
  Terminal,
  Trash2,
  User,
  Wrench,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { contributedIcon, productIcon, useIconThemeState } from "../features/icon-themes-state";

/**
 * VS Code's `$(icon-name)` syntax (status bar items, quick picks) rendered
 * with the closest Lucide icon; unknown names are dropped.
 */

const ICONS: Record<string, LucideIcon> = {
  alert: TriangleAlert,
  warning: TriangleAlert,
  bell: Bell,
  "bell-dot": Bell,
  bug: Bug,
  check: Check,
  "check-all": CheckCheck,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  circle: Circle,
  "circle-filled": Circle,
  "circle-outline": Circle,
  error: CircleX,
  "circle-slash": CircleX,
  pass: CircleCheck,
  "pass-filled": CircleCheck,
  info: Info,
  issues: CircleAlert,
  clock: Clock,
  watch: Clock,
  history: Clock,
  cloud: Cloud,
  "cloud-upload": Cloud,
  "cloud-download": Cloud,
  code: Code,
  "symbol-method": Code,
  copy: Copy,
  database: Database,
  eye: Eye,
  file: File,
  "file-code": FileText,
  "file-text": FileText,
  flame: Flame,
  folder: Folder,
  "folder-opened": Folder,
  "git-branch": GitBranch,
  "source-control": GitBranch,
  "git-pull-request": GitPullRequest,
  globe: Globe,
  heart: Heart,
  key: Key,
  lightbulb: Lightbulb,
  loading: Loader,
  sync: RefreshCw,
  refresh: RefreshCw,
  lock: Lock,
  mail: Mail,
  comment: MessageSquare,
  "comment-discussion": MessageSquare,
  pencil: Pencil,
  edit: Pencil,
  play: Play,
  "debug-start": Play,
  plug: Plug,
  add: Plus,
  rocket: Rocket,
  search: Search,
  server: Server,
  gear: Settings,
  "settings-gear": Settings,
  sparkle: Sparkles,
  copilot: Sparkles,
  "primitive-square": Square,
  "debug-stop": Square,
  star: Star,
  "star-full": Star,
  tag: Tag,
  terminal: Terminal,
  trash: Trash2,
  person: User,
  account: User,
  tools: Wrench,
  close: X,
  x: X,
  zap: Zap,
  "symbol-event": Zap,
  archive: Archive,
  bookmark: Bookmark,
  "symbol-class": Box,
  "symbol-module": Braces,
  "symbol-namespace": Braces,
  json: Braces,
  "collapse-all": ChevronsDownUp,
  "expand-all": ChevronsUpDown,
  "cloud-download-alt": Download,
  "arrow-down": Download,
  "arrow-up": Upload,
  "arrow-left": ArrowLeft,
  ellipsis: Ellipsis,
  kebab: Ellipsis,
  "clear-all": Eraser,
  "link-external": ExternalLink,
  "new-file": FilePlus,
  filter: Filter,
  beaker: FlaskConical,
  "new-folder": FolderPlus,
  home: Home,
  layers: Layers,
  library: Library,
  link: Link,
  "list-flat": List,
  "list-unordered": List,
  "list-tree": ListTree,
  remove: Minus,
  dash: Minus,
  package: Package,
  extensions: Puzzle,
  "symbol-variable": Variable,
  "symbol-field": Variable,
  "symbol-property": Variable,
};

/** Text with `$(name)` / `$(name~spin)` icons. */
export function WithCodicons({ text, size = 13 }: { text: string; size?: number }): ReactNode {
  const themeState = useIconThemeState();
  const parts = text.split(/(\$\([\w-]+(?:~spin)?\))/g);
  return (
    <>
      {parts.map((part, index) => {
        const match = /^\$\(([\w-]+)(~spin)?\)$/.exec(part);
        if (!match) return part ? <Fragment key={index}>{part}</Fragment> : null;
        // A product icon theme (contributes.productIconThemes) replaces the glyph by its own font;
        // otherwise an icon an extension defines (contributes.icons) uses the extension's font.
        const contributed = contributedIcon(match[1]!, themeState);
        // An alias of another icon ("default": "<icon id>") ends at a codicon.
        const name = contributed && "codicon" in contributed ? contributed.codicon : match[1]!;
        const glyph = productIcon(match[1]!, themeState) ?? productIcon(name, themeState) ?? (contributed && "char" in contributed ? contributed : undefined);
        if (glyph) {
          const glyphSpin = !!match[2] || match[1] === "loading";
          return (
            <span
              key={index}
              className={`codicon product-icon${glyphSpin ? " spin" : ""}`}
              style={{ fontFamily: `"${glyph.family}"`, fontSize: size, lineHeight: 1 }}
              aria-hidden="true"
            >
              {glyph.char}
            </span>
          );
        }
        const Icon = ICONS[name];
        if (!Icon) return null;
        const spin = !!match[2] || match[1] === "loading";
        return <Icon key={index} size={size} className={`codicon${spin ? " spin" : ""}`} aria-hidden="true" />;
      })}
    </>
  );
}
