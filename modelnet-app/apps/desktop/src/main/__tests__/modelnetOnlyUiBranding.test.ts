import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const repoRoot = resolve(desktopRoot, '../..');

const readRepoFile = (file: string) => readFileSync(resolve(repoRoot, file), 'utf8');

const listJsonFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);

    if (entry.isDirectory()) return listJsonFiles(path);
    return entry.isFile() && entry.name.endsWith('.json') ? [path] : [];
  });

const listTextFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);

    if (entry.isDirectory()) return listTextFiles(path);
    return entry.isFile() && /\.(?:md|ts|tsx)$/.test(entry.name) ? [path] : [];
  });

const collectStringValues = (value: unknown): string[] => {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(collectStringValues);
  }

  return [];
};

const retiredBrandUrl = /lobehub\.com|github\.com\/lobehub/i;

describe('ModelNet-only renderer branding', () => {
  it('uses ModelNet branding components without a LobeHub visual fallback', () => {
    const watermark = readRepoFile('src/components/BrandWatermark/index.tsx');
    const productLogo = readRepoFile('src/components/Branding/ProductLogo/index.tsx');
    const orgBrand = readRepoFile('src/components/Branding/OrgBrand/index.tsx');

    expect(watermark).toContain('ORG_NAME');
    expect(watermark).toContain('Powered by');
    expect(watermark).not.toMatch(/<LobeHub\b|@lobehub\/ui\/brand/);
    expect(watermark).not.toMatch(retiredBrandUrl);

    expect(productLogo).toContain('<CustomLogo');
    expect(productLogo).not.toMatch(/<LobeHub\b|@lobehub\/ui\/brand/);
    expect(productLogo).not.toContain('isCustomBranding');

    expect(orgBrand).toContain('ORG_NAME');
    expect(orgBrand).not.toMatch(/<LobeHub\b|@lobehub\/ui\/brand/);
    expect(orgBrand).not.toContain('isCustomORG');
  });

  it('renders the legacy internal provider id with ModelNet name and logo', () => {
    const modelSelect = readRepoFile('src/components/ModelSelect/index.tsx');

    expect(modelSelect).toContain('BRANDING_NAME');
    expect(modelSelect).toContain('ProductLogo');
    expect(modelSelect).not.toMatch(/<LobeHub\.Morden\b/);
    expect(modelSelect).not.toMatch(
      /import\s*\{[^}]*\bLobeHub\b[^}]*\}\s*from\s*['"]@lobehub\/icons['"]/,
    );
  });

  it('publishes ModelNet provider metadata while preserving compatibility ids', () => {
    const legacyProvider = readRepoFile('packages/model-bank/src/modelProviders/lobehub.ts');
    const modelnetProvider = readRepoFile('packages/model-bank/src/modelProviders/modelnet.ts');

    expect(legacyProvider).toContain("id: 'lobehub'");
    expect(legacyProvider).toMatch(/name:\s*['"]ModelNet Cloud['"]/);
    expect(legacyProvider).toMatch(/description:[\s\S]*ModelNet/);
    expect(legacyProvider).not.toMatch(/name:\s*['"]LobeHub['"]|LobeHub Cloud/);
    expect(legacyProvider).not.toMatch(retiredBrandUrl);

    expect(modelnetProvider).toContain("name: 'ModelNet'");
    expect(modelnetProvider).toContain('https://github.com/WNDS-JNU/ModelNet-Toc');
    expect(modelnetProvider).not.toMatch(retiredBrandUrl);
  });
});

describe('ModelNet-only skill branding', () => {
  it('uses ModelNet as the visible author for predefined and built-in skills', () => {
    const providers = readRepoFile('packages/const/src/lobehubSkill.ts');
    const skillList = readRepoFile('src/features/SkillStore/SkillList/LobeHub/index.tsx');
    const selectors = readRepoFile('src/store/tool/slices/lobehubSkillStore/selectors.ts');

    expect(providers).toContain("author: 'ModelNet'");
    expect(providers).toContain('OFFICIAL_URL');
    expect(providers).not.toMatch(/author:\s*['"]LobeHub(?: Market)?['"]/);
    expect(providers).not.toMatch(retiredBrandUrl);

    expect(skillList).toContain("author: 'ModelNet'");
    expect(skillList).not.toMatch(/author:\s*['"]LobeHub(?: Market)?['"]/);

    expect(selectors).toContain("author: 'ModelNet'");
    expect(selectors).toContain('OFFICIAL_URL');
    expect(selectors).not.toMatch(/author:\s*['"]LobeHub(?: Market)?['"]/);
    expect(selectors).not.toMatch(retiredBrandUrl);
  });

  it('uses the ModelNet avatar and display name for the compatibility skill', () => {
    const builtinSkill = readRepoFile('packages/builtin-skills/src/lobehub/index.ts');

    expect(builtinSkill).toContain("avatar: '/avatars/modelnet.png'");
    expect(builtinSkill).toContain("name: 'modelnet'");
    expect(builtinSkill).toContain('`modelnet` CLI');
    expect(builtinSkill).not.toMatch(/LOBEHUB_AVATAR|data:image\/x-icon|base64,/);
  });

  it('normalizes legacy official-author values before rendering them', () => {
    const pluginTags = [
      readRepoFile('src/components/Plugins/PluginTag.tsx'),
      readRepoFile('src/features/LibraryModal/AssignKnowledgeBase/Item/PluginTag.tsx'),
    ];

    for (const source of pluginTags) {
      expect(source).toContain("'ModelNet'");
      expect(source).toMatch(/(?:display|normalized)Author/);
      expect(source).not.toContain("const isOfficial = author === 'LobeHub';");
      expect(source).not.toContain('showText && (author ||');
    }

    const controls = readRepoFile('src/features/ChatInput/ActionBar/Tools/useControls.tsx');
    expect(controls).toContain('isOfficialModelNetAuthor');
    expect(controls).toContain("author === 'ModelNet'");
    expect(controls).not.toMatch(/author\s*===\s*['"]LobeHub['"]\s*\?\s*officialTag/);
  });
});

describe('ModelNet-only visible links and fonts', () => {
  it('uses the official ModelNet URL in built-in skill details', () => {
    const detailProviders = [
      readRepoFile('src/features/SkillStore/SkillDetail/BuiltinAgentSkillDetailProvider.tsx'),
      readRepoFile('src/features/SkillStore/SkillDetail/BuiltinDetailProvider.tsx'),
    ];

    for (const source of detailProviders) {
      expect(source).toContain('OFFICIAL_URL');
      expect(source).not.toMatch(retiredBrandUrl);
    }

    const pluginItem = readRepoFile(
      'src/routes/(main)/community/(detail)/agent/features/Details/Capabilities/PluginItem.tsx',
    );
    expect(pluginItem).toContain('OFFICIAL_URL');
    expect(pluginItem).not.toMatch(retiredBrandUrl);
  });

  it('does not load LobeHub webfonts or subscription links', () => {
    const compatibilityPage = readRepoFile('public/not-compatible.html');
    const branding = readRepoFile('packages/business/const/src/branding.ts');

    expect(compatibilityPage).toMatch(/font-family:[\s\S]*-apple-system[\s\S]*sans-serif/);
    expect(compatibilityPage).not.toMatch(/@lobehub\/webfont|webfont-harmony/i);
    expect(branding).toMatch(/subscription:\s*undefined/);
    expect(branding).not.toContain('app.lobehub.com');
  });

  it('uses ModelNet project links in previews and generated issue links', () => {
    const linkPreview = readRepoFile(
      'src/routes/(main)/settings/chat-appearance/features/ChatAppearance/LinkIconPreview.tsx',
    );
    const welcomeText = readRepoFile('src/routes/(main)/home/features/WelcomeText/index.tsx');

    expect(linkPreview).toContain('https://github.com/WNDS-JNU/ModelNet-Toc');
    expect(linkPreview).toContain('ModelNet');
    expect(linkPreview).not.toMatch(retiredBrandUrl);

    expect(welcomeText).toContain('https://github.com/WNDS-JNU/ModelNet-Toc/issues/');
    expect(welcomeText).not.toMatch(retiredBrandUrl);
  });

  it('keeps secondary UI links and exported filenames ModelNet-only', () => {
    const surfaces = [
      'src/features/CreatePlatformAgent/index.tsx',
      'src/features/ChatInput/ControlBar/HeteroDeviceSwitcher.tsx',
      'src/features/PluginDevModal/LocalForm.tsx',
      'src/routes/(main)/agent/channel/list.tsx',
      'src/routes/(main)/community/(list)/(home)/features/CreatorRewardBanner.tsx',
      'src/routes/(main)/community/(detail)/skill/features/Sidebar/index.tsx',
      'src/routes/(main)/community/(detail)/model/features/Details/Parameter/ParameterItem.tsx',
      'src/routes/share/t/[id]/_layout/HeaderMenu.tsx',
      'src/routes/(main)/community/(detail)/group_agent/features/StatusPage/index.tsx',
      'src/routes/(main)/community/(detail)/agent/features/StatusPage/index.tsx',
    ].map(readRepoFile);

    for (const source of surfaces) {
      expect(source).not.toMatch(/lobehub\.com|support@lobehub\.com|hi@lobehub\.com/i);
    }

    expect(surfaces.join('\n')).toContain('modelnet-channels-${agentId}.json');
  });

  it('does not expose retired brand names or domains in locale values', () => {
    const localeFiles = listJsonFiles(resolve(repoRoot, 'locales'));
    const retiredLocaleBrand = /LobeHub|LobeChat|@lobehub|lobehub\.com/i;

    const offenders = localeFiles.flatMap((file) => {
      const values = collectStringValues(JSON.parse(readFileSync(file, 'utf8')));
      return values.filter((value) => retiredLocaleBrand.test(value)).map(() => file);
    });

    expect(offenders).toEqual([]);
  });

  it('publishes only the ModelNet CLI command and package identity', () => {
    const cliPackage = JSON.parse(readRepoFile('apps/cli/package.json'));
    const cliProgram = readRepoFile('apps/cli/src/program.ts');
    const desktopBranding = readRepoFile('apps/desktop/src/main/const/branding.ts');
    const deviceConnect = readRepoFile('src/features/DeviceManager/DeviceConnectModal.tsx');

    expect(cliPackage.name).toBe('@modelnet/cli');
    expect(cliPackage.bin).toEqual({ modelnet: './dist/index.js' });
    expect(cliProgram).toContain(".name('modelnet')");
    expect(desktopBranding).toContain('MODELNET_CLI_COMPATIBILITY_ALIASES = []');
    expect(deviceConnect).toContain('npm install -g @modelnet/cli');
    expect(deviceConnect).toContain('modelnet login');
    expect(deviceConnect).toContain('modelnet connect');
    expect(deviceConnect).not.toMatch(/\blh\s+(?:connect|login)\b|@lobehub\/cli/);
  });

  it('uses ModelNet commands in built-in skill and Agent instructions', () => {
    const files = [
      ...listTextFiles(resolve(repoRoot, 'packages/builtin-skills/src')),
      resolve(repoRoot, 'packages/builtin-tool-skills/src/systemRole.ts'),
      resolve(repoRoot, 'packages/builtin-tool-message/src/systemRole.ts'),
      resolve(repoRoot, 'packages/builtin-tool-activator/src/systemRole.ts'),
      resolve(repoRoot, 'packages/agent-manager-runtime/src/heteroAgentDescriptor.ts'),
    ];
    const offenders = files.filter((file) =>
      /\blh\s+(?:connect|login|update|task|verify|agent|bot|gen|model|topic|kb|file|doc|message|skill|provider|plugin|config|memory|search|eval)\b/.test(
        readFileSync(file, 'utf8'),
      ),
    );

    expect(offenders).toEqual([]);
  });

  it('uses ModelNet avatars and excludes stale SPA and screenshot bundles', () => {
    const avatarSurfaces = [
      'packages/builtin-agents/src/agents/agent-builder/index.ts',
      'packages/builtin-agents/src/agents/group-agent-builder/index.ts',
      'packages/builtin-agents/src/agents/page-agent/index.ts',
      'packages/builtin-agents/src/agents/verify-agent/index.ts',
      'packages/const/src/meta.ts',
    ].map(readRepoFile);
    const manifest = readRepoFile('src/app/manifest.ts');
    const builder = readRepoFile('apps/desktop/electron-builder.mjs');

    for (const source of avatarSurfaces) {
      expect(source).toContain('/avatars/modelnet.png');
      expect(source).not.toMatch(
        /avatars\/(?:agent-builder|doc-copilot|agent-default|lobe-ai)\.png/,
      );
    }

    expect(manifest).toContain('screenshots: []');
    expect(manifest).not.toContain('/screenshots/shot-');
    expect(builder).toContain('!dist/renderer/_spa/**');
    expect(builder).toContain('!dist/renderer/_spa-auth/**');
    expect(builder).toContain('!dist/renderer/screenshots/**');
    expect(builder).toContain('!dist/renderer/avatars/lobe-ai.png');
    expect(builder).toContain('!dist/renderer/avatars/agent-builder.png');
    expect(builder).toContain('!dist/renderer/avatars/agent-default.png');
    expect(builder).toContain('!dist/renderer/avatars/doc-copilot.png');
  });

  it('writes ModelNet into the Windows CompanyName version resource', () => {
    const builder = readRepoFile('apps/desktop/electron-builder.mjs');

    expect(builder).toContain("author: { name: 'ModelNet' }");
    expect(builder).not.toMatch(/author:\s*['"]ModelNet['"]/);
  });
});
