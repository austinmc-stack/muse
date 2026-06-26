// src/services/dj-tts.ts
//
// Renders DJ commentary text to an audio file, with local disk caching so
// repeated phrasing doesn't re-bill the TTS provider. Returns a file path
// that Player can hand to createAudioResource.
//
// Now that I've seen the real config.ts, this injects Config properly
// instead of reading process.env directly. DATA_DIR already exists on
// Config — ELEVENLABS_API_KEY and DEFAULT_TTS_VOICE_ID do not, so you'll
// need to add them. See the bottom of this file for the exact lines to
// add to config.ts.

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
    // Reuse Muse's existing DATA_DIR convention rather than a new mount.
    this.cacheDir = join(this.config.DATA_DIR, 'dj-tts-cache');
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, {recursive: true});
    }
  }

  /** Renders text to a cached mp3 file, returning its path. */
  async renderToFile(text: string, voiceId?: string | null): Promise<string> {
    const key = crypto.createHash('sha256').update(`${voiceId ?? 'default'}:${text}`).digest('hex');
    const filePath = join(this.cacheDir, `${key}.mp3`);

    if (existsSync(filePath)) {
      return filePath;
    }

    const voice = voiceId ?? this.config.DEFAULT_TTS_VOICE_ID;
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream`, {
      method: 'POST',
      headers: {
        'xi-api-key': this.config.ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_turbo_v2_5',
        voice_settings: {stability: 0.4, similarity_boost: 0.8},
      }),
    });

    if (!res.ok || !res.body) {
      throw new Error(`TTS request failed: ${res.status} ${res.statusText}`);
    }

    const {Readable} = await import('stream');
    const nodeStream = Readable.fromWeb(res.body as any);
    await pipeline(nodeStream, createWriteStream(filePath));

    return filePath;
  }
}
