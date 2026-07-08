export interface LoopsRunConfig {
  engine?: string;
  defaultModel?: string;
  workerModel?: string;
  validatorModel?: string;
  reviewerModel?: string;
  apiKey?: string;
  cliBinary?: string;
  permissionMode?: string;
  engineArg?: string[];
  budget?: string | number;
  ground?: boolean;
  record?: string | false;
  checkpoint?: string;
  supervise?: boolean;
  onLimit?: string;
  maxWait?: string;
  json?: boolean;
  tui?: boolean;
}

export interface LoopsConfig {
  run?: LoopsRunConfig;
  profiles?: Record<string, LoopsRunConfig | { run?: LoopsRunConfig }>;
}

/** Identity helper for `loops.config.ts`. */
export function defineConfig(config: LoopsConfig): LoopsConfig {
  return config;
}
