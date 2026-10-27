'use strict';

// Mulberry32 with an explicit uint32 seed. Its sequence is stable across Node versions.
class SeededRNG {
  constructor(seed = 42) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new RangeError('seed must be a uint32 integer');
    this.seed = seed;
    this.state = seed >>> 0;
  }

  next() {
    this.state = (this.state + 0x6D2B79F5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 0x100000000;
  }

  uniform(min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) throw new RangeError('invalid uniform range');
    return min + this.next() * (max - min);
  }

  nextInt(min, max) {
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw new RangeError('invalid integer range');
    return min + Math.floor(this.next() * (max - min + 1));
  }

  choice(items) {
    if (!Array.isArray(items) || !items.length) throw new RangeError('choice requires a nonempty array');
    return items[this.nextInt(0, items.length - 1)];
  }
}

module.exports = { SeededRNG };
