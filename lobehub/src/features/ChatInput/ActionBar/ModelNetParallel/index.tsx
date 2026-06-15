'use client';

import { Flexbox, Icon, Popover, SearchBar } from '@lobehub/ui';
import { Button, message } from 'antd';
import { createStaticStyles, cx } from 'antd-style';
import { CheckIcon, NetworkIcon } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import {
  getModelNetParallelCandidates,
  isModelNetParallelModel,
  MAX_MODELNET_PARALLEL_MODELS,
  MIN_MODELNET_PARALLEL_MODELS,
  normalizeModelNetParallelModelIds,
} from '@/features/ModelNetParallel';
import { useEnabledChatModels } from '@/hooks/useEnabledChatModels';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';

import { useAgentId } from '../../hooks/useAgentId';

const PARALLEL_LABEL = '\u5e76\u8054';
const SELECT_PARALLEL_MODELS_LABEL = '\u9009\u62e9\u5e76\u8054\u6a21\u578b';
const PANEL_SUBTITLE_LABEL =
  `\u9009\u62e9 ${MIN_MODELNET_PARALLEL_MODELS}-${MAX_MODELNET_PARALLEL_MODELS} ` +
  '\u4e2a\u6a21\u578b\u53c2\u4e0e\u540c\u4e00\u6b21\u54cd\u5e94';
const SEARCH_PLACEHOLDER_LABEL = '\u641c\u7d22\u6a21\u578b';
const SELECTED_LABEL = '\u5df2\u9009';
const MAX_REACHED_LABEL = '\u5df2\u8fbe\u5230\u4e0a\u9650';
const EMPTY_LABEL = '\u6ca1\u6709\u5339\u914d\u7684\u6a21\u578b';
const CANCEL_LABEL = '\u53d6\u6d88';
const SAVE_LABEL = '\u4fdd\u5b58';

const styles = createStaticStyles(({ css, cssVar }) => ({
  checkmark: css`
    display: flex;
    flex: none;
    align-items: center;
    justify-content: center;

    width: 18px;
    height: 18px;
    border: 1px solid ${cssVar.colorBorder};
    border-radius: 50%;

    color: ${cssVar.colorBgContainer};

    background: ${cssVar.colorBgContainer};
  `,
  checkmarkActive: css`
    border-color: ${cssVar.colorPrimary};
    color: ${cssVar.colorWhite};
    background: ${cssVar.colorPrimary};
  `,
  count: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  empty: css`
    padding: 18px 12px;
    border: 1px dashed ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
    text-align: center;

    background: ${cssVar.colorFillQuaternary};
  `,
  footer: css`
    border-top: 1px solid ${cssVar.colorBorderSecondary};
    padding-block-start: 12px;
  `,
  header: css`
    padding: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorFillQuaternary};
  `,
  headerIcon: css`
    flex: none;

    width: 36px;
    height: 36px;
    border: 1px solid ${cssVar.colorPrimaryBorder};
    border-radius: 8px;

    color: ${cssVar.colorPrimary};

    background: ${cssVar.colorPrimaryBg};
  `,
  hint: css`
    font-size: 12px;
    color: ${cssVar.colorTextTertiary};
  `,
  hintInvalid: css`
    color: ${cssVar.colorError};
  `,
  invalid: css`
    border-color: ${cssVar.colorError};
    color: ${cssVar.colorError};
    background: ${cssVar.colorErrorBg};
  `,
  list: css`
    overflow-y: auto;

    max-height: 320px;
    padding-inline-end: 2px;
  `,
  modelId: css`
    overflow: hidden;

    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    font-size: 11px;
    color: ${cssVar.colorTextQuaternary};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  modelName: css`
    overflow: hidden;

    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
  option: css`
    cursor: pointer;

    display: flex;
    align-items: center;
    gap: 10px;

    width: 100%;
    min-height: 48px;
    padding: 8px 10px;
    border: 1px solid transparent;
    border-radius: 8px;

    text-align: start;

    background: transparent;

    transition:
      border-color 0.2s,
      background 0.2s,
      box-shadow 0.2s;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  optionActive: css`
    border-color: ${cssVar.colorPrimaryBorder};
    background: ${cssVar.colorPrimaryBg};
    box-shadow: inset 0 0 0 1px ${cssVar.colorPrimaryBorder};
  `,
  optionBlocked: css`
    cursor: not-allowed;
    opacity: 0.58;
  `,
  panel: css`
    width: 380px;
    max-width: calc(100vw - 32px);
  `,
  search: css`
    padding-inline: 4px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgContainer};
  `,
  status: css`
    flex: none;

    padding: 3px 8px;
    border: 1px solid ${cssVar.colorPrimaryBorder};
    border-radius: 999px;

    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorPrimary};

    background: ${cssVar.colorPrimaryBg};
  `,
  title: css`
    font-size: 14px;
    font-weight: 600;
    color: ${cssVar.colorText};
  `,
  trigger: css`
    cursor: pointer;

    display: flex;
    align-items: center;
    gap: 6px;

    height: 28px;
    padding: 0 8px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};

    background: transparent;

    &:hover {
      background: ${cssVar.colorFillTertiary};
    }
  `,
  triggerBadge: css`
    display: inline-flex;
    align-items: center;
    justify-content: center;

    min-width: 18px;
    height: 18px;
    padding-inline: 5px;
    border-radius: 999px;

    color: ${cssVar.colorPrimary};

    background: ${cssVar.colorPrimaryBg};
  `,
}));

const ModelNetParallel = memo(() => {
  const agentId = useAgentId();
  const enabledList = useEnabledChatModels();
  const [model, provider, agentParams, isLoading, updateAgentConfigById] = useAgentStore((s) => [
    agentByIdSelectors.getAgentModelById(agentId)(s),
    agentByIdSelectors.getAgentModelProviderById(agentId)(s),
    agentByIdSelectors.getAgentConfigById(agentId)(s)?.params,
    agentByIdSelectors.isAgentConfigLoadingById(agentId)(s),
    s.updateAgentConfigById,
  ]);
  const candidates = useMemo(
    () => getModelNetParallelCandidates(enabledList, provider),
    [enabledList, provider],
  );

  const [open, setOpen] = useState(false);

  const selectedIds = useMemo(() => {
    if (candidates.length < MIN_MODELNET_PARALLEL_MODELS) return [];

    return normalizeModelNetParallelModelIds(agentParams?.modelnetParallelModelIds, candidates);
  }, [agentParams?.modelnetParallelModelIds, candidates]);

  const [draftIds, setDraftIds] = useState<string[]>(selectedIds);
  const [searchKeyword, setSearchKeyword] = useState('');

  useEffect(() => {
    if (open) {
      setDraftIds(selectedIds);
      setSearchKeyword('');
    }
  }, [open, selectedIds]);

  const filteredCandidates = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    if (!keyword) return candidates;

    return candidates.filter((candidate) => {
      const displayName = candidate.displayName || '';

      return (
        candidate.id.toLowerCase().includes(keyword) ||
        displayName.toLowerCase().includes(keyword)
      );
    });
  }, [candidates, searchKeyword]);

  const draftInvalid =
    draftIds.length < MIN_MODELNET_PARALLEL_MODELS ||
    draftIds.length > MAX_MODELNET_PARALLEL_MODELS;
  const minRemaining = Math.max(MIN_MODELNET_PARALLEL_MODELS - draftIds.length, 0);

  const draftHint = draftInvalid
    ? `\u8fd8\u9700\u8981 ${minRemaining} \u4e2a\u6a21\u578b`
    : draftIds.length >= MAX_MODELNET_PARALLEL_MODELS
      ? MAX_REACHED_LABEL
      : `\u8fd8\u53ef\u9009\u62e9 ${MAX_MODELNET_PARALLEL_MODELS - draftIds.length} \u4e2a`;

  const handleToggle = useCallback((id: string) => {
    setDraftIds((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= MAX_MODELNET_PARALLEL_MODELS) {
        message.error(
          `\u6700\u591a\u9009\u62e9 ${MAX_MODELNET_PARALLEL_MODELS} \u4e2a\u5e76\u8054\u6a21\u578b`,
        );
        return current;
      }

      return [...current, id];
    });
  }, []);

  const handleSave = useCallback(async () => {
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const nextIds = [...new Set(draftIds)].filter((id) => candidateIds.has(id));

    if (
      nextIds.length < MIN_MODELNET_PARALLEL_MODELS ||
      nextIds.length > MAX_MODELNET_PARALLEL_MODELS
    ) {
      message.error(
        `ModelNet \u5e76\u8054\u9700\u8981\u9009\u62e9 ${MIN_MODELNET_PARALLEL_MODELS}-${MAX_MODELNET_PARALLEL_MODELS} \u4e2a\u6a21\u578b`,
      );
      return;
    }

    await updateAgentConfigById(agentId, {
      params: {
        ...agentParams,
        modelnetParallelModelIds: nextIds,
      },
    });
    setOpen(false);
  }, [agentId, agentParams, candidates, draftIds, updateAgentConfigById]);

  if (!isModelNetParallelModel(provider, model)) return null;
  if (isLoading || candidates.length < MIN_MODELNET_PARALLEL_MODELS) return null;

  const invalid =
    selectedIds.length < MIN_MODELNET_PARALLEL_MODELS ||
    selectedIds.length > MAX_MODELNET_PARALLEL_MODELS;

  return (
    <Popover
      content={
        <Flexbox
          className={styles.panel}
          gap={12}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Flexbox horizontal align={'center'} className={styles.header} gap={10}>
            <Flexbox align={'center'} className={styles.headerIcon} justify={'center'}>
              <Icon icon={NetworkIcon} size={18} />
            </Flexbox>
            <Flexbox flex={1} gap={2}>
              <span className={styles.title}>{SELECT_PARALLEL_MODELS_LABEL}</span>
              <span className={styles.hint}>{PANEL_SUBTITLE_LABEL}</span>
            </Flexbox>
            <span className={styles.status}>
              {draftIds.length}/{MAX_MODELNET_PARALLEL_MODELS}
            </span>
          </Flexbox>

          <SearchBar
            allowClear
            className={styles.search}
            placeholder={SEARCH_PLACEHOLDER_LABEL}
            size="small"
            value={searchKeyword}
            variant="borderless"
            onChange={(event) => setSearchKeyword(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />

          <Flexbox className={styles.list} gap={6}>
            {filteredCandidates.length === 0 ? (
              <div className={styles.empty}>{EMPTY_LABEL}</div>
            ) : (
              filteredCandidates.map((candidate) => {
                const checked = draftIds.includes(candidate.id);
                const blocked = !checked && draftIds.length >= MAX_MODELNET_PARALLEL_MODELS;
                const displayName = candidate.displayName || candidate.id;
                const showId = candidate.id !== displayName;

                return (
                  <button
                    aria-pressed={checked}
                    className={cx(
                      styles.option,
                      checked && styles.optionActive,
                      blocked && styles.optionBlocked,
                    )}
                    key={candidate.id}
                    title={candidate.id}
                    type="button"
                    onClick={() => handleToggle(candidate.id)}
                  >
                    <span className={cx(styles.checkmark, checked && styles.checkmarkActive)}>
                      {checked && <Icon icon={CheckIcon} size={12} />}
                    </span>
                    <Flexbox flex={1} gap={2} style={{ minWidth: 0 }}>
                      <span className={styles.modelName}>{displayName}</span>
                      {showId && <span className={styles.modelId}>{candidate.id}</span>}
                    </Flexbox>
                  </button>
                );
              })
            )}
          </Flexbox>

          <Flexbox horizontal align={'center'} className={styles.footer} justify={'space-between'}>
            <Flexbox gap={2}>
              <span className={styles.count}>
                {SELECTED_LABEL} {draftIds.length}/{MAX_MODELNET_PARALLEL_MODELS}
              </span>
              <span className={cx(styles.hint, draftInvalid && styles.hintInvalid)}>
                {draftHint}
              </span>
            </Flexbox>
            <Flexbox horizontal gap={8}>
              <Button size="small" onClick={() => setOpen(false)}>
                {CANCEL_LABEL}
              </Button>
              <Button disabled={draftInvalid} size="small" type="primary" onClick={handleSave}>
                {SAVE_LABEL}
              </Button>
            </Flexbox>
          </Flexbox>
        </Flexbox>
      }
      nativeButton={false}
      open={open}
      placement="top"
      onOpenChange={setOpen}
    >
      <button
        className={cx(styles.trigger, invalid && styles.invalid)}
        title="ModelNet \u5e76\u8054\u6a21\u578b"
        type="button"
      >
        <Icon icon={NetworkIcon} size={14} />
        <span>{PARALLEL_LABEL}</span>
        <span className={styles.triggerBadge}>{selectedIds.length}</span>
      </button>
    </Popover>
  );
});

ModelNetParallel.displayName = 'ModelNetParallel';

export default ModelNetParallel;
