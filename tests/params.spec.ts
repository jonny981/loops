import { describe, it, expect } from 'vitest';

import { defineParams } from '../src/api.ts';

describe('defineParams', () => {
  it('returns the declared parameter metadata unchanged', () => {
    const params = defineParams({
      oem: { type: 'string', required: true },
      device: { type: 'choice', choices: ['battery', 'inverter'], default: 'battery' },
      skip: { type: 'string[]', default: [] },
    });

    expect(params.oem.required).toBe(true);
    expect(params.device.default).toBe('battery');
    expect(params.skip.type).toBe('string[]');
  });

  it('rejects malformed flags and invalid choice defaults', () => {
    expect(() =>
      defineParams({
        bad: { type: 'string', flag: 'bad flag' },
      }),
    ).toThrow(/invalid flag/);

    expect(() =>
      defineParams({
        device: {
          type: 'choice',
          choices: ['battery', 'inverter'],
          default: 'ev',
        },
      }),
    ).toThrow(/default must be one of/);
  });
});
