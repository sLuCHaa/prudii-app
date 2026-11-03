import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackerRecorder, createTrackerScanRunner, scanStoredBodies, toRecord } from "./trackerScan";
import type { TrackerInfo } from "./sanitize";
import type { StoredBody, TrackerRecord } from "../types";

const mailchimp = (n: number): TrackerInfo => ({ domain: "us5.list-manage.com", type: "tracking_domain", src: `https://us5.list-manage.com/t/${n}.gif` });
const pixel: TrackerInfo = { domain: "open.halde-shop.example", type: "pixel", src: "https://open.halde-shop.example/o.gif" };

describe("toRecord", () => {
  it("groups trackers by kind and domain with their company", () => {
    const record = toRecord("m1", [mailchimp(1), mailchimp(2), pixel]);
    expect(record.mail_id).toBe("m1");
    expect(record.hits).toHaveLength(2);
    expect(record.hits).toEqual(
      expect.arrayContaining([
        { kind: "tracking_domain", domain: "us5.list-manage.com", company: "Mailchimp", count: 2 },
        { kind: "pixel", domain: "open.halde-shop.example", company: null, count: 1 },
      ]),
    );
  });
});

describe("createTrackerRecorder", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends each mail once, batched", async () => {
    const send = vi.fn(async (_records: TrackerRecord[]) => 2);
    const recorder = createTrackerRecorder(send, 2000);
    recorder.add("a", [pixel], false);
    recorder.add("a", [pixel], false);
    recorder.add("b", [], false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].map((r) => r.mail_id)).toEqual(["a", "b"]);
  });

  it("skips a mail shown with its tracked images", async () => {
    const send = vi.fn(async (_records: TrackerRecord[]) => 0);
    const recorder = createTrackerRecorder(send, 2000);
    recorder.add("a", [pixel], true);
    await recorder.flush();
    expect(send).not.toHaveBeenCalled();
  });
});

describe("scanStoredBodies", () => {
  const bodies = (n: number, from = 0): StoredBody[] => Array.from({ length: n }, (_, i) => ({ mail_id: `m${from + i}`, html: "<p>Hallo</p>" }));

  it("scans stored bodies in batches until nothing is left", async () => {
    const pages = [bodies(25), bodies(3, 25), []];
    const detect = vi.fn(() => [pixel]);
    const send = vi.fn(async (records: TrackerRecord[]) => records.length);
    const scanned = await scanStoredBodies({ list: async () => pages.shift() ?? [], detect, send, pause: async () => {} }, 25);
    expect(scanned).toBe(28);
    expect(detect).toHaveBeenCalledTimes(28);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("yields to the interface while sanitizing a batch", async () => {
    let clock = 0;
    const pages = [bodies(3), []];
    const pause = vi.fn(async () => {});
    await scanStoredBodies(
      { list: async () => pages.shift() ?? [], detect: () => { clock += 10; return []; }, send: async (r) => r.length, pause, now: () => clock },
      25,
    );
    expect(pause.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("stops when a batch counts nothing new", async () => {
    const list = vi.fn(async () => bodies(2));
    const scanned = await scanStoredBodies({ list, detect: () => [], send: async () => 0, pause: async () => {} }, 25);
    expect(scanned).toBe(2);
    expect(list).toHaveBeenCalledTimes(1);
  });
});

describe("createTrackerScanRunner", () => {
  it("runs one scan at a time", async () => {
    let release: (n: number) => void = () => {};
    const fetchBodies = vi.fn(() => new Promise<number>((resolve) => { release = resolve; }));
    const run = createTrackerScanRunner({ scanStored: async () => 1, fetchBodies });
    const first = run();
    const second = run();
    await vi.waitFor(() => expect(fetchBodies).toHaveBeenCalledTimes(1));
    release(0);
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    const third = run();
    await vi.waitFor(() => expect(fetchBodies).toHaveBeenCalledTimes(2));
    release(0);
    await third;
  });

  it("scans stored bodies before fetching", async () => {
    const calls: string[] = [];
    const runner = (loaded: number) =>
      createTrackerScanRunner({
        scanStored: async () => { calls.push("scan"); return 2; },
        fetchBodies: async () => { calls.push("fetch"); return loaded; },
      });
    expect(await runner(3)()).toBe(4);
    expect(calls).toEqual(["scan", "fetch", "scan"]);
    calls.length = 0;
    expect(await runner(0)()).toBe(2);
    expect(calls).toEqual(["scan", "fetch"]);
  });

  it("keeps going when fetching fails", async () => {
    const run = createTrackerScanRunner({ scanStored: async () => 5, fetchBodies: async () => { throw new Error("offline"); } });
    expect(await run()).toBe(5);
  });
});
