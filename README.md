# MarkText Fork

This repository is based on [upstream MarkText](https://github.com/marktext/marktext). This README lists only the features added or improved by this fork compared with upstream.

## Fork-specific Features

- **Independent outline panel**: Moves the table of contents (TOC) from the sidebar to a separate panel on the right side of the editor. The panel can be toggled from the View menu, and its visibility and width are remembered. The TOC tree is unmounted while the panel is hidden to reduce rendering overhead for large documents.
- **Read-only mode**: Adds a read-only editing mode for both WYSIWYG and source-code modes. While enabled, editing, pasting, cutting, dropping, undoing, redoing, and other document mutations are blocked, while document browsing and outline navigation remain available.
- **File navigation**: Adds Previous File and Next File buttons for cycling through Markdown files in the current project, reusing tabs that are already open.
- **Copy path**: Adds a Copy Path action to the sidebar context menu for files, folders, and the project root, copying the selected item's path to the clipboard.
- **Scrolling performance**: Removes the costly active-heading tracking performed during editor scrolling, reducing extra computation when scrolling through large documents.

## Upstream Project

For MarkText's existing features, usage instructions, and development documentation, see the upstream project:

<https://github.com/marktext/marktext>

## License

[MIT](LICENSE)
