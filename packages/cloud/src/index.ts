export { DITFA_MODELS_URL, DITFA_WEB_URL, DitfaApiError, HttpClient, type HttpOptions } from "./http";
export {
  IDE_SCHEMES,
  PASTE_SCHEME,
  beginSignIn,
  challengeFor,
  exchangeSignInCode,
  parseCallback,
  parsePastedCode,
  randomToken,
  signInScheme,
  type ClientInfo,
  type CloudLinks,
  type CloudUser,
  type IdeKey,
  type IdeSignIn,
  type PendingSignIn,
} from "./auth";
export {
  canUseDitfaModels,
  formatBytes,
  planLabel,
  usageFraction,
  type CloudProfile,
  type MediaMeter,
  type PlanId,
} from "./account";
export {
  capabilitiesOf,
  contextWindowTokens,
  fetchApiModels,
  isLocked,
  requiredPlanFor,
  type ApiModel,
  type CloudCatalog,
  type CloudModel,
  type ModelCapabilities,
  type ModelType,
} from "./models";
export {
  CAPTURE_SAMPLE_RATE,
  SentenceChunker,
  VoiceSocket,
  encodeWav,
  voiceSocketUrl,
  type VoiceConfig,
  type VoiceSocketHandlers,
  type WebSocketFactory,
  type WebSocketLike,
} from "./voice";
export { readSse, streamChat, type LlmEndpoint, type LlmMessage, type LlmRequest, type LlmResult } from "./llm";
export { DitfaCloud, type DitfaCloudOptions } from "./client";
export { OPENAI_VOICES, ditfaSpeech, openAiSpeech, type SpeechBackend, type SpokenAudio } from "./speech";
