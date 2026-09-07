import React from 'react';
import PropTypes from 'prop-types';
import {useTranslation} from 'react-i18next';
import {CopyButton} from './CopyButton';
import styles from './Tabs.module.css';

const ALT_MAX_CHARS = 125;

/**
 * AI alt text suggestions inside the Accessibility tab, for every image that
 * has no alt attribute. Display + copy: the editor pastes into the image's
 * alt field in Content Editor. Rendered only when AI is configured and the
 * page actually has images without alt.
 */
export function AltAssist({aiStatus, assist, phase, error, language, count, onGenerate, onHighlight}) {
    const {t} = useTranslation('page-audit');

    if (!aiStatus || !aiStatus.enabled || !count) {
        return null;
    }

    const suggestionFor = item => (assist.images || []).find(s => s.id === item.id);

    return (
        <div className={styles.assist}>
            <h4 className={styles.sectionTitle}>{t('a11y.alt.title')}</h4>
            <p className={styles.note}>
                {t('a11y.alt.intro', {count, language: language.toUpperCase()})}
                {!aiStatus.vision && <> {t('a11y.alt.noVision', {provider: aiStatus.provider})}</>}
            </p>

            {phase !== 'running' && (
                <button type="button" className={styles.smallButton} onClick={onGenerate}>
                    {assist ? t('a11y.alt.regenerate') : t('a11y.alt.generate')}
                </button>
            )}

            {phase === 'running' && (
                <div className={styles.note}>{t('a11y.alt.generating')}</div>
            )}

            {phase === 'error' && (
                <div className={styles.recList}>
                    <div className={`${styles.rec} ${styles.cardBad}`}>
                        <div className={styles.recBody}>
                            <div className={styles.recTitle}>{t('a11y.alt.error')}</div>
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

                    {assist.items.map(item => {
                        const s = suggestionFor(item);
                        return (
                            <div key={item.id} className={styles.rec}>
                                <img alt="" src={item.src} className={styles.altThumb}/>
                                <div className={styles.recBody}>
                                    <div className={styles.altMeta}>
                                        {item.filename}
                                        {' · '}{item.width}×{item.height}
                                        {(!item.hasPicture || !assist.vision) && <> · {t('a11y.alt.noPicture')}</>}
                                    </div>
                                    {s && s.decorative && (
                                        <div className={styles.headingSuggested}>
                                            <span className={styles.chip}>{t('a11y.alt.decorative')}</span>
                                            <CopyButton text={'alt=""'}/>
                                        </div>
                                    )}
                                    {s && !s.decorative && s.alt && (
                                        <div className={styles.headingSuggested}>
                                            <strong>{s.alt}</strong>
                                            <span className={s.alt.length <= ALT_MAX_CHARS ? styles.charCount : `${styles.charCount} ${styles.warn}`}>
                                                {t('seo.chars', {count: s.alt.length})}
                                            </span>
                                            <CopyButton text={s.alt}/>
                                        </div>
                                    )}
                                    {!s && <div className={styles.warn}>{t('a11y.alt.noAnswer')}</div>}
                                    {s && s.reason && <div className={styles.recDetail}>{s.reason}</div>}
                                    <button
                                        type="button"
                                        className={styles.smallButton}
                                        onClick={() => onHighlight(item.selector)}
                                    >
                                        {t('a11y.highlight')}
                                    </button>
                                </div>
                            </div>
                        );
                    })}

                    {assist.total > assist.items.length && (
                        <p className={styles.note}>{t('a11y.alt.more', {count: assist.total - assist.items.length})}</p>
                    )}

                    {assist.provider && (
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
                    )}
                </>
            )}
        </div>
    );
}

AltAssist.propTypes = {
    aiStatus: PropTypes.object,
    assist: PropTypes.object,
    phase: PropTypes.string.isRequired,
    error: PropTypes.string,
    language: PropTypes.string.isRequired,
    // Number of images without alt on the page (from the SEO analyzer); 0 hides the section
    count: PropTypes.number,
    onGenerate: PropTypes.func.isRequired,
    onHighlight: PropTypes.func.isRequired
};
