import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { INITIAL, Registry, parseRawGrammar, type IGrammar, type IOnigLib, type IRawGrammar, type IToken, type StateStack } from "vscode-textmate";
import { createOnigScanner, createOnigString, loadWASM } from "vscode-oniguruma";
import onigWasm from "vscode-oniguruma/release/onig.wasm";
import type { ExtensionGrammar } from "../../shared/types";
import { api } from "./rpc";
import { textMateTokenStyle } from "./textmate-scopes";
import { textMateTokenName, textMateTokenTable } from "./theme";

/**
 * TextMate grammars from installed extensions, through vscode-textmate.
 * Grammars live on disk, so their contributions (and their text) come over the
 * main-process RPC; this module turns the loaded grammar into a CodeMirror
 * language for the editor.
 */

/** One pathological line must not freeze the UI. */
const MAX_LINE_LENGTH = 10_000;
const TOKENIZE_TIME_LIMIT = 50;

type TextMateState = {
  /** The grammar's immutable stack carried from line to line. */
  stack: StateStack | null;
  tokens: readonly IToken[];
  index: number;
};

type GrammarIndex = {
  byScope: Map<string, ExtensionGrammar>;
  byLanguage: Map<string, ExtensionGrammar>;
  injections: Map<string, string[]>;
};

let indexPromise: Promise<GrammarIndex> | null = null;
/** The grammar list the cached index was built from (to tell real changes apart). */
let signature: string | null = null;
let onigLib: Promise<IOnigLib> | null = null;
/** One registry per index: grammar loads in flight keep the index they started with. */
const registries = new WeakMap<GrammarIndex, Promise<Registry>>();
const languages = new Map<string, Promise<Extension | null>>();

function buildIndex(grammars: ExtensionGrammar[]): GrammarIndex {
  const byScope = new Map<string, ExtensionGrammar>();
  const byLanguage = new Map<string, ExtensionGrammar>();
  const injections = new Map<string, string[]>();
  for (const grammar of grammars) {
    if (!byScope.has(grammar.scopeName)) byScope.set(grammar.scopeName, grammar);
    if (!byLanguage.has(grammar.language)) byLanguage.set(grammar.language, grammar);
    for (const target of grammar.injectTo ?? []) {
      const scopes = injections.get(target) ?? [];
      if (!scopes.includes(grammar.scopeName)) scopes.push(grammar.scopeName);
      injections.set(target, scopes);
    }
  }
  return { byScope, byLanguage, injections };
}

function grammarIndex(): Promise<GrammarIndex> {
  indexPromise ??= api()
    .request.extensionGrammars({})
    .then(({ grammars }) => {
      signature = JSON.stringify(grammars);
      return buildIndex(grammars);
    })
    .catch((error: unknown) => {
      console.error("[textmate] could not read the extensions' grammars", error);
      indexPromise = null; // retry next time
      return buildIndex([]);
    });
  return indexPromise;
}

function loadOniguruma(): Promise<IOnigLib> {
  onigLib ??= loadWASM(onigWasm).then(() => ({ createOnigScanner, createOnigString }));
  return onigLib;
}

async function loadRawGrammar(index: GrammarIndex, scopeName: string): Promise<IRawGrammar | null> {
  const grammar = index.byScope.get(scopeName);
  if (!grammar) return null;
  try {
    const { content } = await api().request.extensionGrammarFile({ path: grammar.path });
    if (content === null) return null;
    // parseRawGrammar understands both .tmLanguage JSON and plist XML.
    return parseRawGrammar(content, grammar.path);
  } catch (error) {
    console.error(`[textmate] could not read the grammar for ${scopeName}`, error);
    return null;
  }
}

function getRegistry(index: GrammarIndex): Promise<Registry> {
  let registry = registries.get(index);
  if (!registry) {
    registry = loadOniguruma().then(
      (lib) =>
        new Registry({
          onigLib: Promise.resolve(lib),
          loadGrammar: (scopeName) => loadRawGrammar(index, scopeName),
          // `injectTo` grammars are loaded (and applied) as injections of their targets.
          getInjections: (scopeName) => index.injections.get(scopeName),
        }),
    );
    registries.set(index, registry);
  }
  return registry;
}

/**
 * Extensions were installed, enabled or disabled (or registered providers):
 * forget grammars and languages if the contributed grammars actually changed.
 * Resolves to whether they did.
 */
export async function refreshTextMateGrammars(): Promise<boolean> {
  if (signature === null) return false; // nothing loaded yet, nothing cached
  let next: string;
  try {
    next = JSON.stringify((await api().request.extensionGrammars({})).grammars);
  } catch {
    return false;
  }
  if (next === signature) return false;
  signature = null;
  indexPromise = null;
  languages.clear();
  return true;
}

/** A CodeMirror language for an extension's TextMate grammar, if one exists. */
export function textMateLanguage(languageId: string): Promise<Extension | null> {
  let language = languages.get(languageId);
  if (!language) {
    language = createLanguage(languageId);
    languages.set(languageId, language);
    // Don't remember a failure: the grammar may become available later.
    void language.then((result) => {
      if (!result && languages.get(languageId) === language) languages.delete(languageId);
    });
  }
  return language;
}

async function createLanguage(languageId: string): Promise<Extension | null> {
  const grammars = await grammarIndex();
  const contribution = grammars.byLanguage.get(languageId);
  if (!contribution) return null;

  let grammar: IGrammar | null;
  try {
    grammar = await (await getRegistry(grammars)).loadGrammar(contribution.scopeName);
  } catch (error) {
    console.error(`[textmate] could not load the grammar for ${languageId}`, error);
    return null;
  }
  if (!grammar) return null;

  return StreamLanguage.define<TextMateState>({
    name: `${languageId} (TextMate)`,
    // Tokens keep their full scopes so the color theme's rules apply as in VS Code.
    tokenTable: textMateTokenTable,
    startState: () => ({ stack: INITIAL, tokens: [], index: 0 }),
    // The TextMate stack is immutable; only the per-line token cursor is copied.
    copyState: (state) => ({ ...state }),
    // Blank lines still advance multi-line constructs (comments, strings, …).
    blankLine: (state) => {
      try {
        state.stack = grammar.tokenizeLine("", state.stack, TOKENIZE_TIME_LIMIT).ruleStack;
      } catch (error) {
        console.error(`[textmate] tokenizing a blank line of ${contribution.scopeName} failed`, error);
      }
      state.tokens = [];
      state.index = 0;
    },
    token: (stream, state) => {
      if (stream.sol()) {
        const line = stream.string;
        state.index = 0;
        state.tokens = [];
        if (line.length > MAX_LINE_LENGTH) {
          stream.skipToEnd();
          return null;
        }
        try {
          const result = grammar.tokenizeLine(line, state.stack, TOKENIZE_TIME_LIMIT);
          state.stack = result.ruleStack;
          state.tokens = result.tokens;
        } catch (error) {
          console.error(`[textmate] tokenizing ${contribution.scopeName} failed`, error);
          stream.skipToEnd();
          return null;
        }
      }

      while (state.index < state.tokens.length && state.tokens[state.index].endIndex <= stream.pos) state.index++;
      const token = state.tokens[state.index];
      if (!token) {
        stream.skipToEnd();
        return null;
      }
      stream.pos = Math.min(token.endIndex, stream.string.length);
      return textMateTokenName(token.scopes, textMateTokenStyle(token.scopes));
    },
  });
}
