import type { AssistantMessageEventStream, AssistantMessageEvent } from "@mariozechner/pi-ai";
import { SignalDetector } from "../routing/signal-detector.ts";

export interface SignalDetectionState {
  signalDetected: boolean;
  preSignalText: string;
}

export function createSignalDetectionState(): SignalDetectionState {
  return { signalDetected: false, preSignalText: "" };
}

/**
 * Wraps a pi-ai AssistantMessageEventStream with signal detection.
 *
 * Only `text_delta` events are scanned for the escalation signal.
 * All other events pass through unchanged.
 *
 * When the signal is detected:
 * - state.signalDetected is set to true
 * - onSignal() is invoked
 * - Subsequent text_delta events after the signal are suppressed
 * - The "done" event is still forwarded so the stream closes cleanly
 *
 * Buffering: chars that might be part of the signal are held back and
 * NOT emitted until either the signal is confirmed (→ suppressed) or a
 * non-matching char causes divergence (→ emitted as passthrough).
 */
export async function* detectSignalInStream(
  stream: AssistantMessageEventStream,
  detector: SignalDetector,
  state: SignalDetectionState,
  onSignal: () => void,
): AsyncGenerator<AssistantMessageEvent> {
  let signaled = false;

  for await (const event of stream) {
    if (signaled) {
      if (event.type === "done" || event.type === "error") {
        yield event;
      }
      continue;
    }

    if (event.type === "text_delta" && typeof event.delta === "string") {
      const results = detector.feedChunk(event.delta);
      let confirmedText = "";

      for (const r of results) {
        if (r.type === "passthrough") {
          state.preSignalText += r.text;
          confirmedText += r.text;
        } else if (r.type === "signal_detected") {
          signaled = true;
          state.signalDetected = true;
          onSignal();
        }
      }

      if (signaled) {
        if (confirmedText.length > 0) {
          yield {
            ...event,
            delta: confirmedText,
          } as AssistantMessageEvent & { type: "text_delta"; delta: string };
        }
        continue;
      }

      if (confirmedText.length > 0) {
        yield {
          ...event,
          delta: confirmedText,
        } as AssistantMessageEvent & { type: "text_delta"; delta: string };
      }
      continue;
    }

    if (event.type === "done" || event.type === "error") {
      const flushed = detector.flush();
      if (flushed !== null) {
        state.preSignalText += flushed;
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta: flushed,
          partial: event.type === "done" ? event.message : event.error,
        } as AssistantMessageEvent;
      }
    }

    yield event;
  }
}
