import { buildSandboxImage, setSandboxEnabled } from '@duya/sandbox';

/** Enable command sandboxing and prewarm its image without delaying worker readiness. */
export function prepareWorkerSandbox(reportProgress: (message: string) => void): void {
  setSandboxEnabled(true);
  void buildSandboxImage(reportProgress).catch(() => {});
}
