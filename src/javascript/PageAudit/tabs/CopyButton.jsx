import React, {useEffect, useRef, useState} from 'react';
import PropTypes from 'prop-types';
import {useTranslation} from 'react-i18next';
import styles from './Tabs.module.css';

/** Copies a suggestion to the clipboard and confirms briefly - the "display + copy" half of AI assist. */
export function CopyButton({text}) {
    const {t} = useTranslation('page-audit');
    const [copied, setCopied] = useState(false);
    const timerRef = useRef(null);

    useEffect(() => () => clearTimeout(timerRef.current), []);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            // Clipboard API unavailable (insecure context): legacy fallback
            const area = document.createElement('textarea');
            area.value = text;
            document.body.appendChild(area);
            area.select();
            document.execCommand('copy');
            area.remove();
        }

        setCopied(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1500);
    };

    return (
        <button type="button" className={styles.smallButton} onClick={copy}>
            {copied ? t('copy.done') : t('copy.action')}
        </button>
    );
}

CopyButton.propTypes = {
    text: PropTypes.string.isRequired
};
