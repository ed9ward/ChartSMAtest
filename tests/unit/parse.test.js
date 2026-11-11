import { describe, it, expect } from 'vitest';
import { parseFiniteNumber, parseBucketTimestamp } from '../../src/parse.js';

describe('parseFiniteNumber', () => {
  it.each([
    [0, 0],
    [-12.5, -12.5],
    ['42', 42],
    [' -1.25e2 ', -125],
    ['.5', 0.5],
    ['1.', 1],
  ])('parses %j as %j', (input, expected) => {
    expect(parseFiniteNumber(input)).toBe(expected);
  });

  it.each([
    [null], [undefined], [true], [false], [[]], [{}], [''], ['   '], ['0x10'],
    ['NaN'], ['Infinity'], ['1e9999'], [NaN], [Infinity], [-Infinity],
  ])('rejects non-decimal or non-finite input %j', (input) => {
    expect(parseFiniteNumber(input)).toBeNull();
  });
});

describe('parseBucketTimestamp', () => {
  it('converts aligned millisecond timestamps to epoch seconds', () => {
    expect(parseBucketTimestamp('1794324480000', 1000, 60)).toBe(1794324480);
    expect(parseBucketTimestamp(1794324480000, 1000)).toBe(1794324480);
  });

  it.each([
    [null, 1000, null],
    [-1000, 1000, null],
    [1000.5, 1000, null],
    [Number.MAX_SAFE_INTEGER + 1, 1000, null],
    [1001, 1000, null],
    [60000, 1000, 90],
  ])('rejects invalid or misaligned timestamp tuple %j', (value, units, interval) => {
    expect(parseBucketTimestamp(value, units, interval)).toBeNull();
  });

  it.each([
    [0], [-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], ['1000'], [null],
  ])('rejects invalid units-per-second %j', (units) => {
    expect(parseBucketTimestamp(60000, units, 60)).toBeNull();
  });

  it.each([
    [0], [-1], [1.5], [NaN], [Infinity], [Number.MAX_SAFE_INTEGER + 1], ['60'],
  ])('rejects invalid interval seconds %j', (interval) => {
    expect(parseBucketTimestamp(60000, 1000, interval)).toBeNull();
  });

  it('supports omitting interval alignment', () => {
    expect(parseBucketTimestamp(61000, 1000)).toBe(61);
  });
});
