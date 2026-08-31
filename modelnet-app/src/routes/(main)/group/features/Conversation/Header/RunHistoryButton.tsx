'use client';

import { Empty, Flexbox } from '@lobehub/ui';
import { ActionIcon, Button, Drawer, Tag, Text, toast } from '@lobehub/ui/base-ui';
import { Popconfirm, Skeleton } from 'antd';
import { cssVar } from 'antd-style';
import { History } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { DESKTOP_HEADER_ICON_SIZE } from '@/const/layoutTokens';
import { useClientPollingSWR } from '@/libs/swr';
import { groupKeys } from '@/libs/swr/keys';
import { chatGroupService } from '@/services/chatGroup';

const ACTIVE_RUN_STATUSES = new Set(['pending', 'running', 'waiting', 'cancelling']);
const TERMINAL_NODE_STATUSES = new Set(['cancelled', 'completed', 'failed', 'skipped']);
const TERMINAL_RUN_STATUSES = new Set(['cancelled', 'completed', 'failed']);

const statusColor = (status: string) => {
  switch (status) {
    case 'completed': {
      return 'success';
    }
    case 'failed': {
      return 'error';
    }
    case 'cancelled': {
      return 'default';
    }
    case 'cancelling': {
      return 'warning';
    }
    default: {
      return 'processing';
    }
  }
};

const formatTime = (value: Date | string | null | undefined) => {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
};

interface RunHistoryButtonProps {
  groupId: string;
}

const RunHistoryButton = memo<RunHistoryButtonProps>(({ groupId }) => {
  const { t } = useTranslation('agentGroup');
  const [open, setOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [cancelling, setCancelling] = useState(false);
  const [retryingNodeId, setRetryingNodeId] = useState<string>();

  const {
    data: runs = [],
    isLoading,
    mutate: mutateRuns,
  } = useClientPollingSWR(
    open ? groupKeys.runs(groupId) : null,
    () => chatGroupService.listGroupRuns(groupId),
    {
      refreshInterval: (data) =>
        data?.some((snapshot) => ACTIVE_RUN_STATUSES.has(snapshot.run.status)) ? 5000 : 0,
    },
  );

  useEffect(() => {
    if (!open || runs.length === 0) return;
    if (!selectedRunId || !runs.some((snapshot) => snapshot.run.id === selectedRunId)) {
      setSelectedRunId(runs[0].run.id);
    }
  }, [open, runs, selectedRunId]);

  const selectedRun = useMemo(
    () => runs.find((snapshot) => snapshot.run.id === selectedRunId),
    [runs, selectedRunId],
  );

  const { data: events = [], mutate: mutateEvents } = useClientPollingSWR(
    open && selectedRunId ? groupKeys.runEvents(selectedRunId) : null,
    () => chatGroupService.listGroupRunEvents(selectedRunId!),
    {
      refreshInterval: selectedRun && ACTIVE_RUN_STATUSES.has(selectedRun.run.status) ? 5000 : 0,
    },
  );

  const statusLabel = (status: string) => {
    switch (status) {
      case 'cancelled': {
        return t('run.status.cancelled');
      }
      case 'cancelling': {
        return t('run.status.cancelling');
      }
      case 'completed': {
        return t('run.status.completed');
      }
      case 'failed': {
        return t('run.status.failed');
      }
      case 'pending': {
        return t('run.status.pending');
      }
      case 'running': {
        return t('run.status.running');
      }
      case 'waiting': {
        return t('run.status.waiting');
      }
      default: {
        return status;
      }
    }
  };

  const cancelRun = async () => {
    if (!selectedRun) return;
    setCancelling(true);
    try {
      await chatGroupService.cancelGroupRun(selectedRun.run.id);
      await Promise.all([mutateRuns(), mutateEvents()]);
      toast.success(t('run.cancelled'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('run.cancelFailed'));
    } finally {
      setCancelling(false);
    }
  };

  const retryNode = async (runNodeId: string) => {
    if (!selectedRun) return;
    setRetryingNodeId(runNodeId);
    try {
      await chatGroupService.retryGroupNode(selectedRun.run.id, runNodeId);
      await Promise.all([mutateRuns(), mutateEvents()]);
      toast.success(t('run.retryStarted'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('run.retryFailed'));
    } finally {
      setRetryingNodeId(undefined);
    }
  };

  return (
    <>
      <ActionIcon
        icon={History}
        size={DESKTOP_HEADER_ICON_SIZE}
        title={t('run.title')}
        tooltipProps={{ placement: 'bottom' }}
        onClick={() => setOpen(true)}
      />
      <Drawer
        containerMaxWidth={'100%'}
        open={open}
        placement={'right'}
        title={t('run.title')}
        width={'min(780px, 96vw)'}
        onClose={() => setOpen(false)}
      >
        {isLoading ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : runs.length === 0 ? (
          <Empty description={t('run.empty')} style={{ paddingBlock: 48 }} />
        ) : (
          <Flexbox gap={16}>
            <Flexbox horizontal gap={8} style={{ overflowX: 'auto', paddingBlockEnd: 4 }}>
              {runs.map(({ run }) => (
                <Button
                  key={run.id}
                  size={'small'}
                  type={run.id === selectedRunId ? 'primary' : 'default'}
                  onClick={() => setSelectedRunId(run.id)}
                >
                  {run.protocol} · {formatTime(run.createdAt)}
                </Button>
              ))}
            </Flexbox>

            {selectedRun && (
              <>
                <Flexbox horizontal align={'center'} gap={8} justify={'space-between'}>
                  <Flexbox gap={4} style={{ minWidth: 0 }}>
                    <Text code ellipsis style={{ maxWidth: 500 }}>
                      {selectedRun.run.id}
                    </Text>
                    <Text type={'secondary'}>
                      {selectedRun.run.protocol} · {formatTime(selectedRun.run.createdAt)}
                    </Text>
                  </Flexbox>
                  <Flexbox horizontal align={'center'} gap={8}>
                    <Tag color={statusColor(selectedRun.run.status)}>
                      {statusLabel(selectedRun.run.status)}
                    </Tag>
                    {ACTIVE_RUN_STATUSES.has(selectedRun.run.status) &&
                      selectedRun.run.status !== 'cancelling' && (
                        <Popconfirm
                          description={t('run.cancelConfirm')}
                          title={t('run.cancel')}
                          onConfirm={cancelRun}
                        >
                          <Button danger loading={cancelling} size={'small'}>
                            {t('run.cancel')}
                          </Button>
                        </Popconfirm>
                      )}
                  </Flexbox>
                </Flexbox>

                <Flexbox gap={8}>
                  <Text strong>{t('run.nodes')}</Text>
                  {selectedRun.nodes.map((node) => {
                    const attempts = selectedRun.attempts.filter(
                      (attempt) => attempt.runNodeId === node.id,
                    );
                    const canRetry =
                      TERMINAL_RUN_STATUSES.has(selectedRun.run.status) &&
                      TERMINAL_NODE_STATUSES.has(node.status) &&
                      attempts.length > 0 &&
                      attempts.length < node.maxAttempts;
                    return (
                      <Flexbox
                        gap={4}
                        key={node.id}
                        padding={12}
                        style={{
                          background: cssVar.colorFillQuaternary,
                          borderRadius: 8,
                        }}
                      >
                        <Flexbox horizontal align={'center'} gap={8} justify={'space-between'}>
                          <Text strong>{node.nodeKey}</Text>
                          <Tag color={statusColor(node.status)}>{statusLabel(node.status)}</Tag>
                        </Flexbox>
                        <Text>{node.instruction}</Text>
                        <Text type={'secondary'}>
                          {attempts.length} {t('run.attempts')}
                          {attempts.at(-1)?.operationId ? ` · ${attempts.at(-1)?.operationId}` : ''}
                        </Text>
                        {canRetry && (
                          <Popconfirm
                            description={t('run.retryConfirm')}
                            title={t('run.retry')}
                            onConfirm={() => retryNode(node.id)}
                          >
                            <Button
                              loading={retryingNodeId === node.id}
                              size={'small'}
                              style={{ alignSelf: 'flex-start' }}
                            >
                              {t('run.retry')}
                            </Button>
                          </Popconfirm>
                        )}
                      </Flexbox>
                    );
                  })}
                </Flexbox>

                <Flexbox gap={8}>
                  <Text strong>{t('run.events')}</Text>
                  {events.length === 0 ? (
                    <Text type={'secondary'}>{t('run.eventsEmpty')}</Text>
                  ) : (
                    events.map((event) => (
                      <Flexbox
                        horizontal
                        align={'baseline'}
                        gap={8}
                        key={event.id}
                        paddingBlock={4}
                        style={{ borderBottom: `1px solid ${cssVar.colorBorderSecondary}` }}
                      >
                        <Text code>{event.sequence}</Text>
                        <Text strong>{event.type}</Text>
                        {event.status && (
                          <Tag color={statusColor(event.status)}>{event.status}</Tag>
                        )}
                        <Text style={{ marginInlineStart: 'auto' }} type={'secondary'}>
                          {formatTime(event.createdAt)}
                        </Text>
                      </Flexbox>
                    ))
                  )}
                </Flexbox>
              </>
            )}
          </Flexbox>
        )}
      </Drawer>
    </>
  );
});

RunHistoryButton.displayName = 'RunHistoryButton';

export default RunHistoryButton;
