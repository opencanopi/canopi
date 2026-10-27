// picomatch ships no types; the CSS policies use its isMatch only (policy/check.mjs's one glob engine).
declare module 'picomatch' {
  interface PicomatchOptions {
    readonly dot?: boolean
    readonly posix?: boolean
  }
  const picomatch: {
    isMatch(value: string, patterns: string | readonly string[], options?: PicomatchOptions): boolean
  }
  export default picomatch
}
