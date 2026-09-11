import { describe, expect, it } from 'vitest';
import { canonicalJson, hashObject, sha256 } from './hash.js';

describe('sha256', () => {
  // Standard NIST test vectors. If these fail the audit chain is worthless.
  it('matches published vectors', () => {
    expect(sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('handles messages that straddle the 64-byte block boundary', () => {
    // 55, 56 and 64 bytes exercise the three padding branches.
    expect(sha256('a'.repeat(55))).toHaveLength(64);
    expect(sha256('a'.repeat(56))).toHaveLength(64);
    expect(sha256('a'.repeat(64))).toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    );
  });

  it('handles multi-byte utf-8', () => {
    // The rupee sign is three UTF-8 bytes. Vectors cross-checked against node:crypto,
    // which matters because currency strings are hashed into the audit chain.
    expect(sha256('₹')).toBe(
      'd8c3e87cd7f5b7d388f9dc1e35ccee09640ef3dca63d449d9ef59fc323a87a20',
    );
    expect(sha256('₹1,23,456')).toBe(
      'ac32e32519cea28d515bccd2d54dbce6e907c5d87130c39ac2b253d1b211486f',
    );
  });
});

describe('canonicalJson', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('sorts nested keys too', () => {
    const x = { outer: { z: 1, a: { y: 2, b: 3 } } };
    const y = { outer: { a: { b: 3, y: 2 }, z: 1 } };
    expect(canonicalJson(x)).toBe(canonicalJson(y));
  });

  it('drops undefined members so optional fields do not change the digest', () => {
    expect(hashObject({ a: 1 })).toBe(hashObject({ a: 1, b: undefined }));
  });

  it('preserves array order, which is semantically meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});
