import React from 'react';
import PropTypes from 'prop-types';
import {useTranslation} from 'react-i18next';
import {Recommendations} from './Recommendations';
import {SeoAssist} from './SeoAssist';
import styles from './Tabs.module.css';

export function SeoTab({result, assist}) {
    const {t} = useTranslation('page-audit');

    const rows = [
        {key: 'title', ok: Boolean(result.title.text), value: result.title.text ? `${result.title.text} (${t('seo.chars', {count: result.title.length})})` : null},
        {key: 'description', ok: Boolean(result.description.text), value: result.description.text ? `${result.description.text} (${t('seo.chars', {count: result.description.length})})` : null},
        {key: 'canonical', ok: Boolean(result.canonical), value: result.canonical},
        {key: 'robots', ok: !result.robots.noindex, value: result.robots.content || t('seo.defaultIndexable')},
        {key: 'ogTitle', ok: Boolean(result.og.title), value: result.og.title},
        {key: 'ogDescription', ok: Boolean(result.og.description), value: result.og.description},
        {key: 'ogImage', ok: Boolean(result.og.image), value: result.og.image},
        {key: 'twitterCard', ok: Boolean(result.twitterCard), value: result.twitterCard},
        {key: 'jsonLd', ok: result.jsonLd.count > 0 && result.jsonLd.errors === 0, value: t('seo.jsonLdValue', {count: result.jsonLd.count, errors: result.jsonLd.errors})},
        {key: 'lang', ok: Boolean(result.lang.htmlLang) && (!result.lang.expected || result.lang.htmlLang.startsWith(result.lang.expected)), value: result.lang.htmlLang},
        {key: 'hreflang', ok: result.hreflang > 0, value: t('seo.hreflangValue', {count: result.hreflang})},
        {key: 'imageAlt', ok: result.imagesWithoutAlt === 0, value: t('seo.imageAltValue', {missing: result.imagesWithoutAlt, total: result.totalImages})}
    ];

    return (
        <div>
            <Recommendations items={result.recommendations} ns="seo"/>

            <SeoAssist {...assist}/>

            <h4 className={styles.sectionTitle}>{t('seo.preview')}</h4>
            {(result.og.title || result.title.text) ? (
                <div className={styles.previewCard}>
                    {result.ogImageResolved ?
                        <img alt="" src={result.ogImageResolved} className={styles.previewImage}/> :
                        <div className={styles.previewImageMissing}>{t('seo.noOgImage')}</div>}
                    <div className={styles.previewBody}>
                        <div className={styles.previewTitle}>{result.og.title || result.title.text}</div>
                        <div className={styles.previewDesc}>
                            {result.og.description || result.description.text || ''}
                        </div>
                    </div>
                </div>
            ) : (
                <p className={styles.note}>{t('seo.noPreview')}</p>
            )}

            <h4 className={styles.sectionTitle}>{t('seo.tags')}</h4>
            <ul className={styles.statList}>
                {rows.map(row => (
                    <li key={row.key}>
                        <span className={row.ok ? styles.okMark : styles.koMark}>{row.ok ? '✓' : '✗'}</span>
                        {' '}{t(`seo.fields.${row.key}`)}:{' '}
                        {row.value ?
                            <strong className={styles.tagValue}>{row.value}</strong> :
                            <span className={styles.warn}>{t('seo.missing')}</span>}
                    </li>
                ))}
            </ul>
        </div>
    );
}

SeoTab.propTypes = {
    result: PropTypes.object.isRequired,
    // Props forwarded to <SeoAssist/> (AI status, suggestions, phase, callbacks)
    assist: PropTypes.object.isRequired
};
