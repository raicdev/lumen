import { Check, ChevronRight } from "lucide-react";
import { useState, type MouseEvent } from "react";
import type { ScmControlData, ScmGroupData, ScmViewMessage } from "../../shared/scm-protocol";
import { FileIcon } from "../components/FileIcon";
import { WithCodicons } from "../components/Codicon";
import { featureApi } from "./registry";
import { resourceIcon, scmDarkTheme, scmInputs, scmStore, type ScmResourceIcon } from "./scm-store";
import { useStore } from "./store";
import { MenuActions } from "./menus-walkthroughs/MenuActions";
import { refArg, showContributedMenu, uriArg } from "./menus-walkthroughs/menus";

/**
 * Extension source controls, shown in the Source Control view under the
 * built-in git UI, with their contributed menus: scm/title and
 * scm/repository (header), scm/sourceControl (header right click),
 * scm/resourceGroup/context, scm/resourceState/context and
 * scm/resourceFolder/context (a row's folder) — `inline` entries as buttons.
 */

const send = (message: ScmViewMessage) => featureApi("scm").sendToHost(message);

const controlRef = (control: ScmControlData) => refArg("scm", { control: control.handle });
const groupRef = (control: ScmControlData, group: ScmGroupData) => refArg("scm", { control: control.handle, group: group.handle });
const resourceRef = (control: ScmControlData, group: ScmGroupData, index: number) => refArg("scm", { control: control.handle, group: group.handle, index });

/** Context keys of the scm/* menus. */
function scmLookup(control: ScmControlData, group?: ScmGroupData, contextValue?: string): (key: string) => unknown {
  return (key) => {
    switch (key) {
      case "scmProvider":
        return control.id;
      case "scmProviderRootUri":
        return control.rootPath;
      case "scmProviderHasRootUri":
        return !!control.rootPath;
      case "scmResourceGroup":
        return group?.id;
      case "scmResourceState":
        return contextValue;
      case "scmRepositoryCount":
        return scmStore.get().controls.length;
      default:
        return undefined;
    }
  };
}

/** The icon of a resource state: the extension's `decorations.iconPath` (light/dark variant, or a theme icon), else the file's type icon. */
function ResourceIcon({ name, icon }: { name: string; icon?: ScmResourceIcon }) {
  const dark = useStore(scmDarkTheme);
  if (icon?.codicon) {
    return (
      <span className="scm-resource-icon scm-resource-codicon" aria-hidden="true">
        <WithCodicons text={`$(${icon.codicon})`} size={14} />
      </span>
    );
  }
  const src = dark ? (icon?.dark ?? icon?.light) : (icon?.light ?? icon?.dark);
  if (src) return <img className="scm-resource-icon" src={src} alt="" aria-hidden="true" />;
  return <FileIcon name={name} />;
}

function ResourceRow({ control, group, index }: { control: ScmControlData; group: ScmGroupData; index: number }) {
  const resource = group.resources[index]!;
  const open = () => {
    if (resource.hasCommand) send({ kind: "resource", handle: control.handle, group: group.handle, index: resource.index });
    else void featureApi("scm").openFile(resource.path);
  };
  const lookup = scmLookup(control, group, resource.contextValue);
  const args = [resourceRef(control, group, resource.index)];
  // The folder of the row: scm/resourceFolder/context, with the folder and the states inside it.
  const folderMenu = (e: MouseEvent) => {
    if (!resource.description) return;
    const folder = resource.path.slice(0, resource.path.length - resource.label.length - 1);
    const inside = group.resources.filter((entry) => entry.path.startsWith(`${folder}/`) || entry.path.startsWith(`${folder}\\`));
    if (showContributedMenu(e, "scm/resourceFolder/context", scmLookup(control, group), () => [uriArg(folder), ...inside.map((entry) => resourceRef(control, group, entry.index))])) e.stopPropagation();
  };
  return (
    <div
      className="scm-row"
      onClick={open}
      onContextMenu={(e) => showContributedMenu(e, "scm/resourceState/context", lookup, args)}
      title={resource.tooltip ? `${resource.path} • ${resource.tooltip}` : resource.path}
    >
      <ResourceIcon name={resource.label} icon={resourceIcon(resource)} />
      <span className={`scm-name${resource.strikeThrough ? " deleted" : ""}${resource.faded ? " scm-faded" : ""}`}>{resource.label}</span>
      <span className="scm-dir" onContextMenu={folderMenu}>
        {resource.description}
      </span>
      <MenuActions menuId="scm/resourceState/context" lookup={lookup} args={args} inline={["inline"]} overflow={false} className="scm-row-actions" />
      {resource.letter && <span className="scm-letter">{resource.letter}</span>}
    </div>
  );
}

function Group({ control, group }: { control: ScmControlData; group: ScmGroupData }) {
  const [open, setOpen] = useState(true);
  if (group.hideWhenEmpty && !group.resources.length) return null;
  return (
    <div className="scm-section">
      <div
        className="scm-section-header"
        onClick={() => setOpen((value) => !value)}
        onContextMenu={(e) => showContributedMenu(e, "scm/resourceGroup/context", scmLookup(control, group), [groupRef(control, group)])}
      >
        <span className={`chevron${open ? " open" : ""}`}>
          <ChevronRight size={14} />
        </span>
        <span className="scm-section-title">{group.label}</span>
        <MenuActions menuId="scm/resourceGroup/context" lookup={scmLookup(control, group)} args={[groupRef(control, group)]} inline={["inline"]} overflow={false} className="scm-row-actions" />
        <span className="badge">{group.resources.length}</span>
      </div>
      {open && group.resources.map((_, index) => <ResourceRow key={`${group.handle}:${index}`} control={control} group={group} index={index} />)}
    </div>
  );
}

function InputBox({ control }: { control: ScmControlData }) {
  const inputs = useStore(scmInputs);
  const value = inputs[control.handle] ?? control.inputBox.value;
  const box = control.inputBox;
  const accept = () => {
    if (box.enabled) send({ kind: "accept", handle: control.handle });
  };
  if (!box.visible) return null;
  return (
    <div className="scm-commit">
      <textarea
        className="scm-message"
        placeholder={box.placeholder || (control.accept ? "Message (Ctrl+Enter to accept)" : "")}
        value={value}
        disabled={!box.enabled}
        rows={Math.min(8, Math.max(2, value.split("\n").length))}
        onChange={(e) => {
          scmInputs.set((previous) => ({ ...previous, [control.handle]: e.target.value }));
          send({ kind: "input", handle: control.handle, value: e.target.value });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            accept();
          }
        }}
      />
      {box.validation && <div className={`scm-validation scm-validation-${box.validation.type}`}>{box.validation.message}</div>}
      {control.accept && (
        <button type="button" className="primary-btn scm-commit-btn" disabled={!box.enabled} title={control.accept.tooltip} onClick={accept}>
          <Check size={15} /> {control.accept.title}
        </button>
      )}
    </div>
  );
}

function Control({ control }: { control: ScmControlData }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="scm-ext-control">
      <div
        className="scm-section-header scm-ext-header"
        onClick={() => setOpen((value) => !value)}
        onContextMenu={(e) => showContributedMenu(e, ["scm/repository", "scm/sourceControl"], scmLookup(control), [controlRef(control)])}
      >
        <span className={`chevron${open ? " open" : ""}`}>
          <ChevronRight size={14} />
        </span>
        <span className="scm-section-title" title={control.extensionId}>
          {control.label}
        </span>
        <span className="scm-ext-status">
          {control.statusBarCommands.map((command, index) => (
            <button
              key={index}
              type="button"
              className="scm-ext-status-btn"
              title={command.tooltip ?? command.title}
              onClick={(e) => {
                e.stopPropagation();
                send({ kind: "statusCommand", handle: control.handle, index });
              }}
            >
              {command.title}
            </button>
          ))}
        </span>
        <MenuActions menuId="scm/sourceControl" lookup={scmLookup(control)} args={[controlRef(control)]} inline={["inline"]} overflow={false} />
        <MenuActions menuId="scm/title" lookup={scmLookup(control)} args={[controlRef(control)]} />
        <span className="badge">{control.count}</span>
      </div>
      {open && (
        <>
          <InputBox control={control} />
          {control.groups.map((group) => (
            <Group key={group.handle} control={control} group={group} />
          ))}
        </>
      )}
    </div>
  );
}

export function ExtensionScm() {
  const { controls, busy } = useStore(scmStore);
  if (!controls.length) return null;
  return (
    <div className="scm-ext">
      {busy > 0 && <div className="scm-progress" role="progressbar" />}
      {controls.map((control) => (
        <Control key={control.handle} control={control} />
      ))}
    </div>
  );
}
