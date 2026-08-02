import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createTtsProvider } from "./tts-provider.js";

const config = loadConfig();
const app = createApp({
  ...config,
  ttsProvider: createTtsProvider(config),
});

app.listen(config.port, config.host, () => {
  console.log(
    `Fish Study Reader ${config.mockMode ? "mock" : "provider"} server listening on ` +
      `http://${config.host}:${config.port}`,
  );
});
