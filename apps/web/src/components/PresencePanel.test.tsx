import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PresencePanel } from "./PresencePanel";

const participants = [
  {
    presenceId: "00000000-0000-4000-8000-000000000001",
    name: "River",
    color: "#2c4270",
    since: 1,
  },
  {
    presenceId: "00000000-0000-4000-8000-000000000002",
    name: "Ada",
    color: "#4f657c",
    since: 2,
    isAccount: true,
  },
];

describe("PresencePanel", () => {
  it("labels guests and prefixes authenticated accounts", async () => {
    const user = userEvent.setup();
    render(
      <PresencePanel
        participants={participants}
        selfPresenceId={participants[0]!.presenceId}
      />,
    );

    await user.click(screen.getByRole("button", { name: /2 people have/ }));
    expect(screen.getByText("River")).toBeTruthy();
    expect(screen.getByText("Guest")).toBeTruthy();
    expect(screen.getByText("@Ada")).toBeTruthy();
  });
});
