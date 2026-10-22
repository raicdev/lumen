/**
 * A small Markdown renderer for extension READMEs and hovers: headings,
 * paragraphs, lists, fenced code, quotes, tables, links, images and inline
 * HTML — the output always goes through an allow-list sanitizer, so nothing
 * from an extension can run script in the window.
 */

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text: string): string {
  const codes: string[] = [];
  let out = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, code: string) => {
    codes.push(`<code>${escape(code.trim())}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out
    .replace(/!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, alt: string, src: string) => `<img alt="${escape(alt)}" src="${escape(src)}">`)
    .replace(/\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g, (_m, label: string, href: string) => `<a href="${escape(href)}">${label}</a>`)
    .replace(/<(https?:\/\/[^\s>]+)>/g, (_m, href: string) => `<a href="${escape(href)}">${escape(href)}</a>`)
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "<strong>$2</strong>")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>")
    .replace(/ {2,}\n/g, "<br>")
    .replace(/\$\(([a-z0-9-]+)(~spin)?\)/g, "");
  return out.replace(/\u0000(\d+)\u0000/g, (_m, index: string) => codes[Number(index)]!);
}

export function renderMarkdownUnsafe(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) html.push(`<p>${inline(paragraph.join("\n"))}</p>`);
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) body.push(lines[i++]!);
      html.push(`<pre><code${fence[2] ? ` data-lang="${escape(fence[2])}"` : ""}>${escape(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      html.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      html.push("<hr>");
      continue;
    }
    if (/^\s*>/.test(line)) {
      flush();
      const quote: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      i--;
      html.push(`<blockquote>${renderMarkdownUnsafe(quote.join("\n"))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && items.length))) {
        const current = lines[i]!;
        const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(current);
        if (item) {
          const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]!);
          const depth = Math.min(4, Math.floor(item[1]!.length / 2));
          const content = task ? `<input type="checkbox" disabled${task[1] !== " " ? " checked" : ""}> ${inline(task[2]!)}` : inline(item[3]!);
          items.push(`<li${depth ? ` style="margin-left:${depth * 16}px"` : ""}>${content}</li>`);
        } else if (items.length) items[items.length - 1] = items[items.length - 1]!.replace(/<\/li>$/, ` ${inline(current.trim())}</li>`);
        i++;
      }
      i--;
      html.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")) {
      flush();
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) rows.push(cells(lines[i++]!));
      i--;
      html.push(
        `<table><thead><tr>${head.map((cell) => `<th>${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((row) => `<tr>${row.map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return html.join("\n");
}

const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "code",
  "del",
  "details",
  "div",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "input",
  "kbd",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);
const ALLOWED_ATTRIBUTES = new Set(["alt", "title", "width", "height", "align", "colspan", "rowspan", "type", "checked", "disabled", "data-lang", "style"]);

function safeUrl(value: string, image: boolean): string | null {
  const url = value.trim();
  if (/^https?:\/\//i.test(url) || (!image && /^mailto:/i.test(url))) return url;
  if (image && /^data:image\/(png|gif|jpeg|webp);base64,/i.test(url)) return url;
  return null;
}

/** Keep only harmless markup; links carry their target in data-href (opened by the app). */
export function sanitizeHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walk = (node: Element) => {
    for (const child of [...node.children]) {
      const tag = child.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        if (["script", "style", "iframe", "object", "embed", "svg", "math", "template", "link", "meta", "form"].includes(tag)) child.remove();
        else {
          walk(child);
          child.replaceWith(...child.childNodes);
        }
        continue;
      }
      for (const attribute of [...child.attributes]) {
        const name = attribute.name.toLowerCase();
        if (tag === "a" && name === "href") {
          const url = safeUrl(attribute.value, false);
          child.removeAttribute("href");
          if (url) child.setAttribute("data-href", url);
        } else if (tag === "img" && name === "src") {
          const url = safeUrl(attribute.value, true);
          if (!url) child.removeAttribute("src");
          else child.setAttribute("src", url);
        } else if (name === "style") {
          // Only layout-neutral inline styles survive (list indentation from the renderer).
          if (!/^margin-left:\d+px$/.test(attribute.value)) child.removeAttribute(name);
        } else if (!ALLOWED_ATTRIBUTES.has(name)) child.removeAttribute(attribute.name);
      }
      if (tag === "img" && !child.getAttribute("src")) {
        child.replaceWith(doc.createTextNode(child.getAttribute("alt") ?? ""));
        continue;
      }
      if (tag === "input" && child.getAttribute("type") !== "checkbox") {
        child.remove();
        continue;
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export function renderMarkdown(source: string): string {
  return sanitizeHtml(renderMarkdownUnsafe(source));
}
