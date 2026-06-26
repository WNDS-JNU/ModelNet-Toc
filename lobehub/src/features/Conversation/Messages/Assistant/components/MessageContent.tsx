import { LOADING_FLAT } from '@lobechat/const';
import { type UIChatMessage } from '@lobechat/types';
import { Flexbox } from '@lobehub/ui';
import { memo, useCallback, useMemo } from 'react';

import { useUserStore } from '@/store/user';
import { userProfileSelectors } from '@/store/user/selectors';

import { ReactionDisplay } from '../../../components/Reaction';
import { messageStateSelectors, useConversationStore } from '../../../store';
import { CollapsedMessage } from '../../AssistantGroup/components/CollapsedMessage';
import DisplayContent from '../../components/DisplayContent';
import FileChunks from '../../components/FileChunks';
import ImageFileListViewer from '../../components/ImageFileListViewer';
import Reasoning from '../../components/Reasoning';
import SearchGrounding from '../../components/SearchGrounding';
import { useMarkdown } from '../useMarkdown';
import { stripModelNetFlowContent } from './modelnetTraceContent';
import ModelNetTraceThinking from './ModelNetTraceThinking';

const MessageContent = memo<UIChatMessage>(
  ({ id, tools, content, chunksList, search, imageList, metadata, ...props }) => {
    const { drawer, markdownProps } = useMarkdown(id);
    // Use ConversationStore instead of ChatStore
    const generating = useConversationStore(messageStateSelectors.isMessageGenerating(id));
    const isCreating = useConversationStore(messageStateSelectors.isMessageCreating(id));
    const isCollapsed = useConversationStore(messageStateSelectors.isMessageCollapsed(id));
    const isReasoning = useConversationStore(messageStateSelectors.isMessageInReasoning(id));
    const addReaction = useConversationStore((s) => s.addReaction);
    const removeReaction = useConversationStore((s) => s.removeReaction);
    const userId = useUserStore(userProfileSelectors.userId)!;

    const isLoading = generating || isCreating;
    const visibleContent = stripModelNetFlowContent(content);
    const isToolCallGenerating =
      isLoading && (visibleContent === LOADING_FLAT || !visibleContent) && !!tools;

    const showSearch = !!search && (!!search.citations?.length || !!search.imageResults?.length);
    const showImageItems = !!imageList && imageList.length > 0;

    // remove \n to avoid empty content
    // refs: https://github.com/lobehub/lobe-chat/pull/6153
    const showReasoning =
      (!!props.reasoning && props.reasoning.content?.trim() !== '') ||
      (!props.reasoning && isReasoning);

    const showFileChunks = !!chunksList && chunksList.length > 0;

    const reactions = useMemo(() => metadata?.reactions || [], [metadata?.reactions]);

    const handleReactionClick = useCallback(
      (emoji: string) => {
        const existing = reactions.find((r) => r.emoji === emoji);
        if (existing && existing.users.includes(userId)) {
          removeReaction(id, emoji);
        } else {
          addReaction(id, emoji);
        }
      },
      [id, reactions, addReaction, removeReaction, userId],
    );

    const isActive = useCallback(
      (emoji: string) => {
        const reaction = reactions.find((r) => r.emoji === emoji);
        return !!reaction && reaction.users.includes(userId);
      },
      [reactions, userId],
    );

    if (isCollapsed) return <CollapsedMessage content={visibleContent} id={id} />;

    return (
      <Flexbox gap={8} id={id}>
        {drawer}
        {showSearch && (
          <SearchGrounding
            citations={search?.citations}
            imageResults={search?.imageResults}
            imageSearchQueries={search?.imageSearchQueries}
            searchQueries={search?.searchQueries}
          />
        )}
        {showFileChunks && <FileChunks data={chunksList} />}
        {showReasoning && <Reasoning {...props.reasoning} id={id} />}
        <ModelNetTraceThinking data={metadata?.modelnetParallel} />
        <DisplayContent
          content={visibleContent}
          generating={isLoading}
          hasImages={showImageItems}
          id={id}
          isMultimodal={metadata?.isMultimodal}
          isToolCallGenerating={isToolCallGenerating}
          markdownProps={markdownProps}
          tempDisplayContent={metadata?.tempDisplayContent}
        />
        {showImageItems && <ImageFileListViewer items={imageList} />}
        {reactions.length > 0 && (
          <ReactionDisplay
            isActive={isActive}
            messageId={id}
            reactions={reactions}
            onReactionClick={handleReactionClick}
          />
        )}
      </Flexbox>
    );
  },
);

export default MessageContent;
