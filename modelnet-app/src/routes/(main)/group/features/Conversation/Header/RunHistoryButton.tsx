'use client';

import { Empty, Flexbox } from '@lobehub/ui';
import { ActionIcon, Button, Drawer, Tag, Text, toast } from '@lobehub/ui/base-ui';
import { Popconfirm, Skeleton } from 'antd';
import { cssVar } from 'antd-style';
import { ExternalLink, History } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import { DESKTOP_HEADER_ICON_SIZE } from '@/const/layoutTokens';
import { buildWorkspaceAwarePath } from '@/features/Workspace/workspaceAwarePath';
import { useClientPollingSWR } from '@/libs/swr';
import { groupKeys } from '@/libs/swr/keys';
import { chatGroupService } from '@/services/chatGroup';

import { buildAgentGroupRunObservability } from './runObservability';

const ACTIVE_RUN_STATUSES = new Set(['pending', 'running', 'waiting', 'cancelling']);
const TERMINAL_NODE_STATUSES = new Set(['cancelled', 'completed', 'failed', 'skipped']);
const TERMINAL_RUN_STATUSES = new Set(['cancelled', 'completed', 'failed']);

const statusColor = (status: string) => {
  switch (status) {
    case 'completed': {
      return 'success';
    }
    case 'blocked':
    case 'failed':
    case 'timed_out': {
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

const formatCount = (value: number) => new Intl.NumberFormat().format(value);

const formatDuration = (milliseconds: number) => {
  if (milliseconds < 1000) return `${milliseconds} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
};

const MetricCard = ({ label, value }: { label: string; value: string }) => (
  <Flexbox
    gap={2}
    padding={10}
    style={{ background: cssVar.colorFillQuaternary, borderRadius: 8, minWidth: 112 }}
  >
    <Text fontSize={12} type={'secondary'}>
      {label}
    </Text>
    <Text strong>{value}</Text>
  </Flexbox>
);

interface RunHistoryButtonProps {
  groupId: string;
}

const RunHistoryButton = memo<RunHistoryButtonProps>(({ groupId }) => {
  const { t } = useTranslation('agentGroup');
  const activeWorkspaceSlug = useActiveWorkspaceSlug();
  const [open, setOpen] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [cancelling, setCancelling] = useState(false);
  const [pausing, setPausing] = useState(false);
  const [resuming, setResuming] = useState(false);
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

  const { data: runtimeHealth } = useClientPollingSWR(
    open ? groupKeys.runRuntimeHealth(groupId) : null,
    () => chatGroupService.getGroupRunRuntimeHealth(groupId),
    { refreshInterval: open ? 10_000 : 0 },
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
  const isManuallyPaused =
    selectedRun?.run.status === 'waiting' && selectedRun.run.completionReason === 'manual_pause';
  const isWaitingForIntervention =
    selectedRun?.run.status === 'waiting' &&
    selectedRun.run.completionReason === 'waiting_for_human';

  const { data: events = [], mutate: mutateEvents } = useClientPollingSWR(
    open && selectedRunId ? groupKeys.runEvents(selectedRunId) : null,
    () => chatGroupService.listGroupRunEvents(selectedRunId!),
    {
      refreshInterval: selectedRun && ACTIVE_RUN_STATUSES.has(selectedRun.run.status) ? 5000 : 0,
    },
  );

  const observability = useMemo(
    () => (selectedRun ? buildAgentGroupRunObservability(selectedRun, events) : undefined),
    [events, selectedRun],
  );
  const operationById = useMemo(
    () => new Map(selectedRun?.operations.map((operation) => [operation.id, operation]) ?? []),
    [selectedRun],
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
      case 'blocked': {
        return t('run.status.blocked');
      }
      case 'pending': {
        return t('run.status.pending');
      }
      case 'running': {
        return t('run.status.running');
      }
      case 'ready': {
        return t('run.status.ready');
      }
      case 'skipped': {
        return t('run.status.skipped');
      }
      case 'timed_out': {
        return t('run.status.timedOut');
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

  const pauseRun = async () => {
    if (!selectedRun) return;
    setPausing(true);
    try {
      await chatGroupService.pauseGroupRun(selectedRun.run.id);
      await Promise.all([mutateRuns(), mutateEvents()]);
      toast.success(t('run.paused'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('run.pauseFailed'));
    } finally {
      setPausing(false);
    }
  };

  const resumeRun = async () => {
    if (!selectedRun) return;
    setResuming(true);
    try {
      await chatGroupService.resumeGroupRun(selectedRun.run.id);
      await Promise.all([mutateRuns(), mutateEvents()]);
      toast.success(t('run.resumed'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('run.resumeFailed'));
    } finally {
      setResuming(false);
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
                      {isManuallyPaused
                        ? t('run.status.paused')
                        : isWaitingForIntervention
                          ? t('run.status.intervention')
                          : statusLabel(selectedRun.run.status)}
                    </Tag>
                    {selectedRun.run.status === 'running' && (
                      <Popconfirm
                        description={t('run.pauseConfirm')}
                        title={t('run.pause')}
                        onConfirm={pauseRun}
                      >
                        <Button loading={pausing} size={'small'}>
                          {t('run.pause')}
                        </Button>
                      </Popconfirm>
                    )}
                    {isManuallyPaused && (
                      <Popconfirm
                        description={t('run.resumeConfirm')}
                        title={t('run.resume')}
                        onConfirm={resumeRun}
                      >
                        <Button loading={resuming} size={'small'} type={'primary'}>
                          {t('run.resume')}
                        </Button>
                      </Popconfirm>
                    )}
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

                {isWaitingForIntervention && (
                  <Flexbox
                    gap={4}
                    padding={12}
                    style={{ background: cssVar.colorWarningBg, borderRadius: 8 }}
                  >
                    <Text strong>{t('run.intervention.title')}</Text>
                    <Text type={'secondary'}>{t('run.intervention.description')}</Text>
                  </Flexbox>
                )}

                <Flexbox gap={8}>
                  <Flexbox horizontal align={'center'} gap={8} justify={'space-between'}>
                    <Text strong>{t('run.runtime.title')}</Text>
                    {runtimeHealth && (
                      <Tag color={runtimeHealth.health.healthy ? 'success' : 'error'}>
                        {runtimeHealth.health.healthy
                          ? t('run.runtime.healthy')
                          : t('run.runtime.unhealthy')}
                      </Tag>
                    )}
                  </Flexbox>
                  {runtimeHealth ? (
                    <>
                      <Text type={'secondary'}>
                        {t('run.runtime.mode')}: {runtimeHealth.mode} ·{' '}
                        {formatTime(runtimeHealth.checkedAt)}
                        {runtimeHealth.health.message ? ` · ${runtimeHealth.health.message}` : ''}
                      </Text>
                      {runtimeHealth.stats && (
                        <div
                          style={{
                            display: 'grid',
                            gap: 8,
                            gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))',
                          }}
                        >
                          <MetricCard
                            label={t('run.runtime.pending')}
                            value={formatCount(runtimeHealth.stats.pendingCount)}
                          />
                          <MetricCard
                            label={t('run.runtime.processing')}
                            value={formatCount(runtimeHealth.stats.processingCount)}
                          />
                          <MetricCard
                            label={t('run.runtime.deadLetter')}
                            value={formatCount(runtimeHealth.stats.deadLetterCount)}
                          />
                          <MetricCard
                            label={t('run.runtime.failed')}
                            value={formatCount(runtimeHealth.stats.failedCount)}
                          />
                          <MetricCard
                            label={t('run.runtime.completed')}
                            value={formatCount(runtimeHealth.stats.completedCount)}
                          />
                        </div>
                      )}
                    </>
                  ) : (
                    <Text type={'secondary'}>{t('run.runtime.loading')}</Text>
                  )}
                </Flexbox>

                {observability && (
                  <Flexbox gap={8}>
                    <Text strong>{t('run.metrics.title')}</Text>
                    <div
                      style={{
                        display: 'grid',
                        gap: 8,
                        gridTemplateColumns: 'repeat(auto-fit, minmax(112px, 1fr))',
                      }}
                    >
                      <MetricCard
                        label={t('run.metrics.cost')}
                        value={`${observability.currencies.join('/') || 'USD'} ${observability.totalCost.toFixed(4)}`}
                      />
                      <MetricCard
                        label={t('run.metrics.tokens')}
                        value={formatCount(observability.totalTokens)}
                      />
                      <MetricCard
                        label={t('run.metrics.calls')}
                        value={`${formatCount(observability.llmCallCount)} / ${formatCount(observability.toolCallCount)}`}
                      />
                      <MetricCard
                        label={t('run.metrics.processing')}
                        value={formatDuration(observability.processingTimeMs)}
                      />
                      <MetricCard
                        label={t('run.metrics.approvals')}
                        value={formatCount(observability.humanInterventionCount)}
                      />
                      <MetricCard
                        label={t('run.metrics.barriers')}
                        value={formatCount(observability.waitingBarrierCount)}
                      />
                      <MetricCard
                        label={t('run.metrics.leases')}
                        value={`${observability.activeLeaseCount} / ${observability.expiredLeaseCount}`}
                      />
                      <MetricCard
                        label={t('run.metrics.failures')}
                        value={`${observability.attemptCount ? ((observability.failedAttemptCount / observability.attemptCount) * 100).toFixed(1) : '0.0'}% / ${observability.deviceOfflineCount}`}
                      />
                      <MetricCard
                        label={t('run.metrics.evidence')}
                        value={`${observability.workVersionIds.length} / ${observability.verifyRunIds.length} / ${observability.traceCount}`}
                      />
                    </div>
                    <Text fontSize={12} type={'secondary'}>
                      {t('run.metrics.legend')}
                    </Text>
                  </Flexbox>
                )}

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
                        <Text code fontSize={12} type={'secondary'}>
                          nodeId: {node.id}
                        </Text>
                        {node.dependencies.length > 0 && (
                          <Text fontSize={12} type={'secondary'}>
                            {t('run.dependencies')}: {node.dependencies.join(', ')}
                          </Text>
                        )}
                        {node.dispatchClaimId && (
                          <Text code fontSize={12} type={'secondary'}>
                            claimId: {node.dispatchClaimId} ·{' '}
                            {formatTime(node.dispatchClaimExpiresAt)}
                          </Text>
                        )}
                        <Flexbox gap={6} paddingBlock={4}>
                          <Text strong fontSize={12}>
                            {attempts.length} {t('run.attempts')}
                          </Text>
                          {attempts.map((attempt) => {
                            const operation = operationById.get(attempt.operationId);
                            const output = attempt.outputSnapshot;
                            const externalRef = attempt.externalExecutionRef;
                            const errorMessage =
                              attempt.error?.message ?? operation?.error?.message;
                            return (
                              <Flexbox
                                gap={4}
                                key={attempt.id}
                                padding={10}
                                style={{
                                  background: cssVar.colorBgContainer,
                                  border: `1px solid ${cssVar.colorBorderSecondary}`,
                                  borderRadius: 8,
                                }}
                              >
                                <Flexbox
                                  horizontal
                                  align={'center'}
                                  gap={8}
                                  justify={'space-between'}
                                >
                                  <Text strong>
                                    {t('run.attempt')} #{attempt.attemptNo} · {attempt.runtimeKind}
                                  </Text>
                                  <Tag color={statusColor(attempt.status)}>
                                    {statusLabel(attempt.status)}
                                  </Tag>
                                </Flexbox>
                                <Text code fontSize={12} type={'secondary'}>
                                  attemptId: {attempt.id}
                                </Text>
                                <Text code fontSize={12} type={'secondary'}>
                                  operationId: {attempt.operationId}
                                </Text>
                                {(externalRef?.taskId || externalRef?.contextId) && (
                                  <Text code fontSize={12} type={'secondary'}>
                                    external: {externalRef.taskId ?? '-'} /{' '}
                                    {externalRef.contextId ?? '-'}
                                  </Text>
                                )}
                                <Text fontSize={12} type={'secondary'}>
                                  {formatTime(attempt.startedAt ?? attempt.createdAt)} →{' '}
                                  {formatTime(attempt.completedAt)}
                                </Text>
                                {operation && (
                                  <Text fontSize={12} type={'secondary'}>
                                    {t('run.attempt.usage')}:{' '}
                                    {formatCount(operation.totalTokens ?? 0)} tokens ·{' '}
                                    {operation.llmCalls ?? 0} LLM · {operation.toolCalls ?? 0} tools
                                    · {operation.currency}{' '}
                                    {Number(operation.totalCost ?? 0).toFixed(4)}
                                    {operation.traceS3Key ? ` · ${t('run.attempt.trace')}` : ''}
                                  </Text>
                                )}
                                {output?.summary && <Text fontSize={12}>{output.summary}</Text>}
                                {output?.workspace && (
                                  <Flexbox gap={2}>
                                    <Text strong fontSize={12}>
                                      {t('run.attempt.workspace')}: {output.workspace.mode}
                                    </Text>
                                    <Text code fontSize={12} type={'secondary'}>
                                      isolationId: {output.workspace.isolationId}
                                    </Text>
                                    <Text fontSize={12} type={'secondary'}>
                                      {output.workspace.branch ?? output.workspace.baseRef ?? '-'} ·{' '}
                                      {output.workspace.changedFiles} files · +
                                      {output.workspace.additions} / -{output.workspace.deletions} ·{' '}
                                      {output.workspace.cleanupState}
                                    </Text>
                                    {output.workspace.worktreePath && (
                                      <Text code fontSize={12} type={'secondary'}>
                                        {output.workspace.worktreePath}
                                      </Text>
                                    )}
                                  </Flexbox>
                                )}
                                {(output?.workVersionRefs.length ?? 0) > 0 && (
                                  <Flexbox gap={2}>
                                    <Text strong fontSize={12}>
                                      {t('run.attempt.workVersions')}
                                    </Text>
                                    {(output?.workVersionRefs ?? []).map((reference) => (
                                      <Text
                                        code
                                        fontSize={12}
                                        key={reference.workVersionId}
                                        type={'secondary'}
                                      >
                                        {reference.workVersionId} · workId: {reference.workId}
                                      </Text>
                                    ))}
                                  </Flexbox>
                                )}
                                {output?.verifyRunId && (
                                  <Button
                                    icon={ExternalLink}
                                    size={'small'}
                                    style={{ alignSelf: 'flex-start' }}
                                    target={'_blank'}
                                    type={'link'}
                                    href={buildWorkspaceAwarePath(
                                      `/verify/${output.verifyRunId}`,
                                      activeWorkspaceSlug,
                                    )}
                                  >
                                    {t('run.attempt.openVerify')} · {output.verifyRunId}
                                  </Button>
                                )}
                                {errorMessage && (
                                  <Text fontSize={12} type={'danger'}>
                                    {errorMessage}
                                  </Text>
                                )}
                              </Flexbox>
                            );
                          })}
                        </Flexbox>
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
