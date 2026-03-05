---
name: release
description: Automate the full wct release process — version bump, tag, GitHub release, and homebrew formula update. Use when the user says /release <version> or asks to create a new release.
user_invocable: true
argument: version number (e.g., 1.3.1)
---

# Release wct $ARGUMENTS

Follow these steps in order. Stop and report if any step fails.

## 1. Version bump

- Edit `package.json` and set `"version"` to `$ARGUMENTS`
- Commit: `chore: bump version to $ARGUMENTS`
- Create tag: `v$ARGUMENTS`

## 2. Push

- Push the commit and tag to the remote:
  ```
  git push && git push origin v$ARGUMENTS
  ```

## 3. Wait for CI

- Find the release workflow run: `gh run list --limit 5`
- Watch it until completion: `gh run watch <run-id>`
- If the workflow fails, stop and report the error.

## 4. Get checksums

- Download the checksums file from the release:
  ```
  gh release download v$ARGUMENTS --pattern checksums.txt --output -
  ```
- Parse the output — each line is `<sha256>  <filename>`.

## 5. Update homebrew formula

Clone or locate the `dmtr-p/homebrew-tools` repo. Find `Formula/wct.rb` and read it, then:

1. Update the `version` string to `$ARGUMENTS`
2. Replace all old version tags in URLs (e.g., `v1.3.0` → `v$ARGUMENTS`)
3. Update every `sha256` hash using the checksums from step 4. Match filenames:
   - `wct-darwin-arm64` → `on_macos` / `on_arm`
   - `wct-darwin-x64` → `on_macos` / `on_intel`
   - `wct-linux-arm64` → `on_linux` / `on_arm`
   - `wct-linux-x64` → `on_linux` / `on_intel`
   - `wct.bash` → `bash-completion` resource
   - `_wct` → `zsh-completion` resource
   - `wct.fish` → `fish-completion` resource

## 6. Push homebrew formula

- Commit the formula: `wct $ARGUMENTS`
- Push to remote
