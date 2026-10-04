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
import { normalizeReferenceLabel } from './referenceLabel';

const debug = logger('inlineRenderer:');
const REFERENCE_USAGE = /!?\[([^\]]+)\](?:\[([^\]]*)\])?/g;

class InlineRenderer {
    public labels: Labels = new Map();
    public renderer: Renderer;

    private _labelsDirty = true;
    private _labelRefs = new Map<string, Set<Content>>();

    constructor(public muya: Muya) {
        this.renderer = new Renderer(muya, this);
    }

    invalidateLabels() {
        this._labelsDirty = true;
    }

    notifyDefinitionTransition(oldText: string, newText: string) {
        if (
            beginRules.reference_definition.test(oldText)
            || beginRules.reference_definition.test(newText)
        ) {
            this.invalidateLabels();
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

    getBlocksReferencingLabel(label: string): Content[] {
        if (this._labelsDirty)
            this._rebuildLabels();
        return [...(this._labelRefs.get(normalizeReferenceLabel(label)) ?? [])];
    }

    private _rebuildLabels() {
        const labels: Labels = new Map();
        const { scrollPage } = this.muya.editor;

        if (scrollPage) {
            scrollPage.depthFirstTraverse((node) => {
                if (!node.isContent())
                    return;
                const content = node as Content;
                const { label, info } = content.blockName === 'paragraph.content'
                    ? this.getLabelInfo(content as ParagraphContent)
                    : { label: null, info: null };
                if (label && info && !labels.has(label))
                    labels.set(label, info);
            });
        }
        else {
            this.muya.editor.jsonState.traverseStates((state) => {
                if (state.name !== 'paragraph')
                    return;
                const { label, info } = this.getLabelInfo(state);
                if (label && info && !labels.has(label))
                    labels.set(label, info);
            });
        }

        this.labels = labels;
        this._labelRefs = this._collectLabelRefs();
        this._labelsDirty = false;
    }

    private _collectLabelRefs() {
        const refs = new Map<string, Set<Content>>();
        const { scrollPage } = this.muya.editor;
        if (!scrollPage)
            return refs;

        scrollPage.depthFirstTraverse((node) => {
            if (!node.isContent())
                return;
            const block = node as Content;
            REFERENCE_USAGE.lastIndex = 0;
            let match: RegExpExecArray | null;
            while ((match = REFERENCE_USAGE.exec(block.text)) !== null) {
                const after = block.text[REFERENCE_USAGE.lastIndex];
                if (after === ':' || after === '(')
                    continue;
                const key = normalizeReferenceLabel(match[2] || match[1]);
                if (!key)
                    continue;
                let blocks = refs.get(key);
                if (!blocks)
                    refs.set(key, blocks = new Set());
                blocks.add(block);
            }
        });
        return refs;
    }

    getLabelInfo(blockOrState: ParagraphContent | IParagraphState) {
        const { text } = blockOrState;
        const tokens = beginRules.reference_definition.exec(text);
        let label = null;
        let info = null;
        if (tokens) {
            label = normalizeReferenceLabel(tokens[2] + tokens[3]);
            info = {
                href: tokens[6],
                title: tokens[10] || '',
            };
        }

        return { label, info };
    }
}

export default InlineRenderer;
