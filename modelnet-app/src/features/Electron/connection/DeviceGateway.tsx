import { useWatchBroadcast } from '@lobechat/electron-client-ipc';
import { Flexbox } from '@lobehub/ui';
import { ActionIcon, Popover, Switch } from '@lobehub/ui/base-ui';
import { Input } from 'antd';
import { createStaticStyles } from 'antd-style';
import { HardDrive, SettingsIcon } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useActiveWorkspaceSlug } from '@/business/client/hooks/useActiveWorkspaceSlug';
import { useWorkspaceAwareNavigate } from '@/features/Workspace/useWorkspaceAwareNavigate';
import { useElectronStore } from '@/store/electron';
import { electronSyncSelectors } from '@/store/electron/selectors';

const styles = createStaticStyles(({ css, cssVar }) => ({
  errorText: css`
    font-size: 12px;
    color: ${cssVar.colorError};
  `,
  fieldLabel: css`
    font-size: 12px;
    color: ${cssVar.colorTextDescription};
  `,
  greenDot: css`
    position: absolute;
    inset-block-end: 0;
    inset-inline-end: 0;

    width: 8px;
    height: 8px;
    border: 1.5px solid ${cssVar.colorBgContainer};
    border-radius: 50%;

    background: #52c41a;
  `,
  input: css`
    border: none;
    background: ${cssVar.colorFillTertiary};

    &:hover,
    &:focus {
      background: ${cssVar.colorFillSecondary};
    }
  `,
  popoverContent: css`
    width: 280px;
  `,
  scopeHint: css`
    font-size: 11px;
    line-height: 1.4;
    color: ${cssVar.colorTextDescription};
    white-space: nowrap;
  `,
  statusTitle: css`
    font-size: 13px;
    font-weight: 500;
    color: ${cssVar.colorText};
  `,
}));

const DeviceGateway = memo(() => {
  const { t } = useTranslation('electron');
  const navigate = useWorkspaceAwareNavigate();
  const [
    gatewayStatus,
    gatewayError,
    connectGateway,
    disconnectGateway,
    setGatewayConnectionStatus,
    useFetchGatewayStatus,
    useFetchGatewayDeviceInfo,
    updateDeviceName,
    updateDeviceDescription,
    gatewayDeviceInfo,
  ] = useElectronStore((s) => [
    s.gatewayConnectionStatus,
    s.gatewayConnectionError,
    s.connectGateway,
    s.disconnectGateway,
    s.setGatewayConnectionStatus,
    s.useFetchGatewayStatus,
    s.useFetchGatewayDeviceInfo,
    s.updateDeviceName,
    s.updateDeviceDescription,
    s.gatewayDeviceInfo,
  ]);

  useFetchGatewayStatus();
  useFetchGatewayDeviceInfo();

  useWatchBroadcast('gatewayConnectionStatusChanged', ({ error, status }) => {
    setGatewayConnectionStatus(status, error);
  });

  const isConnected = gatewayStatus === 'connected';
  const isConnecting =
    gatewayStatus === 'authenticating' ||
    gatewayStatus === 'connecting' ||
    gatewayStatus === 'reconnecting';

  const [localName, setLocalName] = useState<string | undefined>();
  const [localDescription, setLocalDescription] = useState<string | undefined>();
  const [open, setOpen] = useState(false);

  const handleSwitchChange = useCallback(
    async (checked: boolean) => {
      if (checked) {
        await connectGateway();
      } else {
        await disconnectGateway();
      }
    },
    [connectGateway, disconnectGateway],
  );

  const handleNameBlur = useCallback(() => {
    if (localName !== undefined && localName !== gatewayDeviceInfo?.name) {
      updateDeviceName(localName);
    }
    setLocalName(undefined);
  }, [gatewayDeviceInfo?.name, localName, updateDeviceName]);

  const handleDescriptionBlur = useCallback(() => {
    if (localDescription !== undefined && localDescription !== gatewayDeviceInfo?.description) {
      updateDeviceDescription(localDescription);
    }
    setLocalDescription(undefined);
  }, [gatewayDeviceInfo?.description, localDescription, updateDeviceDescription]);

  const connectionHint = t(
    isConnecting
      ? 'gateway.statusConnecting'
      : isConnected
        ? 'gateway.statusConnected'
        : 'gateway.statusDisconnected',
  );

  const popoverContent = (
    <Flexbox className={styles.popoverContent} gap={16}>
      <Flexbox horizontal align="center" justify="space-between">
        <span className={styles.statusTitle}>{t('gateway.title')}</span>
        <Flexbox horizontal align="center" gap={6}>
          <ActionIcon
            aria-label={t('gateway.manageDevices')}
            icon={SettingsIcon}
            size="small"
            title={t('gateway.manageDevices')}
            onClick={() => {
              setOpen(false);
              navigate('/settings/devices', { escape: true });
            }}
          />
          <Switch
            aria-label={t('gateway.enableConnection')}
            checked={isConnected || isConnecting}
            loading={isConnecting}
            size="small"
            onChange={handleSwitchChange}
          />
        </Flexbox>
      </Flexbox>
      {gatewayError && <span className={styles.errorText}>{gatewayError}</span>}
      <Flexbox gap={4}>
        <span className={styles.fieldLabel}>{t('gateway.deviceName')}</span>
        <Input
          className={styles.input}
          placeholder={t('gateway.deviceNamePlaceholder')}
          size="small"
          value={localName ?? gatewayDeviceInfo?.name ?? ''}
          variant="filled"
          onBlur={handleNameBlur}
          onChange={(event) => setLocalName(event.target.value)}
          onPressEnter={handleNameBlur}
        />
      </Flexbox>
      <Flexbox gap={4}>
        <span className={styles.fieldLabel}>{t('gateway.description')}</span>
        <Input.TextArea
          autoSize={{ maxRows: 3, minRows: 2 }}
          className={styles.input}
          placeholder={t('gateway.descriptionPlaceholder')}
          size="small"
          value={localDescription ?? gatewayDeviceInfo?.description ?? ''}
          variant="filled"
          onBlur={handleDescriptionBlur}
          onChange={(event) => setLocalDescription(event.target.value)}
        />
      </Flexbox>
      <span className={styles.scopeHint}>{connectionHint}</span>
    </Flexbox>
  );

  return (
    <Popover
      arrow={false}
      content={popoverContent}
      open={open}
      placement="bottomRight"
      styles={{ content: { padding: 8 } }}
      trigger="click"
      onOpenChange={setOpen}
    >
      <div style={{ position: 'relative' }}>
        <ActionIcon
          icon={HardDrive}
          loading={isConnecting}
          size="small"
          title={t('gateway.title')}
          tooltipProps={{ placement: 'bottomRight' }}
        />
        {isConnected && <div className={styles.greenDot} />}
      </div>
    </Popover>
  );
});

const DeviceGatewayWithAuth = memo(() => {
  const isSyncActive = useElectronStore(electronSyncSelectors.isSyncActive);
  const activeWorkspaceSlug = useActiveWorkspaceSlug();

  if (!isSyncActive || activeWorkspaceSlug) return null;

  return <DeviceGateway />;
});

export default DeviceGatewayWithAuth;
