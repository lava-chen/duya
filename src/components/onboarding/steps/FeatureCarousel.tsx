"use client";

import { useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { CaretLeftIcon, CaretRightIcon, ArrowRightIcon } from "@/components/icons";

interface FeatureCarouselProps {
  onComplete: () => void;
}

const FEATURES = [
  {
    label: "Chat",
    titleKey: "onboarding.feature1.title" as const,
    descKey: "onboarding.feature1.desc" as const,
  },
  {
    label: "Files",
    titleKey: "onboarding.feature2.title" as const,
    descKey: "onboarding.feature2.desc" as const,
  },
  {
    label: "Tools",
    titleKey: "onboarding.feature3.title" as const,
    descKey: "onboarding.feature3.desc" as const,
  },
  {
    label: "Security",
    titleKey: "onboarding.feature4.title" as const,
    descKey: "onboarding.feature4.desc" as const,
  },
];

export function FeatureCarousel({ onComplete }: FeatureCarouselProps) {
  const { t } = useTranslation();
  const [currentIndex, setCurrentIndex] = useState(0);

  const handlePrev = () => {
    setCurrentIndex((i) => (i > 0 ? i - 1 : FEATURES.length - 1));
  };

  const handleNext = () => {
    if (currentIndex < FEATURES.length - 1) {
      setCurrentIndex((i) => i + 1);
    } else {
      onComplete();
    }
  };

  const currentFeature = FEATURES[currentIndex];

  return (
    <div className="flex flex-col h-full">
      {/* Carousel content */}
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-6 max-w-md">
          {/* Label */}
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-[var(--accent)]/10">
            <span className="text-[var(--accent)] text-sm font-medium" style={{ fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif" }}>
              {currentFeature.label}
            </span>
          </div>

          {/* Text */}
          <div className="space-y-2">
            <h2 className="text-xl font-semibold" style={{ color: "var(--text)", fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif" }}>
              {t(currentFeature.titleKey)}
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t(currentFeature.descKey)}
            </p>
          </div>
        </div>
      </div>

      {/* Navigation */}
      <div className="flex items-center justify-between pt-6">
        {/* Left arrow */}
        <button
          onClick={handlePrev}
          className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-[var(--chip)] transition-colors"
          aria-label="Previous"
        >
          <CaretLeftIcon size={24} />
        </button>

        {/* Feature indicators */}
        <div className="flex items-center gap-2">
          {FEATURES.map((_, index) => (
            <button
              key={index}
              onClick={() => setCurrentIndex(index)}
              className={`w-2 h-2 rounded-full transition-all duration-300 ${
                index === currentIndex
                  ? "w-6 bg-[var(--accent)]"
                  : "bg-[var(--border)] hover:bg-[var(--accent)]/50"
              }`}
              aria-label={t("onboarding.goToFeature", { index: index + 1 })}
            />
          ))}
        </div>

        {/* Right arrow or Next button */}
        {currentIndex < FEATURES.length - 1 ? (
          <button
            onClick={handleNext}
            className="p-2 rounded-lg text-muted-foreground hover:text-foreground hover:bg-[var(--chip)] transition-colors"
            aria-label="Next"
          >
            <CaretRightIcon size={24} />
          </button>
        ) : (
          <button
            onClick={handleNext}
            className="flex items-center gap-1 px-4 py-2 bg-[var(--accent)] text-white rounded-lg text-sm font-medium hover:opacity-90 transition-all"
          >
            {t("onboarding.next")}
            <ArrowRightIcon size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
