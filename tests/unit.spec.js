const { expect, test } = require('playwright/test');

const { listExtensions, openExtension, triggerExtensionAction } = require('..');

const extension = {
  id: 'extension-id',
  name: 'JM MV3 Fixture',
  version: '1.0.0',
  path: '/fixtures/popup-extension',
  enabled: true,
};

function createHarness(options = {}) {
  const state = {
    browserSessionCount: 0,
    extensionReads: 0,
    extensionTargetReads: 0,
    events: [],
    openedURL: undefined,
    popupClosed: false,
    triggerParams: undefined,
  };
  const extensions = options.extensions || (() => [extension]);
  const pageTarget = {
    targetId: 'page-id',
    browserContextId: 'context-id',
    title: 'Target',
    type: 'page',
    url: 'about:blank',
  };
  const tabTargets = options.tabTargets || [{
    ...pageTarget,
    targetId: 'tab-id',
    type: 'tab',
  }];
  const extensionTargets = options.extensionTargets || [[]];
  const browser = {
    browserType: () => ({ name: () => 'chromium' }),
    newBrowserCDPSession: async () => {
      state.browserSessionCount++;
      return {
        detach: async () => {},
        send: async (method, params) => {
          if (method === 'Extensions.getExtensions') {
            if (options.extensionError)
              throw options.extensionError;
            return { extensions: extensions(++state.extensionReads) };
          }
          if (method === 'Extensions.triggerAction') {
            state.triggerParams = params;
            return {};
          }
          if (method === 'Target.getTargets' && params.filter.some(entry => entry.type === 'tab'))
            return { targetInfos: tabTargets };
          if (method === 'Target.getTargets') {
            const index = Math.min(state.extensionTargetReads++, extensionTargets.length - 1);
            return { targetInfos: extensionTargets[index] };
          }
          throw new Error(`Unexpected browser command: ${method}`);
        },
      };
    },
  };
  const popupPage = {
    close: async () => { state.popupClosed = true; },
    goto: async url => {
      state.events.push('popup-goto');
      state.openedURL = url;
      if (options.gotoError)
        throw options.gotoError;
    },
  };
  const context = {
    browser: () => browser,
    newCDPSession: async () => ({
      detach: async () => {},
      send: async method => {
        if (method === 'Target.getTargetInfo')
          return { targetInfo: pageTarget };
        throw new Error(`Unexpected page command: ${method}`);
      },
    }),
    newPage: async () => {
      state.events.push('new-page');
      return popupPage;
    },
  };
  const page = {
    bringToFront: async () => { state.events.push('target-front'); },
    context: () => context,
    url: () => pageTarget.url,
  };
  return { page, state };
}

test('ignores MV3 worker and offscreen targets, preserves the active tab, and reuses one browser CDP session', async () => {
  const popupURL = `chrome-extension://${extension.id}/popup.html`;
  const { page, state } = createHarness({
    extensions: read => read < 3 ? [] : [extension],
    extensionTargets: [
      [],
      [
        { targetId: 'worker-id', type: 'service_worker', url: `chrome-extension://${extension.id}/background.js` },
        { targetId: 'offscreen-id', type: 'background_page', url: `chrome-extension://${extension.id}/offscreen.html` },
      ],
      [{ targetId: 'popup-id', type: 'other', url: popupURL }],
    ],
  });

  await openExtension(page, { name: extension.name, timeout: 1_000 });

  expect(state.openedURL).toBe(popupURL);
  expect(state.browserSessionCount).toBe(1);
  expect(state.events.slice(-3)).toEqual(['new-page', 'target-front', 'popup-goto']);
});

test('finds a native popup after Chromium classifies it as a page', async () => {
  const popupURL = `chrome-extension://${extension.id}/popup.html`;
  const { page, state } = createHarness({
    extensionTargets: [[], [{ targetId: 'popup-id', type: 'page', url: popupURL }]],
  });

  await openExtension(page, { id: extension.id });
  expect(state.openedURL).toBe(popupURL);
});

for (const flags of ['g', 'y']) {
  test(`treats /${flags} name selectors as stateless`, async () => {
    const selector = new RegExp(extension.name, flags);
    selector.lastIndex = 1;
    const { page } = createHarness({
      extensions: () => [extension, { ...extension, id: 'second-extension-id' }],
    });

    await expect(triggerExtensionAction(page, { name: selector })).rejects.toThrow('matched multiple extensions');
    expect(selector.lastIndex).toBe(1);
  });
}

test('uses the sole active tab to disambiguate identical targets', async () => {
  const { page, state } = createHarness({
    tabTargets: [
      { targetId: 'inactive-tab', browserContextId: 'context-id', title: 'Target', type: 'tab', url: 'about:blank', embedderData: { tabActive: false } },
      { targetId: 'active-tab', browserContextId: 'context-id', title: 'Target', type: 'tab', url: 'about:blank', embedderData: { tabActive: true } },
    ],
  });

  await triggerExtensionAction(page, { id: extension.id });

  expect(state.triggerParams.targetId).toBe('active-tab');
});

test('still rejects multiple active matching tabs', async () => {
  const { page } = createHarness({
    tabTargets: ['first-tab', 'second-tab'].map(targetId => ({
      targetId,
      browserContextId: 'context-id',
      title: 'Target',
      type: 'tab',
      url: 'about:blank',
      embedderData: { tabActive: true },
    })),
  });

  await expect(triggerExtensionAction(page, { id: extension.id })).rejects.toThrow('Could not uniquely identify');
});

test('resolves relative selectors without treating an empty extension path as cwd', async () => {
  const cwdExtension = { ...extension, id: 'cwd-extension', path: process.cwd() };
  const { page, state } = createHarness({
    extensions: () => [{ ...extension, id: 'empty-path', path: '' }, cwdExtension],
  });

  await triggerExtensionAction(page, { path: '.' });
  expect(state.triggerParams.id).toBe(cwdExtension.id);
});

test('closes the tab-hosted copy when popup navigation fails', async () => {
  const popupURL = `chrome-extension://${extension.id}/popup.html`;
  const { page, state } = createHarness({
    extensionTargets: [[], [{ targetId: 'popup-id', type: 'other', url: popupURL }]],
    gotoError: new Error('navigation failed'),
  });

  await expect(openExtension(page, { id: extension.id })).rejects.toThrow('navigation failed');
  expect(state.popupClosed).toBe(true);
});

test('rejects ambiguous new extension targets', async () => {
  const { page } = createHarness({
    extensionTargets: [[], [
      { targetId: 'popup-id', type: 'other', url: `chrome-extension://${extension.id}/popup.html` },
      { targetId: 'offscreen-id', type: 'other', url: `chrome-extension://${extension.id}/offscreen.html` },
    ]],
  });

  await expect(openExtension(page, { id: extension.id })).rejects.toThrow('opened multiple popup-like targets');
});

test('explains when Chromium lacks the Extensions CDP domain', async () => {
  const { page } = createHarness({
    extensionError: new Error("Protocol error: 'Extensions.getExtensions' wasn't found"),
  });

  await expect(listExtensions(page)).rejects.toThrow('require a recent Chromium build with Extensions CDP support');
});
