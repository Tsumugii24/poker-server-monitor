import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

const proxyAgents = new Map<string, ProxyAgent>();

export type HuggingFaceFetchOptions = RequestInit & {
  proxyUrl?: string | null;
};

export async function huggingFaceFetch(
  input: string | URL,
  { proxyUrl, ...init }: HuggingFaceFetchOptions = {}
): Promise<Response> {
  const normalizedProxyUrl = normalizeProxyUrl(proxyUrl);
  if (!normalizedProxyUrl) {
    return fetch(input, init);
  }
  const proxiedInit = {
    ...init,
    dispatcher: proxyAgent(normalizedProxyUrl) as Dispatcher
  } as unknown as NonNullable<Parameters<typeof undiciFetch>[1]>;
  return undiciFetch(input, proxiedInit) as unknown as Promise<Response>;
}

export function normalizeProxyUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("HF proxy URL must start with http:// or https://.");
  }
  return trimmed;
}

function proxyAgent(proxyUrl: string): ProxyAgent {
  let agent = proxyAgents.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyAgents.set(proxyUrl, agent);
  }
  return agent;
}
