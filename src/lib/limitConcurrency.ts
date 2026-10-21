/** A scheduler that runs at most `max` jobs at a time, starting them in the order they were queued. */
export function limitConcurrency(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];

  const next = () => {
    if (active >= max) return;
    const start = waiting.shift();
    if (!start) return;
    active++;
    start();
  };

  return function run<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      waiting.push(() => {
        new Promise<T>((settle) => settle(job()))
          .then(resolve, reject)
          .finally(() => {
            active--;
            next();
          });
      });
      next();
    });
  };
}
