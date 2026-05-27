// Dump a single state snapshot and the current frame, then quit.
// Useful for sanity-checking what the engine exposes.
await bot.log(JSON.stringify(await bot.getState(), null, 2));
// The screenshot lands in the collapsible image panel on the right.
const shot = await bot.screenshot();
await bot.logImage(shot, "inspect: current frame");
