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

import type { Meter, Histogram } from "@opentelemetry/api";
import {
  GEN_AI_CLIENT_OPERATION_DURATION,
  GEN_AI_CLIENT_TOKEN_USAGE,
} from "./semconv/gen-ai-extended-attributes.js";

const DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
];

const TOKEN_USAGE_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304,
  16777216, 67108864,
];

export function createDurationHistogram(meter: Meter): Histogram {
  return meter.createHistogram(GEN_AI_CLIENT_OPERATION_DURATION, {
    description: "Duration of GenAI client operation",
    unit: "s",
    advice: { explicitBucketBoundaries: DURATION_BUCKETS },
  });
}

export function createTokenHistogram(meter: Meter): Histogram {
  return meter.createHistogram(GEN_AI_CLIENT_TOKEN_USAGE, {
    description:
      "Number of input and output tokens used by GenAI clients",
    unit: "{token}",
    advice: { explicitBucketBoundaries: TOKEN_USAGE_BUCKETS },
  });
}
