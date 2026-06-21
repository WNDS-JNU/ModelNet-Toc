'use client';

import { Flexbox, Icon, Popover, SearchBar } from '@lobehub/ui';
import { Button, message } from 'antd';
import { createStaticStyles, cx } from 'antd-style';
import { ArrowDownIcon, ArrowUpIcon, LinkIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import {
  getModelNetParallelCandidates,
  isModelNetSerialModel,
  MIN_MODELNET_SERIAL_MODELS,
  modelIdsToModelNetSerialTopology,
  type ModelNetSerialTopology,
  normalizeModelNetSerialTopology,
} from '@/features/ModelNetParallel';
import { useEnabledChatModels } from '@/hooks/useEnabledChatModels';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';

import { useAgentId } from '../../hooks/useAgentId';

const SERIAL_LABEL = '\u4E32\u8054';
const SELECT_SERIAL_MODELS_LABEL = '\u9009\u62E9\u4E32\u8054\u6A21\u578B';
const SEARCH_PLACEHOLDER_LABEL = '\u641C\u7D22\u6A21\u578B';
const CHAIN_LABEL = '\u4E32\u8054\u94FE\u8DEF';
const AVAILABLE_LABEL = '\u53EF\u6DFB\u52A0\u6A21\u578B';
const MAX_REACHED_LABEL = '\u5DF2\u8FBE\u5230\u4E0A\u9650';
const EMPTY_LABEL = '\u6CA1\u6709\u53EF\u6DFB\u52A0\u7684\u6A21\u578B';
const CANCEL_LABEL = '\u53D6\u6D88';
const SAVE_LABEL = '\u4FDD\u5B58';

const styles = createStaticStyles(({ css, cssVar }) => ({
  addButton: css`
    flex: none;
  `,
  availableHeader: css`
    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};
  `,
  chainPreview: css`
    overflow: hidden;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    font-family:
      ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    font-size: 11px;
    color: ${cssVar.colorTextSecondary};
    text-overflow: ellipsis;
    white-space: nowrap;

    background: ${cssVar.colorFillQuaternary};
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

    max-height: 220px;
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
    display: flex;
    align-items: center;
    gap: 8px;

    width: 100%;
    min-height: 46px;
    padding: 8px 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    background: ${cssVar.colorBgContainer};
  `,
  panel: css`
    width: 420px;
    max-width: calc(100vw - 32px);
  `,
  rowActions: css`
    flex: none;
  `,
  search: css`
    padding-inline: 4px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
    background: ${cssVar.colorBgContainer};
  `,
  stepBadge: css`
    display: inline-flex;
    flex: none;
    align-items: center;
    justify-content: center;

    min-width: 48px;
    height: 24px;
    border: 1px solid ${cssVar.colorPrimaryBorder};
    border-radius: 999px;

    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorPrimary};

    background: ${cssVar.colorPrimaryBg};
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

const moveItem = (items: string[], index: number, direction: -1 | 1) => {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= items.length) return items;
  const next = [...items];
  const current = next[index];
  const target = next[nextIndex];
  if (!current || !target) return items;
  next[index] = target;
  next[nextIndex] = current;
  return next;
};

const ModelNetSerial = memo(() => {
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
  const modelMap = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.id, candidate])),
    [candidates],
  );

  const [open, setOpen] = useState(false);

  const selectedTopology = useMemo(() => {
    if (candidates.length < MIN_MODELNET_SERIAL_MODELS) return undefined;

    return normalizeModelNetSerialTopology(
      agentParams?.modelnetSerialTopology as ModelNetSerialTopology | undefined,
      candidates,
    );
  }, [agentParams?.modelnetSerialTopology, candidates]);

  const selectedIds = useMemo(
    () => selectedTopology?.nodes.map((node) => node.modelId) ?? [],
    [selectedTopology],
  );

  const [draftIds, setDraftIds] = useState<string[]>(selectedIds);
  const [searchKeyword, setSearchKeyword] = useState('');

  useEffect(() => {
    if (open) {
      setDraftIds(selectedIds);
      setSearchKeyword('');
    }
  }, [open, selectedIds]);

  const filteredCandidates = useMemo(() => {
    const selected = new Set(draftIds);
    const keyword = searchKeyword.trim().toLowerCase();

    return candidates.filter((candidate) => {
      if (selected.has(candidate.id)) return false;
      if (!keyword) return true;
      const displayName = candidate.displayName || '';

      return (
        candidate.id.toLowerCase().includes(keyword) || displayName.toLowerCase().includes(keyword)
      );
    });
  }, [candidates, draftIds, searchKeyword]);

  const maxSelectableModels = candidates.length;
  const panelSubtitleLabel =
    `\u9009\u62E9 ${MIN_MODELNET_SERIAL_MODELS}-${maxSelectableModels} ` +
    '\u4E2A\u6A21\u578B\uFF0C\u6309\u987A\u5E8F\u4F9D\u6B21 review/refine';

  const draftInvalid =
    draftIds.length < MIN_MODELNET_SERIAL_MODELS || draftIds.length > maxSelectableModels;
  const minRemaining = Math.max(MIN_MODELNET_SERIAL_MODELS - draftIds.length, 0);
  const draftHint =
    draftIds.length < MIN_MODELNET_SERIAL_MODELS
      ? `\u8FD8\u9700\u8981 ${minRemaining} \u4E2A\u6A21\u578B`
      : draftIds.length > maxSelectableModels
        ? `\u6700\u591A\u9009\u62E9 ${maxSelectableModels} \u4E2A\u6A21\u578B`
        : draftIds.length >= maxSelectableModels
          ? MAX_REACHED_LABEL
          : `\u8FD8\u53EF\u6DFB\u52A0 ${maxSelectableModels - draftIds.length} \u4E2A`;
  const chainPreview = draftIds.map((_, index) => `step-${index + 1}`).join(' \u2192 ');

  const handleAdd = useCallback(
    (id: string) => {
      setDraftIds((current) => {
        if (current.includes(id)) return current;
        if (current.length >= maxSelectableModels) {
          message.error(
            `\u6700\u591A\u9009\u62E9 ${maxSelectableModels} \u4E2A\u4E32\u8054\u6A21\u578B`,
          );
          return current;
        }

        return [...current, id];
      });
    },
    [maxSelectableModels],
  );

  const handleSave = useCallback(async () => {
    const candidateIds = new Set(candidates.map((candidate) => candidate.id));
    const nextIds = [...new Set(draftIds)].filter((id) => candidateIds.has(id));

    if (nextIds.length < MIN_MODELNET_SERIAL_MODELS || nextIds.length > maxSelectableModels) {
      message.error(
        `ModelNet \u4E32\u8054\u9700\u8981\u9009\u62E9 ${MIN_MODELNET_SERIAL_MODELS}-${maxSelectableModels} \u4E2A\u6A21\u578B`,
      );
      return;
    }

    await updateAgentConfigById(agentId, {
      params: {
        ...agentParams,
        modelnetSerialTopology: modelIdsToModelNetSerialTopology(nextIds),
      },
    });
    setOpen(false);
  }, [agentId, agentParams, candidates, draftIds, maxSelectableModels, updateAgentConfigById]);

  if (!isModelNetSerialModel(provider, model)) return null;
  if (isLoading || candidates.length < MIN_MODELNET_SERIAL_MODELS || !selectedTopology) return null;

  const invalid =
    selectedIds.length < MIN_MODELNET_SERIAL_MODELS || selectedIds.length > maxSelectableModels;

  return (
    <Popover
      nativeButton={false}
      open={open}
      placement="top"
      content={
        <Flexbox
          className={styles.panel}
          gap={12}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Flexbox horizontal align={'center'} className={styles.header} gap={10}>
            <Flexbox align={'center'} className={styles.headerIcon} justify={'center'}>
              <Icon icon={LinkIcon} size={18} />
            </Flexbox>
            <Flexbox flex={1} gap={2}>
              <span className={styles.title}>{SELECT_SERIAL_MODELS_LABEL}</span>
              <span className={styles.hint}>{panelSubtitleLabel}</span>
            </Flexbox>
            <span className={styles.status}>
              {draftIds.length}/{maxSelectableModels}
            </span>
          </Flexbox>

          <Flexbox gap={6}>
            <span className={styles.availableHeader}>{CHAIN_LABEL}</span>
            <div className={styles.chainPreview}>{chainPreview}</div>
            <Flexbox className={styles.list} gap={6}>
              {draftIds.map((id, index) => {
                const candidate = modelMap.get(id);
                const displayName = candidate?.displayName || id;
                const showId = id !== displayName;

                return (
                  <div className={styles.option} key={id} title={id}>
                    <span className={styles.stepBadge}>step-{index + 1}</span>
                    <Flexbox flex={1} gap={2} style={{ minWidth: 0 }}>
                      <span className={styles.modelName}>{displayName}</span>
                      {showId && <span className={styles.modelId}>{id}</span>}
                    </Flexbox>
                    <Flexbox horizontal className={styles.rowActions} gap={2}>
                      <Button
                        disabled={index === 0}
                        icon={<Icon icon={ArrowUpIcon} size={14} />}
                        size="small"
                        type="text"
                        onClick={() => setDraftIds((current) => moveItem(current, index, -1))}
                      />
                      <Button
                        disabled={index === draftIds.length - 1}
                        icon={<Icon icon={ArrowDownIcon} size={14} />}
                        size="small"
                        type="text"
                        onClick={() => setDraftIds((current) => moveItem(current, index, 1))}
                      />
                      <Button
                        icon={<Icon icon={Trash2Icon} size={14} />}
                        size="small"
                        type="text"
                        onClick={() =>
                          setDraftIds((current) =>
                            current.filter((_, itemIndex) => itemIndex !== index),
                          )
                        }
                      />
                    </Flexbox>
                  </div>
                );
              })}
            </Flexbox>
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

          <Flexbox gap={6}>
            <Flexbox horizontal align={'center'} justify={'space-between'}>
              <span className={styles.availableHeader}>{AVAILABLE_LABEL}</span>
              <span className={cx(styles.hint, draftInvalid && styles.hintInvalid)}>
                {draftHint}
              </span>
            </Flexbox>
            <Flexbox className={styles.list} gap={6}>
              {filteredCandidates.length === 0 ? (
                <div className={styles.empty}>{EMPTY_LABEL}</div>
              ) : (
                filteredCandidates.map((candidate) => {
                  const displayName = candidate.displayName || candidate.id;
                  const showId = candidate.id !== displayName;
                  const blocked = draftIds.length >= maxSelectableModels;

                  return (
                    <button
                      className={cx(styles.option, blocked && styles.invalid)}
                      disabled={blocked}
                      key={candidate.id}
                      title={candidate.id}
                      type="button"
                      onClick={() => handleAdd(candidate.id)}
                    >
                      <Icon icon={PlusIcon} size={14} />
                      <Flexbox flex={1} gap={2} style={{ minWidth: 0 }}>
                        <span className={styles.modelName}>{displayName}</span>
                        {showId && <span className={styles.modelId}>{candidate.id}</span>}
                      </Flexbox>
                    </button>
                  );
                })
              )}
            </Flexbox>
          </Flexbox>

          <Flexbox horizontal align={'center'} className={styles.footer} justify={'space-between'}>
            <span className={styles.count}>
              {draftIds.length}/{maxSelectableModels}
            </span>
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
      onOpenChange={setOpen}
    >
      <button
        className={cx(styles.trigger, invalid && styles.invalid)}
        title="ModelNet 串联模型"
        type="button"
      >
        <Icon icon={LinkIcon} size={14} />
        <span>{SERIAL_LABEL}</span>
        <span className={styles.triggerBadge}>{selectedIds.length}</span>
      </button>
    </Popover>
  );
});

ModelNetSerial.displayName = 'ModelNetSerial';

export default ModelNetSerial;
