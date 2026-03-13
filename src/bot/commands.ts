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
    command: "chat",
    description: "Start a new AI conversation",
  },
  {
    command: "cancel",
    description: "Cancel the current task",
  },
];
