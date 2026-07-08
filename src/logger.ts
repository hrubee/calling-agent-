import pino from "pino";
import { config } from "./config";

const isProd = config.isProd;

export const logger = pino({
  level: config.logLevel,
  ...(isProd
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss.l", ignore: "pid,hostname" },
        },
      }),
  redact: {
    paths: ["req.headers.authorization", "req.headers.cookie", "*.apiKey", "*.api_key", "*.password"],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
