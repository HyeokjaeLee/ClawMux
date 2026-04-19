import { describe, it, expect } from "bun:test";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { AssistantMessageEvent } from "@mariozechner/pi-ai";
import { SignalDetector } from "../routing/signal-detector.ts";
import {
  detectSignalInStream,
  createSignalDetectionState,
  type SignalDetectionState,
} from "./signal-detecting-stream.ts";

const ESCALATE_SIGNAL = "===CLAWMUX_ESCALATE===";

function stubMessage(): AssistantMessageEvent & { type: "done" } {
  return {
    type: "done",
    reason: "stop",
    message: {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  };
}

function textDelta(
  text: string,
  contentIndex = 0,
): AssistantMessageEvent & { type: "text_delta"; delta: string; contentIndex: number } {
  return {
    type: "text_delta",
    contentIndex,
    delta: text,
    partial: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: "test",
      model: "test",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  };
}

async function collectEvents(
  events: AssistantMessageEvent[],
): Promise<{ emitted: AssistantMessageEvent[]; state: SignalDetectionState }> {
  const stream = createAssistantMessageEventStream();
  const detector = new SignalDetector();
  const state = createSignalDetectionState();
  const emitted: AssistantMessageEvent[] = [];

  const onSignal = () => {};

  const gen = detectSignalInStream(stream, detector, state, onSignal);

  const collectPromise = (async () => {
    for await (const event of gen) {
      emitted.push(event);
    }
  })();

  for (const event of events) {
    stream.push(event);
  }

  await collectPromise;
  return { emitted, state };
}

describe("detectSignalInStream", () => {
  it("passes through all events when no signal present", async () => {
    const { emitted, state } = await collectEvents([
      textDelta("Hello "),
      textDelta("world"),
      stubMessage(),
    ]);

    expect(state.signalDetected).toBe(false);
    expect(emitted.length).toBe(3);
  });

  it("detects signal in a single text_delta", async () => {
    const { emitted, state } = await collectEvents([
      textDelta("OK." + ESCALATE_SIGNAL),
      stubMessage(),
    ]);

    expect(state.signalDetected).toBe(true);
    expect(state.preSignalText).toBe("OK.");

    const textEvents = emitted.filter((e) => e.type === "text_delta");
    const combinedText = textEvents
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(combinedText).toBe("OK.");
  });

  it("detects signal split across multiple text_deltas", async () => {
    const { emitted, state } = await collectEvents([
      textDelta("OK."),
      textDelta("===CLAWM"),
      textDelta("UX_ESCALATE==="),
      stubMessage(),
    ]);

    expect(state.signalDetected).toBe(true);
    expect(state.preSignalText).toBe("OK.");

    const textEvents = emitted.filter((e) => e.type === "text_delta");
    const combinedText = textEvents
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(combinedText).toBe("OK.");
  });

  it("passes through non-text events unchanged", async () => {
    const startEvent: AssistantMessageEvent = {
      type: "start",
      partial: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "test",
        model: "test",
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    };

    const { emitted } = await collectEvents([startEvent, textDelta("hi"), stubMessage()]);

    expect(emitted[0]).toEqual(startEvent);
  });

  it("suppresses text after signal but forwards done", async () => {
    const stream = createAssistantMessageEventStream();
    const detector = new SignalDetector();
    const state = createSignalDetectionState();
    const emitted: AssistantMessageEvent[] = [];

    const gen = detectSignalInStream(stream, detector, state, () => {});

    const collectPromise = (async () => {
      for await (const event of gen) {
        emitted.push(event);
      }
    })();

    stream.push(textDelta(ESCALATE_SIGNAL));
    stream.push(textDelta("This should be suppressed"));
    const done = stubMessage();
    stream.push(done);

    await collectPromise;

    expect(state.signalDetected).toBe(true);

    const textEvents = emitted.filter((e) => e.type === "text_delta");
    expect(textEvents.length).toBe(0);

    const doneEvents = emitted.filter((e) => e.type === "done");
    expect(doneEvents.length).toBe(1);
  });

  it("invokes onSignal callback when signal detected", async () => {
    const stream = createAssistantMessageEventStream();
    const detector = new SignalDetector();
    const state = createSignalDetectionState();
    let signalCallCount = 0;

    const gen = detectSignalInStream(stream, detector, state, () => {
      signalCallCount++;
    });

    const collectPromise = (async () => {
      for await (const _ of gen) {}
    })();

    stream.push(textDelta(ESCALATE_SIGNAL));
    stream.push(stubMessage());

    await collectPromise;

    expect(signalCallCount).toBe(1);
  });

  it("flushes partial buffer at stream end", async () => {
    const { emitted, state } = await collectEvents([
      textDelta("==="),
      stubMessage(),
    ]);

    expect(state.signalDetected).toBe(false);
    expect(state.preSignalText).toBe("===");

    const textEvents = emitted.filter((e) => e.type === "text_delta");
    const combinedText = textEvents
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(combinedText).toBe("===");
  });

  it("handles empty stream gracefully", async () => {
    const { emitted, state } = await collectEvents([stubMessage()]);

    expect(state.signalDetected).toBe(false);
    expect(emitted.length).toBe(1);
    expect(emitted[0]!.type).toBe("done");
  });

  it("handles text_delta with non-string delta by passing through", async () => {
    const stream = createAssistantMessageEventStream();
    const detector = new SignalDetector();
    const state = createSignalDetectionState();
    const emitted: AssistantMessageEvent[] = [];

    const gen = detectSignalInStream(stream, detector, state, () => {});

    const collectPromise = (async () => {
      for await (const event of gen) {
        emitted.push(event);
      }
    })();

    const weirdEvent = {
      type: "text_delta" as const,
      contentIndex: 0,
      delta: 42 as unknown as string,
      partial: {
        role: "assistant" as const,
        content: [],
        api: "anthropic-messages" as const,
        provider: "test",
        model: "test",
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop" as const,
        timestamp: Date.now(),
      },
    };

    stream.push(weirdEvent);
    stream.push(stubMessage());

    await collectPromise;

    expect(emitted.length).toBe(2);
    expect(emitted[0]).toBe(weirdEvent);
  });

  it("emits preSignal text before signal even within same chunk", async () => {
    const { emitted, state } = await collectEvents([
      textDelta("Sure!" + ESCALATE_SIGNAL),
      stubMessage(),
    ]);

    expect(state.signalDetected).toBe(true);
    expect(state.preSignalText).toBe("Sure!");

    const textEvents = emitted.filter((e) => e.type === "text_delta");
    const combinedText = textEvents
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(combinedText).toBe("Sure!");
  });

  it("handles signal at start of text with no preSignal text", async () => {
    const { emitted, state } = await collectEvents([
      textDelta(ESCALATE_SIGNAL),
      stubMessage(),
    ]);

    expect(state.signalDetected).toBe(true);
    expect(state.preSignalText).toBe("");

    const textEvents = emitted.filter((e) => e.type === "text_delta");
    expect(textEvents.length).toBe(0);
  });

  it("buffers partial prefix across chunks then diverges and emits", async () => {
    const { emitted, state } = await collectEvents([
      textDelta("==="),
      textDelta("CLAWMUXX"),
      stubMessage(),
    ]);

    expect(state.signalDetected).toBe(false);

    const textEvents = emitted.filter((e) => e.type === "text_delta");
    const combinedText = textEvents
      .map((e) => (e as { delta: string }).delta)
      .join("");
    expect(combinedText).toBe("===CLAWMUXX");
  });
});
