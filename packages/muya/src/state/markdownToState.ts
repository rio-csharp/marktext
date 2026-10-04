import type { TBlockToken } from '../utils/marked/types';
import type {
    IAtxHeadingState,
    IBulletListState,
    IListItemState,
    IOrderListState,
    ISetextHeadingState,
    ITableState,
    ITaskListItemState,
    ITaskListState,
    TState,
} from './types';
import { firstWordOfInfo } from '../utils';
import logger from '../utils/logger';
import { lexBlock } from '../utils/marked';

const debug = logger('import markdown: ');

interface IMarkdownToStateOptions {
    footnote: boolean;
    math: boolean;
    isGitlabCompatibilityEnabled: boolean;
    trimUnnecessaryCodeBlockEmptyLines: boolean;
    frontMatter: boolean;
};

const DEFAULT_OPTIONS = {
    footnote: false,
    math: true,
    isGitlabCompatibilityEnabled: true,
    trimUnnecessaryCodeBlockEmptyLines: false,
    frontMatter: true,
};

// Token types whose handler pushes a container onto the `parentList` stack
// and recurses into its child tokens, as opposed to the leaf tokens that
// only append a state to the current level.
const CONTAINER_TOKEN_TYPES = new Set([
    'blockquote',
    'list',
    'list_item',
    'footnote',
]);

export class MarkdownToState {
    constructor(private _options: IMarkdownToStateOptions = DEFAULT_OPTIONS) {}

    generate(markdown: string): TState[] {
        return this._convertMarkdownToState(markdown);
    }

    private _convertMarkdownToState(markdown: string): TState[] {
        const {
            footnote = false,
            math = true,
            isGitlabCompatibilityEnabled = true,
            trimUnnecessaryCodeBlockEmptyLines = false,
            frontMatter = true,
        } = this._options;

        const tokens: TBlockToken[] = lexBlock(markdown, {
            footnote,
            math,
            frontMatter,
            isGitlabCompatibilityEnabled,
        });

        const states: TState[] = [];
        const parentList: TState[][] = [states];

        this._consumeTokens(tokens, parentList, trimUnnecessaryCodeBlockEmptyLines);

        return states.length ? states : [{ name: 'paragraph', text: '' }];
    }

    // Cursor-based traversal (`i` only ever advances) — the previous
    // shift/unshift stream made every container nesting O(n) array copies.
    private _consumeTokens(
        tokens: TBlockToken[],
        parentList: TState[][],
        trimUnnecessaryCodeBlockEmptyLines: boolean,
    ) {
        for (let i = 0; i < tokens.length; i++) {
            const token = tokens[i];

            if (token.type === 'text') {
                // Adjacent `text` tokens are soft-wrapped lines of one
                // paragraph; merge them through the cursor.
                let value = token.text;
                while (tokens[i + 1]?.type === 'text')
                    value += `\n${(tokens[++i] as Extract<TBlockToken, { type: 'text' }>).text}`;

                parentList[0].push({ name: 'paragraph', text: value });
                continue;
            }

            if (CONTAINER_TOKEN_TYPES.has(token.type))
                this._handleContainerToken(token, parentList, trimUnnecessaryCodeBlockEmptyLines);
            else
                this._handleLeafToken(token, parentList, trimUnnecessaryCodeBlockEmptyLines);
        }
    }

    // Pops the container `children` array the caller pushed for `tokenType`,
    // preserving the old synthetic `block-end` sentinel semantics: an emptied
    // blockquote / list item still yields one empty paragraph (fix #1735, e.g.
    // `>` followed by `bar`).
    private _closeContainer(
        tokenType: 'blockquote' | 'list' | 'list-item' | 'footnote',
        children: TState[],
        parentList: TState[][],
    ) {
        if (
            children.length === 0
            && (tokenType === 'blockquote' || tokenType === 'list-item')
        ) {
            children.push({ name: 'paragraph', text: '' });
        }
        parentList.shift();
    }

    private _handleContainerToken(
        token: TBlockToken,
        parentList: TState[][],
        trimUnnecessaryCodeBlockEmptyLines: boolean,
    ) {
        let state: TState;
        switch (token.type) {
            case 'blockquote': {
                state = {
                    name: 'block-quote' as const,
                    children: [],
                };
                parentList[0].push(state);
                parentList.unshift(state.children);
                this._consumeTokens(token.tokens as TBlockToken[], parentList, trimUnnecessaryCodeBlockEmptyLines);
                this._closeContainer('blockquote', state.children, parentList);
                break;
            }

            case 'list': {
                const { listType, loose, start } = token;
                const bulletMarkerOrDelimiter
                    = token.items[0].bulletMarkerOrDelimiter;

                let listState: IOrderListState | IBulletListState | ITaskListState;
                if (listType === 'order') {
                    listState = {
                        name: 'order-list',
                        meta: {
                            loose,
                            start: /^\d+$/.test(String(start)) ? Number(start) : 1,
                            delimiter: bulletMarkerOrDelimiter || '.',
                        },
                        children: [],
                    };
                }
                else if (listType === 'task') {
                    listState = {
                        name: 'task-list',
                        meta: {
                            loose,
                            marker: bulletMarkerOrDelimiter || '-',
                        },
                        children: [],
                    };
                }
                else {
                    listState = {
                        name: 'bullet-list',
                        meta: {
                            loose,
                            marker: bulletMarkerOrDelimiter || '-',
                        },
                        children: [],
                    };
                }

                state = listState;
                parentList[0].push(state);
                parentList.unshift(state.children);
                this._consumeTokens(token.items as TBlockToken[], parentList, trimUnnecessaryCodeBlockEmptyLines);
                this._closeContainer('list', state.children, parentList);
                break;
            }

            case 'list_item': {
                const { listItemType, checked } = token;
                let itemState: IListItemState | ITaskListItemState;
                if (listItemType === 'task') {
                    itemState = {
                        name: 'task-list-item',
                        meta: { checked: Boolean(checked) },
                        children: [],
                    };
                }
                else {
                    itemState = {
                        name: 'list-item',
                        children: [],
                    };
                }

                state = itemState;
                parentList[0].push(state);
                parentList.unshift(state.children);
                this._consumeTokens(token.tokens as TBlockToken[], parentList, trimUnnecessaryCodeBlockEmptyLines);
                this._closeContainer('list-item', state.children, parentList);
                break;
            }

            case 'footnote': {
                // The footnote extension (utils/marked/extensions/footnote.ts)
                // emits a parent token whose `tokens` array holds nested
                // block tokens. Mirror that into a `footnote` container
                // state and recurse into the child tokens.
                const { identifier } = token;
                state = {
                    name: 'footnote' as const,
                    meta: { identifier },
                    children: [],
                };
                parentList[0].push(state);
                parentList.unshift(state.children);
                this._consumeTokens(token.tokens as TBlockToken[], parentList, trimUnnecessaryCodeBlockEmptyLines);
                this._closeContainer('footnote', state.children, parentList);
                break;
            }
        }
    }

    private _handleLeafToken(
        token: TBlockToken,
        parentList: TState[][],
        trimUnnecessaryCodeBlockEmptyLines: boolean,
    ) {
        let state: TState;
        let value: string;
        switch (token.type) {
            case 'frontmatter': {
                const { lang, style, text } = token;
                value = text.replace(/^\s+/, '').replace(/\s$/, '');

                state = {
                    name: 'frontmatter' as const,
                    meta: {
                        lang,
                        style,
                    },
                    text: value,
                };

                parentList[0].push(state);
                break;
            }

            case 'hr': {
                state = {
                    name: 'thematic-break' as const,
                    text: token.raw.replace(/\n+$/, ''),
                };

                parentList[0].push(state);
                break;
            }

            case 'heading': {
                const { headingStyle, depth, text, marker } = token;
                value = headingStyle === 'atx'
                    ? `${'#'.repeat(+depth)} ${text}`
                    : text;

                if (headingStyle === 'atx') {
                    const atxState: IAtxHeadingState = {
                        name: 'atx-heading',
                        meta: { level: depth },
                        text: value,
                    };
                    state = atxState;
                }
                else {
                    const setextState: ISetextHeadingState = {
                        name: 'setext-heading',
                        meta: { level: depth, underline: marker },
                        text: value,
                    };
                    state = setextState;
                }

                parentList[0].push(state);
                break;
            }

            case 'code': {
                const { codeBlockStyle, text, lang: infoString = '', raw = '' } = token;
                // marked >=17 appends a trailing newline to indented code text
                // (fenced text has none); strip it so indented blocks round-trip.
                const codeText = codeBlockStyle === 'indented' ? text.replace(/\n$/, '') : text;
                const fenceLength = /^ {0,3}([`~]{3,})/.exec(raw)?.[1].length;
                parentList[0].push(
                    this._buildCodeState(codeText, infoString, codeBlockStyle, trimUnnecessaryCodeBlockEmptyLines, fenceLength),
                );
                break;
            }

            case 'table': {
                const { header, align, rows } = token;
                const tableState: ITableState = {
                    name: 'table',
                    children: [],
                };

                // Store the cell text as marked emits it (with the table `\|`
                // escape already resolved to a literal `|`), so the editor shows
                // `` `|` `` rather than the escaped `` `\|` `` inside inline code
                // (#4849). `escapeText` re-adds the `\|` escape on serialization,
                // keeping the markdown round-trip intact.
                tableState.children.push({
                    name: 'table.row',
                    children: header.map((h, i) => ({
                        name: 'table.cell' as const,
                        meta: { align: align[i] || 'none' },
                        text: h.text,
                    })),
                });

                tableState.children.push(
                    ...rows.map(row => ({
                        name: 'table.row' as const,
                        children: row.map((c, i) => ({
                            name: 'table.cell' as const,
                            meta: { align: align[i] || 'none' },
                            text: c.text,
                        })),
                    })),
                );

                state = tableState;
                parentList[0].push(state);
                break;
            }

            case 'html': {
                const text = token.text.trim();
                // TODO: Treat html state which only contains one img as paragraph, we maybe add image state in the future.
                const isSingleImage = /^<img[^<>]+>$/.test(text);
                if (isSingleImage) {
                    state = {
                        name: 'paragraph' as const,
                        text,
                    };
                    parentList[0].push(state);
                }
                else {
                    state = {
                        name: 'html-block' as const,
                        text,
                    };
                    parentList[0].push(state);
                }
                break;
            }

            case 'multiplemath': {
                const text = token.text.trim();
                const { mathStyle = '' } = token;
                const state = {
                    name: 'math-block' as const,
                    text,
                    meta: { mathStyle },
                };
                parentList[0].push(state);
                break;
            }

            case 'paragraph': {
                value = token.text;
                state = {
                    name: 'paragraph' as const,
                    text: value,
                };
                parentList[0].push(state);
                break;
            }

            case 'space': {
                break;
            }

            case 'def': {
                // Marked v16 hoists `[label]: url "title"` reference
                // definitions to block-level `def` tokens. Lower them back
                // to paragraph state nodes so the rest of the pipeline —
                // `InlineRenderer.collectReferenceDefinitions` (regex scan
                // over paragraph text) and round-trip serialization —
                // keeps working without a dedicated state node.
                // Aligns with marktext's "definition is paragraph text"
                // model. See plan section 13 (PR-16).
                state = {
                    name: 'paragraph' as const,
                    text: token.raw.replace(/\n+$/, ''),
                };
                parentList[0].push(state);
                break;
            }

            default:
                debug.warn(`Unknown type ${token.type}`);
                break;
        }
    }

    private _buildCodeState(
        text: string,
        infoString: string,
        codeBlockStyle: 'indented' | undefined,
        trimUnnecessaryCodeBlockEmptyLines: boolean,
        fenceLength?: number,
    ): TState {
        // Keep the whole info string; the language for highlighting / diagram
        // detection is its first word (CommonMark §4.5).
        const info = (infoString || '').trim();
        const lang = firstWordOfInfo(info);

        let value = text;
        // Fix: #1265.
        if (
            trimUnnecessaryCodeBlockEmptyLines
            && (value.endsWith('\n') || value.startsWith('\n'))
        ) {
            value = value.replace(/\n+$/, '').replace(/^\n+/, '');
        }

        const diagramMatch = /^(mermaid|vega-lite|plantuml|flowchart|sequence)$/.exec(lang);
        if (diagramMatch) {
            const diagramType = diagramMatch[1] as 'mermaid' | 'vega-lite' | 'plantuml' | 'flowchart' | 'sequence';
            return {
                name: 'diagram' as const,
                text: value,
                meta: {
                    type: diagramType,
                    lang: diagramType === 'vega-lite' ? 'json' : 'yaml',
                },
            };
        }

        // walkTokens (utils/marked/walkTokens.ts) writes
        // codeBlockStyle = 'fenced' for fenced blocks and
        // leaves 'indented' for indented blocks. marked's
        // type widens the field to `'indented' | undefined`,
        // but `'fenced'` reaches us at runtime via the
        // walkTokens assignment — hence the cast.
        const isFenced = (codeBlockStyle as 'indented' | 'fenced' | undefined) === 'fenced';
        return {
            name: 'code-block' as const,
            meta: {
                type: isFenced ? 'fenced' : 'indented',
                // The full info string verbatim (empty for indented blocks); the
                // language is its first word — see `firstWordOfInfo`.
                lang: info,
                ...(isFenced && fenceLength && fenceLength > 3 ? { fenceLength } : {}),
            },
            text: value,
        };
    }
}
