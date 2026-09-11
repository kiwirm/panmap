import TdPoly from './td-poly.js'
import type BufferReader from './buffer-reader.js'
import type { ObjectIndex } from './object-index.js'
import {
  TOBJECT_V12_HEADER,
  type FieldType,
} from '../../native/tobject-schema.js'

function readField(reader: BufferReader, type: FieldType): number {
  switch (type) {
    case 'i32':
      return reader.readInteger()
    case 'u32':
      return reader.readCardinal()
    case 'i16':
      return reader.readSmallInt()
    case 'u16':
      return reader.readWord()
    case 'i8':
      return reader.readByte()
    case 'f64':
      return reader.readDouble()
  }
}

class BaseTObject {
  objIndex: ObjectIndex
  objType: number
  sym!: number
  otp!: number
  unicode!: boolean
  ang!: number
  col!: number
  lineWidth!: number
  diamFlags!: number
  serverObjectId!: number
  height!: number
  creationDate!: number
  multirepresentationId!: number
  modificationDate!: number
  nItem!: number
  nText!: number
  nObjectString!: number
  nDatabaseString!: number
  objectStringType!: number
  res1!: number
  text!: string
  objectString?: string
  databaseString?: string
  coordinates!: TdPoly[]
  mark?: number
  snappingMark?: number
  _date?: number

  constructor(objIndex: ObjectIndex) {
    this.objIndex = objIndex
    this.objType = objIndex.objType
  }
}

/**
 * OCAD version 10 TObject structure.
 */
class TObject10 extends BaseTObject {
  constructor(reader: BufferReader, objIndex: ObjectIndex) {
    super(objIndex)

    this.sym = reader.readInteger()
    this.otp = reader.readByte()
    this.unicode = !!reader.readByte()
    this.ang = reader.readSmallInt()
    this.nItem = reader.readCardinal()
    this.nText = reader.readWord()
    reader.readSmallInt() // Reserved
    this.col = reader.readInteger()
    this.lineWidth = reader.readSmallInt()
    this.diamFlags = reader.readSmallInt()
    reader.readInteger() // Reserved
    reader.readByte() // Reserved
    reader.readByte() // Reserved
    reader.readSmallInt() // Reserved
    this.height = reader.readInteger()
    this.coordinates = new Array(this.nItem)

    reader.skip(4)

    for (let i = 0; i < this.nItem; i++) {
      this.coordinates[i] = new TdPoly(
        reader.readInteger(),
        reader.readInteger(),
      )
    }

    this.text = reader.readWideString(this.unicode, this.nText)
  }
}

/**
 * OCAD version 11 TObject structure.
 */
class TObject11 extends BaseTObject {
  constructor(reader: BufferReader, objIndex: ObjectIndex) {
    super(objIndex)

    this.sym = reader.readInteger()
    this.otp = reader.readByte()
    this.unicode = !!reader.readByte()
    this.ang = reader.readSmallInt()
    this.nItem = reader.readCardinal()
    this.nText = reader.readWord()
    this.mark = reader.readByte()
    this.snappingMark = reader.readByte()
    this.col = reader.readInteger()
    this.lineWidth = reader.readSmallInt()
    this.diamFlags = reader.readSmallInt()
    this.serverObjectId = reader.readInteger()
    this.height = reader.readInteger()
    this._date = reader.readDouble()
    this.coordinates = new Array(this.nItem)

    for (let i = 0; i < this.nItem; i++) {
      this.coordinates[i] = new TdPoly(
        reader.readInteger(),
        reader.readInteger(),
      )
    }

    this.text = reader.readWideString(this.unicode, this.nText)
  }
}

/**
 * OCAD version 12 and 2018 TObject structure.
 */
class TObject12 extends BaseTObject {
  constructor(reader: BufferReader, objIndex: ObjectIndex) {
    super(objIndex)

    // Reader iterates the shared v12 header schema so it stays in lockstep
    // with the writer in encode-tobject.ts.
    const self = this as unknown as Record<string, number | boolean>
    for (const [name, type] of TOBJECT_V12_HEADER) {
      self[name] =
        name === 'unicode' ? !!readField(reader, type) : readField(reader, type)
    }
    this.coordinates = new Array(this.nItem)

    for (let i = 0; i < this.nItem; i++) {
      this.coordinates[i] = new TdPoly(
        reader.readInteger(),
        reader.readInteger(),
      )
    }

    this.text = reader.readWideString(this.unicode, this.nText)
    this.objectString = reader.readWideString(this.unicode, this.nObjectString)
    this.databaseString = reader.readWideString(
      this.unicode,
      this.nDatabaseString,
    )
  }
}

export { BaseTObject as TObject, TObject10, TObject11, TObject12 }

/** Version-indexed TObject constructors used by ObjectIndexBlock.readObjects. */
const tObjectByVersion: Record<
  number,
  typeof TObject10 | typeof TObject11 | typeof TObject12
> = {
  10: TObject10,
  11: TObject11,
  12: TObject12,
  2018: TObject12,
}

export default tObjectByVersion
