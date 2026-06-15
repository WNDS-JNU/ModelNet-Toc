'use client';

import { BRANDING_NAME } from '@lobechat/business-const';
import { Flexbox, Form } from '@lobehub/ui';
import { Divider } from 'antd';
import { createStaticStyles } from 'antd-style';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { OFFICIAL_SITE, PRIVACY_URL, TERMS_URL } from '@/const/url';

import AboutList from './AboutList';
import ItemCard from './ItemCard';
import ItemLink from './ItemLink';
import Version from './Version';

const styles = createStaticStyles(({ css, cssVar }) => ({
  title: css`
    font-size: 14px;
    font-weight: bold;
    color: ${cssVar.colorTextSecondary};
  `,
}));

const About = memo<{ mobile?: boolean }>(({ mobile }) => {
  const { t } = useTranslation('common');

  return (
    <Form.Group
      collapsible={false}
      gap={16}
      style={{ maxWidth: '1024px', width: '100%' }}
      title={`${t('about')} ${BRANDING_NAME}`}
      variant={'filled'}
    >
      <Flexbox gap={20} paddingBlock={20} width={'100%'}>
        <div className={styles.title}>{t('version')}</div>
        <Version mobile={mobile} />
        <Divider style={{ marginBlock: 0 }} />
        <div className={styles.title}>{t('contact')}</div>
        <AboutList
          ItemRender={ItemLink}
          items={[
            {
              href: OFFICIAL_SITE,
              label: t('officialSite'),
              value: 'officialSite',
            },
            {
              href: 'https://english.jnu.edu.cn',
              label: 'Jinan University',
              value: 'jnuEnglish',
            },
            {
              href: 'https://info.jnu.edu.cn',
              label: 'JNU Portal',
              value: 'jnuPortal',
            },
          ]}
        />
        <Divider style={{ marginBlock: 0 }} />
        <div className={styles.title}>{t('information')}</div>
        <AboutList
          grid
          ItemRender={ItemCard}
          items={[
            {
              href: 'https://www.jnu.edu.cn/2567/list.htm',
              label: '暨南文化',
              value: 'culture',
            },
            {
              href: 'https://www.jnu.edu.cn/36429/list.htm',
              label: '校园风光',
              value: 'campus',
            },
            {
              href: 'https://news.jnu.edu.cn',
              label: '暨南大学新闻网',
              value: 'news',
            },
          ]}
        />
        <Divider style={{ marginBlock: 0 }} />
        <div className={styles.title}>{t('legal')}</div>
        <AboutList
          ItemRender={ItemLink}
          items={[
            {
              href: TERMS_URL,
              label: t('terms'),
              value: 'terms',
            },
            {
              href: PRIVACY_URL,
              label: t('privacy'),
              value: 'privacy',
            },
          ]}
        />
      </Flexbox>
    </Form.Group>
  );
});

export default About;
