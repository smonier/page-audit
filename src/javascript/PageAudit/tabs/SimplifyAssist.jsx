import React from 'react';
import PropTypes from 'prop-types';
import {useTranslation} from 'react-i18next';
import {CopyButton} from './CopyButton';
import styles from './Tabs.module.css';

const wordCount = text => text.trim().split(/\s+/).filter(Boolean).length;

/**
 * Plain-language rewrites inside the Readability tab: the page's hardest
 * sentences, each with an AI rewrite to copy into the content. Rendered only
 * when AI is configured and the page has long sentences.
 */
export function SimplifyAssist({aiStatus, assist, phase, error, language, count, onGenerate, onHighlightText}) {
    const {t} = useTranslation('page-audit');

    if (!aiStatus || !aiStatus.enabled || !count) {
        return null;
    }

    const rewriteFor = item => (assist.sentences || []).find(s => s.id === item.id);

    return (
        <div className={styles.assist}>
            <h4 className={styles.sectionTitle}>{t('readability.simplify.title')}</h4>
            <p className={styles.note}>{t('readability.simplify.intro', {count, language: language.toUpperCase()})}</p>

            {phase !== 'running' && (
                <button type="button" className={styles.smallButton} onClick={onGenerate}>
                    {assist ? t('readability.simplify.regenerate') : t('readability.simplify.generate')}
                </button>
            )}

            {phase === 'running' && (
                <div className={styles.note}>{t('readability.simplify.generating')}</div>
            )}

            {phase === 'error' && (
                <div className={styles.recList}>
                    <div className={`${styles.rec} ${styles.cardBad}`}>
                        <div className={styles.recBody}>
                            <div className={styles.recTitle}>{t('readability.simplify.error')}</div>
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
                        const s = rewriteFor(item);
                        return (
                            <div key={item.id} className={styles.rec}>
                                <div className={styles.recBody}>
                                    <div className={styles.sentenceOriginal}>
                                        <span>{item.text}</span>
                                        <span className={styles.suggestionMeta}>
                                            <span className={styles.charCount}>{t('readability.simplify.words', {count: item.words})}</span>
                                            <button
                                                type="button"
                                                className={styles.smallButton}
                                                onClick={() => onHighlightText(item.text)}
                                            >
                                                {t('a11y.highlight')}
                                            </button>
                                        </span>
                                    </div>
                                    {s ? (
                                        <>
                                            <div className={styles.headingSuggested}>
                                                <strong>{s.rewrite}</strong>
                                                <span className={styles.charCount}>{t('readability.simplify.words', {count: wordCount(s.rewrite)})}</span>
                                                <CopyButton text={s.rewrite}/>
                                            </div>
                                            {s.reason && <div className={styles.recDetail}>{s.reason}</div>}
                                        </>
                                    ) : (
                                        <div className={styles.warn}>{t('readability.simplify.noAnswer')}</div>
                                    )}
                                </div>
                            </div>
                        );
                    })}

                    {assist.total > assist.items.length && (
                        <p className={styles.note}>{t('readability.simplify.more', {count: assist.total - assist.items.length})}</p>
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

SimplifyAssist.propTypes = {
    aiStatus: PropTypes.object,
    assist: PropTypes.object,
    phase: PropTypes.string.isRequired,
    error: PropTypes.string,
    language: PropTypes.string.isRequired,
    // Number of long sentences on the page (readability analyzer); 0 hides the section
    count: PropTypes.number,
    onGenerate: PropTypes.func.isRequired,
    onHighlightText: PropTypes.func.isRequired
};
