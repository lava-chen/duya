# uia-probe.ps1 — persistent UIA point-probe service (plan 556 phase 2).
#
# Runs as a single PowerShell 5.1 child process (spawned by the recorder process daemon). Line protocol on stdin/stdout; the
# shapes are defined in the recorder uia-probe protocol:
#
#   → {"id":1,"op":"probe","x":123,"y":456}
#   ← {"id":1,"ok":true,"element":{"name":"..","controlType":"Button",
#        "automationId":"..","className":"..","rect":{"x":..,"y":..,"w":..,"h":..},
#        "isPassword":false}}
#      {"id":1,"ok":true,"element":null}          — UIA answered, nothing there
#      {"id":1,"ok":false,"reason":"timeout"}     — internal 200ms budget blown
#   → {"id":2,"op":"readUrl","hwnd":197144}
#      {"id":2,"ok":true,"url":"https://..."}     — address bar value (zh/en match,
#                                                    first-Edit fallback)
#   → {"id":3,"op":"ping"}  →  {"id":3,"ok":true}
#   → {"id":4,"op":"enumerate","hwnd":197144,     — plan 562 full-tree enumeration
#        "maxDepth":40,"maxNodes":1500,             (knobs optional; controlTypes
#        "controlTypes":["Button",...],             overrides the built-in whitelist;
#        "totalMs":8000}                            per-request walk budget — cold
#                                                   windows get a raised one)
#      {"id":4,"ok":true,"elements":[{"name":"..","controlType":"Button",...,
#         "rect":{...},"isPassword":false,"interactive":true,
#         "enabled":true,"focused":false[,"selected":true]
#         [,"label":".."][,"checked":true][,"description":".."]
#         [,"offscreen":true],"depth":2},...],
#         "truncated":false,"reason":null,"count":12}
#      {"id":4,"ok":true,"elements":[...],"truncated":true,...}  — partial tree kept
#                                                          after a budget hit OR a
#                                                          hang-net salvage
#      {"id":4,"ok":true,"elements":[],"reason":"elevated",...} — UIPI skip, no
#                                                                  budget burned
#
#   plan 576 walk semantics: the per-root-child shard is a recursive
#   ControlView TreeWalker walk (not a flat FindAll), so every emitted
#   node carries its REAL tree `depth`. Static Text nodes never occupy
#   emission slots (
#   plan 576 red line) — their text rides as a `label` on the next
#   emitted element (forward attachment, capped). `maxNodes` budgets
#   VISITED nodes (Text/containers included, so a virtualized list cannot
#   flood the walk); offscreen subtrees are emitted as flagged leaves and
#   NOT descended into, which keeps the budget on on-screen content.
# The first stdout line is {"ready":true} once Add-Type finished — the
# main-side client gates ensureStarted() on it. All UIA work (which can
# block on hung/elevated targets) runs inside a .NET Task with a Wait
# timeout in the C# helper, so the stdin loop stays responsive even when
# a probe stalls; the main side additionally races every request.

$ErrorActionPreference = 'Continue'
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }
# stdin is a redirected pipe; decode explicitly as UTF-8 so element names
# and other non-ASCII request values are preserved.
try {
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
} catch { }
$stdinReader = $null
try {
    $stdinReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)
} catch { }

# C# 5 (the PowerShell 5.1 compiler): no string interpolation, no ?. —
# plain delegates and string.Concat only. The Task timeout covers BOTH
# FromPoint and the property reads, which all cross process boundaries
# and can hang against a dead/elevated target window.
$probeCs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Automation;

namespace Duya.Recorder
{
    public static class UiaProbe
    {
        private static string Escape(string s)
        {
            if (s == null) { return "null"; }
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"') { sb.Append("\\\""); }
                else if (c == '\\') { sb.Append("\\\\"); }
                else if (c == '\b') { sb.Append("\\b"); }
                else if (c == '\f') { sb.Append("\\f"); }
                else if (c == '\n') { sb.Append("\\n"); }
                else if (c == '\r') { sb.Append("\\r"); }
                else if (c == '\t') { sb.Append("\\t"); }
                else if (c < 0x20) { sb.Append("\\u"); sb.Append(((int)c).ToString("x4")); }
                else { sb.Append(c); }
            }
            sb.Append("\"");
            return sb.ToString();
        }

        private static string ElementJson(AutomationElement el)
        {
            if (el == null) { return "null"; }
            AutomationElement.AutomationElementInformation c = el.Current;
            Rect r = c.BoundingRectangle;
            string rect;
            if (r.IsEmpty)
            {
                rect = "null";
            }
            else
            {
                rect = "{\"x\":" + ((int)r.X) + ",\"y\":" + ((int)r.Y)
                     + ",\"w\":" + ((int)r.Width) + ",\"h\":" + ((int)r.Height) + "}";
            }
            string controlType = null;
            if (c.ControlType != null) { controlType = c.ControlType.ProgrammaticName; }
            if (controlType != null) { controlType = controlType.Replace("ControlType.", ""); }
            // Text-bearing controls carry their current value (plan 564) —
            // the LLM-facing tree listing needs it to pick fields. Never
            // emitted for password fields; the key is omitted (not null)
            // when unsupported so downstream strict readers stay happy.
            // plan 576: the value is wire-capped (Documents can carry the
            // whole page text) — the renderers apply their own display
            // truncation on top.
            string valueJson = null;
            if (!c.IsPassword
                && (c.ControlType == ControlType.Edit
                    || c.ControlType == ControlType.Document
                    || c.ControlType == ControlType.ComboBox))
            {
                try
                {
                    object p;
                    if (el.TryGetCurrentPattern(ValuePattern.Pattern, out p))
                    {
                        ValuePattern vp = p as ValuePattern;
                        if (vp != null && !string.IsNullOrEmpty(vp.Current.Value))
                        {
                            valueJson = Escape(TruncateValue(vp.Current.Value));
                        }
                    }
                }
                catch { }
            }
            return "{\"name\":" + Escape(c.Name)
                 + ",\"controlType\":" + Escape(controlType)
                 + ",\"automationId\":" + Escape(c.AutomationId)
                 + ",\"className\":" + Escape(c.ClassName)
                 + ",\"rect\":" + rect
                 + ",\"isPassword\":" + (c.IsPassword ? "true" : "false")
                 + (valueJson == null ? "" : ",\"value\":" + valueJson)
                 + "}";
        }

        // plan 576 wire cap for pattern values (Document/Edit text). Large
        // enough for field values and code snippets, small enough that one
        // oversized document cannot dominate the observation.
        private const int MaxValueChars = 400;

        private static string TruncateValue(string s)
        {
            if (s == null || s.Length <= MaxValueChars) { return s; }
            return s.Substring(0, MaxValueChars);
        }

        // Enumerate nodes carry the interactive assertion the overlay's
        // renderer-side defense re-checks (plan 562 phase 3), plus the
        // real UIA state bits the CUA tree contract needs (plan 575 gap
        // fix): IsEnabled / HasKeyboardFocus are plain property reads off
        // the already-fetched info struct; IsSelected costs one pattern
        // availability query and is emitted only when the element actually
        // carries SelectionItemPattern (the key is omitted otherwise, so
        // strict downstream readers stay happy — same convention as the
        // conditional "value" key in ElementJson).
        private static string InteractiveElementJson(AutomationElement el, AutomationElement.AutomationElementInformation c)
        {
            string baseJson = ElementJson(el);
            if (baseJson == "null") { return null; }
            bool enabled = true;
            try { enabled = c.IsEnabled; } catch { }
            bool focused = false;
            try { focused = c.HasKeyboardFocus; } catch { }
            string selectedJson = "";
            try
            {
                object p;
                if (el.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p))
                {
                    SelectionItemPattern sp = p as SelectionItemPattern;
                    if (sp != null)
                    {
                        selectedJson = ",\"selected\":" + (sp.Current.IsSelected ? "true" : "false");
                    }
                }
            }
            catch { }
            return baseJson.Substring(0, baseJson.Length - 1)
                 + ",\"interactive\":true"
                 + ",\"enabled\":" + (enabled ? "true" : "false")
                 + ",\"focused\":" + (focused ? "true" : "false")
                 + selectedJson
                 + "}";
        }

        // Returns the element JSON string, the literal "null" when UIA
        // answered but there is no element, or null when the internal
        // budget timed out (caller maps that to ok:false/timeout).
        public static string ProbePoint(double x, double y, int timeoutMs)
        {
            Func<string> work = delegate
            {
                try
                {
                    AutomationElement el = AutomationElement.FromPoint(new Point(x, y));
                    return ElementJson(el);
                }
                catch { return "null"; }
            };
            Task<string> task = Task.Run(work);
            return task.Wait(timeoutMs) ? task.Result : null;
        }

        private static int ScoreCandidate(string automationId, string name)
        {
            int score = 0;
            if (!string.IsNullOrEmpty(automationId))
            {
                string id = automationId.ToLowerInvariant();
                if (id == "addressfield" || id == "urlbar-input" || id == "urlbar" || id == "urlfield")
                {
                    score = 40;
                }
            }
            if (score == 0 && !string.IsNullOrEmpty(name))
            {
                string n = name.ToLowerInvariant();
                if (n.Contains("地址和搜索") || n.Contains("地址栏") || n.Contains("搜索或输入")
                    || n.Contains("address and search") || n.Contains("search or type a url")
                    || n.Contains("search or enter"))
                {
                    score = 30;
                }
            }
            return score;
        }

        private static string ReadValue(AutomationElement el)
        {
            try
            {
                ValuePattern pattern = el.GetCurrentPattern(ValuePattern.Pattern) as ValuePattern;
                if (pattern != null) { return pattern.Current.Value; }
            }
            catch { }
            return null;
        }

        // Returns the escaped URL JSON string (quote included), or null
        // when the address bar could not be resolved within the budget.
        public static string ReadUrl(IntPtr hwnd, int timeoutMs)
        {
            Func<string> work = delegate
            {
                try
                {
                    AutomationElement root = AutomationElement.FromHandle(hwnd);
                    if (root == null) { return null; }
                    PropertyCondition editCondition = new PropertyCondition(
                        AutomationElement.ControlTypeProperty, ControlType.Edit);
                    AutomationElementCollection edits = root.FindAll(TreeScope.Descendants, editCondition);
                    if (edits == null || edits.Count == 0) { return null; }

                    AutomationElement best = null;
                    int bestScore = 0;
                    for (int i = 0; i < edits.Count; i++)
                    {
                        AutomationElement el = edits[i];
                        if (el == null) { continue; }
                        int score = ScoreCandidate(el.Current.AutomationId, el.Current.Name);
                        if (score > bestScore)
                        {
                            bestScore = score;
                            best = el;
                        }
                        if (bestScore >= 40) { break; }
                    }
                    if (best == null) { best = edits[0]; }
                    if (best == null) { return null; }
                    string value = ReadValue(best);
                    if (value == null) { value = best.Current.Name; }
                    if (string.IsNullOrEmpty(value)) { return null; }
                    return Escape(value);
                }
                catch { return null; }
            };
            Task<string> task = Task.Run(work);
            return task.Wait(timeoutMs) ? task.Result : null;
        }

        // ------------------------------------------------------------------
        // Foreground snapshot (plan 562 phase 5). The focus tracker used to
        // spawn a fresh powershell.exe plus an Add-Type compile for every
        // 500ms poll; the real cadence measured at ~3.4s and short-lived
        // foreground states (e.g. a quick explorer visit) were swallowed.
        // Serving `fg` from THIS persistent process removes the per-poll
        // spawn and compile entirely.
        // ------------------------------------------------------------------

        public static string ForegroundHandle()
        {
            IntPtr h = GetForegroundWindow();
            if (h == IntPtr.Zero) { return null; }
            int pid = 0;
            GetWindowThreadProcessId(h, out pid);
            // Read the title straight off the foreground hwnd. The
            // alternative (Get-Process MainWindowTitle) returns the
            // process-designated main window, which for single-process
            // multi-window apps (chrome.exe) is NOT the foreground
            // window — real sessions recorded empty titles throughout.
            var sb = new System.Text.StringBuilder(512);
            int n = GetWindowText(h, sb, sb.Capacity);
            if (n < 0) { n = 0; }
            return h.ToInt64() + "\t" + pid.ToString() + "\t" + sb.ToString(0, n);
        }

        // ------------------------------------------------------------------
        // Full-tree enumeration (plan 562 phase 1).
        // ------------------------------------------------------------------

        private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        private const uint TOKEN_QUERY = 0x0008;
        private const int TokenElevation = 20;

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out int processId);

        [DllImport("user32.dll")]
        private static extern IntPtr GetForegroundWindow();

        // CharSet.Unicode binds GetWindowTextW — real Unicode titles
        // (Chinese portal pages) instead of the ANSI lossy variant.
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

        [DllImport("kernel32.dll")]
        private static extern IntPtr GetCurrentProcess();

        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

        // TokenElevation returns a DWORD; marshaling it as a 4-byte int works.
        [DllImport("advapi32.dll", SetLastError = true)]
        private static extern bool GetTokenInformation(IntPtr token, int infoClass, out int info, int length, out int returnLength);

        [DllImport("kernel32.dll")]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        private static bool IsProcessElevated(int pid)
        {
            if (pid <= 0) { return false; }
            IntPtr proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (proc == IntPtr.Zero)
            {
                // Cannot even query the process: protected — treat as skip.
                return true;
            }
            bool elevated = false;
            IntPtr token;
            if (OpenProcessToken(proc, TOKEN_QUERY, out token))
            {
                int info;
                int returnLength;
                if (GetTokenInformation(token, TokenElevation, out info, 4, out returnLength))
                {
                    elevated = info != 0;
                }
                CloseHandle(token);
            }
            CloseHandle(proc);
            return elevated;
        }

        private static bool IsSelfElevated()
        {
            bool elevated = false;
            IntPtr token;
            if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token))
            {
                int info;
                int returnLength;
                if (GetTokenInformation(token, TokenElevation, out info, 4, out returnLength))
                {
                    elevated = info != 0;
                }
                CloseHandle(token);
            }
            return elevated;
        }

        // Shared walk state. Nodes is guarded by Gate because each root
        // child subtree runs in its own abandoned-able task shard.
        private class EnumState
        {
            public readonly List<string> Nodes = new List<string>();
            public readonly object Gate = new object();
            public readonly HashSet<string> ControlTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public Stopwatch Clock;
            public int TotalMs;
            // plan 576: MaxNodes budgets VISITED nodes (every node the
            // walk steps over — Text and containers included) so a
            // virtualized list cannot flood the walk with placeholder
            // rows. Only whitelisted-vocabulary nodes occupy emission
            // slots, so Nodes.Count <= Visited.
            public int MaxNodes;
            public int MaxDepth;
            public bool Truncated;
            public int Visited;
            // plan 576 + 578 interplay: a MINIMIZED window reports every
            // element IsOffscreen=true (iconic position). Offscreen descent
            // pruning is a budget guard for VISIBLE windows — on a
            // minimized one it would collapse the whole tree to zero, so
            // the caller disables pruning there ("a minimized tree is
            // fully usable", plan 578).
            public bool PruneOffscreen;

            public int NodeCount
            {
                get { lock (Gate) { return Nodes.Count; } }
            }

            public bool BudgetBlown
            {
                get { return Visited >= MaxNodes || Clock.ElapsedMilliseconds >= TotalMs; }
            }

            public void Add(string json)
            {
                lock (Gate) { Nodes.Add(json); }
            }
        }

        // Bulk-cache request for the enumerate walk (plan 562 perf fix).
        // Elements obtained while this request is active carry every read
        // property client-side, so a whole subtree arrives in ONE
        // cross-process call instead of one call per node per property —
        // the single biggest enumerate cost on Chromium-sized trees.
        private static CacheRequest NewCacheRequest(TreeScope scope)
        {
            CacheRequest cr = new CacheRequest();
            cr.TreeScope = scope;
            cr.TreeFilter = Automation.ControlViewCondition;
            cr.Add(AutomationElement.NameProperty);
            cr.Add(AutomationElement.AutomationIdProperty);
            cr.Add(AutomationElement.ControlTypeProperty);
            cr.Add(AutomationElement.BoundingRectangleProperty);
            cr.Add(AutomationElement.IsOffscreenProperty);
            cr.Add(AutomationElement.IsPasswordProperty);
            cr.Add(AutomationElement.ClassNameProperty);
            cr.Add(AutomationElement.IsEnabledProperty);
            cr.Add(AutomationElement.HasKeyboardFocusProperty);
            cr.Add(AutomationElement.HelpTextProperty);
            cr.Add(ValuePattern.Pattern);
            cr.Add(SelectionItemPattern.Pattern);
            cr.Add(TogglePattern.Pattern);
            return cr;
        }

        // Interactive whitelist check + JSON emission for one element in
        // CURRENT form (used for the window root, which is fetched outside
        // any active cache request). IsOffscreen elements are skipped (UFO
        // inspector's default filter): they are invisible to the user,
        // cannot be click targets, and virtualized lists would otherwise
        // flood the tree with placeholder rows.
        private static bool TryMakeNode(EnumState st, AutomationElement el, out string json)
        {
            json = null;
            try
            {
                AutomationElement.AutomationElementInformation c = el.Current;
                if (c.IsOffscreen) { return false; }
                if (c.ControlType == null) { return false; }
                string controlType = c.ControlType.ProgrammaticName;
                if (controlType == null) { return false; }
                controlType = controlType.Replace("ControlType.", "");
                if (!st.ControlTypes.Contains(controlType)) { return false; }
                json = InteractiveElementJson(el, c);
                return json != null;
            }
            catch { return false; }
        }

        // Cached-form sibling of ElementJson: identical wire shape, but
        // every read hits the client-side cache (el.Current would throw
        // on a cached-form element). Values are wire-capped.
        private static string CachedElementJson(AutomationElement el)
        {
            AutomationElement.AutomationElementInformation c = el.Cached;
            Rect r = c.BoundingRectangle;
            string rect;
            if (r.IsEmpty)
            {
                rect = "null";
            }
            else
            {
                rect = "{\"x\":" + ((int)r.X) + ",\"y\":" + ((int)r.Y)
                     + ",\"w\":" + ((int)r.Width) + ",\"h\":" + ((int)r.Height) + "}";
            }
            string controlType = null;
            if (c.ControlType != null) { controlType = c.ControlType.ProgrammaticName; }
            if (controlType != null) { controlType = controlType.Replace("ControlType.", ""); }
            string valueJson = null;
            if (!c.IsPassword
                && (c.ControlType == ControlType.Edit
                    || c.ControlType == ControlType.Document
                    || c.ControlType == ControlType.ComboBox))
            {
                try
                {
                    ValuePattern vp = el.GetCachedPattern(ValuePattern.Pattern) as ValuePattern;
                    if (vp != null && !string.IsNullOrEmpty(vp.Cached.Value))
                    {
                        valueJson = Escape(TruncateValue(vp.Cached.Value));
                    }
                }
                catch { }
            }
            return "{\"name\":" + Escape(c.Name)
                 + ",\"controlType\":" + Escape(controlType)
                 + ",\"automationId\":" + Escape(c.AutomationId)
                 + ",\"className\":" + Escape(c.ClassName)
                 + ",\"rect\":" + rect
                 + ",\"isPassword\":" + (c.IsPassword ? "true" : "false")
                 + (valueJson == null ? "" : ",\"value\":" + valueJson)
                 + "}";
        }

        // plan 576 label-attachment caps: a pending text run rides the
        // walk until the next emitted element absorbs it as `label`.
        // The caps bound how far a run can travel and how big one label
        // can get, so a stray paragraph cannot dominate a row.
        private const int MaxLabelParts = 8;
        private const int MaxLabelChars = 200;

        private static string JoinPendingTexts(List<string> pending)
        {
            if (pending == null || pending.Count == 0) { return null; }
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < pending.Count && i < MaxLabelParts; i++)
            {
                string part = pending[i];
                if (string.IsNullOrEmpty(part)) { continue; }
                if (sb.Length > 0) { sb.Append(' '); }
                sb.Append(part);
                if (sb.Length >= MaxLabelChars) { break; }
            }
            string joined = sb.ToString();
            if (joined.Length > MaxLabelChars) { joined = joined.Substring(0, MaxLabelChars); }
            return joined.Length > 0 ? joined : null;
        }

        // Cached-form record for one emitted walk node: the base element
        // JSON plus the plan 576 tree-contract fields. Conditional keys
        // are omitted (not null) so strict downstream readers stay happy:
        //   label       — pending static-Text run absorbed by this node
        //   checked     — TogglePattern state (only when the pattern exists)
        //   description — non-empty HelpText
        //   offscreen   — only when true; the walk does NOT descend into
        //                 offscreen subtrees (budget protection)
        //   depth       — REAL UIA tree depth relative to the window root
        private static string CachedNodeJson(
            AutomationElement el,
            AutomationElement.AutomationElementInformation c,
            int depth,
            string label)
        {
            string baseJson = CachedElementJson(el);
            if (baseJson == "null") { return null; }
            bool enabled = true;
            try { enabled = c.IsEnabled; } catch { }
            bool focused = false;
            try { focused = c.HasKeyboardFocus; } catch { }
            string selectedJson = "";
            try
            {
                SelectionItemPattern sp = el.GetCachedPattern(SelectionItemPattern.Pattern) as SelectionItemPattern;
                if (sp != null)
                {
                    selectedJson = ",\"selected\":" + (sp.Cached.IsSelected ? "true" : "false");
                }
            }
            catch { }
            string checkedJson = "";
            try
            {
                TogglePattern tp = el.GetCachedPattern(TogglePattern.Pattern) as TogglePattern;
                if (tp != null)
                {
                    checkedJson = ",\"checked\":" + (tp.Cached.ToggleState == ToggleState.On ? "true" : "false");
                }
            }
            catch { }
            string descriptionJson = "";
            try
            {
                if (!string.IsNullOrEmpty(c.HelpText))
                {
                    descriptionJson = ",\"description\":" + Escape(TruncateValue(c.HelpText));
                }
            }
            catch { }
            bool offscreen = false;
            try { offscreen = c.IsOffscreen; } catch { }
            string labelJson = string.IsNullOrEmpty(label) ? "" : ",\"label\":" + Escape(label);
            return baseJson.Substring(0, baseJson.Length - 1)
                 + labelJson
                 + ",\"interactive\":true"
                 + ",\"enabled\":" + (enabled ? "true" : "false")
                 + ",\"focused\":" + (focused ? "true" : "false")
                 + selectedJson
                 + checkedJson
                 + descriptionJson
                 + (offscreen ? ",\"offscreen\":true" : "")
                 + ",\"depth\":" + depth
                 + "}";
        }

        // plan 576 walk: the managed System.Windows.Automation TreeWalker
        // does NOT apply the ambient CacheRequest to navigation results —
        // GetFirstChild/GetNextSibling return CURRENT-form elements and
        // every .Cached read on them throws ("cannot request an uncached
        // property"). The reliable cached fetch is FindAll (the 562 perf
        // fix), so the walk is a two-phase hybrid:
        //   1. BFS collect — per node ONE FindAll(Children) call returns
        //      its children as CACHED elements; nodes go into an in-memory
        //      wrapper tree with their depth (budget: one COM call per
        //      visited node, identical to a TreeWalker walk).
        //   2. DFS emit — the wrapper tree is walked depth-first in
        //      document order; every property read is a client-side cache
        //      hit, so emission never crosses process.
        private class WalkNodeRec
        {
            public AutomationElement El;
            public readonly List<WalkNodeRec> Children = new List<WalkNodeRec>();
        }

        // Phase 1: BFS collect. Every stepped node — Text or container
        // alike — counts against MaxNodes (a virtualized list cannot flood
        // the walk). Offscreen nodes stay in the tree (emitted as flagged
        // leaves) but are NOT expanded, keeping the budget on on-screen
        // content.
        private static void CollectLevels(EnumState st, Queue<KeyValuePair<WalkNodeRec, int>> queue)
        {
            while (queue.Count > 0)
            {
                KeyValuePair<WalkNodeRec, int> pair = queue.Dequeue();
                WalkNodeRec rec = pair.Key;
                int depth = pair.Value;
                st.Visited++;
                if (st.BudgetBlown)
                {
                    st.Truncated = true;
                    return;
                }
                if (depth >= st.MaxDepth)
                {
                    continue;
                }
                bool offscreen = false;
                try { offscreen = rec.El.Cached.IsOffscreen; }
                catch { continue; }
                if (offscreen && st.PruneOffscreen)
                {
                    continue;
                }
                try
                {
                    AutomationElementCollection kids = rec.El.FindAll(TreeScope.Children, Automation.ControlViewCondition);
                    if (kids != null)
                    {
                        for (int i = 0; i < kids.Count; i++)
                        {
                            WalkNodeRec child = new WalkNodeRec();
                            child.El = kids[i];
                            rec.Children.Add(child);
                            queue.Enqueue(new KeyValuePair<WalkNodeRec, int>(child, depth + 1));
                        }
                    }
                }
                catch { }
            }
        }

        // Phase 2: DFS emit over the collected wrapper tree. Static Text
        // nodes NEVER occupy emission slots (plan 576 red line — the
        // emitted-node list stays limited to interactive controls); their text
        // is absorbed as `label` on the next emitted element (forward
        // attachment, capped). The run rides through anonymous containers,
        // which is the point: labels and their fields usually sit in
        // different nesting levels.
        private static void EmitDfs(EnumState st, WalkNodeRec rec, int depth, List<string> pendingTexts)
        {
            if (rec == null || rec.El == null) { return; }
            AutomationElement.AutomationElementInformation c;
            string controlType;
            try
            {
                c = rec.El.Cached;
                if (c.ControlType == null) { return; }
                controlType = c.ControlType.ProgrammaticName;
                if (controlType == null) { return; }
                controlType = controlType.Replace("ControlType.", "");
            }
            catch { return; }

            if (string.Equals(controlType, "Text", StringComparison.OrdinalIgnoreCase))
            {
                string text = null;
                try { text = c.Name; } catch { }
                if (!string.IsNullOrEmpty(text))
                {
                    text = text.Trim();
                    if (text.Length > 0 && pendingTexts.Count < MaxLabelParts * 4)
                    {
                        pendingTexts.Add(text);
                    }
                }
                return;
            }

            bool offscreen = false;
            try { offscreen = c.IsOffscreen; } catch { }

            if (st.ControlTypes.Contains(controlType))
            {
                string label = JoinPendingTexts(pendingTexts);
                pendingTexts.Clear();
                string json = CachedNodeJson(rec.El, c, depth, label);
                if (json != null)
                {
                    st.Add(json);
                }
            }

            if (offscreen || depth >= st.MaxDepth)
            {
                return;
            }
            for (int i = 0; i < rec.Children.Count; i++)
            {
                EmitDfs(st, rec.Children[i], depth + 1, pendingTexts);
            }
        }

        // Serialize whatever the walk collected so far. Shared by the
        // success path and the hang-net salvage path below, so a walk
        // that got wedged mid-shard still returns the partial tree
        // instead of dropping every node it already landed.
        private static string SerializeState(EnumState st)
        {
            string elements;
            int count;
            lock (st.Gate)
            {
                count = st.Nodes.Count;
                elements = count > 0 ? "[" + string.Join(",", st.Nodes.ToArray()) + "]" : "[]";
            }
            return "{\"elements\":" + elements
                 + ",\"truncated\":" + (st.Truncated ? "true" : "false")
                 + ",\"reason\":null"
                 + ",\"count\":" + count + "}";
        }

        // Returns a complete JSON object
        // {"elements":[...],"truncated":bool,"reason":str|null,"count":n}
        // for the PS dispatcher to splice (it strips the outer braces),
        // or null when the whole operation failed (caller maps to
        // ok:false/timeout). A walk that blows its budget returns the
        // PARTIAL tree with truncated:true.
        // The outer Wait is the hang net for a single stuck UIA call; the
        // internal clock is what normally ends the walk with a partial
        // tree + truncated:true (plan 562 phase 1).
        public static string EnumerateWindow(
            IntPtr hwnd,
            int totalTimeoutMs,
            int subtreeTimeoutMs,
            int maxNodes,
            int maxDepth,
            string[] controlTypes)
        {
            EnumState st = new EnumState();
            if (controlTypes != null)
            {
                for (int i = 0; i < controlTypes.Length; i++)
                {
                    if (!string.IsNullOrEmpty(controlTypes[i]))
                    {
                        st.ControlTypes.Add(controlTypes[i].Trim());
                    }
                }
            }
            st.Clock = Stopwatch.StartNew();
            st.TotalMs = totalTimeoutMs;
            st.MaxNodes = maxNodes;
            st.MaxDepth = maxDepth;
            // A minimized window reports its whole subtree offscreen —
            // pruning descent there would return an empty tree and break
            // plan 578's "a minimized tree is fully usable" contract.
            st.PruneOffscreen = !IsIconic(hwnd);

            Func<string> work = delegate
            {
                try
                {
                    // UIPI short-circuit: an elevated target is unreadable
                    // from a non-elevated caller — skip before burning any
                    // UIA budget (plan 562 §4).
                    int pid;
                    GetWindowThreadProcessId(hwnd, out pid);
                    if (pid > 0 && IsProcessElevated(pid) && !IsSelfElevated())
                    {
                        return "{\"elements\":[],\"truncated\":false,\"reason\":\"elevated\",\"count\":0}";
                    }

                    AutomationElement root = null;
                    try { root = AutomationElement.FromHandle(hwnd); } catch
                    {
                        // Dead handle (window closed): FromHandle THROWS
                        // ElementNotAvailableException instead of returning
                        // null — report it honestly either way.
                        return "{\"elements\":[],\"truncated\":false,\"reason\":\"no-window\",\"count\":0}";
                    }
                    if (root == null)
                    {
                        return "{\"elements\":[],\"truncated\":false,\"reason\":\"no-window\",\"count\":0}";
                    }

                    // The root itself is rarely interactive (Window), but a
                    // custom whitelist may include it — check it inline.
                    string rootJson;
                    if (TryMakeNode(st, root, out rootJson))
                    {
                        st.Visited++;
                        st.Add(rootJson);
                        if (st.BudgetBlown) { st.Truncated = true; }
                    }

                    // Root children in one cross-process call, then each
                    // child subtree walked in its own shard with an
                    // independent time slice: one hung subtree cannot eat
                    // the whole budget. Abandoned shards keep running and
                    // are simply never merged — partial tree is the answer.
                    // Each shard runs the plan 576 recursive ControlView
                    // TreeWalker walk inside an active cache request: one
                    // navigation call per node, every property read a
                    // client-side cache hit, real tree depth on every
                    // emitted node.
                    List<Task> shards = new List<Task>();
                    List<AutomationElement> shardRoots = new List<AutomationElement>();
                    try
                    {
                        using (NewCacheRequest(TreeScope.Element).Activate())
                        {
                            AutomationElementCollection kids = root.FindAll(TreeScope.Children, Automation.ControlViewCondition);
                            if (kids != null)
                            {
                                for (int i = 0; i < kids.Count; i++) { shardRoots.Add(kids[i]); }
                            }
                        }
                    }
                    catch (Exception shardRootsErr)
                    {
                        try { System.Console.Error.WriteLine("[uia-probe][walk] shard-roots-fetch-throw " + shardRootsErr.GetType().Name + ": " + shardRootsErr.Message); } catch { }
                    }
                    foreach (AutomationElement sub in shardRoots)
                    {
                        shards.Add(Task.Run((Action)(delegate
                        {
                            try
                            {
                                using (NewCacheRequest(TreeScope.Element).Activate())
                                {
                                    WalkNodeRec shardTree = new WalkNodeRec();
                                    shardTree.El = sub;
                                    Queue<KeyValuePair<WalkNodeRec, int>> queue = new Queue<KeyValuePair<WalkNodeRec, int>>();
                                    queue.Enqueue(new KeyValuePair<WalkNodeRec, int>(shardTree, 0));
                                    CollectLevels(st, queue);
                                    List<string> pendingTexts = new List<string>();
                                    EmitDfs(st, shardTree, 0, pendingTexts);
                                }
                                try { System.Console.Error.WriteLine("[uia-probe][walk] shard-done visited=" + st.Visited + " nodes=" + st.NodeCount); } catch { }
                            }
                            catch (Exception shardErr)
                            {
                                try { System.Console.Error.WriteLine("[uia-probe][walk] shard-throw " + shardErr.GetType().Name + ": " + shardErr.Message); } catch { }
                            }
                        })));
                    }
                    // Wait each shard for its slice, clamped to the total
                    // budget remaining. Cold-start UIA COM activation (and
                    // the target's own accessibility-engine spin-up) makes
                    // the first calls slow — the caller raises both budgets
                    // for a cold window, which widens the slice too.
                    foreach (Task shard in shards)
                    {
                        long remaining = st.TotalMs - st.Clock.ElapsedMilliseconds;
                        if (remaining <= 0) { st.Truncated = true; break; }
                        int slice = subtreeTimeoutMs < remaining ? subtreeTimeoutMs : (int)remaining;
                        if (!shard.Wait(slice)) { st.Truncated = true; }
                    }
                    return SerializeState(st);
                }
                catch { return null; }
            };
            // Hang net above the internal clock: if a single UIA call is
            // stuck past the internal budget the walk cannot bail anyway —
            // salvage whatever landed instead of dropping it.
            Task<string> task = Task.Run(work);
            if (task.Wait(totalTimeoutMs + 500)) { return task.Result; }
            st.Truncated = true;
            return SerializeState(st);
        }


    }
}
'@

try {
    Add-Type -TypeDefinition $probeCs -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase | Out-Null
} catch {
    $reason = $_.Exception.Message -replace '"', "'"
    [Console]::Out.WriteLine('{"fatal":"add-type: ' + $reason + '"}')
    exit 1
}

[Console]::Out.WriteLine('{"ready":true}')

# Default interactive ControlType whitelist (plan 562 phase 0, widened by
# plan 576 with the ZCode content/row vocabulary: DataItem/TreeItem rows,
# Document page content, SplitButton, Spinner) — mirrored in
# the recorder uia-probe protocol (DEFAULT_INTERACTIVE_CONTROL_TYPES). Static Text is deliberately NOT
# whitelisted: Text nodes are absorbed as `label` on the next emitted
# element and never occupy emission slots. An enumerate request may
# override the list with a `controlTypes` array.
$defaultInteractiveTypes = @(
    'Button', 'SplitButton', 'Edit', 'Hyperlink', 'CheckBox', 'RadioButton',
    'ComboBox', 'TabItem', 'MenuItem', 'Slider', 'ListItem', 'ToggleSwitch',
    'DataItem', 'TreeItem', 'Document', 'Spinner')

# enumerate budgets (plan 562 phase 1; plan 576 semantics): per-root-child
# subtree slice (clamped to the total budget remaining; 250ms floor covers
# cold-start UIA COM activation), total walk budget, VISITED-node cap
# (raised from the 562-era 500: the 2026-09-29 cached-walk fix made the
# per-node cost one navigation call, and 1500 matches the model-facing
# render cap so the walk does not become the binding constraint before
# time does). The main side races at 3s.
$enumerateSubtreeMs = 250
$enumerateTotalMs = 1500
$enumerateMaxNodes = 1500
$enumerateMaxDepth = 40

while ($true) {
    if ($null -ne $stdinReader) { $line = $stdinReader.ReadLine() } else { $line = [Console]::In.ReadLine() }
    if ($null -eq $line) { break }
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0) { continue }

    try { $req = $trimmed | ConvertFrom-Json } catch {
        try { [System.Console]::Error.WriteLine('[uia-probe][loop] parse-fail: ' + $_.Exception.Message) } catch { }
        continue
    }

    $id = 0
    $op = ''
    try {
        if ($req.PSObject.Properties['id']) { $id = [int]$req.id }
        if ($req.PSObject.Properties['op']) { $op = [string]$req.op }
    } catch { }

    if ($op -eq 'ping') {
        [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true}')
    }
    elseif ($op -eq 'probe') {
        $x = 0.0
        $y = 0.0
        try { $x = [double]$req.x; $y = [double]$req.y } catch { }
        $json = [Duya.Recorder.UiaProbe]::ProbePoint($x, $y, 200)
        if ($null -eq $json) {
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"timeout"}')
        } else {
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,"element":' + $json + '}')
        }
    }
    elseif ($op -eq 'readUrl') {
        $hwnd = [IntPtr]::Zero
        try { $hwnd = [IntPtr][int64]$req.hwnd } catch { }
        $url = [Duya.Recorder.UiaProbe]::ReadUrl($hwnd, 500)
        if ($null -eq $url) {
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"not-found"}')
        } else {
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,"url":' + $url + '}')
        }
    }
    elseif ($op -eq 'enumerate') {
        $hwnd = [IntPtr]::Zero
        try { $hwnd = [IntPtr][int64]$req.hwnd } catch { }
        $maxNodes = $enumerateMaxNodes
        $maxDepth = $enumerateMaxDepth
        try { if ($req.PSObject.Properties['maxNodes']) { $maxNodes = [int]$req.maxNodes } } catch { }
        try { if ($req.PSObject.Properties['maxDepth']) { $maxDepth = [int]$req.maxDepth } } catch { }
        # Per-request walk budget (cold/warm tiers): the main side raises
        # totalMs for a window's first scan so the walk can absorb UIA COM
        # activation + the target's own accessibility-engine startup. The
        # subtree slice scales with it (half the total, floored at the
        # warm 250ms) so a cold FindFirst has room to come back at all.
        $totalMs = $enumerateTotalMs
        try {
            if ($req.PSObject.Properties['totalMs']) {
                $totalMs = [Math]::Max(500, [Math]::Min(20000, [int]$req.totalMs))
            }
        } catch { }
        $subtreeMs = $enumerateSubtreeMs
        if ($totalMs -gt $enumerateTotalMs) { $subtreeMs = [Math]::Max($subtreeMs, [int]($totalMs / 2)) }
        $types = $defaultInteractiveTypes
        try {
            if ($req.PSObject.Properties['controlTypes'] -and $null -ne $req.controlTypes) {
                $override = @($req.controlTypes | ForEach-Object { [string]$_ })
                if ($override.Count -gt 0) { $types = $override }
            }
        } catch { }
        $json = [Duya.Recorder.UiaProbe]::EnumerateWindow(
            $hwnd, $totalMs, $subtreeMs, $maxNodes, $maxDepth, [string[]]$types)
        if ($null -eq $json) {
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"timeout"}')
        } else {
            # EnumerateWindow returns a complete JSON object; strip its
            # outer braces so the splice yields ONE flat response line.
            # Splicing the raw object produced invalid JSON:
            # {"id":1,"ok":true,{"elements":...}} (missing key before '{').
            $frag = $json.Substring(1, $json.Length - 2)
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,' + $frag + '}')
        }
    }
    elseif ($op -eq 'fg') {
        $info = [Duya.Recorder.UiaProbe]::ForegroundHandle()
        if ($null -eq $info) {
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"no-window"}')
        } else {
            # hwnd, pid, title — split capped at 3 so a title that itself
            # contains tabs stays intact.
            $parts = $info -split "`t", 3
            $name = ''
            try {
                $p = Get-Process -Id [int]$parts[1] -ErrorAction SilentlyContinue
                if ($p) { $name = [string]$p.ProcessName }
            } catch { }
            $title = ''
            if ($parts.Count -ge 3) { $title = [string]$parts[2] }
            $o = @{ hwnd = [int64]$parts[0]; pid = [int]$parts[1]; processName = $name; title = $title }
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,"fg":' + ($o | ConvertTo-Json -Compress) + '}')
        }
    }
    else {
        [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"unknown-op"}')
    }
}
