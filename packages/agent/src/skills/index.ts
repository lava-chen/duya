/**
 * Skills Module - Public API
 * Skill loading, registry, and execution for duya Agent
 */

export * from './types.js';
export * from './registry.js';
export * from './loader.js';
export * from './frontmatter.js';
export * from './mcp.js';
export * from './skillsSync.js';
export { fingerprintDir } from './fingerprint.js';
export { shouldSkipScanDir } from './scanFilter.js';
export {
  RootSnapshotCache,
  getRootSnapshotCache,
  resetRootSnapshotCache,
} from './rootSnapshotCache.js';
export {
  activateConditionalSkills,
  getPendingConditionalSkills,
  getPendingConditionalSkillCount,
  isSkillActivated,
  clearConditionalSkills,
  getActivatedSkillNames,
  isConditionalSkill,
} from './conditionalSkills.js';
export {
  loadEnvFile,
  saveEnvVar,
  isEnvVarSet,
  normalizeRequiredEnvVars,
  captureMissingEnvVars,
  checkSkillEnvRequirements,
  buildSkillEnvContext,
  formatRequiredEnvVars,
  setSecretCaptureCallback,
} from './envVarCollector.js';
