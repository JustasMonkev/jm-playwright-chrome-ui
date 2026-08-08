import * as fs from 'node:fs';
import * as path from 'node:path';

// Chrome reports an extension's path as an absolute, symlink-resolved directory. Callers
// naturally pass whatever they handed to --load-extension, which is often relative and may
// travel through symlinks (/tmp on macOS, pnpm stores, workspace links). Compare canonical
// forms so both spellings of the same directory match.
export function canonicalPath(value: string): string {
  const absolute = path.resolve(value);
  let resolved = absolute;
  try {
    resolved = fs.realpathSync.native(absolute);
  } catch {
    // The path may not exist locally — Chrome could be running on another machine, or the
    // directory may have been cleaned up. Fall back to the lexical form.
  }
  const normalized = path.normalize(resolved).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}
