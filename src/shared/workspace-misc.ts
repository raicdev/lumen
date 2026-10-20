/**
 * Input box validation severity travels from the extension host to the window
 * inside the validation message string (the protocol carries a plain string):
 * Error (the default, and what a plain string means) is the message itself,
 * Info and Warning get a two-character marker in front.
 */

export type ValidationSeverity = "info" | "warning" | "error";

const MARK = "\u0001";

/** `InputBoxValidationSeverity` (1 Info, 2 Warning, 3 Error) and the message → what the host posts. */
export function encodeValidation(message: string | null | undefined, severity: number | undefined): string | null {
  if (!message) return null;
  if (severity === 1) return `${MARK}i${MARK}${message}`;
  if (severity === 2) return `${MARK}w${MARK}${message}`;
  return message;
}

/** The message and severity of a posted validation string (`null` when there is none). */
export function decodeValidation(raw: string | null | undefined): { message: string; severity: ValidationSeverity } | null {
  if (!raw) return null;
  if (raw.startsWith(MARK) && raw[2] === MARK) {
    if (raw[1] === "i") return { message: raw.slice(3), severity: "info" };
    if (raw[1] === "w") return { message: raw.slice(3), severity: "warning" };
  }
  return { message: raw, severity: "error" };
}
