// Ambient shim for the removed @duya/computer-use-demo workspace package.
// 86f68e9e deleted the demo package but left these type-only imports behind,
// which fails `tsc` with TS2307 even though nothing is imported at runtime.
// Only the members this package actually reads are declared; the index
// signature keeps the shape permissive until the imports are repointed at a
// local type. Hand-written (tracked with -f past packages/*/src/**/*.d.ts —
// the ignore rule targets tsc emit artifacts, not genuine declarations).
declare module '@duya/computer-use-demo' {
  export interface FocusedEntity {
    kind?: string;
    text?: string;
    title?: string;
    processName?: string;
    pid?: number;
    [key: string]: unknown;
  }
}
