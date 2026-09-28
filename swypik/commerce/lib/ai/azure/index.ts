/** Azure AI Foundry — singurul furnizor AI (chat, Whisper, embeddings, Content Safety). */
export * from "./config";
export { AzureAIError, type AzureErrorCode } from "./http";
export { chatText, chatJson, type ChatMessage, type ChatOptions, type ChatResult } from "./chat";
export { transcribeAudio, type Transcript, type TranscriptSegment } from "./transcribe";
export { createEmbedding } from "./embeddings";
export {
  analyzeText,
  analyzeImage,
  safetyVerdict,
  SAFETY_CATEGORIES,
  type SafetyScores,
  type SafetyVerdict,
  type SafetyDecision,
} from "./content-safety";
export type { TokenUsage } from "./usage";
