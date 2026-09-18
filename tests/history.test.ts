import 'reflect-metadata';
import {describe, expect, it, vi} from 'vitest';

const mocks = vi.hoisted(() => ({
  playHistoryFindMany: vi.fn(),
}));

vi.mock('../src/utils/db.js', () => ({
  prisma: {
    playHistory: {findMany: mocks.playHistoryFindMany},
  },
}));

import History from '../src/commands/history.js';

const makeTrack = (n: number) => ({
  artist: `Artist ${n}`,
  title: `Song ${n}`,
  youtubeId: `video-${n}`,
});

const makeInteraction = (awaitResult: unknown) => {
  const editReply = vi.fn().mockResolvedValue(undefined);
  const message = {
    awaitMessageComponent: vi.fn().mockImplementation(async () => {
      if (awaitResult instanceof Error) {
        throw awaitResult;
      }

      return awaitResult;
    }),
  };

  return {
    editReply,
    guild: {id: 'guild-1'},
    reply: vi.fn().mockResolvedValue(message),
    user: {id: 'user-1'},
  };
};

describe('/history', () => {
  it('replies ephemerally when the guild has no play history', async () => {
    mocks.playHistoryFindMany.mockResolvedValue([]);
    const addQueryToQueue = {addToQueue: vi.fn()};
    const command = new History(addQueryToQueue as never);
    const interaction = makeInteraction(undefined);

    await command.execute(interaction as never);

    expect(interaction.reply).toHaveBeenCalledWith({content: 'no play history yet for this server', ephemeral: true});
    expect(addQueryToQueue.addToQueue).not.toHaveBeenCalled();
  });

  it('queues the selected track by watch URL through the shared add-to-queue path', async () => {
    const tracks = [makeTrack(1), makeTrack(2)];
    mocks.playHistoryFindMany.mockResolvedValue(tracks);
    const addQueryToQueue = {addToQueue: vi.fn().mockResolvedValue(undefined)};
    const command = new History(addQueryToQueue as never);
    const selection = {values: ['video-2']};
    const interaction = makeInteraction(selection);

    await command.execute(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith({content: 'picked **Song 2**.', components: []});
    expect(addQueryToQueue.addToQueue).toHaveBeenCalledWith(expect.objectContaining({
      query: 'https://www.youtube.com/watch?v=video-2',
      interaction: selection,
    }));
  });

  it('reports a timeout and never queues anything if nothing is selected in time', async () => {
    mocks.playHistoryFindMany.mockResolvedValue([makeTrack(1)]);
    const addQueryToQueue = {addToQueue: vi.fn()};
    const command = new History(addQueryToQueue as never);
    const interaction = makeInteraction(new Error('time'));

    await command.execute(interaction as never);

    expect(interaction.editReply).toHaveBeenCalledWith({content: 'timed out waiting for a selection.', components: []});
    expect(addQueryToQueue.addToQueue).not.toHaveBeenCalled();
  });
});
