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
            return "{\"name\":" + Escape(c.Name)
                 + ",\"controlType\":" + Escape(controlType)
                 + ",\"automationId\":" + Escape(c.AutomationId)
                 + ",\"className\":" + Escape(c.ClassName)
                 + ",\"rect\":" + rect
                 + ",\"isPassword\":" + (c.IsPassword ? "true" : "false")
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

            public void Add(string json)
            {
                lock (Gate) { Nodes.Add(json); }
            }
        }

        // Interactive whitelist check + JSON emission for one element.
        private static bool TryMakeNode(EnumState st, AutomationElement el, out string json)
        {
            json = null;
            try
            {
                AutomationElement.AutomationElementInformation c = el.Current;
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
                st.Add(json);
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
                    if (TryMakeNode(st, root, out rootJson)) { st.Add(rootJson); }

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
    else {
        [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"unknown-op"}')
    }
}
