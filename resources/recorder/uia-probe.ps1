# uia-probe.ps1 — persistent UIA point-probe service (plan 556 phase 2).
#
# Runs as a single PowerShell 5.1 child process (spawned by the shared
# computer-use daemon pipeline). Line protocol on stdin/stdout; the
# shapes are defined in packages/computer-use/src/recorder/
# uia-probe-protocol.ts:
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
#   emission slots (the 1-based invoke cache order stays interactive-only,
#   plan 576 red line) — their text rides as a `label` on the next
#   emitted element (forward attachment, capped). `maxNodes` budgets
#   VISITED nodes (Text/containers included, so a virtualized list cannot
#   flood the walk); offscreen subtrees are emitted as flagged leaves and
#   NOT descended into, which keeps the budget on on-screen content.
#   → {"id":5,"op":"invoke","hwnd":197144,"index":12,"method":"invoke",  — plan 564
#        "value":null,"name":"Sign in","controlType":"Button"}   structural act op:
#      {"id":5,"ok":true,"method":"invoke","pattern":"InvokePattern",  resolve the
#         "element":{...},"value":null}              1-based element from the last
#      {"id":5,"ok":false,"reason":"stale-tree"}     enumerate for that hwnd, verify
#                                                    name/controlType when given,
#                                                    dispatch a UIA pattern, return
#                                                    the post-action element JSON.
#                                                    Failure reasons: stale-tree,
#                                                    no-element, no-pattern,
#                                                    bad-index, no-window, timeout.
#
# The first stdout line is {"ready":true} once Add-Type finished — the
# main-side client gates ensureStarted() on it. All UIA work (which can
# block on hung/elevated targets) runs inside a .NET Task with a Wait
# timeout in the C# helper, so the stdin loop stays responsive even when
# a probe stalls; the main side additionally races every request.

$ErrorActionPreference = 'Continue'
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }
# stdin is a redirected pipe; [Console]::In decodes with the console
# input codepage (GBK on zh-CN hosts), which mangles every non-ASCII
# name the request carries (invoke/selectText guards become mojibake and
# fail closed as stale-tree). Decode explicitly as UTF-8 instead.
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

        // ---- plan 575 CUA surface: window/app enumeration + text selection ----

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [StructLayout(LayoutKind.Sequential)]
        private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [DllImport("user32.dll")]
        private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        // DWMWA_CLOAKED = 14 — a UWP shell window reports visible to
        // IsWindowVisible while actually suspended/hidden; DWM knows.
        [DllImport("dwmapi.dll")]
        private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

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
            // Invoke-slot snapshots parallel to Nodes (plan 564): runtime
            // id + name/type captured for free off the cached walk, so
            // `invoke` can re-hydrate a LIVE element without the walk
            // ever paying a per-node cross-process property read.
            public readonly List<InvokeSlot> Slots = new List<InvokeSlot>();
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

            public void Add(string json, InvokeSlot slot)
            {
                lock (Gate)
                {
                    Nodes.Add(json);
                    Slots.Add(slot);
                }
            }
        }

        // One invoke-cache slot: everything `invoke` needs to re-hydrate
        // the live element later. RuntimeId is the stable handle; name /
        // controlType double as the staleness guards the model's invoke
        // request carries.
        private class InvokeSlot
        {
            public int[] RuntimeId;
            public string Name;
            public string ControlType;
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
            cr.Add(AutomationElement.RuntimeIdProperty);
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
        // 1-based invoke cache order stays interactive-only); their text
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
                    InvokeSlot slot = new InvokeSlot();
                    try { slot.Name = c.Name; } catch { }
                    slot.ControlType = controlType;
                    try { slot.RuntimeId = (int[])rec.El.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty); } catch { slot.RuntimeId = null; }
                    st.Add(json, slot);
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
        private static string SerializeState(IntPtr hwnd, EnumState st)
        {
            string elements;
            List<InvokeSlot> snapshot;
            lock (st.Gate)
            {
                elements = st.Nodes.Count > 0
                    ? "[" + string.Join(",", st.Nodes.ToArray()) + "]"
                    : "[]";
                snapshot = new List<InvokeSlot>(st.Slots);
            }
            RememberElements(hwnd, snapshot);
            return "{\"elements\":" + elements
                 + ",\"truncated\":" + (st.Truncated ? "true" : "false")
                 + ",\"reason\":null"
                 + ",\"count\":" + snapshot.Count + "}";
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
                        InvokeSlot rootSlot = new InvokeSlot();
                        try
                        {
                            AutomationElement.AutomationElementInformation rc = root.Current;
                            rootSlot.Name = rc.Name;
                            rootSlot.ControlType = rc.ControlType != null ? rc.ControlType.ProgrammaticName : null;
                            if (rootSlot.ControlType != null) { rootSlot.ControlType = rootSlot.ControlType.Replace("ControlType.", ""); }
                            rootSlot.RuntimeId = root.GetRuntimeId();
                        }
                        catch { }
                        st.Visited++;
                        st.Add(rootJson, rootSlot);
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
                    return SerializeState(hwnd, st);
                }
                catch { return null; }
            };
            // Hang net above the internal clock: if a single UIA call is
            // stuck past the internal budget the walk cannot bail anyway —
            // salvage whatever landed instead of dropping it.
            Task<string> task = Task.Run(work);
            if (task.Wait(totalTimeoutMs + 500)) { return task.Result; }
            st.Truncated = true;
            return SerializeState(hwnd, st);
        }

        // ------------------------------------------------------------------
        // Structural act channel (plan 564). The enumerate walk caches the
        // live AutomationElement references per window; `invoke` resolves
        // a 1-based index against that cache, verifies optional staleness
        // guards, then dispatches a UIA pattern — the RPA-style structured
        // alternative to synthetic mouse events. Pattern actions work on
        // background windows and never depend on pixels.
        // ------------------------------------------------------------------

        private static readonly object CacheGate = new object();
        private static Dictionary<IntPtr, List<InvokeSlot>> ElementCache = new Dictionary<IntPtr, List<InvokeSlot>>();

        private static void RememberElements(IntPtr hwnd, List<InvokeSlot> slots)
        {
            if (slots == null || slots.Count == 0) { return; }
            lock (CacheGate)
            {
                // Tiny window-bounded cache: more than four tracked
                // windows means wholesale replacement (simplest correct
                // eviction; windows are re-enumerated on demand anyway).
                if (ElementCache.Count >= 4 && !ElementCache.ContainsKey(hwnd))
                {
                    ElementCache = new Dictionary<IntPtr, List<InvokeSlot>>();
                }
                ElementCache[hwnd] = slots;
            }
        }

        // Resolve a 1-based slot out of the window's cached tree and run
        // the optional staleness guards, then re-hydrate the LIVE element.
        // The cached walk stores RuntimeId + name/type snapshots (free
        // client-side reads), so the guard check costs no COM at all; the
        // live element is re-located once via a RuntimeId lookup so the
        // structural patterns act on the real thing, not a stale RCW.
        // Returns "ok", "no-element" (nothing cached for the hwnd),
        // "bad-index", "no-window", or "stale-tree" (the element died, or
        // name/controlType no longer match).
        private static string ResolveCached(IntPtr hwnd, int oneBasedIndex, string verifyName, string verifyType, out AutomationElement el)
        {
            el = null;
            InvokeSlot slot = null;
            lock (CacheGate)
            {
                List<InvokeSlot> list = null;
                if (!ElementCache.TryGetValue(hwnd, out list) || list == null) { return "no-element"; }
                if (oneBasedIndex < 1 || oneBasedIndex > list.Count) { return "bad-index"; }
                slot = list[oneBasedIndex - 1];
            }
            if (slot == null || slot.RuntimeId == null)
            {
                try { System.Console.Error.WriteLine("[uia-probe][resolve] stage=slot-rid-null slot=" + (slot == null ? "null" : (slot.Name ?? ""))); } catch { }
                return "stale-tree";
            }
            // Snapshot guard: the slot must still be what the model saw
            // when it read the tree listing. PS 5.1 binds an absent/null
            // $vname to "" for the string parameter (plan 564 smoke), so
            // the guard must treat empty as absent, not as a mismatch.
            if (!string.IsNullOrEmpty(verifyName))
            {
                if (!string.Equals(slot.Name ?? "", verifyName, StringComparison.OrdinalIgnoreCase))
                {
                    try { System.Console.Error.WriteLine("[uia-probe][resolve] stage=snap-name slot=" + (slot.Name ?? "") + " want=" + verifyName); } catch { }
                    return "stale-tree";
                }
            }
            if (!string.IsNullOrEmpty(verifyType))
            {
                if (!string.Equals(slot.ControlType ?? "", verifyType, StringComparison.OrdinalIgnoreCase))
                {
                    try { System.Console.Error.WriteLine("[uia-probe][resolve] stage=snap-type slot=" + (slot.ControlType ?? "") + " want=" + verifyType); } catch { }
                    return "stale-tree";
                }
            }
            try
            {
                AutomationElement root = AutomationElement.FromHandle(hwnd);
                if (root == null) { return "no-window"; }
                AutomationElement live = root.FindFirst(TreeScope.Subtree,
                    new PropertyCondition(AutomationElement.RuntimeIdProperty, slot.RuntimeId));
                if (live == null)
                {
                    try { System.Console.Error.WriteLine("[uia-probe][resolve] stage=refind-null ridLen=" + slot.RuntimeId.Length); } catch { }
                    return "stale-tree";
                }
                // Live guard: the element may have changed since the
                // snapshot even though the runtime id still resolves.
                AutomationElement.AutomationElementInformation c = live.Current;
                if (!string.IsNullOrEmpty(verifyName))
                {
                    if (!string.Equals(c.Name ?? "", verifyName, StringComparison.OrdinalIgnoreCase))
                    {
                        try { System.Console.Error.WriteLine("[uia-probe][resolve] stage=live-name live=" + (c.Name ?? "") + " want=" + verifyName); } catch { }
                        return "stale-tree";
                    }
                }
                if (!string.IsNullOrEmpty(verifyType))
                {
                    string have = c.ControlType != null ? c.ControlType.ProgrammaticName : null;
                    if (have != null) { have = have.Replace("ControlType.", ""); }
                    if (!string.Equals(have ?? "", verifyType, StringComparison.OrdinalIgnoreCase))
                    {
                        try { System.Console.Error.WriteLine("[uia-probe][resolve] stage=live-type live=" + (have ?? "") + " want=" + verifyType); } catch { }
                        return "stale-tree";
                    }
                }
                el = live;
                return "ok";
            }
            catch (Exception refErr)
            {
                try { System.Console.Error.WriteLine("[uia-probe][resolve] stage=refind-throw " + refErr.GetType().Name + ": " + refErr.Message); } catch { }
                return "stale-tree";
            }
        }

        private static object GetPattern(AutomationElement el, AutomationPattern pattern)
        {
            try
            {
                object p;
                if (el.TryGetCurrentPattern(pattern, out p)) { return p; }
            }
            catch { }
            return null;
        }

        // Execute one structural method. Returns the UIA pattern class
        // name used (null for SetFocus) and sets methodUsed to what
        // actually ran (auto may downgrade to focus). Throws
        // InvalidOperationException with a stable error code when the
        // requested method cannot be performed.
        private static string ExecuteMethod(AutomationElement el, string method, string value, out string methodUsed)
        {
            methodUsed = method;
            string ct = null;
            try
            {
                ct = el.Current.ControlType != null ? el.Current.ControlType.ProgrammaticName : null;
                if (ct != null) { ct = ct.Replace("ControlType.", ""); }
            }
            catch { }

            if (method == "focus")
            {
                el.SetFocus();
                return null;
            }

            if (method == "setValue")
            {
                ValuePattern vp = GetPattern(el, ValuePattern.Pattern) as ValuePattern;
                if (vp == null) { throw new InvalidOperationException("no-pattern"); }
                vp.SetValue(value ?? "");
                return "ValuePattern";
            }

            if (method == "invoke")
            {
                InvokePattern ip = GetPattern(el, InvokePattern.Pattern) as InvokePattern;
                if (ip == null) { throw new InvalidOperationException("no-pattern"); }
                ip.Invoke();
                return "InvokePattern";
            }

            if (method == "toggle")
            {
                TogglePattern tp = GetPattern(el, TogglePattern.Pattern) as TogglePattern;
                if (tp == null) { throw new InvalidOperationException("no-pattern"); }
                tp.Toggle();
                return "TogglePattern";
            }

            if (method == "expand" || method == "collapse")
            {
                ExpandCollapsePattern ep = GetPattern(el, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
                if (ep == null) { throw new InvalidOperationException("no-pattern"); }
                if (method == "expand") { ep.Expand(); } else { ep.Collapse(); }
                return "ExpandCollapsePattern";
            }

            if (method == "select")
            {
                SelectionItemPattern sp = GetPattern(el, SelectionItemPattern.Pattern) as SelectionItemPattern;
                if (sp == null) { throw new InvalidOperationException("no-pattern"); }
                sp.Select();
                return "SelectionItemPattern";
            }

            // method == "auto": ControlType-driven chain, first supported
            // pattern wins (UFO-style default chain).
            if (method == "auto")
            {
                if (ct == "Edit" || ct == "Document")
                {
                    if (value != null)
                    {
                        ValuePattern vp = GetPattern(el, ValuePattern.Pattern) as ValuePattern;
                        if (vp == null) { throw new InvalidOperationException("no-pattern"); }
                        methodUsed = "setValue";
                        vp.SetValue(value);
                        return "ValuePattern";
                    }
                    el.SetFocus();
                    methodUsed = "focus";
                    return null;
                }
                if (ct == "CheckBox" || ct == "ToggleSwitch")
                {
                    TogglePattern tp = GetPattern(el, TogglePattern.Pattern) as TogglePattern;
                    if (tp != null) { methodUsed = "toggle"; tp.Toggle(); return "TogglePattern"; }
                    InvokePattern ip = GetPattern(el, InvokePattern.Pattern) as InvokePattern;
                    if (ip != null) { methodUsed = "invoke"; ip.Invoke(); return "InvokePattern"; }
                }
                else if (ct == "ComboBox")
                {
                    ExpandCollapsePattern ep = GetPattern(el, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
                    if (ep != null) { methodUsed = "expand"; ep.Expand(); return "ExpandCollapsePattern"; }
                    InvokePattern ip = GetPattern(el, InvokePattern.Pattern) as InvokePattern;
                    if (ip != null) { methodUsed = "invoke"; ip.Invoke(); return "InvokePattern"; }
                }
                else if (ct == "ListItem" || ct == "RadioButton" || ct == "TabItem")
                {
                    SelectionItemPattern sp = GetPattern(el, SelectionItemPattern.Pattern) as SelectionItemPattern;
                    if (sp != null) { methodUsed = "select"; sp.Select(); return "SelectionItemPattern"; }
                    InvokePattern ip = GetPattern(el, InvokePattern.Pattern) as InvokePattern;
                    if (ip != null) { methodUsed = "invoke"; ip.Invoke(); return "InvokePattern"; }
                }
                else
                {
                    InvokePattern ip = GetPattern(el, InvokePattern.Pattern) as InvokePattern;
                    if (ip != null) { methodUsed = "invoke"; ip.Invoke(); return "InvokePattern"; }
                    TogglePattern tp = GetPattern(el, TogglePattern.Pattern) as TogglePattern;
                    if (tp != null) { methodUsed = "toggle"; tp.Toggle(); return "TogglePattern"; }
                    SelectionItemPattern sp = GetPattern(el, SelectionItemPattern.Pattern) as SelectionItemPattern;
                    if (sp != null) { methodUsed = "select"; sp.Select(); return "SelectionItemPattern"; }
                    ExpandCollapsePattern ep = GetPattern(el, ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
                    if (ep != null) { methodUsed = "expand"; ep.Expand(); return "ExpandCollapsePattern"; }
                }
                // No pattern supported: focus is the last-resort structural
                // action so the caller can follow with keyboard input.
                try { el.SetFocus(); methodUsed = "focus"; return null; }
                catch { throw new InvalidOperationException("no-pattern"); }
            }

            throw new InvalidOperationException("bad-method");
        }

        // Structural invoke entry. Returns "OK:" + post-action JSON
        // {"method":..,"pattern":..,"value":..[,"element":{..}]},
        // "ERR:<code>" (stale-tree / no-element / no-pattern / bad-index /
        // no-window), or null when the whole operation timed out.
        public static string InvokeElement(IntPtr hwnd, int oneBasedIndex, string method, string verifyName, string verifyType, string value, int timeoutMs)
        {
            Func<string> work = delegate
            {
                try
                {
                    if (hwnd == IntPtr.Zero) { return "ERR:no-window"; }
                    AutomationElement el2;
                    string resolveCode = ResolveCached(hwnd, oneBasedIndex, verifyName, verifyType, out el2);
                    if (resolveCode != "ok") { return "ERR:" + resolveCode; }
                    string methodUsed;
                    string pattern = ExecuteMethod(el2, method ?? "auto", value, out methodUsed);
                    // Post-action read-back: the element JSON after the
                    // action landed (lets the caller verify name/value),
                    // plus the ValuePattern value after setValue.
                    string readBack = "null";
                    if (methodUsed == "setValue")
                    {
                        try
                        {
                            ValuePattern vp = GetPattern(el2, ValuePattern.Pattern) as ValuePattern;
                            if (vp != null) { readBack = Escape(vp.Current.Value); }
                        }
                        catch { }
                    }
                    string postJson;
                    try { postJson = ElementJson(el2); } catch { postJson = "null"; }
                    string inner = postJson == "null" ? "" : postJson.Substring(1, postJson.Length - 2);
                    return "OK:{\"method\":" + Escape(methodUsed)
                         + ",\"pattern\":" + (pattern == null ? "null" : Escape(pattern))
                         + ",\"value\":" + readBack
                         + (inner.Length > 0 ? ",\"element\":{" + inner + "}" : "")
                         + "}";
                }
                catch (InvalidOperationException err)
                {
                    string code = err.Message;
                    if (string.IsNullOrEmpty(code)) { code = "error"; }
                    return "ERR:" + code;
                }
                catch
                {
                    // Any other exception almost always means the element
                    // reference died mid-action (window closed, UIA COM
                    // failure) — report stale so the caller re-enumerates.
                    return "ERR:stale-tree";
                }
            };
            Task<string> task = Task.Run(work);
            return task.Wait(timeoutMs) ? task.Result : null;
        }

        // ------------------------------------------------------------------
        // CUA surface (plan 575): app/window enumeration for list_apps /
        // list_windows, and TextPattern selection for select_text.
        // ------------------------------------------------------------------

        // list_apps: processes with a visible main window. exe is null for
        // system/elevated processes where MainModule is unreadable. active
        // marks the foreground pid. Returns a JSON array, null on timeout.
        public static string ListApps()
        {
            Func<string> work = delegate
            {
                IntPtr fg = GetForegroundWindow();
                int fgPid = 0;
                try { GetWindowThreadProcessId(fg, out fgPid); } catch { }
                List<string> rows = new List<string>();
                foreach (System.Diagnostics.Process p in System.Diagnostics.Process.GetProcesses())
                {
                    try
                    {
                        if (p.MainWindowHandle == IntPtr.Zero) { continue; }
                        string title = p.MainWindowTitle;
                        if (string.IsNullOrEmpty(title)) { continue; }
                        string exe = null;
                        try { exe = p.MainModule.FileName; } catch { }
                        string row = "{\"pid\":" + p.Id
                            + ",\"exe\":" + (exe == null ? "null" : Escape(exe))
                            + ",\"title\":" + Escape(title)
                            + ",\"active\":" + (fgPid == p.Id ? "true" : "false") + "}";
                        rows.Add(row);
                    }
                    catch { }
                }
                return "[" + string.Join(",", rows.ToArray()) + "]";
            };
            Task<string> task = Task.Run(work);
            return task.Wait(3000) ? task.Result : null;
        }

        // list_windows: top-level windows (optionally one pid). UWP shell
        // surfaces report DWMWA_CLOAKED so the caller can skip suspended
        // ApplicationFrameHost hosts. Returns a JSON array, null on timeout.
        public static string ListWindows(int pidFilter)
        {
            Func<string> work = delegate
            {
                List<string> rows = new List<string>();
                EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
                {
                    try
                    {
                        if (!IsWindowVisible(hWnd)) { return true; }
                        int pid;
                        GetWindowThreadProcessId(hWnd, out pid);
                        if (pidFilter > 0 && pid != pidFilter) { return true; }
                        int cloaked = 0;
                        try { DwmGetWindowAttribute(hWnd, 14, out cloaked, 4); } catch { }
                        StringBuilder sb = new StringBuilder(512);
                        GetWindowText(hWnd, sb, 512);
                        RECT r;
                        string rectJson = "null";
                        if (GetWindowRect(hWnd, out r))
                        {
                            rectJson = "{\"x\":" + r.Left + ",\"y\":" + r.Top
                                + ",\"w\":" + (r.Right - r.Left) + ",\"h\":" + (r.Bottom - r.Top) + "}";
                        }
                        string row = "{\"hwnd\":" + hWnd.ToInt64()
                            + ",\"pid\":" + pid
                            + ",\"title\":" + Escape(sb.ToString())
                            + ",\"rect\":" + rectJson
                            + ",\"minimized\":" + (IsIconic(hWnd) ? "true" : "false")
                            + ",\"cloaked\":" + (cloaked != 0 ? "true" : "false") + "}";
                        rows.Add(row);
                    }
                    catch { }
                    return true;
                }, IntPtr.Zero);
                return "[" + string.Join(",", rows.ToArray()) + "]";
            };
            Task<string> task = Task.Run(work);
            return task.Wait(3000) ? task.Result : null;
        }

        // select_text: resolve the cached element (same guards as invoke),
        // find the needle inside its TextPattern document range, and select
        // the first occurrence. Returns "OK:{...}" / "ERR:<code>" /
        // null-on-timeout like InvokeElement; codes add no-pattern and
        // not-found on top of the resolve family.
        public static string SelectText(IntPtr hwnd, int oneBasedIndex, string needle, string verifyName, string verifyType, int timeoutMs)
        {
            Func<string> work = delegate
            {
                try
                {
                    if (hwnd == IntPtr.Zero) { return "ERR:no-window"; }
                    if (string.IsNullOrEmpty(needle)) { return "ERR:not-found"; }
                    AutomationElement el2;
                    string resolveCode = ResolveCached(hwnd, oneBasedIndex, verifyName, verifyType, out el2);
                    if (resolveCode != "ok") { return "ERR:" + resolveCode; }
                    TextPattern tp = GetPattern(el2, TextPattern.Pattern) as TextPattern;
                    if (tp == null) { return "ERR:no-pattern"; }
                    System.Windows.Automation.Text.TextPatternRange doc = tp.DocumentRange;
                    System.Windows.Automation.Text.TextPatternRange found = doc.FindText(needle, true, false);
                    if (found == null) { return "ERR:not-found"; }
                    found.Select();
                    string postJson;
                    try { postJson = ElementJson(el2); } catch { postJson = "null"; }
                    string inner = postJson == "null" ? "" : postJson.Substring(1, postJson.Length - 2);
                    return "OK:{\"pattern\":\"TextPattern\""
                         + (inner.Length > 0 ? ",\"element\":{" + inner + "}" : "")
                         + "}";
                }
                catch
                {
                    return "ERR:stale-tree";
                }
            };
            Task<string> task = Task.Run(work);
            return task.Wait(timeoutMs) ? task.Result : null;
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
# packages/computer-use/src/recorder/uia-probe-protocol.ts
# (DEFAULT_INTERACTIVE_CONTROL_TYPES). Static Text is deliberately NOT
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
    elseif ($op -eq 'invoke') {
        # Structural act op (plan 564): resolve a 1-based element from the
        # last enumerate cache for this hwnd and dispatch a UIA pattern.
        $hwnd = [IntPtr]::Zero
        try { $hwnd = [IntPtr][int64]$req.hwnd } catch { }
        $index = 0
        try { if ($req.PSObject.Properties['index']) { $index = [int]$req.index } } catch { }
        $method = 'auto'
        try { if ($req.PSObject.Properties['method'] -and $req.method) { $method = [string]$req.method } } catch { }
        $value = $null
        try { if ($req.PSObject.Properties['value'] -and $null -ne $req.value) { $value = [string]$req.value } } catch { }
        $vname = $null
        try { if ($req.PSObject.Properties['name'] -and $null -ne $req.name) { $vname = [string]$req.name } } catch { }
        $vtype = $null
        try { if ($req.PSObject.Properties['controlType'] -and $null -ne $req.controlType) { $vtype = [string]$req.controlType } } catch { }
        $json = [Duya.Recorder.UiaProbe]::InvokeElement($hwnd, $index, $method, $vname, $vtype, $value, 1000)
        if ($null -eq $json) {
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"timeout"}')
        }
        elseif ($json.StartsWith('OK:')) {
            # Splice the post-action object into the flat response line —
            # strip "OK:" AND the inner object's braces, exactly like the
            # enumerate path, or the line reads "ok":true,{...} (invalid
            # JSON the client would drop on the floor).
            $frag = $json.Substring(4, $json.Length - 5)
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,' + $frag + '}')
        }
        else {
            # "ERR:<code>" — the code is a stable ASCII identifier.
            $code = $json.Substring(4)
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"' + $code + '"}')
        }
    }
    elseif ($op -eq 'apps') {
        # CUA list_apps (plan 575): processes with a visible main window.
        $json = [Duya.Recorder.UiaProbe]::ListApps()
        if ($null -eq $json) {
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"timeout"}')
        } else {
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,"apps":' + $json + '}')
        }
    }
    elseif ($op -eq 'windows') {
        # CUA list_windows (plan 575): top-level windows, optionally one pid.
        $pidFilter = 0
        try { if ($req.PSObject.Properties['pid'] -and $req.pid) { $pidFilter = [int]$req.pid } } catch { }
        $json = [Duya.Recorder.UiaProbe]::ListWindows($pidFilter)
        if ($null -eq $json) {
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"timeout"}')
        } else {
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,"windows":' + $json + '}')
        }
    }
    elseif ($op -eq 'selectText') {
        # CUA select_text (plan 575): TextPattern search + Select on a
        # cached enumerate element; same guard family as invoke.
        $hwnd = [IntPtr]::Zero
        try { $hwnd = [IntPtr][int64]$req.hwnd } catch { }
        $index = 0
        try { if ($req.PSObject.Properties['index']) { $index = [int]$req.index } } catch { }
        $needle = $null
        try { if ($req.PSObject.Properties['text'] -and $null -ne $req.text) { $needle = [string]$req.text } } catch { }
        $vname = $null
        try { if ($req.PSObject.Properties['name'] -and $null -ne $req.name) { $vname = [string]$req.name } } catch { }
        $vtype = $null
        try { if ($req.PSObject.Properties['controlType'] -and $null -ne $req.controlType) { $vtype = [string]$req.controlType } } catch { }
        $json = [Duya.Recorder.UiaProbe]::SelectText($hwnd, $index, $needle, $vname, $vtype, 1000)
        if ($null -eq $json) {
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"timeout"}')
        }
        elseif ($json.StartsWith('OK:')) {
            # Strip "OK:" and the inner object's braces (same splice rule
            # as invoke — Substring(3) alone left invalid JSON on the wire).
            $frag = $json.Substring(4, $json.Length - 5)
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,' + $frag + '}')
        }
        else {
            $code = $json.Substring(4)
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"' + $code + '"}')
        }
    }
    else {
        [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"unknown-op"}')
    }
}
