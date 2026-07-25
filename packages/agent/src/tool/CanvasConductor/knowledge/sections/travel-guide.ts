/**
 * canvas_get_knowledge section: travel-guide
 * Travel / itinerary / route canvas composition: anchor, route, detail,
 * sources. Required composition and layout zones.
 */
export const CONTENT = `## Travel Guide Canvas Module

Use this module only after the user asks for a travel guide, itinerary, route, or trip-planning board. The goal is a layered, editable workspace rather than a column of text cards.

### Source Safety

- When browsing is available, find and verify real official, transport, booking, trail, or map URLs before placing them on the canvas.
- Use native/image only with a verified direct image/map URL or a user-provided asset.
- If browsing is unavailable, make Link cards only from URLs the user supplied. Never fabricate a URL, photo, weather value, or opening-hour claim.

### Required Composition

Unless the user explicitly asks for a text-only outline, build these editable layers:

1. **Visual anchor** — one native/image with a verified map, route image, landscape, or user-provided photo. Make it a prominent left or center element, not a tiny decoration.
2. **Route** — native/shape or native/text cards for stops and days, connected with native/connector arrows. Place the route beside or over the map rather than making one long vertical list.
3. **Detail** — one native/document for the complete itinerary and practical notes. Use short native cards only for scan-worthy decisions.
4. **Sources** — create 2–4 native/link cards for verified pages when usable URLs exist: official destination, transport/trail, booking, and map are typical roles.
5. **Optional mini component** — one widget/dynamic is allowed only for a local secondary visual such as a weather mini-card. It must be based on sourced data, be no larger than 5 x 3 grid units, and never replace the route, itinerary, map, or source cards.

### Layout Zones

- Top: title and key choices (date, duration, budget, or booking decision).
- Left / center: visual anchor and connected route.
- Right: compact weather card and source Link cards.
- Bottom: day-by-day document, packing, transport, and risk notes.

Leave visible whitespace between zones. A board that is only text boxes is incomplete when usable visual assets or sources are available.

### Creation Order

1. Gather sources if needed, then call canvas_get_context if extending an existing board.
2. Create the map/image, route nodes, document, and source links one at a time with canvas_create_element; add connectors only after both endpoints exist.
3. Add the weather widget only after the native content is established.
4. Capture and inspect the canvas after substantial layout changes; fix overlap, excessive empty space, and unreadable text before reporting.
`;