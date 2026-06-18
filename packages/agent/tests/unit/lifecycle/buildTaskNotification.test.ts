import { describe, it, expect } from 'vitest'
import { buildTaskNotificationXml, buildResultXml, DEFAULT_MAX_RESULT_CHARS } from '../../../src/lifecycle/buildTaskNotification.js'
import { TASK_NOTIFICATION_TAG, TASK_ID_TAG } from '../../../src/constants/taskNotificationXml.js'

// The <result> tag is a literal string inside buildTaskNotification.ts (it's
// not a named constant because the source has no other references to it).
// Pin the literal here so the test breaks loudly if the implementation changes.
const RESULT_OPEN = '<result>'
const RESULT_CLOSE = '</result>'

describe('buildTaskNotificationXml', () => {
  it('builds a basic completed envelope with all required fields', () => {
    const xml = buildTaskNotificationXml({
      taskId: 'abc-123',
      status: 'completed',
      agentType: 'general-purpose',
      description: 'research',
      outputFilePath: '/tmp/out.jsonl',
    })

    expect(xml).toContain(`<${TASK_NOTIFICATION_TAG}>`)
    expect(xml).toContain(`</${TASK_NOTIFICATION_TAG}>`)
    expect(xml).toContain(`<${TASK_ID_TAG}>abc-123</${TASK_ID_TAG}>`)
    expect(xml).toContain('<status>completed</status>')
    expect(xml).toContain('<task-type>general-purpose</task-type>')
    expect(xml).toContain('<output-file>/tmp/out.jsonl</output-file>')
    expect(xml).toContain('Agent "research" completed')
    // No finalMessage means no <result> tag.
    expect(xml).not.toContain(RESULT_OPEN)
  })

  it('escapes XML special characters in taskId and finalMessage', () => {
    const xml = buildTaskNotificationXml({
      taskId: 'a<b>&c',
      status: 'completed',
      agentType: 't',
      outputFilePath: '/tmp/o',
      finalMessage: 'has <script>alert(1)</script> & "quotes"',
    })

    expect(xml).toContain('<task-id>a&lt;b&gt;&amp;c</task-id>')
    expect(xml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(xml).toContain('&amp; "quotes"')
    // Should NOT contain raw <script> from the input.
    expect(xml).not.toContain('<script>alert(1)</script>')
  })

  it('omits optional segments when fields are missing', () => {
    const xml = buildTaskNotificationXml({
      taskId: 't1',
      status: 'completed',
      agentType: 't',
      outputFilePath: '/tmp/o',
    })

    expect(xml).not.toContain('<tool-use-id>')
    expect(xml).not.toContain('<usage>')
    expect(xml).not.toContain('<worktree>')
    expect(xml).not.toContain(RESULT_OPEN)
  })

  it('includes usage when totalToolUseCount and totalDurationMs are set', () => {
    const xml = buildTaskNotificationXml({
      taskId: 't1',
      status: 'completed',
      agentType: 't',
      outputFilePath: '/tmp/o',
      totalToolUseCount: 12,
      totalDurationMs: 3456,
    })

    expect(xml).toContain('<usage>')
    expect(xml).toContain('<tool_uses>12</tool_uses>')
    expect(xml).toContain('<duration_ms>3456</duration_ms>')
  })

  it('includes worktree when worktreePath is set', () => {
    const xml = buildTaskNotificationXml({
      taskId: 't1',
      status: 'completed',
      agentType: 't',
      outputFilePath: '/tmp/o',
      worktreePath: '/tmp/wt',
      worktreeBranch: 'feat/x',
    })

    expect(xml).toContain('<worktree>')
    expect(xml).toContain('<worktreePath>/tmp/wt</worktreePath>')
    expect(xml).toContain('<worktreeBranch>feat/x</worktreeBranch>')
  })

  it('uses agentName as the summary fallback when description is missing', () => {
    const xml = buildTaskNotificationXml({
      taskId: 't1',
      status: 'completed',
      agentType: 'general-purpose',
      agentName: 'researcher',
      outputFilePath: '/tmp/o',
    })

    expect(xml).toContain('Agent "researcher" completed')
  })

  it('renders the failed status with the error message', () => {
    const xml = buildTaskNotificationXml({
      taskId: 't1',
      status: 'failed',
      agentType: 'general-purpose',
      description: 'research',
      outputFilePath: '/tmp/o',
      error: 'Out of memory',
    })

    expect(xml).toContain('<status>failed</status>')
    expect(xml).toContain('Agent "research" failed: Out of memory')
  })

  it('renders the killed status without the "Error:" prefix', () => {
    const xml = buildTaskNotificationXml({
      taskId: 't1',
      status: 'killed',
      agentType: 't',
      description: 'work',
      outputFilePath: '/tmp/o',
      error: 'parent_abort',
    })

    expect(xml).toContain('<status>killed</status>')
    expect(xml).toContain('Agent "work" was stopped')
  })
})

describe('buildResultXml (truncation)', () => {
  const baseInput = {
    taskId: 't1',
    status: 'completed' as const,
    agentType: 't',
    outputFilePath: '/tmp/o',
  }

  it('inlines short finalMessage verbatim', () => {
    const xml = buildTaskNotificationXml({ ...baseInput, finalMessage: 'short' })
    expect(xml).toContain(`${RESULT_OPEN}short${RESULT_CLOSE}`)
  })

  it('truncates long finalMessage into an output-file pointer', () => {
    const longText = 'x'.repeat(DEFAULT_MAX_RESULT_CHARS + 100)
    const xml = buildTaskNotificationXml({ ...baseInput, finalMessage: longText })

    expect(xml).not.toContain('x'.repeat(100))
    expect(xml).toContain(`Output is ${longText.length} chars`)
    expect(xml).toContain('<output-file>/tmp/o</output-file>')
  })

  it('respects a custom maxResultChars cap', () => {
    const xml = buildTaskNotificationXml({
      ...baseInput,
      finalMessage: 'abcdefghij',
      maxResultChars: 3,
    })
    expect(xml).toContain('Output is 10 chars')
    expect(xml).not.toContain('abcdefghij')
  })

  it('returns undefined for result when finalMessage is missing', () => {
    // Direct call to internal helper for unit-level coverage.
    expect(buildResultXml({ ...baseInput })).toBeUndefined()
    expect(buildResultXml({ ...baseInput, finalMessage: '' })).toBeUndefined()
  })

  it('inlines verbatim when maxResultChars is 0 but finalMessage is short', () => {
    // maxResultChars=0 means "always truncate" — but cap<=0 short-circuits to
    // "inline verbatim" only when raw is also short. With a long message the
    // pointer is emitted. Test the short case to confirm the short-circuit.
    const xml = buildTaskNotificationXml({ ...baseInput, finalMessage: 'ok', maxResultChars: 0 })
    expect(xml).toContain(`${RESULT_OPEN}ok${RESULT_CLOSE}`)
  })
})
