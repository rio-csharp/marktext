import type Content from '../block/base/content';
import type Format from '../block/base/format';
import type ParagraphContent from '../block/content/paragraphContent';
import type { Muya } from '../muya';
import type { IRenderCursor } from '../selection/types';
import type { IParagraphState } from '../state/types';
import type { IHighlight, Labels } from './types';
import logger from '../utils/logger';
import { tokenizer } from './lexer';
import Renderer from './renderer';
import { beginRules } from './rules';

const debug = logger('inlineRenderer:');

// Finds every `[label]` reference usage that is not itself a definition
// (`[label]:`). Used to index which blocks depend on each defined label.
const REFERENCE_USAGE_REG = /\[([^\]]+)\](?!:)/g;

class InlineRenderer {
    public labels: Labels = new Map();
    public renderer: Renderer;

    // `labels` and `_labelRefs` are rebuilt lazily (on the next patch or
    // index lookup) once `_labelsDirty` is set, instead of re-collecting on
    // every block patch.
    private _labelsDirty = true;
    private _labelRefs = new Map<string, Set<Content>>();

    constructor(public muya: Muya) {
        this.renderer = new Renderer(muya, this);
    }

    invalidateLabels() {
        this._labelsDirty = true;
    }

    // Called from the paragraph content text setter: a paragraph's text
    // starting or stopping to match the reference-definition syntax is the
    // only text-level change that can alter `labels`.
    notifyDefinitionTransition(oldText: string, newText: string) {
        if (this._labelsDirty)
            return;

        if (
            beginRules.reference_definition.test(oldText)
            || beginRules.reference_definition.test(newText)
        ) {
            this._labelsDirty = true;
        }
    }

    private _tokenizer(block: Format, highlights: IHighlight[]) {
        const { options } = this.muya;
        const { text } = block;
        const { labels } = this;

        // TODO: different content block should have different rules.
        // eg: atxheading.content has no soft|hard line break
        // setextheading.content has no heading rules.
        const hasBeginRules
            = /thematicbreak\.content|paragraph\.content|atxheading\.content/.test(
                block.blockName,
            );

        return tokenizer(text, { hasBeginRules, labels, options, highlights });
    }

    /**
     * Flush every cached image and force inline images to reload.
     *
     * The renderer memoises loaded images in `loadImageMap` (keyed by src,
     * skipped on the next render once `isSuccess` is true) and resolved URLs
     * in `urlMap`. When an image file changes on disk the cached entry would
     * otherwise keep the stale bitmap, so clearing both maps and re-rendering
     * every content block re-runs `loadImageAsync`, which loads the source
     * afresh.
     */
    invalidateImageCache() {
        this.renderer.loadImageMap.clear();
        this.renderer.urlMap.clear();

        const { scrollPage } = this.muya.editor;
        if (!scrollPage)
            return;

        scrollPage.breadthFirstTraverse((node) => {
            if (node.isContent())
                node.update();
        });
    }

    patch(block: Format, cursor?: IRenderCursor, highlights: IHighlight[] = []) {
        if (this._labelsDirty)
            this._rebuildLabels();
        const { domNode } = block;
        if (block.isParent())
            debug.error('Patch can only handle content block');

        const tokens = this._tokenizer(block, highlights);
        const html = this.renderer.output(
            tokens,
            block,
            cursor && cursor.block === block ? cursor : {},
        );
        domNode!.innerHTML = html;
    }

    // Blocks whose text references `label` — the set `updateRefLinkAndImage`
    // must re-render when the definition changes. Rebuilt together with the
    // labels cache, so it only ever maps to currently-resolving labels.
    getBlocksReferencingLabel(label: string): Content[] {
        if (this._labelsDirty)
            this._rebuildLabels();

        return [...(this._labelRefs.get(label) ?? [])];
    }

    private _rebuildLabels() {
        const labels: Labels = new Map();

        // Walk the live state tree directly; `getState()`'s defensive
        // deepClone made this a full-document structuredClone per block patch.
        this.muya.editor.jsonState.traverseStates((state) => {
            if (state.name === 'paragraph') {
                const { label, info } = this.getLabelInfo(state);
                if (label && info)
                    labels.set(label, info);
            }
        });

        this.labels = labels;
        this._rebuildLabelRefs();
        this._labelsDirty = false;
    }

    private _rebuildLabelRefs() {
        const labelRefs = new Map<string, Set<Content>>();
        const { labels } = this;
        const { scrollPage } = this.muya.editor;

        if (labels.size && scrollPage) {
            scrollPage.depthFirstTraverse((node) => {
                if (!node.isContent())
                    return;

                const content = node as Content;
                const { text } = content;
                if (!text || !text.includes('['))
                    return;

                REFERENCE_USAGE_REG.lastIndex = 0;
                let match: RegExpExecArray | null;
                // eslint-disable-next-line no-cond-assign
                while ((match = REFERENCE_USAGE_REG.exec(text)) !== null) {
                    const key = match[1].toLowerCase();
                    if (!labels.has(key))
                        continue;

                    let blocks = labelRefs.get(key);
                    if (!blocks)
                        labelRefs.set(key, (blocks = new Set()));
                    blocks.add(content);
                }
            });
        }

        this._labelRefs = labelRefs;
    }

    getLabelInfo(blockOrState: ParagraphContent | IParagraphState) {
        const { text } = blockOrState;
        const tokens = beginRules.reference_definition.exec(text);
        let label = null;
        let info = null;
        if (tokens) {
            label = (tokens[2] + tokens[3]).toLowerCase();
            info = {
                href: tokens[6],
                title: tokens[10] || '',
            };
        }

        return { label, info };
    }
}

export default InlineRenderer;
