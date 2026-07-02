import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = resolve(desktopRoot, '../..');

const desktopOnboardingLocaleSurfaces = readdirSync(resolve(repoRoot, 'locales'), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(repoRoot, 'locales', entry.name, 'desktop-onboarding.json'))
  .filter(existsSync);

const desktopLocaleCommonSurfaces = readdirSync(resolve(desktopRoot, 'resources/locales'), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => resolve(desktopRoot, 'resources/locales', entry.name, 'common.json'));

const brandingSurfaces = [
  resolve(repoRoot, 'src/locales/default/desktop-onboarding.ts'),
  ...desktopOnboardingLocaleSurfaces,
  resolve(repoRoot, 'src/routes/(desktop)/desktop-onboarding/_layout/index.tsx'),
  resolve(desktopRoot, 'index.html'),
  resolve(desktopRoot, 'popup.html'),
  resolve(desktopRoot, 'resources/splash.html'),
  resolve(desktopRoot, 'resources/error.html'),
  resolve(desktopRoot, 'src/main/locales/default/common.ts'),
  ...desktopLocaleCommonSurfaces,
  resolve(desktopRoot, 'stubs/business-const/src/index.ts'),
];

const readSurface = (file: string) => readFileSync(file, 'utf8');

const displayPath = (file: string) => relative(repoRoot, file);

describe('ModelNet desktop branding', () => {
  it('does not show LobeHub on desktop auth and startup surfaces', () => {
    const offenders = brandingSurfaces.flatMap((file) =>
      readSurface(file)
        .split(/\r?\n/)
        .flatMap((line, index) =>
          line.includes('LobeHub') ? [`${displayPath(file)}:${index + 1}: ${line.trim()}`] : [],
        ),
    );

    expect(offenders).toEqual([]);
  });

  it('keeps desktop auth and startup surfaces branded as ModelNet', () => {
    const missing = brandingSurfaces
      .filter((file) => !readSurface(file).includes('ModelNet'))
      .map(displayPath);

    expect(missing).toEqual([]);
  });
});
