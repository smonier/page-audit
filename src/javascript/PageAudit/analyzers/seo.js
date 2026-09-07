/**
 * SEO analysis of the preview frame: meta tags, robots directives,
 * canonical, Open Graph / Twitter card, structured data, language
 * attributes, alt coverage and anchor-text quality. DOM-only - the
 * Jahia-side checks (vanity URLs, translations) belong to a future
 * content-health analyzer.
 */

const TITLE_RANGE = [30, 60];
const DESCRIPTION_RANGE = [50, 160];

// Link / button labels that say nothing about the destination or the action.
// Compared after stripping decorations ("Read More +", "En savoir plus »").
const GENERIC_ANCHORS = /^(click here|here|read more|more|learn more|link|see more|view more|submit|send|go|ok|continue|next|cliquez ici|ici|en savoir plus|lire la suite|plus|voir plus|découvrir|envoyer|soumettre|valider|continuer|suivant)$/i;
const MAX_WEAK_CTAS = 10;

const normalizeLabel = text => (text || '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\W_]+|[\s\W_]+$/g, '')
    .trim();

/**
 * Weak calls to action: links and buttons whose label is generic. Returns
 * distinct labels with a sample of the surrounding text, for the AI assist.
 */
function collectWeakCtas(doc) {
    const controls = Array.from(doc.querySelectorAll('a[href], button, input[type="submit"], input[type="button"]'));
    const seen = new Map();
    controls.forEach(el => {
        const raw = el.tagName === 'INPUT' ? el.value : el.textContent;
        const label = normalizeLabel(raw);
        if (!label || !GENERIC_ANCHORS.test(label)) {
            return;
        }

        const key = label.toLowerCase();
        if (seen.has(key)) {
            seen.get(key).count++;
            return;
        }

        // Walk up until the block carries real text beyond the label itself
        // (the link's own wrapper usually contains nothing else)
        let block = el.parentElement;
        while (block && block !== doc.body && (block.textContent || '').replace(/\s+/g, ' ').trim().length < label.length + 40) {
            block = block.parentElement;
        }

        seen.set(key, {
            text: (raw || '').replace(/\s+/g, ' ').trim(),
            count: 1,
            target: el.getAttribute('href') || '',
            context: block ? (block.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300) : ''
        });
    });

    return Array.from(seen.values()).slice(0, MAX_WEAK_CTAS);
}

export function runSeo(frame, language) {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) {
        throw new Error('Preview frame is not accessible');
    }

    const meta = name => {
        const el = doc.querySelector(`meta[name="${name}"]`);
        return el ? (el.getAttribute('content') || '').trim() : null;
    };

    const prop = property => {
        const el = doc.querySelector(`meta[property="${property}"]`);
        return el ? (el.getAttribute('content') || '').trim() : null;
    };

    // The default-workspace render prefixes the title with Jahia's preview
    // label ("Aperçu - ", "Preview - "…) - not part of the real page title.
    const title = (doc.title || '').trim()
        .replace(/^(aperçu|preview|vorschau|anteprima|vista previa)\s*[-–:]\s*/i, '');
    const description = meta('description');
    const robots = (meta('robots') || '').toLowerCase();
    const canonicalEl = doc.querySelector('link[rel="canonical"]');
    const og = {
        title: prop('og:title'),
        description: prop('og:description'),
        image: prop('og:image'),
        type: prop('og:type')
    };
    let ogImageResolved = null;
    if (og.image) {
        try {
            ogImageResolved = new win.URL(og.image, win.location.href).href;
        } catch (e) {
            ogImageResolved = og.image;
        }
    }

    const twitterCard = meta('twitter:card');

    const jsonLdBlocks = Array.from(doc.querySelectorAll('script[type="application/ld+json"]'));
    let jsonLdErrors = 0;
    jsonLdBlocks.forEach(s => {
        try {
            JSON.parse(s.textContent);
        } catch (e) {
            jsonLdErrors++;
        }
    });

    const htmlLang = (doc.documentElement.getAttribute('lang') || '').toLowerCase();
    const expectedLang = (language || '').slice(0, 2).toLowerCase();

    const images = Array.from(doc.images || []);
    const imagesWithoutAlt = images.filter(img => !img.hasAttribute('alt')).length;

    const badAnchors = Array.from(doc.querySelectorAll('a[href]')).filter(a => {
        const text = normalizeLabel(a.textContent);
        return text.length > 0 && GENERIC_ANCHORS.test(text);
    }).length;
    const weakCtas = collectWeakCtas(doc);

    const hreflang = doc.querySelectorAll('link[rel="alternate"][hreflang]').length;

    const result = {
        title: {text: title, length: title.length},
        description: {text: description, length: description ? description.length : 0},
        robots: {content: robots || null, noindex: robots.includes('noindex'), nofollow: robots.includes('nofollow')},
        canonical: canonicalEl ? canonicalEl.href : null,
        og,
        ogImageResolved,
        twitterCard,
        jsonLd: {count: jsonLdBlocks.length, errors: jsonLdErrors},
        lang: {htmlLang: htmlLang || null, expected: expectedLang},
        hreflang,
        totalImages: images.length,
        imagesWithoutAlt,
        badAnchors,
        weakCtas
    };

    result.recommendations = buildSeoRecommendations(result);
    return result;
}

function buildSeoRecommendations(r) {
    const recs = [];
    const push = (key, severity, params) => recs.push({key, severity, params: params || {}});

    if (!r.title.text) {
        push('noTitle', 'critical');
    } else if (r.title.length < TITLE_RANGE[0] || r.title.length > TITLE_RANGE[1]) {
        push('titleLength', 'moderate', {length: r.title.length, min: TITLE_RANGE[0], max: TITLE_RANGE[1]});
    }

    if (!r.description.text) {
        push('noDescription', 'serious');
    } else if (r.description.length < DESCRIPTION_RANGE[0] || r.description.length > DESCRIPTION_RANGE[1]) {
        push('descriptionLength', 'moderate', {length: r.description.length, min: DESCRIPTION_RANGE[0], max: DESCRIPTION_RANGE[1]});
    }

    if (r.robots.noindex) {
        push('noindex', 'critical', {content: r.robots.content});
    } else if (r.robots.nofollow) {
        push('nofollow', 'moderate', {content: r.robots.content});
    }

    if (!r.canonical) {
        push('noCanonical', 'minor');
    }

    if (!r.og.title || !r.og.image) {
        push('incompleteOg', 'moderate');
    }

    if (r.jsonLd.errors > 0) {
        push('invalidStructuredData', 'serious', {count: r.jsonLd.errors});
    } else if (r.jsonLd.count === 0) {
        push('noStructuredData', 'minor');
    }

    if (!r.lang.htmlLang) {
        push('noLang', 'moderate');
    } else if (r.lang.expected && !r.lang.htmlLang.startsWith(r.lang.expected)) {
        push('langMismatch', 'serious', {htmlLang: r.lang.htmlLang, expected: r.lang.expected});
    }

    if (r.imagesWithoutAlt > 0) {
        push('missingAlt', 'moderate', {count: r.imagesWithoutAlt});
    }

    if (r.badAnchors > 0) {
        push('genericAnchors', 'minor', {count: r.badAnchors});
    }

    return recs;
}
