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
    else {
        [Console]::Out.WriteLine('{"id":' + $id + ',"ok":false,"reason":"unknown-op"}')
    }
}
