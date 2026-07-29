const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  LevelFormat, PageNumber, PageBreak, TabStopType, TabStopPosition
} = require('docx');
const fs = require('fs');
const path = require('path');

// ── Color palette ──────────────────────────────────────────────────────────
const C = {
  black:      '111111',
  darkBlue:   '1A2E4A',
  midBlue:    '2563EB',
  lightBlue:  'DBEAFE',
  accent:     '0EA5E9',
  accentBg:   'E0F2FE',
  gray100:    'F3F4F6',
  gray300:    'D1D5DB',
  gray500:    '6B7280',
  gray700:    '374151',
  white:      'FFFFFF',
  green:      '16A34A',
  greenBg:    'DCFCE7',
  amber:      'D97706',
  amberBg:    'FEF3C7',
  purple:     '7C3AED',
  purpleBg:   'EDE9FE',
};

// ── Border helper ──────────────────────────────────────────────────────────
const border = (color = C.gray300, size = 1) => ({
  style: BorderStyle.SINGLE, size, color
});
const allBorders = (color, size) => {
  const b = border(color, size);
  return { top: b, bottom: b, left: b, right: b };
};
const noBorders = () => {
  const nb = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  return { top: nb, bottom: nb, left: nb, right: nb };
};

// ── Spacing shorthands ─────────────────────────────────────────────────────
const sp = (before, after) => ({ spacing: { before, after } });

// ── Text runs ─────────────────────────────────────────────────────────────
const t = (text, opts = {}) => new TextRun({ text, ...opts });
const bold = (text, opts = {}) => t(text, { bold: true, ...opts });
const mono = (text, opts = {}) => t(text, { font: 'Courier New', size: 18, ...opts });

// ── Paragraph helpers ──────────────────────────────────────────────────────
const h1 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_1,
  children: [new TextRun({ text, bold: true, color: C.darkBlue })],
  spacing: { before: 480, after: 160 },
  border: { bottom: border(C.midBlue, 8) }
});

const h2 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_2,
  children: [new TextRun({ text, bold: true, color: C.darkBlue })],
  spacing: { before: 360, after: 120 },
});

const h3 = (text) => new Paragraph({
  heading: HeadingLevel.HEADING_3,
  children: [new TextRun({ text, bold: true, color: C.gray700 })],
  spacing: { before: 240, after: 80 },
});

const p = (children, opts = {}) => new Paragraph({
  children: Array.isArray(children) ? children : [t(children)],
  spacing: { before: 80, after: 80 },
  ...opts
});

const pb = () => new Paragraph({ children: [new PageBreak()] });

const bullet = (children, level = 0) => new Paragraph({
  numbering: { reference: 'bullets', level },
  children: Array.isArray(children) ? children : [t(children)],
  spacing: { before: 40, after: 40 },
});

const numbered = (children, level = 0, ref = 'numbers') => new Paragraph({
  numbering: { reference: ref, level },
  children: Array.isArray(children) ? children : [t(children)],
  spacing: { before: 40, after: 40 },
});

// ── Code block ─────────────────────────────────────────────────────────────
const codeBlock = (lines) => {
  return lines.map((line, i) => new Paragraph({
    children: [mono(line, { color: C.darkBlue })],
    spacing: { before: i === 0 ? 80 : 0, after: i === lines.length - 1 ? 80 : 0 },
    shading: { fill: C.gray100, type: ShadingType.CLEAR },
    indent: { left: 360 },
    border: i === 0 ? { top: border(C.gray300), left: border(C.midBlue, 12) }
           : i === lines.length - 1 ? { bottom: border(C.gray300), left: border(C.midBlue, 12) }
           : { left: border(C.midBlue, 12) }
  }));
};

// ── Highlight box ──────────────────────────────────────────────────────────
const callout = (label, text, fillColor, labelColor) => [
  new Paragraph({
    children: [
      bold(label + '  ', { color: labelColor }),
      t(text, { color: C.gray700 }),
    ],
    spacing: { before: 120, after: 120 },
    shading: { fill: fillColor, type: ShadingType.CLEAR },
    indent: { left: 360, right: 360 },
    border: { left: border(labelColor, 16) }
  })
];

// ── Simple table ───────────────────────────────────────────────────────────
const CONTENT_W = 9360; // DXA, US Letter 1-inch margins

const simpleTable = (headers, rows, colWidths) => {
  const totalW = colWidths.reduce((a, b) => a + b, 0);
  const headerRow = new TableRow({
    children: headers.map((h, i) => new TableCell({
      borders: allBorders(C.midBlue, 4),
      width: { size: colWidths[i], type: WidthType.DXA },
      shading: { fill: C.darkBlue, type: ShadingType.CLEAR },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: [bold(h, { color: C.white })] })]
    }))
  });
  const dataRows = rows.map((row, ri) => new TableRow({
    children: row.map((cell, ci) => new TableCell({
      borders: allBorders(C.gray300),
      width: { size: colWidths[ci], type: WidthType.DXA },
      shading: { fill: ri % 2 === 0 ? C.white : C.gray100, type: ShadingType.CLEAR },
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      children: [new Paragraph({ children: Array.isArray(cell) ? cell : [t(cell)] })]
    }))
  }));
  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: colWidths,
    rows: [headerRow, ...dataRows]
  });
};

// ══════════════════════════════════════════════════════════════════════════
//  DOCUMENT
// ══════════════════════════════════════════════════════════════════════════
const doc = new Document({
  styles: {
    default: {
      document: { run: { font: 'Arial', size: 22, color: C.black } }
    },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 36, bold: true, font: 'Arial', color: C.darkBlue },
        paragraph: { spacing: { before: 480, after: 160 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 28, bold: true, font: 'Arial', color: C.darkBlue },
        paragraph: { spacing: { before: 360, after: 120 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
        run: { size: 24, bold: true, font: 'Arial', color: C.gray700 },
        paragraph: { spacing: { before: 240, after: 80 }, outlineLevel: 2 } },
    ]
  },
  numbering: {
    config: [
      { reference: 'bullets', levels: [
        { level: 0, format: LevelFormat.BULLET, text: '•',
          style: { paragraph: { indent: { left: 540, hanging: 260 } } } },
        { level: 1, format: LevelFormat.BULLET, text: '◦',
          style: { paragraph: { indent: { left: 900, hanging: 260 } } } },
      ]},
      { reference: 'numbers', levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: '%1.',
          style: { paragraph: { indent: { left: 540, hanging: 260 } } } },
      ]},
      { reference: 'numbers2', levels: [
        { level: 0, format: LevelFormat.DECIMAL, text: '%1.',
          style: { paragraph: { indent: { left: 540, hanging: 260 } } } },
      ]},
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    children: [

      // ═══════════════════════════════════════════════════════════════════
      // COVER
      // ═══════════════════════════════════════════════════════════════════
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 1440, after: 240 },
        children: [new TextRun({ text: 'DUYA', bold: true, size: 72, color: C.midBlue, font: 'Arial' })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 120 },
        children: [new TextRun({ text: 'Agent OS 设计文档', bold: true, size: 40, color: C.darkBlue })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 720 },
        children: [new TextRun({ text: '从应用平台到认知操作系统', size: 26, color: C.gray500, italics: true })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 2880 },
        children: [new TextRun({ text: 'v0.1  ·  2026年5月', size: 22, color: C.gray500 })]
      }),

      // divider
      new Paragraph({
        border: { bottom: border(C.gray300, 4) },
        spacing: { before: 0, after: 480 },
        children: []
      }),

      // abstract
      ...callout('摘要',
        'DUYA 不是又一个 AI 助手。它是一种全新的计算范式：一个 Agent 操作系统，让一组专门的 AI 代理和面向用户的应用程序共享统一的运行时、内存和数据模型。每个应用都是持久化代理的一个感知器官。每一次交互都沉淀到不断增长的个人知识图谱中。用户，第一次真正成为自己数字宇宙的中心——而不是一个在割裂应用集合中的访客。',
        C.accentBg, C.midBlue),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 1. THE MACRO VISION
      // ═══════════════════════════════════════════════════════════════════
      h1('1. 宏观愿景'),

      h2('1.1 应用简史'),
      p('自互联网诞生以来，人与软件的关系经历了四个截然不同的时代：'),
      p(''),

      simpleTable(
        ['时代', '时期', '变革', '遗留问题'],
        [
          ['信息数字化', '1990年代', '图书馆→搜索引擎；报纸→网站。现实被镜像到线上。', '信息是被动的。你必须主动去找。'],
          ['行为数字化', '2007–2015', 'iPhone。网约车、外卖、社交媒体。行为本身数字化。', '应用各自为政。每个只知道你的一小部分。'],
          ['注意力榨取', '2015–2023', '算法推荐、无限滚动。应用开始主动塑造行为。', '用户成为产品。应用针对人类利益进行优化。'],
          ['认知外包', '2023–现在', 'ChatGPT。写作、编程、分析外包给 AI。单点认知增强。', 'AI 和应用在每次会话后断开。没有连续性，没有累积。'],
        ],
        [1600, 1200, 3200, 3360]
      ),

      p(''),
      h2('1.2 DUYA 解决的问题'),
      p([
        t('现代知识工作者的注意力被数十个应用撕碎。每个应用只知道你的一小面。'),
        bold('从来没有一个系统理解过完整的你。'),
        t(' 每天，你手动在应用之间搬运上下文，向 AI 工具重新解释自己，从零开始重建自己的心理状态。这是 21 世纪认知工作中隐藏的税赋。')
      ]),
      p(''),
      ...callout('核心洞察',
        '每一个现有的操作系统——Windows、iOS、Android——都是应用的容器。用户在应用内部是客人。DUYA 反转了这一模式。Agent 是中心。应用是 Agent 的器官。用户，第一次真正成为自己计算环境的拥有者。',
        C.accentBg, C.midBlue),
      p(''),

      h2('1.3 第五时代：认知共生'),
      p('DUYA 提出了第五范式：一个 Agent OS，其中软件不仅仅响应指令，而是持续感知、预测并代表用户行动——跨越他们所有的应用、所有的数据、所有的目标——而从不要求他们的注意力。'),
      p(''),
      p([bold('DUYA 模式：'), t(' 用户 ↔ 应用 ↔ Agent 团队（共享运行时、共享内存、共享用户模型）')]),
      p(''),
      p([bold('旧模式：'), t(' 用户 → 应用 → AI（产生工件）→ 应用与 AI 断开连接')]),
      p(''),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 2. CORE PHILOSOPHY
      // ═══════════════════════════════════════════════════════════════════
      h1('2. 核心理念与设计原则'),

      h2('2.1 应用是器官，而非工具'),
      p('传统应用是你拿起、使用然后放下的工具。在 DUYA 中，应用是一个感知器官：它持续感知用户的操作，向 Agent 团队发送语义信号，并接收指令回来。应用永远不会被"放下"——它始终是 Agent 感知的一部分，即使当用户的屏幕在别处。'),

      h2('2.2 Agent 优先，UI 其次'),
      p('每个 DUYA 应用都同时拥有用户界面和 Agent 界面。UI 是用户看到和交互的。Agent 接口是 Agent 团队读写和推理的。它们共享相同的底层数据——只是以不同的方式呈现给人类和机器。'),

      h2('2.3 内存必须累积'),
      p('今天的 AI 工具在每次会话之间遗忘一切。DUYA 的 WikiAgent 维护着一个结构化的、不断增长的个人知识图谱，跨越所有对话和所有应用。知识不会重置——它持续积累、链接和综合，像一个真正的第二大脑。'),

      h2('2.4 主动性而不侵扰'),
      p('Agent 团队应该像一个优秀的行政助理一样工作：在后台安静工作，在你需要之前准备好一切，在自然的时机浮现洞察——从不制造通知焦虑。每一个主动行为都按侵扰级别分类，并以相应方式交付。'),

      h2('2.5 意图溢出'),
      p('当用户表达一个想法——"我最近对区域感知降水模型很感兴趣"——这个意图不应该死在聊天窗口中。它应该溢出到整个系统：文献 Agent 去搜索，日历 Agent 去预留时间，笔记 Agent 去链接旧笔记。用户表达的意图成为系统级指令。'),

      h2('2.6 用户模型是自主的'),
      p('每个 Agent 和每个应用都基于一个共享的、结构化的用户模型运行：包括用户的目标、专长、工作风格、认知负荷和时间上下文。这个模型由用户拥有、可由用户检查，并持续增长。它是整个系统的结缔组织。'),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 3. KEY INNOVATIONS
      // ═══════════════════════════════════════════════════════════════════
      h1('3. 关键创新'),

      h2('3.1 公告协议'),
      p('DUYA 不使用固定心跳轮询所有 Agent（昂贵且嘈杂），而是采用事件驱动的公告模型：'),
      p(''),
      ...codeBlock([
        '用户对主 Agent 说话',
        '        ↓',
        'Conductor 进程（始终在线的监听者）',
        '        ↓  意图提取（Haiku，低成本）',
        '   intentWeight > threshold？',
        '        ↓ 是',
        '公告发布到 EventBus',
        '        ↓',
        '所有 App-Agent 接收公告',
        '        ↓  本地规则评估（大部分无需 LLM）',
        '响应："我将行动 / 我不行动 / 这是我的提案"',
        '        ↓',
        'Conductor 仲裁：谁行动，什么优先级',
        '        ↓',
        '选中的 App-Agent 静默执行',
      ]),
      p(''),
      p('这个模型意味着 LLM 调用与语义重要性成正比，而非与时间流逝成正比。一天常规活动可能触发零次公告。一次丰富的对话可能触发跨越五个应用的协调行动。'),

      h2('3.2 休眠与唤醒'),
      p([
        t('DUYA 中的应用有三种状态，超越打开/关闭：'),
        bold('休眠'),
        t('。休眠的应用对用户不可见，但对 Agent 是活跃的。Agent 可以读取其状态、准备下一个会话并排队任务——这样当用户打开它时，应用已经预热、个性化并加载好了他们下一步需要的内容。')
      ]),

      h2('3.3 跨应用语义聚类'),
      p('每个应用持续发出语义状态摘要。WikiAgent 将这些摘要嵌入，并运行夜间聚类以检测"偶然邻近"——当两周前写的一条笔记、昨天收集的一篇论文和下周四日历上的一个事件都关于同一个用户尚未有意识关联的问题时。这些连接作为洞察被呈现，而非作为通知。'),

      h2('3.4 三层内存架构'),
      p(''),
      simpleTable(
        ['层级', '名称', '内容', '维护者', '生命周期'],
        [
          ['L1', '事件记忆', '具体操作、输入、今天的交互', 'App-Agent', '短期（天）'],
          ['L2', '上下文记忆', '当前项目、阶段、活跃关注点', '主 Agent + Conductor', '中期（周/月）'],
          ['L3', '叙事记忆', '用户是谁、他们的价值观、长期目标', 'WikiAgent + CogniWiki', '永久（年）'],
        ],
        [800, 1500, 2500, 2200, 1500]
      ),
      p(''),
      p([
        t('L1 事件会'),
        bold('向上蒸馏'),
        t('：L1 中的重复模式结晶为 L2 上下文；稳定的 L2 上下文固化为 L3 叙事。记忆系统永不受限增长——它持续压缩和提升。')
      ]),

      h2('3.5 应用即 Agent 工作负载单元'),
      p('从 DUYA 市场下载的应用不仅仅是 UI。它是一个完整的工作负载包：'),
      bullet([bold('UI 包'), t(' — React 组件树，用户的界面')]),
      bullet([bold('Agent 配置文件'), t(' — 系统提示、工具权限、决策规则、内存范围')]),
      bullet([bold('数据模式'), t(' — 该应用数据在 SQLite 中的结构')]),
      bullet([bold('公告兴趣'), t(' — 哪些语义领域会触发该 Agent')]),
      bullet([bold('休眠能力'), t(' — 用户不在时 Agent 能做什么')]),
      p(''),
      p('用户安装的不是一个 UI——他们是在自己的 Agent 团队中引入一名新成员，该成员拥有自己的专长、自己的责任领域，以及对他们需求的感知。'),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 4. FUNCTIONAL SCENARIOS
      // ═══════════════════════════════════════════════════════════════════
      h1('4. 功能场景'),

      h2('4.1 文献管理器（类似 Zotero）'),
      p('用户打开文献管理器，开始收集关于极端降水建模的论文。在接下来的几天里：'),
      numbered('文献 Agent 检测到最近保存中的主题聚类，开始在后台从 Semantic Scholar 预取相关论文。'),
      numbered('用户在主要聊天中提到"我一直在思考区域感知架构"。Conductor 将其提取为高权重意图，并通知文献 Agent。'),
      numbered('文献 Agent 静默导入三篇该主题的高被引论文，标记为"Lava 提及——高优先级"，并排在未读列表顶部。'),
      numbered('WikiAgent 观察文献活动，为"区域感知降水"创建实体节点，并链接到现有的"PINN"和"极端天气"节点。'),
      numbered('第二天早上，当用户打开应用时，论文已经在那里。没有执行搜索。没有提出请求。'),

      p(''),
      h2('4.2 语言学习应用（类似 Duolingo）'),
      p('用户正在准备雅思。他们安装了一个词汇应用。'),
      numbered('用户在主要聊天中向文献 Agent 请求一个气象术语的翻译。'),
      numbered('Conductor 识别出语言学习信号，通知语言 Agent。'),
      numbered('语言 Agent 使用用户近期文献中的实际术语，准备了一个领域特定的词汇练习，等用户下次打开应用时已就绪。'),
      numbered('连续三天未打开词汇应用后，Conductor 注意到临近的雅思截止日期（来自日历 Agent 的语义状态）并升级：主 Agent 在下一次对话中提到——"你的词汇应用显示考试前有 14 个单词要生锈了。想来个快速学习吗？"'),

      p(''),
      h2('4.3 带 Agent 记忆的笔记应用'),
      p('用户创建了一条新笔记："Saint-Venant 边界条件——处理得不好。"笔记很简略，从未完成。'),
      numbered('WikiAgent 监听并用此会话标签创建一个内存节点，低置信度（来源稀疏）。'),
      numbered('三周后，文献 Agent 导入了一篇专门关于物理信息边界条件的论文。WikiAgent 检测到语义邻近，将两者链接。'),
      numbered('Conductor 的夜间聚类浮现出这个连接。第二天早上，主 Agent 提到："你的笔记和近期文献中有一条线索可能是同一个问题——要我帮你整合一下吗？"'),
      numbered('用户说好。Agent 综合生成一条结构化的笔记，链接两者，并附上相关论文章节。'),

      p(''),
      h2('4.4 意图溢出的实际演示'),
      p([bold('用户说：'), t('"我最近对对比学习越来越感兴趣了。"')]),
      p([bold('幕后发生的事情：')]),
      bullet([bold('文献 Agent：'), t(' 搜索 Semantic Scholar，导入 5 篇基础论文')]),
      bullet([bold('WikiAgent：'), t(' 创建实体节点"对比学习"，链接到现有的 ML 节点')]),
      bullet([bold('日历 Agent：'), t(' 扫描未来一周，找到空闲块，标记为"潜在深度工作：对比学习"')]),
      bullet([bold('笔记 Agent：'), t(' 搜索现有笔记中的语义近邻，创建"相关笔记"合集')]),
      p([bold('用户的体验：'), t(' 立即什么都没发生。但下次他们打开这些应用中的任何一个时，他们会发现系统已经在工作了。')]),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 5. AGENT TEAM DESIGN
      // ═══════════════════════════════════════════════════════════════════
      h1('5. Agent 团队设计'),

      h2('5.1 概览'),
      p('DUYA 的智能不是单个 AI 模型。它是一个结构化的专门 Agent 团队，每个都有明确的角色、通信协议和内存范围。'),
      p(''),
      simpleTable(
        ['Agent', '类型', '角色', '进程模型', '内存范围'],
        [
          ['主 Agent', '内置', '面向用户的主要对话者。意图收集，直接协助。', '按需（AgentProcessPool）', 'L1+L2+L3（读），L1（写）'],
          ['Conductor', '内置', '监听所有主 Agent 轮次，提取意图权重，发布公告，仲裁响应。', '始终在线（专用进程）', 'L2（读/写）'],
          ['WikiAgent', '内置', '从所有对话和应用事件中提取和维护个人知识图谱。', '配置（轮次后触发）', 'L1+L2+L3（读/写）'],
          ['文献 Agent', '应用（内置模板）', '管理学术论文：发现、导入、标记、推荐。', '始终在线（App-Agent 池）', '应用本地 L1，共享 L2'],
          ['语言 Agent', '应用（用户安装）', '管理词汇、语法练习、领域特定练习。', '始终在线（App-Agent 池）', '应用本地 L1，共享 L2'],
          ['日历 Agent', '应用（内置）', '管理时间，检测截止日期压力，预留专注块。', '始终在线（App-Agent 池）', '应用本地 L1，共享 L2'],
          ['子 Agent', '应用定义', 'App-Agent 为深度任务产生的垂直专家（如"引文格式化"子 Agent）。', '按需，短期', '限定在父应用内'],
        ],
        [1500, 1200, 2800, 1900, 1960]
      ),

      p(''),
      h2('5.2 Conductor：协调层'),
      p('Conductor 是架构上最新颖的组件。它不是聊天机器人，不是任务运行器，也不是调度器。它是一个持续的语义观察者，连接用户表达的意图与 Agent 团队的分布式能力。'),
      p(''),
      h3('职责'),
      bullet('监听每个完成的主 Agent 轮次（订阅 chat:done 事件）'),
      bullet('使用低成本模型（Haiku）提取意图信号，按权重分类（0–1 尺度）'),
      bullet('当 intentWeight 超过阈值时向 EventBus 发布公告'),
      bullet('在时间窗口内收集 App-Agent 响应提案'),
      bullet('仲裁：分配行动，设置优先级，防止重叠推送'),
      bullet('学习每个用户对主动性的容忍度，并随时间调整阈值'),
      p(''),
      h3('公告模式'),
      ...codeBlock([
        'interface Announcement {',
        '  id:              string',
        '  trigger:         "user_intent" | "time_event" | "app_signal" | "cross_app_cluster"',
        '  semanticSummary: string          // 发生了什么，用自然语言描述',
        '  intentWeight:    number          // 0.0–1.0',
        '  relevantDomains: string[]        // ["academic", "language", "calendar"]',
        '  timestamp:       number',
        '  expiresAt:       number          // 公告有 TTL',
        '}',
      ]),
      p(''),
      h3('响应与仲裁模式'),
      ...codeBlock([
        'interface AppAgentResponse {',
        '  appId:           string',
        '  willAct:         boolean',
        '  proposedAction:  string          // 人类可读的意图',
        '  priority:        number          // 自评 0–1',
        '  intrusiveness:   0 | 1 | 2 | 3  // 见 §5.4',
        '  estimatedCost:   "low" | "medium" | "high"',
        '}',
      ]),

      p(''),
      h2('5.3 WikiAgent：记忆引擎'),
      p('WikiAgent 维护一个结构化的个人知识图谱，存储为带 YAML frontmatter 的 markdown 文件和一个机器可读的图谱索引。它不是被动的日志——它主动综合、链接和维护知识。'),
      p(''),
      h3('节点类型'),
      simpleTable(
        ['类型', '目录', '回答', '示例'],
        [
          ['实体', 'entities/', '"X 是什么？"', '"PINN 是一种物理信息神经网络架构"'],
          ['概念', 'concepts/', '"X 是什么？"（抽象）', '"区域感知是一种建模策略，它……"'],
          ['记忆', 'memory/', '"X 发生了什么？"', '"2026-05-10，决定使用 D-PINN 进行洪水演进"'],
          ['综合', 'synthesis/', '"X 和 Y 如何关联？"', '"PINN 与传统数值方法在 Saint-Venant 方程上的对比"'],
        ],
        [1200, 1200, 2000, 4960]
      ),
      p(''),
      h3('记忆蒸馏管道'),
      ...codeBlock([
        '// L1 → L2 蒸馏（每日）',
        'L1 事件（今天的应用交互）',
        '   ↓ Listener 提取命名实体 + 决策',
        'WikiAgent 创建/更新记忆节点',
        '   ↓ Gardener 检查重复模式（3 次以上出现）',
        '模式结晶 → L2 上下文条目',
        '',
        '// L2 → L3 蒸馏（每周）',
        '持续 14 天以上且高置信度的 L2 上下文',
        '   ↓ Gardener 综合叙事节点',
        'L3 叙事更新（重大变更需用户确认）',
      ]),
      p(''),
      h3('Gardener：主动知识维护'),
      p('Gardener 通过 DUYA 现有的自动化调度器每日运行。它执行六项检查：'),
      bullet([bold('孤岛检测：'), t(' 没有入链的节点 → 尝试基于关键字的重新链接')]),
      bullet([bold('重复检测：'), t(' 语义相似度扫描 → 标记或自动合并')]),
      bullet([bold('陈旧性检查：'), t(' 30 天未更新且置信度 < 0.5 的节点 → 触发深度研究')]),
      bullet([bold('跨域综合：'), t(' 两个聚类获得新链接 → 生成综合节点')]),
      bullet([bold('置信度衰减：'), t(' 对话来源的发现随时间衰减；文档来源的发现不衰减')]),
      bullet([bold('弱链接补充：'), t(' 共享关键字但没有显式链接 → 添加弱链接')]),

      p(''),
      h2('5.4 主动性级别'),
      p('每个 Agent 行动在执行前都被分配一个侵扰级别。Conductor 强制执行此分类。'),
      p(''),
      simpleTable(
        ['级别', '名称', '交付方式', '示例'],
        [
          ['0', '静默执行', '无通知。用户下次打开时发现。', '标记论文，重组笔记结构，更新单词优先级队列'],
          ['1', '软卡片', '下次用户打开相关应用时，非阻塞卡片出现在应用内。', '"我准备了 3 篇相关论文。想看吗？"'],
          ['2', '对话提及', '主 Agent 在下一次对话轮次中自然提及。', '"顺便说一下，你的词汇应用在考试前有 14 个单词要生锈了。"'],
          ['3', '需确认', '必须等待用户明确批准。', '删除数据，重新安排日历事件，发送外部消息'],
        ],
        [600, 1500, 2500, 4760]
      ),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 6. APP DESIGN
      // ═══════════════════════════════════════════════════════════════════
      h1('6. 应用设计：市场单元'),

      h2('6.1 应用是什么'),
      p('DUYA 应用不是一个独立的应用程序。它是一个结构化的包，用新的领域专长和新的用户界面扩展 Agent 团队。'),

      h2('6.2 应用包结构'),
      ...codeBlock([
        'interface DuyaApp {',
        '  manifest:     AppManifest      // 身份、版本、语义领域',
        '  agentProfile: AppAgentProfile  // 系统提示 + 工具 + 决策规则',
        '  dataSchema:   AppDataSchema    // 本应用的 SQLite 表定义',
        '  uiBundle:     AppUIBundle      // React 组件树，懒加载',
        '}',
        '',
        'interface AppManifest {',
        '  id:                  string    // 如 "literature-manager"',
        '  name:                string',
        '  version:             string',
        '  semanticDomain:      string[]  // ["academic", "research", "citation"]',
        '  announcementInterest:string[]  // 哪些领域会触发此 Agent',
        '  dormantCapabilities: string[]  // 用户不在时可以做什么',
        '}',
        '',
        'interface AppAgentProfile {',
        '  systemPrompt:    string         // 该 Agent 的专长和个性',
        '  allowedTools:    string[]       // "file:*", "search:*", "wiki:read", ...',
        '  decisionRules:   DecisionRule[] // 本地规则：无需 LLM',
        '  memoryScope:     "app-local" | "shared-L2" | "shared-L3"',
        '}',
        '',
        'interface DecisionRule {',
        '  // "如果公告包含领域 X，设置优先级 Y，建议行动 Z"',
        '  matchDomains:    string[]',
        '  priority:        number',
        '  proposedAction:  string',
        '  intrusiveness:   0 | 1 | 2 | 3',
        '}',
      ]),

      p(''),
      h2('6.3 Agent 接口 vs. 用户接口'),
      p('每个应用对同一份数据有两个视图：'),
      p(''),
      simpleTable(
        ['维度', '用户界面（UI）', 'Agent 接口（AI）'],
        [
          ['展示内容', '格式化、可交互、人类可读的呈现', '结构化语义状态：实体、事件、优先级、缺口'],
          ['阅读者', '人类用户', 'Conductor、WikiAgent、其他 App-Agent'],
          ['更新频率', '用户交互时', '每次显著状态变化时，无论用户是否活跃'],
          ['示例（文献应用）', '带标题、作者、标签的论文卡片', '{ recentThemes: ["PINN", "extreme-precip"], unreadCount: 7, staleItems: 2, lastUserSession: "2026-05-23" }'],
        ],
        [2000, 3680, 3680]
      ),

      p(''),
      h2('6.4 应用安装流程'),
      numbered('用户从 DUYA 市场下载应用包'),
      numbered('主进程验证清单模式和安全签名'),
      numbered('AppRegistry 注册 Agent 配置'),
      numbered('App-Agent 进程被生成并进入休眠状态'),
      numbered('SQLite 模式迁移以添加应用的表'),
      numbered('UI 包被放入动态组件注册表'),
      numbered('Conductor 读取应用的 announcementInterest 并更新其路由表'),
      numbered('WikiAgent 索引应用的语义领域以集成知识图谱'),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 7. ENGINEERING ARCHITECTURE
      // ═══════════════════════════════════════════════════════════════════
      h1('7. 工程架构'),

      h2('7.1 三进程模型'),
      p('现有的 DUYA 架构（AgentProcessPool 用于对话 Agent，SQLite 单写入器，MessagePort 用于渲染器通信）通过两个新的进程层扩展：'),
      p(''),
      ...codeBlock([
        '┌──────────────────────────────────────────────────────────────┐',
        '│                  Electron 主进程                               │',
        '│                                                               │',
        '│  SQLite（单写入器） │  EventBus（mitt，持久化）              │',
        '│  AgentProcessPool        │  AppRegistry                      │',
        '│  AutomationScheduler     │  ConductorBridge                  │',
        '└────┬──────────────────────────────────────┬──────────────────┘',
        '     │                                      │',
        '     │ child_process IPC                    │ child_process IPC',
        '     ▼                                      ▼',
        '┌──────────────────┐             ┌──────────────────────────┐',
        '│ 对话              │             │ Conductor 进程            │',
        '│ Agent 池          │             │（始终在线，专用）        │',
        '│（按需）           │             │                           │',
        '│ 每次会话生成       │             │ 订阅：chat:done          │',
        '│ 主 Agent 在此     │             │ 发布：announcements       │',
        '│ WikiAgent 配置    │             │ 仲裁：responses           │',
        '└──────────────────┘             └──────────┬───────────────┘',
        '                                            │ EventBus',
        '                                ┌──────────▼───────────────┐',
        '                                │ App-Agent 池             │',
        '                                │（始终在线，每应用一个）  │',
        '                                │ 文献 Agent               │',
        '                                │ 语言 Agent               │',
        '                                │ 日历 Agent               │',
        '                                │ ...                       │',
        '                                └──────────────────────────┘',
      ]),

      p(''),
      h2('7.2 EventBus 设计'),
      p('EventBus 是 Agent 团队的中枢神经系统。它在主进程内部实现（扩展现有的 mitt 事件总线），并支持持久化以进行重放。'),
      p(''),
      simpleTable(
        ['事件', '发布者', '订阅者', '负载'],
        [
          ['chat:done', 'AgentProcessPool', 'Conductor, WikiAgent', '{ sessionId, messages[] }'],
          ['announcement:publish', 'Conductor', '所有 App-Agent（通过 AppRegistry 路由）', 'Announcement 对象'],
          ['announcement:response', 'App-Agent', 'Conductor', 'AppAgentResponse 对象'],
          ['app:semantic:state', 'App-Agent', 'Conductor, WikiAgent', '{ appId, semanticState, timestamp }'],
          ['wiki:node:updated', 'WikiAgent', 'Conductor（用于跨应用聚类）', '{ nodeId, type, keywords }'],
          ['user:model:patch', 'Conductor / WikiAgent', '所有 App-Agent', '{ slice, data }'],
        ],
        [2200, 2000, 2400, 2760]
      ),

      p(''),
      h2('7.3 新的 IPC 消息类型'),
      p('扩展现有的主进程 ↔ Agent 进程 IPC 协议：'),
      p(''),
      ...codeBlock([
        '// 主进程 → App-Agent（新增）',
        '"announcement:deliver"    // Conductor 将公告转发给特定 Agent',
        '"app:dormant:task"        // 为休眠执行安排任务',
        '"user:model:slice"        // 交付用户模型的相关部分',
        '"app:config:update"       // 动态配置变更',
        '',
        '// App-Agent → 主进程（新增）',
        '"announcement:response"   // App-Agent 对公告的响应提案',
        '"app:semantic:state"      // 周期性语义状态上传',
        '"app:data:write"          // 请求写入应用的 SQLite 表',
        '"app:action:propose"      // 提议 2-3 级行动供仲裁',
        '',
        '// 主进程 → Conductor（新增）',
        '"chat:done:forward"       // 将完成的轮次转发给 Conductor',
        '"app:response:collected"  // 所有 App 响应已收到，触发仲裁',
        '',
        '// Conductor → 主进程（新增）',
        '"arbitration:result"      // 最终决策：谁做什么',
      ]),

      p(''),
      h2('7.4 SQLite 模式扩展'),
      p('现有的单写入器 SQLite 架构得以保留。为 Agent OS 层添加新表：'),
      p(''),
      ...codeBlock([
        '-- 应用注册表',
        'CREATE TABLE app_registry (',
        '  app_id          TEXT PRIMARY KEY,',
        '  manifest_json   TEXT NOT NULL,',
        '  agent_profile   TEXT NOT NULL,',
        '  installed_at    INTEGER,',
        '  is_active       INTEGER DEFAULT 1',
        ');',
        '',
        '-- 公告日志（用于重放 + 分析）',
        'CREATE TABLE conductor_announcements (',
        '  id              TEXT PRIMARY KEY,',
        '  trigger_type    TEXT,',
        '  semantic_summary TEXT,',
        '  intent_weight   REAL,',
        '  relevant_domains TEXT,  -- JSON 数组',
        '  created_at      INTEGER,',
        '  expires_at      INTEGER,',
        '  arbitration_result TEXT  -- JSON',
        ');',
        '',
        '-- 应用语义状态快照',
        'CREATE TABLE app_semantic_states (',
        '  app_id          TEXT,',
        '  snapshot_json   TEXT,',
        '  captured_at     INTEGER,',
        '  PRIMARY KEY (app_id, captured_at)',
        ');',
        '',
        '-- 每个应用的数据表（命名空间化）',
        '-- 安装的应用获得前缀为 app_{app_id}_ 的表',
        '-- 如 app_literature_papers, app_literature_tags',
        '-- 模式迁移由 AppRegistry 在安装时管理',
      ]),

      p(''),
      h2('7.5 AppRegistry'),
      p('AppRegistry 是新的主进程组件，负责已安装应用的生命周期：'),
      bullet([bold('注册：'), t(' 验证清单，存储在 SQLite，将 Agent 配置注入 App-Agent 池')]),
      bullet([bold('路由表：'), t(' 将 announcementInterest 领域映射到应用 ID，供 Conductor 分发使用')]),
      bullet([bold('模式管理：'), t(' 在应用安装或更新时运行 SQLite 迁移')]),
      bullet([bold('进程管理：'), t(' 通过 App-Agent 池生成/终止 App-Agent 进程')]),
      bullet([bold('用户模型分发：'), t(' 在启动时和 user:model:patch 事件时向每个应用交付相关用户模型切片')]),

      p(''),
      h2('7.6 WikiAgent 集成点'),
      p('WikiAgent（已设计为 AgentProfile）获得三个新的集成钩子：'),
      bullet([bold('应用事件订阅：'), t(' 订阅 app:semantic:state 事件；从应用活动（不仅仅是聊天）提取记忆节点')]),
      bullet([bold('Conductor 公告感知：'), t(' 订阅 announcement:publish；将意图事件记录为记忆/L2 上下文节点')]),
      bullet([bold('跨应用嵌入：'), t(' 夜间任务嵌入所有应用语义状态并运行聚类；当聚类收敛时写入跨应用综合节点')]),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 8. KNOWN PROBLEMS & MITIGATIONS
      // ═══════════════════════════════════════════════════════════════════
      h1('8. 已知问题与缓解措施'),
      p(''),
      simpleTable(
        ['问题', '风险', '缓解措施'],
        [
          ['App-Agent 进程数随安装应用线性增长', '安装大量应用时内存压力', 'App-Agent 池有休眠层：非活跃 Agent 被挂起，状态检查点；在相关公告时唤醒'],
          ['意图提取误报', '不必要的公告、噪声、浪费 LLM 调用', 'intentWeight 阈值为每个用户调整；公告有 TTL；Conductor 从被忽略的提案中学习（降低该 Agent 的未来权重）'],
          ['GraphManager 并发写（Gardener + Listener）', '损坏 _graph.json', 'AsyncLock 写互斥锁已在 wiki-agent.md 中设计；Gardener 和 Listener 共享一个锁域'],
          ['公告响应窗口时序', '慢速 App-Agent 延迟仲裁', '固定 500ms 响应窗口；未响应的 Agent 跳过；响应排队等待下一个周期'],
          ['跨应用的用户模型隐私', '向 App-Agent 过度共享敏感个人数据', '用户模型按相关性切片；每个应用只接收其声明的 memoryScope 字段；L3 叙事仅交付给内置 Agent'],
          ['现有 AgentProcessPool 不适用于始终在线的 Agent', 'CPU/2 上限与 App-Agent 池冲突', 'App-Agent 池是一个独立的池，有自己的资源管理器；休眠状态的应用消耗接近零资源'],
        ],
        [2200, 2400, 4760]
      ),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 9. BUILD ROADMAP
      // ═══════════════════════════════════════════════════════════════════
      h1('9. 分阶段构建路线图'),

      h2('阶段 0 — 基础（前提条件）'),
      p('没有新的用户可见功能。仅限内部基础设施。'),
      bullet('设计并实现带有持久化的 EventBus（扩展现有 mitt）'),
      bullet('实现 AppRegistry（清单验证、路由表、SQLite 模式迁移）'),
      bullet('定义所有新的 IPC 消息类型；更新 agent-communicator.ts'),
      bullet('将 App-Agent 池与现有 AgentProcessPool 分离'),

      h2('阶段 1 — Conductor MVP'),
      bullet('将 Conductor 实现为专用的始终在线进程'),
      bullet('意图提取管道（Haiku，intentWeight 评分）'),
      bullet('带有固定 500ms 响应窗口的公告发布/订阅'),
      bullet('基本仲裁（优先级排序，前 N 名胜出）'),
      bullet('仅主动性级别 0 和 1（静默执行 + 软卡片）'),

      h2('阶段 2 — 首个应用：文献管理器'),
      bullet('定义 AppManifest + AppAgentProfile 模式'),
      bullet('构建文献管理器应用包（UI + Agent 配置 + 模式）'),
      bullet('实现 app:semantic:state 发射'),
      bullet('将文献 Agent 连接到 Conductor 公告流程'),
      bullet('休眠层：Agent 在 15 分钟无公告时挂起'),

      h2('阶段 3 — WikiAgent 跨应用扩展'),
      bullet('扩展 WikiAgent Listener 以订阅 app:semantic:state'),
      bullet('实现夜间跨应用语义聚类'),
      bullet('从跨应用聚类生成综合节点'),
      bullet('通过 Conductor 作为 1 级软卡片呈现洞察'),

      h2('阶段 4 — 用户模型与个性化'),
      bullet('定义结构化用户模型模式'),
      bullet('实现向 App-Agent 交付用户模型切片'),
      bullet('首次打开时的 App-Agent 个性化（热启动）'),
      bullet('Conductor 从交互历史中学习用户主动性容忍度'),

      h2('阶段 5 — 市场'),
      bullet('定义应用包格式和签名标准'),
      bullet('在 DUYA 内构建市场 UI'),
      bullet('第三方 Agent 配置的沙箱和安全审查'),
      bullet('安装/更新/卸载生命周期及模式迁移'),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 10. CLOSING
      // ═══════════════════════════════════════════════════════════════════
      h1('10. 结语：这究竟是什么'),

      p('互联网给了我们信息。智能手机给了我们连接。社交媒体给了我们表达。AI 工具给了我们能力。'),
      p(''),
      p([
        t('但没有任何一个给了我们'),
        bold('一致性'),
        t('。没有任何一个让我们的数字生活感觉属于我们、感觉它了解我们、感觉它在'),
        bold('为我们'),
        t('工作——而不是要求我们的注意力。')
      ]),
      p(''),
      p('DUYA 是第一次严肃的尝试，构建一个以用户为基本组织原则的计算环境——而不是以应用、不是以平台、不是以算法。'),
      p(''),
      p('这份文档中的每一个设计决策都源于一个问题：这会让用户更多还是更少地掌控自己的认知生活？这个问题就是北极星。'),
      p(''),
      p('Agent 团队不是产品。知识图谱不是产品。应用市场不是产品。'),
      p(''),
      ...callout('产品', '就是第一次被自己的技术真诚关照的感觉。', C.accentBg, C.midBlue),
      p(''),
      p(''),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 480, after: 0 },
        children: [new TextRun({ text: '— 文档结束 —', color: C.gray500, italics: true, size: 20 })],
        border: { top: border(C.gray300, 4) }
      }),

    ]
  }]
});

const outputDir = process.platform === 'win32'
  ? 'E:\\Users\\lavachen\\Downloads'
  : '/mnt/user-data/outputs';
const outputPath = path.join(outputDir, 'DUYA-AgentOS-Design-中文版.docx');

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(outputPath, buf);
  console.log('Done:', outputPath);
});
