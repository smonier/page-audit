import React from 'react';
import PropTypes from 'prop-types';
import {useTranslation} from 'react-i18next';
import {CopyButton} from './CopyButton';
import styles from './Tabs.module.css';

export function AiTab({status, review, phase, error, onGenerate, onHighlightText}) {
    const {t} = useTranslation('page-audit');

    if (!status) {
        return (
            <div className={styles.note}>{t('ai.checking')}</div>
        );
    }

    if (!status.enabled) {
        return (
            <div>
                <p className={styles.note}>{t('ai.notConfigured')}</p>
                <code className={styles.nodeHtml}>
                    digital-factory-data/karaf/etc/org.jahia.se.modules.pageaudit.cfg
                </code>
            </div>
        );
    }

    return (
        <div>
            <p className={styles.note}>
                {t('ai.intro', {provider: status.provider, model: status.model})}
            </p>

            {phase !== 'running' && (
                <button type="button" className={styles.smallButton} onClick={onGenerate}>
                    {review ? t('ai.regenerate') : t('ai.generate')}
                </button>
            )}

            {phase === 'running' && (
                <div className={styles.note}>{t('ai.generating')}</div>
            )}

            {phase === 'error' && (
                <div className={styles.recList}>
                    <div className={`${styles.rec} ${styles.cardBad}`}>
                        <div className={styles.recBody}>
                            <div className={styles.recTitle}>{t('ai.error')}</div>
                            <div className={styles.recDetail}>{error}</div>
                        </div>
                    </div>
                </div>
            )}

            {review && (
                <>
                    {review.truncated && (
                        <p className={styles.warn}>{t('ai.truncated')}</p>
                    )}
                    {review.summary && (
                        <>
                            <h4 className={styles.sectionTitle}>{t('ai.summary')}</h4>
                            <p>{review.summary}</p>
                        </>
                    )}

                    <h4 className={styles.sectionTitle}>{t('recs.title')}</h4>
                    {review.recommendations.length === 0 && (
                        <div className={styles.allGood}>{t('recs.none')}</div>
                    )}
                    {review.recommendations.map((rec, i) => (
                        /* eslint-disable-next-line react/no-array-index-key */
                        <div key={i} className={styles.rec}>
                            <span className={`${styles.impact} ${styles[`impact_${rec.severity}`]}`}>
                                {t(`a11y.impacts.${rec.severity}`)}
                            </span>
                            <div className={styles.recBody}>
                                <div className={styles.recTitle}>
                                    <span className={styles.levelChip}>{t(`ai.categories.${rec.category}`)}</span>
                                    {' '}{rec.title}
                                </div>
                                <div className={styles.recDetail}>{rec.detail}</div>
                                {rec.wording && (
                                    <>
                                        <code className={styles.nodeHtml}>{rec.wording}</code>
                                        <button
                                            type="button"
                                            className={styles.smallButton}
                                            onClick={() => onHighlightText(rec.wording)}
                                        >
                                            {t('a11y.highlight')}
                                        </button>
                                    </>
                                )}
                                {rec.fix && (
                                    <div className={styles.headingSuggested}>
                                        <span className={styles.levelChip}>{t('ai.fix')}</span>
                                        <strong>{rec.fix}</strong>
                                        <CopyButton text={rec.fix}/>
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}

                    <p className={styles.note}>
                        {t('ai.poweredBy', {provider: review.provider, model: review.model})}
                        {review.usage && (
                            <>
                                {' · '}
                                {t('ai.usage', {
                                    input: review.usage.inputTokens.toLocaleString(),
                                    output: review.usage.outputTokens.toLocaleString()
                                })}
                                {typeof review.usage.cost === 'number' && (
                                    <> · {t('ai.cost', {cost: review.usage.cost.toFixed(4)})}</>
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

AiTab.propTypes = {
    // {enabled, provider, model} from the server, null while loading
    status: PropTypes.object,
    review: PropTypes.object,
    phase: PropTypes.string.isRequired,
    error: PropTypes.string,
    onGenerate: PropTypes.func.isRequired,
    onHighlightText: PropTypes.func.isRequired
};
