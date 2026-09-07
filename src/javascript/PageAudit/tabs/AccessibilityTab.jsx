import React from 'react';
import PropTypes from 'prop-types';
import {useTranslation} from 'react-i18next';
import {MANUAL_CHECKLIST} from './a11yChecklist';
import {AltAssist} from './AltAssist';
import styles from './Tabs.module.css';

const LEVELS = ['A', 'AA', 'AAA', 'BP'];

function RuleDetails({rule, chip, onHighlight}) {
    const {t} = useTranslation('page-audit');

    return (
        <details className={styles.violation}>
            <summary className={styles.violationSummary}>
                {chip}
                <span className={styles.levelChip}>{rule.level}</span>
                <span className={styles.violationHelp}>{rule.help}</span>
                <span className={styles.nodeCount}>{rule.totalNodes}</span>
            </summary>
            <div className={styles.violationBody}>
                <p>{rule.description} (<a href={rule.helpUrl} target="_blank" rel="noreferrer">{rule.id}</a>)</p>
                {rule.nodes.map((node, i) => (
                    /* eslint-disable-next-line react/no-array-index-key */
                    <div key={i} className={styles.node}>
                        <code className={styles.nodeHtml}>{node.html}</code>
                        {node.failureSummary && (
                            <p className={styles.failure}>{node.failureSummary}</p>
                        )}
                        <button
                            type="button"
                            className={styles.smallButton}
                            onClick={() => onHighlight(node.target)}
                        >
                            {t('a11y.highlight')}
                        </button>
                    </div>
                ))}
                {rule.totalNodes > rule.nodes.length && (
                    <p className={styles.note}>
                        {t('a11y.moreElements', {count: rule.totalNodes - rule.nodes.length})}
                    </p>
                )}
            </div>
        </details>
    );
}

RuleDetails.propTypes = {
    rule: PropTypes.object.isRequired,
    chip: PropTypes.node.isRequired,
    onHighlight: PropTypes.func.isRequired
};

export function AccessibilityTab({result, onHighlight, assist}) {
    const {t} = useTranslation('page-audit');

    return (
        <div>
            <div className={styles.cards}>
                {LEVELS.map(level => {
                    const s = result.summary[level];
                    const ok = s.violations === 0;
                    return (
                        <div key={level} className={`${styles.card} ${ok ? styles.cardGood : styles.cardBad}`}>
                            <span className={styles.cardTitle}>{t(`a11y.levels.${level}`)}</span>
                            <span className={styles.cardValue}>{s.violations}</span>
                            <span className={styles.cardHint}>
                                {t('a11y.passes', {count: s.passes})}
                                {s.incomplete > 0 ? ` · ${t('a11y.incomplete', {count: s.incomplete})}` : ''}
                            </span>
                        </div>
                    );
                })}
            </div>

            <p className={styles.note}>
                {t('a11y.machineNote')}
                <br/>
                {t('a11y.engineInfo', {engine: result.engine, rules: result.rulesRun, passes: result.passCount})}
            </p>

            {result.violations.length === 0 && (
                <div className={styles.allGood}>{t('a11y.noViolations')}</div>
            )}

            {result.violations.map(v => (
                <RuleDetails
                    key={v.id}
                    rule={v}
                    chip={
                        <span className={`${styles.impact} ${styles[`impact_${v.impact}`]}`}>
                            {t(`a11y.impacts.${v.impact}`)}
                        </span>
                    }
                    onHighlight={onHighlight}
                />
            ))}

            <AltAssist {...assist}/>

            {result.incomplete.length > 0 && (
                <>
                    <h4 className={styles.sectionTitle}>{t('a11y.incompleteTitle')}</h4>
                    <p className={styles.note}>{t('a11y.incompleteNote')}</p>
                    {result.incomplete.map(rule => (
                        <RuleDetails
                            key={rule.id}
                            rule={rule}
                            chip={
                                <span className={`${styles.impact} ${styles.impact_review}`}>
                                    {t('a11y.needsReview')}
                                </span>
                            }
                            onHighlight={onHighlight}
                        />
                    ))}
                </>
            )}

            <h4 className={styles.sectionTitle}>{t('a11y.checklist.title')}</h4>
            <p className={styles.note}>{t('a11y.checklist.intro')}</p>
            {MANUAL_CHECKLIST.map(group => (
                <details key={group.level} className={styles.violation}>
                    <summary className={styles.violationSummary}>
                        <span className={styles.levelChip}>{group.level}</span>
                        <span className={styles.violationHelp}>{t(`a11y.levels.${group.level}`)}</span>
                        <span className={styles.nodeCount}>{group.items.length}</span>
                    </summary>
                    <div className={styles.violationBody}>
                        {group.items.map(key => (
                            <div key={key} className={styles.node}>
                                <div className={styles.recTitle}>{t(`a11y.checklist.items.${key}.title`)}</div>
                                <div className={styles.recDetail}>{t(`a11y.checklist.items.${key}.detail`)}</div>
                            </div>
                        ))}
                    </div>
                </details>
            ))}
        </div>
    );
}

AccessibilityTab.propTypes = {
    result: PropTypes.object.isRequired,
    onHighlight: PropTypes.func.isRequired,
    // Props forwarded to <AltAssist/> (AI status, suggestions, phase, callbacks)
    assist: PropTypes.object.isRequired
};
