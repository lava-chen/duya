/**
 * MCP (Model Context Protocol) commands for CLI
 *
 * Implements mcp list, check, remove functionality
 */

import { Colors, color } from './colors.js'
import { printSuccess, printError, printHeader, printInfo } from './interactive.js'

// MCP Server interfaces
export interface MCPServerStatus {
  name: string
  transport: string
  connected: boolean
  toolCount: number
  error?: string
}

/**
 * Display list of MCP servers
 */
export async function listMCPServers(servers: MCPServerStatus[]): Promise<void> {
  if (servers.length === 0) {
    console.log(color('  No MCP servers configured', Colors.DIM))
    console.log(color('  Add MCP servers in your config file', Colors.DIM))
    return
  }

  printHeader('MCP Servers')

  servers.forEach((server) => {
    const status = server.connected
      ? color('●', Colors.GREEN) + ' ' + color('Connected', Colors.GREEN)
      : color('●', Colors.RED) + ' ' + color('Disconnected', Colors.RED)

    const transport = color(`(${server.transport})`, Colors.DIM)
    const tools = server.connected
      ? color(`${server.toolCount} tools`, Colors.DIM)
      : color('failed', Colors.RED)

    console.log(color('  ', Colors.WHITE) + color(server.name, Colors.BRIGHT_CYAN))
    console.log(color('      ', Colors.DIM) + `${status} ${transport} - ${tools}`)

    if (server.error) {
      console.log(color('      Error: ', Colors.RED) + color(server.error, Colors.RED))
    }
  })
  console.log('')
}

/**
 * Check a specific MCP server
 */
export async function checkMCPServer(server: MCPServerStatus): Promise<void> {
  printHeader(`Checking: ${server.name}`)

  const statusIcon = server.connected ? color('✓', Colors.GREEN) : color('✗', Colors.RED)
  console.log(color(`  Status: ${statusIcon}`, Colors.WHITE) + (server.connected ? color(' Connected', Colors.GREEN) : color(' Disconnected', Colors.RED)))

  if (server.transport) {
    console.log(color('  Transport: ', Colors.DIM) + server.transport)
  }

  if (server.connected) {
    console.log(color('  Tools: ', Colors.DIM) + color(`${server.toolCount} available`, Colors.GREEN))
  }

  if (server.error) {
    console.log(color('  Error: ', Colors.RED) + server.error)
  }

  console.log('')
}

/**
 * Format MCP server for display
 */
export function formatMCPServer(server: MCPServerStatus): string {
  const status = server.connected ? color('●', Colors.GREEN) : color('●', Colors.RED)
  const name = color(server.name, Colors.BRIGHT_CYAN)
  const transport = color(`(${server.transport})`, Colors.DIM)
  const tools = server.connected ? `${server.toolCount} tools` : 'disconnected'

  return `${status} ${name} ${transport} - ${tools}`
}

export default {
  listMCPServers,
  checkMCPServer,
  formatMCPServer,
}