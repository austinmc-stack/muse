import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import Player from '../services/player.js';
import FileCacheProvider from '../services/file-cache.js';
import DjTts from '../services/dj-tts.js';
import DjCommentary from '../services/dj-commentary.js';
import DjRecommender from '../services/dj-recommender.js';
 
@injectable()
export default class {
  private readonly guildPlayers: Map<string, Player>;
  private readonly fileCache: FileCacheProvider;
 
  constructor(
    @inject(TYPES.FileCache) fileCache: FileCacheProvider,
    @inject(TYPES.Services.DjTts) private readonly djTts: DjTts,
    @inject(TYPES.Services.DjCommentary) private readonly djCommentary: DjCommentary,
    @inject(TYPES.Services.DjRecommender) private readonly djRecommender: DjRecommender,
  ) {
    this.guildPlayers = new Map();
    this.fileCache = fileCache;
  }
 
  get(guildId: string): Player {
    let player = this.guildPlayers.get(guildId);
 
    if (!player) {
      player = new Player(this.fileCache, guildId, this.djTts, this.djCommentary, this.djRecommender);
 
      this.guildPlayers.set(guildId, player);
    }
 
    return player;
  }
}
