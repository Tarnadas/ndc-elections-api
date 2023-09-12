declare interface Env {
  [prop: string]: unknown;

  // Durable Objects
  CANDIDATES: DurableObjectNamespace;

  // Secret variables
  PIKESPEAK_API_KEY: string;
  PAGODA_API_KEY: string;
}
