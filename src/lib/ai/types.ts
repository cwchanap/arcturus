export type AiProvider = 'openai' | 'gemini';

export interface AiSettings {
	provider: AiProvider;
	model: string;
	apiKey: string;
}

export interface AiGenerateRequest {
	system?: string;
	prompt: string;
	temperature?: number;
	maxOutputTokens?: number;
	timeoutMs?: number;
}

export type AiErrorCode = 'timeout' | 'provider-error' | 'invalid-response';

export type AiResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			code: AiErrorCode;
			message: string;
			status?: number;
	  };
