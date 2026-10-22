import { RotateCcw, X } from "lucide-react";
import { ModalEditorTitleActions } from "../features/menus-walkthroughs/MenuActions";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  SETTINGS_SCHEMA,
  configurationDefaultLanguages,
  configurationLanguageOverrides,
  getDefaultSettings,
  getSettingsForLanguage,
  resetLanguageSetting,
  resetSetting,
  updateLanguageSetting,
  updateSetting,
  useSettings,
  type SettingKey,
  type Settings,
} from "../lib/settings";
import { extensionService, useExtensions, type ContributedSetting } from "../lib/extensions";

/** A setting contributed by an extension (contributes.configuration). */
function ExtensionSettingRow({ setting }: { setting: ContributedSetting }) {
  const { key, property } = setting;
  const value = extensionService.extensionSetting(key);
  const modified = extensionService.isExtensionSettingModified(key);
  const [draft, setDraft] = useState<string | null>(null);
  const types = [property.type ?? typeof property.default].flat();
  const set = (next: unknown) => extensionService.updateConfiguration(key, next);
  const description = property.description ?? property.markdownDescription?.replace(/`#([\w.-]+)#`/g, "$1") ?? "";
  const label = key.split(".").slice(1).join(" › ") || key;
  let control;
  if (property.enum) {
    control = (
      <select value={JSON.stringify(value)} onChange={(e) => set(JSON.parse(e.target.value))}>
        {property.enum.map((option, index) => (
          <option key={JSON.stringify(option)} value={JSON.stringify(option)} title={property.enumDescriptions?.[index]}>
            {String(option)}
          </option>
        ))}
      </select>
    );
  } else if (types.includes("boolean")) {
    control = (
      <label className="setting-checkbox">
        <input type="checkbox" checked={!!value} onChange={(e) => set(e.target.checked)} />
        {description}
      </label>
    );
  } else if (types.includes("number") || types.includes("integer")) {
    control = (
      <input
        type="number"
        value={typeof value === "number" ? value : ""}
        min={property.minimum}
        max={property.maximum}
        onChange={(e) => {
          const next = Number(e.target.value);
          if (Number.isFinite(next)) set(types.includes("integer") ? Math.round(next) : next);
        }}
      />
    );
  } else if (types.includes("string")) {
    control = <input type="text" spellCheck={false} value={typeof value === "string" ? value : ""} onChange={(e) => set(e.target.value)} />;
  } else {
    // Arrays and objects: edited as JSON.
    const text = draft ?? JSON.stringify(value ?? null, null, 2);
    let valid = true;
    try {
      JSON.parse(text);
    } catch {
      valid = false;
    }
    control = (
      <textarea
        className={`setting-json${valid ? "" : " invalid"}`}
        spellCheck={false}
        rows={Math.min(8, text.split("\n").length)}
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return;
          try {
            set(JSON.parse(draft));
            setDraft(null);
          } catch {
            /* keep the draft until it is valid JSON */
          }
        }}
      />
    );
  }
  return (
    <div className={`setting${modified ? " modified" : ""}`}>
      <div className="setting-title">
        <span className="setting-category">{setting.title}: </span>
        <strong>{label}</strong>
        {modified && (
          <button type="button" className="setting-reset" title="Reset to default" onClick={() => set(undefined)}>
            <RotateCcw size={13} />
          </button>
        )}
      </div>
      <div className="setting-key">{key}</div>
      {!types.includes("boolean") || property.enum ? (
        <>
          <div className="setting-description">{description}</div>
          {control}
        </>
      ) : (
        control
      )}
    </div>
  );
}

type Props = { open: boolean; onClose: () => void };

type TocEntry = { category: string; label: string; count: number; child?: boolean };

/** Category table of contents: core categories, then each extension's settings under "Extensions". */
function SettingsToc({ entries, active, onSelect }: { entries: TocEntry[]; active: string | null; onSelect: (category: string) => void }) {
  return (
    <nav className="settings-toc" aria-label="Setting categories">
      {entries.map((entry) =>
        entry.category ? (
          <button
            key={entry.category}
            type="button"
            className={`settings-toc-item${entry.child ? " child" : ""}${entry.category === active ? " active" : ""}`}
            title={entry.label}
            onClick={() => onSelect(entry.category)}
          >
            <span className="settings-toc-label">{entry.label}</span>
            <span className="settings-toc-count">{entry.count}</span>
          </button>
        ) : (
          <div key={`heading-${entry.label}`} className="settings-toc-heading">
            {entry.label}
          </div>
        ),
      )}
    </nav>
  );
}

export function SettingsEditor({ open, onClose }: Props) {
  const settings = useSettings();
  const extensions = useExtensions();
  const [query, setQuery] = useState("");
  const [modifiedOnly, setModifiedOnly] = useState(false);
  /** "" = user (all languages); otherwise a `[language]` scope. */
  const [language, setLanguage] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** A category picked in the TOC stays highlighted while the list cannot scroll it to the top (end of the list). */
  const pickedCategory = useRef<string | null>(null);

  /** Values and defaults of the selected scope (extension configurationDefaults are the defaults). */
  const scopedSettings = language ? getSettingsForLanguage(language) : settings;
  const scopedDefaults = useMemo(() => getDefaultSettings(language || undefined), [language]);

  const languages = useMemo(() => {
    const ids = new Set([...configurationDefaultLanguages(), ...configurationLanguageOverrides()]);
    for (const contributed of extensionService.contributedLanguages()) ids.add(contributed.id.toLowerCase());
    return [...ids].sort();
  }, [extensions]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    requestAnimationFrame(() => inputRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, typeof SETTINGS_SCHEMA>();
    for (const entry of SETTINGS_SCHEMA) {
      if (modifiedOnly && scopedSettings[entry.key] === scopedDefaults[entry.key]) continue;
      const haystack = `${entry.key} ${entry.label} ${entry.description} ${entry.category}`.toLowerCase();
      if (q && !q.split(/\s+/).every((word) => haystack.includes(word))) continue;
      const list = map.get(entry.category) ?? [];
      list.push(entry);
      map.set(entry.category, list);
    }
    return map;
  }, [query, modifiedOnly, scopedSettings, scopedDefaults]);

  const extensionGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, ContributedSetting[]>();
    for (const setting of extensionService.contributedSettings()) {
      if (modifiedOnly && !extensionService.isExtensionSettingModified(setting.key)) continue;
      const haystack = `${setting.key} ${setting.title} ${setting.property.description ?? setting.property.markdownDescription ?? ""} ${setting.extensionName}`.toLowerCase();
      if (q && !q.split(/\s+/).every((word) => haystack.includes(word))) continue;
      const category = `Extensions › ${setting.title}`;
      map.set(category, [...(map.get(category) ?? []), setting]);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, modifiedOnly, extensions]);

  const toc = useMemo(() => {
    const entries: TocEntry[] = [...groups].map(([category, list]) => ({ category, label: category, count: list.length }));
    if (extensionGroups.size) {
      entries.push({ category: "", label: "Extensions", count: 0 });
      for (const [category, list] of extensionGroups) {
        entries.push({ category, label: category.replace(/^Extensions › /, ""), count: list.length, child: true });
      }
    }
    return entries;
  }, [groups, extensionGroups]);

  /** Highlights the category whose section is at the top of the scrolled list. */
  const syncActiveCategory = () => {
    const body = bodyRef.current;
    if (!body) return;
    if (pickedCategory.current && body.scrollTop + body.clientHeight >= body.scrollHeight - 2) return;
    const top = body.getBoundingClientRect().top;
    let current: string | null = null;
    for (const section of body.querySelectorAll<HTMLElement>(".settings-section")) {
      if (section.getBoundingClientRect().top - top > 24) break;
      current = section.dataset.category ?? null;
    }
    setActiveCategory(current ?? toc.find((entry) => entry.category)?.category ?? null);
  };

  useEffect(() => {
    if (!open) return;
    pickedCategory.current = null;
    bodyRef.current?.scrollTo({ top: 0 });
    syncActiveCategory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, toc]);

  const selectCategory = (category: string) => {
    const body = bodyRef.current;
    const section = body?.querySelector<HTMLElement>(`.settings-section[data-category="${CSS.escape(category)}"]`);
    if (!body || !section) return;
    pickedCategory.current = category;
    body.scrollTo({ top: body.scrollTop + section.getBoundingClientRect().top - body.getBoundingClientRect().top });
    setActiveCategory(category);
  };

  if (!open) return null;

  const set = <K extends SettingKey>(key: K, value: Settings[K]) => {
    if (language) updateLanguageSetting(language, key, value);
    else updateSetting(key, value);
  };

  return (
    <div className="modal-overlay settings-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="settings-editor" role="dialog" aria-label="Settings">
        <div className="settings-header">
          <h2>Settings</h2>
          <input
            ref={inputRef}
            className="settings-search"
            type="text"
            placeholder="Search settings"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {languages.length > 0 && (
            <label className="settings-filter" title="Edit the settings of one language (extension defaults included)">
              <select value={language} onChange={(e) => setLanguage(e.target.value)} aria-label="Settings language">
                <option value="">All languages</option>
                {languages.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="settings-filter">
            <input type="checkbox" checked={modifiedOnly} onChange={(e) => setModifiedOnly(e.target.checked)} />
            Modified
          </label>
          <ModalEditorTitleActions activeEditor="workbench.editor.settings2" />
          <button type="button" className="icon-btn" title="Close (Esc)" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
        <div className="settings-content">
          <SettingsToc entries={toc} active={activeCategory} onSelect={selectCategory} />
          <div
            className="settings-body"
            ref={bodyRef}
            onScroll={syncActiveCategory}
            onWheel={() => (pickedCategory.current = null)}
            onKeyDown={() => (pickedCategory.current = null)}
          >
            {!groups.size && !extensionGroups.size && <div className="tree-empty">No settings found.</div>}
            {[...groups].map(([category, entries]) => (
              <section key={category} className="settings-section" data-category={category}>
                <h3>{category}</h3>
                {entries.map((entry) => {
                  const value = scopedSettings[entry.key];
                  const modified = value !== scopedDefaults[entry.key];
                  return (
                    <div key={entry.key} className={`setting${modified ? " modified" : ""}`}>
                      <div className="setting-title">
                        <span className="setting-category">{entry.category}: </span>
                        <strong>{entry.label}</strong>
                        {modified && (
                          <button
                            type="button"
                            className="setting-reset"
                            title="Reset to default"
                            onClick={() => (language ? resetLanguageSetting(language, entry.key) : resetSetting(entry.key))}
                          >
                            <RotateCcw size={13} />
                          </button>
                        )}
                      </div>
                      <div className="setting-key">{entry.key}</div>
                      {typeof value === "boolean" ? (
                        <label className="setting-checkbox">
                          <input type="checkbox" checked={value} onChange={(e) => set(entry.key, e.target.checked as never)} />
                          {entry.description}
                        </label>
                      ) : (
                        <>
                          <div className="setting-description">{entry.description}</div>
                          {entry.options ? (
                            <select value={String(value)} onChange={(e) => set(entry.key, e.target.value as never)}>
                              {entry.options.map((option) => (
                                <option key={option} value={option}>
                                  {option}
                                </option>
                              ))}
                            </select>
                          ) : typeof value === "number" ? (
                            <input
                              type="number"
                              value={value}
                              min={entry.min}
                              max={entry.max}
                              onChange={(e) => {
                                const next = Number(e.target.value);
                                if (Number.isFinite(next)) set(entry.key, Math.min(entry.max ?? next, Math.max(entry.min ?? next, next)) as never);
                              }}
                            />
                          ) : (
                            <input type="text" spellCheck={false} value={String(value)} onChange={(e) => set(entry.key, e.target.value as never)} />
                          )}
                        </>
                      )}
                    </div>
                  );
                })}
              </section>
            ))}
            {[...extensionGroups].map(([category, entries]) => (
              <section key={category} className="settings-section" data-category={category}>
                <h3>{category}</h3>
                {entries.map((setting) => (
                  <ExtensionSettingRow key={setting.key} setting={setting} />
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
