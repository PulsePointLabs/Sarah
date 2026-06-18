export class RingBuffer {
  constructor(capacity = 2048) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error('RingBuffer capacity must be a positive integer.');
    this.capacity = capacity;
    this.items = new Array(capacity);
    this.start = 0;
    this.length = 0;
    this.overwrites = 0;
  }

  push(item) {
    const index = (this.start + this.length) % this.capacity;
    if (this.length === this.capacity) {
      this.items[index] = item;
      this.start = (this.start + 1) % this.capacity;
      this.overwrites += 1;
      return;
    }
    this.items[index] = item;
    this.length += 1;
  }

  toArray() {
    const out = [];
    for (let i = 0; i < this.length; i += 1) {
      out.push(this.items[(this.start + i) % this.capacity]);
    }
    return out;
  }

  latest() {
    if (!this.length) return null;
    return this.items[(this.start + this.length - 1) % this.capacity];
  }

  health() {
    return {
      capacity: this.capacity,
      used: this.length,
      fillRatio: this.capacity ? this.length / this.capacity : 0,
      overwrites: this.overwrites,
    };
  }
}
