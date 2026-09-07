import React, {useCallback, useEffect, useRef, useState} from 'react';
import PropTypes from 'prop-types';
import {useTranslation} from 'react-i18next';
import {useApolloClient} from '@apollo/client';
import {runAccessibility} from './analyzers/accessibility';
import {runWebVitals} from './analyzers/webVitals';
import {runReadability} from './analyzers/readability';
import {runEcodesign} from './analyzers/ecodesign';
import {runSeo} from './analyzers/seo';
import {runLinks} from './analyzers/links';
import {runJahiaHealth, fetchPageLastModified} from './analyzers/jahiaHealth';
import {removeToolingElements} from './analyzers/tooling';
import {requestAiReview, requestSeoAssist, requestAltAssist, fetchAiStatus} from './analyzers/aiReview';
import {AccessibilityTab} from './tabs/AccessibilityTab';
import {VitalsTab} from './tabs/VitalsTab';
import {ReadabilityTab} from './tabs/ReadabilityTab';
import {EcodesignTab} from './tabs/EcodesignTab';
import {SeoTab} from './tabs/SeoTab';
import {LinksTab} from './tabs/LinksTab';
import {JahiaTab} from './tabs/JahiaTab';
import {AiTab} from './tabs/AiTab';
import styles from './PageAuditDrawer.module.css';

// Let client islands hydrate and layout settle before measuring
const SETTLE_MS = 2500;

// Results are cached per page+language in localStorage so reopening the
// drawer restores the last audit instantly (with its timestamp shown in the
// header). "Re-run" always performs a fresh audit. LRU-capped.
const CACHE_PREFIX = 'page-audit:';
const CACHE_MAX_ENTRIES = 10;
// Bump whenever the cached `results` shape changes (e.g. a new analyzer key),
// so entries written by an older module version are ignored instead of
// restored into UI that expects the new shape.
const CACHE_SCHEMA = 2;

const cacheKey = (path, language) => `${CACHE_PREFIX}${language}:${path}`;

function loadCachedAudit(path, language) {
    try {
        const raw = window.localStorage.getItem(cacheKey(path, language));
        if (!raw) {
            return null;
        }

        const entry = JSON.parse(raw);
        // Ignore (and clear) entries from an older results schema
        if (entry.schema !== CACHE_SCHEMA) {
            window.localStorage.removeItem(cacheKey(path, language));
            return null;
        }

        return entry;
    } catch (e) {
        return null;
    }
}

function pruneCache(keep) {
    try {
        const entries = Object.keys(window.localStorage)
            .filter(k => k.startsWith(CACHE_PREFIX))
            .map(k => {
                let timestamp = 0;
                try {
                    timestamp = JSON.parse(window.localStorage.getItem(k)).timestamp || 0;
                } catch (e) {
                    // Unparseable entry: treat as oldest
                }

                return {k, timestamp};
            })
            .sort((a, b) => b.timestamp - a.timestamp);
        entries.slice(keep).forEach(e => window.localStorage.removeItem(e.k));
    } catch (e) {
        // localStorage unavailable
    }
}

function saveCachedAudit(path, language, entry) {
    const write = () => window.localStorage.setItem(cacheKey(path, language), JSON.stringify(entry));
    try {
        write();
        pruneCache(CACHE_MAX_ENTRIES);
    } catch (e) {
        // Quota exceeded: evict everything but the most recent and retry once
        pruneCache(2);
        try {
            write();
        } catch (e2) {
            // Give up silently - caching is best-effort
        }
    }
}

export function PageAuditDrawer({isOpen, onClose, path, language}) {
    const {t} = useTranslation('page-audit');
    const apolloClient = useApolloClient();
    const [activeTab, setActiveTab] = useState('accessibility');
    const [status, setStatus] = useState('idle');
    const [results, setResults] = useState(null);
    const [error, setError] = useState(null);
    const [auditedAt, setAuditedAt] = useState(null);
    // True when the page was modified after the cached audit: the old report
    // stays visible (the editor may be mid-fix) with a re-run notice.
    const [stale, setStale] = useState(false);
    // Set when results were restored from cache: skips re-analysis on frame load
    const cacheHitRef = useRef(false);
    // AI review state lives here so it survives tab switches
    const [aiReview, setAiReview] = useState(null);
    const [aiPhase, setAiPhase] = useState('idle');
    const [aiError, setAiError] = useState(null);
    // SEO assist (AI suggestions inside the SEO tab) - same lifecycle rules
    const [seoAssist, setSeoAssist] = useState(null);
    const [seoAssistPhase, setSeoAssistPhase] = useState('idle');
    const [seoAssistError, setSeoAssistError] = useState(null);
    // Alt text assist (AI suggestions inside the Accessibility tab)
    const [altAssist, setAltAssist] = useState(null);
    const [altPhase, setAltPhase] = useState('idle');
    const [altError, setAltError] = useState(null);
    // {enabled, provider, model} fetched once per drawer opening; shared by
    // the AI tab and the assist sections
    const [aiStatus, setAiStatus] = useState(null);
    const [runId, setRunId] = useState(0);
    // The iframe is mounted only once the drawer slide-in transition is done:
    // loading it while the drawer is still translated off-screen makes Chrome
    // throttle rendering, and FCP/LCP paint entries never fire.
    const [frameVisible, setFrameVisible] = useState(false);
    // Collapsing hides the preview visually (height 0) but keeps the iframe
    // mounted - analyzers and highlight still need its document.
    const [previewCollapsed, setPreviewCollapsed] = useState(false);
    const frameRef = useRef(null);
    const highlightedRef = useRef(null);

    const previewUrl = `/cms/render/default/${language}${path}.html?pageAuditRun=${runId}`;

    useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        let cancelled = false;
        fetchAiStatus()
            .then(s => !cancelled && setAiStatus(s))
            .catch(() => !cancelled && setAiStatus({enabled: false, unreachable: true}));
        return () => {
            cancelled = true;
        };
    }, [isOpen]);

    useEffect(() => {
        if (isOpen) {
            setError(null);
            setAiError(null);
            setSeoAssistError(null);
            setAltError(null);
            // Re-runs need a visible frame for paint-dependent measurements
            setPreviewCollapsed(false);
            highlightedRef.current = null;

            const cached = runId === 0 ? loadCachedAudit(path, language) : null;
            setStale(false);
            if (cached && cached.results) {
                cacheHitRef.current = true;
                setResults(cached.results);
                setAuditedAt(cached.timestamp || null);
                setAiReview(cached.aiReview || null);
                setAiPhase(cached.aiReview ? 'done' : 'idle');
                setSeoAssist(cached.seoAssist || null);
                setSeoAssistPhase(cached.seoAssist ? 'done' : 'idle');
                setAltAssist(cached.altAssist || null);
                setAltPhase(cached.altAssist ? 'done' : 'idle');
                setStatus('ready');
                // Staleness probe: was the page modified after this audit?
                if (cached.timestamp) {
                    fetchPageLastModified(apolloClient, path, language).then(modifiedAt => {
                        if (modifiedAt && modifiedAt > cached.timestamp) {
                            setStale(true);
                        }
                    });
                }
            } else {
                cacheHitRef.current = false;
                setStatus('loading');
                setResults(null);
                setAuditedAt(null);
                setAiReview(null);
                setAiPhase('idle');
                setSeoAssist(null);
                setSeoAssistPhase('idle');
                setAltAssist(null);
                setAltPhase('idle');
            }

            const timer = setTimeout(() => setFrameVisible(true), 400);
            return () => clearTimeout(timer);
        }

        setFrameVisible(false);
    }, [isOpen, runId, path, language, apolloClient]);

    const handleFrameLoad = useCallback(() => {
        if (cacheHitRef.current) {
            // Results restored from cache: the frame is only a preview /
            // highlight target, no re-analysis
            return;
        }

        setStatus('analyzing');
        setTimeout(async () => {
            const frame = frameRef.current;
            try {
                if (!frame || !frame.contentDocument) {
                    throw new Error('Preview frame unavailable');
                }

                // Refuse to audit an error page (404/500 render) - scoring it
                // would silently produce meaningless results.
                const navEntry = frame.contentWindow.performance.getEntriesByType('navigation')[0];
                if (navEntry && navEntry.responseStatus >= 400) {
                    throw new Error(`HTTP ${navEntry.responseStatus}`);
                }

                // Strip editor/preview tooling (jExperience persona panel…)
                // before any analyzer sees the DOM.
                removeToolingElements(frame.contentDocument);

                // Vitals first: axe injection and link checks would otherwise
                // appear in the page's own resource statistics.
                const vitals = await runWebVitals(frame);
                const ecodesign = runEcodesign(frame, vitals);
                const readability = runReadability(frame, language);
                const seo = runSeo(frame, language);
                const a11y = await runAccessibility(frame);
                const links = await runLinks(frame);
                const jahia = await runJahiaHealth(frame, {client: apolloClient, path, language});
                const newResults = {a11y, vitals, ecodesign, readability, seo, links, jahia};
                const timestamp = Date.now();
                setResults(newResults);
                setAuditedAt(timestamp);
                saveCachedAudit(path, language, {schema: CACHE_SCHEMA, timestamp, results: newResults});
                setStatus('ready');
            } catch (e) {
                console.error('[page-audit] analysis failed', e);
                setError(e.message);
                setStatus('error');
            }
        }, SETTLE_MS);
    }, [language, path, apolloClient]);

    const highlight = useCallback(selector => {
        const doc = frameRef.current && frameRef.current.contentDocument;
        if (!doc) {
            return;
        }

        setPreviewCollapsed(false);

        if (highlightedRef.current) {
            try {
                highlightedRef.current.style.outline = '';
                highlightedRef.current.style.outlineOffset = '';
            } catch (e) {
                // Element may be gone after re-run
            }
        }

        let el = null;
        try {
            el = doc.querySelector(selector);
        } catch (e) {
            return;
        }

        if (el) {
            el.scrollIntoView({behavior: 'smooth', block: 'center'});
            el.style.outline = '3px solid #e0182d';
            el.style.outlineOffset = '2px';
            highlightedRef.current = el;
        }
    }, []);

    const highlightText = useCallback(sample => {
        const doc = frameRef.current && frameRef.current.contentDocument;
        if (!doc || !doc.body || !sample) {
            return;
        }

        setPreviewCollapsed(false);

        if (highlightedRef.current) {
            try {
                highlightedRef.current.style.outline = '';
                highlightedRef.current.style.outlineOffset = '';
            } catch (e) {
                // Element may be gone after re-run
            }
        }

        // LLM quotes are approximate: normalize whitespace, apostrophes and
        // quotes, compare case-insensitively, and search at ELEMENT level so
        // wording spanning several inline text nodes still matches. Fall back
        // to the first words of the quote when the full text is not found.
        const normalize = s => s
            .replace(/[’‘]/g, '\'')
            .replace(/[“”«»]/g, '"')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const fullNeedle = normalize(sample);
        const words = fullNeedle.split(' ');
        const needles = [...new Set([
            fullNeedle,
            words.slice(0, 8).join(' '),
            words.slice(0, 4).join(' ')
        ])].filter(n => n.length >= 3);

        const elements = [...doc.body.querySelectorAll('*')]
            .filter(el => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName));

        let target = null;
        for (const needle of needles) {
            const matches = elements.filter(el => normalize(el.textContent || '').includes(needle));
            if (matches.length > 0) {
                // Tightest container = the match with the least text
                target = matches.reduce((a, b) =>
                    ((a.textContent || '').length <= (b.textContent || '').length ? a : b));
                break;
            }
        }

        if (target) {
            target.scrollIntoView({behavior: 'smooth', block: 'center'});
            target.style.outline = '3px solid #e0182d';
            target.style.outlineOffset = '2px';
            highlightedRef.current = target;
        }
    }, []);

    // Every AI result rides in the same cache entry: always persist all of
    // them, overriding the one that just changed, or one save wipes the others.
    const persistAi = useCallback(override => {
        saveCachedAudit(path, language, {
            schema: CACHE_SCHEMA,
            timestamp: auditedAt || Date.now(),
            results,
            aiReview,
            seoAssist,
            altAssist,
            ...override
        });
    }, [path, language, auditedAt, results, aiReview, seoAssist, altAssist]);

    // The three AI tasks share one lifecycle: explicit click, running/done/error
    // phases, result cached with the audit. Never auto-triggered (cost control).
    const runAiTask = useCallback(async ({request, cacheKey: key, setResult, setPhase, setErr, label}) => {
        if (!results) {
            return;
        }

        setPhase('running');
        setErr(null);
        try {
            const answer = await request({language, path, results, frame: frameRef.current, aiStatus});
            setResult(answer);
            setPhase('done');
            persistAi({[key]: answer});
        } catch (e) {
            console.error(`[page-audit] ${label} failed`, e);
            setErr(e.message);
            setPhase('error');
        }
    }, [results, language, path, persistAi, aiStatus]);

    const generateAiReview = useCallback(() => runAiTask({
        request: requestAiReview, cacheKey: 'aiReview', label: 'AI review',
        setResult: setAiReview, setPhase: setAiPhase, setErr: setAiError
    }), [runAiTask]);

    const generateSeoAssist = useCallback(() => runAiTask({
        request: requestSeoAssist, cacheKey: 'seoAssist', label: 'SEO assist',
        setResult: setSeoAssist, setPhase: setSeoAssistPhase, setErr: setSeoAssistError
    }), [runAiTask]);

    const generateAltAssist = useCallback(() => runAiTask({
        request: requestAltAssist, cacheKey: 'altAssist', label: 'Alt text assist',
        setResult: setAltAssist, setPhase: setAltPhase, setErr: setAltError
    }), [runAiTask]);

    const exportJson = useCallback(() => {
        if (!results) {
            return;
        }

        const payload = {path, language, url: previewUrl.split('?')[0], auditedAt, results};
        const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `page-audit-${path.split('/').filter(Boolean).pop() || 'page'}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
    }, [results, path, language, previewUrl, auditedAt]);

    // Badge = number of issues to review in that tab; null-safe so a partial
    // result never breaks the tab bar.
    const count = (r, extract) => (r ? extract(r) : null);
    const tabs = [
        {key: 'accessibility', label: t('tabs.accessibility'), badge: count(results && results.a11y, a => a.violations.length)},
        {key: 'seo', label: t('tabs.seo'), badge: count(results && results.seo, r => r.recommendations.length)},
        {key: 'vitals', label: t('tabs.vitals'), badge: count(results && results.vitals, r => r.recommendations.length)},
        {key: 'readability', label: t('tabs.readability'), badge: count(results && results.readability, r => r.recommendations.length)},
        {key: 'ecodesign', label: t('tabs.ecodesign'), badge: count(results && results.ecodesign, r => r.recommendations.length)},
        {key: 'links', label: t('tabs.links'), badge: count(results && results.links, r => r.recommendations.length)},
        {key: 'jahia', label: t('tabs.jahia'), badge: count(results && results.jahia, r => r.recommendations.length)},
        {key: 'ai', label: t('tabs.ai'), badge: count(aiReview, r => r.recommendations.length)}
    ];

    return (
        <>
            <div
                aria-hidden="true"
                className={`${styles.backdrop} ${isOpen ? styles.backdropVisible : ''}`}
                onClick={onClose}
            />
            <aside
                aria-label={t('drawer.title')}
                className={`${styles.drawer} ${isOpen ? styles.drawerOpen : ''}`}
            >
                <header className={styles.header}>
                    <div className={styles.headerText}>
                        <span className={styles.title}>{t('drawer.title')}</span>
                        <span className={styles.path} title={path}>{path}</span>
                        {auditedAt && (
                            <span className={styles.lastAudit}>
                                {t('drawer.lastAudit', {
                                    date: new Date(auditedAt).toLocaleString(
                                        language === 'fr' ? 'fr-FR' : language)
                                })}
                            </span>
                        )}
                    </div>
                    <div className={styles.headerActions}>
                        <button
                            type="button"
                            className={styles.headerButton}
                            onClick={() => setPreviewCollapsed(c => !c)}
                        >
                            {previewCollapsed ? t('drawer.showPreview') : t('drawer.hidePreview')}
                        </button>
                        <button
                            type="button"
                            className={styles.headerButton}
                            disabled={status === 'loading' || status === 'analyzing'}
                            onClick={() => setRunId(id => id + 1)}
                        >
                            {t('drawer.rerun')}
                        </button>
                        <button
                            type="button"
                            className={styles.headerButton}
                            disabled={!results}
                            onClick={exportJson}
                        >
                            {t('drawer.export')}
                        </button>
                        <button
                            type="button"
                            aria-label={t('drawer.close')}
                            className={styles.closeButton}
                            onClick={onClose}
                        >
                            ×
                        </button>
                    </div>
                </header>

                <div className={`${styles.preview} ${previewCollapsed ? styles.previewCollapsed : ''}`}>
                    {frameVisible && (
                        <iframe
                            key={runId}
                            ref={frameRef}
                            title={t('drawer.preview')}
                            src={previewUrl}
                            className={styles.frame}
                            onLoad={handleFrameLoad}
                        />
                    )}
                </div>

                {stale && (
                    <div className={styles.staleBanner}>
                        {t('drawer.stale')}
                        <button
                            type="button"
                            className={styles.smallHeaderButton}
                            onClick={() => setRunId(id => id + 1)}
                        >
                            {t('drawer.rerun')}
                        </button>
                    </div>
                )}

                <nav className={styles.tabs}>
                    {tabs.map(tab => (
                        <button
                            key={tab.key}
                            type="button"
                            className={`${styles.tab} ${activeTab === tab.key ? styles.tabActive : ''}`}
                            title={tab.badge === null ? undefined : t('tabs.badgeTooltip', {count: tab.badge})}
                            onClick={() => setActiveTab(tab.key)}
                        >
                            {tab.label}
                            {tab.badge !== null && tab.badge !== undefined &&
                                <span className={styles.badge}>{tab.badge}</span>}
                        </button>
                    ))}
                </nav>

                <div className={styles.content}>
                    {(status === 'loading' || status === 'analyzing') && (
                        <div className={styles.status}>
                            <div className={styles.spinner}/>
                            {t(status === 'loading' ? 'drawer.loading' : 'drawer.analyzing')}
                        </div>
                    )}
                    {status === 'error' && (
                        <div className={styles.error}>{t('drawer.error')}: {error}</div>
                    )}
                    {status === 'ready' && results && (
                        <>
                            {activeTab === 'accessibility' && results.a11y &&
                                <AccessibilityTab
                                    result={results.a11y}
                                    onHighlight={highlight}
                                    assist={{
                                        aiStatus,
                                        assist: altAssist,
                                        phase: altPhase,
                                        error: altError,
                                        language,
                                        count: results.seo ? results.seo.imagesWithoutAlt : 0,
                                        onGenerate: generateAltAssist,
                                        onHighlight: highlight
                                    }}
                                />}
                            {activeTab === 'seo' && results.seo &&
                                <SeoTab
                                    result={results.seo}
                                    assist={{
                                        aiStatus,
                                        assist: seoAssist,
                                        phase: seoAssistPhase,
                                        error: seoAssistError,
                                        language,
                                        onGenerate: generateSeoAssist,
                                        onHighlightText: highlightText
                                    }}
                                />}
                            {activeTab === 'links' && results.links &&
                                <LinksTab result={results.links} onHighlight={highlight}/>}
                            {activeTab === 'jahia' && results.jahia &&
                                <JahiaTab result={results.jahia} onHighlightText={highlightText}/>}
                            {activeTab === 'ai' &&
                                <AiTab
                                    status={aiStatus}
                                    review={aiReview}
                                    phase={aiPhase}
                                    error={aiError}
                                    onGenerate={generateAiReview}
                                    onHighlightText={highlightText}
                                />}
                            {activeTab === 'vitals' && results.vitals &&
                                <VitalsTab result={results.vitals}/>}
                            {activeTab === 'readability' && results.readability &&
                                <ReadabilityTab result={results.readability}/>}
                            {activeTab === 'ecodesign' && results.ecodesign &&
                                <EcodesignTab result={results.ecodesign}/>}
                        </>
                    )}
                </div>
            </aside>
        </>
    );
}

PageAuditDrawer.propTypes = {
    isOpen: PropTypes.bool.isRequired,
    onClose: PropTypes.func.isRequired,
    path: PropTypes.string.isRequired,
    language: PropTypes.string.isRequired
};
