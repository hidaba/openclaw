import { beforeEach, describe, expect, it } from "vitest";
import { TuiStreamAssembler } from "./tui-stream-assembler.js";

const text = (value: string) => ({ type: "text", text: value }) as const;
const thinking = (value: string) => ({ type: "thinking", thinking: value }) as const;
const message = (...content: readonly Record<string, unknown>[]) =>
  ({ role: "assistant", content }) as const;

describe("TuiStreamAssembler", () => {
  let assembler: TuiStreamAssembler;
  beforeEach(() => {
    assembler = new TuiStreamAssembler();
  });

  it("keeps thinking before content even when thinking arrives later", () => {
    expect(assembler.ingestDelta("run-1", message(text("Hello")), true)).toBe("Hello");
    expect(assembler.ingestDelta("run-1", message(thinking("Brain")), true)).toBe(
      "[thinking]\nBrain\n\nHello",
    );
  });

  it("tracks literal placeholder text as real displayable content until finalization", () => {
    expect(assembler.hasDisplayText("run-1")).toBe(false);
    assembler.ingestDelta("run-1", message(text("(no output)")), false);
    expect(assembler.hasDisplayText("run-1")).toBe(true);
    expect(assembler.finalize("run-1", message(), false)).toBe("(no output)");
    expect(assembler.hasDisplayText("run-1")).toBe(false);
  });

  it("renders sanitized pairing QR terminal text from final content", () => {
    const prompt = "Scan this QR code with the OpenClaw iOS app:";
    const qr = { type: "openclaw_pairing_qr", terminalText: "\u001b[47m\u001b[30m█ ▄\u001b[0m" };
    expect(assembler.finalize("run-1", message(text(prompt), qr), false)).toBe(`${prompt}\n\n█ ▄`);
  });

  it("keeps visible thinking ahead of an attachment-only final", () => {
    const content = message(thinking("Preparing the attachment"), {
      type: "image",
      data: "secret-image",
    });
    expect(assembler.finalize("run-1", content, true)).toBe(
      "[thinking]\nPreparing the attachment\n\nAttached image",
    );
  });

  it("returns null when delta text is unchanged", () => {
    expect(assembler.ingestDelta("run-4", message(text("Repeat")), false)).toBe("Repeat");
    expect(assembler.ingestDelta("run-4", message(text("Repeat")), false)).toBeNull();
  });

  it("bounds orphaned stream state while preserving recently active runs", () => {
    for (let index = 0; index < 200; index += 1) {
      assembler.ingestDelta(`run-${index}`, message(text(`Draft ${index}`)), false);
    }

    assembler.ingestDelta("run-0", message(text("Recently active")), false);
    assembler.ingestDelta("run-200", message(text("Newest")), false);
    expect(assembler.finalize("run-0", message(), false)).toBe("Recently active");
    expect(assembler.finalize("run-1", message(), false)).toBe("(no output)");
    expect(assembler.finalize("run-200", message(), false)).toBe("Newest");
  });

  it("does not evict an active run when an evicted run finalizes late", () => {
    for (let index = 0; index < 201; index += 1) {
      assembler.ingestDelta(`run-${index}`, message(text(`Draft ${index}`)), false);
    }

    expect(assembler.finalize("run-0", message(text("Late final")), false)).toBe("Late final");
    expect(assembler.finalize("run-1", message(), false)).toBe("Draft 1");
  });
});
