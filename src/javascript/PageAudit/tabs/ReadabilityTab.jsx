import React from 'react';
import PropTypes from 'prop-types';
import {useTranslation} from 'react-i18next';
import {Recommendations} from './Recommendations';
import {SimplifyAssist} from './SimplifyAssist';
import styles from './Tabs.module.css';

export function ReadabilityTab({result, assist}) {
    const {t} = useTranslation('page-audit');

    if (result.empty) {
        return <p className={styles.note}>{t('readability.noText', {count: result.words})}</p>;
    }

    const scoreBandClass = result.score >= 50 ?
        styles.cardGood :
        (result.score >= 30 ? styles.band_ni : styles.cardBad);

    return (
        <div>
            <div className={styles.cards}>
                <div className={`${styles.card} ${scoreBandClass}`}>
                    <span className={styles.cardTitle}>
                        {t('readability.score')} ({result.formula})
                    </span>
                    <span className={styles.cardValue}>{result.score}</span>
                    <span className={styles.cardHint}>{t(`readability.bands.${result.band}`)}</span>
                </div>
                {result.gradeLevel !== null && (
                    <div className={styles.card}>
                        <span className={styles.cardTitle}>{t('readability.gradeLevel')}</span>
                        <span className={styles.cardValue}>{result.gradeLevel}</span>
                        <span className={styles.cardHint}>Flesch-Kincaid</span>
                    </div>
                )}
                <div className={styles.card}>
                    <span className={styles.cardTitle}>{t('readability.readingTime')}</span>
                    <span className={styles.cardValue}>{result.readingMinutes}</span>
                    <span className={styles.cardHint}>{t('readability.minutes')}</span>
                </div>
            </div>

            <Recommendations items={result.recommendations} ns="readability"/>

            <SimplifyAssist {...assist}/>

            <h4 className={styles.sectionTitle}>{t('readability.textStats')}</h4>
            <ul className={styles.statList}>
                <li>{t('readability.words')}: <strong>{result.words}</strong></li>
                <li>{t('readability.sentences')}: <strong>{result.sentences}</strong></li>
                <li>{t('readability.avgSentenceLength')}: <strong>{result.avgSentenceLength}</strong></li>
                <li>{t('readability.longSentences')}: <strong>{result.longSentences}</strong></li>
                <li>{t('readability.paragraphs')}: <strong>{result.paragraphs}</strong>
                    {' '}({t('readability.avgWordsPerParagraph')}: {result.avgWordsPerParagraph})
                </li>
            </ul>

            <h4 className={styles.sectionTitle}>{t('readability.structure')}</h4>
            <ul className={styles.statList}>
                <li>{t('readability.h1Count')}: <strong>{result.h1Count}</strong></li>
                <li>{t('readability.headingSkips')}: <strong>{result.headingSkips}</strong></li>
            </ul>
        </div>
    );
}

ReadabilityTab.propTypes = {
    result: PropTypes.object.isRequired,
    // Props forwarded to <SimplifyAssist/> (AI status, rewrites, phase, callbacks)
    assist: PropTypes.object.isRequired
};
