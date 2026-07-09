import { AcpClient, type AcpAgentConfig } from './acp-client';
import { claudeAgentConfig } from './claude';
import { codexAgentConfig } from './codex';
import { GROK_AGENT_CONFIG } from './grok';
import { KIRO_AGENT_CONFIG } from './kiro';
import { OPENCODE_AGENT_CONFIG } from './opencode';

/** The models a backend advertises via its ACP session config option. */
export interface BackendModels {
  /** The agent's current/default model value, if it reported one. */
  current?: string;
  options: { value: string; name: string }[];
}

const CONFIGS: Record<string, () => AcpAgentConfig> = {
  claude: claudeAgentConfig,
  codex: codexAgentConfig,
  grok: () => GROK_AGENT_CONFIG,
  kiro: () => KIRO_AGENT_CONFIG,
  opencode: () => OPENCODE_AGENT_CONFIG,
};

/** Enumerated once per extension session, keyed by backend id. */
const cache = new Map<string, BackendModels | null>();

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);

/**
 * Enumerate a backend's models by opening a throwaway ACP session, reading its
 * `configOptions` model option, then disposing the client (kills the process —
 * no lingering session or idle agent). Cached per backend for the session.
 * Returns null when the backend exposes no model option.
 */
export async function enumerateBackendModels(backendId: string, cwd: string): Promise<BackendModels | null> {
  const cached = cache.get(backendId);
  if (cached !== undefined) return cached;

  const configFn = CONFIGS[backendId];
  if (!configFn) return null;

  const client = new AcpClient(configFn());
  try {
    const session = await withTimeout(client.newSession(cwd, []), 20000);
    const models: BackendModels | null =
      session.modelConfig && session.modelConfig.options.length > 0
        ? {
            current: session.modelConfig.currentValue,
            options: session.modelConfig.options.map((o) => ({ value: o.value, name: o.name })),
          }
        : null;
    // Cache both positive results and "no model option" so we don't re-spawn.
    // Transient errors (catch) are not cached so a later call can retry.
    cache.set(backendId, models);
    return models;
  } catch (err) {
    console.warn(
      `Muster: model enumeration failed for backend "${backendId}":`,
      err instanceof Error ? err.message : err,
    );
    return null;
  } finally {
    client.dispose();
  }
}

export type EnumerateModelsProgress = (partial: Record<string, BackendModels>) => void;

/**
 * Enumerate models for several backends in parallel. Backends with no models are omitted.
 * When `onProgress` is set, it is called after each backend settles so the UI can update early.
 */
export async function enumerateModels(
  backendIds: string[],
  cwd: string,
  onProgress?: EnumerateModelsProgress,
): Promise<Record<string, BackendModels>> {
  const out: Record<string, BackendModels> = {};
  await Promise.all(
    backendIds.map(async (id) => {
      const models = await enumerateBackendModels(id, cwd);
      if (models) {
        out[id] = models;
        onProgress?.({ ...out });
      }
    }),
  );
  return out;
}

/** Test helper: clear the per-process enumeration cache. */
export function clearModelCatalogCacheForTests(): void {
  cache.clear();
}
