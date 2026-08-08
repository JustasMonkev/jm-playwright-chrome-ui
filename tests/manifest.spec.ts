import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { expect, test } from 'playwright/test';

import { extensionResourceURL, readExtensionManifest } from '../src/manifest';

const fixtures = path.join(__dirname, 'fixtures');

function writeManifest(manifest: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), manifest);
  return dir;
}

test('reads the MV3 action popup', () => {
  const manifest = readExtensionManifest(path.join(fixtures, 'mv3-offscreen'));
  expect(manifest.manifestVersion).toBe(3);
  expect(manifest.name).toBe('MV3 Offscreen Fixture');
  expect(manifest.defaultPopup).toBe('popup.html');
  expect(manifest.optionsPage).toBe('options.html');
});

test('reports no popup when the MV3 action omits default_popup', () => {
  const manifest = readExtensionManifest(path.join(fixtures, 'mv3-no-popup'));
  expect(manifest.manifestVersion).toBe(3);
  expect(manifest.defaultPopup).toBeUndefined();
});

test('reads a popup nested in a subdirectory', () => {
  const manifest = readExtensionManifest(path.join(fixtures, 'mv3-nested-popup'));
  expect(manifest.defaultPopup).toBe('ui/popup.html');
});

test('falls back to the MV2 browser_action and page_action popups', () => {
  const browserAction = readExtensionManifest(writeManifest(
    '{"manifest_version":2,"name":"MV2","browser_action":{"default_popup":"b.html"}}'));
  expect(browserAction.manifestVersion).toBe(2);
  expect(browserAction.defaultPopup).toBe('b.html');

  const pageAction = readExtensionManifest(writeManifest(
    '{"manifest_version":2,"name":"MV2","page_action":{"default_popup":"p.html"}}'));
  expect(pageAction.defaultPopup).toBe('p.html');
});

test('prefers action over a stray browser_action, the way Chrome does under MV3', () => {
  const manifest = readExtensionManifest(writeManifest(
    '{"manifest_version":3,"name":"Both","action":{"default_popup":"a.html"},"browser_action":{"default_popup":"b.html"}}'));
  expect(manifest.defaultPopup).toBe('a.html');
});

test('ignores an MV3 action key on an MV2 manifest, which Chrome does not honour', () => {
  const manifest = readExtensionManifest(writeManifest(
    '{"manifest_version":2,"name":"Legacy","action":{"default_popup":"a.html"},"browser_action":{"default_popup":"b.html"}}'));
  expect(manifest.defaultPopup).toBe('b.html');
});

test('treats an empty default_popup as no popup, since Chrome opens nothing for it', () => {
  const manifest = readExtensionManifest(writeManifest(
    '{"manifest_version":3,"name":"Empty","action":{"default_popup":""}}'));
  expect(manifest.defaultPopup).toBeUndefined();
});

test('keeps a __MSG_ placeholder verbatim, because Chrome does not localise default_popup', () => {
  const manifest = readExtensionManifest(writeManifest(
    '{"manifest_version":3,"name":"Msg","action":{"default_popup":"__MSG_popupFile__"}}'));
  expect(manifest.defaultPopup).toBe('__MSG_popupFile__');
});

test('reads options_ui.page as well as options_page', () => {
  const optionsUi = readExtensionManifest(writeManifest(
    '{"manifest_version":3,"name":"X","options_ui":{"page":"o.html"}}'));
  expect(optionsUi.optionsPage).toBe('o.html');
});

test('reads the side panel default path', () => {
  const manifest = readExtensionManifest(writeManifest(
    '{"manifest_version":3,"name":"X","side_panel":{"default_path":"panel.html"}}'));
  expect(manifest.sidePanelPath).toBe('panel.html');
});

test('tolerates comments, which Chrome accepts but JSON.parse does not', () => {
  const manifest = readExtensionManifest(writeManifest(`{
    // the toolbar popup
    "manifest_version": 3,
    "name": "Commented",
    /* block comment */
    "action": { "default_popup": "popup.html" }
  }`));
  expect(manifest.manifestVersion).toBe(3);
  expect(manifest.name).toBe('Commented');
  expect(manifest.defaultPopup).toBe('popup.html');
});

test('tolerates a UTF-8 BOM, which Chrome accepts but JSON.parse does not', () => {
  const manifest = readExtensionManifest(writeManifest(
    '﻿{"manifest_version":3,"name":"BOM","action":{"default_popup":"popup.html"}}'));
  expect(manifest.name).toBe('BOM');
  expect(manifest.defaultPopup).toBe('popup.html');
});

test('does not strip comment-like sequences inside strings', () => {
  const manifest = readExtensionManifest(writeManifest(
    '{"manifest_version":3,"name":"http://example.com/*","action":{"default_popup":"a//b.html"}}'));
  expect(manifest.name).toBe('http://example.com/*');
  expect(manifest.defaultPopup).toBe('a//b.html');
});

test('defaults manifest_version to 2 when absent', () => {
  const manifest = readExtensionManifest(writeManifest('{"name":"Ancient"}'));
  expect(manifest.manifestVersion).toBe(2);
});

test('explains which manifest could not be read', () => {
  const missing = path.join(os.tmpdir(), 'definitely-not-an-extension-dir');
  expect(() => readExtensionManifest(missing)).toThrow(/Could not read the extension manifest/);
});

test('explains which manifest could not be parsed', () => {
  const dir = writeManifest('{ this is not json }');
  expect(() => readExtensionManifest(dir)).toThrow(/Could not parse the extension manifest/);
});

test('resolves manifest resource paths the way Chrome does', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  expect(extensionResourceURL(id, 'popup.html')).toBe(`chrome-extension://${id}/popup.html`);
  expect(extensionResourceURL(id, '/popup.html')).toBe(`chrome-extension://${id}/popup.html`);
  expect(extensionResourceURL(id, 'ui/popup.html')).toBe(`chrome-extension://${id}/ui/popup.html`);
  expect(extensionResourceURL(id, 'popup.html?tab=1')).toBe(`chrome-extension://${id}/popup.html?tab=1`);
  expect(extensionResourceURL(id, './popup.html')).toBe(`chrome-extension://${id}/popup.html`);
  // Traversal cannot climb past the origin root.
  expect(extensionResourceURL(id, '../../etc/passwd')).toBe(`chrome-extension://${id}/etc/passwd`);
});

test('refuses a manifest resource that points outside the extension', () => {
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  for (const escape of ['//evil.example/x', 'http://evil.example/x', 'javascript:alert(1)', 'data:text/html,x'])
    expect(() => extensionResourceURL(id, escape)).toThrow(/outside the extension's origin/);
});
