import type { Browser, BrowserContext, Page } from 'playwright-core';

export type ChromeExtension = {
  id: string;
  name: string;
  version: string;
  path: string;
  enabled: boolean;
};

export type ExtensionSelector = {
  id?: string;
  name?: string | RegExp;
  path?: string;
};

export type ExtensionActionOptions = ExtensionSelector & {
  timeout?: number;
};

export function listExtensions(target: Browser | BrowserContext | Page): Promise<ChromeExtension[]>;
export function triggerExtensionAction(page: Page, options: ExtensionSelector): Promise<ChromeExtension>;
export function openExtension(page: Page, options: ExtensionActionOptions): Promise<Page>;
