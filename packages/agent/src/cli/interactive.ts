/**
 * Interactive input utilities for CLI
 *
 * Provides helper functions for interactive prompts using readline
 */

import * as readline from 'readline'
import { Colors, color } from './colors.js'

/**
 * Prompt user for text input
 */
export async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    const suffix = defaultValue ? ` [${defaultValue}]` : ''
    rl.question(color(`  ${question}${suffix}: `, Colors.YELLOW), (answer) => {
      rl.close()
      const trimmed = answer.trim()
      resolve(trimmed || defaultValue || '')
    })
  })
}

/**
 * Prompt user for password (hidden input)
 */
export async function promptPassword(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(color(`  ${question}: `, Colors.YELLOW), (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

/**
 * Prompt user for yes/no answer
 */
export async function promptYesNo(question: string, defaultValue = true): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N'
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(color(`  ${question} (${hint}): `, Colors.YELLOW), (answer) => {
      rl.close()
      const trimmed = answer.trim().toLowerCase()
      if (!trimmed) return resolve(defaultValue)
      resolve(trimmed.startsWith('y'))
    })
  })
}

/**
 * Display a list of items and let user select one
 */
export async function selectFromList<T>(
  question: string,
  items: T[],
  displayFn: (item: T) => string,
  defaultIndex = 0
): Promise<{ selected: T; index: number } | null> {
  if (items.length === 0) return null

  // Display items
  console.log('')
  items.forEach((item, index) => {
    const marker = index === defaultIndex ? '❯' : ' '
    console.log(color(`  ${marker} ${index + 1}. ${displayFn(item)}`, Colors.WHITE))
  })
  console.log('')

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(color(`  ${question} (1-${items.length}, default: ${defaultIndex + 1}): `, Colors.YELLOW), (answer) => {
      rl.close()
      const trimmed = answer.trim()
      if (!trimmed) {
        resolve({ selected: items[defaultIndex], index: defaultIndex })
        return
      }

      const num = parseInt(trimmed, 10)
      if (isNaN(num) || num < 1 || num > items.length) {
        resolve({ selected: items[defaultIndex], index: defaultIndex })
        return
      }

      resolve({ selected: items[num - 1], index: num - 1 })
    })
  })
}

/**
 * Display a numbered list for selection (for sessions, etc.)
 */
export async function selectFromNumberedList<T>(
  items: T[],
  displayFn: (item: T, index: number) => string,
  defaultIndex = 0
): Promise<{ selected: T; index: number } | null> {
  if (items.length === 0) return null

  // Display items
  console.log('')
  items.forEach((item, index) => {
    const marker = index === defaultIndex ? '❯' : ' '
    const num = String(index + 1).padStart(2, ' ')
    console.log(color(`  ${marker} ${num}. ${displayFn(item, index)}`, Colors.WHITE))
  })
  console.log('')

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question(color(`  Enter number to select (default: ${defaultIndex + 1}): `, Colors.YELLOW), (answer) => {
      rl.close()
      const trimmed = answer.trim()
      if (!trimmed) {
        resolve({ selected: items[defaultIndex], index: defaultIndex })
        return
      }

      const num = parseInt(trimmed, 10)
      if (isNaN(num) || num < 1 || num > items.length) {
        resolve(null) // Invalid selection
        return
      }

      resolve({ selected: items[num - 1], index: num - 1 })
    })
  })
}

/**
 * Print info message
 */
export function printInfo(text: string): void {
  console.log(color(`  ${text}`, Colors.DIM))
}

/**
 * Print success message
 */
export function printSuccess(text: string): void {
  console.log(color(`✓ ${text}`, Colors.GREEN))
}

/**
 * Print warning message
 */
export function printWarning(text: string): void {
  console.log(color(`⚠ ${text}`, Colors.YELLOW))
}

/**
 * Print error message
 */
export function printError(text: string): void {
  console.log(color(`✗ ${text}`, Colors.RED))
}

/**
 * Print header message
 */
export function printHeader(text: string): void {
  console.log(color(`\n  ${text}`, Colors.YELLOW))
}

export default {
  prompt,
  promptPassword,
  promptYesNo,
  selectFromList,
  selectFromNumberedList,
  printInfo,
  printSuccess,
  printWarning,
  printError,
  printHeader,
}