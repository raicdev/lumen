/** Menu description shared by the main process and the in-page menu renderer. */
export type MenuEntry = {
  label?: string;
  action?: string;
  /** Best-effort browser edit role: undo | redo | cut | copy | paste | selectAll. */
  role?: string;
  /** Display-only accelerator hint (the page keeps handling the real keys). */
  accelerator?: string;
  type?: "normal" | "separator";
  enabled?: boolean;
};

export type MenuGroup = {
  label: string;
  submenu: MenuEntry[];
};
