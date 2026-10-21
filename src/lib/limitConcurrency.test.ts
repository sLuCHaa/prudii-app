import { describe, expect, it } from "vitest";
import { limitConcurrency } from "./limitConcurrency";

function gate<T>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("limitConcurrency", () => {
  it("never runs more than two at once and starts them in queue order", async () => {
    const run = limitConcurrency(2);
    const gates = Array.from({ length: 5 }, () => gate<number>());
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const results = gates.map((g, i) =>
      run(async () => {
        started.push(i);
        peak = Math.max(peak, ++running);
        const value = await g.promise;
        running--;
        return value;
      }),
    );

    await settle();
    expect(started).toEqual([0, 1]);
    gates[1].open(1);
    await settle();
    expect(started).toEqual([0, 1, 2]);
    gates.forEach((g, i) => g.open(i));
    expect(await Promise.all(results)).toEqual([0, 1, 2, 3, 4]);
    expect(started).toEqual([0, 1, 2, 3, 4]);
    expect(peak).toBe(2);
  });

  it("keeps going after a job fails", async () => {
    const run = limitConcurrency(1);
    const rejected = run(() => Promise.reject(new Error("broken")));
    const thrown = run(() => {
      throw new Error("sync");
    });
    const next = run(() => Promise.resolve("ok"));
    await expect(rejected).rejects.toThrow("broken");
    await expect(thrown).rejects.toThrow("sync");
    await expect(next).resolves.toBe("ok");
  });
});
