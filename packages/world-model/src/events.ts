import type { FaultEvent, TelemetrySample } from "@fleetos/core-schema";

/**
 * The world model's input stream: already-normalized events from the adapter
 * layer. The model never sees vendor payloads — adapters are held to that
 * normalization by the shared contract suite.
 */
export type WorldModelEvent = TelemetrySample | FaultEvent;

/**
 * Discriminates the ingest union. A fault is the only event with a `faultId`
 * (both shapes carry robotId/ts, so id alone is a safe discriminator).
 */
export function isFaultEvent(event: WorldModelEvent): event is FaultEvent {
  return "faultId" in event;
}
