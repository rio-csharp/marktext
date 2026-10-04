# Fork rebuild plan

This document records the behavior that existed in the fork before the clean upstream rebuild. It is a product and engineering checklist, not a patch to carry forward unchanged.

## Baseline

- Rebuild branch: `codex/upstream-rebuild`
- Baseline: `upstream/develop` at `0d8dba02`
- Historical fork snapshot: `backup/codex-perf-overhaul-wip` at `b955db6e`
- Historical fork-only commits: `upstream/develop..3d799101`

The old implementation is intentionally kept in the backup branch. New work should be implemented against this clean baseline and validated with focused tests before moving to the next item.

## Fork-specific product features

| Priority | Feature | Historical source | Rebuild decision |
| --- | --- | --- | --- |
| P1 | Read-only mode for WYSIWYG and source-code editors. Block edits, paste, cut, drop, undo, redo, and other document mutations while retaining browsing and outline navigation. Includes View-menu toggle, shortcut, preference/schema, menu state, localization, and tests. | `1a8c12cd` — `packages/desktop/src/renderer/src/components/editorWithTabs/editor.vue`, `sourceCode.vue`, `packages/desktop/src/main/menu/templates/view.ts`, editor store | Reimplement. Start with an explicit editor capability guard and cover both editor modes with tests. |
| P1 | Independent outline panel. Move/reuse the TOC in a separately toggleable right-side panel; persist visibility and width; avoid mounting the TOC while hidden. | `ceafb5eb` — `packages/desktop/src/renderer/src/components/outlinePanel/index.vue`, `store/layout.ts`, `pages/app.vue` | Reimplement. Recheck the current upstream layout and TOC APIs first; keep the panel implementation independent of the old sidebar assumptions. |
| P1 | Previous/next Markdown file navigation within the current project. Reuse an open tab where possible and close the previous saved tab after navigation. | `1a8c12cd` — `fileNavigation.vue`, editor store/menu changes | Reimplement, but review the saved-tab closing policy before copying it. Preserve unsaved tabs and make navigation behavior explicit. |
| P1 | Copy path from the sidebar context menu for a file, folder, or project root. | `b6dabcda` — sidebar context-menu actions/menu items and `store/project.ts` | Reimplement. Upstream already has copy-path support for tabs, but not this sidebar behavior. Share a path-copy helper if appropriate. |
| P1 | Large-project sidebar startup optimization: directory watcher add events send metadata only; Markdown content loads on demand when opened. Ignore generated/VCS directories (`node_modules`, `.git`, `.svn`, `.hg`, `target`, `dist`, `__pycache__`) and `.asar` path segments. | `998df1d7` — `main/filesystem/watcher.ts`, `renderer/store/project.ts` | Reimplement and benchmark. Keep the metadata-only protocol compatible with current upstream watcher changes; retain tests for startup and newly created files. |
| P1 | External file changes reload the editor automatically instead of showing a confirmation banner. The fork version reloads even when the tab has local edits; upstream now silently reloads only clean tabs and preserves confirmation for dirty tabs. | `cfbcfd04`; upstream follow-up `445912a4` | Re-evaluate, do not copy blindly. Prefer upstream's dirty-tab safety behavior unless a deliberate product decision says otherwise. Add tests for clean, dirty, identical-content, and pending-auto-save cases. |
| P2 | Remove active-heading tracking on every editor scroll to reduce large-document scroll work. | `9029aedc` — editor/source-code components and editor store | Reimplement only if the current upstream still performs the same costly tracking. Preserve TOC navigation and active-heading semantics that users still need. |
| P2 | Bundle platform-specific ripgrep binaries, unpack executable files outside `app.asar`, bundle `write-file-atomic`, and pin node-gyp to the locally required Visual Studio toolset. | `3d799101` — `.npmrc`, desktop package/build/vite config, lockfile | Re-evaluate against the clean upstream dependency and packaging configuration. Platform/toolset pinning should be environment-specific, not a product feature. Keep the ripgrep packaging fix if a clean build demonstrates the same runtime failure. |
| P3 | Fork documentation describing the features above. | `0399456e` — historical `README.md` | Recreate as maintained documentation after the features stabilize; do not copy the old README wholesale. |

## Historical local performance work to reassess

These changes were uncommitted when the rebuild was requested and were saved in `b955db6e`. They are grouped by likely value rather than copied as a large diff.

### Desktop and Electron main process

- **Content snapshot deferral:** WYSIWYG `json-change` events mark a tab dirty in O(1) and defer full Markdown, word-count, cursor, history, and TOC snapshots until typing pauses or a lifecycle boundary forces a flush. Source mode similarly commits on text changes rather than every cursor movement. Relevant old paths: `editorWithTabs/editor.vue`, `sourceCode.vue`, `store/editor.ts`, `syntheticHistory.ts`.
- **Source-mode virtualization:** replace `viewportMargin: Infinity` and outer scrolling with CodeMirror's virtualized internal scroller. Recheck TOC scrolling and long-document behavior against current CodeMirror integration.
- **Main-process asynchronous I/O:** async buffer-store reads/deletes, durable atomic writes, per-buffer write ordering, async file-stat IPC, async editor-state restore, and asynchronous logging. Relevant paths: `editorBufferStore/index.ts`, `main/ipc/fs.ts`, `main/windows/editor.ts`, `main/index.ts`, `main/app/index.ts`, `main/app/windowManager.ts`.
- **Directory watcher batching:** buffer the initial directory replay, send tree events in chunks, and discard the queue when the window closes. This complements metadata-only directory events but must be reconciled with current watcher lifecycle behavior.
- **Ripgrep IPC batching:** batch matches and progress notifications, then accept both single-match and array payloads in the renderer. Debounce sidebar search process restarts while typing.
- **Recent-document menu caching:** load recent documents once, maintain them in memory, debounce writes and menu rebuilds, and flush on quit.
- **Image-path completion cache:** asynchronous directory reads using dirents, bounded LRU cache, watcher eviction, and an explicit close-all operation.
- **Renderer lifecycle cleanup:** retain named document-level event listeners and remove them on unmount; avoid leaked listeners from repeated sidebar mounts.
- **Avoid redundant work:** skip duplicate selection/menu IPC state, avoid deep-cloning current-file payloads when only an ID/path is needed, mark live Muya selection data as raw, and keep empty-document newline dirty-state semantics correct.

### Muya engine

- **Incremental/deferred rendering:** defer expensive Prism highlighting for long code blocks, avoid replacing identical code-block DOM, and preserve the caret after deferred rendering.
- **Search rendering diff:** update only blocks whose highlights changed, especially when stepping between matches.
- **Reference-link indexing:** cache reference definitions and index blocks that use each label, so a definition change does not traverse and re-render the entire document.
- **Parser traversal:** replace token-array `shift`/`unshift` container handling with cursor/recursive traversal to avoid repeated array copies on deeply nested or large documents.
- **Lexer reuse:** reuse token streams during input/render decisions instead of lexing the same text repeatedly.
- **Lazy JSON-state snapshots:** avoid eagerly cloning the post-edit document when no listener reads it; invalidate reference caches for structural and text changes.
- **Other hot-path cleanup:** replace expensive BigInt content hashing with a suitable numeric hash only after collision behavior is tested; avoid debug `JSON.stringify` work when logging is disabled.

Every Muya optimization must retain the relevant CommonMark/GFM, IME, selection, search, reference-link, and rendering tests. Performance changes that alter editor semantics should be split from pure optimizations.

### Packaging and developer workflow

- Add a Windows portable deployment helper that builds the zip, stops MarkText, optionally backs up the install directory, extracts the package, and relaunches it. Historical file: `scripts/deploy-portable.ps1`; package command: `deploy:win`.
- Treat this as a local developer convenience until paths, process shutdown, data-loss warnings, and platform assumptions are reviewed.

## Features already available upstream

The clean baseline already includes, or has superseded, much of the fork's historical work:

- Tab context-menu copy path exists upstream; only the sidebar copy-path action remains fork-specific.
- Clean-tab external auto-reload exists upstream, with safer dirty-tab confirmation behavior than the historical fork implementation.
- The Muya TypeScript migration, extensive editor correctness fixes, source-mode improvements, diagram viewer, Pandoc export, localization, and many conformance tests are already in the baseline.
- Upstream has its own current sidebar Delete-to-trash implementation; do not reintroduce the historical fork's sidebar assumptions while adding copy path or navigation.

## Suggested implementation order

1. Establish a green baseline with upstream unit/type/build checks.
2. Reimplement read-only mode and its test matrix.
3. Reimplement the independent outline panel and file navigation.
4. Reimplement sidebar copy path.
5. Reimplement metadata-only watcher startup and generated-directory pruning, with a large-tree benchmark.
6. Verify whether upstream still needs the scroll, source-mode, Muya, IPC, and menu optimizations; port them one at a time with focused regression tests.
7. Reassess packaging fixes and add the portable deployment helper only after the application build is green.
8. Update fork documentation after behavior and tests are stable.
