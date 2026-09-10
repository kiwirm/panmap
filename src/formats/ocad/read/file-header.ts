import type BufferReader from './buffer-reader.js'

export type OcadVersion = 12 | 2018

export default class FileHeader {
  ocadMark: number = 0x0cad
  fileType: number = 0
  version: number = 12
  subVersion: number = 0
  subSubVersion: number = 0
  symbolIndexBlock: number = 0
  objectIndexBlock: number = 0
  offlineSyncSerial: number = 0
  currentFileVersion: number = 0
  stringIndexBlock: number = 0
  fileNamePos: number = 0
  fileNameSize: number = 0
  mrStartBlockPosition: number = 0

  constructor(reader?: BufferReader) {
    if (!reader) return

    if (reader.buffer.length - reader.offset < 60) {
      throw new Error('Not an OCAD file (not large enough to hold header)')
    }

    this.ocadMark = reader.readSmallInt()
    this.fileType = reader.readByte()
    reader.readByte() // FileStatus, not used
    this.version = reader.readSmallInt()
    this.subVersion = reader.readByte()
    this.subSubVersion = reader.readByte()
    this.symbolIndexBlock = reader.readCardinal()
    this.objectIndexBlock = reader.readCardinal()
    this.offlineSyncSerial = reader.readInteger()
    this.currentFileVersion = reader.readInteger()
    reader.readCardinal() // Internal, not used
    reader.readCardinal() // Internal, not used
    this.stringIndexBlock = reader.readCardinal()
    this.fileNamePos = reader.readCardinal()
    this.fileNameSize = reader.readCardinal()
    reader.readCardinal() // Internal, not used
    reader.readCardinal() // Res1, not used
    reader.readCardinal() // Res2, not used
    this.mrStartBlockPosition = reader.readCardinal()
  }

  /**
   * Build a fresh header suitable for a newly-synthesized OCAD file.
   *
   * OCAD 2018 uses the same on-disk layout as v12; Mapper's source
   * (`ocd_types_v2018.h`) notes: "Sample maps from the free version
   * 2018 Viewer could be successfully loaded by the free version 12
   * Viewer, after changing the file format version fields." So we
   * write `version = 12` bytes regardless and only bump `subVersion`
   * for 2018, matching what Mapper produces.
   */
  static createFor(_version: OcadVersion): FileHeader {
    // Match what real Mapper output writes: version=12, subVersion=0,
    // subSubVersion=0 regardless of the "target" name. The v2018 marker
    // in Mapper's UI doesn't actually change these bytes — the v12
    // reader accepts both files.
    const header = new FileHeader()
    header.version = 12
    header.subVersion = 0
    header.subSubVersion = 0
    return header
  }

  /**
   * Tells if this is a valid OCAD file (magic number is correct).
   */
  isValid(): boolean {
    return this.ocadMark === 0x0cad
  }
}
