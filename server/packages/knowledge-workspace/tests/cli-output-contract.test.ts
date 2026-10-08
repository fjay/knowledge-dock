import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync(new URL("../actiondock.json", import.meta.url), "utf8"));
const textActions = ["files.read", "bash.exec"];

describe("workspace CLI output declarations", () => {
  for (const id of textActions) {
    it(`${id} declares its required content string as the default CLI output`, () => {
      const contract = manifest.actions[id];
      assert.equal(contract.annotations["actiondock.cli"].textField, "content");
      assert.equal(contract.outputSchema.type, "object");
      assert.equal(contract.outputSchema.properties.content.type, "string");
      assert.ok(contract.outputSchema.required.includes("content"));
    });
  }

  it("keeps other workspace actions in structured output mode", () => {
    for (const [id, contract] of Object.entries(manifest.actions)) {
      if (textActions.includes(id)) continue;
      assert.equal((contract as { annotations?: Record<string, unknown> }).annotations?.["actiondock.cli"], undefined);
    }
  });
});
