/**
 * Type declarations for picomatch
 */

declare module 'picomatch' {
  interface PicomatchOptions {
    dot?: boolean;
    literalBrackets?: boolean;
    waveBrackets?: boolean;
    parentheses?: boolean;
    quotes?: boolean;
    escape?: boolean;
    strict?: boolean;
    nonegate?: boolean;
    noglobstar?: boolean;
    pattern?: string;
    format?: (str: string) => string;
    regex?: boolean;
    tokens?: boolean;
    sparse?: boolean;
  }

  interface PicomatchResult {
    isMatch: boolean;
    pattern: string;
    regex: RegExp;
    state: object;
  }

  function picomatch(
    pattern: string | string[],
    options?: PicomatchOptions
  ): (str: string) => boolean;

  function picomatch(
    pattern: string | string[],
    options?: PicomatchOptions
  ): {
    (str: string): boolean;
    test(str: string): boolean;
    match(str: string): string | null;
    matchBase(str: string, pattern?: string | string[]): boolean;
    parse(pattern: string): object;
    scan(str: string, pattern?: string | string[]): PicomatchResult;
    toRegex(pattern: string, options?: PicomatchOptions): RegExp;
  };

  export default picomatch;
}
