/**
 * The schematic view: the shell's big blocks, drawn.
 *
 * ## Why this exists
 *
 * A structural discussion ("should the sidebar sit on top?") does not need
 * real components, real data or real behaviour — it needs to see WHERE the
 * blocks are and how much room each one gets. The product's own render
 * answers the second question and hides the first under real content.
 *
 * So the schematic draws the same blocks with their real proportions and
 * their real names, and nothing else.
 *
 * The layout is a GRID with explicit tracks, not nested flex boxes: a
 * diagram whose own proportions wobble is worse than no diagram.
 */

import type { ReactNode } from 'react';

interface BlockProps {
  readonly label: string;
  readonly hint?: string;
  readonly children?: ReactNode;
  readonly className?: string;
}

function Block({ label, hint, children, className }: BlockProps) {
  return (
    <div className={className === undefined ? 'mock-schematic-block' : `mock-schematic-block ${className}`}>
      <span className="mock-schematic-label">{label}</span>
      {hint === undefined ? null : <span className="mock-schematic-hint">{hint}</span>}
      {children}
    </div>
  );
}

export function SchematicView() {
  return (
    <div className="mock-schematic">
      <header className="mock-schematic-header">
        <strong>结构示意</strong>
        <span>只画大骨架：侧栏、顶栏、对话区、右侧面板、状态条</span>
      </header>
      <div className="mock-schematic-body">
        <Block label="应用轨" hint="图标" className="mock-schematic-rail" />
        <Block label="侧栏" hint="会话 / 项目分组" className="mock-schematic-sidebar">
          <div className="mock-schematic-lines">
            <i />
            <i />
            <i />
            <i />
          </div>
        </Block>
        <Block label="顶栏" hint="标题 / 前进后退" className="mock-schematic-titlebar" />
        <Block label="对话区" hint="消息 + 输入框" className="mock-schematic-chat">
          <div className="mock-schematic-lines">
            <i style={{ width: '62%' }} />
            <i style={{ width: '78%' }} />
            <i style={{ width: '44%' }} />
          </div>
        </Block>
        <Block label="右侧面板" hint="Review / Terminal / Preview" className="mock-schematic-panel">
          <div className="mock-schematic-lines">
            <i />
            <i style={{ width: '70%' }} />
          </div>
        </Block>
        <Block label="状态条" hint="版本 / 更新" className="mock-schematic-status" />
      </div>
    </div>
  );
}
