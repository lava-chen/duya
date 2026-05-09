/**
 * Platform adapter types
 * Defines the interface for platform-specific browser handling
 */

export interface PlatformAdapter {
  /** Platform name */
  readonly name: string;
  /** URL patterns this adapter handles */
  readonly urlPatterns: RegExp[];
  /** Platform-specific initialization */
  initialize?(): Promise<void>;
  /** Handle navigation (return true to skip default navigation) */
  handleNavigate?(url: string): Promise<{ handled: boolean; result?: unknown }>;
  /** Handle snapshot (return custom snapshot data) */
  handleSnapshot?(defaultSnapshot: unknown): Promise<{ handled: boolean; snapshot?: unknown }>;
  /** Handle click (return true to skip default click) */
  handleClick?(ref: string): Promise<{ handled: boolean; result?: unknown }>;
  /** Handle scroll (for infinite scroll sites) */
  handleScroll?(direction: string, amount: number): Promise<{ handled: boolean; result?: unknown }>;
  /** Check if element is visible on this platform */
  isElementVisible?(selector: string): Promise<boolean>;
  /** Wait for platform-specific conditions */
  waitForReady?(): Promise<void>;
}

export interface PlatformContext {
  url: string;
  title: string;
  evaluate: (script: string) => Promise<unknown>;
  click: (selector: string) => Promise<void>;
  scroll: (direction: string, amount: number) => Promise<void>;
}

export type PlatformAdapterConstructor = new (context: PlatformContext) => PlatformAdapter;
