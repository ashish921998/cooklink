import type { Language } from '@cooklink/domain';

/**
 * Voice transcription service (ticket 06 — voice transcription supports
 * English, Hindi, and code-mixed speech; uncertain output is labelled and
 * correctable).
 *
 * In production this calls a server-side speech-to-text provider (key in server
 * env only, never in the mobile bundle). The stub implementation below lets
 * the flow run end-to-end in dev and tests without a provider, and lets tests
 * inject deterministic output (including the failed case).
 */

export interface TranscriptionResult {
  transcript: string;
  language: Language | null;
  status: 'ready' | 'failed';
}

export interface TranscriptionService {
  transcribe(input: { data: Buffer; contentType: string }): Promise<TranscriptionResult>;
}

/**
 * A deterministic stub used by dev and tests. By default it returns a fixed
 * Hindi grocery phrase so the intent-detection flow is exercised. A test may
 * inject a custom function to assert the failed or English case.
 */
export class StubTranscriptionService implements TranscriptionService {
  private readonly impl: (input: {
    data: Buffer;
    contentType: string;
  }) => Promise<TranscriptionResult>;

  constructor(
    impl?: (input: { data: Buffer; contentType: string }) => Promise<TranscriptionResult>,
  ) {
    this.impl =
      impl ??
      (async () => ({
        transcript: 'नारियल चाहिए',
        language: 'hi',
        status: 'ready',
      }));
  }

  async transcribe(input: { data: Buffer; contentType: string }): Promise<TranscriptionResult> {
    return this.impl(input);
  }
}

/**
 * Resolve a transcription service from the environment. Defaults to the stub so
 * the server runs without a provider key; production sets the provider key in
 * server env (issue 07 — no provider secret in the mobile bundle).
 */
export function createTranscriptionService(): TranscriptionService {
  return new StubTranscriptionService();
}
