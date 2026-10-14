import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PLAN_LIMITS } from '@pingward/shared';
import { applySettingsPatch, settingsFromRows } from '../src/settings';

const rows = (o: Record<string, unknown>) => Object.entries(o).map(([key, v]) => ({ key, value: JSON.stringify(v) }));
const idle = { checksPerMinute: 0, monitors: 0 };

describe('settingsFromRows', () => {
  it('falls back to defaults when nothing is stored', () => {
    expect(settingsFromRows([])).toEqual(DEFAULT_SETTINGS);
  });

  it('reads stored values', () => {
    expect(settingsFromRows(rows({ plan: 'paid', checksPerMinute: 60, pingRetentionDays: 14 }))).toEqual({
      plan: 'paid',
      checksPerMinute: 60,
      pingRetentionDays: 14,
    });
  });

  it('never exceeds the plan ceiling, even if the stored value does', () => {
    const s = settingsFromRows(rows({ plan: 'free', checksPerMinute: 60 }));
    expect(s.checksPerMinute).toBeLessThanOrEqual(PLAN_LIMITS.free.maxChecksPerMinute);
  });

  it('ignores corrupt values', () => {
    expect(settingsFromRows([{ key: 'plan', value: '{oops' }]).plan).toBe('free');
  });
});

describe('applySettingsPatch', () => {
  it('accepts a valid change', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { checksPerMinute: 4, pingRetentionDays: 3 }, idle)).toEqual({
      plan: 'free',
      checksPerMinute: 4,
      pingRetentionDays: 3,
    });
  });

  it('rejects capacity above the free plan ceiling', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { checksPerMinute: 20 }, idle)).toMatch(/between 1 and 7/);
  });

  it('allows more capacity on the paid plan', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { plan: 'paid', checksPerMinute: 50 }, idle)).toMatchObject({ checksPerMinute: 50 });
  });

  it('clamps capacity when downgrading to free', () => {
    const paid = { plan: 'paid' as const, checksPerMinute: 50, pingRetentionDays: 7 };
    expect(applySettingsPatch(paid, { plan: 'free' }, { checksPerMinute: 2, monitors: 5 })).toMatchObject({ checksPerMinute: 7 });
  });

  it('refuses to drop below what active monitors need', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { checksPerMinute: 2 }, { checksPerMinute: 3.5, monitors: 10 })).toMatch(/need 3.50/);
  });

  it('refuses a plan whose monitor cap is already exceeded', () => {
    const paid = { plan: 'paid' as const, checksPerMinute: 8, pingRetentionDays: 7 };
    expect(applySettingsPatch(paid, { plan: 'free' }, { checksPerMinute: 1, monitors: 80 })).toMatch(/allows 50 monitors/);
  });

  it('validates plan and retention', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { plan: 'enterprise' }, idle)).toMatch(/plan/);
    expect(applySettingsPatch(DEFAULT_SETTINGS, { pingRetentionDays: 90 }, idle)).toMatch(/pingRetentionDays/);
  });
});
