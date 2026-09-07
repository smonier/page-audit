import React from 'react';
import PropTypes from 'prop-types';
import {useTranslation} from 'react-i18next';
import {CopyButton} from './CopyButton';
import styles from './Tabs.module.css';

/**
 * AI suggestions inside the SEO tab: titles, meta descriptions, keywords and
 * heading rewrites, ready to copy into Content Editor. Rendered only when a
 * provider is configured; nothing is written back to the repository.
 */
export function SeoAssist({aiStatus, assist, phase, error, language, onGenerate, onHighlightText}) {
    const {t} = useTranslation('page-audit');

    if (!aiStatus || !aiStatus.enabled) {
        return null;
    }

    const lengthHint = (text, min, max) => {
        const len = text.length;
        const ok = len >= min && len <= max;
        return (
            <span className={ok ? styles.charCount : `${styles.charCount} ${styles.warn}`}>
                {t('seo.chars', {count: len})}
            </span>
        );
    };

    const suggestionList = (items, min, max) => (
        <ul className={styles.suggestionList}>
            {items.map(text => (
                <li key={text} className={styles.suggestion}>
                    <span className={styles.suggestionText}>{text}</span>
                    <span className={styles.suggestionMeta}>
                        {lengthHint(text, min, max)}
                        <CopyButton text={text}/>
                    </span>
                </li>
            ))}
        </ul>
    );

    return (
        <div className={styles.assist}>
            <h4 className={styles.sectionTitle}>{t('seo.assist.title')}</h4>
            <p className={styles.note}>
                {t('seo.assist.intro', {language: language.toUpperCase(), provider: aiStatus.provider})}
            </p>

            {phase !== 'running' && (
                <button type="button" className={styles.smallButton} onClick={onGenerate}>
                    {assist ? t('seo.assist.regenerate') : t('seo.assist.generate')}
                </button>
            )}

            {phase === 'running' && (
                <div className={styles.note}>{t('seo.assist.generating')}</div>
            )}

            {phase === 'error' && (
                <div className={styles.recList}>
                    <div className={`${styles.rec} ${styles.cardBad}`}>
                        <div className={styles.recBody}>
                            <div className={styles.recTitle}>{t('seo.assist.error')}</div>
                            <div className={styles.recDetail}>{error}</div>
                        </div>
                    </div>
                </div>
            )}

            {assist && (
                <>
                    {assist.truncated && (
                        <p className={styles.warn}>{t('ai.truncated')}</p>
                    )}

                    {assist.titles.length > 0 && (
                        <>
                            <h5 className={styles.subTitle}>{t('seo.assist.titles')}</h5>
                            {suggestionList(assist.titles, 30, 60)}
                        </>
                    )}

                    {assist.metaDescriptions.length > 0 && (
                        <>
                            <h5 className={styles.subTitle}>{t('seo.assist.descriptions')}</h5>
                            {suggestionList(assist.metaDescriptions, 50, 160)}
                        </>
                    )}

                    {assist.social && (assist.social.title || assist.social.description) && (
                        <>
                            <h5 className={styles.subTitle}>{t('seo.assist.social')}</h5>
                            <p className={styles.note}>{t('seo.assist.socialHint')}</p>
                            {assist.social.title && suggestionList([assist.social.title], 30, 60)}
                            {assist.social.description && suggestionList([assist.social.description], 80, 150)}
                        </>
                    )}

                    {(assist.keywords.focus || assist.keywords.secondary.length > 0) && (
                        <>
                            <h5 className={styles.subTitle}>{t('seo.assist.keywords')}</h5>
                            <p className={styles.note}>{t('seo.assist.keywordsHint')}</p>
                            <div className={styles.chips}>
                                {assist.keywords.focus && (
                                    <span className={`${styles.chip} ${styles.chipFocus}`} title={t('seo.assist.focus')}>
                                        {assist.keywords.focus}
                                    </span>
                                )}
                                {assist.keywords.secondary.map(k => (
                                    <span key={k} className={styles.chip}>{k}</span>
                                ))}
                                <CopyButton
                                    text={[assist.keywords.focus, ...assist.keywords.secondary].filter(Boolean).join(', ')}
                                />
                            </div>
                        </>
                    )}

                    {assist.headings.length > 0 && (
                        <>
                            <h5 className={styles.subTitle}>{t('seo.assist.headings')}</h5>
                            <p className={styles.note}>{t('seo.assist.headingsHint')}</p>
                            {assist.headings.map(h => (
                                <div key={`${h.level}-${h.current}-${h.suggested}`} className={styles.rec}>
                                    <span className={styles.levelChip}>{h.level.toUpperCase()}</span>
                                    <div className={styles.recBody}>
                                        {h.current ? (
                                            <div className={styles.headingCurrent}>
                                                <span>{h.current}</span>
                                                <button
                                                    type="button"
                                                    className={styles.smallButton}
                                                    onClick={() => onHighlightText(h.current)}
                                                >
                                                    {t('a11y.highlight')}
                                                </button>
                                            </div>
                                        ) : (
                                            <div className={styles.headingCurrent}>
                                                <span className={styles.warn}>{t('seo.assist.missingHeading')}</span>
                                            </div>
                                        )}
                                        <div className={styles.headingSuggested}>
                                            <strong>{h.suggested}</strong>
                                            <CopyButton text={h.suggested}/>
                                        </div>
                                        {h.reason && <div className={styles.recDetail}>{h.reason}</div>}
                                    </div>
                                </div>
                            ))}
                        </>
                    )}

                    {assist.ctas && assist.ctas.length > 0 && (
                        <>
                            <h5 className={styles.subTitle}>{t('seo.assist.ctas')}</h5>
                            <p className={styles.note}>{t('seo.assist.ctasHint')}</p>
                            {assist.ctas.map(cta => (
                                <div key={cta.current} className={styles.rec}>
                                    <div className={styles.recBody}>
                                        <div className={styles.headingCurrent}>
                                            <span>{cta.current}</span>
                                            <button
                                                type="button"
                                                className={styles.smallButton}
                                                onClick={() => onHighlightText(cta.current)}
                                            >
                                                {t('a11y.highlight')}
                                            </button>
                                        </div>
                                        <div className={styles.chips}>
                                            {cta.suggestions.map(label => (
                                                <span key={label} className={styles.ctaOption}>
                                                    <span className={styles.chip}>{label}</span>
                                                    <CopyButton text={label}/>
                                                </span>
                                            ))}
                                        </div>
                                        {cta.reason && <div className={styles.recDetail}>{cta.reason}</div>}
                                    </div>
                                </div>
                            ))}
                        </>
                    )}

                    <p className={styles.note}>
                        {t('ai.poweredBy', {provider: assist.provider, model: assist.model})}
                        {assist.usage && (
                            <>
                                {' · '}
                                {t('ai.usage', {
                                    input: assist.usage.inputTokens.toLocaleString(),
                                    output: assist.usage.outputTokens.toLocaleString()
                                })}
                                {typeof assist.usage.cost === 'number' && (
                                    <> · {t('ai.cost', {cost: assist.usage.cost.toFixed(4)})}</>
                                )}
                            </>
                        )}
                        {' · '}{t('ai.disclaimer')}
                    </p>
                </>
            )}
        </div>
    );
}

SeoAssist.propTypes = {
    aiStatus: PropTypes.object,
    assist: PropTypes.object,
    phase: PropTypes.string.isRequired,
    error: PropTypes.string,
    language: PropTypes.string.isRequired,
    onGenerate: PropTypes.func.isRequired,
    onHighlightText: PropTypes.func.isRequired
};
