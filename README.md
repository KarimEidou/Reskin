# Reskin

A small glassy box that floats on your Windows desktop. Drag a shortcut onto
it and the box opens into an icon editor loaded with that app's icon. Draw,
restyle, or start from a preset — then **Save & Apply** changes the real
desktop icon.

> Work in progress toward v1.0. See `docs/PLAN.md` for the full plan and
> `docs/ARCHITECTURE.md` for how it is built.

## Building

Requirements: Windows 10/11, Node 22 + pnpm 10, Rust (pinned by
`rust-toolchain.toml`), the WebView2 Runtime.

```sh
pnpm install
pnpm tauri build      # installers in target/release/bundle
```

## License

MIT — see [LICENSE](LICENSE).
