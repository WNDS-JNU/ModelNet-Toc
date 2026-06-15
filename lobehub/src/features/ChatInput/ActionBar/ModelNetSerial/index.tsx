'use client';

import { Flexbox, Icon, Popover, SearchBar } from '@lobehub/ui';
import { Button, message } from 'antd';
import { createStaticStyles, cx } from 'antd-style';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  LinkIcon,
  PlusIcon,
  Trash2Icon,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';

import {
  getModelNetParallelCandidates,
  isModelNetSerialModel,
  MAX_MODELNET_SERIAL_MODELS,
  MIN_MODELNET_SERIAL_MODELS,
  modelIdsToModelNetSerialTopology,
  normalizeModelNetSerialTopology,
  type ModelNetSerialTopology,
} from '@/features/ModelNetParallel';
import { useEnabledChatModels } from '@/hooks/useEnabledChatModels';
import { useAgentStore } from '@/store/agent';
import { agentByIdSelectors } from '@/store/agent/selectors';

import { useAgentId } from '../../hooks/useAgentId';

const SERIAL_LABEL = '\u4e32\u8054';
const SELECT_SERIAL_MODELS_LABEL = '\u9009\u62e9\u4e32\u8054\u6a21\u578b';
const PANEL_SUBTITLE_LABEL =
  `\u9009\u62e9 ${MIN_MODELNET_SERIAL_MODELS}-${MAX_MODELNET_SERIAL_MODELS} ` +
  '\u4e2a\u6a21\u578b\uff0c\u6309\u987a\u5e8f\u4f9d\u6b21 review/refine';
const SEARCH_PLACEHOLDER_LABEL = '\u641c\u7d22\u6a21\u578b';
const CHAIN_LABEL = '\u4e32\u8054\u94fe\u8def';
const AVAILABLE_LABEL = '\u53ef\u6dfb\u52a0\u6a21\u578b';
const MAX_REACHED_LABEL = '\u5df2\u8fbe\u5230\u4e0a\u9650';
const EMPTY_LABEL = '\u6ca1\u6709\u53ef\u6dfb\u52a0\u7684\u6a21\u578b';
const CANCEL_LABEL = '\u53d6\u6d88';
const SAVE_LABEL = '\u4fdd\u5b58';

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
        candidate.id.toLowerCase().includes(keyword) ||
        displayName.toLowerCase().includes(keyword)
      );
    });
  }, [candidates, draftIds, searchKeyword]);

  const draftInvalid =
    draftIds.length < MIN_MODELNET_SERIAL_MODELS ||
    draftIds.length > MAX_MODELNET_SERIAL_MODELS;
  const minRemaining = Math.max(MIN_MODELNET_SERIAL_MODELS - draftIds.length, 0);
  const draftHint = draftInvalid
    ? `\u8fd8\u9700\u8981 ${minRemaining} \u4e2a\u6a21\u578b`
    : draftIds.length >= MAX_MODELNET_SERIAL_MODELS
      ? MAX_REACHED_LABEL
      : `\u8fd8\u53ef\u6dfb\u52a0 ${MAX_MODELNET_SERIAL_MODELS - draftIds.length} \u4e2a`;
  const chainPreview = draftIds.map((_, index) => `step-${index + 1}`).join(' \u2192 ');

  const handleAdd = useCallback((id: string) => {
    setDraftIds((current) => {
      if (current.includes(id)) return current;
      if (current.length >= MAX_MODELNET_SERIAL_MODELS) {
        message.error(
          `\u6700\u591a\u9009\u62e9 ${MAX_MODELNET_SERIAL_MODELS} \u4e2a\u4e32\u8054\u6a21\u578b`,
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
      nextIds.length < MIN_MODELNET_SERIAL_MODELS ||
      nextIds.length > MAX_MODELNET_SERIAL_MODELS
    ) {
      message.error(
        `ModelNet \u4e32\u8054\u9700\u8981\u9009\u62e9 ${MIN_MODELNET_SERIAL_MODELS}-${MAX_MODELNET_SERIAL_MODELS} \u4e2a\u6a21\u578b`,
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
  }, [agentId, agentParams, candidates, draftIds, updateAgentConfigById]);

  if (!isModelNetSerialModel(provider, model)) return null;
  if (isLoading || candidates.length < MIN_MODELNET_SERIAL_MODELS || !selectedTopology) return null;

  const invalid =
    selectedIds.length < MIN_MODELNET_SERIAL_MODELS ||
    selectedIds.length > MAX_MODELNET_SERIAL_MODELS;

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
              <Icon icon={LinkIcon} size={18} />
            </Flexbox>
            <Flexbox flex={1} gap={2}>
              <span className={styles.title}>{SELECT_SERIAL_MODELS_LABEL}</span>
              <span className={styles.hint}>{PANEL_SUBTITLE_LABEL}</span>
            </Flexbox>
            <span className={styles.status}>
              {draftIds.length}/{MAX_MODELNET_SERIAL_MODELS}
            </span>
          </Flexbox>

          <Flexbox gap={6}>
            <span className={styles.availableHeader}>{CHAIN_LABEL}</span>
            <div className={styles.chainPreview}>{chainPreview}</div>
            <Flexbox className={styles.list} gap={6}>
