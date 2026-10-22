import type {
  HostDecorationAttachment,
  HostDecorationInstanceRenderOptions,
  HostDecorationRenderOptions,
  HostDecorationStyle,
  HostDecorationType,
} from "../../shared/extensions.ts";

/**
 * window.createTextEditorDecorationType / TextEditor.setDecorations options:
 * VS Code's DecorationRenderOptions and DecorationOptions.renderOptions as the
 * style the view applies. Pure (colors and images come in as converters), so
 * the extension host and the tests share it.
 */

/** How the host makes a color and an image file usable in the window. */
export type DecorationConverters = {
  color: (value: unknown) => string | undefined;
  image: (value: unknown) => { light?: string; dark?: string } | undefined;
};

/** A CSS value as given by an extension (strings; numbers for lengths like opacity). */
function text(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Drop undefined members, so an absent option does not overwrite a base value when merged. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/** The border shorthand of ThemableDecorationRenderOptions (its parts have CSS defaults). */
function borderOf(value: any, convert: DecorationConverters): string | undefined {
  if (value.border) return text(value.border);
  if (!value.borderWidth && !value.borderStyle && !value.borderColor) return undefined;
  return `${text(value.borderWidth) ?? "1px"} ${text(value.borderStyle) ?? "solid"} ${convert.color(value.borderColor) ?? "currentColor"}`;
}

/** The outline shorthand of ThemableDecorationRenderOptions. */
function outlineOf(value: any, convert: DecorationConverters): string | undefined {
  if (value.outline) return text(value.outline);
  if (!value.outlineWidth && !value.outlineStyle && !value.outlineColor) return undefined;
  return `${text(value.outlineWidth) ?? "1px"} ${text(value.outlineStyle) ?? "solid"} ${convert.color(value.outlineColor) ?? "currentColor"}`;
}

/** ThemableDecorationAttachmentRenderOptions → the attachment the view renders. */
export function decorationAttachment(value: any, convert: DecorationConverters): HostDecorationAttachment | undefined {
  if (!value || typeof value !== "object") return undefined;
  const attachment = compact<HostDecorationAttachment>({
    contentText: text(value.contentText),
    contentIcon: convert.image(value.contentIconPath),
    border: borderOf(value, convert),
    borderColor: convert.color(value.borderColor),
    textDecoration: text(value.textDecoration),
    color: convert.color(value.color),
    backgroundColor: convert.color(value.backgroundColor),
    margin: text(value.margin),
    width: text(value.width),
    height: text(value.height),
    fontStyle: text(value.fontStyle),
    fontWeight: text(value.fontWeight),
  });
  return Object.keys(attachment).length ? attachment : undefined;
}

/** ThemableDecorationRenderOptions → the style the view applies. */
function styleOf(value: any, convert: DecorationConverters): HostDecorationStyle {
  return compact<HostDecorationStyle>({
    backgroundColor: convert.color(value.backgroundColor),
    color: convert.color(value.color),
    border: borderOf(value, convert),
    borderColor: convert.color(value.borderColor),
    borderStyle: text(value.borderStyle),
    borderWidth: text(value.borderWidth),
    borderSpacing: text(value.borderSpacing),
    borderRadius: text(value.borderRadius),
    outline: outlineOf(value, convert),
    outlineColor: convert.color(value.outlineColor),
    outlineStyle: text(value.outlineStyle),
    outlineWidth: text(value.outlineWidth),
    fontWeight: text(value.fontWeight),
    fontStyle: text(value.fontStyle),
    textDecoration: text(value.textDecoration),
    opacity: text(value.opacity),
    cursor: text(value.cursor),
    letterSpacing: text(value.letterSpacing),
    overviewRulerColor: convert.color(value.overviewRulerColor),
    before: decorationAttachment(value.before, convert),
    after: decorationAttachment(value.after, convert),
  });
}

/** A theme variant: the base style with the variant's own options on top. */
function mergeStyle(base: HostDecorationStyle, variant: HostDecorationStyle): HostDecorationStyle {
  return compact<HostDecorationStyle>({
    ...base,
    ...variant,
    before: base.before || variant.before ? { ...base.before, ...variant.before } : undefined,
    after: base.after || variant.after ? { ...base.after, ...variant.after } : undefined,
  });
}

/** DecorationRenderOptions → the style and per-theme variants the view stores. */
export function decorationTypeOptions(options: any, convert: DecorationConverters): HostDecorationType {
  const source = options && typeof options === "object" ? options : {};
  const base = styleOf(source, convert);
  const type: HostDecorationType = {
    ...base,
    isWholeLine: !!source.isWholeLine,
    rangeBehavior: typeof source.rangeBehavior === "number" ? source.rangeBehavior : 0,
  };
  const gutterIcon = convert.image(source.gutterIconPath);
  if (gutterIcon) type.gutterIcon = gutterIcon;
  if (typeof source.gutterIconSize === "string") type.gutterIconSize = source.gutterIconSize;
  if (typeof source.overviewRulerLane === "number") type.overviewRulerLane = source.overviewRulerLane;
  // The view has no theme colors of its own: send both variants (VS Code's light / dark overrides).
  if (source.light && typeof source.light === "object") type.light = mergeStyle(base, styleOf(source.light, convert));
  if (source.dark && typeof source.dark === "object") type.dark = mergeStyle(base, styleOf(source.dark, convert));
  return type;
}

/** DecorationOptions.renderOptions → a range's own attachments, with their theme variants. */
export function decorationRenderOptions(value: any, convert: DecorationConverters): HostDecorationRenderOptions | undefined {
  if (!value || typeof value !== "object") return undefined;
  const instance = (part: any): HostDecorationInstanceRenderOptions | undefined => {
    if (!part || typeof part !== "object") return undefined;
    const options = compact<HostDecorationInstanceRenderOptions>({
      before: decorationAttachment(part.before, convert),
      after: decorationAttachment(part.after, convert),
    });
    return Object.keys(options).length ? options : undefined;
  };
  const renderOptions = compact<HostDecorationRenderOptions>({
    ...instance(value),
    light: instance(value.light),
    dark: instance(value.dark),
  });
  return Object.keys(renderOptions).length ? renderOptions : undefined;
}
