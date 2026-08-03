import { convert } from '../index.js'

interface ConvertCmdOptions {
  format?: string
}

export async function runConvert(
  input: string,
  output: string,
  options: ConvertCmdOptions
): Promise<void> {
  await convert(input, output, { format: options.format, overwrite: true })
}
