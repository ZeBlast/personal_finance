import { describe, expect, it } from "vitest";
import { updateErrorText } from "./UpdateCheck";

describe("update errors", () => {
  it("say what went wrong in words", () => {
    expect(updateErrorText("Could not fetch a valid release JSON: 404 Not Found")).toMatch(
      /^No published release was found/,
    );
    expect(updateErrorText("error sending request: dns error")).toMatch(/^Could not reach GitHub/);
    expect(updateErrorText("signature verification failed")).toMatch(/valid signature/);
    expect(updateErrorText("something else")).toBe("Could not check for updates (something else).");
  });
});
