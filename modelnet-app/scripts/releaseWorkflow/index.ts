import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

import { confirm, select } from '@inquirer/prompts';
import { consola } from 'consola';
import * as semver from 'semver';

const ROOT_DIR = process.cwd();
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');

// Version type
type VersionType = 'patch' | 'minor' | 'major';

// Check if in a Git repository
function checkGitRepo(): void {
  try {
    execSync('git rev-parse --git-dir', { stdio: 'ignore' });
  } catch {
    consola.error('❌ Current directory is not a Git repository');
    process.exit(1);
  }
}

// Get current version from package.json
function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    return pkg.version;
  } catch {
    consola.error('❌ Unable to read version from package.json');
    process.exit(1);
  }
}

// Calculate new version based on type
function bumpVersion(currentVersion: string, type: VersionType): string {
  const newVersion = semver.inc(currentVersion, type);
  if (!newVersion) {
    consola.error(`❌ Unable to calculate new version (current: ${currentVersion}, type: ${type})`);
    process.exit(1);
  }
  return newVersion;
}

// Get version type from command line arguments
function getVersionTypeFromArgs(): VersionType | null {
  const args = process.argv.slice(2);

  if (args.includes('--patch')) return 'patch';
  if (args.includes('--minor')) return 'minor';
  if (args.includes('--major')) return 'major';

  return null;
}

// Interactive version type selection
async function selectVersionTypeInteractive(): Promise<VersionType> {
  const currentVersion = getCurrentVersion();

  const choices: { name: string; value: VersionType }[] = [
    {
      value: 'patch',
      name: `🔧 patch - Bug fixes (e.g., ${currentVersion} -> ${bumpVersion(currentVersion, 'patch')})`,
    },
    {
      value: 'minor',
      name: `✨ minor - New features (e.g., ${currentVersion} -> ${bumpVersion(currentVersion, 'minor')})`,
    },
    {
      value: 'major',
      name: `🚀 major - Breaking changes (e.g., ${currentVersion} -> ${bumpVersion(currentVersion, 'major')})`,
    },
  ];

  const answer = await select<VersionType>({
    choices,
    message: 'Select version bump type:',
  });

  return answer;
}

// Secondary confirmation
async function confirmRelease(version: string, type: VersionType): Promise<boolean> {
  const currentVersion = getCurrentVersion();

  consola.box(
    `
📦 Release Confirmation
━━━━━━━━━━━━━━━━━━━━━━━
Current:    ${currentVersion}
New:        ${version}
Type:       ${type}
Branch:     release/v${version}
Target:     main
━━━━━━━━━━━━━━━━━━━━━━━
  `.trim(),
  );

  const confirmed = await confirm({
    default: true,
    message: 'Confirm to create release branch and submit PR?',
  });

  return confirmed;
}

// Checkout and pull latest dev branch
function checkoutAndPullDev(): void {
  try {
    // Check for dev branch
    const branches = execSync('git branch -a', { encoding: 'utf8' });
    const hasLocalDev = branches.includes(' dev\n') || branches.startsWith('* dev\n');
    const hasRemoteDev = branches.includes('remotes/origin/dev');

    if (!hasLocalDev && !hasRemoteDev) {
      consola.error('❌ Dev branch not found (local or remote)');
      process.exit(1);
    }

    consola.info('📥 Fetching latest dev branch...');

    if (hasRemoteDev) {
      // Checkout from remote dev branch
      try {
        execSync('git checkout dev', { stdio: 'ignore' });
        execSync('git pull origin dev', { stdio: 'inherit' });
      } catch {
        // Create from remote if local doesn't exist
        execSync('git checkout -b dev origin/dev', { stdio: 'inherit' });
      }
    } else {
      // Local dev branch only
      execSync('git checkout dev', { stdio: 'inherit' });
      execSync('git pull', { stdio: 'inherit' });
    }

    consola.success('✅ Switched to latest dev branch');
  } catch (error) {
    consola.error('❌ Failed to switch or pull dev branch');
    consola.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Create release branch
function createReleaseBranch(version: string): void {
  const branchName = `release/v${version}`;

  try {
    consola.info(`🌿 Creating branch: ${branchName}...`);
    execSync(`git checkout -b ${branchName}`, { stdio: 'inherit' });
    consola.success(`✅ Created and switched to branch: ${branchName}`);
  } catch (error) {
    consola.error(`❌ Failed to create branch or commit: ${branchName}`);
    consola.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Push branch to remote
function pushBranch(version: string): void {
  const branchName = `release/v${version}`;

  try {
    consola.info(`📤 Pushing branch to remote...`);
    execSync(`git push -u origin ${branchName}`, { stdio: 'inherit' });
    consola.success(`✅ Pushed branch to remote: ${branchName}`);
  } catch (error) {
    consola.error('❌ Failed to push branch');
    consola.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Create Pull Request
function createPullRequest(version: string): void {
  const title = `🚀 release: v${version}`;
  const body = `## 📦 Release v${version}

This branch contains changes for the upcoming v${version} release.

### Change Type
- Checked out from dev branch and merged to main branch

### Release Process
1. ✅ Release branch created
2. ✅ Pushed to remote
3. 🔄 Waiting for PR review and merge
4. ⏳ Release workflow triggered after merge

---
Created by release script`;

  try {
    consola.info('🔀 Creating Pull Request...');

    // Create PR using gh CLI
    const cmd = `gh pr create \
      --title "${title}" \
      --body "${body}" \
      --base main \
      --head release/v${version} \
      --label "release"`;

    execSync(cmd, { stdio: 'inherit' });
    consola.success('✅ PR created successfully!');
  } catch (error) {
    consola.error('❌ Failed to create PR');
    consola.error(error instanceof Error ? error.message : String(error));
    consola.info('\n💡 Tip: Make sure GitHub CLI (gh) is installed and logged in');
    consola.info('   Install: https://cli.github.com/');
    consola.info('   Login: gh auth login');
    process.exit(1);
  }
}

// Display completion info
function showCompletion(version: string): void {
  const branchName = `release/v${version}`;

  consola.box(
    `
🎉 Release process started!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ Branch created: ${branchName}
✅ Pushed to remote
✅ PR created targeting main branch

📋 PR Title: 🚀 release: v${version}

Next steps:
1. Open the PR link to view details
2. Complete code review
3. Merge PR to main branch
4. Wait for release workflow to complete
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim(),
  );
}

// Main function
async function main(): Promise<void> {
  consola.info('🚀 ModelNet Release Script\n');

  // 1. Check Git repository
  checkGitRepo();

  // 2. Checkout and pull latest dev branch (ensure we have the latest version)
  checkoutAndPullDev();

  // 3. Get version type
  let versionType = getVersionTypeFromArgs();

  if (!versionType) {
    // No args, enter interactive mode
    versionType = await selectVersionTypeInteractive();
  }

  // 4. Calculate new version
  const currentVersion = getCurrentVersion();
  const newVersion = bumpVersion(currentVersion, versionType);

  // 5. Secondary confirmation
  const confirmed = await confirmRelease(newVersion, versionType);

  if (!confirmed) {
    consola.info('❌ Release process cancelled');
    process.exit(0);
  }

  // 6. Create release branch
  createReleaseBranch(newVersion);

  // 7. Push to remote
  pushBranch(newVersion);

  // 8. Create PR
  createPullRequest(newVersion);

  // 9. Show completion info
  showCompletion(newVersion);
}

main().catch((error) => {
  consola.error('❌ Error occurred:', error);
  process.exit(1);
});
