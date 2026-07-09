# GitKB Viewer for Obsidian

View-only Obsidian desktop plugin for browsing GitKB documents.

GitKB remains the source of truth. This plugin does not project markdown into
your vault and does not edit, checkout, commit, delete, move, or mutate KB
documents.

## Features

- GitKB Explorer side pane powered by `git-kb list --json`
- Search UI powered by `git-kb search <query> --json`
- Readonly document view powered by `git-kb show <slug> --json`
- All-KB graph view powered by `git-kb graph <slug...> --json`
- `[[slug]]` wikilinks open readonly GitKB document views
- Copy slug, wikilink, and raw markdown
- Manual refresh plus optional auto-refresh
- Clear diagnostics for missing `git-kb`, invalid KB roots, and missing slugs

## Safety Model

The plugin uses an explicit command allowlist. It only runs:

- `git-kb list --json`
- `git-kb show <slug> --json`
- `git-kb search <query> --json`
- `git-kb board --json`
- `git-kb graph <slug...> --json`
- `git-kb --version`

It never calls `checkout`, `commit`, `create`, `set`, `rm`, `mv`, `reset`,
`clear`, `stash`, `pull`, `push`, `repair`, `reindex`, `project`, or
`projections`.

## Install From npm

```bash
npm pack obsidian-gitkb-viewer
mkdir -p /path/to/vault/.obsidian/plugins/gitkb-viewer
tar -xzf obsidian-gitkb-viewer-*.tgz --strip-components=1 -C /path/to/vault/.obsidian/plugins/gitkb-viewer package/main.js package/manifest.json package/styles.css
```

Then enable **GitKB Viewer** in Obsidian community plugins.

## Manual Development Install

```bash
npm install
npm run build
mkdir -p /path/to/vault/.obsidian/plugins/gitkb-viewer
cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/gitkb-viewer/
```

## Settings

- `git-kb` binary path: defaults to `git-kb`
- GitKB root path: absolute path to the project containing `.kb`
- Refresh interval: optional, in seconds. `0` disables automatic refresh.

Every GitKB command is run with `GITKB_ROOT=<configured root>`.
