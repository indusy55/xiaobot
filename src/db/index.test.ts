import { describe, expect, it, vi } from "vitest";

describe("db lazy initialization", () => {
  it("does not load config until the database is requested", async () => {
    const drizzle = vi.fn(() => ({
      marker: "db",
    }));

    vi.resetModules();
    vi.doMock("drizzle-orm/libsql", () => ({
      drizzle,
    }));

    const databaseModule = await import("./index.js");

    expect(drizzle).not.toHaveBeenCalled();

    expect(databaseModule.getDb()).toEqual({
      marker: "db",
    });
    expect(drizzle).toHaveBeenCalledTimes(1);

    expect(databaseModule.getDb()).toEqual({
      marker: "db",
    });
    expect(drizzle).toHaveBeenCalledTimes(1);
  });
});
