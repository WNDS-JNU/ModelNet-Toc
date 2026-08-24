import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDesktopEnv: vi.fn(() => ({ DESKTOP_EXTERNAL_NAVIGATION_HOSTS: 'stripe.com' })),
}));

vi.mock('electron-is', () => ({
  dev: vi.fn(() => false),
  linux: vi.fn(() => false),
  macOS: vi.fn(() => false),
  windows: vi.fn(() => false),
}));

vi.mock('@/env', () => ({ getDesktopEnv: mocks.getDesktopEnv }));

import { DESKTOP_EXTERNAL_NAVIGATION_HOSTS } from './env';

describe('desktop environment constants', () => {
  it('exports configured external navigation hosts', () => {
    expect(DESKTOP_EXTERNAL_NAVIGATION_HOSTS).toBe('stripe.com');
  });
});
