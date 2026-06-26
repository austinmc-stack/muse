// Renders DJ commentary text to an audio file using a self-hosted Kokoro
// TTS server (https://github.com/hexgrad/Kokoro-82M, Apache 2.0), with
// local disk caching so repeated phrasing doesn't re-run inference.
//
// Kokoro exposes an OpenAI-compatible /v1/audio/speech endpoint, so this
// is a plain fetch against your own container — no API key, no per-char
// billing. Run it via Docker, e.g.:
//
//   docker run -d --name kokoro -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
//
// (CPU image is fine for this use case — a couple sentences of commentary
// every few tracks is nowhere near enough volume to need a GPU. Swap to
// the -gpu image tag later if you ever want faster cold-starts.)

import {inject, injectable} from 'inversify';
import {createWriteStream, existsSync, mkdirSync} from 'fs';
import {join} from 'path';
import {pipeline} from 'stream/promises';
import crypto from 'crypto';
import {TYPES} from '../types.js';
import Config from './config.js';

@injectable()
export default class DjTts {
  private readonly cacheDir: string;

  constructor(@inject(TYPES.Config) private readonly config: Config) {
    this.cacheDir = join(this.config.DATA_DIR, 'dj-tts-cache');
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, {recursive: true});
    }
  }

  /** Renders text to a cached mp3 file via the self-hosted Kokoro server, returning the path. */
  async renderToFile(text: string, voiceId?: string | null): Promise<string> {
    const voice = voiceId ?? this.config.KOKORO_VOICE;
    const key = crypto.createHash('sha256').update(`${voice}:${text}`).digest('hex');
    const filePath = join(this.cacheDir, `${key}.mp3`);

    if (existsSync(filePath)) {
      return filePath;
    }

    const res = await fetch(`${this.config.KOKORO_BASE_URL}/v1/audio/speech`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        model: 'kokoro',
        input: text,
        voice,
        response_format: 'mp3',
        speed: 1.0,
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`Kokoro TTS request failed: ${res.status} ${res.statusText}`);
    }

    const {Readable} = await import('stream');
    const nodeStream = Readable.fromWeb(res.body as any);
    await pipeline(nodeStream, createWriteStream(filePath));

    return filePath;
  }
}
