import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { generateAliasManPage, generateRootManPage } from './roff';

describe('roff manual generator', () => {
  it('renders a root man page from the command tree', () => {
    const program = new Command();

    program.name('modelnet').description('Sample CLI').version('1.0.0');

    program.command('generate').alias('gen').description('Generate content');
    program.command('login').description('Log in');

    const output = generateRootManPage(program, '1.2.3');

    expect(output).toContain('.TH MODELNET 1 "" "@modelnet/cli 1.2.3" "User Commands"');
    expect(output).not.toMatch(/\.BR (?:lobe|lobehub)/);
    expect(output).toContain('.SH COMMANDS');
    expect(output).toContain('.B generate');
    expect(output).toContain('Generate content Alias: gen.');
    expect(output).toContain('.B login');
    expect(output).toContain('.SH OPTIONS');
  });

  it('renders alias man pages as so links', () => {
    expect(generateAliasManPage('modelnet')).toBe('.so man1/modelnet.1\n');
  });
});
