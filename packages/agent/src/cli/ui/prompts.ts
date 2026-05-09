/**
 * Interactive Prompts using @inquirer/prompts
 *
 * Provides keyboard-navigable selection prompts similar to hermes-agent:
 * - Arrow key navigation (↑↓)
 * - Space to toggle selections
 * - Enter to confirm
 * - Escape to cancel
 */

import select from '@inquirer/select';
import checkbox from '@inquirer/checkbox';
import input from '@inquirer/input';
import password from '@inquirer/password';
import confirm from '@inquirer/confirm';

// ASCII theme for Windows compatibility
const asciiTheme = {
  icon: {
    cursor: '>',
  },
  style: {
    answer: (text: string) => text,
    message: (text: string) => text,
    error: (text: string) => `[ERR] ${text}`,
    help: (text: string) => text,
    highlight: (text: string) => `> ${text}`,
    description: (text: string) => text,
    disabled: (text: string) => `[X] ${text}`,
    keysHelpTip: () => undefined, // Hide help tip to avoid Unicode issues
  },
};

export interface PromptOptions {
  message: string;
  default?: string;
  required?: boolean;
}

export interface SelectOptions<T> {
  message: string;
  choices: Array<{ value: T; name: string; description?: string }>;
  default?: T;
}

export interface CheckboxOptions<T> {
  message: string;
  choices: Array<{ value: T; name: string; checked?: boolean }>;
  instructions?: boolean;
}

export async function promptText(options: PromptOptions): Promise<string> {
  const result = await input({
    message: options.message,
    default: options.default,
    required: options.required,
  });
  return result;
}

export async function promptSecret(options: PromptOptions): Promise<string> {
  const result = await password({
    message: options.message,
    mask: '*',
  });
  return result;
}

export async function promptConfirm(options: {
  message: string;
  default?: boolean;
}): Promise<boolean> {
  const result = await confirm({
    message: options.message,
    default: options.default ?? true,
  });
  return result;
}

export async function promptSelect<T>(options: SelectOptions<T>): Promise<T> {
  const choices = options.choices.map((c) => ({
    value: c.value,
    name: c.name,
    description: c.description,
  }));

  const result = await select<T>({
    message: options.message,
    choices,
    default: options.default,
    theme: asciiTheme,
  });
  return result;
}

export async function promptCheckbox<T>(options: CheckboxOptions<T>): Promise<T[]> {
  const choices = options.choices.map((c) => ({
    value: c.value,
    name: c.name,
    checked: c.checked ?? false,
  }));

  const result = await checkbox<T>({
    message: options.message,
    choices,
    instructions: options.instructions ?? false, // Disable instructions to avoid Unicode
    theme: asciiTheme,
  });
  return result;
}

export async function promptRadio<T>(
  message: string,
  items: T[],
  displayFn: (item: T) => string,
  defaultIndex: number = 0
): Promise<{ selected: T; index: number }> {
  const choices = items.map((item, index) => ({
    value: index,
    name: displayFn(item),
    description: index === defaultIndex ? '(default)' : undefined,
  }));

  const selectedIndex = await select<number>({
    message,
    choices,
    default: defaultIndex,
    theme: asciiTheme,
  });

  return {
    selected: items[selectedIndex],
    index: selectedIndex,
  };
}

export async function promptChecklist<T>(
  message: string,
  items: T[],
  displayFn: (item: T) => string,
  preSelected: number[] = []
): Promise<T[]> {
  const choices = items.map((item, index) => ({
    value: index,
    name: displayFn(item),
    checked: preSelected.includes(index),
  }));

  const selectedIndices = await checkbox<number>({
    message,
    choices,
    instructions: false,
    theme: asciiTheme,
  });

  return selectedIndices.map((i: number) => items[i]);
}

export default {
  text: promptText,
  secret: promptSecret,
  confirm: promptConfirm,
  select: promptSelect,
  checkbox: promptCheckbox,
  radio: promptRadio,
  checklist: promptChecklist,
};
