import type { Context, Message } from "@mariozechner/pi-ai";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { ContentPart, InputItem } from "./openai-ws-connection.js";

type AnyMessage = Message & { role: string; content: unknown };
export type ReplayModelInfo = { input?: ReadonlyArray<string> };
type ReplayableReasoningItem = Extract<InputItem, { type: "reasoning" }>;
type ReplayableReasoningSignature = {
  type: "reasoning" | `reasoning.${string}`;
  id?: string;
};
type ToolCallReplayId = { callId: string; itemId?: string };
export type PlannedTurnInput = {
  inputItems: InputItem[];
  previousResponseId?: string;
  mode: "incremental_tool_results" | "full_context_initial" | "full_context_restart";
};

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function supportsImageInput(modelOverride?: ReplayModelInfo): boolean {
  return !Array.isArray(modelOverride?.input) || modelOverride.input.includes("image");
}

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(
      (part): part is { type?: string; text?: string } => Boolean(part) && typeof part === "object",
    )
    .filter(
      (part) =>
        (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
        typeof part.text === "string",
    )
    .map((part) => part.text as string)
    .join("");
}

function contentToOpenAIParts(content: unknown, modelOverride?: ReplayModelInfo): ContentPart[] {
  if (typeof content === "string") {
    return content ? [{ type: "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) {
    return [];
  }

  const includeImages = supportsImageInput(modelOverride);
  const parts: Conte ntPart[] = [];
  for (const part of content as Array<{
    type?: string;
    text?: string;
    data?: string;
    mimeType?: string;
    source?: unknown;
  }>) {
    if (
      (part.type === "text" || part.type === "input_text" || part.type === "output_text") &&
      typeof part.text === "string"
    ) {
      parts.push({ type: "input_text", text: part.text });
      continue;
    }

    if (!includeImages) {
      continue;
    }

    if (part.type === "image" && typeof part.data === "string") {
      parts.push({
        type: "input_image",
        source: {
          type: "base64",
          media_type: part.mimeType ?? "image/jpeg",
          data: part.data,
        },
      });
      continue;
    }

    if (
      part.type === "input_image" &&
      part.source &&
      typeof part.source === "object" &&
      typeof (part.source as { type?: unknown }).type === "string"
    ) {
      parts.push({
        type: "input_image",
        source: part.source as
          | { type: "url"; url: string }
          | { type: "base64"; media_type: string; data: string },
      });
    }
  }
  return parts;
}

function isReplayableReasoningType(value: unknown): value is "reasoning" | `reasoning.${string}` {
  return typeof value === "string" && (value === "reasoning" || value.startsWith("reasoning."));
}

function toReplayableReasoningId(value: unknown): string | null {
  const id = toNonEmptyString(value);
  return id && id.startsWith("rs_") ? id : null;
}

function toReasoningSignature(value: unknown): ReplayableReasoningSignature | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { type?: unknown; id?: unknown };
  if (!isReplayableReasoningType(record.type)) {
    return null;
  }
  const reasoningId = toReplayableReasoningId(record.id);
  return {
    type: record.type,
    ...(reasoningId ? { id: reasoningId } : {}),
  };
}

function parseReasoningItem(value: unknown): ReplayableReasoningItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as {
    type?: unknown;
    id?: unknown;
    content?: unknown;
    encrypted_content?: unknown;
    summary?: unknown;
  };
  if (!isReplayableReasoningType(record.type)) {
    return null;
  }
  const reasoningId = toReplayableReasoningId(record.id);
  return {
    type: "reasoning",
    ...(reasoningId ? { id: reasoningId } : {}),
    ...(typeof record.content === "string" ? { content: record.content } : {}),
    ...(typeof record.encrypted_content === "string"
      ? { encrypted_content: record.encrypted_content }
      : {}),
    ...(typeof record.summary === "string" ? { summary: record.summary } : {}),
  };
}

function parseThinkingSignature(value: unknown): ReplayableReasoningItem | null {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    const signature = toReasoningSignature(JSON.parse(value));
    return signature ? parseReasoningItem(signature) : null;
  } catch {
    return null;
  }
}

function decodeToolCallReplayId(value: unknown): ToolCallReplayId | null {
  const raw = toNonEmptyString(value);
  if (!raw) {
    return null;
  }
  const [callId, itemId] = raw.split("|", 2);
  return {
    callId,
    ...(itemId ? { itemId } : {}),
  };
}

export function planTurnInput(params: {
  context: Context;
  model: ReplayModelInfo;
  previousResponseId: string | null;
  lastContextLength: number;
}): PlannedTurnInput {
  if (params.previousResponseId && params.lastContextLength > 0) {
    const newMessages = params.context.messages.slice(params.lastContextLength);
    // 有任何新消息（用户输入或 toolResult），都使用增量模式
    if (newMessages.length > 0) {
      return {
        mode: "incremental_tool_results",
        previousResponseId: params.previousResponseId,
        inputItems: convertMessagesToInputItems(newMessages, params.model),
      };
    }
    return {
      mode: "full_context_restart",
      inputItems: convertMessagesToInputItems(params.context.messages, params.model),
    };
  }

  return {
    mode: "full_context_initial",
    inputItems: convertMessagesToInputItems(params.context.messages, params.model),
  };
}

export function convertMessagesToInputItems(
  messages: Message[],
  modelOverride?: ReplayModelInfo,
): InputItem[] {
  const items: InputItem[] = [];

  for (const msg of messages) {
    const m = msg as AnyMessage & {
      phase?: unknown;
      toolCallId?: unknown;
      toolUseId?: unknown;
    };

    if (m.role === "user") {
      const parts = contentToOpenAIParts(m.content, modelOverride);
      if (parts.length === 0) {
        continue;
      }
      items.push({
        type: "message",
        role: "user",
        content:
          parts.length === 1 && parts[0]?.type === "input_text"
            ? (parts[0] as { type: "input_text"; text: string }).text
            : parts,
      });
      continue;
    }

    if (m.role === "assistant") {
      const content = m.content;
      if (Array.isArray(content)) {
        const textParts: string[] = [];

        for (const block of content as Array<{
          type?: string;
          text?: string;
          textSignature?: unknown;
          id?: unknown;
          name?: unknown;
          arguments?: unknown;
          thinkingSignature?: unknown;
        }>) {
          if (block.type === "text" && typeof block.text === "string") {
            textParts.push(block.text);
            continue;
          }

          if (block.type === "thinking") {
            const reasoningItem = parseThinkingSignature(block.thinkingSignature);
            if (reasoningItem) {
              items.push(reasoningItem);
            }
            continue;
          }

          if (block.type !== "toolCall") {
            continue;
          }

          const replayId = decodeToolCallReplayId(block.id);
          const toolName = toNonEmptyString(block.name);
          if (!replayId || !toolName) {
            continue;
          }
          items.push({
            type: "function_call",
            ...(replayId.itemId ? { id: replayId.itemId } : {}),
            call_id: replayId.callId,
            name: toolName,
            arguments:
              typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
          });
        }

        if (textParts.length > 0) {
          items.push({
            type: "message",
            role: "assistant",
            content: textParts.join(""),
          });
        }
        continue;
      }

      const text = contentToText(content);
      if (!text) {
        continue;
      }
      items.push({
        type: "message",
        role: "assistant",
        content: text,
      });
      continue;
    }

    if (m.role !== "toolResult") {
      continue;
    }

    const toolCallId = toNonEmptyString(m.toolCallId) ?? toNonEmptyString(m.toolUseId);
    if (!toolCallId) {
      continue;
    }
    const replayId = decodeToolCallReplayId(toolCallId);
    if (!replayId) {
      continue;
    }
    const parts = Array.isArray(m.content) ? contentToOpenAIParts(m.content, modelOverride) : [];
    const textOutput = contentToText(m.content);
    const imageParts = parts.filter((part) => part.type === "input_image");
    items.push({
      type: "function_call_output",
      call_id: replayId.callId,
      output: textOutput || (imageParts.length > 0 ? "(see attached image)" : ""),
    });
    if (imageParts.length > 0) {
      items.push({
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Attached image(s) from tool result:" },
          ...imageParts,
        ],
      });
    }
  }

  return items;
}
