"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SelectorExtractor = void 0;
class SelectorExtractor {
    constructor(page) {
        this.page = page;
    }
    async extractAllInteractive() {
        const handles = await this.page.$$('button, a, input, textarea, select, [role=button], [role=link], [onclick]');
        const results = [];
        for (const h of handles) {
            const info = await this.extractFromHandle(h);
            results.push(info);
        }
        return results;
    }
    async extractForSelector(selector) {
        const handle = await this.page.$(selector);
        if (!handle)
            throw new Error(`Element not found: ${selector}`);
        return this.extractFromHandle(handle);
    }
    async extractFromHandle(handle) {
        const base = await handle.evaluate((el) => {
            return {
                tagName: el.tagName.toLowerCase(),
                id: el.id || undefined,
                className: el.className || undefined,
                text: el.textContent?.trim() || undefined,
                ariaLabel: el.getAttribute('aria-label') || undefined,
                attrs: Array.from(el.attributes).map((a) => [a.name, a.value])
            };
        });
        const cssSelector = await this.generateCss(handle);
        const xpath = await this.generateXpath(handle);
        return {
            tagName: base.tagName,
            id: base.id,
            className: base.className,
            text: base.text,
            ariaLabel: base.ariaLabel,
            cssSelector,
            xpath,
            attributes: Object.fromEntries(base.attrs)
        };
    }
    async generateCss(handle) {
        return handle.evaluate((el) => {
            if (el.id)
                return `#${el.id}`;
            if (el.getAttribute('data-testid')) {
                return `[data-testid="${el.getAttribute('data-testid')}"]`;
            }
            const parts = [];
            let curr = el;
            const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null);
            while (curr && curr !== (doc ? doc.body : null)) {
                let part = curr.tagName.toLowerCase();
                if (curr.id) {
                    part += `#${curr.id}`;
                    parts.unshift(part);
                    break;
                }
                const classes = (curr.className || '')
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((c) => `.${c}`);
                if (classes.length)
                    part += classes.join('');
                const parent = curr.parentElement;
                if (parent) {
                    const siblings = Array.from(parent.children);
                    const index = siblings.indexOf(curr) + 1;
                    if (index > 0)
                        part += `:nth-child(${index})`;
                }
                parts.unshift(part);
                curr = parent;
            }
            return parts.join(' > ');
        });
    }
    async generateXpath(handle) {
        return handle.evaluate((el) => {
            const segments = [];
            let node = el;
            // nodeType === 1 is ELEMENT_NODE
            while (node && node.nodeType === 1) {
                let index = 1;
                let sibling = node.previousElementSibling;
                while (sibling) {
                    if (sibling.tagName === node.tagName)
                        index++;
                    sibling = sibling.previousElementSibling;
                }
                const tag = node.tagName.toLowerCase();
                segments.unshift(`${tag}[${index}]`);
                node = node.parentElement;
            }
            return '/' + segments.join('/');
        });
    }
}
exports.SelectorExtractor = SelectorExtractor;
//# sourceMappingURL=selectorExtractor.js.map