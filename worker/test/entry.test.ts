import { expect, it } from 'vitest';
import * as entry from '../src/index';

// workerd treats every named export of the entry module as a handler and refuses to start
// ("Incorrect type for map entry …") if one is a plain value such as a number or string.
it('the Worker entry module exports only handlers', () => {
  for (const [name, value] of Object.entries(entry)) {
    expect(['function', 'object'], `export "${name}"`).toContain(typeof value);
  }
  expect(typeof entry.default.fetch).toBe('function');
  expect(typeof entry.default.scheduled).toBe('function');
});
