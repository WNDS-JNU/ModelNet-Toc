'use client';

import { DEFAULT_AVATAR } from '@lobechat/const';
import type { BuiltinInterventionProps } from '@lobechat/types';
import { Accordion, AccordionItem, Flexbox, Icon, stopPropagation, Tooltip } from '@lobehub/ui';
import { Avatar } from '@lobehub/ui/base-ui';
import { Input, InputNumber } from 'antd';
import { createStaticStyles, useTheme } from 'antd-style';
import isEqual from 'fast-deep-equal';
import { Clock, Trash2 } from 'lucide-react';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAgentGroupStore } from '@/store/agentGroup';
import { agentGroupSelectors } from '@/store/agentGroup/selectors';

import type { CreateWorkflowParams, WorkflowStep } from '../../types';

const styles = createStaticStyles(({ css, cssVar }) => ({
  assignee: css`
    display: flex;
    flex-shrink: 0;
    gap: 6px;
    align-items: center;

    font-size: 12px;
    color: ${cssVar.colorTextSecondary};
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
  numberInput: css`
    width: 112px;
  `,
}));

interface WorkflowStepEditorProps {
  index: number;
  onChange: (index: number, updates: Partial<WorkflowStep>) => void;
  onDelete: (index: number) => void;
  step: WorkflowStep;
}

const WorkflowStepEditor = memo<WorkflowStepEditorProps>(({ index, onChange, onDelete, step }) => {
  const { t } = useTranslation('tool');
  const theme = useTheme();
  const activeGroupId = useAgentGroupStore(agentGroupSelectors.activeGroupId);
  const agent = useAgentGroupStore((state) =>
    step.agentId && activeGroupId
      ? agentGroupSelectors.getAgentByIdFromGroup(activeGroupId, step.agentId)(state)
      : undefined,
  );

  const updateText =
    (field: 'instruction' | 'key' | 'role') =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(index, { [field]: event.target.value });

  return (
    <AccordionItem
      defaultExpand
      itemKey={String(index)}
      paddingBlock={4}
      paddingInline={2}
      title={
        <Flexbox horizontal align={'center'} gap={8}>
          <div className={styles.assignee}>
            <Avatar
              avatar={agent?.avatar || DEFAULT_AVATAR}
              background={agent?.backgroundColor || theme.colorBgContainer}
              shape={'circle'}
              size={20}
            />
            <span>
              {agent?.title || t('agentGroupManagement.createWorkflow.intervention.unknownAgent')}
            </span>
          </div>
          <span>{step.key}</span>
        </Flexbox>
      }
    >
      <Flexbox gap={10} style={{ marginTop: 8 }}>
        <Flexbox horizontal gap={8}>
          <Input
            placeholder={t('agentGroupManagement.createWorkflow.intervention.keyPlaceholder')}
            size={'small'}
            value={step.key}
            variant={'filled'}
            onChange={updateText('key')}
          />
          <Input
            placeholder={t('agentGroupManagement.createWorkflow.intervention.rolePlaceholder')}
            size={'small'}
            value={step.role}
            variant={'filled'}
            onChange={updateText('role')}
          />
          <Flexbox horizontal align={'center'} gap={6} onClick={stopPropagation}>
            <Tooltip title={t('agentGroupManagement.createWorkflow.intervention.maxAttempts')}>
              <span>↻</span>
            </Tooltip>
            <InputNumber
              className={styles.numberInput}
              max={10}
              min={1}
              size={'small'}
              value={step.maxAttempts ?? 1}
              variant={'filled'}
              onChange={(value) => value !== null && onChange(index, { maxAttempts: value })}
            />
            <Tooltip title={t('agentGroupManagement.createWorkflow.intervention.timeout')}>
              <Clock size={14} />
            </Tooltip>
            <InputNumber
              className={styles.numberInput}
              min={1}
              size={'small'}
              suffix={t('agentGroupManagement.createWorkflow.intervention.timeoutUnit')}
              value={step.timeoutMs ? Math.round(step.timeoutMs / 60_000) : undefined}
              variant={'filled'}
              onChange={(value) =>
                onChange(index, {
                  timeoutMs: value === null ? undefined : value * 60_000,
                })
              }
            />
            <Icon
              className={styles.deleteButton}
              icon={Trash2}
              size={{ size: 16 }}
              onClick={() => onDelete(index)}
            />
          </Flexbox>
        </Flexbox>
        <Input
          size={'small'}
          value={(step.dependencies ?? []).join(', ')}
          variant={'filled'}
          placeholder={t(
            'agentGroupManagement.createWorkflow.intervention.dependenciesPlaceholder',
          )}
          onChange={(event) =>
            onChange(index, {
              dependencies: event.target.value
                .split(',')
                .map((dependency) => dependency.trim())
                .filter(Boolean),
            })
          }
        />
        <Input.TextArea
          autoSize={{ maxRows: 14, minRows: 5 }}
          placeholder={t('agentGroupManagement.createWorkflow.intervention.instructionPlaceholder')}
          value={step.instruction}
          variant={'filled'}
          onChange={updateText('instruction')}
        />
      </Flexbox>
    </AccordionItem>
  );
});

WorkflowStepEditor.displayName = 'WorkflowStepEditor';

const CreateWorkflowIntervention = memo<BuiltinInterventionProps<CreateWorkflowParams>>(
  ({ args, onArgsChange, registerBeforeApprove }) => {
    const { t } = useTranslation('tool');
    const [draft, setDraft] = useState<CreateWorkflowParams>({
      budget: args?.budget,
      name: args?.name || '',
      policy: args?.policy,
      steps: args?.steps || [],
    });
    const [hasChanges, setHasChanges] = useState(false);

    useEffect(() => {
      if (hasChanges) return;
      setDraft({
        budget: args?.budget,
        name: args?.name || '',
        policy: args?.policy,
        steps: args?.steps || [],
      });
    }, [args?.budget, args?.name, args?.policy, args?.steps, hasChanges]);

    const updateStep = useCallback((index: number, updates: Partial<WorkflowStep>) => {
      setDraft((current) => ({
        ...current,
        steps: current.steps.map((step, stepIndex) =>
          stepIndex === index ? { ...step, ...updates } : step,
        ),
      }));
      setHasChanges(true);
    }, []);

    const deleteStep = useCallback((index: number) => {
      setDraft((current) => ({
        ...current,
        steps: current.steps.filter((_, stepIndex) => stepIndex !== index),
      }));
      setHasChanges(true);
    }, []);

    useEffect(() => {
      if (!registerBeforeApprove) return;

      return registerBeforeApprove('createWorkflow', async () => {
        const invalid =
          !draft.name.trim() ||
          draft.steps.length === 0 ||
          draft.steps.some(
            (step) => !step.agentId || !step.key?.trim() || !step.instruction?.trim(),
          );
        if (invalid) {
          throw new Error(t('agentGroupManagement.createWorkflow.intervention.validationError'));
        }
        if (onArgsChange) await onArgsChange(draft);
      });
    }, [draft, onArgsChange, registerBeforeApprove, t]);

    return (
      <Flexbox className={styles.container} gap={12}>
        <div className={styles.hint}>
          {t('agentGroupManagement.createWorkflow.intervention.reviewHint')}
        </div>
        <Flexbox horizontal gap={8}>
          <Input
            placeholder={t('agentGroupManagement.createWorkflow.intervention.namePlaceholder')}
            value={draft.name}
            variant={'filled'}
            onChange={(event) => {
              setDraft((current) => ({ ...current, name: event.target.value }));
              setHasChanges(true);
            }}
          />
          <InputNumber
            className={styles.numberInput}
            min={1}
            value={draft.budget?.maxParallel}
            variant={'filled'}
            placeholder={t(
              'agentGroupManagement.createWorkflow.intervention.maxParallelPlaceholder',
            )}
            onChange={(value) => {
              setDraft((current) => ({
                ...current,
                budget: {
                  ...current.budget,
                  maxParallel: value === null ? undefined : value,
                },
              }));
              setHasChanges(true);
            }}
          />
        </Flexbox>
        <Accordion gap={0} variant={'borderless'}>
          {draft.steps.map((step, index) => (
            <WorkflowStepEditor
              index={index}
              key={`${step.agentId}:${step.key}:${index}`}
              step={step}
              onChange={updateStep}
              onDelete={deleteStep}
            />
          ))}
        </Accordion>
      </Flexbox>
    );
  },
  isEqual,
);

CreateWorkflowIntervention.displayName = 'CreateWorkflowIntervention';

export default CreateWorkflowIntervention;
