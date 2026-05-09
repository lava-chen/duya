#!/usr/bin/env python3
"""
timeline_builder.py

Utility script for the news-investigator skill.
Helps agents structure, deduplicate, and sort raw timeline entries
collected during Phase 1 and Phase 2 of investigation.

Usage:
  python3 timeline_builder.py --input raw_events.json --output timeline.md
  python3 timeline_builder.py --interactive   (enter events via stdin)
  python3 timeline_builder.py --merge file1.json file2.json --output merged.md

Input JSON format (raw_events.json):
  [
    {
      "date": "2024-03-15",
      "time": "14:32",          // optional
      "event": "Description of what happened",
      "source": "Reuters",
      "source_url": "https://...",  // optional
      "tier": "T2",
      "confidence": "established",  // established / probable / contested / unverified
      "notes": "Any caveats"         // optional
    },
    ...
  ]
"""

import json
import sys
import argparse
from datetime import datetime
from collections import defaultdict


def parse_date(entry):
    """Parse date string to sortable datetime."""
    date_str = entry.get("date", "")
    time_str = entry.get("time", "00:00")
    
    for fmt in ["%Y-%m-%d", "%Y/%m/%d", "%d-%m-%Y", "%B %d, %Y", "%b %d, %Y"]:
        try:
            dt = datetime.strptime(f"{date_str} {time_str}", f"{fmt} %H:%M")
            return dt
        except ValueError:
            continue
    
    # If parsing fails, return epoch (sorts to beginning)
    print(f"Warning: Could not parse date '{date_str}' — placing at start of timeline", 
          file=sys.stderr)
    return datetime(1970, 1, 1)


def detect_duplicates(events):
    """
    Detect likely duplicate entries (same event reported by multiple sources).
    Returns groups of events that appear to describe the same occurrence.
    """
    duplicates = []
    processed = set()
    
    for i, event in enumerate(events):
        if i in processed:
            continue
        
        group = [i]
        event_words = set(event["event"].lower().split())
        event_date = parse_date(event).date()
        
        for j, other in enumerate(events):
            if i == j or j in processed:
                continue
            
            other_date = parse_date(other).date()
            if event_date != other_date:
                continue
            
            other_words = set(other["event"].lower().split())
            
            # Simple overlap detection — events on same day with >50% word overlap
            overlap = len(event_words & other_words) / max(len(event_words), 1)
            if overlap > 0.5:
                group.append(j)
        
        if len(group) > 1:
            duplicates.append(group)
            processed.update(group)
    
    return duplicates


def format_confidence_badge(confidence):
    badges = {
        "established": "✓ Established",
        "probable": "~ Probable",
        "contested": "⚡ Contested",
        "unverified": "? Unverified",
        "disputed": "✗ Disputed/Likely False"
    }
    return badges.get(confidence.lower(), confidence)


def format_tier_badge(tier):
    colors = {"T1": "●", "T2": "◉", "T3": "○", "T4": "·", "T5": "·"}
    return f"{colors.get(tier, '·')} {tier}"


def build_timeline_markdown(events, include_gaps=True):
    """
    Build formatted markdown timeline from sorted events.
    Optionally flags time gaps > 24h as explicit entries.
    """
    if not events:
        return "No events to display."
    
    sorted_events = sorted(events, key=parse_date)
    lines = []
    prev_dt = None
    
    for event in sorted_events:
        dt = parse_date(event)
        
        # Gap detection
        if include_gaps and prev_dt:
            gap = dt - prev_dt
            if gap.days > 1:
                lines.append(f"\n> **⚠ Information gap: {gap.days} days with no verified events "
                             f"({prev_dt.strftime('%Y-%m-%d')} → {dt.strftime('%Y-%m-%d')})**\n")
        
        # Format date/time
        time_display = ""
        if event.get("time"):
            time_display = f" {event['time']}"
        date_display = f"**{event['date']}{time_display}**"
        
        # Format source
        source = event.get("source", "Unknown source")
        tier = event.get("tier", "T?")
        url = event.get("source_url", "")
        source_display = f"[{source}]({url})" if url else source
        
        # Format confidence
        confidence = event.get("confidence", "unverified")
        conf_badge = format_confidence_badge(confidence)
        tier_badge = format_tier_badge(tier)
        
        # Format notes
        notes = event.get("notes", "")
        notes_display = f"\n  *Note: {notes}*" if notes else ""
        
        lines.append(
            f"- {date_display} — {event['event']}\n"
            f"  *{source_display} · {tier_badge} · {conf_badge}*{notes_display}"
        )
        
        prev_dt = dt
    
    return "\n".join(lines)


def build_source_map(events):
    """Build a source relationship map showing what each source contributed."""
    source_map = defaultdict(list)
    
    for event in events:
        source = event.get("source", "Unknown")
        tier = event.get("tier", "T?")
        source_map[f"{source} ({tier})"].append(event["event"][:80])
    
    lines = ["### Source Map\n"]
    for source, contributions in sorted(source_map.items()):
        lines.append(f"**{source}** — {len(contributions)} event(s):")
        for contrib in contributions:
            lines.append(f"  - {contrib}{'...' if len(contrib) == 80 else ''}")
        lines.append("")
    
    return "\n".join(lines)


def interactive_mode():
    """Allow agent to enter events one by one via stdin."""
    print("News Investigator — Timeline Builder (Interactive Mode)")
    print("Enter events one at a time. Press Ctrl+D when done.\n")
    
    events = []
    
    while True:
        try:
            print(f"Event #{len(events)+1}")
            date = input("Date (YYYY-MM-DD): ").strip()
            if not date:
                break
            
            time = input("Time (HH:MM, optional): ").strip() or None
            event_desc = input("Event description: ").strip()
            source = input("Source name: ").strip()
            url = input("Source URL (optional): ").strip() or None
            tier = input("Tier (T1/T2/T3/T4/T5): ").strip() or "T3"
            confidence = input("Confidence (established/probable/contested/unverified): ").strip() or "unverified"
            notes = input("Notes (optional): ").strip() or None
            
            entry = {
                "date": date,
                "event": event_desc,
                "source": source,
                "tier": tier,
                "confidence": confidence
            }
            if time: entry["time"] = time
            if url: entry["source_url"] = url
            if notes: entry["notes"] = notes
            
            events.append(entry)
            print(f"  → Added.\n")
            
        except EOFError:
            break
    
    return events


def main():
    parser = argparse.ArgumentParser(description="Build structured news timeline")
    parser.add_argument("--input", help="Input JSON file with raw events")
    parser.add_argument("--output", help="Output markdown file (default: stdout)")
    parser.add_argument("--merge", nargs="+", help="Merge multiple JSON files")
    parser.add_argument("--interactive", action="store_true", help="Interactive entry mode")
    parser.add_argument("--no-gaps", action="store_true", help="Don't flag time gaps")
    parser.add_argument("--source-map", action="store_true", help="Include source map in output")
    parser.add_argument("--check-duplicates", action="store_true", help="Flag potential duplicates")
    
    args = parser.parse_args()
    
    events = []
    
    if args.interactive:
        events = interactive_mode()
    elif args.merge:
        for fpath in args.merge:
            with open(fpath) as f:
                events.extend(json.load(f))
    elif args.input:
        with open(args.input) as f:
            events = json.load(f)
    else:
        # Try reading from stdin
        try:
            events = json.load(sys.stdin)
        except json.JSONDecodeError:
            print("Error: Provide --input, --merge, --interactive, or pipe JSON to stdin", 
                  file=sys.stderr)
            sys.exit(1)
    
    if not events:
        print("No events provided.", file=sys.stderr)
        sys.exit(1)
    
    # Check for duplicates if requested
    if args.check_duplicates:
        duplicates = detect_duplicates(events)
        if duplicates:
            print(f"\n⚠ Potential duplicate groups detected ({len(duplicates)} groups):", 
                  file=sys.stderr)
            for group in duplicates:
                print(f"\n  Group:", file=sys.stderr)
                for idx in group:
                    print(f"    [{idx}] {events[idx]['date']} — {events[idx]['event'][:60]}... "
                          f"({events[idx].get('source', 'Unknown')})", file=sys.stderr)
    
    # Build output
    output_parts = ["# Event Timeline\n"]
    output_parts.append(f"*Generated: {datetime.now().strftime('%Y-%m-%d %H:%M')} · "
                       f"{len(events)} events*\n")
    output_parts.append(build_timeline_markdown(events, include_gaps=not args.no_gaps))
    
    if args.source_map:
        output_parts.append("\n---\n")
        output_parts.append(build_source_map(events))
    
    output = "\n".join(output_parts)
    
    if args.output:
        with open(args.output, "w") as f:
            f.write(output)
        print(f"Timeline written to {args.output}")
    else:
        print(output)


if __name__ == "__main__":
    main()
