import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../types.js";

vi.mock("../enrichment/hunter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../enrichment/hunter.js")>();
  return { ...actual, findDecisionMaker: vi.fn() };
});

// A minimal stand-in for supabase-js's chainable query builder: every
// step is both chainable and awaitable, matching how the real client
// behaves (`await db.from(...).select(...).eq(...).limit(...)` works
// because each intermediate call is itself a thenable).
function makeDb(companiesByStatus: Record<string, Company[]>) {
  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];

  const db = {
    from: vi.fn((table: string) => ({
      select: () => ({
        eq: (_col: string, status: string) => ({
          limit: async () => ({ data: table === "companies" ? (companiesByStatus[status] ?? []) : [] }),
        }),
      }),
      update: (patch: Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          updates.push({ id, patch });
          return { data: null, error: null };
        },
      }),
      insert: async (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        return { data: null, error: null };
      },
    })),
  };
  return { db, updates, inserts };
}

vi.mock("../db.js", () => ({ get db() { return mockDb.db; } }));

let mockDb: ReturnType<typeof makeDb>;

const company = (id: string, domain = "example.com"): Company =>
  ({ id, domain, name: `Company ${id}`, status: "new" }) as Company;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enrichNewCompanies", () => {
  it("marks a company no_contact_found on a genuine negative result, and enriches it once", async () => {
    mockDb = makeDb({ new: [company("1")] });
    const { findDecisionMaker } = await import("../enrichment/hunter.js");
    vi.mocked(findDecisionMaker).mockResolvedValue(null);

    const { enrichNewCompanies } = await import("./runPipeline.js");
    const result = await enrichNewCompanies();

    expect(result).toEqual({ enriched: 0, deferred: 0 });
    expect(mockDb.updates).toEqual([{ id: "1", patch: expect.objectContaining({ status: "no_contact_found" }) }]);
  });

  it("creates a contact and marks the company enriching on a real hit", async () => {
    mockDb = makeDb({ new: [company("1")] });
    const { findDecisionMaker } = await import("../enrichment/hunter.js");
    vi.mocked(findDecisionMaker).mockResolvedValue({
      firstName: "Jane",
      lastName: "Doe",
      title: "Owner",
      email: "jane@example.com",
      linkedinUrl: null,
      confidenceScore: 0.9,
      verified: true,
    });

    const { enrichNewCompanies } = await import("./runPipeline.js");
    const result = await enrichNewCompanies();

    expect(result).toEqual({ enriched: 1, deferred: 0 });
    expect(mockDb.inserts).toEqual([{ table: "contacts", row: expect.objectContaining({ email: "jane@example.com" }) }]);
    expect(mockDb.updates).toEqual([{ id: "1", patch: { status: "enriching" } }]);
  });

  it(
    "the regression this exists to catch: a Hunter outage must NOT mark companies no_contact_found",
    async () => {
      mockDb = makeDb({ new: [company("1"), company("2"), company("3")] });
      const { findDecisionMaker, HunterUnavailableError } = await import("../enrichment/hunter.js");
      vi.mocked(findDecisionMaker).mockRejectedValue(new HunterUnavailableError(429, "quota exceeded"));

      const { enrichNewCompanies } = await import("./runPipeline.js");
      const result = await enrichNewCompanies();

      // Deferred, not dead — none of the three should have been written
      // to at all, so they stay 'new' and get retried on a future run.
      expect(result).toEqual({ enriched: 0, deferred: 3 });
      expect(mockDb.updates).toEqual([]);
      expect(mockDb.inserts).toEqual([]);
    },
  );

  it("stops calling Hunter for the rest of the run once one call is unavailable, to avoid burning the same failure repeatedly", async () => {
    mockDb = makeDb({ new: [company("1"), company("2"), company("3")] });
    const { findDecisionMaker, HunterUnavailableError } = await import("../enrichment/hunter.js");
    vi.mocked(findDecisionMaker).mockRejectedValue(new HunterUnavailableError(429, "quota exceeded"));

    const { enrichNewCompanies } = await import("./runPipeline.js");
    await enrichNewCompanies();

    expect(findDecisionMaker).toHaveBeenCalledTimes(1);
  });

  it("processes companies before the outage, then defers the rest once it hits", async () => {
    mockDb = makeDb({ new: [company("1"), company("2"), company("3")] });
    const { findDecisionMaker, HunterUnavailableError } = await import("../enrichment/hunter.js");
    vi.mocked(findDecisionMaker)
      .mockResolvedValueOnce(null) // company 1: genuine negative result, real answer
      .mockRejectedValueOnce(new HunterUnavailableError(429, "quota exceeded")); // company 2: outage

    const { enrichNewCompanies } = await import("./runPipeline.js");
    const result = await enrichNewCompanies();

    expect(result).toEqual({ enriched: 0, deferred: 2 }); // companies 2 and 3 deferred
    expect(mockDb.updates).toEqual([{ id: "1", patch: expect.objectContaining({ status: "no_contact_found" }) }]);
  });

  it("skips Hunter entirely and marks no_contact_found for a company with no domain", async () => {
    const noDomainCompany = { ...company("1"), domain: null };
    mockDb = makeDb({ new: [noDomainCompany] });
    const { findDecisionMaker } = await import("../enrichment/hunter.js");

    const { enrichNewCompanies } = await import("./runPipeline.js");
    const result = await enrichNewCompanies();

    expect(result).toEqual({ enriched: 0, deferred: 0 });
    expect(findDecisionMaker).not.toHaveBeenCalled();
    expect(mockDb.updates).toEqual([{ id: "1", patch: expect.objectContaining({ status: "no_contact_found" }) }]);
  });
});
