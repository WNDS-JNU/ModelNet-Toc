'use client';

import { DEFAULT_AVATAR } from '@lobechat/const';
import type { BuiltinInterventionProps } from '@lobechat/types';
import { Flexbox, Icon, Tooltip } from '@lobehub/ui';
import { Avatar, Button } from '@lobehub/ui/base-ui';
import { Input, InputNumber } from 'antd';
import { createStaticStyles, useTheme } from 'antd-style';
import isEqual from 'fast-deep-equal';
import { Plus, Trash2 } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAgentGroupStore } from '@/store/agentGroup';
import { agentGroupSelectors } from '@/store/agentGroup/selectors';

import type { CreateDebateParams, DebateParticipant } from '../../types';

const styles = createStaticStyles(({ css, cssVar }) => ({
  card: css`
    padding: 10px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;
  `,
  container: css`
    padding-block: 12px;
  `,
  deleteButton: css`
    cursor: pointer;
    color: ${cssVar.colorTextTertiary};

    &:hover {
      color: ${cssVar.colorError};
    }
  `,
  hint: css`
    font-size: 12px;
    line-height: 1.5;
    color: ${cssVar.colorTextSecondary};
  `,
  identity: css`
    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
  `,
  numberInput: css`
    width: 132px;
  `,
}));

const AgentIdentity = memo<{ agentId: string }>(({ agentId }) => {
  const { t } = useTranslation('tool');
  const theme = useTheme();
  const activeGroupId = useAgentGroupStore(agentGroupSelectors.activeGroupId);
  const agent = useAgentGroupStore((state) =>
    agentId && activeGroupId
      ? agentGroupSelectors.getAgentByIdFromGroup(activeGroupId, agentId)(state)
      : undefined,
  );

  return (
    <Flexbox horizontal align={'center'} className={styles.identity} gap={6}>
      <Avatar
        avatar={agent?.avatar || DEFAULT_AVATAR}
        background={agent?.backgroundColor || theme.colorBgContainer}
        shape={'circle'}
        size={20}
      />
      <span>
        {agent?.title || t('agentGroupManagement.createDebate.intervention.unknownAgent')}
      </span>
    </Flexbox>
  );
});

AgentIdentity.displayName = 'AgentIdentity';

interface ParticipantEditorProps {
  index: number;
  onChange: (index: number, updates: Partial<DebateParticipant>) => void;
  onDelete: (index: number) => void;
  participant: DebateParticipant;
}

const ParticipantEditor = memo<ParticipantEditorProps>(
  ({ index, onChange, onDelete, participant }) => {
    const { t } = useTranslation('tool');

    return (
      <Flexbox className={styles.card} gap={8}>
        <Flexbox horizontal align={'center'} justify={'space-between'}>
          <AgentIdentity agentId={participant.agentId} />
          <Tooltip title={t('agentGroupManagement.createDebate.intervention.removeParticipant')}>
            <Icon
              className={styles.deleteButton}
              icon={Trash2}
              size={{ size: 16 }}
              onClick={() => onDelete(index)}
            />
          </Tooltip>
        </Flexbox>
        <Input
          placeholder={t('agentGroupManagement.createDebate.intervention.agentIdPlaceholder')}
          size={'small'}
          value={participant.agentId}
          variant={'filled'}
          onChange={(event) => onChange(index, { agentId: event.target.value })}
        />
        <Input.TextArea
          autoSize={{ maxRows: 6, minRows: 2 }}
          placeholder={t('agentGroupManagement.createDebate.intervention.perspectivePlaceholder')}
          value={participant.perspective}
          variant={'filled'}
          onChange={(event) => onChange(index, { perspective: event.target.value })}
        />
      </Flexbox>
    );
  },
);

ParticipantEditor.displayName = 'ParticipantEditor';

const CreateDebateIntervention = memo<BuiltinInterventionProps<CreateDebateParams>>(
  ({ args, onArgsChange, registerBeforeApprove }) => {
    const { t } = useTranslation('tool');
    const [draft, setDraft] = useState<CreateDebateParams>({
      budget: args?.budget,
      judgeAgentId: args?.judgeAgentId || '',
      judgeInstruction: args?.judgeInstruction,
      judgeTimeoutMs: args?.judgeTimeoutMs,
      motion: args?.motion || '',
      name: args?.name || '',
      participants: args?.participants || [],
      policy: args?.policy,
      roundBudget: args?.roundBudget,
      rounds: args?.rounds || 1,
    });
    const [hasChanges, setHasChanges] = useState(false);

    useEffect(() => {
      if (hasChanges) return;
      setDraft({
        budget: args?.budget,
        judgeAgentId: args?.judgeAgentId || '',
        judgeInstruction: args?.judgeInstruction,
        judgeTimeoutMs: args?.judgeTimeoutMs,
        motion: args?.motion || '',
        name: args?.name || '',
        participants: args?.participants || [],
        policy: args?.policy,
        roundBudget: args?.roundBudget,
        rounds: args?.rounds || 1,
      });
    }, [args, hasChanges]);

    const updateParticipant = useCallback((index: number, updates: Partial<DebateParticipant>) => {
      setDraft((current) => ({
        ...current,
        participants: current.participants.map((participant, participantIndex) =>
          participantIndex === index ? { ...participant, ...updates } : participant,
        ),
      }));
      setHasChanges(true);
    }, []);

    const deleteParticipant = useCallback((index: number) => {
      setDraft((current) => ({
        ...current,
        participants: current.participants.filter(
          (_, participantIndex) => participantIndex !== index,
        ),
      }));
      setHasChanges(true);
    }, []);

    const addParticipant = useCallback(() => {
      setDraft((current) =>
        current.participants.length >= 8
          ? current
          : {
              ...current,
              participants: [...current.participants, { agentId: '' }],
            },
      );
      setHasChanges(true);
    }, []);

    useEffect(() => {
      if (!registerBeforeApprove) return;

      return registerBeforeApprove('createDebate', async () => {
        const participantIds = draft.participants.map((participant) => participant.agentId.trim());
        const validPositiveInteger = (value: number | undefined) =>
          value === undefined || (Number.isSafeInteger(value) && value > 0);
        const validBudget =
          validPositiveInteger(draft.budget?.maxDurationMs) &&
          validPositiveInteger(draft.budget?.maxParallel) &&
          (draft.budget?.maxTotalCost === undefined ||
            (Number.isFinite(draft.budget.maxTotalCost) && draft.budget.maxTotalCost >= 0)) &&
          validPositiveInteger(draft.roundBudget?.timeoutMs) &&
          validPositiveInteger(draft.judgeTimeoutMs) &&
          (draft.roundBudget?.maxAttempts === undefined ||
            (Number.isInteger(draft.roundBudget.maxAttempts) &&
              draft.roundBudget.maxAttempts >= 1 &&
              draft.roundBudget.maxAttempts <= 3));
        const invalid =
          !draft.name.trim() ||
          !draft.motion.trim() ||
          !draft.judgeAgentId.trim() ||
          !validBudget ||
          !Number.isInteger(draft.rounds) ||
          draft.rounds < 1 ||
          draft.rounds > 5 ||
          participantIds.length < 2 ||
          participantIds.length > 8 ||
          participantIds.some((agentId) => !agentId) ||
          new Set(participantIds).size !== participantIds.length ||
          participantIds.includes(draft.judgeAgentId.trim());
        if (invalid) {
          throw new Error(t('agentGroupManagement.createDebate.intervention.validationError'));
        }
        if (onArgsChange) await onArgsChange(draft);
      });
    }, [draft, onArgsChange, registerBeforeApprove, t]);

    const changeDraft = (updates: Partial<CreateDebateParams>) => {
      setDraft((current) => ({ ...current, ...updates }));
      setHasChanges(true);
    };

    return (
      <Flexbox className={styles.container} gap={12}>
        <div className={styles.hint}>
          {t('agentGroupManagement.createDebate.intervention.reviewHint')}
        </div>
        <Flexbox horizontal gap={8}>
          <Input
            placeholder={t('agentGroupManagement.createDebate.intervention.namePlaceholder')}
            value={draft.name}
            variant={'filled'}
            onChange={(event) => changeDraft({ name: event.target.value })}
          />
          <InputNumber
            className={styles.numberInput}
            max={5}
            min={1}
            placeholder={t('agentGroupManagement.createDebate.intervention.roundsPlaceholder')}
            value={draft.rounds}
            variant={'filled'}
            onChange={(value) => value !== null && changeDraft({ rounds: value })}
          />
          <InputNumber
            className={styles.numberInput}
            min={1}
            placeholder={t('agentGroupManagement.createDebate.intervention.maxParallelPlaceholder')}
            value={draft.budget?.maxParallel}
            variant={'filled'}
            onChange={(value) =>
              changeDraft({
                budget: { ...draft.budget, maxParallel: value === null ? undefined : value },
              })
            }
          />
        </Flexbox>
        <Input.TextArea
          autoSize={{ maxRows: 8, minRows: 3 }}
          placeholder={t('agentGroupManagement.createDebate.intervention.motionPlaceholder')}
          value={draft.motion}
          variant={'filled'}
          onChange={(event) => changeDraft({ motion: event.target.value })}
        />
        <Flexbox horizontal gap={8}>
          <InputNumber
            className={styles.numberInput}
            min={1}
            suffix={t('agentGroupManagement.createDebate.intervention.timeoutUnit')}
            variant={'filled'}
            placeholder={t(
              'agentGroupManagement.createDebate.intervention.roundTimeoutPlaceholder',
            )}
            value={
              draft.roundBudget?.timeoutMs
                ? Math.round(draft.roundBudget.timeoutMs / 60_000)
                : undefined
            }
            onChange={(value) =>
              changeDraft({
                roundBudget: {
                  ...draft.roundBudget,
                  timeoutMs: value === null ? undefined : value * 60_000,
                },
              })
            }
          />
          <InputNumber
            className={styles.numberInput}
            max={3}
            min={1}
            placeholder={t('agentGroupManagement.createDebate.intervention.maxAttemptsPlaceholder')}
            value={draft.roundBudget?.maxAttempts ?? 1}
            variant={'filled'}
            onChange={(value) =>
              value !== null &&
              changeDraft({ roundBudget: { ...draft.roundBudget, maxAttempts: value } })
            }
          />
        </Flexbox>
        <Flexbox className={styles.card} gap={8}>
          <AgentIdentity agentId={draft.judgeAgentId} />
          <Flexbox horizontal gap={8}>
            <Input
              value={draft.judgeAgentId}
              variant={'filled'}
              placeholder={t(
                'agentGroupManagement.createDebate.intervention.judgeAgentPlaceholder',
              )}
              onChange={(event) => changeDraft({ judgeAgentId: event.target.value })}
            />
            <InputNumber
              className={styles.numberInput}
              min={1}
              suffix={t('agentGroupManagement.createDebate.intervention.timeoutUnit')}
              value={draft.judgeTimeoutMs ? Math.round(draft.judgeTimeoutMs / 60_000) : undefined}
              variant={'filled'}
              placeholder={t(
                'agentGroupManagement.createDebate.intervention.judgeTimeoutPlaceholder',
              )}
              onChange={(value) =>
                changeDraft({
                  judgeTimeoutMs: value === null ? undefined : value * 60_000,
                })
              }
            />
          </Flexbox>
          <Input.TextArea
            autoSize={{ maxRows: 6, minRows: 2 }}
            value={draft.judgeInstruction}
            variant={'filled'}
            placeholder={t(
              'agentGroupManagement.createDebate.intervention.judgeInstructionPlaceholder',
            )}
            onChange={(event) => changeDraft({ judgeInstruction: event.target.value })}
          />
        </Flexbox>
        <Flexbox gap={8}>
          {draft.participants.map((participant, index) => (
            <ParticipantEditor
              index={index}
              key={`${participant.agentId}:${index}`}
              participant={participant}
              onChange={updateParticipant}
              onDelete={deleteParticipant}
            />
          ))}
          <Button
            block
            disabled={draft.participants.length >= 8}
            icon={<Plus size={14} />}
            type={'dashed'}
            onClick={addParticipant}
          >
            {t('agentGroupManagement.createDebate.intervention.addParticipant')}
          </Button>
        </Flexbox>
      </Flexbox>
    );
  },
  isEqual,
);

CreateDebateIntervention.displayName = 'CreateDebateIntervention';

export default CreateDebateIntervention;
