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

import type { Histogram, Meter, Span } from "@opentelemetry/api";
import { trace, context } from "@opentelemetry/api";
import {
  createDurationHistogram,
  createTokenHistogram,
} from "./instruments.js";
import type { LLMInvocation } from "./types.js";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_PROVIDER_NAME,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_TOKEN_TYPE,
  GenAiOperationNameValues,
  GenAiTokenTypeValues,
  SERVER_ADDRESS,
  SERVER_PORT,
  ERROR_TYPE,
} from "./semconv/gen-ai-extended-attributes.js";

export class InvocationMetricsRecorder {
  private _durationHistogram: Histogram;
  private _tokenHistogram: Histogram;

  constructor(meter: Meter) {
    this._durationHistogram = createDurationHistogram(meter);
    this._tokenHistogram = createTokenHistogram(meter);
  }

  record(
    span: Span | null | undefined,
    invocation: LLMInvocation,
    options?: { errorType?: string },
  ): void {
    if (!span) return;

    const tokenCounts: Array<{ count: number; type: string }> = [];
    if (invocation.inputTokens != null) {
      tokenCounts.push({
        count: invocation.inputTokens,
        type: GenAiTokenTypeValues.INPUT,
      });
    }
    if (invocation.outputTokens != null) {
      tokenCounts.push({
        count: invocation.outputTokens,
        type: GenAiTokenTypeValues.OUTPUT,
      });
    }

    const attributes: Record<string, string | number> = {
      [GEN_AI_OPERATION_NAME]: GenAiOperationNameValues.CHAT,
    };
    if (invocation.requestModel) {
      attributes[GEN_AI_REQUEST_MODEL] = invocation.requestModel;
    }
    if (invocation.provider) {
      attributes[GEN_AI_PROVIDER_NAME] = invocation.provider;
    }
    if (invocation.responseModelName) {
      attributes[GEN_AI_RESPONSE_MODEL] = invocation.responseModelName;
    }
    if (invocation.serverAddress) {
      attributes[SERVER_ADDRESS] = invocation.serverAddress;
    }
    if (invocation.serverPort != null) {
      attributes[SERVER_PORT] = invocation.serverPort;
    }
    if (invocation.metricAttributes) {
      Object.assign(attributes, invocation.metricAttributes);
    }

    let durationSeconds: number | null = null;
    if (invocation.monotonicStartS != null) {
      durationSeconds = Math.max(
        performance.now() / 1000 - invocation.monotonicStartS,
        0.0,
      );
    }

    const spanContext = trace.setSpan(context.active(), span);

    if (options?.errorType) {
      attributes[ERROR_TYPE] = options.errorType;
    }

    if (durationSeconds != null) {
      this._durationHistogram.record(durationSeconds, attributes, spanContext);
    }

    for (const { count, type } of tokenCounts) {
      this._tokenHistogram.record(
        count,
        { ...attributes, [GEN_AI_TOKEN_TYPE]: type },
        spanContext,
      );
    }
  }
}
