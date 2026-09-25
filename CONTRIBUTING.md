# Contributing to Reskin

Thanks for helping! Bug reports and ideas are welcome as
[issues](https://github.com/KarimEidou/Reskin/issues/new/choose); for code,
open a pull request against the default branch.

## Building from source

Requirements: Windows 10/11 x64, [Node.js](https://nodejs.org) 22 with
pnpm 10 (`corepack enable`), Rust via [rustup](https://rustup.rs) (the
toolchain is pinned in `rust-toolchain.toml`), the Visual Studio C++ build
tools and the WebView2 Runtime.

```powershell
pnpm install
pnpm tauri dev        # run with hot reload
pnpm tauri build      # installers in target\release\bundle
```

Checks (the same as CI):

```powershell
pnpm check; pnpm test; pnpm build; pnpm bundle:budget; pnpm e2e
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace -- --include-ignored   # real shell tests too; run elevated, as CI does
pnpm bindings; git diff --exit-code            # the IPC types are up to date
```

`pnpm docs:screenshots` renders the pictures of the README, the user guide
and the website (`docs/screenshots/`) from the app's pages. Helper modes:
`reskin.exe --self-test` prints a JSON health report (run it without
administrator rights: as administrator it skips the checks that write your
app data and reports a failed `elevation` check),
`--smoke-test [--capture-handoff]` exercises the packaged app end to end,
`--restore-all [--quiet]` puts every icon back. A release build is a
windowed program that a terminal doesn't wait for: run
`.\reskin.exe --self-test | Out-String` in PowerShell or
`start /wait reskin.exe --self-test` in Command Prompt to see the report.

## How it's built

A [Tauri 2](https://tauri.app) app: Rust for the Windows side and a Svelte 5
+ TypeScript front end in two transparent WebView2 windows, the box and the
editor, which hand over to each other seamlessly. The image engine is plain
TypeScript and runs in a worker where it pays off. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the contracts and
[`docs/UI.md`](docs/UI.md) for the interaction design.

## Releasing

1. Raise the version in `package.json`, `src-tauri/tauri.conf.json` and
   `Cargo.toml` (then `cargo update --workspace` for `Cargo.lock`), and
   describe it in a new `## [x.y.z]` section of `CHANGELOG.md`.
2. Push, and wait for CI to pass on that commit.
3. **Actions → Release → Run workflow** on the default branch (or push a
   `vX.Y.Z` tag). It checks the versions and the changelog, waits for CI,
   builds, smoke-tests and publishes the release with its tag.

Every release attaches `Reskin-Setup.exe`, `Reskin-Portable.exe`,
`Reskin.msi`, `THIRD_PARTY_NOTICES.txt` and `SHA256SUMS.txt` under the same
names, so links to
`https://github.com/KarimEidou/Reskin/releases/latest/download/Reskin-Setup.exe`
always get the newest installer. The release text comes from
`scripts/release-notes.mjs`: the downloads, then the version's changelog
section.
