// Walk forward and shoot enemies in the centre of the FOV.
for (let i = 0; i < 40; i++) {
  const s = await bot.getState();
  await bot.log("tick", i, "screen:", s.screen, "hp:", s.hud.health,
    "enemies:", s.enemies_visible.length);

  // Press enter on menu / intermission / finale to advance.
  if (s.screen !== "playing") {
    await bot.press("enter");
    await bot.sleep(150);
    continue;
  }

  const centred = s.enemies_visible.find((e) => e.bearing === "center");
  if (centred) {
    await bot.log("firing at", centred.type);
    await bot.press("fire", 200);
  }
  await bot.press("up", 250);
  await bot.sleep(50);
}

return "combat run complete";
