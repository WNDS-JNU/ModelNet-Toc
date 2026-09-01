'use client';

import type { AgentGroupCollaborationMode } from '@lobechat/types';
import { memo, useCallback, useEffect, useState } from 'react';

import { type ActionKeys } from '@/features/ChatInput';
import { ChatInput } from '@/features/Conversation';
import { contextSelectors, useConversationStore } from '@/features/Conversation/store';
import { useChatStore } from '@/store/chat';

import CollaborationModeSelector, {
  isAgentGroupCollaborationMode,
} from './CollaborationModeSelector';
import { useSendMenuItems } from './useSendMenuItems';

const leftActions: ActionKeys[] = [
  'search',
  'memory',
  'fileUpload',
  'tools',
  'voiceDictation',
  '---',
  ['typo', 'params', 'clear'],
];

const rightActions: ActionKeys[] = ['model', 'voiceMessage', 'contextWindow'];
const collaborationModeStorageKey = (groupId: string) =>
  `modelnet:agent-group-collaboration:${groupId}`;

/**
 * MainChatInput
 *
 * Custom ChatInput implementation for main chat page.
 * Uses ChatInput from @/features/Conversation which handles all send logic
 * including error alerts display.
 * Only adds MessageFromUrl for desktop mode.
 */
const MainChatInput = memo(() => {
  const sendMenuItems = useSendMenuItems();
  const groupId = useConversationStore(contextSelectors.groupId);
  const [collaborationMode, setCollaborationMode] = useState<AgentGroupCollaborationMode>('auto');

  useEffect(() => {
    if (!groupId) {
      setCollaborationMode('auto');
      return;
    }

    try {
      const stored = window.localStorage.getItem(collaborationModeStorageKey(groupId));
      setCollaborationMode(isAgentGroupCollaborationMode(stored) ? stored : 'auto');
    } catch {
      // Storage may be unavailable in hardened/privacy browser contexts.
      setCollaborationMode('auto');
    }
  }, [groupId]);

  const handleCollaborationModeChange = useCallback(
    (mode: AgentGroupCollaborationMode) => {
      setCollaborationMode(mode);
      if (groupId) {
        try {
          window.localStorage.setItem(collaborationModeStorageKey(groupId), mode);
        } catch {
          // The run still uses the selected in-memory mode when persistence is unavailable.
        }
      }
    },
    [groupId],
  );

  return (
    <ChatInput
      skipScrollMarginWithList
      leftActions={leftActions}
      messageMetadata={{ agentGroupCollaborationMode: collaborationMode }}
      rightActions={rightActions}
      sendMenu={{ items: sendMenuItems }}
      sendAreaPrefix={
        <CollaborationModeSelector
          mode={collaborationMode}
          onChange={handleCollaborationModeChange}
        />
      }
      onEditorReady={(instance) => {
        // Sync to global ChatStore for compatibility with other features
        useChatStore.setState({ mainInputEditor: instance });
      }}
    />
  );
});

MainChatInput.displayName = 'MainChatInput';

export default MainChatInput;
