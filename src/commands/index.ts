import {SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder} from '@discordjs/builders';
import {AutocompleteInteraction, ButtonInteraction, ChatInputCommandInteraction} from 'discord.js';

export default interface Command {
  readonly slashCommand: Partial<SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder> & Pick<SlashCommandBuilder, 'toJSON'>;
  readonly handledButtonIds?: readonly string[];
  readonly requiresVC?: boolean | ((interaction: ChatInputCommandInteraction) => boolean);
  /** Marks this as a player/queue-control command, so its reply is a cleanup candidate under the ALL_BOT_MESSAGES setting. */
  readonly isPlayerCommand?: boolean;
  execute: (interaction: ChatInputCommandInteraction) => Promise<void>;
  handleButtonInteraction?: (interaction: ButtonInteraction) => Promise<void>;
  handleAutocompleteInteraction?: (interaction: AutocompleteInteraction) => Promise<void>;
}
