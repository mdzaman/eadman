export * from "./types.ts";
export { ConfigError, configSchema, loadConfig, parseConfig, validateConfig, type LoadedConfig } from "./load.ts";
export { DEFAULT_CHECKS, deepMerge, resolveConfig } from "./resolve.ts";
