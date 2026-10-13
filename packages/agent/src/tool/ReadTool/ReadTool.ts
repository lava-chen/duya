/**
 * Plan 610 A8 shim â€?ReadTool moved to `@duya/capabilities` (`fs/read`).
 * Pass-through so every existing import (`ReadTool`, `readFileContent`,
 * `isMainModelMultimodal`, `validateReadInput`, `ReadInput`) keeps resolving.
 */

export * from '@duya/capabilities/ReadTool/ReadTool';
