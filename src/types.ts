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
};

export type ExtensionActionOptions = ExtensionSelector & {
  timeout?: number;
};

export type ChromeUITarget = Browser | BrowserContext | Page;

export type TargetInfo = {
  targetId: string;
  browserContextId?: string;
  title?: string;
  type?: string;
  url: string;
};

