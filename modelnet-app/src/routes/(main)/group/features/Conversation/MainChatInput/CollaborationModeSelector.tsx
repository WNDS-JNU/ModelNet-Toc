'use client';

import type { AgentGroupCollaborationMode } from '@lobechat/types';
import { type DropdownItem, DropdownMenu, Flexbox, Icon, type MenuInfo } from '@lobehub/ui';
import { createStaticStyles, cssVar } from 'antd-style';
import {
  CheckIcon,
  ChevronDownIcon,
  GitForkIcon,
  type LucideIcon,
  MegaphoneIcon,
  MessagesSquareIcon,
  SparklesIcon,
  UserRoundIcon,
  WorkflowIcon,
} from 'lucide-react';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

interface CollaborationModeOption {
  icon: LucideIcon;
  mode: AgentGroupCollaborationMode;
}

export const collaborationModeOptions: CollaborationModeOption[] = [
  { icon: SparklesIcon, mode: 'auto' },
  { icon: UserRoundIcon, mode: 'single' },
  { icon: MegaphoneIcon, mode: 'broadcast' },
  { icon: GitForkIcon, mode: 'parallel_tasks' },
  { icon: WorkflowIcon, mode: 'pipeline' },
  { icon: MessagesSquareIcon, mode: 'debate' },
];

export const isAgentGroupCollaborationMode = (
  value: string | null,
): value is AgentGroupCollaborationMode =>
  collaborationModeOptions.some((option) => option.mode === value);

const styles = createStaticStyles(({ css }) => ({
  description: css`
    font-size: 11px;
    color: ${cssVar.colorTextTertiary};
  `,
  label: css`
    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
  trigger: css`
    cursor: pointer;

    display: inline-flex;
    align-items: center;
    gap: 5px;

    height: 28px;
    padding: 0 8px;
    border: 1px solid ${cssVar.colorBorderSecondary};
    border-radius: 8px;

    font-size: 12px;
    font-weight: 500;
    color: ${cssVar.colorTextSecondary};

    background: ${cssVar.colorBgContainer};

    &:hover {
      border-color: ${cssVar.colorPrimaryBorder};
      color: ${cssVar.colorPrimary};
      background: ${cssVar.colorPrimaryBg};
    }
  `,
  triggerLabel: css`
    max-width: 148px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  `,
}));

interface CollaborationModeSelectorProps {
  mode: AgentGroupCollaborationMode;
  onChange: (mode: AgentGroupCollaborationMode) => void;
}

const CollaborationModeSelector = memo<CollaborationModeSelectorProps>(({ mode, onChange }) => {
  const { t } = useTranslation('chat');
  const currentOption =
    collaborationModeOptions.find((option) => option.mode === mode) ?? collaborationModeOptions[0];
  const CurrentIcon = currentOption.icon;
  const currentLabel = t(`agentGroupCollaborationMode.${mode}.title` as never);
  const selectorLabel = t('agentGroupCollaborationMode.label', { mode: currentLabel });

  const items = useMemo<DropdownItem[]>(
    () =>
      collaborationModeOptions.map((option) => {
        const OptionIcon = option.icon;
        return {
          extra: option.mode === mode ? <Icon icon={CheckIcon} size={15} /> : <span aria-hidden />,
          icon: <Icon color={cssVar.colorTextSecondary} icon={OptionIcon} size={16} />,
          key: option.mode,
          label: (
            <Flexbox gap={1} style={{ minWidth: 210 }}>
              <span className={styles.label}>
                {t(`agentGroupCollaborationMode.${option.mode}.title` as never)}
              </span>
              <span className={styles.description}>
                {t(`agentGroupCollaborationMode.${option.mode}.description` as never)}
              </span>
            </Flexbox>
          ),
          onClick: ({ domEvent }: MenuInfo) => {
            domEvent.stopPropagation();
            onChange(option.mode);
          },
        };
      }),
    [mode, onChange, t],
  );

  return (
    <DropdownMenu items={items} placement="topRight">
      <button
        aria-label={selectorLabel}
        className={styles.trigger}
        title={selectorLabel}
        type="button"
      >
        <CurrentIcon size={14} />
        <span className={styles.triggerLabel}>{selectorLabel}</span>
        <ChevronDownIcon size={12} />
      </button>
    </DropdownMenu>
  );
});

CollaborationModeSelector.displayName = 'CollaborationModeSelector';

export default CollaborationModeSelector;
