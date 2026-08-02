export const SKS_MENUBAR_LABEL = 'com.sneakoscope.sks-menubar';
export const CONTROL_CENTER_DOMAIN = 'com.apple.controlcenter';
export const CONTROL_CENTER_PREFERRED_POSITION = 360;
export const SECRET_LAUNCH_ENV_KEYS = ['CODEX_LB_API_KEY', 'OPENROUTER_API_KEY'] as const;

export const MENU_ITEMS = [
  'Open SKS Control Center',
  'Pending approvals',
  'Check for Updates',
  'View Last Operation',
  'Quit SKS Menu'
] as const;

export const NATIVE_SOURCE_FILES = [
  'main.swift',
  'AppDelegate.swift',
  'StatusItemController.swift',
  'ControlCenterWindowController.swift',
  'SidebarItem.swift',
  'ControlKit.swift',
  'OverviewViewController.swift',
  'OverviewSummary.swift',
  'UpdatesViewController.swift',
  'MCPServersViewController.swift',
  'ProvidersViewController.swift',
  'ProvidersConnectTest.swift',
  'ProvidersRoutingTruth.swift',
  'ProvidersFastMode.swift',
  'ProvidersOpenRouter.swift',
  'ProvidersRoleModels.swift',
  'ProvidersMultiProvider.swift',
  'RemoteCodingViewController.swift',
  'DiagnosticsViewController.swift',
  'SettingsViewController.swift',
  'OperationCoordinator.swift',
  'ProcessClient.swift',
  'ProcessExecutionState.swift',
  'ProcessIdentityGuard.swift',
  'SecureProcessEnvelope.swift',
  'TelegramStateLock.swift',
  'TelegramPrivateFileSupport.swift',
  'TelegramPrivateFileStore.swift',
  'TelegramSupport.swift',
  'TelegramRuntimeSupport.swift',
  'TelegramTransport.swift',
  'TelegramProcessGateway.swift',
  'NotificationCoordinator.swift',
  'AlertFactory.swift',
  'AppIdentity.swift',
  'SingletonInstanceGuard.swift'
] as const;

export const NATIVE_RESOURCE_FILES = [
  'AppIcon.icns',
  'SKSStatusTemplate.pdf',
  'SKSStatusUpdateTemplate.pdf',
  'SKSStatusWarningTemplate.pdf',
  'SKSStatusAttentionTemplate.pdf',
  'Localizable.strings'
] as const;
