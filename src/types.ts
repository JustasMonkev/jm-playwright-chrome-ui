import type { Browser, BrowserContext, Page } from 'playwright-core';

export type ChromeExtension = {
  id: string;
  name: string;
  version: string;
  path: string;
  enabled: boolean;
  /**
   * Read from the extension's manifest.json. Undefined when the manifest could not be read,
   * which happens for extensions whose directory is not reachable from the test process.
   */
  manifestVersion?: number;
};

export type ExtensionSelector = {
  id?: string;
  name?: string | RegExp;
  path?: string;
};

export type ExtensionActionOptions = ExtensionSelector & {
  timeout?: number;
};

export type ExtensionStorageArea = 'session' | 'local' | 'sync' | 'managed';

export type ExtensionStorageOptions = ExtensionActionOptions & {
  area?: ExtensionStorageArea;
};

export type ExtensionStorageReadOptions = ExtensionStorageOptions & {
  keys?: string[];
};

export type ChromeUITarget = Browser | BrowserContext | Page;

export type TargetInfo = {
  targetId: string;
  browserContextId?: string;
  title?: string;
  type?: string;
  url: string;
  /**
   * False for Chrome's own action popup bubble, true for every page Playwright owns. This is
   * what separates the bubble from a tab the test (or the extension) opened on the same URL.
   */
  attached?: boolean;
};
