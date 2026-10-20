/**
 * VS Code "when" clauses (`editorTextFocus && resourceExtname == .ts`, `!a || b`,
 * `editorLangId in supportedLanguages`, `resourceFilename =~ /^Docker/`, …),
 * used by extension keybindings, menus and command enablement.
 */

type Token =
  | { type: "op"; value: "&&" | "||" | "!" | "(" | ")" | "==" | "!=" | "=~" | ">" | ">=" | "<" | "<=" | "in" | "not in" }
  | { type: "value"; value: string; quoted: boolean }
  | { type: "regex"; value: RegExp };

type Node =
  | { kind: "and" | "or"; left: Node; right: Node }
  | { kind: "not"; operand: Node }
  | { kind: "key"; key: string }
  | { kind: "literal"; value: boolean }
  | { kind: "compare"; op: string; key: string; value: string | RegExp };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "==" || two === "!=" || two === "=~" || two === ">=" || two === "<=") {
      // `===` / `!==` are accepted as aliases.
      i += source[i + 2] === "=" && (two === "==" || two === "!=") ? 3 : 2;
      tokens.push({ type: "op", value: two as "==" });
      if (two === "=~") {
        while (/\s/.test(source[i] ?? "")) i++;
        if (source[i] === "/") {
          let j = i + 1;
          let body = "";
          while (j < source.length && source[j] !== "/") {
            if (source[j] === "\\" && j + 1 < source.length) {
              body += source[j]! + source[j + 1]!;
              j += 2;
            } else body += source[j++];
          }
          const flags = /^[gimsuy]*/.exec(source.slice(j + 1))![0];
          try {
            tokens.push({ type: "regex", value: new RegExp(body, flags) });
          } catch {
            tokens.push({ type: "regex", value: /$^/ });
          }
          i = j + 1 + flags.length;
        }
      }
      continue;
    }
    if (ch === "!" || ch === "(" || ch === ")" || ch === ">" || ch === "<") {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = source.indexOf(ch, i + 1);
      const value = source.slice(i + 1, end < 0 ? source.length : end);
      tokens.push({ type: "value", value, quoted: true });
      i = end < 0 ? source.length : end + 1;
      continue;
    }
    const match = /^[^\s()!=<>&|'"]+/.exec(source.slice(i));
    if (!match) {
      i++;
      continue;
    }
    const word = match[0];
    i += word.length;
    if (word === "in") tokens.push({ type: "op", value: "in" });
    else if (word === "not" && /^\s+in\b/.test(source.slice(i))) {
      i = source.indexOf("in", i) + 2;
      tokens.push({ type: "op", value: "not in" });
    } else tokens.push({ type: "value", value: word, quoted: false });
  }
  return tokens;
}

function parse(tokens: Token[]): Node {
  let position = 0;
  const peek = () => tokens[position];
  const isOp = (value: string) => {
    const token = peek();
    return token?.type === "op" && token.value === value;
  };

  const or = (): Node => {
    let left = and();
    while (isOp("||")) {
      position++;
      left = { kind: "or", left, right: and() };
    }
    return left;
  };
  const and = (): Node => {
    let left = unary();
    while (isOp("&&")) {
      position++;
      left = { kind: "and", left, right: unary() };
    }
    return left;
  };
  const unary = (): Node => {
    if (isOp("!")) {
      position++;
      return { kind: "not", operand: unary() };
    }
    return primary();
  };
  const primary = (): Node => {
    if (isOp("(")) {
      position++;
      const inner = or();
      if (isOp(")")) position++;
      return inner;
    }
    const token = tokens[position++];
    if (!token || token.type !== "value") return { kind: "literal", value: false };
    if (!token.quoted && (token.value === "true" || token.value === "false")) return { kind: "literal", value: token.value === "true" };
    const next = peek();
    if (next?.type === "op" && ["==", "!=", "=~", ">", ">=", "<", "<=", "in", "not in"].includes(next.value)) {
      position++;
      const operand = tokens[position++];
      const value = operand?.type === "regex" ? operand.value : operand?.type === "value" ? operand.value : "";
      return { kind: "compare", op: next.value, key: token.value, value };
    }
    return { kind: "key", key: token.value };
  };
  return or();
}

const cache = new Map<string, Node>();

export type ContextLookup = (key: string) => unknown;

function evaluate(node: Node, lookup: ContextLookup): boolean {
  switch (node.kind) {
    case "and":
      return evaluate(node.left, lookup) && evaluate(node.right, lookup);
    case "or":
      return evaluate(node.left, lookup) || evaluate(node.right, lookup);
    case "not":
      return !evaluate(node.operand, lookup);
    case "literal":
      return node.value;
    case "key":
      return !!lookup(node.key);
    case "compare": {
      const actual = lookup(node.key);
      const expected = node.value;
      switch (node.op) {
        case "==":
          return String(actual ?? "") === String(expected) || (typeof actual === "boolean" && String(actual) === expected);
        case "!=":
          return String(actual ?? "") !== String(expected);
        case "=~":
          return expected instanceof RegExp && typeof actual === "string" && expected.test(actual);
        case ">":
          return Number(actual) > Number(expected);
        case ">=":
          return Number(actual) >= Number(expected);
        case "<":
          return Number(actual) < Number(expected);
        case "<=":
          return Number(actual) <= Number(expected);
        case "in":
        case "not in": {
          const container = lookup(String(expected));
          const found = Array.isArray(container)
            ? container.includes(actual)
            : !!container && typeof container === "object" && String(actual) in (container as object);
          return node.op === "in" ? found : !found;
        }
      }
      return false;
    }
  }
}

/** Evaluate a when clause; an empty clause is true. */
export function evaluateWhen(clause: string | undefined, lookup: ContextLookup): boolean {
  if (!clause?.trim()) return true;
  let node = cache.get(clause);
  if (!node) {
    node = parse(tokenize(clause));
    cache.set(clause, node);
  }
  try {
    return evaluate(node, lookup);
  } catch {
    return false;
  }
}
