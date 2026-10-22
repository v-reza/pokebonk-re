// ============ codec.test.mjs — round-trip tests for net/codec.mjs ============
// Run with:  node --test net/codec.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, size, MAX_BYTES, version } from './codec.mjs';

/** Round-trip helper: encode then decode and deep-compare. */
function roundTrip(value) {
  const buf = encode(value);
  assert.ok(buf, 'encode returned null for a supported value: ' + JSON.stringify(value));
  return decode(buf);
}

test('nested arrays round-trip', () => {
  const v = [1, [2, 3, [4, 5]], [], [[[]]]];
  assert.deepEqual(roundTrip(v), v);
});

test('floats round-trip exactly', () => {
  const v = [0.5, -1.25, 3.141592653589793, 1e-10, 123456.789, 2.5e300];
  assert.deepEqual(roundTrip(v), v);
});

test('negative integers round-trip', () => {
  const v = [-1, -2, -95, -96, -97, -100, -100000, -9007199254740991];
  assert.deepEqual(roundTrip(v), v);
});

test('large positive integers round-trip', () => {
  const v = [96, 127, 128, 1000, 1 << 20, 9007199254740991];
  assert.deepEqual(roundTrip(v), v);
});

test('strings with surrogate pairs round-trip', () => {
  const v = ['pokémon', 'emoji 😀🔥', '𝕳𝖊𝖑𝖑𝖔 世界', 'a\u0000b', 'ñáéíóú'];
  assert.deepEqual(roundTrip(v), v);
});

test('null, booleans and mixed scalars round-trip', () => {
  const v = [null, true, false, null, 0, 42, 'x'];
  assert.deepEqual(roundTrip(v), v);
});

test('objects round-trip, including empty and nested', () => {
  const v = { a: 1, b: { c: [1, 2, 3], d: 'hi' }, e: {}, f: null, g: true };
  assert.deepEqual(roundTrip(v), v);
});

test('JSON equivalence: -0 -> 0, NaN/Infinity -> null, undefined -> null/omitted', () => {
  const v = { negZero: -0, nan: NaN, inf: Infinity, undefInArr: [1, undefined, 2], undefInObj: undefined, fn: () => {} };
  const expected = JSON.parse(JSON.stringify(v));
  assert.deepEqual(roundTrip(v), expected);
});

test('hundredths path is exact for two-decimal values', () => {
  const v = [0.01, -0.01, 3.14, -3.14, 123.45, -99.99, 100.99];
  assert.deepEqual(roundTrip(v), v);
});

test('a large-enough frame (many enemy rows) round-trips', () => {
  const frame = { k: 'f', t: 123.45, lv: 12, xp: 400.5, xn: 900, ki: 321, bo: 2, co: 55,
    p: { 'uidA': [1, 2, 3.14, 1, 100, 100, 0], 'uidB': [-5, 9, -1.5, 0, 40, 120, 1] },
    e: Array.from({ length: 200 }, (_, i) => [i, i * 1.5, -(i || 1) * 2.25, 500 + i, i % 4, (i % 8), (i % 16)]),
    ev: [['h', 3, 25, '#ff0000', 1, 0, 1]] };
  assert.deepEqual(roundTrip(frame), frame);
});

test('encode rejects unsupported top-level values (returns null)', () => {
  assert.equal(encode(undefined), null);
  assert.equal(encode(() => {}), null);
  assert.equal(encode(Symbol('x')), null);
  assert.equal(encode(10n), null); // BigInt unsupported
  assert.equal(encode(new Date()), null);
});

test('decode rejects garbage / truncated / wrong version', () => {
  assert.throws(() => decode(new Uint8Array([80, 83, 1, 0]).buffer.slice(0, 3)), /truncated|protocol/);
  assert.throws(() => decode(new Uint8Array([80, 83, 2]).buffer), /protocol version/);
  assert.throws(() => decode(new Uint8Array([0, 0, 0]).buffer), /protocol version/);
  // trailing byte
  assert.throws(() => decode(new Uint8Array([80, 83, 1, 32, 0]).buffer), /trailing bytes/);
  // unknown tag
  assert.throws(() => decode(new Uint8Array([80, 83, 1, 31]).buffer), /unknown tag/);
});

test('version and MAX_BYTES are exported', () => {
  assert.equal(version, 1);
  assert.equal(MAX_BYTES, 1024 * 1024);
});

test('size returns UTF-8 byte length', () => {
  assert.equal(size('abc'), 3);
  assert.equal(size('é'), 2);
  assert.equal(size('😀'), 4);
});
