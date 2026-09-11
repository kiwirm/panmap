/**
 * Map a canonical object/symbol `type` string to its OCAD object-type
 * number (Otp). Shared by the object and symbol synth paths.
 */
export function otpForType(t: string): number {
  switch (t) {
    case 'point':
      return 1
    case 'line':
      return 2
    case 'area':
      return 3
    case 'text':
      return 4
    default:
      return 1
  }
}
