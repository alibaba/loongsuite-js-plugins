// Copyright The OpenTelemetry Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { diag } from "@opentelemetry/api";
import { ContentCapturingMode } from "./types.js";
import {
  OTEL_SEMCONV_STABILITY_OPT_IN,
  OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT,
  OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT,
} from "./environment-variables.js";

const GEN_AI_EXPERIMENTAL = "gen_ai_latest_experimental";

export function isExperimentalMode(): boolean {
  const optIn = process.env[OTEL_SEMCONV_STABILITY_OPT_IN];
  if (!optIn) return false;
  return optIn
    .split(",")
    .some((v) => v.trim().toLowerCase() === GEN_AI_EXPERIMENTAL);
}

export function getContentCapturingMode(): ContentCapturingMode {
  if (!isExperimentalMode()) {
    return ContentCapturingMode.NO_CONTENT;
  }

  const envvar =
    process.env[OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT];
  if (!envvar) {
    return ContentCapturingMode.NO_CONTENT;
  }

  const upper = envvar.toUpperCase().trim();
  const mapping: Record<string, ContentCapturingMode> = {
    NO_CONTENT: ContentCapturingMode.NO_CONTENT,
    SPAN_ONLY: ContentCapturingMode.SPAN_ONLY,
    EVENT_ONLY: ContentCapturingMode.EVENT_ONLY,
    SPAN_AND_EVENT: ContentCapturingMode.SPAN_AND_EVENT,
  };

  if (upper in mapping) {
    return mapping[upper];
  }

  diag.warn(
    `${envvar} is not a valid option for \`${OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT}\`. ` +
      `Must be one of ${Object.keys(mapping).join(", ")}. Defaulting to NO_CONTENT.`,
  );
  return ContentCapturingMode.NO_CONTENT;
}

export function shouldCaptureContentInSpan(): boolean {
  const mode = getContentCapturingMode();
  return (
    mode === ContentCapturingMode.SPAN_ONLY ||
    mode === ContentCapturingMode.SPAN_AND_EVENT
  );
}

export function shouldCaptureContentInEvent(): boolean {
  const mode = getContentCapturingMode();
  return (
    mode === ContentCapturingMode.EVENT_ONLY ||
    mode === ContentCapturingMode.SPAN_AND_EVENT
  );
}

export function shouldEmitEvent(): boolean {
  const envvar = process.env[OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT];
  if (envvar && envvar.trim()) {
    const lower = envvar.toLowerCase().trim();
    if (lower === "true") return true;
    if (lower === "false") return false;
    diag.warn(
      `${envvar} is not a valid option for \`${OTEL_INSTRUMENTATION_GENAI_EMIT_EVENT}\`. ` +
        `Must be one of true or false (case-insensitive). Defaulting based on content capturing mode.`,
    );
  }

  if (!isExperimentalMode()) {
    return false;
  }

  const contentMode = getContentCapturingMode();
  return (
    contentMode === ContentCapturingMode.EVENT_ONLY ||
    contentMode === ContentCapturingMode.SPAN_AND_EVENT
  );
}

function bufferToBase64(value: unknown): unknown {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Buffer.from(value).toString("base64");
  }
  return value;
}

function replacer(_key: string, value: unknown): unknown {
  return bufferToBase64(value);
}

export function genAiJsonDumps(obj: unknown): string {
  return JSON.stringify(obj, replacer);
}
