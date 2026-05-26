// A minimal codemode bot. The game is already past the menus when
// this code starts, so we can read state and press keys right away.
//
// API (all async, always 'await'):
//   await bot.getState()            // engine snapshot (hud, screen, ...)
//   await bot.press(key, holdMs?)   // key tap or hold
//   await bot.sleep(ms)             // pause between actions
//   await bot.log(...args)          // streamed live to the log pane

for (let i = 0; i < 10; i++) {
  const s = await bot.getState();
  await bot.log("tick", i, "screen:", s.screen, "hp:", s.hud.health);
  await bot.press("up", 250); // walk forward for 250ms
  await bot.sleep(50);
}

return "walked 10 steps";
