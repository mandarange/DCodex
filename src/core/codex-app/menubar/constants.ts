export const SKS_MENUBAR_LABEL = 'com.sneakoscope.sks-menubar';
export const CONTROL_CENTER_DOMAIN = 'com.apple.controlcenter';
export const CONTROL_CENTER_PREFERRED_POSITION = 360;

export const MENU_ITEMS = [
  'Open SKS Control Center',
  'Pending approvals',
  'Check for Updates',
  'View Last Operation',
  'Hide Until Codex Opens'
] as const;

export const NATIVE_SOURCE_FILES = [
  'main.swift',
  'AppDelegate.swift',
  'StatusItemController.swift',
  'CodexLifecyclePolicy.swift',
  'ControlCenterWindowController.swift',
  'SidebarItem.swift',
  'ControlKit.swift',
  'OverviewViewController.swift',
  'OverviewSummary.swift',
  'UpdatesViewController.swift',
  'MCPServersViewController.swift',
  'ProvidersViewController.swift',
  'ProvidersReliability.swift',
  'ProvidersRoutingTruth.swift',
  'ProvidersOpenRouter.swift',
  'ProvidersModelExposure.swift',
  'ProvidersBridgeCatalog.swift',
  'RemoteCodingViewController.swift',
  'DiagnosticsViewController.swift',
  'SettingsViewController.swift',
  'OperationModels.swift',
  'ProviderRouteExplanation.swift',
  'OperationCoordinator.swift',
  'ProcessClient.swift',
  'ProcessExecutionState.swift',
  'ProcessIdentityGuard.swift',
  'SecureProcessEnvelope.swift',
  'SKSKeychainStore.swift',
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
