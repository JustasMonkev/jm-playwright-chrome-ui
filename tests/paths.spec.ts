import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { expect, test } from 'playwright/test';

import { canonicalPath, samePath } from '../src/paths';

test('matches a relative path against the absolute path Chrome reports', () => {
  const absolute = path.join(__dirname, 'fixtures', 'mv3-offscreen');
  const relative = path.relative(process.cwd(), absolute);
  expect(samePath(relative, absolute)).toBe(true);
});

test('ignores a trailing separator', () => {
  const absolute = path.join(__dirname, 'fixtures', 'mv3-offscreen');
  expect(samePath(absolute + path.sep, absolute)).toBe(true);
});

test('ignores redundant segments', () => {
  const absolute = path.join(__dirname, 'fixtures', 'mv3-offscreen');
  const noisy = path.join(__dirname, 'fixtures', '.', '..', 'fixtures', 'mv3-offscreen');
  expect(samePath(noisy, absolute)).toBe(true);
});

test('resolves symlinks, which is how Chrome reports the path', () => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-real-'));
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ext-link-')), 'ext');
  fs.symlinkSync(real, link, 'dir');

  expect(samePath(link, real)).toBe(true);
  expect(canonicalPath(link)).toBe(canonicalPath(real));
});

test('falls back to the lexical path when the directory does not exist', () => {
  const missing = path.join(os.tmpdir(), 'nope-not-here', 'ext');
  expect(canonicalPath(missing)).toBe(path.normalize(missing));
  expect(samePath(missing, missing)).toBe(true);
});

test('does not treat different directories as equal', () => {
  const fixtures = path.join(__dirname, 'fixtures');
  expect(samePath(path.join(fixtures, 'mv3-offscreen'), path.join(fixtures, 'mv3-no-popup'))).toBe(false);
});
