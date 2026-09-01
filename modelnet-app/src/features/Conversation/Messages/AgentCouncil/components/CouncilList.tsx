'use client';

import { type UIChatMessage } from '@lobechat/types';
import { Flexbox } from '@lobehub/ui';
import { Pagination } from 'antd';
import isEqual from 'fast-deep-equal';
import { memo, useEffect, useMemo, useState } from 'react';

import WideScreenContainer from '@/features/WideScreenContainer';
import { useIsMobile } from '@/hooks/useIsMobile';

import CouncilMember from './CouncilMember';

export type DisplayMode = 'horizontal' | 'tab';

interface CouncilListProps {
  activeTab: number;
  displayMode?: DisplayMode;
  members?: UIChatMessage[];
}

const CouncilList = memo<CouncilListProps>(({ members, displayMode, activeTab }) => {
  const isMobile = useIsMobile();
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = isMobile ? 1 : 2;
  const totalPages = Math.max(1, Math.ceil((members?.length ?? 0) / pageSize));
  const safePage = Math.min(currentPage, totalPages);
  const pageStart = (safePage - 1) * pageSize;
  const visibleMembers = useMemo(
    () => members?.slice(pageStart, pageStart + pageSize) ?? [],
    [members, pageSize, pageStart],
  );

  useEffect(() => {
    if (safePage !== currentPage) setCurrentPage(safePage);
  }, [currentPage, safePage]);

  if (!members || members.length === 0) {
    return null;
  }

  switch (displayMode) {
    case 'tab': {
      const activeMember = members[activeTab];
      if (!activeMember) return null;

      return (
        <WideScreenContainer>
          <CouncilMember index={activeTab} item={activeMember} />
        </WideScreenContainer>
      );
    }

    default: {
      return (
        <WideScreenContainer gap={12}>
          <div
            style={{
              display: 'grid',
              gap: 16,
              gridTemplateColumns: `repeat(${visibleMembers.length}, minmax(0, 1fr))`,
              width: '100%',
            }}
          >
            {visibleMembers.map((member, idx) => {
              return (
                <div key={member.id} style={{ minWidth: 0 }}>
                  <CouncilMember index={pageStart + idx} item={member} />
                </div>
              );
            })}
          </div>
          {members.length > pageSize && (
            <Flexbox horizontal align={'center'} justify={'center'} width={'100%'}>
              <Pagination
                current={safePage}
                pageSize={pageSize}
                showSizeChanger={false}
                size={'small'}
                total={members.length}
                onChange={setCurrentPage}
              />
            </Flexbox>
          )}
        </WideScreenContainer>
      );
    }
  }
}, isEqual);

export default CouncilList;
