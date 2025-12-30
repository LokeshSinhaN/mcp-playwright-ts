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
            const win = el.ownerDocument && el.ownerDocument.defaultView;
            const rect = el.getBoundingClientRect();
            const style = win ? win.getComputedStyle(el) : null;
            const visible = !!el.offsetParent &&
                rect.width > 0 &&
                rect.height > 0 &&
                (!style || (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'));
            const tagName = (el.tagName || '').toLowerCase();
            let roleHint = 'other';
            if (tagName === 'button')
                roleHint = 'button';
            else if (tagName === 'a')
                roleHint = 'link';
            else if (tagName === 'input' || tagName === 'textarea' || tagName === 'select')
                roleHint = 'input';
            const typeAttr = (el.getAttribute && el.getAttribute('type')) || '';
            const placeholder = (el.getAttribute && el.getAttribute('placeholder')) || '';
            const ariaLabel = (el.getAttribute && el.getAttribute('aria-label')) || '';
            const isSearchField = tagName === 'input' &&
                (/search/i.test(typeAttr) || /search/i.test(placeholder) || /search/i.test(ariaLabel));
            const viewportHeight = win && win.innerHeight ? win.innerHeight : 900;
            let region = 'main';
            if (rect.top < viewportHeight * 0.25)
                region = 'header';
            else if (rect.top > viewportHeight * 0.75)
                region = 'footer';
            return {
                tagName,
                id: el.id || undefined,
                className: el.className || undefined,
                text: el.textContent?.trim() || undefined,
                ariaLabel,
                visible,
                roleHint,
                searchField: isSearchField,
                region,
                boundingBox: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
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
            visible: base.visible,
            roleHint: base.roleHint,
            searchField: base.searchField,
            region: base.region,
            boundingBox: base.boundingBox,
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