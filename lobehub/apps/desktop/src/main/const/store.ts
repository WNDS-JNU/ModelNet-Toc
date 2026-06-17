/**
 * Application settings storage related constants
 */
import { DEFAULT_ELECTRON_DESKTOP_SHORTCUTS } from '@lobechat/const/desktopGlobalShortcuts';
import type { DataSyncConfig, NetworkProxySettings } from '@lobechat/electron-client-ipc';

import { appStorageDir } from '@/const/dir';
import { IS_MODELNET_DESKTOP, MODELNET_DESKTOP_SERVER_URL } from '@/const/env';
import { UPDATE_CHANNEL } from '@/modules/updater/configs';
import type { ElectronMainStore } from '@/types/store';

/**
 * Storage name
 */
export const STORE_NAME = 'lobehub-settings';

export const defaultProxySettings: NetworkProxySettings = {
  enableProxy: false,
  proxyBypass: 'localhost, 127.0.0.1, ::1',
  proxyPort: '',
  proxyRequireAuth: false,
  proxyServer: '',
  proxyType: 'http',
};

export const DEFAULT_DATA_SYNC_CONFIG: DataSyncConfig = IS_MODELNET_DESKTOP
  ? { remoteServerUrl: MODELNET_DESKTOP_SERVER_URL, storageMode: 'selfHost' }
  : { storageMode: 'cloud' };

/**
 * Storage default values
 */
export const STORE_DEFAULTS: ElectronMainStore = {
  appTrayVisible: true,
  dataSyncConfig: DEFAULT_DATA_SYNC_CONFIG,
  encryptedTokens: {},
  gatewayDeviceDescription: '',
  gatewayDeviceId: '',
  gatewayDeviceName: '',
  gatewayEnabled: true,
  gatewayUrl: 'https://device-gateway.lobehub.com',
  locale: 'auto',
  localFileWorkspaceRoots: [],
  networkProxy: defaultProxySettings,
  pendingRestoreRoute: '',
  shortcuts: DEFAULT_ELECTRON_DESKTOP_SHORTCUTS,
  storagePath: appStorageDir,
  themeMode: 'system',
  updateChannel: UPDATE_CHANNEL,
};
