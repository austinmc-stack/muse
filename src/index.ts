import util from 'util';
import makeDir from 'make-dir';
import path from 'path';
import container from './inversify.config.js';
import {TYPES} from './types.js';
import Bot from './bot.js';
import Config from './services/config.js';
import FileCacheProvider from './services/file-cache.js';
import prepareYtDlp from './utils/prepare-yt-dlp.js';

// Without this, a non-Error rejection anywhere below (e.g. from discord.js internals)
// crashes with node's generic "#<Object>" message and no way to see the real cause.
process.on('unhandledRejection', reason => {
  console.error('Fatal: unhandled rejection during startup:', util.inspect(reason, {depth: 5}));
  process.exit(1);
});

const bot = container.get<Bot>(TYPES.Bot);

const startBot = async () => {
  // Create data directories if necessary
  const config = container.get<Config>(TYPES.Config);

  await makeDir(config.DATA_DIR);
  await makeDir(config.CACHE_DIR);
  await makeDir(path.join(config.CACHE_DIR, 'tmp'));

  await container.get<FileCacheProvider>(TYPES.FileCache).cleanup();
  await prepareYtDlp(config);

  await bot.register();
};

export {startBot};
