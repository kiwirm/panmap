import { Buffer } from 'node:buffer'

/**
 * Streaming little-endian binary writer that mirrors BufferReader's typed
 * vocabulary (Integer/Cardinal/SmallInt/Word/Byte/Double). Auto-grows.
 */
export default class BufferWriter {
  private buf: Buffer
  private size = 0

  constructor(initialCapacity = 64 * 1024) {
    this.buf = Buffer.alloc(initialCapacity)
  }

  get offset(): number {
    return this.size
  }

  /** Returns the written bytes (sliced exactly to length). */
  toBuffer(): Buffer {
    return this.buf.subarray(0, this.size)
  }

  private ensure(additional: number): void {
    const needed = this.size + additional
    if (needed <= this.buf.length) return
    let cap = this.buf.length
    while (cap < needed) cap *= 2
    const grown = Buffer.alloc(cap)
    this.buf.copy(grown, 0, 0, this.size)
    this.buf = grown
  }

  writeBytes(bytes: Buffer | Uint8Array): void {
    this.ensure(bytes.length)
    Buffer.from(bytes).copy(this.buf, this.size)
    this.size += bytes.length
  }

  writeByte(value: number): void {
    this.ensure(1)
    // Sign-extend from 8 bits so writeInt8's range check accepts inputs
    // that arrived as unsigned bytes (0..255).
    const v = ((value | 0) << 24) >> 24
    this.buf.writeInt8(v, this.size)
    this.size += 1
  }

  writeWord(value: number): void {
    this.ensure(2)
    this.buf.writeUInt16LE((value | 0) & 0xffff, this.size)
    this.size += 2
  }

  writeSmallInt(value: number): void {
    this.ensure(2)
    // Sign-extend from 16 bits so writeInt16LE accepts values that the
    // reader emitted as either signed (-1) or unsigned (65535).
    const v = ((value | 0) << 16) >> 16
    this.buf.writeInt16LE(v, this.size)
    this.size += 2
  }

  writeInteger(value: number): void {
    this.ensure(4)
    this.buf.writeInt32LE(value | 0, this.size)
    this.size += 4
  }

  writeCardinal(value: number): void {
    this.ensure(4)
    this.buf.writeUInt32LE(value >>> 0, this.size)
    this.size += 4
  }

  writeDouble(value: number): void {
    this.ensure(8)
    this.buf.writeDoubleLE(value, this.size)
    this.size += 8
  }

  writeZeros(count: number): void {
    this.ensure(count)
    this.buf.fill(0, this.size, this.size + count)
    this.size += count
  }

  /** Pad output to a multiple of `alignment` bytes with zeros. */
  alignTo(alignment: number): void {
    const pad = (alignment - (this.size % alignment)) % alignment
    if (pad) this.writeZeros(pad)
  }

  /** Patch a previously-written Integer at the given offset. */
  patchInteger(at: number, value: number): void {
    this.buf.writeInt32LE(value | 0, at)
  }

  /** Patch a previously-written Cardinal at the given offset. */
  patchCardinal(at: number, value: number): void {
    this.buf.writeUInt32LE(value >>> 0, at)
  }

  /** Patch a previously-written Word (unsigned 16-bit) at the given offset. */
  patchWord(at: number, value: number): void {
    this.buf.writeUInt16LE(value & 0xffff, at)
  }
}
