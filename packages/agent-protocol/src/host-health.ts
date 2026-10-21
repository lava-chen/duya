/** Authenticated Host readiness projection. */
export interface HostHealthV1 {
  readonly ok: true;
  readonly apiVersion: 1;
  /** True once Host has opened its configured databases and is serving requests. */
  readonly databaseReady: boolean;
}

export interface HostHealthApiV1 {
  getHealth(): Promise<HostHealthV1>;
}
