import {inject, injectable} from 'inversify';
import {TYPES} from '../types.js';
import Player from '../services/player.js';
import FileCacheProvider from '../services/file-cache.js';
import DjRecommender from '../services/dj-recommender.js';
import WrappedTracker from '../services/wrapped-tracker.js';
import MessageCleanup from '../services/message-cleanup.js';
import type YoutubeAPI from '../services/youtube-api.js';

@injectable()
export default class {
  private readonly guildPlayers: Map<string, Player>;
  private readonly fileCache: FileCacheProvider;
  private readonly youtubeAPI: YoutubeAPI;

  constructor(
    @inject(TYPES.FileCache) fileCache: FileCacheProvider,
    @inject(TYPES.Services.YoutubeAPI) youtubeAPI: YoutubeAPI,
    @inject(TYPES.Services.DjRecommender) private readonly djRecommender: DjRecommender,
    @inject(TYPES.Services.WrappedTracker) private readonly wrappedTracker: WrappedTracker,
    @inject(TYPES.Services.MessageCleanup) private readonly messageCleanup: MessageCleanup,
  ) {
    this.guildPlayers = new Map();
    this.fileCache = fileCache;
    this.youtubeAPI = youtubeAPI;
  }

  get(guildId: string): Player {
    let player = this.guildPlayers.get(guildId);

    if (!player) {
      player = new Player(
        this.fileCache,
        guildId,
        async song => this.youtubeAPI.findAudioFallback(song),
        this.djRecommender,
        this.wrappedTracker,
        this.messageCleanup,
      );

      this.guildPlayers.set(guildId, player);
    }

    return player;
  }
}
