/**
 * What an extension asks of a shell terminal (TerminalOptions) beyond a
 * profile id. It travels in the `profile` string of the `terminalCreate`
 * request (the request type is fixed), encoded by `encodeSpawnSpec` and
 * decoded by the main process.
 */

export type TerminalSpawnSpec = {
  shellPath?: string;
  shellArgs?: string[] | string;
  /** `null` removes a variable. */
  env?: Record<string, string | null>;
  strictEnv?: boolean;
  /** A built-in profile to start from (`terminalProfiles()` ids). */
  profileId?: string;
  /** Inject the shell integration script (default true). */
  shellIntegration?: boolean;
  /** TerminalOptions.shellIntegrationNonce: the secret shell integration sequences must carry. */
  nonce?: string;
};

export const SPAWN_SPEC_PREFIX = "lumen-spawn:";

export function encodeSpawnSpec(spec: TerminalSpawnSpec): string {
  return SPAWN_SPEC_PREFIX + encodeURIComponent(JSON.stringify(spec));
}

export function decodeSpawnSpec(profile: string | undefined): TerminalSpawnSpec | null {
  if (!profile || !profile.startsWith(SPAWN_SPEC_PREFIX)) return null;
  try {
    const value = JSON.parse(decodeURIComponent(profile.slice(SPAWN_SPEC_PREFIX.length)));
    return value && typeof value === "object" ? (value as TerminalSpawnSpec) : null;
  } catch {
    return null;
  }
}
