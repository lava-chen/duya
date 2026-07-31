#!/usr/bin/env node
'use strict';

const readline = require('node:readline');

const tools = [{
  name: 'design_audit',
  description: 'Create a structured visual, interaction, and accessibility audit for a described interface.',
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Screen, flow, component, or file being reviewed.' },
      criteria: { type: 'array', items: { type: 'string' }, description: 'Optional evaluation criteria.' }
    },
    required: ['target']
  }
}];

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function audit(args) {
  const criteria = Array.isArray(args.criteria) && args.criteria.length
    ? args.criteria
    : ['hierarchy', 'interaction clarity', 'keyboard access', 'contrast', 'empty and error states'];
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        target: args.target,
        status: 'needs-review',
        checklist: criteria.map((criterion) => ({ criterion, finding: 'Review against the supplied screen or design context.' })),
        nextStep: 'Use the Design Suite accessibility-review or design-critique skill to turn findings into prioritized actions.'
      }, null, 2)
    }]
  };
}

readline.createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === 'initialize') {
    reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'duya-design-audit', version: '1.0.0' } });
  } else if (request.method === 'tools/list') {
    reply(request.id, { tools });
  } else if (request.method === 'tools/call' && request.params?.name === 'design_audit') {
    reply(request.id, audit(request.params.arguments ?? {}));
  } else if (request.id !== undefined) {
    reply(request.id, { error: { code: -32601, message: 'Method not found' } });
  }
});
