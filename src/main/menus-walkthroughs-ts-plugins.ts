import { createRequire } from "node:module";
import { join } from "node:path";
import type ts from "typescript";

/**
 * contributes.typescriptServerPlugins: TypeScript language service plug-ins
 * shipped by extensions (the `tsserver` plug-in protocol), loaded into Lumen's
 * in-process language service (src/main/lsp.ts).
 *
 * What works: `init({ typescript })` / `create(info)` with `info.languageService`,
 * `info.languageServiceHost`, `info.config`, `info.serverHost` and a minimal
 * `info.project`; the plug-in's decorated service answers completions, quick
 * info, diagnostics, definitions, code fixes, ... like tsserver's.
 * What does not: `getExternalFiles`, `onConfigurationChanged` pushes from
 * extensions (the config is whatever `setTsPluginConfig` was given), plug-ins
 * that need tsserver's `ProjectService` beyond the logger.
 */

export type TsServerPluginContribution = {
  name: string;
  enableForWorkspaceTypeScriptVersions?: boolean;
  languages?: string[];
  configNamespace?: string;
};

export type TsServerPluginSpec = {
  extensionId: string;
  /** Extension folder: the plug-in package is resolved from here (its node_modules). */
  location: string;
  name: string;
  /** Key of the plug-in's configuration (`configNamespace`, else the plug-in name). */
  configKey: string;
};

type ExtensionLike = { id: string; location: string; manifest: { contributes?: Record<string, unknown> } };

/** The plug-ins of the enabled extensions' manifests. */
export function tsServerPluginsOf(extensions: ExtensionLike[]): TsServerPluginSpec[] {
  const out: TsServerPluginSpec[] = [];
  for (const extension of extensions) {
    const raw = extension.manifest.contributes?.typescriptServerPlugins;
    for (const plugin of (Array.isArray(raw) ? raw : []) as TsServerPluginContribution[]) {
      if (!plugin || typeof plugin.name !== "string" || !plugin.name) continue;
      out.push({ extensionId: extension.id, location: extension.location, name: plugin.name, configKey: plugin.configNamespace || plugin.name });
    }
  }
  return out;
}

type PluginModule = { create(info: unknown): ts.LanguageService; onConfigurationChanged?(config: unknown): void };
type PluginFactory = (modules: { typescript: typeof ts }) => PluginModule;

export type TsPluginLog = (message: string) => void;

/** Plug-in configuration by `configKey` (what an extension's `configurePlugin` call would send). */
const configs = new Map<string, unknown>();
/** Loaded plug-ins, so a configuration change reaches them. */
const loaded = new Map<string, PluginModule>();

export function setTsPluginConfig(configKey: string, config: unknown): void {
  configs.set(configKey, config);
  loaded.get(configKey)?.onConfigurationChanged?.(config);
}

function loadFactory(spec: TsServerPluginSpec): PluginFactory {
  // From the extension folder: `require("<name>")` finds node_modules/<name> next to its package.json.
  const requireFromExtension = createRequire(join(spec.location, "package.json"));
  const mod = requireFromExtension(spec.name) as PluginFactory | { default?: PluginFactory };
  const factory = typeof mod === "function" ? mod : mod.default;
  if (typeof factory !== "function") throw new Error(`'${spec.name}' does not export a plugin factory`);
  return factory;
}

/**
 * Wraps a language service with the plug-ins, in order (each one decorates the
 * previous one's result, as in tsserver). A plug-in that fails to load or
 * create is skipped and logged; the others still apply.
 */
export function applyTsServerPlugins(
  typescript: typeof ts,
  service: ts.LanguageService,
  host: ts.LanguageServiceHost,
  specs: TsServerPluginSpec[],
  log: TsPluginLog = () => {},
  currentDirectory: string = host.getCurrentDirectory?.() ?? process.cwd(),
): ts.LanguageService {
  let decorated = service;
  loaded.clear();
  for (const spec of specs) {
    try {
      const module = loadFactory(spec)({ typescript });
      const info = {
        languageService: decorated,
        languageServiceHost: host,
        serverHost: typescript.sys,
        config: configs.get(spec.configKey) ?? {},
        project: {
          getProjectName: () => currentDirectory,
          getCurrentDirectory: () => currentDirectory,
          getCompilerOptions: () => host.getCompilationSettings(),
          projectService: { logger: { info: log, msg: log, hasLevel: () => false, loggingEnabled: () => false } },
          log,
        },
      };
      decorated = module.create(info);
      loaded.set(spec.configKey, module);
    } catch (error) {
      log(`typescript plugin '${spec.name}' (${spec.extensionId}) failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return decorated;
}
