import type { Buffer } from 'node:buffer'

/**
 * Encapsulates reading binary values for a buffer using the type names
 * used in the OCAD file format specification.
 *
 * The reader also supports pushing and popping the current offset like a stack,
 * which is useful when reading nested structures.
 */
export default class BufferReader {
  buffer: Buffer
  offset: number
  stack: number[]

  constructor(buffer: Buffer, offset = 0) {
    this.buffer = buffer
    this.offset = offset

    this.stack = []
  }

  readInteger(): number {
    const val = this.buffer.readInt32LE(this.offset)
    this.offset += 4
    return val
  }

  readCardinal(): number {
    const val = this.buffer.readUInt32LE(this.offset)
    this.offset += 4
    return val
  }

  readSmallInt(): number {
    const val = this.buffer.readInt16LE(this.offset)
    this.offset += 2
    return val
  }

  readByte(): number {
    const val = this.buffer.readInt8(this.offset)
    this.offset++
    return val
  }

  readWord(): number {
    const val = this.buffer.readUInt16LE(this.offset)
    this.offset += 2
    return val
  }

  readWordBool(): boolean {
    return !!this.readWord()
  }

  readDouble(): number {
    const val = this.buffer.readDoubleLE(this.offset)
    this.offset += 8
    return val
  }

  /**
   * Reads an OCAD "wide string" from the buffer. For some OCAD versions,
   * a wide string is a string of 16-bit characters, for others it is a
   * string of 32-bit characters; setting the unicode parameter to true
   * will read 16-bit characters.
   *
   * If the length parameter is not given, the length of the string is read
   * as the first byte from the buffer.
   *
   */
  readWideString(unicode: boolean, len?: number): string {
    if (len == null) {
      len = this.readByte()
    }

    const textChars: string[] = []
    for (let i = 0; i < len * (unicode ? 2 : 4); i++) {
      const c = unicode ? this.readByte() : this.readWord()
      if (!c) break
      textChars.push(String.fromCharCode(c))
    }

    return (
      textChars
        // Filter carriage returns
        .filter(c => c !== '\r')
        .join('')
        .trim()
    )
  }

  /**
   * Returns the number of bytes read since the last push() call.
   */
  getSize(): number {
    return this.offset - this.stack[this.stack.length - 1]
  }

  /**
   * Skips the given number of bytes.
   */
  skip(bytes: number): void {
    this.offset += bytes
  }

  /**
   * Pushes the current offset onto the stack and sets the offset to the given
   * value.
   */
  push(offset: number): void {
    this.stack.push(this.offset)
    this.offset = offset
  }

  /**
   * Pops the current offset from the stack.
   */
  pop(): void {
    const nextOffset = this.stack.pop()
    if (nextOffset == null) throw new Error('Stack underflow')
    this.offset = nextOffset
  }

  /**
   * Runs `fn` with the reader positioned at `offset`, then restores the prior
   * offset — even if `fn` throws.
   */
  withOffset<T>(offset: number, fn: () => T): T {
    this.push(offset)
    try {
      return fn()
    } finally {
      this.pop()
    }
  }
}
