'use client';

import { Alert, Input, Select, Spin, Tag } from 'antd';
import { BarChart3, Trophy } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Flexbox, Icon } from '@lobehub/ui';

import NavHeader from '@/features/NavHeader';

import { styles } from './style';

type LocalizedText = string | Record<string, string>;

interface Score {
  key: string;
  label?: LocalizedText;
  value?: number | string | null;
}

interface Dimension {
  average?: number | string | null;
  key: string;
  label?: LocalizedText;
  scores?: Score[];
}

interface Source {
  count?: number;
  id?: string;
  name?: LocalizedText;
  status?: string;
  url?: string;
  version?: string;
}

interface LeaderboardItem {
  aliases?: string[];
  chat_or_base?: string;
  dimensions?: Dimension[];
  model: string;
  modelnet_ids?: string[];
  modelnet_matched?: boolean;
  modelnet_model_names?: string[];
  org?: string;
  rank?: number | string | null;
  scores?: Score[];
  source?: Source;
  time?: string;
  update_time?: string;
}

interface LeaderboardPayload {
  errors?: { error?: string; source?: string }[];
  generated_at?: string;
  items?: LeaderboardItem[];
  modelnet_summary?: {
    chat_model_count?: number;
    matched_modelnet_count?: number;
    unmatched_modelnet_count?: number;
  };
  source?: {
    name?: LocalizedText;
    sources?: Source[];
  };
}

type MatchFilter = 'all' | 'external' | 'modelnet';
type SortKey = 'average' | 'model' | 'rank' | 'updated';

const API_URL = '/api/modelnet/leaderboard';
const MAX_ROWS = 600;

const textValue = (value: unknown) => {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
};

const numericValue = (value: unknown) => {
  const number = Number(String(value ?? '').replace('%', ''));
  return Number.isFinite(number) ? number : undefined;
};

const numberText = (value: unknown) => {
  const number = numericValue(value);
  if (number === undefined) return '-';
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
};

const dateScore = (value: unknown) => {
  const parts = String(value || '').match(/\d+/g) || [];
  if (parts.length >= 3) return Number(`${parts[0]}${parts[1].padStart(2, '0')}${parts[2].padStart(2, '0')}`);
  if (parts.length >= 2) return Number(`${parts[0]}${parts[1].padStart(2, '0')}00`);
  return 0;
};

const sourceId = (item: LeaderboardItem) => item.source?.id || textValue(item.source?.name);

const scoreByKey = (item: LeaderboardItem, key: string) =>
  item.scores?.find((score) => score.key.toLowerCase() === key.toLowerCase())?.value;

const averageScore = (item: LeaderboardItem) => {
  const direct = numericValue(scoreByKey(item, 'Average'));
  if (direct !== undefined) return direct;

  const values = (item.dimensions || [])
    .map((dimension) => numericValue(dimension.average))
    .filter((value): value is number => value !== undefined);

  if (!values.length) return Number.NEGATIVE_INFINITY;

  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const searchText = (item: LeaderboardItem) =>
  [
    item.model,
    item.org,
    item.chat_or_base,
    item.source?.id,
    item.source?.name,
    ...(item.aliases || []),
    ...(item.modelnet_ids || []),
    ...(item.modelnet_model_names || []),
  ]
    .map((value) => (typeof value === 'object' ? Object.values(value).join(' ') : textValue(value)))
    .join(' ')
    .toLowerCase();

const LeaderboardPage = memo(() => {
  const { i18n, t } = useTranslation(['modelnet', 'common']);
  const [payload, setPayload] = useState<LeaderboardPayload>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState('all');
  const [match, setMatch] = useState<MatchFilter>('all');
  const [sort, setSort] = useState<SortKey>('average');

  const locale = i18n.language?.startsWith('zh') ? 'zh-CN' : 'en-US';
  const items = payload?.items || [];
  const sources = payload?.source?.sources || [];

  const localize = (value?: LocalizedText) => {
    if (!value) return '-';
    if (typeof value === 'string') return value;

    return value[locale] || value['en-US'] || value['zh-CN'] || Object.values(value)[0] || '-';
  };

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      setError(undefined);

      try {
        const response = await fetch(API_URL, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        setPayload((await response.json()) as LeaderboardPayload);
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;

        setError(err instanceof Error ? err.message : t('status.loadFailed'));
      } finally {
        setLoading(false);
      }
    };

    void load();

    return () => controller.abort();
  }, [t]);

  const visibleItems = useMemo(() => {
    const lowerQuery = query.trim().toLowerCase();

    return items
      .filter((item) => {
        if (lowerQuery && !searchText(item).includes(lowerQuery)) return false;
        if (source !== 'all' && sourceId(item) !== source) return false;
        if (match === 'modelnet' && item.modelnet_matched !== true) return false;
        if (match === 'external' && item.modelnet_matched === true) return false;

        return true;
      })
      .sort((a, b) => {
        if (sort === 'model') return a.model.localeCompare(b.model);
        if (sort === 'rank') return (numericValue(a.rank) || 1_000_000) - (numericValue(b.rank) || 1_000_000);
        if (sort === 'updated') {
          return dateScore(b.update_time || b.source?.version) - dateScore(a.update_time || a.source?.version);
        }

        return averageScore(b) - averageScore(a);
      });
  }, [items, match, query, sort, source]);

  const sourceOptions = [
    { label: t('filters.allSources'), value: 'all' },
    ...sources.map((item) => ({
      label: `${localize(item.name)}${item.count === undefined ? '' : ` (${item.count})`}`,
      value: item.id || localize(item.name),
    })),
  ];

  const matchedCount =
    payload?.modelnet_summary?.matched_modelnet_count ??
    items.filter((item) => item.modelnet_matched).length;

  const metrics = [
    {
      label: t('metrics.models'),
      subtext: t('metrics.modelsSubtext'),
      value: items.length,
    },
    {
      label: t('metrics.modelnet'),
      subtext: t('metrics.modelnetSubtext'),
      value: matchedCount,
    },
    {
      label: t('metrics.visible'),
      subtext: t('metrics.visibleSubtext'),
      value: visibleItems.length,
    },
    {
      label: t('metrics.updated'),
      subtext: `${t('metrics.generated')} ${textValue(payload?.generated_at).replace('T', ' ').slice(0, 19)}`,
      value: textValue(payload?.generated_at).slice(0, 10),
    },
  ];

  const statusText = payload?.errors?.length
    ? t('status.withErrors', { count: payload.errors.length, visible: visibleItems.length, total: items.length })
    : t('status.ready', { visible: visibleItems.length, total: items.length });

  return (
    <Flexbox className={styles.page}>
      <NavHeader
        left={
          <div className={styles.headerTitle}>
            <Icon icon={Trophy} />
            {t('title')}
          </div>
        }
      />
      <Flexbox className={styles.content} gap={16}>
        <Flexbox gap={6}>
          <div className={styles.muted}>{t('subtitle')}</div>
        </Flexbox>

        <div className={styles.summaryGrid}>
          {metrics.map((metric) => (
            <div className={styles.metric} key={metric.label}>
              <div className={styles.metricLabel}>{metric.label}</div>
              <div className={styles.metricValue}>{metric.value}</div>
              <div className={styles.metricSubtext}>{metric.subtext}</div>
            </div>
          ))}
        </div>

        <div className={styles.toolbar}>
          <Input.Search
            allowClear
            placeholder={t('filters.searchPlaceholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select options={sourceOptions} value={source} onChange={setSource} />
          <Select
            options={[
              { label: t('filters.allModels'), value: 'all' },
              { label: t('filters.modelnetOnly'), value: 'modelnet' },
              { label: t('filters.externalOnly'), value: 'external' },
            ]}
            value={match}
            onChange={(value) => setMatch(value as MatchFilter)}
          />
          <Select
            options={[
              { label: t('sort.average'), value: 'average' },
              { label: t('sort.rank'), value: 'rank' },
              { label: t('sort.model'), value: 'model' },
              { label: t('sort.updated'), value: 'updated' },
            ]}
            value={sort}
            onChange={(value) => setSort(value as SortKey)}
          />
        </div>

        {error && <Alert message={t('status.loadFailed')} showIcon type="error" description={error} />}
        {!error && payload?.errors?.length ? (
          <Alert message={statusText} showIcon type="warning" />
        ) : (
          <Alert icon={<Icon icon={BarChart3} />} message={statusText} showIcon type="info" />
        )}

        <Spin spinning={loading}>
          <div className={styles.panel}>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th style={{ width: 70 }}>{t('table.rank')}</th>
                    <th style={{ width: '30%' }}>{t('table.model')}</th>
                    <th style={{ width: 120 }}>{t('table.average')}</th>
                    <th style={{ width: '30%' }}>{t('table.capabilities')}</th>
                    <th style={{ width: '18%' }}>{t('table.modelnet')}</th>
                    <th style={{ width: 150 }}>{t('table.source')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.length === 0 ? (
                    <tr>
                      <td className={styles.empty} colSpan={6}>
                        {loading ? t('status.loading') : t('status.empty')}
                      </td>
                    </tr>
                  ) : (
                    visibleItems.slice(0, MAX_ROWS).map((item, index) => {
                      const dimensions = (item.dimensions || []).slice(0, 7);
                      const rank = numericValue(item.rank) ?? index + 1;

                      return (
                        <tr key={`${sourceId(item)}-${item.model}-${index}`}>
                          <td>{rank}</td>
                          <td>
                            <div className={styles.modelName}>{item.model}</div>
                            <div className={styles.muted}>{textValue(item.org)}</div>
                          </td>
                          <td>
                            <span className={styles.score}>{numberText(averageScore(item))}</span>
                          </td>
                          <td className={styles.capabilityCell}>
                            <Flexbox horizontal gap={6} style={{ flexWrap: 'wrap' }}>
                              {dimensions.length ? (
                                dimensions.map((dimension) => (
                                  <Tag key={dimension.key}>
                                    {localize(dimension.label || dimension.key)} {numberText(dimension.average)}
                                  </Tag>
                                ))
                              ) : (
                                <span className={styles.muted}>-</span>
                              )}
                            </Flexbox>
                          </td>
                          <td>
                            {item.modelnet_matched ? (
                              <Flexbox horizontal gap={6} style={{ flexWrap: 'wrap' }}>
                                <Tag color="success">{t('table.modelnetMatched')}</Tag>
                                {(item.modelnet_ids || []).slice(0, 2).map((id) => (
                                  <Tag key={id}>{id}</Tag>
                                ))}
                              </Flexbox>
                            ) : (
                              <Tag>{t('table.notConnected')}</Tag>
                            )}
                          </td>
                          <td>
                            <div>{localize(item.source?.name)}</div>
                            <div className={styles.muted}>{textValue(item.update_time || item.time)}</div>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </Spin>
      </Flexbox>
    </Flexbox>
  );
});

LeaderboardPage.displayName = 'LeaderboardPage';

export default LeaderboardPage;
