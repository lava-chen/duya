import { describe, expect, it } from 'vitest'
import {
  getOfficialPluginAssets,
  listOfficialPluginAssets,
} from '../../src/plugins/loader/official-assets.js'

describe('official first-party plugin assets', () => {
  it('pins every upstream skill source to an immutable commit', () => {
    for (const asset of Object.values(listOfficialPluginAssets())) {
      if (asset.skills.mode !== 'upstream-sync') continue
      expect(asset.skills.repository).toMatch(/^https:\/\/github\.com\//)
      expect(asset.skills.ref).toMatch(/^[0-9a-f]{40}$/)
      expect(asset.skills.path).toBeTruthy()
    }
  })

  it('only declares secure remote MCP endpoints', () => {
    for (const asset of Object.values(listOfficialPluginAssets())) {
      if (asset.mcp.transport !== 'streamable-http') continue
      expect(asset.mcp.url).toMatch(/^https:\/\//)
      expect(asset.mcp.authentication).toBe('oauth')
    }
  })

  it('keeps Duya workflows as overlays when a provider offers no portable skill bundle', () => {
    expect(getOfficialPluginAssets('com.duya.github-development')?.skills.mode).toBe('duya-overlay')
    expect(getOfficialPluginAssets('com.duya.linear-project-execution')?.skills.mode).toBe('duya-overlay')
  })
})
