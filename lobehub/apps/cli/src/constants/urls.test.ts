import { describe, expect, it } from 'vitest';

import { OFFICIAL_GATEWAY_URL } from './urls';

describe('official URLs', () => {
  it('uses the public ModelNet IP for the Device Gateway', () => {
    expect(OFFICIAL_GATEWAY_URL).toBe('https://123.56.135.150');
  });
});
