"use client";

import { useEffect, useRef } from "react";
import type { RefineIteration } from "./types";
import { RefineIterationCard } from "./RefineIterationCard";

interface RefineIterationListProps {
  iterations: RefineIteration[];
}

export function RefineIterationList({ iterations }: RefineIterationListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [iterations.length]);

  if (iterations.length === 0) {
    return (
      <div className="text-[10px] text-[var(--muted)] italic px-1">
        No iterations yet. Send a request to start.
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      data-testid="refine-iteration-list"
      className="flex flex-col gap-2 overflow-auto max-h-[40vh] pr-1"
    >
      {iterations.map((it) => (
        <RefineIterationCard key={it.index} iteration={it} />
      ))}
    </div>
  );
}