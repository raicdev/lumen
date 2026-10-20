/** Language ids (as returned by the main process) → display names. */
export const LANGUAGE_LABELS: Record<string, string> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  markdown: "Markdown",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  c: "C",
  cpp: "C++",
  csharp: "C#",
  php: "PHP",
  ruby: "Ruby",
  kotlin: "Kotlin",
  shell: "Shell Script",
  plaintext: "Plain Text",
  dotenv: "Dotenv",
  gitignore: "Ignore",
  dockerfile: "Dockerfile",
  yaml: "YAML",
  toml: "TOML",
  xml: "XML",
  sql: "SQL",
  vue: "Vue",
  svelte: "Svelte",
};

/** Names of languages contributed by extensions (contributes.languages[].aliases[0]). */
let contributedLabels: Record<string, string> = {};

export function setContributedLanguageLabels(labels: Record<string, string>): void {
  contributedLabels = labels;
}

/** Every language the "Change Language Mode" picker offers. */
export function allLanguageLabels(): Record<string, string> {
  return { ...contributedLabels, ...LANGUAGE_LABELS };
}

export function languageLabel(id: string): string {
  return LANGUAGE_LABELS[id] ?? contributedLabels[id] ?? id;
}
