import { createElement } from "react";

import {
  AI_RUNTIME_PROTOCOL_LIMITS,
  AI_RUNTIME_PROTOCOL_VERSION,
  createConversationStore,
  parseChatRequest,
} from "handrail-agent-sdk/assistant";
import {
  IndexedDBConversationEventStore,
  IndexedDBConversationSyncStateStore,
} from "handrail-agent-sdk/assistant/browser";
import "handrail-agent-sdk/assistant/react";
import {
  REACT_PRESENTATION_RECIPES,
  createReactPresentationFixture,
  type ReactPresentationRecipeProps,
} from "../../../examples/react-presentations.js";

export {
  AI_RUNTIME_PROTOCOL_LIMITS,
  AI_RUNTIME_PROTOCOL_VERSION,
  createConversationStore,
  IndexedDBConversationEventStore,
  IndexedDBConversationSyncStateStore,
  parseChatRequest,
};

export const reactSubpathElement = createElement(
  "span",
  null,
  "handrail-agent-sdk/assistant/react resolved",
);

/** Vite compiles actual elements for all six checked, consumer-owned recipes. */
export function renderReactPresentationRecipes(props: ReactPresentationRecipeProps) {
  return REACT_PRESENTATION_RECIPES.map((Recipe, index) =>
    createElement(Recipe, { ...props, key: index })
  );
}

export { createReactPresentationFixture };
