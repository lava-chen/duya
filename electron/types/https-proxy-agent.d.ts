// Type declarations for https-proxy-agent
declare module 'https-proxy-agent' {
  import { Agent } from 'https';
  class HttpsProxyAgent extends Agent {
    constructor(opts: string | HttpsProxyAgent.Options);
  }
  namespace HttpsProxyAgent {
    interface Options {
      host?: string;
      port?: number;
      auth?: string;
      secureProxy?: boolean;
      protocol?: string;
    }
  }
  export = HttpsProxyAgent;
}