import type { Component, OverlayHandle } from "@earendil-works/pi-tui";
import { vi } from "vitest";
import {
  captureChoicePromptSelector,
  type TestChoiceSelector,
} from "./components/choice-prompt.test-support.js";

export function createOverlayHandle(): OverlayHandle {
  return {
    hide: vi.fn(),
    setHidden: vi.fn(),
    isHidden: vi.fn(() => false),
    focus: vi.fn(),
    unfocus: vi.fn(),
    isFocused: vi.fn(() => true),
    getBounds: () => undefined,
  };
}

export function createChoicePromptHarness() {
  let agentId = "main";
  let sessionKey = "agent:main:main";
  const selectors: TestChoiceSelector[] = [];
  const overlayHandles: OverlayHandle[] = [];
  return {
    selectors,
    overlayHandles,
    addSystem: vi.fn(),
    closeOverlay: vi.fn(),
    requestRender: vi.fn(),
    getAgentId: () => agentId,
    getSessionKey: () => sessionKey,
    setAgentId: (value: string) => {
      agentId = value;
    },
    setSessionKey: (value: string) => {
      sessionKey = value;
    },
    openOverlay: vi.fn((component: Component) => {
      selectors.push(captureChoicePromptSelector(component));
      const handle = createOverlayHandle();
      overlayHandles.push(handle);
      return handle;
    }),
  };
}
