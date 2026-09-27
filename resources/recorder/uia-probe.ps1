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
#        "maxDepth":40,"maxNodes":500,              (knobs optional; controlTypes
#        "controlTypes":["Button",...]}             overrides the built-in whitelist)
#      {"id":4,"ok":true,"elements":[{"name":"..","controlType":"Button",...,
#         "rect":{...},"isPassword":false,"interactive":true},...],
#         "truncated":false,"reason":null,"count":12}
#      {"id":4,"ok":true,"elements":[],"truncated":true,...}  — partial tree kept
#                                                               after a budget hit
#      {"id":4,"ok":true,"elements":[],"reason":"elevated",...} — UIPI skip, no
#                                                                  budget burned
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
                            valueJson = Escape(vp.Current.Value);
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

        // Enumerate nodes carry the interactive assertion the overlay's
        // renderer-side defense re-checks (plan 562 phase 3). The base
        // JSON always ends with "}", so splice the flag in.
        private static string InteractiveElementJson(AutomationElement el)
        {
            string baseJson = ElementJson(el);
            if (baseJson == "null") { return null; }
            return baseJson.Substring(0, baseJson.Length - 1) + ",\"interactive\":true}";
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
            // Live element references parallel to Nodes (plan 564) — the
            // invoke op resolves its 1-based index against this list.
            public readonly List<AutomationElement> Elements = new List<AutomationElement>();
            public readonly object Gate = new object();
            public readonly HashSet<string> ControlTypes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            public TreeWalker Walker = TreeWalker.ControlViewWalker;
            public Stopwatch Clock;
            public int TotalMs;
            public int MaxNodes;
            public int MaxDepth;
            public bool Truncated;

            public int NodeCount
            {
                get { lock (Gate) { return Nodes.Count; } }
            }

            public bool BudgetBlown
            {
                get { return NodeCount >= MaxNodes || Clock.ElapsedMilliseconds >= TotalMs; }
            }

            public void Add(string json, AutomationElement el)
            {
                lock (Gate)
                {
                    Nodes.Add(json);
                    Elements.Add(el);
                }
            }
        }

        // Interactive whitelist check + JSON emission for one element.
        // IsOffscreen elements are skipped (UFO inspector's default
        // filter): they are invisible to the user, cannot be click
        // targets, and virtualized lists would otherwise flood the
        // tree with placeholder rows.
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
                json = InteractiveElementJson(el);
                return json != null;
            }
            catch { return false; }
        }

        // ControlViewWalker recursion. Depth is capped silently (a
        // naturally shallow tree must not be flagged truncated); the
        // truncated flag is reserved for node/time budget hits.
        private static void Walk(EnumState st, AutomationElement el, int depth)
        {
            if (el == null || depth > st.MaxDepth) { return; }
            if (st.BudgetBlown) { st.Truncated = true; return; }

            string json;
            if (TryMakeNode(st, el, out json))
            {
                st.Add(json, el);
                if (st.NodeCount >= st.MaxNodes) { st.Truncated = true; return; }
            }
            if (depth == st.MaxDepth) { return; }

            AutomationElement child;
            try { child = st.Walker.GetFirstChild(el); } catch { return; }
            while (child != null)
            {
                Walk(st, child, depth + 1);
                if (st.BudgetBlown) { st.Truncated = true; return; }
                AutomationElement next;
                try { next = st.Walker.GetNextSibling(child); } catch { return; }
                child = next;
            }
        }

        // Returns a complete JSON object
        // {"elements":[...],"truncated":bool,"reason":str|null,"count":n}
        // for the PS dispatcher to splice (it strips the outer braces),
        // or null when the whole operation timed out (caller maps to
        // ok:false/timeout).
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

                    AutomationElement root = AutomationElement.FromHandle(hwnd);
                    if (root == null) { return null; }

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

                    // The root itself is rarely interactive (Window), but a
                    // custom whitelist may include it — check it inline.
                    string rootJson;
                    if (TryMakeNode(st, root, out rootJson)) { st.Add(rootJson, root); }

                    // Each child of the root walks in its own task with an
                    // independent time slice: one hung subtree cannot eat
                    // the whole budget. Abandoned shards keep running and
                    // are simply never merged — partial tree is the answer.
                    List<Task> shards = new List<Task>();
                    AutomationElement child;
                    try { child = st.Walker.GetFirstChild(root); } catch { child = null; }
                    while (child != null)
                    {
                        AutomationElement sub = child;
                        shards.Add(Task.Run((Action)(delegate
                        {
                            try { Walk(st, sub, 1); } catch { }
                        })));
                        try { child = st.Walker.GetNextSibling(child); } catch { break; }
                    }
                    // Wait each shard for its slice, clamped to the total
                    // budget remaining. Cold-start UIA COM activation makes
                    // the first calls slow — a fixed 50ms slice produced
                    // truncated:true + count:0 on the real-machine smoke
                    // (every shard timed out before its first node landed),
                    // so the floor is 250ms; sibling shards run in parallel
                    // and typically finish during the first wait.
                    foreach (Task shard in shards)
                    {
                        long remaining = st.TotalMs - st.Clock.ElapsedMilliseconds;
                        if (remaining <= 0) { st.Truncated = true; break; }
                        int slice = subtreeTimeoutMs < remaining ? subtreeTimeoutMs : (int)remaining;
                        if (!shard.Wait(slice)) { st.Truncated = true; }
                    }

                    string elements = "[]";
                    lock (st.Gate)
                    {
                        if (st.Nodes.Count > 0) { elements = "[" + string.Join(",", st.Nodes.ToArray()) + "]"; }
                    }
                    // Remember the live element references for the invoke
                    // op (plan 564). Emission order == Nodes order == the
                    // 1-based index the LLM-facing tree listing shows.
                    List<AutomationElement> snapshot;
                    lock (st.Gate) { snapshot = new List<AutomationElement>(st.Elements); }
                    RememberElements(hwnd, snapshot);
                    return "{\"elements\":" + elements
                         + ",\"truncated\":" + (st.Truncated ? "true" : "false")
                         + ",\"reason\":null"
                         + ",\"count\":" + st.NodeCount + "}";
                }
                catch { return null; }
            };
            // Hang net above the internal clock: if a single UIA call is
            // stuck past the internal budget the walk cannot bail anyway.
            Task<string> task = Task.Run(work);
            return task.Wait(totalTimeoutMs + 500) ? task.Result : null;
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
        private static Dictionary<IntPtr, List<AutomationElement>> ElementCache = new Dictionary<IntPtr, List<AutomationElement>>();

        private static void RememberElements(IntPtr hwnd, List<AutomationElement> elements)
        {
            if (elements == null || elements.Count == 0) { return; }
            lock (CacheGate)
            {
                // Tiny window-bounded cache: more than four tracked
                // windows means wholesale replacement (simplest correct
                // eviction; windows are re-enumerated on demand anyway).
                if (ElementCache.Count >= 4 && !ElementCache.ContainsKey(hwnd))
                {
                    ElementCache = new Dictionary<IntPtr, List<AutomationElement>>();
                }
                ElementCache[hwnd] = elements;
            }
        }

        // Resolve a 1-based slot out of the window's cached tree and run
        // the optional staleness guards. Returns "ok", "no-element"
        // (nothing cached for the hwnd), "bad-index", or "stale-tree"
        // (the COM element died, or name/controlType no longer match).
        private static string ResolveCached(IntPtr hwnd, int oneBasedIndex, string verifyName, string verifyType, out AutomationElement el)
        {
            el = null;
            List<AutomationElement> list = null;
            lock (CacheGate)
            {
                if (!ElementCache.TryGetValue(hwnd, out list) || list == null) { return "no-element"; }
                if (oneBasedIndex < 1 || oneBasedIndex > list.Count) { return "bad-index"; }
                el = list[oneBasedIndex - 1];
            }
            try
            {
                AutomationElement.AutomationElementInformation c = el.Current;
                if (verifyName != null)
                {
                    if (!string.Equals(c.Name ?? "", verifyName, StringComparison.OrdinalIgnoreCase)) { return "stale-tree"; }
                }
                if (verifyType != null)
                {
                    string have = c.ControlType != null ? c.ControlType.ProgrammaticName : null;
                    if (have != null) { have = have.Replace("ControlType.", ""); }
                    if (!string.Equals(have ?? "", verifyType, StringComparison.OrdinalIgnoreCase)) { return "stale-tree"; }
                }
                return "ok";
            }
            catch { return "stale-tree"; }
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

# Default interactive ControlType whitelist (plan 562 phase 0) — mirrored
# in packages/computer-use/src/recorder/uia-probe-protocol.ts
# (DEFAULT_INTERACTIVE_CONTROL_TYPES). An enumerate request may override
# it with a `controlTypes` array.
$defaultInteractiveTypes = @(
    'Button', 'Edit', 'Hyperlink', 'CheckBox', 'RadioButton', 'ComboBox',
    'TabItem', 'MenuItem', 'Slider', 'ListItem', 'ToggleSwitch')

# enumerate budgets (plan 562 phase 1): per-root-child subtree slice
# (clamped to the total budget remaining; 250ms floor covers cold-start
# UIA COM activation), total walk budget, node cap. The main side races
# at 3s.
$enumerateSubtreeMs = 250
$enumerateTotalMs = 1500
$enumerateMaxNodes = 500
$enumerateMaxDepth = 40

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0) { continue }

    try { $req = $trimmed | ConvertFrom-Json } catch { continue }

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
        $types = $defaultInteractiveTypes
        try {
            if ($req.PSObject.Properties['controlTypes'] -and $null -ne $req.controlTypes) {
                $override = @($req.controlTypes | ForEach-Object { [string]$_ })
                if ($override.Count -gt 0) { $types = $override }
            }
        } catch { }
        $json = [Duya.Recorder.UiaProbe]::EnumerateWindow(
            $hwnd, $enumerateTotalMs, $enumerateSubtreeMs, $maxNodes, $maxDepth, [string[]]$types)
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
            # Splice the post-action object into the flat response line.
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":true,' + $json.Substring(3) + '}')
        }
        else {
            # "ERR:<code>" — the code is a stable ASCII identifier.
            $code = $json.Substring(4)
            [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"' + $code + '"}')
        }
    }
    else {
        [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"unknown-op"}')
    }
}
