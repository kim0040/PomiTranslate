/**
 * One clock for everything that shows elapsed time, so the sidebar and the run screen can never
 * disagree by a tick. It only runs while something holds it.
 */
export const clock = $state({ now: Date.now() });

let holders = 0;
let timer: ReturnType<typeof setInterval> | undefined;

/** Start (or share) the clock. Returns the release function; call it from an effect cleanup. */
export function holdClock(): () => void {
  clock.now = Date.now();
  if (holders++ === 0) timer = setInterval(() => { clock.now = Date.now(); }, 1000);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}
