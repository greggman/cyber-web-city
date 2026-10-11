// Keep the screen on while the demo plays (it's meant to be watched for a
// while), with the Screen Wake Lock API. Browsers drop the lock when the
// page is hidden and some only grant it after a tap, so it's re-requested
// when the page becomes visible again and on user gestures.

/** Returns whether the screen is being kept on now (for tests). */
export function keepScreenOn(): () => boolean {
  let lock: WakeLockSentinel | null = null;
  let pending = false;
  const request = async () => {
    if (lock || pending || document.visibilityState !== 'visible') return;
    if (!('wakeLock' in navigator)) return;
    pending = true;
    try {
      const l = await navigator.wakeLock.request('screen');
      lock = l;
      l.addEventListener('release', () => {
        if (lock === l) lock = null;
      });
    } catch {
      // Refused (not yet tapped, battery saver): try again on a gesture.
    }
    pending = false;
  };
  void request();
  for (const g of ['pointerdown', 'touchend', 'click', 'keydown']) {
    window.addEventListener(g, () => void request(), {capture: true});
  }
  document.addEventListener('visibilitychange', () => void request());
  return () => lock !== null;
}
