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

import type { Span } from "@opentelemetry/api";
import { InvocationMetricsRecorder } from "./metrics.js";
import type { LLMInvocation } from "./types.js";
import type {
  EmbeddingInvocation,
  ExecuteToolInvocation,
  InvokeAgentInvocation,
  CreateAgentInvocation,
  RetrievalInvocation,
  RerankInvocation,
  EntryInvocation,
  ReactStepInvocation,
} from "./extended-types.js";
import type { MemoryInvocation } from "./memory/memory-types.js";

type AnyInvocation =
  | LLMInvocation
  | EmbeddingInvocation
  | ExecuteToolInvocation
  | InvokeAgentInvocation
  | CreateAgentInvocation
  | RetrievalInvocation
  | RerankInvocation
  | MemoryInvocation
  | EntryInvocation
  | ReactStepInvocation;

function isLLMInvocation(inv: AnyInvocation): inv is LLMInvocation {
  return "operationName" in inv && "inputMessages" in inv;
}

export class ExtendedInvocationMetricsRecorder extends InvocationMetricsRecorder {
  recordExtended(
    span: Span | null | undefined,
    invocation: AnyInvocation,
    options?: { errorType?: string },
  ): void {
    if (isLLMInvocation(invocation)) {
      this.record(span, invocation, options);
      return;
    }
    // TODO: Implement extended metrics for other invocation types
  }
}
