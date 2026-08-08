export {
  clearExtensionStorage,
  extensionServiceWorker,
  getExtensionStorage,
  listExtensions,
  openExtension,
  removeExtensionStorage,
  setExtensionStorage,
  triggerExtensionAction,
} from './extensions';
export { readExtensionManifest } from './manifest';
export type {
  ChromeExtension,
  ExtensionActionOptions,
  ExtensionSelector,
  ExtensionStorageArea,
  ExtensionStorageOptions,
  ExtensionStorageReadOptions,
} from './types';
export type { ExtensionManifest } from './manifest';
