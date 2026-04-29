import { Tool } from "./tools/Tool";

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  register(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  entries(): [string, Tool][] {
    return Array.from(this.tools.entries());
  }

  names(): string[] {
    return Array.from(this.tools.keys());
  }
}
