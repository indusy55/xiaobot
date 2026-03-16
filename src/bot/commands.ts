import type { BotCommand } from "grammy/types";

export const botCommands: BotCommand[] = [
  {
    command: "ping",
    description: "Check if the bot is alive",
  },
  {
    command: "ai_ping",
    description: "Check if the AI reply is working",
  },
  {
    command: "cancel",
    description: "Cancel the current task",
  },
  {
    command: "add_setstickerset",
    description: "Add a sticker set for the bot",
  },
];
