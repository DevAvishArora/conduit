import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Properties } from "../src/builder/Properties";
import type { FlowData, FlowNode } from "../src/builder/convert";
import { defaultNode, type NodeType, type WorkflowNode } from "../src/builder/types";

/**
 * Properties is fully controlled — its parent owns the config. The real
 * parent (Builder.tsx) calls setNodes() on every onChange. We mirror that
 * here in a tiny host so typing into an input actually persists.
 */
function TestHost({
  initialType,
  onChange,
  onDelete = vi.fn(),
}: {
  initialType: NodeType;
  onChange?: (c: WorkflowNode) => void;
  onDelete?: () => void;
}): JSX.Element {
  const [config, setConfig] = useState<WorkflowNode>(defaultNode(initialType));
  const node: FlowNode = {
    id: "x",
    type: "flowNode",
    position: { x: 0, y: 0 },
    data: {
      nid: "x",
      type: config.type,
      config,
      isStart: config.type === "TRIGGER_INPUT",
    } satisfies FlowData,
  };
  return (
    <Properties
      node={node}
      onChange={(c) => {
        setConfig(c);
        onChange?.(c);
      }}
      onRename={vi.fn()}
      onDelete={onDelete}
      conflictIds={new Set()}
    />
  );
}

describe("<Properties />", () => {
  it("HTTP_REQUEST: shows Method + URL fields and updates URL on edit", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TestHost initialType="HTTP_REQUEST" onChange={onChange} />);
    expect(screen.getByLabelText(/method/i)).toBeInTheDocument();
    const url = screen.getByLabelText(/^url$/i);
    expect(url).toBeInTheDocument();
    await user.clear(url);
    await user.type(url, "https://api.example.com");
    const last = onChange.mock.calls.at(-1)?.[0] as WorkflowNode;
    if (last?.type !== "HTTP_REQUEST") throw new Error("expected HTTP_REQUEST");
    expect(last.config.url).toBe("https://api.example.com");
  });

  it("CONDITION: hides the right-operand field for `exists` op", async () => {
    const user = userEvent.setup();
    render(<TestHost initialType="CONDITION" />);
    expect(screen.getByLabelText(/^right$/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/operator/i), "exists");
    expect(screen.queryByLabelText(/^right$/i)).not.toBeInTheDocument();
  });

  it("DELAY: numeric input updates delay_ms", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<TestHost initialType="DELAY" onChange={onChange} />);
    const input = screen.getByLabelText(/delay \(milliseconds\)/i);
    await user.clear(input);
    await user.type(input, "12000");
    const last = onChange.mock.calls.at(-1)?.[0] as WorkflowNode;
    if (last?.type !== "DELAY") throw new Error("expected DELAY");
    expect(last.delay_ms).toBe(12000);
  });

  it("NOTIFY: shows webhook_url_secret for Slack channel, swaps to To/Subject for email", async () => {
    const user = userEvent.setup();
    render(<TestHost initialType="NOTIFY" />);
    expect(screen.getByLabelText(/webhook url — secret name/i)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/^channel$/i), "email");
    expect(screen.queryByLabelText(/webhook url — secret name/i)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^to$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/^subject$/i)).toBeInTheDocument();
  });

  it("Delete button calls onDelete", async () => {
    const onDelete = vi.fn();
    const user = userEvent.setup();
    render(<TestHost initialType="HTTP_REQUEST" onDelete={onDelete} />);
    await user.click(screen.getByRole("button", { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("renders a TRIGGER_INPUT explainer (no config form)", () => {
    render(<TestHost initialType="TRIGGER_INPUT" />);
    expect(screen.getByText(/entry point of the workflow/i)).toBeInTheDocument();
  });
});
