import { render } from "@nativedesktop/react";
import { App } from "./App.tsx";
import { openHistory, recentVisits } from "./lib/history.ts";
import { normalize, session } from "./lib/session.ts";

const restored = normalize(await session.load());
session.set(restored);

await openHistory();
const initialHistory = await recentVisits();

await render(
  <App
    initialHistory={initialHistory}
    initialWidth={restored.windowWidth}
    initialHeight={restored.windowHeight}
  />,
);
