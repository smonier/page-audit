/**
 * Client side of the AI review: extracts the page text, builds a compact
 * digest of the audit findings, and calls the module's server-side endpoint
 * (/modules/page-audit/ai-review). The prompt and the API key live on the
 * server - this module only ships data and renders the structured answer.
 */

const ENDPOINT = '/modules/page-audit/ai-review';

export async function fetchAiStatus() {
    const res = await fetch(ENDPOINT, {credentials: 'same-origin'});
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }

    return res.json();
}

export function extractPageText(frame) {
    const doc = frame && frame.contentDocument;
    if (!doc || !doc.body) {
        return '';
    }

    const rootEl = doc.querySelector('main') || doc.body;
    const clone = rootEl.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,svg,nav,header,footer,[aria-hidden="true"]')
        .forEach(node => node.remove());
    // Join text nodes with spaces: textContent concatenates adjacent block
    // elements without separators, which reads as "missing spaces" / merged
    // words to the LLM and to the readability word counter.
    const parts = [];
    const walker = doc.createTreeWalker(clone, 4 /* NodeFilter.SHOW_TEXT */);
    let node = walker.nextNode();
    while (node) {
        const text = node.textContent.trim();
        if (text) {
            parts.push(text);
        }

        node = walker.nextNode();
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function buildDigest(results) {
    const lines = [];

    if (results.a11y) {
        lines.push(`Accessibility: ${results.a11y.violations.length} violations, ${results.a11y.incomplete.length} to verify (${results.a11y.engine})`);
        results.a11y.violations.slice(0, 6).forEach(v =>
            lines.push(`[a11y ${v.impact} ${v.level}] ${v.help} (${v.totalNodes} elements)`));
    }

    if (results.seo) {
        results.seo.recommendations.forEach(r =>
            lines.push(`[seo ${r.severity}] ${r.key} ${JSON.stringify(r.params)}`));
    }

    if (results.links) {
        lines.push(`Links: ${results.links.total} total, ${results.links.broken.length} broken, ${results.links.external} external unchecked`);
        results.links.broken.slice(0, 5).forEach(l =>
            lines.push(`[link broken ${l.status}] ${l.url}`));
    }

    if (results.jahia) {
        results.jahia.unpublished.slice(0, 5).forEach(n =>
            lines.push(`[jahia unpublished ${n.status}] ${n.path} (${n.type})`));
        results.jahia.untranslated.slice(0, 5).forEach(n =>
            lines.push(`[jahia missing translations: ${n.missing.join(',')}] ${n.path}`));
        if (results.jahia.rawKeys.count > 0) {
            lines.push(`[jahia] ${results.jahia.rawKeys.count} raw i18n keys visible on page`);
        }
    }

    if (results.vitals) {
        const m = results.vitals.metrics;
        lines.push(`Vitals (lab): ttfb=${Math.round(m.ttfb || 0)}ms lcp≈${Math.round(m.lcp || 0)}ms cls=${(m.cls || 0).toFixed(3)}, weight=${Math.round(results.vitals.diagnostics.totalBytes / 1024)}kB, ${results.vitals.diagnostics.requests} requests`);
        results.vitals.recommendations.forEach(r =>
            lines.push(`[perf ${r.severity}] ${r.key} ${JSON.stringify(r.params)}`));
    }

    if (results.ecodesign) {
        lines.push(`Ecodesign (RGESN): ${results.ecodesign.passed}/${results.ecodesign.total} page criteria pass, weight=${Math.round(results.ecodesign.stats.totalBytes / 1024)}kB, ${results.ecodesign.stats.thirdParty} third-party origins`);
        results.ecodesign.recommendations.forEach(r =>
            lines.push(`[ecodesign ${r.severity}] ${r.key} ${JSON.stringify(r.params)}`));
    }

    if (results.readability && !results.readability.empty) {
        lines.push(`Readability: ${results.readability.formula} score ${results.readability.score} (${results.readability.band}), ${results.readability.words} words, avg sentence ${results.readability.avgSentenceLength} words`);
        results.readability.recommendations.forEach(r =>
            lines.push(`[readability ${r.severity}] ${r.key} ${JSON.stringify(r.params)}`));
    }

    return lines;
}

/** Current h1-h3 of the main content, in document order (input for heading suggestions). */
export function extractHeadings(frame, max = 20) {
    const doc = frame && frame.contentDocument;
    if (!doc || !doc.body) {
        return [];
    }

    const rootEl = doc.querySelector('main') || doc.body;
    return Array.from(rootEl.querySelectorAll('h1, h2, h3'))
        .map(h => ({level: h.tagName.toLowerCase(), text: (h.textContent || '').replace(/\s+/g, ' ').trim()}))
        .filter(h => h.text)
        .slice(0, max);
}

async function postTask(payload) {
    const res = await fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data.error || `HTTP ${res.status}`);
    }

    return data;
}

/**
 * SEO assist: ready-to-paste title / meta description / keyword / heading
 * suggestions. Unlike the review, the suggestions are PUBLISHED content and
 * are written in the audited page language; only the explanatory "reason"
 * follows the editor's UI language.
 */
export function requestSeoAssist({language, path, results, frame}) {
    const seo = results.seo || {};
    return postTask({
        task: 'seo',
        language,
        uiLanguage: (window.contextJsParameters && window.contextJsParameters.uilang) || language,
        path,
        title: seo.title ? seo.title.text : '',
        description: seo.description ? (seo.description.text || '') : '',
        headings: extractHeadings(frame),
        findings: (seo.recommendations || []).map(r => `[seo ${r.severity}] ${r.key} ${JSON.stringify(r.params)}`),
        text: extractPageText(frame)
    });
}

// Alt text: images per request (server cap too) and thumbnail edge for vision models
const ALT_MAX_IMAGES = 8;
const THUMB_MAX_PX = 512;

/** Stable CSS selector for an element of the preview document (for highlight after the audit). */
function cssPath(el) {
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    const escape = id => (win && win.CSS && win.CSS.escape ? win.CSS.escape(id) : id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== doc.body) {
        if (node.id) {
            parts.unshift(`#${escape(node.id)}`);
            break;
        }

        let selector = node.tagName.toLowerCase();
        const parent = node.parentElement;
        if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === node.tagName);
            if (siblings.length > 1) {
                selector += `:nth-of-type(${siblings.indexOf(node) + 1})`;
            }
        }

        parts.unshift(selector);
        node = parent;
    }

    return parts.join(' > ');
}

/**
 * Downscaled JPEG copy of a loaded image for the vision model, or null when
 * the pixels are unreadable (cross-origin image taints the canvas).
 */
function thumbnail(img, doc) {
    if (!img.complete || !img.naturalWidth) {
        return null;
    }

    const scale = Math.min(1, THUMB_MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = doc.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    try {
        const ctx = canvas.getContext('2d');
        // White backing: JPEG has no alpha and transparent logos would turn black
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return {mediaType: 'image/jpeg', data: canvas.toDataURL('image/jpeg', 0.7).split(',')[1]};
    } catch (e) {
        return null;
    }
}

const clean = s => (s || '').replace(/\s+/g, ' ').trim();

/**
 * Images without an alt attribute, largest first, with the DOM context the
 * model needs (caption, nearest preceding heading, surrounding text, link
 * target) and a thumbnail when readable.
 */
export function collectImagesWithoutAlt(frame, withPictures = true) {
    const doc = frame && frame.contentDocument;
    if (!doc || !doc.body) {
        return {items: [], total: 0};
    }

    const headings = Array.from(doc.querySelectorAll('h1, h2, h3'));
    const all = Array.from(doc.images).filter(img => !img.hasAttribute('alt'));
    const ranked = all
        .map(img => ({img, area: img.clientWidth * img.clientHeight}))
        .sort((a, b) => b.area - a.area)
        .slice(0, ALT_MAX_IMAGES);

    const items = ranked.map(({img}, index) => {
        const figure = img.closest('figure');
        const caption = figure && figure.querySelector('figcaption');
        const heading = headings.filter(h => h.compareDocumentPosition(img) & 4 /* FOLLOWING */).pop();
        const block = img.closest('p, li, figure, article, section, div');
        const link = img.closest('a[href]');
        const src = img.currentSrc || img.src || '';
        const thumb = withPictures ? thumbnail(img, doc) : null;
        return {
            id: index,
            selector: cssPath(img),
            src,
            filename: src.split('?')[0].split('/').pop() || '',
            width: img.clientWidth,
            height: img.clientHeight,
            linkTarget: link ? link.getAttribute('href') : '',
            caption: caption ? clean(caption.textContent) : '',
            heading: heading ? clean(heading.textContent) : '',
            context: block ? clean(block.textContent).slice(0, 400) : '',
            hasPicture: Boolean(thumb),
            ...(thumb || {})
        };
    });

    return {items, total: all.length};
}

/**
 * Alt text suggestions for the page's images without alt. Thumbnails are only
 * produced when the configured provider processes images (aiStatus.vision).
 * Returns the server answer merged with the collected items (thumbnail data
 * stripped - the result is cached in localStorage).
 */
export async function requestAltAssist({language, path, results, frame, aiStatus}) {
    const {items, total} = collectImagesWithoutAlt(frame, Boolean(aiStatus && aiStatus.vision));
    const stripped = items.map(({data, mediaType, ...rest}) => rest);
    if (items.length === 0) {
        return {images: [], items: stripped, total};
    }

    const answer = await postTask({
        task: 'alt',
        language,
        uiLanguage: (window.contextJsParameters && window.contextJsParameters.uilang) || language,
        path,
        title: results.seo && results.seo.title ? results.seo.title.text : '',
        images: items
    });

    return {...answer, items: stripped, total};
}

export function requestAiReview({language, path, results, frame}) {
    const payload = {
        language,
        // Recommendations are written FOR the editor: use the jContent UI
        // language, falling back to the audited page language
        uiLanguage: (window.contextJsParameters && window.contextJsParameters.uilang) || language,
        path,
        title: results.seo ? results.seo.title.text : '',
        description: results.seo ? (results.seo.description.text || '') : '',
        findings: buildDigest(results),
        text: extractPageText(frame)
    };

    return postTask(payload);
}
