import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {chromium, expect, test} from 'playwright/test';

import {openExtension} from '..';

type CustomSite = {
    host: string;
    mode: string;
    enabled: boolean;
};

const extensionPath = process.env.YOUTUBE_SHORT_BLOCKER_DIST ||
    path.join(os.homedir(), 'Desktop', 'youtube-short-blocker', 'dist');

test('adds facebook.com to the YouTube Shorts Blocker blocklist', async ({}, testInfo) => {
    test.skip(!fs.existsSync(path.join(extensionPath, 'manifest.json')), `Missing extension build at ${extensionPath}`);


    const context = await chromium.launchPersistentContext(testInfo.outputPath('user-data-dir'), {
        headless: false,
        args: [
            '--enable-unsafe-extension-debugging',
            `--disable-extensions-except=${extensionPath}`,
            `--load-extension=${extensionPath}`,
        ],
    });

    const page = await context.newPage();
    await page.goto('https://example.com');

    const extensionPage = await openExtension(page, {name: 'YouTube Shorts Blocker', path: extensionPath, timeout: 10000});
    await extensionPage.locator('#custom-site').fill('facebook.com');
    await extensionPage.getByRole('button', {name: 'Add to blocklist'}).click();

    await expect(extensionPage.getByText('facebook.com', {exact: true})).toBeVisible();
    const customSites = await extensionPage.evaluate<CustomSite[]>(() => new Promise(resolve => {
        (globalThis as any).chrome.storage.sync.get(['customSites'], (result: {
            customSites: CustomSite[]
        }) => resolve(result.customSites));
    }));

    expect(customSites).toEqual([
        expect.objectContaining({
            host: 'facebook.com',
            mode: 'block',
            enabled: true,
        }),
    ]);

    await context.close();
});
