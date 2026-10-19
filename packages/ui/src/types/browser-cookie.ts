export interface BrowserCookieProfile {
  browser: "chrome" | "edge";
  dir: string;
  name: string;
  cookieDbExists: boolean;
}
