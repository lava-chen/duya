import React from 'react';

interface Input {
  team_name: string;
  description?: string;
  agent_type?: string;
}

export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  return `create team: ${input.team_name}`;
}
