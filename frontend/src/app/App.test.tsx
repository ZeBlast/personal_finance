// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeBackend } from "../test/fakeBackend";
import { App } from "./App";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the page area", () => {
  it("passes its full height down, for pages that fill the window like the calendar", () => {
    fakeBackend({});
    render(
      <MemoryRouter initialEntries={["/calendar"]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("main").firstElementChild?.classList.contains("h-full")).toBe(true);
  });
});
