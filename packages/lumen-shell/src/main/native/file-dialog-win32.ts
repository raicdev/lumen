import koffi from "koffi";
import { win32 } from "path";
import {
  CoCreateInstance,
  CoInitializeEx,
  GetAt,
  GetPointer,
  GetUInt32,
  PassPointer,
  S_OK,
  asPointer,
  call,
  guid,
  release,
  takeString,
  type Pointer,
} from "./com.ts";
import type { NativeHandle } from "./webview.ts";
import type { OpenDialogOptions, SaveDialogOptions } from "./platform.ts";

/**
 * The Explorer-style open / save dialogs (IFileOpenDialog, IFileSaveDialog),
 * called in-process through COM. The window's thread is already an STA (WebView2
 * needs one), and the dialog's modal loop keeps pumping its messages, so the
 * windows stay painted while it is open. Slots come from shobjidl_core.h.
 */

const CLSID_FILE_OPEN_DIALOG = guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7");
const CLSID_FILE_SAVE_DIALOG = guid("C0B4E2F3-BA21-4773-8DBA-335EC946EB8B");
const IID_IFILE_OPEN_DIALOG = guid("D57C7288-D4AD-4768-BE02-9D969532D960");
const IID_IFILE_SAVE_DIALOG = guid("84BCCD23-5FDE-4CDB-AEA4-AF64B83D78AB");
const IID_ISHELL_ITEM = guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");

const CLSCTX_INPROC_SERVER = 1;
const COINIT_APARTMENTTHREADED = 2;
const RPC_E_CHANGED_MODE = 0x80010106 | 0;
const ERROR_CANCELLED = 0x800704c7 | 0;
const SIGDN_FILESYSPATH = 0x80058000 | 0;

const FOS_OVERWRITEPROMPT = 0x2;
const FOS_NOCHANGEDIR = 0x8;
const FOS_PICKFOLDERS = 0x20;
const FOS_FORCEFILESYSTEM = 0x40;
const FOS_ALLOWMULTISELECT = 0x200;
const FOS_PATHMUSTEXIST = 0x800;
const FOS_FILEMUSTEXIST = 0x1000;

// IModalWindow / IFileDialog / IFileOpenDialog
const SHOW = 3;
const SET_FILE_TYPES = 4;
const SET_OPTIONS = 9;
const GET_OPTIONS = 10;
const SET_FOLDER = 12;
const SET_FILE_NAME = 15;
const SET_TITLE = 17;
const GET_RESULT = 20;
const SET_DEFAULT_EXTENSION = 22;
const GET_RESULTS = 27;
// IShellItemArray / IShellItem
const ARRAY_GET_COUNT = 7;
const ARRAY_GET_ITEM_AT = 8;
const ITEM_GET_DISPLAY_NAME = 5;

// COMDLG_FILTERSPEC, named for the prototype below.
koffi.struct("LumenFilterSpec", { name: "const char16_t *", spec: "const char16_t *" });
const SetFileTypes = koffi.proto("int32_t __stdcall LumenDialogSetFileTypes(void *self, uint32_t count, const LumenFilterSpec *specs)");
const PutUInt32 = koffi.proto("int32_t __stdcall LumenDialogPutUInt32(void *self, uint32_t value)");
const PutString = koffi.proto("int32_t __stdcall LumenDialogPutString(void *self, const char16_t *value)");
const GetDisplayName = koffi.proto("int32_t __stdcall LumenShellItemGetDisplayName(void *self, int32_t form, _Out_ void **name)");

const shell32 = process.platform === "win32" ? koffi.load("shell32.dll") : null;
const SHCreateItemFromParsingName = shell32?.func(
  "int32_t __stdcall SHCreateItemFromParsingName(const char16_t *path, void *bindContext, const void *iid, _Out_ void **item)",
);

function filePath(item: Pointer): string | null {
  const out: unknown[] = [null];
  if (call(item, ITEM_GET_DISPLAY_NAME, GetDisplayName, SIGDN_FILESYSPATH, out) !== S_OK) return null;
  return takeString(asPointer(out[0])) || null;
}

/** Start the dialog in `folder`, when it exists. */
function setFolder(dialog: Pointer, folder: string): void {
  // The shell parses backslashed paths only, and a trailing separator only on a drive root.
  const path = win32.normalize(folder).replace(/(?<!^[A-Za-z]:)\\+$/, "");
  const out: unknown[] = [null];
  if (!SHCreateItemFromParsingName || SHCreateItemFromParsingName(path, null, IID_ISHELL_ITEM, out) !== S_OK) return;
  const item = asPointer(out[0]);
  call(dialog, SET_FOLDER, PassPointer, item);
  release(item);
}

function setFilters(dialog: Pointer, filters: OpenDialogOptions["filters"], withAllFiles: boolean): void {
  const specs = (filters ?? []).map((filter) => ({ name: filter.name, spec: filter.extensions.map((ext) => (ext === "*" ? "*.*" : `*.${ext}`)).join(";") }));
  if (withAllFiles && !specs.some((spec) => spec.spec === "*.*")) specs.push({ name: "All files (*.*)", spec: "*.*" });
  if (specs.length) call(dialog, SET_FILE_TYPES, SetFileTypes, specs.length, specs);
}

type DialogRun = { kind: "open"; options: OpenDialogOptions } | { kind: "save"; options: SaveDialogOptions };

/**
 * Show the dialog: the chosen paths ([] when cancelled), or `null` when the
 * dialog could not be created (no COM here): the caller falls back.
 */
function runDialog(run: DialogRun, owner: NativeHandle | undefined): string[] | null {
  if (!CoCreateInstance || !CoInitializeEx) return null;
  // S_OK or S_FALSE: an STA (the WebView2 thread). A multithreaded apartment cannot host the dialog.
  if (CoInitializeEx(null, COINIT_APARTMENTTHREADED) === RPC_E_CHANGED_MODE) return null;
  const save = run.kind === "save";
  const out: unknown[] = [null];
  const created = CoCreateInstance(
    save ? CLSID_FILE_SAVE_DIALOG : CLSID_FILE_OPEN_DIALOG,
    null,
    CLSCTX_INPROC_SERVER,
    save ? IID_IFILE_SAVE_DIALOG : IID_IFILE_OPEN_DIALOG,
    out,
  );
  if (created !== S_OK) return null;
  const dialog = asPointer(out[0]);
  try {
    const flags = [0];
    call(dialog, GET_OPTIONS, GetUInt32, flags);
    let options = flags[0]! | FOS_FORCEFILESYSTEM | FOS_NOCHANGEDIR | FOS_PATHMUSTEXIST;
    if (run.kind === "open") {
      const properties = run.options.properties ?? [];
      if (properties.includes("openDirectory")) options |= FOS_PICKFOLDERS;
      else options |= FOS_FILEMUSTEXIST;
      if (properties.includes("multiSelections")) options |= FOS_ALLOWMULTISELECT;
    } else {
      options |= FOS_OVERWRITEPROMPT;
    }
    call(dialog, SET_OPTIONS, PutUInt32, options >>> 0);
    if (run.options.title) call(dialog, SET_TITLE, PutString, run.options.title);

    const defaultPath = run.options.defaultPath ?? "";
    if (run.kind === "open") {
      if (defaultPath) setFolder(dialog, defaultPath);
      if (!(run.options.properties ?? []).includes("openDirectory")) setFilters(dialog, run.options.filters, true);
    } else {
      // A directory to start in, or a full path: its folder and the suggested name.
      const fileName = /[\\/]$/.test(defaultPath) ? "" : (defaultPath.split(/[\\/]/).pop() ?? "");
      const directory = fileName ? defaultPath.slice(0, defaultPath.length - fileName.length) : defaultPath;
      if (directory) setFolder(dialog, directory);
      if (fileName) call(dialog, SET_FILE_NAME, PutString, fileName);
      setFilters(dialog, run.options.filters, true);
      // Typing a name without an extension adds the first filter's.
      const extension = run.options.filters?.[0]?.extensions[0];
      if (extension && extension !== "*") call(dialog, SET_DEFAULT_EXTENSION, PutString, extension);
    }

    const shown = call(dialog, SHOW, PassPointer, owner ?? null);
    if (shown === ERROR_CANCELLED) return [];
    if (shown !== S_OK) throw new Error(`the file dialog failed (0x${(shown >>> 0).toString(16)})`);

    if (run.kind === "save") {
      const item: unknown[] = [null];
      if (call(dialog, GET_RESULT, GetPointer, item) !== S_OK) return [];
      try {
        const path = filePath(asPointer(item[0]));
        return path ? [path] : [];
      } finally {
        release(asPointer(item[0]));
      }
    }
    const results: unknown[] = [null];
    if (call(dialog, GET_RESULTS, GetPointer, results) !== S_OK) return [];
    const array = asPointer(results[0]);
    try {
      const count = [0];
      call(array, ARRAY_GET_COUNT, GetUInt32, count);
      const paths: string[] = [];
      for (let index = 0; index < count[0]!; index++) {
        const item: unknown[] = [null];
        if (call(array, ARRAY_GET_ITEM_AT, GetAt, index, item) !== S_OK) continue;
        const path = filePath(asPointer(item[0]));
        release(asPointer(item[0]));
        if (path) paths.push(path);
      }
      return paths;
    } finally {
      release(array);
    }
  } finally {
    release(dialog);
  }
}

/** Paths picked in the open dialog; `null` when it is not available (fall back to another). */
export function nativeOpenDialog(options: OpenDialogOptions, owner?: NativeHandle): string[] | null {
  return runDialog({ kind: "open", options }, owner);
}

/** The path picked in the save dialog (`undefined` when cancelled); `null` when it is not available. */
export function nativeSaveDialog(options: SaveDialogOptions, owner?: NativeHandle): string | undefined | null {
  const paths = runDialog({ kind: "save", options }, owner);
  return paths === null ? null : paths[0];
}
