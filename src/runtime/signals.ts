/**
 * Maps OS signals (Ctrl-C / SIGTERM) onto an `AbortController` so a run unwinds
 * cleanly: in-flight engine calls abort, loops/dags return `aborted`, and the
 * exit summary still prints. A second Ctrl-C force-exits in case a backend
 * ignores the abort.
 */

export interface AbortHandle {
  controller: AbortController;
  dispose: () => void;
}

export function installSignalHandlers(): AbortHandle {
  const controller = new AbortController();
  let hits = 0;

  const onSignal = () => {
    hits += 1;
    if (hits === 1) controller.abort();
    else process.exit(130);
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return {
    controller,
    dispose() {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    },
  };
}
