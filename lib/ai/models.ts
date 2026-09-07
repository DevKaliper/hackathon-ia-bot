import type { JSONValue } from "ai";

export const CHAT_MODEL = "alibaba/qwen3.8-flash";

export const EMBEDDING_MODEL = "openai/text-embedding-3-small";

export const EMBEDDING_DIMENSIONS = 1536;

export const MAX_STEPS = 12;


type OpcionesProveedor = Record<string, Record<string, JSONValue>>;

const OPCIONES_POR_MODELO: Record<string, OpcionesProveedor> = {
  "openai/gpt-5-nano": { openai: { reasoningEffort: "low" } },
};

export function opcionesDe(modelo: string): OpcionesProveedor {
  return OPCIONES_POR_MODELO[modelo] ?? {};
}

export const CHAT_PROVIDER_OPTIONS = opcionesDe(CHAT_MODEL);
