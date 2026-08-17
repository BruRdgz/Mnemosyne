import { normalizeProviderUsage } from '../observability/metrics-recorder.js';
import { EXTRACTION_JSON_MODE_INSTRUCTION } from '../extraction/request-compiler.js';

const PROVIDER_GATES = new Map();
const VOIDAI_EXTRACTION_REASONING_EFFORT = 'none';

function isVoidAiCustom(context) {
  const settings = context?.chatCompletionSettings;
  if (context?.mainApi !== 'openai' || settings?.chat_completion_source !== 'custom') return false;
  try {
    const hostname = new URL(settings.custom_url).hostname.toLowerCase();
    return hostname === 'voidai.app' || hostname.endsWith('.voidai.app');
  } catch {
    return false;
  }
}

function providerKey(context, profileId) {
  if (profileId) return `profile:${profileId}`;
  const settings = context?.chatCompletionSettings;
  if (!context?.mainApi && !settings?.chat_completion_source) return null;
  return `active:${settings?.chat_completion_source ?? context?.mainApi ?? 'unknown'}:${settings?.custom_url ?? ''}:${settings?.custom_model ?? ''}`;
}

async function waitForProviderSlot(key, cooldownMs, signal) {
  if (!key || !Number.isFinite(cooldownMs) || cooldownMs <= 0) return;
  const now = Date.now();
  const slot = Math.max(now, PROVIDER_GATES.get(key) ?? now);
  PROVIDER_GATES.set(key, slot + cooldownMs);
  const delay = slot - now;
  if (delay <= 0) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, delay);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
  });
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function jsonObjectInstruction(systemPrompt, jsonSchema) {
  const schema = jsonSchema?.promptValue ?? jsonSchema?.value ?? jsonSchema;
  return `${String(systemPrompt ?? '')}\n\n${EXTRACTION_JSON_MODE_INSTRUCTION}\nThe object must satisfy this JSON Schema; validation is performed locally:\n${JSON.stringify(schema)}`;
}

function withReasoningEffort(existing, effort) {
  const base = String(existing ?? '').trim();
  const replacement = `reasoning_effort: ${effort}`;
  if (!base) return replacement;
  const lines = base.split(/\r?\n/);
  let replaced = false;
  const normalized = lines.map(line => {
    if (/^\s*reasoning_effort\s*:/i.test(line)) {
      replaced = true;
      return replacement;
    }
    return line;
  });
  return replaced ? normalized.join('\n') : `${base}\n${replacement}`;
}

function jsonObjectIncludeBody(existing) {
  const base = withReasoningEffort(existing, VOIDAI_EXTRACTION_REASONING_EFFORT);
  return `${base ? `${base}\n` : ''}response_format:\n  type: json_object`;
}

function textFallbackIncludeBody(existing) {
  // Do not add a stop sequence here.  The fallback protocol is line/tag based
  // and must be allowed to continue from [SYNOPSIS] into [EVENTS],
  // [OBSERVATIONS], or another continuity section.  A stop on "\\n[" cuts the
  // completion at the first next tag and silently turns a semantic fallback
  // into a synopsis-only response.
  return withReasoningEffort(existing, VOIDAI_EXTRACTION_REASONING_EFFORT);
}

function classifyProviderError(error) {
  if (error?.code) return error;
  const message = String(error?.message ?? '');
  if (/payment required|insufficient (?:funds|credit)|credits? exhausted|quota/i.test(message)) error.code = 'quota';
  else if (/too many requests/i.test(message)) error.code = 'rate_limit';
  else if (/forbidden|access denied/i.test(message)) error.code = 'access_denied';
  else if (/service unavailable/i.test(message)) error.code = 'unavailable';
  return error;
}

export class MemoryGenerationAdapter {
  #getContext;
  #metrics;
  #logger;
  #cooldownMs;
  #temperature;
  #topP;

  constructor({ getContext, metrics, logger = null, cooldownMs = 0, temperature = 0.2, topP = 1 }) {
    this.#getContext = getContext;
    this.#metrics = metrics;
    this.#logger = logger;
    this.#cooldownMs = Math.max(0, Number(cooldownMs) || 0);
    this.#temperature = Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2;
    this.#topP = Number.isFinite(Number(topP)) ? Number(topP) : 1;
  }

  async generate({ systemPrompt, prompt, jsonSchema = null, profileId = null, maxTokens = 6_000, signal } = {}) {
    const context = this.#getContext();
    const voidAiJsonMode = !profileId && Boolean(jsonSchema) && isVoidAiCustom(context);
    const voidAiTextMode = !profileId && !jsonSchema && isVoidAiCustom(context);
    const route = profileId ? 'connection_profile' : (voidAiJsonMode ? 'voidai_json_object' : (voidAiTextMode ? 'voidai_text' : 'generate_raw'));
    this.#logger?.info?.('memory_request_started', {
      route,
      profileId: profileId ?? null,
      maxOutputTokens: maxTokens,
      cooldownMs: this.#cooldownMs,
    });
    const finish = this.#metrics?.measure('memory_generation', { route });
    try {
      await waitForProviderSlot(providerKey(context, profileId), this.#cooldownMs, signal);
      let response;
      if (profileId) {
        const service = context.ConnectionManagerRequestService;
        if (!service?.sendRequest) throw new Error('Connection profile generation is unavailable');
        response = await abortable(service.sendRequest(
          profileId,
          [
            { role: 'system', content: String(systemPrompt ?? '') },
            { role: 'user', content: String(prompt ?? '') },
          ],
          maxTokens,
          { extractData: true, includePreset: true, stream: false, signal },
        ), signal);
      } else if (voidAiJsonMode) {
        const service = context.ChatCompletionService;
        const settings = context.chatCompletionSettings;
        if (!service?.processRequest) throw new Error('VoidAI JSON-mode generation is unavailable');
        response = await abortable(service.processRequest({
          stream: false,
          messages: [
            { role: 'system', content: jsonObjectInstruction(systemPrompt, jsonSchema) },
            { role: 'user', content: String(prompt ?? '') },
          ],
          max_tokens: maxTokens,
          model: context.getChatCompletionModel?.(settings) ?? settings.custom_model,
          temperature: this.#temperature,
          top_p: this.#topP,
          reasoning_effort: VOIDAI_EXTRACTION_REASONING_EFFORT,
          frequency_penalty: Number(settings.freq_pen_openai),
          presence_penalty: Number(settings.pres_pen_openai),
          chat_completion_source: settings.chat_completion_source,
          custom_url: settings.custom_url,
          custom_include_body: jsonObjectIncludeBody(settings.custom_include_body),
          custom_exclude_body: settings.custom_exclude_body,
          custom_include_headers: settings.custom_include_headers,
          custom_prompt_post_processing: settings.custom_prompt_post_processing,
        // Preserve the provider envelope so finish_reason, request id, model,
        // and usage survive the SillyTavern boundary. Without this, a length
        // stop is indistinguishable from malformed JSON on resume.
        }, { presetName: undefined }, false, signal), signal);
      } else if (voidAiTextMode) {
        // generateRaw cleans the provider envelope and throws the opaque
        // "No message generated" error when the response shape is empty. A
        // direct ChatCompletionService call keeps the raw envelope, request
        // id, finish reason, and provider error details available for retry
        // diagnostics while retaining the same VoidAI route.
        const service = context.ChatCompletionService;
        const settings = context.chatCompletionSettings;
        if (!service?.processRequest) throw new Error('VoidAI text generation is unavailable');
        response = await abortable(service.processRequest({
          stream: false,
          messages: [
            { role: 'system', content: String(systemPrompt ?? '') },
            { role: 'user', content: String(prompt ?? '') },
          ],
          max_tokens: maxTokens,
          model: context.getChatCompletionModel?.(settings) ?? settings.custom_model,
          temperature: this.#temperature,
          top_p: this.#topP,
          reasoning_effort: VOIDAI_EXTRACTION_REASONING_EFFORT,
          frequency_penalty: Number(settings.freq_pen_openai),
          presence_penalty: Number(settings.pres_pen_openai),
          chat_completion_source: settings.chat_completion_source,
          custom_url: settings.custom_url,
          // Fallback requests are deliberately text-only.  GLM can spend the
          // whole completion budget on hidden reasoning unless reasoning is
          // disabled.  No stop sequence is imposed: tagged semantic sections
          // must be able to follow the synopsis.
          custom_include_body: textFallbackIncludeBody(settings.custom_include_body),
          custom_exclude_body: settings.custom_exclude_body,
          custom_include_headers: settings.custom_include_headers,
          custom_prompt_post_processing: settings.custom_prompt_post_processing,
        }, { presetName: undefined }, false, signal), signal);
      } else {
        if (typeof context.generateRaw !== 'function') throw new Error('generateRaw is unavailable');
        response = await abortable(context.generateRaw({
          systemPrompt: String(systemPrompt ?? ''),
          prompt: String(prompt ?? ''),
          responseLength: maxTokens,
          jsonSchema,
          signal,
          temperature: this.#temperature,
          topP: this.#topP,
        }), signal);
      }
      const responseContent = response?.content
        ?? response?.choices?.[0]?.message?.content
        ?? response?.choices?.[0]?.text
        ?? response?.response;
      const text = typeof response === 'string'
        ? response
        : typeof responseContent === 'string'
          ? responseContent
          : responseContent && typeof responseContent === 'object'
            ? JSON.stringify(responseContent)
            : String(responseContent ?? '');
      const usage = normalizeProviderUsage(response?.usage);
      const requestId = response?.id ?? response?.request_id ?? null;
      const model = response?.model ?? context.getChatCompletionModel?.(context.chatCompletionSettings) ?? context.chatCompletionSettings?.custom_model ?? null;
      const finishReason = response?.choices?.[0]?.finish_reason ?? response?.finish_reason ?? null;
      finish?.({ status: text ? 'success' : 'empty', outputCharacters: text.length, ...usage });
      this.#logger?.info?.('memory_request_finished', {
        route,
        status: text ? 'success' : 'empty',
        requestId,
        model,
        finishReason,
        outputCharacters: text.length,
        ...usage,
      });
      return {
        text,
        usage,
        raw: response,
        requestId,
        model,
        finishReason,
        route,
        normalizationHints: {
          allowOmittedEmptyFamilies: voidAiJsonMode || voidAiTextMode,
          allowProviderVocabularyVariants: voidAiJsonMode || voidAiTextMode || /^glm-5(?:\.\d+)?$/i.test(String(model ?? '')),
        },
        executionMode: 'live',
      };
    } catch (error) {
      finish?.({ status: signal?.aborted ? 'cancelled' : 'failed', errorName: error?.name ?? 'Error' });
      this.#logger?.warn?.('memory_request_failed', {
        route,
        status: signal?.aborted ? 'cancelled' : 'failed',
        errorName: error?.name ?? 'Error',
        errorCode: error?.code ?? null,
      });
      throw classifyProviderError(error);
    }
  }
}
