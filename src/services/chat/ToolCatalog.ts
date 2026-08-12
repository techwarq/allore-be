import { ToolRegistry } from "./ToolRegistry";

/**
 * ToolCatalog is a lightweight view over ToolRegistry 
 * specifically designed to provide prompt descriptions.
 * 
 * NOTE: The official list of tools is maintained in StandardTools.ts
 */
export class ToolCatalog {
  constructor(private registry: ToolRegistry) {}

  names(): string[] {
    return this.registry.names();
  }

  describeForPrompt(): string {
    return this.registry.entries()
      .map(([name, tool]) => {
        let block = `- ${name}: ${tool.description}`;
        if (tool.whenToUse) block += `\n  Use when: ${tool.whenToUse}`;
        if (tool.routingNotes) block += `\n  Note: ${tool.routingNotes}`;
        return block;
      })
      .join("\n");
  }
}
