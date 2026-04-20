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

export const GEN_AI_MEMORY_OPERATION = "gen_ai.memory.operation";
export const GEN_AI_MEMORY_USER_ID = "gen_ai.memory.user_id";
export const GEN_AI_MEMORY_AGENT_ID = "gen_ai.memory.agent_id";
export const GEN_AI_MEMORY_RUN_ID = "gen_ai.memory.run_id";
export const GEN_AI_MEMORY_APP_ID = "gen_ai.memory.app_id";
export const GEN_AI_MEMORY_ID = "gen_ai.memory.id";
export const GEN_AI_MEMORY_LIMIT = "gen_ai.memory.limit";
export const GEN_AI_MEMORY_PAGE = "gen_ai.memory.page";
export const GEN_AI_MEMORY_PAGE_SIZE = "gen_ai.memory.page_size";
export const GEN_AI_MEMORY_TOP_K = "gen_ai.memory.top_k";
export const GEN_AI_MEMORY_MEMORY_TYPE = "gen_ai.memory.memory_type";
export const GEN_AI_MEMORY_THRESHOLD = "gen_ai.memory.threshold";
export const GEN_AI_MEMORY_RERANK = "gen_ai.memory.rerank";
export const GEN_AI_MEMORY_INPUT_MESSAGES = "gen_ai.memory.input.messages";
export const GEN_AI_MEMORY_OUTPUT_MESSAGES = "gen_ai.memory.output.messages";

export enum GenAiMemoryOperationValues {
  ADD = "add",
  SEARCH = "search",
  UPDATE = "update",
  BATCH_UPDATE = "batch_update",
  GET = "get",
  GET_ALL = "get_all",
  HISTORY = "history",
  DELETE = "delete",
  BATCH_DELETE = "batch_delete",
  DELETE_ALL = "delete_all",
}
