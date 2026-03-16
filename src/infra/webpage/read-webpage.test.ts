import { describe, expect, it } from "vitest";
import { validateReadableWebpageUrl } from "./read-webpage.js";

describe("validateReadableWebpageUrl", () => {
  it("accepts public http and https urls", () => {
    expect(validateReadableWebpageUrl("https://example.com/docs")).toBe(
      "https://example.com/docs"
    );
    expect(validateReadableWebpageUrl("http://example.com")).toBe(
      "http://example.com/"
    );
  });

  it("rejects localhost and private network urls", () => {
    expect(() => validateReadableWebpageUrl("http://127.0.0.1:3000")).toThrow(
      "Private or local URLs are not allowed."
    );
    expect(() =>
      validateReadableWebpageUrl("https://192.168.1.10/internal")
    ).toThrow("Private or local URLs are not allowed.");
    expect(() => validateReadableWebpageUrl("https://localhost/test")).toThrow(
      "Private or local URLs are not allowed."
    );
  });

  it("rejects non-http protocols", () => {
    expect(() => validateReadableWebpageUrl("file:///tmp/test.html")).toThrow(
      "Only http and https URLs are allowed."
    );
  });
});
