import type { ProgressSnapshot } from './TaskState.js'

export const RECENT_ACTIVITIES_CAP = 5

export class ProgressTracker {
  static initial(startedAt: number): ProgressSnapshot {
    return {
      toolUseCount: 0,
      cumulativeOutputTokens: 0,
      cumulativeInputTokens: 0,
      lastActivity: null,
      recentActivities: [],
      startedAt,
      lastUpdateAt: startedAt,
    }
  }

  static recordToolUse(
    snap: ProgressSnapshot,
    tool: string,
    description: string,
    at: number
  ): ProgressSnapshot {
    const activity = { tool, description, at }
    const recent = [...snap.recentActivities, activity].slice(-RECENT_ACTIVITIES_CAP)
    return {
      ...snap,
      toolUseCount: snap.toolUseCount + 1,
      lastActivity: activity,
      recentActivities: recent,
      lastUpdateAt: at,
    }
  }

  static recordTokenUsage(
    snap: ProgressSnapshot,
    input: number,
    output: number,
    at: number
  ): ProgressSnapshot {
    return {
      ...snap,
      cumulativeInputTokens: snap.cumulativeInputTokens + input,
      cumulativeOutputTokens: snap.cumulativeOutputTokens + output,
      lastUpdateAt: at,
    }
  }
}