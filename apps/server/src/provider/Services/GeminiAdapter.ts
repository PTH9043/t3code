/**
 * GeminiAdapter — shape type for the Gemini CLI ACP provider adapter.
 *
 * One adapter is captured by each Gemini provider instance, so this module
 * only names the structural adapter contract used by the driver bundle.
 *
 * @module GeminiAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface GeminiAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
