import { describe, it, expect } from "vitest";
import { keepRowsLeaving } from "./mailListSync";

// keepRowsLeaving only ever reads `id`, so the rows stay minimal.
const mail = (id: string) => ({ id });

const ids = (list: { id: string }[]) => list.map((m) => m.id);

describe("keepRowsLeaving", () => {
  it("takes the fetched list as-is when nothing is animating out", () => {
    const fetched = [mail("a"), mail("b")];
    expect(keepRowsLeaving([mail("a"), mail("b"), mail("c")], fetched, [])).toBe(fetched);
  });

  it("holds a single outgoing row in place while its sweep runs", () => {
    const current = [mail("a"), mail("b"), mail("c")];
    const fetched = [mail("a"), mail("c")];
    expect(ids(keepRowsLeaving(current, fetched, ["b"]))).toEqual(["a", "b", "c"]);
  });

  it("holds a whole selection in its original order", () => {
    const current = [mail("a"), mail("b"), mail("c"), mail("d")];
    const fetched = [mail("a"), mail("d")];
    expect(ids(keepRowsLeaving(current, fetched, ["b", "c"]))).toEqual(["a", "b", "c", "d"]);
  });

  it("holds rows that are not next to each other", () => {
    const current = [mail("a"), mail("b"), mail("c"), mail("d"), mail("e")];
    const fetched = [mail("b"), mail("d")];
    expect(ids(keepRowsLeaving(current, fetched, ["a", "c", "e"]))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("holds the leading rows when the selection starts at the top", () => {
    const current = [mail("a"), mail("b"), mail("c")];
    const fetched = [mail("c")];
    expect(ids(keepRowsLeaving(current, fetched, ["a", "b"]))).toEqual(["a", "b", "c"]);
  });

  it("survives every visible row leaving at once", () => {
    const current = [mail("a"), mail("b"), mail("c")];
    expect(ids(keepRowsLeaving(current, [], ["a", "b", "c"]))).toEqual(["a", "b", "c"]);
  });

  it("anchors to the row above rather than to a bare index", () => {
    // A mail arriving in the same refetch shifts every index down; anchoring by
    // index would drop the outgoing row a slot just as it starts to slide away.
    const current = [mail("a"), mail("b")];
    const fetched = [mail("new"), mail("a")];
    expect(ids(keepRowsLeaving(current, fetched, ["b"]))).toEqual(["new", "a", "b"]);
  });

  it("clamps an index past the end of the fetched list", () => {
    const current = [mail("a"), mail("b"), mail("c")];
    const fetched = [mail("a")];
    expect(ids(keepRowsLeaving(current, fetched, ["c"]))).toEqual(["a", "c"]);
  });

  it("defers to the fetched list when the rows are still in it", () => {
    // The delete failed or has not landed yet — nothing to preserve.
    const fetched = [mail("a"), mail("b")];
    expect(keepRowsLeaving([mail("a"), mail("b")], fetched, ["b"])).toBe(fetched);
  });

  it("defers to the fetched list when the row is already gone locally", () => {
    const fetched = [mail("a")];
    expect(keepRowsLeaving([mail("a")], fetched, ["ghost"])).toBe(fetched);
  });

  it("ignores ids that already landed while others are still leaving", () => {
    const current = [mail("a"), mail("b"), mail("c")];
    const fetched = [mail("a"), mail("b")];
    expect(ids(keepRowsLeaving(current, fetched, ["b", "c"]))).toEqual(["a", "b", "c"]);
  });
});
