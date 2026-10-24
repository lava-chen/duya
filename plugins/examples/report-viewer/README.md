# Report Viewer example

This package shows a read-only Plugin UI surface served by its own MCP stdio
server. The manifest declares `ui://reports/overview`; the host loads that
resource and mounts it in the existing side-panel tab. The HTML file is the
MCP server's response source, not a package-local app entry point.

The MCP server also exposes `duya_ui_select`, `duya_ui_highlight`, and
`duya_ui_refresh` for the `report-overview` surface. The host translates those
tool calls into token-bound events for the current iframe. The page validates
the parent window, document token, and surface id before updating its display.

`plugins/examples/hello-app` remains a static `entry` example for compatibility.
