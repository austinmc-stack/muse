import {ChatInputCommandInteraction, GuildMember, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, PermissionFlagsBits} from 'discord.js';
import {inject, injectable} from 'inversify';
import shuffle from 'array-shuffle';
import {TYPES} from '../types.js';
import GetSongs from '../services/get-songs.js';
import {MediaSource, SongMetadata, STATUS} from './player.js';
import PlayerManager from '../managers/player.js';
import {buildPlayingMessageEmbed} from '../utils/build-embed.js';
import {getMemberVoiceChannel, getMostPopularVoiceChannel} from '../utils/channels.js';
import {getGuildSettings} from '../utils/get-guild-settings.js';
import {SponsorBlock} from 'sponsorblock-api';
import Config from './config.js';
import KeyValueCacheProvider from './key-value-cache.js';
import {ONE_HOUR_IN_SECONDS} from '../utils/constants.js';

@injectable()
export default class AddQueryToQueue {
  private readonly sponsorBlock?: SponsorBlock;
  private sponsorBlockDisabledUntil?: Date;
  private readonly sponsorBlockTimeoutDelay;
  private readonly cache: KeyValueCacheProvider;

  constructor(@inject(TYPES.Services.GetSongs) private readonly getSongs: GetSongs,
    @inject(TYPES.Managers.Player) private readonly playerManager: PlayerManager,
    @inject(TYPES.Config) private readonly config: Config,
    @inject(TYPES.KeyValueCache) cache: KeyValueCacheProvider) {
    this.sponsorBlockTimeoutDelay = config.SPONSORBLOCK_TIMEOUT;
    this.sponsorBlock = config.ENABLE_SPONSORBLOCK
      ? new SponsorBlock('muse-sb-integration')
      : undefined;
    this.cache = cache;
  }

  public async addToQueue({
    query,
    addToFrontOfQueue,
    shuffleAdditions,
    shouldSplitChapters,
    skipCurrentTrack,
    interaction,
  }: {
    query: string;
    addToFrontOfQueue: boolean;
    shuffleAdditions: boolean;
    shouldSplitChapters: boolean;
    skipCurrentTrack: boolean;
    interaction: ChatInputCommandInteraction;
  }): Promise<void> {
    const guildId = interaction.guild!.id;
    const player = this.playerManager.get(guildId);
    const wasPlayingSong = player.getCurrent() !== null;

    const [targetVoiceChannel] = getMemberVoiceChannel(interaction.member as GuildMember) ?? getMostPopularVoiceChannel(interaction.guild!);

    const settings = await getGuildSettings(guildId);
    const {playlistLimit, queueAddResponseEphemeral} = settings;

    // Check if the voice channel is full BEFORE deferring the reply, since
    // we may need to send a button-based confirmation message instead, and
    // deferred replies can't be replaced with a button interaction cleanly.
    if (
      targetVoiceChannel
      && targetVoiceChannel.userLimit > 0
      && targetVoiceChannel.members.size >= targetVoiceChannel.userLimit
      && player.voiceConnection === null // only matters if we need to JOIN
    ) {
      const botMember = interaction.guild!.members.me;
      const canManage = botMember?.permissionsIn(targetVoiceChannel).has(PermissionFlagsBits.ManageChannels) ?? false;

      if (!canManage) {
        // Can't expand the limit -- just tell the user clearly
        await interaction.reply({
          content: `the voice channel is full (${targetVoiceChannel.members.size}/${targetVoiceChannel.userLimit}) and I don't have permission to expand it. Give me the Manage Channels permission if you'd like me to handle this automatically.`,
          ephemeral: true,
        });
        return;
      }

      // Ask for confirmation before overriding the channel limit
      const originalLimit = targetVoiceChannel.userLimit;

      const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('vc-join-yes')
          .setLabel('yes, let the bot in')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('vc-join-no')
          .setLabel('no thanks')
          .setStyle(ButtonStyle.Secondary),
      );

      const confirmMsg = await interaction.reply({
        content: `the voice channel is full (${targetVoiceChannel.members.size}/${originalLimit}). should i temporarily expand it to join? i'll restore the limit once i'm in.`,
        components: [confirmRow],
        fetchReply: true,
      });

      let confirmed = false;
      try {
        const buttonInteraction = await confirmMsg.awaitMessageComponent({
          componentType: ComponentType.Button,
          filter: i => i.user.id === interaction.user.id && ['vc-join-yes', 'vc-join-no'].includes(i.customId),
          time: 30_000, // 30 second window to respond
        });

        if (buttonInteraction.customId === 'vc-join-no') {
          await buttonInteraction.update({content: 'no worries, not joining.', components: []});
          return;
        }

        confirmed = true;
        await buttonInteraction.update({content: 'expanding channel limit and joining...', components: []});
      } catch {
        // Timed out waiting for button response
        await interaction.editReply({content: 'timed out waiting for a response — not joining.', components: []});
        return;
      }

      if (confirmed) {
        try {
          // Temporarily set to unlimited (0) so the bot can join
          await targetVoiceChannel.edit({userLimit: 0});

          // Small delay to let Discord propagate the channel update before
          // the voice state join is attempted -- without this, Discord
          // sometimes still rejects the join against the old cached limit.
          await new Promise(resolve => setTimeout(resolve, 500));

          // Proceed with the normal flow below -- the channel is no longer full.
          // Restore original limit after joining (in a finally block so it
          // always restores even if something else throws after this point).
          try {
            await this.continueAddToQueue({
              query,
              addToFrontOfQueue,
              shuffleAdditions,
              shouldSplitChapters,
              skipCurrentTrack,
              interaction,
              player,
              wasPlayingSong,
              targetVoiceChannel,
              playlistLimit,
              queueAddResponseEphemeral,
              alreadyReplied: true,
            });
          } finally {
            // Restore the original limit whether joining succeeded or not.
            // Small delay to let the bot actually finish joining before
            // the limit goes back -- otherwise it hits the same full-channel
            // wall immediately after restoring.
            await new Promise(resolve => setTimeout(resolve, 1000));
            await targetVoiceChannel.edit({userLimit: originalLimit});
          }
        } catch (error) {
          await interaction.editReply({content: `couldn't expand the channel limit: ${(error as Error).message}`, components: []});
        }

        return;
      }
    }

    // Normal path -- channel is not full or bot is already connected
    await interaction.deferReply({ephemeral: queueAddResponseEphemeral});
    await this.continueAddToQueue({
      query,
      addToFrontOfQueue,
      shuffleAdditions,
      shouldSplitChapters,
      skipCurrentTrack,
      interaction,
      player,
      wasPlayingSong,
      targetVoiceChannel,
      playlistLimit,
      queueAddResponseEphemeral,
      alreadyReplied: false,
    });
  }

  // The original addToQueue logic, extracted so it can be called from both
  // the normal path and the full-channel confirmation path without duplication.
  private async continueAddToQueue({
    query,
    addToFrontOfQueue,
    shuffleAdditions,
    shouldSplitChapters,
    skipCurrentTrack,
    interaction,
    player,
    wasPlayingSong,
    targetVoiceChannel,
    playlistLimit,
    queueAddResponseEphemeral,
    alreadyReplied,
  }: {
    query: string;
    addToFrontOfQueue: boolean;
    shuffleAdditions: boolean;
    shouldSplitChapters: boolean;
    skipCurrentTrack: boolean;
    interaction: ChatInputCommandInteraction;
    player: any;
    wasPlayingSong: boolean;
    targetVoiceChannel: any;
    playlistLimit: number;
    queueAddResponseEphemeral: boolean;
    alreadyReplied: boolean;
  }): Promise<void> {
    if (!alreadyReplied) {
      await interaction.deferReply({ephemeral: queueAddResponseEphemeral});
    }

    let [newSongs, extraMsg] = await this.getSongs.getSongs(query, playlistLimit, shouldSplitChapters);

    if (newSongs.length === 0) {
      throw new Error('no songs found');
    }

    if (shuffleAdditions) {
      newSongs = shuffle(newSongs);
    }

    if (this.config.ENABLE_SPONSORBLOCK) {
      newSongs = await Promise.all(newSongs.map(this.skipNonMusicSegments.bind(this)));
    }

    newSongs.forEach(song => {
      player.add({
        ...song,
        addedInChannelId: interaction.channel!.id,
        requestedBy: interaction.member!.user.id,
      }, {immediate: addToFrontOfQueue ?? false});
    });

    const firstSong = newSongs[0];

    let statusMsg = '';

    if (player.voiceConnection === null) {
      await player.connect(targetVoiceChannel);
      await player.play();

      if (wasPlayingSong) {
        statusMsg = 'resuming playback';
      }

      await interaction.editReply({
        embeds: [buildPlayingMessageEmbed(player)],
      });
    } else if (player.status === STATUS.IDLE) {
      await player.play();
    }

    if (skipCurrentTrack) {
      try {
        await player.forward(1);
      } catch (_: unknown) {
        throw new Error('no song to skip to');
      }
    }

    if (statusMsg !== '') {
      if (extraMsg === '') {
        extraMsg = statusMsg;
      } else {
        extraMsg = `${statusMsg}, ${extraMsg}`;
      }
    }

    if (extraMsg !== '') {
      extraMsg = ` (${extraMsg})`;
    }

    if (newSongs.length === 1) {
      await interaction.editReply(`u betcha, **${firstSong.title}** added to the${addToFrontOfQueue ? ' front of the' : ''} queue${skipCurrentTrack ? 'and current track skipped' : ''}${extraMsg}`);
    } else {
      await interaction.editReply(`u betcha, **${firstSong.title}** and ${newSongs.length - 1} other songs were added to the queue${skipCurrentTrack ? 'and current track skipped' : ''}${extraMsg}`);
    }
  }

  private async skipNonMusicSegments(song: SongMetadata) {
    if (!this.sponsorBlock
          || (this.sponsorBlockDisabledUntil && new Date() < this.sponsorBlockDisabledUntil)
          || song.source !== MediaSource.Youtube
          || !song.url) {
      return song;
    }

    try {
      const segments = await this.cache.wrap(
        async () => this.sponsorBlock?.getSegments(song.url, ['music_offtopic']),
        {
          key: song.url,
          expiresIn: ONE_HOUR_IN_SECONDS,
        },
      ) ?? [];
      const skipSegments = segments
        .sort((a, b) => a.startTime - b.startTime)
        .reduce((acc: Array<{startTime: number; endTime: number}>, {startTime, endTime}) => {
          const previousSegment = acc[acc.length - 1];
          if (previousSegment && previousSegment.endTime > startTime) {
            acc[acc.length - 1].endTime = endTime;
          } else {
            acc.push({startTime, endTime});
          }

          return acc;
        }, []);

      const intro = skipSegments[0];
      const outro = skipSegments.at(-1);
      if (outro && outro?.endTime >= song.length - 2) {
        song.length -= outro.endTime - outro.startTime;
      }

      if (intro?.startTime <= 2) {
        song.offset = Math.floor(intro.endTime);
        song.length -= song.offset;
      }

      return song;
    } catch (e) {
      if (!(e instanceof Error)) {
        console.error('Unexpected event occurred while fetching skip segments : ', e);
        return song;
      }

      if (!e.message.includes('404')) {
        console.warn(`Could not fetch skip segments for "${song.url}" :`, e);
      }

      if (e.message.includes('504')) {
        this.sponsorBlockDisabledUntil = new Date(new Date().getTime() + (this.sponsorBlockTimeoutDelay * 60_000));
      }

      return song;
    }
  }
}
