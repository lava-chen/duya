const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  LevelFormat, PageNumber, PageBreak, TabStopType, TabStopPosition
} = require('docx');
const fs = require('fs');

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
        { level: 0, format: LevelFormat.BULLET, text: '\u2022',
          style: { paragraph: { indent: { left: 540, hanging: 260 } } } },
        { level: 1, format: LevelFormat.BULLET, text: '\u25E6',
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
        children: [new TextRun({ text: 'Agent OS Design Document', bold: true, size: 40, color: C.darkBlue })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 720 },
        children: [new TextRun({ text: 'From App Platform to Cognitive Operating System', size: 26, color: C.gray500, italics: true })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 2880 },
        children: [new TextRun({ text: 'v0.1  ·  May 2026', size: 22, color: C.gray500 })]
      }),

      // divider
      new Paragraph({
        border: { bottom: border(C.gray300, 4) },
        spacing: { before: 0, after: 480 },
        children: []
      }),

      // abstract
      ...callout('Abstract',
        'DUYA is not another AI assistant. It is a new computing paradigm: an Agent Operating System where a team of specialized AI agents and user-facing apps share a unified runtime, memory, and data model. Every app is a sensory organ of a persistent agent. Every interaction compounds into a growing personal knowledge graph. The user is, for the first time, truly the center of their own digital universe — not a visitor inside a collection of disconnected apps.',
        C.accentBg, C.midBlue),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 1. THE MACRO VISION
      // ═══════════════════════════════════════════════════════════════════
      h1('1. The Macro Vision'),

      h2('1.1 A Brief History of the App'),
      p('Since the invention of the internet, the relationship between humans and software has evolved through four distinct eras:'),
      p(''),

      simpleTable(
        ['Era', 'Period', 'What Changed', 'Problem Left Unsolved'],
        [
          ['Information Digitization', '1990s', 'Libraries → Search engines; newspapers → websites. Reality was mirrored online.', 'Information was passive. You had to go find it.'],
          ['Behavior Digitization', '2007–2015', 'iPhone. Ride-hailing, food delivery, social media. Behavior itself became digital.', 'Apps were siloed. Each one knew only its own slice of you.'],
          ['Attention Extraction', '2015–2023', 'Algorithmic feeds, infinite scroll. Apps began actively shaping behavior.', 'The user became the product. Apps optimized against human interests.'],
          ['Cognitive Outsourcing', '2023–Now', 'ChatGPT. Writing, coding, analysis outsourced to AI. Single-point cognitive augmentation.', 'AI and app disconnected after each session. No continuity, no compounding.'],
        ],
        [1600, 1200, 3200, 3360]
      ),

      p(''),
      h2('1.2 The Problem DUYA Solves'),
      p([
        t('The modern knowledge worker\'s attention is shredded across dozens of apps. Each app knows only one facet of who you are. '),
        bold('No system has ever understood the complete you.'),
        t(' Every day, you manually carry context between apps, re-explain yourself to AI tools, and reconstruct your own mental state from scratch. This is the hidden tax of 21st-century cognitive work.')
      ]),
      p(''),
      ...callout('Core Insight',
        'Every existing operating system — Windows, iOS, Android — is a container for apps. The user is a guest inside apps. DUYA inverts this. The agent is the center. Apps are organs of the agent. The user is, for the first time, the actual owner of their own computing environment.',
        C.accentBg, C.midBlue),
      p(''),

      h2('1.3 The Fifth Era: Cognitive Symbiosis'),
      p('DUYA proposes the fifth paradigm: an Agent OS where software does not just respond to commands, but continuously perceives, anticipates, and acts on behalf of the user — across all their apps, all their data, all their goals — without ever demanding their attention.'),
      p(''),
      p([bold('The DUYA Model: '), t('User ↔ Apps ↔ Agent Team (shared runtime, shared memory, shared user model)')]),
      p(''),
      p([bold('The Old Model: '), t('User → App → AI (creates artifact) → App and AI disconnect')]),
      p(''),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 2. CORE PHILOSOPHY
      // ═══════════════════════════════════════════════════════════════════
      h1('2. Core Philosophy & Design Principles'),

      h2('2.1 Apps Are Organs, Not Tools'),
      p('A traditional app is a tool you pick up, use, and put down. In DUYA, an app is a sensory organ: it continuously perceives the user\'s actions, feeds semantic signals to the agent team, and receives instructions back. The app is never "put down" — it is always part of the agent\'s awareness, even when the user\'s screen is on something else.'),

      h2('2.2 Agent-First, UI-Second'),
      p('Every DUYA app ships with both a user interface and an agent interface. The UI is what the user sees and touches. The agent interface is what the agent team reads, writes, and reasons about. They share the same underlying data — presented differently to human and machine.'),

      h2('2.3 Memory Must Compound'),
      p('Today\'s AI tools forget everything between sessions. DUYA\'s WikiAgent maintains a structured, growing personal knowledge graph that spans all conversations and all apps. Knowledge does not reset — it accumulates, links, and synthesizes over time, like a genuine second brain.'),

      h2('2.4 Proactivity Without Intrusion'),
      p('The agent team should act like a great executive assistant: working quietly in the background, preparing things before you need them, surfacing insights at natural moments — never creating notification anxiety. Every proactive action is classified by intrusiveness level and delivered accordingly.'),

      h2('2.5 Intent Overflow'),
      p('When a user expresses a thought — "I\'ve been interested in regime-aware precipitation models lately" — that intent should not die in the chat window. It should overflow into the entire system: the literature agent searches, the calendar agent reserves time, the note agent links old notes. The user\'s expressed intentions become system-wide directives.'),

      h2('2.6 The User Model Is Sovereign'),
      p('Every agent and every app operates from a shared, structured model of the user: their goals, expertise, working style, cognitive load, and temporal context. This model is owned by the user, inspectable by the user, and grows continuously. It is the connective tissue of the entire system.'),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 3. KEY INNOVATIONS
      // ═══════════════════════════════════════════════════════════════════
      h1('3. Key Innovations'),

      h2('3.1 The Announcement Protocol'),
      p('Rather than a fixed heartbeat that polls all agents on a timer (expensive, noisy), DUYA uses an event-driven announcement model:'),
      p(''),
      ...codeBlock([
        'User speaks to Main Agent',
        '        ↓',
        'Conductor Process (always-on listener)',
        '        ↓  intent extraction (Haiku, cheap)',
        '   intentWeight > threshold?',
        '        ↓ YES',
        'Announcement published to EventBus',
        '        ↓',
        'All App-Agents receive announcement',
        '        ↓  local rule evaluation (no LLM needed for most)',
        'Responses: "I will act / I won\'t act / here\'s my proposal"',
        '        ↓',
        'Conductor arbitrates: who acts, at what priority level',
        '        ↓',
        'Selected App-Agent executes silently',
      ]),
      p(''),
      p('This model means LLM calls are proportional to semantic significance, not to time elapsed. A day of routine activity may trigger zero announcements. A single rich conversation may trigger coordinated action across five apps.'),

      h2('3.2 Dormancy & Awakening'),
      p([
        t('Apps in DUYA have a third state beyond open/closed: '),
        bold('dormant'),
        t('. A dormant app is invisible to the user but alive to the agent. The agent can read its state, prepare its next session, and queue tasks — so that when the user opens it, the app is already warm, personalized, and loaded with what they need next.')
      ]),

      h2('3.3 Cross-App Semantic Clustering'),
      p('Each app continuously emits a semantic state summary. The WikiAgent embeds these summaries and runs nightly clustering to detect "accidental proximity" — when a note written two weeks ago, a paper collected yesterday, and a calendar event next Thursday are all about the same underlying problem the user hasn\'t consciously connected yet. These connections are surfaced as insights, not notifications.'),

      h2('3.4 Three-Layer Memory Architecture'),
      p(''),
      simpleTable(
        ['Layer', 'Name', 'Content', 'Maintained By', 'Lifetime'],
        [
          ['L1', 'Event Memory', 'Specific actions, inputs, interactions today', 'App-Agents', 'Short (days)'],
          ['L2', 'Contextual Memory', 'Current projects, phases, active concerns', 'Main Agent + Conductor', 'Medium (weeks/months)'],
          ['L3', 'Narrative Memory', 'Who the user is, their values, long-term goals', 'WikiAgent + CogniWiki', 'Permanent (years)'],
        ],
        [800, 1500, 2500, 2200, 1500]
      ),
      p(''),
      p([
        t('L1 events are '),
        bold('distilled upward'),
        t(' on a schedule: repeated patterns in L1 crystallize into L2 context; stable L2 context solidifies into L3 narrative. The memory system never grows without bound — it continuously compresses and promotes.')
      ]),

      h2('3.5 The App as an Agent Workload Unit'),
      p('An app downloaded from the DUYA marketplace is not just a UI. It is a complete workload package:'),
      bullet([bold('UI Bundle'), t(' — React component tree, the user\'s interface')]),
      bullet([bold('Agent Profile'), t(' — system prompt, tool permissions, decision rules, memory scope')]),
      bullet([bold('Data Schema'), t(' — how this app\'s data is structured in SQLite')]),
      bullet([bold('Announcement Interests'), t(' — which semantic domains trigger this agent')]),
      bullet([bold('Dormant Capabilities'), t(' — what the agent can do without the user present')]),
      p(''),
      p('The user does not install a UI — they onboard a new member of their agent team, with its own expertise, its own area of responsibility, and its own awareness of what they need.'),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 4. FUNCTIONAL SCENARIOS
      // ═══════════════════════════════════════════════════════════════════
      h1('4. Functional Scenarios'),

      h2('4.1 The Literature Manager (Zotero-like)'),
      p('The user opens the literature manager and begins collecting papers on extreme precipitation modeling. Over the following days:'),
      numbered('The Literature Agent detects a thematic cluster in recent saves and begins pre-fetching related papers from Semantic Scholar in the background.'),
      numbered('The user mentions "I\'ve been thinking about regime-aware architectures" in the main chat. Conductor extracts this as a high-weight intent and notifies the Literature Agent.'),
      numbered('The Literature Agent silently imports three highly-cited papers on the topic, tags them "Lava mentioned — high priority," and queues them at the top of the unread list.'),
      numbered('WikiAgent observes the literature activity, creates entity nodes for "regime-aware precipitation" and links them to existing nodes on "PINN" and "extreme weather."'),
      numbered('The next morning, when the user opens the app, the papers are already there. No search was performed. No request was made.'),

      p(''),
      h2('4.2 The Language Learning App (Duolingo-like)'),
      p('The user is preparing for IELTS. They have a vocabulary app installed.'),
      numbered('The user asks the Literature Agent for a translation of a meteorological term in the main chat.'),
      numbered('Conductor identifies a language-learning signal and notifies the Language Agent.'),
      numbered('The Language Agent prepares a domain-specific vocabulary exercise using actual terms from the user\'s recent literature, ready for the next time the user opens the app.'),
      numbered('After three days without opening the vocab app, Conductor notices the approaching IELTS deadline (from the Calendar Agent\'s semantic state) and escalates: the Main Agent mentions it in the next conversation — "Your vocab app says you have 14 words going stale before your exam. Want to do a quick session?"'),

      p(''),
      h2('4.3 The Note App with Agent Memory'),
      p('The user creates a new note: "Saint-Venant boundary conditions — not handled well." The note is sparse and never finished.'),
      numbered('WikiAgent listens and creates a memory node tagged with this session, low confidence (sparse source).'),
      numbered('Three weeks later, the Literature Agent imports a paper specifically on physics-informed boundary conditions. WikiAgent detects semantic proximity and links the two.'),
      numbered('Conductor\'s nightly clustering surfaces this connection. The next morning, the Main Agent mentions: "There\'s a thread across your notes and recent literature that might be the same problem — want me to pull them together?"'),
      numbered('The user says yes. The agent synthesizes a structured note linking the two, with the relevant paper section attached.'),

      p(''),
      h2('4.4 Intent Overflow in Action'),
      p([bold('User says: '), t('"I\'ve been getting more interested in contrastive learning recently."')]),
      p([bold('What happens silently:')]),
      bullet([bold('Literature Agent: '), t('searches Semantic Scholar, imports 5 foundational papers')]),
      bullet([bold('WikiAgent: '), t('creates entity node "Contrastive Learning," links to existing ML nodes')]),
      bullet([bold('Calendar Agent: '), t('scans upcoming week, finds a free block, tags it "potential deep-work: contrastive learning"')]),
      bullet([bold('Note Agent: '), t('searches existing notes for semantic neighbors, creates a "Related Notes" collection')]),
      p([bold('What the user experiences: '), t('Nothing immediately. But the next time they open any of these apps, they find the system has already been working.')]),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 5. AGENT TEAM DESIGN
      // ═══════════════════════════════════════════════════════════════════
      h1('5. The Agent Team'),

      h2('5.1 Overview'),
      p('DUYA\'s intelligence is not a single AI model. It is a structured team of specialized agents, each with a defined role, communication protocol, and memory scope.'),
      p(''),
      simpleTable(
        ['Agent', 'Type', 'Role', 'Process Model', 'Memory Scope'],
        [
          ['Main Agent', 'Built-in', 'Primary user-facing conversationalist. Intent collection, direct assistance.', 'On-demand (AgentProcessPool)', 'L1+L2+L3 (read), L1 (write)'],
          ['Conductor', 'Built-in', 'Listens to all main-agent turns, extracts intent weight, publishes announcements, arbitrates responses.', 'Always-on (dedicated process)', 'L2 (read/write)'],
          ['WikiAgent', 'Built-in', 'Extracts and maintains the personal knowledge graph from all conversations and app events.', 'Profile (post-turn trigger)', 'L1+L2+L3 (read/write)'],
          ['Literature Agent', 'App (built-in template)', 'Manages academic papers: discovery, import, tagging, recommendation.', 'Always-on (App-Agent Pool)', 'App-local L1, shared L2'],
          ['Language Agent', 'App (user-installed)', 'Manages vocabulary, grammar practice, domain-specific exercises.', 'Always-on (App-Agent Pool)', 'App-local L1, shared L2'],
          ['Calendar Agent', 'App (built-in)', 'Manages time, detects deadline pressure, reserves focus blocks.', 'Always-on (App-Agent Pool)', 'App-local L1, shared L2'],
          ['Sub-Agents', 'App-defined', 'Vertical specialists spawned by App-Agents for deep tasks (e.g., a "citation formatter" sub-agent).', 'On-demand, short-lived', 'Scoped to parent app'],
        ],
        [1500, 1200, 2800, 1900, 1960]
      ),

      p(''),
      h2('5.2 Conductor: The Coordination Layer'),
      p('Conductor is the most architecturally novel component. It is not a chatbot, not a task runner, and not a scheduler. It is a continuous semantic observer that bridges the user\'s expressed intent with the agent team\'s distributed capabilities.'),
      p(''),
      h3('Responsibilities'),
      bullet('Listen to every completed main-agent turn (subscribes to chat:done events)'),
      bullet('Extract intent signals using a cheap model (Haiku), classify by weight (0–1 scale)'),
      bullet('Publish Announcements to the EventBus when intentWeight exceeds threshold'),
      bullet('Collect App-Agent response proposals within a time window'),
      bullet('Arbitrate: assign actions, set priority levels, prevent overlapping pushes'),
      bullet('Learn each user\'s tolerance for proactivity and adjust thresholds over time'),
      p(''),
      h3('Announcement Schema'),
      ...codeBlock([
        'interface Announcement {',
        '  id:              string',
        '  trigger:         "user_intent" | "time_event" | "app_signal" | "cross_app_cluster"',
        '  semanticSummary: string          // what happened, in plain language',
        '  intentWeight:    number          // 0.0–1.0',
        '  relevantDomains: string[]        // ["academic", "language", "calendar"]',
        '  timestamp:       number',
        '  expiresAt:       number          // announcements have TTL',
        '}',
      ]),
      p(''),
      h3('Response & Arbitration Schema'),
      ...codeBlock([
        'interface AppAgentResponse {',
        '  appId:           string',
        '  willAct:         boolean',
        '  proposedAction:  string          // human-readable intent',
        '  priority:        number          // self-assessed 0–1',
        '  intrusiveness:   0 | 1 | 2 | 3  // see §5.4',
        '  estimatedCost:   "low" | "medium" | "high"',
        '}',
      ]),

      p(''),
      h2('5.3 WikiAgent: The Memory Engine'),
      p('WikiAgent maintains a structured personal knowledge graph stored as markdown files with YAML frontmatter and a machine-readable graph index. It is not a passive log — it actively synthesizes, links, and maintains knowledge.'),
      p(''),
      h3('Node Types'),
      simpleTable(
        ['Type', 'Directory', 'Answers', 'Example'],
        [
          ['Entity', 'entities/', '"What is X?"', '"PINN is a physics-informed neural network architecture"'],
          ['Concept', 'concepts/', '"What is X?" (abstract)', '"Regime-awareness is a modeling strategy that..."'],
          ['Memory', 'memory/', '"What happened with X?"', '"On 2026-05-10, decided to use D-PINN for flood routing"'],
          ['Synthesis', 'synthesis/', '"How do X and Y relate?"', '"PINN vs traditional numerical methods for Saint-Venant"'],
        ],
        [1200, 1200, 2000, 4960]
      ),
      p(''),
      h3('Memory Distillation Pipeline'),
      ...codeBlock([
        '// L1 → L2 distillation (daily)',
        'L1 events (app interactions today)',
        '   ↓ Listener extracts named entities + decisions',
        'WikiAgent creates/updates memory nodes',
        '   ↓ Gardener checks for repeating patterns (3+ occurrences)',
        'Pattern crystallizes → L2 contextual entry',
        '',
        '// L2 → L3 distillation (weekly)',
        'L2 contexts that persist 14+ days with high confidence',
        '   ↓ Gardener synthesizes narrative node',
        'L3 narrative updated (requires user confirmation for major changes)',
      ]),
      p(''),
      h3('Gardener: Active Knowledge Maintenance'),
      p('The Gardener runs daily via DUYA\'s existing Automation Scheduler. It performs six checks:'),
      bullet([bold('Orphan detection: '), t('nodes with no inbound links → attempt keyword-based relinking')]),
      bullet([bold('Duplicate detection: '), t('semantic similarity scan → flag or auto-merge')]),
      bullet([bold('Staleness check: '), t('nodes not updated in 30d with confidence < 0.5 → trigger Deep Research')]),
      bullet([bold('Cross-domain synthesis: '), t('two clusters gaining new links → generate Synthesis node')]),
      bullet([bold('Confidence decay: '), t('conversation-sourced findings decay over time; document-sourced findings do not')]),
      bullet([bold('Weak link supplement: '), t('shared keywords without explicit link → add weak link')]),

      p(''),
      h2('5.4 Proactivity Levels'),
      p('Every agent action is assigned an intrusiveness level before execution. Conductor enforces this classification.'),
      p(''),
      simpleTable(
        ['Level', 'Name', 'Delivery Method', 'Examples'],
        [
          ['0', 'Silent Execution', 'No notification. User discovers on next open.', 'Tag a paper, reorganize note structure, update word priority queue'],
          ['1', 'Soft Card', 'A non-blocking card appears inside the relevant app when user next opens it.', '"I prepared 3 related papers. Want to see them?"'],
          ['2', 'Conversational Mention', 'Main Agent mentions it naturally in the next conversation turn.', '"By the way, your vocab app has 14 words going stale before your exam."'],
          ['3', 'Confirmation Required', 'Must wait for explicit user approval.', 'Delete data, reschedule calendar events, send external messages'],
        ],
        [600, 1500, 2500, 4760]
      ),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 6. APP DESIGN
      // ═══════════════════════════════════════════════════════════════════
      h1('6. App Design: The Marketplace Unit'),

      h2('6.1 What an App Is'),
      p('A DUYA app is not a standalone application. It is a structured package that extends the agent team with a new domain of expertise and a new user interface.'),

      h2('6.2 App Package Structure'),
      ...codeBlock([
        'interface DuyaApp {',
        '  manifest:     AppManifest      // identity, version, semantic domain',
        '  agentProfile: AppAgentProfile  // system prompt + tools + decision rules',
        '  dataSchema:   AppDataSchema    // SQLite table definitions for this app',
        '  uiBundle:     AppUIBundle      // React component tree, lazy-loaded',
        '}',
        '',
        'interface AppManifest {',
        '  id:                  string    // e.g. "literature-manager"',
        '  name:                string',
        '  version:             string',
        '  semanticDomain:      string[]  // ["academic", "research", "citation"]',
        '  announcementInterest:string[]  // which domains trigger this agent',
        '  dormantCapabilities: string[]  // what can be done without user present',
        '}',
        '',
        'interface AppAgentProfile {',
        '  systemPrompt:    string         // this agent\'s expertise and personality',
        '  allowedTools:    string[]       // "file:*", "search:*", "wiki:read", ...',
        '  decisionRules:   DecisionRule[] // local rules: no LLM needed',
        '  memoryScope:     "app-local" | "shared-L2" | "shared-L3"',
        '}',
        '',
        'interface DecisionRule {',
        '  // "if announcement contains domain X, set priority Y, propose action Z"',
        '  matchDomains:    string[]',
        '  priority:        number',
        '  proposedAction:  string',
        '  intrusiveness:   0 | 1 | 2 | 3',
        '}',
      ]),

      p(''),
      h2('6.3 The Agent Interface vs. The User Interface'),
      p('Every app has two views of the same data:'),
      p(''),
      simpleTable(
        ['Dimension', 'User Interface (UI)', 'Agent Interface (AI)'],
        [
          ['What it shows', 'Formatted, interactive, human-readable presentation', 'Structured semantic state: entities, events, priorities, gaps'],
          ['Who reads it', 'The human user', 'Conductor, WikiAgent, other App-Agents'],
          ['Update frequency', 'On user interaction', 'On every significant state change, regardless of user activity'],
          ['Example (Literature App)', 'Paper cards with title, authors, tags', '{ recentThemes: ["PINN", "extreme-precip"], unreadCount: 7, staleItems: 2, lastUserSession: "2026-05-23" }'],
        ],
        [2000, 3680, 3680]
      ),

      p(''),
      h2('6.4 App Installation Flow'),
      numbered('User downloads app package from DUYA Marketplace'),
      numbered('Main process validates manifest schema and security signature'),
      numbered('AppRegistry registers the agent profile'),
      numbered('App-Agent Process is spawned and enters dormant state'),
      numbered('SQLite schema is migrated to add the app\'s tables'),
      numbered('UI bundle is placed in the dynamic component registry'),
      numbered('Conductor reads the app\'s announcementInterest and updates its routing table'),
      numbered('WikiAgent indexes the app\'s semantic domain for knowledge graph integration'),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 7. ENGINEERING ARCHITECTURE
      // ═══════════════════════════════════════════════════════════════════
      h1('7. Engineering Architecture'),

      h2('7.1 Three-Process Model'),
      p('The existing DUYA architecture (AgentProcessPool for conversation agents, SQLite single-writer, MessagePort for Renderer communication) is extended with two new process tiers:'),
      p(''),
      ...codeBlock([
        '┌──────────────────────────────────────────────────────────────┐',
        '│                  Electron Main Process                        │',
        '│                                                               │',
        '│  SQLite (single writer)  │  EventBus (mitt, persistent)      │',
        '│  AgentProcessPool        │  AppRegistry                      │',
        '│  AutomationScheduler     │  ConductorBridge                  │',
        '└────┬──────────────────────────────────────┬──────────────────┘',
        '     │                                      │',
        '     │ child_process IPC                    │ child_process IPC',
        '     ▼                                      ▼',
        '┌──────────────────┐             ┌──────────────────────────┐',
        '│ Conversation     │             │ Conductor Process         │',
        '│ Agent Pool       │             │ (always-on, dedicated)   │',
        '│ (on-demand)      │             │                           │',
        '│ spawn per session│             │ Subscribes: chat:done    │',
        '│ Main Agent here  │             │ Publishes: announcements  │',
        '│ WikiAgent profile│             │ Arbitrates: responses     │',
        '└──────────────────┘             └──────────┬───────────────┘',
        '                                            │ EventBus',
        '                                ┌──────────▼───────────────┐',
        '                                │ App-Agent Pool            │',
        '                                │ (always-on, one per app)  │',
        '                                │ LiteratureAgent           │',
        '                                │ LanguageAgent             │',
        '                                │ CalendarAgent             │',
        '                                │ ...                       │',
        '                                └──────────────────────────┘',
      ]),

      p(''),
      h2('7.2 EventBus Design'),
      p('The EventBus is the central nervous system of the agent team. It is implemented inside Main Process (extending the existing mitt event bus) with persistence for replay.'),
      p(''),
      simpleTable(
        ['Event', 'Publisher', 'Subscribers', 'Payload'],
        [
          ['chat:done', 'AgentProcessPool', 'Conductor, WikiAgent', '{ sessionId, messages[] }'],
          ['announcement:publish', 'Conductor', 'All App-Agents (via AppRegistry routing)', 'Announcement object'],
          ['announcement:response', 'App-Agents', 'Conductor', 'AppAgentResponse object'],
          ['app:semantic:state', 'App-Agents', 'Conductor, WikiAgent', '{ appId, semanticState, timestamp }'],
          ['wiki:node:updated', 'WikiAgent', 'Conductor (for cross-app clustering)', '{ nodeId, type, keywords }'],
          ['user:model:patch', 'Conductor / WikiAgent', 'All App-Agents', '{ slice, data }'],
        ],
        [2200, 2000, 2400, 2760]
      ),

      p(''),
      h2('7.3 New IPC Message Types'),
      p('Extending the existing Main ↔ Agent Process IPC protocol:'),
      p(''),
      ...codeBlock([
        '// Main → App-Agent (new)',
        '"announcement:deliver"    // Conductor forwards announcement to specific agent',
        '"app:dormant:task"        // Schedule a task for dormant execution',
        '"user:model:slice"        // Deliver relevant portion of user model',
        '"app:config:update"       // Dynamic config change',
        '',
        '// App-Agent → Main (new)',
        '"announcement:response"   // App-Agent\'s proposal in response to announcement',
        '"app:semantic:state"      // Periodic semantic state upload',
        '"app:data:write"          // Request to write to app\'s SQLite tables',
        '"app:action:propose"      // Propose a level 2-3 action for arbitration',
        '',
        '// Main → Conductor (new)',
        '"chat:done:forward"       // Forward completed turn to Conductor',
        '"app:response:collected"  // All app responses received, trigger arbitration',
        '',
        '// Conductor → Main (new)',
        '"arbitration:result"      // Final decision: who does what',
      ]),

      p(''),
      h2('7.4 SQLite Schema Extensions'),
      p('The existing single-writer SQLite architecture is preserved. New tables are added for the agent OS layer:'),
      p(''),
      ...codeBlock([
        '-- App Registry',
        'CREATE TABLE app_registry (',
        '  app_id          TEXT PRIMARY KEY,',
        '  manifest_json   TEXT NOT NULL,',
        '  agent_profile   TEXT NOT NULL,',
        '  installed_at    INTEGER,',
        '  is_active       INTEGER DEFAULT 1',
        ');',
        '',
        '-- Announcement Log (for replay + analytics)',
        'CREATE TABLE conductor_announcements (',
        '  id              TEXT PRIMARY KEY,',
        '  trigger_type    TEXT,',
        '  semantic_summary TEXT,',
        '  intent_weight   REAL,',
        '  relevant_domains TEXT,  -- JSON array',
        '  created_at      INTEGER,',
        '  expires_at      INTEGER,',
        '  arbitration_result TEXT  -- JSON',
        ');',
        '',
        '-- App semantic state snapshots',
        'CREATE TABLE app_semantic_states (',
        '  app_id          TEXT,',
        '  snapshot_json   TEXT,',
        '  captured_at     INTEGER,',
        '  PRIMARY KEY (app_id, captured_at)',
        ');',
        '',
        '-- Per-app data tables (namespaced)',
        '-- Installed apps get tables prefixed with app_{app_id}_',
        '-- e.g. app_literature_papers, app_literature_tags',
        '-- Schema migrations managed by AppRegistry on install',
      ]),

      p(''),
      h2('7.5 AppRegistry'),
      p('AppRegistry is a new Main Process component responsible for the lifecycle of installed apps:'),
      bullet([bold('Registration: '), t('validates manifest, stores in SQLite, injects agent profile into App-Agent pool')]),
      bullet([bold('Routing table: '), t('maps announcementInterest domains to app IDs for Conductor\'s dispatch')]),
      bullet([bold('Schema management: '), t('runs SQLite migrations when apps are installed or updated')]),
      bullet([bold('Process management: '), t('spawns/kills App-Agent processes via App-Agent Pool')]),
      bullet([bold('User model distribution: '), t('delivers relevant user model slices to each app on startup and on user:model:patch events')]),

      p(''),
      h2('7.6 WikiAgent Integration Points'),
      p('WikiAgent (already designed as an AgentProfile) gains three new integration hooks:'),
      bullet([bold('App event subscription: '), t('subscribes to app:semantic:state events; extracts memory nodes from app activity, not just chat')]),
      bullet([bold('Conductor announcement awareness: '), t('subscribes to announcement:publish; logs intent events as memory/L2 contextual nodes')]),
      bullet([bold('Cross-app embedding: '), t('nightly job embeds all app semantic states and runs clustering; writes cross-app synthesis nodes when clusters converge')]),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 8. KNOWN PROBLEMS & MITIGATIONS
      // ═══════════════════════════════════════════════════════════════════
      h1('8. Known Problems & Mitigations'),
      p(''),
      simpleTable(
        ['Problem', 'Risk', 'Mitigation'],
        [
          ['App-Agent process count grows linearly with installed apps', 'Memory pressure with many apps installed', 'App-Agent Pool has a dormancy tier: inactive agents are suspended, state checkpointed; woken on relevant announcement'],
          ['Intent extraction false positives', 'Unnecessary announcements, noise, wasted LLM calls', 'intentWeight threshold tuned per user; announcements have TTL; Conductor learns from ignored proposals (reduce that agent\'s future weight)'],
          ['GraphManager concurrent writes (Gardener + Listener)', 'Corrupted _graph.json', 'AsyncLock write mutex already designed in wiki-agent.md; Gardener and Listener share one lock domain'],
          ['Announcement response window timing', 'Slow app-agents delay arbitration', 'Fixed 500ms response window; non-responding agents skipped; responses queued for next cycle'],
          ['User model privacy across apps', 'Oversharing sensitive personal data with app-agents', 'User model is sliced by relevance; each app only receives its declared memoryScope fields; L3 narrative delivered only to built-in agents'],
          ['Existing AgentProcessPool not designed for always-on agents', 'CPU/2 cap conflicts with App-Agent Pool', 'App-Agent Pool is a separate pool with its own resource governor; apps in dormant state consume near-zero resources'],
        ],
        [2200, 2400, 4760]
      ),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 9. BUILD ROADMAP
      // ═══════════════════════════════════════════════════════════════════
      h1('9. Phased Build Roadmap'),

      h2('Phase 0 — Foundation (prerequisite)'),
      p('No new user-visible features. Internal infrastructure only.'),
      bullet('Design and implement EventBus with persistence (extend existing mitt)'),
      bullet('Implement AppRegistry (manifest validation, routing table, SQLite schema migration)'),
      bullet('Define all new IPC message types; update agent-communicator.ts'),
      bullet('Separate App-Agent Pool from existing AgentProcessPool'),

      h2('Phase 1 — Conductor MVP'),
      bullet('Implement Conductor as a dedicated always-on process'),
      bullet('Intent extraction pipeline (Haiku, intentWeight scoring)'),
      bullet('Announcement publish/subscribe with fixed 500ms response window'),
      bullet('Basic arbitration (priority sort, first-N-wins)'),
      bullet('Proactivity level 0 and 1 only (silent execution + soft card)'),

      h2('Phase 2 — First App: Literature Manager'),
      bullet('Define AppManifest + AppAgentProfile schema'),
      bullet('Build Literature Manager app package (UI + agent profile + schema)'),
      bullet('Implement app:semantic:state emission'),
      bullet('Connect Literature Agent to Conductor announcement flow'),
      bullet('Dormancy tier: agent suspends when no announcements for 15 minutes'),

      h2('Phase 3 — WikiAgent Cross-App Extension'),
      bullet('Extend WikiAgent Listener to subscribe to app:semantic:state'),
      bullet('Implement nightly cross-app semantic clustering'),
      bullet('Synthesis node generation from cross-app clusters'),
      bullet('Surface insights via Conductor as level-1 soft cards'),

      h2('Phase 4 — User Model & Personalization'),
      bullet('Define structured user model schema'),
      bullet('Implement user model slice delivery to app-agents'),
      bullet('App-agent personalization on first open (warm start)'),
      bullet('Conductor learns user proactivity tolerance from interaction history'),

      h2('Phase 5 — Marketplace'),
      bullet('Define app package format and signing standard'),
      bullet('Build marketplace UI within DUYA'),
      bullet('Sandbox and security review for third-party agent profiles'),
      bullet('Install / update / uninstall lifecycle with schema migration'),

      pb(),

      // ═══════════════════════════════════════════════════════════════════
      // 10. CLOSING
      // ═══════════════════════════════════════════════════════════════════
      h1('10. Closing: What This Is, Really'),

      p('The internet gave us information. The smartphone gave us connectivity. Social media gave us expression. AI tools gave us capability.'),
      p(''),
      p([
        t('None of them gave us '),
        bold('coherence'),
        t('. None of them made our digital life feel like it belongs to us, like it knows us, like it is working '),
        bold('for'),
        t(' us rather than demanding our attention.')
      ]),
      p(''),
      p('DUYA is the first serious attempt to build a computing environment whose fundamental organizing principle is the user — not the app, not the platform, not the algorithm.'),
      p(''),
      p('Every design decision in this document flows from one question: does this put the user more in control of their own cognitive life, or less? That question is the north star.'),
      p(''),
      p('The agent team is not the product. The knowledge graph is not the product. The app marketplace is not the product.'),
      p(''),
      ...callout('The product', 'is the feeling of being genuinely looked after by your own technology — for the first time.', C.accentBg, C.midBlue),
      p(''),
      p(''),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 480, after: 0 },
        children: [new TextRun({ text: '— End of Document —', color: C.gray500, italics: true, size: 20 })],
        border: { top: border(C.gray300, 4) }
      }),

    ]
  }]
});

const path = require('path');
const outputDir = process.platform === 'win32'
  ? 'E:\\Users\\lavachen\\Downloads'
  : '/mnt/user-data/outputs';
const outputPath = path.join(outputDir, 'DUYA-AgentOS-Design.docx');

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(outputPath, buf);
  console.log('Done:', outputPath);
});
