import { useState, useEffect } from 'react';

export function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>('dark');

  useEffect(() => {
    // Get initial theme from localStorage or data-theme attribute
    const getTheme = () => {
      if (typeof window === 'undefined') return 'dark';
      
      // Check localStorage first
      const stored = window.localStorage.getItem('duya-theme');
      if (stored === 'light' || stored === 'dark') {
        return stored;
      }
      
      // Fall back to data-theme attribute
      const dataTheme = document.documentElement.getAttribute('data-theme');
      if (dataTheme === 'light' || dataTheme === 'dark') {
        return dataTheme;
      }
      
      return 'dark';
    };

    setTheme(getTheme());

    // Listen for theme changes
    const handleStorageChange = () => {
      setTheme(getTheme());
    };

    // Listen for data-theme attribute changes
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.attributeName === 'data-theme') {
          setTheme(getTheme());
        }
      });
    });

    observer.observe(document.documentElement, { attributes: true });
    window.addEventListener('storage', handleStorageChange);

    return () => {
      observer.disconnect();
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  return { theme };
}
