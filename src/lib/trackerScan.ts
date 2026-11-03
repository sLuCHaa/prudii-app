import { sanitizeEmailHtml, trackerCompany, type TrackerInfo } from "./sanitize";
import { fetchBulkBodies, listUnscannedBodies, recordMailTrackers } from "./tauri";
import type { StoredBody, TrackerHit, TrackerRecord } from "../types";

export function toRecord(mailId: string, trackers: TrackerInfo[]): TrackerRecord {
  const hits = new Map<string, TrackerHit>();
  for (const tracker of trackers) {
    const key = `${tracker.type}|${tracker.domain}`;
    const hit = hits.get(key);
    if (hit) hit.count += 1;
    else hits.set(key, { kind: tracker.type, domain: tracker.domain, company: trackerCompany(tracker.domain), count: 1 });
  }
  return { mail_id: mailId, hits: [...hits.values()] };
}

export function createTrackerRecorder(send: (records: TrackerRecord[]) => Promise<unknown>, delayMs = 2000) {
  const seen = new Set<string>();
  let pending: TrackerRecord[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    try {
      await send(batch);
    } catch {
      // Unsent mails may be counted the next time they are shown.
      for (const record of batch) seen.delete(record.mail_id);
    }
  };

  return {
    // A view with its tracked images let through only sees part of the trackers; its first view already counted.
    add(mailId: string, trackers: TrackerInfo[], shownTracked: boolean) {
      if (shownTracked || seen.has(mailId)) return;
      seen.add(mailId);
      pending.push(toRecord(mailId, trackers));
      if (!timer) timer = setTimeout(() => void flush(), delayMs);
    },
    flush,
  };
}

export const displayTrackerRecorder = createTrackerRecorder((records) => recordMailTrackers(records));

interface ScanDeps {
  list: (limit: number) => Promise<StoredBody[]>;
  detect: (html: string) => TrackerInfo[];
  send: (records: TrackerRecord[]) => Promise<number>;
  pause?: () => Promise<void>;
  now?: () => number;
}

// Sanitizing a newsletter takes milliseconds; a whole batch in one go would make the window stutter.
const SLICE_MS = 8;

export async function scanStoredBodies(deps: ScanDeps, batch = 25): Promise<number> {
  const pause = deps.pause ?? (() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  const now = deps.now ?? (() => performance.now());
  let scanned = 0;
  for (;;) {
    const bodies = await deps.list(batch);
    if (bodies.length === 0) return scanned;
    const records: TrackerRecord[] = [];
    let sliceStart = now();
    for (const body of bodies) {
      records.push(toRecord(body.mail_id, deps.detect(body.html)));
      if (now() - sliceStart > SLICE_MS) {
        await pause();
        sliceStart = now();
      }
    }
    const counted = await deps.send(records);
    scanned += bodies.length;
    // Nothing new counted means the backend keeps returning the same mails; stop instead of looping.
    if (counted === 0) return scanned;
    await pause();
  }
}

export async function runTrackerScan(): Promise<number> {
  await fetchBulkBodies().catch(() => 0);
  return scanStoredBodies({
    list: listUnscannedBodies,
    detect: (html) => sanitizeEmailHtml(html).trackers,
    send: recordMailTrackers,
  });
}
