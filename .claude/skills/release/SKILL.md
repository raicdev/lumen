---
name: release
description: Release a new version of Lumen. Bumps the version, builds the Windows setup and the portable zip, smoke-tests the packaged app, commits, tags and pushes, then publishes the GitHub release that auto update reads. Use when the user asks to release, ship or publish a version (for example "0.3.0をリリースして", "release 0.2.1").
---

# Release Lumen

Lumen updates itself from the GitHub releases of `raicdev/lumen`
(`packages/lumen-shell/src/main/updater.ts`). Users pick a channel with the
`update.channel` setting:

- **stable** (the default) reads the **latest** release. It only takes a tag
  that is plain semver with a `v` prefix (`v0.3.0`) and is not a pre-release.
- **beta** reads the 30 most recent releases and takes the newest by semver,
  pre-releases included (`v0.3.0-beta.1` < `v0.3.0-beta.2` < `v0.3.0`).

So a stable version is released with `--latest`. A beta version
(`<x.y.z>-beta.<n>`) is released with `--prerelease --latest=false`, which
keeps the stable release as latest and reaches only the beta channel. Drafts
reach nobody. Either way the release needs an asset named
`Lumen-<version>-win32-x64-setup.exe`. GitHub's SHA-256 `digest` for that
asset is required; GitHub adds it automatically when the asset is uploaded.

Releasing is outward-facing: it pushes to `main` and publishes a release.
Only run this when the user asked for a release. Reply to the user in Japanese.
Write the commit message and the release notes in English.

## 1. Preconditions

```bash
git fetch -q && git status -sb | head -1     # on main, not behind origin/main
gh auth status                                # can publish to raicdev/lumen
ls "C:/Program Files (x86)/NSIS/makensis.exe" # NSIS (winget install NSIS.NSIS)
git tag -l v<version>                         # must print nothing
```

- If the user gave no version, ask for one. Suggest the next minor version for
  features and the next patch version for fixes only.
- **Uncommitted changes go into the release.** The build packages the working
  tree. Run `git status --short` and list what is uncommitted (including
  untracked source files). Mention it in the final report. If anything looks
  unrelated or unfinished, ask before including it.

## 2. Bump the version (four places)

| File                   | What                                                                         |
| ---------------------- | ---------------------------------------------------------------------------- |
| `package.json`         | `"version"`                                                                  |
| `lumen.config.ts`      | `app.version`: names the setup and its version info                          |
| `src/main/main.ts`     | `const APP_VERSION`: what the updater compares against                       |
| `src/mainview/App.tsx` | the About dialog's fallback `version:` in `workbench.action.showAboutDialog` |

Afterwards, grep for the old version to make sure nothing was missed. The
`"version": "0.2.0"` in App.tsx's launch.json template is the launch.json
format version: never change it.

Use the Edit tool for these edits. Python on Windows rewrites LF files with
CRLF, so avoid it here.

## 3. Verify

```bash
pnpm exec tsc --noEmit -p .
pnpm test
```

Both must pass. Do not release on failures. Report them to the user.

## 4. Build

```bash
pnpm installer   # → dist/Lumen/ and dist/Lumen-<version>-win32-x64-setup.exe (several minutes)
```

Smoke-test the packaged app. It must still be running after 10 seconds. Then
end it with its process tree (PowerShell):

```powershell
$p = Start-Process -FilePath "D:\Software\zed-alternative\dist\Lumen\Lumen.exe" -PassThru; Start-Sleep -Seconds 10
"alive=$(-not $p.HasExited) exit=$($p.ExitCode)"; if (-not $p.HasExited) { taskkill /PID $p.Id /T /F | Out-Null }
```

Build the portable zip and hash both assets (PowerShell, absolute paths). The
zip name has a `v` and the setup name does not; keep it that way.

```powershell
Set-Location D:\Software\zed-alternative\dist
Compress-Archive -Path .\Lumen -DestinationPath .\Lumen-v<version>-win32-x64.zip -CompressionLevel Optimal -Force
Get-FileHash .\Lumen-<version>-win32-x64-setup.exe, .\Lumen-v<version>-win32-x64.zip
```

The zip's entries must start with `Lumen/` (users run `Lumen\Lumen.exe`).

## 5. Release notes

Collect what changed since the previous tag:

- `git log --oneline v<previous>..HEAD`
- `git diff --stat v<previous>`, plus uncommitted files
- The names of added tests: `git diff v<previous> -- test | grep -E '^\+\s*test\('`.
  They describe behaviour well.
- Added doc comments in the changed UI and main-process files.

Write the notes in the scratchpad (not in the repo), in English, for users
rather than developers. Match the earlier releases (`gh release view v0.2.0 -R raicdev/lumen`):

```markdown
## What's new

- **Feature**: what it does for the user, and where to find it (menu, command, setting).

## Fixes

- What was wrong, as the user saw it.

## Download

- **Windows x64 installer (recommended)**: `Lumen-<version>-win32-x64-setup.exe`. It installs to `%LOCALAPPDATA%\Programs\Lumen` with a Start menu shortcut and an uninstaller, and it is what auto update installs.
- **Windows x64 portable**: `Lumen-v<version>-win32-x64.zip`. Extract it and run `Lumen\Lumen.exe`.

Both need the WebView2 runtime (preinstalled on Windows 10/11). The executables are not code-signed, so SmartScreen may warn on first launch.

SHA-256:

- `Lumen-<version>-win32-x64-setup.exe`: `<HASH>`
- `Lumen-v<version>-win32-x64.zip`: `<HASH>`
```

## 6. Commit, tag, push

```bash
git add -A
git commit -F - <<'EOF'
Release <version>: <three or four headline changes>

- <one bullet per notable change, wrapped at ~72 columns>

Co-Authored-By: <the attribution line from the session's system reminder>
EOF
git tag -s v<version> -m "Lumen v<version>"
git cat-file commit HEAD | grep -c "BEGIN SSH SIGNATURE"         # must print 1
git cat-file tag v<version> | grep -c "BEGIN SSH SIGNATURE"      # must print 1
git push origin main && git push origin v<version>
```

## 7. Publish

```bash
gh release create v<version> -R raicdev/lumen --title "Lumen v<version>" --latest \
  --notes-file "<scratchpad>/release-notes-<version>.md" \
  dist/Lumen-<version>-win32-x64-setup.exe dist/Lumen-v<version>-win32-x64.zip
```

For a beta version, replace `--latest` with `--prerelease --latest=false`,
and start the notes with a line saying it is a beta that reaches users on the
beta channel (`update.channel`: `beta`).

## 8. Check that auto update picks it up

On the channel the release is for, the previous version must see the new
release as an update with a digest, and the new version must see no update. A
beta must not show up on the stable channel.

```bash
node -e "
import('file:///D:/Software/zed-alternative/packages/lumen-shell/src/main/updater.ts').then(async ({ autoUpdater }) => {
  for (const channel of ['stable', 'beta']) for (const v of ['<previous>', '<version>']) {
    autoUpdater.configure({ repository: 'raicdev/lumen', name: 'Lumen', version: v, identifier: 'lumen-release-check' });
    autoUpdater.channel = channel;
    const r = await autoUpdater.check();
    console.log(channel, v, '->', r ? r.version + ' ' + r.installer?.name + ' ' + r.installer?.sha256 : null);
  }
});"
```

The digest must equal the `Get-FileHash` result (lower-case).

## 9. Report (in Japanese)

- The release URL, the commit and the tag.
- Which uncommitted changes went into the release.
- The test results, the smoke test result and the updater check result.
- Anything skipped or failed, stated plainly.

## Pitfalls

- Git Bash rewrites arguments that start with `/` (`/V2`, `/S`, `/D=`) into
  paths. Run NSIS or setup commands from PowerShell or Node, or set
  `MSYS_NO_PATHCONV=1`.
- `dist/` and `.lumen/` are gitignored build output. `pnpm installer`
  overwrites `dist/Lumen/`.
- Never rewrite an existing tag or release asset. Installed copies have
  already checked its digest. If a release is broken, publish a new patch
  version.
