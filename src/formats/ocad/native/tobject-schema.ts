/**
 * Field schemas shared by the TObject reader (`tobject.ts`) and writer
 * (`../writer/encode/encode-tobject.ts`). Each entry is [fieldName, ioType].
 * Order matters — it's the byte layout on disk.
 *
 * Reserved fields (name === '_res*') consume bytes but aren't stored on
 * the TObject; the writer emits zero bytes in their place.
 */

export type FieldType =
  | 'i32' // Integer  (readInteger / writeInteger)
  | 'u32' // Cardinal (readCardinal / writeCardinal)
  | 'i16' // SmallInt (readSmallInt / writeSmallInt)
  | 'u16' // Word     (readWord / writeWord)
  | 'i8' // Byte     (readByte / writeByte)
  | 'f64' // Double   (readDouble / writeDouble)

export type FieldSpec = readonly [name: string, type: FieldType]

/** OCAD v12 / v2018 TObject header layout. */
export const TOBJECT_V12_HEADER: readonly FieldSpec[] = [
  ['sym', 'i32'],
  ['otp', 'i8'],
  ['unicode', 'i8'], // stored as boolean on the object but 1 byte on disk
  ['ang', 'i16'],
  ['col', 'i32'],
  ['lineWidth', 'i16'],
  ['diamFlags', 'i16'],
  ['serverObjectId', 'i32'],
  ['height', 'i32'],
  ['creationDate', 'f64'],
  ['multirepresentationId', 'u32'],
  ['modificationDate', 'f64'],
  ['nItem', 'u32'],
  ['nText', 'u16'],
  ['nObjectString', 'u16'],
  ['nDatabaseString', 'u16'],
  ['objectStringType', 'i8'],
  ['res1', 'i8'],
]
