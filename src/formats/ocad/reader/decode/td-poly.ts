import {
  unpackOcadValue,
  unpackOcadFlags,
  packOcadOrdinate,
} from '../../codecs/index.js'

/**
 * Represents a TDPoly, which is a coordinate pair with optional flags.
 * The class is an array of X and Y coordinates, with the flags stored in
 * the `xFlags` and `yFlags` properties.
 *
 * OCAD coordinates use 1/100 mm units, unmanipulated coordinates from an OCAD
 * file are 24 bit signed integers.
 *
 */
class TdPoly extends Array<number> {
  xFlags: number
  yFlags: number

  constructor(ocadX: number, ocadY: number, xFlags?: number, yFlags?: number) {
    super(
      xFlags === undefined ? unpackOcadValue(ocadX) : ocadX,
      yFlags === undefined ? unpackOcadValue(ocadY) : ocadY,
    )
    this.xFlags = xFlags === undefined ? unpackOcadFlags(ocadX) : xFlags
    this.yFlags = yFlags === undefined ? unpackOcadFlags(ocadY) : yFlags
  }

  isFirstBezier(): boolean {
    return !!(this.xFlags & 0x01)
  }

  isSecondBezier(): boolean {
    return !!(this.xFlags & 0x02)
  }

  hasNoLeftLine(): number {
    return this.xFlags & 0x04
  }

  isBorderOrVirtualLine(): boolean {
    return !!(this.xFlags & 0x08)
  }

  isCornerPoint(): boolean {
    return !!(this.yFlags & 0x01)
  }

  isFirstHolePoint(): boolean {
    return !!(this.yFlags & 0x02)
  }

  hasNoRightLine(): number {
    return this.yFlags & 0x04
  }

  isDashPoint(): boolean {
    return !!(this.yFlags & 0x08)
  }

  vLength(): number {
    return Math.sqrt(this[0] * this[0] + this[1] * this[1])
  }

  add(c1: ArrayLike<number>): TdPoly {
    return new TdPoly(
      this[0] + c1[0],
      this[1] + c1[1],
      this.xFlags,
      this.yFlags,
    )
  }

  sub(c1: ArrayLike<number>): TdPoly {
    return new TdPoly(
      this[0] - c1[0],
      this[1] - c1[1],
      this.xFlags,
      this.yFlags,
    )
  }

  mul(f: number): TdPoly {
    return new TdPoly(this[0] * f, this[1] * f, this.xFlags, this.yFlags)
  }

  unit(): TdPoly {
    const l = this.vLength()
    return this.mul(1 / l)
  }

  rotate(theta: number): TdPoly {
    return new TdPoly(
      this[0] * Math.cos(theta) - this[1] * Math.sin(theta),
      this[0] * Math.sin(theta) + this[1] * Math.cos(theta),
      this.xFlags,
      this.yFlags,
    )
  }

  equalCoords(other: ArrayLike<number>): boolean {
    return this[0] === other[0] && this[1] === other[1]
  }

  // Round before packing. `packOcadOrdinate` shifts (`value << 8`), and JS
  // `<<` coerces via ToInt32 — truncation TOWARD ZERO — so a fractional
  // ordinate silently truncates. xmap coords are µm scaled to 0.01 mm units
  // and land on halves (a vertex stored as -447065 µm is -44706.5 here), so
  // the rounding mode is load-bearing.
  //
  // The grid is OCAD's, so match how OCAD holds those halves: AWAY FROM
  // ZERO. Measured both directions against the corpus — positive halves
  // round up and negative halves round down, which is one rule, not two.
  // (Mapper's `convertPointMember` asserts half-UP, but that governs Mapper
  // writing an OCD file, not how the authored OCAD file stores its own
  // vertices; using it left every negative-half vertex one unit off.)
  static fromCoords(x: number, y: number): TdPoly {
    return new TdPoly(
      packOcadOrdinate(roundHalfAwayFromZero(x)),
      packOcadOrdinate(roundHalfAwayFromZero(y)),
    )
  }
}

function roundHalfAwayFromZero(v: number): number {
  return v < 0 ? -Math.round(-v) : Math.round(v)
}

export default TdPoly
