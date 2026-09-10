import { InvalidObjectIndexBlockError } from './errors.js'
import LRect from './lrect.js'
import tObjectByVersion from './tobject.js'
import type BufferReader from './buffer-reader.js'

export interface ObjectIndex {
  rc: LRect
  pos: number
  len: number
  sym: number
  objType: number
  encryptedMode: number
  status: number
  viewType: number
  color: number
  group: number
  impLayer: number
  dbDatasetHash: number
  dbKeyHash: number
  _index: number
  /** Source byte range of this 40-byte index entry, for byte-exact write. */
  _entryByteRange?: { start: number; end: number }
}

const TObjectConstructors = tObjectByVersion

export default class ObjectIndexBlock {
  version: number
  nextObjectIndexBlock: number
  table: ObjectIndex[]

  constructor(reader: BufferReader, startIndex: number, version: number) {
    this.version = version

    // Ignore pointers that do not point to a valid location in the file.
    // Compare getBlockCheckedRaw() in Open Orienteering Mapper.
    this.nextObjectIndexBlock = reader.readInteger()
    if (this.nextObjectIndexBlock > reader.buffer.length - (256 * 40 + 4)) {
      throw new InvalidObjectIndexBlockError(
        `Invalid object index block pointer ${this.nextObjectIndexBlock} > ${
          reader.buffer.length - (256 * 40 + 4)
        }.`
      )
    }

    this.table = new Array(256)
    for (let i = 0; i < 256; i++) {
      const entryStart = reader.offset
      const rc = new LRect(reader)

      this.table[i] = {
        rc,
        pos: reader.readInteger(),
        len: reader.readInteger(),
        sym: reader.readInteger(),
        objType: reader.readByte(),
        encryptedMode: reader.readByte(),
        status: reader.readByte(),
        viewType: reader.readByte(),
        color: reader.readSmallInt(),
        group: reader.readSmallInt(),
        impLayer: reader.readSmallInt(),
        dbDatasetHash: reader.readByte(),
        dbKeyHash: reader.readByte(),
        _index: startIndex + i,
        _entryByteRange: { start: entryStart, end: reader.offset },
      }
    }
  }

  readObjects(reader: BufferReader): unknown[] {
    return this.table
      .filter(o => o.status > 0 && o.status < 3) // Remove deleted objects, keep normal and hidden objects.
      .map(o => this.readObject(reader, o))
      .filter(o => o)
  }

  readObject(reader: BufferReader, objIndex: ObjectIndex): unknown | undefined {
    if (!objIndex.pos) return

    reader.push(objIndex.pos)
    const ObjectConstructor = TObjectConstructors[this.version]
    const tObject = new ObjectConstructor(reader, objIndex) as {
      _byteRange?: { start: number; end: number }
    }
    const end = reader.offset
    reader.pop()
    // Capture the source byte range so the writer can byte-preserve
    // unmodified TObject records.
    tObject._byteRange = { start: objIndex.pos, end }
    return tObject
  }
}
