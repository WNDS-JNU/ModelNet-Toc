import { Icon } from '@lobehub/ui';
import { Tag } from '@lobehub/ui/base-ui';
import { BadgeCheck, CircleUser, Package } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import MCPTag from './MCPTag';

interface PluginTagProps {
  author?: string;
  isMCP?: boolean;
  showIcon?: boolean;
  showText?: boolean;
  type: 'builtin' | 'customPlugin' | 'plugin';
}

const isOfficialModelNetAuthor = (author?: string) =>
  author === 'ModelNet' || author === 'LobeHub' || author === 'LobeHub Market';

const PluginTag = memo<PluginTagProps>(
  ({ showIcon = true, author, type, showText = true, isMCP }) => {
    const { t } = useTranslation('plugin');
    const isCustom = type === 'customPlugin';
    const isOfficial = isOfficialModelNetAuthor(author);
    const displayAuthor = isOfficial ? 'ModelNet' : author;

    const customTag = (
      <Tag color={'warning'} icon={showIcon && <Icon icon={Package} />} size={'small'}>
        {t('store.customPlugin')}
      </Tag>
    );

    if (isMCP) {
      return (
        <>
          <MCPTag showIcon={showIcon} showText={false} />
          {isCustom && customTag}
        </>
      );
    }

    if (isCustom) return customTag;

    return (
      <Tag
        color={isOfficial ? 'success' : undefined}
        icon={showIcon && <Icon icon={isOfficial ? BadgeCheck : CircleUser} />}
        size={'small'}
      >
        {showText && (displayAuthor || t('store.communityPlugin'))}
      </Tag>
    );
  },
);

export default PluginTag;
