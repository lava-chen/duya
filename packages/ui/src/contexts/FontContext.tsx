"use client";

import React, { createContext, useContext, useEffect, useState } from "react";

type MessageFont = "serif" | "sans-serif";

interface FontContextType {
  messageFont: MessageFont;
  setMessageFont: (font: MessageFont) => void;
}

const FontContext = createContext<FontContextType | undefined>(undefined);

export function FontProvider({ children }: { children: React.ReactNode }) {
  const [messageFont, setMessageFontState] = useState<MessageFont>("serif");
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    const loadFontPreference = async () => {
      try {
        if (window.electronAPI?.settingsDb?.getJson) {
          const font = await window.electronAPI.settingsDb.getJson<MessageFont>('messageFont', 'serif');
          if (font && (font === 'serif' || font === 'sans-serif')) {
            setMessageFontState(font);
            document.documentElement.setAttribute('data-message-font', font);
            window.localStorage.setItem('duya-message-font', font);
            setInitialized(true);
            return;
          }
        }
      } catch {
        // Fall back to localStorage if IPC fails
      }

      const savedFont = window.localStorage.getItem('duya-message-font') as MessageFont | null;
      if (savedFont && (savedFont === 'serif' || savedFont === 'sans-serif')) {
        setMessageFontState(savedFont);
        document.documentElement.setAttribute('data-message-font', savedFont);
      } else {
        document.documentElement.setAttribute('data-message-font', 'serif');
      }
      setInitialized(true);
    };

    loadFontPreference();
  }, []);

  const setMessageFont = (font: MessageFont) => {
    setMessageFontState(font);
    document.documentElement.setAttribute("data-message-font", font);
    window.localStorage.setItem("duya-message-font", font);
  };

  return (
    <FontContext.Provider value={{ messageFont, setMessageFont }}>
      {children}
    </FontContext.Provider>
  );
}

export function useFont() {
  const context = useContext(FontContext);
  if (context === undefined) {
    throw new Error("useFont must be used within a FontProvider");
  }
  return context;
}
