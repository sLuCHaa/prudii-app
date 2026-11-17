import { describe, it, expect } from "vitest";
import { undoSendStep } from "./undoSendStep";
import type { UndoSendState } from "../stores/appStore";
import type { SendMailRequest } from "../types";

const pending = (subject: string): UndoSendState => ({
  active: true,
  request: { account_id: "acc1", subject } as SendMailRequest,
  composeMode: "reply",
  composeMail: null,
  composeSnapshot: null,
});

describe("undoSendStep", () => {
  it("sends the first mail right away when a second one starts its countdown", () => {
    const first = pending("Re: Angebot");
    const second = pending("Re: Termin");
    expect(undoSendStep(first, first.request, second)).toEqual({ flush: first, countdown: "start" });
  });

  it("starts a plain countdown when nothing else is waiting", () => {
    const first = pending("Re: Angebot");
    expect(undoSendStep(null, null, first)).toEqual({ flush: null, countdown: "start" });
  });

  it("starts the next countdown without resending a mail already handed over", () => {
    const first = pending("Re: Angebot");
    const second = pending("Re: Termin");
    expect(undoSendStep(null, first.request, second)).toEqual({ flush: null, countdown: "start" });
  });

  it("resumes the running countdown of the same mail instead of restarting it", () => {
    const first = pending("Re: Angebot");
    expect(undoSendStep(first, first.request, first)).toEqual({ flush: null, countdown: "resume" });
  });

  it("never counts down again for a mail that is already on its way", () => {
    const first = pending("Re: Angebot");
    expect(undoSendStep(null, first.request, first)).toEqual({ flush: null, countdown: "none" });
  });

  it("does nothing while no send is pending", () => {
    const idle: UndoSendState = { active: false, request: null, composeMode: "new", composeMail: null, composeSnapshot: null };
    expect(undoSendStep(null, null, idle)).toEqual({ flush: null, countdown: "none" });
  });
});
