/**
 * TUI Components for CLI
 *
 * Provides blessed-based terminal UI components similar to hermes-agent:
 * - Fixed bottom input box
 * - Scrollable message list
 * - Optional status bar
 * - Keyboard navigation for selections
 */

import blessed from 'blessed';
import type { Widgets } from 'blessed';

export interface TUIAppOptions {
  title?: string;
  showStatusBar?: boolean;
  onInput?: (text: string) => void | Promise<void>;
  onInterrupt?: () => void;
  statusBarText?: () => string;
}

export class TUIApp {
  private screen: Widgets.Screen;
  private messageBox: Widgets.BoxElement;
  private inputBox: Widgets.TextboxElement;
  private statusBar?: Widgets.BoxElement;
  private options: TUIAppOptions;
  private isRunning: boolean = false;
  private messageLines: string[] = [];

  constructor(options: TUIAppOptions = {}) {
    this.options = {
      title: 'DUYA Agent',
      showStatusBar: true,
      ...options,
    };

    this.screen = blessed.screen({
      smartCSR: true,
      title: this.options.title,
      fullUnicode: true,
    });

    const statusBarHeight = this.options.showStatusBar ? 1 : 0;

    this.messageBox = blessed.box({
      top: 0,
      left: 0,
      right: 0,
      bottom: 3 + statusBarHeight,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      vi: true,
      tags: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'cyan',
        },
      },
    });

    this.inputBox = blessed.textbox({
      bottom: 1 + statusBarHeight,
      left: 0,
      right: 0,
      height: 3,
      inputOnFocus: true,
      border: {
        type: 'line',
      },
      style: {
        border: {
          fg: 'green',
        },
        focus: {
          border: {
            fg: 'brightgreen',
          },
        },
      },
    });

    if (this.options.showStatusBar) {
      this.statusBar = blessed.box({
        bottom: 0,
        left: 0,
        right: 0,
        height: 1,
        tags: true,
        style: {
          bg: 'blue',
          fg: 'white',
        },
      });
      this.screen.append(this.statusBar);
    }

    this.screen.append(this.messageBox);
    this.screen.append(this.inputBox);

    this.setupEventHandlers();
  }

  private setupEventHandlers(): void {
    this.screen.key(['escape', 'q', 'C-c'], () => {
      if (this.options.onInterrupt) {
        this.options.onInterrupt();
      }
      this.stop();
    });

    this.inputBox.key('enter', async () => {
      const text = this.inputBox.getValue().trim();
      if (text) {
        this.inputBox.clearValue();
        this.screen.render();
        if (this.options.onInput) {
          await this.options.onInput(text);
        }
      }
    });

    this.inputBox.key('tab', () => {
      this.inputBox.setValue(this.inputBox.getValue() + '  ');
      this.screen.render();
    });

    this.screen.on('resize', () => {
      this.screen.render();
    });
  }

  start(): void {
    this.isRunning = true;
    this.screen.render();
    this.inputBox.focus();
  }

  stop(): void {
    this.isRunning = false;
    this.screen.destroy();
  }

  print(message: string): void {
    this.messageLines.push(message);
    this.updateMessageBox();
  }

  println(message: string): void {
    this.messageLines.push(message);
    this.updateMessageBox();
  }

  printColored(message: string, colorName: string): void {
    const colorMap: Record<string, string> = {
      red: 'red',
      green: 'green',
      yellow: 'yellow',
      blue: 'blue',
      magenta: 'magenta',
      cyan: 'cyan',
      white: 'white',
      dim: 'gray',
    };
    const tag = colorMap[colorName] || 'white';
    this.messageLines.push(`{${tag}-fg}${message}{/${tag}-fg}`);
    this.updateMessageBox();
  }

  clear(): void {
    this.messageLines = [];
    this.messageBox.setContent('');
    this.screen.render();
  }

  private updateMessageBox(): void {
    this.messageBox.setContent(this.messageLines.join('\n'));
    this.messageBox.setScrollPerc(100);
    this.screen.render();
  }

  updateStatusBar(): void {
    if (this.statusBar && this.options.statusBarText) {
      this.statusBar.setContent(this.options.statusBarText());
      this.screen.render();
    }
  }

  get running(): boolean {
    return this.isRunning;
  }

  focusInput(): void {
    this.inputBox.focus();
    this.screen.render();
  }
}

export default TUIApp;
