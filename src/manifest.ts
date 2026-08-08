import * as fs from 'node:fs';
import * as path from 'node:path';

export type ExtensionManifest = {
  manifestVersion: number;
  name?: string;
  defaultPopup?: string;
  optionsPage?: string;
  sidePanelPath?: string;
};

// Resolving the popup from the manifest is what makes this library MV3-safe. Watching for a
// new chrome-extension:// target after clicking the action cannot tell an action popup from a
// service worker restart or an offscreen document the worker just created.
export function readExtensionManifest(extensionPath: string): ExtensionManifest {
  const manifestPath = path.join(extensionPath, 'manifest.json');

  let source: string;
  try {
    source = fs.readFileSync(manifestPath, 'utf8');
  } catch (error: any) {
    throw new Error(`Could not read the extension manifest at ${manifestPath}: ${error.message}. Chrome UI helpers need filesystem access to the unpacked extension directory.`);
  }

  let manifest: any;
  try {
    manifest = JSON.parse(stripJSONComments(source));
  } catch (error: any) {
    throw new Error(`Could not parse the extension manifest at ${manifestPath}: ${error.message}`);
  }

  const manifestVersion = Number(manifest.manifest_version) || 2;
  return {
    manifestVersion,
    name: typeof manifest.name === 'string' ? manifest.name : undefined,
    defaultPopup: defaultPopupFrom(manifest, manifestVersion),
    optionsPage: optionsPageFrom(manifest),
    sidePanelPath: typeof manifest.side_panel?.default_path === 'string' ? manifest.side_panel.default_path : undefined,
  };
}

// `resource` comes from the manifest, so it may be "popup.html", "/popup.html",
// "ui/popup.html", or carry a query string. Resolving against the extension origin applies the
// same rules Chrome does.
export function extensionResourceURL(extensionId: string, resource: string): string {
  const url = new URL(resource, `chrome-extension://${extensionId}/`);
  // A manifest entry is meant to be a relative path, but URL resolution happily follows
  // "//host/x", "http://host/x" or "javascript:..." somewhere else entirely. Refuse to hand
  // back anything that leaves the extension, rather than navigating a test browser to it.
  if (url.protocol !== 'chrome-extension:' || url.hostname !== extensionId.toLowerCase()) {
    throw new Error(`Extension resource "${resource}" resolves to ${url.toString()}, which is outside the extension's origin.`);
  }
  return url.toString();
}

// Chrome keys the toolbar action off manifest_version, not off whichever key happens to be
// present: an MV3 manifest carrying a stray legacy `browser_action` still uses `action`.
// An empty default_popup installs fine but opens nothing, so it counts as absent rather than
// resolving to the extension root.
function defaultPopupFrom(manifest: any, manifestVersion: number): string | undefined {
  const popup = manifestVersion >= 3
    ? manifest.action?.default_popup
    : manifest.browser_action?.default_popup ?? manifest.page_action?.default_popup;
  return typeof popup === 'string' && popup ? popup : undefined;
}

function optionsPageFrom(manifest: any): string | undefined {
  const page = manifest.options_ui?.page ?? manifest.options_page;
  return typeof page === 'string' && page ? page : undefined;
}

// Chrome accepts JavaScript-style comments and a UTF-8 BOM in manifest.json; JSON.parse rejects
// both. Trailing commas are deliberately left alone — Chrome refuses to install a manifest that
// has one, so such an extension can never be running for us to inspect.
function stripJSONComments(source: string): string {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === '\\') {
        out += next ?? '';
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }
    out += char;
  }

  return out;
}
