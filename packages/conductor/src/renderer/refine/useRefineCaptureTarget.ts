"use client";

import { useEffect, useRef } from "react";
import { useRefineStore } from "..//stores/refine-store";

/**
 * Hook for widget DOM roots to register themselves as capture targets
 * for the refine loop. Pass the ref containing the widget's root element.
 */
export function useRefineCaptureTarget(widgetId: string) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const setCaptureTarget = useRefineStore((s) => s.setCaptureTarget);

  useEffect(() => {
    if (!widgetId) return;
    setCaptureTarget(widgetId, elRef.current);
    return () => {
      setCaptureTarget(widgetId, null);
    };
  }, [widgetId, setCaptureTarget]);

  return elRef;
}