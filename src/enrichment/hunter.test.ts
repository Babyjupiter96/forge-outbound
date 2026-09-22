import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findDecisionMaker, HunterUnavailableError } from "./hunter.js";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("findDecisionMaker", () => {
  it("throws HunterUnavailableError on a 429 — this is NOT a negative result", async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, { errors: [{ code: 429 }] }));
    await expect(findDecisionMaker("example.com", "Example Co")).rejects.toBeInstanceOf(HunterUnavailableError);
  });

  it("carries the HTTP status on the thrown error", async () => {
    fetchMock.mockResolvedValue(jsonResponse(429, {}));
    await expect(findDecisionMaker("example.com", "Example Co")).rejects.toMatchObject({ status: 429 });
  });

  it("throws HunterUnavailableError on 401/403/5xx too, not just 429", async () => {
    for (const status of [401, 403, 500, 503]) {
      fetchMock.mockResolvedValue(jsonResponse(status, {}));
      await expect(findDecisionMaker("example.com", "Example Co")).rejects.toBeInstanceOf(HunterUnavailableError);
    }
  });

  it("throws HunterUnavailableError on a network failure, not a silent null", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(findDecisionMaker("example.com", "Example Co")).rejects.toBeInstanceOf(HunterUnavailableError);
  });

  it("returns null — not a throw — for a genuine 200 OK with no personal emails", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { data: { emails: [] } }));
    await expect(findDecisionMaker("example.com", "Example Co")).resolves.toBeNull();
  });

  it("returns null when every email is generic (info@/support@), never a decision-maker guess", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: { emails: [{ value: "info@example.com", type: "generic", confidence: 90, position: null, linkedin: null, verification: null }] },
      }),
    );
    await expect(findDecisionMaker("example.com", "Example Co")).resolves.toBeNull();
  });

  it("picks the highest-priority title among several personal emails", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: {
          emails: [
            { value: "staff@x.com", type: "personal", confidence: 70, first_name: "A", last_name: "B", position: "Technician", linkedin: null, verification: null },
            { value: "owner@x.com", type: "personal", confidence: 90, first_name: "C", last_name: "D", position: "Owner", linkedin: null, verification: { status: "valid" } },
          ],
        },
      }),
    );
    const result = await findDecisionMaker("x.com", "X Co");
    expect(result?.email).toBe("owner@x.com");
    expect(result?.verified).toBe(true);
  });

  it("requires both a valid verification status AND confidence >= 80 to mark verified", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: {
          emails: [
            { value: "owner@x.com", type: "personal", confidence: 70, first_name: "C", last_name: "D", position: "Owner", linkedin: null, verification: { status: "valid" } },
          ],
        },
      }),
    );
    const result = await findDecisionMaker("x.com", "X Co");
    expect(result?.verified).toBe(false);
  });
});
