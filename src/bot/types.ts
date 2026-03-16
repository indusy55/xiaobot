import type { FileApiFlavor, FileFlavor } from "@grammyjs/files";
import type { Api, Bot, Context, RawApi } from "grammy";

export type AppContext = FileFlavor<Context>;
export type AppApi = FileApiFlavor<Api<RawApi>>;
export type AppBot = Bot<AppContext, AppApi>;
