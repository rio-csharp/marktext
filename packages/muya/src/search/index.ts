import type Content from '../block/base/content';
import type TreeNode from '../block/base/treeNode';
import type { IHighlight } from '../inlineRenderer/types';
import type { Muya } from '../muya';
import type { IMatch, IReplaceOption, ISearchOption } from './types';
import { DEFAULT_SEARCH_OPTIONS } from '../config';
import { buildRegexValue, matchString } from '../utils/search';

export class Search {
    private _value: string = '';
    public matches: IMatch[] = [];
    public index: number = -1;
    private _highlightedBlocks = new Map<Content, IHighlight[]>();

    get value() {
        return this._value;
    }

    private get _scrollPage() {
        return this._muya.editor.scrollPage;
    }

    constructor(private _muya: Muya) {}

    // Drop match state when the document is replaced (e.g. a tab switch), so
    // stale matches don't reference the previous document's blocks (#1932).
    reset() {
        this._value = '';
        this.matches = [];
        this.index = -1;
        this._highlightedBlocks.clear();
    }

    private _sameHighlights(a: IHighlight[], b: IHighlight[]) {
        return a.length === b.length
            && a.every((highlight, index) => {
                const other = b[index];
                return highlight.start === other.start
                    && highlight.end === other.end
                    && highlight.active === other.active;
            });
    }

    private _renderMatches() {
        const { matches, index } = this;
        const next = new Map<Content, IHighlight[]>();
        for (let i = 0; i < matches.length; i++) {
            const { block, start, end } = matches[i];
            const highlight = { start, end, active: i === index };
            const highlights = next.get(block);
            if (highlights)
                highlights.push(highlight);
            else
                next.set(block, [highlight]);
        }

        for (const [block, highlights] of this._highlightedBlocks) {
            if (next.has(block) || !block.outMostBlock)
                continue;
            block.update(undefined, []);
            if (block.parent?.active && !highlights.some((highlight) => highlight.active))
                block.blurHandler();
        }

        for (const [block, highlights] of next) {
            if (!block.outMostBlock)
                continue;
            const previous = this._highlightedBlocks.get(block);
            if (previous && this._sameHighlights(previous, highlights))
                continue;
            const isActive = highlights.some((highlight) => highlight.active);
            block.update(undefined, highlights);
            if (block.parent?.active && !isActive)
                block.blurHandler();
            if (isActive)
                block.focusHandler();
        }
        this._highlightedBlocks = next;
    }

    private _innerReplace(matches: IMatch[], replacementOf: (match: IMatch) => string) {
        if (!matches.length)
            return;

        let tempText = '';
        let lastBlock = matches[0].block;
        let lastEnd = 0;

        for (const match of matches) {
            const { start, end, block } = match;
            if (lastBlock !== block) {
                if (lastBlock)
                    lastBlock.text = tempText + lastBlock.text.substring(lastEnd);

                tempText = '';
                lastEnd = 0;
                lastBlock = block;
            }

            tempText += block.text.substring(lastEnd, start);
            tempText += replacementOf(match);
            lastEnd = end;
        }

        lastBlock.text = tempText + lastBlock.text.substring(lastEnd);
    }

    replace(replaceValue: string, opt: IReplaceOption = { isSingle: true, isRegexp: false }) {
        const { isSingle, isRegexp, ...rest } = opt;
        const options = Object.assign({}, DEFAULT_SEARCH_OPTIONS, rest);
        const { matches, index } = this;
        const value = this._value;

        if (matches.length) {
            this._innerReplace(
                isSingle ? [matches[index]] : matches,
                match => (isRegexp ? buildRegexValue(match, replaceValue) : replaceValue),
            );
            const highlightIndex = index < matches.length - 1 ? index : index - 1;

            this.search(value, {
                ...options,
                highlightIndex: isSingle ? highlightIndex : -1,
            });
        }

        return this;
    }

    /**
     * Find preview or next value, and highlight it.
     * @param {string} action : previous or next.
     */
    find(action: 'previous' | 'next'): this {
        const { matches } = this;
        let { index } = this;
        const len = matches.length;

        if (!len)
            return this;

        index = action === 'next' ? index + 1 : index - 1;

        if (index < 0)
            index = len - 1;

        if (index >= len)
            index = 0;

        this.index = index;

        this._renderMatches();

        return this;
    }

    /**
     * Search value in current document.
     * @param {string} value
     * @param {object} opts
     */
    search(value: string, opts: ISearchOption = {}) {
        const matches: IMatch[] = [];
        const options = Object.assign({}, DEFAULT_SEARCH_OPTIONS, opts);
        const { highlightIndex, selectHighlight } = options;
        let index = -1;

        // The currently active match, captured before it is cleared below, so a
        // `selectHighlight` request can drop the cursor back onto it when the
        // new search has no match of its own (e.g. closing the search bar).
        const prevActiveMatch = this.matches[this.index];

        // Highlight current search.
        if (value) {
            this._scrollPage?.depthFirstTraverse((block: TreeNode) => {
                if (block.isContent()) {
                    const { text } = block;
                    if (text && typeof text === 'string') {
                        const strMatches = matchString(text, value, options);
                        matches.push(
                            ...strMatches.map(({ index, match, subMatches }) => {
                                return {
                                    block,
                                    start: index,
                                    end: index + match.length,
                                    match,
                                    subMatches,
                                };
                            }),
                        );
                    }
                }
            });
        }

        if (highlightIndex !== -1) {
            // If set the highlight index, then highlight the highlighIndex
            index = highlightIndex;
        }
        else if (matches.length) {
            // highlight the first word that matches.
            index = 0;
        }

        Object.assign(this, { _value: value, matches, index });

        this._renderMatches();

        // Restore the editor cursor onto the active match. Mirrors muyajs's
        // `render(selectHighlight)` -> `setCursor()` path: closing the search
        // bar empties the search with `selectHighlight`, which must place the
        // cursor where the highlight was so the user can keep typing there.
        if (selectHighlight) {
            const activeMatch = matches[index] ?? prevActiveMatch;
            if (activeMatch?.block.outMostBlock) {
                const { block, start, end } = activeMatch;
                block.setCursor(start, end, true);
            }
        }

        return this;
    }
}
