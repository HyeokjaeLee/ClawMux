export interface OpenClawModelEntry {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
}

export interface OpenClawProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  auth?: string;
  models?: OpenClawModelEntry[];
}

export interface OpenClawConfig {
  models?: {
    mode?: "merge" | "replace";
    providers?: Record<string, OpenClawProviderConfig>;
  };
}

export interface AuthProfile {
  provider: string;
  apiKey?: string;
  token?: string;
  accountId?: string;
}

export interface ResolvedAuth {
  apiKey: string;
  headerName: string;
  headerValue: string;
  awsAccessKeyId?: string;
  awsSecretKey?: string;
  awsSessionToken?: string;
  awsRegion?: string;
  accountId?: string;
}
