import { Flexbox } from '@lobehub/ui';
import { type ComponentType, type FC } from 'react';
import { useMemo, useState } from 'react';
import { Rnd } from 'react-rnd';

import { withModelNetParallelModel } from '@/features/ModelNetParallel';
import { useEnabledChatModels } from '@/hooks/useEnabledChatModels';
import { useAiInfraStore } from '@/store/aiInfra';
import { useUserStore } from '@/store/user';
import { userGeneralSettingsSelectors } from '@/store/user/slices/settings/selectors/general';
import type { EnabledProviderWithModels } from '@/types/aiProvider';

import { DEFAULT_WIDTH, ENABLE_RESIZING, MAX_WIDTH, MIN_WIDTH } from '../const';
import { usePanelSize } from '../hooks/usePanelSize';
import { usePanelState } from '../hooks/usePanelState';
import type { ModelChangeParams } from '../types';
import { List } from './List';
import type { PricingMode } from './ModelDetailPanel';
import { Toolbar } from './Toolbar';

interface PanelContentProps {
  enabledList?: EnabledProviderWithModels[];
  model?: string;
  ModelItemComponent?: ComponentType<any>;
  onModelChange?: (params: ModelChangeParams) => Promise<void>;
  onOpenChange?: (open: boolean) => void;
  pricingMode?: PricingMode;
  provider?: string;
}

export const PanelContent: FC<PanelContentProps> = ({
  ModelItemComponent,
  enabledList: enabledListProp,
  model: modelProp,
  onModelChange: onModelChangeProp,
  onOpenChange,
  pricingMode,
  provider: providerProp,
}) => {
  const chatEnabledList = useEnabledChatModels();
  const aiProviderRuntimeConfig = useAiInfraStore((s) => s.aiProviderRuntimeConfig);
  const enabledList = useMemo(
    () => enabledListProp ?? withModelNetParallelModel(chatEnabledList, aiProviderRuntimeConfig),
    [aiProviderRuntimeConfig, chatEnabledList, enabledListProp],
  );
  const [searchKeyword, setSearchKeyword] = useState('');
  const isDevMode = useUserStore((s) => userGeneralSettingsSelectors.config(s).isDevMode);
  const { groupMode, handleGroupModeChange } = usePanelState();
  const { panelHeight, panelWidth, handlePanelWidthChange } = usePanelSize(enabledList.length);

  const content = (
    <>
      <Toolbar
        groupMode={groupMode}
        searchKeyword={searchKeyword}
        showGroupModeSwitch={isDevMode}
        onGroupModeChange={handleGroupModeChange}
        onSearchKeywordChange={setSearchKeyword}
      />
      <List
        ModelItemComponent={ModelItemComponent}
        enabledList={enabledList}
        groupMode={isDevMode ? groupMode : 'byModel'}
        model={modelProp}
        pricingMode={pricingMode}
        provider={providerProp}
        runtimeConfig={aiProviderRuntimeConfig}
        searchKeyword={searchKeyword}
        onModelChange={onModelChangeProp}
        onOpenChange={onOpenChange}
      />
    </>
  );

  if (isDevMode) {
    return (
      <Rnd
        disableDragging
        enableResizing={ENABLE_RESIZING}
        maxWidth={MAX_WIDTH}
        minWidth={MIN_WIDTH}
        position={{ x: 0, y: 0 }}
        size={{ height: panelHeight, width: panelWidth }}
        style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}
        onResizeStop={(_e, _direction, ref) => {
          handlePanelWidthChange(ref.offsetWidth);
        }}
      >
        {content}
      </Rnd>
    );
  }

  return (
    <Flexbox
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: panelHeight,
        position: 'relative',
        width: DEFAULT_WIDTH,
      }}
    >
      {content}
    </Flexbox>
  );
};
