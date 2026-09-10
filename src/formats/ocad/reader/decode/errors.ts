export class InvalidObjectIndexBlockError extends Error {
  override name = 'InvalidObjectIndexBlockError'
}

export class InvalidSymbolElementError extends Error {
  override name = 'InvalidSymbolElementError'
  symbolElement?: unknown

  constructor(message: string, symbolElement?: unknown) {
    super(message)
    this.symbolElement = symbolElement
  }
}
